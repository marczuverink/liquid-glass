const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const dist = path.join(__dirname, '../liquid-glass@thinkingcoding1231.gmail.com/dist');
const bindings = {
  isActorValid: actor => !!actor && !actor.disposed,
  innerGlassEffectOf: actor => actor.glass,
};
const { syncDamageHooks } = loadModule(path.join(dist, 'capture/damageHooks.js'), bindings);

function source(extra = {}) {
  return { glass: true, callbacks: new Map(), nextId: 1,
    connect(signal, callback) { assert.equal(signal, 'damaged'); const id = this.nextId++; this.callbacks.set(id, callback); return id; },
    disconnect(id) { assert.ok(this.callbacks.delete(id)); }, ...extra };
}

test('damage subscriptions are unique, retry failed connections and ignore non-glass actors', () => {
  const a = source(), plain = source({ glass: false }), disposed = source({ disposed: true });
  const broken = source({ connect() { throw new Error('gone'); } });
  const hooks = new Map(), sources = new Map([a, plain, disposed, broken].map(s => [s, {}]));
  let damage = 0;
  syncDamageHooks(hooks, sources, () => damage++);
  syncDamageHooks(hooks, sources, () => damage += 100);
  assert.equal(hooks.size, 1);
  assert.equal(a.callbacks.size, 1);
  [...a.callbacks.values()][0]();
  assert.equal(damage, 1);
  broken.connect = source().connect;
  syncDamageHooks(hooks, sources, () => damage++);
  assert.equal(hooks.size, 2);
});

test('damage pruning drops sources that left the clone set and tolerates disposed sources', () => {
  const a = source(), b = source();
  const hooks = new Map();
  syncDamageHooks(hooks, new Map([[a, {}]]), () => {});
  syncDamageHooks(hooks, new Map([[source({ glass: false }), {}]]), () => {});
  assert.equal(hooks.has(a), false, 'a source outside the clone set is released even when the maps are the same size');
  assert.equal(a.callbacks.size, 0);
  syncDamageHooks(hooks, new Map([[a, {}]]), () => {});
  syncDamageHooks(hooks, new Map([[b, {}]]), () => {});
  assert.equal(hooks.has(a), false);
  assert.equal(a.callbacks.size, 0);
  b.disposed = true;
  syncDamageHooks(hooks, new Map(), () => {});
  assert.equal(hooks.size, 0);
});

test('a failed disconnect does not prevent other damage subscriptions being removed', () => {
  const a = source({ disconnect() { throw new Error('disposed'); } }), b = source();
  const hooks = new Map();
  syncDamageHooks(hooks, new Map([[a, {}], [b, {}]]), () => {});
  syncDamageHooks(hooks, new Map(), () => {});
  assert.equal(hooks.size, 0);
  assert.equal(b.callbacks.size, 0);
});

test('application damage callbacks follow the current background and stop when it is hidden', () => {
  const { ApplicationManager } = loadModule(path.join(dist, 'applicationManager.js'), {
    ...bindings, Meta: { WindowType: {} },
  });
  const manager = Object.create(ApplicationManager.prototype);
  const a = source();
  const background = () => ({ mapped: true, visible: true, redraws: 0, queue_redraw() { this.redraws++; } });
  const first = background(), second = background();
  const state = { clones: new Map([[a, {}]]), bgActor: first };
  manager._syncDamageHooks(state);
  manager._syncDamageHooks(state);
  const emit = () => [...a.callbacks.values()].forEach(cb => cb());
  emit();
  assert.equal(first.redraws, 1);
  state.bgActor = second;
  emit();
  assert.equal(first.redraws, 1);
  assert.equal(second.redraws, 1);
  second.visible = false;
  emit();
  assert.equal(second.redraws, 1);
  manager._releaseDamageHooks(state);
  assert.equal(a.callbacks.size, 0);
  assert.equal(state.damageHooks, undefined);
});

test('window clone damage callbacks retain their container and release when the mode changes', () => {
  let mode = 'damage';
  const { WindowCloneManager } = loadModule(path.join(dist, 'capture/windowClones.js'), {
    ...bindings, getNestedGlassFix: () => mode,
  });
  const manager = Object.create(WindowCloneManager.prototype);
  const a = source();
  const container = { mapped: true, visible: true, redraws: 0, queue_redraw() { this.redraws++; } };
  Object.assign(manager, { container, _windowClones: new Map([[a, {}]]), _damageHooks: new Map() });
  manager._syncDamageHooks();
  manager.container = { ...container };
  [...a.callbacks.values()][0]();
  assert.equal(container.redraws, 1);
  assert.equal(manager.container.redraws, 0);
  mode = 'off';
  manager._syncDamageHooks();
  assert.equal(a.callbacks.size, 0);
});

function isolatedFixture() {
  const glassy = new Set();
  const { syncDamageHooks, releaseDamageHooks } = loadModule(path.join(dist, 'capture/damageHooks.js'), {
    isActorValid: actor => !!actor && !actor.disposed,
    innerGlassEffectOf: actor => (glassy.has(actor) ? {} : null),
  });
  let next = 1;
  const actor = name => ({ name, handlers: new Map(),
    connect(signal, fn) { const id = next++; this.handlers.set(id, fn); return id; },
    disconnect(id) { assert.ok(this.handlers.delete(id)); } });
  return { syncDamageHooks, releaseDamageHooks, glassy, actor };
}

test('a nested-glass window that leaves the clone set loses its hook even when many other windows stay', () => {
  const { syncDamageHooks, glassy, actor } = isolatedFixture();
  const windows = Array.from({ length: 10 }, (_, i) => actor(`w${i}`));
  glassy.add(windows[0]);
  const sources = new Map(windows.map(w => [w, {}]));
  const hooks = new Map();
  syncDamageHooks(hooks, sources, () => {});
  assert.equal(hooks.size, 1);
  assert.equal(windows[0].handlers.size, 1);
  sources.delete(windows[0]);
  syncDamageHooks(hooks, sources, () => {});
  assert.equal(hooks.size, 0);
  assert.equal(windows[0].handlers.size, 0);
});

test('releasing hooks disconnects live sources and skips disposed ones', () => {
  const { syncDamageHooks, releaseDamageHooks, glassy, actor } = isolatedFixture();
  const a = actor('a'), b = actor('b');
  glassy.add(a); glassy.add(b);
  const hooks = new Map();
  syncDamageHooks(hooks, new Map([[a, {}], [b, {}]]), () => {});
  b.disposed = true;
  releaseDamageHooks(hooks);
  assert.equal(hooks.size, 0);
  assert.equal(a.handlers.size, 0);
  assert.equal(b.handlers.size, 1);
});

test('a source that keeps its clone but loses its inner glass loses its damage hook', () => {
  const a = source();
  const hooks = new Map(), sources = new Map([[a, {}]]);
  syncDamageHooks(hooks, sources, () => {});
  assert.equal(a.callbacks.size, 1);
  a.glass = false;
  syncDamageHooks(hooks, sources, () => {});
  assert.equal(hooks.size, 0);
  assert.equal(a.callbacks.size, 0);
});
