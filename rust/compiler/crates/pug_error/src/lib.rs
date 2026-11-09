use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorOptions {
    pub line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PugErrorJson {
    pub code: String,
    pub msg: String,
    pub line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// Standard Pug error object matching `raw/compiler/packages/pug-error/src/index.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PugError {
    pub code: String,
    pub msg: String,
    pub line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    pub message: String,
    #[serde(skip)]
    pub is_js_host_exception: bool,
}

impl PugError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        options: ErrorOptions,
    ) -> Self {
        let raw_code = code.into();
        let full_code = if raw_code.starts_with("PUG:") {
            raw_code
        } else {
            format!("PUG:{raw_code}")
        };
        let msg = message.into();
        let line = options.line;
        let column = options.column;
        let filename = options.filename;
        let src = options.src;

        let location = match column {
            Some(col) if col != 0 => format!("{line}:{col}"),
            _ => line.to_string(),
        };

        let display_filename = match filename.as_deref() {
            Some(f) if !f.is_empty() => f,
            _ => "Pug",
        };

        let full_message = if let Some(ref s) = src
            && !s.is_empty()
        {
            let lines: Vec<&str> = s.split('\n').collect();
            let total_lines = lines.len() as i64;
            if line >= 1 && line <= total_lines {
                let start = (line - 3).max(0) as usize;
                let end = (line + 3).min(total_lines) as usize;
                let mut context_lines = Vec::with_capacity(end - start);
                for (i, text) in lines[start..end].iter().enumerate() {
                    let curr = (i + start + 1) as i64;
                    let prefix = if curr == line { "  > " } else { "    " };
                    let preamble = format!("{prefix}{curr}| ");
                    let mut out = format!("{preamble}{text}");
                    if curr == line
                        && let Some(col) = column
                        && col > 0
                    {
                        let dash_count =
                            (preamble.chars().map(char::len_utf16).sum::<usize>() + col as usize)
                                .saturating_sub(1);
                        out.push('\n');
                        for _ in 0..dash_count {
                            out.push('-');
                        }
                        out.push('^');
                    }
                    context_lines.push(out);
                }
                let context = context_lines.join("\n");
                format!("{display_filename}:{location}\n{context}\n\n{msg}")
            } else {
                format!("{display_filename}:{location}\n\n{msg}")
            }
        } else {
            format!("{display_filename}:{location}\n\n{msg}")
        };

        Self {
            code: full_code,
            msg,
            line,
            column,
            filename,
            src,
            message: full_message,
            is_js_host_exception: false,
        }
    }

    pub fn host_exception(message: impl Into<String>) -> Self {
        let m = message.into();
        Self {
            code: String::from("JS_HOST_EXCEPTION"),
            msg: m.clone(),
            line: 0,
            column: None,
            filename: None,
            src: None,
            message: m,
            is_js_host_exception: true,
        }
    }

    pub fn to_json(&self) -> PugErrorJson {
        PugErrorJson {
            code: self.code.clone(),
            msg: self.msg.clone(),
            line: self.line,
            column: self.column,
            filename: self.filename.clone(),
        }
    }
}

impl fmt::Display for PugError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PugError {}

pub fn make_error(
    code: impl Into<String>,
    message: impl Into<String>,
    options: ErrorOptions,
) -> PugError {
    PugError::new(code, message, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_with_source_and_filename() {
        let err = make_error(
            "MY_CODE",
            "My message",
            ErrorOptions {
                line: 3,
                column: None,
                filename: Some("myfile".into()),
                src: Some("foo\nbar\nbaz\nbash\nbing".into()),
            },
        );
        assert_eq!(
            err.message,
            "myfile:3\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message"
        );
        assert_eq!(err.code, "PUG:MY_CODE");
        assert_eq!(err.msg, "My message");
        assert_eq!(err.line, 3);
        assert_eq!(err.filename.as_deref(), Some("myfile"));
        assert_eq!(err.src.as_deref(), Some("foo\nbar\nbaz\nbash\nbing"));
    }

    #[test]
    fn test_with_source_and_no_filename() {
        let err = make_error(
            "MY_CODE",
            "My message",
            ErrorOptions {
                line: 3,
                column: None,
                filename: None,
                src: Some("foo\nbar\nbaz\nbash\nbing".into()),
            },
        );
        assert_eq!(
            err.message,
            "Pug:3\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message"
        );
        assert_eq!(err.filename, None);
    }

    #[test]
    fn test_without_source() {
        let err1 = make_error(
            "MY_CODE",
            "My message",
            ErrorOptions {
                line: 3,
                column: None,
                filename: Some("myfile".into()),
                src: None,
            },
        );
        assert_eq!(err1.message, "myfile:3\n\nMy message");

        let err2 = make_error(
            "MY_CODE",
            "My message",
            ErrorOptions {
                line: 3,
                column: None,
                filename: None,
                src: None,
            },
        );
        assert_eq!(err2.message, "Pug:3\n\nMy message");
    }

    #[test]
    fn test_with_column() {
        let err1 = make_error(
            "MY_CODE",
            "My message",
            ErrorOptions {
                line: 3,
                column: Some(2),
                filename: Some("myfile".into()),
                src: Some("foo\nbar\nbaz\nbash\nbing".into()),
            },
        );
        assert_eq!(
            err1.message,
            "myfile:3:2\n    1| foo\n    2| bar\n  > 3| baz\n--------^\n    4| bash\n    5| bing\n\nMy message"
        );

        let err2 = make_error(
            "MY_CODE",
            "My message",
            ErrorOptions {
                line: 3,
                column: Some(1),
                filename: None,
                src: None,
            },
        );
        assert_eq!(err2.message, "Pug:3:1\n\nMy message");
    }

    #[test]
    fn test_invalid_information() {
        let err_neg = make_error(
            "MY_CODE",
            "My message",
            ErrorOptions {
                line: 3,
                column: Some(-1),
                filename: None,
                src: Some("foo\nbar\nbaz\nbash\nbing".into()),
            },
        );
        assert_eq!(
            err_neg.message,
            "Pug:3:-1\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message"
        );

        for line in [0, 6] {
            let err = make_error(
                "MY_CODE",
                "My message",
                ErrorOptions {
                    line,
                    column: None,
                    filename: None,
                    src: Some("foo\nbar\nbaz\nbash\nbing".into()),
                },
            );
            assert_eq!(err.message, format!("Pug:{line}\n\nMy message"));
        }
    }
}
