// A glass that copies what is behind it out of the stage framebuffer while the
// stage is painted, instead of rebuilding the backdrop from clones. Everything
// painted before the glass is in the framebuffer by the time its paint nodes
// run, so a BlitNode copies the sample rect, the blur runs on the copy, and
// glass.frag draws the result over the same pixels.
//
// Only the frame's redraw clip holds current pixels; outside it the
// framebuffer still has the previous frame, this glass included. The copy is
// therefore taken only when the clip contains the whole sample rect and is
// reused otherwise. Relays make the reuse safe: every actor painted before the
// glass gets an invisible clone whose paint volume is the sample area, so a
// redraw anywhere in that actor puts the whole sample area into the same
// frame's clip.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import type Gio from 'gi://Gio';

import type { Logger } from '../logger.js';
import { GlassRenderer, type GlassRegion } from './glassRenderer.js';
import type { BlurMethod } from './blur.js';
import { UnpickableActor } from '../actors/unpickable.js';
import { setPositionIfChanged, setSizeIfChanged } from '../actors/writes.js';
import { registerBackdropGlass, unregisterBackdropGlass } from '../diagnostics/glass.js';

// Room around the sample rect, so the rect can shift a little at paint time
// (the live geometry hook) and still be inside the redrawn area.
const SAMPLE_MARGIN = 32;

// Server-side window shadows are painted outside the window actor's box.
const WINDOW_SHADOW_MARGIN = 80;

interface BackdropGlassParams {
  extensionPath?: string;
  settings?: Gio.Settings;
  logger?: Logger;
  // The owning manager, shown by global._lgGlass.dump().
  owner?: string;
}

// The copy of one stage view's pixels.
interface ViewCopy {
  texture: Cogl.Texture2D;
  framebuffer: Cogl.Offscreen;
  width: number;
  height: number;
  format: Cogl.PixelFormat | null;
  // The stage rect [x0, y0, x1, y1] it holds, on the view's pixel grid; null
  // until the first copy.
  rect: number[] | null;
  serial: number;
}

function coglContext(): Cogl.Context {
  return Clutter.get_default_backend().get_cogl_context() as Cogl.Context;
}

/**
 * An invisible clone of something behind a glass. Its paint volume is its own
 * box (the sample area), not the source's: a redraw anywhere in the source,
 * which Clutter forwards to every clone, then damages exactly the sample area,
 * whatever happens to the source's size in that frame.
 */
const BackdropRelay = GObject.registerClass(
  class BackdropRelay extends Clutter.Clone {
    _init(params: any): void {
      super._init(params);
      Shell.util_set_hidden_from_pick(this, true);
    }

    vfunc_pick(_pickContext: any): void {
    }

    vfunc_get_paint_volume(volume: Clutter.PaintVolume): boolean {
      return volume.set_from_allocation(this);
    }
  }
);

export const BackdropGlass = GObject.registerClass(
  class BackdropGlass extends Clutter.Actor {
    declare _owner: string;
    // What this glass belongs to, for the dump.
    declare _diagOwnerLabel: string;
    declare private _extensionPath: string | undefined;
    declare private _logger: Logger | undefined;
    declare private _renderer: GlassRenderer;
    declare private _shadersLoaded: boolean;
    declare private _diagEnabled: boolean;

    // Parent of the relays, covering the sample rect plus SAMPLE_MARGIN. It
    // draws nothing itself; it is painted (opacity 255) so that its children
    // are visited and Clutter keeps forwarding their sources' redraws.
    declare private _sampleArea: Clutter.Actor;
    declare private _relays: Map<Clutter.Actor, Clutter.Clone>;

    declare private _copies: Map<Clutter.StageView, ViewCopy>;
    // The copy an off-stage paint (screenshot, clone) draws with.
    declare private _lastCopy: ViewCopy | null;
    declare private _copySerial: number;

    declare private _liveGeometryHook: (() => void) | null;
    declare private _inLiveGeometry: boolean;
    declare private _batchDepth: number;
    declare private _batchDirty: boolean;

    // For global._lgGlass.dump().
    declare private _paints: number;
    declare private _copyCount: number;
    declare private _reuseCount: number;
    declare private _offStageCount: number;
    declare private _missCount: number;
    declare private _blurRuns: number;
    declare private _blurSkips: number;
    declare private _relayChanges: number;
    declare private _diagLast: any;
    declare private _diagLastSnapshotAt: number;

    _init(params: BackdropGlassParams = {}) {
      super._init({ name: 'liquid-glass-bg-actor', reactive: false });
      Shell.util_set_hidden_from_pick(this, true);

      this._owner = params.owner ?? '?';
      this._diagOwnerLabel = '';
      this._extensionPath = params.extensionPath;
      this._logger = params.logger;
      this._shadersLoaded = false;
      this._diagEnabled = false;
      this._relays = new Map();
      this._copies = new Map();
      this._lastCopy = null;
      this._copySerial = 0;
      this._liveGeometryHook = null;
      this._inLiveGeometry = false;
      this._batchDepth = 0;
      this._batchDirty = false;
      this._paints = 0;
      this._copyCount = 0;
      this._reuseCount = 0;
      this._offStageCount = 0;
      this._missCount = 0;
      this._blurRuns = 0;
      this._blurSkips = 0;
      this._relayChanges = 0;
      this._diagLast = null;
      this._diagLastSnapshotAt = 0;

      this._renderer = new GlassRenderer({
        settings: params.settings,
        logger: params.logger,
        repaint: () => this._queueRepaint(),
        setDiagnostics: enabled => { this._diagEnabled = enabled; },
      });

      this._sampleArea = new UnpickableActor({ name: 'liquid-glass-sample-area' });
      this.add_child(this._sampleArea);

      registerBackdropGlass(this);
      this._loadShaders();
    }

    vfunc_pick(_pickContext: any): void {
    }

    private async _loadShaders(): Promise<void> {
      const start = GLib.get_monotonic_time();
      try {
        await this._renderer.pipelines.load(this._extensionPath);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] Failed to load shaders: ${e}`);
        return;
      }
      this._shadersLoaded = true;
      const elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
      this._logger?.log(`[Liquid Glass] shaders loaded in ${elapsedMs.toFixed(1)}ms`);
      // Nothing was copied while the shaders were missing.
      this._queueRepaint();
      this._sampleArea.queue_redraw();
    }

    /**
     * Places the sample area and the relays for this frame. Call it every frame
     * from before-update, after this frame's geometry setters: a redraw queued
     * there lands in the same frame's clip.
     */
    syncSources(): void {
      const area = this._sampleAreaRect();
      if (!area) return;
      const [x, y, w, h] = area;
      setPositionIfChanged(this._sampleArea, x, y);
      setSizeIfChanged(this._sampleArea, w, h);

      const stageArea = this._localToStage(x, y, x + w, y + h);
      const wanted = this._collectSources(stageArea);
      let changed = false;
      for (const [source, relay] of this._relays) {
        if (wanted.has(source)) continue;
        relay.destroy();
        this._relays.delete(source);
        changed = true;
      }
      for (const source of wanted) {
        let relay = this._relays.get(source);
        if (!relay) {
          relay = new BackdropRelay({ source, opacity: 0 }) as Clutter.Clone;
          this._sampleArea.add_child(relay);
          this._relays.set(source, relay);
          changed = true;
        }
        setSizeIfChanged(relay, w, h);
      }
      // An actor that appeared or left behind the glass changed the backdrop
      // without necessarily redrawing all of the sample rect.
      if (changed) {
        this._relayChanges++;
        this._sampleArea.queue_redraw();
      }

      const views = this.peek_stage_views();
      for (const view of this._copies.keys()) {
        if (!views.includes(view)) this._copies.delete(view);
      }
    }

    // The sample rect in shader space: the blur rect, or the whole glass.
    private _sampleShaderRect(): number[] | null {
      const [resW, resH] = this._renderer.getResolution();
      if (!(resW >= 1) || !(resH >= 1)) return null;
      return this._renderer.geometry.blurRect() ?? [0, 0, resW, resH];
    }

    // Shader space to actor space. The size requested this frame, which the
    // allocation only catches up with in the relayout.
    private _shaderScale(): [number, number] | null {
      const [resW, resH] = this._renderer.getResolution();
      const [w, h] = this.get_size();
      if (!(resW >= 1) || !(resH >= 1) || !(w >= 1) || !(h >= 1)) return null;
      return [w / resW, h / resH];
    }

    private _sampleAreaRect(): number[] | null {
      const s = this._sampleShaderRect();
      const k = this._shaderScale();
      if (!s || !k) return null;
      const x0 = Math.floor(s[0] * k[0]) - SAMPLE_MARGIN;
      const y0 = Math.floor(s[1] * k[1]) - SAMPLE_MARGIN;
      const x1 = Math.ceil((s[0] + s[2]) * k[0]) + SAMPLE_MARGIN;
      const y1 = Math.ceil((s[1] + s[3]) * k[1]) + SAMPLE_MARGIN;
      return [x0, y0, x1 - x0, y1 - y0];
    }

    // Everything painted before this glass: the earlier siblings of the glass
    // and of each of its ancestors. Never an ancestor itself, whose paint
    // volume would contain the relays. Of the window group, only the windows
    // that reach the sample area.
    private _collectSources(stageArea: number[]): Set<Clutter.Actor> {
      const wanted = new Set<Clutter.Actor>();
      let child: Clutter.Actor = this;
      let parent = child.get_parent();
      while (parent) {
        for (let s = parent.get_first_child(); s && s !== child; s = s.get_next_sibling()) {
          if (!s.mapped || s.opacity === 0) continue;
          if (s === global.window_group) this._collectWindows(s, stageArea, wanted);
          else wanted.add(s);
        }
        child = parent;
        parent = parent.get_parent();
      }
      return wanted;
    }

    private _collectWindows(group: Clutter.Actor, stageArea: number[], wanted: Set<Clutter.Actor>): void {
      for (let a = group.get_first_child(); a; a = a.get_next_sibling()) {
        if (!a.mapped || a.opacity === 0) continue;
        if (a instanceof Meta.WindowActor && !this._windowReaches(a, stageArea)) continue;
        wanted.add(a);
      }
    }

    // The actor's box is last frame's until the relayout, so the window's
    // buffer rect (already moved) is checked as well.
    private _windowReaches(actor: Meta.WindowActor, area: number[]): boolean {
      const m = WINDOW_SHADOW_MARGIN;
      const ext = actor.get_transformed_extents();
      if (ext.origin.x - m < area[2] && ext.origin.x + ext.size.width + m > area[0] &&
        ext.origin.y - m < area[3] && ext.origin.y + ext.size.height + m > area[1])
        return true;
      const r = actor.get_meta_window()?.get_buffer_rect();
      if (!r) return false;
      return r.x - m < area[2] && r.x + r.width + m > area[0] &&
        r.y - m < area[3] && r.y + r.height + m > area[1];
    }

    private _localToStage(x0: number, y0: number, x1: number, y1: number): number[] {
      const a = this.apply_transform_to_point(new Graphene.Point3D({ x: x0, y: y0, z: 0 }));
      const b = this.apply_transform_to_point(new Graphene.Point3D({ x: x1, y: y1, z: 0 }));
      return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
    }

    vfunc_paint_node(root: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
      this._paints++;
      this._runLiveGeometryHook();
      if (!this._shadersLoaded) return;

      const ctx = coglContext();
      this._renderer.prepare(ctx);

      const [resW, resH] = this._renderer.getResolution();
      const box = this.get_allocation_box();
      const allocW = box.get_width();
      const allocH = box.get_height();
      if (!(resW >= 1) || !(resH >= 1) || !(allocW >= 1) || !(allocH >= 1)) return;
      const kx = allocW / resW;
      const ky = allocH / resH;

      const copy = this._takeCopy(root, paintContext, kx, ky);
      if (!copy?.rect) return;
      const blurRect = this._stageToShader(copy.rect, kx, ky);
      if (!blurRect) return;

      this._runBlur(root, ctx, copy, blurRect);
      this._renderer.bindBackdrop(copy.texture, [0, 0, 1, 1], blurRect, true);

      const r = this._renderer.geometry.compositeRect() ?? [0, 0, resW, resH];
      const drawRect = [r[0] * kx, r[1] * ky, (r[0] + r[2]) * kx, (r[1] + r[3]) * ky];
      const drawUV = [r[0] / resW, r[1] / resH, (r[0] + r[2]) / resW, (r[1] + r[3]) / resH];
      const paintOpacity = this.get_paint_opacity();
      this._renderer.addComposite(root, drawRect, drawUV, paintOpacity);
      this._snapshot(copy, blurRect, r, paintOpacity);
    }

    // The view this paint draws to directly, or null for a paint that goes
    // elsewhere (a clone, a screenshot, an ancestor's offscreen), where the
    // framebuffer does not hold what is behind the glass.
    private _liveView(fb: Cogl.Framebuffer): Clutter.StageView | null {
      if (this.is_in_clone_paint()) return null;
      for (const view of this.peek_stage_views()) {
        if (view.get_framebuffer() === fb) return view;
      }
      return null;
    }

    // The copy to draw with: a new one when this frame's clip covers the
    // sample rect, otherwise the last one taken on this view.
    private _takeCopy(root: Clutter.PaintNode, paintContext: Clutter.PaintContext,
      kx: number, ky: number): ViewCopy | null {
      const fb = paintContext.get_framebuffer();
      const view = this._liveView(fb);
      if (!view) {
        this._offStageCount++;
        return this._lastCopy;
      }
      let copy = this._copies.get(view) ?? null;

      const s = this._sampleShaderRect();
      if (!s) return copy;
      const st = this._localToStage(s[0] * kx, s[1] * ky, (s[0] + s[2]) * kx, (s[1] + s[3]) * ky);
      const layout = view.layout;
      const x0 = Math.max(st[0], layout.x);
      const y0 = Math.max(st[1], layout.y);
      const x1 = Math.min(st[2], layout.x + layout.width);
      const y1 = Math.min(st[3], layout.y + layout.height);
      if (!(x1 > x0) || !(y1 > y0)) return copy;

      // Stage to framebuffer pixels, as Clutter lays the stage out on a view.
      const scale = view.get_scale();
      const ox = Math.round(-layout.x * scale);
      const oy = Math.round(-layout.y * scale);
      const fx0 = Math.floor(x0 * scale) + ox;
      const fy0 = Math.floor(y0 * scale) + oy;
      const fx1 = Math.ceil(x1 * scale) + ox;
      const fy1 = Math.ceil(y1 * scale) + oy;
      const rect = [(fx0 - ox) / scale, (fy0 - oy) / scale, (fx1 - ox) / scale, (fy1 - oy) / scale];

      const clip = paintContext.get_redraw_clip();
      const clipX = Math.floor(rect[0]);
      const clipY = Math.floor(rect[1]);
      const inClip = !clip || clip.contains_rectangle(new Mtk.Rectangle({
        x: clipX, y: clipY, width: Math.ceil(rect[2]) - clipX, height: Math.ceil(rect[3]) - clipY,
      })) === Mtk.RegionOverlap.IN;
      if (!inClip) {
        if (copy?.rect) {
          this._reuseCount++;
          return copy;
        }
        // Nothing to draw with yet; the next frame redraws the whole area.
        this._missCount++;
        this._sampleArea.queue_redraw();
        return null;
      }

      // A blit needs both sides fixed point or both floating point, so an
      // offscreen view (rotation, HDR) is copied in its own format.
      const format = fb instanceof Cogl.Offscreen ? fb.get_texture().get_format() : null;
      copy = this._copyTarget(view, copy, fx1 - fx0, fy1 - fy0, format);
      if (!copy) return null;

      // A RootNode makes the copy the blit's target and, with no clear flags,
      // leaves it alone otherwise. Its colour state must be the view's.
      const target = Clutter.RootNode.new(copy.framebuffer, view.color_state, new Cogl.Color(), 0);
      root.add_child(target);
      const blit = Clutter.BlitNode.new(fb);
      blit.add_blit_rectangle(fx0, fy0, 0, 0, fx1 - fx0, fy1 - fy0);
      target.add_child(blit);

      copy.rect = rect;
      copy.serial = ++this._copySerial;
      this._lastCopy = copy;
      this._copyCount++;
      return copy;
    }

    private _copyTarget(view: Clutter.StageView, copy: ViewCopy | null, width: number, height: number,
      format: Cogl.PixelFormat | null): ViewCopy | null {
      if (copy && copy.width === width && copy.height === height && copy.format === format) return copy;
      const ctx = coglContext();
      const texture = format === null
        ? Cogl.Texture2D.new_with_size(ctx, width, height)
        : Cogl.Texture2D.new_with_format(ctx, width, height, format);
      const framebuffer = Cogl.Offscreen.new_with_texture(texture);
      try {
        framebuffer.allocate();
      } catch (e) {
        this._logger?.error(`[Liquid Glass] backdrop copy ${width}x${height} could not be allocated: ${e}`);
        return null;
      }
      const next: ViewCopy = { texture, framebuffer, width, height, format, rect: null, serial: 0 };
      this._copies.set(view, next);
      return next;
    }

    // A stage rect [x0, y0, x1, y1] as [x, y, w, h] in shader space.
    private _stageToShader(rect: number[], kx: number, ky: number): number[] | null {
      const [ok0, ax, ay] = this.transform_stage_point(rect[0], rect[1]);
      const [ok1, bx, by] = this.transform_stage_point(rect[2], rect[3]);
      if (!ok0 || !ok1) return null;
      const x0 = Math.min(ax, bx) / kx;
      const y0 = Math.min(ay, by) / ky;
      const x1 = Math.max(ax, bx) / kx;
      const y1 = Math.max(ay, by) / ky;
      if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) return null;
      return [x0, y0, x1 - x0, y1 - y0];
    }

    // The pool works in shader-space pixels, like LiquidEffect's, so the blur
    // radius means the same at every monitor scale.
    private _runBlur(root: Clutter.PaintNode, ctx: Cogl.Context, copy: ViewCopy, blurRect: number[]): void {
      const blur = this._renderer.blur;
      if (blur.passCount <= 0) return;
      const w = Math.max(1, Math.round(blurRect[2]));
      const h = Math.max(1, Math.round(blurRect[3]));
      const key = [copy.texture, copy.serial];
      if (blur.width === w && blur.height === h && blur.canReuse(key)) {
        this._blurSkips++;
        return;
      }
      if (blur.width !== w || blur.height !== h) blur.resize(ctx, w, h);
      if (!blur.ready) return;
      blur.render(root, copy.texture, [0, 0, 1, 1], key);
      this._blurRuns++;
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

    private _queueRepaint(): void {
      // Repainting from inside this paint would request a new frame every frame.
      if (this._inLiveGeometry) return;
      if (this._batchDepth) {
        this._batchDirty = true;
        return;
      }
      this.queue_redraw();
    }

    private _snapshot(copy: ViewCopy, blurRect: number[], compositeRect: number[], paintOpacity: number): void {
      const now = GLib.get_monotonic_time();
      if (!this._diagEnabled && now - this._diagLastSnapshotAt < 1000 * 1000) return;
      this._diagLastSnapshotAt = now;
      const round = (v: number) => +v.toFixed(2);
      this._diagLast = {
        owner: this._owner,
        mode: 'backdrop',
        copy: `${copy.width}x${copy.height}${copy.format === null ? '' : ` fmt=${copy.format}`}`,
        copyStageRect: copy.rect?.map(round) ?? null,
        blurRect: blurRect.map(round),
        compositeRect: compositeRect.map(round),
        ...this._renderer.blur.describe(),
        paintOpacity,
      };
    }

    /** One row of global._lgGlass.dump(). */
    describe(): object {
      return {
        ...(this._diagLast ?? { owner: this._owner, mode: 'backdrop', state: 'never composited' }),
        label: this._diagOwnerLabel || undefined,
        paints: this._paints,
        copies: this._copyCount,
        reuses: this._reuseCount,
        offStage: this._offStageCount,
        misses: this._missCount,
        blurRuns: this._blurRuns,
        blurSkips: this._blurSkips,
        // Through the relay, whose source is null once the source is gone.
        relays: [...this._relays.values()].map(relay => {
          const a = relay.source;
          if (!a) return '(destroyed)';
          if (a instanceof Meta.WindowActor) return `window:${a.get_meta_window()?.get_title() ?? '?'}`;
          return a.get_name() || (a.constructor as any).$gtype.name;
        }),
        relayChanges: this._relayChanges,
        mapped: this.mapped,
        opacity: this.opacity,
        sampleArea: [this._sampleArea.x, this._sampleArea.y, this._sampleArea.width, this._sampleArea.height],
      };
    }

    get paintCount(): number {
      return this._paints;
    }

    get uniformValues(): ReadonlyMap<string, number> {
      return this._renderer.uniforms.values;
    }

    /** See LiquidEffect.setLiveGeometryHook(). */
    setLiveGeometryHook(fn: (() => void) | null): void {
      this._liveGeometryHook = fn;
    }

    beginBatch(): void {
      this._batchDepth++;
    }

    endBatch(): void {
      if (!this._batchDepth) return;
      this._batchDepth--;
      if (this._batchDepth === 0 && this._batchDirty) {
        this._batchDirty = false;
        this.queue_redraw();
      }
    }

    // The relays go with the glass when the caller destroys it; at shell
    // shutdown they can already be gone by the time this runs.
    cleanup(): void {
      // The hook's closure holds the manager and its actors.
      this._liveGeometryHook = null;
      unregisterBackdropGlass(this);
      this._relays.clear();
      this._copies.clear();
      this._lastCopy = null;
      this._renderer.cleanup();
    }

    getResolution(): [number, number] {
      return this._renderer.getResolution();
    }

    setBlurRectEnabled(enabled: boolean): void { this._renderer.setBlurRectEnabled(enabled); }
    setCompositeRectEnabled(enabled: boolean): void { this._renderer.setCompositeRectEnabled(enabled); }
    setEdgeTapsEnabled(enabled: boolean): void { this._renderer.setEdgeTapsEnabled(enabled); }
    setEarlyExitEnabled(enabled: boolean): void { this._renderer.setEarlyExitEnabled(enabled); }
    setDebugView(mode: number): void { this._renderer.setDebugView(mode); }
    setIsDock(isDock: boolean): void { this._renderer.setIsDock(isDock); }
    setSurfaceLightEnabled(enabled: boolean): void { this._renderer.setSurfaceLightEnabled(enabled); }
    setPadding(pad: number): void { this._renderer.setPadding(pad); }
    setShadowMaxRadius(radius: number): void { this._renderer.setShadowMaxRadius(radius); }
    setBlurMethod(method: BlurMethod): void { this._renderer.setBlurMethod(method); }
    setBlurRadius(radius: number): void { this._renderer.setBlurRadius(radius); }
    reloadShaders(): void { this._renderer.reloadShaders(); }
    setTintColor(r: number, g: number, b: number): void { this._renderer.setTintColor(r, g, b); }
    setTintStrength(strength: number): void { this._renderer.setTintStrength(strength); }
    setCornerRadius(radius: number): void { this._renderer.setCornerRadius(radius); }
    setAnimationScale(scale: number): void { this._renderer.setAnimationScale(scale); }
    // The glass's size in shader space; normally its own size.
    setResolution(width: number, height: number): void { this._renderer.setResolution(width, height); }
    setGlassGeometry(x: number, y: number, w: number, h: number): void { this._renderer.setGlassGeometry(x, y, w, h); }
    setMultiRegionMode(enabled: boolean): void { this._renderer.setMultiRegionMode(enabled); }
    setGlassRegions(regions: GlassRegion[]): void { this._renderer.setGlassRegions(regions); }
    setBrightness(brightness: number): void { this._renderer.setBrightness(brightness); }
    setContrast(contrast: number): void { this._renderer.setContrast(contrast); }
    setSaturation(saturation: number): void { this._renderer.setSaturation(saturation); }
  }
);

export type BackdropGlass = InstanceType<typeof BackdropGlass>;
