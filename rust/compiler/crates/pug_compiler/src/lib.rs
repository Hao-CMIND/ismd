use pug_ast::{BlockNode, Token};
use pug_code_gen::{CodeGenOptions, generate_code};
use pug_error::PugError;
use pug_filters::handle_filters;
use pug_lexer::{LexerOptions, lex};
use pug_linker::link;
use pug_load::load_ast;
use pug_parser::{ParserOptions, parse};
use pug_strip_comments::{StripCommentsOptions, strip_comments};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileResult {
    pub body: String,
    pub dependencies: Vec<String>,
}

/// Host abstraction for synchronous same-thread callbacks (`plugins`, `filters`, `resolve`, `read`).
pub trait CompilerHost {
    fn pre_lex(&mut self, source: String, filename: Option<&str>) -> Result<String, PugError> {
        let _ = filename;
        Ok(source)
    }

    fn post_lex(&mut self, tokens: Vec<Token>) -> Result<Vec<Token>, PugError> {
        Ok(tokens)
    }

    fn pre_parse(&mut self, tokens: Vec<Token>) -> Result<Vec<Token>, PugError> {
        Ok(tokens)
    }

    fn post_parse(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn pre_load(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn post_load(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn pre_filters(&mut self, ast: BlockNode) -> Result<BlockNode, PugError> {
        Ok(ast)
    }

    fn run_filter(
        &mut self,
        name: &str,
        text: &str,
        attrs: &Value,
        line: usize,
        filename: Option<&str>,
    ) -> Result<String, PugError> {
        Err(pug_filters::unknown_filter_error(
            name,
            line,
            None,
            filename.map(String::from),
            None,
        ))
        .map(|_: ()| {
            let _ = (text, attrs);
            String::new()
        })
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
}

pub struct DefaultHost;
impl CompilerHost for DefaultHost {}

/// Main compilation pipeline matching `raw/compiler/packages/pug/lib/index.js` `compileBody`.
pub fn compile_body<H: CompilerHost>(
    source: &str,
    options: &CompileOptions,
    host: &mut H,
) -> Result<CompileResult, PugError> {
    let dependencies = Vec::new();
    let filename = options.filename.as_deref();

    // 1. preLex -> Lexer -> postLex
    let contents = host.pre_lex(source.to_string(), filename)?;
    let lex_opts = LexerOptions {
        filename: options.filename.clone(),
        ..LexerOptions::default()
    };
    let mut tokens = lex(&contents, &lex_opts)?;
    tokens = host.post_lex(tokens)?;

    // 2. Append `.pug` to extensionless path tokens
    for tok in &mut tokens {
        if tok.token_type == "path"
            && let Some(Value::String(ref mut p)) = tok.val
            && Path::new(p).extension().is_none()
        {
            p.push_str(".pug");
        }
    }

    // 3. stripComments -> preParse -> Parser -> postParse -> preLoad
    tokens = strip_comments(
        tokens,
        StripCommentsOptions::new(true, false, options.filename.clone()),
    )?;
    tokens = host.pre_parse(tokens)?;
    let parse_opts = ParserOptions {
        filename: options.filename.clone(),
        src: Some(contents.clone()),
    };
    let mut ast = parse(&tokens, &parse_opts)?;
    ast = host.post_parse(ast)?;
    ast = host.pre_load(ast)?;

    // 4. Load -> postLoad
    ast = load_ast(ast)?;
    ast = host.post_load(ast)?;

    // 5. preFilters -> handleFilters -> postFilters
    ast = host.pre_filters(ast)?;
    ast = handle_filters(ast, |name, text, attrs, line, file| {
        host.run_filter(name, text, attrs, line, file)
    })?;
    ast = host.post_filters(ast)?;

    // 6. preLink -> Linker -> postLink
    ast = host.pre_link(ast)?;
    ast = link(ast)?;
    ast = host.post_link(ast)?;

    // 7. preCodeGen -> generateCode -> postCodeGen
    ast = host.pre_code_gen(ast)?;
    let debug_sources_json = if options.include_sources {
        let mut map = serde_json::Map::new();
        let key = options
            .filename
            .clone()
            .unwrap_or_else(|| String::from("undefined"));
        map.insert(key, Value::String(source.to_string()));
        let json = serde_json::to_string(&Value::Object(map))
            .unwrap_or_else(|_| String::from("{}"));
        Some(pug_js::escape_js_stringify_chars(&json))
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
        src: Some(contents),
    };
    let js = match host.custom_generate_code(&ast)? {
        Some(custom_js) => custom_js,
        None => generate_code(&ast, &code_gen_opts)?,
    };
    let js = host.post_code_gen(js)?;

    Ok(CompileResult {
        body: js,
        dependencies,
    })
}
