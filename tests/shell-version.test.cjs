const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/load-module.cjs');
const { dist } = require('./helpers/gpu.cjs');

function shellVersion(version, bindings = {}) {
  return loadModule(path.join(dist, 'shellVersion.js'), { Config: { PACKAGE_VERSION: version }, ...bindings });
}

function recordingPipeline() {
  const writes = [];
  return {
    writes,
    get_uniform_location: name => `loc:${name}`,
    set_uniform_float: (...args) => writes.push(['float', ...args]),
    set_uniform_1f: (...args) => writes.push(['1f', ...args]),
  };
}

test('from GNOME 48 vectors and arrays go through set_uniform_float unchanged', () => {
  const v = shellVersion('48.7');
  const pipeline = recordingPipeline();
  v.setUniformVector(pipeline, 'd_rect', [0.1, 0.2, 0.3, 0.4]);
  v.setUniformArray(pipeline, 'loc:region_x', 'region_x', [1, 2, 3]);
  assert.deepEqual(pipeline.writes, [
    ['float', 'loc:d_rect', 4, 1, [0.1, 0.2, 0.3, 0.4]],
    ['float', 'loc:region_x', 1, 3, [1, 2, 3]],
  ]);
  const decl = 'uniform vec2 inv_size; /* source texel */\nuniform float kernel_scale;\n';
  assert.equal(v.uniformDeclarations(decl), decl);
});

test('before GNOME 48 only set_uniform_1f is called, per component and per element', () => {
  for (const version of ['46.0', '47.10']) {
    const v = shellVersion(version);
    const pipeline = recordingPipeline();
    v.setUniformVector(pipeline, 'inv_size', [0.5, 0.25]);
    v.setUniformArray(pipeline, 'loc:region_x', 'region_x', [7, 8]);
    assert.deepEqual(pipeline.writes, [
      ['1f', 'loc:inv_size_0', 0.5],
      ['1f', 'loc:inv_size_1', 0.25],
      ['1f', 'loc:region_x[0]', 7],
      ['1f', 'loc:region_x[1]', 8],
    ], version);
  }
});

test('before GNOME 48 vector uniforms are declared as floats behind a macro', () => {
  const v = shellVersion('47.0');
  const decl = 'uniform vec2 inv_size; /* source texel */\nuniform float kernel_scale;\nuniform vec4 m_rect;\n';
  assert.equal(v.uniformDeclarations(decl),
    'uniform float inv_size_0, inv_size_1;\n#define inv_size vec2(inv_size_0, inv_size_1)\n /* source texel */\n' +
    'uniform float kernel_scale;\n' +
    'uniform float m_rect_0, m_rect_1, m_rect_2, m_rect_3;\n#define m_rect vec4(m_rect_0, m_rect_1, m_rect_2, m_rect_3)\n\n');
});

test('the root node, Cogl context and menu toggle class follow the version', () => {
  const calls = [];
  class Color { constructor() { this.kind = 'clutter'; } }
  class CoglColor { constructor() { this.kind = 'cogl'; } }
  const bindings = {
    Clutter: {
      Color,
      RootNode: { new: (...args) => { calls.push(args); return {}; } },
      get_default_backend: () => ({ get_cogl_context: () => 'default-backend' }),
    },
    Cogl: { Color: CoglColor },
    global: { stage: { context: { get_backend: () => ({ get_cogl_context: () => 'stage-context' }) } } },
  };
  const expected = {
    '46.0': [['fb', 'clutter', 0], 'default-backend', 'quick-menu-toggle'],
    '47.5': [['fb', 'cogl', 0], 'default-backend', 'quick-menu-toggle'],
    '48.0': [['fb', 'state', 'cogl', 0], 'stage-context', 'quick-toggle-has-menu'],
    '51.0': [['fb', 'state', 'cogl', 0], 'stage-context', 'quick-toggle-has-menu'],
  };
  for (const [version, [rootArgs, context, toggleClass]] of Object.entries(expected)) {
    calls.length = 0;
    const v = shellVersion(version, bindings);
    v.newRootNode('fb', 'state');
    assert.deepEqual(calls[0].map(a => a?.kind ?? a), rootArgs, version);
    assert.equal(v.coglContext(), context, version);
    assert.equal(v.QS_MENU_TOGGLE_CLASS, toggleClass, version);
  }
});

test('GNOME 46 has no St accent colour and falls back', () => {
  assert.equal(shellVersion('46.0').accentColors(), null);
});
