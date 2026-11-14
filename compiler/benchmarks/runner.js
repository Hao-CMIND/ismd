import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BENCHMARKS_DIR,
  DEFAULT_CASES_DIR,
  DEFAULT_COLD_BATCHES,
  DEFAULT_HOT_BATCHES,
  DEFAULT_ROUNDS,
  DEFAULT_SCENARIOS,
  parsePositiveIntFlag,
  parseScenarioFlag,
  summarize,
} from './shared.js';

const args = process.argv.slice(2);

const rounds = parsePositiveIntFlag(args, '--rounds', DEFAULT_ROUNDS);
const coldBatches = parsePositiveIntFlag(
  args,
  '--cold-batches',
  DEFAULT_COLD_BATCHES
);
const hotBatches = parsePositiveIntFlag(
  args,
  '--hot-batches',
  DEFAULT_HOT_BATCHES
);
const scenarioFlag = parseScenarioFlag(args, true);
const activeScenarios =
  scenarioFlag === 'all' ? [...DEFAULT_SCENARIOS] : [scenarioFlag];

const resultsDir = path.join(BENCHMARKS_DIR, 'results');
const rawResultsDir = path.join(resultsDir, 'raw');
const rustResultsDir = path.join(resultsDir, 'rust');
const distRawDir = path.join(BENCHMARKS_DIR, 'dist', 'raw');
const distRustDir = path.join(BENCHMARKS_DIR, 'dist', 'rust');
const summaryPath = path.join(resultsDir, 'summary.json');
const reportPath = path.join(BENCHMARKS_DIR, 'report.md');

fs.rmSync(rawResultsDir, { recursive: true, force: true });
fs.rmSync(rustResultsDir, { recursive: true, force: true });
fs.mkdirSync(rawResultsDir, { recursive: true });
fs.mkdirSync(rustResultsDir, { recursive: true });

if (activeScenarios.includes('build')) {
  fs.rmSync(distRawDir, { recursive: true, force: true });
  fs.rmSync(distRustDir, { recursive: true, force: true });
  fs.mkdirSync(distRawDir, { recursive: true });
  fs.mkdirSync(distRustDir, { recursive: true });
}

const rawScript = path.join(BENCHMARKS_DIR, 'raw.js');
const rustScript = path.join(BENCHMARKS_DIR, 'rust.js');

const SCENARIO_META = {
  memory: {
    title: '1. memory（Source 已在記憶體：`compile` → `render`，不寫 HTML）',
    target: '測 Compiler 本體（註：入口模板已在記憶體，依賴 `include`/`extends` 仍依 Loader 讀檔）',
  },
  file: {
    title: '2. file（從實體 `.pug` 載入：`compileFile` → `render`，不寫 HTML）',
    target: '測 File Loader + Compiler（`cache: false`）',
  },
  build: {
    title: '3. build（從實體 `.pug`：`compileFile` → `render` → `write HTML`）',
    target: '測接近實際靜態 Build 的總成本，並輸出 `.html` 至 `benchmarks/dist/{raw,rust}/`',
  },
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function runIsolatedChild(scriptPath, childArgs, outFile) {
  const t0 = performance.now();
  const proc = spawnSync(
    process.execPath,
    [scriptPath, ...childArgs, '--out', outFile],
    {
      cwd: BENCHMARKS_DIR,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }
  );
  const t1 = performance.now();

  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    throw new Error(
      `Child process failed (${path.basename(scriptPath)} ${childArgs.join(' ')}), exit=${proc.status}\nstderr:\n${proc.stderr}\nstdout:\n${proc.stdout}`
    );
  }
  if (!fs.existsSync(outFile)) {
    throw new Error(`Child process did not produce output file: ${outFile}`);
  }

  const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  return {
    data,
    wallMs: t1 - t0,
  };
}

function getRustcVersion() {
  try {
    return execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
}

function ratio(rustVal, rawVal) {
  if (
    rustVal === null ||
    rawVal === null ||
    !Number.isFinite(rustVal) ||
    !Number.isFinite(rawVal) ||
    rawVal === 0
  ) {
    return null;
  }
  return rustVal / rawVal;
}

function fmtMs(val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return 'N/A';
  return val.toFixed(3);
}

function fmtRatio(r) {
  if (r === null || r === undefined || !Number.isFinite(r)) return 'N/A';
  return `${r.toFixed(2)}x`;
}

// =============================================================================
// 1. Cold Benchmark (fresh Node process per measurement, alternating order)
// =============================================================================
const coldRecords = [];

for (let batch = 1; batch <= coldBatches; batch++) {
  const order = batch % 2 === 1 ? ['raw', 'rust'] : ['rust', 'raw'];
  const orderLabel = order.map((c) => (c === 'raw' ? 'Raw' : 'Rust')).join(' -> ');

  for (const compiler of order) {
    const script = compiler === 'raw' ? rawScript : rustScript;
    const outFile = path.join(
      compiler === 'raw' ? rawResultsDir : rustResultsDir,
      `cold-batch-${pad2(batch)}.json`
    );

    const { data, wallMs } = runIsolatedChild(
      script,
      ['--mode', 'cold', '--batch', String(batch)],
      outFile
    );

    const processOverheadMs = Math.max(0, wallMs - data.loadMs);
    const enriched = {
      ...data,
      order: orderLabel,
      wallMs,
      processOverheadMs,
    };
    fs.writeFileSync(outFile, JSON.stringify(enriched, null, 2) + '\n', 'utf8');
    coldRecords.push(enriched);
  }
}

const rawCold = coldRecords.filter((r) => r.compiler === 'raw');
const rustCold = coldRecords.filter((r) => r.compiler === 'rust');

const coldSummary = {
  batches: coldBatches,
  moduleLoad: {
    raw: summarize(rawCold.map((r) => r.loadMs)),
    rust: summarize(rustCold.map((r) => r.loadMs)),
  },
  processOverhead: {
    raw: summarize(rawCold.map((r) => r.processOverheadMs)),
    rust: summarize(rustCold.map((r) => r.processOverheadMs)),
  },
  totalWall: {
    raw: summarize(rawCold.map((r) => r.wallMs)),
    rust: summarize(rustCold.map((r) => r.wallMs)),
  },
};

// =============================================================================
// 2. Hot Benchmarks (per scenario, independent process batches, alternating)
// =============================================================================
function evaluateScenario(scenario, batchesData) {
  const templateFiles = batchesData[0].raw.correctness.map((c) => c.file);
  const correctnessPerFile = [];
  const eligibleFiles = new Set();

  for (let idx = 0; idx < templateFiles.length; idx++) {
    const file = templateFiles[idx];
    const rawEntries = batchesData.map((b) => b.raw.correctness[idx]);
    const rustEntries = batchesData.map((b) => b.rust.correctness[idx]);

    const rawAllOk = rawEntries.every((e) => e.ok);
    const rustAllOk = rustEntries.every((e) => e.ok);
    const rawConsistentHtml =
      rawAllOk && rawEntries.every((e) => e.html === rawEntries[0].html);
    const rustConsistentHtml =
      rustAllOk && rustEntries.every((e) => e.html === rustEntries[0].html);

    const rawMeasuredAllOk = batchesData.every((b) =>
      b.raw.samples.filter((s) => s.file === file).every((s) => s.ok)
    );
    const rustMeasuredAllOk = batchesData.every((b) =>
      b.rust.samples.filter((s) => s.file === file).every((s) => s.ok)
    );

    let status;
    let note = '';

    if (rawAllOk && rustAllOk) {
      if (!rawConsistentHtml || !rustConsistentHtml) {
        status = 'INCONSISTENT_OUTPUT';
        note = 'Output differed across batches';
      } else if (rawEntries[0].html === rustEntries[0].html) {
        if (rawMeasuredAllOk && rustMeasuredAllOk) {
          status = 'MATCH';
          eligibleFiles.add(file);
        } else {
          status = 'RUNTIME_ERROR_IN_HOT';
          note = 'Correctness passed but a measured hot round threw an error';
        }
      } else {
        status = 'HTML_MISMATCH';
        note = 'Raw and Rust produced different HTML strings';
      }
    } else if (rawAllOk && !rustAllOk) {
      status = 'RAW_ONLY';
      const firstErr = rustEntries.find((e) => !e.ok)?.error;
      note = firstErr ? `${firstErr.name}: ${firstErr.message}` : 'Rust failed';
    } else if (!rawAllOk && rustAllOk) {
      status = 'RUST_ONLY';
      const firstErr = rawEntries.find((e) => !e.ok)?.error;
      note = firstErr ? `${firstErr.name}: ${firstErr.message}` : 'Raw failed';
    } else {
      status = 'BOTH_ERROR';
      note = 'Both Raw and Rust failed';
    }

    correctnessPerFile.push({
      file,
      rawOk: rawAllOk && rawMeasuredAllOk,
      rustOk: rustAllOk && rustMeasuredAllOk,
      status,
      note,
    });
  }

  const correctnessSummary = {
    totalFiles: correctnessPerFile.length,
    rawSuccess: correctnessPerFile.filter((c) => c.rawOk).length,
    rustSuccess: correctnessPerFile.filter((c) => c.rustOk).length,
    commonSuccess: correctnessPerFile.filter((c) => c.rawOk && c.rustOk).length,
    rawOnlySuccess: correctnessPerFile.filter((c) => c.status === 'RAW_ONLY').length,
    rustOnlySuccess: correctnessPerFile.filter((c) => c.status === 'RUST_ONLY').length,
    htmlMatch: correctnessPerFile.filter((c) => c.status === 'MATCH').length,
    htmlMismatch: correctnessPerFile.filter((c) => c.status === 'HTML_MISMATCH').length,
    errors: correctnessPerFile.filter(
      (c) =>
        c.status === 'RAW_ONLY' ||
        c.status === 'RUST_ONLY' ||
        c.status === 'BOTH_ERROR' ||
        c.status === 'RUNTIME_ERROR_IN_HOT'
    ).length,
    excluded: correctnessPerFile.filter((c) => c.status !== 'MATCH').length,
    details: correctnessPerFile,
  };

  function collectValidSamples(samples) {
    return samples.filter((s) => s.ok && eligibleFiles.has(s.file));
  }

  function summarizeCompilerSamples(samples) {
    const writeVals = samples
      .map((s) => s.writeMs)
      .filter((v) => v !== null && v !== undefined);
    return {
      compile: summarize(samples.map((s) => s.compileMs)),
      render: summarize(samples.map((s) => s.renderMs)),
      write: summarize(writeVals),
      total: summarize(samples.map((s) => s.totalMs)),
    };
  }

  const batchSummaries = batchesData.map((b) => {
    const rawValid = collectValidSamples(b.raw.samples);
    const rustValid = collectValidSamples(b.rust.samples);
    return {
      batch: b.batch,
      order: b.order,
      rawPid: b.raw.pid,
      rustPid: b.rust.pid,
      rawWallMs: b.raw.wallMs,
      rustWallMs: b.rust.wallMs,
      rawValidSamples: rawValid.length,
      rustValidSamples: rustValid.length,
      raw: summarizeCompilerSamples(rawValid),
      rust: summarizeCompilerSamples(rustValid),
    };
  });

  const allRawValid = batchesData.flatMap((b) => collectValidSamples(b.raw.samples));
  const allRustValid = batchesData.flatMap((b) => collectValidSamples(b.rust.samples));

  const overall = {
    eligibleFiles: eligibleFiles.size,
    excludedFiles: correctnessSummary.excluded,
    raw: summarizeCompilerSamples(allRawValid),
    rust: summarizeCompilerSamples(allRustValid),
  };

  const rawByFile = new Map(templateFiles.map((f) => [f, []]));
  const rustByFile = new Map(templateFiles.map((f) => [f, []]));
  for (const b of batchesData) {
    for (const s of b.raw.samples) {
      if (s.ok) rawByFile.get(s.file).push(s);
    }
    for (const s of b.rust.samples) {
      if (s.ok) rustByFile.get(s.file).push(s);
    }
  }

  const perFile = correctnessPerFile.map((c) => {
    const isEligible = eligibleFiles.has(c.file);
    const rawStats = isEligible
      ? summarizeCompilerSamples(rawByFile.get(c.file))
      : summarizeCompilerSamples([]);
    const rustStats = isEligible
      ? summarizeCompilerSamples(rustByFile.get(c.file))
      : summarizeCompilerSamples([]);

    return {
      file: c.file,
      status: c.status,
      eligible: isEligible,
      note: c.note,
      raw: rawStats,
      rust: rustStats,
      ratioTotalP50: ratio(rustStats.total.p50, rawStats.total.p50),
      ratioCompileP50: ratio(rustStats.compile.p50, rawStats.compile.p50),
      ratioRenderP50: ratio(rustStats.render.p50, rawStats.render.p50),
      ratioWriteP50: ratio(rustStats.write.p50, rawStats.write.p50),
    };
  });

  return {
    scenario,
    correctnessSummary,
    batchSummaries,
    overall,
    perFile,
  };
}

const scenarioResults = {};
const allHotBatchesRaw = [];
const allHotBatchesRust = [];

for (const scenario of activeScenarios) {
  const batchesData = [];
  for (let batch = 1; batch <= hotBatches; batch++) {
    const order = batch % 2 === 1 ? ['raw', 'rust'] : ['rust', 'raw'];
    const orderLabel = order.map((c) => (c === 'raw' ? 'Raw' : 'Rust')).join(' -> ');
    const pair = { batch, order: orderLabel, raw: null, rust: null };

    for (const compiler of order) {
      const script = compiler === 'raw' ? rawScript : rustScript;
      const outFile = path.join(
        compiler === 'raw' ? rawResultsDir : rustResultsDir,
        `${scenario}-batch-${pad2(batch)}.json`
      );
      const childArgs = [
        '--mode',
        'hot',
        '--scenario',
        scenario,
        '--batch',
        String(batch),
        '--rounds',
        String(rounds),
      ];
      if (scenario === 'build') {
        childArgs.push(
          '--dist-dir',
          compiler === 'raw' ? distRawDir : distRustDir
        );
      }

      const { data, wallMs } = runIsolatedChild(script, childArgs, outFile);
      const enriched = {
        ...data,
        order: orderLabel,
        wallMs,
      };
      fs.writeFileSync(outFile, JSON.stringify(enriched), 'utf8');
      pair[compiler] = enriched;

      if (compiler === 'raw') allHotBatchesRaw.push(enriched);
      else allHotBatchesRust.push(enriched);
    }

    batchesData.push(pair);
  }

  scenarioResults[scenario] = evaluateScenario(scenario, batchesData);
}

// =============================================================================
// 3. Environment & Isolation Metadata
// =============================================================================
const firstRustHot = allHotBatchesRust[0];
const firstRawHot = allHotBatchesRaw[0];

const coldPids = coldRecords.map((r) => r.pid);
const hotPids = [...allHotBatchesRaw, ...allHotBatchesRust].map((r) => r.pid);
const allChildPids = [...coldPids, ...hotPids];
const uniqueChildPids = new Set(allChildPids);

const isolationAudit = {
  parentPid: process.pid,
  totalChildProcesses: allChildPids.length,
  uniqueChildProcessIds: uniqueChildPids.size,
  rawIsolationAllOk:
    rawCold.every((r) => r.moduleAudit.isolationOk) &&
    allHotBatchesRaw.every((r) => r.moduleAudit.isolationOk),
  rustIsolationAllOk:
    rustCold.every((r) => r.moduleAudit.isolationOk) &&
    allHotBatchesRust.every((r) => r.moduleAudit.isolationOk),
  rustLoadedAnyRawCompilerPackage:
    rustCold.some((r) => r.moduleAudit.rawCompilerMatches.length > 0) ||
    allHotBatchesRust.some((r) => r.moduleAudit.rawCompilerMatches.length > 0),
  rustHotRawFilterDepsCount: firstRustHot.moduleAudit.rawFilterDepsCount,
  rustHotRawFilterDepsSample: firstRustHot.moduleAudit.rawFilterDepsSample,
};

const envInfo = {
  date: new Date().toISOString(),
  os: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
  cpu: `${os.cpus()[0]?.model || 'unknown'} (${os.cpus().length} logical cores)`,
  nodeVersion: process.version,
  rustVersion: getRustcVersion(),
  rawCompilerVersion: firstRawHot.compilerVersion,
  rawCompilerPath: firstRawHot.compilerEntryPath,
  rustCompilerVersion: firstRustHot.compilerVersion,
  rustJsEntryPath: firstRustHot.compilerEntryPath,
  rustNativeAddonPath: firstRustHot.nativeInfo.actualAddonPath,
  rustNativeAddonBytes: firstRustHot.nativeInfo.actualBytes,
  rustNativeAddonSha256: firstRustHot.nativeInfo.actualSha256,
  rustBuildProfile: firstRustHot.nativeInfo.profile,
  rustOptimizationLevel: firstRustHot.nativeInfo.optimizationLevel,
  casesDir: DEFAULT_CASES_DIR,
  templateCount: firstRawHot.templateCount,
  scenarios: activeScenarios,
  roundsPerHotBatch: rounds,
  coldBatches,
  hotBatches,
  distRawDir: activeScenarios.includes('build') ? distRawDir : null,
  distRustDir: activeScenarios.includes('build') ? distRustDir : null,
  options: {
    basedir: DEFAULT_CASES_DIR,
    pretty: true,
    doctype: 'undefined',
    cache: 'false (file/build)',
    filters: 'custom (stateless helper in shared.js) + jstransformer-*',
    filterAliases: { markdown: 'markdown-it' },
    locals: { title: 'Pug' },
    warmupRoundsPerBatch: 1,
  },
  isolationAudit,
};

const summaryPayload = {
  environment: envInfo,
  coldSummary,
  coldRecords,
  scenarios: scenarioResults,
};

fs.writeFileSync(summaryPath, JSON.stringify(summaryPayload, null, 2) + '\n', 'utf8');

// =============================================================================
// 4. Generate Markdown Report
// =============================================================================
const md = [
  '# Pug Compiler Benchmark — Raw vs Rust',
  '',
  '## 1. 測試環境與隔離驗證',
  '',
  '| 項目 | 內容 |',
  '| --- | --- |',
  `| 日期 | ${envInfo.date} |`,
  `| OS | ${envInfo.os} |`,
  `| CPU | ${envInfo.cpu} |`,
  `| Node version | \`${envInfo.nodeVersion}\` |`,
  `| Rust version | \`${envInfo.rustVersion}\` |`,
  `| Raw compiler identity | \`pug@${envInfo.rawCompilerVersion}\` |`,
  `| Raw compiler path | \`${envInfo.rawCompilerPath}\` |`,
  `| Rust compiler identity | \`pug-rust-compiler@${envInfo.rustCompilerVersion}\` |`,
  `| Rust JS entry path | \`${envInfo.rustJsEntryPath}\` |`,
  `| Rust \`.node\` 實際 path | \`${envInfo.rustNativeAddonPath}\` (${envInfo.rustNativeAddonBytes} bytes, sha256:\`${envInfo.rustNativeAddonSha256?.slice(0, 12)}...\`) |`,
  `| Rust build profile | \`${envInfo.rustBuildProfile}\` |`,
  `| Rust optimization level | ${envInfo.rustOptimizationLevel} |`,
  `| Fixture 來源 | \`${envInfo.casesDir}\`（${envInfo.templateCount} 檔） |`,
  `| 測試模式 | \`${activeScenarios.join('`, `')}\` |`,
  `| Cold batches | ${coldBatches} batches（Raw ${coldBatches} 次 + Rust ${coldBatches} 次，順序交替） |`,
  `| Hot batches / rounds | 每個模式 ${hotBatches} batches × ${rounds} rounds / batch（預熱 1 輪，順序交替） |`,
  `| 編譯選項 | \`pretty: true\`, \`doctype: undefined\`, \`basedir: cases\`, \`cache: false\`, \`filterAliases: { markdown: 'markdown-it' }\`, \`filters: { custom }\`, \`locals: { title: 'Pug' }\` |`,
];

if (activeScenarios.includes('build')) {
  md.push(
    `| HTML 輸出目錄 | Raw: \`${distRawDir}\` / Rust: \`${distRustDir}\` |`
  );
}

md.push(
  '',
  '### 測試模式與方法說明',
  '',
  '- **`memory`**：入口 `.pug` 原始碼預先讀入記憶體，呼叫 `compiler.compile(src, opts)` → `fn(locals)`，不寫 HTML；量測 Compiler 本體（註：依賴的 `include`/`extends` 仍依 compiler Loader 實際行為讀取）。',
  '- **`file`**：每次皆從實體 `.pug` 路徑呼叫 `compiler.compileFile(pugPath, { ...opts, cache: false })` → `fn(locals)`，不寫 HTML；量測 Entry 讀檔 + File Loader + Compiler。',
  '- **`build`**：每次皆從實體 `.pug` 路徑呼叫 `compiler.compileFile(pugPath, { ...opts, cache: false })` → `fn(locals)` → `fs.writeFileSync(outHtmlPath, html)`；量測接近實際靜態 Build 的總成本，並產出實體 `.html` 檔。',
  `- **Process 隔離**：總共啟動 ${isolationAudit.totalChildProcesses} 個獨立子程序（與主程序 PID \`${isolationAudit.parentPid}\` 完全分離；不重複 PID 數：${isolationAudit.uniqueChildProcessIds}），Raw 與 Rust 各自在獨立 Node.js process 執行。`,
  `- **相依模組審計**：\`raw.js\` 未載入 \`rust/compiler\`（\`isolationOk=${isolationAudit.rawIsolationAllOk}\`）；\`rust.js\` 未載入任何 \`raw/compiler/packages/pug*\`（\`isolationOk=${isolationAudit.rustIsolationAllOk}\`）。註：執行 \`:stylus\`、\`:less\`、\`:coffee-script\`、\`:markdown-it\` 等第三方 filter 時，\`rust/compiler/index.js\` 會從 \`raw/compiler/node_modules/\` 載入外部 \`jstransformer-*\` 套件（共 ${isolationAudit.rustHotRawFilterDepsCount} 個外部相依模組），並非 Raw Pug compiler 本體。`,
  '- **Filter / fixture 狀態**：`custom` filter 已抽離為 `shared.js` 內的無狀態函式；第三方 `jstransformer-*` 套件在單一 Hot process 內仍保有各自的 CJS 模組快取與 lazy initialization，但 Raw 與 Rust 在不同 process 執行而完全不互相污染。',
  '- **Correctness check 範圍**：各模式在計時區間外比對 `compile` / `render` 成功失敗、跨 batch 輸出一致性，以及 Raw vs Rust 產出 HTML 精確字串（`===`）。其餘相容性（`compileClient` JS、`locals` 副作用、error 物件、plugins 等）由 `rust/compiler/tests/differential/runner.js` 負責。',
  '- **統計口徑**：P50 / P95 採 linear interpolation；所有比較倍率統一為 `Rust / Raw`（`< 1.00x` 表示 Rust 較快，`> 1.00x` 表示 Rust 較慢）。',
  '',
  '## 2. Cold Load（每次獨立全新 Node Process）',
  '',
  '> 量測區間定義：',
  '> - **Compiler Module Load**：子程序內執行 `require(\'../raw/compiler/packages/pug\')` 或 `await import(\'../rust/compiler/index.js\')` 的純載入時間（不含 `shared.js` 載入）。',
  '> - **Process Startup & Overhead**：`總 Wall Time - Compiler Module Load`，包含 OS 建立 Node 子程序、V8 初始化、指令稿解析與 IPC/結束成本（此測試未啟動 Vite，不稱為 Vite Server 啟動時間）。',
  '',
  '| 量測區段 | Raw Avg (ms) | Raw P50 (ms) | Raw P95 (ms) | Rust Avg (ms) | Rust P50 (ms) | Rust P95 (ms) | Rust / Raw (P50) | Rust / Raw (Avg) |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  `| Compiler Module Load | ${fmtMs(coldSummary.moduleLoad.raw.avg)} | ${fmtMs(coldSummary.moduleLoad.raw.p50)} | ${fmtMs(coldSummary.moduleLoad.raw.p95)} | ${fmtMs(coldSummary.moduleLoad.rust.avg)} | ${fmtMs(coldSummary.moduleLoad.rust.p50)} | ${fmtMs(coldSummary.moduleLoad.rust.p95)} | ${fmtRatio(ratio(coldSummary.moduleLoad.rust.p50, coldSummary.moduleLoad.raw.p50))} | ${fmtRatio(ratio(coldSummary.moduleLoad.rust.avg, coldSummary.moduleLoad.raw.avg))} |`,
  `| Process Startup & Overhead | ${fmtMs(coldSummary.processOverhead.raw.avg)} | ${fmtMs(coldSummary.processOverhead.raw.p50)} | ${fmtMs(coldSummary.processOverhead.raw.p95)} | ${fmtMs(coldSummary.processOverhead.rust.avg)} | ${fmtMs(coldSummary.processOverhead.rust.p50)} | ${fmtMs(coldSummary.processOverhead.rust.p95)} | ${fmtRatio(ratio(coldSummary.processOverhead.rust.p50, coldSummary.processOverhead.raw.p50))} | ${fmtRatio(ratio(coldSummary.processOverhead.rust.avg, coldSummary.processOverhead.raw.avg))} |`,
  `| 單次冷啟動總 Wall Time | ${fmtMs(coldSummary.totalWall.raw.avg)} | ${fmtMs(coldSummary.totalWall.raw.p50)} | ${fmtMs(coldSummary.totalWall.raw.p95)} | ${fmtMs(coldSummary.totalWall.rust.avg)} | ${fmtMs(coldSummary.totalWall.rust.p50)} | ${fmtMs(coldSummary.totalWall.rust.p95)} | ${fmtRatio(ratio(coldSummary.totalWall.rust.p50, coldSummary.totalWall.raw.p50))} | ${fmtRatio(ratio(coldSummary.totalWall.rust.avg, coldSummary.totalWall.raw.avg))} |`,
  '',
  '## 3. 三種 Hot 模式總覽對比（P50 / Avg，單位 ms，倍率 = `Rust / Raw`）',
  '',
  '| 模式 | 納入檔案 | 階段 | Raw Avg | Raw P50 | Rust Avg | Rust P50 | Rust / Raw (P50) | Rust / Raw (Avg) |',
  '| --- | :---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |'
);

for (const sc of activeScenarios) {
  const res = scenarioResults[sc];
  const o = res.overall;
  const elig = `${o.eligibleFiles}/${res.correctnessSummary.totalFiles}`;
  md.push(
    `| \`${sc}\` | ${elig} | Compile | ${fmtMs(o.raw.compile.avg)} | ${fmtMs(o.raw.compile.p50)} | ${fmtMs(o.rust.compile.avg)} | ${fmtMs(o.rust.compile.p50)} | ${fmtRatio(ratio(o.rust.compile.p50, o.raw.compile.p50))} | ${fmtRatio(ratio(o.rust.compile.avg, o.raw.compile.avg))} |`,
    `| \`${sc}\` | ${elig} | Render | ${fmtMs(o.raw.render.avg)} | ${fmtMs(o.raw.render.p50)} | ${fmtMs(o.rust.render.avg)} | ${fmtMs(o.rust.render.p50)} | ${fmtRatio(ratio(o.rust.render.p50, o.raw.render.p50))} | ${fmtRatio(ratio(o.rust.render.avg, o.raw.render.avg))} |`
  );
  if (sc === 'build') {
    md.push(
      `| \`${sc}\` | ${elig} | Write HTML | ${fmtMs(o.raw.write.avg)} | ${fmtMs(o.raw.write.p50)} | ${fmtMs(o.rust.write.avg)} | ${fmtMs(o.rust.write.p50)} | ${fmtRatio(ratio(o.rust.write.p50, o.raw.write.p50))} | ${fmtRatio(ratio(o.rust.write.avg, o.raw.write.avg))} |`
    );
  }
  md.push(
    `| \`${sc}\` | ${elig} | **Total** | **${fmtMs(o.raw.total.avg)}** | **${fmtMs(o.raw.total.p50)}** | **${fmtMs(o.rust.total.avg)}** | **${fmtMs(o.rust.total.p50)}** | **${fmtRatio(ratio(o.rust.total.p50, o.raw.total.p50))}** | **${fmtRatio(ratio(o.rust.total.avg, o.raw.total.avg))}** |`
  );
}

let secNo = 4;
for (const sc of activeScenarios) {
  const res = scenarioResults[sc];
  const o = res.overall;
  const c = res.correctnessSummary;
  const meta = SCENARIO_META[sc];

  md.push(
    '',
    `## ${secNo++}. Hot Scenario：\`${sc}\``,
    '',
    `- 定義：${meta.title}`,
    `- 目的：${meta.target}`,
    `- 納入比較檔案：${o.eligibleFiles} / ${c.totalFiles}（總有效樣本數 Raw=${o.raw.total.count}, Rust=${o.rust.total.count}；Correctness 排除=${c.excluded}）`,
    '',
    '### 階段統計（ms）',
    '',
    '| 階段 | 指標 | Raw (ms) | Rust (ms) | Rust / Raw |',
    '| --- | --- | ---: | ---: | ---: |'
  );

  const stages = [
    ['Compile', o.raw.compile, o.rust.compile],
    ['Render', o.raw.render, o.rust.render],
  ];
  if (sc === 'build') {
    stages.push(['Write HTML', o.raw.write, o.rust.write]);
  }
  stages.push(['Total', o.raw.total, o.rust.total]);

  for (const [label, rRaw, rRust] of stages) {
    md.push(
      `| ${label} | Avg | ${fmtMs(rRaw.avg)} | ${fmtMs(rRust.avg)} | ${fmtRatio(ratio(rRust.avg, rRaw.avg))} |`,
      `| ${label} | P50 | ${fmtMs(rRaw.p50)} | ${fmtMs(rRust.p50)} | ${fmtRatio(ratio(rRust.p50, rRaw.p50))} |`,
      `| ${label} | P95 | ${fmtMs(rRaw.p95)} | ${fmtMs(rRust.p95)} | ${fmtRatio(ratio(rRust.p95, rRaw.p95))} |`,
      `| ${label} | Min / Max | ${fmtMs(rRaw.min)} / ${fmtMs(rRaw.max)} | ${fmtMs(rRust.min)} / ${fmtMs(rRust.max)} | — |`,
      `| ${label} | StdDev | ${fmtMs(rRaw.stdDev)} | ${fmtMs(rRust.stdDev)} | — |`
    );
  }

  md.push(
    `| 理論估算：50 次獨立執行（Total Avg × 50） | — | ${fmtMs(o.raw.total.avg !== null ? o.raw.total.avg * 50 : null)} | ${fmtMs(o.rust.total.avg !== null ? o.rust.total.avg * 50 : null)} | ${fmtRatio(ratio(o.rust.total.avg, o.raw.total.avg))} |`,
    '',
    '### 各 Batch 獨立執行結果',
    '',
    '| Batch | 執行順序 | Raw PID | Rust PID | Raw Compile P50 | Rust Compile P50 | Compile Ratio | Raw Total P50 | Rust Total P50 | Total Avg (Raw / Rust) | Total Ratio (P50) |',
    '| :---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |'
  );

  for (const b of res.batchSummaries) {
    md.push(
      `| ${b.batch} | ${b.order} | ${b.rawPid} | ${b.rustPid} | ${fmtMs(b.raw.compile.p50)} | ${fmtMs(b.rust.compile.p50)} | ${fmtRatio(ratio(b.rust.compile.p50, b.raw.compile.p50))} | ${fmtMs(b.raw.total.p50)} | ${fmtMs(b.rust.total.p50)} | ${fmtMs(b.raw.total.avg)} / ${fmtMs(b.rust.total.avg)} | ${fmtRatio(ratio(b.rust.total.p50, b.raw.total.p50))} |`
    );
  }

  md.push(
    '',
    '### Correctness 摘要',
    '',
    `- Total: ${c.totalFiles} | Raw success: ${c.rawSuccess} | Rust success: ${c.rustSuccess} | Common: ${c.commonSuccess} | HTML match: ${c.htmlMatch} | Mismatch: ${c.htmlMismatch} | Error: ${c.errors} | Excluded: ${c.excluded}`
  );

  const excluded = c.details.filter((d) => d.status !== 'MATCH');
  if (excluded.length > 0) {
    for (const d of excluded) {
      md.push(`  - \`${d.file}\` [${d.status}]: ${d.note}`);
    }
  }

  md.push(
    '',
    `### 各檔案詳細結果（\`${sc}\` Total，單位 ms；倍率 = \`Rust / Raw\`）`,
    '',
    '| 檔案 | 狀態 | Raw Avg | Raw P50 | Raw P95 | Rust Avg | Rust P50 | Rust P95 | Rust / Raw (P50) |',
    '| --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  );

  for (const f of res.perFile) {
    md.push(
      `| \`${f.file}\` | ${f.status} | ${fmtMs(f.raw.total.avg)} | ${fmtMs(f.raw.total.p50)} | ${fmtMs(f.raw.total.p95)} | ${fmtMs(f.rust.total.avg)} | ${fmtMs(f.rust.total.p50)} | ${fmtMs(f.rust.total.p95)} | ${fmtRatio(f.ratioTotalP50)} |`
    );
  }
}

fs.writeFileSync(reportPath, md.join('\n') + '\n', 'utf8');

console.log(`Benchmark completed (scenarios=${activeScenarios.join(',')}).`);
console.log(
  `  Cold Load (module): Raw P50=${fmtMs(coldSummary.moduleLoad.raw.p50)} ms | Rust P50=${fmtMs(coldSummary.moduleLoad.rust.p50)} ms | Rust/Raw=${fmtRatio(ratio(coldSummary.moduleLoad.rust.p50, coldSummary.moduleLoad.raw.p50))}`
);
for (const sc of activeScenarios) {
  const o = scenarioResults[sc].overall;
  const c = scenarioResults[sc].correctnessSummary;
  const writePart =
    sc === 'build'
      ? ` | write=${fmtMs(o.raw.write.p50)}/${fmtMs(o.rust.write.p50)}`
      : '';
  console.log(
    `  [${sc}] P50 (Raw/Rust ms): compile=${fmtMs(o.raw.compile.p50)}/${fmtMs(o.rust.compile.p50)} (${fmtRatio(ratio(o.rust.compile.p50, o.raw.compile.p50))}) | render=${fmtMs(o.raw.render.p50)}/${fmtMs(o.rust.render.p50)}${writePart} | total=${fmtMs(o.raw.total.p50)}/${fmtMs(o.rust.total.p50)} (${fmtRatio(ratio(o.rust.total.p50, o.raw.total.p50))}) | match=${c.htmlMatch}/${c.totalFiles}`
  );
}
if (activeScenarios.includes('build')) {
  console.log(`  HTML Dist         : ${distRawDir} , ${distRustDir}`);
}
console.log(`  Report            : ${reportPath}`);
console.log(`  Summary JSON      : ${summaryPath}`);
