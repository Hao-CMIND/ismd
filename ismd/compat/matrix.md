# Ismd Rust Compiler 相容性追蹤矩陣 (`compat/matrix.md`)

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

| 原版套件 | 對應 Rust Crate | 目標階段 | 追蹤案例數 | 原版基準 (`raw/compiler`) | Rust 目標 (`ismd`) |
|---|---|---|---:|---|---|
| `ismd-error` | `ismd_error` | Step 1 | 8 | 8 PASS / 0 APPROVED_DIFF / 0 FAIL | 8 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-lexer` | `ismd_lexer + ismd_js` | Step 2 | 144 | 144 PASS / 0 APPROVED_DIFF / 0 FAIL | 144 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-strip-comments` | `ismd_strip_comments` | Step 2 | 12 | 12 PASS / 0 APPROVED_DIFF / 0 FAIL | 12 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-parser` | `ismd_parser + ismd_ast` | Step 3 | 119 | 119 PASS / 0 APPROVED_DIFF / 0 FAIL | 119 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-walk` | `ismd_walk` | Step 3 | 5 | 5 PASS / 0 APPROVED_DIFF / 0 FAIL | 5 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-load` | `ismd_load` | Step 4 | 1 | 1 PASS / 0 APPROVED_DIFF / 0 FAIL | 1 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-filters` | `ismd_filters + ismd_js::constant` | Step 4 | 16 | 16 PASS / 0 APPROVED_DIFF / 0 FAIL | 16 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-linker` | `ismd_linker` | Step 4 | 24 | 24 PASS / 0 APPROVED_DIFF / 0 FAIL | 24 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-attrs` | `ismd_attrs` | Step 5 | 58 | 58 PASS / 0 APPROVED_DIFF / 0 FAIL | 58 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd-runtime` | `ismd_runtime` | Step 5 | 9 | 9 PASS / 0 APPROVED_DIFF / 0 FAIL | 9 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| `ismd` | `ismd_code_gen + ismd_compiler + ismd_napi` | Step 1–6 | 330 | 328 PASS / 2 APPROVED_DIFF / 0 FAIL | 330 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| **合計** | — | **Step 0** | **726** | **724 PASS / 2 APPROVED_DIFF / 0 FAIL** | **726 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL** |

> 註：`ismd-code-gen` (`2.0.2`) 在原版 Monorepo 中無獨立 `test/` 資料夾，其單元與快照測試合併於 `ismd` 主套件的 `cases/*.ismd` 與執行語意測試中驗收（`compileClient` 系列 API 已於後續移除）。

---

## 3. 依驗收分類統計

| 測試類別 | 追蹤案例數 | 原版基準 (`raw/compiler`) | Rust 目標 (`ismd`) |
|---|---:|---|---|
| Token/AST | 273 | 273 PASS / 0 APPROVED_DIFF / 0 FAIL | 273 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| HTML | 131 | 131 PASS / 0 APPROVED_DIFF / 0 FAIL | 131 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| Execution Semantics | 12 | 12 PASS / 0 APPROVED_DIFF / 0 FAIL | 12 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| Filters/Plugins | 17 | 17 PASS / 0 APPROVED_DIFF / 0 FAIL | 17 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| API | 25 | 25 PASS / 0 APPROVED_DIFF / 0 FAIL | 25 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| Error | 87 | 85 PASS / 2 APPROVED_DIFF / 0 FAIL | 87 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |
| JS Artifact | 181 | 181 PASS / 0 APPROVED_DIFF / 0 FAIL | 181 PASS / 0 DEFERRED / 0 BLOCKED / 0 FAIL |

---

## 4. 公開 API、選項與外掛追蹤矩陣

| 類別 | 項目 | 原版基準行為 | 目前目標狀態 | 預計完成階段 |
|---|---|---|---|---|
| 公開 API | `ismd.compile(str, options)` | 回傳附帶 `.dependencies` 的同步渲染函式 | `PASS (Step 6)` | Step 1–6 |
| 公開 API | `ismd.compileFile(path, options)` | 讀取檔案並支援 `exports.cache[path]` | `PASS (Step 6)` | Step 4 / Step 6 |
| 公開 API | `ismd.compileClient` 系列 | 已完整移除（僅保留伺服端與預編譯 AST/SSR 渲染） | `REMOVED` | 已移除 |
| 公開 API | `ismd.render(str, options, fn)` | 同步渲染或同步回呼 `fn(err, html)`；原始 `locals` 不經 JSON 序列化 | `PASS (Step 6)` | Step 1–6 |
| 公開 API | `ismd.renderFile(path, options, fn)` | 檔案同步渲染或同步回呼 `fn(err, html)` | `PASS (Step 6)` | Step 4 / Step 6 |
| 公開 API | `ismd.__express(path, options, fn)` | `NODE_ENV === 'production'` 且未指定 `compileDebug` 時預設 `false` | `PASS (Step 6)` | Step 6 |
| 公開 API | `ismd.cache` / `ismd.filters` / `ismd.runtime` / `ismd.name` | 外部可直接讀寫 `cache` 與 `filters`；`name === 'Ismd'` | `PASS (Step 6)` | Step 1 / Step 6 |
| 公開 API | `require('ismd/register')` | 註冊 `require.extensions['.ismd'] = compileTemplate` | `PASS (Step 6)` | Step 1 / Step 6 |
| 編譯選項 | `pretty` / `doctype` / `self` / `globals` | 縮排字串、DOCTYPE 模式、`self` 命名空間與全域變數白名單 | `PASS (Step 5/6)` | Step 3 / Step 5 |
| 編譯選項 | `compileDebug` / `includeSources` / `debug` | 保留 `compile` 預設值與警告／除錯輸出（`compileClient` 已移除） | `PASS (Step 5/6)` | Step 3 / Step 5 / Step 6 |
| 編譯選項 | `inlineRuntimeFunctions` / `name` / `module` | 內嵌 `ismd_*` 依賴展開或 `runtimeWrap` / `require("ismd-runtime")` | `PASS (Step 5/6)` | Step 1 / Step 3 / Step 5 |
| 編譯選項 | `filename` / `basedir` | Node `path` 相容解析，不任意 `fs::canonicalize` | `PASS (Step 4/6)` | Step 4 |
| 外掛介面 | `preLex` / `postLex` / `preParse` / `postParse` / `preLoad` / `postLoad` | 對入口與每個 `include`/`extends` 依賴檔案在主執行緒同步呼叫 | `PASS (Step 6)` | Step 1 / Step 4 / Step 6 |
| 外掛介面 | `preFilters` / `postFilters` / `preLink` / `postLink` / `preCodeGen` / `postCodeGen` | 管線各階段 AST / Code 同步轉換 hook | `PASS (Step 6)` | Step 4 / Step 6 |
| 外掛介面 | Replacement hooks (`resolve`, `read`, `generateCode`) | 多個 plugin 同時實作同名 replacement 時拋錯；支援 `Buffer` 回傳 | `PASS (Step 6)` | Step 4 / Step 6 |
| 外掛介面 | 內部擴充 (`plugin.lex`, `ismd-parser` plugin contexts) | 如 `#3295` tag interpolation 中的 `plugin.lex.advance` 已原生橋接；原版未測試之 `ismd-parser` context hooks 尚未實作 | `PASS (plugin.lex) / N/A (parser context 未使用)` | Step 6 |

---

## 5. 節點、編譯選項與外掛支援矩陣（Step 6 完整狀態）

| 類別 | AST 節點 / 編譯選項 | 可解析 (`ismd_parser`) | 可走訪 (`ismd_walk`) | 可產生 JS (`ismd_code_gen`) | 可渲染 (`Node VM + locals`) | 完成階段與說明 |
|---|---|:---:|:---:|:---:|:---:|---|
| AST 節點 | `Block` / `Tag` / `InterpolatedTag` / `Text` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（含 inline tags、block expansion、text interpolation） |
| AST 節點 | `Comment` / `BlockComment` / `Doctype` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（含 conditional comments 與 doctype 模式） |
| AST 節點 | `Code`（buffered / unbuffered / 附帶 `block`） | ✅ | ✅ | ✅ | ✅ | Step 3 已完成（保留完整 JS 上下文與行號追蹤） |
| AST 節點 | `Conditional` (`if` / `else if` / `else` / `unless`) | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | `Each`（含 `key` 與 `else` 替代區塊）/ `EachOf` / `While` | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | `Case` / `When` (`default` / `block`) | ✅ | ✅ | ✅ | ✅ | Step 3 已完成 |
| AST 節點 | `AttributeBlock` (`&attributes`) 與靜態/動態屬性 | ✅ | ✅ | ✅ | ✅ | Step 5 已完成 `ismd_attrs` 52 筆獨立快照與執行等價收斂 |
| AST 節點 | `Filter` / `IncludeFilter` | ✅ | ✅ | ✅ | ✅ | Step 4B 已完成（`ismd_filters` 編譯期常數選項、filter 執行與 JSTransformer 橋接） |
| AST 節點 | `Include` / `RawInclude` / `Extends` / `FileReference` | ✅ | ✅ | ✅ | ✅ | Step 4A/4C 已完成（`ismd_load` 遞迴讀檔與 `ismd_linker` 模板連結） |
| AST 節點 | `NamedBlock` (`block` / `append` / `prepend`) / `YieldBlock` | ✅ | ✅ | ✅ | ✅ | Step 4C 已完成（`ismd_linker` 繼承合併、`yield` 替換與 `Codegen` 走訪） |
| AST 節點 | `Mixin`（定義與呼叫）/ `MixinBlock` | ✅ | ✅ | ✅ | ✅ | Step 4D/5 已完成（定義、參數/rest、動態名稱、繼承位置與 block/attributes 合併傳遞） |
| 編譯選項 | `pretty` / `doctype` / `self` / `globals` | ✅ | ✅ | ✅ | ✅ | Step 5 已完成多選項組合、void-elements 與 terse/xml 收斂 |
| 編譯選項 | `compileDebug` / `includeSources` / `inlineRuntimeFunctions` | ✅ | ✅ | ✅ | ✅ | Step 5/6 已完成全部選項與 Runtime helper 依賴展開組合 |
| 編譯選項 | `filename` / `basedir`（多檔案相對/絕對路徑解析） | ✅ | ✅ | ✅ | ✅ | Step 4A 已完成（`ismd_load` 跨檔案依賴解析） |
| 外掛擴充 | `plugin.lex`（lexer method 擴充 + nested interpolation） | ✅ | ✅ | ✅ | ✅ | Step 6 已透過 `LexerPluginHook` / `NapiLexBridge` 完成 `plugin.lex` 全方法橋接 |

---

## 6. 已核准差異（Approved Differences）

| 差異 ID | 影響案例 | 狀態 | 說明 |
|---|---|---|---|
| `NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY` | `error.reporting > runtime errors > in a mixin`<br>`error.reporting > runtime errors > in a layout` | `APPROVED_DIFF` | Node.js 16+ / 22 (V8 9.3+) 將存取 `null`/`undefined` 屬性的 `TypeError` 訊息由 `Cannot read property 'length' of null/undefined` 改為 `Cannot read properties of null/undefined (reading 'length')`。同 Node 版本下 `raw/compiler` 與 `ismd` 行為完全一致。 |
