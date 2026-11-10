use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TokenType {
    LineComment,
    BlockComment,
    SingleQuote,
    DoubleQuote,
    TemplateQuote,
    Regexp,
    RoundBracket,
    CurlyBracket,
    SquareBracket,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NestingOptions {
    pub ignore_line_comment: bool,
    pub ignore_nesting: bool,
    pub start: usize,
    pub end: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    pub stack: Vec<TokenType>,
    pub regexp_start: bool,
    pub escaped: bool,
    pub has_dollar: bool,
    pub src: String,
    pub history: Vec<u16>,
    pub last_char: Option<u16>,
}

impl Default for State {
    fn default() -> Self {
        Self::new()
    }
}

impl State {
    pub fn new() -> Self {
        Self {
            stack: Vec::new(),
            regexp_start: false,
            escaped: false,
            has_dollar: false,
            src: String::new(),
            history: Vec::new(),
            last_char: None,
        }
    }

    pub fn current(&self) -> Option<TokenType> {
        self.stack.last().copied()
    }

    pub fn is_string(&self) -> bool {
        matches!(
            self.current(),
            Some(TokenType::SingleQuote | TokenType::DoubleQuote | TokenType::TemplateQuote)
        )
    }

    pub fn is_comment(&self) -> bool {
        matches!(
            self.current(),
            Some(TokenType::LineComment | TokenType::BlockComment)
        )
    }

    pub fn is_nesting(&self, opts: NestingOptions) -> bool {
        if opts.ignore_line_comment
            && self.stack.len() == 1
            && self.stack[0] == TokenType::LineComment
        {
            return false;
        }
        !self.stack.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CharacterParserErrorCode {
    EndOfStringReached,
    MismatchedBracket,
    CharLengthNotOne,
}

impl CharacterParserErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EndOfStringReached => "CHARACTER_PARSER:END_OF_STRING_REACHED",
            Self::MismatchedBracket => "CHARACTER_PARSER:MISMATCHED_BRACKET",
            Self::CharLengthNotOne => "CHARACTER_PARSER:CHAR_LENGTH_NOT_ONE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterParserError {
    pub code: CharacterParserErrorCode,
    pub message: String,
    pub index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseUntilRange {
    pub start: usize,
    pub end: usize,
    pub src: String,
}

fn is_open_bracket(ch: u16) -> bool {
    ch == b'(' as u16 || ch == b'{' as u16 || ch == b'[' as u16
}

fn is_close_bracket(ch: u16) -> bool {
    ch == b')' as u16 || ch == b'}' as u16 || ch == b']' as u16
}

fn get_bracket_type(open_bracket: u16) -> Option<TokenType> {
    match open_bracket {
        x if x == b'(' as u16 => Some(TokenType::RoundBracket),
        x if x == b'{' as u16 => Some(TokenType::CurlyBracket),
        x if x == b'[' as u16 => Some(TokenType::SquareBracket),
        _ => None,
    }
}

fn is_matching_bracket(close_bracket: u16, bracket_type: Option<TokenType>) -> bool {
    match bracket_type {
        Some(TokenType::RoundBracket) => close_bracket == b')' as u16,
        Some(TokenType::CurlyBracket) => close_bracket == b'}' as u16,
        Some(TokenType::SquareBracket) => close_bracket == b']' as u16,
        _ => false,
    }
}

pub fn default_state() -> State {
    State::new()
}

pub fn is_punctuator_u16(c: Option<u16>) -> bool {
    let Some(code) = c else {
        return true; // start of string is a punctuator
    };
    matches!(
        code,
        46  // .
        | 40 // (
        | 41 // )
        | 59 // ;
        | 44 // ,
        | 123 // {
        | 125 // }
        | 91 // [
        | 93 // ]
        | 58 // :
        | 63 // ?
        | 126 // ~
        | 37 // %
        | 38 // &
        | 42 // *
        | 43 // +
        | 45 // -
        | 47 // /
        | 60 // <
        | 62 // >
        | 94 // ^
        | 124 // |
        | 33 // !
        | 61 // =
    )
}

pub fn is_punctuator(c: Option<char>) -> bool {
    is_punctuator_u16(c.map(|ch| {
        let mut buf = [0u16; 2];
        ch.encode_utf16(&mut buf)[0]
    }))
}

pub fn is_keyword(id: &str) -> bool {
    matches!(
        id,
        "if" | "in"
            | "do"
            | "var"
            | "for"
            | "new"
            | "try"
            | "let"
            | "this"
            | "else"
            | "case"
            | "void"
            | "with"
            | "enum"
            | "while"
            | "break"
            | "catch"
            | "throw"
            | "const"
            | "yield"
            | "class"
            | "super"
            | "return"
            | "typeof"
            | "delete"
            | "switch"
            | "export"
            | "import"
            | "default"
            | "finally"
            | "extends"
            | "function"
            | "continue"
            | "debugger"
            | "package"
            | "private"
            | "interface"
            | "instanceof"
            | "implements"
            | "protected"
            | "public"
            | "static"
    )
}

fn is_js_whitespace(u: u16) -> bool {
    matches!(
        u,
        0x0009
            | 0x000A
            | 0x000B
            | 0x000C
            | 0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

fn is_word_u16(u: u16) -> bool {
    matches!(u, 48..=57 | 65..=90 | 95 | 97..=122)
}

fn is_regexp(history: &[u16]) -> bool {
    let mut i = 0;
    while i < history.len() && is_js_whitespace(history[i]) {
        i += 1;
    }
    let trimmed = &history[i..];
    let first = trimmed.first().copied();
    if first == Some(b')' as u16) {
        return false;
    }
    if first == Some(b'}' as u16) {
        return true;
    }
    if is_punctuator_u16(first) {
        return true;
    }
    // Check `^\w+\b` in reversed history
    let mut word_len = 0;
    while word_len < trimmed.len() && is_word_u16(trimmed[word_len]) {
        word_len += 1;
    }
    if word_len > 0 {
        let mut rev = String::with_capacity(word_len);
        for &u in trimmed[..word_len].iter().rev() {
            rev.push(u as u8 as char);
        }
        if is_keyword(&rev) {
            return true;
        }
    }
    false
}

pub fn parse_char_u16(character: u16, state: &mut State) -> Result<(), CharacterParserError> {
    if let Some(ch) = char::from_u32(character as u32) {
        state.src.push(ch);
    }
    let was_comment = state.is_comment();
    let last_char = state.history.last().copied();

    if state.regexp_start {
        if character == b'/' as u16 || character == b'*' as u16 {
            state.stack.pop();
        }
        state.regexp_start = false;
    }

    match state.current() {
        Some(TokenType::LineComment) => {
            if character == b'\n' as u16 {
                state.stack.pop();
            }
        }
        Some(TokenType::BlockComment) => {
            if state.last_char == Some(b'*' as u16) && character == b'/' as u16 {
                state.stack.pop();
            }
        }
        Some(TokenType::SingleQuote) => {
            if character == b'\'' as u16 && !state.escaped {
                state.stack.pop();
            } else if character == b'\\' as u16 && !state.escaped {
                state.escaped = true;
            } else {
                state.escaped = false;
            }
        }
        Some(TokenType::DoubleQuote) => {
            if character == b'"' as u16 && !state.escaped {
                state.stack.pop();
            } else if character == b'\\' as u16 && !state.escaped {
                state.escaped = true;
            } else {
                state.escaped = false;
            }
        }
        Some(TokenType::TemplateQuote) => {
            if character == b'`' as u16 && !state.escaped {
                state.stack.pop();
                state.has_dollar = false;
            } else if character == b'\\' as u16 && !state.escaped {
                state.escaped = true;
                state.has_dollar = false;
            } else if character == b'$' as u16 && !state.escaped {
                state.has_dollar = true;
            } else if character == b'{' as u16 && state.has_dollar {
                state.stack.push(TokenType::CurlyBracket);
            } else {
                state.escaped = false;
                state.has_dollar = false;
            }
        }
        Some(TokenType::Regexp) => {
            if character == b'/' as u16 && !state.escaped {
                state.stack.pop();
            } else if character == b'\\' as u16 && !state.escaped {
                state.escaped = true;
            } else {
                state.escaped = false;
            }
        }
        _ => {
            if is_open_bracket(character) {
                if let Some(bt) = get_bracket_type(character) {
                    state.stack.push(bt);
                }
            } else if is_close_bracket(character) {
                if !is_matching_bracket(character, state.current()) {
                    let ch_str = char::from_u32(character as u32)
                        .map(|c| c.to_string())
                        .unwrap_or_default();
                    return Err(CharacterParserError {
                        code: CharacterParserErrorCode::MismatchedBracket,
                        message: format!("Mismatched Bracket: {ch_str}"),
                        index: None,
                    });
                }
                state.stack.pop();
            } else if last_char == Some(b'/' as u16) && character == b'/' as u16 {
                state.history.pop();
                state.stack.push(TokenType::LineComment);
            } else if last_char == Some(b'/' as u16) && character == b'*' as u16 {
                state.history.pop();
                state.stack.push(TokenType::BlockComment);
            } else if character == b'/' as u16 && {
                let mut rev_hist = state.history.clone();
                rev_hist.reverse();
                is_regexp(&rev_hist)
            } {
                state.stack.push(TokenType::Regexp);
                state.regexp_start = true;
            } else if character == b'\'' as u16 {
                state.stack.push(TokenType::SingleQuote);
            } else if character == b'"' as u16 {
                state.stack.push(TokenType::DoubleQuote);
            } else if character == b'`' as u16 {
                state.stack.push(TokenType::TemplateQuote);
            }
        }
    }

    if !state.is_comment() && !was_comment {
        state.history.push(character);
    }
    state.last_char = Some(character);
    Ok(())
}

pub fn parse_char(character: char, mut state: State) -> Result<State, CharacterParserError> {
    let mut buf = [0u16; 2];
    let units = character.encode_utf16(&mut buf);
    if units.len() != 1 {
        return Err(CharacterParserError {
            code: CharacterParserErrorCode::CharLengthNotOne,
            message: String::from("Character must be a string of length 1"),
            index: None,
        });
    }
    parse_char_u16(units[0], &mut state)?;
    Ok(state)
}

pub fn parse(src: &str, options: NestingOptions) -> Result<State, CharacterParserError> {
    let units: Vec<u16> = src.encode_utf16().collect();
    let start = options.start;
    let end = options.end.unwrap_or(units.len()).min(units.len());
    let mut state = default_state();
    for (idx, &u) in units.iter().enumerate().take(end).skip(start) {
        if let Err(mut err) = parse_char_u16(u, &mut state) {
            err.index = Some(idx);
            return Err(err);
        }
    }
    Ok(state)
}

pub fn parse_until(
    src: &str,
    delimiter: &str,
    options: NestingOptions,
) -> Result<ParseUntilRange, CharacterParserError> {
    let units: Vec<u16> = src.encode_utf16().collect();
    let delim_units: Vec<u16> = delimiter.encode_utf16().collect();
    let start = options.start;
    let mut state = default_state();

    for index in start..units.len() {
        if (options.ignore_nesting || !state.is_nesting(options))
            && index + delim_units.len() <= units.len()
            && units[index..index + delim_units.len()] == delim_units[..]
        {
            let slice_str = String::from_utf16_lossy(&units[start..index]);
            return Ok(ParseUntilRange {
                start,
                end: index,
                src: slice_str,
            });
        }
        if let Err(mut err) = parse_char_u16(units[index], &mut state) {
            err.index = Some(index);
            return Err(err);
        }
    }

    Err(CharacterParserError {
        code: CharacterParserErrorCode::EndOfStringReached,
        message: String::from("The end of the string was reached with no closing bracket found."),
        index: Some(units.len()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nested_parens_and_strings() {
        let range = parse_until(
            "foo(')', `a ${b(')')} c`, /\\)/g))",
            ")",
            NestingOptions::default(),
        )
        .unwrap();
        assert_eq!(range.src, "foo(')', `a ${b(')')} c`, /\\)/g)");
    }

    #[test]
    fn test_template_literal_nested_braces() {
        let range = parse_until(
            "`hello ${user ? `${user.name}` : 'world'}`}",
            "}",
            NestingOptions::default(),
        )
        .unwrap();
        assert_eq!(range.src, "`hello ${user ? `${user.name}` : 'world'}`");
    }

    #[test]
    fn test_regex_vs_division() {
        // Division: `a / b )` -> `)` closes the outer bracket!
        let div = parse_until("a / b)", ")", NestingOptions::default()).unwrap();
        assert_eq!(div.src, "a / b");

        // Regex after keyword: `return /a)b/)` -> `)` inside regex is ignored!
        let re = parse_until("return /a)b/)", ")", NestingOptions::default()).unwrap();
        assert_eq!(re.src, "return /a)b/");
    }

    #[test]
    fn test_mismatched_bracket_and_eof() {
        let err = parse_until("(a + [b)", ")", NestingOptions::default()).unwrap_err();
        assert_eq!(err.code, CharacterParserErrorCode::MismatchedBracket);
        assert_eq!(err.message, "Mismatched Bracket: )");
        assert_eq!(err.index, Some(7));

        let eof = parse_until("(a + b", ")", NestingOptions::default()).unwrap_err();
        assert_eq!(eof.code, CharacterParserErrorCode::EndOfStringReached);
        assert_eq!(eof.index, Some(6));
    }

    #[test]
    fn test_unicode_emoji_indices() {
        // '😀' is 2 UTF-16 code units, matching JS String.prototype.length!
        let range = parse_until("'😀')", ")", NestingOptions::default()).unwrap();
        assert_eq!(range.src, "'😀'");
        assert_eq!(range.end, 4);
    }
}
