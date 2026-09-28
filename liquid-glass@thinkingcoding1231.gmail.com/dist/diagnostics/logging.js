export let _utilsLogger = null;
export function setUtilsLogger(logger) {
    _utilsLogger = logger;
}
export function utilsLogEnabled() {
    return !!_utilsLogger && _utilsLogger.enabled !== false;
}
export function utilsLog(msg) {
    try {
        _utilsLogger?.log(msg);
    }
    catch (_) { }
}
const _frameLoopErrorLastLogged = new Map();
const FRAME_LOOP_ERROR_LOG_INTERVAL_MS = 5000;
export function reportFrameLoopError(tag, e) {
    try {
        const now = Date.now();
        const last = _frameLoopErrorLastLogged.get(tag) ?? 0;
        if (now - last < FRAME_LOOP_ERROR_LOG_INTERVAL_MS)
            return;
        _frameLoopErrorLastLogged.set(tag, now);
        console.error(`[Liquid Glass] exception in ${tag} frame sync (loop kept alive): ${e}`);
        const stack = e?.stack;
        if (stack)
            console.error(`[Liquid Glass] ${stack}`);
    }
    catch (_) { }
}
