'use strict';
const rawPug = require('../../../../../../raw/compiler/packages/pug');
const rustPug = require('../../../../index.js');

const src = 'doctype\nhtml\n  body\n    h1 Title';
const expected = rawPug.render(src);
const actual = rustPug.render(src);
console.log({ src, expected, actual, match: expected === actual });
