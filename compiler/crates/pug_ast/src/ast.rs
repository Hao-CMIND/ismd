use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attribute {
    pub name: String,
    pub val: Value,
    #[serde(rename = "mustEscape", alias = "escaped", default)]
    pub must_escape: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttributeBlock {
    pub node_type: String,
    pub val: String,
    pub line: usize,
    pub column: Option<usize>,
    pub filename: Option<String>,
}

impl Serialize for AttributeBlock {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        if self.node_type.is_empty() {
            return serializer.serialize_str(&self.val);
        }
        let mut count = 3;
        if self.column.is_some() {
            count += 1;
        }
        if self.filename.is_some() {
            count += 1;
        }
        let mut map = serializer.serialize_map(Some(count))?;
        map.serialize_entry("type", &self.node_type)?;
        map.serialize_entry("val", &self.val)?;
        map.serialize_entry("line", &self.line)?;
        if let Some(col) = self.column {
            map.serialize_entry("column", &col)?;
        }
        if let Some(ref f) = self.filename {
            map.serialize_entry("filename", f)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for AttributeBlock {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct FullAttrBlock {
            #[serde(rename = "type")]
            node_type: String,
            val: String,
            line: usize,
            column: Option<usize>,
            filename: Option<String>,
        }

        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(s) => Ok(AttributeBlock {
                node_type: String::new(),
                val: s,
                line: 0,
                column: None,
                filename: None,
            }),
            other => {
                let full: FullAttrBlock =
                    serde_json::from_value(other).map_err(serde::de::Error::custom)?;
                Ok(AttributeBlock {
                    node_type: full.node_type,
                    val: full.val,
                    line: full.line,
                    column: full.column,
                    filename: full.filename,
                })
            }
        }
    }
}

fn default_block_type() -> String {
    String::from("Block")
}

mod typed_named_block {
    use super::*;
    use serde::{Deserializer, Serializer};

    #[derive(Serialize)]
    #[serde(tag = "type")]
    enum TypedRef<'a> {
        NamedBlock(&'a NamedBlockNode),
    }

    pub fn serialize_map<S: Serializer>(
        val: &Option<BTreeMap<String, Vec<NamedBlockNode>>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let Some(map) = val else {
            return serializer.serialize_none();
        };
        let typed: BTreeMap<&String, Vec<TypedRef<'_>>> = map
            .iter()
            .map(|(k, list)| (k, list.iter().map(TypedRef::NamedBlock).collect()))
            .collect();
        typed.serialize(serializer)
    }

    pub fn deserialize_map<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<BTreeMap<String, Vec<NamedBlockNode>>>, D::Error> {
        Option::<BTreeMap<String, Vec<NamedBlockNode>>>::deserialize(deserializer)
    }

    pub fn serialize_vec<S: Serializer>(
        val: &Option<Vec<NamedBlockNode>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let Some(list) = val else {
            return serializer.serialize_none();
        };
        let typed: Vec<TypedRef<'_>> = list.iter().map(TypedRef::NamedBlock).collect();
        typed.serialize(serializer)
    }

    pub fn deserialize_vec<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Vec<NamedBlockNode>>, D::Error> {
        Option::<Vec<NamedBlockNode>>::deserialize(deserializer)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockNode {
    #[serde(rename = "type", default = "default_block_type")]
    pub node_type: String,
    pub nodes: Vec<Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(
        rename = "declaredBlocks",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "typed_named_block::serialize_map",
        deserialize_with = "typed_named_block::deserialize_map"
    )]
    pub declared_blocks: Option<BTreeMap<String, Vec<NamedBlockNode>>>,
    #[serde(rename = "hasExtends", default, skip_serializing_if = "Option::is_none")]
    pub has_extends: Option<bool>,
}

impl BlockNode {
    pub fn new(line: usize, nodes: Vec<Node>, filename: Option<String>) -> Self {
        Self {
            node_type: String::from("Block"),
            nodes,
            line: Some(line),
            column: None,
            filename,
            declared_blocks: None,
            has_extends: None,
        }
    }

    pub fn synthetic(nodes: Vec<Node>) -> Self {
        Self {
            node_type: String::from("Block"),
            nodes,
            line: None,
            column: None,
            filename: None,
            declared_blocks: None,
            has_extends: None,
        }
    }

    pub fn empty(line: usize, filename: Option<String>) -> Self {
        Self::new(line, Vec::new(), filename)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedBlockNode {
    pub name: String,
    pub mode: String,
    pub nodes: Vec<Node>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "typed_named_block::serialize_vec",
        deserialize_with = "typed_named_block::deserialize_vec"
    )]
    pub parents: Option<Vec<NamedBlockNode>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore: Option<bool>,
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
pub struct InterpolatedTagNode {
    pub expr: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
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
    #[serde(rename = "mustEscape", alias = "escape", default)]
    pub must_escape: bool,
    #[serde(rename = "isInline")]
    pub is_inline: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockNode>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockCommentNode {
    pub val: String,
    pub block: BlockNode,
    pub buffer: bool,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DoctypeNode {
    pub val: Option<String>,
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

fn default_include_filter_type() -> String {
    String::from("IncludeFilter")
}

fn default_extension_type() -> String {
    String::from("Extension")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionNode {
    #[serde(rename = "type", default = "default_extension_type")]
    pub node_type: String,
    pub rule_id: String,
    pub target_name: String,
    pub raw_content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options_json: Option<String>,
    pub is_block: bool,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncludeFilterNode {
    #[serde(rename = "type", default = "default_include_filter_type")]
    pub node_type: String,
    pub name: String,
    pub attrs: Vec<Attribute>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

fn default_file_ref_type() -> String {
    String::from("FileReference")
}

/// Raw content returned by a `read` callback and stored in `FileReference.raw`.
///
/// `Bytes` keeps the original bytes and serializes exactly like `JSON.stringify(Buffer)`
/// (`{"type":"Buffer","data":[...]}`) so that the Node wrapper can revive a real `Buffer`.
/// `Text` is used when a custom `read` returns a string (the baseline stores it unchanged).
#[derive(Debug, Clone, PartialEq)]
pub enum RawContent {
    Bytes(Vec<u8>),
    Text(String),
}

impl RawContent {
    /// Equivalent to `raw.toString('utf8')` (lossy replacement for invalid sequences, like Node).
    pub fn to_utf8_string(&self) -> String {
        match self {
            RawContent::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
            RawContent::Text(s) => s.clone(),
        }
    }
}

impl Serialize for RawContent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            RawContent::Text(s) => serializer.serialize_str(s),
            RawContent::Bytes(b) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "Buffer")?;
                map.serialize_entry("data", b)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for RawContent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(s) => Ok(RawContent::Text(s)),
            Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("Buffer") => {
                let data = map
                    .get("data")
                    .and_then(Value::as_array)
                    .ok_or_else(|| serde::de::Error::custom("Buffer.data must be an array"))?;
                let mut bytes = Vec::with_capacity(data.len());
                for v in data {
                    let n = v
                        .as_u64()
                        .filter(|n| *n <= 255)
                        .ok_or_else(|| serde::de::Error::custom("Buffer.data must contain bytes"))?;
                    bytes.push(n as u8);
                }
                Ok(RawContent::Bytes(bytes))
            }
            _ => Err(serde::de::Error::custom(
                "FileReference.raw must be a string or a Buffer",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileReferenceNode {
    #[serde(rename = "type", default = "default_file_ref_type")]
    pub node_type: String,
    pub path: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(rename = "fullPath", skip_serializing_if = "Option::is_none")]
    pub full_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub str: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<RawContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ast: Option<Box<BlockNode>>,
}

impl FileReferenceNode {
    pub fn new(
        path: String,
        line: usize,
        column: Option<usize>,
        filename: Option<String>,
    ) -> Self {
        Self {
            node_type: String::from("FileReference"),
            path,
            line,
            column,
            filename,
            full_path: None,
            str: None,
            raw: None,
            ast: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtendsNode {
    pub file: FileReferenceNode,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncludeNode {
    pub file: FileReferenceNode,
    pub block: BlockNode,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawIncludeNode {
    pub file: FileReferenceNode,
    pub filters: Vec<IncludeFilterNode>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaseNode {
    pub expr: String,
    pub block: BlockNode,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WhenNode {
    pub expr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockNode>,
    pub debug: bool,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConditionalNode {
    pub test: String,
    pub consequent: BlockNode,
    /// Explicitly serializes as `null` when `None`, matching `pug-parser`'s `alternate: null`.
    pub alternate: Option<Box<Node>>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WhileNode {
    pub test: String,
    pub block: BlockNode,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EachNode {
    pub obj: String,
    pub val: String,
    /// Explicitly serializes as `null` when `None`, matching `pug-parser`'s `key: null`.
    pub key: Option<String>,
    pub block: BlockNode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternate: Option<BlockNode>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EachOfNode {
    pub obj: String,
    pub val: String,
    pub block: BlockNode,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MixinNode {
    pub name: String,
    /// Explicitly serializes as `null` when `None`, matching `pug-parser`.
    pub args: Option<String>,
    /// Explicitly serializes as `null` when `None` (e.g. bodiless mixin call), matching `pug-parser`.
    pub block: Option<BlockNode>,
    pub call: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Vec<Attribute>>,
    #[serde(rename = "attributeBlocks", skip_serializing_if = "Option::is_none")]
    pub attribute_blocks: Option<Vec<AttributeBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<Box<CodeNode>>,
    #[serde(rename = "textOnly", skip_serializing_if = "Option::is_none")]
    pub text_only: Option<bool>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MixinBlockNode {
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct YieldBlockNode {
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttrsNode {
    pub attrs: Vec<Attribute>,
    #[serde(rename = "attributeBlocks", skip_serializing_if = "Option::is_none")]
    pub attribute_blocks: Option<Vec<AttributeBlock>>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// Core Pug AST node enum serialized with `"type"` tag matching `pug-parser@5.0.1` and `pug-walk@1.1.8`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Node {
    Block(BlockNode),
    NamedBlock(NamedBlockNode),
    Tag(TagNode),
    InterpolatedTag(InterpolatedTagNode),
    Text(TextNode),
    Code(CodeNode),
    Comment(CommentNode),
    BlockComment(BlockCommentNode),
    Doctype(DoctypeNode),
    Filter(FilterNode),
    IncludeFilter(IncludeFilterNode),
    FileReference(FileReferenceNode),
    Extends(ExtendsNode),
    Include(IncludeNode),
    RawInclude(RawIncludeNode),
    Case(CaseNode),
    When(WhenNode),
    Conditional(ConditionalNode),
    While(WhileNode),
    Each(EachNode),
    EachOf(EachOfNode),
    Mixin(MixinNode),
    MixinBlock(MixinBlockNode),
    YieldBlock(YieldBlockNode),
    Attrs(AttrsNode),
    Extension(ExtensionNode),
}

impl Node {
    pub fn empty_block(line: usize, filename: Option<String>) -> BlockNode {
        BlockNode::empty(line, filename)
    }

    pub fn node_type(&self) -> &'static str {
        match self {
            Node::Block(_) => "Block",
            Node::NamedBlock(_) => "NamedBlock",
            Node::Tag(_) => "Tag",
            Node::InterpolatedTag(_) => "InterpolatedTag",
            Node::Text(_) => "Text",
            Node::Code(_) => "Code",
            Node::Comment(_) => "Comment",
            Node::BlockComment(_) => "BlockComment",
            Node::Doctype(_) => "Doctype",
            Node::Filter(_) => "Filter",
            Node::IncludeFilter(_) => "IncludeFilter",
            Node::FileReference(_) => "FileReference",
            Node::Extends(_) => "Extends",
            Node::Include(_) => "Include",
            Node::RawInclude(_) => "RawInclude",
            Node::Case(_) => "Case",
            Node::When(_) => "When",
            Node::Conditional(_) => "Conditional",
            Node::While(_) => "While",
            Node::Each(_) => "Each",
            Node::EachOf(_) => "EachOf",
            Node::Mixin(_) => "Mixin",
            Node::MixinBlock(_) => "MixinBlock",
            Node::YieldBlock(_) => "YieldBlock",
            Node::Attrs(_) => "Attrs",
            Node::Extension(_) => "Extension",
        }
    }
}
