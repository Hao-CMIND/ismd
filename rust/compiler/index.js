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
  const outcome = native.lexSync(str, {
    filename: options.filename,
    interpolated: Boolean(options.interpolated),
    startingLine:
      options.startingLine === undefined ? undefined : Number(options.startingLine),
    startingColumn:
      options.startingColumn === undefined ? undefined : Number(options.startingColumn),
  });
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
  const outcome = native.parseSync(tokens, {
    filename: options.filename,
    src: options.src,
  });
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

function requireFilterDep(name) {
  try {
    return require(name);
  } catch (_) {
    return require(path.join(__dirname, '../../raw/compiler/node_modules', name));
  }
}

function runJstransformerFilter(name, str, options, currentDirectory, funcName) {
  funcName = funcName || 'render';
  const resolveMod = requireFilterDep('resolve');
  const jstransformer = requireFilterDep('jstransformer');
  let trPath;
  try {
    try {
      trPath = resolveMod.sync('jstransformer-' + name, {
        basedir: currentDirectory || process.cwd(),
      });
    } catch (_) {
      try {
        trPath = require.resolve('jstransformer-' + name);
      } catch (_2) {
        trPath = require.resolve('jstransformer-' + name, {
          paths: [path.join(__dirname, '../../raw/compiler/node_modules')],
        });
      }
    }
  } catch (_) {
    return {
      ok: false,
      unknownFilter: 'unknown filter ":' + name + '"',
    };
  }
  const tr = jstransformer(require(trPath));
  let result = tr[funcName](str, options, options).body;
  if (options && options.minify) {
    const minifyName =
      tr.outputFormat === 'js'
        ? 'uglify-js'
        : tr.outputFormat === 'css'
          ? 'clean-css'
          : null;
    if (minifyName) {
      try {
        const minRes = runJstransformerFilter(
          minifyName,
          result,
          null,
          currentDirectory,
          'render'
        );
        if (minRes.ok) {
          result = minRes.value;
        }
      } catch (_) {}
    }
  }
  if (typeof result !== 'string') {
    throw new TypeError(
      'Expected filter ":' + name + '" to return a string, got ' + typeof result
    );
  }
  return { ok: true, value: result };
}

function makeFilterHostCallback(filtersSet) {
  return function(filterName, mode, text, fullPath, rawVal, attrsObj, dir) {
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
    return runJstransformerFilter(
      filterName,
      mode === 'rawFile' ? fullPath : text,
      attrsObj,
      dir,
      mode === 'rawFile' ? 'renderFile' : 'render'
    );
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

function compileBody(str, options) {
  const plugins = options.plugins || [];
  const filtersSet = {};
  Object.keys(filters).forEach(function(key) {
    filtersSet[key] = filters[key];
  });
  if (options.filters) {
    Object.keys(options.filters).forEach(function(key) {
      filtersSet[key] = options.filters[key];
    });
  }

  const customResolve = findReplacementFunc(plugins, 'resolve');
  const customRead = findReplacementFunc(plugins, 'read');
  const customGenerateCode = findReplacementFunc(plugins, 'generateCode');

  function fileOpts(filename, src) {
    const o = Object.assign({}, options);
    if (filename !== null && filename !== undefined) o.filename = filename;
    if (src !== null && src !== undefined) o.src = src;
    return o;
  }

  const hostCallbacks = {
    preLex: function(s, filename) {
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
    },
    postLex: function(tokens, filename, src) {
      return applyPlugins(tokens, fileOpts(filename, src), plugins, 'postLex');
    },
    preParse: function(tokens, filename, src) {
      return applyPlugins(tokens, fileOpts(filename, src), plugins, 'preParse');
    },
    postParse: function(ast, filename, src) {
      return dehydrateAstBuffers(
        applyPlugins(
          reviveAstBuffers(ast),
          fileOpts(filename, src),
          plugins,
          'postParse'
        )
      );
    },
    preLoad: function(ast, filename, src) {
      return dehydrateAstBuffers(
        applyPlugins(
          reviveAstBuffers(ast),
          fileOpts(filename, src),
          plugins,
          'preLoad'
        )
      );
    },
    resolve: customResolve
      ? function(targetPath, source, nodeFilename, nodeLine) {
          try {
            return String(customResolve(targetPath, source, options));
          } catch (ex) {
            if (ex && typeof ex === 'object' && 'message' in ex) {
              ex.message += '\n    at ' + nodeFilename + ' line ' + nodeLine;
            }
            throw ex;
          }
        }
      : undefined,
    read: function(fullPath, nodeFilename, nodeLine) {
      try {
        const contents = customRead
          ? customRead(fullPath, options)
          : fs.readFileSync(fullPath);
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
    },
    postLoad: function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'postLoad')
      );
    },
    preFilters: function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'preFilters')
      );
    },
    filter: makeFilterHostCallback(filtersSet),
    postFilters: function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'postFilters')
      );
    },
    preLink: function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'preLink')
      );
    },
    postLink: function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'postLink')
      );
    },
    preCodeGen: function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'preCodeGen')
      );
    },
    generateCode: customGenerateCode
      ? function(ast) {
          return customGenerateCode(reviveAstBuffers(ast), {
            pretty: options.pretty,
            compileDebug: options.compileDebug,
            doctype: options.doctype,
            inlineRuntimeFunctions: options.inlineRuntimeFunctions,
            globals: options.globals,
            self: options.self,
            includeSources: options.includeSources,
            templateName: options.templateName,
          });
        }
      : undefined,
    postCodeGen: function(js) {
      return applyPlugins(js, options, plugins, 'postCodeGen');
    },
  };

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
    },
    hostCallbacks
  );

  if (!outcome.ok && outcome.plainError) {
    throw new Error(outcome.plainError);
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
    pretty: options.pretty,
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
    plugins: options.plugins,
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
    pretty: options.pretty,
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
    plugins: options.plugins,
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
  if (
    options.compileDebug == undefined &&
    process.env.NODE_ENV === 'production'
  ) {
    options.compileDebug = false;
  }
  renderFile(path, options, fn);
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
  compile,
  compileClientWithDependenciesTracked,
  compileClient,
  compileFile,
  render,
  renderFile,
  compileFileClient,
  __express,
};
