import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_CASES_DIR,
  REPO_ROOT,
  buildOpts,
  createFilters,
  createLocals,
  loadTemplates,
  summarize,
} from '../shared.js';

const DIAG_DIR = import.meta.dirname;
const CASES = [
  'basic.pug',
  'attrs.pug',
  'mixin.attrs.pug',
  'code.conditionals.pug',
  'layout.multi.append.prepend.block.pug',
  'text.pug',
  'filters.nested.pug',
];

const WARMUP = 5;
const ROUNDS = 30;

function reviveAstBuffers(val) {
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i += 1) {
      reviveAstBuffers(val[i]);
    }
    return val;
  }
  if (val && typeof val === 'object' && !Buffer.isBuffer(val)) {
    if (
      val.type === 'FileReference' &&
      val.raw &&
      typeof val.raw === 'object' &&
      !Buffer.isBuffer(val.raw) &&
      val.raw.type === 'Buffer' &&
      Array.isArray(val.raw.data)
    ) {
      val.raw = Buffer.from(val.raw.data);
    }
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (k !== 'raw') {
        reviveAstBuffers(val[k]);
      }
    }
  }
  return val;
}

function dehydrateAstBuffers(val) {
  if (Array.isArray(val)) {
    return val.map(dehydrateAstBuffers);
  }
  if (val && typeof val === 'object' && !Buffer.isBuffer(val)) {
    const out = {};
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (
        k === 'raw' &&
        val.type === 'FileReference' &&
        Buffer.isBuffer(val.raw)
      ) {
        out.raw = { type: 'Buffer', data: Array.from(val.raw) };
      } else {
        out[k] = dehydrateAstBuffers(val[k]);
      }
    }
    return out;
  }
  return val;
}

function runRawWorker() {
  const require = createRequire(import.meta.url);
  const rawPug = require(
    path.resolve(REPO_ROOT, 'raw/compiler/packages/pug')
  );
  const templates = loadTemplates(DEFAULT_CASES_DIR, CASES);
  const out = {};

  for (const tpl of templates) {
    for (let i = 0; i < WARMUP; i += 1) {
      rawPug.compile(tpl.src, buildOpts(tpl.pugPath, DEFAULT_CASES_DIR, 'memory'));
    }
    const samples = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const opts = buildOpts(tpl.pugPath, DEFAULT_CASES_DIR, 'memory');
      const t0 = performance.now();
      rawPug.compile(tpl.src, opts);
      const t1 = performance.now();
      samples.push(t1 - t0);
    }
    out[tpl.file] = summarize(samples);
  }

  process.stdout.write(JSON.stringify(out));
}

async function main() {
  if (process.argv.includes('--raw-worker')) {
    runRawWorker();
    return;
  }

  // Ensure normal non-profile release addon is used
  if (process.env.PUG_PROFILE === '1') {
    throw new Error('Do not run 3A microbenchmark with PUG_PROFILE=1');
  }

  const rawRes = spawnSync(
    process.execPath,
    [import.meta.filename, '--raw-worker'],
    {
      encoding: 'utf8',
      env: { ...process.env },
    }
  );
  if (rawRes.status !== 0) {
    throw new Error(`Raw worker failed: ${rawRes.stderr}`);
  }
  const rawByFile = JSON.parse(rawRes.stdout);

  const require = createRequire(import.meta.url);
  const addonPath = path.resolve(
    REPO_ROOT,
    'compiler/pug-napi.win32-x64-msvc.node'
  );
  const native = require(addonPath);
  const { default: rustPug } = await import('../../index.js');
  const { default: runtimeWrap } = await import(
    '../../runtime/wrap.js'
  );

  // Measure token/AST size info once
  const templates = loadTemplates(DEFAULT_CASES_DIR, CASES);

  const filterMap = createFilters();
  // Create a filter callback identical to index.js for filters.nested.pug via rustPug's normal filter handling,
  // or compile via sparse callbacks
  const compilerRequire = createRequire(
    path.resolve(REPO_ROOT, 'compiler/index.js')
  );
  const rawNodeModules = path.resolve(REPO_ROOT, 'raw/compiler/node_modules');
  function requireFilterDep(name) {
    try {
      return compilerRequire(name);
    } catch (_) {
      return compilerRequire(path.join(rawNodeModules, name));
    }
  }
  const jstransformer = requireFilterDep('jstransformer');
  const resolveMod = requireFilterDep('resolve');
  function runJstransformerFilter(name, input, attrsObj, currentDirectory, method) {
    let trPath;
    try {
      trPath = resolveMod.sync('jstransformer-' + name, {
        basedir: currentDirectory || process.cwd(),
      });
    } catch (_) {
      try {
        trPath = compilerRequire.resolve('jstransformer-' + name);
      } catch (_2) {
        trPath = compilerRequire.resolve('jstransformer-' + name, {
          paths: [rawNodeModules],
        });
      }
    }
    const tr = jstransformer(compilerRequire(trPath));
    const opts = Object.assign({ filename: undefined }, attrsObj);
    const res = tr[method](input, opts);
    return { ok: true, value: res.body };
  }

  function makeSparseFilterCb() {
    return function filterCb(name, mode, text, fullPath, rawVal, attrsObj, dir) {
      if (filterMap[name]) {
        return { ok: true, value: filterMap[name](text, attrsObj) };
      }
      return runJstransformerFilter(
        name,
        mode === 'rawFile' ? fullPath : text,
        attrsObj,
        dir,
        mode === 'rawFile' ? 'renderFile' : 'render'
      );
    };
  }

  function makeCoreNativeOpts(tpl) {
    return {
      filename: tpl.pugPath,
      basedir: DEFAULT_CASES_DIR,
      pretty: '  ',
      compileDebug: true,
      doctype: undefined,
      inlineRuntimeFunctions: false,
      globals: [],
      useSelf: false,
      includeSources: false,
      templateName: 'template',
      filterOptions: null,
      filterAliases: { markdown: 'markdown-it' },
      lexPluginMethods: [],
    };
  }

  function measureVariant(fn) {
    if (typeof global.gc === 'function') global.gc();
    for (let i = 0; i < WARMUP; i += 1) {
      fn();
    }
    if (typeof global.gc === 'function') global.gc();
    const samples = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const t0 = performance.now();
      fn();
      const t1 = performance.now();
      samples.push(t1 - t0);
    }
    return summarize(samples);
  }

  const results = [];

  for (const tpl of templates) {
    const isFilterTpl = tpl.file === 'filters.nested.pug';
    const filterCb = isFilterTpl ? makeSparseFilterCb() : undefined;

    // Inspect token count & AST JSON byte size
    const tokens = rustPug._lex(tpl.src, { filename: tpl.pugPath });
    const tokenJsonBytes = Buffer.byteLength(JSON.stringify(tokens), 'utf8');
    let ast = rustPug._parse(tokens, {
      filename: tpl.pugPath,
      src: tpl.src,
    });
    const astJsonBytes = Buffer.byteLength(JSON.stringify(ast), 'utf8');

    // 1. Current public API: rustPug.compile(src, compatOpts)
    const currentApi = measureVariant(() =>
      rustPug.compile(tpl.src, buildOpts(tpl.pugPath, DEFAULT_CASES_DIR, 'memory'))
    );

    // 2. Native compileBodySync + full no-op callbacks (with revive/dehydrate) + runtimeWrap
    const fullReviveCallbacks = {
      warn: () => {},
      preLex: (s) => s,
      postLex: (t) => t,
      preParse: (t) => t,
      postParse: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      preLoad: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      read: (fp) => fs.readFileSync(fp),
      postLoad: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      preFilters: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      filter: filterCb,
      postFilters: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      preLink: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      postLink: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      preCodeGen: (a) => dehydrateAstBuffers(reviveAstBuffers(a)),
      postCodeGen: (js) => js,
    };
    const nativeFullReviveWithWrap = measureVariant(() => {
      const outcome = native.compileBodySync(
        tpl.src,
        makeCoreNativeOpts(tpl),
        fullReviveCallbacks
      );
      if (!outcome.ok) throw new Error(outcome.plainError || outcome.error?.message);
      runtimeWrap(outcome.body, 'template');
    });

    // 3. Native compileBodySync + identity callbacks (NO reviveAstBuffers/dehydrateAstBuffers) + runtimeWrap
    const identityCallbacks = {
      preLex: (s) => s,
      postLex: (t) => t,
      preParse: (t) => t,
      postParse: (a) => a,
      preLoad: (a) => a,
      postLoad: (a) => a,
      preFilters: (a) => a,
      filter: filterCb,
      postFilters: (a) => a,
      preLink: (a) => a,
      postLink: (a) => a,
      preCodeGen: (a) => a,
      postCodeGen: (js) => js,
    };
    const nativeIdentityWithWrap = measureVariant(() => {
      const outcome = native.compileBodySync(
        tpl.src,
        makeCoreNativeOpts(tpl),
        identityCallbacks
      );
      if (!outcome.ok) throw new Error(outcome.plainError || outcome.error?.message);
      runtimeWrap(outcome.body, 'template');
    });

    // 4. Token roundtrips only (postLex + preParse)
    const tokenOnlyCallbacks = {
      postLex: (t) => t,
      preParse: (t) => t,
      filter: filterCb,
    };
    const nativeTokenOnlyWithWrap = measureVariant(() => {
      const outcome = native.compileBodySync(
        tpl.src,
        makeCoreNativeOpts(tpl),
        tokenOnlyCallbacks
      );
      if (!outcome.ok) throw new Error(outcome.plainError || outcome.error?.message);
      runtimeWrap(outcome.body, 'template');
    });

    // 5. AST NAPI roundtrips only (8 AST identity hooks, no token hooks, no revive/dehydrate)
    const astOnlyCallbacks = {
      postParse: (a) => a,
      preLoad: (a) => a,
      postLoad: (a) => a,
      preFilters: (a) => a,
      filter: filterCb,
      postFilters: (a) => a,
      preLink: (a) => a,
      postLink: (a) => a,
      preCodeGen: (a) => a,
    };
    const nativeAstOnlyNoReviveWithWrap = measureVariant(() => {
      const outcome = native.compileBodySync(
        tpl.src,
        makeCoreNativeOpts(tpl),
        astOnlyCallbacks
      );
      if (!outcome.ok) throw new Error(outcome.plainError || outcome.error?.message);
      runtimeWrap(outcome.body, 'template');
    });

    // 6. Sparse / No-op callbacks omitted completely (undefined, or { filter } only when filter needed) + runtimeWrap
    const sparseCallbacks = isFilterTpl ? { filter: filterCb } : undefined;
    const nativeSparseWithWrap = measureVariant(() => {
      const outcome = native.compileBodySync(
        tpl.src,
        makeCoreNativeOpts(tpl),
        sparseCallbacks
      );
      if (!outcome.ok) throw new Error(outcome.plainError || outcome.error?.message);
      runtimeWrap(outcome.body, 'template');
    });

    // 7. Native sparse WITHOUT runtimeWrap (pure Rust NAPI call + return string)
    const nativeSparseBodyOnly = measureVariant(() => {
      const outcome = native.compileBodySync(
        tpl.src,
        makeCoreNativeOpts(tpl),
        sparseCallbacks
      );
      if (!outcome.ok) throw new Error(outcome.plainError || outcome.error?.message);
    });

    // Correctness sanity check: confirm sparse compile produces identical HTML to raw/current
    const testSparseOutcome = native.compileBodySync(
      tpl.src,
      makeCoreNativeOpts(tpl),
      sparseCallbacks
    );
    const sparseFn = runtimeWrap(testSparseOutcome.body, 'template');
    const currentFn = rustPug.compile(
      tpl.src,
      buildOpts(tpl.pugPath, DEFAULT_CASES_DIR, 'memory')
    );
    const htmlMatch = sparseFn(createLocals()) === currentFn(createLocals());
    if (!htmlMatch) {
      throw new Error(`HTML mismatch on sparse path for ${tpl.file}`);
    }

    const raw = rawByFile[tpl.file];
    const tokenCostP50 = nativeTokenOnlyWithWrap.p50 - nativeSparseWithWrap.p50;
    const astSerdeV8CostP50 =
      nativeAstOnlyNoReviveWithWrap.p50 - nativeSparseWithWrap.p50;
    const jsReviveDehydrateCostP50 =
      nativeFullReviveWithWrap.p50 - nativeIdentityWithWrap.p50;
    const jsWrapCostP50 = nativeSparseWithWrap.p50 - nativeSparseBodyOnly.p50;

    results.push({
      file: tpl.file,
      tokenCount: tokens.length,
      tokenJsonBytes,
      astJsonBytes,
      htmlMatch,
      rawP50Ms: raw.p50,
      rustCurrentApiP50Ms: currentApi.p50,
      nativeFullReviveWithWrapP50Ms: nativeFullReviveWithWrap.p50,
      nativeIdentityWithWrapP50Ms: nativeIdentityWithWrap.p50,
      nativeTokenOnlyWithWrapP50Ms: nativeTokenOnlyWithWrap.p50,
      nativeAstOnlyNoReviveWithWrapP50Ms: nativeAstOnlyNoReviveWithWrap.p50,
      nativeSparseWithWrapP50Ms: nativeSparseWithWrap.p50,
      nativeSparseBodyOnlyP50Ms: nativeSparseBodyOnly.p50,
      decompositionP50Ms: {
        tokenRoundtrips: tokenCostP50,
        astNapiSerdeV8Roundtrips: astSerdeV8CostP50,
        jsReviveDehydrateClone: jsReviveDehydrateCostP50,
        runtimeWrapNewFunction: jsWrapCostP50,
      },
      ratiosVsRawP50: {
        currentApi: currentApi.p50 / raw.p50,
        sparseWithWrap: nativeSparseWithWrap.p50 / raw.p50,
        sparseRustOnly: nativeSparseBodyOnly.p50 / raw.p50,
      },
      speedupIfNoOpHooksRemoved: currentApi.p50 / nativeSparseWithWrap.p50,
      summaries: {
        raw,
        currentApi,
        nativeFullReviveWithWrap,
        nativeIdentityWithWrap,
        nativeTokenOnlyWithWrap,
        nativeAstOnlyNoReviveWithWrap,
        nativeSparseWithWrap,
        nativeSparseBodyOnly,
      },
    });

    console.log(
      `${tpl.file.padEnd(38)} | Raw=${raw.p50.toFixed(3)}ms | CurAPI=${currentApi.p50.toFixed(3)}ms (${(currentApi.p50 / raw.p50).toFixed(2)}x) | Sparse+Wrap=${nativeSparseWithWrap.p50.toFixed(3)}ms (${(nativeSparseWithWrap.p50 / raw.p50).toFixed(2)}x) | TokenRT=${tokenCostP50.toFixed(3)}ms | AstSerdeRT=${astSerdeV8CostP50.toFixed(3)}ms | JsReviveClone=${jsReviveDehydrateCostP50.toFixed(3)}ms`
    );
  }

  const outPath = path.join(DIAG_DIR, 'micro-3a-napi-roundtrip.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        addonPath,
        warmup: WARMUP,
        rounds: ROUNDS,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nSaved 3A microbenchmark report to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
