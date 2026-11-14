import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pug from '../../index.js';

test('JS API: Simple API + Advanced createCompiler removeFiles & dispose lifecycle', () => {
  // Simple API
  assert.equal(pug.render('p Hello #{name}', { name: 'World' }), '<p>Hello World</p>');
  const fn = pug.compile('div= count');
  assert.equal(fn({ count: 42 }), '<div>42</div>');
  assert.ok(pug.compileClient('p Client').includes('function template'));

  // Advanced API: removeFiles + dispose
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-js-api-'));
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
