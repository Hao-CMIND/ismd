import fs from 'node:fs';
import path from 'node:path';
import ismd from 'ismd';
import registry from './session-registry.mjs';

function isIsmdFile(filePath) {
  return typeof filePath === 'string' && /\.pug$/i.test(filePath);
}

function normalizeTrackedKey(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const LEGACY_FILTER_OPTIONS = ['filters', 'filterExecutor', 'filterOptions', 'filterAliases'];

/**
 * Webpack 5 Plugin that owns a persistent ismd CompilerSession
 * and shares it with ismd loader via a WeakMap keyed by the Webpack compiler.
 */
export class IsmdWebpackPlugin {
  constructor(options = {}) {
    const legacyOptions = LEGACY_FILTER_OPTIONS.filter((key) => options[key] !== undefined);
    if (legacyOptions.length > 0) {
      throw new Error(
        `[ismd-webpack-plugin] The following filter options have been removed and are no longer supported: ${legacyOptions.join(
          ', '
        )}. Use native Rust plugins via options.plugins instead.`
      );
    }
    this.options = options;
    this.session = null;
    this.compilerRef = null;
    this.trackedDependencies = new Set();
    this.metrics = {
      sessionCreates: 0,
      initialBatchCompiles: 0,
      watchRuns: 0,
      noopWatchRuns: 0,
      affectedCompiles: 0,
      lastAffectedCount: 0,
      removedFilesCount: 0,
      disposes: 0,
    };
  }

  recordDependencies(results) {
    if (!Array.isArray(results)) return;
    for (const item of results) {
      if (item && Array.isArray(item.dependencies)) {
        for (const dep of item.dependencies) {
          this.trackedDependencies.add(normalizeTrackedKey(dep));
        }
      }
    }
  }

  isTrackedFile(filePath) {
    return isIsmdFile(filePath) || (typeof filePath === 'string' && this.trackedDependencies.has(normalizeTrackedKey(filePath)));
  }

  getCompilerOptions(compiler) {
    const context = (compiler && compiler.context) || process.cwd();
    return {
      basedir: this.options.basedir ? path.resolve(this.options.basedir) : context,
      pretty: this.options.pretty,
      doctype: this.options.doctype,
      globals: this.options.globals,
      self: this.options.self,
      compileDebug:
        this.options.compileDebug !== undefined ? this.options.compileDebug : false,
      inlineRuntimeFunctions: this.options.inlineRuntimeFunctions,
      plugins: this.options.plugins,
    };
  }

  ensureSession(compiler) {
    if (!this.session || this.session.isDisposed) {
      this.session = ismd.createCompiler(this.getCompilerOptions(compiler || this.compilerRef));
      this.metrics.sessionCreates += 1;
    }
    if (compiler) {
      this.compilerRef = compiler;
      registry.set(compiler, {
        session: this.session,
        options: this.options,
        metrics: this.metrics,
        recordDependencies: (results) => this.recordDependencies(results),
      });
    }
    return this.session;
  }

  dispose() {
    if (this.session && !this.session.isDisposed) {
      this.session.dispose();
      this.metrics.disposes += 1;
    }
    if (this.compilerRef) {
      registry.delete(this.compilerRef);
    }
    this.trackedDependencies.clear();
    this.session = null;
  }

  getMetrics() {
    return {
      ...this.metrics,
      stats: this.session && !this.session.isDisposed ? this.session.stats() : null,
    };
  }

  apply(compiler) {
    this.compilerRef = compiler;
    this.ensureSession(compiler);

    if (compiler.hooks && compiler.hooks.run) {
      compiler.hooks.run.tapPromise('IsmdWebpackPlugin', async () => {
        const active = this.ensureSession(compiler);
        if (Array.isArray(this.options.entries) && this.options.entries.length > 0) {
          const batch = this.options.entries.map((entry) =>
            typeof entry === 'string'
              ? { id: path.resolve(entry), filename: path.resolve(entry) }
              : {
                  ...entry,
                  id: entry.id || path.resolve(entry.filename),
                  filename: path.resolve(entry.filename || entry.id),
                }
          );
          const initial = active.compileBatch(batch);
          this.recordDependencies(initial);
          this.metrics.initialBatchCompiles += 1;
        }
      });
    }

    if (compiler.hooks && compiler.hooks.watchRun) {
      compiler.hooks.watchRun.tapPromise('IsmdWebpackPlugin', async (comp) => {
        const target = comp || compiler;
        const active = this.ensureSession(target);
        this.metrics.watchRuns += 1;

        const removed = target.removedFiles
          ? Array.from(target.removedFiles).filter((f) => this.isTrackedFile(f))
          : [];
        const modified = target.modifiedFiles
          ? Array.from(target.modifiedFiles).filter((f) => this.isTrackedFile(f))
          : [];

        if (removed.length > 0) {
          this.metrics.removedFilesCount += removed.length;
          active.removeFiles(removed);
        }

        if (modified.length > 0) {
          const updates = [];
          const missing = [];
          for (const file of modified) {
            try {
              updates.push({ path: file, source: fs.readFileSync(file, 'utf8') });
            } catch {
              missing.push(file);
            }
          }
          if (missing.length > 0) {
            this.metrics.removedFilesCount += missing.length;
            active.removeFiles(missing);
          }
          if (updates.length > 0) {
            const report = active.updateFiles(updates);
            if (!report.changed) {
              this.metrics.noopWatchRuns += 1;
              this.metrics.lastAffectedCount = 0;
              return;
            }
            const compiled = active.compileAffected();
            this.recordDependencies(compiled);
            this.metrics.affectedCompiles += 1;
            this.metrics.lastAffectedCount = compiled.length;
            return;
          }
        } else if (removed.length === 0) {
          if (
            Array.isArray(this.options.entries) &&
            this.options.entries.length > 0 &&
            this.metrics.initialBatchCompiles === 0
          ) {
            const batch = this.options.entries.map((entry) =>
              typeof entry === 'string'
                ? { id: path.resolve(entry), filename: path.resolve(entry) }
                : {
                    ...entry,
                    id: entry.id || path.resolve(entry.filename),
                    filename: path.resolve(entry.filename || entry.id),
                  }
            );
            const initial = active.compileBatch(batch);
            this.recordDependencies(initial);
            this.metrics.initialBatchCompiles += 1;
          } else {
            this.metrics.noopWatchRuns += 1;
          }
        }
      });
    }

    if (compiler.hooks && compiler.hooks.done) {
      compiler.hooks.done.tap('IsmdWebpackPlugin', () => {
        if (!compiler.watchMode) {
          this.dispose();
        }
      });
    }

    if (compiler.hooks && compiler.hooks.watchClose) {
      compiler.hooks.watchClose.tap('IsmdWebpackPlugin', () => {
        this.dispose();
      });
    }

    if (compiler.hooks && compiler.hooks.shutdown) {
      compiler.hooks.shutdown.tap('IsmdWebpackPlugin', () => {
        this.dispose();
      });
    }
  }
}

export const IsmdRustPlugin = IsmdWebpackPlugin;
export default IsmdWebpackPlugin;
