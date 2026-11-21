use ismd_ast::profile::{record_file, scope, with_counters, Stage};
use ismd_ast::{BlockNode, Node, RawContent};
use ismd_error::IsmdError;
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
    pub generic_syntax: Vec<ismd_lexer::GenericSyntaxRule>,
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
    pub has_extensions: bool,
    pub has_yield: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CompiledOutputKey {
    pub normalized_path: String,
    pub content_hash: u64,
    pub byte_len: u64,
    pub source_version: u64,
    pub options_hash: u64,
}

#[derive(Debug, Clone)]
pub struct CompiledOutputEntry {
    pub body: Arc<str>,
    pub dependencies: Arc<Vec<String>>,
    pub dep_versions: Vec<(String, u64, u64)>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TemplateStoreStats {
    pub sources: usize,
    pub parsed: usize,
    pub resolved: usize,
    pub outputs: usize,
    pub dag_nodes: usize,
    pub dag_edges: usize,
    pub source_hits: u64,
    pub source_misses: u64,
    pub parse_hits: u64,
    pub parse_misses: u64,
    pub output_cache_hits: u64,
    pub output_cache_misses: u64,
}

use crate::dag::DependencyGraph;
use crate::plugin::NativePluginManager;

struct CacheSlot<V> {
    value: Arc<V>,
    last_used: AtomicU64,
}

impl<V> CacheSlot<V> {
    fn new(value: Arc<V>, tick: u64) -> Self {
        Self {
            value,
            last_used: AtomicU64::new(tick),
        }
    }

    #[inline]
    fn touch(&self, tick: u64) {
        self.last_used.store(tick, Ordering::Relaxed);
    }

    #[inline]
    fn tick(&self) -> u64 {
        self.last_used.load(Ordering::Relaxed)
    }
}

/// Thread-safe layered template store holding immutable sources and parsed ASTs.
pub struct TemplateStore {
    trust_cached_sources: bool,
    next_id: AtomicU64,
    next_version: AtomicU64,
    cache_tick: AtomicU64,
    source_hits: AtomicU64,
    source_misses: AtomicU64,
    parse_hits: AtomicU64,
    parse_misses: AtomicU64,
    output_cache_hits: AtomicU64,
    output_cache_misses: AtomicU64,
    path_ids: RwLock<HashMap<String, TemplateId>>,
    id_paths: RwLock<HashMap<TemplateId, String>>,
    sources: RwLock<HashMap<String, Arc<SourceEntry>>>,
    parsed: RwLock<HashMap<ParseKey, CacheSlot<ParsedTemplate>>>,
    resolved: RwLock<HashMap<ResolutionKey, String>>,
    outputs: RwLock<HashMap<CompiledOutputKey, CacheSlot<CompiledOutputEntry>>>,
    dag: DependencyGraph,
    pub plugins: RwLock<NativePluginManager>,
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
            cache_tick: AtomicU64::new(1),
            source_hits: AtomicU64::new(0),
            source_misses: AtomicU64::new(0),
            parse_hits: AtomicU64::new(0),
            parse_misses: AtomicU64::new(0),
            output_cache_hits: AtomicU64::new(0),
            output_cache_misses: AtomicU64::new(0),
            path_ids: RwLock::new(HashMap::new()),
            id_paths: RwLock::new(HashMap::new()),
            sources: RwLock::new(HashMap::new()),
            parsed: RwLock::new(HashMap::new()),
            resolved: RwLock::new(HashMap::new()),
            outputs: RwLock::new(HashMap::new()),
            dag: DependencyGraph::new(),
            plugins: RwLock::new(NativePluginManager::new()),
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
            .unwrap_or_else(|e| e.into_inner())
            .get(&norm)
            .copied()
    }

    pub fn path_for_id(&self, id: TemplateId) -> Option<String> {
        self.id_paths
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
    }

    pub fn get_or_alloc_id(&self, path: &str) -> TemplateId {
        let norm = normalize_cache_path(path);
        if let Some(&id) = self
            .path_ids
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&norm)
        {
            return id;
        }
        let mut guard = self.path_ids.write().unwrap_or_else(|e| e.into_inner());
        if let Some(&id) = guard.get(&norm) {
            return id;
        }
        let id = TemplateId(self.next_id.fetch_add(1, Ordering::Relaxed));
        guard.insert(norm, id);
        self.id_paths
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, path.to_string());
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
            .unwrap_or_else(|e| e.into_inner())
            .get(&norm)
            .cloned();
        if entry.is_some() {
            self.source_hits.fetch_add(1, Ordering::Relaxed);
        }
        entry
    }

    /// Reads a cached source entry without incrementing `source_hits` (used for internal metadata checks).
    pub fn peek_cached_source(&self, full_path: &str) -> Option<Arc<SourceEntry>> {
        if !self.trust_cached_sources {
            return None;
        }
        let norm = normalize_cache_path(full_path);
        self.sources
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&norm)
            .cloned()
    }

    /// Resolves `path` from `source`/`basedir` using cached resolutions when
    /// `trust_cached_sources` is enabled, preserving exact resolve errors.
    pub fn resolve_path(
        &self,
        path: &str,
        source: Option<&str>,
        basedir: Option<&str>,
        resolver: impl FnOnce() -> Result<String, IsmdError>,
    ) -> Result<String, IsmdError> {
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
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned()
        {
            return Ok(hit);
        }
        let full_path = resolver()?;
        self.resolved
            .write()
            .unwrap_or_else(|e| e.into_inner())
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
            let guard = self.sources.read().unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = guard.get(&norm) {
                if existing.byte_len == byte_len && existing.content_hash == content_hash {
                    return Arc::clone(existing);
                }
            }
        }

        let text: Arc<str> = Arc::from(String::from_utf8_lossy(&bytes).into_owned());
        let id = self.get_or_alloc_id(full_path);
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
        let mut guard = self.sources.write().unwrap_or_else(|e| e.into_inner());
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
        self.update_virtual_source_checked(full_path, text).0
    }

    /// Inserts or replaces virtual/in-memory UTF-8 template source for `full_path`,
    /// returning `(entry, changed)` where `changed` is `false` if content hash & length matched.
    pub fn update_virtual_source_checked(
        &self,
        full_path: &str,
        text: String,
    ) -> (Arc<SourceEntry>, bool) {
        let norm = normalize_cache_path(full_path);
        let byte_len = text.len() as u64;
        let content_hash = hash_bytes(text.as_bytes());

        {
            let guard = self.sources.read().unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = guard.get(&norm) {
                if existing.byte_len == byte_len && existing.content_hash == content_hash {
                    return (Arc::clone(existing), false);
                }
            }
        }

        let arc_text: Arc<str> = Arc::from(text);
        let id = self.get_or_alloc_id(full_path);
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
        let mut guard = self.sources.write().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.get(&norm) {
            if existing.byte_len == byte_len && existing.content_hash == content_hash {
                return (Arc::clone(existing), false);
            }
        }
        guard.insert(norm.clone(), Arc::clone(&entry));
        drop(guard);
        self.prune_parsed_for_path(&norm, version);
        (entry, true)
    }

    pub fn invalidate_path(&self, path: &str) {
        let _ = self.invalidate_path_checked(path);
    }

    /// Invalidates cached source and parsed ASTs for `path`, returning its `TemplateId` if known.
    pub fn invalidate_path_checked(&self, path: &str) -> Option<TemplateId> {
        let norm = normalize_cache_path(path);
        let removed_source = self
            .sources
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&norm)
            .is_some();
        let mut parsed_guard = self.parsed.write().unwrap_or_else(|e| e.into_inner());
        let before_len = parsed_guard.len();
        parsed_guard.retain(|k, _| k.normalized_path != norm);
        let removed_parsed = parsed_guard.len() != before_len;
        drop(parsed_guard);
        if removed_source || removed_parsed {
            self.resolved
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            self.outputs
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|k, _| k.normalized_path != norm);
        }
        self.id_for_path(&norm)
    }

    pub fn clear(&self) {
        self.sources
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.parsed.write().unwrap_or_else(|e| e.into_inner()).clear();
        self.resolved
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.outputs
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.dag.clear();
        self.source_hits.store(0, Ordering::Relaxed);
        self.source_misses.store(0, Ordering::Relaxed);
        self.parse_hits.store(0, Ordering::Relaxed);
        self.parse_misses.store(0, Ordering::Relaxed);
        self.output_cache_hits.store(0, Ordering::Relaxed);
        self.output_cache_misses.store(0, Ordering::Relaxed);
    }

    const MAX_PARSED_CACHE_ENTRIES: usize = 4096;
    const MAX_OUTPUT_CACHE_ENTRIES: usize = 4096;

    #[inline]
    fn next_cache_tick(&self) -> u64 {
        self.cache_tick.fetch_add(1, Ordering::Relaxed)
    }

    pub fn get_parsed(&self, key: &ParseKey) -> Option<Arc<ParsedTemplate>> {
        let hit = {
            let guard = self.parsed.read().unwrap_or_else(|e| e.into_inner());
            guard.get(key).map(|slot| {
                slot.touch(self.next_cache_tick());
                Arc::clone(&slot.value)
            })
        };
        if hit.is_some() {
            self.parse_hits.fetch_add(1, Ordering::Relaxed);
        } else {
            self.parse_misses.fetch_add(1, Ordering::Relaxed);
        }
        hit
    }

    pub fn insert_parsed(&self, key: ParseKey, parsed: ParsedTemplate) -> Arc<ParsedTemplate> {
        let arc = Arc::new(parsed);
        let mut guard = self.parsed.write().unwrap_or_else(|e| e.into_inner());
        let tick = self.next_cache_tick();
        if let Some(existing) = guard.get(&key) {
            existing.touch(tick);
            return Arc::clone(&existing.value);
        }
        if guard.len() >= Self::MAX_PARSED_CACHE_ENTRIES {
            let target_len = Self::MAX_PARSED_CACHE_ENTRIES * 3 / 4;
            let evict_count = guard.len().saturating_sub(target_len);
            let mut entries: Vec<(ParseKey, u64)> = guard
                .iter()
                .map(|(k, slot)| (k.clone(), slot.tick()))
                .collect();
            entries.sort_unstable_by_key(|(_, t)| *t);
            for (k, _) in entries.into_iter().take(evict_count) {
                guard.remove(&k);
            }
        }
        guard.insert(key, CacheSlot::new(Arc::clone(&arc), tick));
        arc
    }

    pub fn get_compiled_output(&self, key: &CompiledOutputKey) -> Option<Arc<CompiledOutputEntry>> {
        let entry = {
            let guard = self.outputs.read().unwrap_or_else(|e| e.into_inner());
            guard.get(key).map(|slot| {
                slot.touch(self.next_cache_tick());
                Arc::clone(&slot.value)
            })
        };
        if let Some(ref e) = entry {
            let sources = self.sources.read().unwrap_or_else(|e| e.into_inner());
            let valid = e.dep_versions.iter().all(|(dep_norm, dep_hash, dep_ver)| {
                sources.get(dep_norm).is_some_and(|s| {
                    s.content_hash == *dep_hash && s.version == *dep_ver
                })
            });
            if valid {
                self.output_cache_hits.fetch_add(1, Ordering::Relaxed);
                return Some(Arc::clone(e));
            }
        }
        self.output_cache_misses.fetch_add(1, Ordering::Relaxed);
        None
    }

    pub fn insert_compiled_output(
        &self,
        key: CompiledOutputKey,
        entry: CompiledOutputEntry,
    ) -> Arc<CompiledOutputEntry> {
        let arc = Arc::new(entry);
        let mut guard = self.outputs.write().unwrap_or_else(|e| e.into_inner());
        let tick = self.next_cache_tick();
        if guard.len() >= Self::MAX_OUTPUT_CACHE_ENTRIES && !guard.contains_key(&key) {
            let target_len = Self::MAX_OUTPUT_CACHE_ENTRIES * 3 / 4;
            let evict_count = guard.len().saturating_sub(target_len);
            let mut entries: Vec<(CompiledOutputKey, u64)> = guard
                .iter()
                .map(|(k, slot)| (k.clone(), slot.tick()))
                .collect();
            entries.sort_unstable_by_key(|(_, t)| *t);
            for (k, _) in entries.into_iter().take(evict_count) {
                guard.remove(&k);
            }
        }
        guard.insert(key, CacheSlot::new(Arc::clone(&arc), tick));
        arc
    }

    /// Removes all cached state for `path`, returning its `TemplateId` if known.
    /// Retains reverse dependency edges and stable path-to-ID mapping so that
    /// entries depending on this path can be automatically recompiled upon recreation.
    pub fn remove_path(&self, path: &str) -> Option<TemplateId> {
        let id = self.invalidate_path_checked(path);
        if let Some(tid) = id {
            self.dag.set_dependencies(tid, Vec::new());
        }
        id
    }

    pub fn stats(&self) -> TemplateStoreStats {
        let dag_stats = self.dag.stats();
        TemplateStoreStats {
            sources: self.sources.read().unwrap_or_else(|e| e.into_inner()).len(),
            parsed: self.parsed.read().unwrap_or_else(|e| e.into_inner()).len(),
            resolved: self.resolved.read().unwrap_or_else(|e| e.into_inner()).len(),
            outputs: self.outputs.read().unwrap_or_else(|e| e.into_inner()).len(),
            dag_nodes: dag_stats.nodes,
            dag_edges: dag_stats.edges,
            source_hits: self.source_hits.load(Ordering::Relaxed),
            source_misses: self.source_misses.load(Ordering::Relaxed),
            parse_hits: self.parse_hits.load(Ordering::Relaxed),
            parse_misses: self.parse_misses.load(Ordering::Relaxed),
            output_cache_hits: self.output_cache_hits.load(Ordering::Relaxed),
            output_cache_misses: self.output_cache_misses.load(Ordering::Relaxed),
        }
    }

    fn prune_parsed_for_path(&self, norm: &str, keep_version: u64) {
        self.parsed
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|k, _| k.normalized_path != norm || k.source_version == keep_version);
        self.outputs
            .write()
            .unwrap_or_else(|e| e.into_inner())
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

pub struct AstMetadata {
    pub dependencies: Vec<DependencyRef>,
    pub declared_blocks: Vec<DeclaredBlockMeta>,
    pub has_extensions: bool,
    pub has_yield: bool,
}

pub fn collect_ast_metadata(block: &BlockNode) -> AstMetadata {
    let mut meta = AstMetadata {
        dependencies: Vec::new(),
        declared_blocks: Vec::new(),
        has_extensions: false,
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
            }),
            Node::Include(n) => {
                meta.dependencies.push(DependencyRef {
                    kind: DependencyKind::Include,
                    raw_path: n.file.path.clone(),
                    line: n.line,
                    column: n.column,
                    from_filename: n.filename.clone(),
                });
                collect_from_nodes(&n.block.nodes, meta);
            }
            Node::RawInclude(n) => {
                meta.dependencies.push(DependencyRef {
                    kind: DependencyKind::RawInclude,
                    raw_path: n.file.path.clone(),
                    line: n.line,
                    column: n.column,
                    from_filename: n.filename.clone(),
                });
            }
            Node::Tag(t) => collect_from_nodes(&t.block.nodes, meta),
            Node::InterpolatedTag(t) => collect_from_nodes(&t.block.nodes, meta),
            Node::Extension(_) => meta.has_extensions = true,
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
