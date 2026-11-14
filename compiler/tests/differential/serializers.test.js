import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  RAW_COMPILER_ROOT,
  RUST_COMPILER_ROOT,
  formatForSnapshot,
  parseJestSnapFile,
  compareCodegen,
  compareStructured,
  checkApprovedErrorPattern,
} from './serializers.js';

const require = createRequire(import.meta.url);

function testFilenameAndTokenSnapshots() {
  const lex = require(path.join(RAW_COMPILER_ROOT, 'packages/pug-lexer'));
  const casesDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-lexer/test/cases');
  const snapFile = path.join(
    RAW_COMPILER_ROOT,
    'packages/pug-lexer/test/__snapshots__/index.test.js.snap'
  );
  const snaps = parseJestSnapFile(snapFile);

  let verified = 0;
  for (const file of fs.readdirSync(casesDir)) {
    if (!file.endsWith('.pug')) continue;
    const fullPath = path.join(casesDir, file);
    const tokens = lex(fs.readFileSync(fullPath, 'utf8'), { filename: fullPath });
    const serialized = formatForSnapshot(tokens);
    const expected = snaps[`${file} 1`];
    assert.strictEqual(
      serialized,
      expected,
      `Serializer mismatch on pug-lexer snapshot for ${file}`
    );
    verified++;
  }
  assert(verified > 100, `Expected >100 lexer snapshots verified, got ${verified}`);
  return verified;
}

function testBufferAndLoadSnapshots() {
  const walk = require(path.join(RAW_COMPILER_ROOT, 'packages/pug-walk'));
  const lex = require(path.join(RAW_COMPILER_ROOT, 'packages/pug-lexer'));
  const parse = require(path.join(RAW_COMPILER_ROOT, 'packages/pug-parser'));
  const load = require(path.join(RAW_COMPILER_ROOT, 'packages/pug-load'));

  const testDir = path.join(RAW_COMPILER_ROOT, 'packages/pug-load/test');
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
    snaps['pug-load 1'],
    'Serializer mismatch on pug-load Buffer + filename snapshot'
  );
}

function testPrettierJavascriptSnapshots() {
  const pug = require(path.join(RAW_COMPILER_ROOT, 'packages/pug'));
  const snapFile = path.join(
    RAW_COMPILER_ROOT,
    'packages/pug/test/__snapshots__/pug.test.js.snap'
  );
  const snaps = parseJestSnapFile(snapFile);

  const src = '.bar= self.foo';
  const codeInlineFalse = pug.compileClient(src, {
    self: true,
    module: true,
    inlineRuntimeFunctions: false,
  });
  const codeInlineTrue = pug.compileClient(src, {
    self: true,
    module: true,
    inlineRuntimeFunctions: true,
  });

  assert.strictEqual(
    formatForSnapshot(codeInlineFalse),
    snaps[
      'pug .compileClient() should support module syntax in pug.compileClient(str, options) when inlineRuntimeFunctions it false 1'
    ]
  );
  assert.strictEqual(
    formatForSnapshot(codeInlineTrue),
    snaps[
      'pug .compileClient() should support module syntax in pug.compileClient(str, options) when inlineRuntimeFunctions it true 1'
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
    filename: path.join(RAW_COMPILER_ROOT, 'packages/pug/test/cases/basic.pug'),
  };
  const rustNode = {
    type: 'Tag',
    filename: path.join(RUST_COMPILER_ROOT, 'packages/pug/test/cases/basic.pug'),
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
    `PASS tests/differential/serializers.test.js (${lexerCount} lexer snapshots + pug-load Buffer snapshot + Prettier JS snapshots + structural invariants verified)`
  );
}

main();
