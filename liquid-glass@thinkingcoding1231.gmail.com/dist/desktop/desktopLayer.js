import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import { isActorValid } from '../actors/lifecycle.js';
import { addBeforeRedraw, removeBeforeRedraw, startSyncLoop, stopStageLoop } from '../animation/frameLoops.js';
import GLib from 'gi://GLib';
import { parsePositions, placeAtFraction, fractionOf, sanitizeAnchor, stackAt } from './placement.js';
import { WeatherWidget } from './weather.js';
import { EventsWidget } from './events.js';
import { MediaWidget } from './media.js';
import { GlassClock } from './clock.js';
export const WIDGET_IDS = ['weather', 'events', 'media'];

/**
 * The glass clock and the desktop widgets. They live in the shell's
 * background group, above the wallpaper and below every window, so they are
 * hidden with the windows in the overview. Each sits at a corner or the
 * centre of the primary monitor's work area, stacked with the others there,
 * unless the user dragged it somewhere else.
 */
export class DesktopLayer {
    _settings;
    _container = null;
    _items = new Map();
    _settingsIds = [];
    _signals = [];
    _frameSyncId = 0;
    _frameSignalId = 0;
    _needsLayout = true;
    _layoutLaterId = 0;
    _env;

    constructor(path, _settings, logger) {
        this._settings = _settings;
        this._env = { path, settings: _settings, logger, dropped: (item, x, y) => this._dropped(item, x, y) };
    }

    setup() {
        const watch = (key, fn) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        for (const key of ['enable-desktop-widgets', 'desktop-widgets', 'enable-glass-clock'])
            watch(key, () => this._sync());
        for (const key of ['desktop-widgets-position', 'glass-clock-position', 'desktop-item-positions'])
            watch(key, () => this._queueLayout());
        this._sync();
    }

    _wanted() {
        const ids = [];
        if (this._settings.get_boolean('enable-glass-clock'))
            ids.push('clock');
        if (this._settings.get_boolean('enable-desktop-widgets')) {
            const chosen = new Set(this._settings.get_strv('desktop-widgets'));
            ids.push(...WIDGET_IDS.filter(id => chosen.has(id)));
        }
        return ids;
    }

    _create(id) {
        switch (id) {
            case 'clock': return new GlassClock(this._env);
            case 'weather': return new WeatherWidget(this._env);
            case 'events': return new EventsWidget(this._env);
            default: return new MediaWidget(this._env);
        }
    }

    // Creates and destroys items to match the settings.
    _sync() {
        const wanted = this._wanted();
        for (const [id, item] of this._items) {
            if (wanted.includes(id))
                continue;
            item.destroy();
            this._items.delete(id);
        }
        if (wanted.length === 0) {
            this._removeContainer();
            return;
        }
        this._ensureContainer();
        for (const id of wanted) {
            if (this._items.has(id))
                continue;
            const item = this._create(id);
            this._items.set(id, item);
            this._container.add_child(item.actor);
        }
        this._queueLayout();
    }

    _ensureContainer() {
        if (this._container)
            return;
        const container = new St.Widget({ name: 'liquid-glass-desktop', x: 0, y: 0 });
        this._container = container;
        Main.layoutManager._backgroundGroup.add_child(container);
        const relayout = () => this._queueLayout();
        this._signals.push({ target: Main.layoutManager, id: Main.layoutManager.connect('monitors-changed', relayout) });
        this._signals.push({ target: global.display, id: global.display.connect('workareas-changed', relayout) });
        startSyncLoop(this._frameSignalSlot, this._frameSlot, {
            alive: () => !!this._container,
            honourFreeze: true,
            errorTag: 'DesktopLayer',
            step: () => this._step(),
        });
    }

    _removeContainer() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        removeBeforeRedraw(this._layoutLaterId);
        this._layoutLaterId = 0;
        for (const { target, id } of this._signals)
            target.disconnect(id);
        this._signals = [];
        const container = this._container;
        this._container = null;
        if (container && isActorValid(container))
            container.destroy();
    }

    // Lays the items out before the next frame, and makes sure there is one.
    _queueLayout() {
        this._needsLayout = true;
        if (this._layoutLaterId || !this._container)
            return;
        this._layoutLaterId = addBeforeRedraw(() => {
            this._layoutLaterId = 0;
            if (this._container)
                this._step();
            return GLib.SOURCE_REMOVE;
        });
    }

    _step() {
        for (const item of this._items.values()) {
            if (item.sync())
                this._needsLayout = true;
        }
        if (this._needsLayout) {
            this._needsLayout = false;
            this._layout();
        }
    }

    _workArea() {
        return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    }

    _anchorOf(id) {
        return id === 'clock'
            ? sanitizeAnchor(this._settings.get_string('glass-clock-position'), 'center')
            : sanitizeAnchor(this._settings.get_string('desktop-widgets-position'));
    }

    // Places every item: where it was dragged, or stacked at its anchor.
    _layout() {
        const area = this._workArea();
        const dragged = parsePositions(this._settings.get_string('desktop-item-positions'));
        const stacks = new Map();
        for (const [id, item] of this._items) {
            if (!item.shown)
                continue;
            const fraction = dragged[id];
            if (fraction) {
                item.actor.set_position(...placeAtFraction(fraction, area, item.size()));
                continue;
            }
            const anchor = this._anchorOf(id);
            if (!stacks.has(anchor))
                stacks.set(anchor, []);
            stacks.get(anchor).push(item);
        }
        for (const [anchor, items] of stacks) {
            const positions = stackAt(anchor, area, items.map(item => item.size()));
            items.forEach((item, i) => item.actor.set_position(...positions[i]));
        }
    }

    _dropped(item, x, y) {
        const positions = parsePositions(this._settings.get_string('desktop-item-positions'));
        positions[item.id] = fractionOf([x, y], this._workArea(), item.size());
        this._settings.set_string('desktop-item-positions', JSON.stringify(positions));
    }

    cleanup() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        this._removeContainer();
    }

    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }

    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
