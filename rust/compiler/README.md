# pug-rust-compiler

以 Rust、Oxc 與 NAPI-RS 實作的 Pug 模板編譯器，設計目標為與固定基準 `pug@2.0.4`（[compat/baseline.json](compat/baseline.json)）維持語意、錯誤與 JS 產物相容。

## 支援環境

- **Node.js**：`>= 20.0.0`（於 `v22.23.3` 完成驗證，支援主執行緒與 `worker_threads` 並行隔離）
- **平台與架構**：Windows `x64`（`win32-x64-msvc` 預建置原生模組 `pug-napi.win32-x64-msvc.node`）
- **Rust 工具鏈**（本地從原始碼重建時）：依 `rust-toolchain.toml` 與 `Cargo.lock` 鎖定版本執行 `cargo build -p pug_napi --locked`

> 其他作業系統或 CPU 架構未在本輪實測驗證，不列入已驗證支援範圍。

## 安裝與本地建置

### 從封裝壓縮包安裝

```bash
npm pack
npm install ./pug-rust-compiler-2.0.4-rust.1.tgz
```

### 本地開發建置原生模組

```bash
npm run build
```

執行時 `index.js` 會依序嘗試載入 `pug-napi.win32-x64-msvc.node`、`target/release/pug_napi.dll` 或 `target/debug/pug_napi.dll`（若以 `.dll` 載入並會自動同步複製至 `.node`）。

## 公開入口與基本範例

套件採 ESM（`"type": "module"`），並透過 `exports` 匯出主入口與兩個子入口：

- 主入口 `.`（`./index.js`）：`compile`、`compileFile`、`compileClient`、`compileClientWithDependenciesTracked`、`compileFileClient`、`render`、`renderFile`、`__express`、`cache`、`filters`、`runtime`、`name`
- `./register`（`./register.js`）：掛載 `require.extensions['.pug']` 供 CommonJS `require('./view.pug')` 使用
- `./runtime`（`./runtime/index.js`）：`merge`、`classes`、`style`、`attr`、`attrs`、`escape`、`rethrow`

### ESM 使用範例

```js
import pug from 'pug-rust-compiler';

const html = pug.render('p= msg', { msg: 'Hello Pug Rust' });

const fn = pug.compile('ul\n  each item in items\n    li= item', {
  compileDebug: true,
});
console.log(fn({ items: ['a', 'b'] }));
```

### Client 端編譯與外部 Runtime

```js
import { compileClient } from 'pug-rust-compiler';
import runtime from 'pug-rust-compiler/runtime';

const jsSource = compileClient('.badge= name', {
  name: 'renderBadge',
  inlineRuntimeFunctions: false,
});
```

### Express 整合與 `register`

```js
import pug from 'pug-rust-compiler';
app.engine('pug', pug.__express);
```

在 CommonJS 使用者程式中亦可直接載入 `./register`（或透過 `createRequire` 匯入 `pug-rust-compiler/register`）來直接 `require('./template.pug')`。

## 主要選項

- `filename` / `basedir`：用於 `include` / `extends` 解析、`cache` key 與錯誤來源定位
- `doctype` / `pretty`：輸出文件宣告、`void-elements` 與縮排控制（`boolean | string`）
- `compileDebug` / `includeSources` / `debug`：除錯上下文內嵌與錯誤重拋包裝（`compile` 預設 `compileDebug !== false`；`compileClient` 預設未開啟；`__express` 於 `NODE_ENV === 'production'` 且未指定時預設 `false`）
- `inlineRuntimeFunctions` / `name` / `module`：控制 Runtime helper 展開與 client 函式匯出格式
- `self` / `globals`：調整 `with (locals)` 作用域邊界與全域識別字白名單
- `cache`：啟用或略過 `pug.cache`（`compileFile` / `renderFile` 使用 `filename`；`compileFileClient` 使用 `filename + ':client'`）
- `filters` / `filterOptions` / `filterAliases`：自訂過濾器函式、`renderBuffer` 支援與 JSTransformer 橋接

## Plugins 介面與相容邊界

- **階段 Hooks**：`preLex`、`postLex`、`preParse`、`postParse`、`preLoad`、`postLoad`、`preFilters`、`postFilters`、`preLink`、`postLink`、`preCodeGen`、`postCodeGen`（均於呼叫端所在 JS 執行緒同步執行）。
- **Replacement Hooks**：`resolve`、`read`、`generateCode`（同一呼叫中不得由多個 plugin 同時實作同一個 replacement 方法）。
- **Lexer 擴充**：支援 `plugin.lex` 各方法（含 `#3295` 巢狀 `#[...]` 插值中的 `lex.advance` 等橋接）；原版未覆蓋的 `pug-parser` 內部 context hooks 未列入本套件實作範圍。

完整測試覆蓋率與狀態統計請見 [compat/matrix.md](compat/matrix.md)。

## 已知核准差異

- 本機 Node.js 16+ / 22 (V8 9.3+) 下讀取 `null` / `undefined` 屬性之 `TypeError` 訊息格式記錄於 [compat/expected-differences.json](compat/expected-differences.json)（`NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY`），在相同 Node 版本下 `rust/compiler` 與 `raw/compiler` 行為完全一致。

## 安全性與輸入邊界說明

- **可信輸入前提**：Pug 模板語法本身可嵌入任意 JavaScript 表達式與 unbuffered code（`locals` 求值與生成的 JS 函式會在宿主 Node / 瀏覽器環境執行），且 `filters`、`plugins` 及影響 Codegen 的選項（如 `globals`、`pretty`、`name` 等）均可直接執行或參與程式碼生成。
- **不提供 JS Sandbox**：Rust 核心與 `pug-rust-compiler` **不提供 JavaScript sandbox**；所有模板來源、`filters`、`plugins` 與編譯選項皆視為**可信輸入**，請勿在未經隔離或審查的情況下直接編譯或渲染來自未受信任第三方的任意模板。
