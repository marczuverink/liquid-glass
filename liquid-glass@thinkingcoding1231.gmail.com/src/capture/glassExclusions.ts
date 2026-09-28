import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function nameOf(actor: any): string | null {
  return actor?.get_name?.() ?? actor?.name ?? null;
}

export function isGlassBackground(actor: any): boolean {
  if (nameOf(actor) === 'liquid-glass-bg-actor') return true;
  if (typeof actor?.get_children !== 'function') return false;
  return actor.get_children().some((child: any) => nameOf(child) === 'liquid-box');
}

export function excludeOtherGlass(sampler: { addExclusion(actor: any): void } | null | undefined, self: any): void {
  if (!sampler) return;
  for (const child of Main.layoutManager.uiGroup.get_children()) {
    if (child !== self && isGlassBackground(child)) sampler.addExclusion(child);
  }
}
