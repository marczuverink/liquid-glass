import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import { BackdropGlass } from './rendering/backdropGlass.js';
import type { GlassRegion } from './rendering/glassRenderer.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isActorValid } from './actors/lifecycle.js';
import { startSyncLoop, stopStageLoop } from './animation/frameLoops.js';
import { hexToColorArray } from './animation/colors.js';
import { sanitizeColorPreference } from './contrastSampler.js';
import { AdaptiveTextColor } from './adaptiveText.js';
import type { Logger } from './logger.js';

export type TopBarStyle = 'off' | 'pill' | 'islands';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
// Room below the bar for the single pill's shadow.
const SHADOW_ROOM = 48;
// The pills sit this far inside the bar's height, px.
const INSET_Y = 3;
// Room on either side of an island's buttons, px.
const ISLAND_PAD_X = 4;

function sanitizeStyle(value: string): TopBarStyle {
  return value === 'pill' || value === 'islands' ? value : 'off';
}

/**
 * Glass for the top bar itself: one pill across it, or an island behind each
 * of its three groups of buttons (activities, clock, status). The bar's own
 * background is cleared while either is on.
 */
export class TopBarManager {
  private _style: TopBarStyle = 'off';
  private _glass: BackdropGlass | null = null;
  private _settingsIds: number[] = [];
  private _frameSyncId = 0;
  private _frameSignalId = 0;
  private _lastKey = '';
  private _text: AdaptiveTextColor;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger) {
    this._text = new AdaptiveTextColor(() => this._textRoots(), () => (this._glass ? [this._glass] : []),
      _logger, 'top bar');
  }

  setup(): void {
    const watch = (key: string, fn: () => void) =>
      this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
    watch('top-bar-style', () => this._apply());
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
      watch(`top-bar-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`top-bar-${key}`, () => this._syncText());
    this._apply();
  }

  private _key(suffix: string): string {
    return `top-bar-${suffix}`;
  }

  private _apply(): void {
    const style = sanitizeStyle(this._settings.get_string('top-bar-style'));
    if (style === this._style) return;
    this._remove();
    this._style = style;
    if (style !== 'off') this._create();
  }

  private _create(): void {
    const panel = Main.panel as any;
    const panelBox = Main.layoutManager.panelBox;
    panel.add_style_class_name('liquid-glass-transparent');

    const glass = new BackdropGlass({
      extensionPath: this._path, settings: this._settings, logger: this._logger, owner: 'top-bar',
    } as any);
    this._glass = glass;
    glass.setPadding(SHADER_PADDING);
    glass.setIsDock(false);
    glass.setMultiRegionMode(this._style === 'islands');
    glass.setShadowMaxRadius(SHADOW_ROOM - 8);
    // Below the bar, so the glass reads the stage before the bar is drawn.
    Main.layoutManager.uiGroup.insert_child_below(glass, panelBox);
    this._applyMaterial();
    this._lastKey = '';

    startSyncLoop(this._frameSignalSlot, this._frameSlot, {
      alive: () => !!this._glass,
      honourFreeze: true,
      errorTag: 'TopBarManager',
      step: () => {
        ensureGlassAllocated(this._glass);
        this._sync();
      },
    });
    this._syncText();
  }

  private _applyMaterial(): void {
    const glass = this._glass;
    if (!glass) return;
    glass.setTintColor(...hexToColorArray(this._settings.get_string(this._key('tint-color'))));
    glass.setTintStrength(this._settings.get_double(this._key('tint-strength')));
    glass.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
    glass.setCornerRadius(this._settings.get_double(this._key('corner-radius')));
    glass.setBrightness(this._settings.get_double(this._key('brightness')));
    glass.setContrast(this._settings.get_double(this._key('contrast')));
    glass.setSaturation(this._settings.get_double(this._key('saturation')));
  }

  private _syncText(): void {
    if (!this._glass || !this._settings.get_boolean(this._key('enable-adaptive-text-color'))) {
      this._text.clear();
      return;
    }
    this._text.start(this._settings.get_int(this._key('sample-interval-ms')),
      sanitizeColorPreference(this._settings.get_string(this._key('adaptive-text-preference'))));
  }

  private _textRoots(): Clutter.Actor[] {
    const panel = Main.panel as any;
    return [panel._leftBox, panel._centerBox, panel._rightBox].filter(box => box && box.mapped);
  }

  // The visible buttons of one of the bar's boxes, [x0, x1] in bar coordinates.
  private _boxExtent(box: Clutter.Actor): number[] | null {
    let x0 = Infinity, x1 = -Infinity;
    const [bx] = box.get_position();
    for (const child of box.get_children()) {
      if (!child.visible || child.width < 1) continue;
      const alloc = child.get_allocation_box();
      x0 = Math.min(x0, bx + alloc.x1);
      x1 = Math.max(x1, bx + alloc.x2);
    }
    return x1 > x0 ? [x0, x1] : null;
  }

  // Every frame: places the glass under the bar, or hides it with the bar.
  private _sync(): void {
    const glass = this._glass!;
    const panelBox = Main.layoutManager.panelBox;
    const panel = Main.panel as any;
    const shown = panelBox.visible && panelBox.mapped && panel.mapped;
    if (!shown) {
      if (glass.visible) glass.hide();
      return;
    }
    if (!glass.visible) glass.show();
    glass.opacity = Math.round(panelBox.opacity * panel.opacity / 255);

    const [x, y] = panelBox.get_transformed_position();
    const width = Math.round(panelBox.width);
    const height = Math.round(panel.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || width < 1 || height < 1) return;

    const inset = Math.min(INSET_Y, height / 4);
    const rects: number[][] = [];
    if (this._style === 'pill') {
      rects.push([inset * 2, inset, width - inset * 4, height - inset * 2]);
    } else {
      for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
        const extent = box ? this._boxExtent(box) : null;
        if (extent)
          rects.push([extent[0] - ISLAND_PAD_X, inset, extent[1] - extent[0] + ISLAND_PAD_X * 2, height - inset * 2]);
      }
    }

    const key = `${x},${y},${width},${height},${rects.flat().join(',')}`;
    if (key !== this._lastKey) {
      this._lastKey = key;
      glass.set_position(x, y);
      glass.set_size(width, height + SHADOW_ROOM);
      glass.setResolution(width, height + SHADOW_ROOM);
      const p = SHADER_PADDING;
      if (this._style === 'pill') {
        const [rx, ry, rw, rh] = rects[0];
        glass.setGlassGeometry(rx - p, ry - p, rw + p * 2, rh + p * 2);
      } else {
        const regions: GlassRegion[] = rects.map(([rx, ry, rw, rh]) => ({
          x: rx - p, y: ry - p, w: rw + p * 2, h: rh + p * 2, tintR: 1, tintG: 1, tintB: 1,
        }));
        glass.setGlassRegions(regions);
        glass.setGlassGeometry(0, 0, width, height);
      }
      this._text.invalidate();
    }
    glass.syncSources();
  }

  private _remove(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    this._text.clear();
    const glass = this._glass;
    this._glass = null;
    if (glass) {
      glass.cleanup();
      // At shell shutdown the stage may have destroyed it already.
      if (isActorValid(glass)) glass.destroy();
      (Main.panel as any).remove_style_class_name('liquid-glass-transparent');
    }
    this._style = 'off';
  }

  cleanup(): void {
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    this._remove();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}
