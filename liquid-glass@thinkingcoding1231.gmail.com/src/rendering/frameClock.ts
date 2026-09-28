export let frameSerial = 0;
let _frameSerialStage: any = null;
let _frameSerialHandler = 0;

export function ensureFrameSerialHook(): boolean {
  if (_frameSerialHandler) return true;
  try {
    const stage = (globalThis as any).global?.stage;
    if (!stage) return false;
    _frameSerialStage = stage;
    _frameSerialHandler = stage.connect('after-paint', () => { frameSerial++; });
  } catch (e) {
    _frameSerialStage = null;
    _frameSerialHandler = 0;
  }
  return _frameSerialHandler !== 0;
}

export function frameSerialIsLive(): boolean {
  return _frameSerialHandler !== 0;
}

export function releaseFrameSerialHook(): void {
  if (!_frameSerialHandler) return;
  try { _frameSerialStage?.disconnect(_frameSerialHandler); } catch (e) { }
  _frameSerialStage = null;
  _frameSerialHandler = 0;
}
