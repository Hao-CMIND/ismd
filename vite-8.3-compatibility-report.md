# Vite 8.3 相容性驗證報告 (`vite-8.3-compatibility-report.md`)

## 1. 環境與測試摘要

- **Vite Adapter 路徑**：`rust/vite/index.js`（`@pug-rust/vite`）
- **實測 Vite 版本**：`vite@8.3.8`（含 Rolldown）
- **實測 Node 版本**：`v22.23.3`
- **Package Metadata**：`peerDependencies.vite: "^8.3.0"`、`engines.node: "^20.19.0 || >=22.12.0"`
- **Git Branch**：`feat/vite-plugin`

---

## 2. 實測數據與 End-to-End Baseline

### 真實 Vite 8.3.8 End-to-End 實測（`step14-vite8-real.test.js`）
- **Production Build (`vite.build` + Rolldown)**：`101.89 ms`（PASS，無 Unknown module type、無 Rolldown parse error）
- **Dev HMR（含真實 Chokidar filesystem watcher + HTTP module fetch）**：
  - Page HMR：`32.33 ms`
  - Include HMR (`header.pug`)：`31.40 ms`
  - Layout HMR (`default.pug`)：`36.40 ms`
  - No-op Save：`32.52 ms`（`affectedCompiles` 未增加，0 次編譯）
  - Add / Unlink / Atomic Save：全數 PASS
- **Session 生命週期**：`sessionCreates = 1`；`vite.build` 於 `closeBundle()` 釋放（`disposes = 1`, `stats = null`）；`server.close()` 於 `closeServer()` / `httpServer.close` 釋放（`disposes = 1`, `stats = null`）。

---

## 3. 16 項核心驗證問題回答

1. **實際測試 Vite version？**  
   `8.3.8`（安裝於 `rust/vite/node_modules/vite`，未納入 Git）。
2. **實際 Node version？**  
   `v22.23.3`（符合 Vite 8.3.8 `engines.node`: `^20.19.0 || >=22.12.0`）。
3. **`transform` 是否需要 `moduleType: 'js'`？**  
   是。已於 `rust/vite/index.js` 的 `transform.handler()` 回傳 `{ code, map: null, moduleType: 'js' }`，明確告知 Vite 8 / Rolldown `.pug` 轉換結果為 JavaScript ES module。
4. **Hook Filter 是否成功使用？**  
   是。已依 Vite 8.3.8 型別（`ObjectHook<..., { filter?: { id?: StringFilter } }>`）實作 `transform: { filter: { id: /\.pug(?:\?|$)/i }, handler(code, id) { ... } }`，並於 handler 內保留 `isPugFile(cleanId)` 第二層防呆；真實 `vite.build` 與 `vite.createServer` 均正常運作。
5. **`buildStart` 是否完成整理？**  
   是。`buildStart()` 保留 `active.compileBatch(batch)` prewarm 與 `metrics.initialBatchCompiles += 1`，不再回傳編譯結果給 Vite。
6. **`handleHotUpdate` 是否繼續正常？**  
   是。真實 Vite 8.3 測試中同時發現 Windows 路徑問題：`CompilerSession` 回傳反斜線路徑，而 Vite `moduleGraph.getModulesByFile()` 使用 POSIX 正斜線鍵值；已於 `handleHotUpdate` 以 `posixId` 查詢 `moduleGraph`，並保留 `// Future: Vite Environment API / hotUpdate migration` 註記。
7. **Vite dev 是否成功？**  
   是。`vite.createServer()` + `server.listen()` + HTTP `?import` 模組請求與 `.pug?import` query 皆回傳正確 JS 模組。
8. **`vite build` 是否成功？**  
   是。`vite.build()` + Rolldown 打包輸出包含正確 HTML 字串，無 parse error 或 unknown module type。
9. **page HMR 是否正常？**  
   是。修改 `index.pug` 僅重編 1 個受影響 entry（`lastAffectedCount = 1`），觸發 `full-reload` 並於 HTTP 取得最新內容。
10. **include HMR 是否正常？**  
    是。修改 `header.pug` 透過 Dependency DAG 重編所有受影響頁面（`index.pug`、`about.pug`），`about.pug?import` 立即取得 `Header V2`。
11. **layout HMR 是否正常？**  
    是。修改 `default.pug` 透過 Dependency DAG 重編所有繼承頁面，`index.pug?import` 立即取得新版 layout。
12. **add/unlink/atomic save 是否正常？**  
    是。真實 chokidar `add`、`unlink` 與暫存檔 `renameSync` atomic save 均正常更新或移除並產出正確結果。
13. **`CompilerSession` 是否只建立一次？**  
    是。整個 `vite dev` 與 `vite build` 生命週期中 `sessionCreates = 1`。
14. **Server close 是否 dispose？**  
    是。`server.close()` 觸發 `closeServer()` / `httpServer.close` 並執行 `disposeSession()`，確認 `disposes = 1` 且 `stats = null`。
15. **是否有需要修改 Compiler Core？**  
    否。全程未修改 `rust/compiler/` 任何 Rust/NAPI/Core 程式碼、Webpack Adapter 或 Filter Adapter。
16. **Vite Adapter 是否可以正式宣告支援 Vite 8.3？**  
    是。所有必要項目（真實 `vite@8.3.8` 安裝、`vite dev`、`vite build`、`.pug` transform、`moduleType: 'js'`、Hook Filter、page/include/layout HMR、no-op = 0 compile、add/unlink/atomic save、單一 `CompilerSession` 重用、dispose、726/726 differential）皆已通過驗證。
