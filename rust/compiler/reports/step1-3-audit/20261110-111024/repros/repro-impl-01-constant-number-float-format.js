'use strict';
const rawPug = require('../../../../../../raw/compiler/packages/pug');
const rustPug = require('../../../../index.js');

for (const src of ['div(foo=1 + 2)', 'td(colspan=2)', 'foo(data-items=[1, 2, 3])']) {
  const expected = rawPug.render(src);
  const actual = rustPug.render(src);
  console.log({ src, expected, actual, match: expected === actual });
}
