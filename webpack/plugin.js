import fs from 'node:fs';
import path from 'node:path';
import pug from '../compiler/index.js';
import registry from './session-registry.js';

function isPugFile(filePath) {
  return typeof filePath === 'string' && /\.pug$/i.test(filePath);
}

/**
 * Webpack 5 Plugin that owns a persistent pug-rust CompilerSession
 * and shares it with pug-rust-loader via a WeakMap keyed by the Webpack compiler.
 */
export class PugRustPlugin {
  constructor(options = {}) {
    this.options = options;
    this.session = null;
    this.compilerRef = null;
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
      filters: this.options.filters,
      filterExecutor: this.options.filterExecutor,
      plugins: this.options.plugins,
      filterOptions: this.options.filterOptions,
      filterAliases: this.options.filterAliases,
    };
  }

  ensureSession(compiler) {
    if (!this.session || this.session.isDisposed) {
      this.session = pug.createCompiler(this.getCompilerOptions(compiler || this.compilerRef));
      this.metrics.sessionCreates += 1;
    }
    if (compiler) {
      this.compilerRef = compiler;
      registry.set(compiler, {
        session: this.session,
        options: this.options,
        metrics: this.metrics,
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
      compiler.hooks.run.tapPromise('PugRustPlugin', async () => {
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
          active.compileBatch(batch);
          this.metrics.initialBatchCompiles += 1;
        }
      });
    }

    if (compiler.hooks && compiler.hooks.watchRun) {
      compiler.hooks.watchRun.tapPromise('PugRustPlugin', async (comp) => {
        const target = comp || compiler;
        const active = this.ensureSession(target);
        this.metrics.watchRuns += 1;

        const removed = target.removedFiles
          ? Array.from(target.removedFiles).filter(isPugFile)
          : [];
        const modified = target.modifiedFiles
          ? Array.from(target.modifiedFiles).filter(isPugFile)
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
            active.compileBatch(batch);
            this.metrics.initialBatchCompiles += 1;
          } else {
            this.metrics.noopWatchRuns += 1;
          }
        }
      });
    }

    if (compiler.hooks && compiler.hooks.done) {
      compiler.hooks.done.tap('PugRustPlugin', () => {
        if (!compiler.watchMode) {
          this.dispose();
        }
      });
    }

    if (compiler.hooks && compiler.hooks.watchClose) {
      compiler.hooks.watchClose.tap('PugRustPlugin', () => {
        this.dispose();
      });
    }

    if (compiler.hooks && compiler.hooks.shutdown) {
      compiler.hooks.shutdown.tap('PugRustPlugin', () => {
        this.dispose();
      });
    }
  }
}

export default PugRustPlugin;
