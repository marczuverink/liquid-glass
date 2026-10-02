import type { LiquidEffect } from '../liquidEffect.js';
import type { GlassActor } from './backdropGlass.js';

// What a manager drives: the clone-capturing effect or a stage-reading glass
// actor. Both take the same setters.
export type GlassSurface = LiquidEffect | GlassActor;
