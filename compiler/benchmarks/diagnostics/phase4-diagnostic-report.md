# Phase 4 診斷與效能報告（Dependency DAG、增量失效、HMR Session 與 Compiled Output Cache）

## 1. 總覽與階段提交紀錄

Phase 4 依序完成 **4A → 4B → 4C → 4D**，並對 **4E（Persistent Disk Cache）** 完成評估。每個階段皆通過 `cargo test --workspace`、Node 整合測試、726 項差異測試後獨立提交（分支 `compiler-dev`）：

| 階段 | 核心項目 | Commit | 關鍵實作摘要 |
| --- | --- | --- | --- |
| **Phase 4A** | 雙向 Dependency DAG | `30d199c` | 新增 `pug_compiler/src/dag.rs` (`DependencyGraph` / `DependencyEdge`)，維護 `TemplateId` 正向依賴與 `reverse_dependents` 反向閉包（支援循環依賴防呆與去重），於 `linked_view` 與 `Session` 自動寫入。 |
| **Phase 4B** | Incremental Invalidation | `1c70c91` | 在 `TemplateStore` 新增 `update_virtual_source_checked` / `invalidate_path_checked`；在 `CompilerSession` 追蹤已註冊入口並實作 `update_files_incremental`、`affected_entries` 與 `compile_affected_with_mode`。 |
| **Phase 4C** | Persistent `CompilerSession` / HMR | `1261281` | 在 `pug_napi` 與 `index.js` `createCompiler()` 曝露 `updateFiles` / `invalidateFiles` 影響報告、`getAffectedEntries()` 與 `compileAffected()`，無受影響入口時 0 NAPI 呼叫、0 `new Function`。 |
| **Phase 4D** | `CompiledOutputCache` + JS `fnCache` | `990e52c` | 在 `TemplateStore` 新增 `CompiledOutputKey` / `CompiledOutputEntry`（含依賴版本快照驗證），並在 `createCompiler()` 實作 `fnCache` 重用既有的 JS `template` function。 |
| **Phase 4E** | Persistent Disk Cache | 評估完成（暫緩實作） | 見第 5 節評估：100 頁冷編譯僅 `6.75 ms`，多數專案無立即磁碟快取需求，保留設計於大型（500+ 頁）CI 場景按需啟用。 |

---

## 2. 正確性與回歸驗證

- **Rust Workspace 單元測試**：`cargo test --workspace` **45 / 45 PASS**（含 `dependency_dag_tracks_extends_includes_multi_page_and_cycles` 與 `incremental_invalidation_handles_page_include_layout_noop_and_sequential_edits`）。
- **Node.js 整合測試**：`node --test rust/compiler/tests/integration/*.test.js` **54 / 54 PASS**（含 Phase 4C HMR 測試與 Phase 4D `CompiledOutputCache` + `fnCache` 測試）。
- **差異測試（Differential Baseline）**：`node rust/compiler/tests/differential/runner.js --verify-baseline` **726 PASS, 0 APPROVED_DIFF, 0 DEFERRED, 0 BLOCKED, 0 FAIL**。
- **正式 Benchmark（115 fixtures）**：`node benchmarks/runner.js` 在 `memory` (`0.06x`)、`file` (`0.09x`)、`build` (`0.10x` compile / `0.14x` total) 皆 **115 / 115 MATCH**；Cold Load `148.522 ms` vs `8.742 ms` (`0.06x`)。

---

## 3. Incremental Benchmark 實測數據（`incremental-phase4d.json`）

測試環境：`13th Gen Intel(R) Core(TM) i7-13620H (16 logical cores)`、Node `v22.23.3`、`rustc 1.99.1`、7 rounds P50、`parallelMode: auto (threshold=8)`。

### 3.1 10 / 50 / 100 頁各情境耗時（P50 ms）

| 情境 | 10 頁 | 50 頁 | 100 頁 |
| --- | --- | --- | --- |
| Raw Full Build (對照組) | 17.477 ms | 72.851 ms | 122.943 ms |
| Rust Full Cold Build | 1.644 ms | 2.348 ms | 6.750 ms |
| Rust `changed-source` 全頁內容異動重編 | 0.695 ms | 1.560 ms | 3.204 ms |
| **Test A：單頁修改 (`compileAffected`)** | **0.145 ms** | **0.197 ms** | **0.193 ms** |
| **Test B：共用 `header.pug` 修改 (`compileAffected`)** | 0.579 ms | 2.174 ms | 3.526 ms |
| **Test C：共用 `layout.pug` 修改 (`compileAffected`)** | 0.550 ms | 2.050 ms | 3.352 ms |
| **Test D：無內容變更 Watcher (`noop`)** | **0.020 ms** | **0.024 ms** | **0.024 ms** |
| **Phase 4D：`compileEntries(全部)` 全快取命中** | **0.211 ms** | **0.470 ms** | **0.709 ms** |
| **Phase 4D：`compileEntries(全部)` 僅改 1 頁** | **0.249 ms** | **0.418 ms** | **0.732 ms** |

### 3.2 50 頁場景內部計數器明細

| 情境 | `changed_file` | `invalidated_tpl` | `affected_entry` | `compile` | `parseHit / Miss` | `outputHit / Miss` | `NAPI calls` | `JS new Function` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Full Cold Build | — | — | 50 | 50 | 147 / 53 | 0 / 50 | 1 | 50 |
| Test A（改 1 頁） | 1 | 1 | 1 | 1 | 3 / 1 | — | 1 | 1 |
| Test B（改 `header.pug`） | 1 | 52 | 50 | 50 | 199 / 1 | — | 1 | 50 |
| Test C（改 `layout.pug`） | 1 | 51 | 50 | 50 | 188 / 12 | — | 1 | 50 |
| Test D（無變更通知） | 0 | 0 | 0 | 0 | 0 / 0 | — | 0 | 0 |
| `compileEntries(50)` 全命中 | 0 | 0 | 0 | 50 (hit) | 0 / 0 | 50 / 0 | 1 | **0** |
| `compileEntries(50)` 改 1 頁 | 1 | 1 | 1 | 50 (49 hit) | 3 / 1 | 49 / 1 | 1 | **1** |

---

## 4. Phase 4 核心問題逐題回答

1. **修改 page 時，50 頁實際重編幾頁？**
   - **1 頁**（`affected_entry = 1`、`compile = 1`、`jsNewFunctionCount = 1`、`0.197 ms`；100 頁亦僅重編 **1 頁**、`0.193 ms`）。
2. **修改 header 時，哪些頁被 invalidated？**
   - `header.pug`、`layout.pug` 以及所有依賴 `layout.pug` 的 50 個頁面共 **52 個模板**被標記為受影響（`invalidatedTemplateCount = 52`、`affectedEntryCount = 50`），但其中未修改的頁面與 `layout.pug`、`footer.pug` 的 `ParsedTemplate` 全數保留在快取中。
3. **修改 layout 時，有哪些 AST 被重新 parse？**
   - **只有 `layout.pug` 本身需要重新 parse**；`header.pug`、`footer.pug` 與 50 個頁面 AST 全數命中 `ParsedAstCache`（50 頁共 `199` 次或 `188` 次 parse hit；少量多出的 miss 僅為 Rayon 平行首次碰觸剛更新之 `layout.pug` 的同時解析，100 頁實測 `386 hit / 14 miss`）。
4. **unchanged watcher event 是否做到 0 compile？**
   - **是**。`updateFiles` 比對內容長度與雜湊後回傳 `{ changed: false, changedFiles: [], invalidatedTemplates: [], affectedEntries: [] }`，`compileAffected()` 做到 **`0 compile`、`0 NAPI call`、`0 JS new Function`**（50/100 頁僅 `0.024 ms`）。
5. **10 / 50 / 100 pages 各情境耗時？**
   - 見上表 3.1：100 頁 full build `6.750 ms`、page change `0.193 ms`、include change `3.526 ms`、layout change `3.352 ms`、noop `0.024 ms`。
6. **Cache hit / miss 數量？**
   - 見上表 3.2：100 頁單頁修改 `sourceHit = 4, sourceMiss = 0, parseHit = 3, parseMiss = 1`；`compileEntries(100)` 全快取重跑 `outputCacheHit = 100, outputCacheMiss = 0`；僅改 1 頁時 `outputCacheHit = 99, outputCacheMiss = 1`。
7. **JS `new Function` 次數 Before / After？**
   - Before（Phase 3D 重跑 100 頁或未分流）：每次 `100` 次（僅 1 頁異動亦重跑 `100` 次）。
   - After（Phase 4C/4D）：單頁異動 `compileAffected()` 降為 **`1` 次**；即使外部呼叫端仍傳入全部 100 頁 `compileEntries(pages)`，亦因 `CompiledOutputCache` + `fnCache` 降為 **`1` 次**（無變更時 **`0` 次**）。
8. **Phase 4 最大收益來自哪裡？**
   - **HMR partial rebuild（DAG + Incremental Invalidation）** 與 **Compiled Output Cache + JS `fnCache`** 兩者相輔相成：前者將單頁修改的 100 頁重編由 `6.750 ms` 降至 `0.193 ms`（約 **35x**）；後者讓即使無法只傳單頁的批次重跑也由 `6.750 ms` 降至 `0.709 ms`（約 **9.5x**）並徹底消除冗餘的 `new Function`。

---

## 5. Phase 4E（Persistent Disk Cache）與下一階段評估

9. **是否還需要 Persistent Disk Cache？**
   - **現階段非必要，建議暫緩（保留為大專案擴充項）**。實測 100 頁冷全量編譯僅需 **6.75 ms**（Cold Load `8.74 ms`）；若引入磁碟快取，在 100 頁規模下讀寫 100 個快取檔與依賴雜湊驗證的 I/O 開銷容易逼近甚至超過 `6.75 ms`。僅當單一專案超過 **500～1,000+ 頁** 且需跨 CI / CLI 行程冷啟動加速時，再啟用第一版「僅快取 generated JS body + 依賴雜湊」的 disk cache 即可。
10. **下一階段是否值得處理 JS wrapper / direct SSG HTML？**
    - **對一般開發 / HMR 流程已不急迫**：透過 Phase 4C/4D，未變更頁面的 `new Function` 已被降至 `0` 次，單頁 HMR 僅 `0.19 ms`。
    - **僅在大型純靜態 SSG 一次輸出上千頁 HTML 時值得研究**：若未來目標是超大規模 SSG 建置（千頁全量產出靜態 HTML 而非 runtime template function），可將「免 `new Function` 直接由 Rust 輸出 HTML 或批次輸出預編譯 ES Module」列為 Phase 5 Experimental 支線。
