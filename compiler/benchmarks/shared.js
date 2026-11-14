import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const BENCHMARKS_DIR = import.meta.dirname;
export const REPO_ROOT = path.resolve(BENCHMARKS_DIR, '../..');
export const DEFAULT_CASES_DIR = path.resolve(
  REPO_ROOT,
  'raw/compiler/packages/pug/test/cases'
);

export const VALID_SCENARIOS = ['memory', 'file', 'build', 'pure'];
export const DEFAULT_SCENARIOS = ['memory', 'file', 'build'];
export const PURE_CASES = [
  'basic.pug',
  'doctype.default.pug',
  'comments.source.pug',
  'text.pug',
  'nesting.pug',
  'code.conditionals.pug',
  'attrs.pug',
  'layout.multi.append.prepend.block.pug',
];
export const DEFAULT_ROUNDS = 30;
export const DEFAULT_COLD_BATCHES = 10;
export const DEFAULT_HOT_BATCHES = 5;

/**
 * Strictly parse a positive integer CLI flag (e.g. --rounds 30).
 * Rejects missing value, NaN, Infinity, non-integers, 0, and negative numbers.
 */
export function parsePositiveIntFlag(args, flagName, defaultValue) {
  const idx = args.indexOf(flagName);
  if (idx === -1) return defaultValue;

  if (idx + 1 >= args.length) {
    throw new Error(`Missing value for ${flagName}`);
  }
  const rawValue = args[idx + 1];
  if (rawValue.startsWith('--')) {
    throw new Error(`Missing value for ${flagName} (got "${rawValue}")`);
  }

  const trimmed = rawValue.trim();
  if (trimmed === '' || !/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid value for ${flagName}: "${rawValue}". Expected a finite integer >= 1.`
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Invalid value for ${flagName}: "${rawValue}". Expected a finite integer >= 1.`
    );
  }
  return parsed;
}

export function parseScenarioFlag(args, allowAll = true) {
  const idx = args.indexOf('--scenario');
  if (idx === -1) return allowAll ? 'all' : 'memory';
  if (idx + 1 >= args.length || args[idx + 1].startsWith('--')) {
    throw new Error('Missing value for --scenario');
  }
  const val = args[idx + 1].trim();
  const allowed = allowAll ? [...VALID_SCENARIOS, 'all'] : VALID_SCENARIOS;
  if (!allowed.includes(val)) {
    throw new Error(
      `Invalid --scenario "${val}". Expected one of: ${allowed.join(', ')}`
    );
  }
  return val;
}

/**
 * Standalone custom filter helper matching raw/compiler/packages/pug/test/run-utils.js,
 * extracted here so rust.js never imports run-utils.js (which requires Raw Pug).
 */
export function createFilters() {
  return {
    custom(str, options) {
      assert(options && options.opt === 'val');
      assert(options && options.num === 2);
      return 'BEGIN' + str + 'END';
    },
  };
}

export function createLocals() {
  return { title: 'Pug' };
}

export function loadTemplates(casesDir = DEFAULT_CASES_DIR, filterFiles = null) {
  let files = fs
    .readdirSync(casesDir)
    .filter((file) => file.endsWith('.pug'))
    .sort();

  if (Array.isArray(filterFiles) && filterFiles.length > 0) {
    const allow = new Set(filterFiles);
    files = filterFiles.filter((f) => allow.has(f) && files.includes(f));
  }

  return files.map((file) => {
    const pugPath = path.join(casesDir, file);
    return {
      file,
      pugPath,
      htmlName: file.replace(/\.pug$/, '.html'),
      src: fs.readFileSync(pugPath, 'utf8'),
    };
  });
}

export function buildOpts(pugPath, casesDir = DEFAULT_CASES_DIR, scenario = 'memory') {
  if (scenario === 'pure') {
    return {
      filename: pugPath,
      basedir: casesDir,
      pretty: true,
      doctype: undefined,
    };
  }
  const opts = {
    filename: pugPath,
    basedir: casesDir,
    pretty: true,
    doctype: undefined,
    filters: createFilters(),
    filterAliases: { markdown: 'markdown-it' },
  };
  if (scenario === 'file' || scenario === 'build') {
    opts.cache = false;
  }
  return opts;
}

export function compileAndRenderOnce(compiler, tpl, config = {}) {
  const {
    casesDir = DEFAULT_CASES_DIR,
    scenario = 'memory',
    outDir = null,
    skipWrite = false,
  } = config;

  const options = buildOpts(tpl.pugPath, casesDir, scenario);

  const t0 = performance.now();
  const fn =
    scenario === 'memory' || scenario === 'pure'
      ? compiler.compile(tpl.src, options)
      : compiler.compileFile(tpl.pugPath, options);
  const t1 = performance.now();
  const html = fn(createLocals());
  const t2 = performance.now();

  let writeMs = null;
  let t3 = t2;
  if (scenario === 'build' && !skipWrite) {
    if (!outDir) {
      throw new Error('outDir is required for scenario "build"');
    }
    fs.writeFileSync(path.join(outDir, tpl.htmlName), html, 'utf8');
    t3 = performance.now();
    writeMs = t3 - t2;
  }

  return {
    html,
    compileMs: t1 - t0,
    renderMs: t2 - t1,
    writeMs,
    totalMs: t3 - t0,
  };
}

export function serializeError(err) {
  return {
    name: err && err.name ? String(err.name) : 'Error',
    message: err && err.message ? String(err.message) : String(err),
  };
}

/**
 * Untimed correctness check executed before warm-up and hot measurement.
 * Records compile/render success and exact HTML string for each template.
 */
export function correctnessCheck(compiler, templates, config = {}) {
  const { casesDir = DEFAULT_CASES_DIR, scenario = 'memory' } = config;
  const results = [];

  for (const tpl of templates) {
    const options = buildOpts(tpl.pugPath, casesDir, scenario);
    let fn = null;
    let compileOk = false;
    let renderOk = false;
    let html = null;
    let error = null;

    try {
      fn =
        scenario === 'memory' || scenario === 'pure'
          ? compiler.compile(tpl.src, options)
          : compiler.compileFile(tpl.pugPath, options);
      compileOk = true;
    } catch (err) {
      error = serializeError(err);
    }

    if (compileOk) {
      try {
        html = fn(createLocals());
        renderOk = true;
      } catch (err) {
        error = serializeError(err);
      }
    }

    results.push({
      file: tpl.file,
      compileOk,
      renderOk,
      ok: compileOk && renderOk,
      html,
      error,
    });
  }
  return results;
}

/**
 * Linear-interpolation percentile over an already-sorted numeric array.
 * Returns null when values is empty.
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];

  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarize(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      count: 0,
      sum: null,
      avg: null,
      p50: null,
      p95: null,
      min: null,
      max: null,
      stdDev: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += sorted[i];
  }
  const avg = sum / count;

  let sqDiffSum = 0;
  for (let i = 0; i < count; i++) {
    const d = sorted[i] - avg;
    sqDiffSum += d * d;
  }
  const stdDev = Math.sqrt(sqDiffSum / count);

  return {
    count,
    sum,
    avg,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[count - 1],
    stdDev,
  };
}

/**
 * Hot benchmark executed inside a single isolated compiler child process:
 * 1. Correctness check (untimed)
 * 2. Warm-up pass (1 full round over all templates, untimed)
 * 3. Measured rounds (record compileMs, renderMs, writeMs, totalMs, ok, error)
 */
export function benchmarkHot(compiler, templates, options = {}) {
  const {
    compilerName,
    scenario = 'memory',
    batch = 1,
    rounds = DEFAULT_ROUNDS,
    casesDir = DEFAULT_CASES_DIR,
    outDir = null,
    warmupRounds = 1,
  } = options;

  if (!VALID_SCENARIOS.includes(scenario)) {
    throw new Error(`Invalid scenario: "${scenario}"`);
  }
  if (!Number.isFinite(rounds) || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`Invalid rounds: ${rounds}. Expected finite integer >= 1.`);
  }
  if (scenario === 'build') {
    if (!outDir) {
      throw new Error('outDir is required for scenario "build"');
    }
    fs.mkdirSync(outDir, { recursive: true });
  }

  const correctness = correctnessCheck(compiler, templates, {
    casesDir,
    scenario,
  });

  for (let w = 0; w < warmupRounds; w++) {
    for (const tpl of templates) {
      try {
        compileAndRenderOnce(compiler, tpl, {
          casesDir,
          scenario,
          outDir,
          skipWrite: scenario === 'build',
        });
      } catch (_) {
        // Failures are captured in correctnessCheck and measured rounds.
      }
    }
  }

  const samples = [];
  for (let round = 1; round <= rounds; round++) {
    for (const tpl of templates) {
      try {
        const res = compileAndRenderOnce(compiler, tpl, {
          casesDir,
          scenario,
          outDir,
        });
        samples.push({
          compiler: compilerName,
          scenario,
          batch,
          round,
          file: tpl.file,
          compileMs: res.compileMs,
          renderMs: res.renderMs,
          writeMs: res.writeMs,
          totalMs: res.totalMs,
          ok: true,
          error: null,
        });
      } catch (err) {
        samples.push({
          compiler: compilerName,
          scenario,
          batch,
          round,
          file: tpl.file,
          compileMs: null,
          renderMs: null,
          writeMs: null,
          totalMs: null,
          ok: false,
          error: serializeError(err),
        });
      }
    }
  }

  return { correctness, samples };
}

/**
 * Inspect CJS module cache (used by both raw.js and rust.js) to verify
 * that Raw Pug and Rust Pug never cross-load each other.
 */
export function auditLoadedModules(requireCache, compilerName) {
  const keys = Object.keys(requireCache || {});
  const norm = keys.map((k) => k.replace(/\\/g, '/'));

  const rawCompilerMatches = norm.filter((p) =>
    /\/raw\/compiler\/packages\/pug(?:-|\b|\/)/.test(p)
  );
  const rawFilterDeps = norm.filter((p) =>
    /\/raw\/compiler\/node_modules\//.test(p)
  );
  const compilerRoot = path.resolve(BENCHMARKS_DIR, '..').replace(/\\/g, '/').toLowerCase() + '/';
  const rustCompilerMatches = norm.filter((p) =>
    p.toLowerCase().startsWith(compilerRoot)
  );
  const nativeAddonMatches = norm.filter((p) => /\.(?:node|dll)$/i.test(p));

  const violation =
    compilerName === 'rust'
      ? rawCompilerMatches.length > 0
      : rustCompilerMatches.length > 0;

  return {
    compiler: compilerName,
    totalCjsCached: keys.length,
    rawCompilerMatches,
    rawFilterDepsCount: rawFilterDeps.length,
    rawFilterDepsSample: rawFilterDeps.slice(0, 10),
    rustCompilerMatches,
    nativeAddonMatches,
    isolationOk: !violation,
  };
}
