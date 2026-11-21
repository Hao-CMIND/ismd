# ISMD: High-Performance Pug Template Engine in Rust

以 Rust 與 Oxc 為核心重構的高效能 Pug 縮排式 HTML 模板編譯系統，透過 NAPI-RS 提供原生 Node.js 模組，並深度整合 Vite 8、Webpack 5 與 MPA 增量開發工具鏈。

---

## 專案工作區（Workspaces）

本專案採 npm / pnpm Monorepo 結構管理，包含以下核心套件：

| 套件 | 目錄 | 說明 |
|---|---|---|
| **`ismd`** | [`ismd/`](ismd/README.md) | 核心模板編譯器，提供 Rust + N-API 原生繫結與 `compile` / `render` / `createCompiler` API。 |
| **`ismd-cli`** | [`ismd-cli/`](ismd-cli/) | 現代命令列工具，支援目錄批次編譯、標準片段資料夾過濾與高效增量監看（`-w`）。 |
| **`vite-plugin-ismd`** | [`vite-plugin-ismd/`](vite-plugin-ismd/README.md) | Vite 外掛，完整支援 Vite 8（Rolldown）與 Vite 5/6/7，具備精確熱模組替換（HMR）。 |
| **`ismd-webpack-plugin`** | [`ismd-webpack-plugin/`](ismd-webpack-plugin/) | Webpack 5 外掛與 Loader，支援共享 CompilerSession 與多層相依監看。 |
| **`ismd-filters`** | [`ismd-filters/`](ismd-filters/) | 原生動態外掛與過濾器相容擴充層。 |

---

## 新版專屬功能清單（舊版 Pug 2.x 所沒有的功能與使用方式）

相較於舊版純 JavaScript 實作的 Pug（`raw/pug` 2.x），新版針對現代工程化與大型建置場景，提供了以下全新功能與架構突破：

### 1. 常駐型增量編譯器（`createCompiler` / CompilerSession API）
- **舊版限制**：Pug 每次編譯都是單次冷啟動編譯，編譯後即拋棄所有內部狀態；修改一個共用組件無法知道哪些頁面受影響，往往只能全量重編。
- **新版功能**：建立常駐記憶體的編譯 Session，維護即時 Dependency DAG（有向無環圖）。檔案變動時可精準查詢受影響的 Entry 頁面，並透過 `compileAffected()` 進行微秒／毫秒級增量重編。
- **使用方式**：
  ```js
  import { createCompiler } from 'ismd';

  const compiler = createCompiler({ basedir: './views', pretty: true });

  // 1. 編譯多個入口
  compiler.compileEntries(['pages/index.pug', 'pages/about.pug']);

  // 2. 當局部檔案變動時更新記憶體/磁碟快取
  compiler.updateFiles({
    'partials/header.pug': 'header\n  h1 My Site'
  });

  // 3. 自動依 DAG 反查受影響頁面並僅重新編譯受波及者（通常僅 1~5ms）
  const affected = compiler.getAffectedEntries();
  const results = compiler.compileAffected();

  // 4. 釋放資源
  compiler.dispose();
  ```

---

### 2. 跨 Session 共享快取容器（`createTemplateStore`）
- **舊版限制**：舊版僅有簡易全域物件快取，無 AST 快取，無法跨 Worker 或多次建置流程共享已解析的 AST。
- **新版功能**：提供獨立的 TemplateStore，底層以執行緒安全 `Arc` 共享解析後的 AST 與相依視圖，支援容量上限與 LRU 淘汰機制，有效避免記憶體膨脹。
- **使用方式**：
  ```js
  import { createTemplateStore, createCompiler } from 'ismd';

  const sharedStore = createTemplateStore();
  const session1 = createCompiler({ templateStore: sharedStore });
  const session2 = createCompiler({ templateStore: sharedStore });
  ```

---

### 3. 多檔案平行批次編譯（`compileBatch`）
- **舊版限制**：無批次 API，多檔案時必須在 JavaScript 單執行緒內以迴圈逐一編譯，無法發揮多核心效能。
- **新版功能**：提供批次編譯 API，直接在 Rust 核心以多執行緒平行調度（`parallel: true`），並支援 `throwOnError: false`（容許個別檔案錯誤而不中斷批次流程）。
- **使用方式**：
  ```js
  import { compileBatch } from 'ismd';

  const results = compileBatch(
    ['page1.pug', 'page2.pug', 'page3.pug'],
    { doctype: 'html' },
    { parallel: true, parallelThreshold: 2, throwOnError: false }
  );
  ```

---

### 4. 原生動態外掛系統（Native Dynamic Plugins，C ABI）
- **舊版限制**：僅支援純 JavaScript 編寫的外掛，大型 AST 走訪會產生大量垃圾回收（GC）開銷。
- **新版功能**：制定 `ismd_plugin_abi` 標準 C ABI，支援直接載入以 Rust 或 C/C++ 編譯的動態庫（`.dll`、`.so`、`.dylib`），在原生層直接執行過濾與轉換。
- **使用方式**：
  ```js
  import { render, resolveNativePluginPath } from 'ismd';

  const pluginPath = resolveNativePluginPath('./native_uppercase.dll');
  const html = render('div\n  :uppercase\n    hello', {
    plugins: [pluginPath]
  });
  ```

---

### 5. 現代構建工具深度適配器（Vite 8 Rolldown 與 Webpack 5+）
- **舊版限制**：Pug 官方未提供現代 Bundler 外掛；社群插件缺乏組件相依性感知的 HMR，修改 include 常導致全頁刷新。
- **新版功能**：
  - **`vite-plugin-ismd`**：支援最新 Vite 8（Rolldown 引擎）與 Vite 5/6/7。與 CompilerSession 深度整合，修改 page、include、layout 均具備精確熱替換，未受影響時 0ms 空轉；支援 Windows Atomic Save 與 `?raw` / `?url` 略過。
  - **`ismd-webpack-plugin`**：提供外掛與 Loader，可在 Webpack 建置管線中共享同一個常駐 Session，自動遞迴註冊所有深層檔案相依。

---

### 6. 高效能 MPA 監看命令列介面（`ismd-cli`）
- **舊版限制**：舊版 `pug-cli` 依賴 Node 檔案輪詢，且目錄遍歷會把所有 partials/layouts 誤編譯為獨立頁面。
- **新版功能**：內建常駐 Session；自動過濾 `includes/`、`layouts/`、`partials/`、`components/`、`mixins/` 與 `_` 開頭片段檔案；支援 non-pug 相依檔（如 raw include `.css`、`.html`）更新時精準觸發宿主重繪。
- **使用方式**：
  ```bash
  # 批次編譯目錄（自動忽略版型與片段資料夾）
  ismd src/pages -o dist

  # 持續監看與增量微秒重繪
  ismd src/pages -o dist -w

  # 注入 locals 參數（支援 .json、.js、.mjs 與 JS 運算式）
  ismd src/pages -o dist -O siteConfig.json
  ```

---

## 快速開始

### 安裝方式

可直接透過 GitHub 分支安裝各套件：

```bash
# 安裝核心編譯器
npm install github:Hao-CMIND/ismd#pkg-ismd

# 全域安裝 CLI 命令列工具
npm install -g github:Hao-CMIND/ismd#pkg-cli

# 安裝 Vite 外掛（搭配 ismd 核心）
npm install -D github:Hao-CMIND/ismd#pkg-vite github:Hao-CMIND/ismd#pkg-ismd vite@^8.3.0

# 安裝 Webpack 外掛（搭配 ismd 核心）
npm install -D github:Hao-CMIND/ismd#pkg-webpack github:Hao-CMIND/ismd#pkg-ismd webpack@^5
```

> 註：正式發布至 npm registry 後，亦可直接使用 `npm install ismd` 或 `npm install -g ismd-cli`。

### 基本使用範例

```js
import ismd from 'ismd';

// 渲染模板字串
const html = ismd.render('h1= title', { title: 'Hello ISMD' });
console.log(html); // => '<h1>Hello ISMD</h1>'

// 編譯模板檔案
const templateFn = ismd.compileFile('views/index.pug');
console.log(templateFn({ user: 'Alice' }));
```

更多 API 細節與進階用法，請參閱 [`ismd/README.md`](ismd/README.md)。

---

## 分支管理與推送指南（Push Guide）

本專案採 Monorepo（`dev`）與獨立套件發布分支（`pkg-*`）並行架構。根目錄 `package.json` 已配置便捷腳本，可直接使用 npm 或 Git 原生指令推送：

### 1. 透過 npm 快速指令推送

```bash
# 僅推送主開發分支
npm run push:dev

# 一次性推送所有套件獨立發布分支（pkg-cli, pkg-ismd, pkg-vite, pkg-webpack）
npm run push:pkgs

# 同時推送 dev 與所有獨立發布分支
npm run push:all
```

### 2. 透過原生 Git 指令推送

```bash
# 推送主開發分支
git push origin dev

# 推送所有獨立套件分支並綁定遠端追蹤
git push -u origin pkg-cli pkg-ismd pkg-vite pkg-webpack
```
