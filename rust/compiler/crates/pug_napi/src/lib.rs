use napi::bindgen_prelude::*;
use napi::{Env, JsValue};
use napi_derive::napi;
use pug_ast::{BlockNode, RawContent, Token};
use pug_compiler::{CompileOptions, CompilerHost, FileCtx, LoadedFile, compile_body, default_resolve};
use pug_error::{ErrorOptions, PugError};
use pug_lexer::{LexerOptions, lex};
use pug_load::{LoadHost, annotate_load_error, load_ast};
use pug_parser::{ParserOptions, parse_json_tokens};
use pug_strip_comments::{StripCommentsOptions, strip_comments_json};
use pug_walk::walk_json_ast;
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
    pub plain_error: Option<String>,
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

#[napi]
pub fn add_with_sync(
    obj: String,
    src: String,
    exclude: Option<Vec<String>>,
) -> Result<String> {
    let ex = exclude.unwrap_or_default();
    pug_js::add_with_checked(&obj, &src, &ex).map_err(|e| napi::Error::from_reason(e.message))
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
    pub plain_error: Option<String>,
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
                plain_error: None,
            })
        }
        Ok(Err(pug_err)) => Ok(NapiJsonOutcome {
            ok: false,
            data: None,
            error: Some(NapiPugErrorDto::from(pug_err)),
            plain_error: None,
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
            plain_error: None,
        }),
        Ok(Err(pug_err)) => Ok(NapiJsonOutcome {
            ok: false,
            data: None,
            error: Some(NapiPugErrorDto::from(pug_err)),
            plain_error: None,
        }),
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in strip_comments_sync",
        )),
    }
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiParserOptions {
    pub filename: Option<String>,
    pub src: Option<String>,
}

#[napi]
pub fn parse_sync(
    tokens: Vec<Value>,
    options: Option<NapiParserOptions>,
) -> Result<NapiJsonOutcome> {
    let opts = options.unwrap_or_default();
    let parse_opts = ParserOptions {
        filename: opts.filename,
        src: opts.src,
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        parse_json_tokens(&tokens, &parse_opts)
    }));
    match outcome {
        Ok(Ok(ast)) => {
            let val = serde_json::to_value(ast)
                .map_err(|e| napi::Error::from_reason(format!("Failed to serialize AST: {e}")))?;
            Ok(NapiJsonOutcome {
                ok: true,
                data: Some(val),
                error: None,
                plain_error: None,
            })
        }
        Ok(Err(pug_err)) => Ok(NapiJsonOutcome {
            ok: false,
            data: None,
            error: Some(NapiPugErrorDto::from(pug_err)),
            plain_error: None,
        }),
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in parse_sync",
        )),
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiWalkStepInput {
    pub node: Value,
    pub array_allowed: bool,
    pub parents: Vec<Value>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiWalkStepResult {
    pub cont: Option<bool>,
    pub replaced: bool,
    pub replacement: Option<Value>,
}

#[napi]
pub fn walk_sync(
    env: Env,
    ast: Value,
    include_dependencies: Option<bool>,
    initial_parents: Option<Vec<Value>>,
    callbacks: Object,
) -> Result<Value> {
    let before_cb: Option<Function<NapiWalkStepInput, NapiWalkStepResult>> =
        if callbacks.has_named_property("before")? {
            callbacks.get_named_property("before")?
        } else {
            None
        };
    let after_cb: Option<Function<NapiWalkStepInput, NapiWalkStepResult>> =
        if callbacks.has_named_property("after")? {
            callbacks.get_named_property("after")?
        } else {
            None
        };

    let pending_js_err: std::cell::RefCell<Option<napi::Error>> = std::cell::RefCell::new(None);
    let mut parents = initial_parents.unwrap_or_default();

    let res = walk_json_ast(
        ast,
        &mut |node, array_allowed, cur_parents| {
            let Some(ref cb) = before_cb else {
                return Ok((true, None));
            };
            let input = NapiWalkStepInput {
                node: node.clone(),
                array_allowed,
                parents: cur_parents.to_vec(),
            };
            match cb.call(input) {
                Ok(step_res) => {
                    let cont = step_res.cont.unwrap_or(true);
                    let rep = if step_res.replaced {
                        step_res.replacement
                    } else {
                        None
                    };
                    Ok((cont, rep))
                }
                Err(e) => {
                    let msg = e.to_string();
                    *pending_js_err.borrow_mut() = Some(e);
                    Err(msg)
                }
            }
        },
        &mut |node, array_allowed, cur_parents| {
            let Some(ref cb) = after_cb else {
                return Ok(None);
            };
            let input = NapiWalkStepInput {
                node: node.clone(),
                array_allowed,
                parents: cur_parents.to_vec(),
            };
            match cb.call(input) {
                Ok(step_res) => {
                    let rep = if step_res.replaced {
                        step_res.replacement
                    } else {
                        None
                    };
                    Ok(rep)
                }
                Err(e) => {
                    let msg = e.to_string();
                    *pending_js_err.borrow_mut() = Some(e);
                    Err(msg)
                }
            }
        },
        include_dependencies.unwrap_or(false),
        &mut parents,
    );

    let _ = env;
    match res {
        Ok(final_ast) => Ok(final_ast),
        Err(msg) => {
            if let Some(js_err) = pending_js_err.into_inner() {
                Err(js_err)
            } else {
                Err(napi::Error::from_reason(msg))
            }
        }
    }
}

struct NodeHostAdapter<'env> {
    env: Env,
    callbacks: Option<Object<'env>>,
    pending_js_error: Option<napi::Error>,
}

fn unknown_to_raw_content<'env>(
    env: &Env,
    val: Unknown<'env>,
) -> Result<(RawContent, String)> {
    if val.is_buffer()? {
        let buf = Buffer::from_unknown(val)?;
        let bytes = buf.to_vec();
        let raw = RawContent::Bytes(bytes);
        let text = raw.to_utf8_string();
        return Ok((raw, text));
    }
    let text: String = env.from_js_value(val)?;
    Ok((RawContent::Text(text.clone()), text))
}

impl<'env> NodeHostAdapter<'env> {
    fn get_optional_val(&self, name: &str) -> Result<Option<Unknown<'env>>> {
        let Some(ref obj) = self.callbacks else {
            return Ok(None);
        };
        if !obj.has_named_property(name)? {
            return Ok(None);
        }
        let val: Unknown<'env> = obj.get_named_property(name)?;
        if val.get_type()? == ValueType::Undefined || val.get_type()? == ValueType::Null {
            return Ok(None);
        }
        Ok(Some(val))
    }

    fn get_unary_fn(
        &self,
        name: &str,
    ) -> Result<Option<Function<'env, Unknown<'env>, Unknown<'env>>>> {
        let Some(val) = self.get_optional_val(name)? else {
            return Ok(None);
        };
        Ok(Some(Function::from_unknown(val)?))
    }

    fn get_ctx_fn(
        &self,
        name: &str,
    ) -> Result<
        Option<
            Function<
                'env,
                FnArgs<(Unknown<'env>, Option<String>, Option<String>)>,
                Unknown<'env>,
            >,
        >,
    > {
        let Some(val) = self.get_optional_val(name)? else {
            return Ok(None);
        };
        Ok(Some(Function::from_unknown(val)?))
    }

    fn get_filter_fn(
        &self,
    ) -> Result<Option<Function<'env, FnArgs<(String, String, Unknown<'env>)>, String>>> {
        let Some(val) = self.get_optional_val("filter")? else {
            return Ok(None);
        };
        Ok(Some(Function::from_unknown(val)?))
    }

    fn record_js_err(&mut self, err: napi::Error) -> PugError {
        let msg = err.to_string();
        self.pending_js_error = Some(err);
        PugError::host_exception(msg)
    }

    fn call_json_hook<T>(&mut self, hook_name: &str, value: T) -> std::result::Result<T, PugError>
    where
        T: serde::Serialize + serde::de::DeserializeOwned,
    {
        let cb_opt = self.get_unary_fn(hook_name).map_err(|e| self.record_js_err(e))?;
        let Some(cb) = cb_opt else {
            return Ok(value);
        };

        let json_val = serde_json::to_value(&value).map_err(|e| {
            PugError::host_exception(format!("Failed to serialize {hook_name}: {e}"))
        })?;
        let js_arg = self
            .env
            .to_js_value(&json_val)
            .map_err(|e| self.record_js_err(e))?;
        let ret_unknown = cb.call(js_arg).map_err(|e| self.record_js_err(e))?;
        let ret_json: Value = self
            .env
            .from_js_value(ret_unknown)
            .map_err(|e| self.record_js_err(e))?;
        serde_json::from_value(ret_json).map_err(|e| {
            PugError::host_exception(format!("Invalid return value from {hook_name}: {e}"))
        })
    }

    fn call_ctx_json_hook<T>(
        &mut self,
        hook_name: &str,
        value: T,
        ctx: &FileCtx,
    ) -> std::result::Result<T, PugError>
    where
        T: serde::Serialize + serde::de::DeserializeOwned,
    {
        let cb_opt = self.get_ctx_fn(hook_name).map_err(|e| self.record_js_err(e))?;
        let Some(cb) = cb_opt else {
            return Ok(value);
        };

        let json_val = serde_json::to_value(&value).map_err(|e| {
            PugError::host_exception(format!("Failed to serialize {hook_name}: {e}"))
        })?;
        let js_arg = self
            .env
            .to_js_value(&json_val)
            .map_err(|e| self.record_js_err(e))?;
        let ret_unknown = cb
            .call(FnArgs::from((
                js_arg,
                ctx.filename.map(String::from),
                Some(ctx.src.to_string()),
            )))
            .map_err(|e| self.record_js_err(e))?;
        let ret_json: Value = self
            .env
            .from_js_value(ret_unknown)
            .map_err(|e| self.record_js_err(e))?;
        serde_json::from_value(ret_json).map_err(|e| {
            PugError::host_exception(format!("Invalid return value from {hook_name}: {e}"))
        })
    }
}

impl<'env> CompilerHost for NodeHostAdapter<'env> {
    fn pre_lex(
        &mut self,
        source: String,
        filename: Option<&str>,
    ) -> std::result::Result<String, PugError> {
        let val_opt = self
            .get_optional_val("preLex")
            .map_err(|e| self.record_js_err(e))?;
        let Some(val) = val_opt else {
            return Ok(source);
        };
        let cb: Function<'env, FnArgs<(String, Option<String>)>, String> =
            Function::from_unknown(val).map_err(|e| self.record_js_err(e))?;
        cb.call(FnArgs::from((source, filename.map(String::from))))
            .map_err(|e| self.record_js_err(e))
    }

    fn post_lex(
        &mut self,
        tokens: Vec<Token>,
        ctx: &FileCtx,
    ) -> std::result::Result<Vec<Token>, PugError> {
        self.call_ctx_json_hook("postLex", tokens, ctx)
    }

    fn pre_parse(
        &mut self,
        tokens: Vec<Token>,
        ctx: &FileCtx,
    ) -> std::result::Result<Vec<Token>, PugError> {
        self.call_ctx_json_hook("preParse", tokens, ctx)
    }

    fn post_parse(
        &mut self,
        ast: BlockNode,
        ctx: &FileCtx,
    ) -> std::result::Result<BlockNode, PugError> {
        self.call_ctx_json_hook("postParse", ast, ctx)
    }

    fn pre_load(
        &mut self,
        ast: BlockNode,
        ctx: &FileCtx,
    ) -> std::result::Result<BlockNode, PugError> {
        self.call_ctx_json_hook("preLoad", ast, ctx)
    }

    fn load_file(
        &mut self,
        path: &str,
        source: Option<&str>,
        node_filename: Option<&str>,
        node_line: usize,
        options: &CompileOptions,
    ) -> std::result::Result<LoadedFile, PugError> {
        let resolve_val = self
            .get_optional_val("resolve")
            .map_err(|e| self.record_js_err(e))?;

        let full_path = if let Some(val) = resolve_val {
            let cb: Function<
                'env,
                FnArgs<(String, Option<String>, Option<String>, u32)>,
                String,
            > = Function::from_unknown(val).map_err(|e| self.record_js_err(e))?;
            cb.call(FnArgs::from((
                path.to_string(),
                source.map(String::from),
                node_filename.map(String::from),
                node_line as u32,
            )))
            .map_err(|e| self.record_js_err(e))?
        } else {
            default_resolve(path, source, options.basedir.as_deref())
                .map_err(|e| annotate_load_error(e, node_filename, node_line))?
        };

        let read_val = self
            .get_optional_val("read")
            .map_err(|e| self.record_js_err(e))?;

        if let Some(val) = read_val {
            let cb: Function<'env, FnArgs<(String, Option<String>, u32)>, Unknown<'env>> =
                Function::from_unknown(val).map_err(|e| self.record_js_err(e))?;
            let ret = cb
                .call(FnArgs::from((
                    full_path.clone(),
                    node_filename.map(String::from),
                    node_line as u32,
                )))
                .map_err(|e| self.record_js_err(e))?;
            let (raw, text) = unknown_to_raw_content(&self.env, ret)
                .map_err(|e| self.record_js_err(e))?;
            Ok(LoadedFile {
                full_path,
                raw,
                text,
            })
        } else {
            let bytes = std::fs::read(&full_path).map_err(|e| {
                annotate_load_error(
                    PugError::host_exception(format!("{e}, open '{full_path}'")),
                    node_filename,
                    node_line,
                )
            })?;
            let raw = RawContent::Bytes(bytes);
            let text = raw.to_utf8_string();
            Ok(LoadedFile {
                full_path,
                raw,
                text,
            })
        }
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
        let cb_opt = self
            .get_filter_fn()
            .map_err(|e| self.record_js_err(e))?;
        let Some(cb) = cb_opt else {
            return Err(pug_filters::unknown_filter_error(
                name,
                line,
                None,
                filename.map(String::from),
                None,
            ));
        };

        let js_attrs = self
            .env
            .to_js_value(attrs)
            .map_err(|e| self.record_js_err(e))?;

        cb.call(FnArgs::from((
            name.to_string(),
            text.to_string(),
            js_attrs,
        )))
        .map_err(|e| self.record_js_err(e))
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
        let cb_opt = self
            .get_unary_fn("generateCode")
            .map_err(|e| self.record_js_err(e))?;
        let Some(cb) = cb_opt else {
            return Ok(None);
        };
        let json_val = serde_json::to_value(ast).map_err(|e| {
            PugError::host_exception(format!("Failed to serialize generateCode AST: {e}"))
        })?;
        let js_arg = self
            .env
            .to_js_value(&json_val)
            .map_err(|e| self.record_js_err(e))?;
        let ret_unknown = cb.call(js_arg).map_err(|e| self.record_js_err(e))?;
        let s: String = self
            .env
            .from_js_value(ret_unknown)
            .map_err(|e| self.record_js_err(e))?;
        Ok(Some(s))
    }

    fn post_code_gen(&mut self, js: String) -> std::result::Result<String, PugError> {
        self.call_json_hook("postCodeGen", js)
    }
}

struct NapiLoadHost<'env> {
    env: Env,
    callbacks: Object<'env>,
    basedir: Option<String>,
    pending_js_error: Option<napi::Error>,
}

impl<'env> NapiLoadHost<'env> {
    fn record_js_err(&mut self, err: napi::Error) -> PugError {
        let msg = err.to_string();
        self.pending_js_error = Some(err);
        PugError::host_exception(msg)
    }
}

impl<'env> LoadHost for NapiLoadHost<'env> {
    fn load_file(
        &mut self,
        path: &str,
        source: Option<&str>,
        node_filename: Option<&str>,
        node_line: usize,
    ) -> std::result::Result<LoadedFile, PugError> {
        let has_resolve = self
            .callbacks
            .has_named_property("resolve")
            .map_err(|e| self.record_js_err(e))?;
        let full_path = if has_resolve {
            let val: Unknown<'env> = self
                .callbacks
                .get_named_property("resolve")
                .map_err(|e| self.record_js_err(e))?;
            if val.get_type().map_err(|e| self.record_js_err(e))? == ValueType::Function {
                let cb: Function<
                    'env,
                    FnArgs<(String, Option<String>, Option<String>, u32)>,
                    String,
                > = Function::from_unknown(val).map_err(|e| self.record_js_err(e))?;
                cb.call(FnArgs::from((
                    path.to_string(),
                    source.map(String::from),
                    node_filename.map(String::from),
                    node_line as u32,
                )))
                .map_err(|e| self.record_js_err(e))?
            } else {
                default_resolve(path, source, self.basedir.as_deref())
                    .map_err(|e| annotate_load_error(e, node_filename, node_line))?
            }
        } else {
            default_resolve(path, source, self.basedir.as_deref())
                .map_err(|e| annotate_load_error(e, node_filename, node_line))?
        };

        let read_cb: Function<'env, FnArgs<(String, Option<String>, u32)>, Unknown<'env>> = self
            .callbacks
            .get_named_property("read")
            .map_err(|e| self.record_js_err(e))?;
        let ret = read_cb
            .call(FnArgs::from((
                full_path.clone(),
                node_filename.map(String::from),
                node_line as u32,
            )))
            .map_err(|e| self.record_js_err(e))?;
        let (raw, text) =
            unknown_to_raw_content(&self.env, ret).map_err(|e| self.record_js_err(e))?;
        Ok(LoadedFile {
            full_path,
            raw,
            text,
        })
    }

    fn parse_source(
        &mut self,
        src: &str,
        filename: &str,
    ) -> std::result::Result<BlockNode, PugError> {
        let cb: Function<'env, FnArgs<(String, String)>, Unknown<'env>> = self
            .callbacks
            .get_named_property("parseSource")
            .map_err(|e| self.record_js_err(e))?;
        let ret = cb
            .call(FnArgs::from((src.to_string(), filename.to_string())))
            .map_err(|e| self.record_js_err(e))?;
        let json_val: Value = self
            .env
            .from_js_value(ret)
            .map_err(|e| self.record_js_err(e))?;
        serde_json::from_value(json_val).map_err(|e| {
            PugError::host_exception(format!("Invalid AST returned by parse: {e}"))
        })
    }
}

#[napi]
pub fn default_resolve_sync(
    filename: String,
    source: Option<String>,
    basedir: Option<String>,
) -> NapiJsonOutcome {
    match default_resolve(&filename, source.as_deref(), basedir.as_deref()) {
        Ok(resolved) => NapiJsonOutcome {
            ok: true,
            data: Some(Value::String(resolved)),
            error: None,
            plain_error: None,
        },
        Err(e) => NapiJsonOutcome {
            ok: false,
            data: None,
            error: None,
            plain_error: Some(e.message),
        },
    }
}

#[napi]
pub fn load_sync(
    env: Env,
    ast: Value,
    basedir: Option<String>,
    callbacks: Object,
) -> Result<NapiJsonOutcome> {
    let block: BlockNode = match serde_json::from_value(ast) {
        Ok(b) => b,
        Err(e) => {
            return Ok(NapiJsonOutcome {
                ok: false,
                data: None,
                error: None,
                plain_error: Some(format!("Invalid AST passed to load_sync: {e}")),
            });
        }
    };
    let mut host = NapiLoadHost {
        env,
        callbacks,
        basedir,
        pending_js_error: None,
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        load_ast(block, &mut host)
    }));
    match outcome {
        Ok(Ok(loaded)) => {
            let data = serde_json::to_value(loaded).map_err(|e| {
                napi::Error::from_reason(format!("Failed to serialize loaded AST: {e}"))
            })?;
            Ok(NapiJsonOutcome {
                ok: true,
                data: Some(data),
                error: None,
                plain_error: None,
            })
        }
        Ok(Err(pug_err)) => {
            if let Some(js_err) = host.pending_js_error.take() {
                Err(js_err)
            } else {
                Ok(NapiJsonOutcome {
                    ok: false,
                    data: None,
                    error: None,
                    plain_error: Some(pug_err.message),
                })
            }
        }
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in load_sync",
        )),
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
            plain_error: None,
        }),
        Ok(Err(pug_err)) => {
            if let Some(js_err) = host.pending_js_error.take() {
                return Err(js_err);
            }
            if pug_err.is_js_host_exception {
                return Ok(NapiCompileOutcome {
                    ok: false,
                    body: None,
                    dependencies: None,
                    error: None,
                    plain_error: Some(pug_err.message),
                });
            }
            Ok(NapiCompileOutcome {
                ok: false,
                body: None,
                dependencies: None,
                error: Some(NapiPugErrorDto::from(pug_err)),
                plain_error: None,
            })
        }
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in compile_body_sync",
        )),
    }
}
