use pug_ast::{BlockNode, Node};
use pug_error::PugError;

/// Walks a `BlockNode` and applies a visitor closure to each node in the tree
/// (expanded to full `pug-walk@1.1.8` `before`/`after`/`replace` contract in Step 3).
pub fn walk_block<F>(block: &mut BlockNode, visit: &mut F) -> Result<(), PugError>
where
    F: FnMut(&mut Node) -> Result<(), PugError>,
{
    for node in &mut block.nodes {
        visit(node)?;
        match node {
            Node::Block(b) => walk_block(b, visit)?,
            Node::Tag(tag) => walk_block(&mut tag.block, visit)?,
            Node::Filter(filter) => walk_block(&mut filter.block, visit)?,
            Node::Code(code) => {
                if let Some(ref mut b) = code.block {
                    walk_block(b, visit)?;
                }
            }
            Node::Text(_) | Node::Comment(_) => {}
        }
    }
    Ok(())
}
