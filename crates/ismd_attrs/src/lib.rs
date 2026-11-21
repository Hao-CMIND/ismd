use std::borrow::Cow;
use std::fmt::Write as _;

use ismd_ast::Attribute;
use ismd_js::{
    ConstVal, eval_constant, js_stringify_str, js_stringify_val, ismd_attr, ismd_classes,
    ismd_escape, ismd_style, push_js_string_inner,
};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttrsFormat {
    Html,
    Object,
}

/// Compiles a slice of `Attribute` AST nodes matching `ismd-attrs@2.0.4`.
/// Note: in `constantinople@3.1.2`, `isConstant(val)` only succeeds when `val` is a `string`;
/// when `attr.val` is a boolean `true` (e.g., `input(disabled)`), `parseExpression(true)` throws
/// `TypeError` and `isConstant(true)` returns `false`.
pub fn compile_attrs<R>(
    attrs: &[Attribute],
    terse: bool,
    format: AttrsFormat,
    mut runtime: R,
) -> String
where
    R: FnMut(&str) -> String,
{
    compile_attrs_fast(attrs, terse, format, |name| Cow::Owned(runtime(name)))
}

/// Allocation-minimized variant of `compile_attrs` allowing `&'static str` runtime helpers.
pub fn compile_attrs_fast<R>(
    attrs: &[Attribute],
    terse: bool,
    format: AttrsFormat,
    mut runtime: R,
) -> String
where
    R: FnMut(&'static str) -> Cow<'static, str>,
{
    let _prof_attrs = ismd_ast::profile::scope(ismd_ast::profile::Stage::Attrs);
    if attrs.is_empty() {
        return match format {
            AttrsFormat::Html => String::from("\"\""),
            AttrsFormat::Object => String::from("{}"),
        };
    }

    let mut body = String::with_capacity(attrs.len() * 24);
    let mut last_was_str_lit = false;
    let mut classes: Vec<(Cow<'_, str>, bool)> = Vec::new();
    let mut class_escaping: Vec<bool> = Vec::new();

    for attr in attrs {
        let key = &attr.name;
        let (mut val, mut is_str): (Cow<'_, str>, bool) = match &attr.val {
            Value::String(s) => (Cow::Borrowed(s.as_str()), true),
            Value::Bool(true) => (Cow::Borrowed("true"), false),
            Value::Bool(false) => (Cow::Borrowed("false"), false),
            other => (Cow::Owned(other.to_string()), false),
        };
        let must_escape = attr.must_escape;

        if key == "class" {
            classes.push((val, is_str));
            class_escaping.push(must_escape);
        } else {
            if key == "style" {
                if is_str && let Some(cval) = eval_constant(&val) {
                    val = Cow::Owned(js_stringify_str(&ismd_style(&cval)));
                    is_str = true;
                } else {
                    let style_fn = runtime("style");
                    val = Cow::Owned(format!("{style_fn}({val})"));
                    is_str = true;
                }
            }
            add_attribute(
                key,
                &val,
                is_str,
                must_escape,
                &mut body,
                &mut last_was_str_lit,
                terse,
                format,
                &mut runtime,
            );
        }
    }

    if classes.is_empty() {
        return match format {
            AttrsFormat::Html => {
                if body.is_empty() {
                    String::from("\"\"")
                } else {
                    body
                }
            }
            AttrsFormat::Object => {
                let mut out = String::with_capacity(body.len() + 2);
                out.push('{');
                out.push_str(&body);
                out.push('}');
                out
            }
        };
    }

    let mut evaluated_classes: Vec<Option<ConstVal>> = Vec::with_capacity(classes.len());
    let mut all_const = true;
    for (cls, is_s) in &classes {
        let cv = if *is_s { eval_constant(cls) } else { None };
        if cv.is_none() {
            all_const = false;
        }
        evaluated_classes.push(cv);
    }

    let mut class_out = String::with_capacity(64);
    let mut class_last_str_lit = false;
    if all_const {
        let const_vals: Vec<ConstVal> = evaluated_classes
            .into_iter()
            .map(|c| c.unwrap_or(ConstVal::Undefined))
            .collect();
        let class_str = ismd_classes(&ConstVal::Array(const_vals), Some(&class_escaping));
        let val_str = js_stringify_str(&class_str);
        add_attribute(
            "class",
            &val_str,
            true,
            false,
            &mut class_out,
            &mut class_last_str_lit,
            terse,
            format,
            &mut runtime,
        );
    } else {
        let classes_fn = runtime("classes");
        let mut expr = String::with_capacity(classes.len() * 20 + 24);
        expr.push_str(&classes_fn);
        expr.push_str("([");
        for (i, ((cls, _), cv)) in classes.into_iter().zip(evaluated_classes).enumerate() {
            if i > 0 {
                expr.push(',');
            }
            if let Some(cval) = cv {
                let final_val = if class_escaping[i] {
                    let s = cval.to_js_string();
                    let escaped = ismd_escape(&s);
                    if escaped == s {
                        cval
                    } else {
                        ConstVal::String(escaped)
                    }
                } else {
                    cval
                };
                expr.push_str(&js_stringify_val(&final_val));
                class_escaping[i] = false;
            } else {
                expr.push_str(&cls);
            }
        }
        expr.push_str("], [");
        for (i, esc) in class_escaping.iter().enumerate() {
            if i > 0 {
                expr.push(',');
            }
            expr.push_str(if *esc { "true" } else { "false" });
        }
        expr.push_str("])");
        add_attribute(
            "class",
            &expr,
            true,
            false,
            &mut class_out,
            &mut class_last_str_lit,
            terse,
            format,
            &mut runtime,
        );
    }

    match format {
        AttrsFormat::Html => {
            if body.is_empty() {
                if class_out.is_empty() {
                    String::from("\"\"")
                } else {
                    class_out
                }
            } else if class_out.is_empty() {
                body
            } else {
                class_out.reserve(1 + body.len());
                class_out.push('+');
                class_out.push_str(&body);
                class_out
            }
        }
        AttrsFormat::Object => {
            let total = 2 + class_out.len() + if !body.is_empty() && !class_out.is_empty() { 1 } else { 0 } + body.len();
            let mut out = String::with_capacity(total);
            out.push('{');
            out.push_str(&class_out);
            if !class_out.is_empty() && !body.is_empty() {
                out.push(',');
            }
            out.push_str(&body);
            out.push('}');
            out
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn add_attribute<R>(
    key: &str,
    val: &str,
    is_str: bool,
    must_escape: bool,
    out: &mut String,
    last_was_str_lit: &mut bool,
    terse: bool,
    format: AttrsFormat,
    runtime: &mut R,
) where
    R: FnMut(&'static str) -> Cow<'static, str>,
{
    if is_str && let Some(cval) = eval_constant(val) {
        match format {
            AttrsFormat::Html => {
                let rendered = ismd_attr(key, &cval, must_escape, terse);
                if *last_was_str_lit && out.ends_with('"') {
                    out.pop();
                    push_js_string_inner(out, &rendered);
                    out.push('"');
                } else {
                    if !out.is_empty() {
                        out.push('+');
                    }
                    out.push('"');
                    push_js_string_inner(out, &rendered);
                    out.push('"');
                }
                *last_was_str_lit = true;
            }
            AttrsFormat::Object => {
                let final_val = if must_escape {
                    let s = cval.to_js_string();
                    let escaped = ismd_escape(&s);
                    if escaped == s {
                        cval
                    } else {
                        ConstVal::String(escaped)
                    }
                } else {
                    cval
                };
                if !out.is_empty() {
                    out.push(',');
                }
                out.push('"');
                push_js_string_inner(out, key);
                out.push_str("\": ");
                out.push_str(&js_stringify_val(&final_val));
                *last_was_str_lit = false;
            }
        }
    } else {
        match format {
            AttrsFormat::Html => {
                let attr_fn = runtime("attr");
                if !out.is_empty() {
                    out.push('+');
                }
                out.push_str(&attr_fn);
                out.push_str("(\"");
                push_js_string_inner(out, key);
                let _ = write!(out, "\", {val}, {must_escape}, {terse})");
                *last_was_str_lit = false;
            }
            AttrsFormat::Object => {
                if !out.is_empty() {
                    out.push(',');
                }
                out.push('"');
                push_js_string_inner(out, key);
                out.push_str("\": ");
                if must_escape {
                    let esc_fn = runtime("escape");
                    out.push_str(&esc_fn);
                    out.push('(');
                    out.push_str(val);
                    out.push(')');
                } else {
                    out.push_str(val);
                }
                *last_was_str_lit = false;
            }
        }
    }
}

/// Legacy helper for static attributes when no runtime function is needed.
pub fn compile_static_attrs(attrs: &[Attribute]) -> String {
    let expr = compile_attrs_fast(attrs, false, AttrsFormat::Html, |name| {
        Cow::Owned(format!("ismd.{name}"))
    });
    eval_constant(&expr)
        .map(|v| v.to_js_string())
        .unwrap_or_default()
}
