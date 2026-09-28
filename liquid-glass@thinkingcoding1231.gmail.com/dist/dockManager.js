import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableActor } from './actors/unpickable.js';
import { UILayerSampler } from './capture/uiLayerSampler.js';
import { WindowCloneManager } from './capture/windowClones.js';
import { reportFrameLoopError } from './diagnostics/logging.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './animation/frameSync.js';
import { setClipIfChanged } from './actors/writes.js';
import { syncGlassCaptureClip } from './capture/clip.js';
import { isActorValid } from './actors/lifecycle.js';
const SHADER_PADDING = 20;
function hexToColorArray(hex) {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) {
        return [1.0, 1.0, 1.0];
    }
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
}
export class DashManager {
    extensionPath;
    targetActor;
    _settings;
    bgActor = null;
    effect = null;
    liquidBox = null;
    _lastScreenW;
    _lastScreenH;
    _glassExpand;
    _signals;
    _settingsSignals;
    _frameSyncId;
    _frameSignalId = 0;
    _lastTickUs = 0;
    _torndown = false;
    _isEffectActive;
    _originalStyle;
    _currentMarginStyle;
    _dockParent = null;
    _cloneContainer = null;
    _lastAbsX;
    _lastAbsY;
    _lastTW;
    _lastTH;
    _stableDeltaW;
    _stableDeltaH;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _lastBaseW;
    _lastBaseH;
    _outputLogs = false;
    _marginValue = 0;
    _lastHidden;
    _uiSampler = null;
    _windowCloneManager = null;
    _logger;
    constructor(extensionPath, targetActor, settings, logger) {
        this.extensionPath = extensionPath;
        this.targetActor = targetActor;
        this._settings = settings;
        this._logger = logger;
        this._glassExpand = 0;
        this._signals = [];
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;
    }
    setup() {
        if (!this.targetActor || !this._settings)
            return;
        this._bindSettings();
        if (this._settings.get_boolean('enable-dock-glass')) {
            this._applyEffect();
        }
    }
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        connectSetting('enable-dock-glass', () => {
            let enabled = this._settings.get_boolean('enable-dock-glass');
            if (enabled && !this._isEffectActive) {
                this._applyEffect();
            }
            else if (!enabled && this._isEffectActive) {
                this._removeEffect();
            }
        });
        connectSetting('dock-glass-expand', () => {
            if (this.effect && this._isEffectActive) {
                this._glassExpand = this._settings.get_int('dock-glass-expand');
                this.bgActor?.queue_redraw();
            }
        });
        connectSetting('dock-margin-bottom', () => {
            if (this._isEffectActive)
                this._applyMargin();
            this._marginValue = this._settings.get_int('dock-margin-bottom') || 0;
        });
        connectSetting('dock-tint-color', () => {
            if (this.effect && this._isEffectActive) {
                let colorArray = hexToColorArray(this._settings.get_string('dock-tint-color'));
                this.effect.setTintColor(...colorArray);
            }
        });
        connectSetting('dock-tint-strength', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setTintStrength(this._settings.get_double('dock-tint-strength'));
            }
        });
        connectSetting('dock-blur-radius', () => {
            const radius = this._settings.get_int('dock-blur-radius');
            if (this.effect && this._isEffectActive)
                this.effect.setBlurRadius(radius);
        });
        connectSetting('dock-corner-radius', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setCornerRadius(this._settings.get_double('dock-corner-radius'));
            }
        });
        connectSetting('output-logs', () => {
            this._outputLogs = this._settings.get_boolean('output-logs');
        });
        connectSetting('dock-brightness', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setBrightness(this._settings.get_double('dock-brightness'));
            }
        });
        connectSetting('dock-contrast', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setContrast(this._settings.get_double('dock-contrast'));
            }
        });
        connectSetting('dock-saturation', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setSaturation(this._settings.get_double('dock-saturation'));
            }
        });
    }
    _applyMargin() {
        if (!this.targetActor)
            return;
        let marginBottom = this._settings.get_int('dock-margin-bottom');
        let [w, h] = this.targetActor.get_size();
        let [x, y] = this.targetActor.get_transformed_position();
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let distLeft = x - monitor.x;
        let distRight = (monitor.x + monitor.width) - (x + w);
        let distTop = y - monitor.y;
        let distBottom = (monitor.y + monitor.height) - (y + h);
        let minEdge = Math.min(distLeft, distRight, distTop, distBottom);
        let marginStyle = '';
        if (minEdge === distBottom || minEdge === distTop) {
            if (minEdge === distBottom) {
                marginStyle = `margin-bottom: ${marginBottom}px;`;
            }
            else {
                marginStyle = `margin-top: ${marginBottom}px;`;
            }
        }
        else {
            if (minEdge === distRight) {
                marginStyle = `margin-right: ${marginBottom}px;`;
            }
            else {
                marginStyle = `margin-left: ${marginBottom}px;`;
            }
        }
        if (this._originalStyle === undefined) {
            this._originalStyle = this.targetActor.get_style() || '';
        }
        this._currentMarginStyle = marginStyle;
        this.targetActor.set_style(`${this._originalStyle} ${marginStyle}`);
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        this._lastScreenW = this._lastScreenH = undefined;
        this._lastBgW = this._lastBgH = undefined;
        this._lastBgX = this._lastBgY = undefined;
        this._lastBaseW = this._lastBaseH = undefined;
        this._lastAbsX = this._lastAbsY = undefined;
        this._lastTW = this._lastTH = undefined;
        this._stableDeltaW = this._stableDeltaH = undefined;
        this._lastHidden = undefined;
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this._dockParent = this.targetActor.get_parent();
        if (this._dockParent) {
            this._dockParent.add_style_class_name('liquid-glass-transparent');
        }
        this.bgActor = new UnpickableActor();
        this.bgActor.set_name('liquid-glass-bg-actor');
        this.bgActor.set_size(1.0, 1.0);
        this.liquidBox = new UnpickableActor();
        this.liquidBox.set_name("liquid-box");
        this.liquidBox.set_clip_to_allocation(true);
        this.bgActor.add_child(this.liquidBox);
        let dummyBreaker = new UnpickableActor();
        dummyBreaker.set_name("optimization-breaker");
        dummyBreaker.set_size(1.0, 1.0);
        dummyBreaker.set_opacity(0);
        this.liquidBox.add_child(dummyBreaker);
        this._cloneContainer = new UnpickableActor();
        this._cloneContainer.set_name("clone-container");
        this.liquidBox.add_child(this._cloneContainer);
        this._applyMargin();
        this._marginValue = this._settings.get_int('dock-margin-bottom');
        this._glassExpand = this._settings.get_int("dock-glass-expand");
        this._outputLogs = this._settings.get_boolean('output-logs');
        let dockRoot = this.targetActor;
        while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
            let p = dockRoot.get_parent();
            if (!p)
                break;
            dockRoot = p;
        }
        if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, dockRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        let blurRadius = this._settings.get_int('dock-blur-radius');
        let tintColorStr = this._settings.get_string('dock-tint-color');
        let tintStrength = this._settings.get_double('dock-tint-strength');
        let cornerRadius = this._settings.get_double('dock-corner-radius');
        let brightness = this._settings.get_double('dock-brightness');
        let contrast = this._settings.get_double('dock-contrast');
        let saturation = this._settings.get_double('dock-saturation');
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings, logger: this._logger, owner: 'dock' });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...hexToColorArray(tintColorStr));
        this.effect.setTintStrength(tintStrength);
        this.effect.setCornerRadius(cornerRadius);
        this.effect.setBrightness(brightness);
        this.effect.setContrast(contrast);
        this.effect.setSaturation(saturation);
        this.effect.setBlurRadius(blurRadius);
        this.effect.setIsDock(true);
        this.liquidBox.add_effect(this.effect);
        this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer, 'lg-dock');
        this._uiSampler = new UILayerSampler(this.bgActor, this.liquidBox, [dockRoot, global.windowGroup, global.window_group], this._cloneContainer, 'dock', [this.targetActor]);
        this.bgActor.show();
        const laterAdd = (laterType, callback) => {
            return global.compositor.get_laters().add(laterType, callback);
        };
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        let buildClones = () => {
            if (!this.bgActor)
                return;
            if (this._uiSampler) {
                for (let child of Main.layoutManager.uiGroup.get_children()) {
                    if (child === this.bgActor)
                        continue;
                    let isLiquidBg = child.name === 'liquid-glass-bg-actor' ||
                        (typeof child.get_children === 'function' &&
                            child.get_children().some(c => c.name === 'liquid-box'));
                    if (isLiquidBg) {
                        this._uiSampler.addExclusion(child);
                    }
                }
            }
            this._windowCloneManager?.rebuildClones();
            this._uiSampler?.rebindSelf();
            this._uiSampler?.refresh();
        };
        let frameTick = () => {
            if (this._torndown || !this._isEffectActive || !this.bgActor || !this.targetActor.mapped)
                return;
            if (isFrameSyncFrozen())
                return;
            const nowUs = GLib.get_monotonic_time();
            if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US)
                return;
            this._lastTickUs = nowUs;
            try {
                ensureGlassAllocated(this.bgActor);
                this._syncGeometry();
            }
            catch (e) {
                reportFrameLoopError('DockManager', e);
            }
        };
        let startFrameSync = () => {
            if (this._frameSignalId === 0) {
                buildClones();
                this._frameSignalId = global.stage.connect('before-update', frameTick);
                this._frameSyncId = laterAdd(frameLaterType, () => {
                    this._frameSyncId = 0;
                    frameTick();
                    return GLib.SOURCE_REMOVE;
                });
            }
        };
        let mapSignalId = this.targetActor.connect('notify::mapped', () => {
            if (this.targetActor.mapped) {
                startFrameSync();
            }
            else {
                this._stopFrameSync();
            }
        });
        this._signals.push(mapSignalId);
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped)
            return;
        let sourceActor = this.targetActor;
        let children = this.targetActor.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i].has_style_class_name('dash-background')) {
                children[i].opacity = 0;
                sourceActor = children[i];
            }
        }
        let [baseW, baseH] = sourceActor.get_size();
        let [absX, absY] = sourceActor.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        if (sourceActor !== this.targetActor) {
            let [tX, tY] = this.targetActor.get_transformed_position();
            let [tW, tH] = this.targetActor.get_size();
            if (absX < tX) {
                baseW -= (tX - absX);
                absX = tX;
            }
            if (absY < tY) {
                baseH -= (tY - absY);
                absY = tY;
            }
            if (absX + baseW > tX + tW) {
                baseW = (tX + tW) - absX;
            }
            if (absY + baseH > tY + tH) {
                baseH = (tY + tH) - absY;
            }
        }
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let minCenterDist = -1;
        let distLeftCenter = 0;
        let distRightCenter = 0;
        let distTopCenter = 0;
        let distBottomCenter = 0;
        if (monitor) {
            let dockCenterX = absX + (baseW / 2);
            let dockCenterY = absY + (baseH / 2);
            distLeftCenter = dockCenterX - monitor.x;
            distRightCenter = (monitor.x + monitor.width) - dockCenterX;
            distTopCenter = dockCenterY - monitor.y;
            distBottomCenter = (monitor.y + monitor.height) - dockCenterY;
            minCenterDist = Math.min(distLeftCenter, distRightCenter, distTopCenter, distBottomCenter);
        }
        if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
            let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);
            if (isHorizontalDock) {
                if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1) {
                    baseH = this._lastBaseH;
                }
            }
            else {
                if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1) {
                    baseW = this._lastBaseW;
                }
            }
        }
        this._lastBaseW = baseW;
        this._lastBaseH = baseH;
        let refActor = this._findReferenceActor(this.targetActor);
        if (refActor) {
            let [refW, refH] = refActor.get_size();
            let [refX, refY] = refActor.get_transformed_position();
            if (!Number.isNaN(refX) && !Number.isNaN(refY) && refW > 0 && refH > 0) {
                let topGap = refY - absY;
                let bottomGap = (absY + baseH) - (refY + refH);
                if (topGap < 0 || bottomGap < 0) {
                    let trueRefY = refY - refH;
                    topGap = trueRefY - absY;
                    bottomGap = (absY + baseH) - (trueRefY + refH);
                }
                let leftGap = refX - absX;
                let rightGap = (absX + baseW) - (refX + refW);
                if (leftGap < 0 || rightGap < 0) {
                    let trueRefX = refX - refW;
                    leftGap = trueRefX - absX;
                    rightGap = (absX + baseW) - (trueRefX + refW);
                }
                if (baseW >= baseH) {
                    let diff = Math.abs(bottomGap - topGap);
                    if (diff > 0 && diff < baseH / 2) {
                        if (bottomGap > topGap) {
                            baseH -= diff;
                        }
                        else {
                            absY += diff;
                            baseH -= diff;
                        }
                    }
                }
                else {
                    let diff = Math.abs(rightGap - leftGap);
                    if (diff > 0 && diff < baseW / 2) {
                        if (minCenterDist === distLeftCenter) {
                            if (rightGap > leftGap) {
                                baseW -= diff;
                            }
                        }
                        else {
                            if (rightGap > leftGap) {
                                baseW -= diff;
                            }
                            else {
                                absX += diff;
                                baseW -= diff;
                            }
                        }
                    }
                }
            }
        }
        let marginValue = this._marginValue || 0;
        if (monitor && marginValue > 0) {
            let isMoving = false;
            if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
                let diffX = Math.abs(absX - this._lastAbsX);
                let diffY = Math.abs(absY - this._lastAbsY);
                if (diffX > 1.0 || diffY > 1.0) {
                    isMoving = true;
                }
            }
            this._lastAbsX = absX;
            this._lastAbsY = absY;
            let [tW, tH] = this.targetActor.get_size();
            if (this._stableDeltaW === undefined || this._lastTW !== tW) {
                this._stableDeltaW = baseW - tW;
                this._lastTW = tW;
            }
            if (this._stableDeltaH === undefined || this._lastTH !== tH) {
                this._stableDeltaH = baseH - tH;
                this._lastTH = tH;
            }
            let stableBaseW = tW + this._stableDeltaW;
            let stableBaseH = tH + this._stableDeltaH;
            if (!isMoving) {
                if (minCenterDist === distBottomCenter) {
                    let expectedBottom = monitor.y + monitor.height - marginValue;
                    if (absY + baseH > expectedBottom) {
                        let overflow = (absY + baseH) - expectedBottom;
                        baseH -= overflow;
                    }
                    if (baseH > stableBaseH)
                        baseH = stableBaseH;
                }
                else if (minCenterDist === distTopCenter) {
                    let expectedTop = monitor.y + marginValue;
                    if (absY < expectedTop) {
                        let diff = expectedTop - absY;
                        absY = expectedTop;
                        baseH -= diff;
                    }
                    if (baseH > stableBaseH)
                        baseH = stableBaseH;
                }
                else if (minCenterDist === distRightCenter) {
                    let expectedRight = monitor.x + monitor.width - marginValue;
                    if (absX + baseW > expectedRight) {
                        let overflow = (absX + baseW) - expectedRight;
                        baseW -= overflow;
                    }
                    if (baseW > stableBaseW)
                        baseW = stableBaseW;
                }
                else {
                    let expectedLeft = monitor.x + marginValue;
                    if (absX < expectedLeft) {
                        let diff = expectedLeft - absX;
                        absX = expectedLeft;
                        baseW -= diff;
                    }
                    if (baseW > stableBaseW)
                        baseW = stableBaseW;
                }
            }
        }
        let w = Math.max(1.0, baseW);
        let h = Math.max(1.0, baseH);
        if (baseW <= 9 || baseH <= 9) {
            this.bgActor.hide();
            this._lastBgW = undefined;
            this._lastBgH = undefined;
            this._lastBgX = undefined;
            this._lastBgY = undefined;
            return;
        }
        else {
            this.bgActor.show();
        }
        this.bgActor.opacity = this.targetActor.opacity;
        let visibleW = baseW;
        let visibleH = baseH;
        if (monitor) {
            if (absX < monitor.x)
                visibleW -= (monitor.x - absX);
            if (absY < monitor.y)
                visibleH -= (monitor.y - absY);
            if (absX + baseW > monitor.x + monitor.width)
                visibleW -= ((absX + baseW) - (monitor.x + monitor.width));
            if (absY + baseH > monitor.y + monitor.height)
                visibleH -= ((absY + baseH) - (monitor.y + monitor.height));
        }
        if (visibleW <= 1 || visibleH <= 1) {
            if (this._lastHidden !== true) {
                this._lastHidden = true;
                this._logger.log(`[Liquid Glass][dock] hiding the glass: visible=(${visibleW.toFixed(1)}x${visibleH.toFixed(1)}) ` +
                    `base=(${baseW.toFixed(1)}x${baseH.toFixed(1)}) abs=(${absX.toFixed(1)},${absY.toFixed(1)}) ` +
                    `monitor=(${monitor?.x},${monitor?.y},${monitor?.width}x${monitor?.height}) ` +
                    `margin=${this._marginValue}`);
            }
            this.bgActor.opacity = 0;
        }
        else {
            if (this._lastHidden === true) {
                this._lastHidden = false;
                this._logger.log('[Liquid Glass][dock] glass visible again');
            }
            this.bgActor.opacity = this.targetActor.opacity;
        }
        let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgX = absX - SHADER_PADDING - this._glassExpand;
        let bgY = absY - SHADER_PADDING - this._glassExpand;
        let screenW = monitor.width;
        let screenH = monitor.height;
        let localBgX = bgX - monitor.x;
        let localBgY = bgY - monitor.y;
        if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
            this._lastBgX !== bgX || this._lastBgY !== bgY ||
            this._lastScreenW !== screenW || this._lastScreenH !== screenH ||
            this.bgActor.x !== monitor.x || this.bgActor.y !== monitor.y) {
            this.bgActor.remove_transition('size');
            this.bgActor.remove_transition('position');
            this.bgActor.set_position(monitor.x, monitor.y);
            this.bgActor.set_size(screenW, screenH);
            this.bgActor.remove_transition('size');
            this.bgActor.remove_transition('position');
            this.liquidBox?.set_position(0, 0);
            this.liquidBox?.set_size(screenW, screenH);
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = bgX;
            this._lastBgY = bgY;
            this._lastScreenW = screenW;
            this._lastScreenH = screenH;
        }
        const CLIP_PADDING = 200;
        setClipIfChanged(this.bgActor, localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
        const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
        this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);
        this.effect?.setResolution(screenW, screenH);
        this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);
        this._windowCloneManager?.setOffset(-monitor.x, -monitor.y);
        syncGlassCaptureClip({
            cloneContainer: this._cloneContainer,
            effect: this.effect,
            originX: monitor.x,
            originY: monitor.y,
            uiSampler: this._uiSampler,
            windowCloneManager: this._windowCloneManager,
        });
        this._uiSampler?.refresh();
        this._uiSampler?.sync(monitor.x, monitor.y, screenW, screenH);
        this._windowCloneManager?.sync();
    }
    _stopFrameSync() {
        this._teardownStep('frameSignal', () => {
            const id = this._frameSignalId;
            this._frameSignalId = 0;
            if (id)
                global.stage.disconnect(id);
        });
        this._teardownStep('initialFrame', () => {
            const id = this._frameSyncId;
            this._frameSyncId = 0;
            if (id)
                global.compositor?.get_laters().remove(id);
        });
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._currentMarginStyle = undefined;
        this._stopFrameSync();
        for (const id of this._signals) {
            this._teardownStep('targetSignal', () => {
                if (isActorValid(this.targetActor))
                    this.targetActor.disconnect(id);
            });
        }
        this._signals = [];
        this._teardownStep('targetStyle', () => {
            if (!isActorValid(this.targetActor))
                return;
            this.targetActor.remove_style_class_name('liquid-glass-transparent');
            if (this._originalStyle !== undefined)
                this.targetActor.set_style(this._originalStyle);
            for (const child of this.targetActor.get_children()) {
                if (child.has_style_class_name('dash-background'))
                    child.opacity = 255;
            }
        });
        this._originalStyle = undefined;
        this._teardownStep('parentStyle', () => {
            if (isActorValid(this._dockParent))
                this._dockParent.remove_style_class_name('liquid-glass-transparent');
        });
        this._dockParent = null;
        this._teardownStep('effect', () => this.effect?.cleanup());
        this.effect = null;
        this._teardownStep('uiSampler', () => this._uiSampler?.destroy());
        this._uiSampler = null;
        this._teardownStep('windowClones', () => this._windowCloneManager?.destroy());
        this._windowCloneManager = null;
        this._teardownStep('background', () => {
            if (isActorValid(this.bgActor))
                this.bgActor.destroy();
        });
        this.bgActor = null;
        this.liquidBox = null;
        this._cloneContainer = null;
    }
    _teardownStep(name, fn) {
        try {
            fn();
        }
        catch (e) {
            try {
                this._logger?.error(`[Liquid Glass] ${this.constructor.name}.${name} failed during cleanup: ${e}`);
            }
            catch (_) {
                console.error(`[Liquid Glass] ${name} failed during cleanup: ${e}`);
            }
        }
    }
    cleanup() {
        this._torndown = true;
        this._stopFrameSync();
        this._teardownStep('removeEffect', () => this._removeEffect());
        this._teardownStep('settingsSignals', () => {
            if (this._settings) {
                for (let id of this._settingsSignals) {
                    try {
                        this._settings.disconnect(id);
                    }
                    catch (e) { }
                }
                this._settingsSignals = [];
            }
        });
    }
    _findReferenceActor(actor) {
        if (!actor)
            return null;
        if (!actor || typeof actor.get_children !== 'function') {
            return null;
        }
        if (actor.toString().includes('IndicatorDrawingArea')) {
            return actor;
        }
        const children = actor.get_children();
        for (const child of children) {
            const found = this._findReferenceActor(child);
            if (found) {
                return found;
            }
        }
        return null;
    }
}
