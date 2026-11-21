import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ismd from '../../index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ISMD_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.resolve(ISMD_ROOT, '../ismd-cli/index.mjs');

test('JS API: Simple API + Advanced createCompiler removeFiles & dispose lifecycle', () => {
  // Simple API
  assert.equal(ismd.render('p Hello #{name}', { name: 'World' }), '<p>Hello World</p>');
  const fn = ismd.compile('div= count');
  assert.equal(fn({ count: 42 }), '<div>42</div>');

  // Advanced API: removeFiles + dispose
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-js-api-'));
  try {
    const p1 = path.join(dir, 'a.pug');
    const p2 = path.join(dir, 'b.pug');
    fs.writeFileSync(p1, 'p A\n', 'utf8');
    fs.writeFileSync(p2, 'p B\n', 'utf8');

    const compiler = ismd.createCompiler({ basedir: dir, compileDebug: false });
    const res = compiler.compileEntries([p1, p2]);
    assert.equal(res.length, 2);
    assert.equal(compiler.stats().sources, 2);
    assert.equal(compiler.stats().fnCache, 2);

    const rem = compiler.removeFiles([p1]);
    assert.equal(rem.changed, true);
    assert.equal(compiler.stats().sources, 1);
    assert.equal(compiler.stats().fnCache, 1);

    compiler.dispose();
    assert.equal(compiler.isDisposed, true);
    assert.throws(() => compiler.compileEntries([p2]), /disposed/);
    // Idempotent dispose
    compiler.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JS API: circular include throws error instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cycle-'));
  try {
    const a = path.join(dir, 'a.pug');
    const b = path.join(dir, 'b.pug');
    fs.writeFileSync(a, 'include b.pug\n', 'utf8');
    fs.writeFileSync(b, 'include a.pug\n', 'utf8');

    assert.throws(() => ismd.compileFile(a), /Circular include\/extends/);
    assert.throws(
      () => ismd.compile('include b.pug\n', { filename: a, plugins: [{ name: 'noop' }] }),
      /Circular include\/extends/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JS API: batch fallback isolates per-entry errors when throwOnError is false', () => {
  const results = ismd.compileBatch(
    [
      { id: 'ok', filename: 'ok.pug', source: 'p ok' },
      { id: 'bad', filename: 'nonexistent-file-12345.pug' },
    ],
    { plugins: [{ preParse: (tokens) => tokens }] },
    { throwOnError: false }
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].fn(), '<p>ok</p>');
  assert.equal(results[1].ok, false);
  assert.ok(results[1].error instanceof Error);
});

test('JS API: template cache respects content changes and avoids Object.prototype collisions', () => {
  assert.equal(
    ismd.render('p A', { cache: true, filename: 'cache-test-key' }),
    '<p>A</p>'
  );
  assert.equal(
    ismd.render('p B', { cache: true, filename: 'cache-test-key' }),
    '<p>B</p>'
  );
  assert.equal(
    ismd.render('p Proto', { cache: true, filename: 'constructor' }),
    '<p>Proto</p>'
  );
  delete ismd.cache['cache-test-key'];
  delete ismd.cache['constructor'];
});

test('JS API: pure CJS require("x.pug") works via ismd/register', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cjs-reg-'));
  try {
    const tplPath = path.join(dir, 'hello.pug');
    const cjsPath = path.join(dir, 'app.cjs');
    fs.writeFileSync(tplPath, 'p Hello #{name}\n', 'utf8');
    fs.writeFileSync(
      cjsPath,
      `require(${JSON.stringify(path.join(ISMD_ROOT, 'register.mjs'))});\n` +
        `const tpl = require(${JSON.stringify(tplPath)});\n` +
        `process.stdout.write(tpl({ name: 'CJS' }));\n`,
      'utf8'
    );
    const out = execFileSync(process.execPath, [cjsPath], { encoding: 'utf8' });
    assert.equal(out, '<p>Hello CJS</p>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: missing option values and invalid JSON produce clear errors', () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI_PATH, '-o'], { encoding: 'utf8', stdio: 'pipe' }),
    /Option -o requires a value/
  );
  assert.throws(
    () => execFileSync(process.execPath, [CLI_PATH, '-O', '{bad'], { encoding: 'utf8', stdio: 'pipe' }),
    /Invalid JSON for -O/
  );
});

test('JS API: dynamic attribute name with quotes is properly escaped', () => {
  assert.equal(ismd.render("div('a\"b'=x)", { x: '1' }), '<div a"b="1"></div>');
});

test('JS API: 4-level extends chain with same-name block replace + append/prepend does not duplicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-ext-chain-'));
  try {
    fs.writeFileSync(path.join(dir, 'base.pug'), 'html\n  body\n    block content\n      p BASE\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'mid1.pug'), 'extends base.pug\nblock content\n  p MID1\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'mid2.pug'), 'extends mid1.pug\nblock content\n  p MID2\n', 'utf8');
    const pageAppend = path.join(dir, 'page-append.pug');
    const pagePrepend = path.join(dir, 'page-prepend.pug');
    fs.writeFileSync(pageAppend, 'extends mid2.pug\nblock append content\n  p PAGE\n', 'utf8');
    fs.writeFileSync(pagePrepend, 'extends mid2.pug\nblock prepend content\n  p PAGE\n', 'utf8');

    assert.equal(ismd.renderFile(pageAppend), '<html><body><p>MID2</p><p>PAGE</p></body></html>');
    assert.equal(ismd.renderFile(pagePrepend), '<html><body><p>PAGE</p><p>MID2</p></body></html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JS API: uppercase .PUG include and mixin default object spread arg work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-up-ext-'));
  try {
    fs.writeFileSync(path.join(dir, 'PART.PUG'), 'span UPPER\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'main.pug'), 'div\n  include PART.PUG\n', 'utf8');
    assert.equal(ismd.renderFile(path.join(dir, 'main.pug')), '<div><span>UPPER</span></div>');

    const mixinHtml = ismd.render(
      '- var x = { b: 2 }\nmixin m(o={a:1,...x})\n  p= o.a + "-" + o.b\n+m()\n'
    );
    assert.equal(mixinHtml, '<p>1-2</p>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JS API: walk handles 800+ nodes in linear time and restores parents on error', () => {
  const sections = Array.from({ length: 80 }, (_, i) => `section\n  h2 Title ${i}\n  p Body ${i}\n  ul\n    li Item ${i}\n`).join('');
  const tokens = ismd.lex(sections);
  const ast = ismd.parse(tokens);

  let visited = 0;
  const parents = [];
  const t0 = performance.now();
  const walked = ismd.walk(
    ast,
    (node) => {
      visited++;
      if (node.type === 'Text' && node.val === 'Title 0') {
        assert.ok(parents.length >= 2);
        assert.equal(parents[0].type, 'Block');
      }
    },
    (node) => {
      if (node.type === 'Text' && node.val === 'Body 0') {
        node.val = 'Updated 0';
      }
    },
    { parents }
  );
  const elapsedMs = performance.now() - t0;
  assert.ok(visited >= 800, `expected >= 800 visited nodes, got ${visited}`);
  assert.ok(elapsedMs < 500, `walk took too long: ${elapsedMs.toFixed(1)}ms`);
  assert.equal(parents.length, 0);
  assert.equal(walked.nodes[0].block.nodes[1].block.nodes[0].val, 'Updated 0');

  assert.throws(
    () =>
      ismd.walk(
        ast,
        (node) => {
          if (node.type === 'Text') throw new Error('stop');
        },
        { parents }
      ),
    /stop/
  );
  assert.equal(parents.length, 0);
});

test('JS API: compileBatch and createCompiler respect preLex/postLex hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-batch-hooks-'));
  try {
    const file = path.join(dir, 'a.pug');
    fs.writeFileSync(file, 'div XX\n', 'utf8');
    const plugins = [
      {
        preLex(src) {
          return src.replace('XX', 'YY');
        },
        postLex(tokens) {
          return tokens.map((t) => (t.type === 'text' && t.val === 'YY' ? { ...t, val: 'ZZ' } : t));
        },
      },
    ];

    assert.equal(ismd.renderFile(file, { plugins }), '<div>ZZ</div>');

    const batchRes = ismd.compileBatch([{ filename: file, options: { plugins } }]);
    assert.equal(batchRes[0].fn(), '<div>ZZ</div>');

    const compiler = ismd.createCompiler();
    try {
      const sessionRes = compiler.compileEntries([{ filename: file, options: { plugins } }]);
      assert.equal(sessionRes[0].fn(), '<div>ZZ</div>');
    } finally {
      compiler.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JS API: compileBatch and createCompiler support custom templateName', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-tpl-name-'));
  try {
    const file = path.join(dir, 'a.pug');
    fs.writeFileSync(file, 'p= msg\n', 'utf8');

    const batchRes = ismd.compileBatch([
      { id: 'non-inline', filename: file, options: { templateName: 'foo', inlineRuntimeFunctions: false } },
      { id: 'inline', filename: file, options: { templateName: 'bar', inlineRuntimeFunctions: true } },
    ]);
    assert.equal(batchRes[0].fn({ msg: 'hi' }), '<p>hi</p>');
    assert.equal(batchRes[1].fn({ msg: 'hi' }), '<p>hi</p>');

    const compiler = ismd.createCompiler();
    try {
      const sessionRes = compiler.compileEntries([
        { id: 's-non-inline', filename: file, options: { templateName: 'foo', inlineRuntimeFunctions: false } },
        { id: 's-inline', filename: file, options: { templateName: 'bar', inlineRuntimeFunctions: true } },
      ]);
      assert.equal(sessionRes[0].fn({ msg: 'ok' }), '<p>ok</p>');
      assert.equal(sessionRes[1].fn({ msg: 'ok' }), '<p>ok</p>');
    } finally {
      compiler.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JS API: inlineRuntimeFunctions rethrow does not fail with require is not defined', () => {
  const fnWithSource = ismd.compile('p= missing.prop\n', {
    filename: 'inline-err.pug',
    inlineRuntimeFunctions: true,
  });
  assert.throws(
    () => fnWithSource({}),
    (err) => {
      assert.ok(!err.message.includes('require is not defined'));
      assert.ok(err.message.includes('p= missing.prop'));
      return true;
    }
  );

  const fnNoSource = ismd.compile('p= missing.prop\n', {
    filename: 'inline-err.pug',
    inlineRuntimeFunctions: true,
    includeSources: false,
  });
  assert.throws(
    () => fnNoSource({}),
    (err) => {
      assert.ok(!err.message.includes('require is not defined'));
      assert.ok(err.message.includes('on line 1'));
      return true;
    }
  );
});
