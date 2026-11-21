# ismd-webpack-plugin

Webpack 5 的 `ismd` 整合層，包含一個 Plugin 與一個 Loader。Plugin 在整個 Webpack 編譯期間持有一個持續性的 `CompilerSession`，Loader 與 Plugin 共用同一個 session，因此增量編譯與相依追蹤可以跨 `watch` 週期保留。

## 需求

- Node.js `>=20.0.0`
- Peer dependencies：`ismd`（`^0.1.0`）、`webpack`（`^5.0.0`）

## 安裝

可直接透過 GitHub 安裝：

```bash
npm install --save-dev github:Hao-CMIND/ismd#pkg-ismd github:Hao-CMIND/ismd#pkg-webpack webpack@^5
```

## 使用方式

在 `webpack.config.mjs` 中同時加入 Plugin 與 Loader：

```javascript
import IsmdWebpackPlugin from 'ismd-webpack-plugin';

export default {
  module: {
    rules: [
      {
        test: /\.pug$/,
        use: [IsmdWebpackPlugin.loader],
      },
    ],
  },
  plugins: [
    new IsmdWebpackPlugin({
      basedir: 'src',
      pretty: false,
    }),
  ],
};
```

`index.mjs` 另匯出的具名項目：

| 匯出 | 說明 |
| --- | --- |
| `IsmdWebpackPlugin`（預設匯出） | Plugin 類別 |
| `IsmdRustPlugin` | `IsmdWebpackPlugin` 的別名 |
| `loaderPath` | Loader 檔案的絕對路徑 |

子路徑匯出：`ismd-webpack-plugin/plugin`、`ismd-webpack-plugin/loader`。

## 選項

Plugin 的建構選項會傳入編譯流程，常用的鍵包括：

| 選項 | 說明 |
| --- | --- |
| `basedir` | 解析以 `/` 開頭之 `include` / `extends` 的根目錄 |
| `pretty` | 輸出縮排格式的 HTML |
| `compileDebug` | 是否保留錯誤時的原始碼片段與行號 |
| `doctype` | 強制輸出的 doctype |
| `globals` | 允許模板直接存取的全域名稱 |
| `plugins` | 原生外掛清單 |

完整說明請見 [ismd/README.md](../ismd/README.md) 的「編譯選項」。

以下舊版過濾器相關選項已移除，傳入會直接拋出錯誤：`filters`、`filterExecutor`、`filterOptions`、`filterAliases`。過濾器請改用原生 Rust 外掛（`plugins`）。

## 運作方式

- Loader 由 `rules` 決定處理哪些檔案，範例中的 `test: /\.pug$/` 即只處理 `.pug` 模板。
- Loader 優先使用 Plugin 登記的 session；若 Loader 脫離 Plugin 單獨使用，則退回單次 `compile()`，但失去增量編譯。
- Loader 會把編譯結果回報的相依檔加入 Webpack 的 `addDependency`，使被 `include` / `extends` 的檔案變更時觸發重編。
- Plugin 會記錄相依檔；非 `watch` 模式在 `done` 後釋放 session，`watch` 模式則在 `watchClose` 或 `shutdown` 時釋放。

## 測試

```bash
npm test
```

測試檔為 `tests/webpack-adapter.test.mjs`，使用假的 Webpack compiler 物件驗證 Plugin 與 Loader 的生命週期，並不會啟動真實的 Webpack 建置。
