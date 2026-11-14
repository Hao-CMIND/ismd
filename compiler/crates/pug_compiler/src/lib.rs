pub mod dag;
mod linked_view;
pub mod plugin;
pub mod session;
pub mod store;

pub use plugin::{LoadedNativePlugin, NativePluginManager};

use pug_ast::profile::{Stage, record_file, scope, with_counters};
use pug_ast::{BlockNode, RawContent, Token};
use pug_code_gen::{CodeGenOptions, generate_code};
use pug_error::PugError;
use pug_lexer::{LexerOptions, LexerPluginHook, LexerState, lex, lex_with_hook};
use pug_linker::link;
pub use pug_load::LoadedFile;
use pug_load::{LoadHost, annotate_load_error, load_ast};
use pug_parser::{ParserOptions, parse_owned_with_warnings};
use pug_strip_comments::{StripCommentsOptions, strip_comments};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
pub use dag::{DependencyEdge, DependencyGraph, DependencyGraphStats};
pub use session::{
    BatchEntryInput, BatchEntryOutput, CompilerSession, DEFAULT_PARALLEL_THRESHOLD,
    IncrementalUpdateReport, ParallelMode, compile_batch_with_mode, compile_batch_with_store,
};
pub use store::{
    DeclaredBlockMeta, DependencyKind, DependencyRef, ParseKey, ParsedTemplate, SourceEntry,
    TemplateId, TemplateStore, TemplateStoreStats, collect_ast_metadata, default_global_store,
    hash_bytes, normalize_cache_path,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompileOptions {
    pub filename: Option<String>,
    pub basedir: Option<String>,
    pub pretty: Option<String>,
    pub compile_debug: bool,
    pub doctype: Option<String>,
    pub inline_runtime_functions: bool,
    pub globals: Vec<String>,
    pub use_self: bool,
    pub include_sources: bool,
    pub template_name: String,
    pub filter_options: Value,
    pub filter_aliases: HashMap<String, String>,
    pub lex_plugin_methods: Vec<String>,
    pub native_plugins: Vec<String>,
    pub generic_syntax: Vec<pug_lexer::GenericSyntaxRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileResult {
    pub body: String,
    pub dependencies: Vec<String>,
}

/// Per-file context handed to the lexer/parser stage hooks (`options` of the baseline `load.string`).
#[derive(Debug, Clone, Copy)]
pub struct FileCtx<'a> {
    pub filename: Option<&'a str>,
    pub src: &'a str,
}

/// Host abstraction for synchronous same-thread callbacks (`plugins`, `filters`, `resolve`, `read`).
pub trait CompilerHost {
    fn pre_lex(&mut self, source: String, filename: Option<&str>) -> Result<String, PugError> {
        let _ = filename;
        Ok(source)
    }

    fn pre_lex_cow<'s>(
        &mut self,
        source: &'s str,
        filename: Option<&str>,
    ) -> Result<Cow<'s, str>, PugError> {
        self.pre_lex(source.to_string(), filename).map(Cow::Owned)
    }

    fn post_lex(&mut self, tokens: Vec<Token>, ctx: &FileCtx) -> Result<Vec<Token>, PugError> {
        let _ = ctx;
        Ok(tokens)
    }

    fn pre_parse(&mut self, tokens: Vec<Token>, ctx: &FileCtx) -> Result<Vec<Token>, PugError> {
        let _ = ctx;
        Ok(tokens)
    }

    fn post_parse(&mut self, ast: BlockNode, ctx: &FileCtx) -> Result<BlockNode, PugError> {
        let _ = ctx;
        Ok(ast)
    }

    fn pre_load(&mut self, ast: BlockNode, ctx: &FileCtx) -> Result<BlockNode, PugError> {
        let _ = ctx;
        Ok(ast)
    }

    /// `resolve` + `read` + `toString('utf8')` for one `include`/`extends` reference.
    ///
    /// The default implementation uses `load.resolve` / `fs.readFileSync` semantics and appends the
    /// baseline's `\n    at <filename> line <line>` suffix to any error message. Hosts that call back
    /// into JS (`plugins[].resolve` / `plugins[].read`) override this to keep JS error identity.
    fn load_file(
        &mut self,
        path: &str,
        source: Option<&str>,
        node_filename: Option<&str>,
        node_line: usize,
        options: &CompileOptions,
    ) -> Result<LoadedFile, PugError> {
        let result = (|| {
            let full_path = default_resolve(path, source, options.basedir.as_deref())?;
            let bytes = std::fs::read(&full_path)
                .map_err(|e| PugError::host_exception(format!("{e}, open '{full_path}'")))?;
            let raw = RawContent::Bytes(bytes);
            let text = raw.to_utf8_string();
            Ok(LoadedFile {
                full_path,
                raw,
                text,
            })
        })();
        result.map_err(|e| annotate_load_error(e, node_filename, node_line))
    }

    fn post_load(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn pre_filters(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn post_filters(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn pre_link(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn post_link(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn pre_code_gen(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn custom_generate_code(&mut self, _ast: &BlockNode) -> Result<Option<String>, PugError> {
        Ok(None)
    }

    fn post_code_gen(&mut self, js: String) -> Result<String, PugError> {
        Ok(js)
    }

    fn warn(&mut self, msg: &str) {
        let _ = msg;
    }

    fn call_lex_plugin(
        &mut self,
        method: &str,
        state: &mut LexerState,
    ) -> Result<bool, PugError> {
        let _ = (method, state);
        Ok(false)
    }

    fn has_custom_resolve(&self) -> bool {
        true
    }

    fn has_custom_read(&self) -> bool {
        true
    }

    fn has_lex_parse_hooks(&self) -> bool {
        true
    }

    fn supports_linked_view(&self) -> bool {
        false
    }
}

pub struct DefaultHost;
impl CompilerHost for DefaultHost {
    fn pre_lex_cow<'s>(
        &mut self,
        source: &'s str,
        _filename: Option<&str>,
    ) -> Result<Cow<'s, str>, PugError> {
        Ok(Cow::Borrowed(source))
    }

    fn has_custom_resolve(&self) -> bool {
        false
    }

    fn has_custom_read(&self) -> bool {
        false
    }

    fn has_lex_parse_hooks(&self) -> bool {
        false
    }

    fn supports_linked_view(&self) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// `load.resolve` (pug-load) with Node `path.join` / `path.dirname` semantics.
// ---------------------------------------------------------------------------

#[cfg(windows)]
const SEP: char = '\\';
#[cfg(not(windows))]
const SEP: char = '/';

fn is_sep(c: char) -> bool {
    if cfg!(windows) {
        c == '/' || c == '\\'
    } else {
        c == '/'
    }
}

/// Splits an optional root (`/`, `\`, `C:\`, `C:`) from the remainder.
fn split_root(p: &str) -> (String, &str) {
    let chars: Vec<char> = p.chars().collect();
    if cfg!(windows) && chars.len() >= 2 && chars[1] == ':' && chars[0].is_ascii_alphabetic() {
        if chars.len() >= 3 && is_sep(chars[2]) {
            return (format!("{}:{}", chars[0], SEP), &p[3..]);
        }
        return (format!("{}:", chars[0]), &p[2..]);
    }
    if !chars.is_empty() && is_sep(chars[0]) {
        return (SEP.to_string(), &p[1..]);
    }
    (String::new(), p)
}

/// `path.normalize` for the supported separator set.
fn normalize(p: &str) -> String {
    if p.is_empty() {
        return String::from(".");
    }
    let (root, rest) = split_root(p);
    let trailing = rest.chars().last().is_some_and(is_sep);
    let absolute = root.ends_with(SEP);
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let mut out = root;
    out.push_str(&parts.join(&SEP.to_string()));
    if out.is_empty() {
        out.push('.');
    }
    if trailing && !parts.is_empty() {
        out.push(SEP);
    }
    out
}

fn join(a: &str, b: &str) -> String {
    let joined = if a.is_empty() && b.is_empty() {
        String::new()
    } else {
        format!("{a}{SEP}{b}")
    };
    normalize(&joined)
}

/// `path.dirname`.
fn dirname(p: &str) -> String {
    if p.is_empty() {
        return String::from(".");
    }
    let (root, rest) = split_root(p);
    let trimmed = rest.trim_end_matches(is_sep);
    match trimmed.rfind(is_sep) {
        Some(idx) => {
            let dir = trimmed[..idx].trim_end_matches(is_sep);
            format!("{root}{dir}")
        }
        None => {
            if root.is_empty() {
                String::from(".")
            } else {
                root
            }
        }
    }
}

/// `load.resolve(filename, source, options)` from `pug-load@2.0.12`.
pub fn default_resolve(
    filename: &str,
    source: Option<&str>,
    basedir: Option<&str>,
) -> Result<String, PugError> {
    let filename = filename.trim();
    let absolute = filename.starts_with('/');
    let source = source.filter(|s| !s.is_empty());
    if !absolute && source.is_none() {
        return Err(PugError::host_exception(
            "the \"filename\" option is required to use includes and extends with \"relative\" paths",
        ));
    }
    let basedir = basedir.filter(|s| !s.is_empty());
    if absolute && basedir.is_none() {
        return Err(PugError::host_exception(
            "the \"basedir\" option is required to use includes and extends with \"absolute\" paths",
        ));
    }
    let base = if absolute {
        basedir.unwrap_or_default().to_string()
    } else {
        dirname(source.unwrap_or_default().trim())
    };
    Ok(join(&base, filename))
}

// ---------------------------------------------------------------------------
// Compilation session: Lexer -> StripComments -> Parser (+hooks) -> Loader.
// ---------------------------------------------------------------------------

struct LoadedSourceMeta {
    path: String,
    id: TemplateId,
    version: u64,
    content_hash: u64,
    byte_len: u64,
}

struct Session<'a, H: CompilerHost> {
    host: &'a mut H,
    options: &'a CompileOptions,
    store: &'a TemplateStore,
    dependencies: Vec<String>,
    dag_edges: HashMap<TemplateId, Vec<DependencyEdge>>,
    /// `debug_sources` of the baseline: insertion ordered, later writes overwrite the value in place.
    debug_sources: Vec<(String, String)>,
    last_loaded: Option<LoadedSourceMeta>,
}

struct HostLexBridge<'a, H: CompilerHost> {
    host: &'a mut H,
}

impl<H: CompilerHost> LexerPluginHook for HostLexBridge<'_, H> {
    fn call_lex(&mut self, method: &str, state: &mut LexerState) -> Result<bool, PugError> {
        self.host.call_lex_plugin(method, state)
    }
}

pub(crate) fn io_read_error(
    e: std::io::Error,
    full_path: &str,
    node_filename: Option<&str>,
    node_line: usize,
) -> PugError {
    let pug_err = match e.kind() {
        std::io::ErrorKind::NotFound => PugError::host_exception_with_code(
            "ENOENT",
            format!("ENOENT: no such file or directory, open '{full_path}'"),
        ),
        std::io::ErrorKind::PermissionDenied => PugError::host_exception_with_code(
            "EACCES",
            format!("EACCES: permission denied, open '{full_path}'"),
        ),
        _ => PugError::host_exception(format!("{e}, open '{full_path}'")),
    };
    annotate_load_error(pug_err, node_filename, node_line)
}

impl<H: CompilerHost> Session<'_, H> {
    fn record_source(&mut self, key: String, text: String) {
        if let Some(entry) = self.debug_sources.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = text;
        } else {
            self.debug_sources.push((key, text));
        }
    }

    fn lex_and_parse(&mut self, src: &str, filename: Option<&str>) -> Result<BlockNode, PugError> {
        let can_use_parse_cache = !self.host.has_lex_parse_hooks()
            && self.options.lex_plugin_methods.is_empty();

        if can_use_parse_cache && let Some(fname) = filename {
            let (id, source_version, content_hash, byte_len) =
                if let Some(ref meta) = self.last_loaded
                    && meta.path == fname
                {
                    (meta.id, meta.version, meta.content_hash, meta.byte_len)
                } else {
                    (
                        self.store.get_or_alloc_id(fname),
                        0,
                        hash_bytes(src.as_bytes()),
                        src.len() as u64,
                    )
                };

            let key = ParseKey {
                normalized_path: normalize_cache_path(fname),
                filename: fname.to_string(),
                content_hash,
                byte_len,
                source_version,
                lex_plugin_methods: Vec::new(),
            };

            if let Some(cached) = self.store.get_parsed(&key) {
                with_counters(|c| {
                    c.parse_cache_hit_count += 1;
                    c.ast_clone_count += 1;
                });
                record_file(Some(fname), |fc| fc.parse_cache_hit_count += 1);
                for warning in &cached.warnings {
                    self.host.warn(warning);
                }
                return Ok((*cached.ast).clone());
            }

            let (ast, warnings) = self.lex_strip_and_parse(src, Some(fname), false)?;
            for warning in &warnings {
                self.host.warn(warning);
            }
            let meta = collect_ast_metadata(&ast);
            let ast_arc = Arc::new(ast.clone());
            self.store.insert_parsed(
                key,
                ParsedTemplate {
                    id,
                    source_version,
                    content_hash,
                    filename: Arc::from(fname),
                    ast: ast_arc,
                    direct_dependencies: meta.dependencies,
                    declared_blocks: meta.declared_blocks,
                    has_filters: meta.has_filters,
                    has_yield: meta.has_yield,
                    warnings,
                },
            );
            return Ok(ast);
        }

        self.lex_and_parse_uncached(src, filename)
    }

    fn lex_strip_and_parse(
        &mut self,
        src: &str,
        filename: Option<&str>,
        with_lex_hooks: bool,
    ) -> Result<(BlockNode, Vec<String>), PugError> {
        lex_strip_and_parse_with_store(src, filename, self.options, self.host, with_lex_hooks)
    }

    /// `options.lex` + `options.parse` of the baseline `compileBody` for one file, ending with `preLoad`.
    fn lex_and_parse_uncached(
        &mut self,
        src: &str,
        filename: Option<&str>,
    ) -> Result<BlockNode, PugError> {
        let ctx = FileCtx { filename, src };
        let (mut ast, warnings) = self.lex_strip_and_parse(src, filename, true)?;
        for warning in warnings {
            self.host.warn(&warning);
        }
        ast = self.host.post_parse(ast, &ctx)?;
        self.host.pre_load(ast, &ctx)
    }
}

pub(crate) fn lex_strip_and_parse_with_store<H: CompilerHost>(
    src: &str,
    filename: Option<&str>,
    options: &CompileOptions,
    host: &mut H,
    with_lex_hooks: bool,
) -> Result<(BlockNode, Vec<String>), PugError> {
    let ctx = FileCtx { filename, src };
    let contents = if with_lex_hooks {
        host.pre_lex_cow(src, filename)?
    } else {
        Cow::Borrowed(src)
    };
    let lex_opts = LexerOptions {
        filename: filename.map(String::from),
        plugin_methods: options.lex_plugin_methods.clone(),
        generic_syntax: options.generic_syntax.clone(),
        ..LexerOptions::default()
    };
    let mut tokens = {
        let _g = scope(Stage::Lexer);
        with_counters(|c| c.lexer_count += 1);
        record_file(filename, |fc| fc.lexer_count += 1);
        if lex_opts.plugin_methods.is_empty() {
            lex(&contents, &lex_opts)?
        } else {
            let mut bridge = HostLexBridge { host };
            lex_with_hook(&contents, &lex_opts, &mut bridge)?
        }
    };
    if with_lex_hooks {
        tokens = host.post_lex(tokens, &ctx)?;
    }

    // parse adapter: append `.pug` to extensionless path tokens
    for tok in &mut tokens {
        if tok.token_type == "path"
            && let Some(Value::String(ref mut p)) = tok.val
            && node_extname(p).is_empty()
        {
            p.push_str(".pug");
        }
    }
    tokens = {
        let _g = scope(Stage::StripComments);
        strip_comments(
            tokens,
            StripCommentsOptions::new(true, false, filename.map(String::from)),
        )?
    };
    if with_lex_hooks {
        tokens = host.pre_parse(tokens, &ctx)?;
    }
    let parse_opts = ParserOptions {
        filename: filename.map(String::from),
        src: Some(src.to_string()),
    };
    let _g = scope(Stage::Parser);
    with_counters(|c| c.parser_count += 1);
    record_file(filename, |fc| fc.parser_count += 1);
    parse_owned_with_warnings(tokens, &parse_opts)
}

/// `path.extname` (basename based; a leading dot alone is not an extension).
fn node_extname(p: &str) -> String {
    let base = p.rsplit(is_sep).next().unwrap_or(p);
    match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(idx) => {
            if base == ".." {
                String::new()
            } else {
                base[idx..].to_string()
            }
        }
    }
}

impl<H: CompilerHost> LoadHost for Session<'_, H> {
    fn load_file(
        &mut self,
        path: &str,
        source: Option<&str>,
        node_filename: Option<&str>,
        node_line: usize,
    ) -> Result<LoadedFile, PugError> {
        if !self.host.has_custom_resolve() && !self.host.has_custom_read() {
            let full_path = {
                let _prof_res = scope(Stage::Resolve);
                with_counters(|c| c.resolve_count += 1);
                self.store.resolve_path(
                    path,
                    source,
                    self.options.basedir.as_deref(),
                    || {
                        default_resolve(path, source, self.options.basedir.as_deref())
                            .map_err(|e| annotate_load_error(e, node_filename, node_line))
                    },
                )?
            };
            let (entry, _hit) = self
                .store
                .load_or_read_disk(&full_path)
                .map_err(|e| io_read_error(e, &full_path, node_filename, node_line))?;
            self.last_loaded = Some(LoadedSourceMeta {
                path: full_path.clone(),
                id: entry.id,
                version: entry.version,
                content_hash: entry.content_hash,
                byte_len: entry.byte_len,
            });
            let loaded = LoadedFile {
                full_path,
                raw: entry.to_raw_content(),
                text: entry.text.to_string(),
            };
            if let Some(parent_path) = source.or(self.options.filename.as_deref()) {
                let parent_id = self.store.get_or_alloc_id(parent_path);
                let child_id = entry.id;
                self.dag_edges
                    .entry(parent_id)
                    .or_default()
                    .push(DependencyEdge {
                        target: child_id,
                        kind: DependencyKind::Include,
                    });
            }
            self.dependencies.push(loaded.full_path.clone());
            if self.options.include_sources {
                self.record_source(loaded.full_path.clone(), loaded.text.clone());
            }
            return Ok(loaded);
        }

        let loaded = self
            .host
            .load_file(path, source, node_filename, node_line, self.options)?;
        if let Some(parent_path) = source.or(self.options.filename.as_deref()) {
            let parent_id = self.store.get_or_alloc_id(parent_path);
            let child_id = self.store.get_or_alloc_id(&loaded.full_path);
            self.dag_edges
                .entry(parent_id)
                .or_default()
                .push(DependencyEdge {
                    target: child_id,
                    kind: DependencyKind::Include,
                });
        }
        self.dependencies.push(loaded.full_path.clone());
        if self.options.include_sources {
            self.record_source(loaded.full_path.clone(), loaded.text.clone());
        }
        Ok(loaded)
    }

    fn parse_source(&mut self, src: &str, filename: &str) -> Result<BlockNode, PugError> {
        self.lex_and_parse(src, Some(filename))
    }
}

fn debug_sources_json(entries: &[(String, String)]) -> String {
    let mut out = String::from("{");
    for (i, (k, v)) in entries.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(k).unwrap_or_else(|_| String::from("\"\"")));
        out.push(':');
        out.push_str(&serde_json::to_string(v).unwrap_or_else(|_| String::from("\"\"")));
    }
    out.push('}');
    out
}

/// Main compilation pipeline matching `raw/compiler/packages/pug/lib/index.js` `compileBody`.
pub fn compile_body<H: CompilerHost>(
    source: &str,
    options: &CompileOptions,
    host: &mut H,
) -> Result<CompileResult, PugError> {
    compile_body_with_store(source, options, host, default_global_store())
}

pub fn compile_body_with_store<H: CompilerHost>(
    source: &str,
    options: &CompileOptions,
    host: &mut H,
    store: &TemplateStore,
) -> Result<CompileResult, PugError> {
    let _other = scope(Stage::Other);

    let has_native_plugins = !options.native_plugins.is_empty();
    let mut opts_buf;
    let effective_options = if has_native_plugins {
        let mut mgr = store.plugins.write().unwrap();
        for p in &options.native_plugins {
            mgr.load_plugin(std::path::Path::new(p))?;
        }
        if options.generic_syntax.is_empty() {
            opts_buf = options.clone();
            opts_buf.generic_syntax = mgr.syntax_rules().to_vec();
            &opts_buf
        } else {
            options
        }
    } else {
        options
    };

    if !has_native_plugins {
        if let Some(result) = linked_view::try_compile_linked_view(source, effective_options, host, store)? {
            return Ok(result);
        }
    }

    let mut session = Session {
        host,
        options: effective_options,
        store,
        dependencies: Vec::new(),
        dag_edges: HashMap::new(),
        debug_sources: Vec::new(),
        last_loaded: None,
    };
    if options.include_sources {
        session.record_source(
            options
                .filename
                .clone()
                .unwrap_or_else(|| String::from("undefined")),
            source.to_string(),
        );
    }

    // 1. lex + parse the entry file, then load every dependency recursively
    let parsed = session.lex_and_parse(source, options.filename.as_deref())?;
    let mut ast = {
        let _g = scope(Stage::Loader);
        load_ast(parsed, &mut session)?
    };
    ast = session.host.post_load(ast)?;

    if let Some(ref fname) = options.filename {
        let entry_id = store.get_or_alloc_id(fname);
        session.dag_edges.entry(entry_id).or_default();
    }
    for (parent_id, edges) in std::mem::take(&mut session.dag_edges) {
        store.dag().set_dependencies(parent_id, edges);
    }

    let dependencies = std::mem::take(&mut session.dependencies);
    let debug_sources = std::mem::take(&mut session.debug_sources);
    let host = session.host;

    // 2. preFilters -> postFilters (Filters stage is handled via NativePluginManager)
    ast = host.pre_filters(ast)?;
    ast = host.post_filters(ast)?;

    // 3. preLink -> Linker -> postLink
    ast = host.pre_link(ast)?;
    ast = {
        let _g = scope(Stage::Linker);
        link(ast)?
    };
    ast = host.post_link(ast)?;

    if has_native_plugins {
        let mgr = store.plugins.read().unwrap();
        mgr.transform_ast(&mut ast)?;
    }

    // 4. preCodeGen -> generateCode -> postCodeGen
    ast = host.pre_code_gen(ast)?;
    let debug_sources_json = if options.include_sources {
        Some(pug_js::escape_js_stringify_chars(&debug_sources_json(
            &debug_sources,
        )))
    } else {
        None
    };
    let code_gen_opts = CodeGenOptions {
        compile_debug: options.compile_debug,
        pretty: options.pretty.clone(),
        doctype: options.doctype.clone(),
        inline_runtime_functions: options.inline_runtime_functions,
        globals: options.globals.clone(),
        use_self: options.use_self,
        include_sources: options.include_sources,
        debug_sources_json,
        template_name: if options.template_name.is_empty() {
            String::from("template")
        } else {
            options.template_name.clone()
        },
        filename: options.filename.clone(),
        src: Some(source.to_string()),
    };
    let js = match host.custom_generate_code(&ast)? {
        Some(custom_js) => custom_js,
        None => {
            let _g = scope(Stage::Codegen);
            generate_code(&ast, &code_gen_opts)?
        }
    };
    let js = host.post_code_gen(js)?;

    Ok(CompileResult {
        body: js,
        dependencies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_relative_requires_filename() {
        let err = default_resolve("a.pug", None, None).unwrap_err();
        assert!(err.message.contains("\"filename\" option is required"));
    }

    #[test]
    fn resolve_absolute_requires_basedir() {
        let err = default_resolve("/a.pug", Some("x.pug"), None).unwrap_err();
        assert!(err.message.contains("\"basedir\" option is required"));
    }

    #[test]
    fn resolve_joins_and_normalizes() {
        let joined = default_resolve("../b/c.pug", Some("a/main.pug"), None).unwrap();
        assert_eq!(joined, format!("b{SEP}c.pug"));
        let from_base = default_resolve(" /x/y.pug ", Some("m.pug"), Some("base")).unwrap();
        assert_eq!(from_base, format!("base{SEP}x{SEP}y.pug"));
        let bare = default_resolve("c.pug", Some("main.pug"), None).unwrap();
        assert_eq!(bare, "c.pug");
    }

    #[test]
    fn extname_matches_node() {
        assert_eq!(node_extname("a.pug"), ".pug");
        assert_eq!(node_extname("a"), "");
        assert_eq!(node_extname(".hidden"), "");
        assert_eq!(node_extname("a."), ".");
        assert_eq!(node_extname("dir.d/a"), "");
    }

    #[test]
    fn template_store_shares_layout_and_includes_across_pages() {
        let dir = std::env::temp_dir().join(format!(
            "pug_store_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let layout_path = dir.join("layout.pug");
        let header_path = dir.join("header.pug");
        let footer_path = dir.join("footer.pug");
        std::fs::write(&header_path, "header.site Header\n").unwrap();
        std::fs::write(&footer_path, "footer.site Footer\n").unwrap();
        std::fs::write(
            &layout_path,
            "html\n  body\n    include header.pug\n    block content\n    include footer.pug\n",
        )
        .unwrap();

        let store = TemplateStore::new();
        let mut results = Vec::new();
        for i in 1..=5 {
            let page_path = dir.join(format!("page{i}.pug"));
            let page_src = format!("extends layout.pug\nblock content\n  p Page {i}\n");
            let opts = CompileOptions {
                filename: Some(page_path.to_string_lossy().into_owned()),
                ..CompileOptions::default()
            };
            let mut host = DefaultHost;
            let res = compile_body_with_store(&page_src, &opts, &mut host, &store).unwrap();
            assert!(res.body.contains(&format!("Page {i}")));
            assert_eq!(res.dependencies.len(), 3);
            results.push(res.body);
        }

        let stats = store.stats();
        // 3 dependency sources read & parsed once across 5 pages -> 4 misses (1 each for layout/header/footer? 3 misses!),
        // then 4 hits on pages 2..5 => 3 * 4 = 12 source hits & 12 parse hits!
        assert_eq!(stats.sources, 3);
        assert_eq!(stats.source_misses, 3);
        assert_eq!(stats.source_hits, 12);
        assert_eq!(stats.parse_hits, 12);

        // Update header in virtual store and confirm invalidation/re-parse updates output cleanly.
        store.update_virtual_source(
            &header_path.to_string_lossy(),
            String::from("header.site UpdatedHeader\n"),
        );
        let page_opts = CompileOptions {
            filename: Some(dir.join("page1.pug").to_string_lossy().into_owned()),
            ..CompileOptions::default()
        };
        let mut host = DefaultHost;
        let updated = compile_body_with_store(
            "extends layout.pug\nblock content\n  p Page 1\n",
            &page_opts,
            &mut host,
            &store,
        )
        .unwrap();
        assert!(updated.body.contains("UpdatedHeader"));
        assert!(!updated.body.contains(">Header<"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn template_store_isolates_different_filename_parse_keys() {
        let dir = std::env::temp_dir().join(format!(
            "pug_store_key_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a/inc.pug"), "p same\n").unwrap();
        std::fs::write(dir.join("b/inc.pug"), "p same\n").unwrap();

        let store = TemplateStore::new();
        let mut host = DefaultHost;
        let res_a = compile_body_with_store(
            "include inc.pug",
            &CompileOptions {
                filename: Some(dir.join("a/main.pug").to_string_lossy().into_owned()),
                compile_debug: true,
                ..CompileOptions::default()
            },
            &mut host,
            &store,
        )
        .unwrap();
        let res_b = compile_body_with_store(
            "include inc.pug",
            &CompileOptions {
                filename: Some(dir.join("b/main.pug").to_string_lossy().into_owned()),
                compile_debug: true,
                ..CompileOptions::default()
            },
            &mut host,
            &store,
        )
        .unwrap();

        assert_ne!(res_a.dependencies, res_b.dependencies);
        assert!(res_a.body.contains("a"));
        assert!(res_b.body.contains("b"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    struct ForceMutableHost;
    impl CompilerHost for ForceMutableHost {
        fn pre_lex_cow<'s>(
            &mut self,
            source: &'s str,
            _filename: Option<&str>,
        ) -> Result<Cow<'s, str>, PugError> {
            Ok(Cow::Borrowed(source))
        }
        fn has_custom_resolve(&self) -> bool {
            false
        }
        fn has_custom_read(&self) -> bool {
            false
        }
        fn has_lex_parse_hooks(&self) -> bool {
            false
        }
        fn supports_linked_view(&self) -> bool {
            false
        }
    }

    #[test]
    fn linked_view_matches_mutable_linker_across_inheritance_and_yield() {
        let dir = std::env::temp_dir().join(format!(
            "pug_linked_view_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("base.pug"),
            "html\n  head\n    block head\n      title Base\n  body\n    include inc.pug\n      p YieldedFromBase\n    block content\n      p BaseContent\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("mid.pug"),
            "extends base.pug\nmixin midMixin(x)\n  span.mid= x\nappend head\n  meta(charset=\"utf-8\")\nblock content\n  .mid\n    block inner\n      p DefaultInner\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("inc.pug"),
            "section.card\n  .body\n    yield\n",
        )
        .unwrap();
        std::fs::write(dir.join("raw.txt"), "RAW_OK").unwrap();

        let page_src = "extends mid.pug\nmixin pageMixin(y)\n  em= y\nprepend head\n  link(rel=\"icon\")\nappend inner\n  +midMixin('A')\n  +pageMixin('B')\n  p\n    include raw.txt\n";
        let opts = CompileOptions {
            filename: Some(dir.join("page.pug").to_string_lossy().into_owned()),
            include_sources: true,
            ..CompileOptions::default()
        };

        let store_lv = TemplateStore::new();
        let mut fast_host = DefaultHost;
        let fast_res = compile_body_with_store(page_src, &opts, &mut fast_host, &store_lv).unwrap();

        let store_mut = TemplateStore::new();
        let mut mut_host = ForceMutableHost;
        let mut_res = compile_body_with_store(page_src, &opts, &mut mut_host, &store_mut).unwrap();

        assert_eq!(fast_res.body, mut_res.body);
        assert_eq!(fast_res.dependencies, mut_res.dependencies);
        assert!(fast_res.body.contains("YieldedFromBase"));
        assert!(fast_res.body.contains("RAW_OK"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compiler_session_compiles_batch_and_updates_virtual_files() {
        let dir = std::env::temp_dir().join(format!(
            "pug_session_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let layout_path = dir.join("layout.pug");
        let p1 = dir.join("p1.pug");
        let p2 = dir.join("p2.pug");
        std::fs::write(&layout_path, "html\n  body\n    block content\n").unwrap();
        std::fs::write(&p1, "extends layout.pug\nblock content\n  p One\n").unwrap();
        std::fs::write(&p2, "extends layout.pug\nblock content\n  p Two\n").unwrap();

        let session = CompilerSession::new(CompileOptions {
            basedir: Some(dir.to_string_lossy().into_owned()),
            ..CompileOptions::default()
        });
        let entries = vec![
            BatchEntryInput {
                id: String::from("p1"),
                filename: Some(p1.to_string_lossy().into_owned()),
                source: None,
                options: None,
            },
            BatchEntryInput {
                id: String::from("p2"),
                filename: Some(p2.to_string_lossy().into_owned()),
                source: None,
                options: None,
            },
        ];

        let out1 = session.compile_entries(&entries);
        assert_eq!(out1.len(), 2);
        assert!(out1[0].ok && out1[1].ok);
        assert!(out1[0].body.as_ref().unwrap().contains("One"));
        assert!(out1[1].body.as_ref().unwrap().contains("Two"));

        session.update_files(&[(
            layout_path.to_string_lossy().into_owned(),
            String::from("html\n  body.updated\n    block content\n"),
        )]);
        let out2 = session.compile_entries(&entries);
        assert!(out2[0].body.as_ref().unwrap().contains("updated"));
        assert!(out2[1].body.as_ref().unwrap().contains("updated"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parallel_batch_compile_matches_serial_deterministically() {
        let dir = std::env::temp_dir().join(format!(
            "pug_parallel_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("layout.pug"), "html\n  body\n    block content\n").unwrap();
        let mut entries = Vec::new();
        for i in 1..=32 {
            let p = dir.join(format!("p{i}.pug"));
            std::fs::write(
                &p,
                format!("extends layout.pug\nblock content\n  p= 'Page ' + {i}\n"),
            )
            .unwrap();
            entries.push(BatchEntryInput {
                id: format!("p{i}"),
                filename: Some(p.to_string_lossy().into_owned()),
                source: None,
                options: None,
            });
        }

        let opts = CompileOptions {
            basedir: Some(dir.to_string_lossy().into_owned()),
            ..CompileOptions::default()
        };
        let serial = compile_batch_with_mode(
            &entries,
            &opts,
            &TemplateStore::new(),
            ParallelMode::ForceSerial,
        );
        let parallel = compile_batch_with_mode(
            &entries,
            &opts,
            &TemplateStore::new(),
            ParallelMode::ForceParallel,
        );

        assert_eq!(serial.len(), 32);
        assert_eq!(parallel.len(), 32);
        for (s, p) in serial.iter().zip(parallel.iter()) {
            assert_eq!(s.id, p.id);
            assert!(s.ok && p.ok);
            assert_eq!(s.body, p.body);
            assert_eq!(s.dependencies, p.dependencies);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dependency_dag_tracks_extends_includes_multi_page_and_cycles() {
        let dir = std::env::temp_dir().join(format!(
            "pug-dag-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let base = dir.join("base.pug");
        let layout = dir.join("layout.pug");
        let header = dir.join("header.pug");
        let footer = dir.join("footer.pug");
        let nested = dir.join("nested.pug");
        let page1 = dir.join("page1.pug");
        let page2 = dir.join("page2.pug");
        let page_inc = dir.join("page_inc.pug");

        std::fs::write(&base, "html\n  body\n    block body\n").unwrap();
        std::fs::write(
            &layout,
            "extends base.pug\nblock body\n  include header.pug\n  block content\n  include footer.pug\n",
        )
        .unwrap();
        std::fs::write(&header, "header\n  include nested.pug\n").unwrap();
        std::fs::write(&footer, "footer Footer\n").unwrap();
        std::fs::write(&nested, "span Nested\n").unwrap();
        let page1_src = "extends layout.pug\nblock content\n  p Page 1\n";
        let page2_src = "extends layout.pug\nblock content\n  p Page 2\n";
        let page_inc_src = "div\n  include header.pug\n";
        std::fs::write(&page1, page1_src).unwrap();
        std::fs::write(&page2, page2_src).unwrap();
        std::fs::write(&page_inc, page_inc_src).unwrap();

        let store = TemplateStore::new();
        let mut host = DefaultHost;
        for (path, src) in [
            (&page1, page1_src),
            (&page2, page2_src),
            (&page_inc, page_inc_src),
        ] {
            let opts = CompileOptions {
                filename: Some(path.to_string_lossy().into_owned()),
                ..CompileOptions::default()
            };
            compile_body_with_store(src, &opts, &mut host, &store).unwrap();
        }

        let base_id = store.id_for_path(base.to_str().unwrap()).unwrap();
        let layout_id = store.id_for_path(layout.to_str().unwrap()).unwrap();
        let header_id = store.id_for_path(header.to_str().unwrap()).unwrap();
        let footer_id = store.id_for_path(footer.to_str().unwrap()).unwrap();
        let nested_id = store.id_for_path(nested.to_str().unwrap()).unwrap();
        let page1_id = store.id_for_path(page1.to_str().unwrap()).unwrap();
        let page2_id = store.id_for_path(page2.to_str().unwrap()).unwrap();
        let page_inc_id = store.id_for_path(page_inc.to_str().unwrap()).unwrap();

        // Forward edges: page1 -> layout -> base + header + footer, header -> nested
        assert_eq!(store.dag().direct_dependencies(page1_id), vec![layout_id]);
        assert_eq!(
            store.dag().direct_dependencies(layout_id),
            vec![base_id, header_id, footer_id]
        );
        assert_eq!(store.dag().direct_dependencies(header_id), vec![nested_id]);

        // Reverse closure from nested.pug reaches header, layout, page1, page2, page_inc without duplicates.
        let affected_from_nested = store.dag().collect_affected(&[nested_id]);
        for expected in [nested_id, header_id, layout_id, page1_id, page2_id, page_inc_id] {
            assert!(affected_from_nested.contains(&expected));
        }
        assert!(!affected_from_nested.contains(&base_id));
        assert!(!affected_from_nested.contains(&footer_id));
        let unique: std::collections::HashSet<TemplateId> =
            affected_from_nested.iter().copied().collect();
        assert_eq!(unique.len(), affected_from_nested.len());

        // Reverse closure from footer.pug only affects layout, page1, page2 (not page_inc).
        let affected_from_footer = store.dag().collect_affected(&[footer_id]);
        assert!(affected_from_footer.contains(&layout_id));
        assert!(affected_from_footer.contains(&page1_id));
        assert!(affected_from_footer.contains(&page2_id));
        assert!(!affected_from_footer.contains(&page_inc_id));

        // Circular dependency in DependencyGraph terminates cleanly with no duplicates.
        let cycle_dag = DependencyGraph::new();
        let a = TemplateId(100);
        let b = TemplateId(101);
        cycle_dag.set_dependencies(
            a,
            vec![DependencyEdge {
                target: b,
                kind: DependencyKind::Include,
            }],
        );
        cycle_dag.set_dependencies(
            b,
            vec![DependencyEdge {
                target: a,
                kind: DependencyKind::Include,
            }],
        );
        let cycle_affected = cycle_dag.collect_affected(&[a]);
        assert_eq!(cycle_affected.len(), 2);
        assert!(cycle_affected.contains(&a) && cycle_affected.contains(&b));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn incremental_invalidation_handles_page_include_layout_noop_and_sequential_edits() {
        let dir = std::env::temp_dir().join(format!(
            "pug-inc-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let header = dir.join("header.pug");
        let footer = dir.join("footer.pug");
        let layout = dir.join("layout.pug");
        let header_src = "header InitialHeader\n";
        let footer_src = "footer InitialFooter\n";
        let layout_src =
            "html\n  body\n    include header.pug\n    block content\n    include footer.pug\n";
        std::fs::write(&header, header_src).unwrap();
        std::fs::write(&footer, footer_src).unwrap();
        std::fs::write(&layout, layout_src).unwrap();

        let mut entries = Vec::new();
        let mut page_paths = Vec::new();
        for i in 1..=10 {
            let p = dir.join(format!("page{i}.pug"));
            std::fs::write(
                &p,
                format!("extends layout.pug\nblock content\n  p Page {i}\n"),
            )
            .unwrap();
            let p_str = p.to_string_lossy().into_owned();
            entries.push(BatchEntryInput {
                id: p_str.clone(),
                filename: Some(p_str.clone()),
                source: None,
                options: None,
            });
            page_paths.push(p_str);
        }

        let session = CompilerSession::new(CompileOptions {
            basedir: Some(dir.to_string_lossy().into_owned()),
            ..CompileOptions::default()
        });
        let initial = session.compile_entries(&entries);
        assert_eq!(initial.len(), 10);
        assert!(initial.iter().all(|o| o.ok));

        // Test D: Updating with identical source is a complete no-op
        let noop_report = session.update_files_incremental(&[(
            header.to_string_lossy().into_owned(),
            header_src.to_string(),
        )]);
        assert!(!noop_report.changed);
        assert!(noop_report.changed_files.is_empty());
        assert!(noop_report.invalidated_templates.is_empty());
        assert!(noop_report.affected_entries.is_empty());
        assert!(session.compile_affected_with_mode(ParallelMode::Auto(8)).is_empty());

        // Test A: Modifying a single page affects ONLY that page; layout/header/footer stay cached
        let stats_before_page = session.stats();
        let page5_path = page_paths[4].clone();
        let page_report = session.update_files_incremental(&[(
            page5_path.clone(),
            "extends layout.pug\nblock content\n  p Page 5 Updated\n".to_string(),
        )]);
        assert!(page_report.changed);
        assert_eq!(page_report.affected_entries, vec![page5_path.clone()]);
        let page_out = session.compile_affected_with_mode(ParallelMode::Auto(8));
        assert_eq!(page_out.len(), 1);
        assert_eq!(page_out[0].id, page5_path);
        assert!(page_out[0].body.as_deref().unwrap().contains("Page 5 Updated"));
        let stats_after_page = session.stats();
        // layout + header + footer = 3 parse cache hits
        assert_eq!(stats_after_page.parse_hits - stats_before_page.parse_hits, 3);
        assert_eq!(stats_after_page.parse_misses - stats_before_page.parse_misses, 1);

        // Test B: Modifying header.pug affects all 10 pages, while layout/footer/pages stay parsed
        let stats_before_header = session.stats();
        let header_report = session.update_files_incremental(&[(
            header.to_string_lossy().into_owned(),
            "header HotHeader\n".to_string(),
        )]);
        assert!(header_report.changed);
        assert_eq!(header_report.affected_entries.len(), 10);
        let header_out = session.compile_affected_with_mode(ParallelMode::Auto(8));
        assert_eq!(header_out.len(), 10);
        assert!(header_out
            .iter()
            .all(|o| o.body.as_deref().unwrap().contains("HotHeader")));
        let stats_after_header = session.stats();
        // Only header.pug was reparsed (1 miss); layout + footer + 10 pages hit cache (or >= 20 hits)
        assert!(stats_after_header.parse_hits > stats_before_header.parse_hits);

        // Test C: Modifying layout.pug affects all 10 pages, header/footer/pages stay cached
        let stats_before_layout = session.stats();
        let layout_report = session.update_files_incremental(&[(
            layout.to_string_lossy().into_owned(),
            "html\n  body.v2\n    include header.pug\n    block content\n    include footer.pug\n"
                .to_string(),
        )]);
        assert!(layout_report.changed);
        assert_eq!(layout_report.affected_entries.len(), 10);
        let layout_out = session.compile_affected_with_mode(ParallelMode::Auto(8));
        assert_eq!(layout_out.len(), 10);
        assert!(layout_out
            .iter()
            .all(|o| o.body.as_deref().unwrap().contains("v2")));
        let stats_after_layout = session.stats();
        assert!(stats_after_layout.parse_hits > stats_before_layout.parse_hits);

        // Test E: Sequential edits header -> page1 -> footer leave no stale output
        session.update_files_incremental(&[(
            header.to_string_lossy().into_owned(),
            "header SeqHeader\n".to_string(),
        )]);
        let _ = session.compile_affected_with_mode(ParallelMode::Auto(8));
        session.update_files_incremental(&[(
            page_paths[0].clone(),
            "extends layout.pug\nblock content\n  p Page 1 Seq\n".to_string(),
        )]);
        let p1_out = session.compile_affected_with_mode(ParallelMode::Auto(8));
        assert_eq!(p1_out.len(), 1);
        assert!(p1_out[0].body.as_deref().unwrap().contains("SeqHeader"));
        assert!(p1_out[0].body.as_deref().unwrap().contains("Page 1 Seq"));
        session.update_files_incremental(&[(
            footer.to_string_lossy().into_owned(),
            "footer SeqFooter\n".to_string(),
        )]);
        let footer_out = session.compile_affected_with_mode(ParallelMode::Auto(8));
        assert_eq!(footer_out.len(), 10);
        assert!(footer_out[0].body.as_deref().unwrap().contains("SeqHeader"));
        assert!(footer_out[0].body.as_deref().unwrap().contains("Page 1 Seq"));
        assert!(footer_out[0].body.as_deref().unwrap().contains("SeqFooter"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_native_dynamic_plugin_uppercase_poc() {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let candidates = [
            manifest_dir.join("../../target/debug/pug_filter_uppercase.dll"),
            manifest_dir.join("../../target/debug/libpug_filter_uppercase.so"),
            manifest_dir.join("../../target/debug/libpug_filter_uppercase.dylib"),
            manifest_dir.join("../../../target/debug/pug_filter_uppercase.dll"),
        ];
        let plugin_path = candidates
            .into_iter()
            .find(|p| p.exists())
            .expect("pug_filter_uppercase dynamic library must exist in target/debug");

        let opts = CompileOptions {
            native_plugins: vec![plugin_path.to_string_lossy().into_owned()],
            ..Default::default()
        };

        struct SpyHost;
        impl CompilerHost for SpyHost {}

        let mut host = SpyHost;
        let store = std::sync::Arc::new(TemplateStore::new());

        // 1. Single compile with :uppercase
        let res = compile_body_with_store(":uppercase\n  hello world", &opts, &mut host, &store).unwrap();
        assert!(res.body.contains("HELLO WORLD"), "Expected 'HELLO WORLD', got: {}", res.body);
        assert!(!res.body.contains("hello world"));

        // 2. Verify plugin is cached in store and not reloaded
        let plugins_guard = store.plugins.read().unwrap();
        assert_eq!(plugins_guard.plugins().len(), 1);
        assert_eq!(plugins_guard.plugins()[0].plugin_id, "pug_filter_uppercase");
        assert!(plugins_guard.plugins()[0].is_thread_safe);
        drop(plugins_guard);

        // Second compile with same store
        let res2 = compile_body_with_store(":uppercase\n  another native text", &opts, &mut host, &store).unwrap();
        assert!(res2.body.contains("ANOTHER NATIVE TEXT"));

        // 3. Batch compile through CompilerSession with Rayon parallel mode
        let entries: Vec<BatchEntryInput> = (0..10)
            .map(|i| BatchEntryInput {
                id: format!("page{i}.pug"),
                filename: Some(format!("page{i}.pug")),
                source: Some(format!("div\n  :uppercase\n    page content {i}")),
                options: Some(opts.clone()),
            })
            .collect();

        let opts_clone = opts.clone();
        let batch_out = compile_batch_with_mode(&entries, &opts_clone, &store, ParallelMode::ForceParallel);
        assert_eq!(batch_out.len(), 10);
        for (i, out) in batch_out.iter().enumerate() {
            assert!(out.ok);
            let body = out.body.as_deref().unwrap();
            let expected = format!("PAGE CONTENT {i}");
            assert!(body.contains(&expected), "Expected '{expected}' in output: {body}");
        }
    }
}
