const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

const { MenuMorphMotion } = loadModule(path.join(dist, 'animation/menuMorph.js'), {});

// The date button in the middle of the top bar and the calendar under it.
const BUTTON = [860, 4, 200, 26];
const MENU = [610, 40, 700, 420];
const RADIUS = 20;
const centre = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];
const near = (a, b, within) => a.every((v, i) => Math.abs(v - b[i]) <= within);

// Steps at 60 fps until done (or 3 s), calling `each` with every frame and its time.
function run(motion, each = () => {}) {
  let frame = motion.frame;
  for (let t = 1 / 60; t < 3; t += 1 / 60) {
    frame = motion.step(1 / 60);
    each(frame, t);
    if (frame.done) return { frame, t };
  }
  return { frame, t: Infinity };
}

test('opening starts on the button and comes to rest on the menu', () => {
  const motion = new MenuMorphMotion(true, BUTTON, MENU, RADIUS);
  const first = motion.frame;
  assert.ok(near(first.button, BUTTON, 0), `button glass ${first.button}`);
  assert.ok(near(centre(first.body), centre(BUTTON), 6), `body ${first.body}`);
  assert.ok(first.body[2] <= 40 && first.contentOpacity < 0.2, `body ${first.body}`);
  assert.ok(first.lens > 0.9);

  const { frame, t } = run(motion);
  assert.ok(t < 1.5, `took ${t}s`);
  assert.ok(near(frame.body, MENU, 0.5), `body ${frame.body}`);
  assert.equal(frame.bodyRadius, RADIUS);
  assert.equal(frame.contentScale, 1);
  assert.ok(frame.contentOpacity > 0.99 && frame.lens === 0 && frame.glassOpacity === 1);
  // The button's glass waits in the middle of the menu, half its size.
  assert.ok(near(centre(frame.button), centre(MENU), 0.5) && Math.abs(frame.button[2] - 100) < 1);
});

test('the button reaches the middle of the menu before the menu has grown', () => {
  const motion = new MenuMorphMotion(true, BUTTON, MENU, RADIUS);
  let arrived = null;
  run(motion, (f, t) => {
    if (arrived === null && Math.hypot(...centre(f.button).map((v, i) => v - centre(MENU)[i])) < 20)
      arrived = { t, width: f.body[2] };
  });
  assert.ok(arrived && arrived.t < 0.25, JSON.stringify(arrived));
  assert.ok(arrived.width < MENU[2] / 2, JSON.stringify(arrived));
});

test('closing goes back into the button\'s capsule, then fades', () => {
  const motion = new MenuMorphMotion(false, BUTTON, MENU, RADIUS);
  assert.ok(near(motion.frame.body, MENU, 0), `body ${motion.frame.body}`);
  let beforeFade = null;
  const { frame, t } = run(motion, f => {
    if (f.glassOpacity === 1) beforeFade = f;
  });
  assert.ok(t < 1.5, `took ${t}s`);
  assert.equal(frame.glassOpacity, 0);
  // Before it fades the glass is the capsule, with the menu's blob inside it.
  assert.ok(near(beforeFade.button, BUTTON, 0.6), `button glass ${beforeFade.button}`);
  const [x, y, w, h] = beforeFade.body;
  assert.ok(x >= BUTTON[0] && y >= BUTTON[1] - 0.5 && x + w <= BUTTON[0] + BUTTON[2] &&
    y + h <= BUTTON[1] + BUTTON[3] + 0.5, `body ${beforeFade.body}`);
});

test('reversing midway carries on from where the glass is', () => {
  const opening = new MenuMorphMotion(true, BUTTON, MENU, RADIUS);
  let frame;
  for (let i = 0; i < 12; i++) frame = opening.step(1 / 60);
  const closing = new MenuMorphMotion(false, BUTTON, MENU, RADIUS, frame, opening.velocities);
  const next = closing.step(1 / 60);
  assert.ok(near(next.body, frame.body, 70), `${frame.body} -> ${next.body}`);
  assert.ok(near(next.button, frame.button, 25), `${frame.button} -> ${next.button}`);
  assert.ok(Math.abs(next.contentScale - frame.contentScale) < 0.1);
  assert.ok(run(closing).frame.done);
});

test('the glass never jumps from one frame to the next', () => {
  for (const opening of [true, false]) {
    const motion = new MenuMorphMotion(opening, BUTTON, MENU, RADIUS);
    let last = motion.frame;
    run(motion, f => {
      for (let i = 0; i < 4; i++) {
        // The body grows fastest at the end of its 0.3 s ease: about 3.4x its mean rate.
        assert.ok(Math.abs(f.body[i] - last.body[i]) < 120, `${opening} ${last.body} -> ${f.body}`);
      }
      last = f;
    });
  }
});
