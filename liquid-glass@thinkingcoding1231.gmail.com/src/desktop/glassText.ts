// The outline of a line of text as a signed distance field, for glass whose
// shape is the text itself (the glass clock).
//
// GJS cannot read a Cairo surface's pixels or a texture's back, so each glyph
// is drawn (with Pango, or from a font file the extension ships) into a Cairo
// surface that is written to a PNG and decoded here. Glyphs are measured once
// per font and kept: a new time only places the cached fields side by side.
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'cairo';

import { coglContext } from '../shellVersion.js';
import { type TrueTypeFont, traceGlyph } from './trueType.js';

// Glyphs are drawn this many times larger and their fields scaled down, for
// sub-pixel accurate edges.
const SUPERSAMPLE = 2;

/** Signed distances in px (negative inside), `width` x `height`. */
export interface DistanceField {
  data: Float32Array;
  width: number;
  height: number;
}

interface GlyphField extends DistanceField {
  // Where the glyph's layout origin is in the field.
  originX: number;
  originY: number;
}

// PNG decoding (8-bit, not interlaced: what Cairo writes)

function readU32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function inflate(data: Uint8Array): Uint8Array {
  const converter = new Gio.ZlibDecompressor({ format: Gio.ZlibCompressorFormat.ZLIB });
  const input = new Gio.ConverterInputStream({
    base_stream: Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(data)),
    converter,
  });
  const output = Gio.MemoryOutputStream.new_resizable();
  output.splice(input, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET, null);
  return output.steal_as_bytes().toArray();
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The coverage (alpha, 0-255) of every pixel of a PNG. */
export function decodePngAlpha(png: Uint8Array): { alpha: Uint8Array, width: number, height: number } {
  let pos = 8;
  let width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
  const chunks: Uint8Array[] = [];
  while (pos + 8 <= png.length) {
    const length = readU32(png, pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = readU32(body, 0);
      height = readU32(body, 4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      chunks.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (depth !== 8 || interlace !== 0 || !channels || !width || !height)
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`);

  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  const raw = inflate(joined);
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[dst + x - channels] : 0;
      const b = y > 0 ? rows[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? rows[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      rows[dst + x] = (filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1)
        : filter === 4 ? v + paeth(a, b, c) : v) & 255;
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++)
    alpha[i] = channels === 4 ? rows[i * 4 + 3] : channels === 2 ? rows[i * 2 + 1] : rows[i * channels];
  return { alpha, width, height };
}

// Distance transform

const INF = 1e20;

// How far (px) the edge is from a pixel's centre, positive when the centre is
// outside, from its coverage `a` (0 to 1) and the coverage's gradient: the
// edge is taken to be straight across the pixel (Gustavson's anti-aliased
// distance transform).
function edgeOffset(gx: number, gy: number, a: number): number {
  if (gx === 0 || gy === 0) return 0.5 - a;
  const len = Math.hypot(gx, gy);
  let x = Math.abs(gx) / len, y = Math.abs(gy) / len;
  if (x < y) [x, y] = [y, x];
  const a1 = 0.5 * y / x;
  if (a < a1) return 0.5 * (x + y) - Math.sqrt(2 * x * y * a);
  if (a < 1 - a1) return (0.5 - a) * x;
  return -0.5 * (x + y) + Math.sqrt(2 * x * y * (1 - a));
}

// Signed distances (px, negative inside) from coverage (0-255), the piece of
// edge each pixel is nearest (the index of the pixel it crosses, or -1), and
// each piece's normal (into the glyph). Every pixel the outline crosses gets
// the short piece of edge that crosses it, placed to a fraction of a pixel
// from its coverage; every other
// pixel takes the nearest of those pieces from its neighbours. Distances to
// pixel centres instead would follow the pixels' staircase, which the glass
// shows as facets along a curve.
function edgeField(alpha: Uint8Array, w: number, h: number):
  { signed: Float32Array, nearest: Int32Array, nx: Float32Array, ny: Float32Array } {
  const n = w * h;
  const cov = new Float32Array(n);
  for (let i = 0; i < n; i++) cov[i] = alpha[i] / 255;
  const at = (x: number, y: number) => cov[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];
  // Each piece of edge: its middle, its normal (into the glyph) and half its length.
  const ex = new Float32Array(n);
  const ey = new Float32Array(n);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const half = new Float32Array(n);
  const nearest = new Int32Array(n).fill(-1);
  const dist2 = new Float32Array(n).fill(INF);

  const squaredDistanceTo = (x: number, y: number, e: number) => {
    const dx = x - ex[e], dy = y - ey[e];
    const across = dx * nx[e] + dy * ny[e];
    const along = Math.max(Math.abs(dy * nx[e] - dx * ny[e]) - half[e], 0);
    return across * across + along * along;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = cov[i];
      // The edge runs through this pixel, or right between it and a neighbour
      // covered the other way. A whole pixel next to a partly covered one
      // says little about where the edge is; the partly covered one does.
      const other = 1 - a;
      const crossed = (a > 0 && a < 1) || (x > 0 && cov[i - 1] === other) || (x < w - 1 && cov[i + 1] === other) ||
        (y > 0 && cov[i - w] === other) || (y < h - 1 && cov[i + w] === other);
      if (!crossed) continue;
      // Sobel, pointing into the glyph.
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const len = Math.hypot(gx, gy);
      if (len === 0) continue;
      const off = edgeOffset(gx, gy, a);
      nx[i] = gx / len;
      ny[i] = gy / len;
      ex[i] = x + nx[i] * off;
      ey[i] = y + ny[i] * off;
      half[i] = 0.5 / Math.max(Math.abs(nx[i]), Math.abs(ny[i]));
      nearest[i] = i;
      dist2[i] = squaredDistanceTo(x, y, i);
    }
  }

  const take = (i: number, x: number, y: number, j: number) => {
    const e = nearest[j];
    if (e < 0 || e === nearest[i]) return;
    const d = squaredDistanceTo(x, y, e);
    if (d < dist2[i]) {
      dist2[i] = d;
      nearest[i] = e;
    }
  };
  // A sweep down and one back up over the 8 neighbours.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) take(i, x, y, i - 1);
      if (y > 0) {
        if (x > 0) take(i, x, y, i - w - 1);
        take(i, x, y, i - w);
        if (x < w - 1) take(i, x, y, i - w + 1);
      }
    }
    for (let x = w - 2; x >= 0; x--) take(y * w + x, x, y, y * w + x + 1);
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) take(i, x, y, i + 1);
      if (y < h - 1) {
        if (x < w - 1) take(i, x, y, i + w + 1);
        take(i, x, y, i + w);
        if (x > 0) take(i, x, y, i + w - 1);
      }
    }
    for (let x = 1; x < w; x++) take(y * w + x, x, y, y * w + x - 1);
  }

  const signed = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) signed[i] = (alpha[i] >= 128 ? -1 : 1) * Math.sqrt(dist2[i]);
  return { signed, nearest, nx, ny };
}

/** Signed distances (px, negative inside) from coverage (0-255); see edgeField(). */
export function signedDistances(alpha: Uint8Array, w: number, h: number): Float32Array {
  return edgeField(alpha, w, h).signed;
}

// The box widths for three box blurs that together approximate a Gaussian of `sigma`.
function boxRadii(sigma: number): number[] {
  const ideal = Math.sqrt(4 * sigma * sigma + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  return [0, 1, 2].map(i => ((i < m ? lower : upper) - 1) / 2);
}

// One box blur of radius r along rows (step 1) or columns (step w), edges extended.
function boxBlur(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, alongRows: boolean): void {
  const [n, lines, step, lineStep] = alongRows ? [w, h, 1, w] : [h, w, w, 1];
  const norm = 1 / (2 * r + 1);
  const last = (n - 1) * step;
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    const first = src[base], end = src[base + last];
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[base + Math.min(Math.max(k, 0), n - 1) * step];
    for (let k = 0; k < n; k++) {
      dst[base + k * step] = sum * norm;
      const add = k + r + 1, drop = k - r;
      sum += (add < n ? src[base + add * step] : end) - (drop > 0 ? src[base + drop * step] : first);
    }
  }
}

/** `field` blurred by about a Gaussian of `sigma` px. */
export function softened(field: DistanceField, sigma: number): DistanceField {
  const { width: w, height: h } = field;
  const a = Float32Array.from(field.data);
  const b = new Float32Array(w * h);
  if (sigma > 0.3) {
    for (const r of boxRadii(sigma)) {
      if (r < 1) continue;
      boxBlur(a, b, w, h, r, true);
      boxBlur(b, a, w, h, r, false);
    }
  }
  return { data: a, width: w, height: h };
}

// Taller glyphs
//
// A glyph is made taller by drawing it that much taller, evenly, which also
// thickens its strokes: a flat one by the whole factor, an upright one not
// at all, a slanted or curved one in between. Its outline is then pulled
// back into the ink by what the stretch added on each side, as if the
// stretched strokes had been drawn with the font's own pen: an ellipse as
// wide as its upright strokes and as tall as its flat ones. Every piece of
// the outline moves along its normal by an amount that depends only on which
// way it faces, and neighbouring pieces meet where their moved lines cross,
// so corners stay sharp and curves stay smooth.

// Pieces of edge whose normal is this close to across (down) the rows are
// on the side of an upright (flat) stroke.
const SIDE_NORMAL = 0.9;
// How far (px) the traced outline may stray from the pixels' edge.
const TRACE_TOLERANCE = 0.2;
// Corners rounded off by less than this many strokes are made sharp (see sharpenCorners()).
const CORNER_SIZE = 0.3;
// A corner whose moved lines meet further out than this many times the move
// is too sharp to keep; it is cut off between them instead.
const MITER_LIMIT = 6;

// The mean of the middle half of `values`: one side of a stroke may reach
// its middle and the other not, and joins and ends are far off either way.
function middleMean(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = values.slice(values.length >> 2, values.length - (values.length >> 2));
  return middle.length ? middle.reduce((sum, v) => sum + v, 0) / middle.length : 0;
}

/**
 * How thick the strokes of coverage `alpha` (`w` x `h`) are, px: across
 * the upright ones and across the flat ones. A stroke is as thick as the
 * largest circle that touches its edge from inside.
 */
export function strokeWidths(alpha: Uint8Array, w: number, h: number): [number, number] {
  const { signed, nearest, nx, ny } = edgeField(alpha, w, h);
  const deepest = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const e = nearest[i];
    if (signed[i] < 0 && e >= 0) deepest[e] = Math.max(deepest[e], -signed[i]);
  }
  const upright: number[] = [], flat: number[] = [];
  for (let e = 0; e < w * h; e++) {
    if (nearest[e] !== e || deepest[e] === 0) continue;
    // The pixel centres on the two sides of a stroke stop short of its
    // middle by a pixel between them.
    const width = 2 * deepest[e] + 1;
    if (Math.abs(nx[e]) > SIDE_NORMAL) upright.push(width);
    else if (Math.abs(ny[e]) > SIDE_NORMAL) flat.push(width);
  }
  const across = middleMean(upright) || middleMean(flat) || 1;
  return [across, middleMean(flat) || across];
}

/**
 * How wide and how tall the widest and tallest runs of ink in coverage
 * `alpha` (`w` x `h`) are, px: a dot's size.
 */
export function dotSize(alpha: Uint8Array, w: number, h: number): [number, number] {
  let wide = 0, tall = 0;
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run = alpha[y * w + x] ? run + alpha[y * w + x] / 255 : 0;
      wide = Math.max(wide, run);
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h; y++) {
      run = alpha[y * w + x] ? run + alpha[y * w + x] / 255 : 0;
      tall = Math.max(tall, run);
    }
  }
  return [wide, tall];
}

/**
 * Where coverage `alpha` (`w` x `h`) crosses half, as closed loops of
 * points [x0, y0, x1, y1, ...], pixel (x, y) covering x to x + 1, each loop
 * running with the ink on its left.
 */
export function traceOutlines(alpha: Uint8Array, w: number, h: number): number[][] {
  const inside = (i: number) => alpha[i] >= 128;
  // Edges between neighbouring pixel centres: 2i to the right of pixel i, 2i + 1 below it.
  const points = new Map<number, [number, number]>();
  const next = new Map<number, number>();
  const cross = (edge: number, i: number, j: number, x: number, y: number, dx: number, dy: number) => {
    if (!points.has(edge)) {
      const t = (127.5 - alpha[i]) / (alpha[j] - alpha[i]);
      points.set(edge, [x + 0.5 + t * dx, y + 0.5 + t * dy]);
    }
    return edge;
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = y * w + x, tr = tl + 1, bl = tl + w, br = bl + 1;
      const corners = [tl, tr, br, bl];
      const ins = corners.map(inside);
      if (ins.every(v => v === ins[0])) continue;
      // Round the cell clockwise: top, right, bottom, left.
      const sides = [
        () => cross(2 * tl, tl, tr, x, y, 1, 0),
        () => cross(2 * tr + 1, tr, br, x + 1, y, 0, 1),
        () => cross(2 * bl, bl, br, x, y + 1, 1, 0),
        () => cross(2 * tl + 1, tl, bl, x, y, 0, 1),
      ];
      const entries: number[] = [], exits: number[] = [];
      for (let k = 0; k < 4; k++) {
        if (ins[k] === ins[(k + 1) % 4]) continue;
        (ins[k] ? exits : entries).push(k);
      }
      if (entries.length === 1) {
        next.set(sides[entries[0]](), sides[exits[0]]());
        continue;
      }
      // A saddle: the ink joins across the middle if the middle is covered.
      const middle = corners.reduce((sum, c) => sum + alpha[c], 0) / 4 >= 127.5;
      for (const k of entries) {
        const exit = middle ? (k + 3) % 4 : (k + 1) % 4;
        next.set(sides[k](), sides[exit]());
      }
    }
  }

  const loops: number[][] = [];
  for (const start of next.keys()) {
    if (!points.has(start)) continue;
    const loop: number[] = [];
    let edge: number | undefined = start;
    while (edge !== undefined && points.has(edge)) {
      loop.push(...points.get(edge)!);
      points.delete(edge);
      edge = next.get(edge);
    }
    if (loop.length >= 6) loops.push(loop);
  }
  return loops;
}

// Keeps the points of a closed loop that it cannot do without to stay
// within `tolerance` px (Douglas-Peucker).
function simplify(loop: number[], tolerance: number): number[] {
  const n = loop.length / 2;
  const far = (from: number) => {
    let best = from, bestD = -1;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(loop[2 * i] - loop[2 * from], loop[2 * i + 1] - loop[2 * from + 1]);
      if (d > bestD) [best, bestD] = [i, d];
    }
    return best;
  };
  const a = far(0), b = far(a);
  const keep = new Uint8Array(n);
  keep[a] = keep[b] = 1;
  const stack = [[a, b], [b, a]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const count = (j - i + n) % n;
    if (count < 2) continue;
    const [x0, y0, x1, y1] = [loop[2 * i], loop[2 * i + 1], loop[2 * j], loop[2 * j + 1]];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    let worst = -1, worstD = tolerance;
    for (let k = 1; k < count; k++) {
      const m = (i + k) % n;
      const d = Math.abs((x1 - x0) * (y0 - loop[2 * m + 1]) - (x0 - loop[2 * m]) * (y1 - y0)) / len;
      if (d > worstD) [worst, worstD] = [m, d];
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([i, worst], [worst, j]);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[2 * i], loop[2 * i + 1]);
  return out;
}

// A corner that is rounded off a little (by the font, or by anti-aliasing)
// would have its few short pieces moved by amounts between those of the two
// sides, and come out as a bevel. Short pieces adding up to less than
// `limit` px between two at least twice as long, which turn by more than
// CORNER_TURN, are put back to the corner where the long ones' lines cross,
// when that is about where the short ones are.
const CORNER_TURN = 0.5;

function sharpenCorners(loop: number[], limit: number): number[] {
  const n = loop.length / 2;
  if (n < 4) return loop;
  const pt = (k: number): [number, number] => [loop[2 * ((k % n + n) % n)], loop[2 * ((k % n + n) % n) + 1]];
  const lengths = Array.from({ length: n }, (_, k) => Math.hypot(pt(k + 1)[0] - pt(k)[0], pt(k + 1)[1] - pt(k)[1]));
  const long = (k: number) => lengths[(k % n + n) % n] >= limit;
  let first = 0;
  while (first < n && !long(first)) first++;
  if (first === n) return loop;
  // The corner that replaces vertices k..m + 1, by k.
  const corners = new Map<number, { end: number, at: [number, number] }>();
  for (let k = first + 1; k < first + n; k++) {
    if (long(k)) continue;
    let m = k, run = 0;
    while (!long(m)) run += lengths[m++ % n];
    const [a, b] = [k - 1, m];
    const next = m;
    if (run < limit && lengths[a % n] >= 2 * run && lengths[b % n] >= 2 * run) {
      const [a0, a1, b0, b1] = [pt(a), pt(a + 1), pt(b), pt(b + 1)];
      const [ux, uy, vx, vy] = [a1[0] - a0[0], a1[1] - a0[1], b1[0] - b0[0], b1[1] - b0[1]];
      const det = ux * vy - uy * vx;
      const turn = Math.abs(Math.atan2(det, ux * vx + uy * vy));
      if (turn >= CORNER_TURN) {
        const t = ((b0[0] - a1[0]) * vy - (b0[1] - a1[1]) * vx) / det;
        const at: [number, number] = [a1[0] + ux * t, a1[1] + uy * t];
        if (Math.hypot(at[0] - (a1[0] + b0[0]) / 2, at[1] - (a1[1] + b0[1]) / 2) <= run) corners.set(k % n, { end: m % n, at });
      }
    }
    k = next;
  }
  if (!corners.size) return loop;
  const out: number[] = [];
  for (let i = 0, k = first; i < n; i++, k = (k + 1) % n) {
    const corner = corners.get(k);
    if (!corner) {
      out.push(...pt(k));
      continue;
    }
    out.push(...corner.at);
    // Vertices k + 1 to the end of the run go with it.
    const skip = (corner.end - k + n) % n;
    i += skip;
    k = (k + skip) % n;
  }
  return out;
}

/**
 * `loop` (ink on its left) with every piece moved into the ink by
 * `move(nx, ny)` px, its normal into the ink being (nx, ny): the corners
 * where the moved pieces' lines cross. A piece the move turns round (a curve
 * or a corner tighter than the move) is dropped, and its neighbours meet
 * instead. Empty when nothing is left.
 */
export function moveOutline(loop: number[], move: (nx: number, ny: number) => number): number[] {
  const n = loop.length / 2;
  const nx = new Float64Array(n), ny = new Float64Array(n), shift = new Float64Array(n), along = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const dx = loop[2 * j] - loop[2 * k], dy = loop[2 * j + 1] - loop[2 * k + 1];
    const len = Math.hypot(dx, dy) || 1;
    nx[k] = dy / len;
    ny[k] = -dx / len;
    // The moved line: the points p with p . normal = along.
    shift[k] = move(nx[k], ny[k]);
    along[k] = loop[2 * k] * nx[k] + loop[2 * k + 1] * ny[k] + shift[k];
  }
  const prev = Array.from({ length: n }, (_, k) => (k + n - 1) % n);
  const next = Array.from({ length: n }, (_, k) => (k + 1) % n);
  // Where piece b starts: on piece a's line and on its own.
  const start = (a: number, b: number): [number, number] => {
    const det = nx[a] * ny[b] - ny[a] * nx[b];
    const [cx, cy] = [loop[2 * b], loop[2 * b + 1]];
    if (Math.abs(det) > 0.02) {
      const x = (along[a] * ny[b] - ny[a] * along[b]) / det, y = (nx[a] * along[b] - along[a] * nx[b]) / det;
      if (Math.hypot(x - cx, y - cy) <= MITER_LIMIT * Math.max(shift[a], shift[b], 0.5)) return [x, y];
    }
    // Nearly in line, or too sharp a corner: between where the two lines pass the corner.
    const end = (a + 1) % n;
    const [ex, ey] = [loop[2 * end], loop[2 * end + 1]];
    return [(ex + nx[a] * shift[a] + cx + nx[b] * shift[b]) / 2, (ey + ny[a] * shift[a] + cy + ny[b] * shift[b]) / 2];
  };
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let k = 0; k < n; k++) [xs[k], ys[k]] = start(prev[k], k);
  let alive = n;
  for (let changed = true; changed && alive >= 3;) {
    changed = false;
    for (let k = 0; k < n && alive >= 3; k++) {
      if (next[k] < 0) continue;
      const j = next[k];
      // Turned round: it now runs against its normal's tangent.
      if ((xs[j] - xs[k]) * -ny[k] + (ys[j] - ys[k]) * nx[k] >= 0) continue;
      const [p, q] = [prev[k], next[k]];
      next[p] = q;
      prev[q] = p;
      next[k] = prev[k] = -1;
      alive--;
      [xs[q], ys[q]] = start(p, q);
      changed = true;
    }
  }
  if (alive < 3) return [];
  const out: number[] = [];
  let first = 0;
  while (next[first] < 0) first++;
  let k = first;
  do {
    out.push(xs[k], ys[k]);
    k = next[k];
  } while (k !== first);
  return out;
}

/**
 * Coverage (0-255, `w` x `h`) of the area inside `loops` (as
 * traceOutlines() gives them), anti-aliased by the exact area each pixel
 * has inside.
 */
export function fillOutlines(loops: number[][], w: number, h: number): Uint8Array {
  const stride = w + 2;
  const area = new Float32Array(stride * h);
  const line = (px: number, py: number, qx: number, qy: number) => {
    if (py === qy) return;
    const dir = py < qy ? 1 : -1;
    const [ax, ay, bx, by] = py < qy ? [px, py, qx, qy] : [qx, qy, px, py];
    const dxdy = (bx - ax) / (by - ay);
    let x = ax + Math.max(-ay, 0) * dxdy;
    for (let y = Math.max(Math.floor(ay), 0); y < Math.min(Math.ceil(by), h); y++) {
      const row = y * stride;
      const dy = Math.min(y + 1, by) - Math.max(y, ay);
      const xNext = x + dxdy * dy;
      const d = dy * dir;
      const x0 = Math.min(Math.max(Math.min(x, xNext), 0), w);
      const x1 = Math.min(Math.max(Math.max(x, xNext), 0), w);
      const i0 = Math.floor(x0), i1 = Math.ceil(x1);
      if (i1 <= i0 + 1) {
        const mid = (x0 + x1) / 2 - i0;
        area[row + i0] += d * (1 - mid);
        area[row + i0 + 1] += d * mid;
      } else {
        // The part of the row's slice left of each pixel boundary.
        const s = 1 / (x1 - x0);
        const f0 = x0 - i0;
        const a0 = 0.5 * s * (1 - f0) ** 2;
        const f1 = x1 - i1 + 1;
        const am = 0.5 * s * f1 * f1;
        area[row + i0] += d * a0;
        if (i1 === i0 + 2) {
          area[row + i0 + 1] += d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - f0);
          area[row + i0 + 1] += d * (a1 - a0);
          for (let i = i0 + 2; i < i1 - 1; i++) area[row + i] += d * s;
          const a2 = a1 + (i1 - i0 - 3) * s;
          area[row + i1 - 1] += d * (1 - a2 - am);
        }
        area[row + i1] += d * am;
      }
      x = xNext;
    }
  };
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      line(loop[2 * i], loop[2 * i + 1], loop[2 * j], loop[2 * j + 1]);
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += area[y * stride + x];
      out[y * w + x] = Math.round(Math.min(Math.abs(sum), 1) * 255);
    }
  }
  return out;
}

/**
 * Coverage `alpha` (`w` x `h`) of a glyph drawn `stretch` times as tall,
 * with each stroke pulled back to the thickness a pen `pen` px across
 * (upright strokes) and tall (flat strokes) draws it at that angle.
 */
export function keepStrokeWidths(alpha: Uint8Array, w: number, h: number, pen: [number, number],
  stretch: number): Uint8Array {
  const [across, tall] = pen;
  const move = (nx: number, ny: number) =>
    (Math.hypot(across * nx, stretch * tall * ny) - Math.hypot(across * nx, tall * ny)) / 2;
  const corner = CORNER_SIZE * Math.min(across, tall);
  const loops = traceOutlines(alpha, w, h).map(loop => moveOutline(sharpenCorners(simplify(loop, TRACE_TOLERANCE), corner), move));
  return fillOutlines(loops, w, h);
}

// Averages `factor` x `factor` blocks and scales the distances to match.
function downsample(field: DistanceField, factor: number): DistanceField {
  const width = Math.floor(field.width / factor);
  const height = Math.floor(field.height / factor);
  const data = new Float32Array(width * height);
  const norm = 1 / (factor * factor * factor);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) {
        const row = (y * factor + j) * field.width + x * factor;
        for (let i = 0; i < factor; i++) sum += field.data[row + i];
      }
      data[y * width + x] = sum * norm;
    }
  }
  return { data, width, height };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A font the digits are cut from, at one size. */
export interface TextFace {
  /** The union of the ink and the line of `text` at `scale` times the size, px from the line's top left. */
  bounds(text: string, scale: number): Box;
  /** Where each character of `text` starts, px. */
  offsets(text: string): number[];
  /** The top of the digits and the baseline, px from the line's top. */
  digitBand(): [number, number];
  /** Fills `text` on `cr` at `scale` times the size, the line's top left at the origin. */
  draw(cr: any, text: string, scale: number): void;
}

function layoutFor(cr: any, font: Pango.FontDescription, text: string): Pango.Layout {
  const layout = PangoCairo.create_layout(cr);
  layout.set_font_description(font);
  layout.set_text(text, -1);
  return layout;
}

// Runs `fn` with a Cairo context that draws nowhere, for measuring.
function measuring<T>(fn: (cr: any) => T): T {
  const probe = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
  const cr = new Cairo.Context(probe);
  const result = fn(cr);
  cr.$dispose();
  probe.finish();
  return result;
}

/** An installed font, through Pango: a description such as "Cantarell Bold" at `size` px. */
export function pangoFace(description: string, size: number): TextFace {
  const fontAt = (scale: number) => {
    const font = Pango.FontDescription.from_string(description);
    font.set_absolute_size(size * scale * Pango.SCALE);
    return font;
  };
  const font = fontAt(1);
  return {
    bounds: (text, scale) => measuring(cr => {
      const [ink, logical] = layoutFor(cr, scale === 1 ? font : fontAt(scale), text).get_pixel_extents();
      return {
        x0: Math.floor(Math.min(ink!.x, logical!.x)),
        y0: Math.floor(Math.min(ink!.y, logical!.y)),
        x1: Math.ceil(Math.max(ink!.x + ink!.width, logical!.x + logical!.width)),
        y1: Math.ceil(Math.max(ink!.y + ink!.height, logical!.y + logical!.height)),
      };
    }),
    offsets: text => measuring(cr => {
      const layout = layoutFor(cr, font, text);
      // Pango indexes the text by UTF-8 byte.
      const encoder = new TextEncoder();
      let byteIndex = 0;
      return Array.from(text, ch => {
        const x = layout.index_to_pos(byteIndex).x / Pango.SCALE;
        byteIndex += encoder.encode(ch).length;
        return x;
      });
    }),
    digitBand: () => measuring(cr => {
      const digits = layoutFor(cr, font, '0123456789');
      const [ink] = digits.get_pixel_extents();
      return [ink!.y, digits.get_baseline() / Pango.SCALE] as [number, number];
    }),
    draw: (cr, text, scale) => PangoCairo.show_layout(cr, layoutFor(cr, fontAt(scale), text)),
  };
}

/** A font file the extension ships with, at `size` px. */
export function fileFace(font: TrueTypeFont, size: number): TextFace {
  const unit = size / font.unitsPerEm;
  const glyphs = (text: string) => Array.from(text, ch => font.glyph(ch.codePointAt(0)!));
  const ascent = font.ascender * unit;
  return {
    bounds: (text, scale) => {
      const s = unit * scale;
      let pen = 0;
      const box = { x0: 0, y0: 0, x1: 0, y1: (font.ascender - font.descender) * s };
      for (const g of glyphs(text)) {
        if (g.contours.length) {
          box.x0 = Math.min(box.x0, pen + g.xMin * s);
          box.x1 = Math.max(box.x1, pen + g.xMax * s);
          box.y0 = Math.min(box.y0, (font.ascender - g.yMax) * s);
          box.y1 = Math.max(box.y1, (font.ascender - g.yMin) * s);
        }
        pen += g.advance * s;
      }
      box.x1 = Math.max(box.x1, pen);
      return { x0: Math.floor(box.x0), y0: Math.floor(box.y0), x1: Math.ceil(box.x1), y1: Math.ceil(box.y1) };
    },
    offsets: text => {
      let pen = 0;
      return glyphs(text).map(g => {
        const x = pen;
        pen += g.advance * unit;
        return x;
      });
    },
    digitBand: () => [Math.min(...glyphs('0123456789').map(g => ascent - g.yMax * unit)), ascent],
    draw: (cr, text, scale) => {
      const s = unit * scale;
      let pen = 0;
      for (const g of glyphs(text)) {
        traceGlyph(cr, g, pen, font.ascender * s, s);
        pen += g.advance * s;
      }
      cr.fill();
    },
  };
}

// How glyphs are made taller: y is drawn at centre + scale * (y - centre),
// and the strokes are given back the thickness the pen draws them with,
// [across, tall] (see keepStrokeWidths()).
interface Tallness {
  scale: number;
  centre: number;
  pen: [number, number];
}

function tallY(tall: Tallness | null, y: number): number {
  return tall ? tall.centre + tall.scale * (y - tall.centre) : y;
}

// Draws `text` at `scale` times the size, stretched `stretch` times as wide
// and made taller by `tall` (in px at that scale), into a temporary PNG and
// reads its coverage back, with `margin` px of room around it. The coverage
// is in whole blocks of SUPERSAMPLE.
async function rasterize(face: TextFace, text: string, scale: number, stretch: number, tall: Tallness | null,
  margin: number, cancellable: Gio.Cancellable): Promise<{ alpha: Uint8Array, width: number, height: number, originX: number, originY: number }> {
  const b = face.bounds(text, scale);
  const x0 = Math.floor(b.x0 * stretch) - margin;
  const y0 = Math.floor(tallY(tall, b.y0)) - margin;
  const x1 = Math.ceil(b.x1 * stretch) + margin;
  const y1 = Math.ceil(tallY(tall, b.y1)) + margin;
  // Whole blocks of SUPERSAMPLE, so the downscaled field keeps its origin.
  const ax = x0 - ((x0 % SUPERSAMPLE) + SUPERSAMPLE) % SUPERSAMPLE;
  const ay = y0 - ((y0 % SUPERSAMPLE) + SUPERSAMPLE) % SUPERSAMPLE;
  const width = Math.ceil((x1 - ax) / SUPERSAMPLE) * SUPERSAMPLE;
  const height = Math.ceil((y1 - ay) / SUPERSAMPLE) * SUPERSAMPLE;

  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
  const cr = new Cairo.Context(surface);
  cr.setSourceRGBA(1, 1, 1, 1);
  cr.translate(-ax, -ay);
  if (tall) {
    cr.translate(0, tall.centre);
    cr.scale(stretch, tall.scale);
    cr.translate(0, -tall.centre);
  } else {
    cr.scale(stretch, 1);
  }
  face.draw(cr, text, scale);
  cr.$dispose();

  const [fd, path] = GLib.file_open_tmp('liquid-glass-glyph-XXXXXX.png');
  GLib.close(fd);
  const file = Gio.File.new_for_path(path);
  try {
    surface.writeToPNG(path);
    surface.finish();
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      file.load_contents_async(cancellable, (_f, res) => {
        try {
          resolve(file.load_contents_finish(res)[1]);
        } catch (e) {
          reject(e);
        }
      });
    });
    const { alpha, width: w, height: h } = decodePngAlpha(bytes);
    return { alpha: tall ? keepStrokeWidths(alpha, w, h, tall.pen, tall.scale) : alpha, width: w, height: h,
      originX: -ax, originY: -ay };
  } finally {
    file.delete_async(GLib.PRIORITY_DEFAULT, null, (_f, res) => {
      // Throws a GError when the file is already gone; nothing is left behind then.
      try {
        file.delete_finish(res);
      } catch {
      }
    });
  }
}

// The digits are measured for their pen this many px tall.
const MEASURE_HEIGHT = 240;

/**
 * Distance fields of single glyphs of `face`, stretched `stretch` times as
 * wide and made `height` times as tall (see keepStrokeWidths()), built on
 * first use. `range` is how far (px) from the outline the fields reach.
 */
export class GlyphFields {
  private _glyphs = new Map<string, Promise<GlyphField>>();
  // Cancels the reads still running when the fields are no longer wanted.
  readonly cancellable = new Gio.Cancellable();
  /** The digits' height in the font as it is, px. */
  readonly digitHeight: number;
  private _band: [number, number];
  private _tall: Promise<Tallness | null> | null = null;

  constructor(private _face: TextFace, readonly range: number, readonly stretch = 1, readonly height = 1) {
    this._band = _face.digitBand();
    this.digitHeight = Math.max(this._band[1] - this._band[0], 1);
  }

  // How the glyphs are made taller, in px at the font's size. Each end of
  // the digits loses half of what the stretch added to a flat stroke, so
  // they are stretched that much more, about the middle of their top stroke:
  // their outline then spans `height` times the digits' height from the top.
  private _tallness(): Promise<Tallness | null> {
    if (this._tall) return this._tall;
    if (this.height <= 1) return this._tall = Promise.resolve(null);
    this._tall = (async () => {
      const [across, tall] = await this._pen('0123456789');
      const h = this.digitHeight;
      const flat = Math.min(tall, h / 3);
      return { scale: (this.height * h - flat) / (h - flat), centre: this._band[0] + flat / 2, pen: [across, tall] };
    })();
    // Measured again next time when it failed.
    this._tall.catch(() => {
      this._tall = null;
    });
    return this._tall;
  }

  // How thick the strokes of `text` are, px at the font's size (see
  // strokeWidths()), or for dots how big the dots are.
  private async _pen(text: string, dots = false): Promise<[number, number]> {
    const scale = Math.min(MEASURE_HEIGHT / this.digitHeight, SUPERSAMPLE);
    const big = await rasterize(this._face, text, scale, this.stretch, null, 2, this.cancellable);
    const [across, tall] = (dots ? dotSize : strokeWidths)(big.alpha, big.width, big.height);
    return [across / scale, tall / scale];
  }

  private _glyph(ch: string): Promise<GlyphField> {
    let glyph = this._glyphs.get(ch);
    if (!glyph) {
      glyph = this._tallness().then(async t => {
        // The colon's dots keep their own shape, whatever the digits' strokes are.
        const pen = t && ch === ':' ? await this._pen(ch, true) : t?.pen;
        const tall = t && { scale: t.scale, centre: t.centre * SUPERSAMPLE,
          pen: pen!.map(v => v * SUPERSAMPLE) as [number, number] };
        const big = await rasterize(this._face, ch, SUPERSAMPLE, this.stretch, tall, this.range * SUPERSAMPLE,
          this.cancellable);
        const field = downsample({ data: signedDistances(big.alpha, big.width, big.height),
          width: big.width, height: big.height }, SUPERSAMPLE);
        return { ...field, originX: big.originX / SUPERSAMPLE, originY: big.originY / SUPERSAMPLE };
      });
      // A failed glyph is tried again next time.
      glyph.catch(() => this._glyphs.delete(ch));
      this._glyphs.set(ch, glyph);
    }
    return glyph;
  }

  /**
   * The field of `text` laid out on one line: each glyph's field placed where
   * the line puts it, merged by taking the nearest outline. Rejects with a
   * GError when a glyph cannot be drawn or `cancellable` was cancelled.
   */
  async fieldFor(text: string): Promise<DistanceField> {
    const glyphs = new Map<string, GlyphField>();
    for (const ch of new Set(text)) {
      if (!/\s/.test(ch)) glyphs.set(ch, await this._glyph(ch));
    }

    const b = this._face.bounds(text, 1);
    const offsets = this._face.offsets(text);
    const r = this.range;
    // The line's room above and below the digits stays as it was.
    const tall = await this._tallness();
    const [top, baseline] = this._band;
    const x0 = Math.floor(b.x0 * this.stretch) - r;
    const y0 = Math.floor(tallY(tall, top) - (top - b.y0)) - r;
    const width = Math.ceil(b.x1 * this.stretch) + r - x0;
    const height = Math.ceil(tallY(tall, baseline) + (b.y1 - baseline)) + r - y0;
    const data = new Float32Array(width * height).fill(r);

    Array.from(text).forEach((ch, index) => {
      const glyph = glyphs.get(ch);
      if (!glyph) return;
      const left = Math.round(offsets[index] * this.stretch - glyph.originX - x0);
      const top = Math.round(-glyph.originY - y0);
      for (let gy = 0; gy < glyph.height; gy++) {
        const y = top + gy;
        if (y < 0 || y >= height) continue;
        for (let gx = 0; gx < glyph.width; gx++) {
          const x = left + gx;
          if (x < 0 || x >= width) continue;
          const v = glyph.data[gy * glyph.width + gx];
          const i = y * width + x;
          if (v < data[i]) data[i] = v;
        }
      }
    });
    return { data, width, height };
  }
}

/** The deepest point of `field`, px. */
export function maxDepth(field: DistanceField): number {
  let depth = 0;
  for (let i = 0; i < field.data.length; i++) depth = Math.max(depth, -field.data[i]);
  return depth;
}

/**
 * A texture for glass.frag's LG_SHAPE_TEXTURE: `outline` above `lens`, two
 * fields of the same size, distances from -range to +range in 16 bits, the
 * high byte in red and the low in green. Throws a GError when the texture
 * cannot be made.
 */
export function fieldTexture(outline: DistanceField, lens: DistanceField, range: number): Cogl.Texture {
  const { width, height } = outline;
  const bytes = new Uint8Array(width * height * 8);
  const put = (data: Float32Array, offset: number) => {
    for (let i = 0; i < width * height; i++) {
      const t = Math.min(Math.max((data[i] + range) / (2 * range), 0), 1);
      const v = Math.round(t * 65535);
      const o = (offset + i) * 4;
      bytes[o] = v >> 8;
      bytes[o + 1] = v & 255;
      bytes[o + 3] = 255;
    }
  };
  put(outline.data, 0);
  put(lens.data, width * height);
  return Cogl.Texture2D.new_from_data(coglContext(), width, height * 2, Cogl.PixelFormat.RGBA_8888, width * 4, bytes);
}
