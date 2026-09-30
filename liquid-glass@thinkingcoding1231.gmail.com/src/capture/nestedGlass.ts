import { isActorValid } from '../actors/lifecycle.js';

// How a glass that clones a window with its own glass is repaired when that
// inner glass re-renders. 'off' is the default: the black frames these modes
// worked around came from cloning _backgroundGroup, which BackgroundMirror
// (background.ts) fixes at the source. The others stay for A/B comparison
// through global._lgGlass.nestedFix():
//   'damage'     queue a redraw of the outer glass when an inner one damages;
//   'recapture'  never reuse the outer capture (correct, but repaints every frame);
//   'propagate'  re-capture on the frame after an inner re-render (one frame late).
export type NestedGlassFix = 'off' | 'recapture' | 'propagate' | 'damage';

let _nestedGlassFix: NestedGlassFix = 'off';

const NESTED_FIX_MODES: NestedGlassFix[] = ['off', 'recapture', 'propagate', 'damage'];

export function setNestedGlassFix(mode: NestedGlassFix): void {
  _nestedGlassFix = NESTED_FIX_MODES.includes(mode) ? mode : 'off';
}

export function getNestedGlassFix(): NestedGlassFix {
  return _nestedGlassFix;
}

// Clone-placement logging (global._lgGlass.focusDebug). Off by default: it
// logs on every restack, and writing that much to the journal from the
// compositor thread can stall the shell.
let _focusDebugEnabled = false;

export function setFocusDebugEnabled(on: boolean): void { _focusDebugEnabled = !!on; }
export function isFocusDebugEnabled(): boolean { return _focusDebugEnabled; }

/**
 * The LiquidEffect on a window actor's own glass, or null when that window
 * has no glass.
 */
export function innerGlassEffectOf(windowActor: any): any | null {
  if (!isActorValid(windowActor)) return null;
  for (const c of windowActor.get_children()) {
    if (c.name !== 'lgw-bg') continue;
    const fx = c.get_effects()[0];
    if (fx && typeof fx._recaptureSerial === 'number') return fx;
  }
  return null;
}
