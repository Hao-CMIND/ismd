import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ismd from '../../index.mjs';

test('Phase 3C: createCompiler and compileBatch share layout/includes across batch and support updateFiles/invalidateFiles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-session-'));
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

    const compiler = ismd.createCompiler({ basedir: dir, compileDebug: false });
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
    const batch = ismd.compileBatch(pages.slice(0, 3), { basedir: dir, compileDebug: false });
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
    const serialOut = ismd.compileBatch(
      manyPages,
      { basedir: dir, compileDebug: false },
      { parallel: false }
    );
    const parallelOut = ismd.compileBatch(
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-hmr-'));
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

    const compiler = ismd.createCompiler({ basedir: dir, compileDebug: false });
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
    assert.deepEqual(pageReport.invalidatedTemplates, [pages[2]]);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-outcache-'));
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

    const compiler = ismd.createCompiler({ basedir: dir, compileDebug: false });
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

test('createCompiler with JS hook plugins honors updateFiles virtual sources, incremental compileAffected, invalidateFiles, removeFiles, and wrap:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-hook-session-'));
  try {
    const partialPath = path.join(dir, 'part.pug');
    const page1Path = path.join(dir, 'page1.pug');
    const page2Path = path.join(dir, 'page2.pug');
    fs.writeFileSync(partialPath, 'span DISK_PART\n', 'utf8');
    fs.writeFileSync(page1Path, 'div\n  | DISK_PAGE1\n  include part.pug\n', 'utf8');
    fs.writeFileSync(page2Path, 'div\n  | DISK_PAGE2\n', 'utf8');

    let preLexCalls = 0;
    const compiler = ismd.createCompiler({
      basedir: dir,
      compileDebug: false,
      plugins: [
        {
          preLex(src) {
            preLexCalls++;
            return src;
          },
        },
      ],
    });

    // 1. Virtual entry source via updateFiles BEFORE compileEntries is honored (not disk content)
    compiler.updateFiles({
      [page1Path]: 'div\n  | VIRTUAL_PAGE1\n  include part.pug\n',
    });
    const initial = compiler.compileEntries([page1Path, page2Path]);
    assert.equal(initial.length, 2);
    assert.equal(initial[0].ok, true);
    assert.equal(initial[0].fn({}), '<div>VIRTUAL_PAGE1<span>DISK_PART</span></div>');
    assert.equal(initial[1].fn({}), '<div>DISK_PAGE2</div>');
    assert.ok(preLexCalls >= 3);

    // 2. Identical virtual update is a no-op
    const noop = compiler.updateFiles({
      [page1Path]: 'div\n  | VIRTUAL_PAGE1\n  include part.pug\n',
    });
    assert.equal(noop.changed, false);
    assert.deepEqual(compiler.getAffectedEntries(), []);
    assert.deepEqual(compiler.compileAffected(), []);

    // 3. Updating virtual dependency marks only dependent entry affected and recompiles with virtual dep
    const depReport = compiler.updateFiles({
      [partialPath]: 'span VIRTUAL_PART\n',
    });
    assert.equal(depReport.changed, true);
    assert.deepEqual(depReport.affectedEntries, [page1Path]);
    assert.deepEqual(compiler.getAffectedEntries(), [page1Path]);
    const depRebuilt = compiler.compileAffected();
    assert.equal(depRebuilt.length, 1);
    assert.equal(depRebuilt[0].id, page1Path);
    assert.equal(depRebuilt[0].fn({}), '<div>VIRTUAL_PAGE1<span>VIRTUAL_PART</span></div>');
    assert.deepEqual(compiler.getAffectedEntries(), []);

    // 4. Disk update + invalidateFiles drops virtual override, marks affected, and compileAffected reads disk
    fs.writeFileSync(partialPath, 'span DISK_PART_V2\n', 'utf8');
    const invReport = compiler.invalidateFiles(partialPath);
    assert.equal(invReport.changed, true);
    assert.deepEqual(invReport.affectedEntries, [page1Path]);
    assert.deepEqual(compiler.getAffectedEntries(), [page1Path]);
    const invRebuilt = compiler.compileAffected();
    assert.equal(invRebuilt.length, 1);
    assert.equal(invRebuilt[0].fn({}), '<div>VIRTUAL_PAGE1<span>DISK_PART_V2</span></div>');

    // 5. wrap: false in compileEntries, compileAffected, and compileBatch omits fn and returns body
    const rawBatch = compiler.compileEntries([page2Path], { wrap: false });
    assert.equal(rawBatch.length, 1);
    assert.equal(rawBatch[0].ok, true);
    assert.equal(rawBatch[0].fn, undefined);
    assert.equal(typeof rawBatch[0].body, 'string');
    assert.ok(rawBatch[0].body.includes('DISK_PAGE2'));

    compiler.updateFiles({ [page2Path]: 'div\n  | VIRTUAL_PAGE2\n' });
    const rawAffected = compiler.compileAffected({ wrap: false });
    assert.equal(rawAffected.length, 1);
    assert.equal(rawAffected[0].ok, true);
    assert.equal(rawAffected[0].fn, undefined);
    assert.equal(typeof rawAffected[0].body, 'string');
    assert.ok(rawAffected[0].body.includes('VIRTUAL_PAGE2'));

    const oneShotRaw = ismd.compileBatch(
      [{ id: 'custom', filename: page2Path, source: 'p= msg' }],
      { compileDebug: false, templateName: 'myTpl', plugins: [{ preLex: (s) => s }] },
      { wrap: false }
    );
    assert.equal(oneShotRaw.length, 1);
    assert.equal(oneShotRaw[0].ok, true);
    assert.equal(oneShotRaw[0].fn, undefined);
    assert.ok(oneShotRaw[0].body.includes('function myTpl('));

    // 6. removeFiles removes entry from tracking
    compiler.removeFiles(page2Path);
    compiler.invalidateFiles(page2Path);
    assert.deepEqual(compiler.getAffectedEntries(), []);

    // 7. Entry failing on first compileEntries (throwOnError: true) is still registered for invalidateFiles/compileAffected
    const brokenPath = path.join(dir, 'broken.pug');
    fs.writeFileSync(brokenPath, 'div(\n', 'utf8');
    assert.throws(() => compiler.compileEntries([brokenPath]));
    fs.writeFileSync(brokenPath, 'div FIXED\n', 'utf8');
    const fixInv = compiler.invalidateFiles(brokenPath);
    assert.equal(fixInv.changed, true);
    assert.deepEqual(fixInv.affectedEntries, [brokenPath]);
    assert.deepEqual(compiler.getAffectedEntries(), [brokenPath]);
    const fixRebuilt = compiler.compileAffected();
    assert.equal(fixRebuilt.length, 1);
    assert.equal(fixRebuilt[0].ok, true);
    assert.equal(fixRebuilt[0].fn({}), '<div>FIXED</div>');
    assert.deepEqual(compiler.getAffectedEntries(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Per-entry options merge with defaultOptions in both native and JS-hook fallback paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-entry-opts-merge-'));
  globalThis.ISMD_MERGE_GLOBAL = 'G_OK';
  try {
    const incPath = path.join(dir, 'inc.pug');
    const pagePath = path.join(dir, 'page.pug');
    fs.writeFileSync(incPath, 'br\nspan= ISMD_MERGE_GLOBAL\n', 'utf8');
    fs.writeFileSync(pagePath, 'div\n  include /inc.pug\n', 'utf8');

    const baseOpts = {
      basedir: dir,
      doctype: 'xml',
      compileDebug: false,
      globals: ['ISMD_MERGE_GLOBAL'],
    };

    // 1. Native createCompiler & compileBatch
    const nativeCompiler = ismd.createCompiler(baseOpts);
    try {
      const [resNative] = nativeCompiler.compileEntries([
        { filename: pagePath, options: { pretty: true } },
      ]);
      assert.equal(resNative.ok, true);
      const htmlNative = resNative.fn({});
      assert.ok(htmlNative.includes('<br></br>') || htmlNative.includes('<br/>'), `expected xml doctype preserved, got: ${htmlNative}`);
      assert.ok(htmlNative.includes('G_OK'), `expected globals preserved, got: ${htmlNative}`);
      assert.ok(htmlNative.includes('\n'), `expected pretty:true applied, got: ${htmlNative}`);

      const [resBatch] = ismd.compileBatch(
        [{ filename: pagePath, options: { pretty: true } }],
        baseOpts
      );
      assert.equal(resBatch.ok, true);
      assert.equal(resBatch.fn({}), htmlNative);

      // 2. JS-hook fallback createCompiler & compileBatch produce identical HTML
      const hookOpts = { ...baseOpts, plugins: [{ preLex: (s) => s }] };
      const hookCompiler = ismd.createCompiler(hookOpts);
      try {
        const [resHook] = hookCompiler.compileEntries([
          { filename: pagePath, options: { pretty: true } },
        ]);
        assert.equal(resHook.ok, true);
        assert.equal(resHook.fn({}), htmlNative);
      } finally {
        hookCompiler.dispose();
      }

      const [resHookBatch] = ismd.compileBatch(
        [{ filename: pagePath, options: { pretty: true } }],
        hookOpts
      );
      assert.equal(resHookBatch.ok, true);
      assert.equal(resHookBatch.fn({}), htmlNative);
    } finally {
      nativeCompiler.dispose();
    }
  } finally {
    delete globalThis.ISMD_MERGE_GLOBAL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Step 7 & 8: Incremental DAG recovery across delete/recreate/ENOENT and single-entry options in compileAffected', () => {
  // Test #8: compileAffected preserves single-entry options (e.g. inlineRuntimeFunctions override)
  {
    const compiler = ismd.createCompiler({ inlineRuntimeFunctions: true });
    try {
      const res = compiler.compileEntries([
        { id: 'custom-inline', source: 'p before', options: { inlineRuntimeFunctions: false } },
      ]);
      assert.equal(res[0].ok, true);
      assert.equal(res[0].fn(), '<p>before</p>');

      compiler.updateFiles({
        'custom-inline': 'p after',
      });
      const affected = compiler.getAffectedEntries();
      assert.deepEqual(affected, ['custom-inline']);
      const updated = compiler.compileAffected();
      assert.equal(updated.length, 1);
      assert.equal(updated[0].ok, true);
      assert.equal(updated[0].fn(), '<p>after</p>');
    } finally {
      compiler.dispose();
    }
  }

  // Test #7 Part A: 5 pages share include, file is deleted (ENOENT) then recreated
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-test7-recreate-'));
    try {
      const headerPath = path.join(dir, 'header.pug');
      fs.writeFileSync(headerPath, 'header MyHeader\n', 'utf8');

      const pages = [];
      for (let i = 0; i < 5; i++) {
        const p = path.join(dir, `page${i}.pug`);
        fs.writeFileSync(p, 'include header.pug\np content\n', 'utf8');
        pages.push(p);
      }

      const compiler = ismd.createCompiler({ basedir: dir, compileDebug: false });
      try {
        const init = compiler.compileEntries(pages);
        assert.equal(init.length, 5);
        assert.ok(init[0].fn().includes('MyHeader'));

        // 1. Remove header from disk and notify compiler
        fs.unlinkSync(headerPath);
        compiler.removeFiles([headerPath]);

        const afterRemoveAffected = compiler.getAffectedEntries();
        assert.equal(afterRemoveAffected.length, 5);

        const failedCompile = compiler.compileAffected({ throwOnError: false });
        assert.equal(failedCompile.length, 5);
        assert.equal(failedCompile[0].ok, false);

        // 2. Recreate header and update compiler
        fs.writeFileSync(headerPath, 'header RecreatedHeader\n', 'utf8');
        compiler.updateFiles({
          [headerPath]: 'header RecreatedHeader\n',
        });

        const recoveredAffected = compiler.getAffectedEntries();
        assert.equal(recoveredAffected.length, 5);

        const recovered = compiler.compileAffected();
        assert.equal(recovered.length, 5);
        assert.equal(recovered[0].ok, true);
        assert.ok(recovered[0].fn().includes('RecreatedHeader'));
      } finally {
        compiler.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Test #7 Part B: Initial include is missing (ENOENT), then created later
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-test7-enoent-init-'));
    try {
      const headerPath = path.join(dir, 'header.pug');
      const pagePath = path.join(dir, 'page.pug');
      fs.writeFileSync(pagePath, 'include header.pug\np page\n', 'utf8');

      const compiler = ismd.createCompiler({ basedir: dir, compileDebug: false });
      try {
        const init = compiler.compileEntries([pagePath], { throwOnError: false });
        assert.equal(init.length, 1);
        assert.equal(init[0].ok, false);
        assert.equal(init[0].error.code, 'ENOENT');

        // Create missing include
        fs.writeFileSync(headerPath, 'h1 HeaderNowCreated\n', 'utf8');
        compiler.updateFiles({
          [headerPath]: 'h1 HeaderNowCreated\n',
        });

        const affected = compiler.getAffectedEntries();
        assert.equal(affected.length, 1);
        assert.equal(path.resolve(affected[0]), path.resolve(pagePath));

        const recovered = compiler.compileAffected();
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].ok, true);
        assert.ok(recovered[0].fn().includes('HeaderNowCreated'));
      } finally {
        compiler.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

