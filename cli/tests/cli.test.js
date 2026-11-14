import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../index.js');

test('CLI: compiles single file and multi-page directory batch via CompilerSession', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-cli-'));
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
        JSON.stringify({ site: 'PugRust' }),
      ],
      { encoding: 'utf8' }
    );

    const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const aboutHtml = fs.readFileSync(path.join(outDir, 'about.html'), 'utf8');
    assert.equal(indexHtml, '<html><body><h1>Home PugRust</h1></body></html>');
    assert.equal(aboutHtml, '<html><body><h1>About PugRust</h1></body></html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
