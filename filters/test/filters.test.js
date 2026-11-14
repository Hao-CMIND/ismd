import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createFilterExecutor,
  getFilterTransformer,
  getFilterMetrics,
  resetFilterMetrics,
} from '../index.js';

test('custom filters leave optional transformer dependencies unloaded', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {createFilterExecutor} from ${JSON.stringify(new URL('../index.js', import.meta.url).href)};
    const require = createRequire(import.meta.url);
    const out = createFilterExecutor({upper: s => s.toUpperCase()}).execute('upper', 'text', 'hello');
    assert.deepEqual(out, {ok:true,value:'HELLO'});
    assert.ok(!Object.keys(require.cache).some(p => /[\\\\/]node_modules[\\\\/](?:resolve|jstransformer)(?:[\\\\/]|$)/.test(p)));
    console.log('custom filter loads no external transformer dependencies');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

test('module-local Markdown transformer loads lazily and is cached', () => {
  resetFilterMetrics();
  const executor = createFilterExecutor();
  assert.equal(executor.execute('markdown-it', 'text', '# Title').value, '<h1>Title</h1>\n');
  assert.equal(executor.execute('markdown-it', 'text', '## Sub').value, '<h2>Sub</h2>\n');
  const metrics = getFilterMetrics();
  assert.equal(metrics.resolveLookups, 1);
  assert.equal(metrics.resolveCacheHits, 1);
  assert.equal(metrics.transformerCacheHits, 1);
});

test('caller-installed transformer takes precedence over module-local transformer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-filter-consumer-'));
  try {
    const pkg = path.join(dir, 'node_modules/jstransformer-markdown-it');
    fs.mkdirSync(pkg, {recursive:true});
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name:'jstransformer-markdown-it',version:'1.0.0',main:'index.js'}));
    fs.writeFileSync(path.join(pkg, 'index.js'), "module.exports = {name:'consumer',outputFormat:'html',render: text => 'consumer:' + text};\n");
    const result = createFilterExecutor().execute('markdown-it', 'text', '# Local', undefined, undefined, {}, dir);
    assert.deepEqual(result, {ok:true,value:'consumer:# Local'});
  } finally {
    fs.rmSync(dir, {recursive:true});
  }
});

test('missing transformers keep the unknown-filter response', () => {
  assert.equal(getFilterTransformer('pug-rust-missing-transformer-test'), null);
  assert.deepEqual(createFilterExecutor().execute('pug-rust-missing-transformer-test', 'text', 'x'), {
    ok:false,
    unknownFilter:'unknown filter ":pug-rust-missing-transformer-test"',
  });
});
