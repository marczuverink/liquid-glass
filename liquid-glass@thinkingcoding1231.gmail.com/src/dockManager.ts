// src/dockManager.js
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

import { clipDockBounds, dockEdges, balanceDockBounds, insetDockBounds, visibleDockSize,
  type DockBounds, type DockEdges, type DockMonitor } from './actors/dockGeometry.js';

import { Logger } from './logger.js';

// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
const SHADER_PADDING = 20;

// Utility: Convert HEX color string (e.g., "#ffffff") to normalized RGB array [1.0, 1.0, 1.0]
function hexToColorArray(hex: string): [number, number, number] {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) {
    return [1.0, 1.0, 1.0];
  }
  let r = parseInt(hex.slice(1, 3), 16) / 255.0;
  let g = parseInt(hex.slice(3, 5), 16) / 255.0;
  let b = parseInt(hex.slice(5, 7), 16) / 255.0;
  return [r, g, b];
}

export class DashManager {
  private extensionPath: string;
  private targetActor: St.Widget;
  private _settings: Gio.Settings;

  // private bgActor: St.Widget | null = null;
  private bgActor: Clutter.Actor | null = null;
  // Delete Shell.BlurEffect and use custom blur (dual kawase) — now handled inside LiquidEffect
  private effect: LiquidEffect | null = null;

  // Nesting order (outermost → innermost):
  //   bgActor (full monitor, no effect)
  //     └─ liquidBox  ← LiquidEffect with built-in dual-Kawase blur
  //          └─ _cloneContainer  ← bgClone + windowClones + uiClones
  private liquidBox: Clutter.Actor | null = null;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  private _glassExpand: number;

  private _signals: number[];
  private _settingsSignals: number[]; // GSettingsのイベントリスナーを管理
  private _frameSyncId: number;
  private _frameSignalId = 0;
  private _lastTickUs = 0;
  // [FIX] Set by cleanup() before anything that can throw. Read by the
  // per-frame tick so an orphaned loop stops working even if cleanup() never
  // reached _stopFrameSync(). See the note on frameTick.
  private _torndown: boolean = false;
  private _isEffectActive: boolean; // エフェクトが現在適用されているかのフラグ

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

  private _outputLogs: boolean = false;

  private _marginValue: number = 0;
  // Tracks the hide/show transition so the reason is logged once, not per frame.
  private _lastHidden: boolean | undefined;

  // What the last _syncGeometry() derived the shader's glass rect from, so
  // the paint-time hook can re-apply the part of it that moves. See
  // _syncGlassGeometryLive().
  private _liveRef: {
    actor: Clutter.Actor;
    rawX: number; rawY: number;
    rect: [number, number, number, number];
  } | null = null;

  private _uiSampler: UILayerSampler | null = null;
  private _windowCloneManager: WindowCloneManager | null = null;

  private _logger: Logger;

  // コンストラクタに settings を追加
  constructor(extensionPath: string, targetActor: St.Widget, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this.targetActor = targetActor;
    this._settings = settings; // GSettings object
    this._logger = logger; // Logger object

    this._glassExpand = 0; // ガラスエリアの拡張量（ピクセル）

    this._signals = [];
    this._settingsSignals = []; // GSettingsのイベントリスナーを管理
    this._frameSyncId = 0;
    this._isEffectActive = false; // エフェクトが現在適用されているかのフラグ
  }

  // 拡張機能が有効化された時に呼ばれるエントリーポイント
  setup() {
    if (!this.targetActor || !this._settings) return;

    // 設定の監視を開始
    this._bindSettings();

    // 初回起動時にスイッチがONならエフェクトを適用
    if (this._settings.get_boolean('enable-dock-glass')) {
      this._applyEffect();
    }
  }

  // 設定が変更された時にリアルタイムで反映するためのバインディング
  _bindSettings() {
    const connectSetting = (key, callback) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    // ON/OFFスイッチの切り替え
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

    // マージン変更時
    connectSetting('dock-margin-bottom', () => {
      if (this._isEffectActive) this._applyMargin();
      this._marginValue = this._settings.get_int('dock-margin-bottom') || 0;
    });

    // シェーダーパラメータの動的変更
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

    connectSetting('output-logs', () => {
      this._outputLogs = this._settings.get_boolean('output-logs');
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

  // マージンの再計算と適用（動的反映のために独立した関数化）
  _applyMargin() {
    if (!this.targetActor) return;

    let marginBottom = this._settings.get_int('dock-margin-bottom');

    let [w, h] = this.targetActor.get_size();
    let [x, y] = this.targetActor.get_transformed_position();

    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) monitorIndex = Main.layoutManager.primaryIndex;
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    // 画面の各エッジとの距離から配置場所を特定する
    let distLeft = x - monitor.x;
    let distRight = (monitor.x + monitor.width) - (x + w);
    let distTop = y - monitor.y;
    let distBottom = (monitor.y + monitor.height) - (y + h);
    let minEdge = Math.min(distLeft, distRight, distTop, distBottom);

    let marginStyle = '';
    if (minEdge === distBottom || minEdge === distTop) {
      if (minEdge === distBottom) {
        marginStyle = `margin-bottom: ${marginBottom}px;`; // 下
      } else {
        marginStyle = `margin-top: ${marginBottom}px;`; // 上
      }
    } else {
      if (minEdge === distRight) {
        marginStyle = `margin-right: ${marginBottom}px;`; // 右
      } else {
        marginStyle = `margin-left: ${marginBottom}px;`; // 左
      }
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

    // liquidBox: full-monitor-sized actor that holds the LiquidEffect.
    // LiquidEffect internally runs dual-Kawase blur passes before the glass composite,
    // so no separate blurBox/Shell.BlurEffect is needed.
    this.liquidBox = new UnpickableActor();
    this.liquidBox.set_name("liquid-box");
    this.liquidBox.set_clip_to_allocation(true);
    this.bgActor.add_child(this.liquidBox);

    // dummyBreaker: dummy actor to break the BMS bug
    let dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name("optimization-breaker");
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0); // 完全に透明
    this.liquidBox.add_child(dummyBreaker);

    // _cloneContainer lives inside liquidBox.
    // Clones are captured into the LiquidEffect's OffscreenEffect FBO and
    // blurred + distorted by the shader in a single pass.
    this._cloneContainer = new UnpickableActor();
    this._cloneContainer.set_name("clone-container");
    this.liquidBox.add_child(this._cloneContainer);

    // 動的マージンを適用
    this._applyMargin();
    this._marginValue = this._settings.get_int('dock-margin-bottom');
    this._glassExpand = this._settings.get_int("dock-glass-expand");
    this._outputLogs = this._settings.get_boolean('output-logs');

    let dockRoot = this.targetActor;
    while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
      let p = dockRoot.get_parent() as St.Widget | null;
      if (!p) break;
      dockRoot = p;
    }

    if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(this.bgActor, dockRoot);
    } else {
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    // 設定から初期値を読み込み
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

    // [FIX] Dock-follows-glass lag — same cause and same remedy as the
    // notification banner's. See LiquidEffect.setLiveGeometryHook().
    this.effect.setLiveGeometryHook(() => this._syncGlassGeometryLive());

    // WindowCloneManager + UILayerSampler deposit their clones inside liquidBox.
    this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer, 'lg-dock');
    // [FIX] dockRoot is passed BOTH as a fixed exclusion and as an ancestor
    // source. The fixed entry covers the common case; the ancestor source is
    // what keeps the exclusion correct after Dash to Dock destroys and
    // rebuilds its container (which it does whenever its settings change,
    // including a change of dock position). Without the second one the dock
    // starts being cloned into its own glass — ghost icons inside the dock.
    this._uiSampler = new UILayerSampler(
      this.bgActor, this.liquidBox,
      [dockRoot, global.windowGroup, global.window_group],
      this._cloneContainer,
      'dock',
      [this.targetActor]);

    this.bgActor.show();

    // Rebuild clones (called on menu open): delegate entirely to WindowCloneManager + UILayerSampler
    let buildClones = () => {
      if (!this.bgActor) return;
      excludeOtherGlass(this._uiSampler, this.bgActor);
      this._windowCloneManager?.rebuildClones();
      this._uiSampler?.rebindSelf();
      this._uiSampler?.refresh();
    };

    // Runs from the stage's own 'before-update' (startStageLoop()), so it
    // costs nothing while nothing on screen changes. A throw out of
    // _syncGeometry() (a disposed clone, a destroyed dash child, ...) is
    // caught and reported rather than allowed to escape: when this was a
    // self-rescheduling later chain, one such throw skipped the reschedule
    // and froze the dock's glass permanently — clones stuck at their last
    // position, no new UI clones (the Overview's controls never appeared
    // inside the dock), and the only way back was hiding and re-showing the
    // dock, since startFrameSync() only runs from 'notify::mapped'.
    // SAME_FRAME_WINDOW_US keeps two stage views updating in one frame from
    // stepping it twice.
    let frameTick = () => {
      // [FIX] Hard stop after teardown: _torndown ends the work even if
      // cleanup() never got as far as _stopFrameSync() — otherwise a live
      // handler against destroyed actors keeps this whole manager (and its
      // settings and logger) alive, and the next enable() builds a second set
      // on top of it, which is the "the extension can no longer be enabled"
      // symptom.
      if (this._torndown || !this._isEffectActive || !this.bgActor || !this.targetActor.mapped) return;
      // [DIAG] See setFrameSyncFrozen() in animation/frameSync.ts. Does
      // nothing, so the cost of this poll can be measured directly.
      if (isFrameSyncFrozen()) return;

      const nowUs = GLib.get_monotonic_time();
      if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US) return;
      this._lastTickUs = nowUs;
      try {
        // Repair the subtree if Clutter has stopped allocating it. Sampled
        // here, at the top of the tick, because the previous frame's relayout
        // has settled by now and this frame's sync has not dirtied anything
        // yet. See ensureGlassAllocated().
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

  // ── Paint-time geometry (see LiquidEffect.setLiveGeometryHook) ─────────────
  //
  // _syncGeometry() runs from the stage's 'before-update' and reads the dash
  // through get_transformed_position(), i.e. through its allocation. Dash to
  // Dock slides by easing 'slide-x' on its DashSlideContainer, whose
  // 'notify::slide-x' handler calls queue_relayout() and whose
  // vfunc_allocate() is what actually moves the dash (docking.js) — so the
  // position only becomes current in the stage's relayout phase, which runs
  // after 'before-update'. The tick therefore reads the previous frame's
  // allocation and the glass trails the dock across the whole animation.
  //
  // Only the translation is corrected here. _syncGeometry() is a long
  // stateful function — the gap/margin corrections, the "isMoving" guard, the
  // stable-delta bookkeeping all depend on running exactly once per frame —
  // so re-running it mid-paint would corrupt its own state, and none of that
  // bookkeeping is what moves during a slide anyway. The shape and size stay
  // as the tick computed them; the rect is simply put where the dock actually
  // is this frame.
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
    // this._logger.log(`[Raw] ${absX}, ${absY}, ${baseW}, ${baseH}`);
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
      // stateをリセットして、次の表示時に必ずガードを通過させる 
      // Reset state to guard against the next frame tick from applying the guard.
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

    // 1. まず元の背景のサイズと位置を取得
    let [baseW, baseH] = sourceActor.get_size();
    let [absX, absY] = sourceActor.get_transformed_position();
    if (Number.isNaN(absX) || Number.isNaN(absY)) return null;
    // Remembered before any of the corrections below touch it: the paint-time
    // hook compares against exactly this to learn how far the dock has moved
    // since this tick ran. See _syncGlassGeometryLive().
    this._liveSource = { actor: sourceActor, rawX: absX, rawY: absY };
    const bounds = { absX, absY, baseW, baseH };
    return sourceActor === this.targetActor ? bounds : clipDockBounds(bounds, this._actorBounds(this.targetActor));
  }

  private _stabilizeDockBounds(bounds: DockBounds, edges: DockEdges): DockBounds {
    let { baseW, baseH } = bounds;
    const { minCenterDist, distTopCenter, distBottomCenter } = edges;
    if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
      let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);

      if (isHorizontalDock) {
        // ▼ 上・下ドックの場合：異常に膨張するのは H（厚み）
        // Hの変化量が「ちょうど marginValue 分」だった場合のみ、そのジャンプを無効化（<= 1 に修正）
        if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1) {
          baseH = this._lastBaseH;
        }
      } else {
        // ▼ 左・右ドックの場合：異常に膨張するのは W（厚み）
        // Wの変化量が「ちょうど marginValue 分」だった場合のみ無効化
        if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1) {
          baseW = this._lastBaseW;
        }
      }
    }
    this._lastBaseW = baseW;
    this._lastBaseH = baseH;
    return { ...bounds, baseW, baseH };
  }

  private _applyDockMargin(bounds: DockBounds, monitor: DockMonitor | null, edges: DockEdges): DockBounds {
    // this._logger.log(`[Gap] ${absX}, ${absY}, ${baseW}, ${baseH}`);
    // --------------------------------------------------------------------
    // --------------------------------------------------------------------
    // [PERF C3] Mirrored by the 'changed::dock-margin-bottom' handler; no
    // need to go through GSettings on every frame.
    const marginValue = this._marginValue || 0;
    if (!monitor || !(marginValue > 0)) return bounds;
    const { absX, absY, baseW, baseH } = bounds;
    // アプリ起動時の微小揺れ（誤動作の元）を完全に無視するため、閾値を大きく設定
    let isMoving = false;
    if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
      let diffX = Math.abs(absX - this._lastAbsX);
      let diffY = Math.abs(absY - this._lastAbsY);
      if (diffX > 1.0 || diffY > 1.0) {
        isMoving = true;
      }
    }

    // Fix hiding animation bug
    // isMoving = false;
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
    // [FIX] Was `<= 5`. The guard exists to avoid drawing a glass for a dock
    // that has been reduced to nothing, but 5px is wide enough to catch a dock
    // that is merely sitting flush against a screen edge — which is exactly
    // what a small dock-margin-bottom produces, and it made the glass vanish
    // while the margin was being tuned. Only a genuinely degenerate box is
    // rejected now, and the decision is logged on transition so a dock that
    // still disappears says why.
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

    // Full-screen FBO geometry.
    // bgActor and liquidBox are both sized to cover the entire monitor.
    // This makes the FBO coordinate system match what BMS expects (full-screen
    // absolute coordinates), eliminating the BMS blur offset and cache-pollution
    // bugs caused by the old dock-sized FBO.
    let screenW = monitor.width;
    let screenH = monitor.height;

    // Dock background position in monitor-local coordinates (monitor origin = 0,0).
    // This is what the shader receives via setGlassGeometry() to reconstruct the
    // dock-centred local coordinate system inside the full-screen FBO.
    let localBgX = bgX - monitor.x;
    let localBgY = bgY - monitor.y;

    // Detect any change in dock geometry OR monitor size to trigger a rebuild.
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

    // Soft clipping via set_clip — limits GPU fragment-shader execution
    // to the dock region + a generous margin for drop-shadow decay, without
    // using clip_to_allocation (which hard-clips child actors and severs shadows).
    //
    // CLIP_PADDING must be at least as large as the maximum shadow_radius
    // setting so the penumbra gradient has room to fade to zero naturally.
    const CLIP_PADDING = 200;

    // Clip only bgActor; liquidBox has no separate clip
    // this.liquidBox?.remove_clip();

    // [PERF] clutter_actor_set_clip() does not compare before storing: it
    // notifies and calls clutter_actor_queue_redraw() every single time. Run
    // unconditionally from this per-frame tick, it damaged the dock's glass
    // (and therefore re-ran its capture/blur/composite) on every frame with
    // nothing on screen having moved. See setClipIfChanged() in actors/writes.ts.
    setClipIfChanged(
      this.bgActor,
      localBgX - CLIP_PADDING, localBgY - CLIP_PADDING,
      bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2
    );
    const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
    this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);

    /*
    if (this._outputLogs) {
      const shadowRadiusSetting = this._settings.get_double('shadow-radius');
      const shadowIntensitySetting = this._settings.get_double('shadow-intensity');
      this._logger.log(`[Shadow Debug] dock(local)=(${localBgX.toFixed(1)}, ${localBgY.toFixed(1)}, ${bgW.toFixed(1)}x${bgH.toFixed(1)}) ` +
        `clip=(${(localBgX - CLIP_PADDING).toFixed(1)}, ${(localBgY - CLIP_PADDING).toFixed(1)}, ` +
        `${(bgW + CLIP_PADDING * 2).toFixed(1)}x${(bgH + CLIP_PADDING * 2).toFixed(1)}) ` +
        `shadow_max_radius=${SHADOW_MAX_RADIUS} shadow-radius=${shadowRadiusSetting} shadow-intensity=${shadowIntensitySetting} ` +
        `screen=${screenW}x${screenH}`);
    }
    */

    // setResolution receives the full monitor dimensions (was bgW/bgH).
    // The shader uses resolution to compute UV-to-pixel mapping over the full FBO.
    this.effect?.setResolution(screenW, screenH);

    // Inform the shader where the dock lives within the full-screen FBO.
    // The shader uses these to compute dock_center and box_size, replacing
    // the old "resolution * 0.5" center assumption that only worked when
    // the FBO was dock-sized.
    this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

    const source = this._liveSource;
    this._liveRef = source ? {
      actor: source.actor,
      rawX: source.rawX, rawY: source.rawY,
      rect: [localBgX, localBgY, bgW, bgH],
    } : null;

    // Clones in WindowCloneManager are placed at (w.x, w.y) — absolute screen
    // coordinates. The container shift of (-monitor.x, -monitor.y) makes each
    // clone appear at (w.x - monitor.x, w.y - monitor.y) inside the full-screen
    // FBO, which maps back to (w.x, w.y) in screen space once bgActor's
    // monitor-origin position is added by Clutter's scene graph. ✓
    this._windowCloneManager?.setOffset(-monitor.x, -monitor.y);

    // [PERF ①/①b] Clip the offscreen CAPTURE to the region this glass can
    // actually show, and hide the clones that fall outside it. Must sit
    // between setGlassGeometry() (which makes the effect's uniforms describe
    // this frame) and the two sync() calls below (which consume the cull
    // rect this sets). See syncGlassCaptureClip() in capture/clip.ts.
    syncGlassCaptureClip({
      cloneContainer: this._cloneContainer,
      effect: this.effect,
      originX: monitor.x,
      originY: monitor.y,
      uiSampler: this._uiSampler,
      windowCloneManager: this._windowCloneManager,
    });

    // UILayerSampler is synced with the monitor origin and full-screen
    // dimensions instead of the dock-relative bgX/bgY/bgW/bgH.
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
    this._teardownStep('frameSync', () => stopStageLoop(this._frameSignalSlot, this._frameSlot));
  }

  // エフェクトを画面から消し、元に戻す処理
  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;
    this._currentMarginStyle = undefined;
    this._stopFrameSync();
    // Safely try to remove styles/signals. If targetActor is already destroyed, 
    // this will fail safely without breaking the rest of the cleanup.
    for (const id of this._signals) {
      this._teardownStep('targetSignal', () => {
        if (isActorValid(this.targetActor)) this.targetActor.disconnect(id);
      });
    }
    this._signals = [];
    this._teardownStep('targetStyle', () => {
      if (!isActorValid(this.targetActor)) return;
      this.targetActor.remove_style_class_name('liquid-glass-transparent');
      if (this._originalStyle !== undefined) this.targetActor.set_style(this._originalStyle);
      for (const child of this.targetActor.get_children() as St.Widget[]) {
        if (child.has_style_class_name('dash-background')) child.opacity = 255;
      }
    });
    this._originalStyle = undefined; // 次回オンになった時に再取得できるようクリア
    this._teardownStep('parentStyle', () => {
      if (isActorValid(this._dockParent))
        this._dockParent!.remove_style_class_name('liquid-glass-transparent');
    });
    this._dockParent = null;
    this._teardownStep('effect', () => this.effect?.cleanup());
    this.effect = null;
    this._teardownStep('uiSampler', () => this._uiSampler?.destroy());
    this._uiSampler = null;
    this._teardownStep('windowClones', () => this._windowCloneManager?.destroy());
    this._windowCloneManager = null;
    this._teardownStep('background', () => {
      if (isActorValid(this.bgActor)) this.bgActor!.destroy();
    });
    this.bgActor = null;
    // liquidBox is a child of bgActor and is already destroyed by bgActor.destroy().
    // Just clear the reference here.
    this.liquidBox = null;
    this._cloneContainer = null;
  }

  // 拡張機能全体が無効化される時の最終クリーンアップ
  // [FIX] Teardown must not be all-or-nothing.
  //
  // These steps used to run bare, one after another, so the first one that
  // threw skipped every step after it — signal handlers, actors, effects and
  // (worst of all) the per-frame later chain stayed alive, and the next
  // enable() built a second set on top. Disabling is exactly when a throw is
  // most likely: the shell is destroying the same actors we are.
  private _teardownStep(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this._logger?.error(`[Liquid Glass] ${this.constructor.name}.${name} failed during cleanup: ${e}`);
      } catch {
        console.error(`[Liquid Glass] ${name} failed during cleanup: ${e}`);
      }
    }
  }

  cleanup() {
    this._torndown = true;
    // Nothing for a late paint-time hook to act on. (The effect drops the
    // hook itself in its own cleanup(); this covers the window before that.)
    this._liveRef = null;

    // 毎フレームのループを最初に、無条件で止める。_removeEffect() の途中で
    // throw しても孤児ループが残らないようにするため（_teardownStep のコメント参照）。
    this._stopFrameSync();

    // エフェクトを解除
    this._teardownStep('removeEffect', () => this._removeEffect());

    // メモリリークを防ぐため、GSettingsのリスナーもすべて解除する
    this._teardownStep('settingsSignals', () => {
      if (this._settings) {
        for (let id of this._settingsSignals) {
          try { this._settings.disconnect(id); } catch { }
        }
        this._settingsSignals = [];
      }
    });
  }

  // ドックの内部から、計算の基準となるアイコンまたはインジケーターを1つ再帰的に探し出す
  private _findReferenceActor(actor: Clutter.Actor): Clutter.Actor | null {
    if (!actor) return null;
    // 1. 安全性のチェック：オブジェクトが存在しない、または get_children がない場合は終了
    if (!actor || typeof actor.get_children !== 'function') {
      return null;
    }

    // 2. 判定条件：文字列化して 'IndicatorDrawingArea' が含まれているか
    if (actor.toString().includes('IndicatorDrawingArea')) {
      return actor;
    }

    // 3. 子要素を再帰的に探索
    const children = actor.get_children();
    for (const child of children) {
      const found = this._findReferenceActor(child);
      if (found) {
        return found; // 見つかったら即座に返す（無駄な探索をしない）
      }
    }

    return null; // 見つからなかった場合
  }
}
