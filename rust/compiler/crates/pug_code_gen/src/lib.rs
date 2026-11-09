use pug_ast::{BlockNode, CodeNode, Node, TagNode};
use pug_attrs::compile_static_attrs;
use pug_error::PugError;
use pug_js::add_with;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Void elements matching `void-elements@3.1.0`.
pub const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "menuitem",
    "meta", "param", "source", "track", "wbr",
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
    pub template_name: String,
    pub filename: Option<String>,
}

/// Generates a JavaScript template function from a Pug `BlockNode` AST.
pub fn generate_code(ast: &BlockNode, options: &CodeGenOptions) -> Result<String, PugError> {
    let mut generator = CodeGenerator {
        options,
        buf: Vec::new(),
        runtime_fns: BTreeSet::new(),
    };
    generator.visit_block(ast);
    Ok(generator.finish())
}

struct CodeGenerator<'a> {
    options: &'a CodeGenOptions,
    buf: Vec<String>,
    runtime_fns: BTreeSet<String>,
}

impl<'a> CodeGenerator<'a> {
    fn runtime(&mut self, name: &str) -> String {
        if self.options.inline_runtime_functions {
            self.runtime_fns.insert(name.to_string());
            format!("pug_{name}")
        } else {
            format!("pug.{name}")
        }
    }

    fn push_html(&mut self, lit: &str) {
        let escaped = js_stringify_html(lit);
        self.buf.push(format!("pug_html = pug_html + {escaped};"));
    }

    fn push_debug(&mut self, line: usize, filename: Option<&str>) {
        if self.options.compile_debug && line > 0 {
            self.buf.push(format!("pug_debug_line = {line};"));
            if let Some(f) = filename {
                self.buf
                    .push(format!("pug_debug_filename = {};", js_stringify_html(f)));
            }
        }
    }

    fn visit_block(&mut self, block: &BlockNode) {
        for (i, node) in block.nodes.iter().enumerate() {
            if i > 0
                && matches!(block.nodes.get(i - 1), Some(Node::Text(_)))
                && matches!(node, Node::Text(_))
            {
                self.push_html("\n");
            }
            self.visit_node(node);
        }
    }

    fn visit_node(&mut self, node: &Node) {
        match node {
            Node::Block(b) => self.visit_block(b),
            Node::Tag(tag) => self.visit_tag(tag),
            Node::Text(text) => {
                self.push_html(&text.val);
            }
            Node::Code(code) => self.visit_code(code),
            Node::Comment(comment) => {
                if comment.buffer {
                    self.push_debug(comment.line, comment.filename.as_deref());
                    self.push_html(&format!("<!--{}-->", comment.val));
                }
            }
            Node::Filter(_) => {}
        }
    }

    fn visit_tag(&mut self, tag: &TagNode) {
        self.push_debug(tag.line, tag.filename.as_deref());
        let attr_str = compile_static_attrs(&tag.attrs);
        let is_void = VOID_ELEMENTS.contains(&tag.name.as_str()) || tag.self_closing;
        let is_terse = matches!(self.options.doctype.as_deref(), Some("html"));

        if is_void {
            let close = if is_terse && !tag.self_closing {
                ">"
            } else {
                "/>"
            };
            self.push_html(&format!("<{}{}{close}", tag.name, attr_str));
            return;
        }

        self.push_html(&format!("<{}{}>", tag.name, attr_str));
        if let Some(ref code) = tag.code {
            self.visit_code(code);
        }
        self.visit_block(&tag.block);
        self.push_html(&format!("</{}>", tag.name));
    }

    fn visit_code(&mut self, code: &CodeNode) {
        self.push_debug(code.line, code.filename.as_deref());
        if code.buffer {
            let val_expr = code.val.trim();
            let expr = if code.must_escape {
                let esc = self.runtime("escape");
                format!("{esc}(null == (pug_interp = {val_expr}) ? \"\" : pug_interp)")
            } else {
                format!("(null == (pug_interp = {val_expr}) ? \"\" : pug_interp)")
            };
            self.buf.push(format!("pug_html = pug_html + {expr};"));
        } else {
            self.buf.push(format!("{};", code.val));
        }
        if let Some(ref block) = code.block {
            self.visit_block(block);
        }
    }

    fn finish(mut self) -> String {
        let fn_name = if self.options.template_name.is_empty() {
            "template"
        } else {
            &self.options.template_name
        };

        let raw_inner = self.buf.join("\n");
        let scoped_body = if self.options.use_self {
            format!("var self = locals || {{}};\n{raw_inner}")
        } else {
            add_with("locals || {}", &raw_inner, &self.options.globals)
        };

        let full_fn = if self.options.compile_debug {
            let rethrow = self.runtime("rethrow");
            format!(
                "function {fn_name}(locals) {{var pug_html = \"\", pug_mixins = {{}}, pug_interp;;var pug_debug_filename, pug_debug_line;try {{\n{scoped_body}\n}} catch (err) {{{rethrow}(err, pug_debug_filename, pug_debug_line);}};return pug_html;}}"
            )
        } else {
            format!(
                "function {fn_name}(locals) {{var pug_html = \"\", pug_mixins = {{}}, pug_interp;{scoped_body};return pug_html;}}"
            )
        };

        if self.options.inline_runtime_functions && !self.runtime_fns.is_empty() {
            let fns: Vec<String> = self.runtime_fns.into_iter().collect();
            let runtime_prefix = pug_runtime::build(&fns);
            if runtime_prefix.is_empty() {
                full_fn
            } else {
                format!("{runtime_prefix}\n{full_fn}")
            }
        } else {
            full_fn
        }
    }
}

fn js_stringify_html(s: &str) -> String {
    let json = serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""));
    json.replace('<', "\\u003C")
        .replace('>', "\\u003E")
        .replace('/', "\\u002F")
}
