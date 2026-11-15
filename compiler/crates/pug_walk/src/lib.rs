use pug_ast::{BlockNode, FileReferenceNode, Node};
use pug_error::PugError;
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    pub include_dependencies: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WalkReplacement {
    None,
    Single(Node),
    Multiple(Vec<Node>),
}

pub struct ReplaceContext {
    pub array_allowed: bool,
    replacement: WalkReplacement,
}

impl ReplaceContext {
    pub fn new(array_allowed: bool) -> Self {
        Self {
            array_allowed,
            replacement: WalkReplacement::None,
        }
    }

    pub fn replace_single(&mut self, node: Node) {
        self.replacement = WalkReplacement::Single(node);
    }

    pub fn replace_multiple(&mut self, nodes: Vec<Node>) -> Result<(), String> {
        if !self.array_allowed {
            return Err(String::from(
                "replace() can only be called with an array if the last parent is a Block or NamedBlock",
            ));
        }
        self.replacement = WalkReplacement::Multiple(nodes);
        Ok(())
    }

    pub fn into_replacement(self) -> WalkReplacement {
        self.replacement
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WalkOutcome {
    Single(Node),
    Multiple(Vec<Node>),
}

impl WalkOutcome {
    pub fn into_single(self) -> Result<Node, String> {
        match self {
            WalkOutcome::Single(n) => Ok(n),
            WalkOutcome::Multiple(_) => Err(String::from(
                "Expected a single AST node but walkAST produced an array",
            )),
        }
    }

    pub fn into_block(self) -> Result<BlockNode, String> {
        match self {
            WalkOutcome::Single(Node::Block(b)) => Ok(b),
            other => Err(format!("Expected Block node from walk_ast, got {other:?}")),
        }
    }
}

fn is_array_allowed_for(parents: &[Node], _current: &Node) -> bool {
    let Some(parent) = parents.first() else {
        return false;
    };
    matches!(parent, Node::Block(_) | Node::NamedBlock(_))
}

/// Walks a typed `Node` AST matching `pug-walk@1.1.8` semantics:
/// - `parents` has the immediate parent at index `0` (`parents.unshift(ast)` before descending, `parents.shift()` after).
/// - If `before` returns `Ok(false)`, descending and `after` are skipped for this node.
/// - If `before` calls `replace(Vec<Node>)`, each replacement node is immediately walked via `walk_and_merge_nodes`
///   and `after` on the replaced array is skipped.
/// - `after` is called after children are walked and `parents.shift()` is popped.
pub fn walk_ast<B, A>(
    node: Node,
    before: &mut B,
    after: &mut A,
    options: &WalkOptions,
    parents: &mut Vec<Node>,
) -> Result<WalkOutcome, String>
where
    B: FnMut(&Node, &mut ReplaceContext, &[Node]) -> Result<bool, String>,
    A: FnMut(&Node, &mut ReplaceContext, &[Node]) -> Result<(), String>,
{
    let array_allowed = is_array_allowed_for(parents, &node);
    let mut before_ctx = ReplaceContext::new(array_allowed);
    let cont = before(&node, &mut before_ctx, parents)?;

    let mut current = match before_ctx.into_replacement() {
        WalkReplacement::None => node,
        WalkReplacement::Single(n) => n,
        WalkReplacement::Multiple(arr) => {
            if !cont {
                return Ok(WalkOutcome::Multiple(arr));
            }
            let merged = walk_and_merge_nodes(arr, before, after, options, parents)?;
            return Ok(WalkOutcome::Multiple(merged));
        }
    };

    if !cont {
        return Ok(WalkOutcome::Single(current));
    }

    parents.insert(0, current.clone());

    match &mut current {
        Node::Block(b) => {
            let children = std::mem::take(&mut b.nodes);
            b.nodes = walk_and_merge_nodes(children, before, after, options, parents)?;
        }
        Node::NamedBlock(nb) => {
            let children = std::mem::take(&mut nb.nodes);
            nb.nodes = walk_and_merge_nodes(children, before, after, options, parents)?;
        }
        Node::Case(c) => {
            let blk = std::mem::replace(&mut c.block, BlockNode::empty(0, None));
            c.block = walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?;
        }
        Node::Mixin(m) => {
            if let Some(blk) = m.block.take() {
                m.block = Some(
                    walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?,
                );
            }
        }
        Node::Tag(t) => {
            let blk = std::mem::replace(&mut t.block, BlockNode::empty(0, None));
            t.block = walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?;
        }
        Node::InterpolatedTag(t) => {
            let blk = std::mem::replace(&mut t.block, BlockNode::empty(0, None));
            t.block = walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?;
        }
        Node::When(w) => {
            if let Some(blk) = w.block.take() {
                w.block = Some(
                    walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?,
                );
            }
        }
        Node::Code(c) => {
            if let Some(blk) = c.block.take() {
                c.block = Some(
                    walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?,
                );
            }
        }
        Node::While(w) => {
            let blk = std::mem::replace(&mut w.block, BlockNode::empty(0, None));
            w.block = walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?;
        }
        Node::Each(e) => {
            let blk = std::mem::replace(&mut e.block, BlockNode::empty(0, None));
            e.block = walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?;
            if let Some(alt) = e.alternate.take() {
                e.alternate = Some(
                    walk_ast(Node::Block(alt), before, after, options, parents)?.into_block()?,
                );
            }
        }
        Node::EachOf(e) => {
            let blk = std::mem::replace(&mut e.block, BlockNode::empty(0, None));
            e.block = walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?;
        }
        Node::Conditional(c) => {
            let cons = std::mem::replace(&mut c.consequent, BlockNode::empty(0, None));
            c.consequent =
                walk_ast(Node::Block(cons), before, after, options, parents)?.into_block()?;
            if let Some(alt_box) = c.alternate.take() {
                let walked_alt = walk_ast(*alt_box, before, after, options, parents)?.into_single()?;
                c.alternate = Some(Box::new(walked_alt));
            }
        }
        Node::Include(inc) => {
            let blk = std::mem::replace(&mut inc.block, BlockNode::empty(0, None));
            inc.block =
                walk_ast(Node::Block(blk), before, after, options, parents)?.into_block()?;
            let fref = std::mem::replace(
                &mut inc.file,
                FileReferenceNode::new(String::new(), 0, None, None),
            );
            if let Node::FileReference(walked_fref) =
                walk_ast(Node::FileReference(fref), before, after, options, parents)?
                    .into_single()?
            {
                inc.file = walked_fref;
            }
        }
        Node::Extends(ext) => {
            let fref = std::mem::replace(
                &mut ext.file,
                FileReferenceNode::new(String::new(), 0, None, None),
            );
            if let Node::FileReference(walked_fref) =
                walk_ast(Node::FileReference(fref), before, after, options, parents)?
                    .into_single()?
            {
                ext.file = walked_fref;
            }
        }
        Node::RawInclude(raw_inc) => {
            let fref = std::mem::replace(
                &mut raw_inc.file,
                FileReferenceNode::new(String::new(), 0, None, None),
            );
            if let Node::FileReference(walked_fref) =
                walk_ast(Node::FileReference(fref), before, after, options, parents)?
                    .into_single()?
            {
                raw_inc.file = walked_fref;
            }
        }
        Node::FileReference(fref) => {
            if options.include_dependencies
                && let Some(dep_ast) = fref.ast.take()
            {
                let walked_dep =
                    walk_ast(Node::Block(*dep_ast), before, after, options, parents)?
                        .into_block()?;
                fref.ast = Some(Box::new(walked_dep));
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

    // Update top of parents with mutated `current` before popping
    let _ = parents.remove(0);

    let after_array_allowed = is_array_allowed_for(parents, &current);
    let mut after_ctx = ReplaceContext::new(after_array_allowed);
    after(&current, &mut after_ctx, parents)?;
    match after_ctx.into_replacement() {
        WalkReplacement::None => Ok(WalkOutcome::Single(current)),
        WalkReplacement::Single(n) => Ok(WalkOutcome::Single(n)),
        WalkReplacement::Multiple(arr) => Ok(WalkOutcome::Multiple(arr)),
    }
}

fn walk_and_merge_nodes<B, A>(
    nodes: Vec<Node>,
    before: &mut B,
    after: &mut A,
    options: &WalkOptions,
    parents: &mut Vec<Node>,
) -> Result<Vec<Node>, String>
where
    B: FnMut(&Node, &mut ReplaceContext, &[Node]) -> Result<bool, String>,
    A: FnMut(&Node, &mut ReplaceContext, &[Node]) -> Result<(), String>,
{
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        match walk_ast(node, before, after, options, parents)? {
            WalkOutcome::Single(n) => out.push(n),
            WalkOutcome::Multiple(arr) => out.extend(arr),
        }
    }
    Ok(out)
}

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

/// Walks a JSON AST value (`serde_json::Value`), supporting partial test fixtures (such as in `pug-walk/test/index.test.js`
/// where `{ type: 'Text', val: 'a' }` has no `line` field) and validating unknown node types with
/// `"Unexpected node type <type>"`.
pub fn walk_json_ast<B, A>(
    mut ast: Value,
    before: &mut B,
    after: &mut A,
    include_dependencies: bool,
    parents: &mut Vec<Value>,
) -> Result<Value, String>
where
    B: FnMut(&Value, bool, &[Value]) -> Result<(bool, Option<Value>), String>,
    A: FnMut(&Value, bool, &[Value]) -> Result<Option<Value>, String>,
{
    let parent_type = parents
        .first()
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let array_allowed = matches!(parent_type, "Block" | "NamedBlock");

    let (cont, before_rep) = before(&ast, array_allowed, parents)?;
    if let Some(rep) = before_rep {
        ast = rep;
    }
    if !cont {
        return Ok(ast);
    }
    if let Some(arr) = ast.as_array().cloned() {
        let merged =
            walk_and_merge_json_nodes(arr, before, after, include_dependencies, parents)?;
        return Ok(Value::Array(merged));
    }

    let current_type = ast
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    parents.insert(0, ast.clone());

    match current_type.as_str() {
        "NamedBlock" | "Block" => {
            let children = ast
                .get("nodes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let walked =
                walk_and_merge_json_nodes(children, before, after, include_dependencies, parents)?;
            if let Some(obj) = ast.as_object_mut() {
                obj.insert(String::from("nodes"), Value::Array(walked));
            }
            parents[0] = ast.clone();
        }
        "Case" | "Mixin" | "Tag" | "InterpolatedTag" | "When" | "Code" | "While" => {
            if let Some(blk) = ast.get("block").cloned()
                && !blk.is_null()
            {
                let walked =
                    walk_json_ast(blk, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("block"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        "Each" => {
            if let Some(blk) = ast.get("block").cloned()
                && !blk.is_null()
            {
                let walked =
                    walk_json_ast(blk, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("block"), walked);
                }
                parents[0] = ast.clone();
            }
            if let Some(alt) = ast.get("alternate").cloned()
                && !alt.is_null()
            {
                let walked =
                    walk_json_ast(alt, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("alternate"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        "EachOf" => {
            if let Some(blk) = ast.get("block").cloned()
                && !blk.is_null()
            {
                let walked =
                    walk_json_ast(blk, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("block"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        "Conditional" => {
            if let Some(cons) = ast.get("consequent").cloned()
                && !cons.is_null()
            {
                let walked =
                    walk_json_ast(cons, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("consequent"), walked);
                }
                parents[0] = ast.clone();
            }
            if let Some(alt) = ast.get("alternate").cloned()
                && !alt.is_null()
            {
                let walked =
                    walk_json_ast(alt, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("alternate"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        "Include" => {
            if let Some(blk) = ast.get("block").cloned()
                && !blk.is_null()
            {
                let walked =
                    walk_json_ast(blk, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("block"), walked);
                }
                parents[0] = ast.clone();
            }
            if let Some(file) = ast.get("file").cloned()
                && !file.is_null()
            {
                let walked =
                    walk_json_ast(file, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("file"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        "Extends" => {
            if let Some(file) = ast.get("file").cloned()
                && !file.is_null()
            {
                let walked =
                    walk_json_ast(file, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("file"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        "RawInclude" => {
            if let Some(file) = ast.get("file").cloned()
                && !file.is_null()
            {
                let walked =
                    walk_json_ast(file, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("file"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        "Attrs" | "BlockComment" | "Comment" | "Doctype" | "Extension" | "MixinBlock"
        | "YieldBlock" | "Text" => {}
        "FileReference" => {
            if include_dependencies
                && let Some(dep_ast) = ast.get("ast").cloned()
                && !dep_ast.is_null()
            {
                let walked =
                    walk_json_ast(dep_ast, before, after, include_dependencies, parents)?;
                if let Some(obj) = ast.as_object_mut() {
                    obj.insert(String::from("ast"), walked);
                }
                parents[0] = ast.clone();
            }
        }
        other => {
            let _ = parents.remove(0);
            return Err(format!("Unexpected node type {other}"));
        }
    }

    let _ = parents.remove(0);

    let after_parent_type = parents
        .first()
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let after_array_allowed = matches!(after_parent_type, "Block" | "NamedBlock");

    if let Some(after_rep) = after(&ast, after_array_allowed, parents)? {
        ast = after_rep;
    }

    Ok(ast)
}

fn walk_and_merge_json_nodes<B, A>(
    nodes: Vec<Value>,
    before: &mut B,
    after: &mut A,
    include_dependencies: bool,
    parents: &mut Vec<Value>,
) -> Result<Vec<Value>, String>
where
    B: FnMut(&Value, bool, &[Value]) -> Result<(bool, Option<Value>), String>,
    A: FnMut(&Value, bool, &[Value]) -> Result<Option<Value>, String>,
{
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        let res = walk_json_ast(node, before, after, include_dependencies, parents)?;
        if let Some(arr) = res.as_array() {
            out.extend(arr.iter().cloned());
        } else {
            out.push(res);
        }
    }
    Ok(out)
}

/// Simple mutable visitor over a `BlockNode` for internal compiler passes.
pub fn walk_block<F>(block: &mut BlockNode, visit: &mut F) -> Result<(), PugError>
where
    F: FnMut(&mut Node) -> Result<(), PugError>,
{
    for node in &mut block.nodes {
        visit(node)?;
        match node {
            Node::Block(b) => walk_block(b, visit)?,
            Node::NamedBlock(nb) => {
                let mut tmp = BlockNode::new(nb.line, std::mem::take(&mut nb.nodes), nb.filename.clone());
                walk_block(&mut tmp, visit)?;
                nb.nodes = tmp.nodes;
            }
            Node::Tag(tag) => walk_block(&mut tag.block, visit)?,
            Node::InterpolatedTag(tag) => walk_block(&mut tag.block, visit)?,
            Node::Case(c) => walk_block(&mut c.block, visit)?,
            Node::When(w) => {
                if let Some(ref mut b) = w.block {
                    walk_block(b, visit)?;
                }
            }
            Node::Code(code) => {
                if let Some(ref mut b) = code.block {
                    walk_block(b, visit)?;
                }
            }
            Node::While(w) => walk_block(&mut w.block, visit)?,
            Node::Each(e) => {
                walk_block(&mut e.block, visit)?;
                if let Some(ref mut alt) = e.alternate {
                    walk_block(alt, visit)?;
                }
            }
            Node::EachOf(e) => walk_block(&mut e.block, visit)?,
            Node::Conditional(c) => {
                walk_block(&mut c.consequent, visit)?;
                if let Some(ref mut alt) = c.alternate {
                    visit(alt)?;
                    if let Node::Block(b) = alt.as_mut() {
                        walk_block(b, visit)?;
                    }
                }
            }
            Node::Mixin(m) => {
                if let Some(ref mut b) = m.block {
                    walk_block(b, visit)?;
                }
            }
            Node::Include(inc) => walk_block(&mut inc.block, visit)?,
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_walk_block_flattening_and_callback_order() {
        let ast = json!({
            "type": "Block",
            "nodes": [
                {
                    "type": "Block",
                    "nodes": [
                        {
                            "type": "Block",
                            "nodes": [
                                { "type": "Text", "val": "a" },
                                { "type": "Text", "val": "b" }
                            ]
                        },
                        { "type": "Text", "val": "c" }
                    ]
                },
                { "type": "Text", "val": "d" }
            ]
        });

        let called = std::cell::RefCell::new(Vec::<String>::new());
        let mut parents = Vec::new();
        let res = walk_json_ast(
            ast,
            &mut |node, array_allowed, _parents| {
                if node["type"] == "Text" {
                    let val = node["val"].as_str().unwrap();
                    called.borrow_mut().push(format!("before {val}"));
                    if val == "a" {
                        assert!(array_allowed);
                        return Ok((
                            true,
                            Some(json!([
                                { "type": "Text", "val": "e" },
                                { "type": "Text", "val": "f" }
                            ])),
                        ));
                    }
                }
                Ok((true, None))
            },
            &mut |node, array_allowed, _parents| {
                if node["type"] == "Block" && array_allowed {
                    return Ok(Some(node["nodes"].clone()));
                } else if node["type"] == "Text" {
                    let val = node["val"].as_str().unwrap();
                    called.borrow_mut().push(format!("after {val}"));
                }
                Ok(None)
            },
            false,
            &mut parents,
        )
        .unwrap();

        assert_eq!(
            res,
            json!({
                "type": "Block",
                "nodes": [
                    { "type": "Text", "val": "e" },
                    { "type": "Text", "val": "f" },
                    { "type": "Text", "val": "b" },
                    { "type": "Text", "val": "c" },
                    { "type": "Text", "val": "d" }
                ]
            })
        );
        assert_eq!(
            *called.borrow(),
            vec![
                "before a", "before e", "after e", "before f", "after f", "before b", "after b",
                "before c", "after c", "before d", "after d"
            ]
        );
    }
}
