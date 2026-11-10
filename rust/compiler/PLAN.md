# Pug Rust Compiler 轉換規劃 (`rust/compiler`)

> 本文件為 `d:/pug-rust/raw/compiler` 轉換至 `d:/pug-rust/rust/compiler` 的工程規格與實施藍圖，保留模組對照、Rust 核心與 NAPI 分離設計，以及測試驅動移植（Test-Driven Porting）流程。
>
> 本版整合 Step 3 的前置能力、作用域分析邊界與階段驗收修訂，並同步調整相關的基準、NAPI、錯誤傳遞、Filters、Runtime 及 Step 2／4／5 銜接條文。
>
> 既有核取方塊沿用原文件進度紀錄；本次文件修訂不代表重新執行過原版或 Rust 測試。新增工作維持未勾選。

## 目標與相容範圍

以 **Rust + Oxc** 實作 Pug 編譯核心，提供與固定本機來源快照 `raw/compiler` 相容的 Node.js API。

第一階段固定使用 **Oxc**，不同時維護 Oxc／SWC 雙後端。

Oxc 的角色是 JavaScript 解析與語意分析，不是 Pug Parser、JavaScript Runtime，也不是自動可用的 `constantinople` 或 `with` 替代實作。

### 本機 `raw/compiler` 基準資料

以下版本、測試工具與序列化設定沿用原文件紀錄。正式相容基準以 `compat/baseline.json` 指定的來源快照、檔案雜湊、lockfile 與實際解析依賴為準。

**唯一比較對象是固定的本機 `raw/compiler` 來源快照。各 `package.json` 的版本名稱僅作識別，不推定其行為等同 npm 同版本或官方同名 tag。**

原文件記錄本機 `d:/pug-rust/raw/compiler` 為 Yarn v1 Monorepo，具備 `yarn.lock`。

#### 核心套件版本紀錄

| 套件 | 原文件記錄版本 |
|---|---|
| `pug` | `2.0.4`，含 `lib/index.js` 與 `register.js` |
| `pug-lexer` | `4.1.0` |
| `pug-strip-comments` | `1.0.4` |
| `pug-parser` | `5.0.1` |
| `pug-walk` | `1.1.8` |
| `pug-load` | `2.0.12` |
| `pug-filters` | `3.1.1` |
| `pug-linker` | `3.0.6` |
| `pug-attrs` | `2.0.4` |
| `pug-code-gen` | `2.0.2` |
| `pug-runtime` | `2.0.5` |
| `pug-error` | `1.3.3` |

#### 內嵌 JS 與相關依賴宣告

| 依賴 | 原文件記錄的宣告範圍 |
|---|---|
| `character-parser` | `^4.0.0` |
| `is-expression` | `^4.0.0` |
| `constantinople` | `^4.0.1` |
| `with` | `^7.0.0` |
| `doctypes` | `^1.1.0` |
| `void-elements` | `^3.1.0` |
| `js-stringify` | `^1.0.2` |

以上含 `^` 的內容是依賴宣告範圍，不是實際鎖定版本。

`compat/baseline.json` 必須區分並記錄：

- 來源 commit，或可識別來源內容的檔案雜湊。
- `yarn.lock` 雜湊。
- 各相關依賴的宣告範圍、實際解析版本與載入路徑。
- Rust、Oxc、NAPI-RS、Node 與目標平台版本。
- 原版測試與產物生成工具的版本及設定。

差異測試不得意外載入另一份 npm Pug，或以不同依賴版本替代本機來源快照。

#### 原版測試與快照序列化規則

以下設定依原文件所記錄的 `raw/compiler/package.json`：

- 測試執行器：`jest@^26.0.1`。
- 執行前先跑 `yarn build`，觸發 `pug-runtime/prepublish.js` 生成：
  - `lib/dependencies.js`
  - `lib/internals.js`
  - `lib/sources.js`
- Snapshot Serializers：
  1. `scripts/filename-serializer.js`：統一跨平台路徑斜線並移除專案根目錄前綴。
  2. `scripts/prettier-javascript-serializer.js`：對包含 `function ` 的生成 JS 字串，使用 `prettier@1.19.1` 與 `{ parser: 'babel' }` 格式化後再比對。
  3. `scripts/buffer-serializer.js`：序列化 Buffer 物件。

實際執行版本與規則仍須與固定來源快照一致，不因進入下一個開發階段而更新工具或重新生成預期快照。

### 相容性分層驗收標準

| 層級 | 驗收範圍 |
|---|---|
| 語言及輸出 | 語法接受／拒絕、HTML 字串、空白、escaping、屬性順序、控制流程 |
| 執行語意 | locals、globals、self、函式、getter、原型、Mixin、例外及可觀察副作用 |
| 公開 API | 函式簽章、同步／callback 行為、預設選項、dependencies、cache、filters、runtime、`register.js` |
| 擴充介面 | 明列支援的 plugin hooks、lex／parse 擴充、read／resolve／generateCode 替代介面 |
| 內部套件 | Token／AST JSON 與各套件 API；只有明列的部分才宣稱相容 |
| 產物文字 | `compileClient` 與 Codegen 分兩層驗收：① 經固定 Prettier／Babel parser 格式化後的快照；② 未格式化原始輸出與 `pug-runtime/build` 內嵌字串 |

不得使用「支援全部語法」代替外掛、選項、錯誤與副作用相容驗收。

未支援項目必須列出，不可靜默忽略。

執行語意、格式化快照與原始 JS 字串是不同驗收結果；其中一項通過，不代表其他項目通過。

安全修補造成的必要差異依本文件的安全政策獨立記錄，不以複製已知漏洞作為相容條件。

---

## 一、現有架構與編譯管線

### 1. 核心資料流

```text
Node.js 公開 API
正規化各入口選項，但不序列化 render locals
    ↓
同步 NAPI 呼叫 + 編譯用 Host 介面
回呼留在呼叫端所屬 Node 環境的 JS 執行緒
    ↓
pug_compiler 協調 Loader 與 parse adapter
對入口及每個 Pug 模板依賴執行：
    preLex → Lexer → postLex
    → 路徑 Token 補副檔名
      （由 parse adapter 依基準規則處理）
    → StripComments → preParse → Parser → postParse → preLoad
    → resolve / read → 遞迴處理 include / extends
    ↓
postLoad
    ↓
preFilters → Filters → postFilters
    ↓
preLink → Linker → postLink
    ↓
preCodeGen
    ↓
CodeGen
包含 attrs、必要常數處理、JS scope／locals 相容轉換
    ↓
postCodeGen
    ↓
{ body, dependencies }
    ├─ compileClient 系列：
    │   回傳 JS 原始碼／追蹤依賴的產物
    └─ compile / render 系列：
        Node 包裝函式 → 原始 locals → HTML
```

精確的 hook 順序、參數、呼叫次數、資料可變性與例外處理，依固定本機基準驗收。

`pug_load` 負責載入與遞迴；path token 的副檔名補齊由 `pug_compiler` 提供的 parse adapter 處理，不直接加入獨立 Loader 或 Parser 的行為。

`RawInclude` 與一般 Pug 模板依賴依基準採不同處理路徑，不將原始 bytes 一律送入 Lexer／Parser。

`pug_runtime` 提供 JavaScript helpers；函式建構與呼叫由 Node 包裝層處理。Rust 編譯核心不內建 JavaScript 執行引擎。

### 2. 內嵌 JavaScript：`pug_js` 內部分工

```text
pug_js/
├── scan.rs
│   # 字串、註解、regex、template literal、括號與 Pug 邊界
│   # 對應 character-parser
├── expression.rs
│   # Oxc 表達式解析、完整消耗檢查與語法錯誤對應
│   # 對應 is-expression
├── constant.rs
│   # 與基準 constantinople 相容的常數分類與求值
├── scope.rs
│   # 對齊基準輸入上下文的自由變數／作用域分析
└── locals.rs
    # 與基準 with 套件相容的包裝、綁定與 return 處理
```

#### 邊界規則

Pug 屬性區域不等於一段完整 JavaScript。

不能以逗號直接分割屬性，不能遇到第一個右括號就終止，也不能把每段 unbuffered code 都當成獨立完整 JS 程式驗證。

#### 語法模式

以基準 Pug 的可接受語法與解析設定為契約。

Oxc 支援更多語法，不代表相容模式就應開啟 TypeScript、JSX 或 module 語法。

對控制流程片段建立必要的解析上下文，並保存回原始 Pug 的位置映射；若增加虛擬函式或區塊，不得忽略它對作用域分析的影響。

#### 常數求值

區分以下結果：

- 已知常數。
- 非常數。
- 本實作尚不支援。
- 語法或求值錯誤。

filter 選項需要在編譯期取得值，不能一律延後到 render。

對未納入原始 JS 字串相容要求的最佳化，可以採保守策略；但已承諾字串相容的案例，必須實作基準所需的常數判定、求值與輸出合併行為。

分階段完成：

- Step 3B：已納入最小 Codegen 驗收案例所需的常數能力。
- Step 4：filter 選項的編譯期求值契約。
- Step 5：完整 `constantinople` 相容範圍。

#### locals 轉換

不能將所有自由變數直接改寫為 `locals.name`。

必須對照基準驗證：

- 屬性存在性與原型鏈。
- 全域名稱回退。
- getter 次數、順序與讀取時點。
- `this`、`arguments` 與 `return`。
- 暫存變數碰撞。
- 賦值對區域變數及原始 locals 的影響。

Oxc 提供分析資料；名稱排除、排序、綁定與 Pug 的相容包裝仍須自行實作。

Scope 分析對象必須對齊基準實際交給 `with` 的 JS body、object expression 與 exclude 清單，不能直接以最終 render function 的作用域結果替代。

### 3. 編譯宿主與外掛

#### Host Trait 抽象

以不依賴 NAPI 的 Rust `CompilerHost` trait，抽象：

- 讀檔 `read`。
- 路徑解析 `resolve`。
- 過濾器 `filter`。
- 各階段 plugin hooks。

`pug_napi` 提供 Node 宿主 adapter；純 Rust 使用者可提供原生檔案系統與其他宿主實作。

#### 階段精確性

不能只在最外層包一個 `compileBody()`，再於編譯完成後補跑所有外掛。

相關呼叫須發生在正確階段與正確依賴檔案上，特別是遞迴載入期間的：

```text
preLex
postLex
preParse
postParse
preLoad
resolve
read
```

#### 同執行緒同步回呼

相容版編譯、渲染與 callback 入口，保持基準的同步行為與回呼時點，不改成 Promise。

所有同步編譯入口與 JS callbacks，必須在呼叫端所屬 `napi_env` 的 JavaScript 執行緒執行，不限定為整個 Node 行程的主執行緒。

使用 `worker_threads` 時，各 Worker 必須使用自己的 Node 環境；不得跨環境共用 `Env`、JS handles 或 callbacks。

NAPI-RS 的具體同步呼叫介面，依 Step 0 已鎖定的版本選定，不預先將特定版本的 `JsFunction::call` 寫死為唯一介面。

不得在同步編譯路徑中，將需要目前 JS 環境回呼的工作移到其他執行緒，再同步等待只能由目前被阻塞 JS 執行緒完成的工作。

JS hook／filter 內重入呼叫 `pug.compile`／`pug.render` 時，必須安全運作。

#### Lexer／Parser 內部擴充 Plugins

對透過 `plugin.lex`／`plugin.parse` 擴充內部方法的 plugins，需另外定義狀態、`this` 與資料可變性相容層。

支援 `preLex`／`postParse`，不等於支援完整的 lex／parse 擴充介面。

---

## 二、`raw/compiler/packages` 與 `rust/compiler` 對照表

保留與原版套件對應的 crate 拆分，作為逐套件對照測試的移植邊界。

表內版本沿用原文件的識別資訊，實際行為以固定來源快照為準。

| 原版套件 | Rust Crate | 核心職責與修訂要求 |
|---|---|---|
| 共用資料結構 | `pug_ast` | Token、AST、來源資訊；為相容 JSON 設置明確 DTO／轉換層，保留缺欄位與 `null` 的差異 |
| `character-parser`／`is-expression`／`constantinople`／`with` | `pug_js` | 掃描、解析、常數、作用域與 locals 轉換；固定 Oxc，不能僅靠 Parser 取代全部功能 |
| `pug-error` (`1.3.3`) | `pug_error` | PUG 錯誤碼、訊息、檔案、行列、來源上下文與 `toJSON()`；JS Error 類型／屬性由 adapter 保留 |
| `pug-lexer` (`4.1.0`) | `pug_lexer` | 詞法狀態機、縮排、插值、JS 邊界與來源正規化 |
| `pug-strip-comments` (`1.0.4`) | `pug_strip_comments` | 預設移除 unbuffered `//-`、保留 buffered `//`；依 `stripUnbuffered`／`stripBuffered` 控制 |
| `pug-parser` (`5.0.1`) | `pug_parser` | Pug AST，含 `lib/inline-tags.js` 規則；覆蓋完整節點清單與 Parser 擴充契約 |
| `pug-walk` (`1.1.8`) | `pug_walk` | before／after、停止子樹、parents、合法位置的 replace 陣列展開與 includeDependencies |
| `pug-load` (`2.0.12`) | `pug_load` | read／resolve、遞迴載入、RawInclude、原始 bytes、路徑驗證與依賴記錄 |
| `pug-filters` (`3.1.1`) | `pug_filters` | 編譯期常數選項、巢狀／include filters、filterOptions、filterAliases、自訂 filter／JSTransformer 橋接 |
| `pug-linker` (`3.0.6`) | `pug_linker` | include、yield、extends、block replace／prepend／append、繼承中的 Mixin 定義保留 |
| `pug-attrs` (`2.0.4`) | `pug_attrs` | 靜態／動態屬性 Codegen、escape、class／style／布林與屬性合併 |
| `pug-code-gen` (`2.0.2`) | `pug_code_gen` | JS render function、控制流程、Mixin 函式／呼叫、locals 包裝、debug 與格式選項 |
| `pug-runtime` (`2.0.5`) | `pug_runtime` | JS helpers 的單一邏輯來源；提供相容的內嵌函式片段、依賴展開與 `build(fns)` |
| `pug` (`2.0.4`) | `pug_compiler` + `pug_napi` + `index.js` | Host-aware 編譯協調、同步 NAPI、公開 API、函式包裝、cache、callback 與 register 相容 |

### 補充邊界

#### Mixin

Linker 整合定義在繼承中的位置；Codegen 產生執行期函式與呼叫。

不得無條件靜態展開，需支援基準中的遞迴、動態名稱、`block`、`attributes` 與參數語意。

#### Filters

不要假設 `:markdown` 或 `:cdata` 都是 Rust 核心內建功能。

依本機基準分別處理：

| 路徑 | 相容要求 |
|---|---|
| 一般自訂 JS filter | 依基準直接呼叫 filter 函式，不一律改成 `filter.render()` |
| RawInclude 自訂 filter | 依基準確認是否具有 `.renderBuffer` 分支及其回退規則 |
| JSTransformer | 依其橋接流程處理 `render`／`renderFile` 等介面，不與自訂 filter 混為一談 |

Node 宿主橋接既有套件。

純 Rust 宿主遇到未提供的 filter，必須明確回報；錯誤碼、包裝階段與來源位置依基準契約處理。

#### 來源座標

內部 UTF-8 byte span、對外 JS 相容欄位及行列資訊分開保存或轉換。

依基準核對 UTF-16 欄位計數與 1-based 行列規則，不將 byte offset 直接當成公開 column。

測試英文、中文、非 BMP 字元、BOM、CRLF、tab，以及 include 檔案位置。

#### 序列化

JSON 快照可驗證資料形狀，但不保證以下資料往返相容：

```text
函式
Buffer
自訂欄位
物件身分
原型
```

外掛介面的轉換限制必須明確記錄，不可靜默丟失資料。

#### `pug_runtime` 單一來源機制

`runtime/index.js` 維持為 helper 程式邏輯的唯一來源，`wrap.js` 與其他包裝邏輯按基準保存。

原版 Runtime 的生成流程、壓縮工具版本與選項必須固定，不以另一套 minifier 的語意等價輸出冒充字串一致。

採用以下流程：

```text
固定 Runtime 來源、生成腳本、工具版本與選項
    ↓
執行明確的生成命令
    ↓
產生 helper sources、dependencies、internals 衍生資料
    ↓
核對固定基準的生成結果
    ↓
Rust 載入或嵌入衍生資料
    ↓
pug_runtime::build(fns)
依基準展開依賴、排序與拼接
```

衍生資料可納入版本控制，但必須標記為自動產物，不允許手動修改。

Rust 建置可嵌入或校驗已生成資料；不得在未固定工具鏈的情況下，於 `build.rs` 任意重新壓縮並期望字串相同。

CI 應驗證重新生成結果沒有漂移。

要求原始 JS 文字一致的相容模式，使用對標基準的專用輸出器；Oxc 用於解析與分析，不任意重新列印整份程式。

---

## 三、`rust/compiler` 目錄結構

```text
d:\pug-rust\rust\compiler\
├── PLAN.md
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── package.json
├── yarn.lock                   # 或選定套件管理器的 lockfile
├── index.js                    # 對標本機 pug 公開 API
├── register.js                 # 對標本機 pug/register.js
├── index.d.ts
├── runtime/                    # JS helpers、包裝與生成資料
├── compat/
│   ├── baseline.json           # 來源雜湊、實際依賴與測試環境
│   ├── matrix.md               # API、語法、外掛及已知差異
│   └── expected-differences.json
├── tests/
│   ├── differential/           # 原版與 Rust 的逐階段差異 runner
│   ├── fixtures/               # 新增高風險邊界案例
│   ├── integration/            # Node、client、外掛及框架整合
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

純 Rust CLI／Linter 可引用核心 crates，不代表已能無 Node 執行任意 Pug JavaScript 或任意 npm filter。

CLI 應分清楚輸出 JS、受限制靜態 HTML，以及需要 JavaScript 執行宿主的模式。

---

## 四、Node.js API 對接設計

### 1. Rust／NAPI 介面

主要編譯產物維持：

```text
compileBody(source, compileOptions, host)
    -> { body, dependencies }
```

`debug sources` 在編譯期間由 `CompilerHost`／`pug_compiler` 收集並用於 `includeSources` Codegen，不強制增加公開回傳欄位。

保留以下逐階段介面，作為內部測試與明列的進階子入口：

```text
lex
stripComments
parse
walk
load
link
generateCode
```

`tests/differential` 可使用這些入口與原版套件做單階段 A/B 對照。

公開 client API 的預設值與 module 包裝集中在 Node 相容層，避免 Rust 與 JS 分別實作兩套不一致的入口行為。

### 2. 公開 API 與匯出入口

依 `compat/baseline.json` 指定的本機來源快照，核對參數、預設值、回傳值與屬性：

```text
compile / compileFile
compileClient / compileFileClient
compileClientWithDependenciesTracked
render / renderFile / __express
cache / filters / runtime / name
require('pug/register')
```

`compile()` 先取得 JS 原始碼，再由 Node 依基準的 inline runtime 或外部 runtime 路徑建構函式，並掛上 `.dependencies`。

原文件記錄的建構路徑包括：

```js
// inlineRuntimeFunctions: true 的基準建構方式
new Function('', parsed.body + ';return template;')();

// 外部 runtime 路徑
runtimeWrap(parsed.body);
```

具體入口差異以固定本機基準測試為準。

`render()` 將原始 JavaScript `options` 作為 locals 傳入 render function。

**不得將 locals 轉成 JSON，或複製成 Rust Map 後再還原。**

### 3. 必要選項契約

以下細節沿用原文件紀錄，實作時由固定本機基準驗收。

| 項目 | 規格要求 |
|---|---|
| `pretty` | 相容 boolean 與自訂縮排字串；原文件記錄 `true` 轉為兩個空格；非法值與安全限制另按基準及安全政策驗收 |
| `compileDebug` | 保留入口差異：`compile` 使用 `options.compileDebug !== false`；其 `includeSources` 依 `options.compileDebug === true`；`compileClient` 傳遞原選項；`__express` 的 production 預設另測 |
| `inlineRuntimeFunctions` | `compile` 預設使用外部 runtime；`compileClient` 依 `options.inlineRuntimeFunctions !== false` 決定預設 inline 行為 |
| `name`／`module` | client 函式名稱、預設 `template`、識別字驗證、runtime 引用與 `module.exports` 包裝 |
| `filename`／`basedir` | 依相容的 Node path 規則解析，不任意 canonicalize 改寫可觀察路徑 |
| `self`／`globals` | 配合 scope 與 locals 轉換，分別驗證是否繞過 `with`、名稱排除與取值行為 |
| `filters`／`filterOptions`／`filterAliases`／`plugins` | 保留全域與入口設定的合併規則；JS 物件與函式留在 Node 宿主，於正確階段同步呼叫 |
| `cache` | 保留公開 cache 物件的讀寫及清空；依基準核對 client key 與缺少 filename 時的錯誤 |
| `debug` | 按基準向 `console.error` 輸出編譯後函式與格式，包括適用的 ANSI 色碼 |
| `includeSources` | 與各 API 入口的 debug 推導規則一起驗證，不在共用層過早統一預設值 |

原文件記錄的 cache 行為包括：

```text
compileFileClient：
    path + ':client'

render 開啟 cache 但缺少 filename：
    the "filename" option is required for caching
```

公開 API cache 與內部 AST／增量編譯快取必須分離，不因新增內部快取而改變對外行為。

### 4. 同步、錯誤與安全

#### 同步與 callback

相容入口不改成 Promise。

`render`／`renderFile` 的 callback 參數處理、第二個參數為 function 時的分流、成功參數、`try/catch` 與錯誤呼叫時點，依基準測試。

#### 錯誤傳遞

Rust 編譯錯誤需轉換成具相容欄位的 JS Error。

依基準核對：

```text
code
msg
line
column
filename
src
toJSON
```

不得讓 Rust panic 越過 FFI 邊界。

NAPI 邊界應保留 JavaScript 拋出值及其身分，不任意轉成字串或泛用錯誤。

各編譯階段若在基準中具有攔截、加註或重新包裝行為，仍須在相同階段重現。

因此，例外驗收應區分：

- NAPI 邊界是否保留原始拋出值。
- 編譯階段是否按照基準加註或包裝。
- callback API 是否按照基準接收或拋出錯誤。

不得將所有情況都簡化成「永遠原樣傳遞」或「永遠包裝成 Pug Error」。

#### 安全政策

模板、filter、plugin 可以執行程式碼，必須視為可信輸入。

Rust 實作不會自動提供 sandbox。

編譯選項同樣屬於信任邊界，不得把未經限制的外部輸入直接作為可影響 Codegen 的設定。

**相容性不包含複製已知安全漏洞。**

安全修補造成的輸入拒絕、錯誤或產物差異，必須記錄於 `expected-differences.json`，附原因與回歸測試。

不得為通過舊快照而撤除安全修補。

---

## 五、分階段開發與測試驗證

以下既有 `[x]` 沿用原文件的進度紀錄，不代表本次文件修訂重新執行或驗證過測試。

### Step 0：鎖定相容基準及驗收分類

- [x] 記錄 `raw/compiler` 的套件版本、檔案雜湊與 `yarn.lock`，寫入 `compat/baseline.json`。
- [x] 固定 Rust toolchain、Oxc、NAPI-RS、Node 版本與目標平台設定。
- [x] 在 `raw/compiler` 執行原版建置與測試（`yarn build && yarn test`），確認原版 fixture、快照與錯誤基準在本機可 100% 重現。
- [x] 建立差異測試 runner（`tests/differential`）與 `compat/matrix.md`；每個案例標記通過、失敗、不支援或已核准差異。
- [x] 實作與原版 Jest serializers 等價的比對工具，含路徑正規化、Prettier Babel 格式化與原始字串比對。

實際解析依賴與載入路徑應符合前述基準契約；不得只以套件版本名稱或宣告範圍代替來源識別。

### Step 1：Workspace、基礎型別與最小端到端路徑

- [x] 建立 `rust/compiler/Cargo.toml` 與各子 crates 骨架，實作 `pug_ast`／`pug_error` 與來源座標轉換契約，並通過 `pug-error` 測試。
- [x] 同時建立 `pug_napi`、`rust/compiler/index.js`、`register.js` 與 `runtime/` 接線。
- [x] 用只支援最小語法的 Lexer／Parser／Codegen，跑通 `pug.render('p Hello') -> '<p>Hello</p>'`。
- [x] 加入最小動態輸出與函式型 locals，例如 `pug.render('p= fn()', { fn: () => 'ok' })`，驗證 locals 不經 JSON 序列化。
- [x] 建立主執行緒同步 Host callback adapter 原型；驗證 `preLex`／自訂 filter 回傳值、錯誤傳遞、同步時序與重入呼叫行為。
- [x] 驗證 Windows MSVC `.node` 原生模組建置與載入。

上述主執行緒原型是原文件記錄的測試範圍，不表示 Worker 環境已經驗證。正式同步規範仍以呼叫端所屬 `napi_env` 為邊界。

### Step 2：Lexer、註解與 JS 邊界

- [x] 完成 `pug_js` 的 `scan.rs`，對應 `character-parser`，以及 `expression.rs`，對應 `is-expression`。
- [x] 移植 `pug_lexer`、`pug_strip_comments`，核對 buffered／unbuffered 註解預設值與選項。
- [x] 執行 `raw/compiler/packages/pug-lexer/test/` 與 `pug-strip-comments/test/` 的 Token 快照與錯誤案例；加入 regex、template literal、巢狀括號及 Unicode 案例。
- [x] 所有新增詞法支援，均加入 Token／錯誤差異測試。
- [x] Step 1 已支援的語法，持續執行 Node render 回歸測試。
- [x] 需要 Step 3 或後續階段才能執行的語法，先完成詞法驗收；不將完整渲染列為 Step 2 的完成條件。

失敗、跳過、不支援與已核准差異必須分開記錄，不得略過案例後宣稱整套測試全部通過。

Step 2 可辨識 `include`、`extends`、Mixin、Filters 等語法並產生 Token，但不負責完成讀檔、連結或執行。

### Step 3：Parser、Walk、控制流程與 locals

本階段拆成：

```text
3A：Parser／Walk
    ↓
3B：最小 Codegen
    ↓
3C：Scope／locals
```

分段實作與驗收，保留現有 crate 分工，不新增另一套編譯架構。

**相容基準沿用 Step 0 固定的本機 `raw/compiler` 快照與實際解析依賴。所有新增項目均為待辦，不代表已完成實作或通過測試。**

3A → 3B → 3C 是主要實作順序，不代表 3B 必須全部驗收通過，才能開始 3C。

依賴完整 locals 轉換的 3B 案例，在接上 3C 後共同驗收。

#### 開始條件與階段邊界

- [x] 確認 Step 2 的 Token、註解處理與錯誤測試已有可重現結果；失敗、跳過、不支援及已核准差異分開記錄。
- [x] 確認 Token 類型、欄位、缺欄位與 `null`、位置資訊及 `eos` 等契約穩定；Parser 不自行修補不符合契約的 Lexer 輸出。
- [x] 重跑 Step 1 的 Node → NAPI → Rust → JS render 路徑，確認原生模組與函式型 locals 仍正常，locals 不經 JSON 序列化。
- [x] 沿用 `compat/baseline.json` 與既有 serializers，不在本階段順便升級基準依賴或自動更新預期快照。

Step 2 若有已隔離的未完成案例，可先開發不受影響的 Parser／Walk 功能，但必須記錄依賴關係；受阻案例不得列為通過。

本階段不以完成 Loader、Filters、Linker 或全部 Codegen 選項為前提。

#### Step 3A：Parser 與 AST Walk

**目標：先確認 AST 資料與走訪行為，再擴充執行能力。**

- [x] 盤點本機 `raw/compiler/packages/pug-parser/test/`、`pug-walk/test/` 的案例與節點種類，建立對應測試清單；擴充外掛案例單獨標記。
- [x] 移植 `pug_parser`，含 `lib/inline-tags.js` 規則，覆蓋基準的節點、巢狀關係、屬性、插值、JS code、控制流程與語法錯誤。
- [x] 為 `include`、`extends`、`block`、Mixin 與 Filters 建立相容 AST；本階段的 Parser 不執行讀檔、模板連結、Mixin 展開或 filter。
- [x] 保留 JS 片段與來源資訊，不在 Parser 中任意改寫表達式、執行常數求值，或把 unbuffered code 當成獨立完整 JS 程式驗證。
- [x] 分開內部 AST 與對外相容 DTO；比對缺欄位、`null`、空陣列、預設值、節點順序與來源位置，不輸出額外內部欄位。
- [x] 移植 `pug_walk`，核對 `before`／`after` 順序、`before` 回傳 `false` 時的停止範圍，以及是否呼叫對應 `after`；預期行為取自本機基準。
- [x] 核對 `parents` 的內容、最近父節點的位置與 callback 執行時點，保存每次 callback 的觀察紀錄。
- [x] 核對單節點與陣列 `replace` 的合法位置、展開順序、非法替換錯誤，以及替換後節點是否再次走訪；不能只比較最後 AST。
- [x] 核對 `includeDependencies` 對既有依賴 AST 的走訪規則；Walker 不自行載入檔案。
- [x] 保留 Parser 擴充介面邊界。完整 Node plugin 擴充相容仍依 Step 6 驗收；相關未完成案例須明列，不得略過後宣稱整套 Parser 測試全數通過。

**測試分成兩層：**

```text
單階段差異測試：

相同內容、獨立建立的 Tokens
    ├─ 原版 Parser
    └─ Rust Parser
          ↓
      AST 或錯誤比對

相同內容、獨立建立的 AST
    ├─ 原版 Walk
    └─ Rust Walk
          ↓
      callback 紀錄、結果與錯誤比對


整條前端管線測試：

同一份 Pug
    ├─ 原版 Lexer → StripComments → Parser
    └─ Rust Lexer → StripComments → Parser
                                      ↓
                                AST 或錯誤比對
```

兩邊使用相同內容、互不共享可變狀態的輸入。

保留中文、emoji、BOM、CRLF、tab 等位置案例，並依 Step 0 的規則比對。

不得藉由刪除位置欄位或重新排序節點隱藏差異。

#### Step 3B：最小 Attrs／Codegen 與控制流程

**目標：以明確限定的功能範圍，讓 Parser 產物接回既有 Node 執行路徑。**

##### 支援範圍與執行路徑

- [x] 在 `compat/matrix.md` 列出本階段支援的節點與編譯選項，區分「可解析」「可走訪」「可產生 JS」「可渲染」四種能力。
- [x] 建立最小 `pug_attrs`／`pug_code_gen`：一般標籤、文字、靜態 ID／Class／字串屬性、buffered／unbuffered 輸出與插值；escaping 依既有 Runtime 契約處理。
- [x] 加入用來驗證控制流程的 `if`／`else`／`unless`、`each`（含替代區塊）、`while` 與 unbuffered JS code；依本機基準核對其接受、拒絕與輸出行為。
- [x] 將 JS 控制流程片段與其 Pug 子節點組成必要的函式／區塊結構，不逐行獨立編譯，並保留回原始 Pug 的位置資訊。
- [x] 保持編譯與渲染分離：Rust 回傳 JS，Node 建構函式並傳入原始 locals；不得在編譯時提前執行模板中的動態 JS。

##### 本階段必要前置能力

- [x] 對本階段已納入驗收的案例，提前實作生成 JS 一致性所需的最小能力，包括常數判定／求值、輸出片段合併、Runtime 引用，以及所選入口預設的 debug Codegen。
- [x] 明列哪些案例依賴 `pug_js::constant`，哪些依賴 Runtime helper、debug 包裝或 3C 的 locals 轉換，不將缺少前置能力的案例標記為通過。
- [x] 上述能力僅覆蓋 Step 3 已承諾的案例；filter 選項求值仍於 Step 4 完成，完整常數相容範圍、Codegen 選項及組合仍於 Step 5 收斂。

##### 驗收與未支援行為

- [x] 測試 fixture 明確記錄入口、選項與 locals 建立方式，同時保留公開 API 預設選項的回歸案例；不得暗中關閉 `compileDebug` 或更改 Runtime 模式來通過測試。
- [x] 對尚未支援的節點或選項明確回報，標示為本實作未完成；不得忽略節點、輸出空字串、偽裝成基準語法錯誤，或回退原版 Pug 後算成 Rust 通過。
- [x] 每個案例分開記錄執行語意、格式化快照及原始 JS 字串的驗收結果；尚未通過的項目不得以其他項目通過替代。
- [x] 已納入本階段的產物契約沿用 Step 0 的兩層字串比對；不能以 HTML 相同掩蓋未核准的 Codegen 字串差異。

3B 可先以模板內自行宣告變數、常值與既有最小整合案例驗證。

需要完整自由變數綁定、`with` 包裝或其產物文字的案例，接到 3C 後共同驗收；中間階段結果不宣稱為完整 Codegen 相容。

不得為了先跑通 3B，新增直接將識別字替換成 `locals.xxx` 的暫時實作。

完整 `pug-attrs`／`pug-code-gen` 測試集與全部選項仍在 Step 5 收斂；本階段只驗收明列範圍，不宣稱整套 Codegen 已完成。

#### Step 3C：Oxc Scope 與 locals 相容轉換

**目標：對齊基準傳入 `with` 的程式片段與分析上下文，保留指定基準的名稱綁定及執行語意。**

```text
Pug AST
    ↓
依基準產生交給 with 的輸入
JS body + object expression + exclude 清單
    ↓
依相同語意建立 Oxc 解析／分析上下文
必要時使用有明確映射規則的虛擬包裝
    ↓
Oxc Parser + Semantic Analysis
    ↓
依基準辨識、排除及排序自由變數
    ↓
locals 相容包裝、綁定與控制流程處理
    ↓
依基準完成其餘 Codegen 與 render function 包裝
    ↓
最終 JS → Node 執行
    ↓
執行語意、副作用、錯誤階段及產物文字比對
```

##### 分析邊界與診斷契約

- [x] Scope 分析的輸入、解析模式與排除名稱，必須對齊固定基準實際傳入 `with` 的 JS body、object expression 與 exclude 清單，不直接以最終 render function 的作用域結果替代。
- [x] 若為了讓 Oxc 解析程式片段而加入虛擬函式或區塊，必須處理它對名稱綁定、`arguments`、`this`、`return` 與來源位置的影響。
- [x] Oxc 的未解析引用清單作為分析資料，不直接視為基準 `with` 的最終自由變數清單；名稱排除、排序、綁定及包裝仍依基準實作。
- [x] 在 `pug_js::scope.rs` 整合 Oxc Parser／Semantic Analysis，檢查診斷結果、宣告與引用解析；不能僅以取得 AST 判定合法。
- [x] Oxc 診斷須對照基準的接受／拒絕行為及錯誤發生階段處理，不因額外分析而任意提前拒絕輸入。
- [x] `self` 等繞過 `with` 的路徑分開驗證，不套用原本不應執行的 locals 分析或轉換。
- [x] 分開驗證 locals 轉換前的分析結果、轉換後的 JS，以及最終函式建構／執行結果。

##### locals 轉換實作

- [x] 在 `pug_js::locals.rs` 對照已鎖定的 `with` 實作完成轉換，不直接依賴 Oxc 預設行為，也不以字串替換或 `locals.xxx` 全域改寫代替。
- [x] 按基準處理局部宣告、生成程式使用的內部名稱、`globals` 排除與 `self` 分支；先完成本階段語意測試所需範圍，完整選項組合在 Step 5 收斂。
- [x] 核對自由變數輸出與 locals 讀取的順序，不依賴 Rust 無序集合的迭代順序，避免改變 getter 副作用或產物文字。
- [x] 處理函式／區塊邊界、外層與巢狀 `return`、`this`、`arguments` 及暫存名稱碰撞；結果以本機基準建立預期值。
- [x] 新增的作用域與控制流程案例，同時執行直接 JS 轉換測試及 Pug 端到端測試，避免只有其中一層通過。
- [x] Oxc 主要用於解析與分析；要求原始 JS 文字一致的路徑，不任意重新列印整份程式。所有文字差異依既有相容契約獨立追蹤。

##### 必要測試矩陣

| 測試組 | 應驗證內容 |
|---|---|
| 宣告與遮蔽 | `var`／`let`／`const`、函式參數、解構、閉包及同名變數；接受／拒絕以基準語法能力為準 |
| locals 取值 | 自有屬性、原型鏈、不存在的屬性、存在但值為 `undefined`、全域名稱回退 |
| 讀取副作用 | getter 呼叫次數、順序、讀取時點與拋出例外，不只比較最終 HTML |
| 賦值 | `=`、`+=`、`++` 對區域值與原始 locals 的影響 |
| 執行上下文 | `this`、`arguments`、外層 `return`、巢狀函式的 `return` 與丟出例外 |
| 分析邊界 | 原始 JS body、虛擬包裝及最終 render function 的差異；排除人工包裝造成的錯誤綁定 |
| 生成名稱 | 使用者名稱與內部暫存名稱、Runtime 名稱或參數衝突 |
| 控制流程與錯誤 | 多層條件／迴圈、JS 片段上下文、無效語法，以及錯誤發生於哪個階段 |
| 分支與診斷 | `self`、`globals`、Oxc 額外診斷與基準接受／拒絕行為 |

具有 getter、函式、原型或可變狀態的 locals，應由同一 fixture factory 分別建立兩份等價實例。

不得以 JSON 複製，也不得先執行原版後，把已受副作用影響的同一物件交給 Rust 產物。

錯誤驗收不只比較最終訊息，也要記錄錯誤發生於分析、Codegen、函式建構或實際執行階段。

#### 與 Step 4～6 的責任分界

| 功能 | Step 3 必須完成 | 後續完成事項 |
|---|---|---|
| `include`／`extends` | AST、錯誤與既有依賴 AST 的 Walk 規則 | Step 4 讀檔、遞迴載入與連結 |
| `block`／`append`／`prepend` | 節點與關係 | Step 4 繼承合併 |
| Filters | 節點、屬性與走訪 | Step 4 編譯期求值及執行 |
| Mixin | 定義／呼叫 AST 與 Walk | Step 4 接上案例所需的最小執行能力；Step 5 補齊 Codegen |
| 常數求值 | 3B 已承諾 Codegen 案例所需的最小能力 | Step 4 filter 選項；Step 5 完整相容範圍 |
| attrs／Runtime／debug | 本階段已承諾案例與預設入口所需能力 | Step 5 完整選項與組合 |
| Scope／locals | 已明列的分析邊界、綁定與副作用測試 | Step 5 配合新增節點／選項擴充回歸 |
| Parser plugins | 介面邊界與受影響案例清單 | Step 6 完整 Node 擴充相容驗收 |

#### Step 3 完成條件與交付結果

- [x] 3A：交付 Parser AST／錯誤差異結果、Walk callback 日誌與替換／停止／依賴走訪結果。
- [x] 3B：交付支援範圍清單、必要前置能力清單、最小渲染案例，以及 HTML、回傳值、錯誤與生成 JS 差異結果。
- [x] 3C：交付 Scope／locals 測試矩陣結果，包含分析邊界、原始 locals 變化、getter 日誌、控制流程語意與錯誤階段。
- [x] 重跑 Step 1～2 回歸測試，確認既有端到端路徑、Token、註解與來源位置沒有退步。
- [x] 更新 `compat/matrix.md`，報告總數、通過、失敗、跳過、不支援及已核准差異；範圍內不得有未處理或未核准的差異。
- [x] 延後項目逐一連到 Step 4、5 或 6，不計入本階段通過數；新增排除項目不得用來掩蓋原已承諾功能的失敗。
- [x] 依賴 3C 的 3B 案例已完成聯合驗收，不只保留中間產物或暫時繞過結果。

**只有 AST／Walk 通過時，僅能標記 3A 完成。**

**3A、3B、3C 的已承諾範圍與回歸驗收都通過，才可標記整個 Step 3 完成。**

### Step 4：Loader、Filters、Linker 與最小 Mixin 整合

**目標：完成模板依賴載入、編譯期 Filters、模板連結，並接回既有 Node 渲染路徑。**

沿用 Step 0 固定的本機 `raw/compiler` 快照、實際解析依賴及測試工具，不另建編譯架構。

本階段拆成：

1. 4A：Loader、parse adapter 與依賴追蹤。
2. 4B：常數選項求值與 Filters。
3. 4C：Linker 與模板繼承。
4. 4D：最小 Mixin 執行與整合驗收。

以上是主要實作順序；各模組可先獨立驗證。
整合管線必須維持 Loader → Filters → Linker → Codegen。

#### 開始條件

- [x] 核對 Step 3A／3B／3C 的實際測試結果與 `compat/matrix.md`，確認已承諾的 Parser、Walk、最小 Codegen 與 Scope／locals 範圍已有可重現結果；不能只依 PLAN 的勾選判斷完成。
- [x] 確認 Step 1～3 相關回歸仍通過，包含 Node → NAPI → Rust → JS render、函式型 locals、來源位置及既有控制流程。
- [x] 核對 `compat/baseline.json` 的來源、lockfile、依賴載入路徑與工具版本；沿用既有 serializers，不更新基準依賴或預期快照。
- [x] 盤點本機 `pug-load`、`pug-filters`、`pug-linker` 測試及相關 Pug 整合案例，建立本階段測試清單，標示所需的 Host、Codegen、Runtime 與 Mixin 能力。

前置核對通過後，直接開始 4A。

若發現缺口，先補齊受影響工作所需的前置能力；不受影響的項目可以繼續。
受阻案例須記錄原因，不得列為通過，也不得移除原已承諾的驗收範圍。

#### 本階段共用要求：CompilerHost 與 Node 橋接

- [x] 沿用既有 `CompilerHost`，完成本階段需要的同步 `read`、`resolve`、`filter` 與階段 hooks；不能全部延到 Step 6。
- [x] 依前文編譯管線，在入口與各 Pug 依賴的正確階段呼叫 hooks；核對參數、次數、順序、資料修改及例外處理，不能編譯完成後才補跑。
- [x] JS callbacks 在呼叫端所屬 `napi_env` 的 JS 執行緒同步執行，驗證 hook／filter 重入編譯時，外層與內層的來源、依賴及錯誤狀態不互相污染。
- [x] NAPI 邊界保留 JS 拋出值及必要身分；各編譯階段的加註或包裝依基準重現，不一律轉成字串或泛用錯誤。
- [x] 保留本階段所需的 Buffer、JS 函式與值型別，不透過一般 JSON 往返而靜默改變資料；render locals 持續直接交給 Node 執行。

完整 `plugin.lex`／`plugin.parse` 擴充、其餘 replacement hooks 及跨平台／Worker 完整驗收仍在 Step 6。
本階段已使用到的介面，必須在本階段驗收。

#### Step 4A：Loader、parse adapter 與依賴追蹤

**目標：先驗證載入後的 AST、來源與依賴，再接上 Filters／Linker。**

- [x] 實作 `pug_load`，核對相對路徑、`filename`、`basedir`、巢狀 include／extends，以及自訂 `read`／`resolve` 的參數、回傳值與錯誤。
- [x] 在 `pug_compiler` 的 parse adapter 中，依基準處理 path token 副檔名補齊；不加入單獨 Loader／Parser 入口。
- [x] 每個 Pug 依賴依前文管線完成 Lexer、StripComments、Parser 與相關 hooks，保留各檔案的來源及位置資訊。
- [x] 分開處理 Pug 模板與 `RawInclude`。原始 bytes 必須保留；文字解碼與 Buffer 轉換時點依基準，不將所有讀檔結果先轉成字串，也不將 RawInclude 一律送入 Lexer／Parser。
- [x] 核對 `dependencies` 的路徑表示、順序與重複行為，以及對應的 `read`／`resolve`／hook 日誌；不自行排序、去重或加快取而改變可觀察行為。
- [x] 驗證缺少必要路徑選項、檔案不存在、讀取失敗及依賴內語法錯誤，核對錯誤階段、檔名、行列與來源上下文。

至少涵蓋：單層及多層依賴、重複引用同一檔案、自訂記憶體讀取、RawInclude，以及含中文／非 BMP 字元與 CRLF 的依賴檔案。

**4A 驗收：載入後 AST、原始 bytes、dependencies、呼叫日誌與錯誤差異結果。**
本階段不以完整 Codegen 通過為前提。

#### Step 4B：常數選項求值與 Filters

**目標：在編譯期正確取得 filter 選項，並依基準呼叫對應的 filter 路徑。**

- [x] 擴充既有 `pug_js::constant`，完成本階段 filter 案例所需的常數判定與求值，區分已知常數、非常數、尚未支援及語法／求值錯誤。
- [x] filter 選項必須在基準要求的編譯階段求值；不得延到 render，也不得把尚未支援的常數偽裝成非常數。
- [x] 實作 `pug_filters`，核對 `filters`、`filterOptions`、`filterAliases` 的查找、合併優先序、值型別及 filename 傳遞方式。
- [x] 驗證一般 filter、巢狀 filter 與 include filter 的處理順序、輸入內容、輸出節點及編譯期呼叫次數。
- [x] 分別實作與驗證一般自訂 JS filter 函式、RawInclude 的 `.renderBuffer` 分支與回退，以及 JSTransformer 橋接；實際存在的 `render`／`renderFile` 等路徑與呼叫方式，以固定本機來源為準。
- [x] 驗證未知 filter、無效選項、filter 拋出例外及異常回傳值，核對錯誤包裝階段與來源位置。

自訂 filter 與 JSTransformer 不共用一套假定的呼叫規則。
純 Rust 宿主未提供所需 filter 時，必須明確回報。

**4B 驗收：處理後 AST、選項值、filter 呼叫日誌、Buffer 內容與錯誤差異結果。**
完整 `constantinople` 相容範圍仍在 Step 5 收斂。

#### Step 4C：Linker 與模板繼承

**目標：完成載入及 Filters 後，正確整合模板結構。**

- [x] 實作 `pug_linker`，核對 include 內容整合、include block／yield，以及巢狀結構的處理。
- [x] 實作 extends、多層繼承及 block replace／prepend／append，驗證合併順序、節點位置與基準的非法用法錯誤。
- [x] 保留繼承過程中的 Mixin 定義及其正確位置；Linker 不負責把 Mixin 呼叫無條件靜態展開。
- [x] 確認 Filters 在 Linker 前執行，透過混合 include／extends／filters 的案例驗證實際處理順序。
- [x] 保留連結後節點的來源資訊，使後續 Codegen 與執行錯誤能依基準指出原始模板位置。

**4C 驗收：連結後 AST、節點順序、來源資訊與錯誤差異結果。**

先使用等價且互不共享可變狀態的輸入 AST 做單階段比較，再接整合管線。
Codegen 尚未支援造成的失敗，須與 Linker 差異分開記錄。

#### Step 4D：最小 Mixin 執行與整合驗收

**目標：讓本階段承諾的模板組合能經既有 Node 路徑實際渲染。**

- [x] 在既有 `pug_code_gen` 接上本階段案例所需的 Mixin 函式定義、呼叫、參數傳遞與 block 傳入，維持執行期函式語意。
- [x] 完成原 Step 4 已承諾的遞迴 Mixin、動態名稱、繼承中的定義位置與 block 傳入案例，不因拆分子階段而全部延到 Step 5。
- [x] 將新增 Mixin 產物接入既有 Scope／locals 轉換，驗證名稱遮蔽、暫存名稱碰撞、locals 取值及必要副作用。
- [x] 補齊上述案例實際需要的 Runtime helper、常數處理與 debug／來源接線，沿用固定 Runtime 生成機制。
- [x] 透過既有公開編譯／渲染入口驗證完整管線，同時保留預設選項案例；不得暗中關閉 debug、改用其他 Runtime 模式或回退原版 Pug 來通過測試。

完整 Mixin 邊界、attributes、全部 Codegen／Runtime 能力及選項組合仍在 Step 5 收斂。
但本階段承諾案例所需的能力，必須在本階段完成。

#### 測試與比較方式

| 層級 | 必須比較 |
|---|---|
| Loader | 載入後 AST、bytes、路徑、dependencies、read／resolve 日誌及錯誤 |
| Filters | 選項求值、呼叫參數與順序、Buffer、處理後 AST 及錯誤 |
| Linker | 連結後 AST、節點順序、繼承合併、Mixin 定義位置及錯誤 |
| Node 整合 | 同步時序、重入、JS 拋出值與階段包裝、hook 資料修改 |
| 渲染 | HTML 精確字串、回傳值、locals 變化、getter 日誌及執行例外 |
| JS 產物 | 固定格式化快照與原始 JS 字串，分別記錄結果 |

原版與 Rust 使用相同內容、獨立建立的 AST、Host、callbacks 與 locals。
含函式、Buffer、getter、原型或可變狀態的資料，由 fixture factory 分別建立，不以 JSON 複製。

錯誤須區分發生於載入、選項求值、filter 執行、連結、Codegen、函式建構或 render。
HTML 相同不能取代 AST、呼叫日誌、錯誤或 JS 產物的驗收。

#### Step 4 完成條件

- [x] 交付 4A／4B／4C 的單階段差異結果，以及 4D 的 Node 整合與渲染結果。
- [x] 本階段已承諾範圍內沒有未處理或未核准的差異；必要的 Host／NAPI 接線已完成。
- [x] 重跑 Step 1～3 既有回歸，確認 Token、AST、Walk、控制流程、Scope／locals 與 Node 執行路徑沒有退步。
- [x] 更新 `compat/matrix.md`，列出測試命令、總數、通過、失敗、跳過、不支援與已核准差異。
- [x] 延後項目逐一標明 Step 5／6 的承接位置，不計入本階段通過數。
- [x] 實際驗收完成後才更新核取方塊；不得自動改寫基準快照或把原版回退結果計入 Rust 通過率。

只有 Loader／Filters／Linker 的 AST 測試通過時，只能標記對應子階段完成。
本階段承諾的 Mixin、Node 整合與回歸驗收都通過，才可標記整個 Step 4 完成。

### Step 5：補齊屬性、Codegen、Runtime 與選項

- [ ] 完成 `pug_attrs`：class 陣列／物件、style 物件、布林屬性、`toJSON`、escape、同名屬性合併與輸出順序，通過 `pug-attrs/test/`。
- [ ] 在 Step 3／4 的最小能力上補齊 `pug_code_gen`，包含 doctype、void-elements、Mixin、pretty、compileDebug、self、globals、includeSources 與 inlineRuntimeFunctions。
- [ ] 完成各編譯選項的組合測試，不只測試單一選項或單一 API 入口。
- [ ] 完成 `pug_runtime` 的 helper 範圍、依賴展開與產物字串驗收，分別確認 inline 與外部 Runtime 行為。
- [ ] 完整對齊 `constantinople` 相容範圍；對已知常數、非常數、非法及尚未支援的運算清楚區分。
- [ ] 對新增節點及選項擴充 Scope／locals 回歸測試，確認 Step 3 語意沒有退步。
- [ ] 按 Step 0 規則執行 `pug-code-gen` 格式化快照、原始字串與執行差異測試。

### Step 6：API／擴充整合與發行驗收

- [ ] 補齊全部已宣告 API、選項、cache、callback、`__express`、`register.js` 與 client 產物行為。
- [ ] 驗證 plugins 的階段 hooks、replacement hooks、lex／parse 擴充及資料往返限制；實際支援介面以本機基準與相容矩陣為準。
- [ ] 執行 `raw/compiler/packages/pug/test/` 完整整合測試套件，更新 `compat/matrix.md`。
- [ ] 驗證宣告支援的 Node 環境與平台；Worker 環境的 addon 載入、同步 callbacks 與隔離行為，須以獨立案例確認，不以主執行緒原型結果代替。
- [ ] 驗證安全修補及其核准差異，不因字串快照不一致而移除必要修補。
- [ ] 分開量測冷啟動、編譯、渲染、NAPI／序列化、外掛與記憶體效能，在此基礎上評估增量快取與最佳化。

### 驗收分類總表

| 測試類別 | 主要比較內容 |
|---|---|
| Token／AST | 欄位、缺省值、位置、節點順序；只正規化明確批准的檔案路徑差異 |
| HTML | 精確字串比對，不用 DOM 等價掩蓋空白或屬性順序差異 |
| 執行語意 | 回傳值、locals 副作用、getter 次數與順序、控制流程及 JS 例外 |
| Scope／locals | 分析輸入邊界、自由變數、排除及排序、虛擬包裝影響與綁定結果 |
| Filters／Plugins | 呼叫階段、參數、同步順序、read 結果、Buffer、錯誤與資料修改 |
| API | 簽章、同步／callback、選項預設值、函式屬性、dependencies、cache 與 register |
| 錯誤 | 類型、code、message、檔案、行列、來源上下文與發生階段；stack 的平台差異另列 |
| JS 產物 | 可解析／執行、client／module mode、Prettier 快照、原始字串及 inline Runtime 依賴展開 |
| 安全差異 | 修補原因、受影響輸入、核准紀錄與回歸測試 |
| 效能 | 在已驗收的相容範圍內，分開量測速度與記憶體收益 |

不得自動更新基準快照來消除 Rust 實作差異。

不得靜默回退原版 Pug，並將回退結果計入 Rust 通過率。

已核准差異、未支援案例與真正通過的案例，必須分開統計。

---

## 本機核對參考路徑 (`d:/pug-rust/raw/compiler`)

以下路徑供實作與驗收時核對。列出路徑不代表本次文件修訂已讀取本機檔案。

### Workspace 與測試設定

```text
raw/compiler/package.json
raw/compiler/yarn.lock
```

### 快照正規化腳本

```text
raw/compiler/scripts/filename-serializer.js
raw/compiler/scripts/prettier-javascript-serializer.js
raw/compiler/scripts/buffer-serializer.js
```

### 主入口與管線

```text
raw/compiler/packages/pug/lib/index.js
raw/compiler/packages/pug/register.js
```

### 詞法與註解

```text
raw/compiler/packages/pug-lexer/index.js
raw/compiler/packages/pug-strip-comments/index.js
```

### 語法與走訪

```text
raw/compiler/packages/pug-parser/index.js
raw/compiler/packages/pug-parser/lib/inline-tags.js
raw/compiler/packages/pug-walk/index.js
```

### 載入、過濾與連結

```text
raw/compiler/packages/pug-load/index.js
raw/compiler/packages/pug-filters/lib/handle-filters.js
raw/compiler/packages/pug-filters/lib/run-filter.js
raw/compiler/packages/pug-linker/index.js
```

### 屬性、程式碼生成與執行期

```text
raw/compiler/packages/pug-attrs/index.js
raw/compiler/packages/pug-code-gen/index.js
raw/compiler/packages/pug-runtime/index.js
raw/compiler/packages/pug-runtime/wrap.js
raw/compiler/packages/pug-runtime/build.js
raw/compiler/packages/pug-runtime/prepublish.js
```

### 錯誤格式

```text
raw/compiler/packages/pug-error/src/index.ts
```

### 外部 JS 相依套件

`character-parser`、`is-expression`、`constantinople`、`with` 及其他相關依賴，使用 `compat/baseline.json` 記錄的實際解析版本與載入路徑。

不得自行以網路上的最新版本或同名 npm 套件代替固定本機基準。