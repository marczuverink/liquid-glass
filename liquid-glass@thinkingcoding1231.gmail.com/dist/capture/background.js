import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { utilsLog } from '../diagnostics/logging.js';
import Meta from 'gi://Meta';
import { isActorValid } from '../actors/lifecycle.js';
import Shell from 'gi://Shell';
import { UnpickableClone } from '../actors/unpickable.js';
export const BackgroundMirror = GObject.registerClass(class BackgroundMirror extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        this._mirrors = new Map();
        this._groupHandlers = [];
        this._sourceGroup = null;
        const group = Main.layoutManager?._backgroundGroup ?? null;
        if (!group)
            return;
        this._sourceGroup = group;
        this._groupHandlers.push(group.connect('child-added', (_g, child) => this._addMirror(child)), group.connect('child-removed', (_g, child) => this._removeMirror(child)), group.connect('notify::first-child', () => this._restack()), group.connect('notify::last-child', () => this._restack()));
        this.connect('destroy', () => this._onDestroy());
        for (const child of group.get_children())
            this._addMirror(child);
    }
    _contentProps() {
        return [
            'background',
            'brightness',
            'vignette',
            'vignette-sharpness',
            'gradient',
            'gradient-height',
            'gradient-max-darkness',
            'rounded-clip-radius',
        ];
    }
    _addMirror(child) {
        try {
            this._addMirrorUnsafe(child);
        }
        catch (e) {
            utilsLog(`[bg-mirror] _addMirror failed: ${e}`);
        }
    }
    _addMirrorUnsafe(child) {
        if (!child || this._mirrors.has(child))
            return;
        const srcContent = child.content;
        if (!srcContent || !(srcContent instanceof Meta.BackgroundContent))
            return;
        let mirror;
        try {
            mirror = new Meta.BackgroundActor({
                meta_display: global.display,
                monitor: child.monitor,
                reactive: false,
            });
        }
        catch (e) {
            utilsLog(`[bg-mirror] could not create Meta.BackgroundActor: ${e}`);
            return;
        }
        mirror.set_name('lg-bg-mirror');
        mirror.visible = false;
        const dstContent = mirror.content;
        if (dstContent) {
            for (const prop of this._contentProps()) {
                try {
                    srcContent.bind_property(prop, dstContent, prop, GObject.BindingFlags.SYNC_CREATE);
                }
                catch (e) {
                    utilsLog(`[bg-mirror] skipped content prop '${prop}': ${e}`);
                }
            }
            try {
                if (!dstContent.background && srcContent.background)
                    dstContent.set_background(srcContent.background);
            }
            catch (e) {
                utilsLog(`[bg-mirror] set_background failed: ${e}`);
            }
        }
        try {
            child.bind_property('opacity', mirror, 'opacity', GObject.BindingFlags.SYNC_CREATE);
        }
        catch (e) {
            utilsLog(`[bg-mirror] opacity binding failed: ${e}`);
        }
        const syncVisible = () => {
            if (!isActorValid(mirror))
                return;
            let hasBackground = false;
            try {
                hasBackground = !!(mirror.content && mirror.content.background);
            }
            catch { }
            const wanted = hasBackground && isActorValid(child) && child.visible;
            if (mirror.visible !== wanted)
                mirror.visible = wanted;
        };
        const watchers = [];
        try {
            watchers.push([child, child.connect('notify::visible', syncVisible)]);
            watchers.push([child, child.connect('notify::opacity', () => this._restack())]);
            if (dstContent)
                watchers.push([dstContent, dstContent.connect('notify::background', syncVisible)]);
        }
        catch (e) {
            utilsLog(`[bg-mirror] visibility watchers failed: ${e}`);
        }
        mirror.connect('destroy', () => {
            for (const [obj, id] of watchers) {
                try {
                    obj.disconnect(id);
                }
                catch { }
            }
            watchers.length = 0;
        });
        syncVisible();
        mirror.set_position(child.x, child.y);
        mirror.set_size(child.width, child.height);
        for (const coordinate of [
            Clutter.BindCoordinate.X,
            Clutter.BindCoordinate.Y,
            Clutter.BindCoordinate.WIDTH,
            Clutter.BindCoordinate.HEIGHT,
        ]) {
            mirror.add_constraint(new Clutter.BindConstraint({ source: child, coordinate }));
        }
        this._mirrors.set(child, mirror);
        this.add_child(mirror);
        this._restack();
    }
    _removeMirror(child) {
        const mirror = this._mirrors.get(child);
        if (!mirror)
            return;
        this._mirrors.delete(child);
        if (isActorValid(mirror))
            mirror.destroy();
    }
    _restack() {
        if (!isActorValid(this._sourceGroup))
            return;
        const wanted = [];
        for (const child of this._sourceGroup.get_children()) {
            const mirror = this._mirrors.get(child);
            if (mirror && isActorValid(mirror))
                wanted.push(mirror);
        }
        const current = this.get_children();
        let ordered = current.length === wanted.length;
        if (ordered) {
            for (let i = 0; i < wanted.length; i++) {
                if (current[i] !== wanted[i]) {
                    ordered = false;
                    break;
                }
            }
        }
        if (ordered)
            return;
        for (let i = 0; i < wanted.length; i++)
            this.set_child_at_index(wanted[i], i);
        utilsLog(`[bg-mirror] restacked ${wanted.length} wallpaper mirror(s)`);
    }
    _onDestroy() {
        if (isActorValid(this._sourceGroup)) {
            for (const id of this._groupHandlers) {
                try {
                    this._sourceGroup.disconnect(id);
                }
                catch { }
            }
        }
        this._groupHandlers = [];
        this._mirrors.clear();
        this._sourceGroup = null;
    }
    vfunc_pick(_pickContext) {
    }
});
let _backgroundMirrorEnabled = true;
export function setBackgroundMirrorEnabled(enabled) {
    _backgroundMirrorEnabled = !!enabled;
}
export function isBackgroundMirrorEnabled() {
    return _backgroundMirrorEnabled;
}
let _sharedBackgroundSource = null;
function ensureSharedBackgroundSource() {
    if (isActorValid(_sharedBackgroundSource))
        return _sharedBackgroundSource;
    _sharedBackgroundSource = null;
    const uiGroup = Main.layoutManager?.uiGroup ?? null;
    const group = Main.layoutManager?._backgroundGroup ?? null;
    if (!uiGroup || !group)
        return null;
    const source = new BackgroundMirror();
    source.set_name('lg-bg-mirror-source');
    source.set_position(0, 0);
    source.set_size(group.width, group.height);
    for (const coordinate of [Clutter.BindCoordinate.WIDTH, Clutter.BindCoordinate.HEIGHT]) {
        try {
            source.add_constraint(new Clutter.BindConstraint({ source: group, coordinate }));
        }
        catch (e) {
            utilsLog(`[bg-mirror] source size constraint failed: ${e}`);
        }
    }
    source.opacity = 0;
    source.reactive = false;
    Shell.util_set_hidden_from_pick(source, true);
    uiGroup.add_child(source);
    source.connect('destroy', () => {
        if (_sharedBackgroundSource === source)
            _sharedBackgroundSource = null;
    });
    _sharedBackgroundSource = source;
    return source;
}
export function getSharedBackgroundSource() {
    return isActorValid(_sharedBackgroundSource) ? _sharedBackgroundSource : null;
}
export function destroySharedBackgroundSource() {
    const source = _sharedBackgroundSource;
    _sharedBackgroundSource = null;
    if (isActorValid(source)) {
        try {
            source.destroy();
        }
        catch { }
    }
}
export function createBackgroundMirror(name) {
    let source = null;
    if (_backgroundMirrorEnabled) {
        try {
            source = ensureSharedBackgroundSource();
        }
        catch (e) {
            utilsLog(`[bg-mirror] shared source unavailable, falling back: ${e}`);
            source = null;
        }
    }
    if (!source)
        source = Main.layoutManager._backgroundGroup;
    const clone = new UnpickableClone({ source });
    clone.set_name(name);
    return clone;
}
