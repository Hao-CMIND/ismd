use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use pug_error::PugError;
use rayon::prelude::*;

use crate::{
    CompileOptions, DefaultHost, TemplateId, TemplateStore, TemplateStoreStats,
    compile_body_with_store, io_read_error, normalize_cache_path,
};

pub const DEFAULT_PARALLEL_THRESHOLD: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParallelMode {
    Auto(usize),
    ForceParallel,
    ForceSerial,
}

impl Default for ParallelMode {
    fn default() -> Self {
        Self::Auto(DEFAULT_PARALLEL_THRESHOLD)
    }
}

impl ParallelMode {
    pub fn should_parallelize(self, len: usize) -> bool {
        match self {
            ParallelMode::Auto(threshold) => len >= threshold,
            ParallelMode::ForceParallel => len > 1,
            ParallelMode::ForceSerial => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BatchEntryInput {
    pub id: String,
    pub filename: Option<String>,
    pub source: Option<String>,
    pub options: Option<CompileOptions>,
}

#[derive(Debug, Clone)]
pub struct BatchEntryOutput {
    pub id: String,
    pub ok: bool,
    pub body: Option<String>,
    pub dependencies: Vec<String>,
    pub error: Option<PugError>,
    pub plain_error: Option<String>,
    pub plain_error_code: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct IncrementalUpdateReport {
    pub changed: bool,
    pub changed_files: Vec<String>,
    pub invalidated_templates: Vec<String>,
    pub affected_entries: Vec<String>,
}

pub struct CompilerSession {
    store: Arc<TemplateStore>,
    default_options: CompileOptions,
    registered_entries: RwLock<Vec<BatchEntryInput>>,
    entry_index_by_path: RwLock<HashMap<String, usize>>,
    pending_affected: RwLock<Vec<usize>>,
}

impl CompilerSession {
    pub fn new(default_options: CompileOptions) -> Self {
        Self::with_store(Arc::new(TemplateStore::new()), default_options)
    }

    pub fn with_store(store: Arc<TemplateStore>, default_options: CompileOptions) -> Self {
        Self {
            store,
            default_options,
            registered_entries: RwLock::new(Vec::new()),
            entry_index_by_path: RwLock::new(HashMap::new()),
            pending_affected: RwLock::new(Vec::new()),
        }
    }

    pub fn store(&self) -> &Arc<TemplateStore> {
        &self.store
    }

    pub fn default_options(&self) -> &CompileOptions {
        &self.default_options
    }

    pub fn register_entries(&self, entries: &[BatchEntryInput]) {
        let mut reg = self
            .registered_entries
            .write()
            .expect("registered_entries rwlock poisoned");
        let mut by_path = self
            .entry_index_by_path
            .write()
            .expect("entry_index_by_path rwlock poisoned");
        for entry in entries {
            let key_path = entry
                .filename
                .as_deref()
                .or(entry.options.as_ref().and_then(|o| o.filename.as_deref()))
                .unwrap_or(&entry.id);
            let norm = normalize_cache_path(key_path);
            if let Some(&idx) = by_path.get(&norm) {
                reg[idx] = entry.clone();
            } else {
                let idx = reg.len();
                reg.push(entry.clone());
                by_path.insert(norm, idx);
            }
        }
    }

    pub fn update_files(&self, files: &[(String, String)]) {
        let _ = self.update_files_incremental(files);
    }

    pub fn update_files_incremental(&self, files: &[(String, String)]) -> IncrementalUpdateReport {
        let mut changed_files = Vec::new();
        let mut changed_ids = Vec::new();
        for (path, source) in files {
            let (entry, changed) = self
                .store
                .update_virtual_source_checked(path, source.clone());
            if changed {
                changed_files.push(path.clone());
                changed_ids.push(entry.id);
            }
        }

        if changed_ids.is_empty() {
            return IncrementalUpdateReport::default();
        }

        // If any registered entry previously had inline `source: Some(...)` and its path was updated,
        // clear inline source so subsequent compileAffected reads the updated source from TemplateStore.
        {
            let changed_norms: HashSet<String> = files
                .iter()
                .map(|(p, _)| normalize_cache_path(p))
                .collect();
            let mut reg = self
                .registered_entries
                .write()
                .expect("registered_entries rwlock poisoned");
            for entry in reg.iter_mut() {
                if entry.source.is_some() {
                    let key_path = entry
                        .filename
                        .as_deref()
                        .or(entry.options.as_ref().and_then(|o| o.filename.as_deref()))
                        .unwrap_or(&entry.id);
                    if changed_norms.contains(&normalize_cache_path(key_path)) {
                        entry.source = None;
                    }
                }
            }
        }

        self.build_invalidation_report(changed_files, &changed_ids)
    }

    pub fn invalidate_files(&self, paths: &[String]) {
        let _ = self.invalidate_files_incremental(paths);
    }

    pub fn invalidate_files_incremental(&self, paths: &[String]) -> IncrementalUpdateReport {
        let mut changed_files = Vec::new();
        let mut changed_ids = Vec::new();
        for path in paths {
            if let Some(id) = self.store.invalidate_path_checked(path) {
                changed_files.push(path.clone());
                changed_ids.push(id);
            }
        }
        if changed_ids.is_empty() {
            return IncrementalUpdateReport::default();
        }
        self.build_invalidation_report(changed_files, &changed_ids)
    }

    fn build_invalidation_report(
        &self,
        changed_files: Vec<String>,
        changed_ids: &[TemplateId],
    ) -> IncrementalUpdateReport {
        let affected_ids = self.store.dag().collect_affected(changed_ids);
        let affected_id_set: HashSet<TemplateId> = affected_ids.iter().copied().collect();

        let mut invalidated_templates = Vec::with_capacity(affected_ids.len());
        for &id in &affected_ids {
            if let Some(path) = self.store.path_for_id(id) {
                invalidated_templates.push(path);
            }
        }

        let reg = self
            .registered_entries
            .read()
            .expect("registered_entries rwlock poisoned");
        let mut affected_entries = Vec::new();
        let mut affected_indices = Vec::new();
        for (idx, entry) in reg.iter().enumerate() {
            let key_path = entry
                .filename
                .as_deref()
                .or(entry.options.as_ref().and_then(|o| o.filename.as_deref()))
                .unwrap_or(&entry.id);
            if let Some(entry_id) = self.store.id_for_path(key_path) {
                if affected_id_set.contains(&entry_id) {
                    affected_entries.push(entry.id.clone());
                    affected_indices.push(idx);
                }
            }
        }
        drop(reg);

        if !affected_indices.is_empty() {
            let mut pending = self
                .pending_affected
                .write()
                .expect("pending_affected rwlock poisoned");
            let mut seen: HashSet<usize> = pending.iter().copied().collect();
            for idx in affected_indices {
                if seen.insert(idx) {
                    pending.push(idx);
                }
            }
        }

        IncrementalUpdateReport {
            changed: true,
            changed_files,
            invalidated_templates,
            affected_entries,
        }
    }

    pub fn affected_entries(&self) -> Vec<String> {
        let pending = self
            .pending_affected
            .read()
            .expect("pending_affected rwlock poisoned");
        let reg = self
            .registered_entries
            .read()
            .expect("registered_entries rwlock poisoned");
        pending
            .iter()
            .filter_map(|&idx| reg.get(idx).map(|e| e.id.clone()))
            .collect()
    }

    pub fn compile_affected_with_mode(&self, mode: ParallelMode) -> Vec<BatchEntryOutput> {
        let indices: Vec<usize> = {
            let mut pending = self
                .pending_affected
                .write()
                .expect("pending_affected rwlock poisoned");
            std::mem::take(&mut *pending)
        };
        if indices.is_empty() {
            return Vec::new();
        }
        let entries: Vec<BatchEntryInput> = {
            let reg = self
                .registered_entries
                .read()
                .expect("registered_entries rwlock poisoned");
            indices
                .into_iter()
                .filter_map(|idx| reg.get(idx).cloned())
                .collect()
        };
        compile_batch_with_mode(&entries, &self.default_options, &self.store, mode)
    }

    pub fn clear(&self) {
        self.store.clear();
        self.registered_entries
            .write()
            .expect("registered_entries rwlock poisoned")
            .clear();
        self.entry_index_by_path
            .write()
            .expect("entry_index_by_path rwlock poisoned")
            .clear();
        self.pending_affected
            .write()
            .expect("pending_affected rwlock poisoned")
            .clear();
    }

    pub fn stats(&self) -> TemplateStoreStats {
        self.store.stats()
    }

    pub fn compile_entries(&self, entries: &[BatchEntryInput]) -> Vec<BatchEntryOutput> {
        self.register_entries(entries);
        compile_batch_with_store(entries, &self.default_options, &self.store)
    }

    pub fn compile_entries_with_mode(
        &self,
        entries: &[BatchEntryInput],
        mode: ParallelMode,
    ) -> Vec<BatchEntryOutput> {
        self.register_entries(entries);
        compile_batch_with_mode(entries, &self.default_options, &self.store, mode)
    }
}

pub fn compile_batch_with_store(
    entries: &[BatchEntryInput],
    default_options: &CompileOptions,
    store: &TemplateStore,
) -> Vec<BatchEntryOutput> {
    compile_batch_with_mode(entries, default_options, store, ParallelMode::default())
}

pub fn compile_batch_with_mode(
    entries: &[BatchEntryInput],
    default_options: &CompileOptions,
    store: &TemplateStore,
    mode: ParallelMode,
) -> Vec<BatchEntryOutput> {
    if mode.should_parallelize(entries.len()) {
        entries
            .par_iter()
            .map(|entry| compile_single_entry(entry, default_options, store))
            .collect()
    } else {
        entries
            .iter()
            .map(|entry| compile_single_entry(entry, default_options, store))
            .collect()
    }
}

pub(crate) fn compile_single_entry(
    entry: &BatchEntryInput,
    default_options: &CompileOptions,
    store: &TemplateStore,
) -> BatchEntryOutput {
    let mut opts = entry
        .options
        .clone()
        .unwrap_or_else(|| default_options.clone());
    if entry.filename.is_some() {
        opts.filename = entry.filename.clone();
    }

    let loaded_text: Option<String> = if let Some(ref src) = entry.source {
        Some(src.clone())
    } else if let Some(ref fname) = opts.filename {
        match store.load_or_read_disk(fname) {
            Ok((source_entry, _hit)) => Some(source_entry.text.to_string()),
            Err(e) => {
                let pug_err = io_read_error(e, fname, None, 0);
                return err_to_output(entry.id.clone(), pug_err);
            }
        }
    } else {
        return BatchEntryOutput {
            id: entry.id.clone(),
            ok: false,
            body: None,
            dependencies: Vec::new(),
            error: None,
            plain_error: Some(String::from(
                "Batch entry requires either `source` or `filename`",
            )),
            plain_error_code: None,
        };
    };

    let src = loaded_text.as_deref().unwrap_or("");
    let mut host = DefaultHost;
    match compile_body_with_store(src, &opts, &mut host, store) {
        Ok(res) => BatchEntryOutput {
            id: entry.id.clone(),
            ok: true,
            body: Some(res.body),
            dependencies: res.dependencies,
            error: None,
            plain_error: None,
            plain_error_code: None,
        },
        Err(err) => err_to_output(entry.id.clone(), err),
    }
}

fn err_to_output(id: String, err: PugError) -> BatchEntryOutput {
    if err.is_js_host_exception {
        BatchEntryOutput {
            id,
            ok: false,
            body: None,
            dependencies: Vec::new(),
            error: None,
            plain_error: Some(err.message),
            plain_error_code: err.plain_error_code,
        }
    } else {
        BatchEntryOutput {
            id,
            ok: false,
            body: None,
            dependencies: Vec::new(),
            error: Some(err),
            plain_error: None,
            plain_error_code: None,
        }
    }
}
