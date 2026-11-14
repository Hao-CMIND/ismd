# Pug Rust Compiler Phase 1A 效能診斷與 Before / After 報告

> 本報告記錄 **Phase 1A（Sparse Host Callbacks 與預設檔案讀取 Fast Path，對應 `c56309d`）** 實作完成後的完整驗證、Formal Benchmark（`memory`、`file`、`build` × 115 fixtures）、Rust Stage Profiler 與 Call Counters 結果，並與 Phase 0 Baseline V1（`diagnostic-report.md`）進行 Before / After 對比，作為下一階段優化排序依據。

---

## 1. 本輪修改摘要（Phase 1A — P0）

| 檔案 | 修改重點 |
| --- | --- |
| `rust/compiler/index.js` | 於 `compileBody()` 實作 **Sparse Host Callbacks**：12 個 plugin lifecycle hooks（`preLex`～`postCodeGen`）、`resolve`、`read`、`generateCode` 與 `lexPluginStep` 僅在 `options.plugins` 實際實作對應方法時才掛載到 `hostCallbacks`（無 no-op closure）；無 `customRead` 時省略 `read` 改走 Rust 原生 `std::fs::read`；無自訂 `filters` 時重用單例 `defaultFilterCallback`，同時完整保留 `:markdown-it` 等外部 `jstransformer` 相容性 |
| `rust/compiler/crates/pug_error/src/lib.rs` | `PugError` 新增 `#[serde(skip)] pub plain_error_code: Option<String>` 與 `PugError::host_exception_with_code(...)` |
| `rust/compiler/crates/pug_napi/src/lib.rs` | `NapiCompileOutcome` 新增 `plain_error_code`；`NodeHostAdapter::load_file` 使用 `std::fs::read` 時將 `NotFound` / `PermissionDenied` 對應為 `ENOENT` / `EACCES` 錯誤碼與 Node 相容錯誤訊息 |
| `rust/compiler/tests/integration/step6-release.test.js` | 新增 `Step 6.7`，驗證單一 `preLex`、單一 `postParse`、多 plugin 同 hook 執行順序，以及預設 Rust 讀檔 `ENOENT` `.code` / `.message` 相容性 |

- **Git Commit**：`c56309ddee6191cf892beaeac39fcb6c8c319b5c`（分支 `compiler-dev`，僅含 `rust/compiler/` 內上述 4 檔）
- **Release Binary**：`D:\pug-rust\rust\compiler\pug-napi.win32-x64-msvc.node`（`3,818,496` bytes，SHA-256 `c97027e0fa1f...`）
- **Profile Binary**：`D:\pug-rust\rust\compiler\target-profile\release\pug_napi.dll`（`--features profile`）

---

## 2. 相容性與正確性驗證

| 驗證項目 | 結果 | 備註 |
| --- | --- | --- |
| `cargo test --workspace` | **通過（0 failed）** | 全 Rust workspace crates 單元測試全數通過 |
| `node --test tests/integration/*.test.js` | **50 / 50 通過（0 failed, 0 skipped）** | 含 `Step 6.7` sparse lifecycle hooks 與 `ENOENT` 相容性測試 |
| `node tests/differential/runner.js` | **726 / 726 PASS（0 FAIL）** | 含 `--verify-baseline` 通過；HTML、compileClient、errors、plugins、filters、extends/include、block replace/append/prepend、yield 零退步 |
| Formal Benchmark 正確性 | **115 / 115 MATCH** | `memory`、`file`、`build` 三模式皆 `115/115` HTML 精確字串一致（`0 Mismatch`、`0 Excluded`） |

---

## 3. Formal Benchmark：Before vs After 對比（115 Fixtures）

量測腳本：`node benchmarks/runner.js`（Raw `pug@2.0.4` 與 Rust `pug-rust-compiler@2.0.4-rust.1` 分別於 50 個獨立 Node 子程序隔離執行；P50 單位為 `ms`，倍率為 `Rust / Raw`，`< 1.00x` 代表 Rust 較快）。

### 3.1 Cold Load & 三種 Hot 模式總覽

| 量測項目 | Raw P50 (Before / After) | Before Rust P50 | After Rust P50 | Before Rust/Raw | After Rust/Raw | Rust 耗時改善 |
| --- | :---: | ---: | ---: | ---: | ---: | ---: |
| Cold Load（Module Load） | 147.158 / 149.137 | 7.782 | **7.730** | 0.05x | **0.05x** | -0.7% |
| `memory` Compile | 0.779 / 0.788 | 2.852 | **0.285** | 3.66x | **0.36x** | **-90.0%** |
| `memory` **Total** | 0.782 / 0.792 | 2.864 | **0.292** | 3.66x | **0.37x** | **-89.8%** |
| `file` Compile | 0.894 / 0.882 | 2.927 | **0.358** | 3.27x | **0.41x** | **-87.8%** |
| `file` **Total** | 0.898 / 0.886 | 2.936 | **0.363** | 3.27x | **0.41x** | **-87.6%** |
| `build` Compile | 0.914 / 0.961 | 2.907 | **0.424** | 3.18x | **0.44x** | **-85.4%** |
| `build` **Total** | 1.084 / 1.147 | 3.092 | **0.586** | 2.85x | **0.51x** | **-81.0%** |

- **After Avg 補充**：`memory` Total Avg Raw `1.168 ms` vs Rust `0.583 ms`（`0.50x`）；`file` Total Avg Raw `1.292 ms` vs Rust `0.648 ms`（`0.50x`）；`build` Total Avg Raw `1.662 ms` vs Rust `0.927 ms`（`0.56x`）。

### 3.2 重點案例對比（`memory` Total P50，單位 `ms`）

| 模板 | Raw P50 (Before / After) | Before Rust P50 | After Rust P50 | Before Rust/Raw | After Rust/Raw | Rust 耗時改善 |
| --- | :---: | ---: | ---: | ---: | ---: | ---: |
| `basic.pug` | 0.215 / 0.219 | 1.040 | **0.090** | 4.83x | **0.41x** | **-91.3%** |
| `attrs.pug` | 4.848 / 4.956 | 16.482 | **1.079** | 3.40x | **0.22x** | **-93.5%** |
| `mixin.attrs.pug` | 4.723 / 4.859 | 16.940 | **1.462** | 3.59x | **0.30x** | **-91.4%** |
| `code.conditionals.pug` | 1.746 / 1.804 | 9.527 | **0.555** | 5.46x | **0.31x** | **-94.2%** |
| `layout.multi.append.prepend.block.pug` | 1.476 / 1.500 | 8.341 | **0.644** | 5.65x | **0.43x** | **-92.3%** |
| `text.pug` | 1.462 / 1.479 | 7.871 | **0.443** | 5.38x | **0.30x** | **-94.4%** |
| `filters.nested.pug` | 6.688 / 6.831 | 8.858 | **6.716** | 1.32x | **0.98x** | **-24.2%** |

---

## 4. Stage Profiler 與 Callback Count：Before vs After

量測腳本：`node benchmarks/diagnostics/run-profiler.js`（10 measured rounds，Compatibility options，`profile-summary.json`）。

### 4.1 Host Callback / Roundtrip 計數對比

| 案例 | Before `host_callback` / `token_rt` / `ast_rt` | After `host_callback` / `token_rt` / `ast_rt` | 備註 |
| --- | :---: | :---: | --- |
| `basic.pug` | `12 / 2 / 8` | **`0 / 0 / 0`** | 零跨 V8 lifecycle / read 回呼 |
| `attrs.pug` | `12 / 2 / 8` | **`0 / 0 / 0`** | 零跨 V8 lifecycle / read 回呼 |
| `mixin.attrs.pug` | `12 / 2 / 8` | **`0 / 0 / 0`** | 零跨 V8 lifecycle / read 回呼 |
| `code.conditionals.pug` | `12 / 2 / 8` | **`0 / 0 / 0`** | 零跨 V8 lifecycle / read 回呼 |
| `layout.multi.append.prepend.block.pug` | `24 / 6 / 12` | **`0 / 0 / 0`** | `file_read_count=2` 完全由 Rust `std::fs::read` 處理 |
| `text.pug` | `12 / 2 / 8` | **`0 / 0 / 0`** | 零跨 V8 lifecycle / read 回呼 |
| `filters.nested.pug` | `17 / 2 / 8` | **`5 / 0 / 0`** | 僅保留 5 次實際 filter callback |
| 單一 `preLex` plugin（`PUG_PROFILE`） | — | **`1 / 0 / 0`** | 僅觸發 `preLex` |
| 單一 `postParse` plugin（`PUG_PROFILE`） | — | **`1 / 0 / 1`** | 僅觸發 `postParse` |

### 4.2 After 各模板 Stage Exclusive 耗時分佈（Avg ms / 佔 Rust Total Avg 比例）

| Template | JS P50 (ms) | Rust Total Avg / P50 (ms) | JS Wrap Avg (ms) | Top 4 Stages（Avg ms / 佔比） | 主要 Counters |
| --- | ---: | :---: | ---: | --- | --- |
| `basic.pug` | `0.238` | `0.121 / 0.108` | `0.129` | `codegen` 0.0335 (27.7%), `lexer` 0.0145 (12.0%), `loader` 0.0128 (10.6%), `other` 0.0113 (9.3%) | `oxc_parse=2`, `alloc=2` |
| `attrs.pug` | `1.529` | `1.420 / 1.376` | `0.135` | `lexer` 0.4609 (32.5%), `codegen` 0.2698 (19.0%), `oxc_parse` 0.1605 (11.3%), `parser` 0.1169 (8.2%) | `oxc_parse=139`, `alloc=139`, `eval_const=61` |
| `mixin.attrs.pug` | `1.435` | `1.323 / 1.293` | `0.129` | `lexer` 0.4009 (30.3%), `codegen` 0.2165 (16.4%), `oxc_parse` 0.1483 (11.2%), `loader` 0.1386 (10.5%) | `oxc_parse=162`, `alloc=162`, `eval_const=73` |
| `code.conditionals.pug` | `0.583` | `0.514 / 0.506` | `0.085` | `codegen` 0.1182 (23.0%), `lexer` 0.0881 (17.2%), `loader` 0.0723 (14.1%), `filters` 0.0684 (13.3%) | `oxc_parse=42`, `alloc=42`, `eval_const=24` |
| `layout.multi.append.prepend.block.pug` | `0.720` | `0.641 / 0.636` | `0.092` | `file_read` 0.1182 (18.4%), `lexer` 0.1090 (17.0%), `linker` 0.0862 (13.4%), `codegen` 0.0700 (10.9%) | `file_read=2`, `layout=2`, `oxc_parse=42`, `alloc=42` |
| `text.pug` | `0.454` | `0.384 / 0.377` | `0.081` | `codegen` 0.1142 (29.8%), `lexer` 0.0699 (18.2%), `loader` 0.0402 (10.5%), `filters` 0.0381 (9.9%) | `oxc_parse=6`, `alloc=6`, `eval_const=2` |
| `filters.nested.pug` | `7.498` | `7.484 / 7.383` | `0.096` | `filter_callback` 7.1960 (96.2%), `filters` 0.0930 (1.2%), `loader` 0.0441 (0.6%), `lexer` 0.0329 (0.4%) | `host_callback=5`, `oxc_parse=2` |

---

## 5. 新的效能瓶頸排名與下一階段前三大建議

原本佔非 filter 模板 88%～93% 的無條件 callback 開銷已完全消除，P50 整體編譯速度已較 Raw Pug 快約 **2.4x–2.8x**（`memory` `0.36x`、`file` `0.41x`、`build` `0.44x`）。根據新版 Profiler，下輪建議排序如下：

1. **Oxc 共用 `Allocator` 與 Expression 解析／常數求值去重（P1）**
   - `attrs.pug` 產生 `139` 次 `allocator_create_count` / `oxc_parse_count`、`mixin.attrs.pug` 達 `162` 次（`oxc_parse` + `oxc_semantic` + `constant_evaluation` 合計佔 ~15%–16%，且帶動 `loader`/`filters`/`attrs` 間接成本）。集中 `Allocator` 並避免 `validate_expression()` 對同一表達式重複 parse，是複雜模板最直接的降本方向。
2. **Lexer 熱路徑（Cursor / 字串掃描與 Token 配置）（P1）**
   - 移除 callback 後，`lexer` 在 `attrs.pug`（`0.4609 ms`，`32.5%`）與 `mixin.attrs.pug`（`0.4009 ms`，`30.3%`）已成為最大單一 Rust 原生階段。
3. **Codegen 字串組裝預分配 與 Filter（`jstransformer`）解析快取（P2）**
   - `codegen` 在中小模板居首（`basic.pug` `27.7%`、`code.conditionals.pug` `23.0%`、`text.pug` `29.8%`）；而外部 filter 模板則有 `96.2%` 耗時集中在 `filter_callback`（`jstransformer` 解析與執行），若實際工作負載含大量 `:markdown-it` / `:stylus` 等濾鏡，可再針對 `jstransformer` 套件解析快取做優化。
