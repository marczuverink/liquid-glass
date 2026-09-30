// Counts painted frames, so an effect can tell its first paint of a frame from
// a repeat. Repeats are the common case: every other glass that shows a
// window paints it again through a Clutter.Clone, and each repeat would redo a
// blur identical to the first one. 'after-paint' fires once per stage view, so
// each monitor's first paint still runs the full chain.
export let frameSerial = 0;
let _frameSerialHandler = 0;

export function ensureFrameSerialHook() {
    if (!_frameSerialHandler)
        _frameSerialHandler = global.stage.connect('after-paint', () => { frameSerial++; });
    return true;
}

// Blur reuse is gated on this: without the hook the serial never advances and
// every paint after the first would reuse a stale blur.
export function frameSerialIsLive() {
    return _frameSerialHandler !== 0;
}

export function releaseFrameSerialHook() {
    if (!_frameSerialHandler)
        return;
    global.stage.disconnect(_frameSerialHandler);
    _frameSerialHandler = 0;
}
