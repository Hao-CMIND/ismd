use libloading::{Library, Symbol};
use ismd_ast::{BlockNode, Node, TextNode};
use ismd_error::IsmdError;
use ismd_lexer::GenericSyntaxRule;
use ismd_plugin_abi::{
    IsmdPluginDescriptorV1, IsmdPluginEntryFnV1, IsmdPluginStringView, IsmdTransformRequest,
    IsmdTransformResponse, ISMD_OUTPUT_RAW_HTML, ISMD_PLUGIN_ABI_VERSION,
    ISMD_PLUGIN_CAP_THREAD_SAFE, ISMD_PLUGIN_ENTRY_SYMBOL_V1, ISMD_STATUS_OK,
};
use ismd_walk::walk_mut;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

pub struct LoadedNativePlugin {
    pub path: PathBuf,
    pub library: Library,
    pub descriptor: &'static IsmdPluginDescriptorV1,
    pub plugin_id: String,
    pub plugin_version: String,
    pub is_thread_safe: bool,
    pub mtime_ns: u128,
    pub file_len: u64,
    call_mutex: Mutex<()>,
}

impl LoadedNativePlugin {
    pub fn fingerprint(&self) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.plugin_id.hash(&mut hasher);
        self.plugin_version.hash(&mut hasher);
        self.mtime_ns.hash(&mut hasher);
        self.file_len.hash(&mut hasher);
        hasher.finish()
    }
}

fn read_file_stamp(path: &Path) -> (u128, u64) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            (mtime_ns, meta.len())
        }
        Err(_) => (0, 0),
    }
}

unsafe impl Send for LoadedNativePlugin {}
unsafe impl Sync for LoadedNativePlugin {}

impl Drop for LoadedNativePlugin {
    fn drop(&mut self) {
        if let Some(shutdown_fn) = self.descriptor.shutdown_fn {
            unsafe {
                shutdown_fn();
            }
        }
    }
}

#[derive(Default, Clone)]
pub struct NativePluginManager {
    plugins: Vec<Arc<LoadedNativePlugin>>,
    rule_to_plugin: HashMap<String, Arc<LoadedNativePlugin>>,
    syntax_rules: Vec<GenericSyntaxRule>,
    loaded_paths: HashMap<PathBuf, Arc<LoadedNativePlugin>>,
    raw_path_aliases: HashMap<String, PathBuf>,
}

impl NativePluginManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has_plugins(&self) -> bool {
        !self.plugins.is_empty()
    }

    pub fn syntax_rules(&self) -> &[GenericSyntaxRule] {
        &self.syntax_rules
    }

    pub fn plugins(&self) -> &[Arc<LoadedNativePlugin>] {
        &self.plugins
    }

    pub fn load_plugin(&mut self, path: &Path) -> Result<Arc<LoadedNativePlugin>, IsmdError> {
        let raw_str = path.to_string_lossy().into_owned();
        let abs_path = if let Some(cached_abs) = self.raw_path_aliases.get(&raw_str) {
            cached_abs.clone()
        } else {
            let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            self.raw_path_aliases.insert(raw_str, resolved.clone());
            resolved
        };
        let (mtime_ns, file_len) = read_file_stamp(&abs_path);
        if let Some(existing) = self.loaded_paths.get(&abs_path) {
            if existing.mtime_ns == mtime_ns && existing.file_len == file_len {
                return Ok(existing.clone());
            }
            if let Some(old) = self.loaded_paths.remove(&abs_path) {
                self.unload_plugin_rules(&old);
            }
        }

        let lib = unsafe { Library::new(&abs_path) }.map_err(|e| {
            IsmdError::host_exception(format!(
                "Failed to load native dynamic plugin at '{}': {e}",
                path.display()
            ))
        })?;

        let entry: Symbol<IsmdPluginEntryFnV1> = unsafe { lib.get(ISMD_PLUGIN_ENTRY_SYMBOL_V1) }
            .map_err(|e| {
                IsmdError::host_exception(format!(
                    "Failed to find symbol 'ismd_plugin_entry_v1' in '{}': {e}",
                    path.display()
                ))
            })?;

        let descriptor_ptr = unsafe { entry() };
        if descriptor_ptr.is_null() {
            return Err(IsmdError::host_exception(format!(
                "Plugin at '{}' returned null descriptor",
                path.display()
            )));
        }
        let descriptor = unsafe { &*descriptor_ptr };

        if descriptor.abi_version != ISMD_PLUGIN_ABI_VERSION {
            return Err(IsmdError::host_exception(format!(
                "Incompatible plugin ABI version: expected {}, got {} in '{}'",
                ISMD_PLUGIN_ABI_VERSION,
                descriptor.abi_version,
                path.display()
            )));
        }

        let plugin_id = if descriptor.plugin_id.is_null() {
            "unknown".to_string()
        } else {
            unsafe { CStr::from_ptr(descriptor.plugin_id) }
                .to_string_lossy()
                .into_owned()
        };

        let plugin_version = if descriptor.plugin_version.is_null() {
            "0.0.0".to_string()
        } else {
            unsafe { CStr::from_ptr(descriptor.plugin_version) }
                .to_string_lossy()
                .into_owned()
        };

        let is_thread_safe = (descriptor.capabilities & ISMD_PLUGIN_CAP_THREAD_SAFE) != 0;

        if let Some(init_fn) = descriptor.init_fn {
            let code = unsafe { init_fn() };
            if code != ISMD_STATUS_OK {
                return Err(IsmdError::host_exception(format!(
                    "Plugin '{}' initialization failed with exit code {}",
                    plugin_id, code
                )));
            }
        }

        let mut plugin_rules = Vec::new();
        if descriptor.syntax_count > 0 && !descriptor.syntax_descriptors.is_null() {
            let syntax_slice = unsafe {
                std::slice::from_raw_parts(descriptor.syntax_descriptors, descriptor.syntax_count)
            };
            for desc in syntax_slice {
                let rule_id = if desc.rule_id.is_null() {
                    continue;
                } else {
                    unsafe { CStr::from_ptr(desc.rule_id) }
                        .to_string_lossy()
                        .into_owned()
                };
                let prefix = if desc.prefix.is_null() {
                    continue;
                } else {
                    unsafe { CStr::from_ptr(desc.prefix) }
                        .to_string_lossy()
                        .into_owned()
                };
                let is_block =
                    matches!(desc.syntax_kind, ismd_plugin_abi::IsmdSyntaxKind::BlockPrefix);
                plugin_rules.push(GenericSyntaxRule {
                    rule_id,
                    prefix,
                    is_block,
                });
            }
        }

        let loaded = Arc::new(LoadedNativePlugin {
            path: abs_path.clone(),
            library: lib,
            descriptor,
            plugin_id,
            plugin_version,
            is_thread_safe,
            mtime_ns,
            file_len,
            call_mutex: Mutex::new(()),
        });

        for rule in &plugin_rules {
            self.rule_to_plugin
                .insert(rule.rule_id.clone(), loaded.clone());
            self.syntax_rules.push(rule.clone());
        }

        self.plugins.push(loaded.clone());
        self.loaded_paths.insert(abs_path, loaded.clone());

        Ok(loaded)
    }

    fn unload_plugin_rules(&mut self, target: &Arc<LoadedNativePlugin>) {
        self.plugins.retain(|p| !Arc::ptr_eq(p, target));
        self.rule_to_plugin
            .retain(|_, owner| !Arc::ptr_eq(owner, target));
        let remaining_rules = &self.rule_to_plugin;
        self.syntax_rules
            .retain(|rule| remaining_rules.contains_key(&rule.rule_id));
    }

    pub fn reload_plugin(&mut self, path: &Path) -> Result<Arc<LoadedNativePlugin>, IsmdError> {
        let abs_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if let Some(old) = self.loaded_paths.remove(&abs_path) {
            self.unload_plugin_rules(&old);
        }
        self.load_plugin(path)
    }

    pub fn clear(&mut self) {
        self.plugins.clear();
        self.rule_to_plugin.clear();
        self.syntax_rules.clear();
        self.loaded_paths.clear();
        self.raw_path_aliases.clear();
    }

    /// Fast-path selection under a read lock when all requested plugins are already loaded.
    pub fn try_select_plugins(&self, paths: &[String]) -> Option<Self> {
        let mut selected = Self::new();
        for raw in paths {
            let key = self.raw_path_aliases.get(raw)?;
            let plugin = self.loaded_paths.get(key)?;
            if selected.loaded_paths.contains_key(key) {
                continue;
            }
            selected.loaded_paths.insert(key.clone(), plugin.clone());
            selected.plugins.push(plugin.clone());
            for rule in &self.syntax_rules {
                if self
                    .rule_to_plugin
                    .get(&rule.rule_id)
                    .is_some_and(|owner| Arc::ptr_eq(owner, plugin))
                {
                    selected.syntax_rules.push(rule.clone());
                    selected
                        .rule_to_plugin
                        .insert(rule.rule_id.clone(), plugin.clone());
                }
            }
        }
        Some(selected)
    }

    pub fn fingerprint_for_paths(&self, paths: &[String]) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for raw in paths {
            raw.hash(&mut hasher);
            if let Some(key) = self.raw_path_aliases.get(raw) {
                if let Some(plugin) = self.loaded_paths.get(key) {
                    plugin.fingerprint().hash(&mut hasher);
                }
            }
        }
        hasher.finish()
    }

    /// Select only this compilation's registrations; cached libraries stay alive in the store.
    pub fn select_plugins(&self, paths: &[String]) -> Self {
        let mut selected = Self::new();
        for raw in paths {
            let key = if let Some(cached) = self.raw_path_aliases.get(raw) {
                cached.clone()
            } else {
                let p = Path::new(raw);
                p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
            };
            if selected.loaded_paths.contains_key(&key) { continue; }
            if let Some(plugin) = self.loaded_paths.get(&key) {
                selected.loaded_paths.insert(key, plugin.clone());
                selected.plugins.push(plugin.clone());
                for rule in &self.syntax_rules {
                    if self.rule_to_plugin.get(&rule.rule_id).is_some_and(|owner| Arc::ptr_eq(owner, plugin)) {
                        selected.syntax_rules.push(rule.clone());
                        selected.rule_to_plugin.insert(rule.rule_id.clone(), plugin.clone());
                    }
                }
            }
        }
        selected
    }

    pub fn transform_ast(&self, ast: &mut BlockNode) -> Result<(), IsmdError> {
        if self.plugins.is_empty() {
            return Ok(());
        }
        walk_mut(ast, true, &mut |node: &mut Node| -> Result<bool, IsmdError> {
            if let Node::Extension(ext) = node {
                let plugin = self.rule_to_plugin.get(&ext.rule_id).ok_or_else(|| {
                    IsmdError::host_exception(format!(
                        "No loaded native plugin registered for syntax rule '{}'",
                        ext.rule_id
                    ))
                })?;
                let transform_fn = plugin.descriptor.transform_fn.ok_or_else(|| {
                    IsmdError::host_exception(format!(
                        "Plugin '{}' does not provide transform_fn",
                        plugin.plugin_id
                    ))
                })?;

                let rule_id_c = CString::new(ext.rule_id.clone()).unwrap_or_default();
                let target_name_c = CString::new(ext.target_name.clone()).unwrap_or_default();
                let filename_c = ext.filename.as_deref().and_then(|f| CString::new(f).ok());

                let req = IsmdTransformRequest {
                    rule_id: rule_id_c.as_ptr(),
                    target_name: target_name_c.as_ptr(),
                    content: IsmdPluginStringView::from_str(&ext.raw_content),
                    options_json: IsmdPluginStringView::from_str(
                        ext.options_json.as_deref().unwrap_or("{}"),
                    ),
                    filename: filename_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    line: ext.line,
                    column: ext.column.unwrap_or(0),
                    _marker: std::marker::PhantomData,
                };

                let mut resp = IsmdTransformResponse::default();
                let status = {
                    let _guard = if !plugin.is_thread_safe {
                        Some(plugin.call_mutex.lock().unwrap_or_else(|e| e.into_inner()))
                    } else {
                        None
                    };
                    unsafe { transform_fn(&req, &mut resp) }
                };

                if status != ISMD_STATUS_OK || !resp.success {
                    let err_msg = resp.error_message.to_string_lossy();
                    let msg = if err_msg.is_empty() {
                        format!(
                            "Plugin '{}' transform failed with exit code {}",
                            plugin.plugin_id, status
                        )
                    } else {
                        err_msg
                    };
                    return Err(IsmdError::host_exception(msg));
                }

                let output_str = resp.output.to_string_lossy();
                let is_html = if resp.output_kind == ISMD_OUTPUT_RAW_HTML {
                    Some(true)
                } else {
                    None
                };

                *node = Node::Text(TextNode {
                    val: output_str,
                    line: Some(ext.line),
                    column: ext.column,
                    filename: ext.filename.clone(),
                    is_html,
                });
            }
            Ok(true)
        })?;
        Ok(())
    }
}
