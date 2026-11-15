import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rustPug from '../../index.js';
import serializers from '../differential/serializers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const RAW_ROOT = path.resolve(__dirname, '../../../raw/compiler');
const rawPug = require(path.join(RAW_ROOT, 'packages/pug'));

test('Step 4B.1: Compile-time constant option evaluation, non-constants, syntax errors, unsupported constants, and void 0', () => {
  // 1a. Rich constant expressions evaluated at compile time only (not re-evaluated on render)
  let filterCalls = 0;
  const tpl = [
    ':inspect(num=1 + 2 * 3, str="hello".toUpperCase(), arr=[...[1, 2], 3], obj={ a: 1, ["b" + 2]: "x" }, hasA=("a" in { a: 1 }), fixed=(1.2345).toFixed(2), flag, undef=void 0)',
    '  body text',
  ].join('\n');

  function runWith(engine, onCall) {
    return engine.compile(tpl, {
      filename: 'const.pug',
      filterOptions: { inspect: { undef: 'SHOULD_NOT_OVERRIDE', extra: 42 } },
      filters: {
        inspect(text, opts) {
          onCall(text, {
            keys: Object.keys(opts),
            hasUndefKey: Object.prototype.hasOwnProperty.call(opts, 'undef'),
            undefIsUndefined: opts.undef === undefined,
            num: opts.num,
            str: opts.str,
            arr: opts.arr,
            obj: opts.obj,
            hasA: opts.hasA,
            fixed: opts.fixed,
            flag: opts.flag,
            extra: opts.extra,
            filename: opts.filename,
          });
          return text;
        },
      },
    });
  }

  let rawCaptured, rustCaptured;
  const rawFn = runWith(rawPug, (_t, c) => { rawCaptured = c; });
  const rustFn = runWith(rustPug, (_t, c) => { filterCalls++; rustCaptured = c; });

  assert.deepEqual(rustCaptured, rawCaptured);
  assert.equal(rustCaptured.undefIsUndefined, true);
  assert.equal(rustCaptured.hasUndefKey, true);
  assert.equal(rustCaptured.num, 7);
  assert.equal(rustCaptured.str, 'HELLO');
  assert.equal(rustCaptured.fixed, '1.23');
  assert.equal(rustCaptured.extra, 42);
  assert.equal(filterCalls, 1);
  // Rendering multiple times does NOT re-run compile-time filter
  assert.equal(rustFn(), 'body text');
  assert.equal(rustFn(), 'body text');
  assert.equal(filterCalls, 1);

  // 1b. Non-constant expressions, `pug` / `pug_interp` (not predefined for filters), and invalid syntax
  for (const badExpr of ['dynamicVar', 'pug', 'pug_interp', 'Math.max(1, 2)']) {
    const src = `p\n  :cdata(opt=${badExpr})\n    hi`;
    let rawErr, rustErr;
    try { rawPug.compile(src, { filename: 'badopt.pug' }); } catch (e) { rawErr = e; }
    try { rustPug.compile(src, { filename: 'badopt.pug' }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, 'PUG:FILTER_OPTION_NOT_CONSTANT');
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.column, rawErr.column);
    assert.equal(rustErr.filename, rawErr.filename);
    assert.equal(rustErr.msg, rawErr.msg);
  }
  // Invalid expression syntax inside AST filter attr -> FILTER_OPTION_NOT_CONSTANT (matching constantinople.toConstant)
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
    (err) => {
      assert.equal(err.code, 'PUG:FILTER_OPTION_NOT_CONSTANT');
      return true;
    }
  );

  // 1c. Unsupported constant constructs explicitly report PUG:UNSUPPORTED_CONSTANT (not disguised as NotConstant)
  for (const unsupExpr of ['tag`hello`', 'null ?? 1', '/abc/.test("abc")']) {
    const src = `:cdata(opt=${unsupExpr})\n  hi`;
    assert.throws(
      () => rustPug.compile(src, { filename: 'unsup.pug' }),
      (err) => {
        assert.equal(err.code, 'PUG:UNSUPPORTED_CONSTANT');
        return true;
      }
    );
  }
});

test('Step 4B.2: Nested filters, filterOptions before filterAliases, and RawInclude .renderBuffer vs fallback vs JSTransformer renderFile', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4b-'));
  try {
    const binBytes = Buffer.from([0x00, 0xfe, 0x48, 0x69, 0xff]); // invalid UTF-8 bytes
    const binPath = path.join(tmp, 'blob.bin');
    const txtPath = path.join(tmp, 'note.txt');
    fs.writeFileSync(binPath, binBytes);
    fs.writeFileSync(txtPath, 'raw text payload');

    function runWith(engine) {
      const log = [];
      const bufFilter = function(str, opts) {
        log.push(['bufFilter:str', str, opts.filename]);
        return 'STR:' + str;
      };
      bufFilter.renderBuffer = function(buf, opts) {
        log.push(['bufFilter:renderBuffer', Buffer.isBuffer(buf), Buffer.compare(buf, binBytes), opts.filename, opts.tag]);
        return 'BUF:' + buf.toString('hex');
      };

      const fallbackFilter = function(str, opts) {
        log.push(['fallbackFilter', str, opts.filename, opts.tag]);
        return '[' + opts.tag + ':' + str + ']';
      };

      const wrapFilter = function(str, opts) {
        log.push(['wrapFilter', str, opts.filename, opts.prefix]);
        return (opts.prefix || '') + str;
      };

      const tpl = [
        ':wrap(prefix="OUT:"):aliasInner',
        '  body',
        'p',
        '  include:wrap:bufAlias(tag="B") blob.bin',
        'p',
        '  include:wrap:fallbackFilter(tag="F") note.txt',
      ].join('\n');

      const opts = {
        filename: path.join(tmp, 'entry.pug'),
        basedir: tmp,
        compileDebug: false,
        filterOptions: {
          aliasInner: { tag: 'INNER_OPT', prefix: 'IN:' },
          wrap: { prefix: 'DEFAULT:' },
        },
        filterAliases: {
          aliasInner: 'fallbackFilter',
          bufAlias: 'bufFilter',
        },
        filters: {
          bufFilter,
          fallbackFilter,
          wrap: wrapFilter,
        },
      };

      const html = engine.render(tpl, opts);
      const cg = engine.compileClient(tpl, opts);
      return { html, cg, log };
    }

    const rRaw = runWith(rawPug);
    const rRust = runWith(rustPug);

    assert.deepEqual(rRust.log, rRaw.log);
    assert.equal(rRust.html, rRaw.html);
    assert.equal(
      rRust.html,
      'OUT:[INNER_OPT:body]<p>DEFAULT:BUF:00fe4869ff</p><p>DEFAULT:[F:raw text payload]</p>'
    );
    const cgCmp = serializers.compareCodegen(rRaw.cg, rRust.cg);
    assert.equal(cgCmp.ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 4B.3: Filters inside loaded Pug dependencies run before Linker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4b-dep-'));
  try {
    const depPath = path.join(tmp, 'dep.pug');
    fs.writeFileSync(depPath, ':cdata\n  hello from dep\n');

    let postFiltersSnap = null;
    const tracked = rustPug.compileClientWithDependenciesTracked('include dep.pug\n', {
      filename: path.join(tmp, 'main.pug'),
      basedir: tmp,
      plugins: [
        {
          postFilters(ast) {
            postFiltersSnap = ast;
            return ast;
          },
          generateCode() {
            return 'function template() { return ""; }';
          },
        },
      ],
    });

    assert.deepEqual(tracked.dependencies, [depPath]);
    const depAst = postFiltersSnap.nodes[0].file.ast;
    assert.equal(depAst.nodes[0].type, 'Text');
    assert.equal(depAst.nodes[0].val, '<![CDATA[hello from dep]]>');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 4B.4: End-to-end HTML + 2-layer codegen for all raw pug/test/cases/filters*.pug', () => {
  const casesDir = path.join(RAW_ROOT, 'packages/pug/test/cases');
  const runUtils = require(path.join(RAW_ROOT, 'packages/pug/test/run-utils'));
  const filterCases = fs
    .readdirSync(casesDir)
    .filter((f) => /^filters.*\.pug$/.test(f))
    .sort();

  assert.equal(filterCases.length, 10);

  for (const file of filterCases) {
    const fullPath = path.join(casesDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    const opts = {
      filename: fullPath,
      basedir: casesDir,
      pretty: true,
      compileDebug: false,
      filterAliases: { markdown: 'markdown-it' },
      filters: runUtils.filters,
    };
    const rawHtml = rawPug.render(src, opts);
    const rustHtml = rustPug.render(src, opts);
    assert.equal(rustHtml, rawHtml, `HTML mismatch for ${file}`);

    const cg = serializers.compareCodegen(
      rawPug.compileClient(src, opts),
      rustPug.compileClient(src, opts)
    );
    assert.equal(cg.ok, true, `Codegen mismatch for ${file}`);
  }
});

test('Step 4B.5: Error handling (UNKNOWN_FILTER, FILTER_ALISE_CHAIN, JS exception identity, abnormal return values)', () => {
  // 5a. Unknown filter location
  {
    const src = 'p\n  :nonexistentFilter\n    body';
    let rawErr, rustErr;
    try { rawPug.compile(src, { filename: 'u.pug' }); } catch (e) { rawErr = e; }
    try { rustPug.compile(src, { filename: 'u.pug' }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, 'PUG:UNKNOWN_FILTER');
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.column, rawErr.column);
    assert.equal(rustErr.filename, rawErr.filename);
    assert.equal(rustErr.msg, rawErr.msg);
  }

  // 5b. Alias chain error
  {
    const src = ':a\n  hi';
    let rawErr, rustErr;
    const opts = { filename: 'a.pug', filterAliases: { a: 'b', b: 'c' } };
    try { rawPug.compile(src, opts); } catch (e) { rawErr = e; }
    try { rustPug.compile(src, opts); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, 'PUG:FILTER_ALISE_CHAIN');
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.msg, rawErr.msg);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.column, rawErr.column);
  }

  // 5c. Custom filter throwing custom Error subclass preserves object identity across FFI
  class CustomFilterBoom extends SyntaxError {
    constructor(msg) {
      super(msg);
      this.marker = 'FILTER_ERR_77';
    }
  }
  {
    const thrown = new CustomFilterBoom('filter exploded');
    let caught = null;
    try {
      rustPug.compile(':boom\n  hi', {
        filters: { boom() { throw thrown; } },
      });
    } catch (e) {
      caught = e;
    }
    assert.equal(caught, thrown);
    assert.equal(caught instanceof CustomFilterBoom, true);
    assert.equal(caught.marker, 'FILTER_ERR_77');
  }

  // 5d. Abnormal non-string return value from custom filter raises explicit TypeError without panic
  for (const badReturn of [undefined, null, 42, { body: 'x' }]) {
    assert.throws(
      () =>
        rustPug.compile(':badRet\n  hi', {
          filters: { badRet: () => badReturn },
        }),
      TypeError
    );
  }
});
