# Pug Rust Compiler 相容性追蹤矩陣 (`compat/matrix.md`)

> 本文件由 `node tests/differential/runner.js --write-matrix` 自動驗證並產生，對應 `PLAN.md` Step 0 相容基準與分層驗收分類。

## 1. 狀態標記定義

| 狀態碼 | 定義 |
|---|---|
| `PASS` | 與基準版本（`raw/compiler`）輸出、快照、錯誤欄位或雙層 Codegen 完全一致 |
| `FAIL` | 已實作功能與基準輸出不一致，或非預期拋錯 |
| `UNSUPPORTED` | 目標階段尚未實作（將於對應 Step 1–6 逐步實作並切換為 `PASS`） |
| `APPROVED_DIFF` | 已登錄於 `compat/expected-differences.json` 的環境／平台差異 |

---

## 2. 各套件差異測試總覽

| 原版套件 | 對應 Rust Crate | 目標階段 | 追蹤案例數 | 原版基準 (`raw/compiler`) | Rust 目標 (`rust/compiler`) |
|---|---|---|---:|---|---|
| `pug-error` | `pug_error` | Step 1 | 8 | 8 PASS / 0 APPROVED_DIFF / 0 FAIL | 8 PASS / 0 UNSUPPORTED / 0 FAIL |
| `pug-lexer` | `pug_lexer + pug_js` | Step 2 | 144 | 144 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 144 UNSUPPORTED / 0 FAIL |
| `pug-strip-comments` | `pug_strip_comments` | Step 2 | 12 | 12 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 12 UNSUPPORTED / 0 FAIL |
| `pug-parser` | `pug_parser + pug_ast` | Step 3 | 119 | 119 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 119 UNSUPPORTED / 0 FAIL |
| `pug-walk` | `pug_walk` | Step 3 | 4 | 4 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 4 UNSUPPORTED / 0 FAIL |
| `pug-load` | `pug_load` | Step 4 | 1 | 1 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 1 UNSUPPORTED / 0 FAIL |
| `pug-filters` | `pug_filters + pug_js::constant` | Step 4 | 16 | 16 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 16 UNSUPPORTED / 0 FAIL |
| `pug-linker` | `pug_linker` | Step 4 | 24 | 24 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 24 UNSUPPORTED / 0 FAIL |
| `pug-attrs` | `pug_attrs` | Step 5 | 52 | 52 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 52 UNSUPPORTED / 0 FAIL |
| `pug-runtime` | `pug_runtime` | Step 5 | 9 | 9 PASS / 0 APPROVED_DIFF / 0 FAIL | 9 PASS / 0 UNSUPPORTED / 0 FAIL |
| `pug` | `pug_code_gen + pug_compiler + pug_napi` | Step 1–6 | 179 | 177 PASS / 2 APPROVED_DIFF / 0 FAIL | 10 PASS / 169 UNSUPPORTED / 0 FAIL |
| **合計** | — | **Step 0** | **568** | **566 PASS / 2 APPROVED_DIFF / 0 FAIL** | **27 PASS / 541 UNSUPPORTED / 0 FAIL** |

> 註：`pug-code-gen` (`2.0.2`) 在原版 Monorepo 中無獨立 `test/` 資料夾，其單元與快照測試合併於 `pug` 主套件的 `cases/*.pug`、`compileClient` 快照與執行語意測試中驗收。

---

## 3. 依驗收分類統計

| 測試類別 | 追蹤案例數 | 原版基準 (`raw/compiler`) | Rust 目標 (`rust/compiler`) |
|---|---:|---|---|
| Token/AST | 271 | 271 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 271 UNSUPPORTED / 0 FAIL |
| HTML | 119 | 119 PASS / 0 APPROVED_DIFF / 0 FAIL | 2 PASS / 117 UNSUPPORTED / 0 FAIL |
| Execution Semantics | 11 | 11 PASS / 0 APPROVED_DIFF / 0 FAIL | 10 PASS / 1 UNSUPPORTED / 0 FAIL |
| Filters/Plugins | 19 | 19 PASS / 0 APPROVED_DIFF / 0 FAIL | 1 PASS / 18 UNSUPPORTED / 0 FAIL |
| API | 7 | 7 PASS / 0 APPROVED_DIFF / 0 FAIL | 5 PASS / 2 UNSUPPORTED / 0 FAIL |
| Error | 87 | 85 PASS / 2 APPROVED_DIFF / 0 FAIL | 8 PASS / 79 UNSUPPORTED / 0 FAIL |
| JS Artifact | 54 | 54 PASS / 0 APPROVED_DIFF / 0 FAIL | 1 PASS / 53 UNSUPPORTED / 0 FAIL |

---

## 4. 公開 API、選項與外掛追蹤矩陣

| 類別 | 項目 | 原版基準行為 | 目前目標狀態 | 預計完成階段 |
|---|---|---|---|---|
| 公開 API | `pug.compile(str, options)` | 回傳附帶 `.dependencies` 的同步渲染函式 | `UNSUPPORTED` | Step 1 / Step 6 |
| 公開 API | `pug.compileFile(path, options)` | 讀取檔案並支援 `exports.cache[path]` | `UNSUPPORTED` | Step 4 / Step 6 |
| 公開 API | `pug.compileClient(str, options)` | 回傳 JS 函式原始碼字串（雙層驗收：Prettier + Raw） | `UNSUPPORTED` | Step 1 / Step 5 |
| 公開 API | `pug.compileFileClient(path, options)` | 支援 `exports.cache[path + ':client']` 與 `name` | `UNSUPPORTED` | Step 5 / Step 6 |
| 公開 API | `pug.compileClientWithDependenciesTracked(str, options)` | 回傳 `{ body, dependencies }` | `UNSUPPORTED` | Step 1 / Step 5 |
| 公開 API | `pug.render(str, options, fn)` | 同步渲染或同步回呼 `fn(err, html)`；原始 `locals` 不經 JSON 序列化 | `UNSUPPORTED` | Step 1 / Step 6 |
| 公開 API | `pug.renderFile(path, options, fn)` | 檔案同步渲染或同步回呼 `fn(err, html)` | `UNSUPPORTED` | Step 4 / Step 6 |
| 公開 API | `pug.__express(path, options, fn)` | `NODE_ENV === 'production'` 且未指定 `compileDebug` 時預設 `false` | `UNSUPPORTED` | Step 6 |
| 公開 API | `pug.cache` / `pug.filters` / `pug.runtime` / `pug.name` | 外部可直接讀寫 `cache` 與 `filters`；`name === 'Pug'` | `UNSUPPORTED` | Step 1 / Step 6 |
| 公開 API | `require('pug/register')` | 註冊 `require.extensions['.pug'] = pug.compileFile` | `UNSUPPORTED` | Step 1 / Step 6 |
| 編譯選項 | `pretty` / `doctype` / `self` / `globals` | 縮排字串、DOCTYPE 模式、`self` 命名空間與全域變數白名單 | `UNSUPPORTED` | Step 3 / Step 5 |
| 編譯選項 | `compileDebug` / `includeSources` / `debug` | 保留 `compile` 與 `compileClient` 預設差異 | `UNSUPPORTED` | Step 5 / Step 6 |
| 編譯選項 | `inlineRuntimeFunctions` / `name` / `module` | 內嵌 `pug_*` 依賴展開或 `runtimeWrap` / `require("pug-runtime")` | `UNSUPPORTED` | Step 1 / Step 5 |
| 編譯選項 | `filename` / `basedir` | Node `path` 相容解析，不任意 `fs::canonicalize` | `UNSUPPORTED` | Step 4 |
| 外掛介面 | `preLex` / `postLex` / `preParse` / `postParse` / `preLoad` / `postLoad` | 對入口與每個 `include`/`extends` 依賴檔案在主執行緒同步呼叫 | `UNSUPPORTED` | Step 1 / Step 4 / Step 6 |
| 外掛介面 | `preFilters` / `postFilters` / `preLink` / `postLink` / `preCodeGen` / `postCodeGen` | 管線各階段 AST / Code 同步轉換 hook | `UNSUPPORTED` | Step 4 / Step 6 |
| 外掛介面 | Replacement hooks (`resolve`, `read`, `generateCode`) | 多個 plugin 同時實作同名 replacement 時拋錯；支援 `Buffer` 回傳 | `UNSUPPORTED` | Step 4 / Step 6 |
| 外掛介面 | 內部擴充 (`plugin.lex`, `plugin.parse`) | 如 `#3295` tag interpolation 中的 `plugin.lex.advance` | `UNSUPPORTED` | Step 6 |

---

## 5. 已核准差異（Approved Differences）

| 差異 ID | 影響案例 | 狀態 | 說明 |
|---|---|---|---|
| `NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY` | `error.reporting > runtime errors > in a mixin`<br>`error.reporting > runtime errors > in a layout` | `APPROVED_DIFF` | Node.js 16+ / 22 (V8 9.3+) 將存取 `null`/`undefined` 屬性的 `TypeError` 訊息由 `Cannot read property 'length' of null/undefined` 改為 `Cannot read properties of null/undefined (reading 'length')`。同 Node 版本下 `raw/compiler` 與 `rust/compiler` 行為完全一致。 |
