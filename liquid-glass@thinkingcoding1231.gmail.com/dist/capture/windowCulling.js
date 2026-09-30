import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import { isActorValid } from '../actors/lifecycle.js';
import { utilsLog } from '../diagnostics/logging.js';
/**
 * Stops mutter from clipping a window we clone to the frame's damage region.
 * MetaSurfaceActor stores the damage clip on its MetaShapedTexture, which
 * applies it even while painted through a clone, so a clone of a window
 * paints only where the frame was damaged. meta-cullable.c skips actors that
 * carry an active ClutterEffect (and passes their children a NULL clip), so an
 * empty effect on each cloned window actor makes the clone paint in full.
 * Those windows no longer occlude what is behind them, so the effect is only
 * kept while some glass clones the window.
 */
export const CullOptOutEffect = GObject.registerClass(
// Empty: the default paint passes the actor through unchanged.
class CullOptOutEffect extends Clutter.Effect {
});
const CULL_OPT_OUT_NAME = 'lg-cull-opt-out';
const _cullOptOutOwners = new Map();
const _cullOptOutEffects = new Map();
let _cullOptOutEnabled = true;
function _reconcileCullOptOut() {
    const before = _cullOptOutEffects.size;
    const wanted = _wantedCullOptOutActors();
    for (const actor of wanted) {
        if (_cullOptOutEffects.has(actor))
            continue;
        const effect = new CullOptOutEffect();
        actor.add_effect_with_name(CULL_OPT_OUT_NAME, effect);
        _cullOptOutEffects.set(actor, effect);
    }
    for (const [actor, effect] of [..._cullOptOutEffects.entries()]) {
        if (wanted.has(actor))
            continue;
        _cullOptOutEffects.delete(actor);
        if (isActorValid(actor))
            actor.remove_effect(effect);
    }
    if (_cullOptOutEffects.size !== before) {
        _reportCullOptOut();
    }
}
function _wantedCullOptOutActors() {
    const wanted = new Set();
    if (_cullOptOutEnabled) {
        for (const actors of _cullOptOutOwners.values()) {
            for (const actor of actors) {
                if (isActorValid(actor))
                    wanted.add(actor);
            }
        }
    }
    return wanted;
}
function _reportCullOptOut() {
    utilsLog(`[cull-opt-out] holding ${_cullOptOutEffects.size} window actor(s)` +
        ` [${[..._cullOptOutEffects.keys()].map(a => a.get_meta_window()?.get_title() ?? '?').join(', ')}]`);
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
/**
 * Declares which window actors `owner` currently clones. Safe to call every
 * frame: it returns immediately unless the set actually changed.
 */
export function reportClonedWindowActors(owner, actors) {
    if (_sameSet(_cullOptOutOwners.get(owner), actors))
        return;
    _cullOptOutOwners.set(owner, new Set(actors));
    _reconcileCullOptOut();
}
/** Drops `owner`'s claim; call when a manager or a window's glass goes away. */
export function releaseClonedWindowActors(owner) {
    if (_cullOptOutOwners.delete(owner))
        _reconcileCullOptOut();
}
/** Drops every claim and every effect; call from the extension's disable(). */
export function releaseAllClonedWindowActors() {
    _cullOptOutOwners.clear();
    _reconcileCullOptOut();
}
// false restores mutter's normal culling of cloned windows (global._lgGlass.cullOptOut).
export function setCullOptOutEnabled(enabled) {
    _cullOptOutEnabled = !!enabled;
    _reconcileCullOptOut();
}
export function isCullOptOutEnabled() {
    return _cullOptOutEnabled;
}
