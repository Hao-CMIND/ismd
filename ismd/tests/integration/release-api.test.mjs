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
import rustIsmd from '../../index.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILER_ROOT = path.resolve(__dirname, '../..');
const RAW_ROOT = path.resolve(__dirname, '../../../raw/compiler');
const rawIsmd = require(path.join(RAW_ROOT, 'packages/ismd'));

test('Step 6.1: Public APIs, options, __express, client modules & register.js parity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step6-api-'));
  try {
    // 1. __express with NODE_ENV=production vs unset
    const exprFile = path.join(tmpDir, 'express-err.pug');
    fs.writeFileSync(exprFile, 'p= user.name');
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      let rustErr = null;
      let rawErr = null;
      rustIsmd.__express(exprFile, {}, (err) => {
        rustErr = err;
      });
      rawIsmd.__express(exprFile, {}, (err) => {
        rawErr = err;
      });
      assert.ok(rustErr && rawErr);
      assert.strictEqual(rustErr.message, rawErr.message);

      // Explicit compileDebug: true overrides NODE_ENV === 'production'
      let rustDbgErr = null;
      let rawDbgErr = null;
      rustIsmd.__express(exprFile, { compileDebug: true, user: null }, (err) => {
        rustDbgErr = err;
      });
      rawIsmd.__express(exprFile, { compileDebug: true, user: null }, (err) => {
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
      rustIsmd.__express(okFile, (err, html) => {
        assert.ifError(err);
        rustHtml = html;
      });
      rawIsmd.__express(okFile, (err, html) => {
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

    // 2. compileFile with self & inlineRuntimeFunctions flags (compileFileClient was removed in c121f92)
    for (const inlineRuntimeFunctions of [true, false]) {
      const compileOpts = {
        self: true,
        inlineRuntimeFunctions,
        compileDebug: false,
      };
      const tplPath = path.join(tmpDir, `client-${inlineRuntimeFunctions}.pug`);
      fs.writeFileSync(tplPath, '.badge= self.label');
      const compiledFn = rustIsmd.compileFile(tplPath, compileOpts);
      const fnSrc = compiledFn.toString();
      assert.match(fnSrc, /function template\(locals\)/);
      if (inlineRuntimeFunctions) {
        assert.ok(fnSrc.includes('ismd_escape('), 'expected inlined ismd_escape');
      } else {
        assert.ok(fnSrc.includes('ismd.escape('), 'expected external ismd.escape');
      }
      assert.strictEqual(compiledFn({ label: 'v6' }), '<div class="badge">v6</div>');
    }

    // 3. register.mjs in isolated child Node process (CJS consumer requiring ESM register.mjs & .pug file)
    const regIsmdPath = path.join(tmpDir, 'reg-sample.pug');
    fs.writeFileSync(regIsmdPath, 'section.card\n  h1= title\n  p&attributes(attrs) ok');
    const regScript = `
      require(${JSON.stringify(path.join(COMPILER_ROOT, 'register.mjs'))});
      const tpl = require(${JSON.stringify(regIsmdPath)});
      const html = tpl({ title: 'Registered', attrs: { 'data-ok': '1' } });
      process.stdout.write(html);
    `;
    const regOut = execFileSync(process.execPath, ['-e', regScript], { encoding: 'utf8' });
    assert.strictEqual(regOut, '<section class="card"><h1>Registered</h1><p data-ok="1">ok</p></section>');

    // 4. Sync callback throwing exception (no double call, exact error propagation)
    const cbFile = path.join(tmpDir, 'cb-ok.pug');
    fs.writeFileSync(cbFile, 'p Callback ok');
    for (const engine of [rawIsmd, rustIsmd]) {
      let calls = 0;
      const boom = new Error('cb-boom');
      assert.throws(
        () =>
          engine.render('p hi', (err) => {
            calls++;
            assert.ifError(err);
            throw boom;
          }),
        (e) => e === boom
      );
      assert.strictEqual(calls, 1);

      let fileCalls = 0;
      assert.throws(
        () =>
          engine.renderFile(cbFile, (err) => {
            fileCalls++;
            assert.ifError(err);
            throw boom;
          }),
        (e) => e === boom
      );
      assert.strictEqual(fileCalls, 1);
    }

    // 5. Cache hit skips recompile & plugin hooks; mtime change or cache delete invalidates; missing filename errors
    // Expected improvement vs rawIsmd: handleTemplateCache checks fs.statSync(key).mtimeMs so disk edits invalidate automatically.
    assert.throws(
      () => rustIsmd.render('p hi', { cache: true }),
      /the "filename" option is required for caching/
    );
    const cacheFile = path.join(tmpDir, 'cached.pug');
    fs.writeFileSync(cacheFile, 'p cached-v1');
    let preLexHits = 0;
    const cachePlugin = { preLex: (s) => { preLexHits++; return s; } };
    delete rustIsmd.cache[cacheFile];
    try {
      assert.strictEqual(rustIsmd.renderFile(cacheFile, { cache: true, plugins: [cachePlugin] }), '<p>cached-v1</p>');
      assert.strictEqual(preLexHits, 1);
      // Unchanged file hits cache and skips plugin hooks
      assert.strictEqual(rustIsmd.renderFile(cacheFile, { cache: true, plugins: [cachePlugin] }), '<p>cached-v1</p>');
      assert.strictEqual(preLexHits, 1);
      // Modifying file + advancing mtime invalidates cache automatically
      fs.writeFileSync(cacheFile, 'p cached-v2');
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(cacheFile, future, future);
      assert.strictEqual(rustIsmd.renderFile(cacheFile, { cache: true, plugins: [cachePlugin] }), '<p>cached-v2</p>');
      assert.strictEqual(preLexHits, 2);
      // Explicit cache delete also invalidates
      delete rustIsmd.cache[cacheFile];
      assert.strictEqual(rustIsmd.renderFile(cacheFile, { cache: true, plugins: [cachePlugin] }), '<p>cached-v2</p>');
      assert.strictEqual(preLexHits, 3);
    } finally {
      delete rustIsmd.cache[cacheFile];
    }

    // 6. debug: true outputs ANSI formatted function to console.error identically to raw
    const origConsoleErr = console.error;
    const rawDebugLogs = [];
    const rustDebugLogs = [];
    try {
      console.error = (...args) => rawDebugLogs.push(args);
      rawIsmd.compile('p debug', { debug: true, compileDebug: false });
      console.error = (...args) => rustDebugLogs.push(args);
      rustIsmd.compile('p debug', { debug: true, compileDebug: false });
    } finally {
      console.error = origConsoleErr;
    }
    assert.strictEqual(rustDebugLogs.length, 1);
    assert.strictEqual(rustDebugLogs[0][0], '\nCompiled Function:\n\n\u001b[90m%s\u001b[0m');
    assert.deepStrictEqual(rustDebugLogs, rawDebugLogs);

    // 7. index.d.ts declares all current public exports & Options fields
    // (filters, compileClient, compileClientWithDependenciesTracked, compileFileClient were removed)
    const dts = fs.readFileSync(path.join(COMPILER_ROOT, 'index.d.ts'), 'utf8');
    for (const sym of [
      'name', 'cache', 'runtime',
      'compile', 'compileFile',
      'render', 'renderFile', '__express',
    ]) {
      assert.ok(sym in rustIsmd, `missing runtime export ${sym}`);
      assert.ok(dts.includes(sym), `index.d.ts missing export ${sym}`);
    }
    for (const opt of ['includeSources', 'inlineRuntimeFunctions', 'compileDebug', 'plugins']) {
      assert.ok(dts.includes(opt), `index.d.ts Options missing ${opt}`);
    }
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

  const rendered = rustIsmd.render(
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
  // Phase 6 removed preFilters/postFilters hooks; verify remaining pipeline hooks execute in order
  assert.ok(!order.includes('preFilters'), 'preFilters should not run after Phase 6');
  assert.ok(!order.includes('postFilters'), 'postFilters should not run after Phase 6');
  for (const hook of [
    'preLink',
    'postLink',
    'preCodeGen',
    'postCodeGen',
  ]) {
    assert.ok(order.includes(hook), `missing ${hook} in ${JSON.stringify(order)}`);
  }

  // Custom generateCode replacement + multiple replacement conflict check
  const genFn = rustIsmd.compile('p hi', {
    plugins: [
      {
        generateCode(ast, opts) {
          assert.strictEqual(ast.type, 'Block');
          return `function ${opts.templateName || 'template'}(){return "custom-cg";}`;
        },
      },
    ],
  });
  assert.strictEqual(genFn(), 'custom-cg');

  for (const conflictKey of ['resolve', 'read', 'generateCode']) {
    const p1 = { [conflictKey]: () => '' };
    const p2 = { [conflictKey]: () => '' };
    const tpl = conflictKey === 'generateCode' ? 'p hi' : 'include a.pug';
    const expectedMsg = new RegExp(`Two or more plugins all implement ${conflictKey} method\\.`);
    assert.throws(
      () => rustIsmd.compile(tpl, { filename: 'x.pug', plugins: [p1, p2] }),
      expectedMsg
    );
    assert.throws(
      () => rawIsmd.compile(tpl, { filename: 'x.pug', plugins: [p1, p2] }),
      expectedMsg
    );
  }

  // Re-entrancy inside lex.advance + AST mutation vs replacement + Buffer read
  const rawPayload = Buffer.from([0x00, 0x01, 0xfe]);
  const reentrantFn = rustIsmd.compile('include bin.raw\np #[!]', {
    filename: 'outer.pug',
    plugins: [
      {
        resolve(file) {
          return file;
        },
        read(file, opts) {
          assert.strictEqual(opts.filename, 'outer.pug');
          return rawPayload;
        },
        lex: {
          advance(lexer) {
            if (lexer.input.charAt(0) === '!') {
              const inner = rustIsmd.render('em= v', { v: 'reentrant-lex' });
              assert.strictEqual(inner, '<em>reentrant-lex</em>');
              lexer.tokens.push(lexer.tok('text', 'lex-ok'));
              lexer.consume(1);
              lexer.incrementColumn(1);
              return true;
            }
          },
        },
        postLoad(ast) {
          const rawNode = ast.nodes.find((n) => n.type === 'RawInclude');
          assert.ok(Buffer.isBuffer(rawNode.file.raw));
          assert.deepStrictEqual(rawNode.file.raw, rawPayload);
          // Replace node explicitly
          ast.nodes[1] = {
            type: 'Tag',
            name: 'div',
            selfClosing: false,
            block: { type: 'Block', nodes: [{ type: 'Text', val: 'replaced-ast', line: 2, filename: 'outer.pug' }], line: 2 },
            attrs: [],
            attributeBlocks: [],
            isInline: false,
            line: 2,
            filename: 'outer.pug',
          };
          return ast;
        },
      },
    ],
  });
  assert.deepStrictEqual(reentrantFn.dependencies, ['bin.raw']);
  assert.strictEqual(reentrantFn({}), `${rawPayload.toString('utf8')}<div>replaced-ast</div>`);
});

test('Step 6.3: Worker threads concurrent addon load, sync callbacks, and isolation', async () => {
  const entryHref = pathToFileURL(path.join(COMPILER_ROOT, 'index.mjs')).href;
  const workerScript = `
    import { parentPort, workerData } from 'node:worker_threads';
    import ismd from ${JSON.stringify(entryHref)};

    const { id } = workerData;
    const cacheKey = 'worker-template.pug';
    ismd.cache[cacheKey] = ismd.compile('.from-cache Cache-' + id);

    const html = ismd.render(
      'include part.pug\\np #[~]',
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

    const cachedHtml = ismd.cache[cacheKey]();
    let trappedErr = null;
    try {
      ismd.render('div(');
    } catch (err) {
      trappedErr = err.code;
    }
    let hookErr = null;
    try {
      ismd.render('p ok', { plugins: [{ preLex() { throw new Error('worker-hook-err'); } }] });
    } catch (err) {
      hookErr = err.message;
    }
    const recoveredHtml = ismd.render('p= ok', { ok: 'after-err-' + id });

    parentPort.postMessage({
      id,
      html,
      cachedHtml,
      trappedErr,
      hookErr,
      recoveredHtml,
      cacheKeys: Object.keys(ismd.cache),
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
  assert.strictEqual(w1.html, '<span>worker-1</span><p>lex-1</p>');
  assert.strictEqual(w2.html, '<span>worker-2</span><p>lex-2</p>');
  assert.strictEqual(w1.cachedHtml, '<div class="from-cache">Cache-1</div>');
  assert.strictEqual(w2.cachedHtml, '<div class="from-cache">Cache-2</div>');
  assert.strictEqual(w1.trappedErr, 'ISMD:NO_END_BRACKET');
  assert.strictEqual(w2.trappedErr, 'ISMD:NO_END_BRACKET');
  assert.strictEqual(w1.hookErr, 'worker-hook-err');
  assert.strictEqual(w2.hookErr, 'worker-hook-err');
  assert.strictEqual(w1.recoveredHtml, '<p>after-err-1</p>');
  assert.strictEqual(w2.recoveredHtml, '<p>after-err-2</p>');

  // Sequential worker termination & recreation works cleanly
  const w3 = await runWorker(3);
  assert.strictEqual(w3.recoveredHtml, '<p>after-err-3</p>');

  // Main thread cache remains untouched by workers
  assert.strictEqual(rustIsmd.cache['worker-template.pug'], undefined);
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
    rustIsmd.render(xssTpl, xssLocals),
    rawIsmd.render(xssTpl, xssLocals)
  );
  const renderedXss = rustIsmd.render(xssTpl, xssLocals);
  assert.ok(!renderedXss.includes('<img src=x'));
  assert.ok(renderedXss.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(renderedXss.includes('&quot; onmouseover=&quot;alert(1)'));

  // 2. Inline filter syntax fails loudly at lex time (Phase 6 removed filter syntax; no silent passthrough)
  assert.throws(
    () => rustIsmd.compile(':nonexistentFilter\n  hi'),
    (err) => err && err.code === 'ISMD:UNEXPECTED_TEXT'
  );

  // 3. Expected differences file integrity & exact V8 TypeError parity
  const diffSpec = JSON.parse(
    fs.readFileSync(path.join(COMPILER_ROOT, 'compat/expected-differences.json'), 'utf8')
  );
  assert.strictEqual(diffSpec.schemaVersion, 1);
  assert.ok(Array.isArray(diffSpec.environmentDifferences) && diffSpec.environmentDifferences.length >= 1);
  const RAW_PUG_ROOT = path.resolve(__dirname, '../../../raw/pug');
  for (const [ismdRel, pugRel] of [
    ['packages/ismd/test/fixtures/runtime.with.mixin.error.pug', 'packages/pug/test/fixtures/runtime.with.mixin.error.pug'],
    ['packages/ismd/test/fixtures/runtime.layout.error.pug', 'packages/pug/test/fixtures/runtime.layout.error.pug'],
  ]) {
    const rawFile = path.join(RAW_ROOT, ismdRel);
    const rustFile = path.join(RAW_PUG_ROOT, pugRel);
    let rawMsg;
    let rustMsg;
    try { rawIsmd.renderFile(rawFile, {}); } catch (e) { rawMsg = e.message; }
    try { rustIsmd.renderFile(rustFile, {}); } catch (e) { rustMsg = e.message; }
    assert.ok(rawMsg && rustMsg);
    const norm = (s) =>
      s
        .replace(/raw[\\/]compiler[\\/]packages[\\/]ismd/g, '<pkg>')
        .replace(/raw[\\/]pug[\\/]packages[\\/]pug/g, '<pkg>')
        .replace(/\.pug\b/g, '.pug');
    assert.strictEqual(norm(rustMsg), norm(rawMsg));
  }
});

test('Step 6.5: Separated performance measurements (cold start, compile, render, NAPI, plugins, memory)', (t) => {
  const perfTemplate = fs.readFileSync(
    path.join(RAW_ROOT, 'packages/ismd/test/cases/mixins.pug'),
    'utf8'
  );

  // 1. Cold start (fresh Node process loading ismd/index.mjs)
  const coldStartScript = `
    import { performance } from 'node:perf_hooks';
    const t0 = performance.now();
    await import(${JSON.stringify(pathToFileURL(path.join(COMPILER_ROOT, 'index.mjs')).href)});
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
    rustIsmd.compile(perfTemplate)({});
  }

  const N = 100;

  // 2. Compile only
  const c0 = performance.now();
  let compiledFn;
  for (let i = 0; i < N; i++) {
    compiledFn = rustIsmd.compile(perfTemplate, { compileDebug: false });
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
    const toks = rustIsmd.lex(perfTemplate);
    rustIsmd.parse(toks);
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
    rustIsmd.compile('p Hello #[strong world]', pluginOpts);
  }
  const pluginCompileMs = (performance.now() - p0) / N;

  // 6. Cold vs Hot cache renderFile measurements
  const cacheTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step6-perf-cache-'));
  let coldCacheMs = 0;
  let hotCacheMs = 0;
  try {
    const cacheTplPath = path.join(cacheTmpDir, 'perf.pug');
    fs.writeFileSync(cacheTplPath, perfTemplate);
    delete rustIsmd.cache[cacheTplPath];
    const cc0 = performance.now();
    rustIsmd.renderFile(cacheTplPath, { cache: true, compileDebug: false });
    coldCacheMs = performance.now() - cc0;

    const hc0 = performance.now();
    for (let i = 0; i < N; i++) {
      rustIsmd.renderFile(cacheTplPath, { cache: true, compileDebug: false });
    }
    hotCacheMs = (performance.now() - hc0) / N;
    delete rustIsmd.cache[cacheTplPath];
  } finally {
    fs.rmSync(cacheTmpDir, { recursive: true, force: true });
  }

  // 7. Memory delta across N compilations
  if (typeof global.gc === 'function') global.gc();
  const memBefore = process.memoryUsage();
  for (let i = 0; i < N; i++) {
    rustIsmd.compile(perfTemplate, { cache: false });
  }
  if (typeof global.gc === 'function') global.gc();
  const memAfter = process.memoryUsage();
  const heapDeltaMb = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
  const rssDeltaMb = (memAfter.rss - memBefore.rss) / (1024 * 1024);

  assert.ok(heapDeltaMb < 64, `unexpected heap growth: ${heapDeltaMb.toFixed(2)} MB`);
  assert.ok(rssDeltaMb < 128, `unexpected rss growth: ${rssDeltaMb.toFixed(2)} MB`);

  t.diagnostic(
    `Perf breakdown (${N}x mixins.pug): coldStart=${coldStartMs.toFixed(2)}ms, compile=${compileMs.toFixed(3)}ms/op, render=${renderMs.toFixed(4)}ms/op, napiLexParse=${napiLexParseMs.toFixed(3)}ms/op, pluginCompile=${pluginCompileMs.toFixed(3)}ms/op, coldCache=${coldCacheMs.toFixed(3)}ms, hotCache=${hotCacheMs.toFixed(4)}ms/op, heapDelta=${heapDeltaMb.toFixed(2)}MB, rssDelta=${rssDeltaMb.toFixed(2)}MB`
  );
});

test('Step 6.6: Packed tarball clean install verification in isolated project (ESM, register, runtime, plugins, worker)', () => {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step6-pack-'));
  const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step6-consumer-'));
  try {
    const tgzName = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--pack-destination', packDir, '--silent'],
      { cwd: COMPILER_ROOT, encoding: 'utf8', shell: process.platform === 'win32' }
    ).trim().split(/\r?\n/).pop();
    const tgzPath = path.join(packDir, tgzName);
    assert.ok(fs.existsSync(tgzPath), `missing packed tarball: ${tgzPath}`);

    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'ismd-clean-consumer', version: '1.0.0', private: true, type: 'module' }, null, 2)
    );
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--offline', '--no-audit', '--no-fund', tgzPath],
      { cwd: consumerDir, stdio: 'pipe', shell: process.platform === 'win32' }
    );

    fs.writeFileSync(path.join(consumerDir, 'base.pug'), 'html\n  body\n    block content\n');
    fs.writeFileSync(
      path.join(consumerDir, 'view.pug'),
      'extends base\nblock content\n  p= msg\n  p #[~]\n'
    );
    fs.writeFileSync(
      path.join(consumerDir, 'verify-esm.mjs'),
      `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { createRequire } from 'node:module';
      import { Worker } from 'node:worker_threads';
      import ismd from 'ismd';
      import runtime from 'ismd/runtime';

      const require = createRequire(import.meta.url);
      const html = ismd.renderFile(path.resolve('view.pug'), {
        msg: 'isolated-ok',
        plugins: [{
          lex: {
            advance(lexer) {
              if (lexer.input.charAt(0) === '~') {
                lexer.tokens.push(lexer.tok('text', 'pkg-lex'));
                lexer.consume(1);
                lexer.incrementColumn(1);
                return true;
              }
            }
          }
        }]
      });
      assert.strictEqual(html, '<html><body><p>isolated-ok</p><p>pkg-lex</p></body></html>');

      const compiled = ismd.compile('p= x', { inlineRuntimeFunctions: false, compileDebug: false });
      const wrappedFn = Function('ismd', compiled.toString() + '; return template;')(runtime);
      assert.strictEqual(wrappedFn({ x: 'rt' }), '<p>rt</p>');

      require('ismd/register');
      fs.writeFileSync('reg-view.pug', 'span= label');
      const regFn = require(path.resolve('reg-view.pug'));
      assert.strictEqual(regFn({ label: 'reg-ok' }), '<span>reg-ok</span>');

      const workerRes = await new Promise((resolve, reject) => {
        const w = new Worker(\`
          import { parentPort } from 'node:worker_threads';
          import ismd from 'ismd';
          parentPort.postMessage(ismd.render('b= v', { v: 'worker-pkg' }));
        \`, { eval: true });
        w.on('message', resolve);
        w.on('error', reject);
      });
      assert.strictEqual(workerRes, '<b>worker-pkg</b>');

      const loadedPaths = Object.keys(require.cache);
      assert.strictEqual(loadedPaths.some((p) => p.toLowerCase().includes('raw')), false);
      assert.strictEqual(
        loadedPaths.filter((p) => p.endsWith('.node')).every((p) => p.startsWith(path.resolve('node_modules'))),
        true
      );
      process.stdout.write('CLEAN_PKG_OK');
      `
    );

    const out = execFileSync(process.execPath, ['verify-esm.mjs'], {
      cwd: consumerDir,
      encoding: 'utf8',
    });
    assert.strictEqual(out, 'CLEAN_PKG_OK');
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.rmSync(consumerDir, { recursive: true, force: true });
  }
});

test('Step 6.7: Sparse plugin lifecycle callbacks (preLex-only, postParse-only, ordering, fs ENOENT parity)', () => {
  // 1. Only preLex plugin: triggers only preLex and matches rawIsmd
  const preLexEvents = [];
  const preLexPlugin = {
    preLex(src, opts) {
      preLexEvents.push({ hook: 'preLex', filename: opts.filename });
      return src.replace('OLD', 'NEW');
    },
  };
  const src1 = 'p OLD';
  const rust1 = rustIsmd.render(src1, { filename: 'a.pug', plugins: [preLexPlugin] });
  const raw1 = rawIsmd.render(src1, {
    filename: 'a.pug',
    plugins: [{ preLex: (s) => s.replace('OLD', 'NEW') }],
  });
  assert.strictEqual(rust1, '<p>NEW</p>');
  assert.strictEqual(rust1, raw1);
  assert.deepStrictEqual(preLexEvents, [{ hook: 'preLex', filename: 'a.pug' }]);

  // 2. Only postParse plugin: triggers only postParse and preserves AST roundtrip & parity
  const postParseEvents = [];
  const postParsePlugin = {
    postParse(ast, opts) {
      postParseEvents.push({
        hook: 'postParse',
        type: ast.type,
        filename: opts.filename,
      });
      ast.nodes[0].attrs.push({ name: 'data-pp', val: "'ok'", mustEscape: true });
      return ast;
    },
  };
  const src2 = 'div hi';
  const rust2 = rustIsmd.render(src2, { filename: 'b.pug', plugins: [postParsePlugin] });
  const raw2 = rawIsmd.render(src2, {
    filename: 'b.pug',
    plugins: [
      {
        postParse(ast) {
          ast.nodes[0].attrs.push({ name: 'data-pp', val: "'ok'", mustEscape: true });
          return ast;
        },
      },
    ],
  });
  assert.strictEqual(rust2, '<div data-pp="ok">hi</div>');
  assert.strictEqual(rust2, raw2);
  assert.deepStrictEqual(postParseEvents, [
    { hook: 'postParse', type: 'Block', filename: 'b.pug' },
  ]);

  // 3. Multiple plugins implementing the same hook execute in exact registration order
  const order = [];
  const pA = {
    preLex(s) {
      order.push('A:preLex');
      return s;
    },
    postParse(ast) {
      order.push('A:postParse');
      return ast;
    },
    preCodeGen(ast) {
      order.push('A:preCodeGen');
      return ast;
    },
  };
  const pB = {
    preLex(s) {
      order.push('B:preLex');
      return s.replace('VAL', 'STEP1');
    },
    postParse(ast) {
      order.push('B:postParse');
      return ast;
    },
  };
  const pC = {
    preLex(s) {
      order.push('C:preLex');
      return s.replace('STEP1', 'STEP2');
    },
    preCodeGen(ast) {
      order.push('C:preCodeGen');
      return ast;
    },
  };
  const rust3 = rustIsmd.render('p VAL', { plugins: [pA, pB, pC] });
  assert.strictEqual(rust3, '<p>STEP2</p>');
  assert.deepStrictEqual(order, [
    'A:preLex',
    'B:preLex',
    'C:preLex',
    'A:postParse',
    'B:postParse',
    'A:preCodeGen',
    'C:preCodeGen',
  ]);

  // 4. Built-in Rust filesystem read preserves ENOENT code & message parity when no customRead
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step6-enoent-'));
  try {
    const entry = path.join(tmpDir, 'entry.pug');
    fs.writeFileSync(entry, 'include does-not-exist.pug\n');
    let rustErr = null;
    let rawErr = null;
    try {
      rustIsmd.compileFile(entry);
    } catch (e) {
      rustErr = e;
    }
    try {
      rawIsmd.compileFile(entry);
    } catch (e) {
      rawErr = e;
    }
    assert.ok(rustErr && rawErr);
    assert.strictEqual(rustErr.code, 'ENOENT');
    assert.strictEqual(rustErr.code, rawErr.code);
    assert.strictEqual(rustErr.message, rawErr.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
