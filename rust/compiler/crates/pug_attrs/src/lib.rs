use pug_ast::Attribute;
use pug_js::{
    ConstVal, eval_constant, is_constant, js_stringify_str, js_stringify_val, pug_attr,
    pug_classes, pug_escape, pug_style,
};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttrsFormat {
    Html,
    Object,
}

/// Compiles a slice of `Attribute` AST nodes matching `pug-attrs@2.0.4`.
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
    let mut buf: Vec<String> = Vec::new();
    let mut classes: Vec<(String, bool)> = Vec::new();
    let mut class_escaping: Vec<bool> = Vec::new();

    for attr in attrs {
        let key = &attr.name;
        let (mut val, mut is_str) = match &attr.val {
            Value::String(s) => (s.clone(), true),
            Value::Bool(b) => (b.to_string(), false),
            other => (other.to_string(), false),
        };
        let must_escape = attr.must_escape;

        if key == "class" {
            classes.push((val, is_str));
            class_escaping.push(must_escape);
        } else {
            if key == "style" {
                if is_str && let Some(cval) = eval_constant(&val) {
                    val = js_stringify_str(&pug_style(&cval));
                    is_str = true;
                } else {
                    let style_fn = runtime("style");
                    val = format!("{style_fn}({val})");
                    is_str = true;
                }
            }
            add_attribute(
                key,
                &val,
                is_str,
                must_escape,
                &mut buf,
                terse,
                format,
                &mut runtime,
            );
        }
    }

    let mut classes_buf: Vec<String> = Vec::new();
    if !classes.is_empty() {
        if classes.iter().all(|(c, is_s)| *is_s && is_constant(c)) {
            let const_vals: Vec<ConstVal> = classes
                .iter()
                .map(|(c, _)| eval_constant(c).unwrap_or(ConstVal::Undefined))
                .collect();
            let class_str = pug_classes(&ConstVal::Array(const_vals), Some(&class_escaping));
            let val_str = js_stringify_str(&class_str);
            add_attribute(
                "class",
                &val_str,
                true,
                false,
                &mut classes_buf,
                terse,
                format,
                &mut runtime,
            );
        } else {
            let mut class_exprs: Vec<String> = Vec::with_capacity(classes.len());
            for (i, (cls, is_s)) in classes.into_iter().enumerate() {
                if is_s && let Some(cval) = eval_constant(&cls) {
                    let final_val = if class_escaping[i] {
                        let s = cval.to_js_string();
                        let escaped = pug_escape(&s);
                        if escaped == s {
                            cval
                        } else {
                            ConstVal::String(escaped)
                        }
                    } else {
                        cval
                    };
                    class_exprs.push(js_stringify_val(&final_val));
                    class_escaping[i] = false;
                } else {
                    class_exprs.push(cls);
                }
            }
            let classes_fn = runtime("classes");
            let esc_json =
                serde_json::to_string(&class_escaping).unwrap_or_else(|_| String::from("[]"));
            let expr = format!("{classes_fn}([{}], {esc_json})", class_exprs.join(","));
            add_attribute(
                "class",
                &expr,
                true,
                false,
                &mut classes_buf,
                terse,
                format,
                &mut runtime,
            );
        }
    }

    classes_buf.extend(buf);
    match format {
        AttrsFormat::Html => {
            if classes_buf.is_empty() {
                String::from("\"\"")
            } else {
                classes_buf.join("+")
            }
        }
        AttrsFormat::Object => format!("{{{}}}", classes_buf.join(",")),
    }
}

#[allow(clippy::too_many_arguments)]
fn add_attribute<R>(
    key: &str,
    val: &str,
    is_str: bool,
    must_escape: bool,
    buf: &mut Vec<String>,
    terse: bool,
    format: AttrsFormat,
    runtime: &mut R,
) where
    R: FnMut(&str) -> String,
{
    if is_str && let Some(cval) = eval_constant(val) {
        match format {
            AttrsFormat::Html => {
                let str_lit = js_stringify_str(&pug_attr(key, &cval, must_escape, terse));
                if let Some(last) = buf.last_mut()
                    && !last.is_empty()
                    && !str_lit.is_empty()
                    && last.as_bytes().last() == str_lit.as_bytes().first()
                {
                    last.pop();
                    last.push_str(&str_lit[1..]);
                } else {
                    buf.push(str_lit);
                }
            }
            AttrsFormat::Object => {
                let final_val = if must_escape {
                    let s = cval.to_js_string();
                    let escaped = pug_escape(&s);
                    if escaped == s {
                        cval
                    } else {
                        ConstVal::String(escaped)
                    }
                } else {
                    cval
                };
                buf.push(format!(
                    "{}: {}",
                    js_stringify_str(key),
                    js_stringify_val(&final_val)
                ));
            }
        }
    } else {
        match format {
            AttrsFormat::Html => {
                let attr_fn = runtime("attr");
                buf.push(format!("{attr_fn}(\"{key}\", {val}, {must_escape}, {terse})"));
            }
            AttrsFormat::Object => {
                let val_expr = if must_escape {
                    let esc_fn = runtime("escape");
                    format!("{esc_fn}({val})")
                } else {
                    val.to_string()
                };
                buf.push(format!("{}: {val_expr}", js_stringify_str(key)));
            }
        }
    }
}

/// Legacy helper for static attributes when no runtime function is needed.
pub fn compile_static_attrs(attrs: &[Attribute]) -> String {
    let expr = compile_attrs(attrs, false, AttrsFormat::Html, |name| format!("pug.{name}"));
    eval_constant(&expr)
        .map(|v| v.to_js_string())
        .unwrap_or_default()
}
