import pug from '../compiler/index.js';
import registry from './session-registry.js';

/**
 * Thin ESM Webpack loader adapter.
 * Uses the shared CompilerSession registered by PugRustPlugin when present,
 * and falls back to standalone compile() only when used without the plugin.
 */
export default function pugRustLoader(source) {
  const options =
    (typeof this.getOptions === 'function' ? this.getOptions() : this.query) || {};
  const resourcePath = this.resourcePath;
  const pluginRecord = this._compiler ? registry.get(this._compiler) : null;

  if (pluginRecord && pluginRecord.session && !pluginRecord.session.isDisposed) {
    const session = pluginRecord.session;
    const results = session.compileEntries([
      { id: resourcePath, filename: resourcePath, source },
    ]);
    const compiled = results[0];

    if (Array.isArray(compiled.dependencies) && typeof this.addDependency === 'function') {
      for (const dep of compiled.dependencies) {
        this.addDependency(dep);
      }
    }

    if (options.mode === 'client') {
      return `export default ${compiled.fn.toString()};\n`;
    }

    const locals =
      typeof options.locals === 'function'
        ? options.locals(resourcePath)
        : options.locals || (pluginRecord.options && pluginRecord.options.locals) || {};
    const html = compiled.fn(locals);
    return `export default ${JSON.stringify(html)};\n`;
  }

  const compileOpts = {
    ...options,
    filename: resourcePath,
    compileDebug: options.compileDebug !== undefined ? options.compileDebug : false,
  };
  const fn = pug.compile(source, compileOpts);
  if (Array.isArray(fn.dependencies) && typeof this.addDependency === 'function') {
    for (const dep of fn.dependencies) {
      this.addDependency(dep);
    }
  }
  if (options.mode === 'client') {
    return `export default ${fn.toString()};\n`;
  }
  const locals =
    typeof options.locals === 'function'
      ? options.locals(resourcePath)
      : options.locals || {};
  return `export default ${JSON.stringify(fn(locals))};\n`;
}
