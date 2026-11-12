# @pug-rust/vite

> Vite 8.3+ Plugin Adapter for `pug-rust-compiler` using persistent `CompilerSession` & Rolldown transform.

本套件為 `pug-rust-compiler` 的官方 Vite 插件適配層，支援 Vite 8.3（Rolldown 引擎架構）與 Hook Filter API，透過持久化 `CompilerSession` 提供增量編譯與極速 HMR。

---

## 特性與架構

1. **Vite 8.3 & Rolldown 相容**：
   - 採用 Vite 8.3 transform hook filter（`id: /\.pug(?:\?|$)/i`），大幅減少非 Pug 檔案的 hook 調度負擔。
   - 回傳 `moduleType: 'js'`，完整適配 Rolldown 對模組類型之型態約定。
2. **持續性 CompilerSession 整合**：
   - Dev Server 生命週期全程共用單一 `CompilerSession` 實例，依賴 DAG 與快取命中成本降至微秒級。
   - `buildStart` 僅進行批次預熱（prewarm），不預先覆寫產物。
3. **精準 HMR 傳播**：
   - Page 異動：局部模組重載。
   - Include / Layout 異動：透過 Dependency DAG 找出所有受影響的 Entry 自動觸發熱更新。
   - Atomic Save / File Add / Unlink / Rename：平滑處理暫存檔與改名序列。
4. **生命週期資源釋放**：
   - `closeBundle` 與 Dev Server `close` 時自動調用 `session.dispose()` 釋放 Rust 核心記憶體。

---

## 安裝與相依需求

- **Node.js**: `^20.19.0 || >=22.12.0`
- **Vite**: `^8.3.0`
- **pug-rust-compiler**: `^2.0.4-rust.1`（本機 `../compiler`）

```bash
npm install --save-dev @pug-rust/vite
```

---

## 設定與使用方法

在專案根目錄的 `vite.config.js` 中引入並配置插件：

```javascript
import { defineConfig } from 'vite';
import { pugRustPlugin } from '@pug-rust/vite';

export default defineConfig({
  plugins: [
    pugRustPlugin({
      // 常用選項：
      // basedir: 模板解析之根目錄（預設為 Vite root）
      // pretty: 是否輸出縮排 HTML（預設 false）
      // compileDebug: 是否包含偵錯資訊（開發模式預設 true，生產模式 false）
      // locals: 傳入模板之全域變數
    }),
  ],
});
```

### 在前端腳本中載入 Pug 模板

```javascript
import template from './pages/index.pug';

// template 為編譯後的客戶端渲染函式
const html = template({ name: 'World' });
document.getElementById('app').innerHTML = html;
```

---

## 本機測試與 Fixtures 環境設定

依專案規範，`rust/vite/tests/` 目錄下的測試 Fixtures 屬於本機驗證環境，**不納入 Git 版本控管**。若需在本機執行完整 Vite 8.3 整合測試，請依照下列步驟設定：

### 1. 安裝測試相依套件

在 `rust/vite/` 目錄下安裝開發依賴（包含相容之 Vite 8.3+）：

```bash
cd rust/vite
npm install
```

### 2. 建立測試 Fixture 目錄結構

測試需要 `rust/vite/tests/fixtures/vite8/` 目錄結構如下：

```text
rust/vite/tests/fixtures/vite8/
├── index.html
├── vite.config.js
└── src/
    ├── main.js
    ├── includes/
    │   └── header.pug
    ├── layouts/
    │   └── default.pug
    └── pages/
        ├── index.pug
        ├── about.pug
        └── query.pug
```

#### 各檔案內容範例：

* **`vite.config.js`**：
  ```javascript
  import { defineConfig } from 'vite';
  import { pugRustPlugin } from '../../../../vite/index.js';

  export default defineConfig({
    plugins: [pugRustPlugin()],
  });
  ```

* **`index.html`**：
  ```html
  <!DOCTYPE html>
  <html>
    <head><meta charset="utf-8" /></head>
    <body>
      <div id="app"></div>
      <script type="module" src="/src/main.js"></script>
    </body>
  </html>
  ```

* **`src/main.js`**：
  ```javascript
  import indexTpl from './pages/index.pug';
  document.getElementById('app').innerHTML = indexTpl();
  ```

* **`src/includes/header.pug`**：
  ```pug
  header.site-header Site Header
  ```

* **`src/layouts/default.pug`**：
  ```pug
  doctype html
  html
    body
      include ../includes/header.pug
      block content
  ```

* **`src/pages/index.pug`**：
  ```pug
  extends ../layouts/default.pug
  block content
    h1 Home Page
  ```

* **`src/pages/about.pug`**：
  ```pug
  extends ../layouts/default.pug
  block content
    h1 About Page
  ```

* **`src/pages/query.pug`**：
  ```pug
  p Query Template
  ```

### 3. 執行整合測試

環境配置完成後，可執行以下測試：

```bash
# 測試 1：Pug Vite 插件生命週期與持續性 CompilerSession（無須安裝外部 Vite）
node rust/compiler/tests/integration/step11-vite-plugin.test.js

# 測試 2：真實 Vite 8.3 生產建置與 Dev Server HMR（需完成上述 fixture 與 npm install）
node rust/compiler/tests/integration/step14-vite8-real.test.js
```
