import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { reportFrameLoopError } from '../diagnostics/logging.js';
import { SAME_FRAME_WINDOW_US } from './frameSync.js';
const MAX_INTERVAL_MS = 50;
let _nextId = 0;
const _tickers = new Map();
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
    catch (_) { }
    ticker.laterId = 0;
}
export function normalizeAnimationIntervalMs(v) {
    if (!Number.isFinite(v) || v <= 16)
        return 0;
    return Math.min(Math.round(v), MAX_INTERVAL_MS);
}
