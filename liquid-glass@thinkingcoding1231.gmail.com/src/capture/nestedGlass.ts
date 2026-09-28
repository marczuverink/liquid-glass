import { isActorValid } from '../actors/lifecycle.js';
export type NestedGlassFix = 'off' | 'recapture' | 'propagate' | 'damage';

let _nestedGlassFix: NestedGlassFix = 'off';

const NESTED_FIX_MODES: NestedGlassFix[] = ['off', 'recapture', 'propagate', 'damage'];

export function setNestedGlassFix(mode: NestedGlassFix): void {
  _nestedGlassFix = NESTED_FIX_MODES.includes(mode) ? mode : 'off';
}

export function getNestedGlassFix(): NestedGlassFix {
  return _nestedGlassFix;
}

let _focusDebugEnabled = false;

export function setFocusDebugEnabled(on: boolean): void { _focusDebugEnabled = !!on; }
export function isFocusDebugEnabled(): boolean { return _focusDebugEnabled; }

export function innerGlassEffectOf(windowActor: any): any | null {
  try {
    if (!windowActor || !isActorValid(windowActor)) return null;
    for (const c of windowActor.get_children()) {
      if ((c.name || '') !== 'lgw-bg') continue;
      const fx = c.get_effects()[0];
      if (fx && typeof fx._recaptureSerial === 'number') return fx;
    }
  } catch (_) { }
  return null;
}
