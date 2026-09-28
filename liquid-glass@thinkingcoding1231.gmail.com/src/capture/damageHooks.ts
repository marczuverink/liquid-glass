import { isActorValid } from '../actors/lifecycle.js';
import { innerGlassEffectOf } from './nestedGlass.js';

export function syncDamageHooks(
  hooks: Map<any, number>, sources: ReadonlyMap<any, unknown>, onDamage: () => void,
): void {
  for (const source of sources.keys()) {
    if (hooks.has(source) || !isActorValid(source) || !innerGlassEffectOf(source)) continue;
    try {
      hooks.set(source, source.connect('damaged', onDamage));
    } catch { }
  }
  // Drop handlers for windows this glass no longer clones, or that lost their
  // inner glass, so the map cannot grow with every window that has ever been
  // behind this one (and cannot keep those actors alive).
  for (const [source, id] of hooks) {
    if (sources.has(source) && isActorValid(source) && innerGlassEffectOf(source)) continue;
    try { if (isActorValid(source)) source.disconnect(id); } catch { }
    hooks.delete(source);
  }
}

export function releaseDamageHooks(hooks: Map<any, number>): void {
  for (const [source, id] of hooks) {
    try { if (isActorValid(source)) source.disconnect(id); } catch { }
  }
  hooks.clear();
}
