// The glass effect. Clutter.OffscreenEffect renders the actor (a container of
// wallpaper, window and UI clones) into a texture; this effect then blurs that
// texture (rendering/blur.ts) and composites it through shaders/glass.frag,
// which draws the refraction, tint, rim light and shadow.
//
// Rules for the drawing code:
//
// - Every pass is a paint node, never an immediate Cogl draw. Clutter builds
//   the paint node tree first and executes it afterwards; vfunc_paint_target()
//   runs while it is built, before the offscreen capture has been drawn for
//   this frame, so an immediate draw would sample last frame's capture.
// - Each pass uses its own pipeline copy (RenderPasses.pipeline()): the nodes
//   run after vfunc_paint_target() returns, so a shared pipeline would give
//   every pass the last pass's uniforms.
// - No pass writes a framebuffer that an earlier pass read. Cogl rejects such
//   a cycle between deferred framebuffers and the passes lose their order.
// - Clutter.PaintNode.add_multitexture_rectangle() is not usable from GJS (its
//   coordinate array is introspected as a number and crashes the shell), so
//   all composite layers share one UV range.
import { CropPass } from './rendering/crop.js';
import type { BlurMethod, BlurRenderer } from './rendering/blur.js';
import type { ShaderPipelines } from './rendering/pipelines.js';
import type { GlassGeometry } from './rendering/geometry.js';
import type { UniformState } from './rendering/uniforms.js';
import type { MaterialSettings } from './rendering/material.js';
import type { RenderPasses } from './rendering/passes.js';
import { GlassRenderer, MAX_GLASS_REGIONS, type GlassRegion } from './rendering/glassRenderer.js';

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type { Logger } from './logger.js';
import { computeCaptureLayout } from './actors/geometry.js';
import { registerGlassEffect, unregisterGlassEffect, isLiveGlassEffect, blurCacheDefault, nestedRoiDefault } from './diagnostics/glass.js';
import { registerCaptureOwner, unregisterCaptureOwner, nestedCompositeRoi, clampToRoi } from './rendering/nestedRoi.js';
import { frameSerial, ensureFrameSerialHook, frameSerialIsLive } from './rendering/frameClock.js';

interface PaintCapture {
  actor: Clutter.Actor | null;
  srcW: number;
  srcH: number;
  effectiveW: number;
  effectiveH: number;
  layout: ReturnType<typeof computeCaptureLayout>;
  srcUV: number[];
  resW: number;
  resH: number;
  blurRect: number[] | null;
  blurW: number;
  blurH: number;
  blurSrcUV: number[];
}

interface LiquidEffectParams {
  extensionPath?: string;
  settings?: Gio.Settings;
  logger?: Logger;
  // The owning manager ('dock', 'menu', 'application', ...), shown by
  // global._lgGlass.dump() to tell the glasses apart.
  owner?: string;
  [key: string]: any;
}

export const LiquidEffect = GObject.registerClass({
  GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {
  static readonly MAX_GLASS_REGIONS = MAX_GLASS_REGIONS;

  declare private _extensionPath: string | undefined;
  declare private _owner: string;
  // What this glass belongs to (usually a window title), for the dump.
  declare _diagOwnerLabel: string;
  declare private _logger: Logger | undefined;
  declare private _cropPassEnabled: boolean;

  // Last frame's resolved state, for global._lgGlass.dump().
  declare private _diagLast: any;
  // The blur rect of the last paint (null for the whole actor), and the one
  // the current blur result was produced with.
  declare private _blurRect: number[] | null;
  declare private _blurRectUsed: number[] | null;
  // The composite quad's sub-rect on the last paint, for the dump.
  declare private _compositeRect: number[] | null;
  declare private _shadersLoaded: boolean;

  // How often this effect is painted, and how often it composites instead of
  // falling back to the default paint.
  declare private _diagPaintCount: number;
  declare private _diagCompositedPaintCount: number;
  declare private _diagLastPaintLogAt: number;
  declare private _diagFirstPaintLogged: boolean;

  // The glass-debug-diagnostics setting: per-paint diagnostics, separate
  // from output-logs because they cost time on every paint.
  declare private _diagEnabled: boolean;

  // With diagnostics off the dump is refreshed about once a second.
  declare private _diagLastSnapshotAt: number;

  // The frame serial of the paint that last ran the blur chain; a paint with
  // the same serial is a repeat (a clone painting this glass again) and
  // reuses it. The whole node tree is built before any of it executes, so the
  // real paint always runs before the repeats.
  declare private _blurFrameSerial: number;
  declare private _blurRuns: number;
  declare private _blurSkips: number;
  declare private _blurCacheHits: number;
  // Reuse of the blur across frames while the capture is unchanged.
  declare private _blurCacheEnabled: boolean;
  // Clamping a nested composite to the enclosing glass (rendering/nestedRoi.ts).
  declare private _nestedRoiEnabled: boolean;
  declare private _nestedRoiClamps: number;
  declare private _nestedRoiSkips: number;
  declare private _registeredCaptureTex: any;

  // Incremented whenever Clutter re-renders the offscreen capture rather than
  // reusing it. Keys the blur cache and the nested-glass repair.
  declare private _recaptureSerial: number;
  // See setLiveGeometryHook().
  declare private _liveGeometryHook: (() => void) | null;
  declare private _inLiveGeometry: boolean;

  // The drawing shared with BackdropGlass. The fields below are its parts,
  // kept under their own names for the paint code.
  declare private _renderer: GlassRenderer;

  declare private _material: MaterialSettings;

  declare private _crop: CropPass;

  declare private _geometry: GlassGeometry;

  declare private _uniforms: UniformState;

  declare private _blur: BlurRenderer;

  declare private _pipelines: ShaderPipelines;

  declare private _passes: RenderPasses;

  _init(params: LiquidEffectParams) {
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
    this._nestedRoiEnabled = nestedRoiDefault;
    this._nestedRoiClamps = 0;
    this._nestedRoiSkips = 0;
    this._registeredCaptureTex = null;
    this._recaptureSerial = 0;
    this._liveGeometryHook = null;
    this._inLiveGeometry = false;
    ensureFrameSerialHook();
    this._diagFirstPaintLogged = false;

    this._extensionPath = extensionPath;
    this._logger = logger;
    this._renderer = new GlassRenderer({
      settings,
      logger,
      repaint: () => this.queue_repaint(),
      setDiagnostics: enabled => { this._diagEnabled = enabled; },
    });
    this._passes = this._renderer.passes;
    this._pipelines = this._renderer.pipelines;
    this._blur = this._renderer.blur;
    this._uniforms = this._renderer.uniforms;
    this._geometry = this._renderer.geometry;
    this._material = this._renderer.material;
    this._crop = new CropPass(this._pipelines, this._passes);

    this._loadAllShadersAsync();
  }

  // The glass draws nothing until its shaders have loaded.
  private async _loadAllShadersAsync(): Promise<void> {
    const start = GLib.get_monotonic_time();
    try {
      await this._pipelines.load(this._extensionPath);

      this._shadersLoaded = true;

      const elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
      this._logger?.log(`[Liquid Glass] shaders loaded in ${elapsedMs.toFixed(1)}ms`);

      // The next paint compiles the pipelines.
      this.queue_repaint();
      const actor = this.get_actor();
      actor?.queue_redraw();
      actor?.get_parent()?.queue_redraw();
    } catch (e) {
      this._logger?.error(`[Liquid Glass] Failed to load shaders asynchronously: ${e}`);
    }
  }

  // Only observes ACTOR_DIRTY, the one sign from JS that the offscreen is
  // about to be re-rendered; vfunc_paint_target() runs either way.
  vfunc_paint(node: Clutter.PaintNode, paintContext: Clutter.PaintContext,
    flags: Clutter.EffectPaintFlags): void {
    if (flags & Clutter.EffectPaintFlags.ACTOR_DIRTY) this._recaptureSerial++;
    super.vfunc_paint(node, paintContext, flags);
  }

  // Where OffscreenEffect would draw its texture to the screen, queue the blur
  // passes and the glass composite instead.
  vfunc_paint_target(_paintNode: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
    this._notePaint();
    this._runLiveGeometryHook();
    if (!this._preparePaint()) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }

    // Repeat paints within a frame (clones of this glass) reuse the blur of
    // the first; every paint of a frame sees the same capture.
    if (!frameSerialIsLive()) ensureFrameSerialHook();
    const serialIsLive = frameSerialIsLive();
    const firstPaintThisFrame = !serialIsLive || this._blurFrameSerial !== frameSerial;
    if (serialIsLive) this._blurFrameSerial = frameSerial;

    const srcTex = this.get_texture() as Cogl.Texture2D | null;
    if (!srcTex) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }
    // Lets a glass painted into this capture find us (rendering/nestedRoi.ts).
    if (isLiveGlassEffect(this))
      this._registeredCaptureTex = registerCaptureOwner(this, srcTex, this._registeredCaptureTex);
    const capture = this._captureLayout(srcTex);
    const { blurRect, blurW, blurH, blurSrcUV, srcUV } = capture;
    const { reuseBlur, reuseCrossFrame, blurInputKey } = this._blurReuse(srcTex, capture, firstPaintThisFrame);
    const effectiveTex = this._cropSource(_paintNode, srcTex, capture, reuseBlur);
    // The cropped texture is padding-free (0..1); the raw capture is not.
    const inputUV = effectiveTex === srcTex ? srcUV : [0, 0, 1, 1];
    // With a blur rect, the blur reads that slice of the raw capture.
    const blurInputUV = blurRect ? blurSrcUV : inputUV;

    // The pool is sized from the unpadded size; halving an odd padded size
    // level after level would misalign the layers.
    if (!this._resizeBlur(blurW, blurH, reuseBlur)) {
      super.vfunc_paint_target(_paintNode, paintContext);
      return;
    }
    if (reuseBlur) {
      this._blurSkips++;
      if (reuseCrossFrame) this._blurCacheHits++;
    } else {
      this._blurRectUsed = blurRect;
      if (this._blur.passCount > 0) this._blurRuns++;
      this._blur.render(_paintNode, effectiveTex, blurInputUV, blurInputKey);
    }

    const layer0UV = this._bindCompositeLayers(effectiveTex, inputUV, blurRect);
    const paintOpacity = this._compositePaint(_paintNode, paintContext, capture, layer0UV);
    if (paintOpacity === null) return;
    this._snapshotPaint(srcTex, effectiveTex, capture, paintOpacity);
  }

  // A paint count that stops advancing means Clutter is skipping this actor.
  private _notePaint(): void {
    this._diagPaintCount++;
    if (this._diagEnabled) {
      const now = GLib.get_monotonic_time();
      const actorTitle = this._diagOwnerLabel || this.get_actor()?.get_name() || '?';
      if (!this._diagFirstPaintLogged) {
        this._diagFirstPaintLogged = true;
        this._diagLastPaintLogAt = now;
        this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: FIRST call for "${actorTitle}" ` +
          `(paintCount=${this._diagPaintCount}, shadersLoaded=${this._shadersLoaded})`);
      } else if (now - this._diagLastPaintLogAt > 2000 * 1000) {
        this._logger?.log(`[Liquid Glass][diag] LiquidEffect.vfunc_paint_target: heartbeat for "${actorTitle}", ` +
          `paintCount=${this._diagPaintCount}, compositedCount=${this._diagCompositedPaintCount}`);
        this._diagLastPaintLogAt = now;
      }
    }
  }

  private _runLiveGeometryHook(): void {
    if (!this._liveGeometryHook) return;
    this._inLiveGeometry = true;
    try {
      this._liveGeometryHook();
    } finally {
      this._inLiveGeometry = false;
    }
  }

  private _preparePaint(): boolean {
    if (!this._shadersLoaded)
      return false;

    this._renderer.prepare(this._getCoglContext());
    return true;
  }

  private _captureLayout(srcTex: Cogl.Texture2D): PaintCapture {
    const srcW = srcTex.get_width();
    const srcH = srcTex.get_height();

    // The capture is a few pixels larger than the actor (padding), so the
    // actor's own size is used from here on.
    const actor = this.get_actor();
    let allocW = srcW;
    let allocH = srcH;
    if (actor) {
      const [aw, ah] = actor.get_size();
      if (Number.isFinite(aw) && aw > 0) allocW = Math.round(aw);
      if (Number.isFinite(ah) && ah > 0) allocH = Math.round(ah);
    }

    // computeCaptureLayout() finds the actor's own pixels inside the padded
    // capture and where to draw so the result lands back on the actor.
    const effectiveW = allocW;
    const effectiveH = allocH;

    const layout = computeCaptureLayout(actor, srcW, srcH, effectiveW, effectiveH);
    const srcUV: number[] = layout.uv;

    // Where the actor's (0, 0) lies inside the capture. A background-mode blur
    // inside this subtree samples the framebuffer by stage coordinates and
    // needs it (UILayerSampler._syncBmsReplica()).
    if (actor)
      (actor as any)._lgCaptureOffset = [layout.dest[0], layout.dest[1]];

    // The blur rect is in shader space and the capture mapping in allocation
    // space; the rect is only used while the two agree.
    const resW = this._uniforms.values.get('resolution_x') ?? 0;
    const resH = this._uniforms.values.get('resolution_y') ?? 0;
    const spacesAgree =
      Math.abs(resW - effectiveW) <= 1 && Math.abs(resH - effectiveH) <= 1;
    const blurRect =
      (this._blur.passCount > 0 && spacesAgree) ? this._geometry.blurRect() : null;

    // The blur_rect_* uniforms are set in _bindCompositeLayers(), once it is
    // known whether layer 1 holds the rect or the raw capture.
    const blurW = blurRect ? blurRect[2] : effectiveW;
    const blurH = blurRect ? blurRect[3] : effectiveH;
    const blurSrcUV: number[] = blurRect
      ? [
        srcUV[0] + (blurRect[0] / effectiveW) * (srcUV[2] - srcUV[0]),
        srcUV[1] + (blurRect[1] / effectiveH) * (srcUV[3] - srcUV[1]),
        srcUV[0] + ((blurRect[0] + blurRect[2]) / effectiveW) * (srcUV[2] - srcUV[0]),
        srcUV[1] + ((blurRect[1] + blurRect[3]) / effectiveH) * (srcUV[3] - srcUV[1]),
      ]
      : srcUV;
    return { actor, srcW, srcH, effectiveW, effectiveH, layout, srcUV, resW, resH, blurRect, blurW, blurH, blurSrcUV };
  }

  private _blurReuse(srcTex: Cogl.Texture2D, capture: PaintCapture, firstPaintThisFrame: boolean) {
    const { blurRect, blurW, blurH, blurSrcUV, srcUV } = capture;
    // Reuse needs the same pool and the same rect: geometry can move between
    // two paints of one frame while the quantized size stays the same.
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
    // Across frames the blur is reused while its inputs are unchanged: the
    // capture (_recaptureSerial moves exactly when Clutter re-renders it, and
    // a reallocated capture is a new texture), the sampled slice, and every
    // blur parameter and pipeline (BlurRenderer adds those to the key).
    const keyUV = blurRect ? blurSrcUV : srcUV;
    const blurInputKey = [this._recaptureSerial, srcTex, keyUV[0], keyUV[1], keyUV[2], keyUV[3],
      this._cropPassEnabled];
    const reuseCrossFrame = !reuseSameFrame && poolMatches && this._blurCacheEnabled &&
      this._blur.canReuse(blurInputKey);
    const reuseBlur = reuseSameFrame || reuseCrossFrame;
    return { reuseBlur, reuseCrossFrame, blurInputKey };
  }

  // The crop gives the blur a padding-free input. It only runs for a paint
  // that blurs the whole actor: with a blur rect the blur reads a slice of
  // the raw capture anyway. glass.frag samples only layer 1, and both layers
  // are bound to the same texture, so the composite does not need the crop.
  private _cropSource(_paintNode: Clutter.PaintNode, srcTex: Cogl.Texture2D,
    capture: PaintCapture, reuseBlur: boolean): Cogl.Texture {
    const { blurRect, srcW, srcH, effectiveW, effectiveH, layout } = capture;
    if (this._cropPassEnabled && !blurRect && !reuseBlur &&
      (srcW !== effectiveW || srcH !== effectiveH)) {
      return this._crop.render(
        _paintNode, this._getCoglContext(), srcTex, srcW, srcH, effectiveW, effectiveH, layout.uv
      );
    }
    return srcTex;
  }

  private _resizeBlur(blurW: number, blurH: number, reuseBlur: boolean): boolean {
    if (!reuseBlur && (blurW !== this._blur.width || blurH !== this._blur.height)) {
      this._crop.clear();
      this._blur.resize(this._getCoglContext(), blurW, blurH);
    }

    return this._blur.ready;
  }

  // Binds the blurred background for glass.frag. The draw space is capture
  // texels from the texture's corner (Clutter folds the FBO offset into the
  // transform), so the quad is layout.dest; see computeCaptureLayout().
  private _bindCompositeLayers(effectiveTex: Cogl.Texture, inputUV: number[], blurRect: number[] | null): number[] {
    const { layerUV, activeRect } = this._renderer.bindBackdrop(effectiveTex, inputUV, blurRect);
    this._blurRect = activeRect;
    return layerUV;
  }

  private _compositePaint(_paintNode: Clutter.PaintNode, paintContext: Clutter.PaintContext,
    capture: PaintCapture, layer0UV: number[]): number | null {
    const { actor, resW, resH, effectiveW, effectiveH, layout } = capture;
    const paintOpacity = actor ? actor.get_paint_opacity() : 255;

    // Draw only the part of the quad that can be non-transparent. The uv also
    // gives the shader its pixel position (uv * resolution), so the rect is
    // only used when shader space and capture space coincide exactly.
    const spacesExact = resW === effectiveW && resH === effectiveH;
    let compRect = spacesExact ? this._geometry.compositeRect() : null;
    // A nested paint only has to cover what the enclosing glass can show.
    const roi = spacesExact && this._nestedRoiEnabled
      ? nestedCompositeRoi(this, actor, paintContext, resW, resH) : null;
    if (roi) {
      const clamp = clampToRoi(compRect, roi, resW, resH);
      if (clamp.skip) {
        // Nothing of this glass lands anywhere the enclosing one samples.
        this._nestedRoiSkips++;
        return null;
      }
      if (clamp.clamped) this._nestedRoiClamps++;
      compRect = clamp.rect;
    }
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

    this._renderer.addComposite(_paintNode, drawRect, drawUV, paintOpacity);
    return paintOpacity;
  }

  private _snapshotPaint(srcTex: Cogl.Texture2D, effectiveTex: Cogl.Texture,
    capture: PaintCapture, paintOpacity: number): void {
    const { srcW, srcH, effectiveW, effectiveH, layout } = capture;
    this._diagCompositedPaintCount++;

    // The state behind global._lgGlass.dump(). A sharp body means layer 1 got
    // the raw capture (no blur result). Refreshed every paint with
    // diagnostics on, about once a second otherwise.
    const diagNow = GLib.get_monotonic_time();
    if (this._diagEnabled || diagNow - this._diagLastSnapshotAt > 1000 * 1000) {
      this._diagLastSnapshotAt = diagNow;
      this._diagLast = {
        owner: this._owner,
        actor: this.get_actor()?.get_name() ?? '?',
        src: `${srcW}x${srcH}`,
        alloc: `${effectiveW}x${effectiveH}`,
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
        // The uniforms as last given to the pipeline.
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

  getCaptureClipRect(): number[] | null {
    return this._geometry.captureClip(this._blur.radius);
  }

  /** Shader-space size of this glass, i.e. the resolution_x/y uniforms. */
  getResolution(): [number, number] {
    return this._renderer.getResolution();
  }

  // The capture clip last applied by syncGlassCaptureClip(), for the dump.
  declare _lgCaptureClip: number[] | null;

  // The crop's default; global._lgGlass.cropPass() switches it per instance.
  static readonly USE_CROP_PASS = true;

  private _getCoglContext(): Cogl.Context {
    return Clutter.get_default_backend().get_cogl_context() as Cogl.Context;
  }

  cleanup(): void {
    // The hook's closure holds the manager and its actors.
    this._liveGeometryHook = null;
    unregisterCaptureOwner(this, this._registeredCaptureTex);
    this._registeredCaptureTex = null;
    unregisterGlassEffect(this);

    this._renderer.cleanup();
    this._crop.clear();
  }

  // The setters below back the global._lgGlass switches.
  setCropPassEnabled(enabled: boolean): void {
    this._cropPassEnabled = enabled;
    this.queue_repaint();
  }

  get paintCount(): number {
    return this._diagPaintCount;
  }

  setNestedRoiEnabled(enabled: boolean): void {
    this._nestedRoiEnabled = !!enabled;
    this.queue_repaint();
  }

  setBlurCacheEnabled(enabled: boolean): void {
    this._blurCacheEnabled = !!enabled;
    this.queue_repaint();
  }

  setBlurRectEnabled(enabled: boolean): void { this._renderer.setBlurRectEnabled(enabled); }
  setCompositeRectEnabled(enabled: boolean): void { this._renderer.setCompositeRectEnabled(enabled); }
  setEdgeTapsEnabled(enabled: boolean): void { this._renderer.setEdgeTapsEnabled(enabled); }
  // The early exits are meant to match the full path exactly; any visible
  // difference with them off is a threshold bug.
  setEarlyExitEnabled(enabled: boolean): void { this._renderer.setEarlyExitEnabled(enabled); }
  setDebugView(mode: number): void { this._renderer.setDebugView(mode); }
  setIsDock(isDock: boolean): void { this._renderer.setIsDock(isDock); }
  // The rim, specular and sheen highlights as a group; the drop shadow and
  // the inner AO are not affected. Off for application windows.
  setSurfaceLightEnabled(enabled: boolean): void { this._renderer.setSurfaceLightEnabled(enabled); }
  setPadding(pad: number): void { this._renderer.setPadding(pad); }
  // How far the drop shadow may extend before the background actor's clip.
  setShadowMaxRadius(radius: number): void { this._renderer.setShadowMaxRadius(radius); }
  setBlurMethod(method: BlurMethod): void { this._renderer.setBlurMethod(method); }
  setBlurRadius(radius: number): void { this._renderer.setBlurRadius(radius); }
  reloadShaders(): void { this._renderer.reloadShaders(); }
  setTintColor(r: number, g: number, b: number): void { this._renderer.setTintColor(r, g, b); }
  setTintStrength(strength: number): void { this._renderer.setTintStrength(strength); }
  setCornerRadius(radius: number): void { this._renderer.setCornerRadius(radius); }
  setAnimationScale(scale: number): void { this._renderer.setAnimationScale(scale); }
  // The actor's size in shader space. The texture pool follows the capture
  // size on its own.
  setResolution(width: number, height: number): void { this._renderer.setResolution(width, height); }
  // The glass rect inside the monitor-sized capture (glass.frag's dock_*).
  setGlassGeometry(x: number, y: number, w: number, h: number): void { this._renderer.setGlassGeometry(x, y, w, h); }
  // Draws up to MAX_GLASS_REGIONS rounded rects (setGlassRegions()) instead of
  // the single glass rect; used by Quick Settings' toggle-button mode.
  setMultiRegionMode(enabled: boolean): void { this._renderer.setMultiRegionMode(enabled); }
  /**
   * The regions for multi-region mode, in the space of setGlassGeometry(),
   * truncated to MAX_GLASS_REGIONS. Each carries the element's own base
   * colour and how strongly to apply it (0 when it could not be sampled);
   * the custom tint from setTintColor() is applied on top.
   */
  setGlassRegions(regions: GlassRegion[]): void { this._renderer.setGlassRegions(regions); }
  setBrightness(brightness: number): void { this._renderer.setBrightness(brightness); }
  setContrast(contrast: number): void { this._renderer.setContrast(contrast); }
  setSaturation(saturation: number): void { this._renderer.setSaturation(saturation); }

  // beginBatch()/endBatch() fold the repaints requested by a run of setters
  // into one. Each queue_repaint() walks to the actor and invalidates it, and
  // an application window calls a dozen setters per frame.
  private declare _batchDepth: number;
  private declare _batchDirty: boolean;

  /**
   * Registers a callback run at the start of every vfunc_paint_target().
   *
   * The managers sync geometry from a BEFORE_REDRAW later, which runs before
   * the stage's relayout, so it reads the previous frame's allocation. Things
   * positioned by relayout (the notification banner's eased y, Dash to Dock's
   * slide) then trail their glass by a frame. At paint time the allocation is
   * current, so the hook can correct the uniforms for this paint.
   *
   * The hook may only set uniforms. Actor changes mid-paint would queue
   * another frame; queue_repaint() is ignored while it runs for that reason.
   * Pass null to unregister.
   */
  setLiveGeometryHook(fn: (() => void) | null): void {
    this._liveGeometryHook = fn;
  }

  beginBatch(): void {
    this._batchDepth = (this._batchDepth || 0) + 1;
  }

  endBatch(): void {
    if (!this._batchDepth) return;
    this._batchDepth--;
    if (this._batchDepth === 0 && this._batchDirty) {
      this._batchDirty = false;
      // @ts-ignore: the inherited implementation, bypassing the override below.
      Clutter.Effect.prototype.queue_repaint.call(this);
    }
  }

  // A plain JS override of Clutter.Effect.queue_repaint(), so every call in
  // this class goes through the batching.
  queue_repaint(): void {
    // Repainting from inside this paint would request a new frame every frame.
    if (this._inLiveGeometry) return;
    if (this._batchDepth) {
      this._batchDirty = true;
      return;
    }
    // @ts-ignore
    super.queue_repaint();
  }
});

export type LiquidEffect = InstanceType<typeof LiquidEffect>;
