import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from './runtime/index.mjs';
import runtimeWrap from './runtime/wrap.mjs';
import runtimeBuild from './runtime/build.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function loadNativeAddon() {
  if (process.env.ISMD_PROFILE === '1' && process.env.ISMD_PROFILE_ADDON) {
    const profileAddon = path.resolve(process.env.ISMD_PROFILE_ADDON);
    if (!fs.existsSync(profileAddon)) {
      throw new Error(`ISMD_PROFILE_ADDON not found: ${profileAddon}`);
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
  const rootNodePath = path.join(__dirname, 'ismd-napi.win32-x64-msvc.node');
  const candidates = [
    rootNodePath,
    path.join(__dirname, 'target/release/ismd_napi.dll'),
    path.join(__dirname, 'target/debug/ismd_napi.dll'),
  ];
  let newest = null;
  let newestMtime = -1;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const mtime = fs.statSync(candidate).mtimeMs;
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newest = candidate;
    }
  }
  if (newest) {
    if (newest.endsWith('.dll')) {
      try {
        fs.copyFileSync(newest, rootNodePath);
        return require(rootNodePath);
      } catch (_) {
        const siblingNode = newest.slice(0, -4) + '.node';
        if (!fs.existsSync(siblingNode) || newestMtime > fs.statSync(siblingNode).mtimeMs) {
          fs.copyFileSync(newest, siblingNode);
        }
        return require(siblingNode);
      }
    }
    return require(newest);
  }
  throw new Error(
    'ismd_napi native module not found. Run `cargo build -p ismd_napi` first.'
  );
}

const native = loadNativeAddon();

export const name = 'Pug';
export { runtime };
export const cache = Object.create(null);
const templateCacheMeta = new WeakMap();

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
  const includeDependencies = Boolean(options.includeDependencies);

  const userBefore = typeof before === 'function' ? before : null;
  const userAfter = typeof after === 'function' ? after : null;

  function makeReplace(arrayAllowed) {
    const replace = function replace(rep) {
      if (Array.isArray(rep) && !replace.arrayAllowed) {
        throw new Error(
          'replace() can only be called with an array if the last parent is a Block or NamedBlock'
        );
      }
      replace.replaced = true;
      replace.replacement = rep;
    };
    replace.arrayAllowed = arrayAllowed;
    replace.replaced = false;
    replace.replacement = undefined;
    return replace;
  }

  function walkAndMergeNodes(nodes) {
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const walked = walkNode(nodes[i]);
      if (Array.isArray(walked)) {
        for (let j = 0; j < walked.length; j++) {
          out.push(walked[j]);
        }
      } else {
        out.push(walked);
      }
    }
    return out;
  }

  function walkNode(node) {
    const beforeArrayAllowed = Boolean(
      parents[0] && (parents[0].type === 'Block' || parents[0].type === 'NamedBlock')
    );

    if (userBefore) {
      const replace = makeReplace(beforeArrayAllowed);
      const res = userBefore(node, replace);
      if (replace.replaced) {
        node = replace.replacement;
      }
      if (res === false) {
        return node;
      }
    }

    if (Array.isArray(node)) {
      return walkAndMergeNodes(node);
    }

    parents.unshift(node);
    try {
      switch (node.type) {
        case 'NamedBlock':
        case 'Block':
          node.nodes = walkAndMergeNodes(node.nodes || []);
          break;
        case 'Case':
        case 'Mixin':
        case 'Tag':
        case 'InterpolatedTag':
        case 'When':
        case 'Code':
        case 'While':
        case 'EachOf':
          if (node.block) {
            node.block = walkNode(node.block);
          }
          break;
        case 'Each':
          if (node.block) {
            node.block = walkNode(node.block);
          }
          if (node.alternate) {
            node.alternate = walkNode(node.alternate);
          }
          break;
        case 'Conditional':
          if (node.consequent) {
            node.consequent = walkNode(node.consequent);
          }
          if (node.alternate) {
            node.alternate = walkNode(node.alternate);
          }
          break;
        case 'Include':
          if (node.block) {
            node.block = walkNode(node.block);
          }
          if (node.file) {
            node.file = walkNode(node.file);
          }
          break;
        case 'Extends':
        case 'RawInclude':
          if (node.file) {
            node.file = walkNode(node.file);
          }
          break;
        case 'Attrs':
        case 'BlockComment':
        case 'Comment':
        case 'Doctype':
        case 'Extension':
        case 'MixinBlock':
        case 'YieldBlock':
        case 'Text':
          break;
        case 'FileReference':
          if (includeDependencies && node.ast) {
            node.ast = walkNode(node.ast);
          }
          break;
        default:
          throw new Error(`Unexpected node type ${node.type}`);
      }
    } finally {
      parents.shift();
    }

    if (userAfter) {
      const afterArrayAllowed = Boolean(
        parents[0] && (parents[0].type === 'Block' || parents[0].type === 'NamedBlock')
      );
      const replace = makeReplace(afterArrayAllowed);
      userAfter(node, replace);
      if (replace.replaced) {
        node = replace.replacement;
      }
    }

    return node;
  }

  return walkNode(ast);
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
      const v = val[k];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        continue;
      }
      if (k === 'raw' && val.type === 'FileReference' && Buffer.isBuffer(v)) {
        out.raw = { type: 'BufferBase64', data: v.toString('base64') };
      } else {
        out[k] = dehydrateAstBuffers(v);
      }
    }
    return out;
  }
  return val;
}

function load(ast, options) {
  options = getLoadOptions(options);
  const inputAst = dehydrateAstBuffers(ast);
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

export function _link(ast) {
  const inputAst = dehydrateAstBuffers(ast);
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
  const plugins = collectAllPlugins(options);
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
  const hasPreTransform = plugins.length > 0 && hasPluginHook(plugins, 'preTransform');
  const hasPostTransform = plugins.length > 0 && hasPluginHook(plugins, 'postTransform');
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
  if (hasPreTransform) {
    hostCallbacks.preTransform = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'preTransform')
      );
    };
  }
  if (hasPostTransform) {
    hostCallbacks.postTransform = function(ast) {
      return dehydrateAstBuffers(
        applyPlugins(reviveAstBuffers(ast), options, plugins, 'postTransform')
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
      lexPluginMethods: lexBridge.methods,
      nativePlugins: resolveNativePlugins(plugins),
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
  if (options.cache && Object.prototype.hasOwnProperty.call(cache, key) && cache[key]) {
    const cached = cache[key];
    const meta = templateCacheMeta.get(cached);
    if (!meta) {
      return cached;
    }
    const optsMatch =
      meta.pretty === options.pretty &&
      meta.compileDebug === options.compileDebug &&
      meta.doctype === options.doctype &&
      meta.self === options.self &&
      meta.inlineRuntimeFunctions === options.inlineRuntimeFunctions;
    if (optsMatch) {
      if (str !== undefined) {
        if (meta.str === str) return cached;
      } else {
        try {
          if (fs.statSync(key).mtimeMs === meta.mtimeMs) return cached;
        } catch (_) {
          return cached;
        }
      }
    }
  }
  let mtimeMs;
  if (str === undefined) {
    if (options.cache) {
      try {
        mtimeMs = fs.statSync(key).mtimeMs;
      } catch (_) {}
    }
    str = fs.readFileSync(key, 'utf8');
  }
  const templ = compile(str, options);
  if (options.cache) {
    templateCacheMeta.set(templ, {
      str,
      mtimeMs,
      pretty: options.pretty,
      compileDebug: options.compileDebug,
      doctype: options.doctype,
      self: options.self,
      inlineRuntimeFunctions: options.inlineRuntimeFunctions,
    });
    cache[key] = templ;
  }
  return templ;
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
    includeSources: resolveIncludeSources(options),
    debug: options.debug,
    templateName: 'template',
    plugins: options.plugins,
    nativePlugins: options.nativePlugins,
    templateStore: options.templateStore,
  });

  const res = options.inlineRuntimeFunctions
    ? new Function('', parsed.body + ';return template;')()
    : runtimeWrap(parsed.body);

  res.dependencies = parsed.dependencies;
  return res;
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

function collectAllPlugins(options) {
  if (!options) return [];
  const a = Array.isArray(options.plugins) ? options.plugins : [];
  const b = Array.isArray(options.nativePlugins) ? options.nativePlugins : [];
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return [...a, ...b];
}

export function resolveNativePluginPath(plugin) {
  if (typeof plugin === 'string') {
    if (fs.existsSync(plugin)) {
      return path.resolve(plugin);
    }
    try {
      const resolved = require.resolve(plugin);
      if (fs.existsSync(resolved)) return path.resolve(resolved);
    } catch (_) {}
    return path.resolve(plugin);
  }
  if (plugin && typeof plugin === 'object' && typeof plugin.nativePath === 'string' && plugin.nativePath) {
    if (fs.existsSync(plugin.nativePath)) {
      return path.resolve(plugin.nativePath);
    }
  }
  return null;
}

export function resolveNativePlugins(plugins) {
  if (!Array.isArray(plugins)) return [];
  const out = [];
  const seen = new Set();
  for (const p of plugins) {
    const resolved = resolveNativePluginPath(p);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function resolveIncludeSources(options = {}) {
  if (options.includeSources !== undefined) {
    return Boolean(options.includeSources);
  }
  if (options.inlineRuntimeFunctions) {
    return options.compileDebug !== false;
  }
  return options.compileDebug === true;
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
    includeSources: resolveIncludeSources(options),
    templateName: options.templateName || 'template',
    nativePlugins: resolveNativePlugins(collectAllPlugins(options)),
  };
}

const HOST_PLUGIN_HOOK_NAMES = [
  'lex',
  'preLex',
  'postLex',
  'preParse',
  'postParse',
  'preLoad',
  'postLoad',
  'resolve',
  'read',
  'preTransform',
  'postTransform',
  'preLink',
  'postLink',
  'preCodeGen',
  'postCodeGen',
  'generateCode',
];

function hasHostCustomizations(options) {
  const allPlugins = collectAllPlugins(options);
  return allPlugins.some((p) => {
    if (!p || typeof p !== 'object') return false;
    return HOST_PLUGIN_HOOK_NAMES.some((hook) => Boolean(p[hook]));
  });
}

function normalizeBatchEntries(entries, defaultOptions = {}) {
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
      out.options = toNapiCompileOptions({ ...defaultOptions, ...entry.options });
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
    const entryOpts =
      (compileOpts.entryOptionsMap && compileOpts.entryOptionsMap.get(r.id)) ||
      (compileOpts.entries && compileOpts.entries[idx] && compileOpts.entries[idx].options);
    const inline =
      entryOpts && entryOpts.inlineRuntimeFunctions !== undefined
        ? Boolean(entryOpts.inlineRuntimeFunctions)
        : inlineDefault;
    const templateName =
      (entryOpts && entryOpts.templateName) ||
      (defaultOptions && defaultOptions.templateName) ||
      'template';
    if (fnCache && r.cacheHit) {
      const cached = fnCache.get(r.id);
      if (
        cached &&
        cached.inline === inline &&
        cached.templateName === templateName &&
        cached.body === r.body
      ) {
        return cached.result;
      }
    }
    const fn = inline
      ? new Function('', `${r.body};return ${templateName};`)()
      : runtimeWrap(r.body, templateName);
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
        templateName,
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

function normalizeSessionPath(p) {
  return path.resolve(String(p)).toLowerCase();
}

function mergeUniqueStrings(a, b) {
  const out = Array.isArray(a) ? [...a] : [];
  const seen = new Set(out);
  for (const item of b || []) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function compileBatchFallbackEntry(e, i, baseOptions, compileOpts = {}, virtualFiles = null) {
  const wrap = compileOpts.wrap !== false;
  const throwOnError = compileOpts.throwOnError !== false;
  const isStr = typeof e === 'string';
  const filename = isStr ? e : e.filename;
  const id = isStr ? e : e.id || filename || `entry_${i}`;
  try {
    const mergedOpts = isStr
      ? { ...baseOptions, filename }
      : { ...baseOptions, ...e.options, filename };
    const normFilename = filename ? normalizeSessionPath(filename) : null;
    let src;
    if (!isStr && e.source !== undefined) {
      src = e.source;
    } else if (virtualFiles && normFilename && virtualFiles.has(normFilename)) {
      src = virtualFiles.get(normFilename);
    } else {
      src = fs.readFileSync(filename, 'utf8');
    }

    let effectivePlugins = mergedOpts.plugins;
    if (virtualFiles && virtualFiles.size > 0) {
      const pluginList = Array.isArray(effectivePlugins) ? effectivePlugins : [];
      const hasCustomRead = pluginList.some((p) => p && typeof p === 'object' && p.read);
      if (!hasCustomRead) {
        effectivePlugins = [
          ...pluginList,
          {
            read(fullPath) {
              const key = normalizeSessionPath(fullPath);
              if (virtualFiles.has(key)) {
                return virtualFiles.get(key);
              }
              return fs.readFileSync(fullPath);
            },
          },
        ];
      }
    }

    const templateName = mergedOpts.templateName || 'template';
    const parsed = compileBody(String(src), {
      compileDebug: mergedOpts.compileDebug !== false,
      filename: mergedOpts.filename,
      basedir: mergedOpts.basedir,
      pretty: normalizePretty(mergedOpts.pretty),
      doctype: mergedOpts.doctype,
      inlineRuntimeFunctions: mergedOpts.inlineRuntimeFunctions,
      globals: mergedOpts.globals,
      self: mergedOpts.self,
      includeSources: resolveIncludeSources(mergedOpts),
      debug: mergedOpts.debug,
      templateName,
      plugins: effectivePlugins,
      nativePlugins: mergedOpts.nativePlugins,
      templateStore: mergedOpts.templateStore,
    });

    if (!wrap) {
      return {
        id,
        ok: true,
        body: parsed.body,
        dependencies: parsed.dependencies || [],
        cacheHit: false,
      };
    }

    const fn = mergedOpts.inlineRuntimeFunctions
      ? new Function('', `${parsed.body};return ${templateName};`)()
      : runtimeWrap(parsed.body, templateName);
    fn.dependencies = parsed.dependencies || [];
    return {
      id,
      ok: true,
      fn,
      body: parsed.body,
      dependencies: fn.dependencies,
      cacheHit: false,
    };
  } catch (err) {
    if (throwOnError) {
      throw err;
    }
    return { id, ok: false, error: err, dependencies: [] };
  }
}

export function createCompiler(defaultOptions = {}) {
  const optsCopy = { ...defaultOptions };
  const session = new native.NativeCompilerSession(
    toNapiCompileOptions(optsCopy),
    optsCopy.templateStore || undefined
  );
  const fnCache = new Map();
  const entryOptionsMap = new Map();
  const virtualFiles = new Map();
  const fallbackEntries = new Map();
  const fallbackDirty = new Set();
  let disposed = false;

  function assertAlive() {
    if (disposed) {
      throw new Error('CompilerSession has been disposed');
    }
  }

  function markFallbackAffected(normPathSet) {
    const affected = [];
    if (fallbackEntries.size === 0 || normPathSet.size === 0) {
      return affected;
    }
    for (const [id, rec] of fallbackEntries.entries()) {
      let hit = rec.normFilename !== null && normPathSet.has(rec.normFilename);
      if (!hit) {
        for (const dep of rec.normDeps) {
          if (normPathSet.has(dep)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        fallbackDirty.add(id);
        affected.push(id);
      }
    }
    return affected;
  }

  function ensureFallbackEntry(e, i) {
    const isStr = typeof e === 'string';
    const filename = isStr ? e : e.filename;
    const id = isStr ? e : e.id || filename || `entry_${i}`;
    const normFilename = filename ? normalizeSessionPath(filename) : null;
    const prev = fallbackEntries.get(id);
    fallbackEntries.set(id, {
      entry: e,
      filename,
      normFilename,
      normDeps: prev ? prev.normDeps : new Set(),
    });
  }

  function recordFallbackEntry(e, i, res) {
    const isStr = typeof e === 'string';
    const filename = isStr ? e : e.filename;
    const id = isStr ? e : e.id || filename || `entry_${i}`;
    const normFilename = filename ? normalizeSessionPath(filename) : null;
    const prev = fallbackEntries.get(id);
    const normDeps =
      res.ok || !prev
        ? new Set((res.dependencies || []).map(normalizeSessionPath))
        : prev.normDeps;
    fallbackEntries.set(id, { entry: e, filename, normFilename, normDeps });
    fallbackDirty.delete(id);
  }

  return {
    updateFiles(files) {
      assertAlive();
      const normalized = normalizeVirtualFiles(files);
      const changedNormSet = new Set();
      const changedPaths = [];
      for (const { path: p, source } of normalized) {
        const key = normalizeSessionPath(p);
        let prevSource;
        if (virtualFiles.has(key)) {
          prevSource = virtualFiles.get(key);
        } else if (fallbackEntries.size > 0) {
          try {
            prevSource = fs.readFileSync(p, 'utf8');
          } catch (_) {
            prevSource = undefined;
          }
        }
        virtualFiles.set(key, source);
        if (prevSource !== source) {
          changedNormSet.add(key);
          changedPaths.push(p);
        }
      }
      const report = session.updateFiles(normalized);
      if (fallbackEntries.size === 0) {
        return report;
      }
      const fallbackAffected = markFallbackAffected(changedNormSet);
      if (fallbackAffected.length === 0 && changedPaths.length === 0) {
        return report;
      }
      return {
        ...report,
        changed: Boolean(report.changed) || changedPaths.length > 0 || fallbackAffected.length > 0,
        changedFiles: mergeUniqueStrings(report.changedFiles, changedPaths),
        invalidatedTemplates: mergeUniqueStrings(report.invalidatedTemplates, changedPaths),
        affectedEntries: mergeUniqueStrings(report.affectedEntries, fallbackAffected),
      };
    },
    invalidateFiles(paths) {
      assertAlive();
      const list = (Array.isArray(paths) ? paths : [paths]).map(String);
      const normSet = new Set();
      for (const p of list) {
        const key = normalizeSessionPath(p);
        normSet.add(key);
        virtualFiles.delete(key);
      }
      const report = session.invalidateFiles(list);
      if (fallbackEntries.size === 0) {
        return report;
      }
      const fallbackAffected = markFallbackAffected(normSet);
      if (fallbackAffected.length === 0) {
        return report;
      }
      return {
        ...report,
        changed: true,
        invalidatedTemplates: mergeUniqueStrings(report.invalidatedTemplates, list),
        affectedEntries: mergeUniqueStrings(report.affectedEntries, fallbackAffected),
      };
    },
    removeFiles(paths) {
      assertAlive();
      const list = (Array.isArray(paths) ? paths : [paths]).map(String);
      const normSet = new Set(list.map(normalizeSessionPath));
      for (const key of normSet) {
        virtualFiles.delete(key);
      }
      for (const key of fnCache.keys()) {
        if (list.includes(key) || normSet.has(normalizeSessionPath(key))) {
          fnCache.delete(key);
        }
      }
      for (const key of entryOptionsMap.keys()) {
        if (list.includes(key) || normSet.has(normalizeSessionPath(key))) {
          entryOptionsMap.delete(key);
        }
      }
      const removedIds = [];
      for (const [id, rec] of fallbackEntries.entries()) {
        if (
          list.includes(id) ||
          (rec.normFilename !== null && normSet.has(rec.normFilename))
        ) {
          removedIds.push(id);
        }
      }
      for (const id of removedIds) {
        fallbackEntries.delete(id);
        fallbackDirty.delete(id);
      }
      const fallbackAffected = markFallbackAffected(normSet);
      const report = session.removeFiles(list);
      if (fallbackAffected.length === 0) {
        return report;
      }
      return {
        ...report,
        changed: true,
        affectedEntries: mergeUniqueStrings(report.affectedEntries, fallbackAffected),
      };
    },
    getAffectedEntries() {
      assertAlive();
      const nativeAffected = session.getAffectedEntries();
      if (fallbackDirty.size === 0) {
        return nativeAffected;
      }
      return mergeUniqueStrings(nativeAffected, Array.from(fallbackDirty));
    },
    compileAffected(compileOpts = {}) {
      assertAlive();
      const nativeAffected = session.getAffectedEntries();
      const fallbackIds = Array.from(fallbackDirty);
      if (nativeAffected.length === 0 && fallbackIds.length === 0) {
        return [];
      }

      let nativeResults = [];
      if (nativeAffected.length > 0) {
        const parallelBool =
          typeof compileOpts.parallel === 'boolean' ? compileOpts.parallel : undefined;
        const parallelThreshold =
          typeof compileOpts.parallel === 'number'
            ? compileOpts.parallel
            : compileOpts.parallelThreshold;
        const rawResults = session.compileAffected(parallelBool, parallelThreshold);
        nativeResults = wrapBatchResults(rawResults, optsCopy, {
          ...compileOpts,
          fnCache,
          entryOptionsMap,
        });
      }

      const fallbackResults = [];
      for (let i = 0; i < fallbackIds.length; i++) {
        const id = fallbackIds[i];
        const rec = fallbackEntries.get(id);
        if (!rec) {
          fallbackDirty.delete(id);
          continue;
        }
        const res = compileBatchFallbackEntry(
          rec.entry,
          i,
          optsCopy,
          compileOpts,
          virtualFiles
        );
        recordFallbackEntry(rec.entry, i, res);
        fallbackResults.push(res);
      }

      return [...nativeResults, ...fallbackResults];
    },
    clear() {
      assertAlive();
      fnCache.clear();
      entryOptionsMap.clear();
      virtualFiles.clear();
      fallbackEntries.clear();
      fallbackDirty.clear();
      session.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      fnCache.clear();
      entryOptionsMap.clear();
      virtualFiles.clear();
      fallbackEntries.clear();
      fallbackDirty.clear();
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
        for (let i = 0; i < entries.length; i++) {
          ensureFallbackEntry(entries[i], i);
        }
        return entries.map((e, i) => {
          const res = compileBatchFallbackEntry(e, i, optsCopy, compileOpts, virtualFiles);
          recordFallbackEntry(e, i, res);
          return res;
        });
      }

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const isStr = typeof e === 'string';
        const id = isStr ? e : e.id || e.filename || `entry_${i}`;
        const opts = typeof e === 'object' && e ? e.options : undefined;
        if (opts) {
          entryOptionsMap.set(id, opts);
        }
      }

      const normalized = normalizeBatchEntries(entries, optsCopy);
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
        entryOptionsMap,
      });
    },
  };
}

export function compileBatch(entries, defaultOptions = {}, compileOpts = {}) {
  if (
    hasHostCustomizations(defaultOptions) ||
    entries.some((e) => typeof e === 'object' && hasHostCustomizations(e.options))
  ) {
    return entries.map((e, i) => compileBatchFallbackEntry(e, i, defaultOptions, compileOpts));
  }

  const normalized = normalizeBatchEntries(entries, defaultOptions);
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
  _link,
  _compileAttrs,
  _getLastProfileJson: getLastProfileJson,
  createTemplateStore,
  clearDefaultTemplateStore,
  defaultTemplateStoreStats,
  createCompiler,
  compileBatch,
  compile,
  compileFile,
  render,
  renderFile,
  __express,
};
