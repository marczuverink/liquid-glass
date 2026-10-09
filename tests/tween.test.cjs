const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { RectTween } = loadModule(path.join(dist, 'animation/tween.js'), {});

test('a tween reaches its target in its time and never passes it', () => {
  const tween = new RectTween(200);
  tween.start([0, 0, 100, 100], [0, 0, 100, 300], 0);
  let last = 100;
  for (let us = 0; us <= 250000; us += 16000) {
    const h = tween.rect(us)[3];
    assert.ok(h >= last && h <= 300, `${us}: ${h}`);
    last = h;
  }
  assert.deepEqual(tween.rect(200000), [0, 0, 100, 300]);
});

test('a new target eases on from where the rect is, and the same target does not restart it', () => {
  const tween = new RectTween(200);
  tween.start([0, 0, 100, 100], [0, 0, 100, 300], 0);
  const mid = tween.rect(100000);
  tween.setTarget([0, 0, 100, 300.2], 100000);
  assert.deepEqual(tween.rect(100000), mid);
  assert.equal(tween.rect(200000)[3], 300);
  tween.setTarget([0, 0, 100, 150], 100000);
  assert.deepEqual(tween.rect(100000), mid);
  assert.equal(tween.rect(300000)[3], 150);
});
