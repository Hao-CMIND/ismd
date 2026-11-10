use oxc::allocator::Allocator;
use oxc::ast::ast::{
    Argument, ArrayExpressionElement, BinaryOperator, Expression, LogicalOperator,
    ObjectPropertyKind, PropertyKey, UnaryOperator,
};
use oxc::parser::Parser;
use oxc::span::SourceType;

/// Compile-time constant value matching `constantinople@3.1.2` with `{ pug: runtime, pug_interp: undefined }`.
#[derive(Debug, Clone, PartialEq)]
pub enum ConstVal {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<ConstVal>),
    Object(Vec<(String, ConstVal)>),
    PugRuntime,
    PugMethod(&'static str),
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
            ConstVal::Object(_) | ConstVal::PugRuntime | ConstVal::PugMethod(_) => f64::NAN,
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
            ConstVal::PugRuntime | ConstVal::PugMethod(_) => {
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
            ConstVal::PugRuntime | ConstVal::PugMethod(_) => String::from("{}"),
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
    eval_expr(&expr)
}

fn eval_expr(expr: &Expression<'_>) -> Option<ConstVal> {
    match expr {
        Expression::BooleanLiteral(b) => Some(ConstVal::Bool(b.value)),
        Expression::NullLiteral(_) => Some(ConstVal::Null),
        Expression::NumericLiteral(n) => Some(ConstVal::Number(n.value)),
        Expression::StringLiteral(s) => Some(ConstVal::String(s.value.as_str()?.to_string())),
        Expression::ParenthesizedExpression(p) => eval_expr(&p.expression),
        Expression::SequenceExpression(seq) => {
            let mut last = ConstVal::Undefined;
            for sub in &seq.expressions {
                last = eval_expr(sub)?;
            }
            Some(last)
        }
        Expression::TemplateLiteral(tpl) => {
            let mut result = String::new();
            for (i, quasi) in tpl.quasis.iter().enumerate() {
                let cooked = quasi.value.cooked.as_ref()?;
                result.push_str(cooked.as_str()?);
                if let Some(sub) = tpl.expressions.get(i) {
                    let v = eval_expr(sub)?;
                    result.push_str(&v.to_js_string());
                }
            }
            Some(ConstVal::String(result))
        }
        Expression::Identifier(id) => match id.name.as_str() {
            "pug_interp" => Some(ConstVal::Undefined),
            "pug" => Some(ConstVal::PugRuntime),
            _ => None,
        },
        Expression::ArrayExpression(arr) => {
            let mut out = Vec::new();
            for elem in &arr.elements {
                match elem {
                    ArrayExpressionElement::SpreadElement(spread) => {
                        match eval_expr(&spread.argument)? {
                            ConstVal::Array(items) => out.extend(items),
                            ConstVal::String(s) => {
                                out.extend(s.chars().map(|c| ConstVal::String(c.to_string())));
                            }
                            _ => return None,
                        }
                    }
                    ArrayExpressionElement::Elision(_) => return None,
                    other => {
                        let e = other.as_expression()?;
                        out.push(eval_expr(e)?);
                    }
                }
            }
            Some(ConstVal::Array(out))
        }
        Expression::ObjectExpression(obj) => {
            let mut entries: Vec<(String, ConstVal)> = Vec::new();
            for prop in &obj.properties {
                match prop {
                    ObjectPropertyKind::ObjectProperty(p) => {
                        if p.shorthand || p.method {
                            return None;
                        }
                        let key = if p.computed {
                            let kv = eval_expr(p.key.as_expression()?)?;
                            kv.to_js_string()
                        } else {
                            match &p.key {
                                PropertyKey::StaticIdentifier(id) => id.name.to_string(),
                                PropertyKey::StringLiteral(s) => s.value.as_str()?.to_string(),
                                _ => return None,
                            }
                        };
                        if key.is_empty() || key.starts_with('_') {
                            return None;
                        }
                        let val = eval_expr(&p.value)?;
                        if let Some(existing) = entries.iter_mut().find(|(k, _)| k == &key) {
                            existing.1 = val;
                        } else {
                            entries.push((key, val));
                        }
                    }
                    ObjectPropertyKind::SpreadProperty(spread) => {
                        match eval_expr(&spread.argument)? {
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
                            _ => return None,
                        }
                    }
                }
            }
            Some(ConstVal::Object(entries))
        }
        Expression::UnaryExpression(u) => {
            let arg = eval_expr(&u.argument)?;
            match u.operator {
                UnaryOperator::UnaryNegation => Some(ConstVal::Number(-arg.to_js_number())),
                UnaryOperator::UnaryPlus => Some(ConstVal::Number(arg.to_js_number())),
                UnaryOperator::LogicalNot => Some(ConstVal::Bool(!arg.is_truthy())),
                UnaryOperator::BitwiseNot => {
                    let n = arg.to_js_number() as i64 as i32;
                    Some(ConstVal::Number((!n) as f64))
                }
                UnaryOperator::Typeof => {
                    let t = match arg {
                        ConstVal::Undefined => "undefined",
                        ConstVal::Null | ConstVal::Array(_) | ConstVal::Object(_) | ConstVal::PugRuntime => "object",
                        ConstVal::Bool(_) => "boolean",
                        ConstVal::Number(_) => "number",
                        ConstVal::String(_) => "string",
                        ConstVal::PugMethod(_) => "function",
                    };
                    Some(ConstVal::String(String::from(t)))
                }
                UnaryOperator::Void => Some(ConstVal::Undefined),
                UnaryOperator::Delete => None,
            }
        }
        Expression::BinaryExpression(bin) => {
            let left = eval_expr(&bin.left)?;
            let right = eval_expr(&bin.right)?;
            eval_binary(bin.operator, left, right)
        }
        Expression::LogicalExpression(log) => {
            let left = eval_expr(&log.left)?;
            let right = eval_expr(&log.right)?;
            match log.operator {
                LogicalOperator::And => Some(if left.is_truthy() { right } else { left }),
                LogicalOperator::Or => Some(if left.is_truthy() { left } else { right }),
                LogicalOperator::Coalesce => None,
            }
        }
        Expression::ConditionalExpression(cond) => {
            let test = eval_expr(&cond.test)?;
            if test.is_truthy() {
                eval_expr(&cond.consequent)
            } else {
                eval_expr(&cond.alternate)
            }
        }
        Expression::StaticMemberExpression(mem) => {
            let obj = eval_expr(&mem.object)?;
            let prop = mem.property.name.as_str();
            eval_member(obj, prop)
        }
        Expression::ComputedMemberExpression(mem) => {
            let obj = eval_expr(&mem.object)?;
            let prop_val = eval_expr(&mem.expression)?;
            let prop = prop_val.to_js_string();
            eval_member(obj, &prop)
        }
        Expression::CallExpression(call) => {
            let mut args = Vec::new();
            for arg in &call.arguments {
                match arg {
                    Argument::SpreadElement(spread) => match eval_expr(&spread.argument)? {
                        ConstVal::Array(items) => args.extend(items),
                        ConstVal::String(s) => {
                            args.extend(s.chars().map(|c| ConstVal::String(c.to_string())));
                        }
                        _ => return None,
                    },
                    other => {
                        let e = other.as_expression()?;
                        args.push(eval_expr(e)?);
                    }
                }
            }
            match &call.callee {
                Expression::StaticMemberExpression(mem) => {
                    let obj = eval_expr(&mem.object)?;
                    let method = mem.property.name.as_str();
                    eval_method_call(obj, method, &args)
                }
                Expression::ComputedMemberExpression(mem) => {
                    let obj = eval_expr(&mem.object)?;
                    let method_val = eval_expr(&mem.expression)?;
                    let method = method_val.to_js_string();
                    eval_method_call(obj, &method, &args)
                }
                other_callee => {
                    let callee = eval_expr(other_callee)?;
                    if let ConstVal::PugMethod(m) = callee {
                        eval_pug_method(m, &args)
                    } else {
                        None
                    }
                }
            }
        }
        _ => None,
    }
}

fn eval_member(obj: ConstVal, prop: &str) -> Option<ConstVal> {
    if prop.starts_with('_') {
        return None;
    }
    match obj {
        ConstVal::PugRuntime => match prop {
            "escape" => Some(ConstVal::PugMethod("escape")),
            "attr" => Some(ConstVal::PugMethod("attr")),
            "attrs" => Some(ConstVal::PugMethod("attrs")),
            "classes" => Some(ConstVal::PugMethod("classes")),
            "style" => Some(ConstVal::PugMethod("style")),
            _ => None,
        },
        ConstVal::Object(entries) => entries
            .into_iter()
            .find(|(k, _)| k == prop)
            .map(|(_, v)| v),
        ConstVal::Array(items) => {
            if prop == "length" {
                Some(ConstVal::Number(items.len() as f64))
            } else if let Ok(idx) = prop.parse::<usize>() {
                items.get(idx).cloned()
            } else {
                None
            }
        }
        ConstVal::String(s) => {
            if prop == "length" {
                Some(ConstVal::Number(s.encode_utf16().count() as f64))
            } else if let Ok(idx) = prop.parse::<usize>() {
                let units: Vec<u16> = s.encode_utf16().collect();
                units
                    .get(idx)
                    .map(|&u| ConstVal::String(String::from_utf16_lossy(&[u])))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn eval_method_call(obj: ConstVal, method: &str, args: &[ConstVal]) -> Option<ConstVal> {
    match obj {
        ConstVal::PugRuntime => eval_pug_method(method, args),
        ConstVal::String(s) => match method {
            "trim" => Some(ConstVal::String(s.trim().to_string())),
            "toLowerCase" => Some(ConstVal::String(s.to_lowercase())),
            "toUpperCase" => Some(ConstVal::String(s.to_uppercase())),
            "concat" => {
                let mut out = s;
                for a in args {
                    out.push_str(&a.to_js_string());
                }
                Some(ConstVal::String(out))
            }
            "repeat" => {
                let count = args.first().map(ConstVal::to_js_number).unwrap_or(0.0) as usize;
                Some(ConstVal::String(s.repeat(count)))
            }
            "startsWith" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                Some(ConstVal::Bool(s.starts_with(&pat)))
            }
            "endsWith" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                Some(ConstVal::Bool(s.ends_with(&pat)))
            }
            "includes" => {
                let pat = args.first().map(ConstVal::to_js_string).unwrap_or_default();
                Some(ConstVal::Bool(s.contains(&pat)))
            }
            "split" => {
                let sep = args.first().map(ConstVal::to_js_string)?;
                let parts = s
                    .split(&sep)
                    .map(|p| ConstVal::String(p.to_string()))
                    .collect();
                Some(ConstVal::Array(parts))
            }
            _ => None,
        },
        ConstVal::Bool(b) if method == "toString" => Some(ConstVal::String(b.to_string())),
        ConstVal::Number(n) if method == "toString" => {
            Some(ConstVal::String(format_js_number(n)))
        }
        _ => None,
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

fn eval_binary(op: BinaryOperator, left: ConstVal, right: ConstVal) -> Option<ConstVal> {
    match op {
        BinaryOperator::Addition => {
            if matches!(
                left,
                ConstVal::String(_) | ConstVal::Array(_) | ConstVal::Object(_)
            ) || matches!(
                right,
                ConstVal::String(_) | ConstVal::Array(_) | ConstVal::Object(_)
            ) {
                Some(ConstVal::String(format!(
                    "{}{}",
                    left.to_js_string(),
                    right.to_js_string()
                )))
            } else {
                Some(ConstVal::Number(left.to_js_number() + right.to_js_number()))
            }
        }
        BinaryOperator::Subtraction => {
            Some(ConstVal::Number(left.to_js_number() - right.to_js_number()))
        }
        BinaryOperator::Multiplication => {
            Some(ConstVal::Number(left.to_js_number() * right.to_js_number()))
        }
        BinaryOperator::Division => {
            Some(ConstVal::Number(left.to_js_number() / right.to_js_number()))
        }
        BinaryOperator::Remainder => {
            Some(ConstVal::Number(left.to_js_number() % right.to_js_number()))
        }
        BinaryOperator::Exponential => Some(ConstVal::Number(
            left.to_js_number().powf(right.to_js_number()),
        )),
        BinaryOperator::StrictEquality => Some(ConstVal::Bool(strict_eq(&left, &right))),
        BinaryOperator::StrictInequality => Some(ConstVal::Bool(!strict_eq(&left, &right))),
        BinaryOperator::Equality => Some(ConstVal::Bool(abstract_eq(&left, &right))),
        BinaryOperator::Inequality => Some(ConstVal::Bool(!abstract_eq(&left, &right))),
        BinaryOperator::LessThan => Some(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().lt(b.encode_utf16()),
            _ => left.to_js_number() < right.to_js_number(),
        })),
        BinaryOperator::LessEqualThan => Some(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().le(b.encode_utf16()),
            _ => left.to_js_number() <= right.to_js_number(),
        })),
        BinaryOperator::GreaterThan => Some(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().gt(b.encode_utf16()),
            _ => left.to_js_number() > right.to_js_number(),
        })),
        BinaryOperator::GreaterEqualThan => Some(ConstVal::Bool(match (&left, &right) {
            (ConstVal::String(a), ConstVal::String(b)) => a.encode_utf16().ge(b.encode_utf16()),
            _ => left.to_js_number() >= right.to_js_number(),
        })),
        BinaryOperator::BitwiseOR => {
            let a = left.to_js_number() as i64 as i32;
            let b = right.to_js_number() as i64 as i32;
            Some(ConstVal::Number((a | b) as f64))
        }
        BinaryOperator::BitwiseAnd => {
            let a = left.to_js_number() as i64 as i32;
            let b = right.to_js_number() as i64 as i32;
            Some(ConstVal::Number((a & b) as f64))
        }
        BinaryOperator::BitwiseXOR => {
            let a = left.to_js_number() as i64 as i32;
            let b = right.to_js_number() as i64 as i32;
            Some(ConstVal::Number((a ^ b) as f64))
        }
        BinaryOperator::ShiftLeft => {
            let a = left.to_js_number() as i64 as i32;
            let b = (right.to_js_number() as i64 as u32) & 0x1f;
            Some(ConstVal::Number((a << b) as f64))
        }
        BinaryOperator::ShiftRight => {
            let a = left.to_js_number() as i64 as i32;
            let b = (right.to_js_number() as i64 as u32) & 0x1f;
            Some(ConstVal::Number((a >> b) as f64))
        }
        BinaryOperator::ShiftRightZeroFill => {
            let a = left.to_js_number() as i64 as u32;
            let b = (right.to_js_number() as i64 as u32) & 0x1f;
            Some(ConstVal::Number((a >> b) as f64))
        }
        BinaryOperator::In | BinaryOperator::Instanceof => None,
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
        assert!(is_constant("void 0"));
        assert!(is_constant("pug_interp"));
    }
}
