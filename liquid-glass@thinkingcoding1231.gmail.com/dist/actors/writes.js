import { utilsLog, utilsLogEnabled } from '../diagnostics/logging.js';
let _diffWritesEnabled = true;
export function setDiffWritesEnabled(enabled) {
    _diffWritesEnabled = !!enabled;
}
export function isDiffWritesEnabled() {
    return _diffWritesEnabled;
}
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
export function setCloneCulled(actor, culled, why) {
    if (!actor)
        return;
    const wasCulled = !!actor._lgCulled;
    if (wasCulled === !!culled)
        return;
    actor._lgCulled = !!culled;
    if (why && utilsLogEnabled()) {
        let name = '(?)';
        try {
            name = actor.get_name?.() || '(unnamed)';
        }
        catch (_) { }
        const text = typeof why === 'function' ? why() : why;
        utilsLog(`[Liquid Glass][cull] ${culled ? 'CULL ' : 'SHOW '} "${name}" ${text}`);
    }
    if (culled) {
        actor.opacity = 0;
    }
    else {
        actor._lgOpacity = undefined;
    }
    try {
        actor.get_parent?.()?.queue_redraw();
    }
    catch (_) { }
}
export function isCloneCulled(actor) {
    return !!(actor && actor._lgCulled);
}
export function setOpacityIfChanged(actor, opacity) {
    const c = actor;
    if (actor._lgCulled)
        return false;
    if (_diffWritesEnabled && c._lgOpacity === opacity)
        return false;
    c._lgOpacity = opacity;
    actor.opacity = opacity;
    return true;
}
