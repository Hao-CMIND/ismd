use serde::{Deserialize, Serialize};

/// 1-based line number and 1-based UTF-16 code unit column number,
/// matching JavaScript `String.prototype.length` / `.charCodeAt` semantics in Ismd.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineCol {
    pub line: usize,
    pub column: usize,
}

impl LineCol {
    pub const fn new(line: usize, column: usize) -> Self {
        Self { line, column }
    }
}

/// Internal UTF-8 byte span paired with Ismd's 1-based line / UTF-16 column coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub byte_start: usize,
    pub byte_end: usize,
    pub start: LineCol,
    pub end: LineCol,
}

/// Token location DTO matching `ismd-lexer` (`{ start: { line, column }, end: { line, column }, filename? }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenLoc {
    pub start: LineCol,
    pub end: LineCol,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// Indexes a source string to convert between UTF-8 byte offsets and
/// Ismd's 1-based line + 1-based UTF-16 column coordinates.
#[derive(Debug, Clone)]
pub struct SourceIndex {
    /// Byte offset of the start of each 0-indexed line.
    line_starts: Vec<usize>,
    source_len: usize,
}

impl SourceIndex {
    /// Normalizes Ismd input newlines (`\r\n` and `\r` -> `\n`) and strips UTF-8 BOM (`\u{FEFF}`)
    /// only when explicitly requested by the caller; `SourceIndex::new` indexes the exact string given.
    pub fn normalize_ismd_input(input: &str) -> String {
        let stripped = input.strip_prefix('\u{feff}').unwrap_or(input);
        if stripped.contains('\r') {
            stripped.replace("\r\n", "\n").replace('\r', "\n")
        } else {
            stripped.to_string()
        }
    }

    pub fn new(src: &str) -> Self {
        let mut line_starts = vec![0];
        for (i, b) in src.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }
        Self {
            line_starts,
            source_len: src.len(),
        }
    }

    /// Converts a UTF-8 byte offset within `src` into 1-based `(line, utf16_column)`.
    pub fn line_col(&self, src: &str, byte_offset: usize) -> LineCol {
        let clamped = byte_offset.min(self.source_len);
        let line_idx = match self.line_starts.binary_search(&clamped) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let line_start = self.line_starts[line_idx];
        let slice = &src[line_start..clamped];
        let utf16_col: usize = slice.chars().map(char::len_utf16).sum::<usize>() + 1;
        LineCol {
            line: line_idx + 1,
            column: utf16_col,
        }
    }

    /// Converts a 1-based `(line, utf16_column)` back into a UTF-8 byte offset in `src`, if valid.
    pub fn byte_offset(&self, src: &str, pos: LineCol) -> Option<usize> {
        if pos.line == 0 || pos.line > self.line_starts.len() || pos.column == 0 {
            return None;
        }
        let line_idx = pos.line - 1;
        let line_start = self.line_starts[line_idx];
        let line_end = if line_idx + 1 < self.line_starts.len() {
            self.line_starts[line_idx + 1]
        } else {
            self.source_len
        };
        let line_str = &src[line_start..line_end];
        let mut utf16_acc = 1;
        for (byte_rel, ch) in line_str.char_indices() {
            if utf16_acc == pos.column {
                return Some(line_start + byte_rel);
            }
            utf16_acc += ch.len_utf16();
        }
        if utf16_acc == pos.column {
            Some(line_end)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_and_multiline_coordinates() {
        let src = "p Hello\n  span World";
        let idx = SourceIndex::new(src);
        assert_eq!(idx.line_col(src, 0), LineCol::new(1, 1));
        assert_eq!(idx.line_col(src, 2), LineCol::new(1, 3));
        assert_eq!(idx.line_col(src, 8), LineCol::new(2, 1));
        assert_eq!(idx.line_col(src, 10), LineCol::new(2, 3));
        assert_eq!(idx.byte_offset(src, LineCol::new(2, 3)), Some(10));
    }

    #[test]
    fn test_cjk_and_emoji_utf16_columns() {
        // '\u{4E2D}' (U+4E2D) is 3 UTF-8 bytes, 1 UTF-16 code unit.
        // '\u{1F600}' (U+1F600) is 4 UTF-8 bytes, 2 UTF-16 code units (surrogate pair).
        let src = "p \u{4E2D}\u{1F600}a";
        let idx = SourceIndex::new(src);
        // 'p' at byte 0 -> col 1
        // ' ' at byte 1 -> col 2
        // '\u{4E2D}' at byte 2..5 -> starts col 3
        // '\u{1F600}' at byte 5..9 -> starts col 4, occupies cols 4 & 5
        // 'a' at byte 9..10 -> starts col 6
        assert_eq!(idx.line_col(src, 2), LineCol::new(1, 3));
        assert_eq!(idx.line_col(src, 5), LineCol::new(1, 4));
        assert_eq!(idx.line_col(src, 9), LineCol::new(1, 6));
        assert_eq!(idx.byte_offset(src, LineCol::new(1, 3)), Some(2));
        assert_eq!(idx.byte_offset(src, LineCol::new(1, 4)), Some(5));
        assert_eq!(idx.byte_offset(src, LineCol::new(1, 6)), Some(9));
    }

    #[test]
    fn test_bom_and_crlf_normalization() {
        let raw = "\u{feff}p foo\r\np bar\rp baz";
        let norm = SourceIndex::normalize_ismd_input(raw);
        assert_eq!(norm, "p foo\np bar\np baz");
    }
}
