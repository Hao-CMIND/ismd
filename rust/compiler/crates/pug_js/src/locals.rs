use crate::scope::find_free_variables;

/// Wraps `js_code` with locals binding compatible with `with@7.0.0`.
/// In Step 1 Walking Skeleton, binds free variables from `obj` (`locals || {}`)
/// via `(function(...) { ... }.call(this, ...))` so function-valued locals,
/// getters, and prototype properties work without JSON serialization.
pub fn add_with(obj: &str, js_code: &str, exclude: &[String]) -> String {
    let vars = find_free_variables(js_code, exclude);
    if vars.is_empty() {
        return js_code.to_string();
    }
    let params = vars.join(", ");
    let args = vars
        .iter()
        .map(|v| {
            format!(
                "\"{v}\" in locals_for_with ?\n        locals_for_with.{v} :\n        typeof {v} !== \"undefined\" ? {v} : undefined"
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "var locals_for_with = ({obj});\n\n(function ({params}) {{\n  {js_code}}}.call(this, {args}));"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_with_no_free_vars() {
        let body = "pug_html = pug_html + \"<p>Hello</p>\";";
        assert_eq!(add_with("locals || {}", body, &[]), body);
    }

    #[test]
    fn test_add_with_free_var_fn() {
        let body = "pug_html = pug_html + pug_escape(fn());";
        let wrapped = add_with("locals || {}", body, &[]);
        assert!(wrapped.contains("var locals_for_with = (locals || {});"));
        assert!(wrapped.contains("(function (fn) {"));
        assert!(wrapped.contains("\"fn\" in locals_for_with"));
    }
}
