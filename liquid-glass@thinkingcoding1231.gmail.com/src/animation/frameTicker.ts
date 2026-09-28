import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { reportFrameLoopError } from '../diagnostics/logging.js';

const FRAME_TICKER_SLACK_US = 4000;
let _frameTickerSeq = 0;
const _frameTickers: Map<number, { laterId: number, cb: () => boolean, minUs: number, last: number }> = new Map();

export function addFrameTicker(cb: () => boolean, minIntervalMs: number = 0): number {
  const id = ++_frameTickerSeq;
  const st = { laterId: 0, cb, minUs: Math.max(0, minIntervalMs || 0) * 1000, last: 0 };
  _frameTickers.set(id, st);
  const schedule = () => {
    st.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      st.laterId = 0;
      if (_frameTickers.get(id) !== st) return GLib.SOURCE_REMOVE;
      let keep = true;
      const now = GLib.get_monotonic_time();
      if (st.minUs <= 0 || st.last === 0 || now - st.last >= st.minUs - FRAME_TICKER_SLACK_US) {
        st.last = now;
        try {
          keep = !!st.cb();
        } catch (e) {
          keep = false;
          reportFrameLoopError('frameTicker', e);
        }
      }
      if (keep && _frameTickers.get(id) === st) schedule();
      else if (_frameTickers.get(id) === st) _frameTickers.delete(id);
      return GLib.SOURCE_REMOVE;
    });
  };
  schedule();
  return id;
}

export function removeFrameTicker(id: number): void {
  const st = _frameTickers.get(id);
  if (!st) return;
  _frameTickers.delete(id);
  if (st.laterId) {
    try { global.compositor.get_laters().remove(st.laterId); } catch (_) { }
    st.laterId = 0;
  }
}

export const ANIMATION_INTERVAL_MAX_MS = 50;
export function normalizeAnimationIntervalMs(v: number): number {
  if (!Number.isFinite(v) || v <= 16) return 0;
  return Math.min(Math.round(v), ANIMATION_INTERVAL_MAX_MS);
}
