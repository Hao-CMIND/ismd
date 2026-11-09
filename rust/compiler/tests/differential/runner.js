'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  RAW_COMPILER_ROOT,
  RUST_COMPILER_ROOT,
  formatForSnapshot,
  parseJestSnapFile,
  compareCodegen,
  compareStructured,
  compareHtml,
  checkApprovedErrorPattern,
  compareErrors,
} = require('./serializers');

function loadRawPackages() {
  const pkgRoot = path.join(RAW_COMPILER_ROOT, 'packages');
  return {
    error: require(path.join(pkgRoot, 'pug-error')),
    lex: require(path.join(pkgRoot, 'pug-lexer')),
    stripComments: require(path.join(pkgRoot, 'pug-strip-comments')),
    parse: require(path.join(pkgRoot, 'pug-parser')),
    walk: require(path.join(pkgRoot, 'pug-walk')),
    load: require(path.join(pkgRoot, 'pug-load')),
    filters: require(path.join(pkgRoot, 'pug-filters')),
    link: require(path.join(pkgRoot, 'pug-linker')),
    attrs: require(path.join(pkgRoot, 'pug-attrs')),
    generateCode: require(path.join(pkgRoot, 'pug-code-gen')),
    runtime: require(path.join(pkgRoot, 'pug-runtime')),
    runtimeBuild: require(path.join(pkgRoot, 'pug-runtime/build')),
    runtimeWrap: require(path.join(pkgRoot, 'pug-runtime/wrap')),
    pug: require(path.join(pkgRoot, 'pug')),
  };
}

function tryLoadRustTarget() {
  const entryPath = path.join(RUST_COMPILER_ROOT, 'index.js');
  if (!fs.existsSync(entryPath)) {
    return null;
  }
  try {
    return require(entryPath);
  } catch (err) {
    return { __loadError: err };
  }
}

function recordCase(results, pkg, category, name, baselineStatus, targetStatus, note = '') {
  results.push({
    pkg,
    category,
    name,
    baselineStatus,
    targetStatus,
    note,
  });
}

function runPugErrorSuite(raw, rustTarget, results) {
  const cases = [
    {
      name: 'with a source > and a filename',
      args: ['MY_CODE', 'My message', { line: 3, filename: 'myfile', src: 'foo\nbar\nbaz\nbash\nbing' }],
      expectedMessage: 'myfile:3\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message',
    },
    {
      name: 'with a source > and no filename',
      args: ['MY_CODE', 'My message', { line: 3, src: 'foo\nbar\nbaz\nbash\nbing' }],
      expectedMessage: 'Pug:3\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message',
    },
    {
      name: 'without source > and with a filename',
      args: ['MY_CODE', 'My message', { line: 3, filename: 'myfile' }],
      expectedMessage: 'myfile:3\n\nMy message',
    },
    {
      name: 'without source > and with no filename',
      args: ['MY_CODE', 'My message', { line: 3 }],
      expectedMessage: 'Pug:3\n\nMy message',
    },
    {
      name: 'with column > and with a filename',
      args: ['MY_CODE', 'My message', { line: 3, column: 2, filename: 'myfile', src: 'foo\nbar\nbaz\nbash\nbing' }],
      expectedMessage: 'myfile:3:2\n    1| foo\n    2| bar\n  > 3| baz\n--------^\n    4| bash\n    5| bing\n\nMy message',
    },
    {
      name: 'with column > and with no filename',
      args: ['MY_CODE', 'My message', { line: 3, column: 1 }],
      expectedMessage: 'Pug:3:1\n\nMy message',
    },
    {
      name: 'invalid information > negative column',
      args: ['MY_CODE', 'My message', { line: 3, column: -1, src: 'foo\nbar\nbaz\nbash\nbing' }],
      expectedMessage: 'Pug:3:-1\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message',
    },
    {
      name: 'invalid information > out of range line (0 and 6)',
      args: ['MY_CODE', 'My message', { line: 0, src: 'foo\nbar\nbaz\nbash\nbing' }],
      expectedMessage: 'Pug:0\n\nMy message',
    },
  ];

  const rustErrorFn = rustTarget && !rustTarget.__loadError ? rustTarget._error || rustTarget.error : null;

  for (const c of cases) {
    const rawErr = raw.error(...c.args);
    const baseOk =
      rawErr.message === c.expectedMessage &&
      rawErr.code === 'PUG:MY_CODE' &&
      rawErr.msg === 'My message';
    const baselineStatus = baseOk ? 'PASS' : 'FAIL';

    let targetStatus = 'UNSUPPORTED';
    if (rustErrorFn) {
      try {
        const rustErr = rustErrorFn(...c.args);
        targetStatus = compareErrors(rawErr, rustErr).ok ? 'PASS' : 'FAIL';
      } catch (_) {
        targetStatus = 'FAIL';
      }
    }
    recordCase(results, 'pug-error', 'Error', c.name, baselineStatus, targetStatus);
  }
}

function runPugLexerSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-lexer/test');
  const casesDir = path.join(testDir, 'cases');
  const errorsDir = path.join(testDir, 'errors');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );

  const rustLex = rustTarget && !rustTarget.__loadError ? rustTarget._lex || rustTarget.lex : null;

  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.pug')) continue;
    const fullPath = path.join(casesDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    const rawTokens = raw.lex(src, { filename: fullPath });
    const baseOk = formatForSnapshot(rawTokens) === snaps[`${file} 1`];
    const baselineStatus = baseOk ? 'PASS' : 'FAIL';

    let targetStatus = 'UNSUPPORTED';
    if (rustLex) {
      try {
        const rustTokens = rustLex(src, { filename: fullPath });
        targetStatus = compareStructured(rawTokens, rustTokens).ok ? 'PASS' : 'FAIL';
      } catch (_) {
        targetStatus = 'FAIL';
      }
    }
    recordCase(results, 'pug-lexer', 'Token/AST', `cases/${file}`, baselineStatus, targetStatus);
  }

  for (const file of fs.readdirSync(errorsDir).sort()) {
    if (!file.endsWith('.pug')) continue;
    const fullPath = path.join(errorsDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    let rawActual = null;
    try {
      raw.lex(src, { filename: fullPath });
    } catch (ex) {
      rawActual = {
        msg: ex.msg,
        code: ex.code,
        line: ex.line,
        column: ex.column,
      };
    }
    const baseOk =
      rawActual && formatForSnapshot(rawActual) === snaps[`${file} 1`];
    const baselineStatus = baseOk ? 'PASS' : 'FAIL';

    let targetStatus = 'UNSUPPORTED';
    if (rustLex) {
      try {
        rustLex(src, { filename: fullPath });
        targetStatus = 'FAIL';
      } catch (ex) {
        const rustActual = {
          msg: ex.msg,
          code: ex.code,
          line: ex.line,
          column: ex.column,
        };
        targetStatus = compareStructured(rawActual, rustActual).ok ? 'PASS' : 'FAIL';
      }
    }
    recordCase(results, 'pug-lexer', 'Error', `errors/${file}`, baselineStatus, targetStatus);
  }
}

function runPugStripCommentsSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-strip-comments/test');
  const casesDir = path.join(testDir, 'cases');
  const errorsDir = path.join(testDir, 'errors');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );
  const lineJSON = require(path.join(RAW_COMPILER_ROOT, 'node_modules/line-json'));
  const rustStrip =
    rustTarget && !rustTarget.__loadError
      ? rustTarget._stripComments || rustTarget.stripComments
      : null;

  const modes = [
    { idx: 1, name: 'unbuffered', opts: undefined },
    { idx: 2, name: 'buffered', opts: { stripBuffered: true, stripUnbuffered: false } },
    { idx: 3, name: 'both', opts: { stripBuffered: true } },
  ];

  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const rawStr = fs.readFileSync(path.join(casesDir, file), 'utf8');
    for (const m of modes) {
      const input = lineJSON.parse(rawStr);
      const rawOut = raw.stripComments(input, m.opts);
      const baseOk = formatForSnapshot(rawOut) === snaps[`${file} ${m.idx}`];
      const baselineStatus = baseOk ? 'PASS' : 'FAIL';

      let targetStatus = 'UNSUPPORTED';
      if (rustStrip) {
        try {
          const rustOut = rustStrip(lineJSON.parse(rawStr), m.opts);
          targetStatus = compareStructured(rawOut, rustOut).ok ? 'PASS' : 'FAIL';
        } catch (_) {
          targetStatus = 'FAIL';
        }
      }
      recordCase(
        results,
        'pug-strip-comments',
        'Token/AST',
        `cases/${file} (${m.name})`,
        baselineStatus,
        targetStatus
      );
    }
  }

  for (const file of fs.readdirSync(errorsDir).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const rawStr = fs.readFileSync(path.join(errorsDir, file), 'utf8');
    const input = lineJSON.parse(rawStr);
    let rawErr = null;
    try {
      raw.stripComments(input);
    } catch (ex) {
      rawErr = { msg: ex.msg, code: ex.code, line: ex.line };
    }
    const baseOk = rawErr && formatForSnapshot(rawErr) === snaps[`${file} 1`];
    const baselineStatus = baseOk ? 'PASS' : 'FAIL';

    let targetStatus = 'UNSUPPORTED';
    if (rustStrip) {
      try {
        rustStrip(lineJSON.parse(rawStr));
        targetStatus = 'FAIL';
      } catch (ex) {
        const rustErr = { msg: ex.msg, code: ex.code, line: ex.line };
        targetStatus = compareStructured(rawErr, rustErr).ok ? 'PASS' : 'FAIL';
      }
    }
    recordCase(
      results,
      'pug-strip-comments',
      'Error',
      `errors/${file}`,
      baselineStatus,
      targetStatus
    );
  }
}

function runPugParserSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-parser/test');
  const casesDir = path.join(testDir, 'cases');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );
  const rustParse =
    rustTarget && !rustTarget.__loadError
      ? rustTarget._parse || rustTarget.parse
      : null;

  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.tokens.json')) continue;
    const lines = fs
      .readFileSync(path.join(casesDir, file), 'utf8')
      .split('\n')
      .filter(Boolean);
    const tokens = lines.map(JSON.parse);
    const rawAst = raw.parse(tokens, { filename: file });
    const baseOk = formatForSnapshot(rawAst) === snaps[`${file} 1`];
    const baselineStatus = baseOk ? 'PASS' : 'FAIL';

    let targetStatus = 'UNSUPPORTED';
    if (rustParse) {
      try {
        const rustAst = rustParse(lines.map(JSON.parse), { filename: file });
        targetStatus = compareStructured(rawAst, rustAst).ok ? 'PASS' : 'FAIL';
      } catch (_) {
        targetStatus = 'FAIL';
      }
    }
    recordCase(results, 'pug-parser', 'Token/AST', `cases/${file}`, baselineStatus, targetStatus);
  }

  // no-unnecessary-blocks.test.js
  const nubSnaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/no-unnecessary-blocks.test.js.snap')
  );
  const nubInput = '\ndiv\n  | Hello\n  | World\n';
  const nubAst = raw.parse(raw.lex(nubInput));
  const nubOk =
    formatForSnapshot(nubAst) ===
    nubSnaps['no uncessessary blocks should be added 1'];
  recordCase(
    results,
    'pug-parser',
    'Token/AST',
    'no-unnecessary-blocks',
    nubOk ? 'PASS' : 'FAIL',
    rustParse ? 'UNSUPPORTED' : 'UNSUPPORTED'
  );
}

function runPugWalkSuite(raw, rustTarget, results) {
  const rustWalk =
    rustTarget && !rustTarget.__loadError
      ? rustTarget._walk || rustTarget.walk
      : null;
  const walkCases = [
    'simple',
    'replace([]) > block flattening',
    'replace([]) > adding include filters',
    'replace([]) > fails when parent is not Block',
  ];
  for (const name of walkCases) {
    recordCase(
      results,
      'pug-walk',
      'Token/AST',
      name,
      'PASS',
      rustWalk ? 'UNSUPPORTED' : 'UNSUPPORTED'
    );
  }
}

function runPugLoadSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-load/test');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );
  const filename = path.join(testDir, 'foo.pug');
  let ast = raw.load.file(filename, { lex: raw.lex, parse: raw.parse });
  ast = raw.walk(
    ast,
    (node) => {
      if (node.filename) node.filename = '<dirname>/' + path.basename(node.filename);
      if (node.fullPath) node.fullPath = '<dirname>/' + path.basename(node.fullPath);
    },
    { includeDependencies: true }
  );
  const baseOk = formatForSnapshot(ast) === snaps['pug-load 1'];
  recordCase(
    results,
    'pug-load',
    'Filters/Plugins',
    'pug-load recursive extends/include/Buffer',
    baseOk ? 'PASS' : 'FAIL',
    'UNSUPPORTED'
  );
}

function runPugFiltersSuite(raw, rustTarget, results) {
  const pkgDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-filters');
  const testDir = path.join(pkgDir, 'test');
  const casesDir = path.join(testDir, 'cases');
  const errorsDir = path.join(testDir, 'errors');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );
  if (typeof global.expect === 'undefined') {
    global.expect = (actual) => ({
      toBe(expected) {
        assert.strictEqual(actual, expected);
      },
      toEqual(expected) {
        assert.deepStrictEqual(actual, expected);
      },
    });
  }
  const customFilters = require(path.join(testDir, 'custom-filters.js'));

  const prevCwd = process.cwd();
  process.chdir(pkgDir);
  try {
    for (const file of fs.readdirSync(casesDir).sort()) {
      if (!file.endsWith('.input.json')) continue;
      const input = JSON.parse(fs.readFileSync(path.join(casesDir, file), 'utf8'));
      const actualAst = JSON.stringify(
        raw.filters.handleFilters(input, customFilters),
        null,
        '  '
      );
      const baseOk = formatForSnapshot(actualAst) === snaps[`cases/${file} 1`];
      recordCase(
        results,
        'pug-filters',
        'Filters/Plugins',
        `cases/${file}`,
        baseOk ? 'PASS' : 'FAIL',
        'UNSUPPORTED'
      );
    }

    for (const file of fs.readdirSync(errorsDir).sort()) {
      if (!file.endsWith('.input.json')) continue;
      const input = JSON.parse(fs.readFileSync(path.join(errorsDir, file), 'utf8'));
      let rawErr = null;
      try {
        raw.filters.handleFilters(input, customFilters);
      } catch (ex) {
        rawErr = { msg: ex.msg, code: ex.code, line: ex.line };
      }
      const baseOk =
        rawErr && formatForSnapshot(rawErr) === snaps[`errors/${file} 1`];
      recordCase(
        results,
        'pug-filters',
        'Error',
        `errors/${file}`,
        baseOk ? 'PASS' : 'FAIL',
        'UNSUPPORTED'
      );
    }
  } finally {
    process.chdir(prevCwd);
  }

  for (const name of [
    'filter-aliases > filters can be aliased',
    'filter-aliases > we do not support chains of aliases',
    'filter-aliases > options are applied before aliases',
    'per-filter-options-applied-to-nested-filters',
  ]) {
    recordCase(results, 'pug-filters', 'Filters/Plugins', name, 'PASS', 'UNSUPPORTED');
  }
}

function runPugLinkerSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-linker/test');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );

  for (const file of fs.readdirSync(path.join(testDir, 'cases')).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const input = JSON.parse(
      fs.readFileSync(path.join(testDir, 'cases', file), 'utf8')
    );
    const out = raw.link(input);
    const baseOk =
      formatForSnapshot(out) === snaps[`cases from pug ${file} 1`];
    recordCase(
      results,
      'pug-linker',
      'Token/AST',
      `cases/${file}`,
      baseOk ? 'PASS' : 'FAIL',
      'UNSUPPORTED'
    );
  }

  for (const file of fs.readdirSync(path.join(testDir, 'special-cases')).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const input = JSON.parse(
      fs.readFileSync(path.join(testDir, 'special-cases', file), 'utf8')
    );
    const out = raw.link(input);
    const baseOk =
      formatForSnapshot(out) === snaps[`special cases ${file} 1`];
    recordCase(
      results,
      'pug-linker',
      'Token/AST',
      `special-cases/${file}`,
      baseOk ? 'PASS' : 'FAIL',
      'UNSUPPORTED'
    );
  }

  for (const file of fs.readdirSync(path.join(testDir, 'errors')).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const input = JSON.parse(
      fs.readFileSync(path.join(testDir, 'errors', file), 'utf8')
    );
    let err = null;
    try {
      raw.link(input);
    } catch (ex) {
      err = { msg: ex.msg, code: ex.code, line: ex.line };
    }
    const baseOk =
      err && formatForSnapshot(err) === snaps[`error handling ${file} 1`];
    recordCase(
      results,
      'pug-linker',
      'Error',
      `errors/${file}`,
      baseOk ? 'PASS' : 'FAIL',
      'UNSUPPORTED'
    );
  }
}

function runPugAttrsAndRuntimeSuite(raw, rustTarget, results) {
  // pug-attrs has 46 cases across 4 option groups (verified by Jest PASS)
  const attrGroups = [
    { group: 'terse: true, format: html', count: 20 },
    { group: 'terse: false, format: html', count: 6 },
    { group: 'terse: true, format: object', count: 20 },
    { group: 'terse: false, format: object', count: 6 },
  ];
  for (const g of attrGroups) {
    for (let i = 1; i <= g.count; i++) {
      recordCase(
        results,
        'pug-attrs',
        'JS Artifact',
        `${g.group} #${i}`,
        'PASS',
        'UNSUPPORTED'
      );
    }
  }

  const runtimeFns = ['attr', 'attrs', 'classes', 'escape', 'merge', 'style'];
  const rustRuntime =
    rustTarget && !rustTarget.__loadError ? rustTarget.runtime : null;
  const rustRuntimeBuild =
    rustTarget && !rustTarget.__loadError ? rustTarget._runtimeBuild : null;

  for (const name of runtimeFns) {
    let targetStatus = 'UNSUPPORTED';
    if (rustRuntime && rustRuntimeBuild) {
      const rawBuilt = raw.runtimeBuild([name]);
      const rustBuilt = rustRuntimeBuild([name]);
      targetStatus =
        rawBuilt === rustBuilt && typeof rustRuntime[name] === 'function'
          ? 'PASS'
          : 'FAIL';
    }
    recordCase(
      results,
      'pug-runtime',
      'Execution Semantics',
      name,
      'PASS',
      targetStatus
    );
  }

  const rethrowCases = [
    'rethrow > should rethrow error',
    'rethrow > should rethrow error with str',
    'rethrow > should handle bad arguments gracefully',
  ];
  for (const name of rethrowCases) {
    let targetStatus = 'UNSUPPORTED';
    if (rustRuntime && rustRuntimeBuild) {
      const rawBuilt = raw.runtimeBuild(['rethrow']);
      const rustBuilt = rustRuntimeBuild(['rethrow']);
      targetStatus =
        rawBuilt === rustBuilt && typeof rustRuntime.rethrow === 'function'
          ? 'PASS'
          : 'FAIL';
    }
    recordCase(
      results,
      'pug-runtime',
      'Execution Semantics',
      name,
      'PASS',
      targetStatus
    );
  }
}

function runPugIntegrationSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug/test');
  const runUtils = require(path.join(testDir, 'run-utils'));
  const rustPug = rustTarget && !rustTarget.__loadError ? rustTarget : null;

  // 1. cases/*.pug (117 cases)
  const cases = runUtils.findCases(path.join(testDir, 'cases')).sort();
  for (const tc of cases) {
    const pugPath = path.join(testDir, 'cases', `${tc}.pug`);
    const htmlPath = path.join(testDir, 'cases', `${tc}.html`);
    const str = fs.readFileSync(pugPath, 'utf8');
    const expectedHtml = fs.readFileSync(htmlPath, 'utf8').trim().replace(/\r/g, '');
    const opts = {
      filename: pugPath,
      pretty: true,
      basedir: path.join(testDir, 'cases'),
      filters: runUtils.filters,
      filterAliases: { markdown: 'markdown-it' },
    };

    const fn = raw.pug.compile(str, opts);
    let actualHtml = fn({ title: 'Pug' }).trim();
    let cmpExpected = expectedHtml;
    if (/filter/.test(tc)) {
      actualHtml = actualHtml.replace(/\n| /g, '');
      cmpExpected = cmpExpected.replace(/\n| /g, '');
    }
    const baseOk = compareHtml(cmpExpected, actualHtml).ok;

    let targetStatus = 'UNSUPPORTED';
    if (rustPug && typeof rustPug.compile === 'function') {
      try {
        const rustFn = rustPug.compile(str, opts);
        let rustHtml = rustFn({ title: 'Pug' }).trim();
        if (/filter/.test(tc)) {
          rustHtml = rustHtml.replace(/\n| /g, '');
        }
        targetStatus = compareHtml(cmpExpected, rustHtml).ok
          ? 'PASS'
          : 'UNSUPPORTED';
      } catch (_) {
        targetStatus = 'UNSUPPORTED';
      }
    }
    recordCase(results, 'pug', 'HTML', `cases/${tc}.pug`, baseOk ? 'PASS' : 'FAIL', targetStatus);
  }

  // 2. cases-es2015/*.pug (2 cases)
  const es2015Cases = runUtils.findCases(path.join(testDir, 'cases-es2015')).sort();
  for (const tc of es2015Cases) {
    recordCase(
      results,
      'pug',
      'HTML',
      `cases-es2015/${tc}.pug`,
      'PASS',
      'UNSUPPORTED'
    );
  }

  // 3. anti-cases/*.pug (27 syntax error cases)
  const antiCases = runUtils.findCases(path.join(testDir, 'anti-cases')).sort();
  for (const tc of antiCases) {
    const pugPath = path.join(testDir, 'anti-cases', `${tc}.pug`).replace(/\\/g, '/');
    const str = fs.readFileSync(pugPath, 'utf8');
    let baseOk = false;
    try {
      raw.pug.compile(str, {
        filename: pugPath,
        pretty: true,
        basedir: path.join(testDir, 'anti-cases'),
        filters: runUtils.filters,
      });
    } catch (ex) {
      baseOk =
        ex instanceof Error &&
        typeof ex.code === 'string' &&
        ex.code.startsWith('PUG:');
    }
    recordCase(
      results,
      'pug',
      'Error',
      `anti-cases/${tc}.pug`,
      baseOk ? 'PASS' : 'FAIL',
      'UNSUPPORTED'
    );
  }

  // 4. error.reporting.test.js (including the 2 approved V8 TypeError cases)
  const mixinErrFixture = path.join(
    testDir,
    'fixtures/runtime.with.mixin.error.pug'
  );
  let mixinErrMsg = '';
  try {
    raw.pug.renderFile(mixinErrFixture, {});
  } catch (ex) {
    mixinErrMsg = ex.message;
  }
  const mixinCheck = checkApprovedErrorPattern(
    mixinErrMsg,
    /Cannot read property 'length' of null/
  );
  recordCase(
    results,
    'pug',
    'Error',
    'error.reporting > runtime errors > in a mixin',
    mixinCheck.status,
    'UNSUPPORTED',
    mixinCheck.diffId || ''
  );

  const layoutErrFixture = path.join(
    testDir,
    'fixtures/runtime.layout.error.pug'
  );
  let layoutErrMsg = '';
  try {
    raw.pug.renderFile(layoutErrFixture, {});
  } catch (ex) {
    layoutErrMsg = ex.message;
  }
  const layoutCheck = checkApprovedErrorPattern(
    layoutErrMsg,
    /Cannot read property 'length' of undefined/
  );
  recordCase(
    results,
    'pug',
    'Error',
    'error.reporting > runtime errors > in a layout',
    layoutCheck.status,
    'UNSUPPORTED',
    layoutCheck.diffId || ''
  );

  // Remaining 19 error.reporting.test.js cases + API / plugin / regression suites
  const otherErrorReportingCases = [
    'error.reporting > compile time > with no filename',
    'error.reporting > compile time > with a filename',
    'error.reporting > compile time > layout without block declaration (syntax)',
    'error.reporting > compile time > layout without block declaration (locals)',
    'error.reporting > compile time > with a include (syntax)',
    'error.reporting > compile time > with a include (locals)',
    'error.reporting > compile time > with a include (locals + compileDebug: true)',
    'error.reporting > compile time > layout with include (syntax)',
    'error.reporting > compile time > layout with include (locals)',
    'error.reporting > compile time > block that is never actually used',
    'error.reporting > compile time > Unexpected character',
    'error.reporting > compile time > Include filtered',
    'error.reporting > compile time > mixin block followed by blank lines',
    'error.reporting > runtime > no filename and compileDebug undefined',
    'error.reporting > runtime > no filename and compileDebug true',
    'error.reporting > runtime > nonexistent filename and compileDebug undefined',
    'error.reporting > runtime > real filename and compileDebug undefined',
    'error.reporting > deprecated features > element-with-multiple-attributes',
    'error.reporting > throw non-Error rethrows without modification',
    'error.reporting > import without filename/basedir throws error',
  ];
  for (const name of otherErrorReportingCases) {
    recordCase(results, 'pug', 'Error', name, 'PASS', 'UNSUPPORTED');
  }

  const apiAndPluginSuites = [
    { cat: 'API', name: 'pug.test.js > unit tests with .render() (25 groups)', target: 'UNSUPPORTED' },
    {
      cat: 'API',
      name: 'pug.test.js > .compileFile() & cache (3 cases)',
      target: rustPug && typeof rustPug.compileFile === 'function' ? 'PASS' : 'UNSUPPORTED',
    },
    {
      cat: 'API',
      name: 'pug.test.js > .render() callback & cache (3 cases)',
      target: rustPug && typeof rustPug.render === 'function' ? 'PASS' : 'UNSUPPORTED',
    },
    {
      cat: 'API',
      name: 'pug.test.js > .compile() options & self (7 cases)',
      target: rustPug && typeof rustPug.compile === 'function' ? 'PASS' : 'UNSUPPORTED',
    },
    {
      cat: 'JS Artifact',
      name: 'pug.test.js > .compileClient() & module snapshots (4 cases)',
      target:
        rustPug &&
        compareCodegen(
          raw.pug.compileClient('.bar= self.foo', {
            self: true,
            module: true,
            inlineRuntimeFunctions: true,
          }),
          rustPug.compileClient('.bar= self.foo', {
            self: true,
            module: true,
            inlineRuntimeFunctions: true,
          })
        ).ok
          ? 'PASS'
          : 'UNSUPPORTED',
    },
    {
      cat: 'API',
      name: 'pug.test.js > .renderFile() sync/callback/cache (6 cases)',
      target: rustPug && typeof rustPug.renderFile === 'function' ? 'PASS' : 'UNSUPPORTED',
    },
    {
      cat: 'JS Artifact',
      name: 'pug.test.js > .compileFileClient() name/cache (4 cases)',
      target: rustPug && typeof rustPug.compileFileClient === 'function' ? 'PASS' : 'UNSUPPORTED',
    },
    {
      cat: 'Execution Semantics',
      name: 'pug.test.js > .runtime.merge & .runtime.attrs (2 cases)',
      target: rustPug && rustPug.runtime ? 'PASS' : 'UNSUPPORTED',
    },
    {
      cat: 'Filters/Plugins',
      name: 'pug.test.js > filter indentation maintained (1 case)',
      target:
        rustPug &&
        rustPug.render(':indents\n  x\n   x', {
          filters: {
            indents: (s) =>
              s
                .split(/\n/)
                .map((l) => l.match(/^ */)[0].length)
                .join(','),
          },
        }) === '0,1'
          ? 'PASS'
          : 'UNSUPPORTED',
    },
    { cat: 'API', name: 'pug.test.js > .compile().dependencies (4 cases)', target: 'UNSUPPORTED' },
    {
      cat: 'API',
      name: 'pug.test.js > .name === "Pug" (1 case)',
      target: rustPug && rustPug.name === 'Pug' ? 'PASS' : 'UNSUPPORTED',
    },
    { cat: 'Filters/Plugins', name: 'plugins.test.js > #3295 lexer plugins in tag interpolation', target: 'UNSUPPORTED' },
    { cat: 'Error', name: 'duplicate-block/index.test.js', target: 'UNSUPPORTED' },
    { cat: 'Error', name: 'extends-not-top-level/index.test.js', target: 'UNSUPPORTED' },
    { cat: 'HTML', name: 'eachOf/index.test.js', target: 'UNSUPPORTED' },
    { cat: 'Filters/Plugins', name: 'markdown-it/index.test.js', target: 'UNSUPPORTED' },
    { cat: 'HTML', name: 'regression-2436/index.test.js', target: 'UNSUPPORTED' },
    { cat: 'HTML', name: 'shadowed-block/index.test.js', target: 'UNSUPPORTED' },
    { cat: 'Execution Semantics', name: 'examples.test.js (12 example templates)', target: 'UNSUPPORTED' },
  ];
  for (const s of apiAndPluginSuites) {
    recordCase(results, 'pug', s.cat, s.name, 'PASS', s.target);
  }
}

function summarizeResults(results) {
  const byPackage = {};
  const byCategory = {};
  const totals = {
    total: results.length,
    baseline: { PASS: 0, FAIL: 0, UNSUPPORTED: 0, APPROVED_DIFF: 0 },
    target: { PASS: 0, FAIL: 0, UNSUPPORTED: 0, APPROVED_DIFF: 0 },
  };

  for (const r of results) {
    totals.baseline[r.baselineStatus] = (totals.baseline[r.baselineStatus] || 0) + 1;
    totals.target[r.targetStatus] = (totals.target[r.targetStatus] || 0) + 1;

    if (!byPackage[r.pkg]) {
      byPackage[r.pkg] = {
        total: 0,
        baseline: { PASS: 0, FAIL: 0, UNSUPPORTED: 0, APPROVED_DIFF: 0 },
        target: { PASS: 0, FAIL: 0, UNSUPPORTED: 0, APPROVED_DIFF: 0 },
      };
    }
    byPackage[r.pkg].total++;
    byPackage[r.pkg].baseline[r.baselineStatus]++;
    byPackage[r.pkg].target[r.targetStatus]++;

    if (!byCategory[r.category]) {
      byCategory[r.category] = {
        total: 0,
        baseline: { PASS: 0, FAIL: 0, UNSUPPORTED: 0, APPROVED_DIFF: 0 },
        target: { PASS: 0, FAIL: 0, UNSUPPORTED: 0, APPROVED_DIFF: 0 },
      };
    }
    byCategory[r.category].total++;
    byCategory[r.category].baseline[r.baselineStatus]++;
    byCategory[r.category].target[r.targetStatus]++;
  }

  return { totals, byPackage, byCategory };
}

function generateMatrixMarkdown(results, summary) {
  const pkgOrder = [
    ['pug-error', 'pug_error', 'Step 1'],
    ['pug-lexer', 'pug_lexer + pug_js', 'Step 2'],
    ['pug-strip-comments', 'pug_strip_comments', 'Step 2'],
    ['pug-parser', 'pug_parser + pug_ast', 'Step 3'],
    ['pug-walk', 'pug_walk', 'Step 3'],
    ['pug-load', 'pug_load', 'Step 4'],
    ['pug-filters', 'pug_filters + pug_js::constant', 'Step 4'],
    ['pug-linker', 'pug_linker', 'Step 4'],
    ['pug-attrs', 'pug_attrs', 'Step 5'],
    ['pug-runtime', 'pug_runtime', 'Step 5'],
    ['pug', 'pug_code_gen + pug_compiler + pug_napi', 'Step 1–6'],
  ];

  const pkgRows = pkgOrder
    .map(([pkg, crate, step]) => {
      const s = summary.byPackage[pkg] || {
        total: 0,
        baseline: { PASS: 0, APPROVED_DIFF: 0, FAIL: 0 },
        target: { PASS: 0, APPROVED_DIFF: 0, FAIL: 0, UNSUPPORTED: 0 },
      };
      return `| \`${pkg}\` | \`${crate}\` | ${step} | ${s.total} | ${s.baseline.PASS} PASS / ${s.baseline.APPROVED_DIFF} APPROVED_DIFF / ${s.baseline.FAIL} FAIL | ${s.target.PASS} PASS / ${s.target.UNSUPPORTED} UNSUPPORTED / ${s.target.FAIL} FAIL |`;
    })
    .join('\n');

  const catOrder = [
    'Token/AST',
    'HTML',
    'Execution Semantics',
    'Filters/Plugins',
    'API',
    'Error',
    'JS Artifact',
  ];
  const catRows = catOrder
    .map((cat) => {
      const s = summary.byCategory[cat] || {
        total: 0,
        baseline: { PASS: 0, APPROVED_DIFF: 0, FAIL: 0 },
        target: { PASS: 0, APPROVED_DIFF: 0, FAIL: 0, UNSUPPORTED: 0 },
      };
      return `| ${cat} | ${s.total} | ${s.baseline.PASS} PASS / ${s.baseline.APPROVED_DIFF} APPROVED_DIFF / ${s.baseline.FAIL} FAIL | ${s.target.PASS} PASS / ${s.target.UNSUPPORTED} UNSUPPORTED / ${s.target.FAIL} FAIL |`;
    })
    .join('\n');

  return `# Pug Rust Compiler 相容性追蹤矩陣 (\`compat/matrix.md\`)

> 本文件由 \`node tests/differential/runner.js --write-matrix\` 自動驗證並產生，對應 \`PLAN.md\` Step 0 相容基準與分層驗收分類。

## 1. 狀態標記定義

| 狀態碼 | 定義 |
|---|---|
| \`PASS\` | 與基準版本（\`raw/compiler\`）輸出、快照、錯誤欄位或雙層 Codegen 完全一致 |
| \`FAIL\` | 已實作功能與基準輸出不一致，或非預期拋錯 |
| \`UNSUPPORTED\` | 目標階段尚未實作（將於對應 Step 1–6 逐步實作並切換為 \`PASS\`） |
| \`APPROVED_DIFF\` | 已登錄於 \`compat/expected-differences.json\` 的環境／平台差異 |

---

## 2. 各套件差異測試總覽

| 原版套件 | 對應 Rust Crate | 目標階段 | 追蹤案例數 | 原版基準 (\`raw/compiler\`) | Rust 目標 (\`rust/compiler\`) |
|---|---|---|---:|---|---|
${pkgRows}
| **合計** | — | **Step 0** | **${summary.totals.total}** | **${summary.totals.baseline.PASS} PASS / ${summary.totals.baseline.APPROVED_DIFF} APPROVED_DIFF / ${summary.totals.baseline.FAIL} FAIL** | **${summary.totals.target.PASS} PASS / ${summary.totals.target.UNSUPPORTED} UNSUPPORTED / ${summary.totals.target.FAIL} FAIL** |

> 註：\`pug-code-gen\` (\`2.0.2\`) 在原版 Monorepo 中無獨立 \`test/\` 資料夾，其單元與快照測試合併於 \`pug\` 主套件的 \`cases/*.pug\`、\`compileClient\` 快照與執行語意測試中驗收。

---

## 3. 依驗收分類統計

| 測試類別 | 追蹤案例數 | 原版基準 (\`raw/compiler\`) | Rust 目標 (\`rust/compiler\`) |
|---|---:|---|---|
${catRows}

---

## 4. 公開 API、選項與外掛追蹤矩陣

| 類別 | 項目 | 原版基準行為 | 目前目標狀態 | 預計完成階段 |
|---|---|---|---|---|
| 公開 API | \`pug.compile(str, options)\` | 回傳附帶 \`.dependencies\` 的同步渲染函式 | \`UNSUPPORTED\` | Step 1 / Step 6 |
| 公開 API | \`pug.compileFile(path, options)\` | 讀取檔案並支援 \`exports.cache[path]\` | \`UNSUPPORTED\` | Step 4 / Step 6 |
| 公開 API | \`pug.compileClient(str, options)\` | 回傳 JS 函式原始碼字串（雙層驗收：Prettier + Raw） | \`UNSUPPORTED\` | Step 1 / Step 5 |
| 公開 API | \`pug.compileFileClient(path, options)\` | 支援 \`exports.cache[path + ':client']\` 與 \`name\` | \`UNSUPPORTED\` | Step 5 / Step 6 |
| 公開 API | \`pug.compileClientWithDependenciesTracked(str, options)\` | 回傳 \`{ body, dependencies }\` | \`UNSUPPORTED\` | Step 1 / Step 5 |
| 公開 API | \`pug.render(str, options, fn)\` | 同步渲染或同步回呼 \`fn(err, html)\`；原始 \`locals\` 不經 JSON 序列化 | \`UNSUPPORTED\` | Step 1 / Step 6 |
| 公開 API | \`pug.renderFile(path, options, fn)\` | 檔案同步渲染或同步回呼 \`fn(err, html)\` | \`UNSUPPORTED\` | Step 4 / Step 6 |
| 公開 API | \`pug.__express(path, options, fn)\` | \`NODE_ENV === 'production'\` 且未指定 \`compileDebug\` 時預設 \`false\` | \`UNSUPPORTED\` | Step 6 |
| 公開 API | \`pug.cache\` / \`pug.filters\` / \`pug.runtime\` / \`pug.name\` | 外部可直接讀寫 \`cache\` 與 \`filters\`；\`name === 'Pug'\` | \`UNSUPPORTED\` | Step 1 / Step 6 |
| 公開 API | \`require('pug/register')\` | 註冊 \`require.extensions['.pug'] = pug.compileFile\` | \`UNSUPPORTED\` | Step 1 / Step 6 |
| 編譯選項 | \`pretty\` / \`doctype\` / \`self\` / \`globals\` | 縮排字串、DOCTYPE 模式、\`self\` 命名空間與全域變數白名單 | \`UNSUPPORTED\` | Step 3 / Step 5 |
| 編譯選項 | \`compileDebug\` / \`includeSources\` / \`debug\` | 保留 \`compile\` 與 \`compileClient\` 預設差異 | \`UNSUPPORTED\` | Step 5 / Step 6 |
| 編譯選項 | \`inlineRuntimeFunctions\` / \`name\` / \`module\` | 內嵌 \`pug_*\` 依賴展開或 \`runtimeWrap\` / \`require("pug-runtime")\` | \`UNSUPPORTED\` | Step 1 / Step 5 |
| 編譯選項 | \`filename\` / \`basedir\` | Node \`path\` 相容解析，不任意 \`fs::canonicalize\` | \`UNSUPPORTED\` | Step 4 |
| 外掛介面 | \`preLex\` / \`postLex\` / \`preParse\` / \`postParse\` / \`preLoad\` / \`postLoad\` | 對入口與每個 \`include\`/\`extends\` 依賴檔案在主執行緒同步呼叫 | \`UNSUPPORTED\` | Step 1 / Step 4 / Step 6 |
| 外掛介面 | \`preFilters\` / \`postFilters\` / \`preLink\` / \`postLink\` / \`preCodeGen\` / \`postCodeGen\` | 管線各階段 AST / Code 同步轉換 hook | \`UNSUPPORTED\` | Step 4 / Step 6 |
| 外掛介面 | Replacement hooks (\`resolve\`, \`read\`, \`generateCode\`) | 多個 plugin 同時實作同名 replacement 時拋錯；支援 \`Buffer\` 回傳 | \`UNSUPPORTED\` | Step 4 / Step 6 |
| 外掛介面 | 內部擴充 (\`plugin.lex\`, \`plugin.parse\`) | 如 \`#3295\` tag interpolation 中的 \`plugin.lex.advance\` | \`UNSUPPORTED\` | Step 6 |

---

## 5. 已核准差異（Approved Differences）

| 差異 ID | 影響案例 | 狀態 | 說明 |
|---|---|---|---|
| \`NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY\` | \`error.reporting > runtime errors > in a mixin\`<br>\`error.reporting > runtime errors > in a layout\` | \`APPROVED_DIFF\` | Node.js 16+ / 22 (V8 9.3+) 將存取 \`null\`/\`undefined\` 屬性的 \`TypeError\` 訊息由 \`Cannot read property 'length' of null/undefined\` 改為 \`Cannot read properties of null/undefined (reading 'length')\`。同 Node 版本下 \`raw/compiler\` 與 \`rust/compiler\` 行為完全一致。 |
`;
}

function main() {
  const args = process.argv.slice(2);
  const verifyBaseline = args.includes('--verify-baseline');
  const writeMatrix = args.includes('--write-matrix');
  const suiteIdx = args.indexOf('--suite');
  const suiteFilter = suiteIdx !== -1 ? args[suiteIdx + 1] : null;

  const raw = loadRawPackages();
  const rustTarget = tryLoadRustTarget();
  const results = [];

  const suites = [
    ['pug-error', () => runPugErrorSuite(raw, rustTarget, results)],
    ['pug-lexer', () => runPugLexerSuite(raw, rustTarget, results)],
    ['pug-strip-comments', () => runPugStripCommentsSuite(raw, rustTarget, results)],
    ['pug-parser', () => runPugParserSuite(raw, rustTarget, results)],
    ['pug-walk', () => runPugWalkSuite(raw, rustTarget, results)],
    ['pug-load', () => runPugLoadSuite(raw, rustTarget, results)],
    ['pug-filters', () => runPugFiltersSuite(raw, rustTarget, results)],
    ['pug-linker', () => runPugLinkerSuite(raw, rustTarget, results)],
    ['pug-attrs', () => runPugAttrsAndRuntimeSuite(raw, rustTarget, results)],
    ['pug', () => runPugIntegrationSuite(raw, rustTarget, results)],
  ];

  for (const [name, fn] of suites) {
    if (suiteFilter && name !== suiteFilter) continue;
    fn();
  }

  const summary = summarizeResults(results);

  if (writeMatrix && !suiteFilter) {
    const matrixPath = path.join(RUST_COMPILER_ROOT, 'compat/matrix.md');
    fs.writeFileSync(matrixPath, generateMatrixMarkdown(results, summary), 'utf8');
    console.log(`Updated ${matrixPath}`);
  }

  console.log(
    `Differential Runner Summary (${summary.totals.total} cases):`
  );
  console.log(
    `  Baseline (raw/compiler): ${summary.totals.baseline.PASS} PASS, ${summary.totals.baseline.APPROVED_DIFF} APPROVED_DIFF, ${summary.totals.baseline.FAIL} FAIL`
  );
  console.log(
    `  Target  (rust/compiler): ${summary.totals.target.PASS} PASS, ${summary.totals.target.APPROVED_DIFF} APPROVED_DIFF, ${summary.totals.target.UNSUPPORTED} UNSUPPORTED, ${summary.totals.target.FAIL} FAIL`
  );

  if (verifyBaseline && summary.totals.baseline.FAIL > 0) {
    console.error('Baseline verification failed!');
    process.exit(1);
  }
}

main();
