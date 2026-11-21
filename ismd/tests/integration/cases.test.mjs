import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ismd from '../../index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.resolve(__dirname, '../cases');
const files = fs.readdirSync(casesDir).filter((f) => f.endsWith('.pug')).sort();

test(`Native ismd test suite (${files.length} cases)`, async (t) => {
  for (const file of files) {
    const caseName = file.replace(/\.pug$/, '');
    await t.test(caseName, () => {
      const ismdFilePath = path.join(casesDir, file);
      const htmlPath = path.join(casesDir, `${caseName}.html`);
      const src = fs.readFileSync(ismdFilePath, 'utf8');
      const expectedHtml = fs.existsSync(htmlPath)
        ? fs.readFileSync(htmlPath, 'utf8').trim().replace(/\r/g, '')
        : '';

      const fn = ismd.compile(src, {
        filename: ismdFilePath,
        pretty: true,
        basedir: casesDir,
      });
      const actualHtml = fn({ title: 'Ismd' }).trim().replace(/\r/g, '');
      assert.strictEqual(actualHtml, expectedHtml, `HTML mismatch in case: ${file}`);
    });
  }
});
