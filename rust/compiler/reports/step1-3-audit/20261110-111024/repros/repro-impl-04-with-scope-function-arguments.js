'use strict';
const rawWith = require('../../../../../../raw/compiler/node_modules/with');
const rustPug = require('../../../../index.js');

const body = 'function firstArg() { return arguments[0]; }\npug_html = pug_html + firstArg("ok");';
const expected = rawWith('locals || {}', body, ['pug_html']);
const actual = rustPug._addWith('locals || {}', body, ['pug_html']);
console.log('=== EXPECTED (raw with@7.0.0) ===\n' + expected);
console.log('=== ACTUAL (rust pug_js::scope) ===\n' + actual);
console.log('match:', expected === actual);
