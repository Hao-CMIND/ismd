use oxc::allocator::Allocator;
use oxc::ast::ast::{
    Argument, ArrayExpressionElement, BinaryOperator, Expression, LogicalOperator,
    ObjectPropertyKind, PropertyKey, UnaryOperator,
};
use oxc::parser::Parser;
use oxc::span::SourceType;

/// Compile-time constant value matching `constantinople@3.1.2`/`4.0.1`.
#[derive(Debug, Clone, PartialEq)]
pub enum ConstVal {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    RegExp { pattern: String, flags: String },
    Array(Vec<ConstVal>),
    Object(Vec<(String, ConstVal)>),
    PugRuntime,
    PugMethod(&'static str),
}

/// Outcome of evaluating a filter option expression against `constantinople@4.0.1`.
#[derive(Debug, Clone, PartialEq)]
pub enum ConstEvalOutcome {
    Constant(ConstVal),
    NotConstant,
    Unsupported(String),
}

impl ConstVal {
    pub fn is_truthy(&self) -> bool {
        match self {
            ConstVal::Undefined | ConstVal::Null => false,
            ConstVal::Bool(b) => *b,
            ConstVal::Number(n) => *n != 0.0 && !n.is_nan(),
            ConstVal::String(s) => !s.is_empty(),
            ConstVal::Array(_)
            | ConstVal::Object(_)
            | ConstVal::RegExp { .. }
            | ConstVal::PugRuntime
            | ConstVal::PugMethod(_) => true,
        }
    }

    pub fn to_js_number(&self) -> f64 {
        match self {
            ConstVal::Undefined => f64::NAN,
            ConstVal::Null => 0.0,
            ConstVal::Bool(true) => 1.0,
            ConstVal::Bool(false) => 0.0,
            ConstVal::Number(n) => *n,
            ConstVal::String(s) => {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    0.0
                } else {
                    trimmed.parse::<f64>().unwrap_or(f64::NAN)
                }
            }
            ConstVal::Array(arr) => match arr.as_slice() {
                [] => 0.0,
                [single] => single.to_js_string().parse::<f64>().unwrap_or(f64::NAN),
                _ => f64::NAN,
            },
            ConstVal::Object(_)
            | ConstVal::RegExp { .. }
            | ConstVal::PugRuntime
            | ConstVal::PugMethod(_) => f64::NAN,
        }
    }

    pub fn to_js_string(&self) -> String {
        match self {
            ConstVal::Undefined => String::from("undefined"),
            ConstVal::Null => String::from("null"),
            ConstVal::Bool(true) => String::from("true"),
            ConstVal::Bool(false) => String::from("false"),
            ConstVal::Number(n) => format_js_number(*n),
            ConstVal::String(s) => s.clone(),
            ConstVal::RegExp { pattern, flags } => format!("/{pattern}/{flags}"),
            ConstVal::Array(arr) => arr
                .iter()
                .map(|v| match v {
                    ConstVal::Undefined | ConstVal::Null => String::new(),
                    other => other.to_js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
            ConstVal::Object(_) | ConstVal::PugRuntime => String::from("[object Object]"),
            ConstVal::PugMethod(m) => format!("function pug_{m}() {{}}"),
        }
    }

    pub fn to_json_value(&self) -> serde_json::Value {
        match self {
            ConstVal::Undefined | ConstVal::Null => serde_json::Value::Null,
            ConstVal::Bool(b) => serde_json::Value::Bool(*b),
            ConstVal::Number(n) => {
                if !n.is_finite() {
                    serde_json::Value::Null
                } else if *n == 0.0 {
                    serde_json::Value::Number(serde_json::Number::from(0))
                } else if n.fract() == 0.0
                    && *n >= -9223372036854775808.0
                    && *n < 9223372036854775808.0
                {
                    serde_json::Value::Number(serde_json::Number::from(*n as i64))
                } else {
                    serde_json::Number::from_f64(*n)
                        .map(serde_json::Value::Number)
                        .unwrap_or(serde_json::Value::Null)
                }
            }
            ConstVal::String(s) => serde_json::Value::String(s.clone()),
            ConstVal::Array(arr) => {
                serde_json::Value::Array(arr.iter().map(ConstVal::to_json_value).collect())
            }
            ConstVal::Object(entries) => {
                let mut map = serde_json::Map::new();
                for (k, v) in entries {
                    if !matches!(v, ConstVal::Undefined) {
                        map.insert(k.clone(), v.to_json_value());
                    }
                }
                serde_json::Value::Object(map)
            }
            ConstVal::RegExp { .. } | ConstVal::PugRuntime | ConstVal::PugMethod(_) => {
                serde_json::Value::Object(serde_json::Map::new())
            }
        }
    }

    pub fn to_json_string(&self) -> String {
        match self {
            ConstVal::Undefined | ConstVal::Null => String::from("null"),
            ConstVal::Bool(b) => b.to_string(),
            ConstVal::Number(n) => {
                if !n.is_finite() {
                    String::from("null")
                } else {
                    format_js_number(*n)
                }
            }
            ConstVal::String(s) => {
                serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""))
            }
            ConstVal::Array(arr) => {
                let parts: Vec<String> = arr.iter().map(ConstVal::to_json_string).collect();
                format!("[{}]", parts.join(","))
            }
            ConstVal::Object(entries) => {
                let mut parts = Vec::new();
                for (k, v) in entries {
                    if !matches!(v, ConstVal::Undefined) {
                        let k_json =
                            serde_json::to_string(k).unwrap_or_else(|_| String::from("\"\""));
                        parts.push(format!("{k_json}:{}", v.to_json_string()));
                    }
                }
                format!("{{{}}}", parts.join(","))
            }
            ConstVal::RegExp { .. } | ConstVal::PugRuntime | ConstVal::PugMethod(_) => {
                String::from("{}")
            }
        }
    }
}

fn format_js_number(n: f64) -> String {
    if n.is_nan() {
        return String::from("NaN");
    }
    if n.is_infinite() {
        return if n.is_sign_positive() {
            String::from("Infinity")
        } else {
            String::from("-Infinity")
        };
    }
    if n == 0.0 {
        return String::from("0");
    }
    let abs = n.abs();
    if abs >= 1e21 || abs < 1e-6 {
        let exp = format!("{n:e}");
        if let Some((mantissa, exponent)) = exp.split_once('e') {
            if exponent.starts_with('-') {
                return format!("{mantissa}e{exponent}");
            }
            return format!("{mantissa}e+{exponent}");
        }
        return exp;
    }
    format!("{n}")
}

/// Equivalent to `js-stringify@1.0.2`.
pub fn js_stringify_val(val: &ConstVal) -> String {
    if matches!(val, ConstVal::Undefined) {
        return String::from("undefined");
    }
    let json = val.to_json_string();
    escape_js_stringify_chars(&json)
}

/// Equivalent to `js-stringify(str)` on a string.
pub fn js_stringify_str(s: &str) -> String {
    let json = serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""));
    escape_js_stringify_chars(&json)
}

pub fn escape_js_stringify_chars(json: &str) -> String {
    json.replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
        .replace('<', "\\u003C")
        .replace('>', "\\u003E")
        .replace('/', "\\u002F")
}

/// Equivalent to `pug_escape` in `pug-runtime@2.0.5`.
pub fn pug_escape(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut last_idx = 0;
    for (i, b) in html.bytes().enumerate() {
        let esc = match b {
            b'"' => "&quot;",
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            _ => continue,
        };
        if last_idx != i {
            result.push_str(&html[last_idx..i]);
        }
        result.push_str(esc);
        last_idx = i + 1;
    }
    if last_idx == 0 {
        return html.to_string();
    }
    if last_idx < html.len() {
        result.push_str(&html[last_idx..]);
    }
    result
}

/// Equivalent to `pug_style` in `pug-runtime@2.0.5`.
pub fn pug_style(val: &ConstVal) -> String {
    if !val.is_truthy() {
        return String::new();
    }
    match val {
        ConstVal::Object(entries) => {
            let mut out = String::new();
            for (style, v) in entries {
                out.push_str(style);
                out.push(':');
                out.push_str(&v.to_js_string());
                out.push(';');
            }
            out
        }
        other => other.to_js_string(),
    }
}

/// Equivalent to `pug_classes` in `pug-runtime@2.0.5`.
pub fn pug_classes(val: &ConstVal, escaping: Option<&[bool]>) -> String {
    match val {
        ConstVal::Array(arr) => {
            let mut class_string = String::new();
            let mut padding = "";
            for (i, item) in arr.iter().enumerate() {
                let mut class_name = pug_classes(item, None);
                if class_name.is_empty() {
                    continue;
                }
                if let Some(esc) = escaping
                    && esc.get(i).copied().unwrap_or(false)
                {
                    class_name = pug_escape(&class_name);
                }
                class_string.push_str(padding);
                class_string.push_str(&class_name);
                padding = " ";
            }
            class_string
        }
        ConstVal::Object(entries) => {
            let mut class_string = String::new();
            let mut padding = "";
            for (key, v) in entries {
                if !key.is_empty() && v.is_truthy() {
                    class_string.push_str(padding);
                    class_string.push_str(key);
                    padding = " ";
                }
            }
            class_string
        }
        other => {
            if other.is_truthy() {
                other.to_js_string()
            } else {
                String::new()
            }
        }
    }
}

/// Equivalent to `pug_attr` in `pug-runtime@2.0.5`.
pub fn pug_attr(key: &str, val: &ConstVal, escaped: bool, terse: bool) -> String {
    if matches!(
        val,
        ConstVal::Bool(false) | ConstVal::Null | ConstVal::Undefined
    ) || (!val.is_truthy() && (key == "class" || key == "style"))
    {
        return String::new();
    }
    if matches!(val, ConstVal::Bool(true)) {
        return if terse {
            format!(" {key}")
        } else {
            format!(" {key}=\"{key}\"")
        };
    }
    match val {
        ConstVal::String(s) => {
            let v = if escaped {
                pug_escape(s)
            } else {
                s.clone()
            };
            format!(" {key}=\"{v}\"")
        }
        other => {
            let json = other.to_json_string();
            if !escaped && json.contains('"') {
                return format!(" {key}='{}'", json.replace('\'', "&#39;"));
            }
            let v = if escaped { pug_escape(&json) } else { json };
            format!(" {key}=\"{v}\"")
        }
    }
}

/// Evaluates whether `src` is a compile-time constant expression under `{ pug: runtime, pug_interp: undefined }`.
pub fn is_constant(src: &str) -> bool {
    eval_constant(src).is_some()
}

/// Evaluates `src` to a `ConstVal` if it is a compile-time constant expression.
pub fn eval_constant(src: &str) -> Option<ConstVal> {
    let allocator = Allocator::default();
    let expr = Parser::new(&allocator, src, SourceType::script())
        .parse_expression()
        .ok()?;
    match eval_expr(&expr, true) {
        ConstEvalOutcome::Constant(v) => Some(v),
        _ => None,
    }
}

/// Evaluates a filter option expression without `{ pug, pug_interp }`, distinguishing
/// `NotConstant` from `Unsupported` constant constructs.
pub fn eval_filter_constant(src: &str) -> ConstEvalOutcome {
    if crate::expression::validate_expression(
        src,
        crate::expression::ExpressionOptions {
            strict: false,
            line_comment: true,
        },
    )
    .is_err()
    {
        return ConstEvalOutcome::NotConstant;
    }
    let allocator = Allocator::default();
    let Ok(expr) = Parser::new(&allocator, src, SourceType::cjs()).parse_expression() else {
        return ConstEvalOutcome::NotConstant;
    };
    eval_expr(&expr, false)
}

fn eval_expr(expr: &Expression<'_>, allow_pug_constants: bool) -> ConstEvalOutcome {
    use ConstEvalOutcome::*;
    macro_rules! eval_sub {
        ($e:expr) => {
            match eval_expr($e, allow_pug_constants) {
                Constant(v) => v,
                other => return other,
            }
        };
    }

    match expr {
        Expression::BooleanLiteral(b) => Constant(ConstVal::Bool(b.value)),
        Expression::NullLiteral(_) => Constant(ConstVal::Null),
        Expression::NumericLiteral(n) => Constant(ConstVal::Number(n.value)),
        Expression::StringLiteral(s) => match s.value.as_str() {
            Some(v) => Constant(ConstVal::String(v.to_string())),
            None => NotConstant,
        },
        Expression::RegExpLiteral(re) => Constant(ConstVal::RegExp {
            pattern: re.regex.pattern.text.to_string(),
            flags: re.regex.flags.to_string(),
        }),
        Expression::BigIntLiteral(_) => {
            Unsupported(String::from("BigInt constant evaluation is not supported"))
        }
        Expression::ParenthesizedExpression(p) => eval_expr(&p.expression, allow_pug_constants),
        Expression::SequenceExpression(seq) => {
            let mut last = ConstVal::Undefined;
            for sub in &seq.expressions {
                last = eval_sub!(sub);
            }
            Constant(last)
        }
        Expression::TemplateLiteral(tpl) => {
            let mut result = String::new();
            for (i, quasi) in tpl.quasis.iter().enumerate() {
                let Some(cooked) = quasi.value.cooked.as_ref().and_then(|c| c.as_str()) else {
                    return NotConstant;
                };
                result.push_str(cooked);
                if let Some(sub) = tpl.expressions.get(i) {
                    let v = eval_sub!(sub);
                    result.push_str(&v.to_js_string());
                }
            }
            Constant(ConstVal::String(result))
        }
        Expression::TaggedTemplateExpression(_) => Unsupported(String::from(
            "TaggedTemplateExpression constant evaluation is not supported",
        )),
        Expression::Identifier(id) => match id.name.as_str() {
            "pug_interp" if allow_pug_constants => Constant(ConstVal::Undefined),
            "pug" if allow_pug_constants => Constant(ConstVal::PugRuntime),
            _ => NotConstant,
        },
        Expression::ArrayExpression(arr) => {
            let mut out = Vec::new();
            for elem in &arr.elements {
                match elem {
                    ArrayExpressionElement::SpreadElement(spread) => match eval_sub!(&spread.argument)
                    {
                        ConstVal::Array(items) => out.extend(items),
                        ConstVal::String(s) => {
                            out.extend(s.chars().map(|c| ConstVal::String(c.to_string())));
                        }
                        _ => return NotConstant,
                    },
                    ArrayExpressionElement::Elision(_) => return NotConstant,
                    other => {
                        let Some(e) = other.as_expression() else {
                            return NotConstant;
                        };
                        out.push(eval_sub!(e));
                    }
                }
            }
            Constant(ConstVal::Array(out))
        }
        Expression::ObjectExpression(obj) => {
            let mut entries: Vec<(String, ConstVal)> = Vec::new();
            for prop in &obj.properties {
                match prop {
                    ObjectPropertyKind::ObjectProperty(p) => {
                        if p.shorthand || p.method {
                            return NotConstant;
                        }
                        let key = if p.computed {
                            let kv = eval_sub!(p.key.as_expression().unwrap_or(&p.value));
                            kv.to_js_string()
                        } else {
                            match &p.key {
                                PropertyKey::StaticIdentifier(id) => id.name.to_string(),
                                PropertyKey::StringLiteral(s) => match s.value.as_str() {
                                    Some(v) => v.to_string(),
                                    None => return NotConstant,
                                },
                                _ => return NotConstant,
                            }
                        };
                        if key.is_empty() || key.starts_with('_') {
                            return NotConstant;
                        }
                        let val = eval_sub!(&p.value);
                        if let Some(existing) = entries.iter_mut().find(|(k, _)| k == &key) {
                            existing.1 = val;
                        } else {
                            entries.push((key, val));
                        }
                    }
                    ObjectPropertyKind::SpreadProperty(spread) => match eval_sub!(&spread.argument)
                    {
                        ConstVal::Object(other_entries) => {
                            for (k, v) in other_entries {
                                if let Some(existing) =
                                    entries.iter_mut().find(|(ek, _)| ek == &k)
                                {
                                    existing.1 = v;
                                } else {
                                    entries.push((k, v));
                                }
                            }
                        }
                        _ => return NotConstant,
                    },
                }
            }
            Constant(ConstVal::Object(entries))
        }
        Expression::UnaryExpression(u) => {
            let arg = eval_sub!(&u.argument);
            match u.operator {
                UnaryOperator::UnaryNegation => Constant(ConstVal::Number(-arg.to_js_number())),
                UnaryOperator::UnaryPlus => Constant(ConstVal::Number(arg.to_js_number())),
                UnaryOperator::LogicalNot => Constant(ConstVal::Bool(!arg.is_truthy())),
                UnaryOperator::BitwiseNot => {
                    let n = arg.to_js_number() as i64 as i32;
                    Constant(ConstVal::Number((!n) as f64))
                }
                UnaryOperator::Typeof => {
                    let t = match arg {
                        ConstVal::Undefined => "undefined",
                        ConstVal::Null
                        | ConstVal::Array(_)
                        | ConstVal::Object(_)
                        | ConstVal::RegExp { .. }
                        | ConstVal::PugRuntime => "object",
                        ConstVal::Bool(_) => "boolean",
                        ConstVal::Number(_) => "number",
                        ConstVal::String(_) => "string",
                        ConstVal::PugMethod(_) => "function",
                    };
                    Constant(ConstVal::String(String::from(t)))
                }
                UnaryOperator::Void => Constant(ConstVal::Undefined),
                UnaryOperator::Delete => NotConstant,
            }
        }
        Expression::BinaryExpression(bin) => {
            let left = eval_sub!(&bin.left);
            let right = eval_sub!(&bin.right);
            eval_binary(bin.operator, left, right)
        }
        Expression::LogicalExpression(log) => {
            let left = eval_sub!(&log.left);
            let right = eval_sub!(&log.right);
            match log.operator {
                LogicalOperator::And => Constant(if left.is_truthy() { right } else { left }),
                LogicalOperator::Or => Constant(if left.is_truthy() { left } else { right }),
                LogicalOperator::Coalesce => Unsupported(String::from(
                    "Nullish coalescing constant evaluation is not supported",
                )),
            }
        }
        Expression::ConditionalExpression(cond) => {
            let test = eval_sub!(&cond.test);
            if test.is_truthy() {
                eval_expr(&cond.consequent, allow_pug_constants)
            } else {
                eval_expr(&cond.alternate, allow_pug_constants)
            }
        }
        Expression::StaticMemberExpression(mem) => {
            let obj = eval_sub!(&mem.object);
            let prop = mem.property.name.as_str();
            eval_member(obj, prop)
        }
        Expression::ComputedMemberExpression(mem) => {
            let obj = eval_sub!(&mem.object);
            let prop_val = eval_sub!(&mem.expression);
            let prop = prop_val.to_js_string();
            eval_member(obj, &prop)
        }
        Expression::CallExpression(call) => {
            let mut args = Vec::new();
            for arg in &call.arguments {
                match arg {
                    Argument::SpreadElement(spread) => match eval_sub!(&spread.argument) {
                        ConstVal::Array(items) => args.extend(items),
                        ConstVal::String(s) => {
                            args.extend(s.chars().map(|c| ConstVal::String(c.to_string())));
                        }
                        _ => return NotConstant,
                    },
                    other => {
                        let Some(e) = other.as_expression() else {
                            return NotConstant;
                        };
                        args.push(eval_sub!(e));
                    }
                }
            }
            match &call.callee {
                Expression::StaticMemberExpression(mem) => {
                    let obj = eval_sub!(&mem.object);
                    let method = mem.property.name.as_str();
                    eval_method_call(obj, method, &args)
                }
                Expression::ComputedMemberExpression(mem) => {
                    let obj = eval_sub!(&mem.object);
                    let method_val = eval_sub!(&mem.expression);
                    let method = method_val.to_js_string();
                    eval_method_call(obj, &method, &args)
                }
                other_callee => {
                    let callee = eval_sub!(other_callee);
                    if let ConstVal::PugMethod(m) = callee {
                        match eval_pug_method(m, &args) {
                            Some(v) => Constant(v),
                            None => NotConstant,
                        }
                    } else {
                        NotConstant
                    }
                }
            }
        }
        _ => NotConstant,
    }
}

fn eval_member(obj: ConstVal, prop: &str) -> ConstEvalOutcome {
    if prop.starts_with('_') {
        return ConstEvalOutcome::NotConstant;
    }
    match obj {
        ConstVal::PugRuntime => match prop {
            "escape" => ConstEvalOutcome::Constant(ConstVal::PugMethod("escape")),
            "attr" => ConstEvalOutcome::Constant(ConstVal::PugMethod("attr")),
            "attrs" => ConstEvalOutcome::Constant(ConstVal::PugMethod("attrs")),
            "classes" => ConstEvalOutcome::Constant(ConstVal::PugMethod("classes")),
            "style" => ConstEvalOutcome::Constant(ConstVal::PugMethod("style")),
            _ => ConstEvalOutcome::NotConstant,
        },
        ConstVal::Object(entries) => match entries.into_iter().find(|(k, _)| k == prop) {
            Some((_, v)) => ConstEvalOutcome::Constant(v),
            None => ConstEvalOutcome::NotConstant,
        },
        ConstVal::Array(items) => {
            if prop == "length" {
                ConstEvalOutcome::Constant(ConstVal::Number(items.len() as f64))
            } else if let Ok(idx) = prop.parse::<usize>() {
                match items.get(idx).cloned() {
                    Some(v) => ConstEvalOutcome::Constant(v),
                    None => ConstEvalOutcome::NotConstant,
                }
            } else {
                ConstEvalOutcome::NotConstant
            }
        }
        ConstVal::String(s) => {
            if prop == "length" {
                ConstEvalOutcome::Constant(ConstVal::Number(s.encode_utf16().count() as f64))
            } else if let Ok(idx) = prop.parse::<usize>() {
                let units: Vec<u16> = s.encode_utf16().collect();
                match units
                    .get(idx)
                    .map(|&u| ConstVal::String(String::from_utf16_lossy(&[u])))
                {
                    Some(v) => ConstEvalOutcome::Constant(v),
                    None => ConstEvalOutcome::NotConstant,
                }
            } else {
                ConstEvalOutcome::NotConstant
            }
        }
        _ => ConstEvalOutcome::NotConstant,
    }
}

fn eval_method_call(obj: ConstVal, method: &str, args: &[ConstVal]) -> ConstEvalOutcome {
    use ConstEvalOutcome::*;
    match obj {
        ConstVal::PugRuntime => match eval_pug_method(method, args) {
            Some(v) => Constant(v),
            None => NotConstant,
        },
        ConstVal::String(s) => match method {
            "trim" => Constant(ConstVal::String(s.trim().to_string())),
            "toLowerCase" => Constant(ConstVal::String(s.to_lowercase())),
            "toUpperCase" => Constant(ConstVal::String(s.to_uppercase())),
            "concat" => {
                let mut out = s;
                for a in args {
                    out.push_str(&a.to_js_string());
                }
                Constant(ConstVal::String(out))
            }
            "repeat" => {
                let count = args.first().map(ConstVal::to_js_number).unwrap_or(0.0).max(0.0) as usize;
                Constant(ConstVal::String(s.repeat(count)))
            }
            "startsWith" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                Constant(ConstVal::Bool(s.starts_with(&pat)))
            }
            "endsWith" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                Constant(ConstVal::Bool(s.ends_with(&pat)))
            }
            "includes" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                Constant(ConstVal::Bool(s.contains(&pat)))
            }
            "indexOf" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                let pos = args.get(1).map(|a| a.to_js_number().max(0.0) as usize).unwrap_or(0);
                let byte_idx = s.char_indices().nth(pos).map(|(i, _)| i).unwrap_or(s.len());
                let res = s[byte_idx..]
                    .find(&pat)
                    .map(|off| s[..byte_idx + off].encode_utf16().count() as f64)
                    .unwrap_or(-1.0);
                Constant(ConstVal::Number(res))
            }
            "replace" => {
                let Some(first) = args.first() else {
                    return Constant(ConstVal::String(s));
                };
                if matches!(first, ConstVal::RegExp { .. }) {
                    return Unsupported(String::from(
                        "String.prototype.replace with RegExp is not supported",
                    ));
                }
                let pat = first.to_js_string();
                let rep = args.get(1).map(ConstVal::to_js_string).unwrap_or_else(|| String::from("undefined"));
                Constant(ConstVal::String(s.replacen(&pat, &rep, 1)))
            }
            "slice" | "substring" | "substr" => {
                let units: Vec<u16> = s.encode_utf16().collect();
                let len = units.len() as isize;
                let norm = |raw: f64, _default: isize| -> isize {
                    if raw.is_nan() {
                        0
                    } else if method == "slice" {
                        let i = raw as isize;
                        if i < 0 { (len + i).max(0) } else { i.min(len) }
                    } else {
                        (raw as isize).clamp(0, len)
                    }
                };
                let start = args.first().map(|a| norm(a.to_js_number(), 0)).unwrap_or(0);
                let end = if method == "substr" {
                    let count = args
                        .get(1)
                        .map(|a| (a.to_js_number() as isize).max(0))
                        .unwrap_or(len - start);
                    (start + count).min(len)
                } else {
                    args.get(1).map(|a| norm(a.to_js_number(), len)).unwrap_or(len)
                };
                let (lo, hi) = if method == "substring" && start > end {
                    (end as usize, start as usize)
                } else {
                    (start as usize, end.max(start) as usize)
                };
                Constant(ConstVal::String(String::from_utf16_lossy(&units[lo..hi])))
            }
            "split" => {
                let Some(first) = args.first() else {
                    return Constant(ConstVal::Array(vec![ConstVal::String(s)]));
                };
                if matches!(first, ConstVal::RegExp { .. }) {
                    return Unsupported(String::from(
                        "String.prototype.split with RegExp is not supported",
                    ));
                }
                let sep = first.to_js_string();
                let parts = s
                    .split(&sep)
                    .map(|p| ConstVal::String(p.to_string()))
                    .collect();
                Constant(ConstVal::Array(parts))
            }
            "lastIndexOf" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                let units_s: Vec<u16> = s.encode_utf16().collect();
                let units_p: Vec<u16> = pat.encode_utf16().collect();
                let max_pos = args
                    .get(1)
                    .map(|a| {
                        let n = a.to_js_number();
                        if n.is_nan() {
                            units_s.len()
                        } else if n < 0.0 {
                            0
                        } else {
                            (n as usize).min(units_s.len())
                        }
                    })
                    .unwrap_or(units_s.len());
                let res = if units_p.is_empty() {
                    Some(max_pos)
                } else if units_p.len() > units_s.len() {
                    None
                } else {
                    let upper = max_pos.min(units_s.len() - units_p.len());
                    (0..=upper)
                        .rev()
                        .find(|&idx| units_s[idx..idx + units_p.len()] == units_p[..])
                };
                Constant(ConstVal::Number(res.map(|i| i as f64).unwrap_or(-1.0)))
            }
            "charAt" => {
                let n = args.first().map(ConstVal::to_js_number).unwrap_or(0.0);
                let out = if n.is_nan() {
                    let units: Vec<u16> = s.encode_utf16().collect();
                    units
                        .first()
                        .map(|&u| String::from_utf16_lossy(&[u]))
                        .unwrap_or_default()
                } else if n < 0.0 {
                    String::new()
                } else {
                    let units: Vec<u16> = s.encode_utf16().collect();
                    units
                        .get(n as usize)
                        .map(|&u| String::from_utf16_lossy(&[u]))
                        .unwrap_or_default()
                };
                Constant(ConstVal::String(out))
            }
            "charCodeAt" => {
                let n = args.first().map(ConstVal::to_js_number).unwrap_or(0.0);
                let units: Vec<u16> = s.encode_utf16().collect();
                let code = if n.is_nan() {
                    units.first().map(|&u| u as f64).unwrap_or(f64::NAN)
                } else if n < 0.0 {
                    f64::NAN
                } else {
                    units
                        .get(n as usize)
                        .map(|&u| u as f64)
                        .unwrap_or(f64::NAN)
                };
                Constant(ConstVal::Number(code))
            }
            "codePointAt" => {
                let n = args.first().map(ConstVal::to_js_number).unwrap_or(0.0);
                let units: Vec<u16> = s.encode_utf16().collect();
                let idx = if n.is_nan() {
                    Some(0usize)
                } else if n < 0.0 {
                    None
                } else {
                    Some(n as usize)
                };
                match idx.and_then(|i| units.get(i).map(|&u| (i, u))) {
                    None => Constant(ConstVal::Undefined),
                    Some((i, first)) => {
                        let cp = if (0xD800..=0xDBFF).contains(&first)
                            && let Some(&second) = units.get(i + 1)
                            && (0xDC00..=0xDFFF).contains(&second)
                        {
                            0x10000 + (((first as u32 - 0xD800) << 10) | (second as u32 - 0xDC00))
                        } else {
                            first as u32
                        };
                        Constant(ConstVal::Number(cp as f64))
                    }
                }
            }
            "padStart" | "padEnd" => {
                let target_len = args
                    .first()
                    .map(|a| a.to_js_number().max(0.0) as usize)
                    .unwrap_or(0);
                let pad_str = args
                    .get(1)
                    .filter(|a| !matches!(a, ConstVal::Undefined))
                    .map(ConstVal::to_js_string)
                    .unwrap_or_else(|| String::from(" "));
                let s_units: Vec<u16> = s.encode_utf16().collect();
                if target_len <= s_units.len() || pad_str.is_empty() {
                    return Constant(ConstVal::String(s));
                }
                let need = target_len - s_units.len();
                let pad_units: Vec<u16> = pad_str.encode_utf16().collect();
                let mut filler = Vec::with_capacity(need);
                while filler.len() < need {
                    let rem = need - filler.len();
                    let take = rem.min(pad_units.len());
                    filler.extend_from_slice(&pad_units[..take]);
                }
                let out = if method == "padStart" {
                    let mut combined = filler;
                    combined.extend_from_slice(&s_units);
                    String::from_utf16_lossy(&combined)
                } else {
                    let mut combined = s_units;
                    combined.extend_from_slice(&filler);
                    String::from_utf16_lossy(&combined)
                };
                Constant(ConstVal::String(out))
            }
            "match" | "search" | "normalize" => {
                Unsupported(format!("String.prototype.{method} constant evaluation is not supported"))
            }
            _ => NotConstant,
        },
        ConstVal::RegExp { .. } => match method {
            "test" | "exec" => Unsupported(format!("RegExp.prototype.{method} constant evaluation is not supported")),
            _ => NotConstant,
        },
        ConstVal::Bool(b) if method == "toString" => Constant(ConstVal::String(b.to_string())),
        ConstVal::Number(n) => match method {
            "toString" => Constant(ConstVal::String(format_js_number(n))),
            "toFixed" => {
                let digits = args
                    .first()
                    .map(|a| (a.to_js_number() as isize).clamp(0, 20) as usize)
                    .unwrap_or(0);
                Constant(ConstVal::String(format!("{n:.digits$}")))
            }
            "toExponential" | "toPrecision" => Unsupported(format!(
                "Number.prototype.{method} constant evaluation is not supported"
            )),
            _ => NotConstant,
        },
        _ => NotConstant,
    }
}

fn eval_pug_method(method: &str, args: &[ConstVal]) -> Option<ConstVal> {
    match method {
        "escape" => {
            let arg = args.first().unwrap_or(&ConstVal::Undefined);
            let s = arg.to_js_string();
            let escaped = pug_escape(&s);
            if escaped == s {
                Some(arg.clone())
            } else {
                Some(ConstVal::String(escaped))
            }
        }
        "style" => {
            let arg = args.first().unwrap_or(&ConstVal::Undefined);
            Some(ConstVal::String(pug_style(arg)))
        }
        "classes" => {
            let val = args.first().unwrap_or(&ConstVal::Undefined);
            let escaping: Option<Vec<bool>> = match args.get(1) {
                Some(ConstVal::Array(arr)) => {
                    Some(arr.iter().map(ConstVal::is_truthy).collect())
                }
                _ => None,
            };
            Some(ConstVal::String(pug_classes(val, escaping.as_deref())))
        }
        "attr" => {
            let key = args.first().map(ConstVal::to_js_string).unwrap_or_default();
            let val = args.get(1).unwrap_or(&ConstVal::Undefined);
            let escaped = args.get(2).is_some_and(ConstVal::is_truthy);
            let terse = args.get(3).is_some_and(ConstVal::is_truthy);
            Some(ConstVal::String(pug_attr(&key, val, escaped, terse)))
        }
        _ => None,
    }
}

fn eval_binary(op: BinaryOperator, left: ConstVal, right: ConstVal) -> ConstEvalOutcome {
    use ConstEvalOutcome::*;
    match op {
        BinaryOperator::Addition => {
            if matches!(
                left,
                ConstVal::String(_) | ConstVal::Array(_) | ConstVal::Object(_)
            ) || matches!(
                right,
                ConstVal::String(_) | ConstVal::Array(_) | ConstVal::Object(_)
            ) {
                Constant(ConstVal::String(format!(
                    "{}{}",
                    left.to_js_string(),
                    right.to_js_string()
                )))
            } else {
                Constant(ConstVal::Number(left.to_js_number() + right.to_js_number()))
            }
        }
        BinaryOperator::Subtraction => {
            Constant(ConstVal::Number(left.to_js_number() - right.to_js_number()))
        }
        BinaryOperator::Multiplication => {
            Constant(ConstVal::Number(left.to_js_number() * right.to_js_number()))
        }
        BinaryOperator::Division => {
            Constant(ConstVal::Number(left.to_js_number() / right.to_js_number()))
        }
        BinaryOperator::Remainder => {
            Constant(ConstVal::Number(left.to_js_number() % right.to_js_number()))
        }
        BinaryOperator::Exponential => Constant(ConstVal::Number(
            left.to_js_number().powf(right.to_js_number()),
        )),
        BinaryOperator::StrictEquality => Constant(ConstVal::Bool(strict_eq(&left, &right))),
        BinaryOperator::StrictInequality => Constant(ConstVal::Bool(!strict_eq(&left, &right))),
        BinaryOperator::Equality => Constant(ConstVal::Bool(abstract_eq(&left, &right))),
        BinaryOperator::Inequality => Constant(ConstVal::Bool(!abstract_eq(&left, &right))),
        BinaryOperator::LessThan => Constant(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().lt(b.encode_utf16()),
            _ => left.to_js_number() < right.to_js_number(),
        })),
        BinaryOperator::LessEqualThan => Constant(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().le(b.encode_utf16()),
            _ => left.to_js_number() <= right.to_js_number(),
        })),
        BinaryOperator::GreaterThan => Constant(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().gt(b.encode_utf16()),
            _ => left.to_js_number() > right.to_js_number(),
        })),
        BinaryOperator::GreaterEqualThan => Constant(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().ge(b.encode_utf16()),
            _ => left.to_js_number() >= right.to_js_number(),
        })),
        BinaryOperator::BitwiseOR => {
            let a = left.to_js_number() as i64 as i32;
            let b = right.to_js_number() as i64 as i32;
            Constant(ConstVal::Number((a | b) as f64))
        }
        BinaryOperator::BitwiseAnd => {
            let a = left.to_js_number() as i64 as i32;
            let b = right.to_js_number() as i64 as i32;
            Constant(ConstVal::Number((a & b) as f64))
        }
        BinaryOperator::BitwiseXOR => {
            let a = left.to_js_number() as i64 as i32;
            let b = right.to_js_number() as i64 as i32;
            Constant(ConstVal::Number((a ^ b) as f64))
        }
        BinaryOperator::ShiftLeft => {
            let a = left.to_js_number() as i64 as i32;
            let b = (right.to_js_number() as i64 as u32) & 0x1f;
            Constant(ConstVal::Number((a << b) as f64))
        }
        BinaryOperator::ShiftRight => {
            let a = left.to_js_number() as i64 as i32;
            let b = (right.to_js_number() as i64 as u32) & 0x1f;
            Constant(ConstVal::Number((a >> b) as f64))
        }
        BinaryOperator::ShiftRightZeroFill => {
            let a = left.to_js_number() as i64 as u32;
            let b = (right.to_js_number() as i64 as u32) & 0x1f;
            Constant(ConstVal::Number((a >> b) as f64))
        }
        BinaryOperator::In => {
            let key = left.to_js_string();
            match right {
                ConstVal::Object(entries) => {
                    Constant(ConstVal::Bool(entries.iter().any(|(k, _)| k == &key)))
                }
                ConstVal::Array(items) => {
                    let found = key == "length"
                        || key
                            .parse::<usize>()
                            .is_ok_and(|idx| idx < items.len());
                    Constant(ConstVal::Bool(found))
                }
                _ => NotConstant,
            }
        }
        BinaryOperator::Instanceof => {
            Unsupported(String::from("instanceof constant evaluation is not supported"))
        }
    }
}

fn strict_eq(left: &ConstVal, right: &ConstVal) -> bool {
    match (left, right) {
        (ConstVal::Undefined, ConstVal::Undefined) | (ConstVal::Null, ConstVal::Null) => true,
        (ConstVal::Bool(a), ConstVal::Bool(b)) => a == b,
        (ConstVal::Number(a), ConstVal::Number(b)) => a == b,
        (ConstVal::String(a), ConstVal::String(b)) => a == b,
        _ => false,
    }
}

fn abstract_eq(left: &ConstVal, right: &ConstVal) -> bool {
    if strict_eq(left, right) {
        return true;
    }
    if matches!(
        (left, right),
        (ConstVal::Null, ConstVal::Undefined) | (ConstVal::Undefined, ConstVal::Null)
    ) {
        return true;
    }
    if matches!(left, ConstVal::Null | ConstVal::Undefined)
        || matches!(right, ConstVal::Null | ConstVal::Undefined)
    {
        return false;
    }
    left.to_js_number() == right.to_js_number()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constant_number_json_and_string_formatting() {
        let val = eval_constant("1 + 2").unwrap();
        assert_eq!(val.to_json_value(), serde_json::json!(3));
        assert_eq!(val.to_json_string(), "3");
        assert_eq!(pug_attr("foo", &val, true, false), " foo=\"3\"");

        let neg = eval_constant("-5").unwrap();
        assert_eq!(neg.to_json_value(), serde_json::json!(-5));
        assert_eq!(neg.to_json_string(), "-5");

        let dec = eval_constant("1.5").unwrap();
        assert_eq!(dec.to_json_value(), serde_json::json!(1.5));
        assert_eq!(dec.to_json_string(), "1.5");

        let neg_zero = eval_constant("0 * -1").unwrap();
        assert_eq!(neg_zero.to_json_value(), serde_json::json!(0));
        assert_eq!(neg_zero.to_json_string(), "0");
        assert_eq!(neg_zero.to_js_string(), "0");

        let arr = eval_constant("[1, -2, 3.5, -0]").unwrap();
        assert_eq!(arr.to_json_string(), "[1,-2,3.5,0]");

        let obj = eval_constant("({ x: 1, y: 2.5, z: -0 })").unwrap();
        assert_eq!(obj.to_json_string(), "{\"x\":1,\"y\":2.5,\"z\":0}");

        let max_safe = eval_constant("9007199254740991").unwrap();
        assert_eq!(max_safe.to_json_value(), serde_json::json!(9007199254740991_i64));
        assert_eq!(max_safe.to_json_string(), "9007199254740991");

        assert_eq!(eval_constant("1e20").unwrap().to_json_string(), "100000000000000000000");
        assert_eq!(eval_constant("1e21").unwrap().to_json_string(), "1e+21");
        assert_eq!(eval_constant("1e-6").unwrap().to_json_string(), "0.000001");
        assert_eq!(eval_constant("1e-7").unwrap().to_json_string(), "1e-7");

        let inf = eval_constant("1 / 0").unwrap();
        assert_eq!(inf.to_json_value(), serde_json::Value::Null);
        assert_eq!(inf.to_json_string(), "null");
        assert_eq!(inf.to_js_string(), "Infinity");

        let nan = eval_constant("0 / 0").unwrap();
        assert_eq!(nan.to_json_value(), serde_json::Value::Null);
        assert_eq!(nan.to_json_string(), "null");
        assert_eq!(nan.to_js_string(), "NaN");

        assert!(!is_constant("undefined"));
        assert!(!is_constant("Infinity"));
        assert!(!is_constant("NaN"));
        assert!(!is_constant("({ 1: 'a' })"));
        assert!(!is_constant("({ '': 'a' })"));
        assert!(!is_constant("({ _a: 1 })"));
        assert!(is_constant("void 0"));
        assert!(is_constant("pug_interp"));
        assert_eq!(eval_constant("'abc'.charAt(1)"), Some(ConstVal::String("b".into())));
        assert_eq!(eval_constant("'abc'.charCodeAt(1)"), Some(ConstVal::Number(98.0)));
        assert_eq!(eval_constant("'a'.padStart(3, '0')"), Some(ConstVal::String("00a".into())));
        assert_eq!(eval_constant("'a'.padEnd(3, '0')"), Some(ConstVal::String("a00".into())));
        assert_eq!(eval_constant("'abcb'.lastIndexOf('b')"), Some(ConstVal::Number(3.0)));
        assert_eq!(eval_filter_constant("null ?? 1"), ConstEvalOutcome::Unsupported("Nullish coalescing constant evaluation is not supported".into()));
        assert_eq!(eval_filter_constant("dynamicIdent"), ConstEvalOutcome::NotConstant);
        assert_eq!(eval_filter_constant("(1 +"), ConstEvalOutcome::NotConstant);
    }
}
