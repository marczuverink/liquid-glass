import Clutter from 'gi://Clutter';
import { UILayerSampler } from './uiLayerSampler.js';
import { WindowCloneManager } from './windowClones.js';
import { isActorValid } from '../actors/lifecycle.js';
import { isCaptureClipEnabled, isCloneCullEnabled, isCullSiteEnabled, GlassRect } from './options.js';
import { unionRectInto, rectsIntersect } from '../actors/geometry.js';
import { setClipIfChanged } from '../actors/writes.js';
/**
 * Per-frame update of the capture clip and the clone cull rect. Call it after
 * the effect's geometry is set for this frame and before the samplers sync,
 * so they cull against this frame's rect.
 *
 * The effect works in shader space (liquidBox-local pixels); the clones are
 * positioned in screen space. The two differ by the glass's screen origin,
 * passed as originX/originY. The clone container's own transform is identity,
 * so its local space is shader space.
 */
export function syncGlassCaptureClip(opts: {
  /** The actor holding bgClone / windowClones / uiClones. */
  cloneContainer: Clutter.Actor | null,
  /** The LiquidEffect driving this glass. */
  effect: any,
  /** Screen position of shader-space (0, 0), i.e. of the glass's bgActor. */
  originX: number,
  originY: number,
  uiSampler?: UILayerSampler | null,
  windowCloneManager?: WindowCloneManager | null,
}): void {
  const { cloneContainer, effect, originX, originY } = opts;
  const uiSampler = opts.uiSampler ?? null;
  const windowCloneManager = opts.windowCloneManager ?? null;

  const clear = () => {
    if (cloneContainer && isActorValid(cloneContainer) &&
        (cloneContainer as any)._lgClipW !== undefined) {
      (cloneContainer as any)._lgClipX = undefined;
      (cloneContainer as any)._lgClipY = undefined;
      (cloneContainer as any)._lgClipW = undefined;
      (cloneContainer as any)._lgClipH = undefined;
      cloneContainer.remove_clip();
    }
    uiSampler?.setCullRect(null);
    windowCloneManager?.setCullRect(null);
    windowCloneManager?.applyBgCloneClip(null);
    if (effect) {
      effect._lgCaptureClip = null;
      effect._lgCaptureScreenRect = null;
    }
  };

  if (!isCaptureClipEnabled() && !isCloneCullEnabled()) { clear(); return; }
  if (!effect) { clear(); return; }

  const r = effect.getCaptureClipRect();
  if (!r) { clear(); return; }
  const rect: GlassRect = [r[0], r[1], r[2], r[3]];

  // A Blur My Shell replica that has not been measured yet: skip one frame
  // rather than clip the panel band away.
  if (uiSampler?.hasUnmeasuredBmsReplica()) { clear(); return; }

  // Widen to cover each Blur My Shell replica the glass can reach. Its
  // background blur reads the whole panel rect, and any part left unpainted
  // is smeared across the panel as transparency. Replicas out of reach add no
  // visible pixel, so they stay out of the rect and are culled.
  const bmsRects = uiSampler?.getBmsScreenRects() ?? [];
  const ownRect: GlassRect = [rect[0], rect[1], rect[2], rect[3]];
  for (const b of bmsRects) {
    const local: GlassRect = [b[0] - originX, b[1] - originY, b[2], b[3]];
    if (!isCullSiteEnabled('bms') || rectsIntersect(local[0], local[1], local[2], local[3], ownRect))
      unionRectInto(rect, local);
  }

  const [resW, resH] = effect.getResolution();
  if (resW >= 1 && resH >= 1) {
    const x1 = Math.min(resW, rect[0] + rect[2]);
    const y1 = Math.min(resH, rect[1] + rect[3]);
    rect[0] = Math.max(0, rect[0]);
    rect[1] = Math.max(0, rect[1]);
    rect[2] = x1 - rect[0];
    rect[3] = y1 - rect[1];
    if (!(rect[2] >= 2) || !(rect[3] >= 2)) { clear(); return; }
  }

  applyCaptureClip(cloneContainer, rect);

  // Shown by global._lgGlass.cullReport().
  effect._lgCaptureClip = rect.slice();

  const screenRect: GlassRect = [rect[0] + originX, rect[1] + originY, rect[2], rect[3]];

  // The wallpaper clone is not under cloneContainer and is clipped in screen space.
  windowCloneManager?.applyBgCloneClip(isCaptureClipEnabled() ? screenRect : null);

  uiSampler?.setCullRect(screenRect);
  windowCloneManager?.setCullRect(screenRect);
  // A window glass painted through a clone inside this capture clamps its
  // composite to the same rect (rendering/nestedRoi.ts).
  effect._lgCaptureScreenRect = screenRect;
}

function applyCaptureClip(cloneContainer: Clutter.Actor | null, rect: GlassRect): void {
  if (isCaptureClipEnabled() && cloneContainer && isActorValid(cloneContainer)) {
    setClipIfChanged(cloneContainer, rect[0], rect[1], rect[2], rect[3]);
  } else if (cloneContainer && isActorValid(cloneContainer) &&
             (cloneContainer as any)._lgClipW !== undefined) {
    (cloneContainer as any)._lgClipW = undefined;
    cloneContainer.remove_clip();
  }
}
