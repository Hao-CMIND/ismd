# Step 1～3 缺陷修復與重新驗收報告 (`FIX-REPORT.md`)

- **Run ID**：`20261110-124421`
- **報告目錄**：[`reports/step1-3-fix/20261110-124421/`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/)
- **採用規格快照**：[`PLAN.used.md`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/PLAN.used.md)（SHA-256：`2459e963dddf90266c6c7bf104385dd0aac96b08eb62f81c9aa870fbf8e31357`）
- **原 AUDIT 資料**：保留未覆寫（[`reports/step1-3-audit/20261110-111024/`](file:///d:/pug-rust/rust/compiler/reports/step1-3-audit/20261110-111024/)）
- **Git 基準**：分支 `compiler-dev`，HEAD `6b82cc2938ba1a9c339a12de0473e9c8505a572b`（保留既有未提交修改；本分支不在 `AGENTS.md` 自動 commit 分支對照表內，未建立自動 commit）

---

## 1. 規格核對與原驗收調查發現

1. **規格確認**：
   - `PLAN.used.md` 已完整包含 Step 3A／3B／3C 分段、3B 所需常數／Runtime／預設 debug 前置能力，以及 3C 對齊原版 `with` 輸入之分析邊界。與原 AUDIT 記錄一致（SHA-256 同為 `2459e963...`）。
2. **原報告 8 個 HTML 失敗與 9 個 JS 產物失敗之對應核對**：
   - 原 AUDIT 在 `step3BInScopeFailures` 僅依 `!c.htmlOk` 篩選，列出 8 個 HTML 失敗案例：
     1. `attrs`（`ISSUE-IMPL-01`：`"1.0"` vs `"1"`）
     2. `attrs-data`（`ISSUE-IMPL-01`：`"[1.0,2.0,3.0]"` vs `"[1,2,3]"`）
     3. `basic`（`ISSUE-IMPL-02`：未宣告 doctype 之 `html` 誤輸出 `<!DOCTYPE html>`）
     4. `case`（`ISSUE-IMPL-02`）
     5. `case-blocks`（`ISSUE-IMPL-02`）
     6. `code`（`ISSUE-IMPL-01`：`foo="0.0"` vs `foo="0"`）
     7. `doctype.default`（`ISSUE-IMPL-03`：裸 `doctype` 輸出 `<!DOCTYPE >`）
     8. `source`（`ISSUE-IMPL-02`：誤加 `<!DOCTYPE html>` 並開啟 `terse` 模式）
   - 第 **9** 個 JS 產物失敗案例（HTML 恰好相同但 Prettier + Raw JS 雙層比對均失敗）：
     9. **`classes-empty`**（`a(class=undefined)`）：原版 `pug-attrs` 使用 `constantinople(src, { pug: runtime, pug_interp: undefined })`，將 `undefined` 視為「非常數識別字」而產生執行期 `pug_attr("class", pug_classes([undefined], [true]), false, false)`；Rust `pug_js::constant` 原先將 `"undefined"`、`"Infinity"`、`"NaN"` 當作編譯期常數折疊成空字串，導致雙層 JS 產物不符。已於本次一併修正並關閉。
3. **原報告中不準確處之實際核對紀錄**：
   - **`filters.custom.pug` 失敗根因**：原 AUDIT 誤判為數字 `"2.0"` 造成 `assert(options.num === 2)` 失敗。實際於 [`repro-filters-custom-root-cause.js`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/repros/repro-filters-custom-root-cause.js) 實測傳入值：`raw` 傳入 `{ opt: 'val', num: 2, filename: undefined }`（`typeof num === 'number'`），而 `rust` 傳入 `{ num: '2', opt: "'val'" }`（`typeof num === 'string'`）。真正原因是 Step 4 `pug_filters` 尚未實作編譯期屬性常數求值，並非 `"2.0"` 格式問題。該案例因包含 `Filter` 節點屬於 Step 4 延後範圍（`DEFERRED`）。
   - **API 測試群組統計（`ISSUE-TEST-02`）**：原 AUDIT 標題寫「5 個群組」，內文明列 **6** 個群組（`.compileFile` 3、`.render` callback/cache 3、`.compile` options/self 7、`.renderFile` 6、`.compileFileClient` 4、`.runtime.merge & .attrs` 2，合計對應 `pug.test.js` 25 個原版測試案例；但在舊 `runner.js` 中每個群組僅記為 1 筆存在性檢查）。本次已在 `runner.js` 拆為逐項獨立案例並核實統計。
   - **Walk `options.parents` 建議修正方向（`ISSUE-IMPL-05`）**：原 AUDIT 建議「返回前一律 `parents.length = 0`」。經對照原版 [`raw/compiler/packages/pug-walk/index.js`](file:///d:/pug-rust/raw/compiler/packages/pug-walk/index.js)：原版透過平衡的 `unshift`/`shift` 保留呼叫者預先提供的非空 `parents`（例如 `[sentinel]`），且並無 `finally` 清空，callback 拋錯時會保留當下堆疊與參照；同時 `parents` 中元素即為受訪 AST 節點本身之參照。本次改以 `parents.splice(...)` + `initialParentsSnapshot` + `jsStack` 原地同步更新，不加入改變例外行為的 `finally` 清空。

---

## 2. 問題關閉表

| ISSUE | 修前重現 | 修復位置 | 新增測試 | 修後結果 | 證據 |
|---|---|---|---|---|---|
| `ISSUE-TEST-01` | [`runner-before-core-fix.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/runner-before-core-fix.log)（22 FAIL 顯現、exit=1） | [`tests/differential/runner.js`](file:///d:/pug-rust/rust/compiler/tests/differential/runner.js) | 按 AST 範圍與基準結果分類 `PASS`/`FAIL`/`DEFERRED`/`BLOCKED`/`APPROVED_DIFF`；Step 3B `cases/*.pug` 增測 `compileClient` JS Artifact；非零 exit code 與 crash handler | **CLOSED (`PASS`)** | [`results-before-core-fix.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/results-before-core-fix.json)、[`results-after.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/results-after.json)、[`audit-after.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/audit-after.json) |
| `ISSUE-TEST-02` | `typeof` 假通過檢查已自 `runner.js` 移除 | [`tests/differential/runner.js`](file:///d:/pug-rust/rust/compiler/tests/differential/runner.js) | 拆分存在性檢查為獨立 1 筆；25 項 API/行為案例逐項執行（Step 1–3）或標記 `DEFERRED`（Step 4–6），另逐項執行 `unit render`、`cases-es2015`、`anti-cases` | **CLOSED (`PASS`)** | [`results-after.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/results-after.json)（658 筆逐項紀錄） |
| `ISSUE-TEST-03` | [`step3-test-before-core-fix.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/step3-test-before-core-fix.log)（`options.parents` 參照改變即失敗） | [`tests/integration/step3-parser-walk-scope.test.js`](file:///d:/pug-rust/rust/compiler/tests/integration/step3-parser-walk-scope.test.js#L167-L299) | 改讀 `walkOpts.parents` 快照、檢查陣列參照穩定性、`after` 省略清空、預置非空 `parents`、callback 拋錯、重入與節點參照 | **CLOSED (`PASS`)** | [`integration-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/integration-after.log)（18/18 PASS） |
| `ISSUE-IMPL-01` (+ `classes-empty`) | `<div foo="3.0"></div>`；`classes-empty` JS 產物不符 | [`crates/pug_js/src/constant.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/constant.rs#L82-L169) | Rust `test_constant_number_json_and_string_formatting`；Node 回歸 `Step 3B Regression (ISSUE-IMPL-01 & classes-empty)`（含正負整數、小數、`±0`、陣列/物件、`9007199254740991`、`1e20`/`1e21`/`1e-6`/`1e-7`、`Infinity`/`NaN`、`undefined` 非常數） | **CLOSED (`PASS`)** | [`repros-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/repros-after.log)、[`audit-after.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/audit-after.json)（56/56 HTML, 56/56 Prettier+Raw JS） |
| `ISSUE-IMPL-02` | `html` 誤輸出 `<!DOCTYPE html>` 並開 `terse` | [`crates/pug_code_gen/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L84-L88) | Rust `test_doctype_and_html_tag_modes`；Node 回歸 `Step 3B Regression (ISSUE-IMPL-02 & 03)`（15 組選項/標籤/反覆呼叫） | **CLOSED (`PASS`)** | [`repros-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/repros-after.log)、[`audit-after.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/audit-after.json)（22/22 unit render） |
| `ISSUE-IMPL-03` | 裸 `doctype` 輸出 `<!DOCTYPE >` | [`crates/pug_code_gen/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs#L337-L348) | 同上，涵蓋裸 `doctype`、`options.doctype: ""` 與 `options.doctype: "xml"` 並存情形 | **CLOSED (`PASS`)** | [`repros-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/repros-after.log)、[`results-after.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/results-after.json) |
| `ISSUE-IMPL-04` | `(function (arguments, firstArg) { ... })` | [`crates/pug_js/src/scope.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/scope.rs#L91-L162) | Rust `test_arguments_scope_rules`；Node 回歸 `Step 3C Regression (ISSUE-IMPL-04)`（一般函式、函式內箭頭函式、頂層箭頭函式、混合、參數遮蔽、頂層 `var arguments`、`locals.arguments` getter 呼叫次數與副作用） | **CLOSED (`PASS`)** | [`repros-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/repros-after.log)、[`audit-after.json`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/audit-after.json)（9/9 類全通過） |
| `ISSUE-IMPL-05` | `{ refChanged: true, finalParentsLength: 5 }` | [`index.js`](file:///d:/pug-rust/rust/compiler/index.js#L160-L249) | Node `Step 3A: Walk AST traversal...`（`before`/`after`、停走、replace 單節點/陣列、無 `after`、預置 `[sentinel]`、拋錯保留堆疊、重入、節點參照 `optsOuter.parents[1] === visitedDiv`）+ `runner.js` `pug-walk` 5 案例 | **CLOSED (`PASS`)** | [`repros-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/repros-after.log)、[`integration-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/integration-after.log) |

---

## 3. 原生建置與載入產物驗證

- **建置命令**：`cargo build -p pug_napi --locked`（使用鎖定依賴 `Cargo.lock`）。
- **DLL → `.node` 同步與雜湊核對**：
  - `target/debug/pug_napi.dll` SHA-256：`1ff85a30b7f9872ddf901393dc8aee1a60b75cf1711031b2c29788c952eddb4b`
  - `pug-napi.win32-x64-msvc.node` SHA-256：`1ff85a30b7f9872ddf901393dc8aee1a60b75cf1711031b2c29788c952eddb4b`
  - 兩者完全一致（`HASH_MATCH=True`）。
- **全新 Node 子行程隔離驗證**（[`node-isolation-probe-after.log`](file:///d:/pug-rust/rust/compiler/reports/step1-3-fix/20261110-124421/logs/node-isolation-probe-after.log)）：
  - `require('./index.js').render('div(foo=1 + 2)')` → `'<div foo="3"></div>'`
  - `require.cache` 中載入原生模組：`["D:\\pug-rust\\rust\\compiler\\pug-napi.win32-x64-msvc.node"]`
  - `raw/compiler` 載入數：`0`

---

## 4. 分階段驗收結果

| 階段 / 項目 | 實測結果 | 判定狀態 | 關鍵數據與說明 |
|---|---|---|---|
| **Rust Workspace 測試** | `26 passed, 0 failed` | `PASS` | `cargo test --workspace --locked`（`pug_ast` 3、`pug_code_gen` 1、`pug_error` 5、`pug_js` 12、`pug_lexer` 2、`pug_parser` 2、`pug_runtime` 1） |
| **Step 1** | 9/9 獨立檢查通過；`pug-error` 8/8；`pug-runtime` 9/9 | `PASS` | 端到端 render、非 JSON locals（原型/getter/循環）、12 階段同步 Host callbacks、重入、跨 FFI 例外身分、`Buffer` 輸入 |
| **Step 2** | Lexer Tokens 118/118、Errors 26/26；StripComments 27/27（含 3 錯誤）；JS 邊界 11/11 | `PASS` | `runner.js` 與 `audit-runner.js` 全數一致 |
| **Step 3A** | 隔離 Parser 119/119；完整前端管線 233/233；Walk 5/5 + 整合測試 `parents` 原地參照/清理/預置/拋錯/重入全通過 | `PASS` | `ISSUE-IMPL-05`、`ISSUE-TEST-03` 已關閉 |
| **Step 3B** | Prompt 13/13；Step 3B 範圍 `cases/*.pug` **56/56 HTML + 56/56 Prettier & Raw JS**；`unitRender` 22/22；`cases-es2015` 1/1 | `PASS` | `ISSUE-IMPL-01`（含 `classes-empty`）、`ISSUE-IMPL-02`、`ISSUE-IMPL-03` 已關閉；59 個含 Step 4–5 節點案例標記 `DEFERRED`（不計為 PASS） |
| **Step 3C** | 9/9 語意類別（24 子項）全通過；新增 `arguments` 多情境與 `locals.arguments` getter 端到端回歸通過 | `PASS` | `ISSUE-IMPL-04` 已關閉 |
| **整個 Step 3** | **3A、3B、3C 與 Step 1–2 回歸全數通過（0 FAIL, 0 BLOCKED）** | **`PASS`** | 已依實測證據更新 [`PLAN.md`](file:///d:/pug-rust/rust/compiler/PLAN.md) Step 2 與 Step 3A／3B／3C／Step 3 完成核取方塊 |
| **差異 Runner (`runner.js`)** | 總計 658 筆：**457 PASS / 201 DEFERRED / 0 BLOCKED / 0 FAIL**（Baseline：656 PASS / 2 APPROVED_DIFF / 0 FAIL） | `PASS` | `APPROVED_DIFF`（2 筆 V8 TypeError 格式）與 `DEFERRED`（201 筆 Step 4–6）不計入 Rust `PASS` |
| **是否具備進入 Step 4 的條件** | **是（Ready for Step 4）** | **`PASS`** | Step 1–3 已承諾範圍 0 失敗；Step 4～6 延後項目明確標記於 `compat/matrix.md` |

---

## 5. 變更清單

- **核心檔案**：
  - [`crates/pug_js/src/constant.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/constant.rs)：修正 `ConstVal::to_json_value` 與 `to_json_string` / `format_js_number` 數字格式（整數無 `.0`、`±0`、`1e20`/`1e21`/`1e-7`、`NaN`/`Infinity` -> `null`），並移除 `undefined`/`Infinity`/`NaN` 常數誤判；新增 Rust 單元測試。
  - [`crates/pug_code_gen/src/lib.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_code_gen/src/lib.rs)：修正 `generate_code` 空 `options.doctype` 與 `visit_doctype`（`None` 不強制設 html doctype，裸 `doctype` 回退 `"html"` 並維持既有 `self.doctype` 判斷）；新增 Rust 單元測試。
  - [`crates/pug_js/src/scope.rs`](file:///d:/pug-rust/rust/compiler/crates/pug_js/src/scope.rs)：逐一檢查 `arguments` 參考所屬作用域祖先鏈（僅忽略位於非箭頭函式內者，涵蓋未解析與頂層 `var arguments` 情境）；新增 Rust 單元測試。
  - [`index.js`](file:///d:/pug-rust/rust/compiler/index.js)：修正 `walkAST` 原地維護 `options.parents`、保留節點參照與預置內容、正常結束還原初始狀態、拋錯不以 `finally` 破壞基準行為。
  - [`pug-napi.win32-x64-msvc.node`](file:///d:/pug-rust/rust/compiler/pug-napi.win32-x64-msvc.node)：同步自重新建置之 `target/debug/pug_napi.dll`。
- **測試器與整合測試**：
  - [`tests/differential/runner.js`](file:///d:/pug-rust/rust/compiler/tests/differential/runner.js)：修復 `ISSUE-TEST-01`（嚴格區分 `PASS` / `FAIL` / `DEFERRED` / `BLOCKED` / `APPROVED_DIFF`，新增 Step 3B `compileClient` 檢查與非零 exit code）、修復 `ISSUE-TEST-02`（移除 `typeof` 假通過、拆分逐項執行與 `DEFERRED`）。
  - [`tests/integration/step3-parser-walk-scope.test.js`](file:///d:/pug-rust/rust/compiler/tests/integration/step3-parser-walk-scope.test.js)：修復 `ISSUE-TEST-03`（改讀 `options.parents` 並驗證陣列/節點參照與預置/拋錯/重入）及新增 `ISSUE-IMPL-01`～`04` 與 `classes-empty` 回歸測試。
- **文件與相容矩陣**：
  - [`compat/matrix.md`](file:///d:/pug-rust/rust/compiler/compat/matrix.md)：由 `runner.js --write-matrix` 重新產生（658 筆：457 PASS / 201 DEFERRED / 0 BLOCKED / 0 FAIL）。
  - [`PLAN.md`](file:///d:/pug-rust/rust/compiler/PLAN.md)：依本次實測證據勾選 Step 2 與 Step 3（3A／3B／3C／完成條件）。
- **未驗證項目與平台**：
  - Step 4（`pug-load`、`pug-filters`、`pug-linker`）、Step 5（完整 `pug-attrs` 52 筆、Mixin Codegen、完整選項組合）、Step 6（完整 `pug.test.js`、`error.reporting`、plugins 內部擴充、`worker_threads` 隔離）依規格延後（`DEFERRED`）。
  - 非 Windows 目標平台（Linux `x86_64-unknown-linux-gnu` / `musl`、macOS `x86_64-apple-darwin` / `aarch64-apple-darwin`）於目前 Windows x64 環境未驗證（`NOT_RUN`）。

---

## 6. 精確重跑命令

於 `d:\pug-rust\rust\compiler` 下執行：

```powershell
# 1. Rust Workspace 單元測試與 NAPI 建置
cargo test --workspace --locked
cargo build -p pug_napi --locked
Copy-Item -Force target\debug\pug_napi.dll pug-napi.win32-x64-msvc.node

# 2. Node 整合與回歸測試 (18 tests)
node --test tests/differential/serializers.test.js tests/integration/step1-skeleton.test.js tests/integration/step2-lexer.test.js tests/integration/step3-parser-walk-scope.test.js

# 3. 差異測試 Runner (658 cases)
node tests/differential/runner.js

# 4. Step 1~3 獨立驗收腳本
node tests/audit/step1-3/audit-runner.js
```
