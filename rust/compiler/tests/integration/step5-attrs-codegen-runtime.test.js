import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rustPug from '../../index.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = path.resolve(__dirname, '../../../../raw/compiler');
const rawPug = require(path.join(RAW_ROOT, 'packages/pug'));
const rawAttrs = require(path.join(RAW_ROOT, 'packages/pug-attrs'));
const rawRuntime = require(path.join(RAW_ROOT, 'packages/pug-runtime'));
const rawBuild = require(path.join(RAW_ROOT, 'packages/pug-runtime/build'));
const rawWrap = require(path.join(RAW_ROOT, 'packages/pug-runtime/wrap'));
const serializers = require('../differential/serializers.js');

test('Step 5.1: pug_attrs matches baseline on all 52 standalone cases and class/style/toJSON/order edge cases', () => {
  // Verify toJSON objects, Dates, nested classes, style objects, attribute ordering (`class` hoisted first)
  const tpl = [
    'div#box(data-json=obj, data-date=dt, data-bool-t=true, data-bool-f=false, style={ color: "red", margin: "0" }, class=["a", { b: flag, c: false }], data-raw!=rawHtml)&attributes(extra)',
    'img(src="/x.png", disabled)',
  ].join('\n');

  const localsFactory = () => ({
    obj: { toJSON: () => ({ a: "don't" }) },
    dt: new Date('2020-01-02T03:04:05.000Z'),
    flag: true,
    rawHtml: '<span title="x">ok</span>',
    extra: { class: ['d'], style: { padding: '4px' }, 'data-z': 'last' },
  });

  for (const opts of [
    { doctype: undefined, compileDebug: false },
    { doctype: 'html', compileDebug: false },
    { doctype: 'xml', compileDebug: false },
    { doctype: 'strict', compileDebug: false },
  ]) {
    assert.equal(
      rustPug.compile(tpl, opts)(localsFactory()),
      rawPug.compile(tpl, opts)(localsFactory())
    );
    const cg = serializers.compareCodegen(
      rawPug.compileClient(tpl, opts),
      rustPug.compileClient(tpl, opts)
    );
    assert.equal(cg.ok, true, `attrs codegen mismatch for ${JSON.stringify(opts)}`);
  }

  // Standalone _compileAttrs validation & parity checks (raw vs rust JS output)
  assert.throws(() => rustPug._compileAttrs('not-array', { terse: true, format: 'html', runtime: (n) => n }), /Attrs should be an array/);
  assert.throws(() => rustPug._compileAttrs([], { terse: 'yes', format: 'html', runtime: (n) => n }), /Options.terse should be a boolean/);
  assert.throws(() => rustPug._compileAttrs([], { terse: true, format: 'xml', runtime: (n) => n }), /Options.format/);

  const edgeAttrs = [
    [{ name: 'style', val: false, mustEscape: true }],
    [{ name: 'style', val: '{ color: color }', mustEscape: true }],
    [{ name: 'foo', val: '"\'"', mustEscape: false }],
    [{ name: 'class', val: '"<x>"', mustEscape: true }, { name: 'class', val: 'dynCls', mustEscape: false }],
  ];
  for (const attrs of edgeAttrs) {
    for (const format of ['html', 'object']) {
      for (const terse of [true, false]) {
        const opts = { terse, format, runtime: (n) => `pug.${n}` };
        assert.equal(rustPug._compileAttrs(attrs, opts), rawAttrs(attrs, opts));
      }
    }
  }
});

test('Step 5.2: Pug CodeGen multi-option combination matrix (doctype, void-elements, pretty, compileDebug, self, globals, inlineRuntimeFunctions)', () => {
  const tpl = [
    'mixin card(title, ...tags)',
    '  article.card&attributes(attributes)',
    '    h2= title',
    '    pre',
    '      code= typeof self !== "undefined" ? self.snippet : snippet',
    '    img(src="/pic.png")',
    '    if block',
    '      block',
    '    each t in tags',
    '      span= t',
    '',
    'html',
    '  body',
    '    p= GLOBAL_TAG + ":" + (typeof self !== "undefined" ? self.title : title)',
    '    +card("C", "x", "y").lead(data-on=true)',
    '      p inner',
  ].join('\n');

  const combinations = [
    { doctype: undefined, pretty: undefined, compileDebug: false, inlineRuntimeFunctions: false, self: false, globals: ['GLOBAL_TAG'] },
    { doctype: 'html', pretty: true, compileDebug: false, inlineRuntimeFunctions: false, self: false, globals: ['GLOBAL_TAG'] },
    { doctype: 'xml', pretty: '    ', compileDebug: true, inlineRuntimeFunctions: true, self: false, globals: ['GLOBAL_TAG'] },
    { doctype: 'strict', pretty: true, compileDebug: true, inlineRuntimeFunctions: true, self: true, globals: ['GLOBAL_TAG'] },
    { doctype: 'transitional', pretty: undefined, compileDebug: true, inlineRuntimeFunctions: false, self: true, globals: ['GLOBAL_TAG'] },
  ];

  globalThis.GLOBAL_TAG = 'G5';
  try {
    for (const opts of combinations) {
      const fullOpts = { filename: 'combo.pug', ...opts };
      const rawHtml = rawPug.compile(tpl, fullOpts)({ title: 'T', snippet: '<a>\n  b\n</a>' });
      const rustHtml = rustPug.compile(tpl, fullOpts)({ title: 'T', snippet: '<a>\n  b\n</a>' });
      assert.equal(rustHtml, rawHtml, `HTML mismatch for ${JSON.stringify(opts)}`);

      const rawClient = rawPug.compileClient(tpl, fullOpts);
      const rustClient = rustPug.compileClient(tpl, fullOpts);
      const cg = serializers.compareCodegen(rawClient, rustClient);
      assert.equal(
        cg.ok,
        true,
        `JS codegen mismatch for ${JSON.stringify(opts)}: prettier=${cg.prettierMatch}, raw=${cg.rawMatch}`
      );
    }
  } finally {
    delete globalThis.GLOBAL_TAG;
  }
});

test('Step 5.3: pug_runtime helpers, transitive dependency expansion, inline vs external runtimeWrap parity', () => {
  const names = ['attr', 'attrs', 'classes', 'escape', 'merge', 'style', 'rethrow'];
  for (const fnName of names) {
    assert.equal(rustPug._runtimeBuild([fnName]), rawBuild([fnName]), `build mismatch for ${fnName}`);
    assert.equal(rustPug._runtimeBuildJs([fnName]), rawBuild([fnName]), `buildJs mismatch for ${fnName}`);
  }
  // Combined dependency deduplication + alphabetical ordering
  assert.equal(
    rustPug._runtimeBuild(['merge', 'attrs', 'escape', 'rethrow']),
    rawBuild(['merge', 'attrs', 'escape', 'rethrow'])
  );

  // Verify String.prototype.toJSON & custom toJSON & Date parity across runtime & inline build
  const origStrToJSON = String.prototype.toJSON;
  String.prototype.toJSON = function () {
    return JSON.stringify(this);
  };
  try {
    const inlineAttrRaw = Function('', rawBuild(['attr']) + ';return pug_attr;')();
    const inlineAttrRust = Function('', rustPug._runtimeBuild(['attr']) + ';return pug_attr;')();
    const cases = [
      ['k', true, true, true],
      ['k', true, false, false],
      ['k', false, true, true],
      ['k', null, true, false],
      ['k', new Date('2014-12-28T16:46:06.962Z'), true, true],
      ['k', { toJSON: () => 'bar' }, true, false],
      ['k', { foo: "don't" }, false, true],
      ['k', 'a>b', true, true],
    ];
    for (const args of cases) {
      assert.equal(rustPug.runtime.attr(...args), rawRuntime.attr(...args));
      assert.equal(inlineAttrRust(...args), inlineAttrRaw(...args));
    }
  } finally {
    if (origStrToJSON === undefined) delete String.prototype.toJSON;
    else String.prototype.toJSON = origStrToJSON;
  }

  // Verify compileClient inlineRuntimeFunctions: false works with both rawWrap and rust runtime wrap
  const tpl = 'p&attributes({ class: ["a"], style: { color: c } })= msg';
  const clientCode = rustPug.compileClient(tpl, { inlineRuntimeFunctions: false, compileDebug: false });
  assert.equal(serializers.compareCodegen(rawPug.compileClient(tpl, { inlineRuntimeFunctions: false, compileDebug: false }), clientCode).ok, true);
  assert.equal(rawWrap(clientCode)({ c: 'red', msg: '<hi>' }), '<p class="a" style="color:red;">&lt;hi&gt;</p>');

  // Verify inlineRuntimeFunctions: true expands all transitive deps (merge + attrs + attr + classes + escape + style + has_own_property + match_html)
  const inlineTpl = 'mixin m\n  div.a&attributes(attributes)(data-x=val)\n+m(class="b" style={ color: c })';
  const inlineRaw = rawPug.compileClient(inlineTpl, { inlineRuntimeFunctions: true, compileDebug: false });
  const inlineRust = rustPug.compileClient(inlineTpl, { inlineRuntimeFunctions: true, compileDebug: false });
  assert.equal(serializers.compareCodegen(inlineRaw, inlineRust).ok, true);
});

test('Step 5.4: constantinople compatibility (known constants, non-constants, invalid syntax, and unsupported constructs)', () => {
  // Known constants folded at compile time identically to constantinople
  const constCases = [
    ['p(data-c="abc".charAt(1))', '<p data-c="b"></p>'],
    ['p(data-c="a".padStart(3, "0"))', '<p data-c="00a"></p>'],
    ['p(data-c="a".padEnd(3, "0"))', '<p data-c="a00"></p>'],
    ['p(data-c="abcb".lastIndexOf("b"))', '<p data-c="3"></p>'],
    ['p(data-c="abc".charCodeAt(1))', '<p data-c="98"></p>'],
    ['p(data-c=`${1 + 2}`)', '<p data-c="3"></p>'],
  ];
  for (const [src, expected] of constCases) {
    assert.equal(rustPug.render(src, { compileDebug: false }), expected);
    assert.equal(
      serializers.compareCodegen(
        rawPug.compileClient(src, { compileDebug: false }),
        rustPug.compileClient(src, { compileDebug: false })
      ).ok,
      true
    );
  }

  // Non-constants rejected by constantinople (must NOT fold at compile time!)
  const nonConstAttrs = [
    '({ 1: "a" })',
    '({ "": "a" })',
    '({ _a: 1 })',
    'undefined',
    'NaN',
    'Infinity',
    'true || missingVar',
  ];
  for (const expr of nonConstAttrs) {
    const rawOut = rawAttrs([{ name: 'data-x', val: expr, mustEscape: false }], { terse: true, format: 'html', runtime: (n) => `pug.${n}` });
    const rustOut = rustPug._compileAttrs([{ name: 'data-x', val: expr, mustEscape: false }], { terse: true, format: 'html', runtime: (n) => `pug.${n}` });
    assert.equal(rustOut, rawOut, `non-constant divergence for ${expr}`);
    assert.ok(rustOut.includes('pug.attr("data-x"'), `expected runtime pug.attr for ${expr}`);
  }

  // Distinction between NonConstant/Invalid vs Unsupported in filter options
  for (const expr of ['undefined', '({ _a: 1 })']) {
    assert.throws(
      () => rustPug.compile(`:cdata(opt=${expr})\n  hi`, { filename: 'c.pug' }),
      (err) => err.code === 'PUG:FILTER_OPTION_NOT_CONSTANT'
    );
  }
  assert.throws(
    () =>
      rustPug._handleFilters(
        {
          type: 'Block',
          line: 0,
          nodes: [
            {
              type: 'Filter',
              name: 'cdata',
              block: { type: 'Block', line: 1, nodes: [] },
              attrs: [{ name: 'opt', val: '(1 +', mustEscape: true }],
              line: 1,
            },
          ],
        },
        {}
      ),
    (err) => err.code === 'PUG:FILTER_OPTION_NOT_CONSTANT'
  );
  for (const expr of ['1n', 'tag`hi`', 'null ?? 1', '/a/.test("a")', '"a".match("a")', '(1).toExponential()']) {
    assert.throws(
      () => rustPug.compile(`:cdata(opt=${expr})\n  hi`, { filename: 'c.pug' }),
      (err) => err.code === 'PUG:UNSUPPORTED_CONSTANT'
    );
  }
});

test('Step 5.5: Scope/locals regression across Step 4-5 constructs (mixins, attrs, each-of destructuring, globals, self)', () => {
  const tpl = [
    'mixin row([k, v])',
    '  li(data-k=k, data-g=appPrefix)&attributes(attributes)= v',
    'ul',
    '  each entry of items',
    '    +row(entry)(class=cls)',
  ].join('\n');

  globalThis.appPrefix = 'PRE';
  try {
    const items = new Map([['k1', 'v1'], ['k2', 'v2']]);
    const opts = { globals: ['appPrefix'], compileDebug: false };
    assert.equal(
      rustPug.compile(tpl, opts)({ items, cls: 'active' }),
      rawPug.compile(tpl, opts)({ items, cls: 'active' })
    );
    assert.equal(
      serializers.compareCodegen(
        rawPug.compileClient(tpl, opts),
        rustPug.compileClient(tpl, opts)
      ).ok,
      true
    );
  } finally {
    delete globalThis.appPrefix;
  }
});
