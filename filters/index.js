import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Initialization only: all syntax handling and transformation execute in the native library.
export function nativePluginPath({ profile = 'debug' } = {}) {
  if (!['debug', 'release'].includes(profile)) throw new Error('Invalid native build profile');
  const filename = process.platform === 'win32' ? 'pug_filter_uppercase.dll'
    : process.platform === 'darwin' ? 'libpug_filter_uppercase.dylib' : 'libpug_filter_uppercase.so';
  const library = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native/target', profile, filename);
  if (!fs.existsSync(library)) throw new Error('Native Filters library is missing. Run npm run build --workspace=@pug-rust/filters');
  return library;
}

export default nativePluginPath;
