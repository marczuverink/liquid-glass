const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const placement = loadModule(path.join(dist, 'desktop/placement.js'), {});
const rect = { x: 100, y: 200, width: 300, height: 150 };

test('a right or bottom handle grows the rect away from its left and top edges', () => {
  assert.deepEqual(placement.resizeRect(rect, 1, 0, 50, 999, 48), { x: 100, y: 200, width: 350, height: 150 });
  assert.deepEqual(placement.resizeRect(rect, 0, 1, 999, -30, 48), { x: 100, y: 200, width: 300, height: 120 });
});

test('a left or top handle keeps the opposite edge where it was', () => {
  const r = placement.resizeRect(rect, -1, -1, 40, -20, 48);
  assert.deepEqual(r, { x: 140, y: 180, width: 260, height: 170 });
  assert.equal(r.x + r.width, rect.x + rect.width);
  assert.equal(r.y + r.height, rect.y + rect.height);
});

test('a rect is never resized below the minimum, whichever edge moves', () => {
  assert.equal(placement.resizeRect(rect, 1, 0, -1000, 0, 48).width, 48);
  const r = placement.resizeRect(rect, -1, 0, 1000, 0, 48);
  assert.deepEqual([r.x, r.width], [rect.x + rect.width - 48, 48]);
});

test('a moved item keeps its centre as a fraction of the work area', () => {
  const area = { x: 0, y: 32, width: 1920, height: 1048 };
  const fraction = placement.fractionOf([860, 500], area, [200, 100]);
  assert.deepEqual(placement.placeAtFraction(fraction, area, [200, 100]), [860, 500]);
  assert.deepEqual(placement.placeAtFraction([1, 1], area, [200, 100]), [1720, 980]);
});
