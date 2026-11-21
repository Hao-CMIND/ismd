# ISMD 建置、測試與部署交接

查證日期：2026-11-16。以 `ismd/` 現有 manifests、loader 與測試腳本為準；以下指令是供維護者執行的操作說明，本次文件工作未執行建置、發布或完整測試。

## 1. 交付形式與平台範圍

`ismd` 是 ESM 模板編譯器套件，主入口 `index.mjs` 載入 Rust N-API addon。`package.json` 宣告 `private: true`，沒有 publish/deploy/start script；Rust addon 為 `cdylib`。目前 loader 明列的候選檔只有 Windows `.node` / `.dll`，napi target 只列 `x86_64-pc-windows-msvc`。不能據此宣稱已有 Linux/macOS 預編譯發行物或跨平台安裝流程。依據：[package.json](../../package.json#L1)、[loadNativeAddon](../../index.mjs#L13)、[ismd_napi/Cargo.toml](../../crates/ismd_napi/Cargo.toml#L8)。

本次在 `ismd/` 應用原始碼與專案設定搜尋中未找到 HTTP server 啟動、資料庫連線、Docker/Compose、Kubernetes 或 CI/CD workflow；`__express` 是 view-engine adapter，並不建立 HTTP server。主機配置、域名、port、secret 管理、健康檢查、雲端發布環境與 rollback 機制均沒有可由本範圍原始碼證實的實作。見 [__express](../../index.mjs#L1029)。

## 2. 開發環境

| 項目 | 專案宣告 | 證據 |
|---|---|---|
| Node.js | `>=20.0.0`，ES modules | [ismd/package.json](../../package.json#L5) |
| Rust toolchain | `1.99.1`，minimal profile，包含 rustfmt/clippy | [rust-toolchain.toml](../../rust-toolchain.toml#L1) |
| Rust workspace | edition `2024`，最低 `rust-version = "1.99"` | [Cargo.toml](../../Cargo.toml#L21) |
| Native target | `x86_64-pc-windows-msvc`；建置需可用的此 target 編譯/連結環境 | [rust-toolchain.toml](../../rust-toolchain.toml#L5) |
| Oxc | 固定 `=0.157.0` | [workspace dependencies](../../Cargo.toml#L31) |
| napi / napi-derive / napi-build | 固定 `=3.16.1` / `=3.7.0` / `=2.6.0` | [workspace dependencies](../../Cargo.toml#L32) |
| N-API build 初始化 | `napi_build::setup()` | [build.rs](../../crates/ismd_napi/build.rs#L1) |

根 [package.json](../../../package.json#L7) 將 `ismd`、CLI、Vite、Webpack、filters、lint、benchmarks 列為 npm workspaces。**但根 [package-lock.json](../../package-lock.json#L7) 仍保留 `compiler`、`cli`、`vite` 等舊 workspace 路徑與套件名稱**。因此不能將 `npm ci` 寫成已驗證可重現的安裝步驟；完整 npm dependency 安裝流程需先核對 lockfile 與 manifest。本次只記錄落差，沒有修改 lockfile 或安裝依賴。

**乾淨 checkout 的完成條件尚未滿足。** 下文是工具與依賴備妥後的建置操作；不是從零安裝成功的保證。接手者須先由專案維護者確認與目前 workspace 相符的 lockfile／安裝方式及 reference checkout 版本，再執行完整 Node／differential 驗證。現有資料未指定負責人或核准的替代安裝指令，這裡不以 `npm install` 代替缺少的驗證。

以下是前置環境的只讀檢查，不會安裝工具。範例中的 `D:\pug-rust` 是目前 checkout 位置，請替換成自己的路徑：

```powershell
Set-Location D:\pug-rust\ismd
node --version
npm --version
rustup toolchain list
rustup target list --installed --toolchain 1.99.1
Get-Command cl.exe, link.exe -ErrorAction SilentlyContinue
```

應核對 Node 版本與 `1.99.1` toolchain／MSVC target 是否符合上表。`Get-Command` 只顯示目前 shell 找到的編譯／連結工具，找不到不等於機器完全未安裝；最終仍以 Cargo 建置是否成功確認環境。這些檢查不會修復 lockfile，也不證明 Node dependencies 已安裝。

## 3. 建置與 addon 載入

### 一般開發建置

在專案根目錄執行 PowerShell：

```powershell
Set-Location D:\pug-rust\ismd
cargo build -p ismd_napi
```

此命令等同 `ismd/package.json` 的 `npm run build`，產物通常位於該 workspace 的 `target/debug/ismd_napi.dll`（以未另設 Cargo target directory 為前提）。release 使用 `cargo build --release -p ismd_napi`。依據：[build script](../../package.json#L40)、[loader candidates](../../index.mjs#L31)。

`loadNativeAddon()` 依序檢查：

1. `ismd/ismd-napi.win32-x64-msvc.node`
2. `ismd/target/release/ismd_napi.dll`
3. `ismd/target/debug/ismd_napi.dll`

遇到 DLL 時會嘗試複製至套件根的 `.node` 再 require；一般路徑未比對 `.node` 與 DLL 的 mtime，且複製失敗被 catch。**既有 `.node` 優先，因此只執行 cargo build 可能仍載入舊 addon。** 見 [loadNativeAddon](../../index.mjs#L31)。

若維護者要驗證剛建好的 debug addon，應先結束使用該 addon 的 Node 程序，再明確更新載入檔：

```powershell
# 執行位置：D:\pug-rust\ismd；建置成功後才執行。
$env:ISMD_PROFILE = '0' # 此 shell 使用一般 loader，避免既有 profile 路徑覆蓋候選檔。
Copy-Item -LiteralPath .\target\debug\ismd_napi.dll -Destination .\ismd-napi.win32-x64-msvc.node -Force
$builtHash = (Get-FileHash -LiteralPath .\target\debug\ismd_napi.dll -Algorithm SHA256).Hash
$loadedHash = (Get-FileHash -LiteralPath .\ismd-napi.win32-x64-msvc.node -Algorithm SHA256).Hash
if ($builtHash -ne $loadedHash) { throw 'DLL 與載入用 .node 內容不一致' }
node --input-type=module -e 'import { render } from "./index.mjs"; console.log(render("p hello"));'
```

此 smoke check 依 `render` 實作應輸出 `<p>hello</p>`；hash 比對確認 `.node` 與剛選定的 DLL 相同，仍須以先前 Cargo 成功的結果確認 DLL 是該次建置產物。新 Node 程序與 `ISMD_PROFILE='0'` 讓檢查遵循一般 loader 的第一候選檔。這是交接用檢查範例，本次沒有建置、複製 binary 或執行 smoke check。`.dll`、`.node`、`target/` 為建置產物，本次文件變更不包含它們。來源：[loadNativeAddon](../../index.mjs#L13)、[render](../../index.mjs#L986)。

### Native plugin 測試前置

預設 integration suite 的 skeleton 等測試會匯入相鄰 `ismd-filters` 的 `nativePluginPath`，不是只測沒有 plugin 的核心。該 helper 找不到 library 時會 throw，並指示建置 filters。依據：[skeleton.test.mjs](../../tests/integration/skeleton.test.mjs#L1)、[native-plugin-poc.test.mjs](../../tests/integration/native-plugin-poc.test.mjs#L1)、[nativePluginPath](../../../ismd-filters/index.mjs#L6)。

```powershell
Set-Location D:\pug-rust\ismd-filters
npm run build
Set-Location D:\pug-rust\ismd
```

filters 的 build script 是 `cargo build --manifest-path native/Cargo.toml`，為另一個 Rust workspace；這裡只記錄它作為 `ismd` 測試的前置條件。見 [ismd-filters/package.json](../../../ismd-filters/package.json#L14)。

## 4. 測試指令與實際範圍

執行目錄：`D:\pug-rust\ismd`。下列 script 定義均見 [package.json](../../package.json#L40)。

| 指令 | 已定義範圍與限制 |
|---|---|
| `cargo test --workspace` / `npm run test:rust` | Rust workspace 測試 |
| `npm test` / `npm run test:integration` | 只列 skeleton、template-store、compiler-session、js-api、core-decoupling、phase6-no-plugin-syntax、cases 七個檔案；不是 integration 目錄所有測試 |
| `npm run test:cases` | `tests/integration/cases.test.mjs` |
| `npm run test:native` | native-plugin-poc 與 core-decoupling |
| `npm run test:diff:core` | `tests/differential/core-decoupling.test.mjs` |
| `npm run test:serializers` | differential serializers 測試 |
| `npm run test:diff` | 完整 differential runner，需 reference compiler 與其依賴 |
| `npm run test:diff:baseline` | 同 runner 加 `--verify-baseline`；驗證 baseline 模式不等同 target 完整通過 |
| `npm run test:audit` | `scripts/audit-core-decoupling.mjs` 靜態邊界稽核 |

例如 [lifecycle-stability.test.mjs](../../tests/integration/lifecycle-stability.test.mjs#L1)、[release-api.test.mjs](../../tests/integration/release-api.test.mjs#L1) 存在，但不在預設 `test:integration` 清單中；需要時用 `node --test <對應檔案>` 明確執行。

Differential reference 由 `ISMD_REFERENCE_ROOT` 指定，否則先找 repo 的 `raw/compiler`，不存在再找 `raw/pug`；serializer 會載入 reference 的 `prettier`、`pretty-format`，runner 載入 reference 各 `ismd-*` packages。見 [serializers.mjs](../../tests/differential/serializers.mjs#L11)、[runner.mjs](../../tests/differential/runner.mjs#L21)。

Reference 的目錄存在仍不足以跑測試：runner 需要該目錄下的 `packages/ismd-*`，serializer 先找 reference 的 `node_modules`，失敗才嘗試一般模組解析。預設路徑、取得 reference 的方式與可比較的版本不是同一件事；目前文件沒有可驗證的下載／版本固定／安裝程序。應由維護者提供這些資訊，不能因目錄名叫 `raw/pug` 就假設其 package layout 符合 runner。[loadRawPackages](../../tests/differential/runner.mjs#L23)、[requireFromRaw](../../tests/differential/serializers.mjs#L20)

`compat:baseline` 會執行 baseline generator；runner 的 `--write-matrix` 與 `--json` 會寫入輸出檔，不屬於只讀檢查。本次沒有執行這些寫入。見 [runner output options](../../tests/differential/runner.mjs#L2487)。

## 5. 環境變數與 profiling

| 名稱 | 精確用途 | 證據 |
|---|---|---|
| `ISMD_PROFILE` | 值為字串 `'1'` 才啟用 JS profile addon 選擇與 Rust profile session；Rust 也必須以 `profile` feature 編譯 | [loader](../../index.mjs#L14)、[profile.rs](../../crates/ismd_ast/src/profile.rs#L222)、[features](../../crates/ismd_napi/Cargo.toml#L11) |
| `ISMD_PROFILE_ADDON` | 只有 `ISMD_PROFILE === '1'` 時使用；resolve 絕對路徑，若是 `.dll` 則按 mtime 複製到同位置 `.node` 再載入 | [loadNativeAddon](../../index.mjs#L14) |
| `NODE_ENV` | `__express` 且 `compileDebug` 未指定、值為 `'production'` 時設 `compileDebug = false`；不是全域 compile 預設開關 | [__express](../../index.mjs#L1029) |
| `ISMD_REFERENCE_ROOT` | Differential 測試的 reference checkout | [serializers.mjs](../../tests/differential/serializers.mjs#L14) |

Profiling 建置與指向 addon 的範例：

```powershell
Set-Location D:\pug-rust\ismd
cargo build --release -p ismd_napi --features profile --target-dir target-profile
$env:ISMD_PROFILE = '1'
$env:ISMD_PROFILE_ADDON = (Resolve-Path -LiteralPath .\target-profile\release\ismd_napi.dll).Path
```

`getLastProfileJson()` 取得上一筆 profile JSON；未具備 profile 功能時可能回傳 `null`。`benchmarks/diagnostics/run-profiler.mjs` 的預設 addon 路徑目前仍組成 `<repo>/compiler/target-profile/release/ismd_napi.dll`，與現行 `ismd/` 路徑不同；若使用該 script，需顯式設定 `ISMD_PROFILE_ADDON`，並核對 reference cases 的存在。見 [getLastProfileJson](../../index.mjs#L1044)、[run-profiler.mjs](../../benchmarks/diagnostics/run-profiler.mjs#L14)、[benchmarks/shared.mjs](../../benchmarks/shared.mjs#L6)。

## 6. 交付檔案與排錯

套件 `files` 宣告包含 `index.mjs`、`index.d.ts`、`register.mjs`、`runtime/`、Windows `.node`、README 與兩個 compat 文件。這是 package manifest 中的封裝清單，**不是已完成公開發布的證據**；`private: true` 與缺少發布腳本仍是目前狀態。見 [package files](../../package.json#L13)。

| 現象 | 查核位置與原因 |
|---|---|
| `ismd_napi native module not found` | loader 三個候選檔都不存在；先查 build 是否成功、執行目錄與 target directory 是否一致。[loader](../../index.mjs#L31) |
| 修改 Rust 後行為未改 | `.node` 優先於新 DLL；確認載入檔與 Node 程序是否更新。[loader](../../index.mjs#L31) |
| `ISMD_PROFILE_ADDON not found` | 自訂 profile addon 路徑不存在。[profile loader](../../index.mjs#L14) |
| `Native Filters library is missing` | 測試使用的 filters native library 尚未建置或 profile 不符。[nativePluginPath](../../../ismd-filters/index.mjs#L6) |
| Differential dependency not found | reference checkout、其 node_modules 或 `ISMD_REFERENCE_ROOT` 不符。[requireFromRaw](../../tests/differential/serializers.mjs#L20) |
| 長時間 session 未反映檔案修改 | explicit store 信任快取來源；檔案事件應呼叫 update/invalidate/remove API。沒有在 core session 內自動啟動 watcher。[CompilerSession](../../crates/ismd_compiler/src/session.rs#L124) |

目前 log 主要由 `console.warn` 傳遞 warning，`options.debug` 會以 `console.error` 印出 compiled function；未見統一 logging backend 或 telemetry exporter。見 [defaultWarn](../../index.mjs#L648)、[debug output](../../index.mjs#L888)。

## 7. 尚待實際驗證的交接項目

1. 根 lockfile 與新 workspace layout 的一致性、乾淨環境 dependency 安裝。
2. 所需 MSVC 編譯/連結工具是否已安裝；本 repo 未提供自動環境佈署腳本。
3. 預編譯 `.node` 與目前 Rust source 的版本一致性；本次沒有重建或驗證既有 binary。
4. 非 Windows 平台、npm 公開發布與 production 主機部署流程；現有程式碼不足以證明這些已完成。

以上是文件查證邊界，不是新增功能需求或宣稱測試失敗。
