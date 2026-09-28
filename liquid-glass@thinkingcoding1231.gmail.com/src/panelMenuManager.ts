import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { UIManager } from './uiManager.js';
import { Logger } from './logger.js';

// GSettings namespace for every detected panel dropdown. Separate from the
// Calendar's `menu-*` so these can be tuned without moving the date menu —
// the same split quick-settings-*, notification-*, osd-* and dock-* already
// have. UIManager builds its keys from this; see its _keyPrefix.
const PANEL_MENU_PREFIX = 'panel-menu';

// Preserve the preferences from the original keyboard/Vitals implementation.
const LEGACY_KEYS: Record<string, string> = {
  keyboard: 'enable-keyboard-menu-glass',
  vitalsMenu: 'enable-vitals-menu-glass',
};

export class PanelMenuManager {
  private _signals: { target: any; id: number }[] = [];
  private _buttons = new Map<any, number[]>();
  // menu actor -> the glass on it, tagged with the indicator name it was
  // found under so logs and teardown can name the menu that misbehaved.
  private _menus = new Map<any, { name: string; manager: UIManager }>();
  private _idleId = 0;
  private _active = false;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger) {}

  setup() {
    this._active = true;
    const schedule = () => this._scheduleScan();
    const watch = (target: any, signal: string) => {
      this._signals.push({ target, id: target.connect(signal, schedule) });
    };
    // Defer until addToStatusArea() has finished registering the indicator.
    const panel = Main.panel as any;
    for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
      watch(box, 'child-added');
      watch(box, 'child-removed');
    }
    watch(Main.extensionManager, 'extension-state-changed');
    for (const key of ['enable-extra-menu-glass', 'disabled-extra-menus', ...Object.values(LEGACY_KEYS)])
      watch(this._settings, `changed::${key}`);
    this._scheduleScan();
  }

  private _scheduleScan() {
    if (!this._active || this._idleId) return;
    this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idleId = 0;
      this._scan();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _scan() {
    const panel = Main.panel as any;
    const { buttons, wanted, detected } = this._discover(panel);
    this._forgetButtons(buttons);
    this._detachUnwanted(wanted);
    this._attachWanted(wanted);
    detected.sort();
    if (JSON.stringify(detected) !== JSON.stringify(this._settings.get_strv('detected-extra-menus')))
      this._settings.set_strv('detected-extra-menus', detected);
  }

  private _discover(panel: any): { buttons: Set<any>, wanted: Map<any, { button: any, name: string }>, detected: string[] } {
    const buttons = new Set<any>();
    // Indicator name per menu, so each glass can be told apart in the log.
    const wanted = new Map<any, { button: any, name: string }>();
    const detected: string[] = [];
    const disabled = new Set(this._settings.get_strv('disabled-extra-menus'));
    const enabled = this._settings.get_boolean('enable-extra-menu-glass');
    const reserved = new Set([panel.statusArea.dateMenu?.menu, panel.statusArea.quickSettings?.menu]);

    for (const [name, button] of Object.entries<any>(panel.statusArea)) {
      if (!button || !panel.contains(button.container ?? button)) continue;
      buttons.add(button);
      this._watchButton(button);
      const menu = button.menu;
      // Dummy menus and custom non-popup actors cannot use UIManager.
      // Calendar and Quick Settings already have their own managers.
      if (!(menu instanceof PopupMenu.PopupMenu) || reserved.has(menu) || !menu.actor || !menu.box)
        continue;
      detected.push(name);
      const allowed = LEGACY_KEYS[name]
        ? this._settings.get_boolean(LEGACY_KEYS[name]) : !disabled.has(name);
      if (enabled && allowed) wanted.set(menu, { button, name });
    }
    return { buttons, wanted, detected };
  }

  private _watchButton(button: any) {
    if (this._buttons.has(button)) return;
    this._buttons.set(button, [
      button.connect('menu-set', () => this._scheduleScan()),
      button.connect('destroy', () => {
        this._buttons.delete(button);
        this._scheduleScan();
      }),
    ]);
  }

  private _forgetButtons(present: Set<any>) {
    for (const [button, ids] of this._buttons) {
      if (present.has(button)) continue;
      for (const id of ids) button.disconnect(id);
      this._buttons.delete(button);
    }
  }

  private _detachUnwanted(wanted: Map<any, unknown>) {
    // Keep existing instances: a new indicator must not close another menu.
    for (const [menu, entry] of this._menus) {
      if (wanted.has(menu)) continue;
      this._menus.delete(menu);
      try { entry.manager.cleanup(); } catch (e) { this._logger.log(`[Liquid Glass] Menu cleanup (${entry.name}): ${e}`); }
    }
  }

  private _attachWanted(wanted: Map<any, { button: any, name: string }>) {
    for (const [menu, { button, name }] of wanted) {
      if (this._menus.has(menu)) continue;
      let manager: UIManager | null = null;
      try {
        manager = new UIManager(this._path, this._settings, this._logger, button, false,
          'enable-extra-menu-glass', PANEL_MENU_PREFIX, `menu:${name}`, false);
        manager.setup();
        this._menus.set(menu, { name, manager });
      } catch (e) {
        try { manager?.cleanup(); } catch { }
        this._logger.log(`[Liquid Glass] Could not attach panel menu glass to "${name}": ${e}`);
      }
    }
  }

  // [FIX] Teardown must not be all-or-nothing — the same guard UIManager,
  // NotificationManager and extension.js already use. These steps used to run
  // bare, so the first one that threw skipped every step after it, leaving
  // this manager's signal handlers and its per-menu UIManagers (each with its
  // own actors and per-frame later chain) alive across disable(). Disabling
  // is exactly when a throw is most likely: the shell is destroying the same
  // indicators we are.
  private _teardownStep(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this._logger?.log(`[Liquid Glass] PanelMenuManager.${name} failed during cleanup: ${e}`);
      } catch {
        console.error(`[Liquid Glass] PanelMenuManager.${name} failed during cleanup: ${e}`);
      }
    }
  }

  cleanup() {
    // Set before anything that can throw, so a scan queued by a signal that
    // fires mid-teardown stops itself even if this method never finishes.
    this._active = false;

    this._teardownStep('idleScan', () => {
      if (this._idleId) GLib.Source.remove(this._idleId);
      this._idleId = 0;
    });

    this._teardownStep('signals', () => {
      for (const { target, id } of this._signals) {
        try { target.disconnect(id); } catch { }
      }
      this._signals = [];
    });

    this._teardownStep('buttonSignals', () => {
      for (const [button, ids] of this._buttons)
        for (const id of ids) {
          try { button.disconnect(id); } catch { }
        }
      this._buttons.clear();
    });

    // One step per menu: a menu that throws must not strand the others.
    for (const { name, manager } of [...this._menus.values()])
      this._teardownStep(`menu(${name})`, () => manager.cleanup());
    this._menus.clear();

    this._teardownStep('detectedList', () => this._settings.set_strv('detected-extra-menus', []));
  }
}
