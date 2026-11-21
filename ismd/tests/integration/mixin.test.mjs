import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rustIsmd from '../../index.mjs';
import serializers from '../differential/serializers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const RAW_ROOT = path.resolve(__dirname, '../../../raw/compiler');
const rawIsmd = require(path.join(RAW_ROOT, 'packages/ismd'));

test('Step 4D.1: Mixin definitions, arguments, rest args, nested blocks, attributes merge, and pretty indent', () => {
  const tpl = [
    'mixin item(title, ...tags)',
    '  li.item&attributes(attributes)',
    '    h3= title',
    '    if block',
    '      .body',
    '        block',
    '    ul.tags',
    '      each t in tags',
    '        li= t',
    '',
    'ul#list',
    '  +item("First", "a", "b").featured(data-id=42)&attributes({ "aria-label": "row1" })',
    '    p Passed block #{note}',
    '  +item("Plain")',
  ].join('\n');

  for (const opts of [
    { filename: 'mixin-basic.pug' }, // preserves default compileDebug: true in compile/render
    { filename: 'mixin-basic.pug', compileDebug: false },
    { filename: 'mixin-basic.pug', compileDebug: false, pretty: true },
    { filename: 'mixin-basic.pug', compileDebug: false, inlineRuntimeFunctions: true },
  ]) {
    const locals = { note: '<b>ok</b>' };
    const rawFn = rawIsmd.compile(tpl, opts);
    const rustFn = rustIsmd.compile(tpl, opts);
    const rawHtml = rawFn(locals);
    const rustHtml = rustFn(locals);
    assert.equal(rustHtml, rawHtml);

    // Expected codegen difference (commit 5040ee2): rust codegen hoists `each t in tags` into
    // `ismd_each_body0` to prevent exponential code size growth on nested `each` loops.
    const rustSrc = rustFn.toString();
    assert.ok(rustSrc.includes('function ismd_each_body0'), `expected hoisted each helper (${JSON.stringify(opts)})`);
    assert.equal(rustSrc.includes('ismd_debug_line'), opts.compileDebug !== false, `compileDebug mismatch (${JSON.stringify(opts)})`);
    assert.equal(rustSrc.includes('ismd_escape('), Boolean(opts.inlineRuntimeFunctions), `inlineRuntimeFunctions mismatch (${JSON.stringify(opts)})`);
  }
});

test('Step 4D.2: Recursive mixins, dynamic mixin names, and unused-mixin pruning vs dynamic retention', () => {
  const recursiveTpl = [
    'mixin countdown(n)',
    '  if n > 0',
    '    span= n',
    '    +countdown(n - 1)',
    '  else',
    '    strong done',
    '',
    '+countdown(3)',
  ].join('\n');

  assert.equal(
    rustIsmd.render(recursiveTpl, { filename: 'rec.pug' }),
    rawIsmd.render(recursiveTpl, { filename: 'rec.pug' })
  );

  // Unused mixin is pruned when no dynamic mixin call exists (even if body references unbound vars)
  const unusedTpl = [
    'mixin unusedOne()',
    '  p= shouldNotTouchLocalsOrSideEffects',
    'p visible',
  ].join('\n');
  let touched = false;
  const locals = {
    get shouldNotTouchLocalsOrSideEffects() {
      touched = true;
      return 'boom';
    },
  };
  assert.equal(rustIsmd.render(unusedTpl, locals), '<p>visible</p>');
  assert.equal(touched, false);
  const unusedClientRaw = rawIsmd.compile(unusedTpl, { compileDebug: false }).toString();
  const unusedClientRust = rustIsmd.compile(unusedTpl, { compileDebug: false }).toString();
  assert.equal(serializers.compareCodegen(unusedClientRaw, unusedClientRust).ok, true);

  // Dynamic mixin keeps all mixin definitions alive
  const dynamicTpl = [
    'mixin alpha(v)',
    '  p.a= v',
    'mixin beta(v)',
    '  p.b= v',
    '+#{target}(val)',
  ].join('\n');
  assert.equal(
    rustIsmd.render(dynamicTpl, { target: 'beta', val: 'ok' }),
    rawIsmd.render(dynamicTpl, { target: 'beta', val: 'ok' })
  );
  const dynCg = serializers.compareCodegen(
    rawIsmd.compile(dynamicTpl, { compileDebug: false }).toString(),
    rustIsmd.compile(dynamicTpl, { compileDebug: false }).toString()
  );
  assert.equal(dynCg.ok, true);
});

test('Step 4D.3: Root mixins in extends, included mixins, block overrides, and source error lines', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4d-ext-'));
  try {
    const layoutSrc = ['html', '  body', '    block main'].join('\n');
    const helpersSrc = [
      'mixin badge(label)',
      '  span.badge&attributes(attributes)= label',
      '  if block',
      '    block',
    ].join('\n');
    const pageSrc = [
      'extends layout',
      'mixin card(title)',
      '  .card',
      '    h2= title',
      '    include helpers',
      '    +badge("tag").pill',
      '      em child-slot',
      'block main',
      '  +card(heading)',
    ].join('\n');
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmpDir, `layout.${ext}`), layoutSrc, 'utf8');
      fs.writeFileSync(path.join(tmpDir, `helpers.${ext}`), helpersSrc, 'utf8');
      fs.writeFileSync(path.join(tmpDir, `page.${ext}`), pageSrc, 'utf8');
    }
    const rawPagePath = path.join(tmpDir, 'page.pug');
    const rustPagePath = path.join(tmpDir, 'page.pug');

    const rawOut = rawIsmd.renderFile(rawPagePath, { heading: 'Hello' });
    const rustOut = rustIsmd.renderFile(rustPagePath, { heading: 'Hello' });
    assert.equal(rustOut, rawOut);

    const rawDeps = rawIsmd.compileFile(rawPagePath).dependencies.map((d) => d.replace(/\.pug$/, '.pug'));
    const rustDeps = rustIsmd.compileFile(rustPagePath).dependencies;
    assert.deepEqual(rustDeps, rawDeps);

    // Runtime exception inside mixin preserves filename + line in default compileDebug mode
    const errMixinSrc = ['mixin boom(x)', '  p ok', '  p= x.missing.prop'].join('\n');
    const errCallerSrc = ['include err-mixin', '+boom(null)'].join('\n');
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmpDir, `err-mixin.${ext}`), errMixinSrc, 'utf8');
      fs.writeFileSync(path.join(tmpDir, `caller.${ext}`), errCallerSrc, 'utf8');
    }

    let rawErr, rustErr;
    try { rawIsmd.renderFile(path.join(tmpDir, 'caller.pug')); } catch (e) { rawErr = e; }
    try { rustIsmd.renderFile(path.join(tmpDir, 'caller.pug')); } catch (e) { rustErr = e; }
    assert.ok(rawErr && rustErr);
    assert.equal(rustErr.path, rawErr.path.replace(/\.pug$/, '.pug'));
    assert.equal(rustErr.message, rawErr.message.replace(/\.pug/g, '.pug'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 4D.4: Scope/locals shadowing, getter side effects, ismd_mixins/block/attributes binding, and self mode', () => {
  // 4a. Shadowing `block` / `attributes` / mixin parameter names vs outer locals getters
  const scopeTpl = [
    'mixin box(outerShadow, ...restArgs)',
    '  - var localOnly = outerShadow + ":" + restArgs.join(",")',
    '  div(data-val=localOnly data-attr=attributes.kind)= fromLocals',
    '  if block',
    '    block',
    '+box("param", 1, 2)(kind="k")',
    '  p= innerLocal',
  ].join('\n');

  function makeLocals(log) {
    return {
      outerShadow: 'OUTER_SHOULD_BE_SHADOWED',
      get fromLocals() {
        log.push('fromLocals');
        return 'from-locals';
      },
      get innerLocal() {
        log.push('innerLocal');
        return 'inner-val';
      },
      get block() {
        log.push('outer-block-should-be-shadowed-inside-mixin');
        return 'outer-block';
      },
    };
  }

  const rawLog = [];
  const rustLog = [];
  const rawHtml = rawIsmd.render(scopeTpl, { ...makeLocals(rawLog), compileDebug: false });
  const rustHtml = rustIsmd.render(scopeTpl, { ...makeLocals(rustLog), compileDebug: false });
  assert.equal(rustHtml, rawHtml);
  assert.deepEqual(rustLog, rawLog);

  // Verify getter descriptor side-effect order (without spread copying)
  const getterLogRaw = [];
  const getterLogRust = [];
  const lRaw = {};
  const lRust = {};
  for (const [target, log] of [[lRaw, getterLogRaw], [lRust, getterLogRust]]) {
    Object.defineProperty(target, 'fromLocals', {
      enumerable: true,
      get() { log.push('fromLocals'); return 'L'; },
    });
    Object.defineProperty(target, 'innerLocal', {
      enumerable: true,
      get() { log.push('innerLocal'); return 'I'; },
    });
  }
  assert.equal(
    rustIsmd.compile(scopeTpl, { compileDebug: false })(lRust),
    rawIsmd.compile(scopeTpl, { compileDebug: false })(lRaw)
  );
  assert.deepEqual(getterLogRust, getterLogRaw);

  // 4b. `self: true` mode with mixin + merge + inlineRuntimeFunctions
  const selfTpl = [
    'mixin greet(n)',
    '  p&attributes(attributes) #{n} #{self.suffix}',
    '+greet("hi")(class="x")&attributes({ "data-k": "v" })',
  ].join('\n');
  const selfOpts = { self: true, inlineRuntimeFunctions: true, compileDebug: false };
  const rawSelfFn = rawIsmd.compile(selfTpl, selfOpts);
  const rustSelfFn = rustIsmd.compile(selfTpl, selfOpts);
  assert.equal(rustSelfFn({ suffix: '!' }), rawSelfFn({ suffix: '!' }));
  assert.equal(
    serializers.compareCodegen(rawSelfFn.toString(), rustSelfFn.toString()).ok,
    true
  );

  // 4c. Public compile (dependencies tracked) & compileFile parity
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4d-client-'));
  try {
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmpDir, `m.${ext}`), 'mixin hello(x)\n  span= x', 'utf8');
      fs.writeFileSync(path.join(tmpDir, `entry.${ext}`), 'include m\n+hello(msg)', 'utf8');
    }
    const rawEntry = path.join(tmpDir, 'entry.pug');
    const rustEntry = path.join(tmpDir, 'entry.pug');
    const entrySrc = 'include m\n+hello(msg)';

    const trackedRaw = rawIsmd.compile(entrySrc, { filename: rawEntry, compileDebug: false });
    const trackedRust = rustIsmd.compile(entrySrc, { filename: rustEntry, compileDebug: false });
    assert.deepEqual(
      trackedRust.dependencies,
      trackedRaw.dependencies.map((d) => d.replace(/\.pug$/, '.pug'))
    );
    assert.equal(serializers.compareCodegen(trackedRaw.toString(), trackedRust.toString()).ok, true);

    const fileFnRaw = rawIsmd.compileFile(rawEntry, { compileDebug: false });
    const fileFnRust = rustIsmd.compileFile(rustEntry, { compileDebug: false });
    assert.deepEqual(
      fileFnRust.dependencies,
      fileFnRaw.dependencies.map((d) => d.replace(/\.pug$/, '.pug'))
    );
    assert.equal(serializers.compareCodegen(fileFnRaw.toString(), fileFnRust.toString()).ok, true);
    assert.equal(fileFnRust({ msg: 'hi' }), fileFnRaw({ msg: 'hi' }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
