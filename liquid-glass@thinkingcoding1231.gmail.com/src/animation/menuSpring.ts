const CLOSE_SPEED = 15.0;
const MAX_CLOSE_STEP_S = 0.033;
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

function stepClosing(scale: MenuSpring, pos: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const dt = Math.min(elapsedMs / 1000, MAX_CLOSE_STEP_S);
  const k = 1.0 - Math.exp(-CLOSE_SPEED * dt);
  scale.value += (0 - scale.value) * k;
  pos.value += (0 - pos.value) * k;
  if (scale.value < CLOSED_BELOW) return { s: 0, stopped: true };
  return { s: scale.value, stopped: false };
}

function stepOpening(scale: MenuSpring, pos: MenuSpring, elapsedMs: number): { s: number, stopped: boolean } {
  const settled = scale.update(elapsedMs) && pos.update(elapsedMs);
  const s = scale.value;
  if (Math.abs(1.0 - s) < OPEN_SNAP_DISTANCE && Math.abs(scale.velocity) < OPEN_SNAP_VELOCITY)
    return { s: 1.0, stopped: true };
  return { s, stopped: settled };
}

export function stepMenuSprings(scale: MenuSpring, pos: MenuSpring, elapsedMs: number): MenuFrame {
  const closing = scale.target === 0;
  const { s, stopped } = closing ? stepClosing(scale, pos, elapsedMs) : stepOpening(scale, pos, elapsedMs);
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
