import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rustIsmd from '../../index.mjs';
import depLib from '../../runtime/lib/dependencies.mjs';
import intLib from '../../runtime/lib/internals.mjs';
import srcLib from '../../runtime/lib/sources.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_ROOT = path.resolve(__dirname, '../../../raw/compiler');
const rawIsmd = require(path.join(RAW_ROOT, 'packages/ismd'));
const rawAttrs = require(path.join(RAW_ROOT, 'packages/ismd-attrs'));
const rawRuntime = require(path.join(RAW_ROOT, 'packages/ismd-runtime'));
const rawBuild = require(path.join(RAW_ROOT, 'packages/ismd-runtime/build'));
const rawWrap = require(path.join(RAW_ROOT, 'packages/ismd-runtime/wrap'));
const serializers = require('../differential/serializers.mjs');

test('Step 5.1: ismd_attrs matches baseline on all 52 standalone cases and class/style/toJSON/order edge cases', () => {
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
    const rawFn = rawIsmd.compile(tpl, opts);
    const rustFn = rustIsmd.compile(tpl, opts);
    assert.equal(rustFn(localsFactory()), rawFn(localsFactory()));
    const cg = serializers.compareCodegen(rawFn.toString(), rustFn.toString());
    assert.equal(cg.ok, true, `attrs codegen mismatch for ${JSON.stringify(opts)}`);
  }

  // Standalone _compileAttrs validation & parity checks (raw vs rust JS output)
  assert.throws(() => rustIsmd._compileAttrs('not-array', { terse: true, format: 'html', runtime: (n) => n }), /Attrs should be an array/);
  assert.throws(() => rustIsmd._compileAttrs([], { terse: 'yes', format: 'html', runtime: (n) => n }), /Options.terse should be a boolean/);
  assert.throws(() => rustIsmd._compileAttrs([], { terse: true, format: 'xml', runtime: (n) => n }), /Options.format/);

  const edgeAttrs = [
    [{ name: 'style', val: false, mustEscape: true }],
    [{ name: 'style', val: '{ color: color }', mustEscape: true }],
    [{ name: 'foo', val: '"\'"', mustEscape: false }],
    [{ name: 'class', val: '"<x>"', mustEscape: true }, { name: 'class', val: 'dynCls', mustEscape: false }],
  ];
  for (const attrs of edgeAttrs) {
    for (const format of ['html', 'object']) {
      for (const terse of [true, false]) {
        const opts = { terse, format, runtime: (n) => `ismd.${n}` };
        assert.equal(rustIsmd._compileAttrs(attrs, opts), rawAttrs(attrs, opts));
      }
    }
  }
});

test('Step 5.2: Ismd CodeGen multi-option combination matrix (doctype, void-elements, pretty, compileDebug, self, globals, inlineRuntimeFunctions)', () => {
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
      const rawFn = rawIsmd.compile(tpl, fullOpts);
      const rustFn = rustIsmd.compile(tpl, fullOpts);
      const rawHtml = rawFn({ title: 'T', snippet: '<a>\n  b\n</a>' });
      const rustHtml = rustFn({ title: 'T', snippet: '<a>\n  b\n</a>' });
      assert.equal(rustHtml, rawHtml, `HTML mismatch for ${JSON.stringify(opts)}`);

      // Expected codegen difference (commit 5040ee2): rust codegen hoists `each` bodies into
      // `ismd_each_bodyN` helpers to avoid exponential O(2^d) code size on nested `each` loops.
      // Verify option-specific codegen invariants directly alongside exact HTML parity above.
      const rustSrc = rustFn.toString();
      assert.ok(rustSrc.includes('function ismd_each_body0'), `expected hoisted each helper for ${JSON.stringify(opts)}`);
      assert.equal(rustSrc.includes('ismd_debug_line'), Boolean(opts.compileDebug), `compileDebug mismatch for ${JSON.stringify(opts)}`);
      assert.equal(rustSrc.includes('ismd_escape('), Boolean(opts.inlineRuntimeFunctions), `inlineRuntimeFunctions mismatch for ${JSON.stringify(opts)}`);
      assert.equal(rustSrc.includes('locals_for_with'), !opts.self, `self mode mismatch for ${JSON.stringify(opts)}`);
      assert.ok(!rustSrc.includes('locals_for_with.GLOBAL_TAG'), `globals should not be bound from locals_for_with for ${JSON.stringify(opts)}`);
    }
  } finally {
    delete globalThis.GLOBAL_TAG;
  }
});

test('Step 5.3: ismd_runtime helpers, transitive dependency expansion, inline vs external runtimeWrap parity', () => {
  const names = ['attr', 'attrs', 'classes', 'escape', 'merge', 'style', 'rethrow'];
  // Expected difference vs raw/compiler: ismd/runtime/lib/sources.mjs uses a newer minifier
  // (`!1===e` vs `e===!1`, `(s=...)&&` vs `s=...,s&&`) and adds an ESM-safe `typeof require`
  // guard in `rethrow`. Native `_runtimeBuild` and JS `_runtimeBuildJs` must match each other
  // byte-for-byte, and emit the exact same helper function definitions in the same order as rawBuild.
  const extractDefs = (code) =>
    code
      .split('\n')
      .map((line) => {
        const m = line.match(/^(?:function|var)\s+(ismd_\w+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);

  for (const fnName of names) {
    const rustNative = rustIsmd._runtimeBuild([fnName]);
    const rustJs = rustIsmd._runtimeBuildJs([fnName]);
    const rawOut = rawBuild([fnName]);
    assert.equal(rustNative, rustJs, `native vs JS runtimeBuild mismatch for ${fnName}`);
    assert.deepEqual(
      extractDefs(rustNative),
      extractDefs(rawOut),
      `transitive helper set/order mismatch for ${fnName}`
    );
  }
  // Combined dependency deduplication + alphabetical ordering
  const comboNative = rustIsmd._runtimeBuild(['merge', 'attrs', 'escape', 'rethrow']);
  const comboJs = rustIsmd._runtimeBuildJs(['merge', 'attrs', 'escape', 'rethrow']);
  const comboRaw = rawBuild(['merge', 'attrs', 'escape', 'rethrow']);
  assert.equal(comboNative, comboJs);
  assert.deepEqual(extractDefs(comboNative), extractDefs(comboRaw));

  // Verify String.prototype.toJSON & custom toJSON & Date parity across runtime & inline build
  const origStrToJSON = String.prototype.toJSON;
  String.prototype.toJSON = function () {
    return JSON.stringify(this);
  };
  try {
    const inlineAttrRaw = Function('', rawBuild(['attr']) + ';return ismd_attr;')();
    const inlineAttrRust = Function('', rustIsmd._runtimeBuild(['attr']) + ';return ismd_attr;')();
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
      assert.equal(rustIsmd.runtime.attr(...args), rawRuntime.attr(...args));
      assert.equal(inlineAttrRust(...args), inlineAttrRaw(...args));
    }
  } finally {
    if (origStrToJSON === undefined) delete String.prototype.toJSON;
    else String.prototype.toJSON = origStrToJSON;
  }

  // Verify inlineRuntimeFunctions: false works with both rawWrap and rust runtime wrap
  const tpl = 'p&attributes({ class: ["a"], style: { color: c } })= msg';
  const rawFn = rawIsmd.compile(tpl, { inlineRuntimeFunctions: false, compileDebug: false });
  const rustFn = rustIsmd.compile(tpl, { inlineRuntimeFunctions: false, compileDebug: false });
  assert.equal(serializers.compareCodegen(rawFn.toString(), rustFn.toString()).ok, true);
  assert.equal(rawWrap(rustFn.toString())({ c: 'red', msg: '<hi>' }), '<p class="a" style="color:red;">&lt;hi&gt;</p>');

  // Verify inlineRuntimeFunctions: true expands all transitive deps (merge + attrs + attr + classes + escape + style + has_own_property + match_html)
  const inlineTpl = 'mixin m\n  div.a&attributes(attributes)(data-x=val)\n+m(class="b" style={ color: c })';
  const inlineRawFn = rawIsmd.compile(inlineTpl, { inlineRuntimeFunctions: true, compileDebug: false });
  const inlineRustFn = rustIsmd.compile(inlineTpl, { inlineRuntimeFunctions: true, compileDebug: false });
  assert.equal(serializers.compareCodegen(inlineRawFn.toString(), inlineRustFn.toString()).ok, true);
  assert.equal(
    inlineRustFn({ val: '1', c: 'red' }),
    inlineRawFn({ val: '1', c: 'red' })
  );
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
    // Review #5 & #6: String methods with offset, replace, split limit, surrogate pairs, and number conversions
    ['p(data-x="abc".split("").length)', '<p data-x="3"></p>'],
    ['p(data-x="a,b,c".split(",", 2).length)', '<p data-x="2"></p>'],
    ['p(data-x="abc".startsWith("b", 1))', '<p data-x="data-x"></p>'],
    ['p(data-x="abc".includes("a", 1))', '<p></p>'],
    ['p(data-x="abc".replace("b", "$&$&"))', '<p data-x="abbc"></p>'],
    ['p(data-x="😀x".indexOf("x", 2))', '<p data-x="2"></p>'],
    ['p(data-x=(255).toString(16))', '<p data-x="ff"></p>'],
    ['p(data-x=(2.5).toFixed(0))', '<p data-x="3"></p>'],
    ['p(data-x=+"0x10")', '<p data-x="16"></p>'],
    ['p(data-x=[null]*1)', '<p data-x="0"></p>'],
    ['p(data-x="abc".substr(-2))', '<p data-x="bc"></p>'],
    ['p(data-x="abc".substr(-1))', '<p data-x="c"></p>'],
    ['p(data-x="abc".substr(-2, 1))', '<p data-x="b"></p>'],
    ['p(data-x="a,b,c".split(",", -1).length)', '<p data-x="3"></p>'],
    ['p(data-x="a,b,c".split(",", 4294967296).length)', '<p data-x="0"></p>'],
    ['p(data-x=(1.45).toFixed(1))', '<p data-x="1.4"></p>'],
    ['p(data-x=(2.675).toFixed(2))', '<p data-x="2.67"></p>'],
    ['p(data-x=(0.615).toFixed(2))', '<p data-x="0.61"></p>'],
    ['p(data-x=(10.235).toFixed(2))', '<p data-x="10.23"></p>'],
    ['p(data-x=(5e-7).toFixed(6))', '<p data-x="0.000000"></p>'],
    ['p(data-x=(-2.5).toFixed(0))', '<p data-x="-3"></p>'],
    ['p(data-x=(1e21).toFixed(2))', '<p data-x="1e+21"></p>'],
    ['p(data-x=(1e21).toString(16))', '<p data-x="3635c9adc5dea00000"></p>'],
    ['p(data-x=(-1e21).toString(16))', '<p data-x="-3635c9adc5dea00000"></p>'],
    ['p(data-x=(1e21).toString(10))', '<p data-x="1e+21"></p>'],
    ['p(data-x=(255).toString(10))', '<p data-x="255"></p>'],
  ];
  for (const [src, expected] of constCases) {
    assert.equal(rustIsmd.render(src, { compileDebug: false }), expected);
    assert.equal(
      serializers.compareCodegen(
        rawIsmd.compile(src, { compileDebug: false }).toString(),
        rustIsmd.compile(src, { compileDebug: false }).toString()
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
    const rawOut = rawAttrs([{ name: 'data-x', val: expr, mustEscape: false }], { terse: true, format: 'html', runtime: (n) => `ismd.${n}` });
    const rustOut = rustIsmd._compileAttrs([{ name: 'data-x', val: expr, mustEscape: false }], { terse: true, format: 'html', runtime: (n) => `ismd.${n}` });
    assert.equal(rustOut, rawOut, `non-constant divergence for ${expr}`);
    assert.ok(rustOut.includes('ismd.attr("data-x"'), `expected runtime ismd.attr for ${expr}`);
  }

  // Large lengths are not folded to protect against compile hangs / OOM
  const largePad = rustIsmd._compileAttrs([{ name: 'data-x', val: '"abc".padStart(1e8, "x")', mustEscape: false }], { terse: true, format: 'html', runtime: (n) => `ismd.${n}` });
  assert.ok(largePad.includes('ismd.attr("data-x"'), 'expected runtime ismd.attr for 1e8 padStart');
  const largeRepeat = rustIsmd._compileAttrs([{ name: 'data-x', val: '"x".repeat(1e8)', mustEscape: false }], { terse: true, format: 'html', runtime: (n) => `ismd.${n}` });
  assert.ok(largeRepeat.includes('ismd.attr("data-x"'), 'expected runtime ismd.attr for 1e8 repeat');

  // Legacy provider-option cases are retained in filters/test/legacy.

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
    const rawFn = rawIsmd.compile(tpl, opts);
    const rustFn = rustIsmd.compile(tpl, opts);
    assert.equal(
      rustFn({ items, cls: 'active' }),
      rawFn({ items, cls: 'active' })
    );
    assert.equal(
      serializers.compareCodegen(rawFn.toString(), rustFn.toString()).ok,
      true
    );
  } finally {
    delete globalThis.appPrefix;
  }
});

test('Step 5.6: runtime/lib parity, attribute getter/toJSON side-effect order & errors, and entry compileDebug/includeSources defaults', () => {
  // 6a. Generated runtime lib tables match raw/compiler ismd-runtime/lib
  // Note: rebuilt raw/compiler keeps .js extensions for ismd-runtime/lib/*.js.
  assert.deepEqual(depLib, require(path.join(RAW_ROOT, 'packages/ismd-runtime/lib/dependencies.js')));
  assert.deepEqual(intLib, require(path.join(RAW_ROOT, 'packages/ismd-runtime/lib/internals.js')));
  const rawSrcLib = require(path.join(RAW_ROOT, 'packages/ismd-runtime/lib/sources.js'));
  assert.deepEqual(Object.keys(srcLib).sort(), Object.keys(rawSrcLib).sort());
  // Expected differences in `sources`: `attr` and `classes_array` differ only in minifier output,
  // and `rethrow` adds an ESM-safe `typeof require` check. All other helpers match byte-for-byte.
  const EXPECTED_SOURCE_DIFF_KEYS = new Set(['attr', 'classes_array', 'rethrow']);
  for (const key of Object.keys(rawSrcLib)) {
    if (!EXPECTED_SOURCE_DIFF_KEYS.has(key)) {
      assert.equal(srcLib[key], rawSrcLib[key], `unexpected runtime source diff for ${key}`);
    } else {
      assert.equal(typeof srcLib[key], 'string');
      assert.ok(srcLib[key].includes(`ismd_${key}`), `missing helper definition for ${key}`);
    }
  }

  // 6b. Attribute getter / toJSON / toString side-effect call counts, order, and errors
  const attrSideEffectTpl = 'div(class=objCls, style=objStyle, data-a=objA)&attributes(dynBag)';
  const makeAttrLocals = (log) => {
    const objCls = [];
    Object.defineProperty(objCls, '0', {
      enumerable: true,
      get() {
        log.push('cls[0]');
        return 'c1';
      },
    });
    const objStyle = {};
    Object.defineProperty(objStyle, 'color', {
      enumerable: true,
      get() {
        log.push('style.color');
        return 'red';
      },
    });
    const objA = {
      toJSON() {
        log.push('objA.toJSON');
        return { k: 1 };
      },
    };
    const dynBag = {};
    Object.defineProperty(dynBag, 'title', {
      enumerable: true,
      get() {
        log.push('dynBag.title');
        return {
          toJSON() {
            log.push('dynBag.title.toJSON');
            return 'J';
          },
        };
      },
    });
    return { objCls, objStyle, objA, dynBag };
  };

  const rLog = [];
  const xLog = [];
  const rawAttrFn = rawIsmd.compile(attrSideEffectTpl, { compileDebug: false });
  const rustAttrFn = rustIsmd.compile(attrSideEffectTpl, { compileDebug: false });
  const rawAttrHtml = rawAttrFn(makeAttrLocals(rLog));
  const rustAttrHtml = rustAttrFn(makeAttrLocals(xLog));
  assert.equal(rustAttrHtml, rawAttrHtml);
  assert.deepEqual(xLog, rLog);
  assert.equal(
    serializers.compareCodegen(rawAttrFn.toString(), rustAttrFn.toString()).ok,
    true
  );

  for (const badTpl of ['div(data-x=badObj)', 'div&attributes(badBag)']) {
    const makeBad = () => ({
      badObj: {
        toJSON() {
          throw new RangeError('tojson-boom');
        },
      },
      get badBag() {
        throw new TypeError('bag-boom');
      },
    });
    let re;
    let xe;
    try { rawIsmd.compile(badTpl, { filename: 'b.pug', compileDebug: true })(makeBad()); } catch (e) { re = e; }
    try { rustIsmd.compile(badTpl, { filename: 'b.pug', compileDebug: true })(makeBad()); } catch (e) { xe = e; }
    assert.ok(re && xe);
    assert.equal(xe.message, re.message);
  }

  // 6c. compile defaults for compileDebug x includeSources across entry + include
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step5-defaults-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'inc.pug'), 'p= boom.x\n');
    fs.writeFileSync(path.join(tmpDir, 'inc.pug'), 'p= boom.x\n');
    const rawEntry = path.join(tmpDir, 'main.pug');
    const rustEntry = path.join(tmpDir, 'main.pug');
    const src = 'include inc\n';
    for (const cDbg of [undefined, true, false]) {
      for (const incSrc of [undefined, true, false]) {
        const rawOpts = { filename: rawEntry };
        const rustOpts = { filename: rustEntry };
        if (cDbg !== undefined) {
          rawOpts.compileDebug = cDbg;
          rustOpts.compileDebug = cDbg;
        }
        if (incSrc !== undefined) {
          rawOpts.includeSources = incSrc;
          rustOpts.includeSources = incSrc;
        }
        const rawFn = rawIsmd.compile(src, rawOpts);
        const rustFn = rustIsmd.compile(src, rustOpts);
        // Expected difference: rustIsmd.compile honors explicit `includeSources` via `resolveIncludeSources`
        // (embed `ismd_debug_sources` when `compileDebug !== false` and `includeSources === true`,
        // or when `includeSources === undefined && compileDebug === true`), whereas rawIsmd.compile
        // always sets `includeSources = (compileDebug === true)` and ignores explicit `options.includeSources`.
        const expectRustSources =
          cDbg !== false && (incSrc === true || (incSrc === undefined && cDbg === true));
        const expectRawSources = cDbg === true;
        assert.equal(
          rustFn.toString().includes('ismd_debug_sources'),
          expectRustSources,
          `includeSources embedding mismatch for ${JSON.stringify(rustOpts)}`
        );
        if (expectRustSources === expectRawSources) {
          assert.equal(
            serializers.compareCodegen(
              rawFn.toString().replace(/\.pug/g, '.pug'),
              rustFn.toString()
            ).ok,
            true,
            `compile codegen mismatch for ${JSON.stringify(rustOpts)}`
          );
        }

        let re;
        let xe;
        try { rawFn({}); } catch (e) { re = e; }
        try { rustFn({}); } catch (e) { xe = e; }
        assert.equal(Boolean(xe), Boolean(re));
        assert.equal(xe.message, re.message.replace(/\.pug/g, '.pug'));
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
