use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attribute {
    pub name: String,
    pub val: Value,
    #[serde(rename = "mustEscape")]
    pub must_escape: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttributeBlock {
    #[serde(rename = "type")]
    pub node_type: String,
    pub val: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockNode {
    pub nodes: Vec<Node>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagNode {
    pub name: String,
    #[serde(rename = "selfClosing")]
    pub self_closing: bool,
    pub block: BlockNode,
    pub attrs: Vec<Attribute>,
    #[serde(rename = "attributeBlocks")]
    pub attribute_blocks: Vec<AttributeBlock>,
    #[serde(rename = "isInline")]
    pub is_inline: bool,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<Box<CodeNode>>,
    #[serde(rename = "textOnly", skip_serializing_if = "Option::is_none")]
    pub text_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextNode {
    pub val: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(rename = "isHtml", skip_serializing_if = "Option::is_none")]
    pub is_html: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeNode {
    pub val: String,
    pub buffer: bool,
    #[serde(rename = "mustEscape")]
    pub must_escape: bool,
    #[serde(rename = "isInline")]
    pub is_inline: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockNode>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterNode {
    pub name: String,
    pub block: BlockNode,
    pub attrs: Vec<Attribute>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommentNode {
    pub val: String,
    pub buffer: bool,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// Core Pug AST node enum serialized with `"type"` tag matching `pug-parser`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Node {
    Block(BlockNode),
    Tag(TagNode),
    Text(TextNode),
    Code(CodeNode),
    Filter(FilterNode),
    Comment(CommentNode),
}

impl Node {
    pub fn empty_block(line: usize, filename: Option<String>) -> BlockNode {
        BlockNode {
            nodes: Vec::new(),
            line,
            column: None,
            filename,
        }
    }
}
