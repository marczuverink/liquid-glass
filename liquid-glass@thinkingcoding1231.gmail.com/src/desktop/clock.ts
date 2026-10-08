import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated } from '../actors/allocation.js';
import { isActorValid } from '../actors/lifecycle.js';
import { hexToColorArray } from '../animation/colors.js';
import { AdaptiveTextColor } from '../adaptiveText.js';
import { sanitizeColorPreference } from '../contrastSampler.js';
import { connectClicks, type DesktopItem, type ItemEnv } from './desktopItem.js';
import { GlyphFields, fieldTexture, maxDepth, softened } from './glassText.js';

// How far (px) the distance field reaches past the outline: room for the
// drop shadow, whose reach stays a little inside it.
const FIELD_RANGE = 48;
const SHADOW_REACH = 40;
// The lens rises over at most this much of a stroke (px), as on any glass.
const MAX_BAND = 22;
// The lens follows the outline softened by this fraction of its band, so its
// slope turns smoothly in a corner instead of folding along the corner's
// bisector.
const LENS_SOFTNESS = 0.35;
// Font changes are applied once the preferences stop changing them.
const FONT_DELAY_MS = 300;
// The date sits this far (px) above the glass digits' outline.
const DATE_GAP = 6;

const SIZE_KEYS = ['glass-clock-size', 'glass-clock-stretch', 'glass-clock-height'];

// The [min, max] the schema allows for a number key.
function keyRange(settings: Gio.Settings, key: string): [number, number] {
  const [, range] = settings.settings_schema.get_key(key).get_range().recursiveUnpack() as [string, [number, number]];
  return range;
}

function clamp(value: number, [min, max]: [number, number]): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A large clock whose digits are glass, like the clock on the iPhone's lock
 * screen, with the date above it.
 */
export class GlassClock implements DesktopItem {
  readonly id = 'clock';
  readonly actor: St.Widget;
  readonly shown = true;
  private _env: ItemEnv;
  private _glass: BackdropGlass;
  private _date: St.Label;
  private _glyphs: GlyphFields | null = null;
  private _text = '';
  private _font = '';
  private _fieldSize: [number, number] = [1, 1];
  private _size: [number, number] = [1, 1];
  private _bounds: [number, number, number, number] = [0, 0, 1, 1];
  private _sizeChanged = true;
  private _timerId = 0;
  private _fontTimerId = 0;
  private _settingsIds: number[] = [];
  private _interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
  private _interfaceIds: number[] = [];
  private _adaptive: AdaptiveTextColor;

  constructor(env: ItemEnv) {
    this._env = env;
    this.actor = new St.Widget({ name: 'liquid-glass-desktop-clock', reactive: true });
    this._glass = new BackdropGlass({
      extensionPath: env.path, settings: env.settings, logger: env.logger, owner: 'desktop-clock', shapeTexture: true,
    } as any);
    this._glass.setPadding(0);
    this._glass.setIsDock(false);
    this._glass.setShadowMaxRadius(SHADOW_REACH);
    this._date = new St.Label({ style_class: 'liquid-glass-clock-date' });
    this.actor.add_child(this._glass);
    this.actor.add_child(this._date);
    connectClicks(this.actor, () => {}, (x, y) => env.menu(this, x, y));

    this._adaptive = new AdaptiveTextColor(() => [this._date], () => [this._glass], env.logger, 'clock');
    const watch = (key: string, fn: () => void) => this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
    for (const key of ['glass-clock-font', 'glass-clock-size', 'glass-clock-stretch', 'glass-clock-height'])
      watch(key, () => this._queueFont());
    watch('glass-clock-format', () => this._tick());
    watch('glass-clock-show-date', () => this._tick());
    for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'brightness', 'contrast', 'saturation'])
      watch(`glass-clock-${key}`, () => this._applyMaterial());
    for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
      watch(`desktop-widget-${key}`, () => this._syncAdaptive());
    this._interfaceIds.push(this._interfaceSettings.connect('changed::clock-format', () => this._tick()));
    this._interfaceIds.push(this._interfaceSettings.connect('changed::font-name', () => this._queueFont()));

    this._applyMaterial();
    this._syncAdaptive();
    this._loadFont();
  }

  private _applyMaterial(): void {
    const s = this._env.settings;
    const g = this._glass;
    g.setTintColor(...hexToColorArray(s.get_string('glass-clock-tint-color')));
    g.setTintStrength(s.get_double('glass-clock-tint-strength'));
    g.setBlurRadius(s.get_int('glass-clock-blur-radius'));
    g.setBrightness(s.get_double('glass-clock-brightness'));
    g.setContrast(s.get_double('glass-clock-contrast'));
    g.setSaturation(s.get_double('glass-clock-saturation'));
  }

  private _syncAdaptive(): void {
    const s = this._env.settings;
    if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
      this._adaptive.clear();
      return;
    }
    this._adaptive.start(s.get_int('desktop-widget-sample-interval-ms'),
      sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')));
  }

  // The font the digits are cut from: the chosen one, or the interface font in bold.
  private _fontDescription(): string {
    const chosen = this._env.settings.get_string('glass-clock-font').trim();
    if (chosen) return chosen;
    const ui = Pango.FontDescription.from_string(this._interfaceSettings.get_string('font-name'));
    return `${ui.get_family() ?? 'Sans'} Bold`;
  }

  private _queueFont(): void {
    if (this._fontTimerId) GLib.Source.remove(this._fontTimerId);
    this._fontTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FONT_DELAY_MS, () => {
      this._fontTimerId = 0;
      this._loadFont();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _loadFont(): void {
    const s = this._env.settings;
    const font = this._fontDescription();
    const size = s.get_int('glass-clock-size');
    const stretch = s.get_double('glass-clock-stretch');
    const height = s.get_double('glass-clock-height');
    const glyphs = this._glyphs;
    if (glyphs && font === this._font && size === glyphs.size && stretch === glyphs.stretch && height === glyphs.height)
      return;
    glyphs?.cancellable.cancel();
    this._font = font;
    this._glyphs = new GlyphFields(font, size, FIELD_RANGE, stretch, height);
    this._date.set_style(`font-size: ${Math.max(11, Math.round(size * 0.13))}px;`);
    this._text = '';
    this._tick();
  }

  /** Whether the digits have a size or width other than the default. */
  get resized(): boolean {
    const s = this._env.settings;
    return SIZE_KEYS.some(key => !s.get_value(key).equal(s.get_default_value(key)!));
  }

  /**
   * Makes the clock `sx` times as wide and `sy` times as tall, as far as the
   * settings allow: taller alone lengthens the digits' upright strokes, wider
   * alone stretches them, and both scale the font.
   */
  resizeBy(sx: number, sy: number): void {
    const s = this._env.settings;
    if (sx === 1 && this._glyphs) {
      const added = (sy - 1) * this._bounds[3] / this._glyphs.digitHeight;
      const height = clamp(s.get_double('glass-clock-height') + added, keyRange(s, 'glass-clock-height'));
      s.set_double('glass-clock-height', Math.round(height * 100) / 100);
      this._loadFont();
      return;
    }
    const size = s.get_int('glass-clock-size');
    const newSize = Math.round(clamp(size * sy, keyRange(s, 'glass-clock-size')));
    // The width follows the size too; the stretch makes up the rest.
    const stretch = clamp(s.get_double('glass-clock-stretch') * sx * size / newSize, keyRange(s, 'glass-clock-stretch'));
    s.set_int('glass-clock-size', newSize);
    s.set_double('glass-clock-stretch', Math.round(stretch * 100) / 100);
    this._loadFont();
  }

  resetSize(): void {
    for (const key of SIZE_KEYS) this._env.settings.reset(key);
    this._loadFont();
  }

  private _timeText(now: GLib.DateTime): string {
    const format = this._env.settings.get_string('glass-clock-format');
    const twelve = format === '12h' || (format !== '24h' && this._interfaceSettings.get_string('clock-format') === '12h');
    return now.format(twelve ? '%-I:%M' : '%H:%M') ?? '';
  }

  private _tick(): void {
    if (this._timerId) GLib.Source.remove(this._timerId);
    const now = GLib.DateTime.new_now_local();
    this._date.visible = this._env.settings.get_boolean('glass-clock-show-date');
    this._date.text = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    this._setText(this._timeText(now));
    this._sizeChanged = true;
    const wait = 60 - now.get_seconds() + 0.05;
    this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait * 1000), () => {
      this._timerId = 0;
      this._tick();
      return GLib.SOURCE_REMOVE;
    });
  }

  private async _setText(text: string): Promise<void> {
    const glyphs = this._glyphs;
    if (text === this._text || !glyphs) return;
    this._text = text;
    let field;
    let texture;
    let band;
    try {
      field = await glyphs.fieldFor(text);
      if (glyphs !== this._glyphs || text !== this._text) return;
      const lens = softened(field, Math.min(Math.max(maxDepth(field), 2), MAX_BAND) * LENS_SOFTNESS);
      band = Math.min(Math.max(maxDepth(lens), 2), MAX_BAND);
      texture = fieldTexture(field, lens, FIELD_RANGE);
    } catch (e) {
      if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
        this._env.logger.error(`[Liquid Glass] Could not draw the clock's digits: ${e}`);
      // Tried again at the next minute.
      if (text === this._text) this._text = '';
      return;
    }
    this._fieldSize = [field.width, field.height];
    this._glass.set_size(field.width, field.height);
    this._glass.setResolution(field.width, field.height);
    this._glass.setGlassGeometry(0, 0, field.width, field.height);
    this._glass.setShapeTexture(texture, FIELD_RANGE, band);
    this._sizeChanged = true;
    this._adaptive.invalidate();
  }

  // The date above the digits; the field's margin is mostly empty, so the
  // label goes into it.
  private _layout(): void {
    const [fw, fh] = this._fieldSize;
    const [, dateH] = this._date.visible ? this._date.get_preferred_height(-1) : [0, 0];
    const [, dateW] = this._date.visible ? this._date.get_preferred_width(-1) : [0, 0];
    const glassY = Math.max(dateH + DATE_GAP - FIELD_RANGE, 0);
    const width = Math.max(fw, dateW);
    const glassX = Math.round((width - fw) / 2);
    this._glass.set_position(glassX, glassY);
    const dateX = Math.round((width - dateW) / 2);
    const dateY = Math.max(glassY + FIELD_RANGE - DATE_GAP - dateH, 0);
    this._date.set_position(dateX, dateY);
    this._size = [Math.ceil(width), Math.ceil(glassY + fh)];
    this.actor.set_size(...this._size);

    const r = FIELD_RANGE;
    let [x0, y0, x1, y1] = [glassX + r, glassY + r, glassX + fw - r, glassY + fh - r];
    if (this._date.visible) {
      x0 = Math.min(x0, dateX);
      x1 = Math.max(x1, dateX + dateW);
      y0 = Math.min(y0, dateY);
    }
    this._bounds = [x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1)];
  }

  size(): [number, number] {
    return this._size;
  }

  bounds(): [number, number, number, number] {
    return this._bounds;
  }

  sync(): boolean {
    const changed = this._sizeChanged;
    if (changed) {
      this._sizeChanged = false;
      this._layout();
    }
    if (this.actor.mapped) {
      ensureGlassAllocated(this._glass);
      this._glass.syncSources();
    }
    return changed;
  }

  destroy(): void {
    if (this._timerId) GLib.Source.remove(this._timerId);
    if (this._fontTimerId) GLib.Source.remove(this._fontTimerId);
    this._timerId = this._fontTimerId = 0;
    for (const id of this._settingsIds) this._env.settings.disconnect(id);
    for (const id of this._interfaceIds) this._interfaceSettings.disconnect(id);
    this._settingsIds = [];
    this._interfaceIds = [];
    this._adaptive.clear();
    this._glyphs?.cancellable.cancel();
    this._glyphs = null;
    this._glass.cleanup();
    if (isActorValid(this.actor)) this.actor.destroy();
  }
}
