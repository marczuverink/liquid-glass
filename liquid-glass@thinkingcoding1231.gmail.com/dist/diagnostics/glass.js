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
const _liveEffects = new Set();
export let blurCacheDefault = true;
const RING_MAX = 4000;
const _ring = [];
let _ringLast = new Map();
function _ringTransition(wa) {
    const trOp = wa.get_transition ? wa.get_transition('opacity') : null;
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
    const mw = wa.get_meta_window ? wa.get_meta_window() : null;
    const wg = wa.get_parent();
    const wgAllocated = wg?.has_allocation() ? 1 : 0;
    return `${fx._diagOwnerLabel || '?'}|sc=${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}` +
        `|op=${wa.opacity}|pos=${Math.round(wa.x)},${Math.round(wa.y)}` +
        `|map=${wa.mapped ? 1 : 0}|alloc=${wa.has_allocation() ? 1 : 0}` +
        `|gAlloc=${a.has_allocation() ? 1 : 0}|gPos=${Math.round(a.x)},${Math.round(a.y)}` +
        `|gSize=${Math.round(a.width)}x${Math.round(a.height)}` +
        `|min=${mw?.minimized ? 1 : 0}` +
        `|wgAlloc=${wg ? wgAllocated : '-'}` +
        `|views=${(wa.peek_stage_views() || []).length}` +
        _ringTransition(wa);
}
function _ringSampleOnce() {
    const t = GLib.get_monotonic_time();
    for (const fx of _liveEffects) {
        if (fx._owner !== 'application')
            continue;
        let line;
        try {
            line = _ringLine(fx);
        }
        catch {
            continue;
        }
        if (line === null || _ringLast.get(fx) === line)
            continue;
        _ringLast.set(fx, line);
        _ring.push(`${t} ${line}`);
        if (_ring.length > RING_MAX)
            _ring.shift();
    }
}
function _dumpWindowState(wa, live) {
    try {
        const mw = wa.get_meta_window ? wa.get_meta_window() : null;
        if (mw) {
            live.minimized = mw.minimized;
            const r = mw.get_frame_rect();
            live.wRect = `${r.x},${r.y},${r.width}x${r.height}`;
        }
    }
    catch { }
}
function _dumpTransitions(wa, live) {
    for (const prop of ['opacity', 'scale-x']) {
        try {
            const tr = wa.get_transition(prop);
            if (tr) {
                live[`tr_${prop}`] =
                    `playing=${tr.is_playing()},prog=${tr.get_progress().toFixed(3)}` +
                        `,dur=${tr.get_duration()}` +
                        `,clock=${tr.get_frame_clock() ? 'set' : 'NULL'}`;
            }
        }
        catch { }
    }
}
function _dumpParentState(a, wa, live) {
    live.parentMapped = wa.mapped;
    live.parentHasAlloc = wa.has_allocation();
    live.parentOpacity = wa.opacity;
    live.parentScale = `${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}`;
    _dumpWindowState(wa, live);
    _dumpTransitions(wa, live);
    try {
        live.waViews = (wa.peek_stage_views() || []).length;
        const wg = wa.get_parent();
        if (wg)
            live.wgViews = (wg.peek_stage_views() || []).length;
        live.glassViews = (a.peek_stage_views() || []).length;
    }
    catch { }
    try {
        const destroying = Main.wm?._destroying;
        if (destroying)
            live.shellDestroying = destroying.has(wa);
    }
    catch { }
}
function _dumpLiveState(fx) {
    let live = {};
    try {
        const a = fx.get_actor();
        if (!a)
            return live;
        live = {
            mapped: a.mapped,
            visible: a.visible,
            hasAlloc: a.has_allocation(),
            opacity: a.opacity,
            pos: `${Math.round(a.x)},${Math.round(a.y)}`,
        };
        const wa = a.get_parent();
        if (wa)
            _dumpParentState(a, wa, live);
    }
    catch { }
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
        snapshotAgeMs: Math.round((now - fx._diagLastSnapshotAt) / 1000),
        ..._dumpLiveState(fx),
    });
}
let _autoCaptures = 0;
const AUTO_CAPTURE_LIMIT = 6;
export function noteStrandEntry(label, detail) {
    if (!_ringArmed)
        return;
    if (_autoCaptures >= AUTO_CAPTURE_LIMIT)
        return;
    _autoCaptures++;
    console.log(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
        `on strand entry for "${label}" — ${detail}`);
    try {
        flushGlassRing();
    }
    catch (e) {
        console.error(`[Liquid Glass][ring] ${e}`);
    }
}
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
            try {
                _ringSampleOnce();
            }
            catch { }
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
export function startGlassRingSampler(intervalMs = 50) {
    _ringSamplerInterval = intervalMs;
    _ringSamplerEnabled = true;
    syncGlassRingSampler();
}
export function stopGlassRingSampler() {
    _ringSamplerEnabled = false;
    setGlassRingArmed(false);
}
export function flushGlassRing() {
    if (!_ring.length) {
        console.log('[Liquid Glass][ring] empty');
        return;
    }
    const t0 = parseInt(_ring[0].split(' ')[0], 10);
    const tN = parseInt(_ring[_ring.length - 1].split(' ')[0], 10);
    const lines = _ring.map(r => {
        const sp = r.indexOf(' ');
        const ms = Math.round((parseInt(r.slice(0, sp), 10) - t0) / 1000);
        return `+${String(ms).padStart(6)}ms ${r.slice(sp + 1)}`;
    });
    const CHUNK = 150;
    const total = Math.ceil(lines.length / CHUNK);
    console.log(`[Liquid Glass][ring] BEGIN ${lines.length} samples spanning ` +
        `${Math.round((tN - t0) / 1000)}ms in ${total} chunk(s)`);
    for (let i = 0; i < total; i++) {
        console.log(`[Liquid Glass][ring] ${i + 1}/${total}\n` +
            lines.slice(i * CHUNK, (i + 1) * CHUNK).join('\n'));
    }
    console.log('[Liquid Glass][ring] END');
    _ring.length = 0;
    _ringLast = new Map();
}
function _registerGlassDebugHooks() {
    const g = globalThis;
    if (!g.global || g.global._lgGlass)
        return;
    g.global._lgGlass = {
        count: () => _liveEffects.size,
        debugView: (mode) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setDebugView(mode);
                    n++;
                }
                catch { }
            }
            const msg = `[Liquid Glass] debug_view = ${mode} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        bmsMode: (mode) => setBmsMode(mode),
        BMS_MODE,
        blurRect: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setBlurRectEnabled(enabled);
                    n++;
                }
                catch { }
            }
            const msg = `[Liquid Glass] blur sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        freezeSync: (frozen) => {
            setFrameSyncFrozen(frozen);
            const msg = `[Liquid Glass] per-frame sync ${frozen ? 'FROZEN' : 'RUNNING'}`;
            console.log(msg);
            return msg;
        },
        syncFrozen: () => isFrameSyncFrozen(),
        textColorMode: (mode) => {
            const m = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
            setAdaptiveColorMode(m);
            const msg = `[Liquid Glass] adaptive text colour mode = ${m}`;
            console.log(msg);
            return msg;
        },
        textColorModeName: () => getAdaptiveColorMode(),
        nestedFix: (mode) => {
            const m = mode;
            setNestedGlassFix(m);
            const msg = `[Liquid Glass] nested-glass repair = ${m}`;
            console.log(msg);
            return msg;
        },
        nestedFixMode: () => getNestedGlassFix(),
        bgMirror: (on) => {
            setBackgroundMirrorEnabled(on);
            const msg = `[Liquid Glass] background mirror ${on ? 'ENABLED' : 'disabled'} ` +
                '(toggle the extension off/on to rebuild existing glass)';
            console.log(msg);
            return msg;
        },
        bgMirrorEnabled: () => isBackgroundMirrorEnabled(),
        cullOptOut: (on) => {
            setCullOptOutEnabled(on);
            const msg = `[Liquid Glass] cloned-window cull opt-out ${on ? 'ENABLED' : 'disabled'}`;
            console.log(msg);
            return msg;
        },
        cullOptOutEnabled: () => isCullOptOutEnabled(),
        windowRescue: (mode) => {
            setWindowActorRescueMode(mode);
            const msg = `[Liquid Glass] window-actor rescue = ${getWindowActorRescueMode()}`;
            console.log(msg);
            return msg;
        },
        windowRescueMode: () => getWindowActorRescueMode(),
        ring: (on) => {
            setGlassRingArmed(on);
            const msg = `[Liquid Glass] ring recorder ${on ? 'ARMED (50ms)' : 'disarmed'}`;
            console.log(msg);
            return msg;
        },
        ringArmed: () => isGlassRingArmed(),
        ringFlush: () => { flushGlassRing(); return 'flushed'; },
        focusDebug: (on) => {
            setFocusDebugEnabled(on);
            const msg = `[Liquid Glass] focus-debug logging ${on ? 'ENABLED' : 'disabled'}`;
            console.log(msg);
            return msg;
        },
        focusDebugEnabled: () => isFocusDebugEnabled(),
        diffWrites: (enabled) => {
            setDiffWritesEnabled(enabled);
            const msg = `[Liquid Glass] diff writes ${enabled ? 'ENABLED' : 'DISABLED'}`;
            console.log(msg);
            return msg;
        },
        diffWritesEnabled: () => isDiffWritesEnabled(),
        captureClip: (enabled) => {
            setCaptureClipEnabled(enabled);
            const msg = `[Liquid Glass] capture clip ${enabled ? 'ENABLED' : 'DISABLED'}`;
            console.log(msg);
            return msg;
        },
        captureClipEnabled: () => isCaptureClipEnabled(),
        cloneCull: (enabled) => {
            setCloneCullEnabled(enabled);
            const msg = `[Liquid Glass] clone cull ${enabled ? 'ENABLED' : 'DISABLED'}`;
            console.log(msg);
            return msg;
        },
        cloneCullEnabled: () => isCloneCullEnabled(),
        cullApp: (enabled) => {
            setCullSiteEnabled('app', enabled);
            const msg = `[Liquid Glass] cull site app (behind-window clones) ${enabled ? 'ON' : 'OFF'}`;
            console.log(msg);
            return msg;
        },
        cullWindows: (enabled) => {
            setCullSiteEnabled('windows', enabled);
            const msg = `[Liquid Glass] cull site windows (dock/menu window clones) ${enabled ? 'ON' : 'OFF'}`;
            console.log(msg);
            return msg;
        },
        cullUi: (enabled) => {
            setCullSiteEnabled('ui', enabled);
            const msg = `[Liquid Glass] cull site ui (uiGroup clones) ${enabled ? 'ON' : 'OFF'}`;
            console.log(msg);
            return msg;
        },
        treeReport: (maxDepth = 4) => {
            const lines = [];
            for (const fx of _liveEffects) {
                let actor = null;
                try {
                    actor = fx.get_actor?.();
                }
                catch { }
                const owner = (() => {
                    try {
                        return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)';
                    }
                    catch {
                        return '(?)';
                    }
                })();
                const res = (() => { try {
                    return fx.getResolution();
                }
                catch {
                    return [0, 0];
                } })();
                lines.push(`── ${owner} res=${res[0]}x${res[1]}`);
                const walk = (a, depth) => {
                    if (depth > maxDepth)
                        return;
                    let children = [];
                    try {
                        children = a.get_children();
                    }
                    catch {
                        return;
                    }
                    for (const c of children) {
                        let name = '(?)', vis = true, op = 255, geom = '?';
                        try {
                            name = c.get_name() || '(unnamed)';
                        }
                        catch { }
                        try {
                            vis = c.visible;
                            op = c.opacity;
                            geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                                `p=(${Math.round(c.x)},${Math.round(c.y)}) size=${Math.round(c.width)}x${Math.round(c.height)}`;
                        }
                        catch { }
                        lines.push(`   ${'  '.repeat(depth)}${vis && op > 0 ? '   ' : 'XX '}"${name}" ` +
                            `vis=${vis} op=${op} culled=${!!c._lgCulled} ${geom}`);
                        walk(c, depth + 1);
                    }
                };
                if (actor)
                    walk(actor, 0);
            }
            const out = lines.join('\n');
            console.log(out);
            return out;
        },
        cullSites: () => ({
            app: isCullSiteEnabled('app'),
            windows: isCullSiteEnabled('windows'),
            ui: isCullSiteEnabled('ui'),
        }),
        cullReport: () => {
            const lines = [];
            for (const fx of _liveEffects) {
                let actor = null;
                try {
                    actor = fx.get_actor?.();
                }
                catch { }
                const owner = (() => {
                    try {
                        return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)';
                    }
                    catch {
                        return '(?)';
                    }
                })();
                const res = (() => { try {
                    return fx.getResolution();
                }
                catch {
                    return [0, 0];
                } })();
                lines.push(`── ${owner} res=${res[0]}x${res[1]} captureClip=${JSON.stringify(fx._lgCaptureClip ?? null)}`);
                const walk = (a, depth) => {
                    let children = [];
                    try {
                        children = a.get_children();
                    }
                    catch {
                        return;
                    }
                    for (const c of children) {
                        let name = '(?)', vis = true, op = 255;
                        try {
                            name = c.get_name() || `(${c.constructor?.name ?? 'actor'})`;
                        }
                        catch { }
                        try {
                            vis = c.visible;
                            op = c.opacity;
                        }
                        catch { }
                        if (!vis || op === 0) {
                            let geom = '?';
                            try {
                                geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                                    `size=${Math.round(c.width)}x${Math.round(c.height)}`;
                            }
                            catch { }
                            lines.push(`   ${'  '.repeat(depth)}NOT PAINTED "${name}" vis=${vis} op=${op} ` +
                                `culled=${!!c._lgCulled} ${geom}`);
                        }
                        else if (depth < 6) {
                            walk(c, depth + 1);
                        }
                    }
                };
                if (actor)
                    walk(actor, 0);
            }
            const out = lines.join('\n');
            console.log(out);
            return out;
        },
        compositeRect: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setCompositeRectEnabled(enabled);
                    n++;
                }
                catch { }
            }
            const msg = `[Liquid Glass] composite sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        cropPass: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setCropPassEnabled(enabled);
                    n++;
                }
                catch { }
            }
            const msg = `[Liquid Glass] crop pass ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        blurCache: (enabled) => {
            blurCacheDefault = !!enabled;
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setBlurCacheEnabled(enabled);
                    n++;
                }
                catch { }
            }
            const msg = `[Liquid Glass] cross-frame blur cache ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        earlyExit: (enabled) => {
            let n = 0;
            for (const fx of _liveEffects) {
                try {
                    fx.setEarlyExitEnabled(enabled);
                    n++;
                }
                catch { }
            }
            const msg = `[Liquid Glass] early exits ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
            console.log(msg);
            return msg;
        },
        dump: () => {
            const now = GLib.get_monotonic_time();
            const rows = [..._liveEffects].map(fx => _dumpRow(fx, now));
            const out = rows.length ? rows.join('\n') : '(no live LiquidEffect)';
            console.log(`[Liquid Glass][dump]\n${out}`);
            return out;
        },
    };
}
export function registerGlassEffect(effect) {
    _liveEffects.add(effect);
    _registerGlassDebugHooks();
}
export function unregisterGlassEffect(effect) {
    _liveEffects.delete(effect);
    if (_liveEffects.size === 0)
        releaseFrameSerialHook();
}
