import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import rustIsmd from '../../index.mjs';
import {
  RAW_COMPILER_ROOT,
  RUST_COMPILER_ROOT,
  formatForSnapshot,
  parseJestSnapFile,
  compareCodegen,
  compareStructured,
  checkApprovedErrorPattern,
} from './serializers.mjs';

const require = createRequire(import.meta.url);

function testFilenameAndTokenSnapshots() {
  const rawLex = require(path.join(RAW_COMPILER_ROOT, 'packages/ismd-lexer'));
  const casesDir = path.join(RAW_COMPILER_ROOT, 'packages/ismd-lexer/test/cases');

  // Rebuilt raw/compiler renames `.pug` -> `.pug`, shifting column numbers by +1 on lines
  // referencing `.pug` filenames, so static `.snap` column numbers are unreliable.
  // Compare live serialized token streams between rawLex and rustIsmd.lex across all non-filter cases.
  let verified = 0;
  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.pug')) continue;
    const fullPath = path.join(casesDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    let rustTokens;
    try {
      rustTokens = rustIsmd.lex(src, { filename: fullPath });
    } catch (err) {
      // Skip legacy filter syntax cases removed in Phase 6 (e.g. `:filter`, `include:filter`)
      if (err && (err.code === 'ISMD:UNEXPECTED_TEXT' || err.code === 'ISMD:MALFORMED_INCLUDE')) {
        continue;
      }
      throw err;
    }
    const rawTokens = rawLex(src, { filename: fullPath });
    const rawSerialized = formatForSnapshot(rawTokens);
    const rustSerialized = formatForSnapshot(rustTokens);
    assert.strictEqual(
      rustSerialized,
      rawSerialized,
      `Serializer live token mismatch on ${file}`
    );
    assert.ok(
      rawSerialized.includes('<basedir>/packages/ismd-lexer/test/cases/'),
      `Expected <basedir> normalization in serialized tokens for ${file}`
    );
    verified++;
  }
  assert(verified > 90, `Expected >90 live lexer token cases verified, got ${verified}`);
  return verified;
}

function testBufferAndLoadSnapshots() {
  const walk = require(path.join(RAW_COMPILER_ROOT, 'packages/ismd-walk'));
  const lex = require(path.join(RAW_COMPILER_ROOT, 'packages/ismd-lexer'));
  const parse = require(path.join(RAW_COMPILER_ROOT, 'packages/ismd-parser'));
  const load = require(path.join(RAW_COMPILER_ROOT, 'packages/ismd-load'));

  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/ismd-load/test');
  const filename = path.join(testDir, 'foo.pug');
  let ast = load.file(filename, { lex, parse });
  ast = walk(
    ast,
    (node) => {
      if (node.filename) node.filename = '<dirname>/' + path.basename(node.filename);
      if (node.fullPath) node.fullPath = '<dirname>/' + path.basename(node.fullPath);
    },
    { includeDependencies: true }
  );

  const snaps = parseJestSnapFile(
    path.join(testDir, '__snapshots__/index.test.js.snap')
  );
  const serialized = formatForSnapshot(ast);
  assert.strictEqual(
    serialized,
    snaps['ismd-load 1'],
    'Serializer mismatch on ismd-load Buffer + filename snapshot'
  );
}

function testPrettierJavascriptSnapshots() {
  const ismd = require(path.join(RAW_COMPILER_ROOT, 'packages/ismd'));
  const snapFile = path.join(
    RAW_COMPILER_ROOT,
    'packages/ismd/test/__snapshots__/ismd.test.js.snap'
  );
  const snaps = parseJestSnapFile(snapFile);

  const src = '.bar= self.foo';
  const codeInlineFalse = ismd.compileClient(src, {
    self: true,
    module: true,
    inlineRuntimeFunctions: false,
  });
  const codeInlineTrue = ismd.compileClient(src, {
    self: true,
    module: true,
    inlineRuntimeFunctions: true,
  });

  assert.strictEqual(
    formatForSnapshot(codeInlineFalse),
    snaps[
      'ismd .compileClient() should support module syntax in ismd.compileClient(str, options) when inlineRuntimeFunctions it false 1'
    ]
  );
  assert.strictEqual(
    formatForSnapshot(codeInlineTrue),
    snaps[
      'ismd .compileClient() should support module syntax in ismd.compileClient(str, options) when inlineRuntimeFunctions it true 1'
    ]
  );

  // Verify dual-layer codegen comparator
  const dualSame = compareCodegen(codeInlineTrue, codeInlineTrue);
  assert.strictEqual(dualSame.ok, true);
  assert.strictEqual(dualSame.prettierMatch, true);
  assert.strictEqual(dualSame.rawMatch, true);

  const whitespaceVariant = codeInlineFalse.replace('function template(locals) {', 'function template( locals ) {');
  const dualDiff = compareCodegen(codeInlineFalse, whitespaceVariant);
  assert.strictEqual(dualDiff.prettierMatch, true, 'Prettier layer should match across whitespace');
  assert.strictEqual(dualDiff.rawMatch, false, 'Raw layer should detect exact string difference');
  assert.strictEqual(dualDiff.ok, false, 'Dual-layer ok requires both Prettier and raw layers');
}

function testMissingVsNullAndCrossBasedir() {
  // Missing field vs null vs undefined distinction
  const a = { type: 'Block', nodes: [] };
  const b = { type: 'Block', nodes: [], filename: null };
  assert.strictEqual(
    compareStructured(a, b).ok,
    false,
    'Must distinguish missing field from null'
  );

  // Cross-basedir path normalization (<basedir>)
  const rawNode = {
    type: 'Tag',
    filename: path.join(RAW_COMPILER_ROOT, 'packages/ismd/test/cases/basic.pug'),
  };
  const rustNode = {
    type: 'Tag',
    filename: path.join(RUST_COMPILER_ROOT, 'packages/ismd/test/cases/basic.pug'),
  };
  assert.strictEqual(
    compareStructured(rawNode, rustNode).ok,
    true,
    'Cross-basedir paths must normalize identically to <basedir>/...'
  );

  // Approved Node 16+ V8 TypeError difference
  const check = checkApprovedErrorPattern(
    "Cannot read properties of null (reading 'length')",
    /Cannot read property 'length' of null/
  );
  assert.strictEqual(check.matched, true);
  assert.strictEqual(check.status, 'APPROVED_DIFF');
  assert.strictEqual(check.diffId, 'NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY');
}

function main() {
  const lexerCount = testFilenameAndTokenSnapshots();
  testBufferAndLoadSnapshots();
  testPrettierJavascriptSnapshots();
  testMissingVsNullAndCrossBasedir();
  console.log(
    `PASS tests/differential/serializers.test.js (${lexerCount} lexer snapshots + ismd-load Buffer snapshot + Prettier JS snapshots + structural invariants verified)`
  );
}

main();
