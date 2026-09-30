import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Another glass surface's background actor: either the actor named
// 'liquid-glass-bg-actor' or one holding a 'liquid-box' child.
export function isGlassBackground(actor) {
    if (actor.get_name() === 'liquid-glass-bg-actor')
        return true;
    return actor.get_children().some((child) => child.get_name() === 'liquid-box');
}

export function excludeOtherGlass(sampler, self) {
    if (!sampler)
        return;
    for (const child of Main.layoutManager.uiGroup.get_children()) {
        if (child !== self && isGlassBackground(child))
            sampler.addExclusion(child);
    }
}
