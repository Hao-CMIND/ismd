# Pug Rust Compiler Step 1～3 獨立驗收報告 (`AUDIT.md`)

- **驗收時間**：`2026-11-10T11:10:24+08:00` ～ `2026-11-10T11:36:00+08:00`
- **驗收目錄**：[`d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/)
- **獨立驗收腳本**：[`d:/pug-rust/rust/compiler/tests/audit/step1-3/audit-runner.js`](file:///d:/pug-rust/rust/compiler/tests/audit/step1-3/audit-runner.js)
- **結構化驗收結果**：[`results.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/results.json)

---

## 1. 結論摘要

| 驗收項目 | 判定狀態 | 關鍵證據與說明 |
| :--- | :---: | :--- |
| **序列化比較器 (`serializers.js`)** | **通過 (`PASS`)** | 5 項受控反例（Token/AST 座標與欄位差異、`undefined`/缺欄位 vs `null`、Prettier 相同但原始 JS 字串不同、callback/getter 順序差異、預期拋錯未拋出與 HTML 空白差異）100% 準確攔截。 |
| **既有差異測試 Runner (`runner.js`)** | **不通過（存在假通過風險 `FAIL_FALSE_POSITIVES_FOUND`）** | 發現 **2 項 High** 與 **1 項 Medium** 測試器缺陷（`ISSUE-TEST-01`～`03`）：`runner.js` 在 `cases/*.pug` 中將「成功編譯但 HTML 比對不符」與「非 `UNSUPPORTED` 例外」一律標記為 `UNSUPPORTED` 而非 `FAIL`，掩蓋了 8 個實際失敗案例；且有 5 個 API 測試群組（計 25 個案例數）僅檢查 `typeof fn === 'function'` 即計為 `PASS`。 |
| **Step 1：最小端到端與 NAPI 接線** | **通過 (`PASS`)** | 9/9 獨立檢查全數通過：原生模組 `.node` 建置與載入驗證、`pug_error` 10 組欄位與 UTF-16 座標對齊、`pug.render('p Hello')`、函式/原型鏈/Getter/循環參照 `locals`（證明未經 JSON 序列化）、`Buffer` 輸入支援、12 階段同步 Host Callbacks 順序/回傳值/跨 FFI 例外身分保留與重入（re-entrancy）。 |
| **Step 2：Lexer、註解與 JS 邊界** | **通過 (`PASS`)** | `pug-lexer` 118 組 Token 快照 + 26 組錯誤快照（144/144）、`pug-strip-comments` 6 組案例 × 4 種選項組合（24/24）+ 3 組錯誤案例（3/3）、`character-parser` 92 組案例、Regex vs 除法、巢狀 `${...}` Template Literal、CJK/Emoji/BOM/CRLF/CR/Tab 座標、結尾多餘 token 拒絕全數通過。 |
| **Step 3A：Parser／Walk** | **部分通過 (`PARTIAL_FAIL`)** | **Parser 100% 通過**：第一層隔離 Parser（119/119）與第二層完整前端管線 `Pug -> Lexer -> StripComments -> Parser`（233/233）全數與原版一致。<br>**Walk 發現 1 項 Medium 缺陷 (`ISSUE-IMPL-05`)**：[`index.js`](file:///d:/pug-rust/rust/compiler/index.js#L165-L231) 的 `walkAST` 每步以新陣列覆寫 `options.parents = step.parents`（未如原版原地 `unshift`/`shift` 修改同一陣列參照），且未傳入 `after` callback 時結束後 `options.parents` 殘留未清空。 |
| **Step 3B：核心 Codegen、Attrs 與單檔編譯** | **部分通過 (`PARTIAL_FAIL`)** | 控制流程（`if`/`else`/`unless`、`each` 含 `else`、`each...of`、`while`、`case`/`when`、unbuffered code）與 `pug_runtime` 通過；但發現 **2 項 High** 與 **1 項 Medium** 實作缺陷：<br>1. `ISSUE-IMPL-01`（High）：[`constant.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/constant.rs#L86-L88) 將常數整數 `f64` 轉為 `serde_json::Number::from_f64`，導致 `div(foo=1 + 2)` 輸出 `<div foo="3.0"></div>`（應為 `"3"`），影響 `attrs`、`attrs-data`、`code`。<br>2. `ISSUE-IMPL-02`（High）：[`pug_code_gen/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L335-L348) 在遇到 `<html>` 標籤但未宣告 doctype 時誤呼叫 `set_doctype("html")`，多輸出 `<!DOCTYPE html>` 並開啟 `terse` 模式，影響 `pug.render('html')`、`basic`、`case`、`case-blocks`、`source`。<br>3. `ISSUE-IMPL-03`（Medium）：裸 `doctype` 關鍵字輸出 `<!DOCTYPE >` 而非 `<!DOCTYPE html>`，影響 `doctype.default`。 |
| **Step 3C：Scope／With 語意與邊界** | **部分通過 (`PARTIAL_FAIL`)** | 9 大語意矩陣中有 8 大類（宣告與遮蔽、`locals` 自有/原型鏈/全域回退、Getter 呼叫次數/字典序/時機、指定運算、分析邊界、生成名稱衝突避開、多層控制流與錯誤階段、`self`/`globals` 選項）完全通過；但第 5 類（執行環境 `arguments`）發現 **1 項 Medium 缺陷 (`ISSUE-IMPL-04`)**：[`scope.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/scope.rs#L91-L96) 未排除一般 `function` 內部的隱式 `arguments` 綁定，將其誤判為頂層自由變數並加入 IIFE 參數 `(function (arguments, ...) { ... })`。 |

---

## 2. 規格與環境

### 2.1 採用規格與修訂狀態檢查

- **採用規格檔案**：[`d:/pug-rust/rust/compiler/PLAN.md`](file:///d:/pug-rust/rust/compiler/PLAN.md)
  - **SHA-256**：`2459e963dddf90266c6c7bf104385dd0aac96b08eb62f81c9aa870fbf8e31357`
  - **修訂包含確認**：目前工作目錄中的 `PLAN.md` **已包含** Step 3A／3B／3C 拆分、Step 3B 前置能力（`pug_attrs`、`pug_runtime`、基礎 `pug_js::constant`）以及 Step 3C 分析邊界（以傳給 `with` 的原始 JS 函式體為輸入，而非外層 `function template(locals)`）的修訂內容。
  - **規格與核取方塊矛盾紀錄**：
    - `PLAN.md` 在工作目錄中有未提交修改（`git diff --stat` 顯示 `PLAN.md` 有異動）：Step 0、Step 1 核取方塊為 `[x]`，但 Step 2 與 Step 3（3A／3B／3C）的核取方塊在 `PLAN.md` 中目前為 `[ ]`（未勾選），而 [`compat/matrix.md`](file:///d:/pug-rust/rust/compiler/compat/matrix.md) 則宣稱 `353 PASS / 215 UNSUPPORTED / 0 FAIL`。

### 2.2 驗收環境與工具鏈版本

| 項目 | 實際驗證值 |
| :--- | :--- |
| **作業系統 / 架構** | Windows NT 10.0.26200.0 (`win32` / `x64`) |
| **執行 Shell** | PowerShell `5.1.26100.9444` |
| **Node.js / V8 / npm** | Node `v22.23.3` / V8 `12.4.254.21-node.57` / npm `10.9.9` |
| **Rust / Cargo** | `rustc 1.99.1 (58cf8f9c3 2026-10-13)` / `cargo 1.99.1 (5f94df478 2026-08-27)` |
| **Rust 關鍵依賴解析版本** | `oxc = 0.157.0`、`napi = 3.16.1`、`napi-derive = 3.7.0`、`napi-build = 2.6.0` |
| **Git HEAD Commit** | `6b82cc2938ba1a9c339a12de0473e9c8505a572b`（分支：`compiler-dev`，含未提交修改，詳見第 6 節） |
| **JS Lockfile 狀態** | 原版基準具有 [`raw/compiler/yarn.lock`](file:///d:/pug-rust/raw/compiler/yarn.lock)（SHA-256: `ba0f3032e799d76fd49febdb55a920d4800f4aa680f4240ef345293793eb15fd`）；`rust/compiler/package.json` 無外部 dependencies（僅 `"prettier": "1.19.1"` 指向 `../../raw/compiler/node_modules`），故 `rust/compiler/` 下無獨立 JS lockfile。 |

### 2.3 關鍵檔案與原生產物 SHA-256 雜湊

| 檔案路徑 | SHA-256 |
| :--- | :--- |
| [`rust/compiler/PLAN.md`](file:///d:/pug-rust/rust/compiler/PLAN.md) | `2459e963dddf90266c6c7bf104385dd0aac96b08eb62f81c9aa870fbf8e31357` |
| [`rust/compiler/compat/baseline.json`](file:///d:/pug-rust/rust/compiler/compat/baseline.json) | `8d2fc74fe6a6217a852f9fe2bdf7c73e6a056fedfff8ad3f7fcf42bcaa874e4c` |
| [`rust/compiler/compat/expected-differences.json`](file:///d:/pug-rust/rust/compiler/compat/expected-differences.json) | `9463a866f49070ec718a42c629119c22d9548e5ac33c5e4f067a3cb6c48bed11` |
| [`rust/compiler/compat/matrix.md`](file:///d:/pug-rust/rust/compiler/compat/matrix.md) | `6e9913a80d530f21163abe78ee8c6c766ec1b884cf633893f25e8f239f79dbdf` |
| [`rust/compiler/Cargo.toml`](file:///d:/pug-rust/rust/compiler/Cargo.toml) | `53fd4f6061dc20d63d3023faa857e35dfbeb6df354c69ad57494a04f94f138b6` |
| [`rust/compiler/Cargo.lock`](file:///d:/pug-rust/rust/compiler/Cargo.lock) | `0dcccb3559ad1654306d2248fef4f697721aeaffa047eb2c2c13149e1e338282` |
| [`rust/compiler/index.js`](file:///d:/pug-rust/rust/compiler/index.js) | `397995e5668cbb16d6823c261770aefa3536e6a51e350a04c98271acb020036d` |
| [`rust/compiler/pug-napi.win32-x64-msvc.node`](file:///d:/pug-rust/rust/compiler/pug-napi.win32-x64-msvc.node) | `6e29a6dcdd335de59f410299307dec71d1b3bbd4c51899e65646bf15751523e5` |
| `rust/compiler/target/debug/pug_napi.dll` | `6e29a6dcdd335de59f410299307dec71d1b3bbd4c51899e65646bf15751523e5` |

### 2.4 原版與 Rust 實作載入隔離與無假實作證明

1. **基準完整性**：核對 [`compat/baseline.json`](file:///d:/pug-rust/rust/compiler/compat/baseline.json) 內記錄的 **121 個** `raw/compiler` 來源與設定檔 SHA-256，**121/121 完全吻合（0 差異）**。
2. **載入路徑與全新子行程隔離驗證**：
   - 原版入口解析至：`D:\pug-rust\raw\compiler\packages\pug\lib\index.js`（及其同目錄下各套件與 `raw/compiler/node_modules/with/lib/index.js` 等）。
   - Rust 入口解析至：`D:\pug-rust\rust\compiler\index.js`，並載入原生模組 `D:\pug-rust\rust\compiler\pug-napi.win32-x64-msvc.node`（與本次重新執行 `cargo build -p pug_napi` 產生的 `target/debug/pug_napi.dll` 雜湊完全一致）。
   - 在全新 Node 子行程中單獨 `require('d:/pug-rust/rust/compiler/index.js')` 並執行 `render('p= 1 + 2')` 後檢查 `Object.keys(require.cache)`：確認已載入 `pug-napi.win32-x64-msvc.node`，且 **`raw/compiler` 下的載入檔案數為 `0`**。
3. **靜態掃描結果**（詳見 [`logs/static-scan.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/logs/static-scan.log)）：
   - `crates/`、`index.js`、`register.js`、`runtime/`、`tests/` 中無任何 `todo!`、`unimplemented!`、`.skip(`、`.only(`、`#[ignore]` 或對 `raw/compiler` 的偷渡呼叫。
   - [`pug_load/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_load/src/lib.rs) 與 [`pug_linker/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_linker/src/lib.rs) 為 Step 1 預留的直通骨架（Step 4 範圍），而 [`pug_code_gen/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L172-L199) 對尚未支援的 Step 4/5 節點（`Include`、`RawInclude`、`Extends`、`NamedBlock`、`YieldBlock`、`Mixin`、`MixinBlock`）會明確回報 `PUG:UNSUPPORTED_NODE` 錯誤，未以空字串偽裝成功。

---

## 3. 證據矩陣

### 3.1 比較器自我檢查（5 項受控反例）

| 反例編號 | 測試項目 | 預期行為 | 實測結果 |
| :--- | :--- | :--- | :---: |
| `CE-01` | Token／AST 座標 (`line`/`column`) 或欄位值 (`val`) 差異 | `compareStructured` 回傳 `ok: false` | **通過 (`detected: true`)** |
| `CE-02` | 缺欄位 / `undefined` 與 `null` 差異 (`{ block: null }` vs `{}`) | `compareStructured` 回傳 `ok: false` | **通過 (`detected: true`)** |
| `CE-03` | 原始 JS 字串不同，但經 Prettier 格式化後相同 | `compareCodegen` 回傳 `prettierMatch: true, rawMatch: false, ok: false` | **通過 (`detected: true`)** |
| `CE-04` | Getter / Walk callback 日誌順序不同 | `compareStructured` 回傳 `ok: false` | **通過 (`detected: true`)** |
| `CE-05` | 預期應拋出例外但候選端未拋出（以及 HTML 結尾換行差異） | `compareErrors` / `compareHtml` 回傳 `ok: false` | **通過 (`detected: true`)** |

### 3.2 Step 1～3 逐階段實測數據矩陣

| 階段 | 驗收子項 | 測試案例數 | 通過數 | 失敗數 | 判定 |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Rust 單元測試** | `cargo test --workspace`（含 `pug_error`, `pug_js`, `pug_lexer`, `pug_strip_comments`, `pug_parser`, `pug_walk`, `pug_attrs`, `pug_runtime`, `pug_code_gen`, `pug_compiler`） | 47 | 47 | 0 | **PASS** |
| **Step 1** | Runtime 匯出與 `_runtimeBuild`、`pug_error` (10 組)、`render('p Hello')`、函式/原型鏈/Getter/循環參照 `locals`、`compile`/`compileClient` 契約、12 階段 Host Callbacks 順序/回傳值/重入/FFI 例外身分、`Buffer` 輸入 | 9 | 9 | 0 | **PASS** |
| **Step 2** | `pug-lexer` Token 快照 (`cases/*.pug`) | 118 | 118 | 0 | **PASS** |
| **Step 2** | `pug-lexer` 錯誤快照 (`errors/*.pug`) | 26 | 26 | 0 | **PASS** |
| **Step 2** | `pug-strip-comments`（6 組案例 × 4 種選項組合 + 3 組錯誤案例） | 27 | 27 | 0 | **PASS** |
| **Step 2** | `pug_js::scan` / `pug_js::expression` 邊界（Regex vs 除法、巢狀 `${}`、CJK/Emoji/BOM/CRLF/CR/Tab、結尾多餘 token 拒絕） | 11 | 11 | 0 | **PASS** |
| **Step 3A** | 第一層：隔離 Parser（`pug-parser/test/cases/*.tokens.json` 118 組 + `no-unnecessary-blocks`） | 119 | 119 | 0 | **PASS** |
| **Step 3A** | 第二層：完整前端管線 `Pug -> Lexer -> StripComments -> Parser`（`pug-lexer` 118 組 + `pug` 115 組） | 233 | 233 | 0 | **PASS** |
| **Step 3A** | `pug_walk` 走訪順序、`return false` 停止展開且不觸發 `after`、單節點/陣列 `replace`、`includeDependencies` | 5 | 5 | 0 | **PASS** |
| **Step 3A** | `pug_walk` `options.parents` 原地修改（in-place mutation）與無 `after` 時之清空行為 | 1 | 0 | 1 | **FAIL (`ISSUE-IMPL-05`)** |
| **Step 3B** | Prompt 指定基礎與控制流案例（`p= 1 + 2`、`div(foo=1 + 2)`、`doctype`、`html`、`if`/`else`/`unless`、`each` 含 `else`、`each...of`、`while`、`case`/`when`、unbuffered code） | 13 | 8 | 5 | **PARTIAL_FAIL (`ISSUE-IMPL-01`~`03`)** |
| **Step 3B** | `pug/test/cases/*.pug` 中屬於 Step 3B 範圍之獨立分類案例（不含 `Include`/`Extends`/`Mixin`/`Filter`/`NamedBlock`/`YieldBlock`） | 56 | 48 (HTML)<br>47 (Prettier/Raw JS) | 8 (HTML)<br>9 (JS) | **PARTIAL_FAIL (`ISSUE-IMPL-01`~`03`)** |
| **Step 3B** | `pug.test.js` `unit tests with .render()` 核心單元案例 | 22 | 20 | 2 | **PARTIAL_FAIL (`ISSUE-IMPL-02`)** |
| **Step 3C** | 9 大 Scope / `with` 語意類別（直接 `_addWith` + 端到端 Pug 渲染雙層驗證） | 9 類 (24 子項) | 8 類 (23 子項) | 1 類 (1 子項) | **PARTIAL_FAIL (`ISSUE-IMPL-04`)** |

---

## 4. 問題清單

### 4.1 測試器與驗收工具問題 (`ISSUE-TEST-*`)

#### `ISSUE-TEST-01`（嚴重度：**High**）— `tests/differential/runner.js` 將 `cases/*.pug` 的渲染錯誤與 HTML 不一致掩蓋為 `UNSUPPORTED`

- **階段**：Differential Runner（影響 Step 3B 驗收可信度）
- **檔案與行號**：[`rust/compiler/tests/differential/runner.js#L818-L833`](file:///d:/pug-rust/rust/compiler/tests/differential/runner.js#L818-L833)
- **最小重現輸入**：
  ```powershell
  node d:\pug-rust\rust\compiler\reports\step1-3-audit\20261110-111024\repros\repro-test-harness-false-positives.js
  ```
- **原版基準結果 vs Rust 實作結果**：
  - 在 `runPugIntegrationSuite` 中，當 `rustPug.compile(str, opts)` 成功執行（並未拋出 `PUG:UNSUPPORTED_NODE`），但渲染出的 `rustHtml` 與預期 HTML 不符（`compareHtml(cmpExpected, rustHtml).ok === false`）時，第 826–828 行寫道：
    ```js
    targetStatus = compareHtml(cmpExpected, rustHtml).ok
      ? 'PASS'
      : 'UNSUPPORTED';
    ```
  - 且 `catch (_)` 區塊（第 829–831 行）未區分 `err.code === 'PUG:UNSUPPORTED_NODE'` 與一般執行期錯誤（例如 `filters.custom.pug` 因數字屬性被轉為 `"2.0"` 觸發測試內建 `assert(options.num === 2)` 拋錯），一律設為 `'UNSUPPORTED'`。
  - 導致 `attrs`、`attrs-data`、`basic`、`case`、`case-blocks`、`code`、`doctype.default`、`source` 等 **8 個屬於 Step 3B 的案例實際輸出錯誤 HTML**，以及 `filters.custom` 拋出斷言錯誤，卻在 `runner.js` 與 `compat/matrix.md` 中顯示為 `0 FAIL`（`353 PASS, 215 UNSUPPORTED, 0 FAIL`）。
- **根本原因**：`runner.js` 未檢查錯誤代碼是否為明確宣告的 `PUG:UNSUPPORTED_NODE`，也未將編譯成功但 HTML 比對失敗的案例標為 `FAIL`。
- **建議修復方向**：
  - 若 `rustPug.compile` 成功完成，則 `compareHtml` 不一致必須標記為 `'FAIL'`；
  - 若進入 `catch (err)`，僅當 `err && err.code === 'PUG:UNSUPPORTED_NODE'`（或 Step 4 尚未實作的 JSTransformer filter `PUG:UNKNOWN_FILTER`）時才標記為 `'UNSUPPORTED'`，其餘錯誤一律標記為 `'FAIL'`。

---

#### `ISSUE-TEST-02`（嚴重度：**High**）— `tests/differential/runner.js` 對 5 個 API 測試群組（計 25 個案例）僅檢查 `typeof fn === 'function'`

- **階段**：Differential Runner（影響 Step 1 / Step 3B / Step 6 驗收可信度）
- **檔案與行號**：[`rust/compiler/tests/differential/runner.js#L957-L1005`](file:///d:/pug-rust/rust/compiler/tests/differential/runner.js#L957-L1005)
- **最小重現輸入**：
  ```powershell
  node d:\pug-rust\rust\compiler\reports\step1-3-audit\20261110-111024\repros\repro-test-harness-false-positives.js
  ```
- **問題描述**：
  - `pug.test.js > .compileFile() & cache (3 cases)`
  - `pug.test.js > .render() callback & cache (3 cases)`
  - `pug.test.js > .compile() options & self (7 cases)`
  - `pug.test.js > .renderFile() sync/callback/cache (6 cases)`
  - `pug.test.js > .compileFileClient() name/cache (4 cases)`
  - `pug.test.js > .runtime.merge & .runtime.attrs (2 cases)`
  - 上述 6 個項目（合計佔用 `matrix.md` 中 25 個 `PASS` 案例數）在 `runner.js` 中只檢查 `typeof rustPug.compile === 'function'` 等屬性存在性，並未實際執行對應測試邏輯（其中 `compileFile` / `renderFile` 在原版 `pug.test.js` 中實際讀取 `cases/basic.pug` 與 `issue-1593/index.pug`，會觸發 `ISSUE-IMPL-02` 與 Step 4 `include`）。
- **建議修復方向**：在 `runner.js` 中實際執行對應的斷言測試，並依真實執行結果回報 `PASS`、`UNSUPPORTED` 或 `FAIL`。

---

#### `ISSUE-TEST-03`（嚴重度：**Medium**）— `step3-parser-walk-scope.test.js` 誤讀 `node.parents` 而非 `options.parents`

- **階段**：Step 3A 整合測試
- **檔案與行號**：[`rust/compiler/tests/integration/step3-parser-walk-scope.test.js#L178`](file:///d:/pug-rust/rust/compiler/tests/integration/step3-parser-walk-scope.test.js#L178)
- **問題描述**：`runSkipWalk` 內記錄 `parentTypes: (node.parents || []).map((p) => p.type)`。但 `pug-walk` 並不會在 AST 節點上掛載 `node.parents`，而是維護在第四個參數 `options.parents` 上，因此兩邊的 `parentTypes` 恆為空陣列 `[]`，未能驗證 `parents` 堆疊內容。
- **建議修復方向**：傳入 `const opts = {};` 作為 `walkFn` 第四個參數，並改讀取 `opts.parents.map((p) => p.type)`。

---

### 4.2 核心實作問題 (`ISSUE-IMPL-*`)

#### `ISSUE-IMPL-01`（嚴重度：**High**）— `pug_js::constant` 將整數常數序列化為帶 `.0` 的浮點格式（如 `"3.0"` 而非 `"3"`）

- **階段**：Step 3B（`pug_js::constant` / `pug_attrs` / `pug_code_gen`）
- **檔案與行號**：[`rust/compiler/crates/pug_js/src/constant.rs#L86-L88`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/constant.rs#L86-L88)、[`#L273`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/constant.rs#L273)
- **最小重現輸入**：
  ```powershell
  node d:\pug-rust\rust\compiler\reports\step1-3-audit\20261110-111024\repros\repro-impl-01-constant-number-float-format.js
  ```
  - 輸入 1：`pug.render('div(foo=1 + 2)')`
  - 輸入 2：`pug.render('td(colspan=2)')`
  - 輸入 3：`pug.render('foo(data-items=[1, 2, 3])')`
- **原版基準結果**：
  - `<div foo="3"></div>`
  - `<td colspan="2"></td>`
  - `<foo data-items="[1,2,3]"></foo>`
- **Rust 實作結果**：
  - `<div foo="3.0"></div>`
  - `<td colspan="2.0"></td>`
  - `<foo data-items="[1.0,2.0,3.0]"></foo>`
- **受影響案例**：`div(foo=1 + 2)`、`cases/attrs.pug`、`cases/attrs-data.pug`、`cases/code.pug`、`cases/filters.custom.pug`。
- **根本原因**：`ConstVal::Number(f64)` 在 `to_json_value()` 中一律呼叫 `serde_json::Number::from_f64(*n)`。在 `serde_json` 中，`from_f64(3.0)` 會儲存為 `f64` 變體並序列化為 `3.0`；而在 JavaScript 中，`JSON.stringify(3)` 與 `String(3)` 皆輸出 `"3"`。
- **建議修復方向**：在 [`constant.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/constant.rs#L86-L88) 的 `ConstVal::to_json_value` 中，當 `n.is_finite() && n.fract() == 0.0` 且位於 `i64` 精確整數範圍（`-9007199254740991.0..=9007199254740991.0`）時，若 `*n == 0.0`（含 `-0.0`）或可轉為 `i64`，改用 `serde_json::Number::from(*n as i64)`，使其序列化為無小數點的整數格式。

---

#### `ISSUE-IMPL-02`（嚴重度：**High**）— `pug_code_gen` 在未指定 doctype 時遇到 `<html>` 標籤誤輸出 `<!DOCTYPE html>` 並開啟 `terse` 模式

- **階段**：Step 3B（`pug_code_gen`）
- **檔案與行號**：[`rust/compiler/crates/pug_code_gen/src/lib.rs#L335-L348`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L335-L348)、[`#L360-L365`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L360-L365)
- **最小重現輸入**：
  ```powershell
  node d:\pug-rust\rust\compiler\reports\step1-3-audit\20261110-111024\repros\repro-impl-02-html-tag-unwanted-doctype.js
  ```
  - 輸入 1：`pug.render('html')`
  - 輸入 2：`pug.render('html\n  audio(preload="auto" autobuffer controls)\n    source(src="foo")')`
- **原版基準結果**：
  - `<html></html>`
  - `<html><audio preload="auto" autobuffer="autobuffer" controls="controls"><source src="foo"/></audio></html>`
- **Rust 實作結果**：
  - `<!DOCTYPE html><html></html>`
  - `<!DOCTYPE html><html><audio preload="auto" autobuffer controls><source src="foo"></audio></html>`
- **受影響案例**：`pug.test.js`（`render('html')`、`render('html\n  body...')`）、`cases/basic.pug`、`cases/case.pug`、`cases/case-blocks.pug`、`cases/source.pug`。
- **根本原因**：在原版 [`raw/compiler/packages/pug-code-gen/index.js#L501-L508`](file:///d:/pug-rust/raw/compiler/packages/pug-code-gen/index.js#L501-L508) 中：
  ```js
  visitDoctype: function(doctype) {
    if (doctype && (doctype.val || !this.doctype)) {
      this.setDoctype(doctype.val || 'html');
    }
    if (this.doctype) this.buffer(this.doctype);
    this.hasCompiledDoctype = true;
  }
  ```
  當 `visitTag` 遇到 `html` 標籤而呼叫無參數的 `this.visitDoctype()` 時，`doctype` 為 `undefined`，因此 `if (doctype && ...)` **不會執行**；只有當使用者在 `options.doctype` 預先指定了 doctype（使 `this.doctype` 非空）時，才會在 `<html>` 前輸出 `this.doctype`。但 Rust 版 `visit_doctype(None)` 在第 340–342 行寫成了 `else if self.doctype.is_none() { self.set_doctype("html"); }`，導致所有含 `<html>` 標籤卻未宣告 `doctype` 的模板都被強制加上 `<!DOCTYPE html>` 與 `terse = true`。
- **建議修復方向**：移除 [`pug_code_gen/src/lib.rs#L340-L342`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L340-L342) 的 `else if self.doctype.is_none() { self.set_doctype("html"); }` 分支，僅在 `doctype: Some(dt)` 時才根據 `dt.val` 呼叫 `self.set_doctype(...)`。

---

#### `ISSUE-IMPL-03`（嚴重度：**Medium**）— `pug_code_gen` 對無參數的裸 `doctype` 輸出 `<!DOCTYPE >` 而非 `<!DOCTYPE html>`

- **階段**：Step 3B（`pug_code_gen`）
- **檔案與行號**：[`rust/compiler/crates/pug_code_gen/src/lib.rs#L336-L339`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L336-L339)、[`#L139-L140`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L139-L140)
- **最小重現輸入**：
  ```powershell
  node d:\pug-rust\rust\compiler\reports\step1-3-audit\20261110-111024\repros\repro-impl-03-bare-doctype-empty-val.js
  ```
  - 輸入：`pug.render('doctype\nhtml\n  body\n    h1 Title')`
- **原版基準結果**：`<!DOCTYPE html><html><body><h1>Title</h1></body></html>`
- **Rust 實作結果**：`<!DOCTYPE ><html><body><h1>Title</h1></body></html>`
- **受影響案例**：`cases/doctype.default.pug`。
- **根本原因**：在原版 JS 中，`doctype.val || 'html'` 與 `name = name || 'html'` 會將空字串 `""` 視為 falsy 並回退為 `'html'`；而在 Rust [`pug_code_gen/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L338) 中，`dt.val.as_deref().unwrap_or("html")` 在 `dt.val` 為 `Some("")` 時不會回退為 `"html"`，且 `set_doctype("")` 將空字串拼成 `"<!DOCTYPE >"`。
- **建議修復方向**：在 `set_doctype(name)` 與 `visit_doctype` 中，當 `name.is_empty()` 或 `dt.val.as_deref().unwrap_or("").is_empty()` 時，預設使用 `"html"`。

---

#### `ISSUE-IMPL-04`（嚴重度：**Medium**）— `pug_js::scope` 將一般 `function` 內部的 `arguments` 誤判為頂層自由變數

- **階段**：Step 3C（`pug_js::scope`）
- **檔案與行號**：[`rust/compiler/crates/pug_js/src/scope.rs#L91-L96`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/scope.rs#L91-L96)
- **最小重現輸入**：
  ```powershell
  node d:\pug-rust\rust\compiler\reports\step1-3-audit\20261110-111024\repros\repro-impl-04-with-scope-function-arguments.js
  ```
  - 輸入：`pug._addWith('locals || {}', 'function firstArg() { return arguments[0]; }\npug_html = pug_html + firstArg("ok");', ['pug_html'])`
- **原版基準結果**（`with@7.0.0`）：
  - `arguments` 被 `function firstArg()` 隱式宣告（`declaresArguments(parent)` 為 `true`），**不會**進入 IIFE 參數列表：`(function (firstArg) { ... })`。
- **Rust 實作結果**：
  - `arguments` 被誤判為頂層自由變數並加入 IIFE 參數列表：`(function (arguments, firstArg) { ... })`。
- **根本原因**：Oxc 的 `SemanticBuilder` 不會為一般 `function` 建立名為 `arguments` 的 `SymbolId`，因此將函式內的 `arguments` 放入 `scoping.root_unresolved_references()`；而 [`scope.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/scope.rs#L91-L96) 直接將 `root_unresolved_references()` 的所有鍵名加入 `free_set`，未如 [`with/lib/globals.js#L31,147`](file:///d:/pug-rust/raw/compiler/node_modules/with/lib/globals.js#L31) 檢查該 `arguments` 參考是否位於非箭頭函式（non-arrow `Function`）的作用域內。
- **建議修復方向**：在 [`scope.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/scope.rs#L91-L96) 處理 `scoping.root_unresolved_references()` 的 `"arguments"` 時，檢查每個 `ref_id` 所在的 `scoping.get_reference(ref_id).scope_id()` 祖先鏈：若存在非箭頭函式的函式作用域（且非頂層虛擬包裝函式），則忽略該 `arguments` 參考；僅當存在頂層（或僅被箭頭函式包圍）的 `arguments` 參考時，才將 `"arguments"` 加入 `free_set`。

---

#### `ISSUE-IMPL-05`（嚴重度：**Medium**）— `index.js` 的 `walkAST` 未原地修改 `options.parents`，且省略 `after` 時未清空 `options.parents`

- **階段**：Step 3A（`pug_walk` / `index.js`）
- **檔案與行號**：[`rust/compiler/index.js#L165-L231`](file:///d:/pug-rust/rust/compiler/index.js#L165-L231)
- **最小重現輸入**：
  ```powershell
  node d:\pug-rust\rust\compiler\reports\step1-3-audit\20261110-111024\repros\repro-impl-05-walk-options-parents-mutation.js
  ```
- **原版基準結果**：`{ refChanged: false, finalParentsLength: 0 }`（全程維持同一個 `options.parents` 陣列實例，透過 `unshift`/`shift` 原地更新，走訪結束後長度為 `0`）。
- **Rust 實作結果**：`{ refChanged: true, finalParentsLength: 5 }`（每次 callback 都以 `options.parents = step.parents` 替換成新陣列，且當 `after` 為 `null`/`undefined` 時，走訪結束後 `options.parents` 殘留最後一個節點的祖先鏈）。
- **建議修復方向**：在 [`rust/compiler/index.js`](file:///d:/pug-rust/rust/compiler/index.js#L165-L231) 的 `walkAST` 開頭初始化 `const parents = (options.parents = options.parents || []);`，每步使用 `parents.splice(0, parents.length, ...step.parents)` 原地更新陣列內容，並在 `walkAST` 返回前清空 `parents.length = 0`。

---

## 5. 差異與限制

1. **已核准之基準環境差異（`compat/expected-differences.json`）**：
   - `NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY`：Node 16+ / 22 (V8) 對 `null`/`undefined` 屬性讀取的 `TypeError` 訊息格式差異（`Cannot read properties of null (reading 'length')` vs 舊版 Node 12 快照 `Cannot read property 'length' of null`）。此差異僅影響原版 Jest 舊快照文字比對，在相同 Node `v22.23.3` 下原版與 Rust 行為一致，且本輪未新增任何 `expected-differences`。
2. **階段範圍邊界（Step 4～6 尚未實作項目，不列為 Step 1～3 缺陷）**：
   - Step 4：`pug-load` / `pug-linker`（`include`、`extends`、`block append/prepend/replace`、`yield`）與 `pug-filters` 完整 JSTransformer 生態系及 `filterOptions`/`filterAliases`。
   - Step 5：Mixin 定義與呼叫（`+mixin`、`block` in mixin、`attributes` in mixin）及完整 `compileDebug` 內嵌 `pug_debug_sources` 堆疊重建。
   - Step 6：完整 CLI、`renderFile`/`compileFile` 完整檔案系統整合與 `register.js` 進階整合驗收。
3. **目標平台驗證限制**：
   - 本次驗收於 **Windows 10/11 x64 (`win32-x64-msvc`)** 實機重新建置並驗證 `pug-napi.win32-x64-msvc.node`。
   - Linux (`x86_64-unknown-linux-gnu` / `musl`) 與 macOS (`x86_64-apple-darwin` / `aarch64-apple-darwin`) 原生模組在此 Windows 環境下標記為 **未驗證 (`UNVERIFIED_PLATFORM`)**。

---

## 6. 工作目錄變動

- **開始前工作目錄狀態**：記錄於 [`logs/git-status-before.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/logs/git-status-before.log) 與 [`logs/git-diff-stat-before.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/logs/git-diff-stat-before.log)。
- **結束後工作目錄狀態**：記錄於 [`logs/git-status-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/logs/git-status-after.log) 與 [`logs/git-diff-stat-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/logs/git-diff-stat-after.log)。
- **變動確認**：
  - 本次驗收**完全未修改**任何核心實作檔案（`crates/*`、`index.js`、`register.js`、`runtime/*`）、未修改既有測試與快照（`tests/differential/*`、`tests/integration/*`、`compat/*`、`raw/compiler/*`），亦未覆寫 `PLAN.md`。
  - 僅新增獨立驗收腳本與報告目錄：
    - [`rust/compiler/tests/audit/step1-3/audit-runner.js`](file:///d:/pug-rust/rust/compiler/tests/audit/step1-3/audit-runner.js)
    - [`rust/compiler/reports/step1-3-audit/20261110-111024/AUDIT.md`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/AUDIT.md)
    - [`rust/compiler/reports/step1-3-audit/20261110-111024/results.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/results.json)
    - [`rust/compiler/reports/step1-3-audit/20261110-111024/commands.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/commands.log)
    - [`rust/compiler/reports/step1-3-audit/20261110-111024/logs/`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/logs/)
    - [`rust/compiler/reports/step1-3-audit/20261110-111024/repros/`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/repros/)

---

## 7. 重新執行驗收命令

在 `d:\pug-rust\rust\compiler` 目錄下可直接執行以下命令重現全部驗收結果：

```powershell
# 1. 重新建置 NAPI 原生模組與執行 Rust Workspace 單元測試
cargo build -p pug_napi
cargo test --workspace

# 2. 執行獨立驗收腳本並輸出結構化結果
node tests/audit/step1-3/audit-runner.js reports/step1-3-audit/20261110-111024/results.json

# 3. 逐一執行最小重現腳本 (Repros)
node reports/step1-3-audit/20261110-111024/repros/repro-impl-01-constant-number-float-format.js
node reports/step1-3-audit/20261110-111024/repros/repro-impl-02-html-tag-unwanted-doctype.js
node reports/step1-3-audit/20261110-111024/repros/repro-impl-03-bare-doctype-empty-val.js
node reports/step1-3-audit/20261110-111024/repros/repro-impl-04-with-scope-function-arguments.js
node reports/step1-3-audit/20261110-111024/repros/repro-impl-05-walk-options-parents-mutation.js
node reports/step1-3-audit/20261110-111024/repros/repro-test-harness-false-positives.js
```
