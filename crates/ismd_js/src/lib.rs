use oxc::allocator::Allocator;
use std::cell::RefCell;

pub mod constant;
pub mod expression;
pub mod locals;
pub mod scan;
pub mod scope;

pub use constant::{
    ConstEvalOutcome, ConstVal, escape_js_stringify_chars, eval_constant, eval_static_expression,
    is_constant, js_stringify_str, js_stringify_val, ismd_attr, ismd_classes, ismd_escape, ismd_style,
    push_js_string_inner,
};
pub use expression::{
    ExpressionAnalysis, ExpressionError, ExpressionOptions, analyze_expression, is_expression,
    validate_expression,
};
pub use locals::{add_with, add_with_checked};
pub use scope::{ScopeAnalysis, ScopeError, analyze_scope, find_free_variables, is_valid_js_identifier};

thread_local! {
    static ALLOCATOR_POOL: RefCell<Option<Allocator>> = const { RefCell::new(None) };
}

/// Runs `f` with a recycled thread-local Oxc `Allocator`, resetting it upon completion
/// without dropping its initial heap chunk. Re-entrant calls safely fall back to a
/// fresh `Allocator`.
pub(crate) fn with_reusable_allocator<R>(f: impl FnOnce(&Allocator) -> R) -> R {
    let taken = ALLOCATOR_POOL.with(|cell| cell.borrow_mut().take());
    let mut alloc = match taken {
        Some(a) => a,
        None => {
            ismd_ast::profile::with_counters(|c| {
                c.allocator_create_count += 1;
            });
            Allocator::default()
        }
    };
    let out = f(&alloc);
    alloc.reset();
    ALLOCATOR_POOL.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(alloc);
        }
    });
    out
}
