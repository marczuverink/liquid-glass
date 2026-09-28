export class GlassGeometry {
  constructor(private _uniforms: ReadonlyMap<string, number>) {
    this.blurEnabled = GlassGeometry.USE_BLUR_RECT;
    this.compositeEnabled = GlassGeometry.USE_COMPOSITE_RECT;
  }

  public rect: number[] = [0, 0, 0, 0];
  public regions: number[][] = [];
  public multiRegion: boolean = false;

  public blurEnabled: boolean;

  public compositeEnabled: boolean;

  static USE_BLUR_RECT = true;

  static BLUR_RECT_MIN_MARGIN = 12;

  static BLUR_RECT_MIN_SAVING = 0.95;

  static BLUR_RECT_QUANTUM = 64;

  static CAPTURE_CLIP_EXTRA_MARGIN = 24;

  static CAPTURE_CLIP_MIN_SAVING = 0.85;

  static USE_COMPOSITE_RECT = true;

  static COMPOSITE_RECT_MIN_SAVING = 0.95;

  compositeRect(): number[] | null {
    if (!this.compositeEnabled) return null;

    if ((this._uniforms.get('debug_view') ?? 0) > 0.5) return null;

    const resW = this._uniforms.get('resolution_x') ?? 0;
    const resH = this._uniforms.get('resolution_y') ?? 0;
    if (!(resW >= 1) || !(resH >= 1)) return null;

    const body = this._glassBodyUnion();
    if (!body) return null;
    let [x0, y0, x1, y1] = body;

    const shadowMax = Math.max(this._uniforms.get('shadow_max_radius') ?? 0, 5);
    const shadowRadius = Math.max(this._uniforms.get('shadow_radius') ?? 0, 0);
    const shadowIntensity = this._uniforms.get('shadow_intensity') ?? 0;
    const reach = (this.multiRegion || !(shadowIntensity > 0))
      ? 0
      : Math.min(shadowRadius, shadowMax);

    const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
    const m = Math.ceil(reach + feather + 2);

    x0 -= m; y0 -= m; x1 += m; y1 += m;

    if ((this._uniforms.get('panel_bg_a') ?? 0) > 0) {
      const px = this._uniforms.get('panel_rect_x') ?? 0;
      const py = this._uniforms.get('panel_rect_y') ?? 0;
      const pw = this._uniforms.get('panel_rect_w') ?? 0;
      const ph = this._uniforms.get('panel_rect_h') ?? 0;
      if (pw > 0 && ph > 0) {
        x0 = Math.min(x0, px - 2); y0 = Math.min(y0, py - 2);
        x1 = Math.max(x1, px + pw + 2); y1 = Math.max(y1, py + ph + 2);
      }
    }

    const maxW = Math.round(resW);
    const maxH = Math.round(resH);
    const bx = Math.max(0, Math.floor(x0));
    const by = Math.max(0, Math.floor(y0));
    const bw = Math.min(maxW, Math.ceil(x1)) - bx;
    const bh = Math.min(maxH, Math.ceil(y1)) - by;
    if (!(bw >= 2) || !(bh >= 2)) return null;
    if (bw * bh >= maxW * maxH * GlassGeometry.COMPOSITE_RECT_MIN_SAVING) return null;

    return [bx, by, bw, bh];
  }

  private _glassBodyUnion(): number[] | null {
    const pad = Math.max(this._uniforms.get('padding') ?? 0, 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const rects = this.multiRegion ? this.regions : [this.rect];
    for (const r of rects) {
      const [rx, ry, rw, rh] = r;
      if (!(rw > 0) || !(rh > 0)) continue;
      const ix = Math.min(pad, Math.max(rw / 2 - 1, 0));
      const iy = Math.min(pad, Math.max(rh / 2 - 1, 0));
      if (rx + ix < x0) x0 = rx + ix;
      if (ry + iy < y0) y0 = ry + iy;
      if (rx + rw - ix > x1) x1 = rx + rw - ix;
      if (ry + rh - iy > y1) y1 = ry + rh - iy;
    }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return [x0, y0, x1, y1];
  }

  captureClip(radius: number): number[] | null {
    const resW = this._uniforms.get('resolution_x') ?? 0;
    const resH = this._uniforms.get('resolution_y') ?? 0;
    if (!(resW >= 1) || !(resH >= 1)) return null;

    const body = this._glassBodyUnion();
    if (!body) return null;
    const [x0, y0, x1, y1] = body;

    const ior = this._uniforms.get('ior') ?? 1.5;
    const dispScale = this._uniforms.get('displacement_scale') ?? 0;
    const eta = 1.0 / Math.max(ior, 1.001);
    const bend = Math.min(eta / Math.sqrt(Math.max(1 - eta * eta, 1e-6)), 1 / 0.15);
    const minRes = Math.max(Math.min(resW, resH), 1);
    const dispUV = Math.min(0.30, bend * Math.max(dispScale, 0) / minRes);

    const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
    const blurReach = 3 * Math.max(Math.min(radius, 30), 0);
    const extra = GlassGeometry.BLUR_RECT_MIN_MARGIN + feather + 2.5 +
      blurReach + GlassGeometry.CAPTURE_CLIP_EXTRA_MARGIN;

    const mx = Math.ceil(dispUV * resW + extra);
    const my = Math.ceil(dispUV * resH + extra);

    const maxW = Math.round(resW);
    const maxH = Math.round(resH);
    let cx = Math.max(0, Math.floor(x0 - mx));
    let cy = Math.max(0, Math.floor(y0 - my));
    let cw = Math.min(maxW, Math.ceil(x1 + mx)) - cx;
    let ch = Math.min(maxH, Math.ceil(y1 + my)) - cy;
    if (!(cw >= 2) || !(ch >= 2)) return null;

    const q = GlassGeometry.BLUR_RECT_QUANTUM;
    cw = Math.min(maxW, Math.ceil(cw / q) * q);
    ch = Math.min(maxH, Math.ceil(ch / q) * q);
    cx = Math.max(0, Math.min(cx, maxW - cw));
    cy = Math.max(0, Math.min(cy, maxH - ch));

    if (cw * ch >= resW * resH * GlassGeometry.CAPTURE_CLIP_MIN_SAVING) return null;

    return [cx, cy, cw, ch];
  }

  blurRect(): number[] | null {
    if (!this.blurEnabled) return null;

    const resW = this._uniforms.get('resolution_x') ?? 0;
    const resH = this._uniforms.get('resolution_y') ?? 0;
    if (!(resW >= 1) || !(resH >= 1)) return null;

    const body = this._glassBodyUnion();
    if (!body) return null;
    const [x0, y0, x1, y1] = body;

    const ior = this._uniforms.get('ior') ?? 1.5;
    const dispScale = this._uniforms.get('displacement_scale') ?? 0;
    const eta = 1.0 / Math.max(ior, 1.001);
    const bend = Math.min(eta / Math.sqrt(Math.max(1 - eta * eta, 1e-6)), 1 / 0.15);
    const minRes = Math.max(Math.min(resW, resH), 1);
    const dispUV = Math.min(0.30, bend * Math.max(dispScale, 0) / minRes);
    const dispX = dispUV * resW;
    const dispY = dispUV * resH;

    const feather = Math.max(this._uniforms.get('edge_smoothing') ?? 0, 0.75);
    const extra = GlassGeometry.BLUR_RECT_MIN_MARGIN + feather + 2.5;

    const mx = Math.ceil(dispX + extra);
    const my = Math.ceil(dispY + extra);

    const maxW = Math.round(resW);
    const maxH = Math.round(resH);
    let bx = Math.max(0, Math.floor(x0 - mx));
    let by = Math.max(0, Math.floor(y0 - my));
    let bw = Math.min(maxW, Math.ceil(x1 + mx)) - bx;
    let bh = Math.min(maxH, Math.ceil(y1 + my)) - by;
    if (!(bw >= 2) || !(bh >= 2)) return null;

    const q = GlassGeometry.BLUR_RECT_QUANTUM;
    bw = Math.min(maxW, Math.ceil(bw / q) * q);
    bh = Math.min(maxH, Math.ceil(bh / q) * q);
    bx = Math.max(0, Math.min(bx, maxW - bw));
    by = Math.max(0, Math.min(by, maxH - bh));

    if (bw * bh >= resW * resH * GlassGeometry.BLUR_RECT_MIN_SAVING) return null;

    return [bx, by, bw, bh];
  }
}
