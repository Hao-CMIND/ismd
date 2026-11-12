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
    const compiled = compiler.compileEntries(pages, { parallel: false });
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

    // Phase 3D: Rayon parallel vs serial deterministic parity across 32 pages
    const manyPages = [];
    for (let i = 1; i <= 32; i++) {
      const p = path.join(dir, `par${i}.pug`);
      fs.writeFileSync(p, `extends layout.pug\nblock content\n  p Parallel ${i} #{name}\n`, 'utf8');
      manyPages.push(p);
    }
    const serialOut = pug.compileBatch(
      manyPages,
      { basedir: dir, compileDebug: false },
      { parallel: false }
    );
    const parallelOut = pug.compileBatch(
      manyPages,
      { basedir: dir, compileDebug: false },
      { parallel: true }
    );
    assert.equal(serialOut.length, 32);
    assert.equal(parallelOut.length, 32);
    for (let i = 0; i < 32; i++) {
      assert.equal(parallelOut[i].id, serialOut[i].id);
      assert.equal(parallelOut[i].body, serialOut[i].body);
      assert.equal(parallelOut[i].fn({ name: 'OK' }), serialOut[i].fn({ name: 'OK' }));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 4C: createCompiler incremental HMR (noop, single page, header, layout, compileAffected)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-hmr-'));
  try {
    const headerPath = path.join(dir, 'header.pug');
    const footerPath = path.join(dir, 'footer.pug');
    const layoutPath = path.join(dir, 'layout.pug');
    const initialHeader = 'header.site InitialHeader\n';
    const initialFooter = 'footer.site InitialFooter\n';
    const initialLayout =
      'html\n  body\n    include header.pug\n    block content\n    include footer.pug\n';
    fs.writeFileSync(headerPath, initialHeader, 'utf8');
    fs.writeFileSync(footerPath, initialFooter, 'utf8');
    fs.writeFileSync(layoutPath, initialLayout, 'utf8');

    const pages = [];
    for (let i = 1; i <= 10; i++) {
      const p = path.join(dir, `page${i}.pug`);
      fs.writeFileSync(p, `extends layout.pug\nblock content\n  p Page ${i} #{name}\n`, 'utf8');
      pages.push(p);
    }

    const compiler = pug.createCompiler({ basedir: dir, compileDebug: false });
    const initial = compiler.compileEntries(pages);
    assert.equal(initial.length, 10);

    // 1. Identical source update => no-op
    const noopReport = compiler.updateFiles({ [headerPath]: initialHeader });
    assert.equal(noopReport.changed, false);
    assert.deepEqual(noopReport.changedFiles, []);
    assert.deepEqual(noopReport.invalidatedTemplates, []);
    assert.deepEqual(noopReport.affectedEntries, []);
    assert.deepEqual(compiler.getAffectedEntries(), []);
    assert.deepEqual(compiler.compileAffected(), []);

    // 2. Single page update => only 1 affected entry
    const pageReport = compiler.updateFiles({
      [pages[2]]: 'extends layout.pug\nblock content\n  p Page 3 Hot #{name}\n',
    });
    assert.equal(pageReport.changed, true);
    assert.deepEqual(pageReport.affectedEntries, [pages[2]]);
    assert.deepEqual(compiler.getAffectedEntries(), [pages[2]]);
    const pageRebuilt = compiler.compileAffected();
    assert.equal(pageRebuilt.length, 1);
    assert.equal(pageRebuilt[0].id, pages[2]);
    assert.ok(pageRebuilt[0].fn({ name: 'HMR' }).includes('Page 3 Hot HMR'));
    assert.deepEqual(compiler.getAffectedEntries(), []);

    // 3. Header update => all 10 entries affected
    const headerReport = compiler.updateFiles({
      [headerPath]: 'header.site UpdatedHeader\n',
    });
    assert.equal(headerReport.changed, true);
    assert.equal(headerReport.affectedEntries.length, 10);
    const headerRebuilt = compiler.compileAffected();
    assert.equal(headerRebuilt.length, 10);
    assert.ok(headerRebuilt[0].fn({ name: 'HMR' }).includes('UpdatedHeader'));
    assert.ok(headerRebuilt[2].fn({ name: 'HMR' }).includes('Page 3 Hot HMR'));

    // 4. Layout update => all 10 entries affected
    const layoutReport = compiler.updateFiles({
      [layoutPath]:
        'html\n  body.v2\n    include header.pug\n    block content\n    include footer.pug\n',
    });
    assert.equal(layoutReport.changed, true);
    assert.equal(layoutReport.affectedEntries.length, 10);
    const layoutRebuilt = compiler.compileAffected();
    assert.equal(layoutRebuilt.length, 10);
    assert.ok(layoutRebuilt[9].fn({ name: 'HMR' }).includes('class="v2"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 4D: CompiledOutputCache and JS fnCache skip codegen and new Function for unchanged pages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-outcache-'));
  try {
    const headerPath = path.join(dir, 'header.pug');
    const layoutPath = path.join(dir, 'layout.pug');
    fs.writeFileSync(headerPath, 'header.site H1\n', 'utf8');
    fs.writeFileSync(layoutPath, 'html\n  body\n    include header.pug\n    block content\n', 'utf8');

    const pages = [];
    for (let i = 1; i <= 10; i++) {
      const p = path.join(dir, `p${i}.pug`);
      fs.writeFileSync(p, `extends layout.pug\nblock content\n  p P${i}\n`, 'utf8');
      pages.push(p);
    }

    const compiler = pug.createCompiler({ basedir: dir, compileDebug: false });
    const first = compiler.compileEntries(pages);
    assert.equal(first.length, 10);
    assert.equal(first.every((r) => !r.cacheHit), true);
    const st1 = compiler.stats();
    assert.equal(st1.outputCacheMisses, 10);
    assert.equal(st1.outputCacheHits, 0);

    // Re-running compileEntries on all 10 pages hits CompiledOutputCache & reuses exact fn references
    const second = compiler.compileEntries(pages);
    assert.equal(second.length, 10);
    assert.equal(second.every((r) => r.cacheHit), true);
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(second[i].fn, first[i].fn);
    }
    const st2 = compiler.stats();
    assert.equal(st2.outputCacheHits, 10);
    assert.equal(st2.outputCacheMisses, 10);

    // Updating 1 page and re-compiling all 10 hits cache on 9 and misses on 1
    compiler.updateFiles({
      [pages[4]]: 'extends layout.pug\nblock content\n  p P5-v2\n',
    });
    const third = compiler.compileEntries(pages);
    assert.equal(third[4].cacheHit, false);
    assert.notStrictEqual(third[4].fn, first[4].fn);
    assert.ok(third[4].fn({}).includes('P5-v2'));
    for (let i = 0; i < 10; i++) {
      if (i !== 4) {
        assert.equal(third[i].cacheHit, true);
        assert.strictEqual(third[i].fn, first[i].fn);
      }
    }

    // Updating header.pug invalidates all 10 via dep_versions check
    compiler.updateFiles({
      [headerPath]: 'header.site H2\n',
    });
    const fourth = compiler.compileEntries(pages);
    assert.equal(fourth.every((r) => !r.cacheHit), true);
    assert.ok(fourth[0].fn({}).includes('H2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
