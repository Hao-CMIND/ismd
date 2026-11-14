import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BENCHMARKS_DIR,
  DEFAULT_CASES_DIR,
  REPO_ROOT,
  buildOpts,
  createLocals,
  loadTemplates,
  percentile,
} from '../shared.js';

const DIAG_DIR = import.meta.dirname;
const DEFAULT_PROFILE_ADDON = path.resolve(
  REPO_ROOT,
  'compiler/target-profile/release/pug_napi.dll'
);

if (process.env.PUG_PROFILE !== '1') {
  process.env.PUG_PROFILE = '1';
}
if (!process.env.PUG_PROFILE_ADDON) {
  process.env.PUG_PROFILE_ADDON = DEFAULT_PROFILE_ADDON;
}

const TARGET_TEMPLATES = [
  { file: 'basic.pug', out: 'profile-basic.json', runPure: true },
  { file: 'attrs.pug', out: 'profile-attrs.json', runPure: true },
  { file: 'mixin.attrs.pug', out: 'profile-mixin-attrs.json', runPure: true },
  { file: 'code.conditionals.pug', out: 'profile-conditionals.json', runPure: true },
  {
    file: 'layout.multi.append.prepend.block.pug',
    out: 'profile-layout.json',
    runPure: true,
  },
  { file: 'text.pug', out: 'profile-text.json', runPure: true },
  { file: 'filters.nested.pug', out: 'profile-filter.json', runPure: false },
];

const WARMUP_ROUNDS = 2;
const MEASURED_ROUNDS = 10;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function profileOneMode(pug, tpl, scenario) {
  const warmupOpts = () => buildOpts(tpl.pugPath, DEFAULT_CASES_DIR, scenario);

  for (let i = 0; i < WARMUP_ROUNDS; i += 1) {
    const fn = pug.compile(tpl.src, warmupOpts());
    fn(createLocals());
  }

  const samples = [];
  for (let r = 0; r < MEASURED_ROUNDS; r += 1) {
    const opts = warmupOpts();
    const t0 = performance.now();
    const fn = pug.compile(tpl.src, opts);
    const t1 = performance.now();
    const html = fn(createLocals());
    const t2 = performance.now();

    const rawProfile = pug._getLastProfileJson();
    if (!rawProfile) {
      throw new Error(
        `Profiler did not return data for ${tpl.file}. Ensure target-profile/release/pug_napi.dll is built with --features profile and PUG_PROFILE=1.`
      );
    }
    const prof = JSON.parse(rawProfile);
    const jsCompileMs = t1 - t0;
    const renderMs = t2 - t1;
    const jsWrapperMs = Math.max(0, jsCompileMs - prof.totalCompileMs);

    samples.push({
      jsCompileMs,
      renderMs,
      jsWrapperMs,
      htmlBytes: Buffer.byteLength(html, 'utf8'),
      prof,
    });
  }

  const stageNames = Object.keys(samples[0].prof.stagesExclusiveMs);
  const counterNames = Object.keys(samples[0].prof.counters);

  const rustTotalArr = samples.map((s) => s.prof.totalCompileMs);
  const jsCompileArr = samples.map((s) => s.jsCompileMs);
  const renderArr = samples.map((s) => s.renderMs);
  const wrapperArr = samples.map((s) => s.jsWrapperMs);

  const rustTotalP50 = median(rustTotalArr);
  const rustTotalAvg = mean(rustTotalArr);
  const jsCompileP50 = median(jsCompileArr);

  const stagesExclusive = {};
  const stagesInclusive = {};
  for (const name of stageNames) {
    const exArr = samples.map((s) => s.prof.stagesExclusiveMs[name]);
    const inArr = samples.map((s) => s.prof.stagesInclusiveMs[name]);
    const p50Ex = median(exArr);
    const avgEx = mean(exArr);
    const p50In = median(inArr);
    const avgIn = mean(inArr);
    stagesExclusive[name] = {
      p50Ms: p50Ex,
      avgMs: avgEx,
      pctOfRustP50: rustTotalP50 > 0 ? (p50Ex / rustTotalP50) * 100 : 0,
      pctOfRustAvg: rustTotalAvg > 0 ? (avgEx / rustTotalAvg) * 100 : 0,
    };
    stagesInclusive[name] = {
      p50Ms: p50In,
      avgMs: avgIn,
      pctOfRustP50: rustTotalP50 > 0 ? (p50In / rustTotalP50) * 100 : 0,
      pctOfRustAvg: rustTotalAvg > 0 ? (avgIn / rustTotalAvg) * 100 : 0,
    };
  }

  const counters = {};
  for (const name of counterNames) {
    counters[name] = samples[0].prof.counters[name];
  }

  const topStages = Object.entries(stagesExclusive)
    .filter(([, v]) => v.avgMs > 0)
    .sort((a, b) => b[1].avgMs - a[1].avgMs)
    .map(([stage, v]) => ({
      stage,
      avgMs: v.avgMs,
      p50Ms: v.p50Ms,
      pctOfRustAvg: v.pctOfRustAvg,
      pctOfRustP50: v.pctOfRustP50,
    }));

  const exclusiveSumAvgMs = Object.values(stagesExclusive).reduce(
    (sum, s) => sum + s.avgMs,
    0
  );

  return {
    scenario,
    rounds: MEASURED_ROUNDS,
    warmupRounds: WARMUP_ROUNDS,
    jsCompileMs: { p50: jsCompileP50, avg: mean(jsCompileArr) },
    rustTotalCompileMs: { p50: rustTotalP50, avg: rustTotalAvg },
    jsWrapperMs: {
      p50: median(wrapperArr),
      avg: mean(wrapperArr),
      pctOfJsP50: jsCompileP50 > 0 ? (median(wrapperArr) / jsCompileP50) * 100 : 0,
    },
    renderMs: { p50: median(renderArr), avg: mean(renderArr) },
    exclusiveSumAvgMs,
    topStages,
    stagesExclusive,
    stagesInclusive,
    counters,
  };
}

async function main() {
  const { default: pug } = await import('../../index.js');
  const templates = loadTemplates(
    DEFAULT_CASES_DIR,
    TARGET_TEMPLATES.map((t) => t.file)
  );
  const tplMap = new Map(templates.map((t) => [t.file, t]));

  const summary = [];
  for (const entry of TARGET_TEMPLATES) {
    const tpl = tplMap.get(entry.file);
    if (!tpl) {
      throw new Error(`Template not found: ${entry.file}`);
    }

    const compat = profileOneMode(pug, tpl, 'memory');
    const pure = entry.runPure ? profileOneMode(pug, tpl, 'pure') : null;

    const record = {
      file: entry.file,
      sourceBytes: Buffer.byteLength(tpl.src, 'utf8'),
      sourceLines: tpl.src.split(/\r?\n/).length,
      compat,
      pure,
    };

    const outPath = path.join(DIAG_DIR, entry.out);
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
    summary.push(record);

    console.log(
      `\n=== ${entry.file} (JS compile P50=${compat.jsCompileMs.p50.toFixed(3)}ms, Rust=${compat.rustTotalCompileMs.p50.toFixed(3)}ms, JSWrap=${compat.jsWrapperMs.p50.toFixed(3)}ms) ===`
    );
    for (const s of compat.topStages.slice(0, 8)) {
      console.log(
        `  ${s.stage.padEnd(22)} ${s.avgMs.toFixed(4)} ms (${s.pctOfRustAvg.toFixed(1)}%)`
      );
    }
    console.log(`  Counters:`, JSON.stringify(compat.counters));
  }

  fs.writeFileSync(
    path.join(DIAG_DIR, 'profile-summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        addon: process.env.PUG_PROFILE_ADDON,
        measuredRounds: MEASURED_ROUNDS,
        summary,
      },
      null,
      2
    )
  );
  console.log(`\nSaved 7 profile JSONs and profile-summary.json to ${DIAG_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
