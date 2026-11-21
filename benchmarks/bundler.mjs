import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

import { ismdPlugin } from '../vite-plugin-ismd/index.mjs';
import { IsmdWebpackPlugin, loaderPath } from '../ismd-webpack-plugin/index.mjs';

const { default: ismdLoader } = await import(pathToFileURL(loaderPath).href);

function createSite(pageCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ismd-bundler-bench-${pageCount}-`));
  const layoutsDir = path.join(dir, 'layouts');
  const includesDir = path.join(dir, 'includes');
  const pagesDir = path.join(dir, 'pages');
  fs.mkdirSync(layoutsDir, { recursive: true });
  fs.mkdirSync(includesDir, { recursive: true });
  fs.mkdirSync(pagesDir, { recursive: true });

  const layoutPath = path.join(layoutsDir, 'base.pug');
  const headerPath = path.join(includesDir, 'header.pug');
  const footerPath = path.join(includesDir, 'footer.pug');

  fs.writeFileSync(headerPath, 'header.site-header\n  nav Nav V0\n', 'utf8');
  fs.writeFileSync(footerPath, 'footer.site-footer Copyright V0\n', 'utf8');
  fs.writeFileSync(
    layoutPath,
    'doctype html\nhtml\n  body\n    include ../includes/header.pug\n    block content\n    include ../includes/footer.pug\n',
    'utf8'
  );

  const pagePaths = [];
  for (let i = 0; i < pageCount; i += 1) {
    const p = path.join(pagesDir, `page-${String(i).padStart(3, '0')}.pug`);
    fs.writeFileSync(
      p,
      `extends ../layouts/base.pug\nblock content\n  main Page ${i} V0\n`,
      'utf8'
    );
    pagePaths.push(p);
  }

  return { dir, layoutPath, headerPath, footerPath, pagePaths };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function measureAsync(fn, iters = 5) {
  const times = [];
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    await fn(i);
    times.push(performance.now() - t0);
  }
  return Number(median(times).toFixed(3));
}

function createFakeWebpackCompiler(context, watchMode = true) {
  const makeAsyncHook = () => {
    const taps = [];
    return {
      tapPromise(_name, fn) {
        taps.push(fn);
      },
      async promise(...args) {
        for (const fn of taps) await fn(...args);
      },
    };
  };
  const makeSyncHook = () => {
    const taps = [];
    return {
      tap(_name, fn) {
        taps.push(fn);
      },
      call(...args) {
        for (const fn of taps) fn(...args);
      },
    };
  };
  return {
    context,
    watchMode,
    modifiedFiles: new Set(),
    removedFiles: new Set(),
    hooks: {
      run: makeAsyncHook(),
      watchRun: makeAsyncHook(),
      done: makeSyncHook(),
      watchClose: makeSyncHook(),
      shutdown: makeSyncHook(),
    },
  };
}

async function benchVite(pageCount) {
  const site = createSite(pageCount);
  try {
    // Prod build (cold -> closeBundle)
    const prodMs = await measureAsync(async () => {
      const plugin = ismdPlugin({ basedir: site.dir, entries: site.pagePaths });
      plugin.configResolved({ root: site.dir, command: 'build' });
      plugin.buildStart();
      for (const p of site.pagePaths) {
        const transformHook = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler;
        transformHook.call(plugin, fs.readFileSync(p, 'utf8'), p);
      }
      plugin.closeBundle();
    }, 3);

    // Dev server lifecycle
    const watcher = new EventEmitter();
    const httpServer = new EventEmitter();
    const fakeServer = {
      watcher,
      httpServer,
      moduleGraph: {
        getModulesByFile: (f) => new Set([{ id: f, file: f }]),
        invalidateModule: () => {},
      },
      ws: { send: () => {} },
    };

    const plugin = ismdPlugin({ basedir: site.dir, entries: site.pagePaths });
    plugin.configResolved({ root: site.dir, command: 'serve' });
    plugin.configureServer(fakeServer);

    const tInit = performance.now();
    plugin.buildStart();
    const devInitialMs = Number((performance.now() - tInit).toFixed(3));

    const noopMs = await measureAsync(async () => {
      await plugin.handleHotUpdate({
        file: site.pagePaths[0],
        server: fakeServer,
        read: async () => fs.readFileSync(site.pagePaths[0], 'utf8'),
      });
    }, 10);

    const pageHmrMs = await measureAsync(async (i) => {
      const src = `extends ../layouts/base.pug\nblock content\n  main Page 0 Vite ${i}\n`;
      fs.writeFileSync(site.pagePaths[0], src, 'utf8');
      await plugin.handleHotUpdate({
        file: site.pagePaths[0],
        server: fakeServer,
        read: async () => src,
      });
    }, 10);

    const includeHmrMs = await measureAsync(async (i) => {
      const src = `header.site-header\n  nav Nav Vite ${i}\n`;
      fs.writeFileSync(site.headerPath, src, 'utf8');
      await plugin.handleHotUpdate({
        file: site.headerPath,
        server: fakeServer,
        read: async () => src,
      });
    }, 5);

    const layoutHmrMs = await measureAsync(async (i) => {
      const src = `doctype html\nhtml\n  body(data-v="${i}")\n    include ../includes/header.pug\n    block content\n    include ../includes/footer.pug\n`;
      fs.writeFileSync(site.layoutPath, src, 'utf8');
      await plugin.handleHotUpdate({
        file: site.layoutPath,
        server: fakeServer,
        read: async () => src,
      });
    }, 5);

    const burstCount = Math.min(10, pageCount);
    const burstHmrMs = await measureAsync(async (i) => {
      for (let j = 0; j < burstCount; j += 1) {
        const p = site.pagePaths[j];
        const src = `extends ../layouts/base.pug\nblock content\n  main Page ${j} Burst ${i}\n`;
        fs.writeFileSync(p, src, 'utf8');
        await plugin.handleHotUpdate({ file: p, server: fakeServer, read: async () => src });
      }
    }, 5);

    const addRenameDeleteMs = await measureAsync(async (i) => {
      const p1 = path.join(site.dir, 'pages', `extra-${i}.pug`);
      const p2 = path.join(site.dir, 'pages', `extra-renamed-${i}.pug`);
      const src = `extends ../layouts/base.pug\nblock content\n  main Extra ${i}\n`;
      fs.writeFileSync(p1, src, 'utf8');
      plugin.handleFileAdd(p1);
      fs.renameSync(p1, p2);
      plugin.handleFileUnlink(p1);
      plugin.handleFileAdd(p2);
      fs.unlinkSync(p2);
      plugin.handleFileUnlink(p2);
    }, 5);

    const metrics = plugin.getMetrics();
    httpServer.emit('close');

    return {
      pages: pageCount,
      devInitialMs,
      prodMs,
      pageHmrMs,
      includeHmrMs,
      layoutHmrMs,
      burst10HmrMs: burstHmrMs,
      noopMs,
      addRenameDeleteMs,
      noopEvents: metrics.noopEvents,
      disposesAfterClose: plugin.getMetrics().disposes,
    };
  } finally {
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
}

async function benchWebpack(pageCount) {
  const site = createSite(pageCount);
  try {
    const prodMs = await measureAsync(async () => {
      const compiler = createFakeWebpackCompiler(site.dir, false);
      const plugin = new IsmdWebpackPlugin({ basedir: site.dir, entries: site.pagePaths });
      plugin.apply(compiler);
      await compiler.hooks.run.promise(compiler);
      for (const p of site.pagePaths) {
        ismdLoader.call(
          { _compiler: compiler, resourcePath: p, getOptions: () => ({}), addDependency: () => {} },
          fs.readFileSync(p, 'utf8')
        );
      }
      compiler.hooks.done.call();
    }, 3);

    const compiler = createFakeWebpackCompiler(site.dir, true);
    const plugin = new IsmdWebpackPlugin({ basedir: site.dir, entries: site.pagePaths });
    plugin.apply(compiler);

    const tInit = performance.now();
    await compiler.hooks.watchRun.promise(compiler);
    for (const p of site.pagePaths) {
      ismdLoader.call(
        { _compiler: compiler, resourcePath: p, getOptions: () => ({}), addDependency: () => {} },
        fs.readFileSync(p, 'utf8')
      );
    }
    const watchInitialMs = Number((performance.now() - tInit).toFixed(3));

    const noopMs = await measureAsync(async () => {
      compiler.modifiedFiles = new Set([site.pagePaths[0]]);
      compiler.removedFiles = new Set();
      await compiler.hooks.watchRun.promise(compiler);
    }, 10);

    const pageRebuildMs = await measureAsync(async (i) => {
      const src = `extends ../layouts/base.pug\nblock content\n  main Page 0 WP ${i}\n`;
      fs.writeFileSync(site.pagePaths[0], src, 'utf8');
      compiler.modifiedFiles = new Set([site.pagePaths[0]]);
      compiler.removedFiles = new Set();
      await compiler.hooks.watchRun.promise(compiler);
    }, 10);

    const includeRebuildMs = await measureAsync(async (i) => {
      const src = `header.site-header\n  nav Nav WP ${i}\n`;
      fs.writeFileSync(site.headerPath, src, 'utf8');
      compiler.modifiedFiles = new Set([site.headerPath]);
      compiler.removedFiles = new Set();
      await compiler.hooks.watchRun.promise(compiler);
    }, 5);

    const layoutRebuildMs = await measureAsync(async (i) => {
      const src = `doctype html\nhtml\n  body(data-wp="${i}")\n    include ../includes/header.pug\n    block content\n    include ../includes/footer.pug\n`;
      fs.writeFileSync(site.layoutPath, src, 'utf8');
      compiler.modifiedFiles = new Set([site.layoutPath]);
      compiler.removedFiles = new Set();
      await compiler.hooks.watchRun.promise(compiler);
    }, 5);

    const burstCount = Math.min(10, pageCount);
    const burstRebuildMs = await measureAsync(async (i) => {
      const mods = new Set();
      for (let j = 0; j < burstCount; j += 1) {
        const p = site.pagePaths[j];
        fs.writeFileSync(p, `extends ../layouts/base.pug\nblock content\n  main Page ${j} WP Burst ${i}\n`, 'utf8');
        mods.add(p);
      }
      compiler.modifiedFiles = mods;
      compiler.removedFiles = new Set();
      await compiler.hooks.watchRun.promise(compiler);
    }, 5);

    const addRenameDeleteMs = await measureAsync(async (i) => {
      const p1 = path.join(site.dir, 'pages', `wp-extra-${i}.pug`);
      const p2 = path.join(site.dir, 'pages', `wp-extra-ren-${i}.pug`);
      fs.writeFileSync(p1, `extends ../layouts/base.pug\nblock content\n  main WP Extra ${i}\n`, 'utf8');
      compiler.modifiedFiles = new Set([p1]);
      compiler.removedFiles = new Set();
      await compiler.hooks.watchRun.promise(compiler);

      fs.renameSync(p1, p2);
      compiler.modifiedFiles = new Set([p2]);
      compiler.removedFiles = new Set([p1]);
      await compiler.hooks.watchRun.promise(compiler);

      fs.unlinkSync(p2);
      compiler.modifiedFiles = new Set();
      compiler.removedFiles = new Set([p2]);
      await compiler.hooks.watchRun.promise(compiler);
    }, 5);

    compiler.hooks.watchClose.call();

    return {
      pages: pageCount,
      watchInitialMs,
      prodMs,
      pageRebuildMs,
      includeRebuildMs,
      layoutRebuildMs,
      burst10RebuildMs: burstRebuildMs,
      noopMs,
      addRenameDeleteMs,
      disposesAfterClose: plugin.getMetrics().disposes,
    };
  } finally {
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
}

async function main() {
  const counts = [10, 50, 100];
  const vite = [];
  const webpack = [];

  for (const n of counts) {
    vite.push(await benchVite(n));
    webpack.push(await benchWebpack(n));
  }

  console.log(JSON.stringify({ vite, webpack }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
