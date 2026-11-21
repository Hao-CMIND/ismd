import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BENCHMARKS_DIR,
  DEFAULT_HOT_BATCHES,
  DEFAULT_ROUNDS,
  PURE_CASES,
  parsePositiveIntFlag,
  summarize,
} from '../shared.mjs';

const args = process.argv.slice(2);
const rounds = parsePositiveIntFlag(args, '--rounds', DEFAULT_ROUNDS);
const hotBatches = parsePositiveIntFlag(args, '--hot-batches', DEFAULT_HOT_BATCHES);

const diagDir = path.join(BENCHMARKS_DIR, 'diagnostics');
const batchesDir = path.join(diagDir, 'pure-batches');
const summaryOutPath = path.join(diagDir, 'pure-summary.json');
const baselineSummaryPath = path.join(BENCHMARKS_DIR, 'results', 'summary.json');

fs.rmSync(batchesDir, { recursive: true, force: true });
fs.mkdirSync(batchesDir, { recursive: true });

const rawScript = path.join(BENCHMARKS_DIR, 'raw.js');
const rustScript = path.join(BENCHMARKS_DIR, 'rust.js');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function runChild(script, batch, outFile) {
  const proc = spawnSync(
    process.execPath,
    [
      script,
      '--mode',
      'hot',
      '--scenario',
      'pure',
      '--batch',
      String(batch),
      '--rounds',
      String(rounds),
      '--out',
      outFile,
    ],
    { cwd: BENCHMARKS_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(
      `Child failed (${path.basename(script)} batch=${batch}):\n${proc.stderr}\n${proc.stdout}`
    );
  }
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

const batchesData = [];
for (let batch = 1; batch <= hotBatches; batch++) {
  const order = batch % 2 === 1 ? ['raw', 'rust'] : ['rust', 'raw'];
  const orderLabel = order.map((c) => (c === 'raw' ? 'Raw' : 'Rust')).join(' -> ');
  const pair = { batch, order: orderLabel, raw: null, rust: null };

  for (const compiler of order) {
    const script = compiler === 'raw' ? rawScript : rustScript;
    const outFile = path.join(batchesDir, `${compiler}-pure-batch-${pad2(batch)}.json`);
    pair[compiler] = runChild(script, batch, outFile);
  }
  batchesData.push(pair);
}

const baselineSummary = JSON.parse(fs.readFileSync(baselineSummaryPath, 'utf8'));
const baselineMemPerFile = new Map(
  baselineSummary.scenarios.memory.perFile.map((item) => [item.file, item])
);

const perFile = [];
for (let idx = 0; idx < PURE_CASES.length; idx++) {
  const file = PURE_CASES[idx];
  const rawEntries = batchesData.map((b) => b.raw.correctness[idx]);
  const rustEntries = batchesData.map((b) => b.rust.correctness[idx]);

  const rawOk = rawEntries.every((e) => e.ok);
  const rustOk = rustEntries.every((e) => e.ok);
  const htmlMatch =
    rawOk &&
    rustOk &&
    rawEntries.every((e) => e.html === rawEntries[0].html) &&
    rustEntries.every((e) => e.html === rustEntries[0].html) &&
    rawEntries[0].html === rustEntries[0].html;

  let status = 'MATCH';
  let skipReason = null;
  if (!rawOk || !rustOk) {
    status = 'SKIPPED_ERROR';
    const rErr = rawEntries.find((e) => !e.ok)?.error;
    const rsErr = rustEntries.find((e) => !e.ok)?.error;
    skipReason = `raw=${rErr ? rErr.message : 'ok'}, rust=${rsErr ? rsErr.message : 'ok'}`;
  } else if (!htmlMatch) {
    status = 'HTML_MISMATCH';
    skipReason = 'Raw and Rust HTML mismatch in pure mode';
  }

  const rawSamples = batchesData.flatMap((b) =>
    b.raw.samples.filter((s) => s.file === file && s.ok)
  );
  const rustSamples = batchesData.flatMap((b) =>
    b.rust.samples.filter((s) => s.file === file && s.ok)
  );

  const pureRawCompile = summarize(rawSamples.map((s) => s.compileMs));
  const pureRawRender = summarize(rawSamples.map((s) => s.renderMs));
  const pureRawTotal = summarize(rawSamples.map((s) => s.totalMs));

  const pureRustCompile = summarize(rustSamples.map((s) => s.compileMs));
  const pureRustRender = summarize(rustSamples.map((s) => s.renderMs));
  const pureRustTotal = summarize(rustSamples.map((s) => s.totalMs));

  const compat = baselineMemPerFile.get(file);
  const compatRawTotalP50 = compat?.raw?.total?.p50 ?? null;
  const compatRustTotalP50 = compat?.rust?.total?.p50 ?? null;
  const compatRawCompileP50 = compat?.raw?.compile?.p50 ?? null;
  const compatRustCompileP50 = compat?.rust?.compile?.p50 ?? null;

  const rustDeltaCompileP50 =
    compatRustCompileP50 !== null && pureRustCompile.p50 !== null
      ? pureRustCompile.p50 - compatRustCompileP50
      : null;
  const rustImprovementPct =
    compatRustCompileP50 && pureRustCompile.p50 !== null
      ? ((compatRustCompileP50 - pureRustCompile.p50) / compatRustCompileP50) * 100
      : null;

  perFile.push({
    file,
    status,
    skipReason,
    compatibility: {
      source: 'Baseline V1 (benchmarks/results/summary.json -> scenarios.memory)',
      rawCompileP50: compatRawCompileP50,
      rustCompileP50: compatRustCompileP50,
      rawTotalP50: compatRawTotalP50,
      rustTotalP50: compatRustTotalP50,
      ratioTotalP50:
        compatRawTotalP50 && compatRustTotalP50
          ? compatRustTotalP50 / compatRawTotalP50
          : null,
    },
    pure: {
      raw: {
        compile: pureRawCompile,
        render: pureRawRender,
        total: pureRawTotal,
      },
      rust: {
        compile: pureRustCompile,
        render: pureRustRender,
        total: pureRustTotal,
      },
      ratioCompileP50:
        pureRawCompile.p50 && pureRustCompile.p50
          ? pureRustCompile.p50 / pureRawCompile.p50
          : null,
      ratioTotalP50:
        pureRawTotal.p50 && pureRustTotal.p50
          ? pureRustTotal.p50 / pureRawTotal.p50
          : null,
    },
    rustDeltaCompileP50,
    rustImprovementPct,
  });
}

const eligible = new Set(perFile.filter((f) => f.status === 'MATCH').map((f) => f.file));
const allPureRaw = batchesData.flatMap((b) =>
  b.raw.samples.filter((s) => s.ok && eligible.has(s.file))
);
const allPureRust = batchesData.flatMap((b) =>
  b.rust.samples.filter((s) => s.ok && eligible.has(s.file))
);

const summary = {
  generatedAt: new Date().toISOString(),
  config: {
    hotBatches,
    rounds,
    options: {
      filename: '<ismdPath>',
      basedir: '<casesDir>',
      pretty: true,
      doctype: 'undefined',
    },
    cases: PURE_CASES,
  },
  isolationAudit: {
    rawAllOk: batchesData.every((b) => b.raw.moduleAudit.isolationOk),
    rustAllOk: batchesData.every((b) => b.rust.moduleAudit.isolationOk),
  },
  overallPure: {
    eligibleFiles: eligible.size,
    totalFiles: PURE_CASES.length,
    raw: {
      compile: summarize(allPureRaw.map((s) => s.compileMs)),
      render: summarize(allPureRaw.map((s) => s.renderMs)),
      total: summarize(allPureRaw.map((s) => s.totalMs)),
    },
    rust: {
      compile: summarize(allPureRust.map((s) => s.compileMs)),
      render: summarize(allPureRust.map((s) => s.renderMs)),
      total: summarize(allPureRust.map((s) => s.totalMs)),
    },
  },
  perFile,
};

fs.writeFileSync(summaryOutPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.log(`Pure Fast Path Benchmark (${eligible.size}/${PURE_CASES.length} MATCH, ${hotBatches} batches x ${rounds} rounds):`);
for (const r of perFile) {
  if (r.status !== 'MATCH') {
    console.log(`  [SKIP] ${r.file}: ${r.skipReason}`);
    continue;
  }
  console.log(
    `  ${r.file}: Compat(Raw=${r.compatibility.rawCompileP50.toFixed(3)}, Rust=${r.compatibility.rustCompileP50.toFixed(3)} ms) | Pure(Raw=${r.pure.raw.compile.p50.toFixed(3)}, Rust=${r.pure.rust.compile.p50.toFixed(3)} ms, ratio=${r.pure.ratioCompileP50.toFixed(2)}x, rustImpr=${r.rustImprovementPct.toFixed(1)}%)`
  );
}
console.log(`Saved -> ${summaryOutPath}`);
