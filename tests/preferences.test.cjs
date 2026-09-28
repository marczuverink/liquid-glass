const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createModuleLoader} = require('./helpers/load-module.cjs');
const root = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com');

function fixture(overrides = {}, dbusResponses = []) {
  const values = new Map();
  const types = new Map();
  const xml = fs.readFileSync(path.join(root, 'schemas/org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com.gschema.xml'), 'utf8');
  for (const [, key, type, body] of xml.matchAll(/<key name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/key>/g)) {
    const raw = body.match(/<default>([\s\S]*?)<\/default>/)[1].trim();
    const value = type === 'as' ? [] : type === 's' ? raw.slice(1, -1) : type === 'b' ? raw === 'true' : Number(raw);
    types.set(key, type); values.set(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) values.set(key, value);
  const listeners = new Map(); const widgets = []; const writes = []; let nextId = 1;
  class Variant {
    constructor(type, value) { this.type = type; this.value = value; }
    deep_unpack() { return this.value; }
    get_type_string() { return this.type; }
  }
  class Settings {
    constructor() { this.path = '/test/'; this.settings_schema = {get_key: () => ({range_check: () => true})}; }
    get_value(key) { assert.ok(types.has(key), `unknown schema key ${key}`); return new Variant(types.get(key), values.get(key)); }
    get_boolean(key) { return this.get_value(key).deep_unpack(); }
    get_strv(key) { return this.get_value(key).deep_unpack(); }
    connect(signal, fn) { const id = nextId++; listeners.set(id, {signal, fn}); return id; }
    disconnect(id) { listeners.delete(id); }
    is_writable() { return true; }
    delay() { this.pending = new Map(); }
    set_value(key, variant) { this.get_value(key); this.pending.set(key, variant.deep_unpack()); return true; }
    apply() {
      const patch = Object.fromEntries(this.pending); writes.push(patch);
      for (const [key, value] of this.pending) values.set(key, value);
      for (const key of this.pending.keys()) for (const {signal, fn} of [...listeners.values()]) if (signal === `changed::${key}`) fn();
      this.pending.clear();
    }
    revert() { this.pending.clear(); }
    bind(key, widget, property) { this.connect(`changed::${key}`, () => { widget[property] = values.get(key); }); widget[property] = values.get(key); }
  }
  class Widget {
    constructor(props = {}) { Object.assign(this, {children: [], signals: new Map(), visible: true}, props); widgets.push(this); }
    add(child) { this.children.push(child); }
    add_row(child) { this.add(child); }
    append(child) { this.add(child); }
    remove(child) { this.children = this.children.filter(item => item !== child); }
    add_prefix() {} add_suffix() {} add_css_class() {} set_header_suffix() {} set_default_size() {}
    get_first_child() { return this.children[0] ?? null; }
    get_next_sibling() { return null; }
    connect(signal, fn) { const id = nextId++; this.signals.set(id, {signal, fn}); return id; }
    emit(signal) { for (const entry of this.signals.values()) if (entry.signal === signal) entry.fn(); }
    set selected(value) { this._selected = value; this.emit('notify::selected'); }
    get selected() { return this._selected; }
    set value(value) { this._value = value; this.emit('notify::value'); }
    get value() { return this._value; }
    set active(value) { this._active = value; this.emit('notify::active'); }
    get active() { return this._active; }
  }
  class RGBA { parse() { this.red = this.green = this.blue = 1; } }
  const Adw = Object.fromEntries(['PreferencesPage', 'PreferencesGroup', 'SwitchRow', 'ComboRow', 'SpinRow', 'ActionRow', 'EntryRow', 'ExpanderRow'].map(name => [name, class extends Widget {}]));
  const Gtk = {Adjustment: Widget, ColorDialogButton: Widget, ColorDialog: Widget, Button: Widget, ListBox: Widget,
    StringList: {new: titles => titles}, Align: {CENTER: 0}, SelectionMode: {NONE: 0}};
  const dbusCalls = [];
  const Gio = {Settings, SettingsBindFlags: {GET: 1, DEFAULT: 0}, DBusCallFlags: {NONE: 0},
    Cancellable: class { cancel() { this.cancelled = true; } },
    DBus: {session: {
      call(_name, _path, _interface, method, _args, _type, _flags, _timeout, cancellable, callback) {
        dbusCalls.push(method);
        const response = dbusResponses.shift();
        queueMicrotask(() => callback({call_finish() {
          if (cancellable.cancelled) throw Error('Cancelled');
          if (response instanceof Error) throw response;
          return {deep_unpack: () => [response]};
        }}, {}));
      },
    }}};
  const load = createModuleLoader({Adw, Gtk, Gio, Gdk: {RGBA}, GLib: {Variant}});
  const settings = new Settings(); const window = new Widget();
  const {buildPreferences} = load(path.join(root, 'preferences/pages.js'));
  const controls = buildPreferences(window, settings);
  return {settings, window, controls, writes, values, widgets, load, listeners, dbusCalls,
    row: title => widgets.find(widget => widget.title === title)};
}

test('preferences expose three pages and seven shared appearance controls', () => {
  const f = fixture();
  assert.deepEqual(f.window.children.map(page => page.title), ['Appearance', 'Effects', 'Rendering']);
  assert.equal(f.window.children[0].children.filter(group => group.title !== 'Settings' && group.visible !== false).flatMap(group => group.children).length, 7);
  assert.equal(f.widgets.filter(widget => /Spring|Sample Interval|X Offset|Y Offset/.test(widget.title ?? '')).length, 0);
  assert.equal(f.window.search_enabled, true);
});

test('opening and closing preferences preserves a customized configuration without writes', () => {
  const f = fixture({'dock-blur-radius': 3, 'menu-blur-radius': 20, 'menu-scale': 0.83,
    'quick-settings-apply-to': 1, 'shadow-intensity': 0});
  assert.match(f.row('Blur').subtitle, /Custom/);
  assert.equal(f.writes.length, 0);
  f.window.emit('close-request');
  assert.equal(f.writes.length, 0);
  assert.equal(f.values.get('menu-scale'), 0.83);
});

test('editing shared blur updates all eight surfaces in one transaction and no other settings', () => {
  const f = fixture();
  f.row('Blur').value = 12;
  assert.equal(f.writes.length, 1);
  assert.equal(Object.keys(f.writes[0]).length, 8);
  assert.ok(Object.keys(f.writes[0]).every(key => key.endsWith('-blur-radius')));
  assert.ok(Object.values(f.writes[0]).every(value => value === 12));
  assert.equal(f.row('Blur').subtitle, '');
});

test('corners include toggle glass and changing them does not enable any effect', () => {
  const f = fixture(); f.row('Corners').value = 24;
  assert.equal(f.values.get('quick-settings-toggle-corner-radius'), 24);
  assert.equal(Object.keys(f.writes[0]).length, 9);
  assert.equal(f.values.get('enable-application-glass'), false);
});

test('Smooth uses critically damped motion across menus without changing their appearance', () => {
  const f = fixture(); f.row('Animations').selected = 1;
  for (const surface of ['menu', 'panel-menu', 'quick-settings']) {
    assert.equal(f.values.get(`enable-${surface}-animation`), true);
    const damping = f.values.get(`${surface}-spring-damping`);
    assert.ok(damping >= 2 * Math.sqrt(f.values.get(`${surface}-spring-stiffness`) * f.values.get(`${surface}-spring-mass`)));
  }
  assert.equal(f.values.get('menu-blur-radius'), 8);
  f.row('Animations').selected = 0;
  assert.equal(f.values.get('enable-menu-animation'), false);
});

test('Custom is a readout, not a reset preset', () => {
  const f = fixture(); f.row('Quality').selected = 3;
  assert.equal(f.writes.length, 0);
  assert.equal(f.row('Quality').selected, 0);
});

test('external settings updates refresh controls without a write feedback loop', () => {
  const f = fixture(); f.controls.write({'dock-blur-radius': 19});
  assert.equal(f.writes.length, 1);
  assert.equal(f.row('Blur').value, 19);
  assert.match(f.row('Blur').subtitle, /Custom/);
});

test('window rules only show the active list while window glass is enabled', () => {
  const f = fixture();
  assert.equal(f.row('Included applications').visible, false);
  assert.equal(f.row('Excluded applications').visible, false);
  f.controls.write({'enable-application-glass': true});
  assert.equal(f.row('Included applications').visible, true);
  f.controls.write({'application-glass-all-windows': true});
  assert.equal(f.row('Included applications').visible, false);
  assert.equal(f.row('Excluded applications').visible, true);
});

test('closing disconnects manually owned settings subscriptions', () => {
  const f = fixture(); const ownedIds = [...f.controls._ids];
  f.window.emit('close-request');
  assert.ok(ownedIds.every(id => !f.listeners.has(id)));
  f.controls.dispose();
});

test('switching preference views preserves effect settings and reuses advanced widgets', () => {
  const f = fixture({'dock-blur-radius': 3, 'menu-blur-radius': 20, 'menu-scale': 0.83});
  const before = new Map(f.values);
  assert.deepEqual(f.row('Settings view').model, ['Simple', 'Advanced']);
  f.row('Settings view').selected = 1;
  const count = f.widgets.length;
  assert.equal(f.row('Glass').visible, false);
  f.row('Settings view').selected = 0;
  assert.equal(f.row('Glass').visible, true);
  f.row('Settings view').selected = 1;
  assert.equal(f.widgets.length, count);
  for (const [key, value] of before) if (key !== 'preferences-advanced') assert.deepEqual(f.values.get(key), value, key);
  assert.ok(f.writes.every(patch => Object.keys(patch).join() === 'preferences-advanced'));
});

test('persisted advanced view opens without writes and exposes every surface', () => {
  const f = fixture({'preferences-advanced': true});
  const selector = f.row('Surface');
  for (let i = 0; i < selector.model.length; i++) selector.selected = i;
  assert.equal(f.writes.length, 0);
  const ownedIds = [...f.controls._ids];
  f.controls.dispose();
  assert.ok(ownedIds.every(id => !f.listeners.has(id)));
});

test('advanced surface edit changes only its own setting', () => {
  const f = fixture({'preferences-advanced': true});
  f.row('Surface').selected = 1;
  const group = f.window.children[0].children.find(group => group.title === 'Calendar');
  group.children.find(row => row.title === 'Blur').value = 17;
  assert.deepEqual(f.writes, [{'menu-blur-radius': 17}]);
  assert.match(f.row('Blur').subtitle, /Custom/);
  f.row('Surface').selected = 0;
  assert.equal(group.visible, false);
});

test('detected menus preserve exclusions and support legacy Vitals controls', () => {
  const f = fixture({'preferences-advanced': true, 'detected-extra-menus': ['vitalsMenu', 'exampleMenu'],
    'disabled-extra-menus': ['missingMenu', 'exampleMenu']});
  assert.equal(f.row('example Menu').active, false);
  f.row('example Menu').active = true;
  assert.deepEqual(f.values.get('disabled-extra-menus'), ['missingMenu']);
  f.row('Vitals').active = false;
  assert.equal(f.values.get('enable-vitals-menu-glass'), false);
  f.controls.write({'detected-extra-menus': []});
  assert.equal(f.row('No additional menus detected').visible, true);
});

test('advanced groups sit above the always-visible groups on each page', () => {
  const f = fixture({'preferences-advanced': true});
  const titles = name => f.window.children.find(page => page.title === name).children
    .filter(group => group.visible !== false).map(group => group.title);
  const effects = titles('Effects'), rendering = titles('Rendering');
  assert.ok(effects.indexOf('Individual effects') < effects.indexOf('Application windows'), effects.join(' | '));
  assert.ok(rendering.indexOf('Blur') < rendering.indexOf('Compatibility'), rendering.join(' | '));
  assert.ok(rendering.indexOf('Shadows') < rendering.indexOf('Troubleshooting'), rendering.join(' | '));
});

test('a fresh install shows the default shadow as the Soft preset, not Custom', () => {
  const f = fixture();
  assert.equal(f.row('Shadows').selected, 1);
});
