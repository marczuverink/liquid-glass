// A once-a-second record of what the glass is doing next to what the GPU is
// doing, for comparing the two in a real session: global._lgGlass.monitor().
// One journal line per second:
//
//   [Liquid Glass][monitor] t=12 gpu=23% (max 41) frames=58 full=2 | windows 4 shown, 1 moved, 1 redrawn |
//     dock copies=58 reuses=0 blurs=58 relays=3 | menu hidden
//
// gpu is amdgpu's gpu_busy_percent, sampled every 100 ms (no other driver
// exposes one; tools/perf/glass-monitor.sh can sample intel_gpu_top instead).
// frames counts painted stage views; full counts those that redrew the whole
// monitor. A window is "moved" when its frame rect changed, "redrawn" when it
// reported damage.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { diagnosticLog } from './logging.js';
import { isActorValid } from '../actors/lifecycle.js';
const SAMPLE_MS = 100;
const REPORT_MS = 1000;
// Paints nothing; notes whether a frame redrew its whole monitor. Registered
// on first use, so the type exists only once someone monitors.
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
            if (!clip || clip.contains_rectangle(new Mtk.Rectangle({ x, y, width, height })) === Mtk.RegionOverlap.IN)
                this.full++;
        }
    });
    return new _probeClass(rect);
}

class GlassMonitor {
    _sources;
    _duration;
    _sampleId = 0;
    _reportId = 0;
    _paintId = 0;
    _frames = 0;
    _seconds = 0;
    _gpuFiles = [];
    _gpuSum = 0;
    _gpuMax = 0;
    _gpuSamples = 0;
    _probes = [];
    _windows = new Map();
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
            Main.layoutManager.uiGroup.add_child(probe);
            this._probes.push(probe);
        }
        this._paintId = global.stage.connect('after-paint', () => { this._frames++; });
        this._snapshotCounters();
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
            `gpu source: ${this._gpuFiles.length ? this._gpuFiles.join(', ') : 'none (use tools/perf/glass-monitor.sh)'}`);
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
        const seen = new Set();
        for (const actor of global.get_window_actors()) {
            seen.add(actor);
            const r = actor.get_meta_window()?.get_frame_rect();
            const rect = r ? `${r.x},${r.y},${r.width},${r.height}` : '';
            let track = this._windows.get(actor);
            if (!track) {
                const created = { rect, moved: false, damaged: false, damagedId: 0 };
                created.damagedId = actor.connect('damaged', () => { created.damaged = true; });
                this._windows.set(actor, created);
                continue;
            }
            if (track.rect !== rect) {
                track.moved = true;
                track.rect = rect;
            }
        }
        // A destroyed window actor took its handler with it.
        for (const actor of this._windows.keys()) {
            if (!seen.has(actor))
                this._windows.delete(actor);
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

    _report() {
        this._seconds++;
        const parts = [];
        const gpu = this._gpuSamples ? this._gpuSum / this._gpuSamples : -1;
        const full = this._probes.reduce((n, p) => n + p.full, 0);
        parts.push(`t=${this._seconds}` +
            (gpu >= 0 ? ` gpu=${gpu.toFixed(0)}% (max ${this._gpuMax})` : '') +
            ` frames=${this._frames} full=${full}`);
        this._totals.seconds++;
        this._totals.gpu += Math.max(gpu, 0);
        this._totals.frames += this._frames;
        this._totals.full += full;
        let shown = 0, moved = 0, damaged = 0;
        for (const [actor, track] of this._windows) {
            const window = actor.get_meta_window();
            if (actor.mapped && actor.visible && !window?.minimized)
                shown++;
            if (track.moved)
                moved++;
            if (track.damaged)
                damaged++;
            track.moved = false;
            track.damaged = false;
        }
        parts.push(`windows ${shown} shown, ${moved} moved, ${damaged} redrawn`);
        for (const glass of this._sources.glasses()) {
            const now = this._counters(glass);
            const last = this._last.get(glass) ?? now;
            this._last.set(glass, now);
            const d = (k) => now[k] - (last[k] ?? 0);
            if (!glass.mapped && d('paints') === 0) {
                continue;
            }
            const relays = typeof glass.describe === 'function' ? (glass.describe().relays?.length ?? 0) : 0;
            parts.push(`${glass._owner} copies=${d('copies')} reuses=${d('reuses')} paints=${d('paints')} ` +
                `blurs=${d('blurs')} relays=${relays}${glass.mapped ? '' : ' (hidden)'}`);
        }
        for (const fx of this._sources.effects()) {
            const now = { paints: fx._diagPaintCount ?? 0, blurs: fx._blurRuns ?? 0 };
            const last = this._last.get(fx) ?? now;
            this._last.set(fx, now);
            const paints = now.paints - last.paints;
            if (paints === 0)
                continue;
            parts.push(`${fx._owner}(capture) paints=${paints} blurs=${now.blurs - last.blurs}`);
        }
        diagnosticLog(`[Liquid Glass][monitor] ${parts.join(' | ')}`);
        this._frames = 0;
        for (const probe of this._probes)
            probe.full = 0;
        this._gpuSum = 0;
        this._gpuSamples = 0;
        this._gpuMax = 0;
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
