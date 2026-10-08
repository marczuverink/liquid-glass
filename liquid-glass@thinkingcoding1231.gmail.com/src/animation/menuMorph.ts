// How a menu's glass grows out of its panel button and goes back into it, after
// the menu of liquid-dom's showcase. Opening, the button's glass slides to the
// middle of where the menu will be and shrinks into it, while the menu's glass,
// a small blob in the button at first, follows on a bouncier spring and swells
// to the menu's size, rounding off less and less. The two are drawn as one
// liquid. Closing runs it back and ends on the button's capsule.

// [x, y, w, h]
export type Rect = number[];

const STEP_S = 0.002;
const MAX_FRAME_S = 0.05;

class Spring {
  velocity = 0;
  target: number;

  constructor(public value: number, private _stiffness: number, private _damping: number) {
    this.target = value;
  }

  step(dt: number): void {
    const acc = -this._stiffness * (this.value - this.target) - this._damping * this.velocity;
    this.velocity += acc * dt;
    this.value += this.velocity * dt;
  }

  settled(within: number): boolean {
    return Math.abs(this.value - this.target) < within && Math.abs(this.velocity) < within * 10;
  }
}

// [stiffness, damping], unit mass, as liquid-dom's demo has them.
const BUTTON_OPEN_MOVE = [499, 22];
const BUTTON_CLOSE_MOVE = [90, 20];
const BUTTON_SCALE = [155, 24];
const BODY_OPEN_MOVE = [144, 14];
const BODY_CLOSE_MOVE = [130, 18];
const CONTENT_FADE = [137, 20];
// The demo throws the menu out and the button back at 2400 px/s over about
// 150 px; here the throw is that many times the distance, per second.
const THROW = 16;
// The button shrinks to this in the middle of the menu.
const BUTTON_OPEN_SCALE = 0.5;
// The menu's glass starts as a blob no wider than this (px), and its content
// twice its size.
const BLOB_MAX = 40;
const CONTENT_CLOSED_SCALE = 2;
const OPEN_SIZE_S = 0.3;
const CLOSE_SIZE_S = 0.25;
const RADIUS_S = 0.7;
const CONTENT_SCALE_S = 0.3;
// The content is seen through the glass as if it were deep inside it when
// the menu opens, and comes up to the surface over this long.
const LENS_S = 0.3;
// The closed glass fades over this long once it is back on the button.
const FADE_S = 0.15;
// Corners start (opening) and end (closing) this round, as a fraction of the
// largest the body allows.
const BLOB_ROUNDNESS = 0.8;

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (t: number, a: number, b: number) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return x => {
    if (x <= 0 || x >= 1) return Math.min(Math.max(x, 0), 1);
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(Math.max(t - (at(t, x1, x2) - x) / d, 0), 1);
    }
    return at(t, y1, y2);
  };
}

// Slow out of the button, then quick to the menu's size.
const openSize = cubicBezier(0.8, 0.3, 0.5, 0.8);
const easeOut = (t: number) => 1 - (1 - t) ** 2;

function clamp01(t: number): number {
  return Math.min(Math.max(t, 0), 1);
}

export interface MorphFrame {
  // The menu's glass and its corner radius.
  body: Rect;
  bodyRadius: number;
  // The button's glass, a capsule.
  button: Rect;
  // The menu's items: drawn around the body's centre at this scale and opacity.
  contentScale: number;
  contentOpacity: number;
  // How deep in the glass the content looks, 0 (at the surface) to 1.
  lens: number;
  glassOpacity: number;
  // Opening: at rest on the menu. Closing: faded out on the button.
  done: boolean;
}

export class MenuMorphMotion {
  private _t = 0;
  private _bodyX: Spring;
  private _bodyY: Spring;
  private _buttonX: Spring;
  private _buttonY: Spring;
  private _buttonScale: Spring;
  private _opacity: Spring;
  private _sizeFrom: number[];
  private _radiusFrom: number;
  private _contentFrom: number;
  private _lensFrom: number;
  private _fadeAt = -1;
  private _frame: MorphFrame;

  /**
   * Starts towards the menu (`opening`) or back to the button, from `from`
   * (the frame a reversed motion had got to) or from where that motion rests.
   */
  constructor(readonly opening: boolean, private _buttonRect: Rect, private _menu: Rect,
    private _menuRadius: number, from: MorphFrame | null = null, velocities: number[] | null = null) {
    const [bx, by, bw, bh] = _buttonRect;
    const blob = this._blob();
    const start: MorphFrame = from ?? (opening
      ? { body: [bx + bw / 2 - blob / 2, by + bh / 2 - blob / 2, blob, blob], bodyRadius: blob / 2,
        button: [..._buttonRect], contentScale: CONTENT_CLOSED_SCALE, contentOpacity: 0, lens: 1, glassOpacity: 1,
        done: false }
      : { body: [..._menu], bodyRadius: _menuRadius, button: this._buttonAt(centre(_menu), BUTTON_OPEN_SCALE),
        contentScale: 1, contentOpacity: 1, lens: 0, glassOpacity: 1, done: false });
    this._frame = start;

    const [bodyMove, buttonMove] = opening ? [BODY_OPEN_MOVE, BUTTON_OPEN_MOVE] : [BODY_CLOSE_MOVE, BUTTON_CLOSE_MOVE];
    const bc = centre(start.body), uc = centre(start.button);
    this._bodyX = new Spring(bc[0], bodyMove[0], bodyMove[1]);
    this._bodyY = new Spring(bc[1], bodyMove[0], bodyMove[1]);
    this._buttonX = new Spring(uc[0], buttonMove[0], buttonMove[1]);
    this._buttonY = new Spring(uc[1], buttonMove[0], buttonMove[1]);
    this._buttonScale = new Spring(start.button[3] / Math.max(bh, 1), BUTTON_SCALE[0], BUTTON_SCALE[1]);
    this._opacity = new Spring(start.contentOpacity, CONTENT_FADE[0], CONTENT_FADE[1]);
    if (velocities) {
      [this._bodyX.velocity, this._bodyY.velocity, this._buttonX.velocity, this._buttonY.velocity] = velocities;
    }
    this._sizeFrom = [start.body[2], start.body[3]];
    this._radiusFrom = from ? start.bodyRadius
      : opening ? BLOB_ROUNDNESS * Math.min(_menu[2], _menu[3]) / 2 : _menuRadius;
    this._contentFrom = start.contentScale;
    this._lensFrom = start.lens;
    this._aim();
    // Thrown: the menu's glass out of the button, the button's back to its place.
    if (!velocities) {
      const thrown = opening ? [this._bodyX, this._bodyY] : [this._buttonX, this._buttonY];
      for (const s of thrown) s.velocity = (s.target - s.value) * THROW;
    }
  }

  /** The springs' velocities, for a motion that reverses this one. */
  get velocities(): number[] {
    return [this._bodyX.velocity, this._bodyY.velocity, this._buttonX.velocity, this._buttonY.velocity];
  }

  get frame(): MorphFrame {
    return this._frame;
  }

  /** Where the button and the menu are now; they may move while it runs. */
  retarget(button: Rect, menu: Rect | null, menuRadius: number): void {
    this._buttonRect = button;
    if (menu) this._menu = menu;
    this._menuRadius = menuRadius;
    this._aim();
  }

  private _blob(): number {
    return Math.max(Math.min(this._buttonRect[2], this._buttonRect[3], BLOB_MAX), 1);
  }

  private _buttonAt(c: number[], scale: number): Rect {
    const w = this._buttonRect[2] * scale, h = this._buttonRect[3] * scale;
    return [c[0] - w / 2, c[1] - h / 2, w, h];
  }

  private _aim(): void {
    const home = centre(this._buttonRect), menu = centre(this._menu);
    const [bodyTo, buttonTo] = this.opening ? [menu, menu] : [home, home];
    [this._bodyX.target, this._bodyY.target] = bodyTo;
    [this._buttonX.target, this._buttonY.target] = buttonTo;
    this._buttonScale.target = this.opening ? BUTTON_OPEN_SCALE : 1;
    this._opacity.target = this.opening ? 1 : 0;
  }

  /** Advances by `elapsed` seconds. */
  step(elapsed: number): MorphFrame {
    const dt = Math.min(Math.max(elapsed, 0), MAX_FRAME_S);
    for (let t = 0; t < dt; t += STEP_S) {
      const h = Math.min(STEP_S, dt - t);
      for (const s of [this._bodyX, this._bodyY, this._buttonX, this._buttonY, this._buttonScale, this._opacity])
        s.step(h);
    }
    this._t += dt;
    const t = this._t;

    const blob = this._blob();
    const sizeTo = this.opening ? [this._menu[2], this._menu[3]] : [blob, blob];
    const k = this.opening ? openSize(clamp01(t / OPEN_SIZE_S)) : easeOut(clamp01(t / CLOSE_SIZE_S));
    const w = this._sizeFrom[0] + (sizeTo[0] - this._sizeFrom[0]) * k;
    const h = this._sizeFrom[1] + (sizeTo[1] - this._sizeFrom[1]) * k;
    const body = [this._bodyX.value - w / 2, this._bodyY.value - h / 2, w, h];

    const radiusTo = this.opening ? this._menuRadius : BLOB_ROUNDNESS * Math.min(...this._sizeFrom) / 2;
    const radius = this._radiusFrom + (radiusTo - this._radiusFrom) * easeOut(clamp01(t / RADIUS_S));

    const contentTo = this.opening ? 1 : CONTENT_CLOSED_SCALE;
    const contentScale = this._contentFrom + (contentTo - this._contentFrom) * easeOut(clamp01(t / CONTENT_SCALE_S));
    const lens = this.opening ? this._lensFrom * (1 - clamp01(t / LENS_S) ** 2) : 0;

    const moving = ![this._bodyX, this._bodyY, this._buttonX, this._buttonY].every(s => s.settled(0.5)) ||
      !this._buttonScale.settled(0.005);
    let glassOpacity = 1;
    let done = false;
    if (this.opening) {
      done = !moving && t >= Math.max(OPEN_SIZE_S, RADIUS_S);
    } else {
      if (this._fadeAt < 0 && !moving && t >= CLOSE_SIZE_S) this._fadeAt = t;
      if (this._fadeAt >= 0) {
        glassOpacity = 1 - clamp01((t - this._fadeAt) / FADE_S);
        done = glassOpacity === 0;
      }
    }

    this._frame = {
      body,
      bodyRadius: Math.min(radius, w / 2, h / 2),
      button: this._buttonAt([this._buttonX.value, this._buttonY.value], Math.max(this._buttonScale.value, 0.01)),
      contentScale,
      contentOpacity: clamp01(this._opacity.value),
      lens,
      glassOpacity,
      done,
    };
    return this._frame;
  }
}

function centre(r: Rect): number[] {
  return [r[0] + r[2] / 2, r[1] + r[3] / 2];
}
