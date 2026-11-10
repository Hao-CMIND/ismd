use pug_ast::{BlockNode, FileReferenceNode, Node, RawContent};
use pug_error::PugError;
use pug_walk::{ReplaceContext, WalkOptions, walk_ast};
use std::cell::RefCell;

/// Result of resolving and reading one dependency (`resolve` -> `read` -> `toString('utf8')`).
#[derive(Debug, Clone)]
pub struct LoadedFile {
    pub full_path: String,
    pub raw: RawContent,
    pub text: String,
}

/// Services required by the loader, matching `raw/compiler/packages/pug-load/index.js`
/// (`options.resolve`, `options.read`, and `load.string` = `options.lex` + `options.parse`).
pub trait LoadHost {
    /// `path = resolve(file.path, file.filename, options); raw = read(path, options); str = raw.toString('utf8')`.
    ///
    /// Implementations are responsible for appending `\n    at <node.filename> line <node.line>` to the
    /// message of any error raised while resolving, reading or decoding (the baseline mutates `ex.message`).
    fn load_file(
        &mut self,
        path: &str,
        source: Option<&str>,
        node_filename: Option<&str>,
        node_line: usize,
    ) -> Result<LoadedFile, PugError>;

    /// Lex + parse one dependency (including every per-file hook); the loader recurses afterwards.
    fn parse_source(&mut self, src: &str, filename: &str) -> Result<BlockNode, PugError>;
}

fn append_location(err: &mut PugError, node_filename: Option<&str>, node_line: usize) {
    let suffix = format!(
        "\n    at {} line {}",
        node_filename.unwrap_or("undefined"),
        node_line
    );
    err.message.push_str(&suffix);
}

/// Recursively loads `include`, raw `include` and `extends` dependencies (`load(ast, options)`).
///
/// The AST is walked in the baseline's `pug-walk` order without `includeDependencies`, so nested
/// dependencies are loaded when their parent dependency is loaded (depth first).
pub fn load_ast<H: LoadHost + ?Sized>(
    ast: BlockNode,
    host: &mut H,
) -> Result<BlockNode, PugError> {
    let pending: RefCell<Option<PugError>> = RefCell::new(None);

    let mut before = |node: &Node, ctx: &mut ReplaceContext, _parents: &[Node]| -> Result<bool, String> {
        let (file, node_filename, node_line, with_ast): (&FileReferenceNode, Option<&str>, usize, bool) =
            match node {
                Node::Include(n) => (&n.file, n.filename.as_deref(), n.line, true),
                Node::Extends(n) => (&n.file, n.filename.as_deref(), n.line, true),
                Node::RawInclude(n) => (&n.file, n.filename.as_deref(), n.line, false),
                _ => return Ok(true),
            };

        let result: Result<FileReferenceNode, PugError> = (|| {
            if file.node_type != "FileReference" {
                return Err(PugError::host_exception(
                    "Expected file.type to be \"FileReference\"",
                ));
            }
            let mut file = file.clone();
            let loaded = host.load_file(&file.path, file.filename.as_deref(), node_filename, node_line)?;
            file.full_path = Some(loaded.full_path.clone());
            file.str = Some(loaded.text.clone());
            file.raw = Some(loaded.raw);
            if with_ast {
                let parsed = host.parse_source(&loaded.text, &loaded.full_path)?;
                file.ast = Some(Box::new(load_ast(parsed, host)?));
            }
            Ok(file)
        })();

        match result {
            Ok(new_file) => {
                let mut updated = node.clone();
                match &mut updated {
                    Node::Include(n) => n.file = new_file,
                    Node::Extends(n) => n.file = new_file,
                    Node::RawInclude(n) => n.file = new_file,
                    _ => {}
                }
                ctx.replace_single(updated);
                Ok(true)
            }
            Err(e) => {
                let message = e.message.clone();
                *pending.borrow_mut() = Some(e);
                Err(message)
            }
        }
    };
    let mut after = |_n: &Node, _c: &mut ReplaceContext, _p: &[Node]| -> Result<(), String> { Ok(()) };

    let mut parents: Vec<Node> = Vec::new();
    let walked = walk_ast(
        Node::Block(ast),
        &mut before,
        &mut after,
        &WalkOptions::default(),
        &mut parents,
    );
    match walked {
        Ok(outcome) => outcome
            .into_block()
            .map_err(PugError::host_exception),
        Err(msg) => Err(pending
            .into_inner()
            .unwrap_or_else(|| PugError::host_exception(msg))),
    }
}

/// Appends the baseline's `\n    at <filename> line <line>` suffix; exported for host implementations.
pub fn annotate_load_error(mut err: PugError, node_filename: Option<&str>, node_line: usize) -> PugError {
    append_location(&mut err, node_filename, node_line);
    err
}

#[cfg(test)]
mod tests {
    use super::*;
    use pug_ast::{IncludeNode, TextNode};

    struct MemHost {
        log: Vec<String>,
    }

    impl LoadHost for MemHost {
        fn load_file(
            &mut self,
            path: &str,
            _source: Option<&str>,
            node_filename: Option<&str>,
            node_line: usize,
        ) -> Result<LoadedFile, PugError> {
            self.log.push(format!("load:{path}"));
            if path == "missing.pug" {
                return Err(annotate_load_error(
                    PugError::host_exception("ENOENT"),
                    node_filename,
                    node_line,
                ));
            }
            Ok(LoadedFile {
                full_path: format!("/mem/{path}"),
                raw: RawContent::Bytes(path.as_bytes().to_vec()),
                text: path.to_string(),
            })
        }

        fn parse_source(&mut self, src: &str, filename: &str) -> Result<BlockNode, PugError> {
            self.log.push(format!("parse:{filename}"));
            Ok(BlockNode::new(
                1,
                vec![Node::Text(TextNode {
                    val: src.to_string(),
                    line: 1,
                    column: Some(1),
                    filename: Some(filename.to_string()),
                    is_html: None,
                })],
                Some(filename.to_string()),
            ))
        }
    }

    fn include(path: &str) -> Node {
        Node::Include(IncludeNode {
            file: FileReferenceNode::new(path.to_string(), 2, Some(1), Some("main.pug".into())),
            block: BlockNode::empty(2, Some("main.pug".into())),
            line: 2,
            column: Some(1),
            filename: Some("main.pug".into()),
        })
    }

    #[test]
    fn loads_include_and_keeps_bytes() {
        let mut host = MemHost { log: vec![] };
        let ast = BlockNode::new(1, vec![include("a.pug")], Some("main.pug".into()));
        let out = load_ast(ast, &mut host).unwrap();
        let Node::Include(inc) = &out.nodes[0] else { panic!() };
        assert_eq!(inc.file.full_path.as_deref(), Some("/mem/a.pug"));
        assert_eq!(inc.file.str.as_deref(), Some("a.pug"));
        assert_eq!(inc.file.raw, Some(RawContent::Bytes(b"a.pug".to_vec())));
        assert!(inc.file.ast.is_some());
        assert_eq!(host.log, vec!["load:a.pug", "parse:/mem/a.pug"]);
    }

    #[test]
    fn error_message_is_annotated() {
        let mut host = MemHost { log: vec![] };
        let ast = BlockNode::new(1, vec![include("missing.pug")], Some("main.pug".into()));
        let err = load_ast(ast, &mut host).unwrap_err();
        assert!(err.message.ends_with("\n    at main.pug line 2"), "{}", err.message);
    }

    #[test]
    fn raw_content_json_matches_buffer_json() {
        let v = serde_json::to_value(RawContent::Bytes(vec![1, 2, 255])).unwrap();
        assert_eq!(v, serde_json::json!({"type":"Buffer","data":[1,2,255]}));
        let back: RawContent = serde_json::from_value(v).unwrap();
        assert_eq!(back, RawContent::Bytes(vec![1, 2, 255]));
    }
}
