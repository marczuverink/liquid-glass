import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
export class SelfExcludingSnapshotCapture {
    _content = null;
    _rectGetter;
    _hideActors = new Set();
    _stage;
    _refCount = 0;
    _afterPaintId = 0;
    _destroyed = false;
    static FRAME_SKIP = 1;
    _frameCounter = 0;
    _label;
    _failCount = 0;
    _okCount = 0;
    _activeCheck;
    constructor(stage, hideActor, rectGetter, label = 'snapshot', activeCheck = null) {
        this._stage = stage;
        this._label = label;
        this._activeCheck = activeCheck;
        if (hideActor)
            this._hideActors.add(hideActor);
        this._rectGetter = rectGetter;
        this._captureOnce();
        try {
            this._afterPaintId = this._stage.connect('after-paint', () => {
                if (this._destroyed)
                    return;
                this._frameCounter++;
                if (this._frameCounter % SelfExcludingSnapshotCapture.FRAME_SKIP !== 0)
                    return;
                this._captureOnce();
            });
        }
        catch (e) {
        }
    }
    retain() { this._refCount++; }
    release() {
        this._refCount--;
        if (this._refCount <= 0) {
            this.destroy();
            return true;
        }
        return false;
    }
    addHideActor(actor) {
        if (actor)
            this._hideActors.add(actor);
    }
    removeHideActor(actor) {
        if (actor)
            this._hideActors.delete(actor);
    }
    _report(kind, detail) {
        this._failCount++;
        if (this._failCount <= 2 || this._failCount % 300 === 0) {
            console.warn(`[Liquid Glass][snapshot:${this._label}] ${kind} (failures=${this._failCount}, ` +
                `successes=${this._okCount}): ${detail}`);
        }
    }
    _captureOnce() {
        if (this._activeCheck) {
            try {
                if (!this._activeCheck())
                    return;
            }
            catch (e) {
                return;
            }
        }
        const [x, y, w, h] = this._rectGetter();
        if (w <= 0 || h <= 0) {
            this._report('empty capture rect', `x=${x} y=${y} w=${w} h=${h}`);
            return;
        }
        const hidden = [];
        try {
            for (const actor of this._hideActors) {
                try {
                    if (actor && actor.visible) {
                        actor.hide();
                        hidden.push(actor);
                    }
                }
                catch (_) { }
            }
            const rect = new Mtk.Rectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
            const scale = 1;
            const NO_CURSORS = Clutter.PaintFlag?.NO_CURSORS ?? 0;
            const CLEAR = Clutter.PaintFlag?.CLEAR ?? 0;
            const paintFlags = NO_CURSORS | CLEAR;
            const content = this._stage.paint_to_content?.(rect, scale, null, paintFlags);
            if (content) {
                this._content = content;
                this._okCount++;
            }
            else {
                this._report('paint_to_content returned null', `rect=${rect.x},${rect.y} ${rect.width}x${rect.height}`);
            }
        }
        catch (e) {
            this._report('paint_to_content threw', `${e}`);
        }
        finally {
            for (const actor of hidden) {
                try {
                    actor.show();
                }
                catch (_) { }
            }
        }
    }
    getContent() {
        return this._content;
    }
    destroy() {
        this._destroyed = true;
        if (this._afterPaintId) {
            try {
                this._stage.disconnect(this._afterPaintId);
            }
            catch (_) { }
            this._afterPaintId = 0;
        }
    }
}
const _selfExcludingSnapshotRegistry = new Map();
export function acquireSelfExcludingSnapshot(sourceActor, stage, hideActor, rectGetter, label = 'bms') {
    let cap = _selfExcludingSnapshotRegistry.get(sourceActor);
    if (!cap) {
        cap = new SelfExcludingSnapshotCapture(stage, hideActor, rectGetter, label);
        _selfExcludingSnapshotRegistry.set(sourceActor, cap);
    }
    else {
        cap.addHideActor(hideActor);
    }
    cap.retain();
    return cap;
}
export function releaseSelfExcludingSnapshot(sourceActor, hideActor) {
    const cap = _selfExcludingSnapshotRegistry.get(sourceActor);
    if (!cap)
        return;
    cap.removeHideActor(hideActor);
    if (cap.release()) {
        _selfExcludingSnapshotRegistry.delete(sourceActor);
    }
}
