# ISMD 技術交接文件

本組文件以現有原始碼為依據，供新進工程師接手 `ismd/` 的 Rust／JavaScript 編譯流程；閱讀不需要先取得撰寫時的對話或技能檔案。

## 文件導覽

| 文件 | 用途 |
|---|---|
| [architecture.md](architecture.md) | 系統邊界、15 個 Rust crate、單檔編譯／渲染、linked view、batch／增量流程 |
| [rust-api.md](rust-api.md) | Rust struct／enum／trait、函式與方法的 Arguments、Return 型別及來源 |
| [javascript-api.md](javascript-api.md) | JS exports、session 物件方法、runtime、options/results、TypeScript 宣告與實作差異 |
| [database.md](database.md) | 資料庫查核結果、實際記憶體 store／cache／DAG 與資料生命週期 |
| [deployment.md](deployment.md) | toolchain、建置、native addon 載入、測試與部署現況 |
| [developer-guide.md](developer-guide.md) | 維護查找表、最小呼叫範例、變更驗證方式 |

第一次接手時，先讀部署文件的環境前提與安裝缺口，再看維護指引的 API 選擇與範例；定位問題時依架構圖查對應 Rust 方法。長期 session 的失敗重試、刪除後重建與共享 store 注意事項，分別見維護指引及儲存模型。

常用名詞：**N-API** 是此套件的 Node.js／Rust 呼叫邊界；**DTO** 是跨該邊界傳遞的資料物件；**AST** 是模板語法樹；**DAG** 在本專案指用來追蹤模板依賴及反向受影響項目的圖；**entry** 是呼叫端註冊的一個編譯入口，`id` 是結果識別字串、`filename` 是路徑，兩者不必相同；**locals** 是呼叫生成模板函式時傳入的資料。

## 範圍與型別標示

- 分析日期：`2026-11-16`；分支：`dev`；原始碼基準 commit：`9bd5ce46680a8e3d0ccf4983aad91d8e3db80afd`。
- 重點為 `ismd/crates/**/*.rs`、`ismd/index.mjs`、`ismd/register.mjs`、`ismd/runtime/**/*.mjs`。`.js` fixture 不視為套件 API；測試及 benchmark 是驗證／診斷入口，不列為產品公開方法。
- 使用者要求的「類別」在 Rust 對應 struct／enum／trait 及其 impl；JS `createCompiler()` 回傳帶方法的物件。文件保留真實語言結構。
- Rust 的 Arguments／Return 依原碼宣告；JS 沒有靜態註記的 API，以實作整理描述型別，並與 `index.d.ts` 宣告分開。`void`／`undefined`／`()` 依語言與宣告分別解釋。
- 程式碼連結相對於本文件目錄，指向 repo 中的真實檔案與 `#L` 行號；行號是這次查核快照，後續改碼應同步更新。
- 既有未追蹤文件、診斷輸出與 fixture 不作為已實作功能的唯一證據，也未納入本次修改。外部 workspace adapter 的完整 API 不在本次範圍。

## 驗證界線

本次為純文件變更：查核來源路徑、簽章、文件連結及 Markdown 格式，沒有為了文件執行會重建 native addon 的整套測試。文件中的測試指令是原碼可追查的維護入口，不代表該測試已在本次執行或通過。

Rust API 主表的 282 個函式／方法已逐筆比對來源名稱、Arguments 與 Return；維護指引的 JavaScript 範例已通過 `node --check` 語法檢查，沒有執行範例或載入 native addon。文件亦經獨立讀者測試，檢查建置、API 選擇、增量更新、編譯流程與錯誤處理能否從文件直接回答；這不等同編譯器功能測試。

未確認的環境資訊包括實際生產主機、部署帳號、服務啟動方式及發布程序；原碼未提供的部分已在部署文件標明。未找到資料庫不會被補寫成假設 schema。
