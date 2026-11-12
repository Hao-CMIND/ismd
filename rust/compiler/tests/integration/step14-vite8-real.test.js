import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pugRustPlugin } from '../../../vite/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viteEntry = path.resolve(__dirname, '../../../vite/node_modules/vite/dist/node/index.js');
const fixtureDir = path.resolve(__dirname, '../../../vite/tests/fixtures/vite8');
const isConfigured = fs.existsSync(viteEntry) && fs.existsSync(fixtureDir);
const vite = isConfigured ? await import(pathToFileURL(viteEntry).href) : null;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

async function waitForCondition(fn, timeoutMs = 4000, stepMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test(
  'Level 3: Real Vite 8.3 production build (Rolldown + Hook Filter + moduleType: js + closeBundle dispose)',
  { skip: !isConfigured ? 'Vite 8.3 test environment not configured. Please see rust/vite/README.md for setup instructions.' : false },
  async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-vite8-build-'));
  copyDir(fixtureDir, workDir);

  const plugin = pugRustPlugin({
    locals: (id) => ({
      pageName: id.includes('about') ? 'About' : 'Home',
    }),
  });

  try {
    const t0 = performance.now();
    const output = await vite.build({
      root: workDir,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      build: {
        outDir: path.join(workDir, 'dist'),
        emptyOutDir: true,
        minify: false,
      },
    });
    const buildMs = Number((performance.now() - t0).toFixed(2));

    const outputs = Array.isArray(output) ? output : [output];
    const allCode = outputs
      .flatMap((o) => o.output || [])
      .filter((chunk) => chunk.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');

    assert.ok(allCode.includes('Index V1 Home'), 'build output missing index.pug HTML');
    assert.ok(allCode.includes('About V1 About'), 'build output missing about.pug HTML');
    assert.ok(allCode.includes('Header V1'), 'build output missing header.pug include');
    assert.ok(allCode.includes('Query Page'), 'build output missing query.pug?import HTML');

    const metrics = plugin.getMetrics();
    assert.equal(metrics.sessionCreates, 1, 'should create exactly 1 CompilerSession');
    assert.equal(metrics.disposes, 1, 'closeBundle must dispose CompilerSession');
    assert.equal(metrics.stats, null, 'stats should be null after dispose');

    console.log(
      `# Vite ${vite.version} (Node ${process.version}) prod build PASS in ${buildMs}ms`
    );
  } finally {
    plugin.dispose();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test(
  'Level 2 & 4: Real Vite 8.3 dev server, HTTP transform, HMR (page/include/layout/noop/add/unlink/atomic), and closeServer dispose',
  { skip: !isConfigured ? 'Vite 8.3 test environment not configured. Please see rust/vite/README.md for setup instructions.' : false },
  async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-vite8-dev-'));
  copyDir(fixtureDir, workDir);

  const indexPug = path.join(workDir, 'src', 'pages', 'index.pug');
  const aboutPug = path.join(workDir, 'src', 'pages', 'about.pug');
  const headerPug = path.join(workDir, 'src', 'includes', 'header.pug');
  const layoutPug = path.join(workDir, 'src', 'layouts', 'default.pug');

  const plugin = pugRustPlugin({
    entries: [indexPug, aboutPug],
    locals: (id) => ({
      pageName: id.includes('about') ? 'About' : 'Home',
    }),
  });

  const wsEvents = [];
  const server = await vite.createServer({
    root: workDir,
    configFile: false,
    logLevel: 'silent',
    server: {
      port: 0,
      strictPort: false,
      watch: {
        // Use fast polling/fs events reliably in temp dir on Windows
        awaitWriteFinish: false,
      },
    },
    plugins: [plugin],
  });

  try {
    await server.listen();
    const address = server.httpServer.address();
    const baseUrl = `http://localhost:${address.port}`;

    // Spy on ws.send to verify full-reload triggers while keeping real ws behavior
    const origSend = server.ws.send.bind(server.ws);
    server.ws.send = (payload) => {
      wsEvents.push(payload);
      return origSend(payload);
    };

    // Initial HTTP module requests (Vite serves non-JS assets as JS modules via ?import or transformRequest)
    const resIndex = await fetch(`${baseUrl}/src/pages/index.pug?import`);
    assert.equal(resIndex.status, 200);
    const bodyIndex = await resIndex.text();
    assert.ok(bodyIndex.includes('Index V1 Home'));
    assert.ok(bodyIndex.includes('Header V1'));

    const resAbout = await fetch(`${baseUrl}/src/pages/about.pug?import`);
    assert.equal(resAbout.status, 200);
    const bodyAbout = await resAbout.text();
    assert.ok(bodyAbout.includes('About V1 About'));

    const resQuery = await fetch(`${baseUrl}/src/pages/query.pug?import`);
    assert.equal(resQuery.status, 200);
    const bodyQuery = await resQuery.text();
    assert.ok(bodyQuery.includes('Query Page'));

    assert.equal(plugin.getMetrics().sessionCreates, 1);

    // Wait briefly so chokidar initial scan settles before file edits
    await new Promise((r) => setTimeout(r, 200));

    // A. Page HMR
    const prevAffected = plugin.getMetrics().affectedCompiles;
    const prevWsLen = wsEvents.length;
    const tPage0 = performance.now();
    fs.writeFileSync(
      indexPug,
      'extends ../layouts/default.pug\nblock content\n  main Index V2 #{pageName}\n',
      'utf8'
    );
    const pageOk = await waitForCondition(
      () => plugin.getMetrics().affectedCompiles > prevAffected && wsEvents.length > prevWsLen
    );
    const pageHmrMs = Number((performance.now() - tPage0).toFixed(2));
    assert.ok(pageOk, 'page HMR should trigger compileAffected + ws full-reload');
    assert.equal(plugin.getMetrics().lastAffectedCount, 1);
    const bodyIndexV2 = await (await fetch(`${baseUrl}/src/pages/index.pug?import`)).text();
    assert.ok(bodyIndexV2.includes('Index V2 Home'));

    // D. No-op save (write identical content) -> 0 compile
    await new Promise((r) => setTimeout(r, 150));
    const prevNoop = plugin.getMetrics().noopEvents;
    const prevAffectedBeforeNoop = plugin.getMetrics().affectedCompiles;
    const tNoop0 = performance.now();
    fs.writeFileSync(
      indexPug,
      'extends ../layouts/default.pug\nblock content\n  main Index V2 #{pageName}\n',
      'utf8'
    );
    const noopOk = await waitForCondition(() => plugin.getMetrics().noopEvents > prevNoop);
    const noopMs = Number((performance.now() - tNoop0).toFixed(2));
    assert.ok(noopOk, 'no-op save should increment noopEvents');
    assert.equal(plugin.getMetrics().affectedCompiles, prevAffectedBeforeNoop);

    // B. Include HMR (header.pug)
    const prevIncAffected = plugin.getMetrics().affectedCompiles;
    const tInc0 = performance.now();
    fs.writeFileSync(headerPug, 'header.site-header Header V2\n', 'utf8');
    const incOk = await waitForCondition(
      () => plugin.getMetrics().affectedCompiles > prevIncAffected
    );
    const incHmrMs = Number((performance.now() - tInc0).toFixed(2));
    assert.ok(incOk, 'include HMR should trigger compileAffected');
    assert.ok(plugin.getMetrics().lastAffectedCount >= 2);
    const aboutAfterInc = await (await fetch(`${baseUrl}/src/pages/about.pug?import`)).text();
    assert.ok(aboutAfterInc.includes('Header V2'));

    // C. Layout HMR (default.pug)
    const prevLayAffected = plugin.getMetrics().affectedCompiles;
    const tLay0 = performance.now();
    fs.writeFileSync(
      layoutPug,
      'doctype html\nhtml\n  body.layout-v2\n    include ../includes/header.pug\n    block content\n',
      'utf8'
    );
    const layOk = await waitForCondition(
      () => plugin.getMetrics().affectedCompiles > prevLayAffected
    );
    const layHmrMs = Number((performance.now() - tLay0).toFixed(2));
    assert.ok(layOk, 'layout HMR should trigger compileAffected');
    const indexAfterLay = await (await fetch(`${baseUrl}/src/pages/index.pug?import`)).text();
    assert.ok(indexAfterLay.includes('layout-v2'));

    // E. Add pug + F. Unlink pug
    const newPagePug = path.join(workDir, 'src', 'pages', 'added.pug');
    const prevAdd = plugin.getMetrics().addEvents;
    fs.writeFileSync(
      newPagePug,
      'extends ../layouts/default.pug\nblock content\n  main Added Page\n',
      'utf8'
    );
    const addOk = await waitForCondition(() => plugin.getMetrics().addEvents > prevAdd);
    assert.ok(addOk, 'watcher add should call handleFileAdd');
    const addedResp = await (await fetch(`${baseUrl}/src/pages/added.pug?import`)).text();
    assert.ok(addedResp.includes('Added Page'));

    const prevUnlink = plugin.getMetrics().unlinkEvents;
    fs.unlinkSync(newPagePug);
    const unlinkOk = await waitForCondition(() => plugin.getMetrics().unlinkEvents > prevUnlink);
    assert.ok(unlinkOk, 'watcher unlink should call handleFileUnlink');

    // G. Atomic save (write tmp + renameSync over index.pug)
    const prevAtomicAffected = plugin.getMetrics().affectedCompiles;
    const tmpFile = path.join(workDir, 'src', 'pages', '.index.pug.tmp');
    fs.writeFileSync(
      tmpFile,
      'extends ../layouts/default.pug\nblock content\n  main Index Atomic V3 #{pageName}\n',
      'utf8'
    );
    fs.renameSync(tmpFile, indexPug);
    await new Promise((r) => setTimeout(r, 250));
    const atomicBody = await (await fetch(`${baseUrl}/src/pages/index.pug?import`)).text();
    assert.ok(atomicBody.includes('Index Atomic V3 Home'));
    assert.ok(plugin.getMetrics().affectedCompiles >= prevAtomicAffected);

    // Verify sessionCreates stayed 1 throughout entire dev lifecycle
    assert.equal(plugin.getMetrics().sessionCreates, 1);

    console.log(
      `# Vite ${vite.version} dev HMR latencies (incl. chokidar): page=${pageHmrMs}ms, include=${incHmrMs}ms, layout=${layHmrMs}ms, noop=${noopMs}ms`
    );
  } finally {
    await server.close();
    const afterClose = plugin.getMetrics();
    assert.equal(afterClose.disposes, 1, 'server.close() must dispose CompilerSession');
    assert.equal(afterClose.stats, null, 'stats must be null after server.close()');
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
