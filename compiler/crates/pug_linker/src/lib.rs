use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;

use pug_ast::{
    BlockCommentNode, BlockNode, CaseNode, CodeNode, ConditionalNode, EachNode, EachOfNode,
    FilterNode, IncludeNode, InterpolatedTagNode, MixinNode, NamedBlockNode, Node, TagNode,
    TextNode, WhenNode, WhileNode,
};
use pug_error::{ErrorOptions, PugError};

/// Links `Extends`, `Include`, `RawInclude`, `NamedBlock`, and `YieldBlock` nodes
/// according to `raw/compiler/packages/pug-linker/index.js`.
pub fn link(mut ast: BlockNode) -> Result<BlockNode, PugError> {
    if ast.node_type != "Block" {
        return Err(PugError::new(
            "INVALID_AST",
            "The top level element should always be a block",
            ErrorOptions {
                line: ast.line.unwrap_or(0) as i64,
                column: ast.column.map(|c| c as i64),
                filename: ast.filename.clone(),
                src: None,
            },
        ));
    }

    if !ast_needs_link(&ast) {
        if ast.declared_blocks.is_none() {
            ast.declared_blocks = Some(BTreeMap::new());
        }
        return Ok(ast);
    }

    let lblock = link_block(LBlock::from_ast(ast))?;
    Ok(lblock.into_ast())
}

fn ast_needs_link(block: &BlockNode) -> bool {
    block.nodes.iter().any(node_needs_link)
}

fn node_needs_link(node: &Node) -> bool {
    match node {
        Node::Extends(_) | Node::Include(_) | Node::RawInclude(_) | Node::NamedBlock(_) => true,
        Node::Block(b) => ast_needs_link(b),
        Node::Tag(t) => ast_needs_link(&t.block),
        Node::InterpolatedTag(t) => ast_needs_link(&t.block),
        Node::BlockComment(bc) => ast_needs_link(&bc.block),
        Node::Filter(f) => ast_needs_link(&f.block),
        Node::Case(c) => ast_needs_link(&c.block),
        Node::When(w) => w.block.as_ref().is_some_and(ast_needs_link),
        Node::Conditional(c) => {
            ast_needs_link(&c.consequent)
                || c.alternate.as_deref().is_some_and(node_needs_link)
        }
        Node::While(w) => ast_needs_link(&w.block),
        Node::Each(e) => {
            ast_needs_link(&e.block) || e.alternate.as_ref().is_some_and(ast_needs_link)
        }
        Node::EachOf(e) => ast_needs_link(&e.block),
        Node::Mixin(m) => m.block.as_ref().is_some_and(ast_needs_link),
        Node::Code(c) => c.block.as_ref().is_some_and(ast_needs_link),
        Node::Attrs(_)
        | Node::Comment(_)
        | Node::Doctype(_)
        | Node::Extension(_)
        | Node::FileReference(_)
        | Node::IncludeFilter(_)
        | Node::MixinBlock(_)
        | Node::YieldBlock(_)
        | Node::Text(_) => false,
    }
}

#[derive(Debug, Clone)]
struct LBlock {
    node_type: String,
    nodes: Vec<LNode>,
    line: Option<usize>,
    column: Option<usize>,
    filename: Option<String>,
    declared_blocks: Option<BTreeMap<String, Vec<Rc<RefCell<LNamedBlock>>>>>,
    has_extends: Option<bool>,
}

#[derive(Debug, Clone)]
struct LNamedBlock {
    name: String,
    mode: String,
    nodes: Vec<LNode>,
    line: usize,
    column: Option<usize>,
    filename: Option<String>,
    parents: Option<Vec<Rc<RefCell<LNamedBlock>>>>,
    ignore: Option<bool>,
}

#[derive(Debug, Clone)]
enum LNode {
    Block(LBlock),
    NamedBlock(Rc<RefCell<LNamedBlock>>),
    Tag(Box<TagNode>, LBlock),
    InterpolatedTag(Box<InterpolatedTagNode>, LBlock),
    BlockComment(Box<BlockCommentNode>, LBlock),
    Filter(Box<FilterNode>, LBlock),
    Case(Box<CaseNode>, LBlock),
    When(Box<WhenNode>, Option<LBlock>),
    Conditional {
        meta: Box<ConditionalNode>,
        consequent: LBlock,
        alternate: Option<Box<LNode>>,
    },
    While(Box<WhileNode>, LBlock),
    Each {
        meta: Box<EachNode>,
        block: LBlock,
        alternate: Option<LBlock>,
    },
    EachOf(Box<EachOfNode>, LBlock),
    Mixin(Box<MixinNode>, Option<LBlock>),
    Code(Box<CodeNode>, Option<LBlock>),
    Include(Box<IncludeNode>, LBlock),
    Leaf(Node),
}

impl LBlock {
    fn from_ast(mut ast: BlockNode) -> Self {
        let nodes = std::mem::take(&mut ast.nodes)
            .into_iter()
            .map(LNode::from_ast)
            .collect();
        let declared_blocks = ast.declared_blocks.map(|map| {
            map.into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        v.into_iter()
                            .map(|nb| Rc::new(RefCell::new(LNamedBlock::from_ast(nb))))
                            .collect(),
                    )
                })
                .collect()
        });
        Self {
            node_type: ast.node_type,
            nodes,
            line: ast.line,
            column: ast.column,
            filename: ast.filename,
            declared_blocks,
            has_extends: ast.has_extends,
        }
    }

    fn into_ast(self) -> BlockNode {
        BlockNode {
            node_type: self.node_type,
            nodes: self.nodes.into_iter().map(LNode::into_ast).collect(),
            line: self.line,
            column: self.column,
            filename: self.filename,
            declared_blocks: self.declared_blocks.map(|map| {
                map.into_iter()
                    .map(|(k, v)| (k, v.iter().map(|nb| nb.borrow().to_ast()).collect()))
                    .collect()
            }),
            has_extends: self.has_extends,
        }
    }
}

impl LNamedBlock {
    fn from_ast(mut nb: NamedBlockNode) -> Self {
        let nodes = std::mem::take(&mut nb.nodes)
            .into_iter()
            .map(LNode::from_ast)
            .collect();
        let parents = nb.parents.map(|ps| {
            ps.into_iter()
                .map(|p| Rc::new(RefCell::new(LNamedBlock::from_ast(p))))
                .collect()
        });
        Self {
            name: nb.name,
            mode: nb.mode,
            nodes,
            line: nb.line,
            column: nb.column,
            filename: nb.filename,
            parents,
            ignore: nb.ignore,
        }
    }

    fn to_ast(&self) -> NamedBlockNode {
        NamedBlockNode {
            name: self.name.clone(),
            mode: self.mode.clone(),
            nodes: self.nodes.iter().cloned().map(LNode::into_ast).collect(),
            line: self.line,
            column: self.column,
            filename: self.filename.clone(),
            parents: self
                .parents
                .as_ref()
                .map(|ps| ps.iter().map(|p| p.borrow().to_ast()).collect()),
            ignore: self.ignore,
        }
    }
}

impl LNode {
    fn from_ast(node: Node) -> Self {
        match node {
            Node::Block(b) => LNode::Block(LBlock::from_ast(b)),
            Node::NamedBlock(nb) => LNode::NamedBlock(Rc::new(RefCell::new(LNamedBlock::from_ast(nb)))),
            Node::Tag(mut t) => {
                let blk = std::mem::replace(&mut t.block, BlockNode::empty(0, None));
                LNode::Tag(Box::new(t), LBlock::from_ast(blk))
            }
            Node::InterpolatedTag(mut t) => {
                let blk = std::mem::replace(&mut t.block, BlockNode::empty(0, None));
                LNode::InterpolatedTag(Box::new(t), LBlock::from_ast(blk))
            }
            Node::BlockComment(mut c) => {
                let blk = std::mem::replace(&mut c.block, BlockNode::empty(0, None));
                LNode::BlockComment(Box::new(c), LBlock::from_ast(blk))
            }
            Node::Filter(mut f) => {
                let blk = std::mem::replace(&mut f.block, BlockNode::empty(0, None));
                LNode::Filter(Box::new(f), LBlock::from_ast(blk))
            }
            Node::Case(mut c) => {
                let blk = std::mem::replace(&mut c.block, BlockNode::empty(0, None));
                LNode::Case(Box::new(c), LBlock::from_ast(blk))
            }
            Node::When(mut w) => {
                let blk = w.block.take().map(LBlock::from_ast);
                LNode::When(Box::new(w), blk)
            }
            Node::Conditional(mut c) => {
                let cons = std::mem::replace(&mut c.consequent, BlockNode::empty(0, None));
                let alt = c.alternate.take().map(|a| Box::new(LNode::from_ast(*a)));
                LNode::Conditional {
                    meta: Box::new(c),
                    consequent: LBlock::from_ast(cons),
                    alternate: alt,
                }
            }
            Node::While(mut w) => {
                let blk = std::mem::replace(&mut w.block, BlockNode::empty(0, None));
                LNode::While(Box::new(w), LBlock::from_ast(blk))
            }
            Node::Each(mut e) => {
                let blk = std::mem::replace(&mut e.block, BlockNode::empty(0, None));
                let alt = e.alternate.take().map(LBlock::from_ast);
                LNode::Each {
                    meta: Box::new(e),
                    block: LBlock::from_ast(blk),
                    alternate: alt,
                }
            }
            Node::EachOf(mut e) => {
                let blk = std::mem::replace(&mut e.block, BlockNode::empty(0, None));
                LNode::EachOf(Box::new(e), LBlock::from_ast(blk))
            }
            Node::Mixin(mut m) => {
                let blk = m.block.take().map(LBlock::from_ast);
                LNode::Mixin(Box::new(m), blk)
            }
            Node::Code(mut c) => {
                let blk = c.block.take().map(LBlock::from_ast);
                LNode::Code(Box::new(c), blk)
            }
            Node::Include(mut inc) => {
                let blk = std::mem::replace(&mut inc.block, BlockNode::empty(0, None));
                LNode::Include(Box::new(inc), LBlock::from_ast(blk))
            }
            other => LNode::Leaf(other),
        }
    }

    fn into_ast(self) -> Node {
        match self {
            LNode::Block(b) => Node::Block(b.into_ast()),
            LNode::NamedBlock(nb) => Node::NamedBlock(nb.borrow().to_ast()),
            LNode::Tag(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::Tag(*meta)
            }
            LNode::InterpolatedTag(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::InterpolatedTag(*meta)
            }
            LNode::BlockComment(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::BlockComment(*meta)
            }
            LNode::Filter(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::Filter(*meta)
            }
            LNode::Case(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::Case(*meta)
            }
            LNode::When(mut meta, blk) => {
                meta.block = blk.map(LBlock::into_ast);
                Node::When(*meta)
            }
            LNode::Conditional {
                mut meta,
                consequent,
                alternate,
            } => {
                meta.consequent = consequent.into_ast();
                meta.alternate = alternate.map(|a| Box::new(a.into_ast()));
                Node::Conditional(*meta)
            }
            LNode::While(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::While(*meta)
            }
            LNode::Each {
                mut meta,
                block,
                alternate,
            } => {
                meta.block = block.into_ast();
                meta.alternate = alternate.map(LBlock::into_ast);
                Node::Each(*meta)
            }
            LNode::EachOf(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::EachOf(*meta)
            }
            LNode::Mixin(mut meta, blk) => {
                meta.block = blk.map(LBlock::into_ast);
                Node::Mixin(*meta)
            }
            LNode::Code(mut meta, blk) => {
                meta.block = blk.map(LBlock::into_ast);
                Node::Code(*meta)
            }
            LNode::Include(mut meta, blk) => {
                meta.block = blk.into_ast();
                Node::Include(*meta)
            }
            LNode::Leaf(node) => node,
        }
    }

    fn loc_and_type(&self) -> (usize, Option<usize>, Option<String>, &'static str) {
        match self {
            LNode::Block(b) => (b.line.unwrap_or(0), b.column, b.filename.clone(), "Block"),
            LNode::NamedBlock(nb) => {
                let nb = nb.borrow();
                (nb.line, nb.column, nb.filename.clone(), "NamedBlock")
            }
            LNode::Tag(m, _) => (m.line, m.column, m.filename.clone(), "Tag"),
            LNode::InterpolatedTag(m, _) => {
                (m.line, m.column, m.filename.clone(), "InterpolatedTag")
            }
            LNode::BlockComment(m, _) => (m.line, m.column, m.filename.clone(), "BlockComment"),
            LNode::Filter(m, _) => (m.line, m.column, m.filename.clone(), "Filter"),
            LNode::Case(m, _) => (m.line, m.column, m.filename.clone(), "Case"),
            LNode::When(m, _) => (m.line, m.column, m.filename.clone(), "When"),
            LNode::Conditional { meta, .. } => {
                (meta.line, meta.column, meta.filename.clone(), "Conditional")
            }
            LNode::While(m, _) => (m.line, m.column, m.filename.clone(), "While"),
            LNode::Each { meta, .. } => (meta.line, meta.column, meta.filename.clone(), "Each"),
            LNode::EachOf(m, _) => (m.line, m.column, m.filename.clone(), "EachOf"),
            LNode::Mixin(m, _) => (m.line, m.column, m.filename.clone(), "Mixin"),
            LNode::Code(m, _) => (m.line, m.column, m.filename.clone(), "Code"),
            LNode::Include(m, _) => (m.line, m.column, m.filename.clone(), "Include"),
            LNode::Leaf(n) => {
                let ty = n.node_type();
                match n {
                    Node::Text(t) => (t.line.unwrap_or(0), t.column, t.filename.clone(), ty),
                    Node::Comment(c) => (c.line, c.column, c.filename.clone(), ty),
                    Node::Doctype(d) => (d.line, d.column, d.filename.clone(), ty),
                    Node::IncludeFilter(f) => (f.line, f.column, f.filename.clone(), ty),
                    Node::FileReference(f) => (f.line, f.column, f.filename.clone(), ty),
                    Node::Extends(e) => (e.line, e.column, e.filename.clone(), ty),
                    Node::RawInclude(r) => (r.line, r.column, r.filename.clone(), ty),
                    Node::MixinBlock(m) => (m.line, m.column, m.filename.clone(), ty),
                    Node::YieldBlock(y) => (y.line, y.column, y.filename.clone(), ty),
                    Node::Attrs(a) => (a.line, a.column, a.filename.clone(), ty),
                    _ => (0, None, None, ty),
                }
            }
        }
    }

    fn text_only(&self) -> bool {
        match self {
            LNode::Tag(m, _) => m.text_only == Some(true),
            LNode::InterpolatedTag(m, _) => m.text_only == Some(true),
            LNode::Mixin(m, _) => m.text_only == Some(true),
            _ => false,
        }
    }

    fn child_block_if_nonempty(&self) -> Option<&LBlock> {
        let blk = match self {
            LNode::Tag(_, b)
            | LNode::InterpolatedTag(_, b)
            | LNode::BlockComment(_, b)
            | LNode::Filter(_, b)
            | LNode::Case(_, b)
            | LNode::While(_, b)
            | LNode::EachOf(_, b)
            | LNode::Include(_, b) => Some(b),
            LNode::When(_, Some(b))
            | LNode::Mixin(_, Some(b))
            | LNode::Code(_, Some(b)) => Some(b),
            LNode::Each { block, .. } => Some(block),
            _ => None,
        }?;
        if blk.nodes.is_empty() {
            None
        } else {
            Some(blk)
        }
    }

    fn child_block_mut(&mut self) -> Option<&mut LBlock> {
        match self {
            LNode::Tag(_, b)
            | LNode::InterpolatedTag(_, b)
            | LNode::BlockComment(_, b)
            | LNode::Filter(_, b)
            | LNode::Case(_, b)
            | LNode::While(_, b)
            | LNode::EachOf(_, b)
            | LNode::Include(_, b) => Some(b),
            LNode::When(_, Some(b))
            | LNode::Mixin(_, Some(b))
            | LNode::Code(_, Some(b)) => Some(b),
            LNode::Each { block, .. } => Some(block),
            _ => None,
        }
    }
}

fn link_block(mut ast: LBlock) -> Result<LBlock, PugError> {
    let mut extends_node = None;
    if !ast.nodes.is_empty() {
        let has_extends = matches!(&ast.nodes[0], LNode::Leaf(Node::Extends(_)));
        check_extend_position(&ast, has_extends)?;
        if has_extends && let LNode::Leaf(Node::Extends(ext)) = ast.nodes.remove(0) {
            extends_node = Some(ext);
        }
    }

    ast = apply_includes(ast)?;
    let declared_blocks = find_declared_blocks(&ast);
    ast.declared_blocks = Some(declared_blocks);

    if let Some(extends_node) = extends_node {
        let mut mixins = Vec::new();
        let mut expected_blocks = Vec::new();
        collect_extending_root_nodes(&ast.nodes, &mut mixins, &mut expected_blocks)?;

        let parent_raw = extends_node.file.ast.ok_or_else(|| {
            PugError::new(
                "MISSING_EXTENDS_AST",
                format!(
                    "Extended file \"{}\" does not have a parsed AST",
                    extends_node.file.path
                ),
                ErrorOptions {
                    line: extends_node.line as i64,
                    column: extends_node.column.map(|c| c as i64),
                    filename: extends_node.filename.clone(),
                    src: None,
                },
            )
        })?;
        let mut parent = link_block(LBlock::from_ast(*parent_raw))?;
        let parent_declared = parent.declared_blocks.as_ref().expect("set by link_block");
        extend(parent_declared, &ast);

        let found_block_names = collect_named_block_names(&parent);
        for expected in expected_blocks {
            let eb = expected.borrow();
            if !found_block_names.contains(&eb.name) {
                return Err(PugError::new(
                    "UNEXPECTED_BLOCK",
                    format!("Unexpected block {}", eb.name),
                    ErrorOptions {
                        line: eb.line as i64,
                        column: eb.column.map(|c| c as i64),
                        filename: eb.filename.clone(),
                        src: None,
                    },
                ));
            }
        }

        if let (Some(parent_map), Some(child_map)) =
            (&mut parent.declared_blocks, ast.declared_blocks)
        {
            for (name, blocks) in child_map {
                parent_map.insert(name, blocks);
            }
        }

        mixins.append(&mut parent.nodes);
        parent.nodes = mixins;
        parent.has_extends = Some(true);
        return Ok(parent);
    }

    Ok(ast)
}

fn collect_extending_root_nodes(
    nodes: &[LNode],
    mixins: &mut Vec<LNode>,
    expected_blocks: &mut Vec<Rc<RefCell<LNamedBlock>>>,
) -> Result<(), PugError> {
    for node in nodes {
        match node {
            LNode::NamedBlock(nb) => expected_blocks.push(nb.clone()),
            LNode::Block(b) => collect_extending_root_nodes(&b.nodes, mixins, expected_blocks)?,
            LNode::Mixin(m, _) if !m.call => mixins.push(node.clone()),
            _ => {
                let (line, column, filename, _) = node.loc_and_type();
                return Err(PugError::new(
                    "UNEXPECTED_NODES_IN_EXTENDING_ROOT",
                    "Only named blocks and mixins can appear at the top level of an extending template",
                    ErrorOptions {
                        line: line as i64,
                        column: column.map(|c| c as i64),
                        filename,
                        src: None,
                    },
                ));
            }
        }
    }
    Ok(())
}

fn find_declared_blocks(ast: &LBlock) -> BTreeMap<String, Vec<Rc<RefCell<LNamedBlock>>>> {
    let mut definitions: BTreeMap<String, Vec<Rc<RefCell<LNamedBlock>>>> = BTreeMap::new();
    walk_lblock_ref(ast, &mut |node| {
        if let LNode::NamedBlock(nb_rc) = node {
            let mode_replace = nb_rc.borrow().mode == "replace";
            if mode_replace {
                let name = nb_rc.borrow().name.clone();
                definitions.entry(name).or_default().push(nb_rc.clone());
            }
        }
        Ok(())
    })
    .expect("infallible find_declared_blocks");
    definitions
}

fn collect_named_block_names(ast: &LBlock) -> HashSet<String> {
    let mut names = HashSet::new();
    walk_lblock_ref(ast, &mut |node| {
        if let LNode::NamedBlock(nb_rc) = node {
            names.insert(nb_rc.borrow().name.clone());
        }
        Ok(())
    })
    .expect("infallible collect_named_block_names");
    names
}

fn flatten_parent_blocks(
    parent_blocks: &[Rc<RefCell<LNamedBlock>>],
    accumulator: &mut Vec<Rc<RefCell<LNamedBlock>>>,
) {
    for parent_block in parent_blocks {
        let parents = parent_block.borrow().parents.clone();
        if let Some(parents) = parents {
            flatten_parent_blocks(&parents, accumulator);
        }
        accumulator.push(parent_block.clone());
    }
}

fn extend(parent_blocks: &BTreeMap<String, Vec<Rc<RefCell<LNamedBlock>>>>, ast: &LBlock) {
    let mut stack: HashSet<String> = HashSet::new();
    extend_in_nodes(&ast.nodes, parent_blocks, &mut stack);
}

fn extend_in_node(
    node: &LNode,
    parent_blocks: &BTreeMap<String, Vec<Rc<RefCell<LNamedBlock>>>>,
    stack: &mut HashSet<String>,
) {
    let mut pushed_name: Option<String> = None;

    if let LNode::NamedBlock(nb_rc) = node {
        let name = nb_rc.borrow().name.clone();
        if stack.contains(&name) {
            nb_rc.borrow_mut().ignore = Some(true);
        } else {
            stack.insert(name.clone());
            pushed_name = Some(name.clone());

            let mut parent_block_list = Vec::new();
            if let Some(pblocks) = parent_blocks.get(&name) {
                flatten_parent_blocks(pblocks, &mut parent_block_list);
            }

            if !parent_block_list.is_empty() {
                nb_rc.borrow_mut().parents = Some(parent_block_list.clone());
                let mode = nb_rc.borrow().mode.clone();
                let child_nodes = nb_rc.borrow().nodes.clone();

                for parent_block in &parent_block_list {
                    let mut pb = parent_block.borrow_mut();
                    match mode.as_str() {
                        "append" => pb.nodes.extend(child_nodes.clone()),
                        "prepend" => {
                            let mut combined = child_nodes.clone();
                            combined.append(&mut pb.nodes);
                            pb.nodes = combined;
                        }
                        "replace" => pb.nodes = child_nodes.clone(),
                        _ => {}
                    }
                }
            }
        }
    }

    match node {
        LNode::Block(b) => extend_in_nodes(&b.nodes, parent_blocks, stack),
        LNode::NamedBlock(nb_rc) => {
            let children = nb_rc.borrow().nodes.clone();
            extend_in_nodes(&children, parent_blocks, stack);
        }
        LNode::Tag(_, b)
        | LNode::InterpolatedTag(_, b)
        | LNode::BlockComment(_, b)
        | LNode::Filter(_, b)
        | LNode::Case(_, b)
        | LNode::While(_, b)
        | LNode::EachOf(_, b)
        | LNode::Include(_, b) => extend_in_nodes(&b.nodes, parent_blocks, stack),
        LNode::When(_, Some(b)) | LNode::Mixin(_, Some(b)) | LNode::Code(_, Some(b)) => {
            extend_in_nodes(&b.nodes, parent_blocks, stack)
        }
        LNode::Conditional {
            consequent,
            alternate,
            ..
        } => {
            extend_in_nodes(&consequent.nodes, parent_blocks, stack);
            if let Some(alt) = alternate {
                extend_in_node(alt, parent_blocks, stack);
            }
        }
        LNode::Each {
            block, alternate, ..
        } => {
            extend_in_nodes(&block.nodes, parent_blocks, stack);
            if let Some(alt) = alternate {
                extend_in_nodes(&alt.nodes, parent_blocks, stack);
            }
        }
        LNode::When(_, None)
        | LNode::Mixin(_, None)
        | LNode::Code(_, None)
        | LNode::Leaf(_) => {}
    }

    if let Some(name) = pushed_name {
        stack.remove(&name);
    }
}

fn extend_in_nodes(
    nodes: &[LNode],
    parent_blocks: &BTreeMap<String, Vec<Rc<RefCell<LNamedBlock>>>>,
    stack: &mut HashSet<String>,
) {
    for node in nodes {
        extend_in_node(node, parent_blocks, stack);
    }
}

fn apply_includes(mut ast: LBlock) -> Result<LBlock, PugError> {
    ast.nodes = ast
        .nodes
        .into_iter()
        .map(apply_includes_in_node)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ast)
}

fn apply_includes_in_node(mut node: LNode) -> Result<LNode, PugError> {
    if let LNode::Leaf(Node::RawInclude(raw)) = node {
        let val = raw.file.str.unwrap_or_default().replace('\r', "");
        return Ok(LNode::Leaf(Node::Text(TextNode {
            val,
            line: None,
            column: None,
            filename: None,
            is_html: None,
        })));
    }

    node = map_lchildren(node, &mut apply_includes_in_node)?;

    if let LNode::Include(inc, block) = node {
        let child_raw = inc.file.ast.ok_or_else(|| {
            PugError::new(
                "MISSING_INCLUDE_AST",
                format!("Included file \"{}\" does not have a parsed AST", inc.file.path),
                ErrorOptions {
                    line: inc.line as i64,
                    column: inc.column.map(|c| c as i64),
                    filename: inc.filename.clone(),
                    src: None,
                },
            )
        })?;
        let mut child_ast = link_block(LBlock::from_ast(*child_raw))?;
        if child_ast.has_extends == Some(true) {
            child_ast = remove_blocks(child_ast);
        }
        let yielded = apply_yield(child_ast, block);
        return Ok(LNode::Block(yielded));
    }

    Ok(node)
}

fn remove_blocks(mut ast: LBlock) -> LBlock {
    ast.nodes = ast.nodes.into_iter().map(remove_blocks_in_node).collect();
    ast
}

fn remove_blocks_in_node(node: LNode) -> LNode {
    let replaced = match node {
        LNode::NamedBlock(nb_rc) => LNode::Block(LBlock {
            node_type: String::from("Block"),
            nodes: nb_rc.borrow().nodes.clone(),
            line: None,
            column: None,
            filename: None,
            declared_blocks: None,
            has_extends: None,
        }),
        other => other,
    };
    map_lchildren_infallible(replaced, &mut remove_blocks_in_node)
}

fn apply_yield(mut ast: LBlock, block: LBlock) -> LBlock {
    if block.nodes.is_empty() {
        return ast;
    }

    let mut replaced = false;
    ast = apply_yield_walk_block(ast, &block, &mut replaced);

    if !replaced {
        default_yield_location(&mut ast).nodes.push(LNode::Block(block));
    }

    ast
}

fn apply_yield_walk_block(mut ast: LBlock, block: &LBlock, replaced: &mut bool) -> LBlock {
    ast.nodes = ast
        .nodes
        .into_iter()
        .map(|n| apply_yield_walk_node(n, block, replaced))
        .collect();
    ast
}

fn apply_yield_walk_node(node: LNode, block: &LBlock, replaced: &mut bool) -> LNode {
    let mapped = map_lchildren_infallible(node, &mut |child| {
        apply_yield_walk_node(child, block, replaced)
    });
    if let LNode::Leaf(Node::YieldBlock(yb)) = mapped {
        *replaced = true;
        return LNode::Block(LBlock {
            node_type: String::from("Block"),
            nodes: vec![LNode::Block(block.clone())],
            line: Some(yb.line),
            column: yb.column,
            filename: yb.filename,
            declared_blocks: None,
            has_extends: None,
        });
    }
    mapped
}

fn default_yield_location(block: &mut LBlock) -> &mut LBlock {
    let mut target_idx = None;
    for (i, child) in block.nodes.iter().enumerate() {
        if child.text_only() {
            continue;
        }
        match child {
            LNode::Block(_) => target_idx = Some((i, true)),
            other if other.child_block_if_nonempty().is_some() => {
                target_idx = Some((i, false));
            }
            _ => {}
        }
    }

    match target_idx {
        Some((idx, true)) => match &mut block.nodes[idx] {
            LNode::Block(inner) => default_yield_location(inner),
            _ => unreachable!(),
        },
        Some((idx, false)) => {
            let inner = block.nodes[idx]
                .child_block_mut()
                .expect("checked non-empty child block");
            default_yield_location(inner)
        }
        None => block,
    }
}

fn check_extend_position(ast: &LBlock, has_extends: bool) -> Result<(), PugError> {
    let mut legit_extends_reached = false;
    walk_lblock_ref(ast, &mut |node| {
        if let LNode::Leaf(Node::Extends(ext)) = node {
            if has_extends && !legit_extends_reached {
                legit_extends_reached = true;
            } else {
                return Err(PugError::new(
                    "EXTENDS_NOT_FIRST",
                    "Declaration of template inheritance (\"extends\") should be the first thing in the file. There can only be one extends statement per file.",
                    ErrorOptions {
                        line: ext.line as i64,
                        column: ext.column.map(|c| c as i64),
                        filename: ext.filename.clone(),
                        src: None,
                    },
                ));
            }
        }
        Ok(())
    })
}

fn walk_lblock_ref<F>(block: &LBlock, visit: &mut F) -> Result<(), PugError>
where
    F: FnMut(&LNode) -> Result<(), PugError>,
{
    for node in &block.nodes {
        walk_lnode_ref(node, visit)?;
    }
    Ok(())
}

fn walk_lnode_ref<F>(node: &LNode, visit: &mut F) -> Result<(), PugError>
where
    F: FnMut(&LNode) -> Result<(), PugError>,
{
    visit(node)?;
    match node {
        LNode::Block(b)
        | LNode::Tag(_, b)
        | LNode::InterpolatedTag(_, b)
        | LNode::BlockComment(_, b)
        | LNode::Filter(_, b)
        | LNode::Case(_, b)
        | LNode::While(_, b)
        | LNode::EachOf(_, b)
        | LNode::Include(_, b) => walk_lblock_ref(b, visit)?,
        LNode::NamedBlock(nb_rc) => {
            let children = nb_rc.borrow().nodes.clone();
            for child in &children {
                walk_lnode_ref(child, visit)?;
            }
        }
        LNode::When(_, Some(b)) | LNode::Mixin(_, Some(b)) | LNode::Code(_, Some(b)) => {
            walk_lblock_ref(b, visit)?;
        }
        LNode::Conditional {
            consequent,
            alternate,
            ..
        } => {
            walk_lblock_ref(consequent, visit)?;
            if let Some(alt) = alternate {
                walk_lnode_ref(alt, visit)?;
            }
        }
        LNode::Each {
            block, alternate, ..
        } => {
            walk_lblock_ref(block, visit)?;
            if let Some(alt) = alternate {
                walk_lblock_ref(alt, visit)?;
            }
        }
        LNode::When(_, None)
        | LNode::Mixin(_, None)
        | LNode::Code(_, None)
        | LNode::Leaf(_) => {}
    }
    Ok(())
}

fn map_lchildren<F>(node: LNode, f: &mut F) -> Result<LNode, PugError>
where
    F: FnMut(LNode) -> Result<LNode, PugError>,
{
    let map_block = |mut b: LBlock, f: &mut F| -> Result<LBlock, PugError> {
        b.nodes = b.nodes.into_iter().map(f).collect::<Result<Vec<_>, _>>()?;
        Ok(b)
    };

    Ok(match node {
        LNode::Block(b) => LNode::Block(map_block(b, f)?),
        LNode::NamedBlock(nb_rc) => {
            let orig = {
                let mut nb = nb_rc.borrow_mut();
                std::mem::take(&mut nb.nodes)
            };
            let mapped = orig.into_iter().map(f).collect::<Result<Vec<_>, _>>()?;
            nb_rc.borrow_mut().nodes = mapped;
            LNode::NamedBlock(nb_rc)
        }
        LNode::Tag(m, b) => LNode::Tag(m, map_block(b, f)?),
        LNode::InterpolatedTag(m, b) => LNode::InterpolatedTag(m, map_block(b, f)?),
        LNode::BlockComment(m, b) => LNode::BlockComment(m, map_block(b, f)?),
        LNode::Filter(m, b) => LNode::Filter(m, map_block(b, f)?),
        LNode::Case(m, b) => LNode::Case(m, map_block(b, f)?),
        LNode::When(m, b) => LNode::When(m, b.map(|blk| map_block(blk, f)).transpose()?),
        LNode::Conditional {
            meta,
            consequent,
            alternate,
        } => LNode::Conditional {
            meta,
            consequent: map_block(consequent, f)?,
            alternate: alternate.map(|alt| f(*alt).map(Box::new)).transpose()?,
        },
        LNode::While(m, b) => LNode::While(m, map_block(b, f)?),
        LNode::Each {
            meta,
            block,
            alternate,
        } => LNode::Each {
            meta,
            block: map_block(block, f)?,
            alternate: alternate.map(|blk| map_block(blk, f)).transpose()?,
        },
        LNode::EachOf(m, b) => LNode::EachOf(m, map_block(b, f)?),
        LNode::Mixin(m, b) => LNode::Mixin(m, b.map(|blk| map_block(blk, f)).transpose()?),
        LNode::Code(m, b) => LNode::Code(m, b.map(|blk| map_block(blk, f)).transpose()?),
        LNode::Include(m, b) => LNode::Include(m, map_block(b, f)?),
        LNode::Leaf(n) => LNode::Leaf(n),
    })
}

fn map_lchildren_infallible<F>(node: LNode, f: &mut F) -> LNode
where
    F: FnMut(LNode) -> LNode,
{
    map_lchildren(node, &mut |n| Ok(f(n))).expect("infallible map")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pug_ast::{ExtendsNode, FileReferenceNode, IncludeNode, TagNode, YieldBlockNode};

    fn text(val: &str, line: usize, filename: &str) -> Node {
        Node::Text(TextNode {
            val: val.to_string(),
            line: Some(line),
            column: None,
            filename: Some(filename.to_string()),
            is_html: None,
        })
    }

    fn named_block(name: &str, mode: &str, nodes: Vec<Node>, line: usize, filename: &str) -> Node {
        Node::NamedBlock(NamedBlockNode {
            name: name.to_string(),
            mode: mode.to_string(),
            nodes,
            line,
            column: None,
            filename: Some(filename.to_string()),
            parents: None,
            ignore: None,
        })
    }

    fn file_ref(path: &str, line: usize, filename: &str, ast: BlockNode) -> FileReferenceNode {
        let mut f = FileReferenceNode::new(path.to_string(), line, None, Some(filename.to_string()));
        f.ast = Some(Box::new(ast));
        f
    }

    #[test]
    fn extends_not_first_rejected() {
        let parent = BlockNode::empty(0, Some("parent.pug".into()));
        let child = BlockNode::new(
            0,
            vec![
                text("hi", 1, "child.pug"),
                Node::Extends(ExtendsNode {
                    file: file_ref("parent.pug", 2, "child.pug", parent),
                    line: 2,
                    column: None,
                    filename: Some("child.pug".into()),
                }),
            ],
            Some("child.pug".into()),
        );
        let err = link(child).unwrap_err();
        assert_eq!(err.code, "PUG:EXTENDS_NOT_FIRST");
        assert_eq!(err.line, 2);
    }

    #[test]
    fn multi_level_replace_then_append_updates_all_ancestors() {
        let grand = BlockNode::new(
            0,
            vec![named_block(
                "content",
                "replace",
                vec![text("grand", 1, "grand.pug")],
                1,
                "grand.pug",
            )],
            Some("grand.pug".into()),
        );
        let mid = BlockNode::new(
            0,
            vec![
                Node::Extends(ExtendsNode {
                    file: file_ref("grand.pug", 1, "mid.pug", grand),
                    line: 1,
                    column: None,
                    filename: Some("mid.pug".into()),
                }),
                named_block(
                    "content",
                    "replace",
                    vec![text("mid", 2, "mid.pug")],
                    2,
                    "mid.pug",
                ),
            ],
            Some("mid.pug".into()),
        );
        let leaf = BlockNode::new(
            0,
            vec![
                Node::Extends(ExtendsNode {
                    file: file_ref("mid.pug", 1, "leaf.pug", mid),
                    line: 1,
                    column: None,
                    filename: Some("leaf.pug".into()),
                }),
                named_block(
                    "content",
                    "append",
                    vec![text("leaf", 2, "leaf.pug")],
                    2,
                    "leaf.pug",
                ),
            ],
            Some("leaf.pug".into()),
        );

        let linked = link(leaf).expect("link succeeds");
        assert_eq!(linked.has_extends, Some(true));
        let Node::NamedBlock(root_nb) = &linked.nodes[0] else {
            panic!("expected NamedBlock");
        };
        assert_eq!(root_nb.nodes.len(), 2);
        let declared = linked.declared_blocks.as_ref().unwrap().get("content").unwrap();
        assert_eq!(declared[0].nodes.len(), 2);
    }

    #[test]
    fn include_yield_falls_back_to_default_location() {
        let inc_ast = BlockNode::new(
            0,
            vec![Node::Tag(TagNode {
                name: "div".into(),
                self_closing: false,
                block: BlockNode::new(1, vec![text("inner", 1, "inc.pug")], Some("inc.pug".into())),
                attrs: vec![],
                attribute_blocks: vec![],
                is_inline: false,
                line: 1,
                column: None,
                filename: Some("inc.pug".into()),
                code: None,
                text_only: None,
            })],
            Some("inc.pug".into()),
        );
        let main = BlockNode::new(
            0,
            vec![Node::Include(IncludeNode {
                file: file_ref("inc.pug", 1, "main.pug", inc_ast),
                block: BlockNode::new(1, vec![text("yielded", 1, "main.pug")], Some("main.pug".into())),
                line: 1,
                column: None,
                filename: Some("main.pug".into()),
            })],
            Some("main.pug".into()),
        );
        let linked = link(main).expect("include links");
        let Node::Block(inc_block) = &linked.nodes[0] else {
            panic!("expected Block");
        };
        let Node::Tag(div_tag) = &inc_block.nodes[0] else {
            panic!("expected div");
        };
        assert_eq!(div_tag.block.nodes.len(), 2);
    }

    #[test]
    fn explicit_yield_is_replaced_when_include_has_block() {
        let inc_ast = BlockNode::new(
            0,
            vec![Node::YieldBlock(YieldBlockNode {
                line: 2,
                column: None,
                filename: Some("inc.pug".into()),
            })],
            Some("inc.pug".into()),
        );
        let main = BlockNode::new(
            0,
            vec![Node::Include(IncludeNode {
                file: file_ref("inc.pug", 1, "main.pug", inc_ast),
                block: BlockNode::new(1, vec![text("passed", 1, "main.pug")], Some("main.pug".into())),
                line: 1,
                column: None,
                filename: Some("main.pug".into()),
            })],
            Some("main.pug".into()),
        );
        let linked = link(main).expect("include links");
        let Node::Block(inc_block) = &linked.nodes[0] else {
            panic!("expected Block");
        };
        let Node::Block(yield_wrapper) = &inc_block.nodes[0] else {
            panic!("expected replaced Block");
        };
        assert_eq!(yield_wrapper.line, Some(2));
        assert_eq!(yield_wrapper.nodes.len(), 1);
    }
}
