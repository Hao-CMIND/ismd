import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { ismdPlugin, ismdRustPlugin } from '../index.mjs';

function createTempMpaSite(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'layouts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'includes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });

  const layoutPath = path.join(dir, 'layouts', 'base.pug');
  const headerPath = path.join(dir, 'includes', 'header.pug');
  const footerPath = path.join(dir, 'includes', 'footer.pug');
  const page1Path = path.join(dir, 'pages', 'page1.pug');
  const page2Path = path.join(dir, 'pages', 'page2.pug');
  const page3Path = path.join(dir, 'pages', 'page3.pug');

  fs.writeFileSync(headerPath, 'header.site-header Header V1\n', 'utf8');
  fs.writeFileSync(footerPath, 'footer.site-footer Footer V1\n', 'utf8');
  fs.writeFileSync(
    layoutPath,
    'doctype html\nhtml\n  body\n    include ../includes/header.pug\n    block content\n    include ../includes/footer.pug\n',
    'utf8'
  );
  fs.writeFileSync(page1Path, 'extends ../layouts/base.pug\nblock content\n  main Page 1 V1\n', 'utf8');
  fs.writeFileSync(page2Path, 'extends ../layouts/base.pug\nblock content\n  main Page 2 V1\n', 'utf8');
  fs.writeFileSync(page3Path, 'extends ../layouts/base.pug\nblock content\n  main Page 3 V1\n', 'utf8');

  return { dir, layoutPath, headerPath, footerPath, page1Path, page2Path, page3Path };
}

test('Vite plugin: persistent CompilerSession, HMR (page/include/layout), noop, atomic save, add/delete/rename, dispose', async () => {
  const site = createTempMpaSite('ismd-vite-');
  const entries = [site.page1Path, site.page2Path, site.page3Path];

  const watcher = new EventEmitter();
  const httpServer = new EventEmitter();
  const wsMessages = [];
  const invalidated = [];
  const moduleGraph = {
    getModulesByFile(file) {
      return new Set([{ id: file, file }]);
    },
    invalidateModule(mod) {
      invalidated.push(mod.file);
    },
  };
  const fakeServer = {
    watcher,
    httpServer,
    moduleGraph,
    ws: {
      send(msg) {
        wsMessages.push(msg);
      },
    },
  };

  const plugin = ismdRustPlugin({
    basedir: site.dir,
    entries,
  });

  try {
    plugin.configResolved({ root: site.dir, command: 'serve' });
    plugin.configureServer(fakeServer);
    plugin.buildStart();

    let metrics = plugin.getMetrics();
    assert.equal(metrics.sessionCreates, 1);
    assert.equal(metrics.initialBatchCompiles, 1);
    assert.ok(metrics.stats.parseMisses <= 6, `layout/includes parsed only once, got ${metrics.stats.parseMisses}`);

    // 1. Transform reuse (same persistent session, no new session created)
    const transformHook = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler;
    const transformed = transformHook.call(plugin, fs.readFileSync(site.page1Path, 'utf8'), site.page1Path);
    assert.ok(transformed.code.includes('Page 1 V1'));
    assert.equal(transformed.moduleType, 'js');
    assert.equal(plugin.getMetrics().sessionCreates, 1);

    // 2. No-op HMR save -> 0 compile
    const prevAffectedCompiles = plugin.getMetrics().affectedCompiles;
    const noopMods = await plugin.handleHotUpdate({
      file: site.page1Path,
      server: fakeServer,
      read: async () => fs.readFileSync(site.page1Path, 'utf8'),
    });
    assert.deepEqual(noopMods, []);
    metrics = plugin.getMetrics();
    assert.equal(metrics.noopEvents, 1);
    assert.equal(metrics.affectedCompiles, prevAffectedCompiles);

    // 3. Single page HMR -> only 1 entry affected
    fs.writeFileSync(site.page1Path, 'extends ../layouts/base.pug\nblock content\n  main Page 1 V2\n', 'utf8');
    const page1Mods = await plugin.handleHotUpdate({
      file: site.page1Path,
      server: fakeServer,
      read: async () => fs.readFileSync(site.page1Path, 'utf8'),
    });
    assert.equal(page1Mods.length, 1);
    metrics = plugin.getMetrics();
    assert.equal(metrics.lastAffectedCount, 1);
    assert.ok(wsMessages.length >= 1);

    // 4. Include HMR -> all 3 pages affected
    fs.writeFileSync(site.headerPath, 'header.site-header Header V2\n', 'utf8');
    const headerMods = await plugin.handleHotUpdate({
      file: site.headerPath,
      server: fakeServer,
      read: async () => fs.readFileSync(site.headerPath, 'utf8'),
    });
    assert.equal(headerMods.length, 3);
    assert.equal(plugin.getMetrics().lastAffectedCount, 3);

    // 5. Layout HMR -> all 3 pages affected
    fs.writeFileSync(
      site.layoutPath,
      'doctype html\nhtml\n  body.v2\n    include ../includes/header.pug\n    block content\n    include ../includes/footer.pug\n',
      'utf8'
    );
    const layoutMods = await plugin.handleHotUpdate({
      file: site.layoutPath,
      server: fakeServer,
      read: async () => fs.readFileSync(site.layoutPath, 'utf8'),
    });
    assert.equal(layoutMods.length, 3);
    assert.equal(plugin.getMetrics().lastAffectedCount, 3);

    // 6. Atomic save (write tmp + rename over page2)
    const tmpSave = path.join(site.dir, 'pages', '.page2.pug.tmp');
    fs.writeFileSync(tmpSave, 'extends ../layouts/base.pug\nblock content\n  main Page 2 Atomic\n', 'utf8');
    fs.renameSync(tmpSave, site.page2Path);
    const atomicMods = await plugin.handleHotUpdate({
      file: site.page2Path,
      server: fakeServer,
      read: async () => fs.readFileSync(site.page2Path, 'utf8'),
    });
    assert.equal(atomicMods.length, 1);
    assert.ok(transformHook.call(plugin, fs.readFileSync(site.page2Path, 'utf8'), site.page2Path).code.includes('Page 2 Atomic'));

    // 7. Add + Rename (unlink + add) via watcher events
    const page4Path = path.join(site.dir, 'pages', 'page4.pug');
    fs.writeFileSync(page4Path, 'extends ../layouts/base.pug\nblock content\n  main Page 4\n', 'utf8');
    watcher.emit('add', page4Path);
    assert.equal(plugin.getMetrics().addEvents, 1);

    const page4Renamed = path.join(site.dir, 'pages', 'page4-renamed.pug');
    fs.renameSync(page4Path, page4Renamed);
    watcher.emit('unlink', page4Path);
    watcher.emit('add', page4Renamed);
    assert.equal(plugin.getMetrics().unlinkEvents, 1);
    assert.equal(plugin.getMetrics().addEvents, 2);

    // 8. Server close disposes native session
    httpServer.emit('close');
    metrics = plugin.getMetrics();
    assert.equal(metrics.disposes, 1);
    assert.equal(metrics.stats, null);
  } finally {
    plugin.dispose();
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
});

test('Vite plugin: handles .pug files natively with CompilerSession', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-vite-'));
  const headerPath = path.join(dir, 'header.pug');
  const indexPath = path.join(dir, 'index.pug');
  fs.writeFileSync(headerPath, 'h1 Header #{title}\n', 'utf8');
  fs.writeFileSync(indexPath, 'include ./header.pug\np Content\n', 'utf8');

  const plugin = ismdPlugin({ basedir: dir });
  try {
    plugin.configResolved({ root: dir, command: 'serve' });
    const code = plugin.transform.handler(
      fs.readFileSync(indexPath, 'utf8'),
      indexPath + '?import'
    );
    assert.ok(code && code.code, 'Must return transformed JS code');
    assert.ok(code.code.includes('export default'), 'Must export template');
  } finally {
    plugin.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Vite plugin: production build disposes CompilerSession on closeBundle', () => {
  const site = createTempMpaSite('ismd-vite-build-');
  const plugin = ismdRustPlugin({
    basedir: site.dir,
    entries: [site.page1Path, site.page2Path],
  });

  try {
    plugin.configResolved({ root: site.dir, command: 'build' });
    plugin.buildStart();
    assert.equal(plugin.getMetrics().initialBatchCompiles, 1);
    assert.ok(plugin.getMetrics().stats !== null);
    plugin.closeBundle();
    assert.equal(plugin.getMetrics().disposes, 1);
    assert.equal(plugin.getMetrics().stats, null);
  } finally {
    plugin.dispose();
    fs.rmSync(site.dir, { recursive: true, force: true });
  }
});

test('Vite plugin: handles .pug files natively with CompilerSession', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-vite-'));
  const headerPath = path.join(dir, 'header.pug');
  const indexPath = path.join(dir, 'index.pug');
  fs.writeFileSync(headerPath, 'h1 Header #{title}\n', 'utf8');
  fs.writeFileSync(indexPath, 'include ./header.pug\np Content\n', 'utf8');

  const plugin = ismdPlugin({ basedir: dir });
  try {
    plugin.configResolved({ root: dir, command: 'serve' });
    const code = plugin.transform.handler(
      fs.readFileSync(indexPath, 'utf8'),
      indexPath + '?import'
    );
    assert.ok(code && code.code, 'Must return transformed JS code');
    assert.ok(code.code.includes('export default'), 'Must export template');
  } finally {
    plugin.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Vite plugin: raw-included non-.pug dependency HMR, ?raw/?url bypass, and addWatchFile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-vite-raw-'));
  const cssPath = path.join(dir, 'style.css');
  const indexPath = path.join(dir, 'index.pug');
  fs.writeFileSync(cssPath, 'body { color: red; }\n', 'utf8');
  fs.writeFileSync(indexPath, 'style\n  include ./style.css\np Hello\n', 'utf8');

  const watched = [];
  const fakeMod = { id: indexPath, file: indexPath };
  const fakeServer = {
    moduleGraph: {
      getModulesByFile: (file) =>
        path.resolve(file).toLowerCase() === path.resolve(indexPath).toLowerCase() ? [fakeMod] : [],
      invalidateModule: () => {},
    },
    ws: { send: () => {} },
  };

  const plugin = ismdPlugin({ basedir: dir });
  try {
    plugin.configResolved({ root: dir, command: 'serve' });

    // ?raw / ?url must bypass ismd transform
    assert.equal(plugin.transform.handler('export default "raw"', indexPath + '?raw'), null);
    assert.equal(plugin.transform.handler('export default "/a"', indexPath + '?url'), null);

    // transform registers dependencies with addWatchFile
    const res1 = plugin.transform.handler.call(
      { addWatchFile: (f) => watched.push(path.resolve(f)) },
      fs.readFileSync(indexPath, 'utf8'),
      indexPath
    );
    assert.ok(res1.code.includes('color: red'));
    assert.ok(watched.includes(path.resolve(cssPath)));

    // Updating raw-included .css triggers HMR invalidation & recompile
    fs.writeFileSync(cssPath, 'body { color: blue; }\n', 'utf8');
    const hmrMods = await plugin.handleHotUpdate({
      file: cssPath,
      server: fakeServer,
      read: async () => fs.readFileSync(cssPath, 'utf8'),
    });
    assert.equal(hmrMods.length, 1);
    const res2 = plugin.transform.handler(fs.readFileSync(indexPath, 'utf8'), indexPath);
    assert.ok(res2.code.includes('color: blue'));
  } finally {
    plugin.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
