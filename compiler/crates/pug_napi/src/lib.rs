use napi::bindgen_prelude::*;
use napi::{Env, JsValue};
use napi_derive::napi;
use pug_ast::{Attribute, BlockNode, RawContent, Token};
use pug_attrs::{AttrsFormat, compile_attrs};
use pug_compiler::{
    BatchEntryInput, BatchEntryOutput, CompileOptions, CompilerHost, CompilerSession,
    DEFAULT_PARALLEL_THRESHOLD, FileCtx, IncrementalUpdateReport, LoadedFile, ParallelMode,
    TemplateStore, TemplateStoreStats, compile_batch_with_mode, compile_body_with_store,
    default_global_store, default_resolve,
};
use pug_error::{ErrorOptions, PugError};
use pug_filters::{FilterCallMode, FilterInvocation, handle_filters};
use pug_lexer::{LexerOptions, LexerPluginHook, LexerState, lex, lex_with_hook};
use pug_linker::link;
use pug_load::{LoadHost, annotate_load_error, load_ast};
use pug_parser::{ParserOptions, parse_json_tokens_with_warnings};
use pug_strip_comments::{StripCommentsOptions, strip_comments_json};
use pug_walk::walk_json_ast;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

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
    pub filter_options: Option<Value>,
    pub filter_aliases: Option<HashMap<String, String>>,
    pub lex_plugin_methods: Option<Vec<String>>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiCompileOutcome {
    pub ok: bool,
    pub body: Option<String>,
    pub dependencies: Option<Vec<String>>,
    pub error: Option<NapiPugErrorDto>,
    pub plain_error: Option<String>,
    pub plain_error_code: Option<String>,
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
    pub plugin_methods: Option<Vec<String>>,
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

struct NapiLexBridge<'env> {
    env: Env,
    cb: Function<'env, FnArgs<(String, Unknown<'env>)>, Unknown<'env>>,
    pending_js_error: Option<napi::Error>,
}

#[derive(serde::Deserialize)]
struct JsLexStepResult {
    handled: bool,
    state: LexerState,
}

fn invoke_js_lex_step<'env>(
    env: Env,
    cb: &Function<'env, FnArgs<(String, Unknown<'env>)>, Unknown<'env>>,
    method: &str,
    state: &mut LexerState,
    pending_js_error: &mut Option<napi::Error>,
) -> std::result::Result<bool, PugError> {
    let record = |e: napi::Error, slot: &mut Option<napi::Error>| {
        let msg = e.to_string();
        *slot = Some(e);
        PugError::host_exception(msg)
    };
    let state_json = serde_json::to_value(&*state)
        .map_err(|e| PugError::host_exception(format!("Failed to serialize lexer state: {e}")))?;
    let js_state = env
        .to_js_value(&state_json)
        .map_err(|e| record(e, pending_js_error))?;
    let ret = cb
        .call(FnArgs::from((method.to_string(), js_state)))
        .map_err(|e| record(e, pending_js_error))?;
    let ret_json: Value = env
        .from_js_value(ret)
        .map_err(|e| record(e, pending_js_error))?;
    let parsed: JsLexStepResult = serde_json::from_value(ret_json)
        .map_err(|e| PugError::host_exception(format!("Invalid lexer plugin result: {e}")))?;
    *state = parsed.state;
    Ok(parsed.handled)
}

impl LexerPluginHook for NapiLexBridge<'_> {
    fn call_lex(&mut self, method: &str, state: &mut LexerState) -> std::result::Result<bool, PugError> {
        invoke_js_lex_step(
            self.env,
            &self.cb,
            method,
            state,
            &mut self.pending_js_error,
        )
    }
}

#[napi]
pub fn lex_sync(
    env: Env,
    source: String,
    options: Option<NapiLexerOptions>,
    callbacks: Option<Object>,
) -> Result<NapiJsonOutcome> {
    let opts = options.unwrap_or_default();
    let lex_opts = LexerOptions {
        filename: opts.filename,
        interpolated: opts.interpolated.unwrap_or(false),
        starting_line: opts.starting_line.map(|n| n as usize),
        starting_column: opts.starting_column.map(|n| n as usize),
        plugin_methods: opts.plugin_methods.unwrap_or_default(),
    };
    let lex_cb: Option<Function<FnArgs<(String, Unknown)>, Unknown>> = match callbacks {
        Some(ref obj) if obj.has_named_property("lexPluginStep")? => {
            let v: Unknown = obj.get_named_property("lexPluginStep")?;
            if v.get_type()? == ValueType::Function {
                Some(Function::from_unknown(v)?)
            } else {
                None
            }
        }
        _ => None,
    };

    let mut pending_js_err: Option<napi::Error> = None;
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !lex_opts.plugin_methods.is_empty()
            && let Some(cb) = lex_cb
        {
            let mut bridge = NapiLexBridge {
                env,
                cb,
                pending_js_error: None,
            };
            let res = lex_with_hook(&source, &lex_opts, &mut bridge);
            pending_js_err = bridge.pending_js_error;
            res
        } else {
            lex(&source, &lex_opts)
        }
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
        Ok(Err(pug_err)) => {
            if let Some(js_err) = pending_js_err {
                return Err(js_err);
            }
            if pug_err.is_js_host_exception {
                return Ok(NapiJsonOutcome {
                    ok: false,
                    data: None,
                    error: None,
                    plain_error: Some(pug_err.message),
                });
            }
            Ok(NapiJsonOutcome {
                ok: false,
                data: None,
                error: Some(NapiPugErrorDto::from(pug_err)),
                plain_error: None,
            })
        }
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
    callbacks: Option<Object>,
) -> Result<NapiJsonOutcome> {
    let opts = options.unwrap_or_default();
    let parse_opts = ParserOptions {
        filename: opts.filename,
        src: opts.src,
    };
    let warn_cb: Option<Function<String, Unknown>> = match callbacks {
        Some(ref obj) if obj.has_named_property("warn")? => {
            let v: Unknown = obj.get_named_property("warn")?;
            if v.get_type()? == ValueType::Function {
                Some(Function::from_unknown(v)?)
            } else {
                None
            }
        }
        _ => None,
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        parse_json_tokens_with_warnings(&tokens, &parse_opts)
    }));
    match outcome {
        Ok(Ok((ast, warnings))) => {
            if let Some(cb) = warn_cb {
                for w in warnings {
                    let _ = cb.call(w);
                }
            }
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
    custom_resolve: bool,
    custom_read: bool,
    lex_parse_hooks: bool,
    ast_or_codegen_hooks: bool,
}

fn has_callback_prop(callbacks: &Option<Object<'_>>, name: &str) -> Result<bool> {
    let Some(obj) = callbacks else {
        return Ok(false);
    };
    if !obj.has_named_property(name)? {
        return Ok(false);
    }
    let val: Unknown<'_> = obj.get_named_property(name)?;
    Ok(val.get_type()? != ValueType::Undefined && val.get_type()? != ValueType::Null)
}

impl<'env> NodeHostAdapter<'env> {
    fn new(env: Env, callbacks: Option<Object<'env>>) -> Result<Self> {
        let custom_resolve = has_callback_prop(&callbacks, "resolve")?;
        let custom_read = has_callback_prop(&callbacks, "read")?;
        let lex_parse_hooks = has_callback_prop(&callbacks, "preLex")?
            || has_callback_prop(&callbacks, "postLex")?
            || has_callback_prop(&callbacks, "preParse")?
            || has_callback_prop(&callbacks, "postParse")?
            || has_callback_prop(&callbacks, "preLoad")?
            || has_callback_prop(&callbacks, "lexPluginStep")?;
        let ast_or_codegen_hooks = has_callback_prop(&callbacks, "postLoad")?
            || has_callback_prop(&callbacks, "preFilters")?
            || has_callback_prop(&callbacks, "postFilters")?
            || has_callback_prop(&callbacks, "preLink")?
            || has_callback_prop(&callbacks, "postLink")?
            || has_callback_prop(&callbacks, "preCodeGen")?
            || has_callback_prop(&callbacks, "generateCode")?;
        Ok(Self {
            env,
            callbacks,
            pending_js_error: None,
            custom_resolve,
            custom_read,
            lex_parse_hooks,
            ast_or_codegen_hooks,
        })
    }
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

    fn record_js_err(&mut self, err: napi::Error) -> PugError {
        let msg = err.to_string();
        self.pending_js_error = Some(err);
        PugError::host_exception(msg)
    }

    fn hook_profile_info(hook_name: &str) -> (pug_ast::profile::Stage, bool, bool) {
        use pug_ast::profile::Stage;
        match hook_name {
            "postLex" => (Stage::PostLexCallback, false, true),
            "preParse" => (Stage::PreParseCallback, false, true),
            "postParse" => (Stage::PostParseCallback, true, false),
            "preLoad" => (Stage::PreLoadCallback, true, false),
            "postLoad" => (Stage::PostLoadCallback, true, false),
            "preFilters" => (Stage::PreFiltersCallback, true, false),
            "postFilters" => (Stage::PostFiltersCallback, true, false),
            "preLink" => (Stage::PreLinkCallback, true, false),
            "postLink" => (Stage::PostLinkCallback, true, false),
            "preCodeGen" => (Stage::PreCodegenCallback, true, false),
            "postCodeGen" => (Stage::PostCodegenCallback, false, false),
            _ => (Stage::Other, false, false),
        }
    }

    fn call_json_hook<T>(&mut self, hook_name: &str, value: T) -> std::result::Result<T, PugError>
    where
        T: serde::Serialize + serde::de::DeserializeOwned,
    {
        let cb_opt = self.get_unary_fn(hook_name).map_err(|e| self.record_js_err(e))?;
        let Some(cb) = cb_opt else {
            return Ok(value);
        };

        let (stage, is_ast, is_token) = Self::hook_profile_info(hook_name);
        let _prof_cb = pug_ast::profile::scope(stage);
        pug_ast::profile::with_counters(|c| {
            c.host_callback_count += 1;
            if is_ast {
                c.ast_roundtrip_count += 1;
            }
            if is_token {
                c.token_roundtrip_count += 1;
            }
        });

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

        let (stage, is_ast, is_token) = Self::hook_profile_info(hook_name);
        let _prof_cb = pug_ast::profile::scope(stage);
        pug_ast::profile::with_counters(|c| {
            c.host_callback_count += 1;
            if is_ast {
                c.ast_roundtrip_count += 1;
            }
            if is_token {
                c.token_roundtrip_count += 1;
            }
        });

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
    fn pre_lex_cow<'s>(
        &mut self,
        source: &'s str,
        filename: Option<&str>,
    ) -> std::result::Result<std::borrow::Cow<'s, str>, PugError> {
        let val_opt = self
            .get_optional_val("preLex")
            .map_err(|e| self.record_js_err(e))?;
        let Some(val) = val_opt else {
            return Ok(std::borrow::Cow::Borrowed(source));
        };
        let _prof_cb = pug_ast::profile::scope(pug_ast::profile::Stage::PreLexCallback);
        pug_ast::profile::with_counters(|c| {
            c.host_callback_count += 1;
        });
        let cb: Function<'env, FnArgs<(String, Option<String>)>, String> =
            Function::from_unknown(val).map_err(|e| self.record_js_err(e))?;
        cb.call(FnArgs::from((source.to_string(), filename.map(String::from))))
            .map(std::borrow::Cow::Owned)
            .map_err(|e| self.record_js_err(e))
    }

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
        let _prof_cb = pug_ast::profile::scope(pug_ast::profile::Stage::PreLexCallback);
        pug_ast::profile::with_counters(|c| {
            c.host_callback_count += 1;
        });
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
        let full_path = {
            let _prof_res = pug_ast::profile::scope(pug_ast::profile::Stage::Resolve);
            pug_ast::profile::with_counters(|c| {
                c.resolve_count += 1;
            });
            let resolve_val = self
                .get_optional_val("resolve")
                .map_err(|e| self.record_js_err(e))?;

            if let Some(val) = resolve_val {
                pug_ast::profile::with_counters(|c| {
                    c.host_callback_count += 1;
                });
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
            }
        };

        let _prof_read = pug_ast::profile::scope(pug_ast::profile::Stage::FileRead);
        pug_ast::profile::with_counters(|c| {
            c.file_read_count += 1;
        });
        let read_val = self
            .get_optional_val("read")
            .map_err(|e| self.record_js_err(e))?;

        if let Some(val) = read_val {
            pug_ast::profile::with_counters(|c| {
                c.host_callback_count += 1;
            });
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

    fn run_filter(&mut self, call: &FilterInvocation<'_>) -> std::result::Result<String, PugError> {
        let cb_val = self
            .get_optional_val("filter")
            .map_err(|e| self.record_js_err(e))?;
        let _prof_flt = pug_ast::profile::scope(pug_ast::profile::Stage::FilterCallback);
        if cb_val.is_some() {
            pug_ast::profile::with_counters(|c| {
                c.host_callback_count += 1;
            });
        }
        invoke_js_filter(self.env, cb_val, call, &mut self.pending_js_error)
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

    fn warn(&mut self, msg: &str) {
        if let Ok(Some(val)) = self.get_optional_val("warn")
            && let Ok(cb) = Function::<String, Unknown>::from_unknown(val)
        {
            let _ = cb.call(msg.to_string());
        }
    }

    fn call_lex_plugin(
        &mut self,
        method: &str,
        state: &mut LexerState,
    ) -> std::result::Result<bool, PugError> {
        let cb_val = self
            .get_optional_val("lexPluginStep")
            .map_err(|e| self.record_js_err(e))?;
        let Some(val) = cb_val else {
            return Ok(false);
        };
        let cb: Function<'env, FnArgs<(String, Unknown<'env>)>, Unknown<'env>> =
            Function::from_unknown(val).map_err(|e| self.record_js_err(e))?;
        invoke_js_lex_step(self.env, &cb, method, state, &mut self.pending_js_error)
    }

    fn has_custom_resolve(&self) -> bool {
        self.custom_resolve
    }

    fn has_custom_read(&self) -> bool {
        self.custom_read
    }

    fn has_lex_parse_hooks(&self) -> bool {
        self.lex_parse_hooks
    }

    fn supports_linked_view(&self) -> bool {
        !self.custom_resolve
            && !self.custom_read
            && !self.lex_parse_hooks
            && !self.ast_or_codegen_hooks
    }
}

fn invoke_js_filter<'env>(
    env: Env,
    cb_val: Option<Unknown<'env>>,
    call: &FilterInvocation<'_>,
    pending_js_error: &mut Option<napi::Error>,
) -> std::result::Result<String, PugError> {
    let record_err = |e: napi::Error, slot: &mut Option<napi::Error>| -> PugError {
        let msg = e.to_string();
        *slot = Some(e);
        PugError::host_exception(msg)
    };

    let Some(val) = cb_val else {
        return Err(pug_filters::unknown_filter_error(
            call.filter_name,
            call.line,
            call.column,
            call.node_filename.map(String::from),
            None,
        ));
    };

    let cb: Function<
        'env,
        FnArgs<(
            String,
            String,
            String,
            Option<String>,
            Unknown<'env>,
            Object<'env>,
            Option<String>,
        )>,
        Unknown<'env>,
    > = Function::from_unknown(val).map_err(|e| record_err(e, pending_js_error))?;

    let mut attrs_obj = Object::new(&env).map_err(|e| record_err(e, pending_js_error))?;
    for entry in call.attrs {
        match &entry.value {
            Some(v) => {
                let js_v = env
                    .to_js_value(v)
                    .map_err(|e| record_err(e, pending_js_error))?;
                attrs_obj
                    .set_named_property(&entry.name, js_v)
                    .map_err(|e| record_err(e, pending_js_error))?;
            }
            None => {
                attrs_obj
                    .set_named_property(&entry.name, ())
                    .map_err(|e| record_err(e, pending_js_error))?;
            }
        }
    }
    match call.attrs_filename {
        Some(f) => attrs_obj
            .set_named_property("filename", f.to_string())
            .map_err(|e| record_err(e, pending_js_error))?,
        None => attrs_obj
            .set_named_property("filename", ())
            .map_err(|e| record_err(e, pending_js_error))?,
    }

    let raw_js = match call.raw {
        Some(RawContent::Bytes(bytes)) => BufferSlice::from_data(&env, bytes.to_vec())
            .map_err(|e| record_err(e, pending_js_error))?
            .into_unknown(&env)
            .map_err(|e| record_err(e, pending_js_error))?,
        Some(RawContent::Text(s)) => env
            .create_string(s)
            .map_err(|e| record_err(e, pending_js_error))?
            .into_unknown(&env)
            .map_err(|e| record_err(e, pending_js_error))?,
        None => ().into_unknown(&env).map_err(|e| record_err(e, pending_js_error))?,
    };

    let mode_str = match call.mode {
        FilterCallMode::Text => String::from("text"),
        FilterCallMode::RawFile => String::from("rawFile"),
    };

    let ret = cb
        .call(FnArgs::from((
            call.filter_name.to_string(),
            mode_str,
            call.text.to_string(),
            call.full_path.map(String::from),
            raw_js,
            attrs_obj,
            call.dir.map(String::from),
        )))
        .map_err(|e| record_err(e, pending_js_error))?;

    let ret_obj = Object::from_unknown(ret).map_err(|e| record_err(e, pending_js_error))?;
    let ok: bool = ret_obj
        .get_named_property("ok")
        .map_err(|e| record_err(e, pending_js_error))?;
    if ok {
        let value: String = ret_obj
            .get_named_property("value")
            .map_err(|e| record_err(e, pending_js_error))?;
        Ok(value)
    } else {
        let msg: String = ret_obj
            .get_named_property("unknownFilter")
            .map_err(|e| record_err(e, pending_js_error))?;
        Err(PugError::new(
            "UNKNOWN_FILTER",
            msg,
            ErrorOptions {
                line: call.line as i64,
                column: call.column.map(|c| c as i64),
                filename: call.node_filename.map(String::from),
                src: None,
            },
        ))
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
pub fn handle_filters_sync(
    env: Env,
    ast: Value,
    filter_options: Option<Value>,
    filter_aliases: Option<HashMap<String, String>>,
    callbacks: Option<Object>,
) -> Result<NapiJsonOutcome> {
    let block: BlockNode = match serde_json::from_value(ast) {
        Ok(b) => b,
        Err(e) => {
            return Ok(NapiJsonOutcome {
                ok: false,
                data: None,
                error: None,
                plain_error: Some(format!("Invalid AST passed to handle_filters_sync: {e}")),
            });
        }
    };
    let opts_val = filter_options.unwrap_or(Value::Null);
    let aliases = filter_aliases.unwrap_or_default();
    let mut pending_js_error: Option<napi::Error> = None;

    let cb_val = match callbacks {
        Some(ref obj) if obj.has_named_property("filter")? => {
            let v: Unknown = obj.get_named_property("filter")?;
            if v.get_type()? == ValueType::Function {
                Some(v)
            } else {
                None
            }
        }
        _ => None,
    };

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handle_filters(block, &opts_val, &aliases, &mut |call: &FilterInvocation<'_>| {
            invoke_js_filter(env, cb_val, call, &mut pending_js_error)
        })
    }));

    match outcome {
        Ok(Ok(processed)) => {
            let data = serde_json::to_value(processed).map_err(|e| {
                napi::Error::from_reason(format!("Failed to serialize filtered AST: {e}"))
            })?;
            Ok(NapiJsonOutcome {
                ok: true,
                data: Some(data),
                error: None,
                plain_error: None,
            })
        }
        Ok(Err(pug_err)) => {
            if let Some(js_err) = pending_js_error {
                return Err(js_err);
            }
            if pug_err.is_js_host_exception {
                return Ok(NapiJsonOutcome {
                    ok: false,
                    data: None,
                    error: None,
                    plain_error: Some(pug_err.message),
                });
            }
            Ok(NapiJsonOutcome {
                ok: false,
                data: None,
                error: Some(NapiPugErrorDto::from(pug_err)),
                plain_error: None,
            })
        }
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in handle_filters_sync",
        )),
    }
}

#[napi]
pub fn link_sync(ast: Value) -> Result<NapiJsonOutcome> {
    let block: BlockNode = match serde_json::from_value(ast) {
        Ok(b) => b,
        Err(e) => {
            return Ok(NapiJsonOutcome {
                ok: false,
                data: None,
                error: None,
                plain_error: Some(format!("Invalid AST passed to link_sync: {e}")),
            });
        }
    };

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| link(block)));

    match outcome {
        Ok(Ok(linked)) => {
            let data = serde_json::to_value(linked).map_err(|e| {
                napi::Error::from_reason(format!("Failed to serialize linked AST: {e}"))
            })?;
            Ok(NapiJsonOutcome {
                ok: true,
                data: Some(data),
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
            "Internal Rust panic caught at FFI boundary in link_sync",
        )),
    }
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiTemplateStoreStats {
    pub sources: u32,
    pub parsed: u32,
    pub resolved: u32,
    pub outputs: u32,
    pub dag_nodes: u32,
    pub dag_edges: u32,
    pub source_hits: f64,
    pub source_misses: f64,
    pub parse_hits: f64,
    pub parse_misses: f64,
    pub output_cache_hits: f64,
    pub output_cache_misses: f64,
}

impl From<TemplateStoreStats> for NapiTemplateStoreStats {
    fn from(s: TemplateStoreStats) -> Self {
        Self {
            sources: s.sources as u32,
            parsed: s.parsed as u32,
            resolved: s.resolved as u32,
            outputs: s.outputs as u32,
            dag_nodes: s.dag_nodes as u32,
            dag_edges: s.dag_edges as u32,
            source_hits: s.source_hits as f64,
            source_misses: s.source_misses as f64,
            parse_hits: s.parse_hits as f64,
            parse_misses: s.parse_misses as f64,
            output_cache_hits: s.output_cache_hits as f64,
            output_cache_misses: s.output_cache_misses as f64,
        }
    }
}

#[napi]
pub struct NativeTemplateStore {
    inner: Arc<TemplateStore>,
}

#[napi]
impl NativeTemplateStore {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(TemplateStore::new()),
        }
    }

    #[napi]
    pub fn invalidate_path(&self, path: String) {
        self.inner.invalidate_path(&path);
    }

    #[napi]
    pub fn update_virtual_source(&self, path: String, source: String) {
        self.inner.update_virtual_source(&path, source);
    }

    #[napi]
    pub fn clear(&self) {
        self.inner.clear();
    }

    #[napi]
    pub fn stats(&self) -> NapiTemplateStoreStats {
        NapiTemplateStoreStats::from(self.inner.stats())
    }
}

#[napi]
pub fn clear_default_template_store() {
    default_global_store().clear();
}

#[napi]
pub fn default_template_store_stats() -> NapiTemplateStoreStats {
    NapiTemplateStoreStats::from(default_global_store().stats())
}

#[napi]
pub fn compile_body_sync(
    env: Env,
    source: String,
    options: NapiCompileOptions,
    callbacks: Option<Object>,
    store: Option<&NativeTemplateStore>,
) -> Result<NapiCompileOutcome> {
    let _prof_session = pug_ast::profile::begin_session();
    let entry_scope = pug_ast::profile::scope(pug_ast::profile::Stage::NapiEntry);
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
        filter_options: options.filter_options.unwrap_or(Value::Null),
        filter_aliases: options.filter_aliases.unwrap_or_default(),
        lex_plugin_methods: options.lex_plugin_methods.unwrap_or_default(),
    };

    let mut host = NodeHostAdapter::new(env, callbacks)?;
    let store_ref: &TemplateStore = match store {
        Some(s) => s.inner.as_ref(),
        None => default_global_store(),
    };
    drop(entry_scope);

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        compile_body_with_store(&source, &compile_opts, &mut host, store_ref)
    }));

    let _prof_return = pug_ast::profile::scope(pug_ast::profile::Stage::NapiReturn);
    match outcome {
        Ok(Ok(res)) => Ok(NapiCompileOutcome {
            ok: true,
            body: Some(res.body),
            dependencies: Some(res.dependencies),
            error: None,
            plain_error: None,
            plain_error_code: None,
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
                    plain_error_code: pug_err.plain_error_code,
                });
            }
            Ok(NapiCompileOutcome {
                ok: false,
                body: None,
                dependencies: None,
                error: Some(NapiPugErrorDto::from(pug_err)),
                plain_error: None,
                plain_error_code: None,
            })
        }
        Err(_panic) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in compile_body_sync",
        )),
    }
}

#[napi]
pub fn get_last_profile_json() -> Option<String> {
    pug_ast::profile::last_report_json()
}

#[napi]
pub fn compile_attrs_sync(
    attrs: Value,
    terse: bool,
    format: String,
    runtime_cb: Function<String, String>,
) -> Result<NapiJsonOutcome> {
    let parsed_attrs: Vec<Attribute> = match serde_json::from_value(attrs) {
        Ok(a) => a,
        Err(e) => {
            return Ok(NapiJsonOutcome {
                ok: false,
                data: None,
                error: None,
                plain_error: Some(format!("Invalid attrs passed to compile_attrs_sync: {e}")),
            });
        }
    };

    let attrs_format = match format.as_str() {
        "html" => AttrsFormat::Html,
        "object" => AttrsFormat::Object,
        other => {
            return Ok(NapiJsonOutcome {
                ok: false,
                data: None,
                error: None,
                plain_error: Some(format!(
                    "Options.format should be \"html\" or \"object\", got \"{other}\""
                )),
            });
        }
    };

    let mut pending_js_error: Option<napi::Error> = None;
    let code = compile_attrs(&parsed_attrs, terse, attrs_format, |name| {
        if pending_js_error.is_some() {
            return format!("pug.{name}");
        }
        match runtime_cb.call(name.to_string()) {
            Ok(s) => s,
            Err(e) => {
                pending_js_error = Some(e);
                format!("pug.{name}")
            }
        }
    });

    if let Some(err) = pending_js_error {
        return Err(err);
    }

    Ok(NapiJsonOutcome {
        ok: true,
        data: Some(Value::String(code)),
        error: None,
        plain_error: None,
    })
}

fn napi_opts_to_compile_options(options: NapiCompileOptions) -> CompileOptions {
    CompileOptions {
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
        filter_options: options.filter_options.unwrap_or(Value::Null),
        filter_aliases: options.filter_aliases.unwrap_or_default(),
        lex_plugin_methods: options.lex_plugin_methods.unwrap_or_default(),
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiVirtualFile {
    pub path: String,
    pub source: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiBatchEntryInput {
    pub id: Option<String>,
    pub filename: Option<String>,
    pub source: Option<String>,
    pub options: Option<NapiCompileOptions>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiBatchEntryResult {
    pub id: String,
    pub ok: bool,
    pub body: Option<String>,
    pub dependencies: Vec<String>,
    pub cache_hit: bool,
    pub error: Option<NapiPugErrorDto>,
    pub plain_error: Option<String>,
    pub plain_error_code: Option<String>,
}

impl From<BatchEntryOutput> for NapiBatchEntryResult {
    fn from(out: BatchEntryOutput) -> Self {
        Self {
            id: out.id,
            ok: out.ok,
            body: out.body,
            dependencies: out.dependencies,
            cache_hit: out.cache_hit,
            error: out.error.map(NapiPugErrorDto::from),
            plain_error: out.plain_error,
            plain_error_code: out.plain_error_code,
        }
    }
}

fn convert_batch_inputs(entries: Vec<NapiBatchEntryInput>) -> Vec<BatchEntryInput> {
    entries
        .into_iter()
        .enumerate()
        .map(|(idx, e)| {
            let id = e
                .id
                .or_else(|| e.filename.clone())
                .unwrap_or_else(|| format!("entry_{idx}"));
            BatchEntryInput {
                id,
                filename: e.filename,
                source: e.source,
                options: e.options.map(napi_opts_to_compile_options),
            }
        })
        .collect()
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NapiIncrementalUpdateReport {
    pub changed: bool,
    pub changed_files: Vec<String>,
    pub invalidated_templates: Vec<String>,
    pub affected_entries: Vec<String>,
}

impl From<IncrementalUpdateReport> for NapiIncrementalUpdateReport {
    fn from(r: IncrementalUpdateReport) -> Self {
        Self {
            changed: r.changed,
            changed_files: r.changed_files,
            invalidated_templates: r.invalidated_templates,
            affected_entries: r.affected_entries,
        }
    }
}

#[napi]
pub struct NativeCompilerSession {
    inner: CompilerSession,
}

#[napi]
impl NativeCompilerSession {
    #[napi(constructor)]
    pub fn new(
        default_options: Option<NapiCompileOptions>,
        store: Option<&NativeTemplateStore>,
    ) -> Self {
        let opts = default_options
            .map(napi_opts_to_compile_options)
            .unwrap_or_default();
        let inner = match store {
            Some(s) => CompilerSession::with_store(Arc::clone(&s.inner), opts),
            None => CompilerSession::new(opts),
        };
        Self { inner }
    }

    #[napi]
    pub fn update_files(&self, files: Vec<NapiVirtualFile>) -> NapiIncrementalUpdateReport {
        let pairs: Vec<(String, String)> = files
            .into_iter()
            .map(|f| (f.path, f.source))
            .collect();
        NapiIncrementalUpdateReport::from(self.inner.update_files_incremental(&pairs))
    }

    #[napi]
    pub fn invalidate_files(&self, paths: Vec<String>) -> NapiIncrementalUpdateReport {
        NapiIncrementalUpdateReport::from(self.inner.invalidate_files_incremental(&paths))
    }

    #[napi]
    pub fn remove_files(&self, paths: Vec<String>) -> NapiIncrementalUpdateReport {
        NapiIncrementalUpdateReport::from(self.inner.remove_files(&paths))
    }

    #[napi]
    pub fn dispose(&self) {
        self.inner.dispose();
    }

    #[napi]
    pub fn get_affected_entries(&self) -> Vec<String> {
        self.inner.affected_entries()
    }

    #[napi]
    pub fn compile_affected(
        &self,
        parallel: Option<bool>,
        parallel_threshold: Option<u32>,
    ) -> Result<Vec<NapiBatchEntryResult>> {
        let _prof_session = pug_ast::profile::begin_session();
        let mode = match parallel {
            Some(true) => ParallelMode::ForceParallel,
            Some(false) => ParallelMode::ForceSerial,
            None => ParallelMode::Auto(
                parallel_threshold
                    .map(|v| v as usize)
                    .unwrap_or(DEFAULT_PARALLEL_THRESHOLD),
            ),
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.inner.compile_affected_with_mode(mode)
        }));
        match outcome {
            Ok(results) => Ok(results.into_iter().map(NapiBatchEntryResult::from).collect()),
            Err(_) => Err(napi::Error::from_reason(
                "Internal Rust panic caught at FFI boundary in NativeCompilerSession::compile_affected",
            )),
        }
    }

    #[napi]
    pub fn clear(&self) {
        self.inner.clear();
    }

    #[napi]
    pub fn stats(&self) -> NapiTemplateStoreStats {
        NapiTemplateStoreStats::from(self.inner.stats())
    }

    #[napi]
    pub fn compile_entries(
        &self,
        entries: Vec<NapiBatchEntryInput>,
        parallel: Option<bool>,
        parallel_threshold: Option<u32>,
    ) -> Result<Vec<NapiBatchEntryResult>> {
        let _prof_session = pug_ast::profile::begin_session();
        let batch_inputs = convert_batch_inputs(entries);
        let mode = match parallel {
            Some(true) => ParallelMode::ForceParallel,
            Some(false) => ParallelMode::ForceSerial,
            None => ParallelMode::Auto(
                parallel_threshold
                    .map(|v| v as usize)
                    .unwrap_or(DEFAULT_PARALLEL_THRESHOLD),
            ),
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.inner.compile_entries_with_mode(&batch_inputs, mode)
        }));
        match outcome {
            Ok(results) => Ok(results.into_iter().map(NapiBatchEntryResult::from).collect()),
            Err(_) => Err(napi::Error::from_reason(
                "Internal Rust panic caught at FFI boundary in NativeCompilerSession::compile_entries",
            )),
        }
    }
}

#[napi]
pub fn compile_batch_sync(
    entries: Vec<NapiBatchEntryInput>,
    default_options: Option<NapiCompileOptions>,
    store: Option<&NativeTemplateStore>,
    parallel: Option<bool>,
    parallel_threshold: Option<u32>,
) -> Result<Vec<NapiBatchEntryResult>> {
    let _prof_session = pug_ast::profile::begin_session();
    let opts = default_options
        .map(napi_opts_to_compile_options)
        .unwrap_or_default();
    let batch_inputs = convert_batch_inputs(entries);
    let store_ref: &TemplateStore = match store {
        Some(s) => s.inner.as_ref(),
        None => default_global_store(),
    };
    let mode = match parallel {
        Some(true) => ParallelMode::ForceParallel,
        Some(false) => ParallelMode::ForceSerial,
        None => ParallelMode::Auto(
            parallel_threshold
                .map(|v| v as usize)
                .unwrap_or(DEFAULT_PARALLEL_THRESHOLD),
        ),
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        compile_batch_with_mode(&batch_inputs, &opts, store_ref, mode)
    }));
    match outcome {
        Ok(results) => Ok(results.into_iter().map(NapiBatchEntryResult::from).collect()),
        Err(_) => Err(napi::Error::from_reason(
            "Internal Rust panic caught at FFI boundary in compile_batch_sync",
        )),
    }
}
