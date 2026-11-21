import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ismd from '../../index.mjs';

function mb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

test('Phase 5F: 100-page + 10,000 mixed updates long-running memory & cache stability + dispose', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-stability-'));
  const layoutPath = path.join(dir, 'layout.pug');
  const headerPath = path.join(dir, 'header.pug');
  const footerPath = path.join(dir, 'footer.pug');

  fs.writeFileSync(headerPath, 'header.site-header Header v0\n', 'utf8');
  fs.writeFileSync(footerPath, 'footer.site-footer Footer v0\n', 'utf8');
  fs.writeFileSync(
    layoutPath,
    'doctype html\nhtml\n  body\n    include header.pug\n    block content\n    include footer.pug\n',
    'utf8'
  );

  const pageCount = 100;
  const pagePaths = [];
  for (let i = 0; i < pageCount; i += 1) {
    const p = path.join(dir, `page-${String(i).padStart(3, '0')}.pug`);
    fs.writeFileSync(p, `extends layout.pug\nblock content\n  main Page ${i} v0\n`, 'utf8');
    pagePaths.push(p);
  }

  const compiler = ismd.createCompiler({ basedir: dir, compileDebug: false });
  const snapshots = [];

  try {
    const initial = compiler.compileBatch(pagePaths);
    assert.equal(initial.length, pageCount);

    const recordSnapshot = (step) => {
      if (typeof global.gc === 'function') global.gc();
      const mem = process.memoryUsage();
      const st = compiler.stats();
      snapshots.push({
        step,
        rssMB: mb(mem.rss),
        heapUsedMB: mb(mem.heapUsed),
        externalMB: mb(mem.external),
        sources: st.sources,
        parsed: st.parsed,
        outputs: st.outputs,
        fnCache: st.fnCache,
        dagNodes: st.dagNodes,
        dagEdges: st.dagEdges,
      });
    };

    recordSnapshot(0);

    let tempIdx = 0;
    for (let i = 1; i <= 10000; i += 1) {
      const mod = i % 20;
      if (mod === 0) {
        // No-op watcher event (identical content)
        const p = pagePaths[i % pageCount];
        const rep = compiler.updateFiles([{ path: p, source: fs.readFileSync(p, 'utf8') }]);
        assert.equal(rep.changed, false);
      } else if (mod === 5) {
        // Include update (every 20th step -> 500 times)
        const src = `header.site-header Header v${i}\n`;
        fs.writeFileSync(headerPath, src, 'utf8');
        const rep = compiler.updateFiles([{ path: headerPath, source: src }]);
        assert.equal(rep.changed, true);
        compiler.compileAffected();
      } else if (mod === 10) {
        // Layout update (every 20th step -> 500 times)
        const src = `doctype html\nhtml\n  body(data-rev="${i}")\n    include header.pug\n    block content\n    include footer.pug\n`;
        fs.writeFileSync(layoutPath, src, 'utf8');
        const rep = compiler.updateFiles([{ path: layoutPath, source: src }]);
        assert.equal(rep.changed, true);
        compiler.compileAffected();
      } else if (mod === 15) {
        // Add -> compile -> Rename -> Remove cycle
        tempIdx += 1;
        const addPath = path.join(dir, `temp-${tempIdx}.pug`);
        const renPath = path.join(dir, `temp-renamed-${tempIdx}.pug`);
        const addSrc = `extends layout.pug\nblock content\n  main Temp ${tempIdx}\n`;
        fs.writeFileSync(addPath, addSrc, 'utf8');
        compiler.updateFiles([{ path: addPath, source: addSrc }]);
        compiler.compileEntries([{ id: addPath, filename: addPath, source: addSrc }]);

        fs.renameSync(addPath, renPath);
        compiler.removeFiles([addPath]);
        compiler.updateFiles([{ path: renPath, source: addSrc }]);
        compiler.compileEntries([{ id: renPath, filename: renPath, source: addSrc }]);

        fs.unlinkSync(renPath);
        compiler.removeFiles([renPath]);
      } else {
        // Single page edit (atomic save simulation for odd steps)
        const idx = i % pageCount;
        const p = pagePaths[idx];
        const src = `extends layout.pug\nblock content\n  main Page ${idx} v${i}\n`;
        if (i % 2 === 1) {
          const tmp = `${p}.tmp`;
          fs.writeFileSync(tmp, src, 'utf8');
          fs.renameSync(tmp, p);
        } else {
          fs.writeFileSync(p, src, 'utf8');
        }
        const rep = compiler.updateFiles([{ path: p, source: src }]);
        assert.equal(rep.changed, true);
        const affected = compiler.compileAffected();
        assert.equal(affected.length, 1);
      }

      if (i === 2500 || i === 5000 || i === 7500 || i === 10000) {
        recordSnapshot(i);
      }
    }

    // Verify bounded cache sizes (no leak from 500 add/rename/delete cycles)
    const finalSnap = snapshots[snapshots.length - 1];
    const startSnap = snapshots[0];
    console.log('# Phase 5F 10,000-update stability snapshots:', JSON.stringify(snapshots));

    assert.ok(finalSnap.sources <= 110, `sources leaked: ${finalSnap.sources}`);
    assert.ok(finalSnap.parsed <= 110, `parsed leaked: ${finalSnap.parsed}`);
    assert.ok(finalSnap.outputs <= 110, `outputs leaked: ${finalSnap.outputs}`);
    assert.ok(finalSnap.fnCache <= 110, `fnCache leaked: ${finalSnap.fnCache}`);
    assert.ok(finalSnap.dagNodes <= 110, `dagNodes leaked: ${finalSnap.dagNodes}`);

    const heapGrowthMB = finalSnap.heapUsedMB - startSnap.heapUsedMB;
    assert.ok(heapGrowthMB < 80, `heapUsed grew too much: ${heapGrowthMB.toFixed(2)} MB`);

    // Verify dispose lifecycle
    compiler.dispose();
    assert.equal(compiler.isDisposed, true);
    const disposedStats = compiler.stats();
    assert.equal(disposedStats.sources, 0);
    assert.equal(disposedStats.parsed, 0);
    assert.equal(disposedStats.outputs, 0);
    assert.equal(disposedStats.fnCache, 0);
    assert.equal(disposedStats.dagNodes, 0);
    assert.equal(disposedStats.dagEdges, 0);
    assert.throws(() => compiler.compileAffected(), /disposed/i);
    assert.throws(() => compiler.updateFiles([]), /disposed/i);
  } finally {
    if (!compiler.isDisposed) compiler.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
