const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const glyphs = loadModule(path.join(dist, 'desktop/glassText.js'), {});

// Anti-aliased coverage (0-255) of `inside(x, y)`, 16 x 16 samples per pixel.
function coverage(w, h, inside) {
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let j = 0; j < 16; j++)
        for (let i = 0; i < 16; i++) if (inside(x - 0.5 + (i + 0.5) / 16, y - 0.5 + (j + 0.5) / 16)) n++;
      alpha[y * w + x] = Math.round(n / 256 * 255);
    }
  }
  return alpha;
}

test('the distances round a circle follow the circle, not the pixels', () => {
  const [w, h, cx, cy, r] = [64, 64, 31.3, 32.6, 19.4];
  const field = glyphs.signedDistances(coverage(w, h, (x, y) => Math.hypot(x - cx, y - cy) < r), w, h);
  let worst = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const exact = Math.hypot(x - cx, y - cy) - r;
      if (Math.abs(exact) < 6) worst = Math.max(worst, Math.abs(field[y * w + x] - exact));
    }
  }
  assert.ok(worst < 0.1, `worst error ${worst.toFixed(3)} px`);
});

test('a straight edge between whole pixels is half a pixel from either side', () => {
  const field = glyphs.signedDistances(coverage(20, 8, x => x < 9.5), 20, 8);
  assert.ok(Math.abs(field[4 * 20 + 9] + 0.5) < 1e-6, String(field[4 * 20 + 9]));
  assert.ok(Math.abs(field[4 * 20 + 10] - 0.5) < 1e-6, String(field[4 * 20 + 10]));
  assert.ok(Math.abs(field[4 * 20 + 15] - 5.5) < 1e-6, String(field[4 * 20 + 15]));
});

test('softening keeps a straight edge where it is and rounds the fold in a corner', () => {
  const [w, h] = [80, 80];
  // A square from 20 to 60.
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const qx = Math.abs(x - 40) - 20, qy = Math.abs(y - 40) - 20;
      data[y * w + x] = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    }
  const soft = glyphs.softened({ data, width: w, height: h }, 4).data;
  // Mid-side, the distance is still linear across the edge.
  for (const x of [17, 20, 23, 26]) assert.ok(Math.abs(soft[40 * w + x] - data[40 * w + x]) < 0.05, `x=${x}`);
  // On the corner's bisector the field was folded (its slope turned by 90
  // degrees); softened, its slope across the bisector turns gradually.
  const slope = (f, x, y) => [(f[y * w + x + 1] - f[y * w + x - 1]) / 2, (f[(y + 1) * w + x] - f[(y - 1) * w + x]) / 2];
  const [ax] = slope(soft, 27, 26), [bx] = slope(soft, 26, 27);
  assert.ok(Math.abs(ax - bx) < 0.5, `${ax} vs ${bx}`);
  assert.equal(glyphs.maxDepth({ data, width: w, height: h }), 20);
});

// Rows (from the top) where column x is covered at least half.
function coveredRows(alpha, w, h, x) {
  const rows = [];
  for (let y = 0; y < h; y++) if (alpha[y * w + x] >= 128) rows.push(y);
  return rows;
}

test('a taller glyph lengthens its upright stroke and keeps its bars as thick', () => {
  // An I: bars across rows 10-14 and 50-54, a stem in columns 20-29 between them.
  const [w, h] = [50, 70];
  const alpha = coverage(w, h, (x, y) => (y >= 9.5 && y < 54.5 && x >= 19.5 && x < 29.5) ||
    (((y >= 9.5 && y < 14.5) || (y >= 49.5 && y < 54.5)) && x >= 9.5 && x < 39.5));
  const tall = glyphs.tallen(alpha, w, h, 10, 55, 20);
  // At the bars' ends only the bars are covered: still 5 rows each.
  const bar = coveredRows(tall, w, h + 20, 12);
  assert.deepEqual(bar, [10, 11, 12, 13, 14, 70, 71, 72, 73, 74]);
  // The stem runs between them, 20 rows longer.
  assert.deepEqual(coveredRows(tall, w, h + 20, 25), Array.from({ length: 65 }, (_, i) => 10 + i));
  // Above the glyph nothing moved.
  assert.deepEqual(tall.subarray(0, 10 * w), alpha.subarray(0, 10 * w));
});

test('the added height goes to the rows where the outline runs upright', () => {
  // An O: the rows round its top and bottom curve, the middle ones run upright.
  const [w, h] = [60, 60];
  const alpha = coverage(w, h, (x, y) => {
    const d = Math.hypot((x - 30) / 20, Math.max(Math.abs(y - 30) - 10, 0) / 20);
    return d < 1 && Math.hypot((x - 30) / 10, Math.max(Math.abs(y - 30) - 10, 0) / 10) >= 1;
  });
  const shares = glyphs.rowShares(alpha, w, 10, 50);
  const middle = shares.slice(10, 30).reduce((a, b) => a + b, 0);
  const ends = shares.slice(0, 5).reduce((a, b) => a + b, 0) + shares.slice(35).reduce((a, b) => a + b, 0);
  assert.ok(middle > 0.8, `middle ${middle}`);
  assert.ok(ends < 0.05, `ends ${ends}`);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('a round dot keeps its shape and the space round it takes the height', () => {
  // A colon: two round dots, the gap between them and the room round them.
  const [w, h] = [40, 100];
  const alpha = coverage(w, h, (x, y) => Math.hypot(x - 20, y - 30) < 8 || Math.hypot(x - 20, y - 80) < 8);
  const shares = glyphs.rowShares(alpha, w, 10, 95);
  const dot = shares.slice(14, 26).reduce((a, b) => a + b, 0);
  assert.ok(dot < 0.05, `the dot takes ${dot}`);
  const tall = glyphs.tallen(alpha, w, h, 10, 95, 50);
  const rows = coveredRows(tall, w, h + 50, 20);
  const runs = rows.filter((y, i) => i === 0 || rows[i - 1] !== y - 1).length;
  assert.equal(runs, 2);
  // Each dot is still about 16 rows tall.
  assert.ok(Math.abs(rows.filter(y => y < 60).length - 16) <= 1, String(rows.filter(y => y < 60).length));
});
