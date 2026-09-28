// src/liquidEffect.ts
//
// ─── Design overview ───────────────────────────────────────────────────────
//
//  Old implementation: subclassed Clutter.ShaderEffect and did refraction,
//          rim lighting, and shadowing all in a single glass.frag shader.
//          Blur relied solely on ShaderEffect's cogl_sampler texture
//          sampling, with no dedicated blur pass.
//
//  New implementation: subclasses Clutter.OffscreenEffect and overrides
//          vfunc_paint_target to run a custom multi-pass FBO pipeline.
//
//  Rendering pipeline (per frame):
//
//    ┌──────────────────────────────────────────────────────┐
//    │  OffscreenEffect automatically captures the actor's   │
//    │  painted content into an internal FBO                │
//    │  (retrievable via get_texture())                      │
//    └────────────────────┬─────────────────────────────────┘
//                         │ srcTex (full monitor resolution)
//                         ▼
//    ┌──────────────── Downsample ──────────────────────────┐
//    │  Pass 0: srcTex    → _blurFbos[0]  (w/2  × h/2)      │
//    │  Pass 1: _tex[0]   → _blurFbos[1]  (w/4  × h/4)      │
//    │  Pass 2: _tex[1]   → _blurFbos[2]  (w/8  × h/8)      │
//    │  Pass 3: _tex[2]   → _blurFbos[3]  (w/16 × h/16)     │
//    │  (shaders/downsample.frag – Dual Kawase, 5-tap)       │
//    └────────────────────┬─────────────────────────────────┘
//                         │
//    ┌──────────────── Upsample ────────────────────────────┐
//    │  Pass 3→2: _tex[3] → _blurFbos[2]                    │
//    │  Pass 2→1: _tex[2] → _blurFbos[1]                    │
//    │  Pass 1→0: _tex[1] → _blurFbos[0]  (w/2 × h/2)       │
//    │  (shaders/upsample.frag – Dual Kawase tent, 8-tap)    │
//    └────────────────────┬─────────────────────────────────┘
//                         │ _blurTextures[0] (blurred, w/2 × h/2)
//                         ▼
//    ┌──────────────── Glass composite ─────────────────────┐
//    │  shaders/glass.frag is parsed at runtime into a Cogl  │
//    │  snippet. cogl_sampler0 = the blurred texture.        │
//    │  Applies refraction / chromatic aberration / rim      │
//    │  lighting / shadow, then draws into screenFb (the     │
//    │  on-screen framebuffer Clutter has prepared).          │
//    └─────────────────────────────────────────────────────┘
//
//  The texture pool is rebuilt whenever the resolution changes.
//  Cogl pipelines are compiled once on the first frame and reused after that.
//
//  The passes themselves live in rendering/: blur.ts (the Dual Kawase and
//  Gaussian chains and their texture pool), crop.ts, passes.ts (the paint-node
//  helpers), pipelines.ts (shader loading and pipeline compilation) and
//  geometry.ts (the blur, composite and capture-clip rects).
//
// ─────────────────────────────────────────────────────────────────────────────
//
//  RENDERING MODEL — READ THIS BEFORE CHANGING ANY DRAWING CODE
//
//  Every pass in this effect is issued as a Clutter PAINT NODE. None of it may
//  be drawn with Cogl's immediate-mode API. This is not a style preference; it
//  is the fix for a long-standing bug, and reverting it silently reintroduces
//  that bug. Four traps are involved, all of them found the hard way.
//
//  ── Trap 1: paint_target runs BEFORE the capture exists ─────────────────────
//
//  Clutter paints in two phases: it BUILDS a ClutterPaintNode tree, then
//  EXECUTES it. ClutterOffscreenEffect adds a LayerNode that renders the actor
//  into the capture texture, and that node runs in the EXECUTE phase — but
//  vfunc_paint_target() is called during the BUILD phase, when the node has
//  only been added to the tree. So at the moment paint_target runs,
//  get_texture() still holds the PREVIOUS frame's content.
//
//  Immediate-mode drawing (draw_textured_rectangle + flush) executes right
//  there, in the build phase, and therefore samples that stale capture. That
//  was the cause of the "background inside the window lags one frame behind
//  while dragging" bug. Clutter's own default paint_target implementation adds
//  nodes rather than drawing, precisely for this reason.
//
//  Drawing straight to the screen framebuffer APPEARED to work, but only by
//  accident: Cogl journals those draws and flushes them later, by which time
//  the capture has landed. It is not a guarantee. Adding a single flush()
//  after such a draw reproduced the identical one-frame lag with no
//  intermediate framebuffer involved at all — that experiment is what finally
//  identified the cause. Do not rely on it.
//
//  ── Trap 2: deferred passes cannot share a Cogl pipeline ────────────────────
//
//  With immediate drawing, "set uniforms, draw, overwrite uniforms for the
//  next pass" worked. Nodes execute after paint_target returns, so a shared
//  pipeline means every pass draws with whatever the LAST pass left behind.
//  Each pass gets its own copy via RenderPasses.pipeline() (rendering/passes.ts).
//
//  ── Trap 3: deferred passes must form an acyclic framebuffer graph ──────────
//
//  With immediate drawing, ping-ponging between framebuffers was harmless.
//  Deferred nodes make Cogl build a real dependency graph, and ping-ponging is
//  a CYCLE in it (e.g. Gaussian: temp reads blur0, then blur0 reads temp).
//  Cogl rejects the dependency with
//    "_cogl_framebuffer_add_dependency: assertion '!find_cycle (...)' failed"
//  and the passes lose their ordering, so the composite samples a
//  never-written blur texture. On screen: a flat tint with no background in it,
//  while rim lighting (which does not read the blur layer) still works.
//
//  Hence the separate _upTextures/_upFbos output targets: no pass ever writes
//  into a framebuffer that an earlier pass read from.
//
//  ── Trap 4: add_multitexture_rectangle() segfaults the shell ────────────────
//
//  Clutter.PaintNode.add_multitexture_rectangle() has a broken introspection
//  annotation on this stack: text_coords is exposed as a plain `number`
//  instead of an array, so passing an array makes the native side read a JS
//  object as a float pointer -> SIGSEGV. The TypeScript error it produces is
//  CORRECT and must not be silenced with a cast.
//
//  (Cogl.Framebuffer.draw_multitextured_rectangle IS annotated correctly, so
//  the two are easy to confuse.)
//
//  Consequence: all composite layers must share one UV range, which is why the
//  capture's padding is removed by a crop pass instead of by per-layer UVs.
//
// ─────────────────────────────────────────────────────────────────────────────
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
import { registerGlassEffect, unregisterGlassEffect, isLiveGlassEffect, blurCacheDefault, nestedRoiDefault } from './diagnostics/glass.js';
import { registerCaptureOwner, unregisterCaptureOwner, nestedCompositeRoi, clampToRoi } from './rendering/nestedRoi.js';
import { frameSerial, ensureFrameSerialHook, frameSerialIsLive } from './rendering/frameClock.js';
export { noteStrandEntry, setGlassRingArmed, isGlassRingArmed, startGlassRingSampler, stopGlassRingSampler, flushGlassRing } from './diagnostics/glass.js';
// ─── Main class ───────────────────────────────────────────────────────────────
export const LiquidEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {
    // Must match glass.frag's `#define MAX_GLASS_REGIONS 16`.
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
    // ─── _init ──────────────────────────────────────────────────────────────────
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
        this._nestedRoiEnabled = nestedRoiDefault;
        this._nestedRoiClamps = 0;
        this._nestedRoiSkips = 0;
        this._registeredCaptureTex = null;
        this._recaptureSerial = 0;
        // See setLiveGeometryHook(). Off unless a manager opts in.
        this._liveGeometryHook = null;
        this._inLiveGeometry = false;
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
    /**
    * Load all shader files asynchronously.
    */
    async _loadAllShadersAsync() {
        // [DIAG] Black-background investigation: each LiquidEffect instance loads
        // its own copy of the 3 shader files independently (no cross-instance
        // cache), so a brand-new window's glass literally cannot render until
        // this completes. Log start/duration to see how long this actually takes
        // relative to the window's own open animation, and to correlate with the
        // applicationManager diag logs (search for "[Liquid Glass][diag]").
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
            // 読み込み完了後に再描画をリクエストし、パイプラインを初期化させる
            this.queue_repaint();
            const actor = this.get_actor();
            actor?.queue_redraw();
            actor?.get_parent()?.queue_redraw();
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Failed to load shaders asynchronously: ${e}`);
        }
    }
    /**
     * Overrides Clutter.Effect's paint hook purely to observe the dirty flag.
     *
     * ACTOR_DIRTY is the only place the "the offscreen is about to be
     * re-rendered" fact is visible from JS: vfunc_paint_target() runs on every
     * paint, cached or not, so it cannot tell the two apart. Everything else is
     * left to the base class.
     */
    vfunc_paint(node, paintContext, flags) {
        if (flags & Clutter.EffectPaintFlags.ACTOR_DIRTY)
            this._recaptureSerial++;
        super.vfunc_paint(node, paintContext, flags);
    }
    /**
     * Overrides the Clutter.OffscreenEffect hook.
     *
     * Called after OffscreenEffect has rendered the actor's content into its
     * internal FBO, at the point where that FBO texture is normally composited
     * onto the screen.
     *
     * The default super.vfunc_paint_target() just draws the FBO straight to
     * the screen; here we instead run the blur pipeline followed by the glass
     * composite pass.
     *
     * @param _paintNode   Clutter's paint node (new signature since GNOME 45+)
     * @param paintContext Current paint context, holding a reference to the on-screen framebuffer
     */
    vfunc_paint_target(_paintNode, paintContext) {
        this._notePaint();
        // ── Live geometry ───────────────────────────────────────────────────────
        // [FIX] The one place in the frame where an animated actor's position is
        // final. See setLiveGeometryHook() for the whole story; in short, the
        // per-frame tick that computes this glass's geometry runs
        // in the stage's "before-update" phase, which is BEFORE Clutter advances
        // this frame's transitions — so anything driven by a transition (a
        // notification banner sliding in, a dock sliding out) is read one frame
        // stale and the glass trails the thing it is supposed to be under. By
        // paint time the transition has been applied, so the hook re-reads it and
        // corrects the uniforms for this very paint.
        this._runLiveGeometryHook();
        if (!this._preparePaint()) {
            // Fall back to OffscreenEffect's default drawing.
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        // ── [PERF] Is this a repeat paint of the same frame? ───────────────────
        // See frameSerial in rendering/frameClock.ts. The frame's FIRST paint of this instance runs the
        // whole chain; the repeats reuse what it produced.
        //
        // Correctness rests on two facts:
        //
        //   1. The input is identical. Every paint of this instance in this frame
        //      renders the same actor subtree into the same capture texture, so
        //      the blur of it cannot differ.
        //   2. The first paint's nodes execute first. Paint nodes run in tree
        //      order, and a Clutter.Clone is always painted after its source (the
        //      dock sits above the windows it clones; a window sits above the
        //      windows below it). So the pool is written before any repeat reads
        //      it — the reuse is same-frame, not last-frame, and a change in what
        //      is behind the glass shows up with zero frames of delay.
        // Retried here rather than only in _init(): an effect can be constructed
        // before global.stage is reachable, and one failed attempt must not
        // disable the optimization for the rest of the session.
        if (!frameSerialIsLive())
            ensureFrameSerialHook();
        const serialIsLive = frameSerialIsLive();
        const firstPaintThisFrame = !serialIsLive || this._blurFrameSerial !== frameSerial;
        // Without a live counter every paint is treated as a first paint, which is
        // exactly the behavior from before this optimization existed. _blurFrameSerial
        // is deliberately left untouched in that case, so it cannot later
        // collide with a real serial once the hook does come up.
        if (serialIsLive)
            this._blurFrameSerial = frameSerial;
        // Grab the FBO texture OffscreenEffect captured from the actor.
        const srcTex = this.get_texture();
        if (!srcTex) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        // [PERF B2] Keep "which glass owns this capture" current, so a glass
        // painted into it later (execution phase) can find us. See rendering/nestedRoi.ts.
        if (isLiveGlassEffect(this))
            this._registeredCaptureTex = registerCaptureOwner(this, srcTex, this._registeredCaptureTex);
        const capture = this._captureLayout(srcTex);
        const { blurRect, blurW, blurH, blurSrcUV, srcUV } = capture;
        const { reuseBlur, reuseCrossFrame, blurInputKey } = this._blurReuse(srcTex, capture, firstPaintThisFrame);
        const effectiveTex = this._cropSource(_paintNode, srcTex, capture, reuseBlur);
        // Whether the crop actually ran decides the range every later pass uses:
        // the cropped texture is padding-free (0..1), the raw capture is not.
        const inputUV = effectiveTex === srcTex ? srcUV : [0, 0, 1, 1];
        // What the blur's first pass reads. Identical to inputUV unless a
        // sub-rect is active, in which case the crop is off and this is the
        // rect's slice of the raw capture.
        const blurInputUV = blurRect ? blurSrcUV : inputUV;
        // ── Rebuild the texture pool when the resolution changes ────────────────
        // Based on the cropped ("true") resolution — using the padded size here
        // would cause rounding error from bit-shifting (w >> 1) an odd value to
        // accumulate across passes, misaligning the sharp and blurred layers.
        if (!this._resizeBlur(blurW, blurH, reuseBlur)) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        // ─────────────────────────────────────────────────────────────────────
        // Blur pass: which blur method runs depends on _blurMethod
        //   0: Separable Gaussian blur
        //   1: Dual Kawase blur (original implementation)
        // Always takes the raw capture as input, sampled over srcUV.
        // ─────────────────────────────────────────────────────────────────────
        if (reuseBlur) {
            // _blurResultTex is left exactly as the paint that computed it set it —
            // earlier this frame, or (B1) in an earlier frame from the same capture.
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
        const layer0UV = this._bindCompositeLayers(effectiveTex, inputUV, blurRect);
        const paintOpacity = this._compositePaint(_paintNode, paintContext, capture, layer0UV);
        if (paintOpacity === null)
            return;
        this._snapshotPaint(srcTex, effectiveTex, capture, paintOpacity);
    }
    _notePaint() {
        // ── [DIAG] Black-background investigation ──────────────────────────────
        // If Clutter culls/skips this actor entirely (e.g. because it decides
        // it's fully occluded by the window content painted above it), this
        // function never runs at all -- which would show up here as a call count
        // that never advances past whatever it was when the window opened, even
        // though _frameTick keeps calling set_size()/queue_redraw() at 60fps.
        //
        // [PERF] The counter itself is one increment and stays unconditional so
        // dump()'s "paints" figure remains exact. Everything below it — a
        // monotonic-time read and a closure that resolves the window title — is
        // gated: the title is only ever used inside a log line that the logger
        // discards unless output-logs is on, yet it was being built on every
        // paint of every glass surface regardless.
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
    }
    _runLiveGeometryHook() {
        if (!this._liveGeometryHook)
            return;
        this._inLiveGeometry = true;
        try {
            this._liveGeometryHook();
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Live geometry hook failed: ${e}`);
        }
        finally {
            this._inLiveGeometry = false;
        }
    }
    _preparePaint() {
        // ── Wait for async shaders ──────────────────────────────────────────────
        if (!this._shadersLoaded) {
            return false;
        }
        // ── Deferred pipeline initialization ─────────────────────────────────────
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
                return false;
            }
        }
        // ── Guard check ───────────────────────────────────────────────────────────
        // The Gaussian H/V pipelines don't exist until a radius has been set
        // (they're built dynamically), so they're intentionally excluded from
        // this required-pipeline check.
        if (!this._pipelines.composite || !this._pipelines.downsample || !this._pipelines.upsample) {
            return false;
        }
        // ── Deferred compilation of the Gaussian shaders ─────────────────────────
        // Whenever setBlurRadius() changes the tap count, compile the new H/V
        // pipelines here, where a Cogl context is guaranteed to be available.
        // Old pipeline references are left for GJS's GC rather than disposed
        // manually.
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
        return true;
    }
    _captureLayout(srcTex) {
        const srcW = srcTex.get_width();
        const srcH = srcTex.get_height();
        // ── Trust the actor's logical size over get_texture()'s reported size ──
        // get_texture() can be a few pixels larger than the actor's logical size
        // due to internal FBO padding (see the crop-pass comment above), so
        // actor.get_size() is used as the source of truth from here on.
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
        // ── Handle the capture's padding ────────────────────────────────────────
        //
        // get_texture() is sized to the actor's PAINT BOX, not its allocation, so
        // it carries a few pixels of padding (measured: 964x563 capture for a
        // 961x560 actor). computeCaptureLayout() derives exactly where the actor's own
        // pixels sit inside that padded texture, and where the composite quad has
        // to be drawn so it lands back on the actor. See that function (actors/geometry.ts)
        // for why the padding is NOT centred and why the draw rect is not
        // (0, 0, w, h).
        // The capture itself, padding and all. Nothing copies it any more; every
        // consumer works on it directly and sampling is confined to the valid
        // sub-rect by srcUV below.
        const effectiveW = allocW;
        const effectiveH = allocH;
        const layout = computeCaptureLayout(actor, srcW, srcH, effectiveW, effectiveH);
        const srcUV = layout.uv;
        // [FIX] Publish where the actor's own pixels start inside the capture.
        //
        // ClutterOffscreenEffect sizes its offscreen to the actor's PAINT BOX,
        // which mutter enlarges by a fixed 3px (2 on the left/top, 1 on the
        // right/bottom — see computeCaptureLayout and memo.md's first addendum).
        // So actor-local (0, 0) is NOT texel (0, 0) of the framebuffer everything
        // inside this effect draws into; it is texel (dest[0], dest[1]).
        //
        // That matters to anything inside our subtree that samples the
        // FRAMEBUFFER by stage coordinates rather than by its own — which is
        // exactly what a background-mode blur does. Without this correction such
        // an effect reads a region shifted up and to the left, whose first rows
        // are the cleared padding, and a blur then smears that transparency down
        // over its whole radius. See UILayerSampler._syncBmsReplica().
        try {
            actor._lgCaptureOffset = [layout.dest[0], layout.dest[1]];
        }
        catch { }
        // ── [PERF] Blurred sub-rect ─────────────────────────────────────────────
        // See GlassGeometry.blurRect() and glass.frag's blur_rect_* uniforms. The rect
        // lives in the shader's coordinate space (resolution_x/y) while the
        // capture mapping below is in allocation space; they are the same space
        // for every current caller, but if they ever drift the rect is dropped
        // rather than trusted.
        const resW = this._uniforms.values.get('resolution_x') ?? 0;
        const resH = this._uniforms.values.get('resolution_y') ?? 0;
        const spacesAgree = Math.abs(resW - effectiveW) <= 1 && Math.abs(resH - effectiveH) <= 1;
        // With no blur running, layer 1 is the raw capture over the FULL actor,
        // so the shader must keep the identity mapping.
        const blurRect = (this._blur.passCount > 0 && spacesAgree) ? this._geometry.blurRect() : null;
        // NOTE: the blur_rect_* uniforms are NOT set here. They describe what
        // layer 1 actually holds, and layer 1 only holds the sub-rect if the blur
        // really ran — several paths below fall back to binding the raw capture.
        // They are set once that is known, in _bindCompositeLayers().
        // The blur chain's own resolution, and the slice of the capture it reads.
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
        return { actor, srcW, srcH, effectiveW, effectiveH, layout, srcUV, resW, resH, blurRect, blurW, blurH, blurSrcUV };
    }
    _blurReuse(srcTex, capture, firstPaintThisFrame) {
        const { blurRect, blurW, blurH, blurSrcUV, srcUV } = capture;
        // [PERF] A repeat paint can reuse the blur only if the pool it was written
        // into is still the right one — a resize between paints destroys it.
        // The rect has to match too, not just the pool size: geometry can change
        // between two paints of the same frame, and the quantized size would
        // often survive a move that shifts the rect's ORIGIN. Reusing a blur
        // taken somewhere else would draw the wrong background.
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
        // [PERF B1] Cross-frame reuse: the capture has not been re-rendered since
        // the pool's result was computed, so the blur of it cannot differ.
        //
        // The same-frame reuse above only covered repeat paints within ONE frame.
        // The first paint of every frame re-ran the whole chain, even when
        // ClutterOffscreenEffect was about to hand it the very same cached FBO —
        // which is what happens on every redraw that touches the glass without
        // touching what is behind it: hovering a menu item or a dock icon, the
        // glass's own window repainting its content (a video, a terminal, a caret
        // blink), another window dragged across it. Measured with [lg-blurstale]:
        // 81-82% of all blur runs in the video and window-drag cases.
        //
        // The key is what the chain's output depends on, and nothing else:
        //   - _recaptureSerial: bumped exactly when Clutter re-renders the capture
        //     (ACTOR_DIRTY, see vfunc_paint) — the SAME condition Clutter itself
        //     uses to decide whether its FBO is stale, so "unchanged serial" means
        //     "byte-identical capture";
        //   - the capture texture itself: a re-allocated offscreen (resize, or the
        //     offscreen == NULL path that re-renders without ACTOR_DIRTY) is a new
        //     texture;
        //   - the sampled sub-rect of the capture, and the pool it lands in;
        //   - every blur parameter and pipeline object (radius, method, downscale,
        //     a recompiled kernel or a reloaded shader all produce a new object or
        //     value).
        // blurRect and the pool size are covered by rectUnchanged / the size check.
        // The slice of the RAW capture the chain reads. (The crop, when it runs,
        // copies exactly srcUV out first, so srcUV identifies its input too.)
        const keyUV = blurRect ? blurSrcUV : srcUV;
        const blurInputKey = [this._recaptureSerial, srcTex, keyUV[0], keyUV[1], keyUV[2], keyUV[3],
            this._cropPassEnabled];
        const reuseCrossFrame = !reuseSameFrame && poolMatches && this._blurCacheEnabled &&
            this._blur.canReuse(blurInputKey);
        const reuseBlur = reuseSameFrame || reuseCrossFrame;
        return { reuseBlur, reuseCrossFrame, blurInputKey };
    }
    // [PERF] When the crop is off. It used to copy the capture into a
    // padding-free texture of its own, at FULL resolution, once per paint per
    // glass surface — 1920x1080 for every full-screen surface.
    //
    // Its only purpose was to make the composite's two layers agree on a
    // texture-coordinate range. Layer 1 (a pool texture) is padding-free and
    // wants 0..1; layer 0 (the raw capture) carries the padding
    // ClutterOffscreenEffect adds and wants the sub-rect. One
    // add_texture_rectangle() carries a single range, and the per-layer
    // variant (add_multitexture_rectangle) is not safely callable from GJS —
    // its annotation types the coordinate array as a bare number, and passing
    // an array through it segfaults the shell (memo.md 6.1). So the crop
    // existed to erase the difference.
    //
    // The difference can be erased for free instead: glass.frag samples ONLY
    // cogl_sampler1, so layer 0's contents are irrelevant, and binding the
    // blur result to BOTH layers makes one range correct for both. The blur
    // chain never needed the crop either — its first pass already samples the
    // capture over srcUV (see _runGaussianBlur / _runDualKawaseBlur).
    //
    // This is not a new code path: it is the one A1's reuse case has been
    // taking for the majority of paints, verified on hardware.
    _cropSource(_paintNode, srcTex, capture, reuseBlur) {
        const { blurRect, srcW, srcH, effectiveW, effectiveH, layout } = capture;
        // [PERF] The crop runs only for a paint that is going to blur — the blur
        // is its only consumer now that both composite layers share one texture.
        // With a sub-rect in play it has nothing left to do: its whole job was to
        // hand the blur a padding-free 0..1 texture, and the blur is reading an
        // arbitrary sub-rect of the capture anyway. Cropping first would mean a
        // full-resolution copy of exactly the pixels we are trying not to touch.
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
        return effectiveTexOut;
    }
    _resizeBlur(blurW, blurH, reuseBlur) {
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
                return false;
            }
        }
        return this._blur.ready;
    }
    // ─────────────────────────────────────────────────────────────────────
    // Final pass: glass composite.
    //   Binds _blurTextures[0] (blurred, w/2 × h/2) as cogl_sampler0 and runs
    //   glass.frag (refraction / rim lighting / shadow) to draw onto the screen.
    //
    //   Clutter has already set up the actor's model-view transform on
    //   screenFb — but with the capture's FBO offset folded in, so this
    //   space is measured in capture TEXELS from the texture's top-left
    //   corner, not in actor-local pixels from the actor's. The rect to draw
    //   is therefore layout.dest, not (0, 0, effectiveW, effectiveH); see
    //   computeCaptureLayout() in utils.ts.
    // ─────────────────────────────────────────────────────────────────────
    _bindCompositeLayers(effectiveTex, inputUV, blurRect) {
        const compPipeline = this._pipelines.composite;
        const haveBlur = this._blur.passCount > 0 && this._blur.result !== null;
        // [PERF] Now that it is settled whether layer 1 is the blurred sub-rect
        // or the whole raw capture, tell the shader which it is. Zero means "the
        // whole actor", i.e. the identity mapping glass.frag used before the
        // sub-rect existed — so every fallback path above lands on the correct
        // sampling automatically.
        const activeRect = (haveBlur && blurRect) ? blurRect : null;
        this._blurRect = activeRect;
        this._uniforms.set('blur_rect_x', activeRect ? activeRect[0] : 0.0);
        this._uniforms.set('blur_rect_y', activeRect ? activeRect[1] : 0.0);
        this._uniforms.set('blur_rect_w', activeRect ? activeRect[2] : 0.0);
        this._uniforms.set('blur_rect_h', activeRect ? activeRect[3] : 0.0);
        // [PERF] Both layers are bound to the SAME texture so that one
        // texture-coordinate range is correct for both — see the note where the
        // crop pass used to be. Whenever a blur exists that is the blur result
        // (0..1); with blur disabled it is the raw capture (srcUV).
        //
        // Sound only because glass.frag samples cogl_sampler1 and never
        // cogl_sampler0. If a future revision starts reading layer 0 as "the
        // sharp capture", it needs its own coordinate range again, and that means
        // either bringing the crop back or finding a working per-layer
        // coordinate call.
        // Layer 0 is never sampled by glass.frag, so it exists only to not
        // contradict layer 1's coordinate range. Bind whichever texture already
        // uses the range layer 1 needs.
        const layer0Tex = haveBlur ? this._blur.result : effectiveTex;
        // [FIX] The texel grid the shader is about to magnify — the blur chain
        // runs at half (or quarter) resolution. glass.frag needs the real texture
        // size to reconstruct it smoothly; see the blur_tex_* uniforms there.
        this._uniforms.set('blur_tex_w', layer0Tex.get_width());
        this._uniforms.set('blur_tex_h', layer0Tex.get_height());
        compPipeline.set_layer_texture(0, layer0Tex);
        configureSamplerLayer(compPipeline, 0);
        const layer0UV = haveBlur ? [0, 0, 1, 1] : inputUV;
        // Layer 1 is the one glass.frag actually samples: the blurred background,
        // or the raw capture when blur is disabled.
        // [FIX round 12] The finished blur no longer always lands in
        // _blurTextures[0]; whichever runner executed records it as
        // BlurRenderer.result.
        compPipeline.set_layer_texture(1, layer0Tex);
        configureSamplerLayer(compPipeline, 1);
        // Manually sync pending uniforms into the composite pipeline.
        // Without this, values like dock_x would stay at 0 and the whole screen
        // would be misdetected as being inside the dock mask.
        this._uniforms.flush();
        return layer0UV;
    }
    _compositePaint(_paintNode, paintContext, capture, layer0UV) {
        const { actor, resW, resH, effectiveW, effectiveH, layout } = capture;
        // [FIX] Feed the actor's real, cascaded paint opacity into the pipeline
        // color used for the final draw. glass.frag's very last line already
        // does `cogl_color_out = vec4(finalRgb, finalAlpha) * cogl_color_in;`
        // — i.e. it was ALWAYS ready to respect the actor's opacity — but
        // nothing on the JS/Cogl side was ever setting this pipeline's color,
        // so Cogl defaulted it to opaque white (255,255,255,255) and that
        // multiply was a permanent no-op. get_paint_opacity() (rather than the
        // actor's own local .opacity) is used because it already returns the
        // value cascaded through the actor's ancestors, so a child of an
        // animating windowActor fades correctly without any extra plumbing.
        //
        // IMPORTANT — this must be (op, op, op, op), NOT (255, 255, 255, op):
        // finalRgb is already PREMULTIPLIED by the shape's own alpha (see
        // `finalRgb = litColor * alpha + shadowColor * shadowContribution`
        // above). Fading premultiplied color by an additional opacity factor
        // requires scaling BOTH the color and the alpha by that same factor —
        // `vec4(finalRgb, finalAlpha) * vec4(1,1,1,op)` only scales alpha and
        // leaves finalRgb at full brightness, which breaks the premultiplied
        // invariant (rgb should never exceed alpha) and — combined with the
        // ADD-based premultiplied blend function above — reads as abnormally
        // bright/washed-out at any opacity below 255, exactly matching the
        // "glass looks way too bright while the window is fading" symptom seen
        // during open/close animations. Scaling all four channels by the same
        // factor keeps it correctly premultiplied at every opacity level.
        const paintOpacity = actor ? actor.get_paint_opacity() : 255;
        const color = new Cogl.Color();
        const paintOpacity_f = paintOpacity / 255;
        color.init_from_4f(paintOpacity_f, paintOpacity_f, paintOpacity_f, paintOpacity_f);
        this._pipelines.composite.set_color(color);
        // [FIX round 10] The push_matrix()/pop_matrix() pair that used to wrap
        // this draw is gone: nothing modified the matrix between them (so it was
        // already a no-op), and now that the draw is queued as a node rather than
        // issued here, bracketing immediate framebuffer state around it would not
        // affect it anyway. The node inherits the actor's model-view transform
        // from the paint context at execution time, which is what positions it.
        // [FIX round 13] The draw rect is layout.dest, NOT (0, 0, w, h).
        // vfunc_paint_target runs inside the transform node ClutterOffscreenEffect
        // wraps around it, whose translation is the capture's own FBO offset —
        // i.e. the coordinate space here has its origin at the capture texture's
        // top-left corner, not at the actor's. Drawing at (0, 0) therefore put
        // the whole glass ~2-3px up and to the left of the actor. See
        // computeCaptureLayout() in actors/geometry.ts for how the correct rect is derived.
        // [PERF] Draw only the part of the quad that can be non-transparent.
        //
        // The rect is in the shader's coordinate space, and the quad is in
        // capture-texel space; the two are related by layout.dest. `uv` doubles
        // as the shader's notion of "where am I in the actor"
        // (`pixel_coord = uv * resolution`), so the sub-range handed to the draw
        // has to be interpolated with `resolution` as the denominator, or
        // pixel_coord would no longer agree with where the quad actually lands.
        // That is only exactly true when the two spaces coincide, so the rect is
        // dropped unless they do — a sub-pixel disagreement here is a visible
        // clip, not a sampling error.
        const spacesExact = resW === effectiveW && resH === effectiveH;
        let compRect = spacesExact ? this._geometry.compositeRect() : null;
        // [PERF B2] A nested paint only has to cover the part of the enclosing
        // capture that the enclosing glass can show. Same exactness requirement as
        // compRect: the quad and pixel_coord must agree, so it is only applied when
        // the two spaces coincide.
        const roi = spacesExact && this._nestedRoiEnabled
            ? nestedCompositeRoi(this, actor, paintContext, resW, resH) : null;
        if (roi) {
            const clamp = clampToRoi(compRect, roi, resW, resH);
            if (clamp.skip) {
                // Nothing of this glass lands anywhere the enclosing one samples.
                this._nestedRoiSkips++;
                return null;
            }
            if (clamp.clamped)
                this._nestedRoiClamps++;
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
        this._passes.composite(_paintNode, this._pipelines.composite, drawRect, drawUV, drawUV);
        return paintOpacity;
    }
    _snapshotPaint(srcTex, effectiveTex, capture, paintOpacity) {
        const { srcW, srcH, effectiveW, effectiveH, layout } = capture;
        this._diagCompositedPaintCount++;
        // [DIAG] "Blur is not visible — the background inside the glass stays
        // sharp — but changing the blur radius does change the look, and
        // refraction works." glass.frag reads ONLY cogl_sampler1 for the body
        // (cogl_sampler0 and blur_strength are declared but unused), so a sharp
        // body means layer 1 is bound to something sharp — which happens exactly
        // when _blurResultTex is null and the fallback below binds the raw
        // capture. This records the state that decides it, per instance, for
        // global._lgGlass.dump().
        //
        // [PERF] Two allocations for the arrays, one for the object, four
        // toFixed() strings, two get_width()/get_height() round trips and a
        // closure — per paint, per glass surface. With diagnostics off this is
        // throttled to roughly once a second instead of being dropped entirely,
        // so dump() still answers (very slightly stale) without anyone having to
        // enable a setting first and reproduce the problem again.
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
                alloc: `${effectiveW}x${effectiveH}`,
                uv: layout.uv.map(v => +v.toFixed(5)),
                dest: layout.dest.map(v => +v.toFixed(2)),
                ...this._blur.describe(),
                paintOpacity,
                paints: this._diagPaintCount,
                // [PERF] How the paints split: blurRuns is the chains actually
                // executed, blurSkips the repeat paints that reused one. With nested
                // glass, blurSkips is where the saving is.
                cropRan: effectiveTex !== srcTex,
                blurRuns: this._blurRuns,
                blurSkips: this._blurSkips,
                blurCacheHits: this._blurCacheHits,
                nestedRoiClamps: this._nestedRoiClamps,
                nestedRoiSkips: this._nestedRoiSkips,
                // The uniforms that decide whether a drop shadow can appear at all.
                // Read straight out of the buffered state, which is by definition
                // what was last handed to the pipeline — so a value that looks wrong
                // here is a JS-side problem, and a value that looks right here with
                // no shadow on screen puts the fault in the shader or in what is
                // drawn over it.
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
    getCaptureClipRect() {
        return this._geometry.captureClip(this._blur.radius);
    }
    /** Shader-space size of this glass, i.e. the resolution_x/y uniforms. */
    getResolution() {
        return [
            this._uniforms.values.get('resolution_x') ?? 0,
            this._uniforms.values.get('resolution_y') ?? 0,
        ];
    }
    // ─── Crop pass ───────────────────────────────────────────────────────────
    //
    // get_texture() is sized to the actor's PAINT BOX, not its allocation, so it
    // carries a few pixels of padding. This pass copies out just the valid
    // region, which lets every later pass work in the plain 0..1 range.
    //
    // [PERF] It was removed outright, and put back behind this flag after the
    // one-frame texture lag from memo.md returned — with A1's blur reuse active,
    // which is the combination the removal had never been tested in. The two
    // interact: without the crop the blur chain samples the effect's own live
    // capture texture, and with the reuse in play that texture is read by passes
    // that no longer sit in a simple chain behind it.
    //
    // Kept switchable rather than simply reverted so the attribution can be
    // settled in one session: global._lgGlass.cropPass(false) turns it off.
    static USE_CROP_PASS = true;
    /**
     * [PERF] Requests a repaint only if something actually changed since the
     * last one. See UniformState.takeDirty() (rendering/uniforms.ts) for why
     * this is safe.
     */
    _queueRepaintIfDirty() {
        if (!this._uniforms.takeDirty())
            return;
        this.queue_repaint();
    }
    // ─── Cogl context lookup ─────────────────────────────────────────────────────
    _getCoglContext() {
        try {
            // Clutter.get_default_backend() is available from GJS.
            // On GNOME 50, get_cogl_context() returns a Cogl.Context.
            const backend = Clutter.get_default_backend();
            return backend.get_cogl_context();
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Failed to obtain the Cogl context: ${e}`);
            return null;
        }
    }
    // ─── Public API (compatible with the previous ShaderEffect-based interface) ──
    cleanup() {
        // Drop the manager's closure before anything else: it captures the
        // manager, its actors and its settings, and a paint can still arrive
        // while the rest of this teardown runs.
        this._liveGeometryHook = null;
        // [PERF B2] The owner table holds this effect and its capture texture.
        unregisterCaptureOwner(this, this._registeredCaptureTex);
        this._registeredCaptureTex = null;
        unregisterGlassEffect(this);
        this._material.clear();
        // Free the texture pool (reference clear only — run_dispose() would double-free).
        this._blur.clear();
        this._crop.clear();
        this._passes.clear();
        // Clear pipeline references (GJS's GC reclaims the VRAM).
        // Never call run_dispose() here — it would double-unref a GJS-managed object.
        this._pipelines.clear();
        this._uniforms.clear();
    }
    /**
     * [PERF/DEBUG] Turns the crop pass on/off at runtime; see USE_CROP_PASS.
     * Reachable as global._lgGlass.cropPass(bool).
     */
    setCropPassEnabled(enabled) {
        this._cropPassEnabled = enabled;
        this.queue_repaint();
    }
    get paintCount() {
        return this._diagPaintCount;
    }
    /** [PERF B2] A/B for clamping nested composites to the enclosing ROI. */
    setNestedRoiEnabled(enabled) {
        this._nestedRoiEnabled = !!enabled;
        this.queue_repaint();
    }
    /** [PERF B1] A/B for the cross-frame blur cache. */
    setBlurCacheEnabled(enabled) {
        this._blurCacheEnabled = !!enabled;
        this.queue_repaint();
    }
    /**
     * [PERF/DEBUG] Turns the blurred sub-rect on/off at runtime; see
     * USE_BLUR_RECT. Off means the blur runs over the whole capture again,
     * which is what it did before that optimization existed.
     */
    setBlurRectEnabled(enabled) {
        this._geometry.blurEnabled = enabled;
        // The pool is keyed on the blurred region's size, so it is stale now.
        this._blur.invalidate();
        this.queue_repaint();
    }
    /**
     * [PERF/DEBUG] Turns the composite sub-rect on/off at runtime; see
     * USE_COMPOSITE_RECT. Off means glass.frag runs over the whole capture
     * again, which is what it did before that optimization existed.
     */
    setCompositeRectEnabled(enabled) {
        this._geometry.compositeEnabled = enabled;
        this.queue_repaint();
    }
    /**
     * [DEBUG] The footprint taps in sampleBackdrop() — see glass.frag's
     * edge_taps_enabled. Off forces the plain four-tap RGSS pattern, which is
     * the direct A/B for whether the edge antialiasing is doing any work.
     * Reachable as global._lgGlass.edgeTaps(bool).
     */
    setEdgeTapsEnabled(enabled) {
        this._uniforms.set('edge_taps_enabled', enabled ? 1.0 : 0.0);
        this._queueRepaintIfDirty();
    }
    /**
     * [PERF/DEBUG] Turns glass.frag's two early exits on/off at runtime.
     *
     * They are meant to be exactly equivalent to the full per-pixel path, so
     * anything that looks different with them on is a bug in the thresholds.
     * Being able to flip this inside a running session — rather than
     * rebuilding and reproducing the state again — is what makes such a
     * report cheap to settle. Reachable as global._lgGlass.earlyExit(bool).
     */
    setEarlyExitEnabled(enabled) {
        this._uniforms.set('early_exit_enabled', enabled ? 1.0 : 0.0);
        this._queueRepaintIfDirty();
    }
    /**
     * [DEBUG] Diagnostic visualisation mode; see glass.frag's debug_view.
     * 0 = normal, 1 = shadow/shape mask view. Reachable as
     * global._lgGlass.debugView(n).
     */
    setDebugView(mode) {
        this._uniforms.set('debug_view', mode);
        this._queueRepaintIfDirty();
    }
    setIsDock(isDock) {
        this._uniforms.set('isDock', isDock ? 1.0 : 0.0);
    }
    /**
     * Enables/disables the rim light + specular + sheen "glass surface
     * glint" terms as a group (see addedLight in glass.frag). The outer
     * drop shadow and inner AO edge-darkening are unaffected either way —
     * they're computed independently of this uniform. Used by
     * applicationManager.ts to give application windows a plainer
     * "shadow + AO only" edge instead of the dock/menu-style glass glint,
     * without touching the shared rim/specular/sheen settings that dock,
     * menu, notification, quick-settings and OSD still use.
     */
    setSurfaceLightEnabled(enabled) {
        this._uniforms.set('surface_light_enabled', enabled ? 1.0 : 0.0);
        this._queueRepaintIfDirty();
    }
    setPadding(pad) {
        this._uniforms.set('padding', pad);
    }
    /**
     * Tells the shader how much room (in px) the drop shadow actually
     * has to render outward, independent of the small optical `padding`
     * uniform. Should be kept in sync with dockManager's CLIP_PADDING (minus
     * a small safety margin) so shadow_radius can use its full prefs.js
     * range (0-100) without being invisibly clamped or hitting a hard edge
     * at the bgActor's own clip boundary.
     */
    setShadowMaxRadius(radius) {
        this._uniforms.set('shadow_max_radius', radius);
    }
    setBlurMethod(method) { this._blur.setBlurMethod(method); }
    setBlurRadius(radius) { this._blur.setBlurRadius(radius); }
    /**
     * [DEBUG] Forces glass.frag (and the downsample/upsample shaders) to be
     * re-read from disk and recompiled into fresh Cogl.Pipelines on the next
     * paint.
     *
     * Why this exists: ShaderPipelines.initialize() only ever runs once per
     * LiquidEffect instance, guarded by `if (!this._pipelines.composite)` in
     * _preparePaint(). The instance itself only gets recreated when
     * dockManager tears down and rebuilds the effect (extension disable/
     * re-enable, or the dock actor being destroyed). So editing glass.frag on
     * disk while the shell keeps running has NO effect on what's on screen
     * until one of those happens — the exact same (possibly still-buggy)
     * compiled shader keeps executing every frame regardless of what the
     * source file now says. This silently made prior shader fixes look like
     * they hadn't worked. Call this after saving shader edits to pick them up
     * immediately instead.
     */
    reloadShaders() {
        this._pipelines.clear();
        // The buffered uniform values are intentionally left intact: they hold
        // every value currently in effect, and attach() re-applies all of them to
        // the freshly-compiled pipeline. BlurRenderer.reload() re-derives the
        // Gaussian kernel so the next paint compiles it again.
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
    // Sets the flat fallback fill composited underneath the glass/shadow
    // result, for areas outside every glass region — see glass.frag's
    // panel_bg_* uniforms for the full rationale. Pass alpha = 0 (the
    // default) to disable it entirely.
    setPanelBackgroundColor(r, g, b, a) {
        this._uniforms.set('panel_bg_r', r);
        this._uniforms.set('panel_bg_g', g);
        this._uniforms.set('panel_bg_b', b);
        this._uniforms.set('panel_bg_a', a);
        this._queueRepaintIfDirty();
    }
    // [FIX] The panel's REAL widget bounds (monitor-relative px, no
    // SHADER_PADDING/CLIP_PADDING/glassExpand) — masks
    // setPanelBackgroundColor()'s fallback fill to this rect in glass.frag so
    // it can't bleed into the sampling-headroom margin around bgActor. See
    // the panel_rect_* uniform comments in glass.frag for the full
    // rationale. Harmless to call regardless of panel_bg_a.
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
    /**
     * Syncs the actor's logical size to the shader's resolution uniform.
     *
     * The texture pool itself is rebuilt automatically inside
     * vfunc_paint_target based on get_texture()'s size, so no extra work is
     * needed here.
     */
    setResolution(width, height) {
        this._uniforms.set('resolution_x', width);
        this._uniforms.set('resolution_y', height);
        this._queueRepaintIfDirty();
    }
    /**
     * Full-screen FBO mode: passes the dock's monitor-relative geometry to the
     * shader (see the dock_x/y/w/h comments in glass.frag for details).
     */
    setGlassGeometry(x, y, w, h) {
        this._uniforms.set('dock_x', x);
        this._uniforms.set('dock_y', y);
        this._uniforms.set('dock_w', w);
        this._uniforms.set('dock_h', h);
        // [PERF] Mirrored for GlassGeometry; reading it back out of the buffered
        // uniforms every paint would work too, but four Map lookups per paint per
        // surface is exactly the kind of cost that section removes.
        this._geometry.rect[0] = x;
        this._geometry.rect[1] = y;
        this._geometry.rect[2] = w;
        this._geometry.rect[3] = h;
        this._queueRepaintIfDirty();
    }
    /**
     * Enables/disables multi-region compositing mode (see glass.frag's
     * multi_region_mode uniform). When enabled, setGlassRegions() draws up to
     * MAX_GLASS_REGIONS independent small rounded-rect "windows" instead of
     * the single dock_x/y/w/h rect. Used by Quick Settings' "Toggles"
     * apply-to mode; every other consumer leaves this at its default (false)
     * and is completely unaffected.
     */
    setMultiRegionMode(enabled) {
        this._uniforms.set('multi_region_mode', enabled ? 1.0 : 0.0);
        this._geometry.multiRegion = enabled;
        this._queueRepaintIfDirty();
    }
    // [PERF] "Window background rendering gets noticeably more expensive
    // (CLUTTER_SHOW_FPS: per-frame paint time roughly triples, ~1.8ms ->
    // ~5-6ms, though FPS itself stays near 60) the moment a window is open,
    // and moving it is the worst case." Single master switch for every
    // drag-time cost-reduction change below — false keeps current behavior
    // byte-for-byte; only flip to true to test the combined effect. Flip
    // this one line, nothing else, to compare.
    static DRAG_PERF_MODE_ENABLED = true;
    /**
     * Registers a callback run at the very top of every vfunc_paint_target(),
     * i.e. during the paint phase of the frame.
     *
     * WHY THIS EXISTS
     *
     * Every manager syncs its glass geometry from a Meta.LaterType.BEFORE_REDRAW
     * later, and reads the tracked actor through get_transformed_position() /
     * get_transformed_extents() — i.e. through its ALLOCATION.
     *
     * NOT the timelines. That was the first theory and it is wrong: a probe
     * easing translation_x and comparing the value seen in a BEFORE_REDRAW
     * later against the value seen at 'after-paint' measured a lag of exactly
     * 0.0px on all 30 sampled frames. Transitions have already been advanced by
     * the time a later runs.
     *
     * The allocation is the part that has not caught up. Both animations that
     * show the lag drive position through a property that queues a RELAYOUT
     * rather than through a paint-time transform:
     *
     *   * the notification banner — messageTray.js eases `_bannerBin.y`, and
     *     clutter_actor_set_y() sets a fixed position and queues a relayout;
     *   * Dash to Dock — ease_property('slide-x') on its DashSlideContainer,
     *     whose 'notify::slide-x' handler calls queue_relayout() and whose
     *     vfunc_allocate() is what actually places the dash.
     *
     * Clutter recomputes allocations in the stage's relayout phase, which comes
     * after the laters have run (META_LATER_RESIZE is documented as "a resize
     * processing phase that is done before ... layout"), so the tick reads the
     * PREVIOUS frame's allocation. At ~160px over ~200ms, one frame of that is
     * a visible ~13px gap between the banner and its glass. An application
     * window does not show it because its glass is a child of the window actor
     * and is moved by the scene graph, not by a poll.
     *
     * The paint phase is past both the timeline advance and the relayout, so
     * what the hook reads there is this frame's real geometry.
     *
     * WHAT A HOOK MAY DO
     *
     * Uniforms only — setGlassGeometry() and friends, which write straight to
     * the composite pipeline and are consumed by the node added moments later
     * in the same paint. It must NOT touch actor state: set_position/set_size/
     * set_clip/opacity all queue relayouts or redraws mid-paint, which is both
     * a frame too late to matter and a way to spin the compositor at 100%.
     * queue_repaint() is suppressed while the hook runs for exactly that reason.
     *
     * Pass null to unregister (cleanup() does).
     */
    setLiveGeometryHook(fn) {
        this._liveGeometryHook = fn;
    }
    beginBatch() {
        if (!LiquidEffect.DRAG_PERF_MODE_ENABLED)
            return;
        this._batchDepth = (this._batchDepth || 0) + 1;
    }
    endBatch() {
        if (!LiquidEffect.DRAG_PERF_MODE_ENABLED)
            return;
        if (!this._batchDepth)
            return; // beginBatch() was never called, or the flag flipped mid-batch
        this._batchDepth--;
        if (this._batchDepth === 0 && this._batchDirty) {
            this._batchDirty = false;
            // @ts-ignore — calling the inherited Clutter.Effect implementation
            // directly, bypassing our own override below.
            Clutter.Effect.prototype.queue_repaint.call(this);
        }
    }
    // Overrides (does not shadow via vfunc_, so this is a plain JS-level
    // method override — GJS resolves method lookups the normal JS-prototype
    // way, so every one of this file's existing `this.queue_repaint()` call
    // sites transparently goes through here without needing to change any
    // of them individually) the inherited Clutter.Effect.queue_repaint().
    queue_repaint() {
        // [FIX] Queueing a repaint from inside the paint we are already running
        // would schedule a fresh frame for every frame — an endless redraw loop
        // at full frame rate. The live-geometry hook has nothing to queue anyway:
        // it writes uniforms straight onto the composite pipeline, and that
        // pipeline is consumed by the node this same paint is about to add. See
        // setLiveGeometryHook().
        if (this._inLiveGeometry)
            return;
        if (LiquidEffect.DRAG_PERF_MODE_ENABLED && this._batchDepth) {
            this._batchDirty = true;
            return;
        }
        // @ts-ignore
        super.queue_repaint();
    }
    /**
     * Supplies the list of glass regions to draw when multi-region mode is
     * enabled. Each region is a small rounded rect (monitor-relative pixel
     * coordinates, same space as setGlassGeometry()/setResolution()) carrying
     * its own BASE color — the color the underlying element actually paints
     * itself — plus how strongly that base color should be applied. Silently
     * truncated to LiquidEffect.MAX_GLASS_REGIONS (must match glass.frag's
     * MAX_GLASS_REGIONS #define) if more are supplied.
     *
     * [FIX-8] `tintR/G/B` used to arrive pre-blended with the user's configured
     * tint color, leaving the shader's single `tint_strength` to scale the
     * element's own color and the user's tint together. They are separate
     * layers now: the base color/strength here, and setTintColor()/
     * setTintStrength() for the custom tint on top. `baseStrength` 0 means
     * "this region has no usable base color", which is how a region whose real
     * color could not be sampled opts out.
     */
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
        // [PERF] Mirrored for GlassGeometry — see setGlassGeometry().
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
