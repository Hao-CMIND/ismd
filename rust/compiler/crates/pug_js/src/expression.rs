use crate::scan::{NestingOptions, TokenType, default_state, parse_char_u16};
use oxc::allocator::Allocator;
use oxc::parser::Parser;
use oxc::span::{GetSpan, SourceType};
use pug_ast::SourceIndex;

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

fn check_disallowed_line_comment(src: &str) -> Result<(), ExpressionError> {
    let units: Vec<u16> = src.encode_utf16().collect();
    let mut state = default_state();
    let mut line = 1usize;
    let mut col = 0usize; // 0-based UTF-16 column
    for &u in &units {
        let _ = parse_char_u16(u, &mut state);
        if state.current() == Some(TokenType::LineComment) {
            // Line comment started at previous `/` (`col - 1`)
            return Err(ExpressionError {
                message: String::from("Line comments not allowed in an expression"),
                line,
                column: col.saturating_sub(1),
            });
        }
        if u == b'\n' as u16 {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    Ok(())
}

/// Checks if `src[end_byte..]` contains only JS whitespace or block/line comments.
fn has_trailing_tokens(src: &str, end_byte: usize, allow_line_comment: bool) -> Option<usize> {
    let rest = &src[end_byte..];
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'*' {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                if i + 1 < bytes.len() {
                    i += 2;
                    continue;
                } else {
                    return Some(end_byte + i);
                }
            } else if allow_line_comment && bytes[i + 1] == b'/' {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
        }
        // Check non-ASCII JS whitespace
        if let Some(ch) = rest[i..].chars().next() {
            if ch.is_whitespace() {
                i += ch.len_utf8();
                continue;
            }
        }
        return Some(end_byte + i);
    }
    None
}

fn check_unterminated_string_or_template(src: &str) -> Option<ExpressionError> {
    let units: Vec<u16> = src.encode_utf16().collect();
    let mut state = default_state();
    let mut quote_start: Option<(TokenType, usize, usize)> = None;
    let mut line = 1usize;
    let mut col = 0usize;

    for &u in &units {
        let prev_top = state.current();
        let prev_is_str = state.is_string();
        if (prev_top == Some(TokenType::SingleQuote) || prev_top == Some(TokenType::DoubleQuote))
            && u == b'\n' as u16
            && !state.escaped
        {
            if let Some((_, sl, sc)) = quote_start {
                return Some(ExpressionError {
                    message: String::from("Unterminated string constant"),
                    line: sl,
                    column: sc,
                });
            }
        }
        let _ = parse_char_u16(u, &mut state);
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
    }

    if let Some((qt, sl, sc)) = quote_start {
        let message = match qt {
            TokenType::SingleQuote | TokenType::DoubleQuote => {
                String::from("Unterminated string constant")
            }
            TokenType::TemplateQuote => String::from("Unterminated template"),
            _ => String::from("Unexpected token"),
        };
        return Some(ExpressionError {
            message,
            line: sl,
            column: sc,
        });
    }
    None
}

/// Validates that `src` is a single valid JavaScript expression, matching `is-expression@^4.0.0`.
pub fn validate_expression(
    src: &str,
    options: ExpressionOptions,
) -> Result<(), ExpressionError> {
    if !options.line_comment {
        check_disallowed_line_comment(src)?;
    }

    if let Some(unterm_err) = check_unterminated_string_or_template(src) {
        return Err(unterm_err);
    }

    // Check balanced brackets first with character-parser
    if let Err(scan_err) = crate::scan::parse(src, NestingOptions::default()) {
        let idx_u16 = scan_err.index.unwrap_or(0);
        let (line, col) = utf16_offset_to_acorn_loc(src, idx_u16);
        return Err(ExpressionError {
            message: String::from("Unexpected token"),
            line,
            column: col,
        });
    }

    let allocator = Allocator::default();
    let source_type = if options.strict {
        SourceType::mjs()
    } else {
        SourceType::cjs()
    };

    let parser = Parser::new(&allocator, src, source_type);
    match parser.parse_expression() {
        Ok(expr) => {
            let end_byte = expr.span().end as usize;
            if let Some(trailing_byte) = has_trailing_tokens(src, end_byte, options.line_comment) {
                let sidx = SourceIndex::new(src);
                let lc = sidx.line_col(src, trailing_byte);
                return Err(ExpressionError {
                    message: String::from("Unexpected token"),
                    line: lc.line,
                    column: lc.column.saturating_sub(1),
                });
            }
            // Also verify via `parse()` when `strict` is false or when expression has assignment target issues
            let full_wrap = if options.strict {
                format!("\"use strict\";(\n{src}\n)")
            } else {
                format!("(\n{src}\n)")
            };
            let wrap_alloc = Allocator::default();
            let wrap_ret = Parser::new(&wrap_alloc, &full_wrap, SourceType::cjs()).parse();
            if let Some(first_err) = wrap_ret.diagnostics.first() {
                let sidx = SourceIndex::new(src);
                let byte_off = first_err
                    .labels
                    .as_ref()
                    .first()
                    .map(|s| (s.offset() as usize).saturating_sub(if options.strict { 15 } else { 2 }))
                    .unwrap_or(src.len());
                let lc = sidx.line_col(src, byte_off.min(src.len()));
                return Err(ExpressionError {
                    message: normalize_oxc_error_message(&first_err.message),
                    line: lc.line,
                    column: lc.column.saturating_sub(1),
                });
            }
            Ok(())
        }
        Err(errors) => {
            let sidx = SourceIndex::new(src);
            let first = errors.first();
            let byte_off = first
                .and_then(|e| e.labels.as_ref().first())
                .map(|s| s.offset() as usize)
                .unwrap_or(src.len());
            let lc = sidx.line_col(src, byte_off.min(src.len()));
            let raw_msg = first.map(|e| e.message.as_ref()).unwrap_or("Unexpected token");
            Err(ExpressionError {
                message: normalize_oxc_error_message(raw_msg),
                line: lc.line,
                column: lc.column.saturating_sub(1),
            })
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

fn utf16_offset_to_acorn_loc(src: &str, target_u16: usize) -> (usize, usize) {
    let mut line = 1usize;
    let mut col = 0usize;
    let mut count = 0usize;
    for u in src.encode_utf16() {
        if count >= target_u16 {
            break;
        }
        if u == b'\n' as u16 {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
        count += 1;
    }
    (line, col)
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
