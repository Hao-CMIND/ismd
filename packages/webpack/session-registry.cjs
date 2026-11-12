'use strict';

const registry = new WeakMap();

module.exports = {
  set(compiler, record) {
    registry.set(compiler, record);
  },
  get(compiler) {
    return registry.get(compiler);
  },
  delete(compiler) {
    return registry.delete(compiler);
  },
};
