// Drives the real Liquid Glass extension (and Dash to Dock) in the headless
// shell started by run-glass.sh. Reports through "[drv] ..." log lines and
// PNGs in $LG_SPIKE_OUT, then terminates the shell.
//
// Scenarios ($LG_DRV_SCENARIO):
//   dock       the dock over windows, a changing background and UI actors
//   ui         the calendar menu, Quick Settings, a notification and the OSD
//   toggles    Quick Settings in toggle mode
//   fullstage  how many frames redraw the whole stage while the calendar opens
//   monitor    global._lgGlass.monitor() while windows move and a menu opens
//   lifecycle  disables and enables Liquid Glass with every glass shown once
//   window     application glass on a foot window: drag, a busy window behind,
//              a change in front, minimise, resize and close
//   bench      global._lgBench.run() (run-glass.sh with LG_BENCH=1); LG_DRV_BENCH
//              picks scenarios (comma separated, default all), LG_DRV_BENCH_SECONDS
//              the seconds per scenario (default 3), LG_DRV_BENCH_AB=1 adds a run without UI glass
//
// Screenshots are off-stage paints, where a stage-reading glass draws with
// its last on-screen copy. The camera shows what was really on screen: while
// armed it copies a stage rect out of the framebuffer on every frame and
// draws that copy, so a screenshot of the camera is the on-screen result.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT_DIR = GLib.getenv('LG_SPIKE_OUT') ?? GLib.get_tmp_dir();
const SCENARIO = GLib.getenv('LG_DRV_SCENARIO') ?? 'dock';
const LG_UUID = 'liquid-glass@thinkingcoding1231.gmail.com';
const COLORS = ['rgb(255,0,255)', 'rgb(255,255,0)'];

function log(msg) {
  console.log(`[drv] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);

// The same version split as the extension's shellVersion.ts.
function coglContext() {
  const backend = SHELL_MAJOR >= 48 ? global.stage.context.get_backend() : Clutter.get_default_backend();
  return backend.get_cogl_context();
}

// GNOME 46 calls paint_node without the paint context; see paintNodeWithContext()
// in the extension's shellVersion.ts.
function paintNodeWithContext(klass) {
  if (SHELL_MAJOR >= 47)
    return klass;
  const proto = klass.prototype;
  const paintNode = proto.vfunc_paint_node;
  delete proto.vfunc_paint_node;
  const parentPaint = Object.getPrototypeOf(proto).vfunc_paint;
  proto.vfunc_paint = function (paintContext) {
    const root = Clutter.ClipNode.new();
    paintNode.call(this, root, paintContext);
    root.paint(paintContext);
    parentPaint.call(this, paintContext);
  };
  return klass;
}

function newRootNode(framebuffer, colorState) {
  if (SHELL_MAJOR >= 48)
    return Clutter.RootNode.new(framebuffer, colorState, new Cogl.Color(), 0);
  return Clutter.RootNode.new(framebuffer, SHELL_MAJOR >= 47 ? new Cogl.Color() : new Clutter.Color(), 0);
}

function shot(name, [x, y, w, h]) {
  return new Promise(resolve => {
    const path = `${OUT_DIR}/${name}.png`;
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    new Shell.Screenshot().screenshot_area(x, y, w, h, stream, (obj, res) => {
      try {
        obj.screenshot_area_finish(res);
      } catch (e) {
        log(`shot ${name} failed: ${e}`);
      }
      stream.close(null);
      resolve();
    });
  });
}

const Camera = GObject.registerClass(paintNodeWithContext(
class Camera extends Clutter.Actor {
  _init(rect) {
    super._init({name: 'drv-camera', reactive: false});
    this.rect = rect;
    this.tex = null;
    this.off = null;
    this.armed = false;
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(root, paintContext) {
    const fb = paintContext.get_framebuffer();
    const view = this.peek_stage_views().find(v => v.get_framebuffer() === fb);
    if (this.armed && view && !this.is_in_clone_paint()) {
      const s = view.get_scale();
      const l = view.layout;
      const [x, y, w, h] = this.rect;
      const fx = Math.floor(x * s) + Math.round(-l.x * s);
      const fy = Math.floor(y * s) + Math.round(-l.y * s);
      const fw = Math.ceil(w * s);
      const fh = Math.ceil(h * s);
      if (!this.tex || this.tex.get_width() !== fw || this.tex.get_height() !== fh) {
        this.tex = Cogl.Texture2D.new_with_size(coglContext(), fw, fh);
        this.off = Cogl.Offscreen.new_with_texture(this.tex);
        this.off.allocate();
      }
      const target = newRootNode(this.off, view.color_state);
      root.add_child(target);
      const blit = Clutter.BlitNode.new(fb);
      blit.add_blit_rectangle(fx, fy, 0, 0, fw, fh);
      target.add_child(blit);
    }
    if (!this.tex)
      return;
    const pipeline = Cogl.Pipeline.new(coglContext());
    pipeline.set_layer_texture(0, this.tex);
    const node = Clutter.PipelineNode.new(pipeline);
    const [w, h] = this.get_size();
    node.add_texture_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}), 0, 0, 1, 1);
    root.add_child(node);
  }
}));

// Paints nothing; records whether each frame redrew the whole stage.
const ClipProbe = GObject.registerClass(paintNodeWithContext(
class ClipProbe extends Clutter.Actor {
  _init(rect) {
    super._init({name: 'drv-clip-probe', reactive: false});
    this.set_position(rect[0], rect[1]);
    this.set_size(rect[2], rect[3]);
    this.rect = rect;
    this.last = null;
  }

  vfunc_pick(_pickContext) {
  }

  vfunc_paint_node(_root, paintContext) {
    const clip = paintContext.get_redraw_clip();
    const [x, y, width, height] = this.rect;
    this.last = clip
      ? ['OUT', 'IN', 'PART'][clip.contains_rectangle(new Mtk.Rectangle({x, y, width, height}))]
      : 'NOCLIP';
  }
}));

function lg() {
  return global._lgGlass;
}

function glassRows() {
  const out = lg()?.dump() ?? '';
  const rows = [];
  for (const line of out.split('\n')) {
    try {
      rows.push(JSON.parse(line));
    } catch {
    }
  }
  return rows;
}

function glassRow(owner) {
  return glassRows().find(r => r.owner === owner) ?? null;
}

function delta(a, b) {
  if (!a || !b)
    return 'n/a';
  return Object.keys(a).filter(k => typeof a[k] === 'number').map(k => `${k}=${b[k] - a[k]}`).join(' ');
}

export default class LgDriver extends Extension {
  enable() {
    this._actors = [];
    this._procs = [];
    this._signals = [];
    this._frames = 0;
    this._camera = null;
    this._signals.push([global.stage, global.stage.connect('after-paint', () => this._frames++)]);
    this._signals.push([global.stage, global.stage.connect('before-update', () => {
      if (this._camera?.armed)
        this._camera.queue_redraw();
    })]);
    // Disabling Liquid Glass makes the shell disable and enable the
    // extensions enabled after it, possibly this one: run the scenario once.
    if (globalThis._lgDriverStarted)
      return;
    globalThis._lgDriverStarted = true;
    this._run().catch(e => log(`FAILED ${e}\n${e.stack}`)).finally(() => this._finish());
  }

  disable() {
    for (const [obj, id] of this._signals)
      obj.disconnect(id);
    this._signals = [];
    for (const actor of this._actors)
      actor.destroy();
    this._actors = [];
    for (const proc of this._procs)
      proc.force_exit();
    this._procs = [];
  }

  async _run() {
    if (Main.layoutManager._startingUp) {
      await new Promise(resolve => {
        const id = Main.layoutManager.connect('startup-complete', () => {
          Main.layoutManager.disconnect(id);
          resolve();
        });
      });
    }
    if (Main.overview.visible)
      Main.overview.hide();
    await sleep(1500);
    // A banner's glass redraws while it is shown; the scenarios want a quiet stage.
    for (const source of Main.messageTray.getSources())
      source.destroy();
    await sleep(1500);
    for (const view of global.stage.peek_stage_views()) {
      const l = view.layout;
      log(`view layout=[${l.x},${l.y},${l.width},${l.height}] scale=${view.get_scale()}`);
    }
    this._camera = this._add(new Camera([0, 0, 10, 10]));
    this._camera.set_position(20, 60);
    for (let i = 0; i < 40 && !this._glass('dock'); i++)
      await sleep(250);

    if (SCENARIO === 'dock')
      await this._dockScenario();
    else if (SCENARIO === 'ui')
      await this._uiScenario();
    else if (SCENARIO === 'toggles')
      await this._togglesScenario();
    else if (SCENARIO === 'fullstage')
      await this._fullStageScenario();
    else if (SCENARIO === 'monitor')
      await this._monitorScenario();
    else if (SCENARIO === 'lifecycle')
      await this._lifecycleScenario();
    else if (SCENARIO === 'window')
      await this._windowScenario();
    else if (SCENARIO === 'bench')
      await this._benchScenario();
    log(`dump\n${lg().dump()}`);
  }

  _add(actor, below = null) {
    if (below)
      Main.layoutManager.uiGroup.insert_child_below(actor, below);
    else
      Main.layoutManager.uiGroup.add_child(actor);
    this._actors.push(actor);
    return actor;
  }

  _drop(actor) {
    actor.destroy();
    this._actors = this._actors.filter(a => a !== actor);
  }

  _lgSettings() {
    return Extension.lookupByUUID(LG_UUID).getSettings();
  }

  // Rebuilds one surface's glass by switching it off and on.
  async _rebuild(key) {
    const settings = this._lgSettings();
    settings.set_boolean(key, false);
    await sleep(300);
    settings.set_boolean(key, true);
    await sleep(2500);
  }

  _glass(owner) {
    return lg()?.glassObjects().find(g => g._owner === owner) ?? null;
  }

  _stats(owner) {
    return this._glass(owner)?.stats ?? null;
  }

  // A glass's rect plus room for its shadow, in stage coordinates.
  _region(owner) {
    let g = lg()?.geom(owner)[0];
    // Toggle mode draws regions; its composite rect covers them.
    if (!(g?.w > 0)) {
      const r = glassRow(owner)?.compositeRect ?? glassRow(owner)?.u?.compositeRect;
      g = r ? {x: r[0], y: r[1], w: r[2], h: r[3]} : null;
    }
    if (!g || !(g.w > 0))
      return null;
    const m = Main.layoutManager.primaryMonitor;
    const x = Math.max(0, Math.floor(m.x + g.x - 40));
    const y = Math.max(0, Math.floor(m.y + g.y - 40));
    const w = Math.min(m.width - x, Math.ceil(g.w + 80));
    const h = Math.min(m.height - y, Math.ceil(g.h + 80));
    return [x, y, w, h];
  }

  async _shots(tag, rect, owner) {
    this._camera.rect = rect;
    this._camera.set_size(rect[2], rect[3]);
    this._camera.armed = true;
    // On a quiet stage nothing else asks for a frame.
    this._camera.queue_redraw();
    await sleep(200);
    const name = tag.replace(/ /g, '-');
    await shot(`${name}-screen`, rect);
    await shot(`${name}-camera`, [this._camera.x, this._camera.y, rect[2], rect[3]]);
    this._camera.armed = false;
    const row = glassRow(owner);
    if (!row) {
      log(`${tag}: no ${owner} glass row`);
      return;
    }
    const keys = ['mode', 'paints', 'copies', 'reuses', 'offStage', 'misses', 'materialCopies', 'blurRuns',
      'blurSkips', 'relayChanges', 'copy', 'desktop', 'material', 'blurRect', 'composited'];
    const picked = Object.fromEntries(keys.filter(k => k in row).map(k => [k, row[k]]));
    log(`${tag} frames=${this._frames} ${JSON.stringify(picked)} relays=${JSON.stringify(row.relays ?? null)}`);
  }

  // A window that redraws every frame. glxgears needs an X server, which the
  // shell in a distrobox runs without; there a terminal printing without
  // pause stands in.
  _spawnGears() {
    if (GLib.getenv('DISPLAY') && GLib.find_program_in_path('glxgears'))
      return this._spawn(['glxgears'], 'gears');
    return this._spawn(['foot', '-T', 'lgdrv-gears', 'sh', '-c', 'while :; do echo $RANDOM$RANDOM$RANDOM; done'], 'gears');
  }

  async _spawn(argv, title) {
    let proc;
    try {
      proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
      log(`spawn ${argv[0]} failed: ${e}`);
      return null;
    }
    this._procs.push(proc);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const actor = global.get_window_actors().find(a => (a.get_meta_window()?.get_title() ?? '').includes(title));
      if (actor)
        return {proc, actor, win: actor.get_meta_window()};
    }
    log(`no window for ${title}`);
    return null;
  }

  // Runs `step` between frames and checks the frame after each step: with
  // the backdrop changing behind the glass, that frame must take a new copy.
  // With `expectCopy` false (a change in front of the glass), it must not.
  async _audit(tag, owner, steps, intervalMs, step, expectCopy = true) {
    const glass = typeof owner === 'string' ? this._glass(owner) : owner;
    if (!glass) {
      log(`${tag} audit: no stage-reading ${owner} glass`);
      return;
    }
    const rec = [];
    let prev = glass.stats;
    let pending = false;
    const id = global.stage.connect('after-paint', () => {
      const cur = glass.stats;
      if (pending) {
        rec.push({painted: cur.paints > prev.paints, copied: cur.copies > prev.copies,
          reused: cur.reuses > prev.reuses, missed: cur.misses > prev.misses});
      }
      pending = false;
      prev = cur;
    });
    for (let i = 0; i < steps; i++) {
      step(i);
      pending = true;
      await sleep(intervalMs);
    }
    await sleep(100);
    global.stage.disconnect(id);
    const count = f => rec.filter(f).length;
    const bad = expectCopy ? count(r => !r.copied || !r.painted) : count(r => r.copied);
    log(`${tag} audit steps=${steps} frames=${rec.length} painted=${count(r => r.painted)} ` +
      `copied=${count(r => r.copied)} reused=${count(r => r.reused)} missed=${count(r => r.missed)} ` +
      `${expectCopy ? 'stale' : 'needless-copy'}=${bad} ${bad === 0 ? 'OK' : 'NG'}`);
  }

  // Frames and glass counters over a quiet period; both should stay put.
  async _idle(tag, owner, ms) {
    const before = this._stats(owner);
    const frames = this._frames;
    await sleep(ms);
    log(`${tag} idle ${ms}ms frames=${this._frames - frames} ${delta(before, this._stats(owner))}`);
  }

  // A plain widget behind a glass in paint order, inside `rect`.
  _behind(owner, rect, w = 120, h = 60) {
    const glass = this._glass(owner);
    const anchor = glass?.reader ?? glass;
    const widget = new St.Widget({name: `drv-behind-${owner}`, reactive: false, style: `background-color: ${COLORS[1]};`});
    widget.set_position(rect[0] + 60, rect[1] + 60);
    widget.set_size(w, h);
    return this._add(widget, anchor?.get_parent() === Main.layoutManager.uiGroup ? anchor : null);
  }

  // Counts whole-stage redraws while `run` runs.
  async _countFullStage(run) {
    const m = Main.layoutManager.primaryMonitor;
    const probe = this._add(new ClipProbe([m.x, m.y, m.width, m.height]));
    let frames = 0, full = 0;
    const id = global.stage.connect('after-paint', () => {
      frames++;
      if (probe.last === 'IN')
        full++;
      probe.last = null;
    });
    await run();
    global.stage.disconnect(id);
    this._drop(probe);
    return `frames=${frames} full-stage=${full}`;
  }

  async _dockScenario() {
    const region = this._region('dock');
    if (!region) {
      log('no dock glass');
      return;
    }
    log(`dock region=${JSON.stringify(region)}`);
    await this._shots('d0 baseline', region, 'dock');
    await this._idle('d0', 'dock', 2000);

    // An actor behind the glass and one in front of it.
    const [rx, ry, rw] = region;
    const behind = this._behind('dock', region);
    const front = this._add(new St.Widget({name: 'drv-front', reactive: false, style: 'background-color: rgb(0,255,255);'}));
    front.set_position(rx + rw - 140, ry + 50);
    front.set_size(30, 30);
    await sleep(500);
    await this._audit('d0a behind-colour', 'dock', 10, 120, i => behind.set_style(`background-color: ${COLORS[i % 2]};`));
    await this._audit('d0b behind-move', 'dock', 10, 120, i => { behind.translation_x = (i + 1) * 12; });
    await this._audit('d0c front-colour', 'dock', 10, 120, i => front.set_style(`background-color: ${COLORS[i % 2]};`), false);
    this._drop(behind);
    this._drop(front);
    await sleep(300);

    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-o', 'cursor.blink=no', '-T', 'lgdrv-a'], 'lgdrv-a');
    if (a) {
      a.win.move_resize_frame(true, rx + 80, ry - 300, 420, 380);
      await sleep(1200);
      await this._shots('d1 window', region, 'dock');
      await this._idle('d1', 'dock', 2000);
      await this._audit('d2 window-drag', 'dock', 20, 50, i => a.win.move_frame(true, rx + 80 + (i + 1) * 15, ry - 300));
      await sleep(300);
      await this._shots('d2 moved', region, 'dock');
    }

    const g = await this._spawnGears();
    if (g) {
      g.win.move_frame(true, rx + rw - 350, ry - 150);
      await sleep(800);
      await this._audit('d3 gears', 'dock', 30, 40, () => {});
      g.proc.force_exit();
      await sleep(800);
      await this._shots('d3b gears-gone', region, 'dock');
    }

    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', '#2050c0');
    await sleep(1500);
    await this._shots('d5 background', region, 'dock');

    if (a) {
      a.win.move_frame(true, rx + 200, ry - 200);
      await sleep(800);
    }
    await this._shots('d6 backdrop', region, 'dock');
    await this._rebuild('enable-dock-glass');
    await this._shots('d7 rebuilt', region, 'dock');
  }

  // Opens, checks and closes one menu-like surface.
  async _surface(tag, owner, open, close, keepOpen = () => {}) {
    const dockBefore = this._stats('dock');
    const full = await this._countFullStage(async () => {
      open();
      await sleep(1200);
    });
    const opening = `${full}, dock ${delta(dockBefore, this._stats('dock'))}`;
    const region = this._region(owner) ?? this._menuRegion();
    if (!region) {
      log(`${tag} no ${owner} glass`);
      close();
      await sleep(800);
      return;
    }
    log(`${tag} region=${JSON.stringify(region)} opening: ${opening}`);
    await this._shots(`${tag} open`, region, owner);
    await this._idle(tag, owner, 1500);
    keepOpen();
    await sleep(200);
    const behind = this._behind(owner, region);
    await sleep(300);
    await this._audit(`${tag} behind-colour`, owner, 10, 120, i => behind.set_style(`background-color: ${COLORS[i % 2]};`));
    keepOpen();
    await sleep(200);
    await this._audit(`${tag} behind-move`, owner, 10, 120, i => { behind.translation_x = (i + 1) * 8; });
    keepOpen();
    await sleep(200);
    await this._shots(`${tag} behind`, region, owner);
    this._drop(behind);
    const dockBeforeClose = this._stats('dock');
    close();
    await sleep(1200);
    log(`${tag} closing: dock ${delta(dockBeforeClose, this._stats('dock'))}`);
  }

  // Quick Settings' menu on screen, for toggle mode, whose glass has regions
  // rather than one rect.
  _menuRegion() {
    const actor = Main.panel.statusArea.quickSettings.menu.actor;
    const ext = actor.get_transformed_extents();
    if (!(ext.size.width > 0))
      return null;
    return [Math.floor(ext.origin.x), Math.floor(ext.origin.y), Math.ceil(ext.size.width), Math.ceil(ext.size.height)];
  }

  async _uiScenario() {
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    await this._surface('m1 calendar', 'menu', () => dateMenu.open(true), () => dateMenu.close(true));
    const qs = Main.panel.statusArea.quickSettings.menu;
    await this._surface('q1 quick-settings', 'quick-settings', () => qs.open(true), () => qs.close(true));
    await this._surface('n1 notification', 'notification',
      () => Main.notify('Liquid Glass driver', 'A banner over the desktop'),
      () => {
        for (const source of Main.messageTray.getSources())
          source.destroy();
      });
    const icon = Gio.ThemedIcon.new('audio-volume-high-symbolic');
    // showAll() is GNOME 49's; before, show() with no monitor index.
    const showOsd = () => SHELL_MAJOR >= 49
      ? Main.osdWindowManager.showAll(icon, 'Volume', 0.6, 1)
      : Main.osdWindowManager.show(-1, icon, 'Volume', 0.6, 1);
    await this._surface('o1 osd', 'osd', showOsd, () => Main.osdWindowManager.hideAll(), showOsd);

    await this._menuShot('m2 calendar-again', dateMenu, 'menu');
  }

  async _togglesScenario() {
    const settings = this._lgSettings();
    settings.set_int('quick-settings-apply-to', 1);
    await sleep(1500);
    const qs = Main.panel.statusArea.quickSettings.menu;
    qs.open(true);
    await sleep(1200);
    const ext = qs.actor.get_transformed_extents();
    log(`t0 menu extents=${ext.origin.x},${ext.origin.y},${ext.size.width}x${ext.size.height} ` +
      `mapped=${qs.actor.mapped} glass=${JSON.stringify(this._glass('quick-settings-toggles')?.describe() ?? null)}`);
    qs.close(true);
    await sleep(1000);
    await this._surface('t1 toggles', 'quick-settings-toggles', () => qs.open(true), () => qs.close(true));
    await this._menuShot('t2 toggles-again', qs, 'quick-settings-toggles');
  }

  async _menuShot(tag, menu, owner) {
    menu.open(false);
    await sleep(1200);
    const region = this._region(owner) ?? this._menuRegion();
    if (region)
      await this._shots(tag, region, owner);
    else
      log(`${tag}: no region`);
    menu.close(false);
    await sleep(600);
  }

  async _fullStageScenario() {
    const settings = this._lgSettings();
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    const open = async () => {
      dateMenu.open(true);
      await sleep(1200);
    };
    log(`calendar first open: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
    log(`calendar second open: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
    settings.set_boolean('enable-menu-glass', false);
    await sleep(500);
    log(`calendar without glass: ${await this._countFullStage(open)}`);
    dateMenu.close(true);
    await sleep(1000);
  }

  async _monitorScenario() {
    lg().monitor(0);
    await sleep(2200);
    const region = this._region('dock');
    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-T', 'lgdrv-a'], 'lgdrv-a');
    const g = await this._spawnGears();
    if (a && region) {
      a.win.move_frame(true, region[0] + 80, region[1] - 300);
      g?.win.move_frame(true, region[0] + region[2] - 350, region[1] - 150);
      for (let i = 0; i < 30; i++) {
        a.win.move_frame(true, region[0] + 80 + i * 10, region[1] - 300);
        await sleep(50);
      }
    }
    await sleep(1500);
    g?.proc.force_exit();
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    dateMenu.open(true);
    await sleep(2000);
    dateMenu.close(true);
    await sleep(2000);
    lg().monitorStop();
  }

  async _benchScenario() {
    const which = GLib.getenv('LG_DRV_BENCH') ?? 'all';
    const seconds = Number(GLib.getenv('LG_DRV_BENCH_SECONDS') ?? 3);
    log(global._lgBench.run(which === 'all' ? 'all' : which.split(','),
      {seconds, settle: 2, ab: GLib.getenv('LG_DRV_BENCH_AB') === '1'}));
    await sleep(1000);
    while (global._lgBench.running)
      await sleep(500);
    log(`after bench: leftovers=${JSON.stringify(this._leftovers())} windows=${global.get_window_actors().length}`);
  }

  // Our own actors left anywhere on the stage.
  _leftovers() {
    const names = [];
    const walk = a => {
      const name = a.get_name() ?? '';
      if (/^liquid-(glass|box)|^clone-container|^optimization-breaker/.test(name))
        names.push(name);
      for (const c of a.get_children())
        walk(c);
    };
    walk(global.stage);
    return names;
  }

  // The glass inside a window actor.
  _windowGlass(actor) {
    return lg()?.glassObjects().find(g => g.get_parent() === actor) ?? null;
  }

  _windowRegion(win, margin = 90) {
    const r = win.get_frame_rect();
    const m = Main.layoutManager.primaryMonitor;
    const x = Math.max(0, r.x - margin), y = Math.max(0, r.y - margin);
    return [x, y, Math.min(m.width - x, r.width + margin * 2), Math.min(m.height - y, r.height + margin * 2)];
  }

  async _windowScenario() {
    // A white desktop, where a drop shadow's banding shows most.
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', '#ffffff');
    const settings = this._lgSettings();
    settings.set_strv('application-window-whitelist', ['foot']);
    settings.set_boolean('enable-application-glass', true);
    await sleep(500);
    const b = await this._spawn(['foot', '-o', 'colors.background=20a040', '-o', 'cursor.blink=no', '-T', 'lgdrv-b'], 'lgdrv-b');
    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-o', 'cursor.blink=no', '-T', 'lgdrv-a'], 'lgdrv-a');
    if (!a || !b) {
      log('window: no windows');
      return;
    }
    b.win.move_resize_frame(true, 300, 200, 500, 400);
    a.win.move_resize_frame(true, 600, 300, 500, 400);
    a.win.activate(global.get_current_time());
    await sleep(1500);
    const glass = this._windowGlass(a.actor);
    log(`w0 glass=${glass ? JSON.stringify(glass.describe()) : 'none'} wmclass=${a.win.get_wm_class()}`);
    if (!glass)
      return;
    await this._shots('w0 window', this._windowRegion(a.win), 'application');
    await this._idle('w0', 'application', 2000);

    // The window behind moves under the glass.
    await this._audit('w1 behind-move', glass, 15, 80, i => b.win.move_frame(true, 300 + (i + 1) * 10, 200));
    // The glass's own window is dragged.
    await this._audit('w2 window-drag', glass, 20, 50, i => a.win.move_frame(true, 600 + (i + 1) * 12, 300));
    await sleep(300);
    await this._shots('w2 moved', this._windowRegion(a.win), 'application');

    // A window behind that redraws every frame.
    const g = await this._spawnGears();
    if (g) {
      const r = a.win.get_frame_rect();
      g.win.move_frame(true, r.x - 150, r.y + 100);
      a.win.activate(global.get_current_time());
      await sleep(1000);
      await this._audit('w3 gears-behind', glass, 30, 40, () => {});
      await this._shots('w3 gears', this._windowRegion(a.win), 'application');
      g.proc.force_exit();
      await sleep(800);
    }

    // A change in front of the window is not behind its glass.
    const r = a.win.get_frame_rect();
    const front = this._add(new St.Widget({name: 'drv-front', reactive: false, style: 'background-color: rgb(0,255,255);'}));
    front.set_position(r.x + 100, r.y + 100);
    front.set_size(60, 60);
    await sleep(500);
    await this._audit('w4 front-colour', glass, 10, 120, i => front.set_style(`background-color: ${COLORS[i % 2]};`), false);
    this._drop(front);

    // Resize, then minimise and restore.
    a.win.move_resize_frame(true, r.x, r.y, 640, 460);
    await sleep(1200);
    log(`w5 resized glass=${JSON.stringify({size: glass.get_size(), pos: [glass.x, glass.y]})}`);
    await this._shots('w5 resized', this._windowRegion(a.win), 'application');
    a.win.minimize();
    await sleep(1200);
    a.win.unminimize();
    a.win.activate(global.get_current_time());
    await sleep(1500);
    log(`w6 restored mapped=${glass.mapped} alloc=${glass.has_allocation()} stats=${JSON.stringify(glass.stats)}`);
    await this._shots('w6 restored', this._windowRegion(a.win), 'application');

    // Closing the window takes its glass along.
    a.proc.force_exit();
    await sleep(1500);
    log(`w7 closed glasses=${lg().glassObjects().filter(x => x._owner === 'application').length}`);
    settings.set_boolean('enable-application-glass', false);
    await sleep(800);
    log(`w8 disabled glasses=${lg().glassObjects().filter(x => x._owner === 'application').length} ` +
      `windowActorChildren=${b.actor.get_n_children()}`);
  }

  async _lifecycleScenario() {
    const settings = this._lgSettings();
    settings.set_int('quick-settings-apply-to', 1);
    await sleep(1500);
    const qs = Main.panel.statusArea.quickSettings.menu;
    const dateMenu = Main.panel.statusArea.dateMenu.menu;
    for (const menu of [qs, dateMenu]) {
      menu.open(true);
      await sleep(800);
      menu.close(true);
      await sleep(600);
    }
    Main.notify('Liquid Glass driver', 'lifecycle');
    await sleep(800);
    // Disabling has to stop a running monitor and take its probes along.
    lg().monitor(0);
    await sleep(1200);
    log(`before disable: glasses=${lg().glassObjects().length} actors=${this._leftovers().length}`);
    Main.extensionManager.disableExtension(LG_UUID);
    await sleep(1000);
    log(`after disable: _lgGlass=${global._lgGlass === undefined ? 'gone' : 'present'} leftovers=${JSON.stringify(this._leftovers())}`);
    Main.extensionManager.enableExtension(LG_UUID);
    await sleep(4000);
    const dock = this._glass('dock');
    log(`after enable: glasses=${lg()?.glassObjects().length} dock=${dock ? JSON.stringify(dock.stats) : 'none'}`);
    qs.open(true);
    await sleep(800);
    log(`toggles after enable: ${JSON.stringify(this._glass('quick-settings-toggles')?.stats ?? null)}`);
    qs.close(true);
    await sleep(600);
  }

  _finish() {
    log('DONE');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      global.context.terminate();
      return GLib.SOURCE_REMOVE;
    });
  }
}
