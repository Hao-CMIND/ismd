import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pug from '../../compiler/index.js';
import {
  getFilterMetrics,
  resetFilterMetrics,
} from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compilerEntry = path.resolve(__dirname, '../../compiler/index.js');

test('zero-filter project never loads @pug-rust/filters, jstransformer, or resolve', () => {
  const script = `
    import { createRequire } from 'node:module';
    import pug from ${JSON.stringify('file:///' + compilerEntry.replace(/\\/g, '/'))};
    const require = createRequire(import.meta.url);
    const html = pug.render('div.card\\n  h1= title\\n  p Hello #{name}', { title: 'Hi', name: 'Pug' });
    if (!html.includes('Hello Pug')) throw new Error('unexpected html: ' + html);
    const loaded = Object.keys(require.cache);
    const filterDeps = loaded.filter((p) => /filters|jstransformer|resolve/.test(p));
    console.log(JSON.stringify({ filterDeps }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out.trim());
  assert.deepEqual(parsed.filterDeps, []);
});

test('filterExecutor boundary supports custom filters, jstransformer lazy-load + cache, and disabled UNKNOWN_FILTER', () => {
  resetFilterMetrics();

  // 1. Custom filterExecutor injection (never touches jstransformer)
  const customOut = pug.render(':upper\n  hello world', {
    filterExecutor: {
      execute(name, _mode, text) {
        assert.equal(name, 'upper');
        return { ok: true, value: text.toUpperCase() };
      },
    },
  });
  assert.equal(customOut, 'HELLO WORLD');
  assert.equal(getFilterMetrics().filterExecutions, 0);

  // 2. Disabled filterExecutor throws compatible UNKNOWN_FILTER error
  assert.throws(
    () => pug.render(':markdown\n  # Hi', { filterExecutor: false }),
    (err) => err && err.code === 'PUG:UNKNOWN_FILTER' && /unknown filter ":markdown"/.test(err.message)
  );

  // 3. Real jstransformer filter lazy-loads and caches on repeat calls
  const md1 = pug.render(':markdown-it\n  # Title', {});
  assert.ok(md1.includes('<h1>Title</h1>'));
  const m1 = getFilterMetrics();
  assert.equal(m1.filterExecutions, 1);
  assert.equal(m1.resolveLookups, 1);

  const md2 = pug.render(':markdown-it\n  ## Sub', {});
  assert.ok(md2.includes('<h2>Sub</h2>'));
  const m2 = getFilterMetrics();
  assert.equal(m2.filterExecutions, 2);
  assert.equal(m2.resolveLookups, 1);
  assert.ok(m2.resolveCacheHits >= 1);
  assert.ok(m2.transformerCacheHits >= 1);
});
