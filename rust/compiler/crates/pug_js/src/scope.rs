use oxc::allocator::Allocator;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;

/// Built-in JavaScript globals excluded by default in `with` package (`globals` list).
const DEFAULT_GLOBALS: &[&str] = &[
    "Array",
    "Boolean",
    "Date",
    "Error",
    "EvalError",
    "Function",
    "Infinity",
    "JSON",
    "Math",
    "NaN",
    "Number",
    "Object",
    "Promise",
    "Proxy",
    "RangeError",
    "ReferenceError",
    "Reflect",
    "RegExp",
    "Set",
    "Map",
    "WeakMap",
    "WeakSet",
    "String",
    "Symbol",
    "SyntaxError",
    "TypeError",
    "URIError",
    " undefined",
    "undefined",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "eval",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "console",
    "global",
    "process",
    "require",
    "module",
    "exports",
    "Buffer",
    "window",
    "document",
    " navigator",
    "Intl",
];

/// Uses Oxc parser + `SemanticBuilder` to find free variables in `js_code`
/// that are not in `ignored_globals`. Preserves first-seen order.
pub fn find_free_variables(js_code: &str, ignored_globals: &[String]) -> Vec<String> {
    let allocator = Allocator::default();
    let wrapped = format!("(function() {{\n{js_code}\n}})");
    let ret = Parser::new(&allocator, &wrapped, SourceType::cjs()).parse();
    let semantic_ret = SemanticBuilder::new().build(&ret.program);
    let scoping = semantic_ret.semantic.scoping();

    let mut vars: Vec<String> = Vec::new();
    for (name, _ref_ids) in scoping.root_unresolved_references() {
        let name_str = name.as_str();
        if name_str.starts_with("pug_") || name_str == "pug" || name_str == "locals_for_with" {
            continue;
        }
        if DEFAULT_GLOBALS.contains(&name_str) {
            continue;
        }
        if ignored_globals.iter().any(|g| g == name_str) {
            continue;
        }
        if !vars.iter().any(|v| v == name_str) {
            vars.push(name_str.to_string());
        }
    }
    vars
}
