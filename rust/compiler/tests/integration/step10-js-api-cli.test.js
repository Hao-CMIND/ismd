import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pug from '../../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../../../cli/index.js');

test('Phase 5B: Simple JS API + Advanced createCompiler removeFiles & dispose lifecycle', () => {
  // Simple API
  assert.equal(pug.render('p Hello #{name}', { name: 'World' }), '<p>Hello World</p>');
  const fn = pug.compile('div= count');
  assert.equal(fn({ count: 42 }), '<div>42</div>');
  assert.ok(pug.compileClient('p Client').includes('function template'));

  // Advanced API: removeFiles + dispose
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-5b-'));
  try {
    const p1 = path.join(dir, 'a.pug');
    const p2 = path.join(dir, 'b.pug');
    fs.writeFileSync(p1, 'p A\n', 'utf8');
    fs.writeFileSync(p2, 'p B\n', 'utf8');

    const compiler = pug.createCompiler({ basedir: dir, compileDebug: false });
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

test('Phase 5C: CLI compiles single file and multi-page directory batch via CompilerSession', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-cli-'));
  try {
    const srcDir = path.join(dir, 'src');
    const outDir = path.join(dir, 'dist');
    const layoutsDir = path.join(dir, 'layouts');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(layoutsDir, { recursive: true });

    fs.writeFileSync(
      path.join(layoutsDir, 'base.pug'),
      'html\n  body\n    block content\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(srcDir, 'index.pug'),
      'extends ../layouts/base.pug\nblock content\n  h1 Home #{site}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(srcDir, 'about.pug'),
      'extends ../layouts/base.pug\nblock content\n  h1 About #{site}\n',
      'utf8'
    );

    execFileSync(
      process.execPath,
      [
        cliPath,
        srcDir,
        '--out',
        outDir,
        '--basedir',
        dir,
        '--obj',
        JSON.stringify({ site: 'PugRust' }),
      ],
      { encoding: 'utf8' }
    );

    const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const aboutHtml = fs.readFileSync(path.join(outDir, 'about.html'), 'utf8');
    assert.equal(indexHtml, '<html><body><h1>Home PugRust</h1></body></html>');
    assert.equal(aboutHtml, '<html><body><h1>About PugRust</h1></body></html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
