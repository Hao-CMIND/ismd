import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Initialization only: all syntax handling and transformation execute in the native library.
export function nativePluginPath({ profile } = {}) {
  if (profile !== undefined && !['debug', 'release'].includes(profile)) {
    throw new Error('Invalid native build profile');
  }
  const filename =
    process.platform === 'win32'
      ? 'ismd_filter_uppercase.dll'
      : process.platform === 'darwin'
        ? 'libismd_filter_uppercase.dylib'
        : 'libismd_filter_uppercase.so';
  const targetRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native/target');
  const profiles = profile ? [profile] : ['release', 'debug'];
  for (const candidate of profiles) {
    const library = path.join(targetRoot, candidate, filename);
    if (fs.existsSync(library)) {
      return library;
    }
  }
  throw new Error('Native Filters library is missing. Run npm run build --workspace=ismd-filters');
}

export default nativePluginPath;
