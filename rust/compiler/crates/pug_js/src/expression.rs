use oxc::allocator::Allocator;
use oxc::parser::Parser;
use oxc::span::SourceType;

/// Checks whether `src` is a valid JavaScript expression using Oxc parser
/// (corresponds to `is-expression`, expanded in Step 2).
pub fn is_expression(src: &str) -> bool {
    let allocator = Allocator::default();
    let source_type = SourceType::cjs();
    let parser = Parser::new(&allocator, src, source_type);
    parser.parse_expression().is_ok()
}
