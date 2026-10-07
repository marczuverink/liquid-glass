import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { isActorValid } from '../actors/lifecycle.js';
import { addBeforeRedraw, removeBeforeRedraw, startSyncLoop, stopStageLoop } from '../animation/frameLoops.js';
import GLib from 'gi://GLib';
import type { Logger } from '../logger.js';
import { type DesktopItem, type ItemEnv } from './desktopItem.js';
import { type Anchor, type Rect, parsePositions, placeAtFraction, fractionOf, sanitizeAnchor, stackAt } from './placement.js';
import { WeatherWidget } from './weather.js';
import { EventsWidget } from './events.js';
import { MediaWidget } from './media.js';
import { GlassClock } from './clock.js';

export const WIDGET_IDS = ['weather', 'events', 'media'] as const;

/**
 * The glass clock and the desktop widgets. They live in the shell's
 * background group, above the wallpaper and below every window, so they are
 * hidden with the windows in the overview. Each sits at a corner or the
 * centre of the primary monitor's work area, stacked with the others there,
 * unless the user dragged it somewhere else.
 */
export class DesktopLayer {
  private _container: St.Widget | null = null;
  private _items = new Map<string, DesktopItem>();
  private _settingsIds: number[] = [];
  private _signals: { target: any, id: number }[] = [];
  private _frameSyncId = 0;
  private _frameSignalId = 0;
  private _needsLayout = true;
  private _layoutLaterId = 0;
  private _env: ItemEnv;

  constructor(path: string, private _settings: Gio.Settings, logger: Logger) {
    this._env = { path, settings: _settings, logger, dropped: (item, x, y) => this._dropped(item, x, y) };
  }

  setup(): void {
    const watch = (key: string, fn: () => void) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
    for (const key of ['enable-desktop-widgets', 'desktop-widgets', 'enable-glass-clock'])
      watch(key, () => this._sync());
    for (const key of ['desktop-widgets-position', 'glass-clock-position', 'desktop-item-positions'])
      watch(key, () => this._queueLayout());
    this._sync();
  }

  private _wanted(): string[] {
    const ids: string[] = [];
    if (this._settings.get_boolean('enable-glass-clock')) ids.push('clock');
    if (this._settings.get_boolean('enable-desktop-widgets')) {
      const chosen = new Set(this._settings.get_strv('desktop-widgets'));
      ids.push(...WIDGET_IDS.filter(id => chosen.has(id)));
    }
    return ids;
  }

  private _create(id: string): DesktopItem {
    switch (id) {
    case 'clock': return new GlassClock(this._env);
    case 'weather': return new WeatherWidget(this._env);
    case 'events': return new EventsWidget(this._env);
    default: return new MediaWidget(this._env);
    }
  }

  // Creates and destroys items to match the settings.
  private _sync(): void {
    const wanted = this._wanted();
    for (const [id, item] of this._items) {
      if (wanted.includes(id)) continue;
      item.destroy();
      this._items.delete(id);
    }
    if (wanted.length === 0) {
      this._removeContainer();
      return;
    }
    this._ensureContainer();
    for (const id of wanted) {
      if (this._items.has(id)) continue;
      const item = this._create(id);
      this._items.set(id, item);
      this._container!.add_child(item.actor);
    }
    this._queueLayout();
  }

  private _ensureContainer(): void {
    if (this._container) return;
    const container = new St.Widget({ name: 'liquid-glass-desktop', x: 0, y: 0 });
    this._container = container;
    (Main.layoutManager as any)._backgroundGroup.add_child(container);
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

  private _removeContainer(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    removeBeforeRedraw(this._layoutLaterId);
    this._layoutLaterId = 0;
    for (const { target, id } of this._signals) target.disconnect(id);
    this._signals = [];
    const container = this._container;
    this._container = null;
    if (container && isActorValid(container)) container.destroy();
  }

  // Lays the items out before the next frame, and makes sure there is one.
  private _queueLayout(): void {
    this._needsLayout = true;
    if (this._layoutLaterId || !this._container) return;
    this._layoutLaterId = addBeforeRedraw(() => {
      this._layoutLaterId = 0;
      if (this._container) this._step();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _step(): void {
    for (const item of this._items.values()) {
      if (item.sync()) this._needsLayout = true;
    }
    if (this._needsLayout) {
      this._needsLayout = false;
      this._layout();
    }
  }

  private _workArea(): Rect {
    return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
  }

  private _anchorOf(id: string): Anchor {
    return id === 'clock'
      ? sanitizeAnchor(this._settings.get_string('glass-clock-position'), 'center')
      : sanitizeAnchor(this._settings.get_string('desktop-widgets-position'));
  }

  // Places every item: where it was dragged, or stacked at its anchor.
  private _layout(): void {
    const area = this._workArea();
    const dragged = parsePositions(this._settings.get_string('desktop-item-positions'));
    const stacks = new Map<Anchor, DesktopItem[]>();
    for (const [id, item] of this._items) {
      if (!item.shown) continue;
      const fraction = dragged[id];
      if (fraction) {
        item.actor.set_position(...placeAtFraction(fraction, area, item.size()));
        continue;
      }
      const anchor = this._anchorOf(id);
      if (!stacks.has(anchor)) stacks.set(anchor, []);
      stacks.get(anchor)!.push(item);
    }
    for (const [anchor, items] of stacks) {
      const positions = stackAt(anchor, area, items.map(item => item.size()));
      items.forEach((item, i) => item.actor.set_position(...positions[i]));
    }
  }

  private _dropped(item: DesktopItem, x: number, y: number): void {
    const positions = parsePositions(this._settings.get_string('desktop-item-positions'));
    positions[item.id] = fractionOf([x, y], this._workArea(), item.size());
    this._settings.set_string('desktop-item-positions', JSON.stringify(positions));
  }

  cleanup(): void {
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    for (const item of this._items.values()) item.destroy();
    this._items.clear();
    this._removeContainer();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}
