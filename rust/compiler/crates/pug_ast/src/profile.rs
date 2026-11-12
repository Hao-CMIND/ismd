#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum Stage {
    NapiEntry = 0,
    PreLexCallback,
    Lexer,
    StripComments,
    PostLexCallback,
    PreParseCallback,
    Parser,
    PostParseCallback,
    PreLoadCallback,
    Loader,
    Resolve,
    FileRead,
    PostLoadCallback,
    PreFiltersCallback,
    Filters,
    FilterCallback,
    PostFiltersCallback,
    PreLinkCallback,
    Linker,
    PostLinkCallback,
    PreCodegenCallback,
    OxcParse,
    OxcSemantic,
    ConstantEvaluation,
    ScopeAnalysis,
    Attrs,
    Codegen,
    RuntimeBuild,
    PostCodegenCallback,
    NapiReturn,
    Other,
}

impl Stage {
    pub const COUNT: usize = Stage::Other as usize + 1;

    pub const ALL: [Stage; Stage::COUNT] = [
        Stage::NapiEntry,
        Stage::PreLexCallback,
        Stage::Lexer,
        Stage::StripComments,
        Stage::PostLexCallback,
        Stage::PreParseCallback,
        Stage::Parser,
        Stage::PostParseCallback,
        Stage::PreLoadCallback,
        Stage::Loader,
        Stage::Resolve,
        Stage::FileRead,
        Stage::PostLoadCallback,
        Stage::PreFiltersCallback,
        Stage::Filters,
        Stage::FilterCallback,
        Stage::PostFiltersCallback,
        Stage::PreLinkCallback,
        Stage::Linker,
        Stage::PostLinkCallback,
        Stage::PreCodegenCallback,
        Stage::OxcParse,
        Stage::OxcSemantic,
        Stage::ConstantEvaluation,
        Stage::ScopeAnalysis,
        Stage::Attrs,
        Stage::Codegen,
        Stage::RuntimeBuild,
        Stage::PostCodegenCallback,
        Stage::NapiReturn,
        Stage::Other,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Stage::NapiEntry => "napi_entry",
            Stage::PreLexCallback => "pre_lex_callback",
            Stage::Lexer => "lexer",
            Stage::StripComments => "strip_comments",
            Stage::PostLexCallback => "post_lex_callback",
            Stage::PreParseCallback => "pre_parse_callback",
            Stage::Parser => "parser",
            Stage::PostParseCallback => "post_parse_callback",
            Stage::PreLoadCallback => "pre_load_callback",
            Stage::Loader => "loader",
            Stage::Resolve => "resolve",
            Stage::FileRead => "file_read",
            Stage::PostLoadCallback => "post_load_callback",
            Stage::PreFiltersCallback => "pre_filters_callback",
            Stage::Filters => "filters",
            Stage::FilterCallback => "filter_callback",
            Stage::PostFiltersCallback => "post_filters_callback",
            Stage::PreLinkCallback => "pre_link_callback",
            Stage::Linker => "linker",
            Stage::PostLinkCallback => "post_link_callback",
            Stage::PreCodegenCallback => "pre_codegen_callback",
            Stage::OxcParse => "oxc_parse",
            Stage::OxcSemantic => "oxc_semantic",
            Stage::ConstantEvaluation => "constant_evaluation",
            Stage::ScopeAnalysis => "scope_analysis",
            Stage::Attrs => "attrs",
            Stage::Codegen => "codegen",
            Stage::RuntimeBuild => "runtime_build",
            Stage::PostCodegenCallback => "post_codegen_callback",
            Stage::NapiReturn => "napi_return",
            Stage::Other => "other",
        }
    }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct FileProfileCounters {
    pub read_count: u64,
    pub lexer_count: u64,
    pub parser_count: u64,
    pub source_cache_hit_count: u64,
    pub parse_cache_hit_count: u64,
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ProfileCounters {
    pub lexer_count: u64,
    pub parser_count: u64,
    pub file_read_count: u64,
    pub resolve_count: u64,
    pub host_callback_count: u64,
    pub ast_roundtrip_count: u64,
    pub token_roundtrip_count: u64,
    pub oxc_parse_count: u64,
    pub oxc_semantic_count: u64,
    pub eval_constant_count: u64,
    pub scope_analysis_count: u64,
    pub layout_parse_count: u64,
    pub include_parse_count: u64,
    pub allocator_create_count: u64,
    pub source_cache_hit_count: u64,
    pub parse_cache_hit_count: u64,
    pub ast_clone_count: u64,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub per_file: std::collections::BTreeMap<String, FileProfileCounters>,
}

#[cfg(feature = "profile")]
mod imp {
    use super::{ProfileCounters, Stage};
    use std::cell::RefCell;
    use std::time::Instant;

    struct Frame {
        stage: Stage,
        start: Instant,
        child_ns: u64,
    }

    struct State {
        active: bool,
        session_start: Option<Instant>,
        stack: Vec<Frame>,
        exclusive_ns: [u64; Stage::COUNT],
        inclusive_ns: [u64; Stage::COUNT],
        counters: ProfileCounters,
        last_json: Option<String>,
    }

    impl Default for State {
        fn default() -> Self {
            Self {
                active: false,
                session_start: None,
                stack: Vec::with_capacity(16),
                exclusive_ns: [0; Stage::COUNT],
                inclusive_ns: [0; Stage::COUNT],
                counters: ProfileCounters::default(),
                last_json: None,
            }
        }
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::new(State::default());
    }

    pub struct ScopeGuard {
        active: bool,
    }

    impl Drop for ScopeGuard {
        fn drop(&mut self) {
            if !self.active {
                return;
            }
            STATE.with(|cell| {
                let mut st = cell.borrow_mut();
                let Some(frame) = st.stack.pop() else {
                    return;
                };
                let elapsed = frame.start.elapsed().as_nanos() as u64;
                let self_ns = elapsed.saturating_sub(frame.child_ns);
                let idx = frame.stage as usize;
                st.exclusive_ns[idx] = st.exclusive_ns[idx].saturating_add(self_ns);
                let already_on_stack = st.stack.iter().any(|f| f.stage == frame.stage);
                if !already_on_stack {
                    st.inclusive_ns[idx] = st.inclusive_ns[idx].saturating_add(elapsed);
                }
                if let Some(parent) = st.stack.last_mut() {
                    parent.child_ns = parent.child_ns.saturating_add(elapsed);
                }
            });
        }
    }

    pub struct SessionGuard {
        active: bool,
    }

    impl Drop for SessionGuard {
        fn drop(&mut self) {
            if !self.active {
                return;
            }
            finish_session();
        }
    }

    pub fn begin_session() -> SessionGuard {
        let enabled = std::env::var_os("PUG_PROFILE").is_some_and(|v| v == "1");
        if !enabled {
            return SessionGuard { active: false };
        }
        STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            st.active = true;
            st.session_start = Some(Instant::now());
            st.stack.clear();
            st.exclusive_ns = [0; Stage::COUNT];
            st.inclusive_ns = [0; Stage::COUNT];
            st.counters = ProfileCounters::default();
        });
        SessionGuard { active: true }
    }

    fn finish_session() {
        STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            if !st.active {
                return;
            }
            let total_ns = st
                .session_start
                .take()
                .map(|s| s.elapsed().as_nanos() as u64)
                .unwrap_or(0);
            st.active = false;
            st.stack.clear();

            let mut stages_map = serde_json::Map::new();
            let mut inclusive_map = serde_json::Map::new();
            for stage in Stage::ALL {
                let idx = stage as usize;
                let ex_ms = st.exclusive_ns[idx] as f64 / 1_000_000.0;
                let in_ms = st.inclusive_ns[idx] as f64 / 1_000_000.0;
                stages_map.insert(
                    String::from(stage.as_str()),
                    serde_json::Value::from(ex_ms),
                );
                inclusive_map.insert(
                    String::from(stage.as_str()),
                    serde_json::Value::from(in_ms),
                );
            }

            let report = serde_json::json!({
                "totalCompileMs": total_ns as f64 / 1_000_000.0,
                "stagesExclusiveMs": stages_map,
                "stagesInclusiveMs": inclusive_map,
                "counters": st.counters,
            });
            st.last_json = Some(report.to_string());
        });
    }

    pub fn scope(stage: Stage) -> ScopeGuard {
        let active = STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            if !st.active {
                return false;
            }
            st.stack.push(Frame {
                stage,
                start: Instant::now(),
                child_ns: 0,
            });
            true
        });
        ScopeGuard { active }
    }

    pub fn with_counters(f: impl FnOnce(&mut ProfileCounters)) {
        STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            if st.active {
                f(&mut st.counters);
            }
        });
    }

    pub fn record_file(
        filename: Option<&str>,
        f: impl FnOnce(&mut super::FileProfileCounters),
    ) {
        let Some(name) = filename else {
            return;
        };
        STATE.with(|cell| {
            let mut st = cell.borrow_mut();
            if st.active {
                let entry = st.counters.per_file.entry(name.to_string()).or_default();
                f(entry);
            }
        });
    }

    pub fn last_report_json() -> Option<String> {
        STATE.with(|cell| cell.borrow().last_json.clone())
    }
}

#[cfg(not(feature = "profile"))]
mod imp {
    use super::{FileProfileCounters, ProfileCounters, Stage};

    pub struct ScopeGuard;
    pub struct SessionGuard;

    #[inline(always)]
    pub fn begin_session() -> SessionGuard {
        SessionGuard
    }

    #[inline(always)]
    pub fn scope(_stage: Stage) -> ScopeGuard {
        ScopeGuard
    }

    #[inline(always)]
    pub fn with_counters(_f: impl FnOnce(&mut ProfileCounters)) {}

    #[inline(always)]
    pub fn record_file(_filename: Option<&str>, _f: impl FnOnce(&mut FileProfileCounters)) {}

    #[inline(always)]
    pub fn last_report_json() -> Option<String> {
        None
    }
}

pub use imp::{
    ScopeGuard, SessionGuard, begin_session, last_report_json, record_file, scope, with_counters,
};
