import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { reportFrameLoopError } from '../diagnostics/logging.js';
import { isFrameSyncFrozen } from './frameSync.js';

export type IdSlot = { get(): number; set(id: number): void };

export function addBeforeRedraw(callback: GLib.SourceFunc): number {
  return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
}

export function removeBeforeRedraw(id: number): void {
  if (!id) return;
  global.compositor.get_laters().remove(id);
}

export type LaterLoop = {
  alive: () => boolean;
  step: () => void;
  errorTag: string;
  honourFreeze?: boolean;
};

// A self-rescheduling BEFORE_REDRAW chain. The next tick is scheduled before
// step() runs, so an exception in step() is reported (rate-limited) instead of
// silently ending the chain and freezing the glass.
export function startLaterLoop(slot: IdSlot, loop: LaterLoop): boolean {
  if (slot.get() !== 0) return false;
  const tick = (): boolean => {
    slot.set(0);
    if (!loop.alive()) return GLib.SOURCE_REMOVE;
    slot.set(addBeforeRedraw(tick));
    if (loop.honourFreeze && isFrameSyncFrozen()) return GLib.SOURCE_REMOVE;
    try {
      loop.step();
    } catch (e) {
      reportFrameLoopError(loop.errorTag, e);
    }
    return GLib.SOURCE_REMOVE;
  };
  slot.set(addBeforeRedraw(tick));
  return true;
}

export function stopLaterLoop(slot: IdSlot): void {
  const id = slot.get();
  slot.set(0);
  removeBeforeRedraw(id);
}

// Follows the stage's own frames instead of requesting them, so an idle
// desktop does not keep the frame clock running. `first` covers the frame in
// which the loop starts.
export function startStageLoop(signal: IdSlot, first: IdSlot, tick: () => void): boolean {
  if (signal.get() !== 0) return false;
  signal.set(global.stage.connect('before-update', tick));
  first.set(addBeforeRedraw(() => {
    first.set(0);
    tick();
    return GLib.SOURCE_REMOVE;
  }));
  return true;
}

export function stopStageLoop(signal: IdSlot, first: IdSlot): void {
  const signalId = signal.get();
  signal.set(0);
  if (signalId) global.stage.disconnect(signalId);
  stopLaterLoop(first);
}
