const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const { Spring, SwiftSpring } = loadModule(path.join(dist, 'animation/spring.js'));
const { stepMenuSprings } = loadModule(path.join(dist, 'animation/menuSpring.js'));

function referenceStep(scaleSpring, posSpring, elapsedMs) {
  const isClosing = scaleSpring.target === 0;
  let dt = elapsedMs / 1000;
  if (dt > 0.033) dt = 0.033;
  let stopped = false;
  let s;
  if (isClosing) {
    const speed = 15.0;
    scaleSpring.value += (0 - scaleSpring.value) * (1.0 - Math.exp(-speed * dt));
    posSpring.value += (0 - posSpring.value) * (1.0 - Math.exp(-speed * dt));
    s = scaleSpring.value;
    if (s < 0.005) { s = 0; stopped = true; }
  } else {
    stopped = scaleSpring.update(elapsedMs) && posSpring.update(elapsedMs);
    s = scaleSpring.value;
    if (Math.abs(1.0 - s) < 0.002 && Math.abs(scaleSpring.velocity) < 0.03) { s = 1.0; stopped = true; }
  }
  let scale, opacity;
  if (isClosing) {
    scale = Math.max(0.001, s);
    opacity = Math.min(255, Math.max(0, (s - 0.3) / 0.7 * 255));
  } else {
    scale = 0.2 + (s * 0.8);
    opacity = Math.min(255, Math.max(0, (s / 0.3) * 255));
  }
  return { closing: isClosing, stopped, scale, opacity };
}

function pair(kind) {
  return kind === 'swift'
    ? [new SwiftSpring(0.4, 0.7), new SwiftSpring(0.4, 0.7)]
    : [new Spring(120, 8, 1), new Spring(300, 12, 1)];
}

function lcg(seed) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

for (const kind of ['euler', 'swift']) test(`${kind} open/close steps match the original inline animation`, () => {
  const rand = lcg(kind === 'swift' ? 7 : 3);
  for (let run = 0; run < 40; run++) {
    const [a1, b1] = pair(kind), [a2, b2] = pair(kind);
    let target = 1;
    for (let frame = 0; frame < 400; frame++) {
      if (rand() < 0.01) target = target ? 0 : 1;
      a1.target = b1.target = a2.target = b2.target = target;
      const ms = rand() < 0.05 ? 40 + rand() * 200 : 6 + rand() * 12;
      assert.deepEqual(stepMenuSprings(a1, b1, ms), referenceStep(a2, b2, ms), `run ${run} frame ${frame}`);
      assert.deepEqual([a1.value, a1.velocity, b1.value, b1.velocity], [a2.value, a2.velocity, b2.value, b2.velocity]);
    }
  }
});

test('opening only advances the position spring once the scale spring has settled', () => {
  const calls = [];
  const spring = (name, settled) => ({ value: 0.5, velocity: 1, target: 1,
    update() { calls.push(name); return settled; } });
  stepMenuSprings(spring('scale', false), spring('pos', true), 16);
  assert.deepEqual(calls, ['scale']);
});
