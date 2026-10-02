import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { releaseFrameSerialHook } from '../rendering/frameClock.js';
import { setBmsMode, BMS_MODE } from '../capture/uiLayerSampler.js';
import { setFrameSyncFrozen, isFrameSyncFrozen } from '../animation/frameSync.js';
import { setDiffWritesEnabled, isDiffWritesEnabled } from '../actors/writes.js';
import { setCaptureClipEnabled, isCaptureClipEnabled, setCloneCullEnabled, isCloneCullEnabled, setCullSiteEnabled, isCullSiteEnabled } from '../capture/options.js';
import { setAdaptiveColorMode, getAdaptiveColorMode } from '../animation/colors.js';
import { setNestedGlassFix, getNestedGlassFix, setFocusDebugEnabled, isFocusDebugEnabled } from '../capture/nestedGlass.js';
import { setBackgroundMirrorEnabled, isBackgroundMirrorEnabled } from '../capture/background.js';
import { setCullOptOutEnabled, isCullOptOutEnabled } from '../capture/windowCulling.js';
import { setWindowActorRescueMode, getWindowActorRescueMode } from '../actors/allocation.js';
import { diagnosticLog } from './logging.js';
import { startGlassMonitor, stopGlassMonitor, isGlassMonitorRunning } from './monitor.js';
// Every live LiquidEffect registers here so its last frame can be inspected
// from Looking Glass through global._lgGlass (installed by enable(), removed by
// disable()). For example, `blurResult: NULL` in dump() means the glass shows
// the raw, unblurred capture.
const _liveEffects = new Set();
// Defaults for new effects; global._lgGlass.blurCache()/nestedRoi() change
// them for A/B testing.
export let blurCacheDefault = true;
export let nestedRoiDefault = true;
// Every live BackdropGlass, for the same dump and switches.
const _liveBackdrops = new Set();
// Whether glass created from now on reads its backdrop from the stage
// (BackdropGlass) or captures clones (LiquidEffect); global._lgGlass.backdrop()
// switches it for A/B comparison.
export let backdropDefault = true;
// A rolling in-memory record of the application glasses, written to the
// journal only when flushed. It exists for rare animation stalls: a capture
// started after the stall is noticed misses the frames leading up to it, and
// logging continuously from the compositor thread can stall the shell itself.
// A sample is stored only when a window's line changes, and RING_MAX caps
// the memory.
const RING_MAX = 4000;
const _ring = [];
let _ringLast = new Map();

function _ringTransition(wa) {
    const trOp = wa.get_transition('opacity');
    if (!trOp)
        return '|tr=-';
    return `|tr=${trOp.is_playing() ? 'play' : 'stop'},${trOp.get_progress().toFixed(3)},` +
        `${trOp.get_frame_clock() ? 'clk' : 'NOCLK'}`;
}

function _ringLine(fx) {
    const a = fx.get_actor();
    if (!a)
        return null;
    const wa = a.get_parent();
    if (!wa)
        return null;
    const mw = wa.get_meta_window();
    // A stranded window has the glass, the window actor and the window group
    // all waiting for an allocation, so the group's state is recorded too.
    const wg = wa.get_parent();
    const wgAllocated = wg?.has_allocation() ? 1 : 0;
    return `${fx._diagOwnerLabel || '?'}|sc=${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}` +
        `|op=${wa.opacity}|pos=${Math.round(wa.x)},${Math.round(wa.y)}` +
        `|map=${wa.mapped ? 1 : 0}|alloc=${wa.has_allocation() ? 1 : 0}` +
        `|gAlloc=${a.has_allocation() ? 1 : 0}|gPos=${Math.round(a.x)},${Math.round(a.y)}` +
        `|gSize=${Math.round(a.width)}x${Math.round(a.height)}` +
        `|min=${mw?.minimized ? 1 : 0}` +
        `|wgAlloc=${wg ? wgAllocated : '-'}` +
        `|views=${wa.peek_stage_views().length}` +
        _ringTransition(wa);
}

function _ringSampleOnce() {
    const t = GLib.get_monotonic_time();
    for (const fx of _liveEffects) {
        if (fx._owner !== 'application')
            continue;
        const line = _ringLine(fx);
        if (line === null || _ringLast.get(fx) === line)
            continue;
        _ringLast.set(fx, line);
        _ring.push(`${t} ${line}`);
        if (_ring.length > RING_MAX)
            _ring.shift();
    }
}

function _dumpWindowState(wa, live) {
    const mw = wa.get_meta_window();
    if (!mw)
        return;
    live.minimized = mw.minimized;
    const r = mw.get_frame_rect();
    live.wRect = `${r.x},${r.y},${r.width}x${r.height}`;
}

// Whether the shell's own animation is still attached to the window actor.
// A stall at a fixed scale/opacity looks the same from outside whether the
// timeline is not being ticked (playing, progress stuck; `clock=NULL` when no
// stage view reaches the actor), was stopped early (present, not playing), or
// has already been removed (absent).
function _dumpTransitions(wa, live) {
    for (const prop of ['opacity', 'scale-x']) {
        const tr = wa.get_transition(prop);
        if (!tr)
            continue;
        live[`tr_${prop}`] =
            `playing=${tr.is_playing()},prog=${tr.get_progress().toFixed(3)}` +
                `,dur=${tr.get_duration()}` +
                `,clock=${tr.get_frame_clock() ? 'set' : 'NULL'}`;
    }
}

function _dumpParentState(fx, a, wa, live) {
    live.parentMapped = wa.mapped;
    live.parentHasAlloc = wa.has_allocation();
    live.parentOpacity = wa.opacity;
    live.parentScale = `${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}`;
    if (fx._owner === 'application') {
        _dumpWindowState(wa, live);
        live.shellDestroying = Main.wm._destroying.has(wa);
    }
    _dumpTransitions(wa, live);
    live.waViews = wa.peek_stage_views().length;
    const wg = wa.get_parent();
    if (wg)
        live.wgViews = wg.peek_stage_views().length;
    live.glassViews = a.peek_stage_views().length;
}

// Live actor state next to the snapshot: a frozen paint counter alone cannot
// tell minimised, culled, unallocated and stuck apart. `paints` is read live
// too, because with glass-debug-diagnostics off the snapshot is only
// refreshed about once a second.
function _dumpLiveState(fx) {
    const a = fx.get_actor();
    if (!a)
        return {};
    const live = {
        mapped: a.mapped,
        visible: a.visible,
        hasAlloc: a.has_allocation(),
        opacity: a.opacity,
        pos: `${Math.round(a.x)},${Math.round(a.y)}`,
    };
    const wa = a.get_parent();
    if (wa)
        _dumpParentState(fx, a, wa, live);
    return live;
}

function _dumpRow(fx, now) {
    if (!fx._diagLast)
        return `(never painted) owner=${fx._owner ?? '?'}${fx._diagOwnerLabel ? ' label=' + fx._diagOwnerLabel : ''}`;
    return JSON.stringify({
        ...fx._diagLast,
        label: fx._diagOwnerLabel || undefined,
        paints: fx._diagPaintCount,
        composited: fx._diagCompositedPaintCount,
        blurRuns: fx._blurRuns,
        blurSkips: fx._blurSkips,
        blurCacheHits: fx._blurCacheHits,
        nestedRoiClamps: fx._nestedRoiClamps,
        nestedRoiSkips: fx._nestedRoiSkips,
        snapshotAgeMs: Math.round((now - fx._diagLastSnapshotAt) / 1000),
        ..._dumpLiveState(fx),
    });
}

export function dumpGlassState() {
    const now = GLib.get_monotonic_time();
    const rows = [..._liveEffects].map(fx => _dumpRow(fx, now));
    for (const glass of _liveBackdrops)
        rows.push(JSON.stringify(glass.describe()));
    const out = rows.length ? rows.join('\n') : '(no live glass)';
    diagnosticLog(`[Liquid Glass][dump]\n${out}`);
    return out;
}

// While the recorder is armed, flush it automatically the first few times a
// window actor becomes stranded. Capped, because each flush writes to the
// journal.
let _autoCaptures = 0;
const AUTO_CAPTURE_LIMIT = 6;

export function noteStrandEntry(label, detail) {
    if (!_ringArmed)
        return;
    if (_autoCaptures >= AUTO_CAPTURE_LIMIT)
        return;
    _autoCaptures++;
    diagnosticLog(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
        `on strand entry for "${label}" — ${detail}`);
    flushGlassRing();
}

// The recorder is off unless armed through global._lgGlass.ring(true), and
// its timer only exists while it is armed.
let _ringArmed = false;
let _ringSamplerEnabled = false;
let _ringSamplerId = 0;
let _ringSamplerInterval = 50;

function syncGlassRingSampler() {
    if (!_ringArmed || !_ringSamplerEnabled) {
        if (_ringSamplerId)
            GLib.Source.remove(_ringSamplerId);
        _ringSamplerId = 0;
    }
    else if (!_ringSamplerId) {
        _ringSamplerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, _ringSamplerInterval, () => {
            _ringSampleOnce();
            return GLib.SOURCE_CONTINUE;
        });
    }
}

export function setGlassRingArmed(armed) {
    _ringArmed = !!armed;
    syncGlassRingSampler();
    if (!_ringArmed) {
        _ring.length = 0;
        _ringLast = new Map();
        _autoCaptures = 0;
    }
}

export function isGlassRingArmed() {
    return _ringArmed;
}

/**
 * Lets the sampler run whenever the recorder is armed. Pair with
 * stopGlassRingSampler() in disable().
 */
export function startGlassRingSampler(intervalMs = 50) {
    _ringSamplerInterval = intervalMs;
    _ringSamplerEnabled = true;
    syncGlassRingSampler();
}

export function stopGlassRingSampler() {
    _ringSamplerEnabled = false;
    setGlassRingArmed(false);
}

/** Writes the ring buffer out and clears it. */
export function flushGlassRing() {
    if (!_ring.length) {
        diagnosticLog('[Liquid Glass][ring] empty');
        return;
    }
    const t0 = parseInt(_ring[0].split(' ')[0], 10);
    const tN = parseInt(_ring[_ring.length - 1].split(' ')[0], 10);
    const lines = _ring.map(r => {
        const sp = r.indexOf(' ');
        const ms = Math.round((parseInt(r.slice(0, sp), 10) - t0) / 1000);
        return `+${String(ms).padStart(6)}ms ${r.slice(sp + 1)}`;
    });
    // Medium-sized chunks: journald truncates a very long message, and a flood
    // of small ones can block the compositor thread.
    const CHUNK = 150;
    const total = Math.ceil(lines.length / CHUNK);
    diagnosticLog(`[Liquid Glass][ring] BEGIN ${lines.length} samples spanning ` +
        `${Math.round((tN - t0) / 1000)}ms in ${total} chunk(s)`);
    for (let i = 0; i < total; i++) {
        diagnosticLog(`[Liquid Glass][ring] ${i + 1}/${total}\n` +
            lines.slice(i * CHUNK, (i + 1) * CHUNK).join('\n'));
    }
    diagnosticLog('[Liquid Glass][ring] END');
    _ring.length = 0;
    _ringLast = new Map();
}

function report(msg) {
    diagnosticLog(`[Liquid Glass] ${msg}`);
    return msg;
}

function onOff(enabled) {
    return enabled ? 'ENABLED' : 'DISABLED';
}

// Applies a setter to every live LiquidEffect and returns how many it reached.
function onEveryEffect(apply) {
    for (const fx of _liveEffects)
        apply(fx);
    return _liveEffects.size;
}

// The same for the setters BackdropGlass shares with LiquidEffect.
function onEveryGlass(apply) {
    for (const glass of _liveBackdrops)
        apply(glass);
    return onEveryEffect(apply) + _liveBackdrops.size;
}

function ownerName(actor) {
    return actor.get_parent()?.get_name() ?? actor.get_name() ?? '(?)';
}

function describeChildren(actor, depth, maxDepth, lines) {
    if (depth > maxDepth)
        return;
    for (const c of actor.get_children()) {
        const geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
            `p=(${Math.round(c.x)},${Math.round(c.y)}) size=${Math.round(c.width)}x${Math.round(c.height)}`;
        lines.push(`   ${'  '.repeat(depth)}${c.visible && c.opacity > 0 ? '   ' : 'XX '}"${c.get_name() || '(unnamed)'}" ` +
            `vis=${c.visible} op=${c.opacity} culled=${!!c._lgCulled} ${geom}`);
        describeChildren(c, depth + 1, maxDepth, lines);
    }
}

function describeUnpainted(actor, depth, lines) {
    for (const c of actor.get_children()) {
        if (!c.visible || c.opacity === 0) {
            const geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                `size=${Math.round(c.width)}x${Math.round(c.height)}`;
            lines.push(`   ${'  '.repeat(depth)}NOT PAINTED "${c.get_name() || `(${c.constructor.name})`}" ` +
                `vis=${c.visible} op=${c.opacity} culled=${!!c._lgCulled} ${geom}`);
        }
        else if (depth < 6) {
            describeUnpainted(c, depth + 1, lines);
        }
    }
}

function createDebugApi() {
    return {
        count: () => _liveEffects.size + _liveBackdrops.size,
        dump: () => dumpGlassState(),
        // 0 = normal, 1 = red where the shader computes the drop shadow and green
        // where it computes the glass shape, 2 = raw values.
        debugView: (mode) => report(`debug_view = ${mode} on ${onEveryGlass(fx => fx.setDebugView(mode))} instance(s)`),
        // How a Blur My Shell panel is supplied to the glass; see BMS_MODE.
        bmsMode: (mode) => setBmsMode(mode),
        BMS_MODE,
        // Every tick of every per-frame sync loop does nothing while frozen, so
        // the cost of the polling itself can be measured. The glass stops
        // following anything that moves.
        freezeSync: (frozen) => {
            setFrameSyncFrozen(frozen);
            return report(`per-frame sync ${frozen ? 'FROZEN' : 'RUNNING'}`);
        },
        syncFrozen: () => isFrameSyncFrozen(),
        // 'cross-fade' (default) dissolves through alpha so a white/black flip
        // never sits at mid-grey; 'rgb-lerp' interpolates the channels.
        textColorMode: (mode) => {
            const m = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
            setAdaptiveColorMode(m);
            return report(`adaptive text colour mode = ${m}`);
        },
        textColorModeName: () => getAdaptiveColorMode(),
        nestedFix: (mode) => {
            setNestedGlassFix(mode);
            return report(`nested-glass repair = ${getNestedGlassFix()}`);
        },
        nestedFixMode: () => getNestedGlassFix(),
        // Only affects glass created afterwards; toggle the extension off and on
        // to rebuild the existing ones.
        bgMirror: (on) => {
            setBackgroundMirrorEnabled(on);
            return report(`background mirror ${onOff(on)} (toggle the extension off/on to rebuild existing glass)`);
        },
        bgMirrorEnabled: () => isBackgroundMirrorEnabled(),
        // false restores mutter's culling of cloned windows, including the
        // occlusion culling the opt-out gives up; compare idle GPU with this.
        cullOptOut: (on) => {
            setCullOptOutEnabled(on);
            return report(`cloned-window cull opt-out ${onOff(on)}`);
        },
        cullOptOutEnabled: () => isCullOptOutEnabled(),
        // 'two-stage' (default) asks the window group to relayout first and only
        // then remaps the window actor; 'remap' goes straight to hide()/show();
        // 'off' never touches the window actor and lets the clones go stale.
        windowRescue: (mode) => {
            setWindowActorRescueMode(mode);
            return report(`window-actor rescue = ${getWindowActorRescueMode()}`);
        },
        windowRescueMode: () => getWindowActorRescueMode(),
        ring: (on) => {
            setGlassRingArmed(on);
            return report(`ring recorder ${on ? 'ARMED (50ms)' : 'disarmed'}`);
        },
        ringArmed: () => isGlassRingArmed(),
        ringFlush: () => { flushGlassRing(); return 'flushed'; },
        // Logs on every restack; leaving it on can flood the journal.
        focusDebug: (on) => {
            setFocusDebugEnabled(on);
            return report(`focus-debug logging ${onOff(on)}`);
        },
        focusDebugEnabled: () => isFocusDebugEnabled(),
        // Compare-then-write in the per-frame sync loops. Changes how often the
        // stage is damaged, not what is drawn.
        diffWrites: (enabled) => {
            setDiffWritesEnabled(enabled);
            return report(`diff writes ${onOff(enabled)}`);
        },
        diffWritesEnabled: () => isDiffWritesEnabled(),
        // Clipping the offscreen capture to what the glass can show. Off by
        // default: it measured slower than capturing everything.
        captureClip: (enabled) => {
            setCaptureClipEnabled(enabled);
            return report(`capture clip ${onOff(enabled)}`);
        },
        captureClipEnabled: () => isCaptureClipEnabled(),
        // Hiding clones outside that rect. An invisible clone never paints its
        // source, so this is what removes nested glass paints.
        cloneCull: (enabled) => {
            setCloneCullEnabled(enabled);
            return report(`clone cull ${onOff(enabled)}`);
        },
        cloneCullEnabled: () => isCloneCullEnabled(),
        // The individual cull sites, each ANDed with cloneCull.
        cullApp: (enabled) => {
            setCullSiteEnabled('app', enabled);
            return report(`cull site app (behind-window clones) ${onOff(enabled)}`);
        },
        cullWindows: (enabled) => {
            setCullSiteEnabled('windows', enabled);
            return report(`cull site windows (dock/menu window clones) ${onOff(enabled)}`);
        },
        cullBms: (enabled) => {
            setCullSiteEnabled('bms', enabled);
            return report(`cull site bms (BMS replicas out of reach) ${onOff(enabled)}`);
        },
        cullUi: (enabled) => {
            setCullSiteEnabled('ui', enabled);
            return report(`cull site ui (uiGroup clones) ${onOff(enabled)}`);
        },
        cullSites: () => ({
            app: isCullSiteEnabled('app'),
            windows: isCullSiteEnabled('windows'),
            ui: isCullSiteEnabled('ui'),
            bms: isCullSiteEnabled('bms'),
        }),
        // The whole subtree of every glass, painted or not, to compare what the
        // capture holds with what the screen shows.
        treeReport: (maxDepth = 4) => {
            const lines = [];
            for (const fx of _liveEffects) {
                const actor = fx.get_actor();
                if (!actor)
                    continue;
                const res = fx.getResolution();
                lines.push(`── ${ownerName(actor)} res=${res[0]}x${res[1]}`);
                describeChildren(actor, 0, maxDepth, lines);
            }
            return report(lines.join('\n'));
        },
        // Every clone inside a glass that is currently not painted (culled or
        // hidden): the probe for part of a glass background going black.
        cullReport: () => {
            const lines = [];
            for (const fx of _liveEffects) {
                const actor = fx.get_actor();
                if (!actor)
                    continue;
                const res = fx.getResolution();
                lines.push(`── ${ownerName(actor)} res=${res[0]}x${res[1]} captureClip=${JSON.stringify(fx._lgCaptureClip ?? null)}`);
                describeUnpainted(actor, 0, lines);
            }
            return report(lines.join('\n'));
        },
        // The rect each glass is drawing with right now, straight from its
        // uniforms, for per-frame tracking probes.
        geom: (owner) => {
            const out = [];
            const add = (glassOwner, u) => {
                if (owner && glassOwner !== owner)
                    return;
                out.push({ owner: glassOwner, x: u.get('dock_x') ?? 0, y: u.get('dock_y') ?? 0,
                    w: u.get('dock_w') ?? 0, h: u.get('dock_h') ?? 0 });
            };
            for (const fx of _liveEffects)
                add(fx._owner, fx._uniforms.values);
            for (const glass of _liveBackdrops)
                add(glass._owner, glass.uniformValues);
            return out;
        },
        // Only affects glass created afterwards; toggle the extension off and on
        // to rebuild the existing ones.
        backdrop: (on) => {
            backdropDefault = !!on;
            return report(`backdrop glass ${onOff(on)} (toggle the extension off/on to rebuild existing glass)`);
        },
        backdropEnabled: () => backdropDefault,
        // The live stage-reading glass actors themselves, for scripted checks.
        glassObjects: () => [..._liveBackdrops],
        // One journal line per second with every shown glass's work, the windows
        // on screen and the GPU's busy percentage (see diagnostics/monitor.ts).
        // 0 runs until monitorStop().
        monitor: (seconds = 30) => {
            startGlassMonitor({ glasses: () => _liveBackdrops, effects: () => _liveEffects }, seconds);
            return report(`monitor running${seconds > 0 ? ` for ${seconds}s` : ''}; see journalctl -o cat | grep '\[monitor\]'`);
        },
        monitorStop: () => {
            stopGlassMonitor();
            return report('monitor stopped');
        },
        monitorRunning: () => isGlassMonitorRunning(),
        blurRect: (enabled) => report(`blur sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setBlurRectEnabled(enabled))} instance(s)`),
        compositeRect: (enabled) => report(`composite sub-rect ${onOff(enabled)} on ${onEveryGlass(fx => fx.setCompositeRectEnabled(enabled))} instance(s)`),
        cropPass: (enabled) => report(`crop pass ${onOff(enabled)} on ${onEveryEffect(fx => fx.setCropPassEnabled(enabled))} instance(s)`),
        nestedRoi: (enabled) => {
            nestedRoiDefault = !!enabled;
            return report(`nested composite ROI ${onOff(enabled)} on ${onEveryEffect(fx => fx.setNestedRoiEnabled(enabled))} instance(s)`);
        },
        blurCache: (enabled) => {
            blurCacheDefault = !!enabled;
            return report(`cross-frame blur cache ${onOff(enabled)} on ${onEveryEffect(fx => fx.setBlurCacheEnabled(enabled))} instance(s)`);
        },
        // false = the plain four-tap pattern along the edge.
        edgeTaps: (enabled) => report(`edge footprint taps ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEdgeTapsEnabled(enabled))} instance(s)`),
        earlyExit: (enabled) => report(`early exits ${onOff(enabled)} on ${onEveryGlass(fx => fx.setEarlyExitEnabled(enabled))} instance(s)`),
    };
}

/** Called from enable(): publishes global._lgGlass and the ring sampler. */
export function installGlassDiagnostics() {
    global._lgGlass = createDebugApi();
    startGlassRingSampler(50);
}

/** Called from disable(). */
export function removeGlassDiagnostics() {
    stopGlassMonitor();
    stopGlassRingSampler();
    delete global._lgGlass;
}

export function registerBackdropGlass(glass) {
    _liveBackdrops.add(glass);
}

export function unregisterBackdropGlass(glass) {
    _liveBackdrops.delete(glass);
}

export function isLiveGlassEffect(effect) {
    return _liveEffects.has(effect);
}

export function registerGlassEffect(effect) {
    _liveEffects.add(effect);
}

export function unregisterGlassEffect(effect) {
    _liveEffects.delete(effect);
    // The frame-serial hook is shared by every instance; release it with the
    // last one so nothing stays connected to the stage.
    if (_liveEffects.size === 0)
        releaseFrameSerialHook();
}
