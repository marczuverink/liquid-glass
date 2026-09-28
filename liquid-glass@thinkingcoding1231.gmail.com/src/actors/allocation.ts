import Clutter from 'gi://Clutter';
import { isActorValid } from './lifecycle.js';
const _strandedFrames: WeakMap<Clutter.Actor, number> = new WeakMap();
const STRANDED_FRAMES_BEFORE_RESCUE = 3;

export function ensureWindowActorAllocated(
  actor: any,
  relayoutFrames: number,
  remapFrames: number
): '' | 'relayout' | 'remap' {
  try {
    if (!actor) return '';
    if (_windowActorRescueMode === 'off') return '';

    if (!actor.visible || !actor.mapped || actor.has_allocation()) {
      _windowActorStrandedFrames.delete(actor);
      return '';
    }

    const strandedFor = (_windowActorStrandedFrames.get(actor) ?? 0) + 1;
    _windowActorStrandedFrames.set(actor, strandedFor);

    if (_windowActorRescueMode !== 'remap' && strandedFor === relayoutFrames) {
      let ancestor: any = actor.get_parent();
      while (ancestor && isActorValid(ancestor) && !ancestor.has_allocation())
        ancestor = ancestor.get_parent();
      if (ancestor && isActorValid(ancestor)) {
        ancestor.queue_relayout();
        return 'relayout';
      }
    }

    if (strandedFor >= remapFrames) {
      _windowActorStrandedFrames.delete(actor);
      actor.hide();
      actor.show();
      return 'remap';
    }

    return '';
  } catch (_) {
    return '';
  }
}

const _windowActorStrandedFrames: Map<any, number> = new Map();

export type WindowActorRescueMode = 'two-stage' | 'remap' | 'off';
let _windowActorRescueMode: WindowActorRescueMode = 'two-stage';
const WINDOW_ACTOR_RESCUE_MODES: WindowActorRescueMode[] =
  ['two-stage', 'remap', 'off'];

export function setWindowActorRescueMode(mode: WindowActorRescueMode): void {
  _windowActorRescueMode =
    WINDOW_ACTOR_RESCUE_MODES.includes(mode) ? mode : 'two-stage';
}
export function getWindowActorRescueMode(): WindowActorRescueMode {
  return _windowActorRescueMode;
}

export function ensureGlassAllocated(
  actor: Clutter.Actor | null,
  framesBeforeRescue: number = STRANDED_FRAMES_BEFORE_RESCUE
): boolean {
  try {
    if (!actor) return false;

    if (!actor.visible || !actor.mapped || actor.has_allocation()) {
      _strandedFrames.delete(actor);
      return false;
    }

    const strandedFor = (_strandedFrames.get(actor) ?? 0) + 1;
    if (strandedFor < framesBeforeRescue) {
      _strandedFrames.set(actor, strandedFor);
      return false;
    }
    _strandedFrames.delete(actor);

    actor.hide();
    actor.show();
    return true;
  } catch (_) {
    return false;
  }
}

export function setActorVisible(actor: Clutter.Actor, visible: boolean): void {
  try {
    if (!actor) return;
    if (actor.visible === visible) return;
    actor.visible = visible;
    if (visible) {
      actor.queue_relayout();
      actor.get_parent()?.queue_relayout();
    }
  } catch (_) { }
}
