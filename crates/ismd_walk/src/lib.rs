use ismd_ast::{BlockNode, Node};

/// Walks and mutates a `BlockNode` AST in place in pre-order (`before`), without cloning nodes
/// or maintaining a `parents` vector.
///
/// If `visitor` returns `Ok(false)` for a node, descending into that node's children is skipped.
/// Note: `visitor` is invoked on child `Node`s (not wrapper `Block`/`FileReference` nodes unless
/// a `Node::Block` / `Node::FileReference` variant explicitly appears inside a block or conditional).
pub fn walk_mut<E, F>(
    block: &mut BlockNode,
    include_dependencies: bool,
    visitor: &mut F,
) -> Result<(), E>
where
    F: FnMut(&mut Node) -> Result<bool, E>,
{
    for child in &mut block.nodes {
        walk_node_mut(child, include_dependencies, visitor)?;
    }
    Ok(())
}

fn walk_node_mut<E, F>(
    node: &mut Node,
    include_dependencies: bool,
    visitor: &mut F,
) -> Result<(), E>
where
    F: FnMut(&mut Node) -> Result<bool, E>,
{
    if !visitor(node)? {
        return Ok(());
    }

    match node {
        Node::Block(b) => walk_mut(b, include_dependencies, visitor)?,
        Node::NamedBlock(nb) => {
            for child in &mut nb.nodes {
                walk_node_mut(child, include_dependencies, visitor)?;
            }
        }
        Node::Case(c) => walk_mut(&mut c.block, include_dependencies, visitor)?,
        Node::Mixin(m) => {
            if let Some(ref mut blk) = m.block {
                walk_mut(blk, include_dependencies, visitor)?;
            }
        }
        Node::Tag(t) => walk_mut(&mut t.block, include_dependencies, visitor)?,
        Node::InterpolatedTag(t) => walk_mut(&mut t.block, include_dependencies, visitor)?,
        Node::When(w) => {
            if let Some(ref mut blk) = w.block {
                walk_mut(blk, include_dependencies, visitor)?;
            }
        }
        Node::Code(c) => {
            if let Some(ref mut blk) = c.block {
                walk_mut(blk, include_dependencies, visitor)?;
            }
        }
        Node::While(w) => walk_mut(&mut w.block, include_dependencies, visitor)?,
        Node::Each(e) => {
            walk_mut(&mut e.block, include_dependencies, visitor)?;
            if let Some(ref mut alt) = e.alternate {
                walk_mut(alt, include_dependencies, visitor)?;
            }
        }
        Node::EachOf(e) => walk_mut(&mut e.block, include_dependencies, visitor)?,
        Node::Conditional(c) => {
            walk_mut(&mut c.consequent, include_dependencies, visitor)?;
            if let Some(ref mut alt) = c.alternate {
                walk_node_mut(alt, include_dependencies, visitor)?;
            }
        }
        Node::Include(inc) => {
            walk_mut(&mut inc.block, include_dependencies, visitor)?;
            if include_dependencies && let Some(ref mut dep_ast) = inc.file.ast {
                walk_mut(dep_ast, include_dependencies, visitor)?;
            }
        }
        Node::Extends(ext) => {
            if include_dependencies && let Some(ref mut dep_ast) = ext.file.ast {
                walk_mut(dep_ast, include_dependencies, visitor)?;
            }
        }
        Node::RawInclude(raw_inc) => {
            if include_dependencies && let Some(ref mut dep_ast) = raw_inc.file.ast {
                walk_mut(dep_ast, include_dependencies, visitor)?;
            }
        }
        Node::FileReference(fref) => {
            if include_dependencies && let Some(ref mut dep_ast) = fref.ast {
                walk_mut(dep_ast, include_dependencies, visitor)?;
            }
        }
        Node::Attrs(_)
        | Node::BlockComment(_)
        | Node::Comment(_)
        | Node::Doctype(_)
        | Node::MixinBlock(_)
        | Node::YieldBlock(_)
        | Node::Extension(_)
        | Node::Text(_) => {}
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ismd_ast::{FileReferenceNode, IncludeNode, TextNode};

    fn text(val: &str) -> Node {
        Node::Text(TextNode {
            val: val.to_string(),
            line: Some(1),
            column: None,
            filename: None,
            is_html: None,
        })
    }

    fn block(nodes: Vec<Node>, line: usize) -> BlockNode {
        BlockNode {
            node_type: "Block".into(),
            nodes,
            line: Some(line),
            column: None,
            filename: None,
            declared_blocks: None,
            has_extends: None,
        }
    }

    #[test]
    fn test_walk_mut_preorder_skip_and_dependencies() {
        let mut ast = block(
            vec![
                Node::Block(block(vec![text("a"), text("b")], 1)),
                Node::Include(IncludeNode {
                    file: FileReferenceNode {
                        node_type: "FileReference".into(),
                        path: "dep.ismd".into(),
                        line: 2,
                        column: None,
                        filename: None,
                        full_path: None,
                        str: None,
                        raw: None,
                        ast: Some(Box::new(block(vec![text("dep")], 1))),
                    },
                    block: block(vec![text("child")], 2),
                    line: 2,
                    column: None,
                    filename: None,
                }),
                text("d"),
            ],
            0,
        );

        // include_dependencies = false skips FileReference.ast, returning Ok(false) skips nested block
        let mut visited_no_dep = Vec::new();
        walk_mut(&mut ast, false, &mut |node| -> Result<bool, ()> {
            match node {
                Node::Block(_) => {
                    visited_no_dep.push("skip-block".to_string());
                    return Ok(false);
                }
                Node::Text(t) => visited_no_dep.push(t.val.clone()),
                _ => {}
            }
            Ok(true)
        })
        .unwrap();
        assert_eq!(visited_no_dep, vec!["skip-block", "child", "d"]);

        // include_dependencies = true visits dependency AST and mutates in place
        let mut visited_with_dep = Vec::new();
        walk_mut(&mut ast, true, &mut |node| -> Result<bool, ()> {
            if let Node::Text(t) = node {
                t.val = t.val.to_uppercase();
                visited_with_dep.push(t.val.clone());
            }
            Ok(true)
        })
        .unwrap();
        assert_eq!(visited_with_dep, vec!["A", "B", "CHILD", "DEP", "D"]);
    }
}
