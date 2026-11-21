import dependencies from './lib/dependencies.mjs';
import internals from './lib/internals.mjs';
import sources from './lib/sources.mjs';

export default function build(functions) {
  var fns = [];
  functions = functions.filter(function(fn) {
    return !internals[fn];
  });
  for (var i = 0; i < functions.length; i++) {
    if (fns.indexOf(functions[i]) === -1) {
      fns.push(functions[i]);
      functions.push.apply(functions, dependencies[functions[i]]);
    }
  }
  return fns
    .sort()
    .map(function(name) {
      return sources[name];
    })
    .join('\n');
}
