# 效能分析與優化項目清單

本文件整理 `rust/compiler`（`pug-rust-compiler`）與原版基準 `raw/compiler`（`pug@2.0.4`）在本機環境下的實測效能表現、瓶頸定位與後續優化建議。

---

## 一、實測數據對比

- **測試環境**：Windows `x64`、Node.js `v22.23.3`
- **測試對象**：`rust/compiler` vs `raw/compiler/packages/pug`
- **測試樣本**：`raw/compiler/packages/pug/test/cases/mixins.pug`（預熱 10 次後連續執行 200 次，`compileDebug: false`）與單檔冷啟動渲染

### 1. 建置產物大小對比

| 產物版本 | 檔案路徑 | 檔案大小 |
| :--- | :--- | :---: |
| Debug 版 | `target/debug/pug_napi.dll` | `10,072,064` bytes（約 9.61 MB） |
| Release 版 | `target/release/pug_napi.dll` / `pug-napi.win32-x64-msvc.node` | `3,822,080` bytes（約 3.64 MB） |

### 2. 執行耗時對比

| 測試項目 | Rust Debug 版 | Rust Release 版 | 原版 `raw/compiler` |
| :--- | :---: | :---: | :---: |
| 純模組載入（`import` / `require`） | `5.82 ms` | — | `119.08 ms` |
| 開新 Node 程序冷啟動渲染單檔 | `55.6 ms` | `96.2 ms` *(註)* | `168.1 ms` / `235.1 ms` *(註)* |
| `compile`（`mixins.pug` × 200 次平均） | `11.49 ms / 次` | `7.15 ms / 次` | `1.74 ms / 次` |
| `compileClient`（`mixins.pug` × 200 次平均） | `10.97 ms / 次` | `6.78 ms / 次` | `1.49 ms / 次` |
| `render`（`mixins.pug` × 200 次平均） | `10.49 ms / 次` | `6.83 ms / 次` | `1.41 ms / 次` |
| 純 `lex` 階段（`mixins.pug` × 200 次平均） | — | `0.40 ms / 次` | `0.72 ms / 次` |

> *(註)* 兩組冷啟動數據分別來自兩次不同時段量測（同組內對照：`rust` 約為 `raw` 的 2.4～3 倍快）。

### 3. 數據解讀

- **冷啟動與載入速度明顯領先**：原版 `raw` 需載入大量 CommonJS 子套件與依賴樹；`rust/compiler` 將整個編譯管線與 `oxc` 收斂進單一 `.node` 原生模組，載入時間大幅縮短，適合 CLI 短任務與多 `worker_threads` 平行處理。
- **純 Rust 階段具效能優勢**：單看 `lex` 階段（含跨一次 NAPI），Release 版已比原版 JS 快近 2 倍（`0.40 ms` vs `0.72 ms`）。
- **完整 `compile` 目前反而慢於原版**：即使開啟 `--release`，`compile` 單次仍需 `7.15 ms`（原版熱身後為 `1.74 ms`），主要耗時並不在 Rust 運算本身，而是被不必要的 NAPI 來回序列化吃掉。

---

## 二、目前問題出在哪裡？

### 1. 最大瓶頸：`compileBody` 無條件掛載 11 個 NAPI Hook（AST 重複序列化 8 次）

Rust 端 [`crates/pug_napi/src/lib.rs`](crates/pug_napi/src/lib.rs) 中的 `NodeHostAdapter` 其實已經具備條件跳過機制：透過 `get_optional_val` 檢查 JS 傳入的 `callbacks` 物件，若對應 hook 未提供或為 `undefined` / `null`，就會直接略過序列化與 JS callback 呼叫。

然而 [`index.js`](index.js) 中的 `compileBody` 目前僅對 `resolve` 與 `generateCode` 做了條件掛載；其餘以下 hooks **無論使用者是否傳入 `plugins`，全部無條件掛載為函式**：

- 字串 / Token 階段：`preLex`、`postLex`、`preParse`、`postCodeGen`
- AST 階段：`postParse`、`preLoad`、`postLoad`、`preFilters`、`postFilters`、`preLink`、`postLink`、`preCodeGen`

其中 8 個 AST hook 每次呼叫都會觸發：
1. Rust：`serde_json::to_value` → `env.to_js_value`（整棵 AST 跨 NAPI 序列化傳給 JS）
2. JS：`reviveAstBuffers(ast)` → `applyPlugins(...)` → `dehydrateAstBuffers(...)`
3. Rust：`env.from_js_value` → `serde_json::from_value`（反序列化回 Rust `BlockNode`）

**即使完全沒有使用任何 `plugins`，每次編譯仍白白進行 8 次整棵 AST 的跨邊界序列化與結構轉換。**

### 2. 次要跨界瓶頸：`read` 與 `filter` callback 無條件掛載

- [`index.js`](index.js) 的 `compileBody` 即使沒有自訂 `read` plugin，依然傳入 `read` callback，導致 `include` / `extends` 每次讀檔都從 Rust 跳回 JS 執行 `fs.readFileSync`，無法直接走 `crates/pug_compiler/src/lib.rs` 中 `CompilerHost::load_file` 預設的 `std::fs::read`。
- `filter` callback 同樣總是傳入，即使沒有自訂 JS filter 也會進行建立與傳遞。

### 3. 結構性成本：動態 JS 編譯與執行

- `pug_compiler` 的產物是 JavaScript 函式原始碼（而非直接輸出 HTML）。
- `compile` 與 `runtime/wrap.js` 拿到產物後，仍需透過 `Function(...)` 讓 V8 解析與編譯該動態函式才能執行輸出 HTML。在單次編譯即丟棄的批次 `.pug` → `.html` 場景下，這個動態函式建立成本無法跨檔攤平。

### 4. 建置流程預設為 Debug 版

- [`package.json`](package.json) 的 `"build"` 腳本預設為 `cargo build -p pug_napi`（未加 `--release`）。
- [`Cargo.toml`](Cargo.toml) 尚未配置 `[profile.release]`（如 `lto`、`codegen-units`）。
- [`index.js`](index.js) 內的 `loadNativeAddon()` 會優先載入已存在的 `pug-napi.win32-x64-msvc.node`；若未先刪除或覆蓋舊的 `.node`，即使重新編譯了 Release 版 `.dll`，程式仍會繼續載入舊版 `.node`。

---

## 三、優化項目清單

### 【P0】`index.js` 改為按需掛載 `hostCallbacks`（最高效益、風險最低）

- **修改位置**：[`index.js`](index.js) 的 `compileBody`
- **做法**：
  - 先檢查 `plugins` 陣列中實際有定義哪些生命週期方法（`preLex`、`postLex`、`preParse`、`postParse`、`preLoad`、`postLoad`、`preFilters`、`postFilters`、`preLink`、`postLink`、`preCodeGen`、`postCodeGen`）。
  - 只有當至少一個 plugin 實作該方法時才放入 `hostCallbacks`，否則該欄位設為 `undefined`。
  - 無 `customRead` plugin 時，`read` 設為 `undefined`，讓 Rust 直接使用 `default_resolve` + `std::fs::read`。
  - 當 `filtersSet` 為空（無全域或單次 `filters`）時，`filter` 設為 `undefined`。
- **預期效益**：在無 plugin 的常見情境下，完全消除 8 次 AST 序列化與多次 Token/I/O 跨界呼叫，讓 NAPI 邊界降為「單次進入 Rust、單次傳回結果 JS 字串」。

### 【P1】補齊 Release Profile 與建置更新腳本

- **修改位置**：[`Cargo.toml`](Cargo.toml)、[`package.json`](package.json)
- **做法**：
  - 在 `Cargo.toml` 新增 `[profile.release]`（例如評估 `lto = "thin"`、`codegen-units = 1`）。
  - 在 `package.json` 新增 `build:release` 腳本，於編譯完成後自動將 `target/release/pug_napi.dll` 複製覆蓋 `pug-napi.win32-x64-msvc.node`，避免開發或測試時誤載舊版 `.node`。

### 【P1】新增入口檔案的純 Rust 讀取 Fast Path（針對 `compileFile` / `renderFile`）

- **修改位置**：[`crates/pug_napi/src/lib.rs`](crates/pug_napi/src/lib.rs)、[`index.js`](index.js)
- **做法**：
  - 目前 `compileFile` / `renderFile` 先在 JS 端 `fs.readFileSync`，再將完整模板字串跨 NAPI 複製進 Rust。
  - 若無 `preLex` 與自訂 `read` plugin，可直接將入口檔案路徑傳給 Rust 讀取，減少一次 JS I/O 與大型字串跨界拷貝。

### 【P2】優化有使用 Plugin 時的 `NodeHostAdapter` 轉換與查找成本

- **修改位置**：[`crates/pug_napi/src/lib.rs`](crates/pug_napi/src/lib.rs)
- **做法**：
  - 目前 `call_json_hook` / `call_ctx_json_hook` 每次都會先經 `serde_json::Value` 再轉 NAPI JS 值（雙重記憶體配置），且每個檔案階段都會重複執行 `has_named_property`。
  - 可快取已解析的 `callbacks` 欄位狀態，並評估減少中介 `serde_json::Value` 的配置成本。

### 【P2】多檔案 `.pug` → `.html` 批次編譯最佳實踐

- **架構限制**：`compile_body_sync` 為同步 API（支援同步 JS plugin/filter callbacks），單執行緒內使用 `async` / `Promise.all` 並不會平行運算。
- **建議做法**：
  - 檔案數量少（數十個以內）：單執行緒同步迴圈呼叫 `renderFile(..., { compileDebug: false })` + `fs.writeFileSync` 即可，啟動開銷最低。
  - 檔案數量龐大（數百～上千個以上）：在完成 P0 優化後，搭配固定數量（如 `os.availableParallelism()`）的 `node:worker_threads` 工作池平行編譯，並在正式產出靜態 `.html` 時設定 `compileDebug: false`、視需求關閉 `pretty`、批次建置不啟用 `cache: true`。

### 【P3】純靜態模板直出 HTML（僅限特定場景、不列入相容主線）

- **適用條件**：完全不使用 `- for(...)`、`#{expr}` 等動態 JS 語法、僅包含靜態 HTML 結構與 `include`/`extends` 的子集。
- **做法**：在 Rust 端實作靜態 `AST → HTML` 輸出器，可完全跳過 `pug_code_gen` 與 V8 `new Function` 執行。
- **限制**：只要模板需要完整 Pug 語法（包含任何 JS 表達式或控制流），仍必須交由 JS 引擎（如 Node.js V8）執行。
