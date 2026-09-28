import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { reportFrameLoopError } from '../diagnostics/logging.js';
import { SAME_FRAME_WINDOW_US } from './frameSync.js';
const MAX_INTERVAL_MS = 50;
let _nextId = 0;
const _tickers = new Map();
// ─── Frame-clock animation driver ───────────────────────────────────────────
//
// [PERF C1] The menu / quick-settings open-close springs used to be stepped by
// GLib.timeout_add(animation-interval-ms). That timer is not tied to the frame
// clock at all: at the default 16ms it beats against the 16.67ms frame (a
// double step every ~25 frames, a skipped one as often — see the same finding
// for the text-colour tween, memo.md 追記12 C), and at the 1ms a user can dial
// in it ran _syncGeometry() a thousand times a second — sixteen full geometry
// syncs per frame, fifteen of which no frame ever showed (and 0ms was a busy
// loop). Smoothness is decided by how finely the PHYSICS is stepped, not by
// how often the actors are written: see Spring.update(), which sub-steps.
//
// addFrameTicker() calls `cb` at most once per frame, from a BEFORE_REDRAW
// later (which also keeps the frame clock running while the animation lives),
// optionally no more often than `minIntervalMs`. `cb` returns true to keep
// going. The returned id stays valid across the internal reschedules.
export function addFrameTicker(cb, minIntervalMs = 0) {
    const id = ++_nextId;
    const ticker = { laterId: 0, cb, minUs: Math.max(0, minIntervalMs || 0) * 1000, last: 0 };
    _tickers.set(id, ticker);
    const schedule = () => {
        ticker.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            ticker.laterId = 0;
            if (_tickers.get(id) !== ticker)
                return GLib.SOURCE_REMOVE;
            let keep = true;
            const now = GLib.get_monotonic_time();
            // At most once per frame even when several stage views update in the
            // same one (SAME_FRAME_WINDOW_US), and a little slack so a 16ms minimum
            // does not drop a frame whose interval happened to measure 15.9ms.
            const due = ticker.last === 0 ||
                now - ticker.last >= Math.max(SAME_FRAME_WINDOW_US, ticker.minUs - SAME_FRAME_WINDOW_US);
            if (due) {
                ticker.last = now;
                try {
                    keep = !!ticker.cb();
                }
                catch (e) {
                    keep = false;
                    reportFrameLoopError('frameTicker', e);
                }
            }
            if (_tickers.get(id) !== ticker)
                return GLib.SOURCE_REMOVE;
            if (keep)
                schedule();
            else
                _tickers.delete(id);
            return GLib.SOURCE_REMOVE;
        });
    };
    schedule();
    return id;
}
export function removeFrameTicker(id) {
    const ticker = _tickers.get(id);
    if (!ticker)
        return;
    _tickers.delete(id);
    if (!ticker.laterId)
        return;
    try {
        global.compositor.get_laters().remove(ticker.laterId);
    }
    catch { }
    ticker.laterId = 0;
}
/**
 * [PERF C1] The animation-interval-ms settings, reduced to what can actually
 * happen now that the animation is frame-driven: anything up to one 60Hz frame
 * (including the old 0/1ms values) means "every frame" (0); larger values are
 * a frame-rate cap, bounded to what the preferences offer.
 */
export function normalizeAnimationIntervalMs(v) {
    if (!Number.isFinite(v) || v <= 16)
        return 0;
    return Math.min(Math.round(v), MAX_INTERVAL_MS);
}
