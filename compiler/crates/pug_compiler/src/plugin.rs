use libloading::{Library, Symbol};
use pug_ast::{BlockNode, Node, TextNode};
use pug_error::PugError;
use pug_lexer::GenericSyntaxRule;
use pug_plugin_abi::{
    PugPluginDescriptorV1, PugPluginEntryFnV1, PugPluginStringView, PugTransformRequest,
    PugTransformResponse, PUG_OUTPUT_RAW_HTML, PUG_PLUGIN_ABI_VERSION,
    PUG_PLUGIN_CAP_THREAD_SAFE, PUG_PLUGIN_ENTRY_SYMBOL_V1, PUG_STATUS_OK,
};
use pug_walk::walk_mut;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct LoadedNativePlugin {
    pub path: PathBuf,
    pub library: Library,
    pub descriptor: &'static PugPluginDescriptorV1,
    pub plugin_id: String,
    pub plugin_version: String,
    pub is_thread_safe: bool,
}

unsafe impl Send for LoadedNativePlugin {}
unsafe impl Sync for LoadedNativePlugin {}

#[derive(Default, Clone)]
pub struct NativePluginManager {
    plugins: Vec<Arc<LoadedNativePlugin>>,
    rule_to_plugin: HashMap<String, Arc<LoadedNativePlugin>>,
    syntax_rules: Vec<GenericSyntaxRule>,
    loaded_paths: HashMap<PathBuf, Arc<LoadedNativePlugin>>,
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

    pub fn load_plugin(&mut self, path: &Path) -> Result<Arc<LoadedNativePlugin>, PugError> {
        let abs_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if let Some(existing) = self.loaded_paths.get(&abs_path) {
            return Ok(existing.clone());
        }

        let lib = unsafe { Library::new(path) }.map_err(|e| {
            PugError::host_exception(format!(
                "Failed to load native dynamic plugin at '{}': {e}",
                path.display()
            ))
        })?;

        let entry: Symbol<PugPluginEntryFnV1> = unsafe { lib.get(PUG_PLUGIN_ENTRY_SYMBOL_V1) }
            .map_err(|e| {
                PugError::host_exception(format!(
                    "Failed to find symbol 'pug_plugin_entry_v1' in '{}': {e}",
                    path.display()
                ))
            })?;

        let descriptor_ptr = unsafe { entry() };
        if descriptor_ptr.is_null() {
            return Err(PugError::host_exception(format!(
                "Plugin at '{}' returned null descriptor",
                path.display()
            )));
        }
        let descriptor = unsafe { &*descriptor_ptr };

        if descriptor.abi_version != PUG_PLUGIN_ABI_VERSION {
            return Err(PugError::host_exception(format!(
                "Incompatible plugin ABI version: expected {}, got {} in '{}'",
                PUG_PLUGIN_ABI_VERSION,
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

        let is_thread_safe = (descriptor.capabilities & PUG_PLUGIN_CAP_THREAD_SAFE) != 0;

        if let Some(init_fn) = descriptor.init_fn {
            let code = unsafe { init_fn() };
            if code != PUG_STATUS_OK {
                return Err(PugError::host_exception(format!(
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
                    matches!(desc.syntax_kind, pug_plugin_abi::PugSyntaxKind::BlockPrefix);
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

    /// Select only this compilation's registrations; cached libraries stay alive in the store.
    pub fn select_plugins(&self, paths: &[String]) -> Self {
        let mut selected = Self::new();
        for path in paths {
            let path = Path::new(path);
            let key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
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

    pub fn transform_ast(&self, ast: &mut BlockNode) -> Result<(), PugError> {
        if self.plugins.is_empty() {
            return Ok(());
        }
        walk_mut(ast, true, &mut |node: &mut Node| -> Result<bool, PugError> {
            if let Node::Extension(ext) = node {
                let plugin = self.rule_to_plugin.get(&ext.rule_id).ok_or_else(|| {
                    PugError::host_exception(format!(
                        "No loaded native plugin registered for syntax rule '{}'",
                        ext.rule_id
                    ))
                })?;
                let transform_fn = plugin.descriptor.transform_fn.ok_or_else(|| {
                    PugError::host_exception(format!(
                        "Plugin '{}' does not provide transform_fn",
                        plugin.plugin_id
                    ))
                })?;

                let rule_id_c = CString::new(ext.rule_id.clone()).unwrap_or_default();
                let target_name_c = CString::new(ext.target_name.clone()).unwrap_or_default();
                let filename_c = ext.filename.as_deref().and_then(|f| CString::new(f).ok());

                let req = PugTransformRequest {
                    rule_id: rule_id_c.as_ptr(),
                    target_name: target_name_c.as_ptr(),
                    content: PugPluginStringView::from_str(&ext.raw_content),
                    options_json: PugPluginStringView::from_str(
                        ext.options_json.as_deref().unwrap_or("{}"),
                    ),
                    filename: filename_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    line: ext.line,
                    column: ext.column.unwrap_or(0),
                    _marker: std::marker::PhantomData,
                };

                let mut resp = PugTransformResponse::default();
                let status = unsafe { transform_fn(&req, &mut resp) };

                if status != PUG_STATUS_OK || !resp.success {
                    let err_msg = resp.error_message.to_string_lossy();
                    let msg = if err_msg.is_empty() {
                        format!(
                            "Plugin '{}' transform failed with exit code {}",
                            plugin.plugin_id, status
                        )
                    } else {
                        err_msg
                    };
                    return Err(PugError::host_exception(msg));
                }

                let output_str = resp.output.to_string_lossy();
                let is_html = if resp.output_kind == PUG_OUTPUT_RAW_HTML {
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
