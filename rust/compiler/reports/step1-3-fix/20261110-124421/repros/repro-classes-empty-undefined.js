'use strict';
const rawPug = require('../../../../../../raw/compiler/packages/pug');
const rustPug = require('../../../../index.js');
const serializers = require('../../../../tests/differential/serializers.js');

const src = "a(class='')\na(class=null)\na(class=undefined)";
const rawClient = rawPug.compileClient(src, { compileDebug: false });
const rustClient = rustPug.compileClient(src, { compileDebug: false });
const cmp = serializers.compareCodegen(rawClient, rustClient);
console.log({
  rawHtml: rawPug.render(src),
  rustHtml: rustPug.render(src),
  prettierMatch: cmp.prettierMatch,
  rawMatch: cmp.rawMatch,
  ok: cmp.ok,
});
