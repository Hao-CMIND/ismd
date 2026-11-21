use ismd_ast::{
    Attribute, AttributeBlock, BlockCommentNode, BlockNode, CaseNode, CodeNode, CommentNode,
    ConditionalNode, DoctypeNode, EachNode, EachOfNode, ExtensionNode, ExtendsNode, FileReferenceNode,
    IncludeNode, InterpolatedTagNode, LineCol, MixinBlockNode, MixinNode,
    NamedBlockNode, Node, RawIncludeNode, TagNode, TextNode, Token, TokenLoc, WhenNode, WhileNode,
    YieldBlockNode,
};
use ismd_error::{ErrorOptions, IsmdError};
use serde_json::Value;
use std::collections::VecDeque;

/// Inline tags matching `raw/compiler/packages/ismd-parser/lib/inline-tags.js`.
pub const INLINE_TAGS: &[&str] = &[
    "a", "abbr", "acronym", "b", "br", "code", "em", "font", "i", "img", "ins", "kbd", "map",
    "samp", "small", "span", "strong", "sub", "sup",
];

pub fn is_inline_tag(name: &str) -> bool {
    INLINE_TAGS.contains(&name)
}

#[derive(Debug, Clone, Default)]
pub struct ParserOptions {
    pub filename: Option<String>,
    pub src: Option<String>,
}

/// Parses a slice of `Token`s into a `BlockNode` AST, matching `ismd-parser@5.0.1`.
pub fn parse(tokens: &[Token], options: &ParserOptions) -> Result<BlockNode, IsmdError> {
    Ok(parse_with_warnings(tokens, options)?.0)
}

/// Parses tokens and also returns any deprecation warnings emitted during parsing.
pub fn parse_with_warnings(
    tokens: &[Token],
    options: &ParserOptions,
) -> Result<(BlockNode, Vec<String>), IsmdError> {
    parse_owned_with_warnings(tokens.to_vec(), options)
}

/// Parses an owned `Vec<Token>` into a `BlockNode` AST without cloning the token stream.
pub fn parse_owned_with_warnings(
    tokens: Vec<Token>,
    options: &ParserOptions,
) -> Result<(BlockNode, Vec<String>), IsmdError> {
    parse_owned_with_warnings_borrowed(tokens, options.filename.as_deref(), options.src.as_deref())
}

/// Parses an owned `Vec<Token>` with borrowed `filename` and `src` to avoid copying source text.
pub fn parse_owned_with_warnings_borrowed(
    tokens: Vec<Token>,
    filename: Option<&str>,
    src: Option<&str>,
) -> Result<(BlockNode, Vec<String>), IsmdError> {
    let mut parser = Parser::new_borrowed(tokens, filename.map(str::to_string), src);
    let ast = parser.parse_root()?;
    Ok((ast, parser.warnings))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExprKind {
    Tag,
    Mixin,
    Block,
    MixinBlock,
    Case,
    Extends,
    Include,
    Doctype,
    Extension,
    Comment,
    TextOrInterp,
    TextHtml,
    Dot,
    Each,
    EachOf,
    Code,
    BlockCode,
    If,
    While,
    Call,
    Interpolation,
    Yield,
    IdOrClass,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextKind {
    Text,
    InterpolatedCode,
    Newline,
    StartIsmdInterpolation,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TagAttrKind {
    IdOrClass,
    StartAttributes,
    StartAttributeBlocks,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TagTailKind {
    TextOrInterp,
    Code,
    Colon,
    Newline,
    Slash,
    Other,
}

/// Parses raw JSON token objects (including legacy `line`/`col` tokens in `ismd-parser/test/cases/*.tokens.json`)
/// into a `BlockNode` AST.
pub fn parse_json_tokens(
    raw_tokens: &[Value],
    options: &ParserOptions,
) -> Result<BlockNode, IsmdError> {
    Ok(parse_json_tokens_with_warnings(raw_tokens, options)?.0)
}

pub fn parse_json_tokens_with_warnings(
    raw_tokens: &[Value],
    options: &ParserOptions,
) -> Result<(BlockNode, Vec<String>), IsmdError> {
    let mut converted = Vec::with_capacity(raw_tokens.len());
    for raw in raw_tokens {
        converted.push(json_value_to_token(raw, &options.filename)?);
    }
    parse_with_warnings(&converted, options)
}

fn json_value_to_token(raw: &Value, default_filename: &Option<String>) -> Result<Token, IsmdError> {
    let obj = raw.as_object().ok_or_else(|| {
        IsmdError::new(
            "INVALID_TOKEN",
            "Expected token to be an object",
            ErrorOptions {
                line: 1,
                column: None,
                filename: default_filename.clone(),
                src: None,
            },
        )
    })?;

    let token_type = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let loc = if let Some(loc_val) = obj.get("loc") {
        let start_line = loc_val
            .get("start")
            .and_then(|s| s.get("line"))
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize;
        let start_col = loc_val
            .get("start")
            .and_then(|s| s.get("column"))
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize;
        let end_line = loc_val
            .get("end")
            .and_then(|s| s.get("line"))
            .and_then(Value::as_u64)
            .unwrap_or(start_line as u64) as usize;
        let end_col = loc_val
            .get("end")
            .and_then(|s| s.get("column"))
            .and_then(Value::as_u64)
            .unwrap_or(start_col as u64) as usize;
        let filename = loc_val
            .get("filename")
            .and_then(Value::as_str)
            .map(String::from);
        TokenLoc {
            start: LineCol::new(start_line, start_col),
            end: LineCol::new(end_line, end_col),
            filename,
        }
    } else {
        let line = obj.get("line").and_then(Value::as_u64).unwrap_or(1) as usize;
        let col = obj.get("col").and_then(Value::as_u64).unwrap_or(1) as usize;
        TokenLoc {
            start: LineCol::new(line, col),
            end: LineCol::new(line, col),
            filename: default_filename.clone(),
        }
    };

    // Both modern `loc.start.*` and legacy `line`/`col` token JSON formats are supported above.
    let mut tok = Token::new(token_type, loc);
    tok.val = obj.get("val").cloned();
    tok.name = obj.get("name").and_then(Value::as_str).map(String::from);
    tok.must_escape = obj.get("mustEscape").and_then(Value::as_bool);
    tok.buffer = obj.get("buffer").and_then(Value::as_bool);
    tok.mode = obj.get("mode").and_then(Value::as_str).map(String::from);
    tok.args = obj.get("args").cloned();
    tok.key = obj.get("key").cloned();
    tok.code = obj.get("code").and_then(Value::as_str).map(String::from);
    tok.value = obj.get("value").and_then(Value::as_str).map(String::from);
    tok.self_closing = obj.get("selfClosing").and_then(Value::as_bool);
    Ok(tok)
}

enum TagLike {
    Tag(TagNode),
    InterpolatedTag(InterpolatedTagNode),
    MixinCall(MixinNode),
}

impl TagLike {
    fn line(&self) -> usize {
        match self {
            TagLike::Tag(t) => t.line,
            TagLike::InterpolatedTag(t) => t.line,
            TagLike::MixinCall(m) => m.line,
        }
    }

    fn attrs_mut(&mut self) -> &mut Vec<Attribute> {
        match self {
            TagLike::Tag(t) => &mut t.attrs,
            TagLike::InterpolatedTag(t) => &mut t.attrs,
            TagLike::MixinCall(m) => m.attrs.get_or_insert_with(Vec::new),
        }
    }

    fn attribute_blocks_mut(&mut self) -> &mut Vec<AttributeBlock> {
        match self {
            TagLike::Tag(t) => &mut t.attribute_blocks,
            TagLike::InterpolatedTag(t) => &mut t.attribute_blocks,
            TagLike::MixinCall(m) => m.attribute_blocks.get_or_insert_with(Vec::new),
        }
    }

    fn set_text_only(&mut self, val: bool) {
        match self {
            TagLike::Tag(t) => t.text_only = Some(val),
            TagLike::InterpolatedTag(t) => t.text_only = Some(val),
            TagLike::MixinCall(m) => m.text_only = Some(val),
        }
    }

    fn is_text_only(&self) -> bool {
        match self {
            TagLike::Tag(t) => t.text_only.unwrap_or(false),
            TagLike::InterpolatedTag(t) => t.text_only.unwrap_or(false),
            TagLike::MixinCall(m) => m.text_only.unwrap_or(false),
        }
    }

    fn set_self_closing(&mut self, val: bool) {
        match self {
            TagLike::Tag(t) => t.self_closing = val,
            TagLike::InterpolatedTag(t) => t.self_closing = val,
            TagLike::MixinCall(_) => {}
        }
    }

    fn block_mut(&mut self, filename: &Option<String>) -> &mut BlockNode {
        match self {
            TagLike::Tag(t) => &mut t.block,
            TagLike::InterpolatedTag(t) => &mut t.block,
            TagLike::MixinCall(m) => {
                let ln = m.line;
                m.block
                    .get_or_insert_with(|| BlockNode::empty(ln, filename.clone()))
            }
        }
    }

    fn set_block(&mut self, block: BlockNode) {
        match self {
            TagLike::Tag(t) => t.block = block,
            TagLike::InterpolatedTag(t) => t.block = block,
            TagLike::MixinCall(m) => m.block = Some(block),
        }
    }
}

pub struct Parser<'a> {
    tokens: VecDeque<Token>,
    pub filename: Option<String>,
    pub src: Option<&'a str>,
    pub in_mixin: usize,
    pub warnings: Vec<String>,
}

impl<'a> Parser<'a> {
    pub fn new(tokens: Vec<Token>, options: &'a ParserOptions) -> Self {
        Self::new_borrowed(tokens, options.filename.clone(), options.src.as_deref())
    }

    pub fn new_borrowed(tokens: Vec<Token>, filename: Option<String>, src: Option<&'a str>) -> Self {
        Self {
            tokens: VecDeque::from(tokens),
            filename,
            src,
            in_mixin: 0,
            warnings: Vec::new(),
        }
    }

    fn error(&self, code: &str, message: impl Into<String>, token: &Token) -> IsmdError {
        IsmdError::new(
            code,
            message.into(),
            ErrorOptions {
                line: token.loc.start.line as i64,
                column: Some(token.loc.start.column as i64),
                filename: self.filename.clone(),
                src: self.src.map(str::to_string),
            },
        )
    }

    fn peek(&self) -> Result<&Token, IsmdError> {
        self.tokens.front().ok_or_else(|| {
            IsmdError::new(
                "INVALID_TOKEN",
                "Unexpected end of token stream",
                ErrorOptions {
                    line: 1,
                    column: Some(1),
                    filename: self.filename.clone(),
                    src: self.src.map(str::to_string),
                },
            )
        })
    }

    fn advance(&mut self) -> Result<Token, IsmdError> {
        self.tokens.pop_front().ok_or_else(|| {
            IsmdError::new(
                "INVALID_TOKEN",
                "Unexpected end of token stream",
                ErrorOptions {
                    line: 1,
                    column: Some(1),
                    filename: self.filename.clone(),
                    src: self.src.map(str::to_string),
                },
            )
        })
    }

    fn defer(&mut self, tok: Token) {
        self.tokens.push_front(tok);
    }

    fn expect(&mut self, expected_type: &str) -> Result<Token, IsmdError> {
        let peeked = self.peek()?;
        if peeked.token_type == expected_type {
            self.advance()
        } else {
            let got = peeked.token_type.clone();
            let err_tok = peeked.clone();
            Err(self.error(
                "INVALID_TOKEN",
                format!("expected \"{expected_type}\", but got \"{got}\""),
                &err_tok,
            ))
        }
    }

    fn accept(&mut self, expected_type: &str) -> Result<Option<Token>, IsmdError> {
        if self.peek()?.token_type == expected_type {
            Ok(Some(self.advance()?))
        } else {
            Ok(None)
        }
    }

    fn init_block(&self, line: usize, nodes: Vec<Node>) -> BlockNode {
        BlockNode::new(line, nodes, self.filename.clone())
    }

    fn empty_block(&self, line: usize) -> BlockNode {
        BlockNode::empty(line, self.filename.clone())
    }

    pub fn parse_root(&mut self) -> Result<BlockNode, IsmdError> {
        let mut block = self.empty_block(0);

        loop {
            let tt = self.peek()?.token_type.as_str();
            if tt == "eos" {
                break;
            } else if tt == "newline" {
                self.advance()?;
            } else if tt == "text-html" {
                let html_nodes = self.parse_text_html()?;
                block.nodes.extend(html_nodes);
            } else {
                let expr = self.parse_expr()?;
                if let Node::Block(b) = expr {
                    block.nodes.extend(b.nodes);
                } else {
                    block.nodes.push(expr);
                }
            }
        }

        Ok(block)
    }

    fn parse_expr(&mut self) -> Result<Node, IsmdError> {
        let kind = match self.peek()?.token_type.as_str() {
            "tag" => ExprKind::Tag,
            "mixin" => ExprKind::Mixin,
            "block" => ExprKind::Block,
            "mixin-block" => ExprKind::MixinBlock,
            "case" => ExprKind::Case,
            "extends" => ExprKind::Extends,
            "include" => ExprKind::Include,
            "doctype" => ExprKind::Doctype,
            "extension_start" => ExprKind::Extension,
            "comment" => ExprKind::Comment,
            "text" | "interpolated-code" | "start-ismd-interpolation" => ExprKind::TextOrInterp,
            "text-html" => ExprKind::TextHtml,
            "dot" => ExprKind::Dot,
            "each" => ExprKind::Each,
            "eachOf" => ExprKind::EachOf,
            "code" => ExprKind::Code,
            "blockcode" => ExprKind::BlockCode,
            "if" => ExprKind::If,
            "while" => ExprKind::While,
            "call" => ExprKind::Call,
            "interpolation" => ExprKind::Interpolation,
            "yield" => ExprKind::Yield,
            "id" | "class" => ExprKind::IdOrClass,
            _ => ExprKind::Other,
        };
        match kind {
            ExprKind::Tag => self.parse_tag(),
            ExprKind::Mixin => self.parse_mixin(),
            ExprKind::Block => self.parse_block(),
            ExprKind::MixinBlock => self.parse_mixin_block(),
            ExprKind::Case => self.parse_case(),
            ExprKind::Extends => self.parse_extends(),
            ExprKind::Include => self.parse_include(),
            ExprKind::Doctype => self.parse_doctype(),
            ExprKind::Extension => self.parse_extension(),
            ExprKind::Comment => self.parse_comment(),
            ExprKind::TextOrInterp => self.parse_text(true),
            ExprKind::TextHtml => {
                let line = self.peek()?.loc.start.line;
                let nodes = self.parse_text_html()?;
                Ok(Node::Block(self.init_block(line, nodes)))
            }
            ExprKind::Dot => self.parse_dot(),
            ExprKind::Each => self.parse_each(),
            ExprKind::EachOf => self.parse_each_of(),
            ExprKind::Code => Ok(Node::Code(self.parse_code(false)?)),
            ExprKind::BlockCode => self.parse_block_code(),
            ExprKind::If => self.parse_conditional(),
            ExprKind::While => self.parse_while(),
            ExprKind::Call => self.parse_call(),
            ExprKind::Interpolation => self.parse_interpolation(),
            ExprKind::Yield => self.parse_yield(),
            ExprKind::IdOrClass => {
                let loc = self.peek()?.loc.clone();
                let div_tok = Token::new("tag", loc).with_str_val("div");
                self.defer(div_tok);
                self.parse_expr()
            }
            ExprKind::Other => {
                let tok = self.peek()?.clone();
                let other = tok.token_type.as_str();
                Err(self.error("INVALID_TOKEN", format!("unexpected token \"{other}\""), &tok))
            }
        }
    }

    fn parse_dot(&mut self) -> Result<Node, IsmdError> {
        self.advance()?;
        match self.parse_text_block()? {
            Some(block) => Ok(Node::Block(block)),
            None => Ok(Node::Block(self.empty_block(0))),
        }
    }

    fn parse_text(&mut self, block_opt: bool) -> Result<Node, IsmdError> {
        let mut tags: Vec<Node> = Vec::new();
        let lineno = self.peek()?.loc.start.line;

        loop {
            let kind = match self.peek()?.token_type.as_str() {
                "text" => TextKind::Text,
                "interpolated-code" => TextKind::InterpolatedCode,
                "newline" => TextKind::Newline,
                "start-ismd-interpolation" => TextKind::StartIsmdInterpolation,
                _ => TextKind::Other,
            };
            match kind {
                TextKind::Text => {
                    let mut tok = self.advance()?;
                    tags.push(Node::Text(TextNode {
                        val: token_str_val_take(&mut tok),
                        line: Some(tok.loc.start.line),
                        column: Some(tok.loc.start.column),
                        filename: self.filename.clone(),
                        is_html: None,
                    }));
                }
                TextKind::InterpolatedCode => {
                    let mut tok = self.advance()?;
                    tags.push(Node::Code(CodeNode {
                        val: token_str_val_take(&mut tok),
                        buffer: tok.buffer.unwrap_or(false),
                        must_escape: tok.must_escape != Some(false),
                        is_inline: true,
                        debug: None,
                        block: None,
                        line: tok.loc.start.line,
                        column: Some(tok.loc.start.column),
                        filename: self.filename.clone(),
                    }));
                }
                TextKind::Newline => {
                    if !block_opt {
                        break;
                    }
                    let tok = self.advance()?;
                    let next_after = self.peek()?.token_type.as_str();
                    if next_after == "text" || next_after == "interpolated-code" {
                        tags.push(Node::Text(TextNode {
                            val: String::from("\n"),
                            line: Some(tok.loc.start.line),
                            column: Some(tok.loc.start.column),
                            filename: self.filename.clone(),
                            is_html: None,
                        }));
                    }
                }
                TextKind::StartIsmdInterpolation => {
                    self.advance()?;
                    let expr = self.parse_expr()?;
                    tags.push(expr);
                    self.expect("end-ismd-interpolation")?;
                }
                TextKind::Other => break,
            }
        }

        if tags.len() == 1 {
            Ok(tags.into_iter().next().unwrap())
        } else {
            Ok(Node::Block(self.init_block(lineno, tags)))
        }
    }

    fn parse_text_html(&mut self) -> Result<Vec<Node>, IsmdError> {
        let mut nodes: Vec<Node> = Vec::new();

        loop {
            let tt = self.peek()?.token_type.as_str();
            if tt == "text-html" {
                let mut text = self.advance()?;
                let text_val = token_str_val_take(&mut text);
                if let Some(Node::Text(last_text)) = nodes.last_mut()
                    && last_text.is_html == Some(true)
                {
                    last_text.val.push('\n');
                    last_text.val.push_str(&text_val);
                } else {
                    nodes.push(Node::Text(TextNode {
                        val: text_val,
                        filename: self.filename.clone(),
                        line: Some(text.loc.start.line),
                        column: Some(text.loc.start.column),
                        is_html: Some(true),
                    }));
                }
            } else if tt == "indent" {
                let block = self.block()?;
                for node in block.nodes {
                    if let Node::Text(ref t) = node
                        && t.is_html == Some(true)
                    {
                        if let Some(Node::Text(last_text)) = nodes.last_mut()
                            && last_text.is_html == Some(true)
                        {
                            last_text.val.push('\n');
                            last_text.val.push_str(&t.val);
                        } else {
                            nodes.push(node);
                        }
                    } else {
                        nodes.push(node);
                    }
                }
            } else if tt == "code" {
                let code_node = self.parse_code(true)?;
                nodes.push(Node::Code(code_node));
            } else if tt == "newline" {
                self.advance()?;
            } else {
                break;
            }
        }

        Ok(nodes)
    }

    fn parse_block_expansion(&mut self) -> Result<BlockNode, IsmdError> {
        if let Some(tok) = self.accept(":")? {
            let expr = self.parse_expr()?;
            match expr {
                Node::Block(b) => Ok(b),
                other => Ok(self.init_block(tok.loc.start.line, vec![other])),
            }
        } else {
            self.block()
        }
    }

    fn parse_case(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("case")?;
        let mut block = self.empty_block(tok.loc.start.line + 1);
        self.expect("indent")?;
        while self.peek()?.token_type != "outdent" {
            let next_type = self.peek()?.token_type.clone();
            match next_type.as_str() {
                "comment" | "newline" => {
                    self.advance()?;
                }
                "when" => {
                    block.nodes.push(self.parse_when()?);
                }
                "default" => {
                    block.nodes.push(self.parse_default()?);
                }
                other => {
                    let err_tok = self.peek()?.clone();
                    return Err(self.error(
                        "INVALID_TOKEN",
                        format!(
                            "Unexpected token \"{other}\", expected \"when\", \"default\" or \"newline\""
                        ),
                        &err_tok,
                    ));
                }
            }
        }
        self.expect("outdent")?;

        Ok(Node::Case(CaseNode {
            expr: token_str_val(&tok),
            block,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_when(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("when")?;
        let block = if self.peek()?.token_type != "newline" {
            Some(self.parse_block_expansion()?)
        } else {
            None
        };
        Ok(Node::When(WhenNode {
            expr: token_str_val(&tok),
            block,
            debug: false,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_default(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("default")?;
        let block = self.parse_block_expansion()?;
        Ok(Node::When(WhenNode {
            expr: String::from("default"),
            block: Some(block),
            debug: false,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_code(&mut self, no_block: bool) -> Result<CodeNode, IsmdError> {
        let tok = self.expect("code")?;
        let val = token_str_val(&tok);
        let debug = if val.trim_start_matches(' ').starts_with("else") {
            Some(false)
        } else {
            None
        };
        let mut node = CodeNode {
            val,
            buffer: tok.buffer.unwrap_or(false),
            must_escape: tok.must_escape != Some(false),
            is_inline: no_block,
            debug,
            block: None,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        };

        if no_block {
            return Ok(node);
        }

        if self.peek()?.token_type == "indent" {
            if tok.buffer.unwrap_or(false) {
                let err_tok = self.peek()?.clone();
                return Err(self.error(
                    "BLOCK_IN_BUFFERED_CODE",
                    "Buffered code cannot have a block attached to it",
                    &err_tok,
                ));
            }
            node.block = Some(self.block()?);
        }

        Ok(node)
    }

    fn parse_conditional(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("if")?;
        let mut consequent = self.empty_block(tok.loc.start.line);
        if self.peek()?.token_type == "indent" {
            consequent = self.block()?;
        }

        let mut root = ConditionalNode {
            test: token_str_val(&tok),
            consequent,
            alternate: None,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        };

        let mut else_ifs: Vec<ConditionalNode> = Vec::new();
        let mut final_else: Option<BlockNode> = None;

        loop {
            let next_type = self.peek()?.token_type.clone();
            if next_type == "newline" {
                self.expect("newline")?;
            } else if next_type == "else-if" {
                let elif_tok = self.expect("else-if")?;
                let mut elif_cons = self.empty_block(elif_tok.loc.start.line);
                if self.peek()?.token_type == "indent" {
                    elif_cons = self.block()?;
                }
                else_ifs.push(ConditionalNode {
                    test: token_str_val(&elif_tok),
                    consequent: elif_cons,
                    alternate: None,
                    line: elif_tok.loc.start.line,
                    column: Some(elif_tok.loc.start.column),
                    filename: self.filename.clone(),
                });
            } else if next_type == "else" {
                self.expect("else")?;
                if self.peek()?.token_type == "indent" {
                    final_else = Some(self.block()?);
                }
                break;
            } else {
                break;
            }
        }

        let mut tail_alt: Option<Box<Node>> = final_else.map(|b| Box::new(Node::Block(b)));
        for mut elif_node in else_ifs.into_iter().rev() {
            elif_node.alternate = tail_alt;
            tail_alt = Some(Box::new(Node::Conditional(elif_node)));
        }
        root.alternate = tail_alt;

        Ok(Node::Conditional(root))
    }

    fn parse_while(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("while")?;
        let block = if self.peek()?.token_type == "indent" {
            self.block()?
        } else {
            self.empty_block(tok.loc.start.line)
        };
        Ok(Node::While(WhileNode {
            test: token_str_val(&tok),
            block,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_block_code(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("blockcode")?;
        let line = tok.loc.start.line;
        let column = tok.loc.start.column;
        let mut text = String::new();
        if self.peek()?.token_type == "start-pipeless-text" {
            self.advance()?;
            while self.peek()?.token_type != "end-pipeless-text" {
                let inner = self.advance()?;
                match inner.token_type.as_str() {
                    "text" => text.push_str(&token_str_val(&inner)),
                    "newline" => text.push('\n'),
                    other => {
                        return Err(self.error(
                            "INVALID_TOKEN",
                            format!("Unexpected token type: {other}"),
                            &inner,
                        ));
                    }
                }
            }
            self.advance()?;
        }
        Ok(Node::Code(CodeNode {
            val: text,
            buffer: false,
            must_escape: false,
            is_inline: false,
            debug: None,
            block: None,
            line,
            column: Some(column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_comment(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("comment")?;
        if let Some(block) = self.parse_text_block()? {
            Ok(Node::BlockComment(BlockCommentNode {
                val: token_str_val(&tok),
                block,
                buffer: tok.buffer.unwrap_or(false),
                line: tok.loc.start.line,
                column: Some(tok.loc.start.column),
                filename: self.filename.clone(),
            }))
        } else {
            Ok(Node::Comment(CommentNode {
                val: token_str_val(&tok),
                buffer: tok.buffer.unwrap_or(false),
                line: tok.loc.start.line,
                column: Some(tok.loc.start.column),
                filename: self.filename.clone(),
            }))
        }
    }

    fn parse_doctype(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("doctype")?;
        let val = tok.val.as_ref().and_then(Value::as_str).map(String::from);
        Ok(Node::Doctype(DoctypeNode {
            val,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_extension(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("extension_start")?;
        let payload = token_str_val(&tok);
        let (rule_id, target_name) = match payload.split_once('|') {
            Some((r, t)) => (r.to_string(), t.to_string()),
            None => (String::new(), payload),
        };
        let line = tok.loc.start.line;
        let column = Some(tok.loc.start.column);
        let filename = self.filename.clone();

        let mut raw_content = String::new();
        if self.peek()?.token_type == "start-pipeless-text" {
            self.advance()?;
            while self.peek()?.token_type != "end-pipeless-text" {
                let token = self.advance()?;
                match token.token_type.as_str() {
                    "text" => {
                        raw_content.push_str(&token_str_val(&token));
                    }
                    "newline" => {
                        raw_content.push('\n');
                    }
                    _ => {}
                }
            }
            self.advance()?;
        }

        Ok(Node::Extension(ExtensionNode {
            node_type: String::from("Extension"),
            rule_id,
            target_name,
            raw_content,
            options_json: None,
            is_block: true,
            line,
            column,
            filename,
        }))
    }

    fn parse_each(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("each")?;
        let block = self.block()?;
        let alternate = if self.peek()?.token_type == "else" {
            self.advance()?;
            Some(self.block()?)
        } else {
            None
        };
        let key = tok
            .key
            .as_ref()
            .and_then(Value::as_str)
            .map(String::from);
        Ok(Node::Each(EachNode {
            obj: tok.code.clone().unwrap_or_default(),
            val: token_str_val(&tok),
            key,
            block,
            alternate,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_each_of(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("eachOf")?;
        let block = self.block()?;
        Ok(Node::EachOf(EachOfNode {
            obj: tok.code.clone().unwrap_or_default(),
            val: token_str_val(&tok),
            block,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_extends(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("extends")?;
        let path = self.expect("path")?;
        Ok(Node::Extends(ExtendsNode {
            file: FileReferenceNode::new(
                token_str_val(&path).trim().to_string(),
                path.loc.start.line,
                Some(path.loc.start.column),
                self.filename.clone(),
            ),
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_block(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("block")?;
        let block = if self.peek()?.token_type == "indent" {
            self.block()?
        } else {
            self.empty_block(tok.loc.start.line)
        };
        Ok(Node::NamedBlock(NamedBlockNode {
            name: token_str_val(&tok).trim().to_string(),
            mode: tok.mode.clone().unwrap_or_else(|| String::from("replace")),
            nodes: block.nodes,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
            parents: None,
            ignore: None,
        }))
    }

    fn parse_mixin_block(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("mixin-block")?;
        if self.in_mixin == 0 {
            return Err(self.error(
                "BLOCK_OUTISDE_MIXIN",
                "Anonymous blocks are not allowed unless they are part of a mixin.",
                &tok,
            ));
        }
        Ok(Node::MixinBlock(MixinBlockNode {
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_yield(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("yield")?;
        Ok(Node::YieldBlock(YieldBlockNode {
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        }))
    }

    fn parse_include(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("include")?;
        let path_tok = self.expect("path")?;
        let path_str = token_str_val(&path_tok).trim().to_string();
        let file_ref = FileReferenceNode::new(
            path_str.clone(),
            path_tok.loc.start.line,
            Some(path_tok.loc.start.column),
            self.filename.clone(),
        );

        let is_pug = path_str.len() >= 4
            && path_str.as_bytes()[path_str.len() - 4..].eq_ignore_ascii_case(b".pug");
        if is_pug {
            let block = if self.peek()?.token_type == "indent" {
                self.block()?
            } else {
                self.empty_block(tok.loc.start.line)
            };
            Ok(Node::Include(IncludeNode {
                file: file_ref,
                block,
                line: tok.loc.start.line,
                column: Some(tok.loc.start.column),
                filename: self.filename.clone(),
            }))
        } else {
            if self.peek()?.token_type == "indent" {
                let err_tok = self.peek()?.clone();
                return Err(self.error(
                    "RAW_INCLUDE_BLOCK",
                    "Raw inclusion cannot contain a block",
                    &err_tok,
                ));
            }
            Ok(Node::RawInclude(RawIncludeNode {
                file: file_ref,
                line: tok.loc.start.line,
                column: Some(tok.loc.start.column),
                filename: self.filename.clone(),
            }))
        }
    }

    fn parse_call(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("call")?;
        let name = token_str_val(&tok);
        let args = tok
            .args
            .as_ref()
            .and_then(Value::as_str)
            .map(String::from);
        let mixin = MixinNode {
            name,
            args,
            block: Some(self.empty_block(tok.loc.start.line)),
            call: true,
            attrs: Some(Vec::new()),
            attribute_blocks: Some(Vec::new()),
            code: None,
            text_only: None,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
        };

        let mut tag_like = TagLike::MixinCall(mixin);
        self.tag(&mut tag_like, false)?;
        let TagLike::MixinCall(mut m) = tag_like else {
            unreachable!()
        };
        if let Some(code) = m.code.take() {
            if let Some(ref mut b) = m.block {
                b.nodes.push(Node::Code(*code));
            }
        }
        if m.block.as_ref().is_some_and(|b| b.nodes.is_empty()) {
            m.block = None;
        }
        Ok(Node::Mixin(m))
    }

    fn parse_mixin(&mut self) -> Result<Node, IsmdError> {
        let tok = self.expect("mixin")?;
        let name = token_str_val(&tok);
        let args = tok
            .args
            .as_ref()
            .and_then(Value::as_str)
            .map(String::from);

        if self.peek()?.token_type == "indent" {
            self.in_mixin += 1;
            let block_res = self.block();
            self.in_mixin -= 1;
            let block = block_res?;
            Ok(Node::Mixin(MixinNode {
                name,
                args,
                block: Some(block),
                call: false,
                attrs: None,
                attribute_blocks: None,
                code: None,
                text_only: None,
                line: tok.loc.start.line,
                column: Some(tok.loc.start.column),
                filename: self.filename.clone(),
            }))
        } else {
            Err(self.error(
                "MIXIN_WITHOUT_BODY",
                format!("Mixin {name} declared without body"),
                &tok,
            ))
        }
    }

    fn parse_text_block(&mut self) -> Result<Option<BlockNode>, IsmdError> {
        let Some(tok) = self.accept("start-pipeless-text")? else {
            return Ok(None);
        };
        let mut block = self.empty_block(tok.loc.start.line);
        while self.peek()?.token_type != "end-pipeless-text" {
            let inner = self.advance()?;
            match inner.token_type.as_str() {
                "text" => {
                    block.nodes.push(Node::Text(TextNode {
                        val: token_str_val(&inner),
                        line: Some(inner.loc.start.line),
                        column: Some(inner.loc.start.column),
                        filename: self.filename.clone(),
                        is_html: None,
                    }));
                }
                "newline" => {
                    block.nodes.push(Node::Text(TextNode {
                        val: String::from("\n"),
                        line: Some(inner.loc.start.line),
                        column: Some(inner.loc.start.column),
                        filename: self.filename.clone(),
                        is_html: None,
                    }));
                }
                "start-ismd-interpolation" => {
                    let expr = self.parse_expr()?;
                    block.nodes.push(expr);
                    self.expect("end-ismd-interpolation")?;
                }
                "interpolated-code" => {
                    block.nodes.push(Node::Code(CodeNode {
                        val: token_str_val(&inner),
                        buffer: inner.buffer.unwrap_or(false),
                        must_escape: inner.must_escape != Some(false),
                        is_inline: true,
                        debug: None,
                        block: None,
                        line: inner.loc.start.line,
                        column: Some(inner.loc.start.column),
                        filename: self.filename.clone(),
                    }));
                }
                other => {
                    return Err(self.error(
                        "INVALID_TOKEN",
                        format!("Unexpected token type: {other}"),
                        &inner,
                    ));
                }
            }
        }
        self.advance()?;
        Ok(Some(block))
    }

    fn block(&mut self) -> Result<BlockNode, IsmdError> {
        let tok = self.expect("indent")?;
        let mut block = self.empty_block(tok.loc.start.line);
        loop {
            let tt = self.peek()?.token_type.as_str();
            if tt == "outdent" {
                break;
            } else if tt == "newline" {
                self.advance()?;
            } else if tt == "text-html" {
                let html_nodes = self.parse_text_html()?;
                block.nodes.extend(html_nodes);
            } else {
                let expr = self.parse_expr()?;
                if let Node::Block(b) = expr {
                    block.nodes.extend(b.nodes);
                } else {
                    block.nodes.push(expr);
                }
            }
        }
        self.expect("outdent")?;
        Ok(block)
    }

    fn parse_interpolation(&mut self) -> Result<Node, IsmdError> {
        let mut tok = self.advance()?;
        let interp = InterpolatedTagNode {
            expr: token_str_val_take(&mut tok),
            self_closing: false,
            block: self.empty_block(tok.loc.start.line),
            attrs: Vec::new(),
            attribute_blocks: Vec::new(),
            is_inline: false,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
            code: None,
            text_only: None,
        };
        let mut tag_like = TagLike::InterpolatedTag(interp);
        self.tag(&mut tag_like, true)?;
        let TagLike::InterpolatedTag(res) = tag_like else {
            unreachable!()
        };
        Ok(Node::InterpolatedTag(res))
    }

    fn parse_tag(&mut self) -> Result<Node, IsmdError> {
        let mut tok = self.advance()?;
        let name = token_str_val_take(&mut tok);
        let is_inline = is_inline_tag(&name);
        let tag_node = TagNode {
            name,
            self_closing: false,
            block: self.empty_block(tok.loc.start.line),
            attrs: Vec::new(),
            attribute_blocks: Vec::new(),
            is_inline,
            line: tok.loc.start.line,
            column: Some(tok.loc.start.column),
            filename: self.filename.clone(),
            code: None,
            text_only: None,
        };
        let mut tag_like = TagLike::Tag(tag_node);
        self.tag(&mut tag_like, true)?;
        let TagLike::Tag(res) = tag_like else {
            unreachable!()
        };
        Ok(Node::Tag(res))
    }

    fn tag(&mut self, tag: &mut TagLike, self_closing_allowed: bool) -> Result<(), IsmdError> {
        let mut attribute_names: Vec<String> = Vec::new();
        let mut seen_attrs = false;

        loop {
            let kind = match self.peek()?.token_type.as_str() {
                "id" | "class" => TagAttrKind::IdOrClass,
                "start-attributes" => TagAttrKind::StartAttributes,
                "&attributes" => TagAttrKind::StartAttributeBlocks,
                _ => TagAttrKind::Other,
            };
            match kind {
                TagAttrKind::IdOrClass => {
                    let mut tok = self.advance()?;
                    if tok.token_type == "id" {
                        if attribute_names.iter().any(|n| n == "id") {
                            return Err(self.error(
                                "DUPLICATE_ID",
                                "Duplicate attribute \"id\" is not allowed.",
                                &tok,
                            ));
                        }
                        attribute_names.push(String::from("id"));
                    }
                    let raw = token_str_val_take(&mut tok);
                    let mut val_str = String::with_capacity(raw.len() + 2);
                    val_str.push('\'');
                    val_str.push_str(&raw);
                    val_str.push('\'');
                    tag.attrs_mut().push(Attribute {
                        name: tok.token_type,
                        val: Value::String(val_str),
                        line: Some(tok.loc.start.line),
                        column: Some(tok.loc.start.column),
                        filename: self.filename.clone(),
                        must_escape: false,
                    });
                }
                TagAttrKind::StartAttributes => {
                    if seen_attrs {
                        let line = self.peek()?.loc.start.line;
                        let fname = self.filename.as_deref().unwrap_or("undefined");
                        self.warnings.push(format!(
                            "{fname}, line {line}:\nYou should not have ismd tags with multiple attributes."
                        ));
                    }
                    seen_attrs = true;
                    let new_attrs = self.attrs(Some(&mut attribute_names))?;
                    tag.attrs_mut().extend(new_attrs);
                }
                TagAttrKind::StartAttributeBlocks => {
                    let mut tok = self.advance()?;
                    tag.attribute_blocks_mut().push(AttributeBlock {
                        node_type: String::from("AttributeBlock"),
                        val: token_str_val_take(&mut tok),
                        line: tok.loc.start.line,
                        column: Some(tok.loc.start.column),
                        filename: self.filename.clone(),
                    });
                }
                TagAttrKind::Other => break,
            }
        }

        if self.peek()?.token_type == "dot" {
            tag.set_text_only(true);
            self.advance()?;
        }

        let kind = match self.peek()?.token_type.as_str() {
            "text" | "interpolated-code" => TagTailKind::TextOrInterp,
            "code" => TagTailKind::Code,
            ":" => TagTailKind::Colon,
            "newline" | "indent" | "outdent" | "eos" | "start-pipeless-text"
            | "end-ismd-interpolation" => TagTailKind::Newline,
            "slash" => TagTailKind::Slash,
            _ => TagTailKind::Other,
        };
        match kind {
            TagTailKind::TextOrInterp => {
                let text = self.parse_text(false)?;
                let filename = self.filename.clone();
                let block = tag.block_mut(&filename);
                if let Node::Block(b) = text {
                    block.nodes.extend(b.nodes);
                } else {
                    block.nodes.push(text);
                }
            }
            TagTailKind::Code => {
                let code_node = self.parse_code(true)?;
                let filename = self.filename.clone();
                tag.block_mut(&filename).nodes.push(Node::Code(code_node));
            }
            TagTailKind::Colon => {
                self.advance()?;
                let expr = self.parse_expr()?;
                let block = match expr {
                    Node::Block(b) => b,
                    other => self.init_block(tag.line(), vec![other]),
                };
                tag.set_block(block);
            }
            TagTailKind::Newline => {}
            TagTailKind::Slash if self_closing_allowed => {
                self.advance()?;
                tag.set_self_closing(true);
            }
            TagTailKind::Slash | TagTailKind::Other => {
                let err_tok = self.peek()?.clone();
                let other = err_tok.token_type.as_str();
                let slash_part = if self_closing_allowed { ", `slash`" } else { "" };
                return Err(self.error(
                    "INVALID_TOKEN",
                    format!(
                        "Unexpected token `{other}` expected `text`, `interpolated-code`, `code`, `:`{slash_part}, `newline` or `eos`"
                    ),
                    &err_tok,
                ));
            }
        }

        while self.peek()?.token_type == "newline" {
            self.advance()?;
        }

        if tag.is_text_only() {
            let block = self
                .parse_text_block()?
                .unwrap_or_else(|| self.empty_block(tag.line()));
            tag.set_block(block);
        } else if self.peek()?.token_type == "indent" {
            let child_block = self.block()?;
            let filename = self.filename.clone();
            tag.block_mut(&filename).nodes.extend(child_block.nodes);
        }

        Ok(())
    }

    fn attrs(
        &mut self,
        mut attribute_names: Option<&mut Vec<String>>,
    ) -> Result<Vec<Attribute>, IsmdError> {
        self.expect("start-attributes")?;
        let mut attrs = Vec::new();
        let mut tok = self.advance()?;
        while tok.token_type == "attribute" {
            let attr_name = tok.name.take().unwrap_or_default();
            if attr_name != "class"
                && let Some(ref mut names) = attribute_names
            {
                if names.iter().any(|n| n == &attr_name) {
                    return Err(self.error(
                        "DUPLICATE_ATTRIBUTE",
                        format!("Duplicate attribute \"{attr_name}\" is not allowed."),
                        &tok,
                    ));
                }
                names.push(attr_name.clone());
            }
            attrs.push(Attribute {
                name: attr_name,
                val: tok.val.take().unwrap_or(Value::Bool(true)),
                line: Some(tok.loc.start.line),
                column: Some(tok.loc.start.column),
                filename: self.filename.clone(),
                must_escape: tok.must_escape != Some(false),
            });
            tok = self.advance()?;
        }
        self.defer(tok);
        self.expect("end-attributes")?;
        Ok(attrs)
    }
}

fn token_str_val_take(tok: &mut Token) -> String {
    match tok.val.take() {
        Some(Value::String(s)) => s,
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn token_str_val(tok: &Token) -> String {
    match &tok.val {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}
