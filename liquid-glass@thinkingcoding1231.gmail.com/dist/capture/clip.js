import { isActorValid } from '../actors/lifecycle.js';
import { isCaptureClipEnabled, isCloneCullEnabled } from './options.js';
import { unionRectInto } from '../actors/geometry.js';
import { setClipIfChanged } from '../actors/writes.js';
export function syncGlassCaptureClip(opts) {
    const { cloneContainer, effect, originX, originY } = opts;
    const uiSampler = opts.uiSampler ?? null;
    const windowCloneManager = opts.windowCloneManager ?? null;
    const clear = () => {
        if (cloneContainer && isActorValid(cloneContainer) &&
            cloneContainer._lgClipW !== undefined) {
            cloneContainer._lgClipX = undefined;
            cloneContainer._lgClipY = undefined;
            cloneContainer._lgClipW = undefined;
            cloneContainer._lgClipH = undefined;
            try {
                cloneContainer.remove_clip();
            }
            catch (_) { }
        }
        uiSampler?.setCullRect(null);
        windowCloneManager?.setCullRect(null);
        windowCloneManager?.applyBgCloneClip(null);
        if (effect)
            effect._lgCaptureClip = null;
    };
    if (!isCaptureClipEnabled() && !isCloneCullEnabled()) {
        clear();
        return;
    }
    if (!effect || typeof effect.getCaptureClipRect !== 'function') {
        clear();
        return;
    }
    let rect = null;
    try {
        const r = effect.getCaptureClipRect();
        if (r)
            rect = [r[0], r[1], r[2], r[3]];
    }
    catch (_) {
        clear();
        return;
    }
    if (!rect) {
        clear();
        return;
    }
    if (uiSampler?.hasUnmeasuredBmsReplica()) {
        clear();
        return;
    }
    const bmsRects = uiSampler?.getBmsScreenRects() ?? [];
    for (const b of bmsRects) {
        unionRectInto(rect, [b[0] - originX, b[1] - originY, b[2], b[3]]);
    }
    const [resW, resH] = typeof effect.getResolution === 'function'
        ? effect.getResolution() : [0, 0];
    if (resW >= 1 && resH >= 1) {
        const x1 = Math.min(resW, rect[0] + rect[2]);
        const y1 = Math.min(resH, rect[1] + rect[3]);
        rect[0] = Math.max(0, rect[0]);
        rect[1] = Math.max(0, rect[1]);
        rect[2] = x1 - rect[0];
        rect[3] = y1 - rect[1];
        if (!(rect[2] >= 2) || !(rect[3] >= 2)) {
            clear();
            return;
        }
    }
    if (isCaptureClipEnabled() && cloneContainer && isActorValid(cloneContainer)) {
        setClipIfChanged(cloneContainer, rect[0], rect[1], rect[2], rect[3]);
    }
    else if (cloneContainer && isActorValid(cloneContainer) &&
        cloneContainer._lgClipW !== undefined) {
        cloneContainer._lgClipW = undefined;
        try {
            cloneContainer.remove_clip();
        }
        catch (_) { }
    }
    effect._lgCaptureClip = rect.slice();
    const screenRect = [rect[0] + originX, rect[1] + originY, rect[2], rect[3]];
    windowCloneManager?.applyBgCloneClip(isCaptureClipEnabled() ? screenRect : null);
    uiSampler?.setCullRect(screenRect);
    windowCloneManager?.setCullRect(screenRect);
}
