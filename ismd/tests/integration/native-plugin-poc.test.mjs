import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativePluginPath } from '../../../ismd-filters/index.mjs';
import ismd, { createCompiler, resolveNativePluginPath } from '../../index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pluginPath = nativePluginPath();

test('Step 2.5: Plugin path resolution and existence verification', () => {
  assert(fs.existsSync(pluginPath), `Plugin dll must exist at: ${pluginPath}`);
  const resolved = resolveNativePluginPath(pluginPath);
  assert.equal(resolved, pluginPath);

  // Object wrapper with nativePath
  const resolvedObj = resolveNativePluginPath({ nativePath: pluginPath });
  assert.equal(resolvedObj, pluginPath);
});

test('Step 2.8: Single compile with :uppercase transforms without legacy JS callbacks', () => {
  const html = ismd.render(':uppercase\n  hello world', {
    plugins: [pluginPath],
  });
  assert.equal(html.trim(), 'HELLO WORLD');

  // Multi-line and nested indents
  const html2 = ismd.render('div.card\n  p\n    :uppercase\n      nested content', {
    plugins: [pluginPath],
  });
  assert(html2.includes('<div class="card"><p>NESTED CONTENT</p></div>'), `Got: ${html2}`);
});

test('Step 2.9 (No Plugin): Standard templates compile fast without loading plugins', () => {
  const html = ismd.render('p Normal Ismd Template');
  assert.equal(html.trim(), '<p>Normal Ismd Template</p>');
});

test('Step 2.9 & 2.10: CompilerSession batch and incremental reuse without duplicate loads', () => {
  const compiler = createCompiler({
    plugins: [pluginPath],
  });

  const files = {
    'page1.pug': 'div\n  :uppercase\n    ismd native plugin works',
    'page2.pug': 'span\n  :uppercase\n    another uppercase string',
    'page3.pug': 'p Regular template without plugin in same session',
  };

  compiler.updateFiles(files);
  const results = compiler.compileBatch(['page1.pug', 'page2.pug', 'page3.pug']);

  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
  assert(results[0].fn().includes('ISMD NATIVE PLUGIN WORKS'));
  assert(results[1].fn().includes('ANOTHER UPPERCASE STRING'));
  assert(results[2].fn().includes('Regular template without plugin in same session'));

  // Incremental compilation
  compiler.updateFiles({
    'page1.pug': 'div\n  :uppercase\n    updated native content',
  });
  const affected = compiler.compileAffected();
  assert.equal(affected.length, 1);
  assert(affected[0].fn().includes('UPDATED NATIVE CONTENT'));

  compiler.dispose();
});

test('Step 2.9: Error handling when unknown filter is used with native plugin', () => {
  assert.throws(() => {
    ismd.render(':unknown_filter\n  some text', {
      plugins: [pluginPath],
    });
  });
});

test('Plugin classification: merges plugins + nativePlugins, ignores object.path, and runs both hooks and nativePath on dual objects', () => {
  // (b) Object with `.path` pointing to an existing file is NOT treated as a native plugin
  assert.equal(resolveNativePluginPath({ path: pluginPath }), null);
  assert.equal(resolveNativePluginPath({ path: __filename, preLex: (s) => s }), null);
  const htmlWithPathProp = ismd.render('p old', {
    plugins: [{ path: __filename, preLex: (s) => s.replace('old', 'from-hook') }],
  });
  assert.equal(htmlWithPathProp, '<p>from-hook</p>');

  // (a) Combining `plugins` (JS hooks) + `nativePlugins` (DLL) runs both in render() and createCompiler()
  const combinedHtml = ismd.render('div\n  :uppercase\n    hello old', {
    plugins: [{ preLex: (s) => s.replace('old', 'world') }],
    nativePlugins: [pluginPath],
  });
  assert.equal(combinedHtml, '<div>HELLO WORLD</div>');

  const compiler1 = createCompiler({
    plugins: [{ preLex: (s) => s.replace('old', 'session') }],
    nativePlugins: [pluginPath],
  });
  try {
    compiler1.updateFiles({ 'dual-a.pug': 'div\n  :uppercase\n    hello old' });
    const res1 = compiler1.compileEntries(['dual-a.pug']);
    assert.equal(res1[0].ok, true);
    assert.equal(res1[0].fn(), '<div>HELLO SESSION</div>');
  } finally {
    compiler1.dispose();
  }

  // (c) Single object with both `nativePath` and JS hooks runs both sides in render() and createCompiler()
  const dualPlugin = {
    nativePath: pluginPath,
    preLex: (s) => s.replace('old', 'dual'),
  };
  const dualHtml = ismd.render('div\n  :uppercase\n    hello old', {
    plugins: [dualPlugin],
  });
  assert.equal(dualHtml, '<div>HELLO DUAL</div>');

  const compiler2 = createCompiler({
    plugins: [dualPlugin],
  });
  try {
    compiler2.updateFiles({ 'dual-b.pug': 'div\n  :uppercase\n    hello old' });
    const res2 = compiler2.compileEntries(['dual-b.pug']);
    assert.equal(res2[0].ok, true);
    assert.equal(res2[0].fn(), '<div>HELLO DUAL</div>');
  } finally {
    compiler2.dispose();
  }
});
