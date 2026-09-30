import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import GLib from 'gi://GLib';
import { UnpickableClone } from './actors/unpickable.js';
import { getWindowActors } from './actors/windows.js';
import { isActorValid } from './actors/lifecycle.js';
import { InvertedPositionConstraint } from './actors/invertedPosition.js';
import { getAllocatedSize, rectsIntersect } from './actors/geometry.js';
import { setActorVisible, ensureGlassAllocated, ensureWindowActorAllocated } from './actors/allocation.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './animation/frameSync.js';
import { hexToColorArray } from './animation/colors.js';
import { getNestedGlassFix, innerGlassEffectOf, isFocusDebugEnabled } from './capture/nestedGlass.js';
import { setTranslationIfChanged, setSizeIfChanged, setScaleIfChanged, setOpacityIfChanged, setCloneCulled } from './actors/writes.js';
import { isCullSiteEnabled } from './capture/options.js';
import { createBackgroundMirror } from './capture/background.js';
import { reportClonedWindowActors, releaseClonedWindowActors } from './capture/windowCulling.js';
import { syncDamageHooks, releaseDamageHooks } from './capture/damageHooks.js';
import { noteStrandEntry } from './diagnostics/glass.js';
import { reportFrameLoopError } from './diagnostics/logging.js';
// How far the glass extends past the window on each side. It is both the
// sampling headroom for refraction and blur and the only room the drop shadow
// has to render into, so it grows with the shadow settings instead of
// enlarging every window's framebuffers permanently.
const GLASS_MIN_MARGIN = 10;
// Room between the shadow's largest radius and the actor edge, so the penumbra
// fades out before it is clipped. dockManager leaves the same 20px.
const SHADOW_MARGIN_HEADROOM = 20;
// prefs.js caps shadow-radius at 100.
const GLASS_MAX_MARGIN = 100 + SHADOW_MARGIN_HEADROOM;
// Consecutive stranded frames before each stage of the window actor rescue:
// first a relayout of the nearest allocated ancestor, then a remap of mutter's
// window actor itself. See ensureWindowActorAllocated().
const WINDOW_ACTOR_RELAYOUT_FRAMES = 4;
const WINDOW_ACTOR_STRANDED_FRAMES = 14;
// How far the clone containers' screen origin may drift from (0,0) before the
// glass is hidden for the frame. Drift during normal animations is a few
// pixels. A subtree that stopped being allocated while the counter-scale keeps
// growing (a window minimising to scale 0.03) ends up tens of thousands of
// pixels away, and its damage rectangles make mutter's pixman calls fail.
const MAX_ANCHOR_DISPLACEMENT = 256;
// The anchor check above only sees the previous relayout, so the first runaway
// frame would already be painted. A counter-scale above this on a container
// that has no allocation is refused before it is written. A large
// counter-scale on a healthy subtree is an ordinary minimise and is kept.
const MAX_STRANDED_COUNTER_SCALE = 4;
// GTK's Wayland backend maps a menu xdg_popup onto DROPDOWN_MENU; the other
// two cover X11 and toolkits that pick a different hint.
const MENU_WINDOW_TYPES = [
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.MENU,
];
// Bound on the transient_for walk, so a cycle cannot hang the first-frame
// handler. A desktop menu is one hop from the desktop, submenus a few more.
const MAX_TRANSIENT_DEPTH = 8;
export class ApplicationManager {
    // Slack around the glass box when culling behind-window clones. Keeping a
    // clone too many costs little; one too few pops a window in and out.
    static CLONE_CULL_MARGIN = 48;
    static DEBUG_FOCUS_LOG_FRAME_COUNT = 8;
    _extensionPath;
    _settings;
    _logger;
    _states = new Map();
    _settingsSignals = [];
    _displaySignals = [];
    // Handlers on windows created but not yet painted. See _onWindowCreated().
    _newWindows = new Map();
    _frameSignalId = 0;
    _lastTickUs = 0;
    _rebuildIdleId = 0;
    _rebuildFollowupLaterId = 0;
    _glassMargin = GLASS_MIN_MARGIN;
    // Diagnostics. While _debugFocusLogFrames > 0 every frame logs the window
    // geometry (see _armFocusDebug()). The sets hold the windows or clones in
    // an anomalous state, so each anomaly is logged once on entry and exit.
    _debugFocusLogFrames = 0;
    _displacedContainers = new Set();
    _strandedScaleWindows = new Set();
    _anomalousClones = new Set();
    constructor(extensionPath, settings, logger) {
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
    }
    setup() {
        this._glassMargin = this._computeGlassMargin();
        this._bindSettings();
        const display = global.display;
        this._displaySignals.push(display.connect('window-created', (_d, metaWindow) => this._onWindowCreated(metaWindow)), display.connect('restacked', () => {
            this._rebuildAllClones();
            this._armFocusDebug('restacked');
        }), 
        // Dragging a window and releasing it can misplace clones without any
        // restack, so grabs arm the diagnostic too.
        display.connect('grab-op-begin', () => this._armFocusDebug('grab-op-begin')), display.connect('grab-op-end', () => this._armFocusDebug('grab-op-end')));
        if (this._isEffectEnabled())
            this._applyEffects();
    }
    cleanup() {
        for (const id of this._displaySignals)
            global.display.disconnect(id);
        this._displaySignals = [];
        for (const actor of [...this._newWindows.keys()])
            this._forgetNewWindow(actor);
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._removeAllEffects();
        this._displacedContainers.clear();
        this._strandedScaleWindows.clear();
        this._anomalousClones.clear();
    }
    // A window can only be dressed once it has painted. The handlers are
    // dropped after the first frame, when the window goes away first, or on
    // cleanup.
    _onWindowCreated(metaWindow) {
        const actor = metaWindow.get_compositor_private();
        if (!actor)
            return;
        this._newWindows.set(actor, [
            actor.connect('first-frame', () => {
                this._forgetNewWindow(actor);
                if (this._shouldApplyToWindow(actor)) {
                    this._setupWindow(actor);
                    this._rebuildAllClones();
                }
            }),
            actor.connect('destroy', () => this._forgetNewWindow(actor)),
        ]);
    }
    _forgetNewWindow(actor) {
        const ids = this._newWindows.get(actor);
        if (!ids)
            return;
        this._newWindows.delete(actor);
        for (const id of ids)
            actor.disconnect(id);
    }
    _bindSettings() {
        const connectSetting = (key, callback) => {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, callback));
        };
        for (const profile of ['application', 'desktop-menu']) {
            // _syncWhitelist() drops the windows that no longer qualify, builds the
            // ones that now do, and removes everything when both switches are off.
            connectSetting(this._profileEnableKey(profile), () => {
                this._syncWhitelist();
                if (this._isEffectEnabled())
                    this._startFrameSync();
            });
            for (const suffix of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius',
                'brightness', 'contrast', 'saturation'])
                connectSetting(this._profileKey(profile, suffix), () => this._updateEffectParams());
            connectSetting(this._profileKey(profile, 'content-opacity'), () => this._updateWindowOpacities());
        }
        connectSetting('application-glass-all-windows', () => this._syncWhitelist());
        connectSetting('application-window-whitelist', () => this._syncWhitelist());
        connectSetting('application-window-blacklist', () => this._syncWhitelist());
        // The shadow renders into the margin, so these resize the glass.
        connectSetting('shadow-radius', () => this._updateGlassMargin());
        connectSetting('shadow-intensity', () => this._updateGlassMargin());
    }
    _getContentOpacity(profile = 'application') {
        return this._settings.get_double(this._profileKey(profile, 'content-opacity'));
    }
    _updateWindowOpacities() {
        for (const state of this._states.values()) {
            if (isActorValid(state.surfaceActor))
                state.surfaceActor.opacity = Math.round(this._getContentOpacity(state.profile) * 255);
        }
    }
    /** Appearance key in a profile's namespace, e.g. `desktop-menu-tint-color`. */
    _profileKey(profile, suffix) {
        return `${profile}-${suffix}`;
    }
    /** The switch that turns one profile on, e.g. `enable-desktop-menu-glass`. */
    _profileEnableKey(profile) {
        return `enable-${profile}-glass`;
    }
    _isProfileEnabled(profile) {
        return this._settings.get_boolean(this._profileEnableKey(profile));
    }
    // Whether any profile wants glass. The per-window decision is made in
    // _profileForWindow().
    _isEffectEnabled() {
        return this._isProfileEnabled('application') || this._isProfileEnabled('desktop-menu');
    }
    // WM_CLASS casing differs between toolkits, and the preferences promise a
    // case-insensitive match.
    _listContainsClass(list, wmClass) {
        if (!wmClass)
            return false;
        const normalized = wmClass.toLowerCase();
        return list.some(entry => entry.toLowerCase() === normalized);
    }
    _windowMatchesWhitelist(metaWindow) {
        const whitelist = this._settings.get_strv('application-window-whitelist');
        return this._listContainsClass(whitelist, metaWindow.get_wm_class());
    }
    _windowMatchesBlacklist(metaWindow) {
        const blacklist = this._settings.get_strv('application-window-blacklist');
        return this._listContainsClass(blacklist, metaWindow.get_wm_class());
    }
    /**
     * Whether this is the menu the desktop itself puts up (right-click on the
     * wallpaper). On GNOME 50 / Wayland with Desktop Icons NG it is a
     * DROPDOWN_MENU window with no WM_CLASS or application id, transient for
     * the DESKTOP window, so the menu type plus that transient chain is the
     * only reliable signature. An in-app popup such as Chrome's has neither.
     * Override-redirect windows are managed by their clients and left alone.
     */
    _isDesktopMenuWindow(metaWindow) {
        if (metaWindow.is_override_redirect())
            return false;
        if (!MENU_WINDOW_TYPES.includes(metaWindow.get_window_type()))
            return false;
        let parent = metaWindow.get_transient_for();
        for (let depth = 0; parent && depth < MAX_TRANSIENT_DEPTH; depth++) {
            if (parent.get_window_type() === Meta.WindowType.DESKTOP)
                return true;
            // A submenu is transient for its parent menu. Walk through menus only,
            // never up through an ordinary app window.
            if (!MENU_WINDOW_TYPES.includes(parent.get_window_type()))
                return false;
            parent = parent.get_transient_for();
        }
        return false;
    }
    /**
     * The profile that should dress this window, or null to leave it alone.
     * _shouldApplyToWindow() and _setupWindow() both use it so they agree.
     */
    _profileForWindow(windowActor) {
        const metaWindow = windowActor.get_meta_window();
        if (!metaWindow)
            return null;
        // Checked first so a desktop menu can never fall through to "apply to
        // all windows" and pick up the application settings.
        if (this._isDesktopMenuWindow(metaWindow))
            return this._isProfileEnabled('desktop-menu') ? 'desktop-menu' : null;
        if (!this._isProfileEnabled('application'))
            return null;
        // "Apply to all windows" skips the whitelist but still only covers normal
        // and dialog windows, and still honours the blacklist.
        if (this._settings.get_boolean('application-glass-all-windows')) {
            const windowType = metaWindow.get_window_type();
            const isNormal = windowType === Meta.WindowType.NORMAL ||
                windowType === Meta.WindowType.DIALOG ||
                windowType === Meta.WindowType.MODAL_DIALOG;
            if (!isNormal || this._windowMatchesBlacklist(metaWindow))
                return null;
            return 'application';
        }
        return this._windowMatchesWhitelist(metaWindow) ? 'application' : null;
    }
    _shouldApplyToWindow(windowActor) {
        return this._profileForWindow(windowActor) !== null;
    }
    _applyEffects() {
        this._buildForExistingWindows();
        this._startFrameSync();
    }
    _removeAllEffects() {
        this._stopFrameSync();
        if (this._rebuildIdleId) {
            GLib.Source.remove(this._rebuildIdleId);
            this._rebuildIdleId = 0;
        }
        if (this._rebuildFollowupLaterId) {
            global.compositor.get_laters().remove(this._rebuildFollowupLaterId);
            this._rebuildFollowupLaterId = 0;
        }
        for (const state of this._states.values())
            this._cleanupState(state);
        this._states.clear();
    }
    _syncWhitelist() {
        if (!this._isEffectEnabled()) {
            this._removeAllEffects();
            return;
        }
        // A window that now belongs to the other profile is rebuilt too, since
        // the profile is fixed in its state.
        for (const [actor, state] of [...this._states.entries()]) {
            if (this._profileForWindow(actor) !== state.profile) {
                this._cleanupState(state);
                this._states.delete(actor);
            }
        }
        for (const actor of getWindowActors()) {
            if (this._shouldApplyToWindow(actor) && !this._states.has(actor))
                this._setupWindow(actor);
        }
        this._rebuildAllClones();
    }
    // The margin the shadow settings need. Without a shadow the glass keeps the
    // minimum, so its framebuffers are not enlarged for nothing.
    _computeGlassMargin() {
        const radius = this._settings.get_double('shadow-radius');
        const intensity = this._settings.get_double('shadow-intensity');
        if (!(radius > 0) || !(intensity > 0))
            return GLASS_MIN_MARGIN;
        return Math.min(GLASS_MAX_MARGIN, Math.max(GLASS_MIN_MARGIN, Math.ceil(radius) + SHADOW_MARGIN_HEADROOM));
    }
    // Pushes a changed margin into every glass. The geometry signature is
    // dropped because none of its inputs change with the margin.
    _updateGlassMargin() {
        const next = this._computeGlassMargin();
        if (next === this._glassMargin)
            return;
        this._glassMargin = next;
        const shadowRoom = Math.max(0, next - SHADOW_MARGIN_HEADROOM);
        for (const state of this._states.values()) {
            state.effect.setPadding(next);
            state.effect.setShadowMaxRadius(shadowRoom);
            state.geomSig = undefined;
        }
    }
    _updateEffectParams() {
        for (const state of this._states.values()) {
            this._applyAppearance(state.effect, state.profile);
            state.radiusScaleApplied = 1;
        }
    }
    _applyAppearance(effect, profile) {
        const k = (suffix) => this._profileKey(profile, suffix);
        effect.setTintColor(...hexToColorArray(this._settings.get_string(k('tint-color'))));
        effect.setTintStrength(this._settings.get_double(k('tint-strength')));
        effect.setCornerRadius(this._settings.get_double(k('corner-radius')));
        effect.setBlurRadius(this._settings.get_int(k('blur-radius')));
        effect.setBrightness(this._settings.get_double(k('brightness')));
        effect.setContrast(this._settings.get_double(k('contrast')));
        effect.setSaturation(this._settings.get_double(k('saturation')));
    }
    // The sync runs from the stage's 'before-update', i.e. only on frames the
    // compositor paints anyway, and never requests frames of its own.
    _startFrameSync() {
        if (this._frameSignalId !== 0)
            return;
        this._frameSignalId = global.stage.connect('before-update', () => this._frameTick());
        this._frameTick();
    }
    _stopFrameSync() {
        if (!this._frameSignalId)
            return;
        global.stage.disconnect(this._frameSignalId);
        this._frameSignalId = 0;
    }
    // Debounced to an idle so a burst of restacks rebuilds once. Mutter can
    // still be settling the stacking order then, so the rebuild runs once more
    // before the next frame.
    _rebuildAllClones() {
        if (this._rebuildIdleId)
            return;
        this._rebuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildIdleId = 0;
            if (this._states.size === 0)
                return GLib.SOURCE_REMOVE;
            for (const state of this._states.values())
                this._rebuildWindowClones(state);
            if (!this._rebuildFollowupLaterId) {
                this._rebuildFollowupLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this._rebuildFollowupLaterId = 0;
                    for (const state of this._states.values())
                        this._rebuildWindowClones(state);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    _buildForExistingWindows() {
        for (const actor of getWindowActors()) {
            if (this._shouldApplyToWindow(actor))
                this._setupWindow(actor);
        }
    }
    _setupWindow(windowActor) {
        if (this._states.has(windowActor))
            return;
        const profile = this._profileForWindow(windowActor);
        if (!profile)
            return;
        const surfaceActor = windowActor.get_first_child();
        if (!surfaceActor || !windowActor.get_parent())
            return;
        // No inhibit_culling() on the window actor or on the glass: the glass is
        // part of what other windows clone, and it made those clones disappear.
        const originalOpacity = surfaceActor.opacity;
        surfaceActor.opacity = Math.round(this._getContentOpacity(profile) * 255);
        // Every actor is named so Clutter's allocation warnings identify it. Not
        // 'liquid-glass-bg-actor' or 'liquid-box': UILayerSampler skips those as
        // other glass instances.
        const bgActor = new St.Widget({
            name: 'lgw-bg',
            style_class: 'liquid-glass-bg-actor',
            reactive: false,
            clip_to_allocation: false,
        });
        windowActor.insert_child_below(bgActor, surfaceActor);
        const clipBox = new St.Widget({
            name: 'lgw-clipbox',
            clip_to_allocation: true,
            reactive: false,
        });
        bgActor.add_child(clipBox);
        // Monitor-sized so the wallpaper fills the glass.
        const bgClone = createBackgroundMirror('lgw-bg-wallpaper-clone');
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor)
            bgClone.set_size(monitor.width, monitor.height);
        clipBox.add_child(bgClone);
        const effect = new LiquidEffect({
            extensionPath: this._extensionPath,
            settings: this._settings,
            logger: this._logger,
            owner: profile,
        });
        effect.setPadding(this._glassMargin);
        this._applyAppearance(effect, profile);
        effect.setIsDock(false);
        // No rim, specular or sheen: around a window with translucent content
        // they read as a bright frame. Only this window's effect is affected.
        effect.setSurfaceLightEnabled(false);
        effect.setShadowMaxRadius(Math.max(0, this._glassMargin - SHADOW_MARGIN_HEADROOM));
        bgActor.add_effect(effect);
        const windowsContainer = new Clutter.Actor();
        windowsContainer.set_name('lgw-bg-windows');
        clipBox.add_child(windowsContainer);
        const createConstraint = () => new InvertedPositionConstraint({
            source: windowActor,
            offset_x: -this._glassMargin,
            offset_y: -this._glassMargin,
        });
        const constraints = { bg: createConstraint(), windows: createConstraint() };
        bgClone.add_constraint(constraints.bg);
        windowsContainer.add_constraint(constraints.windows);
        const state = {
            profile,
            windowActor,
            surfaceActor,
            originalOpacity,
            bgActor,
            clipBox,
            bgClone,
            windowsContainer,
            clones: new Map(),
            effect,
            signals: [],
            constraints,
        };
        this._states.set(windowActor, state);
        this._rebuildWindowClones(state);
        state.signals.push({
            obj: windowActor,
            id: windowActor.connect('notify::mapped', () => {
                if (windowActor.mapped)
                    this._forceGlassReallocation(state);
            }),
        });
        const metaWin = windowActor.get_meta_window();
        if (metaWin) {
            state.signals.push({
                obj: metaWin,
                id: metaWin.connect('size-changed', () => {
                    // Maximize and tiling change the invisible border.
                    state.frameLocal = undefined;
                    this._rebuildWindowClones(state);
                }),
            });
        }
        // Our actors are children of the window actor and are already disposed
        // when this runs; _cleanupState() checks for that.
        state.signals.push({
            obj: windowActor,
            id: windowActor.connect('destroy', () => {
                this._cleanupState(state);
                this._states.delete(windowActor);
                this._rebuildAllClones();
            }),
        });
    }
    _rebuildWindowClones(state) {
        for (const clone of state.clones.values())
            clone.destroy();
        state.clones.clear();
        if (this._debugFocusLogFrames > 0) {
            const titles = getWindowActors().map(a => a.get_meta_window()?.get_title() || '(untitled)');
            const ownTitle = state.windowActor.get_meta_window()?.get_title() || '(untitled)';
            this._logger.log(`[Liquid Glass][focus-debug] _rebuildWindowClones for="${ownTitle}" ` +
                `stackingOrder=[${titles.join(', ')}]`);
        }
        // Bottom to top, so everything before our own window is behind it.
        for (const actor of getWindowActors()) {
            if (actor === state.windowActor)
                break;
            // A source without a size can never be allocated. The allocated size is
            // used because get_size() reports the preferred size while a relayout
            // is pending, which reads 0 for healthy windows.
            const [srcW, srcH] = getAllocatedSize(actor);
            if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0)
                continue;
            const clone = new UnpickableClone({ source: actor });
            clone.set_name(`lgw-behind:${actor.get_meta_window()?.get_title() || '(untitled)'}`);
            // Placed now, in the form _syncClones() keeps (x/y at 0, position in the
            // translation), so the first frame does not paint it at (0,0).
            clone.set_position(0, 0);
            clone.translation_x = actor.x;
            clone.translation_y = actor.y;
            clone.set_size(srcW, srcH);
            clone.set_scale(actor.scale_x, actor.scale_y);
            clone.opacity = actor.opacity;
            state.windowsContainer.add_child(clone);
            state.clones.set(actor, clone);
        }
    }
    // The frame rect's origin inside the buffer rect, i.e. the invisible CSD
    // border. It only changes with the decorations, but during a drag the frame
    // rect trails the buffer rect by a frame, so the difference jumps by the
    // mouse movement. It is sampled only while the actor stands still;
    // 'size-changed' clears it.
    _frameLocalOffset(state, actor, rect, bufferRect) {
        const px = actor.x;
        const py = actor.y;
        const prev = state.frameLocalActorPos;
        const stationary = !!prev && prev[0] === px && prev[1] === py;
        state.frameLocalActorPos = [px, py];
        if (!state.frameLocal || stationary) {
            const fx = rect.x - bufferRect.x;
            const fy = rect.y - bufferRect.y;
            if (Number.isFinite(fx) && Number.isFinite(fy))
                state.frameLocal = [fx, fy];
        }
        return state.frameLocal ?? [0, 0];
    }
    // Places a child of the window actor on a screen rect at 1:1 scale while
    // GNOME animates the window actor's scale. The glass edge follows the
    // window, but the content sampled through it is real screen pixels and must
    // not stretch. A child at local point c renders at A + s * c, where A is the
    // window actor's transformed origin, so scale = 1 / s, position = d / s and
    // size = the on-screen size. `dx`/`dy` are the screen offset from A.
    _applyCounterScale(child, windowActor, dx, dy, w, h) {
        const [sx, sy] = this._animationScale(windowActor);
        child.set_pivot_point(0, 0);
        child.remove_clip();
        child.set_size(w, h);
        if (sx === 1 && sy === 1) {
            child.set_scale(1, 1);
            child.set_position(dx, dy);
            return;
        }
        child.set_scale(1 / sx, 1 / sy);
        child.set_position(dx / sx, dy / sy);
    }
    // The window actor's animation scale, with degenerate values read as 1.
    _animationScale(windowActor) {
        let [sx, sy] = windowActor.get_scale();
        if (!Number.isFinite(sx) || sx <= 0)
            sx = 1;
        if (!Number.isFinite(sy) || sy <= 0)
            sy = 1;
        return [sx, sy];
    }
    // The corner radius is in screen pixels and the glass box shrinks with the
    // window during an animation, so the radius scales with it. Re-applied only
    // when the scale changes.
    _syncAnimatedCornerRadius(state, scale) {
        const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
        if (state.radiusScaleApplied === s)
            return;
        state.radiusScaleApplied = s;
        const cornerRadius = this._settings.get_double(this._profileKey(state.profile, 'corner-radius'));
        state.effect.setCornerRadius(cornerRadius * s);
    }
    // Hides the glass for a frame. The geometry signature is dropped so the next
    // frame runs the full sync and shows it again.
    _hideGlass(state) {
        setActorVisible(state.bgActor, false);
        state.geomSig = undefined;
    }
    _syncState(state) {
        const actor = state.windowActor;
        if (!actor.get_stage() || !actor.mapped) {
            this._hideGlass(state);
            return;
        }
        const metaWin = actor.get_meta_window();
        if (!metaWin)
            return;
        // Folds the repaints of the setters below into one.
        state.effect.beginBatch();
        try {
            this._syncStateInner(state, actor, metaWin);
        }
        finally {
            state.effect.endBatch();
        }
    }
    _syncStateInner(state, actor, metaWin) {
        const winWorkspace = metaWin.get_workspace();
        if (winWorkspace && winWorkspace !== global.workspace_manager.get_active_workspace()) {
            this._hideGlass(state);
            return;
        }
        const rect = metaWin.get_frame_rect();
        const bufferRect = metaWin.get_buffer_rect();
        if (rect.width <= 0 || rect.height <= 0) {
            this._hideGlass(state);
            return;
        }
        setActorVisible(state.bgActor, true);
        const [frameLocalX, frameLocalY] = this._frameLocalOffset(state, actor, rect, bufferRect);
        // GNOME animates a resize by easing the window actor's scale while the
        // frame rect is already final (windowManager.js _sizeChangedWindow), so
        // the live size is the frame rect times the scale. The margin is added in
        // screen pixels, since the glass paints at 1:1.
        const margin = this._glassMargin;
        const [sx, sy] = this._animationScale(actor);
        const bgW = rect.width * sx + margin * 2;
        const bgH = rect.height * sy + margin * 2;
        const localX = frameLocalX * sx - margin;
        const localY = frameLocalY * sy - margin;
        const [pivotX, pivotY] = actor.get_pivot_point();
        const [actorW, actorH] = getAllocatedSize(actor);
        // The anchor left by the previous relayout. A stranded subtree never gets
        // that relayout, which is how it shows up here.
        const anchorOffBy = this._checkContainerAnchor(state);
        if (this._counterScaleWouldStrand(state)) {
            this._setGlassStrandHidden(state, true);
            state.geomSig = undefined;
            return;
        }
        // Skip the geometry writes while none of their inputs changed. The clones
        // are still synced: the windows behind move on their own.
        const unchanged = this._updateGeometrySignature(state, [
            rect.x, rect.y, rect.width, rect.height,
            bufferRect.x, bufferRect.y, bufferRect.width, bufferRect.height,
            frameLocalX, frameLocalY,
            sx, sy,
            actor.translation_x, actor.translation_y,
            pivotX * (Number.isFinite(actorW) ? actorW : 0),
            pivotY * (Number.isFinite(actorH) ? actorH : 0),
        ]);
        if (unchanged && anchorOffBy <= MAX_ANCHOR_DISPLACEMENT) {
            this._syncClones(state);
            return;
        }
        this._applyCounterScale(state.bgActor, actor, localX, localY, bgW, bgH);
        // The glass box in screen coordinates, the space the clones are placed in.
        state.glassScreenRect = [
            actor.x + actor.translation_x + localX,
            actor.y + actor.translation_y + localY,
            bgW,
            bgH,
        ];
        state.clipBox.set_position(0, 0);
        state.clipBox.set_size(bgW, bgH);
        state.windowsContainer.set_size(bgW, bgH);
        // The shader gets the live size too, or its rounded corners and edge
        // refraction stay laid out for the final size during an animation.
        state.effect.setResolution(bgW, bgH);
        state.effect.setGlassGeometry(0, 0, bgW, bgH);
        this._syncAnimatedCornerRadius(state, sx);
        this._syncCaptureOffset(state, actor, [pivotX, pivotY], [actorW, actorH], [sx, sy], [localX, localY]);
        this._syncClones(state);
        // Last, so it overrides the show above. A container this far from screen
        // (0,0) can only draw the wrong part of the screen; the glass stays hidden
        // until ensureGlassAllocated() repairs the subtree.
        if (anchorOffBy > MAX_ANCHOR_DISPLACEMENT) {
            this._setGlassStrandHidden(state, true);
            state.geomSig = undefined;
        }
        else {
            this._setGlassStrandHidden(state, false);
        }
    }
    // Stores `values` as the geometry signature and returns whether it was
    // unchanged. A new signature starts as NaN, which never compares equal.
    _updateGeometrySignature(state, values) {
        let sig = state.geomSig;
        if (!sig || sig.length !== values.length) {
            sig = new Float64Array(values.length).fill(NaN);
            state.geomSig = sig;
        }
        let unchanged = true;
        for (let i = 0; i < sig.length; i++) {
            if (sig[i] !== values[i]) {
                unchanged = false;
                sig[i] = values[i];
            }
        }
        return unchanged;
    }
    // Offsets the clone containers so their origin lands on screen (0,0), which
    // lets the clones inside use raw screen coordinates:
    //   container origin = A + localX - windowActor.x + offset = 0
    // where A is the window actor's transformed origin. A is not read with
    // get_transformed_position(): this runs before the stage relayout, when that
    // still returns last frame's allocation while actor.x is already this
    // frame's, and clones lagged a frame behind a drag. It is rebuilt from plain
    // properties instead: A = x + translation + P * (1 - scale), where P is the
    // pivot point in pixels.
    _syncCaptureOffset(state, actor, [pivotX, pivotY], [actorW, actorH], [sx, sy], [localX, localY]) {
        const pivotPxX = (Number.isFinite(pivotX) ? pivotX : 0) * (Number.isFinite(actorW) ? actorW : 0);
        const pivotPxY = (Number.isFinite(pivotY) ? pivotY : 0) * (Number.isFinite(actorH) ? actorH : 0);
        const anchorDX = actor.translation_x + pivotPxX * (1 - sx);
        const anchorDY = actor.translation_y + pivotPxY * (1 - sy);
        const offsetX = -anchorDX - localX;
        const offsetY = -anchorDY - localY;
        // setOffset() queues the relayout; a plain offset_x write does not, and
        // during an open or close animation nothing else would.
        state.constraints.bg.setOffset(offsetX, offsetY);
        state.constraints.windows.setOffset(offsetX, offsetY);
    }
    /**
     * Keeps a glass whose capture contains another glass from latching black.
     * When a cloned window's own glass re-renders its offscreen during our
     * capture, the capture comes out empty and nothing marks it dirty again.
     * The repair is selectable; see NestedGlassFix in capture/nestedGlass.ts.
     */
    _repairNestedGlass(state) {
        const mode = getNestedGlassFix();
        if (mode !== 'damage')
            this._releaseDamageHooks(state);
        if (mode === 'off')
            return;
        const bg = state.bgActor;
        if (!bg.mapped || !bg.visible)
            return;
        // Redraw from the source's damaged signal. It fires before the paint, so
        // the repair lands on the same frame.
        if (mode === 'damage') {
            this._syncDamageHooks(state);
            return;
        }
        // Never reuse the capture: always correct, but repaints every frame.
        if (mode === 'recapture') {
            bg.queue_redraw();
            return;
        }
        if (this._nestedClonesChanged(state))
            bg.queue_redraw();
    }
    // Whether an inner glass we clone has re-rendered since the last frame. Its
    // serial is only readable a frame after the re-render, so this repair
    // leaves a one-frame flicker.
    _nestedClonesChanged(state) {
        let seen = state.nestedSerials;
        if (!seen) {
            seen = new Map();
            state.nestedSerials = seen;
        }
        let stale = false;
        for (const [src, clone] of state.clones.entries()) {
            if (!clone.visible)
                continue;
            const inner = innerGlassEffectOf(src);
            if (!inner)
                continue;
            const serial = inner._recaptureSerial;
            if (seen.get(src) !== serial) {
                seen.set(src, serial);
                stale = true;
            }
        }
        for (const src of seen.keys())
            if (!state.clones.has(src))
                seen.delete(src);
        return stale;
    }
    // One damaged handler per behind-cloned window that owns a glass. It costs
    // one extra repaint per content change of such a window and nothing while
    // the desktop is still. Windows without a glass add no nested offscreen and
    // are not hooked.
    _syncDamageHooks(state) {
        let hooks = state.damageHooks;
        if (!hooks) {
            hooks = new Map();
            state.damageHooks = hooks;
        }
        syncDamageHooks(hooks, state.clones, () => {
            const bg = state.bgActor;
            if (isActorValid(bg) && bg.mapped && bg.visible)
                bg.queue_redraw();
        });
    }
    _releaseDamageHooks(state) {
        if (!state.damageHooks)
            return;
        releaseDamageHooks(state.damageHooks);
        state.damageHooks = undefined;
    }
    /**
     * Places every behind-window clone at its source's geometry. Runs even when
     * this window's own geometry is unchanged.
     */
    _syncClones(state) {
        // Clones outside the glass box are hidden, not just clipped: painting a
        // clone paints its source, including that window's own glass. Skipped
        // during an animation, when the screen rect is only approximate.
        const [animSx, animSy] = this._animationScale(state.windowActor);
        const cullRect = (isCullSiteEnabled('app') && animSx === 1 && animSy === 1)
            ? state.glassScreenRect
            : undefined;
        for (const [src, clone] of state.clones.entries()) {
            if (!isActorValid(src) || !src.visible || !src.mapped) {
                setActorVisible(clone, false);
                this._anomalousClones.delete(clone);
                continue;
            }
            if (this._shouldCullClone(src, cullRect)) {
                setCloneCulled(clone, true, () => this._cullWhy(src, cullRect));
                this._anomalousClones.delete(clone);
                continue;
            }
            setCloneCulled(clone, false, 'app');
            setActorVisible(clone, true);
            // x/y stay at 0 and the translation carries the position. The IfChanged
            // writers skip equal values: Clutter's setters queue a redraw even then,
            // which repainted every glass on every frame.
            if (clone.x !== 0 || clone.y !== 0)
                clone.set_position(0, 0);
            setTranslationIfChanged(clone, src.x, src.y);
            setSizeIfChanged(clone, src.width, src.height);
            setScaleIfChanged(clone, src.scale_x, src.scale_y);
            setOpacityIfChanged(clone, src.opacity);
            this._checkCloneAnomaly(clone, src);
        }
        // Keeps mutter from clipping the cloned windows to their damage region.
        // See CullOptOutEffect in capture/windowCulling.ts.
        reportClonedWindowActors(state, state.clones.keys());
        this._repairNestedGlass(state);
    }
    // Logs, on entry and exit, a clone that should be showing but that Clutter
    // cannot paint. has_allocation() is not checked: it always reads false
    // right after this frame's writes.
    _checkCloneAnomaly(clone, src) {
        const mapped = clone.mapped;
        const [w, h] = clone.get_size();
        const degenerate = !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0;
        const anomalous = !mapped || degenerate;
        if (anomalous === this._anomalousClones.has(clone))
            return;
        const srcTitle = src.get_meta_window()?.get_title() || '(untitled)';
        if (anomalous) {
            this._anomalousClones.add(clone);
            this._logger.log(`[Liquid Glass][clone-anomaly] ENTER src="${srcTitle}" ` +
                `mapped=${mapped} size=(${w}x${h}) ` +
                `clone.(x,y)=(${clone.x},${clone.y}) clone.visible=${clone.visible} clone.opacity=${clone.opacity}`);
        }
        else {
            this._anomalousClones.delete(clone);
            this._logger.log(`[Liquid Glass][clone-anomaly] EXIT src="${srcTitle}"`);
        }
    }
    // Describes a cull transition for the log.
    _cullWhy(src, cullRect) {
        const [w, h] = getAllocatedSize(src);
        return `src=(${Math.round(src.x)},${Math.round(src.y)},${Math.round(w)}x${Math.round(h)}) ` +
            `glassRect=[${cullRect.map(Math.round)}] app`;
    }
    /**
     * Whether `src` lies entirely outside the glass box `cullRect`. The size is
     * the allocated one: src.width reports the preferred size while a relayout
     * is pending, which would cull visible windows. Anything uncertain is kept.
     */
    _shouldCullClone(src, cullRect) {
        if (!cullRect)
            return false;
        const [w, h] = getAllocatedSize(src);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
            return false;
        const x = src.x, y = src.y;
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return false;
        const m = ApplicationManager.CLONE_CULL_MARGIN;
        return !rectsIntersect(x - m, y - m, w + m * 2, h + m * 2, cullRect);
    }
    _frameTick() {
        // Diagnostic switch that freezes the sync so its cost can be measured.
        if (isFrameSyncFrozen())
            return;
        // Two stage views updating in the same frame each emit 'before-update'.
        const nowUs = GLib.get_monotonic_time();
        if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US)
            return;
        this._lastTickUs = nowUs;
        // One window's failure must not stop the others.
        for (const state of this._states.values()) {
            try {
                this._syncFrameState(state);
            }
            catch (e) {
                reportFrameLoopError('ApplicationManager', e);
            }
        }
        if (this._debugFocusLogFrames > 0)
            this._debugFocusLogFrames--;
    }
    _syncFrameState(state) {
        const metaWin = state.windowActor.get_meta_window();
        if (!metaWin)
            return;
        const title = metaWin.get_title() || '(untitled)';
        // Names this glass in diagnostic dumps.
        state.effect._diagOwnerLabel = title;
        // The window actor is rescued before our own actors. Its children are laid
        // out by its default layout, so a stranded window actor swallows every
        // relayout they queue and their own rescue could never land.
        const rescue = ensureWindowActorAllocated(state.windowActor, WINDOW_ACTOR_RELAYOUT_FRAMES, WINDOW_ACTOR_STRANDED_FRAMES);
        if (rescue)
            this._logStrand(state, metaWin, title, rescue);
        ensureGlassAllocated(state.bgActor);
        this._syncState(state);
        if (this._debugFocusLogFrames > 0)
            this._logFocusDebugInfo(state);
    }
    _logStrand(state, metaWin, title, rescue) {
        const wa = state.windowActor;
        const parent = wa.get_parent();
        noteStrandEntry(title, `wa.alloc=${wa.has_allocation()} wg.alloc=${parent ? parent.has_allocation() : '-'} ` +
            `scale=${wa.scale_x.toFixed(3)} op=${wa.opacity} min=${metaWin.minimized} stage=${rescue}`);
        this._logger.log(`[Liquid Glass][strand] ${rescue} for "${title}" — ` +
            `wa(mapped=${wa.mapped},vis=${wa.visible},alloc=${wa.has_allocation()},op=${wa.opacity},` +
            `scale=${wa.scale_x.toFixed(3)}) ` +
            `parent(${parent ? `${parent.constructor.name},mapped=${parent.mapped},alloc=${parent.has_allocation()}` : 'none'}) ` +
            `bg(mapped=${state.bgActor.mapped},vis=${state.bgActor.visible},alloc=${state.bgActor.has_allocation()}) ` +
            `min=${metaWin.minimized}`);
    }
    // Logs the window geometry for a few frames after a restack or grab. Off
    // unless switched on through global._lgGlass, and checked here so the log
    // strings are never built otherwise.
    _armFocusDebug(reason) {
        if (!isFocusDebugEnabled())
            return;
        this._debugFocusLogFrames = ApplicationManager.DEBUG_FOCUS_LOG_FRAME_COUNT;
        this._logger.log(`[Liquid Glass][focus-debug] ---- ${reason} event ----`);
    }
    /**
     * Re-allocates the glass once its window actor is mapped again, after a
     * restore from minimise. clutter_actor_allocate() skips unmapped actors, so
     * the subtree still has the allocation it had mid-way through the minimise
     * animation. Runs on the next BEFORE_REDRAW, once the map has settled.
     */
    _forceGlassReallocation(state) {
        if (state.remapReallocLaterId)
            return;
        state.remapReallocLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            state.remapReallocLaterId = 0;
            if (!state.windowActor.mapped)
                return GLib.SOURCE_REMOVE;
            let rescued = 0;
            for (const actor of [state.bgActor, state.windowsContainer]) {
                if (ensureGlassAllocated(actor, 1))
                    rescued++;
            }
            if (rescued > 0) {
                const title = state.windowActor.get_meta_window()?.get_title() || '(untitled)';
                this._logger.log(`[Liquid Glass][min-restore] re-allocated ${rescued} glass actor(s) for "${title}"`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    /**
     * Hides the glass with opacity rather than visibility. Both callers hide it
     * because the subtree is stranded, and a hidden actor can be neither
     * allocated nor rescued: ensureGlassAllocated() skips it. Zero opacity is
     * skipped at paint all the same but keeps the actor repairable.
     */
    _setGlassStrandHidden(state, hidden) {
        const wanted = hidden ? 0 : 255;
        if (state.bgActor.opacity !== wanted)
            state.bgActor.opacity = wanted;
    }
    // Whether this frame would counter-scale a subtree that missed the last
    // relayout. See MAX_STRANDED_COUNTER_SCALE.
    _counterScaleWouldStrand(state) {
        const container = state.windowsContainer;
        const [sx, sy] = this._animationScale(state.windowActor);
        const counterScale = Math.max(1 / sx, 1 / sy);
        const stranded = counterScale > MAX_STRANDED_COUNTER_SCALE && !container.has_allocation();
        const known = this._strandedScaleWindows.has(container);
        if (stranded && !known) {
            this._strandedScaleWindows.add(container);
            const title = state.windowActor.get_meta_window()?.get_title() || '(untitled)';
            this._logger.log(`[Liquid Glass][anchor] REFUSED window="${title}" ` +
                `counterScale=${counterScale.toFixed(1)}x scale=(${sx.toFixed(4)},${sy.toFixed(4)}) ` +
                'container.hasAlloc=false');
        }
        else if (!stranded && known) {
            this._strandedScaleWindows.delete(container);
            this._logger.log('[Liquid Glass][anchor] REFUSED cleared');
        }
        return stranded;
    }
    // How far the clone container's screen origin is from (0,0), the invariant
    // the clone placement relies on; Infinity if it is not finite.
    _checkContainerAnchor(state) {
        const container = state.windowsContainer;
        const [x, y] = container.get_transformed_position();
        const offBy = (!Number.isFinite(x) || !Number.isFinite(y))
            ? Infinity
            : Math.max(Math.abs(x), Math.abs(y));
        const displaced = offBy > 1;
        const known = this._displacedContainers.has(container);
        if (displaced && !known) {
            this._displacedContainers.add(container);
            const wa = state.windowActor;
            const title = wa.get_meta_window()?.get_title() || '(untitled)';
            const [sx, sy] = this._animationScale(wa);
            this._logger.log(`[Liquid Glass][anchor] DRIFT window="${title}" ` +
                `container.transformedPos=(${Math.round(x)},${Math.round(y)}) expected=(0,0) ` +
                `windowActor.(x,y)=(${wa.x},${wa.y}) ` +
                `translation=(${wa.translation_x},${wa.translation_y}) ` +
                `scale=(${sx.toFixed(4)},${sy.toFixed(4)}) ` +
                `constraint.offset=(${state.constraints.windows.offset_x},${state.constraints.windows.offset_y})`);
        }
        else if (!displaced && known) {
            this._displacedContainers.delete(container);
            this._logger.log('[Liquid Glass][anchor] RECOVERED');
        }
        return offBy;
    }
    _logFocusDebugInfo(state) {
        const actor = state.windowActor;
        const metaWin = actor.get_meta_window();
        if (!metaWin)
            return;
        const title = metaWin.get_title() || '(untitled)';
        const [tX, tY] = actor.get_transformed_position();
        const frameRect = metaWin.get_frame_rect();
        const bufferRect = metaWin.get_buffer_rect();
        const [asx, asy] = this._animationScale(actor);
        const [ancX, ancY] = state.windowsContainer.get_transformed_position();
        this._logger.log(`[Liquid Glass][focus-debug] window="${title}" ` +
            `windowActor.(x,y)=(${actor.x},${actor.y}) ` +
            `transformedPos=(${Math.round(tX)},${Math.round(tY)}) ` +
            `translation=(${actor.translation_x},${actor.translation_y}) ` +
            `scale=(${asx.toFixed(4)},${asy.toFixed(4)}) ` +
            `frameRect=(${frameRect.x},${frameRect.y},${frameRect.width}x${frameRect.height}) ` +
            `bufferRect=(${bufferRect.x},${bufferRect.y},${bufferRect.width}x${bufferRect.height}) ` +
            `actorX-bufferRect.x=${actor.x - bufferRect.x} actorY-bufferRect.y=${actor.y - bufferRect.y} ` +
            `containerAnchor=(${Math.round(ancX)},${Math.round(ancY)}) ` +
            `bgActor.hasAlloc=${state.bgActor.has_allocation()} ` +
            `container.hasAlloc=${state.windowsContainer.has_allocation()}`);
        for (const [src, clone] of state.clones.entries()) {
            if (!isActorValid(src))
                continue;
            const srcTitle = src.get_meta_window()?.get_title() || '(untitled)';
            const [srcTX, srcTY] = src.get_transformed_position();
            const [cloneScreenX, cloneScreenY] = clone.get_transformed_position();
            this._logger.log(`[Liquid Glass][focus-debug]   behind-clone src="${srcTitle}" ` +
                `src.(x,y)=(${src.x},${src.y}) src.transformedPos=(${Math.round(srcTX)},${Math.round(srcTY)}) ` +
                `diff=(${Math.round(srcTX - src.x)},${Math.round(srcTY - src.y)}) ` +
                `clone.translation=(${clone.translation_x},${clone.translation_y}) ` +
                `clone.size=(${clone.width}x${clone.height}) ` +
                `clone.screenPos=(${Math.round(cloneScreenX)},${Math.round(cloneScreenY)}) ` +
                `clone.hasAlloc=${clone.has_allocation()} clone.mapped=${clone.mapped}`);
        }
    }
    _cleanupState(state) {
        // Handlers on mutter's window actors, which outlive the state.
        this._releaseDamageHooks(state);
        releaseClonedWindowActors(state);
        if (state.remapReallocLaterId) {
            global.compositor.get_laters().remove(state.remapReallocLaterId);
            state.remapReallocLaterId = 0;
        }
        for (const { obj, id } of state.signals)
            obj.disconnect(id);
        state.signals = [];
        // Everything below is a child of the window actor, and already disposed
        // when this runs from the window actor's destroy handler.
        if (isActorValid(state.surfaceActor))
            state.surfaceActor.opacity = state.originalOpacity;
        if (isActorValid(state.bgClone))
            state.bgClone.remove_constraint(state.constraints.bg);
        if (isActorValid(state.windowsContainer))
            state.windowsContainer.remove_constraint(state.constraints.windows);
        state.constraints.bg.source = null;
        state.constraints.windows.source = null;
        for (const clone of state.clones.values()) {
            if (isActorValid(clone))
                clone.destroy();
        }
        state.clones.clear();
        state.effect.cleanup();
        if (isActorValid(state.bgActor))
            state.bgActor.destroy();
    }
}
