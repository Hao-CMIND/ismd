# OXC / V8 / Rust 各自執行項目分工表

> 對應專案：`rust/compiler/`（[Cargo.toml](../../rust/compiler/Cargo.toml) 與 [index.js](../../rust/compiler/index.js)）

---

## 1. Rust（本體編譯管線與 NAPI 橋接）

負責 Pug 模板從詞法分析到產出 JS Function Body 字串的核心編譯工作（不含 OXC 與 V8 項目）：

- **詞法與注釋處理**：`pug_lexer`（詞法掃描產出 Token）、`pug_strip_comments`（移除/保留注釋 Token）
- **語法樹建置與走訪**：`pug_parser`（Tokens → Pug AST）、`pug_walk`（AST 遍歷）
- **檔案載入與連結**：`pug_load`（遞迴載入 `extends` / `include`）、`pug_linker`（合併版型 `block` / `append` / `prepend` / `yield`）、預設路徑解析 `default_resolve` 與原生效能讀檔 `std::fs::read`
- **Filter 前處理**：`pug_filters`（掃描 AST filter 節點、alias 轉譯、呼叫常數求值後透過 NAPI 委派 V8 執行 filter）
- **屬性與程式碼生成**：`pug_attrs`（靜態/動態屬性編譯與合併）、`pug_code_gen`（生成 HTML 拼接與 control-flow JS 字串）、`pug_runtime`（內聯/建置所需 runtime helper）、`pug_error`（錯誤結構與定位格式）
- **FFI 橋接與序列化**：`pug_napi`（接收 NAPI 參數、`serde_json` ↔ V8 值轉換、依條件觸發 JS callbacks、回傳編譯結果字串與依賴清單）

---

## 2. OXC（Rust 內的 JavaScript 靜態解析與語意分析）

以 Rust crate `oxc`（`=0.157.0`）嵌入於 [`crates/pug_js`](../../rust/compiler/crates/pug_js/Cargo.toml)，專門處理 Pug 模板中夾帶的 JS 片段（在 Rust 進程內執行，不進 V8）：

- **JS 表達式語法驗證**：[`expression.rs`](../../rust/compiler/crates/pug_js/src/expression.rs)（`validate_expression` / `is_expression`）使用 `oxc::parser::Parser` 驗證屬性值、插值、條件等 JS 表達式語法與錯誤行欄位置（對標原版 `is-expression`）
- **編譯期常數判斷與求值**：[`constant.rs`](../../rust/compiler/crates/pug_js/src/constant.rs)（`eval_constant` / `is_constant` / `eval_filter_constant`）先以 OXC 解析為 JS AST，再於編譯期計算純常數屬性與 filter options（對標原版 `constantinople`）
- **Scope 與自由變數分析**：[`scope.rs`](../../rust/compiler/crates/pug_js/src/scope.rs)（`analyze_scope` / `find_free_variables` / `is_valid_js_identifier`）透過 `oxc::parser::Parser` + `oxc::semantic::SemanticBuilder` 找出未宣告的自由變數與 top-level `return`，供 `with (locals)` 變數綁定使用（對標原版 `with`）

---

## 3. V8（Node.js 宿主層、相容回呼與模板渲染）

負責 Node.js 執行環境互動、JS 生態系套件與最終模板函式的編譯執行：

- **模組載入與外圍封裝**：[`index.js`](../../rust/compiler/index.js) 載入 `.node` 原生模組、處理 `options.cache` 快取、以 `fs.readFileSync` 讀入入口 `.pug` 檔、轉換錯誤物件
- **Plugin Lifecycle Callbacks（透過 NAPI 呼回 V8）**：執行使用者 `plugins` 的 `preLex` / `postLex` / `preParse` / `postParse` / `preLoad` / `postLoad` / `preFilters` / `postFilters` / `preLink` / `postLink` / `preCodeGen` / `postCodeGen`（目前即使 `plugins` 為空仍預設掛載，並執行 `reviveAstBuffers` / `dehydrateAstBuffers`）
- **外部檔案與 Filter 執行（透過 NAPI 呼回 V8）**：`resolve` / `read`（`fs.readFileSync` 或自訂 hook），以及透過 `jstransformer` / `options.filters` 執行 `:markdown` 等 filter
- **JS 函式編譯**：[`runtime/wrap.js`](../../rust/compiler/runtime/wrap.js) 透過 `Function(...)`（或 `new Function(...)`）將 Rust 產出的 JS 字串編譯成可執行函式 `template(locals)`
- **模板渲染執行**：實際執行 `fn(locals)` 與 [`runtime/index.js`](../../rust/compiler/runtime/index.js) 中的 JS runtime helpers，組裝並輸出最終 HTML 字串
