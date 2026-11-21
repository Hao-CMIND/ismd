import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import ismd from '../../index.mjs';
import { RAW_COMPILER_ROOT } from './serializers.mjs';
const require=createRequire(import.meta.url);
const reference=require(path.join(RAW_COMPILER_ROOT, 'packages/ismd'));
assert.equal(require(path.join(RAW_COMPILER_ROOT, 'packages/ismd/package.json')).version,'2.0.4');
const cases=[
  ['tags','div.card\n  h1= title\n  p Hello #{name}',{title:'Title',name:'World'}],
  ['expansion','section: div: p Expanded',{}],
  ['inline interpolation','p Hello #[strong world]!',{}],
  ['attributes','input(type="text" disabled data-x="<x>" class=["a", {b:true}])',{}],
  ['style','p(style={color:"red", "font-size":"12px"}) text',{}],
  ['condition','if ok\n  b yes\nelse\n  i no',{ok:false}],
  ['each','ul\n  each val, key in items\n    li(data-key=key)= val',{items:['a','<b>']}],
  ['case','case n\n  when 1\n    p one\n  default\n    p other',{n:1}],
  ['mixin','mixin item(x)\n  li&attributes(attributes)= x\nul\n  +item("yes")(class="a")',{}],
  ['raw text','script.\n  if (a < b) {\n    log("raw");\n  }',{}],
  ['comments','// visible\np before\n//- hidden\np after',{}],
  ['escaping','p= text\np!= html',{text:'<x>&',html:'<b>raw</b>'}],
  ['doctype','doctype html\nhtml\n  body\n    br',{}],
];
for(const [name,source,locals] of cases) for(const pretty of [false,true]) for(const compileDebug of [false,true]) {
  test(name+' pretty='+pretty+' debug='+compileDebug,()=>{
    const opts={pretty,compileDebug};
    const expected=reference.compile(source,opts)(locals);
    assert.equal(ismd.compile(source,opts)(locals),expected);
  });
}
test('include, extends, append/prepend, yield and raw file match Ismd 2.0.4',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ismd-diff-'));
  try {
    const rustFiles={
      'layout.pug':'html\n  body\n    block content\n      p Base',
      'part.pug':'section\n  yield',
      'raw.html':'<b>Raw</b>',
      'page.pug':'extends layout.pug\nprepend content\n  p Before\nappend content\n  include part.pug\n    p Included\n  include raw.html',
    };
    const rawFiles={
      'layout.pug':'html\n  body\n    block content\n      p Base',
      'part.pug':'section\n  yield',
      'page.pug':'extends layout.pug\nprepend content\n  p Before\nappend content\n  include part.pug\n    p Included\n  include raw.html',
    };
    for(const [name,text] of Object.entries({...rustFiles,...rawFiles}))fs.writeFileSync(path.join(dir,name),text);
    for(const pretty of [false,true]){
      assert.equal(ismd.renderFile(path.join(dir,'page.pug'),{pretty}),reference.renderFile(path.join(dir,'page.pug'),{pretty}));
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
