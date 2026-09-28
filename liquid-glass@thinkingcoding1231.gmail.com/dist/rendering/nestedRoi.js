import Cogl from 'gi://Cogl';
import { isLiveGlassEffect } from '../diagnostics/glass.js';
const ROI_PAD = 2;
// ─── Nested-composite region of interest ─────────────────────────────────────
//
// [PERF B2] When a glass re-renders its capture, every window glass reached
// through a clone inside it runs its composite pass into that capture — over
// its WHOLE window, e.g. 2132x1246 for a maximized window — even though the
// enclosing glass only ever samples the part of its capture it can show (its
// cull rect: glass + refraction reach + blur reach + slack, the very rect ①b
// culls whole windows against, published by syncGlassCaptureClip() as
// `_lgCaptureScreenRect`). Everything composited outside it is thrown away.
//
// A nested composite therefore shrinks its quad to the enclosing glass's rect.
// FINDING the enclosing glass is the subtle part. A nested paint does NOT run
// inside the enclosing effect's vfunc_paint(): ClutterOffscreenEffect adds an
// actor node, and that node's draw handler paints the subtree during the
// EXECUTION phase, after every vfunc_paint of the build phase has returned
// (see _blurFrameSerial's note). The first implementation published the rect
// on a stack around vfunc_paint() and so never found anything — measured:
// nested composite fill unchanged. What IS true at execution time is that the
// enclosing effect's offscreen is the current framebuffer. So the lookup goes
//     paintContext.get_framebuffer() -> Cogl.Offscreen.get_texture()
//       -> the LiquidEffect whose capture that texture is
// via this table, which each glass keeps current from its own paint_target.
// Any other offscreen in between (another extension's effect) simply is not in
// the table, and the composite is left whole — the safe side.
//
// The rect is in SCREEN coordinates, the space every clone is placed in (each
// clone sits at its source's own screen position; the container translation
// maps that into the capture), so the nested glass maps it into its own space
// with its REAL stage transform, which the clone reproduces exactly.
//
// This shrinks geometry; it is NOT a set_clip() (memo.md 地雷17).
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
        // Top-level paints draw into the stage view's (onscreen) framebuffer and
        // stop here.
        if (!(fb instanceof Cogl.Offscreen))
            return null;
        const owner = _captureOwners.get(fb.get_texture()) ?? null;
        return owner && owner !== self && isLiveGlassEffect(owner) ? owner : null;
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
