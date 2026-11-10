use pug_ast::{BlockNode, Node, TextNode};
use pug_error::{ErrorOptions, PugError};
use serde_json::{Map, Value};

/// Processes `Node::Filter` nodes by invoking the synchronous host filter callback
/// (expanded with nested filters, `filterOptions`, `filterAliases`, and JSTransformer fallback in Step 4).
pub fn handle_filters<F>(mut ast: BlockNode, mut run_filter: F) -> Result<BlockNode, PugError>
where
    F: FnMut(&str, &str, &Value, usize, Option<&str>) -> Result<String, PugError>,
{
    process_block(&mut ast, &mut run_filter)?;
    Ok(ast)
}

fn process_block<F>(block: &mut BlockNode, run_filter: &mut F) -> Result<(), PugError>
where
    F: FnMut(&str, &str, &Value, usize, Option<&str>) -> Result<String, PugError>,
{
    for node in &mut block.nodes {
        match node {
            Node::Block(b) => process_block(b, run_filter)?,
            Node::Tag(t) => process_block(&mut t.block, run_filter)?,
            Node::Code(c) => {
                if let Some(ref mut b) = c.block {
                    process_block(b, run_filter)?;
                }
            }
            Node::Filter(f) => {
                process_block(&mut f.block, run_filter)?;
                let mut text = String::new();
                for child in &f.block.nodes {
                    if let Node::Text(t) = child {
                        text.push_str(&t.val);
                    }
                }
                let mut opts_map = Map::new();
                for attr in &f.attrs {
                    opts_map.insert(attr.name.clone(), attr.val.clone());
                }
                let rendered = run_filter(
                    &f.name,
                    &text,
                    &Value::Object(opts_map),
                    f.line,
                    f.filename.as_deref(),
                )?;
                *node = Node::Text(TextNode {
                    val: rendered,
                    line: f.line,
                    column: f.column,
                    filename: f.filename.clone(),
                    is_html: None,
                });
            }
            Node::Text(_) | Node::Comment(_) | _ => {}
        }
    }
    Ok(())
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
