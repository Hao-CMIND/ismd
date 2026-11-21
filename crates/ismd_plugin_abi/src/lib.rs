use std::ffi::c_char;

pub const ISMD_PLUGIN_ABI_VERSION: u32 = 1;

pub const ISMD_PLUGIN_CAP_THREAD_SAFE: u32 = 1 << 0;

pub const ISMD_OUTPUT_TEXT: u32 = 0;
pub const ISMD_OUTPUT_RAW_HTML: u32 = 1;

pub const ISMD_STATUS_OK: i32 = 0;
pub const ISMD_STATUS_ERR: i32 = -1;
pub const ISMD_STATUS_PANIC: i32 = -2;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct IsmdPluginStringView {
    pub ptr: *const u8,
    pub len: usize,
}

impl IsmdPluginStringView {
    pub const fn empty() -> Self {
        Self {
            ptr: std::ptr::null(),
            len: 0,
        }
    }

    pub fn from_str(s: &str) -> Self {
        Self {
            ptr: s.as_ptr(),
            len: s.len(),
        }
    }

    /// # Safety
    /// Caller must guarantee `ptr` is valid for `len` bytes and points to valid UTF-8.
    pub unsafe fn as_str<'a>(&self) -> Result<&'a str, std::str::Utf8Error> {
        if self.ptr.is_null() || self.len == 0 {
            return Ok("");
        }
        let slice = unsafe { std::slice::from_raw_parts(self.ptr, self.len) };
        std::str::from_utf8(slice)
    }
}

pub type IsmdBufferFreeFn = unsafe extern "C" fn(ptr: *mut u8, len: usize, cap: usize);

#[repr(C)]
pub struct IsmdPluginBuffer {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
    pub free_fn: Option<IsmdBufferFreeFn>,
}

impl Default for IsmdPluginBuffer {
    fn default() -> Self {
        Self::empty()
    }
}

impl IsmdPluginBuffer {
    pub const fn empty() -> Self {
        Self {
            ptr: std::ptr::null_mut(),
            len: 0,
            cap: 0,
            free_fn: None,
        }
    }

    pub fn from_string(mut s: String) -> Self {
        let ptr = s.as_mut_ptr();
        let len = s.len();
        let cap = s.capacity();
        std::mem::forget(s);
        Self {
            ptr,
            len,
            cap,
            free_fn: Some(default_buffer_free_fn),
        }
    }

    pub fn from_vec(mut v: Vec<u8>) -> Self {
        let ptr = v.as_mut_ptr();
        let len = v.len();
        let cap = v.capacity();
        std::mem::forget(v);
        Self {
            ptr,
            len,
            cap,
            free_fn: Some(default_buffer_free_fn),
        }
    }

    /// Deallocate the buffer using its own plugin-provided `free_fn`.
    pub fn release(&mut self) {
        if let Some(free_fn) = self.free_fn.take() {
            if !self.ptr.is_null() && self.cap > 0 {
                unsafe {
                    free_fn(self.ptr, self.len, self.cap);
                }
            }
        }
        self.ptr = std::ptr::null_mut();
        self.len = 0;
        self.cap = 0;
    }

    pub fn to_string_lossy(&self) -> String {
        if self.ptr.is_null() || self.len == 0 {
            return String::new();
        }
        let slice = unsafe { std::slice::from_raw_parts(self.ptr, self.len) };
        String::from_utf8_lossy(slice).into_owned()
    }
}

impl Drop for IsmdPluginBuffer {
    fn drop(&mut self) {
        self.release();
    }
}

pub unsafe extern "C" fn default_buffer_free_fn(ptr: *mut u8, len: usize, cap: usize) {
    if !ptr.is_null() && cap > 0 {
        let _ = unsafe { Vec::from_raw_parts(ptr, len, cap) };
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsmdSyntaxKind {
    /// Block prefix, e.g. `:name` with a following pipeless block
    BlockPrefix = 0,
    /// Inline prefix, e.g. `#[name ...]`
    InlinePrefix = 1,
    /// Resource prefix (reserved for a future generic resource hook)
    IncludePrefix = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct IsmdSyntaxDescriptor {
    pub rule_id: *const c_char,
    pub syntax_kind: IsmdSyntaxKind,
    pub prefix: *const c_char,
}

unsafe impl Sync for IsmdSyntaxDescriptor {}
unsafe impl Send for IsmdSyntaxDescriptor {}

#[repr(C)]
pub struct IsmdTransformRequest<'a> {
    pub rule_id: *const c_char,
    pub target_name: *const c_char,
    pub content: IsmdPluginStringView,
    pub options_json: IsmdPluginStringView,
    pub filename: *const c_char,
    pub line: usize,
    pub column: usize,
    pub _marker: std::marker::PhantomData<&'a ()>,
}

#[repr(C)]
pub struct IsmdTransformResponse {
    pub success: bool,
    pub output_kind: u32,
    pub output: IsmdPluginBuffer,
    pub error_message: IsmdPluginBuffer,
}

impl Default for IsmdTransformResponse {
    fn default() -> Self {
        Self {
            success: false,
            output_kind: ISMD_OUTPUT_TEXT,
            output: IsmdPluginBuffer::empty(),
            error_message: IsmdPluginBuffer::empty(),
        }
    }
}

impl IsmdTransformResponse {
    pub fn set_text_output(&mut self, text: String) {
        self.success = true;
        self.output_kind = ISMD_OUTPUT_TEXT;
        self.output = IsmdPluginBuffer::from_string(text);
        self.error_message = IsmdPluginBuffer::empty();
    }

    pub fn set_raw_html_output(&mut self, html: String) {
        self.success = true;
        self.output_kind = ISMD_OUTPUT_RAW_HTML;
        self.output = IsmdPluginBuffer::from_string(html);
        self.error_message = IsmdPluginBuffer::empty();
    }

    pub fn set_error(&mut self, err: String) {
        self.success = false;
        self.output = IsmdPluginBuffer::empty();
        self.error_message = IsmdPluginBuffer::from_string(err);
    }
}

pub type IsmdPluginTransformFn = unsafe extern "C" fn(
    request: *const IsmdTransformRequest<'_>,
    response: *mut IsmdTransformResponse,
) -> i32;

pub type IsmdPluginInitFn = unsafe extern "C" fn() -> i32;
pub type IsmdPluginShutdownFn = unsafe extern "C" fn() -> i32;

#[repr(C)]
pub struct IsmdPluginDescriptorV1 {
    pub abi_version: u32,
    pub plugin_id: *const c_char,
    pub plugin_version: *const c_char,
    pub capabilities: u32,
    pub syntax_count: usize,
    pub syntax_descriptors: *const IsmdSyntaxDescriptor,
    pub transform_fn: Option<IsmdPluginTransformFn>,
    pub init_fn: Option<IsmdPluginInitFn>,
    pub shutdown_fn: Option<IsmdPluginShutdownFn>,
}

unsafe impl Sync for IsmdPluginDescriptorV1 {}
unsafe impl Send for IsmdPluginDescriptorV1 {}

pub const ISMD_PLUGIN_ENTRY_SYMBOL_V1: &[u8] = b"ismd_plugin_entry_v1\0";
pub type IsmdPluginEntryFnV1 = unsafe extern "C" fn() -> *const IsmdPluginDescriptorV1;
