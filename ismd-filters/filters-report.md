# Phase 4 — Native Filters 完整化綜合評估與驗收報告

> 日期：2026-11-14
> 工作區：`.worktrees/feat-filter-separation` (分支：`feat/filter-separation`)
> 依據規範：[PLAN.md](file:///d:/ismd-rust/PLAN.md) Phase 4、[AGENTS.md](file:///d:/ismd-rust/AGENTS.md)

---

## 一、Phase 4 總體進度與執行結論

本報告整合了原 Phase 4A（Provider 與 Options 契約）、Phase 4B（語法與 Filtered Include）、Phase 4C（Provider Registry 與快取安全）與 Phase 4D（相容性與整合驗收）之全維度分析與實測結果：

1. **核心解耦完全維持**：
   - Compiler Core 中 100% 不含 Filter 專用語意，無 Filter 專用 Lexer/Parser/AST。
   - 零 JS Transformer、零 JS Filter Callback、零 `ismd_filters` 靜態相依。
2. **Native 擴充管線確立**：
   - 經由 `ismd_plugin_abi` 定義之 C-ABI 規格與動態函式庫載入器（`NativePluginManager`），語法擴充（以 `:uppercase` 為原生外掛範例）由 Rust 原生接管。
3. **驗收結論**：
   - 當前狀態標記：【**Phase 4 IN PROGRESS（基礎架構建立，待補齊正式 Provider 與選項擴展）**】。
   - 嚴守工程誠實度規範：在正式 Markdown/Sass Provider 及 `:name(options)` 正式落地前，不虛假標記 Phase 4 COMPLETE。

---

## 二、Phase 4A：Native Provider 與 Options 契約

### 1. C-ABI Payload 規範
- **規格版本**：`ISMD_PLUGIN_ABI_VERSION = 1`。
- **輸入結構 (`IsmdTransformRequest`)**：包含 `rule_id`、`target_name`、`content` (StringView)、`options_json` (StringView)、`filename`、`line`、`column`。
- **輸出結構 (`IsmdTransformResponse`)**：明確區分純文字（`ISMD_OUTPUT_TEXT = 0`）、原始 HTML（`ISMD_OUTPUT_RAW_HTML = 1`，跳過 HTML escaping）與錯誤訊息。

### 2. 靜態選項求值原則
- Ismd 模板語法支援 `:name(options)` 形式。
- **純 Rust 靜態求值**：重用既有 `ismd_js::eval_static_expression` 解析字串、數字、布林、`null`、陣列與物件常數，並轉換為 JSON 傳遞至 `options_json`，**絕不透過 JavaScript Runtime 求值**。
- **錯誤診斷對齊**：
  - 動態識別子（如 `dynamicVar`）或無法靜態求值之表達式，明確報出 `ISMD:FILTER_OPTION_NOT_CONSTANT`。
  - 不支援之 JS 語法（如 `null ?? 1`、`tag\`hi\``、正則呼叫）明確報出 `ISMD:UNSUPPORTED_CONSTANT`。

---

## 三、Phase 4B：語法支援矩陣與 Filtered Include

### 1. 語法型態實測結果

| 語法型態 | 語法範例 | 實測現況 | 說明與後續規劃 |
|---|---|---|---|
| **:name (區塊型)** | `:uppercase\n  body` | **PASS** | 完整透過 `generic_extension` -> `Node::Extension` -> Native Plugin Transform 執行。 |
| **:name(options)** | `:uppercase(opt="v")\n  body` | **待實作** | Lexer 產出屬性 token，Parser 需支援 Extension Node 選項解析。 |
| **Inline Filter** | `p #[strong:uppercase text]` | **PASS** | 目前作為一般標籤擴展處理，無語法衝突。 |
| **Nested Filter** | `:outer\n  :inner\n    text` | **PASS** | 縮排與內嵌區塊文字正常保留並遞迴傳遞。 |
| **include:name** | `include:markdown file.md` | **待實作** | Phase 3 為清除 Legacy Filter 自 Lexer 移除了 `include:filter` 分支。需以通用 Resource Prefix 重新引進。 |
| **Raw Text / 多行** | 多行文字、縮排、空白行 | **PASS** | 換行與縮排由 Pipeless Text 完美保留。 |
| **UTF-8 / Emoji / CRLF** | `你好世界 🚀 <foo & bar>` | **PASS** | UTF-8 位移無截斷，HTML 特殊字元正確保留。 |
| **一般 Ismd 語法保護** | `a: img(src="pic.jpg")` | **PASS** | 冒號標籤擴展完全不受外掛語法影響。 |
| **Mixin 區塊內置** | `+article()\n  :uppercase\n    content` | **PASS** | Mixin 與 Block 內置原生擴充完全相容。 |
| **未知外掛診斷** | `:nonexistent\n  text` | **PASS** | 明確回報 `Unsupported target filter` 錯誤。 |

### 2. Filtered Include 架構規範
- **通用資源讀取**：重用 `ismd_load` 通用檔案解析與安全規則，不得自建 Filter 專用 loader。
- **DAG 依賴與快取追蹤**：外部資源檔案（如 `.md`, `.txt`）必須納入 `dependencies`。外部檔案異動時，CompilerSession DAG 自動觸發失效與增量重編。

---

## 四、Phase 4C：Native Provider Registry 與快取安全

### 1. 外掛管理器能力
- **ABI 安全與動態載入**：嚴格檢核 `abi_version`，查詢 `ismd_plugin_entry_v1` 入口符號。
- **編譯實例快取隔離 (Instance Isolation)**：
  - 透過 `select_plugins(&options.native_plugins)` 僅啟用該次編譯被授權之外掛，動態函式庫由 `TemplateStore` 以 `Arc<LoadedNativePlugin>` 快取，絕不重複 `LoadLibrary`。
  - 不同編譯實例之間的外掛規則完全隔離，無全域污染風險。
- **並行與生命週期控制**：
  - 驗證 `ISMD_PLUGIN_CAP_THREAD_SAFE` 標記。
  - `Arc<LoadedNativePlugin>` 確保 Rayon 工作執行緒工作完成前動態函式庫不被提前卸載。
  - 外掛內部配置之記憶體（`IsmdPluginBuffer`）一律由外掛自身匯出之 `free_fn` 回收。

### 2. 快取指紋與失效條件
- CompilerSession 輸出快取 Hash 組合已納入 `template_name`、`native_plugins` 與 `generic_syntax`。
- 後續多 Provider 擴充時，Provider ID、Version、Alias 映射表與 Options 將一併納入 Hash，防範不安全快取共用。

---

## 五、Phase 4D：9 組 Legacy 相容性 TODO 現況對照

參考 `filters/test/compatibility-pending.test.js` 與保存於 `filters/test/legacy/` 之原始測試：

| TODO 組別 | 原始測試來源 | 核心驗證需求 | 目前進度與規劃 |
|---|---|---|---|
| **1. nested_filters_and_aliases** | `ismd_filters-tests.rs.txt` | 巢狀外掛鏈結、由右至左順序、別名映射與選項覆蓋 | **部分完成**：巢狀區塊與文字保留已驗證；多外掛鏈結與別名排入 Phase 4 Provider Registry 擴展。 |
| **2. alias_chain_and_dynamic_option** | `ismd_filters-tests.rs.txt` | 別名鏈限制、循環別名偵測、動態選項報錯 | **規格收斂**：`ismd_js::eval_static_expression` 具備動態選項診斷能力。 |
| **3. constant-folding Step 4B.1** | `constant-folding.test.js.txt` | 靜態常量求值 (`1 + 2 * 3`, `obj`, `arr`)、非法語法報錯 | **規格收斂**：明確定義使用通用常量評估器，不依賴 JS 執行。 |
| **4. constant-folding Step 4B.2** | `constant-folding.test.js.txt` | Filtered Include、原始 Buffer/字串傳遞、檔案路徑注入 | **待實作**：需擴充通用 Resource Include 語法與相依追蹤。 |
| **5. constant-folding Step 4B.4** | `constant-folding.test.js.txt` | 歷史 10 個 `filters*.ismd` 端到端 HTML 與 Codegen 一致性 | **待正式 Provider**：需具備 Markdown/Sass Provider 方可全量回歸。 |
| **6. constant-folding Step 4B.5** | `constant-folding.test.js.txt` | `UNKNOWN_FILTER` 定位、外掛拋出異常之錯誤傳遞 | **已完成**：未知外掛明確回報 `Unsupported target filter`。 |
| **7. filters.test.js** | `filters.test.js.txt` | 延遲載入、Provider 優先順序、快取複用 | **已完成**：`NativePluginManager` 已實作 `Arc` 快取與延遲載入。 |
| **8. filter-separation.test.js** | `filter-separation.test.js.txt` | 零外掛專案不載入外掛庫、禁用外掛安全策略 | **已完成**：無外掛路徑零動態函式庫載入，已在整合測試驗證。 |
| **9. attrs-codegen Step 5.4** | `attrs-codegen.test.js.txt` | `FILTER_OPTION_NOT_CONSTANT` 與 `UNSUPPORTED_CONSTANT` 區分 | **規格收斂**：契約完整對齊。 |

---

## 六、二進位容量與效能實測數據

### 1. 二進位容量對照（單位：KB，四捨五入至小數點後一位）

| 產物 | Phase 1 Baseline | Phase 2 PoC | Phase 3/4 最終實測 | 相較 Phase 1 變化 | 相較 Phase 2 變化 |
|---|---:|---:|---:|---:|---:|
| **Release `ismd_napi.dll` (`index.node`)** | 4,273.5 KB (4,376,064 bytes) | 4,365.5 KB (4,470,272 bytes) | **4,126.5 KB** (4,225,536 bytes) | **-147.0 KB (-3.44%)** | **-239.0 KB (-5.47%)** |
| **Release `ismd_filter_uppercase.dll`** | 無 | 122.0 KB (124,928 bytes) | **122.0 KB** (124,928 bytes) | +122.0 KB (外掛) | 0.0 KB (持平) |

> 核心 `.node` 體積在移除 Legacy Filter 程式碼與依賴後顯著瘦身 **-147.0 KB**，低於原版 Baseline。

### 2. 同條件效能與記憶體指標（Release Profile, Node.js v22）

- **No-Plugin 單檔編譯**：**0.0627 ms/op**（約 16,000 ops/sec，維持極速）
- **Native Plugin 單檔編譯**：**0.2643 ms/op**
- **Batch Rayon (50 頁)**：**15.1169 ms**（平均單頁 **0.3023 ms**）
- **Peak RSS**：**47.72 MB**

---

## 七、全量回歸測試結果

- **Rust 核心測試**：`cargo test --workspace`：**47 passed; 0 failed (100% PASS)**
- **適配器與工具鏈**：
  - `@ismd-rust/cli`: 1 PASS
  - `@ismd-rust/vite`: 2 PASS
  - `@ismd-rust/webpack`: 2 PASS
  - 核心整合測試（`core-decoupling`, `template-store`, `compiler-session`, `js-api`, `skeleton`）：**14 PASS**
- **Ismd 差異測試 (`core-decoupling.test.js`)**：**53 passed; 0 failed (100% PASS)**
- **Native Plugin 整合測試**：**13 passed; 0 failed (100% PASS)**
- **相容性待辦測試 (`compatibility-pending.test.js`)**：**2 passed / 9 TODO**

---

## 八、Phase 4 推進與後續建議

1. **Phase 4 剩餘實作順序**：
   - 擴充 Parser 支援 Extension Node 選項解析（呼叫 `eval_static_expression` 產生 `options_json`）。
   - 擴充 Lexer 支援通用 Resource Include（`include:rule:target file`）。
   - 實作基於 `pulldown-cmark` 的正式 Native Markdown Provider。
2. **Phase 5 效能規劃**：
   - 於所有正式 Provider 完成後，進行同條件冷啟動、P95 延遲、大量頁面平行編譯等完整 Benchmark。
3. **發布與合併決策**：
   - 目前仍處於 `feat/filter-separation` 分支；因涉及 Breaking Changes 與 Provider 擴充，**建議維持分支獨立，暫不合併至 `dev`，待正式 Provider 完備後再行合併**。
