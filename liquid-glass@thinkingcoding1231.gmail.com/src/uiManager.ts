import { stepMenuSpring, applyMenuFrame, showMenuAtRest } from './animation/menuSpring.js';
import { addFrameTicker, removeFrameTicker, normalizeAnimationIntervalMs } from './animation/frameTicker.js';
import { Spring, SwiftSpring } from './animation/spring.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig, sanitizeColorPreference } from './contrastSampler.js';
import { UnpickableActor, UnpickableWidget } from './actors/unpickable.js';
import { UILayerSampler } from './capture/uiLayerSampler.js';
import { WindowCloneManager } from './capture/windowClones.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { resolveMonitorGeometry, getAllocatedSize } from './actors/geometry.js';
import { isActorValid } from './actors/lifecycle.js';
import { startLaterLoop, stopLaterLoop } from './animation/frameLoops.js';
import { excludeOtherGlass } from './capture/glassExclusions.js';
import { placeScreenGlass, resolveGlassOrigin, applyGlassScale, GLASS_SHADOW_MAX_RADIUS } from './actors/glassBounds.js';
import { syncGlassCaptureClip } from './capture/clip.js';
import { resolveCrossFade, adaptiveColorTweener, hexToColorArray, hexToRgb, rgbToHex } from './animation/colors.js';

import { Logger } from './logger.js';

// Room around the glass rect for the shader's edge effects.
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
const MENU_MEASURE_STABLE_FRAMES = 3;

// Quick Settings' open height, measured once for every menu that matches it,
// and the callbacks waiting for a measurement in progress.
let _quickSettingsHeight = 0;
let _quickSettingsWaiting: ((height: number) => void)[] | null = null;

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
  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }
  private _glassExpand: number;
  private _menuXoffset: number;
  private _menuYoffset: number;
  private _menuScale: number = 1.0;
  private _ownsAccentCss: boolean = true;
  private _matchQuickSettingsHeight: boolean = false;
  private _settledHeightScale: number | null = null;
  private _measuringHeights: boolean = false;
  private _ownOpenHeight: number = 0;
  private _measureLaterIds: Set<number> = new Set();
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
  private _springStiffness: number;
  private _springDamping: number;
  private _springMass: number;

  // The alternative SwiftUI-style spring; not exposed in the preferences.
  private _swiftAnimation: boolean = false;
  private _swiftResponse: number = 0.3;
  private _swiftDampingFraction: number = 0.65;

  private _swiftSpringScale: SwiftSpring;

  private _enableAnimation: boolean;

  private _interfaceSettings: Gio.Settings | null = null;
  private _accentColorSignalId: number = 0;
  private _accentColorTimeoutId: number = 0;

  private _dynamicCssFile: Gio.File | null = null;
  private _cornerRadius: number = 0;

  private _animationInterval: number = 16;
  private _uiSampler: UILayerSampler | null = null;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  // The menu's ancestor that is a direct child of uiGroup; see _restackGlass().
  private _menuRoot: Clutter.Actor | null = null;

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger,
              panelButton: any = Main.panel.statusArea.dateMenu, ownsAccentCss: boolean = true,
              private _enableKey: string = 'enable-menu-glass',
              // Settings prefix: `menu` for the calendar, `panel-menu` for the
              // other panel menus (see PanelMenuManager).
              private _keyPrefix: string = 'menu',
              // Names this glass in logs, dumps and actor names.
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
    this._springStiffness = 120;
    this._springDamping = 8;
    this._springMass = 1.0;

    this._swiftSpringScale = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);

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

    this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    // The theme context picks up the new accent colour a moment later.
    this._accentColorSignalId = this._interfaceSettings.connect('changed::accent-color', () => {
      if (this._accentColorTimeoutId)
        GLib.Source.remove(this._accentColorTimeoutId);
      this._accentColorTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        this._accentColorTimeoutId = 0;
        this._applySystemAccentColor();
        return GLib.SOURCE_REMOVE;
      });
    });

    this._applySystemAccentColor();

    if (this._settings.get_boolean(this._enableKey)) {
      this._applyEffect();
    }
  }

  /**
   * The accent colour and its foreground as [background, foreground] hex.
   * Asked of St rather than read off a themed dummy widget, because themes
   * such as MacTahoe only paint today's date in the accent while selected.
   * The dummy (marked :selected) remains the fallback when St has no accent.
   */
  private _resolveAccentColors(): [string, string] {
    const [accent, accentFg] = St.ThemeContext.get_for_stage(global.stage).get_accent_color();
    if (accent && accentFg)
      return [rgbToHex(accent.red, accent.green, accent.blue),
        rgbToHex(accentFg.red, accentFg.green, accentFg.blue)];

    // The theme's selectors need the calendar ancestry.
    const parent = new UnpickableWidget({ style_class: 'calendar' });
    const child = new UnpickableWidget({ style_class: 'calendar-day calendar-today' });
    child.add_style_pseudo_class('selected');
    parent.add_child(child);

    Main.layoutManager.uiGroup.add_child(parent);
    child.ensure_style();
    const bgColor = child.get_theme_node().get_background_color();
    Main.layoutManager.uiGroup.remove_child(parent);
    parent.destroy();

    return [rgbToHex(bgColor.red, bgColor.green, bgColor.blue), '#ffffff'];
  }

  private _applySystemAccentColor() {
    if (!this._ownsAccentCss || !this.targetActor) return;

    const [colorStr, fgStr] = this._resolveAccentColors();

    // St loads stylesheets only from files, so the rule goes through the cache
    // directory.
    const cssContent = `
      .liquid-glass-menu-root .calendar-today,
      .liquid-glass-menu-root .calendar-today:hover,
      .liquid-glass-menu-root .calendar-today:active,
      .liquid-glass-menu-root .calendar-today:checked,
      .liquid-glass-menu-root .calendar-today:selected,
      .liquid-glass-menu-root .calendar-today:focus {
        background-color: ${colorStr} !important;
        color: ${fgStr} !important;
      }
    `;

    // Writing the file and parsing the stylesheet both throw a GError on failure.
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

  _allocatedHeightOf(actor: any): number {
    if (!actor || !isActorValid(actor) || !actor.has_allocation())
      return 0;
    const [, allocated] = getAllocatedSize(actor);
    return allocated > 1 ? allocated : 0;
  }

  _firstHeight(actors: any[], measure: (actor: any) => number): number {
    for (const actor of actors) {
      const height = measure(actor);
      if (height > 0)
        return height;
    }
    return 0;
  }

  // Measures a menu's height once it has stopped changing for a few frames
  // (it grows while its content lays out), within MENU_MEASURE_FRAMES.
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
      const height = this._firstHeight([actor, menu.box], a => this._allocatedHeightOf(a));

      repeats = height > 0 && height === tallest ? repeats + 1 : 0;
      if (height > tallest) tallest = height;

      if (repeats < MENU_MEASURE_STABLE_FRAMES && --framesLeft > 0)
        this._addMeasureLater(tick);
      else
        done(tallest);
    };

    this._addMeasureLater(tick);
  }

  _addMeasureLater(callback: () => void): void {
    const id = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._measureLaterIds.delete(id);
      callback();
      return GLib.SOURCE_REMOVE;
    });
    this._measureLaterIds.add(id);
  }

  _cancelHeightMeasurement(): void {
    for (const id of this._measureLaterIds)
      global.compositor.get_laters().remove(id);
    this._measureLaterIds.clear();

    // This menu was measuring Quick Settings: close it again, and drop the
    // waiting callbacks, which would otherwise never be called.
    const restore = this._restoreQuickSettings;
    this._restoreQuickSettings = null;
    if (restore) {
      restore();
      _quickSettingsWaiting = null;
    }
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

    // Opened invisibly, measured, and closed again.
    const opacity = actor.opacity;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      menu.close(0);
      actor.opacity = opacity;
    };

    menu.open(0);
    actor.opacity = 0;

    this._restoreQuickSettings = restore;
    this._settleHeight(menu, height => {
      this._restoreQuickSettings = null;
      restore();
      settle(height);
    });
  }

  _measureHeightScale(): void {
    if (!this.menu) return;

    _quickSettingsHeight = 0;
    this._ownOpenHeight = 0;
    this._withQuickSettingsHeight(() => this._rememberRatioWhenBothKnown());
  }

  _noteOwnOpenedHeight(): void {
    if (!this._matchQuickSettingsHeight) return;
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

    this._settings.set_double(this._key('settled-height-scale'), ratio);
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

  /**
   * Keeps the glass directly beneath the menu it backs, as the other surfaces
   * do; placed anywhere lower, a dock between the two would cover the glass
   * but not the menu. Re-asserted on every open, because other extensions
   * and dock rebuilds change uiGroup's order.
   */
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

  // A key in this instance's settings namespace; see _keyPrefix.
  private _key(suffix: string): string {
    return `${this._keyPrefix}-${suffix}`;
  }

  // The animation switch is named `enable-<prefix>-animation`.
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
        let colorArray = hexToColorArray(this._settings.get_string(this._key('tint-color')));
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

    connectSetting(this._key('adaptive-text-preference'), () => {
      this._adaptiveConfig.preference = sanitizeColorPreference(
        this._settings.get_string(this._key('adaptive-text-preference')));
    });
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    if (!this.targetActor) return;

    // The menu's own background is made transparent over the glass.
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
      preference: sanitizeColorPreference(
        this._settings.get_string(this._key('adaptive-text-preference'))),
    };

    // Sized to the monitor by _syncGeometry().
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

    // The menu scales from its top centre; the glass follows it by geometry.
    this.animActor.set_pivot_point(0.5, 0.0);
    this.bgActor.set_pivot_point(0.0, 0.0);

    let menuRoot: Clutter.Actor = this.menu.actor;
    while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
      const p = menuRoot.get_parent();
      if (!p) break;
      menuRoot = p;
    }

    // Below the menu, so the glass does not clone itself or the menu.
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
    this.effect.setTintColor(...hexToColorArray(tintColorStr));
    this.effect.setTintStrength(tintStrength);
    this.effect.setCornerRadius(this._cornerRadius);
    this.effect.setIsDock(false);
    this.effect.setBrightness(brightness);
    this.effect.setContrast(contrast);
    this.effect.setSaturation(saturation);
    this.effect.setBlurRadius(blurRadius);
    this.liquidBox.add_effect(this.effect);

    this.bgActor.hide();

    // Runs every frame while the menu is shown, with fresh clones.
    const startFrameSync = () => {
      if (this._frameSyncId !== 0) return;
      this._buildClones();
      startLaterLoop(this._frameSlot, {
        alive: () => !!this.bgActor && this.targetActor.mapped,
        honourFreeze: true,
        errorTag: 'UIManager',
        step: () => {
          // Checked before this frame's sync dirties anything.
          ensureGlassAllocated(this.bgActor);
          this._syncGeometry();
        },
      });
    };
    const stopFrameSync = () => stopLaterLoop(this._frameSlot);

    // The cached size is dropped on every open; the content may have changed.
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

  _buildClones() {
    if (!this.bgActor) return;
    excludeOtherGlass(this._uiSampler, this.bgActor);
    // Before the clones, so this frame's capture already sees the final order.
    this._restackGlass();
    this._windowCloneManager?.rebuildClones();
    this._uiSampler?.rebindSelf();
    this._uiSampler?.refresh();
  }

  _syncGeometry() {
    if (!this._syncBgVisibility()) return;
    const { w, h, scaleX, scaleY } = this._measureMenu();
    const [animAbsX, animAbsY] = this._resolveMenuOrigin(w);

    let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
    let bgY = animAbsY - this._glassExpand - SHADER_PADDING;

    let monitor = this._getMenuMonitorGeometry();
    let monitorX = monitor?.x ?? 0;
    let monitorY = monitor?.y ?? 0;
    let screenW = Math.max(1, monitor?.width ?? 1);
    let screenH = Math.max(1, monitor?.height ?? 1);

    if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0)
      this._applyGlassBounds(this.bgActor!, bgX, bgY, bgW, bgH, monitorX, monitorY, screenW, screenH);

    this._applyGlassScale(scaleX, scaleY);
    this._syncCaptureLayers(monitorX, monitorY, screenW, screenH);
  }

  private _syncBgVisibility(): boolean {
    if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
      if (this.bgActor && this.bgActor.visible) {
        this.bgActor.hide();
      }
      return false;
    }
    if (!this.bgActor.visible) {
      this.bgActor.show();
    }
    if (!this._enableAnimation) {
      this.bgActor.opacity = this.targetActor.opacity;
    }
    return true;
  }

  private _measureMenu(): { w: number, h: number, scaleX: number, scaleY: number } {
    // The allocation: a hover restyle leaves a relayout pending, during
    // which get_size() reports the preferred size including CSS margins.
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

    return {
      w: Math.max(1, this._stableBaseW * scaleX),
      h: Math.max(1, this._stableBaseH * scaleY),
      scaleX,
      scaleY,
    };
  }

  private _resolveMenuOrigin(w: number): [number, number] {
    return resolveGlassOrigin(this.animActor, this as any, () => {
      const monitor = Main.layoutManager.primaryMonitor;
      if (!monitor) return [0, 0];
      return [(monitor.width / 2) - (w / 2) + this._menuXoffset, (Main.panel.height || 27) + this._menuYoffset];
    });
  }

  private _applyGlassBounds(bgActor: Clutter.Actor, bgX: number, bgY: number, bgW: number, bgH: number,
    monitorX: number, monitorY: number, screenW: number, screenH: number) {
    if (this._lastBgW === bgW && this._lastBgH === bgH &&
      this._lastBgX === bgX && this._lastBgY === bgY &&
      this._lastScreenW === screenW && this._lastScreenH === screenH) return;

    // Monitor-local, as the shader uses them.
    let localBgX = bgX - monitorX;
    let localBgY = bgY - monitorY;
    placeScreenGlass(bgActor, this.liquidBox, monitorX, monitorY, screenW, screenH,
      { x: localBgX, y: localBgY, w: bgW, h: bgH }, false);

    this.effect?.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
    this.effect?.setResolution(screenW, screenH);
    this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

    this._lastBgW = bgW; this._lastBgH = bgH;
    this._lastBgX = bgX; this._lastBgY = bgY;
    this._lastScreenW = screenW; this._lastScreenH = screenH;
  }

  private _applyGlassScale(scaleX: number, scaleY: number) {
    applyGlassScale(this.effect, this._cornerRadius, scaleX, scaleY);
  }

  private _syncCaptureLayers(monitorX: number, monitorY: number, screenW: number, screenH: number) {
    this._windowCloneManager?.setOffset(-monitorX, -monitorY);
    this._uiSampler?.refresh();

    // After setGlassGeometry() and before the samplers sync (see capture/clip.ts).
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

    for (const child of actor.get_children())
      this._findAllTextActors(child, foundActors);

    return foundActors;
  }

  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false, batchStart?: number) {
    // Clutter.Text targets have no St style.
    if (!(actor instanceof St.Widget)) return;

    if (!this._styledActors.has(actor)) {
      this._styledActors.set(actor, actor.get_style() || '');

      actor.connect('destroy', () => {
        adaptiveColorTweener.cancel(actor);
        this._styledActors.delete(actor);
      });
    }

    let isInsensitive = false;
    if (actor instanceof St.Button) {
      isInsensitive = !actor.reactive || actor.has_style_pseudo_class('insensitive');
    }

    if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
    actor._currentTargetColor = color;
    actor._currentInsensitiveState = isInsensitive;

    this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations, batchStart);
  }

  _clearAdaptiveStyles() {
    for (const [actor, originalStyle] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      adaptiveColorTweener.cancel(actor);
      actor._currentTargetColor = undefined;
      actor._currentInsensitiveState = undefined;
      actor.set_style(originalStyle || null);
    }
    this._styledActors.clear();
    this._backdropColored.clear();
    this._disconnectHoverWatchers();
  }

  _disconnectHoverWatchers(): void {
    this._pendingBackdropRoots.clear();
    if (this._backdropRefreshId !== 0) {
      global.compositor.get_laters().remove(this._backdropRefreshId);
      this._backdropRefreshId = 0;
    }

    for (const [actor, id] of this._hoverSignals.entries()) {
      if (isActorValid(actor)) actor.disconnect(id);
    }
    this._hoverSignals.clear();
  }

  // A hovered row restyles its parent (the highlight); watching that lets the
  // text colours follow the highlight instead of the glass behind it.
  _watchHoverFor(targets: Clutter.Actor[]): void {
    const restyled = new Set(targets);
    for (const target of targets) {
      const holder = target.get_parent();
      if (!holder || restyled.has(holder) || this._hoverSignals.has(holder)) continue;
      // Only St widgets emit style-changed.
      if (!(holder instanceof St.Widget)) continue;
      this._hoverSignals.set(holder, holder.connect('style-changed', () => {
        if (this._applyingColors) return;
        this._queueBackdropRefresh(holder);
      }));
    }

    // Forget holders that have been destroyed; their handlers went with them.
    for (const actor of [...this._hoverSignals.keys()]) {
      if (!isActorValid(actor))
        this._hoverSignals.delete(actor);
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
    // Our own restyles emit style-changed too; see _watchHoverFor().
    this._applyingColors = true;
    for (const actor of new Set(targets)) {
      const color = this._contrastSampler._backdropColorFor(actor, this._adaptiveConfig, root);
      if (color) {
        this._backdropColored.add(actor);
        this._setActorColor(actor as unknown as CustomBannerActor, color, true, batchStart);
      } else {
        this._backdropColored.delete(actor);
      }
    }
    this._applyingColors = false;
  }

  // Iterates through the color map and applies the new target colors to the respective actors
  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0)
      return;

    // One timestamp for the whole map, so a row of labels flips together.
    const batchStart = GLib.get_monotonic_time();
    this._applyingColors = true;
    for (const [actor, color] of colorMap.entries()) {
      if (this._backdropColored.has(actor)) continue;
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations, batchStart);
    }
    this._applyingColors = false;
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

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, isInsensitive: boolean,
    durationMs = 380, skipAnimations = false, batchStart?: number) {
    // An existing tween is not cancelled: add() restarts from the colour it
    // last applied.
    const originalStyle = (this._styledActors.get(actor) || '').trim();
    const stylePrefix = originalStyle ? `${originalStyle.replace(/;$/, '')}; ` : '';
    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color();

    let targetRgb = hexToRgb(targetHexColor);

    // Insensitive items keep their dimmed look.
    let targetAlpha = isInsensitive ? 0.5 : 1.0;
    let startAlpha = startColor.alpha / 255.0;

    const apply = (r: number, g: number, b: number, a: number) => {
      const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
      actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
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

  // The spring open/close animation.
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
      this._swiftSpringScale.target = targetValue;
      if (Number.isNaN(this._swiftSpringScale.value)) this._swiftSpringScale.value = 0;
    } else {
      this._springScale.target = targetValue;
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

        const frame = stepMenuSpring(this._swiftAnimation ? this._swiftSpringScale : this._springScale, elapsedMs);
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
    this._disconnectEffectSources();
    this._restoreMenuActors();
    this._releaseGlass();
  }

  private _disconnectEffectSources() {
    for (let sig of this._signals)
      sig.target.disconnect(sig.id);
    this._signals = [];

    if (this._tickId) {
      removeFrameTicker(this._tickId);
      this._tickId = 0;
    }

    stopLaterLoop(this._frameSlot);
    this._disconnectAccentColor();
  }

  private _disconnectAccentColor() {
    if (this._accentColorTimeoutId) {
      GLib.Source.remove(this._accentColorTimeoutId);
      this._accentColorTimeoutId = 0;
    }
    if (this._interfaceSettings && this._accentColorSignalId) {
      this._interfaceSettings.disconnect(this._accentColorSignalId);
      this._accentColorSignalId = 0;
      this._interfaceSettings = null;
    }
  }

  private _restoreMenuActors() {
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
  }

  private _releaseGlass() {
    // The effect is cleaned up before its actor is destroyed.
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

  cleanup() {
    this._cancelHeightMeasurement();
    stopLaterLoop(this._frameSlot);

    for (let sigId of this._settingsSignals)
      this._settings.disconnect(sigId);
    this._settingsSignals = [];

    // These exist even while the effect is off.
    if (this._animSignalId) {
      this.menu.disconnect(this._animSignalId);
      this._animSignalId = 0;
    }
    if (this._destroySignalId) {
      this.targetActor.disconnect(this._destroySignalId);
      this._destroySignalId = 0;
    }
    this._disconnectAccentColor();

    this._removeEffect();
  }
}
