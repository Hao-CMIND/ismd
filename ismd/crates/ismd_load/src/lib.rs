use ismd_ast::{BlockNode, FileReferenceNode, Node, RawContent};
use ismd_error::IsmdError;
use ismd_walk::walk_mut;

/// Result of resolving and reading one dependency (`resolve` -> `read` -> `toString('utf8')`).
#[derive(Debug, Clone)]
pub struct LoadedFile {
    pub full_path: String,
    pub raw: RawContent,
    pub text: String,
}

/// Services required by the loader, matching `raw/compiler/packages/ismd-load/index.js`
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
    ) -> Result<LoadedFile, IsmdError>;

    /// Lex + parse one dependency (including every per-file hook); the loader recurses afterwards.
    fn parse_source(&mut self, src: &str, filename: &str) -> Result<BlockNode, IsmdError>;
}

fn append_location(err: &mut IsmdError, node_filename: Option<&str>, node_line: usize) {
    let suffix = format!(
        "\n    at {} line {}",
        node_filename.unwrap_or("undefined"),
        node_line
    );
    err.message.push_str(&suffix);
}

const MAX_LOAD_DEPTH: usize = 256;

fn normalize_cycle_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    #[cfg(any(windows, target_os = "macos"))]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        normalized
    }
}

/// Recursively loads `include`, raw `include` and `extends` dependencies (`load(ast, options)`).
///
/// The AST is walked in the baseline's `ismd-walk` order without `includeDependencies`, so nested
/// dependencies are loaded when their parent dependency is loaded (depth first).
pub fn load_ast<H: LoadHost + ?Sized>(
    ast: BlockNode,
    host: &mut H,
) -> Result<BlockNode, IsmdError> {
    let mut stack = Vec::new();
    if let Some(fname) = ast.filename.as_deref() {
        if !fname.is_empty() && fname != "undefined" {
            stack.push(normalize_cycle_path(fname));
        }
    }
    load_ast_with_stack(ast, host, &mut stack)
}

fn load_ast_with_stack<H: LoadHost + ?Sized>(
    mut ast: BlockNode,
    host: &mut H,
    stack: &mut Vec<String>,
) -> Result<BlockNode, IsmdError> {
    walk_mut(&mut ast, false, &mut |node: &mut Node| -> Result<bool, IsmdError> {
        let (file, node_filename, node_line, with_ast, is_extends, is_include): (
            &mut FileReferenceNode,
            Option<&str>,
            usize,
            bool,
            bool,
            bool,
        ) = match node {
            Node::Include(n) => (
                &mut n.file,
                n.filename.as_deref(),
                n.line,
                true,
                false,
                true,
            ),
            Node::Extends(n) => (
                &mut n.file,
                n.filename.as_deref(),
                n.line,
                true,
                true,
                false,
            ),
            Node::RawInclude(n) => (
                &mut n.file,
                n.filename.as_deref(),
                n.line,
                false,
                false,
                false,
            ),
            _ => return Ok(true),
        };

        if file.node_type != "FileReference" {
            return Err(IsmdError::host_exception(
                "Expected file.type to be \"FileReference\"",
            ));
        }
        let loaded = host.load_file(
            &file.path,
            file.filename.as_deref(),
            node_filename,
            node_line,
        )?;
        if with_ast {
            let norm = normalize_cycle_path(&loaded.full_path);
            if stack.contains(&norm) {
                let chain = format!("{} -> {}", stack.join(" -> "), loaded.full_path);
                return Err(annotate_load_error(
                    IsmdError::host_exception(format!("Circular include/extends detected: {chain}")),
                    node_filename,
                    node_line,
                ));
            }
            if stack.len() >= MAX_LOAD_DEPTH {
                return Err(annotate_load_error(
                    IsmdError::host_exception(format!(
                        "Maximum include/extends depth ({MAX_LOAD_DEPTH}) exceeded at {}",
                        loaded.full_path
                    )),
                    node_filename,
                    node_line,
                ));
            }
            ismd_ast::profile::with_counters(|c| {
                if is_extends {
                    c.layout_parse_count += 1;
                } else if is_include {
                    c.include_parse_count += 1;
                }
            });
            let parsed = host.parse_source(&loaded.text, &loaded.full_path)?;
            stack.push(norm);
            let nested = load_ast_with_stack(parsed, host, stack);
            stack.pop();
            file.ast = Some(Box::new(nested?));
        }
        file.full_path = Some(loaded.full_path);
        file.str = Some(loaded.text);
        file.raw = Some(loaded.raw);
        Ok(true)
    })?;
    Ok(ast)
}

/// Appends the baseline's `\n    at <filename> line <line>` suffix; exported for host implementations.
pub fn annotate_load_error(mut err: IsmdError, node_filename: Option<&str>, node_line: usize) -> IsmdError {
    append_location(&mut err, node_filename, node_line);
    err
}

#[cfg(test)]
mod tests {
    use super::*;
    use ismd_ast::{IncludeNode, TextNode};

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
        ) -> Result<LoadedFile, IsmdError> {
            self.log.push(format!("load:{path}"));
            if path == "missing.ismd" {
                return Err(annotate_load_error(
                    IsmdError::host_exception("ENOENT"),
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

        fn parse_source(&mut self, src: &str, filename: &str) -> Result<BlockNode, IsmdError> {
            self.log.push(format!("parse:{filename}"));
            Ok(BlockNode::new(
                1,
                vec![Node::Text(TextNode {
                    val: src.to_string(),
                    line: Some(1),
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
            file: FileReferenceNode::new(path.to_string(), 2, Some(1), Some("main.ismd".into())),
            block: BlockNode::empty(2, Some("main.ismd".into())),
            line: 2,
            column: Some(1),
            filename: Some("main.ismd".into()),
        })
    }

    #[test]
    fn loads_include_and_keeps_bytes() {
        let mut host = MemHost { log: vec![] };
        let ast = BlockNode::new(1, vec![include("a.ismd")], Some("main.ismd".into()));
        let out = load_ast(ast, &mut host).unwrap();
        let Node::Include(inc) = &out.nodes[0] else { panic!() };
        assert_eq!(inc.file.full_path.as_deref(), Some("/mem/a.ismd"));
        assert_eq!(inc.file.str.as_deref(), Some("a.ismd"));
        assert_eq!(inc.file.raw, Some(RawContent::Bytes(b"a.ismd".to_vec())));
        assert!(inc.file.ast.is_some());
        assert_eq!(host.log, vec!["load:a.ismd", "parse:/mem/a.ismd"]);
    }

    #[test]
    fn error_message_is_annotated() {
        let mut host = MemHost { log: vec![] };
        let ast = BlockNode::new(1, vec![include("missing.ismd")], Some("main.ismd".into()));
        let err = load_ast(ast, &mut host).unwrap_err();
        assert!(err.message.ends_with("\n    at main.ismd line 2"), "{}", err.message);
    }

    #[test]
    fn raw_content_json_matches_buffer_json() {
        let v = serde_json::to_value(RawContent::Bytes(vec![1, 2, 255])).unwrap();
        assert_eq!(v, serde_json::json!({"type":"Buffer","data":[1,2,255]}));
        let back: RawContent = serde_json::from_value(v).unwrap();
        assert_eq!(back, RawContent::Bytes(vec![1, 2, 255]));

        let b64 = serde_json::json!({"type":"BufferBase64","data":"AQID/w=="});
        let back_b64: RawContent = serde_json::from_value(b64).unwrap();
        assert_eq!(back_b64, RawContent::Bytes(vec![1, 2, 3, 255]));
    }

    #[test]
    fn circular_include_returns_error() {
        struct CycleHost;
        impl LoadHost for CycleHost {
            fn load_file(
                &mut self,
                path: &str,
                _source: Option<&str>,
                _node_filename: Option<&str>,
                _node_line: usize,
            ) -> Result<LoadedFile, IsmdError> {
                Ok(LoadedFile {
                    full_path: format!("/mem/{path}"),
                    raw: RawContent::Bytes(vec![]),
                    text: path.to_string(),
                })
            }

            fn parse_source(&mut self, _src: &str, filename: &str) -> Result<BlockNode, IsmdError> {
                let target = if filename == "/mem/a.ismd" { "b.ismd" } else { "a.ismd" };
                Ok(BlockNode::new(
                    1,
                    vec![Node::Include(IncludeNode {
                        file: FileReferenceNode::new(target.to_string(), 2, Some(1), Some(filename.into())),
                        block: BlockNode::empty(2, Some(filename.into())),
                        line: 2,
                        column: Some(1),
                        filename: Some(filename.into()),
                    })],
                    Some(filename.into()),
                ))
            }
        }

        let mut host = CycleHost;
        let ast = BlockNode::new(
            1,
            vec![Node::Include(IncludeNode {
                file: FileReferenceNode::new("b.ismd".to_string(), 2, Some(1), Some("/mem/a.ismd".into())),
                block: BlockNode::empty(2, Some("/mem/a.ismd".into())),
                line: 2,
                column: Some(1),
                filename: Some("/mem/a.ismd".into()),
            })],
            Some("/mem/a.ismd".into()),
        );
        let err = load_ast(ast, &mut host).unwrap_err();
        assert!(err.message.contains("Circular include/extends"), "{}", err.message);
    }

    #[test]
    fn sibling_includes_of_same_file_succeed() {
        let mut host = MemHost { log: vec![] };
        let ast = BlockNode::new(
            1,
            vec![include("a.ismd"), include("a.ismd")],
            Some("main.ismd".into()),
        );
        let out = load_ast(ast, &mut host).unwrap();
        assert_eq!(out.nodes.len(), 2);
    }
}
