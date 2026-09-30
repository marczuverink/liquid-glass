import { isActorValid } from '../actors/lifecycle.js';
import { innerGlassEffectOf } from './nestedGlass.js';

export function syncDamageHooks(
  hooks: Map<any, number>, sources: ReadonlyMap<any, unknown>, onDamage: () => void,
): void {
  for (const source of sources.keys()) {
    if (hooks.has(source) || !isActorValid(source) || !innerGlassEffectOf(source)) continue;
    hooks.set(source, source.connect('damaged', onDamage));
  }
  // Drop windows this glass no longer clones, so the map does not keep every
  // window that was ever behind it alive.
  for (const [source, id] of hooks) {
    if (sources.has(source) && isActorValid(source) && innerGlassEffectOf(source)) continue;
    if (isActorValid(source)) source.disconnect(id);
    hooks.delete(source);
  }
}

export function releaseDamageHooks(hooks: Map<any, number>): void {
  for (const [source, id] of hooks) {
    if (isActorValid(source)) source.disconnect(id);
  }
  hooks.clear();
}
