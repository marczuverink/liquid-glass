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
import { makeDraggable } from './desktopItem.js';
import { GlyphFields, fieldTexture } from './glassText.js';
// How far (px) the distance field reaches past the outline: room for the
// drop shadow, whose reach stays a little inside it.
const FIELD_RANGE = 48;
const SHADOW_REACH = 40;
// The lens rises over at most this much of a stroke (px), as on any glass.
const MAX_BAND = 22;
// Font changes are applied once the preferences stop changing them.
const FONT_DELAY_MS = 300;
// The date sits this far (px) above the glass digits' outline.
const DATE_GAP = 6;

/**
 * A large clock whose digits are glass, like the clock on the iPhone's lock
 * screen, with the date above it.
 */
export class GlassClock {
    id = 'clock';
    actor;
    shown = true;
    _env;
    _glass;
    _date;
    _glyphs = null;
    _text = '';
    _fieldSize = [1, 1];
    _size = [1, 1];
    _sizeChanged = true;
    _timerId = 0;
    _fontTimerId = 0;
    _settingsIds = [];
    _interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    _interfaceIds = [];
    _adaptive;

    constructor(env) {
        this._env = env;
        this.actor = new St.Widget({ name: 'liquid-glass-desktop-clock', reactive: true });
        this._glass = new BackdropGlass({
            extensionPath: env.path, settings: env.settings, logger: env.logger, owner: 'desktop-clock', shapeTexture: true,
        });
        this._glass.setPadding(0);
        this._glass.setIsDock(false);
        this._glass.setShadowMaxRadius(SHADOW_REACH);
        this._date = new St.Label({ style_class: 'liquid-glass-clock-date' });
        this.actor.add_child(this._glass);
        this.actor.add_child(this._date);
        makeDraggable(this.actor, (x, y) => env.dropped(this, x, y), () => { });
        this._adaptive = new AdaptiveTextColor(() => [this._date], () => [this._glass], env.logger, 'clock');
        const watch = (key, fn) => this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
        for (const key of ['glass-clock-font', 'glass-clock-size'])
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

    _applyMaterial() {
        const s = this._env.settings;
        const g = this._glass;
        g.setTintColor(...hexToColorArray(s.get_string('glass-clock-tint-color')));
        g.setTintStrength(s.get_double('glass-clock-tint-strength'));
        g.setBlurRadius(s.get_int('glass-clock-blur-radius'));
        g.setBrightness(s.get_double('glass-clock-brightness'));
        g.setContrast(s.get_double('glass-clock-contrast'));
        g.setSaturation(s.get_double('glass-clock-saturation'));
    }

    _syncAdaptive() {
        const s = this._env.settings;
        if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
            this._adaptive.clear();
            return;
        }
        this._adaptive.start(s.get_int('desktop-widget-sample-interval-ms'), sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')));
    }

    // The font the digits are cut from: the chosen one, or the interface font in bold.
    _fontDescription() {
        const chosen = this._env.settings.get_string('glass-clock-font').trim();
        if (chosen)
            return chosen;
        const ui = Pango.FontDescription.from_string(this._interfaceSettings.get_string('font-name'));
        return `${ui.get_family() ?? 'Sans'} Bold`;
    }

    _queueFont() {
        if (this._fontTimerId)
            GLib.Source.remove(this._fontTimerId);
        this._fontTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FONT_DELAY_MS, () => {
            this._fontTimerId = 0;
            this._loadFont();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadFont() {
        const size = this._env.settings.get_int('glass-clock-size');
        this._glyphs?.cancellable.cancel();
        this._glyphs = new GlyphFields(this._fontDescription(), size, FIELD_RANGE);
        this._date.set_style(`font-size: ${Math.max(11, Math.round(size * 0.13))}px;`);
        this._text = '';
        this._tick();
    }

    _timeText(now) {
        const format = this._env.settings.get_string('glass-clock-format');
        const twelve = format === '12h' || (format !== '24h' && this._interfaceSettings.get_string('clock-format') === '12h');
        return now.format(twelve ? '%-I:%M' : '%H:%M') ?? '';
    }

    // Shows the current time and waits for the next minute.
    _tick() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
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

    async _setText(text) {
        const glyphs = this._glyphs;
        if (text === this._text || !glyphs)
            return;
        this._text = text;
        let field;
        let texture;
        // Drawing the glyphs and making the texture throw a GError on failure,
        // and the glyphs' reads when the font changes or the clock goes away.
        try {
            field = await glyphs.fieldFor(text);
            if (glyphs !== this._glyphs || text !== this._text)
                return;
            texture = fieldTexture(field, FIELD_RANGE);
        }
        catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                this._env.logger.error(`[Liquid Glass] Could not draw the clock's digits: ${e}`);
            // Tried again at the next minute.
            if (text === this._text)
                this._text = '';
            return;
        }
        const band = Math.min(Math.max(field.maxDepth, 2), MAX_BAND);
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
    _layout() {
        const [fw, fh] = this._fieldSize;
        const [, dateH] = this._date.visible ? this._date.get_preferred_height(-1) : [0, 0];
        const [, dateW] = this._date.visible ? this._date.get_preferred_width(-1) : [0, 0];
        const glassY = Math.max(dateH + DATE_GAP - FIELD_RANGE, 0);
        const width = Math.max(fw, dateW);
        this._glass.set_position(Math.round((width - fw) / 2), glassY);
        this._date.set_position(Math.round((width - dateW) / 2), Math.max(glassY + FIELD_RANGE - DATE_GAP - dateH, 0));
        this._size = [Math.ceil(width), Math.ceil(glassY + fh)];
        this.actor.set_size(...this._size);
    }

    size() {
        return this._size;
    }

    sync() {
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

    destroy() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        if (this._fontTimerId)
            GLib.Source.remove(this._fontTimerId);
        this._timerId = this._fontTimerId = 0;
        for (const id of this._settingsIds)
            this._env.settings.disconnect(id);
        for (const id of this._interfaceIds)
            this._interfaceSettings.disconnect(id);
        this._settingsIds = [];
        this._interfaceIds = [];
        this._adaptive.clear();
        this._glyphs?.cancellable.cancel();
        this._glyphs = null;
        this._glass.cleanup();
        if (isActorValid(this.actor))
            this.actor.destroy();
    }
}
