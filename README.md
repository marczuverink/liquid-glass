# Liquid Glass for GNOME Shell

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![GNOME Shell](https://img.shields.io/badge/GNOME-50-green.svg)

A GNOME Shell Extension that replicates the "Liquid Glass" UI concept using shaders on your desktop.

> [!NOTE]
> **Disclaimer:** This is an unofficial, community-driven fan project and is not affiliated with, endorsed by, or connected to Apple Inc. in any way.

I love the look of Apple's Liquid Glass, but since I don't own any Apple products (I use an Android smartphone and a Linux computer), I wanted a way to see it on my desktop every day. So, I decided to build it myself.

## Demo

Dash to Dock:

![Dash to Dock Screenshot](assets/demo2.png)

Notifications:

![Notifications Screenshot](assets/demo3.png)

Panel Menus:

![Panel Menu Screenshot](assets/demo4.png)

Quick Settings (Background mode):

![Quick Settings Screenshot](assets/demo5.png)

Quick Settings (Toggle mode, Adwaita theme):

![Quick Settings Toggle Mode with Adwaita Screenshot](assets/toggle-adwaita.png)

Quick Settings (Toggle mode, MacTahoe theme):

![Quick Settings Toggle Mode with MacTahoe Screenshot](assets/toggle-mactahoe.png)

> The screenshot above uses the [MacTahoe GTK theme](https://github.com/vinceliuice/MacTahoe-gtk-theme) by vinceliuice. The theme is not bundled with this extension and has to be installed separately.

Application Windows:

![Application Window Screenshot](assets/window.png)

OSD:

![OSD Screenshot](assets/demo6.png)


## Installation (GNOME Extension)

> [!IMPORTANT]
> This extension is **not yet available on [extensions.gnome.org](https://extensions.gnome.org)**. It has been submitted, but is still unreviewed, so for now it has to be installed manually using one of the methods below.

### Option 1: Quick Install (Terminal)
Copy and paste this one-liner to clone and install it immediately:

```bash
git clone https://github.com/ryohsuke1231/liquid-glass.git && \
mkdir -p ~/.local/share/gnome-shell/extensions/ && \
cp -r liquid-glass/liquid-glass@thinkingcoding1231.gmail.com ~/.local/share/gnome-shell/extensions/
```

### Option 2: Manual Install
1. Clone this repository: `git clone https://github.com/ryohsuke1231/liquid-glass.git`
2. Open the `liquid-glass` folder.
3. Copy the **entire `liquid-glass@thinkingcoding1231.gmail.com` folder** to:
   `~/.local/share/gnome-shell/extensions/`
4. **Restart GNOME Shell**:
   - **Wayland**: Log out and log back in.
   - **X11**: Press `Alt` + `F2`, type `r`, and hit `Enter`.
5. Enable **Liquid Glass** in the "Extensions" app or Extension Manager.


## Preferences

- **Appearance** — shared blur, corners and tint; animations, automatic text contrast and matching menu heights.
- **Effects** — choose where glass appears: dock, menus, popups and application windows.
- **Advanced** — rendering quality, refraction, edge lighting, shadows and diagnostics.

Opening the window preserves your configuration. **Custom** means your existing
values differ or do not match a preset. Editing a shared control applies its value
to every surface; it does not enable disabled effects. Choose **Smooth** for
non-bouncing menu animations.

Application glass supports either selected applications or all applications with
exclusions. Add applications from the running-window picker; manual IDs are optional.
Quick Settings can cover the whole menu or individual buttons under Advanced.

Low-level settings remain in the schema for compatibility, but are no longer repeated
across separate pages. See [Preferences](docs/preferences.md) for behavior and tests.


## The WebGL/Three.js Prototype (The Lab)

Before writing the GNOME implementation in GJS/Clutter, I built a standalone WebGL prototype using Three.js to perfect the math, shaders, and real-time tuning.

![Three.js Prototype Preview](assets/image.png)

You can run the web prototype locally:
```bash
cd prototypes/sandbox-threejs
npm install
npm run dev
```


## Development & AI Usage

This project is written in TypeScript and compiled to GJS. To build it:

```bash
cd liquid-glass@thinkingcoding1231.gmail.com
npm install
npm run build
```

The [source layout and test instructions](docs/architecture.md) describe module ownership and renderer lifecycle constraints.

A significant part of this codebase was written with the help of AI coding assistants, primarily **Claude (Anthropic)**, used for implementation, shader debugging, and refactoring. The design, the shader math, the architecture decisions, and all of the testing on real hardware are mine, and every change is reviewed before it lands.


## Roadmap
- [x] Perfect the WebGL/Three.js Prototype
- [x] Port GLSL shaders to GNOME Shell
- [x] Apply Liquid Glass to Top Panel Menus
- [x] Add Dash to Dock support
- [x] Add Notifications support
- [x] Add Settings Feature
- [x] Add Adaptive Text Coloring
- [x] Add Quick Settings support (Background mode)
- [x] Add OSD support
- [x] Add Quick Settings Toggle mode (per-toggle glass)
- [x] Add Application Window support (originally by [@hoshizora-chi](https://github.com/hoshizora-chi))
- [ ] Improve performance
- [ ] Publish to extensions.gnome.org (not approved yet)


## License

MIT. See [LICENSE](LICENSE).
