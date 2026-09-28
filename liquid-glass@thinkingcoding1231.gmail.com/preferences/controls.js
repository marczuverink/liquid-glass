import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import {commonValue, matches, uniformPatch} from './model.js';

// Owns multi-key editing and subscriptions. Opening a control never writes settings.
export class PreferenceControls {
  constructor(settings, window) {
    this.settings = settings;
    this._ids = [];
    this._cleanups = [];
    window.connect('close-request', () => { this.dispose(); return false; });
  }

  onClose(callback) { this._cleanups.push(callback); }

  watch(keys, refresh) {
    for (const key of keys) this._ids.push(this.settings.connect(`changed::${key}`, refresh));
    refresh();
  }

  dispose() {
    for (const id of this._ids.splice(0)) this.settings.disconnect(id);
    for (const callback of this._cleanups.splice(0)) callback();
  }

  write(patch) {
    // A separate delayed instance batches shared edits without changing the
    // apply semantics of ordinary bindings or the window picker.
    const transaction = new Gio.Settings({settings_schema: this.settings.settings_schema, path: this.settings.path});
    const changes = Object.entries(patch).map(([key, value]) => [key,
      new GLib.Variant(this.settings.get_value(key).get_type_string(), value)]);
    if (changes.some(([key, value]) => !transaction.is_writable(key) || !transaction.settings_schema.get_key(key).range_check(value)))
      throw new Error('These settings cannot be changed together');
    transaction.delay();
    try {
      for (const [key, value] of changes) {
        if (!transaction.set_value(key, value)) throw new Error(`Cannot change ${key}`);
      }
      transaction.apply();
    } catch (error) {
      transaction.revert();
      throw error;
    }
  }

  group(page, title, description = '') {
    const group = new Adw.PreferencesGroup({title, description});
    page.add(group);
    return group;
  }

  toggle(group, title, key, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    group.add(row);
    this.settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  choice(group, title, choices, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle,
      model: Gtk.StringList.new([...choices.map(choice => choice.title), 'Custom'])});
    group.add(row);
    let syncing = false;
    const refresh = () => {
      syncing = true;
      const index = choices.findIndex(choice => matches(this.settings, choice.patch));
      row.selected = index < 0 ? choices.length : index;
      syncing = false;
    };
    row.connect('notify::selected', () => {
      if (syncing) return;
      const choice = choices[row.selected];
      if (choice) this.write(choice.patch);
      refresh();
    });
    this.watch([...new Set(choices.flatMap(choice => Object.keys(choice.patch)))], refresh);
    return row;
  }

  number(group, title, keys, min, max, step, subtitle = '') {
    const row = new Adw.SpinRow({title, subtitle,
      adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
      digits: step < 1 ? 2 : 0});
    group.add(row);
    let syncing = false;
    const refresh = () => {
      syncing = true;
      const current = commonValue(this.settings, keys);
      row.value = current.value;
      row.subtitle = current.mixed ? 'Custom · changing this applies everywhere' : subtitle;
      syncing = false;
    };
    row.connect('notify::value', () => {
      if (!syncing) this.write(uniformPatch(keys, row.value));
    });
    this.watch(keys, refresh);
    return row;
  }

  color(group, title, keys) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({valign: Gtk.Align.CENTER,
      dialog: new Gtk.ColorDialog({with_alpha: false})});
    row.add_suffix(button);
    row.activatable_widget = button;
    group.add(row);
    let syncing = false;
    this.watch(keys, () => {
      syncing = true;
      const current = commonValue(this.settings, keys);
      const rgba = new Gdk.RGBA();
      rgba.parse(current.value);
      button.rgba = rgba;
      row.subtitle = current.mixed ? 'Custom · changing this applies everywhere' : '';
      syncing = false;
    });
    button.connect('notify::rgba', () => {
      if (syncing) return;
      const color = button.rgba;
      const hex = '#' + [color.red, color.green, color.blue]
        .map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
      this.write(uniformPatch(keys, hex));
    });
  }
}
