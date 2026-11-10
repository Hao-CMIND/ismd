use pug_ast::{
    Attribute, AttributeBlock, BlockCommentNode, BlockNode, CaseNode, CodeNode, CommentNode,
    ConditionalNode, DoctypeNode, EachNode, EachOfNode, InterpolatedTagNode, Node, TagNode,
    WhenNode, WhileNode,
};
use pug_attrs::{AttrsFormat, compile_attrs};
use pug_error::{ErrorOptions, PugError};
use pug_js::{add_with_checked, eval_constant, js_stringify_str};
use serde::{Deserialize, Serialize};

/// Void elements matching `void-elements@3.1.0`.
pub const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "menuitem",
    "meta", "param", "source", "track", "wbr",
];

const INTERNAL_VARIABLES: &[&str] = &[
    "pug",
    "pug_mixins",
    "pug_interp",
    "pug_debug_filename",
    "pug_debug_line",
    "pug_debug_sources",
    "pug_html",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodeGenOptions {
    pub compile_debug: bool,
    pub pretty: Option<String>,
    pub doctype: Option<String>,
    pub inline_runtime_functions: bool,
    pub globals: Vec<String>,
    pub use_self: bool,
    pub include_sources: bool,
    pub debug_sources_json: Option<String>,
    pub template_name: String,
    pub filename: Option<String>,
    pub src: Option<String>,
}

/// Generates a JavaScript template function from a Pug `BlockNode` AST.
pub fn generate_code(ast: &BlockNode, options: &CodeGenOptions) -> Result<String, PugError> {
    if let Some(ref dt) = options.doctype
        && (dt.contains('<') || dt.contains('>'))
    {
        return Err(PugError::new(
            "INVALID_DOCTYPE",
            "Doctype can not contain \"<\" or \">\"",
            ErrorOptions {
                line: 1,
                column: None,
                filename: options.filename.clone(),
                src: options.src.clone(),
            },
        ));
    }

    let mut runtime_functions_used = Vec::new();
    if options.compile_debug && options.inline_runtime_functions {
        runtime_functions_used.push(String::from("rethrow"));
    }

    let mut generator = CodeGenerator {
        options,
        buf: Vec::new(),
        runtime_functions_used,
        buffered_concatenation_count: 0,
        last_buffered_idx: None,
        last_buffered_type: None,
        buffer_start_char: "",
        last_buffered: String::new(),
        has_compiled_doctype: false,
        has_compiled_tag: false,
        indents: 0,
        parent_indents: 0,
        escape_pretty_mode: false,
        terse: false,
        xml: false,
        doctype: None,
        each_count: 0,
    };

    if let Some(ref dt) = options.doctype
        && !dt.is_empty()
    {
        generator.set_doctype(dt);
    }
    if options.pretty.is_some() {
        generator.buf.push(String::from("var pug_indent = [];"));
    }

    generator.visit_block(ast)?;
    generator.finish()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BufferedType {
    Text,
    Code,
}

struct CodeGenerator<'a> {
    options: &'a CodeGenOptions,
    buf: Vec<String>,
    runtime_functions_used: Vec<String>,
    buffered_concatenation_count: usize,
    last_buffered_idx: Option<usize>,
    last_buffered_type: Option<BufferedType>,
    buffer_start_char: &'static str,
    last_buffered: String,
    has_compiled_doctype: bool,
    has_compiled_tag: bool,
    indents: usize,
    parent_indents: usize,
    escape_pretty_mode: bool,
    terse: bool,
    xml: bool,
    doctype: Option<String>,
    each_count: usize,
}

impl<'a> CodeGenerator<'a> {
    fn runtime(&mut self, name: &str) -> String {
        if self.options.inline_runtime_functions {
            self.runtime_functions_used.push(name.to_string());
            format!("pug_{name}")
        } else {
            format!("pug.{name}")
        }
    }

    fn error(&self, message: String, code: &str, line: usize, column: Option<usize>, filename: Option<String>) -> PugError {
        PugError::new(
            code,
            message,
            ErrorOptions {
                line: line as i64,
                column: column.map(|c| c as i64),
                filename: filename.or_else(|| self.options.filename.clone()),
                src: self.options.src.clone(),
            },
        )
    }

    fn set_doctype(&mut self, name: &str) {
        let dt = match name.to_lowercase().as_str() {
            "html" => String::from("<!DOCTYPE html>"),
            "xml" => String::from("<?xml version=\"1.0\" encoding=\"utf-8\" ?>"),
            "transitional" => String::from(
                "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd\">",
            ),
            "strict" => String::from(
                "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">",
            ),
            "frameset" => String::from(
                "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Frameset//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-frameset.dtd\">",
            ),
            "1.1" => String::from(
                "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.1//EN\" \"http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd\">",
            ),
            "basic" => String::from(
                "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML Basic 1.1//EN\" \"http://www.w3.org/TR/xhtml-basic/xhtml-basic11.dtd\">",
            ),
            "mobile" => String::from(
                "<!DOCTYPE html PUBLIC \"-//WAPFORUM//DTD XHTML Mobile 1.2//EN\" \"http://www.openmobilealliance.org/tech/DTD/xhtml-mobile12.dtd\">",
            ),
            "plist" => String::from(
                "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
            ),
            _ => format!("<!DOCTYPE {name}>"),
        };
        self.terse = dt.to_lowercase() == "<!doctype html>";
        self.xml = dt.starts_with("<?xml");
        self.doctype = Some(dt);
    }

    fn buffer(&mut self, s: &str) {
        let escaped = js_stringify_str(s);
        let inner = &escaped[1..escaped.len() - 1];

        if self.last_buffered_idx == Some(self.buf.len()) && self.buffered_concatenation_count < 100
        {
            if self.last_buffered_type == Some(BufferedType::Code) {
                self.last_buffered.push_str(" + \"");
                self.buffered_concatenation_count += 1;
            }
            self.last_buffered_type = Some(BufferedType::Text);
            self.last_buffered.push_str(inner);
            let idx = self.last_buffered_idx.unwrap() - 1;
            self.buf[idx] = format!(
                "pug_html = pug_html + {}{}\";",
                self.buffer_start_char, self.last_buffered
            );
        } else {
            self.buffered_concatenation_count = 0;
            self.buf.push(format!("pug_html = pug_html + \"{inner}\";"));
            self.last_buffered_type = Some(BufferedType::Text);
            self.buffer_start_char = "\"";
            self.last_buffered = inner.to_string();
            self.last_buffered_idx = Some(self.buf.len());
        }
    }

    fn buffer_expression(&mut self, src: &str) {
        if let Some(cval) = eval_constant(src) {
            self.buffer(&cval.to_js_string());
            return;
        }
        if self.last_buffered_idx == Some(self.buf.len()) && self.buffered_concatenation_count < 100
        {
            self.buffered_concatenation_count += 1;
            if self.last_buffered_type == Some(BufferedType::Text) {
                self.last_buffered.push('"');
            }
            self.last_buffered_type = Some(BufferedType::Code);
            self.last_buffered.push_str(&format!(" + ({src})"));
            let idx = self.last_buffered_idx.unwrap() - 1;
            self.buf[idx] = format!(
                "pug_html = pug_html + ({}{});",
                self.buffer_start_char, self.last_buffered
            );
        } else {
            self.buffered_concatenation_count = 0;
            self.buf.push(format!("pug_html = pug_html + ({src});"));
            self.last_buffered_type = Some(BufferedType::Code);
            self.buffer_start_char = "";
            self.last_buffered = format!("({src})");
            self.last_buffered_idx = Some(self.buf.len());
        }
    }

    fn pretty_indent(&mut self, offset: usize, newline: bool) {
        let Some(ref pp) = self.options.pretty else {
            return;
        };
        let nl = if newline { "\n" } else { "" };
        let count = (self.indents + offset).saturating_sub(1);
        let indent_str = format!("{nl}{}", pp.repeat(count));
        self.buffer(&indent_str);
        if self.parent_indents > 0 {
            self.buf
                .push(String::from("pug_html = pug_html + pug_indent.join(\"\");"));
        }
    }

    fn emit_debug_if_needed(&mut self, node: &Node) {
        if !self.options.compile_debug || matches!(node, Node::Block(_) | Node::When(_)) {
            return;
        }
        if let Node::Code(c) = node
            && c.debug == Some(false)
        {
            return;
        }
        let (line, filename) = node_line_and_filename(node);
        if line > 0 {
            let mut js = format!(";pug_debug_line = {line}");
            if let Some(f) = filename {
                js.push_str(&format!(";pug_debug_filename = {}", js_stringify_str(f)));
            }
            js.push(';');
            self.buf.push(js);
        }
    }

    fn visit(&mut self, node: &Node) -> Result<(), PugError> {
        self.emit_debug_if_needed(node);
        self.visit_node(node)
    }

    fn visit_node(&mut self, node: &Node) -> Result<(), PugError> {
        match node {
            Node::Block(b) => self.visit_block(b),
            Node::NamedBlock(nb) => self.visit_nodes(&nb.nodes),
            Node::YieldBlock(_) => Ok(()),
            Node::Tag(tag) => self.visit_tag(tag),
            Node::InterpolatedTag(tag) => self.visit_interpolated_tag(tag),
            Node::Text(text) => {
                self.buffer(&text.val);
                Ok(())
            }
            Node::Code(code) => self.visit_code(code),
            Node::Comment(comment) => self.visit_comment(comment),
            Node::BlockComment(comment) => self.visit_block_comment(comment),
            Node::Doctype(dt) => {
                self.visit_doctype(Some(dt));
                Ok(())
            }
            Node::Conditional(cond) => self.visit_conditional(cond),
            Node::While(w) => self.visit_while(w),
            Node::Each(each) => self.visit_each(each),
            Node::EachOf(each) => self.visit_each_of(each),
            Node::Case(case_node) => self.visit_case(case_node),
            Node::When(when_node) => self.visit_when(when_node),
            other => {
                let (line, filename) = node_line_and_filename(other);
                Err(self.error(
                    format!(
                        "Node of type {} ({}:{}) is not yet supported in Step 3B codegen",
                        other.node_type(),
                        filename.unwrap_or("Pug"),
                        line
                    ),
                    "UNSUPPORTED_NODE",
                    line,
                    None,
                    filename.map(String::from),
                ))
            }
        }
    }

    fn visit_block(&mut self, block: &BlockNode) -> Result<(), PugError> {
        self.visit_nodes(&block.nodes)
    }

    fn visit_nodes(&mut self, nodes: &[Node]) -> Result<(), PugError> {
        let has_pp = self.options.pretty.is_some();
        if has_pp
            && nodes.len() > 1
            && !self.escape_pretty_mode
            && matches!(nodes.first(), Some(Node::Text(_)))
            && matches!(nodes.get(1), Some(Node::Text(_)))
        {
            self.pretty_indent(1, true);
        }

        for (i, node) in nodes.iter().enumerate() {
            if has_pp
                && i > 0
                && !self.escape_pretty_mode
                && let (Some(Node::Text(prev)), Node::Text(_)) = (nodes.get(i - 1), node)
                && prev.val.ends_with('\n')
            {
                self.pretty_indent(1, false);
            }
            self.visit(node)?;
        }
        Ok(())
    }

    fn visit_doctype(&mut self, doctype: Option<&DoctypeNode>) {
        if let Some(dt) = doctype {
            let val = dt.val.as_deref().unwrap_or("");
            if !val.is_empty() || self.doctype.is_none() {
                self.set_doctype(if val.is_empty() { "html" } else { val });
            }
        }

        if let Some(dt_str) = self.doctype.clone() {
            self.buffer(&dt_str);
        }
        self.has_compiled_doctype = true;
    }

    fn visit_tag(&mut self, tag: &TagNode) -> Result<(), PugError> {
        self.indents += 1;
        let name = &tag.name;
        let has_pp = self.options.pretty.is_some();
        let is_ws_sensitive = matches!(name.as_str(), "pre" | "textarea");

        if is_ws_sensitive {
            self.escape_pretty_mode = true;
        }

        if !self.has_compiled_tag {
            if !self.has_compiled_doctype && name == "html" {
                self.visit_doctype(None);
            }
            self.has_compiled_tag = true;
        }

        if has_pp && !tag.is_inline {
            self.pretty_indent(0, true);
        }

        let is_self_closing =
            tag.self_closing || (!self.xml && VOID_ELEMENTS.contains(&name.as_str()));

        if is_self_closing {
            self.buffer("<");
            self.buffer(name);
            let attr_blocks = extract_attr_blocks(&tag.attribute_blocks);
            self.visit_attributes(&tag.attrs, attr_blocks);
            if self.terse && !tag.self_closing {
                self.buffer(">");
            } else {
                self.buffer("/>");
            }
            if tag.code.is_some() || block_has_non_whitespace_content(&tag.block) {
                return Err(self.error(
                    format!(
                        "{name} is a self closing element: <{name}/> but contains nested content."
                    ),
                    "SELF_CLOSING_CONTENT",
                    tag.line,
                    tag.column,
                    tag.filename.clone(),
                ));
            }
        } else {
            self.buffer("<");
            self.buffer(name);
            let attr_blocks = extract_attr_blocks(&tag.attribute_blocks);
            self.visit_attributes(&tag.attrs, attr_blocks);
            self.buffer(">");
            if let Some(ref code) = tag.code {
                self.visit_code(code)?;
            }
            self.visit_block(&tag.block)?;

            if has_pp && !tag.is_inline && !is_ws_sensitive && !tag_can_inline(&tag.block) {
                self.pretty_indent(0, true);
            }
            self.buffer("</");
            self.buffer(name);
            self.buffer(">");
        }

        if is_ws_sensitive {
            self.escape_pretty_mode = false;
        }
        self.indents -= 1;
        Ok(())
    }

    fn visit_interpolated_tag(&mut self, tag: &InterpolatedTagNode) -> Result<(), PugError> {
        self.indents += 1;
        let has_pp = self.options.pretty.is_some();

        if !self.has_compiled_tag {
            self.has_compiled_tag = true;
        }

        if has_pp && !tag.is_inline {
            self.pretty_indent(0, true);
        }

        if tag.self_closing {
            self.buffer("<");
            self.buffer_expression(&tag.expr);
            let attr_blocks = extract_attr_blocks(&tag.attribute_blocks);
            self.visit_attributes(&tag.attrs, attr_blocks);
            if self.terse && !tag.self_closing {
                self.buffer(">");
            } else {
                self.buffer("/>");
            }
            if tag.code.is_some() || block_has_non_whitespace_content(&tag.block) {
                return Err(self.error(
                    format!(
                        "{} is a self closing element: <{}/> but contains nested content.",
                        tag.expr, tag.expr
                    ),
                    "SELF_CLOSING_CONTENT",
                    tag.line,
                    tag.column,
                    tag.filename.clone(),
                ));
            }
        } else {
            self.buffer("<");
            self.buffer_expression(&tag.expr);
            let attr_blocks = extract_attr_blocks(&tag.attribute_blocks);
            self.visit_attributes(&tag.attrs, attr_blocks);
            self.buffer(">");
            if let Some(ref code) = tag.code {
                self.visit_code(code)?;
            }
            self.visit_block(&tag.block)?;

            if has_pp && !tag.is_inline && !tag_can_inline(&tag.block) {
                self.pretty_indent(0, true);
            }
            self.buffer("</");
            self.buffer_expression(&tag.expr);
            self.buffer(">");
        }

        self.indents -= 1;
        Ok(())
    }

    fn visit_comment(&mut self, comment: &CommentNode) -> Result<(), PugError> {
        if !comment.buffer {
            return Ok(());
        }
        if self.options.pretty.is_some() {
            self.pretty_indent(1, true);
        }
        self.buffer(&format!("<!--{}-->", comment.val));
        Ok(())
    }

    fn visit_block_comment(&mut self, comment: &BlockCommentNode) -> Result<(), PugError> {
        if !comment.buffer {
            return Ok(());
        }
        if self.options.pretty.is_some() {
            self.pretty_indent(1, true);
        }
        self.buffer(&format!("<!--{}", comment.val));
        self.visit_block(&comment.block)?;
        if self.options.pretty.is_some() {
            self.pretty_indent(1, true);
        }
        self.buffer("-->");
        Ok(())
    }

    fn visit_code(&mut self, code: &CodeNode) -> Result<(), PugError> {
        if code.buffer {
            let val = code.val.trim();
            let mut expr = format!("null == (pug_interp = {val}) ? \"\" : pug_interp");
            if code.must_escape {
                let esc = self.runtime("escape");
                expr = format!("{esc}({expr})");
            }
            self.buffer_expression(&expr);
        } else {
            self.buf.push(code.val.clone());
        }

        if let Some(ref block) = code.block {
            if !code.buffer {
                self.buf.push(String::from("{"));
            }
            self.visit_block(block)?;
            if !code.buffer {
                self.buf.push(String::from("}"));
            }
        }
        Ok(())
    }

    fn visit_conditional(&mut self, cond: &ConditionalNode) -> Result<(), PugError> {
        self.buf.push(format!("if ({}) {{", cond.test));
        self.visit_block(&cond.consequent)?;
        self.buf.push(String::from("}"));
        if let Some(ref alt) = cond.alternate {
            match alt.as_ref() {
                Node::Conditional(elif) => {
                    self.buf.push(String::from("else"));
                    self.visit_conditional(elif)?;
                }
                Node::Block(b) => {
                    self.buf.push(String::from("else {"));
                    self.visit_block(b)?;
                    self.buf.push(String::from("}"));
                }
                other => {
                    self.buf.push(String::from("else {"));
                    self.visit(other)?;
                    self.buf.push(String::from("}"));
                }
            }
        }
        Ok(())
    }

    fn visit_while(&mut self, loop_node: &WhileNode) -> Result<(), PugError> {
        self.buf.push(format!("while ({}) {{", loop_node.test));
        self.visit_block(&loop_node.block)?;
        self.buf.push(String::from("}"));
        Ok(())
    }

    fn visit_each(&mut self, each: &EachNode) -> Result<(), PugError> {
        let index_var_name = each
            .key
            .clone()
            .unwrap_or_else(|| format!("pug_index{}", self.each_count));
        self.each_count += 1;

        self.buf.push(format!(
            "// iterate {}\n;(function(){{\n  var $$obj = {};\n  if ('number' == typeof $$obj.length) {{",
            each.obj, each.obj
        ));

        if each.alternate.is_some() {
            self.buf.push(String::from("    if ($$obj.length) {"));
        }

        self.buf.push(format!(
            "      for (var {index_var_name} = 0, $$l = $$obj.length; {index_var_name} < $$l; {index_var_name}++) {{\n        var {} = $$obj[{index_var_name}];",
            each.val
        ));

        self.visit_block(&each.block)?;
        self.buf.push(String::from("      }"));

        if let Some(ref alt) = each.alternate {
            self.buf.push(String::from("    } else {"));
            self.visit_block(alt)?;
            self.buf.push(String::from("    }"));
        }

        self.buf.push(format!(
            "  }} else {{\n    var $$l = 0;\n    for (var {index_var_name} in $$obj) {{\n      $$l++;\n      var {} = $$obj[{index_var_name}];",
            each.val
        ));

        self.visit_block(&each.block)?;
        self.buf.push(String::from("    }"));

        if let Some(ref alt) = each.alternate {
            self.buf.push(String::from("    if ($$l === 0) {"));
            self.visit_block(alt)?;
            self.buf.push(String::from("    }"));
        }

        self.buf.push(String::from("  }\n}).call(this);\n"));
        Ok(())
    }

    fn visit_each_of(&mut self, each: &EachOfNode) -> Result<(), PugError> {
        self.buf.push(format!(
            "// iterate {}\nfor (const {} of {}) {{\n",
            each.obj, each.val, each.obj
        ));
        self.visit_block(&each.block)?;
        self.buf.push(String::from("}\n"));
        Ok(())
    }

    fn visit_case(&mut self, case_node: &CaseNode) -> Result<(), PugError> {
        self.buf.push(format!("switch ({}){{", case_node.expr));
        self.visit_block(&case_node.block)?;
        self.buf.push(String::from("}"));
        Ok(())
    }

    fn visit_when(&mut self, when_node: &WhenNode) -> Result<(), PugError> {
        if when_node.expr == "default" {
            self.buf.push(String::from("default:"));
        } else {
            self.buf.push(format!("case {}:", when_node.expr));
        }
        if let Some(ref block) = when_node.block {
            self.visit_block(block)?;
            self.buf.push(String::from("  break;"));
        }
        Ok(())
    }

    fn visit_attributes(&mut self, attrs: &[Attribute], mut attr_blocks: Vec<String>) {
        if !attr_blocks.is_empty() {
            if !attrs.is_empty() {
                let val = self.compile_attrs_internal(attrs, false);
                attr_blocks.insert(0, val);
            }
            let terse = self.terse;
            if attr_blocks.len() > 1 {
                let attrs_fn = self.runtime("attrs");
                let merge_fn = self.runtime("merge");
                let expr = format!("{attrs_fn}({merge_fn}([{}]), {terse})", attr_blocks.join(","));
                self.buffer_expression(&expr);
            } else {
                let attrs_fn = self.runtime("attrs");
                let expr = format!("{attrs_fn}({}, {terse})", attr_blocks[0]);
                self.buffer_expression(&expr);
            }
        } else if !attrs.is_empty() {
            self.compile_attrs_internal(attrs, true);
        }
    }

    fn compile_attrs_internal(&mut self, attrs: &[Attribute], buffer: bool) -> String {
        let terse = self.terse;
        let format = if buffer {
            AttrsFormat::Html
        } else {
            AttrsFormat::Object
        };
        let inline = self.options.inline_runtime_functions;
        let mut used = Vec::new();
        let res = compile_attrs(attrs, terse, format, |name| {
            if inline {
                used.push(name.to_string());
                format!("pug_{name}")
            } else {
                format!("pug.{name}")
            }
        });
        self.runtime_functions_used.extend(used);
        if buffer {
            self.buffer_expression(&res);
        }
        res
    }

    fn finish(self) -> Result<String, PugError> {
        let fn_name = if self.options.template_name.is_empty() {
            "template"
        } else {
            &self.options.template_name
        };

        let mut js = self.buf.join("\n");
        let mut globals = self.options.globals.clone();
        for &iv in INTERNAL_VARIABLES {
            globals.push(String::from(iv));
        }

        if self.options.use_self {
            js = format!("var self = locals || {{}};{js}");
        } else {
            let mut exclude = globals;
            for rf in &self.runtime_functions_used {
                exclude.push(format!("pug_{rf}"));
            }
            js = add_with_checked("locals || {}", &js, &exclude).map_err(|e| {
                PugError::new(
                    "SYNTAX_ERROR",
                    e.message,
                    ErrorOptions {
                        line: 1,
                        column: None,
                        filename: self.options.filename.clone(),
                        src: self.options.src.clone(),
                    },
                )
            })?;
        }

        if self.options.compile_debug {
            if let Some(ref sources_json) = self.options.debug_sources_json {
                js = format!("var pug_debug_sources = {sources_json};\n{js}");
            }
            let rethrow = if self.options.inline_runtime_functions {
                "pug_rethrow"
            } else {
                "pug.rethrow"
            };
            let src_arg = if self.options.debug_sources_json.is_some() {
                ", pug_debug_sources[pug_debug_filename]"
            } else {
                ""
            };
            js = format!(
                "var pug_debug_filename, pug_debug_line;try {{{js}}} catch (err) {{{rethrow}(err, pug_debug_filename, pug_debug_line{src_arg});}}"
            );
        }

        let runtime_prefix = pug_runtime::build(&self.runtime_functions_used);
        Ok(format!(
            "{runtime_prefix}function {fn_name}(locals) {{var pug_html = \"\", pug_mixins = {{}}, pug_interp;{js};return pug_html;}}"
        ))
    }
}

fn extract_attr_blocks(blocks: &[AttributeBlock]) -> Vec<String> {
    blocks.iter().map(|b| b.val.clone()).collect()
}

fn block_has_non_whitespace_content(block: &BlockNode) -> bool {
    block.nodes.iter().any(|node| match node {
        Node::Text(t) => !t.val.trim().is_empty(),
        _ => true,
    })
}

fn tag_can_inline(block: &BlockNode) -> bool {
    fn is_inline(node: &Node) -> bool {
        match node {
            Node::Block(b) => b.nodes.iter().all(is_inline),
            Node::YieldBlock(_) => true,
            Node::Text(t) => !t.val.contains('\n'),
            Node::Tag(t) => t.is_inline,
            Node::InterpolatedTag(t) => t.is_inline,
            Node::Code(c) => c.is_inline,
            _ => false,
        }
    }
    block.nodes.iter().all(is_inline)
}

fn node_line_and_filename(node: &Node) -> (usize, Option<&str>) {
    match node {
        Node::Block(n) => (n.line.unwrap_or(0), n.filename.as_deref()),
        Node::NamedBlock(n) => (n.line, n.filename.as_deref()),
        Node::Tag(n) => (n.line, n.filename.as_deref()),
        Node::InterpolatedTag(n) => (n.line, n.filename.as_deref()),
        Node::Text(n) => (n.line.unwrap_or(0), n.filename.as_deref()),
        Node::Code(n) => (n.line, n.filename.as_deref()),
        Node::Comment(n) => (n.line, n.filename.as_deref()),
        Node::BlockComment(n) => (n.line, n.filename.as_deref()),
        Node::Doctype(n) => (n.line, n.filename.as_deref()),
        Node::Filter(n) => (n.line, n.filename.as_deref()),
        Node::IncludeFilter(n) => (n.line, n.filename.as_deref()),
        Node::FileReference(n) => (n.line, n.filename.as_deref()),
        Node::Extends(n) => (n.line, n.filename.as_deref()),
        Node::Include(n) => (n.line, n.filename.as_deref()),
        Node::RawInclude(n) => (n.line, n.filename.as_deref()),
        Node::Case(n) => (n.line, n.filename.as_deref()),
        Node::When(n) => (n.line, n.filename.as_deref()),
        Node::Conditional(n) => (n.line, n.filename.as_deref()),
        Node::While(n) => (n.line, n.filename.as_deref()),
        Node::Each(n) => (n.line, n.filename.as_deref()),
        Node::EachOf(n) => (n.line, n.filename.as_deref()),
        Node::Mixin(n) => (n.line, n.filename.as_deref()),
        Node::MixinBlock(n) => (n.line, n.filename.as_deref()),
        Node::YieldBlock(n) => (n.line, n.filename.as_deref()),
        Node::Attrs(n) => (n.line, n.filename.as_deref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pug_ast::TagNode;

    fn make_html_br_ast(with_doctype: Option<Option<&str>>) -> BlockNode {
        let br_tag = Node::Tag(TagNode {
            name: String::from("br"),
            self_closing: false,
            block: BlockNode::empty(2, None),
            attrs: Vec::new(),
            attribute_blocks: Vec::new(),
            is_inline: false,
            code: None,
            text_only: None,
            line: 2,
            column: Some(3),
            filename: None,
        });
        let html_tag = Node::Tag(TagNode {
            name: String::from("html"),
            self_closing: false,
            block: BlockNode::new(2, vec![br_tag], None),
            attrs: Vec::new(),
            attribute_blocks: Vec::new(),
            is_inline: false,
            code: None,
            text_only: None,
            line: 1,
            column: Some(1),
            filename: None,
        });
        let mut nodes = Vec::new();
        if let Some(dt_val) = with_doctype {
            nodes.push(Node::Doctype(DoctypeNode {
                val: dt_val.map(String::from),
                line: 1,
                column: Some(1),
                filename: None,
            }));
        }
        nodes.push(html_tag);
        BlockNode::new(1, nodes, None)
    }

    fn compile_ast(ast: &BlockNode, doctype: Option<&str>) -> String {
        let opts = CodeGenOptions {
            doctype: doctype.map(String::from),
            ..CodeGenOptions::default()
        };
        generate_code(ast, &opts).unwrap()
    }

    #[test]
    fn test_doctype_and_html_tag_modes() {
        let html_only = compile_ast(&make_html_br_ast(None), None);
        assert!(!html_only.contains("!DOCTYPE html"));
        assert!(html_only.contains("\\u003Cbr\\u002F\\u003E"));

        let html_empty_dt = compile_ast(&make_html_br_ast(None), Some(""));
        assert!(!html_empty_dt.contains("!DOCTYPE"));
        assert!(html_empty_dt.contains("\\u003Cbr\\u002F\\u003E"));

        let bare_dt_none = compile_ast(&make_html_br_ast(Some(None)), None);
        assert!(bare_dt_none.contains("\\u003C!DOCTYPE html\\u003E"));
        assert!(bare_dt_none.contains("\\u003Cbr\\u003E"));

        let bare_dt_empty = compile_ast(&make_html_br_ast(Some(Some(""))), None);
        assert!(bare_dt_empty.contains("\\u003C!DOCTYPE html\\u003E"));
        assert!(bare_dt_empty.contains("\\u003Cbr\\u003E"));

        let bare_dt_with_xml_opt = compile_ast(&make_html_br_ast(Some(Some(""))), Some("xml"));
        assert!(bare_dt_with_xml_opt.contains("?xml version=\\\"1.0\\\" encoding=\\\"utf-8\\\" ?"));
        assert!(bare_dt_with_xml_opt.contains("\\u003Cbr\\u003E\\u003C\\u002Fbr\\u003E"));

        let explicit_dt_overrides_opt = compile_ast(&make_html_br_ast(Some(Some("html"))), Some("xml"));
        assert!(explicit_dt_overrides_opt.contains("\\u003C!DOCTYPE html\\u003E"));
        assert!(!explicit_dt_overrides_opt.contains("?xml"));
    }
}
