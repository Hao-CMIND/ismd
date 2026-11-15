import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pug, { createCompiler } from '../index.js';
import { nativePluginPath } from '../../filters/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPercentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeStats(timesInMs) {
  const sum = timesInMs.reduce((a, b) => a + b, 0);
  const avg = sum / timesInMs.length;
  const sorted = [...timesInMs].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = getPercentile(sorted, 50);
  const p95 = getPercentile(sorted, 95);
  const p99 = getPercentile(sorted, 99);
  return { avg, min, max, median, p95, p99 };
}

async function runBenchmarks() {
  console.log('=== Pug-Rust Phase 5 Core-Only Benchmarks ===\n');

  // 1. Cold Start / Module Load measurements
  console.log('--- 1. Cold Start & Module Load ---');
  const t0 = process.hrtime.bigint();
  const testCompiler = createCompiler({});
  const t1 = process.hrtime.bigint();
  const createCompilerTimeMs = Number(t1 - t0) / 1e6;
  console.log(`createCompiler({}) instantiation time: ${createCompilerTimeMs.toFixed(4)} ms`);
  testCompiler.dispose();

  // 2. No-Plugin Single Compile, Render, compileClient
  console.log('\n--- 2. No-Plugin Operations (Warmup 200, Measured 2000) ---');
  const template = 'div.container\n  h1 Title\n  p Paragraph with text\n  ul\n    li Item 1\n    li Item 2';
  
  // 2.1 Single Render
  // Warmup
  for (let i = 0; i < 200; i++) pug.render(template);
  const renderTimes = [];
  for (let i = 0; i < 2000; i++) {
    const start = process.hrtime.bigint();
    pug.render(template);
    const end = process.hrtime.bigint();
    renderTimes.push(Number(end - start) / 1e6);
  }
  const renderStats = computeStats(renderTimes);
  console.log(`Single Render: Median = ${renderStats.median.toFixed(4)} ms, P95 = ${renderStats.p95.toFixed(4)} ms, Avg = ${renderStats.avg.toFixed(4)} ms, Min = ${renderStats.min.toFixed(4)} ms`);

  // 2.2 Tight-loop Render (Methodology clarification: batch total time / N)
  const tightT0 = process.hrtime.bigint();
  const tightIters = 20000;
  for (let i = 0; i < tightIters; i++) {
    pug.render(template);
  }
  const tightT1 = process.hrtime.bigint();
  const tightAvgMs = Number(tightT1 - tightT0) / 1e6 / tightIters;
  console.log(`Tight-loop Render (total time / 20k iters): ${tightAvgMs.toFixed(4)} ms/op (Explains ~0.02-0.03ms numbers)`);

  // 2.3 Single Compile
  for (let i = 0; i < 200; i++) pug.compile(template);
  const compileTimes = [];
  for (let i = 0; i < 2000; i++) {
    const start = process.hrtime.bigint();
    pug.compile(template);
    const end = process.hrtime.bigint();
    compileTimes.push(Number(end - start) / 1e6);
  }
  const compileStats = computeStats(compileTimes);
  console.log(`Single Compile: Median = ${compileStats.median.toFixed(4)} ms, P95 = ${compileStats.p95.toFixed(4)} ms, Avg = ${compileStats.avg.toFixed(4)} ms`);

  // 2.4 Single compileClient
  for (let i = 0; i < 200; i++) pug.compileClient(template);
  const clientTimes = [];
  for (let i = 0; i < 2000; i++) {
    const start = process.hrtime.bigint();
    pug.compileClient(template);
    const end = process.hrtime.bigint();
    clientTimes.push(Number(end - start) / 1e6);
  }
  const clientStats = computeStats(clientTimes);
  console.log(`Single compileClient: Median = ${clientStats.median.toFixed(4)} ms, P95 = ${clientStats.p95.toFixed(4)} ms, Avg = ${clientStats.avg.toFixed(4)} ms`);

  // 3. CompilerSession Batch (50 pages) & Incremental Cache
  console.log('\n--- 3. CompilerSession Batch & Incremental ---');
  const files = {};
  const filenames = [];
  for (let i = 0; i < 50; i++) {
    const name = `page_${i}.pug`;
    filenames.push(name);
    files[name] = `div.page-${i}\n  h1 Page ${i}\n  p Content for page ${i} with dynamic details\n  footer Copyright 2026`;
  }

  // Cold batch
  const session1 = createCompiler({});
  session1.updateFiles(files);
  const coldBatchStart = process.hrtime.bigint();
  session1.compileBatch(filenames);
  const coldBatchEnd = process.hrtime.bigint();
  const coldBatchMs = Number(coldBatchEnd - coldBatchStart) / 1e6;
  console.log(`50-page Cold Batch Compile: ${coldBatchMs.toFixed(4)} ms (avg ${(coldBatchMs / 50).toFixed(4)} ms/page)`);

  // Warm batch (identical files, cached)
  const warmBatchStart = process.hrtime.bigint();
  session1.compileBatch(filenames);
  const warmBatchEnd = process.hrtime.bigint();
  const warmBatchMs = Number(warmBatchEnd - warmBatchStart) / 1e6;
  console.log(`50-page Warm Batch Compile (Cache Hit): ${warmBatchMs.toFixed(4)} ms (avg ${(warmBatchMs / 50).toFixed(4)} ms/page) (Explains ~3.5ms numbers)`);

  // Incremental: 1 file modified
  session1.updateFiles({ 'page_0.pug': 'div.page-0\n  h1 Updated Page 0\n  p Modified content' });
  const incStart = process.hrtime.bigint();
  const affected = session1.compileAffected();
  const incEnd = process.hrtime.bigint();
  const incMs = Number(incEnd - incStart) / 1e6;
  console.log(`Incremental compileAffected (1 modified page): ${incMs.toFixed(4)} ms (affected: ${affected.length})`);
  session1.dispose();

  // 4. Native uppercase PoC smoke benchmark
  console.log('\n--- 4. Native uppercase PoC Smoke Benchmark ---');
  const pluginPath = nativePluginPath();
  const pluginTemplate = 'div\n  :uppercase\n    hello native plugin';
  
  // First load
  const pT0 = process.hrtime.bigint();
  pug.render(pluginTemplate, { plugins: [pluginPath] });
  const pT1 = process.hrtime.bigint();
  const firstPluginMs = Number(pT1 - pT0) / 1e6;
  console.log(`Native Plugin First Load + Render: ${firstPluginMs.toFixed(4)} ms`);

  // Warm plugin render
  const pluginTimes = [];
  for (let i = 0; i < 500; i++) {
    const start = process.hrtime.bigint();
    pug.render(pluginTemplate, { plugins: [pluginPath] });
    const end = process.hrtime.bigint();
    pluginTimes.push(Number(end - start) / 1e6);
  }
  const pluginStats = computeStats(pluginTimes);
  console.log(`Native Plugin Render (Reused): Median = ${pluginStats.median.toFixed(4)} ms, P95 = ${pluginStats.p95.toFixed(4)} ms, Avg = ${pluginStats.avg.toFixed(4)} ms`);

  // 5. Memory & RSS Stability (50, 100, 300 session cycles)
  console.log('\n--- 5. Memory & Session Lifecycle Stability ---');
  if (global.gc) global.gc();
  const initialMem = process.memoryUsage();
  console.log(`Initial RSS: ${(initialMem.rss / 1024 / 1024).toFixed(2)} MB, HeapUsed: ${(initialMem.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  for (const count of [50, 100, 300]) {
    for (let c = 0; c < count; c++) {
      const sess = createCompiler({});
      sess.updateFiles({
        'test.pug': 'div\n  h1 Title\n  p Text',
        'layout.pug': 'html\n  body\n    block content',
      });
      sess.compileBatch(['test.pug', 'layout.pug']);
      sess.dispose();
    }
    if (global.gc) global.gc();
    const mem = process.memoryUsage();
    console.log(`After ${count} create/dispose cycles -> RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB, HeapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  }

  const finalMem = process.memoryUsage();
  console.log(`\nFinal Peak RSS: ${(finalMem.rss / 1024 / 1024).toFixed(2)} MB`);

  // Output structured JSON for report
  const reportData = {
    env: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    coldStart: {
      createCompilerTimeMs,
    },
    noPlugin: {
      render: renderStats,
      renderTightLoopAvgMs: tightAvgMs,
      compile: compileStats,
      compileClient: clientStats,
    },
    batch: {
      coldBatch50Ms: coldBatchMs,
      warmBatch50Ms: warmBatchMs,
      incrementalAffectedMs: incMs,
    },
    nativePoC: {
      firstPluginMs,
      reusedRender: pluginStats,
    },
    memory: {
      initialRssMB: initialMem.rss / 1024 / 1024,
      finalRssMB: finalMem.rss / 1024 / 1024,
    }
  };

  fs.writeFileSync(path.join(__dirname, 'phase5-raw-benchmarks.json'), JSON.stringify(reportData, null, 2));
  console.log('\nRaw benchmark data written to phase5-raw-benchmarks.json');
}

runBenchmarks().catch(err => {
  console.error(err);
  process.exit(1);
});
