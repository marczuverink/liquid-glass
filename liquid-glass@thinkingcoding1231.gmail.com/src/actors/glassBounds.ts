import { setClipIfChanged } from './writes.js';

export const GLASS_CLIP_PADDING = 200;
export const GLASS_SHADOW_MAX_RADIUS = GLASS_CLIP_PADDING - 20;

export function placeScreenGlass(bgActor: any, liquidBox: any, x: number, y: number, screenW: number, screenH: number,
  clip: { x: number, y: number, w: number, h: number }, resetBoxClip: boolean): void {
  bgActor.remove_transition('size');
  bgActor.remove_transition('position');
  bgActor.set_position(x, y);
  bgActor.set_size(screenW, screenH);
  bgActor.remove_transition('size');
  bgActor.remove_transition('position');

  liquidBox?.set_position(0, 0);
  liquidBox?.set_size(screenW, screenH);
  if (resetBoxClip) liquidBox?.remove_clip();
  setClipIfChanged(bgActor,
    clip.x - GLASS_CLIP_PADDING, clip.y - GLASS_CLIP_PADDING,
    clip.w + GLASS_CLIP_PADDING * 2, clip.h + GLASS_CLIP_PADDING * 2);
}

export type OriginMemory = { _lastValidAnimAbsX?: number, _lastValidAnimAbsY?: number };

export function resolveGlassOrigin(actor: any, memory: OriginMemory, fallback: () => [number, number]): [number, number] {
  const [x, y] = actor.get_transformed_position();
  if (!Number.isNaN(x) && !Number.isNaN(y)) {
    memory._lastValidAnimAbsX = x;
    memory._lastValidAnimAbsY = y;
    return [x, y];
  }
  if (memory._lastValidAnimAbsX !== undefined && memory._lastValidAnimAbsY !== undefined)
    return [memory._lastValidAnimAbsX, memory._lastValidAnimAbsY];
  return fallback();
}

export function applyGlassScale(effect: any, cornerRadius: number, scaleX: number, scaleY: number): void {
  if (!effect || typeof effect.setCornerRadius !== 'function') return;
  const currentScale = Math.min(scaleX, scaleY);
  effect.setCornerRadius(cornerRadius * currentScale);
  if (typeof effect.setAnimationScale === 'function') effect.setAnimationScale(currentScale);
}
