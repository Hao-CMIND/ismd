import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { PugRustPlugin, loaderPath } from '../../../../packages/webpack/index.js';

const require = createRequire(import.meta.url);
const pugRustLoader = require(loaderPath);

function createAsyncTapHook() {
  const taps = [];
  return {
    tapPromise(_name, fn) {
      taps.push(fn);
    },
    async promise(...args) {
      for (const fn of taps) {
        await fn(...args);
      }
    },
  };
}

function createSyncTapHook() {
  const taps = [];
  return {
    tap(_name, fn) {
      taps.push(fn);
    },
    call(...args) {
      for (const fn of taps) {
        fn(...args);
      }
    },
  };
}

function createFakeWebpackCompiler(context, watchMode = true) {
  return {
    context,
    watchMode,
    modifiedFiles: new Set(),
    removedFiles: new Set(),
    hooks: {
      run: createAsyncTapHook(),
      watchRun: createAsyncTapHook(),
      done: createSyncTapHook(),
      watchClose: createSyncTapHook(),
      shutdown: createSyncTapHook(),
    },
  };
}

function createTempMpaSite(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'layouts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'includes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });

  const layoutPath = path.join(dir, 'layouts', 'base.pug');
  const headerPath = path.join(dir, 'includes', 'header.pug');
  const page1Path = path.join(dir, 'pages', 'page1.pug');
  const page2Path = path.join(dir, 'pages', 'page2.pug');
  const page3Path = path.join(dir, 'pages', 'page3.pug');

  fs.writeFileSync(headerPath, 'header.wp-header Header V1\n', 'utf8');
  fs.writeFileSync(
    layoutPath,
    'doctype html\nhtml\n  body\n    include ../includes/header.pug\n    block content\n',
    'utf8'
  );
  fs.writeFileSync(page1Path, 'extends ../layouts/base.pug\nblock content\n  main WP Page 1 V1\n', 'utf8');
  fs.writeFileSync(page2Path, 'extends ../layouts/base.pug\nblock content\n  main WP Page 2 V1\n', 'utf8');
  fs.writeFileSync(page3Path, 'extends ../layouts/base.pug\nblock content\n  main WP Page 3 V1\n', 'utf8');

  return { dir, layoutPath, headerPath, page1Path, page2Path, page3Path };
}

test('Phase 5E: Webpack PugRustPlugin + loader share CompilerSession, register dependencies, watch rebuild, and dispose', async () => {
  const site = createTempMpaSite('pug-wp-');
  const entries = [site.page1Path, site.page2Path, site.page3Path];
  const compiler = createFakeWebpackCompiler(site.dir, true);
  const plugin = new PugRustPlugin({
    basedir: site.dir,
    entries,
    locals: { env: 'test' },
  });

  try {
    plugin.apply(compiler);

    // 1. Initial watchRun
    await compiler.hooks.watchRun.promise(compiler);
    let metrics = plugin.getMetrics();
    assert.equal(metrics.sessionCreates, 1);
    assert.equal(metrics.initialBatchCompiles, 1);

    // 2. Loader shares the same session and registers dependencies via addDependency
    const depsAdded = [];
    const loaderResult = pugRustLoader.call(
      {
        _compiler: compiler,
        resourcePath: site.page1Path,
        getOptions: () => ({}),
        addDependency(dep) {
          depsAdded.push(path.resolve(dep));
        },
      },
      fs.readFileSync(site.page1Path, 'utf8')
    );
    assert.ok(loaderResult.includes('WP Page 1 V1'));
    assert.ok(depsAdded.includes(path.resolve(site.layoutPath)));
    assert.ok(depsAdded.includes(path.resolve(site.headerPath)));
    assert.equal(plugin.getMetrics().sessionCreates, 1);

    // 3. No-op watchRun (same file content) -> 0 compile
    compiler.modifiedFiles = new Set([site.page1Path]);
    compiler.removedFiles = new Set();
    await compiler.hooks.watchRun.promise(compiler);
    metrics = plugin.getMetrics();
    assert.equal(metrics.noopWatchRuns, 1);
    assert.equal(metrics.affectedCompiles, 0);

    // 4. Single page edit -> 1 affected
    fs.writeFileSync(site.page1Path, 'extends ../layouts/base.pug\nblock content\n  main WP Page 1 V2\n', 'utf8');
    compiler.modifiedFiles = new Set([site.page1Path]);
    await compiler.hooks.watchRun.promise(compiler);
    metrics = plugin.getMetrics();
    assert.equal(metrics.affectedCompiles, 1);
    assert.equal(metrics.lastAffectedCount, 1);

    // 5. Include edit -> 3 affected
    fs.writeFileSync(site.headerPath, 'header.wp-header Header V2\n', 'utf8');
    compiler.modifiedFiles = new Set([site.headerPath]);
    await compiler.hooks.watchRun.promise(compiler);
    metrics = plugin.getMetrics();
    assert.equal(metrics.affectedCompiles, 2);
    assert.equal(metrics.lastAffectedCount, 3);

    // 6. Layout edit -> 3 affected
    fs.writeFileSync(
      site.layoutPath,
      'doctype html\nhtml\n  body.wp-v2\n    include ../includes/header.pug\n    block content\n',
      'utf8'
    );
    compiler.modifiedFiles = new Set([site.layoutPath]);
    await compiler.hooks.watchRun.promise(compiler);
    metrics = plugin.getMetrics();
    assert.equal(metrics.affectedCompiles, 3);
    assert.equal(metrics.lastAffectedCount, 3);

    // 7. File removal via removedFiles
    fs.unlinkSync(site.page3Path);
    compiler.modifiedFiles = new Set();
    compiler.removedFiles = new Set([site.page3Path]);
    await compiler.hooks.watchRun.promise(compiler);
    assert.equal(plugin.getMetrics().removedFilesCount, 1);

    // 8. watchClose disposes session
    compiler.hooks.watchClose.call();
    metrics = plugin.getMetrics();
    assert.equal(metrics.disposes, 1);
    assert.equal(metrics.stats, null);
  } finally {
    plugin.dispose();
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
});

test('Phase 5E: Webpack production run disposes on done and standalone loader fallback works without plugin', async () => {
  const site = createTempMpaSite('pug-wp-prod-');
  const compiler = createFakeWebpackCompiler(site.dir, false);
  const plugin = new PugRustPlugin({
    basedir: site.dir,
    entries: [site.page1Path, site.page2Path],
  });

  try {
    plugin.apply(compiler);
    await compiler.hooks.run.promise(compiler);
    assert.ok(plugin.getMetrics().stats !== null);
    compiler.hooks.done.call();
    assert.equal(plugin.getMetrics().disposes, 1);
    assert.equal(plugin.getMetrics().stats, null);

    // Standalone loader fallback (no _compiler registered)
    const fallbackDeps = [];
    const output = await new Promise((resolve, reject) => {
      const ctx = {
        resourcePath: site.page1Path,
        getOptions: () => ({ basedir: site.dir }),
        addDependency(dep) {
          fallbackDeps.push(path.resolve(dep));
        },
        async() {
          return (err, code) => (err ? reject(err) : resolve(code));
        },
      };
      pugRustLoader.call(ctx, fs.readFileSync(site.page1Path, 'utf8'));
    });

    assert.ok(output.includes('WP Page 1 V1'));
    assert.ok(fallbackDeps.includes(path.resolve(site.layoutPath)));
  } finally {
    plugin.dispose();
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
});
