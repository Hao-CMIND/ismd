#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import pug from '../compiler/index.js';

function printHelp() {
  console.log(`Usage: pug-rust [options] <file-or-dir...>

Options:
  -o, --out <dir>       Output directory for compiled HTML/JS files
  --basedir <dir>       Base directory for absolute includes/extends
  -p, --pretty          Pretty-print HTML output
  -O, --obj <json>      JSON string or path to JSON file for template locals
  -c, --client          Compile to client-side JS function instead of HTML
  -s, --silent          Suppress status logs
  -h, --help            Show this help message`);
}

function parseArgs(argv) {
  const opts = {
    inputs: [],
    outDir: null,
    basedir: null,
    pretty: false,
    locals: {},
    client: false,
    silent: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-p' || arg === '--pretty') {
      opts.pretty = true;
    } else if (arg === '-c' || arg === '--client') {
      opts.client = true;
    } else if (arg === '-s' || arg === '--silent') {
      opts.silent = true;
    } else if (arg === '-o' || arg === '--out') {
      opts.outDir = argv[++i];
    } else if (arg === '--basedir') {
      opts.basedir = argv[++i];
    } else if (arg === '-O' || arg === '--obj' || arg === '--locals') {
      const raw = argv[++i];
      if (raw) {
        if (raw.trim().startsWith('{')) {
          opts.locals = JSON.parse(raw);
        } else {
          opts.locals = JSON.parse(fs.readFileSync(raw, 'utf8'));
        }
      }
    } else if (!arg.startsWith('-')) {
      opts.inputs.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function collectPugFiles(inputs) {
  const files = [];
  const rootBases = new Map();

  function walkDir(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full, baseDir);
      } else if (entry.isFile() && entry.name.endsWith('.pug')) {
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
    } else if (stat.isFile()) {
      files.push(abs);
      rootBases.set(abs, path.dirname(abs));
    }
  }

  return { files, rootBases };
}

export function runCli(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  if (cli.help || cli.inputs.length === 0) {
    printHelp();
    return 0;
  }

  const { files, rootBases } = collectPugFiles(cli.inputs);
  if (files.length === 0) {
    if (!cli.silent) {
      console.error('No .pug files found.');
    }
    return 1;
  }

  const compileOptions = {
    basedir: cli.basedir ? path.resolve(cli.basedir) : undefined,
    pretty: cli.pretty,
    compileDebug: false,
  };

  if (cli.client) {
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const js = pug.compileClient(src, { ...compileOptions, filename: file });
      if (cli.outDir) {
        const rel = path.relative(rootBases.get(file), file);
        const dest = path.join(path.resolve(cli.outDir), rel.replace(/\.pug$/i, '.js'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, js, 'utf8');
      } else if (files.length === 1) {
        process.stdout.write(js);
      } else {
        const dest = file.replace(/\.pug$/i, '.js');
        fs.writeFileSync(dest, js, 'utf8');
      }
    }
    return 0;
  }

  const compiler = pug.createCompiler(compileOptions);
  try {
    const compiled = compiler.compileEntries(files);
    for (const item of compiled) {
      const html = item.fn(cli.locals);
      if (cli.outDir) {
        const rel = path.relative(rootBases.get(item.id), item.id);
        const dest = path.join(path.resolve(cli.outDir), rel.replace(/\.pug$/i, '.html'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, html, 'utf8');
      } else if (files.length === 1) {
        process.stdout.write(html);
      } else {
        const dest = item.id.replace(/\.pug$/i, '.html');
        fs.writeFileSync(dest, html, 'utf8');
      }
    }
    return 0;
  } finally {
    compiler.dispose();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  process.exitCode = runCli();
}
