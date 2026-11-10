'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RAW_ROOT = path.resolve(__dirname, '../../../../raw/compiler');
const rawPug = require(path.join(RAW_ROOT, 'packages/pug'));
const rawLex = require(path.join(RAW_ROOT, 'packages/pug-lexer'));
const rawStripComments = require(path.join(RAW_ROOT, 'packages/pug-strip-comments'));
const rawParse = require(path.join(RAW_ROOT, 'packages/pug-parser'));
const rawWalk = require(path.join(RAW_ROOT, 'packages/pug-walk'));
const rawAddWith = require(path.join(RAW_ROOT, 'node_modules/with'));

const rustPug = require('../../index.js');
const {
  compareStructured,
  compareCodegen,
  compareHtml,
} = require('../differential/serializers.js');

function cloneJson(val) {
  return JSON.parse(JSON.stringify(val));
}

test('Step 3A: Single-stage & full-frontend pipeline (Pug -> Lexer -> StripComments -> Parser) with CJK, Emoji, BOM, CRLF, and tabs', () => {
  const templates = [
    {
      name: 'CJK & supplementary Emoji coordinates with BOM and CRLF',
      src: '\uFEFFdiv(data-title="你好🚀世界")\r\n  p#main.greeting 歡迎來到 👩‍💻 Pug 測試\r\n  span= "🍎" + "🍌"\r\n',
      filename: 'unicode-cjk-emoji.pug',
    },
    {
      name: 'Tabs, explicit null fields (Each.key, Conditional.alternate, Mixin.args, Mixin.block)',
      src: [
        'mixin badge',
        '\tspan.badge default',
        '+badge',
        '+badge("custom")',
        '\tem Nested',
        'if user',
        '\tp= user.name',
        'each item in items',
        '\tli= item',
        'else',
        '\tli Empty',
        'each val, idx in items',
        '\tli #{idx}: #{val}',
      ].join('\n'),
      filename: 'tabs-and-nulls.pug',
    },
    {
      name: 'Include, RawInclude with IncludeFilter, Extends, NamedBlock, YieldBlock, Case/When',
      src: [
        'extends layout.pug',
        'block append head',
        '  include:markdown-it(html=true) article.md',
        '  include header.pug',
        '  case status',
        '    when 200',
        '      p OK',
        '    default',
        '      yield',
      ].join('\n'),
      filename: 'structural-nodes.pug',
    },
  ];

  for (const tpl of templates) {
    // 1. Single-stage: identical unshared token stream -> rawParse vs rustPug.parse
    const rawTokens = rawStripComments(rawLex(tpl.src, { filename: tpl.filename }), {
      filename: tpl.filename,
    });
    const rawAstSingle = rawParse(cloneJson(rawTokens), {
      filename: tpl.filename,
      src: tpl.src,
    });
    const rustAstSingle = rustPug.parse(cloneJson(rawTokens), {
      filename: tpl.filename,
      src: tpl.src,
    });
    const cmpSingle = compareStructured(rawAstSingle, rustAstSingle);
    assert.equal(
      cmpSingle.ok,
      true,
      `Single-stage Parser mismatch for ${tpl.name}:\nExpected:\n${cmpSingle.expectedFormatted}\nActual:\n${cmpSingle.actualFormatted}`
    );

    // 2. Full frontend pipeline: Pug -> Lexer -> StripComments -> Parser
    const rustTokens = rustPug.stripComments(
      rustPug.lex(tpl.src, { filename: tpl.filename }),
      { filename: tpl.filename }
    );
    const rustAstFull = rustPug.parse(rustTokens, {
      filename: tpl.filename,
      src: tpl.src,
    });
    const cmpFull = compareStructured(rawAstSingle, rustAstFull);
    assert.equal(
      cmpFull.ok,
      true,
      `Full-frontend pipeline AST mismatch for ${tpl.name}:\nExpected:\n${cmpFull.expectedFormatted}\nActual:\n${cmpFull.actualFormatted}`
    );
  }
});

test('Step 3A: Parser error cases match raw pug-parser code, line, column, and filename', () => {
  const errorCases = [
    {
      name: 'BLOCK_IN_BUFFERED_CODE',
      src: '= foo\n  p Inside buffered code',
      expectedCode: 'PUG:BLOCK_IN_BUFFERED_CODE',
    },
    {
      name: 'BLOCK_OUTISDE_MIXIN',
      src: 'div\n  block',
      expectedCode: 'PUG:BLOCK_OUTISDE_MIXIN',
    },
    {
      name: 'MIXIN_WITHOUT_BODY',
      src: 'mixin emptyMixin()',
      expectedCode: 'PUG:MIXIN_WITHOUT_BODY',
    },
    {
      name: 'RAW_INCLUDE_BLOCK',
      src: 'include file.txt\n  p Cannot have block on raw include',
      expectedCode: 'PUG:RAW_INCLUDE_BLOCK',
    },
    {
      name: 'DUPLICATE_ID',
      src: 'div#first#second',
      expectedCode: 'PUG:DUPLICATE_ID',
    },
  ];

  for (const tc of errorCases) {
    const filename = `${tc.name}.pug`;
    let rawErr = null;
    let rustErr = null;
    try {
      rawParse(rawLex(tc.src, { filename }), { filename, src: tc.src });
    } catch (e) {
      rawErr = e;
    }
    try {
      rustPug.parse(rustPug.lex(tc.src, { filename }), { filename, src: tc.src });
    } catch (e) {
      rustErr = e;
    }
    assert.ok(rawErr, `Expected rawParse to throw for ${tc.name}`);
    assert.ok(rustErr, `Expected rustPug.parse to throw for ${tc.name}`);
    assert.equal(rustErr.code, tc.expectedCode);
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.msg, rawErr.msg);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.column, rawErr.column);
    assert.equal(rustErr.filename, rawErr.filename);
  }
});

test('Step 3A: Walk AST traversal, parents stack, replace(node), replace([]), return false, and includeDependencies', () => {
  const src = 'div\n  p Hello\n  span World';
  const baseAst = rawParse(rawLex(src, { filename: 'walk.pug' }), {
    filename: 'walk.pug',
  });

  // 1. Compare before/after callback logs, options.parents tracking, array reference stability, and return false skipping descent & after
  function runSkipWalk(walkFn, astInput) {
    const log = [];
    const walkOpts = {};
    let initialParentsRef = null;
    let parentsRefChanged = false;

    const recordParents = () => {
      if (initialParentsRef === null) {
        initialParentsRef = walkOpts.parents;
      } else if (walkOpts.parents !== initialParentsRef) {
        parentsRefChanged = true;
      }
      return walkOpts.parents.map((p) => ({
        type: p.type,
        name: p.name || null,
        line: p.line || null,
        column: p.column || null,
      }));
    };

    const out = walkFn(
      astInput,
      (node, replace) => {
        const parentsSnapshot = recordParents();
        log.push({
          phase: 'before',
          type: node.type,
          val: node.name || node.val || null,
          arrayAllowed: Boolean(replace.arrayAllowed),
          parents: parentsSnapshot,
        });
        if (node.type === 'Tag' && node.name === 'p') {
          return false; // skip descending into <p>'s Block/Text and skip after() for <p>
        }
      },
      (node, replace) => {
        const parentsSnapshot = recordParents();
        log.push({
          phase: 'after',
          type: node.type,
          val: node.name || node.val || null,
          arrayAllowed: Boolean(replace.arrayAllowed),
          parents: parentsSnapshot,
        });
      },
      walkOpts
    );
    return {
      log,
      out,
      parentsRefChanged,
      finalParentsLength: Array.isArray(walkOpts.parents) ? walkOpts.parents.length : null,
    };
  }

  const rawSkip = runSkipWalk(rawWalk, cloneJson(baseAst));
  const rustSkip = runSkipWalk(rustPug.walk, cloneJson(baseAst));
  assert.deepEqual(rustSkip.log, rawSkip.log);
  assert.equal(rustSkip.parentsRefChanged, false, 'options.parents array reference must remain stable across callbacks');
  assert.equal(rustSkip.parentsRefChanged, rawSkip.parentsRefChanged);
  assert.equal(rustSkip.finalParentsLength, 0, 'options.parents must be empty after walk finishes');
  assert.equal(rustSkip.finalParentsLength, rawSkip.finalParentsLength);
  // Ensure <p> has Block(div's block) -> Tag(div) -> Block(root) in parents at before()
  const pBefore = rustSkip.log.find((e) => e.phase === 'before' && e.type === 'Tag' && e.val === 'p');
  assert.ok(pBefore && pBefore.parents.length === 3, 'Expected 3 ancestors for <p> tag');
  assert.deepEqual(
    pBefore.parents.map((p) => p.type),
    ['Block', 'Tag', 'Block']
  );
  assert.equal(compareStructured(rawSkip.out, rustSkip.out).ok, true);

  // 1b. options.parents reference stability & cleanup when `after` callback is omitted
  function runNoAfterWalk(walkFn, astInput) {
    const walkOpts = {};
    let firstRef = null;
    let refChanged = false;
    walkFn(
      astInput,
      () => {
        if (firstRef === null) firstRef = walkOpts.parents;
        else if (walkOpts.parents !== firstRef) refChanged = true;
      },
      null,
      walkOpts
    );
    return {
      refChanged,
      finalParentsLength: Array.isArray(walkOpts.parents) ? walkOpts.parents.length : null,
    };
  }
  const rawNoAfter = runNoAfterWalk(rawWalk, cloneJson(baseAst));
  const rustNoAfter = runNoAfterWalk(rustPug.walk, cloneJson(baseAst));
  assert.equal(rustNoAfter.refChanged, rawNoAfter.refChanged);
  assert.equal(rustNoAfter.finalParentsLength, rawNoAfter.finalParentsLength);

  // 1c. Pre-provided empty/non-empty options.parents preservation
  {
    const sentinel = { type: 'Sentinel', line: 0 };
    const rawPre = [sentinel];
    const rustPre = [sentinel];
    const rawOptsPre = { parents: rawPre };
    const rustOptsPre = { parents: rustPre };
    let rawPreChanged = false;
    let rustPreChanged = false;
    const rawSeen = [];
    const rustSeen = [];
    rawWalk(
      cloneJson(baseAst),
      (n) => {
        if (rawOptsPre.parents !== rawPre) rawPreChanged = true;
        rawSeen.push(rawOptsPre.parents.map((p) => p.type));
      },
      null,
      rawOptsPre
    );
    rustPug.walk(
      cloneJson(baseAst),
      (n) => {
        if (rustOptsPre.parents !== rustPre) rustPreChanged = true;
        rustSeen.push(rustOptsPre.parents.map((p) => p.type));
      },
      null,
      rustOptsPre
    );
    assert.equal(rustPreChanged, rawPreChanged);
    assert.deepEqual(rustSeen, rawSeen);
    assert.equal(rustOptsPre.parents, rustPre);
    assert.deepEqual(rustOptsPre.parents, rawOptsPre.parents);
    assert.equal(rustOptsPre.parents[0], sentinel);
  }

  // 1d. Callback throws mid-walk: preserves active parents stack & reference (no artificial finally clear)
  {
    const rawPre = [];
    const rustPre = [];
    const rawOptsThrow = { parents: rawPre };
    const rustOptsThrow = { parents: rustPre };
    assert.throws(
      () =>
        rawWalk(
          cloneJson(baseAst),
          (n) => {
            if (n.type === 'Text') throw new Error('walk-boom');
          },
          null,
          rawOptsThrow
        ),
      /walk-boom/
    );
    assert.throws(
      () =>
        rustPug.walk(
          cloneJson(baseAst),
          (n) => {
            if (n.type === 'Text') throw new Error('walk-boom');
          },
          null,
          rustOptsThrow
        ),
      /walk-boom/
    );
    assert.equal(rustOptsThrow.parents, rustPre);
    assert.deepEqual(
      rustOptsThrow.parents.map((p) => p.type),
      rawOptsThrow.parents.map((p) => p.type)
    );
  }

  // 1e. Re-entrant walk inside before() and node reference relationship in parents
  {
    const runReentrant = (walkFn) => {
      const optsOuter = {};
      const optsInner = {};
      let parentRefOk = false;
      let visitedDiv = null;
      const innerAst = rawParse(rawLex('em inner', { filename: 'inner.pug' }), { filename: 'inner.pug' });
      walkFn(
        cloneJson(baseAst),
        (node) => {
          if (node.type === 'Tag' && node.name === 'div') {
            visitedDiv = node;
          }
          if (node.type === 'Tag' && node.name === 'p') {
            // optsOuter.parents[0] is Block of div; optsOuter.parents[1] is Tag(div)
            parentRefOk = optsOuter.parents[1] === visitedDiv;
            walkFn(cloneJson(innerAst), () => {}, null, optsInner);
          }
        },
        null,
        optsOuter
      );
      return {
        parentRefOk,
        outerFinalLen: optsOuter.parents.length,
        innerFinalLen: optsInner.parents.length,
      };
    };
    const rawRe = runReentrant(rawWalk);
    const rustRe = runReentrant(rustPug.walk);
    assert.deepEqual(rustRe, rawRe);
    assert.equal(rustRe.parentRefOk, true);
  }

  // 2. includeDependencies: true vs false on FileReference.ast
  const astWithDep = {
    type: 'Block',
    line: 1,
    nodes: [
      {
        type: 'Include',
        line: 1,
        file: {
          type: 'FileReference',
          path: 'sub.pug',
          line: 1,
          ast: {
            type: 'Block',
            line: 1,
            nodes: [{ type: 'Text', val: 'inside-dep', line: 1 }],
          },
        },
        block: { type: 'Block', line: 1, nodes: [] },
      },
    ],
  };

  for (const includeDependencies of [false, true]) {
    const rawVisited = [];
    const rustVisited = [];
    rawWalk(
      cloneJson(astWithDep),
      (node) => {
        if (node.type === 'Text') rawVisited.push(node.val);
      },
      null,
      { includeDependencies }
    );
    rustPug.walk(
      cloneJson(astWithDep),
      (node) => {
        if (node.type === 'Text') rustVisited.push(node.val);
      },
      null,
      { includeDependencies }
    );
    assert.deepEqual(rustVisited, rawVisited);
    assert.equal(rustVisited.length, includeDependencies ? 1 : 0);
  }
});

test('Step 3B: Control flow (if/else/unless, each with else, each-of, while, case/when, unbuffered code) HTML & 2-layer JS codegen', () => {
  const cases = [
    {
      name: 'if / else if / else and unless',
      src: [
        '- var score = 85',
        'if score >= 90',
        '  p Grade A',
        'else if score >= 80',
        '  p Grade B',
        'else',
        '  p Grade C',
        'unless score < 60',
        '  span Passed',
      ].join('\n'),
      locals: {},
    },
    {
      name: 'each with key and else alternate block (non-empty array, empty array, object)',
      src: [
        '- var arr = ["alpha", "beta"]',
        '- var emptyArr = []',
        '- var mapObj = { k1: "v1", k2: "v2" }',
        'ul.list1',
        '  each item, idx in arr',
        '    li(data-idx=idx)= item',
        '  else',
        '    li.empty No items',
        'ul.list2',
        '  each item in emptyArr',
        '    li= item',
        '  else',
        '    li.empty Empty fallback',
        'ul.list3',
        '  each val, key in mapObj',
        '    li #{key}=#{val}',
      ].join('\n'),
      locals: {},
    },
    {
      name: 'each ... of loop and while loop',
      src: [
        '- var items = ["x", "y"]',
        'div',
        '  each x of items',
        '    span= x',
        '- var n = 0',
        'ul',
        '  while n < 3',
        '    - n++',
        '    li= n',
      ].join('\n'),
      locals: {},
    },
    {
      name: 'case / when / default and unbuffered code with attached block',
      src: [
        '- var color = "green"',
        'case color',
        '  when "red"',
        '    p Stop',
        '  when "green"',
        '    p Go',
        '  default',
        '    p Wait',
        '- for (var i = 0; i < 2; i++)',
        '  b= i',
      ].join('\n'),
      locals: {},
    },
    {
      name: 'Static & dynamic attributes (id, class array/object, style object, boolean terse, &attributes)',
      src: [
        'doctype html',
        'div#box.static-cls(class=["dyn1", { dyn2: true, dyn3: false }] style={ color: "red", display: "block" } disabled data-escaped="<tag>" data-unescaped!="<raw>")&attributes({ "data-extra": "ok" })',
        '  p!= "<strong>bold</strong>"',
        '  // Buffered HTML comment',
        '  //- Unbuffered Pug comment',
      ].join('\n'),
      locals: {},
    },
  ];

  for (const tc of cases) {
    for (const compileDebug of [false, true]) {
      const opts = { filename: `${tc.name}.pug`, compileDebug };
      const rawClient = rawPug.compileClient(tc.src, opts);
      const rustClient = rustPug.compileClient(tc.src, opts);

      const codeCmp = compareCodegen(rawClient, rustClient);
      assert.equal(
        codeCmp.prettierMatch,
        true,
        `Step 3B Prettier JS mismatch for "${tc.name}" (compileDebug=${compileDebug}):\n--- RAW ---\n${codeCmp.formattedExpected}\n--- RUST ---\n${codeCmp.formattedActual}`
      );
      assert.equal(
        codeCmp.rawMatch,
        true,
        `Step 3B Raw JS mismatch for "${tc.name}" (compileDebug=${compileDebug}):\n--- RAW ---\n${rawClient}\n--- RUST ---\n${rustClient}`
      );

      const rawHtml = rawPug.render(tc.src, { ...opts, ...tc.locals });
      const rustHtml = rustPug.render(tc.src, { ...opts, ...tc.locals });
      const htmlCmp = compareHtml(rawHtml, rustHtml);
      assert.equal(htmlCmp.ok, true, `Step 3B HTML mismatch for "${tc.name}"`);
    }
  }
});

test('Step 3B: Codegen explicitly reports UNSUPPORTED_NODE when an unlowered node reaches codegen', () => {
  const unsupportedAsts = [
    { type: 'Include', file: { type: 'FileReference', path: 'x.pug', line: 1 }, block: { type: 'Block', nodes: [], line: 1 }, line: 1 },
    { type: 'Attrs', attrs: [], line: 1 },
  ];

  for (const injectedNode of unsupportedAsts) {
    assert.throws(
      () =>
        rustPug.compile('p ok', {
          filename: 'unsupported.pug',
          plugins: [
            {
              postLink(ast) {
                ast.nodes.push(injectedNode);
                return ast;
              },
            },
          ],
        }),
      (err) => {
        assert.equal(err.code, 'PUG:UNSUPPORTED_NODE');
        return true;
      }
    );
  }
});

test('Step 3C Matrix 1: Declarations & Shadowing (var/let/const, params, destructuring, closures, catch, block shadowing)', () => {
  // 1a. Direct addWith JS comparison
  const jsSnippets = [
    'var a = 1; let b = 2; const c = 3; pug_html += a + b + c + freeVar;',
    'const { x, y: [z = d] } = sourceObj; pug_html += x + z;',
    'function fn(param1, ...rest) { return param1 + rest.length + outerFree; } pug_html += fn(1, 2, 3);',
    'try { riskyCall(); } catch (err) { pug_html += err.message + outerErr; }',
    'pug_html += shadowed; { let shadowed = "inner"; pug_html += shadowed; }',
  ];

  for (const js of jsSnippets) {
    const exclude = ['pug_html'];
    const rawOut = rawAddWith('locals || {}', js, exclude);
    const rustOut = rustPug._addWith('locals || {}', js, exclude);
    assert.equal(rustOut, rawOut, `Direct addWith mismatch for: ${js}`);
  }

  // 1b. End-to-end Pug template verification (top-level var, block-scoped let/const, destructuring, closures)
  const pugSrc = [
    'p.outer= shadowed',
    '- if (true)',
    '  - let shadowed = "inner-block"',
    '  - const { title, items: [first = fallbackItem] } = payload',
    '  - const format = (prefix, ...rest) => prefix + ":" + rest.join(",") + ":" + suffix',
    '  p.inner= shadowed',
    '  p.destructured= format(title, first)',
  ].join('\n');

  const createLocals = () => ({
    shadowed: 'from-locals',
    fallbackItem: 'default-item',
    payload: { title: 'Hello', items: [] },
    suffix: 'end',
  });

  const rawHtml = rawPug.compile(pugSrc)(createLocals());
  const rustHtml = rustPug.compile(pugSrc)(createLocals());
  assert.equal(rustHtml, rawHtml);
  assert.equal(
    rustHtml,
    '<p class="outer">from-locals</p><p class="inner">inner-block</p><p class="destructured">Hello:default-item:end</p>'
  );

  // 1c. Top-level referenced `let`/`const` rejection matches baseline `with` behavior
  const topLevelLetPug = '- let topLet = 1\np= topLet';
  assert.throws(() => rawPug.compile(topLevelLetPug), SyntaxError);
  assert.throws(() => rustPug.compile(topLevelLetPug), SyntaxError);
});

test('Step 3C Matrix 2: Locals Lookup (own property, prototype chain, missing property, explicit undefined vs global fallback)', () => {
  const pugSrc = [
    'p.own= ownProp',
    'p.proto= protoProp',
    'p.missing= typeof missingProp',
    'p.undefOverride= String(Object)',
    'p.globalMath= Math.max(3, 7)',
  ].join('\n');

  function makeLocalsWithProto(overrideObjectWithUndefined) {
    const proto = { protoProp: 'inherited-from-proto' };
    const locals = Object.create(proto);
    locals.ownProp = 'own-value';
    if (overrideObjectWithUndefined) {
      // Property exists on locals with value `undefined`: `"Object" in locals_for_with` is true!
      locals.Object = undefined;
    }
    return locals;
  }

  for (const overrideObj of [false, true]) {
    const rawHtml = rawPug.compile(pugSrc)(makeLocalsWithProto(overrideObj));
    const rustHtml = rustPug.compile(pugSrc)(makeLocalsWithProto(overrideObj));
    assert.equal(rustHtml, rawHtml);
  }
});

test('Step 3C Matrix 3: Getter Side-Effects (call count, lexicographical order, evaluation timing, and getter throwing)', () => {
  const pugSrc = [
    'p= zVal',
    'p= aVal + aVal',
    'p= mVal',
  ].join('\n');

  function createGetterFixture() {
    const calls = [];
    const locals = {};
    for (const name of ['zVal', 'aVal', 'mVal']) {
      Object.defineProperty(locals, name, {
        enumerable: true,
        get() {
          calls.push(name);
          return `[${name}#${calls.length}]`;
        },
      });
    }
    return { locals, calls };
  }

  const rawFixture = createGetterFixture();
  const rustFixture = createGetterFixture();

  const rawHtml = rawPug.compile(pugSrc)(rawFixture.locals);
  const rustHtml = rustPug.compile(pugSrc)(rustFixture.locals);

  assert.equal(rustHtml, rawHtml);
  // Each free variable getter is read exactly once when binding IIFE arguments in sorted order: aVal, mVal, zVal
  assert.deepEqual(rustFixture.calls, rawFixture.calls);
  assert.deepEqual(rustFixture.calls, ['aVal', 'mVal', 'zVal']);

  // Getter throwing an exception preserves line/filename context
  function createThrowingGetter() {
    const locals = {};
    Object.defineProperty(locals, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    return locals;
  }

  let rawErr = null;
  let rustErr = null;
  try {
    rawPug.render('p= boom', { filename: 'getter.pug', ...createThrowingGetter() });
  } catch (e) {
    rawErr = e;
  }
  try {
    rustPug.render('p= boom', { filename: 'getter.pug', ...createThrowingGetter() });
  } catch (e) {
    rustErr = e;
  }
  assert.ok(rawErr && rustErr);
  assert.equal(rustErr.message, rawErr.message);
});

test('Step 3C Matrix 4: Assignments (=, +=, ++ on local binding vs original locals object)', () => {
  const pugSrc = [
    '- count = count + 10',
    '- count += 5',
    '- count++',
    '- nested.hits++',
    'p #{count}:#{nested.hits}',
  ].join('\n');

  const createLocals = () => ({ count: 1, nested: { hits: 0 } });
  const rawLocals = createLocals();
  const rustLocals = createLocals();

  const rawHtml = rawPug.compile(pugSrc)(rawLocals);
  const rustHtml = rustPug.compile(pugSrc)(rustLocals);

  assert.equal(rustHtml, rawHtml);
  assert.equal(rustHtml, '<p>17:1</p>');
  // Top-level primitive `count` on `locals` is NOT mutated, while `nested.hits` IS mutated
  assert.equal(rustLocals.count, rawLocals.count);
  assert.equal(rustLocals.count, 1);
  assert.equal(rustLocals.nested.hits, rawLocals.nested.hits);
  assert.equal(rustLocals.nested.hits, 1);
});

test('Step 3C Matrix 5: Execution Context (this, arguments, top-level return unwrapping, nested function return)', () => {
  // 5a. Top-level `return` vs nested function `return`
  const returnPug = [
    '- function helper(v) { return v.toUpperCase(); }',
    'p= helper(label)',
    '- if (earlyReturn)',
    '  - return customReturnValue',
    'p After early return',
  ].join('\n');

  const rawFn = rawPug.compile(returnPug);
  const rustFn = rustPug.compile(returnPug);

  assert.equal(
    rustFn({ label: 'hi', earlyReturn: true, customReturnValue: '<custom-early>' }),
    rawFn({ label: 'hi', earlyReturn: true, customReturnValue: '<custom-early>' })
  );
  assert.equal(
    rustFn({ label: 'hi', earlyReturn: true, customReturnValue: '<custom-early>' }),
    '<custom-early>'
  );
  assert.equal(
    rustFn({ label: 'hi', earlyReturn: false, customReturnValue: '<custom-early>' }),
    rawFn({ label: 'hi', earlyReturn: false, customReturnValue: '<custom-early>' })
  );

  // 5b. `this` context preservation via `.call(this, ...)`
  const thisPug = 'p= this.contextTag + ":" + msg';
  const rawThisFn = rawPug.compile(thisPug);
  const rustThisFn = rustPug.compile(thisPug);
  const ctx = { contextTag: 'CTX' };
  assert.equal(
    rustThisFn.call(ctx, { msg: 'hello' }),
    rawThisFn.call(ctx, { msg: 'hello' })
  );
  assert.equal(rustThisFn.call(ctx, { msg: 'hello' }), '<p>CTX:hello</p>');
});

test('Step 3C Matrix 6: Generated Names (collisions with locals_for_with, result_of_with, self)', () => {
  const collisionPug = [
    'p= locals_for_with',
    'p= result_of_with',
    '- if (stopNow)',
    '  - return result_of_with',
  ].join('\n');

  const rawClient = rawPug.compileClient(collisionPug, { compileDebug: false });
  const rustClient = rustPug.compileClient(collisionPug, { compileDebug: false });
  assert.equal(compareCodegen(rawClient, rustClient).ok, true);

  const createLocals = (stopNow) => ({
    locals_for_with: 'user-local',
    result_of_with: 'user-result',
    stopNow,
  });

  assert.equal(
    rustPug.compile(collisionPug)(createLocals(false)),
    rawPug.compile(collisionPug)(createLocals(false))
  );
  assert.equal(
    rustPug.compile(collisionPug)(createLocals(true)),
    rawPug.compile(collisionPug)(createLocals(true))
  );

  // `self: true` option branch
  const selfPug = 'p= self.greeting';
  assert.equal(
    rustPug.render(selfPug, { self: true, greeting: 'from-self' }),
    rawPug.render(selfPug, { self: true, greeting: 'from-self' })
  );
});

test('Step 3C Matrix 7: Multi-level Control Flow & Compile/Runtime Error Distinction', () => {
  // 7a. Compile-time invalid JS syntax in unbuffered code is rejected at compile time by Oxc
  assert.throws(() => {
    rustPug.compile('- var broken = (;');
  });

  // 7b. Runtime error inside multi-level control flow reports exact Pug line and filename
  const runtimeErrPug = [
    'div',
    '  if showSection',
    '    each row in rows',
    '      p= row.nested.value',
  ].join('\n');

  const createBadLocals = () => ({
    showSection: true,
    rows: [{ nested: { value: 'ok' } }, { nested: null }],
  });

  for (const compileDebug of [false, true]) {
    let rawRuntimeErr = null;
    let rustRuntimeErr = null;
    try {
      rawPug.render(runtimeErrPug, {
        filename: 'flow-err.pug',
        compileDebug,
        ...createBadLocals(),
      });
    } catch (e) {
      rawRuntimeErr = e;
    }
    try {
      rustPug.render(runtimeErrPug, {
        filename: 'flow-err.pug',
        compileDebug,
        ...createBadLocals(),
      });
    } catch (e) {
      rustRuntimeErr = e;
    }
    assert.ok(rawRuntimeErr && rustRuntimeErr);
    assert.equal(rustRuntimeErr.message, rawRuntimeErr.message);
    if (compileDebug) {
      assert.ok(rustRuntimeErr.message.includes('flow-err.pug:4'));
    }
  }
});

test('Step 3B Regression (ISSUE-IMPL-01 & classes-empty): Constant number formatting, edge values, and non-constant undefined', () => {
  const templates = [
    'div(foo=1 + 2)',
    'td(colspan=2)',
    'foo(data-items=[1, 2, 3])',
    'div(a=-5 b=1.5 c=0 d=-0 e=0 * -1 f=1 - 1)',
    'div(a={ x: 1, y: -2.5, z: -0 })',
    'div(a=9007199254740991 b=-9007199254740991)',
    'div(a=1e20 b=1e21 c=1e-6 d=1e-7)',
    'div(a=1 / 0 b=0 / 0)',
    'a(class="")\na(class=null)\na(class=undefined)',
  ];

  for (const src of templates) {
    const rawHtml = rawPug.render(src);
    const rustHtml = rustPug.render(src);
    assert.equal(rustHtml, rawHtml, `HTML mismatch for: ${src}`);

    const rawClient = rawPug.compileClient(src, { compileDebug: false });
    const rustClient = rustPug.compileClient(src, { compileDebug: false });
    const cg = compareCodegen(rawClient, rustClient);
    assert.equal(cg.prettierMatch, true, `Prettier mismatch for: ${src}`);
    assert.equal(cg.rawMatch, true, `Raw JS mismatch for: ${src}`);
  }
});

test('Step 3B Regression (ISSUE-IMPL-02 & 03): Doctype, html tag, options.doctype, terse/xml, and repeated compiler calls', () => {
  const cases = [
    ['html', {}],
    ['html', { doctype: '' }],
    ['html', { doctype: 'html' }],
    ['html', { doctype: 'xml' }],
    ['doctype', {}],
    ['doctype', { doctype: '' }],
    ['doctype', { doctype: 'xml' }],
    ['doctype', { doctype: 'html' }],
    ['doctype html', {}],
    ['doctype html', { doctype: 'xml' }],
    ['doctype xml', { doctype: 'html' }],
    ['doctype\nhtml\n  input(checked)\n  br', {}],
    ['html\n  input(checked)\n  br', {}],
    ['html\n  input(checked)\n  br', { doctype: 'html' }],
    ['doctype xml\nhtml\n  input(checked)\n  br', {}],
  ];

  // Run twice in alternating order to verify no state leaks across compiler instances
  for (let pass = 0; pass < 2; pass++) {
    for (const [src, opts] of cases) {
      const rawHtml = rawPug.render(src, { ...opts });
      const rustHtml = rustPug.render(src, { ...opts });
      assert.equal(rustHtml, rawHtml, `HTML mismatch (pass ${pass}) for ${JSON.stringify(src)} ${JSON.stringify(opts)}`);

      const rawClient = rawPug.compileClient(src, { ...opts, compileDebug: false });
      const rustClient = rustPug.compileClient(src, { ...opts, compileDebug: false });
      const cg = compareCodegen(rawClient, rustClient);
      assert.equal(cg.ok, true, `Codegen mismatch (pass ${pass}) for ${JSON.stringify(src)} ${JSON.stringify(opts)}`);
    }
  }
});

test('Step 3C Regression (ISSUE-IMPL-04): arguments scope in regular functions, arrow functions, top-level, shadowing, and locals getter', () => {
  // 1. Direct addWith comparisons
  const addWithCases = [
    ['regular function arguments', 'function firstArg() { return arguments[0]; }\npug_html = pug_html + firstArg("ok");'],
    ['arrow inside regular function', 'function outer() { return (() => arguments[0])(); }\npug_html = pug_html + outer("ok");'],
    ['top-level arrow function', 'const f = () => arguments[0];\npug_html = pug_html + f();'],
    ['top-level and regular function', 'function f() { return arguments[0]; }\npug_html = pug_html + f("a") + arguments;'],
    ['explicit parameter shadowing', 'function f(arguments) { return arguments; }\npug_html = pug_html + f("ok");'],
    ['top-level var arguments + regular fn', 'var arguments = 1;\nfunction f() { return arguments[0]; }\npug_html = pug_html + f("ok");'],
  ];

  for (const [label, js] of addWithCases) {
    const rawOut = rawAddWith('locals || {}', js, ['pug_html']);
    const rustOut = rustPug._addWith('locals || {}', js, ['pug_html']);
    assert.equal(rustOut, rawOut, `addWith mismatch for ${label}`);
  }

  // 2. End-to-end Pug render + getter side-effect log on locals.arguments
  function runWithGetter(engine, tpl) {
    let argGetterCalls = 0;
    const locals = {};
    Object.defineProperty(locals, 'arguments', {
      enumerable: true,
      get() {
        argGetterCalls++;
        return ['from-getter'];
      },
    });
    const html = engine.render(tpl, locals);
    return { html, argGetterCalls };
  }

  // Regular function must NOT trigger getter on locals.arguments!
  const regTpl = '- function firstArg() { return arguments[0]; }\np= firstArg("ok")';
  const rawReg = runWithGetter(rawPug, regTpl);
  const rustReg = runWithGetter(rustPug, regTpl);
  assert.deepEqual(rustReg, rawReg);
  assert.equal(rustReg.html, '<p>ok</p>');
  assert.equal(rustReg.argGetterCalls, 0);

  // Arrow inside regular function must NOT trigger getter on locals.arguments!
  const arrowInRegTpl = '- function outer() { return (() => arguments[0])(); }\np= outer("nested")';
  const rawArrowInReg = runWithGetter(rawPug, arrowInRegTpl);
  const rustArrowInReg = runWithGetter(rustPug, arrowInRegTpl);
  assert.deepEqual(rustArrowInReg, rawArrowInReg);
  assert.equal(rustArrowInReg.html, '<p>nested</p>');
  assert.equal(rustArrowInReg.argGetterCalls, 0);

  // Top-level arrow function SHOULD read locals.arguments once!
  const topArrowTpl = '- var f = () => arguments[0];\np= f()';
  const rawTopArrow = runWithGetter(rawPug, topArrowTpl);
  const rustTopArrow = runWithGetter(rustPug, topArrowTpl);
  assert.deepEqual(rustTopArrow, rawTopArrow);
  assert.equal(rustTopArrow.html, '<p>from-getter</p>');
  assert.equal(rustTopArrow.argGetterCalls, 1);

  // Top-level + regular function together SHOULD read locals.arguments once!
  const bothTpl = '- function f() { return arguments[0]; }\np #{f("fn")}:#{arguments[0]}';
  const rawBoth = runWithGetter(rawPug, bothTpl);
  const rustBoth = runWithGetter(rustPug, bothTpl);
  assert.deepEqual(rustBoth, rawBoth);
  assert.equal(rustBoth.html, '<p>fn:from-getter</p>');
  assert.equal(rustBoth.argGetterCalls, 1);
});
