# Pug Rust Compiler 轉換規劃 (`rust/compiler`)

> 本文件為 `d:/pug-rust/raw/compiler` 轉換至 `d:/pug-rust/rust/compiler` 的正式工程規格與實施藍圖，保留模組對照、Rust 核心與 NAPI 分離設計，以及測試驅動移植（Test-Driven Porting）流程。

## 目標與相容範圍

以 **Rust + Oxc** 實作 Pug 編譯核心，提供與本機基準版本 `raw/compiler` 相容的 Node.js API。

第一階段固定使用 **Oxc**，不同時維護 Oxc／SWC 雙後端。Oxc 的角色是 JavaScript 解析與語意分析，不是 Pug Parser、JavaScript Runtime，也不是自動可用的 `constantinople` 或 `with` 替代實作。

### 本機 `raw/compiler` 實際基準版本
本機 `d:/pug-rust/raw/compiler` 為 Yarn v1 Monorepo（具備固定的 `yarn.lock`），各核心套件與關鍵外部 JS 分析依賴版本如下：
- **核心套件**：
  - `pug`: `2.0.4`（含 `lib/index.js` 與 `register.js`）
  - `pug-lexer`: `4.1.0`
  - `pug-strip-comments`: `1.0.4`
  - `pug-parser`: `5.0.1`
  - `pug-walk`: `1.1.8`
  - `pug-load`: `2.0.12`
  - `pug-filters`: `3.1.1`
  - `pug-linker`: `3.0.6`
  - `pug-attrs`: `2.0.4`
  - `pug-code-gen`: `2.0.2`
  - `pug-runtime`: `2.0.5`
  - `pug-error`: `1.3.3`
- **內嵌 JS 相關基準依賴**：
  - `character-parser`: `^4.0.0`
  - `is-expression`: `^4.0.0`
  - `constantinople`: `^4.0.1`
  - `with`: `^7.0.0`
  - `doctypes`: `^1.1.0` / `void-elements`: `^3.1.0` / `js-stringify`: `^1.0.2`
- **原版測試與快照序列化規則**（定義於 `raw/compiler/package.json`）：
  - 測試執行器：`jest@^26.0.1`（執行前需跑 `yarn build` 觸發 `pug-runtime/prepublish.js` 生成 `lib/dependencies.js`、`lib/internals.js`、`lib/sources.js`）。
  - Snapshot Serializers：
    1. `scripts/filename-serializer.js`：統一跨平台路徑斜線並移除專案根目錄前綴。
    2. `scripts/prettier-javascript-serializer.js`：對包含 `function ` 的生成 JS 字串使用 `prettier@1.19.1`（`{ parser: 'babel' }`）格式化後再進行快照比對。
    3. `scripts/buffer-serializer.js`：序列化 Buffer 物件。

### 相容性分層驗收標準

| 層級 | 驗收範圍 |
|---|---|
| 語言及輸出 | 語法接受／拒絕、HTML 字串、空白、escaping、屬性順序、控制流程 |
| 執行語意 | locals、globals、self、函式、getter、原型、Mixin、例外及可觀察副作用 |
| 公開 API | 函式簽章、同步／callback 行為、預設選項、dependencies、cache、filters、runtime、`register.js` |
| 擴充介面 | 明列支援的 plugin hooks、lex／parse 擴充、read／resolve／generateCode 替代介面 |
| 內部套件 | Token／AST JSON 與各套件 API；只有明列的部分才宣稱相容 |
| 產物文字 | `compileClient` 與 codegen 快照分兩層驗收：① 經 `prettier` (`babel` parser) 格式化後的快照一致性；② 未格式化的原始輸出與 `pug-runtime/build` 內嵌字串一致性 |

不得使用「支援全部語法」代替外掛、選項、錯誤與副作用相容驗收。未支援項目必須列出，不可靜默忽略。

---

## 一、現有架構與編譯管線

### 1. 核心資料流

```text
Node.js 公開 API：正規化各入口選項，但不序列化 render locals
    ↓
同步 NAPI 呼叫 + 編譯用 Host 介面 (同執行緒同步回呼)
    ↓
Loader 對入口與每個模板依賴執行：
    preLex → Lexer → postLex
    → 路徑 Token 補副檔名（path token 無副檔名時補 .pug）
    → StripComments → preParse → Parser → postParse → preLoad
    → resolve / read → 遞迴處理 include / extends
    ↓
postLoad
    ↓
preFilters → Filters → postFilters
    ↓
preLink → Linker → postLink
    ↓
preCodeGen → CodeGen（含 attrs、JS scope / locals 轉換）→ postCodeGen
    ↓
{ body, dependencies }
    ├─ compileClient 系列：回傳 JS 原始碼／追蹤依賴的產物
    └─ compile / render 系列：Node 包裝函式 → 原始 locals → HTML
```

`pug_runtime` 提供 JavaScript helpers；函式建構（`new Function` / `runtimeWrap`）與呼叫由 Node 包裝層處理，Rust 端不內建 JS 執行引擎。

### 2. 內嵌 JavaScript：`pug_js` 內部分工

```text
pug_js/
├── scan.rs        # 字串、註解、regex、template literal、括號與 Pug 邊界 (對應 character-parser)
├── expression.rs  # Oxc 表達式解析、完整消耗檢查、語法錯誤對應 (對應 is-expression)
├── constant.rs    # 與基準 constantinople 相容的常數分類與求值
├── scope.rs       # 完整 JS 上下文中的自由變數／作用域分析
└── locals.rs      # 與基準 with 套件相容的包裝、綁定與 return 處理
```

- **邊界規則**：Pug 屬性區域不等於一段完整 JS。不能以逗號分割屬性，不能遇到第一個右括號就終止，也不能把每段 unbuffered code 都當成獨立完整程式。
- **語法模式**：以基準 Pug 的可接受語法為契約；Oxc 支援更多語法不代表相容模式就應開啟 TypeScript、JSX 或 module 語法。對控制流程片段建立合適的函式／區塊上下文，並保存回原始 Pug 的位置映射。
- **常數求值**：區分「已知常數」「非常數」「本實作尚不支援」「語法／求值錯誤」。filter 選項需要在編譯期取得值，不能一律延後到 render。初期對非必要最佳化採保守策略；相容版本必須符合基準對常數的接受與拒絕行為。
- **locals 轉換**：不能將所有自由變數直接改寫為 `locals.name`。需驗證屬性存在性（含 `in` 原型鏈檢查或基準 `with` 行為）、全域名稱回退、getter 次數／順序、`this`、`return`、暫存變數碰撞，以及賦值是否影響區域變數。Oxc 提供分析工具，Pug 的相容轉換仍須自行實作。

### 3. 編譯宿主與外掛（同步 NAPI 與同執行緒回呼規範）

- **Host Trait 抽象**：以不依賴 NAPI 的 Rust `CompilerHost` trait 抽象讀檔（`read`）、路徑解析（`resolve`）、過濾器（`filter`）與各階段 plugin hooks。`pug_napi` 提供 Node 宿主 adapter；純 Rust 使用者可提供原生檔案系統宿主。
- **階段精確性**：不能只在最外層包一個 `compileBody()`，再於編譯完成後補跑所有外掛。相關呼叫須發生在正確階段與正確依賴檔案上（特別是 `load` 遞迴期間對每個被引入檔案的 `preLex`/`postLex`/`preParse`/`postParse`/`preLoad`/`resolve`/`read`）。
- **同執行緒同步回呼（Synchronous Same-Thread Callbacks）**：
  - Pug 的所有編譯與渲染 API（包含 `render(str, options, fn)` 的 callback 版本）在原版皆為**同步執行**。
  - 在 `pug_napi` 中，所有編譯入口必須保持在 **Node.js 主執行緒同步執行**，並直接使用同步的 `napi::Env` 與 `JsFunction::call` 回呼 JS 端的 `plugins` 與 `filters`。
  - **嚴禁**在同步編譯路徑中將含 JS 回呼的工作丟到背景執行緒，或等待 `ThreadsafeFunction` 佇列（這會因為主執行緒正在阻塞等待 Rust 返回而造成死鎖），並確保在 JS hook / filter 內重入（Re-entrant）呼叫 `pug.compile` / `pug.render` 時安全運作。
- **Lexer / Parser 內部擴充 Plugins**：對於透過 `plugin.lex` / `plugin.parse` 擴充內部方法的 plugins，需另外定義狀態、`this` 與資料可變性相容層；支援 `preLex`／`postParse` 不等於支援完整的 lex／parse 擴充介面。

---

## 二、`raw/compiler/packages` 與 `rust/compiler` 對照表

保留與原版套件一一對應的 crate 拆分，作為逐套件對照測試的移植邊界：

| 原版套件 | Rust Crate | 核心職責與修訂要求 |
|---|---|---|
| 共用資料結構 | `pug_ast` | Token、AST、來源資訊；為相容 JSON 設置明確 DTO／轉換層，保留缺欄位與 `null` 的差異 |
| `character-parser` / `is-expression` / `constantinople` / `with` | `pug_js` | 分為掃描、解析、常數、作用域與 locals 轉換；固定 Oxc，不能僅靠 parser 取代全部功能 |
| `pug-error` (`1.3.3`) | `pug_error` | PUG 錯誤碼（`PUG:CODE`）、訊息、檔案、行列、來源上下文、`toJSON()`；JS Error 類型／屬性由 adapter 保留 |
| `pug-lexer` (`4.1.0`) | `pug_lexer` | 詞法狀態機、縮排、插值、JS 邊界與來源正規化 |
| `pug-strip-comments` (`1.0.4`) | `pug_strip_comments` | 預設移除 unbuffered `//-`、保留 buffered `//`；依 `stripUnbuffered` / `stripBuffered` 選項控制 |
| `pug-parser` (`5.0.1`) | `pug_parser` | Pug AST（含 `lib/inline-tags.js` 規則）；覆蓋完整節點清單與 parser 擴充契約 |
| `pug-walk` (`1.1.8`) | `pug_walk` | `before`／`after`、`return false` 停止子樹走訪、`parents` 堆疊、合法位置的 `replace` 陣列展開、`includeDependencies` 走訪 |
| `pug-load` (`2.0.12`) | `pug_load` | `read`／`resolve`、遞迴載入、`RawInclude`、原始 bytes (`Buffer`)、路徑驗證與依賴記錄 |
| `pug-filters` (`3.1.1`) | `pug_filters` | 編譯期常數選項、巢狀／include filters、`filterOptions`、`filterAliases`、Node 自訂 filter／JSTransformer 橋接 |
| `pug-linker` (`3.0.6`) | `pug_linker` | `include`、`yield`、`extends`、`block` (`replace`／`prepend`／`append`)、繼承中的 Mixin 定義保留 |
| `pug-attrs` (`2.0.4`) | `pug_attrs` | 靜態／動態屬性 codegen、escape、class／style／布林與屬性合併 |
| `pug-code-gen` (`2.0.2`) | `pug_code_gen` | JS render function、控制流程、Mixin 函式／呼叫、locals 包裝、debug 與格式選項 |
| `pug-runtime` (`2.0.5`) | `pug_runtime` | 以 `runtime/index.js` 為唯一真實來源；提供 `pug_runtime::build(fns)` 產出與原版 `prepublish.js` UglifyJS 相容的內嵌函式片段與依賴圖 |
| `pug` (`2.0.4`) | `pug_compiler` + `pug_napi` + `index.js` | Host-aware 編譯協調、同步 NAPI、公開 API／函式包裝／cache／callback／`register.js` 相容 |

### 補充邊界

- **Mixin**：Linker 整合定義在繼承中的位置；Codegen 產生執行期函式與呼叫。不得無條件靜態展開，需支援遞迴、動態名稱、`block`、`attributes` 及預設參數語意。
- **Filters**：不要假設 `:markdown` 或 `:cdata` 都是 Rust 核心內建。依基準版本區分自訂 JS filter（含 `.render` / `.renderBuffer`）與 JSTransformer 套件解析。Node 宿主橋接既有套件；純 Rust 宿主遇到未提供的 filter 必須回報明確 `PUG:UNKNOWN_FILTER` 錯誤。
- **來源座標**：內部 UTF-8 byte span、對外 JS UTF-16 `col` 欄位與 1-based `line` 分開保存／轉換。測試中文、非 BMP 字元（Emoji 代理對）、BOM、CRLF、tab 與 include 檔案位置。
- **序列化**：JSON 快照可驗證資料形狀，但不保證函式、`Buffer`、自訂欄位、物件身分或原型往返相容。外掛介面的轉換限制必須明確記錄，不可靜默丟失資料。
- **`pug_runtime` 單一來源機制**：
  - 原版 `pug-runtime/prepublish.js` 會解析 `pug-runtime/index.js` 中所有 `pug_*` 函式與變數，分析彼此依賴（如 `attrs` 依賴 `attr`, `classes`, `escape`, `style`），並用 UglifyJS 壓縮存入 `lib/sources.js` 與 `lib/dependencies.js`；在 `inlineRuntimeFunctions: true` 時按字母排序拼接。
  - 在 `rust/compiler` 中，`runtime/` 保留原版 `index.js` 與 `wrap.js`，並由 `pug_runtime` crate（透過 `build.rs` 或直接載入由 `runtime/index.js` 產生的定義表）提供完全一致的依賴展開與內嵌程式碼片段，杜絕雙份邏輯漂移。

---

## 三、`rust/compiler` 目錄結構

```text
d:\pug-rust\rust\compiler\
├── PLAN.md
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── package.json
├── yarn.lock                   # 或與選定套件管理器相符的 lockfile
├── index.js                    # 主公開 API (對標 raw/compiler/packages/pug/lib/index.js)
├── register.js                 # 對標 raw/compiler/packages/pug/register.js (require.extensions['.pug'])
├── index.d.ts
├── runtime/                    # JS helpers 的唯一實作來源 (index.js, wrap.js, build.js)
├── compat/
│   ├── baseline.json           # raw/compiler 版本／檔案雜湊／測試環境記錄
│   ├── matrix.md               # API、語法、外掛與已知差異追蹤表
│   └── expected-differences.json
├── tests/
│   ├── differential/           # 原版 (raw/compiler) 與 Rust (rust/compiler) 的差異比對 runner
│   ├── fixtures/               # 本專案新增的高風險邊界案例
│   ├── integration/            # Node／client／外掛／框架整合
│   └── benchmarks/
└── crates/
    ├── pug_ast/
    ├── pug_error/
    ├── pug_js/
    ├── pug_lexer/
    ├── pug_strip_comments/
    ├── pug_parser/
    ├── pug_walk/
    ├── pug_load/
    ├── pug_filters/
    ├── pug_linker/
    ├── pug_attrs/
    ├── pug_code_gen/
    ├── pug_runtime/
    ├── pug_compiler/
    └── pug_napi/               # cdylib
```

純 Rust CLI／Linter 可引用核心 crates，不代表已經能無 Node 執行任意 Pug JavaScript 或任意 npm filter。CLI 應分清楚輸出 JS、受限制靜態 HTML，以及需要 JS 執行宿主的模式。

---

## 四、Node.js API 對接設計

### 1. Rust／NAPI 介面

主要產物維持：

```text
compileBody(source, compileOptions, host) -> { body, dependencies }
```

debug sources 在編譯期間由 `CompilerHost` / `pug_compiler` 收集並用於 `includeSources` 的 codegen，無須強制加進公開回傳形狀。

保留 `lex`／`stripComments`／`parse`／`walk`／`load`／`link`／`generateCode` 作為內部測試與進階子入口，讓 `tests/differential` 可以針對單一階段與原版套件直接做 A/B 對照。公開的 client API 預設值與 module 包裝集中在 Node 相容層，避免 Rust 與 JS 分別實作兩套不一致的入口行為。

### 2. 公開 API 與匯出入口

按固定基準版本 `pug@2.0.4` 核對參數、預設值、回傳值與屬性：

```text
compile / compileFile
compileClient / compileFileClient
compileClientWithDependenciesTracked
render / renderFile / __express
cache / filters / runtime / name
require('pug/register')
```

`compile()` 先得到 JS 原始碼，再於 Node 透過 `new Function('', parsed.body + ';return template;')()`（當 `inlineRuntimeFunctions: true`）或 `runtimeWrap(parsed.body)`（預設）建構函式，並掛上 `.dependencies`。`render()` 直接將原始 JS `options`（作為 locals）傳給函式；**絕不將 locals 轉 JSON 或複製成 Rust Map**。

### 3. 必要選項契約

| 項目 | 規格要求 |
|---|---|
| `pretty` | 相容 boolean（`true` 轉 `'  '`）與自訂縮排字串 |
| `compileDebug` | 保留各入口預設差異：`compile` 預設 `options.compileDebug !== false`（即預設 `true`），而 `includeSources` 在 `compile` 為 `options.compileDebug === true`（明確傳 `true` 才內嵌原始碼）；`compileClient` 則直接傳遞 `options.compileDebug`；`__express` 在 `NODE_ENV === 'production'` 且未指定時設為 `false` |
| `inlineRuntimeFunctions` | `compile` 預設為 falsy（使用 `runtimeWrap`）；`compileClient` 預設為 `options.inlineRuntimeFunctions !== false`（即預設 `true`） |
| `name` / `module` | client 函式名稱（預設 `'template'`）、識別字合法性驗證、`module: true` 時的 `var pug = require("pug-runtime");` 與 `module.exports = ...;` 包裝 |
| `filename` / `basedir` | 依相容的 Node `path` 規則解析，不任意 `fs::canonicalize` 改寫可觀察路徑（避免 Windows `\\?\` 前綴或軟連結展開破壞快照與 `dependencies`） |
| `self` / `globals` | 配合 scope 與 `with` locals 轉換測試 |
| `filters` / `filterOptions` / `filterAliases` / `plugins` | 合併全域 `exports.filters` 與 `options.filters`；JS 物件與函式保留在 Node 宿主，於正確階段同步執行 |
| `cache` | 公開 `exports.cache` 物件可供外部直接讀寫與清空（`compileFileClient` 使用 `path + ':client'` 作為 key；`render` 開啟 `cache` 但缺少 `filename` 時必須拋出 `'the "filename" option is required for caching'`） |
| `debug` / `includeSources` | `debug: true` 時向 `console.error` 輸出帶 ANSI 灰階色碼的編譯後函式 |

### 4. 同步、錯誤與安全

- 相容入口不改成 Promise。`render` / `renderFile` 的 callback 參數處理（當第二個參數為 function 時視為 `fn`）及 `try / catch` 分流與原版完全一致。
- Rust 編譯錯誤需轉換成具相容欄位（`code`, `msg`, `line`, `column`, `filename`, `src`, `toJSON`）的 JS `Error`；JS hook 拋出的例外需原樣保留並向上傳遞，不可全部包成泛用字串錯誤。不得讓 Rust `panic!` 越過 FFI 邊界。
- 模板、filter、plugin 可執行任意 JS 程式碼，必須視為可信輸入；Rust 實作不會自動提供 sandbox。

---

## 五、分階段開發與測試驗證

### Step 0：鎖定相容基準及驗收分類

- [x] 記錄 `raw/compiler` 的套件版本、檔案雜湊與 `yarn.lock`，寫入 `compat/baseline.json`。
- [x] 固定 Rust toolchain、Oxc、NAPI-RS、Node 版本與目標平台設定。
- [x] 在 `raw/compiler` 執行原版建置與測試（`yarn build && yarn test`），確認原版 fixture、快照與錯誤基準在本機可 100% 重現。
- [x] 建立差異測試 runner（`tests/differential`）與 `compat/matrix.md`；每個案例標記通過、失敗、不支援或已核准差異。
- [x] 實作與原版 Jest serializers 等價的比對工具（含路徑正規化與 `prettier` Babel 格式化比對，以及原始字串比對）。

### Step 1：Workspace、基礎型別與最小端到端路徑 (Walking Skeleton)

- [x] 建立 `rust/compiler/Cargo.toml` 與各子 crates 骨架，實作 `pug_ast`／`pug_error` 與來源座標轉換契約（並通過 `pug-error` 測試）。
- [x] 同時建立 `pug_napi`、`rust/compiler/index.js`、`register.js` 與 `runtime/` 接線。
- [x] 用只支援最小語法的 Lexer／Parser／Codegen 跑通 `pug.render('p Hello') -> '<p>Hello</p>'`。
- [x] 加入最小動態輸出與函式型 locals（如 `pug.render('p= fn()', { fn: () => 'ok' })`），驗證 locals 不經 JSON 序列化。
- [x] 建立主執行緒同步 Host callback adapter 原型；驗證 `preLex` / 自訂 filter 回傳值、錯誤傳遞、同步時序與重入呼叫行為。
- [x] 驗證 Windows MSVC (`.node`) 原生模組建置與載入。

### Step 2：Lexer、註解與 JS 邊界

- [x] 完成 `pug_js` 的 `scan.rs`（對應 `character-parser`）與 `expression.rs`（對應 `is-expression`）。
- [x] 移植 `pug_lexer`、`pug_strip_comments`，核對 buffered／unbuffered 註解預設值與選項。
- [x] 跑通 `raw/compiler/packages/pug-lexer/test/` 與 `pug-strip-comments/test/` 所有 Token 快照與錯誤案例；加入 regex、template literal、巢狀括號及 Unicode 案例。
- [x] 新支援的基本語法同步加入 Node render 差異測試。

### Step 3：Parser、Walk、控制流程與 locals

本階段拆成 **3A：Parser／Walk → 3B：最小 Codegen → 3C：Scope／locals**，分段實作與驗收。保留現有 crate 分工，不新增另一套編譯架構。

**相容基準沿用 Step 0 固定的本機 `raw/compiler` 快照與實際解析依賴。所有新增項目均為待辦，不代表已完成實作或通過測試。**

#### 開始條件與階段邊界

- [ ] 確認 Step 2 的 Token、註解處理與錯誤測試已有可重現結果；失敗、跳過、不支援及已核准差異分開記錄。
- [ ] 確認 Token 類型、欄位、缺欄位與 `null`、位置資訊及 `eos` 等契約穩定；Parser 不自行修補不符合契約的 Lexer 輸出。
- [ ] 重跑 Step 1 的 Node → NAPI → Rust → JS render 路徑，確認原生模組與函式型 locals 仍正常，locals 不經 JSON 序列化。
- [ ] 沿用 `compat/baseline.json` 與既有 serializers，不在本階段順便升級基準依賴或自動更新預期快照。

Step 2 若有已隔離的未完成案例，可先開發不受影響的 Parser／Walk 功能，但必須記錄依賴關係；受阻案例不得列為通過。本階段不以完成 Loader、Filters、Linker 或全部 Codegen 選項為前提。

#### Step 3A：Parser 與 AST Walk

**目標：先確認 AST 資料與走訪行為，再擴充執行能力。**

- [ ] 盤點本機 `raw/compiler/packages/pug-parser/test/`、`pug-walk/test/` 的案例與節點種類，建立對應測試清單；擴充外掛案例單獨標記。
- [ ] 移植 `pug_parser`（含 `lib/inline-tags.js` 規則），覆蓋基準的節點、巢狀關係、屬性、插值、JS code、控制流程與語法錯誤。
- [ ] 為 `include`、`extends`、`block`、Mixin 與 Filters 建立相容 AST；本階段的 Parser 不執行讀檔、模板連結、Mixin 展開或 filter。
- [ ] 保留 JS 片段與來源資訊，不在 Parser 中任意改寫表達式、執行常數求值，或把 unbuffered code 當成獨立完整 JS 程式驗證。
- [ ] 分開內部 AST 與對外相容 DTO；比對缺欄位、`null`、空陣列、預設值、節點順序與來源位置，不輸出額外內部欄位。
- [ ] 移植 `pug_walk`，核對 `before`／`after` 順序、`before` 回傳 `false` 時的停止範圍，以及是否呼叫對應 `after`；預期行為取自本機基準。
- [ ] 核對 `parents` 的內容、最近父節點的位置與 callback 執行時點，保存每次 callback 的觀察紀錄。
- [ ] 核對單節點與陣列 `replace` 的合法位置、展開順序、非法替換錯誤，以及替換後節點是否再次走訪；不能只比較最後 AST。
- [ ] 核對 `includeDependencies` 對既有依賴 AST 的走訪規則；Walker 不自行載入檔案。
- [ ] 保留 Parser 擴充介面邊界。完整 Node plugin 擴充相容仍依 Step 6 驗收；相關未完成案例須明列，不得略過後宣稱整套 Parser 測試全數通過。

**測試分成兩層：**

```text
單階段差異測試：
同一份獨立 Tokens → 原版 Parser / Rust Parser → AST 或錯誤比對
同一份獨立 AST    → 原版 Walk / Rust Walk     → callback 紀錄、結果與錯誤比對

整條前端管線測試：
同一份 Pug → 原版 Lexer → StripComments → Parser
同一份 Pug → Rust Lexer → StripComments → Parser
                                          ↓
                                    AST 或錯誤比對
```

兩邊使用相同內容、互不共享可變狀態的輸入。保留中文、emoji、BOM、CRLF、tab 等位置案例，並依 Step 0 的規則比對；不得藉由刪除位置欄位或重新排序節點隱藏差異。

#### Step 3B：最小 Attrs／Codegen 與控制流程

**目標：以明確限定的功能範圍，讓 Parser 產物接回既有 Node 執行路徑。**

- [ ] 在 `compat/matrix.md` 列出本階段支援的節點與編譯選項，區分「可解析」「可走訪」「可產生 JS」「可渲染」四種能力。
- [ ] 建立最小 `pug_attrs`／`pug_code_gen`：一般標籤、文字、靜態 ID／Class／字串屬性、buffered／unbuffered 輸出與插值；escaping 依既有 runtime 契約處理。
- [ ] 加入用來驗證控制流程的 `if`／`else`／`unless`、`each`（含替代區塊）、`while` 與 unbuffered JS code；依本機基準核對其接受、拒絕與輸出行為。
- [ ] 將 JS 控制流程片段與其 Pug 子節點組成完整的函式／區塊結構，不逐行獨立編譯，並保留回原始 Pug 的位置資訊。
- [ ] 保持編譯與渲染分離：Rust 回傳 JS，Node 建構函式並傳入原始 locals；不得在編譯時提前執行模板中的動態 JS。
- [ ] 測試 fixture 明確記錄入口、選項與 locals 建立方式，同時保留公開 API 預設選項的回歸案例；不得暗中關閉 `compileDebug` 或更改 runtime 模式來通過測試。
- [ ] 對尚未支援的節點或選項明確回報，標示為本實作未完成；不得忽略節點、輸出空字串、偽裝成基準語法錯誤，或回退原版 Pug 後算成 Rust 通過。
- [ ] 分開比對 HTML／回傳值／錯誤與生成 JS 文字。已納入本階段的產物契約沿用 Step 0 的兩層比對；不能以 HTML 相同掩蓋未核准的 codegen 字串差異。

3B 可先以模板內自行宣告變數、常值與既有最小整合案例驗證；需要完整自由變數綁定的案例接到 3C 後驗收。不得為了先跑通 3B，新增直接將識別字替換成 `locals.xxx` 的暫時實作。

完整 `pug-attrs`／`pug-code-gen` 測試集與全部選項仍在 Step 5 收斂；本階段只驗收明列範圍，不宣稱整套 Codegen 已完成。

#### Step 3C：Oxc Scope 與 locals 相容轉換

**目標：在完整 JS 上下文中分析作用域，並保留指定基準 `with` 的執行語意。**

```text
Pug AST
    ↓
建立必要的 JS 宣告、函式與區塊上下文
    ↓
Oxc Parser + Semantic Analysis
    ↓
依基準辨識自由變數與排除名稱
    ↓
locals 相容包裝、綁定與控制流程處理
    ↓
最終 JS → Node 執行 → 語意及副作用差異測試
```

- [ ] 在 `pug_js::scope.rs` 整合 Oxc Parser／Semantic Analysis，檢查診斷結果、宣告與引用解析；不能僅以取得 AST 判定合法。
- [ ] 在 `pug_js::locals.rs` 對照已鎖定的 `with` 實作完成轉換，不直接依賴 Oxc 預設行為，也不以字串替換或 `locals.xxx` 全域改寫代替。
- [ ] 按基準處理局部宣告、生成程式使用的內部名稱、`globals` 排除與 `self` 分支；先完成本階段語意測試所需範圍，完整選項組合在 Step 5 收斂。
- [ ] 核對自由變數輸出與 locals 讀取的順序，不依賴 Rust 無序集合的迭代順序，避免改變 getter 副作用或產物文字。
- [ ] 處理函式／區塊邊界、外層與巢狀 `return`、`this`、`arguments` 及暫存名稱碰撞；結果以本機基準建立預期值。
- [ ] 新增的作用域與控制流程案例同時執行直接 JS 轉換測試及 Pug 端到端測試，避免只有其中一層通過。
- [ ] Oxc 主要用於解析與分析；要求原始 JS 文字一致的路徑，不任意重新列印整份程式。所有文字差異依既有相容契約獨立追蹤。

**必要測試矩陣：**

| 測試組 | 應驗證內容 |
|---|---|
| 宣告與遮蔽 | `var`／`let`／`const`、函式參數、解構、閉包及同名變數；接受／拒絕以基準語法能力為準 |
| locals 取值 | 自有屬性、原型鏈、不存在的屬性、存在但值為 `undefined`、全域名稱回退 |
| 讀取副作用 | getter 呼叫次數、順序、讀取時點與拋出例外，不只比較最終 HTML |
| 賦值 | `=`、`+=`、`++` 對區域值與原始 locals 的影響 |
| 執行上下文 | `this`、`arguments`、外層 `return`、巢狀函式的 `return` 與丟出例外 |
| 生成名稱 | 使用者名稱與內部暫存名稱、runtime 名稱或參數衝突 |
| 控制流程與錯誤 | 多層條件／迴圈、JS 片段上下文、無效語法，以及錯誤發生於編譯或執行階段 |

具有 getter、函式、原型或可變狀態的 locals，應由同一 fixture factory 分別建立兩份等價實例。不得以 JSON 複製，也不得先執行原版後，把已受副作用影響的同一物件交給 Rust 產物。

#### 與 Step 4～6 的責任分界

| 功能 | Step 3 必須完成 | 後續完成事項 |
|---|---|---|
| `include`／`extends` | AST、錯誤與既有依賴 AST 的 Walk 規則 | Step 4 讀檔、遞迴載入與連結 |
| `block`／`append`／`prepend` | 節點與關係 | Step 4 繼承合併 |
| Filters | 節點、屬性與走訪 | Step 4 編譯期求值及執行 |
| Mixin | 定義／呼叫 AST 與 Walk | Step 4 接上遞迴、動態名稱及 block 案例，Step 5 補齊 Codegen |
| 完整 attrs／runtime／選項 | 明列範圍的最小支援與語意驗證 | Step 5 全面補齊 |
| Parser plugins | 介面邊界與受影響案例清單 | Step 6 完整 Node 擴充相容驗收 |

#### Step 3 完成條件與交付結果

- [ ] 3A：交付 Parser AST／錯誤差異結果、Walk callback 日誌與替換／停止／依賴走訪結果。
- [ ] 3B：交付支援範圍清單、最小渲染案例，以及 HTML、回傳值、錯誤與生成 JS 差異結果。
- [ ] 3C：交付 scope／locals 測試矩陣結果，包含原始 locals 變化、getter 日誌與控制流程語意。
- [ ] 重跑 Step 1～2 回歸測試，確認既有端到端路徑、Token、註解與來源位置沒有退步。
- [ ] 更新 `compat/matrix.md`，報告總數、通過、失敗、跳過、不支援及已核准差異；範圍內不得有未處理或未核准的差異。
- [ ] 延後項目逐一連到 Step 4、5 或 6，不計入本階段通過數；新增排除項目不得用來掩蓋原已承諾功能的失敗。

**只有 AST／Walk 通過時，僅能標記 3A 完成；3A、3B、3C 的已承諾範圍與回歸驗收都通過，才可標記整個 Step 3 完成。**

### Step 4：Loader、Filters、Linker

- [ ] 實作 `pug_load`：依賴載入、`basedir`、`read`／`resolve` hook、path token 自動補 `.pug`、`RawInclude` 與原始 bytes (`Buffer`)。
- [ ] 實作 `pug_js::constant`（對應 `constantinople`），滿足 `pug_filters` 編譯期常數選項求值需求。
- [ ] 實作 `pug_filters`：`filterOptions`、`filterAliases`、自訂 JS filter、JSTransformer 橋接、`renderBuffer`／`renderFile` 路徑。
- [ ] 實作 `pug_linker`：`include`／`yield`、`extends` 與 `block` (`replace`／`prepend`／`append`) 合併，保持 Filters 在 Linker 前執行。
- [ ] 核對 `dependencies` 陣列順序／重複行為與 hook 呼叫日誌，不任意排序去重。
- [ ] 測試 Mixin 遞迴、動態名稱、繼承中的定義位置與 `block` 傳入。

### Step 5：補齊屬性、Codegen、Runtime 與選項

- [ ] 完成 `pug_attrs`：`class`（陣列／物件）／`style`（物件）／布林屬性／`toJSON`／escape／同名屬性合併／輸出順序，通過 `pug-attrs/test/`。
- [ ] 完成 `pug_code_gen`：`doctype`、`void-elements`、`pretty`、`compileDebug`、`self`、`globals`、`includeSources` 與 `inlineRuntimeFunctions`。
- [ ] 完成 `pug_runtime`：確保 `inlineRuntimeFunctions: true` 與外部 `runtime/` 行為與依賴展開 100% 一致。
- [ ] 完整對齊 `constantinople` 相容範圍；對未知、非法及不支援的運算清楚區分。
- [ ] 按 Step 0 規則執行 `pug-code-gen` 文字快照與執行差異測試。

### Step 6：API／擴充整合與發行驗收

- [ ] 補齊全部已宣告 API、選項、`cache`、callback、`__express`、`register.js` 與 client 產物行為。
- [ ] 驗證 plugins 的階段 hooks、replacement hooks（`resolve`, `read`, `generateCode`）、lex／parse 擴充及資料往返限制。
- [ ] 執行 `raw/compiler/packages/pug/test/` 完整整合測試套件，更新 `compat/matrix.md`。
- [ ] 分開量測冷啟動、編譯、渲染、NAPI／序列化、外掛與記憶體效能基準（Benchmark），在此基礎上評估增量快取與最佳化。

### 驗收分類總表

| 測試類別 | 主要比較內容 |
|---|---|
| Token／AST | 欄位、缺省值、位置（1-based line / UTF-16 col）、節點順序；只正規化明確批准的檔案路徑差異 |
| HTML | 精確字串比對，不用 DOM 等價掩蓋空白或屬性順序差異 |
| 執行語意 | 回傳值、locals 副作用、getter 次數與順序、JS 例外 |
| Filters／Plugins | 呼叫階段、參數、同步順序、`read` 結果、`Buffer`、錯誤與資料修改 |
| API | 簽章、同步／callback、選項預設值、函式屬性、`dependencies`、`cache`、`register.js` |
| 錯誤 | 類型、`code`、`message`、檔案、行列與來源上下文；stack 的平台差異另列 |
| JS 產物 | 可解析／執行、client mode、module mode、Prettier 正規化快照及 inline runtime 依賴展開 |
| 效能 | 完整相容測試通過後，才評估速度與記憶體收益 |

---

## 本機核對參考路徑 (`d:/pug-rust/raw/compiler`)

- Workspace 與測試設定：[raw/compiler/package.json](file:///d:/pug-rust/raw/compiler/package.json)、[raw/compiler/yarn.lock](file:///d:/pug-rust/raw/compiler/yarn.lock)
- 快照正規化腳本：[filename-serializer.js](file:///d:/pug-rust/raw/compiler/scripts/filename-serializer.js)、[prettier-javascript-serializer.js](file:///d:/pug-rust/raw/compiler/scripts/prettier-javascript-serializer.js)、[buffer-serializer.js](file:///d:/pug-rust/raw/compiler/scripts/buffer-serializer.js)
- 主入口與管線：[packages/pug/lib/index.js](file:///d:/pug-rust/raw/compiler/packages/pug/lib/index.js)、[packages/pug/register.js](file:///d:/pug-rust/raw/compiler/packages/pug/register.js)
- 詞法與註解：[packages/pug-lexer/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-lexer/index.js)、[packages/pug-strip-comments/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-strip-comments/index.js)
- 語法與走訪：[packages/pug-parser/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-parser/index.js)、[packages/pug-walk/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-walk/index.js)
- 載入、過濾與連結：[packages/pug-load/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-load/index.js)、[packages/pug-filters/lib/handle-filters.js](file:///d:/pug-rust/raw/compiler/packages/pug-filters/lib/handle-filters.js)、[packages/pug-filters/lib/run-filter.js](file:///d:/pug-rust/raw/compiler/packages/pug-filters/lib/run-filter.js)、[packages/pug-linker/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-linker/index.js)
- 屬性、程式碼生成與執行期：[packages/pug-attrs/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-attrs/index.js)、[packages/pug-code-gen/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-code-gen/index.js)、[packages/pug-runtime/index.js](file:///d:/pug-rust/raw/compiler/packages/pug-runtime/index.js)、[packages/pug-runtime/wrap.js](file:///d:/pug-rust/raw/compiler/packages/pug-runtime/wrap.js)、[packages/pug-runtime/build.js](file:///d:/pug-rust/raw/compiler/packages/pug-runtime/build.js)、[packages/pug-runtime/prepublish.js](file:///d:/pug-rust/raw/compiler/packages/pug-runtime/prepublish.js)
- 錯誤格式：[packages/pug-error/src/index.ts](file:///d:/pug-rust/raw/compiler/packages/pug-error/src/index.ts)
