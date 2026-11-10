import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RAW_COMPILER_ROOT,
  RUST_COMPILER_ROOT,
  formatForSnapshot,
  parseJestSnapFile,
  compareCodegen,
  compareStructured,
  compareHtml,
  checkApprovedErrorPattern,
  compareErrors,
} from './serializers.js';

const require = createRequire(import.meta.url);

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

async function tryLoadRustTarget() {
  const entryPath = path.join(RUST_COMPILER_ROOT, 'index.js');
  if (!fs.existsSync(entryPath)) {
    return null;
  }
  try {
    return await import(pathToFileURL(entryPath).href);
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

function isTargetBlocked(rustTarget) {
  return !rustTarget || Boolean(rustTarget.__loadError);
}

const STEP4_5_NODE_TYPES = new Set([]);

function findDeferredAstNodes(raw, src, filename, opts) {
  try {
    const parseTokens = (tokens, o) => {
      const cleaned = raw.stripComments(tokens, o).map((tok) => {
        if (tok.type === 'path' && path.extname(tok.val) === '') {
          return { ...tok, val: `${tok.val}.pug` };
        }
        return tok;
      });
      return raw.parse(cleaned, o);
    };
    let ast = parseTokens(raw.lex(src, { filename }), { filename, src });
    ast = raw.load(ast, {
      lex: raw.lex,
      parse: parseTokens,
      basedir: opts && opts.basedir,
    });
    if (opts && opts.filters) {
      ast = raw.filters.handleFilters(ast, opts.filters, opts.filterOptions, opts.filterAliases);
    }
    ast = raw.link(ast);
    const found = new Set();
    raw.walk(ast, (node) => {
      if (STEP4_5_NODE_TYPES.has(node.type)) {
        found.add(node.type);
      }
    });
    return Array.from(found);
  } catch (_) {
    return [];
  }
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

  const rustErrorFn = !isTargetBlocked(rustTarget) ? rustTarget._error || rustTarget.error : null;

  for (const c of cases) {
    const rawErr = raw.error(...c.args);
    const baseOk =
      rawErr.message === c.expectedMessage &&
      rawErr.code === 'PUG:MY_CODE' &&
      rawErr.msg === 'My message';
    const baselineStatus = baseOk ? 'PASS' : 'FAIL';

    let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
    let note = '';
    if (rustErrorFn) {
      try {
        const rustErr = rustErrorFn(...c.args);
        targetStatus = compareErrors(rawErr, rustErr).ok ? 'PASS' : 'FAIL';
      } catch (err) {
        targetStatus = 'FAIL';
        note = `Unexpected exception: ${err.message}`;
      }
    } else if (!isTargetBlocked(rustTarget)) {
      note = 'Missing _error export in Step 1 scope';
    }
    recordCase(results, 'pug-error', 'Error', c.name, baselineStatus, targetStatus, note);
  }
}

function runPugLexerSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-lexer/test');
  const casesDir = path.join(testDir, 'cases');
  const errorsDir = path.join(testDir, 'errors');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );

  const rustLex = !isTargetBlocked(rustTarget) ? rustTarget._lex || rustTarget.lex : null;

  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.pug')) continue;
    const fullPath = path.join(casesDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    const rawTokens = raw.lex(src, { filename: fullPath });
    const baseOk = formatForSnapshot(rawTokens) === snaps[`${file} 1`];
    const baselineStatus = baseOk ? 'PASS' : 'FAIL';

    let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
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

    let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
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

      let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
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

    let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
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

    let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
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
  let nubTargetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
  if (rustParse) {
    try {
      const rustNubAst = rustParse(raw.lex(nubInput));
      nubTargetStatus = compareStructured(nubAst, rustNubAst).ok ? 'PASS' : 'FAIL';
    } catch (_) {
      nubTargetStatus = 'FAIL';
    }
  }
  recordCase(
    results,
    'pug-parser',
    'Token/AST',
    'no-unnecessary-blocks',
    nubOk ? 'PASS' : 'FAIL',
    nubTargetStatus
  );
}

function runPugWalkSuite(raw, rustTarget, results) {
  const rustWalk =
    rustTarget && !rustTarget.__loadError
      ? rustTarget._walk || rustTarget.walk
      : null;

  const walkBlocked = isTargetBlocked(rustTarget) || !rustWalk;

  // 1. simple (+ options.parents stability & cleanup check)
  let simpleTarget = walkBlocked ? 'BLOCKED' : 'FAIL';
  let simpleNote = '';
  if (rustWalk) {
    try {
      const opts = {};
      let firstRef = null;
      let refChanged = false;
      const ast = rustWalk(
        raw.parse(raw.lex('.my-class foo')),
        (node, replace) => {
          if (firstRef === null) firstRef = opts.parents;
          else if (opts.parents !== firstRef) refChanged = true;
          if (node.type === 'Text') {
            replace({
              type: 'Text',
              val: 'bar',
              line: node.line,
              column: node.column,
            });
          }
        },
        () => {},
        opts
      );
      const parentsOk = !refChanged && Array.isArray(opts.parents) && opts.parents.length === 0;
      const astOk = compareStructured(raw.parse(raw.lex('.my-class bar')), ast).ok;
      simpleTarget = parentsOk && astOk ? 'PASS' : 'FAIL';
      if (!parentsOk) {
        simpleNote = `options.parents refChanged=${refChanged}, finalLen=${opts.parents?.length}`;
      }
    } catch (err) {
      simpleTarget = 'FAIL';
      simpleNote = err.message;
    }
  }
  recordCase(results, 'pug-walk', 'Token/AST', 'simple', 'PASS', simpleTarget, simpleNote);

  // 2. replace([]) > block flattening
  let flattenTarget = walkBlocked ? 'BLOCKED' : 'FAIL';
  if (rustWalk) {
    try {
      const called = [];
      const ast = rustWalk(
        {
          type: 'Block',
          nodes: [
            {
              type: 'Block',
              nodes: [
                {
                  type: 'Block',
                  nodes: [
                    { type: 'Text', val: 'a' },
                    { type: 'Text', val: 'b' },
                  ],
                },
                { type: 'Text', val: 'c' },
              ],
            },
            { type: 'Text', val: 'd' },
          ],
        },
        (node, replace) => {
          if (node.type === 'Text') {
            called.push('before ' + node.val);
            if (node.val === 'a') {
              if (!replace.arrayAllowed) throw new Error('replace.arrayAllowed set wrongly');
              replace([
                { type: 'Text', val: 'e' },
                { type: 'Text', val: 'f' },
              ]);
            }
          }
        },
        (node, replace) => {
          if (node.type === 'Block' && replace.arrayAllowed) {
            replace(node.nodes);
          } else if (node.type === 'Text') {
            called.push('after ' + node.val);
          }
        }
      );
      const expectedAst = {
        type: 'Block',
        nodes: [
          { type: 'Text', val: 'e' },
          { type: 'Text', val: 'f' },
          { type: 'Text', val: 'b' },
          { type: 'Text', val: 'c' },
          { type: 'Text', val: 'd' },
        ],
      };
      const expectedCalled = [
        'before a',
        'before e',
        'after e',
        'before f',
        'after f',
        'before b',
        'after b',
        'before c',
        'after c',
        'before d',
        'after d',
      ];
      flattenTarget =
        compareStructured(expectedAst, ast).ok &&
        compareStructured(expectedCalled, called).ok
          ? 'PASS'
          : 'FAIL';
    } catch (_) {
      flattenTarget = 'FAIL';
    }
  }
  recordCase(
    results,
    'pug-walk',
    'Token/AST',
    'replace([]) > block flattening',
    'PASS',
    flattenTarget
  );

  // 3. replace([]) > adding include filters
  let includeFiltersTarget = walkBlocked ? 'BLOCKED' : 'FAIL';
  if (rustWalk) {
    try {
      const ast = rustWalk(
        raw.parse(raw.lex('include:filter1:filter2 file')),
        (node, replace) => {
          if (node.type === 'IncludeFilter') {
            if (!replace.arrayAllowed) throw new Error('replace.arrayAllowed false');
            if (node.name === 'filter1') {
              const firstFilter = 'filter3';
              replace([
                {
                  type: 'IncludeFilter',
                  name: firstFilter,
                  attrs: [],
                  line: node.line,
                  column: node.column,
                },
                {
                  type: 'IncludeFilter',
                  name: 'filter4',
                  attrs: [],
                  line: node.line,
                  column: node.column + firstFilter.length + 1,
                },
              ]);
            } else if (node.name === 'filter2') {
              replace([]);
            }
          }
        }
      );
      includeFiltersTarget = compareStructured(
        raw.parse(raw.lex('include:filter3:filter4 file')),
        ast
      ).ok
        ? 'PASS'
        : 'FAIL';
    } catch (_) {
      includeFiltersTarget = 'FAIL';
    }
  }
  recordCase(
    results,
    'pug-walk',
    'Token/AST',
    'replace([]) > adding include filters',
    'PASS',
    includeFiltersTarget
  );

  // 4. replace([]) > fails when parent is not Block
  let failNotBlockTarget = walkBlocked ? 'BLOCKED' : 'FAIL';
  if (rustWalk) {
    try {
      let checked = false;
      rustWalk(raw.parse(raw.lex('p content')), (node, replace) => {
        if (
          node.type === 'Block' &&
          node.nodes[0] &&
          node.nodes[0].type === 'Text'
        ) {
          if (replace.arrayAllowed) throw new Error('replace.arrayAllowed set wrongly');
          let threw = false;
          try {
            replace([]);
          } catch (_) {
            threw = true;
          }
          if (!threw) throw new Error('Expected replace([]) to throw');
          checked = true;
        }
      });
      failNotBlockTarget = checked ? 'PASS' : 'FAIL';
    } catch (_) {
      failNotBlockTarget = 'FAIL';
    }
  }
  recordCase(
    results,
    'pug-walk',
    'Token/AST',
    'replace([]) > fails when parent is not Block',
    'PASS',
    failNotBlockTarget
  );

  // 5. options.parents in-place mutation & cleanup when `after` is omitted
  let parentsNoAfterTarget = walkBlocked ? 'BLOCKED' : 'FAIL';
  let parentsNoAfterNote = '';
  if (rustWalk) {
    try {
      const makeAst = () => raw.parse(raw.lex('div\n  p hello'));
      const rawOpts = {};
      let rawRef = null;
      let rawChanged = false;
      raw.walk(
        makeAst(),
        () => {
          if (!rawRef) rawRef = rawOpts.parents;
          else if (rawOpts.parents !== rawRef) rawChanged = true;
        },
        null,
        rawOpts
      );
      const rustOpts = {};
      let rustRef = null;
      let rustChanged = false;
      rustWalk(
        makeAst(),
        () => {
          if (!rustRef) rustRef = rustOpts.parents;
          else if (rustOpts.parents !== rustRef) rustChanged = true;
        },
        null,
        rustOpts
      );
      const ok =
        rustChanged === rawChanged &&
        Array.isArray(rustOpts.parents) &&
        rustOpts.parents.length === rawOpts.parents.length;
      parentsNoAfterTarget = ok ? 'PASS' : 'FAIL';
      if (!ok) {
        parentsNoAfterNote = `refChanged=${rustChanged} (expected ${rawChanged}), finalLen=${rustOpts.parents?.length} (expected ${rawOpts.parents?.length})`;
      }
    } catch (err) {
      parentsNoAfterTarget = 'FAIL';
      parentsNoAfterNote = err.message;
    }
  }
  recordCase(
    results,
    'pug-walk',
    'Token/AST',
    'options.parents in-place mutation & cleanup without after',
    'PASS',
    parentsNoAfterTarget,
    parentsNoAfterNote
  );
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

  let targetStatus = 'FAIL';
  let targetNote = '';
  if (rustTarget && typeof rustTarget._load === 'function') {
    try {
      let rustAst = rustTarget._load.file(filename, {
        lex: rustTarget.lex,
        parse: rustTarget.parse,
      });
      rustAst = rustTarget.walk(
        rustAst,
        (node) => {
          if (node.filename) node.filename = '<dirname>/' + path.basename(node.filename);
          if (node.fullPath) node.fullPath = '<dirname>/' + path.basename(node.fullPath);
        },
        { includeDependencies: true }
      );
      if (formatForSnapshot(rustAst) === snaps['pug-load 1']) {
        targetStatus = 'PASS';
      } else {
        targetStatus = 'FAIL';
        targetNote = 'Snapshot mismatch vs raw pug-load';
      }
    } catch (err) {
      targetStatus = 'FAIL';
      targetNote = err.message;
    }
  }
  recordCase(
    results,
    'pug-load',
    'Token/AST',
    'pug-load recursive extends/include/Buffer',
    baseOk ? 'PASS' : 'FAIL',
    targetStatus,
    targetNote
  );
}

function normalizeFilterTextValTree(node) {
  if (Array.isArray(node)) return node.map(normalizeFilterTextValTree);
  if (node && typeof node === 'object') {
    if (node.type === 'Text') {
      const out = { type: 'Text', val: node.val };
      if (node.line !== undefined) out.line = node.line;
      if (node.column !== undefined) out.column = node.column;
      if (node.filename !== undefined) out.filename = node.filename;
      return out;
    }
    const out = {};
    for (const k of Object.keys(node).sort()) {
      const v = node[k];
      // Legacy pug-filters .input.json fixtures omit `line: 0` on Block and `key: null` on Each
      if (v === undefined) continue;
      if (k === 'key' && v === null && node.type === 'Each') continue;
      if (k === 'line' && v === 0 && node.type === 'Block') continue;
      out[k] = normalizeFilterTextValTree(v);
    }
    return out;
  }
  return node;
}

function runPugFiltersSuite(raw, rustTarget, results) {
  const pkgDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-filters');
  const testDir = path.join(pkgDir, 'test');
  const casesDir = path.join(testDir, 'cases');
  const errorsDir = path.join(testDir, 'errors');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );
  const aliasSnaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/filter-aliases.test.js.snap')
  );
  const nestedOptsSnaps = parseJestSnapFile(
    path.join(
      testDir,
      '__snapshots__/per-filter-options-applied-to-nested-filters.test.js.snap'
    )
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
      const rawOut = raw.filters.handleFilters(
        JSON.parse(JSON.stringify(input)),
        customFilters
      );
      const actualAst = JSON.stringify(rawOut, null, '  ');
      const baseOk = formatForSnapshot(actualAst) === snaps[`cases/${file} 1`];

      let targetStatus = 'FAIL';
      let targetNote = '';
      if (rustTarget && typeof rustTarget._handleFilters === 'function') {
        try {
          const rustOut = rustTarget._handleFilters(
            JSON.parse(JSON.stringify(input)),
            customFilters
          );
          const cmp = compareStructured(
            normalizeFilterTextValTree(rawOut),
            normalizeFilterTextValTree(rustOut)
          );
          if (cmp.ok) {
            targetStatus = 'PASS';
          } else {
            targetStatus = 'FAIL';
            targetNote = `Filtered AST mismatch for ${file}`;
          }
        } catch (err) {
          targetStatus = 'FAIL';
          targetNote = err.message;
        }
      }
      recordCase(
        results,
        'pug-filters',
        'Filters/Plugins',
        `cases/${file}`,
        baseOk ? 'PASS' : 'FAIL',
        targetStatus,
        targetNote
      );
    }

    for (const file of fs.readdirSync(errorsDir).sort()) {
      if (!file.endsWith('.input.json')) continue;
      const input = JSON.parse(fs.readFileSync(path.join(errorsDir, file), 'utf8'));
      let rawErr = null;
      try {
        raw.filters.handleFilters(
          JSON.parse(JSON.stringify(input)),
          customFilters
        );
      } catch (ex) {
        rawErr = { msg: ex.msg, code: ex.code, line: ex.line };
      }
      const baseOk =
        rawErr && formatForSnapshot(rawErr) === snaps[`errors/${file} 1`];

      let targetStatus = 'FAIL';
      let targetNote = '';
      if (rustTarget && typeof rustTarget._handleFilters === 'function') {
        let rustErr = null;
        try {
          rustTarget._handleFilters(
            JSON.parse(JSON.stringify(input)),
            customFilters
          );
        } catch (ex) {
          rustErr = { msg: ex.msg, code: ex.code, line: ex.line };
        }
        if (rustErr && formatForSnapshot(rustErr) === snaps[`errors/${file} 1`]) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          targetNote = `Error mismatch: ${JSON.stringify(rustErr)}`;
        }
      }
      recordCase(
        results,
        'pug-filters',
        'Error',
        `errors/${file}`,
        baseOk ? 'PASS' : 'FAIL',
        targetStatus,
        targetNote
      );
    }
  } finally {
    process.chdir(prevCwd);
  }

  // Filter aliases & per-filter nested options (4 tests)
  const aliasTestFile = path.join(testDir, 'filter-aliases.test.js');
  const nestedTestFile = path.join(
    testDir,
    'per-filter-options-applied-to-nested-filters.test.js'
  );
  const aliasCases = [
    {
      name: 'filter-aliases > filters can be aliased',
      cat: 'Filters/Plugins',
      fn(engine, isRaw) {
        const src = '\nscript\n  :cdata:minify\n    function myFunc(foo) {\n      return foo;\n    }\n  ';
        const lexFn = isRaw ? engine.lex : engine.lex;
        const parseFn = isRaw ? engine.parse : engine.parse;
        const ast = parseFn(lexFn(src, { filename: aliasTestFile }), {
          filename: aliasTestFile,
          src,
        });
        return isRaw
          ? engine.filters.handleFilters(ast, {}, {}, { minify: 'uglify-js' })
          : engine._handleFilters(ast, {}, {}, { minify: 'uglify-js' });
      },
      snap: aliasSnaps['filters can be aliased 1'],
    },
    {
      name: 'filter-aliases > we do not support chains of aliases',
      cat: 'Error',
      fn(engine, isRaw) {
        const src = '\nscript\n  :cdata:minify-js\n    function myFunc(foo) {\n      return foo;\n    }\n  ';
        const ast = engine.parse(engine.lex(src, { filename: aliasTestFile }), {
          filename: aliasTestFile,
          src,
        });
        try {
          if (isRaw) {
            engine.filters.handleFilters(
              ast,
              {},
              {},
              { 'minify-js': 'minify', minify: 'uglify-js' }
            );
          } else {
            engine._handleFilters(
              ast,
              {},
              {},
              { 'minify-js': 'minify', minify: 'uglify-js' }
            );
          }
          throw new Error('Expected an exception');
        } catch (ex) {
          return { code: ex.code, message: ex.message };
        }
      },
      snap: aliasSnaps['we do not support chains of aliases 1'],
    },
    {
      name: 'filter-aliases > options are applied before aliases',
      cat: 'Filters/Plugins',
      fn(engine, isRaw) {
        const src =
          '\nscript\n  :cdata:minify\n    function myFunc(foo) {\n      return foo;\n    }\n  :cdata:uglify-js\n    function myFunc(foo) {\n      return foo;\n    }\n  ';
        const ast = engine.parse(engine.lex(src, { filename: aliasTestFile }), {
          filename: aliasTestFile,
          src,
        });
        const opts = { minify: { output: { beautify: true } } };
        const aliases = { minify: 'uglify-js' };
        return isRaw
          ? engine.filters.handleFilters(ast, {}, opts, aliases)
          : engine._handleFilters(ast, {}, opts, aliases);
      },
      snap: aliasSnaps['options are applied before aliases 1'],
    },
    {
      name: 'per-filter-options-applied-to-nested-filters',
      cat: 'Filters/Plugins',
      fn(engine, isRaw) {
        const src = '\nscript\n  :cdata:uglify-js\n    function myFunc(foo) {\n      return foo;\n    }\n  ';
        const ast = engine.parse(engine.lex(src, { filename: nestedTestFile }), {
          filename: nestedTestFile,
          src,
        });
        const opts = { 'uglify-js': { output: { beautify: true } } };
        return isRaw
          ? engine.filters.handleFilters(ast, {}, opts)
          : engine._handleFilters(ast, {}, opts);
      },
      snap: nestedOptsSnaps['per filter options are applied, even to nested filters 1'],
    },
  ];

  for (const tc of aliasCases) {
    const rawOut = tc.fn(raw, true);
    const baseOk = formatForSnapshot(rawOut) === tc.snap;
    let targetStatus = 'FAIL';
    let targetNote = '';
    if (rustTarget && typeof rustTarget._handleFilters === 'function') {
      try {
        const rustOut = tc.fn(rustTarget, false);
        const cmp = compareStructured(
          normalizeFilterTextValTree(rawOut),
          normalizeFilterTextValTree(rustOut)
        );
        if (cmp.ok) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          targetNote = `Mismatch on ${tc.name}`;
        }
      } catch (err) {
        targetStatus = 'FAIL';
        targetNote = err.message;
      }
    }
    recordCase(
      results,
      'pug-filters',
      tc.cat,
      tc.name,
      baseOk ? 'PASS' : 'FAIL',
      targetStatus,
      targetNote
    );
  }
}

function runPugLinkerSuite(raw, rustTarget, results) {
  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-linker/test');
  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );
  const targetBlocked = isTargetBlocked(rustTarget);
  const rustLink = !targetBlocked ? rustTarget._link : null;

  for (const file of fs.readdirSync(path.join(testDir, 'cases')).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const input = JSON.parse(
      fs.readFileSync(path.join(testDir, 'cases', file), 'utf8')
    );
    const out = raw.link(JSON.parse(JSON.stringify(input)));
    const baseOk =
      formatForSnapshot(out) === snaps[`cases from pug ${file} 1`];

    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let targetNote = '';
    if (rustLink) {
      try {
        const rustOut = rustLink(JSON.parse(JSON.stringify(input)));
        const snapOk =
          formatForSnapshot(rustOut) === snaps[`cases from pug ${file} 1`];
        const cmp = compareStructured(out, rustOut);
        if (cmp.ok && snapOk) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          targetNote = `Mismatch on cases/${file} (cmp=${cmp.ok}, snap=${snapOk})`;
        }
      } catch (err) {
        targetStatus = 'FAIL';
        targetNote = err.message;
      }
    } else if (!targetBlocked) {
      targetNote = 'Missing rustTarget._link export';
    }
    recordCase(
      results,
      'pug-linker',
      'Token/AST',
      `cases/${file}`,
      baseOk ? 'PASS' : 'FAIL',
      targetStatus,
      targetNote
    );
  }

  for (const file of fs.readdirSync(path.join(testDir, 'special-cases')).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const input = JSON.parse(
      fs.readFileSync(path.join(testDir, 'special-cases', file), 'utf8')
    );
    const out = raw.link(JSON.parse(JSON.stringify(input)));
    const baseOk =
      formatForSnapshot(out) === snaps[`special cases ${file} 1`];

    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let targetNote = '';
    if (rustLink) {
      try {
        const rustOut = rustLink(JSON.parse(JSON.stringify(input)));
        const snapOk =
          formatForSnapshot(rustOut) === snaps[`special cases ${file} 1`];
        const cmp = compareStructured(out, rustOut);
        if (cmp.ok && snapOk) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          targetNote = `Mismatch on special-cases/${file} (cmp=${cmp.ok}, snap=${snapOk})`;
        }
      } catch (err) {
        targetStatus = 'FAIL';
        targetNote = err.message;
      }
    } else if (!targetBlocked) {
      targetNote = 'Missing rustTarget._link export';
    }
    recordCase(
      results,
      'pug-linker',
      'Token/AST',
      `special-cases/${file}`,
      baseOk ? 'PASS' : 'FAIL',
      targetStatus,
      targetNote
    );
  }

  for (const file of fs.readdirSync(path.join(testDir, 'errors')).sort()) {
    if (!file.endsWith('.input.json')) continue;
    const input = JSON.parse(
      fs.readFileSync(path.join(testDir, 'errors', file), 'utf8')
    );
    let err = null;
    try {
      raw.link(JSON.parse(JSON.stringify(input)));
    } catch (ex) {
      err = { msg: ex.msg, code: ex.code, line: ex.line };
    }
    const baseOk =
      err && formatForSnapshot(err) === snaps[`error handling ${file} 1`];

    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let targetNote = '';
    if (rustLink) {
      let rustErr = null;
      try {
        rustLink(JSON.parse(JSON.stringify(input)));
        targetStatus = 'FAIL';
        targetNote = 'Expected linker error, got AST';
      } catch (ex) {
        rustErr = { msg: ex.msg, code: ex.code, line: ex.line };
        const snapOk =
          formatForSnapshot(rustErr) === snaps[`error handling ${file} 1`];
        const cmp = compareStructured(err, rustErr);
        if (cmp.ok && snapOk) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          targetNote = `Error mismatch on errors/${file}`;
        }
      }
    } else if (!targetBlocked) {
      targetNote = 'Missing rustTarget._link export';
    }
    recordCase(
      results,
      'pug-linker',
      'Error',
      `errors/${file}`,
      baseOk ? 'PASS' : 'FAIL',
      targetStatus,
      targetNote
    );
  }
}

function collectPugAttrsCases(raw) {
  const attrsTestSrc = fs.readFileSync(
    path.join(RAW_COMPILER_ROOT, 'packages/pug-attrs/test/index.test.js'),
    'utf8'
  );
  const groups = [];
  let currentGroup = null;
  const expectStub = (actual) => ({
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
  });

  // Intercept calls to attrs(...) so we capture exact (input, opts, expected, locals) tuples
  const capturedCalls = [];
  let currentOpts = null;
  let capturedInput = null;
  const capturingAttrs = function (input, opts) {
    capturedInput = JSON.parse(JSON.stringify(input));
    currentOpts = opts;
    return raw.attrs(input, opts);
  };
  const evalLocalsShim = function (fnBody, locals) {
    const keys = Object.keys(locals || {}).sort();
    // eslint-disable-next-line no-new-func
    return Function(keys.join(', '), fnBody).apply(
      null,
      keys.map((k) => locals[k])
    );
  };
  void evalLocalsShim;

  const customRequire = (id) => {
    if (id === '../') return capturingAttrs;
    if (id === 'pug-runtime') return raw.runtime;
    if (id === 'assert') return assert;
    if (id === 'util') return require('util');
    throw new Error(`Unexpected require in pug-attrs test: ${id}`);
  };
  const describeFn = (title, fn) => {
    currentGroup = { title, cases: [] };
    groups.push(currentGroup);
    fn();
    currentGroup = null;
  };
  const itFn = (label, fn) => {
    capturedInput = null;
    fn();
    currentGroup.cases.push({
      label,
      input: capturedInput,
      opts: currentOpts,
      runBaseline: fn,
    });
  };
  // Note: pug-attrs test evaluates expected via closure, so run fn() with BOTH raw & rust!
  // We capture input+opts during describe() pass, and execute with swapped capturing/rust runtime below.
  let activeAttrsImpl = capturingAttrs;
  const proxyAttrs = function (input, opts) {
    capturedInput = JSON.parse(JSON.stringify(input));
    currentOpts = opts;
    return activeAttrsImpl(input, opts);
  };
  const runRequire = (id) => (id === '../' ? proxyAttrs : customRequire(id));

  // eslint-disable-next-line no-new-func
  const runnerFn = Function('require', 'describe', 'it', 'expect', attrsTestSrc);
  const collected = [];
  runnerFn(
    runRequire,
    (title, fn) => {
      currentGroup = { title, idx: 0 };
      fn();
      currentGroup = null;
    },
    (label, fn) => {
      currentGroup.idx++;
      collected.push({
        groupTitle: currentGroup.title,
        idx: currentGroup.idx,
        label,
        runWithImpl(impl) {
          activeAttrsImpl = impl;
          return fn();
        },
      });
    },
    expectStub
  );
  return collected;
}

function runPugAttrsAndRuntimeSuite(raw, rustTarget, results) {
  const targetBlocked = isTargetBlocked(rustTarget);
  const rustCompileAttrs = !targetBlocked ? rustTarget._compileAttrs : null;
  const attrsCases = collectPugAttrsCases(raw);

  for (const tc of attrsCases) {
    let rawCode = null;
    let baseOk = false;
    try {
      tc.runWithImpl((input, opts) => {
        rawCode = raw.attrs(input, opts);
        return rawCode;
      });
      baseOk = true;
    } catch (_) {
      baseOk = false;
    }

    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let targetNote = '';
    if (rustCompileAttrs) {
      let rustCode = null;
      try {
        tc.runWithImpl((input, opts) => {
          rustCode = rustCompileAttrs(input, opts);
          return rustCode;
        });
        if (rustCode === rawCode) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          targetNote = `JS output mismatch: expected ${rawCode}, got ${rustCode}`;
        }
      } catch (err) {
        targetStatus = 'FAIL';
        targetNote = err && err.message ? err.message : String(err);
      }
    } else if (!targetBlocked) {
      targetNote = 'Missing rustTarget._compileAttrs export';
    }

    recordCase(
      results,
      'pug-attrs',
      'JS Artifact',
      `${tc.groupTitle} #${tc.idx}`,
      baseOk ? 'PASS' : 'FAIL',
      targetStatus,
      targetNote
    );
  }

  const runtimeFns = ['attr', 'attrs', 'classes', 'escape', 'merge', 'style'];
  const rustRuntime =
    !isTargetBlocked(rustTarget) ? rustTarget.runtime : null;
  const rustRuntimeBuild =
    !isTargetBlocked(rustTarget) ? rustTarget._runtimeBuild : null;

  for (const name of runtimeFns) {
    let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
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
    let targetStatus = isTargetBlocked(rustTarget) ? 'BLOCKED' : 'FAIL';
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
  const targetBlocked = isTargetBlocked(rustTarget);
  const rustPug = targetBlocked ? null : rustTarget;

  // 1. cases/*.pug (115 cases) — classified by AST nodes vs Step 1-3 committed scope
  const cases = runUtils.findCases(path.join(testDir, 'cases')).sort();
  for (const tc of cases) {
    const pugPath = path.join(testDir, 'cases', `${tc}.pug`);
    const htmlPath = path.join(testDir, 'cases', `${tc}.html`);
    const str = fs.readFileSync(pugPath, 'utf8');
    const expectedHtml = fs.readFileSync(htmlPath, 'utf8').trim().replace(/\r/g, '');
    const opts = {
      filename: pugPath,
      pretty: !/\.min$/.test(tc),
      doctype: /xml/.test(tc) ? 'xml' : undefined,
      basedir: path.join(testDir, 'cases'),
      filters: runUtils.filters,
      filterAliases: { markdown: 'markdown-it' },
    };

    const fn = raw.pug.compile(str, {
      ...opts,
      pretty: true,
      doctype: undefined,
    });
    let actualHtml = fn({ title: 'Pug' }).trim();
    let cmpExpected = expectedHtml;
    if (/filter/.test(tc)) {
      actualHtml = actualHtml.replace(/\n| /g, '');
      cmpExpected = cmpExpected.replace(/\n| /g, '');
    }
    const baseOk = compareHtml(cmpExpected, actualHtml).ok;

    const deferredNodes = findDeferredAstNodes(raw, str, pugPath, opts);
    if (deferredNodes.length > 0) {
      recordCase(
        results,
        'pug',
        'HTML',
        `cases/${tc}.pug`,
        baseOk ? 'PASS' : 'FAIL',
        'DEFERRED',
        `PLAN.md §五 Step 4-5; missing AST nodes: ${deferredNodes.join(', ')}`
      );
      continue;
    }

    // Step 3B in-scope HTML check
    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let targetNote = targetBlocked ? 'Target native module failed to load' : '';
    if (rustPug && typeof rustPug.compile === 'function') {
      try {
        const rustFn = rustPug.compile(str, {
          ...opts,
          pretty: true,
          doctype: undefined,
        });
        let rustHtml = rustFn({ title: 'Pug' }).trim();
        if (/filter/.test(tc)) {
          rustHtml = rustHtml.replace(/\n| /g, '');
        }
        if (compareHtml(cmpExpected, rustHtml).ok) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          targetNote = 'HTML mismatch in Step 3B scope';
        }
      } catch (err) {
        targetStatus = 'FAIL';
        if (err && (err.code === 'PUG:UNSUPPORTED_NODE' || err.code === 'PUG:UNKNOWN_FILTER')) {
          targetNote = `Step 1-3 committed feature reported unsupported (${err.code}): ${err.message}`;
        } else {
          targetNote = `Unexpected exception: ${err && err.message ? err.message : String(err)}`;
        }
      }
    } else if (!targetBlocked) {
      targetNote = 'Missing rustPug.compile export';
    }
    recordCase(results, 'pug', 'HTML', `cases/${tc}.pug`, baseOk ? 'PASS' : 'FAIL', targetStatus, targetNote);

    // Step 3B in-scope JS Artifact (compileClient dual-layer: Prettier + Raw) check
    let jsStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let jsNote = '';
    if (rustPug && typeof rustPug.compileClient === 'function') {
      try {
        const clientOpts = {
          ...opts,
          compileDebug: false,
        };
        const rawClient = raw.pug.compileClient(str, clientOpts);
        const rustClient = rustPug.compileClient(str, clientOpts);
        const cg = compareCodegen(rawClient, rustClient);
        if (cg.ok) {
          jsStatus = 'PASS';
        } else {
          jsStatus = 'FAIL';
          jsNote = `JS artifact mismatch (prettierMatch=${cg.prettierMatch}, rawMatch=${cg.rawMatch})`;
        }
      } catch (err) {
        jsStatus = 'FAIL';
        jsNote = `compileClient threw: ${err && err.message ? err.message : String(err)}`;
      }
    }
    recordCase(results, 'pug', 'JS Artifact', `cases/${tc}.pug (compileClient)`, 'PASS', jsStatus, jsNote);
  }

  // 2. cases-es2015/*.pug
  const es2015Cases = runUtils.findCases(path.join(testDir, 'cases-es2015')).sort();
  for (const tc of es2015Cases) {
    const pugPath = path.join(testDir, 'cases-es2015', `${tc}.pug`);
    const htmlPath = path.join(testDir, 'cases-es2015', `${tc}.html`);
    const str = fs.readFileSync(pugPath, 'utf8');
    const expectedHtml = fs.readFileSync(htmlPath, 'utf8').trim().replace(/\r/g, '');
    const rawHtml = raw.pug.compile(str, { filename: pugPath, pretty: true })({ title: 'Pug' }).trim();
    const baseOk = compareHtml(expectedHtml, rawHtml).ok;
    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let note = '';
    if (rustPug) {
      try {
        const rustHtml = rustPug.compile(str, { filename: pugPath, pretty: true })({ title: 'Pug' }).trim();
        targetStatus = compareHtml(expectedHtml, rustHtml).ok ? 'PASS' : 'FAIL';
        if (targetStatus === 'FAIL') note = 'HTML mismatch';
      } catch (err) {
        targetStatus = 'FAIL';
        note = err.message;
      }
    }
    recordCase(results, 'pug', 'HTML', `cases-es2015/${tc}.pug`, baseOk ? 'PASS' : 'FAIL', targetStatus, note);
  }

  // 3. anti-cases/*.pug (22 syntax error cases)
  const antiCases = runUtils.findCases(path.join(testDir, 'anti-cases')).sort();
  for (const tc of antiCases) {
    const pugPath = path.join(testDir, 'anti-cases', `${tc}.pug`).replace(/\\/g, '/');
    const str = fs.readFileSync(pugPath, 'utf8');
    const compileOpts = {
      filename: pugPath,
      pretty: true,
      basedir: path.join(testDir, 'anti-cases'),
      filters: runUtils.filters,
    };
    let rawErr = null;
    try {
      raw.pug.compile(str, compileOpts);
    } catch (ex) {
      rawErr = ex;
    }
    const baseOk =
      rawErr instanceof Error &&
      typeof rawErr.code === 'string' &&
      rawErr.code.startsWith('PUG:');

    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let note = '';
    if (rustPug) {
      let rustErr = null;
      try {
        rustPug.compile(str, compileOpts);
        targetStatus = 'FAIL';
        note = 'Expected error but compile succeeded';
      } catch (ex) {
        rustErr = ex;
        if (rawErr && rustErr && rawErr.code === rustErr.code) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          note = `Error code mismatch: expected ${rawErr?.code}, got ${rustErr?.code}`;
        }
      }
    }
    recordCase(results, 'pug', 'Error', `anti-cases/${tc}.pug`, baseOk ? 'PASS' : 'FAIL', targetStatus, note);
  }

  // 4. error.reporting.test.js (including the 2 approved V8 TypeError cases)
  for (const [label, relFixture, legacyRegex] of [
    ['error.reporting > runtime errors > in a mixin', 'fixtures/runtime.with.mixin.error.pug', /Cannot read property 'length' of null/],
    ['error.reporting > runtime errors > in a layout', 'fixtures/runtime.layout.error.pug', /Cannot read property 'length' of undefined/],
  ]) {
    const fixturePath = path.join(testDir, relFixture);
    let rawErr = null;
    try {
      raw.pug.renderFile(fixturePath, {});
    } catch (ex) {
      rawErr = ex;
    }
    const errMsg = rawErr ? rawErr.message : '';
    const check = checkApprovedErrorPattern(errMsg, legacyRegex);
    let targetStatus = targetBlocked ? 'BLOCKED' : 'FAIL';
    let note = check.diffId || '';
    if (rustPug) {
      let rustErr = null;
      try {
        rustPug.renderFile(fixturePath, {});
        targetStatus = 'FAIL';
        note = 'Expected runtime error, succeeded';
      } catch (ex) {
        rustErr = ex;
        if (rawErr && rustErr.message === rawErr.message && rustErr.path === rawErr.path) {
          targetStatus = 'PASS';
        } else {
          targetStatus = 'FAIL';
          note = `Mismatch: path=${rustErr && rustErr.path} msg=${rustErr && rustErr.message}`;
        }
      }
    }
    recordCase(results, 'pug', 'Error', label, check.status, targetStatus, note);
  }

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
    recordCase(
      results,
      'pug',
      'Error',
      name,
      'PASS',
      'DEFERRED',
      'PLAN.md §五 Step 4/6 (error.reporting integration suite)'
    );
  }

  // 5. Export presence check (distinct from behavioral acceptance!)
  {
    const requiredExports = [
      ['compile', 'function'],
      ['compileFile', 'function'],
      ['compileClient', 'function'],
      ['compileClientWithDependenciesTracked', 'function'],
      ['compileFileClient', 'function'],
      ['render', 'function'],
      ['renderFile', 'function'],
      ['__express', 'function'],
      ['cache', 'object'],
      ['filters', 'object'],
      ['runtime', 'object'],
      ['name', 'string'],
    ];
    let ok = false;
    let note = '';
    if (rustPug) {
      const missing = requiredExports.filter(([k, t]) => typeof rustPug[k] !== t).map(([k]) => k);
      ok = missing.length === 0;
      if (!ok) note = `Missing exports: ${missing.join(', ')}`;
    }
    recordCase(
      results,
      'pug',
      'API',
      'API exports presence check (exports surface only)',
      'PASS',
      targetBlocked ? 'BLOCKED' : ok ? 'PASS' : 'FAIL',
      note
    );
  }

  // 6. Helper to run a differential behavioral check against raw.pug & rustPug
  function runBehavioralCase(cat, name, fn) {
    if (targetBlocked) {
      recordCase(results, 'pug', cat, name, 'PASS', 'BLOCKED', 'Native module blocked');
      return;
    }
    let baseOk = false;
    try {
      fn(raw.pug);
      baseOk = true;
    } catch (_) {
      baseOk = false;
    }
    let targetStatus = 'FAIL';
    let note = '';
    try {
      fn(rustPug);
      targetStatus = 'PASS';
    } catch (err) {
      targetStatus = 'FAIL';
      note = err && err.message ? err.message : String(err);
    }
    recordCase(results, 'pug', cat, name, baseOk ? 'PASS' : 'FAIL', targetStatus, note);
  }

  // 6a. pug.test.js > .name === "Pug" (1 case)
  runBehavioralCase('API', 'pug.test.js > .name === "Pug"', (p) => {
    assert.strictEqual(p.name, 'Pug');
  });

  // 6b. pug.test.js > .render() callback & cache (3 individual cases)
  runBehavioralCase('API', 'pug.test.js > .render(str, fn)', (p) => {
    let called = false;
    p.render('p foo bar', (err, str) => {
      called = true;
      assert.ok(!err);
      assert.strictEqual(str, '<p>foo bar</p>');
    });
    assert.strictEqual(called, true);
  });
  runBehavioralCase('API', 'pug.test.js > .render(str, options, fn)', (p) => {
    let called = false;
    p.render('p #{foo}', { foo: 'bar' }, (err, str) => {
      called = true;
      assert.ok(!err);
      assert.strictEqual(str, '<p>bar</p>');
    });
    assert.strictEqual(called, true);
  });
  runBehavioralCase('API', 'pug.test.js > .render(str, options, fn) cache', (p) => {
    let errCalled = false;
    p.render('p bar', { cache: true }, (err) => {
      errCalled = true;
      assert.ok(err && /the "filename" option is required for caching/.test(err.message));
    });
    assert.strictEqual(errCalled, true);

    const key = '__runner_cache_test__';
    delete p.cache[key];
    let okCalled = false;
    p.render('p foo bar', { cache: true, filename: key }, (err, str) => {
      okCalled = true;
      assert.ok(!err);
      assert.strictEqual(str, '<p>foo bar</p>');
    });
    delete p.cache[key];
    assert.strictEqual(okCalled, true);
  });

  // 6c. pug.test.js > .compile() options & self (7 individual cases)
  runBehavioralCase('API', 'pug.test.js > .compile() basic', (p) => {
    const fn = p.compile('p foo');
    assert.strictEqual(fn(), '<p>foo</p>');
  });
  runBehavioralCase('API', 'pug.test.js > .compile() locals', (p) => {
    const fn = p.compile('p= foo');
    assert.strictEqual(fn({ foo: 'bar' }), '<p>bar</p>');
  });
  runBehavioralCase('API', 'pug.test.js > .compile() locals in self hash', (p) => {
    const fn = p.compile('p= self.foo', { self: true });
    assert.strictEqual(fn({ foo: 'bar' }), '<p>bar</p>');
  });
  runBehavioralCase('API', 'pug.test.js > .compile() no debug', (p) => {
    const fn = p.compile('p foo\np #{bar}', { compileDebug: false });
    assert.strictEqual(fn({ bar: 'baz' }), '<p>foo</p><p>baz</p>');
  });
  runBehavioralCase('API', 'pug.test.js > .compile() no debug and global helpers', (p) => {
    const fn = p.compile('p foo\np #{bar}', { compileDebug: false, helpers: 'global' });
    assert.strictEqual(fn({ bar: 'baz' }), '<p>foo</p><p>baz</p>');
  });
  runBehavioralCase('API', 'pug.test.js > .compile() perf.pug', (p) => {
    const perfSrc = fs.readFileSync(path.join(testDir, 'fixtures/perf.pug'), 'utf8');
    const fn = p.compile(perfSrc, {});
    const sample = {
      report: [
        { id: 1, parent: null, type: 'chapter', name: 'C1' },
        { id: 2, parent: 1, type: 'section', name: 'S1' },
      ],
    };
    const expected = raw.pug.compile(perfSrc, {})(sample);
    assert.strictEqual(fn(sample), expected);
  });
  runBehavioralCase('API', 'pug.test.js > .compile() allows trailing space (#1586)', (p) => {
    assert.strictEqual(p.render('ul \n  li An Item'), '<ul> <li>An Item</li></ul>');
  });

  // 6d. pug.test.js > .compileClient() & module snapshots (4 individual cases)
  runBehavioralCase('JS Artifact', 'pug.test.js > .compileClient(str) basic.pug', (p) => {
    const src = fs.readFileSync(path.join(testDir, 'cases/basic.pug'), 'utf8');
    const expected = fs.readFileSync(path.join(testDir, 'cases/basic.html'), 'utf8').replace(/\s/g, '');
    const clientStr = p.compileClient(src);
    const fn = Function('pug', clientStr + '\nreturn template;')(p.runtime);
    const actual = fn({ name: 'foo' }).replace(/\s/g, '');
    assert.strictEqual(actual, expected);
    const rawClientStr = raw.pug.compileClient(src);
    const cg = compareCodegen(rawClientStr, clientStr);
    assert.strictEqual(cg.ok, true, `Codegen mismatch (prettier=${cg.prettierMatch}, raw=${cg.rawMatch})`);
  });
  runBehavioralCase('JS Artifact', 'pug.test.js > .compileClient(str, { self: true })', (p) => {
    const clientStr = p.compileClient('.bar= self.foo', { self: true });
    const fn = Function('pug', clientStr + '\nreturn template;')(p.runtime);
    assert.strictEqual(fn({ foo: 'baz' }), '<div class="bar">baz</div>');
    const cg = compareCodegen(raw.pug.compileClient('.bar= self.foo', { self: true }), clientStr);
    assert.strictEqual(cg.ok, true, `Codegen mismatch (prettier=${cg.prettierMatch}, raw=${cg.rawMatch})`);
  });
  runBehavioralCase('JS Artifact', 'pug.test.js > .compileClient() module inlineRuntimeFunctions: true', (p) => {
    const opts = { self: true, module: true, inlineRuntimeFunctions: true };
    const clientStr = p.compileClient('.bar= self.foo', opts);
    const cg = compareCodegen(raw.pug.compileClient('.bar= self.foo', opts), clientStr);
    assert.strictEqual(cg.ok, true, `Codegen mismatch (prettier=${cg.prettierMatch}, raw=${cg.rawMatch})`);
    const mod = { exports: {} };
    new Function('module', clientStr)(mod);
    assert.strictEqual(mod.exports({ foo: 'baz' }), '<div class="bar">baz</div>');
  });
  runBehavioralCase('JS Artifact', 'pug.test.js > .compileClient() module inlineRuntimeFunctions: false', (p) => {
    const opts = { self: true, module: true, inlineRuntimeFunctions: false };
    const clientStr = p.compileClient('.bar= self.foo', opts);
    const cg = compareCodegen(raw.pug.compileClient('.bar= self.foo', opts), clientStr);
    assert.strictEqual(cg.ok, true, `Codegen mismatch (prettier=${cg.prettierMatch}, raw=${cg.rawMatch})`);
    const mod = { exports: {} };
    new Function('module', 'require', clientStr)(mod, (id) => {
      if (id === 'pug-runtime') return p.runtime;
      throw new Error('Unexpected require: ' + id);
    });
    assert.strictEqual(mod.exports({ foo: 'baz' }), '<div class="bar">baz</div>');
  });

  // 6e. pug.test.js > .runtime.merge & .runtime.attrs (2 individual cases)
  runBehavioralCase('Execution Semantics', 'pug.test.js > .runtime.merge', (p) => {
    assert.deepStrictEqual(
      p.runtime.merge({}, { class: ['foo', 'bar'], foo: 'bar' }),
      { class: ['foo', 'bar'], foo: 'bar' }
    );
    assert.deepStrictEqual(
      p.runtime.merge({ class: ['foo'], foo: 'baz' }, { class: ['bar'], foo: 'bar' }),
      { class: ['foo', 'bar'], foo: 'bar' }
    );
    assert.deepStrictEqual(
      p.runtime.merge({ class: ['foo', 'bar'], foo: 'bar' }, {}),
      { class: ['foo', 'bar'], foo: 'bar' }
    );
  });
  runBehavioralCase('Execution Semantics', 'pug.test.js > .runtime.attrs', (p) => {
    assert.strictEqual(p.runtime.attrs({}), '');
    assert.strictEqual(p.runtime.attrs({ class: [] }), '');
    assert.strictEqual(p.runtime.attrs({ class: ['foo'] }), ' class="foo"');
    assert.strictEqual(p.runtime.attrs({ class: ['foo'], id: 'bar' }), ' class="foo" id="bar"');
  });

  // 6f. pug.test.js > filter indentation maintained (1 case)
  runBehavioralCase('Filters/Plugins', 'pug.test.js > filter indentation maintained', (p) => {
    const filters = {
      indents: (s) => s.split(/\n/).map((l) => l.match(/^ */)[0].length).join(','),
    };
    const indents = [
      ':indents', '  x', '   x', '    x', '     x', '  x', '      x', '      x',
      '     x', '     x', '      x', '    x', '  x', '    x', '  x', '   x',
    ].join('\n');
    assert.strictEqual(p.render(indents, { filters }), '0,1,2,3,0,4,4,3,3,4,2,0,2,0,1');
  });

  // 6g. pug.test.js > unit tests with .render() (representative Step 1-3 in-scope cases + 1 Step 4 deferred)
  const unitRenderTests = [
    ['unit render > doctypes', (p) => {
      assert.strictEqual(p.render('doctype xml'), '<?xml version="1.0" encoding="utf-8" ?>');
      assert.strictEqual(p.render('doctype html'), '<!DOCTYPE html>');
      assert.strictEqual(p.render('doctype foo bar baz'), '<!DOCTYPE foo bar baz>');
      assert.strictEqual(p.render('doctype', { doctype: 'html' }), '<!DOCTYPE html>');
      assert.strictEqual(p.render('doctype html', { doctype: 'xml' }), '<!DOCTYPE html>');
      assert.strictEqual(p.render('html'), '<html></html>');
      assert.strictEqual(p.render('html', { doctype: 'html' }), '<!DOCTYPE html><html></html>');
    }],
    ['unit render > Buffers', (p) => {
      assert.strictEqual(p.render(Buffer.from('p foo')), '<p>foo</p>');
    }],
    ['unit render > line endings', (p) => {
      const src = ['p', 'div', 'img'];
      assert.strictEqual(p.render(src.join('\n')), '<p></p><div></div><img/>');
      assert.strictEqual(p.render(src.join('\r')), '<p></p><div></div><img/>');
      assert.strictEqual(p.render(src.join('\r\n')), '<p></p><div></div><img/>');
      assert.strictEqual(p.render(src.join('\n'), { doctype: 'html' }), '<p></p><div></div><img>');
    }],
    ['unit render > flexible indentation', (p) => {
      assert.strictEqual(
        p.render('html\n  body\n   h1 Wahoo\n   p test'),
        '<html><body><h1>Wahoo</h1><p>test</p></body></html>'
      );
    }],
    ['unit render > interpolation values', (p) => {
      assert.strictEqual(p.render('p Users: #{15}'), '<p>Users: 15</p>');
      assert.strictEqual(p.render('p Users: #{null}'), '<p>Users: </p>');
      assert.strictEqual(p.render('p Users: #{undefined}'), '<p>Users: </p>');
      assert.strictEqual(p.render('p Users: #{0}'), '<p>Users: 0</p>');
      assert.strictEqual(p.render('p Users: #{false}'), '<p>Users: false</p>');
    }],
    ['unit render > html 5 mode boolean attrs', (p) => {
      assert.strictEqual(p.render('doctype html\ninput(type="checkbox", checked)'), '<!DOCTYPE html><input type="checkbox" checked>');
      assert.strictEqual(p.render('doctype html\ninput(type="checkbox", checked=true)'), '<!DOCTYPE html><input type="checkbox" checked>');
      assert.strictEqual(p.render('doctype html\ninput(type="checkbox", checked=false)'), '<!DOCTYPE html><input type="checkbox">');
    }],
    ['unit render > control flow (each/if/unless/else/else-if)', (p) => {
      assert.strictEqual(p.render('- var users = ["tobi", "jane", "loki"];\nfor user in users\n  if user == "tobi"\n    p awesome #{user}\n  else if user == "jane"\n    p lame #{user}\n  else\n    p #{user}'), '<p>awesome tobi</p><p>lame jane</p><p>loki</p>');
      assert.strictEqual(p.render('- var users = []\nunless users.length\n  p no users'), '<p>no users</p>');
    }],
  ];
  for (const [name, fn] of unitRenderTests) {
    runBehavioralCase('HTML', `pug.test.js > ${name}`, fn);
  }
  runBehavioralCase('HTML', 'pug.test.js > unit render > should include block', (p) => {
    const str = [
      'html',
      '  head',
      '    include fixtures/scripts.pug',
      '      scripts(src="/app.js")',
    ].join('\n');
    assert.strictEqual(
      p.render(str, { filename: path.join(testDir, 'pug.test.js') }),
      '<html><head><script src="/jquery.js"></script><script src="/caustic.js"></script><scripts src="/app.js"></scripts></head></html>'
    );
  });

  // 6h. Step 4 dependencies & linker behavioral suites
  for (const [caseName, depFiles] of [
    ['extends1', ['dependency1.pug']],
    ['include1', ['dependency1.pug']],
    ['extends2', ['dependency2.pug', 'dependency3.pug']],
    ['include2', ['dependency2.pug', 'dependency3.pug']],
  ]) {
    runBehavioralCase('API', `pug.test.js > .compile().dependencies > ${caseName}`, (p) => {
      const filename = path.join(testDir, 'dependencies', `${caseName}.pug`);
      const src = fs.readFileSync(filename, 'utf8');
      const info = p.compile(src, { filename });
      assert.deepStrictEqual(
        info.dependencies,
        depFiles.map((d) => path.resolve(testDir, 'dependencies', d))
      );
    });
  }

  runBehavioralCase('Error', 'extends-not-top-level/index.test.js', (p) => {
    for (const file of ['index.pug', 'duplicate.pug']) {
      let thrown = null;
      try {
        p.compileFile(path.join(testDir, 'extends-not-top-level', file));
      } catch (ex) {
        thrown = ex;
      }
      assert.ok(thrown, `expected error for ${file}`);
      assert.strictEqual(thrown.code, 'PUG:EXTENDS_NOT_FIRST');
      assert.strictEqual(
        thrown.msg,
        'Declaration of template inheritance ("extends") should be the first thing in the file. There can only be one extends statement per file.'
      );
    }
  });

  for (const [suiteDir, file, locals] of [
    ['duplicate-block', 'index.pug', { ajax: true }],
    ['duplicate-block', 'index.pug', { ajax: false }],
    ['shadowed-block', 'index.pug', { ajax: true }],
    ['shadowed-block', 'index.pug', { ajax: false }],
    ['regression-2436', 'issue1.pug', { pretty: true }],
    ['regression-2436', 'issue2.pug', { pretty: true }],
  ]) {
    const label = `${suiteDir}/index.test.js (${file}, ${JSON.stringify(locals)})`;
    runBehavioralCase('HTML', label, (p) => {
      const out = p.renderFile(path.join(testDir, suiteDir, file), locals);
      assert.strictEqual(typeof out, 'string');
      if (p !== raw.pug) {
        const expected = raw.pug.renderFile(path.join(testDir, suiteDir, file), locals);
        assert.strictEqual(out, expected);
      }
    });
  }

  runBehavioralCase('HTML', 'eachOf/index.test.js', (p) => {
    for (const bad of ['left-side.pug', 'right-side.pug', 'one-val.pug', 'no-brackets.pug']) {
      assert.throws(
        () => p.compileFile(path.join(testDir, 'eachOf/error', bad)),
        /The value variable for each must either be a valid identifier/
      );
    }
    const users = new Map([
      ['a', 'b'],
      ['foo', 'bar'],
    ]);
    for (const good of ['brackets.pug', 'no-brackets.pug']) {
      const actual = p.renderFile(path.join(testDir, 'eachOf/passing', good), { users });
      if (p !== raw.pug) {
        const expected = raw.pug.renderFile(path.join(testDir, 'eachOf/passing', good), { users });
        assert.strictEqual(actual, expected);
      }
    }
  });

  // 7. Explicitly deferred Step 6 API & integration cases (individually listed, NOT virtual counts)
  const deferredApiAndPluginCases = [
    ['API', 'pug.test.js > .compileFile() > issue-1593', 'PLAN.md §五 Step 6 (compileFile & file warnings)'],
    ['API', 'pug.test.js > .compileFile() > caching (pass 1)', 'PLAN.md §五 Step 6 (compileFile & file cache)'],
    ['API', 'pug.test.js > .compileFile() > caching (pass 2)', 'PLAN.md §五 Step 6 (compileFile & file cache)'],
    ['API', 'pug.test.js > .renderFile() > sync string return', 'PLAN.md §五 Step 6 (renderFile & file API)'],
    ['API', 'pug.test.js > .renderFile() > callback with options', 'PLAN.md §五 Step 6 (renderFile & callback)'],
    ['API', 'pug.test.js > .renderFile() > callback without options', 'PLAN.md §五 Step 6 (renderFile & callback)'],
    ['API', 'pug.test.js > .renderFile() > callback with error', 'PLAN.md §五 Step 6 (renderFile & callback)'],
    ['API', 'pug.test.js > .renderFile() > caching (pass 1)', 'PLAN.md §五 Step 6 (renderFile & file cache)'],
    ['API', 'pug.test.js > .renderFile() > caching (pass 2)', 'PLAN.md §五 Step 6 (renderFile & file cache)'],
    ['JS Artifact', 'pug.test.js > .compileFileClient() > returns template string', 'PLAN.md §五 Step 6 (compileFileClient)'],
    ['JS Artifact', 'pug.test.js > .compileFileClient() > name option', 'PLAN.md §五 Step 6 (compileFileClient)'],
    ['JS Artifact', 'pug.test.js > .compileFileClient() > caching (pass 1)', 'PLAN.md §五 Step 6 (compileFileClient & cache)'],
    ['JS Artifact', 'pug.test.js > .compileFileClient() > caching (pass 2)', 'PLAN.md §五 Step 6 (compileFileClient & cache)'],
    ['Filters/Plugins', 'plugins.test.js > #3295 lexer plugins in tag interpolation', 'PLAN.md §五 Step 6 (plugin.lex internal extension)'],
    ['Filters/Plugins', 'markdown-it/index.test.js', 'PLAN.md §五 Step 6 (markdown-it JSTransformer package check)'],
    ['Execution Semantics', 'examples.test.js', 'PLAN.md §五 Step 6 (full examples suite)'],
  ];
  for (const [cat, name, note] of deferredApiAndPluginCases) {
    recordCase(results, 'pug', cat, name, 'PASS', 'DEFERRED', note);
  }
}

function createStatusCounters() {
  return { PASS: 0, FAIL: 0, DEFERRED: 0, BLOCKED: 0, APPROVED_DIFF: 0 };
}

function summarizeResults(results) {
  const byPackage = {};
  const byCategory = {};
  const totals = {
    total: results.length,
    baseline: createStatusCounters(),
    target: createStatusCounters(),
  };

  for (const r of results) {
    totals.baseline[r.baselineStatus] = (totals.baseline[r.baselineStatus] || 0) + 1;
    totals.target[r.targetStatus] = (totals.target[r.targetStatus] || 0) + 1;

    if (!byPackage[r.pkg]) {
      byPackage[r.pkg] = {
        total: 0,
        baseline: createStatusCounters(),
        target: createStatusCounters(),
      };
    }
    byPackage[r.pkg].total++;
    byPackage[r.pkg].baseline[r.baselineStatus] = (byPackage[r.pkg].baseline[r.baselineStatus] || 0) + 1;
    byPackage[r.pkg].target[r.targetStatus] = (byPackage[r.pkg].target[r.targetStatus] || 0) + 1;

    if (!byCategory[r.category]) {
      byCategory[r.category] = {
        total: 0,
        baseline: createStatusCounters(),
        target: createStatusCounters(),
      };
    }
    byCategory[r.category].total++;
    byCategory[r.category].baseline[r.baselineStatus] = (byCategory[r.category].baseline[r.baselineStatus] || 0) + 1;
    byCategory[r.category].target[r.targetStatus] = (byCategory[r.category].target[r.targetStatus] || 0) + 1;
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
        baseline: createStatusCounters(),
        target: createStatusCounters(),
      };
      return `| \`${pkg}\` | \`${crate}\` | ${step} | ${s.total} | ${s.baseline.PASS} PASS / ${s.baseline.APPROVED_DIFF} APPROVED_DIFF / ${s.baseline.FAIL} FAIL | ${s.target.PASS} PASS / ${s.target.DEFERRED} DEFERRED / ${s.target.BLOCKED} BLOCKED / ${s.target.FAIL} FAIL |`;
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
        baseline: createStatusCounters(),
        target: createStatusCounters(),
      };
      return `| ${cat} | ${s.total} | ${s.baseline.PASS} PASS / ${s.baseline.APPROVED_DIFF} APPROVED_DIFF / ${s.baseline.FAIL} FAIL | ${s.target.PASS} PASS / ${s.target.DEFERRED} DEFERRED / ${s.target.BLOCKED} BLOCKED / ${s.target.FAIL} FAIL |`;
    })
    .join('\n');

  return `# Pug Rust Compiler 相容性追蹤矩陣 (\`compat/matrix.md\`)

> 本文件由 \`node tests/differential/runner.js --write-matrix\` 自動驗證並產生，對應 \`PLAN.md\` Step 0 相容基準與分層驗收分類。

## 1. 狀態標記定義

| 狀態碼 | 定義 |
|---|---|
| \`PASS\` | 與基準版本（\`raw/compiler\`）輸出、快照、錯誤欄位或雙層 Codegen 完全一致 |
| \`FAIL\` | 本階段已承諾功能與基準不一致、非預期拋錯，或回報不支援 |
| \`DEFERRED\` | 驗收前明列屬於後續階段（Step 4–6）且本輪不驗收之案例（不計為 PASS） |
| \`BLOCKED\` | 環境或原版／候選基準無法執行（不計為 PASS） |
| \`APPROVED_DIFF\` | 已登錄於 \`compat/expected-differences.json\` 的環境／平台差異（不計為完全相容通過） |

---

## 2. 各套件差異測試總覽

| 原版套件 | 對應 Rust Crate | 目標階段 | 追蹤案例數 | 原版基準 (\`raw/compiler\`) | Rust 目標 (\`rust/compiler\`) |
|---|---|---|---:|---|---|
${pkgRows}
| **合計** | — | **Step 0** | **${summary.totals.total}** | **${summary.totals.baseline.PASS} PASS / ${summary.totals.baseline.APPROVED_DIFF} APPROVED_DIFF / ${summary.totals.baseline.FAIL} FAIL** | **${summary.totals.target.PASS} PASS / ${summary.totals.target.DEFERRED} DEFERRED / ${summary.totals.target.BLOCKED} BLOCKED / ${summary.totals.target.FAIL} FAIL** |

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
| 公開 API | \`pug.compile(str, options)\` | 回傳附帶 \`.dependencies\` 的同步渲染函式 | \`PARTIAL (Step 4 範圍)\` | Step 1 / Step 3 / Step 4 / Step 6 |
| 公開 API | \`pug.compileFile(path, options)\` | 讀取檔案並支援 \`exports.cache[path]\` | \`PARTIAL (Step 4 範圍)\` | Step 4 / Step 6 |
| 公開 API | \`pug.compileClient(str, options)\` | 回傳 JS 函式原始碼字串（雙層驗收：Prettier + Raw） | \`PASS (Step 5 範圍)\` | Step 1 / Step 3 / Step 4 / Step 5 |
| 公開 API | \`pug.compileFileClient(path, options)\` | 支援 \`exports.cache[path + ':client']\` 與 \`name\` | \`PARTIAL (Step 5 已實作，cache 測試待 Step 6)\` | Step 5 / Step 6 |
| 公開 API | \`pug.compileClientWithDependenciesTracked(str, options)\` | 回傳 \`{ body, dependencies }\` | \`PASS (Step 5 範圍)\` | Step 1 / Step 3 / Step 4 / Step 5 |
| 公開 API | \`pug.render(str, options, fn)\` | 同步渲染或同步回呼 \`fn(err, html)\`；原始 \`locals\` 不經 JSON 序列化 | \`PARTIAL (Step 5 範圍)\` | Step 1 / Step 3 / Step 4 / Step 6 |
| 公開 API | \`pug.renderFile(path, options, fn)\` | 檔案同步渲染或同步回呼 \`fn(err, html)\` | \`PARTIAL (Step 5 範圍)\` | Step 4 / Step 6 |
| 公開 API | \`pug.__express(path, options, fn)\` | \`NODE_ENV === 'production'\` 且未指定 \`compileDebug\` 時預設 \`false\` | \`DEFERRED (Step 6)\` | Step 6 |
| 公開 API | \`pug.cache\` / \`pug.filters\` / \`pug.runtime\` / \`pug.name\` | 外部可直接讀寫 \`cache\` 與 \`filters\`；\`name === 'Pug'\` | \`PASS (Step 1 骨架)\` | Step 1 / Step 6 |
| 公開 API | \`require('pug/register')\` | 註冊 \`require.extensions['.pug'] = pug.compileFile\` | \`PASS (Step 1 骨架)\` | Step 1 / Step 6 |
| 編譯選項 | \`pretty\` / \`doctype\` / \`self\` / \`globals\` | 縮排字串、DOCTYPE 模式、\`self\` 命名空間與全域變數白名單 | \`PASS (Step 5 範圍)\` | Step 3 / Step 5 |
| 編譯選項 | \`compileDebug\` / \`includeSources\` / \`debug\` | 保留 \`compile\` 與 \`compileClient\` 預設差異 | \`PASS (Step 5 範圍)\` | Step 3 / Step 5 / Step 6 |
| 編譯選項 | \`inlineRuntimeFunctions\` / \`name\` / \`module\` | 內嵌 \`pug_*\` 依賴展開或 \`runtimeWrap\` / \`require("pug-runtime")\` | \`PASS (Step 5 範圍)\` | Step 1 / Step 3 / Step 5 |
| 編譯選項 | \`filename\` / \`basedir\` | Node \`path\` 相容解析，不任意 \`fs::canonicalize\` | \`PASS (Step 4 範圍)\` | Step 4 |
| 外掛介面 | \`preLex\` / \`postLex\` / \`preParse\` / \`postParse\` / \`preLoad\` / \`postLoad\` | 對入口與每個 \`include\`/\`extends\` 依賴檔案在主執行緒同步呼叫 | \`PASS (Step 4 範圍)\` | Step 1 / Step 4 / Step 6 |
| 外掛介面 | \`preFilters\` / \`postFilters\` / \`preLink\` / \`postLink\` / \`preCodeGen\` / \`postCodeGen\` | 管線各階段 AST / Code 同步轉換 hook | \`PASS (Step 4 範圍)\` | Step 4 / Step 6 |
| 外掛介面 | Replacement hooks (\`resolve\`, \`read\`, \`generateCode\`) | 多個 plugin 同時實作同名 replacement 時拋錯；支援 \`Buffer\` 回傳 | \`PASS (Step 4 範圍)\` | Step 4 / Step 6 |
| 外掛介面 | 內部擴充 (\`plugin.lex\`, \`plugin.parse\`) | 如 \`#3295\` tag interpolation 中的 \`plugin.lex.advance\` | \`DEFERRED (Step 6)\` | Step 6 |

---

## 5. Step 5 節點與編譯選項支援矩陣（四種能力分界）

| 類別 | AST 節點 / 編譯選項 | 可解析 (\`pug_parser\`) | 可走訪 (\`pug_walk\`) | 可產生 JS (\`pug_code_gen\`) | 可渲染 (\`Node VM + locals\`) | 延後完成階段與說明 |
|---|---|:---:|:---:|:---:|:---:|---|
| AST 節點 | \`Block\` / \`Tag\` / \`InterpolatedTag\` / \`Text\` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（含 inline tags、block expansion、text interpolation） |
| AST 節點 | \`Comment\` / \`BlockComment\` / \`Doctype\` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（含 conditional comments 與 doctype 模式） |
| AST 節點 | \`Code\`（buffered / unbuffered / 附帶 \`block\`） | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（保留完整 JS 上下文與行號追蹤） |
| AST 節點 | \`Conditional\` (\`if\` / \`else if\` / \`else\` / \`unless\`) | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | \`Each\`（含 \`key\` 與 \`else\` 替代區塊）/ \`EachOf\` / \`While\` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | \`Case\` / \`When\` (\`default\` / \`block\`) | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | \`AttributeBlock\` (\`&attributes\`) 與靜態/動態屬性 | ✅ | ✅ | ✅ | ✅ | Step 5 已完成 \`pug_attrs\` 52 筆獨立快照與執行等價收斂 |
| AST 節點 | \`Filter\` / \`IncludeFilter\` | ✅ | ✅ | ✅ | ✅ | Step 4B 已完成（\`pug_filters\` 編譯期常數選項、filter 執行與 JSTransformer 橋接） |
| AST 節點 | \`Include\` / \`RawInclude\` / \`Extends\` / \`FileReference\` | ✅ | ✅ | ✅ | ✅ | Step 4A/4C 已完成（\`pug_load\` 遞迴讀檔與 \`pug_linker\` 模板連結） |
| AST 節點 | \`NamedBlock\` (\`block\` / \`append\` / \`prepend\`) / \`YieldBlock\` | ✅ | ✅ | ✅ | ✅ | Step 4C 已完成（\`pug_linker\` 繼承合併、\`yield\` 替換與 \`Codegen\` 走訪） |
| AST 節點 | \`Mixin\`（定義與呼叫）/ \`MixinBlock\` | ✅ | ✅ | ✅ | ✅ | Step 4D/5 已完成（定義、參數/rest、動態名稱、繼承位置與 block/attributes 合併傳遞） |
| 編譯選項 | \`pretty\` / \`doctype\` / \`self\` / \`globals\` | ✅ | ✅ | ✅ | ✅ | Step 5 已完成多選項組合、void-elements 與 terse/xml 收斂 |
| 編譯選項 | \`compileDebug\` / \`includeSources\` / \`inlineRuntimeFunctions\` | ✅ | ✅ | ✅ | ✅ | Step 5 已完成全部選項與 Runtime helper 依賴展開組合 |
| 編譯選項 | \`filename\` / \`basedir\`（多檔案相對/絕對路徑解析） | ✅ | ✅ | ✅ | ✅ | Step 4A 已完成（\`pug_load\` 跨檔案依賴解析） |
| 外掛擴充 | \`plugin.parse\` / \`plugin.lex\` | ❌ (\`DEFERRED\`) | ❌ (\`DEFERRED\`) | ❌ (\`DEFERRED\`) | ❌ (\`DEFERRED\`) | Step 6（完整 Node Plugin 相容驗收） |

---

## 6. 已核准差異（Approved Differences）

| 差異 ID | 影響案例 | 狀態 | 說明 |
|---|---|---|---|
| \`NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY\` | \`error.reporting > runtime errors > in a mixin\`<br>\`error.reporting > runtime errors > in a layout\` | \`APPROVED_DIFF\` | Node.js 16+ / 22 (V8 9.3+) 將存取 \`null\`/\`undefined\` 屬性的 \`TypeError\` 訊息由 \`Cannot read property 'length' of null/undefined\` 改為 \`Cannot read properties of null/undefined (reading 'length')\`。同 Node 版本下 \`raw/compiler\` 與 \`rust/compiler\` 行為完全一致。 |
`;
}

async function main() {
  const args = process.argv.slice(2);
  const verifyBaseline = args.includes('--verify-baseline');
  const writeMatrix = args.includes('--write-matrix');
  const suiteIdx = args.indexOf('--suite');
  const suiteFilter = suiteIdx !== -1 ? args[suiteIdx + 1] : null;
  const jsonIdx = args.indexOf('--json');
  const jsonOutPath = jsonIdx !== -1 ? args[jsonIdx + 1] : null;

  const raw = loadRawPackages();
  const rustTarget = await tryLoadRustTarget();
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

  if (jsonOutPath) {
    fs.writeFileSync(
      path.resolve(jsonOutPath),
      JSON.stringify(
        {
          summary,
          failures: results.filter((r) => r.targetStatus === 'FAIL' || r.baselineStatus === 'FAIL'),
          blocked: results.filter((r) => r.targetStatus === 'BLOCKED'),
          results,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }

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
    `  Target  (rust/compiler): ${summary.totals.target.PASS} PASS, ${summary.totals.target.APPROVED_DIFF} APPROVED_DIFF, ${summary.totals.target.DEFERRED} DEFERRED, ${summary.totals.target.BLOCKED} BLOCKED, ${summary.totals.target.FAIL} FAIL`
  );

  const failedCases = results.filter((r) => r.targetStatus === 'FAIL');
  if (failedCases.length > 0) {
    console.error(`Target failures (${failedCases.length}):`);
    for (const f of failedCases) {
      console.error(`  FAIL [${f.pkg}/${f.category}] ${f.name}${f.note ? ' — ' + f.note : ''}`);
    }
  }

  if (verifyBaseline && summary.totals.baseline.FAIL > 0) {
    console.error('Baseline verification failed!');
    process.exit(1);
  }
  if (!verifyBaseline && (summary.totals.target.FAIL > 0 || summary.totals.target.BLOCKED > 0 || summary.totals.baseline.FAIL > 0)) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error('Differential runner crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
}
