import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, percentile } from '../shared.mjs';

const DIAG_DIR = import.meta.dirname;
const DEFAULT_PROFILE_ADDON = path.resolve(
  REPO_ROOT,
  'compiler/target-profile/release/ismd_napi.dll'
);

const args = process.argv.slice(2);
const phaseIdx = args.indexOf('--phase');
const phaseLabel = phaseIdx !== -1 && args[phaseIdx + 1] ? args[phaseIdx + 1] : '3a';
const pageCounts = phaseLabel === '3d' ? [1, 10, 50, 100] : [10, 50];

function createSyntheticMpaProject(numPages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ismd-mpa-${numPages}-`));
  const headerPath = path.join(dir, 'header.pug');
  const footerPath = path.join(dir, 'footer.pug');
  const layoutPath = path.join(dir, 'layout.pug');

  fs.writeFileSync(
    headerPath,
    [
      'header.site-header(role="banner")',
      '  .container.header-inner',
      '    a.brand(href="/") Acme Portal',
      '    nav.main-nav(aria-label="Primary")',
      '      ul.nav-list',
      '        li.nav-item: a.nav-link(href="/") Home',
      '        li.nav-item: a.nav-link(href="/docs") Docs',
      '        li.nav-item: a.nav-link(href="/guides") Guides',
      '        li.nav-item: a.nav-link(href="/pricing") Pricing',
      '        li.nav-item: a.nav-link(href="/about") About',
      '',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    footerPath,
    [
      'footer.site-footer(role="contentinfo")',
      '  .container.footer-grid',
      '    .col',
      '      h4 Product',
      '      ul',
      '        li: a(href="/features") Features',
      '        li: a(href="/changelog") Changelog',
      '    .col',
      '      h4 Company',
      '      ul',
      '        li: a(href="/team") Team',
      '        li: a(href="/contact") Contact',
      '    p.copyright &copy; 2026 Acme Inc.',
      '',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    layoutPath,
    [
      'doctype html',
      'html(lang="en")',
      '  head',
      '    meta(charset="utf-8")',
      '    meta(name="viewport", content="width=device-width, initial-scale=1")',
      '    title #{title} | Acme Portal',
      '    block head',
      '  body.app-shell',
      '    include header.pug',
      '    main#main-content.container',
      '      block content',
      '    include footer.pug',
      '',
    ].join('\n'),
    'utf8'
  );

  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    const id = String(i).padStart(2, '0');
    const pagePath = path.join(dir, `page${id}.pug`);
    const src = [
      'extends layout.pug',
      'block content',
      `  section.page-section(data-page="${id}")`,
      `    h1.page-title Page ${id}: #{title}`,
      '    p.lead Welcome to synthetic benchmark page.',
      '    ul.item-list',
      `      li.item Alpha ${id}`,
      `      li.item Beta ${id}`,
      `      li.item Gamma ${id}`,
      '',
    ].join('\n');
    fs.writeFileSync(pagePath, src, 'utf8');
    pages.push({ id, pagePath, src });
  }

  return { dir, headerPath, footerPath, layoutPath, pages };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return percentile(s, 0.5);
}

function loadRawIsmd() {
  const require = createRequire(import.meta.url);
  return require(path.resolve(REPO_ROOT, 'raw/compiler/packages/ismd'));
}

async function loadRustIsmd({ profile = false } = {}) {
  if (profile) {
    process.env.ISMD_PROFILE = '1';
    process.env.ISMD_PROFILE_ADDON = DEFAULT_PROFILE_ADDON;
  } else {
    delete process.env.ISMD_PROFILE;
    delete process.env.ISMD_PROFILE_ADDON;
  }
  const url = pathToFileURL(path.resolve(REPO_ROOT, 'ismd/index.mjs')).href;
  const mod = await import(`${url}?profile=${profile ? 1 : 0}&t=${Date.now()}`);
  return mod.default;
}

function runRawPages(rawIsmd, project, basedir, rounds = 7) {
  // Warmup
  for (const p of project.pages) {
    const fn = rawIsmd.compileFile(p.pagePath, { basedir, cache: false });
    fn({ title: `T${p.id}` });
  }

  const compileMs = [];
  const outputs = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (const p of project.pages) {
      const fn = rawIsmd.compileFile(p.pagePath, { basedir, cache: false });
      if (r === 0) outputs.push(fn({ title: `T${p.id}` }));
    }
    compileMs.push(performance.now() - t0);
  }
  return { p50Ms: median(compileMs), outputs };
}

function runRustPages(
  rustIsmd,
  project,
  basedir,
  { mode = 'store', rounds = 7 } = {}
) {
  const runOnce = (collectOutputs = false) => {
    const store = mode === 'store' ? rustIsmd.createTemplateStore() : undefined;
    if (mode !== 'store') rustIsmd.clearDefaultTemplateStore();
    const outputs = collectOutputs ? [] : null;
    const t0 = performance.now();
    for (const p of project.pages) {
      if (mode === 'uncached') rustIsmd.clearDefaultTemplateStore();
      const opts = { basedir, cache: false };
      if (store) opts.templateStore = store;
      const fn = rustIsmd.compileFile(p.pagePath, opts);
      if (outputs) outputs.push(fn({ title: `T${p.id}` }));
    }
    return { elapsedMs: performance.now() - t0, outputs };
  };

  // Extra warmup round for JIT/FS/allocator stability
  runOnce(false);
  const warm = runOnce(true);
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    samples.push(runOnce(false).elapsedMs);
  }
  return {
    p50Ms: median(samples),
    samples: samples.map((v) => Number(v.toFixed(3))),
    outputs: warm.outputs,
  };
}

function runRustBatch(
  rustIsmd,
  project,
  basedir,
  { wrap = true, parallel = undefined, rounds = 7 } = {}
) {
  const entries = project.pages.map((p) => p.pagePath);
  const runOnce = (collectOutputs = false) => {
    const compiler = rustIsmd.createCompiler({ basedir, compileDebug: true });
    const t0 = performance.now();
    const res = compiler.compileEntries(entries, { wrap, parallel });
    const elapsedMs = performance.now() - t0;
    const outputs =
      collectOutputs && wrap
        ? res.map((r, idx) => r.fn({ title: `T${project.pages[idx].id}` }))
        : null;
    return { elapsedMs, outputs };
  };

  runOnce(false);
  const warm = runOnce(true);
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    samples.push(runOnce(false).elapsedMs);
  }
  return {
    p50Ms: median(samples),
    samples: samples.map((v) => Number(v.toFixed(3))),
    outputs: warm.outputs,
  };
}

function profileRustPages(rustIsmd, project, basedir, { useStore = false } = {}) {
  const store = useStore ? rustIsmd.createTemplateStore() : undefined;
  if (!useStore) rustIsmd.clearDefaultTemplateStore();

  const perFileTotals = new Map();
  let totalRead = 0;
  let totalLexer = 0;
  let totalParser = 0;
  let totalSourceHits = 0;
  let totalParseHits = 0;
  let totalAstClones = 0;

  for (const p of project.pages) {
    const opts = { basedir, cache: false };
    if (store) opts.templateStore = store;
    rustIsmd.compileFile(p.pagePath, opts);
    const prof = JSON.parse(rustIsmd._getLastProfileJson());
    const c = prof.counters;
    totalRead += c.file_read_count || 0;
    totalLexer += c.lexer_count || 0;
    totalParser += c.parser_count || 0;
    totalSourceHits += c.source_cache_hit_count || 0;
    totalParseHits += c.parse_cache_hit_count || 0;
    totalAstClones += c.ast_clone_count || 0;
    if (c.per_file) {
      for (const [file, fc] of Object.entries(c.per_file)) {
        const cur = perFileTotals.get(file) || {
          read: 0,
          lexer: 0,
          parser: 0,
          sourceHits: 0,
          parseHits: 0,
        };
        cur.read += fc.read_count || 0;
        cur.lexer += fc.lexer_count || 0;
        cur.parser += fc.parser_count || 0;
        cur.sourceHits += fc.source_cache_hit_count || 0;
        cur.parseHits += fc.parse_cache_hit_count || 0;
        perFileTotals.set(file, cur);
      }
    }
  }

  const pick = (target) => {
    const hit = perFileTotals.get(target);
    return (
      hit || {
        read: 0,
        lexer: 0,
        parser: 0,
        sourceHits: 0,
        parseHits: 0,
      }
    );
  };

  return {
    totals: {
      read: totalRead,
      lexer: totalLexer,
      parser: totalParser,
      sourceHits: totalSourceHits,
      parseHits: totalParseHits,
      astClones: totalAstClones,
    },
    layout: pick(project.layoutPath),
    header: pick(project.headerPath),
    footer: pick(project.footerPath),
  };
}

async function main() {
  const rawIsmd = loadRawIsmd();
  const rustFast = await loadRustIsmd({ profile: false });
  const rustProf = await loadRustIsmd({ profile: true });

  const results = {};
  for (const count of pageCounts) {
    const project = createSyntheticMpaProject(count);
    try {
      const rawRes = runRawPages(rawIsmd, project, project.dir);
      const rustUncachedRes = runRustPages(rustFast, project, project.dir, { mode: 'uncached' });
      const rustDefaultRes = runRustPages(rustFast, project, project.dir, { mode: 'default' });
      const rustStoreRes = runRustPages(rustFast, project, project.dir, { mode: 'store' });
      const rustBatchRes =
        typeof rustFast.createCompiler === 'function'
          ? runRustBatch(rustFast, project, project.dir, { wrap: true, parallel: false })
          : null;
      const rustBatchNoWrapRes =
        typeof rustFast.createCompiler === 'function'
          ? runRustBatch(rustFast, project, project.dir, { wrap: false, parallel: false })
          : null;
      const rustParallelRes =
        typeof rustFast.createCompiler === 'function'
          ? runRustBatch(rustFast, project, project.dir, { wrap: true, parallel: true })
          : null;
      const rustParallelNoWrapRes =
        typeof rustFast.createCompiler === 'function'
          ? runRustBatch(rustFast, project, project.dir, { wrap: false, parallel: true })
          : null;

      assert.equal(rustUncachedRes.outputs.length, count);
      assert.equal(rustDefaultRes.outputs.length, count);
      assert.equal(rustStoreRes.outputs.length, count);
      for (let i = 0; i < count; i++) {
        assert.equal(rustUncachedRes.outputs[i], rawRes.outputs[i], `uncached mismatch page ${i + 1}`);
        assert.equal(rustDefaultRes.outputs[i], rawRes.outputs[i], `default mismatch page ${i + 1}`);
        assert.equal(rustStoreRes.outputs[i], rawRes.outputs[i], `store mismatch page ${i + 1}`);
        if (rustBatchRes) {
          assert.equal(rustBatchRes.outputs[i], rawRes.outputs[i], `batch mismatch page ${i + 1}`);
        }
        if (rustParallelRes) {
          assert.equal(rustParallelRes.outputs[i], rawRes.outputs[i], `parallel mismatch page ${i + 1}`);
        }
      }

      const defaultProf = profileRustPages(rustProf, project, project.dir, { useStore: false });
      const storeProf = profileRustPages(rustProf, project, project.dir, { useStore: true });

      results[`pages_${count}`] = {
        pages: count,
        rawP50Ms: Number(rawRes.p50Ms.toFixed(3)),
        rustUncachedP50Ms: Number(rustUncachedRes.p50Ms.toFixed(3)),
        rustDefaultP50Ms: Number(rustDefaultRes.p50Ms.toFixed(3)),
        rustStoreP50Ms: Number(rustStoreRes.p50Ms.toFixed(3)),
        rustBatchP50Ms: rustBatchRes ? Number(rustBatchRes.p50Ms.toFixed(3)) : null,
        rustBatchNoWrapP50Ms: rustBatchNoWrapRes ? Number(rustBatchNoWrapRes.p50Ms.toFixed(3)) : null,
        rustParallelP50Ms: rustParallelRes ? Number(rustParallelRes.p50Ms.toFixed(3)) : null,
        rustParallelNoWrapP50Ms: rustParallelNoWrapRes
          ? Number(rustParallelNoWrapRes.p50Ms.toFixed(3))
          : null,
        parallelSpeedupVsSerialBatch:
          rustBatchRes && rustParallelRes
            ? Number((rustBatchRes.p50Ms / rustParallelRes.p50Ms).toFixed(2))
            : null,
        parallelNoWrapSpeedupVsSerialNoWrap:
          rustBatchNoWrapRes && rustParallelNoWrapRes
            ? Number((rustBatchNoWrapRes.p50Ms / rustParallelNoWrapRes.p50Ms).toFixed(2))
            : null,
        jsWrapEstimatedMs:
          rustBatchRes && rustBatchNoWrapRes
            ? Number((rustBatchRes.p50Ms - rustBatchNoWrapRes.p50Ms).toFixed(3))
            : null,
        rustUncachedSamples: rustUncachedRes.samples,
        rustDefaultSamples: rustDefaultRes.samples,
        rustStoreSamples: rustStoreRes.samples,
        rustBatchSamples: rustBatchRes ? rustBatchRes.samples : null,
        storeSpeedupVsUncached: Number((rustUncachedRes.p50Ms / rustStoreRes.p50Ms).toFixed(2)),
        rustDefaultVsRawRatio: Number((rustDefaultRes.p50Ms / rawRes.p50Ms).toFixed(3)),
        rustStoreVsRawRatio: Number((rustStoreRes.p50Ms / rawRes.p50Ms).toFixed(3)),
        rustBatchVsRawRatio: rustBatchRes
          ? Number((rustBatchRes.p50Ms / rawRes.p50Ms).toFixed(3))
          : null,
        napiCallsPerPageMode: count,
        napiCallsBatchMode: 1,
        defaultProfile: defaultProf,
        storeProfile: storeProf,
      };
    } finally {
      fs.rmSync(project.dir, { recursive: true, force: true });
    }
  }

  const outPath = path.join(DIAG_DIR, `mpa-phase${phaseLabel}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(results, null, 2));
}

await main();
