import ismd from 'ismd';
import registry from './session-registry.mjs';

/**
 * Thin ESM Webpack loader adapter.
 * Uses the shared CompilerSession registered by IsmdWebpackPlugin when present,
 * and falls back to standalone compile() only when used without the plugin.
 */
export default function ismdLoader(source) {
  const options =
    (typeof this.getOptions === 'function' ? this.getOptions() : this.query) || {};
  const resourcePath = this.resourcePath;
  const pluginRecord = this._compiler ? registry.get(this._compiler) : null;

  if (pluginRecord && pluginRecord.session && !pluginRecord.session.isDisposed) {
    const session = pluginRecord.session;
    const results = session.compileEntries([
      { id: resourcePath, filename: resourcePath, source },
    ]);
    if (typeof pluginRecord.recordDependencies === 'function') {
      pluginRecord.recordDependencies(results);
    }
    const compiled = results[0];

    if (Array.isArray(compiled.dependencies) && typeof this.addDependency === 'function') {
      for (const dep of compiled.dependencies) {
        this.addDependency(dep);
      }
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
  const fn = ismd.compile(source, compileOpts);
  if (Array.isArray(fn.dependencies) && typeof this.addDependency === 'function') {
    for (const dep of fn.dependencies) {
      this.addDependency(dep);
    }
  }
  const locals =
    typeof options.locals === 'function'
      ? options.locals(resourcePath)
      : options.locals || {};
  return `export default ${JSON.stringify(fn(locals))};\n`;
}
