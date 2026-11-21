import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, build } from 'vite';
import { ismdRustPlugin } from '../index.mjs';
import { nativePluginPath } from '../../ismd-filters/index.mjs';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('P0.1 & P0.3: Legacy filter options throw descriptive error and are rejected', () => {
  const legacyKeys = ['filters', 'filterExecutor', 'filterOptions', 'filterAliases'];
  for (const key of legacyKeys) {
    assert.throws(
      () => {
        ismdRustPlugin({ [key]: {} });
      },
      (err) => {
        assert(err.message.includes('[vite-plugin-ismd]') || err.message.includes('[ismd-rust/vite]'));
        assert(err.message.includes('removed in Phase 3'));
        assert(err.message.includes(key));
        assert(err.message.includes('options.plugins'));
        return true;
      },
      `Passing ${key} must throw descriptive error`
    );
  }
});

test('P0.2: Native Plugin option is accepted and passed to compiler', () => {
  const pluginPath = nativePluginPath();
  const plugin = ismdRustPlugin({
    plugins: [pluginPath],
  });
  const session = plugin.getSession();
  assert.ok(session);
  plugin.dispose();
});

test('P0.4 & P0.5 & Browser Output Update: Real Vite Dev Server HMR (include & layout updates)', async () => {
  const rootDir = createTempDir('ismd-vite-real-');
  fs.mkdirSync(path.join(rootDir, 'includes'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'pages'), { recursive: true });

  const headerFile = path.join(rootDir, 'includes', 'header.pug');
  const pageFile = path.join(rootDir, 'pages', 'index.pug');

  fs.writeFileSync(headerFile, 'header.site-header Welcome V1\n', 'utf8');
  fs.writeFileSync(pageFile, 'div.page\n  include ../includes/header.pug\n  p Body Content V1\n', 'utf8');

  const plugin = ismdRustPlugin();
  const server = await createServer({
    root: rootDir,
    server: { middlewareMode: true },
    plugins: [plugin],
    appType: 'custom',
  });

  try {
    // 1. Initial browser request for the page module
    const res1 = await server.transformRequest('/pages/index.pug');
    assert.ok(res1, 'Vite must successfully transform index.pug');
    assert.ok(res1.code.includes('Welcome V1'), `Expected Welcome V1, got:\n${res1.code}`);
    assert.ok(res1.code.includes('Body Content V1'));

    // 2. Modify header.pug
    fs.writeFileSync(headerFile, 'header.site-header Welcome V2 Updated\n', 'utf8');

    // Trigger handleHotUpdate as Vite's watcher does
    const hotMods = await plugin.handleHotUpdate({
      file: headerFile,
      server,
      read: async () => fs.readFileSync(headerFile, 'utf8'),
      modules: [],
    });

    assert.ok(hotMods.length > 0, 'Hot update must return affected page module');

    // 3. Second browser request for the page module
    // CRITICAL REQUIREMENT: Verify actual transformed output received by browser has updated!
    const res2 = await server.transformRequest('/pages/index.pug');
    assert.ok(res2, 'Vite must return re-transformed module');
    assert.ok(
      res2.code.includes('Welcome V2 Updated'),
      `Browser must receive updated header HTML! Got:\n${res2.code}`
    );
    assert.ok(!res2.code.includes('Welcome V1'), 'Old V1 content must not remain in output');
  } finally {
    await server.close();
    plugin.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('P0.6: Add & Unlink watcher events trigger full-reload and update dependencies', async () => {
  const rootDir = createTempDir('ismd-vite-watcher-');
  const newPage = path.join(rootDir, 'new-page.pug');
  fs.writeFileSync(newPage, 'h1 Initial New Page\n', 'utf8');

  let wsMsg = null;
  const fakeServer = {
    watcher: {
      on(event, fn) {
        if (event === 'add') this._addFn = fn;
        if (event === 'unlink') this._unlinkFn = fn;
      },
      off() {},
    },
    ws: {
      send(msg) {
        wsMsg = msg;
      },
    },
    moduleGraph: {
      onFileDelete() {},
    },
  };

  const plugin = ismdRustPlugin({ basedir: rootDir });
  plugin.configResolved({ root: rootDir, command: 'serve' });
  plugin.configureServer(fakeServer);

  try {
    // Test Add
    await plugin.handleFileAdd(newPage);
    assert.deepEqual(wsMsg, { type: 'full-reload', path: '*' });

    // Test Unlink
    wsMsg = null;
    plugin.handleFileUnlink(newPage);
    assert.deepEqual(wsMsg, { type: 'full-reload', path: '*' });
  } finally {
    plugin.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('P0.7: Windows Atomic Save handles fast rename and lock retries safely', async () => {
  const rootDir = createTempDir('ismd-vite-atomic-');
  const targetFile = path.join(rootDir, 'atomic.pug');
  fs.writeFileSync(targetFile, 'p Initial Content\n', 'utf8');

  const plugin = ismdRustPlugin({ basedir: rootDir });
  plugin.configResolved({ root: rootDir, command: 'serve' });
  plugin.buildStart();

  try {
    // Initial compile
    const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler;
    const initial = transform(fs.readFileSync(targetFile, 'utf8'), targetFile);
    assert.ok(initial.code.includes('Initial Content'));

    // Perform atomic save: write to tmp then atomic rename
    const tmpFile = path.join(rootDir, '.atomic.pug.tmp');
    fs.writeFileSync(tmpFile, 'p Saved via Atomic Operation\n', 'utf8');
    fs.renameSync(tmpFile, targetFile);

    const result = await plugin.handleHotUpdate({
      file: targetFile,
      read: async () => fs.readFileSync(targetFile, 'utf8'),
      modules: [],
    });

    assert.ok(result);
    assert.equal(plugin.getMetrics().affectedCompiles, 1);

    const retransformed = transform(fs.readFileSync(targetFile, 'utf8'), targetFile);
    assert.ok(retransformed.code.includes('Saved via Atomic Operation'));
  } finally {
    plugin.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('P1.1 & P1.2: Windows paths with spaces, backslashes, and root != process.cwd()', async () => {
  // Folder name containing whitespace and Windows backslashes
  const baseDir = createTempDir('ismd space dir-');
  const subRoot = path.join(baseDir, 'sub project root');
  fs.mkdirSync(subRoot, { recursive: true });

  const ismdFile = path.join(subRoot, 'space entry.pug');
  fs.writeFileSync(ismdFile, 'div.container\n  h1 Space Path Works\n', 'utf8');

  const plugin = ismdRustPlugin({
    entries: ['space entry.pug'], // Relative to root, NOT process.cwd()
  });

  plugin.configResolved({ root: subRoot, command: 'build' });
  plugin.buildStart();

  try {
    assert.equal(plugin.getMetrics().initialBatchCompiles, 1);

    const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler;
    // Test with Windows backslash path
    const winPath = ismdFile.replace(/\//g, '\\');
    const result = transform(fs.readFileSync(winPath, 'utf8'), winPath);
    assert.ok(result.code.includes('Space Path Works'));
  } finally {
    plugin.dispose();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('P1.3 & P1.6: Watcher listeners clean-up and Dev Server restart lifecycle', () => {
  let listeners = { add: 0, unlink: 0 };
  const mockWatcher = {
    on(event) {
      listeners[event] = (listeners[event] || 0) + 1;
    },
    removeListener(event) {
      listeners[event] = (listeners[event] || 0) - 1;
    },
  };

  const fakeServer = {
    watcher: mockWatcher,
  };

  const plugin = ismdRustPlugin();

  // First configure
  plugin.configureServer(fakeServer);
  assert.equal(listeners.add, 1);
  assert.equal(listeners.unlink, 1);

  // Second configure (simulating server restart or HMR re-attach)
  plugin.configureServer(fakeServer);
  assert.equal(listeners.add, 1, 'Watcher listener must not duplicate on re-configure');
  assert.equal(listeners.unlink, 1);

  // Close server
  plugin.closeServer();
  assert.equal(listeners.add, 0, 'Watcher listener must be removed on server close');
  assert.equal(listeners.unlink, 0);
  assert.equal(plugin.getMetrics().disposes, 1);

  // Re-start after close
  plugin.configureServer(fakeServer);
  assert.equal(listeners.add, 1);
  assert.ok(plugin.getSession());

  plugin.dispose();
  assert.equal(listeners.add, 0);
  assert.equal(plugin.getMetrics().disposes, 2);
});

test('P1.5: No unneeded Full Reload when change has no affected modules', async () => {
  const rootDir = createTempDir('ismd-vite-noop-');
  const unlinkedFile = path.join(rootDir, 'orphan.pug');
  fs.writeFileSync(unlinkedFile, 'p Orphan\n', 'utf8');

  let wsMsg = null;
  const fakeServer = {
    ws: {
      send(msg) {
        wsMsg = msg;
      },
    },
    moduleGraph: {
      getModulesByFile() {
        return new Set();
      },
    },
  };

  const plugin = ismdRustPlugin({ basedir: rootDir });
  plugin.configResolved({ root: rootDir, command: 'serve' });
  plugin.configureServer(fakeServer);

  try {
    // 1. No-op file change (same content)
    await plugin.handleHotUpdate({
      file: unlinkedFile,
      server: fakeServer,
      read: async () => 'p Orphan\n',
    });
    assert.equal(wsMsg, null, 'No-op change must not send full-reload');
  } finally {
    plugin.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('Production Build: Real Vite build() produces bundle from Ismd template', async () => {
  const rootDir = createTempDir('ismd-vite-build-real-');
  const ismdFile = path.join(rootDir, 'main.pug');
  const jsEntry = path.join(rootDir, 'entry.js');

  fs.writeFileSync(ismdFile, 'div#app\n  h1 Real Vite Build Ismd Success\n', 'utf8');
  fs.writeFileSync(
    jsEntry,
    `import html from './main.pug';
console.log('RENDERED:', html);
`,
    'utf8'
  );

  const plugin = ismdRustPlugin();

  try {
    const output = await build({
      root: rootDir,
      logLevel: 'silent',
      build: {
        write: false,
        rollupOptions: {
          input: jsEntry,
        },
      },
      plugins: [plugin],
    });

    const chunk = Array.isArray(output) ? output[0] : output;
    const bundleCode = chunk.output[0].code;
    assert.ok(
      bundleCode.includes('Real Vite Build Ismd Success'),
      `Bundle must include compiled HTML! Got:\n${bundleCode}`
    );
    assert.equal(plugin.getMetrics().disposes, 1, 'Build must dispose session on closeBundle');
  } finally {
    plugin.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
