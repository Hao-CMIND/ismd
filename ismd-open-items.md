# ismd 未完成待辦清單

> 合併自 `ismd-code-review-claude.md` 與 `TODO.md`，只保留**尚未完成、尚未修復**的項目。
> 已修復並確認的項目（屬性內常數折疊、相依刪除／缺檔增量復原、`compileAffected` 單頁選項、`exports.types` 與 `index.d.mts`、`name` 與進階 API 型別宣告）、已完成的 CLI 功能（`--watch`、`-E`、`--doctype`、`-O` 配置檔）與已完成的語法功能已移除。
> 驗證基準：commit `c4931d3`。

## 一、程式碼審查待處理項目

| # | 嚴重度 | 位置 | 問題 | 日常是否遇到 | 狀態／建議 |
|---|---|---|---|---|---|
| 1 | 🟢 Low（架構） | `ismd/crates/ismd_ast/src/token.rs:11` | `Token.token_type` 為堆積配置的 `String`，parser 與 strip_comments 以字串比對分派；型別名稱打錯仍能通過編譯。 | 否 | 暫時不修復。改為帶 serde rename 的 `TokenKind` enum，牽動 `ismd_ast`／`ismd_lexer`／`ismd_strip_comments`／`ismd_parser`／`ismd_napi`，暫不建議。 |
| 2 | 🟢 Low（韌性） | `ismd/crates/ismd_parser/src/lib.rs`（`parse_expr`→`parse_tag`→`tag`→`block` 遞迴）；詞法／產生碼端的遞迴尚未定位 | 極深巢狀（縮排 `div` 約 2,000 層、內嵌 `#[b …]` 約 2,000 層）會讓 Node 行程以 `STATUS_STACK_OVERFLOW`（`0xC00000FD`）直接結束，`catch_unwind` 與 JS `try/catch` 都攔不到。 | 否（實際模板約 10 層內） | 暫時不修復。在遞迴入口加深度計數（上限 500～1000 層），回傳一般 `IsmdError`；或把編譯放到較大堆疊的執行緒。可與 `cargo fuzz` 一併處理。此項以「可信輸入前提」為前提（`ismd/README.md:1411`）。 |
| 3 | 🟢 Low（測試失效） | `ismd/tests/differential/runner.mjs`（`npm run test:diff`、`test:diff:baseline`），不在 `npm test` 內 | 目標端 109 個失敗：filters 相關 61 個（預期）；其餘 48 個尚未分類：`ismd-attrs/JS Artifact` 31（訊息 `ismd is not defined`，疑為 runner 評估環境問題）、`ismd-runtime/Execution Semantics` 6、`ismd-lexer/Error` 3、`ismd/API` 2、`ismd-parser/Token/AST` 2、`ismd/HTML` 1、`ismd/Error` 1、`ismd-load` 1、`ismd-lexer/Token/AST` 1。基準端另有 37 個失敗；`test:diff:baseline` 雜湊比對亦不通過。 | 否 | 未修復。先修 runner 的 `ismd is not defined`（31 個），再逐一比對其餘約 17 個；確定屬預期者列入 `expected-differences.json`，完成後把 `test:diff` 納入 CI。 |
| 4 | 🟡 Medium（正確性） | `ismd/crates/ismd_attrs/src/lib.rs:113-189`（`evaluated_classes`、`class_escaping[i] = false`） | 常數陣列與動態 class 混用時，常數陣列先 `to_js_string()` 成逗號字串，class 以逗號串接。實測 `div(class=['[&>svg]:size-4','block'] class=more)`（locals `{more:'active'}`）輸出 `class="[&amp;&gt;svg]:size-4,block active"`，預期 `[&amp;&gt;svg]:size-4 block active`。常數物件與動態 class 混用時，escaping flag 也會被提早清除。 | **會**（共用 class 陣列加頁面狀態 class） | 未修復。保留結構值與 escaping flag，先完成正確的 class 展平再轉義；補上常數、全動態、混合三種寫法等價的測試。暫時解法（已實測）：`.join(' ')`、展開 `[...常數, more]`，或把常數陣列放進 locals；`class!=[…]` 雖無逗號，但不轉義，只可用於受信任的常數。 |

## 二、審查覆蓋缺口（尚未完成）

- **測試碼未逐行讀**：`ismd/tests/`、`ismd-cli/tests/`、`ismd-webpack-plugin/tests/`、`vite-plugin-ismd/tests/`、`ismd-filters/test/`、`ismd_compiler/tests/`。
- **基準腳本未讀**：`ismd/benchmarks/run-phase5-benchmark.mjs`、`ismd/benchmarks/run-*.mjs`、根目錄 `benchmarks/benchmark.mjs`、`testProject/`。
- **缺少測試的行為**：
  - `TemplateStore` 快取容量上限與淘汰（`MAX_PARSED_CACHE_ENTRIES=4096`，目前無測試）
  - `catch_unwind` panic 隔離（10 處，無測試，難以觸發）
  - `loadNativeAddon` 的挑選邏輯
  - 極深巢狀（對應 #2）
  - `ISMD_PROFILE` 僅單一測試
- **建議之後補**：`cargo fuzz`／property test 針對 lexer 與 parser，重點為遞迴深度（`ismd_walk`、`ismd_linker`）。

## 三、效能（暫時不用做，皆未實作）

- Persistent Disk Cache
- Direct Rust HTML / SSG
- 1000 頁大型 stress
- 複雜 LRU eviction
- Public standalone compiler API 大整理
- 更深入 Lexer／Oxc 微優化

## 四、CLI 未實作

- **STDIN／Pipe 輸入**（例如 `echo 'h1 Ismd!' | ismd`）：❌ 沒做，建議補。目前只接受實體檔案或目錄路徑。
