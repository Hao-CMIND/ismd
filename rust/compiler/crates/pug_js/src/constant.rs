use serde_json::Value;

/// Compile-time constant evaluator skeleton (corresponds to `constantinople`, completed in Step 4/5).
pub fn eval_constant(expr: &str) -> Option<Value> {
    serde_json::from_str(expr.trim()).ok()
}
