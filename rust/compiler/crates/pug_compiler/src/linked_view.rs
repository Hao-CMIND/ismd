use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use pug_ast::profile::{Stage, record_file, scope, with_counters};
use pug_ast::{
    BlockNode, IncludeNode, MixinNode, NamedBlockNode, Node, RawIncludeNode,
};
use pug_code_gen::{CodeGenOptions, IncludedView, LinkedAstOverlay, generate_code_with_overlay};
use pug_error::{ErrorOptions, PugError};
use pug_load::annotate_load_error;

use crate::dag::DependencyEdge;
use crate::store::{
    ParseKey, ParsedTemplate, SourceEntry, ast_has_extends, collect_ast_metadata, hash_bytes,
    normalize_cache_path,
};
use crate::{
    CompileOptions, CompileResult, CompilerHost, FileCtx, TemplateStore, default_resolve,
    io_read_error, lex_strip_and_parse_with_store,
};

struct LoadedTemplate {
    parsed: Arc<ParsedTemplate>,
    #[allow(dead_code)]
    source_entry: Option<Arc<SourceEntry>>,
}

struct ViewArena {
    templates: Vec<LoadedTemplate>,
    raw_texts: Vec<Arc<str>>,
    normalized_raw_strings: Vec<String>,
}

impl ViewArena {
    fn new() -> Self {
        Self {
            templates: Vec::new(),
            raw_texts: Vec::new(),
            normalized_raw_strings: Vec::new(),
        }
    }
}

struct LinkedView<'ast> {
    segments: HashMap<usize, Vec<&'ast [Node]>>,
    ignored_blocks: HashSet<usize>,
    includes: HashMap<usize, IncludedView<'ast>>,
    raw_includes: HashMap<usize, &'ast str>,
    prepended_mixins: Vec<&'ast MixinNode>,
}

impl<'ast> LinkedAstOverlay<'ast> for LinkedView<'ast> {
    fn named_block_segments(&self, nb: &NamedBlockNode) -> Option<&[&'ast [Node]]> {
        let ptr = nb as *const NamedBlockNode as usize;
        self.segments.get(&ptr).map(Vec::as_slice)
    }

    fn is_named_block_ignored(&self, nb: &NamedBlockNode) -> bool {
        let ptr = nb as *const NamedBlockNode as usize;
        self.ignored_blocks.contains(&ptr)
    }

    fn resolve_include(&self, inc: &IncludeNode) -> Option<IncludedView<'ast>> {
        let ptr = inc as *const IncludeNode as usize;
        self.includes.get(&ptr).copied()
    }

    fn resolve_raw_include(&self, raw: &RawIncludeNode) -> Option<&'ast str> {
        let ptr = raw as *const RawIncludeNode as usize;
        self.raw_includes.get(&ptr).copied()
    }

    fn prepended_mixins(&self) -> &[&'ast MixinNode] {
        &self.prepended_mixins
    }
}

pub(crate) fn try_compile_linked_view<H: CompilerHost>(
    source: &str,
    options: &CompileOptions,
    host: &mut H,
    store: &TemplateStore,
) -> Result<Option<CompileResult>, PugError> {
    if !host.supports_linked_view() || !options.lex_plugin_methods.is_empty() {
        return Ok(None);
    }

    let mut dependencies: Vec<String> = Vec::new();
    let mut debug_sources: Vec<(String, String)> = Vec::new();
    if options.include_sources {
        record_source(
            &mut debug_sources,
            options
                .filename
                .clone()
                .unwrap_or_else(|| String::from("undefined")),
            source.to_string(),
        );
    }

    // 1. Parse/fetch entry template into Arc<ParsedTemplate> without cloning AST.
    let entry_parsed =
        get_or_parse_entry_arc(source, options.filename.as_deref(), options, host, store)?;
    if entry_parsed.has_filters {
        return Ok(None);
    }

    let mut arena = ViewArena::new();
    let entry_idx = arena.templates.len();
    arena.templates.push(LoadedTemplate {
        parsed: Arc::clone(&entry_parsed),
        source_entry: None,
    });

    // 2. Recursively load all Extends / Include / RawInclude dependencies via TemplateStore.
    // Store indices instead of borrowing across arena growth.
    let mut extends_targets: HashMap<usize, usize> = HashMap::new();
    let mut include_targets: HashMap<usize, usize> = HashMap::new();
    let mut raw_include_targets: HashMap<usize, RawStringRef> = HashMap::new();

    {
        let _g = scope(Stage::Loader);
        if !load_template_deps(
            entry_idx,
            &mut arena,
            options,
            host,
            store,
            &mut dependencies,
            &mut debug_sources,
            &mut extends_targets,
            &mut include_targets,
            &mut raw_include_targets,
        )? {
            return Ok(None);
        }
    }

    // Record resolved direct edges for all visited templates into the dependency DAG.
    for tpl in &arena.templates {
        if tpl.parsed.id.0 == 0 {
            continue;
        }
        let mut edges = Vec::with_capacity(tpl.parsed.direct_dependencies.len());
        let fallback_source = (!tpl.parsed.filename.is_empty()).then_some(&*tpl.parsed.filename);
        for dep in &tpl.parsed.direct_dependencies {
            let source = dep.from_filename.as_deref().or(fallback_source);
            if let Ok(full_path) =
                store.resolve_path(&dep.raw_path, source, options.basedir.as_deref(), || {
                    default_resolve(&dep.raw_path, source, options.basedir.as_deref())
                })
            {
                let target = store.get_or_alloc_id(&full_path);
                edges.push(DependencyEdge {
                    target,
                    kind: dep.kind,
                });
            }
        }
        store.dag().set_dependencies(tpl.parsed.id, edges);
    }

    // Check if any loaded template has filters; if so, fall back to mutable pipeline.
    if arena.templates.iter().any(|t| t.parsed.has_filters) {
        return Ok(None);
    }

    // Check if any Include points to a template with Extends (rare edge case handled by pug_linker::remove_blocks).
    for &target_idx in include_targets.values() {
        if ast_has_extends(&arena.templates[target_idx].parsed.ast) {
            return Ok(None);
        }
    }

    // Check if any Extends/Include/NamedBlock exists at all; if not, we still run generate_code_with_overlay
    // with an empty LinkedView (0 AST clones).
    // Pin arena vectors by moving them out or taking stable references after all pushes are done.
    // All pushes to `arena` are complete now!
    // Safety: `arena` is not mutated after this point, and we only hold `&'ast` references
    // derived from `Arc::as_ptr` / `arena` slices for the duration of `try_compile_linked_view`.
    // Wait: we can do this with 100% safe Rust by borrowing `&arena`!
    let (root_ast, view) = {
        let _g = scope(Stage::Linker);
        build_linked_view(
            entry_idx,
            &arena,
            &extends_targets,
            &include_targets,
            &raw_include_targets,
        )?
    };

    let debug_sources_json = if options.include_sources {
        Some(pug_js::escape_js_stringify_chars(&crate::debug_sources_json(
            &debug_sources,
        )))
    } else {
        None
    };
    let code_gen_opts = CodeGenOptions {
        compile_debug: options.compile_debug,
        pretty: options.pretty.clone(),
        doctype: options.doctype.clone(),
        inline_runtime_functions: options.inline_runtime_functions,
        globals: options.globals.clone(),
        use_self: options.use_self,
        include_sources: options.include_sources,
        debug_sources_json,
        template_name: if options.template_name.is_empty() {
            String::from("template")
        } else {
            options.template_name.clone()
        },
        filename: options.filename.clone(),
        src: Some(source.to_string()),
    };

    let js = {
        let _g = scope(Stage::Codegen);
        generate_code_with_overlay(root_ast, &code_gen_opts, &view)?
    };
    let js = host.post_code_gen(js)?;

    Ok(Some(CompileResult {
        body: js,
        dependencies,
    }))
}

#[derive(Clone, Copy)]
enum RawStringRef {
    ArcText(usize),
    Normalized(usize),
}

fn record_source(debug_sources: &mut Vec<(String, String)>, key: String, text: String) {
    if let Some(entry) = debug_sources.iter_mut().find(|(k, _)| *k == key) {
        entry.1 = text;
    } else {
        debug_sources.push((key, text));
    }
}

fn get_or_parse_entry_arc<H: CompilerHost>(
    src: &str,
    filename: Option<&str>,
    options: &CompileOptions,
    host: &mut H,
    store: &TemplateStore,
) -> Result<Arc<ParsedTemplate>, PugError> {
    if let Some(fname) = filename {
        let id = store.get_or_alloc_id(fname);
        let content_hash = hash_bytes(src.as_bytes());
        let byte_len = src.len() as u64;
        let key = ParseKey {
            normalized_path: normalize_cache_path(fname),
            filename: fname.to_string(),
            content_hash,
            byte_len,
            source_version: 0,
            lex_plugin_methods: Vec::new(),
        };
        if let Some(cached) = store.get_parsed(&key) {
            with_counters(|c| c.parse_cache_hit_count += 1);
            record_file(Some(fname), |fc| fc.parse_cache_hit_count += 1);
            for w in &cached.warnings {
                host.warn(w);
            }
            return Ok(cached);
        }
        let (ast, warnings) = lex_strip_and_parse_with_store(src, Some(fname), options, host, false)?;
        for w in &warnings {
            host.warn(w);
        }
        let meta = collect_ast_metadata(&ast);
        return Ok(store.insert_parsed(
            key,
            ParsedTemplate {
                id,
                source_version: 0,
                content_hash,
                filename: Arc::from(fname),
                ast: Arc::new(ast),
                direct_dependencies: meta.dependencies,
                declared_blocks: meta.declared_blocks,
                has_filters: meta.has_filters,
                has_yield: meta.has_yield,
                warnings,
            },
        ));
    }

    let (ast, warnings) = lex_strip_and_parse_with_store(src, None, options, host, true)?;
    let ctx = FileCtx { filename: None, src };
    for w in &warnings {
        host.warn(w);
    }
    let ast = host.post_parse(ast, &ctx)?;
    let ast = host.pre_load(ast, &ctx)?;
    let meta = collect_ast_metadata(&ast);
    Ok(Arc::new(ParsedTemplate {
        id: crate::TemplateId(0),
        source_version: 0,
        content_hash: hash_bytes(src.as_bytes()),
        filename: Arc::from(""),
        ast: Arc::new(ast),
        direct_dependencies: meta.dependencies,
        declared_blocks: meta.declared_blocks,
        has_filters: meta.has_filters,
        has_yield: meta.has_yield,
        warnings,
    }))
}

fn load_and_parse_disk_arc<H: CompilerHost>(
    full_path: &str,
    entry: &Arc<SourceEntry>,
    options: &CompileOptions,
    host: &mut H,
    store: &TemplateStore,
) -> Result<Arc<ParsedTemplate>, PugError> {
    let key = ParseKey {
        normalized_path: normalize_cache_path(full_path),
        filename: full_path.to_string(),
        content_hash: entry.content_hash,
        byte_len: entry.byte_len,
        source_version: entry.version,
        lex_plugin_methods: Vec::new(),
    };
    if let Some(cached) = store.get_parsed(&key) {
        with_counters(|c| c.parse_cache_hit_count += 1);
        record_file(Some(full_path), |fc| fc.parse_cache_hit_count += 1);
        for w in &cached.warnings {
            host.warn(w);
        }
        return Ok(cached);
    }
    let (ast, warnings) =
        lex_strip_and_parse_with_store(&entry.text, Some(full_path), options, host, false)?;
    for w in &warnings {
        host.warn(w);
    }
    let meta = collect_ast_metadata(&ast);
    Ok(store.insert_parsed(
        key,
        ParsedTemplate {
            id: entry.id,
            source_version: entry.version,
            content_hash: entry.content_hash,
            filename: Arc::from(full_path),
            ast: Arc::new(ast),
            direct_dependencies: meta.dependencies,
            declared_blocks: meta.declared_blocks,
            has_filters: meta.has_filters,
            has_yield: meta.has_yield,
            warnings,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn load_template_deps<H: CompilerHost>(
    tpl_idx: usize,
    arena: &mut ViewArena,
    options: &CompileOptions,
    host: &mut H,
    store: &TemplateStore,
    dependencies: &mut Vec<String>,
    debug_sources: &mut Vec<(String, String)>,
    extends_targets: &mut HashMap<usize, usize>,
    include_targets: &mut HashMap<usize, usize>,
    raw_include_targets: &mut HashMap<usize, RawStringRef>,
) -> Result<bool, PugError> {
    let ast = Arc::clone(&arena.templates[tpl_idx].parsed.ast);
    load_block_deps(
        &ast,
        arena,
        options,
        host,
        store,
        dependencies,
        debug_sources,
        extends_targets,
        include_targets,
        raw_include_targets,
    )
}

#[allow(clippy::too_many_arguments)]
fn load_block_deps<H: CompilerHost>(
    block: &BlockNode,
    arena: &mut ViewArena,
    options: &CompileOptions,
    host: &mut H,
    store: &TemplateStore,
    dependencies: &mut Vec<String>,
    debug_sources: &mut Vec<(String, String)>,
    extends_targets: &mut HashMap<usize, usize>,
    include_targets: &mut HashMap<usize, usize>,
    raw_include_targets: &mut HashMap<usize, RawStringRef>,
) -> Result<bool, PugError> {
    for node in &block.nodes {
        if !load_node_deps(
            node,
            arena,
            options,
            host,
            store,
            dependencies,
            debug_sources,
            extends_targets,
            include_targets,
            raw_include_targets,
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn load_node_deps<H: CompilerHost>(
    node: &Node,
    arena: &mut ViewArena,
    options: &CompileOptions,
    host: &mut H,
    store: &TemplateStore,
    dependencies: &mut Vec<String>,
    debug_sources: &mut Vec<(String, String)>,
    extends_targets: &mut HashMap<usize, usize>,
    include_targets: &mut HashMap<usize, usize>,
    raw_include_targets: &mut HashMap<usize, RawStringRef>,
) -> Result<bool, PugError> {
    match node {
        Node::Extends(ext) => {
            if ext.file.node_type != "FileReference" {
                return Err(PugError::host_exception(
                    "Expected file.type to be \"FileReference\"",
                ));
            }
            let (full_path, entry) = resolve_and_load_disk(
                &ext.file.path,
                ext.file.filename.as_deref(),
                ext.filename.as_deref(),
                ext.line,
                options,
                store,
                dependencies,
                debug_sources,
            )?;
            with_counters(|c| c.layout_parse_count += 1);
            let parsed = load_and_parse_disk_arc(&full_path, &entry, options, host, store)?;
            if parsed.has_filters {
                return Ok(false);
            }
            let target_idx = arena.templates.len();
            arena.templates.push(LoadedTemplate {
                parsed,
                source_entry: Some(entry),
            });
            extends_targets.insert(ext as *const _ as usize, target_idx);
            if !load_template_deps(
                target_idx,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            )? {
                return Ok(false);
            }
        }
        Node::Include(inc) => {
            if inc.file.node_type != "FileReference" {
                return Err(PugError::host_exception(
                    "Expected file.type to be \"FileReference\"",
                ));
            }
            let (full_path, entry) = resolve_and_load_disk(
                &inc.file.path,
                inc.file.filename.as_deref(),
                inc.filename.as_deref(),
                inc.line,
                options,
                store,
                dependencies,
                debug_sources,
            )?;
            with_counters(|c| c.include_parse_count += 1);
            let parsed = load_and_parse_disk_arc(&full_path, &entry, options, host, store)?;
            if parsed.has_filters {
                return Ok(false);
            }
            let target_idx = arena.templates.len();
            arena.templates.push(LoadedTemplate {
                parsed,
                source_entry: Some(entry),
            });
            include_targets.insert(inc as *const IncludeNode as usize, target_idx);
            if !load_template_deps(
                target_idx,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            )? {
                return Ok(false);
            }
            if !load_block_deps(
                &inc.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            )? {
                return Ok(false);
            }
        }
        Node::RawInclude(raw) => {
            if !raw.filters.is_empty() {
                return Ok(false);
            }
            if raw.file.node_type != "FileReference" {
                return Err(PugError::host_exception(
                    "Expected file.type to be \"FileReference\"",
                ));
            }
            let (_full_path, entry) = resolve_and_load_disk(
                &raw.file.path,
                raw.file.filename.as_deref(),
                raw.filename.as_deref(),
                raw.line,
                options,
                store,
                dependencies,
                debug_sources,
            )?;
            let raw_ref = if entry.text.contains('\r') {
                let idx = arena.normalized_raw_strings.len();
                arena
                    .normalized_raw_strings
                    .push(entry.text.replace('\r', ""));
                RawStringRef::Normalized(idx)
            } else {
                let idx = arena.raw_texts.len();
                arena.raw_texts.push(Arc::clone(&entry.text));
                RawStringRef::ArcText(idx)
            };
            raw_include_targets.insert(raw as *const RawIncludeNode as usize, raw_ref);
        }
        Node::Block(b) => {
            if !load_block_deps(
                b,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            )? {
                return Ok(false);
            }
        }
        Node::NamedBlock(nb) => {
            for child in &nb.nodes {
                if !load_node_deps(
                    child,
                    arena,
                    options,
                    host,
                    store,
                    dependencies,
                    debug_sources,
                    extends_targets,
                    include_targets,
                    raw_include_targets,
                )? {
                    return Ok(false);
                }
            }
        }
        Node::Tag(t) => {
            return load_block_deps(
                &t.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            );
        }
        Node::InterpolatedTag(t) => {
            return load_block_deps(
                &t.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            );
        }
        Node::BlockComment(bc) => {
            return load_block_deps(
                &bc.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            );
        }
        Node::Filter(f) => {
            let _ = f;
            return Ok(false);
        }
        Node::Case(c) => {
            return load_block_deps(
                &c.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            );
        }
        Node::When(w) => {
            if let Some(ref b) = w.block {
                return load_block_deps(
                    b,
                    arena,
                    options,
                    host,
                    store,
                    dependencies,
                    debug_sources,
                    extends_targets,
                    include_targets,
                    raw_include_targets,
                );
            }
        }
        Node::Conditional(c) => {
            if !load_block_deps(
                &c.consequent,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            )? {
                return Ok(false);
            }
            if let Some(ref alt) = c.alternate {
                return load_node_deps(
                    alt,
                    arena,
                    options,
                    host,
                    store,
                    dependencies,
                    debug_sources,
                    extends_targets,
                    include_targets,
                    raw_include_targets,
                );
            }
        }
        Node::While(w) => {
            return load_block_deps(
                &w.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            );
        }
        Node::Each(e) => {
            if !load_block_deps(
                &e.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            )? {
                return Ok(false);
            }
            if let Some(ref alt) = e.alternate {
                return load_block_deps(
                    alt,
                    arena,
                    options,
                    host,
                    store,
                    dependencies,
                    debug_sources,
                    extends_targets,
                    include_targets,
                    raw_include_targets,
                );
            }
        }
        Node::EachOf(e) => {
            return load_block_deps(
                &e.block,
                arena,
                options,
                host,
                store,
                dependencies,
                debug_sources,
                extends_targets,
                include_targets,
                raw_include_targets,
            );
        }
        Node::Mixin(m) => {
            if let Some(ref b) = m.block {
                return load_block_deps(
                    b,
                    arena,
                    options,
                    host,
                    store,
                    dependencies,
                    debug_sources,
                    extends_targets,
                    include_targets,
                    raw_include_targets,
                );
            }
        }
        Node::Code(c) => {
            if let Some(ref b) = c.block {
                return load_block_deps(
                    b,
                    arena,
                    options,
                    host,
                    store,
                    dependencies,
                    debug_sources,
                    extends_targets,
                    include_targets,
                    raw_include_targets,
                );
            }
        }
        _ => {}
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn resolve_and_load_disk(
    path: &str,
    source: Option<&str>,
    node_filename: Option<&str>,
    node_line: usize,
    options: &CompileOptions,
    store: &TemplateStore,
    dependencies: &mut Vec<String>,
    debug_sources: &mut Vec<(String, String)>,
) -> Result<(String, Arc<SourceEntry>), PugError> {
    let full_path = {
        let _prof_res = scope(Stage::Resolve);
        with_counters(|c| c.resolve_count += 1);
        store.resolve_path(path, source, options.basedir.as_deref(), || {
            default_resolve(path, source, options.basedir.as_deref())
                .map_err(|e| annotate_load_error(e, node_filename, node_line))
        })?
    };
    let (entry, _hit) = store
        .load_or_read_disk(&full_path)
        .map_err(|e| io_read_error(e, &full_path, node_filename, node_line))?;
    dependencies.push(full_path.clone());
    if options.include_sources {
        record_source(debug_sources, full_path.clone(), entry.text.to_string());
    }
    Ok((full_path, entry))
}

struct BuiltLinkState<'ast> {
    declared_blocks: BTreeMap<String, Vec<usize>>,
    parents_map: HashMap<usize, Vec<usize>>,
    segments: HashMap<usize, Vec<&'ast [Node]>>,
    ignored_blocks: HashSet<usize>,
    includes: HashMap<usize, IncludedView<'ast>>,
    raw_includes: HashMap<usize, &'ast str>,
    prepended_mixins: Vec<&'ast MixinNode>,
    root_ast: &'ast BlockNode,
}

fn build_linked_view<'ast>(
    entry_idx: usize,
    arena: &'ast ViewArena,
    extends_targets: &HashMap<usize, usize>,
    include_targets: &HashMap<usize, usize>,
    raw_include_targets: &HashMap<usize, RawStringRef>,
) -> Result<(&'ast BlockNode, LinkedView<'ast>), PugError> {
    let mut state = BuiltLinkState {
        declared_blocks: BTreeMap::new(),
        parents_map: HashMap::new(),
        segments: HashMap::new(),
        ignored_blocks: HashSet::new(),
        includes: HashMap::new(),
        raw_includes: HashMap::new(),
        prepended_mixins: Vec::new(),
        root_ast: &arena.templates[entry_idx].parsed.ast,
    };

    for (&raw_ptr, &raw_ref) in raw_include_targets {
        let s = match raw_ref {
            RawStringRef::ArcText(idx) => arena.raw_texts[idx].as_ref(),
            RawStringRef::Normalized(idx) => arena.normalized_raw_strings[idx].as_str(),
        };
        state.raw_includes.insert(raw_ptr, s);
    }

    link_template_view(entry_idx, arena, extends_targets, include_targets, &mut state)?;

    Ok((
        state.root_ast,
        LinkedView {
            segments: state.segments,
            ignored_blocks: state.ignored_blocks,
            includes: state.includes,
            raw_includes: state.raw_includes,
            prepended_mixins: state.prepended_mixins,
        },
    ))
}

fn link_template_view<'ast>(
    tpl_idx: usize,
    arena: &'ast ViewArena,
    extends_targets: &HashMap<usize, usize>,
    include_targets: &HashMap<usize, usize>,
    state: &mut BuiltLinkState<'ast>,
) -> Result<BTreeMap<String, Vec<usize>>, PugError> {
    let ast: &'ast BlockNode = &arena.templates[tpl_idx].parsed.ast;
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

    let extends_node = if !ast.nodes.is_empty() {
        if let Node::Extends(ext) = &ast.nodes[0] {
            check_extend_position(ast, true)?;
            Some(ext)
        } else {
            check_extend_position(ast, false)?;
            None
        }
    } else {
        None
    };

    // Populate IncludedView for all includes reachable from this template
    populate_includes_in_block(ast, arena, extends_targets, include_targets, state)?;

    // Collect declared replace-blocks in this template (including inside its included templates)
    let mut own_declared: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    collect_declared_blocks_with_includes(
        if extends_node.is_some() {
            &ast.nodes[1..]
        } else {
            &ast.nodes[..]
        },
        arena,
        include_targets,
        &mut own_declared,
    );

    if let Some(ext) = extends_node {
        let mut mixins: Vec<&'ast MixinNode> = Vec::new();
        let mut expected_blocks: Vec<&'ast NamedBlockNode> = Vec::new();
        collect_extending_root_nodes(
            &ast.nodes[1..],
            arena,
            include_targets,
            &mut mixins,
            &mut expected_blocks,
        )?;

        let parent_idx = *extends_targets
            .get(&(ext as *const _ as usize))
            .expect("extends target must be loaded");
        let mut parent_declared =
            link_template_view(parent_idx, arena, extends_targets, include_targets, state)?;

        let mut stack = HashSet::new();
        extend_in_nodes(
            &ast.nodes[1..],
            &parent_declared,
            &mut stack,
            &mut state.parents_map,
            &mut state.segments,
            &mut state.ignored_blocks,
            arena,
            include_targets,
        );

        let mut found_block_names = HashSet::new();
        let parent_ast = &arena.templates[parent_idx].parsed.ast;
        collect_named_block_names_with_includes(
            parent_ast,
            arena,
            extends_targets,
            include_targets,
            &mut found_block_names,
        );
        for eb in expected_blocks {
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

        for (name, blocks) in own_declared {
            parent_declared.insert(name, blocks);
        }

        // Prepend this child's root mixins ahead of parent's mixins (child-to-parent order).
        mixins.append(&mut state.prepended_mixins);
        state.prepended_mixins = mixins;

        state.declared_blocks = parent_declared.clone();
        Ok(parent_declared)
    } else {
        state.root_ast = ast;
        state.declared_blocks = own_declared.clone();
        Ok(own_declared)
    }
}

fn populate_includes_in_block<'ast>(
    block: &'ast BlockNode,
    arena: &'ast ViewArena,
    extends_targets: &HashMap<usize, usize>,
    include_targets: &HashMap<usize, usize>,
    state: &mut BuiltLinkState<'ast>,
) -> Result<(), PugError> {
    for node in &block.nodes {
        populate_includes_in_node(node, arena, extends_targets, include_targets, state)?;
    }
    Ok(())
}

fn populate_includes_in_node<'ast>(
    node: &'ast Node,
    arena: &'ast ViewArena,
    extends_targets: &HashMap<usize, usize>,
    include_targets: &HashMap<usize, usize>,
    state: &mut BuiltLinkState<'ast>,
) -> Result<(), PugError> {
    match node {
        Node::Include(inc) => {
            let inc_ptr = inc as *const IncludeNode as usize;
            let target_idx = *include_targets
                .get(&inc_ptr)
                .expect("include target must be loaded");
            let child_parsed = &arena.templates[target_idx].parsed;
            let child_ast: &'ast BlockNode = &child_parsed.ast;

            check_extend_position(child_ast, false)?;
            populate_includes_in_block(child_ast, arena, extends_targets, include_targets, state)?;

            let default_yield_target_ptr = if !child_parsed.has_yield {
                Some(find_default_yield_target_ptr(child_ast))
            } else {
                None
            };
            state.includes.insert(
                inc_ptr,
                IncludedView {
                    ast: child_ast,
                    has_yield: child_parsed.has_yield,
                    default_yield_target_ptr,
                },
            );
            populate_includes_in_block(&inc.block, arena, extends_targets, include_targets, state)?;
        }
        Node::Block(b) => {
            populate_includes_in_block(b, arena, extends_targets, include_targets, state)?;
        }
        Node::NamedBlock(nb) => {
            for child in &nb.nodes {
                populate_includes_in_node(child, arena, extends_targets, include_targets, state)?;
            }
        }
        Node::Tag(t) => {
            populate_includes_in_block(&t.block, arena, extends_targets, include_targets, state)?;
        }
        Node::InterpolatedTag(t) => {
            populate_includes_in_block(&t.block, arena, extends_targets, include_targets, state)?;
        }
        Node::BlockComment(bc) => {
            populate_includes_in_block(&bc.block, arena, extends_targets, include_targets, state)?;
        }
        Node::Case(c) => {
            populate_includes_in_block(&c.block, arena, extends_targets, include_targets, state)?;
        }
        Node::When(w) => {
            if let Some(ref b) = w.block {
                populate_includes_in_block(b, arena, extends_targets, include_targets, state)?;
            }
        }
        Node::Conditional(c) => {
            populate_includes_in_block(&c.consequent, arena, extends_targets, include_targets, state)?;
            if let Some(ref alt) = c.alternate {
                populate_includes_in_node(alt, arena, extends_targets, include_targets, state)?;
            }
        }
        Node::While(w) => {
            populate_includes_in_block(&w.block, arena, extends_targets, include_targets, state)?;
        }
        Node::Each(e) => {
            populate_includes_in_block(&e.block, arena, extends_targets, include_targets, state)?;
            if let Some(ref alt) = e.alternate {
                populate_includes_in_block(alt, arena, extends_targets, include_targets, state)?;
            }
        }
        Node::EachOf(e) => {
            populate_includes_in_block(&e.block, arena, extends_targets, include_targets, state)?;
        }
        Node::Mixin(m) => {
            if let Some(ref b) = m.block {
                populate_includes_in_block(b, arena, extends_targets, include_targets, state)?;
            }
        }
        Node::Code(c) => {
            if let Some(ref b) = c.block {
                populate_includes_in_block(b, arena, extends_targets, include_targets, state)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn find_default_yield_target_ptr(block: &BlockNode) -> usize {
    let mut target: Option<&BlockNode> = None;
    for child in &block.nodes {
        let text_only = match child {
            Node::Tag(t) => t.text_only == Some(true),
            Node::InterpolatedTag(t) => t.text_only == Some(true),
            Node::Mixin(m) => m.text_only == Some(true),
            _ => false,
        };
        if text_only {
            continue;
        }
        match child {
            Node::Block(b) => target = Some(b),
            Node::Tag(t) if !t.block.nodes.is_empty() => target = Some(&t.block),
            Node::InterpolatedTag(t) if !t.block.nodes.is_empty() => target = Some(&t.block),
            Node::BlockComment(bc) if !bc.block.nodes.is_empty() => target = Some(&bc.block),
            Node::Filter(f) if !f.block.nodes.is_empty() => target = Some(&f.block),
            Node::Case(c) if !c.block.nodes.is_empty() => target = Some(&c.block),
            Node::While(w) if !w.block.nodes.is_empty() => target = Some(&w.block),
            Node::EachOf(e) if !e.block.nodes.is_empty() => target = Some(&e.block),
            Node::Include(i) if !i.block.nodes.is_empty() => target = Some(&i.block),
            Node::When(w) => {
                if let Some(ref b) = w.block && !b.nodes.is_empty() {
                    target = Some(b);
                }
            }
            Node::Mixin(m) => {
                if let Some(ref b) = m.block && !b.nodes.is_empty() {
                    target = Some(b);
                }
            }
            Node::Code(c) => {
                if let Some(ref b) = c.block && !b.nodes.is_empty() {
                    target = Some(b);
                }
            }
            Node::Each(e) if !e.block.nodes.is_empty() => target = Some(&e.block),
            _ => {}
        }
    }
    match target {
        Some(inner) => find_default_yield_target_ptr(inner),
        None => block as *const BlockNode as usize,
    }
}

fn check_extend_position(ast: &BlockNode, has_extends: bool) -> Result<(), PugError> {
    let mut legit_extends_reached = false;
    check_extend_in_block(ast, has_extends, &mut legit_extends_reached)
}

fn check_extend_in_block(
    block: &BlockNode,
    has_extends: bool,
    legit_extends_reached: &mut bool,
) -> Result<(), PugError> {
    for node in &block.nodes {
        check_extend_in_node(node, has_extends, legit_extends_reached)?;
    }
    Ok(())
}

fn check_extend_in_node(
    node: &Node,
    has_extends: bool,
    legit_extends_reached: &mut bool,
) -> Result<(), PugError> {
    match node {
        Node::Extends(ext) => {
            if has_extends && !*legit_extends_reached {
                *legit_extends_reached = true;
                return Ok(());
            }
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
        Node::Block(b) => {
            check_extend_in_block(b, has_extends, legit_extends_reached)?;
        }
        Node::NamedBlock(nb) => {
            for child in &nb.nodes {
                check_extend_in_node(child, has_extends, legit_extends_reached)?;
            }
        }
        Node::Tag(t) => check_extend_in_block(&t.block, has_extends, legit_extends_reached)?,
        Node::InterpolatedTag(t) => {
            check_extend_in_block(&t.block, has_extends, legit_extends_reached)?
        }
        Node::BlockComment(bc) => {
            check_extend_in_block(&bc.block, has_extends, legit_extends_reached)?
        }
        Node::Filter(f) => check_extend_in_block(&f.block, has_extends, legit_extends_reached)?,
        Node::Case(c) => check_extend_in_block(&c.block, has_extends, legit_extends_reached)?,
        Node::When(w) => {
            if let Some(ref b) = w.block {
                check_extend_in_block(b, has_extends, legit_extends_reached)?;
            }
        }
        Node::Conditional(c) => {
            check_extend_in_block(&c.consequent, has_extends, legit_extends_reached)?;
            if let Some(ref alt) = c.alternate {
                check_extend_in_node(alt, has_extends, legit_extends_reached)?;
            }
        }
        Node::While(w) => check_extend_in_block(&w.block, has_extends, legit_extends_reached)?,
        Node::Each(e) => {
            check_extend_in_block(&e.block, has_extends, legit_extends_reached)?;
            if let Some(ref alt) = e.alternate {
                check_extend_in_block(alt, has_extends, legit_extends_reached)?;
            }
        }
        Node::EachOf(e) => check_extend_in_block(&e.block, has_extends, legit_extends_reached)?,
        Node::Mixin(m) => {
            if let Some(ref b) = m.block {
                check_extend_in_block(b, has_extends, legit_extends_reached)?;
            }
        }
        Node::Code(c) => {
            if let Some(ref b) = c.block {
                check_extend_in_block(b, has_extends, legit_extends_reached)?;
            }
        }
        Node::Include(i) => check_extend_in_block(&i.block, has_extends, legit_extends_reached)?,
        _ => {}
    }
    Ok(())
}

fn collect_extending_root_nodes<'ast>(
    nodes: &'ast [Node],
    arena: &'ast ViewArena,
    include_targets: &HashMap<usize, usize>,
    mixins: &mut Vec<&'ast MixinNode>,
    expected_blocks: &mut Vec<&'ast NamedBlockNode>,
) -> Result<(), PugError> {
    for node in nodes {
        match node {
            Node::NamedBlock(nb) => expected_blocks.push(nb),
            Node::Block(b) => collect_extending_root_nodes(
                &b.nodes,
                arena,
                include_targets,
                mixins,
                expected_blocks,
            )?,
            Node::Mixin(m) if !m.call => mixins.push(m),
            Node::Include(inc) => {
                let target_idx = *include_targets
                    .get(&(inc as *const IncludeNode as usize))
                    .expect("include target must be loaded");
                let child_ast = &arena.templates[target_idx].parsed.ast;
                collect_extending_root_nodes(
                    &child_ast.nodes,
                    arena,
                    include_targets,
                    mixins,
                    expected_blocks,
                )?;
                if !inc.block.nodes.is_empty() {
                    collect_extending_root_nodes(
                        &inc.block.nodes,
                        arena,
                        include_targets,
                        mixins,
                        expected_blocks,
                    )?;
                }
            }
            other => {
                let (line, column, filename) = node_loc(other);
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

fn node_loc(node: &Node) -> (usize, Option<usize>, Option<String>) {
    match node {
        Node::Block(b) => (b.line.unwrap_or(0), b.column, b.filename.clone()),
        Node::NamedBlock(nb) => (nb.line, nb.column, nb.filename.clone()),
        Node::Tag(t) => (t.line, t.column, t.filename.clone()),
        Node::InterpolatedTag(t) => (t.line, t.column, t.filename.clone()),
        Node::BlockComment(bc) => (bc.line, bc.column, bc.filename.clone()),
        Node::Filter(f) => (f.line, f.column, f.filename.clone()),
        Node::Case(c) => (c.line, c.column, c.filename.clone()),
        Node::When(w) => (w.line, w.column, w.filename.clone()),
        Node::Conditional(c) => (c.line, c.column, c.filename.clone()),
        Node::While(w) => (w.line, w.column, w.filename.clone()),
        Node::Each(e) => (e.line, e.column, e.filename.clone()),
        Node::EachOf(e) => (e.line, e.column, e.filename.clone()),
        Node::Mixin(m) => (m.line, m.column, m.filename.clone()),
        Node::Code(c) => (c.line, c.column, c.filename.clone()),
        Node::Include(i) => (i.line, i.column, i.filename.clone()),
        Node::Text(t) => (t.line.unwrap_or(0), t.column, t.filename.clone()),
        Node::Comment(c) => (c.line, c.column, c.filename.clone()),
        Node::Doctype(d) => (d.line, d.column, d.filename.clone()),
        Node::IncludeFilter(f) => (f.line, f.column, f.filename.clone()),
        Node::FileReference(f) => (f.line, f.column, f.filename.clone()),
        Node::Extends(e) => (e.line, e.column, e.filename.clone()),
        Node::RawInclude(r) => (r.line, r.column, r.filename.clone()),
        Node::MixinBlock(m) => (m.line, m.column, m.filename.clone()),
        Node::YieldBlock(y) => (y.line, y.column, y.filename.clone()),
        Node::Attrs(a) => (a.line, a.column, a.filename.clone()),
    }
}

fn collect_declared_blocks_with_includes<'ast>(
    nodes: &'ast [Node],
    arena: &'ast ViewArena,
    include_targets: &HashMap<usize, usize>,
    out: &mut BTreeMap<String, Vec<usize>>,
) {
    for node in nodes {
        collect_declared_in_node(node, arena, include_targets, out);
    }
}

fn collect_declared_in_node<'ast>(
    node: &'ast Node,
    arena: &'ast ViewArena,
    include_targets: &HashMap<usize, usize>,
    out: &mut BTreeMap<String, Vec<usize>>,
) {
    match node {
        Node::NamedBlock(nb) => {
            if nb.mode == "replace" {
                out.entry(nb.name.clone())
                    .or_default()
                    .push(nb as *const NamedBlockNode as usize);
            }
            collect_declared_blocks_with_includes(&nb.nodes, arena, include_targets, out);
        }
        Node::Include(inc) => {
            if let Some(&target_idx) = include_targets.get(&(inc as *const IncludeNode as usize)) {
                let child_ast = &arena.templates[target_idx].parsed.ast;
                collect_declared_blocks_with_includes(&child_ast.nodes, arena, include_targets, out);
            }
            collect_declared_blocks_with_includes(&inc.block.nodes, arena, include_targets, out);
        }
        Node::Block(b) => {
            collect_declared_blocks_with_includes(&b.nodes, arena, include_targets, out);
        }
        Node::Tag(t) => {
            collect_declared_blocks_with_includes(&t.block.nodes, arena, include_targets, out);
        }
        Node::InterpolatedTag(t) => {
            collect_declared_blocks_with_includes(&t.block.nodes, arena, include_targets, out);
        }
        Node::BlockComment(bc) => {
            collect_declared_blocks_with_includes(&bc.block.nodes, arena, include_targets, out);
        }
        Node::Case(c) => {
            collect_declared_blocks_with_includes(&c.block.nodes, arena, include_targets, out);
        }
        Node::When(w) => {
            if let Some(ref b) = w.block {
                collect_declared_blocks_with_includes(&b.nodes, arena, include_targets, out);
            }
        }
        Node::Conditional(c) => {
            collect_declared_blocks_with_includes(
                &c.consequent.nodes,
                arena,
                include_targets,
                out,
            );
            if let Some(ref alt) = c.alternate {
                collect_declared_in_node(alt, arena, include_targets, out);
            }
        }
        Node::While(w) => {
            collect_declared_blocks_with_includes(&w.block.nodes, arena, include_targets, out);
        }
        Node::Each(e) => {
            collect_declared_blocks_with_includes(&e.block.nodes, arena, include_targets, out);
            if let Some(ref alt) = e.alternate {
                collect_declared_blocks_with_includes(&alt.nodes, arena, include_targets, out);
            }
        }
        Node::EachOf(e) => {
            collect_declared_blocks_with_includes(&e.block.nodes, arena, include_targets, out);
        }
        Node::Mixin(m) => {
            if let Some(ref b) = m.block {
                collect_declared_blocks_with_includes(&b.nodes, arena, include_targets, out);
            }
        }
        Node::Code(c) => {
            if let Some(ref b) = c.block {
                collect_declared_blocks_with_includes(&b.nodes, arena, include_targets, out);
            }
        }
        _ => {}
    }
}

fn collect_named_block_names_with_includes<'ast>(
    block: &'ast BlockNode,
    arena: &'ast ViewArena,
    extends_targets: &HashMap<usize, usize>,
    include_targets: &HashMap<usize, usize>,
    out: &mut HashSet<String>,
) {
    for node in &block.nodes {
        collect_names_in_node(node, arena, extends_targets, include_targets, out);
    }
}

fn collect_names_in_node<'ast>(
    node: &'ast Node,
    arena: &'ast ViewArena,
    extends_targets: &HashMap<usize, usize>,
    include_targets: &HashMap<usize, usize>,
    out: &mut HashSet<String>,
) {
    match node {
        Node::NamedBlock(nb) => {
            out.insert(nb.name.clone());
            for child in &nb.nodes {
                collect_names_in_node(child, arena, extends_targets, include_targets, out);
            }
        }
        Node::Extends(ext) => {
            if let Some(&target_idx) = extends_targets.get(&(ext as *const _ as usize)) {
                collect_named_block_names_with_includes(
                    &arena.templates[target_idx].parsed.ast,
                    arena,
                    extends_targets,
                    include_targets,
                    out,
                );
            }
        }
        Node::Include(inc) => {
            if let Some(&target_idx) = include_targets.get(&(inc as *const IncludeNode as usize)) {
                collect_named_block_names_with_includes(
                    &arena.templates[target_idx].parsed.ast,
                    arena,
                    extends_targets,
                    include_targets,
                    out,
                );
            }
            collect_named_block_names_with_includes(
                &inc.block,
                arena,
                extends_targets,
                include_targets,
                out,
            );
        }
        Node::Block(b) => {
            collect_named_block_names_with_includes(b, arena, extends_targets, include_targets, out);
        }
        Node::Tag(t) => collect_named_block_names_with_includes(
            &t.block,
            arena,
            extends_targets,
            include_targets,
            out,
        ),
        Node::InterpolatedTag(t) => collect_named_block_names_with_includes(
            &t.block,
            arena,
            extends_targets,
            include_targets,
            out,
        ),
        Node::BlockComment(bc) => collect_named_block_names_with_includes(
            &bc.block,
            arena,
            extends_targets,
            include_targets,
            out,
        ),
        Node::Case(c) => collect_named_block_names_with_includes(
            &c.block,
            arena,
            extends_targets,
            include_targets,
            out,
        ),
        Node::When(w) => {
            if let Some(ref b) = w.block {
                collect_named_block_names_with_includes(
                    b,
                    arena,
                    extends_targets,
                    include_targets,
                    out,
                );
            }
        }
        Node::Conditional(c) => {
            collect_named_block_names_with_includes(
                &c.consequent,
                arena,
                extends_targets,
                include_targets,
                out,
            );
            if let Some(ref alt) = c.alternate {
                collect_names_in_node(alt, arena, extends_targets, include_targets, out);
            }
        }
        Node::While(w) => collect_named_block_names_with_includes(
            &w.block,
            arena,
            extends_targets,
            include_targets,
            out,
        ),
        Node::Each(e) => {
            collect_named_block_names_with_includes(
                &e.block,
                arena,
                extends_targets,
                include_targets,
                out,
            );
            if let Some(ref alt) = e.alternate {
                collect_named_block_names_with_includes(
                    alt,
                    arena,
                    extends_targets,
                    include_targets,
                    out,
                );
            }
        }
        Node::EachOf(e) => collect_named_block_names_with_includes(
            &e.block,
            arena,
            extends_targets,
            include_targets,
            out,
        ),
        Node::Mixin(m) => {
            if let Some(ref b) = m.block {
                collect_named_block_names_with_includes(
                    b,
                    arena,
                    extends_targets,
                    include_targets,
                    out,
                );
            }
        }
        Node::Code(c) => {
            if let Some(ref b) = c.block {
                collect_named_block_names_with_includes(
                    b,
                    arena,
                    extends_targets,
                    include_targets,
                    out,
                );
            }
        }
        _ => {}
    }
}

fn flatten_parent_blocks(
    parent_blocks: &[usize],
    parents_map: &HashMap<usize, Vec<usize>>,
    accumulator: &mut Vec<usize>,
) {
    for &pb_ptr in parent_blocks {
        if let Some(parents) = parents_map.get(&pb_ptr) {
            flatten_parent_blocks(parents, parents_map, accumulator);
        }
        accumulator.push(pb_ptr);
    }
}

#[allow(clippy::too_many_arguments)]
fn extend_in_nodes<'ast>(
    nodes: &'ast [Node],
    parent_blocks: &BTreeMap<String, Vec<usize>>,
    stack: &mut HashSet<String>,
    parents_map: &mut HashMap<usize, Vec<usize>>,
    segments: &mut HashMap<usize, Vec<&'ast [Node]>>,
    ignored_blocks: &mut HashSet<usize>,
    arena: &'ast ViewArena,
    include_targets: &HashMap<usize, usize>,
) {
    for node in nodes {
        extend_in_node(
            node,
            parent_blocks,
            stack,
            parents_map,
            segments,
            ignored_blocks,
            arena,
            include_targets,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn extend_in_node<'ast>(
    node: &'ast Node,
    parent_blocks: &BTreeMap<String, Vec<usize>>,
    stack: &mut HashSet<String>,
    parents_map: &mut HashMap<usize, Vec<usize>>,
    segments: &mut HashMap<usize, Vec<&'ast [Node]>>,
    ignored_blocks: &mut HashSet<usize>,
    arena: &'ast ViewArena,
    include_targets: &HashMap<usize, usize>,
) {
    let mut pushed_name: Option<String> = None;

    if let Node::NamedBlock(nb) = node {
        let nb_ptr = nb as *const NamedBlockNode as usize;
        if stack.contains(&nb.name) {
            ignored_blocks.insert(nb_ptr);
        } else {
            stack.insert(nb.name.clone());
            pushed_name = Some(nb.name.clone());

            let mut parent_block_list = Vec::new();
            if let Some(pblocks) = parent_blocks.get(&nb.name) {
                flatten_parent_blocks(pblocks, parents_map, &mut parent_block_list);
            }

            if !parent_block_list.is_empty() {
                parents_map.insert(nb_ptr, parent_block_list.clone());
                let child_nodes: &'ast [Node] = &nb.nodes;
                for &p_ptr in &parent_block_list {
                    let segs = segments.entry(p_ptr).or_insert_with(|| {
                        let p_nb = unsafe { &*(p_ptr as *const NamedBlockNode) };
                        vec![p_nb.nodes.as_slice()]
                    });
                    match nb.mode.as_str() {
                        "append" => segs.push(child_nodes),
                        "prepend" => segs.insert(0, child_nodes),
                        "replace" => {
                            segs.clear();
                            segs.push(child_nodes);
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    match node {
        Node::Block(b) => {
            extend_in_nodes(
                &b.nodes,
                parent_blocks,
                stack,
                parents_map,
                segments,
                ignored_blocks,
                arena,
                include_targets,
            );
        }
        Node::NamedBlock(nb) => {
            extend_in_nodes(
                &nb.nodes,
                parent_blocks,
                stack,
                parents_map,
                segments,
                ignored_blocks,
                arena,
                include_targets,
            );
        }
        Node::Include(inc) => {
            if let Some(&target_idx) = include_targets.get(&(inc as *const IncludeNode as usize)) {
                let child_ast = &arena.templates[target_idx].parsed.ast;
                extend_in_nodes(
                    &child_ast.nodes,
                    parent_blocks,
                    stack,
                    parents_map,
                    segments,
                    ignored_blocks,
                    arena,
                    include_targets,
                );
            }
            extend_in_nodes(
                &inc.block.nodes,
                parent_blocks,
                stack,
                parents_map,
                segments,
                ignored_blocks,
                arena,
                include_targets,
            );
        }
        Node::Tag(t) => extend_in_nodes(
            &t.block.nodes,
            parent_blocks,
            stack,
            parents_map,
            segments,
            ignored_blocks,
            arena,
            include_targets,
        ),
        Node::InterpolatedTag(t) => extend_in_nodes(
            &t.block.nodes,
            parent_blocks,
            stack,
            parents_map,
            segments,
            ignored_blocks,
            arena,
            include_targets,
        ),
        Node::BlockComment(bc) => extend_in_nodes(
            &bc.block.nodes,
            parent_blocks,
            stack,
            parents_map,
            segments,
            ignored_blocks,
            arena,
            include_targets,
        ),
        Node::Case(c) => extend_in_nodes(
            &c.block.nodes,
            parent_blocks,
            stack,
            parents_map,
            segments,
            ignored_blocks,
            arena,
            include_targets,
        ),
        Node::When(w) => {
            if let Some(ref b) = w.block {
                extend_in_nodes(
                    &b.nodes,
                    parent_blocks,
                    stack,
                    parents_map,
                    segments,
                    ignored_blocks,
                    arena,
                    include_targets,
                );
            }
        }
        Node::Conditional(c) => {
            extend_in_nodes(
                &c.consequent.nodes,
                parent_blocks,
                stack,
                parents_map,
                segments,
                ignored_blocks,
                arena,
                include_targets,
            );
            if let Some(ref alt) = c.alternate {
                extend_in_node(
                    alt,
                    parent_blocks,
                    stack,
                    parents_map,
                    segments,
                    ignored_blocks,
                    arena,
                    include_targets,
                );
            }
        }
        Node::While(w) => extend_in_nodes(
            &w.block.nodes,
            parent_blocks,
            stack,
            parents_map,
            segments,
            ignored_blocks,
            arena,
            include_targets,
        ),
        Node::Each(e) => {
            extend_in_nodes(
                &e.block.nodes,
                parent_blocks,
                stack,
                parents_map,
                segments,
                ignored_blocks,
                arena,
                include_targets,
            );
            if let Some(ref alt) = e.alternate {
                extend_in_nodes(
                    &alt.nodes,
                    parent_blocks,
                    stack,
                    parents_map,
                    segments,
                    ignored_blocks,
                    arena,
                    include_targets,
                );
            }
        }
        Node::EachOf(e) => extend_in_nodes(
            &e.block.nodes,
            parent_blocks,
            stack,
            parents_map,
            segments,
            ignored_blocks,
            arena,
            include_targets,
        ),
        Node::Mixin(m) => {
            if let Some(ref b) = m.block {
                extend_in_nodes(
                    &b.nodes,
                    parent_blocks,
                    stack,
                    parents_map,
                    segments,
                    ignored_blocks,
                    arena,
                    include_targets,
                );
            }
        }
        Node::Code(c) => {
            if let Some(ref b) = c.block {
                extend_in_nodes(
                    &b.nodes,
                    parent_blocks,
                    stack,
                    parents_map,
                    segments,
                    ignored_blocks,
                    arena,
                    include_targets,
                );
            }
        }
        _ => {}
    }

    if let Some(name) = pushed_name {
        stack.remove(&name);
    }
}
