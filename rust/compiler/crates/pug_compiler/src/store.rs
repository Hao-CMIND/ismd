use pug_ast::profile::{record_file, scope, with_counters, Stage};
use pug_ast::{BlockNode, Node, RawContent};
use pug_error::PugError;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

/// Monotonic identifier assigned per normalized template source path in a [`TemplateStore`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TemplateId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DependencyKind {
    Extends,
    Include,
    RawInclude,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyRef {
    pub kind: DependencyKind,
    pub raw_path: String,
    pub line: usize,
    pub column: Option<usize>,
    pub from_filename: Option<String>,
    pub is_filtered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredBlockMeta {
    pub name: String,
    pub mode: String,
}

#[derive(Debug, Clone)]
pub enum CachedRaw {
    Bytes(Arc<Vec<u8>>),
    Text(Arc<str>),
}

impl CachedRaw {
    pub fn to_raw_content(&self) -> RawContent {
        match self {
            CachedRaw::Bytes(bytes) => RawContent::Bytes((**bytes).clone()),
            CachedRaw::Text(text) => RawContent::Text(text.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SourceEntry {
    pub id: TemplateId,
    pub normalized_path: String,
    pub canonical_path: String,
    pub raw: CachedRaw,
    pub text: Arc<str>,
    pub byte_len: u64,
    pub content_hash: u64,
    pub version: u64,
}

impl SourceEntry {
    pub fn to_raw_content(&self) -> RawContent {
        self.raw.to_raw_content()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ParseKey {
    pub normalized_path: String,
    pub filename: String,
    pub content_hash: u64,
    pub byte_len: u64,
    pub source_version: u64,
    pub lex_plugin_methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ResolutionKey {
    pub path: String,
    pub source: Option<String>,
    pub basedir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedTemplate {
    pub id: TemplateId,
    pub source_version: u64,
    pub content_hash: u64,
    pub filename: Arc<str>,
    pub ast: Arc<BlockNode>,
    pub direct_dependencies: Vec<DependencyRef>,
    pub declared_blocks: Vec<DeclaredBlockMeta>,
    pub has_filters: bool,
    pub has_yield: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TemplateStoreStats {
    pub sources: usize,
    pub parsed: usize,
    pub resolved: usize,
    pub source_hits: u64,
    pub source_misses: u64,
    pub parse_hits: u64,
    pub parse_misses: u64,
}

use crate::dag::DependencyGraph;

/// Thread-safe layered template store holding immutable sources and parsed ASTs.
pub struct TemplateStore {
    trust_cached_sources: bool,
    next_id: AtomicU64,
    next_version: AtomicU64,
    source_hits: AtomicU64,
    source_misses: AtomicU64,
    parse_hits: AtomicU64,
    parse_misses: AtomicU64,
    path_ids: RwLock<HashMap<String, TemplateId>>,
    id_paths: RwLock<HashMap<TemplateId, String>>,
    sources: RwLock<HashMap<String, Arc<SourceEntry>>>,
    parsed: RwLock<HashMap<ParseKey, Arc<ParsedTemplate>>>,
    resolved: RwLock<HashMap<ResolutionKey, String>>,
    dag: DependencyGraph,
}

impl Default for TemplateStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TemplateStore {
    /// Creates an explicit session/build store that retains read sources in memory
    /// until invalidated or updated.
    pub fn new() -> Self {
        Self::with_trust_mode(true)
    }

    /// Creates a store that always revalidates disk bytes via fast content hashing
    /// before reusing cached parsed ASTs (used for zero-config global caching).
    pub fn hash_validated() -> Self {
        Self::with_trust_mode(false)
    }

    fn with_trust_mode(trust_cached_sources: bool) -> Self {
        Self {
            trust_cached_sources,
            next_id: AtomicU64::new(1),
            next_version: AtomicU64::new(1),
            source_hits: AtomicU64::new(0),
            source_misses: AtomicU64::new(0),
            parse_hits: AtomicU64::new(0),
            parse_misses: AtomicU64::new(0),
            path_ids: RwLock::new(HashMap::new()),
            id_paths: RwLock::new(HashMap::new()),
            sources: RwLock::new(HashMap::new()),
            parsed: RwLock::new(HashMap::new()),
            resolved: RwLock::new(HashMap::new()),
            dag: DependencyGraph::new(),
        }
    }

    #[inline]
    pub fn trust_cached_sources(&self) -> bool {
        self.trust_cached_sources
    }

    #[inline]
    pub fn dag(&self) -> &DependencyGraph {
        &self.dag
    }

    pub fn id_for_path(&self, path: &str) -> Option<TemplateId> {
        let norm = normalize_cache_path(path);
        self.path_ids
            .read()
            .expect("path_ids rwlock poisoned")
            .get(&norm)
            .copied()
    }

    pub fn path_for_id(&self, id: TemplateId) -> Option<String> {
        self.id_paths
            .read()
            .expect("id_paths rwlock poisoned")
            .get(&id)
            .cloned()
    }

    pub fn get_or_alloc_id(&self, path: &str) -> TemplateId {
        let norm = normalize_cache_path(path);
        if let Some(&id) = self
            .path_ids
            .read()
            .expect("path_ids rwlock poisoned")
            .get(&norm)
        {
            return id;
        }
        let mut guard = self.path_ids.write().expect("path_ids rwlock poisoned");
        if let Some(&id) = guard.get(&norm) {
            return id;
        }
        let id = TemplateId(self.next_id.fetch_add(1, Ordering::Relaxed));
        guard.insert(norm.clone(), id);
        self.id_paths
            .write()
            .expect("id_paths rwlock poisoned")
            .insert(id, norm);
        id
    }

    pub fn get_cached_source(&self, full_path: &str) -> Option<Arc<SourceEntry>> {
        if !self.trust_cached_sources {
            return None;
        }
        let norm = normalize_cache_path(full_path);
        let entry = self
            .sources
            .read()
            .expect("sources rwlock poisoned")
            .get(&norm)
            .cloned();
        if entry.is_some() {
            self.source_hits.fetch_add(1, Ordering::Relaxed);
        }
        entry
    }

    /// Resolves `path` from `source`/`basedir` using cached resolutions when
    /// `trust_cached_sources` is enabled, preserving exact resolve errors.
    pub fn resolve_path(
        &self,
        path: &str,
        source: Option<&str>,
        basedir: Option<&str>,
        resolver: impl FnOnce() -> Result<String, PugError>,
    ) -> Result<String, PugError> {
        if !self.trust_cached_sources {
            return resolver();
        }
        let key = ResolutionKey {
            path: path.to_string(),
            source: source.map(String::from),
            basedir: basedir.map(String::from),
        };
        if let Some(hit) = self
            .resolved
            .read()
            .expect("resolved rwlock poisoned")
            .get(&key)
            .cloned()
        {
            return Ok(hit);
        }
        let full_path = resolver()?;
        self.resolved
            .write()
            .expect("resolved rwlock poisoned")
            .insert(key, full_path.clone());
        Ok(full_path)
    }

    /// Loads source for `full_path`, hitting `SourceStore` when `trust_cached_sources`
    /// is enabled, or reading from disk and hashing bytes otherwise.
    pub fn load_or_read_disk(
        &self,
        full_path: &str,
    ) -> Result<(Arc<SourceEntry>, bool), std::io::Error> {
        if let Some(entry) = self.get_cached_source(full_path) {
            with_counters(|c| c.source_cache_hit_count += 1);
            record_file(Some(full_path), |fc| fc.source_cache_hit_count += 1);
            return Ok((entry, true));
        }

        self.source_misses.fetch_add(1, Ordering::Relaxed);
        let bytes = {
            let _prof_read = scope(Stage::FileRead);
            with_counters(|c| c.file_read_count += 1);
            record_file(Some(full_path), |fc| fc.read_count += 1);
            std::fs::read(full_path)?
        };
        Ok((self.upsert_disk_bytes(full_path, bytes), false))
    }

    pub fn upsert_disk_bytes(&self, full_path: &str, bytes: Vec<u8>) -> Arc<SourceEntry> {
        let norm = normalize_cache_path(full_path);
        let byte_len = bytes.len() as u64;
        let content_hash = hash_bytes(&bytes);

        {
            let guard = self.sources.read().expect("sources rwlock poisoned");
            if let Some(existing) = guard.get(&norm) {
                if existing.byte_len == byte_len && existing.content_hash == content_hash {
                    return Arc::clone(existing);
                }
            }
        }

        let text: Arc<str> = Arc::from(String::from_utf8_lossy(&bytes).into_owned());
        let id = self.get_or_alloc_id(&norm);
        let version = self.next_version.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(SourceEntry {
            id,
            normalized_path: norm.clone(),
            canonical_path: full_path.to_string(),
            raw: CachedRaw::Bytes(Arc::new(bytes)),
            text,
            byte_len,
            content_hash,
            version,
        });
        let mut guard = self.sources.write().expect("sources rwlock poisoned");
        if let Some(existing) = guard.get(&norm) {
            if existing.byte_len == byte_len && existing.content_hash == content_hash {
                return Arc::clone(existing);
            }
        }
        guard.insert(norm.clone(), Arc::clone(&entry));
        drop(guard);
        self.prune_parsed_for_path(&norm, version);
        entry
    }

    /// Inserts or replaces virtual/in-memory UTF-8 template source for `full_path`.
    pub fn update_virtual_source(&self, full_path: &str, text: String) -> Arc<SourceEntry> {
        let norm = normalize_cache_path(full_path);
        let byte_len = text.len() as u64;
        let content_hash = hash_bytes(text.as_bytes());

        {
            let guard = self.sources.read().expect("sources rwlock poisoned");
            if let Some(existing) = guard.get(&norm) {
                if existing.byte_len == byte_len && existing.content_hash == content_hash {
                    return Arc::clone(existing);
                }
            }
        }

        let arc_text: Arc<str> = Arc::from(text);
        let id = self.get_or_alloc_id(&norm);
        let version = self.next_version.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(SourceEntry {
            id,
            normalized_path: norm.clone(),
            canonical_path: full_path.to_string(),
            raw: CachedRaw::Text(Arc::clone(&arc_text)),
            text: arc_text,
            byte_len,
            content_hash,
            version,
        });
        self.sources
            .write()
            .expect("sources rwlock poisoned")
            .insert(norm.clone(), Arc::clone(&entry));
        self.prune_parsed_for_path(&norm, version);
        entry
    }

    pub fn invalidate_path(&self, path: &str) {
        let norm = normalize_cache_path(path);
        self.sources
            .write()
            .expect("sources rwlock poisoned")
            .remove(&norm);
        self.parsed
            .write()
            .expect("parsed rwlock poisoned")
            .retain(|k, _| k.normalized_path != norm);
        self.resolved
            .write()
            .expect("resolved rwlock poisoned")
            .clear();
    }

    pub fn clear(&self) {
        self.sources
            .write()
            .expect("sources rwlock poisoned")
            .clear();
        self.parsed.write().expect("parsed rwlock poisoned").clear();
        self.resolved
            .write()
            .expect("resolved rwlock poisoned")
            .clear();
        self.dag.clear();
        self.source_hits.store(0, Ordering::Relaxed);
        self.source_misses.store(0, Ordering::Relaxed);
        self.parse_hits.store(0, Ordering::Relaxed);
        self.parse_misses.store(0, Ordering::Relaxed);
    }

    pub fn get_parsed(&self, key: &ParseKey) -> Option<Arc<ParsedTemplate>> {
        let hit = self
            .parsed
            .read()
            .expect("parsed rwlock poisoned")
            .get(key)
            .cloned();
        if hit.is_some() {
            self.parse_hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.parse_misses.fetch_add(1, Ordering::Relaxed);
        }
        hit
    }

    pub fn insert_parsed(&self, key: ParseKey, parsed: ParsedTemplate) -> Arc<ParsedTemplate> {
        let arc = Arc::new(parsed);
        let mut guard = self.parsed.write().expect("parsed rwlock poisoned");
        if let Some(existing) = guard.get(&key) {
            return Arc::clone(existing);
        }
        guard.insert(key, Arc::clone(&arc));
        arc
    }

    pub fn stats(&self) -> TemplateStoreStats {
        TemplateStoreStats {
            sources: self.sources.read().expect("sources rwlock poisoned").len(),
            parsed: self.parsed.read().expect("parsed rwlock poisoned").len(),
            resolved: self.resolved.read().expect("resolved rwlock poisoned").len(),
            source_hits: self.source_hits.load(Ordering::Relaxed),
            source_misses: self.source_misses.load(Ordering::Relaxed),
            parse_hits: self.parse_hits.load(Ordering::Relaxed),
            parse_misses: self.parse_misses.load(Ordering::Relaxed),
        }
    }

    fn prune_parsed_for_path(&self, norm: &str, keep_version: u64) {
        self.parsed
            .write()
            .expect("parsed rwlock poisoned")
            .retain(|k, _| k.normalized_path != norm || k.source_version == keep_version);
    }
}

pub fn default_global_store() -> &'static TemplateStore {
    static GLOBAL_STORE: OnceLock<TemplateStore> = OnceLock::new();
    GLOBAL_STORE.get_or_init(TemplateStore::hash_validated)
}

#[inline]
pub fn hash_bytes(bytes: &[u8]) -> u64 {
    // Fast FNV-1a 64-bit hash with avalanche mixing for source deduplication keys.
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(0xff51afd7ed558ccd);
    hash ^= hash >> 33;
    hash
}

pub fn normalize_cache_path(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    #[cfg(windows)]
    {
        if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
            let first = (normalized.as_bytes()[0] as char).to_ascii_lowercase();
            normalized.replace_range(0..1, &first.to_string());
        }
    }
    normalized
}

pub struct AstMetadata {
    pub dependencies: Vec<DependencyRef>,
    pub declared_blocks: Vec<DeclaredBlockMeta>,
    pub has_filters: bool,
    pub has_yield: bool,
}

pub fn collect_ast_metadata(block: &BlockNode) -> AstMetadata {
    let mut meta = AstMetadata {
        dependencies: Vec::new(),
        declared_blocks: Vec::new(),
        has_filters: false,
        has_yield: false,
    };
    collect_from_nodes(&block.nodes, &mut meta);
    meta
}

fn collect_from_nodes(nodes: &[Node], meta: &mut AstMetadata) {
    for node in nodes {
        match node {
            Node::Block(b) => collect_from_nodes(&b.nodes, meta),
            Node::NamedBlock(b) => {
                meta.declared_blocks.push(DeclaredBlockMeta {
                    name: b.name.clone(),
                    mode: b.mode.clone(),
                });
                collect_from_nodes(&b.nodes, meta);
            }
            Node::YieldBlock(_) => {
                meta.has_yield = true;
            }
            Node::Extends(n) => meta.dependencies.push(DependencyRef {
                kind: DependencyKind::Extends,
                raw_path: n.file.path.clone(),
                line: n.line,
                column: n.column,
                from_filename: n.filename.clone(),
                is_filtered: false,
            }),
            Node::Include(n) => {
                meta.dependencies.push(DependencyRef {
                    kind: DependencyKind::Include,
                    raw_path: n.file.path.clone(),
                    line: n.line,
                    column: n.column,
                    from_filename: n.filename.clone(),
                    is_filtered: false,
                });
                collect_from_nodes(&n.block.nodes, meta);
            }
            Node::RawInclude(n) => {
                if !n.filters.is_empty() {
                    meta.has_filters = true;
                }
                meta.dependencies.push(DependencyRef {
                    kind: DependencyKind::RawInclude,
                    raw_path: n.file.path.clone(),
                    line: n.line,
                    column: n.column,
                    from_filename: n.filename.clone(),
                    is_filtered: !n.filters.is_empty(),
                });
            }
            Node::Tag(t) => collect_from_nodes(&t.block.nodes, meta),
            Node::InterpolatedTag(t) => collect_from_nodes(&t.block.nodes, meta),
            Node::Filter(f) => {
                meta.has_filters = true;
                collect_from_nodes(&f.block.nodes, meta);
            }
            Node::Case(c) => collect_from_nodes(&c.block.nodes, meta),
            Node::When(w) => {
                if let Some(ref b) = w.block {
                    collect_from_nodes(&b.nodes, meta);
                }
            }
            Node::Conditional(c) => {
                collect_from_nodes(&c.consequent.nodes, meta);
                if let Some(ref alt) = c.alternate {
                    collect_from_node(alt, meta);
                }
            }
            Node::While(w) => collect_from_nodes(&w.block.nodes, meta),
            Node::Each(e) => {
                collect_from_nodes(&e.block.nodes, meta);
                if let Some(ref alt) = e.alternate {
                    collect_from_nodes(&alt.nodes, meta);
                }
            }
            Node::EachOf(e) => collect_from_nodes(&e.block.nodes, meta),
            Node::Mixin(m) => {
                if let Some(ref b) = m.block {
                    collect_from_nodes(&b.nodes, meta);
                }
            }
            _ => {}
        }
    }
}

fn collect_from_node(node: &Node, meta: &mut AstMetadata) {
    match node {
        Node::Conditional(c) => {
            collect_from_nodes(&c.consequent.nodes, meta);
            if let Some(ref alt) = c.alternate {
                collect_from_node(alt, meta);
            }
        }
        Node::Block(b) => collect_from_nodes(&b.nodes, meta),
        other => collect_from_nodes(std::slice::from_ref(other), meta),
    }
}

pub fn ast_has_extends(block: &BlockNode) -> bool {
    block.nodes.iter().any(|n| matches!(n, Node::Extends(_)))
}
