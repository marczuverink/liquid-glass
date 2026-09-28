const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { gpuFixture, dist } = require('./helpers/gpu.cjs');
const referencePaint = require('./fixtures/paint-target-reference.cjs');

async function fixture(reference, method) {
  const f = gpuFixture();
  const { LiquidEffect } = f.load(path.join(dist, 'liquidEffect.js'));
  const actor = { get_size: () => [800, 600], get_paint_opacity: () => 128,
    get_name: () => 'test', queue_redraw() {}, get_parent: () => null };
  const effect = new LiquidEffect({ extensionPath: '/ext', logger: f.logger, actor, texture: f.texture(803, 603) });
  await new Promise(resolve => setImmediate(resolve));
  if (reference) effect.vfunc_paint_target = referencePaint({ ...f.bindings,
    frameClock: f.load(path.join(dist, 'rendering/frameClock.js')),
    configureSamplerLayer: f.load(path.join(dist, 'rendering/pipelines.js')).configureSamplerLayer,
  }).prototype.vfunc_paint_target;
  effect.setBlurMethod(method);
  effect.setResolution(800, 600);
  effect.setGlassGeometry(0, 0, 800, 600);
  const describeNode = node => ({ rect: node.rect,
    textures: node.pipeline ? [...node.pipeline.layers].map(([i, t]) => [i, t.get_width(), t.get_height()]) : [],
    uniforms: node.pipeline ? [...node.pipeline.uniforms] : [], color: node.pipeline?.color,
    output: node.fbo ? [node.fbo.texture.get_width(), node.fbo.texture.get_height()] : null,
    children: node.children?.map(describeNode) });
  return { ...f, effect, actor, paint() {
    const root = f.root(), repaints = effect.repaints;
    effect.vfunc_paint_target(root, {});
    assert.equal(effect.repaints, repaints, 'painting must not request another repaint');
    return { draw: describeNode(root), fallbacks: effect.fallbacks,
      diag: effect._diagLast, errors: f.errors, textures: f.textures.length,
      offset: actor._lgCaptureOffset, runs: effect._blurRuns, skips: effect._blurSkips, hits: effect._blurCacheHits };
  } };
}

for (const method of [0, 1]) test(`paint stages match the original pipeline for blur method ${method}`, async () => {
  const current = await fixture(false, method), original = await fixture(true, method);
  const scenarios = [
    () => {},
    () => {},
    f => { for (const cb of f.stageHandlers.values()) cb(); },
    f => { f.effect.vfunc_paint(f.root(), {}, 1); for (const cb of f.stageHandlers.values()) cb(); },
    f => f.effect.setGlassGeometry(250, 250, 100, 100),
    f => f.effect.setGlassGeometry(260, 250, 100, 100),
    f => { f.actor.get_size = () => [1000, 700]; f.effect.setResolution(1000, 700); },
    f => f.effect.setBlurRadius(0),
    f => f.effect.setBlurRadius(20),
    f => { f.effect._diagEnabled = true; f.effect._cropPassEnabled = false; },
    f => { f.actor.get_size = () => [NaN, 0]; },
    f => { f.failAllocation(true); f.effect.setResolution(1300, 900); f.actor.get_size = () => [1300, 900]; },
    f => { f.failAllocation(false); },
    f => { f.effect.texture = null; },
    f => { f.effect.texture = f.texture(1000, 700); f.effect._shadersLoaded = false; },
    f => { f.effect._shadersLoaded = true; f.effect.actor = null; },
  ];
  for (const [index, change] of scenarios.entries()) {
    change(current); change(original);
    assert.deepEqual(structuredClone(current.paint()), structuredClone(original.paint()), `scenario ${index}`);
  }
  current.effect.cleanup(); original.effect.cleanup();
});
