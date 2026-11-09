use pug_ast::Token;
use pug_error::PugError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct StripCommentsOptions {
    pub strip_unbuffered: bool,
    pub strip_buffered: bool,
}

impl Default for StripCommentsOptions {
    fn default() -> Self {
        Self {
            strip_unbuffered: true,
            strip_buffered: false,
        }
    }
}

pub fn strip_comments(
    tokens: Vec<Token>,
    options: StripCommentsOptions,
) -> Result<Vec<Token>, PugError> {
    let mut out = Vec::with_capacity(tokens.len());
    for tok in tokens {
        if tok.token_type == "comment" {
            let is_buffered = tok.buffer.unwrap_or(false);
            if (is_buffered && options.strip_buffered)
                || (!is_buffered && options.strip_unbuffered)
            {
                continue;
            }
        }
        out.push(tok);
    }
    Ok(out)
}
