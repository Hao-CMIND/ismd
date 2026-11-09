use pug_ast::BlockNode;
use pug_error::PugError;

/// Loader skeleton for Step 1 (expanded to full recursive `include`/`extends`/`Buffer` loading in Step 4).
pub fn load_ast(ast: BlockNode) -> Result<BlockNode, PugError> {
    Ok(ast)
}
