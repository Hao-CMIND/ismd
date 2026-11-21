use crate::scope::{ScopeError, TopLevelReturn, analyze_scope, is_valid_js_identifier};
use std::collections::BTreeSet;

/// Wraps `src` with `with@7.0.2`-compatible locals binding, returning a `ScopeError`
/// if either `src` or `obj` contains invalid JavaScript syntax.
pub fn add_with_checked(
    obj: &str,
    src: &str,
    exclude: &[String],
) -> Result<String, ScopeError> {
    let src_analysis = analyze_scope(src, "src")?;
    let is_default_locals_obj = obj == "locals || {}";

    let mut exclude_set: BTreeSet<String> = BTreeSet::new();
    exclude_set.insert(String::from("undefined"));
    exclude_set.insert(String::from("this"));
    for ex in exclude {
        exclude_set.insert(ex.clone());
    }
    if is_default_locals_obj {
        exclude_set.insert(String::from("locals"));
    } else {
        let obj_analysis = analyze_scope(obj, "obj")?;
        for g in obj_analysis.free_variables {
            exclude_set.insert(g);
        }
    }

    let vars: Vec<String> = src_analysis
        .free_variables
        .into_iter()
        .filter(|v| !exclude_set.contains(v))
        .collect();

    if vars.is_empty() {
        return Ok(src.to_string());
    }

    let vars_set: BTreeSet<&str> = vars.iter().map(String::as_str).collect();

    let mut declare_local = String::new();
    let mut local = String::from("locals_for_with");
    let mut result = String::from("result_of_with");

    if !is_default_locals_obj && is_valid_js_identifier(obj) {
        local = obj.to_string();
    } else {
        while vars_set.contains(local.as_str()) || exclude_set.contains(&local) {
            local.push('_');
        }
        declare_local = format!("var {local} = ({obj});");
    }

    while vars_set.contains(result.as_str()) || exclude_set.contains(&result) {
        result.push('_');
    }

    let mut args = Vec::with_capacity(vars.len() + 1);
    args.push(String::from("this"));
    for v in &vars {
        let v_json = serde_json::to_string(v).unwrap_or_else(|_| format!("\"{v}\""));
        args.push(format!(
            "{v_json} in {local} ?\n        {local}.{v} :\n        typeof {v} !== 'undefined' ? {v} : undefined"
        ));
    }

    let (before, body, after) = unwrap_returns(src, &src_analysis.top_level_returns, &result);
    let params = vars.join(", ");
    let args_str = args.join(", ");

    Ok(format!(
        ";\n    {declare_local}\n    {before}\n    (function ({params}) {{\n      {body}\n    }}.call({args_str}));\n    {after};"
    ))
}

/// Wraps `src` with `with@7.0.2`-compatible locals binding.
pub fn add_with(obj: &str, src: &str, exclude: &[String]) -> String {
    add_with_checked(obj, src, exclude).unwrap_or_else(|_| src.to_string())
}

fn unwrap_returns(
    src: &str,
    returns: &[TopLevelReturn],
    result_var: &str,
) -> (String, String, String) {
    if returns.is_empty() {
        return (String::new(), src.to_string(), String::new());
    }

    let mut body = String::with_capacity(src.len() + returns.len() * 16);
    let mut last_idx = 0;
    for ret in returns {
        if ret.start >= last_idx && ret.end <= src.len() {
            body.push_str(&src[last_idx..ret.start]);
            if let Some((arg_start, arg_end)) = ret.arg_span {
                let arg_src = &src[arg_start..arg_end];
                body.push_str(&format!("return {{value: ({arg_src})}};"));
            } else {
                body.push_str("return {};");
            }
            last_idx = ret.end;
        }
    }
    if last_idx < src.len() {
        body.push_str(&src[last_idx..]);
    }

    let before = format!("var {result_var} = ");
    let after = format!(";if ({result_var}) return {result_var}.value");
    (before, body, after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_with_no_free_vars() {
        let body = "ismd_html = ismd_html + \"<p>Hello</p>\";";
        assert_eq!(
            add_with("locals || {}", body, &[String::from("ismd_html")]),
            body
        );
    }

    #[test]
    fn test_add_with_free_var_fn() {
        let body = "ismd_html = ismd_html + ismd_escape(fn());";
        let wrapped = add_with(
            "locals || {}",
            body,
            &[String::from("ismd_html"), String::from("ismd_escape")],
        );
        assert!(wrapped.contains("var locals_for_with = (locals || {});"));
        assert!(wrapped.contains("(function (fn) {"));
        assert!(wrapped.contains("\"fn\" in locals_for_with"));
    }

    #[test]
    fn test_add_with_top_level_return_and_name_collision() {
        let body = "if (locals_for_with) return result_of_with + a;";
        let wrapped = add_with("locals || {}", body, &[]);
        assert!(wrapped.contains("var locals_for_with_ = (locals || {});"));
        assert!(wrapped.contains("var result_of_with_ = "));
        assert!(wrapped.contains("return {value: (result_of_with + a)};"));
        assert!(wrapped.contains(";if (result_of_with_) return result_of_with_.value;"));
    }
}
