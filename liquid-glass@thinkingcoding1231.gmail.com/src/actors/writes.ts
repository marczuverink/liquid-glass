import { utilsLog, utilsLogEnabled } from '../diagnostics/logging.js';
// Clutter's transform setters queue a redraw even when the value is
// unchanged, so re-writing every clone every frame kept a static desktop
// re-rendering every glass. These helpers write only on change. The last
// written value is cached as a JS property on the actor, which is much
// cheaper than reading the GObject property back.
// global._lgGlass.diffWrites(false) restores unconditional writes.
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

/** Drops the cache so the next sync writes unconditionally. */
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

/**
 * Culls a clone by opacity rather than visibility. clutter_actor_paint()
 * returns early for a zero-opacity actor, so the clone's source (and any
 * glass nested in it) is not painted, while hiding would map and unmap the
 * actor and queue relayouts on every toggle. The caller's next
 * setOpacityIfChanged() restores the real opacity.
 */
export function setCloneCulled(actor: any, culled: boolean, why?: string | (() => string)): void {
  if (!actor) return;
  const wasCulled = !!actor._lgCulled;
  if (wasCulled === !!culled) return;
  actor._lgCulled = !!culled;

  // Logged on transitions only. A wrong cull leaves black behind that nothing
  // repaints, so a later report looks correct and only this timeline shows it.
  // `why` may be a function so per-frame callers do not build the string.
  if (why && utilsLogEnabled()) {
    const name = actor.get_name() || '(unnamed)';
    const text = typeof why === 'function' ? why() : why;
    utilsLog(`[Liquid Glass][cull] ${culled ? 'CULL ' : 'SHOW '} "${name}" ${text}`);
  }
  if (culled) {
    actor.opacity = 0;
  } else {
    // The cache still holds the pre-cull value, which the actor no longer has.
    actor._lgOpacity = undefined;
  }

  // Damage the parent too. The opacity write alone is dropped for a clone
  // that is not mapped yet (one built and culled in the same frame), and then
  // the glass's OffscreenEffect keeps painting its cached capture.
  actor.get_parent()?.queue_redraw();
}

/** True while setCloneCulled() is holding this clone at zero opacity. */
export function isCloneCulled(actor: any): boolean {
  return !!(actor && actor._lgCulled);
}

export function setOpacityIfChanged(actor: any, opacity: number): boolean {
  const c = actor as CloneWriteCache;
  // Held at 0 while culled; setCloneCulled(false) releases it.
  if ((actor as any)._lgCulled) return false;
  if (_diffWritesEnabled && c._lgOpacity === opacity) return false;
  c._lgOpacity = opacity;
  actor.opacity = opacity;
  return true;
}
