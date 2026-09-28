# Preferences

The preferences window has three pages: Appearance, Effects and Advanced.
Appearance has seven shared controls, rather than repeating the same controls for
each surface. Low-level offsets, spring parameters and sampling intervals are no
longer exposed in the window. Existing schema keys remain available for compatibility.

Opening preferences must not write any settings. Different existing values are
shown as Custom and are retained until an explicit edit. A shared edit updates only
that control's keys, including disabled surfaces, in one delayed GSettings transaction.
No migration or reset runs on open. Custom is a status, not a preset or saved undo point.
Smooth motion sets critically damped springs; it does not run automatically.

`preferences/pages.js` defines the visible choices. `model.js` defines which existing
keys those choices own. `controls.js` owns grouped writes, mixed-value readouts and
subscriptions. `windows.js` owns the application picker and its D-Bus lifetime.
The preferences entry point only loads this window; it does not import Shell modules.

Verification:

```sh
node --test --test-isolation=none tests/preferences.test.cjs
GSETTINGS_BACKEND=memory gjs -m tests/preferences-smoke.mjs
```

The second test needs a graphical session and uses actual GTK/libadwaita widgets;
it refuses to run without the isolated memory backend. Neither test changes the
user's profile. The GTK test covers construction and editing, not a visual audit.

Ship the `preferences/` directory alongside `prefs.js`. When using
`gnome-extensions pack`, include it with `--extra-source=preferences` in addition to
the existing runtime files (`dist`, `shaders` and `resources.gresource`). Reopen the
preferences window to load an update; restarting GNOME is not necessary.

Native widget and transaction behavior follow the upstream documentation for
[libadwaita preferences](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/class.PreferencesWindow.html)
and [GSettings delayed writes](https://docs.gtk.org/gio/class.Settings.html).
