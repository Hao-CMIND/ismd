use oxc::allocator::Allocator;
use oxc::ast::ast::{Expression, Statement};
use oxc::parser::{ParseOptions, Parser};
use oxc::semantic::{ScopeId, Scoping, SemanticBuilder};
use oxc::span::SourceType;
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopLevelReturn {
    pub start: usize,
    pub end: usize,
    pub arg_span: Option<(usize, usize)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeAnalysis {
    /// Free variables referenced in the program, sorted in UTF-16 code unit order
    /// matching `with@7.0.2` (`globals.ts`).
    pub free_variables: Vec<String>,
    /// Top-level `return` statements (not nested inside any function/arrow/method).
    pub top_level_returns: Vec<TopLevelReturn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeError {
    pub component: &'static str,
    pub message: String,
}

impl std::fmt::Display for ScopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ScopeError {}

/// Analyzes JavaScript source `src` using Oxc `Parser` + `SemanticBuilder`,
/// returning free variables in deterministic UTF-16 sorted order and top-level `return` spans
/// matching `with@7.0.2` (`globals.ts` + `index.ts`).
pub fn analyze_scope(src: &str, component: &'static str) -> Result<ScopeAnalysis, ScopeError> {
    let _prof_scope = ismd_ast::profile::scope(ismd_ast::profile::Stage::ScopeAnalysis);
    ismd_ast::profile::with_counters(|c| {
        c.scope_analysis_count += 1;
    });
    crate::with_reusable_allocator(|allocator: &Allocator| {
        let parse_opts = ParseOptions {
            allow_return_outside_function: true,
            ..ParseOptions::default()
        };

        let ret = {
            let _prof_oxc = ismd_ast::profile::scope(ismd_ast::profile::Stage::OxcParse);
            ismd_ast::profile::with_counters(|c| {
                c.oxc_parse_count += 1;
            });
            let mut r = Parser::new(allocator, src, SourceType::script())
                .with_options(parse_opts)
                .parse();

            if !r.diagnostics.is_empty() {
                ismd_ast::profile::with_counters(|c| {
                    c.oxc_parse_count += 1;
                });
                let mjs_ret = Parser::new(allocator, src, SourceType::mjs())
                    .with_options(parse_opts)
                    .parse();
                if mjs_ret.diagnostics.is_empty() {
                    r = mjs_ret;
                } else {
                    let err_msg = match component {
                        "obj" => "Error parsing object part of the with expression",
                        _ => "Error parsing body of the with expression",
                    };
                    let detail = r
                        .diagnostics
                        .first()
                        .map(|d| d.message.to_string())
                        .unwrap_or_default();
                    return Err(ScopeError {
                        component,
                        message: if detail.is_empty() {
                            String::from(err_msg)
                        } else {
                            format!("{err_msg}: {detail}")
                        },
                    });
                }
            }
            r
        };

        let semantic_ret = {
            let _prof_sem = ismd_ast::profile::scope(ismd_ast::profile::Stage::OxcSemantic);
            ismd_ast::profile::with_counters(|c| {
                c.oxc_semantic_count += 1;
            });
            SemanticBuilder::new().build(&ret.program)
        };
    let scoping = semantic_ret.semantic.scoping();
    let root_scope = scoping.root_scope_id();

    let mut non_block_stmt_scopes: BTreeSet<ScopeId> = BTreeSet::new();
    let mut top_level_returns = Vec::new();
    for stmt in &ret.program.body {
        collect_stmt_info(stmt, true, &mut top_level_returns, &mut non_block_stmt_scopes);
    }

    let mut free_set: BTreeSet<String> = BTreeSet::new();

    // 1. All truly unresolved references in `Program`
    for (name, ref_ids) in scoping.root_unresolved_references() {
        let s = name.as_str();
        if s == "undefined" {
            continue;
        }
        if s == "arguments" {
            let has_unbound_ref = ref_ids.iter().any(|&ref_id| {
                let ref_scope = scoping.get_reference(ref_id).scope_id();
                !is_inside_non_arrow_fn(scoping, ref_scope, root_scope)
            });
            if !has_unbound_ref {
                continue;
            }
        }
        free_set.insert(String::from(s));
    }

    // 2. Check resolved symbols against `with@7.0.2` scope rules:
    // In `with@7.0.2` (`globals.ts` with `@babel/types` v7):
    // - `isScope` (`t.isFunctionParent`) is true ONLY for Function/Arrow/Method nodes (NOT `Program`).
    // - `isBlockScope` is true ONLY for `BlockStatement` or `isScope` (NOT `Program`, `For*`, `Switch`).
    for symbol_id in scoping.symbol_ids() {
        let name = scoping.symbol_name(symbol_id);
        if name == "undefined" {
            continue;
        }
        let decl_scope = scoping.symbol_scope_id(symbol_id);

        if is_bound_in_with(
            scoping,
            symbol_id,
            decl_scope,
            root_scope,
            &non_block_stmt_scopes,
        ) {
            continue;
        }

        if name == "arguments" {
            let has_unbound_ref = scoping
                .get_resolved_references(symbol_id)
                .any(|r| !is_inside_non_arrow_fn(scoping, r.scope_id(), root_scope));
            if has_unbound_ref {
                free_set.insert(String::from(name));
            }
        } else if scoping.get_resolved_references(symbol_id).next().is_some() {
            free_set.insert(String::from(name));
        }
    }

    let mut free_variables: Vec<String> = free_set.into_iter().collect();
    // Sort by UTF-16 code units matching `with@7.0.2`: `.sort((a, b) => (a.name < b.name ? -1 : 1))`
    free_variables.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

    Ok(ScopeAnalysis {
        free_variables,
        top_level_returns,
    })
    })
}

fn is_inside_non_arrow_fn(scoping: &Scoping, scope_id: ScopeId, root_scope: ScopeId) -> bool {
    scoping.scope_ancestors(scope_id).any(|sid| {
        if sid == root_scope {
            return false;
        }
        let sf = scoping.scope_flags(sid);
        sf.is_function() && !sf.is_arrow()
    })
}

fn is_bound_in_with(
    scoping: &Scoping,
    symbol_id: oxc::semantic::SymbolId,
    decl_scope: ScopeId,
    root_scope: ScopeId,
    non_block_stmt_scopes: &BTreeSet<ScopeId>,
) -> bool {
    if decl_scope == root_scope {
        return false;
    }

    let flags = scoping.symbol_flags(symbol_id);
    if flags.is_catch_variable() {
        return true;
    }

    // `var`, `function`, `class`, and `import` only bind in `isScope` (`FunctionParent`, not `Program`)
    if (flags.is_function_scoped_declaration() && !flags.is_block_scoped())
        || flags.is_function()
        || flags.is_class()
        || flags.is_import()
    {
        return scoping
            .scope_ancestors(decl_scope)
            .filter(|&s| s != root_scope)
            .any(|s| scoping.scope_flags(s).is_function());
    }

    // `let` and `const` (and function params) bind in `isBlockScope` (`BlockStatement` or `FunctionParent`)
    scoping
        .scope_ancestors(decl_scope)
        .filter(|&s| s != root_scope)
        .any(|s| {
            let sf = scoping.scope_flags(s);
            sf.is_function() || sf.is_catch_clause() || !non_block_stmt_scopes.contains(&s)
        })
}

/// Uses Oxc parser + `SemanticBuilder` to find free variables in `js_code`
/// that are not in `ignored_globals`.
pub fn find_free_variables(js_code: &str, ignored_globals: &[String]) -> Vec<String> {
    let Ok(analysis) = analyze_scope(js_code, "src") else {
        return Vec::new();
    };
    analysis
        .free_variables
        .into_iter()
        .filter(|v| !ignored_globals.iter().any(|g| g == v))
        .collect()
}

/// Checks if `name` is a valid standalone JavaScript identifier expression.
pub fn is_valid_js_identifier(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed != name {
        return false;
    }
    let _prof_oxc = ismd_ast::profile::scope(ismd_ast::profile::Stage::OxcParse);
    ismd_ast::profile::with_counters(|c| {
        c.oxc_parse_count += 1;
    });
    crate::with_reusable_allocator(|allocator: &Allocator| {
        let Ok(expr) = Parser::new(allocator, name, SourceType::script()).parse_expression() else {
            return false;
        };
        matches!(expr, Expression::Identifier(_))
    })
}

fn collect_stmt_info(
    stmt: &Statement<'_>,
    at_top_level_fn: bool,
    returns: &mut Vec<TopLevelReturn>,
    non_block_scopes: &mut BTreeSet<ScopeId>,
) {
    match stmt {
        Statement::ReturnStatement(ret) => {
            if at_top_level_fn {
                let arg_span = ret.argument.as_ref().map(|e| {
                    use oxc::span::GetSpan;
                    let s = e.span();
                    (s.start as usize, s.end as usize)
                });
                returns.push(TopLevelReturn {
                    start: ret.span.start as usize,
                    end: ret.span.end as usize,
                    arg_span,
                });
            }
        }
        Statement::BlockStatement(block) => {
            for s in &block.body {
                collect_stmt_info(s, at_top_level_fn, returns, non_block_scopes);
            }
        }
        Statement::IfStatement(if_stmt) => {
            collect_stmt_info(&if_stmt.consequent, at_top_level_fn, returns, non_block_scopes);
            if let Some(ref alt) = if_stmt.alternate {
                collect_stmt_info(alt, at_top_level_fn, returns, non_block_scopes);
            }
        }
        Statement::SwitchStatement(sw) => {
            if let Some(sid) = sw.scope_id.get() {
                non_block_scopes.insert(sid);
            }
            for case in &sw.cases {
                for s in &case.consequent {
                    collect_stmt_info(s, at_top_level_fn, returns, non_block_scopes);
                }
            }
        }
        Statement::WhileStatement(w) => {
            collect_stmt_info(&w.body, at_top_level_fn, returns, non_block_scopes);
        }
        Statement::DoWhileStatement(dw) => {
            collect_stmt_info(&dw.body, at_top_level_fn, returns, non_block_scopes);
        }
        Statement::ForStatement(f) => {
            if let Some(sid) = f.scope_id.get() {
                non_block_scopes.insert(sid);
            }
            collect_stmt_info(&f.body, at_top_level_fn, returns, non_block_scopes);
        }
        Statement::ForInStatement(fi) => {
            if let Some(sid) = fi.scope_id.get() {
                non_block_scopes.insert(sid);
            }
            collect_stmt_info(&fi.body, at_top_level_fn, returns, non_block_scopes);
        }
        Statement::ForOfStatement(fo) => {
            if let Some(sid) = fo.scope_id.get() {
                non_block_scopes.insert(sid);
            }
            collect_stmt_info(&fo.body, at_top_level_fn, returns, non_block_scopes);
        }
        Statement::LabeledStatement(lbl) => {
            collect_stmt_info(&lbl.body, at_top_level_fn, returns, non_block_scopes);
        }
        Statement::WithStatement(w) => {
            collect_stmt_info(&w.body, at_top_level_fn, returns, non_block_scopes);
        }
        Statement::TryStatement(t) => {
            for s in &t.block.body {
                collect_stmt_info(s, at_top_level_fn, returns, non_block_scopes);
            }
            if let Some(ref handler) = t.handler {
                for s in &handler.body.body {
                    collect_stmt_info(s, at_top_level_fn, returns, non_block_scopes);
                }
            }
            if let Some(ref finalizer) = t.finalizer {
                for s in &finalizer.body {
                    collect_stmt_info(s, at_top_level_fn, returns, non_block_scopes);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_arguments_scope_rules() {
        let a1 = analyze_scope("function f() { return arguments[0]; } f();", "src").unwrap();
        assert_eq!(a1.free_variables, vec!["f"]);

        let a2 = analyze_scope("function f() { return (() => arguments[0])(); } f();", "src").unwrap();
        assert_eq!(a2.free_variables, vec!["f"]);

        let a3 = analyze_scope("const f = () => arguments[0]; f();", "src").unwrap();
        assert_eq!(a3.free_variables, vec!["arguments", "f"]);

        let a4 = analyze_scope("function f() { return arguments[0]; } x = arguments; f();", "src").unwrap();
        assert_eq!(a4.free_variables, vec!["arguments", "f", "x"]);

        let a5 = analyze_scope("function f(arguments) { return arguments; } f();", "src").unwrap();
        assert_eq!(a5.free_variables, vec!["f"]);

        let a6 = analyze_scope("var arguments = 1; function f() { return arguments[0]; } f();", "src").unwrap();
        assert_eq!(a6.free_variables, vec!["f"]);
    }
}
