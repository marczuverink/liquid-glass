import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

const PLACES = [
  ['top-left', 'Top left'],
  ['top-right', 'Top right'],
  ['bottom-left', 'Bottom left'],
  ['bottom-right', 'Bottom right'],
  ['center', 'Centre'],
];

const WIDGETS = [
  ['weather', 'Weather', 'From GNOME Weather, or Open-Meteo for the location below'],
  ['events', 'Up next', 'The rest of today and tomorrow from your calendars'],
  ['media', 'Now playing', 'Shown while a music or video player is running'],
];

function draggedPositions(settings) {
  try {
    return JSON.parse(settings.get_value('desktop-item-positions').deep_unpack()) ?? {};
  } catch {
    return {};
  }
}

// A place on the desktop for `key`. The item `id` may have been dragged
// elsewhere, which the row reports; picking a place puts it back there.
function placeRow(group, controls, title, key, id) {
  const settings = controls.settings;
  const row = new Adw.ComboRow({title,
    model: Gtk.StringList.new([...PLACES.map(([, name]) => name), 'Where it was dragged'])});
  group.add(row);
  let syncing = false;
  const refresh = () => {
    syncing = true;
    const dragged = id ? id in draggedPositions(settings)
      : Object.keys(draggedPositions(settings)).some(item => item !== 'clock');
    const index = PLACES.findIndex(([value]) => value === settings.get_value(key).deep_unpack());
    row.selected = dragged ? PLACES.length : Math.max(index, 0);
    syncing = false;
  };
  row.connect('notify::selected', () => {
    if (syncing) return;
    // "Where it was dragged" only reports; it cannot be picked.
    if (row.selected >= PLACES.length) {
      refresh();
      return;
    }
    const positions = draggedPositions(settings);
    for (const item of Object.keys(positions)) {
      if (id ? item === id : item !== 'clock') delete positions[item];
    }
    controls.write({[key]: PLACES[row.selected][0], 'desktop-item-positions': JSON.stringify(positions)});
  });
  controls.watch([key, 'desktop-item-positions'], refresh);
  return row;
}

function fontRow(group, controls) {
  const settings = controls.settings;
  const row = new Adw.ActionRow({title: 'Font', subtitle: 'The interface font in bold unless you pick one'});
  const button = new Gtk.FontDialogButton({valign: Gtk.Align.CENTER, level: Gtk.FontLevel.FACE,
    dialog: new Gtk.FontDialog({title: 'Clock Font'})});
  const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
    tooltip_text: 'Use the interface font', css_classes: ['flat']});
  row.add_suffix(button);
  row.add_suffix(reset);
  group.add(row);
  let syncing = false;
  controls.watch(['glass-clock-font'], () => {
    syncing = true;
    const value = settings.get_value('glass-clock-font').deep_unpack();
    button.font_desc = Pango.FontDescription.from_string(value || 'Sans Bold');
    reset.sensitive = value !== '';
    syncing = false;
  });
  button.connect('notify::font-desc', () => {
    if (syncing || !button.font_desc) return;
    const desc = button.font_desc.copy();
    desc.unset_fields(Pango.FontMask.SIZE);
    controls.write({'glass-clock-font': desc.to_string()});
  });
  reset.connect('clicked', () => controls.write({'glass-clock-font': ''}));
}

function entryRow(group, controls, title, key, {read = v => v, write = v => v, valid = () => true} = {}) {
  const row = new Adw.EntryRow({title, show_apply_button: true});
  group.add(row);
  controls.watch([key], () => { row.text = read(controls.settings.get_value(key).deep_unpack()); });
  row.connect('apply', () => {
    const text = row.text.trim();
    if (!valid(text)) {
      row.add_css_class('error');
      return;
    }
    row.remove_css_class('error');
    controls.write({[key]: write(text)});
  });
  return row;
}

function addClock(page, controls) {
  const group = controls.group(page, 'Glass clock', 'A large clock whose digits are glass. Drag it to move it.');
  const show = controls.toggle(group, 'Show the clock', 'enable-glass-clock');
  const rows = [
    placeRow(group, controls, 'Place', 'glass-clock-position', 'clock'),
    controls.number(group, 'Size', ['glass-clock-size'], 48, 480, 1, '', {slider: true}),
    controls.choice(group, 'Time format', [
      {title: 'As in Settings', patch: {'glass-clock-format': 'system'}},
      {title: '24-hour', patch: {'glass-clock-format': '24h'}},
      {title: '12-hour', patch: {'glass-clock-format': '12h'}},
    ], '', false),
    controls.toggle(group, 'Show the date', 'glass-clock-show-date'),
    controls.number(group, 'Blur', ['glass-clock-blur-radius'], 0, 30, 1, '', {slider: true}),
    controls.number(group, 'Tint strength', ['glass-clock-tint-strength'], 0, 1, 0.01, '', {slider: true}),
  ];
  fontRow(group, controls);
  controls.watch(['enable-glass-clock'], () => {
    for (const row of rows) row.sensitive = show.active;
  });
}

function addWidgets(page, controls) {
  const settings = controls.settings;
  const group = controls.group(page, 'Widgets',
    'Cards of glass on the desktop, below the windows. Drag one to move it.');
  const show = controls.toggle(group, 'Show widgets', 'enable-desktop-widgets');
  const rows = [];
  for (const [id, title, subtitle] of WIDGETS) {
    const row = new Adw.SwitchRow({title, subtitle});
    group.add(row);
    let syncing = false;
    controls.watch(['desktop-widgets'], () => {
      syncing = true;
      row.active = settings.get_strv('desktop-widgets').includes(id);
      syncing = false;
    });
    row.connect('notify::active', () => {
      if (syncing) return;
      const chosen = new Set(settings.get_strv('desktop-widgets'));
      if (row.active) chosen.add(id);
      else chosen.delete(id);
      controls.write({'desktop-widgets': WIDGETS.map(([w]) => w).filter(w => chosen.has(w))});
    });
    rows.push(row);
  }
  rows.push(placeRow(group, controls, 'Place', 'desktop-widgets-position', null));
  rows.push(entryRow(group, controls, 'Weather location without GNOME Weather', 'weather-location'));
  rows.push(controls.choice(group, 'Temperature', [
    {title: 'Automatic', patch: {'weather-temperature-unit': 'auto'}},
    {title: 'Celsius', patch: {'weather-temperature-unit': 'celsius'}},
    {title: 'Fahrenheit', patch: {'weather-temperature-unit': 'fahrenheit'}},
  ], '', false));
  controls.watch(['enable-desktop-widgets'], () => {
    for (const row of rows) row.sensitive = show.active;
  });
}

function addLauncher(page, controls) {
  const group = controls.group(page, 'Launcher',
    'A search field on glass, with the same results as the overview\'s search.');
  const show = controls.toggle(group, 'Search launcher', 'enable-launcher');
  const shortcut = entryRow(group, controls, 'Shortcut', 'launcher-shortcut', {
    read: value => value[0] ?? '',
    write: text => [text],
    valid: text => {
      const [ok, key] = Gtk.accelerator_parse(text);
      return ok && key !== 0;
    },
  });
  controls.watch(['enable-launcher'], () => { shortcut.sensitive = show.active; });
}

export function buildDesktopPage(page, controls) {
  addClock(page, controls);
  addWidgets(page, controls);
  addLauncher(page, controls);
}
