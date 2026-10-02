// A once-a-second record of what the glass is doing next to what the GPU is
// doing, for comparing the two in a real session: global._lgGlass.monitor().
// One journal line per second:
//
//   [Liquid Glass][monitor] t=12 gpu=23% (max 41) frames=58 full=2
//     scene=<stage; dock calendar~; 4 win: firefox busy@dock, nautilus moving; overview>
//     | dock copies=58 reuses=0 paints=58 blurs=58 relays=3 | calendar copies=...
//
// gpu is amdgpu's gpu_busy_percent, sampled every 100 ms (no other driver
// exposes one). frames counts painted stage views; full counts those that
// redrew the whole monitor.
//
// The scene is worked out without the user's help, so seconds spent in the
// same situation can be grouped (tools/perf/glass-monitor.sh does that):
//   - stage or capture: how the UI glass gets its backdrop;
//   - the glass on screen; ~ marks one that moved or resized;
//   - the windows shown and the ones doing something: busy (damaged at least
//     BUSY_DAMAGE times in the second, e.g. a video), moving (frame rect
//     changed) or anim (actor transform or opacity changed), with @glass for
//     each glass it overlaps;
//   - overview, ws-switch, fullscreen, locked.
// Being behind a glass is decided by rects, so a window whose damage stays
// away from the glass still counts.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { diagnosticLog } from './logging.js';
import { isActorValid } from '../actors/lifecycle.js';
const SAMPLE_MS = 100;
const REPORT_MS = 1000;
const BUSY_DAMAGE = 10;
const MAX_ACTIVE_WINDOWS = 4;
const APP_PROFILES = new Set(['application', 'desktop-menu']);
// Paints nothing; notes whether a frame redrew its whole monitor. Registered
// on first use, so the type exists only once someone monitors. Offscreen
// paints (clones, screenshots) have no redraw clip and are not counted.
let _probeClass = null;

function createProbe(rect) {
    _probeClass ??= GObject.registerClass(class FullRedrawProbe extends Clutter.Actor {
        _init(r) {
            super._init({ name: 'liquid-glass-monitor-probe', reactive: false, x: r[0], y: r[1], width: r[2], height: r[3] });
            Shell.util_set_hidden_from_pick(this, true);
            this.rect = r;
            this.full = 0;
        }

        vfunc_pick(_pickContext) {
        }

        vfunc_paint_node(_root, paintContext) {
            const clip = paintContext.get_redraw_clip();
            const [x, y, width, height] = this.rect;
            if (clip && clip.contains_rectangle(new Mtk.Rectangle({ x, y, width, height })) === Mtk.RegionOverlap.IN)
                this.full++;
        }
    });
    return new _probeClass(rect);
}

function displayName(owner) {
    if (owner === 'menu')
        return 'calendar';
    if (owner === 'application')
        return 'app';
    return owner;
}

// Popups, tooltips and the like are not counted as windows.
function isCountedWindow(window) {
    const type = window.get_window_type();
    return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG || type === Meta.WindowType.MODAL_DIALOG;
}

function windowName(window) {
    const name = window.get_wm_class() || window.get_title() || '?';
    return (name.split('.').pop() ?? name).toLowerCase().replace(/[^a-z0-9_-]/g, '') || '?';
}

// The glass shape in stage coordinates: the shader's rect scaled from the
// shader's resolution onto the actor's box.
function glassStageRect(actor, u) {
    const ext = actor.get_transformed_extents();
    const { x, y } = ext.origin;
    const { width, height } = ext.size;
    if (!(width >= 1) || !(height >= 1))
        return null;
    const resW = u.get('resolution_x') ?? 0;
    const resH = u.get('resolution_y') ?? 0;
    const w = u.get('dock_w') ?? 0;
    const h = u.get('dock_h') ?? 0;
    // Toggle mode draws regions and leaves the rect empty.
    if (!(resW >= 1) || !(resH >= 1) || !(w > 0) || !(h > 0))
        return [x, y, width, height].map(Math.round);
    const kx = width / resW;
    const ky = height / resH;
    return [x + (u.get('dock_x') ?? 0) * kx, y + (u.get('dock_y') ?? 0) * ky, w * kx, h * ky].map(Math.round);
}

function overlaps(a, b) {
    return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

class GlassMonitor {
    _sources;
    _duration;
    _sampleId = 0;
    _reportId = 0;
    _paintId = 0;
    _workspaceId = 0;
    _frames = 0;
    _seconds = 0;
    _gpuFiles = [];
    _gpuSum = 0;
    _gpuMax = 0;
    _gpuSamples = 0;
    _probes = [];
    _windows = new Map();
    _glass = new Map();
    _overview = false;
    _fullscreen = false;
    _locked = false;
    _workspaceSwitched = false;
    _last = new Map();
    // Per-second totals for the summary.
    _totals = { seconds: 0, gpu: 0, frames: 0, full: 0 };

    constructor(_sources, _duration) {
        this._sources = _sources;
        this._duration = _duration;
    }

    start() {
        this._gpuFiles = findGpuBusyFiles();
        for (const m of Main.layoutManager.monitors) {
            const probe = createProbe([m.x, m.y, m.width, m.height]);
            // Outside uiGroup, which the capturing glass clones.
            global.stage.add_child(probe);
            this._probes.push(probe);
        }
        this._paintId = global.stage.connect('after-paint', () => { this._frames++; });
        this._workspaceId = global.workspace_manager.connect('active-workspace-changed', () => {
            this._workspaceSwitched = true;
        });
        this._snapshotCounters();
        this._sample();
        this._sampleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAMPLE_MS, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
        this._reportId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPORT_MS, () => {
            this._report();
            if (this._duration > 0 && this._seconds >= this._duration) {
                stopGlassMonitor();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        diagnosticLog(`[Liquid Glass][monitor] started ${this._duration > 0 ? `for ${this._duration}s` : 'until monitorStop()'}; ` +
            `gpu source: ${this._gpuFiles.length ? this._gpuFiles.join(', ') : 'none'}`);
    }

    stop() {
        if (this._sampleId)
            GLib.Source.remove(this._sampleId);
        this._sampleId = 0;
        if (this._reportId)
            GLib.Source.remove(this._reportId);
        this._reportId = 0;
        if (this._paintId)
            global.stage.disconnect(this._paintId);
        this._paintId = 0;
        if (this._workspaceId)
            global.workspace_manager.disconnect(this._workspaceId);
        this._workspaceId = 0;
        for (const probe of this._probes) {
            if (isActorValid(probe))
                probe.destroy();
        }
        this._probes = [];
        for (const [actor, track] of this._windows) {
            if (isActorValid(actor))
                actor.disconnect(track.damagedId);
        }
        this._windows.clear();
        this._glass.clear();
        const t = this._totals;
        if (t.seconds > 0) {
            diagnosticLog(`[Liquid Glass][monitor] stopped after ${t.seconds}s: ` +
                `${this._gpuFiles.length ? `gpu avg ${(t.gpu / t.seconds).toFixed(1)}%, ` : ''}` +
                `${(t.frames / t.seconds).toFixed(1)} frames/s, ${(t.full / t.seconds).toFixed(1)} full redraws/s`);
        }
    }

    _sample() {
        let busy = -1;
        for (const file of this._gpuFiles) {
            const value = readNumber(file);
            if (value !== null && value > busy)
                busy = value;
        }
        if (busy >= 0) {
            this._gpuSum += busy;
            this._gpuSamples++;
            if (busy > this._gpuMax)
                this._gpuMax = busy;
        }
        this._sampleWindows();
        this._sampleGlass();
        this._overview ||= Main.overview.visible;
        this._locked ||= Main.sessionMode.isLocked;
        for (let i = 0; i < global.display.get_n_monitors(); i++)
            this._fullscreen ||= global.display.get_monitor_in_fullscreen(i);
    }

    _sampleWindows() {
        const seen = new Set();
        for (const actor of global.get_window_actors()) {
            seen.add(actor);
            const r = actor.get_meta_window()?.get_frame_rect();
            const rect = r ? `${r.x},${r.y},${r.width},${r.height}` : '';
            const look = `${actor.scale_x},${actor.scale_y},${actor.translation_x},${actor.translation_y},${actor.opacity}`;
            const track = this._windows.get(actor);
            if (!track) {
                const created = { rect, look, moved: false, animated: false, damage: 0, damagedId: 0 };
                created.damagedId = actor.connect('damaged', () => { created.damage++; });
                this._windows.set(actor, created);
                continue;
            }
            if (track.rect !== rect)
                track.moved = true;
            if (track.look !== look)
                track.animated = true;
            track.rect = rect;
            track.look = look;
        }
        // A destroyed window actor took its handler with it.
        for (const actor of this._windows.keys()) {
            if (!seen.has(actor))
                this._windows.delete(actor);
        }
    }

    *_glassViews() {
        for (const glass of this._sources.glasses()) {
            yield { key: glass, owner: glass._owner, stage: true, actor: glass, values: glass.uniformValues,
                painting: glass.mapped && glass.get_paint_opacity() > 0 };
        }
        for (const fx of this._sources.effects()) {
            const actor = fx.get_actor();
            if (!actor)
                continue;
            yield { key: fx, owner: fx._owner, stage: false, actor, values: fx._uniforms.values,
                painting: fx.get_enabled() && actor.mapped && actor.get_paint_opacity() > 0 };
        }
    }

    _sampleGlass() {
        const stage = [0, 0, global.stage.width, global.stage.height];
        const seen = new Set();
        for (const view of this._glassViews()) {
            seen.add(view.key);
            const rect = view.painting ? glassStageRect(view.actor, view.values) : null;
            const shown = view.painting && (rect === null || overlaps(rect, stage));
            let track = this._glass.get(view.key);
            if (!track) {
                track = { owner: view.owner, name: displayName(view.owner), stage: view.stage, actor: view.actor, rect, shown: false, moved: false };
                this._glass.set(view.key, track);
            }
            else if (shown && rect && track.rect && rect.join() !== track.rect.join()) {
                track.moved = true;
            }
            track.actor = view.actor;
            if (rect)
                track.rect = rect;
            track.shown ||= shown;
        }
        for (const key of this._glass.keys()) {
            if (!seen.has(key))
                this._glass.delete(key);
        }
    }

    _counters(glass) {
        const s = glass.stats ?? {};
        return { copies: s.copies ?? 0, reuses: s.reuses ?? 0, paints: s.paints ?? 0, blurs: glass._blurRuns ?? 0 };
    }

    _snapshotCounters() {
        for (const glass of this._sources.glasses())
            this._last.set(glass, this._counters(glass));
        for (const fx of this._sources.effects())
            this._last.set(fx, { paints: fx._diagPaintCount ?? 0, blurs: fx._blurRuns ?? 0 });
    }

    // stage or capture by how the live UI glass is built; the window glass
    // always captures.
    _mode() {
        let stage = false;
        let capture = false;
        for (const track of this._glass.values()) {
            if (track.stage)
                stage = true;
            else if (!APP_PROFILES.has(track.owner))
                capture = true;
        }
        if (stage && capture)
            return 'mixed';
        if (stage)
            return 'stage';
        return capture ? 'capture' : 'no-ui-glass';
    }

    _glassScene() {
        const counts = new Map();
        for (const track of this._glass.values()) {
            if (!track.shown)
                continue;
            const entry = counts.get(track.name) ?? { n: 0, moved: false };
            entry.n++;
            entry.moved ||= track.moved;
            counts.set(track.name, entry);
        }
        const names = [...counts.keys()].sort().map(name => {
            const { n, moved } = counts.get(name);
            return `${name}${n > 1 ? `(${n})` : ''}${moved ? '~' : ''}`;
        });
        return names.length ? names.join(' ') : 'no glass';
    }

    // The glass a window overlaps, leaving out its own window glass.
    _behind(actor, rect) {
        const names = new Set();
        for (const track of this._glass.values()) {
            if (!track.shown || !track.rect || track.actor.get_parent() === actor)
                continue;
            if (overlaps(rect, track.rect))
                names.add(track.name);
        }
        return [...names].sort();
    }

    _windowScene() {
        let shown = 0;
        const active = new Map();
        for (const [actor, track] of this._windows) {
            const window = actor.get_meta_window();
            if (!window || !actor.mapped || !actor.visible || window.minimized)
                continue;
            if (isCountedWindow(window))
                shown++;
            const what = [];
            if (track.damage >= BUSY_DAMAGE)
                what.push('busy');
            if (track.moved)
                what.push('moving');
            if (track.animated)
                what.push('anim');
            if (!what.length)
                continue;
            const r = window.get_frame_rect();
            const behind = this._behind(actor, [r.x, r.y, r.width, r.height]);
            const entry = `${windowName(window)} ${what.join('+')}${behind.length ? `@${behind.join('+')}` : ''}`;
            active.set(entry, (active.get(entry) ?? 0) + 1);
        }
        const entries = [...active.keys()].sort().map(e => active.get(e) > 1 ? `${e}(${active.get(e)})` : e);
        const listed = entries.slice(0, MAX_ACTIVE_WINDOWS);
        if (entries.length > listed.length)
            listed.push(`+${entries.length - listed.length} more`);
        return `${shown} win${listed.length ? `: ${listed.join(', ')}` : ''}`;
    }

    _scene() {
        const parts = [this._mode(), this._glassScene(), this._windowScene()];
        if (this._overview)
            parts.push('overview');
        if (this._workspaceSwitched)
            parts.push('ws-switch');
        if (this._fullscreen)
            parts.push('fullscreen');
        if (this._locked)
            parts.push('locked');
        return parts.join('; ');
    }

    _report() {
        this._seconds++;
        const parts = [];
        const gpu = this._gpuSamples ? this._gpuSum / this._gpuSamples : -1;
        const full = this._probes.reduce((n, p) => n + p.full, 0);
        parts.push(`t=${this._seconds}` +
            (gpu >= 0 ? ` gpu=${gpu.toFixed(0)}% (max ${this._gpuMax})` : '') +
            ` frames=${this._frames} full=${full} scene=<${this._scene()}>`);
        this._totals.seconds++;
        this._totals.gpu += Math.max(gpu, 0);
        this._totals.frames += this._frames;
        this._totals.full += full;
        for (const glass of this._sources.glasses()) {
            const now = this._counters(glass);
            const last = this._last.get(glass) ?? now;
            this._last.set(glass, now);
            const d = (k) => now[k] - (last[k] ?? 0);
            if (!glass.mapped && d('paints') === 0)
                continue;
            const relays = glass.describe().relays?.length ?? 0;
            parts.push(`${displayName(glass._owner)} copies=${d('copies')} reuses=${d('reuses')} paints=${d('paints')} ` +
                `blurs=${d('blurs')} relays=${relays}${glass.mapped ? '' : ' (hidden)'}`);
        }
        for (const fx of this._sources.effects()) {
            const now = { paints: fx._diagPaintCount ?? 0, blurs: fx._blurRuns ?? 0 };
            const last = this._last.get(fx) ?? now;
            this._last.set(fx, now);
            const paints = now.paints - last.paints;
            if (paints === 0)
                continue;
            parts.push(`${displayName(fx._owner)}(capture) paints=${paints} blurs=${now.blurs - last.blurs}`);
        }
        diagnosticLog(`[Liquid Glass][monitor] ${parts.join(' | ')}`);
        this._frames = 0;
        for (const probe of this._probes)
            probe.full = 0;
        this._gpuSum = 0;
        this._gpuSamples = 0;
        this._gpuMax = 0;
        for (const track of this._windows.values()) {
            track.moved = false;
            track.animated = false;
            track.damage = 0;
        }
        for (const track of this._glass.values()) {
            track.shown = false;
            track.moved = false;
        }
        this._overview = false;
        this._fullscreen = false;
        this._locked = false;
        this._workspaceSwitched = false;
    }
}

// amdgpu's busy percentage, one file per card.
function findGpuBusyFiles() {
    const files = [];
    let dir = null;
    try {
        dir = GLib.Dir.open('/sys/class/drm', 0);
    }
    catch {
        return files;
    }
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (!/^card\d+$/.test(name))
            continue;
        const file = `/sys/class/drm/${name}/device/gpu_busy_percent`;
        if (GLib.file_test(file, GLib.FileTest.EXISTS))
            files.push(file);
    }
    dir.close();
    return files;
}

function readNumber(file) {
    try {
        const [ok, bytes] = GLib.file_get_contents(file);
        if (!ok)
            return null;
        const value = parseInt(new TextDecoder().decode(bytes), 10);
        return Number.isFinite(value) ? value : null;
    }
    catch {
        return null;
    }
}

let _monitor = null;

/** Starts the record for `seconds` (0: until stopped), replacing a running one. */
export function startGlassMonitor(sources, seconds) {
    stopGlassMonitor();
    _monitor = new GlassMonitor(sources, Math.max(0, Math.floor(seconds)));
    _monitor.start();
}

export function stopGlassMonitor() {
    _monitor?.stop();
    _monitor = null;
}

export function isGlassMonitorRunning() {
    return _monitor !== null;
}
