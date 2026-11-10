'use strict';

const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');
const runtimeWrap = require('./runtime/wrap');
const runtimeBuild = require('./runtime/build');

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

exports.name = 'Pug';
exports.runtime = runtime;
exports.cache = {};
exports.filters = {};

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

exports._error = makeError;
exports._runtimeBuild = function(fns) {
  return native.runtimeBuild(fns);
};
exports._runtimeBuildJs = runtimeBuild;

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
  if (!outcome.ok && outcome.error) {
    throw dtoToJsError(outcome.error);
  }
  return outcome.data;
}

exports._lex = lex;
exports.lex = lex;
exports._stripComments = stripComments;
exports.stripComments = stripComments;

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
  Object.keys(exports.filters).forEach(function(key) {
    filtersSet[key] = exports.filters[key];
  });
  if (options.filters) {
    Object.keys(options.filters).forEach(function(key) {
      filtersSet[key] = options.filters[key];
    });
  }

  const customGenerateCode = findReplacementFunc(plugins, 'generateCode');

  const hostCallbacks = {
    preLex: function(s) {
      return applyPlugins(
        s,
        { filename: options.filename },
        plugins,
        'preLex'
      );
    },
    postLex: function(tokens) {
      return applyPlugins(tokens, options, plugins, 'postLex');
    },
    preParse: function(tokens) {
      return applyPlugins(tokens, options, plugins, 'preParse');
    },
    postParse: function(ast) {
      return applyPlugins(ast, options, plugins, 'postParse');
    },
    preLoad: function(ast) {
      return applyPlugins(ast, options, plugins, 'preLoad');
    },
    postLoad: function(ast) {
      return applyPlugins(ast, options, plugins, 'postLoad');
    },
    preFilters: function(ast) {
      return applyPlugins(ast, options, plugins, 'preFilters');
    },
    filter: function(name, text, filterAttrs) {
      const mergedOpts = Object.assign(
        {},
        options.filterOptions && options.filterOptions[name],
        filterAttrs
      );
      const targetName =
        (options.filterAliases && options.filterAliases[name]) || name;
      if (typeof filtersSet[name] === 'function') {
        return String(filtersSet[name](text, mergedOpts));
      }
      if (typeof filtersSet[targetName] === 'function') {
        return String(filtersSet[targetName](text, mergedOpts));
      }
      throw makeError('UNKNOWN_FILTER', 'unknown filter ":' + name + '"', {
        line: 1,
        filename: options.filename,
        src: str,
      });
    },
    postFilters: function(ast) {
      return applyPlugins(ast, options, plugins, 'postFilters');
    },
    preLink: function(ast) {
      return applyPlugins(ast, options, plugins, 'preLink');
    },
    postLink: function(ast) {
      return applyPlugins(ast, options, plugins, 'postLink');
    },
    preCodeGen: function(ast) {
      return applyPlugins(ast, options, plugins, 'preCodeGen');
    },
    generateCode: customGenerateCode
      ? function(ast) {
          return customGenerateCode(ast, {
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
      compileDebug: Boolean(options.compileDebug),
      doctype: options.doctype,
      inlineRuntimeFunctions: Boolean(options.inlineRuntimeFunctions),
      globals: Array.isArray(options.globals) ? options.globals : [],
      useSelf: Boolean(options.self),
      includeSources: Boolean(options.includeSources),
      templateName: options.templateName || 'template',
    },
    hostCallbacks
  );

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
  if (options.cache && exports.cache[key]) {
    return exports.cache[key];
  } else {
    if (str === undefined) str = fs.readFileSync(options.filename, 'utf8');
    const templ = exports.compile(str, options);
    if (options.cache) exports.cache[key] = templ;
    return templ;
  }
}

exports.compile = function(str, options) {
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
};

exports.compileClientWithDependenciesTracked = function(str, options) {
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
};

exports.compileClient = function(str, options) {
  return exports.compileClientWithDependenciesTracked(str, options).body;
};

exports.compileFile = function(path, options) {
  options = options || {};
  options.filename = path;
  return handleTemplateCache(options);
};

exports.render = function(str, options, fn) {
  if ('function' === typeof options) {
    fn = options;
    options = undefined;
  }
  if (typeof fn === 'function') {
    let res;
    try {
      res = exports.render(str, options);
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
};

exports.renderFile = function(path, options, fn) {
  if ('function' === typeof options) {
    fn = options;
    options = undefined;
  }
  if (typeof fn === 'function') {
    let res;
    try {
      res = exports.renderFile(path, options);
    } catch (ex) {
      return fn(ex);
    }
    return fn(null, res);
  }

  options = options || {};
  options.filename = path;
  return handleTemplateCache(options)(options);
};

exports.compileFileClient = function(path, options) {
  const key = path + ':client';
  options = options || {};
  options.filename = path;

  if (options.cache && exports.cache[key]) {
    return exports.cache[key];
  }

  const str = fs.readFileSync(options.filename, 'utf8');
  const out = exports.compileClient(str, options);
  if (options.cache) exports.cache[key] = out;
  return out;
};

exports.__express = function(path, options, fn) {
  if (
    options.compileDebug == undefined &&
    process.env.NODE_ENV === 'production'
  ) {
    options.compileDebug = false;
  }
  exports.renderFile(path, options, fn);
};
