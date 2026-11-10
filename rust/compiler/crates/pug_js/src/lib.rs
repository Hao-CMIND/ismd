pub mod constant;
pub mod expression;
pub mod locals;
pub mod scan;
pub mod scope;

pub use constant::{
    ConstVal, escape_js_stringify_chars, eval_constant, is_constant, js_stringify_str,
    js_stringify_val, pug_attr, pug_classes, pug_escape, pug_style,
};
pub use expression::{ExpressionError, ExpressionOptions, is_expression, validate_expression};
pub use locals::{add_with, add_with_checked};
pub use scope::{ScopeAnalysis, ScopeError, analyze_scope, find_free_variables, is_valid_js_identifier};
