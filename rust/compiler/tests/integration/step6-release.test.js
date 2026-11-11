import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import rustPug from '../../index.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILER_ROOT = path.resolve(__dirname, '../..');
const RAW_ROOT = path.resolve(__dirname, '../../../../raw/compiler');
const rawPug = require(path.join(RAW_ROOT, 'packages/pug'));

test('Step 6.1: Public APIs, options, __express, client modules & register.js parity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step6-api-'));
  try {
    // 1. __express with NODE_ENV=production vs unset
    const exprFile = path.join(tmpDir, 'express-err.pug');
    fs.writeFileSync(exprFile, 'p= user.name');
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      let rustErr = null;
      let rawErr = null;
      rustPug.__express(exprFile, {}, (err) => {
        rustErr = err;
      });
      rawPug.__express(exprFile, {}, (err) => {
        rawErr = err;
      });
      assert.ok(rustErr && rawErr);
      assert.strictEqual(rustErr.message, rawErr.message);

      // Explicit compileDebug: true overrides NODE_ENV === 'production'
      let rustDbgErr = null;
      let rawDbgErr = null;
      rustPug.__express(exprFile, { compileDebug: true, user: null }, (err) => {
        rustDbgErr = err;
      });
      rawPug.__express(exprFile, { compileDebug: true, user: null }, (err) => {
        rawDbgErr = err;
      });
      assert.ok(rustDbgErr && rawDbgErr);
      assert.match(rustDbgErr.message, /express-err\.pug:1/);
      assert.strictEqual(rustDbgErr.message, rawDbgErr.message);

      // __express(path, fn) 2-argument form
      const okFile = path.join(tmpDir, 'express-ok.pug');
      fs.writeFileSync(okFile, 'p Hello Express');
      let rustHtml = null;
      let rawHtml = null;
      rustPug.__express(okFile, (err, html) => {
        assert.ifError(err);
        rustHtml = html;
      });
      rawPug.__express(okFile, (err, html) => {
        assert.ifError(err);
        rawHtml = html;
      });
      assert.strictEqual(rustHtml, rawHtml);
      assert.strictEqual(rustHtml, '<p>Hello Express</p>');
    } finally {
      if (prevEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevEnv;
      }
    }

    // 2. compileClient / compileFileClient with module & inlineRuntimeFunctions flags
    for (const inlineRuntimeFunctions of [true, false]) {
      const clientOpts = {
        self: true,
        module: true,
        inlineRuntimeFunctions,
        name: 'customFn',
      };
      const tplPath = path.join(tmpDir, `client-${inlineRuntimeFunctions}.pug`);
      fs.writeFileSync(tplPath, '.badge= self.label');
      const rustSrc = rustPug.compileFileClient(tplPath, clientOpts);
      assert.match(rustSrc, /function customFn\(locals\)/);
      assert.match(rustSrc, /module\.exports = customFn;/);
      if (inlineRuntimeFunctions === false) {
        assert.match(rustSrc, /^var pug = require\("pug-runtime"\);/);
      } else {
        assert.ok(!rustSrc.startsWith('var pug = require("pug-runtime");'));
      }
      const outPath = path.join(tmpDir, `compiled-${inlineRuntimeFunctions}.cjs`);
      const patchedSrc = rustSrc.replace(
        'require("pug-runtime")',
        `require(${JSON.stringify(path.join(COMPILER_ROOT, 'runtime/index.js'))})`
      );
      fs.writeFileSync(outPath, patchedSrc);
      const loadedFn = require(outPath);
      assert.strictEqual(loadedFn({ label: 'v6' }), '<div class="badge">v6</div>');
    }

    // 3. register.js in isolated child Node process (CJS consumer requiring ESM register.js & .pug file)
    const regPugPath = path.join(tmpDir, 'reg-sample.pug');
    fs.writeFileSync(regPugPath, 'section.card\n  h1= title\n  p&attributes(attrs) ok');
    const regScript = `
      require(${JSON.stringify(path.join(COMPILER_ROOT, 'register.js'))});
      const tpl = require(${JSON.stringify(regPugPath)});
      const html = tpl({ title: 'Registered', attrs: { 'data-ok': '1' } });
      process.stdout.write(html);
    `;
    const regOut = execFileSync(process.execPath, ['-e', regScript], { encoding: 'utf8' });
    assert.strictEqual(regOut, '<section class="card"><h1>Registered</h1><p data-ok="1">ok</p></section>');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 6.2: Full plugin pipeline hooks, replacement conflicts, Buffer read, and plugin.lex', () => {
  const entry = 'virtual-entry.pug';
  const order = [];
  const fullPlugin = {
    resolve(filename, source, options) {
      order.push(`resolve:${filename}:${path.basename(source)}`);
      return filename;
    },
    read(filename, options) {
      order.push(`read:${filename}`);
      return Buffer.from('span from-buffer', 'utf8');
    },
    preLex(str, options) {
      order.push(`preLex:${options.filename}`);
      return str;
    },
    lex: {
      advance(lexer) {
        if (lexer.input.charAt(0) === '~') {
          order.push('lex.advance:~');
          lexer.tokens.push(lexer.tok('text', 'step6-lex'));
          lexer.consume(1);
          lexer.incrementColumn(1);
          return true;
        }
      },
    },
    postLex(tokens, options) {
      order.push(`postLex:${options.filename}`);
      return tokens;
    },
    preParse(tokens, options) {
      order.push(`preParse:${options.filename}`);
      return tokens;
    },
    postParse(ast, options) {
      order.push(`postParse:${options.filename}`);
      return ast;
    },
    preLoad(ast, options) {
      order.push(`preLoad:${options.filename}`);
      return ast;
    },
    postLoad(ast, options) {
      order.push(`postLoad:${options.filename}`);
      return ast;
    },
    preFilters(ast, options) {
      order.push('preFilters');
      return ast;
    },
    postFilters(ast, options) {
      order.push('postFilters');
      return ast;
    },
    preLink(ast, options) {
      order.push('preLink');
      return ast;
    },
    postLink(ast, options) {
      order.push('postLink');
      return ast;
    },
    preCodeGen(ast, options) {
      order.push('preCodeGen');
      return ast;
    },
    postCodeGen(js, options) {
      order.push('postCodeGen');
      return js;
    },
  };

  const rendered = rustPug.render(
    'include virtual-part.pug\np Look at #[~]',
    {
      filename: entry,
      plugins: [fullPlugin],
    }
  );
  assert.strictEqual(rendered, '<span>from-buffer</span><p>Look at step6-lex</p>');
  assert.ok(order.includes('resolve:virtual-part.pug:virtual-entry.pug'));
  assert.ok(order.includes('read:virtual-part.pug'));
  assert.ok(order.includes('lex.advance:~'));
  for (const hook of [
    'preFilters',
    'postFilters',
    'preLink',
    'postLink',
    'preCodeGen',
    'postCodeGen',
  ]) {
    assert.ok(order.includes(hook), `missing ${hook} in ${JSON.stringify(order)}`);
  }

  // Custom generateCode replacement + multiple replacement conflict check
  const genOut = rustPug.compileClient('p hi', {
    plugins: [
      {
        generateCode(ast, opts) {
          assert.strictEqual(ast.type, 'Block');
          return `function ${opts.templateName || 'template'}(){return "custom-cg";}`;
        },
      },
    ],
  });
  assert.strictEqual(genOut, 'function template(){return "custom-cg";}');

  for (const conflictKey of ['resolve', 'read', 'generateCode']) {
    const p1 = { [conflictKey]: () => '' };
    const p2 = { [conflictKey]: () => '' };
    const tpl = conflictKey === 'generateCode' ? 'p hi' : 'include a.pug';
    const expectedMsg = new RegExp(`Two or more plugins all implement ${conflictKey} method\\.`);
    assert.throws(
      () => rustPug.compile(tpl, { filename: 'x.pug', plugins: [p1, p2] }),
      expectedMsg
    );
    assert.throws(
      () => rawPug.compile(tpl, { filename: 'x.pug', plugins: [p1, p2] }),
      expectedMsg
    );
  }
});

test('Step 6.3: Worker threads concurrent addon load, sync callbacks, and isolation', async () => {
  const entryHref = pathToFileURL(path.join(COMPILER_ROOT, 'index.js')).href;
  const workerScript = `
    import { parentPort, workerData } from 'node:worker_threads';
    import pug from ${JSON.stringify(entryHref)};

    const { id } = workerData;
    const cacheKey = 'worker-template.pug';
    // Register a worker-local filter on shared global object name in this thread
    pug.filters['wtag'] = (text) => '[w' + id + ':' + text.trim() + ']';
    pug.cache[cacheKey] = pug.compile('.from-cache Cache-' + id);

    const html = pug.render(
      'include part.pug\\n:wtag\\n  body\\np #[~]',
      {
        filename: 'main-' + id + '.pug',
        plugins: [
          {
            resolve(file) { return file; },
            read() { return 'span worker-' + id; },
            lex: {
              advance(lexer) {
                if (lexer.input.charAt(0) === '~') {
                  lexer.tokens.push(lexer.tok('text', 'lex-' + id));
                  lexer.consume(1);
                  lexer.incrementColumn(1);
                  return true;
                }
              },
            },
          },
        ],
      }
    );

    const cachedHtml = pug.cache[cacheKey]();
    let trappedErr = null;
    try {
      pug.render('div(');
    } catch (err) {
      trappedErr = err.code;
    }

    parentPort.postMessage({
      id,
      html,
      cachedHtml,
      trappedErr,
      cacheKeys: Object.keys(pug.cache),
      filterKeys: Object.keys(pug.filters),
    });
  `;

  const runWorker = (id) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerScript, {
        eval: true,
        workerData: { id },
      });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker ${id} exited with code ${code}`));
      });
    });

  const [w1, w2] = await Promise.all([runWorker(1), runWorker(2)]);
  assert.strictEqual(w1.html, '<span>worker-1</span>[w1:body]<p>lex-1</p>');
  assert.strictEqual(w2.html, '<span>worker-2</span>[w2:body]<p>lex-2</p>');
  assert.strictEqual(w1.cachedHtml, '<div class="from-cache">Cache-1</div>');
  assert.strictEqual(w2.cachedHtml, '<div class="from-cache">Cache-2</div>');
  assert.strictEqual(w1.trappedErr, 'PUG:NO_END_BRACKET');
  assert.strictEqual(w2.trappedErr, 'PUG:NO_END_BRACKET');
  // Main thread cache & filters remain untouched by workers
  assert.strictEqual(rustPug.cache['worker-template.pug'], undefined);
  assert.strictEqual(rustPug.filters['wtag'], undefined);
});

test('Step 6.4: Security hardening & approved differences verification', () => {
  // 1. HTML & JS string breakout / XSS escaping parity
  const xssTpl = [
    'p= userInput',
    'a(href=attrUrl title=attrQuote) link',
    'script var s = #{jsStr};',
  ].join('\n');
  const xssLocals = {
    userInput: '<img src=x onerror=alert(1)>',
    attrUrl: 'javascript:alert("1")',
    attrQuote: '" onmouseover="alert(1)',
    jsStr: JSON.stringify('</script><script>alert(1)</script>\u2028\u2029'),
  };
  assert.strictEqual(
    rustPug.render(xssTpl, xssLocals),
    rawPug.render(xssTpl, xssLocals)
  );
  const renderedXss = rustPug.render(xssTpl, xssLocals);
  assert.ok(!renderedXss.includes('<img src=x'));
  assert.ok(renderedXss.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(renderedXss.includes('&quot; onmouseover=&quot;alert(1)'));

  // 2. Unregistered filter fails loudly (no silent passthrough / shell eval)
  assert.throws(
    () => rustPug.compile(':nonexistentFilter\n  hi'),
    /unknown filter ":nonexistentFilter"/
  );

  // 3. Expected differences file integrity & exact V8 TypeError parity
  const diffSpec = JSON.parse(
    fs.readFileSync(path.join(COMPILER_ROOT, 'compat/expected-differences.json'), 'utf8')
  );
  assert.strictEqual(diffSpec.schemaVersion, 1);
  assert.ok(Array.isArray(diffSpec.environmentDifferences) && diffSpec.environmentDifferences.length >= 1);
  for (const rel of [
    'packages/pug/test/fixtures/runtime.with.mixin.error.pug',
    'packages/pug/test/fixtures/runtime.layout.error.pug',
  ]) {
    const filePath = path.join(RAW_ROOT, rel);
    let rawMsg;
    let rustMsg;
    try { rawPug.renderFile(filePath, {}); } catch (e) { rawMsg = e.message; }
    try { rustPug.renderFile(filePath, {}); } catch (e) { rustMsg = e.message; }
    assert.strictEqual(rustMsg, rawMsg);
  }
});

test('Step 6.5: Separated performance measurements (cold start, compile, render, NAPI, plugins, memory)', (t) => {
  const perfTemplate = fs.readFileSync(
    path.join(RAW_ROOT, 'packages/pug/test/cases/mixins.pug'),
    'utf8'
  );

  // 1. Cold start (fresh Node process loading rust/compiler/index.js)
  const coldStartScript = `
    import { performance } from 'node:perf_hooks';
    const t0 = performance.now();
    await import(${JSON.stringify(pathToFileURL(path.join(COMPILER_ROOT, 'index.js')).href)});
    const t1 = performance.now();
    process.stdout.write(String(t1 - t0));
  `;
  const coldStartMs = Number(
    execFileSync(process.execPath, ['--input-type=module', '-e', coldStartScript], {
      encoding: 'utf8',
    })
  );
  assert.ok(Number.isFinite(coldStartMs) && coldStartMs > 0);

  // Warmup
  for (let i = 0; i < 10; i++) {
    rustPug.compile(perfTemplate)({});
  }

  const N = 100;

  // 2. Compile only
  const c0 = performance.now();
  let compiledFn;
  for (let i = 0; i < N; i++) {
    compiledFn = rustPug.compile(perfTemplate, { compileDebug: false });
  }
  const compileMs = (performance.now() - c0) / N;

  // 3. Render only
  const r0 = performance.now();
  for (let i = 0; i < N; i++) {
    compiledFn({});
  }
  const renderMs = (performance.now() - r0) / N;

  // 4. NAPI serialization / lex+parse boundary overhead
  const n0 = performance.now();
  for (let i = 0; i < N; i++) {
    const toks = rustPug.lex(perfTemplate);
    rustPug.parse(toks);
  }
  const napiLexParseMs = (performance.now() - n0) / N;

  // 5. Plugin callback bridge overhead (pipeline + plugin.lex)
  const pluginOpts = {
    plugins: [
      {
        preLex: (s) => s,
        postLex: (toks) => toks,
        lex: { advance() {} },
        postCodeGen: (js) => js,
      },
    ],
  };
  const p0 = performance.now();
  for (let i = 0; i < N; i++) {
    rustPug.compile('p Hello #[strong world]', pluginOpts);
  }
  const pluginCompileMs = (performance.now() - p0) / N;

  // 6. Memory delta across N compilations
  if (typeof global.gc === 'function') global.gc();
  const memBefore = process.memoryUsage();
  for (let i = 0; i < N; i++) {
    rustPug.compile(perfTemplate, { cache: false });
  }
  if (typeof global.gc === 'function') global.gc();
  const memAfter = process.memoryUsage();
  const heapDeltaMb = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
  const rssDeltaMb = (memAfter.rss - memBefore.rss) / (1024 * 1024);

  assert.ok(heapDeltaMb < 64, `unexpected heap growth: ${heapDeltaMb.toFixed(2)} MB`);
  assert.ok(rssDeltaMb < 128, `unexpected rss growth: ${rssDeltaMb.toFixed(2)} MB`);

  t.diagnostic(
    `Perf breakdown (${N}x mixins.pug): coldStart=${coldStartMs.toFixed(2)}ms, compile=${compileMs.toFixed(3)}ms/op, render=${renderMs.toFixed(4)}ms/op, napiLexParse=${napiLexParseMs.toFixed(3)}ms/op, pluginCompile=${pluginCompileMs.toFixed(3)}ms/op, heapDelta=${heapDeltaMb.toFixed(2)}MB, rssDelta=${rssDeltaMb.toFixed(2)}MB`
  );
});
