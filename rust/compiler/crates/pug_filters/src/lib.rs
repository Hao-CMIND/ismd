use pug_ast::{Attribute, BlockNode, Node, RawContent, TextNode};
use pug_error::{ErrorOptions, PugError};
use pug_js::{ConstEvalOutcome, ConstVal, eval_filter_constant};
use pug_walk::{ReplaceContext, WalkOptions, walk_ast};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct FilterAttrValue {
    pub name: String,
    /// `None` encodes an explicit JS `undefined` property value so `filterOptions` does not override it.
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterCallMode {
    /// `:filter` node or outer filters on `include:outer:inner path`.
    Text,
    /// Innermost (last in source syntax) filter on a `RawInclude`.
    RawFile,
}

pub struct FilterInvocation<'a> {
    pub filter_name: &'a str,
    pub unaliased_name: &'a str,
    pub mode: FilterCallMode,
    pub text: &'a str,
    pub raw: Option<&'a RawContent>,
    pub full_path: Option<&'a str>,
    pub attrs: &'a [FilterAttrValue],
    pub attrs_filename: Option<&'a str>,
    pub dir: Option<&'a str>,
    pub line: usize,
    pub column: Option<usize>,
    pub node_filename: Option<&'a str>,
}

pub trait FilterHost {
    fn run_filter(&mut self, call: &FilterInvocation<'_>) -> Result<String, PugError>;
}

impl<F> FilterHost for F
where
    F: FnMut(&FilterInvocation<'_>) -> Result<String, PugError>,
{
    fn run_filter(&mut self, call: &FilterInvocation<'_>) -> Result<String, PugError> {
        self(call)
    }
}

/// Processes `Node::Filter` and filtered `Node::RawInclude` nodes across the AST
/// (including loaded `Include` / `Extends` dependencies), matching `pug-filters@3.1.1`.
pub fn handle_filters<H: FilterHost + ?Sized>(
    ast: BlockNode,
    filter_options: &Value,
    filter_aliases: &HashMap<String, String>,
    host: &mut H,
) -> Result<BlockNode, PugError> {
    let pending_err: RefCell<Option<PugError>> = RefCell::new(None);

    let mut before = |node: &Node, ctx: &mut ReplaceContext, _parents: &[Node]| -> Result<bool, String> {
        let res: Result<Option<Node>, PugError> = (|| match node {
            Node::Filter(f) => {
                let mut f = f.clone();
                if matches!(f.block.nodes.first(), Some(Node::Filter(_))) {
                    let inner_block =
                        std::mem::replace(&mut f.block, BlockNode::empty(f.line, f.filename.clone()));
                    let processed =
                        handle_filters(inner_block, filter_options, filter_aliases, host)?;
                    f.block = processed;
                }

                let mut text = String::new();
                for child in &f.block.nodes {
                    if let Node::Text(t) = child {
                        text.push_str(&t.val);
                    }
                }

                let attrs = eval_filter_attrs(
                    &f.name,
                    &f.attrs,
                    f.line,
                    f.column,
                    f.filename.as_deref(),
                    filter_options,
                )?;
                let resolved_name = resolve_filter_alias(
                    &f.name,
                    filter_aliases,
                    f.line,
                    f.column,
                    f.filename.as_deref(),
                )?;
                let dir = f.filename.as_deref().map(node_dirname);

                let rendered = host.run_filter(&FilterInvocation {
                    filter_name: &resolved_name,
                    unaliased_name: &f.name,
                    mode: FilterCallMode::Text,
                    text: &text,
                    raw: None,
                    full_path: None,
                    attrs: &attrs,
                    attrs_filename: f.filename.as_deref(),
                    dir: dir.as_deref(),
                    line: f.line,
                    column: f.column,
                    node_filename: f.filename.as_deref(),
                })?;

                Ok(Some(Node::Text(TextNode {
                    val: rendered,
                    line: f.line,
                    column: f.column,
                    filename: f.filename,
                    is_html: None,
                })))
            }
            Node::RawInclude(raw_inc) if !raw_inc.filters.is_empty() => {
                let mut raw_inc = raw_inc.clone();
                let dir = raw_inc.filename.as_deref().map(node_dirname);
                let full_path = raw_inc.file.full_path.as_deref();
                let file_str = raw_inc.file.str.as_deref().unwrap_or("");

                let first = raw_inc
                    .filters
                    .pop()
                    .expect("non-empty filters checked above");
                let first_attrs = eval_filter_attrs(
                    &first.name,
                    &first.attrs,
                    first.line,
                    first.column,
                    first.filename.as_deref(),
                    filter_options,
                )?;
                let first_resolved = resolve_filter_alias(
                    &first.name,
                    filter_aliases,
                    first.line,
                    first.column,
                    first.filename.as_deref(),
                )?;

                let mut val = host.run_filter(&FilterInvocation {
                    filter_name: &first_resolved,
                    unaliased_name: &first.name,
                    mode: FilterCallMode::RawFile,
                    text: file_str,
                    raw: raw_inc.file.raw.as_ref(),
                    full_path,
                    attrs: &first_attrs,
                    attrs_filename: full_path,
                    dir: dir.as_deref(),
                    line: first.line,
                    column: first.column,
                    node_filename: first.filename.as_deref(),
                })?;

                for filt in raw_inc.filters.iter().rev() {
                    let attrs = eval_filter_attrs(
                        &filt.name,
                        &filt.attrs,
                        filt.line,
                        filt.column,
                        filt.filename.as_deref(),
                        filter_options,
                    )?;
                    let resolved = resolve_filter_alias(
                        &filt.name,
                        filter_aliases,
                        filt.line,
                        filt.column,
                        filt.filename.as_deref(),
                    )?;
                    val = host.run_filter(&FilterInvocation {
                        filter_name: &resolved,
                        unaliased_name: &filt.name,
                        mode: FilterCallMode::Text,
                        text: &val,
                        raw: None,
                        full_path: None,
                        attrs: &attrs,
                        attrs_filename: full_path,
                        dir: dir.as_deref(),
                        line: filt.line,
                        column: filt.column,
                        node_filename: filt.filename.as_deref(),
                    })?;
                }

                Ok(Some(Node::Text(TextNode {
                    val,
                    line: raw_inc.line,
                    column: raw_inc.column,
                    filename: raw_inc.filename,
                    is_html: None,
                })))
            }
            _ => Ok(None),
        })();

        match res {
            Ok(Some(replacement)) => {
                ctx.replace_single(replacement);
                Ok(true)
            }
            Ok(None) => Ok(true),
            Err(e) => {
                let msg = e.message.clone();
                *pending_err.borrow_mut() = Some(e);
                Err(msg)
            }
        }
    };
    let mut after = |_n: &Node, _c: &mut ReplaceContext, _p: &[Node]| -> Result<(), String> { Ok(()) };

    let mut parents = Vec::new();
    let walked = walk_ast(
        Node::Block(ast),
        &mut before,
        &mut after,
        &WalkOptions {
            include_dependencies: true,
        },
        &mut parents,
    );

    match walked {
        Ok(outcome) => outcome.into_block().map_err(PugError::host_exception),
        Err(msg) => Err(pending_err
            .into_inner()
            .unwrap_or_else(|| PugError::host_exception(msg))),
    }
}

fn eval_filter_attrs(
    node_name: &str,
    node_attrs: &[Attribute],
    line: usize,
    column: Option<usize>,
    filename: Option<&str>,
    filter_options: &Value,
) -> Result<Vec<FilterAttrValue>, PugError> {
    let mut out: Vec<FilterAttrValue> = Vec::new();

    for attr in node_attrs {
        let evaluated = match &attr.val {
            Value::Bool(true) => Some(Value::Bool(true)),
            Value::String(expr_src) => match eval_filter_constant(expr_src) {
                ConstEvalOutcome::Constant(ConstVal::Undefined) => None,
                ConstEvalOutcome::Constant(v) => Some(v.to_json_value()),
                ConstEvalOutcome::NotConstant => {
                    let quoted =
                        serde_json::to_string(expr_src).unwrap_or_else(|_| format!("\"{expr_src}\""));
                    return Err(PugError::new(
                        "FILTER_OPTION_NOT_CONSTANT",
                        format!(
                            "{quoted} is not constant. All filters are rendered compile-time so filter options must be constants."
                        ),
                        ErrorOptions {
                            line: line as i64,
                            column: column.map(|c| c as i64),
                            filename: filename.map(String::from),
                            src: None,
                        },
                    ));
                }
                ConstEvalOutcome::Unsupported(reason) => {
                    return Err(PugError::new(
                        "UNSUPPORTED_CONSTANT",
                        format!(
                            "Filter option `{expr_src}` uses an unsupported constant expression: {reason}"
                        ),
                        ErrorOptions {
                            line: line as i64,
                            column: column.map(|c| c as i64),
                            filename: filename.map(String::from),
                            src: None,
                        },
                    ));
                }
            },
            other => Some(other.clone()),
        };

        if let Some(existing) = out.iter_mut().find(|a| a.name == attr.name) {
            existing.value = evaluated;
        } else {
            out.push(FilterAttrValue {
                name: attr.name.clone(),
                value: evaluated,
            });
        }
    }

    if let Some(opts) = filter_options.get(node_name).and_then(Value::as_object) {
        for (k, v) in opts {
            if !out.iter().any(|a| &a.name == k) {
                out.push(FilterAttrValue {
                    name: k.clone(),
                    value: Some(v.clone()),
                });
            }
        }
    }

    Ok(out)
}

fn resolve_filter_alias(
    name: &str,
    aliases: &HashMap<String, String>,
    line: usize,
    column: Option<usize>,
    filename: Option<&str>,
) -> Result<String, PugError> {
    let Some(target) = aliases.get(name) else {
        return Ok(name.to_string());
    };
    if let Some(second) = aliases.get(target.as_str()) {
        return Err(PugError::new(
            "FILTER_ALISE_CHAIN",
            format!(
                "The filter \"{name}\" is an alias for \"{target}\", which is an alias for \"{second}\".  Pug does not support chains of filter aliases."
            ),
            ErrorOptions {
                line: line as i64,
                column: column.map(|c| c as i64),
                filename: filename.map(String::from),
                src: None,
            },
        ));
    }
    Ok(target.clone())
}

fn is_sep(c: char) -> bool {
    if cfg!(windows) {
        c == '/' || c == '\\'
    } else {
        c == '/'
    }
}

fn node_dirname(p: &str) -> String {
    if p.is_empty() {
        return String::from(".");
    }
    let chars: Vec<char> = p.chars().collect();
    let (root, rest) =
        if cfg!(windows) && chars.len() >= 2 && chars[1] == ':' && chars[0].is_ascii_alphabetic() {
            if chars.len() >= 3 && is_sep(chars[2]) {
                (format!("{}:{}", chars[0], '\\'), &p[3..])
            } else {
                (format!("{}:", chars[0]), &p[2..])
            }
        } else if !chars.is_empty() && is_sep(chars[0]) {
            (chars[0].to_string(), &p[1..])
        } else {
            (String::new(), p)
        };
    let trimmed = rest.trim_end_matches(is_sep);
    match trimmed.rfind(is_sep) {
        Some(idx) => {
            let dir = trimmed[..idx].trim_end_matches(is_sep);
            format!("{root}{dir}")
        }
        None => {
            if root.is_empty() {
                String::from(".")
            } else {
                root
            }
        }
    }
}

pub fn unknown_filter_error(
    name: &str,
    line: usize,
    column: Option<usize>,
    filename: Option<String>,
    src: Option<String>,
) -> PugError {
    PugError::new(
        "UNKNOWN_FILTER",
        format!("unknown filter \":{name}\""),
        ErrorOptions {
            line: line as i64,
            column: column.map(|c| c as i64),
            filename,
            src,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pug_ast::{FileReferenceNode, FilterNode, IncludeFilterNode, IncludeNode, RawIncludeNode};

    #[test]
    fn nested_filters_and_aliases_and_options_order() {
        let inner = Node::Filter(FilterNode {
            name: String::from("minify"),
            block: BlockNode::new(
                4,
                vec![Node::Text(TextNode {
                    val: String::from("code"),
                    line: 4,
                    column: Some(1),
                    filename: Some(String::from("dir/test.pug")),
                    is_html: None,
                })],
                Some(String::from("dir/test.pug")),
            ),
            attrs: vec![Attribute {
                name: String::from("inline"),
                val: Value::String(String::from("1 + 2")),
                must_escape: true,
                line: Some(3),
                column: Some(1),
                filename: None,
            }],
            line: 3,
            column: Some(9),
            filename: Some(String::from("dir/test.pug")),
        });
        let outer = Node::Filter(FilterNode {
            name: String::from("cdata"),
            block: BlockNode::new(3, vec![inner], Some(String::from("dir/test.pug"))),
            attrs: vec![],
            line: 3,
            column: Some(3),
            filename: Some(String::from("dir/test.pug")),
        });
        let ast = BlockNode::new(0, vec![outer], Some(String::from("dir/test.pug")));

        let filter_options = serde_json::json!({
            "minify": { "inline": 99, "beautify": true }
        });
        let mut aliases = HashMap::new();
        aliases.insert(String::from("minify"), String::from("uglify-js"));

        let mut calls = Vec::new();
        let out = handle_filters(ast, &filter_options, &aliases, &mut |call: &FilterInvocation| {
            calls.push((call.filter_name.to_string(), call.unaliased_name.to_string(), call.text.to_string()));
            if call.filter_name == "uglify-js" {
                assert!(call.attrs.contains(&FilterAttrValue {
                    name: String::from("inline"),
                    value: Some(Value::from(3)),
                }));
                assert!(call.attrs.contains(&FilterAttrValue {
                    name: String::from("beautify"),
                    value: Some(Value::Bool(true)),
                }));
                Ok(format!("MIN({})", call.text))
            } else {
                Ok(format!("<![CDATA[{}]]>", call.text))
            }
        })
        .unwrap();

        assert_eq!(
            calls,
            vec![
                (String::from("uglify-js"), String::from("minify"), String::from("code")),
                (String::from("cdata"), String::from("cdata"), String::from("MIN(code)")),
            ]
        );
        let Node::Text(t) = &out.nodes[0] else { panic!() };
        assert_eq!(t.val, "<![CDATA[MIN(code)]]>");
    }

    #[test]
    fn alias_chain_and_dynamic_option_errors_and_dependency_walk() {
        let dep_filter = Node::Filter(FilterNode {
            name: String::from("cdata"),
            block: BlockNode::empty(2, Some(String::from("dep.pug"))),
            attrs: vec![Attribute {
                name: String::from("opt"),
                val: Value::String(String::from("dynamicVar")),
                must_escape: true,
                line: Some(2),
                column: Some(1),
                filename: None,
            }],
            line: 2,
            column: Some(1),
            filename: Some(String::from("dep.pug")),
        });
        let mut fref = FileReferenceNode::new(String::from("dep.pug"), 1, Some(1), Some(String::from("main.pug")));
        fref.ast = Some(Box::new(BlockNode::new(0, vec![dep_filter], Some(String::from("dep.pug")))));
        let ast = BlockNode::new(
            0,
            vec![Node::Include(IncludeNode {
                file: fref,
                block: BlockNode::empty(1, None),
                line: 1,
                column: Some(1),
                filename: Some(String::from("main.pug")),
            })],
            Some(String::from("main.pug")),
        );

        let err = handle_filters(ast, &Value::Null, &HashMap::new(), &mut |_: &FilterInvocation| {
            Ok(String::new())
        })
        .unwrap_err();
        assert_eq!(err.code, "PUG:FILTER_OPTION_NOT_CONSTANT");
        assert_eq!(err.line, 2);
        assert_eq!(err.filename.as_deref(), Some("dep.pug"));

        let raw_inc = Node::RawInclude(RawIncludeNode {
            file: FileReferenceNode::new(String::from("a.coffee"), 1, Some(1), Some(String::from("main.pug"))),
            filters: vec![IncludeFilterNode {
                node_type: String::from("IncludeFilter"),
                name: String::from("a"),
                attrs: vec![],
                line: 1,
                column: Some(9),
                filename: Some(String::from("main.pug")),
            }],
            line: 1,
            column: Some(1),
            filename: Some(String::from("main.pug")),
        });
        let mut aliases = HashMap::new();
        aliases.insert(String::from("a"), String::from("b"));
        aliases.insert(String::from("b"), String::from("c"));
        let err = handle_filters(
            BlockNode::new(0, vec![raw_inc], None),
            &Value::Null,
            &aliases,
            &mut |_: &FilterInvocation| Ok(String::new()),
        )
        .unwrap_err();
        assert_eq!(err.code, "PUG:FILTER_ALISE_CHAIN");
    }
}
