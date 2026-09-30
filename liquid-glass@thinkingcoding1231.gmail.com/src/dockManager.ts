import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import { LiquidEffect } from './liquidEffect.js';
import Gio from 'gi://Gio';
import { UnpickableActor } from './actors/unpickable.js';
import { UILayerSampler } from './capture/uiLayerSampler.js';
import { WindowCloneManager } from './capture/windowClones.js';
import { reportFrameLoopError } from './diagnostics/logging.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './animation/frameSync.js';
import { startStageLoop, stopStageLoop } from './animation/frameLoops.js';
import { excludeOtherGlass } from './capture/glassExclusions.js';
import { setClipIfChanged } from './actors/writes.js';
import { syncGlassCaptureClip } from './capture/clip.js';
import { isActorValid } from './actors/lifecycle.js';
import { hexToColorArray } from './animation/colors.js';

import { clipDockBounds, dockEdges, balanceDockBounds, insetDockBounds, visibleDockSize,
  type DockBounds, type DockEdges, type DockMonitor } from './actors/dockGeometry.js';

import { Logger } from './logger.js';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;

export class DashManager {
  private extensionPath: string;
  private targetActor: St.Widget;
  private _settings: Gio.Settings;

  private bgActor: Clutter.Actor | null = null;
  private effect: LiquidEffect | null = null;

  // bgActor (monitor-sized) holds liquidBox, which carries the LiquidEffect
  // and holds the clone container.
  private liquidBox: Clutter.Actor | null = null;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  private _glassExpand: number;

  private _signals: number[];
  private _settingsSignals: number[];
  private _frameSyncId: number;
  private _frameSignalId = 0;
  private _lastTickUs = 0;
  private _isEffectActive: boolean;

  private _originalStyle: string | undefined;
  private _currentMarginStyle: string | undefined;
  private _dockParent: St.Widget | null = null;

  private _cloneContainer: Clutter.Actor | null = null;

  private _lastAbsX: number | undefined;
  private _lastAbsY: number | undefined;
  private _lastTW: number | undefined;
  private _lastTH: number | undefined;
  private _stableDeltaW: number | undefined;
  private _stableDeltaH: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _lastBaseW: number | undefined;
  private _lastBaseH: number | undefined;

  private _marginValue: number = 0;
  // Tracks the hide/show transition so the reason is logged once, not per frame.
  private _lastHidden: boolean | undefined;

  // What the last _syncGeometry() based the glass rect on; see
  // _syncGlassGeometryLive().
  private _liveRef: {
    actor: Clutter.Actor;
    rawX: number; rawY: number;
    rect: [number, number, number, number];
  } | null = null;

  private _uiSampler: UILayerSampler | null = null;
  private _windowCloneManager: WindowCloneManager | null = null;

  private _logger: Logger;

  constructor(extensionPath: string, targetActor: St.Widget, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this.targetActor = targetActor;
    this._settings = settings;
    this._logger = logger;

    // Pixels added around the dock's own rect.
    this._glassExpand = 0;

    this._signals = [];
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._isEffectActive = false;
  }

  setup() {
    if (!this.targetActor || !this._settings) return;

    this._bindSettings();

    if (this._settings.get_boolean('enable-dock-glass')) {
      this._applyEffect();
    }
  }

  _bindSettings() {
    const connectSetting = (key, callback) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting('enable-dock-glass', () => {
      let enabled = this._settings.get_boolean('enable-dock-glass');
      if (enabled && !this._isEffectActive) {
        this._applyEffect();
      } else if (!enabled && this._isEffectActive) {
        this._removeEffect();
      }
    });

    connectSetting('dock-glass-expand', () => {
      if (this.effect && this._isEffectActive) {
        this._glassExpand = this._settings.get_int('dock-glass-expand');
        this.bgActor?.queue_redraw();
      }
    });

    connectSetting('dock-margin-bottom', () => {
      if (this._isEffectActive) this._applyMargin();
      this._marginValue = this._settings.get_int('dock-margin-bottom') || 0;
    });

    connectSetting('dock-tint-color', () => {
      if (this.effect && this._isEffectActive) {
        let colorArray = hexToColorArray(this._settings.get_string('dock-tint-color'));
        this.effect.setTintColor(...colorArray);
      }
    });

    connectSetting('dock-tint-strength', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setTintStrength(this._settings.get_double('dock-tint-strength'));
      }
    });

    connectSetting('dock-blur-radius', () => {
      const radius = this._settings.get_int('dock-blur-radius');
      if (this.effect && this._isEffectActive) this.effect.setBlurRadius(radius);
    });

    connectSetting('dock-corner-radius', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setCornerRadius(this._settings.get_double('dock-corner-radius'));
      }
    });

    connectSetting('dock-brightness', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setBrightness(this._settings.get_double('dock-brightness'));
      }
    });

    connectSetting('dock-contrast', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setContrast(this._settings.get_double('dock-contrast'));
      }
    });

    connectSetting('dock-saturation', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setSaturation(this._settings.get_double('dock-saturation'));
      }
    });
  }

  // Moves the dock away from the screen edge it is closest to by
  // dock-margin-bottom.
  _applyMargin() {
    if (!this.targetActor) return;

    let marginBottom = this._settings.get_int('dock-margin-bottom');

    let [w, h] = this.targetActor.get_size();
    let [x, y] = this.targetActor.get_transformed_position();

    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) monitorIndex = Main.layoutManager.primaryIndex;
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    let distLeft = x - monitor.x;
    let distRight = (monitor.x + monitor.width) - (x + w);
    let distTop = y - monitor.y;
    let distBottom = (monitor.y + monitor.height) - (y + h);
    let minEdge = Math.min(distLeft, distRight, distTop, distBottom);

    let marginStyle = '';
    if (minEdge === distBottom || minEdge === distTop) {
      if (minEdge === distBottom)
        marginStyle = `margin-bottom: ${marginBottom}px;`;
      else
        marginStyle = `margin-top: ${marginBottom}px;`;
    } else {
      if (minEdge === distRight)
        marginStyle = `margin-right: ${marginBottom}px;`;
      else
        marginStyle = `margin-left: ${marginBottom}px;`;
    }

    if (this._originalStyle === undefined) {
      this._originalStyle = this.targetActor.get_style() || '';
    }
    this._currentMarginStyle = marginStyle;
    this.targetActor.set_style(`${this._originalStyle} ${marginStyle}`);
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    this._lastScreenW = this._lastScreenH = undefined;
    this._lastBgW = this._lastBgH = undefined;
    this._lastBgX = this._lastBgY = undefined;
    this._lastBaseW = this._lastBaseH = undefined;
    this._lastAbsX = this._lastAbsY = undefined;
    this._lastTW = this._lastTH = undefined;
    this._stableDeltaW = this._stableDeltaH = undefined;
    this._lastHidden = undefined;

    this.targetActor.add_style_class_name('liquid-glass-transparent');

    this._dockParent = this.targetActor.get_parent() as St.Widget | null;
    if (this._dockParent) {
      this._dockParent.add_style_class_name('liquid-glass-transparent');
    }

    this.bgActor = new UnpickableActor();
    this.bgActor.set_name('liquid-glass-bg-actor');

    this.bgActor.set_size(1.0, 1.0);

    this.liquidBox = new UnpickableActor();
    this.liquidBox.set_name("liquid-box");
    this.liquidBox.set_clip_to_allocation(true);
    this.bgActor.add_child(this.liquidBox);

    // A transparent 1x1 child that works around Blur My Shell turning the
    // glass black.
    let dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name("optimization-breaker");
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0);
    this.liquidBox.add_child(dummyBreaker);

    this._cloneContainer = new UnpickableActor();
    this._cloneContainer.set_name("clone-container");
    this.liquidBox.add_child(this._cloneContainer);

    this._applyMargin();
    this._marginValue = this._settings.get_int('dock-margin-bottom');
    this._glassExpand = this._settings.get_int("dock-glass-expand");

    let dockRoot = this.targetActor;
    while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
      let p = dockRoot.get_parent() as St.Widget | null;
      if (!p) break;
      dockRoot = p;
    }

    // Below the dock, so the glass does not clone itself or the dock.
    if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(this.bgActor, dockRoot);
    } else {
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    let blurRadius = this._settings.get_int('dock-blur-radius');
    let tintColorStr = this._settings.get_string('dock-tint-color');
    let tintStrength = this._settings.get_double('dock-tint-strength');
    let cornerRadius = this._settings.get_double('dock-corner-radius');
    let brightness = this._settings.get_double('dock-brightness');
    let contrast = this._settings.get_double('dock-contrast');
    let saturation = this._settings.get_double('dock-saturation');

    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings, logger: this._logger, owner: 'dock' } as any);
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setTintColor(...hexToColorArray(tintColorStr));
    this.effect.setTintStrength(tintStrength);
    this.effect.setCornerRadius(cornerRadius);
    this.effect.setBrightness(brightness);
    this.effect.setContrast(contrast);
    this.effect.setSaturation(saturation);
    this.effect.setBlurRadius(blurRadius);

    this.effect.setIsDock(true);
    this.liquidBox.add_effect(this.effect);

    // Dash to Dock slides by relayout, so the frame tick sees last frame's
    // position; the paint-time hook corrects it.
    this.effect.setLiveGeometryHook(() => this._syncGlassGeometryLive());

    this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer, 'lg-dock');
    // The dock is excluded both directly and through targetActor's uiGroup
    // ancestor, which stays correct after Dash to Dock rebuilds its container.
    this._uiSampler = new UILayerSampler(
      this.bgActor, this.liquidBox,
      [dockRoot, global.windowGroup, global.window_group],
      this._cloneContainer,
      'dock',
      [this.targetActor]);

    this.bgActor.show();

    let buildClones = () => {
      if (!this.bgActor) return;
      excludeOtherGlass(this._uiSampler, this.bgActor);
      this._windowCloneManager?.rebuildClones();
      this._uiSampler?.rebindSelf();
      this._uiSampler?.refresh();
    };

    // Follows the stage's own frames (startStageLoop()), so it costs nothing
    // while nothing changes. Errors are reported rate-limited instead of
    // logged every frame; SAME_FRAME_WINDOW_US keeps two stage views from
    // stepping it twice in one frame.
    let frameTick = () => {
      if (!this._isEffectActive || !this.bgActor || !this.targetActor.mapped) return;
      if (isFrameSyncFrozen()) return;

      const nowUs = GLib.get_monotonic_time();
      if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US) return;
      this._lastTickUs = nowUs;
      try {
        // Checked before this frame's sync dirties anything.
        ensureGlassAllocated(this.bgActor);
        this._syncGeometry();
      } catch (e) {
        reportFrameLoopError('DockManager', e);
      }
    };

    let startFrameSync = () => {
      if (this._frameSignalId !== 0) return;
      buildClones();
      startStageLoop(this._frameSignalSlot, this._frameSlot, frameTick);
    };

    let mapSignalId = this.targetActor.connect('notify::mapped', () => {
      if (this.targetActor.mapped) {
        startFrameSync();
      } else {
        this._stopFrameSync();
      }
    });
    this._signals.push(mapSignalId);

    if (this.targetActor.mapped) {
      startFrameSync();
    }
  }

  // Runs at paint time (see LiquidEffect.setLiveGeometryHook()), when the
  // dock's allocation is current. _syncGeometry() keeps per-frame state and
  // must run once per frame, so only the glass rect's position is corrected
  // here, by how far the dock moved since the tick.
  _syncGlassGeometryLive() {
    const ref = this._liveRef;
    if (!ref || !this.effect) return;
    if (!ref.actor?.mapped) return;

    const [nx, ny] = ref.actor.get_transformed_position();
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;

    this.effect.setGlassGeometry(
      ref.rect[0] + (nx - ref.rawX),
      ref.rect[1] + (ny - ref.rawY),
      ref.rect[2], ref.rect[3]);
  }

  _syncGeometry() {
    if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) return;
    let bounds = this._readDockBounds();
    if (!bounds) return;
    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) {
      monitorIndex = Main.layoutManager.primaryIndex;
    }
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    const edges = dockEdges(bounds, monitor);
    bounds = this._stabilizeDockBounds(bounds, edges);
    const refActor = this._findReferenceActor(this.targetActor);
    if (refActor) bounds = balanceDockBounds(bounds, this._actorBounds(refActor), edges);
    bounds = this._applyDockMargin(bounds, monitor, edges);
    const { baseW, baseH } = bounds;

    if (baseW <= 9 || baseH <= 9) {
      this.bgActor.hide();
      // Forces a full update when the dock comes back.
      this._lastBgW = undefined;
      this._lastBgH = undefined;
      this._lastBgX = undefined;
      this._lastBgY = undefined;
      return;
    }
    this.bgActor.show();
    this.bgActor.opacity = this.targetActor.opacity;
    this._syncDockVisibility(bounds, monitor);
    this._syncDockCapture(bounds, monitor);
  }

  private _actorBounds(actor: Clutter.Actor): DockBounds {
    const [baseW, baseH] = actor.get_size();
    const [absX, absY] = actor.get_transformed_position();
    return { absX, absY, baseW, baseH };
  }

  private _liveSource: { actor: any, rawX: number, rawY: number } | null = null;

  private _readDockBounds(): DockBounds | null {
    let sourceActor = this.targetActor;
    let children = this.targetActor.get_children() as St.Widget[];
    for (let i = 0; i < children.length; i++) {
      if (children[i].has_style_class_name('dash-background')) {
        children[i].opacity = 0;
        sourceActor = children[i];
      }
    }

    let [baseW, baseH] = sourceActor.get_size();
    let [absX, absY] = sourceActor.get_transformed_position();
    if (Number.isNaN(absX) || Number.isNaN(absY)) return null;
    // The uncorrected position, which _syncGlassGeometryLive() compares against.
    this._liveSource = { actor: sourceActor, rawX: absX, rawY: absY };
    const bounds = { absX, absY, baseW, baseH };
    return sourceActor === this.targetActor ? bounds : clipDockBounds(bounds, this._actorBounds(this.targetActor));
  }

  private _stabilizeDockBounds(bounds: DockBounds, edges: DockEdges): DockBounds {
    let { baseW, baseH } = bounds;
    const { minCenterDist, distTopCenter, distBottomCenter } = edges;
    if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
      let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);

      // The dock's thickness can jump by exactly the margin for a frame;
      // such a jump is ignored.
      if (isHorizontalDock) {
        if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1)
          baseH = this._lastBaseH;
      } else {
        if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1)
          baseW = this._lastBaseW;
      }
    }
    this._lastBaseW = baseW;
    this._lastBaseH = baseH;
    return { ...bounds, baseW, baseH };
  }

  private _applyDockMargin(bounds: DockBounds, monitor: DockMonitor | null, edges: DockEdges): DockBounds {
    const marginValue = this._marginValue || 0;
    if (!monitor || !(marginValue > 0)) return bounds;
    const { absX, absY, baseW, baseH } = bounds;
    // No margin correction while the dock moves.
    let isMoving = false;
    if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
      let diffX = Math.abs(absX - this._lastAbsX);
      let diffY = Math.abs(absY - this._lastAbsY);
      if (diffX > 1.0 || diffY > 1.0) {
        isMoving = true;
      }
    }

    this._lastAbsX = absX;
    this._lastAbsY = absY;

    let [tW, tH] = this.targetActor.get_size();
    if (this._stableDeltaW === undefined || this._lastTW !== tW) {
      this._stableDeltaW = baseW - tW;
      this._lastTW = tW;
    }
    if (this._stableDeltaH === undefined || this._lastTH !== tH) {
      this._stableDeltaH = baseH - tH;
      this._lastTH = tH;
    }

    let stableBaseW = tW + this._stableDeltaW;
    let stableBaseH = tH + this._stableDeltaH;
    return isMoving ? bounds : insetDockBounds(bounds, monitor, edges, marginValue, stableBaseW, stableBaseH);
  }

  private _syncDockVisibility(bounds: DockBounds, monitor: DockMonitor | null): void {
    const { absX, absY, baseW, baseH } = bounds;
    const [visibleW, visibleH] = visibleDockSize(bounds, monitor);
    // Only a degenerate box hides the glass: a dock flush against the screen
    // edge is only a few pixels wide on screen. Logged on transition.
    if (visibleW <= 1 || visibleH <= 1) {
      if (this._lastHidden !== true) {
        this._lastHidden = true;
        this._logger.log(
          `[Liquid Glass][dock] hiding the glass: visible=(${visibleW.toFixed(1)}x${visibleH.toFixed(1)}) ` +
          `base=(${baseW.toFixed(1)}x${baseH.toFixed(1)}) abs=(${absX.toFixed(1)},${absY.toFixed(1)}) ` +
          `monitor=(${monitor?.x},${monitor?.y},${monitor?.width}x${monitor?.height}) ` +
          `margin=${this._marginValue}`);
      }
      this.bgActor!.opacity = 0;
    } else {
      if (this._lastHidden === true) {
        this._lastHidden = false;
        this._logger.log('[Liquid Glass][dock] glass visible again');
      }
      this.bgActor!.opacity = this.targetActor.opacity;
    }
  }

  private _syncDockCapture(bounds: DockBounds, monitor: DockMonitor): void {
    const { absX, absY, baseW, baseH } = bounds;
    const w = Math.max(1.0, baseW), h = Math.max(1.0, baseH);
    let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
    let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
    let bgX = absX - SHADER_PADDING - this._glassExpand;
    let bgY = absY - SHADER_PADDING - this._glassExpand;

    // bgActor and liquidBox cover the whole monitor, so the capture's
    // coordinates match the stage's, as Blur My Shell's panel blur requires.
    let screenW = monitor.width;
    let screenH = monitor.height;

    // Monitor-local, as the shader uses them.
    let localBgX = bgX - monitor.x;
    let localBgY = bgY - monitor.y;

    if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
      this._lastBgX !== bgX || this._lastBgY !== bgY ||
      this._lastScreenW !== screenW || this._lastScreenH !== screenH ||
      this.bgActor!.x !== monitor.x || this.bgActor!.y !== monitor.y) {
      this.bgActor!.remove_transition('size');
      this.bgActor!.remove_transition('position');
      this.bgActor!.set_position(monitor.x, monitor.y);
      this.bgActor!.set_size(screenW, screenH);
      this.bgActor!.remove_transition('size');
      this.bgActor!.remove_transition('position');

      this.liquidBox?.set_position(0, 0);
      this.liquidBox?.set_size(screenW, screenH);

      this._lastBgW = bgW; this._lastBgH = bgH;
      this._lastBgX = bgX; this._lastBgY = bgY;
      this._lastScreenW = screenW; this._lastScreenH = screenH;
    }

    // Limit drawing to the dock plus room for its shadow (not
    // clip_to_allocation, which would cut the shadow off).
    const CLIP_PADDING = 200;

    setClipIfChanged(
      this.bgActor,
      localBgX - CLIP_PADDING, localBgY - CLIP_PADDING,
      bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2
    );
    const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
    this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);

    this.effect?.setResolution(screenW, screenH);
    this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

    const source = this._liveSource;
    this._liveRef = source ? {
      actor: source.actor,
      rawX: source.rawX, rawY: source.rawY,
      rect: [localBgX, localBgY, bgW, bgH],
    } : null;

    this._windowCloneManager?.setOffset(-monitor.x, -monitor.y);

    // After setGlassGeometry() and before the samplers sync (see capture/clip.ts).
    syncGlassCaptureClip({
      cloneContainer: this._cloneContainer,
      effect: this.effect,
      originX: monitor.x,
      originY: monitor.y,
      uiSampler: this._uiSampler,
      windowCloneManager: this._windowCloneManager,
    });

    this._uiSampler?.refresh();
    this._uiSampler?.sync(monitor.x, monitor.y, screenW, screenH);

    this._windowCloneManager?.sync();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }

  private _stopFrameSync(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
  }

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;
    this._currentMarginStyle = undefined;
    this._stopFrameSync();
    // The dock may already have been destroyed by Dash to Dock.
    const dockAlive = isActorValid(this.targetActor);
    for (const id of this._signals) {
      if (dockAlive)
        this.targetActor.disconnect(id);
    }
    this._signals = [];
    if (dockAlive) {
      this.targetActor.remove_style_class_name('liquid-glass-transparent');
      if (this._originalStyle !== undefined) this.targetActor.set_style(this._originalStyle);
      for (const child of this.targetActor.get_children() as St.Widget[]) {
        if (child.has_style_class_name('dash-background')) child.opacity = 255;
      }
    }
    this._originalStyle = undefined;
    if (isActorValid(this._dockParent))
      this._dockParent!.remove_style_class_name('liquid-glass-transparent');
    this._dockParent = null;
    this.effect?.cleanup();
    this.effect = null;
    this._uiSampler?.destroy();
    this._uiSampler = null;
    this._windowCloneManager?.destroy();
    this._windowCloneManager = null;
    if (isActorValid(this.bgActor)) this.bgActor!.destroy();
    this.bgActor = null;
    // Destroyed with bgActor.
    this.liquidBox = null;
    this._cloneContainer = null;
  }

  cleanup() {
    this._liveRef = null;
    this._stopFrameSync();
    this._removeEffect();

    for (let id of this._settingsSignals)
      this._settings.disconnect(id);
    this._settingsSignals = [];
  }

  // The first running-app indicator inside the dock (Dash to Dock's
  // IndicatorDrawingArea), used to balance the gaps around the icons.
  private _findReferenceActor(actor: Clutter.Actor): Clutter.Actor | null {
    if (!actor) return null;
    if (actor.toString().includes('IndicatorDrawingArea'))
      return actor;

    for (const child of actor.get_children()) {
      const found = this._findReferenceActor(child);
      if (found)
        return found;
    }
    return null;
  }
}
