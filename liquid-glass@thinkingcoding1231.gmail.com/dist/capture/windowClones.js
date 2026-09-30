import { isCullSiteEnabled } from './options.js';
import { createBackgroundMirror } from './background.js';
import { UnpickableActor, UnpickableClone } from '../actors/unpickable.js';
import { isActorValid } from '../actors/lifecycle.js';
import { setTranslationIfChanged, setClipIfChanged, setCloneCulled, setSizeIfChanged, setScaleIfChanged, setPivotIfChanged, setOpacityIfChanged, isDiffWritesEnabled } from '../actors/writes.js';
import { getNestedGlassFix } from './nestedGlass.js';
import { syncDamageHooks, releaseDamageHooks } from './damageHooks.js';
import { reportClonedWindowActors, releaseClonedWindowActors } from './windowCulling.js';
import { getWindowActors } from '../actors/windows.js';
import { getAllocatedSize, rectsIntersect } from '../actors/geometry.js';
import { setActorVisible } from '../actors/allocation.js';

export class WindowCloneManager {
    // The screen rect this glass can show; see setCullRect().
    _cullRect = null;
    windowClonesContainer = null;
    _windowClones;
    // 'damaged' handlers on cloned windows that have their own glass; see
    // _syncDamageHooks().
    _damageHooks = new Map();
    // The wallpaper, as a BackgroundMirror.
    bgClone = null;
    container = null;
    cloneContainer = null;
    // Prefix for the names of every actor created here, so Clutter's warnings
    // (which print actor names) say which glass they are about.
    label;

    constructor(container, cloneContainer = null, label = 'lg') {
        this.container = container;
        this.label = label;
        this._windowClones = new Map();
        this.cloneContainer = cloneContainer;
        this._createClones();
    }

    // The wallpaper sits at the back of `container`; the window clones go into
    // `cloneContainer` when there is one, else into `container` above it.
    _createClones() {
        this.bgClone = createBackgroundMirror(`${this.label}-bgclone`);
        this.bgClone.connect('destroy', () => { this.bgClone = null; });
        this.windowClonesContainer = new UnpickableActor();
        this.windowClonesContainer.set_name(`${this.label}-window-clones`);
        this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
        if (isActorValid(this.cloneContainer))
            this.cloneContainer.add_child(this.windowClonesContainer);
        else
            this.container.add_child(this.windowClonesContainer);
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
        this._createClones();
        this.sync();
    }

    // Clones sit at their windows' screen positions and the glass's background
    // actor sits at the monitor origin, so callers pass (-monitor.x, -monitor.y).
    // Applied as a translation, like the clones themselves (see
    // _syncWindowClone()).
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

    // The screen rect this glass can show, or null to draw every window.
    setCullRect(rect) {
        this._cullRect = rect;
    }

    /**
     * Clips the wallpaper, which is outside the clone container and so not
     * covered by its clip. `rect` is in screen coordinates: the clip applies
     * inside the actor's own transform, and bgClone's local space is screen
     * space (see setOffset()).
     */
    applyBgCloneClip(rect) {
        const bg = this.bgClone;
        if (!bg || !isActorValid(bg))
            return;
        if (rect) {
            setClipIfChanged(bg, rect[0], rect[1], rect[2], rect[3]);
        }
        else if (bg._lgClipW !== undefined) {
            bg._lgClipW = undefined;
            bg.remove_clip();
        }
    }

    // The 'damage' nested-glass repair (see NestedGlassFix): redraw this glass
    // when a cloned window with its own glass is damaged. 'damaged' fires before
    // the frame is painted, so the redraw lands in the same frame.
    _syncDamageHooks() {
        const container = this.container;
        if (getNestedGlassFix() !== 'damage' || !container || !isActorValid(container)) {
            this._releaseDamageHooks();
            return;
        }
        syncDamageHooks(this._damageHooks, this._windowClones, () => {
            if (isActorValid(container) && container.mapped && container.visible)
                container.queue_redraw();
        });
    }

    _releaseDamageHooks() {
        releaseDamageHooks(this._damageHooks);
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
            // The allocated size: w.width/w.height fall back to the preferred size
            // while a relayout is pending (see getAllocatedSize()).
            let [width, height] = getAllocatedSize(w);
            if (width <= 0 || height <= 0)
                continue;
            // The window's screen position, the same space as _cullRect.
            const wX = w.x + w.translation_x;
            const wY = w.y + w.translation_y;
            // Culled windows stay active: their clones are kept and placed, just
            // not painted.
            activeWindows.add(w);
            this._syncWindowClone(w, metaWindow, width, height, wX, wY, zIndex);
            zIndex++;
        }
        // Drop clones of windows that closed or were minimized.
        for (let [w, clone] of this._windowClones.entries()) {
            if (!activeWindows.has(w)) {
                if (isActorValid(clone))
                    clone.destroy();
                this._windowClones.delete(w);
            }
        }
    }

    _ensureWindowClone(w, metaWindow) {
        let clone = this._windowClones.get(w);
        // rebuildClones() destroys clones along with their container.
        if (clone && !isActorValid(clone)) {
            this._windowClones.delete(w);
            clone = undefined;
        }
        if (!clone) {
            clone = new UnpickableClone({ source: w });
            const wTitle = metaWindow.get_title() || '(untitled)';
            clone.set_name(`${this.label}-winclone:${wTitle}`);
            clone.connect('destroy', () => { this._windowClones.delete(w); });
            this.windowClonesContainer?.add_child(clone);
            this._windowClones.set(w, clone);
        }
        return clone;
    }

    _syncWindowClone(w, metaWindow, width, height, wX, wY, zIndex) {
        const sxSafe = Number.isFinite(w.scale_x) && w.scale_x > 0 ? w.scale_x : 1;
        const sySafe = Number.isFinite(w.scale_y) && w.scale_y > 0 ? w.scale_y : 1;
        // Culled clones are still created, placed and indexed; only painting
        // stops. Rebuilding a clone on every boundary crossing would lose damage
        // (a new actor is unmapped) and renumber the whole stack.
        const culled = !!this._cullRect && isCullSiteEnabled('windows') &&
            !rectsIntersect(wX, wY, width * sxSafe, height * sySafe, this._cullRect);
        const clone = this._ensureWindowClone(w, metaWindow);
        // Map the clone first; an unmapped actor cannot report damage.
        setActorVisible(clone, true);
        setCloneCulled(clone, culled, () => culled
            ? `src=(${Math.round(wX)},${Math.round(wY)},${Math.round(width * sxSafe)}x${Math.round(height * sySafe)}) ` +
                `cullRect=[${this._cullRect.map(Math.round)}] label=${this.label}`
            : `label=${this.label}`);
        const pX = w.pivot_point ? w.pivot_point.x : 0;
        const pY = w.pivot_point ? w.pivot_point.y : 0;
        // Always removed: a live transition would keep driving a property whose
        // write is skipped, and the write cache would drift from the actor.
        clone.remove_transition('position');
        clone.remove_transition('size');
        clone.remove_transition('translation-x');
        clone.remove_transition('translation-y');
        // Placed by translation, which only needs a redraw. set_position() waits
        // for a relayout, and a subtree that stops being allocated (see
        // actors/allocation.ts) would leave the clone where the window used to be.
        if (clone.x !== 0 || clone.y !== 0)
            clone.set_position(0, 0);
        setTranslationIfChanged(clone, wX, wY);
        setSizeIfChanged(clone, width, height);
        clone.remove_transition('scale-x');
        clone.remove_transition('scale-y');
        setScaleIfChanged(clone, w.scale_x, w.scale_y);
        setPivotIfChanged(clone, pX, pY);
        // A clone paints with its own opacity, not the source's, so follow the
        // window's fade during the shell's open and close animations.
        setOpacityIfChanged(clone, w.opacity);
        // set_child_at_index() queues a relayout even for the current index, so
        // only call it when the stacking order changed.
        if (!isDiffWritesEnabled() || clone._lgZIndex !== zIndex) {
            clone._lgZIndex = zIndex;
            this.windowClonesContainer?.set_child_at_index(clone, zIndex);
        }
    }

    destroy() {
        // Both live on mutter's window actors, which outlive this manager.
        this._releaseDamageHooks();
        releaseClonedWindowActors(this);
        if (isActorValid(this.windowClonesContainer))
            this.windowClonesContainer.destroy();
        this._windowClones.clear();
        if (isActorValid(this.bgClone))
            this.bgClone.destroy();
        this.container = null;
    }
}
