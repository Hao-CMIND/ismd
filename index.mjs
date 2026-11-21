#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ismd from 'ismd';

const require = createRequire(import.meta.url);

function printHelp() {
  console.log(`Usage: ismd [options] <file-or-dir...>

Options:
  -o, --out <dir>         Output directory for compiled HTML files
  -E, --extension <ext>   Specify the output file extension (default: html)
  -w, --watch             Watch files for changes and automatically re-render
  --doctype <str>         Specify the doctype on the command line
  --basedir <dir>         Base directory for absolute includes/extends
  -p, --pretty            Pretty-print HTML output
  -O, --obj <str|path>    JSON/JavaScript options object or file
  -s, --silent            Suppress status logs
  -h, --help              Show this help message`);
}

function requireArgValue(argv, index, flag) {
  if (index + 1 >= argv.length) {
    throw new Error(`Option ${flag} requires a value`);
  }
  return argv[index + 1];
}

async function parseObj(raw) {
  const resolved = path.resolve(raw);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    if (/\.(mjs|cjs|js)$/i.test(resolved)) {
      try {
        const mod = await import(pathToFileURL(resolved).href);
        return mod.default !== undefined ? mod.default : mod;
      } catch (esmErr) {
        try {
          return require(resolved);
        } catch {
          throw esmErr;
        }
      }
    }
    const text = fs.readFileSync(resolved, 'utf8');
    try {
      return JSON.parse(text);
    } catch {
      try {
        const fn = new Function('require', 'module', 'exports', `
          ${text};
          return (module.exports && Object.keys(module.exports).length) ? module.exports : exports;
        `);
        const modObj = { exports: {} };
        const res = fn(require, modObj, modObj.exports);
        if (res && typeof res === 'object' && Object.keys(res).length) return res;
      } catch {}
      const evalFn = new Function(`return (${text});`);
      return evalFn();
    }
  }

  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const evalFn = new Function(`return (${trimmed});`);
    return evalFn();
  }
}

function parseArgs(argv) {
  const opts = {
    inputs: [],
    outDir: null,
    extension: 'html',
    doctype: null,
    watch: false,
    basedir: null,
    pretty: false,
    locals: {},
    silent: false,
    help: false,
    rawObjList: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-p' || arg === '--pretty') {
      opts.pretty = true;
    } else if (arg === '-s' || arg === '--silent') {
      opts.silent = true;
    } else if (arg === '-w' || arg === '--watch') {
      opts.watch = true;
    } else if (arg === '-E' || arg === '--extension') {
      opts.extension = requireArgValue(argv, i++, arg).replace(/^\./, '');
    } else if (arg === '--doctype') {
      opts.doctype = requireArgValue(argv, i++, arg);
    } else if (arg === '-o' || arg === '--out') {
      opts.outDir = requireArgValue(argv, i++, arg);
    } else if (arg === '--basedir') {
      opts.basedir = requireArgValue(argv, i++, arg);
    } else if (arg === '-O' || arg === '--obj' || arg === '--locals') {
      opts.rawObjList.push(requireArgValue(argv, i++, arg));
    } else if (!arg.startsWith('-')) {
      opts.inputs.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function collectIsmdFiles(inputs) {
  const files = [];
  const rootBases = new Map();

  function isTemplateFile(name) {
    return /\.pug$/i.test(name);
  }

  function isIgnoredFragmentDir(name) {
    return /^(includes?|layouts?|partials?|components?|mixins?|node_modules|\.git)$/i.test(name) || name.startsWith('_');
  }

  function walkDir(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredFragmentDir(entry.name)) {
          walkDir(full, baseDir);
        }
      } else if (entry.isFile() && isTemplateFile(entry.name) && !entry.name.startsWith('_')) {
        const abs = path.resolve(full);
        files.push(abs);
        rootBases.set(abs, baseDir);
      }
    }
  }

  for (const input of inputs) {
    const abs = path.resolve(input);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      walkDir(abs, abs);
    } else if (stat.isFile() && isTemplateFile(abs) && !path.basename(abs).startsWith('_')) {
      files.push(abs);
      rootBases.set(abs, path.dirname(abs));
    }
  }

  return { files, rootBases };
}

export async function runCli(argv = process.argv.slice(2), testHooks = {}) {
  const cli = parseArgs(argv);
  if (cli.help) {
    printHelp();
    return 0;
  }

  for (const raw of cli.rawObjList) {
    try {
      const obj = await parseObj(raw);
      if (obj && typeof obj === 'object') {
        if (obj.doctype !== undefined && cli.doctype === null) {
          cli.doctype = String(obj.doctype);
        }
        if (obj.locals && typeof obj.locals === 'object') {
          cli.locals = { ...cli.locals, ...obj.locals };
        } else {
          cli.locals = { ...cli.locals, ...obj };
        }
      }
    } catch (err) {
      throw new Error(`Invalid JSON for -O: ${err && err.message ? err.message : String(err)}`);
    }
  }

  if (cli.inputs.length === 0) {
    printHelp();
    return 0;
  }

  const { files, rootBases } = collectIsmdFiles(cli.inputs);
  if (files.length === 0) {
    if (!cli.silent) {
      console.error('No .pug files found.');
    }
    return 1;
  }

  const compileOptions = {
    basedir: cli.basedir ? path.resolve(cli.basedir) : undefined,
    pretty: cli.pretty,
    doctype: cli.doctype || undefined,
    compileDebug: false,
  };

  const compiler = ismd.createCompiler(compileOptions);
  const ext = cli.extension || 'html';
  const normalizeWatchPath = (p) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const resolvedOutDir = cli.outDir ? normalizeWatchPath(cli.outDir) : null;
  const writtenOutputFiles = new Set();

  function renderAndWrite(items, currentRootBases) {
    let hasError = false;
    for (const item of items) {
      if (!item.ok) {
        hasError = true;
        if (!cli.silent) {
          console.error(item.error && item.error.message ? item.error.message : String(item.error));
        }
        continue;
      }
      let html;
      try {
        html = item.fn(cli.locals);
      } catch (renderErr) {
        hasError = true;
        if (!cli.silent) {
          const msg = renderErr && renderErr.message ? renderErr.message : String(renderErr);
          console.error(`${item.id}: Render error: ${msg}`);
        }
        continue;
      }

      if (cli.outDir) {
        const base = (currentRootBases && currentRootBases.get(item.id)) || rootBases.get(item.id) || path.dirname(item.id);
        const rel = path.relative(base, item.id);
        const dest = path.join(path.resolve(cli.outDir), rel.replace(/\.pug$/i, '.' + ext));
        writtenOutputFiles.add(normalizeWatchPath(dest));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, html, 'utf8');
      } else if (files.length === 1 && !cli.watch) {
        process.stdout.write(html);
      } else {
        const dest = item.id.replace(/\.pug$/i, '.' + ext);
        writtenOutputFiles.add(normalizeWatchPath(dest));
        fs.writeFileSync(dest, html, 'utf8');
      }
      if (!cli.silent && cli.watch) {
        console.log(`  rendered ${path.relative(process.cwd(), item.id)}`);
      }
    }
    return hasError;
  }

  const compiled = compiler.compileEntries(files, { throwOnError: false });
  const initialError = renderAndWrite(compiled, rootBases);

  if (!cli.watch) {
    compiler.dispose();
    return initialError ? 1 : 0;
  }

  // --- Watch Mode ---
  if (!cli.silent) {
    console.log('  watching for changes...');
  }

  const watchers = [];
  const watchedFiles = new Set();
  const allKnownDependencies = new Set();
  const changedFiles = new Set();
  let debounceTimer = null;

  function isIgnoredWatchFile(filePath) {
    const norm = normalizeWatchPath(filePath);
    if (writtenOutputFiles.has(norm)) return true;
    if (
      resolvedOutDir &&
      (norm === resolvedOutDir || norm.startsWith(resolvedOutDir + path.sep))
    ) {
      return true;
    }
    if (allKnownDependencies.has(norm)) return false;
    const base = path.basename(filePath);
    if (base.startsWith('.') || base.endsWith('~') || base.endsWith('.tmp')) return true;
    return false;
  }

  function triggerRebuild() {
    const changedList = Array.from(changedFiles);
    changedFiles.clear();

    const toUpdate = [];
    const toRemove = [];

    for (const p of changedList) {
      if (isIgnoredWatchFile(p)) continue;
      const norm = normalizeWatchPath(p);
      const isKnownDep = allKnownDependencies.has(norm);
      if (fs.existsSync(p)) {
        const isPug = /\.pug$/i.test(p);
        if (fs.statSync(p).isFile() && (isPug || isKnownDep)) {
          try {
            const src = fs.readFileSync(p, 'utf8');
            toUpdate.push({ path: p, source: src });
          } catch {}
        }
      } else if (isKnownDep || /\.pug$/i.test(p)) {
        toRemove.push(p);
      }
    }

    if (toUpdate.length === 0 && toRemove.length === 0) {
      return;
    }

    if (toUpdate.length > 0) {
      compiler.updateFiles(toUpdate);
    }
    if (toRemove.length > 0) {
      compiler.removeFiles(toRemove);
    }

    const { files: currentFiles, rootBases: currentRootBases } = collectIsmdFiles(cli.inputs);

    let results = compiler.compileAffected({ throwOnError: false });
    if (!results || results.length === 0) {
      results = compiler.compileEntries(currentFiles, { throwOnError: false });
    }

    renderAndWrite(results, currentRootBases);
    registerDependencies(results);

    if (typeof testHooks.onRebuild === 'function') {
      testHooks.onRebuild(results);
    }
  }

  function watchSingleFile(filePath) {
    const abs = path.resolve(filePath);
    const norm = normalizeWatchPath(abs);
    if (watchedFiles.has(norm) || !fs.existsSync(abs) || isIgnoredWatchFile(abs)) return;
    watchedFiles.add(norm);
    try {
      const w = fs.watch(abs, () => {
        if (!isIgnoredWatchFile(abs)) {
          changedFiles.add(abs);
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(triggerRebuild, 50);
        }
      });
      watchers.push(w);
    } catch {}
  }

  function registerDependencies(items) {
    for (const item of items) {
      const itemDir = path.dirname(item.id);
      if (Array.isArray(item.dependencies)) {
        for (const dep of item.dependencies) {
          const absDep = path.isAbsolute(dep)
            ? dep
            : (cli.basedir && dep.startsWith('/')
                ? path.resolve(cli.basedir, '.' + dep)
                : path.resolve(itemDir, dep));
          allKnownDependencies.add(normalizeWatchPath(absDep));
          watchSingleFile(absDep);
        }
      }
    }
  }

  for (const input of cli.inputs) {
    const abs = path.resolve(input);
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        try {
          const w = fs.watch(abs, { recursive: true }, (eventType, filename) => {
            if (filename) {
              const target = path.resolve(abs, filename);
              if (!isIgnoredWatchFile(target)) {
                changedFiles.add(target);
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(triggerRebuild, 50);
              }
            } else {
              changedFiles.add(abs);
              clearTimeout(debounceTimer);
              debounceTimer = setTimeout(triggerRebuild, 50);
            }
          });
          watchers.push(w);
        } catch {
          watchSingleFile(abs);
        }
      } else {
        watchSingleFile(abs);
      }
    }
  }

  registerDependencies(compiled);

  function close() {
    clearTimeout(debounceTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {}
    }
    watchers.length = 0;
    compiler.dispose();
  }

  process.once('SIGINT', () => {
    close();
    process.exit(0);
  });

  return { compiler, watchers, close };
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(selfPath);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(selfPath);
  }
}

if (isEntryPoint()) {
  runCli().then((res) => {
    if (typeof res === 'number') {
      process.exitCode = res;
    }
  }).catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });
}
