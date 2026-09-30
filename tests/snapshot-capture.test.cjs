const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

test('snapshot capture restores only actors it hid, including after capture errors, and stops on destroy', () => {
  const warnings = [], events = [];
  const { SelfExcludingSnapshotCapture } = loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/capture/snapshot.js'), {
    Clutter: { PaintFlag: { NO_CURSORS: 1, CLEAR: 2 } },
    Mtk: { Rectangle: class { constructor(rect) { Object.assign(this, rect); } } },
    console: { warn: message => warnings.push(message) },
  });
  const actor = (name, visible) => ({ visible, hide() { events.push([name, 'hide']); this.visible = false; },
    show() { events.push([name, 'show']); this.visible = true; } });
  const first = actor('first', true), second = actor('second', false);
  let fail = false, afterPaint;
  const content = {};
  const stage = { connect(_name, cb) { afterPaint = cb; return 7; }, disconnect(id) { assert.equal(id, 7); afterPaint = null; },
    paint_to_content(rect, scale, _region, flags) {
      assert.equal(first.visible, false);
      assert.equal(second.visible, false);
      assert.deepEqual([rect.x, rect.y, rect.width, rect.height, scale, flags], [10, 21, 100, 80, 1, 3]);
      if (fail) throw new Error('GPU failure');
      return content;
    } };
  const capture = new SelfExcludingSnapshotCapture(stage, first, () => [10.2, 20.7, 100.1, 79.9]);
  capture.addHideActor(second);
  assert.equal(capture.getContent(), content);
  fail = true;
  afterPaint();
  assert.equal(capture.getContent(), content);
  assert.equal(first.visible, true);
  assert.equal(second.visible, false);
  assert.deepEqual(events, [['first', 'hide'], ['first', 'show'], ['first', 'hide'], ['first', 'show']]);
  assert.equal(warnings.length, 1);
  capture.destroy();
  assert.equal(afterPaint, null);
});
