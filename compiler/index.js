import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from './runtime/index.js';
import runtimeWrap from './runtime/wrap.js';
import runtimeBuild from './runtime/build.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function loadNativeAddon() {
  if (process.env.PUG_PROFILE === '1' && process.env.PUG_PROFILE_ADDON) {
    const profileAddon = path.resolve(process.env.PUG_PROFILE_ADDON);
    if (!fs.existsSync(profileAddon)) {
      throw new Error(`PUG_PROFILE_ADDON not found: ${profileAddon}`);
    }
    if (profileAddon.endsWith('.dll')) {
      const nodePath = profileAddon.slice(0, -4) + '.node';
      if (
        !fs.existsSync(nodePath) ||
        fs.statSync(profileAddon).mtimeMs > fs.statSync(nodePath).mtimeMs
      ) {
        fs.copyFileSync(profileAddon, nodePath);
      }
      return require(nodePath);
    }
    return require(profileAddon);
  }
  const candidates = [
    path.join(__dirname, 'pug-napi.win32-x64-msvc.node'),
    path.join(__dirname, 'target/release/pug_napi.dll'),
    path.join(__dirname, 'target/debug/pug_napi.dll'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const nodePath = path.join(__dirname, 'pug-napi.win32-x64-msvc.node');
      if (candidate.endsWith('.dll')) {
        try {
          fs.copyFileSync(candidate, nodePath);
        } catch (_) {}
      }
      return require(fs.existsSync(nodePath) ? nodePath : candidate);
    }
  }
  throw new Error(
    'pug_napi native module not found. Run `cargo build -p pug_napi` first.'
  );
}

const native = loadNativeAddon();

export const name = 'Pug';
export { runtime };
export const cache = {};
export const filters = {};

function makeError(code, message, options) {
  options = options || {};
  const dto = native.makeErrorDto(String(code), String(message), {
    line: Number(options.line || 0),
    column:
      options.column === undefined || options.column === null
        ? undefined
        : Number(options.column),
    filename: options.filename,
    src: options.src,
  });
  const err = new Error(dto.message);
  err.code = dto.code;
  err.msg = dto.msg;
  err.line = dto.line;
  err.column = dto.column === null ? undefined : dto.column;
  err.filename = dto.filename === null ? undefined : dto.filename;
  err.src = dto.src === null ? undefined : dto.src;
  err.toJSON = function() {
    return {
      code: this.code,
      msg: this.msg,
      line: this.line,
      column: this.column,
      filename: this.filename,
    };
  };
  return err;
}

export function _runtimeBuild(fns) {
  return native.runtimeBuild(fns);
}
export { makeError as _error, runtimeBuild as _runtimeBuildJs };

function dtoToJsError(dto) {
  const err = new Error(dto.message);
  err.code = dto.code;
  err.msg = dto.msg;
  err.line = dto.line;
  err.column = dto.column === null ? undefined : dto.column;
  err.filename = dto.filename === null ? undefined : dto.filename;
  err.src = dto.src === null ? undefined : dto.src;
  err.toJSON = function() {
    return {
      code: this.code,
      msg: this.msg,
      line: this.line,
      column: this.column,
      filename: this.filename,
    };
  };
  return err;
}

function buildLexPluginBridge(plugins) {
  const lexPlugins = (plugins || [])
    .filter((p) => p && p.lex)
    .map((p) => p.lex);
  if (!lexPlugins.length) {
    return { methods: [], step: undefined };
  }
  const methodSet = new Set();
  for (const lp of lexPlugins) {
    for (const k of Object.keys(lp)) {
      if (typeof lp[k] === 'function') methodSet.add(k);
    }
    const proto = Object.getPrototypeOf(lp);
    if (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k !== 'constructor' && typeof lp[k] === 'function') methodSet.add(k);
      }
    }
  }
  return {
    methods: Array.from(methodSet),
    step: function(method, state) {
      const proxy = {
        input: state.input,
        filename: state.filename === null ? undefined : state.filename,
        lineno: state.lineno,
        colno: state.colno,
        interpolated: state.interpolated,
        tokens: state.tokens,
        ended: state.ended,
        tok(type, val) {
          const t = {
            type,
            loc: {
              start: { line: this.lineno, column: this.colno },
              filename: this.filename,
            },
          };
          if (val !== undefined) t.val = val;
          return t;
        },
        tokEnd(tok) {
          tok.loc.end = { line: this.lineno, column: this.colno };
          return tok;
        },
        consume(len) {
          this.input = this.input.substr(len);
        },
        incrementColumn(inc) {
          this.colno += inc;
        },
        incrementLine(inc) {
          this.lineno += inc;
          if (inc) this.colno = 1;
        },
        error(code, message) {
          throw makeError(code, message, {
            line: this.lineno,
            column: this.colno,
            filename: this.filename,
          });
        },
      };
      let handled = false;
      for (const lp of lexPlugins) {
        if (typeof lp[method] === 'function' && lp[method](proxy)) {
          handled = true;
          break;
        }
      }
      return {
        handled,
        state: {
          input: proxy.input,
          filename: proxy.filename === undefined ? null : proxy.filename,
          lineno: proxy.lineno,
          colno: proxy.colno,
          interpolated: Boolean(proxy.interpolated),
          tokens: proxy.tokens.map((tok) => {
            if (tok && tok.loc && tok.loc.start && !tok.loc.end) {
              return {
                ...tok,
                loc: {
                  ...tok.loc,
                  end: { ...tok.loc.start },
                },
              };
            }
            return tok;
          }),
          ended: Boolean(proxy.ended),
        },
      };
    },
  };
}

function lex(str, options) {
  if (typeof str !== 'string') {
    throw new Error(
      'Expected source code to be a string but got "' + typeof str + '"'
    );
  }
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new Error(
      'Expected "options" to be an object but got "' + typeof options + '"'
    );
  }
  options = options || {};
  const lexBridge = buildLexPluginBridge(options.plugins);
  const outcome = native.lexSync(
    str,
    {
      filename: options.filename,
      interpolated: Boolean(options.interpolated),
      startingLine:
        options.startingLine === undefined ? undefined : Number(options.startingLine),
      startingColumn:
        options.startingColumn === undefined ? undefined : Number(options.startingColumn),
      pluginMethods: lexBridge.methods,
    },
    lexBridge.step ? { lexPluginStep: lexBridge.step } : undefined
  );
  if (!outcome.ok && outcome.plainError) {
    throw new Error(outcome.plainError);
  }
  if (!outcome.ok && outcome.error) {
    throw dtoToJsError(outcome.error);
  }
  return outcome.data;
}

function stripComments(input, options) {
  options = options || {};
  const outcome = native.stripCommentsSync(input, {
    stripUnbuffered: options.stripUnbuffered !== false,
    stripBuffered: options.stripBuffered === true,
    filename: options.filename,
  });
  if (!outcome.ok && outcome.plainError) {
    throw new Error(outcome.plainError);
  }
  if (!outcome.ok && outcome.error) {
    throw dtoToJsError(outcome.error);
  }
  return outcome.data;
}

export {
  lex as _lex,
  lex,
  stripComments as _stripComments,
  stripComments,
};

function parse(tokens, options) {
  if (!Array.isArray(tokens)) {
    throw new Error(
      'Expected tokens to be an Array but got "' + typeof tokens + '"'
    );
  }
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new Error(
      'Expected "options" to be an object but got "' + typeof options + '"'
    );
  }
  options = options || {};
  const outcome = native.parseSync(
    tokens,
    {
      filename: options.filename,
      src: options.src,
    },
    { warn: (msg) => console.warn(msg) }
  );
  if (!outcome.ok && outcome.plainError) {
    throw new Error(outcome.plainError);
  }
  if (!outcome.ok && outcome.error) {
    throw dtoToJsError(outcome.error);
  }
  return outcome.data;
}

function walkAST(ast, before, after, options) {
  if (after && typeof after === 'object' && typeof options === 'undefined') {
    options = after;
    after = null;
  }
  options = options || { includeDependencies: false };
  const parents = (options.parents = options.parents || []);
  const initialParentsSnapshot = parents.slice();
  const jsStack = [];

  const userBefore = typeof before === 'function' ? before : null;
  const userAfter = typeof after === 'function' ? after : null;

  const callbacks = {
    before: function(step) {
      let replaced = false;
      let replacement = undefined;
      const nodeObj = reviveAstBuffers(step.node);
      parents.splice(0, parents.length, ...jsStack, ...initialParentsSnapshot);

      let res;
      if (userBefore) {
        const replace = function replace(rep) {
          if (Array.isArray(rep) && !replace.arrayAllowed) {
            throw new Error(
              'replace() can only be called with an array if the last parent is a Block or NamedBlock'
            );
          }
          replaced = true;
          replacement = rep;
        };
        replace.arrayAllowed = Boolean(step.arrayAllowed);
        res = userBefore(nodeObj, replace);
      }

      const finalNode = replaced ? replacement : nodeObj;
      if (res !== false && !Array.isArray(finalNode)) {
        jsStack.unshift(finalNode);
        parents.splice(0, parents.length, ...jsStack, ...initialParentsSnapshot);
      }

      return {
        cont: res !== false,
        replaced: true,
        replacement: dehydrateAstBuffers(finalNode),
      };
    },
    after: function(step) {
      const origNode = jsStack.shift();
      let nodeObj = reviveAstBuffers(step.node);
      if (origNode && typeof origNode === 'object' && nodeObj && typeof nodeObj === 'object') {
        Object.assign(origNode, nodeObj);
        nodeObj = origNode;
      }
      parents.splice(0, parents.length, ...jsStack, ...initialParentsSnapshot);

      let replaced = false;
      let replacement = undefined;
      if (userAfter) {
        const replace = function replace(rep) {
          if (Array.isArray(rep) && !replace.arrayAllowed) {
            throw new Error(
              'replace() can only be called with an array if the last parent is a Block or NamedBlock'
            );
          }
          replaced = true;
          replacement = rep;
        };
        replace.arrayAllowed = Boolean(step.arrayAllowed);
        userAfter(nodeObj, replace);
      }

      if (!replaced) {
        replaced = true;
        replacement = nodeObj;
      }
      return {
        cont: true,
        replaced,
        replacement: dehydrateAstBuffers(replacement),
      };
    },
  };

  const result = native.walkSync(
    dehydrateAstBuffers(ast),
    Boolean(options.includeDependencies),
    dehydrateAstBuffers(initialParentsSnapshot),
    callbacks
  );
  parents.splice(0, parents.length, ...initialParentsSnapshot);
  return reviveAstBuffers(result);
}

function reviveAstBuffers(val) {
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      reviveAstBuffers(val[i]);
    }
    return val;
  }
  if (val && typeof val === 'object' && !Buffer.isBuffer(val)) {
    if (
      val.type === 'FileReference' &&
      val.raw &&
      typeof val.raw === 'object' &&
      !Buffer.isBuffer(val.raw) &&
      val.raw.type === 'Buffer' &&
      Array.isArray(val.raw.data)
    ) {
      val.raw = Buffer.from(val.raw.data);
    }
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k !== 'raw') {
        reviveAstBuffers(val[k]);
      }
    }
  }
  return val;
}

function dehydrateAstBuffers(val) {
  if (Array.isArray(val)) {
    return val.map(dehydrateAstBuffers);
  }
  if (val && typeof val === 'object' && !Buffer.isBuffer(val)) {
    const out = {};
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === 'raw' && val.type === 'FileReference' && Buffer.isBuffer(val.raw)) {
        out.raw = { type: 'Buffer', data: Array.from(val.raw) };
      } else {
        out[k] = dehydrateAstBuffers(val[k]);
      }
    }
    return out;
  }
  return val;
}

function load(ast, options) {
  options = getLoadOptions(options);
  const inputAst = dehydrateAstBuffers(JSON.parse(JSON.stringify(ast)));
  const outcome = native.loadSync(inputAst, options.basedir, {
    resolve: function(targetPath, source, nodeFilename, nodeLine) {
      try {
        return String(options.resolve(targetPath, source, options));
      } catch (ex) {
        if (ex && typeof ex === 'object' && 'message' in ex) {
          ex.message += '\n    at ' + nodeFilename + ' line ' + nodeLine;
        }
        throw ex;
      }
    },
    read: function(fullPath, nodeFilename, nodeLine) {
      try {
        const raw = options.read(fullPath, options);
        if (Buffer.isBuffer(raw) || typeof raw === 'string') {
          return raw;
        }
        return raw.toString('utf8');
      } catch (ex) {
        if (ex && typeof ex === 'object' && 'message' in ex) {
          ex.message += '\n    at ' + nodeFilename + ' line ' + nodeLine;
        }
        throw ex;
      }
    },
    parseSource: function(src, filename) {
      const childOpts = Object.assign({}, options, {
        filename: filename,
        src: src,
      });
      const tokens = childOpts.lex(src, childOpts);
      return dehydrateAstBuffers(childOpts.parse(tokens, childOpts));
    },
  });
  if (!outcome.ok) {
    if (outcome.plainError) throw new Error(outcome.plainError);
    if (outcome.error) throw dtoToJsError(outcome.error);
  }
  return reviveAstBuffers(outcome.data);
}

load.string = function loadString(src, options) {
  options = Object.assign(getLoadOptions(options), {
    src: src,
  });
  const tokens = options.lex(src, options);
  const ast = options.parse(tokens, options);
  return load(ast, options);
};

load.file = function loadFile(filename, options) {
  options = Object.assign(getLoadOptions(options), {
    filename: filename,
  });
  const str = options.read(filename).toString('utf8');
  return load.string(str, options);
};

load.resolve = function resolve(filename, source, options) {
  const outcome = native.defaultResolveSync(
    String(filename),
    source === undefined || source === null ? undefined : String(source),
    options && options.basedir !== undefined && options.basedir !== null
      ? String(options.basedir)
      : undefined
  );
  if (!outcome.ok) {
    throw new Error(outcome.plainError || 'Failed to resolve path');
  }
  return outcome.data;
};

load.read = function read(filename) {
  return fs.readFileSync(filename);
};

load.validateOptions = function validateOptions(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('options must be an object');
  }
  if (typeof options.lex !== 'function') {
    throw new TypeError('options.lex must be a function');
  }
  if (typeof options.parse !== 'function') {
    throw new TypeError('options.parse must be a function');
  }
  if (options.resolve && typeof options.resolve !== 'function') {
    throw new TypeError('options.resolve must be a function');
  }
  if (options.read && typeof options.read !== 'function') {
    throw new TypeError('options.read must be a function');
  }
};

function getLoadOptions(options) {
  load.validateOptions(options);
  return Object.assign(
    {
      resolve: load.resolve,
      read: load.read,
    },
    options
  );
}

export {
  parse as _parse,
  parse,
  load as _load,
  walkAST as _walk,
  walkAST as walk,
};
export function _addWith(obj, src, exclude) {
  return native.addWithSync(
    String(obj),
    String(src),
    Array.isArray(exclude) ? exclude.map(String) : []
  );
}

let cachedFilterAdapter = null;
function loadFilterAdapter() {
  if (!cachedFilterAdapter) {
    const localFilters = path.join(__dirname, '../filters/index.js');
    if (fs.existsSync(localFilters)) {
      try {
        cachedFilterAdapter = require(localFilters);
      } catch (_) {}
    }
    if (!cachedFilterAdapter) {
      try {
        cachedFilterAdapter = require('@pug-rust/filters');
      } catch (_) {
        return null;
      }
    }
  }
  return cachedFilterAdapter;
}

function makeFilterHostCallback(filtersSet, filterExecutor) {
  if (filterExecutor === false) {
    return function disabledFilterHostCallback(filterName) {
      return {
        ok: false,
        unknownFilter: 'unknown filter ":' + filterName + '"',
      };
    };
  }
  if (typeof filterExecutor === 'function') {
    return filterExecutor;
  }
  if (filterExecutor && typeof filterExecutor.execute === 'function') {
    return function customFilterExecutorCallback(
      filterName,
      mode,
      text,
      fullPath,
      rawVal,
      attrsObj,
      dir
    ) {
      return filterExecutor.execute(filterName, mode, text, fullPath, rawVal, attrsObj, dir);
    };
  }
  let resolved = null;
  return function lazyFilterHostCallback(
    filterName,
    mode,
    text,
    fullPath,
    rawVal,
    attrsObj,
    dir
  ) {
    if (filtersSet && filtersSet[filterName]) {
      const custom = filtersSet[filterName];
      const out =
        mode === 'rawFile' && custom.renderBuffer
          ? custom.renderBuffer(rawVal, attrsObj)
          : custom(text, attrsObj);
      if (typeof out !== 'string') {
        throw new TypeError(
          'Expected filter ":' + filterName + '" to return a string, got ' + typeof out
        );
      }
      return { ok: true, value: out };
    }
    if (!resolved) {
      const adapter = loadFilterAdapter();
      if (!adapter) {
        return {
          ok: false,
          unknownFilter: 'unknown filter ":' + filterName + '"',
        };
      }
      resolved = adapter.createFilterCallback(filtersSet || {});
    }
    return resolved(filterName, mode, text, fullPath, rawVal, attrsObj, dir);
  };
}

export function _handleFilters(ast, customFilters, filterOptions, filterAliases) {
  const inputAst = dehydrateAstBuffers(JSON.parse(JSON.stringify(ast)));
  const outcome = native.handleFiltersSync(
    inputAst,
    filterOptions || null,
    filterAliases || undefined,
    { filter: makeFilterHostCallback(customFilters || {}) }
  );
  if (!outcome.ok) {
    if (outcome.plainError) throw new Error(outcome.plainError);
    if (outcome.error) throw dtoToJsError(outcome.error);
  }
  return reviveAstBuffers(outcome.data);
}

export function _link(ast) {
  const inputAst = dehydrateAstBuffers(JSON.parse(JSON.stringify(ast)));
  const outcome = native.linkSync(inputAst);
  if (!outcome.ok) {
    if (outcome.plainError) throw new Error(outcome.plainError);
    if (outcome.error) throw dtoToJsError(outcome.error);
  }
  return reviveAstBuffers(outcome.data);
}

export function _compileAttrs(attrs, options) {
  if (!Array.isArray(attrs)) {
    throw new Error('Attrs should be an array');
  }
  const validAttrs = attrs.every(function(attr) {
    return (
      attr &&
      typeof attr === 'object' &&
      typeof attr.name === 'string' &&
      (typeof attr.val === 'string' || typeof attr.val === 'boolean') &&
      typeof attr.mustEscape === 'boolean'
    );
  });
  if (!validAttrs) {
    throw new Error(
      'All attributes should be supplied as an object of the form {name, val, mustEscape}'
    );
  }
  if (!options || typeof options !== 'object') {
    throw new Error('Options should be an object');
  }
  if (typeof options.terse !== 'boolean') {
    throw new Error('Options.terse should be a boolean');
  }
  if (typeof options.runtime !== 'function') {
    throw new Error(
      'Options.runtime should be a function that takes a runtime function name and returns the source code that will evaluate to that function at runtime'
    );
  }
  if (options.format !== 'html' && options.format !== 'object') {
    throw new Error('Options.format should be "html" or "object"');
  }

  const outcome = native.compileAttrsSync(
    attrs,
    options.terse,
    options.format,
    options.runtime
  );
  if (!outcome.ok) {
    if (outcome.plainError) throw new Error(outcome.plainError);
    if (outcome.error) throw dtoToJsError(outcome.error);
  }
  return outcome.data;
}

function applyPlugins(value, options, plugins, name) {
  return plugins.reduce(function(val, plugin) {
    return plugin[name] ? plugin[name](val, options) : val;
  }, value);
}

function findReplacementFunc(plugins, name) {
  const eligible = plugins.filter(function(plugin) {
    return plugin[name];
  });
  if (eligible.length > 1) {
    throw new Error('Two or more plugins all implement ' + name + ' method.');
  } else if (eligible.length) {
    return eligible[0][name].bind(eligible[0]);
  }
  return null;
}

function normalizePretty(pretty) {
  if (pretty === true) return '  ';
  if (typeof pretty === 'string') return pretty;
  return undefined;
}

function defaultWarn(msg) {
  console.warn(msg);
}

const defaultFilterCallback = makeFilterHostCallback(null);

function hasPluginHook(plugins, name) {
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i];
    if (plugin && plugin[name]) {
      return true;
    }
  }
  return false;
}

function compileBody(str, options) {
  const plugins = options.plugins || [];
  const hasModuleFilters = Object.keys(filters).length > 0;
  const hasOptionFilters =
    Boolean(options.filters) && Object.keys(options.filters).length > 0;
  let filterCallback =
    options.filterExecutor !== undefined
      ? makeFilterHostCallback(null, options.filterExecutor)
      : defaultFilterCallback;
  if (hasModuleFilters || hasOptionFilters) {
    const filtersSet = {};
    if (hasModuleFilters) {
      Object.keys(filters).forEach(function(key) {
        filtersSet[key] = filters[key];
      });
    }
    if (hasOptionFilters) {
      Object.keys(options.filters).forEach(function(key) {
        filtersSet[key] = options.filters[key];
      });
    }
    filterCallback = makeFilterHostCallback(filtersSet, options.filterExecutor);
  }

  const customResolve = plugins.length ? findReplacementFunc(plugins, 'resolve') : null;
  const customRead = plugins.length ? findReplacementFunc(plugins, 'read') : null;
  const customGenerateCode = plugins.length
    ? findReplacementFunc(plugins, 'generateCode')
    : null;
  const lexBridge = plugins.length
    ? buildLexPluginBridge(plugins)
    : { methods: [], step: undefined };

  const hasPreLex = plugins.length > 0 && hasPluginHook(plugins, 'preLex');
  const hasPostLex = plugins.length > 0 && hasPluginHook(plugins, 'postLex');
  const hasPreParse = plugins.length > 0 && hasPluginHook(plugins, 'preParse');
  const hasPostParse = plugins.length > 0 && hasPluginHook(plugins, 'postParse');
  const hasPreLoad = plugins.length > 0 && hasPluginHook(plugins, 'preLoad');
  const hasPostLoad = plugins.length > 0 && hasPluginHook(plugins, 'postLoad');
  const hasPreFilters = plugins.length > 0 && hasPluginHook(plugins, 'preFilters');
  const hasPostFilters = plugins.length > 0 && hasPluginHook(plugins, 'postFilters');
  const hasPreLink = plugins.length > 0 && hasPluginHook(plugins, 'preLink');
  const hasPostLink = plugins.length > 0 && hasPluginHook(plugins, 'postLink');
  const hasPreCodeGen = plugins.length > 0 && hasPluginHook(plugins, 'preCodeGen');
  const hasPostCodeGen = plugins.length > 0 && hasPluginHook(plugins, 'postCodeGen');

  function fileOpts(filename, src) {
    const o = Object.assign({}, options);
    if (filename !== null && filename !== undefined) o.filename = filename;
    if (src !== null && src !== undefined) o.src = src;
    return o;
  }

  const hostCallbacks = {
    warn: defaultWarn,
    filter: filterCallback,
  };

  if (lexBridge.step) {
    hostCallbacks.lexPluginStep = lexBridge.step;
  }
  if (hasPreLex) {
    hostCallbacks.preLex = function(s, filename) {
      return applyPlugins(
        s,
        {
          filename:
            filename === null || filename === undefined
              ? options.filename
              : filename,
        },
        plugins,
        'preLex'
      );
    };
  }
  if (hasPostLex) {
    hostCallbacks.postLex = function(tokens, filename, src) {
      return applyPlugins(tokens, fileOpts(filename, src), plugins, 'postLex');
    };
  }
  if (hasPreParse) {
    hostCallbacks.preParse = function(tokens, filename, src) {
      return applyPlugins(tokens, fileOpts(filename, src), plugins, 'preParse');
    };
  }
  if (hasPostParse) {
    hostCallbacks.postParse = function(ast, filename, src) {
      return dehydrateAstBuffers(
        applyPlugins(
          reviveAstBuffers(ast),
          fileOpts(filename, src),
          plugins,
          'postParse'
        )
      );
    };
  }
  if (hasPreLoad) {
    hostCallbacks.preLoad = function(ast, filename, src) {
      return dehydrateAstBuffers(
        applyPlugins(
          reviveAstBuffers(ast),
          fileOpts(filename, src),
          plugins,
          'preLoad'
        )
      );
    };
  }
  if (customResolve) {
    hostCallbacks.resolve = function(targetPath, source, nodeFilename, nodeLine) {
      try {
        return String(customResolve(targetPath, source, options));
      } catch (ex) {
        if (ex && typeof ex === 'object' && 'message' in ex) {
          ex.message += '\n    at ' + nodeFilename + ' line ' + nodeLine;
        }
        throw ex;
      }
    };
  }
  if (customRead) {
    hostCallbacks.read = function(fullPath, nodeFilename, nodeLine) {
      try {
        const contents = customRead(fullPath, options);
        if (Buffer.isBuffer(contents) || typeof contents === 'string') {
          return contents;
        }
        return contents.toString('utf8');
      } catch (ex) {
        if (ex && typeof ex === 'object' && 'message' in ex) {
          ex.message += '\n    at ' + nodeFilename + ' line ' + nodeLine;
        }
        throw ex;
      }
    };
  }
  if (hasPostLoad) {
    hostCallbacks.postLoad = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'postLoad')
      );
    };
  }
  if (hasPreFilters) {
    hostCallbacks.preFilters = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'preFilters')
      );
    };
  }
  if (hasPostFilters) {
    hostCallbacks.postFilters = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'postFilters')
      );
    };
  }
  if (hasPreLink) {
    hostCallbacks.preLink = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'preLink')
      );
    };
  }
  if (hasPostLink) {
    hostCallbacks.postLink = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'postLink')
      );
    };
  }
  if (hasPreCodeGen) {
    hostCallbacks.preCodeGen = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'preCodeGen')
      );
    };
  }
  if (customGenerateCode) {
    hostCallbacks.generateCode = function(ast) {
      return customGenerateCode(reviveAstBuffers(ast), {
        pretty: normalizePretty(options.pretty),
        compileDebug: options.compileDebug,
        doctype: options.doctype,
        inlineRuntimeFunctions: options.inlineRuntimeFunctions,
        globals: options.globals,
        self: options.self,
        includeSources: options.includeSources,
        templateName: options.templateName,
      });
    };
  }
  if (hasPostCodeGen) {
    hostCallbacks.postCodeGen = function(js) {
      return applyPlugins(js, options, plugins, 'postCodeGen');
    };
  }

  const outcome = native.compileBodySync(
    str,
    {
      filename: options.filename,
      basedir: options.basedir,
      pretty: normalizePretty(options.pretty),
      compileDebug: options.compileDebug !== false,
      doctype: options.doctype,
      inlineRuntimeFunctions: Boolean(options.inlineRuntimeFunctions),
      globals: Array.isArray(options.globals) ? options.globals : [],
      useSelf: Boolean(options.self),
      includeSources: Boolean(options.includeSources),
      templateName: options.templateName || 'template',
      filterOptions: options.filterOptions || null,
      filterAliases: options.filterAliases || undefined,
      lexPluginMethods: lexBridge.methods,
      nativePlugins: resolveNativePlugins(options.plugins || options.nativePlugins),
    },
    hostCallbacks,
    options.templateStore || undefined
  );

  if (!outcome.ok && outcome.plainError) {
    const err = new Error(outcome.plainError);
    if (outcome.plainErrorCode) {
      err.code = outcome.plainErrorCode;
    }
    throw err;
  }
  if (!outcome.ok && outcome.error) {
    const dto = outcome.error;
    const err = new Error(dto.message);
    err.code = dto.code;
    err.msg = dto.msg;
    err.line = dto.line;
    err.column = dto.column === null ? undefined : dto.column;
    err.filename = dto.filename === null ? undefined : dto.filename;
    err.src = dto.src === null ? undefined : dto.src;
    err.toJSON = function() {
      return {
        code: this.code,
        msg: this.msg,
        line: this.line,
        column: this.column,
        filename: this.filename,
      };
    };
    throw err;
  }

  const js = outcome.body;
  if (options.debug) {
    console.error(
      '\nCompiled Function:\n\n\u001b[90m%s\u001b[0m',
      js.replace(/^/gm, '  ')
    );
  }

  return {
    body: js,
    dependencies: outcome.dependencies || [],
  };
}

function handleTemplateCache(options, str) {
  const key = options.filename;
  if (options.cache && cache[key]) {
    return cache[key];
  } else {
    if (str === undefined) str = fs.readFileSync(options.filename, 'utf8');
    const templ = compile(str, options);
    if (options.cache) cache[key] = templ;
    return templ;
  }
}

export function compile(str, options) {
  options = options || {};
  str = String(str);

  const parsed = compileBody(str, {
    compileDebug: options.compileDebug !== false,
    filename: options.filename,
    basedir: options.basedir,
    pretty: normalizePretty(options.pretty),
    doctype: options.doctype,
    inlineRuntimeFunctions: options.inlineRuntimeFunctions,
    globals: options.globals,
    self: options.self,
    includeSources: options.compileDebug === true,
    debug: options.debug,
    templateName: 'template',
    filters: options.filters,
    filterOptions: options.filterOptions,
    filterAliases: options.filterAliases,
    filterExecutor: options.filterExecutor,
    plugins: options.plugins,
    templateStore: options.templateStore,
  });

  const res = options.inlineRuntimeFunctions
    ? new Function('', parsed.body + ';return template;')()
    : runtimeWrap(parsed.body);

  res.dependencies = parsed.dependencies;
  return res;
}

export function compileClientWithDependenciesTracked(str, options) {
  options = options || {};
  str = String(str);

  const parsed = compileBody(str, {
    compileDebug: options.compileDebug,
    filename: options.filename,
    basedir: options.basedir,
    pretty: normalizePretty(options.pretty),
    doctype: options.doctype,
    inlineRuntimeFunctions: options.inlineRuntimeFunctions !== false,
    globals: options.globals,
    self: options.self,
    includeSources: options.compileDebug,
    debug: options.debug,
    templateName: options.name || 'template',
    filters: options.filters,
    filterOptions: options.filterOptions,
    filterAliases: options.filterAliases,
    filterExecutor: options.filterExecutor,
    plugins: options.plugins,
    templateStore: options.templateStore,
  });

  let body = parsed.body;
  if (options.module) {
    if (options.inlineRuntimeFunctions === false) {
      body = 'var pug = require("pug-runtime");' + body;
    }
    body += ' module.exports = ' + (options.name || 'template') + ';';
  }

  return { body: body, dependencies: parsed.dependencies };
}

export function compileClient(str, options) {
  return compileClientWithDependenciesTracked(str, options).body;
}

export function compileFile(path, options) {
  options = options || {};
  options.filename = path;
  return handleTemplateCache(options);
}

export function render(str, options, fn) {
  if ('function' === typeof options) {
    fn = options;
    options = undefined;
  }
  if (typeof fn === 'function') {
    let res;
    try {
      res = render(str, options);
    } catch (ex) {
      return fn(ex);
    }
    return fn(null, res);
  }

  options = options || {};
  if (options.cache && !options.filename) {
    throw new Error('the "filename" option is required for caching');
  }

  return handleTemplateCache(options, str)(options);
}

export function renderFile(path, options, fn) {
  if ('function' === typeof options) {
    fn = options;
    options = undefined;
  }
  if (typeof fn === 'function') {
    let res;
    try {
      res = renderFile(path, options);
    } catch (ex) {
      return fn(ex);
    }
    return fn(null, res);
  }

  options = options || {};
  options.filename = path;
  return handleTemplateCache(options)(options);
}

export function compileFileClient(path, options) {
  const key = path + ':client';
  options = options || {};
  options.filename = path;

  if (options.cache && cache[key]) {
    return cache[key];
  }

  const str = fs.readFileSync(options.filename, 'utf8');
  const out = compileClient(str, options);
  if (options.cache) cache[key] = out;
  return out;
}

export function __express(path, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  options = options || {};
  if (
    options.compileDebug == undefined &&
    process.env.NODE_ENV === 'production'
  ) {
    options.compileDebug = false;
  }
  renderFile(path, options, fn);
}

export function getLastProfileJson() {
  return typeof native.getLastProfileJson === 'function'
    ? native.getLastProfileJson()
    : null;
}

export function createTemplateStore() {
  return new native.NativeTemplateStore();
}

export function clearDefaultTemplateStore() {
  if (typeof native.clearDefaultTemplateStore === 'function') {
    native.clearDefaultTemplateStore();
  }
}

export function defaultTemplateStoreStats() {
  return typeof native.defaultTemplateStoreStats === 'function'
    ? native.defaultTemplateStoreStats()
    : null;
}

export function resolveNativePluginPath(plugin) {
  if (typeof plugin === 'string') {
    if (fs.existsSync(plugin)) {
      return path.resolve(plugin);
    }
    const candidates = [
      plugin,
      path.join(plugin, 'pug_filter_uppercase.dll'),
      path.join(plugin, 'native/win32-x64/pug_filter_uppercase.dll'),
      path.join(plugin, 'target/debug/pug_filter_uppercase.dll'),
      path.join(plugin, 'target/release/pug_filter_uppercase.dll'),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) return path.resolve(cand);
    }
    try {
      const resolved = require.resolve(plugin);
      if (fs.existsSync(resolved)) return path.resolve(resolved);
    } catch (_) {}
    return path.resolve(plugin);
  }
  if (plugin && typeof plugin === 'object') {
    if (plugin.nativePath && fs.existsSync(plugin.nativePath)) {
      return path.resolve(plugin.nativePath);
    }
    if (typeof plugin.path === 'string' && fs.existsSync(plugin.path)) {
      return path.resolve(plugin.path);
    }
  }
  return null;
}

export function resolveNativePlugins(plugins) {
  if (!Array.isArray(plugins)) return [];
  const out = [];
  for (const p of plugins) {
    const resolved = resolveNativePluginPath(p);
    if (resolved) {
      out.push(resolved);
    }
  }
  return out;
}

function toNapiCompileOptions(options = {}) {
  return {
    compileDebug: options.compileDebug !== false,
    filename: options.filename,
    basedir: options.basedir,
    pretty: normalizePretty(options.pretty),
    doctype: options.doctype,
    inlineRuntimeFunctions: Boolean(options.inlineRuntimeFunctions),
    globals: Array.isArray(options.globals) ? options.globals : [],
    useSelf: Boolean(options.self),
    includeSources: options.compileDebug === true,
    templateName: options.templateName || 'template',
    filterOptions:
      options.filterOptions !== undefined ? options.filterOptions : null,
    filterAliases: options.filterAliases || {},
    nativePlugins: resolveNativePlugins(options.plugins || options.nativePlugins),
  };
}

function hasHostCustomizations(options) {
  if (!options) return false;
  if (
    Array.isArray(options.plugins) &&
    options.plugins.some((p) => {
      if (typeof p === 'string') return false;
      if (p && typeof p === 'object' && p.nativePath) return false;
      return (
        typeof p === 'object' &&
        (p.postLoad ||
          p.preFilters ||
          p.postFilters ||
          p.preLink ||
          p.postLink ||
          p.preCodeGen ||
          p.postCodeGen ||
          p.lex)
      );
    })
  ) {
    return true;
  }
  if (options.filters && Object.keys(options.filters).length > 0) return true;
  return false;
}

function normalizeBatchEntries(entries) {
  return entries.map((entry, idx) => {
    if (typeof entry === 'string') {
      return { id: entry, filename: entry };
    }
    const filename = entry.filename;
    const id = entry.id || filename || `entry_${idx}`;
    const out = {
      id,
      filename,
      source: entry.source,
    };
    if (entry.options) {
      out.options = toNapiCompileOptions(entry.options);
    }
    return out;
  });
}

function batchResultToError(r) {
  if (r.error) {
    return dtoToJsError(r.error);
  }
  const err = new Error(r.plainError || 'Unknown batch compilation error');
  if (r.plainErrorCode) {
    err.code = r.plainErrorCode;
  }
  return err;
}

function wrapBatchResults(rawResults, defaultOptions, compileOpts = {}) {
  const wrap = compileOpts.wrap !== false;
  const throwOnError = compileOpts.throwOnError !== false;
  const inlineDefault = Boolean(defaultOptions && defaultOptions.inlineRuntimeFunctions);
  const fnCache = compileOpts.fnCache || null;

  return rawResults.map((r, idx) => {
    if (!r.ok) {
      const err = batchResultToError(r);
      if (throwOnError) {
        throw err;
      }
      return { id: r.id, ok: false, error: err, dependencies: [] };
    }
    if (!wrap) {
      return {
        id: r.id,
        ok: true,
        body: r.body,
        dependencies: r.dependencies || [],
        cacheHit: Boolean(r.cacheHit),
      };
    }
    const entryOpts = compileOpts.entries && compileOpts.entries[idx] && compileOpts.entries[idx].options;
    const inline =
      entryOpts && entryOpts.inlineRuntimeFunctions !== undefined
        ? Boolean(entryOpts.inlineRuntimeFunctions)
        : inlineDefault;
    if (fnCache && r.cacheHit) {
      const cached = fnCache.get(r.id);
      if (cached && cached.inline === inline && cached.body === r.body) {
        return cached.result;
      }
    }
    const fn = inline
      ? new Function('', r.body + ';return template;')()
      : runtimeWrap(r.body);
    fn.dependencies = r.dependencies || [];
    const result = {
      id: r.id,
      ok: true,
      fn,
      body: r.body,
      dependencies: fn.dependencies,
      cacheHit: Boolean(r.cacheHit),
    };
    if (fnCache) {
      fnCache.set(r.id, {
        inline,
        body: r.body,
        result: { ...result, cacheHit: true },
      });
    }
    return result;
  });
}

function normalizeVirtualFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) {
    return files.map((f) => ({ path: String(f.path), source: String(f.source) }));
  }
  if (files instanceof Map) {
    return Array.from(files.entries(), ([p, s]) => ({
      path: String(p),
      source: String(s),
    }));
  }
  return Object.entries(files).map(([p, s]) => ({
    path: String(p),
    source: String(s),
  }));
}

export function createCompiler(defaultOptions = {}) {
  const optsCopy = { ...defaultOptions };
  const session = new native.NativeCompilerSession(
    toNapiCompileOptions(optsCopy),
    optsCopy.templateStore || undefined
  );
  const fnCache = new Map();
  let disposed = false;

  function assertAlive() {
    if (disposed) {
      throw new Error('CompilerSession has been disposed');
    }
  }

  return {
    updateFiles(files) {
      assertAlive();
      return session.updateFiles(normalizeVirtualFiles(files));
    },
    invalidateFiles(paths) {
      assertAlive();
      const list = Array.isArray(paths) ? paths : [paths];
      return session.invalidateFiles(list.map(String));
    },
    removeFiles(paths) {
      assertAlive();
      const list = (Array.isArray(paths) ? paths : [paths]).map(String);
      const normSet = new Set(list.map((p) => path.resolve(p).toLowerCase()));
      for (const key of fnCache.keys()) {
        if (list.includes(key) || normSet.has(path.resolve(String(key)).toLowerCase())) {
          fnCache.delete(key);
        }
      }
      return session.removeFiles(list);
    },
    getAffectedEntries() {
      assertAlive();
      return session.getAffectedEntries();
    },
    compileAffected(compileOpts = {}) {
      assertAlive();
      if (session.getAffectedEntries().length === 0) {
        return [];
      }
      const parallelBool =
        typeof compileOpts.parallel === 'boolean' ? compileOpts.parallel : undefined;
      const parallelThreshold =
        typeof compileOpts.parallel === 'number'
          ? compileOpts.parallel
          : compileOpts.parallelThreshold;
      const rawResults = session.compileAffected(parallelBool, parallelThreshold);
      return wrapBatchResults(rawResults, optsCopy, { ...compileOpts, fnCache });
    },
    clear() {
      assertAlive();
      fnCache.clear();
      session.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      fnCache.clear();
      session.dispose();
    },
    get isDisposed() {
      return disposed;
    },
    stats() {
      const s = session.stats();
      return {
        ...s,
        fnCache: fnCache.size,
      };
    },
    compileBatch(entries, compileOpts = {}) {
      return this.compileEntries(entries, compileOpts);
    },
    compileEntries(entries, compileOpts = {}) {
      assertAlive();
      if (
        hasHostCustomizations(optsCopy) ||
        entries.some((e) => typeof e === 'object' && hasHostCustomizations(e.options))
      ) {
        const out = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const isStr = typeof e === 'string';
          const filename = isStr ? e : e.filename;
          const id = isStr ? e : e.id || filename || `entry_${i}`;
          const mergedOpts = isStr ? { ...optsCopy, filename } : { ...optsCopy, ...e.options, filename };
          const src = isStr || e.source === undefined ? fs.readFileSync(filename, 'utf8') : e.source;
          const fn = compile(src, mergedOpts);
          out.push({ id, ok: true, fn, dependencies: fn.dependencies || [] });
        }
        return out;
      }

      const normalized = normalizeBatchEntries(entries);
      const parallelBool =
        typeof compileOpts.parallel === 'boolean' ? compileOpts.parallel : undefined;
      const parallelThreshold =
        typeof compileOpts.parallel === 'number'
          ? compileOpts.parallel
          : compileOpts.parallelThreshold;
      const rawResults = session.compileEntries(
        normalized,
        parallelBool,
        parallelThreshold
      );
      return wrapBatchResults(rawResults, optsCopy, {
        ...compileOpts,
        entries,
        fnCache,
      });
    },
  };
}

export function compileBatch(entries, defaultOptions = {}, compileOpts = {}) {
  if (
    hasHostCustomizations(defaultOptions) ||
    entries.some((e) => typeof e === 'object' && hasHostCustomizations(e.options))
  ) {
    return entries.map((e, i) => {
      const isStr = typeof e === 'string';
      const filename = isStr ? e : e.filename;
      const id = isStr ? e : e.id || filename || `entry_${i}`;
      const mergedOpts = isStr
        ? { ...defaultOptions, filename }
        : { ...defaultOptions, ...e.options, filename };
      const src =
        isStr || e.source === undefined
          ? fs.readFileSync(filename, 'utf8')
          : e.source;
      const fn = compile(src, mergedOpts);
      return { id, ok: true, fn, dependencies: fn.dependencies || [] };
    });
  }

  const normalized = normalizeBatchEntries(entries);
  const parallelBool =
    typeof compileOpts.parallel === 'boolean' ? compileOpts.parallel : undefined;
  const parallelThreshold =
    typeof compileOpts.parallel === 'number'
      ? compileOpts.parallel
      : compileOpts.parallelThreshold;
  const rawResults = native.compileBatchSync(
    normalized,
    toNapiCompileOptions(defaultOptions),
    defaultOptions.templateStore || undefined,
    parallelBool,
    parallelThreshold
  );
  return wrapBatchResults(rawResults, defaultOptions, {
    ...compileOpts,
    entries,
  });
}

export default {
  name,
  runtime,
  cache,
  filters,
  _error: makeError,
  _runtimeBuild,
  _runtimeBuildJs: runtimeBuild,
  _lex: lex,
  lex,
  _stripComments: stripComments,
  stripComments,
  _parse: parse,
  parse,
  _load: load,
  _walk: walkAST,
  walk: walkAST,
  _addWith,
  _handleFilters,
  _link,
  _compileAttrs,
  _getLastProfileJson: getLastProfileJson,
  createTemplateStore,
  clearDefaultTemplateStore,
  defaultTemplateStoreStats,
  createCompiler,
  compileBatch,
  compile,
  compileClientWithDependenciesTracked,
  compileClient,
  compileFile,
  render,
  renderFile,
  compileFileClient,
  __express,
};
