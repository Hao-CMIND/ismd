use pug_ast::{
    Attribute, BlockNode, CodeNode, CommentNode, FilterNode, Node, TagNode, TextNode, Token,
};
use pug_error::{ErrorOptions, PugError};
use serde_json::Value;

/// Inline tags matching `raw/compiler/packages/pug-parser/lib/inline-tags.js`.
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

/// Minimal Walking-Skeleton Parser for Step 1 (expanded to full `pug-parser@5.0.1` in Step 3).
pub fn parse(tokens: &[Token], options: &ParserOptions) -> Result<BlockNode, PugError> {
    let mut parser = Parser {
        tokens,
        pos: 0,
        filename: options.filename.clone(),
        src: options.src.clone(),
    };
    parser.parse_root()
}

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    filename: Option<String>,
    src: Option<String>,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&'a Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> Option<&'a Token> {
        let tok = self.tokens.get(self.pos);
        if tok.is_some() {
            self.pos += 1;
        }
        tok
    }

    fn parse_root(&mut self) -> Result<BlockNode, PugError> {
        let mut nodes = Vec::new();
        while let Some(tok) = self.peek() {
            match tok.token_type.as_str() {
                "eos" => {
                    self.advance();
                    break;
                }
                "newline" => {
                    self.advance();
                }
                _ => {
                    nodes.push(self.parse_expr()?);
                }
            }
        }
        Ok(BlockNode {
            nodes,
            line: 0,
            column: None,
            filename: self.filename.clone(),
        })
    }

    fn parse_block(&mut self, line: usize) -> Result<BlockNode, PugError> {
        self.advance(); // consume `indent`
        let mut nodes = Vec::new();
        while let Some(tok) = self.peek() {
            match tok.token_type.as_str() {
                "outdent" => {
                    self.advance();
                    break;
                }
                "eos" => break,
                "newline" => {
                    self.advance();
                }
                _ => {
                    nodes.push(self.parse_expr()?);
                }
            }
        }
        Ok(BlockNode {
            nodes,
            line,
            column: None,
            filename: self.filename.clone(),
        })
    }

    fn parse_expr(&mut self) -> Result<Node, PugError> {
        let tok = self.peek().ok_or_else(|| {
            PugError::new(
                "UNEXPECTED_EOS",
                "Unexpected end of input",
                ErrorOptions {
                    line: 1,
                    column: Some(1),
                    filename: self.filename.clone(),
                    src: self.src.clone(),
                },
            )
        })?;

        match tok.token_type.as_str() {
            "tag" | "class" | "id" => self.parse_tag(),
            "text" | "text-html" => {
                let tok = self.advance().unwrap();
                let val = token_str_val(tok);
                Ok(Node::Text(TextNode {
                    val,
                    line: tok.loc.start.line,
                    column: Some(tok.loc.start.column),
                    filename: tok.loc.filename.clone().or_else(|| self.filename.clone()),
                    is_html: if tok.token_type == "text-html" {
                        Some(true)
                    } else {
                        None
                    },
                }))
            }
            "code" | "interpolated-code" => {
                let tok = self.advance().unwrap();
                let val = token_str_val(tok);
                Ok(Node::Code(CodeNode {
                    val,
                    buffer: tok.buffer.unwrap_or(false),
                    must_escape: tok.must_escape.unwrap_or(false),
                    is_inline: tok.token_type == "interpolated-code",
                    block: None,
                    line: tok.loc.start.line,
                    column: Some(tok.loc.start.column),
                    filename: tok.loc.filename.clone().or_else(|| self.filename.clone()),
                }))
            }
            "filter" => self.parse_filter(),
            "comment" => {
                let tok = self.advance().unwrap();
                let val = token_str_val(tok);
                let buffer = tok.buffer.unwrap_or(false);
                let line = tok.loc.start.line;
                let column = Some(tok.loc.start.column);
                let filename = tok.loc.filename.clone().or_else(|| self.filename.clone());
                if let Some(next) = self.peek()
                    && next.token_type == "start-pipeless-text"
                {
                    let block = self.parse_pipeless_text_block(line, &filename);
                    let mut text_parts = Vec::new();
                    for n in block.nodes {
                        if let Node::Text(tn) = n {
                            text_parts.push(tn.val);
                        }
                    }
                    let joined = text_parts.join("");
                    let full_val = if val.is_empty() {
                        format!("\n{joined}\n")
                    } else {
                        format!("{val}\n{joined}\n")
                    };
                    return Ok(Node::Comment(CommentNode {
                        val: full_val,
                        buffer,
                        line,
                        column,
                        filename,
                    }));
                }
                Ok(Node::Comment(CommentNode {
                    val,
                    buffer,
                    line,
                    column,
                    filename,
                }))
            }
            other => {
                let line = tok.loc.start.line as i64;
                let col = tok.loc.start.column as i64;
                Err(PugError::new(
                    "INVALID_TOKEN",
                    format!("unexpected token \"{other}\""),
                    ErrorOptions {
                        line,
                        column: Some(col),
                        filename: self.filename.clone(),
                        src: self.src.clone(),
                    },
                ))
            }
        }
    }

    fn parse_tag(&mut self) -> Result<Node, PugError> {
        let first = self.peek().unwrap();
        let line = first.loc.start.line;
        let column = first.loc.start.column;
        let filename = first.loc.filename.clone().or_else(|| self.filename.clone());

        let name = if first.token_type == "tag" {
            let t = self.advance().unwrap();
            token_str_val(t)
        } else {
            String::from("div")
        };

        let mut attrs: Vec<Attribute> = Vec::new();
        while let Some(tok) = self.peek() {
            match tok.token_type.as_str() {
                "class" => {
                    let t = self.advance().unwrap();
                    let cls = token_str_val(t);
                    attrs.push(Attribute {
                        name: String::from("class"),
                        val: Value::String(format!("'{cls}'")),
                        must_escape: false,
                        line: Some(t.loc.start.line),
                        column: Some(t.loc.start.column),
                        filename: t.loc.filename.clone().or_else(|| filename.clone()),
                    });
                }
                "id" => {
                    let t = self.advance().unwrap();
                    let id = token_str_val(t);
                    attrs.push(Attribute {
                        name: String::from("id"),
                        val: Value::String(format!("'{id}'")),
                        must_escape: false,
                        line: Some(t.loc.start.line),
                        column: Some(t.loc.start.column),
                        filename: t.loc.filename.clone().or_else(|| filename.clone()),
                    });
                }
                _ => break,
            }
        }

        let mut block = BlockNode {
            nodes: Vec::new(),
            line,
            column: None,
            filename: filename.clone(),
        };
        let mut code_node: Option<Box<CodeNode>> = None;
        let mut self_closing = false;

        if let Some(tok) = self.peek()
            && tok.token_type == "slash"
        {
            self.advance();
            self_closing = true;
        }

        if let Some(tok) = self.peek() {
            match tok.token_type.as_str() {
                "dot" => {
                    self.advance();
                    if let Some(next) = self.peek()
                        && next.token_type == "start-pipeless-text"
                    {
                        let pipeless = self.parse_pipeless_text_block(line, &filename);
                        block.nodes.extend(pipeless.nodes);
                    }
                }
                "code" => {
                    let t = self.advance().unwrap();
                    code_node = Some(Box::new(CodeNode {
                        val: token_str_val(t),
                        buffer: t.buffer.unwrap_or(false),
                        must_escape: t.must_escape.unwrap_or(false),
                        is_inline: true,
                        block: None,
                        line: t.loc.start.line,
                        column: Some(t.loc.start.column),
                        filename: t.loc.filename.clone().or_else(|| filename.clone()),
                    }));
                }
                "text" | "interpolated-code" | "start-pug-interpolation" => {
                    self.parse_inline_text_sequence(&mut block.nodes, &filename)?;
                }
                _ => {}
            }
        }

        if let Some(tok) = self.peek()
            && tok.token_type == "indent"
        {
            let child_block = self.parse_block(tok.loc.start.line)?;
            block.nodes.extend(child_block.nodes);
        }

        Ok(Node::Tag(TagNode {
            name: name.clone(),
            self_closing,
            block,
            attrs,
            attribute_blocks: Vec::new(),
            is_inline: is_inline_tag(&name),
            line,
            column: Some(column),
            filename,
            code: code_node,
            text_only: None,
        }))
    }

    fn parse_inline_text_sequence(
        &mut self,
        nodes: &mut Vec<Node>,
        filename: &Option<String>,
    ) -> Result<(), PugError> {
        while let Some(tok) = self.peek() {
            match tok.token_type.as_str() {
                "text" => {
                    let t = self.advance().unwrap();
                    nodes.push(Node::Text(TextNode {
                        val: token_str_val(t),
                        line: t.loc.start.line,
                        column: Some(t.loc.start.column),
                        filename: t.loc.filename.clone().or_else(|| filename.clone()),
                        is_html: None,
                    }));
                }
                "interpolated-code" => {
                    let t = self.advance().unwrap();
                    nodes.push(Node::Code(CodeNode {
                        val: token_str_val(t),
                        buffer: t.buffer.unwrap_or(false),
                        must_escape: t.must_escape.unwrap_or(false),
                        is_inline: true,
                        block: None,
                        line: t.loc.start.line,
                        column: Some(t.loc.start.column),
                        filename: t.loc.filename.clone().or_else(|| filename.clone()),
                    }));
                }
                "start-pug-interpolation" => {
                    self.advance();
                    while let Some(inner) = self.peek() {
                        if inner.token_type == "end-pug-interpolation" {
                            self.advance();
                            break;
                        }
                        nodes.push(self.parse_expr()?);
                    }
                }
                _ => break,
            }
        }
        Ok(())
    }

    fn parse_pipeless_text_block(
        &mut self,
        line: usize,
        filename: &Option<String>,
    ) -> BlockNode {
        let mut nodes = Vec::new();
        if let Some(next) = self.peek()
            && next.token_type == "start-pipeless-text"
        {
            self.advance();
            while let Some(t) = self.peek() {
                match t.token_type.as_str() {
                    "end-pipeless-text" => {
                        self.advance();
                        break;
                    }
                    "newline" => {
                        let nl = self.advance().unwrap();
                        nodes.push(Node::Text(TextNode {
                            val: String::from("\n"),
                            line: nl.loc.start.line,
                            column: Some(nl.loc.start.column),
                            filename: filename.clone(),
                            is_html: None,
                        }));
                    }
                    "text" => {
                        let txt = self.advance().unwrap();
                        nodes.push(Node::Text(TextNode {
                            val: token_str_val(txt),
                            line: txt.loc.start.line,
                            column: Some(txt.loc.start.column),
                            filename: filename.clone(),
                            is_html: None,
                        }));
                    }
                    "interpolated-code" => {
                        let ic = self.advance().unwrap();
                        nodes.push(Node::Code(CodeNode {
                            val: token_str_val(ic),
                            buffer: ic.buffer.unwrap_or(false),
                            must_escape: ic.must_escape.unwrap_or(false),
                            is_inline: true,
                            block: None,
                            line: ic.loc.start.line,
                            column: Some(ic.loc.start.column),
                            filename: filename.clone(),
                        }));
                    }
                    "start-pug-interpolation" => {
                        self.advance();
                        while let Some(inner) = self.peek() {
                            if inner.token_type == "end-pug-interpolation" {
                                self.advance();
                                break;
                            }
                            if let Ok(n) = self.parse_expr() {
                                nodes.push(n);
                            } else {
                                break;
                            }
                        }
                    }
                    _ => break,
                }
            }
        }
        BlockNode {
            nodes,
            line,
            column: None,
            filename: filename.clone(),
        }
    }

    fn parse_filter(&mut self) -> Result<Node, PugError> {
        let tok = self.advance().unwrap();
        let name = token_str_val(tok);
        let line = tok.loc.start.line;
        let column = tok.loc.start.column;
        let filename = tok.loc.filename.clone().or_else(|| self.filename.clone());

        let mut nodes = Vec::new();
        if let Some(next) = self.peek()
            && next.token_type == "start-pipeless-text"
        {
            self.advance();
            while let Some(t) = self.peek() {
                match t.token_type.as_str() {
                    "end-pipeless-text" => {
                        self.advance();
                        break;
                    }
                    "newline" => {
                        let nl = self.advance().unwrap();
                        nodes.push(Node::Text(TextNode {
                            val: String::from("\n"),
                            line: nl.loc.start.line,
                            column: Some(nl.loc.start.column),
                            filename: filename.clone(),
                            is_html: None,
                        }));
                    }
                    "text" => {
                        let txt = self.advance().unwrap();
                        nodes.push(Node::Text(TextNode {
                            val: token_str_val(txt),
                            line: txt.loc.start.line,
                            column: Some(txt.loc.start.column),
                            filename: filename.clone(),
                            is_html: None,
                        }));
                    }
                    _ => break,
                }
            }
        }

        Ok(Node::Filter(FilterNode {
            name,
            block: BlockNode {
                nodes,
                line,
                column: None,
                filename: filename.clone(),
            },
            attrs: Vec::new(),
            line,
            column: Some(column),
            filename,
        }))
    }
}

fn token_str_val(tok: &Token) -> String {
    match &tok.val {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}
