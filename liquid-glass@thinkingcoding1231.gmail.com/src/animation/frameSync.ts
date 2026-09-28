
export const SAME_FRAME_WINDOW_US = 4000;

// ─── [DIAG] Frame-sync freeze ────────────────────────────────────────────────
//
// Every manager re-syncs its geometry and its clones on every frame while its
// target is mapped. That used to be a self-rescheduling
// Meta.LaterType.BEFORE_REDRAW chain, i.e. a poll, not an event: the dock's
// glass was measured running vfunc_paint_target 119 times in 2.0s (= 59.5/s)
// with the desktop sitting still. The dock and window glass now follow the
// stage's own frames instead (startStageLoop() in frameLoops.ts), so an idle
// desktop no longer asks for any.
//
// This switch makes every tick do nothing. It does NOT stop the loops — so if
// the GPU load collapses, the cost is the per-frame sync work and the repaint
// it dirties into existence. If the load barely moves, the cost is elsewhere.
//
// Diagnostic only: while frozen the glass stops following anything that moves.
// global._lgGlass.freezeSync(true) / (false).
let _frameSyncFrozen = false;

export function setFrameSyncFrozen(frozen: boolean): void {
  _frameSyncFrozen = !!frozen;
}

export function isFrameSyncFrozen(): boolean {
  return _frameSyncFrozen;
}
