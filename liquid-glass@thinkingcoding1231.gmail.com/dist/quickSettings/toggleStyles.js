import St from 'gi://St';
import GLib from 'gi://GLib';
export class ToggleStyles {
    _logger;
    _isOpen;
    constructor(_logger, _isOpen) {
        this._logger = _logger;
        this._isOpen = _isOpen;
    }
    sync(root) {
        const toggles = this._findAllToggleContainers(root);
        this._ensureToggleStyles(toggles);
        return toggles;
    }
    colorFor(actor) {
        return this._toggleRegions.get(actor);
    }
    resetDiagnostics() {
        this._debugToggleColorLogFrames = 15;
    }
    static TOGGLE_COLOR_SAMPLE_MS = 100;
    static TOGGLE_COLOR_FULL_PASS_EVERY = 8;
    _toggleRegions = new Map();
    _toggleColorTimerId = 0;
    _resamplePassCount = 0;
    _debugToggleColorLogFrames = 15;
    _findAllToggleContainers(actor, found = [], inSystemItem = false) {
        if (!actor)
            return found;
        let isHasMenuPod = actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-has-menu');
        if (isHasMenuPod) {
            if (actor.visible)
                found.push(actor);
            return found;
        }
        let isToggle = actor instanceof St.Widget && actor.has_style_class_name('quick-toggle');
        if (isToggle) {
            if (actor.visible)
                found.push(actor);
            return found;
        }
        if (inSystemItem && actor instanceof St.Widget && actor.has_style_class_name('icon-button')) {
            if (actor.visible)
                found.push(actor);
            return found;
        }
        if (actor instanceof St.Widget && actor.has_style_class_name('quick-slider')) {
            if (actor.visible && this._paintsOwnBackground(actor))
                found.push(actor);
            return found;
        }
        let entersSystemItem = inSystemItem ||
            (actor instanceof St.Widget && actor.has_style_class_name('quick-settings-system-item'));
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let child of children)
            this._findAllToggleContainers(child, found, entersSystemItem);
        return found;
    }
    _paintsOwnBackground(actor) {
        if (this._toggleRegions.has(actor))
            return true;
        let bg = this._readThemeBg(actor);
        return !!(bg && bg.a > 0.02);
    }
    _getStylableSubActors(pod) {
        const found = [];
        const walk = (actor) => {
            if (actor instanceof St.Widget)
                found.push(actor);
            let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
            for (let child of children)
                walk(child);
        };
        walk(pod);
        return found;
    }
    _getPrimaryToggleButton(pod) {
        if (pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu')) {
            let found = null;
            const search = (actor) => {
                if (found)
                    return;
                let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
                for (let child of children) {
                    if (found)
                        return;
                    if (child instanceof St.Widget && child.has_style_class_name('quick-toggle')) {
                        found = child;
                        return;
                    }
                    search(child);
                }
            };
            search(pod);
            if (found)
                return found;
        }
        return pod;
    }
    _getToggleIconActors(root) {
        const found = [];
        const walk = (actor) => {
            if (actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-icon')) {
                found.push(actor);
            }
            let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
            for (let child of children)
                walk(child);
        };
        if (root)
            walk(root);
        return found;
    }
    _readThemeBg(actor) {
        if (!(actor instanceof St.Widget))
            return null;
        actor.ensure_style();
        let themeNode = actor.get_theme_node();
        if (!themeNode)
            return null;
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
        }
        catch (e) {
        }
        if (!bg)
            return null;
        return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };
    }
    _compositeOverAncestors(actor, own) {
        let outR = 0, outG = 0, outB = 0, outA = 0;
        const add = (c) => {
            if (!c || !(c.a > 0))
                return;
            let w = c.a * (1 - outA);
            outR += c.r * w;
            outG += c.g * w;
            outB += c.b * w;
            outA += w;
        };
        add(own);
        let node = actor ? actor.get_parent() : null;
        let guard = 32;
        while (node && outA < 0.995 && guard-- > 0) {
            if (node instanceof St.Widget)
                add(this._readThemeBg(node));
            node = node.get_parent();
        }
        if (outA <= 0)
            return { r: 0, g: 0, b: 0, a: 0 };
        return { r: outR / outA, g: outG / outA, b: outB / outA, a: outA };
    }
    _samplePodColor(pod, primary) {
        let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');
        let candidates = [primary];
        if (isHasMenu && pod !== primary)
            candidates.push(pod);
        for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod)) {
            if (icon !== primary && icon !== pod)
                candidates.push(icon);
        }
        let bestActor = null;
        let bestOwn = null;
        for (let candidate of candidates) {
            let own = this._readThemeBg(candidate);
            if (!own)
                continue;
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
    _ensureToggleStyles(toggles) {
        const OVERRIDE = 'background-color: transparent !important;';
        for (let pod of toggles) {
            if (!(pod instanceof St.Widget))
                continue;
            let entry = this._toggleRegions.get(pod);
            if (!entry) {
                entry = { destroyId: 0, baseColor: [1.0, 1.0, 1.0], baseAlpha: 0, styledSubs: [], stateKey: '' };
                this._toggleRegions.set(pod, entry);
                entry.destroyId = pod.connect('destroy', () => {
                    this._toggleRegions.delete(pod);
                });
            }
            let primary = this._getPrimaryToggleButton(pod);
            if (primary instanceof St.Widget) {
                let curStyle = typeof primary.get_style === 'function' ? primary.get_style() : null;
                if (!curStyle || !curStyle.includes(OVERRIDE)) {
                    let sampled = this._samplePodColor(pod, primary);
                    if (sampled.a > 0.02) {
                        entry.baseColor = [sampled.r, sampled.g, sampled.b];
                        entry.baseAlpha = sampled.a;
                    }
                }
            }
            let known = new Set(entry.styledSubs.map(s => s.actor));
            for (let sub of this._getStylableSubActors(pod)) {
                if (!(sub instanceof St.Widget))
                    continue;
                let style = typeof sub.get_style === 'function' ? sub.get_style() : null;
                if (style && style.includes(OVERRIDE))
                    continue;
                let origStyle = style || '';
                let newStyle = origStyle ? `${origStyle} ${OVERRIDE}` : OVERRIDE;
                sub.set_style(newStyle);
                if (!known.has(sub))
                    entry.styledSubs.push({ actor: sub, origStyle });
            }
        }
    }
    _resampleToggleColors() {
        let forceFull = (this._resamplePassCount++ % ToggleStyles.TOGGLE_COLOR_FULL_PASS_EVERY) === 0;
        for (const [pod, entry] of this._toggleRegions.entries()) {
            if (!pod)
                continue;
            let primary = this._getPrimaryToggleButton(pod);
            let stateKey = this._podStateKey(pod, primary);
            if (!forceFull && stateKey === entry.stateKey)
                continue;
            entry.stateKey = stateKey;
            for (const { actor, origStyle } of entry.styledSubs) {
                if (actor instanceof St.Widget)
                    actor.set_style(origStyle || null);
            }
            if (pod instanceof St.Widget && pod.has_style_class_name('quick-slider')) {
                let pill = this._readThemeBg(pod);
                if (!(pill && pill.a > 0.02)) {
                    this._logger.log(`[Liquid Glass][toggle-color] releasing .quick-slider pod — theme no longer paints a pill ` +
                        `(bg=${JSON.stringify(pill)})`);
                    if (entry.destroyId)
                        pod.disconnect(entry.destroyId);
                    this._toggleRegions.delete(pod);
                    continue;
                }
            }
            if (primary instanceof St.Widget) {
                let sampled = this._samplePodColor(pod, primary);
                if (sampled.a > 0.02) {
                    entry.baseColor = [sampled.r, sampled.g, sampled.b];
                    entry.baseAlpha = sampled.a;
                }
                if (this._debugToggleColorLogFrames > 0) {
                    let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');
                    let podCls = pod instanceof St.Widget && typeof pod.get_style_class_name === 'function' ? (pod.get_style_class_name() || '') : '';
                    let primaryCls = typeof primary.get_style_class_name === 'function' ? (primary.get_style_class_name() || '') : '';
                    let checked = typeof primary.has_style_pseudo_class === 'function' ? primary.has_style_pseudo_class('checked') : 'n/a';
                    let wrapperBg = isHasMenu ? this._readThemeBg(pod) : null;
                    let iconBgs = this._getToggleIconActors(pod !== primary ? primary : pod)
                        .map(a => JSON.stringify(this._readThemeBg(a))).join(' ');
                    this._logger.log(`[Liquid Glass][toggle-color] pod class="${podCls}" isHasMenu=${isHasMenu} ` +
                        `primary class="${primaryCls}" checked=${checked} ` +
                        `primaryBg=${JSON.stringify(this._readThemeBg(primary))} ` +
                        `wrapperBg=${wrapperBg ? JSON.stringify(wrapperBg) : 'n/a'} ` +
                        `iconBg=[${iconBgs || 'none'}] ` +
                        `chosen.a=${sampled.a.toFixed(2)} trusted=${sampled.a > 0.02} ` +
                        `entry.baseColor=[${entry.baseColor.map(v => v.toFixed(2)).join(',')}] entry.baseAlpha=${entry.baseAlpha.toFixed(2)}`);
                }
            }
            for (const { actor, origStyle } of entry.styledSubs) {
                if (!(actor instanceof St.Widget))
                    continue;
                let newStyle = origStyle
                    ? `${origStyle} background-color: transparent !important;`
                    : `background-color: transparent !important;`;
                actor.set_style(newStyle);
            }
        }
        if (this._debugToggleColorLogFrames > 0)
            this._debugToggleColorLogFrames--;
    }
    start() {
        this._resampleToggleColors();
        if (this._toggleColorTimerId !== 0)
            return;
        this._toggleColorTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ToggleStyles.TOGGLE_COLOR_SAMPLE_MS, () => {
            if (!this._isOpen()) {
                this._toggleColorTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._resampleToggleColors();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _podStateKey(pod, primary) {
        const STATES = ['checked', 'hover', 'active', 'insensitive', 'focus', 'selected'];
        let actors = [pod];
        if (primary !== pod)
            actors.push(primary);
        for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod))
            actors.push(icon);
        let key = '';
        for (let actor of actors) {
            if (!(actor instanceof St.Widget) || typeof actor.has_style_pseudo_class !== 'function') {
                key += '?|';
                continue;
            }
            for (let state of STATES) {
                key += actor.has_style_pseudo_class(state) ? '1' : '0';
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
        for (const [pod, entry] of this._toggleRegions.entries()) {
            if (entry.destroyId) {
                try {
                    pod.disconnect(entry.destroyId);
                }
                catch (_) { }
            }
            for (const { actor, origStyle } of entry.styledSubs) {
                if (actor instanceof St.Widget && typeof actor.set_style === 'function') {
                    try {
                        actor.set_style(origStyle || null);
                    }
                    catch (e) { }
                }
            }
        }
        this._toggleRegions.clear();
    }
}
