import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { releaseFrameSerialHook } from '../rendering/frameClock.js';
import { setBmsMode, BMS_MODE } from '../capture/uiLayerSampler.js';
import { setFrameSyncFrozen, isFrameSyncFrozen } from '../animation/frameSync.js';
import { setDiffWritesEnabled, isDiffWritesEnabled } from '../actors/writes.js';
import { setCaptureClipEnabled, isCaptureClipEnabled, setCloneCullEnabled, isCloneCullEnabled, setCullSiteEnabled, isCullSiteEnabled } from '../capture/options.js';
import { setAdaptiveColorMode, getAdaptiveColorMode, type AdaptiveColorMode } from '../animation/colors.js';
import { setNestedGlassFix, getNestedGlassFix, type NestedGlassFix, setFocusDebugEnabled, isFocusDebugEnabled } from '../capture/nestedGlass.js';
import { setBackgroundMirrorEnabled, isBackgroundMirrorEnabled } from '../capture/background.js';
import { setCullOptOutEnabled, isCullOptOutEnabled } from '../capture/windowCulling.js';
import { setWindowActorRescueMode, getWindowActorRescueMode, type WindowActorRescueMode } from '../actors/allocation.js';
const _liveEffects: Set<any> = new Set();

export let blurCacheDefault = true;

const RING_MAX = 4000;
const _ring: string[] = [];
let _ringLast: Map<any, string> = new Map();

function _ringSampleOnce(): void {
  const t = GLib.get_monotonic_time();
  for (const fx of _liveEffects) {
    if (fx._owner !== 'application') continue;
    let line = '';
    try {
      const a: any = fx.get_actor();
      if (!a) continue;
      const wa: any = a.get_parent();
      if (!wa) continue;
      const trOp: any = wa.get_transition ? wa.get_transition('opacity') : null;
      const mw = wa.get_meta_window ? wa.get_meta_window() : null;
      line =
        `${fx._diagOwnerLabel || '?'}|sc=${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}` +
        `|op=${wa.opacity}|pos=${Math.round(wa.x)},${Math.round(wa.y)}` +
        `|map=${wa.mapped ? 1 : 0}|alloc=${wa.has_allocation() ? 1 : 0}` +
        `|gAlloc=${a.has_allocation() ? 1 : 0}|gPos=${Math.round(a.x)},${Math.round(a.y)}` +
        `|gSize=${Math.round(a.width)}x${Math.round(a.height)}` +
        `|min=${mw && mw.minimized ? 1 : 0}` +
        `|wgAlloc=${(() => { const wg: any = wa.get_parent();
          return wg ? (wg.has_allocation() ? 1 : 0) : '-'; })()}` +
        `|views=${(wa.peek_stage_views() || []).length}` +
        (trOp
          ? `|tr=${trOp.is_playing() ? 'play' : 'stop'},${trOp.get_progress().toFixed(3)},` +
            `${trOp.get_frame_clock() ? 'clk' : 'NOCLK'}`
          : '|tr=-');
    } catch (_) {
      continue;
    }
    if (_ringLast.get(fx) === line) continue;
    _ringLast.set(fx, line);
    _ring.push(`${t} ${line}`);
    if (_ring.length > RING_MAX) _ring.shift();
  }
}

let _autoCaptures = 0;
const AUTO_CAPTURE_LIMIT = 6;

export function noteStrandEntry(label: string, detail: string): void {
  if (!_ringArmed) return;
  if (_autoCaptures >= AUTO_CAPTURE_LIMIT) return;
  _autoCaptures++;
  console.log(`[Liquid Glass][ring] AUTO-CAPTURE ${_autoCaptures}/${AUTO_CAPTURE_LIMIT} ` +
    `on strand entry for "${label}" — ${detail}`);
  try { flushGlassRing(); } catch (e) { console.error(`[Liquid Glass][ring] ${e}`); }
}

let _ringArmed = false;
let _ringSamplerEnabled = false;
let _ringSamplerId = 0;
let _ringSamplerInterval = 50;

function syncGlassRingSampler(): void {
  if (!_ringArmed || !_ringSamplerEnabled) {
    if (_ringSamplerId) GLib.Source.remove(_ringSamplerId);
    _ringSamplerId = 0;
  } else if (!_ringSamplerId) {
    _ringSamplerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, _ringSamplerInterval, () => {
      try { _ringSampleOnce(); } catch (_) { }
      return GLib.SOURCE_CONTINUE;
    });
  }
}

export function setGlassRingArmed(armed: boolean): void {
  _ringArmed = !!armed;
  syncGlassRingSampler();
  if (!_ringArmed) {
    _ring.length = 0;
    _ringLast = new Map();
    _autoCaptures = 0;
  }
}
export function isGlassRingArmed(): boolean {
  return _ringArmed;
}

export function startGlassRingSampler(intervalMs: number = 50): void {
  _ringSamplerInterval = intervalMs;
  _ringSamplerEnabled = true;
  syncGlassRingSampler();
}

export function stopGlassRingSampler(): void {
  _ringSamplerEnabled = false;
  setGlassRingArmed(false);
}

export function flushGlassRing(): void {
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

function _registerGlassDebugHooks(): void {
  const g = globalThis as any;
  if (!g.global || g.global._lgGlass) return;
  g.global._lgGlass = {
    count: () => _liveEffects.size,
    debugView: (mode: number) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setDebugView(mode); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] debug_view = ${mode} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },
    bmsMode: (mode: number) => setBmsMode(mode),
    BMS_MODE,

    blurRect: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setBlurRectEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] blur sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },

    freezeSync: (frozen: boolean) => {
      setFrameSyncFrozen(frozen);
      const msg = `[Liquid Glass] per-frame sync ${frozen ? 'FROZEN' : 'RUNNING'}`;
      console.log(msg);
      return msg;
    },
    syncFrozen: () => isFrameSyncFrozen(),

    textColorMode: (mode: string) => {
      const m: AdaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
      setAdaptiveColorMode(m);
      const msg = `[Liquid Glass] adaptive text colour mode = ${m}`;
      console.log(msg);
      return msg;
    },
    textColorModeName: () => getAdaptiveColorMode(),

    nestedFix: (mode: string) => {
      const m = mode as NestedGlassFix;
      setNestedGlassFix(m);
      const msg = `[Liquid Glass] nested-glass repair = ${m}`;
      console.log(msg);
      return msg;
    },
    nestedFixMode: () => getNestedGlassFix(),

    bgMirror: (on: boolean) => {
      setBackgroundMirrorEnabled(on);
      const msg = `[Liquid Glass] background mirror ${on ? 'ENABLED' : 'disabled'} ` +
        '(toggle the extension off/on to rebuild existing glass)';
      console.log(msg);
      return msg;
    },
    bgMirrorEnabled: () => isBackgroundMirrorEnabled(),

    cullOptOut: (on: boolean) => {
      setCullOptOutEnabled(on);
      const msg = `[Liquid Glass] cloned-window cull opt-out ${on ? 'ENABLED' : 'disabled'}`;
      console.log(msg);
      return msg;
    },
    cullOptOutEnabled: () => isCullOptOutEnabled(),

    windowRescue: (mode: string) => {
      setWindowActorRescueMode(mode as WindowActorRescueMode);
      const msg = `[Liquid Glass] window-actor rescue = ${getWindowActorRescueMode()}`;
      console.log(msg);
      return msg;
    },
    windowRescueMode: () => getWindowActorRescueMode(),

    ring: (on: boolean) => {
      setGlassRingArmed(on);
      const msg = `[Liquid Glass] ring recorder ${on ? 'ARMED (50ms)' : 'disarmed'}`;
      console.log(msg);
      return msg;
    },
    ringArmed: () => isGlassRingArmed(),
    ringFlush: () => { flushGlassRing(); return 'flushed'; },

    focusDebug: (on: boolean) => {
      setFocusDebugEnabled(on);
      const msg = `[Liquid Glass] focus-debug logging ${on ? 'ENABLED' : 'disabled'}`;
      console.log(msg);
      return msg;
    },
    focusDebugEnabled: () => isFocusDebugEnabled(),

    diffWrites: (enabled: boolean) => {
      setDiffWritesEnabled(enabled);
      const msg = `[Liquid Glass] diff writes ${enabled ? 'ENABLED' : 'DISABLED'}`;
      console.log(msg);
      return msg;
    },
    diffWritesEnabled: () => isDiffWritesEnabled(),

    captureClip: (enabled: boolean) => {
      setCaptureClipEnabled(enabled);
      const msg = `[Liquid Glass] capture clip ${enabled ? 'ENABLED' : 'DISABLED'}`;
      console.log(msg);
      return msg;
    },
    captureClipEnabled: () => isCaptureClipEnabled(),

    cloneCull: (enabled: boolean) => {
      setCloneCullEnabled(enabled);
      const msg = `[Liquid Glass] clone cull ${enabled ? 'ENABLED' : 'DISABLED'}`;
      console.log(msg);
      return msg;
    },
    cloneCullEnabled: () => isCloneCullEnabled(),

    cullApp: (enabled: boolean) => {
      setCullSiteEnabled('app', enabled);
      const msg = `[Liquid Glass] cull site app (behind-window clones) ${enabled ? 'ON' : 'OFF'}`;
      console.log(msg);
      return msg;
    },
    cullWindows: (enabled: boolean) => {
      setCullSiteEnabled('windows', enabled);
      const msg = `[Liquid Glass] cull site windows (dock/menu window clones) ${enabled ? 'ON' : 'OFF'}`;
      console.log(msg);
      return msg;
    },
    cullUi: (enabled: boolean) => {
      setCullSiteEnabled('ui', enabled);
      const msg = `[Liquid Glass] cull site ui (uiGroup clones) ${enabled ? 'ON' : 'OFF'}`;
      console.log(msg);
      return msg;
    },
    treeReport: (maxDepth: number = 4) => {
      const lines: string[] = [];
      for (const fx of _liveEffects) {
        let actor: any = null;
        try { actor = (fx as any).get_actor?.(); } catch (e) { }
        const owner = (() => {
          try { return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)'; }
          catch (e) { return '(?)'; }
        })();
        const res = (() => { try { return (fx as any).getResolution(); } catch (e) { return [0, 0]; } })();
        lines.push(`── ${owner} res=${res[0]}x${res[1]}`);
        const walk = (a: any, depth: number) => {
          if (depth > maxDepth) return;
          let children: any[] = [];
          try { children = a.get_children(); } catch (e) { return; }
          for (const c of children) {
            let name = '(?)', vis = true, op = 255, geom = '?';
            try { name = c.get_name() || '(unnamed)'; } catch (e) { }
            try {
              vis = c.visible; op = c.opacity;
              geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                `p=(${Math.round(c.x)},${Math.round(c.y)}) size=${Math.round(c.width)}x${Math.round(c.height)}`;
            } catch (e) { }
            lines.push(`   ${'  '.repeat(depth)}${vis && op > 0 ? '   ' : 'XX '}"${name}" ` +
              `vis=${vis} op=${op} culled=${!!(c as any)._lgCulled} ${geom}`);
            walk(c, depth + 1);
          }
        };
        if (actor) walk(actor, 0);
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
      const lines: string[] = [];
      for (const fx of _liveEffects) {
        let actor: any = null;
        try { actor = (fx as any).get_actor?.(); } catch (e) { }
        const owner = (() => {
          try { return actor?.get_parent?.()?.get_name?.() ?? actor?.get_name?.() ?? '(?)'; }
          catch (e) { return '(?)'; }
        })();
        const res = (() => { try { return (fx as any).getResolution(); } catch (e) { return [0, 0]; } })();
        lines.push(`── ${owner} res=${res[0]}x${res[1]} captureClip=${JSON.stringify((fx as any)._lgCaptureClip ?? null)}`);
        const walk = (a: any, depth: number) => {
          let children: any[] = [];
          try { children = a.get_children(); } catch (e) { return; }
          for (const c of children) {
            let name = '(?)', vis = true, op = 255;
            try { name = c.get_name() || `(${c.constructor?.name ?? 'actor'})`; } catch (e) { }
            try { vis = c.visible; op = c.opacity; } catch (e) { }
            if (!vis || op === 0) {
              let geom = '?';
              try {
                geom = `t=(${Math.round(c.translation_x)},${Math.round(c.translation_y)}) ` +
                  `size=${Math.round(c.width)}x${Math.round(c.height)}`;
              } catch (e) { }
              lines.push(`   ${'  '.repeat(depth)}NOT PAINTED "${name}" vis=${vis} op=${op} ` +
                `culled=${!!(c as any)._lgCulled} ${geom}`);
            } else if (depth < 6) {
              walk(c, depth + 1);
            }
          }
        };
        if (actor) walk(actor, 0);
      }
      const out = lines.join('\n');
      console.log(out);
      return out;
    },

    compositeRect: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setCompositeRectEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] composite sub-rect ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },

    cropPass: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setCropPassEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] crop pass ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },
    blurCache: (enabled: boolean) => {
      blurCacheDefault = !!enabled;
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setBlurCacheEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] cross-frame blur cache ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },
    earlyExit: (enabled: boolean) => {
      let n = 0;
      for (const fx of _liveEffects) {
        try { fx.setEarlyExitEnabled(enabled); n++; } catch (e) { }
      }
      const msg = `[Liquid Glass] early exits ${enabled ? 'ENABLED' : 'DISABLED'} on ${n} instance(s)`;
      console.log(msg);
      return msg;
    },
    dump: () => {
      const rows: string[] = [];
      const now = GLib.get_monotonic_time();
      for (const fx of _liveEffects) {
        if (!fx._diagLast) {
          rows.push(`(never painted) owner=${fx._owner ?? '?'}${fx._diagOwnerLabel ? ' label=' + fx._diagOwnerLabel : ''}`);
          continue;
        }
        let live: any = {};
        try {
          const a: any = fx.get_actor();
          if (a) {
            live = {
              mapped: a.mapped,
              visible: a.visible,
              hasAlloc: a.has_allocation(),
              opacity: a.opacity,
              pos: `${Math.round(a.x)},${Math.round(a.y)}`,
            };
            const wa: any = a.get_parent();
            if (wa) {
              live.parentMapped = wa.mapped;
              live.parentHasAlloc = wa.has_allocation();
              live.parentOpacity = wa.opacity;
              live.parentScale = `${wa.scale_x.toFixed(3)},${wa.scale_y.toFixed(3)}`;
              try {
                const mw = wa.get_meta_window ? wa.get_meta_window() : null;
                if (mw) {
                  live.minimized = mw.minimized;
                  live.wRect = (() => {
                    const r = mw.get_frame_rect();
                    return `${r.x},${r.y},${r.width}x${r.height}`;
                  })();
                }
              } catch (_) { }

              for (const prop of ['opacity', 'scale-x']) {
                try {
                  const tr: any = wa.get_transition(prop);
                  if (tr) {
                    live[`tr_${prop}`] =
                      `playing=${tr.is_playing()},prog=${tr.get_progress().toFixed(3)}` +
                      `,dur=${tr.get_duration()}` +
                      `,clock=${tr.get_frame_clock() ? 'set' : 'NULL'}`;
                  }
                } catch (_) { }
              }
              try {
                live.waViews = (wa.peek_stage_views() || []).length;
                const wg: any = wa.get_parent();
                if (wg) live.wgViews = (wg.peek_stage_views() || []).length;
                live.glassViews = (a.peek_stage_views() || []).length;
              } catch (_) { }
              try {
                const destroying: any = (Main as any).wm?._destroying;
                if (destroying) live.shellDestroying = destroying.has(wa);
              } catch (_) { }
            }
          }
        } catch (_) { }

        rows.push(JSON.stringify({
          ...fx._diagLast,
          label: fx._diagOwnerLabel || undefined,
          paints: fx._diagPaintCount,
          composited: fx._diagCompositedPaintCount,
          blurRuns: fx._blurRuns,
          blurSkips: fx._blurSkips,
          blurCacheHits: fx._blurCacheHits,
          snapshotAgeMs: Math.round((now - fx._diagLastSnapshotAt) / 1000),
          ...live,
        }));
      }
      const out = rows.length ? rows.join('\n') : '(no live LiquidEffect)';
      console.log(`[Liquid Glass][dump]\n${out}`);
      return out;
    },
  };
}
export function registerGlassEffect(effect: any): void {
  _liveEffects.add(effect);
  _registerGlassDebugHooks();
}

export function unregisterGlassEffect(effect: any): void {
  _liveEffects.delete(effect);
  if (_liveEffects.size === 0) releaseFrameSerialHook();
}
