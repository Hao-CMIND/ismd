use pug_ast::Attribute;
use serde_json::Value;

/// Minimal static attribute compiler for Step 1 Walking Skeleton
/// (expanded to full `pug-attrs@2.0.4` in Step 5).
pub fn compile_static_attrs(attrs: &[Attribute]) -> String {
    if attrs.is_empty() {
        return String::new();
    }
    let mut classes: Vec<String> = Vec::new();
    let mut others: Vec<(String, String)> = Vec::new();
    for attr in attrs {
        let raw_val = match &attr.val {
            Value::String(s) => s
                .strip_prefix('\'')
                .and_then(|s| s.strip_suffix('\''))
                .or_else(|| s.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
                .unwrap_or(s)
                .to_string(),
            other => other.to_string(),
        };
        if attr.name == "class" {
            classes.push(raw_val);
        } else {
            others.push((attr.name.clone(), raw_val));
        }
    }

    let mut out = String::new();
    if !classes.is_empty() {
        out.push_str(&format!(" class=\"{}\"", classes.join(" ")));
    }
    for (k, v) in others {
        out.push_str(&format!(" {k}=\"{v}\""));
    }
    out
}
