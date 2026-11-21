import { createRequire } from 'node:module';
import * as ismd from './index.mjs';

const require = createRequire(import.meta.url);

function compileTemplate(module, filename) {
  module.exports = ismd.compileFile(filename);
}

if (require.extensions) {
  require.extensions['.pug'] = compileTemplate;
}

export { compileTemplate };
export default compileTemplate;
