use pug_plugin_abi::{
    PugPluginDescriptorV1, PugSyntaxDescriptor, PugSyntaxKind,
    PugTransformRequest, PugTransformResponse, PUG_PLUGIN_ABI_VERSION,
    PUG_PLUGIN_CAP_THREAD_SAFE, PUG_STATUS_ERR, PUG_STATUS_OK, PUG_STATUS_PANIC,
};
use std::ffi::CStr;

static PLUGIN_ID: &[u8] = b"pug_filter_uppercase\0";
static PLUGIN_VERSION: &[u8] = b"0.1.0\0";
static RULE_ID: &[u8] = b"uppercase_rule\0";
static PREFIX: &[u8] = b":\0";

static SYNTAX_DESCRIPTORS: [PugSyntaxDescriptor; 1] = [PugSyntaxDescriptor {
    rule_id: RULE_ID.as_ptr() as *const _,
    syntax_kind: PugSyntaxKind::BlockPrefix,
    prefix: PREFIX.as_ptr() as *const _,
}];

unsafe extern "C" fn transform_fn(
    request: *const PugTransformRequest<'_>,
    response: *mut PugTransformResponse,
) -> i32 {
    let result = std::panic::catch_unwind(|| {
        if request.is_null() || response.is_null() {
            return PUG_STATUS_ERR;
        }
        let req = unsafe { &*request };
        let resp = unsafe { &mut *response };

        let target_name = if req.target_name.is_null() {
            ""
        } else {
            unsafe { CStr::from_ptr(req.target_name) }
                .to_str()
                .unwrap_or("")
        };

        if target_name != "uppercase" {
            resp.set_error(format!("Unsupported target filter: {target_name}"));
            return PUG_STATUS_ERR;
        }

        let content_str = match unsafe { req.content.as_str() } {
            Ok(s) => s,
            Err(e) => {
                resp.set_error(format!("Invalid UTF-8 in content: {e}"));
                return PUG_STATUS_ERR;
            }
        };

        let upper = content_str.to_uppercase();
        resp.set_text_output(upper);
        PUG_STATUS_OK
    });

    match result {
        Ok(code) => code,
        Err(_) => {
            if !response.is_null() {
                unsafe {
                    (*response).set_error("Panic caught in uppercase plugin transform".to_string());
                }
            }
            PUG_STATUS_PANIC
        }
    }
}

static DESCRIPTOR: PugPluginDescriptorV1 = PugPluginDescriptorV1 {
    abi_version: PUG_PLUGIN_ABI_VERSION,
    plugin_id: PLUGIN_ID.as_ptr() as *const _,
    plugin_version: PLUGIN_VERSION.as_ptr() as *const _,
    capabilities: PUG_PLUGIN_CAP_THREAD_SAFE,
    syntax_count: 1,
    syntax_descriptors: SYNTAX_DESCRIPTORS.as_ptr(),
    transform_fn: Some(transform_fn),
    init_fn: None,
    shutdown_fn: None,
};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pug_plugin_entry_v1() -> *const PugPluginDescriptorV1 {
    &DESCRIPTOR
}
