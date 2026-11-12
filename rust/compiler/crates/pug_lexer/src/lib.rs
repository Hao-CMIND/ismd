use pug_ast::{LineCol, SourceIndex, Token, TokenLoc};
use pug_error::{ErrorOptions, PugError};
use pug_js::scan::{
    CharacterParserErrorCode, NestingOptions, ParseUntilRange, default_state, is_punctuator_u16,
    parse as char_parse, parse_char_u16, parse_until,
};
use pug_js::{ExpressionOptions, validate_expression};
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct LexerOptions {
    pub filename: Option<String>,
    pub interpolated: bool,
    pub starting_line: Option<usize>,
    pub starting_column: Option<usize>,
    pub plugin_methods: Vec<String>,
}

/// Mutable state passed to JS `plugin.lex.<method>(lexer)` hooks.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LexerState {
    pub input: String,
    pub filename: Option<String>,
    pub lineno: usize,
    pub colno: usize,
    pub interpolated: bool,
    pub tokens: Vec<Token>,
    pub ended: bool,
}

/// Host callback interface for `options.plugins[].lex` (e.g. `#3295`).
pub trait LexerPluginHook {
    fn call_lex(&mut self, method: &str, state: &mut LexerState) -> Result<bool, PugError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IndentMode {
    Tabs,
    Spaces,
}

struct AttributeValueResponse<'s> {
    val: Option<String>,
    must_escape: bool,
    remaining_source: &'s str,
}

pub struct Lexer<'h> {
    input_buf: String,
    pos: usize,
    pub original_input: String,
    pub filename: Option<String>,
    pub interpolated: bool,
    pub lineno: usize,
    pub colno: usize,
    pub indent_stack: Vec<usize>,
    indent_mode: Option<IndentMode>,
    pub interpolation_allowed: bool,
    pub tokens: Vec<Token>,
    pub ended: bool,
    plugin_methods: Vec<String>,
    hook: Option<&'h mut dyn LexerPluginHook>,
}

pub fn lex(input: &str, options: &LexerOptions) -> Result<Vec<Token>, PugError> {
    let mut lexer = Lexer::new(input, options);
    lexer.get_tokens()
}

pub fn lex_with_hook(
    input: &str,
    options: &LexerOptions,
    hook: &mut dyn LexerPluginHook,
) -> Result<Vec<Token>, PugError> {
    let mut lexer = Lexer::with_hook(input, options, hook);
    lexer.get_tokens()
}

#[inline]
fn utf16_len(s: &str) -> usize {
    if s.is_ascii() {
        s.len()
    } else {
        s.chars().map(char::len_utf16).sum()
    }
}

/// Converts a UTF-16 code unit offset in `s` to a UTF-8 byte index in `s`.
/// Clamps to `s.len()`.
#[inline]
fn utf16_to_byte_idx(s: &str, u16_offset: usize) -> usize {
    if let Some(prefix) = s.as_bytes().get(..u16_offset) {
        if prefix.is_ascii() {
            return u16_offset;
        }
    } else if s.is_ascii() {
        return s.len();
    }
    let mut acc = 0usize;
    for (byte_idx, ch) in s.char_indices() {
        if acc >= u16_offset {
            return byte_idx;
        }
        acc += ch.len_utf16();
    }
    s.len()
}

#[inline]
fn utf16_at(s: &str, u16_offset: usize) -> u16 {
    if let Some(&b) = s.as_bytes().get(u16_offset)
        && s.as_bytes()[..u16_offset].is_ascii()
        && b < 0x80
    {
        return u16::from(b);
    }
    s.encode_utf16().nth(u16_offset).unwrap_or(0)
}

/// Equivalent to JS `s.substr(start_u16)`.
fn substr_u16(s: &str, start_u16: usize) -> &str {
    let b = utf16_to_byte_idx(s, start_u16);
    &s[b..]
}

/// Equivalent to JS `s.substr(start_u16, len_u16)`.
fn substr_u16_len(s: &str, start_u16: usize, len_u16: usize) -> &str {
    let b_start = utf16_to_byte_idx(s, start_u16);
    let b_end = utf16_to_byte_idx(&s[b_start..], len_u16) + b_start;
    &s[b_start..b_end]
}

fn is_whitespace_char(ch: char) -> bool {
    matches!(ch, ' ' | '\n' | '\t')
}

fn is_js_space(ch: char) -> bool {
    matches!(
        ch,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_ident_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ch == '$'
}

fn is_ident_cont(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

fn is_valid_ident(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    is_ident_start(first) && chars.all(is_ident_cont)
}

fn first_line(s: &str) -> &str {
    match s.find('\n') {
        Some(idx) => &s[..idx],
        None => s,
    }
}

impl Lexer<'static> {
    pub fn new(str_input: &str, options: &LexerOptions) -> Self {
        Lexer::create_inner(str_input, options, None)
    }
}

impl<'h> Lexer<'h> {
    pub fn with_hook(
        str_input: &str,
        options: &LexerOptions,
        hook: &'h mut dyn LexerPluginHook,
    ) -> Self {
        Lexer::create_inner(str_input, options, Some(hook))
    }

    fn create_inner(
        str_input: &str,
        options: &LexerOptions,
        hook: Option<&'h mut dyn LexerPluginHook>,
    ) -> Self {
        let normalized = SourceIndex::normalize_pug_input(str_input);
        let token_cap = (normalized.len() / 16).clamp(16, 1024);
        Self {
            original_input: normalized.clone(),
            input_buf: normalized,
            pos: 0,
            filename: options.filename.clone(),
            interpolated: options.interpolated,
            lineno: options.starting_line.unwrap_or(1),
            colno: options.starting_column.unwrap_or(1),
            indent_stack: vec![0],
            indent_mode: None,
            interpolation_allowed: true,
            tokens: Vec::with_capacity(token_cap),
            ended: false,
            plugin_methods: options.plugin_methods.clone(),
            hook,
        }
    }

    #[inline(always)]
    fn rest(&self) -> &str {
        &self.input_buf[self.pos..]
    }

    #[inline(always)]
    fn run_plugin_step(&mut self, method: &str) -> Result<bool, PugError> {
        if self.hook.is_none() || self.plugin_methods.is_empty() {
            return Ok(false);
        }
        if !self.plugin_methods.iter().any(|m| m == method) {
            return Ok(false);
        }
        let Some(hook) = self.hook.take() else {
            return Ok(false);
        };
        let mut state = LexerState {
            input: self.rest().to_string(),
            filename: self.filename.clone(),
            lineno: self.lineno,
            colno: self.colno,
            interpolated: self.interpolated,
            tokens: std::mem::take(&mut self.tokens),
            ended: self.ended,
        };
        let res = hook.call_lex(method, &mut state);
        self.hook = Some(hook);
        self.input_buf = state.input;
        self.pos = 0;
        self.lineno = state.lineno;
        self.colno = state.colno;
        self.tokens = state.tokens;
        self.ended = state.ended;
        res
    }

    fn error(&self, code: &str, message: impl Into<String>) -> PugError {
        PugError::new(
            code,
            message.into(),
            ErrorOptions {
                line: self.lineno as i64,
                column: Some(self.colno as i64),
                filename: self.filename.clone(),
                src: Some(self.original_input.clone()),
            },
        )
    }

    fn assert_expression(&mut self, exp: &str, no_throw: bool) -> Result<bool, PugError> {
        match validate_expression(exp, ExpressionOptions::default()) {
            Ok(()) => Ok(true),
            Err(ex) => {
                if no_throw {
                    return Ok(false);
                }
                self.increment_line(ex.line.saturating_sub(1));
                self.increment_column(ex.column as isize);
                let msg = format!("Syntax Error: {}", ex.message);
                Err(self.error("SYNTAX_ERROR", msg))
            }
        }
    }

    fn assert_nesting_correct(&self, exp: &str) -> Result<(), PugError> {
        let res = char_parse(exp, NestingOptions::default()).map_err(|e| {
            self.error("BRACKET_MISMATCH", e.message)
        })?;
        if res.is_nesting(NestingOptions::default()) {
            return Err(self.error(
                "INCORRECT_NESTING",
                format!("Nesting must match on expression `{exp}`"),
            ));
        }
        Ok(())
    }

    fn tok(&self, token_type: &str, val: Option<Value>) -> Token {
        let mut t = Token::new(
            token_type,
            TokenLoc {
                start: LineCol::new(self.lineno, self.colno),
                end: LineCol::new(self.lineno, self.colno),
                filename: self.filename.clone(),
            },
        );
        t.val = val;
        t
    }

    fn tok_str(&self, token_type: &str, val: impl Into<String>) -> Token {
        self.tok(token_type, Some(Value::String(val.into())))
    }

    fn tok_end(&self, mut tok: Token) -> Token {
        tok.loc.end = LineCol::new(self.lineno, self.colno);
        tok
    }

    fn increment_line(&mut self, increment: usize) {
        self.lineno += increment;
        if increment > 0 {
            self.colno = 1;
        }
    }

    fn increment_column(&mut self, increment: isize) {
        if increment >= 0 {
            self.colno += increment as usize;
        } else {
            self.colno = self.colno.saturating_sub((-increment) as usize);
        }
    }

    #[inline]
    fn consume_u16(&mut self, len_u16: usize) {
        let byte_idx = utf16_to_byte_idx(self.rest(), len_u16);
        self.pos += byte_idx;
    }

    fn scan_exact(&mut self, cap0_u16: usize, cap1: Option<String>, token_type: &str) -> Token {
        let val_len = cap1.as_ref().map(|v| utf16_len(v)).unwrap_or(0);
        let diff = cap0_u16.saturating_sub(val_len);
        let tok = self.tok(token_type, cap1.map(Value::String));
        self.consume_u16(cap0_u16);
        self.increment_column(diff as isize);
        tok
    }

    fn scan_end_of_line(
        &mut self,
        cap0_bytes: usize,
        cap1: Option<String>,
        token_type: &str,
    ) -> Option<Token> {
        let (cap0_u16, whitespace_len, advance_bytes) = {
            let rem = &self.input_buf[self.pos..];
            let cap0 = &rem[..cap0_bytes];
            let cap0_u16 = utf16_len(cap0);
            let whitespace_len = if cap0.starts_with(' ') {
                cap0.bytes().take_while(|&b| b == b' ').count()
            } else {
                0
            };
            let new_input = &rem[cap0_bytes..];
            if new_input.starts_with(':') {
                (cap0_u16, whitespace_len, Some(cap0_bytes))
            } else {
                let trailing_ws_bytes = new_input
                    .bytes()
                    .take_while(|&b| b == b' ' || b == b'\t')
                    .count();
                let after_ws = &new_input[trailing_ws_bytes..];
                if after_ws.is_empty() || after_ws.starts_with('\n') {
                    (cap0_u16, whitespace_len, Some(cap0_bytes + trailing_ws_bytes))
                } else {
                    (cap0_u16, whitespace_len, None)
                }
            }
        };

        if let Some(advance) = advance_bytes {
            if whitespace_len > 0 {
                self.increment_column(whitespace_len as isize);
            }
            self.pos += advance;
            let tok = self.tok(token_type, cap1.map(Value::String));
            self.increment_column((cap0_u16 - whitespace_len) as isize);
            return Some(tok);
        }
        // Roll back column if whitespace was incremented?
        // Wait: in pug-lexer/index.js lines 215-218:
        // `if ((whitespace = /^([ ]+)([^ ]*)/.exec(captures[0]))) { whitespaceLength = whitespace[1].length; this.incrementColumn(whitespaceLength); }`
        // Note that in pug-lexer, none of the `scanEndOfLine` regexes start with spaces except `path` (`/^ ([^\n]+)/`),
        // and `path`'s regex `[^\n]+` matches to the end of the line so `newInput` is always `\n` or `$`!
        None
    }

    fn bracket_expression(&mut self, skip_u16: usize) -> Result<ParseUntilRange, PugError> {
        let start_u = utf16_at(self.rest(), skip_u16);
        let end_delim = match start_u {
            x if x == b'(' as u16 => ")",
            x if x == b'{' as u16 => "}",
            x if x == b'[' as u16 => "]",
            _ => {
                return Err(self.error(
                    "ASSERT_FAILED",
                    "The start character should be \"(\", \"{\" or \"[\"",
                ));
            }
        };
        let opts = NestingOptions {
            start: skip_u16 + 1,
            ..NestingOptions::default()
        };
        match parse_until(self.rest(), end_delim, opts) {
            Ok(range) => Ok(range),
            Err(ex) => {
                if let Some(mut idx) = ex.index {
                    let units: Vec<u16> = self.rest().encode_utf16().collect();
                    // Exact port of pug-lexer lines 258-271
                    let find_newline_u16 = |start_pos: usize| -> isize {
                        units[start_pos..]
                            .iter()
                            .position(|&u| u == b'\n' as u16)
                            .map(|p| p as isize)
                            .unwrap_or(-1)
                    };
                    let mut tmp = find_newline_u16(skip_u16);
                    let mut next_newline = tmp + (skip_u16 as isize);
                    let mut ptr = 0usize;
                    while (idx as isize) > next_newline && tmp != -1 {
                        self.increment_line(1);
                        idx = ((idx as isize) - (next_newline + 1)) as usize;
                        ptr += (next_newline + 1) as usize;
                        tmp = find_newline_u16(ptr);
                        next_newline = tmp;
                    }
                    self.increment_column(idx as isize);
                }
                match ex.code {
                    CharacterParserErrorCode::EndOfStringReached => Err(self.error(
                        "NO_END_BRACKET",
                        format!(
                            "The end of the string reached with no closing bracket {end_delim} found."
                        ),
                    )),
                    CharacterParserErrorCode::MismatchedBracket => {
                        Err(self.error("BRACKET_MISMATCH", ex.message))
                    }
                    _ => Err(self.error("SYNTAX_ERROR", ex.message)),
                }
            }
        }
    }

    /// Equivalent to `scanIndentation()`. Returns `Some((total_match_u16_len, indent_u16_len))` if `input` starts with `\n`.
    fn scan_indentation_on(
        indent_mode: &mut Option<IndentMode>,
        s: &str,
    ) -> Option<(usize, usize)> {
        let rest = s.strip_prefix('\n')?;
        match *indent_mode {
            Some(IndentMode::Tabs) => {
                let tabs = rest.bytes().take_while(|&b| b == b'\t').count();
                let spaces_after = rest[tabs..].bytes().take_while(|&b| b == b' ').count();
                Some((1 + tabs + spaces_after, tabs))
            }
            Some(IndentMode::Spaces) => {
                let spaces = rest.bytes().take_while(|&b| b == b' ').count();
                Some((1 + spaces, spaces))
            }
            None => {
                let tabs = rest.bytes().take_while(|&b| b == b'\t').count();
                if tabs > 0 {
                    let spaces_after = rest[tabs..].bytes().take_while(|&b| b == b' ').count();
                    *indent_mode = Some(IndentMode::Tabs);
                    Some((1 + tabs + spaces_after, tabs))
                } else {
                    let spaces = rest.bytes().take_while(|&b| b == b' ').count();
                    if spaces > 0 {
                        *indent_mode = Some(IndentMode::Spaces);
                    }
                    Some((1 + spaces, spaces))
                }
            }
        }
    }

    fn scan_indentation(&mut self) -> Option<(usize, usize)> {
        Self::scan_indentation_on(&mut self.indent_mode, &self.input_buf[self.pos..])
    }

    fn eos(&mut self) -> Result<bool, PugError> {
        if !self.rest().is_empty() {
            return Ok(false);
        }
        if self.interpolated {
            return Err(self.error(
                "NO_END_BRACKET",
                "End of line was reached with no closing bracket for interpolation.",
            ));
        }
        let mut i = 0;
        while i < self.indent_stack.len() && self.indent_stack[i] != 0 {
            let tok = self.tok_end(self.tok("outdent", None));
            self.tokens.push(tok);
            i += 1;
        }
        let eos_tok = self.tok_end(self.tok("eos", None));
        self.tokens.push(eos_tok);
        self.ended = true;
        Ok(true)
    }

    fn blank(&mut self) -> Result<bool, PugError> {
        if let Some(rest) = self.rest().strip_prefix('\n') {
            let ws_bytes = rest
                .bytes()
                .take_while(|&b| b == b' ' || b == b'\t')
                .count();
            if rest[ws_bytes..].starts_with('\n') {
                // `captures[0]` is `\n` + ws + `\n`; consume `captures[0].length - 1` (`1 + ws_bytes`)
                self.consume_u16(1 + ws_bytes);
                self.increment_line(1);
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn comment(&mut self) -> Result<bool, PugError> {
        if let Some(after_slashes) = self.rest().strip_prefix("//") {
            let line = first_line(self.rest());
            let cap0_u16 = utf16_len(line);
            let (is_unbuffered, comment_body) =
                if let Some(stripped) = after_slashes.strip_prefix('-') {
                    (true, first_line(stripped).to_string())
                } else {
                    (false, first_line(after_slashes).to_string())
                };
            self.consume_u16(cap0_u16);
            let mut tok = self.tok_str("comment", comment_body);
            let buffer = !is_unbuffered;
            tok.buffer = Some(buffer);
            self.interpolation_allowed = buffer;
            self.increment_column(cap0_u16 as isize);
            tok = self.tok_end(tok);
            self.tokens.push(tok);
            self.pipeless_text(None)?;
            return Ok(true);
        }
        Ok(false)
    }

    fn interpolation(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with("#{") {
            let match_range = self.bracket_expression(1)?;
            self.consume_u16(match_range.end + 1);
            let mut tok = self.tok_str("interpolation", match_range.src.clone());
            self.increment_column(2); // '#{'
            self.assert_expression(&match_range.src, false)?;

            let splitted: Vec<&str> = match_range.src.split('\n').collect();
            let lines = splitted.len() - 1;
            self.increment_line(lines);
            self.increment_column((utf16_len(splitted[lines]) + 1) as isize); // + 1 -> '}'
            tok = self.tok_end(tok);
            self.tokens.push(tok);
            return Ok(true);
        }
        Ok(false)
    }

    fn tag(&mut self) -> Result<bool, PugError> {
        let mut chars = self.rest().char_indices();
        let Some((_, first)) = chars.next() else {
            return Ok(false);
        };
        if !is_word_char(first) {
            return Ok(false);
        }
        let mut last_word_end = first.len_utf8();
        for (idx, ch) in chars {
            if is_word_char(ch) {
                last_word_end = idx + ch.len_utf8();
            } else if ch == '-' || ch == ':' {
                // continue scanning, only commit if followed by word char
            } else {
                break;
            }
        }
        let name = self.rest()[..last_word_end].to_string();
        let len_u16 = utf16_len(&name);
        self.consume_u16(len_u16);
        let mut tok = self.tok_str("tag", name);
        self.increment_column(len_u16 as isize);
        tok = self.tok_end(tok);
        self.tokens.push(tok);
        Ok(true)
    }

    fn filter(&mut self, in_include: bool) -> Result<bool, PugError> {
        if let Some(after_colon) = self.rest().strip_prefix(':') {
            let name_bytes: usize = after_colon
                .chars()
                .take_while(|&c| is_word_char(c) || c == '-')
                .map(char::len_utf8)
                .sum();
            if name_bytes > 0 {
                let name = after_colon[..name_bytes].to_string();
                let name_u16 = utf16_len(&name);
                let mut tok = self.scan_exact(1 + name_u16, Some(name), "filter");
                self.increment_column(name_u16 as isize);
                tok = self.tok_end(tok);
                self.tokens.push(tok);
                self.attrs()?;
                if !in_include {
                    self.interpolation_allowed = false;
                    self.pipeless_text(None)?;
                }
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn doctype(&mut self) -> Result<bool, PugError> {
        if let Some(after_kw) = self.rest().strip_prefix("doctype") {
            let line_rest = first_line(after_kw);
            // Wait: `^doctype *([^\n]*)` matches even `doctypefoo`!
            // Because `scanEndOfLine` checks if `newInput` (after the line) is `:` or `^[ \t]*(\n|$)`,
            // wait: since `([^\n]*)` consumes until `\n` or `$`, `newInput` is ALWAYS `\n...` or `""`!
            // Wait: does `doctypefoo` match `^doctype *([^\n]*)` in JS?
            // YES! In JS `/^doctype *([^\n]*)/` has ` *` (zero or more spaces)!
            // Wait: let's check if there is a test case for `doctype` vs tag `doctype...`!
            // In JS `advance()`, `doctype` is called BEFORE `tag`.
            let spaces = line_rest.bytes().take_while(|&b| b == b' ').count();
            let val = line_rest[spaces..].to_string();
            let cap0_bytes = "doctype".len() + line_rest.len();
            if let Some(node) = self.scan_end_of_line(cap0_bytes, Some(val), "doctype") {
                let ended = self.tok_end(node);
                self.tokens.push(ended);
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn id(&mut self) -> Result<bool, PugError> {
        if let Some(after_hash) = self.rest().strip_prefix('#') {
            let id_bytes: usize = after_hash
                .chars()
                .take_while(|&c| is_word_char(c) || c == '-')
                .map(char::len_utf8)
                .sum();
            if id_bytes > 0 {
                let val = after_hash[..id_bytes].to_string();
                let val_u16 = utf16_len(&val);
                let mut tok = self.scan_exact(1 + val_u16, Some(val), "id");
                self.increment_column(val_u16 as isize);
                tok = self.tok_end(tok);
                self.tokens.push(tok);
                return Ok(true);
            }
            // `/^#/.test(this.input)` -> invalid ID error
            // `/.[^ \t\(\#\.\:]*/.exec(this.input.substr(1))[0]`
            let invalid_str = Self::extract_invalid_selector_token(after_hash);
            return Err(self.error("INVALID_ID", format!("\"{invalid_str}\" is not a valid ID.")));
        }
        Ok(false)
    }

    fn extract_invalid_selector_token(after_sigil: &str) -> String {
        let mut chars = after_sigil.chars();
        let Some(first) = chars.next() else {
            return String::new();
        };
        if first == '\n' {
            return String::new();
        }
        let mut out = String::new();
        out.push(first);
        for c in chars {
            if matches!(c, ' ' | '\t' | '(' | '#' | '.' | ':' | '\n') {
                break;
            }
            out.push(c);
        }
        out
    }

    fn class_name(&mut self) -> Result<bool, PugError> {
        if let Some(after_dot) = self.rest().strip_prefix('.') {
            let cand_bytes: usize = after_dot
                .chars()
                .take_while(|&c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                .map(char::len_utf8)
                .sum();
            if cand_bytes > 0 {
                let cand = &after_dot[..cand_bytes];
                let has_alpha_or_underscore =
                    cand.chars().any(|c| c.is_ascii_alphabetic() || c == '_');
                if has_alpha_or_underscore {
                    let val = cand.to_string();
                    let val_u16 = utf16_len(&val);
                    let mut tok = self.scan_exact(1 + val_u16, Some(val), "class");
                    self.increment_column(val_u16 as isize);
                    tok = self.tok_end(tok);
                    self.tokens.push(tok);
                    return Ok(true);
                } else {
                    return Err(self.error(
                        "INVALID_CLASS_NAME",
                        "Class names must contain at least one letter or underscore.",
                    ));
                }
            }
            let invalid_str = Self::extract_invalid_selector_token(after_dot);
            return Err(self.error(
                "INVALID_CLASS_NAME",
                format!(
                    "\"{invalid_str}\" is not a valid class name.  Class names can only contain \"_\", \"-\", a-z and 0-9, and must contain at least one of \"_\", or a-z"
                ),
            ));
        }
        Ok(false)
    }

    fn end_interpolation(&mut self) -> Result<bool, PugError> {
        if self.interpolated && self.rest().starts_with(']') {
            self.consume_u16(1);
            self.ended = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn find_string_interp(value: &str) -> Option<(usize, bool, char, String)> {
        // Matches `/(\\)?([#!]){((?:.|\n)*)$/` in UTF-16 code units
        let units: Vec<u16> = value.encode_utf16().collect();
        for i in 0..units.len() {
            if i + 1 < units.len()
                && (units[i] == b'#' as u16 || units[i] == b'!' as u16)
                && units[i + 1] == b'{' as u16
            {
                let sigil = units[i] as u8 as char;
                if i > 0 && units[i - 1] == b'\\' as u16 {
                    let rest = String::from_utf16_lossy(&units[i + 2..]);
                    return Some((i - 1, true, sigil, rest));
                } else {
                    let rest = String::from_utf16_lossy(&units[i + 2..]);
                    return Some((i, false, sigil, rest));
                }
            }
        }
        None
    }

    fn find_substr_u16(haystack: &str, needle: &str) -> Option<usize> {
        let byte_pos = haystack.find(needle)?;
        Some(utf16_len(&haystack[..byte_pos]))
    }

    fn add_text(
        &mut self,
        token_type: &str,
        value: &str,
        prefix: Option<&str>,
        escaped: usize,
    ) -> Result<(), PugError> {
        if value.is_empty() && prefix.is_some_and(|p| p.is_empty()) {
            return Ok(());
        }
        let prefix = prefix.unwrap_or("");
        let index_of_end = if self.interpolated {
            Self::find_substr_u16(value, "]").unwrap_or(usize::MAX)
        } else {
            usize::MAX
        };
        let index_of_start = if self.interpolation_allowed {
            Self::find_substr_u16(value, "#[").unwrap_or(usize::MAX)
        } else {
            usize::MAX
        };
        let index_of_escaped = if self.interpolation_allowed {
            Self::find_substr_u16(value, "\\#[").unwrap_or(usize::MAX)
        } else {
            usize::MAX
        };
        let match_string_interp = if self.interpolation_allowed {
            Self::find_string_interp(value)
        } else {
            None
        };
        let index_of_string_interp = match_string_interp
            .as_ref()
            .map(|m| m.0)
            .unwrap_or(usize::MAX);

        if index_of_escaped != usize::MAX
            && index_of_escaped < index_of_end
            && index_of_escaped < index_of_start
            && index_of_escaped < index_of_string_interp
        {
            let new_prefix = format!(
                "{}{}#[",
                prefix,
                substr_u16_len(value, 0, index_of_escaped)
            );
            let rest = substr_u16(value, index_of_escaped + 3);
            return self.add_text(token_type, rest, Some(&new_prefix), escaped + 1);
        }

        if index_of_start != usize::MAX
            && index_of_start < index_of_end
            && index_of_start < index_of_escaped
            && index_of_start < index_of_string_interp
        {
            let before_val = format!("{}{}", prefix, substr_u16_len(value, 0, index_of_start));
            let tok = self.tok_str(token_type, before_val);
            self.increment_column((utf16_len(prefix) + index_of_start + escaped) as isize);
            let ended_tok = self.tok_end(tok);
            self.tokens.push(ended_tok);

            let start_interp_tok = self.tok("start-pug-interpolation", None);
            self.increment_column(2);
            let ended_start = self.tok_end(start_interp_tok);
            self.tokens.push(ended_start);

            let child_input = substr_u16(value, index_of_start + 2);
            let child_opts = LexerOptions {
                filename: self.filename.clone(),
                interpolated: true,
                starting_line: Some(self.lineno),
                starting_column: Some(self.colno),
                plugin_methods: self.plugin_methods.clone(),
            };
            let (interpolated_res, remaining_child_input, child_colno) =
                if let Some(hook) = self.hook.take() {
                    let mut child = Lexer::with_hook(child_input, &child_opts, hook);
                    let res = child.get_tokens();
                    let rem = child.rest().to_string();
                    let col = child.colno;
                    self.hook = child.hook.take();
                    (res, rem, col)
                } else {
                    let mut child = Lexer::new(child_input, &child_opts);
                    let res = child.get_tokens();
                    let rem = child.rest().to_string();
                    (res, rem, child.colno)
                };
            let interpolated_tokens = match interpolated_res {
                Ok(toks) => toks,
                Err(ex) => {
                    if let Some(col) = ex.column {
                        self.colno = col as usize;
                    }
                    let short_code = ex.code.strip_prefix("PUG:").unwrap_or(&ex.code);
                    return Err(self.error(short_code, ex.msg));
                }
            };
            self.colno = child_colno;
            self.tokens.extend(interpolated_tokens);

            let end_interp_tok = self.tok("end-pug-interpolation", None);
            self.increment_column(1);
            let ended_end = self.tok_end(end_interp_tok);
            self.tokens.push(ended_end);

            return self.add_text(token_type, &remaining_child_input, None, 0);
        }

        if index_of_end != usize::MAX
            && index_of_end < index_of_start
            && index_of_end < index_of_escaped
            && index_of_end < index_of_string_interp
        {
            let before = substr_u16_len(value, 0, index_of_end);
            if !(prefix.is_empty() && before.is_empty()) {
                self.add_text(token_type, before, Some(prefix), 0)?;
            }
            self.ended = true;
            let after_bracket = substr_u16(value, index_of_end + 1);
            let mut next = String::with_capacity(after_bracket.len() + self.rest().len());
            next.push_str(after_bracket);
            next.push_str(self.rest());
            self.input_buf = next;
            self.pos = 0;
            return Ok(());
        }

        if let Some((interp_idx, is_escaped_interp, sigil, rest)) = match_string_interp {
            if is_escaped_interp {
                let new_prefix = format!(
                    "{}{}{}{{",
                    prefix,
                    substr_u16_len(value, 0, interp_idx),
                    sigil
                );
                let after = substr_u16(value, interp_idx + 3);
                return self.add_text(token_type, after, Some(&new_prefix), escaped + 1);
            }
            let before = substr_u16_len(value, 0, interp_idx);
            if !prefix.is_empty() || !before.is_empty() {
                let combined = format!("{prefix}{before}");
                let combined_u16 = utf16_len(&combined);
                let tok = self.tok_str(token_type, combined);
                self.increment_column((combined_u16 + escaped) as isize);
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
            }

            let mut tok = self.tok("interpolated-code", None);
            self.increment_column(2);
            let range = match parse_until(&rest, "}", NestingOptions::default()) {
                Ok(r) => r,
                Err(ex) => {
                    if let Some(idx) = ex.index {
                        self.increment_column(idx as isize);
                    }
                    return match ex.code {
                        CharacterParserErrorCode::EndOfStringReached => Err(self.error(
                            "NO_END_BRACKET",
                            "End of line was reached with no closing bracket for interpolation.",
                        )),
                        CharacterParserErrorCode::MismatchedBracket => {
                            Err(self.error("BRACKET_MISMATCH", ex.message))
                        }
                        _ => Err(self.error("SYNTAX_ERROR", ex.message)),
                    };
                }
            };
            tok.must_escape = Some(sigil == '#');
            tok.buffer = Some(true);
            tok.val = Some(Value::String(range.src.clone()));
            self.assert_expression(&range.src, false)?;

            let rest_u16 = utf16_len(&rest);
            if range.end + 1 < rest_u16 {
                let remaining_rest = substr_u16(&rest, range.end + 1).to_string();
                self.increment_column((range.end + 1) as isize);
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                return self.add_text(token_type, &remaining_rest, None, 0);
            } else {
                self.increment_column(rest_u16 as isize);
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
            }
            return Ok(());
        }

        let full_val = format!("{prefix}{value}");
        let full_u16 = utf16_len(&full_val);
        let tok = self.tok_str(token_type, full_val);
        self.increment_column((full_u16 + escaped) as isize);
        let ended = self.tok_end(tok);
        self.tokens.push(ended);
        Ok(())
    }

    fn text(&mut self) -> Result<bool, PugError> {
        let line = first_line(self.rest());
        // 1. `/^(?:\| ?| )([^\n]+)/`
        if let Some(prefix_len) = if line.starts_with("| ") {
            Some(2)
        } else if line.starts_with('|') || line.starts_with(' ') {
            Some(1)
        } else {
            None
        } {
            let val = &line[prefix_len..];
            if !val.is_empty() {
                let val_str = val.to_string();
                let line_u16 = utf16_len(line);
                let tok = self.scan_exact(line_u16, Some(val_str), "text");
                let text_val = tok
                    .val
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_default();
                self.add_text("text", &text_val, None, 0)?;
                return Ok(true);
            }
        }
        // 2. `/^( )/`
        if self.rest().starts_with(' ') {
            let tok = self.scan_exact(1, Some(String::from(" ")), "text");
            let text_val = tok
                .val
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            self.add_text("text", &text_val, None, 0)?;
            return Ok(true);
        }
        // 3. `/^\|( ?)/`
        if let Some(after_pipe) = self.rest().strip_prefix('|') {
            let (cap0_u16, cap1) = if after_pipe.starts_with(' ') {
                (2, String::from(" "))
            } else {
                (1, String::new())
            };
            let tok = self.scan_exact(cap0_u16, Some(cap1), "text");
            let text_val = tok
                .val
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            self.add_text("text", &text_val, None, 0)?;
            return Ok(true);
        }
        Ok(false)
    }

    fn text_html(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with('<') {
            let line = first_line(self.rest()).to_string();
            let line_u16 = utf16_len(&line);
            let tok = self.scan_exact(line_u16, Some(line), "text-html");
            let text_val = tok
                .val
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            self.add_text("text-html", &text_val, None, 0)?;
            return Ok(true);
        }
        Ok(false)
    }

    fn dot(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with('.') {
            if let Some(tok) = self.scan_end_of_line(1, None, "dot") {
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                self.pipeless_text(None)?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn extends_tok(&mut self) -> Result<bool, PugError> {
        // `/^extends?(?= |$|\n)/`
        let kw_len = if self.rest().starts_with("extends") {
            Some(7)
        } else if self.rest().starts_with("extend") {
            Some(6)
        } else {
            None
        };
        if let Some(len) = kw_len {
            let rest = &self.rest()[len..];
            if rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\n') {
                let tok = self.scan_exact(len, None, "extends");
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                if !self.path()? {
                    return Err(self.error("NO_EXTENDS_PATH", "missing path for extends"));
                }
                return Ok(true);
            }
            if !rest.chars().next().is_some_and(is_word_char) {
                let _ = self.scan_exact(len, None, "");
                return Err(self.error("MALFORMED_EXTENDS", "malformed extends"));
            }
        }
        Ok(false)
    }

    fn block_like(&mut self, mode: &str) -> Result<bool, PugError> {
        let line = first_line(self.rest());
        let rest_after_kw = match mode {
            "prepend" => {
                if let Some(after_block) = line.strip_prefix("block ") {
                    let trimmed_block = after_block.trim_start_matches(' ');
                    trimmed_block
                        .strip_prefix("prepend ")
                        .map(|r| r.trim_start_matches(' '))
                } else {
                    line.strip_prefix("prepend ")
                        .map(|r| r.trim_start_matches(' '))
                }
            }
            "append" => {
                if let Some(after_block) = line.strip_prefix("block ") {
                    let trimmed_block = after_block.trim_start_matches(' ');
                    trimmed_block
                        .strip_prefix("append ")
                        .map(|r| r.trim_start_matches(' '))
                } else {
                    line.strip_prefix("append ")
                        .map(|r| r.trim_start_matches(' '))
                }
            }
            "replace" => line
                .strip_prefix("block ")
                .map(|r| r.trim_start_matches(' ')),
            _ => None,
        };
        let Some(raw_capture) = rest_after_kw else {
            return Ok(false);
        };
        if raw_capture.is_empty() {
            return Ok(false);
        }
        let mut name = raw_capture.trim().to_string();
        let mut comment = String::new();
        if let Some(idx) = name.find("//") {
            comment = name[idx..].to_string();
            name = name[..idx].trim().to_string();
        }
        if name.is_empty() {
            return Ok(false);
        }
        let cap0_u16 = utf16_len(line);
        let comment_u16 = utf16_len(&comment);
        let total_without_comment_u16 = cap0_u16 - comment_u16;
        let line_without_comment = &line[..utf16_to_byte_idx(line, total_without_comment_u16)];
        let trimmed_line = line_without_comment.trim_end_matches([' ', '\t', '\n']);
        let len_u16 = utf16_len(trimmed_line);
        let mut tok = self.tok_str("block", name);
        self.increment_column(len_u16 as isize);
        tok.mode = Some(mode.to_string());
        let ended = self.tok_end(tok);
        self.tokens.push(ended);
        self.consume_u16(total_without_comment_u16);
        self.increment_column((total_without_comment_u16 - len_u16) as isize);
        Ok(true)
    }

    fn prepend(&mut self) -> Result<bool, PugError> {
        self.block_like("prepend")
    }

    fn append(&mut self) -> Result<bool, PugError> {
        self.block_like("append")
    }

    fn block(&mut self) -> Result<bool, PugError> {
        self.block_like("replace")
    }

    fn mixin_block(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with("block") {
            if let Some(tok) = self.scan_end_of_line(5, None, "mixin-block") {
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn yield_tok(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with("yield") {
            if let Some(tok) = self.scan_end_of_line(5, None, "yield") {
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn include(&mut self) -> Result<bool, PugError> {
        if let Some(rest) = self.rest().strip_prefix("include") {
            if rest.is_empty()
                || rest.starts_with(':')
                || rest.starts_with(' ')
                || rest.starts_with('\n')
            {
                let tok = self.scan_exact(7, None, "include");
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                while self.filter(true)? {}
                if !self.path()? {
                    if self
                        .rest()
                        .chars()
                        .next()
                        .is_some_and(|c| c != ' ' && c != '\n')
                    {
                        return self.fail();
                    } else {
                        return Err(self.error("NO_INCLUDE_PATH", "missing path for include"));
                    }
                }
                return Ok(true);
            }
            if !rest.chars().next().is_some_and(is_word_char) {
                let _ = self.scan_exact(7, None, "");
                return Err(self.error("MALFORMED_INCLUDE", "malformed include"));
            }
        }
        Ok(false)
    }

    fn path(&mut self) -> Result<bool, PugError> {
        if let Some(after_space) = self.rest().strip_prefix(' ') {
            let line_rest = first_line(after_space);
            if !line_rest.is_empty() {
                let cap0_bytes = 1 + line_rest.len();
                let val_str = line_rest.to_string();
                if let Some(mut tok) = self.scan_end_of_line(cap0_bytes, Some(val_str), "path") {
                    let trimmed = tok
                        .val
                        .as_ref()
                        .and_then(Value::as_str)
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    tok.val = Some(Value::String(trimmed.clone()));
                    if !trimmed.is_empty() {
                        let ended = self.tok_end(tok);
                        self.tokens.push(ended);
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }

    fn case_tok(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with("case") {
            let is_word_boundary = !self.rest()[4..].chars().next().is_some_and(is_word_char);
            if self.rest()[4..].starts_with(' ') {
                let line = first_line(self.rest());
                let spaces = line[4..].bytes().take_while(|&b| b == b' ').count();
                let expr = &line[4 + spaces..];
                if !expr.is_empty() {
                    let cap0_bytes = line.len();
                    let expr_str = expr.to_string();
                    if let Some(tok) = self.scan_end_of_line(cap0_bytes, Some(expr_str.clone()), "case")
                    {
                        let expr_u16 = utf16_len(&expr_str) as isize;
                        self.increment_column(-expr_u16);
                        self.assert_expression(&expr_str, false)?;
                        self.increment_column(expr_u16);
                        let ended = self.tok_end(tok);
                        self.tokens.push(ended);
                        return Ok(true);
                    }
                }
            }
            if is_word_boundary {
                let _ = self.scan_exact(4, None, "");
                return Err(self.error("NO_CASE_EXPRESSION", "missing expression for case"));
            }
        }
        Ok(false)
    }

    fn when(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with("when") {
            let is_word_boundary = !self.rest()[4..].chars().next().is_some_and(is_word_char);
            if self.rest()[4..].starts_with(' ') {
                let line = first_line(self.rest());
                let spaces = line[4..].bytes().take_while(|&b| b == b' ').count();
                let after_spaces = &line[4 + spaces..];
                let non_colon_bytes: usize = after_spaces
                    .chars()
                    .take_while(|&c| c != ':' && c != '\n')
                    .map(char::len_utf8)
                    .sum();
                if non_colon_bytes > 0 {
                    let cap0_bytes = 4 + spaces + non_colon_bytes;
                    let init_val = after_spaces[..non_colon_bytes].to_string();
                    if let Some(mut tok) =
                        self.scan_end_of_line(cap0_bytes, Some(init_val.clone()), "when")
                    {
                        let mut val_str = init_val;
                        let mut parser = char_parse(&val_str, NestingOptions::default());
                        while parser.as_ref().map_or(true, |s| {
                            s.is_nesting(NestingOptions::default()) || s.is_string()
                        }) {
                            let Some(after_colon) = self.rest().strip_prefix(':') else {
                                break;
                            };
                            let seg_bytes: usize = after_colon
                                .chars()
                                .take_while(|&c| c != ':' && c != '\n')
                                .map(char::len_utf8)
                                .sum();
                            if seg_bytes == 0 {
                                break;
                            }
                            let seg = &self.rest()[..1 + seg_bytes];
                            let seg_u16 = utf16_len(seg);
                            val_str.push_str(seg);
                            self.consume_u16(seg_u16);
                            self.increment_column(seg_u16 as isize);
                            parser = char_parse(&val_str, NestingOptions::default());
                        }
                        let val_u16 = utf16_len(&val_str) as isize;
                        tok.val = Some(Value::String(val_str.clone()));
                        self.increment_column(-val_u16);
                        self.assert_expression(&val_str, false)?;
                        self.increment_column(val_u16);
                        let ended = self.tok_end(tok);
                        self.tokens.push(ended);
                        return Ok(true);
                    }
                }
            }
            if is_word_boundary {
                let _ = self.scan_exact(4, None, "");
                return Err(self.error("NO_WHEN_EXPRESSION", "missing expression for when"));
            }
        }
        Ok(false)
    }

    fn default_tok(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with("default") {
            let is_word_boundary = !self.rest()[7..].chars().next().is_some_and(is_word_char);
            if let Some(tok) = self.scan_end_of_line(7, None, "default") {
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                return Ok(true);
            }
            if is_word_boundary {
                let _ = self.scan_exact(7, None, "");
                return Err(self.error(
                    "DEFAULT_WITH_EXPRESSION",
                    "default should not have an expression",
                ));
            }
        }
        Ok(false)
    }

    fn call(&mut self) -> Result<bool, PugError> {
        // `/^\+(\s*)(([-\w]+)|(#\{))/`
        if let Some(after_plus) = self.rest().strip_prefix('+') {
            let ws_bytes: usize = after_plus
                .chars()
                .take_while(|&c| is_js_space(c))
                .map(char::len_utf8)
                .sum();
            let ws_u16 = utf16_len(&after_plus[..ws_bytes]);
            let after_ws = &after_plus[ws_bytes..];
            let name_bytes: usize = after_ws
                .chars()
                .take_while(|&c| is_word_char(c) || c == '-')
                .map(char::len_utf8)
                .sum();

            let (mut tok, increment_u16) = if name_bytes > 0 {
                let name = after_ws[..name_bytes].to_string();
                let inc = 1 + ws_u16 + utf16_len(&name);
                self.consume_u16(inc);
                (self.tok_str("call", name), inc)
            } else if after_ws.starts_with("#{") {
                let match_range = self.bracket_expression(2 + ws_u16)?;
                let inc = match_range.end + 1;
                self.consume_u16(inc);
                self.assert_expression(&match_range.src, false)?;
                (
                    self.tok_str("call", format!("#{{{}}}", match_range.src)),
                    inc,
                )
            } else {
                return Ok(false);
            };

            self.increment_column(increment_u16 as isize);
            tok.args = Some(Value::Null);

            // Check for `^ *\(`
            let leading_spaces = self.rest().bytes().take_while(|&b| b == b' ').count();
            if self.rest()[leading_spaces..].starts_with('(') {
                let range = self.bracket_expression(leading_spaces)?;
                // `!/^\s*[-\w]+ *=/.test(range.src)`
                if !Self::looks_like_attr_assignment(&range.src) {
                    self.increment_column(1);
                    self.consume_u16(range.end + 1);
                    let args_str = range.src;
                    tok.args = Some(Value::String(args_str.clone()));
                    self.assert_expression(&format!("[{args_str}]"), false)?;
                    let args_units: Vec<u16> = args_str.encode_utf16().collect();
                    for i in 0..=args_units.len() {
                        if args_units.get(i) == Some(&(b'\n' as u16)) {
                            self.increment_line(1);
                        } else {
                            self.increment_column(1);
                        }
                    }
                }
            }
            let ended = self.tok_end(tok);
            self.tokens.push(ended);
            return Ok(true);
        }
        Ok(false)
    }

    fn looks_like_attr_assignment(s: &str) -> bool {
        let trimmed = s.trim_start_matches(is_js_space);
        let name_bytes: usize = trimmed
            .chars()
            .take_while(|&c| is_word_char(c) || c == '-')
            .map(char::len_utf8)
            .sum();
        if name_bytes == 0 {
            return false;
        }
        let after_name = trimmed[name_bytes..].trim_start_matches(' ');
        after_name.starts_with('=')
    }

    fn mixin(&mut self) -> Result<bool, PugError> {
        // `/^mixin +([-\w]+)(?: *\((.*)\))? */`
        let line = first_line(self.rest());
        if let Some(after_kw) = line.strip_prefix("mixin ") {
            let spaces1 = after_kw.bytes().take_while(|&b| b == b' ').count();
            let after_s1 = &after_kw[spaces1..];
            let name_bytes: usize = after_s1
                .chars()
                .take_while(|&c| is_word_char(c) || c == '-')
                .map(char::len_utf8)
                .sum();
            if name_bytes > 0 {
                let name = after_s1[..name_bytes].to_string();
                let after_name = &after_s1[name_bytes..];
                let spaces2 = after_name.bytes().take_while(|&b| b == b' ').count();
                let after_s2 = &after_name[spaces2..];

                let (cap0_bytes, args_opt) = if let Some(after_open) = after_s2.strip_prefix('(') {
                    if let Some(last_close) = after_open.rfind(')') {
                        let inside = after_open[..last_close].to_string();
                        let after_close = &after_open[last_close + 1..];
                        let trailing_spaces =
                            after_close.bytes().take_while(|&b| b == b' ').count();
                        let total = 6
                            + spaces1
                            + name_bytes
                            + spaces2
                            + 1
                            + last_close
                            + 1
                            + trailing_spaces;
                        let args_val = if inside.is_empty() {
                            Value::Null
                        } else {
                            Value::String(inside)
                        };
                        (total, args_val)
                    } else {
                        let total = 6 + spaces1 + name_bytes + spaces2;
                        (total, Value::Null)
                    }
                } else {
                    let total = 6 + spaces1 + name_bytes + spaces2;
                    (total, Value::Null)
                };

                let cap0_u16 = utf16_len(&line[..cap0_bytes]);
                self.consume_u16(cap0_u16);
                let mut tok = self.tok_str("mixin", name);
                tok.args = Some(args_opt);
                self.increment_column(cap0_u16 as isize);
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn conditional(&mut self) -> Result<bool, PugError> {
        let line = first_line(self.rest());
        let kw = if line.starts_with("else if")
            && !line[7..].chars().next().is_some_and(is_word_char)
        {
            Some("else if")
        } else if line.starts_with("if") && !line[2..].chars().next().is_some_and(is_word_char) {
            Some("if")
        } else if line.starts_with("unless") && !line[6..].chars().next().is_some_and(is_word_char)
        {
            Some("unless")
        } else if line.starts_with("else") && !line[4..].chars().next().is_some_and(is_word_char) {
            Some("else")
        } else {
            None
        };

        if let Some(kw_str) = kw {
            let cap0_u16 = utf16_len(line);
            let cap2 = line[kw_str.len()..].to_string();
            self.consume_u16(cap0_u16);
            let tok_type = kw_str.replace(' ', "-");
            let js = cap2.trim().to_string();
            let js_u16 = utf16_len(&js);
            let mut tok = self.tok_str(&tok_type, js.clone());
            self.increment_column((cap0_u16 - js_u16) as isize);

            match tok_type.as_str() {
                "if" | "else-if" => {
                    self.assert_expression(&js, false)?;
                }
                "unless" => {
                    self.assert_expression(&js, false)?;
                    tok.val = Some(Value::String(format!("!({js})")));
                    tok.token_type = String::from("if");
                }
                "else" => {
                    if !js.is_empty() {
                        return Err(self.error(
                            "ELSE_CONDITION",
                            "`else` cannot have a condition, perhaps you meant `else if`",
                        ));
                    }
                }
                _ => {}
            }
            self.increment_column(js_u16 as isize);
            let ended = self.tok_end(tok);
            self.tokens.push(ended);
            return Ok(true);
        }
        Ok(false)
    }

    fn while_tok(&mut self) -> Result<bool, PugError> {
        let line = first_line(self.rest());
        if let Some(after_kw) = line.strip_prefix("while") {
            if after_kw.starts_with(' ') {
                let spaces = after_kw.bytes().take_while(|&b| b == b' ').count();
                let expr = after_kw[spaces..].to_string();
                if !expr.is_empty() {
                    let cap0_u16 = utf16_len(line);
                    self.consume_u16(cap0_u16);
                    self.assert_expression(&expr, false)?;
                    let mut tok = self.tok_str("while", expr);
                    self.increment_column(cap0_u16 as isize);
                    tok = self.tok_end(tok);
                    self.tokens.push(tok);
                    return Ok(true);
                }
            }
            if !after_kw.chars().next().is_some_and(is_word_char) {
                let _ = self.scan_exact(5, None, "");
                return Err(self.error("NO_WHILE_EXPRESSION", "missing expression for while"));
            }
        }
        Ok(false)
    }

    fn parse_each_in_line(line: &str) -> Option<(String, Option<String>, String)> {
        // `/^(?:each|for) +([a-zA-Z_$][\w$]*)(?: *, *([a-zA-Z_$][\w$]*))? * in *([^\n]+)/`
        let after_kw = line
            .strip_prefix("each ")
            .or_else(|| line.strip_prefix("for "))?;
        let s1 = after_kw.bytes().take_while(|&b| b == b' ').count();
        let rest1 = &after_kw[s1..];
        let id1_bytes: usize = rest1
            .chars()
            .take_while(|&c| is_ident_cont(c))
            .map(char::len_utf8)
            .sum();
        if id1_bytes == 0 || !is_valid_ident(&rest1[..id1_bytes]) {
            return None;
        }
        let val_ident = rest1[..id1_bytes].to_string();
        let mut after_id = &rest1[id1_bytes..];

        let mut key_ident = None;
        let s_before_comma = after_id.bytes().take_while(|&b| b == b' ').count();
        if let Some(after_comma) = after_id[s_before_comma..].strip_prefix(',') {
            let s_after_comma = after_comma.bytes().take_while(|&b| b == b' ').count();
            let rest2 = &after_comma[s_after_comma..];
            let id2_bytes: usize = rest2
                .chars()
                .take_while(|&c| is_ident_cont(c))
                .map(char::len_utf8)
                .sum();
            if id2_bytes == 0 || !is_valid_ident(&rest2[..id2_bytes]) {
                return None;
            }
            key_ident = Some(rest2[..id2_bytes].to_string());
            after_id = &rest2[id2_bytes..];
        }

        // Now match ` * in *([^\n]+)` (greedy ` *`, then ` in`, then ` *`, then non-empty `[^\n]+`)
        // Wait: in JS `/ * in *([^\n]+)/` requires at least one space before `in`!
        let spaces_before_in = after_id.bytes().take_while(|&b| b == b' ').count();
        if spaces_before_in == 0 {
            return None;
        }
        let after_spaces = &after_id[spaces_before_in..];
        let after_in = after_spaces.strip_prefix("in")?;
        let spaces_after_in = after_in.bytes().take_while(|&b| b == b' ').count();
        let code = &after_in[spaces_after_in..];
        if code.is_empty() {
            return None;
        }
        Some((val_ident, key_ident, code.to_string()))
    }

    fn each(&mut self) -> Result<bool, PugError> {
        let line = first_line(self.rest()).to_string();
        if let Some((val_id, key_id, code_str)) = Self::parse_each_in_line(&line) {
            let cap0_u16 = utf16_len(&line);
            let code_u16 = utf16_len(&code_str);
            self.consume_u16(cap0_u16);
            let mut tok = self.tok_str("each", val_id);
            tok.key = Some(key_id.map_or(Value::Null, Value::String));
            self.increment_column((cap0_u16 - code_u16) as isize);
            self.assert_expression(&code_str, false)?;
            tok.code = Some(code_str);
            self.increment_column(code_u16 as isize);
            let ended = self.tok_end(tok);
            self.tokens.push(ended);
            return Ok(true);
        }

        let kw = if self.rest().starts_with("each")
            && !self.rest()[4..].chars().next().is_some_and(is_word_char)
        {
            Some(("each", 4))
        } else if self.rest().starts_with("for")
            && !self.rest()[3..].chars().next().is_some_and(is_word_char)
        {
            Some(("for", 3))
        } else {
            None
        };
        if let Some((name, len)) = kw {
            let _ = self.scan_exact(len, None, "");
            return Err(self.error(
                "MALFORMED_EACH",
                format!(
                    "This `{name}` has a syntax error. `{name}` statements should be of the form: `{name} VARIABLE_NAME of JS_EXPRESSION`"
                ),
            ));
        }

        // Check `/^- *(?:each|for) +([a-zA-Z_$][\w$]*)(?: *, *([a-zA-Z_$][\w$]*))? +in +([^\n]+)/`
        if let Some(after_dash) = line.strip_prefix('-') {
            let trimmed_dash = after_dash.trim_start_matches(' ');
            if Self::parse_each_in_line(trimmed_dash).is_some() {
                return Err(self.error(
                    "MALFORMED_EACH",
                    "Pug each and for should no longer be prefixed with a dash (\"-\"). They are pug keywords and not part of JavaScript.",
                ));
            }
        }
        Ok(false)
    }

    fn each_of(&mut self) -> Result<bool, PugError> {
        // `/^(?:each|for) (.*?) of *([^\n]+)/`
        let line = first_line(self.rest()).to_string();
        if let Some(after_kw) = line
            .strip_prefix("each ")
            .or_else(|| line.strip_prefix("for "))
        {
            // Non-greedy `(.*?) of *([^\n]+)`: find the first `" of"` followed by spaces and non-empty code
            if let Some(of_pos) = after_kw.find(" of") {
                let after_of = &after_kw[of_pos + 3..];
                let spaces_after_of = after_of.bytes().take_while(|&b| b == b' ').count();
                let code_str = after_of[spaces_after_of..].to_string();
                if !code_str.is_empty() {
                    let val_raw = after_kw[..of_pos].to_string();
                    let cap0_u16 = utf16_len(&line);
                    let code_u16 = utf16_len(&code_str);
                    self.consume_u16(cap0_u16);
                    let mut tok = self.tok_str("eachOf", val_raw.clone());
                    tok.value = Some(val_raw.clone());
                    self.increment_column((cap0_u16 - code_u16) as isize);
                    self.assert_expression(&code_str, false)?;
                    tok.code = Some(code_str);
                    self.increment_column(code_u16 as isize);
                    let ended = self.tok_end(tok);
                    self.tokens.push(ended);

                    let trimmed_val = val_raw.trim();
                    if !(is_valid_ident(trimmed_val) || Self::is_valid_each_of_pair(trimmed_val)) {
                        return Err(self.error(
                            "MALFORMED_EACH_OF_LVAL",
                            "The value variable for each must either be a valid identifier (e.g. `item`) or a pair of identifiers in square brackets (e.g. `[key, value]`).",
                        ));
                    }
                    return Ok(true);
                }
            }
        }

        if let Some(after_dash) = line.strip_prefix('-') {
            let trimmed_dash = after_dash.trim_start_matches(' ');
            if let Some(after_kw) = trimmed_dash
                .strip_prefix("each ")
                .or_else(|| trimmed_dash.strip_prefix("for "))
            {
                if after_kw.contains(" of ") {
                    return Err(self.error(
                        "MALFORMED_EACH",
                        "Pug each and for should not be prefixed with a dash (\"-\"). They are pug keywords and not part of JavaScript.",
                    ));
                }
            }
        }
        Ok(false)
    }

    fn is_valid_each_of_pair(s: &str) -> bool {
        let Some(inner) = s.strip_prefix('[').and_then(|r| r.strip_suffix(']')) else {
            return false;
        };
        let parts: Vec<&str> = inner.split(',').collect();
        if parts.len() != 2 {
            return false;
        }
        let p0 = parts[0].trim_matches(' ');
        let p1 = parts[1].trim_matches(' ');
        is_valid_ident(p0) && is_valid_ident(p1)
    }

    fn block_code(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with('-') {
            if let Some(tok) = self.scan_end_of_line(1, None, "blockcode") {
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                self.interpolation_allowed = false;
                self.pipeless_text(None)?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn code(&mut self) -> Result<bool, PugError> {
        // `/^(!?=|-)[ \t]*([^\n]+)/`
        let line = first_line(self.rest());
        let flags_len = if line.starts_with("!=") {
            Some(2)
        } else if line.starts_with('=') || line.starts_with('-') {
            Some(1)
        } else {
            None
        };
        if let Some(flen) = flags_len {
            let flags = line[..flen].to_string();
            let after_flags = &line[flen..];
            let ws_bytes = after_flags
                .bytes()
                .take_while(|&b| b == b' ' || b == b'\t')
                .count();
            let raw_code = &after_flags[ws_bytes..];
            if !raw_code.is_empty() {
                let cap0_u16 = utf16_len(line);
                let raw_code_u16 = utf16_len(raw_code);
                let mut code_str = raw_code.to_string();
                let mut shortened_u16 = 0usize;

                if self.interpolated {
                    let parsed = match parse_until(&code_str, "]", NestingOptions::default()) {
                        Ok(p) => p,
                        Err(err) => {
                            if let Some(idx) = err.index {
                                self.increment_column((cap0_u16 - raw_code_u16 + idx) as isize);
                            }
                            return match err.code {
                                CharacterParserErrorCode::EndOfStringReached => Err(self.error(
                                    "NO_END_BRACKET",
                                    "End of line was reached with no closing bracket for interpolation.",
                                )),
                                CharacterParserErrorCode::MismatchedBracket => {
                                    Err(self.error("BRACKET_MISMATCH", err.message))
                                }
                                _ => Err(self.error("SYNTAX_ERROR", err.message)),
                            };
                        }
                    };
                    shortened_u16 = raw_code_u16 - parsed.end;
                    code_str = parsed.src;
                }

                let consumed_u16 = cap0_u16 - shortened_u16;
                self.consume_u16(consumed_u16);
                let mut tok = self.tok_str("code", code_str.clone());
                let must_escape = flags.starts_with('=');
                let buffer = flags == "=" || flags == "!=";
                tok.must_escape = Some(must_escape);
                tok.buffer = Some(buffer);

                self.increment_column((cap0_u16 - raw_code_u16) as isize);
                if buffer {
                    self.assert_expression(&code_str, false)?;
                }
                let code_u16 = utf16_len(&code_str);
                self.increment_column(code_u16 as isize);
                tok = self.tok_end(tok);
                self.tokens.push(tok);
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn attribute<'s>(&mut self, str_in: &'s str) -> Result<&'s str, PugError> {
        let mut char_iter = str_in.char_indices();
        let mut after_ws_byte = str_in.len();
        let mut first_non_ws: Option<(usize, char)> = None;
        for (b_idx, ch) in &mut char_iter {
            if !is_whitespace_char(ch) {
                after_ws_byte = b_idx;
                first_non_ws = Some((b_idx, ch));
                break;
            }
            if ch == '\n' {
                self.increment_line(1);
            } else {
                self.increment_column(1);
            }
        }

        let Some((start_b, first_ch)) = first_non_ws else {
            return Ok("");
        };

        let mut tok = self.tok("attribute", None);
        let mut quote: Option<char> = None;
        let mut key_start_byte = start_b;
        if matches!(first_ch, '\'' | '"') {
            quote = Some(first_ch);
            self.increment_column(1);
            key_start_byte = start_b + first_ch.len_utf8();
        }

        let mut after_key_byte = str_in.len();
        let mut key_end_byte = str_in.len();
        for (b_idx, ch) in str_in[key_start_byte..].char_indices() {
            let abs_b = key_start_byte + b_idx;
            if let Some(q) = quote {
                if ch == q {
                    self.increment_column(1);
                    key_end_byte = abs_b;
                    after_key_byte = abs_b + ch.len_utf8();
                    break;
                }
            } else if is_whitespace_char(ch) || matches!(ch, '!' | '=' | ',') {
                key_end_byte = abs_b;
                after_key_byte = abs_b;
                break;
            }
            if ch == '\n' {
                self.increment_line(1);
            } else {
                self.increment_column(ch.len_utf16() as isize);
            }
        }

        tok.name = Some(str_in[key_start_byte..key_end_byte].to_string());

        let value_response = self.attribute_value(&str_in[after_key_byte..])?;

        if let Some(val_str) = value_response.val {
            tok.val = Some(Value::String(val_str));
            tok.must_escape = Some(value_response.must_escape);
        } else {
            tok.val = Some(Value::Bool(true));
            tok.must_escape = Some(true);
        }

        tok = self.tok_end(tok);
        self.tokens.push(tok);

        let rem = value_response.remaining_source;
        let mut next_byte = rem.len();
        let mut saw_non_ws: Option<(usize, char)> = None;
        for (b_idx, ch) in rem.char_indices() {
            if !is_whitespace_char(ch) {
                next_byte = b_idx;
                saw_non_ws = Some((b_idx, ch));
                break;
            }
            if ch == '\n' {
                self.increment_line(1);
            } else {
                self.increment_column(1);
            }
        }

        if let Some((b_idx, ',')) = saw_non_ws {
            self.increment_column(1);
            next_byte = b_idx + 1;
        }

        let _ = after_ws_byte;
        Ok(&rem[next_byte..])
    }

    fn attribute_value<'s>(&mut self, str_in: &'s str) -> Result<AttributeValueResponse<'s>, PugError> {
        if str_in.is_ascii() {
            let bytes = str_in.as_bytes();
            let mut escape_attr = true;
            let mut state = default_state();
            let mut col = self.colno;
            let mut line = self.lineno;
            let mut i = 0usize;

            let is_ws_b = |b: u8| b == b' ' || b == b'\n' || b == b'\t';

            while i < bytes.len() && is_ws_b(bytes[i]) {
                if bytes[i] == b'\n' {
                    line += 1;
                    col = 1;
                } else {
                    col += 1;
                }
                i += 1;
            }

            if i == bytes.len() {
                return Ok(AttributeValueResponse {
                    val: None,
                    must_escape: true,
                    remaining_source: str_in,
                });
            }

            if bytes[i] == b'!' {
                escape_attr = false;
                col += 1;
                i += 1;
                if bytes.get(i) != Some(&b'=') {
                    let unexpected = bytes
                        .get(i)
                        .map(|&b| char::from(b).to_string())
                        .unwrap_or_else(|| String::from("undefined"));
                    return Err(self.error(
                        "INVALID_KEY_CHARACTER",
                        format!("Unexpected character {unexpected} expected `=`"),
                    ));
                }
            }

            if bytes.get(i) != Some(&b'=') {
                if i == 0 && !bytes.is_empty() && !is_ws_b(bytes[0]) && bytes[0] != b',' {
                    let ch0 = char::from(bytes[0]).to_string();
                    return Err(self.error(
                        "INVALID_KEY_CHARACTER",
                        format!("Unexpected character {ch0} expected `=`"),
                    ));
                } else {
                    return Ok(AttributeValueResponse {
                        val: None,
                        must_escape: true,
                        remaining_source: str_in,
                    });
                }
            }

            self.lineno = line;
            self.colno = col + 1;
            i += 1;

            while i < bytes.len() && is_ws_b(bytes[i]) {
                if bytes[i] == b'\n' {
                    self.increment_line(1);
                } else {
                    self.increment_column(1);
                }
                i += 1;
            }

            line = self.lineno;
            col = self.colno;
            let val_start = i;

            while i < bytes.len() {
                if !(state.is_nesting(NestingOptions::default()) || state.is_string()) {
                    if is_ws_b(bytes[i]) {
                        let mut done = false;
                        let mut x = i;
                        while x < bytes.len() {
                            if !is_ws_b(bytes[x]) {
                                let b_x = bytes[x];
                                let is_not_punctuator = !is_punctuator_u16(Some(u16::from(b_x)));
                                let is_quote = b_x == b'\'' || b_x == b'"';
                                let is_colon = b_x == b':';
                                let is_spread = x + 2 < bytes.len()
                                    && bytes[x] == b'.'
                                    && bytes[x + 1] == b'.'
                                    && bytes[x + 2] == b'.';
                                if is_not_punctuator || is_quote || is_colon || is_spread {
                                    let current_val = &str_in[val_start..i];
                                    if self.assert_expression(current_val, true)? {
                                        done = true;
                                    }
                                }
                                break;
                            }
                            x += 1;
                        }
                        if done || x == bytes.len() {
                            break;
                        }
                    }

                    if bytes[i] == b',' {
                        let current_val = &str_in[val_start..i];
                        if self.assert_expression(current_val, true)? {
                            break;
                        }
                    }
                }

                let _ = parse_char_u16(u16::from(bytes[i]), &mut state);
                if bytes[i] == b'\n' {
                    line += 1;
                    col = 1;
                } else {
                    col += 1;
                }
                i += 1;
            }

            let val_str = &str_in[val_start..i];
            self.assert_expression(val_str, false)?;

            self.lineno = line;
            self.colno = col;

            return Ok(AttributeValueResponse {
                val: Some(val_str.to_string()),
                must_escape: escape_attr,
                remaining_source: &str_in[i..],
            });
        }

        let units: Vec<u16> = str_in.encode_utf16().collect();
        let mut val_units: Vec<u16> = Vec::new();
        let mut escape_attr = true;
        let mut state = default_state();
        let mut col = self.colno;
        let mut line = self.lineno;
        let mut i = 0usize;

        let is_ws_u16 = |u: u16| u == b' ' as u16 || u == b'\n' as u16 || u == b'\t' as u16;

        while i < units.len() {
            if !is_ws_u16(units[i]) {
                break;
            }
            if units[i] == b'\n' as u16 {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
            i += 1;
        }

        if i == units.len() {
            return Ok(AttributeValueResponse {
                val: None,
                must_escape: true,
                remaining_source: str_in,
            });
        }

        if units[i] == b'!' as u16 {
            escape_attr = false;
            col += 1;
            i += 1;
            if units.get(i) != Some(&(b'=' as u16)) {
                let unexpected = units
                    .get(i)
                    .and_then(|&u| char::from_u32(u as u32))
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| String::from("undefined"));
                return Err(self.error(
                    "INVALID_KEY_CHARACTER",
                    format!("Unexpected character {unexpected} expected `=`"),
                ));
            }
        }

        if units.get(i) != Some(&(b'=' as u16)) {
            if i == 0 && !units.is_empty() && !is_ws_u16(units[0]) && units[0] != b',' as u16 {
                let ch0 = char::from_u32(units[0] as u32)
                    .map(|c| c.to_string())
                    .unwrap_or_default();
                return Err(self.error(
                    "INVALID_KEY_CHARACTER",
                    format!("Unexpected character {ch0} expected `=`"),
                ));
            } else {
                return Ok(AttributeValueResponse {
                    val: None,
                    must_escape: true,
                    remaining_source: str_in,
                });
            }
        }

        self.lineno = line;
        self.colno = col + 1;
        i += 1;

        while i < units.len() {
            if !is_ws_u16(units[i]) {
                break;
            }
            if units[i] == b'\n' as u16 {
                self.increment_line(1);
            } else {
                self.increment_column(1);
            }
            i += 1;
        }

        line = self.lineno;
        col = self.colno;

        while i < units.len() {
            if !(state.is_nesting(NestingOptions::default()) || state.is_string()) {
                if is_ws_u16(units[i]) {
                    let mut done = false;
                    let mut x = i;
                    while x < units.len() {
                        if !is_ws_u16(units[x]) {
                            let u_x = units[x];
                            let is_not_punctuator = !is_punctuator_u16(Some(u_x));
                            let is_quote = u_x == b'\'' as u16 || u_x == b'"' as u16;
                            let is_colon = u_x == b':' as u16;
                            let is_spread = x + 2 < units.len()
                                && units[x] == b'.' as u16
                                && units[x + 1] == b'.' as u16
                                && units[x + 2] == b'.' as u16;
                            if is_not_punctuator || is_quote || is_colon || is_spread {
                                let current_val = String::from_utf16_lossy(&val_units);
                                if self.assert_expression(&current_val, true)? {
                                    done = true;
                                }
                            }
                            break;
                        }
                        x += 1;
                    }
                    if done || x == units.len() {
                        break;
                    }
                }

                if units[i] == b',' as u16 {
                    let current_val = String::from_utf16_lossy(&val_units);
                    if self.assert_expression(&current_val, true)? {
                        break;
                    }
                }
            }

            let _ = parse_char_u16(units[i], &mut state);
            val_units.push(units[i]);

            if units[i] == b'\n' as u16 {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
            i += 1;
        }

        let val_str = String::from_utf16_lossy(&val_units);
        self.assert_expression(&val_str, false)?;

        self.lineno = line;
        self.colno = col;

        let rem_str = substr_u16(str_in, i);
        Ok(AttributeValueResponse {
            val: Some(val_str),
            must_escape: escape_attr,
            remaining_source: rem_str,
        })
    }

    fn attrs(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with('(') {
            let start_tok = self.tok("start-attributes", None);
            let index = self.bracket_expression(0)?.end;
            let str_inside = substr_u16_len(self.rest(), 1, index - 1).to_string();

            self.increment_column(1);
            let ended_start = self.tok_end(start_tok);
            self.tokens.push(ended_start);
            self.assert_nesting_correct(&str_inside)?;
            self.consume_u16(index + 1);

            let mut rem = str_inside.as_str();
            while !rem.is_empty() {
                rem = self.attribute(rem)?;
            }

            let end_tok = self.tok("end-attributes", None);
            self.increment_column(1);
            let ended_end = self.tok_end(end_tok);
            self.tokens.push(ended_end);
            return Ok(true);
        }
        Ok(false)
    }

    fn attributes_block(&mut self) -> Result<bool, PugError> {
        if let Some(rest) = self.rest().strip_prefix("&attributes") {
            if !rest.chars().next().is_some_and(is_word_char) {
                let consumed = 11usize;
                self.consume_u16(consumed);
                let mut tok = self.tok("&attributes", None);
                self.increment_column(consumed as isize);
                let args = self.bracket_expression(0)?;
                let consumed_args = args.end + 1;
                self.consume_u16(consumed_args);
                tok.val = Some(Value::String(args.src));
                self.increment_column(consumed_args as isize);
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn indent(&mut self) -> Result<bool, PugError> {
        if let Some((_total_len, indents)) = self.scan_indentation() {
            self.increment_line(1);
            self.consume_u16(indents + 1);

            if self.rest().starts_with(' ') || self.rest().starts_with('\t') {
                return Err(self.error(
                    "INVALID_INDENTATION",
                    "Invalid indentation, you can use tabs or spaces but not both",
                ));
            }

            // blank line
            if self.rest().starts_with('\n') {
                self.interpolation_allowed = true;
                return Ok(true);
            }

            // outdent
            if indents < self.indent_stack[0] {
                let mut outdent_count = 0usize;
                while self.indent_stack[0] > indents {
                    if self.indent_stack.get(1).copied().unwrap_or(0) < indents {
                        return Err(self.error(
                            "INCONSISTENT_INDENTATION",
                            format!(
                                "Inconsistent indentation. Expecting either {} or {} spaces/tabs.",
                                self.indent_stack.get(1).copied().unwrap_or(0),
                                self.indent_stack[0]
                            ),
                        ));
                    }
                    outdent_count += 1;
                    self.indent_stack.remove(0);
                }
                while outdent_count > 0 {
                    outdent_count -= 1;
                    self.colno = 1;
                    let tok = self.tok("outdent", None);
                    self.colno = self.indent_stack[0] + 1;
                    let ended = self.tok_end(tok);
                    self.tokens.push(ended);
                }
            } else if indents > 0 && indents != self.indent_stack[0] {
                let tok = self.tok("indent", Some(Value::Number(indents.into())));
                self.colno = 1 + indents;
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
                self.indent_stack.insert(0, indents);
            } else {
                let tok = self.tok("newline", None);
                self.colno = 1 + self.indent_stack.first().copied().unwrap_or(0).min(indents);
                let ended = self.tok_end(tok);
                self.tokens.push(ended);
            }

            self.interpolation_allowed = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn pipeless_text(&mut self, indents_arg: Option<usize>) -> Result<bool, PugError> {
        while self.blank()? {}

        let captures = self.scan_indentation();
        let indents = indents_arg.or_else(|| captures.map(|(_, ind)| ind)).unwrap_or(0);

        if indents > self.indent_stack[0] {
            let start_tok = self.tok_end(self.tok("start-pipeless-text", None));
            self.tokens.push(start_tok);

            let mut tokens_list: Vec<String> = Vec::new();
            let mut token_indent: Vec<bool> = Vec::new();
            let mut string_ptr_u16 = 0usize;
            let input_u16_len = utf16_len(self.rest());

            loop {
                // `var i = this.input.substr(stringPtr + 1).indexOf('\n');`
                let after_nl = substr_u16(self.rest(), string_ptr_u16 + 1);
                let i_u16 = match after_nl.find('\n') {
                    Some(byte_pos) => utf16_len(&after_nl[..byte_pos]),
                    None => input_u16_len - string_ptr_u16 - 1,
                };
                let str_line = substr_u16_len(&self.input_buf[self.pos..], string_ptr_u16 + 1, i_u16);
                let line_with_nl = format!("\n{str_line}");
                let line_captures = Self::scan_indentation_on(&mut self.indent_mode, &line_with_nl);
                let line_indents = line_captures.map(|(_, ind)| ind).unwrap_or(0);
                let mut is_match = line_indents >= indents;
                token_indent.push(is_match);
                is_match = is_match || str_line.trim().is_empty();
                if is_match {
                    string_ptr_u16 += utf16_len(str_line) + 1;
                    tokens_list.push(substr_u16(str_line, indents).to_string());
                } else if line_indents > self.indent_stack[0] {
                    self.tokens.pop();
                    return self.pipeless_text(Some(line_indents));
                }
                if input_u16_len - string_ptr_u16 == 0 || !is_match {
                    break;
                }
            }

            self.consume_u16(string_ptr_u16);
            while self.rest().is_empty() && tokens_list.last().is_some_and(|s| s.is_empty()) {
                tokens_list.pop();
            }

            for (i, token_str) in tokens_list.iter().enumerate() {
                self.increment_line(1);
                let nl_tok = if i != 0 {
                    Some(self.tok("newline", None))
                } else {
                    None
                };
                if token_indent[i] {
                    self.increment_column(indents as isize);
                }
                if let Some(t) = nl_tok {
                    let ended = self.tok_end(t);
                    self.tokens.push(ended);
                }
                self.add_text("text", token_str, None, 0)?;
            }

            let end_tok = self.tok_end(self.tok("end-pipeless-text", None));
            self.tokens.push(end_tok);
            return Ok(true);
        }
        Ok(false)
    }

    fn slash(&mut self) -> Result<bool, PugError> {
        if self.rest().starts_with('/') {
            let tok = self.scan_exact(1, None, "slash");
            let ended = self.tok_end(tok);
            self.tokens.push(ended);
            return Ok(true);
        }
        Ok(false)
    }

    fn colon(&mut self) -> Result<bool, PugError> {
        if let Some(after_colon) = self.rest().strip_prefix(": ") {
            let extra_spaces = after_colon.bytes().take_while(|&b| b == b' ').count();
            let tok = self.scan_exact(2 + extra_spaces, None, ":");
            let ended = self.tok_end(tok);
            self.tokens.push(ended);
            return Ok(true);
        }
        Ok(false)
    }

    fn fail(&self) -> Result<bool, PugError> {
        let preview = substr_u16_len(self.rest(), 0, 5);
        Err(self.error("UNEXPECTED_TEXT", format!("unexpected text \"{preview}\"")))
    }

    pub fn advance(&mut self) -> Result<bool, PugError> {
        macro_rules! step {
            ($name:literal, $call:expr) => {
                self.run_plugin_step($name)? || $call?
            };
        }
        if step!("blank", self.blank())
            || step!("eos", self.eos())
            || step!("endInterpolation", self.end_interpolation())
            || step!("yield", self.yield_tok())
            || step!("doctype", self.doctype())
            || step!("interpolation", self.interpolation())
            || step!("case", self.case_tok())
            || step!("when", self.when())
            || step!("default", self.default_tok())
            || step!("extends", self.extends_tok())
            || step!("append", self.append())
            || step!("prepend", self.prepend())
            || step!("block", self.block())
            || step!("mixinBlock", self.mixin_block())
            || step!("include", self.include())
            || step!("mixin", self.mixin())
            || step!("call", self.call())
            || step!("conditional", self.conditional())
            || step!("eachOf", self.each_of())
            || step!("each", self.each())
            || step!("while", self.while_tok())
            || step!("tag", self.tag())
            || step!("filter", self.filter(false))
            || step!("blockCode", self.block_code())
            || step!("code", self.code())
            || step!("id", self.id())
            || step!("dot", self.dot())
            || step!("className", self.class_name())
            || step!("attrs", self.attrs())
            || step!("attributesBlock", self.attributes_block())
            || step!("indent", self.indent())
            || step!("text", self.text())
            || step!("textHtml", self.text_html())
            || step!("comment", self.comment())
            || step!("slash", self.slash())
            || step!("colon", self.colon())
        {
            return Ok(true);
        }
        self.fail()
    }

    pub fn get_tokens(&mut self) -> Result<Vec<Token>, PugError> {
        while !self.ended {
            if !self.run_plugin_step("advance")? {
                self.advance()?;
            }
        }
        Ok(std::mem::take(&mut self.tokens))
    }
}
