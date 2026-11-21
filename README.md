# ISMD

以 Rust 與 Oxc 實作的 ISMD 模板編譯器，透過 NAPI-RS 提供 Node.js 原生模組。模板語法為縮排式 HTML，副檔名為 `.pug`。
語法與 API 行為以 [tests/cases/](tests/cases/) 中的案例為準（`.pug` 與預期 `.html`）。

## 目錄

- [支援環境](#支援環境)
- [安裝與建置](#安裝與建置)
- [快速開始](#快速開始)
- [API 參考](#api-參考)
- [語言參考](#語言參考)
- [範例](#範例)
- [安全性與輸入邊界說明](#安全性與輸入邊界說明)
- [已核准差異](#已核准差異)
- [raw/pug 原有功能移除清單](#rawpug-原有功能移除清單)
- [新版專屬功能清單（舊版 Pug 2.x 所沒有的功能與使用方式）](#新版專屬功能清單舊版-pug-2x-所沒有的功能與使用方式)

## 支援環境

- **Node.js**：`>= 20.0.0`（於 `v22.23.3` 完成驗證）
- **平台與架構**：Windows `x64`，預建置原生模組 `ismd-napi.win32-x64-msvc.node`
- **Rust 工具鏈**（從原始碼重建時）：依 `rust-toolchain.toml` 與 `Cargo.lock` 鎖定版本

> 其他作業系統或 CPU 架構未在本輪實測驗證，不列入已驗證支援範圍。

## 安裝與建置

### 從 GitHub 安裝
```bash
npm install github:Hao-CMIND/ismd#pkg-ismd
```

### 從原始碼建置
```bash
npm run build
```

等同於 `cargo build -p ismd_napi`。`index.mjs` 會依序載入 `ismd-napi.win32-x64-msvc.node`、`target/release/ismd_napi.dll` 或 `target/debug/ismd_napi.dll`。

## 快速開始

```js
import ismd from './index.mjs';

const html = ismd.render('p= msg', { msg: 'Hello ISMD' });
// => '<p>Hello ISMD</p>'

const fn = ismd.compile('ul\n  each item in items\n    li= item', { compileDebug: false });
fn({ items: ['a', 'b'] });
// => '<ul><li>a</li><li>b</li></ul>'
```

模板檔案 `card.pug`：

```ismd
mixin card(title)
  .card
    h2= title
    block

+card('歡迎')
  p 開始使用 ISMD。
```

```js
ismd.renderFile('card.pug');
// => '<div class="card"><h2>歡迎</h2><p>開始使用 ISMD。</p></div>'
```

以下各節的 API 與語法細節，請依序閱讀。

## API 參考

### 1. 安裝與載入

```bash
# 建置原生 addon（需要 Rust toolchain，見 rust-toolchain.toml）
cargo build -p ismd_napi
```

ESM 載入（`package.json` 的 `"type": "module"`）：

```js
import ismd from 'ismd';                       // 預設匯出（同時具備所有具名匯出）
import { render, compile, createCompiler } from 'ismd';
```

在目前 repo 內直接引用：

```js
import ismd from './index.mjs';
```

| 項目 | 需求 |
|---|---|
| Node.js | `>= 20.0.0`（`package.json` 的 `engines`）；已於 Node 22.23.3 驗證 |
| 作業系統 | 目前隨附的 addon 為 `win32-x64-msvc`；其他平台需自行以 `cargo build -p ismd_napi` 建置 |
| 模組格式 | ESM（`.mjs`） |

載入順序：`index.mjs` 會依序尋找 `ISMD_PROFILE_ADDON`（僅在 `ISMD_PROFILE=1` 時）、`ismd-napi.win32-x64-msvc.node`、`target/release/ismd_napi.dll`、`target/debug/ismd_napi.dll`。
找不到時會拋出 `ismd_napi native module not found. Run cargo build -p ismd_napi first.`

---

### 2. 匯出一覽

| 匯出 | 類型 | 說明 |
|---|---|---|
| `name` | `'ISMD'` | 引擎名稱 |
| `render(str, options?, cb?)` | 函式 | 字串模板 → HTML 字串（§3） |
| `renderFile(path, options?, cb?)` | 函式 | 檔案模板 → HTML 字串（§3） |
| `compile(str, options?)` | 函式 | 字串模板 → 渲染函式（§4） |
| `compileFile(path, options?)` | 函式 | 檔案模板 → 渲染函式（§4） |
| `__express(path, options, cb)` | 函式 | Express 視圖引擎介面（§7） |
| `createCompiler(defaults?)` | 函式 | 建立有狀態的 Compiler Session，支援增量編譯（§8） |
| `compileBatch(entries, defaults?, compileOpts?)` | 函式 | 一次編譯多個模板（§8） |
| `createTemplateStore()` | 函式 | 建立可在多個 session／批次間共享的快取容器（§8） |
| `clearDefaultTemplateStore()` | 函式 | 清空預設 template store |
| `defaultTemplateStoreStats()` | 函式 | 讀取預設 template store 統計 |
| `runtime` | 物件 | 執行期輔助函式：`attr`、`attrs`、`classes`、`escape`、`merge`、`rethrow`、`style`（§11） |
| `cache` | 物件 | 模板快取（以檔案路徑為鍵），僅在 `cache: true` 時寫入 |
| `lex(str, options?)` | 函式 | 詞法分析，回傳 token 陣列（除錯用） |
| `parse(tokens, options?)` | 函式 | 語法分析，回傳 AST（除錯用） |
| `walk(ast, before?, after?, options?)` | 函式 | 走訪 AST |
| `stripComments(tokens, options?)` | 函式 | 依 token 移除註解 |
| `resolveNativePluginPath(plugin)` | 函式 | 解析原生外掛路徑（§10） |
| `resolveNativePlugins(plugins)` | 函式 | 批次解析原生外掛路徑（§10） |
| `getLastProfileJson()` | 函式 | 讀取最近一次的效能 profile（需要 profile 版 addon） |

以下以 `_` 開頭的匯出（`_lex`、`_parse`、`_load`、`_link`、`_compileAttrs`、`_addWith`、`_runtimeBuild`、`_error` 等）為**內部 API**，不保證穩定，請勿在應用程式中依賴。

> **型別宣告注意**：`index.d.ts` 目前只宣告基本 API（`compile`、`render`、`renderFile` 等）。
> `createCompiler`、`compileBatch`、`createTemplateStore`、`lex`、`parse`、`walk` 等 ISMD 新增 API **沒有**型別宣告；
> 在 TypeScript 中使用時需自行補上 `declare` 或以 `any` 接收。

---

### 3. 渲染：render / renderFile

#### `render(str, options?)` → `string`

```js
import { render } from 'ismd';

render('p Hello #{name}', { name: 'World' });
// => '<p>Hello World</p>'
```

第二個參數同時作為**編譯選項**與**模板 locals**：整個 `options` 物件會原樣傳給模板函式作為 locals，
而其中已知的編譯選項鍵（如 `doctype`、`self`、`globals`、`compileDebug`）同時會影響編譯。
因此若 locals 的變數名稱與選項同名（例如 `doctype`），會同時被當成選項解讀，建議避開這些名稱。

#### `render(str, options?, callback)` / `render(str, callback)`

以 Node 風格回呼回傳結果，**回呼是同步執行的**：

```js
render('p= a.b', { a: null }, (err, html) => {
  if (err) console.error(err.message);
  else console.log(html);
});
```

- 成功：`callback(null, html)`
- 失敗：`callback(error)`（不會拋出例外）
- 回傳值為 `callback` 的回傳值

#### `renderFile(path, options?)` → `string`

讀取檔案並渲染。`options.filename` 會被自動設為 `path`，因此 `include` / `extends` 的相對路徑以該檔案所在目錄為基準。

```js
import { renderFile } from 'ismd';

const html = renderFile('./views/post.pug', { post: { title: 'Hi' } });
```

`renderFile(path, options, callback)` 與 `renderFile(path, callback)` 形式同 `render`。

---

### 4. 編譯：compile / compileFile

#### `compile(str, options?)` → `(locals?) => string`

回傳的函式帶有 `dependencies` 屬性（`string[]`，列出被 `include` / `extends` 讀取的檔案路徑）。

```js
import { compile } from 'ismd';

const fn = compile('ul\n  each item in items\n    li= item', { compileDebug: false });
fn({ items: ['a', 'b'] });   // => '<ul><li>a</li><li>b</li></ul>'
fn.dependencies;             // => []
```

> `compile` 的選項**不含** `name` 與 `module`。

#### `compileFile(path, options?)` → `(locals?) => string`

讀取檔案後編譯。若 `options.cache` 為 `true`，會以 `path` 為鍵寫入 `cache`，之後再次呼叫會直接回傳快取的函式。

```js
const fn = compileFile('./views/page.pug', { cache: true });
```

---

### 5. 編譯選項

所有 API 共用的選項。未列出的鍵會被忽略。

| 選項 | 型別 | 預設 | 適用 API | 說明 |
|---|---|---|---|---|
| `filename` | `string` | — | 全部 | 模板檔案路徑。`include` / `extends` 的相對路徑需要此值（字串模板沒有 `filename` 時使用相對路徑會拋錯）。錯誤訊息也會帶上此路徑。 |
| `basedir` | `string` | — | 編譯類 | 解析以 `/` 開頭之 `include` / `extends` 路徑的根目錄。 |
| `doctype` | `string` | — | 全部 | 強制輸出的 doctype 模式，例如 `'html'`、`'xml'`（影響 void 元素與自閉合寫法）。 |
| `pretty` | `boolean \| string` | `false` | 全部 | `true` 代表使用兩個空白縮排；字串則作為縮排字元。 |
| `self` | `boolean` | `false` | 全部 | 開啟後，模板中可以用 `self.x` 存取 locals（而非直接使用 `x`）。 |
| `globals` | `string[]` | `[]` | 全部 | 允許模板直接存取的全域名稱（需要在 Node 全域中存在，例如 `process`）。 |
| `compileDebug` | `boolean` | `true` | 全部 | `false` 時省略錯誤時的原始碼片段與行號資訊。`__express` 在 `NODE_ENV=production` 且未指定時預設為 `false`。 |
| `includeSources` | `boolean` | — | 編譯類 | 只有 `compileDebug === true` 時才會內嵌原始碼（由 API 自動設定）。 |
| `inlineRuntimeFunctions` | `boolean` | `false` | 全部 | 是否內嵌 runtime 函式。 |
| `cache` | `boolean` | `false` | `render`、`renderFile`、`compileFile` | 以 `filename` 為鍵快取編譯結果。 |
| `plugins` | `Array<string \| object>` | `[]` | 全部 | 外掛清單，見 §10。 |
| `debug` | `any` | — | 全部 | 會傳入編譯流程，**本文件未驗證其行為**，請勿依賴。 |

> `render` 在 `cache: true` 而沒有 `filename` 時會拋出 `the "filename" option is required for caching`。

---

### 6. 錯誤物件

語法錯誤與執行期錯誤都會拋出（或透過回呼傳回）`Error` 物件，並附加以下欄位：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `message` | `string` | 含行號與原始碼片段的完整訊息（`compileDebug` 為 `true` 時） |
| `code` | `string` | 錯誤代碼，例如 `ISMD:UNEXPECTED_TEXT` |
| `msg` | `string` | 不含原始碼片段的簡短訊息 |
| `line` | `number` | 行號（從 1 開始） |
| `column` | `number \| undefined` | 欄號 |
| `filename` | `string \| undefined` | 檔案路徑 |
| `src` | `string \| undefined` | 原始碼（僅 `compileDebug: true` 時） |
| `toJSON()` | `function` | 回傳 `{ code, msg, line, column, filename }` |

範例：

```js
try {
  render('div(\n  p x');
} catch (err) {
  console.log(err.code); // ISMD:NO_END_BRACKET
  console.log(err.line); // 2
}
```

常見錯誤代碼（實際觀察到的）：

| `code` | 觸發情境 |
|---|---|
| `ISMD:UNEXPECTED_TEXT` | 在不允許文字的位置出現文字，例如沒有註冊外掛時使用 `:uppercase` 過濾器語法 |
| `ISMD:NO_END_BRACKET` | 屬性括號 `(` 未閉合 |
| `ISMD:INCONSISTENT_INDENTATION` | 縮排不一致 |
| `ISMD:SYNTAX_ERROR` | 內嵌 JavaScript 運算式語法錯誤（例如 `p= (`） |
| `ISMD:MALFORMED_INCLUDE` | `include:` 的過濾器名稱格式不正確 |
| `ISMD:EXTENDS_NOT_FIRST` | `extends` 不在模板第一個節點 |
| `ISMD:UNEXPECTED_TOKEN` | 語法 token 不符合預期 |
| `ENOENT` | 找不到 `include` / `extends` 的檔案（Node 原生錯誤） |

執行期錯誤（例如存取 `null` 的屬性）會以 JavaScript 原生的 `TypeError` 訊息呈現，並附上行號，例如：
`Cannot read properties of null (reading 'b') on line 1`。

---

### 7. Express 整合：__express

```js
import express from 'express';
import { __express } from 'ismd';

const app = express();
app.engine('ismd', __express);
app.set('view engine', 'ismd');
app.set('views', './views');
```

- 簽章：`__express(path, options?, callback)`；`options` 省略時可以直接傳入 callback。
- 若 `options.compileDebug` 未設定且 `process.env.NODE_ENV === 'production'`，會自動設為 `false`。
- 實作上直接呼叫 `renderFile`，因此錯誤與 `renderFile` 相同。

---

### 8. 批次與 Compiler Session

#### `compileBatch(entries, defaults?, compileOpts?)`

一次編譯多個模板。`entries` 元素可以是：

- 字串：檔案路徑（會以 `fs.readFileSync` 讀取）
- 物件：`{ id?, filename?, source?, options? }`
  - `source` 存在時使用它，否則讀取 `filename`
  - `options` 會與 `defaults` 合併

```js
import { compileBatch } from 'ismd';

const results = compileBatch(
  [
    { id: 'home', source: 'h1 首頁' },
    { id: 'bad', source: 'p= (' },
  ],
  { compileDebug: false },
  { throwOnError: false },
);

results.map((r) => [r.id, r.ok]); // [['home', true], ['bad', false]]
results[0].fn();                  // '<h1>首頁</h1>'
results[1].error.code;            // 'ISMD:SYNTAX_ERROR'
```

每個結果的欄位：`id`、`ok`、`fn`（成功時）、`body`、`dependencies`、`cacheHit`、`error`（失敗時）。

`compileOpts`：

| 選項 | 說明 |
|---|---|
| `throwOnError` | 預設行為是遇到第一個錯誤即拋出；設為 `false` 時改為逐一回報於結果的 `ok` / `error`。 |
| `parallel` | `boolean` 或門檻數字，控制是否以平行方式編譯（Rust 端實作）。 |
| `parallelThreshold` | 與 `parallel` 數字形式等效。 |

#### `createCompiler(defaults?)`

建立有狀態的 Compiler Session：適合監看檔案變動、只重新編譯受影響的模板。

```js
import { createCompiler } from 'ismd';

const compiler = createCompiler({ basedir: './views', compileDebug: false });

compiler.updateFiles({
  'page.pug': 'extends layout.pug\nblock content\n  p hi',
  'layout.pug': 'html\n  body\n    block content',
});

const [page] = compiler.compileBatch(['page.pug']);
page.fn(); // '<html><body><p>hi</p></body></html>'

compiler.updateFiles({ 'layout.pug': 'html\n  body\n    main\n      block content' });
compiler.getAffectedEntries();  // 受影響的入口檔案清單
compiler.compileAffected();     // 只重新編譯受影響者

compiler.dispose();
```

| 方法 | 說明 |
|---|---|
| `updateFiles(files)` | 新增或更新虛擬檔案，`files` 為 `{ 路徑: 原始碼 }`。會使依賴它的入口失效。 |
| `invalidateFiles(paths)` | 標記檔案為已變動（不改變內容）。 |
| `removeFiles(paths)` | 移除檔案與對應的函式快取。 |
| `getAffectedEntries()` | 回傳因變動而需要重新編譯的入口路徑。 |
| `compileAffected(opts?)` | 只編譯受影響的入口，回傳結果陣列（同 `compileBatch` 格式）。沒有受影響者時回傳 `[]`。 |
| `compileEntries(entries, opts?)` / `compileBatch(entries, opts?)` | 同頂層 `compileBatch`，但共享此 session 的快取。 |
| `clear()` | 清空快取，但保留 session。 |
| `stats()` | 回傳 `{ sources, parsed, resolved, outputs, dagNodes, dagEdges, sourceHits, sourceMisses, parseHits, parseMisses, outputCacheHits, outputCacheMisses, fnCache }`。 |
| `dispose()` | 釋放 session（可重複呼叫）。之後呼叫其他方法會拋出 `CompilerSession has been disposed`。 |
| `isDisposed` | `boolean` 屬性。 |

#### `createTemplateStore()`

建立可共享的快取容器，傳入 `createCompiler({ templateStore })` 或 `compileBatch(..., { templateStore })` 即可讓多個 session 共用解析與輸出快取。

```js
const store = createTemplateStore();
const a = createCompiler({ templateStore: store });
const b = createCompiler({ templateStore: store });
```

`clearDefaultTemplateStore()` 與 `defaultTemplateStoreStats()` 操作預設 store。

---

### 9. 注意事項

以下行為**已實際驗證，使用時需要注意**：

| 項目 | 說明 |
|---|---|
| 引擎名稱 | `name === 'ISMD'`。 |
| 內建過濾器已移除 | `ismd.filters` 不存在。`:name` 與 `include:name` 語法**不會**自動生效，必須透過原生外掛提供（見 §10）。沒有外掛時會拋出 `ISMD:UNEXPECTED_TEXT`。 |
| 未定義變數 | 已驗證：`p= missing` 會輸出空字串（`<p></p>`），不會拋出 `ReferenceError`。若需要嚴格檢查，請自行在 locals 中提供預設值。 |
| `globals` | 只能列出 Node 全域中實際存在的名稱，否則執行時拋出 `xxx is not defined`。 |
| 字串模板與相對路徑 | 使用 `render` / `compile` 搭配 `include` / `extends` 的相對路徑時，必須提供 `filename`（或 `basedir`），否則拋出 `the "filename" option is required...`。 |
| `pretty` 輸出 | `pretty` 會在輸出開頭加入換行符號。 |
| 屬性的 boolean 寫法 | 預設輸出 `checked="checked"`；設定 `doctype: 'html'` 時輸出 `checked`。 |
| 型別宣告 | `index.d.ts` 不含 ISMD 新增 API（見 §2）。 |
| 平台 | 隨附 addon 僅 Windows x64；其他平台需要自行建置。 |
| `require` 註冊 | `import 'ismd/register'`（即 `register.mjs`）會註冊 `.pug` 副檔名的 `require` 處理器；透過 `ismd.compileFile(filename)` 直接匯出編譯完成的模板函式。 |

---

### 10. 外掛（plugins）

`plugins` 選項接受兩種形式，可以混用：

#### 11.1 原生外掛（Native plugin）

以動態函式庫（`.dll` / `.so` / `.dylib`）實作，透過 `ismd_plugin_abi` 的 C ABI 介接。

```js
import { render } from 'ismd';
import { nativePluginPath } from '../ismd-filters/index.mjs'; // 本 repo 外的 ismd-filters 套件

const plugins = [nativePluginPath()];

render('div\n  :uppercase\n    hello 世界', { plugins });
// => '<div>HELLO 世界</div>'
```

- 字串：檔案路徑，或可被 `require.resolve` 解析的模組名稱。
- 物件：`{ nativePath: '…' }` 或 `{ path: '…' }`。
- 路徑不存在或載入失敗時，會拋出 `Failed to load native dynamic plugin at '…'`。

`resolveNativePluginPath(plugin)` 可在不實際載入的情況下確認路徑是否解析成功（失敗回傳 `null`）。

#### 11.2 JavaScript 掛鉤（hook）物件

以物件提供同步掛鉤函式，於對應的編譯階段被呼叫：

| 掛鉤 | 階段 |
|---|---|
| `postLoad` | 載入檔案（入口與 `include` / `extends` 的依賴）之後 |
| `preTransform` / `postTransform` | AST 轉換（過濾器等）前後 |
| `preLink` / `postLink` | 模板連結（`extends` / `block`）前後 |
| `preCodeGen` / `postCodeGen` | 產生程式碼前後 |
| `lex` | 詞法分析擴充：物件的函式成員會以 `plugin.lex.<方法>(lexer)` 的形式於 lexer 中被呼叫，回傳真值表示已處理 |

> 上表列出的是原生 `index.mjs` 實際接受的掛鉤名稱（對應 `hasHostCustomizations`）。
> 掛鉤回傳的值會被轉回 Rust 端的 AST 結構驗證，結構錯誤會拋出例外。

```js
const trace = {
  preTransform(ast) { console.log('AST type:', ast.type); return ast; },
};

render('p hi', { plugins: [trace] });
```

掛鉤必須回傳合法的 AST；回傳 `null` 或錯誤結構會拋出 `Invalid return value from preCodeGen: …`。

---

### 11. Runtime 輔助函式

`runtime`（來自 `runtime/index.mjs`）提供產生 HTML 時使用的輔助函式：

| 函式 | 說明 |
|---|---|
| `escape(value)` | HTML 跳脫（`<`、`>`、`&`、`"`、`'`） |
| `attr(key, val, escaped, terse)` | 產生單一屬性字串 |
| `attrs(obj, terse)` | 將物件轉為屬性字串 |
| `classes(value, escaping?)` | 將陣列／物件轉為 class 字串 |
| `merge(a, b)` | 合併屬性物件（`class` 會串接，`style` 會合併） |
| `style(value)` | 將物件或字串轉為 style 字串 |
| `rethrow(err, filename, lineno, src)` | 補上錯誤來源資訊後重新拋出 |

```js
import { runtime } from 'ismd';

runtime.escape('<a>');                            // '&lt;a&gt;'
runtime.attrs({ a: 1, b: true, c: false }, false); // ' a="1" b="b"'
runtime.classes(['a', { b: true, c: false }]);     // 'a b'
```

## 語言參考

### 1. 基本結構與縮排

每個非空行是一個節點。縮排代表父子關係，**同一個檔案內的縮排單位必須一致**（全部空白或全部 tab，且每層寬度相同）。

```ismd
html
  body
    h1 Title
```

```html
<html><body><h1>Title</h1></body></html>
```

縮排不一致會拋出 `ISMD:INCONSISTENT_INDENTATION`：

```text
p
    a
  b          // 第 3 行縮排為 2 格，與前面的 4 格不一致
```

---

### 2. Doctype

```ismd
doctype html
html
```

```html
<!DOCTYPE html><html></html>
```

- `doctype html` 輸出 HTML5 doctype。
- `doctype` 與 `doctype html` 等效（不帶參數時預設為 html）。
- 其他字串會原樣輸出，例如 `doctype custom stuff` → `<!DOCTYPE custom stuff>`。
- 也可以在 API 層以 `doctype` 選項強制模式（見 [編譯選項](#5-編譯選項)）。

---

### 3. 標籤、class 與 id

| 寫法 | 結果 |
|---|---|
| `p` | `<p></p>` |
| `.card` | `<div class="card"></div>`（省略標籤名稱時預設為 `div`） |
| `#main` | `<div id="main"></div>` |
| `a.btn.primary` | `<a class="btn primary"></a>` |
| `div#app.container` | `<div class="container" id="app"></div>` |

```ismd
a.btn.primary(href='/save') 儲存
#app
.card
  p 內容
```

```html
<a class="btn primary" href="/save">儲存</a><div id="app"></div><div class="card"><p>內容</p></div>
```

自閉合標籤：以 `/` 結尾。HTML void 元素（如 `img`、`input`）預設會輸出為 `<img .../>` 形式。

```ismd
img(src='a.png')
foo/
```

```html
<img src="a.png"/><foo/>
```

> **注意（以關鍵字開頭的連字號標籤名稱）**：與原版 Pug 一致，`case`、`each`、`while`、`when`、`default`、`include`、`if`、`unless` 等關鍵字採用單字邊界比對。直接寫成 `case-study hi`、`each-item hi`、`while-x hi`、`when-x hi`、`default-x hi`、`include-x hi` 會報錯，而 `if-x hi`、`unless-x hi` 會被當成條件式（`blockquote`、`block-quote`、`caseless`、`eachrow`、`iffy`、`my-case-study`、`x-each` 等不受影響）。撰寫此類自訂元素（Web Components）時，請改用標籤插值或原生 HTML：
> - `#{"case-study"} hi`
> - `#{"each-item"}(a="1") hi`
> - `<case-study>hi</case-study>`

---

### 4. 屬性

屬性寫在標籤後的括號 `( … )` 內，以逗號或空白分隔。值是 JavaScript 運算式；字串需用引號。

```ismd
- var user = { id: 7 }
a(href='/users/' + user.id, target='_blank') 個人頁
a(href='/x' target='_blank') 空白分隔也可以
```

```html
<a href="/users/7" target="_blank">個人頁</a><a href="/x" target="_blank">空白分隔也可以</a>
```

#### 4.1 布林與空值

| 值 | 輸出 |
|---|---|
| 沒有值的屬性名稱（如 `checked`） | `checked="checked"` |
| `true` | 同上 |
| `false`、`null`、`undefined` | 省略該屬性 |
| 空字串 `''` | `foo=""` |
| 數字 `0` | `foo="0"` |

```ismd
input(type='checkbox', checked, disabled=false)
p(foo=null)
p(foo='')
```

```html
<input type="checkbox" checked="checked"/><p></p><p foo=""></p>
```

#### 4.2 class 與 style

`class` 可以是字串、陣列或物件（值為真的鍵會被輸出）。與標籤上的 `.class` 會合併。

```ismd
a(class=['foo', 'bar'])
a.foo(class='bar').baz
a(class={active: true, hidden: false})
```

```html
<a class="foo bar"></a><a class="foo bar baz"></a><a class="active"></a>
```

#### 4.3 資料屬性（data-*）

非字串值（物件、陣列）會被序列化為 JSON 並跳脫：

```ismd
- var user = { name: 'tobi' }
foo(data-user=user, data-items=[1,2,3], data-username='tobi')
```

```html
<foo data-user="{&quot;name&quot;:&quot;tobi&quot;}" data-items="[1,2,3]" data-username="tobi"></foo>
```

#### 4.4 `&attributes`：展開屬性物件

`&attributes(obj)` 會把物件的所有鍵展開為屬性：

```ismd
- var attrs = {foo: 'bar', bar: '<baz>'}
div&attributes(attrs)
```

```html
<div foo="bar" bar="<baz>"></div>
```

> **注意**：`&attributes` 展開的值**不會**被跳脫（見 `tests/cases/attrs.pug`）。
> 請勿把未經處理的使用者輸入直接傳入 `&attributes`；若只是一般屬性，請使用 `name=value`（會跳脫）或 `name!=value`（不跳脫，見 §4.5）。

#### 4.5 不跳脫的屬性：`!=`

```ismd
script(type='text/x-template')
  div(id!='user-<%= user.id %>')
```

```html
<script type="text/x-template"><div id="user-<%= user.id %>"></div></script>
```

#### 4.6 多行屬性

括號內可以跨行，行尾逗號與換行皆可：

```ismd
a(
  href='/x'
  class='btn'
) 連結
```

```html
<a class="btn" href="/x">連結</a>
```

---

### 5. 文字與插值

#### 5.1 行內文字

標籤後直接接文字：

```ismd
h1 Title
p 這是一段文字
```

```html
<h1>Title</h1><p>這是一段文字</p>
```

#### 5.2 `#{}`：跳脫插值

```ismd
- var name = '<World>'
p Hello #{name}
```

```html
<p>Hello &lt;World&gt;</p>
```

#### 5.3 `!{}`：不跳脫插值

```ismd
- var html = '<em>raw</em>'
p Raw: !{html}
```

```html
<p>Raw: <em>raw</em></p>
```

#### 5.4 跳脫 `#{}`

在 `#` 前加反斜線 `\`，會輸出字面文字：

```ismd
p \#{text} 不會被插值
```

```html
<p>#{text} 不會被插值</p>
```

#### 5.5 插值中使用 JavaScript

```ismd
p My ID #{"is {" + 42 + "}"}
```

```html
<p>My ID is {42}</p>
```

#### 5.6 `#[ … ]`：行內標籤

在文字中嵌入一個完整的標籤（可包含屬性與文字）：

```ismd
p bing #[strong foo] bong
p #[a(href='/') 首頁] 之後
```

```html
<p>bing <strong>foo</strong> bong</p><p><a href="/">首頁</a> 之後</p>
```

---

### 6. 輸出運算式：`=` 與 `!=`

| 語法 | 行為 |
|---|---|
| `p= expr` | 計算 `expr`，**跳脫**後輸出為元素內容 |
| `p!= expr` | 計算 `expr`，**不跳脫**輸出 |

```ismd
- var s = '<b>粗體</b>'
p= s
p!= s
```

```html
<p>&lt;b&gt;粗體&lt;/b&gt;</p><p><b>粗體</b></p>
```

`null`、`undefined` 與 `''` 會輸出空內容；數字 `0` 與布林 `false` 會輸出為字串。

```ismd
p= null
p= 0
p= false
```

```html
<p></p><p>0</p><p>false</p>
```

---

### 7. 程式碼：`-`

以 `-` 開頭的行是**不輸出**的 JavaScript 程式碼，變數會在模板範圍內可用。

```ismd
- var x = 2
- var y = x * 3
p= y
```

```html
<p>6</p>
```

多行程式碼區塊以 `-` 開頭並搭配縮排與結尾的 `-`：

```ismd
ul
  - [1, 2].forEach(function (n) {
    li= n
  - })
```

```html
<ul><li>1</li><li>2</li></ul>
```

> **注意（頂層 `let`／`const`／`class` 限制）**：由於模板執行期採用與原版 Pug 一致的 `with` 作用域包裝，在**頂層**使用 `- let x = 1`、`- const a = 1` 或 `- class A {}` 並在後續讀取該識別字時，會拋出 `SyntaxError: Identifier '...' has already been declared`。請在頂層改用 `var`（或 `function` 宣告），或將 `let`／`const` 放進區塊（如 `if`、`each`、`mixin`）內使用。

---

### 8. 註解

| 語法 | 輸出 |
|---|---|
| `// 文字` | 輸出為 HTML 註解 `<!-- 文字-->` |
| `//- 文字` | **不輸出** |
| `//` 後接縮排區塊 | 整段縮排內容輸出為 HTML 註解 |

```ismd
//- 這行不會出現在輸出中
// 這行會輸出為 HTML 註解
p 可見文字
```

```html
<!-- 這行會輸出為 HTML 註解--><p>可見文字</p>
```

---

### 9. 條件與迴圈

#### 9.1 `if` / `else if` / `else` 與 `unless`

```ismd
- var role = 'editor'

if role === 'admin'
  p 管理者
else if role === 'editor'
  p 編輯者
else
  p 訪客

unless role
  p 沒有角色
```

```html
<p>編輯者</p>
```

也可以使用 JavaScript 區塊形式（花括號）：

```ismd
- if (true) {
  p foo
- } else {
  p bar
- }
```

```html
<p>foo</p>
```

#### 9.2 `case` / `when` / `default`

```ismd
- var n = 2
case n
  when 1: p one
  when 2
    p two
  default: p other
```

```html
<p>two</p>
```

`when` 可以不寫任何內容，直接落到下一個 `when` 的內容（fall-through）。

#### 9.3 `each`（與 `for`）

`each` 與 `for` 同義，支援陣列與物件：

```ismd
- var items = ['a', 'b', 'c']
ul
  each item, i in items
    li(class='item-' + i)= item
```

```html
<ul><li class="item-0">a</li><li class="item-1">b</li><li class="item-2">c</li></ul>
```

物件的鍵值：

```ismd
- var user = { name: 'tobi', age: 10 }
ul
  each val, key in user
    li #{key}: #{val}
```

```html
<ul><li>name: tobi</li><li>age: 10</li></ul>
```

使用 `$` 等合法 JavaScript 識別字作為變數名稱也可以：`each $item in items`。

#### 9.4 `each … else`

當集合為空時執行 `else` 分支：

```ismd
- var users = []
ul
  each user in users
    li= user.name
  else
    li 沒有使用者
```

```html
<ul><li>沒有使用者</li></ul>
```

#### 9.5 `while`

```ismd
- var x = 1
ul
  while x < 4
    - x++
    li= 'step ' + x
```

```html
<ul><li>step 2</li><li>step 3</li><li>step 4</li></ul>
```

---

### 10. Block expansion（行內子元素）

標籤後接冒號 `:`，可在同一行寫一個子元素：

```ismd
ul
  li: a(href='#') foo
  li.list-item: .foo: #bar baz
```

```html
<ul><li><a href="#">foo</a></li><li class="list-item"><div class="foo"><div id="bar">baz</div></div></li></ul>
```

---

### 11. Mixin

Mixin 是可重複使用的模板片段：以 `mixin` 定義，以 `+` 呼叫。

#### 11.1 定義與呼叫

```ismd
mixin item(t)
  li= t

ul
  +item('a')
  +item('b')
```

```html
<ul><li>a</li><li>b</li></ul>
```

#### 11.2 預設值與 rest 參數

```ismd
mixin m(a, b = 2)
  p= a + b
+m(1)
```

```html
<p>3</p>
```

```ismd
mixin list(tag, ...items)
  #{tag}
    each item in items
      li= item

+list('ul', 1, 2, 3)
```

```html
<ul><li>1</li><li>2</li><li>3</li></ul>
```

#### 11.3 呼叫時傳入內容區塊（`block`）

Mixin 內的 `block` 會被替換為呼叫端縮排的內容：

```ismd
mixin box
  div.box
    block

+box
  p hi
```

```html
<div class="box"><p>hi</p></div>
```

#### 11.4 `attributes` 與呼叫端屬性

Mixin 內可以用 `attributes` 取得呼叫端傳入的屬性，並以 `&attributes(attributes)` 轉交給內部元素：

```ismd
mixin link(href, label = href)
  a&attributes(attributes)(href=href)= label

+link('/home')
+link('/about', '關於我們')(target='_blank')
```

```html
<a href="/home">/home</a><a href="/about" target="_blank">關於我們</a>
```

呼叫時可以直接在名稱後接 class / id 與屬性：

```ismd
mixin card(title)
  .card(class=attributes.class)
    h2= title

+card('最新文章').featured
```

```html
<div class="card featured"><h2>最新文章</h2></div>
```

多行呼叫時，屬性括號可以跨行：

```ismd
mixin foo
  div.thing(attr1='foo')&attributes(attributes)

+foo(
  attr3="qux"
  class="baz"
)
```

```html
<div class="thing baz" attr1="foo" attr3="qux"></div>
```

#### 11.5 行內呼叫

Mixin 也可以在文字中以 `#[+name(…)]` 形式呼叫：

```ismd
mixin linkit(url)
  a(href=url)= url

p 網址：#[+linkit('http://example.com')]
```

```html
<p>網址：<a href="http://example.com">http://example.com</a></p>
```

---

### 12. 版型：extends、block、include

版型功能需要模板的 `filename`（`renderFile`、`compileFile`，或 `render` 時傳入 `filename`）。

#### 12.1 `block` 與 `extends`

版型檔案定義可被覆寫的 `block`，子模板以 `extends` 指定版型，並覆寫需要的區塊：

`views/layout.pug`

```ismd
doctype html
html
  head
    title= title
    block head
      link(rel='stylesheet', href='/site.css')
  body
    main
      block content
```

`views/post.pug`

```ismd
extends layout.pug

block append head
  script(src='/post.js')

block content
  article
    h1= post.title
```

規則：

- `extends` 必須是模板中的第一個有效節點（否則拋出 `ISMD:EXTENDS_NOT_FIRST`）。
- `block name`：覆寫版型中同名區塊（取代內容）。
- `block append name`：附加在原內容之後。
- `block prepend name`：加在原內容之前。
- 版型中的 `block` 可以有預設內容；子模板未覆寫時會使用預設值。
- 可以同時有多個 `extends` 鏈（子模板再被其他模板 `extends`），`block` 會逐層合併。

以 `renderFile('views/post.pug', data)` 渲染的結果可見 [範例 6](#範例)。

#### 12.2 `include`

`include` 會把另一個檔案的內容插入此處。

```ismd
main
  include partials/header.pug
```

- 副檔名為 `.pug` 的檔案會被當作模板編譯並插入。
- 其他副檔名（如 `.html`）會原樣插入，不做處理。
- 以 `/` 開頭的路徑以 `basedir` 為根目錄；其他路徑相對於目前檔案所在目錄。

`include` 的文字區塊可用於 `script`、`style` 等原始內容：

```ismd
script#pet-template(type='text/x-template')
  include auxiliary/pet.pug
```

---

### 13. 管道文字與原始文字區塊

#### 13.1 管道文字 `|`

`|` 之後的文字會原樣輸出，適合多行文字與混合行內標籤：

```ismd
p
  | 第一行
  | 含 #[strong 行內標籤]
  | 第三行
```

```html
<p>第一行 含 <strong>行內標籤</strong> 第三行</p>
```

#### 13.2 標籤後接 `.`：文字區塊

標籤名稱後接 `.` 會把縮排內容視為**純文字**（不解析為標籤），包括 `#{}` 插值仍然有效：

```ismd
- var name = 'ISMD'
script.
  if (foo) {
    bar();
  }
pre.
  保留縮排
  #{name} 仍會被插值
```

```html
<script>if (foo) {
  bar();
}</script><pre>保留縮排
ISMD 仍會被插值</pre>
```

---

### 14. 過濾器（filter）

過濾器語法 `:name` 與 `include:name` 會把區塊內容交給具名的轉換器處理（例如 Markdown、CSS 前處理）。

- ISMD **核心沒有內建過濾器**。`ismd.filters` 已被移除。
- 過濾器必須由**原生外掛**提供，並在編譯選項 `plugins` 中指定（見 [外掛](#10-外掛plugins)）。
- 未註冊時，`:name` 會拋出 `ISMD:UNEXPECTED_TEXT`，`include:name` 會拋出 `ISMD:MALFORMED_INCLUDE`。

```js
import { render } from 'ismd';
import { nativePluginPath } from '../ismd-filters/index.mjs';

render('div\n  :uppercase\n    hello 世界', { plugins: [nativePluginPath()] });
// => '<div>HELLO 世界</div>'
```

沒有外掛時，`:uppercase` 行會被視為一般文字並拋出錯誤：

```text
ISMD:UNEXPECTED_TEXT
```

---

### 15. 錯誤

編譯期錯誤會附上檔案、行號與原始碼片段（`compileDebug` 為 `true` 時）。範例：

```text
Ismd:2:6
    1| div(
  > 2|   p x
------------^

The end of the string reached with no closing bracket ) found.
```

錯誤代碼與處理方式請見 [錯誤物件](#6-錯誤物件)。

## 範例

以下範例皆可直接執行。`renderFile` 的第二個參數為 locals；輸出為 `compileDebug` 預設值下的實際結果。

### 範例 1：基本結構與插值

locals：`{ pageTitle: "ISMD 範例", name: "World" }`

```ismd
doctype html
html(lang='zh-Hant')
  head
    meta(charset='utf-8')
    title= pageTitle
  body
    #app.container
      h1 Hello, #{name}!
      p.lead 這是一段純文字，支援 #[strong 行內標籤] 與 #[em 強調]。
      ul
        li: a(href='/docs') 文件
        li: a(href='/api') API
```

```html
<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>ISMD 範例</title></head><body><div class="container" id="app"><h1>Hello, World!</h1><p class="lead">這是一段純文字，支援 <strong>行內標籤</strong> 與 <em>強調</em>。</p><ul><li><a href="/docs">文件</a></li><li><a href="/api">API</a></li></ul></div></body></html>
```

### 範例 2：屬性

locals：`{ user: { id: 7, name: "王小明" }, active: true, rawValue: "&amp;" }`

```ismd
- var base = 'btn'
a(href='/users/' + user.id, class=[base, 'primary'])= user.name
a.btn(href='/help', target='_blank') 說明
input(type='checkbox', checked=active, disabled=false)
label(class={active: active, hidden: !active}) 狀態
div(data-user=user, data-count=3)
div&attributes({role: 'region', 'aria-live': 'polite'})
p(title='<引號> "雙引號"') 屬性會被跳脫
p(data-raw!=rawValue) 不跳脫的屬性
```

```html
<a class="btn primary" href="/users/7">王小明</a><a class="btn" href="/help" target="_blank">說明</a><input type="checkbox" checked="checked"/><label class="active">狀態</label><div data-user="{&quot;id&quot;:7,&quot;name&quot;:&quot;王小明&quot;}" data-count="3"></div><div role="region" aria-live="polite"></div><p title="&lt;引號&gt; &quot;雙引號&quot;">屬性會被跳脫</p><p data-raw="&amp;">不跳脫的屬性</p>
```

### 範例 3：條件、迴圈與 case

locals：`{ role: "editor", items: [{ title: "第一筆" }, { title: "第二筆" }] }`

```ismd
- var total = items.length

if role === 'admin'
  p 管理者
else if role === 'editor'
  p 編輯者
else
  p 訪客

unless items.length
  p 沒有資料
else
  p 共 #{total} 筆

ul
  each item, i in items
    li(class='row-' + i)= item.title
  else
    li 目前沒有項目

case role
  when 'admin': p 可以刪除
  when 'editor'
    p 可以編輯
  default
    p 唯讀

- var n = 0
ul
  while n < 3
    - n++
    li= 'step ' + n
```

```html
<p>編輯者</p><p>共 2 筆</p><ul><li class="row-0">第一筆</li><li class="row-1">第二筆</li></ul><p>可以編輯</p><ul><li>step 1</li><li>step 2</li><li>step 3</li></ul>
```

### 範例 4：mixin

無需 locals。

```ismd
mixin card(title)
  .card(class=attributes.class)
    h2= title
    .card-body
      block

mixin tags(...names)
  ul.tags
    each name in names
      li= name

mixin link(href, label = href)
  a&attributes(attributes)(href=href)= label

+card('最新文章').featured
  p 這是卡片內容。
  +tags('node', 'rust', 'template')

+link('/home')
+link('/about', '關於我們')(target='_blank')
```

```html
<div class="card featured"><h2>最新文章</h2><div class="card-body"><p>這是卡片內容。</p><ul class="tags"><li>node</li><li>rust</li><li>template</li></ul></div></div><a href="/home">/home</a><a href="/about" target="_blank">關於我們</a>
```

### 範例 5：跳脫與註解

locals：`{ userInput: "<script>alert(1)</script>", name: "ISMD" }`

```ismd
- var safe = '<b>粗體</b>'
p 跳脫輸出：#{userInput}
p 不跳脫輸出：!{safe}
p= userInput
p!= safe
//- 這行註解不會出現在 HTML 中
// 這行註解會輸出為 HTML 註解
p 字面上的井號：\#{notAVariable}
pre.
  原始文字區塊
    保留縮排
  #{name} 仍會被插值
```

```html
<p>跳脫輸出：&lt;script&gt;alert(1)&lt;/script&gt;</p><p>不跳脫輸出：<b>粗體</b></p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p><b>粗體</b></p><!-- 這行註解會輸出為 HTML 註解--><p>字面上的井號：#{notAVariable}</p><pre>原始文字區塊
  保留縮排
ISMD 仍會被插值</pre>
```

### 範例 6：版型、extends 與 include

以 `renderFile("views/post.pug", { title: "部落格", post: { title: "新版 ISMD", body: "使用 Rust 重寫的模板引擎。", tags: ["rust", "template"] } })` 渲染。

`views/layout.pug`：

```ismd
doctype html
html
  head
    title= title
    block head
      link(rel='stylesheet', href='/site.css')
  body
    include partials/header.pug
    main
      block content
    block footer
      footer 版權所有
```

`views/partials/header.pug`：

```ismd
header
  nav
    a(href='/') 首頁
    a(href='/blog') 部落格
```

`views/post.pug`：

```ismd
extends layout.pug

block append head
  script(src='/post.js')

block content
  article
    h1= post.title
    p= post.body
    if post.tags && post.tags.length
      ul
        each tag in post.tags
          li= tag
```

輸出：

```html
<!DOCTYPE html><html><head><title>部落格</title><link rel="stylesheet" href="/site.css"><script src="/post.js"></script></head><body><header><nav><a href="/">首頁</a><a href="/blog">部落格</a></nav></header><main><article><h1>新版 ISMD</h1><p>使用 Rust 重寫的模板引擎。</p><ul><li>rust</li><li>template</li></ul></article></main><footer>版權所有</footer></body></html>
```

## 差異測試參考環境準備

執行 `npm run test:diff`（[tests/differential/runner.mjs](tests/differential/runner.mjs)）進行與原版基準的差異比對時，預設會檢查 `../raw/compiler`（若不存在則退回 `../raw/pug`），並載入參考目錄下的 `node_modules`（包含 `prettier`、`pretty-format` 等相依套件）。若參考目錄尚未安裝相依套件，請先於該目錄執行安裝，或透過環境變數 `ISMD_REFERENCE_ROOT` 指定已安裝 `node_modules` 的參考樹路徑。

## 安全性與輸入邊界說明

- **可信輸入前提**：ISMD 模板可嵌入任意 JavaScript 運算式與 `-` 程式碼，`locals` 的求值與生成的 JS 函式會在宿主 Node／瀏覽器環境執行。`plugins`（原生外掛與 JS 掛鉤），以及會影響程式碼生成的選項（如 `globals`），同樣視為可信輸入。
- **不提供 JS sandbox**：ISMD 核心不提供 JavaScript sandbox。請勿在未經隔離或審查的情況下，直接編譯或渲染來自不受信任來源的模板。
- **屬性跳脫**：一般屬性 `name=value` 會跳脫；`name!=value` 與 `&attributes(...)` 的值不會跳脫。請勿把未經處理的使用者輸入傳入這兩種寫法。

## 已核准差異

- Node.js 16+／22（V8 9.3+）下，讀取 `null`／`undefined` 屬性的 `TypeError` 訊息格式記錄於 [compat/expected-differences.json](compat/expected-differences.json)（`NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY`）。

## raw/pug 原有功能移除清單

ISMD 架構專注於高效能伺服端渲染（SSR）與建置期（Build-time）編譯，並將過濾器與平台相關相依模組解耦。相較於原版 `raw/pug`，以下功能與 API 已在 ISMD 核心中正式移除：

### 1. 客戶端瀏覽器編譯函式（Client Compilation APIs）
- **移除項目**：
  - `ismd.compileClient(str, options)`
  - `ismd.compileClientWithDependenciesTracked(str, options)`
  - `ismd.compileFileClient(path, options)`
- **說明與替代方式**：
  現代前端開發多透過建置工具（如 Vite、Webpack）在打包階段完成模板編譯，或直接於伺服端 SSR 渲染輸出 HTML。在瀏覽器端運行編譯器的需求極低，且會增加 runtime 體積負擔。ISMD 全面專注於 `compile` / `compileFile`（回傳渲染函式）與 `render` / `renderFile`（回傳 HTML）。若需要在瀏覽器端渲染，建議在建置期先編譯為 JavaScript 模組。

### 2. CLI 客戶端專用選項
- **移除項目**：
  - `-c, --client`：產生供客戶端瀏覽器執行的 JavaScript 函式代碼。
  - `-n, --name`：指定客戶端函式全域變數名稱。
  - `-D, --no-debug`：由選項 `compileDebug: false` 統一控制。
  - `--name-after-file`：以檔案檔名命名客戶端函式。
- **說明**：`ismd-cli` 專注於將 `.pug` 模板直接編譯渲染為 `.html` 檔案或標準輸出，不再提供客戶端 JS 代碼生成流程。

### 3. 編譯選項中的客戶端專用選項
- **移除項目**：
  - `options.name`：原用以指定 client function 函式名稱。
  - `options.module`：原用以控制 client function 包裝模式。
- **說明**：ISMD 的編譯函式 `compile` 與 `render` 不再需要亦不再支援此類選項。

### 4. 內建 JavaScript 過濾器與 filters 物件
- **移除項目**：
  - `ismd.filters` 物件已移除（為 `undefined`）。
  - 核心不再內建任何過濾器，亦不再依賴 `jstransformer`。
- **說明與替代方式**：
  避免核心綁定肥大的 JavaScript transformer 相依套件，解耦過濾器執行層。過濾器一律透過**原生外掛（Native Dynamic Plugins，C ABI）**或外掛掛鉤（`plugins` 選項）提供。在未提供外掛的情況下，模板中使用 `:filter` 語法會回報 `ISMD:UNEXPECTED_TEXT`，`include:filter` 語法會回報 `ISMD:MALFORMED_INCLUDE`。

### 5. `register.mjs` 中的客戶端模式相依
- **變更項目**：
  - 原版 `pug/register` 會透過 client 模式將模板編譯為程式碼字串，呼叫 Node 內部的 `module._compile` 並強制依賴 `pug-runtime`。
  - ISMD 的 `register.mjs` 改為直接透過 `module.exports = ismd.compileFile(filename)` 匯出預先編譯好的模板函式，完全去除字串 eval 與客戶端 runtime 依賴。

## 新版專屬功能清單（舊版 Pug 2.x 所沒有的功能與使用方式）

ISMD 以高效能 Rust 核心重構，除了相容 Pug 縮排模板語法外，更針對現代現代化前端工程（Vite 8、Webpack、大型多頁應用 MPA、持續性開發伺服器 HMR）引入了原版 `raw/pug` 所沒有的多項全新架構與 API：

---

### 1. 常駐型增量編譯器（CompilerSession API）
- **功能說明**：
  - **舊版 Pug 限制**：舊版 Pug 每次呼叫 `compile()` / `compileFile()` 都是單次冷啟動編譯，編譯器在執行完後即丟棄內部所有 AST 與相依狀態。當專案有數百個頁面、且多個頁面共用版型（`layout.pug`）或頁首（`header.pug`）時，若某個被引入的組件修改，開發伺服器無法知道哪些頁面受影響，往往只能全站全量重編，速度緩慢。
  - **新版功能**：`createCompiler(defaults?)` 建立常駐記憶體的編譯 Session，內部建構並維護模板間的 **Dependency DAG（有向無環圖）**。當檔案變動時，能以微秒級速度逆向反查受波及的 Entry 頁面，並透過 `compileAffected()` 僅對受影響頁面做增量重新編譯（通常耗時僅 1~5ms）。
- **使用方式**：
  ```js
  import { createCompiler } from 'ismd';

  // 1. 建立有狀態的編譯器 Session
  const compiler = createCompiler({
    basedir: './views',
    compileDebug: false,
    pretty: true
  });

  // 2. 初始編譯多個入口頁面
  const initial = compiler.compileEntries(['pages/home.pug', 'pages/about.pug']);
  console.log('Home HTML:', initial[0].fn({ title: '首頁' }));

  // 3. 當共用組件（如 partials/nav.pug）在編輯器被修改時通知編譯器
  compiler.updateFiles({
    'partials/nav.pug': 'nav\n  a(href="/") Home\n  a(href="/contact") Contact'
  });

  // 4. 精確查詢受波及的 Entry 清單（舊版無法做到）
  const affected = compiler.getAffectedEntries();
  console.log('受影響頁面:', affected); // => ['pages/home.pug', 'pages/about.pug']

  // 5. 僅重新編譯受波及的頁面（極速增量重編）
  const updated = compiler.compileAffected();
  for (const item of updated) {
    console.log(`頁面 ${item.id} 已更新渲染`);
  }

  // 6. 不再使用時釋放底層原生資源
  compiler.dispose();
  ```

---

### 2. 跨 Session 共享快取容器（TemplateStore）
- **功能說明**：
  - **舊版 Pug 限制**：舊版僅有簡易的 `pug.cache = {}`，僅能以檔名快取 JS 函式，無法跨不同編譯流程或 Session 共享已解析的 AST 結構，且缺乏快取容量上限管理機制。
  - **新版功能**：`createTemplateStore()` 提供獨立於 Session 外的模板儲存與快取容器。底層在 Rust 端使用執行緒安全的 `Arc` 共享解析後的 AST 與相依邊，可傳入多個 `createCompiler` 或批次任務中共同使用，顯著減少多 Worker 或多次建置時重複讀取與解析磁碟檔案的 CPU / 記憶體負擔。
- **使用方式**：
  ```js
  import { createTemplateStore, createCompiler } from 'ismd';

  // 建立共用 TemplateStore
  const sharedStore = createTemplateStore();

  // 多個編譯 Session 共享同一份解析快取
  const devServerCompiler = createCompiler({ templateStore: sharedStore });
  const ssgBuildCompiler = createCompiler({ templateStore: sharedStore });
  ```

---

### 3. 多檔案平行批次編譯（`compileBatch`）
- **功能說明**：
  - **舊版 Pug 限制**：舊版無原生批次編譯 API，使用者需在 Node.js 中以迴圈或 `Promise.all` 逐一呼叫 `compileFile`，受限於 JavaScript 單執行緒，在大規模站點建置時無法利用多核心 CPU 算力。
  - **新版功能**：`compileBatch(entries, defaults?, compileOpts?)` 直接在 Rust 核心透過多執行緒並行平行編譯（可藉由 `parallel: true` 或 `parallelThreshold: 10` 指定平行化門檻）。同時支援 `throwOnError: false`，即使個別模板存在語法錯誤也不會中斷整個批次，會於結果陣列中個別標明 `ok: false` 與具體錯誤。
- **使用方式**：
  ```js
  import { compileBatch } from 'ismd';

  const entries = [
    'src/pages/index.pug',
    'src/pages/about.pug',
    'src/pages/blog.pug',
    { id: 'virtual-contact', source: 'h1 聯絡我們\np 請填寫表單' }
  ];

  const results = compileBatch(
    entries,
    { doctype: 'html' },
    {
      parallel: true,           // 啟用 Rust 端多核心平行運算
      parallelThreshold: 2,     // 超過 2 筆即啟動平行排程
      throwOnError: false       // 不因單一頁面錯誤而中斷整個流程
    }
  );

  results.forEach(res => {
    if (res.ok) {
      console.log(`[成功] ${res.id}`);
    } else {
      console.error(`[失敗] ${res.id}: ${res.error.message}`);
    }
  });
  ```

---

### 4. 原生動態外掛架構（Native Dynamic Plugins，C ABI）
- **功能說明**：
  - **舊版 Pug 限制**：舊版外掛完全使用 JavaScript 撰寫，在 AST 階段走訪大型樹狀物件時會產生大量臨時物件，對 V8 垃圾回收（GC）造成顯著負擔，且無法整合高效能系統語言函式庫。
  - **新版功能**：新版提供 `ismd_plugin_abi` 標準 C ABI 介面，支援直接載入以 Rust 或 C/C++ 編譯的動態函式庫（`.dll`、`.so`、`.dylib`）。原生外掛在 Rust 編譯管線內部直接執行過濾與轉換，無需透過 N-API 頻繁跨邊界序列化 AST，執行速度極快。
- **使用方式**：
  ```js
  import { render, resolveNativePluginPath } from 'ismd';

  // 1. 指定原生外掛的動態庫路徑（支援 .dll / .so）
  const pluginPath = resolveNativePluginPath('./plugins/native_uppercase.dll');

  // 2. 傳入 plugins 選項
  const html = render('div\n  :uppercase\n    hello world', {
    plugins: [pluginPath]
  });

  console.log(html); // => '<div>HELLO WORLD</div>'
  ```

---

### 5. 現代前端打包工具深度適配器（Vite 8 & Webpack 5+）
- **功能說明**：
  - **舊版 Pug 限制**：Pug 官方未提供現代 Bundler 外掛。社群開發的插件多屬於單檔編譯器，不具備組件相依性感知的 HMR（熱模組替換），修改 `include` 或 `layout` 往往引發全頁刷新（Full Reload）。
  - **新版功能**：
    - **Vite 外掛（`vite-plugin-ismd`）**：支援 Vite 8（Rolldown 引擎，peer 版本 `^8.3.0`）。開發伺服器啟動時綁定持續性 `CompilerSession`，具備細緻的熱更新判定（修改頁面 entry、修改 include 局部、修改 layout 均可個別針對受波及模組推播更新；修改與 entry 無關的檔案則 0ms 空轉），支援 `?raw` 與 `?url` 匯入查詢，以及 Windows 系統快速重命名（Atomic Save）重試防護。
    - **Webpack 外掛（`ismd-webpack-plugin`）**：提供 `IsmdWebpackPlugin` 與 `IsmdWebpackPlugin.loader`，使多個編譯任務能共享同一個 `CompilerSession`，並自動向 Webpack 監看管線註冊所有深層巢狀相依檔案。
- **使用方式**：
  - **Vite 設定（`vite.config.mjs`）**：
    ```js
    import { defineConfig } from 'vite';
    import ismd from 'vite-plugin-ismd';

    export default defineConfig({
      plugins: [
        ismd({
          doctype: 'html',
          pretty: true
        })
      ]
    });
    ```
  - **Webpack 設定（`webpack.config.mjs`）**：
    ```js
    import IsmdWebpackPlugin from 'ismd-webpack-plugin';

    export default {
      module: {
        rules: [
          {
            test: /\.pug$/,
            use: [IsmdWebpackPlugin.loader]
          }
        ]
      },
      plugins: [
        new IsmdWebpackPlugin({ doctype: 'html' })
      ]
    };
    ```

---

### 6. 高效能 MPA 監看命令列介面（`ismd-cli`）
- **功能說明**：
  - **舊版 CLI 限制**：舊版 `pug-cli` 基於 `fs.watchFile` 輪詢，監控效率隨檔案數量增加顯著下降；且目錄遍歷時若沒有手動加上 `_` 前綴，會將 `includes`、`layouts` 等非獨立頁面片段全部編譯成多餘的 HTML。
  - **新版功能**：`ismd-cli` 直接整合常駐型 `CompilerSession`。在 `-w, --watch` 模式下進行即時增量重繪；目錄掃描自動識別並忽略標準片段目錄（`layouts/`、`includes/`、`partials/`、`components/`、`mixins/` 與 `_` 開頭檔案）；此外，更支援**非 `.pug` 相依檔追蹤**（例如 raw include `.css`、`.html` 時，修改該 CSS/HTML 亦會精確觸發宿主 Pug 重繪）。
- **使用方式**：
  ```bash
  # 批次編譯目錄（自動略過 layouts、partials 等輔助資料夾），輸出至 dist/
  ismd src/pages -o dist

  # 持續監看模式（增量微秒級自動重繪）
  ismd src/pages -o dist -w

  # 注入 locals 參數（支援 .json、.js、.mjs 與 JavaScript 運算式）
  ismd src/pages -o dist -O siteConfig.json

  # 指定輸出附檔名
  ismd src/pages -o dist -E php
  ```

