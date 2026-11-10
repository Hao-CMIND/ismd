# Pug Rust Compiler 相容性追蹤矩陣 (`compat/matrix.md`)

> 本文件由 `node tests/differential/runner.js --write-matrix` 自動驗證並產生，對應 `PLAN.md` Step 0 相容基準與分層驗收分類。

## 1. 狀態標記定義

| 狀態碼 | 定義 |
|---|---|
| `PASS` | 與基準版本（`raw/compiler`）輸出、快照、錯誤欄位或雙層 Codegen 完全一致 |
| `FAIL` | 本階段已承諾功能與基準不一致、非預期拋錯，或回報不支援 |
| `DEFERRED` | 驗收前明列屬於後續階段（Step 4–6）且本輪不驗收之案例（不計為 PASS） |
| `BLOCKED` | 環境或原版／候選基準無法執行（不計為 PASS） |
| `APPROVED_DIFF` | 已登錄於 `compat/expected-differences.json` 的環境／平台差異（不計為完全相容通過） |

---

## 2. 各套件差異測試總覽

| 原版套件 | 對應 Rust Crate | 目標階段 | 追蹤案例數 | 原版基準 (`raw/compiler`) | Rust 目標 (`rust/compiler`) |
|---|---|---|---:|---|---|
| `pug-error` | `pug_error` | Step 1 | 8 | 8 PASS / 0 APPROVED_DIFF / 0 FAIL | 8 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-lexer` | `pug_lexer + pug_js` | Step 2 | 144 | 144 PASS / 0 APPROVED_DIFF / 0 FAIL | 144 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-strip-comments` | `pug_strip_comments` | Step 2 | 12 | 12 PASS / 0 APPROVED_DIFF / 0 FAIL | 12 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-parser` | `pug_parser + pug_ast` | Step 3 | 119 | 119 PASS / 0 APPROVED_DIFF / 0 FAIL | 119 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-walk` | `pug_walk` | Step 3 | 5 | 5 PASS / 0 APPROVED_DIFF / 0 FAIL | 5 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-load` | `pug_load` | Step 4 | 1 | 1 PASS / 0 APPROVED_DIFF / 0 FAIL | 1 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-filters` | `pug_filters + pug_js::constant` | Step 4 | 16 | 16 PASS / 0 APPROVED_DIFF / 0 FAIL | 16 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-linker` | `pug_linker` | Step 4 | 24 | 24 PASS / 0 APPROVED_DIFF / 0 FAIL | 24 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-attrs` | `pug_attrs` | Step 5 | 52 | 52 PASS / 0 APPROVED_DIFF / 0 FAIL | 0 PASS / 52 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug-runtime` | `pug_runtime` | Step 5 | 9 | 9 PASS / 0 APPROVED_DIFF / 0 FAIL | 9 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `pug` | `pug_code_gen + pug_compiler + pug_napi` | Step 1–6 | 330 | 328 PASS / 2 APPROVED_DIFF / 0 FAIL | 293 PASS / 37 DEFERRED / 0 BLOCKED / 0 FAIL |
| **合計** | — | **Step 0** | **720** | **718 PASS / 2 APPROVED_DIFF / 0 FAIL** | **631 PASS / 89 DEFERRED / 0 BLOCKED / 0 FAIL** |

> 註：`pug-code-gen` (`2.0.2`) 在原版 Monorepo 中無獨立 `test/` 資料夾，其單元與快照測試合併於 `pug` 主套件的 `cases/*.pug`、`compileClient` 快照與執行語意測試中驗收。

---

## 3. 依驗收分類統計

| 測試類別 | 追蹤案例數 | 原版基準 (`raw/compiler`) | Rust 目標 (`rust/compiler`) |
|---|---:|---|---|
| Token/AST | 273 | 273 PASS / 0 APPROVED_DIFF / 0 FAIL | 273 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| HTML | 131 | 131 PASS / 0 APPROVED_DIFF / 0 FAIL | 130 PASS / 1 DEFERRED / 0 BLOCKED / 0 FAIL |
| Execution Semantics | 12 | 12 PASS / 0 APPROVED_DIFF / 0 FAIL | 11 PASS / 1 DEFERRED / 0 BLOCKED / 0 FAIL |
| Filters/Plugins | 17 | 17 PASS / 0 APPROVED_DIFF / 0 FAIL | 15 PASS / 2 DEFERRED / 0 BLOCKED / 0 FAIL |
| API | 25 | 25 PASS / 0 APPROVED_DIFF / 0 FAIL | 16 PASS / 9 DEFERRED / 0 BLOCKED / 0 FAIL |
| Error | 87 | 85 PASS / 2 APPROVED_DIFF / 0 FAIL | 67 PASS / 20 DEFERRED / 0 BLOCKED / 0 FAIL |
| JS Artifact | 175 | 175 PASS / 0 APPROVED_DIFF / 0 FAIL | 119 PASS / 56 DEFERRED / 0 BLOCKED / 0 FAIL |

---

## 4. 公開 API、選項與外掛追蹤矩陣

| 類別 | 項目 | 原版基準行為 | 目前目標狀態 | 預計完成階段 |
|---|---|---|---|---|
| 公開 API | `pug.compile(str, options)` | 回傳附帶 `.dependencies` 的同步渲染函式 | `PARTIAL (Step 4 範圍)` | Step 1 / Step 3 / Step 4 / Step 6 |
| 公開 API | `pug.compileFile(path, options)` | 讀取檔案並支援 `exports.cache[path]` | `PARTIAL (Step 4 範圍)` | Step 4 / Step 6 |
| 公開 API | `pug.compileClient(str, options)` | 回傳 JS 函式原始碼字串（雙層驗收：Prettier + Raw） | `PARTIAL (Step 4 範圍)` | Step 1 / Step 3 / Step 4 / Step 5 |
| 公開 API | `pug.compileFileClient(path, options)` | 支援 `exports.cache[path + ':client']` 與 `name` | `DEFERRED (Step 5/6)` | Step 5 / Step 6 |
| 公開 API | `pug.compileClientWithDependenciesTracked(str, options)` | 回傳 `{ body, dependencies }` | `PARTIAL (Step 4 範圍)` | Step 1 / Step 3 / Step 4 / Step 5 |
| 公開 API | `pug.render(str, options, fn)` | 同步渲染或同步回呼 `fn(err, html)`；原始 `locals` 不經 JSON 序列化 | `PARTIAL (Step 4 範圍)` | Step 1 / Step 3 / Step 4 / Step 6 |
| 公開 API | `pug.renderFile(path, options, fn)` | 檔案同步渲染或同步回呼 `fn(err, html)` | `PARTIAL (Step 4 範圍)` | Step 4 / Step 6 |
| 公開 API | `pug.__express(path, options, fn)` | `NODE_ENV === 'production'` 且未指定 `compileDebug` 時預設 `false` | `DEFERRED (Step 6)` | Step 6 |
| 公開 API | `pug.cache` / `pug.filters` / `pug.runtime` / `pug.name` | 外部可直接讀寫 `cache` 與 `filters`；`name === 'Pug'` | `PASS (Step 1 骨架)` | Step 1 / Step 6 |
| 公開 API | `require('pug/register')` | 註冊 `require.extensions['.pug'] = pug.compileFile` | `PASS (Step 1 骨架)` | Step 1 / Step 6 |
| 編譯選項 | `pretty` / `doctype` / `self` / `globals` | 縮排字串、DOCTYPE 模式、`self` 命名空間與全域變數白名單 | `PASS (Step 4 範圍)` | Step 3 / Step 5 |
| 編譯選項 | `compileDebug` / `includeSources` / `debug` | 保留 `compile` 與 `compileClient` 預設差異 | `PASS (Step 4 範圍)` | Step 3 / Step 5 / Step 6 |
| 編譯選項 | `inlineRuntimeFunctions` / `name` / `module` | 內嵌 `pug_*` 依賴展開或 `runtimeWrap` / `require("pug-runtime")` | `PASS (Step 4 範圍)` | Step 1 / Step 3 / Step 5 |
| 編譯選項 | `filename` / `basedir` | Node `path` 相容解析，不任意 `fs::canonicalize` | `PASS (Step 4 範圍)` | Step 4 |
| 外掛介面 | `preLex` / `postLex` / `preParse` / `postParse` / `preLoad` / `postLoad` | 對入口與每個 `include`/`extends` 依賴檔案在主執行緒同步呼叫 | `PASS (Step 4 範圍)` | Step 1 / Step 4 / Step 6 |
| 外掛介面 | `preFilters` / `postFilters` / `preLink` / `postLink` / `preCodeGen` / `postCodeGen` | 管線各階段 AST / Code 同步轉換 hook | `PASS (Step 4 範圍)` | Step 4 / Step 6 |
| 外掛介面 | Replacement hooks (`resolve`, `read`, `generateCode`) | 多個 plugin 同時實作同名 replacement 時拋錯；支援 `Buffer` 回傳 | `PASS (Step 4 範圍)` | Step 4 / Step 6 |
| 外掛介面 | 內部擴充 (`plugin.lex`, `plugin.parse`) | 如 `#3295` tag interpolation 中的 `plugin.lex.advance` | `DEFERRED (Step 6)` | Step 6 |

---

## 5. Step 4 節點與編譯選項支援矩陣（四種能力分界）

| 類別 | AST 節點 / 編譯選項 | 可解析 (`pug_parser`) | 可走訪 (`pug_walk`) | 可產生 JS (`pug_code_gen`) | 可渲染 (`Node VM + locals`) | 延後完成階段與說明 |
|---|---|:---:|:---:|:---:|:---:|---|
| AST 節點 | `Block` / `Tag` / `InterpolatedTag` / `Text` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（含 inline tags、block expansion、text interpolation） |
| AST 節點 | `Comment` / `BlockComment` / `Doctype` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（含 conditional comments 與 doctype 模式） |
| AST 節點 | `Code`（buffered / unbuffered / 附帶 `block`） | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（保留完整 JS 上下文與行號追蹤） |
| AST 節點 | `Conditional` (`if` / `else if` / `else` / `unless`) | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | `Each`（含 `key` 與 `else` 替代區塊）/ `EachOf` / `While` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | `Case` / `When` (`default` / `block`) | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | `AttributeBlock` (`&attributes`) 與靜態/動態屬性 | ✅ | ✅ | ✅ | ✅ | Step 3–4 已支援基本與 Mixin 屬性合併；完整 `pug-attrs` 52 筆獨立快照於 Step 5 收斂 |
| AST 節點 | `Filter` / `IncludeFilter` | ✅ | ✅ | ✅ | ✅ | Step 4B 已完成（`pug_filters` 編譯期常數選項、filter 執行與 JSTransformer 橋接） |
| AST 節點 | `Include` / `RawInclude` / `Extends` / `FileReference` | ✅ | ✅ | ✅ | ✅ | Step 4A/4C 已完成（`pug_load` 遞迴讀檔與 `pug_linker` 模板連結） |
| AST 節點 | `NamedBlock` (`block` / `append` / `prepend`) / `YieldBlock` | ✅ | ✅ | ✅ | ✅ | Step 4C 已完成（`pug_linker` 繼承合併、`yield` 替換與 `Codegen` 走訪） |
| AST 節點 | `Mixin`（定義與呼叫）/ `MixinBlock` | ✅ | ✅ | ✅ | ✅ | Step 4D 已完成（定義、參數/rest、動態名稱、繼承位置與 block/attributes 傳遞）；完整選項與 attrs 收斂於 Step 5 |
| 編譯選項 | `pretty` / `doctype` / `self` / `globals` | ✅ | ✅ | ✅ | ✅ | Step 3–4 已完成基本與語意支援；全組合於 Step 5 收斂 |
| 編譯選項 | `compileDebug` / `includeSources` / `inlineRuntimeFunctions` | ✅ | ✅ | ✅ | ✅ | Step 3–4 已完成（保留 `compile` 預設 `compileDebug !== false` 與 `compileClient` 預設 `false`） |
| 編譯選項 | `filename` / `basedir`（多檔案相對/絕對路徑解析） | ✅ | ✅ | ✅ | ✅ | Step 4A 已完成（`pug_load` 跨檔案依賴解析） |
| 外掛擴充 | `plugin.parse` / `plugin.lex` | ❌ (`DEFERRED`) | ❌ (`DEFERRED`) | ❌ (`DEFERRED`) | ❌ (`DEFERRED`) | Step 6（完整 Node Plugin 相容驗收） |

---

## 6. 已核准差異（Approved Differences）

| 差異 ID | 影響案例 | 狀態 | 說明 |
|---|---|---|---|
| `NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY` | `error.reporting > runtime errors > in a mixin`<br>`error.reporting > runtime errors > in a layout` | `APPROVED_DIFF` | Node.js 16+ / 22 (V8 9.3+) 將存取 `null`/`undefined` 屬性的 `TypeError` 訊息由 `Cannot read property 'length' of null/undefined` 改為 `Cannot read properties of null/undefined (reading 'length')`。同 Node 版本下 `raw/compiler` 與 `rust/compiler` 行為完全一致。 |
