import { utilsLog, utilsLogEnabled } from '../diagnostics/logging.js';
let _diffWritesEnabled = true;

export function setDiffWritesEnabled(enabled: boolean): void {
  _diffWritesEnabled = !!enabled;
}

export function isDiffWritesEnabled(): boolean {
  return _diffWritesEnabled;
}

interface CloneWriteCache {
  _lgTx?: number;
  _lgTy?: number;
  _lgW?: number;
  _lgH?: number;
  _lgSx?: number;
  _lgSy?: number;
  _lgPx?: number;
  _lgPy?: number;
  _lgOpacity?: number;
}

export function invalidateCloneWriteCache(actor: any): void {
  if (!actor) return;
  const c = actor as CloneWriteCache;
  c._lgTx = c._lgTy = c._lgW = c._lgH = undefined;
  c._lgSx = c._lgSy = c._lgPx = c._lgPy = c._lgOpacity = undefined;
}

export function setTranslationIfChanged(actor: any, x: number, y: number): boolean {
  const c = actor as CloneWriteCache;
  if (_diffWritesEnabled && c._lgTx === x && c._lgTy === y) return false;
  c._lgTx = x; c._lgTy = y;
  actor.translation_x = x;
  actor.translation_y = y;
  return true;
}

export function setSizeIfChanged(actor: any, w: number, h: number): boolean {
  const c = actor as CloneWriteCache;
  if (_diffWritesEnabled && c._lgW === w && c._lgH === h) return false;
  c._lgW = w; c._lgH = h;
  actor.set_size(w, h);
  return true;
}

export function setScaleIfChanged(actor: any, sx: number, sy: number): boolean {
  const c = actor as CloneWriteCache;
  if (_diffWritesEnabled && c._lgSx === sx && c._lgSy === sy) return false;
  c._lgSx = sx; c._lgSy = sy;
  actor.set_scale(sx, sy);
  return true;
}

export function setPivotIfChanged(actor: any, px: number, py: number): boolean {
  const c = actor as CloneWriteCache;
  if (_diffWritesEnabled && c._lgPx === px && c._lgPy === py) return false;
  c._lgPx = px; c._lgPy = py;
  actor.set_pivot_point(px, py);
  return true;
}

export function setClipIfChanged(actor: any, x: number, y: number, w: number, h: number): boolean {
  const c = actor as any;
  if (_diffWritesEnabled &&
      c._lgClipX === x && c._lgClipY === y && c._lgClipW === w && c._lgClipH === h) return false;
  c._lgClipX = x; c._lgClipY = y; c._lgClipW = w; c._lgClipH = h;
  actor.set_clip(x, y, w, h);
  return true;
}

export function setPositionIfChanged(actor: any, x: number, y: number): boolean {
  const c = actor as any;
  if (_diffWritesEnabled && c._lgPosX === x && c._lgPosY === y) return false;
  c._lgPosX = x; c._lgPosY = y;
  actor.set_position(x, y);
  return true;
}

export function setCloneCulled(actor: any, culled: boolean, why?: string | (() => string)): void {
  if (!actor) return;
  const wasCulled = !!actor._lgCulled;
  if (wasCulled === !!culled) return;
  actor._lgCulled = !!culled;

  if (why && utilsLogEnabled()) {
    let name = '(?)';
    try { name = actor.get_name?.() || '(unnamed)'; } catch { }
    const text = typeof why === 'function' ? why() : why;
    utilsLog(`[Liquid Glass][cull] ${culled ? 'CULL ' : 'SHOW '} "${name}" ${text}`);
  }
  if (culled) {
    actor.opacity = 0;
  } else {
    actor._lgOpacity = undefined;
  }

  try { actor.get_parent?.()?.queue_redraw(); } catch { }
}

export function isCloneCulled(actor: any): boolean {
  return !!(actor && actor._lgCulled);
}

export function setOpacityIfChanged(actor: any, opacity: number): boolean {
  const c = actor as CloneWriteCache;
  if ((actor as any)._lgCulled) return false;
  if (_diffWritesEnabled && c._lgOpacity === opacity) return false;
  c._lgOpacity = opacity;
  actor.opacity = opacity;
  return true;
}
