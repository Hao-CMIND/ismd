#!/usr/bin/env node
/**
 * 由原版 pug 參考碼（`raw/pug`）產生對照測試使用的 ismd 命名版本（`raw/compiler`）。
 *
 * - 複製 `raw/pug`（排除 `node_modules`、`.git`、`coverage`）到 `raw/compiler`。
 * - 目錄與檔名：`pug` -> `ismd`、`Pug` -> `Ismd`、`PUG` -> `ISMD`；**模板副檔名 `.pug` 保持不變**
 *   （產品只認 `.pug`，參考端的模板檔名與 `include x.pug`、副檔名比對都必須維持 `.pug`）。
 * - 文字檔內容做同樣的大小寫對應替換（`.pug` 副檔名同樣保留）；二進位檔原樣複製。
 * - `node_modules`：第三方套件以目錄連結（junction）指回 `raw/pug/node_modules`，
 *   工作區套件 `pug-*` 改為 `ismd-*` 並指向 `raw/compiler/packages/ismd-*`。
 *
 * `raw/` 已列於 `.gitignore`，產物不會進版控；`raw/pug` 不會被修改。
 *
 * 用法：node scripts/build-reference.mjs [--force]
 *   --force  目標 `raw/compiler` 已存在時先刪除再重建
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ISMD_ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(ISMD_ROOT, '../raw/pug');
const DEST = path.resolve(ISMD_ROOT, '../raw/compiler');
const force = process.argv.includes('--force');

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.pug', '.html', '.snap', '.txt', '.yml', '.yaml',
  '.ts', '.tsx', '.lock', '.css', '.svg', '.xml', '.markdown', '.jade', '.tmpl', '.ejs', '',
]);

// 模板副檔名 `.pug`（其後不接字母、數字、底線或連字號）不可改名。
const PUG_EXT_RE = /\.pug(?![A-Za-z0-9_-])/g;
const PUG_EXT_MARK = '@@KEEP_TPL_EXT@@';

function renameText(text) {
  return text
    .replace(PUG_EXT_RE, PUG_EXT_MARK)
    .replace(/pug/g, 'ismd')
    .replace(/Pug/g, 'Ismd')
    .replace(/PUG/g, 'ISMD')
    .split(PUG_EXT_MARK)
    .join('.pug');
}

// 鎖定檔的 integrity 雜湊是 base64，可能碰巧含有 pug 字樣，不可改動；其餘行才改名。
function renameLockfile(text) {
  return text
    .split('\n')
    .map((line) => (/integrity/.test(line) ? line : renameText(line)))
    .join('\n');
}

function rename(name) {
  return renameText(name);
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

function copyTree(src, dest, stats) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, rename(ent.name));
    if (ent.isDirectory()) {
      copyTree(from, to, stats);
    } else if (ent.isFile()) {
      const buf = fs.readFileSync(from);
      const ext = path.extname(ent.name).toLowerCase();
      if (TEXT_EXT.has(ext) && isProbablyText(buf)) {
        const text = buf.toString('utf8');
        const isLock = ent.name === 'package-lock.json' || ent.name === 'yarn.lock';
        fs.writeFileSync(to, isLock ? renameLockfile(text) : renameText(text));
        stats.text++;
      } else {
        fs.writeFileSync(to, buf);
        stats.binary++;
      }
    }
  }
}

function link(target, linkPath) {
  fs.symlinkSync(target, linkPath, 'junction');
}

function buildNodeModules(stats) {
  const srcNm = path.join(SRC, 'node_modules');
  const destNm = path.join(DEST, 'node_modules');
  fs.mkdirSync(destNm, { recursive: true });
  for (const ent of fs.readdirSync(srcNm, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('pug')) continue;
    link(path.join(srcNm, ent.name), path.join(destNm, ent.name));
    stats.links++;
  }
  const pkgDir = path.join(DEST, 'packages');
  for (const ent of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    if (ent.isDirectory() && ent.name.startsWith('ismd')) {
      link(path.join(pkgDir, ent.name), path.join(destNm, ent.name));
      stats.links++;
    }
  }
}

function main() {
  if (!fs.existsSync(path.join(SRC, 'packages'))) {
    console.error(`找不到原版參考碼：${SRC}`);
    process.exit(1);
  }
  if (fs.existsSync(DEST)) {
    if (!force) {
      console.error(`${DEST} 已存在；要重建請加 --force`);
      process.exit(1);
    }
    fs.rmSync(DEST, { recursive: true, force: true });
  }
  const stats = { text: 0, binary: 0, links: 0 };
  copyTree(SRC, DEST, stats);
  buildNodeModules(stats);
  console.log(
    `完成：${DEST}\n  文字檔 ${stats.text}、二進位檔 ${stats.binary}、node_modules 連結 ${stats.links}`
  );
}

main();
