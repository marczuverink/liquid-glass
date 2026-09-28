import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { isActorValid } from '../actors/lifecycle.js';
export interface RgbColor { r: number; g: number; b: number; }

export function crossFadeColorAt(
  start: RgbColor, startAlpha: number,
  target: RgbColor, targetAlpha: number,
  progress: number
): { r: number; g: number; b: number; a: number } {
  const p = Math.max(0, Math.min(1, progress));
  if (p < 0.5) {
    const local = p / 0.5;
    const a = startAlpha * (1 - local * local);
    return { r: start.r, g: start.g, b: start.b, a };
  }
  const local = (p - 0.5) / 0.5;
  const e = 1 - (1 - local) * (1 - local);
  return { r: target.r, g: target.g, b: target.b, a: targetAlpha * e };
}

const CROSS_FADE_LUMA_DELTA = 0.4;

export function shouldCrossFadeColors(start: RgbColor, target: RgbColor): boolean {
  const luma = (c: RgbColor) =>
    (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return Math.abs(luma(target) - luma(start)) > CROSS_FADE_LUMA_DELTA;
}

export function lerpColorAt(
  start: RgbColor, startAlpha: number,
  target: RgbColor, targetAlpha: number,
  progress: number
): { r: number; g: number; b: number; a: number } {
  const p = Math.max(0, Math.min(1, progress));
  const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  return {
    r: Math.round(start.r + (target.r - start.r) * e),
    g: Math.round(start.g + (target.g - start.g) * e),
    b: Math.round(start.b + (target.b - start.b) * e),
    a: startAlpha + (targetAlpha - startAlpha) * e,
  };
}

export type AdaptiveColorMode = 'cross-fade' | 'rgb-lerp';

let _adaptiveColorMode: AdaptiveColorMode = 'cross-fade';

export function setAdaptiveColorMode(mode: AdaptiveColorMode): void {
  _adaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
}

export function getAdaptiveColorMode(): AdaptiveColorMode {
  return _adaptiveColorMode;
}

export function resolveCrossFade(start: RgbColor, target: RgbColor): boolean {
  return _adaptiveColorMode === 'cross-fade' && shouldCrossFadeColors(start, target);
}

interface ColorTweenEntry {
  startRgb: RgbColor;
  startAlpha: number;
  targetRgb: RgbColor;
  targetAlpha: number;
  crossFade: boolean;
  durationMs: number;
  startTime: number;
  apply: (r: number, g: number, b: number, a: number, progress: number) => void;
  coalesce?: boolean;
  last?: { r: number; g: number; b: number; a: number };
}

class AdaptiveColorTweener {
  private _entries: Map<any, ColorTweenEntry> = new Map();
  private _laterId: number = 0;

  add(actor: any, entry: Omit<ColorTweenEntry, 'startTime' | 'last'>, batchStart?: number): void {
    if (!actor) return;
    const prev = this._entries.get(actor);
    const startRgb = prev?.last
      ? { r: prev.last.r, g: prev.last.g, b: prev.last.b }
      : entry.startRgb;
    const startAlpha = prev?.last ? prev.last.a : entry.startAlpha;

    this._entries.set(actor, {
      ...entry,
      startRgb,
      startAlpha,
      crossFade: entry.crossFade && shouldCrossFadeColors(startRgb, entry.targetRgb),
      startTime: batchStart ?? GLib.get_monotonic_time(),
    });
    this._schedule();
  }

  cancel(actor: any): void {
    this._entries.delete(actor);
  }

  stopAll(): void {
    this._entries.clear();
    this._unschedule();
  }

  isAnimating(actor: any): boolean {
    return this._entries.has(actor);
  }

  private _schedule(): void {
    if (this._laterId !== 0) return;
    try {
      this._laterId = (global as any).compositor.get_laters().add(
        Meta.LaterType.BEFORE_REDRAW,
        () => { this._tick(); return false; }
      );
    } catch (_) {
      this._laterId = 0;
    }
  }

  private _unschedule(): void {
    if (this._laterId === 0) return;
    try { (global as any).compositor.get_laters().remove(this._laterId); } catch (_) { }
    this._laterId = 0;
  }

  private _tick(): void {
    this._laterId = 0;
    const now = GLib.get_monotonic_time();

    for (const [actor, e] of [...this._entries]) {
      if (!isActorValid(actor)) { this._entries.delete(actor); continue; }

      const elapsedMs = (now - e.startTime) / 1000;
      const progress = e.durationMs > 0 ? Math.min(elapsedMs / e.durationMs, 1) : 1;
      const c = e.crossFade
        ? crossFadeColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress)
        : lerpColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress);
      const a = Math.max(0, Math.min(1, c.a));

      const same = e.coalesce !== false && e.last &&
        e.last.r === c.r && e.last.g === c.g && e.last.b === c.b &&
        Math.abs(e.last.a - a) < 0.002;
      if (!same) {
        e.last = { r: c.r, g: c.g, b: c.b, a };
        try { e.apply(c.r, c.g, c.b, a, progress); } catch (_) { }
      }

      if (progress >= 1) this._entries.delete(actor);
    }

    if (this._entries.size > 0) this._schedule();
  }
}

export const adaptiveColorTweener = new AdaptiveColorTweener();
