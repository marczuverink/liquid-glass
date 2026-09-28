import { MAX_STEP_S } from './spring.js';

const CLOSE_SPEED = 15.0;
const CLOSED_BELOW = 0.005;
const OPEN_SNAP_DISTANCE = 0.002;
const OPEN_SNAP_VELOCITY = 0.03;

export interface MenuSpring {
  value: number;
  velocity: number;
  target: number;
  update(elapsedMs: number): boolean;
}

export interface MenuFrame {
  closing: boolean;
  stopped: boolean;
  scale: number;
  opacity: number;
}

function clampOpacity(v: number): number {
  return Math.min(255, Math.max(0, v));
}

// Use a simple exponential decay for closing (faster, no bounce)
function stepClosing(scale: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const dt = Math.min(elapsedMs / 1000, MAX_STEP_S);
  const k = 1.0 - Math.exp(-CLOSE_SPEED * dt);
  scale.value += (0 - scale.value) * k;
  // Stop animation completely when it's virtually invisible
  if (scale.value < CLOSED_BELOW) return { s: 0, stopped: true };
  return { s: scale.value, stopped: false };
}

// Use Hooke's law spring physics for opening (creates a nice bounce effect)
function stepOpening(scale: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const settled = scale.update(elapsedMs);
  const s = scale.value;
  // Magnet effect: Snap to exactly 1.0 when the bounce is almost settled.
  // This prevents indefinite micro-stuttering at the end of the animation.
  if (Math.abs(1.0 - s) < OPEN_SNAP_DISTANCE && Math.abs(scale.velocity) < OPEN_SNAP_VELOCITY)
    return { s: 1.0, stopped: true };
  return { s, stopped: settled };
}

export function stepMenuSpring(scale: MenuSpring, elapsedMs: number): MenuFrame {
  const closing = scale.target === 0;
  const { s, stopped } = closing ? stepClosing(scale, elapsedMs) : stepOpening(scale, elapsedMs);
  // Clamp to 0.001 because scale = 0 crashes Cogl. Fade out opacity faster
  // than the scale shrinks (fades between scale 1.0 and 0.3).
  if (closing)
    return { closing, stopped, scale: Math.max(0.001, s), opacity: clampOpacity((s - 0.3) / 0.7 * 255) };
  return { closing, stopped, scale: 0.2 + s * 0.8, opacity: clampOpacity((s / 0.3) * 255) };
}

export function applyMenuFrame(frame: MenuFrame, animActor: any, bgActor: any, menuActor: any, sync: () => void): void {
  animActor.set_scale(frame.scale, frame.scale);
  bgActor.opacity = frame.opacity;
  animActor.opacity = frame.opacity;
  sync();
  if (!frame.stopped) return;
  if (frame.closing) {
    if (!menuActor) return;
    // Tell GNOME the menu is officially closed
    menuActor.hide();
    bgActor.opacity = 0;
    animActor.opacity = 0;
    return;
  }
  animActor.set_scale(1.0, 1.0);
  animActor.opacity = 255;
  bgActor.opacity = 255;
  sync();
}

export function showMenuAtRest(bgActor: any, animActor: any): void {
  if (!bgActor) return;
  bgActor.remove_all_transitions();
  bgActor.opacity = 255;
  bgActor.set_scale(1.0, 1.0);
  if (!animActor) return;
  animActor.set_scale(1.0, 1.0);
  animActor.opacity = 255;
}
