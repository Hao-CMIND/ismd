import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nativePluginPath } from '../../../filters/index.js';
import pug, { createCompiler, resolveNativePluginPath } from '../../index.js';

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
  const html = pug.render(':uppercase\n  hello world', {
    plugins: [pluginPath],
  });
  assert.equal(html.trim(), 'HELLO WORLD');

  // Multi-line and nested indents
  const html2 = pug.render('div.card\n  p\n    :uppercase\n      nested content', {
    plugins: [pluginPath],
  });
  assert(html2.includes('<div class="card"><p>NESTED CONTENT</p></div>'), `Got: ${html2}`);
});

test('Step 2.9 (No Plugin): Standard templates compile fast without loading plugins', () => {
  const html = pug.render('p Normal Pug Template');
  assert.equal(html.trim(), '<p>Normal Pug Template</p>');
});

test('Step 2.9 & 2.10: CompilerSession batch and incremental reuse without duplicate loads', () => {
  const compiler = createCompiler({
    plugins: [pluginPath],
  });

  const files = {
    'page1.pug': 'div\n  :uppercase\n    pug native plugin works',
    'page2.pug': 'span\n  :uppercase\n    another uppercase string',
    'page3.pug': 'p Regular template without plugin in same session',
  };

  compiler.updateFiles(files);
  const results = compiler.compileBatch(['page1.pug', 'page2.pug', 'page3.pug']);

  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
  assert(results[0].fn().includes('PUG NATIVE PLUGIN WORKS'));
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
    pug.render(':unknown_filter\n  some text', {
      plugins: [pluginPath],
    });
  });
});
