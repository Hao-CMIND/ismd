'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAW_ROOT = path.resolve(__dirname, '../../../../raw/compiler');
const rawPug = require(path.join(RAW_ROOT, 'packages/pug'));
const rawLink = require(path.join(RAW_ROOT, 'packages/pug-linker'));
const rustPug = require('../../index.js');
const serializers = require('../differential/serializers.js');

test('Step 4C.1: Isolated pug_linker matches baseline on all cases, special-cases, and errors', () => {
  const linkerTestDir = path.join(RAW_ROOT, 'packages/pug-linker/test');
  const snaps = serializers.parseJestSnapFile(
    path.join(linkerTestDir, '__snapshots__/index.test.js.snap')
  );

  for (const [subDir, snapPrefix] of [
    ['cases', 'cases from pug'],
    ['special-cases', 'special cases'],
  ]) {
    const dir = path.join(linkerTestDir, subDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.input.json')).sort();
    assert.ok(files.length > 0, `expected fixtures in ${subDir}`);
    for (const file of files) {
      const input = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const rawOut = rawLink(JSON.parse(JSON.stringify(input)));
      const rustOut = rustPug._link(JSON.parse(JSON.stringify(input)));
      const cmp = serializers.compareStructured(rawOut, rustOut);
      assert.equal(
        cmp.ok,
        true,
        `structural mismatch on ${subDir}/${file}`
      );
      assert.equal(
        serializers.formatForSnapshot(rustOut),
        snaps[`${snapPrefix} ${file} 1`],
        `snapshot mismatch on ${subDir}/${file}`
      );
    }
  }

  const errorsDir = path.join(linkerTestDir, 'errors');
  for (const file of fs.readdirSync(errorsDir).filter((f) => f.endsWith('.input.json')).sort()) {
    const input = JSON.parse(fs.readFileSync(path.join(errorsDir, file), 'utf8'));
    let rawErr = null;
    try {
      rawLink(JSON.parse(JSON.stringify(input)));
    } catch (ex) {
      rawErr = { msg: ex.msg, code: ex.code, line: ex.line };
    }
    let rustErr = null;
    try {
      rustPug._link(JSON.parse(JSON.stringify(input)));
    } catch (ex) {
      rustErr = { msg: ex.msg, code: ex.code, line: ex.line };
    }
    assert.ok(rawErr && rustErr, `expected error for errors/${file}`);
    assert.deepEqual(rustErr, rawErr);
    assert.equal(
      serializers.formatForSnapshot(rustErr),
      snaps[`error handling ${file} 1`]
    );
  }
});

test('Step 4C.2: Multi-level extends (replace/append/prepend/implicit) + include/yield + RawInclude HTML and JS codegen', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4c-multi-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'grand.pug'),
      [
        'doctype html',
        'html',
        '  head',
        '    block head',
        '      meta(charset="utf-8")',
        '  body',
        '    block content',
        '      p default',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'parent.pug'),
      [
        'extends grand',
        'append head',
        '  title Parent',
        'block content',
        '  section',
        '    block inner',
        '      p parent-inner',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'widget.pug'),
      ['.card', '  h2 Title', '  yield'].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpDir, 'plain.txt'), 'line1\r\nline2\r\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'child.pug'),
      [
        'extends parent',
        'block prepend head',
        '  script(src="a.js")',
        'block append inner',
        '  include widget',
        '    p yielded-body',
        '  pre',
        '    include plain.txt',
      ].join('\n'),
      'utf8'
    );

    const entry = path.join(tmpDir, 'child.pug');
    const src = fs.readFileSync(entry, 'utf8');

    for (const compileOpts of [
      { filename: entry, compileDebug: false },
      { filename: entry, compileDebug: true },
      { filename: entry, compileDebug: false, pretty: true },
    ]) {
      const rawHtml = rawPug.compile(src, compileOpts)();
      const rustHtml = rustPug.compile(src, compileOpts)();
      assert.equal(rustHtml, rawHtml);

      const rawClient = rawPug.compileClient(src, compileOpts);
      const rustClient = rustPug.compileClient(src, compileOpts);
      const cg = serializers.compareCodegen(rawClient, rustClient);
      assert.equal(
        cg.ok,
        true,
        `codegen mismatch: prettier=${cg.prettierMatch}, raw=${cg.rawMatch}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 4C.3: Include without explicit yield uses defaultYieldLocation and skips textOnly tags', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4c-yield-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'box.pug'),
      [
        'div.box',
        '  script.',
        '    console.log(1);',
        '  main',
        '    p existing',
      ].join('\n'),
      'utf8'
    );
    const entry = path.join(tmpDir, 'index.pug');
    const src = ['include box', '  p appended-to-main'].join('\n');
    const opts = { filename: entry, compileDebug: false };

    const rawHtml = rawPug.compile(src, opts)();
    const rustHtml = rustPug.compile(src, opts)();
    assert.equal(rustHtml, rawHtml);
    assert.ok(rustHtml.includes('<main><p>existing<p>appended-to-main</p></p></main>'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 4C.4: Filters execute before Linker and Mixin definitions/order are preserved in linked AST', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4c-order-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'layout.pug'),
      ['html', '  body', '    block content'].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'snippet.txt'),
      'hello filter',
      'utf8'
    );
    const entry = path.join(tmpDir, 'page.pug');
    const src = [
      'extends layout',
      'block content',
      '  include:shout snippet.txt',
      '  :shout',
      '    inline block',
    ].join('\n');

    const logRaw = [];
    const logRust = [];
    const makeOpts = (log) => ({
      filename: entry,
      compileDebug: false,
      filters: {
        shout(text) {
          log.push(text.trim());
          return `[${text.trim().toUpperCase()}]`;
        },
      },
    });

    const rawHtml = rawPug.compile(src, makeOpts(logRaw))();
    const rustHtml = rustPug.compile(src, makeOpts(logRust))();
    assert.equal(rustHtml, rawHtml);
    assert.deepEqual(logRust, logRaw);

    // Also verify plugin order: postFilters observes unlinked NamedBlock/Include, postLink observes linked tree
    const pluginPhases = [];
    rustPug.compile(src, {
      filename: entry,
      compileDebug: false,
      filters: { shout: (t) => t },
      plugins: [
        {
          postFilters(ast) {
            pluginPhases.push(
              `postFilters:${ast.nodes.some((n) => n.type === 'Extends')}`
            );
            return ast;
          },
          postLink(ast) {
            pluginPhases.push(`postLink:${Boolean(ast.hasExtends)}`);
            return ast;
          },
        },
      ],
    })();
    assert.deepEqual(pluginPhases, ['postFilters:true', 'postLink:true']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 4C.5: Duplicate nested block name sets ignore=true and preserves nested distinct block', () => {
  const input = {
    type: 'Block',
    line: 0,
    filename: 'child.pug',
    nodes: [
      {
        type: 'Extends',
        line: 1,
        filename: 'child.pug',
        file: {
          type: 'FileReference',
          path: 'layout.pug',
          line: 1,
          filename: 'child.pug',
          ast: {
            type: 'Block',
            line: 0,
            filename: 'layout.pug',
            nodes: [
              {
                type: 'NamedBlock',
                name: 'outer',
                mode: 'replace',
                line: 1,
                filename: 'layout.pug',
                nodes: [
                  {
                    type: 'NamedBlock',
                    name: 'inner',
                    mode: 'replace',
                    line: 2,
                    filename: 'layout.pug',
                    nodes: [],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        type: 'NamedBlock',
        name: 'outer',
        mode: 'replace',
        line: 2,
        filename: 'child.pug',
        nodes: [
          {
            type: 'NamedBlock',
            name: 'outer',
            mode: 'replace',
            line: 3,
            filename: 'child.pug',
            nodes: [
              {
                type: 'NamedBlock',
                name: 'inner',
                mode: 'replace',
                line: 4,
                filename: 'child.pug',
                nodes: [
                  {
                    type: 'Text',
                    val: 'from-nested-inner',
                    line: 4,
                    filename: 'child.pug',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const rawOut = rawLink(JSON.parse(JSON.stringify(input)));
  const rustOut = rustPug._link(JSON.parse(JSON.stringify(input)));
  assert.equal(serializers.compareStructured(rawOut, rustOut).ok, true);
  assert.equal(rustOut.nodes[0].nodes[0].ignore, true);
});

test('Step 4C.6: Source locations preserved in compile errors and runtime debug frames across include/extends', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-step4c-loc-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'base.pug'), 'html\n  body\n    block main', 'utf8');
    const badEntry = path.join(tmpDir, 'bad.pug');
    const badSrc = 'extends base\nblock nope\n  p hi';

    let rawErr, rustErr;
    try { rawPug.compile(badSrc, { filename: badEntry }); } catch (e) { rawErr = e; }
    try { rustPug.compile(badSrc, { filename: badEntry }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, 'PUG:UNEXPECTED_BLOCK');
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.filename, rawErr.filename);
    assert.equal(rustErr.msg, rawErr.msg);

    const boomPath = path.join(tmpDir, 'boom.pug');
    fs.writeFileSync(boomPath, 'p ok\np= missingObj.prop', 'utf8');
    const okEntry = path.join(tmpDir, 'ok.pug');
    const okSrc = 'extends base\nblock main\n  include boom';

    let rawRtErr, rustRtErr;
    try { rawPug.compile(okSrc, { filename: okEntry, compileDebug: true })(); } catch (e) { rawRtErr = e; }
    try { rustPug.compile(okSrc, { filename: okEntry, compileDebug: true })(); } catch (e) { rustRtErr = e; }
    assert.ok(rawRtErr && rustRtErr);
    assert.ok(rustRtErr.message.includes('boom.pug:2'), `expected boom.pug:2 in ${rustRtErr.message}`);
    assert.equal(rustRtErr.path, rawRtErr.path);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
