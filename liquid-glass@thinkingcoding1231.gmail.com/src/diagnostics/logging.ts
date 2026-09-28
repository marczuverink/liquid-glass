
type UtilsLogger = { log: (...args: any[]) => void, readonly enabled?: boolean };
export let _utilsLogger: UtilsLogger | null = null;
export function setUtilsLogger(logger: UtilsLogger | null): void {
  _utilsLogger = logger;
}
export function utilsLogEnabled(): boolean {
  return !!_utilsLogger && _utilsLogger.enabled !== false;
}
export function utilsLog(msg: string): void {
  try { _utilsLogger?.log(msg); } catch { }
}

const _frameLoopErrorLastLogged: Map<string, number> = new Map();
const FRAME_LOOP_ERROR_LOG_INTERVAL_MS = 5000;
export function reportFrameLoopError(tag: string, e: unknown): void {
  try {
    const now = Date.now();
    const last = _frameLoopErrorLastLogged.get(tag) ?? 0;
    if (now - last < FRAME_LOOP_ERROR_LOG_INTERVAL_MS) return;
    _frameLoopErrorLastLogged.set(tag, now);
    console.error(`[Liquid Glass] exception in ${tag} frame sync (loop kept alive): ${e}`);
    const stack = (e as any)?.stack;
    if (stack) console.error(`[Liquid Glass] ${stack}`);
  } catch { }
}
