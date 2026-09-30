import { isActorValid } from '../actors/lifecycle.js';
let _nestedGlassFix = 'off';
const NESTED_FIX_MODES = ['off', 'recapture', 'propagate', 'damage'];

export function setNestedGlassFix(mode) {
    _nestedGlassFix = NESTED_FIX_MODES.includes(mode) ? mode : 'off';
}

export function getNestedGlassFix() {
    return _nestedGlassFix;
}

// Clone-placement logging (global._lgGlass.focusDebug). Off by default: it
// logs on every restack, and writing that much to the journal from the
// compositor thread can stall the shell.
let _focusDebugEnabled = false;

export function setFocusDebugEnabled(on) { _focusDebugEnabled = !!on; }

export function isFocusDebugEnabled() { return _focusDebugEnabled; }

/**
 * The LiquidEffect on a window actor's own glass, or null when that window
 * has no glass.
 */
export function innerGlassEffectOf(windowActor) {
    if (!isActorValid(windowActor))
        return null;
    for (const c of windowActor.get_children()) {
        if (c.name !== 'lgw-bg')
            continue;
        const fx = c.get_effects()[0];
        if (fx && typeof fx._recaptureSerial === 'number')
            return fx;
    }
    return null;
}
