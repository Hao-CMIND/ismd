use ismd_ast::Token;
use ismd_error::{ErrorOptions, IsmdError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StripCommentsOptions {
    pub strip_unbuffered: bool,
    pub strip_buffered: bool,
    pub filename: Option<String>,
}

impl StripCommentsOptions {
    pub fn new(strip_unbuffered: bool, strip_buffered: bool, filename: Option<String>) -> Self {
        Self {
            strip_unbuffered,
            strip_buffered,
            filename,
        }
    }
}

#[derive(Default)]
struct StripState {
    in_comment: bool,
    in_pipeless_text: bool,
}

impl StripState {
    fn keep_token(
        &mut self,
        tok_type: &str,
        tok_buffer: bool,
        tok_line: i64,
        options: &StripCommentsOptions,
    ) -> Result<bool, IsmdError> {
        match tok_type {
            "comment" => {
                if self.in_comment {
                    return Err(IsmdError::new(
                        "UNEXPECTED_TOKEN",
                        "`comment` encountered when already in a comment",
                        ErrorOptions {
                            line: tok_line,
                            column: None,
                            filename: options.filename.clone(),
                            src: None,
                        },
                    ));
                }
                self.in_comment = if tok_buffer {
                    options.strip_buffered
                } else {
                    options.strip_unbuffered
                };
                Ok(!self.in_comment)
            }
            "start-pipeless-text" => {
                if !self.in_comment {
                    return Ok(true);
                }
                if self.in_pipeless_text {
                    return Err(IsmdError::new(
                        "UNEXPECTED_TOKEN",
                        "`start-pipeless-text` encountered when already in pipeless text mode",
                        ErrorOptions {
                            line: tok_line,
                            column: None,
                            filename: options.filename.clone(),
                            src: None,
                        },
                    ));
                }
                self.in_pipeless_text = true;
                Ok(false)
            }
            "end-pipeless-text" => {
                if !self.in_comment {
                    return Ok(true);
                }
                if !self.in_pipeless_text {
                    return Err(IsmdError::new(
                        "UNEXPECTED_TOKEN",
                        "`end-pipeless-text` encountered when not in pipeless text mode",
                        ErrorOptions {
                            line: tok_line,
                            column: None,
                            filename: options.filename.clone(),
                            src: None,
                        },
                    ));
                }
                self.in_pipeless_text = false;
                self.in_comment = false;
                Ok(false)
            }
            "text" => Ok(!self.in_comment),
            _ => {
                if self.in_pipeless_text {
                    Ok(false)
                } else {
                    self.in_comment = false;
                    Ok(true)
                }
            }
        }
    }
}

/// Strips comment tokens and their associated pipeless text blocks from a `Vec<Token>`,
/// matching `ismd-strip-comments@1.0.4`.
pub fn strip_comments(
    mut tokens: Vec<Token>,
    options: StripCommentsOptions,
) -> Result<Vec<Token>, IsmdError> {
    let mut state = StripState::default();
    let mut write_idx = 0;
    for read_idx in 0..tokens.len() {
        let keep = {
            let tok = &tokens[read_idx];
            let tok_buffer = tok.buffer.unwrap_or(false);
            let tok_line = tok.loc.start.line as i64;
            state.keep_token(&tok.token_type, tok_buffer, tok_line, &options)?
        };
        if keep {
            if write_idx != read_idx {
                tokens.swap(write_idx, read_idx);
            }
            write_idx += 1;
        }
    }
    tokens.truncate(write_idx);
    Ok(tokens)
}

/// Strips comment tokens from arbitrary JSON token objects (used by standalone `ismd-strip-comments`
/// tests where legacy `.input.json` fixtures use top-level `line` instead of `loc`).
pub fn strip_comments_json(
    tokens: Vec<Value>,
    options: StripCommentsOptions,
) -> Result<Vec<Value>, IsmdError> {
    let mut state = StripState::default();
    let mut out = Vec::with_capacity(tokens.len());
    for tok in tokens {
        let tok_type = tok
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tok_buffer = tok
            .get("buffer")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tok_line = tok
            .get("line")
            .and_then(Value::as_i64)
            .or_else(|| {
                tok.get("loc")
                    .and_then(|l| l.get("start"))
                    .and_then(|s| s.get("line"))
                    .and_then(Value::as_i64)
            })
            .unwrap_or(0);
        if state.keep_token(tok_type, tok_buffer, tok_line, &options)? {
            out.push(tok);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_strip_unbuffered_default_and_buffered() {
        let input = vec![
            json!({ "type": "comment", "line": 1, "buffer": true, "val": " buffered" }),
            json!({ "type": "newline", "line": 2 }),
            json!({ "type": "comment", "line": 2, "buffer": false, "val": " unbuffered" }),
            json!({ "type": "start-pipeless-text", "line": 2 }),
            json!({ "type": "text", "line": 3, "val": "inside comment" }),
            json!({ "type": "newline", "line": 4 }),
            json!({ "type": "text", "line": 4, "val": "more comment" }),
            json!({ "type": "end-pipeless-text", "line": 4 }),
            json!({ "type": "eos", "line": 4 }),
        ];

        // Default: strip unbuffered (true), keep buffered (false missing -> keep)
        let def_opts = StripCommentsOptions::new(true, false, None);
        let res_def = strip_comments_json(input.clone(), def_opts).unwrap();
        assert_eq!(res_def.len(), 3);
        assert_eq!(res_def[0]["type"], "comment");
        assert_eq!(res_def[1]["type"], "newline");
        assert_eq!(res_def[2]["type"], "eos");

        // Strip both
        let both_opts = StripCommentsOptions::new(true, true, None);
        let res_both = strip_comments_json(input, both_opts).unwrap();
        assert_eq!(res_both.len(), 2);
        assert_eq!(res_both[0]["type"], "newline");
        assert_eq!(res_both[1]["type"], "eos");
    }

    #[test]
    fn test_unexpected_token_errors() {
        let err_comment = strip_comments_json(
            vec![
                json!({ "type": "comment", "line": 1, "buffer": false }),
                json!({ "type": "comment", "line": 2, "buffer": false }),
            ],
            StripCommentsOptions::new(true, false, None),
        )
        .unwrap_err();
        assert_eq!(err_comment.code, "ISMD:UNEXPECTED_TOKEN");
        assert_eq!(
            err_comment.msg,
            "`comment` encountered when already in a comment"
        );
        assert_eq!(err_comment.line, 2);
    }
}
