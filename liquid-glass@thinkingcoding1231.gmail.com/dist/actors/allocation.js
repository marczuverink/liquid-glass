import { isActorValid } from './lifecycle.js';
const _strandedFrames = new WeakMap();
const STRANDED_FRAMES_BEFORE_RESCUE = 3;
export function ensureWindowActorAllocated(actor, relayoutFrames, remapFrames) {
    try {
        if (!actor)
            return '';
        if (_windowActorRescueMode === 'off')
            return '';
        if (!actor.visible || !actor.mapped || actor.has_allocation()) {
            _windowActorStrandedFrames.delete(actor);
            return '';
        }
        const strandedFor = (_windowActorStrandedFrames.get(actor) ?? 0) + 1;
        _windowActorStrandedFrames.set(actor, strandedFor);
        if (_windowActorRescueMode !== 'remap' && strandedFor === relayoutFrames) {
            let ancestor = actor.get_parent();
            while (ancestor && isActorValid(ancestor) && !ancestor.has_allocation())
                ancestor = ancestor.get_parent();
            if (ancestor && isActorValid(ancestor)) {
                ancestor.queue_relayout();
                return 'relayout';
            }
        }
        if (strandedFor >= remapFrames) {
            _windowActorStrandedFrames.delete(actor);
            actor.hide();
            actor.show();
            return 'remap';
        }
        return '';
    }
    catch {
        return '';
    }
}
const _windowActorStrandedFrames = new Map();
let _windowActorRescueMode = 'two-stage';
const WINDOW_ACTOR_RESCUE_MODES = ['two-stage', 'remap', 'off'];
export function setWindowActorRescueMode(mode) {
    _windowActorRescueMode =
        WINDOW_ACTOR_RESCUE_MODES.includes(mode) ? mode : 'two-stage';
}
export function getWindowActorRescueMode() {
    return _windowActorRescueMode;
}
export function ensureGlassAllocated(actor, framesBeforeRescue = STRANDED_FRAMES_BEFORE_RESCUE) {
    try {
        if (!actor)
            return false;
        if (!actor.visible || !actor.mapped || actor.has_allocation()) {
            _strandedFrames.delete(actor);
            return false;
        }
        const strandedFor = (_strandedFrames.get(actor) ?? 0) + 1;
        if (strandedFor < framesBeforeRescue) {
            _strandedFrames.set(actor, strandedFor);
            return false;
        }
        _strandedFrames.delete(actor);
        actor.hide();
        actor.show();
        return true;
    }
    catch {
        return false;
    }
}
export function setActorVisible(actor, visible) {
    try {
        if (!actor)
            return;
        if (actor.visible === visible)
            return;
        actor.visible = visible;
        if (visible) {
            actor.queue_relayout();
            actor.get_parent()?.queue_relayout();
        }
    }
    catch { }
}
