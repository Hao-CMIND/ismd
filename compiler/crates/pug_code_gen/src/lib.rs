use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as _;

use pug_ast::{
    Attribute, AttributeBlock, BlockCommentNode, BlockNode, CaseNode, CodeNode, CommentNode,
    ConditionalNode, DoctypeNode, EachNode, EachOfNode, IncludeNode, InterpolatedTagNode,
    MixinNode, NamedBlockNode, Node, RawIncludeNode, TagNode, WhenNode, WhileNode,
};
use pug_attrs::{AttrsFormat, compile_attrs_fast};
use pug_error::{ErrorOptions, PugError};
use pug_js::{add_with_checked, eval_constant, push_js_string_inner};
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

/// Resolved immutable include view supplied by an AST overlay (`LinkedView`).
#[derive(Debug, Clone, Copy)]
pub struct IncludedView<'ast> {
    pub ast: &'ast BlockNode,
    pub has_yield: bool,
    pub default_yield_target_ptr: Option<usize>,
}

/// Read-only overlay supplying linked block overrides and resolved includes without cloning shared ASTs.
pub trait LinkedAstOverlay<'ast> {
    fn named_block_segments(&self, nb: &NamedBlockNode) -> Option<&[&'ast [Node]]>;
    fn is_named_block_ignored(&self, _nb: &NamedBlockNode) -> bool {
        false
    }
    fn resolve_include(&self, inc: &IncludeNode) -> Option<IncludedView<'ast>>;
    fn resolve_raw_include(&self, raw: &RawIncludeNode) -> Option<&'ast str>;
    fn prepended_mixins(&self) -> &[&'ast MixinNode] {
        &[]
    }
}

/// Generates a JavaScript template function from a Pug `BlockNode` AST.
pub fn generate_code(ast: &BlockNode, options: &CodeGenOptions) -> Result<String, PugError> {
    generate_code_inner(ast, options, None)
}

/// Generates a JavaScript template function from a shared immutable `BlockNode` AST and a [`LinkedAstOverlay`].
pub fn generate_code_with_overlay<'ast>(
    ast: &'ast BlockNode,
    options: &CodeGenOptions,
    overlay: &'ast dyn LinkedAstOverlay<'ast>,
) -> Result<String, PugError> {
    generate_code_inner(ast, options, Some(overlay))
}

fn generate_code_inner<'ast>(
    ast: &'ast BlockNode,
    options: &CodeGenOptions,
    overlay: Option<&'ast dyn LinkedAstOverlay<'ast>>,
) -> Result<String, PugError> {
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

    let mut runtime_functions_used: Vec<&'static str> = Vec::with_capacity(8);
    if options.compile_debug && options.inline_runtime_functions {
        runtime_functions_used.push("rethrow");
    }

    let mut generator = CodeGenerator {
        options,
        js: String::with_capacity(ast.nodes.len() * 128 + 256),
        runtime_functions_used,
        buffered_concatenation_count: 0,
        last_buffered_type: None,
        buffer_start_char: "\"",
        last_buffered: String::with_capacity(256),
        has_compiled_doctype: false,
        has_compiled_tag: false,
        indents: 0,
        parent_indents: 0,
        escape_pretty_mode: false,
        terse: false,
        xml: false,
        doctype: None,
        each_count: 0,
        mixins: HashMap::new(),
        dynamic_mixins: false,
        overlay,
        yield_stack: Vec::new(),
        default_yield_stack: Vec::new(),
    };

    if let Some(ref dt) = options.doctype
        && !dt.is_empty()
    {
        generator.set_doctype(dt);
    }
    if options.pretty.is_some() {
        generator.push_line("var pug_indent = [];");
    }

    if let Some(ov) = overlay {
        for mixin in ov.prepended_mixins() {
            generator.visit_mixin(mixin)?;
        }
    }
    generator.visit_block(ast)?;
    generator.finish()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BufferedType {
    Text,
    Code,
}

#[derive(Debug, Default)]
struct MixinEntry {
    used: bool,
    instances: Vec<(usize, usize)>,
}

#[inline]
fn inline_or_pug_runtime_name(inline: bool, name: &'static str) -> &'static str {
    if inline {
        match name {
            "attr" => "pug_attr",
            "attrs" => "pug_attrs",
            "classes" => "pug_classes",
            "classes_array" => "pug_classes_array",
            "classes_object" => "pug_classes_object",
            "escape" => "pug_escape",
            "has_own_property" => "pug_has_own_property",
            "match_html" => "pug_match_html",
            "merge" => "pug_merge",
            "rethrow" => "pug_rethrow",
            "style" => "pug_style",
            _ => "pug_unknown",
        }
    } else {
        match name {
            "attr" => "pug.attr",
            "attrs" => "pug.attrs",
            "classes" => "pug.classes",
            "classes_array" => "pug.classes_array",
            "classes_object" => "pug.classes_object",
            "escape" => "pug.escape",
            "has_own_property" => "pug.has_own_property",
            "match_html" => "pug.match_html",
            "merge" => "pug.merge",
            "rethrow" => "pug.rethrow",
            "style" => "pug.style",
            _ => "pug.unknown",
        }
    }
}

struct CodeGenerator<'a, 'opt> {
    options: &'opt CodeGenOptions,
    js: String,
    runtime_functions_used: Vec<&'static str>,
    buffered_concatenation_count: usize,
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
    mixins: HashMap<String, MixinEntry>,
    dynamic_mixins: bool,
    overlay: Option<&'a dyn LinkedAstOverlay<'a>>,
    yield_stack: Vec<&'a BlockNode>,
    default_yield_stack: Vec<(usize, &'a BlockNode)>,
}

impl<'a, 'opt> CodeGenerator<'a, 'opt> {
    #[inline]
    fn record_runtime(&mut self, name: &'static str) {
        if !self.runtime_functions_used.contains(&name) {
            self.runtime_functions_used.push(name);
        }
    }

    fn runtime(&mut self, name: &'static str) -> &'static str {
        if self.options.inline_runtime_functions {
            self.record_runtime(name);
        }
        inline_or_pug_runtime_name(self.options.inline_runtime_functions, name)
    }

    fn flush_buffered(&mut self) {
        let Some(kind) = self.last_buffered_type.take() else {
            return;
        };
        if !self.js.is_empty() {
            self.js.push('\n');
        }
        self.js.push_str("pug_html = pug_html + ");
        match kind {
            BufferedType::Text => {
                self.js.push_str(self.buffer_start_char);
                self.js.push_str(&self.last_buffered);
                self.js.push_str("\";");
            }
            BufferedType::Code => {
                if self.buffered_concatenation_count == 0 && self.buffer_start_char.is_empty() {
                    self.js.push_str(&self.last_buffered);
                    self.js.push(';');
                } else {
                    self.js.push('(');
                    self.js.push_str(self.buffer_start_char);
                    self.js.push_str(&self.last_buffered);
                    self.js.push_str(");");
                }
            }
        }
        self.last_buffered.clear();
    }

    #[inline]
    fn start_line(&mut self) {
        self.flush_buffered();
        if !self.js.is_empty() {
            self.js.push('\n');
        }
    }

    #[inline]
    fn push_line(&mut self, line: &str) {
        self.start_line();
        self.js.push_str(line);
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
                "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML Basic 1.1//EN\" \"http://www.openmobilealliance.org/tech/DTD/xhtml-basic11.dtd\">",
            ),
            "mobile" => String::from(
                "<!DOCTYPE html PUBLIC \"-//WAPFORUM//DTD XHTML Mobile 1.2//EN\" \"http://www.openmobilealliance.org/tech/DTD/xhtml-mobile12.dtd\">",
            ),
            "plist" => String::from(
                "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
            ),
            _ => format!("<!DOCTYPE {name}>"),
        };
        self.terse = dt.eq_ignore_ascii_case("<!doctype html>");
        self.xml = dt.starts_with("<?xml");
        self.doctype = Some(dt);
    }

    fn buffer(&mut self, s: &str) {
        if self.last_buffered_type.is_some() && self.buffered_concatenation_count < 100 {
            if self.last_buffered_type == Some(BufferedType::Code) {
                self.last_buffered.push_str(" + \"");
                self.buffered_concatenation_count += 1;
            }
            self.last_buffered_type = Some(BufferedType::Text);
            push_js_string_inner(&mut self.last_buffered, s);
        } else {
            self.flush_buffered();
            self.buffered_concatenation_count = 0;
            self.last_buffered_type = Some(BufferedType::Text);
            self.buffer_start_char = "\"";
            self.last_buffered.clear();
            push_js_string_inner(&mut self.last_buffered, s);
        }
    }

    fn buffer_expression(&mut self, src: &str) {
        if let Some(cval) = eval_constant(src) {
            self.buffer(&cval.to_js_string());
            return;
        }
        if self.last_buffered_type.is_some() && self.buffered_concatenation_count < 100 {
            self.buffered_concatenation_count += 1;
            if self.last_buffered_type == Some(BufferedType::Text) {
                self.last_buffered.push('"');
            }
            self.last_buffered_type = Some(BufferedType::Code);
            self.last_buffered.push_str(" + (");
            self.last_buffered.push_str(src);
            self.last_buffered.push(')');
        } else {
            self.flush_buffered();
            self.buffered_concatenation_count = 0;
            self.last_buffered_type = Some(BufferedType::Code);
            self.buffer_start_char = "";
            self.last_buffered.clear();
            self.last_buffered.push('(');
            self.last_buffered.push_str(src);
            self.last_buffered.push(')');
        }
    }

    fn pretty_indent(&mut self, offset: usize, newline: bool) {
        let Some(ref pp) = self.options.pretty else {
            return;
        };
        let count = (self.indents + offset).saturating_sub(1);
        if newline {
            self.buffer("\n");
        }
        for _ in 0..count {
            self.buffer(pp);
        }
        if self.parent_indents > 0 {
            self.push_line("pug_html = pug_html + pug_indent.join(\"\");");
        }
    }

    fn emit_debug_if_needed(&mut self, node: &Node) {
        if !self.options.compile_debug
            || matches!(node, Node::Block(_) | Node::When(_))
            || (self.overlay.is_some()
                && matches!(
                    node,
                    Node::Include(_) | Node::YieldBlock(_) | Node::RawInclude(_)
                ))
        {
            return;
        }
        if let Node::Code(c) = node
            && c.debug == Some(false)
        {
            return;
        }
        let (line, filename) = node_line_and_filename(node);
        if line > 0 {
            self.start_line();
            let _ = write!(self.js, ";pug_debug_line = {line}");
            if let Some(f) = filename {
                self.js.push_str(";pug_debug_filename = \"");
                push_js_string_inner(&mut self.js, f);
                self.js.push('"');
            }
            self.js.push(';');
        }
    }

    fn visit(&mut self, node: &'a Node) -> Result<(), PugError> {
        self.emit_debug_if_needed(node);
        self.visit_node(node)
    }

    fn visit_node(&mut self, node: &'a Node) -> Result<(), PugError> {
        match node {
            Node::Block(b) => self.visit_block(b),
            Node::NamedBlock(nb) => {
                if let Some(ov) = self.overlay {
                    if ov.is_named_block_ignored(nb) {
                        return Ok(());
                    }
                    if let Some(segments) = ov.named_block_segments(nb) {
                        for seg in segments {
                            self.visit_nodes(seg)?;
                        }
                        return Ok(());
                    }
                }
                self.visit_nodes(&nb.nodes)
            }
            Node::Include(inc) if self.overlay.is_some() => {
                if let Some(ov) = self.overlay
                    && let Some(inc_view) = ov.resolve_include(inc)
                {
                    if inc.block.nodes.is_empty() {
                        return self.visit_block(inc_view.ast);
                    }
                    if inc_view.has_yield {
                        self.yield_stack.push(&inc.block);
                        let res = self.visit_block(inc_view.ast);
                        self.yield_stack.pop();
                        return res;
                    }
                    if let Some(target_ptr) = inc_view.default_yield_target_ptr {
                        self.default_yield_stack.push((target_ptr, &inc.block));
                        let res = self.visit_block(inc_view.ast);
                        self.default_yield_stack.pop();
                        return res;
                    }
                    return self.visit_block(inc_view.ast);
                }
                Ok(())
            }
            Node::RawInclude(raw) if self.overlay.is_some() => {
                if let Some(ov) = self.overlay
                    && let Some(text) = ov.resolve_raw_include(raw)
                {
                    self.buffer(text);
                }
                Ok(())
            }
            Node::YieldBlock(_) => {
                if let Some(yb) = self.yield_stack.last().copied() {
                    self.visit_block(yb)
                } else {
                    Ok(())
                }
            }
            Node::MixinBlock(_) => {
                self.visit_mixin_block();
                Ok(())
            }
            Node::Mixin(m) => self.visit_mixin(m),
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

    fn visit_block(&mut self, block: &'a BlockNode) -> Result<(), PugError> {
        self.visit_nodes(&block.nodes)?;
        if !self.default_yield_stack.is_empty() {
            let ptr = (block as *const BlockNode) as usize;
            if self
                .default_yield_stack
                .last()
                .is_some_and(|(target, _)| *target == ptr)
            {
                let popped = self.default_yield_stack.pop().unwrap();
                let res = self.visit_block(popped.1);
                self.default_yield_stack.push(popped);
                res?;
            }
        }
        Ok(())
    }

    fn visit_mixin_block(&mut self) {
        if let Some(ref pp) = self.options.pretty {
            let indents = self.indents;
            let s = pp.repeat(indents);
            self.start_line();
            self.js.push_str("pug_indent.push(\"");
            push_js_string_inner(&mut self.js, &s);
            self.js.push_str("\");");
        }
        self.push_line("block && block();");
        if self.options.pretty.is_some() {
            self.push_line("pug_indent.pop();");
        }
    }

    fn visit_mixin(&mut self, mixin: &'a MixinNode) -> Result<(), PugError> {
        let dynamic = mixin.name.starts_with('#');
        if dynamic {
            self.dynamic_mixins = true;
        }
        let name_expr = if dynamic && mixin.name.len() >= 3 {
            &mixin.name[2..mixin.name.len() - 1]
        } else {
            &mixin.name
        };
        let args = mixin.args.as_deref().unwrap_or("");
        let entry = self.mixins.entry(mixin.name.clone()).or_default();

        if mixin.call {
            entry.used = true;
            if let Some(ref pp) = self.options.pretty {
                let s = pp.repeat(self.indents);
                self.start_line();
                self.js.push_str("pug_indent.push(\"");
                push_js_string_inner(&mut self.js, &s);
                self.js.push_str("\");");
            }
            let attrs = mixin.attrs.as_deref().unwrap_or(&[]);
            let attr_blocks = mixin.attribute_blocks.as_deref().unwrap_or(&[]);

            if mixin.block.is_some() || !attrs.is_empty() || !attr_blocks.is_empty() {
                self.start_line();
                if dynamic && mixin.name.len() >= 3 {
                    let _ = write!(self.js, "pug_mixins[{name_expr}].call({{");
                } else {
                    let _ = write!(self.js, "pug_mixins[\"{name_expr}\"].call({{");
                }

                if let Some(ref block) = mixin.block {
                    self.push_line("block: function(){");
                    self.parent_indents += 1;
                    let saved_indents = self.indents;
                    self.indents = 0;
                    self.visit_block(block)?;
                    self.indents = saved_indents;
                    self.parent_indents -= 1;

                    if !attrs.is_empty() || !attr_blocks.is_empty() {
                        self.push_line("},");
                    } else {
                        self.push_line("}");
                    }
                }

                if !attr_blocks.is_empty() {
                    let has_attrs = !attrs.is_empty();
                    let val = if has_attrs {
                        Some(self.compile_attrs_internal(attrs, false))
                    } else {
                        None
                    };
                    let total_blocks = attr_blocks.len() + usize::from(has_attrs);
                    if total_blocks > 1 {
                        let merge_fn = self.runtime("merge");
                        self.start_line();
                        self.js.push_str("attributes: ");
                        self.js.push_str(merge_fn);
                        self.js.push_str("([");
                        let mut first = true;
                        if let Some(ref v) = val {
                            self.js.push_str(v);
                            first = false;
                        }
                        for ab in attr_blocks {
                            if !first {
                                self.js.push(',');
                            }
                            first = false;
                            self.js.push_str(&ab.val);
                        }
                        self.js.push_str("])");
                    } else if let Some(ref v) = val {
                        self.start_line();
                        self.js.push_str("attributes: ");
                        self.js.push_str(v);
                    } else {
                        self.start_line();
                        self.js.push_str("attributes: ");
                        self.js.push_str(&attr_blocks[0].val);
                    }
                } else if !attrs.is_empty() {
                    let val = self.compile_attrs_internal(attrs, false);
                    self.start_line();
                    self.js.push_str("attributes: ");
                    self.js.push_str(&val);
                }

                if !args.is_empty() {
                    self.start_line();
                    let _ = write!(self.js, "}}, {args});");
                } else {
                    self.push_line("});");
                }
            } else {
                self.start_line();
                if dynamic && mixin.name.len() >= 3 {
                    let _ = write!(self.js, "pug_mixins[{name_expr}]({args});");
                } else {
                    let _ = write!(self.js, "pug_mixins[\"{name_expr}\"]({args});");
                }
            }

            if self.options.pretty.is_some() {
                self.push_line("pug_indent.pop();");
            }
        } else {
            self.flush_buffered();
            let mixin_start = self.js.len();
            let mut arg_parts: Vec<&str> = if args.is_empty() {
                Vec::new()
            } else {
                args.split(',').collect()
            };
            let mut rest: Option<&str> = None;
            if let Some(last) = arg_parts.last()
                && let Some(stripped) = last.trim().strip_prefix("...")
            {
                rest = Some(stripped);
                arg_parts.pop();
            }

            self.start_line();
            if dynamic && mixin.name.len() >= 3 {
                let _ = write!(self.js, "pug_mixins[{name_expr}] = pug_interp = function(");
            } else {
                let _ = write!(self.js, "pug_mixins[\"{name_expr}\"] = pug_interp = function(");
            }
            for (i, part) in arg_parts.iter().enumerate() {
                if i > 0 {
                    self.js.push(',');
                }
                self.js.push_str(part);
            }
            self.js.push_str("){");
            self.push_line(
                "var block = (this && this.block), attributes = (this && this.attributes) || {};",
            );
            if let Some(rest_name) = rest {
                self.start_line();
                let _ = write!(self.js, "var {rest_name} = [];");
                self.start_line();
                let _ = write!(
                    self.js,
                    "for (pug_interp = {}; pug_interp < arguments.length; pug_interp++) {{",
                    arg_parts.len()
                );
                self.start_line();
                let _ = write!(self.js, "  {rest_name}.push(arguments[pug_interp]);");
                self.push_line("}");
            }

            self.parent_indents += 1;
            if let Some(ref block) = mixin.block {
                self.visit_block(block)?;
            }
            self.parent_indents -= 1;
            self.push_line("};");
            let mixin_end = self.js.len();
            self.mixins
                .entry(mixin.name.clone())
                .or_default()
                .instances
                .push((mixin_start, mixin_end));
        }

        Ok(())
    }

    fn visit_nodes(&mut self, nodes: &'a [Node]) -> Result<(), PugError> {
        let has_pp = self.options.pretty.is_some();
        let overlay = self.overlay;
        let text_val = |n: &'a Node| -> Option<&'a str> {
            match n {
                Node::Text(t) => Some(&t.val),
                Node::RawInclude(raw) => overlay.and_then(|ov| ov.resolve_raw_include(raw)),
                _ => None,
            }
        };
        if has_pp
            && nodes.len() > 1
            && !self.escape_pretty_mode
            && nodes.first().and_then(text_val).is_some()
            && nodes.get(1).and_then(text_val).is_some()
        {
            self.pretty_indent(1, true);
        }

        for (i, node) in nodes.iter().enumerate() {
            if has_pp
                && i > 0
                && !self.escape_pretty_mode
                && let (Some(prev), Some(_)) =
                    (nodes.get(i - 1).and_then(text_val), text_val(node))
                && prev.ends_with('\n')
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

    fn visit_tag(&mut self, tag: &'a TagNode) -> Result<(), PugError> {
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
            self.visit_attributes(&tag.attrs, &tag.attribute_blocks);
            if self.terse && !tag.self_closing {
                self.buffer(">");
            } else {
                self.buffer("/>");
            }
            if tag.code.is_some()
                || block_has_non_whitespace_content(&tag.block, self.overlay)
            {
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
            self.visit_attributes(&tag.attrs, &tag.attribute_blocks);
            self.buffer(">");
            if let Some(ref code) = tag.code {
                self.visit_code(code)?;
            }
            self.visit_block(&tag.block)?;

            if has_pp
                && !tag.is_inline
                && !is_ws_sensitive
                && !tag_can_inline(&tag.block, self.overlay, self.yield_stack.last().copied())
            {
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

    fn visit_interpolated_tag(&mut self, tag: &'a InterpolatedTagNode) -> Result<(), PugError> {
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
            self.visit_attributes(&tag.attrs, &tag.attribute_blocks);
            if self.terse && !tag.self_closing {
                self.buffer(">");
            } else {
                self.buffer("/>");
            }
            if tag.code.is_some()
                || block_has_non_whitespace_content(&tag.block, self.overlay)
            {
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
            self.visit_attributes(&tag.attrs, &tag.attribute_blocks);
            self.buffer(">");
            if let Some(ref code) = tag.code {
                self.visit_code(code)?;
            }
            self.visit_block(&tag.block)?;

            if has_pp
                && !tag.is_inline
                && !tag_can_inline(&tag.block, self.overlay, self.yield_stack.last().copied())
            {
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
        self.buffer("<!--");
        self.buffer(&comment.val);
        self.buffer("-->");
        Ok(())
    }

    fn visit_block_comment(&mut self, comment: &'a BlockCommentNode) -> Result<(), PugError> {
        if !comment.buffer {
            return Ok(());
        }
        if self.options.pretty.is_some() {
            self.pretty_indent(1, true);
        }
        self.buffer("<!--");
        self.buffer(&comment.val);
        self.visit_block(&comment.block)?;
        if self.options.pretty.is_some() {
            self.pretty_indent(1, true);
        }
        self.buffer("-->");
        Ok(())
    }

    fn visit_code(&mut self, code: &'a CodeNode) -> Result<(), PugError> {
        if code.buffer {
            let val = code.val.trim();
            let mut expr = String::with_capacity(val.len() + 48);
            if code.must_escape {
                let esc = self.runtime("escape");
                let _ = write!(expr, "{esc}(null == (pug_interp = {val}) ? \"\" : pug_interp)");
            } else {
                let _ = write!(expr, "null == (pug_interp = {val}) ? \"\" : pug_interp");
            }
            self.buffer_expression(&expr);
        } else {
            self.push_line(&code.val);
        }

        if let Some(ref block) = code.block {
            if !code.buffer {
                self.push_line("{");
            }
            self.visit_block(block)?;
            if !code.buffer {
                self.push_line("}");
            }
        }
        Ok(())
    }

    fn visit_conditional(&mut self, cond: &'a ConditionalNode) -> Result<(), PugError> {
        self.start_line();
        let _ = write!(self.js, "if ({}) {{", cond.test);
        self.visit_block(&cond.consequent)?;
        self.push_line("}");
        if let Some(ref alt) = cond.alternate {
            match alt.as_ref() {
                Node::Conditional(elif) => {
                    self.push_line("else");
                    self.visit_conditional(elif)?;
                }
                Node::Block(b) => {
                    self.push_line("else {");
                    self.visit_block(b)?;
                    self.push_line("}");
                }
                other => {
                    self.push_line("else {");
                    self.visit(other)?;
                    self.push_line("}");
                }
            }
        }
        Ok(())
    }

    fn visit_while(&mut self, loop_node: &'a WhileNode) -> Result<(), PugError> {
        self.start_line();
        let _ = write!(self.js, "while ({}) {{", loop_node.test);
        self.visit_block(&loop_node.block)?;
        self.push_line("}");
        Ok(())
    }

    fn visit_each(&mut self, each: &'a EachNode) -> Result<(), PugError> {
        let count = self.each_count;
        self.each_count += 1;

        self.start_line();
        let _ = write!(
            self.js,
            "// iterate {}\n;(function(){{\n  var $$obj = {};\n  if ('number' == typeof $$obj.length) {{",
            each.obj, each.obj
        );

        if each.alternate.is_some() {
            self.push_line("    if ($$obj.length) {");
        }

        self.start_line();
        if let Some(ref k) = each.key {
            let _ = write!(
                self.js,
                "      for (var {k} = 0, $$l = $$obj.length; {k} < $$l; {k}++) {{\n        var {} = $$obj[{k}];",
                each.val
            );
        } else {
            let _ = write!(
                self.js,
                "      for (var pug_index{count} = 0, $$l = $$obj.length; pug_index{count} < $$l; pug_index{count}++) {{\n        var {} = $$obj[pug_index{count}];",
                each.val
            );
        }

        self.visit_block(&each.block)?;
        self.push_line("      }");

        if let Some(ref alt) = each.alternate {
            self.push_line("    } else {");
            self.visit_block(alt)?;
            self.push_line("    }");
        }

        self.start_line();
        if let Some(ref k) = each.key {
            let _ = write!(
                self.js,
                "  }} else {{\n    var $$l = 0;\n    for (var {k} in $$obj) {{\n      $$l++;\n      var {} = $$obj[{k}];",
                each.val
            );
        } else {
            let _ = write!(
                self.js,
                "  }} else {{\n    var $$l = 0;\n    for (var pug_index{count} in $$obj) {{\n      $$l++;\n      var {} = $$obj[pug_index{count}];",
                each.val
            );
        }

        self.visit_block(&each.block)?;
        self.push_line("    }");

        if let Some(ref alt) = each.alternate {
            self.push_line("    if ($$l === 0) {");
            self.visit_block(alt)?;
            self.push_line("    }");
        }

        self.push_line("  }\n}).call(this);\n");
        Ok(())
    }

    fn visit_each_of(&mut self, each: &'a EachOfNode) -> Result<(), PugError> {
        self.start_line();
        let _ = write!(
            self.js,
            "// iterate {}\nfor (const {} of {}) {{\n",
            each.obj, each.val, each.obj
        );
        self.visit_block(&each.block)?;
        self.push_line("}\n");
        Ok(())
    }

    fn visit_case(&mut self, case_node: &'a CaseNode) -> Result<(), PugError> {
        self.start_line();
        let _ = write!(self.js, "switch ({}){{", case_node.expr);
        self.visit_block(&case_node.block)?;
        self.push_line("}");
        Ok(())
    }

    fn visit_when(&mut self, when_node: &'a WhenNode) -> Result<(), PugError> {
        if when_node.expr == "default" {
            self.push_line("default:");
        } else {
            self.start_line();
            let _ = write!(self.js, "case {}:", when_node.expr);
        }
        if let Some(ref block) = when_node.block {
            self.visit_block(block)?;
            self.push_line("  break;");
        }
        Ok(())
    }

    fn visit_attributes(&mut self, attrs: &[Attribute], attr_blocks: &[AttributeBlock]) {
        if !attr_blocks.is_empty() {
            let has_attrs = !attrs.is_empty();
            let val = if has_attrs {
                Some(self.compile_attrs_internal(attrs, false))
            } else {
                None
            };
            let terse = self.terse;
            let total_blocks = attr_blocks.len() + usize::from(has_attrs);
            if total_blocks > 1 {
                let attrs_fn = self.runtime("attrs");
                let merge_fn = self.runtime("merge");
                let mut expr = String::with_capacity(64);
                expr.push_str(attrs_fn);
                expr.push('(');
                expr.push_str(merge_fn);
                expr.push_str("([");
                let mut first = true;
                if let Some(ref v) = val {
                    expr.push_str(v);
                    first = false;
                }
                for ab in attr_blocks {
                    if !first {
                        expr.push(',');
                    }
                    first = false;
                    expr.push_str(&ab.val);
                }
                let _ = write!(expr, "]), {terse})");
                self.buffer_expression(&expr);
            } else {
                let attrs_fn = self.runtime("attrs");
                let block_expr = val.as_deref().unwrap_or_else(|| &attr_blocks[0].val);
                let mut expr = String::with_capacity(attrs_fn.len() + block_expr.len() + 12);
                let _ = write!(expr, "{attrs_fn}({block_expr}, {terse})");
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
        let mut used: Vec<&'static str> = Vec::new();
        let res = compile_attrs_fast(attrs, terse, format, |name| {
            if inline && !used.contains(&name) {
                used.push(name);
            }
            Cow::Borrowed(inline_or_pug_runtime_name(inline, name))
        });
        for name in used {
            self.record_runtime(name);
        }
        if buffer {
            self.buffer_expression(&res);
        }
        res
    }

    fn finish(mut self) -> Result<String, PugError> {
        let fn_name = if self.options.template_name.is_empty() {
            "template"
        } else {
            &self.options.template_name
        };

        self.flush_buffered();

        let mut js = if !self.dynamic_mixins {
            let mut dead_ranges: Vec<(usize, usize)> = Vec::new();
            for entry in self.mixins.values() {
                if !entry.used {
                    dead_ranges.extend_from_slice(&entry.instances);
                }
            }
            if dead_ranges.is_empty() {
                std::mem::take(&mut self.js)
            } else {
                dead_ranges.sort_unstable_by_key(|r| r.0);
                let mut filtered = String::with_capacity(self.js.len());
                let mut cursor = 0;
                for (start, end) in dead_ranges {
                    if start > cursor {
                        filtered.push_str(&self.js[cursor..start]);
                    }
                    let slice_start = start.max(cursor);
                    if end > slice_start {
                        let nl_count = self.js[slice_start..end]
                            .bytes()
                            .filter(|&b| b == b'\n')
                            .count();
                        for _ in 0..nl_count {
                            filtered.push('\n');
                        }
                    }
                    cursor = cursor.max(end);
                }
                if cursor < self.js.len() {
                    filtered.push_str(&self.js[cursor..]);
                }
                filtered
            }
        } else {
            std::mem::take(&mut self.js)
        };

        if self.options.use_self {
            let mut prefixed = String::with_capacity(js.len() + 24);
            prefixed.push_str("var self = locals || {};");
            prefixed.push_str(&js);
            js = prefixed;
        } else {
            let mut exclude = Vec::with_capacity(
                self.options.globals.len()
                    + INTERNAL_VARIABLES.len()
                    + self.runtime_functions_used.len(),
            );
            exclude.extend(self.options.globals.iter().cloned());
            for &iv in INTERNAL_VARIABLES {
                exclude.push(String::from(iv));
            }
            for &rf in &self.runtime_functions_used {
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

        let runtime_prefix = {
            let _prof_rt = pug_ast::profile::scope(pug_ast::profile::Stage::RuntimeBuild);
            pug_runtime::build(&self.runtime_functions_used)
        };

        let sources_json = if self.options.compile_debug {
            self.options.debug_sources_json.as_deref()
        } else {
            None
        };
        let extra = runtime_prefix.len()
            + fn_name.len()
            + js.len()
            + sources_json.map_or(0, |s| s.len() + 26)
            + 200;
        let mut out = String::with_capacity(extra);
        out.push_str(&runtime_prefix);
        let _ = write!(
            out,
            "function {fn_name}(locals) {{var pug_html = \"\", pug_mixins = {{}}, pug_interp;"
        );
        if self.options.compile_debug {
            let rethrow = if self.options.inline_runtime_functions {
                "pug_rethrow"
            } else {
                "pug.rethrow"
            };
            out.push_str("var pug_debug_filename, pug_debug_line;try {");
            if let Some(sj) = sources_json {
                let _ = write!(out, "var pug_debug_sources = {sj};\n");
            }
            out.push_str(&js);
            let _ = write!(
                out,
                "}} catch (err) {{{rethrow}(err, pug_debug_filename, pug_debug_line{});}}",
                if sources_json.is_some() {
                    ", pug_debug_sources[pug_debug_filename]"
                } else {
                    ""
                }
            );
        } else {
            out.push_str(&js);
        }
        out.push_str(";return pug_html;}");
        Ok(out)
    }
}

fn block_has_non_whitespace_content<'a>(
    block: &BlockNode,
    overlay: Option<&dyn LinkedAstOverlay<'a>>,
) -> bool {
    block.nodes.iter().any(|node| match node {
        Node::Text(t) => !t.val.trim().is_empty(),
        Node::RawInclude(raw) => overlay
            .and_then(|ov| ov.resolve_raw_include(raw))
            .is_none_or(|t| !t.trim().is_empty()),
        _ => true,
    })
}

fn tag_can_inline<'a>(
    block: &BlockNode,
    overlay: Option<&dyn LinkedAstOverlay<'a>>,
    yield_block: Option<&BlockNode>,
) -> bool {
    fn is_inline<'a>(
        node: &Node,
        overlay: Option<&dyn LinkedAstOverlay<'a>>,
        yield_block: Option<&BlockNode>,
    ) -> bool {
        match node {
            Node::Block(b) => b.nodes.iter().all(|n| is_inline(n, overlay, yield_block)),
            Node::YieldBlock(_) => yield_block
                .is_none_or(|yb| yb.nodes.iter().all(|n| is_inline(n, overlay, None))),
            Node::Text(t) => !t.val.contains('\n'),
            Node::RawInclude(raw) => overlay
                .and_then(|ov| ov.resolve_raw_include(raw))
                .is_some_and(|t| !t.contains('\n')),
            Node::Include(inc) => overlay
                .and_then(|ov| ov.resolve_include(inc))
                .is_some_and(|view| {
                    let next_yield = if inc.block.nodes.is_empty() {
                        None
                    } else {
                        Some(&inc.block)
                    };
                    view.ast
                        .nodes
                        .iter()
                        .all(|n| is_inline(n, overlay, next_yield))
                }),
            Node::Tag(t) => t.is_inline,
            Node::InterpolatedTag(t) => t.is_inline,
            Node::Code(c) => c.is_inline,
            _ => false,
        }
    }
    block.nodes.iter().all(|n| is_inline(n, overlay, yield_block))
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
        Node::Extension(n) => (n.line, n.filename.as_deref()),
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
