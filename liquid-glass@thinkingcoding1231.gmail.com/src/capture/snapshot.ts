import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
export class SelfExcludingSnapshotCapture {
  private _content: any = null;
  private _rectGetter: () => [number, number, number, number];

  private _hideActors: Set<Clutter.Actor> = new Set();
  private _stage: Clutter.Stage;
  private _refCount: number = 0;
  private _afterPaintId: number = 0;
  private _destroyed: boolean = false;

  private static readonly FRAME_SKIP = 1;
  private _frameCounter: number = 0;

  private _label: string;
  private _failCount: number = 0;
  private _okCount: number = 0;

  private _activeCheck: (() => boolean) | null;

  constructor(
    stage: Clutter.Stage, hideActor: Clutter.Actor,
    rectGetter: () => [number, number, number, number],
    label: string = 'snapshot',
    activeCheck: (() => boolean) | null = null
  ) {
    this._stage = stage;
    this._label = label;
    this._activeCheck = activeCheck;
    if (hideActor) this._hideActors.add(hideActor);
    this._rectGetter = rectGetter;
    this._captureOnce();
    try {
      this._afterPaintId = (this._stage as any).connect('after-paint', () => {
        if (this._destroyed) return;
        this._frameCounter++;
        if (this._frameCounter % SelfExcludingSnapshotCapture.FRAME_SKIP !== 0) return;
        this._captureOnce();
      });
    } catch {
    }
  }

  retain(): void { this._refCount++; }
  release(): boolean {
    this._refCount--;
    if (this._refCount <= 0) { this.destroy(); return true; }
    return false;
  }

  addHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.add(actor);
  }

  removeHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.delete(actor);
  }

  private _report(kind: string, detail: string): void {
    this._failCount++;
    if (this._failCount <= 2 || this._failCount % 300 === 0) {
      console.warn(
        `[Liquid Glass][snapshot:${this._label}] ${kind} (failures=${this._failCount}, ` +
        `successes=${this._okCount}): ${detail}`
      );
    }
  }

  private _captureOnce(): void {
    if (this._activeCheck) {
      try {
        if (!this._activeCheck()) return;
      } catch {
        return;
      }
    }

    const [x, y, w, h] = this._rectGetter();
    if (w <= 0 || h <= 0) {
      this._report('empty capture rect', `x=${x} y=${y} w=${w} h=${h}`);
      return;
    }

    const hidden: Clutter.Actor[] = [];
    try {
      for (const actor of this._hideActors) {
        try {
          if (actor && actor.visible) {
            actor.hide();
            hidden.push(actor);
          }
        } catch { }
      }

      const rect = new Mtk.Rectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
      const scale = 1;

      const NO_CURSORS = (Clutter as any).PaintFlag?.NO_CURSORS ?? 0;
      const CLEAR = (Clutter as any).PaintFlag?.CLEAR ?? 0;
      const paintFlags = NO_CURSORS | CLEAR;
      const content = (this._stage as any).paint_to_content?.(rect, scale, null, paintFlags);
      if (content) {
        this._content = content;
        this._okCount++;
      } else {
        this._report('paint_to_content returned null',
          `rect=${rect.x},${rect.y} ${rect.width}x${rect.height}`);
      }
    } catch (e) {
      this._report('paint_to_content threw', `${e}`);
    } finally {
      for (const actor of hidden) {
        try { actor.show(); } catch { }
      }
    }
  }

  getContent(): any | null {
    return this._content;
  }

  destroy(): void {
    this._destroyed = true;
    if (this._afterPaintId) {
      try { (this._stage as any).disconnect(this._afterPaintId); } catch { }
      this._afterPaintId = 0;
    }
  }
}

const _selfExcludingSnapshotRegistry: Map<Clutter.Actor, SelfExcludingSnapshotCapture> = new Map();

export function acquireSelfExcludingSnapshot(
  sourceActor: Clutter.Actor,
  stage: Clutter.Stage,
  hideActor: Clutter.Actor,
  rectGetter: () => [number, number, number, number],
  label: string = 'bms'
): SelfExcludingSnapshotCapture {
  let cap = _selfExcludingSnapshotRegistry.get(sourceActor);
  if (!cap) {
    cap = new SelfExcludingSnapshotCapture(stage, hideActor, rectGetter, label);
    _selfExcludingSnapshotRegistry.set(sourceActor, cap);
  } else {
    cap.addHideActor(hideActor);
  }
  cap.retain();
  return cap;
}

export function releaseSelfExcludingSnapshot(sourceActor: Clutter.Actor, hideActor?: Clutter.Actor): void {
  const cap = _selfExcludingSnapshotRegistry.get(sourceActor);
  if (!cap) return;
  cap.removeHideActor(hideActor);
  if (cap.release()) {
    _selfExcludingSnapshotRegistry.delete(sourceActor);
  }
}
