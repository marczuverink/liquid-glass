
export const SAME_FRAME_WINDOW_US = 4000;

let _frameSyncFrozen = false;

export function setFrameSyncFrozen(frozen: boolean): void {
  _frameSyncFrozen = !!frozen;
}

export function isFrameSyncFrozen(): boolean {
  return _frameSyncFrozen;
}
