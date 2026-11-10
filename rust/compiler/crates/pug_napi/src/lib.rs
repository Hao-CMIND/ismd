use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use pug_ast::{BlockNode, Token};
use pug_compiler::{CompileOptions, CompilerHost, compile_body};
use pug_error::{ErrorOptions, PugError};
use pug_lexer::{LexerOptions, lex};
use pug_strip_comments::{StripCommentsOptions, strip_comments_json};
use serde_json::Value;

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiErrorOptions {
    pub line: i64,
    pub column: Option<i64>,
    pub filename: Option<String>,
    pub src: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiPugErrorDto {
    pub code: String,
    pub msg: String,
    pub line: i64,
    pub column: Option<i64>,
    pub filename: Option<String>,
    pub src: Option<String>,
    pub message: String,
}

impl From<PugError> for NapiPugErrorDto {
    fn from(err: PugError) -> Self {
        Self {
            code: err.code,
            msg: err.msg,
            line: err.line,
            column: err.column,
            filename: err.filename,
            src: err.src,
            message: err.message,
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiCompileOptions {
    pub filename: Option<String>,
    pub basedir: Option<String>,
    pub pretty: Option<String>,
    pub compile_debug: Option<bool>,
    pub doctype: Option<String>,
    pub inline_runtime_functions: Option<bool>,
    pub globals: Option<Vec<String>>,
    pub use_self: Option<bool>,
    pub include_sources: Option<bool>,
    pub template_name: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiCompileOutcome {
    pub ok: bool,
    pub body: Option<String>,
    pub dependencies: Option<Vec<String>>,
    pub error: Option<NapiPugErrorDto>,
}

#[napi]
pub fn make_error_dto(
    code: String,
    message: String,
    options: NapiErrorOptions,
) -> NapiPugErrorDto {
    let err = PugError::new(
        code,
        message,
        ErrorOptions {
            line: options.line,
            column: options.column,
            filename: options.filename,
            src: options.src,
        },
    );
    NapiPugErrorDto::from(err)
}

#[napi]
pub fn runtime_build(functions: Vec<String>) -> String {
    pug_runtime::build(&functions)
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiLexerOptions {
    pub filename: Option<String>,
    pub interpolated: Option<bool>,
    pub starting_line: Option<i64>,
    pub starting_column: Option<i64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiJsonOutcome {
    pub ok: bool,
    pub data: Option<Value>,
    pub error: Option<NapiPugErrorDto>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiStripCommentsOptions {
    pub strip_unbuffered: Option<bool>,
    pub strip_buffered: Option<bool>,
    pub filename: Option<String>,
}

#[napi]
pub fn lex_sync(source: String, options: Option<NapiLexerOptions>) -> Result<NapiJsonOutcome> {
    let opts = options.unwrap_or_default();
    let lex_opts = LexerOptions {
        filename: opts.filename,
        interpolated: opts.interpolated.unwrap_or(false),
        starting_line: opts.starting_line.map(|n| n as usize),
        starting_column: opts.starting_column.map(|n| n as usize),
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        lex(&source, &lex_opts)
    }));
    match outcome {
        Ok(Ok(tokens)) => {
            let val = serde_json::to_value(tokens)
                .map_err(|e| napi::Error::from_reason(format!("Failed to serialize tokens: {e}")))?;
            Ok(NapiJsonOutcome {
                ok: true,
                data: Some(val),
                error: None,
            })
        }
        Ok(Err(pug_err)) => Ok(NapiJsonOutcome {
            ok: false,
            data: None,
            error: Some(NapiPugErrorDto::from(pug_err)),
        }),
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in lex_sync",
        )),
    }
}

#[napi]
pub fn strip_comments_sync(
    tokens: Vec<Value>,
    options: Option<NapiStripCommentsOptions>,
) -> Result<NapiJsonOutcome> {
    let opts = options.unwrap_or_default();
    let strip_opts = StripCommentsOptions::new(
        opts.strip_unbuffered.unwrap_or(true),
        opts.strip_buffered.unwrap_or(false),
        opts.filename,
    );
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        strip_comments_json(tokens, strip_opts)
    }));
    match outcome {
        Ok(Ok(stripped)) => Ok(NapiJsonOutcome {
            ok: true,
            data: Some(Value::Array(stripped)),
            error: None,
        }),
        Ok(Err(pug_err)) => Ok(NapiJsonOutcome {
            ok: false,
            data: None,
            error: Some(NapiPugErrorDto::from(pug_err)),
        }),
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in strip_comments_sync",
        )),
    }
}

struct NodeHostAdapter<'env> {
    env: Env,
    callbacks: Option<Object<'env>>,
    pending_js_error: Option<napi::Error>,
}

impl<'env> NodeHostAdapter<'env> {
    fn get_unary_fn(
        &self,
        name: &str,
    ) -> Result<Option<Function<'env, Unknown<'env>, Unknown<'env>>>> {
        let Some(ref obj) = self.callbacks else {
            return Ok(None);
        };
        if !obj.has_named_property(name)? {
            return Ok(None);
        }
        obj.get_named_property(name)
    }

    fn get_filter_fn(
        &self,
    ) -> Result<Option<Function<'env, FnArgs<(String, String, Unknown<'env>)>, String>>> {
        let Some(ref obj) = self.callbacks else {
            return Ok(None);
        };
        if !obj.has_named_property("filter")? {
            return Ok(None);
        }
        obj.get_named_property("filter")
    }

    fn call_json_hook<T>(&mut self, hook_name: &str, value: T) -> std::result::Result<T, PugError>
    where
        T: serde::Serialize + serde::de::DeserializeOwned,
    {
        let cb_opt = self.get_unary_fn(hook_name).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        let Some(cb) = cb_opt else {
            return Ok(value);
        };

        let json_val = serde_json::to_value(&value).map_err(|e| {
            PugError::host_exception(format!("Failed to serialize {hook_name}: {e}"))
        })?;
        let js_arg = self.env.to_js_value(&json_val).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        let ret_unknown = cb.call(js_arg).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        let ret_json: Value = self.env.from_js_value(ret_unknown).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        serde_json::from_value(ret_json).map_err(|e| {
            PugError::host_exception(format!("Invalid return value from {hook_name}: {e}"))
        })
    }
}

impl<'env> CompilerHost for NodeHostAdapter<'env> {
    fn pre_lex(
        &mut self,
        source: String,
        _filename: Option<&str>,
    ) -> std::result::Result<String, PugError> {
        self.call_json_hook("preLex", source)
    }

    fn post_lex(&mut self, tokens: Vec<Token>) -> std::result::Result<Vec<Token>, PugError> {
        self.call_json_hook("postLex", tokens)
    }

    fn pre_parse(&mut self, tokens: Vec<Token>) -> std::result::Result<Vec<Token>, PugError> {
        self.call_json_hook("preParse", tokens)
    }

    fn post_parse(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("postParse", ast)
    }

    fn pre_load(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("preLoad", ast)
    }

    fn post_load(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("postLoad", ast)
    }

    fn pre_filters(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("preFilters", ast)
    }

    fn run_filter(
        &mut self,
        name: &str,
        text: &str,
        attrs: &Value,
        line: usize,
        filename: Option<&str>,
    ) -> std::result::Result<String, PugError> {
        let cb_opt = self.get_filter_fn().map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        let Some(cb) = cb_opt else {
            return Err(pug_filters::unknown_filter_error(
                name,
                line,
                None,
                filename.map(String::from),
                None,
            ));
        };

        let js_attrs = self.env.to_js_value(attrs).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;

        cb.call(FnArgs::from((
            name.to_string(),
            text.to_string(),
            js_attrs,
        )))
        .map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })
    }

    fn post_filters(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("postFilters", ast)
    }

    fn pre_link(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("preLink", ast)
    }

    fn post_link(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("postLink", ast)
    }

    fn pre_code_gen(&mut self, ast: BlockNode) -> std::result::Result<BlockNode, PugError> {
        self.call_json_hook("preCodeGen", ast)
    }

    fn custom_generate_code(
        &mut self,
        ast: &BlockNode,
    ) -> std::result::Result<Option<String>, PugError> {
        let cb_opt = self.get_unary_fn("generateCode").map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        let Some(cb) = cb_opt else {
            return Ok(None);
        };
        let json_val = serde_json::to_value(ast).map_err(|e| {
            PugError::host_exception(format!("Failed to serialize generateCode AST: {e}"))
        })?;
        let js_arg = self.env.to_js_value(&json_val).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        let ret_unknown = cb.call(js_arg).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        let s: String = self.env.from_js_value(ret_unknown).map_err(|e| {
            let msg = e.to_string();
            self.pending_js_error = Some(e);
            PugError::host_exception(msg)
        })?;
        Ok(Some(s))
    }

    fn post_code_gen(&mut self, js: String) -> std::result::Result<String, PugError> {
        self.call_json_hook("postCodeGen", js)
    }
}

#[napi]
pub fn compile_body_sync(
    env: Env,
    source: String,
    options: NapiCompileOptions,
    callbacks: Option<Object>,
) -> Result<NapiCompileOutcome> {
    let compile_opts = CompileOptions {
        filename: options.filename,
        basedir: options.basedir,
        pretty: options.pretty,
        compile_debug: options.compile_debug.unwrap_or(false),
        doctype: options.doctype,
        inline_runtime_functions: options.inline_runtime_functions.unwrap_or(false),
        globals: options.globals.unwrap_or_default(),
        use_self: options.use_self.unwrap_or(false),
        include_sources: options.include_sources.unwrap_or(false),
        template_name: options
            .template_name
            .unwrap_or_else(|| String::from("template")),
    };

    let mut host = NodeHostAdapter {
        env,
        callbacks,
        pending_js_error: None,
    };

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        compile_body(&source, &compile_opts, &mut host)
    }));

    match outcome {
        Ok(Ok(res)) => Ok(NapiCompileOutcome {
            ok: true,
            body: Some(res.body),
            dependencies: Some(res.dependencies),
            error: None,
        }),
        Ok(Err(pug_err)) => {
            if let Some(js_err) = host.pending_js_error.take() {
                return Err(js_err);
            }
            Ok(NapiCompileOutcome {
                ok: false,
                body: None,
                dependencies: None,
                error: Some(NapiPugErrorDto::from(pug_err)),
            })
        }
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in compile_body_sync",
        )),
    }
}
