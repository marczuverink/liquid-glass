const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');

test('window clone sync preserves placement, culling, stacking and source removal', () => {
  const active = [], order = [], reports = [];
  class Actor {
    constructor(params = {}) { Object.assign(this, { x: 0, y: 0, visible: true, handlers: [] }, params); }
    connect(_name, cb) { this.handlers.push(cb); }
    set_name(name) { this.name = name; }
    set_position(x, y) { this.x = x; this.y = y; }
    remove_transition() {}
    destroy() { this.disposed = true; this.handlers.forEach(cb => cb()); }
  }
  const { WindowCloneManager } = loadModule(path.join(__dirname,
    '../liquid-glass@thinkingcoding1231.gmail.com/dist/capture/windowClones.js'), {
    UnpickableClone: Actor,
    isActorValid: a => !!a && !a.disposed,
    getNestedGlassFix: () => 'off', getWindowActors: () => active,
    getAllocatedSize: a => [a.width, a.height], isCullSiteEnabled: () => true,
    reportClonedWindowActors: (_owner, sources) => reports.push([...sources]),
    setActorVisible: (a, visible) => { a.visible = visible; },
    setCloneCulled: (a, culled) => { a.culled = culled; },
    setTranslationIfChanged: (a, x, y) => { a.translation = [x, y]; },
    setSizeIfChanged: (a, w, h) => { a.size = [w, h]; },
    setScaleIfChanged: (a, x, y) => { a.scale = [x, y]; },
    setPivotIfChanged: (a, x, y) => { a.pivot = [x, y]; },
    setOpacityIfChanged: (a, opacity) => { a.opacity = opacity; },
    isDiffWritesEnabled: () => true,
  });
  const source = (x, extra = {}) => new Actor({ x, y: 20, width: 100, height: 60,
    translation_x: 5, translation_y: -2, scale_x: 2, scale_y: 1, opacity: 128,
    pivot_point: { x: 0.5, y: 0.25 }, get_meta_window: () => ({ minimized: false, get_title: () => 'Title' }), ...extra });
  const first = source(10), second = source(1000), hidden = source(0, { visible: false });
  active.push(first, second, hidden);
  const manager = Object.create(WindowCloneManager.prototype);
  Object.assign(manager, { _damageHooks: new Map(), _windowClones: new Map(),
    windowClonesContainer: { add_child() {}, set_child_at_index: (a, i) => order.push([a, i]) },
    _cullRect: [0, 0, 400, 400], label: 'test' });
  manager.sync();
  const a = manager._windowClones.get(first), b = manager._windowClones.get(second);
  assert.equal(manager._windowClones.size, 2);
  assert.deepEqual(a.translation, [15, 18]);
  assert.deepEqual(a.size, [100, 60]);
  assert.deepEqual(a.scale, [2, 1]);
  assert.deepEqual(a.pivot, [0.5, 0.25]);
  assert.equal(a.opacity, 128);
  assert.equal(a.culled, false); assert.equal(b.culled, true);
  assert.deepEqual(order.map(([, i]) => i), [0, 1]);
  manager.sync();
  assert.equal(order.length, 2);
  assert.deepEqual(reports, [[], [first, second]]);
  active.splice(0, 1);
  manager.sync();
  assert.equal(a.disposed, true);
  assert.equal(manager._windowClones.has(first), false);
  assert.equal(order.at(-1)[1], 0);
  b.disposed = true;
  manager.sync();
  assert.notEqual(manager._windowClones.get(second), b);
});
