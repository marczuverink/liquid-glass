import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
/**
 * Snapshots a screen rectangle (the top panel) into a Clutter.Content, for the
 * blurred-panel backdrop inside the glass.
 *
 * Blur My Shell blurs the panel with a native effect that expects to be the
 * only consumer of its actor's paint; cloning that actor takes the blur away
 * from the real panel. paint_to_content() instead renders the stage rect into
 * a separate buffer, synchronously and outside the displayed frame, so every
 * glass root can be hidden for the duration: the glass never captures itself
 * (which would nest the capture into itself frame after frame) and nothing
 * flickers. NO_CURSORS keeps the pointer out, as the shell's own screenshots do.
 */
export class SelfExcludingSnapshotCapture {
  private _content: any = null;
  private _rectGetter: () => [number, number, number, number];

  private _hideActors: Set<Clutter.Actor> = new Set();
  private _stage: Clutter.Stage;
  private _refCount: number = 0;
  private _afterPaintId: number = 0;

  // Re-captured after every stage paint, so it only costs anything while the
  // screen changes. Raise FRAME_SKIP to capture every Nth frame instead.
  private static readonly FRAME_SKIP = 1;
  private _frameCounter: number = 0;

  private _label: string;
  private _failCount: number = 0;
  private _okCount: number = 0;

  // While this returns false the capture is dormant (e.g. its popup is
  // closed) and costs nothing.
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
    this._afterPaintId = this._stage.connect('after-paint', () => {
      this._frameCounter++;
      if (this._frameCounter % SelfExcludingSnapshotCapture.FRAME_SKIP !== 0) return;
      this._captureOnce();
    });
  }

  retain(): void { this._refCount++; }
  release(): boolean {
    this._refCount--;
    if (this._refCount <= 0) { this.destroy(); return true; }
    return false;
  }

  /** Registers another Liquid Glass instance's root as needing to be hidden during capture. */
  addHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.add(actor);
  }

  /** Unregisters a previously-added hide actor (called when that instance releases the capture). */
  removeHideActor(actor: Clutter.Actor | null | undefined): void {
    if (actor) this._hideActors.delete(actor);
  }

  // A failed capture otherwise looks like a working one (the glass just shows
  // the layers below), so report the first two failures and every 300th.
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
    if (this._activeCheck && !this._activeCheck()) return;

    const [x, y, w, h] = this._rectGetter();
    if (w <= 0 || h <= 0) {
      this._report('empty capture rect', `x=${x} y=${y} w=${w} h=${h}`);
      return;
    }

    // Hide every registered glass root, so a shared capture contains none of them.
    const hidden: Clutter.Actor[] = [];
    try {
      this._hideCaptureActors(hidden);

      const rect = new Mtk.Rectangle({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
      const scale = 1;

      // A null color state is the default colour space. Without CLEAR the
      // new texture keeps undefined contents wherever the stage paints nothing.
      const paintFlags = Clutter.PaintFlag.NO_CURSORS | Clutter.PaintFlag.CLEAR;
      const content = this._stage.paint_to_content(rect, scale, null, paintFlags);
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
      for (const actor of hidden)
        actor.show();
    }
  }

  private _hideCaptureActors(hidden: Clutter.Actor[]): void {
    for (const actor of this._hideActors) {
      if (actor.visible) {
        actor.hide();
        hidden.push(actor);
      }
    }
  }

  getContent(): any | null {
    return this._content;
  }

  destroy(): void {
    if (this._afterPaintId) {
      this._stage.disconnect(this._afterPaintId);
      this._afterPaintId = 0;
    }
  }
}

// Glasses that capture the same Blur My Shell target share one capture.
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
