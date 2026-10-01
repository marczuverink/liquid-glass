// Drives the real Liquid Glass extension (and Dash to Dock) in the headless
// shell started by run-glass.sh. Reports through "[drv] ..." log lines and
// PNGs in $LG_SPIKE_OUT, then terminates the shell.
//
// Screenshots are off-stage paints, where a backdrop glass draws with its last
// on-screen copy. The camera shows what was really on screen: while armed it
// copies a stage rect out of the framebuffer on every frame and draws that
// copy, so a screenshot of the camera is the on-screen result.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT_DIR = GLib.getenv('LG_SPIKE_OUT') ?? GLib.get_tmp_dir();
const SCENARIO = GLib.getenv('LG_DRV_SCENARIO') ?? 'dock';
const LG_UUID = 'liquid-glass@thinkingcoding1231.gmail.com';

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

function coglContext() {
  return Clutter.get_default_backend().get_cogl_context();
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

const Camera = GObject.registerClass(
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
      const target = Clutter.RootNode.new(this.off, view.color_state, new Cogl.Color(), 0);
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
});

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

export default class LgDriver extends Extension {
  enable() {
    this._actors = [];
    this._procs = [];
    this._signals = [];
    this._frames = 0;
    this._signals.push([global.stage, global.stage.connect('after-paint', () => this._frames++)]);
    this._signals.push([global.stage, global.stage.connect('before-update', () => {
      if (this._camera?.armed)
        this._camera.queue_redraw();
    })]);
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
    // A banner's glass redraws every frame; the scenarios want a quiet stage.
    for (const source of Main.messageTray.getSources())
      source.destroy();
    await sleep(1500);
    for (const view of global.stage.peek_stage_views()) {
      const l = view.layout;
      log(`view layout=[${l.x},${l.y},${l.width},${l.height}] scale=${view.get_scale()}`);
    }
    if (SCENARIO === 'dock')
      await this._dockScenario();
  }

  _lgSettings() {
    return Extension.lookupByUUID(LG_UUID).getSettings();
  }

  async _rebuildDock(backdrop) {
    lg().backdrop(backdrop);
    const settings = this._lgSettings();
    settings.set_boolean('enable-dock-glass', false);
    await sleep(300);
    settings.set_boolean('enable-dock-glass', true);
    await sleep(2500);
  }

  // The dock glass's rect plus room for its shadow, in stage coordinates.
  _dockRegion() {
    const g = lg().geom('dock')[0];
    if (!g || !(g.w > 0))
      return null;
    const m = Main.layoutManager.primaryMonitor;
    const x = Math.max(0, Math.floor(m.x + g.x - 40));
    const y = Math.max(0, Math.floor(m.y + g.y - 40));
    const w = Math.min(m.width - x, Math.ceil(g.w + 80));
    const h = Math.min(m.height - y, Math.ceil(g.h + 80));
    return [x, y, w, h];
  }

  async _shots(tag, rect) {
    this._camera.rect = rect;
    this._camera.set_size(rect[2], rect[3]);
    this._camera.armed = true;
    // On a quiet stage nothing else asks for a frame.
    this._camera.queue_redraw();
    await sleep(200);
    await shot(`${tag}-screen`, rect);
    await shot(`${tag}-camera`, [this._camera.x, this._camera.y, rect[2], rect[3]]);
    this._camera.armed = false;
    this._report(tag);
  }

  _report(tag) {
    const row = glassRow('dock');
    if (!row) {
      log(`${tag} no dock glass row`);
      return;
    }
    const keys = ['mode', 'paints', 'copies', 'reuses', 'offStage', 'misses', 'blurRuns', 'blurSkips',
      'relayChanges', 'copy', 'copyStageRect', 'blurRect', 'composited'];
    const picked = Object.fromEntries(keys.filter(k => k in row).map(k => [k, row[k]]));
    log(`${tag} frames=${this._frames} ${JSON.stringify(picked)} relays=${JSON.stringify(row.relays ?? null)}`);
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

  _dockGlass() {
    return Main.layoutManager.uiGroup.get_children()
      .find(a => a._owner === 'dock' && typeof a.describe === 'function') ?? null;
  }

  // Runs `step` between frames and checks the frame after each step: with
  // the backdrop changing behind the glass, that frame must take a new copy.
  // With `expectCopy` false (a change in front of the glass), it must not.
  async _audit(tag, steps, intervalMs, step, expectCopy = true) {
    const glass = this._dockGlass();
    if (!glass) {
      log(`${tag} audit: no backdrop dock glass`);
      return;
    }
    const read = () => ({copies: glass._copyCount, reuses: glass._reuseCount, misses: glass._missCount,
      paints: glass._paints});
    const rec = [];
    let prev = read();
    let pending = false;
    const id = global.stage.connect('after-paint', () => {
      const cur = read();
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
    const bad = expectCopy ? count(r => !r.copied) : count(r => r.copied);
    log(`${tag} audit steps=${steps} frames=${rec.length} painted=${count(r => r.painted)} ` +
      `copied=${count(r => r.copied)} reused=${count(r => r.reused)} missed=${count(r => r.missed)} ` +
      `${expectCopy ? 'stale' : 'needless-copy'}=${bad} ${bad === 0 ? 'OK' : 'NG'}`);
  }

  // Frames and copies over a quiet period; both should stay put.
  async _idle(tag, ms) {
    const before = glassRow('dock');
    const frames = this._frames;
    await sleep(ms);
    const after = glassRow('dock');
    log(`${tag} idle ${ms}ms frames=${this._frames - frames} ` +
      `copies=${(after?.copies ?? 0) - (before?.copies ?? 0)} blurRuns=${(after?.blurRuns ?? 0) - (before?.blurRuns ?? 0)} ` +
      `paints=${(after?.paints ?? 0) - (before?.paints ?? 0)}`);
  }

  async _dockScenario() {
    let region = null;
    for (let i = 0; i < 40 && !region; i++) {
      region = lg() ? this._dockRegion() : null;
      if (!region)
        await sleep(250);
    }
    if (!region) {
      log('no dock glass');
      return;
    }
    log(`dock region=${JSON.stringify(region)}`);
    this._camera = new Camera(region);
    this._camera.set_position(20, 60);
    Main.layoutManager.uiGroup.add_child(this._camera);
    this._actors.push(this._camera);

    await this._shots('d0-baseline', region);
    await this._idle('d0', 2000);

    // An actor behind the glass and one in front of it.
    const [bx, by, bw, bh] = region;
    const glass = this._dockGlass();
    const behind = new St.Widget({name: 'drv-behind', reactive: false, style: 'background-color: rgb(255,255,0);'});
    behind.set_position(bx + 100, by + 20);
    behind.set_size(120, 60);
    if (glass)
      Main.layoutManager.uiGroup.insert_child_below(behind, glass);
    else
      Main.layoutManager.uiGroup.add_child(behind);
    this._actors.push(behind);
    const front = new St.Widget({name: 'drv-front', reactive: false, style: 'background-color: rgb(0,255,255);'});
    front.set_position(bx + bw - 140, by + 50);
    front.set_size(30, 30);
    Main.layoutManager.uiGroup.add_child(front);
    this._actors.push(front);
    await sleep(500);
    const colors = ['rgb(255,0,255)', 'rgb(255,255,0)'];
    await this._audit('d0a behind-colour', 10, 120, i => behind.set_style(`background-color: ${colors[i % 2]};`));
    await this._audit('d0b behind-move', 10, 120, i => { behind.translation_x = (i + 1) * 12; });
    await this._audit('d0c front-colour', 10, 120, i => front.set_style(`background-color: ${colors[i % 2]};`), false);
    await this._shots('d0d-actors', region);
    behind.destroy();
    front.destroy();
    this._actors = this._actors.filter(a => a !== behind && a !== front);
    await sleep(300);

    const [rx, ry, rw] = region;
    const a = await this._spawn(['foot', '-o', 'colors.background=d02020', '-o', 'cursor.blink=no',
      '-T', 'lgdrv-a'], 'lgdrv-a');
    if (a) {
      a.win.move_resize_frame(true, rx + 80, ry - 300, 420, 380);
      await sleep(1200);
      await this._shots('d1-window', region);
      await this._idle('d1', 2000);

      await this._audit('d2 window-drag', 20, 50, i => a.win.move_frame(true, rx + 80 + (i + 1) * 15, ry - 300));
      await sleep(300);
      await this._shots('d2-moved', region);
    }

    const g = await this._spawn(['glxgears'], 'glxgears');
    if (g) {
      g.win.move_frame(true, rx + rw - 350, ry - 150);
      await sleep(800);
      await this._audit('d3 gears', 30, 40, () => {});
      const before = glassRow('dock');
      const frames = this._frames;
      await sleep(2000);
      const after = glassRow('dock');
      log(`d3 gears 2000ms frames=${this._frames - frames} copies=${after.copies - before.copies} ` +
        `blurRuns=${after.blurRuns - before.blurRuns} reuses=${after.reuses - before.reuses}`);
      await this._shots('d3-gears', region);
      g.proc.force_exit();
      await sleep(800);
      await this._shots('d3b-gears-gone', region);
    }

    if (a) {
      a.win.move_frame(true, rx + 80, 80);
      await sleep(600);
      await this._shots('d4-window-left', region);
    }

    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    bg.set_string('picture-uri', '');
    bg.set_string('picture-uri-dark', '');
    bg.set_string('picture-options', 'none');
    bg.set_string('color-shading-type', 'solid');
    bg.set_string('primary-color', '#2050c0');
    await sleep(1500);
    await this._shots('d5-background', region);

    if (a) {
      a.win.move_frame(true, rx + 200, ry - 200);
      await sleep(800);
    }
    await this._shots('d6-backdrop', region);
    await this._rebuildDock(false);
    await this._shots('d7-capture', region);
    await this._rebuildDock(true);
    await this._shots('d8-backdrop-again', region);
    log(`dump\n${lg().dump()}`);
  }

  _finish() {
    log('DONE');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      global.context.terminate();
      return GLib.SOURCE_REMOVE;
    });
  }
}
