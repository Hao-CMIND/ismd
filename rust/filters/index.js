import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

let cachedFilterResolve = null;
let cachedJstransformerFn = null;
const jstransformerPathCache = new Map();
const jstransformerInstanceCache = new Map();

const metrics = {
  resolveModuleLoads: 0,
  jstransformerModuleLoads: 0,
  resolveLookups: 0,
  resolveCacheHits: 0,
  transformerCacheHits: 0,
  filterExecutions: 0,
};

function requireFilterDep(name) {
  try {
    return require(name);
  } catch (_) {
    return require(path.join(__dirname, '../../raw/compiler/node_modules', name));
  }
}

export function getFilterTransformer(name, currentDirectory) {
  const basedir = currentDirectory || process.cwd();
  const cacheKey = basedir + '\0' + name;
  let trPath = jstransformerPathCache.get(cacheKey);
  if (trPath === undefined) {
    metrics.resolveLookups += 1;
    if (!cachedFilterResolve) {
      cachedFilterResolve = requireFilterDep('resolve');
      metrics.resolveModuleLoads += 1;
    }
    try {
      try {
        trPath = cachedFilterResolve.sync('jstransformer-' + name, {
          basedir,
        });
      } catch (_) {
        try {
          trPath = require.resolve('jstransformer-' + name);
        } catch (_2) {
          trPath = require.resolve('jstransformer-' + name, {
            paths: [path.join(__dirname, '../../raw/compiler/node_modules')],
          });
        }
      }
    } catch (_) {
      return null;
    }
    jstransformerPathCache.set(cacheKey, trPath);
  } else {
    metrics.resolveCacheHits += 1;
  }

  let tr = jstransformerInstanceCache.get(trPath);
  if (!tr) {
    if (!cachedJstransformerFn) {
      cachedJstransformerFn = requireFilterDep('jstransformer');
      metrics.jstransformerModuleLoads += 1;
    }
    tr = cachedJstransformerFn(require(trPath));
    jstransformerInstanceCache.set(trPath, tr);
  } else {
    metrics.transformerCacheHits += 1;
  }
  return tr;
}

export function runJstransformerFilter(name, str, options, currentDirectory, funcName) {
  funcName = funcName || 'render';
  const tr = getFilterTransformer(name, currentDirectory);
  if (!tr) {
    return {
      ok: false,
      unknownFilter: 'unknown filter ":' + name + '"',
    };
  }
  let result = tr[funcName](str, options, options).body;
  if (options && options.minify) {
    const minifyName =
      tr.outputFormat === 'js'
        ? 'uglify-js'
        : tr.outputFormat === 'css'
          ? 'clean-css'
          : null;
    if (minifyName) {
      try {
        const minRes = runJstransformerFilter(
          minifyName,
          result,
          null,
          currentDirectory,
          'render'
        );
        if (minRes.ok) {
          result = minRes.value;
        }
      } catch (_) {}
    }
  }
  if (typeof result !== 'string') {
    throw new TypeError(
      'Expected filter ":' + name + '" to return a string, got ' + typeof result
    );
  }
  return { ok: true, value: result };
}

export function createFilterExecutor(filtersSet = {}) {
  return {
    execute(filterName, mode, text, fullPath, rawVal, attrsObj, dir) {
      metrics.filterExecutions += 1;
      if (filtersSet && filtersSet[filterName]) {
        const custom = filtersSet[filterName];
        const out =
          mode === 'rawFile' && custom.renderBuffer
            ? custom.renderBuffer(rawVal, attrsObj)
            : custom(text, attrsObj);
        if (typeof out !== 'string') {
          throw new TypeError(
            'Expected filter ":' + filterName + '" to return a string, got ' + typeof out
          );
        }
        return { ok: true, value: out };
      }
      return runJstransformerFilter(
        filterName,
        mode === 'rawFile' ? fullPath : text,
        attrsObj,
        dir,
        mode === 'rawFile' ? 'renderFile' : 'render'
      );
    },
  };
}

export function createFilterCallback(filtersSet = {}) {
  const executor = createFilterExecutor(filtersSet);
  return function filterHostCallback(filterName, mode, text, fullPath, rawVal, attrsObj, dir) {
    return executor.execute(filterName, mode, text, fullPath, rawVal, attrsObj, dir);
  };
}

export function getFilterMetrics() {
  return { ...metrics };
}

export function resetFilterMetrics() {
  metrics.resolveModuleLoads = 0;
  metrics.jstransformerModuleLoads = 0;
  metrics.resolveLookups = 0;
  metrics.resolveCacheHits = 0;
  metrics.transformerCacheHits = 0;
  metrics.filterExecutions = 0;
}

export default {
  getFilterTransformer,
  runJstransformerFilter,
  createFilterExecutor,
  createFilterCallback,
  getFilterMetrics,
  resetFilterMetrics,
};
