# ISMD 工程師維護指引

此文件只涵蓋目前 `ismd/` compiler，搭配 [架構](architecture.md)、[Rust API](rust-api.md)、[JS API](javascript-api.md) 閱讀。下列範例依來源 API 撰寫；本次文件工作未執行範例，執行前須完成 [native addon 建置與載入檢查](deployment.md)。

## 1. 先從呼叫端確認問題所在階段

| 問題／工作 | 優先讀取的來源 | 現有測試位置 |
|---|---|---|
| 模板字元、縮排、token、位置錯誤 | [ismd_lexer](../../crates/ismd_lexer/src/lib.rs#L56)、[span.rs](../../crates/ismd_ast/src/span.rs#L38) | [lexer.test.mjs](../../tests/integration/lexer.test.mjs) |
| AST 節點、mixin、控制流程解析 | [ismd_parser](../../crates/ismd_parser/src/lib.rs#L42)、[ast.rs](../../crates/ismd_ast/src/ast.rs#L657) | [parser-scope.test.mjs](../../tests/integration/parser-scope.test.mjs)、[mixin.test.mjs](../../tests/integration/mixin.test.mjs) |
| include／extends 讀檔與路徑 | [ismd_load](../../crates/ismd_load/src/lib.rs#L59)、[compiler default_resolve](../../crates/ismd_compiler/src/lib.rs#L314) | [load.test.mjs](../../tests/integration/load.test.mjs) |
| block append／prepend／replace、繼承結果 | [ismd_linker](../../crates/ismd_linker/src/lib.rs#L14)、[linked_view.rs](../../crates/ismd_compiler/src/linked_view.rs#L78) | [linker.test.mjs](../../tests/integration/linker.test.mjs)、[cases.test.mjs](../../tests/integration/cases.test.mjs) |
| 生成 JS 或屬性／escaping 問題 | [ismd_code_gen](../../crates/ismd_code_gen/src/lib.rs#L68)、[ismd_attrs](../../crates/ismd_attrs/src/lib.rs#L21)、[runtime/index.mjs](../../runtime/index.mjs) | [attrs-codegen.test.mjs](../../tests/integration/attrs-codegen.test.mjs) |
| JavaScript expression／locals 分析 | [ismd_js](../../crates/ismd_js/src/lib.rs#L1) | 各 Rust module 的 `#[cfg(test)]`、[parser-scope.test.mjs](../../tests/integration/parser-scope.test.mjs) |
| 快取、增量更新、刪除與 dispose | [store.rs](../../crates/ismd_compiler/src/store.rs#L159)、[session.rs](../../crates/ismd_compiler/src/session.rs#L67)、[createCompiler](../../index.mjs#L1268) | [template-store.test.mjs](../../tests/integration/template-store.test.mjs)、[compiler-session.test.mjs](../../tests/integration/compiler-session.test.mjs)、[lifecycle-stability.test.mjs](../../tests/integration/lifecycle-stability.test.mjs) |
| JS／Rust 例外轉換或 hook | [ismd_napi](../../crates/ismd_napi/src/lib.rs#L483)、[JS compileBody](../../index.mjs#L662) | [js-api.test.mjs](../../tests/integration/js-api.test.mjs)、[core-decoupling.test.mjs](../../tests/integration/core-decoupling.test.mjs) |
| native extension | [plugin.rs](../../crates/ismd_compiler/src/plugin.rs#L65)、[ismd_plugin_abi](../../crates/ismd_plugin_abi/src/lib.rs#L218) | [native-plugin-poc.test.mjs](../../tests/integration/native-plugin-poc.test.mjs)、[generic_syntax.rs](../../crates/ismd_compiler/tests/generic_syntax.rs) |

這張表只表示測試檔存在且與模組相關，並不代表 `npm test` 會自動跑完全部檔案。實際 scripts 清單見 [ismd/package.json](../../package.json)。

## 2. 選擇 API 與單檔範例

| 需求 | 呼叫方式 | 成功結果 |
|---|---|---|
| 重複用同一模板渲染不同資料 | `compile(source, options)`，之後 `fn(locals)` | 先取得函式，再取得 HTML 字串 |
| 一次取得 HTML | `render(source, optionsAndLocals)` | HTML 字串；options 同時作為 locals |
| 一次編譯多頁 | `compileBatch(entries, defaultOptions, compileOpts)` | 結果陣列；預設成功項含 `fn`，需再呼叫 `result.fn(locals)` |
| 編譯多頁並持續處理異動 | `createCompiler(defaultOptions)` → `compileEntries(entries)` → 異動 API → `compileAffected()` | 保留同一 session；每次編譯回傳結果陣列 |

`compileOpts` 控制包裝、錯誤與平行策略，不是 locals；`wrap:false` 的正常 native batch 結果只有 JS body，沒有 `fn`。上表的增量流程限正常 native session 路徑；host plugin fallback 不註冊 native entries。Native 的 per-entry options 會整份取代 defaults；初次接手時使用 session 層統一選項，可避開不同 entry 的 wrapper 選項差異。詳見 [Batch 分支差異](javascript-api.md)。

在 repo 根目錄建立或使用 ESM 呼叫端時：

```js
import { compile, render } from './ismd/index.mjs';

const template = compile('p= message', { filename: 'example.ismd' });
const html = template({ message: 'Hello' });
const dependencies = template.dependencies;

const directHtml = render('p= message', {
  filename: 'example.ismd',
  message: 'Hello',
});
```

`template` 是函式；`html`／`directHtml` 是字串；`dependencies` 是相依檔案路徑陣列。`render` 會把 options 本身作為 locals；`compile` 則把編譯設定與每次呼叫的 locals 分開。證據：[compile/render](../../index.mjs#L952)。

## 3. 虛擬檔案與增量範例

```js
import path from 'node:path';
import { createCompiler } from './ismd/index.mjs';

const compiler = createCompiler({ compileDebug: false });
const page = path.resolve('example.ismd');
try {
  compiler.updateFiles({ [page]: 'p= message' });
  const first = compiler.compileEntries([{ id: 'page', filename: page }]);
  const html = first[0].fn({ message: 'Hello' });

  const report = compiler.updateFiles({ [page]: 'h1= message' });
  const next = compiler.compileAffected();
  // report.affectedEntries 是已註冊 entry 的 id；next 是批次結果陣列。
} finally {
  compiler.dispose();
}
```

先 `compileEntries` 建立 entry／依賴關係，再更新已知檔案，才有可追蹤的受影響 entry。`updateFiles` 更新的是記憶體來源，不會寫入磁碟；`removeFiles` 也不是 filesystem 刪除。JS `dispose()` 後多數工作方法經 `assertAlive` 拒絕呼叫，`stats()` 與 `isDisposed` 仍可讀。證據：[createCompiler](../../index.mjs#L1268)、[CompilerSession::register_entries](../../crates/ismd_compiler/src/session.rs#L98)。

### 3.1 異動與失敗恢復

以下是依目前原碼整理的呼叫方式，前提是正常 native session 路徑。呼叫端應保存完整 entries（含 id、filename、options），並統一使用相同絕對路徑，避免相對／絕對路徑在 store 中形成不同 key；`id` 不必等於 filename，不能直接把所有 affected IDs 當路徑。

若保存的 entry 另含 inline `source`，重試時須同步換成最新內容，或先用 `updateFiles` 更新 store，再以省略 source 的 entry 重編；不要重新傳入舊 source，因為編譯會優先使用它。[compile_single_entry_inner](../../crates/ismd_compiler/src/session.rs#L479)

| 情境 | 操作與限制 |
|---|---|
| 已知 include 的記憶體內容改變 | `updateFiles({[path]: source})`，再 `compileAffected()`；相同內容不會新增待編譯項目 |
| 已知磁碟檔改變 | `invalidateFiles(path)`，再 `compileAffected()`，下一次從磁碟讀取。若 entry 註冊時附 inline `source`，invalidate 不會清掉它；改用 `updateFiles` 提供新內容，或以不含 source 的 entry 再次 `compileEntries` |
| 已知檔案刪除 | `removeFiles(path)`；先保存報告的 `affectedEntries`，再處理重編結果。被刪除的入口本身已取消註冊，其他依賴它的入口可能報缺檔錯誤 |
| 刪除後重建／改名 | 補回來源後，以呼叫端保存的完整 entry 清單對受影響入口明確 `compileEntries`；新／改名入口也須註冊。remove 已刪 DAG 邊，不能假設單靠新路徑的 `updateFiles → compileAffected` 找回舊依賴 |
| `compileAffected` 失敗 | pending 在編譯前已清空，沒有失敗自動重排／重試。修正來源後明確 `compileEntries` 重編失敗入口；只再呼叫 `compileAffected()` 可能得到 `[]` |
| `clear()` 後繼續使用 | 重新提供虛擬來源並 `compileEntries` 註冊入口；不是呼叫 `compileAffected` 就能恢復所有頁面 |
| JS `dispose()` 後繼續工作 | 建立新的 `createCompiler()`；原 facade 已停用，不能靠 clear 重新開啟 |

為保留重試範圍，先取得 `compiler.getAffectedEntries()` 的 IDs，再呼叫 `compileAffected({throwOnError: false})`。若正常回傳結果，挑選 `ok:false` 的 IDs；若整個呼叫 throw 而沒有結果陣列，就以先前保存的 IDs 對應最新 entry 定義重編。IDs 必須由呼叫端對映回 filename／options，不要直接當作 filename 陣列傳入。

來源：[update／invalidate](../../crates/ismd_compiler/src/session.rs#L128)、[remove_files](../../crates/ismd_compiler/src/session.rs#L192)、[compile_affected_with_mode](../../crates/ismd_compiler/src/session.rs#L338)、[clear](../../crates/ismd_compiler/src/session.rs#L362)、[normalize_cache_path](../../crates/ismd_compiler/src/store.rs#L664)。

### 3.2 區分編譯錯誤與執行錯誤

```js
import { compileBatch } from './ismd/index.mjs';

try {
  const results = compileBatch(
    [
      { id: 'page', filename: 'page.ismd', source: 'p= message' },
      { id: 'missing-input' }, // 沒有 source 或有效 filename，示範編譯失敗項目。
    ],
    { compileDebug: false },
    { throwOnError: false },
  );
  for (const result of results) {
    if (!result.ok) {
      console.error('編譯失敗', result.id, result.error);
      continue;
    }
    try {
      const html = result.fn({ message: 'Hello' });
      console.log(html);
    } catch (error) {
      console.error('模板執行失敗', result.id, error);
    }
  }
} catch (error) {
  console.error('批次呼叫或函式包裝失敗', error);
}
```

`throwOnError:false` 讓已轉成結果的編譯錯誤留在陣列中，不會替稍後的 `fn(locals)` 捕捉例外。上述第二項依原碼回報一般 `Error`，message 指出該 entry 缺少 `source` 或 `filename`；不是保證帶 ISMD code 的錯誤。[compile_single_entry_inner](../../crates/ismd_compiler/src/session.rs#L479)。Native batch 預設 throw 時也不代表其他 entry 沒編譯或快取已回滾；詳細差異見 [錯誤邊界](javascript-api.md)。

## 4. 修改時維持的契約

1. 改參數或結果時，同時比對 JS implementation、N-API DTO 與 Rust types；不要只依 `index.d.ts`，它尚未涵蓋完整 export surface。
2. 改 AST/load/link 時檢查 mutable 與 linked view 兩條路徑，並以 include、extends、named block、mixin 的既有測試確認輸出。
3. 改快取時分清 JS function cache、Rust source/parse/resolve/output cache 與 session `fnCache`。只有重新產生 source 不等於其他層都失效，應追查相關更新函式。
4. 改 batch options 時分別檢查 native 與 JS fallback 路徑；兩者目前 options 合併與結果欄位並非完全一致。
5. 測試 JS 前先確定載入新編譯的 addon；`loadNativeAddon` 會優先選現成 `.node`，不是自動選最新 `.dll`。

證據：[JavaScript API 的實作差異](javascript-api.md)、[儲存模型](database.md)、[loadNativeAddon](../../index.mjs#L13)。

## 5. 變更驗證與文件維護

維護 include／extends 時，可先執行現有 Rust 比對測試（執行目錄為 `ismd/`）：

```powershell
cargo test -p ismd_compiler linked_view_matches_mutable_linker_across_inheritance_and_yield
```

該測試以 `DefaultHost` 與 `ForceMutableHost` 編譯同一組繼承、named block、yield、mixin、raw include 輸入，對照生成的 body 與 dependencies；後者明確令 `supports_linked_view()` 回傳 false。這是兩種 host 設定的結果比對，沒有斷言 fast host 的每個輸入必定未 fallback，因此不能把它當成所有 linked-view 分支覆蓋證明。[ForceMutableHost](../../crates/ismd_compiler/src/lib.rs#L969)、[比對測試](../../crates/ismd_compiler/src/lib.rs#L993)

執行時需確認 runner 確實列出該測試且通過；Cargo exit code 為 0 但顯示 0 tests 不代表測到此案例。之後仍依變更範圍執行 Rust workspace、Node integration 與 differential；此單一案例不取代完整 regression。

必要測試隨功能選擇，完整入口與限制見 [deployment.md](deployment.md)。純文件修改使用路徑／行號、函式簽章與格式查核；compiler 行為變更則依專案 [AGENTS.md](../../AGENTS.md) 執行適當 Rust、Node integration、differential tests，再建立 commit。

本組文件不把現有診斷報告中的測試數字、效能倍數或相容率當作此次驗證結果。更新方法簽章、選項預設值或執行分支時，請一併更新 API 表、流程圖與程式碼連結；保留「宣告型別」與「由 JS 實作整理的型別」的區別。
