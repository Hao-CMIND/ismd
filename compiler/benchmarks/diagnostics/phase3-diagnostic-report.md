# Phase 3 診斷與效能報告（MPA 共享架構、Zero-Clone LinkedView、CompilerSession 與 Rayon 平行編譯）

## 1. 總覽與階段提交紀錄

Phase 3 依序完成四個獨立階段，每個階段皆通過完整單元/整合測試、726 項差異測試與 115 項正式 Benchmark 正確性比對後獨立提交（分支 `compiler-dev`）：

| 階段 | 核心項目 | Commit | 關鍵實作摘要 |
| --- | --- | --- | --- |
| **Phase 3A** | `TemplateStore` + `ParsedAstCache` | `9042a64` | `SourceStore` 與 `ParsedTemplateCache` 跨頁共享 `layout` / `header` / `footer` 之原始碼與已解析 AST（`Arc<ParsedTemplate>`），`createTemplateStore()` 支援 `invalidate` / `stats`。 |
| **Phase 3B** | Shared Immutable AST + `LinkedView` | `b242e6c` | 新增 `pug_compiler/src/linked_view.rs` 與 `pug_code_gen` `LinkedAstOverlay`，針對標準繼承/include 頁面零複製直接產生程式碼，消除整個 layout AST clone。 |
| **Phase 3C** | 持續性 `CompilerSession` + `compileBatch` | `d5ca038` | 新增 `pug_compiler/src/session.rs`、`NativeCompilerSession` 與 JS `createCompiler()` / `compileBatch()`，將 N 頁編譯的 NAPI 邊界呼叫由 N 次收斂為 1 次，並支援 `updateFiles` / `invalidateFiles`。 |
| **Phase 3D** | Rayon 多頁平行編譯 | `04118fa` | 引入 `rayon` 對批次入口平行編譯，確認 `pug_js` thread-local allocator/scratch 與 `DashMap` 快取並行安全；依實測將 `DEFAULT_PARALLEL_THRESHOLD` 設為 `8`，輸出順序完全確定。 |

---

## 2. 正確性與回歸驗證

Phase 3D 最終狀態驗證結果如下：

- **Rust Workspace 單元測試**：`cargo test --workspace` 全數通過（含 `pug_compiler` 9 tests、`pug_js` 12 tests、`pug_linker` 4 tests、`pug_load` 3 tests 等，0 failed）。
- **Node.js 整合測試**：`node --test rust/compiler/tests/integration/*.test.js` **52 / 52 PASS**（含 Step 6.7 sparse callbacks、Step 7 `createTemplateStore`、Step 8 `createCompiler` / `compileBatch` 與 32 頁 `parallel: false` vs `parallel: true` 一致性驗證）。
- **差異測試（Differential Baseline）**：`node rust/compiler/tests/differential/runner.js --verify-baseline` **726 PASS, 0 APPROVED_DIFF, 0 DEFERRED, 0 BLOCKED, 0 FAIL**（`raw/compiler` 為 724 PASS, 2 APPROVED_DIFF）。
- **正式 Benchmark（115 fixtures）**：`node benchmarks/runner.js` 在 `memory`、`file`、`build` 三種情境下皆 **115 / 115 MATCH**。

---

## 3. 單頁正式 Benchmark 結果（Phase 3D 後）

取自 `benchmarks/results/summary.json`（環境：Windows 10/11 x64, 13th Gen Intel Core i7-13620H 16 logical cores, Node `v22.23.3`, `rustc 1.99.1`）：

- **Cold Load (module)**：Raw P50 `155.060 ms` | Rust P50 `8.526 ms` | **Rust/Raw = `0.05x`**
- **`[memory]` P50**：compile `1.523 / 0.088 ms` (`0.06x`) | render `0.002 / 0.001 ms` | total `1.532 / 0.093 ms` (`0.06x`) | match `115/115`
- **`[file]` P50**：compile `1.943 / 0.154 ms` (`0.08x`) | render `0.002 / 0.001 ms` | total `1.952 / 0.157 ms` (`0.08x`) | match `115/115`
- **`[build]` P50**：compile `2.391 / 0.227 ms` (`0.10x`) | render `0.003 / 0.002 ms` | write `0.427 / 0.138 ms` | total `2.904 / 0.379 ms` (`0.13x`) | match `115/115`

---

## 4. MPA 多頁架構演進（Phase 3A → 3D）

測試專案結構：每頁皆 `extends layout.pug`，`layout.pug` 含 `include header.pug`、`block content`、`include footer.pug`。

### 4.1 50 頁 MPA 各階段 P50 演進

| 階段 | 測試檔案 | Raw P50 (ms) | Rust Uncached (ms) | Rust Store 單頁逐次 (ms) | Rust Batch 序列 (ms) | Rust Batch Rayon 平行 (ms) | 平行版 vs Raw |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Phase 3A** | `mpa-phase3a.json` | 278.411 | 163.078 | 77.725 (`0.279x`) | — | — | — |
| **Phase 3B** | `mpa-phase3b.json` | 286.282 | 188.932 | 96.951 | — | — | — |
| **Phase 3C** | `mpa-phase3c.json` | 278.111 | 170.174 | 93.584 (`0.337x`) | 63.161 (`0.227x`) | — | — |
| **Phase 3D** | `mpa-phase3d.json` | 590.053 | 145.778 | 71.873 (`0.122x`) | 61.187 (`0.104x`) | **24.885** | **`0.042x` (23.7x faster)** |

### 4.2 1 / 10 / 50 / 100 頁 Scale 曲線與 Serial vs Rayon（`mpa-phase3d.json`）

| 頁數 | Raw P50 (ms) | Rust Uncached (ms) | Rust Store 單頁 (ms) | Rust Batch 序列 (ms) | Rust Batch 序列 NoWrap (ms) | Rust Parallel (ms) | Rust Parallel NoWrap (ms) | Rayon vs 序列加速比 | Rayon vs Raw 加速比 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1 頁** | 11.733 | 0.965 | 1.007 | 0.877 | 0.762 | 0.814 | 0.982 | 1.08x（NoWrap `0.78x`） | 14.4x |
| **10 頁** | 59.088 | 8.076 | 4.465 | 4.303 | 3.488 | **1.940** | **1.708** | **2.22x**（NoWrap `2.04x`） | **30.5x** |
| **50 頁** | 590.053 | 145.778 | 71.873 | 61.187 | 56.013 | **24.885** | **16.943** | **2.46x**（NoWrap `3.31x`） | **23.7x** |
| **100 頁** | 1881.011 | 316.673 | 162.379 | 150.376 | 122.017 | **53.840** | **42.309** | **2.79x**（NoWrap `2.88x`） | **34.9x** |

#### 關鍵觀察：自適應平行門檻 (`DEFAULT_PARALLEL_THRESHOLD = 8`)

- **1 頁**：純 Rust 端 (`NoWrap`) 開啟 Rayon 為 `0.982 ms`，反而不及序列 `0.762 ms`（`0.78x`），顯示單頁走 thread pool 調度有開銷。
- **10 頁**：Rayon 已提供 **`2.22x`**（`4.303 ms → 1.940 ms`；NoWrap `2.04x`）。因此將預設自動平行門檻由最初的 `16` 下調至 **`8`**，讓 10 頁等級專案即可自動受益，同時保留單頁與極小批次的序列零開銷。

---

## 5. 內部指標對比（I/O、Parse、Clone、NAPI 與 JS Wrapper）

### 5.1 `layout` / `header` / `footer` 解析與讀取次數（100 頁 Store 模式）

- **Phase 3 前（未快取基準推算）**：每個共用模板各 `read = 100`、`lexer = 100`、`parser = 100`。
- **Phase 3D Store 模式實測**：
  - `layout`：`read = 1`、`lexer = 1`、`parser = 1`、`sourceHits = 99`、`parseHits = 99`
  - `header`：`read = 1`、`lexer = 1`、`parser = 1`、`sourceHits = 99`、`parseHits = 99`
  - `footer`：`read = 1`、`lexer = 1`、`parser = 1`、`sourceHits = 99`、`parseHits = 99`
  - 總計（含 100 頁入口）：`read = 3`、`lexer = 103`、`parser = 103`、`sourceHits = 297`、`parseHits = 297`

### 5.2 AST Clone 次數（Phase 3A → Phase 3B+）

- **10 頁**：`27` 次 → **`0` 次**
- **50 頁**：`147` 次 → **`0` 次**
- **100 頁**：`297` 次 → **`0` 次**

### 5.3 NAPI 邊界呼叫次數（Phase 3C+ Batch 模式）

- **10 頁**：`10` 次 → **`1` 次**
- **50 頁**：`50` 次 → **`1` 次**
- **100 頁**：`100` 次 → **`1` 次**

### 5.4 Rust Compile vs JS `new Function` Wrapper 分解

以 `mpa-phase3d.json` 為例（比較 `rustParallelP50Ms` 與 `rustParallelNoWrapP50Ms`）：

- **50 頁平行模式**：總計 `24.885 ms`，其中純 Rust NAPI 批次編譯 `16.943 ms`（68.1%），JS `new Function` 包裝約 `7.942 ms`（31.9%）。
- **100 頁平行模式**：總計 `53.840 ms`，其中純 Rust NAPI 批次編譯 `42.309 ms`（78.6%），JS `new Function` 包裝約 `11.531 ms`（21.4%）。
- 即使在 100 頁大量共用模板場景下，整體 100 頁編譯（含 `new Function` 可執行函式建構）僅需 **53.8 ms**，對比 Raw Pug 的 **1881.0 ms** 縮短超過 34 倍。

---

## 6. 剩餘主要瓶頸與 Phase 4 就緒狀態

### 6.1 當前剩餘瓶頸

1. **JS `new Function(...)` 包裝開銷（約佔平行批次總耗時 21%～32%）**：在 50～100 頁全量編譯下，Rust 端已壓縮至 `16.9～42.3 ms`，V8 對每頁產生的 JS function body 進行 `new Function` 解析佔比相對放大；若僅輸出靜態 HTML（SSG）或預編譯 client code（`compileClient`），此層可再大幅降低。
2. **頁面自身未快取時之冷解析與依賴圖重建**：目前 `CompilerSession` 已保存 `TemplateStore` 與虛擬檔案疊加層，但尚未建立跨批次之「檔案變更依賴圖（Dependency DAG）增量重編譯」與持久化磁碟快取。

### 6.2 Phase 4 就緒狀態

Phase 3 已為 Phase 4（Incremental Compile / HMR / Watcher / Persistent Cache）建立完整基礎：
- `CompilerSession` 已具備 `updateFiles`、`invalidateFiles`、`stats()` 與 thread-safe `TemplateStore`。
- `ParsedTemplate` 已保存 `AstMetadata { dependencies, declared_blocks, has_filters, has_yield }`，可直接作為 Phase 4 Dependency Graph 與細粒度檔案無效化的資料來源。
