# vite-plugin-ismd

`ismd` 的 Vite 外掛。在 Vite 開發伺服器與建置期間，為 `.pug` 模板提供由持續性 `CompilerSession` 驅動的編譯、增量重編與 HMR。

## 需求

- Node.js `^20.19.0 || >=22.12.0`
- Peer dependencies：`vite`（`^8.3.0`）、`ismd`（`^0.1.0`）

## 安裝

可直接透過 GitHub 安裝：

```bash
npm install --save-dev github:Hao-CMIND/ismd#pkg-ismd github:Hao-CMIND/ismd#pkg-vite vite@^8.3.0
```

## 使用方式

在 `vite.config.mjs` 中引入並加入插件：

```javascript
import { defineConfig } from 'vite';
import ismdPlugin from 'vite-plugin-ismd';

export default defineConfig({
  plugins: [
    ismdPlugin({
      // basedir: 解析以 "/" 開頭之 include / extends 的根目錄（預設為 process.cwd()）
      // pretty: 輸出縮排格式的 HTML（預設 false）
      // compileDebug: 是否保留錯誤時的原始碼片段（預設 true）
      // locals: 傳入模板的變數
    }),
  ],
});
```

`index.mjs` 同時匯出 `ismdPlugin`（預設匯出）與 `ismdRustPlugin`（別名），兩者相同。`normalizePath` 也有具名匯出。

在前端程式中匯入模板：

```javascript
import template from './pages/index.pug';

// template 為編譯後的模板函式，傳入 locals 後回傳 HTML 字串
const html = template({ name: 'World' });
document.getElementById('app').innerHTML = html;
```

## 選項

| 選項 | 說明 |
| --- | --- |
| `basedir` | 解析以 `/` 開頭之 `include` / `extends` 的根目錄 |
| `pretty` | 輸出縮排格式的 HTML |
| `compileDebug` | 是否保留錯誤時的原始碼片段與行號 |
| `doctype` | 強制輸出的 doctype |
| `locals` | 傳入模板的變數 |
| `globals` | 允許模板直接存取的全域名稱 |
| `plugins` | 原生外掛清單，見 [ismd/README.md](../ismd/README.md) 的「外掛」 |
| `entries` | 啟動時預先登記並批次編譯的入口檔案 |
| `isEntry` | 判斷檔案是否為入口的函式；預設將 `includes/`、`layouts/`、`partials/`、`components/`、`mixins/` 下的檔案視為非入口 |

以下舊版過濾器相關選項已移除，傳入會直接拋出錯誤：`filters`、`filterExecutor`、`filterOptions`、`filterAliases`。過濾器請改用原生 Rust 外掛（`plugins`）。

## 運作方式

- **持續性 session**：開發伺服器存活期間共用單一 `CompilerSession`，相依關係由 Dependency DAG 追蹤。
- **HMR**：修改入口頁面時只重編該頁；修改 include 或 layout 時，DAG 會找出所有受影響的入口並觸發更新；與入口無關的檔案變更不會觸發重編。
- **檔案事件**：新增、刪除、改名與編輯器的暫存寫入（atomic save）都有對應處理。
- **查詢參數**：`?raw` 與 `?url`、`?worker`、`?inline` 等資源查詢不會被當作模板處理。
- **釋放資源**：`closeBundle` 與開發伺服器關閉時呼叫 `session.dispose()`。

## 測試

在本資料夾執行：

```bash
npm install
npm test
```

`npm test` 會執行三個測試檔：

| 測試檔 | 內容 |
| --- | --- |
| `tests/vite-plugin.test.mjs` | 外掛生命週期與持續性 session，不需要真實 Vite |
| `tests/vite-windows-stability.test.mjs` | Windows 上的檔案事件穩定性 |
| `tests/vite8-real.test.mjs` | 真實 Vite 8 建置與開發伺服器 HMR，使用 `tests/fixtures/vite8/` |

`tests/fixtures/vite8/` 為納入版本控制的測試專案，結構如下：

```text
tests/fixtures/vite8/
├── index.html
├── vite.config.mjs
└── src/
    ├── main.mjs
    ├── includes/header.pug
    ├── layouts/default.pug
    └── pages/
        ├── index.pug
        ├── about.pug
        └── query.pug
```

`npm run test:all` 會執行 `tests/*.test.mjs` 全部測試檔。
