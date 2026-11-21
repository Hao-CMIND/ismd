import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ismd, { createCompiler, createTemplateStore } from '../../index.mjs';
import { nativePluginPath } from '../../../ismd-filters/index.mjs';
const pluginPath = nativePluginPath();
const plugins = [pluginPath];

test('removed filter API is absent from both JS and the actual native addon', () => {
  const require = createRequire(import.meta.url);
  const addon = require(process.env.ISMD_PROFILE_ADDON || process.env.ISMD_PROFILE_ADDON || '../../ismd-napi.win32-x64-msvc.node');
  assert.equal(addon.handleFiltersSync, undefined);
  assert.equal(ismd._handleFilters, undefined);
  assert.equal(ismd.filters, undefined);
});

test('no-plugin syntax, block expansion, interpolation, mixins, attributes and raw include', () => {
  assert.equal(ismd.render('div: p Hello #{name}', {name:'Ismd'}), '<div><p>Hello Ismd</p></div>');
  assert.equal(ismd.render('mixin greet(x)\n  span= x\n+greet("ok")'), '<span>ok</span>');
  assert.equal(ismd.render('p(class=["a", "b"] data-id=3) hi'), '<p class="a b" data-id="3">hi</p>');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-core-'));
  try {
    fs.writeFileSync(path.join(dir, 'raw.html'), '<strong>raw</strong>');
    assert.equal(ismd.render('include raw.html', {filename:path.join(dir,'page.pug')}), '<strong>raw</strong>');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('unregistered syntax fails without plugins; unknown targets reach only native provider', () => {
  assert.throws(() => ismd._lex(':uppercase\n  hello'));
  assert.throws(() => ismd.render(':uppercase\n  hello'));
  assert.throws(() => ismd.render('include:uppercase x.txt'));
  assert.throws(() => ismd.render(':missing\n  hello', {plugins}), /Unsupported target filter: missing/);
  assert.equal(ismd.render('div: p hello', {plugins}), '<div><p>hello</p></div>');
});

test('generic AST hooks see Extension before native replacement; visitor and codegen retain source', () => {
  const seen=[];
  const filename=path.resolve('native-location.pug');
  let before,after;
  const html=ismd.render('p\n  :uppercase\n    héllo 世界', {filename,plugins:[pluginPath,{
    preTransform(ast){ before=ast; return ast; },
    postTransform(ast){ after=ast; return ast; },
  }]});
  assert.equal(html,'<p>HÉLLO 世界</p>');
  ismd._walk(before,n=>{seen.push(n.type);});
  assert.ok(seen.includes('Extension'));
  const ext=before.nodes[0].block.nodes[0];
  assert.equal(ext.line,2);assert.equal(ext.column,3);assert.equal(ext.filename,filename);
  const text=after.nodes[0].block.nodes[0];
  assert.equal(text.type,'Text');assert.equal(text.line,2);assert.equal(text.filename,filename);
  assert.throws(()=>ismd.render('p placeholder', {plugins:[{preCodeGen(){return before;}}]}), /Extension|UNSUPPORTED_NODE/);
});

test('loaded includes and extends are transformed before linking and invalidated in session', () => {
  const c=createCompiler({plugins});
  try {
    c.updateFiles({
      'native/layout.pug':'html\n  body\n    block content',
      'native/part.pug':':uppercase\n  from include',
      'native/page.pug':'extends layout.pug\nblock content\n  include part.pug',
    });
    assert.equal(c.compileBatch(['native/page.pug'])[0].fn(),'<html><body>FROM INCLUDE</body></html>');
    assert.equal(c.compileBatch(['native/page.pug'])[0].cacheHit,true);
    c.updateFiles({'native/part.pug':':uppercase\n  updated include'});
    const changed=c.compileAffected();assert.equal(changed.length,1);
    assert.equal(changed[0].fn(),'<html><body>UPDATED INCLUDE</body></html>');
  } finally {c.dispose();}
});

test('shared parse/output caches do not grant an unconfigured compilation a plugin', () => {
  const templateStore=createTemplateStore();
  const c=createCompiler({templateStore});
  try {
    c.updateFiles({'cache/plugin.pug':':uppercase\n  cache test'});
    const entry={id:'native',filename:'cache/plugin.pug',options:{plugins}};
    assert.equal(c.compileBatch([entry])[0].fn(),'CACHE TEST');
    const disabled=c.compileBatch([{...entry,id:'plain',options:{plugins:[]}}],{throwOnError:false})[0];
    assert.equal(disabled.ok,false);
    assert.equal(c.compileBatch([entry])[0].cacheHit,true);
  } finally {c.dispose();}
});

test('serial and Rayon batches produce identical native output and errors', () => {
  const c=createCompiler({plugins});
  try {
    const entries=Array.from({length:24},(_,i)=>({id:String(i),source:'div\n  :uppercase\n    item '+i}));
    entries.push({id:'bad',source:':missing\n  fail'});
    const run=parallel=>c.compileBatch(entries,{parallel,throwOnError:false}).map(r=>r.ok?r.fn():r.error.message);
    assert.deepEqual(run(true),run(false));
    assert.equal(run(true)[0],'<div>ITEM 0</div>');
  } finally {c.dispose();}
});

test('native empty output and raw text are exercised without JS providers', () => {
  assert.equal(ismd.render(':uppercase',{plugins}), '');
  assert.equal(ismd.render(':uppercase\n  #{literal}\n  <em>x</em>',{plugins}), '#{LITERAL}\n<EM>X</EM>');
});
