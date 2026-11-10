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

const RAW_ROOT = path.resolve(__dirname, '../../../../raw/compiler');
const rawPug = require(path.join(RAW_ROOT, 'packages/pug'));
const rawLoad = require(path.join(RAW_ROOT, 'packages/pug-load'));
const rawLex = require(path.join(RAW_ROOT, 'packages/pug-lexer'));
const rawParse = require(path.join(RAW_ROOT, 'packages/pug-parser'));
const rawWalk = require(path.join(RAW_ROOT, 'packages/pug-walk'));

test('Step 4A.1: pug-load baseline snapshot parity (foo.pug / bar.pug / bing.pug / script.js)', () => {
  const filename = path.join(RAW_ROOT, 'packages/pug-load/test/foo.pug');

  const rawAst = rawWalk(
    rawLoad.file(filename, { lex: rawLex, parse: rawParse }),
    (node) => {
      if (node.filename) node.filename = '<dirname>/' + path.basename(node.filename);
      if (node.fullPath) node.fullPath = '<dirname>/' + path.basename(node.fullPath);
    },
    { includeDependencies: true }
  );

  const rustAst = rustPug.walk(
    rustPug._load.file(filename, { lex: rustPug.lex, parse: rustPug.parse }),
    (node) => {
      if (node.filename) node.filename = '<dirname>/' + path.basename(node.filename);
      if (node.fullPath) node.fullPath = '<dirname>/' + path.basename(node.fullPath);
    },
    { includeDependencies: true }
  );

  assert.equal(
    serializers.formatForSnapshot(rustAst),
    serializers.formatForSnapshot(rawAst)
  );
});

test('Step 4A.2: Multi-layer dependencies, repeated includes, RawInclude binary bytes, CJK/Emoji/CRLF, and dependencies order', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4a-multi-'));
  try {
    const subDir = path.join(tmp, 'partials');
    fs.mkdirSync(subDir, { recursive: true });

    const binaryBytes = Buffer.from([0x00, 0xfe, 0xff, 0x41, 0x0d, 0x0a, 0x80]);
    const layoutPath = path.join(tmp, 'layout.pug');
    const aPath = path.join(subDir, 'a.pug');
    const bPath = path.join(tmp, 'shared.pug');
    const binPath = path.join(subDir, 'raw.bin');
    const mainPath = path.join(tmp, 'main.pug');

    fs.writeFileSync(layoutPath, 'html\n  block content\n');
    fs.writeFileSync(aPath, '\uFEFFp 中文😀\r\ninclude ../shared\r\n');
    fs.writeFileSync(bPath, 'span 共享段落\n');
    fs.writeFileSync(binPath, binaryBytes);

    const mainSrc = [
      'extends layout',
      'block content',
      '  include partials/a',
      '  include /shared',
      '  script',
      '    include partials/raw.bin',
    ].join('\n');

    function runWith(engine) {
      let capturedAstSnap = null;
      let capturedAst = null;
      const hookLog = [];
      const tracked = engine.compileClientWithDependenciesTracked(mainSrc, {
        filename: mainPath,
        basedir: tmp,
        plugins: [
          {
            preLex(s, o) {
              hookLog.push(['preLex', o.filename]);
              return s;
            },
            postLex(toks, o) {
              hookLog.push(['postLex', o.filename, typeof o.src]);
              return toks;
            },
            preParse(toks, o) {
              hookLog.push(['preParse', o.filename]);
              return toks;
            },
            postParse(ast, o) {
              hookLog.push(['postParse', o.filename]);
              return ast;
            },
            preLoad(ast, o) {
              hookLog.push(['preLoad', o.filename]);
              return ast;
            },
            postLoad(ast, o) {
              hookLog.push(['postLoad', o.filename]);
              capturedAstSnap = serializers.formatForSnapshot(ast);
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

    const rRaw = runWith(rawPug);
    const rRust = runWith(rustPug);

    // Dependency list preserves exact depth-first order AND duplicate references
    assert.deepEqual(rRust.tracked.dependencies, rRaw.tracked.dependencies);
    assert.equal(
      rRust.tracked.dependencies.filter((d) => d === bPath).length,
      2
    );

    // Hook sequence and per-file options.filename match identically
    assert.deepEqual(rRust.hookLog, rRaw.hookLog);

    // Post-load AST snapshot matches identically (captured before raw pug-linker mutates AST in place)
    // and preserves raw Buffer bytes on RawInclude
    assert.equal(rRust.capturedAstSnap, rRaw.capturedAstSnap);

    let rawNodeSeen = null;
    rustPug.walk(
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
  function createVfsFixture() {
    const marker = () => 'non-json-fn';
    const vfs = {
      'mem:/root/main.pug': Buffer.from('include sub\ninclude raw.txt\n'),
      'mem:/root/sub.pug': Buffer.from('p from-sub\n'),
      'mem:/root/raw.txt': 'string-raw-content',
    };
    const log = [];
    return { marker, vfs, log };
  }

  function runWith(engine) {
    const { marker, vfs, log } = createVfsFixture();
    let postLoadSnap = null;
    let postLoadAst = null;
    const opts = {
      filename: 'mem:/root/main.pug',
      filters: { marker },
      plugins: [
        {
          resolve(target, source, options) {
            assert.equal(options.filters.marker, marker);
            log.push(['resolve', target, source]);
            const dir = source.slice(0, source.lastIndexOf('/'));
            return `${dir}/${target}`;
          },
          read(fullPath, options) {
            assert.equal(options.filters.marker, marker);
            log.push(['read', fullPath]);
            return vfs[fullPath];
          },
          preLex(src, o) {
            if (o.filename === 'mem:/root/sub.pug') {
              return src.replace('from-sub', 'from-preLex');
            }
            return src;
          },
          postLoad(ast) {
            postLoadSnap = serializers.formatForSnapshot(ast);
            postLoadAst = ast;
            return ast;
          },
          generateCode() {
            return 'function template() { return "ok"; }';
          },
        },
      ],
    };
    const res = engine.compileClientWithDependenciesTracked(
      'include sub\ninclude raw.txt\n',
      opts
    );
    return { res, log, postLoadSnap, postLoadAst };
  }

  const rRaw = runWith(rawPug);
  const rRust = runWith(rustPug);

  assert.deepEqual(rRust.log, rRaw.log);
  assert.deepEqual(rRust.res.dependencies, rRaw.res.dependencies);
  assert.equal(rRust.postLoadSnap, rRaw.postLoadSnap);

  // Verify Buffer vs String preservation in FileReference.raw
  const rawInc = rRust.postLoadAst.nodes[1];
  const pugInc = rRust.postLoadAst.nodes[0];
  assert.equal(Buffer.isBuffer(pugInc.file.raw), true);
  assert.equal(typeof rawInc.file.raw, 'string');
  assert.equal(rawInc.file.raw, 'string-raw-content');
});

test('Step 4A.4: Error cases, source annotation, and JS error identity preservation across FFI', () => {
  // 1. Missing filename for relative include
  {
    let rawErr, rustErr;
    try { rawPug.compile('include foo'); } catch (e) { rawErr = e; }
    try { rustPug.compile('include foo'); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.message, rawErr.message);
  }

  // 2. Missing basedir for absolute include
  {
    let rawErr, rustErr;
    try { rawPug.compile('include /foo', { filename: 'entry.pug' }); } catch (e) { rawErr = e; }
    try { rustPug.compile('include /foo', { filename: 'entry.pug' }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.message, rawErr.message);
  }

  // 3. ENOENT error preserves Node fs error code and location suffix
  {
    const fakeMain = path.resolve(os.tmpdir(), 'pug4a-does-not-exist', 'entry.pug');
    let rawErr, rustErr;
    try { rawPug.compile('include missing.pug', { filename: fakeMain }); } catch (e) { rawErr = e; }
    try { rustPug.compile('include missing.pug', { filename: fakeMain }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, 'ENOENT');
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.message, rawErr.message);
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
      rustPug.compile('p ok\ninclude broken', {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4a-err-'));
  try {
    const depPath = path.join(tmp, 'bad.pug');
    fs.writeFileSync(depPath, 'p 一二\np= (bad +)\n');
    let rawErr, rustErr;
    try {
      rawPug.compile('include bad', { filename: path.join(tmp, 'main.pug') });
    } catch (e) {
      rawErr = e;
    }
    try {
      rustPug.compile('include bad', { filename: path.join(tmp, 'main.pug') });
    } catch (e) {
      rustErr = e;
    }
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.column, rawErr.column);
    assert.equal(rustErr.filename, rawErr.filename);
    assert.equal(rustErr.message, rawErr.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Step 4A.5: Re-entrant compilation inside read() and postLoad() does not pollute outer dependencies or errors', () => {
  let outerCaught = null;
  let innerHtml = null;

  const tracked = rustPug.compileClientWithDependenciesTracked('include sub\n', {
    filename: 'outer/main.pug',
    plugins: [
      {
        resolve(target, source) {
          return 'mem://' + path.posix.join(path.posix.dirname(source), target);
        },
        read(fullPath) {
          if (fullPath === 'mem://outer/sub.pug') {
            // Re-entrant full render + failing inner compile inside read hook
            innerHtml = rustPug.render('p= val', { val: 'reentrant-ok' });
            try {
              rustPug.compile('include nonexistent', { filename: 'inner/entry.pug' });
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
