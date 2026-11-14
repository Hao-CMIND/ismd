import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rawPug = require('../../../raw/compiler/packages/pug/lib/index.js');
import rustPug from '../../index.js';

const ROUNDS = 7;
const PAGE_COUNTS = [10, 50, 100];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return Number(sorted[idx].toFixed(3));
}

function getBinaryHash() {
  const addonPath = path.resolve(import.meta.dirname, '../../pug-napi.win32-x64-msvc.node');
  if (!fs.existsSync(addonPath)) return null;
  const buf = fs.readFileSync(addonPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getRustVersion() {
  try {
    return execSync('rustc --version', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function createProject(dir, count) {
  const headerPath = path.join(dir, 'header.pug');
  const footerPath = path.join(dir, 'footer.pug');
  const layoutPath = path.join(dir, 'layout.pug');
  const headerSrc = 'header.site Header\n';
  const footerSrc = 'footer.site Footer\n';
  const layoutSrc =
    'html\n  body\n    include header.pug\n    block content\n    include footer.pug\n';
  fs.writeFileSync(headerPath, headerSrc, 'utf8');
  fs.writeFileSync(footerPath, footerSrc, 'utf8');
  fs.writeFileSync(layoutPath, layoutSrc, 'utf8');

  const pages = [];
  for (let i = 1; i <= count; i++) {
    const p = path.join(dir, `page${i}.pug`);
    fs.writeFileSync(
      p,
      `extends layout.pug\nblock content\n  main\n    h1 Page ${i}\n    p Hello #{name}\n`,
      'utf8'
    );
    pages.push(p);
  }
  return { headerPath, footerPath, layoutPath, headerSrc, footerSrc, layoutSrc, pages };
}

function benchRawFullBuild(pages, dir) {
  const samples = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (const p of pages) {
      rawPug.compileFile(p, { basedir: dir, compileDebug: false, cache: false });
    }
    samples.push(Number((performance.now() - t0).toFixed(3)));
  }
  return percentile(samples, 0.5);
}

function runForCount(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pug-inc-bench-${count}-`));
  try {
    const proj = createProject(dir, count);
    const { headerPath, layoutPath, headerSrc, layoutSrc, pages } = proj;
    const rawFullBuildP50Ms = benchRawFullBuild(pages, dir);

    const fullBuildSamples = [];
    const outputCacheHitSamples = [];
    const outputCache1PageChangedSamples = [];
    const changedSourceSamples = [];
    const pageChangeSamples = [];
    const includeChangeSamples = [];
    const layoutChangeSamples = [];
    const noopSamples = [];

    let pageMetrics = null;
    let includeMetrics = null;
    let layoutMetrics = null;
    let noopMetrics = null;
    let fullMetrics = null;
    let outputCacheHitMetrics = null;
    let outputCache1PageMetrics = null;

    // Warmup one full cycle
    {
      const c = rustPug.createCompiler({ basedir: dir, compileDebug: false });
      c.compileEntries(pages);
    }

    // 1. Full cold build & changed-source rebuild
    for (let r = 0; r < ROUNDS; r++) {
      const c = rustPug.createCompiler({ basedir: dir, compileDebug: false });
      const t0 = performance.now();
      const res = c.compileEntries(pages);
      fullBuildSamples.push(Number((performance.now() - t0).toFixed(3)));
      const st = c.stats();
      if (r === 0) {
        fullMetrics = {
          compileCount: res.length,
          napiCallCount: 1,
          jsNewFunctionCount: res.length,
          sourceCacheHit: st.sourceHits,
          sourceCacheMiss: st.sourceMisses,
          parseCacheHit: st.parseHits,
          parseCacheMiss: st.parseMisses,
          outputCacheHit: st.outputCacheHits,
          outputCacheMiss: st.outputCacheMisses,
        };
      }

      // Output cache hit: re-run compileEntries(pages) with no changes
      {
        const s0 = c.stats();
        const th0 = performance.now();
        const hitRes = c.compileEntries(pages);
        outputCacheHitSamples.push(Number((performance.now() - th0).toFixed(3)));
        const s1 = c.stats();
        if (r === 0) {
          const newFnCount = hitRes.filter((x) => !x.cacheHit).length;
          outputCacheHitMetrics = {
            compileCount: hitRes.length,
            napiCallCount: 1,
            jsNewFunctionCount: newFnCount,
            outputCacheHitDelta: s1.outputCacheHits - s0.outputCacheHits,
            outputCacheMissDelta: s1.outputCacheMisses - s0.outputCacheMisses,
          };
        }
      }

      // Output cache partial: change 1 page and re-run compileEntries(pages)
      {
        c.updateFiles({
          [pages[0]]: `extends layout.pug\nblock content\n  main\n    h1 Page 1\n    p Hello #{name}\n    //- outcache-round-${r}\n`,
        });
        const s0 = c.stats();
        const tp0 = performance.now();
        const partRes = c.compileEntries(pages);
        outputCache1PageChangedSamples.push(Number((performance.now() - tp0).toFixed(3)));
        const s1 = c.stats();
        if (r === 0) {
          const newFnCount = partRes.filter((x) => !x.cacheHit).length;
          outputCache1PageMetrics = {
            compileCount: partRes.length,
            napiCallCount: 1,
            jsNewFunctionCount: newFnCount,
            outputCacheHitDelta: s1.outputCacheHits - s0.outputCacheHits,
            outputCacheMissDelta: s1.outputCacheMisses - s0.outputCacheMisses,
          };
        }
      }

      // changed-source rebuild: mutate every page's source comment so source version changes
      const updates = {};
      for (let i = 0; i < pages.length; i++) {
        updates[pages[i]] =
          `extends layout.pug\nblock content\n  main\n    h1 Page ${i + 1}\n    p Hello #{name}\n    //- benchmark-round-${r}\n`;
      }
      const tc0 = performance.now();
      const rep = c.updateFiles(updates);
      const changedOut = c.compileAffected();
      changedSourceSamples.push(Number((performance.now() - tc0).toFixed(3)));
      if (changedOut.length !== count || rep.affectedEntries.length !== count) {
        throw new Error(`Expected ${count} changed-source rebuilds, got ${changedOut.length}`);
      }
    }

    // 2. Persistent session HMR tests (A: page, B: include, C: layout, D: noop, E: sequential)
    const session = rustPug.createCompiler({ basedir: dir, compileDebug: false });
    session.compileEntries(pages);
    const targetPage = pages[Math.floor(count / 2)];

    for (let r = 0; r < ROUNDS; r++) {
      // Test D: No-op watcher event (unchanged header.pug)
      {
        const s0 = session.stats();
        const t0 = performance.now();
        const rep = session.updateFiles({ [headerPath]: r === 0 ? headerSrc : `header.site Header v${r - 1}\n` });
        const out = session.compileAffected();
        noopSamples.push(Number((performance.now() - t0).toFixed(3)));
        const s1 = session.stats();
        if (r === 0) {
          noopMetrics = {
            changedFileCount: rep.changedFiles.length,
            invalidatedTemplateCount: rep.invalidatedTemplates.length,
            affectedEntryCount: rep.affectedEntries.length,
            compileCount: out.length,
            napiCallCount: out.length === 0 ? 0 : 1,
            jsNewFunctionCount: out.length,
            sourceCacheHitDelta: s1.sourceHits - s0.sourceHits,
            sourceCacheMissDelta: s1.sourceMisses - s0.sourceMisses,
            parseCacheHitDelta: s1.parseHits - s0.parseHits,
            parseCacheMissDelta: s1.parseMisses - s0.parseMisses,
          };
        }
      }

      // Test A: Single page change
      {
        const s0 = session.stats();
        const t0 = performance.now();
        const rep = session.updateFiles({
          [targetPage]: `extends layout.pug\nblock content\n  main\n    h1 Page Target\n    p Hello #{name}\n    //- page-round-${r}\n`,
        });
        const out = session.compileAffected();
        pageChangeSamples.push(Number((performance.now() - t0).toFixed(3)));
        const s1 = session.stats();
        if (r === 0) {
          pageMetrics = {
            changedFileCount: rep.changedFiles.length,
            invalidatedTemplateCount: rep.invalidatedTemplates.length,
            affectedEntryCount: rep.affectedEntries.length,
            compileCount: out.length,
            napiCallCount: out.length === 0 ? 0 : 1,
            jsNewFunctionCount: out.length,
            sourceCacheHitDelta: s1.sourceHits - s0.sourceHits,
            sourceCacheMissDelta: s1.sourceMisses - s0.sourceMisses,
            parseCacheHitDelta: s1.parseHits - s0.parseHits,
            parseCacheMissDelta: s1.parseMisses - s0.parseMisses,
          };
        }
      }

      // Test B: Include (header.pug) change
      {
        const s0 = session.stats();
        const t0 = performance.now();
        const rep = session.updateFiles({
          [headerPath]: `header.site Header v${r}\n`,
        });
        const out = session.compileAffected();
        includeChangeSamples.push(Number((performance.now() - t0).toFixed(3)));
        const s1 = session.stats();
        if (r === 0) {
          includeMetrics = {
            changedFileCount: rep.changedFiles.length,
            invalidatedTemplateCount: rep.invalidatedTemplates.length,
            affectedEntryCount: rep.affectedEntries.length,
            compileCount: out.length,
            napiCallCount: out.length === 0 ? 0 : 1,
            jsNewFunctionCount: out.length,
            sourceCacheHitDelta: s1.sourceHits - s0.sourceHits,
            sourceCacheMissDelta: s1.sourceMisses - s0.sourceMisses,
            parseCacheHitDelta: s1.parseHits - s0.parseHits,
            parseCacheMissDelta: s1.parseMisses - s0.parseMisses,
          };
        }
      }

      // Test C: Layout (layout.pug) change
      {
        const s0 = session.stats();
        const t0 = performance.now();
        const rep = session.updateFiles({
          [layoutPath]: `${layoutSrc}//- layout-round-${r}\n`,
        });
        const out = session.compileAffected();
        layoutChangeSamples.push(Number((performance.now() - t0).toFixed(3)));
        const s1 = session.stats();
        if (r === 0) {
          layoutMetrics = {
            changedFileCount: rep.changedFiles.length,
            invalidatedTemplateCount: rep.invalidatedTemplates.length,
            affectedEntryCount: rep.affectedEntries.length,
            compileCount: out.length,
            napiCallCount: out.length === 0 ? 0 : 1,
            jsNewFunctionCount: out.length,
            sourceCacheHitDelta: s1.sourceHits - s0.sourceHits,
            sourceCacheMissDelta: s1.sourceMisses - s0.sourceMisses,
            parseCacheHitDelta: s1.parseHits - s0.parseHits,
            parseCacheMissDelta: s1.parseMisses - s0.parseMisses,
          };
        }
      }
    }

    return {
      pages: count,
      rawFullBuildP50Ms,
      rustFullBuildP50Ms: percentile(fullBuildSamples, 0.5),
      outputCacheAllHitP50Ms: percentile(outputCacheHitSamples, 0.5),
      outputCache1PageChangedP50Ms: percentile(outputCache1PageChangedSamples, 0.5),
      rustChangedSourceRebuildP50Ms: percentile(changedSourceSamples, 0.5),
      pageChangeP50Ms: percentile(pageChangeSamples, 0.5),
      includeChangeP50Ms: percentile(includeChangeSamples, 0.5),
      layoutChangeP50Ms: percentile(layoutChangeSamples, 0.5),
      noopWatcherP50Ms: percentile(noopSamples, 0.5),
      metrics: {
        fullBuild: fullMetrics,
        outputCacheAllHit: outputCacheHitMetrics,
        outputCache1PageChanged: outputCache1PageMetrics,
        pageChange: pageMetrics,
        includeChange: includeMetrics,
        layoutChange: layoutMetrics,
        noopWatcher: noopMetrics,
      },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const phaseIdx = process.argv.indexOf('--phase');
const phaseLabel = phaseIdx >= 0 && process.argv[phaseIdx + 1] ? process.argv[phaseIdx + 1] : '4c';

const cpus = os.cpus();
const report = {
  metadata: {
    phase: phaseLabel,
    date: new Date().toISOString(),
    cpu: cpus[0] ? `${cpus[0].model} (${cpus.length} logical cores)` : 'unknown',
    nodeVersion: process.version,
    rustVersion: getRustVersion(),
    binaryHash: getBinaryHash(),
    rounds: ROUNDS,
    parallelMode: 'auto (threshold=8)',
  },
  results: {},
};

for (const count of PAGE_COUNTS) {
  report.results[`pages_${count}`] = runForCount(count);
}

const outPath = path.resolve(`benchmarks/diagnostics/incremental-phase${phaseLabel}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
