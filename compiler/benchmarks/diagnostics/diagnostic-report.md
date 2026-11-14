# Pug Rust Compiler 效能瓶頸診斷報告

> 本報告依據 Baseline V1 已驗證數據，依序執行 **Priority 1（Pure Fast Path Benchmark）**、**Priority 2（Rust Stage Profiler + Call Counters）** 與 **Priority 3A（NAPI / Host Callback / AST & Token Roundtrip Microbenchmark）**，定位 `pug-rust` 編譯階段相較於原版 `pug@2.0.4`（Raw Pug）慢 ~3x 的根本原因，並量化各階段成本與改善優先順序。

---

## Already Verified（Baseline V1 已驗證基準，本次未重測）

以下數據取自既有隔離測試（`benchmarks/report.md`、`benchmarks/results/summary.json`）：

- **Release binary 驗證**：`rust/compiler/pug-napi.win32-x64-msvc.node`（`3,822,080` bytes，SHA-256 `38de5b118370...`），與 `target/release/pug_napi.dll` 一致（`opt-level = 3`、`matchesRelease = true`、`matchesDebug = false`）。
- **Process 隔離**：Raw Pug 與 Rust Pug 各自於獨立 Node child process 執行，共 `50` 個 process（`isolationOk = true`），無跨引擎污染。
- **Correctness**：`115 / 115` 模板皆通過 Raw/Rust 編譯與 HTML 精確字串比對（`0 mismatch`、`0 excluded`）。
- **Cold Load（10 batches 交替）**：Raw module load P50 = `147.158 ms` vs Rust P50 = `7.782 ms`（`0.05x`），Rust 冷啟動顯著快於 Raw。
- **Hot Benchmark（5 batches × 30 rounds × 115 fixtures）**：
  - `memory`：Compile P50 Raw `0.779 ms` / Rust `2.852 ms`（`3.66x`）；Render P50 Raw `0.001 ms` / Rust `0.002 ms`；Total P50 Raw `0.782 ms` / Rust `2.864 ms`（`3.66x`，Avg `3.41x`）。
  - `file`：Total P50 Raw `0.898 ms` / Rust `2.936 ms`（`3.27x`）。
  - `build`：Write P50 Raw `0.157 ms` / Rust `0.167 ms`；Total P50 Raw `1.084 ms` / Rust `3.092 ms`（`2.85x`）。

**已確認前提**：效能落差完全集中於 **`compile` 階段**，而非 Cold Load、`render()` 或檔案寫入。

---

## Priority 1：Pure Fast Path Benchmark

### 測試設定

以最小化 Pure options `{ filename, basedir, pretty: true, doctype: undefined }`（移除 `filters`、`filterAliases`、`plugins`、`read`、`resolve`、`hooks`），透過獨立 Node process 測試 8 個無 custom filter 依賴的代表性案例（5 hot batches × 30 rounds，`8 / 8 MATCH`），結果存於 `benchmarks/diagnostics/pure-summary.json`。

### Compatibility Baseline vs Pure 比較（Compile P50 / Avg，單位 `ms`）

| Template | Compat Raw P50 | Compat Rust P50 | Pure Raw P50 | Pure Rust P50 | Pure Ratio (Rust/Raw) | Rust Pure 變化（Compat→Pure） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `basic.pug` | `0.215` | `1.039` | `0.296` | `1.082` | `3.66x` | `-4.1%`（無改善） |
| `doctype.default.pug` | `0.232` | `1.145` | `0.303` | `1.154` | `3.80x` | `-0.8%`（無改善） |
| `comments.source.pug` | `0.162` | `0.479` | `0.176` | `0.429` | `2.44x` | `+10.4%` |
| `text.pug` | `1.457` | `7.867` | `1.753` | `8.248` | `4.70x` | `-4.8%`（無改善） |
| `nesting.pug` | `0.484` | `2.669` | `0.623` | `2.754` | `4.42x` | `-3.2%`（無改善） |
| `code.conditionals.pug` | `1.739` | `9.525` | `2.108` | `9.904` | `4.70x` | `-4.0%`（無改善） |
| `attrs.pug` | `4.827` | `16.450` | `5.394` | `17.192` | `3.19x` | `-4.5%`（無改善） |
| `layout.multi.append.prepend.block.pug` | `1.475` | `8.339` | `2.067` | `8.784` | `4.25x` | `-5.3%`（無改善） |
| **Overall（8 檔彙總）** | — | — | `1.465`（Avg `1.735`） | `6.048`（Avg `6.422`） | `4.13x`（Avg `3.70x`） | **無改善** |

### Pure Fast Path 結論

把使用者傳入的 `filters` / `filterAliases` 拿掉後，Rust 並沒有變快（仍維持 `2.4x–4.7x` 慢於 Raw Pug）。這直接否定了「僅因 test options 帶有 `filters`/`filterAliases` 導致變慢」的假設，證明瓶頸位於 **編譯管線內部（預設 NAPI host callbacks 與/或 Rust core）**。

---

## Priority 2：Rust Stage Profiler + Call Counters

### 量測方法

- 於 `crates/pug_ast/src/profile.rs` 實作 thread-local 階層計時器（非重複計時：子階段耗時會自父階段扣除，使所有階段 `exclusive_ns` 總和精確等於 `compile_body_sync` 總耗時），全程由 `#[cfg(feature = "profile")]` 與執行期環境變數 `PUG_PROFILE=1` 雙重保護。
- 使用獨立 `--target-dir target-profile` 編譯 profile release DLL，不影響預設 release `.node` 二進位檔。
- 每個代表性模板先 warmup 2 次，再量測 10 rounds（紀錄於 `profile-*.json` 與 `profile-summary.json`）。

### 各模板階段耗時拆解（Compatibility Options，Avg Exclusive ms 與佔 Rust 總編譯時間比例）

#### 1. 整體總覽：Host Callback Roundtrip vs Filter Callback vs Pure Rust Core

| Template | JS Compile P50 (ms) | Rust Total Avg (ms) | Rust Total P50 (ms) | AST/Token Roundtrip Callbacks | Filter Callback | Pure Rust Core（含 read/lexer/oxc/codegen） | JS `runtimeWrap` Avg (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `basic.pug` (`profile-basic.json`) | `1.490` | `1.466` | `1.352` | `1.297 ms` (**88.5%**) | `0.000 ms` | `0.167 ms` (**11.4%**) | `0.131` |
| `attrs.pug` (`profile-attrs.json`) | `16.720` | `16.608` | `16.540` | `15.233 ms` (**91.7%**) | `0.000 ms` | `1.374 ms` (**8.3%**) | `0.199` |
| `mixin.attrs.pug` (`profile-mixin-attrs.json`) | `16.991` | `18.176` | `16.785` | `16.454 ms` (**90.5%**) | `0.000 ms` | `1.721 ms` (**9.5%**) | `0.226` |
| `code.conditionals.pug` (`profile-conditionals.json`) | `10.840` | `11.082` | `10.695` | `10.214 ms` (**92.2%**) | `0.000 ms` | `0.866 ms` (**7.8%**) | `0.188` |
| `layout.multi.append.prepend.block.pug` (`profile-layout.json`) | `9.348` | `9.673` | `9.224` | `8.530 ms` (**88.2%**) | `0.000 ms` | `1.141 ms` (**11.8%**，含 `file_read 0.330 ms`) | `0.152` |
| `text.pug` (`profile-text.json`) | `7.557` | `7.998` | `7.441` | `7.436 ms` (**93.0%**) | `0.000 ms` | `0.561 ms` (**7.0%**) | `0.135` |
| `filters.nested.pug` (`profile-filter.json`) | `8.401` | `8.740` | `8.315` | `1.885 ms` (**21.6%**) | `6.571 ms` (**75.2%**) | `0.283 ms` (**3.2%**) | `0.093` |

> **註**：Pure mode 在 Stage Profiler 中呈現完全一致的結構（`basic.pug` callbacks `89.4%`、`attrs.pug` callbacks `92.0%`、`mixin.attrs.pug` callbacks `90.2%`、`code.conditionals.pug` callbacks `92.3%`、`layout...` callbacks `87.8%`、`text.pug` callbacks `93.2%`）。

#### 2. 關鍵 Stage 明細（Avg Exclusive ms）與 Call Counters

| Metric / Stage | `basic` | `attrs` | `mixin.attrs` | `conditionals` | `layout.multi...` | `text` | `filters.nested` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `post_lex_callback` | `0.228` (15.6%) | `3.080` (18.5%) | `2.783` (15.3%) | `1.550` (14.0%) | `1.294` (13.4%) | `1.329` (16.6%) | `0.363` (4.2%) |
| `pre_parse_callback` | `0.148` (10.1%) | `2.854` (17.2%) | `2.980` (16.4%) | `1.313` (11.8%) | `1.200` (12.4%) | `1.198` (15.0%) | `0.336` (3.8%) |
| 8× AST Hook Callbacks 合計 | `0.914` (62.4%) | `9.290` (55.9%) | `10.677` (58.7%) | `7.339` (66.2%) | `6.020` (62.2%) | `4.900` (61.3%) | `1.180` (13.5%) |
| `filter_callback` | `0.000` | `0.000` | `0.000` | `0.000` | `0.000` | `0.000` | `6.571` (75.2%) |
| `file_read` | `0.000` | `0.000` | `0.000` | `0.000` | `0.330` (3.4%) | `0.000` | `0.000` |
| `lexer` | `0.015` (1.0%) | `0.461` (2.8%) | `0.471` (2.6%) | `0.171` (1.5%) | `0.158` (1.6%) | `0.093` (1.2%) | `0.034` (0.4%) |
| `parser` | `0.010` (0.7%) | `0.105` (0.6%) | `0.124` (0.7%) | `0.062` (0.6%) | `0.058` (0.6%) | `0.051` (0.6%) | `0.017` (0.2%) |
| `loader` / `linker` / `filters` | `0.031` (2.1%) | `0.166` (1.0%) | `0.321` (1.7%) | `0.225` (2.0%) | `0.274` (2.8%) | `0.107` (1.4%) | `0.125` (1.5%) |
| `oxc_parse` | `0.024` (1.6%) | `0.155` (0.9%) | `0.205` (1.1%) | `0.075` (0.7%) | `0.059` (0.6%) | `0.053` (0.7%) | `0.025` (0.3%) |
| `oxc_semantic` + `constant_eval` + `scope` | `0.015` (1.0%) | `0.057` (0.3%) | `0.087` (0.4%) | `0.039` (0.3%) | `0.029` (0.4%) | `0.031` (0.4%) | `0.017` (0.2%) |
| `attrs` | `0.000` | `0.050` (0.3%) | `0.060` (0.3%) | `0.015` (0.1%) | `0.021` (0.2%) | `0.003` (0.0%) | `0.000` |
| `codegen` + `runtime_build` | `0.043` (2.9%) | `0.205` (1.2%) | `0.233` (1.3%) | `0.160` (1.4%) | `0.090` (0.9%) | `0.140` (1.7%) | `0.032` (0.4%) |
| **`host_callback_count`** | `12` | `12` | `12` | `12` | `24` | `12` | `17` |
| **`token_roundtrip_count`** | `2` | `2` | `2` | `2` | `6` | `2` | `2` |
| **`ast_roundtrip_count`** | `8` | `8` | `8` | `8` | `12` | `8` | `8` |
| **`lexer_count` / `parser_count`** | `1 / 1` | `1 / 1` | `1 / 1` | `1 / 1` | `3 / 3` | `1 / 1` | `1 / 1` |
| **`layout_parse_count` / `file_read_count`** | `0 / 0` | `0 / 0` | `0 / 0` | `0 / 0` | `2 / 2` | `0 / 0` | `0 / 0` |
| **`oxc_parse_count` / `allocator_create_count`** | `2 / 2` | `139 / 139` | `162 / 162` | `42 / 42` | `42 / 42` | `6 / 6` | `2 / 2` |
| **`eval_constant_count`** | `0` | `61` | `73` | `24` | `34` | `2` | `0` |
| **`scope_analysis_count` / `oxc_semantic_count`** | `2 / 2` | `2 / 2` | `2 / 2` | `2 / 2` | `2 / 2` | `2 / 2` | `2 / 2` |

### Profiler 診斷發現

1. **無條件掛載所有 Plugin Host Callbacks 是壓倒性的第一大瓶頸**：
   檢視 `rust/compiler/index.js`（L773–L893）可確認，`compileBody()` **無條件** 在 `hostCallbacks` 物件掛載了 `preLex`、`postLex`、`preParse`、`postParse`、`preLoad`、`read`、`postLoad`、`preFilters`、`postFilters`、`preLink`、`postLink`、`preCodeGen`、`postCodeGen`。即使 `options.plugins` 為空陣列 `[]`（絕大多數一般編譯與 Pure Fast Path 皆然），Rust 端的 `NodeHostAdapter` 每次仍查得 `Some(cb)`，於是對 **每個模板** 強制執行：
   - **2 次 Token JSON ⇄ V8 來回**（`postLex`、`preParse`）
   - **8 次完整 AST JSON ⇄ V8 來回**（`postParse`、`preLoad`、`postLoad`、`preFilters`、`postFilters`、`preLink`、`postLink`、`preCodeGen`；若有 `extends`/`include`，每個外部檔案還會額外觸發 `postLex`、`preParse`、`postParse`、`preLoad` 與 JS `read` callback）
   - 每次 AST callback 在 JS 端還會額外執行 `dehydrateAstBuffers(reviveAstBuffers(ast))`，對整個 AST 進行 **深度遍歷與整棵物件樹深拷貝**，完全是無意義的 no-op 開銷！
2. **Rust Compiler Core 本身其實非常快**：
   扣除 `host_callback` 之後，純 Rust 編譯核心在 `basic.pug` 僅 `0.167 ms`、`text.pug` 僅 `0.561 ms`、`code.conditionals.pug` 僅 `0.866 ms`、`attrs.pug` 僅 `1.374 ms`——全部已經快於 Raw Pug！

---

## Priority 3：依 Profiler 結果選擇性執行 Microbenchmark

### 挑選依據（不盲目實作全部 4 項）

- **3A（NAPI / Host Callback / AST & Token Roundtrip Microbenchmark）→ 觸發執行**：因 `*callback` 佔非 filter 模板總時間的 **88.2%–93.0%**，且 `filter_callback` 佔 `filters.nested.pug` 的 **75.2%**。
- **3B（Oxc） / 3C（Lexer） / 3D（Loader/Linker）→ 本階段不單獨執行**：目前分別僅佔 `0.3%–1.6%`（Oxc）、`0.4%–2.8%`（Lexer）、`0.1%–1.1%`（Loader/Linker，及 `file_read` JS callback `3.4%`）。將在移除 3A 的無用 no-op callbacks 之後，依需求做為下一波微調對象。

### 3A Microbenchmark 實測結果（未含 profiler 的 Release `.node` + `--expose-gc` 隔離 GC，30 rounds P50）

腳本：`benchmarks/diagnostics/run-micro-3a-napi-roundtrip.js`，結果：`benchmarks/diagnostics/micro-3a-napi-roundtrip.json`（所有變體 HTML 輸出 100% 一致驗證通過）。

| Template | Tokens / Token JSON / AST JSON | Raw P50 (ms) | Current API `pug.compile` (ms) | Native + No-Op Sparse Callbacks + Wrap (ms) | 相對 Raw（Current → Sparse） | 移除 No-Op Callbacks 預估加速 | 拆解：Token RT (ms) | 拆解：AST Serde/V8 RT (ms) | 拆解：JS Revive/Dehydrate Clone (ms) | 拆解：`runtimeWrap` (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `basic.pug` | `9` / `1.5 KB` / `1.2 KB` | `0.674` | `1.121` | **`0.065`** | `1.66x` → **`0.10x`** | **`17.37x`** | `0.258` | `0.648` | `0.086` | `0.002` |
| `attrs.pug` | `180` / `33.3 KB` / `18.9 KB` | `5.796` | `16.918` | **`0.923`** | `2.92x` → **`0.16x`** | **`18.33x`** | `5.392` | `8.929` | `1.235` | `0.001` |
| `mixin.attrs.pug` | `161` / `30.9 KB` / `20.2 KB` | `5.572` | `16.353` | **`1.230`** | `2.93x` → **`0.22x`** | **`13.29x`** | `4.822` | `10.534` | `0.611` | `0.029` |
| `code.conditionals.pug` | `86` / `16.1 KB` / `13.2 KB` | `1.936` | `9.827` | **`0.464`** | `5.08x` → **`0.24x`** | **`21.16x`** | `2.288` | `5.992` | `1.105` | `0.017` |
| `layout.multi...` | `46` / `9.7 KB` / `6.5 KB` | `1.599` | `7.977` | **`0.552`** | `4.99x` → **`0.35x`** | **`14.44x`** | `1.996` | `5.118` | `0.386` | `0.004` |
| `text.pug` | `91` / `15.5 KB` / `9.6 KB` | `1.560` | `7.453` | **`0.393`** | `4.78x` → **`0.25x`** | **`18.95x`** | `2.487` | `4.373` | `0.271` | `0.035` |
| `filters.nested.pug` | `26` / `4.8 KB` / `3.7 KB` | `6.898` | `8.432` | **`4.399`** | `1.22x` → **`0.64x`** | **`1.92x`** | `0.710` | `1.149` | `0.403` | `0.075` |

> **`filters.nested.pug` 說明**：Sparse 模式仍傳入 `{ filter: filterCb }`（透過 JS `jstransformer` 執行 `:markdown-it` 與 `:custom`），即便保留了跨 NAPI filter callback，拿掉 11 個無用 plugin hooks 後仍從 `8.432 ms` 降至 `4.399 ms`（**快於 Raw Pug `6.898 ms`**）。

---

## 根因分類（Categories A–E）與改善優先順序

| 優先序 | 分類 | 問題描述 | 證據與量化影響 | 受影響範圍 |
| --- | --- | --- | --- | --- |
| **P0（最優先）** | **Category A**：NAPI 邊界 / 序列化 / 無條件 Host Callbacks | `rust/compiler/index.js` 無論 `options.plugins` 是否為空，皆掛載全套 12 個 callback，觸發 2 次 Token + 8+ 次 AST 經由 `serde_json::to_value` → `env.to_js_value` → `reviveAstBuffers`/`dehydrateAstBuffers`（整棵 AST 複製）→ `env.from_js_value` → `serde_json::from_value` | 佔無 filter 模板編譯耗時 **88.2%–93.0%**；以 Sparse callbacks 移除無用 hook 後，`attrs.pug` 從 `16.918 ms` 降至 `0.923 ms`（**快 18.33x，領先 Raw Pug 6.3x**） | 全體 `compile` / `compileFile` / `render` / `compileClient` 呼叫 |
| **P1（次要，修復 P0 後浮現）** | **Category A + D**：JS `read` fallback 與 Filter Callback | 1. 無 `customRead` 時仍掛載 JS `read` callback 而未使用 Rust 原生 `std::fs::read`。<br>2. Filter-heavy 模板每次需跨 NAPI 呼叫 JS `jstransformer`（且 `requireFilterDep`/`resolve.sync` 於每次呼叫重複查找套件） | 1. `layout.multi...` `file_read = 0.330 ms`（佔純 Rust ~29%）。<br>2. `filters.nested.pug` `filter_callback = 6.571 ms`（75.2%，包含 `markdown-it` 本身執行與模組解析） | 使用 `extends`/`include` 或 `:markdown` 等 filter 之模板 |
| **P2（後續最佳化）** | **Category B**：JS / Oxc 管線重複解析與配置 | `crates/pug_js/src/expression.rs` 中 `validate_expression()` 對同一表達式建立 **2 個** `Allocator` 並解析 **2 次**（`parse_expression()` + 包裝 `parse()`）；`eval_filter_constant()` 亦重複呼叫 `validate_expression()` + 再 parse；`attrs.pug` 產生 `139` 次、`mixin.attrs.pug` 產生 `162` 次 Oxc parse 與 allocator 建立 | 目前僅佔 Compat 總耗時 `1.1%–2.7%`，但在修復 P0 後將成為 `attrs` / `mixin.attrs`（總時間 `0.92–1.23 ms`）中約 **15%–25%** 的占比（`0.21–0.30 ms`） | 含大量屬性或條件式之模板（`attrs.pug`、`mixin.attrs.pug`、`code.conditionals.pug`） |
| **P2（後續最佳化）** | **Category C**：Rust Compiler Core（Lexer / Codegen） | `lexer` 在屬性密集模板中佔 `0.461–0.471 ms`（佔 P0 修復後純 Rust 耗時約 `27%–34%`）；`codegen` 佔 `0.205–0.232 ms` | 修復 P0 前僅佔 `2.6%–2.8%`，修復 P0 後整體已比 Raw 快 `3x–10x`，屬後續精進項目 | 高 token 數模板 |
| **已排除** | **Category E**：量測假象 / Options / RuntimeWrap / Render | Release binary、Process isolation、Cold load（Rust 快 19x）、`filters` 選項有無（Pure 測試證實非主因）、`runtimeWrap`（`0.001–0.075 ms`）、`render`（`~0.002 ms`）均非瓶頸 | 115/115 正確、Baseline V1 與 Pure 實測 | — |

---

## 診斷問題明確回答（8 大關鍵問題）

1. **Q1：究竟是 JS 相容層還是 Rust Compiler Core 慢？**
   **主要是 JS/NAPI Host Callback 相容橋接層（佔 88%–93%）**。Rust compiler core 在無這些無用回呼時，實際上比 Raw Pug **快 3x 至 10x**（例如 `attrs.pug`：`0.923 ms` vs Raw `5.796 ms`；`basic.pug`：`0.065 ms` vs Raw `0.674 ms`）。
2. **Q2：為什麼移除 `filters` 與 `filterAliases` 的 Pure Fast Path 測試幾乎沒讓 Rust 變快？**
   因為 `rust/compiler/index.js` 在 `compileBody()` 內依據 **未檢查 `plugins.length` 的固定 `hostCallbacks` 物件** 傳給 `native.compileBodySync()`，無論使用者是否傳入 `plugins`、`filters` 或 `filterAliases`，都會無條件觸發全部 10 次以上 Token/AST 往返與深拷貝。
3. **Q3：這 88%–93% 的 Callback 時間究竟花在哪些具體動作？**
   以 `attrs.pug`（`16.918 ms`）為例，3A 微基準拆解為：
   - **2 次 Token NAPI Roundtrip（`postLex`、`preParse`）**：`5.392 ms`
   - **8 次 AST NAPI Serde/V8 序列化與反序列化 Roundtrip**：`8.929 ms`
   - **JS 端 8 次 `reviveAstBuffers` + `dehydrateAstBuffers` 全樹複製**：`1.235 ms`
   合計高達 `15.556 ms`，而編譯本體 + `new Function` 僅 `0.923 ms`。
4. **Q4：當模板確實使用了 Plugin 時該怎麼辦？**
   依 `plugins` 陣列實際實作的 method 名稱做 **Sparse Callback 掛載**（只傳入真的有被某個 plugin 定義的 hook；沒有 `plugins` 定義 `postLex` 就不傳 `postLex`），並可考慮只有在 `ast` 含 `FileReference` 節點或實際存在對應 plugin 時才執行 buffer 還原／脫水，或在未來導入直接操作 V8／binary AST 而非每次整棵 `serde_json::Value` 雙重轉換。
5. **Q5：`read` 與 `resolve` 預設 callback 是否造成重複成本？**
   是的。當沒有 custom `resolve` plugin 時 `index.js` 已正確傳 `undefined` 讓 Rust 使用 `default_resolve`；但 `read` 卻無條件包了一層 `(fp) => fs.readFileSync(fp)`，導致 `layout.multi.append.prepend.block.pug` 每次載入依賴檔都要經 NAPI 呼回 JS 讀檔（`0.330 ms`）。只要 `customRead` 不存在，直接傳 `read: undefined` 即可由 Rust `std::fs::read` 直接處理。
6. **Q6：Filter 密集模板（`filters.nested.pug`）的瓶頸在哪？**
   `filter_callback` 佔 `6.571 ms`（`75.2%`），來自呼叫外部 JS `jstransformer` 執行 Markdown/filter 轉換及每次動態 `resolve.sync` 查表；其餘 `1.885 ms`（`21.6%`）則是無用 plugin hooks。僅移除無用 plugin hooks 即可讓 `filters.nested.pug` 從 `8.432 ms` 降至 `4.399 ms`，已經優於 Raw Pug（`6.898 ms`）。若再快取 `jstransformer` resolver 查找或內建常見 filter（純診斷觀察，未改架構），仍有進一步空間。
7. **Q7：Oxc (`pug_js`) 與 `lexer` 是否也是核心慢點？**
   在目前架構下不是主因（分別 `<3%`），但 Counters 確實揭露了結構性浪費：`attrs.pug` 呼叫了 `139` 次 `Allocator::default()` + `OxcParse`，`mixin.attrs.pug` 達 `162` 次，主因是 `validate_expression()` 解析兩次且每個屬性單獨建立 arena。修正 Category A 後，Oxc（`0.21–0.30 ms`）與 Lexer（`0.46–0.47 ms`）會是下一波值得優化的對象。
8. **Q8：接下來的改善優先順序建議？**
   1. **Priority 1（Immediate Quick Win，預期整體編譯提速 10x–20x）**：修改 `rust/compiler/index.js` `compileBody()` 為 **按需 Sparse 掛載 `hostCallbacks`**（僅當 `plugins` 確實註冊該 hook 名稱時才提供對應 callback；無 `customRead` 時 `read: undefined`）。
   2. **Priority 2**：快取 `jstransformer` 套件解析、並讓 `FileReference` buffer 還原僅在需要時進行（或改寫 JS plugin 傳遞機制避免無 `FileReference` 仍深拷貝整棵 AST）。
   3. **Priority 3**：最佳化 `pug_js`（消除 `validate_expression` 雙重 parse、重複使用 `Allocator`）與 `pug_lexer` 熱路徑（避免多餘掃描與分配）。
