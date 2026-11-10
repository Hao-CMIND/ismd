'use strict';
const rawPug = require('../../../../../../raw/compiler/packages/pug');
const rustPug = require('../../../../index.js');

for (const src of [
  'html',
  'html\n  body\n    h1 Title',
  'html\n  audio(preload="auto" autobuffer controls)\n    source(src="foo")',
]) {
  const expected = rawPug.render(src);
  const actual = rustPug.render(src);
  console.log({ src, expected, actual, match: expected === actual });
}
