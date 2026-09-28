import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import GLib from 'gi://GLib';
import { UIManager } from './uiManager.js';
const PANEL_MENU_PREFIX = 'panel-menu';
const LEGACY_KEYS = {
    keyboard: 'enable-keyboard-menu-glass',
    vitalsMenu: 'enable-vitals-menu-glass',
};
export class PanelMenuManager {
    _path;
    _settings;
    _logger;
    _signals = [];
    _buttons = new Map();
    _menus = new Map();
    _idleId = 0;
    _active = false;
    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
    }
    setup() {
        this._active = true;
        const schedule = () => this._scheduleScan();
        const watch = (target, signal) => {
            this._signals.push({ target, id: target.connect(signal, schedule) });
        };
        const panel = Main.panel;
        for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
            watch(box, 'child-added');
            watch(box, 'child-removed');
        }
        watch(Main.extensionManager, 'extension-state-changed');
        for (const key of ['enable-extra-menu-glass', 'disabled-extra-menus', ...Object.values(LEGACY_KEYS)])
            watch(this._settings, `changed::${key}`);
        this._scheduleScan();
    }
    _scheduleScan() {
        if (!this._active || this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }
    _scan() {
        const panel = Main.panel;
        const buttons = new Set();
        const wanted = new Map();
        const wantedNames = new Map();
        const detected = [];
        const disabled = new Set(this._settings.get_strv('disabled-extra-menus'));
        const enabled = this._settings.get_boolean('enable-extra-menu-glass');
        const reserved = new Set([panel.statusArea.dateMenu?.menu, panel.statusArea.quickSettings?.menu]);
        for (const [name, button] of Object.entries(panel.statusArea)) {
            if (!button || !panel.contains(button.container ?? button))
                continue;
            buttons.add(button);
            if (!this._buttons.has(button)) {
                this._buttons.set(button, [
                    button.connect('menu-set', () => this._scheduleScan()),
                    button.connect('destroy', () => {
                        this._buttons.delete(button);
                        this._scheduleScan();
                    }),
                ]);
            }
            const menu = button.menu;
            if (!(menu instanceof PopupMenu.PopupMenu) || reserved.has(menu) || !menu.actor || !menu.box)
                continue;
            detected.push(name);
            const allowed = LEGACY_KEYS[name]
                ? this._settings.get_boolean(LEGACY_KEYS[name]) : !disabled.has(name);
            if (enabled && allowed) {
                wanted.set(menu, button);
                wantedNames.set(menu, name);
            }
        }
        for (const [button, ids] of this._buttons) {
            if (buttons.has(button))
                continue;
            for (const id of ids)
                button.disconnect(id);
            this._buttons.delete(button);
        }
        for (const [menu, entry] of this._menus) {
            if (wanted.has(menu))
                continue;
            this._menus.delete(menu);
            try {
                entry.manager.cleanup();
            }
            catch (e) {
                this._logger.log(`[Liquid Glass] Menu cleanup (${entry.name}): ${e}`);
            }
        }
        for (const [menu, button] of wanted) {
            if (this._menus.has(menu))
                continue;
            const name = wantedNames.get(menu) ?? '?';
            let manager = null;
            try {
                manager = new UIManager(this._path, this._settings, this._logger, button, false, 'enable-extra-menu-glass', PANEL_MENU_PREFIX, `menu:${name}`, false);
                manager.setup();
                this._menus.set(menu, { name, manager });
            }
            catch (e) {
                try {
                    manager?.cleanup();
                }
                catch (_) { }
                this._logger.log(`[Liquid Glass] Could not attach panel menu glass to "${name}": ${e}`);
            }
        }
        detected.sort();
        if (JSON.stringify(detected) !== JSON.stringify(this._settings.get_strv('detected-extra-menus')))
            this._settings.set_strv('detected-extra-menus', detected);
    }
    _teardownStep(name, fn) {
        try {
            fn();
        }
        catch (e) {
            try {
                this._logger?.log(`[Liquid Glass] PanelMenuManager.${name} failed during cleanup: ${e}`);
            }
            catch (_) {
                console.error(`[Liquid Glass] PanelMenuManager.${name} failed during cleanup: ${e}`);
            }
        }
    }
    cleanup() {
        this._active = false;
        this._teardownStep('idleScan', () => {
            if (this._idleId)
                GLib.Source.remove(this._idleId);
            this._idleId = 0;
        });
        this._teardownStep('signals', () => {
            for (const { target, id } of this._signals) {
                try {
                    target.disconnect(id);
                }
                catch (e) { }
            }
            this._signals = [];
        });
        this._teardownStep('buttonSignals', () => {
            for (const [button, ids] of this._buttons)
                for (const id of ids) {
                    try {
                        button.disconnect(id);
                    }
                    catch (e) { }
                }
            this._buttons.clear();
        });
        for (const { name, manager } of [...this._menus.values()])
            this._teardownStep(`menu(${name})`, () => manager.cleanup());
        this._menus.clear();
        this._teardownStep('detectedList', () => this._settings.set_strv('detected-extra-menus', []));
    }
}
