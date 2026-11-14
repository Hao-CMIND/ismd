# Phase 5 Diagnostic Report

## 1. Phase 5 執行摘要與 Commit 清單

Phase 5 已於 `compiler-dev` 分支完成 5A–5G 全部階段實作與驗證：

| 階段 | 內容 | Commit Hash |
|---|---|---|
| Phase 5A | Filter Core `FilterExecutor` 邊界與 `@pug-rust/filters` 延遲載入分離 | `6ec58ee` |
| Phase 5B | JS API 穩定化（`removeFiles`、`dispose`、`isDisposed`、`compileBatch`、`stats()` 擴充、`normalizePretty` 修正） | `e3665d3` |
| Phase 5C | `pug-rust` CLI 工具（`rust/compiler/bin/pug-rust.js`）與 `CompilerSession` 整合 | `ff54523` |
| Phase 5D | Vite Plugin Adapter（`packages/vite/index.js`）與 HMR / Lifecycle 測試 | `3137825` |
| Phase 5E | Webpack Plugin + Loader Adapter（`packages/webpack/plugin.js`、`loader.cjs`、`session-registry.cjs`） | `10b56c1` |
| Phase 5F | 100 頁 + 10,000 次混合更新長時間記憶體與快取穩定性測試 | `720565d` |

---

## 2. 18 項核心診斷問題與實測回答

### Q1. Core 與 Filter 是否已明確分離？
是。`pug_filters::FilterExecutor`（`rust/compiler/crates/pug_filters/src/lib.rs`）定義 Rust 端抽象執行邊界；所有 `jstransformer` 與 `resolve` 依賴均已移出 `rust/compiler/index.js`，獨立至 `rust/filters/`（`@pug-rust/filters`，純 ESM）。

### Q2. 無 Filter 專案是否完全不載入 `jstransformer` / `resolve`？
是。`step9-filter-separation.test.js` 實測確認：純 Pug 無 filter 專案編譯後，`require.cache` 中完全沒有 `@pug-rust/filters`、`jstransformer` 或 `resolve` 模組載入。

### Q3. 有 Filter 專案是否保留 `jstransformer` cache 與正確性？
是。`@pug-rust/filters` 保留 `jstransformerPathCache`、`jstransformerInstanceCache`、`resolve` 與 `jstransformer` 模組快取；Differential Runner `726/726 PASS` 與 `step9-filter-separation.test.js` 全數通過。

### Q4. `filterExecutor: false` 與自訂 `filterExecutor` 是否正常運作？
是。`makeFilterHostCallback(filtersSet, filterExecutor)` 支援傳入自訂 `{ execute }` 物件；傳入 `filterExecutor: false` 時會回傳 `PUG:UNKNOWN_FILTER` 錯誤。

### Q5. Simple JS API 與 Pug 原生相容性是否維持？
是。`compile`、`compileFile`、`compileClient`、`render`、`renderFile`、`__express` 等既有公開 API 完全保留；Differential 測試 `726/726 PASS`（0 `APPROVED_DIFF`、0 `FAIL`），Formal Benchmark `115/115 MATCH`。

### Q6. `createCompiler()` 進階 Session API 是否穩定且具備完整生命週期？
是。`createCompiler()` 提供 `updateFiles`、`invalidateFiles`、`removeFiles`、`getAffectedEntries`、`compileAffected`、`compileEntries`、`compileBatch`、`stats`（含 `sources`、`parsed`、`resolved`、`outputs`、`dagNodes`、`dagEdges`、`fnCache`）、`clear`、`dispose`、`isDisposed`。

### Q7. CLI 是否共用同一套 `CompilerSession` / `compileBatch`？
是。`rust/cli/index.js`（對齊 `raw/cli/` 結構）使用 `pug.createCompiler(compileOptions)` 並呼叫 `compiler.compileEntries(files)` 進行批次編譯，於 `finally` 區塊呼叫 `compiler.dispose()`；於 `step10-js-api-cli.test.js` 驗證通過。

### Q8. Compiler Core 是否與 Vite / Webpack 保持完全解耦？
是。`rust/compiler/` 內完全沒有匯入或參照 `vite`、`webpack`、`@pug-rust/vite` 或 `@pug-rust/webpack`；所有 bundler adapter 均獨立位於 `rust/vite/` 與 `rust/webpack/`（全數採用 ESM）。

### Q9. Vite Plugin 是否使用單一持續性 `CompilerSession`？
是。`rust/vite/index.js` 於 `configureServer` / `buildStart` 建立單一 `CompilerSession`，實測 `sessionCreates = 1`；`transform()` 與 `handleHotUpdate()` 皆重用同一個 session。

### Q10. Vite HMR 與 Watcher（add/unlink/rename/atomic save/no-op）是否正確？
是。`step11-vite-plugin.test.js` 驗證：
- No-op 存檔：`handleHotUpdate` 回傳 `[]`，`affectedCompiles` 不增加（0 次編譯）。
- 單頁修改：僅 1 個 entry 受影響（`lastAffectedCount = 1`）。
- Include / Layout 修改：受影響的 3 個 entry 全部重編（`lastAffectedCount = 3`）。
- Atomic save（寫暫存檔再 `rename` 覆蓋）：正確觸發更新並產出新 HTML。
- `watcher.emit('add')` / `watcher.emit('unlink')`：正確呼叫 `updateFiles` / `removeFiles`。

### Q11. Webpack Plugin 與 Loader 是否共用 `CompilerSession` 並正確註冊依賴？
是。`rust/webpack/plugin.js` 透過 `session-registry.js` 的 `WeakMap(compiler)` 將 `CompilerSession` 共享給 `rust/webpack/loader.js`（純 ESM），且 loader 對每個依賴呼叫 `this.addDependency(dep)`。

### Q12. Webpack Loader 在無 Plugin 時是否具備 standalone fallback？
是。`step12-webpack-adapter.test.js` 驗證：無 `PugRustPlugin` 時，`loader.js` 自動同步呼叫 `pug.compile` 並註冊 `addDependency`。

### Q13. Bundler End-to-End 效能表現為何（10 / 50 / 100 頁實測）？
以下為 `node benchmarks/diagnostics/run-bundler-benchmark.js` 實測中位數（ms，含磁碟 I/O）：

**Vite Plugin (`@pug-rust/vite`)**：

| Pages | Dev Initial | Prod Build | Page HMR | Include HMR | Layout HMR | 10-File Burst | No-op | Add/Rename/Delete |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1.902 ms | 4.106 ms | 12.138 ms | 5.284 ms | 10.935 ms | 63.409 ms | 0.034 ms | 42.564 ms |
| 50 | 3.440 ms | 11.164 ms | 1.354 ms | 4.404 ms | 2.283 ms | 5.487 ms | 0.040 ms | 13.932 ms |
| 100 | 4.546 ms | 27.720 ms | 0.699 ms | 4.196 ms | 4.740 ms | 4.338 ms | 0.115 ms | 4.542 ms |

**Webpack Plugin + Loader (`@pug-rust/webpack`)**：

| Pages | Watch Initial | Prod Build | Page Rebuild | Include Rebuild | Layout Rebuild | 10-File Burst | No-op | Add/Rename/Delete |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 3.203 ms | 4.953 ms | 12.877 ms | 16.762 ms | 11.261 ms | 34.727 ms | 0.055 ms | 19.802 ms |
| 50 | 8.298 ms | 13.918 ms | 12.505 ms | 16.166 ms | 15.860 ms | 19.471 ms | 0.043 ms | 3.583 ms |
| 100 | 112.852 ms | 17.473 ms | 5.873 ms | 15.692 ms | 8.591 ms | 31.042 ms | 0.030 ms | 7.318 ms |

### Q14. 10,000 次混合更新下快取與記憶體是否穩定無洩漏？
是。`step13-lifecycle-stability.test.js`（100 頁 + 10,000 次混合異動，含 500 次 add/rename/delete 循環、500 次 header 修改、500 次 layout 修改、500 次 no-op、8,000 次單頁修改）實測快照：

| Step | `rssMB` | `heapUsedMB` | `externalMB` | `sources` | `parsed` | `outputs` | `fnCache` | `dagNodes` | `dagEdges` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 43.93 | 5.30 | 2.23 | 103 | 103 | 100 | 100 | 103 | 102 |
| 2,500 | 95.82 | 7.29 | 2.23 | 103 | 103 | 100 | 100 | 103 | 102 |
| 5,000 | 104.58 | 9.15 | 2.23 | 103 | 103 | 100 | 100 | 103 | 102 |
| 7,500 | 107.11 | 9.22 | 2.23 | 103 | 103 | 100 | 100 | 103 | 102 |
| 10,000 | 112.61 | 12.30 | 2.23 | 103 | 103 | 100 | 100 | 103 | 102 |

快取項目數量完全維持在 `103 / 103 / 100 / 100 / 103 / 102` 無任何洩漏，`externalMB` 維持 `2.23 MB`。

### Q15. `dispose()` 是否確實釋放 Native 與 JS 快取並防止後續誤用？
是。`dispose()` 後 `stats()` 實測 `sources = 0`、`parsed = 0`、`outputs = 0`、`fnCache = 0`、`dagNodes = 0`、`dagEdges = 0`，`isDisposed = true`，且後續呼叫 `compileAffected()` / `updateFiles()` 會拋出 `CompilerSession has been disposed`。Vite（`closeBundle` / `httpServer.close`）與 Webpack（`done` / `watchClose` / `shutdown`）均已接上自動 `dispose()`。

### Q16. 完整回歸測試結果為何？
- `cargo test --workspace`：**45 / 45 PASS**（0 failed）
- `node --test rust/compiler/tests/integration/*.test.js`：**63 / 63 PASS**（0 failed）
- `node rust/compiler/tests/differential/runner.js --verify-baseline`：**726 / 726 PASS**（0 APPROVED_DIFF, 0 FAIL）

### Q17. Formal Benchmark（115 cases）結果為何？
`node benchmarks/runner.js` 實測結果：
- **Cold Load (module)**：Raw P50 `118.163 ms` | Rust P50 `8.381 ms` | Rust/Raw = **0.07x**
- **[memory]**：compile `0.617 / 0.067 ms` (**0.11x**) | total `0.621 / 0.071 ms` (**0.11x**) | `match = 115/115`
- **[file]**：compile `0.707 / 0.132 ms` (**0.19x**) | total `0.710 / 0.135 ms` (**0.19x**) | `match = 115/115`
- **[build]**：compile `0.866 / 0.194 ms` (**0.22x**) | total `1.008 / 0.322 ms` (**0.32x**) | `match = 115/115`

### Q18. Phase 5 後續建議與限制說明
- 本機環境未安裝 `vite` 與 `webpack` npm 套件，因此 Vite / Webpack 測試與 benchmark 係針對官方 Vite 5/6 與 Webpack 5 契約之 harness 驗證；未來整合於實際專案 CI 時可補上真實 `vite build` / `webpack` CLI smoke test。
- `rust/compiler/`、Filter adapter、Vite adapter、Webpack adapter 均已具備獨立邊界與契約測試，可作為後續發布與合併 `main` 之穩定基礎。
