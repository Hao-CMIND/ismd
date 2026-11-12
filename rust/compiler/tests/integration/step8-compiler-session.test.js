import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pug from '../../index.js';

test('Phase 3C: createCompiler and compileBatch share layout/includes across batch and support updateFiles/invalidateFiles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-session-'));
  try {
    const headerPath = path.join(dir, 'header.pug');
    const footerPath = path.join(dir, 'footer.pug');
    const layoutPath = path.join(dir, 'layout.pug');
    fs.writeFileSync(headerPath, 'header.site InitialHeader\n', 'utf8');
    fs.writeFileSync(footerPath, 'footer.site InitialFooter\n', 'utf8');
    fs.writeFileSync(
      layoutPath,
      'html\n  body\n    include header.pug\n    block content\n    include footer.pug\n',
      'utf8'
    );

    const pages = [];
    for (let i = 1; i <= 10; i++) {
      const p = path.join(dir, `page${i}.pug`);
      fs.writeFileSync(p, `extends layout.pug\nblock content\n  p Page ${i} #{name}\n`, 'utf8');
      pages.push(p);
    }

    const compiler = pug.createCompiler({ basedir: dir, compileDebug: false });
    const compiled = compiler.compileEntries(pages);
    assert.equal(compiled.length, 10);
    for (let i = 0; i < 10; i++) {
      assert.equal(compiled[i].ok, true);
      const html = compiled[i].fn({ name: 'World' });
      assert.ok(html.includes('InitialHeader'));
      assert.ok(html.includes(`Page ${i + 1} World`));
      assert.equal(compiled[i].dependencies.length, 3);
    }

    const stats1 = compiler.stats();
    assert.equal(stats1.sources, 13);
    assert.equal(stats1.sourceMisses, 13);
    assert.equal(stats1.sourceHits, 27);
    assert.equal(stats1.parseHits, 27);

    // Virtual update via updateFiles
    compiler.updateFiles({
      [headerPath]: 'header.site HotHeader\n',
    });
    const updated = compiler.compileEntries([pages[0], pages[9]]);
    assert.ok(updated[0].fn({ name: 'HMR' }).includes('HotHeader'));
    assert.ok(updated[1].fn({ name: 'HMR' }).includes('HotHeader'));

    // Disk update + invalidateFiles
    fs.writeFileSync(footerPath, 'footer.site DiskFooter\n', 'utf8');
    compiler.invalidateFiles(footerPath);
    const reloaded = compiler.compileEntries([pages[0]]);
    assert.ok(reloaded[0].fn({ name: 'Reload' }).includes('DiskFooter'));

    // One-shot compileBatch
    const batch = pug.compileBatch(pages.slice(0, 3), { basedir: dir, compileDebug: false });
    assert.equal(batch.length, 3);
    assert.ok(batch[2].fn({ name: 'Batch' }).includes('Page 3 Batch'));

    // throwOnError: false captures ENOENT cleanly
    const errRes = compiler.compileEntries([path.join(dir, 'missing.pug')], {
      throwOnError: false,
    });
    assert.equal(errRes.length, 1);
    assert.equal(errRes[0].ok, false);
    assert.equal(errRes[0].error.code, 'ENOENT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
