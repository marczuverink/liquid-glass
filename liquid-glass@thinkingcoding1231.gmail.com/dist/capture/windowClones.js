import { isCullSiteEnabled } from './options.js';
import { createBackgroundMirror } from './background.js';
import { UnpickableActor, UnpickableClone } from '../actors/unpickable.js';
import { isActorValid } from '../actors/lifecycle.js';
import { setTranslationIfChanged, setClipIfChanged, setCloneCulled, setSizeIfChanged, setScaleIfChanged, setPivotIfChanged, setOpacityIfChanged, isDiffWritesEnabled } from '../actors/writes.js';
import { getNestedGlassFix, innerGlassEffectOf } from './nestedGlass.js';
import { reportClonedWindowActors, releaseClonedWindowActors } from './windowCulling.js';
import { getWindowActors } from '../actors/windows.js';
import { getAllocatedSize, rectsIntersect } from '../actors/geometry.js';
import { setActorVisible } from '../actors/allocation.js';
export class WindowCloneManager {
    _cullRect = null;
    windowClonesContainer = null;
    _windowClones;
    _damageHooks = new Map();
    bgClone = null;
    container = null;
    cloneContainer = null;
    label;
    constructor(container, cloneContainer = null, label = 'lg') {
        this.container = container;
        this.label = label;
        this._windowClones = new Map();
        this.bgClone = createBackgroundMirror(`${this.label}-bgclone`);
        this.bgClone.connect('destroy', () => { this.bgClone = null; });
        this.windowClonesContainer = new UnpickableActor();
        this.windowClonesContainer.set_name(`${this.label}-window-clones`);
        this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
        this.cloneContainer = cloneContainer;
        if (this.cloneContainer) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        this.container.insert_child_at_index(this.bgClone, 0);
    }
    rebuildClones() {
        if (!isActorValid(this.container))
            return;
        if (isActorValid(this.bgClone)) {
            this.bgClone.destroy();
        }
        if (isActorValid(this.windowClonesContainer)) {
            this.windowClonesContainer.destroy();
        }
        this._windowClones.clear();
        this.bgClone = createBackgroundMirror(`${this.label}-bgclone`);
        this.bgClone.connect('destroy', () => { this.bgClone = null; });
        this.windowClonesContainer = new UnpickableActor();
        this.windowClonesContainer.set_name(`${this.label}-window-clones`);
        this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
        if (isActorValid(this.cloneContainer)) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        this.container.insert_child_at_index(this.bgClone, 0);
        this.sync();
    }
    setOffset(x, y) {
        if (this.windowClonesContainer) {
            if (this.windowClonesContainer.x !== 0 || this.windowClonesContainer.y !== 0)
                this.windowClonesContainer.set_position(0, 0);
            setTranslationIfChanged(this.windowClonesContainer, x, y);
        }
        if (this.bgClone) {
            if (this.bgClone.x !== 0 || this.bgClone.y !== 0)
                this.bgClone.set_position(0, 0);
            setTranslationIfChanged(this.bgClone, x, y);
        }
    }
    setCullRect(rect) {
        this._cullRect = rect;
    }
    applyBgCloneClip(rect) {
        const bg = this.bgClone;
        if (!bg || !isActorValid(bg))
            return;
        if (rect) {
            setClipIfChanged(bg, rect[0], rect[1], rect[2], rect[3]);
        }
        else if (bg._lgClipW !== undefined) {
            bg._lgClipW = undefined;
            try {
                bg.remove_clip();
            }
            catch { }
        }
    }
    _syncDamageHooks() {
        const container = this.container;
        if (getNestedGlassFix() !== 'damage' || !container || !isActorValid(container)) {
            this._releaseDamageHooks();
            return;
        }
        for (const src of this._windowClones.keys()) {
            if (this._damageHooks.has(src))
                continue;
            if (!isActorValid(src) || !innerGlassEffectOf(src))
                continue;
            try {
                const id = src.connect('damaged', () => {
                    if (isActorValid(container) && container.mapped && container.visible)
                        container.queue_redraw();
                });
                this._damageHooks.set(src, id);
            }
            catch { }
        }
        if (this._damageHooks.size > this._windowClones.size) {
            for (const [src, id] of [...this._damageHooks]) {
                if (this._windowClones.has(src))
                    continue;
                try {
                    if (isActorValid(src))
                        src.disconnect(id);
                }
                catch { }
                this._damageHooks.delete(src);
            }
        }
    }
    _releaseDamageHooks() {
        if (this._damageHooks.size === 0)
            return;
        for (const [src, id] of this._damageHooks) {
            try {
                if (isActorValid(src))
                    src.disconnect(id);
            }
            catch { }
        }
        this._damageHooks.clear();
    }
    sync() {
        this._syncDamageHooks();
        reportClonedWindowActors(this, this._windowClones.keys());
        let windows = getWindowActors();
        let activeWindows = new Set();
        let zIndex = 0;
        if (!isActorValid(this.windowClonesContainer))
            return;
        for (let w of windows) {
            if (!isActorValid(w))
                continue;
            let metaWindow = w.get_meta_window();
            if (!metaWindow || metaWindow.minimized || !w.visible)
                continue;
            let [width, height] = getAllocatedSize(w);
            if (width <= 0 || height <= 0)
                continue;
            const wX = w.x + w.translation_x;
            const wY = w.y + w.translation_y;
            activeWindows.add(w);
            const sxSafe = Number.isFinite(w.scale_x) && w.scale_x > 0 ? w.scale_x : 1;
            const sySafe = Number.isFinite(w.scale_y) && w.scale_y > 0 ? w.scale_y : 1;
            const culled = !!this._cullRect && isCullSiteEnabled('windows') &&
                !rectsIntersect(wX, wY, width * sxSafe, height * sySafe, this._cullRect);
            let clone = this._windowClones.get(w);
            if (clone && !isActorValid(clone)) {
                this._windowClones.delete(w);
                clone = undefined;
            }
            if (!clone) {
                clone = new UnpickableClone({ source: w });
                const wTitle = (() => {
                    try {
                        return metaWindow.get_title() || '(untitled)';
                    }
                    catch {
                        return '(?)';
                    }
                })();
                clone.set_name(`${this.label}-winclone:${wTitle}`);
                clone.connect('destroy', () => { this._windowClones.delete(w); });
                this.windowClonesContainer?.add_child(clone);
                this._windowClones.set(w, clone);
            }
            setActorVisible(clone, true);
            setCloneCulled(clone, culled, () => culled
                ? `src=(${Math.round(wX)},${Math.round(wY)},${Math.round(width * sxSafe)}x${Math.round(height * sySafe)}) ` +
                    `cullRect=[${this._cullRect.map(Math.round)}] label=${this.label}`
                : `label=${this.label}`);
            const tX = wX;
            const tY = wY;
            const pX = w.pivot_point ? w.pivot_point.x : 0;
            const pY = w.pivot_point ? w.pivot_point.y : 0;
            clone.remove_transition('position');
            clone.remove_transition('size');
            clone.remove_transition('translation-x');
            clone.remove_transition('translation-y');
            if (clone.x !== 0 || clone.y !== 0)
                clone.set_position(0, 0);
            setTranslationIfChanged(clone, tX, tY);
            setSizeIfChanged(clone, width, height);
            clone.remove_transition('scale-x');
            clone.remove_transition('scale-y');
            setScaleIfChanged(clone, w.scale_x, w.scale_y);
            setPivotIfChanged(clone, pX, pY);
            setOpacityIfChanged(clone, w.opacity);
            if (!isDiffWritesEnabled() || clone._lgZIndex !== zIndex) {
                clone._lgZIndex = zIndex;
                this.windowClonesContainer?.set_child_at_index(clone, zIndex);
            }
            zIndex++;
        }
        for (let [w, clone] of this._windowClones.entries()) {
            if (!activeWindows.has(w)) {
                if (isActorValid(clone))
                    clone.destroy();
                this._windowClones.delete(w);
            }
        }
    }
    destroy() {
        this._releaseDamageHooks();
        releaseClonedWindowActors(this);
        if (isActorValid(this.windowClonesContainer)) {
            try {
                this.windowClonesContainer.destroy();
            }
            catch { }
        }
        this._windowClones.clear();
        if (isActorValid(this.bgClone)) {
            try {
                this.bgClone.destroy();
            }
            catch { }
        }
        this.container = null;
    }
}
