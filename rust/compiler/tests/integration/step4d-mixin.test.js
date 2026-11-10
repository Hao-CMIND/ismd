'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAW_ROOT = path.resolve(__dirname, '../../../../raw/compiler');
const rawPug = require(path.join(RAW_ROOT, 'packages/pug'));
const rustPug = require('../../index.js');
const serializers = require('../differential/serializers.js');

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
    const rawHtml = rawPug.compile(tpl, opts)(locals);
    const rustHtml = rustPug.compile(tpl, opts)(locals);
    assert.equal(rustHtml, rawHtml);

    const rawClient = rawPug.compileClient(tpl, opts);
    const rustClient = rustPug.compileClient(tpl, opts);
    const cg = serializers.compareCodegen(rawClient, rustClient);
    assert.equal(
      cg.ok,
      true,
      `codegen mismatch (${JSON.stringify(opts)}): prettier=${cg.prettierMatch}, raw=${cg.rawMatch}`
    );
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
    rustPug.render(recursiveTpl, { filename: 'rec.pug' }),
    rawPug.render(recursiveTpl, { filename: 'rec.pug' })
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
  assert.equal(rustPug.render(unusedTpl, locals), '<p>visible</p>');
  assert.equal(touched, false);
  const unusedClientRaw = rawPug.compileClient(unusedTpl);
  const unusedClientRust = rustPug.compileClient(unusedTpl);
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
    rustPug.render(dynamicTpl, { target: 'beta', val: 'ok' }),
    rawPug.render(dynamicTpl, { target: 'beta', val: 'ok' })
  );
  const dynCg = serializers.compareCodegen(
    rawPug.compileClient(dynamicTpl),
    rustPug.compileClient(dynamicTpl)
  );
  assert.equal(dynCg.ok, true);
});

test('Step 4D.3: Root mixins in extends, included mixins, block overrides, and source error lines', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4d-ext-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'layout.pug'),
      ['html', '  body', '    block main'].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'helpers.pug'),
      [
        'mixin badge(label)',
        '  span.badge&attributes(attributes)= label',
        '  if block',
        '    block',
      ].join('\n'),
      'utf8'
    );
    const pagePath = path.join(tmpDir, 'page.pug');
    fs.writeFileSync(
      pagePath,
      [
        'extends layout',
        'mixin card(title)',
        '  .card',
        '    h2= title',
        '    include helpers',
        '    +badge("tag").pill',
        '      em child-slot',
        'block main',
        '  +card(heading)',
      ].join('\n'),
      'utf8'
    );

    const rawOut = rawPug.renderFile(pagePath, { heading: 'Hello' });
    const rustOut = rustPug.renderFile(pagePath, { heading: 'Hello' });
    assert.equal(rustOut, rawOut);

    const rawDeps = rawPug.compileFile(pagePath).dependencies;
    const rustDeps = rustPug.compileFile(pagePath).dependencies;
    assert.deepEqual(rustDeps, rawDeps);

    // Runtime exception inside mixin preserves filename + line in default compileDebug mode
    const errMixinPath = path.join(tmpDir, 'err-mixin.pug');
    fs.writeFileSync(
      errMixinPath,
      ['mixin boom(x)', '  p ok', '  p= x.missing.prop'].join('\n'),
      'utf8'
    );
    const errCallerPath = path.join(tmpDir, 'caller.pug');
    fs.writeFileSync(errCallerPath, ['include err-mixin', '+boom(null)'].join('\n'), 'utf8');

    let rawErr, rustErr;
    try { rawPug.renderFile(errCallerPath); } catch (e) { rawErr = e; }
    try { rustPug.renderFile(errCallerPath); } catch (e) { rustErr = e; }
    assert.ok(rawErr && rustErr);
    assert.equal(rustErr.path, rawErr.path);
    assert.equal(rustErr.message, rawErr.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 4D.4: Scope/locals shadowing, getter side effects, pug_mixins/block/attributes binding, and self mode', () => {
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
  const rawHtml = rawPug.render(scopeTpl, { ...makeLocals(rawLog), compileDebug: false });
  const rustHtml = rustPug.render(scopeTpl, { ...makeLocals(rustLog), compileDebug: false });
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
    rustPug.compile(scopeTpl, { compileDebug: false })(lRust),
    rawPug.compile(scopeTpl, { compileDebug: false })(lRaw)
  );
  assert.deepEqual(getterLogRust, getterLogRaw);

  // 4b. `self: true` mode with mixin + merge + inlineRuntimeFunctions
  const selfTpl = [
    'mixin greet(n)',
    '  p&attributes(attributes) #{n} #{self.suffix}',
    '+greet("hi")(class="x")&attributes({ "data-k": "v" })',
  ].join('\n');
  const selfOpts = { self: true, inlineRuntimeFunctions: true, compileDebug: false };
  assert.equal(
    rustPug.compile(selfTpl, selfOpts)({ suffix: '!' }),
    rawPug.compile(selfTpl, selfOpts)({ suffix: '!' })
  );
  assert.equal(
    serializers.compareCodegen(
      rawPug.compileClient(selfTpl, selfOpts),
      rustPug.compileClient(selfTpl, selfOpts)
    ).ok,
    true
  );

  // 4c. Public compileClientWithDependenciesTracked & compileFileClient parity
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4d-client-'));
  try {
    const dep = path.join(tmpDir, 'm.pug');
    const entry = path.join(tmpDir, 'entry.pug');
    fs.writeFileSync(dep, 'mixin hello(x)\n  span= x', 'utf8');
    fs.writeFileSync(entry, 'include m\n+hello(msg)', 'utf8');

    const trackedRaw = rawPug.compileClientWithDependenciesTracked(fs.readFileSync(entry, 'utf8'), { filename: entry });
    const trackedRust = rustPug.compileClientWithDependenciesTracked(fs.readFileSync(entry, 'utf8'), { filename: entry });
    assert.deepEqual(trackedRust.dependencies, trackedRaw.dependencies);
    assert.equal(serializers.compareCodegen(trackedRaw.body, trackedRust.body).ok, true);

    const clientFnStrRaw = rawPug.compileFileClient(entry, { name: 'renderEntry' });
    const clientFnStrRust = rustPug.compileFileClient(entry, { name: 'renderEntry' });
    assert.equal(serializers.compareCodegen(clientFnStrRaw, clientFnStrRust).ok, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
