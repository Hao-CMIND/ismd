import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const loadedEsmUrls = new Set();
if (typeof registerHooks === 'function') {
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:')) {
        loadedEsmUrls.add(url);
      }
      return nextLoad(url, context);
    },
  });
}

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

const rustRoot = path.resolve(import.meta.dirname, '..');
const rustEntryPath = path.join(rustRoot, 'index.mjs');
const rustPkgJsonPath = path.join(rustRoot, 'package.json');

const tBeforeLoad = performance.now();
const { default: ismd } = await import('../index.mjs');
const tAfterLoad = performance.now();
const loadMs = tAfterLoad - tBeforeLoad;

if (typeof ismd.compile !== 'function' || typeof ismd.compileFile !== 'function') {
  throw new Error('Rust Ismd compiler did not expose compile() / compileFile()');
}

const shared = await import('./shared.mjs');
const batch = shared.parsePositiveIntFlag(args, '--batch', 1);

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function inspectNativeAddon(moduleAudit) {
  const loadedAddons = moduleAudit.nativeAddonMatches || [];
  const actualAddonPath = loadedAddons[0] ? path.resolve(loadedAddons[0]) : null;
  const releaseDll = path.join(rustRoot, 'target/release/ismd_napi.dll');
  const debugDll = path.join(rustRoot, 'target/debug/ismd_napi.dll');
  const cargoTomlPath = path.join(rustRoot, 'Cargo.toml');
  const cargoToml = fs.existsSync(cargoTomlPath)
    ? fs.readFileSync(cargoTomlPath, 'utf8')
    : '';

  const actualHash =
    actualAddonPath && fs.existsSync(actualAddonPath)
      ? sha256File(actualAddonPath)
      : null;
  const actualBytes =
    actualAddonPath && fs.existsSync(actualAddonPath)
      ? fs.statSync(actualAddonPath).size
      : null;

  const releaseHash = fs.existsSync(releaseDll) ? sha256File(releaseDll) : null;
  const debugHash = fs.existsSync(debugDll) ? sha256File(debugDll) : null;

  const matchesRelease = Boolean(actualHash && releaseHash && actualHash === releaseHash);
  const matchesDebug = Boolean(actualHash && debugHash && actualHash === debugHash);

  const hasCustomReleaseProfile = /\[profile\.release\]/.test(cargoToml);
  let profile = 'unknown';
  let optimizationLevel = 'unknown';
  if (matchesRelease) {
    profile = 'release';
    optimizationLevel = hasCustomReleaseProfile
      ? 'custom [profile.release] in Cargo.toml'
      : 'opt-level=3 (Cargo release default; no [profile.release] override, lto=false, codegen-units=16)';
  } else if (matchesDebug) {
    profile = 'dev (debug)';
    optimizationLevel = 'opt-level=0 (Cargo dev default)';
  }

  return {
    actualAddonPath,
    actualBytes,
    actualSha256: actualHash,
    matchesRelease,
    matchesDebug,
    profile,
    optimizationLevel,
  };
}

const rustPkg = JSON.parse(fs.readFileSync(rustPkgJsonPath, 'utf8'));

let payload;

if (mode === 'cold') {
  const moduleAudit = shared.auditLoadedModules(require.cache, 'rust', loadedEsmUrls);
  if (!moduleAudit.isolationOk) {
    throw new Error(
      `Isolation violation in rust.mjs: selfLoadedOk=${moduleAudit.selfLoadedOk}, rawMatches=${moduleAudit.rawCompilerMatches.join(', ')}`
    );
  }
  payload = {
    compiler: 'rust',
    mode: 'cold',
    batch,
    pid: process.pid,
    entryNowMs: tBeforeLoad,
    loadMs,
    compilerVersion: rustPkg.version,
    compilerEntryPath: rustEntryPath,
    nativeInfo: inspectNativeAddon(moduleAudit),
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
    distDirArg || path.join(shared.BENCHMARKS_DIR, 'dist', 'rust');

  const templates = shared.loadTemplates(
    shared.DEFAULT_CASES_DIR,
    scenario === 'pure' ? shared.PURE_CASES : null
  );
  const { correctness, samples } = shared.benchmarkHot(ismd, templates, {
    compilerName: 'rust',
    scenario,
    batch,
    rounds,
    casesDir: shared.DEFAULT_CASES_DIR,
    outDir: distDir,
    warmupRounds: 1,
  });

  const moduleAudit = shared.auditLoadedModules(require.cache, 'rust', loadedEsmUrls);
  if (!moduleAudit.isolationOk) {
    throw new Error(
      `Isolation violation in rust.mjs: selfLoadedOk=${moduleAudit.selfLoadedOk}, rawMatches=${moduleAudit.rawCompilerMatches.join(', ')}`
    );
  }

  payload = {
    compiler: 'rust',
    mode: 'hot',
    scenario,
    batch,
    rounds,
    pid: process.pid,
    loadMs,
    compilerVersion: rustPkg.version,
    compilerEntryPath: rustEntryPath,
    nativeInfo: inspectNativeAddon(moduleAudit),
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
