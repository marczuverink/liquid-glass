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
// each piece's row and normal (into the glyph). Every pixel the outline crosses gets the short piece of edge that
// crosses it, placed to a fraction of a pixel from its coverage; every other
// pixel takes the nearest of those pieces from its neighbours. Distances to
// pixel centres instead would follow the pixels' staircase, which the glass
// shows as facets along a curve.
function edgeField(alpha: Uint8Array, w: number, h: number):
  { signed: Float32Array, nearest: Int32Array, ey: Float32Array, nx: Float32Array, ny: Float32Array } {
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
  return { signed, nearest, ey, nx, ny };
}

/** Signed distances (px, negative inside) from coverage (0-255); see edgeField(). */
export function signedDistances(alpha: Uint8Array, w: number, h: number): Float32Array {
  return edgeField(alpha, w, h).signed;
}

/**
 * For every pixel of coverage `alpha` (`w` x `h`) near the glyph, the row
 * (fractional, rows' tops at whole numbers) of the middle of the stroke it
 * belongs to or lies beside, NaN for the pixels too far from the glyph to
 * matter: straight in from its nearest edge by half the stroke's width.
 * Where a stroke is cut off that would be a point inside the cut, not in the
 * stroke's middle: the cut end of a flat stroke (no taller than `across` px)
 * takes the middle halfway down it, and the cut end of an upright one (no
 * wider than that) the pixel's own row, as the rest of the stroke does.
 */
export function strokeMiddles(alpha: Uint8Array, w: number, h: number, across: number): Float32Array {
  const out = new Float32Array(w * h).fill(NaN);
  // Only round the ink, for speed.
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] === 0) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return out;
  const pad = 4;
  x0 = Math.max(x0 - pad, 0);
  y0 = Math.max(y0 - pad, 0);
  x1 = Math.min(x1 + pad, w - 1);
  y1 = Math.min(y1 + pad, h - 1);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const crop = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) crop.set(alpha.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw), y * cw);

  // The runs of ink (anti-aliased ends included) through each pixel: how
  // wide across its row, and how tall down its column with its middle.
  const wide = new Float32Array(cw * ch);
  const tall = new Float32Array(cw * ch);
  const halfway = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw;) {
      if (crop[y * cw + x] === 0) {
        x++;
        continue;
      }
      const start = x;
      while (x < cw && crop[y * cw + x] > 0) x++;
      wide.fill(x - start, y * cw + start, y * cw + x);
    }
  }
  for (let x = 0; x < cw; x++) {
    for (let y = 0; y < ch;) {
      if (crop[y * cw + x] === 0) {
        y++;
        continue;
      }
      const start = y;
      while (y < ch && crop[y * cw + x] > 0) y++;
      for (let r = start; r < y; r++) {
        tall[r * cw + x] = y - start;
        halfway[r * cw + x] = (start + y) / 2;
      }
    }
  }

  const { signed, nearest, ey, nx, ny } = edgeField(crop, cw, ch);
  const deepest = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    const e = nearest[i];
    if (signed[i] < 0 && e >= 0) deepest[e] = Math.max(deepest[e], -signed[i]);
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const e = nearest[i];
      if (e < 0) continue;
      // Where strokes meet, the ink straight in from an edge reaches past the
      // middle of its stroke into the other one.
      let mid = ey[e] + ny[e] * Math.min(deepest[e], across * MIDDLE_DEPTH_MAX) + 0.5;
      if (crop[i] > 0 && Math.abs(nx[e]) > CUT_NORMAL && tall[i] <= across) mid = halfway[i];
      else if (crop[i] > 0 && Math.abs(ny[e]) > CUT_NORMAL && wide[i] <= across) mid = y + 0.5;
      out[(y0 + y) * w + x0 + x] = y0 + mid;
    }
  }
  return out;
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
// A glyph grows taller by spacing its rows of coverage further apart, more
// in some rows than in others. Each row has a cost for growing (an edge that
// bends or lies flat through it would be drawn out of shape) and takes in
// inverse to it; neighbouring rows that an edge slants or curves through are
// tied to grow alike, or the edge would bend there. So upright straight
// strokes take the height, curves and slanted strokes grow evenly, and a
// glyph with nothing upright grows evenly all over. Each stroke is then moved
// as a whole along its middle (see tallen()), so it keeps its width.

// How fast a row's cost rises as the outline bends through it: at this much
// change of an edge's slope (horizontal px per row) between half a stroke
// above and half a stroke below, it costs twice what a straight row does.
const BEND_HALF = 0.12;
// Edges flatter than this many px across per row change their angle visibly
// when their rows spread out; past it the row costs more, twice as much at
// FLAT_START + FLAT_HALF.
const FLAT_START = 1.5;
const FLAT_HALF = 1;
// A row whose longest stroke is this many times the glyph's usual stroke runs
// along a horizontal one (a bar, the top of a bowl), whose thickness is kept;
// fully past BAR_START + BAR_SPAN.
const BAR_START = 1.4;
const BAR_SPAN = 0.3;
// No row costs more than BEND_COST_MAX for bending, so the sharpest rows of a
// curve do not stand out from the rest. Rows within half a stroke of where an
// edge starts or ends cost END_COST more: the pixels there move with
// different strokes' middles, and the end of a stroke, or where strokes meet,
// keeps its shape only if its rows do not grow. Rows that must not grow at
// all cost HOLD: those along a bar, and those where an edge is there for that
// row only or nothing is covered past half (the tip of a curve).
const BEND_COST_MAX = 30;
const HOLD = 1e4;
const END_COST = 1000;
// Neighbouring rows an edge slants through by this many px per row, or
// bends through by this much (as BEND_HALF measures it), may differ in growth
// over about as many rows as the band has; the reach grows with the squares,
// so straight upright edges barely tie their rows, and slanted or curved ones
// make them grow as one.
const SLOPE_TIE = 0.03;
const BEND_TIE = 0.03;

// The Gaussian the pixels' moves are smoothed by, in strokes.
const MOVE_SMOOTHING = 0.25;
// Ink no taller (wider) than this many strokes is a flat (upright) stroke,
// and an edge whose normal is this close to across (down) the rows is where
// such a stroke is cut off (see strokeMiddles()).
const FLAT_RUN = 1.5;
const CUT_NORMAL = 0.95;
// The middle of a stroke is at most this many times `across` in from its edge.
const MIDDLE_DEPTH_MAX = 0.4;

// Where the outline crosses row y of coverage `alpha` (`w` wide): x to a
// fraction of a pixel, positive where the row enters the glyph and negative
// where it leaves (the sign is the direction, the magnitude x + 1).
function rowEdges(alpha: Uint8Array, w: number, y: number): number[] {
  const edges: number[] = [];
  let prev = 0;
  for (let x = 0; x <= w; x++) {
    const a = x < w ? alpha[y * w + x] : 0;
    if ((prev < 128) !== (a < 128)) {
      const at = x - 1 + (127.5 - prev) / (a - prev);
      edges.push(a >= 128 ? at + 1 : -(at + 1));
    }
    prev = a;
  }
  return edges;
}

// The rows of a band, top to bottom: their edges (see rowEdges()), and the
// slope (px across per row) and bend of each edge there, NaN for an edge
// that is there for that row only.
interface BandRows {
  edges: number[][];
  slopes: number[][];
  bends: number[][];
  // How many rows each edge has before it starts or after it ends, whichever
  // is fewer.
  ends: number[][];
  // Which edges go on into the next row, as the index of the edge they
  // become there (or -1).
  next: number[][];
  longest: Float64Array;
  // Whether anything is drawn in the row at all.
  inked: boolean[];
  stroke: number;
}

// The usual width of the strokes: the median of the rows' longest runs.
function medianStroke(longest: Float64Array): number {
  const stroked = Array.from(longest).filter(v => v > 0).sort((a, b) => a - b);
  return stroked.length ? stroked[stroked.length >> 1] : 1;
}

// Follows each edge from row to row, nearest matches first, so strokes that
// start or end beside it do not break it.
function bandRows(alpha: Uint8Array, w: number, top: number, bottom: number): BandRows {
  const n = bottom - top;
  const edges: number[][] = [];
  const longest = new Float64Array(n + 1);
  const inked: boolean[] = [];
  for (let r = 0; r <= n; r++) {
    edges.push(rowEdges(alpha, w, top + r));
    let run = 0, ink = false;
    for (let x = 0, i = (top + r) * w; x < w; x++, i++) {
      run = alpha[i] >= 128 ? run + 1 : 0;
      longest[r] = Math.max(longest[r], run);
      ink ||= alpha[i] > 0;
    }
    inked.push(ink);
  }
  const stroke = medianStroke(longest);
  const reach = Math.max(Math.round(stroke / 2), 1);

  const next: number[][] = edges.map(row => row.map(() => -1));
  const chains: { start: number, xs: number[] }[] = [];
  const chainOf: number[][] = [];
  for (let r = 0; r <= n; r++) {
    const ids = edges[r].map(() => -1);
    if (r > 0) {
      const pairs: [number, number, number][] = [];
      edges[r - 1].forEach((a, i) => edges[r].forEach((b, j) => {
        const d = Math.abs(Math.abs(a) - Math.abs(b));
        if (Math.sign(a) === Math.sign(b) && d <= reach) pairs.push([d, i, j]);
      }));
      pairs.sort((p, q) => p[0] - q[0]);
      for (const [, i, j] of pairs) {
        if (next[r - 1][i] >= 0 || ids[j] >= 0) continue;
        next[r - 1][i] = j;
        ids[j] = chainOf[r - 1][i];
        chains[ids[j]].xs.push(Math.abs(edges[r][j]));
      }
    }
    edges[r].forEach((e, j) => {
      if (ids[j] >= 0) return;
      ids[j] = chains.length;
      chains.push({ start: r, xs: [Math.abs(e)] });
    });
    chainOf.push(ids);
  }

  const slopes = edges.map(row => row.map(() => NaN));
  const bends = edges.map(row => row.map(() => 0));
  const ends = edges.map(row => row.map(() => 0));
  for (let r = 0; r <= n; r++) {
    chainOf[r].forEach((c, j) => {
      const { start, xs } = chains[c];
      const i = r - start;
      ends[r][j] = Math.min(i, xs.length - 1 - i);
      if (xs.length < 2) return;
      const a = Math.max(i - reach, 0), b = Math.min(i + reach, xs.length - 1);
      const up = i > a ? (xs[i] - xs[a]) / (i - a) : null;
      const down = b > i ? (xs[b] - xs[i]) / (b - i) : null;
      slopes[r][j] = (xs[b] - xs[a]) / (b - a);
      if (up !== null && down !== null) bends[r][j] = Math.abs(down - up);
    });
  }
  return { edges, slopes, bends, ends, next, longest, inked, stroke };
}

// Solves the tridiagonal system with `diag` on the diagonal, -off[i] between
// i and i + 1, and `rhs` on the right.
function solveTridiagonal(diag: Float64Array, off: Float64Array, rhs: Float64Array): Float64Array {
  const n = diag.length;
  const c = new Float64Array(n);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const below = i > 0 ? off[i - 1] : 0;
    const m = diag[i] + (i > 0 ? below * c[i - 1] : 0);
    c[i] = i < n - 1 ? -off[i] / m : 0;
    d[i] = (rhs[i] + (i > 0 ? below * d[i - 1] : 0)) / m;
  }
  for (let i = n - 2; i >= 0; i--) d[i] -= c[i] * d[i + 1];
  return d;
}

function bandShares(rows: BandRows): Float64Array {
  const n = rows.edges.length - 1;
  // The room above and below the glyph grows as the band does, so the glyph
  // stays where it was in it; the rest of the height goes to the rows between.
  let first = 0, last = n - 1;
  while (first < n && !rows.inked[first]) first++;
  while (last >= first && !rows.inked[last]) last--;
  const shares = new Float64Array(n).fill(1 / n);
  const m = last - first + 1;
  if (m <= 0) return shares;

  const cost = new Float64Array(m);
  const along = new Float64Array(m);
  for (let r = first; r <= last; r++) {
    let bend = 0, flat = 0, end = false;
    // Drawn but never covered past half: the tip of a curve.
    let lone = rows.inked[r] && rows.edges[r].length === 0;
    rows.edges[r].forEach((_e, j) => {
      if (rows.ends[r][j] < rows.stroke / 2) end = true;
      const slope = rows.slopes[r][j];
      if (Number.isNaN(slope)) lone = true;
      else flat = Math.max(flat, Math.abs(slope));
      bend = Math.max(bend, rows.bends[r][j]);
    });
    const b = bend / BEND_HALF;
    const f = Math.max(flat - FLAT_START, 0) / FLAT_HALF;
    const bar = Math.min(Math.max(rows.longest[r] / rows.stroke - BAR_START, 0) / BAR_SPAN, 1);
    along[r - first] = bar;
    const bending = Math.min((1 + b * b) * (1 + f * f), BEND_COST_MAX) + (end ? END_COST : 0);
    cost[r - first] = bending + HOLD * (bar * bar + (lone ? 1 : 0));
  }
  // Ties between rows r and r + 1, through the edges that run on.
  const tie = new Float64Array(m);
  for (let r = first; r < last; r++) {
    let pull = 0;
    rows.next[r].forEach((j, i) => {
      if (j < 0) return;
      const a = rows.slopes[r][i], b = rows.slopes[r + 1][j];
      if (Number.isNaN(a) || Number.isNaN(b)) return;
      const slope = Math.abs(a + b) / 2, bend = (rows.bends[r][i] + rows.bends[r + 1][j]) / 2;
      pull = Math.max(pull, (slope / SLOPE_TIE) ** 2 + (bend / BEND_TIE) ** 2);
    });
    // Not into a bar, which keeps its thickness however the edges that
    // run into it grow.
    const reach = n * pull * (1 - along[r - first]) * (1 - along[r + 1 - first]);
    tie[r - first] = reach * reach;
  }
  // Each row takes in inverse to its cost, then the ties even that out:
  // minimising sum((k - 1 / cost)^2) + sum(tie * (k[r + 1] - k[r])^2), so
  // rows tied together take the mean of what they would alone.
  const diag = new Float64Array(m);
  for (let i = 0; i < m; i++) diag[i] = 1 + (i > 0 ? tie[i - 1] : 0) + tie[i];
  const k = solveTridiagonal(diag, tie, cost.map(c => 1 / c));
  let total = 0;
  for (let i = 0; i < m; i++) total += k[i];
  for (let i = 0; i < m; i++) shares[first + i] = k[i] / total * m / n;
  return shares;
}

/**
 * How much of a glyph's added height each row of coverage `alpha` (0-255,
 * `w` wide) takes, rows `top` to `bottom` (see the top of this section). The
 * shares add up to 1.
 */
export function rowShares(alpha: Uint8Array, w: number, top: number, bottom: number): Float64Array {
  return bandShares(bandRows(alpha, w, top, bottom));
}

/**
 * Coverage `alpha` (`w` x `h`) made `extra` rows taller between rows `top`
 * and `bottom`, the extra height spread by rowShares(); the rows above stay
 * where they are and the rows below move down. It is the middles of the
 * strokes that are spread out: every pixel moves down as far as the middle
 * of its stroke does, so strokes keep their width whichever way they run.
 */
export function tallen(alpha: Uint8Array, w: number, h: number, top: number, bottom: number, extra: number): Uint8Array {
  top = Math.min(Math.max(Math.round(top), 0), h - 1);
  bottom = Math.min(Math.max(Math.round(bottom), top + 1), h - 1);
  const rows = bandRows(alpha, w, top, bottom);
  const shares = bandShares(rows);
  // Where each row boundary lands.
  const lands = new Float64Array(h + 1);
  for (let y = 0; y <= h; y++) {
    const r = y - top;
    lands[y] = y + (r <= 0 ? 0 : r >= shares.length ? extra : lands[y - 1] - (y - 1) + shares[r - 1] * extra);
  }
  const land = (y: number) => {
    if (y <= 0) return y;
    if (y >= h) return y + extra;
    const i = Math.floor(y);
    return lands[i] + (y - i) * (lands[i + 1] - lands[i]);
  };

  // How far each pixel moves down. The middle of a stroke is found a pixel
  // at a time, so the moves are smoothed, or neighbouring columns would part
  // along a flat edge: weighted by the ink, so the room beside a stroke,
  // which may move with another, does not pull at its edge.
  const stroke = rows.stroke;
  const middles = strokeMiddles(alpha, w, h, stroke * FLAT_RUN);
  const sigma = MOVE_SMOOTHING * stroke;
  // Away from the ink every pixel moves with its row.
  const move = new Float32Array(w * h);
  for (let y = 0; y < h; y++) move.fill(land(y + 0.5) - y - 0.5, y * w, y * w + w);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] === 0) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 >= 0) {
    const pad = Math.ceil(sigma * 3) + 2;
    x0 = Math.max(x0 - pad, 0);
    y0 = Math.max(y0 - pad, 0);
    x1 = Math.min(x1 + pad, w - 1);
    y1 = Math.min(y1 + pad, h - 1);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const weighted = new Float32Array(cw * ch);
    const weights = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y0 + y) * w + x0 + x;
        const mid = Number.isNaN(middles[i]) ? y0 + y + 0.5 : middles[i];
        weights[y * cw + x] = alpha[i] / 255 + 1e-3;
        weighted[y * cw + x] = (land(mid) - mid) * weights[y * cw + x];
      }
    }
    const num = softened({ data: weighted, width: cw, height: ch }, sigma).data;
    const den = softened({ data: weights, width: cw, height: ch }, sigma).data;
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) move[(y0 + y) * w + x0 + x] = num[y * cw + x] / den[y * cw + x];
  }

  const out = new Uint8Array(w * (h + extra));
  // Where each pixel centre of a column lands, never above the one before.
  const z = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      z[y] = y + 0.5 + move[y * w + x];
      if (y > 0) z[y] = Math.max(z[y], z[y - 1]);
    }
    let y = 0;
    for (let oy = 0; oy < h + extra; oy++) {
      const o = oy + 0.5;
      while (y < h - 1 && z[y + 1] <= o) y++;
      let v;
      if (o <= z[0]) v = alpha[x];
      else if (y >= h - 1) v = alpha[(h - 1) * w + x];
      else {
        const f = Math.min((o - z[y]) / Math.max(z[y + 1] - z[y], 1e-9), 1);
        v = alpha[y * w + x] * (1 - f) + alpha[(y + 1) * w + x] * f;
      }
      out[oy * w + x] = Math.round(v);
    }
  }
  return out;
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

// Rows `top` to `bottom` of a layout (px) made `extra` px taller.
interface Tallness {
  top: number;
  bottom: number;
  extra: number;
}

// Draws `text` at SUPERSAMPLE times the size, stretched `stretch` times as wide
// (and made taller by `tall`, in px at that size) into a temporary PNG and reads
// its coverage back, with `margin` px of room around it. The coverage is in
// whole blocks of SUPERSAMPLE.
async function rasterize(face: TextFace, text: string, stretch: number, tall: Tallness | null,
  margin: number, cancellable: Gio.Cancellable): Promise<{ alpha: Uint8Array, width: number, height: number, originX: number, originY: number }> {
  const b = face.bounds(text, SUPERSAMPLE);
  const x0 = Math.floor(b.x0 * stretch) - margin;
  const y0 = b.y0 - margin;
  const x1 = Math.ceil(b.x1 * stretch) + margin;
  const y1 = b.y1 + margin;
  // Whole blocks of SUPERSAMPLE, so the downscaled field keeps its origin.
  const ax = x0 - ((x0 % SUPERSAMPLE) + SUPERSAMPLE) % SUPERSAMPLE;
  const ay = y0 - ((y0 % SUPERSAMPLE) + SUPERSAMPLE) % SUPERSAMPLE;
  const width = Math.ceil((x1 - ax) / SUPERSAMPLE) * SUPERSAMPLE;
  const height = Math.ceil((y1 - ay) / SUPERSAMPLE) * SUPERSAMPLE;

  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
  const cr = new Cairo.Context(surface);
  cr.setSourceRGBA(1, 1, 1, 1);
  cr.translate(-ax, -ay);
  cr.scale(stretch, 1);
  face.draw(cr, text, SUPERSAMPLE);
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
    if (!tall || tall.extra < 1) return { alpha, width: w, height: h, originX: -ax, originY: -ay };
    return { alpha: tallen(alpha, w, h, tall.top - ay, tall.bottom - ay, tall.extra), width: w,
      height: h + tall.extra, originX: -ax, originY: -ay };
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

/**
 * Distance fields of single glyphs of `face`, stretched `stretch` times as
 * wide and made `height` times as tall (see tallen()), built on first use.
 * `range` is how far (px) from the outline the fields reach.
 */
export class GlyphFields {
  private _glyphs = new Map<string, Promise<GlyphField>>();
  // Cancels the reads still running when the fields are no longer wanted.
  readonly cancellable = new Gio.Cancellable();
  // The rows the digits stand in, from their top to the baseline, and the
  // px added to them.
  private _tall: Tallness;
  /** The digits' height in the font as it is, px. */
  readonly digitHeight: number;

  constructor(private _face: TextFace, readonly range: number, readonly stretch = 1, readonly height = 1) {
    const [top, baseline] = _face.digitBand();
    this.digitHeight = Math.max(baseline - top, 1);
    this._tall = { top, bottom: baseline, extra: Math.round((height - 1) * this.digitHeight) };
  }

  private _glyph(ch: string): Promise<GlyphField> {
    let glyph = this._glyphs.get(ch);
    if (!glyph) {
      const tall = { top: this._tall.top * SUPERSAMPLE, bottom: this._tall.bottom * SUPERSAMPLE,
        extra: this._tall.extra * SUPERSAMPLE };
      glyph = rasterize(this._face, ch, this.stretch, tall, this.range * SUPERSAMPLE, this.cancellable).then(big => {
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
    const x0 = Math.floor(b.x0 * this.stretch) - r;
    const y0 = b.y0 - r;
    const width = Math.ceil(b.x1 * this.stretch) + r - x0;
    const height = b.y1 + this._tall.extra + r - y0;
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
