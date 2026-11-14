# Pug Rust Compiler Phase 2 單一模板原生最佳化診斷與 Before / After 報告

> 本報告記錄 **Phase 2（Single-template Native Optimization：2F、2C、2A、2B、2D）** 全數實作完成後的正確性驗證、Formal Benchmark（`memory`、`file`、`build` × 115 fixtures）、Rust Stage Profiler 與 Call Counters 結果，並與 **Phase 0（Baseline V1）** 及 **Phase 1A（`c56309d`）** 進行三階段 Before / After 對比。

---

## 1. 本輪完成項目與對應 Commit（分支：`compiler-dev`）

| 子任務 | Commit | 修改檔案 | 核心優化 |
| --- | --- | --- | --- |
| **2F Filter Optimization** | `5b5ab52` | `rust/compiler/index.js` | 快取 `jstransformer` 解析路徑（`jstransformerPathCache`）與 transformer 實例（`jstransformerInstanceCache`），並複用已載入的 `resolve`/`jstransformer` 函式 |
| **2C Oxc / JS Analysis** | `fdd6145` | `pug_js/src/{lib,scan,expression,constant,scope,locals}.rs`、`pug_attrs/src/lib.rs` | Thread-local `Allocator` 複用（`alloc.reset()`）、`with_validated_expression` 單次包裝 parse、移除掃描端 `Vec<u16>` 與 `eval_constant` 重複解析、`locals || {}` scope 分析前置/快路徑、靜態 `class` 單次求值 |
| **2A Lexer Hot Path** | `e03f968` | `pug_lexer/src/lib.rs` | `input.drain(..)` 改為 `input_buf + pos` 游標推進、`scan_end_of_line` 零拷貝、ASCII UTF-16 長度與定位快路徑、移除 `O(N^2)` 全檔 UTF-16 配置、借用切片屬性掃描、`tokens` 預配與 `mem::take` |
| **2B Codegen & Runtime** | `08ad11d` | `pug_runtime/src/lib.rs`、`pug_js/src/{constant,lib}.rs`、`pug_attrs/src/lib.rs`、`pug_code_gen/src/lib.rs` | 新增單次掃描 `push_js_string_inner` 消除 `js_stringify_str` 6 次字串配置、`pug_runtime::build` 改用 `u16` 位元遮罩與單次配置、`compile_attrs_fast` 使用 `Cow` 與直寫緩衝、`CodeGenerator::buf` 改為平坦 `String` + 延遲靜態 chunk flush（保留未使用 mixin 行號換行語意）、去重 `runtime_functions_used` |
| **2D General Allocation** | `bd44e2e` | `pug_walk/src/lib.rs`、`pug_load/src/lib.rs`、`pug_filters/src/lib.rs`、`pug_linker/src/lib.rs`、`pug_strip_comments/src/lib.rs`、`pug_parser/src/lib.rs`、`pug_compiler/src/lib.rs`、`pug_napi/src/lib.rs` | `pug_walk::walk_mut` 原地走訪取代 `parents.insert(0, current.clone())` 深層子樹複製、`pug_load`/`pug_filters` 原地改寫 AST、`pug_linker::link` 新增 `ast_needs_link` 略過無依賴模板 `LBlock` 轉換、`pug_strip_comments` 原地壓縮、`pug_parser` 新增 `parse_owned_with_warnings` 與零配置 `Copy` token-kind 分派及 `Option::take`、`CompilerHost::pre_lex_cow` 與按需 `debug_sources` 紀錄 |

- **Release Binary**：`D:\pug-rust\rust\compiler\pug-napi.win32-x64-msvc.node`（`3,672,064` bytes，SHA-256 `d9207a5ad9ea...`）
- **Profile Binary**：`D:\pug-rust\rust\compiler\target-profile\release\pug_napi.dll`（`--features profile`）

---

## 2. 相容性與正確性驗證

| 驗證項目 | 結果 | 備註 |
| --- | --- | --- |
| `cargo test --workspace` | **全數通過（38 tests passed, 0 failed）** | 零編譯警告（0 warnings） |
| `node --test tests/integration/*.test.js` | **50 / 50 通過（0 failed, 0 skipped）** | 包含 plugin hooks、worker threads、pack tarball、sparse lifecycle hooks 等全套整合測試 |
| `node tests/differential/runner.js --verify-baseline` | **726 / 726 PASS（0 FAIL）** | Baseline `724 PASS, 2 APPROVED_DIFF`；Target `726 PASS, 0 APPROVED_DIFF, 0 DEFERRED, 0 BLOCKED, 0 FAIL` |
| Formal Benchmark 正確性 | **115 / 115 MATCH** | `memory`、`file`、`build` 三模式皆 `115/115` HTML 精確字串一致（`0 Mismatch`、`0 Excluded`） |

---

## 3. Formal Benchmark：Baseline V1 vs Phase 1A vs Phase 2（115 Fixtures）

量測腳本：`node benchmarks/runner.js`（50 個獨立 Node.js v22.23.3 子程序隔離執行；P50 單位 `ms`，倍率為同次執行之 `Rust / Raw`）。

### 3.1 Cold Load 與三種 Hot 模式總覽（P50）

| 量測項目 | Raw P50 (本輪) | Baseline V1 Rust P50 | Phase 1A Rust P50 | **Phase 2 Rust P50** | Phase 2 `Rust/Raw` | Phase 1A → Phase 2 降幅 | V1 → Phase 2 總降幅 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold Load（Module Load） | 158.206 | 7.782 | 7.730 | **8.561** | **0.05x** | +10.8% | +10.0% |
| `memory` Compile | 1.349 | 2.852 | 0.285 | **0.144** | **0.11x** | **-49.5%** | **-95.0%** |
| `memory` **Total** | 1.356 | 2.864 | 0.292 | **0.149** | **0.11x** | **-49.0%** | **-94.8%** |
| `file` Compile | 1.752 | 2.927 | 0.358 | **0.216** | **0.12x** | **-39.7%** | **-92.6%** |
| `file` **Total** | 1.760 | 2.936 | 0.363 | **0.221** | **0.13x** | **-39.1%** | **-92.5%** |
| `build` Compile | 1.709 | 2.907 | 0.424 | **0.257** | **0.15x** | **-39.4%** | **-91.2%** |
| `build` **Total** | 2.057 | 3.092 | 0.586 | **0.393** | **0.19x** | **-32.9%** | **-87.3%** |

- **Phase 2 Avg 補充**：
  - `memory`：Compile Avg Raw `2.552 ms` vs Rust `0.246 ms`（`0.10x`）；Total Avg Raw `2.563 ms` vs Rust `0.252 ms`（`0.10x`）。
  - `file`：Compile Avg Raw `2.985 ms` vs Rust `0.315 ms`（`0.11x`）；Total Avg Raw `2.995 ms` vs Rust `0.321 ms`（`0.11x`）。
  - `build`：Compile Avg Raw `2.877 ms` vs Rust `0.370 ms`（`0.13x`）；Total Avg Raw `3.230 ms` vs Rust `0.520 ms`（`0.16x`）。

### 3.2 重點案例對比（`memory` Total P50，單位 `ms`）

| 模板 | Raw P50 (本輪) | Baseline V1 Rust P50 | Phase 1A Rust P50 | **Phase 2 Rust P50** | Phase 2 `Rust/Raw` | Phase 1A → Phase 2 降幅 | V1 → Phase 2 總降幅 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `basic.pug` | 0.474 | 1.040 | 0.090 | **0.041** | **0.09x** | **-54.4%** | **-96.1%** |
| `attrs.pug` | 10.371 | 16.482 | 1.079 | **0.483** | **0.05x** | **-55.2%** | **-97.1%** |
| `mixin.attrs.pug` | 10.613 | 16.940 | 1.462 | **0.669** | **0.06x** | **-54.2%** | **-96.1%** |
| `code.conditionals.pug` | 2.781 | 9.527 | 0.555 | **0.236** | **0.08x** | **-57.5%** | **-97.5%** |
| `layout.multi.append.prepend.block.pug` | 3.596 | 8.341 | 0.644 | **0.389** | **0.11x** | **-39.6%** | **-95.3%** |
| `text.pug` | 3.154 | 7.871 | 0.443 | **0.214** | **0.07x** | **-51.7%** | **-97.3%** |
| `filters.nested.pug` | 13.050 | 8.858 | 6.716 | **1.488** | **0.11x** | **-77.8%** | **-83.2%** |

---

## 4. Stage Profiler 與 Call Counters：Phase 1A vs Phase 2

量測腳本：`node benchmarks/diagnostics/run-profiler.js`（10 measured rounds，Compatibility options，`benchmarks/diagnostics/profile-summary.json`）。

### 4.1 編譯內部計數器對比

| 案例 | Phase 1A `oxc_parse` / `alloc` / `eval_const` | Phase 2 `oxc_parse` / `alloc` / `eval_const` | `host_cb` / `token_rt` / `ast_rt` |
| --- | :---: | :---: | :---: |
| `basic.pug` | `2 / 2 / 0` | **`1 / 0 / 0`** | `0 / 0 / 0` |
| `attrs.pug` | `139 / 139 / 61` | **`101 / 0 / 59`** | `0 / 0 / 0` |
| `mixin.attrs.pug` | `162 / 162 / 73` | **`103 / 0 / 59`** | `0 / 0 / 0` |
| `code.conditionals.pug` | `42 / 42 / 24` | **`27 / 0 / 18`** | `0 / 0 / 0` |
| `layout.multi.append.prepend.block.pug` | `42 / 42 / 25` | **`29 / 0 / 25`** | `0 / 0 / 0` |
| `text.pug` | `6 / 6 / 2` | **`4 / 0 / 2`** | `0 / 0 / 0` |
| `filters.nested.pug` | `2 / 2 / 0` | **`1 / 0 / 0`** | `5 / 0 / 0` |

### 4.2 Rust 總編譯時間與主要 Stage Exclusive 耗時對比（Avg ms）

| Template | Phase 1A Rust Avg / P50 (ms) | **Phase 2 Rust Avg / P50 (ms)** | Phase 2 Top Stages（Avg ms / 佔 Rust Avg 比例） |
| --- | :---: | :---: | --- |
| `basic.pug` | `0.121 / 0.108` | **`0.086 / 0.072`** (`JSWrap Avg=0.172`) | `lexer` 0.0201 (23.4%), `other` 0.0154 (18.0%), `codegen` 0.0128 (14.9%), `oxc_parse` 0.0128 (14.9%) |
| `attrs.pug` | `1.420 / 1.376` | **`0.894 / 0.915`** (`JSWrap Avg=0.184`) | `lexer` 0.3583 (40.1%), `oxc_parse` 0.1799 (20.1%), `parser` 0.0925 (10.3%), `codegen` 0.0780 (8.7%), `const_eval` 0.0491 (5.5%) |
| `mixin.attrs.pug` | `1.323 / 1.293` | **`0.541 / 0.524`** (`JSWrap Avg=0.117`) | `lexer` 0.1884 (34.8%), `oxc_parse` 0.1130 (20.9%), `codegen` 0.0637 (11.8%), `oxc_semantic` 0.0517 (9.6%), `parser` 0.0483 (8.9%) |
| `code.conditionals.pug` | `0.514 / 0.506` | **`0.400 / 0.386`** (`JSWrap Avg=0.192`) | `lexer` 0.1416 (35.4%), `oxc_parse` 0.0710 (17.8%), `parser` 0.0538 (13.5%), `codegen` 0.0482 (12.1%) |
| `layout.multi.append.prepend.block.pug` | `0.641 / 0.636` | **`0.359 / 0.354`** (`JSWrap Avg=0.090`) | `file_read` 0.0993 (27.7%), `linker` 0.0783 (21.8%), `lexer` 0.0576 (16.0%), `oxc_parse` 0.0246 (6.9%) |
| `text.pug` | `0.384 / 0.377` | **`0.178 / 0.168`** (`JSWrap Avg=0.087`) | `lexer` 0.0565 (31.8%), `oxc_parse` 0.0370 (20.8%), `codegen` 0.0238 (13.4%), `parser` 0.0238 (13.4%) |
| `filters.nested.pug` | `7.484 / 7.383` | **`2.003 / 1.732`** (`JSWrap Avg=0.105`) | `filter_callback` 1.8991 (94.8%), `filters` 0.0234 (1.2%), `lexer` 0.0234 (1.2%) |

### 4.3 各子階段具體改善幅度觀察

- **`loader` 與 `filters`（walk_mut 原地走訪）**：在無依賴/無 filter 模板上原本佔 10%～14% 的巡檢成本（例如 `code.conditionals.pug` 原本 `loader 0.0723 ms + filters 0.0684 ms`，`mixin.attrs.pug` `loader 0.1386 ms`）已降到 1% 以下並退出前 8 大階段。
- **`codegen`（2B）**：`attrs.pug` 由 `0.2698 ms` 降至 `0.0780 ms`（**-71.1%**）；`mixin.attrs.pug` 由 `0.2165 ms` 降至 `0.0637 ms`（**-70.6%**）；`text.pug` 由 `0.1142 ms` 降至 `0.0238 ms`（**-79.2%**）。
- **`parser`（2D）**：`mixin.attrs.pug` 由原本前 4 外降至 `0.0483 ms`；`attrs.pug` 由 `0.1169 ms` 降至 `0.0925 ms`。
- **`oxc_parse` / `allocator`（2C）**：`allocator_create_count` 在熱編譯全數歸 **0**；`oxc_parse_count` 減少約 **27%～36%**（如 `mixin.attrs.pug` `162 → 103`，`attrs.pug` `139 → 101`）。
- **`filter_callback`（2F）**：`filters.nested.pug` 的 `filter_callback` 由 `7.1960 ms` 降至 `1.8991 ms`（**-73.6%**），帶動 Rust 總時間由 `7.484 ms` 降至 `2.003 ms`。

---

## 5. 更新後瓶頸排序與 Phase 3 前瞻建議

Phase 2 完成後，Rust Compiler 相對於 Raw Pug 已達到 **`memory` `0.11x`（約快 9 倍）、`file` `0.12x`、`build` `0.15x`**。目前剩餘成本集中於：

1. **JS Wrapper 與 V8 `new Function`（`JSWrap Avg ~0.09–0.19 ms`）**：在極小模板如 `basic.pug`（`Rust=0.086 ms`、`JSWrap=0.172 ms`）上，JS 端包裝與 `vm`/函式建立已是 Rust 本體的 ~2 倍；在 SSR / MPA 多頁場景可由 Phase 3/4 批次與快取攤提。
2. **Oxc 單表達式多次解析（`oxc_parse ~18–21%`）**：`attrs.pug`（`101` 次）與 `mixin.attrs.pug`（`103` 次）仍對每個動態屬性/表達式單獨建置 Oxc AST；下一輪若需進一步壓榨大模板單次編譯時間，可評估共用 `ExpressionStore` 或針對單一字面量/簡單識別字做輕量快速判斷。
3. **Lexer 屬性括號與插值掃描（`lexer ~32–40%`）**：目前是純原生模板中佔比最高階段（`attrs.pug` `0.358 ms`、`mixin.attrs.pug` `0.188 ms`），主要成本來自 `pug_lexer` 大量動態規則的 Regex/Char 掃描與 Token 配置；對含大量 `include`/`extends` 的專案則由 Phase 3（`TemplateStore` / `ParsedAstCache`）直接消除重複 `file_read`（`27.7%`）與 `linker`（`21.8%`）成本。
