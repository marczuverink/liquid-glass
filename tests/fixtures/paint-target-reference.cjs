module.exports = ({ Clutter, Cogl, GLib, computeCaptureLayout, frameClock, configureSamplerLayer }) => {
  const { frameSerialIsLive, ensureFrameSerialHook } = frameClock;
  return class ReferencePaint extends Clutter.OffscreenEffect {
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
        const firstPaintThisFrame = !serialIsLive || this._blurFrameSerial !== frameClock.frameSerial;
        if (serialIsLive)
            this._blurFrameSerial = frameClock.frameSerial;
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
        this._uniforms.set('blur_tex_w', layer0Tex.get_width());
        this._uniforms.set('blur_tex_h', layer0Tex.get_height());
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
                nestedRoiClamps: this._nestedRoiClamps,
                nestedRoiSkips: this._nestedRoiSkips,
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
                    edgeTaps: this._uniforms.values.get('edge_taps_enabled'),
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
  };
};
