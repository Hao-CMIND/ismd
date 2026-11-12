import fs from 'node:fs';
import path from 'node:path';
import pug from '../../rust/compiler/index.js';

function isPugFile(filePath) {
  return typeof filePath === 'string' && /\.pug($|\?)/i.test(filePath);
}

function stripQuery(id) {
  const idx = id.indexOf('?');
  return idx === -1 ? id : id.slice(0, idx);
}

function defaultIsEntry(filePath, rootDir) {
  const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  return !/(^|\/)(includes?|layouts?|partials?|components?|mixins?)\//i.test(rel);
}

/**
 * Create a Vite plugin backed by a persistent pug-rust CompilerSession.
 */
export function pugRustPlugin(options = {}) {
  let root = options.basedir ? path.resolve(options.basedir) : process.cwd();
  let command = 'build';
  let session = null;
  let serverRef = null;
  const registeredEntries = new Set();
  const metrics = {
    sessionCreates: 0,
    initialBatchCompiles: 0,
    hmrEvents: 0,
    noopEvents: 0,
    affectedCompiles: 0,
    lastAffectedCount: 0,
    addEvents: 0,
    unlinkEvents: 0,
    disposes: 0,
  };

  function getCompilerOptions() {
    return {
      basedir: options.basedir ? path.resolve(options.basedir) : root,
      pretty: options.pretty,
      doctype: options.doctype,
      globals: options.globals,
      self: options.self,
      compileDebug: options.compileDebug !== undefined ? options.compileDebug : false,
      inlineRuntimeFunctions: options.inlineRuntimeFunctions,
      filters: options.filters,
      filterExecutor: options.filterExecutor,
      plugins: options.plugins,
      filterOptions: options.filterOptions,
      filterAliases: options.filterAliases,
    };
  }

  function ensureSession() {
    if (!session || session.isDisposed) {
      session = pug.createCompiler(getCompilerOptions());
      metrics.sessionCreates += 1;
    }
    return session;
  }

  function disposeSession() {
    if (session && !session.isDisposed) {
      session.dispose();
      metrics.disposes += 1;
    }
    session = null;
  }

  function resolveLocals(id, extra = {}) {
    if (typeof options.locals === 'function') {
      return options.locals(id, extra) || {};
    }
    return options.locals || {};
  }

  function registerEntries(entries) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const p = typeof entry === 'string' ? entry : entry.filename || entry.id;
      if (p) registeredEntries.add(path.resolve(p));
    }
  }

  async function handleFileChange(filePath, readFn) {
    const cleanPath = stripQuery(filePath);
    if (!isPugFile(cleanPath)) return { changed: false, affected: [] };

    const active = ensureSession();
    metrics.hmrEvents += 1;

    let source;
    try {
      source = readFn ? await readFn() : fs.readFileSync(cleanPath, 'utf8');
    } catch {
      // File may have vanished mid-atomic-save; treat as removal if missing on disk
      if (!fs.existsSync(cleanPath)) {
        const rep = active.removeFiles([cleanPath]);
        registeredEntries.delete(path.resolve(cleanPath));
        return { changed: rep.changed, affected: [] };
      }
      return { changed: false, affected: [] };
    }

    const report = active.updateFiles([{ path: cleanPath, source }]);
    if (!report.changed) {
      metrics.noopEvents += 1;
      metrics.lastAffectedCount = 0;
      return { changed: false, affected: [] };
    }

    const compiled = active.compileAffected();
    metrics.affectedCompiles += 1;
    metrics.lastAffectedCount = compiled.length;
    return { changed: true, report, affected: compiled };
  }

  function handleFileAdd(filePath) {
    const cleanPath = stripQuery(filePath);
    if (!isPugFile(cleanPath)) return { changed: false, affected: [] };
    const active = ensureSession();
    metrics.addEvents += 1;
    let source;
    try {
      source = fs.readFileSync(cleanPath, 'utf8');
    } catch {
      return { changed: false, affected: [] };
    }
    const report = active.updateFiles([{ path: cleanPath, source }]);
    const entryCheck = options.isEntry || ((p) => defaultIsEntry(p, root));
    const abs = path.resolve(cleanPath);
    if (entryCheck(abs)) {
      registeredEntries.add(abs);
      const compiled = active.compileEntries([{ id: abs, filename: abs, source }]);
      return { changed: true, report, affected: compiled };
    }
    const compiled = report.changed ? active.compileAffected() : [];
    return { changed: report.changed, report, affected: compiled };
  }

  function handleFileUnlink(filePath) {
    const cleanPath = stripQuery(filePath);
    if (!isPugFile(cleanPath)) return { changed: false };
    if (!session || session.isDisposed) return { changed: false };
    metrics.unlinkEvents += 1;
    registeredEntries.delete(path.resolve(cleanPath));
    return session.removeFiles([cleanPath]);
  }

  return {
    name: 'vite-plugin-pug-rust',

    configResolved(resolvedConfig) {
      if (resolvedConfig && resolvedConfig.root) {
        root = path.resolve(resolvedConfig.root);
      }
      if (resolvedConfig && resolvedConfig.command) {
        command = resolvedConfig.command;
      }
    },

    buildStart() {
      const active = ensureSession();
      if (Array.isArray(options.entries) && options.entries.length > 0) {
        registerEntries(options.entries);
        const batch = options.entries.map((entry) =>
          typeof entry === 'string'
            ? { id: path.resolve(entry), filename: path.resolve(entry) }
            : { ...entry, id: entry.id || path.resolve(entry.filename), filename: path.resolve(entry.filename || entry.id) }
        );
        const results = active.compileBatch(batch);
        metrics.initialBatchCompiles += 1;
        return results;
      }
      return undefined;
    },

    configureServer(server) {
      serverRef = server;
      ensureSession();

      if (server && server.watcher && typeof server.watcher.on === 'function') {
        server.watcher.on('add', (file) => {
          handleFileAdd(file);
        });
        server.watcher.on('unlink', (file) => {
          handleFileUnlink(file);
        });
      }

      if (server && server.httpServer && typeof server.httpServer.once === 'function') {
        server.httpServer.once('close', () => {
          disposeSession();
        });
      }
    },

    async handleHotUpdate(ctx) {
      if (!ctx || !isPugFile(ctx.file)) return undefined;
      const result = await handleFileChange(ctx.file, ctx.read ? () => ctx.read() : undefined);
      if (!result.changed) {
        return [];
      }

      const affectedModules = [];
      const modGraph = (ctx.server && ctx.server.moduleGraph) || (serverRef && serverRef.moduleGraph);
      if (modGraph && typeof modGraph.getModulesByFile === 'function') {
        for (const item of result.affected) {
          const mods = modGraph.getModulesByFile(item.id);
          if (mods) {
            for (const m of mods) {
              modGraph.invalidateModule(m);
              affectedModules.push(m);
            }
          }
        }
      }

      if (options.hmr !== false && ctx.server && ctx.server.ws && typeof ctx.server.ws.send === 'function') {
        ctx.server.ws.send({
          type: 'full-reload',
          path: '*',
        });
      }

      return affectedModules.length > 0 ? affectedModules : ctx.modules || [];
    },

    transform(code, id) {
      const cleanId = stripQuery(id);
      if (!isPugFile(cleanId)) return null;

      const active = ensureSession();
      const abs = path.resolve(cleanId);
      registeredEntries.add(abs);

      const results = active.compileEntries([
        { id: abs, filename: abs, source: code },
      ]);
      const entry = results[0];
      const html = entry.fn(resolveLocals(abs, { id: abs }));

      return {
        code: `export default ${JSON.stringify(html)};\n`,
        map: null,
      };
    },

    closeBundle() {
      if (command === 'build') {
        disposeSession();
      }
    },

    // Exposed helpers for testing, benchmarking, and server lifecycle inspection
    getSession() {
      return ensureSession();
    },
    getMetrics() {
      return {
        ...metrics,
        registeredEntries: registeredEntries.size,
        stats: session && !session.isDisposed ? session.stats() : null,
      };
    },
    handleFileAdd,
    handleFileUnlink,
    dispose: disposeSession,
  };
}

export default pugRustPlugin;
