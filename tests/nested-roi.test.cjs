const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

class Offscreen { constructor(texture) { this.texture = texture; } get_texture() { return this.texture; } }
const roi = loadModule(path.join(dist, 'rendering/nestedRoi.js'), { Cogl: { Offscreen } });
const context = texture => ({ get_framebuffer: () => new Offscreen(texture) });
const actor = (dx, dy) => ({ transform_stage_point: (x, y) => [true, x - dx, y - dy] });

test('a nested glass maps the enclosing glass region into its own space, padded and clamped', () => {
  const outer = { _lgCaptureScreenRect: [100, 200, 300, 100] }, inner = {}, capture = {};
  roi.registerCaptureOwner(outer, capture, null);
  assert.deepEqual(roi.nestedCompositeRoi(inner, actor(50, 150), context(capture), 1000, 1000), [48, 48, 352, 152]);
  assert.deepEqual(roi.nestedCompositeRoi(inner, actor(0, 0), context(capture), 380, 250), [98, 198, 380, 250]);
  roi.unregisterCaptureOwner(outer, capture);
});

test('no region is used for the on-screen framebuffer, an own capture, an unknown texture or a missing rect', () => {
  const outer = { _lgCaptureScreenRect: [0, 0, 10, 10] }, inner = {}, capture = {};
  roi.registerCaptureOwner(outer, capture, null);
  assert.equal(roi.nestedCompositeRoi(inner, actor(0, 0), { get_framebuffer: () => ({}) }, 100, 100), null);
  assert.equal(roi.nestedCompositeRoi(outer, actor(0, 0), context(capture), 100, 100), null);
  assert.equal(roi.nestedCompositeRoi(inner, actor(0, 0), context({}), 100, 100), null);
  assert.equal(roi.nestedCompositeRoi(inner, { transform_stage_point: () => [false, 0, 0] }, context(capture), 100, 100), null);
  outer._lgCaptureScreenRect = null;
  assert.equal(roi.nestedCompositeRoi(inner, actor(0, 0), context(capture), 100, 100), null);
  roi.unregisterCaptureOwner(outer, capture);
  outer._lgCaptureScreenRect = [0, 0, 10, 10];
  assert.equal(roi.nestedCompositeRoi(inner, actor(0, 0), context(capture), 100, 100), null, 'unregistered owners are forgotten');
});

test('re-registering a new capture texture releases the old one', () => {
  const outer = { _lgCaptureScreenRect: [0, 0, 10, 10] }, inner = {}, first = {}, second = {};
  let current = roi.registerCaptureOwner(outer, first, null);
  current = roi.registerCaptureOwner(outer, second, current);
  assert.equal(roi.nestedCompositeRoi(inner, actor(0, 0), context(first), 100, 100), null);
  assert.ok(roi.nestedCompositeRoi(inner, actor(0, 0), context(second), 100, 100));
  roi.unregisterCaptureOwner(outer, current);
});

test('the composite rect is clamped to the region, skipped outside it and left alone inside it', () => {
  assert.deepEqual(roi.clampToRoi(null, [10, 20, 60, 80], 100, 100), { rect: [10, 20, 50, 60], skip: false, clamped: true });
  assert.deepEqual(roi.clampToRoi([40, 40, 10, 10], [0, 0, 100, 100], 100, 100), { rect: [40, 40, 10, 10], skip: false, clamped: false });
  assert.equal(roi.clampToRoi([0, 0, 10, 10], [50, 50, 60, 60], 100, 100).skip, true);
});
