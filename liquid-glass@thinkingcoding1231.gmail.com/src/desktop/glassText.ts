// The outline of a line of text as a signed distance field, for glass whose
// shape is the text itself (the glass clock).
//
// GJS cannot read a Cairo surface's pixels or a texture's back, so each glyph
// is drawn with Pango into a Cairo surface that is written to a PNG and
// decoded here. Glyphs are measured once per font and kept: a new time only
// places the cached fields side by side.
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'cairo';

import { coglContext } from '../shellVersion.js';

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

// Distance transform (Felzenszwalb and Huttenlocher), squared distances

const INF = 1e20;

function transform1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Squared distance from every pixel to the nearest pixel where `feature` is set.
function squaredDistances(feature: (i: number) => boolean, w: number, h: number): Float64Array {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = feature(i) ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    transform1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    transform1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  return grid;
}

/** Signed distances (px, negative inside) from coverage, with pixel centres on the edge at half coverage. */
export function signedDistances(alpha: Uint8Array, w: number, h: number): Float32Array {
  const inside = (i: number) => alpha[i] >= 128;
  const toInside = squaredDistances(inside, w, h);
  const toOutside = squaredDistances(i => !inside(i), w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    out[i] = inside(i) ? -(Math.sqrt(toOutside[i]) - 0.5) : Math.sqrt(toInside[i]) - 0.5;
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

// The union of a layout's ink and logical rects, px.
function bounds(layout: Pango.Layout): { x0: number, y0: number, x1: number, y1: number } {
  const [ink, logical] = layout.get_pixel_extents();
  return {
    x0: Math.floor(Math.min(ink!.x, logical!.x)),
    y0: Math.floor(Math.min(ink!.y, logical!.y)),
    x1: Math.ceil(Math.max(ink!.x + ink!.width, logical!.x + logical!.width)),
    y1: Math.ceil(Math.max(ink!.y + ink!.height, logical!.y + logical!.height)),
  };
}

function layoutFor(cr: any, font: Pango.FontDescription, text: string): Pango.Layout {
  const layout = PangoCairo.create_layout(cr);
  layout.set_font_description(font);
  layout.set_text(text, -1);
  return layout;
}

// Draws `text` stretched `stretch` times as wide into a temporary PNG and reads
// its coverage back, with `margin` px of room around it. The coverage is in
// whole blocks of SUPERSAMPLE.
async function rasterize(font: Pango.FontDescription, text: string, stretch: number, margin: number,
  cancellable: Gio.Cancellable): Promise<{ alpha: Uint8Array, width: number, height: number, originX: number, originY: number }> {
  const probe = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
  const probeCr = new Cairo.Context(probe);
  const b = bounds(layoutFor(probeCr, font, text));
  probeCr.$dispose();
  probe.finish();

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
  PangoCairo.show_layout(cr, layoutFor(cr, font, text));
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
    return { ...decodePngAlpha(bytes), originX: -ax, originY: -ay };
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
 * Distance fields of single glyphs in one font, stretched `stretch` times as
 * wide, built on first use. `range` is how far (px) from the outline the
 * fields reach.
 */
export class GlyphFields {
  private _glyphs = new Map<string, Promise<GlyphField>>();
  // Cancels the reads still running when the fields are no longer wanted.
  readonly cancellable = new Gio.Cancellable();
  private _font: Pango.FontDescription;
  private _bigFont: Pango.FontDescription;

  constructor(fontDescription: string, readonly size: number, readonly range: number, readonly stretch = 1) {
    this._font = Pango.FontDescription.from_string(fontDescription);
    this._font.set_absolute_size(size * Pango.SCALE);
    this._bigFont = this._font.copy()!;
    this._bigFont.set_absolute_size(size * SUPERSAMPLE * Pango.SCALE);
  }

  private _glyph(ch: string): Promise<GlyphField> {
    let glyph = this._glyphs.get(ch);
    if (!glyph) {
      glyph = rasterize(this._bigFont, ch, this.stretch, this.range * SUPERSAMPLE, this.cancellable).then(big => {
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
  async fieldFor(text: string): Promise<DistanceField & { maxDepth: number }> {
    const glyphs = new Map<string, GlyphField>();
    for (const ch of new Set(text)) {
      if (!/\s/.test(ch)) glyphs.set(ch, await this._glyph(ch));
    }

    const probe = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
    const probeCr = new Cairo.Context(probe);
    const layout = layoutFor(probeCr, this._font, text);
    const b = bounds(layout);
    const r = this.range;
    const x0 = Math.floor(b.x0 * this.stretch) - r;
    const y0 = b.y0 - r;
    const width = Math.ceil(b.x1 * this.stretch) + r - x0;
    const height = b.y1 + r - y0;
    const data = new Float32Array(width * height).fill(r);

    // Pango indexes the text by UTF-8 byte.
    const encoder = new TextEncoder();
    let byteIndex = 0;
    for (const ch of text) {
      const pos = layout.index_to_pos(byteIndex);
      byteIndex += encoder.encode(ch).length;
      const glyph = glyphs.get(ch);
      if (!glyph) continue;
      const left = Math.round(pos.x / Pango.SCALE * this.stretch - glyph.originX - x0);
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
    }
    probeCr.$dispose();
    probe.finish();

    let maxDepth = 0;
    for (let i = 0; i < data.length; i++) maxDepth = Math.max(maxDepth, -data[i]);
    return { data, width, height, maxDepth };
  }
}

/**
 * A texture of `field` for glass.frag's LG_SHAPE_TEXTURE: distances from
 * -range to +range in 16 bits, the high byte in red and the low in green.
 * Throws a GError when the texture cannot be made.
 */
export function fieldTexture(field: DistanceField, range: number): Cogl.Texture {
  const { data, width, height } = field;
  const bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const t = Math.min(Math.max((data[i] + range) / (2 * range), 0), 1);
    const v = Math.round(t * 65535);
    bytes[i * 4] = v >> 8;
    bytes[i * 4 + 1] = v & 255;
    bytes[i * 4 + 3] = 255;
  }
  return Cogl.Texture2D.new_from_data(coglContext(), width, height, Cogl.PixelFormat.RGBA_8888, width * 4, bytes);
}
