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
  const perRow = (a, b) => shares.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
  // The rows away from the curves take several times what the curves' rows do.
  const middle = perRow(15, 25), curves = (perRow(0, 8) + perRow(32, 40)) / 2;
  assert.ok(middle > curves * 3, `middle ${middle.toFixed(4)} curves ${curves.toFixed(4)}`);
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

test('a 4 grows along its slanted upper part as well as its stem', () => {
  // A 4: a diagonal from the top of the stem down to the bar, the stem in
  // columns 40-49 from row 10 to 90, and the bar across rows 60-69.
  const [w, h] = [70, 100];
  const alpha = coverage(w, h, (x, y) => {
    const stem = x >= 39.5 && x < 49.5 && y >= 9.5 && y < 89.5;
    const bar = x >= 9.5 && x < 59.5 && y >= 59.5 && y < 69.5;
    // The diagonal's left edge runs from (40, 10) to (10, 60), 12 px wide.
    const left = 40 - (y - 10) * 0.6;
    const diagonal = y >= 9.5 && y < 60 && x >= left && x < left + 12;
    return stem || bar || diagonal;
  });
  const shares = glyphs.rowShares(alpha, w, 10, 90);
  const perRow = (a, b) => shares.slice(a - 10, b - 10).reduce((s, v) => s + v, 0) / (b - a);
  const upper = perRow(25, 50), lower = perRow(75, 88);
  assert.ok(upper > lower * 0.6, `upper ${upper.toFixed(4)} lower ${lower.toFixed(4)}`);
  // The bar keeps its thickness.
  assert.ok(perRow(61, 68) < lower * 0.2, `bar ${perRow(61, 68).toFixed(4)}`);
});

test('a band that starts and ends between rows is taken to the nearest rows', () => {
  const [w, h] = [20, 40];
  const alpha = coverage(w, h, (x, y) => x >= 7.5 && x < 12.5 && y >= 9.5 && y < 30.5);
  const tall = glyphs.tallen(alpha, w, h, 9.6, 30.4, 10);
  assert.equal(coveredRows(tall, w, h + 10, 10).length, 31);
});

test('a slanted straight stroke stays straight when the glyph grows, whatever starts beside it', () => {
  // A 4 whose stem starts halfway down its diagonal, as in condensed fonts.
  const [w, h] = [70, 100];
  const alpha = coverage(w, h, (x, y) => {
    const stem = x >= 39.5 && x < 49.5 && y >= 34.5 && y < 89.5;
    const bar = x >= 9.5 && x < 59.5 && y >= 59.5 && y < 69.5;
    const left = 40 - (y - 10) * 0.6;
    const diagonal = y >= 9.5 && y < 60 && x >= left && x < left + 12;
    return stem || bar || diagonal;
  });
  const extra = 40;
  const tall = glyphs.tallen(alpha, w, h, 10, 90, extra);
  // The diagonal's left edge, row by row, to a fraction of a pixel.
  const xs = [], ys = [];
  for (let y = 0; y < h + extra; y++) {
    for (let x = 1; x < 39; x++) {
      const a = tall[y * w + x - 1], b = tall[y * w + x];
      if (a < 128 && b >= 128) {
        xs.push(x - 1 + (127.5 - a) / (b - a));
        ys.push(y);
        break;
      }
    }
  }
  // Away from its ends, where it meets the stem's top and the bar.
  const pts = xs.map((x, i) => [ys[i], x]).filter(([y]) => y > ys[0] + 6 && y < 60 + extra * 0.4);
  assert.ok(pts.length > 30, `only ${pts.length} rows of the diagonal`);
  const n = pts.length;
  const my = pts.reduce((s, [y]) => s + y, 0) / n, mx = pts.reduce((s, [, x]) => s + x, 0) / n;
  const slope = pts.reduce((s, [y, x]) => s + (y - my) * (x - mx), 0) / pts.reduce((s, [y]) => s + (y - my) ** 2, 0);
  const worst = Math.max(...pts.map(([y, x]) => Math.abs(mx + slope * (y - my) - x)));
  assert.ok(worst < 0.5, `the diagonal strays ${worst.toFixed(2)} px from a straight line`);
});

// The width of the ink across row y of `alpha` (`w` wide) around column x.
function runAt(alpha, w, y, x) {
  let a = x, b = x;
  while (a > 0 && alpha[y * w + a - 1] >= 128) a--;
  while (b < w - 1 && alpha[y * w + b + 1] >= 128) b++;
  return alpha[y * w + x] >= 128 ? b - a + 1 : 0;
}

test('a slanted stroke keeps its width when the glyph grows', () => {
  // A stroke 10 px wide slanting at 45 degrees from (10, 10) to (60, 60).
  const [w, h] = [80, 80];
  const across = 10 * Math.SQRT2;
  const alpha = coverage(w, h, (x, y) => y >= 9.5 && y < 60.5 && Math.abs(x - y) < across / 2);
  const extra = 50;
  const tall = glyphs.tallen(alpha, w, h, 10, 60, extra);
  // Twice as tall, the stroke slants at atan(2); 10 px wide across its slant
  // it spans 10 / sin(atan(2)) = 11.2 px across a row (the plain stretch: 14.1).
  const y = 10 + Math.round((60 + extra - 10) / 2);
  const x = Math.round(10 + (y - 10) / 2);
  const run = runAt(tall, w, y, x);
  assert.ok(Math.abs(run - 10 / Math.sin(Math.atan(2))) <= 1.5, `${run} px across`);
});

test('a ring with nothing upright grows evenly and keeps its width all round', () => {
  // An ellipse 60 x 80 px with a stroke 8 px wide.
  const [w, h] = [80, 100];
  const ring = (x, y, a, b) => ((x - 40) / a) ** 2 + ((y - 50) / b) ** 2 < 1;
  const alpha = coverage(w, h, (x, y) => ring(x, y, 30, 40) && !ring(x, y, 22, 32));
  const tall = glyphs.tallen(alpha, w, h, 10, 90, 80);
  const rows = coveredRows(tall, w, h + 80, 40);
  // Top and bottom still 8 rows thick.
  const runs = [];
  for (const y of rows) {
    if (runs.length && runs[runs.length - 1][1] === y - 1) runs[runs.length - 1][1] = y;
    else runs.push([y, y]);
  }
  assert.equal(runs.length, 2, JSON.stringify(runs));
  for (const [a, b] of runs) assert.ok(Math.abs(b - a + 1 - 8) <= 1, JSON.stringify(runs));
  // Its outside spans the band, 160 rows.
  assert.ok(Math.abs(runs[1][1] - runs[0][0] + 1 - 160) <= 2, JSON.stringify(runs));
  // And its sides are 8 px wide halfway down.
  assert.ok(Math.abs(runAt(tall, w, 90, 14) - 8) <= 1, String(runAt(tall, w, 90, 14)));
});

test('the cut end of a flat stroke stays square where its rows grow', () => {
  // A bar 8 rows thick from x = 10 to 50 hanging off an upright stroke, all
  // in rows that grow evenly with a ring beside them.
  const [w, h] = [100, 100];
  const ring = (x, y, a, b) => ((x - 75) / a) ** 2 + ((y - 50) / b) ** 2 < 1;
  const alpha = coverage(w, h, (x, y) => (x >= 9.5 && x < 50.5 && y >= 45.5 && y < 53.5) ||
    (x >= 42.5 && x < 50.5 && y >= 9.5 && y < 90.5) || (ring(x, y, 20, 40) && !ring(x, y, 12, 32)));
  const tall = glyphs.tallen(alpha, w, h, 10, 90, 80);
  // The bar's rows down its free end and further in.
  const end = coveredRows(tall, w, h + 80, 11), inner = coveredRows(tall, w, h + 80, 30);
  assert.ok(Math.abs(end.length - 8) <= 1 && Math.abs(inner.length - 8) <= 1, `${end} / ${inner}`);
  assert.ok(Math.abs(end[0] - inner[0]) <= 1, `${end[0]} vs ${inner[0]}`);
});
