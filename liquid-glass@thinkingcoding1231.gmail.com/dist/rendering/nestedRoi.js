import Cogl from 'gi://Cogl';
const ROI_PAD = 2;
const _captureOwners = new Map();
export function registerCaptureOwner(owner, texture, previous) {
    if (previous && previous !== texture && _captureOwners.get(previous) === owner)
        _captureOwners.delete(previous);
    _captureOwners.set(texture, owner);
    return texture;
}
export function unregisterCaptureOwner(owner, texture) {
    if (texture && _captureOwners.get(texture) === owner)
        _captureOwners.delete(texture);
}
function enclosingOwner(self, paintContext) {
    if (_captureOwners.size === 0)
        return null;
    try {
        const fb = paintContext.get_framebuffer();
        if (!(fb instanceof Cogl.Offscreen))
            return null;
        const owner = _captureOwners.get(fb.get_texture()) ?? null;
        return owner && owner !== self ? owner : null;
    }
    catch (_) {
        return null;
    }
}
export function nestedCompositeRoi(self, actor, paintContext, resW, resH) {
    if (!actor)
        return null;
    const roi = enclosingOwner(self, paintContext)?._lgCaptureScreenRect ?? null;
    if (!roi)
        return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sx of [roi[0], roi[0] + roi[2]]) {
        for (const sy of [roi[1], roi[1] + roi[3]]) {
            let res;
            try {
                res = actor.transform_stage_point(sx, sy);
            }
            catch (_) {
                return null;
            }
            if (!Array.isArray(res) || res[0] !== true || !Number.isFinite(res[1]) || !Number.isFinite(res[2]))
                return null;
            minX = Math.min(minX, res[1]);
            maxX = Math.max(maxX, res[1]);
            minY = Math.min(minY, res[2]);
            maxY = Math.max(maxY, res[2]);
        }
    }
    return [
        Math.max(0, Math.floor(minX) - ROI_PAD),
        Math.max(0, Math.floor(minY) - ROI_PAD),
        Math.min(resW, Math.ceil(maxX) + ROI_PAD),
        Math.min(resH, Math.ceil(maxY) + ROI_PAD),
    ];
}
export function clampToRoi(compRect, roi, resW, resH) {
    const base = compRect ?? [0, 0, resW, resH];
    const x0 = Math.max(base[0], roi[0]);
    const y0 = Math.max(base[1], roi[1]);
    const x1 = Math.min(base[0] + base[2], roi[2]);
    const y1 = Math.min(base[1] + base[3], roi[3]);
    if (!(x1 > x0) || !(y1 > y0))
        return { rect: compRect, skip: true, clamped: false };
    if (x0 > base[0] || y0 > base[1] || x1 < base[0] + base[2] || y1 < base[1] + base[3])
        return { rect: [x0, y0, x1 - x0, y1 - y0], skip: false, clamped: true };
    return { rect: compRect, skip: false, clamped: false };
}
