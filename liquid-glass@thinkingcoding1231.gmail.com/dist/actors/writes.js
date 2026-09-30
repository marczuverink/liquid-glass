import { utilsLog, utilsLogEnabled } from '../diagnostics/logging.js';
// Clutter's transform setters queue a redraw even when the value is
// unchanged, so re-writing every clone every frame kept a static desktop
// re-rendering every glass. These helpers write only on change. The last
// written value is cached as a JS property on the actor, which is much
// cheaper than reading the GObject property back.
// global._lgGlass.diffWrites(false) restores unconditional writes.
let _diffWritesEnabled = true;

export function setDiffWritesEnabled(enabled) {
    _diffWritesEnabled = !!enabled;
}

export function isDiffWritesEnabled() {
    return _diffWritesEnabled;
}

/** Drops the cache so the next sync writes unconditionally. */
export function invalidateCloneWriteCache(actor) {
    if (!actor)
        return;
    const c = actor;
    c._lgTx = c._lgTy = c._lgW = c._lgH = undefined;
    c._lgSx = c._lgSy = c._lgPx = c._lgPy = c._lgOpacity = undefined;
}

export function setTranslationIfChanged(actor, x, y) {
    const c = actor;
    if (_diffWritesEnabled && c._lgTx === x && c._lgTy === y)
        return false;
    c._lgTx = x;
    c._lgTy = y;
    actor.translation_x = x;
    actor.translation_y = y;
    return true;
}

export function setSizeIfChanged(actor, w, h) {
    const c = actor;
    if (_diffWritesEnabled && c._lgW === w && c._lgH === h)
        return false;
    c._lgW = w;
    c._lgH = h;
    actor.set_size(w, h);
    return true;
}

export function setScaleIfChanged(actor, sx, sy) {
    const c = actor;
    if (_diffWritesEnabled && c._lgSx === sx && c._lgSy === sy)
        return false;
    c._lgSx = sx;
    c._lgSy = sy;
    actor.set_scale(sx, sy);
    return true;
}

export function setPivotIfChanged(actor, px, py) {
    const c = actor;
    if (_diffWritesEnabled && c._lgPx === px && c._lgPy === py)
        return false;
    c._lgPx = px;
    c._lgPy = py;
    actor.set_pivot_point(px, py);
    return true;
}

export function setClipIfChanged(actor, x, y, w, h) {
    const c = actor;
    if (_diffWritesEnabled &&
        c._lgClipX === x && c._lgClipY === y && c._lgClipW === w && c._lgClipH === h)
        return false;
    c._lgClipX = x;
    c._lgClipY = y;
    c._lgClipW = w;
    c._lgClipH = h;
    actor.set_clip(x, y, w, h);
    return true;
}

export function setPositionIfChanged(actor, x, y) {
    const c = actor;
    if (_diffWritesEnabled && c._lgPosX === x && c._lgPosY === y)
        return false;
    c._lgPosX = x;
    c._lgPosY = y;
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
export function setCloneCulled(actor, culled, why) {
    if (!actor)
        return;
    const wasCulled = !!actor._lgCulled;
    if (wasCulled === !!culled)
        return;
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
    }
    else {
        // The cache still holds the pre-cull value, which the actor no longer has.
        actor._lgOpacity = undefined;
    }
    // Damage the parent too. The opacity write alone is dropped for a clone
    // that is not mapped yet (one built and culled in the same frame), and then
    // the glass's OffscreenEffect keeps painting its cached capture.
    actor.get_parent()?.queue_redraw();
}

/** True while setCloneCulled() is holding this clone at zero opacity. */
export function isCloneCulled(actor) {
    return !!(actor && actor._lgCulled);
}

export function setOpacityIfChanged(actor, opacity) {
    const c = actor;
    // Held at 0 while culled; setCloneCulled(false) releases it.
    if (actor._lgCulled)
        return false;
    if (_diffWritesEnabled && c._lgOpacity === opacity)
        return false;
    c._lgOpacity = opacity;
    actor.opacity = opacity;
    return true;
}
