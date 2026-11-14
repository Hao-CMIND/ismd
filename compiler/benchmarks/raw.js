import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

function getFlag(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  if (idx + 1 >= args.length || args[idx + 1].startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return args[idx + 1];
}

const mode = getFlag('--mode', 'hot');
if (mode !== 'cold' && mode !== 'hot') {
  throw new Error(`Unsupported --mode "${mode}". Expected "cold" or "hot".`);
}
const outPath = getFlag('--out', null);
const distDirArg = getFlag('--dist-dir', null);

const rawEntryPath = path.resolve(
  import.meta.dirname,
  '../../raw/compiler/packages/pug'
);
const rawPkgJsonPath = path.join(rawEntryPath, 'package.json');

const tBeforeLoad = performance.now();
const pug = require('../../raw/compiler/packages/pug');
const tAfterLoad = performance.now();
const loadMs = tAfterLoad - tBeforeLoad;

if (typeof pug.compile !== 'function' || typeof pug.compileFile !== 'function') {
  throw new Error('Raw Pug compiler did not expose compile() / compileFile()');
}

const shared = await import('./shared.js');
const batch = shared.parsePositiveIntFlag(args, '--batch', 1);

const rawPkg = JSON.parse(fs.readFileSync(rawPkgJsonPath, 'utf8'));
const resolvedEntry = require.resolve('../../raw/compiler/packages/pug');

let payload;

if (mode === 'cold') {
  const moduleAudit = shared.auditLoadedModules(require.cache, 'raw');
  if (!moduleAudit.isolationOk) {
    throw new Error(
      `Isolation violation in raw.js: loaded ${moduleAudit.rustCompilerMatches.join(', ')}`
    );
  }
  payload = {
    compiler: 'raw',
    mode: 'cold',
    batch,
    pid: process.pid,
    entryNowMs: tBeforeLoad,
    loadMs,
    compilerVersion: rawPkg.version,
    compilerEntryPath: resolvedEntry,
    moduleAudit,
  };
} else {
  const scenario = shared.parseScenarioFlag(args, false);
  const rounds = shared.parsePositiveIntFlag(
    args,
    '--rounds',
    shared.DEFAULT_ROUNDS
  );
  const distDir =
    distDirArg || path.join(shared.BENCHMARKS_DIR, 'dist', 'raw');

  const templates = shared.loadTemplates(
    shared.DEFAULT_CASES_DIR,
    scenario === 'pure' ? shared.PURE_CASES : null
  );
  const { correctness, samples } = shared.benchmarkHot(pug, templates, {
    compilerName: 'raw',
    scenario,
    batch,
    rounds,
    casesDir: shared.DEFAULT_CASES_DIR,
    outDir: distDir,
    warmupRounds: 1,
  });

  const moduleAudit = shared.auditLoadedModules(require.cache, 'raw');
  if (!moduleAudit.isolationOk) {
    throw new Error(
      `Isolation violation in raw.js: loaded ${moduleAudit.rustCompilerMatches.join(', ')}`
    );
  }

  payload = {
    compiler: 'raw',
    mode: 'hot',
    scenario,
    batch,
    rounds,
    pid: process.pid,
    loadMs,
    compilerVersion: rawPkg.version,
    compilerEntryPath: resolvedEntry,
    templateCount: templates.length,
    moduleAudit,
    correctness,
    samples,
  };
}

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
} else {
  process.stdout.write(JSON.stringify(payload) + '\n');
}
