# ismd-cli

以命令列把 `.pug` 模板批次編譯為 HTML（或其他副檔名）的工具，底層使用 `ismd` 的持續性 `CompilerSession`，同一批次內共用版型與 include 的解析快取。

## 需求

- Node.js `>=20.0.0`
- 相依套件 `ismd`，會隨 `npm install` 自動從 GitHub 下載安裝

## 安裝

可直接透過 GitHub 安裝：

```bash
# 全域安裝 CLI
npm install -g github:Hao-CMIND/ismd#pkg-cli

# 或在專案中安裝為開發依賴
npm install -D github:Hao-CMIND/ismd#pkg-cli
```

## 使用方式

若為全域安裝，可直接使用 `ismd` 指令：

```bash
ismd [options] <file-or-dir...>
```

若在專案本機或從原始碼執行：

```bash
npx ismd [options] <file-or-dir...>
# 或直接執行腳本
node index.mjs [options] <file-or-dir...>
```

傳入單一檔案或目錄；目錄會遞迴掃描 `.pug` 檔案。

```bash
# 編譯單一檔案，輸出到 dist/
node index.mjs -o dist pages/index.pug

# 編譯整個目錄並監看變更
node index.mjs -o dist -w src/pages
```

## 參數

| 參數 | 說明 |
| --- | --- |
| `-o, --out <dir>` | 輸出目錄，會保留來源的相對目錄結構 |
| `-E, --extension <ext>` | 輸出副檔名，預設 `html`（例如 `-E php`、`-E .xml`） |
| `-w, --watch` | 監看檔案變更並自動增量重編譯 |
| `--doctype <str>` | 指定 doctype，例如 `html`、`xml` |
| `--basedir <dir>` | 解析以 `/` 開頭之 `include` / `extends` 的根目錄 |
| `-p, --pretty` | 輸出縮排格式的 HTML |
| `-O, --obj <str\|path>` | 編譯選項：JSON 字串、`.json` 檔，或 `.js` / `.mjs` / `.cjs` 模組 |
| `-s, --silent` | 不輸出狀態訊息 |
| `-h, --help` | 顯示說明 |

`-O` 的完整選項鍵請見 [ismd/README.md](../ismd/README.md) 的「編譯選項」。

## 目錄掃描規則

掃描目錄時會略過下列目錄與檔案，它們只作為版型或片段被引用，不會單獨輸出：

- 目錄名稱為 `includes`、`include`、`layouts`、`layout`、`partials`、`partial`、`components`、`component`、`mixins`、`mixin`、`node_modules`、`.git`
- 以 `_` 開頭的檔案或目錄

## 測試

```bash
npm test
```

測試檔為 `tests/cli.test.mjs`，會在系統暫存目錄建立臨時專案執行 CLI。
