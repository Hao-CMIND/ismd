use ismd_ast::{Node, TextNode};
use ismd_lexer::{GenericSyntaxRule, LexerOptions};
use ismd_parser::ParserOptions;

#[test]
fn arbitrary_prefix_uses_extension_and_all_visitors() {
    let tokens = ismd_lexer::lex(
        "@echo\n  first\n  second",
        &LexerOptions {
            filename: Some("generic.ismd".into()),
            generic_syntax: vec![GenericSyntaxRule {
                rule_id: "arbitrary".into(),
                prefix: "@".into(),
                is_block: true,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(tokens[0].token_type, "extension_start");
    let mut ast = ismd_parser::parse(
        &tokens,
        &ParserOptions {
            filename: Some("generic.ismd".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let Node::Extension(ext) = &ast.nodes[0] else {
        panic!("expected generic Extension")
    };
    assert_eq!(ext.rule_id, "arbitrary");
    assert_eq!(ext.target_name, "echo");
    assert_eq!(ext.raw_content, "first\nsecond");
    assert_eq!(ext.line, 1);
    assert_eq!(ext.column, Some(1));
    assert!(ismd_compiler::store::collect_ast_metadata(&ast).has_extensions);
    let mut visited_extension = false;
    ismd_walk::walk_mut(&mut ast, true, &mut |node| -> Result<bool, String> {
        if matches!(node, Node::Extension(_)) {
            visited_extension = true;
        }
        Ok(true)
    })
    .unwrap();
    assert!(visited_extension);
    let err = ismd_code_gen::generate_code(&ast, &Default::default()).unwrap_err();
    assert!(err.message.contains("Extension"));
    ismd_walk::walk_mut(&mut ast, true, &mut |node| -> Result<bool, String> {
        if let Node::Extension(e) = node {
            *node = Node::Text(TextNode {
                val: e.raw_content.clone(),
                line: Some(e.line),
                column: e.column,
                filename: e.filename.clone(),
                is_html: None,
            });
        }
        Ok(true)
    })
    .unwrap();
    assert!(!ismd_compiler::store::collect_ast_metadata(&ast).has_extensions);
    assert!(ismd_code_gen::generate_code(&ast, &Default::default()).is_ok());
}

#[test]
fn removed_syntax_is_not_accepted_by_lexer_or_ast_deserializer() {
    assert!(ismd_lexer::lex(":unregistered\n  text", &Default::default()).is_err());
    for kind in ["Filter", "IncludeFilter"] {
        assert!(
            serde_json::from_value::<Node>(serde_json::json!({"type":kind,"name":"old","line":1}))
                .is_err()
        );
    }
    assert!(ismd_lexer::lex("div: p ordinary expansion", &Default::default()).is_ok());
}
