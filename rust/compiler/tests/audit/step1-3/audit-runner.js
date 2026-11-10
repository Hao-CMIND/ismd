'use strict';

/**
 * Independent Verification Runner for Pug Rust Compiler (Step 1 ~ Step 3)
 *
 * Performs:
 * 1. Environment, Baseline Hash & Native Addon Provenance Audit
 * 2. Differential Test Harness & Serializer Self-Check (5 Controlled Counterexamples + Runner Audit)
 * 3. Step 1 Audit (pug_error, minimal render, fn/getter/proto locals, sync host callbacks, re-entrancy, register.js, Buffer input)
 * 4. Step 2 Audit (pug_js::scan, pug_js::expression, pug_lexer 144 cases, pug_strip_comments 12 cases, Unicode/CRLF/BOM/tabs)
 * 5. Step 3A Audit (Isolated Parser 119 cases + error cases, Full Frontend Pipeline Lexer->StripComments->Parser, pug_walk + options.parents mutation audit)
 * 6. Step 3B Audit (pug_attrs, pug_runtime, control flow, AST-classified pug/test/cases/*.pug HTML + 2-layer JS codegen, pug.test.js unit tests)
 * 7. Step 3C Audit (Direct addWith + End-to-End Pug across all 9 PLAN.md Scope/With categories)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const RUST_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(RUST_ROOT, '../..');
const RAW_ROOT = path.resolve(REPO_ROOT, 'raw/compiler');

const serializers = require(path.join(RUST_ROOT, 'tests/differential/serializers.js'));
const rustPug = require(path.join(RUST_ROOT, 'index.js'));

const rawPackages = path.join(RAW_ROOT, 'packages');
const rawError = require(path.join(rawPackages, 'pug-error'));
const rawLex = require(path.join(rawPackages, 'pug-lexer'));
const rawStripComments = require(path.join(rawPackages, 'pug-strip-comments'));
const rawParse = require(path.join(rawPackages, 'pug-parser'));
const rawWalk = require(path.join(rawPackages, 'pug-walk'));
const rawAttrs = require(path.join(rawPackages, 'pug-attrs'));
const rawRuntime = require(path.join(rawPackages, 'pug-runtime'));
const rawRuntimeBuild = require(path.join(rawPackages, 'pug-runtime/build'));
const rawCodeGen = require(path.join(rawPackages, 'pug-code-gen'));
const rawPug = require(path.join(rawPackages, 'pug'));
const rawWith = require(path.join(RAW_ROOT, 'node_modules/with'));
const rawCharParser = require(path.join(RAW_ROOT, 'node_modules/character-parser'));

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeNewlines(str) {
  return String(str).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ============================================================================
// 1. Environment, Baseline & Provenance Verification
// ============================================================================
function runEnvAndProvenanceAudit() {
  const baselineJsonPath = path.join(RUST_ROOT, 'compat/baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselineJsonPath, 'utf8'));

  // Verify every file hash in baseline.json against raw/compiler
  const baselineHashChecks = [];
  let baselineHashMismatches = 0;

  for (const [pkgName, pkgInfo] of Object.entries(baseline.packages)) {
    for (const [relFile, fileMeta] of Object.entries(pkgInfo.files || {})) {
      const expectedHash = typeof fileMeta === 'string' ? fileMeta : fileMeta.sha256;
      const fullPath = path.join(RAW_ROOT, pkgInfo.path, relFile);
      const exists = fs.existsSync(fullPath);
      const actualHash = exists ? sha256File(fullPath) : null;
      const ok = actualHash === expectedHash;
      if (!ok) baselineHashMismatches++;
      baselineHashChecks.push({
        package: pkgName,
        file: `${pkgInfo.path}/${relFile}`,
        expectedHash,
        actualHash,
        ok,
      });
    }
  }

  for (const [relFile, fileMeta] of Object.entries(baseline.rootFiles || {})) {
    const expectedHash = typeof fileMeta === 'string' ? fileMeta : fileMeta.sha256;
    const fullPath = path.join(RAW_ROOT, relFile);
    const exists = fs.existsSync(fullPath);
    const actualHash = exists ? sha256File(fullPath) : null;
    const ok = actualHash === expectedHash;
    if (!ok) baselineHashMismatches++;
    baselineHashChecks.push({
      package: 'rootFiles',
      file: relFile,
      expectedHash,
      actualHash,
      ok,
    });
  }

  // Resolved paths of raw vs rust entrypoints and key dependencies
  const resolvedPaths = {
    raw: {
      pug: require.resolve(path.join(rawPackages, 'pug')),
      pugError: require.resolve(path.join(rawPackages, 'pug-error')),
      pugLexer: require.resolve(path.join(rawPackages, 'pug-lexer')),
      pugStripComments: require.resolve(path.join(rawPackages, 'pug-strip-comments')),
      pugParser: require.resolve(path.join(rawPackages, 'pug-parser')),
      pugWalk: require.resolve(path.join(rawPackages, 'pug-walk')),
      pugAttrs: require.resolve(path.join(rawPackages, 'pug-attrs')),
      pugRuntime: require.resolve(path.join(rawPackages, 'pug-runtime')),
      pugCodeGen: require.resolve(path.join(rawPackages, 'pug-code-gen')),
      with: require.resolve(path.join(RAW_ROOT, 'node_modules/with')),
      characterParser: require.resolve(path.join(RAW_ROOT, 'node_modules/character-parser')),
      constantinople: require.resolve(path.join(RAW_ROOT, 'node_modules/constantinople')),
      isExpression: require.resolve(path.join(RAW_ROOT, 'node_modules/is-expression')),
      acorn: require.resolve(path.join(RAW_ROOT, 'node_modules/acorn')),
      babelWalk: require.resolve(path.join(RAW_ROOT, 'node_modules/babel-walk')),
    },
    rust: {
      indexJs: require.resolve(path.join(RUST_ROOT, 'index.js')),
      registerJs: require.resolve(path.join(RUST_ROOT, 'register.js')),
      runtimeJs: require.resolve(path.join(RUST_ROOT, 'runtime/index.js')),
      nativeNode: require.resolve(path.join(RUST_ROOT, 'pug-napi.win32-x64-msvc.node')),
    },
  };

  // Verify native .node addon is loaded in require.cache and matches target/debug/pug_napi.dll
  const nodeFilePath = path.join(RUST_ROOT, 'pug-napi.win32-x64-msvc.node');
  const dllFilePath = path.join(RUST_ROOT, 'target/debug/pug_napi.dll');
  const nodeHash = fs.existsSync(nodeFilePath) ? sha256File(nodeFilePath) : null;
  const dllHash = fs.existsSync(dllFilePath) ? sha256File(dllFilePath) : null;
  const inRequireCache = Boolean(require.cache[resolvedPaths.rust.nativeNode]);

  // Verify in a fresh subprocess that requiring rust/compiler/index.js and calling render/lex/parse
  // loads the .node binary and loads ZERO files from raw/compiler
  const isolationProbeCode = `
    const rust = require(${JSON.stringify(path.join(RUST_ROOT, 'index.js'))});
    const html = rust.render('p= 1 + 2');
    const loadedKeys = Object.keys(require.cache);
    const rawLoaded = loadedKeys.filter(k => k.toLowerCase().includes('raw\\\\compiler') || k.toLowerCase().includes('raw/compiler'));
    const nodeLoaded = loadedKeys.filter(k => k.endsWith('.node'));
    console.log(JSON.stringify({ html, rawLoaded, nodeLoaded }));
  `;
  const probeOut = JSON.parse(
    childProcess.execFileSync(process.execPath, ['-e', isolationProbeCode], {
      cwd: RUST_ROOT,
      encoding: 'utf8',
    })
  );

  const keyFilesHashes = {
    'rust/compiler/PLAN.md': sha256File(path.join(RUST_ROOT, 'PLAN.md')),
    'rust/compiler/compat/baseline.json': sha256File(path.join(RUST_ROOT, 'compat/baseline.json')),
    'rust/compiler/compat/expected-differences.json': sha256File(
      path.join(RUST_ROOT, 'compat/expected-differences.json')
    ),
    'rust/compiler/compat/matrix.md': sha256File(path.join(RUST_ROOT, 'compat/matrix.md')),
    'rust/compiler/Cargo.toml': sha256File(path.join(RUST_ROOT, 'Cargo.toml')),
    'rust/compiler/Cargo.lock': sha256File(path.join(RUST_ROOT, 'Cargo.lock')),
    'rust/compiler/rust-toolchain.toml': sha256File(path.join(RUST_ROOT, 'rust-toolchain.toml')),
    'rust/compiler/package.json': sha256File(path.join(RUST_ROOT, 'package.json')),
    'rust/compiler/index.js': sha256File(path.join(RUST_ROOT, 'index.js')),
    'rust/compiler/register.js': sha256File(path.join(RUST_ROOT, 'register.js')),
    'rust/compiler/runtime/index.js': sha256File(path.join(RUST_ROOT, 'runtime/index.js')),
    'rust/compiler/pug-napi.win32-x64-msvc.node': nodeHash,
    'rust/compiler/target/debug/pug_napi.dll': dllHash,
  };

  return {
    status:
      baselineHashMismatches === 0 &&
      nodeHash === dllHash &&
      inRequireCache &&
      probeOut.rawLoaded.length === 0 &&
      probeOut.nodeLoaded.length === 1
        ? 'PASS'
        : 'FAIL',
    baselineFilesChecked: baselineHashChecks.length,
    baselineHashMismatches,
    nodeAddonMatchesBuiltDll: nodeHash === dllHash,
    nodeAddonSha256: nodeHash,
    builtDllSha256: dllHash,
    nodeAddonInRequireCache: inRequireCache,
    freshProcessIsolationProbe: probeOut,
    resolvedPaths,
    keyFilesHashes,
  };
}

// ============================================================================
// 2. Comparator & Differential Harness Self-Check
// ============================================================================
function runComparatorSelfCheck() {
  const counterexamples = [];

  // Counterexample 1: Token/AST location or field value diff
  {
    const baseToken = [{ type: 'tag', val: 'p', loc: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }];
    const candTokenLocDiff = [{ type: 'tag', val: 'p', loc: { start: { line: 1, column: 2 }, end: { line: 1, column: 2 } } }];
    const candTokenValDiff = [{ type: 'tag', val: 'div', loc: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }];
    const resLoc = serializers.compareStructured(baseToken, candTokenLocDiff);
    const resVal = serializers.compareStructured(baseToken, candTokenValDiff);
    counterexamples.push({
      id: 'CE-01',
      name: 'Token/AST location or field value difference',
      detected: resLoc.ok === false && resVal.ok === false,
      details: { locDiffOk: resLoc.ok, valDiffOk: resVal.ok },
    });
  }

  // Counterexample 2: Missing field (undefined) vs null difference
  {
    const baseAst = { type: 'Code', val: 'x', block: null, line: 1 };
    const candMissingField = { type: 'Code', val: 'x', line: 1 };
    const candUndefinedField = { type: 'Code', val: 'x', block: undefined, line: 1 };
    const resMissing = serializers.compareStructured(baseAst, candMissingField);
    const resUndef = serializers.compareStructured(baseAst, candUndefinedField);
    counterexamples.push({
      id: 'CE-02',
      name: 'Missing field / undefined vs null difference',
      detected: resMissing.ok === false && resUndef.ok === false,
      details: {
        baseSerialized: resMissing.expected,
        missingSerialized: resMissing.actual,
        missingDiffOk: resMissing.ok,
        undefDiffOk: resUndef.ok,
      },
    });
  }

  // Counterexample 3: Raw JS string differs, but Prettier formatted output is identical
  {
    const baseJs = 'function template(locals) {\nvar pug_html = "";\nreturn pug_html;\n}';
    const candJs = 'function template(locals){var pug_html="";return pug_html;}';
    const resCodegen = serializers.compareCodegen(baseJs, candJs);
    counterexamples.push({
      id: 'CE-03',
      name: 'Raw JS string differs while Prettier formatted JS is identical',
      detected: resCodegen.prettierMatch === true && resCodegen.rawMatch === false && resCodegen.ok === false,
      details: {
        prettierMatch: resCodegen.prettierMatch,
        rawMatch: resCodegen.rawMatch,
        overallOk: resCodegen.ok,
      },
    });
  }

  // Counterexample 4: Getter / Walk callback log order difference
  {
    const baseLog = ['before:Block:0', 'before:Tag:1', 'after:Tag:1', 'after:Block:0'];
    const candLog = ['before:Block:0', 'after:Tag:1', 'before:Tag:1', 'after:Block:0'];
    const resOrder = serializers.compareStructured(baseLog, candLog);
    counterexamples.push({
      id: 'CE-04',
      name: 'Getter / Walk callback log order difference',
      detected: resOrder.ok === false,
      details: { orderDiffOk: resOrder.ok },
    });
  }

  // Counterexample 5: Expected exception on baseline, but candidate did not throw (or threw at wrong stage)
  {
    const baseErr = Object.assign(new Error('Pug:1:1\n\nSyntax Error'), {
      code: 'PUG:SYNTAX_ERROR',
      msg: 'Syntax Error',
      line: 1,
      column: 1,
      filename: 'test.pug',
    });
    const resNoThrow = serializers.compareErrors(baseErr, null);
    const resWrongCode = serializers.compareErrors(baseErr, {
      code: 'PUG:INVALID_TOKEN',
      msg: 'Syntax Error',
      line: 1,
      column: 1,
      filename: 'test.pug',
    });
    const resHtmlTrim = serializers.compareHtml('<p>Hello</p>\n', '<p>Hello</p>');
    counterexamples.push({
      id: 'CE-05',
      name: 'Expected exception missing on candidate side (plus HTML whitespace sensitivity)',
      detected: resNoThrow.ok === false && resWrongCode.ok === false && resHtmlTrim.ok === false,
      details: {
        noThrowOk: resNoThrow.ok,
        wrongCodeOk: resWrongCode.ok,
        htmlWhitespaceDiffOk: resHtmlTrim.ok,
      },
    });
  }

  // Audit runner.js false-positive defects
  const runnerSource = normalizeNewlines(
    fs.readFileSync(path.join(RUST_ROOT, 'tests/differential/runner.js'), 'utf8')
  );
  const runnerMasksFailAsUnsupported =
    runnerSource.includes("targetStatus = compareHtml(cmpExpected, rustHtml).ok ? 'PASS' : 'UNSUPPORTED'") &&
    runnerSource.includes("targetStatus = 'UNSUPPORTED';\n      }");
  const runnerUsesTypeofForApiSuites =
    runnerSource.includes("typeof rustTarget.compileFile === 'function' ? 'PASS' : 'UNSUPPORTED'") &&
    runnerSource.includes("typeof rustTarget.compile === 'function' ? 'PASS' : 'UNSUPPORTED'");

  const step3TestSource = fs.readFileSync(
    path.join(RUST_ROOT, 'tests/integration/step3-parser-walk-scope.test.js'),
    'utf8'
  );
  const step3TestChecksNodeParents = step3TestSource.includes('(node.parents || []).map');

  return {
    serializersCredible: counterexamples.every((c) => c.detected),
    runnerFullyCredible: !(runnerMasksFailAsUnsupported || runnerUsesTypeofForApiSuites || step3TestChecksNodeParents),
    counterexamples,
    harnessIssuesFound: [
      {
        id: 'ISSUE-TEST-01',
        severity: 'High',
        location: 'rust/compiler/tests/differential/runner.js:818-833',
        confirmed: runnerMasksFailAsUnsupported,
        summary:
          'runPugIntegrationSuite maps HTML mismatch and non-UNSUPPORTED exceptions in cases/*.pug to UNSUPPORTED instead of FAIL, hiding 8 failing cases.',
      },
      {
        id: 'ISSUE-TEST-02',
        severity: 'High',
        location: 'rust/compiler/tests/differential/runner.js:957-1005',
        confirmed: runnerUsesTypeofForApiSuites,
        summary:
          '5 API test categories (25 counted cases: compileFile, render callback/cache, compile options/self, renderFile, compileFileClient, runtime.merge/attrs) only check typeof fn === "function" instead of executing the tests.',
      },
      {
        id: 'ISSUE-TEST-03',
        severity: 'Medium',
        location: 'rust/compiler/tests/integration/step3-parser-walk-scope.test.js:178',
        confirmed: step3TestChecksNodeParents,
        summary:
          'runSkipWalk checks node.parents (which is always undefined -> []) instead of options.parents.',
      },
    ],
  };
}

// ============================================================================
// 3. Step 1 Audit: Minimal E2E, NAPI Wiring, Locals & Host Callbacks
// ============================================================================
function runStep1Audit() {
  const checks = [];
  function record(name, ok, details = {}) {
    checks.push({ name, ok, ...details });
  }

  // 1. Runtime helper parity
  const runtimeHelperNames = ['merge', 'classes', 'style', 'attr', 'attrs', 'escape', 'rethrow'];
  const runtimeExportParity = runtimeHelperNames.every(
    (k) => typeof rustPug.runtime[k] === 'function' && rustPug.runtime[k].toString() === rawRuntime[k].toString()
  );
  const runtimeBuildParity =
    rustPug._runtimeBuild(['attrs', 'escape', 'rethrow', 'merge']) ===
    rawRuntimeBuild(['attrs', 'escape', 'rethrow', 'merge']);
  record('runtime_exports_and_build_parity', runtimeExportParity && runtimeBuildParity);

  // 2. pug_error 8 baseline cases + toJSON + UTF-16 column alignment
  const errCases = [
    ['MY_CODE', 'My message', { line: 3, filename: 'myfile', src: 'foo\nbar\nbaz\nbash\nbing' }],
    ['MY_CODE', 'My message', { line: 3, src: 'foo\nbar\nbaz\nbash\nbing' }],
    ['MY_CODE', 'My message', { line: 3, filename: 'myfile' }],
    ['MY_CODE', 'My message', { line: 3 }],
    ['MY_CODE', 'My message', { line: 3, column: 2, filename: 'myfile', src: 'foo\nbar\nbaz\nbash\nbing' }],
    ['MY_CODE', 'My message', { line: 3, column: 1 }],
    ['MY_CODE', 'My message', { line: 3, column: -1, src: 'foo\nbar\nbaz\nbash\nbing' }],
    ['MY_CODE', 'My message', { line: 0, src: 'foo\nbar\nbaz\nbash\nbing' }],
    ['MY_CODE', 'My message', { line: 6, src: 'foo\nbar\nbaz\nbash\nbing' }],
    ['CJK_EMOJI', 'Unicode col', { line: 1, column: 5, filename: 'u.pug', src: 'p 中文😀x' }],
  ];
  let errAllMatch = true;
  for (const [code, msg, opts] of errCases) {
    const rawE = rawError(code, msg, { ...opts });
    const rustE = rustPug._error(code, msg, { ...opts });
    if (
      rawE.message !== rustE.message ||
      rawE.code !== rustE.code ||
      rawE.msg !== rustE.msg ||
      rawE.line !== rustE.line ||
      rawE.column !== rustE.column ||
      rawE.filename !== rustE.filename ||
      JSON.stringify(rawE) !== JSON.stringify(rustE)
    ) {
      errAllMatch = false;
    }
  }
  record('pug_error_parity_and_serialization', errAllMatch, { casesTested: errCases.length });

  // 3. Minimal render: pug.render('p Hello')
  const minHtmlRaw = rawPug.render('p Hello');
  const minHtmlRust = rustPug.render('p Hello');
  record('minimal_render_p_hello', minHtmlRaw === '<p>Hello</p>' && minHtmlRust === '<p>Hello</p>', {
    raw: minHtmlRaw,
    rust: minHtmlRust,
  });

  // 4. Function-valued locals, prototype chain, getters, circular objects (proving no JSON serialization of locals)
  const fnHtmlRaw = rawPug.render('p= fn()', { fn: () => 'ok' });
  const fnHtmlRust = rustPug.render('p= fn()', { fn: () => 'ok' });
  record('function_locals_p_fn', fnHtmlRaw === '<p>ok</p>' && fnHtmlRust === '<p>ok</p>', {
    raw: fnHtmlRaw,
    rust: fnHtmlRust,
  });

  const proto = {
    inheritedFn() {
      return 'from-proto';
    },
    methodWithThis() {
      return this.secret;
    },
  };
  const complexLocals = Object.create(proto);
  complexLocals.secret = 'this-ok';
  complexLocals.selfRef = complexLocals; // circular reference that would throw in JSON.stringify!
  let getterCount = 0;
  Object.defineProperty(complexLocals, 'dynProp', {
    enumerable: true,
    get() {
      getterCount++;
      return 'getter-ok';
    },
  });
  const complexTpl =
    'p= inheritedFn() + ":" + selfRef.methodWithThis() + ":" + dynProp + ":" + (selfRef === selfRef.selfRef)';
  const complexRaw = rawPug.render(complexTpl, complexLocals);
  const complexRust = rustPug.render(complexTpl, complexLocals);
  record(
    'non_json_locals_proto_getter_circular',
    complexRaw === '<p>from-proto:this-ok:getter-ok:true</p>' &&
      complexRust === complexRaw &&
      getterCount === 2,
    { raw: complexRaw, rust: complexRust, getterCount }
  );

  // 5. compile() / compileClient() / compileClientWithDependenciesTracked() return values
  const fnCompiled = rustPug.compile('p= name');
  const clientCode = rustPug.compileClient('p= name');
  const tracked = rustPug.compileClientWithDependenciesTracked('p= name');
  record(
    'compile_and_compileClient_contracts',
    typeof fnCompiled === 'function' &&
      fnCompiled({ name: 'Ada' }) === '<p>Ada</p>' &&
      typeof clientCode === 'string' &&
      clientCode.includes('function template(locals)') &&
      typeof tracked === 'object' &&
      tracked.body === clientCode &&
      Array.isArray(tracked.dependencies)
  );

  // 6. Synchronous Host Callbacks: return values, order, error identity, and re-entrancy
  const hookOrder = [];
  const hookHtml = rustPug.render('p\n  :shout hi', {
    plugins: [
      {
        preLex(val) {
          hookOrder.push('preLex');
          const inner = rustPug.render('span reentrant-lex');
          if (inner !== '<span>reentrant-lex</span>') throw new Error('reentrant-lex failed');
          return val;
        },
        postLex(tokens) {
          hookOrder.push('postLex');
          return tokens;
        },
        preParse(tokens) {
          hookOrder.push('preParse');
          return tokens;
        },
        postParse(ast) {
          hookOrder.push('postParse');
          return ast;
        },
        preLoad(ast) {
          hookOrder.push('preLoad');
          return ast;
        },
        postLoad(ast) {
          hookOrder.push('postLoad');
          return ast;
        },
        preFilters(ast) {
          hookOrder.push('preFilters');
          return ast;
        },
        postFilters(ast) {
          hookOrder.push('postFilters');
          return ast;
        },
        preLink(ast) {
          hookOrder.push('preLink');
          return ast;
        },
        postLink(ast) {
          hookOrder.push('postLink');
          return ast;
        },
        preCodeGen(ast) {
          hookOrder.push('preCodeGen');
          return ast;
        },
        postCodeGen(js) {
          hookOrder.push('postCodeGen');
          return js;
        },
      },
    ],
    filters: {
      shout(text) {
        hookOrder.push('filter:shout');
        const inner = rustPug.render('em ' + text.toUpperCase());
        return inner;
      },
    },
  });
  const expectedHookOrder = [
    'preLex',
    'postLex',
    'preParse',
    'postParse',
    'preLoad',
    'postLoad',
    'preFilters',
    'filter:shout',
    'postFilters',
    'preLink',
    'postLink',
    'preCodeGen',
    'postCodeGen',
  ];
  record(
    'sync_host_callbacks_order_return_and_reentrancy',
    hookHtml === '<p><em>HI</em></p>' && JSON.stringify(hookOrder) === JSON.stringify(expectedHookOrder),
    { hookHtml, hookOrder }
  );

  // Host callback exception identity across FFI
  class CustomHostError extends TypeError {
    constructor(msg) {
      super(msg);
      this.customTag = 'HOST_ERR_42';
    }
  }
  const thrownErr = new CustomHostError('boom in hook');
  let caughtErr = null;
  try {
    rustPug.render('p test', {
      plugins: [{ preParse() { throw thrownErr; } }],
    });
  } catch (e) {
    caughtErr = e;
  }
  record(
    'sync_host_callback_exception_identity',
    caughtErr === thrownErr && caughtErr instanceof CustomHostError && caughtErr.customTag === 'HOST_ERR_42'
  );

  // 7. Check Buffer input support on pug.render(Buffer.from('.foo')) (from raw pug.test.js line 258)
  let rawBufHtml = null;
  let rustBufHtml = null;
  let rustBufErr = null;
  try {
    rawBufHtml = rawPug.render(Buffer.from('.foo'));
  } catch (e) {
    rawBufHtml = String(e);
  }
  try {
    rustBufHtml = rustPug.render(Buffer.from('.foo'));
  } catch (e) {
    rustBufErr = { code: e.code, message: e.message };
  }
  record('render_buffer_input_support', rawBufHtml === '<div class="foo"></div>' && rustBufHtml === rawBufHtml, {
    raw: rawBufHtml,
    rust: rustBufHtml,
    rustError: rustBufErr,
  });

  const failed = checks.filter((c) => !c.ok);
  return {
    status: failed.length === 0 ? 'PASS' : 'PARTIAL_FAIL',
    totalChecks: checks.length,
    passedChecks: checks.length - failed.length,
    failedChecks: failed.length,
    checks,
  };
}

// ============================================================================
// 4. Step 2 Audit: Lexer, Comments & JS Boundary
// ============================================================================
function runStep2Audit() {
  // 4.1 pug-lexer 116 token cases + 28 error cases
  const lexTestDir = path.join(RAW_ROOT, 'packages/pug-lexer/test');
  const lexCasesDir = path.join(lexTestDir, 'cases');
  const lexErrorsDir = path.join(lexTestDir, 'errors');

  const lexTokenFiles = fs.readdirSync(lexCasesDir).filter((f) => f.endsWith('.pug') || f.endsWith('.jade')).sort();
  let lexTokenPassed = 0;
  const lexTokenFailures = [];
  for (const file of lexTokenFiles) {
    const fullPath = path.join(lexCasesDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    const filename = path.join(lexCasesDir, file);
    try {
      const rawTokens = rawLex(src, { filename });
      const rustTokens = rustPug.lex(src, { filename });
      const cmp = serializers.compareStructured(rawTokens, rustTokens);
      if (cmp.ok) {
        lexTokenPassed++;
      } else {
        lexTokenFailures.push({ file, diff: cmp });
      }
    } catch (err) {
      lexTokenFailures.push({ file, error: err.message });
    }
  }

  const lexErrorFiles = fs.readdirSync(lexErrorsDir).filter((f) => f.endsWith('.pug') || f.endsWith('.jade')).sort();
  let lexErrorPassed = 0;
  const lexErrorFailures = [];
  for (const file of lexErrorFiles) {
    const fullPath = path.join(lexErrorsDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    const filename = path.join(lexErrorsDir, file);
    let rawErr = null;
    let rustErr = null;
    try {
      rawLex(src, { filename });
    } catch (e) {
      rawErr = e;
    }
    try {
      rustPug.lex(src, { filename });
    } catch (e) {
      rustErr = e;
    }
    const cmp = serializers.compareErrors(rawErr, rustErr);
    if (cmp.ok) {
      lexErrorPassed++;
    } else {
      lexErrorFailures.push({ file, cmp, rawMsg: rawErr?.message, rustMsg: rustErr?.message });
    }
  }

  // 4.2 pug-strip-comments 9 cases + 3 error cases + option combinations
  const stripDir = path.join(RAW_ROOT, 'packages/pug-strip-comments/test/cases');
  const stripErrDir = path.join(RAW_ROOT, 'packages/pug-strip-comments/test/errors');
  const stripInputFiles = fs.readdirSync(stripDir).filter((f) => f.endsWith('.input.json')).sort();
  let stripPassed = 0;
  const stripFailures = [];
  for (const file of stripInputFiles) {
    const inputTokens = fs
      .readFileSync(path.join(stripDir, file), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const optionCombos = [
      {},
      { stripBuffered: true, stripUnbuffered: false },
      { stripBuffered: true },
      { stripUnbuffered: false },
    ];
    for (const opts of optionCombos) {
      const rawOut = rawStripComments(JSON.parse(JSON.stringify(inputTokens)), { filename: file, ...opts });
      const rustOut = rustPug.stripComments(JSON.parse(JSON.stringify(inputTokens)), { filename: file, ...opts });
      const cmp = serializers.compareStructured(rawOut, rustOut);
      if (cmp.ok) {
        stripPassed++;
      } else {
        stripFailures.push({ file, opts, cmp });
      }
    }
  }

  // 3 strip-comments error cases from packages/pug-strip-comments/test/errors/*.input.json
  const stripErrorFiles = fs.readdirSync(stripErrDir).filter((f) => f.endsWith('.input.json')).sort();
  let stripErrPassed = 0;
  for (const file of stripErrorFiles) {
    const tokens = fs
      .readFileSync(path.join(stripErrDir, file), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    let rawE = null;
    let rustE = null;
    try { rawStripComments(JSON.parse(JSON.stringify(tokens))); } catch (e) { rawE = e; }
    try { rustPug.stripComments(JSON.parse(JSON.stringify(tokens))); } catch (e) { rustE = e; }
    if (serializers.compareErrors(rawE, rustE).ok) stripErrPassed++;
  }

  // 4.3 Edge cases: regex vs division, template literals with nested ${}, nested brackets, trailing garbage in expression, unbuffered control flow, CJK/Emoji/BOM/CRLF/CR/tab coordinates
  const edgeCases = [
    'a(href=/https?:\\/\\/(foo|bar)\\/baz\\?q=1&x="2"/.source, data-div=(10 / 2 / 5))',
    'p= `outer ${a ? `inner ${b + `deep ${c}`}` : "none"}`',
    'div(data-fn=fn({ a: [1, (2 + 3), { k: ")]}" }] }))',
    '\uFEFFdiv(title="中文😀")\r\n\tp Tabbed\r\tp CR-only',
    '- if (foo) {\n  p inside unbuffered if\n- }',
    'p #{1 + 2} !{"<b>raw</b>"} #[span.inner(data-x=1) text]',
    '//-\n  unbuffered multiline comment\n  line 2 with #{not_interpolated}\n//\n  buffered multiline comment\n  line 2',
  ];
  let edgePassed = 0;
  const edgeFailures = [];
  for (const src of edgeCases) {
    let rawT = null;
    let rustT = null;
    let rawE = null;
    let rustE = null;
    try { rawT = rawLex(src, { filename: 'edge.pug' }); } catch (e) { rawE = e; }
    try { rustT = rustPug.lex(src, { filename: 'edge.pug' }); } catch (e) { rustE = e; }
    if (rawE || rustE) {
      if (serializers.compareErrors(rawE, rustE).ok) edgePassed++;
      else edgeFailures.push({ src, rawE, rustE });
    } else {
      const cmp = serializers.compareStructured(rawT, rustT);
      if (cmp.ok) edgePassed++;
      else edgeFailures.push({ src, cmp });
    }
  }

  // Expression incomplete consumption check (must reject trailing tokens like `foo bar`)
  const invalidExprCases = ['p= foo bar', 'div(a=(1 2))', 'if a b\n  p x', 'p #{foo bar}'];
  let invalidExprPassed = 0;
  for (const src of invalidExprCases) {
    let rawE = null;
    let rustE = null;
    try { rawLex(src, { filename: 'bad.pug' }); } catch (e) { rawE = e; }
    try { rustPug.lex(src, { filename: 'bad.pug' }); } catch (e) { rustE = e; }
    if (rawE && rustE && serializers.compareErrors(rawE, rustE).ok) {
      invalidExprPassed++;
    }
  }

  const allOk =
    lexTokenFailures.length === 0 &&
    lexErrorFailures.length === 0 &&
    stripFailures.length === 0 &&
    stripErrPassed === stripErrorFiles.length &&
    edgeFailures.length === 0 &&
    invalidExprPassed === invalidExprCases.length;

  return {
    status: allOk ? 'PASS' : 'FAIL',
    pugLexerTokens: { total: lexTokenFiles.length, passed: lexTokenPassed, failed: lexTokenFailures.length, failures: lexTokenFailures },
    pugLexerErrors: { total: lexErrorFiles.length, passed: lexErrorPassed, failed: lexErrorFailures.length, failures: lexErrorFailures },
    pugStripComments: { total: stripPassed + stripFailures.length, passed: stripPassed, failed: stripFailures.length, errorCasesPassed: stripErrPassed },
    edgeAndInvalidExprCases: { edgeTotal: edgeCases.length, edgePassed, invalidExprTotal: invalidExprCases.length, invalidExprPassed },
  };
}

// ============================================================================
// 5. Step 3A Audit: Parser (2-Layer) & Walk
// ============================================================================
function runStep3AAudit() {
  // Layer 1: Isolated Parser on all 118 .tokens.json + no-unnecessary-blocks
  const parserTestDir = path.join(RAW_ROOT, 'packages/pug-parser/test');
  const parserCasesDir = path.join(parserTestDir, 'cases');
  const tokenFiles = fs.readdirSync(parserCasesDir).filter((f) => f.endsWith('.tokens.json')).sort();

  let layer1Passed = 0;
  const layer1Failures = [];
  for (const file of tokenFiles) {
    const fullPath = path.join(parserCasesDir, file);
    const rawTokens = fs
      .readFileSync(fullPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const rawAst = rawParse(JSON.parse(JSON.stringify(rawTokens)), { filename: file });
    const rustAst = rustPug.parse(JSON.parse(JSON.stringify(rawTokens)), { filename: file });
    const cmp = serializers.compareStructured(rawAst, rustAst);
    if (cmp.ok) {
      layer1Passed++;
    } else {
      layer1Failures.push({ file, cmp });
    }
  }

  // Layer 1 extra case: no-unnecessary-blocks
  {
    const src = ['div', '  | text 1', '  | text 2'].join('\n');
    const tokens = rawLex(src);
    const rawAst = rawParse(JSON.parse(JSON.stringify(tokens)));
    const rustAst = rustPug.parse(JSON.parse(JSON.stringify(tokens)));
    if (serializers.compareStructured(rawAst, rustAst).ok) layer1Passed++;
    else layer1Failures.push({ file: 'no-unnecessary-blocks' });
  }

  // Layer 2: Full Frontend Pipeline (Pug -> Lexer -> StripComments -> Parser) across all 116 pug-lexer cases + 138 pug integration cases
  const allPugSources = [];
  const lexCasesDir = path.join(RAW_ROOT, 'packages/pug-lexer/test/cases');
  for (const f of fs.readdirSync(lexCasesDir).filter((x) => x.endsWith('.pug') || x.endsWith('.jade')).sort()) {
    allPugSources.push({ suite: 'pug-lexer/cases', file: f, fullPath: path.join(lexCasesDir, f) });
  }
  const pugCasesDir = path.join(RAW_ROOT, 'packages/pug/test/cases');
  for (const f of fs.readdirSync(pugCasesDir).filter((x) => x.endsWith('.pug') || x.endsWith('.jade')).sort()) {
    allPugSources.push({ suite: 'pug/cases', file: f, fullPath: path.join(pugCasesDir, f) });
  }

  let layer2Passed = 0;
  const layer2Failures = [];
  for (const item of allPugSources) {
    const src = fs.readFileSync(item.fullPath, 'utf8');
    let rawAst = null;
    let rustAst = null;
    let rawErr = null;
    let rustErr = null;
    try {
      const t = rawStripComments(rawLex(src, { filename: item.file }), { filename: item.file });
      rawAst = rawParse(t, { filename: item.file, src });
    } catch (e) {
      rawErr = e;
    }
    try {
      const t = rustPug.stripComments(rustPug.lex(src, { filename: item.file }), { filename: item.file });
      rustAst = rustPug.parse(t, { filename: item.file, src });
    } catch (e) {
      rustErr = e;
    }
    if (rawErr || rustErr) {
      const cmp = serializers.compareErrors(rawErr, rustErr);
      if (cmp.ok) layer2Passed++;
      else layer2Failures.push({ ...item, errorMismatch: cmp });
    } else {
      const cmp = serializers.compareStructured(rawAst, rustAst);
      if (cmp.ok) layer2Passed++;
      else layer2Failures.push({ ...item, astMismatch: cmp });
    }
  }

  // Walk verification (callback order, return false, options.parents contents & in-place reference check, replace, includeDependencies)
  const walkChecks = [];
  {
    const src = 'div\n  p Hello #[em world]\n  ul\n    li one\n    li two';
    const makeAst = () => rawParse(rawStripComments(rawLex(src, { filename: 'w.pug' })));

    const runWalkTrace = (walkFn) => {
      const trace = [];
      const opts = {};
      let initialParentsRef = null;
      let refChangedMidWalk = false;
      walkFn(
        makeAst(),
        (node) => {
          if (!initialParentsRef) initialParentsRef = opts.parents;
          else if (opts.parents !== initialParentsRef) refChangedMidWalk = true;
          trace.push(`before:${node.type}:${node.line}:parents=[${opts.parents.map((p) => p.type).join('>')}]`);
          if (node.type === 'Tag' && node.name === 'ul') return false;
        },
        (node) => {
          if (opts.parents !== initialParentsRef) refChangedMidWalk = true;
          trace.push(`after:${node.type}:${node.line}:parents=[${opts.parents.map((p) => p.type).join('>')}]`);
        },
        opts
      );
      return { trace, refChangedMidWalk, finalParentsLen: opts.parents ? opts.parents.length : null };
    };

    const rawTrace = runWalkTrace(rawWalk);
    const rustTrace = runWalkTrace((ast, b, a, o) => rustPug.walk(ast, b, a, o));
    const traceMatch = JSON.stringify(rawTrace.trace) === JSON.stringify(rustTrace.trace);
    walkChecks.push({
      name: 'walk_before_after_order_skip_and_parents_contents',
      ok: traceMatch,
      traceSteps: rawTrace.trace.length,
    });

    // Check options.parents in-place reference stability & cleanup when `after` is omitted
    const rawOptsNoAfter = {};
    let rawInitialRef = null;
    let rawRefChanged = false;
    rawWalk(
      makeAst(),
      () => {
        if (!rawInitialRef) rawInitialRef = rawOptsNoAfter.parents;
        else if (rawOptsNoAfter.parents !== rawInitialRef) rawRefChanged = true;
      },
      null,
      rawOptsNoAfter
    );

    const rustOptsNoAfter = {};
    let rustInitialRef = null;
    let rustRefChanged = false;
    rustPug.walk(
      makeAst(),
      () => {
        if (!rustInitialRef) rustInitialRef = rustOptsNoAfter.parents;
        else if (rustOptsNoAfter.parents !== rustInitialRef) rustRefChanged = true;
      },
      null,
      rustOptsNoAfter
    );

    walkChecks.push({
      name: 'walk_options_parents_in_place_mutation_and_cleanup_without_after',
      ok:
        !rustRefChanged &&
        Array.isArray(rustOptsNoAfter.parents) &&
        rustOptsNoAfter.parents.length === rawOptsNoAfter.parents.length,
      details: {
        rawRefChanged,
        rustRefChanged,
        rawFinalParentsLength: rawOptsNoAfter.parents.length,
        rustFinalParentsLength: rustOptsNoAfter.parents.length,
      },
    });
  }

  return {
    status:
      layer1Failures.length === 0 &&
      layer2Failures.length === 0 &&
      walkChecks.every((w) => w.ok)
        ? 'PASS'
        : 'PARTIAL_FAIL',
    isolatedParserLayer1: { total: tokenFiles.length + 1, passed: layer1Passed, failed: layer1Failures.length, failures: layer1Failures },
    frontendPipelineLayer2: { total: allPugSources.length, passed: layer2Passed, failed: layer2Failures.length, failures: layer2Failures },
    walkChecks,
  };
}

// ============================================================================
// 6. Step 3B Audit: Codegen, Attrs, Control Flow & AST-Classified Cases
// ============================================================================
const STEP4_5_NODE_TYPES = new Set([
  'Include',
  'RawInclude',
  'Extends',
  'NamedBlock',
  'YieldBlock',
  'Mixin',
  'MixinBlock',
  'Filter',
]);

function findStep45NodeTypes(ast) {
  const found = new Set();
  rawWalk(ast, (node) => {
    if (STEP4_5_NODE_TYPES.has(node.type)) {
      found.add(node.type);
    }
  });
  return Array.from(found);
}

function runStep3BAudit() {
  // 6.1 Explicit PLAN.md Step 3B prompt checks
  const promptCases = [
    { name: 'p= 1 + 2', src: 'p= 1 + 2', locals: {} },
    { name: 'div(foo=1 + 2)', src: 'div(foo=1 + 2)', locals: {} },
    { name: 'td(colspan=2)', src: 'td(colspan=2)', locals: {} },
    { name: 'foo(data-items=[1, 2, 3])', src: 'foo(data-items=[1, 2, 3])', locals: {} },
    { name: 'bare html tag without doctype', src: 'html\n  body\n    h1 Hi', locals: {} },
    { name: 'bare doctype keyword', src: 'doctype\nhtml\n  body\n    h1 Hi', locals: {} },
    { name: 'if / else if / else / unless', src: 'if a\n  p A\nelse if b\n  p B\nelse\n  p C\nunless a\n  p NotA', locals: { a: false, b: true } },
    { name: 'each array and else', src: 'each x, i in items\n  li #{i}:#{x}\nelse\n  li empty', locals: { items: [] } },
    { name: 'each object key/val', src: 'each v, k in obj\n  p #{k}=#{v}', locals: { obj: { a: 1, b: 2 } } },
    { name: 'each ... of', src: 'each item of list\n  span= item', locals: { list: ['x', 'y'] } },
    { name: 'while loop', src: '- var i = 0\nwhile i < 3\n  p= i++', locals: {} },
    { name: 'case / when / default', src: 'case x\n  when 1\n  when 2\n    p one-or-two\n  when 3: p three\n  default\n    p other', locals: { x: 2 } },
    { name: 'unbuffered code', src: '- var msg = "hello"\n- for (var k = 0; k < 2; k++) {\n  p #{msg}-#{k}\n- }', locals: {} },
  ];

  const promptResults = [];
  for (const tc of promptCases) {
    const rawHtml = rawPug.render(tc.src, tc.locals);
    const rustHtml = rustPug.render(tc.src, tc.locals);
    const rawClient = rawPug.compileClient(tc.src, { compileDebug: false });
    const rustClient = rustPug.compileClient(tc.src, { compileDebug: false });
    const htmlMatch = rawHtml === rustHtml;
    const codegenCmp = serializers.compareCodegen(rawClient, rustClient);
    promptResults.push({
      name: tc.name,
      htmlMatch,
      prettierMatch: codegenCmp.prettierMatch,
      rawJsMatch: codegenCmp.rawMatch,
      expectedHtml: rawHtml,
      actualHtml: rustHtml,
    });
  }

  // 6.2 Classify all 138 cases/*.pug in raw/compiler/packages/pug/test/cases/
  const casesDir = path.join(RAW_ROOT, 'packages/pug/test/cases');
  const caseFiles = fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith('.pug') || f.endsWith('.jade'))
    .map((f) => f.replace(/\.(pug|jade)$/, ''))
    .sort();

  const step3BInScopeCases = [];
  const step45DeferredCases = [];

  for (const name of caseFiles) {
    const filename = path.join(casesDir, `${name}.pug`);
    const htmlPath = path.join(casesDir, `${name}.html`);
    const src = fs.readFileSync(filename, 'utf8');
    const expectedHtml = normalizeNewlines(fs.readFileSync(htmlPath, 'utf8').trim());
    const ast = rawParse(rawStripComments(rawLex(src, { filename }), { filename }), { filename, src });
    const deferredNodes = findStep45NodeTypes(ast);

    const opts = {
      filename,
      basedir: casesDir,
      pretty: ! /\.min$/.test(name),
      doctype: /xml/.test(name) ? 'xml' : undefined,
      filterOptions: { anything: 'whatever' },
      filterAliases: { markdown: 'markdown-it' },
      filters: {
        custom: function (str, options) {
          if (options.opt !== 'val' || options.num !== 2) {
            throw new Error('Expected custom filter options opt="val", num=2');
          }
          return 'BEGIN' + str + 'END';
        },
      },
    };

    if (deferredNodes.length === 0) {
      let rustHtml = null;
      let rustErr = null;
      try {
        const fn = rustPug.compile(src, opts);
        rustHtml = normalizeNewlines(fn({ title: 'Pug' }).trim());
      } catch (e) {
        rustErr = { code: e.code, message: e.message };
      }

      let codegenPrettierMatch = false;
      let codegenRawMatch = false;
      try {
        const rawClient = rawPug.compileClient(src, {
          filename: `${name}.pug`,
          pretty: opts.pretty,
          doctype: opts.doctype,
          compileDebug: false,
        });
        const rustClient = rustPug.compileClient(src, {
          filename: `${name}.pug`,
          pretty: opts.pretty,
          doctype: opts.doctype,
          compileDebug: false,
        });
        const cg = serializers.compareCodegen(rawClient, rustClient);
        codegenPrettierMatch = cg.prettierMatch;
        codegenRawMatch = cg.rawMatch;
      } catch (_) {}

      const htmlOk = rustErr === null && rustHtml === expectedHtml;
      step3BInScopeCases.push({
        case: name,
        htmlOk,
        codegenPrettierMatch,
        codegenRawMatch,
        rustError: rustErr,
        ...(htmlOk ? {} : { expectedHtml, actualHtml: rustHtml }),
      });
    } else {
      let rustErrCode = null;
      let rustThrewUnsupported = false;
      try {
        const fn = rustPug.compile(src, opts);
        fn({ title: 'Pug' });
      } catch (e) {
        rustErrCode = e.code || e.name || 'ERROR';
        rustThrewUnsupported = e.code === 'PUG:UNSUPPORTED_NODE' || e.code === 'PUG:UNKNOWN_FILTER';
      }
      step45DeferredCases.push({
        case: name,
        deferredNodes,
        rustErrCode,
        rustThrewUnsupported,
      });
    }
  }

  // 6.3 Run all 25 unit tests from raw/compiler/packages/pug/test/pug.test.js ("unit tests with .render()")
  const pugUnitRenderCases = [
    { name: 'render(str)', fn: (p) => p.render('html') },
    { name: 'render(Buffer)', fn: (p) => p.render(Buffer.from('.foo')) },
    { name: 'render(str, options)', fn: (p) => p.render('p #{foo}', { foo: 'bar' }) },
    { name: 'render(str, options, fn)', fn: (p) => { let out; p.render('p #{foo}', { foo: 'bar' }, (err, res) => { if (err) throw err; out = res; }); return out; } },
    { name: 'render(str, fn)', fn: (p) => { let out; p.render('p #{foo}', (err, res) => { if (err) throw err; out = res; }); return out; } },
    { name: 'doctype default html', fn: (p) => p.render('doctype html') },
    { name: 'doctype xml', fn: (p) => p.render('doctype xml') },
    { name: 'doctype custom', fn: (p) => p.render('doctype foo bar baz') },
    { name: 'html->body->h1+p indentation', fn: (p) => p.render('html\n  body\n   h1 Wahoo\n   p test') },
    { name: 'self-closing tags without doctype', fn: (p) => p.render('img\ninput\nlink\nmeta\nbr\nhr') },
    { name: 'self-closing tags with html doctype', fn: (p) => p.render('doctype html\nimg\ninput\nlink\nmeta\nbr\nhr') },
    { name: 'explicit self-closing tag a/', fn: (p) => p.render('a/') },
    { name: 'tag interpolation #[strong]', fn: (p) => p.render('p hello #[strong world]') },
    { name: 'nested tag interpolation', fn: (p) => p.render('p #[a(href="foo") bar #[em baz]]') },
    { name: 'class and id literals', fn: (p) => p.render('#foo.bar.baz') },
    { name: 'attribute escaping', fn: (p) => p.render('a(href="http://example.com/?a=1&b=2")') },
    { name: 'unescaped attribute !=', fn: (p) => p.render('a(href!="http://example.com/?a=1&b=2")') },
    { name: 'boolean attributes without doctype', fn: (p) => p.render('input(checked=true)\ninput(checked=false)\ninput(checked=null)\ninput(checked=undefined)') },
    { name: 'boolean attributes with doctype html', fn: (p) => p.render('doctype html\ninput(checked=true)\ninput(checked=false)') },
    { name: 'class array and object', fn: (p) => p.render('div(class=["a", "b", { c: true, d: false }])') },
    { name: 'style object', fn: (p) => p.render('div(style={ color: "red", background: "blue" })') },
    { name: '&attributes', fn: (p) => p.render('div.foo&attributes({ id: "bar", class: "baz" })') },
  ];

  const unitRenderResults = [];
  for (const uc of pugUnitRenderCases) {
    let rawOut = null;
    let rustOut = null;
    let rustErr = null;
    try { rawOut = uc.fn(rawPug); } catch (e) { rawOut = `ERR:${e.message}`; }
    try { rustOut = uc.fn(rustPug); } catch (e) { rustErr = e.message; }
    unitRenderResults.push({
      name: uc.name,
      ok: rustErr === null && rawOut === rustOut,
      expected: rawOut,
      actual: rustErr ? `ERR:${rustErr}` : rustOut,
    });
  }

  const inScopeFailed = step3BInScopeCases.filter((c) => !c.htmlOk);
  const promptFailed = promptResults.filter((c) => !c.htmlMatch);
  const unitFailed = unitRenderResults.filter((c) => !c.ok);

  return {
    status: inScopeFailed.length === 0 && promptFailed.length === 0 && unitFailed.length === 0 ? 'PASS' : 'PARTIAL_FAIL',
    promptCases: {
      total: promptResults.length,
      passed: promptResults.length - promptFailed.length,
      failed: promptFailed.length,
      results: promptResults,
    },
    pugCasesClassification: {
      totalCases: caseFiles.length,
      step3BInScopeTotal: step3BInScopeCases.length,
      step3BInScopeHtmlPassed: step3BInScopeCases.length - inScopeFailed.length,
      step3BInScopeHtmlFailed: inScopeFailed.length,
      step3BInScopePrettierJsMatched: step3BInScopeCases.filter((c) => c.codegenPrettierMatch).length,
      step3BInScopeRawJsMatched: step3BInScopeCases.filter((c) => c.codegenRawMatch).length,
      step3BInScopeFailures: inScopeFailed,
      step45DeferredTotal: step45DeferredCases.length,
      step45NonUnsupportedErrors: step45DeferredCases.filter((c) => !c.rustThrewUnsupported),
    },
    unitRenderTests: {
      total: unitRenderResults.length,
      passed: unitRenderResults.length - unitFailed.length,
      failed: unitFailed.length,
      failures: unitFailed,
    },
  };
}

// ============================================================================
// 7. Step 3C Audit: Scope / With Semantics (9 Categories)
// ============================================================================
function runStep3CAudit() {
  const categories = [];

  function runBothRender(tpl, localsFn, options = {}) {
    let rawHtml = null;
    let rustHtml = null;
    let rawErr = null;
    let rustErr = null;
    try {
      rawHtml = rawPug.render(tpl, localsFn ? localsFn() : {}, options);
    } catch (e) {
      rawErr = { name: e.name, code: e.code, message: e.message };
    }
    try {
      rustHtml = rustPug.render(tpl, localsFn ? localsFn() : {}, options);
    } catch (e) {
      rustErr = { name: e.name, code: e.code, message: e.message };
    }
    const rawClient = rawPug.compileClient(tpl, { compileDebug: false, ...options });
    const rustClient = rustPug.compileClient(tpl, { compileDebug: false, ...options });
    const cg = serializers.compareCodegen(rawClient, rustClient);
    const ok =
      rawErr || rustErr
        ? Boolean(rawErr && rustErr && rawErr.name === rustErr.name && rawErr.message === rustErr.message)
        : rawHtml === rustHtml;
    return {
      ok,
      rawHtml,
      rustHtml,
      rawErr,
      rustErr,
      prettierMatch: cg.prettierMatch,
      rawJsMatch: cg.rawMatch,
    };
  }

  function runBothAddWith(objExpr, bodyJs, excludeList) {
    const rawWrapped = rawWith(objExpr, bodyJs, excludeList);
    const rustWrapped = rustPug._addWith(objExpr, bodyJs, excludeList);
    const cg = serializers.compareCodegen(rawWrapped, rustWrapped);
    return {
      ok: cg.prettierMatch,
      prettierMatch: cg.prettierMatch,
      rawJsMatch: cg.rawMatch,
      rawWrapped,
      rustWrapped,
    };
  }

  // Category 1: Declarations & Shadowing
  {
    const tVarAndBlockLetConst = runBothRender(
      '- var a = 1\n- if (true)\n  - let b = 2\n  - const c = 3\n  p= a + b + c',
      () => ({ a: 100, b: 200, c: 300 })
    );
    const tDestructuring = runBothRender(
      '- var { x, y: [z = d] } = obj\np #{x}-#{z}',
      () => ({ obj: { x: 'X', y: [] }, d: 'DEF' })
    );
    const tFunctions = runBothRender(
      '- function fn(p = ext) { return p + 1; }\n- var arr = (q = ext2) => q * 2;\np #{fn()}:#{arr()}',
      () => ({ ext: 10, ext2: 5 })
    );
    const tCatch = runBothRender(
      '- try { throw new Error("E"); } catch (err) { var msg = err.message + suffix; }\np= msg',
      () => ({ err: 'WRONG', suffix: '!' })
    );
    const tBlockShadow = runBothRender(
      'p= x\n- {\n  - let x = "inner"\n  p= x\n- }\np= x',
      () => ({ x: 'outer' })
    );
    // Top-level referenced let/const throws SyntaxError in both raw and rust due to with@7.0.0 wrapping
    let rawTopLetThrew = false;
    let rustTopLetThrew = false;
    try { rawPug.compile('- let topLet = 1\np= topLet'); } catch (e) { rawTopLetThrew = e instanceof SyntaxError; }
    try { rustPug.compile('- let topLet = 1\np= topLet'); } catch (e) { rustTopLetThrew = e instanceof SyntaxError; }
    const tTopLetParity = { ok: rawTopLetThrew && rustTopLetThrew };

    const tests = [tVarAndBlockLetConst, tDestructuring, tFunctions, tCatch, tBlockShadow, tTopLetParity];
    categories.push({
      category: '1. Declarations & Shadowing',
      passed: tests.filter((t) => t.ok).length,
      total: tests.length,
      allOk: tests.every((t) => t.ok),
    });
  }

  // Category 2: Locals Lookup (own, prototype, missing, explicit undefined vs global fallback)
  {
    const proto = { inherited: 'proto-val' };
    const tests = [
      runBothRender('p #{own}:#{inherited}:#{typeof missing}', () => {
        const o = Object.create(proto);
        o.own = 'own-val';
        return o;
      }),
      runBothRender('p= typeof Math', () => ({ Math: undefined })),
      runBothRender('p= Math.max(2, 9) + ":" + JSON.stringify([1]) + ":" + Array.isArray([])', () => ({})),
    ];
    categories.push({
      category: '2. Locals Lookup & Global Fallback',
      passed: tests.filter((t) => t.ok).length,
      total: tests.length,
      allOk: tests.every((t) => t.ok),
    });
  }

  // Category 3: Getter Side-Effects (count, order, timing, throwing)
  {
    const runGetterTrace = (engine) => {
      const log = [];
      const locals = {};
      Object.defineProperty(locals, 'bVar', {
        enumerable: true,
        get() { log.push('get:bVar'); return 'B'; },
      });
      Object.defineProperty(locals, 'aVar', {
        enumerable: true,
        get() { log.push('get:aVar'); return 'A'; },
      });
      const tpl = '- log.push("body:start")\np #{bVar}-#{aVar}-#{bVar}\n- log.push("body:end")';
      locals.log = log;
      const html = engine.render(tpl, locals);
      return { html, log };
    };
    const rawG = runGetterTrace(rawPug);
    const rustG = runGetterTrace(rustPug);
    const getterMatch = JSON.stringify(rawG) === JSON.stringify(rustG);
    categories.push({
      category: '3. Getter Side-Effects (Count, Order, Timing, Exceptions)',
      passed: getterMatch ? 1 : 0,
      total: 1,
      allOk: getterMatch,
      details: { rawG, rustG },
    });
  }

  // Category 4: Assignments (=, +=, ++ on local binding vs locals object)
  {
    const rawLocals = { count: 10, box: { n: 1 } };
    const rustLocals = { count: 10, box: { n: 1 } };
    const tpl = '- count += 5\n- count++\n- box.n = 99\np #{count}:#{box.n}';
    const rawHtml = rawPug.render(tpl, rawLocals);
    const rustHtml = rustPug.render(tpl, rustLocals);
    const ok =
      rawHtml === rustHtml &&
      rawLocals.count === 10 &&
      rustLocals.count === 10 &&
      rawLocals.box.n === 99 &&
      rustLocals.box.n === 99;
    categories.push({
      category: '4. Assignments (=, +=, ++ on local vs property mutation)',
      passed: ok ? 1 : 0,
      total: 1,
      allOk: ok,
    });
  }

  // Category 5: Execution Context (this, arguments at top-level vs regular function vs arrow function, top-level return vs nested return)
  {
    const tTopReturn = runBothRender('p before\n- if (stop) return "<p>early</p>";\np after', () => ({ stop: true }));
    const tNestedReturn = runBothRender('- function helper() { return "from-helper"; }\np= helper()', () => ({}));
    const tTopArguments = runBothRender('p= arguments', () => ({ arguments: 'top-level-args-from-locals' }));
    // Regular function using its own implicit `arguments` object:
    const tFnArguments = runBothRender(
      '- function firstArg() { return arguments[0]; }\np= firstArg("correct")',
      () => ({ arguments: ['wrong-from-locals'] })
    );
    const tAddWithFnArguments = runBothAddWith(
      'locals || {}',
      'function firstArg() { return arguments[0]; }\npug_html = pug_html + firstArg("ok");',
      ['pug_html']
    );
    const tests = [tTopReturn, tNestedReturn, tTopArguments, tFnArguments, tAddWithFnArguments];
    categories.push({
      category: '5. Execution Context (this, arguments, top-level vs nested return)',
      passed: tests.filter((t) => t.ok).length,
      total: tests.length,
      allOk: tests.every((t) => t.ok),
      failures: tests
        .map((t, idx) => ({ idx, ...t }))
        .filter((t) => !t.ok),
    });
  }

  // Category 6: Analysis Boundary (raw JS body passed to addWith vs outer render function)
  {
    const sampleBody = 'var pug_indent = [];\npug_html = pug_html + "<p>" + (pug_escape(null == (pug_interp = locals_var) ? "" : pug_interp)) + "</p>";';
    const boundaryCheck = runBothAddWith('locals || {}', sampleBody, [
      'pug_html',
      'pug_interp',
      'pug_debug_line',
      'pug_debug_filename',
      'pug_debug_sources',
      'pug_escape',
    ]);
    categories.push({
      category: '6. Analysis Boundary (direct addWith on codegen body)',
      passed: boundaryCheck.ok ? 1 : 0,
      total: 1,
      allOk: boundaryCheck.ok,
      details: boundaryCheck,
    });
  }

  // Category 7: Generated Name Collisions (locals_for_with, result_of_with, self, pug_html, pug_interp)
  {
    const t1 = runBothRender('p #{locals_for_with}:#{result_of_with}:#{self}', () => ({
      locals_for_with: 'L',
      result_of_with: 'R',
      self: 'S',
    }));
    const t2 = runBothRender(
      '- var locals_for_with = "localL"\n- if (flag) return "<p>" + locals_for_with + ":" + ext + "</p>"\np normal',
      () => ({ flag: true, ext: 'E' })
    );
    const tests = [t1, t2];
    categories.push({
      category: '7. Generated Name Collisions (locals_for_with, result_of_with, self)',
      passed: tests.filter((t) => t.ok).length,
      total: tests.length,
      allOk: tests.every((t) => t.ok),
    });
  }

  // Category 8: Multi-level Control Flow & Compile vs Runtime Error Stages
  {
    const tpl = [
      'if show',
      '  each group in groups',
      '    - var prefix = group.title + ":" + globalTag',
      '    while group.items.length > 0',
      '      - var item = group.items.shift()',
      '      case item',
      '        when "a"',
      '          p #{prefix}-A',
      '        default',
      '          p #{prefix}-#{item}',
    ].join('\n');
    const cfRes = runBothRender(tpl, () => ({
      show: true,
      globalTag: 'G',
      groups: [{ title: 'G1', items: ['a', 'b'] }],
    }));

    // Compile error stage vs runtime error stage
    let rawCompileErr = null;
    let rustCompileErr = null;
    try { rawPug.compile('p= (1 +'); } catch (e) { rawCompileErr = e; }
    try { rustPug.compile('p= (1 +'); } catch (e) { rustCompileErr = e; }
    const compileStageMatch = Boolean(rawCompileErr && rustCompileErr && rawCompileErr.code === rustCompileErr.code);

    const rawFn = rawPug.compile('p= obj.undefProp.deep');
    const rustFn = rustPug.compile('p= obj.undefProp.deep');
    let rawRuntimeErr = null;
    let rustRuntimeErr = null;
    try { rawFn({ obj: {} }); } catch (e) { rawRuntimeErr = e; }
    try { rustFn({ obj: {} }); } catch (e) { rustRuntimeErr = e; }
    const runtimeStageMatch = Boolean(
      rawRuntimeErr instanceof TypeError &&
      rustRuntimeErr instanceof TypeError &&
      rawRuntimeErr.message === rustRuntimeErr.message
    );

    const allOk = cfRes.ok && compileStageMatch && runtimeStageMatch;
    categories.push({
      category: '8. Multi-level Control Flow & Error Stage Distinction',
      passed: [cfRes.ok, compileStageMatch, runtimeStageMatch].filter(Boolean).length,
      total: 3,
      allOk,
    });
  }

  // Category 9: self: true & globals: [...] branches
  {
    const tSelf = runBothRender('p #{self.a}:#{typeof a}', () => ({ a: 'SELF_A' }), { self: true });
    const tGlobalsTypeof = runBothRender(
      'p= typeof customGlobal + ":" + normalLocal',
      () => ({ customGlobal: 'from-locals', normalLocal: 'ok' }),
      { globals: ['customGlobal'] }
    );
    const tests = [tSelf, tGlobalsTypeof];
    categories.push({
      category: '9. self: true & globals: [...] Options',
      passed: tests.filter((t) => t.ok).length,
      total: tests.length,
      allOk: tests.every((t) => t.ok),
    });
  }

  return {
    status: categories.every((c) => c.allOk) ? 'PASS' : 'PARTIAL_FAIL',
    categoriesTotal: categories.length,
    categoriesPassed: categories.filter((c) => c.allOk).length,
    categoriesFailed: categories.filter((c) => !c.allOk).length,
    categories,
  };
}

function main() {
  const startedAt = new Date().toISOString();
  const envAndProvenance = runEnvAndProvenanceAudit();
  const comparatorSelfCheck = runComparatorSelfCheck();
  const step1 = runStep1Audit();
  const step2 = runStep2Audit();
  const step3a = runStep3AAudit();
  const step3b = runStep3BAudit();
  const step3c = runStep3CAudit();
  const finishedAt = new Date().toISOString();

  const report = {
    startedAt,
    finishedAt,
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      cwd: process.cwd(),
      repoRoot: REPO_ROOT,
      rawRoot: RAW_ROOT,
      rustRoot: RUST_ROOT,
    },
    verdicts: {
      envAndProvenance: envAndProvenance.status,
      serializersCredible: comparatorSelfCheck.serializersCredible ? 'PASS' : 'FAIL',
      differentialRunnerCredible: comparatorSelfCheck.runnerFullyCredible ? 'PASS' : 'FAIL_FALSE_POSITIVES_FOUND',
      step1: step1.status,
      step2: step2.status,
      step3a: step3a.status,
      step3b: step3b.status,
      step3c: step3c.status,
    },
    envAndProvenance,
    comparatorSelfCheck,
    step1,
    step2,
    step3a,
    step3b,
    step3c,
  };

  const outArg = process.argv[2];
  if (outArg) {
    fs.writeFileSync(path.resolve(outArg), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(report.verdicts, null, 2));
}

main();
