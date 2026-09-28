const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createModuleLoader } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');

function fixture(bmsRects) {
  const load = createModuleLoader({ UILayerSampler: class {}, WindowCloneManager: class {} });
  const { syncGlassCaptureClip } = load(path.join(dist, 'capture/clip.js'));
  const options = load(path.join(dist, 'capture/options.js'));
  const culls = [];
  const effect = { getCaptureClipRect: () => [100, 900, 400, 100], getResolution: () => [1920, 1080] };
  const uiSampler = { hasUnmeasuredBmsReplica: () => false, getBmsScreenRects: () => bmsRects,
    setCullRect: rect => culls.push(rect) };
  const sync = () => syncGlassCaptureClip({ cloneContainer: null, effect, originX: 0, originY: 0, uiSampler });
  return { sync, culls, effect, options };
}

test('a Blur My Shell panel band out of the glass reach no longer widens its cull rect', () => {
  const f = fixture([[0, 0, 1920, 32]]);
  f.sync();
  assert.deepEqual(f.culls.at(-1), [100, 900, 400, 100]);
  assert.deepEqual(f.effect._lgCaptureScreenRect, [100, 900, 400, 100], 'the capture ROI is published for nested glass');
});

test('a reachable band is still unioned, and the cullBms switch restores the old unconditional union', () => {
  const near = fixture([[0, 880, 1920, 32]]);
  near.sync();
  assert.deepEqual(near.culls.at(-1), [0, 880, 1920, 120]);
  const far = fixture([[0, 0, 1920, 32]]);
  far.options.setCullSiteEnabled('bms', false);
  try {
    far.sync();
    assert.deepEqual(far.culls.at(-1), [0, 0, 1920, 1000]);
  } finally {
    far.options.setCullSiteEnabled('bms', true);
  }
});
