# Native Filters 相容性遷移矩陣

日期：2026-11-14。Phase 3 只驗收 Core 解耦，未執行 Phase 4。

| 原案例 | 保存位置 | Native / 通用替代 | 狀態 |
|---|---|---|---|
| ismd_filters nested_filters_and_aliases_and_options_order | legacy/ismd_filters-tests.rs.txt | compatibility-pending.test.js | TODO：Nested / aliases / options |
| ismd_filters alias_chain_and_dynamic_option_errors_and_dependency_walk | 同上 | core-decoupling.test.js 已驗證載入相依走 Native Transform；其餘 TODO | 部分遷移 |
| filters.test.js（4 個原測試） | legacy/filters.test.js.txt | native.test.js：無 JS transformer 相依、缺 library 錯誤 | Provider 安裝順序 / Markdown / Cache 語意 TODO |
| filter-separation.test.js（2 個原測試） | legacy/filter-separation.test.js.txt | native.test.js + core-decoupling.test.js | 無 Plugin 與 Native 邊界已遷移；舊 JS executor 已移除 |
| constant-folding Step 4B.1 / 2 / 4 / 5 | legacy/constant-folding.test.js.txt（原檔全文） | compatibility-pending.test.js | TODO：options、filtered include、provider 輸出、錯誤 |
| constant-folding Step 4B.3 | 同上 | compiler/tests/integration/core-decoupling.test.js | PASS：Include / Extends 內的 Native Transform 及 Session 更新 |
| attrs-codegen Step 5.4 中 provider options | legacy/attrs-codegen.test.js.txt（原檔全文） | compatibility-pending.test.js；一般 constant/attribute 案例保留原測試 | Provider options TODO |
| skeleton JS filter callback | legacy/skeleton.test.js.txt（原檔全文） | 原 skeleton 改測 Native uppercase + 通用 hooks；preLex re-entrancy 仍測試 | PASS；JS provider callback 已不支援 |

TODO 顯示 9 個需求群組，並非只有 9 個細部相容性條件。保存原始斷言是為後續逐項移植，不能把 .txt 檔案當已執行的測試。
既有大型 differential runner、linker / release-api 等歷史 fixture suites 仍保留作基準，需備妥 raw/compiler 才能執行；其中 Legacy Filter API 預期值必須遷移，不得直接當作 Native PASS。
