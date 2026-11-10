import { createRequire } from 'node:module';
import * as pug from './index.js';

const require = createRequire(import.meta.url);
const resolvedPug = JSON.stringify(require.resolve('./index.js'));

function compileTemplate(module, filename) {
  var template = pug.compileFileClient(filename, {
    inlineRuntimeFunctions: false,
  });
  var body =
    'var pug = require(' +
    resolvedPug +
    ').runtime;\n\n' +
    'module.exports = ' +
    template +
    ';';
  module._compile(body, filename);
}

if (require.extensions) {
  require.extensions['.pug'] = compileTemplate;
}

export { compileTemplate };
export default compileTemplate;
