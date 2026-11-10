'use strict';
const rawLex = require('../../../../../../raw/compiler/packages/pug-lexer');
const rawParse = require('../../../../../../raw/compiler/packages/pug-parser');
const rawWalk = require('../../../../../../raw/compiler/packages/pug-walk');
const rustPug = require('../../../../index.js');

function testWalk(walkFn) {
  const ast = rawParse(rawLex('div\n  p hello'));
  const opts = {};
  let firstRef = null;
  let refChanged = false;
  walkFn(
    ast,
    () => {
      if (!firstRef) firstRef = opts.parents;
      else if (opts.parents !== firstRef) refChanged = true;
    },
    null,
    opts
  );
  return { refChanged, finalParentsLength: opts.parents.length };
}

console.log('raw pug-walk:', testWalk(rawWalk));
console.log('rust pug.walk:', testWalk((ast, b, a, o) => rustPug.walk(ast, b, a, o)));
