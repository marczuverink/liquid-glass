import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated } from '../actors/allocation.js';
import { isActorValid } from '../actors/lifecycle.js';
import { hexToColorArray } from '../animation/colors.js';
import { AdaptiveTextColor } from '../adaptiveText.js';
import { sanitizeColorPreference } from '../contrastSampler.js';
import type { Logger } from '../logger.js';
import { verticalBoxParams } from '../shellVersion.js';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
// Room around a card for its shadow.
const SHADOW_MARGIN = 40;
// How far the pointer moves before a press becomes a drag, px.
const DRAG_THRESHOLD = 6;

export interface ItemEnv {
  path: string;
  settings: Gio.Settings;
  logger: Logger;
  // The item was dragged and dropped with its top left corner at (x, y).
  dropped: (item: DesktopItem, x: number, y: number) => void;
}

/** Something the desktop layer places, stacks and lets the user drag. */
export interface DesktopItem {
  readonly id: string;
  readonly actor: St.Widget;
  // Whether it has anything to show; a hidden item leaves its place in the stack.
  readonly shown: boolean;
  // [width, height] as placed.
  size(): [number, number];
  // Every frame. True when the size or `shown` changed, so the stack is laid out again.
  sync(): boolean;
  destroy(): void;
}

/**
 * Makes `actor` draggable: a press that moves further than a few pixels
 * drags it, anything else is a click.
 */
export function makeDraggable(actor: St.Widget, onDrop: (x: number, y: number) => void, onClick: () => void): void {
  let grab: any = null;
  let start: [number, number] | null = null;
  let origin: [number, number] = [0, 0];
  let dragging = false;
  const end = () => {
    grab?.dismiss();
    grab = null;
    start = null;
  };
  actor.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    start = event.get_coords() as [number, number];
    origin = [actor.x, actor.y];
    dragging = false;
    grab = global.stage.grab(actor);
    return Clutter.EVENT_STOP;
  });
  actor.connect('motion-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    if (!start) return Clutter.EVENT_PROPAGATE;
    const [x, y] = event.get_coords();
    const dx = x - start[0], dy = y - start[1];
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return Clutter.EVENT_STOP;
    dragging = true;
    actor.set_position(Math.round(origin[0] + dx), Math.round(origin[1] + dy));
    return Clutter.EVENT_STOP;
  });
  actor.connect('button-release-event', (_a: Clutter.Actor, event: Clutter.Event) => {
    if (!start || event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
    const wasDragging = dragging;
    end();
    if (wasDragging) onDrop(actor.x, actor.y);
    else onClick();
    return Clutter.EVENT_STOP;
  });
  // A grab lost to a modal dialog ends the drag where it is.
  actor.connect('destroy', end);
}

/**
 * A desktop widget: content on a rounded card of glass. Subclasses fill
 * `box` and may hide the card (`shown`) when they have nothing to show.
 */
export abstract class GlassCard implements DesktopItem {
  readonly actor: St.Widget;
  protected readonly box: St.BoxLayout;
  protected readonly glass: BackdropGlass;
  protected env: ItemEnv;
  private _settingsIds: number[] = [];
  private _lastSize = '';
  private _lastShown = false;
  private _text: AdaptiveTextColor;
  shown = true;

  constructor(readonly id: string, env: ItemEnv, width: number) {
    this.env = env;
    this.actor = new St.Widget({ name: `liquid-glass-desktop-${id}`, reactive: true, track_hover: true });
    this.glass = new BackdropGlass({
      extensionPath: env.path, settings: env.settings, logger: env.logger, owner: `desktop-${id}`,
    } as any);
    this.glass.setPadding(SHADER_PADDING);
    this.glass.setIsDock(false);
    this.glass.setShadowMaxRadius(SHADOW_MARGIN - 8);
    this.actor.add_child(this.glass);
    this.box = new St.BoxLayout({ style_class: 'liquid-glass-desktop-card', width, ...verticalBoxParams() } as any);
    this.actor.add_child(this.box);
    makeDraggable(this.actor, (x, y) => env.dropped(this, x, y), () => this.activate());

    this._text = new AdaptiveTextColor(() => [this.box], () => [this.glass], env.logger, `desktop ${id}`);
    const watch = (key: string, fn: () => void) =>
      this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
      watch(`desktop-widget-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`desktop-widget-${key}`, () => this._syncText());
    this._applyMaterial();
    this._syncText();
  }

  // A click on the card.
  protected activate(): void {
  }

  private _applyMaterial(): void {
    const s = this.env.settings;
    const g = this.glass;
    g.setTintColor(...hexToColorArray(s.get_string('desktop-widget-tint-color')));
    g.setTintStrength(s.get_double('desktop-widget-tint-strength'));
    g.setBlurRadius(s.get_int('desktop-widget-blur-radius'));
    g.setCornerRadius(s.get_double('desktop-widget-corner-radius'));
    g.setBrightness(s.get_double('desktop-widget-brightness'));
    g.setContrast(s.get_double('desktop-widget-contrast'));
    g.setSaturation(s.get_double('desktop-widget-saturation'));
    this.box.set_style(`border-radius: ${s.get_double('desktop-widget-corner-radius')}px;`);
  }

  private _syncText(): void {
    const s = this.env.settings;
    if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
      this._text.clear();
      return;
    }
    this._text.start(s.get_int('desktop-widget-sample-interval-ms'),
      sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')));
  }

  // The content changed; measure the text colour again.
  protected contentChanged(): void {
    this._text.invalidate();
  }

  size(): [number, number] {
    const [, natW] = this.box.get_preferred_width(-1);
    const [, natH] = this.box.get_preferred_height(natW);
    return [Math.ceil(Math.max(natW, this.box.width)), Math.ceil(natH)];
  }

  sync(): boolean {
    const shown = this.shown;
    this.actor.visible = shown;
    const [w, h] = this.size();
    const key = `${w}x${h}`;
    const changed = key !== this._lastSize || shown !== this._lastShown;
    this._lastShown = shown;
    if (key !== this._lastSize) {
      this._lastSize = key;
      const m = SHADOW_MARGIN;
      const p = SHADER_PADDING;
      this.glass.set_position(-m, -m);
      this.glass.set_size(w + m * 2, h + m * 2);
      this.glass.setResolution(w + m * 2, h + m * 2);
      this.glass.setGlassGeometry(m - p, m - p, w + p * 2, h + p * 2);
      this.actor.set_size(w, h);
      this._text.invalidate();
    }
    if (shown && this.actor.mapped) {
      ensureGlassAllocated(this.glass);
      this.glass.syncSources();
    }
    return changed;
  }

  destroy(): void {
    for (const id of this._settingsIds) this.env.settings.disconnect(id);
    this._settingsIds = [];
    this._text.clear();
    this.glass.cleanup();
    if (isActorValid(this.actor)) this.actor.destroy();
  }
}
