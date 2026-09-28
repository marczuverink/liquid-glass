import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import { isActorValid } from '../actors/lifecycle.js';
import { utilsLog } from '../diagnostics/logging.js';
export const CullOptOutEffect = GObject.registerClass(class CullOptOutEffect extends Clutter.Effect {
});
const CULL_OPT_OUT_NAME = 'lg-cull-opt-out';
const _cullOptOutOwners = new Map();
const _cullOptOutEffects = new Map();
let _cullOptOutEnabled = true;
function _reconcileCullOptOut() {
    const before = _cullOptOutEffects.size;
    const wanted = new Set();
    if (_cullOptOutEnabled) {
        for (const actors of _cullOptOutOwners.values()) {
            for (const actor of actors) {
                if (isActorValid(actor))
                    wanted.add(actor);
            }
        }
    }
    for (const actor of wanted) {
        if (_cullOptOutEffects.has(actor))
            continue;
        try {
            const effect = new CullOptOutEffect();
            actor.add_effect_with_name(CULL_OPT_OUT_NAME, effect);
            _cullOptOutEffects.set(actor, effect);
        }
        catch (e) {
            utilsLog(`[cull-opt-out] could not attach: ${e}`);
        }
    }
    for (const [actor, effect] of [..._cullOptOutEffects.entries()]) {
        if (wanted.has(actor))
            continue;
        _cullOptOutEffects.delete(actor);
        try {
            if (isActorValid(actor))
                actor.remove_effect(effect);
        }
        catch { }
    }
    if (_cullOptOutEffects.size !== before) {
        utilsLog(`[cull-opt-out] holding ${_cullOptOutEffects.size} window actor(s)` +
            ` [${[..._cullOptOutEffects.keys()].map(a => {
                try {
                    return a.get_meta_window()?.get_title() ?? '?';
                }
                catch {
                    return '?';
                }
            }).join(', ')}]`);
    }
}
function _sameSet(a, b) {
    if (!a)
        return false;
    let n = 0;
    for (const x of b) {
        if (!a.has(x))
            return false;
        n++;
    }
    return n === a.size;
}
export function reportClonedWindowActors(owner, actors) {
    if (_sameSet(_cullOptOutOwners.get(owner), actors))
        return;
    _cullOptOutOwners.set(owner, new Set(actors));
    _reconcileCullOptOut();
}
export function releaseClonedWindowActors(owner) {
    if (_cullOptOutOwners.delete(owner))
        _reconcileCullOptOut();
}
export function releaseAllClonedWindowActors() {
    _cullOptOutOwners.clear();
    _reconcileCullOptOut();
}
export function setCullOptOutEnabled(enabled) {
    _cullOptOutEnabled = !!enabled;
    _reconcileCullOptOut();
}
export function isCullOptOutEnabled() {
    return _cullOptOutEnabled;
}
