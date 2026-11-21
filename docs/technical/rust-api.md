# ISMD Rust API 與型別參考

本文件以目前工作樹的 `ismd/crates/` 原始碼為依據，記錄 Rust 型別、函式／方法的 Arguments 與 Return；不把設計規範中的名稱當作已實作 API。Rust 使用 `struct`、`enum`、`trait` 與 `impl`，沒有原生 `class` 語法。JavaScript 匯出的名稱、選項正規化與例子請搭配 [JavaScript API](javascript-api.md)。

## 閱讀方式與覆蓋範圍

- 主表逐檔涵蓋 15 個 crate、29 個 `src/*.rs`：282 筆 callable 宣告、128 筆 `pub struct/enum/trait` 宣告，以及 5 個 C ABI 函式指標別名。數量按來源宣告計算，包含 `profile` feature 的兩個互斥版本。
- Callable 包含 production `pub fn`（含 `const`、`unsafe`）、公開 trait 的方法、公開型別明寫的 trait 實作；不展開 `derive`／`#[napi]` 自動產生的程式碼。
- 私有 helper 與 `pub(crate)` 僅在「重要內部流程」選列。`#[cfg(test)]` 模組、`ismd_compiler/tests/generic_syntax.rs` 測試函式不屬於可供產品呼叫的 API，未逐一列入。
- 每個來源連結含符號起始行號。Arguments 保留 `self`、借用、生命周期、`mut` 與參數原名；Return 保留原宣告型別。原碼省略回傳宣告者標為 Rust unit `()`。`Self` 指所屬 `impl`／trait 的型別。
- `Value` 為來源匯入的 `serde_json::Value`；`ismd_napi` 中的單參數 `Result<T>` 來自 `napi::bindgen_prelude`。Rust 輸出 DTO 欄位採 snake_case，不能直接當成 JavaScript 呼叫端的大小寫契約。
- 表內「模組內 pub」表示宣告有 `pub`，但可能在私有模組內；`ast.rs::typed_named_block` 是內部 serde helper，非外部 crate API。`profile.rs::imp` 的選定版本則經檔尾 `pub use` 對外重匯出。
- 型別表列公開具名欄位／enum variants；私有欄位不列。沒有公開欄位不代表該 struct 不保存狀態。Tuple struct 的欄位直接保留在宣告中。

## 核心入口與生命週期

### 單次編譯

`compile_body(source, options, host)` 使用預設全域 store；`compile_body_with_store` 接受呼叫者指定的 store。回傳 `CompileResult { body, dependencies }`，其中 `body` 是 JavaScript 模板函式原始碼，並非已渲染的 HTML。原碼會先處理本次指定的原生外掛；只有未指定原生外掛時才嘗試 linked-view 路徑，不適用時走可變 AST 流程。[compile_body](../../crates/ismd_compiler/src/lib.rs#L671)、[compile_body_with_store](../../crates/ismd_compiler/src/lib.rs#L679)

可變流程的主要階段為 lex → strip comments → parse → load dependencies → transform → link → codegen，並穿插 `CompilerHost` hooks。`DefaultHost` 使用預設檔案載入行為，關閉自訂 resolve/read/lex-parse flags，且允許 linked view。自訂 `CompilerHost` trait 預設的 flags 較保守，`supports_linked_view()` 預設 `false`。[CompilerHost](../../crates/ismd_compiler/src/lib.rs#L66)、[DefaultHost](../../crates/ismd_compiler/src/lib.rs#L190)

### 持續性 session 與快取

`CompilerSession::new` 建立 `Arc<TemplateStore>`；`with_store` 可共享指定 store。`compile_entries*` 先註冊 entry，再同步回傳 `Vec<BatchEntryOutput>`；每個 entry 透過 `ok/error/plain_error` 回報個別結果。這些函式沒有回傳 `Future` 或 `Promise`。[CompilerSession](../../crates/ismd_compiler/src/session.rs#L67)、[compile_entries](../../crates/ismd_compiler/src/session.rs#L382)

`update_files_incremental` 以來源雜湊與長度判斷變化，更新 store，並沿 dependency graph 計算受影響 entry；同一路徑原先註冊的 inline source 會清除，讓後續編譯讀取更新後內容。`compile_affected_with_mode` 取走 pending 清單並進行編譯。`remove_files` 另會清除對應註冊 entry 與 store 路徑。[update_files_incremental](../../crates/ismd_compiler/src/session.rs#L128)、[compile_affected_with_mode](../../crates/ismd_compiler/src/session.rs#L338)、[remove_files](../../crates/ismd_compiler/src/session.rs#L192)

`dispose()` 在 Rust 層實際呼叫 `clear()`，清除 store、註冊 entry、索引與 pending 清單；此 Rust struct 沒有「已永久關閉」旗標。不能將此函式描述為 Rust 物件之後必定拒絕使用。[dispose](../../crates/ismd_compiler/src/session.rs#L262)、[clear](../../crates/ismd_compiler/src/session.rs#L362)

`TemplateStore::new()` 信任已快取的來源，直到明確 invalidate/update；`hash_validated()` 關閉該模式，供全域 store 重新讀取磁碟與雜湊檢查。`load_or_read_disk` 回傳 tuple 的 `bool` 表示是否直接命中 source cache；`update_virtual_source_checked` 的 `bool` 表示內容是否變更。兩者的布林語意不同。[建構模式](../../crates/ismd_compiler/src/store.rs#L189)、[load_or_read_disk](../../crates/ismd_compiler/src/store.rs#L338)、[update_virtual_source_checked](../../crates/ismd_compiler/src/store.rs#L404)

`ParallelMode::Auto(usize)` 在 entry 數達門檻時使用 Rayon；預設門檻常數為 `8`。`ForceParallel` 在數量大於 1 時平行，`ForceSerial` 一律序列。這是批次內的執行策略，不是背景排程服務。[ParallelMode](../../crates/ismd_compiler/src/session.rs#L17)、[compile_batch_with_mode](../../crates/ismd_compiler/src/session.rs#L405)

### 錯誤與外掛邊界

核心多數函式回傳 `Result<T, IsmdError>`。`IsmdError::new` 為未帶前綴的錯誤碼加上 `ISMD:`；`host_exception*` 使用 `JS_HOST_EXCEPTION` 並保留一般宿主錯誤資訊。N-API 層另透過 outcome DTO 區分模板錯誤與一般錯誤；不要把 Rust `Result` 說成 HTTP status。[IsmdError](../../crates/ismd_error/src/lib.rs#L28)、[NapiCompileOutcome](../../crates/ismd_napi/src/lib.rs#L76)

`ismd_plugin_abi` 定義 C ABI v1、字串 view、由外掛釋放的 buffer 與 transform callback。`IsmdPluginBuffer::Drop` 呼叫 `release`；`from_string/from_vec` 轉移配置所有權並登記 free callback。`IsmdPluginStringView::as_str` 是 unsafe 借用，呼叫者必須維持原始記憶體與生命周期。[IsmdPluginBuffer](../../crates/ismd_plugin_abi/src/lib.rs#L50)、[as_str](../../crates/ismd_plugin_abi/src/lib.rs#L38)

`IsmdSyntaxKind::IncludePrefix` 雖然有 enum 值，原碼註解明示是未來 generic resource hook 的保留值；不能據此宣稱完整實作了該 hook。[IsmdSyntaxKind](../../crates/ismd_plugin_abi/src/lib.rs#L136)

## 重要內部流程（選列，非對外 API）

| 實際符號與來源 | Arguments → Return／用途 |
|---|---|
| [Session::lex_and_parse](../../crates/ismd_compiler/src/lib.rs#L403) | `(&mut self, src: &str, filename: Option<&str>) -> Result<BlockNode, IsmdError>`；協調單檔 parse 與快取。`Session<'a, H>` 是單次編譯內部狀態，與公開 `CompilerSession` 不同。 |
| [try_compile_linked_view](../../crates/ismd_compiler/src/linked_view.rs#L78) | `<H: CompilerHost>(source: &str, options: &CompileOptions, host: &mut H, store: &TemplateStore) -> Result<Option<CompileResult>, IsmdError>`；`Ok(None)` 代表應回退可變 AST 流程。 |
| [ViewArena / LinkedView](../../crates/ismd_compiler/src/linked_view.rs#L28) | `ViewArena` 保存 `Arc<ParsedTemplate>` 等來源；`LinkedView<'ast>` 保存 named-block segments、include／raw include 與 mixin 引用，實作 `LinkedAstOverlay`。不是對外 store API。 |
| [Parser::parse_expr](../../crates/ismd_parser/src/lib.rs#L401) | `(&mut self) -> Result<Node, IsmdError>`；依 token 派送個別語法 parser；公開入口為 `parse*` 與 `Parser::parse_root`。 |
| [CodeGenerator::visit_node](../../crates/ismd_code_gen/src/lib.rs#L416) | `(&mut self, node: &'a Node) -> Result<(), IsmdError>`；派送各種 AST 節點。 |
| [CodeGenerator::finish](../../crates/ismd_code_gen/src/lib.rs#L1162) | `(mut self) -> Result<String, IsmdError>`；收斂 codegen 結果；公開呼叫端使用 `generate_code*`。 |
| [with_reusable_allocator](../../crates/ismd_js/src/lib.rs#L29) | `<R>(f: impl FnOnce(&Allocator) -> R) -> R`；借用 thread-local Oxc allocator，呼叫後 reset，重入時另建 allocator。 |
| [with_validated_expression](../../crates/ismd_js/src/expression.rs#L135) | `<R>(src: &str, options: ExpressionOptions, on_expr: impl FnOnce(&Expression<'_>) -> R) -> Result<R, ExpressionError>`；驗證與解析後在 allocator 有效期間呼叫 callback。 |
| [LBlock / LNamedBlock / LNode](../../crates/ismd_linker/src/lib.rs#L75) | linker 的私有中介表示；對外入口只有 `link(ast)`。 |
| [NodeHostAdapter](../../crates/ismd_napi/src/lib.rs#L483) | N-API 私有宿主 adapter，將 JS callbacks 接到 `CompilerHost`。本文件的 N-API 表是 Rust 簽章，不等同 JavaScript class 宣告。 |

未在此次檢查的 Rust production 宣告中找到名為 `Compiler`、`ExpressionStore`、`CompileBundle` 或 `BlockOverlay` 的公開型別；現有的相近職責由上述函式、`ExpressionAnalysis`、`TemplateStore` 與 `LinkedView` 分擔，不能寫成這些名稱已存在。

## 逐 crate／逐檔宣告表

以下以來源順序保留同名方法的所屬 `impl`，方法名稱連結直接指向宣告。泛型與 `where` 限制放在最後一欄，避免把約束誤當作回傳型別。

### `ismd_compiler/src/dag.rs`

來源：[ismd/crates/ismd_compiler/src/dag.rs](../../crates/ismd_compiler/src/dag.rs)

正向 dependency edges 與反向 dependents；`collect_affected` 供增量失效計算使用。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct DependencyEdge](../../crates/ismd_compiler/src/dag.rs#L7) | `target: TemplateId; kind: DependencyKind` |
| [pub struct DependencyGraphStats](../../crates/ismd_compiler/src/dag.rs#L13) | `nodes: usize; edges: usize` |
| [pub struct DependencyGraph](../../crates/ismd_compiler/src/dag.rs#L25) | 無公開具名欄位。 |


#### `impl Default for DependencyGraph`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default](../../crates/ismd_compiler/src/dag.rs#L30) | `（無）` | `Self` | `顯式 trait impl` |

#### `impl DependencyGraph`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_compiler/src/dag.rs#L36) | `（無）` | `Self` | — |
| [set_dependencies](../../crates/ismd_compiler/src/dag.rs#L43) | `&self, parent: TemplateId, edges: Vec<DependencyEdge>` | `()` | — |
| [direct_dependency_edges](../../crates/ismd_compiler/src/dag.rs#L77) | `&self, id: TemplateId` | `Vec<DependencyEdge>` | — |
| [direct_dependencies](../../crates/ismd_compiler/src/dag.rs#L82) | `&self, id: TemplateId` | `Vec<TemplateId>` | — |
| [direct_dependents](../../crates/ismd_compiler/src/dag.rs#L96) | `&self, id: TemplateId` | `Vec<TemplateId>` | — |
| [collect_affected](../../crates/ismd_compiler/src/dag.rs#L108) | `&self, changed: &[TemplateId]` | `Vec<TemplateId>` | — |
| [remove_template](../../crates/ismd_compiler/src/dag.rs#L137) | `&self, id: TemplateId` | `()` | — |
| [clear](../../crates/ismd_compiler/src/dag.rs#L161) | `&self` | `()` | — |
| [stats](../../crates/ismd_compiler/src/dag.rs#L167) | `&self` | `DependencyGraphStats` | — |

### `ismd_compiler/src/lib.rs`

來源：[ismd/crates/ismd_compiler/src/lib.rs](../../crates/ismd_compiler/src/lib.rs)

編譯協調入口與宿主 hooks。`CompileOptions` 的 Rust `Default` 由 derive 產生；JavaScript 預設值另由 wrapper/N-API 處理，不應混用。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct CompileOptions](../../crates/ismd_compiler/src/lib.rs#L36) | `filename: Option<String>; basedir: Option<String>; pretty: Option<String>; compile_debug: bool; doctype: Option<String>; inline_runtime_functions: bool; globals: Vec<String>; use_self: bool; include_sources: bool; template_name: String; lex_plugin_methods: Vec<String>; native_plugins: Vec<String>; generic_syntax: Vec<ismd_lexer::GenericSyntaxRule>` |
| [pub struct CompileResult](../../crates/ismd_compiler/src/lib.rs#L53) | `body: String; dependencies: Vec<String>` |
| [pub struct FileCtx<'a>](../../crates/ismd_compiler/src/lib.rs#L60) | `filename: Option<&'a str>; src: &'a str` |
| [pub trait CompilerHost](../../crates/ismd_compiler/src/lib.rs#L66) | 見下方 trait 方法表。 |
| [pub struct DefaultHost](../../crates/ismd_compiler/src/lib.rs#L190) | 無公開具名欄位。 |


#### `pub trait CompilerHost`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [pre_lex](../../crates/ismd_compiler/src/lib.rs#L67) | `&mut self, source: String, filename: Option<&str>` | `Result<String, IsmdError>` | `trait 方法` |
| [pre_lex_cow](../../crates/ismd_compiler/src/lib.rs#L72) | `&mut self, source: &'s str, filename: Option<&str>` | `Result<Cow<'s, str>, IsmdError>` | `trait 方法`<br>`<'s>` |
| [post_lex](../../crates/ismd_compiler/src/lib.rs#L80) | `&mut self, tokens: Vec<Token>, ctx: &FileCtx` | `Result<Vec<Token>, IsmdError>` | `trait 方法` |
| [pre_parse](../../crates/ismd_compiler/src/lib.rs#L85) | `&mut self, tokens: Vec<Token>, ctx: &FileCtx` | `Result<Vec<Token>, IsmdError>` | `trait 方法` |
| [post_parse](../../crates/ismd_compiler/src/lib.rs#L90) | `&mut self, ast: BlockNode, ctx: &FileCtx` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [pre_load](../../crates/ismd_compiler/src/lib.rs#L95) | `&mut self, ast: BlockNode, ctx: &FileCtx` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [load_file](../../crates/ismd_compiler/src/lib.rs#L105) | `&mut self, path: &str, source: Option<&str>, node_filename: Option<&str>, node_line: usize, options: &CompileOptions` | `Result<LoadedFile, IsmdError>` | `trait 方法` |
| [post_load](../../crates/ismd_compiler/src/lib.rs#L128) | `&mut self, ast: BlockNode` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [pre_transform](../../crates/ismd_compiler/src/lib.rs#L132) | `&mut self, ast: BlockNode` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [post_transform](../../crates/ismd_compiler/src/lib.rs#L136) | `&mut self, ast: BlockNode` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [pre_link](../../crates/ismd_compiler/src/lib.rs#L140) | `&mut self, ast: BlockNode` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [post_link](../../crates/ismd_compiler/src/lib.rs#L144) | `&mut self, ast: BlockNode` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [pre_code_gen](../../crates/ismd_compiler/src/lib.rs#L148) | `&mut self, ast: BlockNode` | `Result<BlockNode, IsmdError>` | `trait 方法` |
| [custom_generate_code](../../crates/ismd_compiler/src/lib.rs#L152) | `&mut self, _ast: &BlockNode` | `Result<Option<String>, IsmdError>` | `trait 方法` |
| [post_code_gen](../../crates/ismd_compiler/src/lib.rs#L156) | `&mut self, js: String` | `Result<String, IsmdError>` | `trait 方法` |
| [warn](../../crates/ismd_compiler/src/lib.rs#L160) | `&mut self, msg: &str` | `()` | `trait 方法` |
| [call_lex_plugin](../../crates/ismd_compiler/src/lib.rs#L164) | `&mut self, method: &str, state: &mut LexerState` | `Result<bool, IsmdError>` | `trait 方法` |
| [has_custom_resolve](../../crates/ismd_compiler/src/lib.rs#L173) | `&self` | `bool` | `trait 方法` |
| [has_custom_read](../../crates/ismd_compiler/src/lib.rs#L177) | `&self` | `bool` | `trait 方法` |
| [has_lex_parse_hooks](../../crates/ismd_compiler/src/lib.rs#L181) | `&self` | `bool` | `trait 方法` |
| [supports_linked_view](../../crates/ismd_compiler/src/lib.rs#L185) | `&self` | `bool` | `trait 方法` |

#### `impl CompilerHost for DefaultHost`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [pre_lex_cow](../../crates/ismd_compiler/src/lib.rs#L192) | `&mut self, source: &'s str, _filename: Option<&str>` | `Result<Cow<'s, str>, IsmdError>` | `顯式 trait impl`<br>`<'s>` |
| [has_custom_resolve](../../crates/ismd_compiler/src/lib.rs#L200) | `&self` | `bool` | `顯式 trait impl` |
| [has_custom_read](../../crates/ismd_compiler/src/lib.rs#L204) | `&self` | `bool` | `顯式 trait impl` |
| [has_lex_parse_hooks](../../crates/ismd_compiler/src/lib.rs#L208) | `&self` | `bool` | `顯式 trait impl` |
| [supports_linked_view](../../crates/ismd_compiler/src/lib.rs#L212) | `&self` | `bool` | `顯式 trait impl` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default_resolve](../../crates/ismd_compiler/src/lib.rs#L314) | `filename: &str, source: Option<&str>, basedir: Option<&str>` | `Result<String, IsmdError>` | — |
| [compile_body](../../crates/ismd_compiler/src/lib.rs#L671) | `source: &str, options: &CompileOptions, host: &mut H` | `Result<CompileResult, IsmdError>` | `<H: CompilerHost>` |
| [compile_body_with_store](../../crates/ismd_compiler/src/lib.rs#L679) | `source: &str, options: &CompileOptions, host: &mut H, store: &TemplateStore` | `Result<CompileResult, IsmdError>` | `<H: CompilerHost>` |

### `ismd_compiler/src/linked_view.rs`

來源：[ismd/crates/ismd_compiler/src/linked_view.rs](../../crates/ismd_compiler/src/linked_view.rs)

本檔只有私有或 `pub(crate)` 宣告；重要入口已在前文列出，不屬於外部 crate 的公開 API。

### `ismd_compiler/src/plugin.rs`

來源：[ismd/crates/ismd_compiler/src/plugin.rs](../../crates/ismd_compiler/src/plugin.rs)

原生動態外掛的載入、選擇、指紋與 AST transform。`LoadedNativePlugin` 保持 library 存活。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct LoadedNativePlugin](../../crates/ismd_compiler/src/plugin.rs#L18) | `path: PathBuf; library: Library; descriptor: &'static IsmdPluginDescriptorV1; plugin_id: String; plugin_version: String; is_thread_safe: bool; mtime_ns: u128; file_len: u64` |
| [pub struct NativePluginManager](../../crates/ismd_compiler/src/plugin.rs#L59) | 無公開具名欄位。 |


#### `impl LoadedNativePlugin`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [fingerprint](../../crates/ismd_compiler/src/plugin.rs#L31) | `&self` | `u64` | — |

#### `impl NativePluginManager`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_compiler/src/plugin.rs#L68) | `（無）` | `Self` | — |
| [has_plugins](../../crates/ismd_compiler/src/plugin.rs#L72) | `&self` | `bool` | — |
| [syntax_rules](../../crates/ismd_compiler/src/plugin.rs#L76) | `&self` | `&[GenericSyntaxRule]` | — |
| [plugins](../../crates/ismd_compiler/src/plugin.rs#L80) | `&self` | `&[Arc<LoadedNativePlugin>]` | — |
| [load_plugin](../../crates/ismd_compiler/src/plugin.rs#L84) | `&mut self, path: &Path` | `Result<Arc<LoadedNativePlugin>, IsmdError>` | — |
| [reload_plugin](../../crates/ismd_compiler/src/plugin.rs#L226) | `&mut self, path: &Path` | `Result<Arc<LoadedNativePlugin>, IsmdError>` | — |
| [clear](../../crates/ismd_compiler/src/plugin.rs#L234) | `&mut self` | `()` | — |
| [try_select_plugins](../../crates/ismd_compiler/src/plugin.rs#L243) | `&self, paths: &[String]` | `Option<Self>` | — |
| [fingerprint_for_paths](../../crates/ismd_compiler/src/plugin.rs#L269) | `&self, paths: &[String]` | `u64` | — |
| [select_plugins](../../crates/ismd_compiler/src/plugin.rs#L283) | `&self, paths: &[String]` | `Self` | — |
| [transform_ast](../../crates/ismd_compiler/src/plugin.rs#L307) | `&self, ast: &mut BlockNode` | `Result<(), IsmdError>` | — |

### `ismd_compiler/src/session.rs`

來源：[ismd/crates/ismd_compiler/src/session.rs](../../crates/ismd_compiler/src/session.rs)

持續性 entry 註冊、增量失效與批次編譯；`BatchEntryOutput.body` 為 JS 原始碼。更新報告欄位記錄此次變更與受影響 entry ID。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub enum ParallelMode](../../crates/ismd_compiler/src/session.rs#L17) | `Auto(usize), ForceParallel, ForceSerial` |
| [pub struct BatchEntryInput](../../crates/ismd_compiler/src/session.rs#L40) | `id: String; filename: Option<String>; source: Option<String>; options: Option<CompileOptions>` |
| [pub struct BatchEntryOutput](../../crates/ismd_compiler/src/session.rs#L48) | `id: String; ok: bool; body: Option<String>; dependencies: Vec<String>; cache_hit: bool; error: Option<IsmdError>; plain_error: Option<String>; plain_error_code: Option<String>` |
| [pub struct IncrementalUpdateReport](../../crates/ismd_compiler/src/session.rs#L60) | `changed: bool; changed_files: Vec<String>; invalidated_templates: Vec<String>; affected_entries: Vec<String>` |
| [pub struct CompilerSession](../../crates/ismd_compiler/src/session.rs#L67) | 無公開具名欄位。 |


#### `impl Default for ParallelMode`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default](../../crates/ismd_compiler/src/session.rs#L24) | `（無）` | `Self` | `顯式 trait impl` |

#### `impl ParallelMode`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [should_parallelize](../../crates/ismd_compiler/src/session.rs#L30) | `self, len: usize` | `bool` | — |

#### `impl CompilerSession`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_compiler/src/session.rs#L76) | `default_options: CompileOptions` | `Self` | — |
| [with_store](../../crates/ismd_compiler/src/session.rs#L80) | `store: Arc<TemplateStore>, default_options: CompileOptions` | `Self` | — |
| [store](../../crates/ismd_compiler/src/session.rs#L90) | `&self` | `&Arc<TemplateStore>` | — |
| [default_options](../../crates/ismd_compiler/src/session.rs#L94) | `&self` | `&CompileOptions` | — |
| [register_entries](../../crates/ismd_compiler/src/session.rs#L98) | `&self, entries: &[BatchEntryInput]` | `()` | — |
| [update_files](../../crates/ismd_compiler/src/session.rs#L124) | `&self, files: &[(String, String)]` | `()` | — |
| [update_files_incremental](../../crates/ismd_compiler/src/session.rs#L128) | `&self, files: &[(String, String)]` | `IncrementalUpdateReport` | — |
| [invalidate_files](../../crates/ismd_compiler/src/session.rs#L173) | `&self, paths: &[String]` | `()` | — |
| [invalidate_files_incremental](../../crates/ismd_compiler/src/session.rs#L177) | `&self, paths: &[String]` | `IncrementalUpdateReport` | — |
| [remove_files](../../crates/ismd_compiler/src/session.rs#L192) | `&self, paths: &[String]` | `IncrementalUpdateReport` | — |
| [dispose](../../crates/ismd_compiler/src/session.rs#L262) | `&self` | `()` | — |
| [affected_entries](../../crates/ismd_compiler/src/session.rs#L323) | `&self` | `Vec<String>` | — |
| [compile_affected_with_mode](../../crates/ismd_compiler/src/session.rs#L338) | `&self, mode: ParallelMode` | `Vec<BatchEntryOutput>` | — |
| [clear](../../crates/ismd_compiler/src/session.rs#L362) | `&self` | `()` | — |
| [stats](../../crates/ismd_compiler/src/session.rs#L378) | `&self` | `TemplateStoreStats` | — |
| [compile_entries](../../crates/ismd_compiler/src/session.rs#L382) | `&self, entries: &[BatchEntryInput]` | `Vec<BatchEntryOutput>` | — |
| [compile_entries_with_mode](../../crates/ismd_compiler/src/session.rs#L387) | `&self, entries: &[BatchEntryInput], mode: ParallelMode` | `Vec<BatchEntryOutput>` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [compile_batch_with_store](../../crates/ismd_compiler/src/session.rs#L397) | `entries: &[BatchEntryInput], default_options: &CompileOptions, store: &TemplateStore` | `Vec<BatchEntryOutput>` | — |
| [compile_batch_with_mode](../../crates/ismd_compiler/src/session.rs#L405) | `entries: &[BatchEntryInput], default_options: &CompileOptions, store: &TemplateStore, mode: ParallelMode` | `Vec<BatchEntryOutput>` | — |

### `ismd_compiler/src/store.rs`

來源：[ismd/crates/ismd_compiler/src/store.rs](../../crates/ismd_compiler/src/store.rs)

記憶體來源、parse、resolve、編譯輸出快取與 plugin manager。`Arc` 表示共享所有權，不是資料庫持久化。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct TemplateId(pub u64)](../../crates/ismd_compiler/src/store.rs#L10) | 無公開具名欄位。 |
| [pub enum DependencyKind](../../crates/ismd_compiler/src/store.rs#L13) | `Extends, Include, RawInclude` |
| [pub struct DependencyRef](../../crates/ismd_compiler/src/store.rs#L20) | `kind: DependencyKind; raw_path: String; line: usize; column: Option<usize>; from_filename: Option<String>` |
| [pub struct DeclaredBlockMeta](../../crates/ismd_compiler/src/store.rs#L29) | `name: String; mode: String` |
| [pub enum CachedRaw](../../crates/ismd_compiler/src/store.rs#L35) | `Bytes(Arc<Vec<u8>>), Text(Arc<str>)` |
| [pub struct SourceEntry](../../crates/ismd_compiler/src/store.rs#L50) | `id: TemplateId; normalized_path: String; canonical_path: String; raw: CachedRaw; text: Arc<str>; byte_len: u64; content_hash: u64; version: u64` |
| [pub struct ParseKey](../../crates/ismd_compiler/src/store.rs#L68) | `normalized_path: String; filename: String; content_hash: u64; byte_len: u64; source_version: u64; lex_plugin_methods: Vec<String>; generic_syntax: Vec<ismd_lexer::GenericSyntaxRule>` |
| [pub struct ResolutionKey](../../crates/ismd_compiler/src/store.rs#L79) | `path: String; source: Option<String>; basedir: Option<String>` |
| [pub struct ParsedTemplate](../../crates/ismd_compiler/src/store.rs#L86) | `id: TemplateId; source_version: u64; content_hash: u64; filename: Arc<str>; ast: Arc<BlockNode>; direct_dependencies: Vec<DependencyRef>; declared_blocks: Vec<DeclaredBlockMeta>; has_extensions: bool; has_yield: bool; warnings: Vec<String>` |
| [pub struct CompiledOutputKey](../../crates/ismd_compiler/src/store.rs#L100) | `normalized_path: String; content_hash: u64; byte_len: u64; source_version: u64; options_hash: u64` |
| [pub struct CompiledOutputEntry](../../crates/ismd_compiler/src/store.rs#L109) | `body: Arc<str>; dependencies: Arc<Vec<String>>; dep_versions: Vec<(String, u64, u64)>` |
| [pub struct TemplateStoreStats](../../crates/ismd_compiler/src/store.rs#L116) | `sources: usize; parsed: usize; resolved: usize; outputs: usize; dag_nodes: usize; dag_edges: usize; source_hits: u64; source_misses: u64; parse_hits: u64; parse_misses: u64; output_cache_hits: u64; output_cache_misses: u64` |
| [pub struct TemplateStore](../../crates/ismd_compiler/src/store.rs#L159) | `plugins: RwLock<NativePluginManager>` |
| [pub struct AstMetadata](../../crates/ismd_compiler/src/store.rs#L676) | `dependencies: Vec<DependencyRef>; declared_blocks: Vec<DeclaredBlockMeta>; has_extensions: bool; has_yield: bool` |


#### `impl CachedRaw`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [to_raw_content](../../crates/ismd_compiler/src/store.rs#L41) | `&self` | `RawContent` | — |

#### `impl SourceEntry`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [to_raw_content](../../crates/ismd_compiler/src/store.rs#L62) | `&self` | `RawContent` | — |

#### `impl Default for TemplateStore`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default](../../crates/ismd_compiler/src/store.rs#L181) | `（無）` | `Self` | `顯式 trait impl` |

#### `impl TemplateStore`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_compiler/src/store.rs#L189) | `（無）` | `Self` | — |
| [hash_validated](../../crates/ismd_compiler/src/store.rs#L195) | `（無）` | `Self` | — |
| [trust_cached_sources](../../crates/ismd_compiler/src/store.rs#L223) | `&self` | `bool` | — |
| [dag](../../crates/ismd_compiler/src/store.rs#L228) | `&self` | `&DependencyGraph` | — |
| [id_for_path](../../crates/ismd_compiler/src/store.rs#L232) | `&self, path: &str` | `Option<TemplateId>` | — |
| [path_for_id](../../crates/ismd_compiler/src/store.rs#L241) | `&self, id: TemplateId` | `Option<String>` | — |
| [get_or_alloc_id](../../crates/ismd_compiler/src/store.rs#L249) | `&self, path: &str` | `TemplateId` | — |
| [get_cached_source](../../crates/ismd_compiler/src/store.rs#L272) | `&self, full_path: &str` | `Option<Arc<SourceEntry>>` | — |
| [peek_cached_source](../../crates/ismd_compiler/src/store.rs#L290) | `&self, full_path: &str` | `Option<Arc<SourceEntry>>` | — |
| [resolve_path](../../crates/ismd_compiler/src/store.rs#L304) | `&self, path: &str, source: Option<&str>, basedir: Option<&str>, resolver: impl FnOnce() -> Result<String, IsmdError>` | `Result<String, IsmdError>` | — |
| [load_or_read_disk](../../crates/ismd_compiler/src/store.rs#L338) | `&self, full_path: &str` | `Result<(Arc<SourceEntry>, bool), std::io::Error>` | — |
| [upsert_disk_bytes](../../crates/ismd_compiler/src/store.rs#L358) | `&self, full_path: &str, bytes: Vec<u8>` | `Arc<SourceEntry>` | — |
| [update_virtual_source](../../crates/ismd_compiler/src/store.rs#L398) | `&self, full_path: &str, text: String` | `Arc<SourceEntry>` | — |
| [update_virtual_source_checked](../../crates/ismd_compiler/src/store.rs#L404) | `&self, full_path: &str, text: String` | `(Arc<SourceEntry>, bool)` | — |
| [invalidate_path](../../crates/ismd_compiler/src/store.rs#L447) | `&self, path: &str` | `()` | — |
| [invalidate_path_checked](../../crates/ismd_compiler/src/store.rs#L452) | `&self, path: &str` | `Option<TemplateId>` | — |
| [clear](../../crates/ismd_compiler/src/store.rs#L478) | `&self` | `()` | — |
| [get_parsed](../../crates/ismd_compiler/src/store.rs#L509) | `&self, key: &ParseKey` | `Option<Arc<ParsedTemplate>>` | — |
| [insert_parsed](../../crates/ismd_compiler/src/store.rs#L525) | `&self, key: ParseKey, parsed: ParsedTemplate` | `Arc<ParsedTemplate>` | — |
| [get_compiled_output](../../crates/ismd_compiler/src/store.rs#L549) | `&self, key: &CompiledOutputKey` | `Option<Arc<CompiledOutputEntry>>` | — |
| [insert_compiled_output](../../crates/ismd_compiler/src/store.rs#L573) | `&self, key: CompiledOutputKey, entry: CompiledOutputEntry` | `Arc<CompiledOutputEntry>` | — |
| [remove_path](../../crates/ismd_compiler/src/store.rs#L598) | `&self, path: &str` | `Option<TemplateId>` | — |
| [stats](../../crates/ismd_compiler/src/store.rs#L615) | `&self` | `TemplateStoreStats` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default_global_store](../../crates/ismd_compiler/src/store.rs#L645) | `（無）` | `&'static TemplateStore` | — |
| [hash_bytes](../../crates/ismd_compiler/src/store.rs#L651) | `bytes: &[u8]` | `u64` | — |
| [normalize_cache_path](../../crates/ismd_compiler/src/store.rs#L664) | `path: &str` | `String` | — |
| [collect_ast_metadata](../../crates/ismd_compiler/src/store.rs#L683) | `block: &BlockNode` | `AstMetadata` | — |
| [ast_has_extends](../../crates/ismd_compiler/src/store.rs#L780) | `block: &BlockNode` | `bool` | — |

### `ismd_ast/src/ast.rs`

來源：[ismd/crates/ismd_ast/src/ast.rs](../../crates/ismd_ast/src/ast.rs)

模板 AST 及 serde 相容表示。`typed_named_block` 是私有模組；其內 `pub` helpers 仍明確標示為內部。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct Attribute](../../crates/ismd_ast/src/ast.rs#L7) | `name: String; val: Value; must_escape: bool; line: Option<usize>; column: Option<usize>; filename: Option<String>` |
| [pub struct AttributeBlock](../../crates/ismd_ast/src/ast.rs#L21) | `node_type: String; val: String; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct BlockNode](../../crates/ismd_ast/src/ast.rs#L145) | `node_type: String; nodes: Vec<Node>; line: Option<usize>; column: Option<usize>; filename: Option<String>; declared_blocks: Option<BTreeMap<String, Vec<NamedBlockNode>>>; has_extends: Option<bool>` |
| [pub struct NamedBlockNode](../../crates/ismd_ast/src/ast.rs#L198) | `name: String; mode: String; nodes: Vec<Node>; line: usize; column: Option<usize>; filename: Option<String>; parents: Option<Vec<NamedBlockNode>>; ignore: Option<bool>` |
| [pub struct TagNode](../../crates/ismd_ast/src/ast.rs#L219) | `name: String; self_closing: bool; block: BlockNode; attrs: Vec<Attribute>; attribute_blocks: Vec<AttributeBlock>; is_inline: bool; line: usize; column: Option<usize>; filename: Option<String>; code: Option<Box<CodeNode>>; text_only: Option<bool>` |
| [pub struct InterpolatedTagNode](../../crates/ismd_ast/src/ast.rs#L241) | `expr: String; self_closing: bool; block: BlockNode; attrs: Vec<Attribute>; attribute_blocks: Vec<AttributeBlock>; is_inline: bool; line: usize; column: Option<usize>; filename: Option<String>; code: Option<Box<CodeNode>>; text_only: Option<bool>` |
| [pub struct TextNode](../../crates/ismd_ast/src/ast.rs#L263) | `val: String; line: Option<usize>; column: Option<usize>; filename: Option<String>; is_html: Option<bool>` |
| [pub struct CodeNode](../../crates/ismd_ast/src/ast.rs#L276) | `val: String; buffer: bool; must_escape: bool; is_inline: bool; debug: Option<bool>; block: Option<BlockNode>; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct CommentNode](../../crates/ismd_ast/src/ast.rs#L295) | `val: String; buffer: bool; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct BlockCommentNode](../../crates/ismd_ast/src/ast.rs#L306) | `val: String; block: BlockNode; buffer: bool; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct DoctypeNode](../../crates/ismd_ast/src/ast.rs#L318) | `val: Option<String>; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct ExtensionNode](../../crates/ismd_ast/src/ast.rs#L332) | `node_type: String; rule_id: String; target_name: String; raw_content: String; options_json: Option<String>; is_block: bool; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub enum RawContent](../../crates/ismd_ast/src/ast.rs#L358) | `Bytes(Vec<u8>), Text(String)` |
| [pub struct FileReferenceNode](../../crates/ismd_ast/src/ast.rs#L454) | `node_type: String; path: String; line: usize; column: Option<usize>; filename: Option<String>; full_path: Option<String>; str: Option<String>; raw: Option<RawContent>; ast: Option<Box<BlockNode>>` |
| [pub struct ExtendsNode](../../crates/ismd_ast/src/ast.rs#L495) | `file: FileReferenceNode; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct IncludeNode](../../crates/ismd_ast/src/ast.rs#L505) | `file: FileReferenceNode; block: BlockNode; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct RawIncludeNode](../../crates/ismd_ast/src/ast.rs#L516) | `file: FileReferenceNode; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct CaseNode](../../crates/ismd_ast/src/ast.rs#L526) | `expr: String; block: BlockNode; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct WhenNode](../../crates/ismd_ast/src/ast.rs#L537) | `expr: String; block: Option<BlockNode>; debug: bool; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct ConditionalNode](../../crates/ismd_ast/src/ast.rs#L550) | `test: String; consequent: BlockNode; alternate: Option<Box<Node>>; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct WhileNode](../../crates/ismd_ast/src/ast.rs#L563) | `test: String; block: BlockNode; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct EachNode](../../crates/ismd_ast/src/ast.rs#L574) | `obj: String; val: String; key: Option<String>; block: BlockNode; alternate: Option<BlockNode>; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct EachOfNode](../../crates/ismd_ast/src/ast.rs#L590) | `obj: String; val: String; block: BlockNode; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct MixinNode](../../crates/ismd_ast/src/ast.rs#L602) | `name: String; args: Option<String>; block: Option<BlockNode>; call: bool; attrs: Option<Vec<Attribute>>; attribute_blocks: Option<Vec<AttributeBlock>>; code: Option<Box<CodeNode>>; text_only: Option<bool>; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct MixinBlockNode](../../crates/ismd_ast/src/ast.rs#L625) | `line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct YieldBlockNode](../../crates/ismd_ast/src/ast.rs#L634) | `line: usize; column: Option<usize>; filename: Option<String>` |
| [pub struct AttrsNode](../../crates/ismd_ast/src/ast.rs#L643) | `attrs: Vec<Attribute>; attribute_blocks: Option<Vec<AttributeBlock>>; line: usize; column: Option<usize>; filename: Option<String>` |
| [pub enum Node](../../crates/ismd_ast/src/ast.rs#L657) | `Block(BlockNode), NamedBlock(NamedBlockNode), Tag(TagNode), InterpolatedTag(InterpolatedTagNode), Text(TextNode), Code(CodeNode), Comment(CommentNode), BlockComment(BlockCommentNode), Doctype(DoctypeNode), FileReference(FileReferenceNode), Extends(ExtendsNode), Include(IncludeNode), RawInclude(RawIncludeNode), Case(CaseNode), When(WhenNode), Conditional(ConditionalNode), While(WhileNode), Each(EachNode), EachOf(EachOfNode), Mixin(MixinNode), MixinBlock(MixinBlockNode), YieldBlock(YieldBlockNode), Attrs(AttrsNode), Extension(ExtensionNode)` |


#### `impl Serialize for AttributeBlock`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [serialize](../../crates/ismd_ast/src/ast.rs#L30) | `&self, serializer: S` | `Result<S::Ok, S::Error>` | `顯式 trait impl`<br>`<S: serde::Serializer>` |

#### `impl<'de> Deserialize<'de> for AttributeBlock`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [deserialize](../../crates/ismd_ast/src/ast.rs#L57) | `deserializer: D` | `Result<Self, D::Error>` | `顯式 trait impl`<br>`<D: serde::Deserializer<'de>>` |

#### `mod typed_named_block`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [serialize_map](../../crates/ismd_ast/src/ast.rs#L106) | `val: &Option<BTreeMap<String, Vec<NamedBlockNode>>>, serializer: S` | `Result<S::Ok, S::Error>` | `模組內 pub`<br>`<S: Serializer>` |
| [deserialize_map](../../crates/ismd_ast/src/ast.rs#L120) | `deserializer: D` | `Result<Option<BTreeMap<String, Vec<NamedBlockNode>>>, D::Error>` | `模組內 pub`<br>`<'de, D: Deserializer<'de>>` |
| [serialize_vec](../../crates/ismd_ast/src/ast.rs#L126) | `val: &Option<Vec<NamedBlockNode>>, serializer: S` | `Result<S::Ok, S::Error>` | `模組內 pub`<br>`<S: Serializer>` |
| [deserialize_vec](../../crates/ismd_ast/src/ast.rs#L137) | `deserializer: D` | `Result<Option<Vec<NamedBlockNode>>, D::Error>` | `模組內 pub`<br>`<'de, D: Deserializer<'de>>` |

#### `impl BlockNode`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_ast/src/ast.rs#L168) | `line: usize, nodes: Vec<Node>, filename: Option<String>` | `Self` | — |
| [synthetic](../../crates/ismd_ast/src/ast.rs#L180) | `nodes: Vec<Node>` | `Self` | — |
| [empty](../../crates/ismd_ast/src/ast.rs#L192) | `line: usize, filename: Option<String>` | `Self` | — |

#### `impl RawContent`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [to_utf8_string](../../crates/ismd_ast/src/ast.rs#L365) | `&self` | `String` | — |

#### `impl Serialize for RawContent`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [serialize](../../crates/ismd_ast/src/ast.rs#L374) | `&self, serializer: S` | `Result<S::Ok, S::Error>` | `顯式 trait impl`<br>`<S: serde::Serializer>` |

#### `impl<'de> Deserialize<'de> for RawContent`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [deserialize](../../crates/ismd_ast/src/ast.rs#L419) | `deserializer: D` | `Result<Self, D::Error>` | `顯式 trait impl`<br>`<D: serde::Deserializer<'de>>` |

#### `impl FileReferenceNode`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_ast/src/ast.rs#L474) | `path: String, line: usize, column: Option<usize>, filename: Option<String>` | `Self` | — |

#### `impl Node`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [empty_block](../../crates/ismd_ast/src/ast.rs#L685) | `line: usize, filename: Option<String>` | `BlockNode` | — |
| [node_type](../../crates/ismd_ast/src/ast.rs#L689) | `&self` | `&'static str` | — |

### `ismd_ast/src/lib.rs`

來源：[ismd/crates/ismd_ast/src/lib.rs](../../crates/ismd_ast/src/lib.rs)

模組與型別重匯出；此檔沒有自行宣告 callable 或型別。

### `ismd_ast/src/profile.rs`

來源：[ismd/crates/ismd_ast/src/profile.rs](../../crates/ismd_ast/src/profile.rs)

`#[cfg(feature = "profile")]` 與相反條件各有一組 `imp` 宣告，透過檔尾 `pub use` 重匯出；兩組不會同時編譯。啟用 feature 的 `begin_session` 還檢查 `ISMD_PROFILE=1`；未啟用版本是 no-op，`last_report_json` 回傳 `None`。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub enum Stage](../../crates/ismd_ast/src/profile.rs#L3) | `NapiEntry = 0, PreLexCallback, Lexer, StripComments, PostLexCallback, PreParseCallback, Parser, PostParseCallback, PreLoadCallback, Loader, Resolve, FileRead, PostLoadCallback, PreTransformCallback, Transform, PostTransformCallback, PreLinkCallback, Linker, PostLinkCallback, PreCodegenCallback, OxcParse, OxcSemantic, ConstantEvaluation, ScopeAnalysis, Attrs, Codegen, RuntimeBuild, PostCodegenCallback, NapiReturn, Other` |
| [pub struct FileProfileCounters](../../crates/ismd_ast/src/profile.rs#L109) | `read_count: u64; lexer_count: u64; parser_count: u64; source_cache_hit_count: u64; parse_cache_hit_count: u64` |
| [pub struct ProfileCounters](../../crates/ismd_ast/src/profile.rs#L118) | `lexer_count: u64; parser_count: u64; file_read_count: u64; resolve_count: u64; host_callback_count: u64; ast_roundtrip_count: u64; token_roundtrip_count: u64; oxc_parse_count: u64; oxc_semantic_count: u64; eval_constant_count: u64; scope_analysis_count: u64; layout_parse_count: u64; include_parse_count: u64; allocator_create_count: u64; source_cache_hit_count: u64; parse_cache_hit_count: u64; ast_clone_count: u64; per_file: std::collections::BTreeMap<String, FileProfileCounters>` |
| [pub struct ScopeGuard](../../crates/ismd_ast/src/profile.rs#L180)（mod imp） | 無公開具名欄位。 |
| [pub struct SessionGuard](../../crates/ismd_ast/src/profile.rs#L209)（mod imp） | 無公開具名欄位。 |
| [pub struct ScopeGuard](../../crates/ismd_ast/src/profile.rs#L329)（mod imp） | 無公開具名欄位。 |
| [pub struct SessionGuard](../../crates/ismd_ast/src/profile.rs#L330)（mod imp） | 無公開具名欄位。 |


#### `impl Stage`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [as_str](../../crates/ismd_ast/src/profile.rs#L72) | `self` | `&'static str` | `const` |

#### `impl Drop for ScopeGuard`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [drop](../../crates/ismd_ast/src/profile.rs#L185) | `&mut self` | `()` | `顯式 trait impl` |

#### `impl Drop for SessionGuard`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [drop](../../crates/ismd_ast/src/profile.rs#L214) | `&mut self` | `()` | `顯式 trait impl` |

#### `mod imp`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [begin_session](../../crates/ismd_ast/src/profile.rs#L222) | `（無）` | `SessionGuard` | `模組內 pub` |
| [scope](../../crates/ismd_ast/src/profile.rs#L279) | `stage: Stage` | `ScopeGuard` | `模組內 pub` |
| [with_counters](../../crates/ismd_ast/src/profile.rs#L295) | `f: impl FnOnce(&mut ProfileCounters)` | `()` | `模組內 pub` |
| [record_file](../../crates/ismd_ast/src/profile.rs#L304) | `filename: Option<&str>, f: impl FnOnce(&mut super::FileProfileCounters)` | `()` | `模組內 pub` |
| [last_report_json](../../crates/ismd_ast/src/profile.rs#L320) | `（無）` | `Option<String>` | `模組內 pub` |
| [begin_session](../../crates/ismd_ast/src/profile.rs#L333) | `（無）` | `SessionGuard` | `模組內 pub` |
| [scope](../../crates/ismd_ast/src/profile.rs#L338) | `_stage: Stage` | `ScopeGuard` | `模組內 pub` |
| [with_counters](../../crates/ismd_ast/src/profile.rs#L343) | `_f: impl FnOnce(&mut ProfileCounters)` | `()` | `模組內 pub` |
| [record_file](../../crates/ismd_ast/src/profile.rs#L346) | `_filename: Option<&str>, _f: impl FnOnce(&mut FileProfileCounters)` | `()` | `模組內 pub` |
| [last_report_json](../../crates/ismd_ast/src/profile.rs#L349) | `（無）` | `Option<String>` | `模組內 pub` |

### `ismd_ast/src/span.rs`

來源：[ismd/crates/ismd_ast/src/span.rs](../../crates/ismd_ast/src/span.rs)

行列位置、byte span 與來源索引；以各方法的原宣告保留 byte offset / line-column 型別差異。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct LineCol](../../crates/ismd_ast/src/span.rs#L6) | `line: usize; column: usize` |
| [pub struct Span](../../crates/ismd_ast/src/span.rs#L19) | `byte_start: usize; byte_end: usize; start: LineCol; end: LineCol` |
| [pub struct TokenLoc](../../crates/ismd_ast/src/span.rs#L28) | `start: LineCol; end: LineCol; filename: Option<String>` |
| [pub struct SourceIndex](../../crates/ismd_ast/src/span.rs#L38) | 無公開具名欄位。 |


#### `impl LineCol`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_ast/src/span.rs#L12) | `line: usize, column: usize` | `Self` | `const` |

#### `impl SourceIndex`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [normalize_ismd_input](../../crates/ismd_ast/src/span.rs#L47) | `input: &str` | `String` | — |
| [new](../../crates/ismd_ast/src/span.rs#L56) | `src: &str` | `Self` | — |
| [line_col](../../crates/ismd_ast/src/span.rs#L70) | `&self, src: &str, byte_offset: usize` | `LineCol` | — |
| [byte_offset](../../crates/ismd_ast/src/span.rs#L86) | `&self, src: &str, pos: LineCol` | `Option<usize>` | — |

### `ismd_ast/src/token.rs`

來源：[ismd/crates/ismd_ast/src/token.rs](../../crates/ismd_ast/src/token.rs)

詞法 token 與建構 helper。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct Token](../../crates/ismd_ast/src/token.rs#L9) | `token_type: String; loc: TokenLoc; val: Option<Value>; name: Option<String>; must_escape: Option<bool>; buffer: Option<bool>; mode: Option<String>; args: Option<Value>; key: Option<Value>; code: Option<String>; value: Option<String>; self_closing: Option<bool>` |


#### `impl Token`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_ast/src/token.rs#L36) | `token_type: impl Into<String>, loc: TokenLoc` | `Self` | — |
| [with_str_val](../../crates/ismd_ast/src/token.rs#L53) | `mut self, val: impl Into<String>` | `Self` | — |

### `ismd_lexer/src/lib.rs`

來源：[ismd/crates/ismd_lexer/src/lib.rs](../../crates/ismd_lexer/src/lib.rs)

詞法掃描、token 輸出及 generic syntax / lexer hook 邊界。大量詞法內部 helper 未逐一列入。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct GenericSyntaxRule](../../crates/ismd_lexer/src/lib.rs#L11) | `rule_id: String; prefix: String; is_block: bool` |
| [pub struct LexerOptions](../../crates/ismd_lexer/src/lib.rs#L18) | `filename: Option<String>; interpolated: bool; starting_line: Option<usize>; starting_column: Option<usize>; plugin_methods: Vec<String>; generic_syntax: Vec<GenericSyntaxRule>` |
| [pub struct LexerState](../../crates/ismd_lexer/src/lib.rs#L29) | `input: String; filename: Option<String>; lineno: usize; colno: usize; interpolated: bool; tokens: Vec<Token>; ended: bool` |
| [pub trait LexerPluginHook](../../crates/ismd_lexer/src/lib.rs#L40) | 見下方 trait 方法表。 |
| [pub struct Lexer<'h>](../../crates/ismd_lexer/src/lib.rs#L56) | `original_input: String; filename: Option<String>; interpolated: bool; lineno: usize; colno: usize; indent_stack: Vec<usize>; interpolation_allowed: bool; tokens: Vec<Token>; ended: bool; generic_syntax: Vec<GenericSyntaxRule>` |


#### `pub trait LexerPluginHook`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [call_lex](../../crates/ismd_lexer/src/lib.rs#L41) | `&mut self, method: &str, state: &mut LexerState` | `Result<bool, IsmdError>` | `trait 方法` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [lex](../../crates/ismd_lexer/src/lib.rs#L74) | `input: &str, options: &LexerOptions` | `Result<Vec<Token>, IsmdError>` | — |
| [lex_with_hook](../../crates/ismd_lexer/src/lib.rs#L79) | `input: &str, options: &LexerOptions, hook: &mut dyn LexerPluginHook` | `Result<Vec<Token>, IsmdError>` | — |

#### `impl Lexer<'static>`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_lexer/src/lib.rs#L194) | `str_input: &str, options: &LexerOptions` | `Self` | — |

#### `impl<'h> Lexer<'h>`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [with_hook](../../crates/ismd_lexer/src/lib.rs#L200) | `str_input: &str, options: &LexerOptions, hook: &'h mut dyn LexerPluginHook` | `Self` | — |
| [advance](../../crates/ismd_lexer/src/lib.rs#L2410) | `&mut self` | `Result<bool, IsmdError>` | — |
| [get_tokens](../../crates/ismd_lexer/src/lib.rs#L2458) | `&mut self` | `Result<Vec<Token>, IsmdError>` | — |

### `ismd_strip_comments/src/lib.rs`

來源：[ismd/crates/ismd_strip_comments/src/lib.rs](../../crates/ismd_strip_comments/src/lib.rs)

typed token 與 JSON token 的註解剝除入口。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct StripCommentsOptions](../../crates/ismd_strip_comments/src/lib.rs#L7) | `strip_unbuffered: bool; strip_buffered: bool; filename: Option<String>` |


#### `impl StripCommentsOptions`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_strip_comments/src/lib.rs#L14) | `strip_unbuffered: bool, strip_buffered: bool, filename: Option<String>` | `Self` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [strip_comments](../../crates/ismd_strip_comments/src/lib.rs#L112) | `mut tokens: Vec<Token>, options: StripCommentsOptions` | `Result<Vec<Token>, IsmdError>` | — |
| [strip_comments_json](../../crates/ismd_strip_comments/src/lib.rs#L138) | `tokens: Vec<Value>, options: StripCommentsOptions` | `Result<Vec<Value>, IsmdError>` | — |

### `ismd_parser/src/lib.rs`

來源：[ismd/crates/ismd_parser/src/lib.rs](../../crates/ismd_parser/src/lib.rs)

token 至 AST；`parse_with_warnings`/`parse_owned_with_warnings` 同時回傳 warnings，`parse` 只回傳 AST。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct ParserOptions](../../crates/ismd_parser/src/lib.rs#L23) | `filename: Option<String>; src: Option<String>` |
| [pub struct Parser](../../crates/ismd_parser/src/lib.rs#L279) | `filename: Option<String>; src: Option<String>; in_mixin: usize; warnings: Vec<String>` |


#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [is_inline_tag](../../crates/ismd_parser/src/lib.rs#L18) | `name: &str` | `bool` | — |
| [parse](../../crates/ismd_parser/src/lib.rs#L29) | `tokens: &[Token], options: &ParserOptions` | `Result<BlockNode, IsmdError>` | — |
| [parse_with_warnings](../../crates/ismd_parser/src/lib.rs#L34) | `tokens: &[Token], options: &ParserOptions` | `Result<(BlockNode, Vec<String>), IsmdError>` | — |
| [parse_owned_with_warnings](../../crates/ismd_parser/src/lib.rs#L42) | `tokens: Vec<Token>, options: &ParserOptions` | `Result<(BlockNode, Vec<String>), IsmdError>` | — |
| [parse_json_tokens](../../crates/ismd_parser/src/lib.rs#L108) | `raw_tokens: &[Value], options: &ParserOptions` | `Result<BlockNode, IsmdError>` | — |
| [parse_json_tokens_with_warnings](../../crates/ismd_parser/src/lib.rs#L115) | `raw_tokens: &[Value], options: &ParserOptions` | `Result<(BlockNode, Vec<String>), IsmdError>` | — |

#### `impl Parser`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_parser/src/lib.rs#L288) | `tokens: Vec<Token>, options: &ParserOptions` | `Self` | — |
| [parse_root](../../crates/ismd_parser/src/lib.rs#L376) | `&mut self` | `Result<BlockNode, IsmdError>` | — |

### `ismd_walk/src/lib.rs`

來源：[ismd/crates/ismd_walk/src/lib.rs](../../crates/ismd_walk/src/lib.rs)

typed／JSON AST 遍歷與替換；`walk_mut` 直接修改節點，其他入口提供 before／after 與替換語意。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct WalkOptions](../../crates/ismd_walk/src/lib.rs#L6) | `include_dependencies: bool` |
| [pub enum WalkReplacement](../../crates/ismd_walk/src/lib.rs#L11) | `None, Single(Node), Multiple(Vec<Node>)` |
| [pub struct ReplaceContext](../../crates/ismd_walk/src/lib.rs#L17) | `array_allowed: bool` |
| [pub enum WalkOutcome](../../crates/ismd_walk/src/lib.rs#L50) | `Single(Node), Multiple(Vec<Node>)` |


#### `impl ReplaceContext`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_walk/src/lib.rs#L23) | `array_allowed: bool` | `Self` | — |
| [replace_single](../../crates/ismd_walk/src/lib.rs#L30) | `&mut self, node: Node` | `()` | — |
| [replace_multiple](../../crates/ismd_walk/src/lib.rs#L34) | `&mut self, nodes: Vec<Node>` | `Result<(), String>` | — |
| [into_replacement](../../crates/ismd_walk/src/lib.rs#L44) | `self` | `WalkReplacement` | — |

#### `impl WalkOutcome`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [into_single](../../crates/ismd_walk/src/lib.rs#L56) | `self` | `Result<Node, String>` | — |
| [into_block](../../crates/ismd_walk/src/lib.rs#L65) | `self` | `Result<BlockNode, String>` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [walk_ast](../../crates/ismd_walk/src/lib.rs#L86) | `node: Node, before: &mut B, after: &mut A, options: &WalkOptions, parents: &mut Vec<Node>` | `Result<WalkOutcome, String>` | `<B, A>`<br>`where B: FnMut(&Node, &mut ReplaceContext, &[Node]) -> Result<bool, String>, A: FnMut(&Node, &mut ReplaceContext, &[Node]) -> Result<(), String>` |
| [walk_mut](../../crates/ismd_walk/src/lib.rs#L286) | `block: &mut BlockNode, include_dependencies: bool, visitor: &mut F` | `Result<(), E>` | `<E, F>`<br>`where F: FnMut(&mut Node) -> Result<bool, E>` |
| [walk_json_ast](../../crates/ismd_walk/src/lib.rs#L388) | `mut ast: Value, before: &mut B, after: &mut A, include_dependencies: bool, parents: &mut Vec<Value>` | `Result<Value, String>` | `<B, A>`<br>`where B: FnMut(&Value, bool, &[Value]) -> Result<(bool, Option<Value>), String>, A: FnMut(&Value, bool, &[Value]) -> Result<Option<Value>, String>` |
| [walk_block](../../crates/ismd_walk/src/lib.rs#L616) | `block: &mut BlockNode, visit: &mut F` | `Result<(), IsmdError>` | `<F>`<br>`where F: FnMut(&mut Node) -> Result<(), IsmdError>` |

### `ismd_load/src/lib.rs`

來源：[ismd/crates/ismd_load/src/lib.rs](../../crates/ismd_load/src/lib.rs)

遞迴解析 include / extends 引用；透過 `LoadHost` 執行檔案讀取與依賴 parse。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct LoadedFile](../../crates/ismd_load/src/lib.rs#L7) | `full_path: String; raw: RawContent; text: String` |
| [pub trait LoadHost](../../crates/ismd_load/src/lib.rs#L15) | 見下方 trait 方法表。 |


#### `pub trait LoadHost`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [load_file](../../crates/ismd_load/src/lib.rs#L20) | `&mut self, path: &str, source: Option<&str>, node_filename: Option<&str>, node_line: usize` | `Result<LoadedFile, IsmdError>` | `trait 方法` |
| [parse_source](../../crates/ismd_load/src/lib.rs#L29) | `&mut self, src: &str, filename: &str` | `Result<BlockNode, IsmdError>` | `trait 方法` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [load_ast](../../crates/ismd_load/src/lib.rs#L59) | `ast: BlockNode, host: &mut H` | `Result<BlockNode, IsmdError>` | `<H: LoadHost + ?Sized>` |
| [annotate_load_error](../../crates/ismd_load/src/lib.rs#L166) | `mut err: IsmdError, node_filename: Option<&str>, node_line: usize` | `IsmdError` | — |

### `ismd_linker/src/lib.rs`

來源：[ismd/crates/ismd_linker/src/lib.rs](../../crates/ismd_linker/src/lib.rs)

接收已載入的 AST，連結 extends、named block、include 與 mixin 所需結構。


#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [link](../../crates/ismd_linker/src/lib.rs#L14) | `mut ast: BlockNode` | `Result<BlockNode, IsmdError>` | — |

### `ismd_code_gen/src/lib.rs`

來源：[ismd/crates/ismd_code_gen/src/lib.rs](../../crates/ismd_code_gen/src/lib.rs)

AST 轉 JavaScript 函式原始碼；overlay 版本可使用共享不可變 AST。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct CodeGenOptions](../../crates/ismd_code_gen/src/lib.rs#L32) | `compile_debug: bool; pretty: Option<String>; doctype: Option<String>; inline_runtime_functions: bool; globals: Vec<String>; use_self: bool; include_sources: bool; debug_sources_json: Option<String>; template_name: String; filename: Option<String>; src: Option<String>` |
| [pub struct IncludedView<'ast>](../../crates/ismd_code_gen/src/lib.rs#L48) | `ast: &'ast BlockNode; has_yield: bool; default_yield_target_ptr: Option<usize>` |
| [pub trait LinkedAstOverlay<'ast>](../../crates/ismd_code_gen/src/lib.rs#L55) | 見下方 trait 方法表。 |


#### `pub trait LinkedAstOverlay<'ast>`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [named_block_segments](../../crates/ismd_code_gen/src/lib.rs#L56) | `&self, nb: &NamedBlockNode` | `Option<&[&'ast [Node]]>` | `trait 方法` |
| [is_named_block_ignored](../../crates/ismd_code_gen/src/lib.rs#L57) | `&self, _nb: &NamedBlockNode` | `bool` | `trait 方法` |
| [resolve_include](../../crates/ismd_code_gen/src/lib.rs#L60) | `&self, inc: &IncludeNode` | `Option<IncludedView<'ast>>` | `trait 方法` |
| [resolve_raw_include](../../crates/ismd_code_gen/src/lib.rs#L61) | `&self, raw: &RawIncludeNode` | `Option<&'ast str>` | `trait 方法` |
| [prepended_mixins](../../crates/ismd_code_gen/src/lib.rs#L62) | `&self` | `&[&'ast MixinNode]` | `trait 方法` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [generate_code](../../crates/ismd_code_gen/src/lib.rs#L68) | `ast: &BlockNode, options: &CodeGenOptions` | `Result<String, IsmdError>` | — |
| [generate_code_with_overlay](../../crates/ismd_code_gen/src/lib.rs#L73) | `ast: &'ast BlockNode, options: &CodeGenOptions, overlay: &'ast dyn LinkedAstOverlay<'ast>` | `Result<String, IsmdError>` | `<'ast>` |

### `ismd_attrs/src/lib.rs`

來源：[ismd/crates/ismd_attrs/src/lib.rs](../../crates/ismd_attrs/src/lib.rs)

屬性編譯結果為 JavaScript 表達式字串；`AttrsFormat` 控制 HTML 或 object 形式。`compile_static_attrs` 則回傳靜態屬性字串。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub enum AttrsFormat](../../crates/ismd_attrs/src/lib.rs#L12) | `Html, Object` |


#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [compile_attrs](../../crates/ismd_attrs/src/lib.rs#L21) | `attrs: &[Attribute], terse: bool, format: AttrsFormat, mut runtime: R` | `String` | `<R>`<br>`where R: FnMut(&str) -> String` |
| [compile_attrs_fast](../../crates/ismd_attrs/src/lib.rs#L34) | `attrs: &[Attribute], terse: bool, format: AttrsFormat, mut runtime: R` | `String` | `<R>`<br>`where R: FnMut(&'static str) -> Cow<'static, str>` |
| [compile_static_attrs](../../crates/ismd_attrs/src/lib.rs#L313) | `attrs: &[Attribute]` | `String` | — |

### `ismd_js/src/constant.rs`

來源：[ismd/crates/ismd_js/src/constant.rs](../../crates/ismd_js/src/constant.rs)

常數分析、值轉換與模板屬性／字串 helper；`ConstEvalOutcome` 區分 `Constant(ConstVal)`、`NotConstant` 與 `Unsupported(String)`。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub enum ConstVal](../../crates/ismd_js/src/constant.rs#L10) | `Undefined, Null, Bool(bool), Number(f64), String(String), RegExp { pattern: String, flags: String }, Array(Vec<ConstVal>), Object(Vec<(String, ConstVal)>), IsmdRuntime, IsmdMethod(&'static str)` |
| [pub enum ConstEvalOutcome](../../crates/ismd_js/src/constant.rs#L25) | `Constant(ConstVal), NotConstant, Unsupported(String)` |


#### `impl ConstVal`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [is_truthy](../../crates/ismd_js/src/constant.rs#L32) | `&self` | `bool` | — |
| [to_js_number](../../crates/ismd_js/src/constant.rs#L46) | `&self` | `f64` | — |
| [to_js_string](../../crates/ismd_js/src/constant.rs#L73) | `&self` | `String` | — |
| [to_json_value](../../crates/ismd_js/src/constant.rs#L95) | `&self` | `serde_json::Value` | — |
| [to_json_string](../../crates/ismd_js/src/constant.rs#L134) | `&self` | `String` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [js_stringify_val](../../crates/ismd_js/src/constant.rs#L199) | `val: &ConstVal` | `String` | — |
| [push_js_string_inner](../../crates/ismd_js/src/constant.rs#L209) | `out: &mut String, s: &str` | `()` | — |
| [js_stringify_str](../../crates/ismd_js/src/constant.rs#L276) | `s: &str` | `String` | — |
| [escape_js_stringify_chars](../../crates/ismd_js/src/constant.rs#L284) | `json: &str` | `String` | — |
| [ismd_escape](../../crates/ismd_js/src/constant.rs#L325) | `html: &str` | `String` | — |
| [ismd_style](../../crates/ismd_js/src/constant.rs#L352) | `val: &ConstVal` | `String` | — |
| [ismd_classes](../../crates/ismd_js/src/constant.rs#L372) | `val: &ConstVal, escaping: Option<&[bool]>` | `String` | — |
| [ismd_attr](../../crates/ismd_js/src/constant.rs#L416) | `key: &str, val: &ConstVal, escaped: bool, terse: bool` | `String` | — |
| [is_constant](../../crates/ismd_js/src/constant.rs#L452) | `src: &str` | `bool` | — |
| [eval_constant](../../crates/ismd_js/src/constant.rs#L457) | `src: &str` | `Option<ConstVal>` | — |
| [eval_static_expression](../../crates/ismd_js/src/constant.rs#L481) | `src: &str` | `ConstEvalOutcome` | — |

### `ismd_js/src/expression.rs`

來源：[ismd/crates/ismd_js/src/expression.rs](../../crates/ismd_js/src/expression.rs)

Oxc 表達式驗證與 owned 分析結果；`ExpressionAnalysis` 不持有需跨 allocator 生命周期保留的 Oxc AST。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct ExpressionOptions](../../crates/ismd_js/src/expression.rs#L11) | `strict: bool; line_comment: bool` |
| [pub struct ExpressionError](../../crates/ismd_js/src/expression.rs#L17) | `message: String; line: usize; column: usize` |
| [pub struct ExpressionAnalysis](../../crates/ismd_js/src/expression.rs#L27) | `const_outcome: ConstEvalOutcome` |


#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [validate_expression](../../crates/ismd_js/src/expression.rs#L195) | `src: &str, options: ExpressionOptions` | `Result<(), ExpressionError>` | — |
| [analyze_expression](../../crates/ismd_js/src/expression.rs#L204) | `src: &str, options: ExpressionOptions, allow_ismd_constants: bool` | `Result<ExpressionAnalysis, ExpressionError>` | — |

#### `impl ExpressionAnalysis`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [constant_value](../../crates/ismd_js/src/expression.rs#L220) | `&self` | `Option<&ConstVal>` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [is_expression](../../crates/ismd_js/src/expression.rs#L238) | `src: &str` | `bool` | — |

### `ismd_js/src/lib.rs`

來源：[ismd/crates/ismd_js/src/lib.rs](../../crates/ismd_js/src/lib.rs)

重匯出 expression / scope / constant / locals API；thread-local allocator helper 是 `pub(crate)`，已在前文選列。

### `ismd_js/src/locals.rs`

來源：[ismd/crates/ismd_js/src/locals.rs](../../crates/ismd_js/src/locals.rs)

根據自由變數分析改寫 locals 存取；checked 版本提供 `ScopeError`。


#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [add_with_checked](../../crates/ismd_js/src/locals.rs#L6) | `obj: &str, src: &str, exclude: &[String]` | `Result<String, ScopeError>` | — |
| [add_with](../../crates/ismd_js/src/locals.rs#L77) | `obj: &str, src: &str, exclude: &[String]` | `String` | — |

### `ismd_js/src/scan.rs`

來源：[ismd/crates/ismd_js/src/scan.rs](../../crates/ismd_js/src/scan.rs)

JavaScript 字元與括號狀態掃描器，包含 UTF-16 code unit 入口；與模板 lexer 的 `Token` 不同。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub enum TokenType](../../crates/ismd_js/src/scan.rs#L4) | `LineComment, BlockComment, SingleQuote, DoubleQuote, TemplateQuote, Regexp, RoundBracket, CurlyBracket, SquareBracket` |
| [pub struct NestingOptions](../../crates/ismd_js/src/scan.rs#L17) | `ignore_line_comment: bool; ignore_nesting: bool; start: usize; end: Option<usize>` |
| [pub struct State](../../crates/ismd_js/src/scan.rs#L25) | `stack: Vec<TokenType>; regexp_start: bool; escaped: bool; has_dollar: bool; history: Vec<u16>; last_char: Option<u16>` |
| [pub enum CharacterParserErrorCode](../../crates/ismd_js/src/scan.rs#L82) | `EndOfStringReached, MismatchedBracket, CharLengthNotOne` |
| [pub struct CharacterParserError](../../crates/ismd_js/src/scan.rs#L99) | `code: CharacterParserErrorCode; message: String; index: Option<usize>` |
| [pub struct ParseUntilRange](../../crates/ismd_js/src/scan.rs#L106) | `start: usize; end: usize; src: String` |


#### `impl Default for State`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default](../../crates/ismd_js/src/scan.rs#L35) | `（無）` | `Self` | `顯式 trait impl` |

#### `impl State`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_js/src/scan.rs#L41) | `（無）` | `Self` | — |
| [current](../../crates/ismd_js/src/scan.rs#L52) | `&self` | `Option<TokenType>` | — |
| [is_string](../../crates/ismd_js/src/scan.rs#L56) | `&self` | `bool` | — |
| [is_comment](../../crates/ismd_js/src/scan.rs#L63) | `&self` | `bool` | — |
| [is_nesting](../../crates/ismd_js/src/scan.rs#L70) | `&self, opts: NestingOptions` | `bool` | — |

#### `impl CharacterParserErrorCode`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [as_str](../../crates/ismd_js/src/scan.rs#L89) | `&self` | `&'static str` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default_state](../../crates/ismd_js/src/scan.rs#L138) | `（無）` | `State` | — |
| [is_punctuator_u16](../../crates/ismd_js/src/scan.rs#L142) | `c: Option<u16>` | `bool` | — |
| [is_punctuator](../../crates/ismd_js/src/scan.rs#L175) | `c: Option<char>` | `bool` | — |
| [is_keyword](../../crates/ismd_js/src/scan.rs#L182) | `id: &str` | `bool` | — |
| [parse_char_u16](../../crates/ismd_js/src/scan.rs#L287) | `character: u16, state: &mut State` | `Result<(), CharacterParserError>` | — |
| [parse_char](../../crates/ismd_js/src/scan.rs#L395) | `character: char, mut state: State` | `Result<State, CharacterParserError>` | — |
| [parse](../../crates/ismd_js/src/scan.rs#L409) | `src: &str, options: NestingOptions` | `Result<State, CharacterParserError>` | — |
| [parse_until](../../crates/ismd_js/src/scan.rs#L442) | `src: &str, delimiter: &str, options: NestingOptions` | `Result<ParseUntilRange, CharacterParserError>` | — |

### `ismd_js/src/scope.rs`

來源：[ismd/crates/ismd_js/src/scope.rs](../../crates/ismd_js/src/scope.rs)

Oxc scope 分析、自由變數與識別字檢查。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct TopLevelReturn](../../crates/ismd_js/src/scope.rs#L9) | `start: usize; end: usize; arg_span: Option<(usize, usize)>` |
| [pub struct ScopeAnalysis](../../crates/ismd_js/src/scope.rs#L16) | `free_variables: Vec<String>; top_level_returns: Vec<TopLevelReturn>` |
| [pub struct ScopeError](../../crates/ismd_js/src/scope.rs#L25) | `component: &'static str; message: String` |


#### `impl std::fmt::Display for ScopeError`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [fmt](../../crates/ismd_js/src/scope.rs#L31) | `&self, f: &mut std::fmt::Formatter<'_>` | `std::fmt::Result` | `顯式 trait impl` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [analyze_scope](../../crates/ismd_js/src/scope.rs#L41) | `src: &str, component: &'static str` | `Result<ScopeAnalysis, ScopeError>` | — |
| [find_free_variables](../../crates/ismd_js/src/scope.rs#L223) | `js_code: &str, ignored_globals: &[String]` | `Vec<String>` | — |
| [is_valid_js_identifier](../../crates/ismd_js/src/scope.rs#L235) | `name: &str` | `bool` | — |

### `ismd_runtime/src/lib.rs`

來源：[ismd/crates/ismd_runtime/src/lib.rs](../../crates/ismd_runtime/src/lib.rs)

生成 JavaScript runtime helper 原始碼及其相依 helper；此 Rust crate 不直接執行模板 JS。


#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [is_internal](../../crates/ismd_runtime/src/lib.rs#L4) | `name: &str` | `bool` | — |
| [dependencies](../../crates/ismd_runtime/src/lib.rs#L16) | `name: &str` | `&'static [&'static str]` | — |
| [source](../../crates/ismd_runtime/src/lib.rs#L33) | `name: &str` | `Option<&'static str>` | — |
| [build](../../crates/ismd_runtime/src/lib.rs#L85) | `functions: &[S]` | `String` | `<S: AsRef<str>>` |

### `ismd_error/src/lib.rs`

來源：[ismd/crates/ismd_error/src/lib.rs](../../crates/ismd_error/src/lib.rs)

模板錯誤資料、訊息格式及宿主例外標記。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct ErrorOptions](../../crates/ismd_error/src/lib.rs#L5) | `line: i64; column: Option<i64>; filename: Option<String>; src: Option<String>` |
| [pub struct IsmdErrorJson](../../crates/ismd_error/src/lib.rs#L16) | `code: String; msg: String; line: i64; column: Option<i64>; filename: Option<String>` |
| [pub struct IsmdError](../../crates/ismd_error/src/lib.rs#L28) | `code: String; msg: String; line: i64; column: Option<i64>; filename: Option<String>; src: Option<String>; message: String; is_js_host_exception: bool; plain_error_code: Option<String>` |


#### `impl IsmdError`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_error/src/lib.rs#L46) | `code: impl Into<String>, message: impl Into<String>, options: ErrorOptions` | `Self` | — |
| [host_exception](../../crates/ismd_error/src/lib.rs#L124) | `message: impl Into<String>` | `Self` | — |
| [host_exception_with_code](../../crates/ismd_error/src/lib.rs#L139) | `plain_code: impl Into<String>, message: impl Into<String>` | `Self` | — |
| [to_json](../../crates/ismd_error/src/lib.rs#L157) | `&self` | `IsmdErrorJson` | — |

#### `impl fmt::Display for IsmdError`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [fmt](../../crates/ismd_error/src/lib.rs#L169) | `&self, f: &mut fmt::Formatter<'_>` | `fmt::Result` | `顯式 trait impl` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [make_error](../../crates/ismd_error/src/lib.rs#L176) | `code: impl Into<String>, message: impl Into<String>, options: ErrorOptions` | `IsmdError` | — |

### `ismd_plugin_abi/src/lib.rs`

來源：[ismd/crates/ismd_plugin_abi/src/lib.rs](../../crates/ismd_plugin_abi/src/lib.rs)

C ABI 型別與 buffer 所有權函式；保留原始指標、`unsafe` 與 `extern "C"` 宣告。

ABI（Application Binary Interface）規定 native library 間的資料配置與函式呼叫契約。以下常數補充 descriptor／response 中整數欄位的含義，來源為 [ismd_plugin_abi/lib.rs](../../crates/ismd_plugin_abi/src/lib.rs#L3)：

| 常數 | 型別與值 | 用途 |
|---|---|---|
| `ISMD_PLUGIN_ABI_VERSION` | `u32 = 1` | loader 要求 descriptor.abi_version 相符 |
| `ISMD_PLUGIN_CAP_THREAD_SAFE` | `u32 = 1 << 0` | capabilities 的 bit 0；未設定時 host 以 mutex 序列化 transform 呼叫 |
| `ISMD_OUTPUT_TEXT` | `u32 = 0` | response 的文字輸出種類 |
| `ISMD_OUTPUT_RAW_HTML` | `u32 = 1` | host 轉成 `TextNode { is_html: Some(true), ... }` |
| `ISMD_STATUS_OK` | `i32 = 0` | transform 還須同時有 response.success=true 才算成功；init 非 0 則失敗 |
| `ISMD_STATUS_ERR` | `i32 = -1` | 宣告的錯誤狀態；host 以非 0 狀態處理 |
| `ISMD_STATUS_PANIC` | `i32 = -2` | 宣告的 panic 狀態；不代表 host 能自動捕捉跨 C ABI 的所有 panic |

transform 遇非 OK status 或 success=false 時使用 error_message 建立 host error；output_kind 只有等於 RAW_HTML 時設定 is_html，其餘值走文字節點處理，目前未另外驗證未知 output_kind。這是實際分支，不能將未知整數視為新增輸出種類。[load_plugin](../../crates/ismd_compiler/src/plugin.rs#L84)、[transform_ast](../../crates/ismd_compiler/src/plugin.rs#L307)

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct IsmdPluginStringView](../../crates/ismd_plugin_abi/src/lib.rs#L16) | `ptr: *const u8; len: usize` |
| [pub struct IsmdPluginBuffer](../../crates/ismd_plugin_abi/src/lib.rs#L50) | `ptr: *mut u8; len: usize; cap: usize; free_fn: Option<IsmdBufferFreeFn>` |
| [pub enum IsmdSyntaxKind](../../crates/ismd_plugin_abi/src/lib.rs#L136) | `BlockPrefix = 0, InlinePrefix = 1, IncludePrefix = 2` |
| [pub struct IsmdSyntaxDescriptor](../../crates/ismd_plugin_abi/src/lib.rs#L147) | `rule_id: *const c_char; syntax_kind: IsmdSyntaxKind; prefix: *const c_char` |
| [pub struct IsmdTransformRequest<'a>](../../crates/ismd_plugin_abi/src/lib.rs#L157) | `rule_id: *const c_char; target_name: *const c_char; content: IsmdPluginStringView; options_json: IsmdPluginStringView; filename: *const c_char; line: usize; column: usize; _marker: std::marker::PhantomData<&'a ()>` |
| [pub struct IsmdTransformResponse](../../crates/ismd_plugin_abi/src/lib.rs#L169) | `success: bool; output_kind: u32; output: IsmdPluginBuffer; error_message: IsmdPluginBuffer` |
| [pub struct IsmdPluginDescriptorV1](../../crates/ismd_plugin_abi/src/lib.rs#L218) | `abi_version: u32; plugin_id: *const c_char; plugin_version: *const c_char; capabilities: u32; syntax_count: usize; syntax_descriptors: *const IsmdSyntaxDescriptor; transform_fn: Option<IsmdPluginTransformFn>; init_fn: Option<IsmdPluginInitFn>; shutdown_fn: Option<IsmdPluginShutdownFn>` |

| 函式指標別名（完整宣告） | 來源 |
|---|---|
| `pub type IsmdBufferFreeFn = unsafe extern "C" fn(ptr: *mut u8, len: usize, cap: usize);` | [L47](../../crates/ismd_plugin_abi/src/lib.rs#L47) |
| `pub type IsmdPluginTransformFn = unsafe extern "C" fn( request: *const IsmdTransformRequest<'_>, response: *mut IsmdTransformResponse, ) -> i32;` | [L209](../../crates/ismd_plugin_abi/src/lib.rs#L209) |
| `pub type IsmdPluginInitFn = unsafe extern "C" fn() -> i32;` | [L214](../../crates/ismd_plugin_abi/src/lib.rs#L214) |
| `pub type IsmdPluginShutdownFn = unsafe extern "C" fn() -> i32;` | [L215](../../crates/ismd_plugin_abi/src/lib.rs#L215) |
| `pub type IsmdPluginEntryFnV1 = unsafe extern "C" fn() -> *const IsmdPluginDescriptorV1;` | [L234](../../crates/ismd_plugin_abi/src/lib.rs#L234) |


#### `impl IsmdPluginStringView`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [empty](../../crates/ismd_plugin_abi/src/lib.rs#L22) | `（無）` | `Self` | `const` |
| [from_str](../../crates/ismd_plugin_abi/src/lib.rs#L29) | `s: &str` | `Self` | — |
| [as_str](../../crates/ismd_plugin_abi/src/lib.rs#L38) | `&self` | `Result<&'a str, std::str::Utf8Error>` | `unsafe`<br>`<'a>` |

#### `impl Default for IsmdPluginBuffer`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default](../../crates/ismd_plugin_abi/src/lib.rs#L58) | `（無）` | `Self` | `顯式 trait impl` |

#### `impl IsmdPluginBuffer`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [empty](../../crates/ismd_plugin_abi/src/lib.rs#L64) | `（無）` | `Self` | `const` |
| [from_string](../../crates/ismd_plugin_abi/src/lib.rs#L73) | `mut s: String` | `Self` | — |
| [from_vec](../../crates/ismd_plugin_abi/src/lib.rs#L86) | `mut v: Vec<u8>` | `Self` | — |
| [release](../../crates/ismd_plugin_abi/src/lib.rs#L100) | `&mut self` | `()` | — |
| [to_string_lossy](../../crates/ismd_plugin_abi/src/lib.rs#L113) | `&self` | `String` | — |

#### `impl Drop for IsmdPluginBuffer`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [drop](../../crates/ismd_plugin_abi/src/lib.rs#L123) | `&mut self` | `()` | `顯式 trait impl` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default_buffer_free_fn](../../crates/ismd_plugin_abi/src/lib.rs#L128) | `ptr: *mut u8, len: usize, cap: usize` | `()` | `unsafe extern "C"` |

#### `impl Default for IsmdTransformResponse`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [default](../../crates/ismd_plugin_abi/src/lib.rs#L177) | `（無）` | `Self` | `顯式 trait impl` |

#### `impl IsmdTransformResponse`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [set_text_output](../../crates/ismd_plugin_abi/src/lib.rs#L188) | `&mut self, text: String` | `()` | — |
| [set_raw_html_output](../../crates/ismd_plugin_abi/src/lib.rs#L195) | `&mut self, html: String` | `()` | — |
| [set_error](../../crates/ismd_plugin_abi/src/lib.rs#L202) | `&mut self, err: String` | `()` | — |

### `ismd_napi/src/lib.rs`

來源：[ismd/crates/ismd_napi/src/lib.rs](../../crates/ismd_napi/src/lib.rs)

N-API Rust 邊界、DTO、native store/session。`Env` 由 N-API 注入；這裡完整列 Rust 參數，JavaScript 實際呼叫方式請見 JavaScript API 文件。

| 型別宣告 | 公開欄位／variants |
|---|---|
| [pub struct NapiErrorOptions](../../crates/ismd_napi/src/lib.rs#L24) | `line: i64; column: Option<i64>; filename: Option<String>; src: Option<String>` |
| [pub struct NapiIsmdErrorDto](../../crates/ismd_napi/src/lib.rs#L33) | `code: String; msg: String; line: i64; column: Option<i64>; filename: Option<String>; src: Option<String>; message: String` |
| [pub struct NapiCompileOptions](../../crates/ismd_napi/src/lib.rs#L59) | `filename: Option<String>; basedir: Option<String>; pretty: Option<String>; compile_debug: Option<bool>; doctype: Option<String>; inline_runtime_functions: Option<bool>; globals: Option<Vec<String>>; use_self: Option<bool>; include_sources: Option<bool>; template_name: Option<String>; lex_plugin_methods: Option<Vec<String>>; native_plugins: Option<Vec<String>>` |
| [pub struct NapiCompileOutcome](../../crates/ismd_napi/src/lib.rs#L76) | `ok: bool; body: Option<String>; dependencies: Option<Vec<String>>; error: Option<NapiIsmdErrorDto>; plain_error: Option<String>; plain_error_code: Option<String>` |
| [pub struct NapiLexerOptions](../../crates/ismd_napi/src/lib.rs#L121) | `filename: Option<String>; interpolated: Option<bool>; starting_line: Option<i64>; starting_column: Option<i64>; plugin_methods: Option<Vec<String>>` |
| [pub struct NapiJsonOutcome](../../crates/ismd_napi/src/lib.rs#L131) | `ok: bool; data: Option<Value>; error: Option<NapiIsmdErrorDto>; plain_error: Option<String>` |
| [pub struct NapiStripCommentsOptions](../../crates/ismd_napi/src/lib.rs#L140) | `strip_unbuffered: Option<bool>; strip_buffered: Option<bool>; filename: Option<String>` |
| [pub struct NapiParserOptions](../../crates/ismd_napi/src/lib.rs#L315) | `filename: Option<String>; src: Option<String>` |
| [pub struct NapiWalkStepInput](../../crates/ismd_napi/src/lib.rs#L375) | `node: Value; array_allowed: bool; parents: Vec<Value>` |
| [pub struct NapiWalkStepResult](../../crates/ismd_napi/src/lib.rs#L383) | `cont: Option<bool>; replaced: bool; replacement: Option<Value>` |
| [pub struct NapiTemplateStoreStats](../../crates/ismd_napi/src/lib.rs#L1185) | `sources: u32; parsed: u32; resolved: u32; outputs: u32; dag_nodes: u32; dag_edges: u32; source_hits: f64; source_misses: f64; parse_hits: f64; parse_misses: f64; output_cache_hits: f64; output_cache_misses: f64` |
| [pub struct NativeTemplateStore](../../crates/ismd_napi/src/lib.rs#L1220) | 無公開具名欄位。 |
| [pub struct NapiVirtualFile](../../crates/ismd_napi/src/lib.rs#L1429) | `path: String; source: String` |
| [pub struct NapiBatchEntryInput](../../crates/ismd_napi/src/lib.rs#L1436) | `id: Option<String>; filename: Option<String>; source: Option<String>; options: Option<NapiCompileOptions>` |
| [pub struct NapiBatchEntryResult](../../crates/ismd_napi/src/lib.rs#L1445) | `id: String; ok: bool; body: Option<String>; dependencies: Vec<String>; cache_hit: bool; error: Option<NapiIsmdErrorDto>; plain_error: Option<String>; plain_error_code: Option<String>` |
| [pub struct NapiIncrementalUpdateReport](../../crates/ismd_napi/src/lib.rs#L1492) | `changed: bool; changed_files: Vec<String>; invalidated_templates: Vec<String>; affected_entries: Vec<String>` |
| [pub struct NativeCompilerSession](../../crates/ismd_napi/src/lib.rs#L1511) | 無公開具名欄位。 |


#### `impl From<IsmdError> for NapiIsmdErrorDto`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [from](../../crates/ismd_napi/src/lib.rs#L44) | `err: IsmdError` | `Self` | `顯式 trait impl` |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [make_error_dto](../../crates/ismd_napi/src/lib.rs#L86) | `code: String, message: String, options: NapiErrorOptions` | `NapiIsmdErrorDto` | — |
| [runtime_build](../../crates/ismd_napi/src/lib.rs#L105) | `functions: Vec<String>` | `String` | — |
| [add_with_sync](../../crates/ismd_napi/src/lib.rs#L110) | `obj: String, src: String, exclude: Option<Vec<String>>` | `Result<String>` | — |
| [lex_sync](../../crates/ismd_napi/src/lib.rs#L200) | `env: Env, source: String, options: Option<NapiLexerOptions>, callbacks: Option<Object>` | `Result<NapiJsonOutcome>` | — |
| [strip_comments_sync](../../crates/ismd_napi/src/lib.rs#L281) | `tokens: Vec<Value>, options: Option<NapiStripCommentsOptions>` | `Result<NapiJsonOutcome>` | — |
| [parse_sync](../../crates/ismd_napi/src/lib.rs#L321) | `tokens: Vec<Value>, options: Option<NapiParserOptions>, callbacks: Option<Object>` | `Result<NapiJsonOutcome>` | — |
| [walk_sync](../../crates/ismd_napi/src/lib.rs#L390) | `env: Env, ast: Value, include_dependencies: Option<bool>, initial_parents: Option<Vec<Value>>, callbacks: Object` | `Result<Value>` | — |
| [default_resolve_sync](../../crates/ismd_napi/src/lib.rs#L1065) | `filename: String, source: Option<String>, basedir: Option<String>` | `NapiJsonOutcome` | — |
| [load_sync](../../crates/ismd_napi/src/lib.rs#L1087) | `env: Env, ast: Value, basedir: Option<String>, callbacks: Object` | `Result<NapiJsonOutcome>` | — |
| [link_sync](../../crates/ismd_napi/src/lib.rs#L1144) | `ast: Value` | `Result<NapiJsonOutcome>` | — |

#### `impl From<TemplateStoreStats> for NapiTemplateStoreStats`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [from](../../crates/ismd_napi/src/lib.rs#L1201) | `s: TemplateStoreStats` | `Self` | `顯式 trait impl` |

#### `impl NativeTemplateStore`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_napi/src/lib.rs#L1227) | `（無）` | `Self` | — |
| [invalidate_path](../../crates/ismd_napi/src/lib.rs#L1234) | `&self, path: String` | `()` | — |
| [update_virtual_source](../../crates/ismd_napi/src/lib.rs#L1239) | `&self, path: String, source: String` | `()` | — |
| [clear](../../crates/ismd_napi/src/lib.rs#L1244) | `&self` | `()` | — |
| [stats](../../crates/ismd_napi/src/lib.rs#L1249) | `&self` | `NapiTemplateStoreStats` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [clear_default_template_store](../../crates/ismd_napi/src/lib.rs#L1255) | `（無）` | `()` | — |
| [default_template_store_stats](../../crates/ismd_napi/src/lib.rs#L1260) | `（無）` | `NapiTemplateStoreStats` | — |
| [compile_body_sync](../../crates/ismd_napi/src/lib.rs#L1265) | `env: Env, source: String, options: NapiCompileOptions, callbacks: Option<Object>, store: Option<&NativeTemplateStore>` | `Result<NapiCompileOutcome>` | — |
| [get_last_profile_json](../../crates/ismd_napi/src/lib.rs#L1343) | `（無）` | `Option<String>` | — |
| [compile_attrs_sync](../../crates/ismd_napi/src/lib.rs#L1348) | `attrs: Value, terse: bool, format: String, runtime_cb: Function<String, String>` | `Result<NapiJsonOutcome>` | — |

#### `impl From<BatchEntryOutput> for NapiBatchEntryResult`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [from](../../crates/ismd_napi/src/lib.rs#L1457) | `out: BatchEntryOutput` | `Self` | `顯式 trait impl` |

#### `impl From<IncrementalUpdateReport> for NapiIncrementalUpdateReport`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [from](../../crates/ismd_napi/src/lib.rs#L1500) | `r: IncrementalUpdateReport` | `Self` | `顯式 trait impl` |

#### `impl NativeCompilerSession`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [new](../../crates/ismd_napi/src/lib.rs#L1518) | `default_options: Option<NapiCompileOptions>, store: Option<&NativeTemplateStore>` | `Self` | — |
| [update_files](../../crates/ismd_napi/src/lib.rs#L1533) | `&self, files: Vec<NapiVirtualFile>` | `NapiIncrementalUpdateReport` | — |
| [invalidate_files](../../crates/ismd_napi/src/lib.rs#L1542) | `&self, paths: Vec<String>` | `NapiIncrementalUpdateReport` | — |
| [remove_files](../../crates/ismd_napi/src/lib.rs#L1547) | `&self, paths: Vec<String>` | `NapiIncrementalUpdateReport` | — |
| [dispose](../../crates/ismd_napi/src/lib.rs#L1552) | `&self` | `()` | — |
| [get_affected_entries](../../crates/ismd_napi/src/lib.rs#L1557) | `&self` | `Vec<String>` | — |
| [compile_affected](../../crates/ismd_napi/src/lib.rs#L1562) | `&self, parallel: Option<bool>, parallel_threshold: Option<u32>` | `Result<Vec<NapiBatchEntryResult>>` | — |
| [clear](../../crates/ismd_napi/src/lib.rs#L1589) | `&self` | `()` | — |
| [stats](../../crates/ismd_napi/src/lib.rs#L1594) | `&self` | `NapiTemplateStoreStats` | — |
| [compile_entries](../../crates/ismd_napi/src/lib.rs#L1599) | `&self, entries: Vec<NapiBatchEntryInput>, parallel: Option<bool>, parallel_threshold: Option<u32>` | `Result<Vec<NapiBatchEntryResult>>` | — |

#### `自由函式`

| Callable／來源 | Arguments | Return | 宣告限制 |
|---|---|---|---|
| [compile_batch_sync](../../crates/ismd_napi/src/lib.rs#L1629) | `entries: Vec<NapiBatchEntryInput>, default_options: Option<NapiCompileOptions>, store: Option<&NativeTemplateStore>, parallel: Option<bool>, parallel_threshold: Option<u32>` | `Result<Vec<NapiBatchEntryResult>>` | — |

## Build-time Rust 入口

| 符號 | Arguments | Return | 實際行為 |
|---|---|---|---|
| [ismd_napi/build.rs::main](../../crates/ismd_napi/build.rs#L1) | 無 | `()` | 呼叫 `napi_build::setup()`；由 Cargo build script 執行，不是 library callable。 |

## 查核與維護方式

本次文件核對 29 個 production source files，逐行對應 callable 的名稱、參數、回傳型別與泛型限制。上表共 282 個 callable、128 個型別宣告、5 個函式指標別名；build script 另列，不併入 callable 數量。沒有為此文件修改 Rust 程式碼。

新增或改名 public 方法時，應同步更新該檔的表格與來源行號；新增 trait 方法也屬於 API 變更。語意敘述應回到函式實作核對，不能只由命名判斷。
