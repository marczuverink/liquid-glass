import type { LiquidEffect } from '../liquidEffect.js';
import type { BackdropGlass } from './backdropGlass.js';

// What a manager drives: the clone-capturing effect or the stage-reading
// actor. Both take the same setters.
export type GlassSurface = LiquidEffect | BackdropGlass;
