import Clutter from 'gi://Clutter';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { isCullSiteEnabled } from './options.js';
import { UnpickableActor, UnpickableClone } from '../actors/unpickable.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import { utilsLog, utilsLogEnabled, reportFrameLoopError } from '../diagnostics/logging.js';
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
export const BMS_MODE = { SNAPSHOT: 0, CLONE: 1, SKIP: 2, REPLICATE: 3 };
let _bmsMode = BMS_MODE.REPLICATE;
const _liveSamplers = new Set();
export function setBmsMode(mode) {
    _bmsMode = mode;
    let n = 0;
    for (const sampler of _liveSamplers) {
        try {
            sampler.rebuildBmsClones();
            n++;
        }
        catch { }
    }
    const name = Object.keys(BMS_MODE).find(k => BMS_MODE[k] === mode) ?? `? (${mode})`;
    const msg = `[Liquid Glass] BMS mode = ${name} on ${n} sampler(s)`;
    console.log(msg);
    return msg;
}
export function getBmsMode() {
    return _bmsMode;
}
export class UILayerSampler {
    _selfActor;
    _container;
    _extraExclusions;
    _selfRoot = null;
    _label = '?';
    _bmsStateAtClone = new Map();
    _lastBmsTarget = undefined;
    _ancestorExclusionSources = [];
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
    _existingEffectCache = new Map();
    _useCaptureFixForBms = true;
    _delayedCaptureOwners = new Map();
    _driftingClones = new Set();
    _cullRect = null;
    _bmsScreenRects = [];
    constructor(selfActor, container, extraExclusions = [], cloneContainer = null, label = '?', ancestorExclusions = []) {
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
    setCullRect(rect) {
        this._cullRect = rect;
    }
    getBmsScreenRects() {
        return this._bmsScreenRects;
    }
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
    addExclusion(actor) {
        if (!actor)
            return;
        this._extraExclusions.add(actor);
    }
    _resolveBmsTargetActor() {
        try {
            const ext = Main.extensionManager?.lookup?.('blur-my-shell@aunetx');
            const actor = ext?.stateObj?._panel_blur?.actors_list?.[0]?.bg_manager?.backgroundActor;
            return actor ?? null;
        }
        catch {
            return null;
        }
    }
    _findBmsDescendant(child) {
        const target = this._resolveBmsTargetActor();
        if (!target)
            return null;
        if (child === target)
            return target;
        try {
            if (typeof child.contains === 'function' && child.contains(target)) {
                return target;
            }
        }
        catch { }
        return null;
    }
    setDebugDisableBmsClone(_disabled) { }
    setDebugBmsProbeEnabled(_enabled) { }
    _createBmsReplicaActor(child) {
        try {
            const target = this._findBmsDescendant(child);
            if (!target)
                return null;
            let bmsGroup = target;
            while (bmsGroup && bmsGroup.get_parent() !== child) {
                bmsGroup = bmsGroup.get_parent();
            }
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
        catch (e) {
            reportFrameLoopError('UILayerSampler._createBmsReplicaActor', e);
            return null;
        }
    }
    _captureOffset() {
        try {
            const off = this._container?._lgCaptureOffset;
            if (Array.isArray(off) && Number.isFinite(off[0]) && Number.isFinite(off[1]))
                return [off[0], off[1]];
        }
        catch { }
        return [0, 0];
    }
    _buildReplicaBlurEffect(bmsTarget) {
        try {
            const theirs = (bmsTarget.get_effects() ?? [])
                .find((e) => typeof e?.radius === 'number');
            if (theirs) {
                const Ctor = Object.getPrototypeOf(theirs)?.constructor;
                if (typeof Ctor === 'function') {
                    const cornerRadius = theirs.unscaled_corner_radius ?? theirs.corner_radius ?? 0;
                    const params = {
                        unscaled_radius: theirs.unscaled_radius ?? theirs.radius ?? 0,
                        brightness: theirs.brightness ?? 1.0,
                        corner_radius: cornerRadius,
                    };
                    const ours = new Ctor(params);
                    utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica blur uses ` +
                        `${Ctor.name ?? '?'} (matching BMS's own effect), ` +
                        `unscaled_radius=${params.unscaled_radius} brightness=${params.brightness} ` +
                        `corner_radius=${params.corner_radius}`);
                    return ours;
                }
            }
        }
        catch (e) {
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] could not mirror BMS's ` +
                `blur effect (${e}); falling back to Shell.BlurEffect`);
        }
        return new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: 0,
            brightness: 1.0,
        });
    }
    _syncBmsReplica(source, replica) {
        try {
            const parts = replica.parts;
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
            const blurWidget = replica.blurWidget;
            if (isActorValid(blurWidget) && panelRect) {
                replica.panelRect = panelRect;
                const [offX, offY] = this._captureOffset();
                setPositionIfChanged(blurWidget, panelRect[0] + offX, panelRect[1] + offY);
                setSizeIfChanged(blurWidget, panelRect[2], panelRect[3]);
                setActorVisible(blurWidget, true);
                const src = replica.bmsTarget;
                let ours = blurWidget.get_effects()[0];
                if (ours && isActorValid(src)) {
                    const theirs = (src.get_effects() ?? []).find((e) => typeof e?.radius === 'number');
                    if (theirs) {
                        if (Object.getPrototypeOf(ours)?.constructor !==
                            Object.getPrototypeOf(theirs)?.constructor) {
                            try {
                                blurWidget.remove_effect(ours);
                                blurWidget.add_effect(this._buildReplicaBlurEffect(src));
                                ours = blurWidget.get_effects()[0];
                            }
                            catch { }
                        }
                        if (ours.radius !== theirs.radius)
                            ours.radius = theirs.radius;
                        if (ours.brightness !== theirs.brightness)
                            ours.brightness = theirs.brightness;
                    }
                }
            }
            this._reportReplicaGeometry(source, replica);
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler._syncBmsReplica', e);
        }
    }
    _reportReplicaGeometry(source, replica) {
        if (!utilsLogEnabled())
            return;
        try {
            const blurWidget = replica.blurWidget;
            const [srcAbsX, srcAbsY] = source.get_transformed_position();
            const [bwAbsX, bwAbsY] = blurWidget.get_transformed_position();
            const [bwW, bwH] = blurWidget.get_size();
            const ours = blurWidget.get_effects()[0];
            const theirs = (replica.bmsTarget?.get_effects?.() ?? [])
                .find((e) => typeof e?.radius === 'number');
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
                `cls=${Object.getPrototypeOf(ours ?? {})?.constructor?.name ?? '?'}/` +
                `${Object.getPrototypeOf(theirs ?? {})?.constructor?.name ?? '?'}`;
            if (line === replica.lastGeomLine)
                return;
            replica.lastGeomLine = line;
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica geom ${line}`);
        }
        catch { }
    }
    _createSelfExcludingSnapshotActor(child) {
        try {
            const stage = child.get_stage();
            if (!stage)
                return null;
            if (typeof stage.paint_to_content !== 'function')
                return null;
            if (!this._selfRoot)
                return null;
            const selfRoot = this._selfRoot;
            const rectGetter = () => {
                const [x, y] = child.get_transformed_position();
                const [w, h] = getAllocatedSize(child);
                if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0) {
                    return [0, 0, 0, 0];
                }
                return [x, y, w, h];
            };
            const capture = acquireSelfExcludingSnapshot(child, stage, selfRoot, rectGetter);
            const actor = new UnpickableActor();
            actor.set_name(`${child.name}-selfExcludingSnapshot`);
            const applyContent = () => {
                if (actor._isDisposed)
                    return;
                const content = capture.getContent();
                if (content && actor.content !== content) {
                    actor.content = content;
                }
            };
            let afterPaintId = 0;
            try {
                afterPaintId = stage.connect('after-paint', applyContent);
            }
            catch {
            }
            applyContent();
            this._delayedCaptureOwners.set(actor, { source: child, hideActor: selfRoot });
            actor.connect('destroy', () => {
                actor._isDisposed = true;
                if (afterPaintId) {
                    try {
                        stage.disconnect(afterPaintId);
                    }
                    catch { }
                }
                const owner = this._delayedCaptureOwners.get(actor);
                if (owner) {
                    releaseSelfExcludingSnapshot(owner.source, owner.hideActor);
                    this._delayedCaptureOwners.delete(actor);
                }
            });
            return actor;
        }
        catch {
            return null;
        }
    }
    setUseCaptureFixForBms(enabled) {
        this._useCaptureFixForBms = enabled;
    }
    _findExistingOffscreenEffect(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const effects = actor.get_effects?.() ?? [];
                for (const effect of effects) {
                    if (!(effect instanceof Clutter.OffscreenEffect))
                        continue;
                    const gtypeName = effect.constructor?.$gtype?.name ?? '';
                    if (gtypeName.startsWith('LiquidGlass'))
                        continue;
                    return { actor, effect: effect };
                }
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch { }
        }
        return null;
    }
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
    _containsOtherLiquidGlassRoot(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const name = actor.name;
                if (name === 'liquid-glass-bg-actor' || name === 'liquid-box')
                    return true;
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch { }
        }
        return false;
    }
    _insertCloneInZOrder(child, clone) {
        if (!this._uiClonesContainer)
            return;
        try {
            const uiGroup = Main.layoutManager.uiGroup;
            const siblings = uiGroup.get_children();
            const idx = siblings.indexOf(child);
            if (idx < 0)
                return;
            let insertAboveClone = null;
            for (let i = idx - 1; i >= 0; i--) {
                const prevClone = this._clones.get(siblings[i]);
                if (prevClone && !prevClone._isDisposed) {
                    insertAboveClone = prevClone;
                    break;
                }
            }
            if (insertAboveClone) {
                this._uiClonesContainer.set_child_above_sibling(clone, insertAboveClone);
            }
            else {
                this._uiClonesContainer.set_child_below_sibling(clone, null);
            }
        }
        catch {
        }
    }
    refresh() {
        if (!this._selfRoot)
            this._selfRoot = this._findUiGroupAncestor(this._selfActor);
        const uiGroup = Main.layoutManager.uiGroup;
        const children = uiGroup.get_children();
        const seen = new Set();
        if (this._dragActor && !children.includes(this._dragActor))
            this._dragActor = null;
        const bmsTarget = this._resolveBmsTargetActor();
        if (this._lastBmsTarget !== bmsTarget) {
            const first = this._lastBmsTarget === undefined;
            this._lastBmsTarget = bmsTarget;
            if (!first)
                this._reevaluateBmsClones();
        }
        const dynamicExclusions = new Set();
        for (const src of this._ancestorExclusionSources) {
            try {
                if (!isActorValid(src))
                    continue;
                const root = this._findUiGroupAncestor(src);
                if (root)
                    dynamicExclusions.add(root);
            }
            catch { }
        }
        for (const child of children) {
            try {
                if (child._isDisposed)
                    continue;
                if (!isActorValid(child))
                    continue;
                if (child === this._dragActor)
                    continue;
                if (child === this._selfActor || child === this._selfRoot)
                    continue;
                if (child === Main.layoutManager._backgroundGroup)
                    continue;
                if (child === getSharedBackgroundSource())
                    continue;
                if (this._extraExclusions.has(child))
                    continue;
                if (dynamicExclusions.has(child))
                    continue;
                if (!child.visible || !child.mapped)
                    continue;
                if (!this._clones.has(child) && this._containsOtherLiquidGlassRoot(child)) {
                    utilsLog(`[Liquid Glass][ui-sampler] permanent exclusion of uiGroup child ` +
                        `name="${child.name ?? '(unnamed)'}" ` +
                        `type=${child.constructor?.name} ` +
                        `(nested liquid-glass root found during deep scan)`);
                    this.addExclusion(child);
                    continue;
                }
                seen.add(child);
                if (!this._clones.has(child)) {
                    const bmsTarget = this._findBmsDescendant(child);
                    if (bmsTarget && _bmsMode === BMS_MODE.SKIP) {
                        seen.delete(child);
                        continue;
                    }
                    let sourceClone = null;
                    if (bmsTarget && _bmsMode === BMS_MODE.REPLICATE) {
                        sourceClone = this._createBmsReplicaActor(child);
                        if (!sourceClone) {
                            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS replica ` +
                                `could not be built for name="${child.name ?? '(unnamed)'}"; ` +
                                `leaving it out of the glass rather than cloning BMS's target`);
                            seen.delete(child);
                            continue;
                        }
                    }
                    if (!sourceClone && bmsTarget && _bmsMode === BMS_MODE.SNAPSHOT) {
                        sourceClone = this._createSelfExcludingSnapshotActor(child);
                        if (!sourceClone && this._useCaptureFixForBms) {
                            sourceClone = this._createExistingEffectBlitActor(child);
                        }
                    }
                    if (!sourceClone) {
                        sourceClone = new UnpickableClone({ source: child });
                    }
                    this._bmsStateAtClone.set(child, !!bmsTarget);
                    sourceClone.set_name(`${child.name}-sourceClone`);
                    sourceClone.connect('destroy', () => {
                        this._clones.delete(child);
                    });
                    this._uiClonesContainer?.add_child(sourceClone);
                    this._clones.set(child, sourceClone);
                    if (!this._sourceDestroyIds.has(child)) {
                        this._sourceDestroyIds.set(child, child.connect('destroy', () => {
                            this._sourceDestroyIds.delete(child);
                            this._bmsStateAtClone.delete(child);
                            this._existingEffectCache.delete(child);
                            const clone = this._clones.get(child);
                            this._clones.delete(child);
                            try {
                                clone?.destroy();
                            }
                            catch { }
                        }));
                    }
                    this._insertCloneInZOrder(child, sourceClone);
                }
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler.refresh', e);
            }
        }
        for (const [actor, sourceClone] of this._clones) {
            if (!seen.has(actor)) {
                try {
                    sourceClone.destroy();
                }
                catch { }
                this._clones.delete(actor);
            }
        }
        for (const [actor, id] of this._sourceDestroyIds) {
            if (this._clones.has(actor))
                continue;
            try {
                actor.disconnect(id);
            }
            catch { }
            this._sourceDestroyIds.delete(actor);
            this._bmsStateAtClone.delete(actor);
            this._existingEffectCache.delete(actor);
        }
        this._reportClonedSet();
        this._reportClonedWindowGroups();
    }
    static _stageToLocal(actor, stageX, stageY) {
        try {
            const res = actor.transform_stage_point(stageX, stageY);
            if (Array.isArray(res) && res[0] === true) {
                return [res[1], res[2]];
            }
        }
        catch { }
        try {
            const [cx, cy] = actor.get_transformed_position();
            return [
                stageX - (Number.isNaN(cx) ? 0 : cx),
                stageY - (Number.isNaN(cy) ? 0 : cy),
            ];
        }
        catch {
            return [stageX, stageY];
        }
    }
    syncProperties(source, sourceClone, containerW, containerH, cX, cY) {
        if (!source || !sourceClone)
            return;
        try {
            const [absX, absY] = source.get_transformed_position();
            const [w, h] = getAllocatedSize(source);
            if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
                setActorVisible(sourceClone, false);
                return;
            }
            const scaleX = source.scale_x;
            const scaleY = source.scale_y;
            const scaledW = w * scaleX;
            const scaledH = h * scaleY;
            const cull = this._cullRect;
            const cullable = !!cull && isCullSiteEnabled('ui') &&
                !sourceClone._lgBmsReplica &&
                scaledW > 0 && scaledH > 0 &&
                Number.isFinite(absX) && Number.isFinite(absY);
            if (cullable && !rectsIntersect(absX, absY, scaledW, scaledH, cull)) {
                setCloneCulled(sourceClone, true, () => `src=(${Math.round(absX)},${Math.round(absY)},${Math.round(scaledW)}x${Math.round(scaledH)}) ` +
                    `cullRect=[${cull.map(Math.round)}] label=${this._label}`);
                return;
            }
            setCloneCulled(sourceClone, false, () => `label=${this._label}`);
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
                const pr = replica.panelRect;
                if (pr && pr[2] > 0 && pr[3] > 0)
                    this._bmsScreenRects.push([absX + pr[0], absY + pr[1], pr[2], pr[3]]);
            }
            this._checkCloneDrift(source, sourceClone, absX, absY);
            const localX = absX - cX;
            const localY = absY - cY;
            const isVisible = source.visible && source.mapped;
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
        catch { }
    }
    _checkCloneDrift(source, sourceClone, expectX, expectY) {
        if (!utilsLogEnabled()) {
            if (this._driftingClones.size)
                this._driftingClones.clear();
            return;
        }
        try {
            const [gotX, gotY] = sourceClone.get_transformed_position();
            const drifted = !Number.isFinite(gotX) || !Number.isFinite(gotY) ||
                Math.abs(gotX - expectX) > 1 || Math.abs(gotY - expectY) > 1;
            const known = this._driftingClones.has(sourceClone);
            if (drifted && !known) {
                this._driftingClones.add(sourceClone);
                utilsLog(`[Liquid Glass][ui-sampler] DRIFT clone for ` +
                    `name="${source.name ?? '(unnamed)'}" ` +
                    `type=${source.constructor?.name} ` +
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
        catch { }
    }
    sync(cX, cY, cW, cH) {
        this._bmsScreenRects = [];
        let contW = cW ?? 0;
        let contH = cH ?? 0;
        let contAbsX = cX ?? 0;
        let contAbsY = cY ?? 0;
        if (cX === undefined || cY === undefined) {
            try {
                const [cw, ch] = this._container.get_size();
                if (!Number.isNaN(cw))
                    contW = cw;
                if (!Number.isNaN(ch))
                    contH = ch;
                const [tx, ty] = this._container.get_transformed_position();
                contAbsX = Number.isNaN(tx) ? 0 : tx;
                contAbsY = Number.isNaN(ty) ? 0 : ty;
            }
            catch { }
        }
        try {
            const parent = this._uiClonesContainer?.get_parent();
            if (parent && this._uiClonesContainer) {
                const siblings = parent.get_children();
                if (siblings[siblings.length - 1] !== this._uiClonesContainer) {
                    parent.set_child_above_sibling(this._uiClonesContainer, null);
                }
            }
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler.sync', e);
        }
        if (this._uiClonesContainer) {
            if (this._uiClonesContainer.x !== 0 || this._uiClonesContainer.y !== 0)
                this._uiClonesContainer.set_position(0, 0);
            setTranslationIfChanged(this._uiClonesContainer, -contAbsX, -contAbsY);
        }
        for (const [actor, sourceClone] of this._clones) {
            this.syncProperties(actor, sourceClone, contW, contH, contAbsX, contAbsY);
        }
    }
    _reevaluateBmsClones() {
        this._existingEffectCache.clear();
        for (const [child, wasBms] of [...this._bmsStateAtClone]) {
            try {
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
                    try {
                        clone.destroy();
                    }
                    catch { }
                }
                this._bmsStateAtClone.delete(child);
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler._reevaluateBmsClones', e);
            }
        }
    }
    rebuildBmsClones() {
        this._existingEffectCache.clear();
        for (const [child] of [...this._bmsStateAtClone]) {
            try {
                if (isActorValid(child) && !this._findBmsDescendant(child))
                    continue;
                const clone = this._clones.get(child);
                if (clone) {
                    this._clones.delete(child);
                    try {
                        clone.destroy();
                    }
                    catch { }
                }
                this._bmsStateAtClone.delete(child);
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler.rebuildBmsClones', e);
            }
        }
        this._clonedNamesLogged = '';
    }
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
    _reportClonedSet() {
        if (!utilsLogEnabled()) {
            this._clonedNamesLogged = '';
            return;
        }
        let names = '';
        for (const actor of this._clones.keys()) {
            let n = '(unnamed)';
            try {
                n = actor.name || actor.constructor?.name || '(unnamed)';
            }
            catch { }
            names += (names ? ', ' : '') + n;
        }
        if (names === this._clonedNamesLogged)
            return;
        this._clonedNamesLogged = names;
        utilsLog(`[Liquid Glass][ui-sampler:${this._label}] cloning [${names}]`);
    }
    destroy() {
        _liveSamplers.delete(this);
        DND.removeDragMonitor(this._dragMonitor);
        this._dragActor = null;
        for (const [actor, id] of this._sourceDestroyIds) {
            try {
                actor.disconnect(id);
            }
            catch { }
        }
        this._sourceDestroyIds.clear();
        releaseClonedWindowActors(this);
        this._bmsStateAtClone.clear();
        if (this._uiClonesContainer) {
            try {
                this._uiClonesContainer.destroy();
            }
            catch { }
        }
        this._clones.clear();
        this._driftingClones.clear();
        this._selfRoot = null;
        this._existingEffectCache.clear();
    }
}
