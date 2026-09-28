import { isActorValid } from '../actors/lifecycle.js';
let _nestedGlassFix = 'off';
const NESTED_FIX_MODES = ['off', 'recapture', 'propagate', 'damage'];
export function setNestedGlassFix(mode) {
    _nestedGlassFix = NESTED_FIX_MODES.includes(mode) ? mode : 'off';
}
export function getNestedGlassFix() {
    return _nestedGlassFix;
}
let _focusDebugEnabled = false;
export function setFocusDebugEnabled(on) { _focusDebugEnabled = !!on; }
export function isFocusDebugEnabled() { return _focusDebugEnabled; }
export function innerGlassEffectOf(windowActor) {
    try {
        if (!windowActor || !isActorValid(windowActor))
            return null;
        for (const c of windowActor.get_children()) {
            if ((c.name || '') !== 'lgw-bg')
                continue;
            const fx = c.get_effects()[0];
            if (fx && typeof fx._recaptureSerial === 'number')
                return fx;
        }
    }
    catch (_) { }
    return null;
}
