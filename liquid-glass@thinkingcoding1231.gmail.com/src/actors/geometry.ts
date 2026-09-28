import { GlassRect } from '../capture/options.js';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isActorValid } from './lifecycle.js';
export function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  b: GlassRect
): boolean {
  return ax < b[0] + b[2] && ax + aw > b[0] &&
    ay < b[1] + b[3] && ay + ah > b[1];
}

export function unionRectInto(a: GlassRect, b: GlassRect): void {
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  a[0] = Math.min(a[0], b[0]);
  a[1] = Math.min(a[1], b[1]);
  a[2] = x1 - a[0];
  a[3] = y1 - a[1];
}

export function getAllocatedSize(actor: Clutter.Actor): [number, number] {
  try {
    const box = actor.get_allocation_box();
    const w = box.get_width();
    const h = box.get_height();
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return [w, h];
    }
  } catch (_) { }

  try {
    const [w, h] = actor.get_size();
    return [w, h];
  } catch (_) {
    return [0, 0];
  }
}

export function getTransformedRect(actor: Clutter.Actor): [number, number, number, number] {
  try {
    const r = actor.get_transformed_extents();
    const x = r.origin.x, y = r.origin.y;
    const w = r.size.width, h = r.size.height;
    if (Number.isFinite(x) && Number.isFinite(y) &&
      Number.isFinite(w) && Number.isFinite(h)) {
      return [x, y, w, h];
    }
  } catch (_) { }

  try {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = getAllocatedSize(actor);
    return [x, y, w, h];
  } catch (_) {
    return [0, 0, 0, 0];
  }
}

export function computeCaptureLayout(
  actor: Clutter.Actor | null, srcW: number, srcH: number,
  allocW: number, allocH: number
): { uv: number[]; dest: number[] } {
  const centredFallback = (): { uv: number[]; dest: number[] } => {
    const padW = srcW - allocW;
    const padH = srcH - allocH;
    if (padW === 0 && padH === 0) {
      return { uv: [0, 0, 1, 1], dest: [0, 0, allocW, allocH] };
    }
    const x0 = padW / 2, y0 = padH / 2;
    return {
      uv: [
        x0 / srcW, y0 / srcH,
        Math.min(1.0, (x0 + allocW) / srcW),
        Math.min(1.0, (y0 + allocH) / srcH),
      ],
      dest: [x0, y0, x0 + allocW, y0 + allocH],
    };
  };

  if (!actor) return centredFallback();

  let rawX1 = 0, rawY1 = 0, rawX2 = allocW, rawY2 = allocH;
  try {
    const pv = (actor as any).get_paint_volume?.();
    if (pv) {
      const origin = pv.get_origin();
      rawX1 = origin.x;
      rawY1 = origin.y;
      rawX2 = rawX1 + pv.get_width();
      rawY2 = rawY1 + pv.get_height();
    }
  } catch (e) {
  }
  if (!Number.isFinite(rawX1) || !Number.isFinite(rawY1) ||
    !Number.isFinite(rawX2) || !Number.isFinite(rawY2)) {
    return centredFallback();
  }

  const nearbyint = (v: number) => Math.trunc(v < 0 ? v - 0.5 : v + 0.5);

  let x1 = rawX1, y1 = rawY1, x2 = rawX2, y2 = rawY2;
  if ((rawX2 - rawX1) * (rawY2 - rawY1) !== 0) {
    const w = nearbyint(rawX2 - rawX1);
    const h = nearbyint(rawY2 - rawY1);
    x2 = Math.ceil(rawX2 + 0.75);
    y2 = Math.ceil(rawY2 + 0.75);
    x1 = x2 - w - 3;
    y1 = y2 - h - 3;
  }

  const boxW = x2 - x1;
  const boxH = y2 - y1;
  if (!(boxW > 0) || !(boxH > 0)) return centredFallback();

  const fboOffX = Math.trunc(x1);
  const fboOffY = Math.trunc(y1);

  const scale = Math.max(1, Math.round(srcW / boxW));
  if (Math.ceil(boxW * scale) !== srcW || Math.ceil(boxH * scale) !== srcH) {
    return centredFallback();
  }

  const padLeft = -fboOffX * scale;
  const padTop = -fboOffY * scale;
  const contentW = allocW * scale;
  const contentH = allocH * scale;

  if (!(padLeft >= 0) || !(padTop >= 0) ||
    padLeft + contentW > srcW || padTop + contentH > srcH) {
    return centredFallback();
  }

  return {
    uv: [
      padLeft / srcW, padTop / srcH,
      (padLeft + contentW) / srcW, (padTop + contentH) / srcH,
    ],
    dest: [padLeft, padTop, padLeft + contentW, padTop + contentH],
  };
}

export function resolveMonitorGeometry(candidates: any[]): any {
  const layoutManager = Main.layoutManager;

  for (const actor of candidates) {
    if (!actor || !isActorValid(actor)) continue;

    const [width, height] = actor.get_size();
    if (!(width > 0 && height > 0)) continue;

    const index = layoutManager.findIndexForActor(actor);
    if (index >= 0)
      return layoutManager.monitors[index] || layoutManager.primaryMonitor;
  }

  return layoutManager.monitors[layoutManager.primaryIndex] || layoutManager.primaryMonitor;
}
