use ismd_plugin_abi::{
    IsmdPluginDescriptorV1, IsmdSyntaxDescriptor, IsmdSyntaxKind,
    IsmdTransformRequest, IsmdTransformResponse, ISMD_PLUGIN_ABI_VERSION,
    ISMD_PLUGIN_CAP_THREAD_SAFE, ISMD_STATUS_ERR, ISMD_STATUS_OK, ISMD_STATUS_PANIC,
};
use std::ffi::CStr;

static PLUGIN_ID: &[u8] = b"ismd_filter_uppercase\0";
static PLUGIN_VERSION: &[u8] = b"0.1.0\0";
static RULE_ID: &[u8] = b"uppercase_rule\0";
static PREFIX: &[u8] = b":\0";

static SYNTAX_DESCRIPTORS: [IsmdSyntaxDescriptor; 1] = [IsmdSyntaxDescriptor {
    rule_id: RULE_ID.as_ptr() as *const _,
    syntax_kind: IsmdSyntaxKind::BlockPrefix,
    prefix: PREFIX.as_ptr() as *const _,
}];

unsafe extern "C" fn transform_fn(
    request: *const IsmdTransformRequest<'_>,
    response: *mut IsmdTransformResponse,
) -> i32 {
    let result = std::panic::catch_unwind(|| {
        if request.is_null() || response.is_null() {
            return ISMD_STATUS_ERR;
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
            return ISMD_STATUS_ERR;
        }

        let content_str = match unsafe { req.content.as_str() } {
            Ok(s) => s,
            Err(e) => {
                resp.set_error(format!("Invalid UTF-8 in content: {e}"));
                return ISMD_STATUS_ERR;
            }
        };

        let upper = content_str.to_uppercase();
        resp.set_text_output(upper);
        ISMD_STATUS_OK
    });

    match result {
        Ok(code) => code,
        Err(_) => {
            if !response.is_null() {
                unsafe {
                    (*response).set_error("Panic caught in uppercase plugin transform".to_string());
                }
            }
            ISMD_STATUS_PANIC
        }
    }
}

static DESCRIPTOR: IsmdPluginDescriptorV1 = IsmdPluginDescriptorV1 {
    abi_version: ISMD_PLUGIN_ABI_VERSION,
    plugin_id: PLUGIN_ID.as_ptr() as *const _,
    plugin_version: PLUGIN_VERSION.as_ptr() as *const _,
    capabilities: ISMD_PLUGIN_CAP_THREAD_SAFE,
    syntax_count: 1,
    syntax_descriptors: SYNTAX_DESCRIPTORS.as_ptr(),
    transform_fn: Some(transform_fn),
    init_fn: None,
    shutdown_fn: None,
};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ismd_plugin_entry_v1() -> *const IsmdPluginDescriptorV1 {
    &DESCRIPTOR
}
