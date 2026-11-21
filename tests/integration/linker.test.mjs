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
const rawLink = require(path.join(RAW_ROOT, 'packages/ismd-linker'));

test('Step 4C.1: Isolated ismd_linker matches baseline on all cases, special-cases, and errors', () => {
  const linkerTestDir = path.join(RAW_ROOT, 'packages/ismd-linker/test');
  const snaps = serializers.parseJestSnapFile(
    path.join(linkerTestDir, '__snapshots__/index.test.js.snap')
  );

  for (const [subDir, snapPrefix] of [
    ['cases', 'cases from ismd'],
    ['special-cases', 'special cases'],
  ]) {
    const dir = path.join(linkerTestDir, subDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.input.json')).sort();
    assert.ok(files.length > 0, `expected fixtures in ${subDir}`);
    for (const file of files) {
      const input = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const rawOut = rawLink(JSON.parse(JSON.stringify(input)));
      const rustOut = rustIsmd._link(JSON.parse(JSON.stringify(input)));
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
      rustIsmd._link(JSON.parse(JSON.stringify(input)));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4c-multi-'));
  try {
    const grandSrc = [
      'doctype html',
      'html',
      '  head',
      '    block head',
      '      meta(charset="utf-8")',
      '  body',
      '    block content',
      '      p default',
    ].join('\n');
    const parentSrc = [
      'extends grand',
      'append head',
      '  title Parent',
      'block content',
      '  section',
      '    block inner',
      '      p parent-inner',
    ].join('\n');
    const widgetSrc = ['.card', '  h2 Title', '  yield'].join('\n');
    const childSrc = [
      'extends parent',
      'block prepend head',
      '  script(src="a.js")',
      'block append inner',
      '  include widget',
      '    p yielded-body',
      '  pre',
      '    include plain.txt',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'plain.txt'), 'line1\r\nline2\r\n', 'utf8');
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmpDir, `grand.${ext}`), grandSrc, 'utf8');
      fs.writeFileSync(path.join(tmpDir, `parent.${ext}`), parentSrc, 'utf8');
      fs.writeFileSync(path.join(tmpDir, `widget.${ext}`), widgetSrc, 'utf8');
      fs.writeFileSync(path.join(tmpDir, `child.${ext}`), childSrc, 'utf8');
    }

    const rawEntry = path.join(tmpDir, 'child.pug');
    const rustEntry = path.join(tmpDir, 'child.pug');

    for (const baseOpts of [
      { compileDebug: false },
      { compileDebug: true },
      { compileDebug: false, pretty: true },
    ]) {
      const rawFn = rawIsmd.compile(childSrc, { filename: rawEntry, ...baseOpts });
      const rustFn = rustIsmd.compile(childSrc, { filename: rustEntry, ...baseOpts });
      assert.equal(rustFn(), rawFn());

      const cg = serializers.compareCodegen(
        rawFn.toString().replace(/\.pug/g, '.pug'),
        rustFn.toString()
      );
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4c-yield-'));
  try {
    const boxSrc = [
      'div.box',
      '  script.',
      '    console.log(1);',
      '  main',
      '    p existing',
    ].join('\n');
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmpDir, `box.${ext}`), boxSrc, 'utf8');
    }
    const src = ['include box', '  p appended-to-main'].join('\n');

    const rawHtml = rawIsmd.compile(src, { filename: path.join(tmpDir, 'index.pug'), compileDebug: false })();
    const rustHtml = rustIsmd.compile(src, { filename: path.join(tmpDir, 'index.pug'), compileDebug: false })();
    assert.equal(rustHtml, rawHtml);
    assert.ok(rustHtml.includes('<main><p>existing<p>appended-to-main</p></p></main>'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Step 4C.4: Plugin phase ordering around Linker and Mixin definitions/order preserved in linked AST (filter syntax removed in Phase 6)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4c-order-'));
  try {
    const layoutSrc = [
      'mixin shared(label)',
      '  span.shared= label',
      'html',
      '  body',
      '    block content',
    ].join('\n');
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmpDir, `layout.${ext}`), layoutSrc, 'utf8');
    }
    fs.writeFileSync(
      path.join(tmpDir, 'snippet.txt'),
      'hello raw snippet',
      'utf8'
    );
    const rawEntry = path.join(tmpDir, 'page.pug');
    const rustEntry = path.join(tmpDir, 'page.pug');

    // Phase 6 expected difference: inline/include filter syntax (`include:shout`, `:shout`)
    // and `preFilters`/`postFilters` hooks were removed from core.
    const filterSrc = [
      'extends layout',
      'block content',
      '  include:shout snippet.txt',
    ].join('\n');
    assert.throws(
      () => rustIsmd.compile(filterSrc, { filename: rustEntry, compileDebug: false }),
      (err) => err && err.code === 'ISMD:MALFORMED_INCLUDE'
    );

    // Without filter syntax: verify RawInclude + Mixin definitions/order in linked AST and plugin order
    const src = [
      'extends layout',
      'mixin localBadge(text)',
      '  em.badge= text',
      'block content',
      '  include snippet.txt',
      '  +shared("from-layout")',
      '  +localBadge("from-page")',
    ].join('\n');

    const rawHtml = rawIsmd.compile(src, { filename: rawEntry, compileDebug: false })();
    const rustHtml = rustIsmd.compile(src, { filename: rustEntry, compileDebug: false })();
    assert.equal(rustHtml, rawHtml);

    // Verify plugin order: preLink observes unlinked Extends, postLink observes linked tree with preserved mixins
    const rawLinkedMixinNames = [];
    rawIsmd.compile(src, {
      filename: rawEntry,
      compileDebug: false,
      plugins: [
        {
          postLink(ast) {
            for (const node of ast.nodes) {
              if (node.type === 'Mixin' && !node.call) {
                rawLinkedMixinNames.push(node.name);
              }
            }
            return ast;
          },
        },
      ],
    })();

    const pluginPhases = [];
    const linkedMixinNames = [];
    rustIsmd.compile(src, {
      filename: rustEntry,
      compileDebug: false,
      plugins: [
        {
          preLink(ast) {
            pluginPhases.push(
              `preLink:${ast.nodes.some((n) => n.type === 'Extends')}`
            );
            return ast;
          },
          postLink(ast) {
            pluginPhases.push(`postLink:${Boolean(ast.hasExtends)}`);
            for (const node of ast.nodes) {
              if (node.type === 'Mixin' && !node.call) {
                linkedMixinNames.push(node.name);
              }
            }
            return ast;
          },
        },
      ],
    })();
    assert.deepEqual(pluginPhases, ['preLink:true', 'postLink:true']);
    assert.deepEqual(linkedMixinNames, rawLinkedMixinNames);
    assert.deepEqual(linkedMixinNames, ['localBadge', 'shared']);
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
  const rustOut = rustIsmd._link(JSON.parse(JSON.stringify(input)));
  assert.equal(serializers.compareStructured(rawOut, rustOut).ok, true);
  assert.equal(rustOut.nodes[0].nodes[0].ignore, true);
});

test('Step 4C.6: Source locations preserved in compile errors and runtime debug frames across include/extends', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-step4c-loc-'));
  try {
    for (const ext of ['ismd', 'pug']) {
      fs.writeFileSync(path.join(tmpDir, `base.${ext}`), 'html\n  body\n    block main', 'utf8');
      fs.writeFileSync(path.join(tmpDir, `boom.${ext}`), 'p ok\np= missingObj.prop', 'utf8');
    }
    const badSrc = 'extends base\nblock nope\n  p hi';

    let rawErr, rustErr;
    try { rawIsmd.compile(badSrc, { filename: path.join(tmpDir, 'bad.pug') }); } catch (e) { rawErr = e; }
    try { rustIsmd.compile(badSrc, { filename: path.join(tmpDir, 'bad.pug') }); } catch (e) { rustErr = e; }
    assert.equal(rustErr.code, 'ISMD:UNEXPECTED_BLOCK');
    assert.equal(rustErr.code, rawErr.code);
    assert.equal(rustErr.line, rawErr.line);
    assert.equal(rustErr.filename, rawErr.filename.replace(/\.pug$/, '.pug'));
    assert.equal(rustErr.msg, rawErr.msg);

    const okSrc = 'extends base\nblock main\n  include boom';

    let rawRtErr, rustRtErr;
    try { rawIsmd.compile(okSrc, { filename: path.join(tmpDir, 'ok.pug'), compileDebug: true })(); } catch (e) { rawRtErr = e; }
    try { rustIsmd.compile(okSrc, { filename: path.join(tmpDir, 'ok.pug'), compileDebug: true })(); } catch (e) { rustRtErr = e; }
    assert.ok(rawRtErr && rustRtErr);
    assert.ok(rustRtErr.message.includes('boom.pug:2'), `expected boom.pug:2 in ${rustRtErr.message}`);
    assert.equal(rustRtErr.path, rawRtErr.path.replace(/\.pug$/, '.pug'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
