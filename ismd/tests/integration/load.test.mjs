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
const rawLoad = require(path.join(RAW_ROOT, 'packages/ismd-load'));
const rawLex = require(path.join(RAW_ROOT, 'packages/ismd-lexer'));
const rawParse = require(path.join(RAW_ROOT, 'packages/ismd-parser'));
const rawWalk = require(path.join(RAW_ROOT, 'packages/ismd-walk'));

// Phase 6 removed inline/include filter syntax and `RawInclude.filters` from the AST.
// Return a cloned AST with empty `filters: []` omitted on `RawInclude` nodes (preserving Buffers)
// so rawIsmd's downstream `handleFilters` is not mutated in place.
function stripEmptyRawIncludeFilters(node) {
  if (!node || typeof node !== 'object' || Buffer.isBuffer(node)) return node;
  if (Array.isArray(node)) {
    return node.map(stripEmptyRawIncludeFilters);
  }
  const out = {};
  for (const key of Object.keys(node)) {
    if (
      key === 'filters' &&
      node.type === 'RawInclude' &&
      Array.isArray(node.filters) &&
      node.filters.length === 0
    ) {
      continue;
    }
    out[key] = stripEmptyRawIncludeFilters(node[key]);
  }
  return out;
}

test('Step 4A.1: ismd-load baseline snapshot parity (foo.pug / bar.pug / bing.pug / script.js)', () => {
  const rawFilename = path.join(RAW_ROOT, 'packages/ismd-load/test/foo.pug');
  const rustFilename = path.resolve(__dirname, '../../../raw/pug/packages/pug-load/test/foo.pug');

  const rawAst = stripEmptyRawIncludeFilters(
    rawWalk(
      rawLoad.file(rawFilename, { lex: rawLex, parse: rawParse }),
      (node) => {
        if (node.filename) node.filename = '<dirname>/' + path.basename(node.filename).replace(/\.pug$/, '.pug');
        if (node.fullPath) node.fullPath = '<dirname>/' + path.basename(node.fullPath).replace(/\.pug$/, '.pug');
        if (node.path) node.path = node.path.replace(/\.pug$/, '.pug');
      },
      { includeDependencies: true }
    )
  );

  const rustAst = rustIsmd.walk(
    rustIsmd._load.file(rustFilename, { lex: rustIsmd.lex, parse: rustIsmd.parse }),
    (node) => {
      if (node.filename) node.filename = '<dirname>/' + path.basename(node.filename);
      if (node.fullPath) node.fullPath = '<dirname>/' + path.basename(node.fullPath);
    },
    { includeDependencies: true }
  );

  const normSnap = (s) =>
    s
      .replace(/<basedir>\/packages\/ismd-load\/test\/bing\.pug/g, '<dirname>/bing.pug')
      .replace(/[^"]*raw(?:\\\\|\\|\/)pug(?:\\\\|\\|\/)packages(?:\\\\|\\|\/)pug-load(?:\\\\|\\|\/)test(?:\\\\|\\|\/)bing\.pug/g, '<dirname>/bing.pug');

  assert.equal(
    normSnap(serializers.formatForSnapshot(rustAst)),
    normSnap(serializers.formatForSnapshot(rawAst))
  );
});

test('Step 4A.2: Multi-layer dependencies, repeated includes, RawInclude binary bytes, CJK/Emoji/CRLF, and dependencies order', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4a-multi-'));
  try {
    const subDir = path.join(tmp, 'partials');
    fs.mkdirSync(subDir, { recursive: true });

    const binaryBytes = Buffer.from([0x00, 0xfe, 0xff, 0x41, 0x0d, 0x0a, 0x80]);
    const binPath = path.join(subDir, 'raw.bin');
    fs.writeFileSync(binPath, binaryBytes);
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmp, `layout.${ext}`), 'html\n  block content\n');
      fs.writeFileSync(path.join(subDir, `a.${ext}`), '\uFEFFp 中文😀\r\ninclude ../shared\r\n');
      fs.writeFileSync(path.join(tmp, `shared.${ext}`), 'span 共享段落\n');
    }
    const bPathRust = path.join(tmp, 'shared.pug');
    const rawMainPath = path.join(tmp, 'main.pug');
    const rustMainPath = path.join(tmp, 'main.pug');

    const mainSrc = [
      'extends layout',
      'block content',
      '  include partials/a',
      '  include /shared',
      '  script',
      '    include partials/raw.bin',
    ].join('\n');

    function runWith(engine, mainPath, stripRawFilters = false) {
      let capturedAstSnap = null;
      let capturedAst = null;
      const hookLog = [];
      const tracked = engine.compile(mainSrc, {
        filename: mainPath,
        basedir: tmp,
        plugins: [
          {
            preLex(s, o) {
              hookLog.push(['preLex', o.filename.replace(/\.pug$/, '.pug')]);
              return s;
            },
            postLex(toks, o) {
              hookLog.push(['postLex', o.filename.replace(/\.pug$/, '.pug'), typeof o.src]);
              return toks;
            },
            preParse(toks, o) {
              hookLog.push(['preParse', o.filename.replace(/\.pug$/, '.pug')]);
              return toks;
            },
            postParse(ast, o) {
              hookLog.push(['postParse', o.filename.replace(/\.pug$/, '.pug')]);
              return ast;
            },
            preLoad(ast, o) {
              hookLog.push(['preLoad', o.filename.replace(/\.pug$/, '.pug')]);
              return ast;
            },
            postLoad(ast, o) {
              hookLog.push(['postLoad', o.filename.replace(/\.pug$/, '.pug')]);
              capturedAstSnap = serializers.formatForSnapshot(
                stripRawFilters ? stripEmptyRawIncludeFilters(ast) : ast
              ).replace(/\.pug/g, '.pug');
              capturedAst = ast;
              return ast;
            },
            generateCode() {
              return 'function template() { return ""; }';
            },
          },
        ],
      });
      return { tracked, hookLog, capturedAstSnap, capturedAst };
    }

    const rRaw = runWith(rawIsmd, rawMainPath, true);
    const rRust = runWith(rustIsmd, rustMainPath, false);

    // Dependency list preserves exact depth-first order AND duplicate references
    assert.deepEqual(
      rRust.tracked.dependencies,
      rRaw.tracked.dependencies.map((d) => d.replace(/\.pug$/, '.pug'))
    );
    assert.equal(
      rRust.tracked.dependencies.filter((d) => d === bPathRust).length,
      2
    );

    // Hook sequence and per-file options.filename match identically
    assert.deepEqual(rRust.hookLog, rRaw.hookLog);

    // Post-load AST snapshot matches identically (captured before raw ismd-linker mutates AST in place)
    // and preserves raw Buffer bytes on RawInclude
    assert.equal(rRust.capturedAstSnap, rRaw.capturedAstSnap);

    let rawNodeSeen = null;
    rustIsmd.walk(
      rRust.capturedAst,
      (node) => {
        if (node.type === 'RawInclude') rawNodeSeen = node;
      },
      { includeDependencies: true }
    );
    assert.ok(rawNodeSeen);
    assert.equal(rawNodeSeen.file.ast, undefined);
    assert.equal(Buffer.isBuffer(rawNodeSeen.file.raw), true);
    assert.equal(Buffer.compare(rawNodeSeen.file.raw, binaryBytes), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 4A.3: Custom in-memory resolve/read plugins, non-JSON options, Buffer/String read returns, and hook data mutation', () => {
  function createVfsFixture(ext) {
    const marker = () => 'non-json-fn';
    const vfs = {
      [`mem:/root/main.${ext}`]: Buffer.from('include sub\ninclude raw.txt\n'),
      [`mem:/root/sub.${ext}`]: Buffer.from('p from-sub\n'),
      'mem:/root/raw.txt': 'string-raw-content',
    };
    const log = [];
    return { marker, vfs, log };
  }

  function runWith(engine, ext, stripRawFilters = false) {
    const { marker, vfs, log } = createVfsFixture(ext);
    let postLoadSnap = null;
    let postLoadAst = null;
    const opts = {
      filename: `mem:/root/main.${ext}`,
      plugins: [
        {
          resolve(target, source, options) {
            assert.equal(options.filename, `mem:/root/main.${ext}`);
            assert.equal(marker(), 'non-json-fn');
            log.push(['resolve', target.replace(/\.pug$/, '.pug'), source.replace(/\.pug$/, '.pug')]);
            const dir = source.slice(0, source.lastIndexOf('/'));
            return `${dir}/${target}`;
          },
          read(fullPath, options) {
            assert.equal(options.filename, `mem:/root/main.${ext}`);
            log.push(['read', fullPath.replace(/\.pug$/, '.pug')]);
            return vfs[fullPath];
          },
          preLex(src, o) {
            if (o.filename === `mem:/root/sub.${ext}`) {
              return src.replace('from-sub', 'from-preLex');
            }
            return src;
          },
          postLoad(ast) {
            postLoadSnap = serializers.formatForSnapshot(
              stripRawFilters ? stripEmptyRawIncludeFilters(ast) : ast
            ).replace(/\.pug/g, '.pug');
            postLoadAst = ast;
            return ast;
          },
          generateCode() {
            return 'function template() { return "ok"; }';
          },
        },
      ],
    };
    const res = engine.compile(
      'include sub\ninclude raw.txt\n',
      opts
    );
    return { res, log, postLoadSnap, postLoadAst };
  }

  const rRaw = runWith(rawIsmd, 'pug', true);
  const rRust = runWith(rustIsmd, 'pug', false);

  assert.deepEqual(rRust.log, rRaw.log);
  assert.deepEqual(
    rRust.res.dependencies,
    rRaw.res.dependencies.map((d) => d.replace(/\.pug$/, '.pug'))
  );
  assert.equal(rRust.postLoadSnap, rRaw.postLoadSnap);

  // Verify Buffer vs String preservation in FileReference.raw
  const rawInc = rRust.postLoadAst.nodes[1];
  const ismdInc = rRust.postLoadAst.nodes[0];
  assert.equal(Buffer.isBuffer(ismdInc.file.raw), true);
  assert.equal(typeof rawInc.file.raw, 'string');
  assert.equal(rawInc.file.raw, 'string-raw-content');
});

test('Step 4A.4: Error cases, source annotation, and JS error identity preservation across FFI', () => {
  // 1. Missing filename for relative include
  {
    let rawErr, rustErr;
    try { rawIsmd.compile('include foo'); } catch (e) { rawErr = e; }
    try { rustIsmd.compile('include foo'); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.message, rawErr.message);
  }

  // 2. Missing basedir for absolute include
  {
    let rawErr, rustErr;
    try { rawIsmd.compile('include /foo', { filename: 'entry.pug' }); } catch (e) { rawErr = e; }
    try { rustIsmd.compile('include /foo', { filename: 'entry.pug' }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.message, rawErr.message.replace(/\.pug/g, '.pug'));
  }

  // 3. ENOENT error preserves Node fs error code and location suffix
  {
    const rawMain = path.resolve(os.tmpdir(), 'ismd4a-does-not-exist', 'entry.pug');
    const rustMain = path.resolve(os.tmpdir(), 'ismd4a-does-not-exist', 'entry.pug');
    let rawErr, rustErr;
    try { rawIsmd.compile('include missing.pug', { filename: rawMain }); } catch (e) { rawErr = e; }
    try { rustIsmd.compile('include missing.pug', { filename: rustMain }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, 'ENOENT');
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.message, rawErr.message.replace(/\.pug/g, '.pug'));
  }

  // 4. Custom resolve / read error preserves exact JS Error object identity and message annotation
  class CustomResolveError extends RangeError {
    constructor(m) {
      super(m);
      this.tag = 99;
    }
  }
  {
    const thrown = new CustomResolveError('resolve-boom');
    let caught = null;
    try {
      rustIsmd.compile('p ok\ninclude broken', {
        filename: 'host.pug',
        plugins: [
          {
            resolve() {
              throw thrown;
            },
          },
        ],
      });
    } catch (e) {
      caught = e;
    }
    assert.equal(caught, thrown);
    assert.equal(caught instanceof CustomResolveError, true);
    assert.equal(caught.tag, 99);
    assert.equal(caught.message, 'resolve-boom\n    at host.pug line 2');
  }

  // 5. Syntax error inside loaded dependency preserves dependency filename, line, column, and src
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4a-err-'));
  try {
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmp, `bad.${ext}`), 'p 一二\np= (bad +)\n');
    }
    let rawErr, rustErr;
    try {
      rawIsmd.compile('include bad', { filename: path.join(tmp, 'main.pug') });
    } catch (e) {
      rawErr = e;
    }
    try {
      rustIsmd.compile('include bad', { filename: path.join(tmp, 'main.pug') });
    } catch (e) {
      rustErr = e;
    }
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.column, rawErr.column);
    assert.equal(rustErr.filename, rawErr.filename.replace(/\.pug$/, '.pug'));
    assert.equal(rustErr.message, rawErr.message.replace(/\.pug/g, '.pug'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 4A.5: Re-entrant compilation inside read() and postLoad() does not pollute outer dependencies or errors', () => {
  let outerCaught = null;
  let innerHtml = null;

  const tracked = rustIsmd.compile('include sub\n', {
    filename: 'outer/main.pug',
    plugins: [
      {
        resolve(target, source) {
          return 'mem://' + path.posix.join(path.posix.dirname(source), target);
        },
        read(fullPath) {
          if (fullPath === 'mem://outer/sub.pug') {
            // Re-entrant full render + failing inner compile inside read hook
            innerHtml = rustIsmd.render('p= val', { val: 'reentrant-ok' });
            try {
              rustIsmd.compile('include nonexistent', { filename: 'inner/entry.pug' });
            } catch (e) {
              outerCaught = e;
            }
            return Buffer.from('span inner-done\n');
          }
          throw new Error('Unexpected read: ' + fullPath);
        },
        generateCode() {
          return 'function template() { return "outer-ok"; }';
        },
      },
    ],
  });

  assert.equal(innerHtml, '<p>reentrant-ok</p>');
  assert.ok(outerCaught && outerCaught.code === 'ENOENT');
  assert.deepEqual(tracked.dependencies, ['mem://outer/sub.pug']);
});
