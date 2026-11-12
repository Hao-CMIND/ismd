use std::sync::Arc;

use pug_error::PugError;
use rayon::prelude::*;

use crate::{
    CompileOptions, DefaultHost, TemplateStore, TemplateStoreStats, compile_body_with_store,
    io_read_error,
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

pub struct CompilerSession {
    store: Arc<TemplateStore>,
    default_options: CompileOptions,
}

impl CompilerSession {
    pub fn new(default_options: CompileOptions) -> Self {
        Self {
            store: Arc::new(TemplateStore::new()),
            default_options,
        }
    }

    pub fn with_store(store: Arc<TemplateStore>, default_options: CompileOptions) -> Self {
        Self {
            store,
            default_options,
        }
    }

    pub fn store(&self) -> &Arc<TemplateStore> {
        &self.store
    }

    pub fn default_options(&self) -> &CompileOptions {
        &self.default_options
    }

    pub fn update_files(&self, files: &[(String, String)]) {
        for (path, source) in files {
            self.store.update_virtual_source(path, source.clone());
        }
    }

    pub fn invalidate_files(&self, paths: &[String]) {
        for path in paths {
            self.store.invalidate_path(path);
        }
    }

    pub fn clear(&self) {
        self.store.clear();
    }

    pub fn stats(&self) -> TemplateStoreStats {
        self.store.stats()
    }

    pub fn compile_entries(&self, entries: &[BatchEntryInput]) -> Vec<BatchEntryOutput> {
        compile_batch_with_store(entries, &self.default_options, &self.store)
    }

    pub fn compile_entries_with_mode(
        &self,
        entries: &[BatchEntryInput],
        mode: ParallelMode,
    ) -> Vec<BatchEntryOutput> {
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
