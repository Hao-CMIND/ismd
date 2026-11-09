use pug_ast::{LineCol, SourceIndex, Token, TokenLoc};
use pug_error::{ErrorOptions, PugError};
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct LexerOptions {
    pub filename: Option<String>,
}

/// Minimal Walking-Skeleton Lexer for Step 1 (expanded to full `pug-lexer@4.1.0` in Step 2).
/// Supports tags, classes/ids, inline text, piped text, buffered/unbuffered code (`=`, `!=`, `-`),
/// filters (`:name`), comments (`//`, `//-`), and indentation (`indent`, `outdent`, `newline`, `eos`).
pub fn lex(input: &str, options: &LexerOptions) -> Result<Vec<Token>, PugError> {
    let normalized = SourceIndex::normalize_pug_input(input);
    let mut tokens: Vec<Token> = Vec::new();
    let mut indent_stack: Vec<usize> = vec![0];
    let filename = options.filename.clone();

    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut idx = 0;

    while idx < lines.len() {
        let raw_line = lines[idx];
        let line_num = idx + 1;

        if raw_line.trim().is_empty() {
            idx += 1;
            continue;
        }

        let indent_bytes = raw_line.len() - raw_line.trim_start_matches([' ', '\t']).len();
        let indent_col = indent_bytes + 1;
        let trimmed = &raw_line[indent_bytes..];

        let current_indent = *indent_stack.last().unwrap_or(&0);
        if indent_bytes > current_indent {
            indent_stack.push(indent_bytes);
            let mut tok = Token::new(
                "indent",
                TokenLoc {
                    start: LineCol::new(line_num, 1),
                    end: LineCol::new(line_num, indent_col),
                    filename: filename.clone(),
                },
            );
            tok.val = Some(Value::Number(serde_json::Number::from(indent_bytes)));
            tokens.push(tok);
        } else {
            while indent_bytes < *indent_stack.last().unwrap_or(&0) {
                indent_stack.pop();
                tokens.push(Token::new(
                    "outdent",
                    TokenLoc {
                        start: LineCol::new(line_num, 1),
                        end: LineCol::new(line_num, indent_col),
                        filename: filename.clone(),
                    },
                ));
            }
            if idx > 0 && !tokens.is_empty() {
                tokens.push(Token::new(
                    "newline",
                    TokenLoc {
                        start: LineCol::new(line_num, 1),
                        end: LineCol::new(line_num, indent_col),
                        filename: filename.clone(),
                    },
                ));
            }
        }

        // Filter `:name` with indented text body
        if let Some(rest) = trimmed.strip_prefix(':') {
            let filter_name = rest.trim();
            if filter_name.is_empty() {
                return Err(PugError::new(
                    "INVALID_FILTER_NAME",
                    "Missing filter name",
                    ErrorOptions {
                        line: line_num as i64,
                        column: Some(indent_col as i64),
                        filename: filename.clone(),
                        src: Some(normalized.clone()),
                    },
                ));
            }
            tokens.push(
                Token::new(
                    "filter",
                    TokenLoc {
                        start: LineCol::new(line_num, indent_col),
                        end: LineCol::new(line_num, indent_col + 1 + filter_name.len()),
                        filename: filename.clone(),
                    },
                )
                .with_str_val(filter_name),
            );

            // Collect indented pipeless text lines belonging to this filter
            let mut body_lines: Vec<(usize, usize, &str)> = Vec::new();
            let mut next_idx = idx + 1;
            let mut min_child_indent: Option<usize> = None;
            while next_idx < lines.len() {
                let child_raw = lines[next_idx];
                if child_raw.trim().is_empty() {
                    body_lines.push((next_idx + 1, indent_bytes, ""));
                    next_idx += 1;
                    continue;
                }
                let child_indent =
                    child_raw.len() - child_raw.trim_start_matches([' ', '\t']).len();
                if child_indent <= indent_bytes {
                    break;
                }
                min_child_indent = Some(match min_child_indent {
                    Some(m) => m.min(child_indent),
                    None => child_indent,
                });
                body_lines.push((next_idx + 1, child_indent, child_raw));
                next_idx += 1;
            }
            if let Some(base_indent) = min_child_indent {
                tokens.push(Token::new(
                    "start-pipeless-text",
                    TokenLoc {
                        start: LineCol::new(line_num + 1, 1),
                        end: LineCol::new(line_num + 1, 1),
                        filename: filename.clone(),
                    },
                ));
                for (i, (ln, _ci, raw_child)) in body_lines.iter().enumerate() {
                    let text_val = if raw_child.len() >= base_indent {
                        &raw_child[base_indent..]
                    } else {
                        ""
                    };
                    if i > 0 {
                        tokens.push(Token::new(
                            "newline",
                            TokenLoc {
                                start: LineCol::new(*ln, 1),
                                end: LineCol::new(*ln, 1),
                                filename: filename.clone(),
                            },
                        ));
                    }
                    tokens.push(
                        Token::new(
                            "text",
                            TokenLoc {
                                start: LineCol::new(*ln, base_indent + 1),
                                end: LineCol::new(*ln, base_indent + 1 + text_val.len()),
                                filename: filename.clone(),
                            },
                        )
                        .with_str_val(text_val),
                    );
                }
                tokens.push(Token::new(
                    "end-pipeless-text",
                    TokenLoc {
                        start: LineCol::new(next_idx, 1),
                        end: LineCol::new(next_idx, 1),
                        filename: filename.clone(),
                    },
                ));
            }
            idx = next_idx;
            continue;
        }

        // Comment `//-` or `//`
        if let Some(rest) = trimmed.strip_prefix("//-") {
            let mut tok = Token::new(
                "comment",
                TokenLoc {
                    start: LineCol::new(line_num, indent_col),
                    end: LineCol::new(line_num, indent_col + trimmed.len()),
                    filename: filename.clone(),
                },
            )
            .with_str_val(rest);
            tok.buffer = Some(false);
            tokens.push(tok);
            idx += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("//") {
            let mut tok = Token::new(
                "comment",
                TokenLoc {
                    start: LineCol::new(line_num, indent_col),
                    end: LineCol::new(line_num, indent_col + trimmed.len()),
                    filename: filename.clone(),
                },
            )
            .with_str_val(rest);
            tok.buffer = Some(true);
            tokens.push(tok);
            idx += 1;
            continue;
        }

        // Piped text `| ...`
        if let Some(rest) = trimmed.strip_prefix('|') {
            let text_val = rest.strip_prefix(' ').unwrap_or(rest);
            tokens.push(
                Token::new(
                    "text",
                    TokenLoc {
                        start: LineCol::new(line_num, indent_col),
                        end: LineCol::new(line_num, indent_col + trimmed.len()),
                        filename: filename.clone(),
                    },
                )
                .with_str_val(text_val),
            );
            idx += 1;
            continue;
        }

        // Standalone code `!=`, `=`, `-`
        if let Some((buffer, must_escape, expr_str)) = parse_code_prefix(trimmed) {
            let mut tok = Token::new(
                "code",
                TokenLoc {
                    start: LineCol::new(line_num, indent_col),
                    end: LineCol::new(line_num, indent_col + trimmed.len()),
                    filename: filename.clone(),
                },
            )
            .with_str_val(expr_str);
            tok.buffer = Some(buffer);
            tok.must_escape = Some(must_escape);
            tokens.push(tok);
            idx += 1;
            continue;
        }

        // Tag (e.g., `p Hello`, `p= fn()`, `div.foo bar`, `.foo bar`)
        lex_tag_line(
            trimmed,
            line_num,
            indent_col,
            &filename,
            &normalized,
            &mut tokens,
        )?;
        idx += 1;
    }

    while indent_stack.len() > 1 {
        indent_stack.pop();
        let last_line = lines.len().max(1);
        tokens.push(Token::new(
            "outdent",
            TokenLoc {
                start: LineCol::new(last_line, 1),
                end: LineCol::new(last_line, 1),
                filename: filename.clone(),
            },
        ));
    }

    let last_line = lines.len().max(1);
    let last_col = lines.last().map(|l| l.chars().map(char::len_utf16).sum::<usize>() + 1).unwrap_or(1);
    tokens.push(Token::new(
        "eos",
        TokenLoc {
            start: LineCol::new(last_line, last_col),
            end: LineCol::new(last_line, last_col),
            filename,
        },
    ));

    Ok(tokens)
}

fn parse_code_prefix(s: &str) -> Option<(bool, bool, &str)> {
    if let Some(rest) = s.strip_prefix("!=") {
        Some((true, false, rest.trim()))
    } else if let Some(rest) = s.strip_prefix('=') {
        Some((true, true, rest.trim()))
    } else if let Some(rest) = s.strip_prefix('-') {
        Some((false, false, rest.trim()))
    } else {
        None
    }
}

fn is_tag_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':'
}

fn lex_tag_line(
    trimmed: &str,
    line_num: usize,
    start_col: usize,
    filename: &Option<String>,
    full_src: &str,
    tokens: &mut Vec<Token>,
) -> Result<(), PugError> {
    let mut rest = trimmed;
    let mut col = start_col;

    // Optional explicit tag name
    let tag_len: usize = rest.chars().take_while(|&c| is_tag_char(c)).map(char::len_utf8).sum();
    if tag_len > 0 {
        let tag_name = &rest[..tag_len];
        let utf16_len: usize = tag_name.chars().map(char::len_utf16).sum();
        tokens.push(
            Token::new(
                "tag",
                TokenLoc {
                    start: LineCol::new(line_num, col),
                    end: LineCol::new(line_num, col + utf16_len),
                    filename: filename.clone(),
                },
            )
            .with_str_val(tag_name),
        );
        rest = &rest[tag_len..];
        col += utf16_len;
    } else if !rest.starts_with('.') && !rest.starts_with('#') {
        return Err(PugError::new(
            "UNEXPECTED_TEXT",
            format!("unexpected text \"{}\"", &rest[..rest.chars().next().map_or(0, char::len_utf8)]),
            ErrorOptions {
                line: line_num as i64,
                column: Some(col as i64),
                filename: filename.clone(),
                src: Some(full_src.to_string()),
            },
        ));
    }

    // Optional `.class` and `#id` shorthands
    while rest.starts_with('.') || rest.starts_with('#') {
        let is_class = rest.starts_with('.');
        let after_sigil = &rest[1..];
        let ident_len: usize = after_sigil
            .chars()
            .take_while(|&c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            .map(char::len_utf8)
            .sum();
        if ident_len == 0 {
            break;
        }
        let ident = &after_sigil[..ident_len];
        let utf16_len = 1 + ident.chars().map(char::len_utf16).sum::<usize>();
        tokens.push(
            Token::new(
                if is_class { "class" } else { "id" },
                TokenLoc {
                    start: LineCol::new(line_num, col),
                    end: LineCol::new(line_num, col + utf16_len),
                    filename: filename.clone(),
                },
            )
            .with_str_val(ident),
        );
        rest = &after_sigil[ident_len..];
        col += utf16_len;
    }

    if rest.is_empty() {
        return Ok(());
    }

    // Inline buffered/unbuffered code on tag (`p= fn()`, `p!= fn()`)
    if let Some((buffer, must_escape, expr_str)) = parse_code_prefix(rest) {
        let utf16_len: usize = rest.chars().map(char::len_utf16).sum();
        let mut tok = Token::new(
            "code",
            TokenLoc {
                start: LineCol::new(line_num, col),
                end: LineCol::new(line_num, col + utf16_len),
                filename: filename.clone(),
            },
        )
        .with_str_val(expr_str);
        tok.buffer = Some(buffer);
        tok.must_escape = Some(must_escape);
        tokens.push(tok);
        return Ok(());
    }

    // Inline text after space (`p Hello`)
    if let Some(text_rest) = rest.strip_prefix(' ') {
        let utf16_len: usize = text_rest.chars().map(char::len_utf16).sum();
        tokens.push(
            Token::new(
                "text",
                TokenLoc {
                    start: LineCol::new(line_num, col + 1),
                    end: LineCol::new(line_num, col + 1 + utf16_len),
                    filename: filename.clone(),
                },
            )
            .with_str_val(text_rest),
        );
        return Ok(());
    }

    Err(PugError::new(
        "UNEXPECTED_TEXT",
        format!("unexpected text \"{rest}\""),
        ErrorOptions {
            line: line_num as i64,
            column: Some(col as i64),
            filename: filename.clone(),
            src: Some(full_src.to_string()),
        },
    ))
}
