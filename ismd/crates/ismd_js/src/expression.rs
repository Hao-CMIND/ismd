use crate::constant::{ConstEvalOutcome, ConstVal, eval_expr};
use crate::scan::{TokenType, default_state, parse_char_u16};
use oxc::allocator::Allocator;
use oxc::ast::ast::{Expression, Statement};
use oxc::parser::Parser;
use oxc::span::SourceType;
use ismd_ast::SourceIndex;
use std::cell::RefCell;

#[derive(Debug, Clone, Copy, Default)]
pub struct ExpressionOptions {
    pub strict: bool,
    pub line_comment: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpressionError {
    pub message: String,
    /// 1-based line and 0-based UTF-16 column (matching Acorn's `ex.loc = { line, column }`).
    pub line: usize,
    pub column: usize,
}

/// Owned, allocator-independent result of validating and optionally constant-evaluating
/// a single JavaScript expression.
#[derive(Debug, Clone, PartialEq)]
pub struct ExpressionAnalysis {
    pub const_outcome: ConstEvalOutcome,
}

thread_local! {
    static EXPR_WRAP_SCRATCH: RefCell<String> = RefCell::new(String::with_capacity(256));
}

/// Performs the line-comment, unterminated string/template, and bracket-nesting prechecks
/// in a single streaming pass without allocating a `Vec<u16>`.
fn precheck_expression(src: &str, allow_line_comment: bool) -> Result<(), ExpressionError> {
    let mut state = default_state();
    let mut quote_start: Option<(TokenType, usize, usize)> = None;
    let mut first_unterm_newline: Option<ExpressionError> = None;
    let mut first_scan_err: Option<(usize, usize)> = None;
    let mut line = 1usize;
    let mut col = 0usize;

    let mut step = |u: u16| -> Result<(), ExpressionError> {
        let prev_top = state.current();
        let prev_is_str = state.is_string();

        if first_unterm_newline.is_none()
            && (prev_top == Some(TokenType::SingleQuote)
                || prev_top == Some(TokenType::DoubleQuote))
            && u == b'\n' as u16
            && !state.escaped
            && let Some((_, sl, sc)) = quote_start
        {
            first_unterm_newline = Some(ExpressionError {
                message: String::from("Unterminated string constant"),
                line: sl,
                column: sc,
            });
        }

        if let Err(_err) = parse_char_u16(u, &mut state)
            && first_scan_err.is_none()
        {
            first_scan_err = Some((line, col));
        }

        if !allow_line_comment && state.current() == Some(TokenType::LineComment) {
            return Err(ExpressionError {
                message: String::from("Line comments not allowed in an expression"),
                line,
                column: col.saturating_sub(1),
            });
        }

        if !prev_is_str && state.is_string() {
            quote_start = Some((state.current().unwrap(), line, col));
        } else if prev_is_str && !state.is_string() {
            quote_start = None;
        }

        if u == b'\n' as u16 {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
        Ok(())
    };

    if src.is_ascii() {
        for &b in src.as_bytes() {
            step(u16::from(b))?;
        }
    } else {
        for u in src.encode_utf16() {
            step(u)?;
        }
    }

    if let Some(err) = first_unterm_newline {
        return Err(err);
    }

    if let Some((qt, sl, sc)) = quote_start {
        let message = match qt {
            TokenType::SingleQuote | TokenType::DoubleQuote => {
                String::from("Unterminated string constant")
            }
            TokenType::TemplateQuote => String::from("Unterminated template"),
            _ => String::from("Unexpected token"),
        };
        return Err(ExpressionError {
            message,
            line: sl,
            column: sc,
        });
    }

    if let Some((err_line, err_col)) = first_scan_err {
        return Err(ExpressionError {
            message: String::from("Unexpected token"),
            line: err_line,
            column: err_col,
        });
    }

    Ok(())
}

/// Parses and validates `src` using a single Oxc `parse()` on a wrapped `(\n{src}\n)`
/// (prechecked for balanced nesting/comments/quotes) and invokes `on_expr` with the parsed
/// expression AST before the scratch allocator is reset.
pub(crate) fn with_validated_expression<R>(
    src: &str,
    options: ExpressionOptions,
    on_expr: impl FnOnce(&Expression<'_>) -> R,
) -> Result<R, ExpressionError> {
    precheck_expression(src, options.line_comment)?;

    ismd_ast::profile::with_counters(|c| {
        c.oxc_parse_count += 1;
    });
    let _prof_oxc = ismd_ast::profile::scope(ismd_ast::profile::Stage::OxcParse);

    crate::with_reusable_allocator(|allocator: &Allocator| {
        let prefix = if options.strict { "\"use strict\";(\n" } else { "(\n" };
        let prefix_len = prefix.len();

        EXPR_WRAP_SCRATCH.with(|cell| {
            let mut wrap_buf = cell.borrow_mut();
            wrap_buf.clear();
            wrap_buf.reserve(prefix_len + src.len() + 2);
            wrap_buf.push_str(prefix);
            wrap_buf.push_str(src);
            wrap_buf.push_str("\n)");

            let ret = Parser::new(allocator, &wrap_buf, SourceType::cjs()).parse();
            if let Some(first_err) = ret.diagnostics.first() {
                let sidx = SourceIndex::new(src);
                let byte_off = first_err
                    .labels
                    .as_ref()
                    .first()
                    .map(|s| (s.offset() as usize).saturating_sub(prefix_len))
                    .unwrap_or(src.len());
                let lc = sidx.line_col(src, byte_off.min(src.len()));
                return Err(ExpressionError {
                    message: normalize_oxc_error_message(&first_err.message),
                    line: lc.line,
                    column: lc.column.saturating_sub(1),
                });
            }

            if ret.program.body.len() == 1
                && let Statement::ExpressionStatement(stmt) = &ret.program.body[0]
                && let Expression::ParenthesizedExpression(paren) = &stmt.expression
            {
                return Ok(on_expr(&paren.expression));
            }

            let sidx = SourceIndex::new(src);
            let lc = sidx.line_col(src, src.len());
            Err(ExpressionError {
                message: String::from("Unexpected token"),
                line: lc.line,
                column: lc.column.saturating_sub(1),
            })
        })
    })
}

/// Validates that `src` is a single valid JavaScript expression, matching `is-expression@^4.0.0`.
pub fn validate_expression(
    src: &str,
    options: ExpressionOptions,
) -> Result<(), ExpressionError> {
    with_validated_expression(src, options, |_| ())
}

/// Validates `src` and computes its constant evaluation outcome in a single Oxc parse,
/// returning an owned `ExpressionAnalysis`.
pub fn analyze_expression(
    src: &str,
    options: ExpressionOptions,
    allow_ismd_constants: bool,
) -> Result<ExpressionAnalysis, ExpressionError> {
    let const_outcome = with_validated_expression(src, options, |expr| {
        let _prof_const = ismd_ast::profile::scope(ismd_ast::profile::Stage::ConstantEvaluation);
        ismd_ast::profile::with_counters(|c| {
            c.eval_constant_count += 1;
        });
        eval_expr(expr, allow_ismd_constants)
    })?;
    Ok(ExpressionAnalysis { const_outcome })
}

impl ExpressionAnalysis {
    pub fn constant_value(&self) -> Option<&ConstVal> {
        match &self.const_outcome {
            ConstEvalOutcome::Constant(v) => Some(v),
            _ => None,
        }
    }
}

fn normalize_oxc_error_message(msg: &str) -> String {
    if msg.contains("Unterminated string") {
        String::from("Unterminated string constant")
    } else {
        String::from("Unexpected token")
    }
}

/// Checks whether `src` is a valid JavaScript expression (default `is-expression` options:
/// `strict: false`, `line_comment: false`).
pub fn is_expression(src: &str) -> bool {
    validate_expression(src, ExpressionOptions::default()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_and_invalid_expressions() {
        assert!(is_expression("a + b"));
        assert!(is_expression("`hello ${name}`"));
        assert!(is_expression("/^[a-z]+$/i.test(foo)"));
        assert!(is_expression("fn(1, 2, { a: [3, 4] })"));

        // Trailing tokens or statements are not valid expressions
        assert!(!is_expression("var x = 1"));
        assert!(!is_expression("a b"));
        assert!(!is_expression("thisWillNotWork("));

        // Line comments are disallowed by default in `is-expression`
        assert!(!is_expression("a // comment"));
        assert!(
            validate_expression(
                "a // comment",
                ExpressionOptions {
                    strict: false,
                    line_comment: true,
                }
            )
            .is_ok()
        );
    }

    #[test]
    fn test_error_locations_match_acorn() {
        let err1 = validate_expression("\n    'asfd\n   asfd'", ExpressionOptions::default())
            .unwrap_err();
        assert_eq!(err1.message, "Unterminated string constant");
        assert_eq!(err1.line, 2);
        assert_eq!(err1.column, 4);

        let err2 =
            validate_expression("thisWillNotWork(", ExpressionOptions::default()).unwrap_err();
        assert_eq!(err2.message, "Unexpected token");
        assert_eq!(err2.line, 1);
        assert_eq!(err2.column, 16);
    }
}
