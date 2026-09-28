import { MaterialSettings } from './rendering/material.js';
import { CropPass } from './rendering/crop.js';
import { BlurRenderer } from './rendering/blur.js';
import { ShaderPipelines, configureSamplerLayer } from './rendering/pipelines.js';
import { GlassGeometry } from './rendering/geometry.js';
import { UniformState } from './rendering/uniforms.js';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import { RenderPasses } from './rendering/passes.js';
import { computeCaptureLayout } from './actors/geometry.js';
import { registerGlassEffect, unregisterGlassEffect, blurCacheDefault } from './diagnostics/glass.js';
import { frameSerial, ensureFrameSerialHook, frameSerialIsLive } from './rendering/frameClock.js';
export { noteStrandEntry, setGlassRingArmed, isGlassRingArmed, startGlassRingSampler, stopGlassRingSampler, flushGlassRing } from './diagnostics/glass.js';
export const LiquidEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {
    static MAX_GLASS_REGIONS = 16;
    static get USE_BLUR_RECT() { return GlassGeometry.USE_BLUR_RECT; }
    static set USE_BLUR_RECT(value) { GlassGeometry.USE_BLUR_RECT = value; }
    static get BLUR_RECT_MIN_MARGIN() { return GlassGeometry.BLUR_RECT_MIN_MARGIN; }
    static set BLUR_RECT_MIN_MARGIN(value) { GlassGeometry.BLUR_RECT_MIN_MARGIN = value; }
    static get BLUR_RECT_MIN_SAVING() { return GlassGeometry.BLUR_RECT_MIN_SAVING; }
    static set BLUR_RECT_MIN_SAVING(value) { GlassGeometry.BLUR_RECT_MIN_SAVING = value; }
    static get BLUR_RECT_QUANTUM() { return GlassGeometry.BLUR_RECT_QUANTUM; }
    static set BLUR_RECT_QUANTUM(value) { GlassGeometry.BLUR_RECT_QUANTUM = value; }
    static get CAPTURE_CLIP_EXTRA_MARGIN() { return GlassGeometry.CAPTURE_CLIP_EXTRA_MARGIN; }
    static set CAPTURE_CLIP_EXTRA_MARGIN(value) { GlassGeometry.CAPTURE_CLIP_EXTRA_MARGIN = value; }
    static get CAPTURE_CLIP_MIN_SAVING() { return GlassGeometry.CAPTURE_CLIP_MIN_SAVING; }
    static set CAPTURE_CLIP_MIN_SAVING(value) { GlassGeometry.CAPTURE_CLIP_MIN_SAVING = value; }
    static get USE_COMPOSITE_RECT() { return GlassGeometry.USE_COMPOSITE_RECT; }
    static set USE_COMPOSITE_RECT(value) { GlassGeometry.USE_COMPOSITE_RECT = value; }
    static get COMPOSITE_RECT_MIN_SAVING() { return GlassGeometry.COMPOSITE_RECT_MIN_SAVING; }
    static set COMPOSITE_RECT_MIN_SAVING(value) { GlassGeometry.COMPOSITE_RECT_MIN_SAVING = value; }
    _init(params) {
        const extensionPath = params.extensionPath;
        const settings = params.settings;
        const logger = params.logger;
        const owner = params.owner;
        delete params.extensionPath;
        delete params.settings;
        delete params.logger;
        delete params.owner;
        super._init(params);
        this._owner = owner ?? '?';
        this._diagOwnerLabel = '';
        this._shadersLoaded = false;
        this._diagPaintCount = 0;
        this._diagLast = null;
        registerGlassEffect(this);
        this._diagCompositedPaintCount = 0;
        this._diagLastPaintLogAt = 0;
        this._diagEnabled = false;
        this._diagLastSnapshotAt = 0;
        this._blurFrameSerial = -1;
        this._cropPassEnabled = LiquidEffect.USE_CROP_PASS;
        this._blurRect = null;
        this._blurRectUsed = null;
        this._compositeRect = null;
        this._blurRuns = 0;
        this._blurSkips = 0;
        this._blurCacheHits = 0;
        this._blurCacheEnabled = blurCacheDefault;
        this._recaptureSerial = 0;
        ensureFrameSerialHook();
        this._diagFirstPaintLogged = false;
        this._extensionPath = extensionPath;
        this._logger = logger;
        this._passes = new RenderPasses(logger);
        this._pipelines = new ShaderPipelines(logger);
        this._crop = new CropPass(this._pipelines, this._passes, logger);
        this._blur = new BlurRenderer(this._pipelines, this._passes, () => this.queue_repaint(), logger);
        this._uniforms = new UniformState();
        this._geometry = new GlassGeometry(this._uniforms.values);
        this._material = new MaterialSettings(settings, this._uniforms, this._blur, enabled => { this._diagEnabled = enabled; });
        this._material.initialize();
        this._loadAllShadersAsync();
    }
    async _loadAllShadersAsync() {
        const diagStart = GLib.get_monotonic_time();
        this._logger?.log(`[Liquid Glass][diag] LiquidEffect: starting async shader load at t=${diagStart}us ` +
            `(extensionPath=${this._extensionPath})`);
        try {
            await this._pipelines.load(this._extensionPath);
            this._shadersLoaded = true;
            const elapsedMs = (GLib.get_monotonic_time() - diagStart) / 1000;
            this._logger?.log(`[Liquid Glass][diag] LiquidEffect: async shader load finished in ${elapsedMs.toFixed(1)}ms, ` +
                `calling queue_repaint() now. If the on-screen black-background bug is still visible ` +
                `after this point, the shader load itself is not the (sole) cause -- the issue is in ` +
                `getting this repaint request actually flushed to the display.`);
            this.queue_repaint();
            const actor = this.get_actor();
            actor?.queue_redraw();
            actor?.get_parent()?.queue_redraw();
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Failed to load shaders asynchronously: ${e}`);
        }
    }
    vfunc_paint(node, paintContext, flags) {
        if (flags & Clutter.EffectPaintFlags.ACTOR_DIRTY)
            this._recaptureSerial++;
        super.vfunc_paint(node, paintContext, flags);
    }
    vfunc_paint_target(_paintNode, paintContext) {
        this._diagPaintCount++;
        if (this._diagEnabled) {
            const now = GLib.get_monotonic_time();
            const actorTitle = (() => {
                try {
                    const a = this.get_actor();
                    return a?.get_meta_window?.()?.get_title?.() ?? a?.get_name?.() ?? '?';
                }
                catch {
                    return '?';
                }
            })();
            if (!this._diagFirstPaintLogged) {
                this._diagFirstPaintLogged = true;
                this._diagLastPaintLogAt = now;
                this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: FIRST call for "${actorTitle}" ` +
                    `(paintCount=${this._diagPaintCount}, shadersLoaded=${this._shadersLoaded})`);
            }
            else if (now - this._diagLastPaintLogAt > 2000 * 1000) {
                this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: heartbeat for "${actorTitle}", ` +
                    `paintCount=${this._diagPaintCount}, compositedCount=${this._diagCompositedPaintCount}`);
                this._diagLastPaintLogAt = now;
            }
        }
        if (!this._shadersLoaded) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        if (!this._pipelines.composite) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                this._pipelines.initialize(ctx);
                this._uniforms.attach(this._pipelines.composite);
            }
            catch (e) {
                this._logger?.error(`[Liquid Glass] Pipeline initialization failed: ${e}`);
                super.vfunc_paint_target(_paintNode, paintContext);
                return;
            }
        }
        if (!this._pipelines.composite || !this._pipelines.downsample || !this._pipelines.upsample) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        if (this._blur.needsCompile) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                this._blur.compilePending(ctx);
            }
            catch (e) {
                this._logger?.error(`[Liquid Glass] Failed to build Gaussian pipelines: ${e}`);
            }
        }
        if (!frameSerialIsLive())
            ensureFrameSerialHook();
        const serialIsLive = frameSerialIsLive();
        const firstPaintThisFrame = !serialIsLive || this._blurFrameSerial !== frameSerial;
        if (serialIsLive)
            this._blurFrameSerial = frameSerial;
        const srcTex = this.get_texture();
        if (!srcTex) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        const srcW = srcTex.get_width();
        const srcH = srcTex.get_height();
        const actor = this.get_actor();
        let allocW = srcW;
        let allocH = srcH;
        if (actor) {
            const [aw, ah] = actor.get_size();
            if (Number.isFinite(aw) && aw > 0)
                allocW = Math.round(aw);
            if (Number.isFinite(ah) && ah > 0)
                allocH = Math.round(ah);
        }
        const effectiveW = allocW;
        const effectiveH = allocH;
        const layout = computeCaptureLayout(actor, srcW, srcH, effectiveW, effectiveH);
        const srcUV = layout.uv;
        try {
            actor._lgCaptureOffset = [layout.dest[0], layout.dest[1]];
        }
        catch { }
        const resW = this._uniforms.values.get('resolution_x') ?? 0;
        const resH = this._uniforms.values.get('resolution_y') ?? 0;
        const spacesAgree = Math.abs(resW - effectiveW) <= 1 && Math.abs(resH - effectiveH) <= 1;
        const blurRect = (this._blur.passCount > 0 && spacesAgree) ? this._geometry.blurRect() : null;
        const blurW = blurRect ? blurRect[2] : effectiveW;
        const blurH = blurRect ? blurRect[3] : effectiveH;
        const blurSrcUV = blurRect
            ? [
                srcUV[0] + (blurRect[0] / effectiveW) * (srcUV[2] - srcUV[0]),
                srcUV[1] + (blurRect[1] / effectiveH) * (srcUV[3] - srcUV[1]),
                srcUV[0] + ((blurRect[0] + blurRect[2]) / effectiveW) * (srcUV[2] - srcUV[0]),
                srcUV[1] + ((blurRect[1] + blurRect[3]) / effectiveH) * (srcUV[3] - srcUV[1]),
            ]
            : srcUV;
        const a = this._blurRectUsed;
        const rectUnchanged = (a === null)
            ? (blurRect === null)
            : (blurRect !== null && a[0] === blurRect[0] && a[1] === blurRect[1] &&
                a[2] === blurRect[2] && a[3] === blurRect[3]);
        const poolMatches = this._blur.passCount > 0 &&
            this._blur.result !== null &&
            rectUnchanged &&
            this._blur.width === blurW &&
            this._blur.height === blurH;
        const reuseSameFrame = !firstPaintThisFrame && poolMatches;
        const keyUV = blurRect ? blurSrcUV : srcUV;
        const blurInputKey = [this._recaptureSerial, srcTex, keyUV[0], keyUV[1], keyUV[2], keyUV[3],
            this._cropPassEnabled];
        const reuseCrossFrame = !reuseSameFrame && poolMatches && this._blurCacheEnabled &&
            this._blur.canReuse(blurInputKey);
        const reuseBlur = reuseSameFrame || reuseCrossFrame;
        let effectiveTexOut = srcTex;
        if (this._cropPassEnabled && !blurRect && !reuseBlur &&
            (srcW !== effectiveW || srcH !== effectiveH)) {
            try {
                const cropCtx = this._getCoglContext();
                if (cropCtx) {
                    effectiveTexOut = this._crop.render(_paintNode, cropCtx, srcTex, srcW, srcH, effectiveW, effectiveH, layout.uv);
                }
            }
            catch (e) {
                this._logger?.error(`[Liquid Glass] Crop pass node failed; continuing with the padded texture: ${e}`);
            }
        }
        const effectiveTex = effectiveTexOut;
        const inputUV = (effectiveTex === srcTex) ? srcUV : [0, 0, 1, 1];
        const blurInputUV = blurRect ? blurSrcUV : inputUV;
        if (!reuseBlur && (blurW !== this._blur.width || blurH !== this._blur.height)) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Could not obtain a Cogl context');
                this._crop.clear();
                this._blur.resize(ctx, blurW, blurH);
            }
            catch (e) {
                this._logger?.error(`[Liquid Glass] Failed to rebuild the texture pool: ${e}`);
                super.vfunc_paint_target(_paintNode, paintContext);
                return;
            }
        }
        if (!this._blur.ready) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        if (reuseBlur) {
            this._blurSkips++;
            if (reuseCrossFrame)
                this._blurCacheHits++;
        }
        else {
            this._blurRectUsed = blurRect;
            if (this._blur.passCount > 0)
                this._blurRuns++;
            this._blur.render(_paintNode, effectiveTex, blurInputUV, blurInputKey);
        }
        const compPipeline = this._pipelines.composite;
        const haveBlur = this._blur.passCount > 0 && this._blur.result !== null;
        const activeRect = (haveBlur && blurRect) ? blurRect : null;
        this._blurRect = activeRect;
        this._uniforms.set('blur_rect_x', activeRect ? activeRect[0] : 0.0);
        this._uniforms.set('blur_rect_y', activeRect ? activeRect[1] : 0.0);
        this._uniforms.set('blur_rect_w', activeRect ? activeRect[2] : 0.0);
        this._uniforms.set('blur_rect_h', activeRect ? activeRect[3] : 0.0);
        const layer0Tex = haveBlur ? this._blur.result : effectiveTex;
        compPipeline.set_layer_texture(0, layer0Tex);
        configureSamplerLayer(compPipeline, 0);
        const layer0UV = haveBlur ? [0, 0, 1, 1] : inputUV;
        compPipeline.set_layer_texture(1, layer0Tex);
        configureSamplerLayer(compPipeline, 1);
        this._uniforms.flush();
        const paintOpacity = actor ? actor.get_paint_opacity() : 255;
        const color = new Cogl.Color();
        const paintOpacity_f = paintOpacity / 255;
        color.init_from_4f(paintOpacity_f, paintOpacity_f, paintOpacity_f, paintOpacity_f);
        this._pipelines.composite.set_color(color);
        const compRect = (resW === effectiveW && resH === effectiveH)
            ? this._geometry.compositeRect()
            : null;
        this._compositeRect = compRect;
        let drawRect = layout.dest;
        let drawUV = layer0UV;
        if (compRect) {
            const sx = (layout.dest[2] - layout.dest[0]) / effectiveW;
            const sy = (layout.dest[3] - layout.dest[1]) / effectiveH;
            drawRect = [
                layout.dest[0] + compRect[0] * sx,
                layout.dest[1] + compRect[1] * sy,
                layout.dest[0] + (compRect[0] + compRect[2]) * sx,
                layout.dest[1] + (compRect[1] + compRect[3]) * sy,
            ];
            const [u0, v0, u1, v1] = layer0UV;
            drawUV = [
                u0 + (compRect[0] / resW) * (u1 - u0),
                v0 + (compRect[1] / resH) * (v1 - v0),
                u0 + ((compRect[0] + compRect[2]) / resW) * (u1 - u0),
                v0 + ((compRect[1] + compRect[3]) / resH) * (v1 - v0),
            ];
        }
        this._passes.composite(_paintNode, this._pipelines.composite, drawRect, drawUV, drawUV);
        this._diagCompositedPaintCount++;
        const diagNow = GLib.get_monotonic_time();
        if (this._diagEnabled || diagNow - this._diagLastSnapshotAt > 1000 * 1000) {
            this._diagLastSnapshotAt = diagNow;
            this._diagLast = {
                owner: this._owner,
                actor: (() => { try {
                    return this.get_actor()?.get_name?.() ?? '?';
                }
                catch {
                    return '?';
                } })(),
                src: `${srcW}x${srcH}`,
                alloc: `${allocW}x${allocH}`,
                uv: layout.uv.map(v => +v.toFixed(5)),
                dest: layout.dest.map(v => +v.toFixed(2)),
                ...this._blur.describe(),
                paintOpacity,
                paints: this._diagPaintCount,
                cropRan: effectiveTex !== srcTex,
                blurRuns: this._blurRuns,
                blurSkips: this._blurSkips,
                blurCacheHits: this._blurCacheHits,
                u: {
                    shadowRadius: this._uniforms.values.get('shadow_radius'),
                    shadowIntensity: this._uniforms.values.get('shadow_intensity'),
                    shadowMaxRadius: this._uniforms.values.get('shadow_max_radius'),
                    edgeSmoothing: this._uniforms.values.get('edge_smoothing'),
                    cornerRadius: this._uniforms.values.get('corner_radius'),
                    padding: this._uniforms.values.get('padding'),
                    isDock: this._uniforms.values.get('isDock'),
                    multiRegion: this._uniforms.values.get('multi_region_mode'),
                    earlyExit: this._uniforms.values.get('early_exit_enabled'),
                    dockRect: [
                        this._uniforms.values.get('dock_x'),
                        this._uniforms.values.get('dock_y'),
                        this._uniforms.values.get('dock_w'),
                        this._uniforms.values.get('dock_h'),
                    ],
                    blurRect: this._blurRect ? this._blurRect.slice() : null,
                    captureClip: this._lgCaptureClip ? this._lgCaptureClip.slice() : null,
                    compositeRect: this._compositeRect ? this._compositeRect.slice() : null,
                    blurPool: [this._blur.width, this._blur.height, this._blur.downscale],
                },
            };
        }
    }
    getCaptureClipRect() {
        return this._geometry.captureClip(this._blur.radius);
    }
    getResolution() {
        return [
            this._uniforms.values.get('resolution_x') ?? 0,
            this._uniforms.values.get('resolution_y') ?? 0,
        ];
    }
    static USE_CROP_PASS = true;
    _queueRepaintIfDirty() {
        if (!this._uniforms.takeDirty())
            return;
        this.queue_repaint();
    }
    _getCoglContext() {
        try {
            const backend = Clutter.get_default_backend();
            return backend.get_cogl_context();
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Failed to obtain the Cogl context: ${e}`);
            return null;
        }
    }
    cleanup() {
        unregisterGlassEffect(this);
        this._material.clear();
        this._blur.clear();
        this._crop.clear();
        this._passes.clear();
        this._pipelines.clear();
        this._uniforms.clear();
    }
    setCropPassEnabled(enabled) {
        this._cropPassEnabled = enabled;
        this.queue_repaint();
    }
    get paintCount() {
        return this._diagPaintCount;
    }
    setBlurCacheEnabled(enabled) {
        this._blurCacheEnabled = !!enabled;
        this.queue_repaint();
    }
    setBlurRectEnabled(enabled) {
        this._geometry.blurEnabled = enabled;
        this._blur.invalidate();
        this.queue_repaint();
    }
    setCompositeRectEnabled(enabled) {
        this._geometry.compositeEnabled = enabled;
        this.queue_repaint();
    }
    setEarlyExitEnabled(enabled) {
        this._uniforms.set('early_exit_enabled', enabled ? 1.0 : 0.0);
        this._queueRepaintIfDirty();
    }
    setDebugView(mode) {
        this._uniforms.set('debug_view', mode);
        this._queueRepaintIfDirty();
    }
    setIsDock(isDock) {
        this._uniforms.set('isDock', isDock ? 1.0 : 0.0);
    }
    setSurfaceLightEnabled(enabled) {
        this._uniforms.set('surface_light_enabled', enabled ? 1.0 : 0.0);
        this._queueRepaintIfDirty();
    }
    setPadding(pad) {
        this._uniforms.set('padding', pad);
    }
    setShadowMaxRadius(radius) {
        this._uniforms.set('shadow_max_radius', radius);
    }
    setBlurMethod(method) { this._blur.setBlurMethod(method); }
    setBlurRadius(radius) { this._blur.setBlurRadius(radius); }
    reloadShaders() {
        this._pipelines.clear();
        this._uniforms.attach(null);
        this._blur.reload();
        this.queue_repaint();
    }
    setTintColor(r, g, b) {
        this._uniforms.set('tint_r', r);
        this._uniforms.set('tint_g', g);
        this._uniforms.set('tint_b', b);
        this._queueRepaintIfDirty();
    }
    setPanelBackgroundColor(r, g, b, a) {
        this._uniforms.set('panel_bg_r', r);
        this._uniforms.set('panel_bg_g', g);
        this._uniforms.set('panel_bg_b', b);
        this._uniforms.set('panel_bg_a', a);
        this._queueRepaintIfDirty();
    }
    setPanelRect(x, y, w, h) {
        this._uniforms.set('panel_rect_x', x);
        this._uniforms.set('panel_rect_y', y);
        this._uniforms.set('panel_rect_w', w);
        this._uniforms.set('panel_rect_h', h);
        this._queueRepaintIfDirty();
    }
    setTintStrength(strength) {
        this._uniforms.set('tint_strength', strength);
        this._queueRepaintIfDirty();
    }
    setCornerRadius(radius) {
        this._uniforms.set('corner_radius', radius);
        this._queueRepaintIfDirty();
    }
    setAnimationScale(scale) {
        if (this._material.setAnimationScale(scale))
            this._queueRepaintIfDirty();
    }
    setPointerPosition(x, y, intensity) {
        this._uniforms.set('pointer_x', x);
        this._uniforms.set('pointer_y', y);
        this._uniforms.set('intensity', intensity);
    }
    setResolution(width, height) {
        this._uniforms.set('resolution_x', width);
        this._uniforms.set('resolution_y', height);
        this._queueRepaintIfDirty();
    }
    setGlassGeometry(x, y, w, h) {
        this._uniforms.set('dock_x', x);
        this._uniforms.set('dock_y', y);
        this._uniforms.set('dock_w', w);
        this._uniforms.set('dock_h', h);
        this._geometry.rect[0] = x;
        this._geometry.rect[1] = y;
        this._geometry.rect[2] = w;
        this._geometry.rect[3] = h;
        this._queueRepaintIfDirty();
    }
    setMultiRegionMode(enabled) {
        this._uniforms.set('multi_region_mode', enabled ? 1.0 : 0.0);
        this._geometry.multiRegion = enabled;
        this._queueRepaintIfDirty();
    }
    static DRAG_PERF_MODE_ENABLED = true;
    beginBatch() {
        if (!LiquidEffect.DRAG_PERF_MODE_ENABLED)
            return;
        this._batchDepth = (this._batchDepth || 0) + 1;
    }
    endBatch() {
        if (!LiquidEffect.DRAG_PERF_MODE_ENABLED)
            return;
        if (!this._batchDepth)
            return;
        this._batchDepth--;
        if (this._batchDepth === 0 && this._batchDirty) {
            this._batchDirty = false;
            // @ts-ignore — calling the inherited Clutter.Effect implementation
            Clutter.Effect.prototype.queue_repaint.call(this);
        }
    }
    queue_repaint() {
        if (LiquidEffect.DRAG_PERF_MODE_ENABLED && this._batchDepth) {
            this._batchDirty = true;
            return;
        }
        // @ts-ignore
        super.queue_repaint();
    }
    setGlassRegions(regions) {
        const clamped = regions.slice(0, LiquidEffect.MAX_GLASS_REGIONS);
        const rx = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
        const ry = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
        const rw = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
        const rh = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
        const rTintR = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
        const rTintG = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
        const rTintB = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(1.0);
        const rBaseStrength = new Array(LiquidEffect.MAX_GLASS_REGIONS).fill(0.0);
        clamped.forEach((region, i) => {
            rx[i] = region.x;
            ry[i] = region.y;
            rw[i] = region.w;
            rh[i] = region.h;
            rTintR[i] = region.tintR;
            rTintG[i] = region.tintG;
            rTintB[i] = region.tintB;
            rBaseStrength[i] = Math.max(0.0, Math.min(1.0, region.baseStrength ?? 0.0));
        });
        this._geometry.regions = clamped.map(r => [r.x, r.y, r.w, r.h]);
        this._uniforms.set('region_count', clamped.length);
        this._uniforms.setArray('region_x', rx);
        this._uniforms.setArray('region_y', ry);
        this._uniforms.setArray('region_w', rw);
        this._uniforms.setArray('region_h', rh);
        this._uniforms.setArray('region_tint_r', rTintR);
        this._uniforms.setArray('region_tint_g', rTintG);
        this._uniforms.setArray('region_tint_b', rTintB);
        this._uniforms.setArray('region_base_strength', rBaseStrength);
        this._queueRepaintIfDirty();
    }
    setBrightness(brightness) {
        this._uniforms.set('brightness', brightness);
        this._queueRepaintIfDirty();
    }
    setContrast(contrast) {
        this._uniforms.set('contrast', contrast);
        this._queueRepaintIfDirty();
    }
    setSaturation(saturation) {
        this._uniforms.set('saturation', saturation);
        this._queueRepaintIfDirty();
    }
});
