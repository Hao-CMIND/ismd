import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../index.mjs');

test('CLI: compiles single file and multi-page directory batch via CompilerSession (.pug)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-'));
  try {
    const srcDir = path.join(dir, 'src');
    const outDir = path.join(dir, 'dist');
    const layoutsDir = path.join(dir, 'layouts');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(layoutsDir, { recursive: true });

    fs.writeFileSync(
      path.join(layoutsDir, 'base.pug'),
      'html\n  body\n    block content\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(srcDir, 'index.pug'),
      'extends ../layouts/base.pug\nblock content\n  h1 Home #{site}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(srcDir, 'about.pug'),
      'extends ../layouts/base.pug\nblock content\n  h1 About #{site}\n',
      'utf8'
    );

    execFileSync(
      process.execPath,
      [
        cliPath,
        srcDir,
        '--out',
        outDir,
        '--basedir',
        dir,
        '--obj',
        JSON.stringify({ site: 'ISMD' }),
      ],
      { encoding: 'utf8' }
    );

    const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const aboutHtml = fs.readFileSync(path.join(outDir, 'about.html'), 'utf8');
    assert.equal(indexHtml, '<html><body><h1>Home ISMD</h1></body></html>');
    assert.equal(aboutHtml, '<html><body><h1>About ISMD</h1></body></html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: runs when path has spaces/CJK and skips layouts/includes/partials directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli space 中文-'));
  try {
    const srcDir = path.join(dir, 'pages');
    const layoutsDir = path.join(srcDir, 'layouts');
    const partialsDir = path.join(srcDir, 'partials');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(layoutsDir, { recursive: true });
    fs.mkdirSync(partialsDir, { recursive: true });

    fs.writeFileSync(path.join(layoutsDir, 'base.pug'), 'html\n  body\n    block content\n', 'utf8');
    fs.writeFileSync(path.join(partialsDir, 'frag.pug'), '+missingMixin()\n', 'utf8');
    fs.writeFileSync(
      path.join(srcDir, 'home.pug'),
      'extends layouts/base.pug\nblock content\n  p OK\n',
      'utf8'
    );

    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '--basedir', srcDir], {
      encoding: 'utf8',
    });

    assert.equal(fs.readFileSync(path.join(outDir, 'home.html'), 'utf8'), '<html><body><p>OK</p></body></html>');
    assert.equal(fs.existsSync(path.join(outDir, 'layouts', 'base.html')), false);
    assert.equal(fs.existsSync(path.join(outDir, 'partials', 'frag.html')), false);

    const copyCliDir = path.join(dir, 'cli space 中文');
    fs.mkdirSync(copyCliDir, { recursive: true });
    const helpOut = execFileSync(process.execPath, [cliPath, '--help'], {
      cwd: copyCliDir,
      encoding: 'utf8',
    });
    assert.ok(helpOut.includes('Usage: ismd'));
    assert.ok(helpOut.includes('-E, --extension'));
    assert.ok(helpOut.includes('-w, --watch'));
    assert.ok(helpOut.includes('--doctype'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: supports -E/--extension to customize output file extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-ext-'));
  try {
    const srcDir = path.join(dir, 'src');
    const outDir = path.join(dir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'template.pug'), 'h1 Hello World\n', 'utf8');

    // Test -E php
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '-E', 'php'], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'template.php'), 'utf8'), '<h1>Hello World</h1>');

    // Test --extension .xml
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '--extension', '.xml'], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'template.xml'), 'utf8'), '<h1>Hello World</h1>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: supports --doctype to specify doctype on command line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-doctype-'));
  try {
    const srcDir = path.join(dir, 'src');
    const outDir = path.join(dir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'page.pug'), 'html\n  body\n    p Content\n', 'utf8');

    // Test --doctype html
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '--doctype', 'html'], {
      encoding: 'utf8',
    });
    const htmlOut = fs.readFileSync(path.join(outDir, 'page.html'), 'utf8');
    assert.equal(htmlOut, '<!DOCTYPE html><html><body><p>Content</p></body></html>');

    // Test --doctype xml
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '--doctype', 'xml'], {
      encoding: 'utf8',
    });
    const xmlOut = fs.readFileSync(path.join(outDir, 'page.html'), 'utf8');
    assert.equal(xmlOut, '<?xml version="1.0" encoding="utf-8" ?><html><body><p>Content</p></body></html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: supports -O/--obj with JSON file, JS/MJS file, and JS expression string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-obj-'));
  try {
    const srcDir = path.join(dir, 'src');
    const outDir = path.join(dir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'data.pug'), 'h1= title\np= desc\n', 'utf8');

    // 1. CommonJS file
    const cjsPath = path.join(dir, 'config.js');
    fs.writeFileSync(cjsPath, 'module.exports = { title: "CJS Title", desc: "CJS Desc" };\n', 'utf8');
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '-O', cjsPath], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'data.html'), 'utf8'), '<h1>CJS Title</h1><p>CJS Desc</p>');

    // 2. ESM file (.mjs)
    const mjsPath = path.join(dir, 'config.mjs');
    fs.writeFileSync(mjsPath, 'export default { title: "ESM Title", desc: "ESM Desc" };\n', 'utf8');
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '-O', mjsPath], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'data.html'), 'utf8'), '<h1>ESM Title</h1><p>ESM Desc</p>');

    // 3. JSON file (.json)
    const jsonPath = path.join(dir, 'config.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: 'JSON Title', desc: 'JSON Desc' }), 'utf8');
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '-O', jsonPath], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'data.html'), 'utf8'), '<h1>JSON Title</h1><p>JSON Desc</p>');

    // 4. JS object literal string (not strict JSON)
    execFileSync(process.execPath, [cliPath, srcDir, '--out', outDir, '-O', "{title: 'Lit Title', desc: 'Lit Desc'}"], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'data.html'), 'utf8'), '<h1>Lit Title</h1><p>Lit Desc</p>');

    // 5. Config file specifying doctype and locals
    const docConfigPath = path.join(dir, 'docConfig.js');
    fs.writeFileSync(docConfigPath, 'exports.doctype = "html"; exports.title = "Doc Title"; exports.desc = "Doc Desc";\n', 'utf8');
    fs.writeFileSync(path.join(srcDir, 'withDoc.pug'), 'html\n  body\n    h1= title\n', 'utf8');
    execFileSync(process.execPath, [cliPath, path.join(srcDir, 'withDoc.pug'), '--out', outDir, '-O', docConfigPath], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'withDoc.html'), 'utf8'), '<!DOCTYPE html><html><body><h1>Doc Title</h1></body></html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: supports -w/--watch mode with incremental re-rendering on changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-watch-'));
  let controller;
  try {
    const srcDir = path.join(dir, 'src');
    const layoutsDir = path.join(dir, 'layouts');
    const outDir = path.join(dir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(layoutsDir, { recursive: true });

    const layoutPath = path.join(layoutsDir, 'base.pug');
    const pagePath = path.join(srcDir, 'page.pug');
    const outPath = path.join(outDir, 'page.html');

    fs.writeFileSync(layoutPath, 'html\n  body\n    header V1 Header\n    block content\n', 'utf8');
    fs.writeFileSync(pagePath, 'extends ../layouts/base.pug\nblock content\n  p V1 Content\n', 'utf8');

    let rebuildPromise;
    let resolveRebuild;

    function resetRebuild() {
      rebuildPromise = new Promise((resolve) => {
        resolveRebuild = resolve;
      });
    }

    resetRebuild();

    controller = await runCli(
      [srcDir, '--out', outDir, '--basedir', dir, '-w', '-s'],
      {
        onRebuild(results) {
          if (resolveRebuild) resolveRebuild(results);
        },
      }
    );

    assert.equal(fs.readFileSync(outPath, 'utf8'), '<html><body><header>V1 Header</header><p>V1 Content</p></body></html>');

    // 1. Modify layout (dependency)
    resetRebuild();
    fs.writeFileSync(layoutPath, 'html\n  body\n    header V2 Header\n    block content\n', 'utf8');
    await rebuildPromise;
    assert.equal(fs.readFileSync(outPath, 'utf8'), '<html><body><header>V2 Header</header><p>V1 Content</p></body></html>');

    // 2. Modify page (entry)
    resetRebuild();
    fs.writeFileSync(pagePath, 'extends ../layouts/base.pug\nblock content\n  p V2 Content\n', 'utf8');
    await rebuildPromise;
    assert.equal(fs.readFileSync(outPath, 'utf8'), '<html><body><header>V2 Header</header><p>V2 Content</p></body></html>');
  } finally {
    if (controller) controller.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: spawns subprocess with -w/--watch and verifies live rebuild', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-proc-watch-'));
  let child;
  try {
    const srcDir = path.join(dir, 'src');
    const outDir = path.join(dir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });

    const pagePath = path.join(srcDir, 'index.pug');
    const outPath = path.join(outDir, 'index.html');

    fs.writeFileSync(pagePath, 'h1 Initial\n', 'utf8');

    child = spawn(process.execPath, [cliPath, srcDir, '--out', outDir, '-w'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();

    // Wait until initial output exists
    for (let i = 0; i < 60; i++) {
      if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf8') === '<h1>Initial</h1>') {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(fs.readFileSync(outPath, 'utf8'), '<h1>Initial</h1>');

    // Slight delay before modify to ensure separate timestamp on Windows filesystem
    await new Promise((r) => setTimeout(r, 100));

    // Modify file
    fs.writeFileSync(pagePath, 'h1 Updated\n', 'utf8');

    // Wait until output updates
    for (let i = 0; i < 80; i++) {
      if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf8') === '<h1>Updated</h1>') {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(fs.readFileSync(outPath, 'utf8'), '<h1>Updated</h1>');
  } finally {
    if (child && !child.killed) {
      child.kill('SIGINT');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI watch: does not loop infinitely when watching directory without -o', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-loop-'));
  let controller;
  try {
    const pagePath = path.join(dir, 'test.pug');
    const htmlPath = path.join(dir, 'test.html');
    fs.writeFileSync(pagePath, 'h1 No Loop\n', 'utf8');

    let rebuildCount = 0;
    controller = await runCli([dir, '-w', '-s'], {
      onRebuild() {
        rebuildCount++;
      },
    });

    assert.equal(fs.readFileSync(htmlPath, 'utf8'), '<h1>No Loop</h1>');

    // Wait 400ms without modifying anything; ensure output .html write didn't trigger endless loop
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(rebuildCount, 0);
  } finally {
    if (controller) controller.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI watch: updates output when a raw-included non-.pug file (.css) is modified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-raw-inc-'));
  let controller;
  try {
    const pagePath = path.join(dir, 'style-test.pug');
    const cssPath = path.join(dir, 'style.css');
    const htmlPath = path.join(dir, 'style-test.html');

    fs.writeFileSync(cssPath, 'body { color: red; }', 'utf8');
    fs.writeFileSync(pagePath, 'style\n  include ./style.css\n', 'utf8');

    let rebuildPromise;
    let resolveRebuild;
    function resetRebuild() {
      rebuildPromise = new Promise((resolve) => {
        resolveRebuild = resolve;
      });
    }

    resetRebuild();
    controller = await runCli([pagePath, '-w', '-s'], {
      onRebuild(results) {
        if (resolveRebuild) resolveRebuild(results);
      },
    });

    assert.equal(fs.readFileSync(htmlPath, 'utf8'), '<style>body { color: red; }</style>');

    // Modify raw-included css file
    resetRebuild();
    fs.writeFileSync(cssPath, 'body { color: blue; }', 'utf8');
    await rebuildPromise;

    assert.equal(fs.readFileSync(htmlPath, 'utf8'), '<style>body { color: blue; }</style>');
  } finally {
    if (controller) {
      controller.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: handles runtime error in template locals without aborting remaining files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-runtime-err-'));
  try {
    const outDir = path.join(dir, 'dist');
    const fileA = path.join(dir, 'a.pug');
    const fileB = path.join(dir, 'b.pug');
    const fileC = path.join(dir, 'c.pug');

    fs.writeFileSync(fileA, 'h1= title\n', 'utf8');
    fs.writeFileSync(fileB, 'p= nope.invalid\n', 'utf8');
    fs.writeFileSync(fileC, 'h2= title\n', 'utf8');

    let errCaught = null;
    try {
      execFileSync(
        process.execPath,
        [cliPath, fileA, fileB, fileC, '--out', outDir, '-O', '{"title":"Test"}'],
        { encoding: 'utf8', stdio: 'pipe' }
      );
    } catch (err) {
      errCaught = err;
    }

    // Process should exit with error code 1
    assert.ok(errCaught, 'CLI should exit with non-zero code on render error');
    assert.equal(errCaught.status, 1);

    // a.html and c.html should still be rendered despite b failing
    assert.equal(fs.readFileSync(path.join(outDir, 'a.html'), 'utf8'), '<h1>Test</h1>');
    assert.equal(fs.readFileSync(path.join(outDir, 'c.html'), 'utf8'), '<h2>Test</h2>');
    assert.equal(fs.existsSync(path.join(outDir, 'b.html')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: supports -O with module.exports in non-.js text file and propagates JS syntax errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-custom-obj-'));
  try {
    const customConfig = path.join(dir, 'options.conf');
    fs.writeFileSync(customConfig, 'module.exports = { title: "Custom Conf" };\n', 'utf8');

    const srcFile = path.join(dir, 'page.pug');
    fs.writeFileSync(srcFile, 'h1= title\n', 'utf8');
    const outDir = path.join(dir, 'out');

    execFileSync(process.execPath, [cliPath, srcFile, '--out', outDir, '-O', customConfig], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'page.html'), 'utf8'), '<h1>Custom Conf</h1>');

    // Invalid JS syntax in .js file propagates error clearly
    const badJs = path.join(dir, 'bad.js');
    fs.writeFileSync(badJs, 'module.exports = {;\n', 'utf8');
    assert.throws(
      () => execFileSync(process.execPath, [cliPath, srcFile, '-O', badJs], { encoding: 'utf8', stdio: 'pipe' }),
      /Invalid JSON for -O/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI watch: rebuilds when a raw-included .html fragment is modified (both with -o and in-place)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-raw-html-'));
  let controllerOut;
  let controllerInPlace;
  try {
    // 1. With -o outDir
    const outDir = path.join(dir, 'out');
    const mainPath = path.join(dir, 'main.pug');
    const partPath = path.join(dir, 'part.html');
    const outPath = path.join(outDir, 'main.html');

    fs.writeFileSync(partPath, '<b>v1</b>', 'utf8');
    fs.writeFileSync(mainPath, 'div\n  include part.html\n', 'utf8');

    let rebuildPromise;
    let resolveRebuild;
    function resetRebuild() {
      rebuildPromise = new Promise((resolve) => {
        resolveRebuild = resolve;
      });
    }

    resetRebuild();
    controllerOut = await runCli([mainPath, '-w', '-o', outDir, '-s'], {
      onRebuild(results) {
        if (resolveRebuild) resolveRebuild(results);
      },
    });
    assert.equal(fs.readFileSync(outPath, 'utf8'), '<div><b>v1</b></div>');

    resetRebuild();
    fs.writeFileSync(partPath, '<b>v2</b>', 'utf8');
    await rebuildPromise;
    assert.equal(fs.readFileSync(outPath, 'utf8'), '<div><b>v2</b></div>');

    controllerOut.close();
    controllerOut = null;

    // 2. In-place (without -o): modifying included part.html triggers rebuild, writing main.html does not loop
    const inPlaceDir = path.join(dir, 'inplace');
    fs.mkdirSync(inPlaceDir, { recursive: true });
    const inMainPath = path.join(inPlaceDir, 'main.pug');
    const inPartPath = path.join(inPlaceDir, 'part.html');
    const inOutPath = path.join(inPlaceDir, 'main.html');

    fs.writeFileSync(inPartPath, '<i>a1</i>', 'utf8');
    fs.writeFileSync(inMainPath, 'section\n  include part.html\n', 'utf8');

    let rebuildCount = 0;
    resetRebuild();
    controllerInPlace = await runCli([inPlaceDir, '-w', '-s'], {
      onRebuild(results) {
        rebuildCount++;
        if (resolveRebuild) resolveRebuild(results);
      },
    });
    assert.equal(fs.readFileSync(inOutPath, 'utf8'), '<section><i>a1</i></section>');

    resetRebuild();
    fs.writeFileSync(inPartPath, '<i>a2</i>', 'utf8');
    await rebuildPromise;
    assert.equal(fs.readFileSync(inOutPath, 'utf8'), '<section><i>a2</i></section>');

    // Wait briefly to confirm writing main.html did not cause an infinite loop
    const countAfterEdit = rebuildCount;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rebuildCount, countAfterEdit);
  } finally {
    if (controllerOut) controllerOut.close();
    if (controllerInPlace) controllerInPlace.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: only accepts .pug templates and ignores non-.pug files (such as .ismd) and files with _ prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ismd-cli-filter-pug-'));
  try {
    const ismdFile = path.join(dir, 'test.ismd');
    const pugFile = path.join(dir, 'test.pug');
    const partialFile = path.join(dir, '_partial.pug');
    const outDir = path.join(dir, 'out');

    fs.writeFileSync(ismdFile, 'h1 ISMD\n', 'utf8');
    fs.writeFileSync(pugFile, 'h1 PUG\n', 'utf8');
    fs.writeFileSync(partialFile, 'h1 Partial\n', 'utf8');

    // 1. Explicitly specifying only non-.pug file exits with code 1 and "No .pug files found."
    let nonPugError = null;
    try {
      execFileSync(process.execPath, [cliPath, ismdFile, '--out', outDir], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (e) {
      nonPugError = e;
    }
    assert.ok(nonPugError, 'Should exit with non-zero when only non-.pug files provided');
    assert.equal(nonPugError.status, 1);
    assert.ok(nonPugError.stderr.includes('No .pug files found.'));

    // 2. Explicitly specifying a _prefixed file also ignored
    let partialError = null;
    try {
      execFileSync(process.execPath, [cliPath, partialFile, '--out', outDir], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (e) {
      partialError = e;
    }
    assert.ok(partialError, 'Should exit with non-zero when only _ prefixed files provided');
    assert.equal(partialError.status, 1);
    assert.ok(partialError.stderr.includes('No .pug files found.'));

    // 3. Specifying a mixture of .pug, .ismd, and _partial.pug compiles only the valid .pug file
    execFileSync(process.execPath, [cliPath, pugFile, ismdFile, partialFile, '--out', outDir], {
      encoding: 'utf8',
    });
    assert.equal(fs.readFileSync(path.join(outDir, 'test.html'), 'utf8'), '<h1>PUG</h1>');
    assert.equal(fs.existsSync(path.join(outDir, 'test.ismd')), false);
    assert.equal(fs.existsSync(path.join(outDir, '_partial.html')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

