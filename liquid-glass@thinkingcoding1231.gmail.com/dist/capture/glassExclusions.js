import * as Main from 'resource:///org/gnome/shell/ui/main.js';
function nameOf(actor) {
    return actor?.get_name?.() ?? actor?.name ?? null;
}
// 名前が 'liquid-glass-bg-actor' のもの、または 'liquid-box' を子に持つものを
// 他のLiquid Glassエフェクトの背景アクターと判定する
export function isGlassBackground(actor) {
    if (nameOf(actor) === 'liquid-glass-bg-actor')
        return true;
    if (typeof actor?.get_children !== 'function')
        return false;
    return actor.get_children().some((child) => nameOf(child) === 'liquid-box');
}
export function excludeOtherGlass(sampler, self) {
    if (!sampler)
        return;
    // Also exclude any other liquid-glass bgActors already in uiGroup
    for (const child of Main.layoutManager.uiGroup.get_children()) {
        if (child !== self && isGlassBackground(child))
            sampler.addExclusion(child);
    }
}
