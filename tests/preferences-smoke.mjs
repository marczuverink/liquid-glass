// Native GTK smoke test. Memory backend is mandatory: never edit the user's profile.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
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
const effectsSnapshot = () => JSON.stringify(schema.list_keys().sort().filter(key => key !== 'preferences-advanced')
  .map(key => [key, settings.get_value(key).print(true)]));
const beforeMode = effectsSnapshot();
find('Settings view').selected = 1;
if (effectsSnapshot() !== beforeMode) throw Error('Switching mode changed effect values');
const groupTitles = [...walk(window)].filter(widget => widget instanceof Adw.PreferencesGroup && widget.visible).map(widget => widget.title);
for (const [first, later] of [['Individual effects', 'Application windows'], ['Shadows', 'Compatibility'], ['Shadows', 'Troubleshooting']]) {
  if (groupTitles.lastIndexOf(first) > groupTitles.indexOf(later)) throw Error(`${first} is below ${later}: ${groupTitles.join(' | ')}`);
}
const surface = [...walk(window)].find(row => row instanceof Adw.ComboRow && row.title === 'Surface');
for (let i = 0; i < 8; i++) surface.selected = i;
for (const [index, title, prefix] of [[1, 'Calendar', 'menu'], [2, 'Other top bar menus', 'panel-menu'],
  [4, 'Quick settings', 'quick-settings']]) {
  surface.selected = index;
  const group = [...walk(window)].find(widget => widget instanceof Adw.PreferencesGroup && widget.title === title);
  const interval = [...walk(group)].find(widget => widget instanceof Adw.SpinRow && widget.title === 'Animation interval (ms)');
  const key = `${prefix}-animation-interval-ms`;
  if (!schema.get_key(key).range_check(new GLib.Variant('i', interval.adjustment.upper)))
    throw Error(`${key} offers an invalid upper bound`);
  interval.value = interval.adjustment.upper + 1;
  if (interval.value !== interval.adjustment.upper || settings.get_int(key) !== interval.adjustment.upper)
    throw Error(`${key} did not clamp and save the edit`);
}
surface.selected = 1;
const calendar = [...walk(window)].find(widget => widget instanceof Adw.PreferencesGroup && widget.title === 'Calendar');
const calendarBlur = [...walk(calendar)].find(widget => widget instanceof Adw.SpinRow && widget.title === 'Blur');
const blurSlider = [...walk(calendarBlur)].find(widget => widget instanceof Gtk.Scale);
if (!blurSlider || blurSlider.adjustment !== calendarBlur.adjustment) throw Error('Blur has no slider on its adjustment');
if (calendarBlur.get_first_child().get_last_child().get_first_child() !== blurSlider)
  throw Error('The slider is not in front of the number');
blurSlider.set_value(16.6);
if (settings.get_int('menu-blur-radius') !== 17) throw Error('Dragging the slider did not store the rounded value');
calendarBlur.value = 17;
if (settings.get_int('menu-blur-radius') !== 17 || settings.get_int('dock-blur-radius') !== 12)
  throw Error('Individual blur changed the wrong surface');
find('Settings view').selected = 0;
if (!find('Blur').subtitle.includes('Custom')) throw Error('Simple view lost individual differences');
controls.dispose();
window.destroy();
print(JSON.stringify({nativeGtk: 'passed', rows: rows.length, openingWrites: 0, sharedBlur: 'passed', smoothMotion: 'passed', advanced: 'passed'}));
