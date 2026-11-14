import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rustPug from '../../index.js';
import { compareStructured, compareHtml } from '../differential/serializers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const rawLex = require(path.resolve(__dirname, '../../../raw/compiler/packages/pug-lexer'));
const rawStrip = require(path.resolve(__dirname, '../../../raw/compiler/packages/pug-strip-comments'));
const rawPug = require(path.resolve(__dirname, '../../../raw/compiler/packages/pug'));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS: ${name}`);
}

console.log('Running Step 2 Lexer, Comments & JS Boundary integration tests...');

test('1. Regex literals with parentheses, quotes, and slashes inside attributes & interpolations', () => {
  const src = [
    'div(data-re=/^a(b|c)[d\\/]$/i.test("ab") ? "yes" : "no")',
    '  p #{/\\((foo|bar)\\)/.exec("(foo)")[1]}',
  ].join('\n');
  const rawTokens = rawLex(src, { filename: 'regex.pug' });
  const rustTokens = rustPug.lex(src, { filename: 'regex.pug' });
  assert.strictEqual(compareStructured(rawTokens, rustTokens).ok, true);
});

test('2. Template literals with nested ${...} expressions and backticks', () => {
  const src = [
    'a(href=`https://example.com/${user ? `${user.id}/${`v${1 + 1}`}` : "guest"}`)',
    '  span #{`Hello ${`world (${1 + 2})`}`}',
  ].join('\n');
  const rawTokens = rawLex(src, { filename: 'template.pug' });
  const rustTokens = rustPug.lex(src, { filename: 'template.pug' });
  assert.strictEqual(compareStructured(rawTokens, rustTokens).ok, true);
});

test('3. Deeply nested parentheses, brackets, and braces in attributes, calls, and interpolations', () => {
  const src = [
    '+myMixin(fn({ a: [1, (2 + 3)], b: "hello ) world" }), [4, 5])(class=({ active: (true && (1 < 2)) }))',
    '  p Text with #[span.inner(title=(a ? "x" : "y")) #[strong #{fn((1 + (2 * 3)))}]]!',
  ].join('\n');
  const rawTokens = rawLex(src, { filename: 'nested.pug' });
  const rustTokens = rustPug.lex(src, { filename: 'nested.pug' });
  assert.strictEqual(compareStructured(rawTokens, rustTokens).ok, true);
});

test('4. Unicode CJK and supplementary plane Emoji UTF-16 column alignment in tokens and errors', () => {
  const src = [
    'p#title.cjk-class(data-emoji="😀🎉🚀" data-cjk="繁體中文")',
    '  | 測試文字 😀 #{`Emoji: ${"🎉".length}`} #[em 內嵌標籤 🚀]',
  ].join('\n');
  const rawTokens = rawLex(src, { filename: 'unicode.pug' });
  const rustTokens = rustPug.lex(src, { filename: 'unicode.pug' });
  assert.strictEqual(compareStructured(rawTokens, rustTokens).ok, true);

  // Error column after Emoji (2 UTF-16 code units)
  const errSrc = 'p 😀 #{unclosed';
  let rawErr;
  let rustErr;
  try {
    rawLex(errSrc, { filename: 'emoji-err.pug' });
  } catch (e) {
    rawErr = { code: e.code, msg: e.msg, line: e.line, column: e.column };
  }
  try {
    rustPug.lex(errSrc, { filename: 'emoji-err.pug' });
  } catch (e) {
    rustErr = { code: e.code, msg: e.msg, line: e.line, column: e.column };
  }
  assert.deepStrictEqual(rustErr, rawErr);
});

test('5. Buffered and unbuffered comment stripping options (default, buffered-only, both)', () => {
  const src = [
    '// buffered single',
    '//- unbuffered single',
    '//',
    '  buffered block line 1',
    '  buffered block line 2',
    '//-',
    '  unbuffered block line 1',
    '  unbuffered block line 2',
    'p Visible',
  ].join('\n');
  const tokens = rustPug.lex(src, { filename: 'comments.pug' });

  for (const opts of [
    undefined,
    { stripUnbuffered: true, stripBuffered: false },
    { stripUnbuffered: false, stripBuffered: true },
    { stripUnbuffered: true, stripBuffered: true },
  ]) {
    const rawOut = rawStrip(JSON.parse(JSON.stringify(tokens)), opts);
    const rustOut = rustPug.stripComments(JSON.parse(JSON.stringify(tokens)), opts);
    assert.strictEqual(compareStructured(rawOut, rustOut).ok, true);
  }
});

test('6. Node render differential checks for newly supported basic syntax (interpolations, tag interpolations, comments, pipeless text)', () => {
  const templates = [
    {
      name: 'string interpolation #{...} and !{...}',
      pug: 'p Hello #{name}, raw !{rawHtml}, escaped \\#{notInterp}!',
      locals: { name: 'World <1>', rawHtml: '<b>bold</b>' },
    },
    {
      name: 'tag interpolation #[...]',
      pug: 'p Welcome to #[strong.highlight Pug #[em #{version}]]!',
      locals: { version: '2.0.4' },
    },
    {
      name: 'buffered & unbuffered comments + pipeless dot text',
      pug: [
        '// Buffered comment',
        '//- Unbuffered comment that is stripped',
        '  ignored block line',
        'div.container.',
        '  Line 1: #{msg}',
        '  Line 2: #[span inline]',
      ].join('\n'),
      locals: { msg: 'Hello & Goodbye' },
    },
    {
      name: 'template literal & regex inside interpolation in render()',
      pug: 'p= `Result: ${/^[a-z]+$/i.test(word) ? word.toUpperCase() : "N/A"}`',
      locals: { word: 'pug' },
    },
  ];

  for (const t of templates) {
    const expectedHtml = rawPug.render(t.pug, Object.assign({}, t.locals));
    const actualHtml = rustPug.render(t.pug, Object.assign({}, t.locals));
    assert.strictEqual(
      compareHtml(expectedHtml, actualHtml).ok,
      true,
      `HTML mismatch on ${t.name}: expected ${expectedHtml}, got ${actualHtml}`
    );
  }
});

console.log(`All ${passed} Step 2 integration tests passed.`);
