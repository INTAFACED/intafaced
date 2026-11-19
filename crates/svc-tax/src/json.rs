//! JSON as the TypeScript service reads and writes it: `JSON.parse` and `JSON.stringify` semantics, byte for byte.
//!
//! Hand-written rather than serde_json because the wire must match V8 exactly: an object keeps its keys in JavaScript's
//! order (array-index keys first, ascending, then the rest as they arrived), a repeated key keeps its first place and its
//! last value, and output escapes exactly what `JSON.stringify` escapes.

use std::fmt::Write as _;

/// A JSON value. Numbers are `f64`, as in JavaScript; an object is an ordered list of keys.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// A string value.
    pub fn str(s: impl Into<String>) -> Json {
        Json::String(s.into())
    }

    /// An integer as a JSON number. Every integer the service writes is far inside f64's exact range.
    pub fn int(n: i64) -> Json {
        #[expect(
            clippy::cast_precision_loss,
            reason = "the integers written (codes, counts, bounds) are below 2^53"
        )]
        Json::Number(n as f64)
    }

    /// An object from its fields, in the order given.
    pub fn obj<const N: usize>(fields: [(&str, Json); N]) -> Json {
        Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    /// The value at `key`, when this is an object holding it.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `JSON.stringify(value)`.
    pub fn compact(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, None, 0);
        out
    }

    /// `JSON.stringify(value, null, 2)`.
    pub fn pretty(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, Some(2), 0);
        out
    }
}

/// Why a text is not JSON. The message is this parser's own, not V8's wording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("Unexpected non-whitespace character after JSON"));
    }
    Ok(v)
}

const MAX_DEPTH: usize = 512;

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn err(&self, what: &str) -> ParseError {
        ParseError {
            message: format!("{what} at position {}", self.i),
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn lit(&mut self, word: &[u8], v: Json) -> Result<Json, ParseError> {
        if self.s.get(self.i..self.i + word.len()) == Some(word) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(self.err("Unexpected token"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth > MAX_DEPTH {
            return Err(self.err("JSON nested too deeply"));
        }
        match self.peek() {
            Some(b'n') => self.lit(b"null", Json::Null),
            Some(b't') => self.lit(b"true", Json::Bool(true)),
            Some(b'f') => self.lit(b"false", Json::Bool(false)),
            Some(b'"') => Ok(Json::String(self.string()?)),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err("Unexpected token")),
            None => Err(self.err("Unexpected end of JSON input")),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.err("No number after minus sign in JSON")),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            if self.digits() == 0 {
                return Err(self.err("Unterminated fractional number in JSON"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return Err(self.err("Exponent part is missing a number in JSON"));
            }
        }
        let text =
            std::str::from_utf8(self.s.get(start..self.i).unwrap_or_default()).unwrap_or_default();
        // Rust's float parsing rounds correctly, as V8's does; an exponent past f64's range is ±Infinity in both.
        text.parse::<f64>()
            .map(Json::Number)
            .map_err(|_| self.err("Bad number"))
    }

    fn hex4(&mut self) -> Result<u32, ParseError> {
        let mut n = 0u32;
        for _ in 0..4 {
            let d = match self.peek() {
                Some(c @ b'0'..=b'9') => c - b'0',
                Some(c @ b'a'..=b'f') => c - b'a' + 10,
                Some(c @ b'A'..=b'F') => c - b'A' + 10,
                _ => return Err(self.err("Bad Unicode escape in JSON")),
            };
            n = n * 16 + u32::from(d);
            self.i += 1;
        }
        Ok(n)
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.i += 1; // the opening quote
        let mut out = String::new();
        loop {
            let start = self.i;
            while matches!(self.peek(), Some(c) if c != b'"' && c != b'\\' && c >= 0x20) {
                self.i += 1;
            }
            // The input is a &str, so any run between ASCII delimiters is whole UTF-8.
            out.push_str(
                std::str::from_utf8(self.s.get(start..self.i).unwrap_or_default())
                    .unwrap_or_default(),
            );
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = self
                        .peek()
                        .ok_or_else(|| self.err("Unterminated string in JSON"))?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi)
                                && self.s.get(self.i..self.i + 2) == Some(b"\\u".as_slice())
                            {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                                } else {
                                    self.i = save;
                                    hi
                                }
                            } else {
                                hi
                            };
                            // A lone surrogate is legal in JSON and in a JavaScript string, and has no Rust `char`:
                            // it reads as U+FFFD, one UTF-16 unit either way, so lengths still count the same.
                            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                        }
                        _ => return Err(self.err("Bad escaped character in JSON")),
                    }
                }
                Some(_) => return Err(self.err("Bad control character in string literal in JSON")),
                None => return Err(self.err("Unterminated string in JSON")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(self.err("Expected ',' or ']' after array element in JSON")),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, ParseError> {
        self.i += 1;
        let mut fields: Vec<(String, Json)> = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Json::Object(fields));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.err("Expected property name or '}' in JSON"));
            }
            let key = self.string()?;
            self.ws();
            if self.peek() != Some(b':') {
                return Err(self.err("Expected ':' after property name in JSON"));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            // A repeated key keeps its first place and takes the last value, as a JavaScript object does.
            match fields.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = v,
                None => fields.push((key, v)),
            }
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Object(js_key_order(fields)));
                }
                _ => return Err(self.err("Expected ',' or '}' after property value in JSON")),
            }
        }
    }
}

/// A key JavaScript treats as an array index: the canonical decimal form of an integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// JavaScript's own key order: array-index keys first, ascending, then every other key in the order it was added.
fn js_key_order(fields: Vec<(String, Json)>) -> Vec<(String, Json)> {
    let (mut indexed, rest): (Vec<_>, Vec<_>) = fields
        .into_iter()
        .partition(|(k, _)| array_index(k).is_some());
    indexed.sort_by_key(|(k, _)| array_index(k));
    indexed.extend(rest);
    indexed
}

/// A string as `JSON.stringify` writes it.
pub fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A number as JavaScript prints it, for the numbers this service writes: integers, and ±Infinity as `null`.
fn number(out: &mut String, n: f64) {
    if !n.is_finite() {
        out.push_str("null");
    } else if n.fract() == 0.0 && n.abs() < 1e21 {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "an integral value below 1e21 fits an i128 exactly"
        )]
        let i = n as i128;
        let _ = write!(out, "{i}");
    } else {
        // Not reached by any answer this service gives; Rust's shortest round-trip form matches V8's for plain decimals.
        let _ = write!(out, "{n}");
    }
}

fn newline(out: &mut String, indent: Option<usize>, level: usize) {
    if let Some(step) = indent {
        out.push('\n');
        for _ in 0..step * level {
            out.push(' ');
        }
    }
}

fn write_value(out: &mut String, v: &Json, indent: Option<usize>, level: usize) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(n) => number(out, *n),
        Json::String(s) => quote(out, s),
        Json::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push(']');
        }
        Json::Object(fields) => {
            if fields.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, item)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                quote(out, k);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_javascript_key_order_and_the_last_value_of_a_repeated_key() {
        let v = parse(r#"{"b":1,"2":2,"a":3,"1":4,"b":5,"01":6}"#).unwrap();
        assert_eq!(v.compact(), r#"{"1":4,"2":2,"b":5,"a":3,"01":6}"#);
    }

    #[test]
    fn writes_as_json_stringify_does() {
        let v = parse(r#"{"a":[],"b":{},"c":[1,"x\u0001\"\\/é"],"d":-840}"#).unwrap();
        assert_eq!(
            v.compact(),
            r#"{"a":[],"b":{},"c":[1,"x\u0001\"\\/é"],"d":-840}"#
        );
        assert_eq!(
            v.pretty(),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    \"x\\u0001\\\"\\\\/é\"\n  ],\n  \"d\": -840\n}"
        );
    }

    #[test]
    fn refuses_what_json_parse_refuses() {
        for bad in [
            "",
            "{bad",
            "[1,]",
            "01",
            "1.",
            "\"\u{1}\"",
            "{\"a\" 1}",
            "nul",
            "1 2",
        ] {
            assert!(parse(bad).is_err(), "{bad:?} parsed");
        }
        assert_eq!(parse("1e400").unwrap(), Json::Number(f64::INFINITY));
    }
}
