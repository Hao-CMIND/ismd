use pug_ast::profile::{Stage, scope, with_counters};
use pug_ast::{BlockNode, RawContent, Token};
use pug_code_gen::{CodeGenOptions, generate_code};
use pug_error::PugError;
use pug_filters::{FilterInvocation, handle_filters};
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

    fn run_filter(&mut self, call: &FilterInvocation<'_>) -> Result<String, PugError> {
        Err(pug_filters::unknown_filter_error(
            call.filter_name,
            call.line,
            call.column,
            call.node_filename.map(String::from),
            None,
        ))
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

struct Session<'a, H: CompilerHost> {
    host: &'a mut H,
    options: &'a CompileOptions,
    dependencies: Vec<String>,
    /// `debug_sources` of the baseline: insertion ordered, later writes overwrite the value in place.
    debug_sources: Vec<(String, String)>,
}

struct HostLexBridge<'a, H: CompilerHost> {
    host: &'a mut H,
}

impl<H: CompilerHost> LexerPluginHook for HostLexBridge<'_, H> {
    fn call_lex(&mut self, method: &str, state: &mut LexerState) -> Result<bool, PugError> {
        self.host.call_lex_plugin(method, state)
    }
}

impl<H: CompilerHost> Session<'_, H> {
    fn record_source(&mut self, key: String, text: String) {
        if let Some(entry) = self.debug_sources.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = text;
        } else {
            self.debug_sources.push((key, text));
        }
    }

    /// `options.lex` + `options.parse` of the baseline `compileBody` for one file, ending with `preLoad`.
    fn lex_and_parse(&mut self, src: &str, filename: Option<&str>) -> Result<BlockNode, PugError> {
        let ctx = FileCtx { filename, src };

        // lex: preLex -> lexer -> postLex
        let contents = self.host.pre_lex_cow(src, filename)?;
        let lex_opts = LexerOptions {
            filename: filename.map(String::from),
            plugin_methods: self.options.lex_plugin_methods.clone(),
            ..LexerOptions::default()
        };
        let mut tokens = {
            let _g = scope(Stage::Lexer);
            with_counters(|c| c.lexer_count += 1);
            if lex_opts.plugin_methods.is_empty() {
                lex(&contents, &lex_opts)?
            } else {
                let mut bridge = HostLexBridge { host: self.host };
                lex_with_hook(&contents, &lex_opts, &mut bridge)?
            }
        };
        tokens = self.host.post_lex(tokens, &ctx)?;

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
        tokens = self.host.pre_parse(tokens, &ctx)?;
        let parse_opts = ParserOptions {
            filename: filename.map(String::from),
            src: Some(src.to_string()),
        };
        let (mut ast, warnings) = {
            let _g = scope(Stage::Parser);
            with_counters(|c| c.parser_count += 1);
            parse_owned_with_warnings(tokens, &parse_opts)?
        };
        for warning in warnings {
            self.host.warn(&warning);
        }
        ast = self.host.post_parse(ast, &ctx)?;
        self.host.pre_load(ast, &ctx)
    }
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
        let loaded = self
            .host
            .load_file(path, source, node_filename, node_line, self.options)?;
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
    let _other = scope(Stage::Other);
    let mut session = Session {
        host,
        options,
        dependencies: Vec::new(),
        debug_sources: Vec::new(),
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

    let dependencies = std::mem::take(&mut session.dependencies);
    let debug_sources = std::mem::take(&mut session.debug_sources);
    let host = session.host;

    // 2. preFilters -> handleFilters -> postFilters
    ast = host.pre_filters(ast)?;
    ast = {
        let _g = scope(Stage::Filters);
        handle_filters(
            ast,
            &options.filter_options,
            &options.filter_aliases,
            &mut |call: &FilterInvocation<'_>| host.run_filter(call),
        )?
    };
    ast = host.post_filters(ast)?;

    // 3. preLink -> Linker -> postLink
    ast = host.pre_link(ast)?;
    ast = {
        let _g = scope(Stage::Linker);
        link(ast)?
    };
    ast = host.post_link(ast)?;

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
}
