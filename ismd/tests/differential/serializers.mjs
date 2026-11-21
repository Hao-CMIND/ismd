import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const RUST_COMPILER_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_RAW_COMPILER = path.resolve(RUST_COMPILER_ROOT, '../raw/compiler');
const DEFAULT_RAW_PUG = path.resolve(RUST_COMPILER_ROOT, '../raw/pug');
const RAW_COMPILER_ROOT = process.env.ISMD_REFERENCE_ROOT
  ? path.resolve(process.env.ISMD_REFERENCE_ROOT)
  : fs.existsSync(DEFAULT_RAW_COMPILER)
    ? DEFAULT_RAW_COMPILER
    : DEFAULT_RAW_PUG;

function requireFromRaw(modName) {
  try {
    return require(path.join(RAW_COMPILER_ROOT, 'node_modules', modName));
  } catch (_) {
    try {
      return require(modName);
    } catch (err) {
      throw new Error(
        `Differential test dependency '${modName}' not found. ` +
          `Set ISMD_REFERENCE_ROOT to a reference compiler checkout with node_modules installed ` +
          `(checked ${RAW_COMPILER_ROOT}): ${err && err.message ? err.message : String(err)}`
      );
    }
  }
}

const prettier = requireFromRaw('prettier');
const prettyFormat = requireFromRaw('pretty-format');

const PRETTIER_OPTIONS = { parser: 'babel' };

let EXPECTED_DIFFERENCES = { environmentDifferences: [], normalizationRules: [] };
try {
  const diffPath = path.join(RUST_COMPILER_ROOT, 'compat/expected-differences.json');
  if (fs.existsSync(diffPath)) {
    EXPECTED_DIFFERENCES = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
  }
} catch {
  // fallback to empty config if not present
}

/**
 * Normalize a path string by replacing any known basedir prefix with `<basedir>`
 * and converting backslashes to forward slashes, matching `filename-serializer.js`.
 */
function matchesBasedir(value, basedirs = [RAW_COMPILER_ROOT, RUST_COMPILER_ROOT]) {
  if (typeof value !== 'string') return false;
  const normVal = value.replace(/\\/g, '/');
  return basedirs.some((b) => normVal.indexOf(b.replace(/\\/g, '/')) === 0);
}

function removeBasedir(value, basedirs = [RAW_COMPILER_ROOT, RUST_COMPILER_ROOT]) {
  if (typeof value !== 'string') return value;
  const normVal = value.replace(/\\/g, '/');
  for (const b of basedirs) {
    const normBase = b.replace(/\\/g, '/');
    if (normVal.indexOf(normBase) === 0) {
      return '<basedir>' + value.substr(b.length).replace(/\\/g, '/');
    }
  }
  return value;
}

/**
 * Equivalent to `raw/compiler/scripts/filename-serializer.js`
 */
function createFilenameSerializer(basedirs = [RAW_COMPILER_ROOT, RUST_COMPILER_ROOT]) {
  return {
    test(val) {
      return Boolean(
        val &&
          typeof val === 'object' &&
          (matchesBasedir(val.filename, basedirs) ||
            matchesBasedir(val.message, basedirs))
      );
    },
    print(val, serialize) {
      const output = {};
      for (const key in val) {
        output[key] = val[key];
      }
      if (matchesBasedir(output.filename, basedirs)) {
        output.filename = removeBasedir(output.filename, basedirs);
      }
      if (matchesBasedir(output.message, basedirs)) {
        output.message = removeBasedir(output.message, basedirs);
      }
      return serialize(output);
    },
  };
}

/**
 * Equivalent to `raw/compiler/scripts/prettier-javascript-serializer.js`
 */
const prettierJavascriptSerializer = {
  test(val) {
    try {
      return (
        typeof val === 'string' &&
        /function /.test(val) &&
        val !== prettier.format(val, PRETTIER_OPTIONS)
      );
    } catch (_) {
      return false;
    }
  },
  print(val, serialize) {
    return serialize(prettier.format(val, PRETTIER_OPTIONS));
  },
};

/**
 * Equivalent to `raw/compiler/scripts/buffer-serializer.js`
 */
const bufferSerializer = {
  test(val) {
    return Boolean(val && Buffer.isBuffer(val));
  },
  print(val, serialize) {
    const output = {
      type: 'Buffer',
      size: val.length,
      hash: crypto.createHash('md5').update(val).digest('hex'),
    };
    return serialize(output);
  },
};

const defaultFilenameSerializer = createFilenameSerializer();

/**
 * Formats a JS value using the exact same `pretty-format` configuration and
 * serializer chain that Jest uses for `.toMatchSnapshot()` in `raw/compiler`.
 */
function formatForSnapshot(val, basedirs) {
  const fnSerializer = basedirs
    ? createFilenameSerializer(basedirs)
    : defaultFilenameSerializer;
  return prettyFormat(val, {
    escapeRegex: true,
    printFunctionName: false,
    plugins: [fnSerializer, prettierJavascriptSerializer, bufferSerializer],
  });
}

/**
 * Parses a Jest `.snap` file and returns a Map of `snapshotKey -> rawSnapshotBody`.
 */
function parseJestSnapFile(snapFilePath) {
  const content = fs.readFileSync(snapFilePath, 'utf8');
  const exportsObj = {};
  const fn = new Function('exports', content);
  fn(exportsObj);
  const result = {};
  for (const [k, v] of Object.entries(exportsObj)) {
    result[k] = typeof v === 'string' ? v.replace(/^\n|\n$/g, '') : v;
  }
  return result;
}

/**
 * Formats JavaScript source with Prettier (`babel` parser), matching
 * `raw/compiler/scripts/prettier-javascript-serializer.js`.
 */
function formatJsWithPrettier(code) {
  return prettier.format(code, PRETTIER_OPTIONS);
}

/**
 * Two-layer comparison for `compileClient` and `ismd-code-gen` outputs,
 * as required by PLAN.md:
 *   Layer 1: Prettier (`babel` parser) formatted equivalence
 *   Layer 2: Unformatted raw string equivalence
 */
function compareCodegen(expectedRawJs, actualRawJs) {
  const rawMatch = expectedRawJs === actualRawJs;
  let formattedExpected = expectedRawJs;
  let formattedActual = actualRawJs;
  let prettierError = null;
  try {
    formattedExpected = formatJsWithPrettier(expectedRawJs);
  } catch (err) {
    prettierError = `expected Prettier error: ${err.message}`;
  }
  try {
    formattedActual = formatJsWithPrettier(actualRawJs);
  } catch (err) {
    prettierError = `actual Prettier error: ${err.message}`;
  }
  const prettierMatch =
    !prettierError && formattedExpected === formattedActual;

  return {
    ok: prettierMatch && rawMatch,
    prettierMatch,
    rawMatch,
    prettierError,
    formattedExpected,
    formattedActual,
  };
}

/**
 * Strictly compares AST or Token structures while preserving the distinction
 * between missing fields (`undefined` / omitted key) and `null`, and
 * normalizing approved `<basedir>` paths and `Buffer` objects.
 */
function compareStructured(expected, actual, basedirs) {
  const expectedSnap = formatForSnapshot(expected, basedirs);
  const actualSnap = formatForSnapshot(actual, basedirs);
  return {
    ok: expectedSnap === actualSnap,
    expectedFormatted: expectedSnap,
    actualFormatted: actualSnap,
  };
}

/**
 * Exact HTML string comparison (does not use DOM equivalence to mask whitespace
 * or attribute order differences).
 */
function compareHtml(expectedHtml, actualHtml) {
  return {
    ok: expectedHtml === actualHtml,
    expected: expectedHtml,
    actual: actualHtml,
  };
}

/**
 * Checks whether an error message difference matches an approved environment difference
 * in `compat/expected-differences.json`.
 */
function checkApprovedErrorPattern(message, expectedPattern) {
  if (expectedPattern.test(message)) {
    return { matched: true, status: 'PASS', diffId: null };
  }
  for (const rule of EXPECTED_DIFFERENCES.environmentDifferences || []) {
    if (
      rule.id === 'NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY' &&
      expectedPattern.source.includes('Cannot read property')
    ) {
      const modernRe = new RegExp(rule.modernNodePattern);
      if (modernRe.test(message)) {
        return {
          matched: true,
          status: 'APPROVED_DIFF',
          diffId: rule.id,
        };
      }
    }
  }
  return { matched: false, status: 'FAIL', diffId: null };
}

/**
 * Compares two Ismd compilation/runtime errors on structured fields:
 * `code`, `msg`, `line`, `column`, `filename`, `src`, and normalized `message`.
 */
function compareErrors(expectedErr, actualErr, basedirs) {
  if (!expectedErr || !actualErr) {
    return {
      ok: false,
      reason: 'One of expectedErr or actualErr is missing',
    };
  }
  const fields = ['code', 'msg', 'line', 'column', 'src'];
  const mismatches = [];
  for (const f of fields) {
    if (expectedErr[f] !== actualErr[f]) {
      mismatches.push({
        field: f,
        expected: expectedErr[f],
        actual: actualErr[f],
      });
    }
  }
  const expFile = removeBasedir(expectedErr.filename, basedirs);
  const actFile = removeBasedir(actualErr.filename, basedirs);
  if (expFile !== actFile) {
    mismatches.push({
      field: 'filename',
      expected: expFile,
      actual: actFile,
    });
  }
  const expMsg = removeBasedir(expectedErr.message, basedirs);
  const actMsg = removeBasedir(actualErr.message, basedirs);
  if (expMsg !== actMsg) {
    mismatches.push({
      field: 'message',
      expected: expMsg,
      actual: actMsg,
    });
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
  };
}

export {
  RUST_COMPILER_ROOT,
  RAW_COMPILER_ROOT,
  EXPECTED_DIFFERENCES,
  matchesBasedir,
  removeBasedir,
  createFilenameSerializer,
  prettierJavascriptSerializer,
  bufferSerializer,
  formatForSnapshot,
  parseJestSnapFile,
  formatJsWithPrettier,
  compareCodegen,
  compareStructured,
  compareHtml,
  checkApprovedErrorPattern,
  compareErrors,
};

export default {
  RUST_COMPILER_ROOT,
  RAW_COMPILER_ROOT,
  EXPECTED_DIFFERENCES,
  matchesBasedir,
  removeBasedir,
  createFilenameSerializer,
  prettierJavascriptSerializer,
  bufferSerializer,
  formatForSnapshot,
  parseJestSnapFile,
  formatJsWithPrettier,
  compareCodegen,
  compareStructured,
  compareHtml,
  checkApprovedErrorPattern,
  compareErrors,
};
