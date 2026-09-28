import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

const WINDOW_LIST_BUS_NAME = 'org.gnome.Shell';
const WINDOW_LIST_OBJECT_PATH = '/org/gnome/Shell/Extensions/LiquidGlass';
const WINDOW_LIST_INTERFACE_NAME = 'org.gnome.Shell.Extensions.LiquidGlass';

class WindowListClient {
  constructor() {
    this._proxy = null;
    this._proxyError = null;
    this._watchers = new Set();
    this._signalId = 0;
  }

  _ensureProxy() {
    if (this._proxy || this._proxyError)
      return this._proxy;

    try {
      this._proxy = Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
        null,
        WINDOW_LIST_BUS_NAME,
        WINDOW_LIST_OBJECT_PATH,
        WINDOW_LIST_INTERFACE_NAME,
        null);

      this._signalId = this._proxy.connect('g-signal', (_proxy, _sender, signalName) => {
        if (signalName === 'WindowsChanged')
          this._notify();
      });
    } catch (e) {
      this._proxy = null;
      this._proxyError = e;
    }

    return this._proxy;
  }

  _notify() {
    for (const watcher of [...this._watchers])
      watcher();
  }

  addWatcher(callback) {
    this._ensureProxy();
    this._watchers.add(callback);
    return () => this._watchers.delete(callback);
  }

  listWindows(callback) {
    const proxy = this._ensureProxy();
    if (!proxy) {
      callback(null, 'Could not connect to GNOME Shell.');
      return;
    }

    proxy.call('ListWindows', null, Gio.DBusCallFlags.NONE, -1, null, (source, result) => {
      let windows = null;
      let error = null;
      try {
        const [json] = source.call_finish(result).deep_unpack();
        windows = JSON.parse(json);
      } catch (e) {
        // The usual cause is the extension being disabled: the object is only
        // exported while it is running, so the call fails with UnknownMethod.
        error = 'The window list is only available while the extension is enabled.';
      }
      callback(windows, error);
    });
  }
}


export class WindowRules {
  constructor(settings, controls) {
    this.settings = settings;
    this.controls = controls;
    this.client = new WindowListClient();
    controls.onClose(() => {
      if (this.client._proxy && this.client._signalId)
        this.client._proxy.disconnect(this.client._signalId);
      this.client._watchers.clear();
    });
  }

  add(page) {
    const group = this.controls.group(page, 'Application windows');
    this.controls.toggle(group, 'Window glass', 'enable-application-glass');
    const allRow = this.controls.toggle(group, 'Include all applications', 'application-glass-all-windows');
    const opacityRow = this.controls.number(group, 'Content opacity', ['application-content-opacity'], 0, 1, 0.05);
    this.settings.bind('enable-application-glass', allRow, 'visible', Gio.SettingsBindFlags.GET);
    this.settings.bind('enable-application-glass', opacityRow, 'visible', Gio.SettingsBindFlags.GET);
    for (const [all, key, title] of [
      [false, 'application-window-whitelist', 'Included applications'],
      [true, 'application-window-blacklist', 'Excluded applications'],
    ]) {
      this._addWindowClassEditor(page, this.settings, this.client, {
        key, title, description: '', emptyTitle: 'No applications added',
        emptySubtitle: '', pickerTitle: 'Choose an application',
        activeKey: 'application-glass-all-windows', activeWhen: all,
      });
    }
  }

  _addWindowClassEditor(page, settings, client, options) {
    const { key, title, description, emptyTitle, emptySubtitle, pickerTitle, activeKey, activeWhen } = options;

    const listGroup = new Adw.PreferencesGroup({ title, description });
    page.add(listGroup);

    // Only the currently relevant application list is shown.
    this.controls.watch([activeKey, 'enable-application-glass'], () => {
      listGroup.visible = settings.get_boolean('enable-application-glass') && settings.get_boolean(activeKey) === activeWhen;
    });

    const addButton = new Gtk.Button({
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
      icon_name: 'list-add-symbolic',
      tooltip_text: pickerTitle,
    });
    addButton.connect('clicked', () => {
      this._presentWindowPicker(addButton, settings, client, key, pickerTitle);
    });
    listGroup.set_header_suffix(addButton);

    const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    listBox.add_css_class('boxed-list');
    listGroup.add(listBox);

    const refreshList = () => {
      let child = listBox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        listBox.remove(child);
        child = next;
      }

      const items = settings.get_strv(key);
      for (const item of items) {
        const row = new Adw.ActionRow({ title: item, use_markup: false });
        const removeButton = new Gtk.Button({
          icon_name: 'user-trash-symbolic',
          valign: Gtk.Align.CENTER,
          css_classes: ['flat', 'error'],
          tooltip_text: 'Remove',
        });
        removeButton.connect('clicked', () => {
          settings.set_strv(key, settings.get_strv(key).filter((v) => v !== item));
        });
        row.add_suffix(removeButton);
        listBox.append(row);
      }

      if (items.length === 0) {
        const emptyRow = new Adw.ActionRow({ title: emptyTitle, subtitle: emptySubtitle });
        emptyRow.add_css_class('dim-label');
        listBox.append(emptyRow);
      }
    };

    this.controls.watch([key], refreshList);

    // Manual entry is kept for windows that are not currently open (or that the
    // shell cannot report), but it is folded away so the picker is the default.
    const manualExpander = new Adw.ExpanderRow({
      title: 'Add by application ID',
    });
    listGroup.add(manualExpander);

    const entryRow = new Adw.EntryRow({ title: 'Application ID', show_apply_button: true });
    entryRow.connect('apply', () => {
      const value = entryRow.get_text().trim();
      if (!value) return;
      this._addWindowClass(settings, key, value);
      entryRow.set_text('');
    });
    manualExpander.add_row(entryRow);
  }

  _addWindowClass(settings, key, wmClass) {
    const value = wmClass.trim();
    if (!value) return false;

    const normalized = value.toLowerCase();
    const items = settings.get_strv(key);
    if (items.some((v) => v.toLowerCase() === normalized))
      return false;

    settings.set_strv(key, [...items, value]);
    return true;
  }

  _presentWindowPicker(parentWidget, settings, client, key, title) {
    const dialog = new Adw.Dialog({
      title,
      content_width: 500,
      content_height: 560,
    });

    const toolbarView = new Adw.ToolbarView();
    toolbarView.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(toolbarView);

    const contentBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      margin_top: 12,
      margin_bottom: 12,
      margin_start: 12,
      margin_end: 12,
    });

    const scrolled = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      vexpand: true,
      child: contentBox,
    });
    toolbarView.set_content(scrolled);

    const clearContent = () => {
      let child = contentBox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        contentBox.remove(child);
        child = next;
      }
    };

    const showStatus = (iconName, statusTitle, statusDescription) => {
      clearContent();
      contentBox.append(new Adw.StatusPage({
        icon_name: iconName,
        title: statusTitle,
        description: statusDescription,
        vexpand: true,
      }));
    };

    const showWindows = (windows) => {
      clearContent();

      if (!windows || windows.length === 0) {
        showStatus('window-symbolic', 'No open windows',
          'Open an application window and it will appear here.');
        return;
      }

      const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
      listBox.add_css_class('boxed-list');
      contentBox.append(listBox);

      const current = settings.get_strv(key).map((v) => v.toLowerCase());

      for (const info of windows) {
        const wmClass = info.wmClass;
        if (!wmClass) continue;

        const rowTitle = info.appName || wmClass;
        const details = [];
        if (rowTitle !== wmClass)
          details.push(wmClass);
        if (info.count > 1)
          details.push(`${info.count} windows`);
        if (!info.normal)
          details.push('not a normal window — the effect cannot apply');

        const row = new Adw.ActionRow({
          title: rowTitle,
          subtitle: details.join(' · '),
          use_markup: false,
          tooltip_text: (info.titles && info.titles.length) ? info.titles.join('\n') : null,
        });

        const image = new Gtk.Image({ pixel_size: 32, valign: Gtk.Align.CENTER });
        let icon = null;
        try {
          if (info.iconName)
            icon = Gio.Icon.new_for_string(info.iconName);
        } catch (e) {
          icon = null;
        }
        if (icon)
          image.set_from_gicon(icon);
        else
          image.set_from_icon_name('application-x-executable-symbolic');
        row.add_prefix(image);

        if (current.includes(wmClass.toLowerCase())) {
          const added = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Already in the list',
          });
          added.add_css_class('success');
          row.add_suffix(added);
          row.set_sensitive(false);
        } else {
          const button = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Add',
          });
          button.connect('clicked', () => this._addWindowClass(settings, key, wmClass));
          row.add_suffix(button);
          row.activatable_widget = button;
        }

        listBox.append(row);
      }
    };

    let alive = true;
    let request = 0;
    const refresh = () => {
      if (!alive) return;
      const currentRequest = ++request;
      client.listWindows((windows, error) => {
        if (!alive || currentRequest !== request) return;
        if (error)
          showStatus('dialog-warning-symbolic', 'Window list unavailable', error);
        else
          showWindows(windows);
      });
    };

    const unwatch = client.addWatcher(refresh);
    const changedId = settings.connect(`changed::${key}`, refresh);
    const cleanup = () => {
      if (!alive) return;
      alive = false;
      unwatch();
      settings.disconnect(changedId);
    };
    dialog.connect('closed', cleanup);
    this.controls.onClose(cleanup);

    showStatus('content-loading-symbolic', 'Loading…', null);
    refresh();

    dialog.present(parentWidget);
  }


}
