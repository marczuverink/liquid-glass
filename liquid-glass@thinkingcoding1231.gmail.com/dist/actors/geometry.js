import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isActorValid } from './lifecycle.js';
/** True when the two rects share at least one pixel. */
export function rectsIntersect(ax, ay, aw, ah, b) {
    return ax < b[0] + b[2] && ax + aw > b[0] &&
        ay < b[1] + b[3] && ay + ah > b[1];
}
/** Grows `a` in place so it also contains `b`. */
export function unionRectInto(a, b) {
    const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
    const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
    a[0] = Math.min(a[0], b[0]);
    a[1] = Math.min(a[1], b[1]);
    a[2] = x1 - a[0];
    a[3] = y1 - a[1];
}
/**
 * An actor's allocated size. get_size() falls back to the preferred size
 * while a relayout is pending, which our BEFORE_REDRAW syncs run into all the
 * time; for the overview (preferred size 0x0, sized by constraints) that
 * meant a zero-sized clone and a one-frame flash of wallpaper.
 */
export function getAllocatedSize(actor) {
    const box = actor.get_allocation_box();
    const w = box.get_width();
    const h = box.get_height();
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
        return [w, h];
    // Not allocated yet.
    const [sw, sh] = actor.get_size();
    return [sw, sh];
}
/**
 * An actor's on-screen rectangle [x, y, w, h] with every ancestor transform
 * applied. Pairing get_transformed_position() with a size is wrong while an
 * ancestor is scaled (menu open animations, window resizes): the origin is
 * transformed but the size is not. Use this for rects in screen space only.
 */
export function getTransformedRect(actor) {
    const r = actor.get_transformed_extents();
    const x = r.origin.x, y = r.origin.y;
    const w = r.size.width, h = r.size.height;
    if (Number.isFinite(x) && Number.isFinite(y) &&
        Number.isFinite(w) && Number.isFinite(h))
        return [x, y, w, h];
    const [px, py] = actor.get_transformed_position();
    const [aw, ah] = getAllocatedSize(actor);
    return [px, py, aw, ah];
}
/**
 * Where the actor's own pixels are inside the padded capture texture, and the
 * rect to draw the composite into so it lands back on the actor.
 *
 * ClutterOffscreenEffect enlarges the paint volume unevenly
 * (_clutter_actor_box_enlarge_for_effects(): 2px left/top, 1px right/bottom
 * for a whole-pixel actor), and vfunc_paint_target() runs in capture texel
 * space, whose origin is the texture's top-left corner rather than the
 * actor's. This replicates Clutter's computation and falls back to centred
 * padding if the result does not reproduce the texture size.
 */
export function computeCaptureLayout(actor, srcW, srcH, allocW, allocH) {
    const centredFallback = () => {
        const padW = srcW - allocW;
        const padH = srcH - allocH;
        if (padW === 0 && padH === 0) {
            return { uv: [0, 0, 1, 1], dest: [0, 0, allocW, allocH] };
        }
        const x0 = padW / 2, y0 = padH / 2;
        return {
            uv: [
                x0 / srcW, y0 / srcH,
                Math.min(1.0, (x0 + allocW) / srcW),
                Math.min(1.0, (y0 + allocH) / srcH),
            ],
            dest: [x0, y0, x0 + allocW, y0 + allocH],
        };
    };
    if (!actor)
        return centredFallback();
    // Without a paint volume Clutter uses the allocation box, which is the
    // same rect with its origin at (0, 0).
    let rawX1 = 0, rawY1 = 0, rawX2 = allocW, rawY2 = allocH;
    const pv = actor.get_paint_volume();
    if (pv) {
        const origin = pv.get_origin();
        rawX1 = origin.x;
        rawY1 = origin.y;
        rawX2 = rawX1 + pv.get_width();
        rawY2 = rawY1 + pv.get_height();
    }
    if (!Number.isFinite(rawX1) || !Number.isFinite(rawY1) ||
        !Number.isFinite(rawX2) || !Number.isFinite(rawY2)) {
        return centredFallback();
    }
    // CLUTTER_NEARBYINT: round half away from zero, truncated to an int.
    const nearbyint = (v) => Math.trunc(v < 0 ? v - 0.5 : v + 0.5);
    let x1 = rawX1, y1 = rawY1, x2 = rawX2, y2 = rawY2;
    // _clutter_actor_box_enlarge_for_effects leaves a zero-area box alone.
    if ((rawX2 - rawX1) * (rawY2 - rawY1) !== 0) {
        const w = nearbyint(rawX2 - rawX1);
        const h = nearbyint(rawY2 - rawY1);
        x2 = Math.ceil(rawX2 + 0.75);
        y2 = Math.ceil(rawY2 + 0.75);
        x1 = x2 - w - 3;
        y1 = y2 - h - 3;
    }
    const boxW = x2 - x1;
    const boxH = y2 - y1;
    if (!(boxW > 0) || !(boxH > 0))
        return centredFallback();
    // The FBO offset is the integer truncation of the enlarged box's origin, so
    // capture texel = (actorLocal - fboOffset) * scale.
    const fboOffX = Math.trunc(x1);
    const fboOffY = Math.trunc(y1);
    // pre_paint() scales the box by ceilf(resourceScale), so the scale can be
    // recovered from the texture size; a mismatch means the replication is off.
    const scale = Math.max(1, Math.round(srcW / boxW));
    if (Math.ceil(boxW * scale) !== srcW || Math.ceil(boxH * scale) !== srcH) {
        return centredFallback();
    }
    const padLeft = -fboOffX * scale;
    const padTop = -fboOffY * scale;
    const contentW = allocW * scale;
    const contentH = allocH * scale;
    if (!(padLeft >= 0) || !(padTop >= 0) ||
        padLeft + contentW > srcW || padTop + contentH > srcH) {
        return centredFallback();
    }
    return {
        uv: [
            padLeft / srcW, padTop / srcH,
            (padLeft + contentW) / srcW, (padTop + contentH) / srcH,
        ],
        dest: [padLeft, padTop, padLeft + contentW, padTop + contentH],
    };
}
export function resolveMonitorGeometry(candidates) {
    const layoutManager = Main.layoutManager;
    for (const actor of candidates) {
        if (!actor || !isActorValid(actor))
            continue;
        const [width, height] = actor.get_size();
        if (!(width > 0 && height > 0))
            continue;
        const index = layoutManager.findIndexForActor(actor);
        if (index >= 0)
            return layoutManager.monitors[index] || layoutManager.primaryMonitor;
    }
    return layoutManager.monitors[layoutManager.primaryIndex] || layoutManager.primaryMonitor;
}
