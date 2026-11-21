use crate::span::TokenLoc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Represents a Ismd lexer token matching `ismd-lexer` JSON structure.
/// Note that `val` and `must_escape` / `buffer` / `mode` / `name` / `args` / `key` / `code`
/// are omitted when `None` to preserve the distinction between missing properties and `null`/`false`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Token {
    #[serde(rename = "type")]
    pub token_type: String,
    pub loc: TokenLoc,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub val: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "mustEscape", skip_serializing_if = "Option::is_none")]
    pub must_escape: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(rename = "selfClosing", skip_serializing_if = "Option::is_none")]
    pub self_closing: Option<bool>,
}

impl Token {
    pub fn new(token_type: impl Into<String>, loc: TokenLoc) -> Self {
        Self {
            token_type: token_type.into(),
            loc,
            val: None,
            name: None,
            must_escape: None,
            buffer: None,
            mode: None,
            args: None,
            key: None,
            code: None,
            value: None,
            self_closing: None,
        }
    }

    pub fn with_str_val(mut self, val: impl Into<String>) -> Self {
        self.val = Some(Value::String(val.into()));
        self
    }
}
