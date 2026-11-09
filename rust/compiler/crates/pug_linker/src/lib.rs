use pug_ast::BlockNode;
use pug_error::PugError;

/// Linker skeleton for Step 1 (expanded to full `include`/`yield`/`extends`/`block` linking in Step 4).
pub fn link(ast: BlockNode) -> Result<BlockNode, PugError> {
    Ok(ast)
}
