use pug_ast::{Node, TextNode};
use pug_lexer::{GenericSyntaxRule, LexerOptions};
use pug_parser::ParserOptions;

#[test]
fn arbitrary_prefix_uses_extension_and_all_visitors() {
    let tokens = pug_lexer::lex(
        "@echo\n  first\n  second",
        &LexerOptions {
            filename: Some("generic.pug".into()),
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
    let mut ast = pug_parser::parse(
        &tokens,
        &ParserOptions {
            filename: Some("generic.pug".into()),
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
    assert!(pug_compiler::store::collect_ast_metadata(&ast).has_extensions);
    let json = serde_json::to_value(&ast).unwrap();
    let mut visited = Vec::new();
    pug_walk::walk_json_ast(
        json,
        &mut |node, _, _| {
            visited.push(node["type"].as_str().unwrap().to_string());
            Ok((true, None))
        },
        &mut |_, _, _| Ok(None),
        true,
        &mut Vec::new(),
    )
    .unwrap();
    assert!(visited.iter().any(|n| n == "Extension"));
    let err = pug_code_gen::generate_code(&ast, &Default::default()).unwrap_err();
    assert!(err.message.contains("Extension"));
    pug_walk::walk_mut(&mut ast, true, &mut |node| -> Result<bool, String> {
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
    assert!(!pug_compiler::store::collect_ast_metadata(&ast).has_extensions);
    assert!(pug_code_gen::generate_code(&ast, &Default::default()).is_ok());
}

#[test]
fn removed_syntax_is_not_accepted_by_lexer_or_ast_deserializer() {
    assert!(pug_lexer::lex(":unregistered\n  text", &Default::default()).is_err());
    for kind in ["Filter", "IncludeFilter"] {
        assert!(
            serde_json::from_value::<Node>(serde_json::json!({"type":kind,"name":"old","line":1}))
                .is_err()
        );
    }
    assert!(pug_lexer::lex("div: p ordinary expansion", &Default::default()).is_ok());
}
