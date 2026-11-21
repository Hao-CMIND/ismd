#!/usr/bin/env node
/**
 * 驗證 `scripts/build-reference.mjs` 產生的 `raw/compiler` 是否可作為對照基準，並把結果寫成報告。
 *
 * 檢查項目：
 *  1. 目錄結構：12 個 `ismd-*` 套件齊全，路徑與檔名不含 `pug`（模板副檔名 `.pug` 除外），且沒有 `.ismd` 檔案。
 *  2. 內容改名：文字檔不殘留 `pug`／`Pug`／`PUG`（模板副檔名 `.pug` 除外）；`package.json` 名稱為 `ismd-monorepo`。
 *  3. node_modules 連結：第三方套件連結數量與 `raw/pug/node_modules` 一致、目標存在；
 *     工作區 `ismd-*` 連結指向 `raw/compiler/packages/ismd-*`。
 *  4. 模組解析：由各套件目錄能 `require` 到 `prettier`、`pretty-format`、`line-json` 與其他 `ismd-*`。
 *  5. 冒煙測試：`ismd` 套件能編譯與渲染，錯誤碼前綴為 `ISMD:`，runtime 函式名為 `ismd_*`。
 *  6. 原版未被改動：`raw/pug` 仍是 `pug-*` 命名，沒有 `ismd` 套件。
 *
 * 報告寫入 `benchmarks/diagnostics/reference-build-report.{md,json}`。
 * 任一檢查失敗時結束碼為 1。
 *
 * 用法：node scripts/verify-reference.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ISMD_ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(ISMD_ROOT, '../raw/pug');
const DEST = path.resolve(ISMD_ROOT, '../raw/compiler');
const REPORT_DIR = path.join(ISMD_ROOT, 'benchmarks/diagnostics');

const EXPECTED_PACKAGES = [
  'ismd', 'ismd-attrs', 'ismd-code-gen', 'ismd-error', 'ismd-filters', 'ismd-lexer',
  'ismd-linker', 'ismd-load', 'ismd-parser', 'ismd-runtime', 'ismd-strip-comments', 'ismd-walk',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.pug', '.html', '.snap', '.txt', '.yml', '.yaml',
  '.ts', '.tsx', '.lock', '.css', '.svg', '.xml', '.markdown', '',
]);

// 模板副檔名 `.pug`（其後不接字母、數字、底線或連字號）是刻意保留的，不算殘留。
const KEEP_EXT_RE = /\.pug(?![A-Za-z0-9_-])/g;

const results = [];
function check(group, name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r.ok;
    detail = r.detail || '';
  } catch (err) {
    ok = false;
    detail = `例外：${err && err.message ? err.message : String(err)}`;
  }
  results.push({ group, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function walkFiles(dir, visit) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    visit(full, ent);
    if (ent.isDirectory()) walkFiles(full, visit);
  }
}

if (!fs.existsSync(DEST)) {
  console.error(`找不到 ${DEST}，請先執行 npm run reference:build`);
  process.exit(1);
}

// 1. 目錄結構
check('結構', '12 個 ismd-* 套件目錄齊全', () => {
  const missing = EXPECTED_PACKAGES.filter(
    (n) => !fs.existsSync(path.join(DEST, 'packages', n, 'package.json'))
  );
  return { ok: missing.length === 0, detail: missing.length ? `缺少：${missing.join(', ')}` : '' };
});
check('結構', '路徑與檔名不含 pug（不含 node_modules）', () => {
  const bad = [];
  walkFiles(DEST, (full) => {
    if (/pug/i.test(path.basename(full).replace(KEEP_EXT_RE, ''))) bad.push(path.relative(DEST, full));
  });
  return { ok: bad.length === 0, detail: bad.slice(0, 5).join(', ') };
});
check('結構', '沒有 .ismd 檔案、且保有 .pug 模板檔案', () => {
  let ismd = 0;
  let pugTpl = 0;
  walkFiles(DEST, (full, ent) => {
    if (!ent.isFile()) return;
    if (/\.ismd$/i.test(full)) ismd++;
    if (/\.pug$/i.test(full)) pugTpl++;
  });
  return { ok: ismd === 0 && pugTpl > 0, detail: `.ismd ${ismd} 個、.pug ${pugTpl} 個` };
});

// 2. 內容改名
check('內容', '文字檔不殘留 pug／Pug／PUG', () => {
  const bad = [];
  let scanned = 0;
  walkFiles(DEST, (full, ent) => {
    if (!ent.isFile() || !TEXT_EXT.has(path.extname(full).toLowerCase())) return;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return;
    scanned++;
    // integrity 雜湊是 base64，可能碰巧含 pug 字樣，不算殘留。
    const text = buf
      .toString('utf8')
      .split('\n')
      .filter((l) => !/integrity/.test(l))
      .join('\n');
    if (/pug/i.test(text.replace(KEEP_EXT_RE, ''))) bad.push(path.relative(DEST, full));
  });
  return {
    ok: bad.length === 0,
    detail: `掃描 ${scanned} 個文字檔${bad.length ? `，殘留於：${bad.slice(0, 5).join(', ')}` : ''}`,
  };
});
check('內容', 'package.json 名稱為 ismd-monorepo', () => {
  const name = JSON.parse(fs.readFileSync(path.join(DEST, 'package.json'), 'utf8')).name;
  return { ok: name === 'ismd-monorepo', detail: `name=${name}` };
});

// 3. node_modules 連結
const destNm = path.join(DEST, 'node_modules');
const srcNm = path.join(SRC, 'node_modules');
check('連結', '第三方套件連結數量與 raw/pug/node_modules 一致', () => {
  const expected = fs
    .readdirSync(srcNm)
    .filter((n) => !n.startsWith('.') && !n.startsWith('pug'));
  const actual = fs
    .readdirSync(destNm)
    .filter((n) => !n.startsWith('ismd') && !n.startsWith('.'));
  const missing = expected.filter((n) => !actual.includes(n));
  return {
    ok: missing.length === 0 && actual.length === expected.length,
    detail: `預期 ${expected.length}、實際 ${actual.length}${missing.length ? `，缺少：${missing.slice(0, 5).join(', ')}` : ''}`,
  };
});
check('連結', '第三方套件連結皆為連結且目標存在', () => {
  const bad = [];
  let count = 0;
  for (const n of fs.readdirSync(destNm)) {
    if (n.startsWith('ismd') || n.startsWith('.')) continue;
    count++;
    const full = path.join(destNm, n);
    if (!fs.lstatSync(full).isSymbolicLink() || !fs.existsSync(full)) bad.push(n);
  }
  return { ok: bad.length === 0, detail: `檢查 ${count} 個${bad.length ? `，異常：${bad.slice(0, 5).join(', ')}` : ''}` };
});
check('連結', 'ismd-* 工作區連結指向 raw/compiler/packages', () => {
  const bad = [];
  for (const n of EXPECTED_PACKAGES) {
    const full = path.join(destNm, n);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isSymbolicLink()) {
      bad.push(`${n}（缺少或非連結）`);
      continue;
    }
    const real = fs.realpathSync(full);
    if (real !== fs.realpathSync(path.join(DEST, 'packages', n))) bad.push(`${n}（指向 ${real}）`);
  }
  return { ok: bad.length === 0, detail: bad.join(', ') };
});
check('連結', '沒有 pug-* 連結殘留', () => {
  const bad = fs.readdirSync(destNm).filter((n) => n.startsWith('pug'));
  return { ok: bad.length === 0, detail: bad.join(', ') };
});

// 4. 模組解析
const reqFromPkg = createRequire(path.join(DEST, 'packages/ismd-lexer/index.js'));
for (const mod of ['prettier', 'pretty-format', 'line-json', 'ismd-error', 'ismd-parser']) {
  check('解析', `由 ismd-lexer 目錄可 require('${mod}')`, () => {
    const p = reqFromPkg.resolve(mod);
    return { ok: !!p, detail: p.replace(DEST, '<raw/compiler>') };
  });
}
check('解析', '12 個 ismd-* 套件皆可 require', () => {
  const bad = [];
  const req = createRequire(path.join(DEST, 'packages/ismd/index.js'));
  for (const n of EXPECTED_PACKAGES) {
    try {
      req(n);
    } catch (err) {
      bad.push(`${n}：${err.message.split('\n')[0]}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.join('；') };
});

// 5. 冒煙測試
const reqRoot = createRequire(path.join(DEST, 'packages/ismd/index.js'));
check('冒煙', 'ismd.render 輸出 <p>Hello</p>', () => {
  const out = reqRoot('ismd').render('p Hello');
  return { ok: out === '<p>Hello</p>', detail: JSON.stringify(out) };
});
check('冒煙', '語法錯誤的錯誤碼前綴為 ISMD:', () => {
  try {
    reqRoot('ismd').render('p(a="x"');
    return { ok: false, detail: '未丟出錯誤' };
  } catch (err) {
    return { ok: String(err.code).startsWith('ISMD:'), detail: `code=${err.code}` };
  }
});
check('冒煙', 'runtime 函式名為 ismd_*', () => {
  const sources = reqRoot('ismd-runtime/lib/sources.js');
  const keys = Object.values(sources).join('\n');
  return {
    ok: /ismd_merge/.test(keys) && !/pug_/.test(keys),
    detail: 'sources 含 ismd_merge 且不含 pug_',
  };
});

// 6. 原版未被改動
check('原版', 'raw/pug 仍為 pug-* 命名，沒有 ismd 套件', () => {
  const pkgs = fs.readdirSync(path.join(SRC, 'packages'));
  const bad = pkgs.filter((n) => /ismd/i.test(n));
  return { ok: bad.length === 0 && pkgs.includes('pug-lexer'), detail: `${pkgs.length} 個套件` };
});

// 報告
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const stamp = new Date().toISOString();
const json = { generatedAt: stamp, passed, failed, results };
const md = [
  '# 對照基準 `raw/compiler` 建置驗證報告',
  '',
  `- 產生時間：${stamp}`,
  `- 腳本：\`scripts/build-reference.mjs\`（建置）、\`scripts/verify-reference.mjs\`（本報告）`,
  `- 結果：${passed} 項通過、${failed} 項失敗`,
  '',
  '| 結果 | 類別 | 項目 | 細節 |',
  '|---|---|---|---|',
  ...results.map(
    (r) => `| ${r.ok ? 'PASS' : 'FAIL'} | ${r.group} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |`
  ),
  '',
].join('\n');
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, 'reference-build-report.md'), md);
fs.writeFileSync(path.join(REPORT_DIR, 'reference-build-report.json'), JSON.stringify(json, null, 2) + '\n');
console.log(`\n${passed} 通過、${failed} 失敗；報告：benchmarks/diagnostics/reference-build-report.md`);
process.exit(failed ? 1 : 0);
