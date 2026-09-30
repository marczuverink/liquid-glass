import Clutter from 'gi://Clutter';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { isCullSiteEnabled } from './options.js';
import { UnpickableActor, UnpickableClone } from '../actors/unpickable.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import { utilsLog, utilsLogEnabled, diagnosticLog } from '../diagnostics/logging.js';
import Shell from 'gi://Shell';
import { isActorValid } from '../actors/lifecycle.js';
import { getAllocatedSize, rectsIntersect } from '../actors/geometry.js';
import { setActorVisible } from '../actors/allocation.js';
import { setPositionIfChanged, setSizeIfChanged, setOpacityIfChanged, setCloneCulled, setTranslationIfChanged, setScaleIfChanged, setPivotIfChanged } from '../actors/writes.js';
import { acquireSelfExcludingSnapshot, releaseSelfExcludingSnapshot } from './snapshot.js';
import { TextureBlitActor } from '../actors/textureBlit.js';
import { getSharedBackgroundSource } from './background.js';
import { reportClonedWindowActors, releaseClonedWindowActors } from './windowCulling.js';
import { getWindowActors } from '../actors/windows.js';
/**
 * How UILayerSampler supplies a uiGroup child that holds Blur My Shell's panel
 * blur. REPLICATE is the default; the others stay for comparison through
 * global._lgGlass.bmsMode():
 *
 *   SNAPSHOT   a self-excluding stage snapshot of the child's rect. Captures
 *              anything else overlapping it too (dock icons ghost into the
 *              dock's glass) and repaints the stage every frame.
 *   CLONE      an ordinary clone. Painting BMS's effect a second time, from
 *              another framebuffer, makes the real panel's blur drift.
 *   SKIP       leave the panel out of the glass.
 *   REPLICATE  clone the panel without BMS's blur widget, and draw our own
 *              instance of BMS's blur effect under it. BMS puts its widget
 *              into panel_box as a sibling of the panel, so leaving it out is
 *              just a matter of which children to clone. Nothing is painted
 *              twice and nothing is snapshotted.
 */
export const BMS_MODE = { SNAPSHOT: 0, CLONE: 1, SKIP: 2, REPLICATE: 3 };
let _bmsMode = BMS_MODE.REPLICATE;
// Every live sampler, so a mode change can rebuild the affected clones.
const _liveSamplers = new Set();
export function setBmsMode(mode) {
    _bmsMode = mode;
    for (const sampler of _liveSamplers)
        sampler.rebuildBmsClones();
    const name = Object.keys(BMS_MODE).find(k => BMS_MODE[k] === mode) ?? `? (${mode})`;
    const msg = `[Liquid Glass] BMS mode = ${name} on ${_liveSamplers.size} sampler(s)`;
    diagnosticLog(msg);
    return msg;
}
export function getBmsMode() {
    return _bmsMode;
}
/**
 * Clones the children of Main.layoutManager.uiGroup (panel, window groups,
 * other extensions' UI) into the glass, so the glass shows everything behind
 * it. One instance per glass.
 */
export class UILayerSampler {
    _selfActor;
    _container;
    _extraExclusions;
    _selfRoot = null;
    _label = '?';
    // Per cloned child: whether a Blur My Shell target was found under it at the
    // moment its clone was built.
    _bmsStateAtClone = new Map();
    // The BMS target actor as of the last refresh(), so a change can be noticed.
    _lastBmsTarget = undefined;
    _ancestorExclusionSources = [];
    // Names of the uiGroup children currently cloned, so a change can be logged
    // once instead of every frame.
    _clonedNamesLogged = '';
    _clones = new Map();
    _sourceDestroyIds = new Map();
    _dragActor = null;
    _dragMonitor = {
        dragMotion: (event) => {
            this._dragActor = event.dragActor;
            return DND.DragMotionResult.CONTINUE;
        },
    };
    _uiClonesContainer = null;
    // Per uiGroup child: an OffscreenEffect found in its subtree, or null.
    _existingEffectCache = new Map();
    // Snapshot clone -> what it registered on the shared snapshot capture.
    _delayedCaptureOwners = new Map();
    // Clones not on their source's screen rect; see _checkCloneDrift().
    _driftingClones = new Set();
    // The screen rect this glass can show, or null to cull only against the
    // container. Set every frame by syncGlassCaptureClip().
    _cullRect = null;
    // Screen rects of the Blur My Shell replicas drawn this frame. Their blur
    // reads the framebuffer under the panel, so the capture clip must keep
    // those rects painted (see syncGlassCaptureClip()).
    _bmsScreenRects = [];
    constructor(selfActor, container, extraExclusions = [], cloneContainer = null, label = '?', 
    /**
     * Actors whose uiGroup ancestor is excluded, resolved on every refresh():
     * Dash to Dock rebuilds its container when its settings change, and a
     * stale exclusion would clone the dock into its own glass.
     */
    ancestorExclusions = []) {
        this._selfActor = selfActor;
        this._container = container;
        this._extraExclusions = new Set(extraExclusions);
        this._ancestorExclusionSources = ancestorExclusions.slice();
        this._label = label;
        this._selfRoot = this._findUiGroupAncestor(selfActor);
        _liveSamplers.add(this);
        this._uiClonesContainer = new UnpickableActor();
        this._uiClonesContainer.set_name("ui-clones-container");
        this._uiClonesContainer.connect('destroy', () => {
            this._uiClonesContainer = null;
        });
        if (cloneContainer) {
            cloneContainer.add_child(this._uiClonesContainer);
        }
        else {
            this._container.add_child(this._uiClonesContainer);
        }
        DND.addDragMonitor(this._dragMonitor);
    }
    // Restricts culling to `rect` (screen coordinates), or null for the
    // container's bounds.
    setCullRect(rect) {
        this._cullRect = rect;
    }
    // The BMS replica rects from the previous sync (the clip is computed
    // before the clones sync); the panel does not move.
    getBmsScreenRects() {
        return this._bmsScreenRects;
    }
    /** True when this sampler has a BMS replica whose rect is not known yet. */
    hasUnmeasuredBmsReplica() {
        if (this._bmsScreenRects.length > 0)
            return false;
        for (const clone of this._clones.values()) {
            if (clone._lgBmsReplica)
                return true;
        }
        return false;
    }
    _findUiGroupAncestor(actor) {
        const uiGroup = Main.layoutManager.uiGroup;
        let current = actor;
        while (current) {
            if (current.get_parent() === uiGroup)
                return current;
            current = current.get_parent();
        }
        return null;
    }
    /** Adds an actor to the set of uiGroup children that should never be cloned. */
    addExclusion(actor) {
        if (!actor)
            return;
        this._extraExclusions.add(actor);
    }
    /**
     * Blur My Shell's panel-blur actor, when BMS is enabled. This reads BMS's
     * internals, which can be absent or change between its versions, so every
     * step is optional; without it the panel is cloned normally.
     */
    _resolveBmsTargetActor() {
        const ext = Main.extensionManager.lookup('blur-my-shell@aunetx');
        return ext?.stateObj?._panel_blur?.actors_list?.[0]?.bg_manager?.backgroundActor ?? null;
    }
    // The BMS actor if `child` (a uiGroup child) is or contains it.
    _findBmsDescendant(child) {
        const target = this._resolveBmsTargetActor();
        if (!target)
            return null;
        return child === target || child.contains(target) ? target : null;
    }
    /**
     * The REPLICATE stand-in for panel_box: a widget carrying our own copy of
     * BMS's blur effect (radius and brightness follow BMS's live effect), then
     * clones of every child of panel_box except BMS's own blur group. Our blur
     * samples the cloned wallpaper and windows behind it inside the offscreen,
     * the same relationship BMS's has to the real framebuffer.
     */
    _createBmsReplicaActor(child) {
        const target = this._findBmsDescendant(child);
        if (!target)
            return null;
        // The child of panel_box that holds BMS's blur widget is left out.
        let bmsGroup = target;
        while (bmsGroup && bmsGroup.get_parent() !== child)
            bmsGroup = bmsGroup.get_parent();
        if (!bmsGroup)
            return null;
        const container = new UnpickableActor();
        container.set_name(`${child.name ?? 'bms'}-replica`);
        const blurWidget = new St.Widget({ name: 'lg-bms-replica-blur' });
        blurWidget.add_effect(this._buildReplicaBlurEffect(target));
        container.add_child(blurWidget);
        const parts = [];
        for (const c of child.get_children()) {
            if (c === bmsGroup)
                continue;
            const clone = new UnpickableClone({ source: c });
            clone.set_name(`${c.name ?? 'part'}-replicaClone`);
            container.add_child(clone);
            parts.push({ src: c, clone });
        }
        if (parts.length === 0) {
            container.destroy();
            return null;
        }
        container._lgBmsReplica = { blurWidget, parts, bmsTarget: target };
        utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS replica built for ` +
            `name="${child.name ?? '(unnamed)'}" with ${parts.length} part(s)`);
        return container;
    }
    // Where the container's own pixels start inside its offscreen, as published
    // by LiquidEffect on each paint; (0, 0) until then.
    _captureOffset() {
        const off = this._container._lgCaptureOffset;
        if (Array.isArray(off) && Number.isFinite(off[0]) && Number.isFinite(off[1]))
            return [off[0], off[1]];
        return [0, 0];
    }
    /**
     * A blur effect of the same class BMS uses on the real panel. BMS picks the
     * Blur module's effect when it is installed and gnome-shell's otherwise,
     * and the two differ visibly at large radii, so the class is taken from
     * BMS's live effect. BMS's constructor comes from another extension and
     * may change, so a failure falls back to Shell.BlurEffect.
     */
    _buildReplicaBlurEffect(bmsTarget) {
        const theirs = bmsTarget.get_effects()
            .find((e) => typeof e.radius === 'number');
        if (theirs) {
            const Ctor = theirs.constructor;
            // corner_radius must be a number: BMS passes it to GObject, which
            // rejects undefined, and its unscaled_corner_radius is often unset.
            const params = {
                unscaled_radius: theirs.unscaled_radius ?? theirs.radius ?? 0,
                brightness: theirs.brightness ?? 1.0,
                corner_radius: theirs.unscaled_corner_radius ?? theirs.corner_radius ?? 0,
            };
            try {
                const ours = new Ctor(params);
                utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica blur uses ` +
                    `${Ctor.name} (matching BMS's own effect), ` +
                    `unscaled_radius=${params.unscaled_radius} brightness=${params.brightness} ` +
                    `corner_radius=${params.corner_radius}`);
                return ours;
            }
            catch (e) {
                utilsLog(`[Liquid Glass][ui-sampler:${this._label}] could not mirror BMS's ` +
                    `blur effect (${e}); falling back to Shell.BlurEffect`);
            }
        }
        return new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: 0,
            brightness: 1.0,
        });
    }
    // Per-frame geometry of a replica: each part at its place inside
    // panel_box, and the blur widget on the panel's rect, as BMS places its own.
    _syncBmsReplica(source, replica) {
        const parts = replica.parts;
        const panelRect = this._syncReplicaParts(parts);
        const blurWidget = replica.blurWidget;
        if (isActorValid(blurWidget) && panelRect) {
            replica.panelRect = panelRect;
            // A background blur blits its rect by stage coordinates out of the
            // current framebuffer. In our offscreen the actor's (0, 0) is at the
            // capture padding's offset, so without this shift the blit reads the
            // cleared padding and smears it over the blur.
            const [offX, offY] = this._captureOffset();
            setPositionIfChanged(blurWidget, panelRect[0] + offX, panelRect[1] + offY);
            setSizeIfChanged(blurWidget, panelRect[2], panelRect[3]);
            setActorVisible(blurWidget, true);
            // BMS's live effect already holds its values scaled for the theme.
            this._syncReplicaBlur(blurWidget, replica.bmsTarget);
        }
        this._reportReplicaGeometry(source, replica);
    }
    _syncReplicaParts(parts) {
        let panelRect = null;
        for (const { src, clone } of parts) {
            if (!isActorValid(src) || !isActorValid(clone))
                continue;
            const [w, h] = getAllocatedSize(src);
            if (!(w > 0) || !(h > 0)) {
                setActorVisible(clone, false);
                continue;
            }
            setPositionIfChanged(clone, src.x, src.y);
            setSizeIfChanged(clone, w, h);
            setOpacityIfChanged(clone, src.opacity);
            setActorVisible(clone, src.visible && src.mapped);
            if (!panelRect)
                panelRect = [src.x, src.y, w, h];
        }
        return panelRect;
    }
    _syncReplicaBlur(blurWidget, src) {
        let ours = blurWidget.get_effects()[0];
        if (!ours || !isActorValid(src))
            return;
        const theirs = src.get_effects().find((e) => typeof e.radius === 'number');
        if (!theirs)
            return;
        // Rebuild if the classes differ (BMS's effect was not there yet when the
        // replica was built, or copying it failed).
        if (ours.constructor !== theirs.constructor) {
            blurWidget.remove_effect(ours);
            blurWidget.add_effect(this._buildReplicaBlurEffect(src));
            ours = blurWidget.get_effects()[0];
        }
        if (ours.radius !== theirs.radius)
            ours.radius = theirs.radius;
        if (ours.brightness !== theirs.brightness)
            ours.brightness = theirs.brightness;
    }
    // Logs the replica's geometry when it changes (with logging on).
    _reportReplicaGeometry(source, replica) {
        if (!utilsLogEnabled())
            return;
        const blurWidget = replica.blurWidget;
        const [srcAbsX, srcAbsY] = source.get_transformed_position();
        const [bwAbsX, bwAbsY] = blurWidget.get_transformed_position();
        const [bwW, bwH] = blurWidget.get_size();
        const ours = blurWidget.get_effects()[0];
        const theirs = replica.bmsTarget.get_effects()
            .find((e) => typeof e.radius === 'number');
        const parts = replica.parts
            .map((p) => `${p.src.name ?? '?'}@(${p.src.x},${p.src.y})` +
            `${getAllocatedSize(p.src)[0]}x${getAllocatedSize(p.src)[1]}`)
            .join(' ');
        const line = `src=${source.name ?? '?'}@(${Math.round(srcAbsX)},${Math.round(srcAbsY)}) ` +
            `parts=[${parts}] ` +
            `blur=(${blurWidget.x},${blurWidget.y}) ${bwW}x${bwH} ` +
            `blurAbs=(${Math.round(bwAbsX)},${Math.round(bwAbsY)}) ` +
            `r=${ours?.radius}/${theirs?.radius} b=${ours?.brightness}/${theirs?.brightness} ` +
            `capOff=(${this._captureOffset()[0]},${this._captureOffset()[1]}) ` +
            `cls=${ours?.constructor.name ?? '?'}/${theirs?.constructor.name ?? '?'}`;
        if (line === replica.lastGeomLine)
            return;
        replica.lastGeomLine = line;
        utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica geom ${line}`);
    }
    // The SNAPSHOT stand-in; see SelfExcludingSnapshotCapture.
    _createSelfExcludingSnapshotActor(child) {
        const stage = child.get_stage();
        if (!stage || !this._selfRoot)
            return null;
        const selfRoot = this._selfRoot;
        const rectGetter = () => {
            const [x, y] = child.get_transformed_position();
            const [w, h] = getAllocatedSize(child);
            if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0)
                return [0, 0, 0, 0];
            return [x, y, w, h];
        };
        const capture = acquireSelfExcludingSnapshot(child, stage, selfRoot, rectGetter);
        const actor = new UnpickableActor();
        actor.set_name(`${child.name}-selfExcludingSnapshot`);
        // Follows the capture, which also refreshes after every stage paint.
        const applyContent = () => {
            const content = capture.getContent();
            if (content && actor.content !== content)
                actor.content = content;
        };
        const afterPaintId = stage.connect('after-paint', applyContent);
        applyContent();
        this._delayedCaptureOwners.set(actor, { source: child, hideActor: selfRoot });
        actor.connect('destroy', () => {
            stage.disconnect(afterPaintId);
            const owner = this._delayedCaptureOwners.get(actor);
            if (owner) {
                releaseSelfExcludingSnapshot(owner.source, owner.hideActor);
                this._delayedCaptureOwners.delete(actor);
            }
        });
        return actor;
    }
    /**
     * Finds an OffscreenEffect in `root`'s subtree (another extension's JS
     * effect, say), skipping our own ("LiquidGlass*" GTypes).
     */
    _findExistingOffscreenEffect(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            for (const effect of actor.get_effects()) {
                if (!(effect instanceof Clutter.OffscreenEffect))
                    continue;
                const gtypeName = effect.constructor.$gtype.name;
                if (gtypeName.startsWith('LiquidGlass'))
                    continue;
                return { actor, effect: effect };
            }
            for (const c of actor.get_children())
                stack.push(c);
        }
        return null;
    }
    /**
     * SNAPSHOT fallback: paints an existing OffscreenEffect's texture instead
     * of the child. BMS's native effect never matches; other extensions' JS
     * effects can.
     */
    _createExistingEffectBlitActor(child) {
        let found = this._existingEffectCache.get(child);
        if (found === undefined) {
            found = this._findExistingOffscreenEffect(child);
            this._existingEffectCache.set(child, found);
        }
        if (!found)
            return null;
        const { actor: effectOwner, effect } = found;
        const blit = new TextureBlitActor();
        blit.setSourceActor(effectOwner);
        blit.setTextureGetter(() => effect.get_texture());
        return blit;
    }
    rebindSelf() {
        this._selfRoot = this._findUiGroupAncestor(this._selfActor);
    }
    /**
     * Whether `root`'s subtree holds another glass's root ('liquid-glass-bg-actor'
     * or 'liquid-box') at any depth; cloning it would nest that glass in this one.
     */
    _containsOtherLiquidGlassRoot(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            if (actor.name === 'liquid-glass-bg-actor' || actor.name === 'liquid-box')
                return true;
            for (const c of actor.get_children())
                stack.push(c);
        }
        return false;
    }
    // Stacks a new clone to match its source's place among uiGroup's children,
    // instead of at the front where add_child() puts it.
    _insertCloneInZOrder(child, clone) {
        if (!this._uiClonesContainer)
            return;
        const siblings = Main.layoutManager.uiGroup.get_children();
        const idx = siblings.indexOf(child);
        if (idx < 0)
            return;
        let insertAboveClone = null;
        for (let i = idx - 1; i >= 0; i--) {
            const prevClone = this._clones.get(siblings[i]);
            if (prevClone) {
                insertAboveClone = prevClone;
                break;
            }
        }
        if (insertAboveClone)
            this._uiClonesContainer.set_child_above_sibling(clone, insertAboveClone);
        else
            this._uiClonesContainer.set_child_below_sibling(clone, null);
    }
    /**
     * Scans uiGroup's current children, creating/destroying clones as needed.
     * Call whenever the set of top-level UI actors may have changed (e.g. a
     * menu opening or closing).
     */
    refresh() {
        if (!this._selfRoot)
            this._selfRoot = this._findUiGroupAncestor(this._selfActor);
        const uiGroup = Main.layoutManager.uiGroup;
        const children = uiGroup.get_children();
        const seen = new Set();
        if (this._dragActor && !children.includes(this._dragActor))
            this._dragActor = null;
        // Notice BMS appearing or going away, and rebuild the affected clones.
        const bmsTarget = this._resolveBmsTargetActor();
        if (this._lastBmsTarget !== bmsTarget) {
            const first = this._lastBmsTarget === undefined;
            this._lastBmsTarget = bmsTarget;
            if (!first)
                this._reevaluateBmsClones();
        }
        const dynamicExclusions = this._dynamicExclusions();
        for (const child of children) {
            if (!this._isCloneCandidate(child, dynamicExclusions))
                continue;
            seen.add(child);
            if (!this._clones.has(child) && !this._addSourceClone(child))
                seen.delete(child);
        }
        this._pruneSourceClones(seen);
        this._reportClonedSet();
        this._reportClonedWindowGroups();
    }
    _dynamicExclusions() {
        const dynamicExclusions = new Set();
        for (const src of this._ancestorExclusionSources) {
            if (!isActorValid(src))
                continue;
            const root = this._findUiGroupAncestor(src);
            if (root)
                dynamicExclusions.add(root);
        }
        return dynamicExclusions;
    }
    _isCloneCandidate(child, dynamicExclusions) {
        if (!isActorValid(child))
            return false;
        if (child === this._dragActor)
            return false;
        if (child === this._selfActor || child === this._selfRoot)
            return false;
        if (child === Main.layoutManager._backgroundGroup)
            return false;
        // The shared wallpaper mirror lives in uiGroup, but every glass already
        // draws it as its own background.
        if (child === getSharedBackgroundSource())
            return false;
        if (this._extraExclusions.has(child))
            return false;
        if (dynamicExclusions.has(child))
            return false;
        if (!child.visible || !child.mapped)
            return false;
        // The deep scan runs only for children without a clone yet; every frame
        // would be too slow in the overview. The exclusion lasts for the life of
        // this sampler, so it is logged.
        if (!this._clones.has(child) && this._containsOtherLiquidGlassRoot(child)) {
            utilsLog(`[Liquid Glass][ui-sampler] permanent exclusion of uiGroup child ` +
                `name="${child.name ?? '(unnamed)'}" ` +
                `type=${child.constructor.name} ` +
                `(nested liquid-glass root found during deep scan)`);
            this.addExclusion(child);
            return false;
        }
        return true;
    }
    _addSourceClone(child) {
        const bmsTarget = this._findBmsDescendant(child);
        // SKIP is decided here rather than in _isCloneCandidate() so the child
        // stays tracked and is rebuilt when the mode or BMS changes.
        if (bmsTarget && _bmsMode === BMS_MODE.SKIP) {
            return null;
        }
        let sourceClone = null;
        if (bmsTarget && _bmsMode === BMS_MODE.REPLICATE) {
            sourceClone = this._createBmsReplicaActor(child);
            if (!sourceClone) {
                // An ordinary clone would make BMS's panel drift, so leave it out.
                utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS replica ` +
                    `could not be built for name="${child.name ?? '(unnamed)'}"; ` +
                    `leaving it out of the glass rather than cloning BMS's target`);
                return null;
            }
        }
        if (!sourceClone && bmsTarget && _bmsMode === BMS_MODE.SNAPSHOT) {
            sourceClone = this._createSelfExcludingSnapshotActor(child) ??
                this._createExistingEffectBlitActor(child);
        }
        if (!sourceClone)
            sourceClone = new UnpickableClone({ source: child });
        // Re-checked by _reevaluateBmsClones() when BMS comes or goes.
        this._bmsStateAtClone.set(child, !!bmsTarget);
        sourceClone.set_name(`${child.name}-sourceClone`);
        sourceClone.connect('destroy', () => {
            this._clones.delete(child);
        });
        this._uiClonesContainer?.add_child(sourceClone);
        this._clones.set(child, sourceClone);
        this._trackSourceDestroy(child);
        this._insertCloneInZOrder(child, sourceClone);
        return sourceClone;
    }
    _trackSourceDestroy(child) {
        if (!this._sourceDestroyIds.has(child)) {
            this._sourceDestroyIds.set(child, child.connect('destroy', () => {
                this._sourceDestroyIds.delete(child);
                this._bmsStateAtClone.delete(child);
                this._existingEffectCache.delete(child);
                const clone = this._clones.get(child);
                this._clones.delete(child);
                clone?.destroy();
            }));
        }
    }
    _pruneSourceClones(seen) {
        for (const [actor, sourceClone] of this._clones) {
            if (!seen.has(actor)) {
                sourceClone.destroy();
                this._clones.delete(actor);
            }
        }
        for (const [actor, id] of this._sourceDestroyIds) {
            if (this._clones.has(actor))
                continue;
            actor.disconnect(id);
            this._sourceDestroyIds.delete(actor);
            this._bmsStateAtClone.delete(actor);
            this._existingEffectCache.delete(actor);
        }
    }
    // Copies the source's geometry, opacity and visibility onto its clone, and
    // culls the clone outside the cull rect or the container.
    syncProperties(source, sourceClone, containerW, containerH, cX, cY) {
        if (!source || !sourceClone)
            return;
        const [absX, absY] = source.get_transformed_position();
        const [w, h] = getAllocatedSize(source);
        if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
            setActorVisible(sourceClone, false);
            return;
        }
        const scaleX = source.scale_x;
        const scaleY = source.scale_y;
        // The transformed position already includes the source's scale and
        // pivot, so the scale goes into the clone's size and its own scale
        // stays 1; applying it again would double the pivot offset.
        const scaledW = w * scaleX;
        const scaledH = h * scaleY;
        if (this._cullSourceClone(sourceClone, absX, absY, scaledW, scaledH))
            return;
        if (sourceClone.x !== 0 || sourceClone.y !== 0)
            sourceClone.set_position(0, 0);
        setTranslationIfChanged(sourceClone, absX, absY);
        setSizeIfChanged(sourceClone, scaledW, scaledH);
        setScaleIfChanged(sourceClone, 1.0, 1.0);
        setPivotIfChanged(sourceClone, 0, 0);
        setOpacityIfChanged(sourceClone, source.opacity);
        const replica = sourceClone._lgBmsReplica;
        if (replica) {
            this._syncBmsReplica(source, replica);
            // panelRect is local to the clone, whose origin is (absX, absY).
            const pr = replica.panelRect;
            if (pr && pr[2] > 0 && pr[3] > 0)
                this._bmsScreenRects.push([absX + pr[0], absY + pr[1], pr[2], pr[3]]);
        }
        this._checkCloneDrift(source, sourceClone, absX, absY);
        const localX = absX - cX;
        const localY = absY - cY;
        const isVisible = source.visible && source.mapped;
        // Against the container (usually the whole monitor): only catches
        // clones that are off-screen. The real culling is _cullSourceClone().
        if (isVisible && containerW > 0 && containerH > 0) {
            const isIntersecting = localX < containerW &&
                (localX + scaledW) > 0 &&
                localY < containerH &&
                (localY + scaledH) > 0;
            setActorVisible(sourceClone, isIntersecting);
        }
        else {
            setActorVisible(sourceClone, isVisible);
        }
    }
    _cullSourceClone(sourceClone, absX, absY, scaledW, scaledH) {
        // Decided before any write, so a culled clone costs nothing this frame.
        // A clone whose source has no usable rect yet is never culled (it may
        // just be waiting for its first allocation), and a BMS replica only once
        // its panel rect is known; a culled replica keeps reporting that rect.
        const cull = this._cullRect;
        const replica = sourceClone._lgBmsReplica;
        const cullable = !!cull && isCullSiteEnabled('ui') &&
            (!replica || (isCullSiteEnabled('bms') && !!replica.panelRect)) &&
            scaledW > 0 && scaledH > 0 &&
            Number.isFinite(absX) && Number.isFinite(absY);
        if (cullable && !rectsIntersect(absX, absY, scaledW, scaledH, cull)) {
            const pr = replica?.panelRect;
            if (pr && pr[2] > 0 && pr[3] > 0)
                this._bmsScreenRects.push([absX + pr[0], absY + pr[1], pr[2], pr[3]]);
            setCloneCulled(sourceClone, true, () => `src=(${Math.round(absX)},${Math.round(absY)},${Math.round(scaledW)}x${Math.round(scaledH)}) ` +
                `cullRect=[${cull.map(Math.round)}] label=${this._label}`);
            return true;
        }
        setCloneCulled(sourceClone, false, () => `label=${this._label}`);
        return false;
    }
    // Logs a clone that is not on its source's screen rect, once when it
    // drifts and once when it recovers.
    _checkCloneDrift(source, sourceClone, expectX, expectY) {
        if (!utilsLogEnabled()) {
            if (this._driftingClones.size)
                this._driftingClones.clear();
            return;
        }
        const [gotX, gotY] = sourceClone.get_transformed_position();
        const drifted = !Number.isFinite(gotX) || !Number.isFinite(gotY) ||
            Math.abs(gotX - expectX) > 1 || Math.abs(gotY - expectY) > 1;
        const known = this._driftingClones.has(sourceClone);
        if (drifted && !known) {
            this._driftingClones.add(sourceClone);
            utilsLog(`[Liquid Glass][ui-sampler] DRIFT clone for ` +
                `name="${source.name ?? '(unnamed)'}" ` +
                `type=${source.constructor.name} ` +
                `expected=(${Math.round(expectX)},${Math.round(expectY)}) ` +
                `got=(${Math.round(gotX)},${Math.round(gotY)}) ` +
                `containerPos=${this._uiClonesContainer?.get_transformed_position()} ` +
                `clone.hasAlloc=${sourceClone.has_allocation()}`);
        }
        else if (!drifted && known) {
            this._driftingClones.delete(sourceClone);
            utilsLog(`[Liquid Glass][ui-sampler] RECOVERED clone for name="${source.name ?? '(unnamed)'}"`);
        }
    }
    // Callers pass the monitor rect: the clone container is translated by
    // (-monitor.x, -monitor.y) so clones can sit at their sources' screen
    // positions. Without arguments the container's own rect is used.
    sync(cX, cY, cW, cH) {
        this._bmsScreenRects = [];
        let contW = cW ?? 0;
        let contH = cH ?? 0;
        let contAbsX = cX ?? 0;
        let contAbsY = cY ?? 0;
        if (cX === undefined || cY === undefined) {
            const [cw, ch] = this._container.get_size();
            if (!Number.isNaN(cw))
                contW = cw;
            if (!Number.isNaN(ch))
                contH = ch;
            const [tx, ty] = this._container.get_transformed_position();
            contAbsX = Number.isNaN(tx) ? 0 : tx;
            contAbsY = Number.isNaN(ty) ? 0 : ty;
        }
        this._syncCloneContainer(contAbsX, contAbsY);
        for (const [actor, sourceClone] of this._clones) {
            this.syncProperties(actor, sourceClone, contW, contH, contAbsX, contAbsY);
        }
    }
    _syncCloneContainer(contAbsX, contAbsY) {
        // Keep the UI clones in front; WindowCloneManager's rebuilds would
        // otherwise put window clones above them.
        const parent = this._uiClonesContainer?.get_parent();
        if (parent && this._uiClonesContainer) {
            const siblings = parent.get_children();
            if (siblings[siblings.length - 1] !== this._uiClonesContainer)
                parent.set_child_above_sibling(this._uiClonesContainer, null);
        }
        // Placed by translation, like the window clones.
        if (this._uiClonesContainer) {
            if (this._uiClonesContainer.x !== 0 || this._uiClonesContainer.y !== 0)
                this._uiClonesContainer.set_position(0, 0);
            setTranslationIfChanged(this._uiClonesContainer, -contAbsX, -contAbsY);
        }
    }
    /**
     * Drops the clones whose BMS answer changed since they were built, for the
     * next refresh() to rebuild. Otherwise the result would depend on which
     * extension was enabled first. Driven by comparing the resolved target
     * rather than by extension-state-changed, because BMS fills in its actors
     * during and after its own enable().
     */
    _reevaluateBmsClones() {
        this._existingEffectCache.clear();
        for (const [child, wasBms] of [...this._bmsStateAtClone]) {
            if (!isActorValid(child)) {
                this._bmsStateAtClone.delete(child);
                continue;
            }
            const isBms = !!this._findBmsDescendant(child);
            if (isBms === wasBms)
                continue;
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS state changed for ` +
                `name="${child.name ?? '(unnamed)'}" (${wasBms} -> ${isBms}); rebuilding its clone`);
            const clone = this._clones.get(child);
            if (clone) {
                this._clones.delete(child);
                clone.destroy();
            }
            this._bmsStateAtClone.delete(child);
        }
    }
    // Drops every clone of a child that holds BMS, so the next refresh()
    // rebuilds it for the current BMS mode.
    rebuildBmsClones() {
        this._existingEffectCache.clear();
        for (const [child] of [...this._bmsStateAtClone]) {
            if (isActorValid(child) && !this._findBmsDescendant(child))
                continue;
            const clone = this._clones.get(child);
            if (clone) {
                this._clones.delete(child);
                clone.destroy();
            }
            this._bmsStateAtClone.delete(child);
        }
        this._clonedNamesLogged = '';
    }
    /**
     * The cull opt-out (see CullOptOutEffect) for windows reached through a
     * cloned window group: cloning global.window_group paints every window in
     * it through a clone too.
     */
    _reportClonedWindowGroups() {
        let clonesAWindowGroup = false;
        for (const child of this._clones.keys()) {
            if (child === global.window_group || child === global.top_window_group) {
                clonesAWindowGroup = true;
                break;
            }
        }
        reportClonedWindowActors(this, clonesAWindowGroup ? getWindowActors() : []);
    }
    // Logs which uiGroup children are cloned whenever the set changes, since a
    // wrongly included child only shows up as a ghost inside the glass.
    _reportClonedSet() {
        if (!utilsLogEnabled()) {
            this._clonedNamesLogged = '';
            return;
        }
        let names = '';
        for (const actor of this._clones.keys())
            names += (names ? ', ' : '') + (actor.name || actor.constructor.name || '(unnamed)');
        if (names === this._clonedNamesLogged)
            return;
        this._clonedNamesLogged = names;
        utilsLog(`[Liquid Glass][ui-sampler:${this._label}] cloning [${names}]`);
    }
    destroy() {
        _liveSamplers.delete(this);
        DND.removeDragMonitor(this._dragMonitor);
        this._dragActor = null;
        for (const [actor, id] of this._sourceDestroyIds)
            actor.disconnect(id);
        this._sourceDestroyIds.clear();
        releaseClonedWindowActors(this);
        this._bmsStateAtClone.clear();
        this._uiClonesContainer?.destroy();
        this._clones.clear();
        this._driftingClones.clear();
        this._selfRoot = null;
        this._existingEffectCache.clear();
    }
}
