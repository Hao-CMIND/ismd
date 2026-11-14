import fs from 'node:fs';
import path from 'node:path';
import pug from '../compiler/index.js';

function isPugFile(filePath) {
  return typeof filePath === 'string' && /\.pug($|\?)/i.test(filePath);
}

function stripQuery(id) {
  const idx = id.indexOf('?');
  return idx === -1 ? id : id.slice(0, idx);
}

export function normalizePath(id) {
  if (typeof id !== 'string') return id;
  let normalized = path.resolve(id).replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

function defaultIsEntry(filePath, rootDir) {
  const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  return !/(^|\/)(includes?|layouts?|partials?|components?|mixins?)\//i.test(rel);
}

/**
 * Create a Vite plugin backed by a persistent pug-rust CompilerSession.
 */
export function pugRustPlugin(options = {}) {
  // P0: Disallow legacy filter options with a clear, descriptive error
  const legacyOptions = ['filters', 'filterExecutor', 'filterOptions', 'filterAliases'].filter(
    (key) => options[key] !== undefined
  );
  if (legacyOptions.length > 0) {
    throw new Error(
      `[pug-rust/vite] The following filter options have been removed in Phase 3 and are no longer supported: ${legacyOptions.join(
        ', '
      )}. Use native Rust plugins via options.plugins instead.`
    );
  }

  let root = options.basedir ? path.resolve(options.basedir) : process.cwd();
  let command = 'build';
  let session = null;
  let serverRef = null;
  let watcherRef = null;
  let addWatcherHandler = null;
  let unlinkWatcherHandler = null;

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
      plugins: options.plugins,
    };
  }

  function ensureSession() {
    if (!session || session.isDisposed) {
      session = pug.createCompiler(getCompilerOptions());
      metrics.sessionCreates += 1;
    }
    return session;
  }

  function cleanupWatcher() {
    if (watcherRef) {
      const remove = typeof watcherRef.off === 'function' ? watcherRef.off : watcherRef.removeListener;
      if (typeof remove === 'function') {
        if (addWatcherHandler) remove.call(watcherRef, 'add', addWatcherHandler);
        if (unlinkWatcherHandler) remove.call(watcherRef, 'unlink', unlinkWatcherHandler);
      }
      addWatcherHandler = null;
      unlinkWatcherHandler = null;
      watcherRef = null;
    }
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
      if (p) registeredEntries.add(normalizePath(path.resolve(root, p)));
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
    } catch (err) {
      // Windows Atomic Save may briefly lock the file with EBUSY/EPERM/ENOENT.
      // Small backoff retry for atomic save stability.
      if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOENT')) {
        await new Promise((r) => setTimeout(r, 20));
        try {
          source = readFn ? await readFn() : fs.readFileSync(cleanPath, 'utf8');
        } catch {
          if (!fs.existsSync(cleanPath)) {
            const rep = active.removeFiles([cleanPath]);
            registeredEntries.delete(normalizePath(path.resolve(root, cleanPath)));
            return { changed: rep.changed, affected: [] };
          }
          return { changed: false, affected: [] };
        }
      } else {
        if (!fs.existsSync(cleanPath)) {
          const rep = active.removeFiles([cleanPath]);
          registeredEntries.delete(normalizePath(path.resolve(root, cleanPath)));
          return { changed: rep.changed, affected: [] };
        }
        return { changed: false, affected: [] };
      }
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

  async function handleFileAdd(filePath) {
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
    const abs = normalizePath(path.resolve(root, cleanPath));
    let compiled = [];

    if (entryCheck(abs)) {
      registeredEntries.add(abs);
      compiled = active.compileEntries([{ id: abs, filename: abs, source }]);
    } else if (report.changed) {
      compiled = active.compileAffected();
    }

    if (report.changed && options.hmr !== false && serverRef && serverRef.ws && typeof serverRef.ws.send === 'function') {
      serverRef.ws.send({
        type: 'full-reload',
        path: '*',
      });
    }

    return { changed: report.changed, report, affected: compiled };
  }

  function handleFileUnlink(filePath) {
    const cleanPath = stripQuery(filePath);
    if (!isPugFile(cleanPath)) return { changed: false, affected: [] };
    if (!session || session.isDisposed) return { changed: false, affected: [] };
    metrics.unlinkEvents += 1;
    const abs = normalizePath(path.resolve(root, cleanPath));
    registeredEntries.delete(abs);
    const report = session.removeFiles([cleanPath]);

    // Invalidate in Vite ModuleGraph if available
    if (serverRef && serverRef.moduleGraph) {
      if (typeof serverRef.moduleGraph.onFileDelete === 'function') {
        serverRef.moduleGraph.onFileDelete(cleanPath);
      }
    }

    if (report.changed && options.hmr !== false && serverRef && serverRef.ws && typeof serverRef.ws.send === 'function') {
      serverRef.ws.send({
        type: 'full-reload',
        path: '*',
      });
    }

    return { changed: report.changed, report, affected: [] };
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
        const batch = options.entries.map((entry) => {
          const entryPath = typeof entry === 'string' ? entry : entry.filename || entry.id;
          const abs = normalizePath(path.resolve(root, entryPath));
          return typeof entry === 'string'
            ? { id: abs, filename: abs }
            : { ...entry, id: entry.id ? normalizePath(path.resolve(root, entry.id)) : abs, filename: abs };
        });
        active.compileBatch(batch);
        metrics.initialBatchCompiles += 1;
      }
    },

    configureServer(server) {
      serverRef = server;
      ensureSession();

      cleanupWatcher();

      if (server && server.watcher && typeof server.watcher.on === 'function') {
        watcherRef = server.watcher;
        addWatcherHandler = (file) => {
          handleFileAdd(file).catch(() => {});
        };
        unlinkWatcherHandler = (file) => {
          handleFileUnlink(file);
        };
        server.watcher.on('add', addWatcherHandler);
        server.watcher.on('unlink', unlinkWatcherHandler);
      }

      if (server && server.httpServer && typeof server.httpServer.once === 'function') {
        server.httpServer.once('close', () => {
          cleanupWatcher();
          disposeSession();
        });
      }
    },

    closeServer() {
      cleanupWatcher();
      disposeSession();
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
        const seen = new Set();
        for (const item of result.affected) {
          const normFile = normalizePath(item.id || item.filename);
          const candidates = [
            normFile,
            String(item.id).replace(/\\/g, '/'),
            String(item.id),
            normFile.toLowerCase(),
            normFile.replace(/\//g, '\\'),
          ];
          let foundMods = null;
          for (const cand of candidates) {
            const mods = modGraph.getModulesByFile(cand);
            if (mods && (mods.size > 0 || (Array.isArray(mods) && mods.length > 0))) {
              foundMods = mods;
              break;
            }
            if (typeof modGraph.getModuleById === 'function') {
              const single = modGraph.getModuleById(cand);
              if (single) {
                foundMods = [single];
                break;
              }
            }
          }

          if (foundMods) {
            for (const m of foundMods) {
              const key = m.id || m.url || m.file || m;
              if (!seen.has(key)) {
                seen.add(key);
                if (typeof modGraph.invalidateModule === 'function') {
                  modGraph.invalidateModule(m, undefined, undefined, true);
                }
                affectedModules.push(m);
              }
            }
          }
        }
      }

      // P1.5: Only trigger full-reload if there are affected modules or affected entries
      if (options.hmr !== false && (affectedModules.length > 0 || (result.affected && result.affected.length > 0))) {
        if (ctx.server && ctx.server.ws && typeof ctx.server.ws.send === 'function') {
          ctx.server.ws.send({
            type: 'full-reload',
            path: '*',
          });
        }
      }

      return affectedModules.length > 0 ? affectedModules : ctx.modules || [];
    },

    transform: {
      filter: {
        id: /\.pug(?:\?|$)/i,
      },

      handler(code, id) {
        const cleanId = stripQuery(id);
        if (!isPugFile(cleanId)) return null;

        const active = ensureSession();
        const abs = normalizePath(path.resolve(root, cleanId));
        registeredEntries.add(abs);

        const results = active.compileEntries([
          { id: abs, filename: abs, source: code },
        ]);
        const entry = results[0];
        const html = entry.fn(resolveLocals(abs, { id: abs }));

        return {
          code: `export default ${JSON.stringify(html)};\n`,
          map: null,
          moduleType: 'js',
        };
      },
    },

    closeBundle() {
      if (command === 'build') {
        cleanupWatcher();
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
    dispose: () => {
      cleanupWatcher();
      disposeSession();
    },
  };
}

export default pugRustPlugin;
