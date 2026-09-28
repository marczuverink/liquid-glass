import { stepMenuSprings, applyMenuFrame, showMenuAtRest } from './animation/menuSpring.js';
import { addFrameTicker, removeFrameTicker, normalizeAnimationIntervalMs } from './animation/frameTicker.js';
import { Spring, SwiftSpring } from './animation/spring.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableActor, UnpickableWidget } from './actors/unpickable.js';
import { UILayerSampler } from './capture/uiLayerSampler.js';
import { WindowCloneManager } from './capture/windowClones.js';
import { reportFrameLoopError } from './diagnostics/logging.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { resolveMonitorGeometry, getAllocatedSize } from './actors/geometry.js';
import { isActorValid } from './actors/lifecycle.js';
import { isFrameSyncFrozen } from './animation/frameSync.js';
import { setClipIfChanged } from './actors/writes.js';
import { syncGlassCaptureClip } from './capture/clip.js';
import { resolveCrossFade, adaptiveColorTweener } from './animation/colors.js';

import { Logger } from './logger.js';

const SHADER_PADDING = 20;

const SAMPLE_PER_ELEMENT = false;

interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
  _currentInsensitiveState?: boolean;
  _isUpdatingAlpha?: boolean;
}

const MIN_MENU_SCALE = 0.5;
const MENU_MEASURE_FRAMES = 30;
let _quickSettingsHeight = 0;
let _quickSettingsWaiting: ((height: number) => void)[] | null = null;
const MENU_MEASURE_STABLE_FRAMES = 3;

export class UIManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private targetActor: St.Widget;
  private menu: any;
  private animActor: St.Widget;
  private bgActor: Clutter.Actor | null;
  private effect: LiquidEffect | null;

  private _cloneContainer: Clutter.Actor | null = null;
  private _windowCloneManager: WindowCloneManager | null = null;

  private _signals: { target: any, id: number }[];
  private _animSignalId: number = 0;
  private _destroySignalId = 0;
  private _actorDestroyed = false;
  private _frameSyncId: number;
  private _torndown: boolean = false;
  private _glassExpand: number;
  private _menuXoffset: number;
  private _menuYoffset: number;
  private _menuScale: number = 1.0;
  private _ownsAccentCss: boolean = true;
  private _matchQuickSettingsHeight: boolean = false;
  private _settledHeightScale: number | null = null;
  private _measuringHeights: boolean = false;
  private _ownOpenHeight: number = 0;
  private _measureLaterId: number = 0;
  private _restoreQuickSettings: (() => void) | null = null;
  private _tickId: number;
  private _contrastSampler: StageContrastSampler;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;
  private _hoverSignals: Map<Clutter.Actor, number> = new Map();
  private _pendingBackdropRoots: Set<Clutter.Actor> = new Set();
  private _backdropColored: Set<Clutter.Actor> = new Set();
  private _applyingColors: boolean = false;
  private _backdropRefreshId: number = 0;
  private _settingsSignals: number[];
  private _isEffectActive: boolean;
  private _adaptiveConfig!: typeof AdaptiveContrastConfig;
  private liquidBox: Clutter.Actor | null = null;
  private _stableBaseW: number | undefined;
  private _stableBaseH: number | undefined;
  private _lastValidAnimAbsX: number | undefined;
  private _lastValidAnimAbsY: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _springScale: Spring;
  private _springPos: Spring;
  private _springStiffness: number;
  private _springDamping: number;
  private _springMass: number;

  private _swiftAnimation: boolean = false;
  private _swiftResponse: number = 0.3;
  private _swiftDampingFraction: number = 0.65;

  private _swiftSpringScale: SwiftSpring;
  private _swiftSpringPos: SwiftSpring;

  private _enableAnimation: boolean;

  private _interfaceSettings: Gio.Settings | null = null;
  private _accentColorSignalId: number = 0;

  private _dynamicCssFile: Gio.File | null = null;
  private _cornerRadius: number = 0;

  private _animationInterval: number = 16;
  private _uiSampler: UILayerSampler | null = null;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  private _menuRoot: Clutter.Actor | null = null;

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger,
              panelButton: any = Main.panel.statusArea.dateMenu, ownsAccentCss: boolean = true,
              private _enableKey: string = 'enable-menu-glass',
              private _keyPrefix: string = 'menu',
              private _label: string = 'menu',
              private _ownsSettingsNamespace: boolean = true) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;
    this._ownsAccentCss = ownsAccentCss;

    this.targetActor = panelButton.menu.actor as St.Widget;
    this.menu = panelButton.menu;
    this.animActor = panelButton.menu.box as St.Widget;

    this.bgActor = null;
    this.effect = null;

    this._signals = [];
    this._frameSyncId = 0;

    this._glassExpand = 0;
    this._menuXoffset = 0;
    this._menuYoffset = 0;

    this._springScale = new Spring(120, 8, 1.0);
    this._springPos = new Spring(300, 12, 1.0);
    this._springStiffness = 120;
    this._springDamping = 8;
    this._springMass = 1.0;

    this._swiftSpringScale = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);
    this._swiftSpringPos = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);

    this._enableAnimation = false;
    this._tickId = 0;

    this._contrastSampler = new StageContrastSampler();
    this._adaptiveTimerId = 0;
    this._adaptiveInFlight = false;
    this._styledActors = new Map();

    this._settingsSignals = [];
    this._isEffectActive = false;

    this._animSignalId = this.menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
      if (!this._isEffectActive) return;
      if (isOpen) {
        this._applyMenuScale();
        this._startAnimation(1);
      } else {
        this._startAnimation(0);
      }
    });
    this._destroySignalId = this.targetActor.connect('destroy', () => {
      this._actorDestroyed = true;
      this._destroySignalId = 0;
      this.cleanup();
    });
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    this._enableAnimation = this._settings.get_boolean(this._animationKey());
    this._menuScale = this._settings.get_double(this._key('scale'));
    this._matchQuickSettingsHeight = this._settings.get_boolean(this._key('match-quick-settings-height'));
    const remembered = this._ownsSettingsNamespace
      ? this._settings.get_double(this._key('settled-height-scale')) : 0;
    this._settledHeightScale = remembered > 0 ? remembered : null;
    this._applyMenuScale();
    this._springStiffness = this._settings.get_double(this._key('spring-stiffness'));
    this._springDamping = this._settings.get_double(this._key('spring-damping'));
    this._springMass = this._settings.get_double(this._key('spring-mass'));
    this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    this._springPos.updateParams(this._springStiffness, this._springDamping, this._springMass);

    this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    this._accentColorSignalId = this._interfaceSettings.connect('changed::accent-color', () => {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        this._applySystemAccentColor();
        return GLib.SOURCE_REMOVE;
      });
    });

    this._applySystemAccentColor();

    if (this._settings.get_boolean(this._enableKey)) {
      this._applyEffect();
    }
  }

  private _applySystemAccentColor() {
    if (!this._ownsAccentCss || !this.targetActor) return;

    const parent = new UnpickableWidget({ style_class: 'calendar' });
    const child = new UnpickableWidget({ style_class: 'calendar-day calendar-today' });
    parent.add_child(child);

    Main.layoutManager.uiGroup.add_child(parent);
    child.ensure_style();

    const themeNode = child.get_theme_node();
    const bgColor = themeNode.get_background_color();

    Main.layoutManager.uiGroup.remove_child(parent);
    parent.destroy();

    const colorStr = this._rgbToHex(bgColor.red, bgColor.green, bgColor.blue);

    const cssContent = `
      .liquid-glass-menu-root .calendar-today,
      .liquid-glass-menu-root .calendar-today:hover,
      .liquid-glass-menu-root .calendar-today:active,
      .liquid-glass-menu-root .calendar-today:checked,
      .liquid-glass-menu-root .calendar-today:focus {
        background-color: ${colorStr} !important;
        color: white !important;
      }
    `;

    try {
      const cacheDir = GLib.get_user_cache_dir();
      const filePath = GLib.build_filenamev([cacheDir, 'liquid-glass-accent.css']);

      GLib.file_set_contents(filePath, cssContent);

      const themeContext = St.ThemeContext.get_for_stage(global.stage);
      const theme = themeContext.get_theme();

      if (this._dynamicCssFile) {
        theme.unload_stylesheet(this._dynamicCssFile);
      }

      this._dynamicCssFile = Gio.File.new_for_path(filePath);
      theme.load_stylesheet(this._dynamicCssFile);

      this._logger.log(`[Liquid Glass] [UIManager] System accent color applied: ${colorStr}`);
    } catch (e) {
      this._logger.error(`[Liquid Glass] [UIManager] Failed to apply system accent color: ${e}`);
    }
  }

  _hexToColorArray(hex: string): [number, number, number] {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return [1.0, 1.0, 1.0];
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
  }

  _allocatedHeightOf(actor: any): number {
    if (!actor || !isActorValid(actor))
      return 0;

    try {
      if (!actor.has_allocation?.())
        return 0;
      const [, allocated] = getAllocatedSize(actor);
      if (allocated > 1)
        return allocated;
    } catch (e) { }

    return 0;
  }

  _firstHeight(actors: any[], measure: (actor: any) => number): number {
    for (const actor of actors) {
      const height = measure(actor);
      if (height > 0)
        return height;
    }
    return 0;
  }

  _settleHeight(menu: any, done: (height: number) => void): void {
    const actor = menu?.actor;
    if (!actor || !isActorValid(actor)) {
      done(0);
      return;
    }

    let framesLeft = MENU_MEASURE_FRAMES;
    let tallest = 0;
    let repeats = 0;
    const tick = () => {
      this._measureLaterId = 0;
      let height = 0;
      try {
        height = this._firstHeight([actor, menu.box], a => this._allocatedHeightOf(a));
      } catch (e) { }

      repeats = height > 0 && height === tallest ? repeats + 1 : 0;
      if (height > tallest) tallest = height;

      if (repeats < MENU_MEASURE_STABLE_FRAMES && --framesLeft > 0 && !this._torndown) {
        this._measureLaterId = this._addMeasureLater(tick);
        return GLib.SOURCE_REMOVE;
      }

      done(tallest);
      return GLib.SOURCE_REMOVE;
    };

    this._measureLaterId = this._addMeasureLater(tick);
  }

  _addMeasureLater(callback: () => boolean): number {
    return global.compositor?.get_laters?.().add(Meta.LaterType.BEFORE_REDRAW, callback) ?? 0;
  }

  _cancelHeightMeasurement(): void {
    if (this._measureLaterId !== 0) {
      if (global.compositor?.get_laters)
        global.compositor.get_laters().remove(this._measureLaterId);
      this._measureLaterId = 0;
    }

    const restore = this._restoreQuickSettings;
    this._restoreQuickSettings = null;
    if (restore) restore();
  }

  _withQuickSettingsHeight(done: (height: number) => void): void {
    if (_quickSettingsHeight > 0) {
      done(_quickSettingsHeight);
      return;
    }

    if (_quickSettingsWaiting) {
      _quickSettingsWaiting.push(done);
      return;
    }

    const menu = Main.panel.statusArea.quickSettings?.menu;
    const actor = menu?.actor;
    if (!menu || !actor || !isActorValid(actor)) {
      done(0);
      return;
    }

    _quickSettingsWaiting = [done];
    const settle = (height: number) => {
      _quickSettingsHeight = height;
      const waiting = _quickSettingsWaiting ?? [];
      _quickSettingsWaiting = null;
      for (const callback of waiting) callback(height);
    };

    if (menu.isOpen) {
      this._settleHeight(menu, settle);
      return;
    }

    const opacity = actor.opacity;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try { menu.close(0); } catch (e) { }
      try { actor.opacity = opacity; } catch (e) { }
    };

    try {
      menu.open(0);
      actor.opacity = 0;
    } catch (e) {
      restore();
      settle(0);
      return;
    }

    this._restoreQuickSettings = restore;
    this._settleHeight(menu, height => {
      this._restoreQuickSettings = null;
      restore();
      settle(height);
    });
  }

  _measureHeightScale(): void {
    if (this._torndown || !this.menu) return;

    _quickSettingsHeight = 0;
    this._ownOpenHeight = 0;
    this._withQuickSettingsHeight(() => this._rememberRatioWhenBothKnown());
  }

  _noteOwnOpenedHeight(): void {
    if (this._torndown || !this._matchQuickSettingsHeight) return;
    if (this._measuringHeights || _quickSettingsHeight <= 0) return;

    this._measuringHeights = true;
    this._settleHeight(this.menu, height => {
      this._measuringHeights = false;
      if (height > 0) {
        this._ownOpenHeight = height;
        this._rememberRatioWhenBothKnown();
      }
    });
  }

  _rememberRatioWhenBothKnown(): void {
    if (_quickSettingsHeight <= 0 || this._ownOpenHeight <= 0) return;

    const ratio = _quickSettingsHeight / this._ownOpenHeight;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return;

    this._rememberHeightScale(ratio);
    this._applyMenuScale();
  }

  _quickSettingsHeightScale(): number | null {
    const quickSettings = Main.panel.statusArea.quickSettings?.menu;
    if (!quickSettings)
      return this._settledHeightScale;

    const targetHeight = this._firstHeight([quickSettings.actor, quickSettings.box],
      actor => this._allocatedHeightOf(actor));
    const ownHeight = this._firstHeight([this.targetActor, this.animActor],
      actor => this._allocatedHeightOf(actor));
    if (targetHeight <= 0 || ownHeight <= 0)
      return this._settledHeightScale;

    const ratio = targetHeight / ownHeight;
    if (!Number.isFinite(ratio) || ratio <= 0)
      return this._settledHeightScale;

    this._rememberHeightScale(ratio);
    return ratio;
  }

  _rememberHeightScale(ratio: number): void {
    if (this._settledHeightScale !== null && Math.abs(this._settledHeightScale - ratio) < 0.005)
      return;

    this._settledHeightScale = ratio;
    if (!this._ownsSettingsNamespace) return;

    try {
      this._settings.set_double(this._key('settled-height-scale'), ratio);
    } catch (e) { }
  }

  _applyMenuScale() {
    if (!this.targetActor || !isActorValid(this.targetActor))
      return;

    let requested = this._menuScale;
    if (this._matchQuickSettingsHeight) {
      const matched = this._quickSettingsHeightScale();
      if (matched !== null)
        requested = matched;
    }

    const scale = Number.isFinite(requested)
      ? Math.min(1.0, Math.max(MIN_MENU_SCALE, requested))
      : 1.0;

    this.targetActor.set_pivot_point(0.5, 0.0);
    this.targetActor.set_scale(scale, scale);
  }

  _getMenuMonitorGeometry() {
    return resolveMonitorGeometry([this.menu?.sourceActor, this.targetActor]);
  }

  private _restackGlass(): void {
    const uiGroup = Main.layoutManager.uiGroup;
    const root = this._menuRoot;
    if (!this.bgActor || !root) return;
    if (!isActorValid(root) || root.get_parent() !== uiGroup) return;
    if (this.bgActor.get_parent() !== uiGroup) return;

    const children = uiGroup.get_children();
    const rootIndex = children.indexOf(root);
    if (rootIndex < 0) return;
    if (children.indexOf(this.bgActor) === rootIndex - 1) return;

    uiGroup.set_child_below_sibling(this.bgActor, root);
  }

  private _key(suffix: string): string {
    return `${this._keyPrefix}-${suffix}`;
  }

  private _animationKey(): string {
    return `enable-${this._keyPrefix}-animation`;
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting(this._enableKey, () => {
      let enabled = this._settings.get_boolean(this._enableKey);
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting(this._animationKey(), () => {
      this._enableAnimation = this._settings.get_boolean(this._animationKey());
    });

    connectSetting(this._key('spring-stiffness'), () => {
      this._springStiffness = this._settings.get_double(this._key('spring-stiffness'));
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting(this._key('spring-damping'), () => {
      this._springDamping = this._settings.get_double(this._key('spring-damping'));
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting(this._key('spring-mass'), () => {
      this._springMass = this._settings.get_double(this._key('spring-mass'));
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting(this._key('animation-interval-ms'), () => {
      this._animationInterval = this._settings.get_int(this._key('animation-interval-ms'));
    });

    connectSetting(this._key('tint-color'), () => {
      if (this.effect) {
        let colorArray = this._hexToColorArray(this._settings.get_string(this._key('tint-color')));
        this.effect.setTintColor(...colorArray);
      }
    });

    connectSetting(this._key('tint-strength'), () => {
      if (this.effect) {
        this.effect.setTintStrength(this._settings.get_double(this._key('tint-strength')));
      }
    });

    connectSetting(this._key('blur-radius'), () => {
      if (this.effect) {
        this.effect.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
      }
    });

    connectSetting(this._key('brightness'), () => {
      if (this.effect) {
        this.effect.setBrightness(this._settings.get_double(this._key('brightness')));
      }
    });

    connectSetting(this._key('contrast'), () => {
      if (this.effect) {
        this.effect.setContrast(this._settings.get_double(this._key('contrast')));
      }
    });

    connectSetting(this._key('saturation'), () => {
      if (this.effect) {
        this.effect.setSaturation(this._settings.get_double(this._key('saturation')));
      }
    });

    connectSetting(this._key('corner-radius'), () => {
      if (this.effect) {
        this._cornerRadius = this._settings.get_double(this._key('corner-radius'));
        this.effect.setCornerRadius(this._cornerRadius);
      }
    });

    connectSetting(this._key('glass-expand'), () => {
      if (this.effect) {
        this._glassExpand = this._settings.get_int(this._key('glass-expand'));
      }
    });

    connectSetting(this._key('x-offset'), () => {
      if (this.animActor) {
        this._menuXoffset = this._settings.get_int(this._key('x-offset'));
        this.animActor.translation_x = this._menuXoffset;
      }
    });

    connectSetting(this._key('scale'), () => {
      this._menuScale = this._settings.get_double(this._key('scale'));
      this._applyMenuScale();
    });

    connectSetting(this._key('match-quick-settings-height'), () => {
      this._matchQuickSettingsHeight = this._settings.get_boolean(this._key('match-quick-settings-height'));
      this._applyMenuScale();
      if (this._matchQuickSettingsHeight) this._measureHeightScale();
    });

    connectSetting(this._key('y-offset'), () => {
      if (this.animActor) {
        this._menuYoffset = this._settings.get_int(this._key('y-offset'));
        this.animActor.translation_y = this._menuYoffset;
      }
    });

    connectSetting(this._key('enable-adaptive-text-color'), () => {
      this._adaptiveConfig.enabled = this._settings.get_boolean(this._key('enable-adaptive-text-color'));
    });

    connectSetting(this._key('sample-interval-ms'), () => {
      this._adaptiveConfig.sampleIntervalMs = this._settings.get_int(this._key('sample-interval-ms'));
    });
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    if (!this.targetActor) return;

    this.targetActor.add_style_class_name('liquid-glass-transparent');
    this.animActor.add_style_class_name('liquid-glass-transparent');
    this.animActor.add_style_class_name('liquid-glass-menu-root');

    this._menuXoffset = this._settings.get_int(this._key('x-offset'));
    this._menuYoffset = this._settings.get_int(this._key('y-offset'));
    this.animActor.translation_x = this._menuXoffset;
    this.animActor.translation_y = this._menuYoffset;

    this._glassExpand = this._settings.get_int(this._key('glass-expand'));
    this._animationInterval = this._settings.get_int(this._key('animation-interval-ms'));

    this._adaptiveConfig = {
      ...AdaptiveContrastConfig,
      enabled: this._settings.get_boolean(this._key('enable-adaptive-text-color')),
      samplePerElement: SAMPLE_PER_ELEMENT,
      sampleIntervalMs: this._settings.get_int(this._key('sample-interval-ms')),
    };

    this.bgActor = new UnpickableActor();
    this.bgActor.set_name('liquid-glass-bg-actor');
    this.bgActor.set_size(1.0, 1.0);

    this.liquidBox = new UnpickableActor();
    this.liquidBox.set_name("liquid-box");
    this.liquidBox.set_clip_to_allocation(true);
    this.bgActor.add_child(this.liquidBox);

    let dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name("optimization-breaker");
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0);
    this.liquidBox.add_child(dummyBreaker);

    this._cloneContainer = new UnpickableActor();
    this._cloneContainer.set_name("clone-container");
    this.liquidBox.add_child(this._cloneContainer);

    this.animActor.set_pivot_point(0.5, 0.0);
    this.bgActor.set_pivot_point(0.0, 0.0);

    let menuRoot: Clutter.Actor = this.menu.actor;
    while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
      const p = menuRoot.get_parent();
      if (!p) break;
      menuRoot = p;
    }

    this._menuRoot = menuRoot;
    if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(this.bgActor, menuRoot);
    } else {
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer, `lg-${this._label}`);

    this._uiSampler = new UILayerSampler(
      this.bgActor,
      this.liquidBox,
      [menuRoot, global.windowGroup, global.window_group],
      this._cloneContainer,
      this._label
    );

    let blurRadius = this._settings.get_int(this._key('blur-radius'));
    let tintColorStr = this._settings.get_string(this._key('tint-color'));
    let tintStrength = this._settings.get_double(this._key('tint-strength'));
    let brightness = this._settings.get_double(this._key('brightness'));
    let contrast = this._settings.get_double(this._key('contrast'));
    let saturation = this._settings.get_double(this._key('saturation'));
    this._cornerRadius = this._settings.get_double(this._key('corner-radius'));

    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings, owner: this._label } as any);
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setTintColor(...this._hexToColorArray(tintColorStr));
    this.effect.setTintStrength(tintStrength);
    this.effect.setCornerRadius(this._cornerRadius);
    this.effect.setIsDock(false);
    this.effect.setBrightness(brightness);
    this.effect.setContrast(contrast);
    this.effect.setSaturation(saturation);
    this.effect.setBlurRadius(blurRadius);
    this.liquidBox.add_effect(this.effect);

    this.bgActor.hide();

    const laterAdd = (laterType: Meta.LaterType, callback: GLib.SourceFunc) => {
      return global.compositor?.get_laters?.().add(laterType, callback);
    };

    const laterRemove = (id: number) => {
      if (!id) return;
      if (global.compositor?.get_laters)
        global.compositor.get_laters().remove(id);
    };

    const frameLaterType = Meta.LaterType.BEFORE_REDRAW;

    let buildClones = () => {
      if (!this.bgActor) return;

      if (this._uiSampler) {
        for (let child of Main.layoutManager.uiGroup.get_children()) {
          if (child === this.bgActor) continue;

          let isLiquidBg = child.name === 'liquid-glass-bg-actor' ||
            (typeof child.get_children === 'function' &&
              child.get_children().some(c => c.name === 'liquid-box'));

          if (isLiquidBg) {
            this._uiSampler.addExclusion(child);
          }
        }
      }

      this._restackGlass();

      this._windowCloneManager?.rebuildClones();
      this._uiSampler?.rebindSelf();
      this._uiSampler?.refresh();
    };

    let frameTick = () => {
      this._frameSyncId = 0;
      if (this._torndown) return GLib.SOURCE_REMOVE;
      if (!this.bgActor || !this.targetActor.mapped)
        return GLib.SOURCE_REMOVE;

      if (isFrameSyncFrozen()) {
        this._frameSyncId = laterAdd(frameLaterType, frameTick);
        return GLib.SOURCE_REMOVE;
      }

      ensureGlassAllocated(this.bgActor);
      try {
        this._syncGeometry();
      } catch (e) {
        reportFrameLoopError('UIManager', e);
      }
      this._frameSyncId = laterAdd(frameLaterType, frameTick);
      return GLib.SOURCE_REMOVE;
    };

    let startFrameSync = () => {
      if (this._frameSyncId === 0) {
        buildClones();
        this._frameSyncId = laterAdd(frameLaterType, frameTick);
      }
    };

    let stopFrameSync = () => {
      if (this._frameSyncId !== 0) {
        laterRemove(this._frameSyncId);
        this._frameSyncId = 0;
      }
    };

    this._signals.push({
      target: this.menu,
      id: this.menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
        if (isOpen) {
          this._queueBackdropRefresh(this.menu?.actor);
          this._noteOwnOpenedHeight();
          this._stableBaseW = undefined;
          this._stableBaseH = undefined;
          startFrameSync();
          this._startAdaptiveColorSampling(true);
        } else {
          this._stopAdaptiveColorSampling();
        }
      })
    });

    this._signals.push({
      target: this.menu.actor,
      id: this.menu.actor.connect('notify::mapped', () => {
        if (!this.menu.actor.mapped) {
          stopFrameSync();

          if (this.bgActor) {
            this.bgActor.hide();
            this.bgActor.opacity = 0;
          }
          if (this.animActor) {
            this.animActor.opacity = 0;
          }
        }
      })
    });

    this._updateResolution();
    if (this.targetActor.mapped) {
      startFrameSync();
    }
  }

  _syncGeometry() {
    if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
      if (this.bgActor && this.bgActor.visible) {
        this.bgActor.hide();
      }
      return;
    }
    if (!this.bgActor.visible) {
      this.bgActor.show();
    }
    if (!this._enableAnimation) {
      this.bgActor.opacity = this.targetActor.opacity;
    }
    let [inW, inH] = getAllocatedSize(this.animActor);
    let [scaleX, scaleY] = this.animActor.get_scale();

    inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
    inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
    scaleX = Number.isNaN(scaleX) ? 1.0 : scaleX;
    scaleY = Number.isNaN(scaleY) ? 1.0 : scaleY;

    scaleX *= this.targetActor.get_scale()[0];
    scaleY *= this.targetActor.get_scale()[1];

    this._stableBaseW = Math.round(inW);
    this._stableBaseH = Math.round(inH);

    let w = Math.max(1, this._stableBaseW * scaleX);
    let h = Math.max(1, this._stableBaseH * scaleY);

    let [animAbsX, animAbsY] = this.animActor.get_transformed_position();

    if (Number.isNaN(animAbsX) || Number.isNaN(animAbsY)) {
      if (this._lastValidAnimAbsX !== undefined && this._lastValidAnimAbsY !== undefined) {
        animAbsX = this._lastValidAnimAbsX;
        animAbsY = this._lastValidAnimAbsY;
      } else {
        let monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
          animAbsX = (monitor.width / 2) - (w / 2) + this._menuXoffset;
          animAbsY = (Main.panel.height || 27) + this._menuYoffset;
        } else {
          animAbsX = 0;
          animAbsY = 0;
        }
      }
    } else {
      this._lastValidAnimAbsX = animAbsX;
      this._lastValidAnimAbsY = animAbsY;
    }

    let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
    let bgY = animAbsY - this._glassExpand - SHADER_PADDING;

    let monitor = this._getMenuMonitorGeometry();
    let monitorX = monitor?.x ?? 0;
    let monitorY = monitor?.y ?? 0;
    let screenW = Math.max(1, monitor?.width ?? 1);
    let screenH = Math.max(1, monitor?.height ?? 1);

    if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {
      let localBgX = bgX - monitorX;
      let localBgY = bgY - monitorY;

      if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
        this._lastBgX !== bgX || this._lastBgY !== bgY ||
        this._lastScreenW !== screenW || this._lastScreenH !== screenH) {
        this.bgActor.remove_transition('size');
        this.bgActor.remove_transition('position');
        this.bgActor.set_position(monitorX, monitorY);
        this.bgActor.set_size(screenW, screenH);
        this.bgActor.remove_transition('size');
        this.bgActor.remove_transition('position');

        this.liquidBox?.set_position(0, 0);
        this.liquidBox?.set_size(screenW, screenH);

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

        this._lastBgW = bgW; this._lastBgH = bgH;
        this._lastBgX = bgX; this._lastBgY = bgY;
        this._lastScreenW = screenW; this._lastScreenH = screenH;
      }
    }

    if (this.effect) {
      let currentScale = Math.min(scaleX, scaleY);
      this.effect.setCornerRadius(this._cornerRadius * currentScale);

      if (typeof this.effect.setAnimationScale === 'function') {
        this.effect.setAnimationScale(currentScale);
      }
    }

    this._windowCloneManager?.setOffset(-monitorX, -monitorY);
    this._uiSampler?.refresh();

    syncGlassCaptureClip({
      cloneContainer: this._cloneContainer,
      effect: this.effect,
      originX: monitorX,
      originY: monitorY,
      uiSampler: this._uiSampler,
      windowCloneManager: this._windowCloneManager,
    });

    this._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
    this._windowCloneManager?.sync();
  }

  _updateResolution() {
    if (!this.bgActor || !this.effect) return;
    let [width, height] = this.bgActor.get_size();
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      this.effect.setResolution(width, height);
    }
  }

  _hasStyleClass(actor: Clutter.Actor, className: string) {
    return actor instanceof St.Widget &&
      actor.has_style_class_name(className);
  }

  _collectAdaptiveTextTargets(actor: Clutter.Actor = this.menu?.actor, targets: Clutter.Actor[] = []) {
    if (!actor) return targets;
    return this._findAllTextActors(this.menu?.actor);
  }

  _findAllTextActors(actor: Clutter.Actor, foundActors: Clutter.Actor[] = []) {
    if (!actor) return foundActors;

    if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button || actor instanceof St.Icon) {
      if (actor.visible) {
        foundActors.push(actor);
      }
    }

    let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
    for (let i = 0; i < children.length; i++) {
      this._findAllTextActors(children[i], foundActors);
    }

    return foundActors;
  }

  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false, batchStart?: number) {
    if (!actor || typeof actor.set_style !== 'function') return;

    if (!this._styledActors.has(actor)) {
      let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
      this._styledActors.set(actor, origStyle || '');

      actor.connect('destroy', () => {
        adaptiveColorTweener.cancel(actor);
        this._styledActors.delete(actor);
      });
    }

    let isInsensitive = false;
    if (actor instanceof St.Button) {
      isInsensitive = (actor.reactive === false) || (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
    }

    if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
    actor._currentTargetColor = color;
    actor._currentInsensitiveState = isInsensitive;

    this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations, batchStart);
  }

  _clearAdaptiveStyles() {
    for (const [actor, originalStyle] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      if (actor && typeof actor.set_style === 'function') {
        adaptiveColorTweener.cancel(actor);
        actor._currentTargetColor = undefined;
        actor._currentInsensitiveState = undefined;
        try {
          actor.remove_style_class_name('adaptive-text-transition');
          actor.remove_style_class_name('adaptive-color-light');
          actor.remove_style_class_name('adaptive-color-dark');
          actor.set_style(originalStyle || null);
        } catch (e) { }
      }
    }
    this._styledActors.clear();
    this._backdropColored.clear();
    this._disconnectHoverWatchers();
  }

  _disconnectHoverWatchers(): void {
    this._pendingBackdropRoots.clear();
    if (this._backdropRefreshId !== 0) {
      if (global.compositor?.get_laters)
        global.compositor.get_laters().remove(this._backdropRefreshId);
      this._backdropRefreshId = 0;
    }

    for (const [actor, id] of this._hoverSignals.entries()) {
      try {
        if (isActorValid(actor)) actor.disconnect(id);
      } catch (e) { }
    }
    this._hoverSignals.clear();
  }

  _watchHoverFor(targets: Clutter.Actor[]): void {
    const restyled = new Set(targets);
    for (const target of targets) {
      const holder = (target as any).get_parent?.();
      if (!holder || restyled.has(holder)) continue;
      if (this._hoverSignals.has(holder) || typeof holder.connect !== 'function') continue;
      try {
        this._hoverSignals.set(holder, holder.connect('style-changed', () => {
          if (this._applyingColors) return;
          this._queueBackdropRefresh(holder);
        }));
      } catch (e) { }
    }

    for (const [actor, id] of [...this._hoverSignals.entries()]) {
      if (isActorValid(actor)) continue;
      this._hoverSignals.delete(actor);
      try { actor.disconnect(id); } catch (e) { }
    }
  }

  _queueBackdropRefresh(root: Clutter.Actor): void {
    if (!this._adaptiveConfig.enabled || !this._isEffectActive || this._actorDestroyed) return;

    this._pendingBackdropRoots.add(root);
    if (this._backdropRefreshId !== 0) return;

    this._backdropRefreshId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._backdropRefreshId = 0;
      const roots = [...this._pendingBackdropRoots];
      this._pendingBackdropRoots.clear();

      const targets: Clutter.Actor[] = [];
      for (const actor of roots) {
        if (isActorValid(actor)) this._findAllTextActors(actor, targets);
      }
      this._applyBackdropColorsTo(targets);
      return GLib.SOURCE_REMOVE;
    });
  }

  _applyBackdropColorsTo(targets: Clutter.Actor[]): void {
    if (!targets || targets.length === 0) return;

    const root = this.menu?.actor ?? null;
    const batchStart = GLib.get_monotonic_time();
    this._applyingColors = true;
    try {
      for (const actor of new Set(targets)) {
        const color = this._contrastSampler._backdropColorFor(actor, this._adaptiveConfig, root);
        if (color) {
          this._backdropColored.add(actor);
          this._setActorColor(actor as unknown as CustomBannerActor, color, true, batchStart);
        } else {
          this._backdropColored.delete(actor);
        }
      }
    } finally {
      this._applyingColors = false;
    }
  }

  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0)
      return;

    const batchStart = GLib.get_monotonic_time();
    this._applyingColors = true;
    try {
      for (const [actor, color] of colorMap.entries()) {
        if (this._backdropColored.has(actor)) continue;
        this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations, batchStart);
      }
    } finally {
      this._applyingColors = false;
    }
  }

  _startAdaptiveColorSampling(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled)
      return;

    if (skipAnimations) this._contrastSampler.invalidate();
    this._updateAdaptiveTextColors(skipAnimations);

    if (this._adaptiveTimerId !== 0)
      return;

    this._adaptiveTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._adaptiveConfig.sampleIntervalMs,
      () => {
        if (!this.menu?.isOpen) {
          this._adaptiveTimerId = 0;
          return GLib.SOURCE_REMOVE;
        }

        this._updateAdaptiveTextColors(false);
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  _stopAdaptiveColorSampling() {
    if (this._adaptiveTimerId !== 0) {
      GLib.source_remove(this._adaptiveTimerId);
      this._adaptiveTimerId = 0;
    }
  }

  _updateAdaptiveTextColors(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
      return;

    const targets = this._collectAdaptiveTextTargets();
    if (targets.length === 0)
      return;

    this._watchHoverFor(targets);

    this._adaptiveInFlight = true;

    this._contrastSampler
      .chooseColorsForActors(targets, this._adaptiveConfig, this.menu?.actor,
        () => this.effect?.paintCount ?? NaN)
      .then(colorMap => {
        if (!this._isEffectActive || this._actorDestroyed) return;
        this._applyAdaptiveColorMap(colorMap, skipAnimations);
      })
      .catch(e => {
        this._logger.error(`[Liquid Glass] Menu adaptive color update failed: ${e}`);
      })
      .finally(() => {
        this._adaptiveInFlight = false;
      });
  }

  _hexToRgb(hex: string) {
    let bigint = parseInt(hex.replace('#', ''), 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255
    };
  }

  _rgbToHex(r: number, g: number, b: number) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, isInsensitive: boolean,
    durationMs = 380, skipAnimations = false, batchStart?: number) {
    if (!actor || Object.keys(actor).length === 0) return;

    const originalStyle = (this._styledActors.get(actor) || '').trim();
    const stylePrefix = originalStyle ? `${originalStyle.replace(/;$/, '')}; ` : '';
    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color();

    let targetRgb = this._hexToRgb(targetHexColor);

    let targetAlpha = isInsensitive ? 0.5 : 1.0;
    let startAlpha = startColor.alpha / 255.0;

    const apply = (r: number, g: number, b: number, a: number) => {
      const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
      try { actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`); } catch (e) { }
    };

    if (skipAnimations) {
      adaptiveColorTweener.cancel(actor);
      apply(targetRgb.r, targetRgb.g, targetRgb.b, targetAlpha);
      return;
    }

    const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
    adaptiveColorTweener.add(actor, {
      startRgb, startAlpha,
      targetRgb, targetAlpha,
      crossFade: resolveCrossFade(startRgb, targetRgb),
      durationMs,
      apply,
    }, batchStart);
  }

  _startAnimation(targetValue: number) {
    if (this._tickId !== 0) {
      removeFrameTicker(this._tickId);
      this._tickId = 0;
    }
    if (!this._enableAnimation) {
      showMenuAtRest(this.bgActor, this.animActor);
      return;
    }

    if (this.animActor) this.animActor.remove_all_transitions();
    if (this.bgActor) this.bgActor.remove_all_transitions();

    if (this._swiftAnimation) {
      this._swiftSpringScale.updateParams(this._swiftResponse, this._swiftDampingFraction);
      this._swiftSpringPos.updateParams(this._swiftResponse, this._swiftDampingFraction);
      this._swiftSpringScale.target = targetValue;
      this._swiftSpringPos.target = targetValue;
      if (Number.isNaN(this._swiftSpringScale.value)) this._swiftSpringScale.value = 0;
      if (Number.isNaN(this._swiftSpringPos.value)) this._swiftSpringPos.value = 0;
    } else {
      this._springScale.target = targetValue;
      this._springPos.target = targetValue;
    }

    if (this._tickId === 0) {
      let lastTime = GLib.get_monotonic_time();

      this._tickId = addFrameTicker(() => {
        if (!this.bgActor || !this.targetActor) {
          this._tickId = 0;
          return GLib.SOURCE_REMOVE;
        }

        let currentTime = GLib.get_monotonic_time();
        let elapsedMs = (currentTime - lastTime) / 1000;
        lastTime = currentTime;

        const frame = stepMenuSprings(this._swiftAnimation ? this._swiftSpringScale : this._springScale,
          this._swiftAnimation ? this._swiftSpringPos : this._springPos, elapsedMs);
        if (frame.stopped) this._tickId = 0;
        applyMenuFrame(frame, this.animActor, this.bgActor, this.menu.actor, () => this._syncGeometry());
        return frame.stopped ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
      }, normalizeAnimationIntervalMs(this._animationInterval));
    }
  }

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    this._stopAdaptiveColorSampling();
    this._clearAdaptiveStyles();

    for (let sig of this._signals) {
      try {
        if (sig && sig.id) sig.target.disconnect(sig.id);
      } catch (e) { }
    }
    this._signals = [];

    if (this._tickId && this._tickId !== 0) {
      removeFrameTicker(this._tickId);
      this._tickId = 0;
    }

    if (this._frameSyncId !== 0) {
      if (global.compositor?.get_laters)
        global.compositor.get_laters().remove(this._frameSyncId);
      this._frameSyncId = 0;
    }

    if (this._interfaceSettings && this._accentColorSignalId) {
      this._interfaceSettings.disconnect(this._accentColorSignalId);
      this._accentColorSignalId = 0;
      this._interfaceSettings = null;
    }

    if (!this._actorDestroyed) this.targetActor.remove_style_class_name('liquid-glass-transparent');
    if (!this._actorDestroyed && this.animActor) {
      this.animActor.remove_style_class_name('liquid-glass-transparent');
      this.animActor.remove_style_class_name('liquid-glass-menu-root');

      this.animActor.translation_x = 0;
      this.animActor.translation_y = 0;
      this.animActor.set_scale(1.0, 1.0);
      this.animActor.opacity = 255;
    }
    if (this._dynamicCssFile) {
      const themeContext = St.ThemeContext.get_for_stage(global.stage);
      const theme = themeContext.get_theme();
      theme.unload_stylesheet(this._dynamicCssFile);
      this._dynamicCssFile = null;
    }

    if (!this._actorDestroyed) {
      this.targetActor.translation_y = 0;
      this.targetActor.set_scale(1.0, 1.0);
      this.targetActor.opacity = 255;
    }

    if (!this._actorDestroyed && this.menu.actor) {
      this.menu.actor.opacity = 255;

      if (this.menu.isOpen) {
        this.menu.close(false);
      }
    }

    if (this.effect) {
      this.effect.cleanup();
      this.effect = null;
    }

    if (this.bgActor) {
      this.bgActor.destroy();
      this.bgActor = null;
    }
    this.liquidBox = null;
    this._cloneContainer = null;
    this._menuRoot = null;

    this._uiSampler?.destroy();
    this._uiSampler = null;
    this._windowCloneManager?.destroy();
    this._windowCloneManager = null;

    this._stableBaseW = undefined;
    this._stableBaseH = undefined;
  }

  private _teardownStep(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this._logger?.error(`[Liquid Glass] ${this.constructor.name}.${name} failed during cleanup: ${e}`);
      } catch (_) {
        console.error(`[Liquid Glass] ${name} failed during cleanup: ${e}`);
      }
    }
  }

  cleanup() {
    this._torndown = true;

    this._teardownStep('heightMeasurement', () => this._cancelHeightMeasurement());

    this._teardownStep('frameSync', () => {
      if (this._frameSyncId !== 0) {
        if (global.compositor?.get_laters)
          global.compositor.get_laters().remove(this._frameSyncId);
        this._frameSyncId = 0;
      }
    });

    this._teardownStep('settingsSignals', () => {
      for (let sigId of this._settingsSignals) {
        try { this._settings.disconnect(sigId); } catch (e) { }
      }
      this._settingsSignals = [];
    });

    this._teardownStep('menuSignals', () => {
      if (this._animSignalId) {
        this.menu.disconnect(this._animSignalId);
        this._animSignalId = 0;
      }
      if (this._destroySignalId) {
        this.targetActor.disconnect(this._destroySignalId);
        this._destroySignalId = 0;
      }
      if (this._interfaceSettings && this._accentColorSignalId) {
        this._interfaceSettings.disconnect(this._accentColorSignalId);
        this._accentColorSignalId = 0;
        this._interfaceSettings = null;
      }
    });

    this._teardownStep('removeEffect', () => this._removeEffect());
  }
}
