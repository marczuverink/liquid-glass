import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import type { Logger } from '../logger.js';

const TRANSPARENT_OVERRIDE = 'background-color: transparent !important;';

type ToggleEntry = {
  destroyId: number;
  baseColor: [number, number, number];
  baseAlpha: number;
  styledSubs: { actor: Clutter.Actor; origStyle: string }[];
  stateKey: string;
};

function _withOverride(origStyle: string): string {
  return origStyle ? `${origStyle} ${TRANSPARENT_OVERRIDE}` : TRANSPARENT_OVERRIDE;
}

function _releaseEntry(pod: Clutter.Actor, entry: ToggleEntry): void {
  if (entry.destroyId) {
    try { pod.disconnect(entry.destroyId); } catch { }
  }
  for (const { actor, origStyle } of entry.styledSubs) {
    if (!(actor instanceof St.Widget) || typeof actor.set_style !== 'function') continue;
    try { actor.set_style(origStyle || null); } catch { }
  }
}

export class ToggleStyles {
  constructor(private _logger: Logger, private _isOpen: () => boolean) {}

  sync(root: Clutter.Actor): Clutter.Actor[] {
    const toggles = this._findAllToggleContainers(root);
    this._ensureToggleStyles(toggles);
    return toggles;
  }

  colorFor(actor: Clutter.Actor): { readonly baseColor: readonly number[]; readonly baseAlpha: number } | undefined {
    return this._toggleRegions.get(actor);
  }

  resetDiagnostics(): void {
    this._debugToggleColorLogFrames = 15;
  }

  private static readonly TOGGLE_COLOR_SAMPLE_MS = 100;

  private static readonly TOGGLE_COLOR_FULL_PASS_EVERY = 8;

  private _toggleRegions: Map<Clutter.Actor, ToggleEntry> = new Map();

  private _toggleColorTimerId: number = 0;

  private _resamplePassCount: number = 0;

  private _debugToggleColorLogFrames: number = 15;

  private _findAllToggleContainers(
    actor: Clutter.Actor,
    found: Clutter.Actor[] = [],
    inSystemItem: boolean = false
  ): Clutter.Actor[] {
    if (!actor) return found;

    const leaf = this._toggleLeafKind(actor, inSystemItem);
    if (leaf === 'slider') {
      if (actor.visible && this._paintsOwnBackground(actor)) found.push(actor);
      return found;
    }
    if (leaf === 'toggle') {
      if (actor.visible) found.push(actor);
      return found;
    }

    let entersSystemItem = inSystemItem ||
      (actor instanceof St.Widget && actor.has_style_class_name('quick-settings-system-item'));

    let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
    for (let child of children) this._findAllToggleContainers(child, found, entersSystemItem);
    return found;
  }

  private _toggleLeafKind(actor: Clutter.Actor, inSystemItem: boolean): 'toggle' | 'slider' | null {
    if (!(actor instanceof St.Widget)) return null;
    if (actor.has_style_class_name('quick-toggle-has-menu')) return 'toggle';
    if (actor.has_style_class_name('quick-toggle')) return 'toggle';
    if (inSystemItem && actor.has_style_class_name('icon-button')) return 'toggle';
    if (actor.has_style_class_name('quick-slider')) return 'slider';
    return null;
  }

  private _paintsOwnBackground(actor: Clutter.Actor): boolean {
    if (this._toggleRegions.has(actor)) return true;
    let bg = this._readThemeBg(actor);
    return !!(bg && bg.a > 0.02);
  }

  private _getStylableSubActors(pod: Clutter.Actor): Clutter.Actor[] {
    const found: Clutter.Actor[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor instanceof St.Widget) found.push(actor);
      let children = typeof (actor as any).get_children === 'function' ? (actor as any).get_children() : [];
      for (let child of children) walk(child);
    };
    walk(pod);
    return found;
  }

  private _getPrimaryToggleButton(pod: Clutter.Actor): Clutter.Actor {
    if (pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu')) {
      let found: Clutter.Actor | null = null;
      const search = (actor: Clutter.Actor) => {
        if (found) return;
        let children = typeof (actor as any).get_children === 'function' ? (actor as any).get_children() : [];
        for (let child of children) {
          if (found) return;
          if (child instanceof St.Widget && child.has_style_class_name('quick-toggle')) {
            found = child;
            return;
          }
          search(child);
        }
      };
      search(pod);
      if (found) return found;
    }
    return pod;
  }

  private _getToggleIconActors(root: Clutter.Actor): Clutter.Actor[] {
    const found: Clutter.Actor[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-icon')) {
        found.push(actor);
      }
      let children = typeof (actor as any).get_children === 'function' ? (actor as any).get_children() : [];
      for (let child of children) walk(child);
    };
    if (root) walk(root);
    return found;
  }

  private _readThemeBg(actor: Clutter.Actor | null): { r: number; g: number; b: number; a: number } | null {
    if (!(actor instanceof St.Widget)) return null;
    actor.ensure_style();
    let themeNode = actor.get_theme_node();
    if (!themeNode) return null;

    let bg = themeNode.get_background_color();
    if (bg && bg.alpha / 255 > 0.02)
      return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };

    try {
      let [gradType, start, end] = themeNode.get_background_gradient();
      if (gradType !== St.GradientType.NONE && start && end) {
        let a = ((start.alpha + end.alpha) / 2) / 255;
        if (a > 0.02) {
          return {
            r: ((start.red + end.red) / 2) / 255,
            g: ((start.green + end.green) / 2) / 255,
            b: ((start.blue + end.blue) / 2) / 255,
            a,
          };
        }
      }
    } catch {
    }

    if (!bg) return null;
    return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };
  }

  private _compositeOverAncestors(
    actor: Clutter.Actor | null,
    own: { r: number; g: number; b: number; a: number } | null
  ): { r: number; g: number; b: number; a: number } {
    let outR = 0, outG = 0, outB = 0, outA = 0;

    const add = (c: { r: number; g: number; b: number; a: number } | null) => {
      if (!c || !(c.a > 0)) return;
      let w = c.a * (1 - outA);
      outR += c.r * w;
      outG += c.g * w;
      outB += c.b * w;
      outA += w;
    };

    add(own);

    let node: Clutter.Actor | null = actor ? actor.get_parent() : null;
    let guard = 32;
    while (node && outA < 0.995 && guard-- > 0) {
      if (node instanceof St.Widget) add(this._readThemeBg(node));
      node = node.get_parent();
    }

    if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: outR / outA, g: outG / outA, b: outB / outA, a: outA };
  }

  private _samplePodColor(pod: Clutter.Actor, primary: Clutter.Actor): { r: number; g: number; b: number; a: number } {
    let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');

    let candidates: Clutter.Actor[] = [primary];
    if (isHasMenu && pod !== primary) candidates.push(pod);
    for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod)) {
      if (icon !== primary && icon !== pod) candidates.push(icon);
    }

    let bestActor: Clutter.Actor | null = null;
    let bestOwn: { r: number; g: number; b: number; a: number } | null = null;
    for (let candidate of candidates) {
      let own = this._readThemeBg(candidate);
      if (!own) continue;
      if (!bestOwn || own.a > bestOwn.a) {
        bestOwn = own;
        bestActor = candidate;
      }
    }

    if (bestOwn && bestOwn.a > 0.02) {
      return this._compositeOverAncestors(bestActor, bestOwn);
    }

    return this._compositeOverAncestors(pod, null);
  }

  private _ensureToggleStyles(toggles: Clutter.Actor[]) {
    for (let pod of toggles) {
      if (!(pod instanceof St.Widget)) continue;
      const entry = this._ensureEntry(pod);
      const primary = this._getPrimaryToggleButton(pod);
      if (primary instanceof St.Widget && !this._hasOverride(primary)) this._updateBaseColor(entry, pod, primary);
      this._overrideSubStyles(entry, pod);
    }
  }

  private _ensureEntry(pod: Clutter.Actor): ToggleEntry {
    let entry = this._toggleRegions.get(pod);
    if (entry) return entry;
    entry = { destroyId: 0, baseColor: [1.0, 1.0, 1.0], baseAlpha: 0, styledSubs: [], stateKey: '' };
    this._toggleRegions.set(pod, entry);
    entry.destroyId = pod.connect('destroy', () => {
      this._toggleRegions.delete(pod);
    });
    return entry;
  }

  private _hasOverride(actor: St.Widget): boolean {
    const style = typeof actor.get_style === 'function' ? actor.get_style() : null;
    return !!style && style.includes(TRANSPARENT_OVERRIDE);
  }

  private _updateBaseColor(entry: ToggleEntry, pod: Clutter.Actor, primary: St.Widget) {
    const sampled = this._samplePodColor(pod, primary);
    if (sampled.a > 0.02) {
      entry.baseColor = [sampled.r, sampled.g, sampled.b];
      entry.baseAlpha = sampled.a;
    }
    return sampled;
  }

  private _overrideSubStyles(entry: ToggleEntry, pod: Clutter.Actor) {
    const known = new Set(entry.styledSubs.map(s => s.actor));
    for (let sub of this._getStylableSubActors(pod)) {
      if (!(sub instanceof St.Widget) || this._hasOverride(sub)) continue;
      const origStyle = sub.get_style() || '';
      sub.set_style(_withOverride(origStyle));
      if (!known.has(sub)) entry.styledSubs.push({ actor: sub, origStyle });
    }
  }

  private _resampleToggleColors() {
    let forceFull = (this._resamplePassCount++ % ToggleStyles.TOGGLE_COLOR_FULL_PASS_EVERY) === 0;
    for (const [pod, entry] of this._toggleRegions.entries()) {
      if (pod) this._resamplePod(pod, entry, forceFull);
    }
    if (this._debugToggleColorLogFrames > 0) this._debugToggleColorLogFrames--;
  }

  private _resamplePod(pod: Clutter.Actor, entry: ToggleEntry, forceFull: boolean) {
    const primary = this._getPrimaryToggleButton(pod);
    const stateKey = this._podStateKey(pod, primary);
    if (!forceFull && stateKey === entry.stateKey) return;
    entry.stateKey = stateKey;

    for (const { actor, origStyle } of entry.styledSubs) {
      if (actor instanceof St.Widget) actor.set_style(origStyle || null);
    }

    if (this._releaseIfSliderLostPill(pod, entry)) return;

    if (primary instanceof St.Widget) {
      const sampled = this._updateBaseColor(entry, pod, primary);
      if (this._debugToggleColorLogFrames > 0) this._logPodColor(pod, primary, entry, sampled);
    }

    for (const { actor, origStyle } of entry.styledSubs) {
      if (actor instanceof St.Widget) actor.set_style(_withOverride(origStyle));
    }
  }

  private _releaseIfSliderLostPill(pod: Clutter.Actor, entry: ToggleEntry): boolean {
    if (!(pod instanceof St.Widget) || !pod.has_style_class_name('quick-slider')) return false;
    const pill = this._readThemeBg(pod);
    if (pill && pill.a > 0.02) return false;
    this._logger.log(
      `[Liquid Glass][toggle-color] releasing .quick-slider pod — theme no longer paints a pill ` +
      `(bg=${JSON.stringify(pill)})`
    );
    if (entry.destroyId) {
      try { pod.disconnect(entry.destroyId); } catch { }
    }
    this._toggleRegions.delete(pod);
    return true;
  }

  private _logPodColor(pod: Clutter.Actor, primary: St.Widget, entry: ToggleEntry, sampled: { a: number }) {
    let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');
    let podCls = pod instanceof St.Widget && typeof pod.get_style_class_name === 'function' ? (pod.get_style_class_name() || '') : '';
    let primaryCls = typeof primary.get_style_class_name === 'function' ? (primary.get_style_class_name() || '') : '';
    let checked = typeof (primary as any).has_style_pseudo_class === 'function' ? (primary as any).has_style_pseudo_class('checked') : 'n/a';
    let wrapperBg = isHasMenu ? this._readThemeBg(pod) : null;
    let iconBgs = this._getToggleIconActors(pod !== primary ? primary : pod)
      .map(a => JSON.stringify(this._readThemeBg(a))).join(' ');
    this._logger.log(
      `[Liquid Glass][toggle-color] pod class="${podCls}" isHasMenu=${isHasMenu} ` +
      `primary class="${primaryCls}" checked=${checked} ` +
      `primaryBg=${JSON.stringify(this._readThemeBg(primary))} ` +
      `wrapperBg=${wrapperBg ? JSON.stringify(wrapperBg) : 'n/a'} ` +
      `iconBg=[${iconBgs || 'none'}] ` +
      `chosen.a=${sampled.a.toFixed(2)} trusted=${sampled.a > 0.02} ` +
      `entry.baseColor=[${entry.baseColor.map(v => v.toFixed(2)).join(',')}] entry.baseAlpha=${entry.baseAlpha.toFixed(2)}`
    );
  }

  start() {
    this._resampleToggleColors();
    if (this._toggleColorTimerId !== 0) return;

    this._toggleColorTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT, ToggleStyles.TOGGLE_COLOR_SAMPLE_MS, () => {
      if (!this._isOpen()) {
        this._toggleColorTimerId = 0;
        return GLib.SOURCE_REMOVE;
      }
      this._resampleToggleColors();
      return GLib.SOURCE_CONTINUE;
    });
  }

  private _podStateKey(pod: Clutter.Actor, primary: Clutter.Actor): string {
    const STATES = ['checked', 'hover', 'active', 'insensitive', 'focus', 'selected'];

    let actors: Clutter.Actor[] = [pod];
    if (primary !== pod) actors.push(primary);
    for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod)) actors.push(icon);

    let key = '';
    for (let actor of actors) {
      if (!(actor instanceof St.Widget) || typeof (actor as any).has_style_pseudo_class !== 'function') {
        key += '?|';
        continue;
      }
      for (let state of STATES) {
        key += (actor as any).has_style_pseudo_class(state) ? '1' : '0';
      }
      key += '|';
    }
    return key;
  }

  stop() {
    if (this._toggleColorTimerId !== 0) {
      GLib.source_remove(this._toggleColorTimerId);
      this._toggleColorTimerId = 0;
    }
  }

  clear() {
    this.stop();
    for (const [pod, entry] of this._toggleRegions.entries()) _releaseEntry(pod, entry);
    this._toggleRegions.clear();
  }
}
