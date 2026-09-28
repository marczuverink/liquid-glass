// Native GTK smoke test. Memory backend is mandatory: never edit the user's profile.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {buildPreferences} from '../liquid-glass@thinkingcoding1231.gmail.com/preferences/pages.js';

if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory') throw Error('Run with GSETTINGS_BACKEND=memory');
Adw.init();
const directory = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const source = Gio.SettingsSchemaSource.new_from_directory(
  directory.get_child('liquid-glass@thinkingcoding1231.gmail.com/schemas').get_path(),
  Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup('org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com', true);
const settings = new Gio.Settings({settings_schema: schema});
settings.set_int('dock-blur-radius', 3);
settings.set_int('menu-blur-radius', 21);
settings.set_double('menu-scale', 0.83);
const snapshot = () => JSON.stringify(schema.list_keys().sort().map(key => [key, settings.get_value(key).print(true)]));
const before = snapshot();
const window = new Adw.PreferencesWindow();
const controls = buildPreferences(window, settings);
if (snapshot() !== before) throw Error('Opening preferences changed the configuration');

function* walk(widget) {
  yield widget;
  for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) yield* walk(child);
}
const rows = [...walk(window)].filter(widget => widget instanceof Adw.PreferencesRow);
const find = title => rows.find(row => row.title === title);
if (!find('Blur').subtitle.includes('Custom')) throw Error('Mixed values not indicated');
find('Blur').value = 12;
for (const surface of ['dock', 'menu', 'panel-menu', 'notification', 'quick-settings', 'osd', 'application', 'desktop-menu']) {
  if (settings.get_int(`${surface}-blur-radius`) !== 12) throw Error(`Shared blur did not reach ${surface}`);
}
find('Animations').selected = 1;
if (settings.get_double('menu-spring-damping') !== 22) throw Error('Smooth motion did not apply');
if (settings.get_double('menu-scale') !== 0.83) throw Error('An unrelated setting changed');
controls.dispose();
window.destroy();
print(JSON.stringify({nativeGtk: 'passed', rows: rows.length, openingWrites: 0, sharedBlur: 'passed', smoothMotion: 'passed'}));
