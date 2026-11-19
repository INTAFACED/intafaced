//! The checks zod 4 runs on svc-tax's inputs, with zod's own issues: same codes, same fields in the same order, same
//! messages. A refused input's wire message is `JSON.stringify(issues, null, 2)`, so every byte counts.
//!
//! Only the schema pieces svc-tax's records use are here (`packages/contracts/src/tax-procedures.ts`,
//! `tax-lot-book.ts`). `crates/svc-tax/tests/input_parity.rs` holds each against zod's own verdicts.

use crate::json::Json;
use crate::time;

/// One zod issue: its fields in zod's order, `path` and `message` last.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    fields: Vec<(&'static str, Json)>,
    path: Vec<String>,
    message: String,
}

impl Issue {
    fn new(fields: Vec<(&'static str, Json)>, path: &[String], message: String) -> Issue {
        Issue {
            fields,
            path: path.to_vec(),
            message,
        }
    }

    fn json(&self) -> Json {
        let mut out: Vec<(String, Json)> = self
            .fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect();
        out.push((
            "path".to_owned(),
            Json::Array(self.path.iter().map(Json::str).collect()),
        ));
        out.push(("message".to_owned(), Json::str(self.message.clone())));
        Json::Object(out)
    }
}

/// The message tRPC sends for a refused input: zod's `error.message`, the issues as pretty JSON.
pub fn message(issues: &[Issue]) -> String {
    Json::Array(issues.iter().map(Issue::json).collect()).pretty()
}

/// The issues so far, and where the value being checked sits.
pub struct Ctx {
    pub issues: Vec<Issue>,
}

/// zod's name for what it received.
fn received(v: Option<&Json>) -> &'static str {
    match v {
        None => "undefined",
        Some(Json::Null) => "null",
        Some(Json::Bool(_)) => "boolean",
        Some(Json::Number(_)) => "number",
        Some(Json::String(_)) => "string",
        Some(Json::Array(_)) => "array",
        Some(Json::Object(_)) => "object",
    }
}

impl Ctx {
    pub fn new() -> Ctx {
        Ctx { issues: Vec::new() }
    }

    fn invalid_type(&mut self, expected: &str, got: Option<&Json>, path: &[String]) {
        let got = received(got);
        self.issues.push(Issue::new(
            vec![
                ("expected", Json::str(expected)),
                ("code", Json::str("invalid_type")),
            ],
            path,
            format!("Invalid input: expected {expected}, received {got}"),
        ));
    }

    /// `z.string()`: the string, or an issue.
    pub fn string<'a>(&mut self, v: Option<&'a Json>, path: &[String]) -> Option<&'a str> {
        match v {
            Some(Json::String(s)) => Some(s),
            other => {
                self.invalid_type("string", other, path);
                None
            }
        }
    }

    /// `z.boolean()`.
    pub fn boolean(&mut self, v: Option<&Json>, path: &[String]) -> Option<bool> {
        match v {
            Some(Json::Bool(b)) => Some(*b),
            other => {
                self.invalid_type("boolean", other, path);
                None
            }
        }
    }

    /// `.min(n)` / `.max(n)` on a string: zod 4.6 counts Unicode code points, not UTF-16 units (an emoji is one).
    pub fn length(&mut self, s: &str, min: Option<i64>, max: Option<i64>, path: &[String]) {
        let len = i64::try_from(s.chars().count()).unwrap_or(i64::MAX);
        if let Some(min) = min.filter(|m| len < *m) {
            self.issues.push(Issue::new(
                vec![
                    ("origin", Json::str("string")),
                    ("code", Json::str("too_small")),
                    ("minimum", Json::int(min)),
                    ("inclusive", Json::Bool(true)),
                ],
                path,
                format!("Too small: expected string to have >={min} characters"),
            ));
        }
        if let Some(max) = max.filter(|m| len > *m) {
            self.issues.push(Issue::new(
                vec![
                    ("origin", Json::str("string")),
                    ("code", Json::str("too_big")),
                    ("maximum", Json::int(max)),
                    ("inclusive", Json::Bool(true)),
                ],
                path,
                format!("Too big: expected string to have <={max} characters"),
            ));
        }
    }

    /// `.regex(pattern)`, where `matches` is the pattern's test and `pattern` its source as zod prints it.
    pub fn regex(&mut self, ok: bool, pattern: &str, path: &[String]) {
        if !ok {
            self.issues.push(Issue::new(
                vec![
                    ("origin", Json::str("string")),
                    ("code", Json::str("invalid_format")),
                    ("format", Json::str("regex")),
                    ("pattern", Json::str(pattern)),
                ],
                path,
                format!("Invalid string: must match pattern {pattern}"),
            ));
        }
    }

    /// `.superRefine` adding `{ code: 'custom', path, message }`.
    pub fn custom(&mut self, ok: bool, path: &[String], message: String) {
        if !ok {
            self.issues.push(Issue::new(
                vec![("code", Json::str("custom"))],
                path,
                message,
            ));
        }
    }

    /// `.refine(...)` with no message.
    pub fn refine(&mut self, ok: bool, path: &[String]) {
        if !ok {
            self.issues.push(Issue::new(
                vec![("code", Json::str("custom"))],
                path,
                "Invalid input".to_owned(),
            ));
        }
    }

    /// `z.string().datetime({ offset: true })`: the moment, or an issue.
    pub fn datetime(&mut self, s: &str, path: &[String]) -> Option<time::Instant> {
        let at = time::zod_datetime(s, true);
        if at.is_none() {
            self.issues.push(Issue::new(
                vec![
                    ("origin", Json::str("string")),
                    ("code", Json::str("invalid_format")),
                    ("format", Json::str("datetime")),
                    ("pattern", Json::str(DATETIME_OFFSET_PATTERN)),
                ],
                path,
                "Invalid ISO datetime".to_owned(),
            ));
        }
        at
    }

    /// `z.enum(values)`: the value, or an issue naming every option.
    pub fn one_of<'a>(
        &mut self,
        v: Option<&'a Json>,
        values: &[&str],
        path: &[String],
    ) -> Option<&'a str> {
        if let Some(Json::String(s)) = v
            && values.contains(&s.as_str())
        {
            return Some(s);
        }
        let options = values
            .iter()
            .map(|o| format!("\"{o}\""))
            .collect::<Vec<_>>()
            .join("|");
        self.issues.push(Issue::new(
            vec![
                ("code", Json::str("invalid_value")),
                (
                    "values",
                    Json::Array(values.iter().map(|o| Json::str(*o)).collect()),
                ),
            ],
            path,
            format!("Invalid option: expected one of {options}"),
        ));
        None
    }

    /// `z.number().int().min(min).max(max)`: the integer, or issues. A non-finite number is refused as a type, a
    /// fraction as `int` (and nothing more is checked); a number past the safe range is named and still bounds-checked.
    pub fn int_between(
        &mut self,
        v: Option<&Json>,
        min: i64,
        max: i64,
        path: &[String],
    ) -> Option<i64> {
        let n = match v {
            Some(Json::Number(n)) if n.is_finite() => *n,
            Some(Json::Number(n)) => {
                let shown = if *n > 0.0 { "Infinity" } else { "-Infinity" };
                self.issues.push(Issue::new(
                    vec![
                        ("expected", Json::str("number")),
                        ("code", Json::str("invalid_type")),
                        ("received", Json::str(shown)),
                    ],
                    path,
                    format!("Invalid input: expected number, received {shown}"),
                ));
                return None;
            }
            other => {
                self.invalid_type("number", other, path);
                return None;
            }
        };
        if n.fract() != 0.0 {
            self.issues.push(Issue::new(
                vec![
                    ("expected", Json::str("int")),
                    ("format", Json::str("safeint")),
                    ("code", Json::str("invalid_type")),
                ],
                path,
                "Invalid input: expected int, received number".to_owned(),
            ));
            return None;
        }
        const SAFE: f64 = 9_007_199_254_740_991.0;
        const NEG_SAFE: f64 = -9_007_199_254_740_991.0;
        if n > SAFE {
            self.issues.push(Issue::new(
                vec![
                    ("code", Json::str("too_big")),
                    ("maximum", Json::int(9_007_199_254_740_991)),
                    (
                        "note",
                        Json::str("Integers must be within the safe integer range."),
                    ),
                    ("origin", Json::str("int")),
                    ("inclusive", Json::Bool(true)),
                ],
                path,
                "Too big: expected int to be <=9007199254740991".to_owned(),
            ));
        }
        if n < NEG_SAFE {
            self.issues.push(Issue::new(
                vec![
                    ("code", Json::str("too_small")),
                    ("minimum", Json::int(-9_007_199_254_740_991)),
                    (
                        "note",
                        Json::str("Integers must be within the safe integer range."),
                    ),
                    ("origin", Json::str("int")),
                    ("inclusive", Json::Bool(true)),
                ],
                path,
                "Too small: expected int to be >=-9007199254740991".to_owned(),
            ));
        }
        #[expect(
            clippy::cast_precision_loss,
            reason = "the bounds are small integers, exact in f64"
        )]
        let (lo, hi) = (min as f64, max as f64);
        if n < lo {
            self.issues.push(Issue::new(
                vec![
                    ("origin", Json::str("number")),
                    ("code", Json::str("too_small")),
                    ("minimum", Json::int(min)),
                    ("inclusive", Json::Bool(true)),
                ],
                path,
                format!("Too small: expected number to be >={min}"),
            ));
        }
        if n > hi {
            self.issues.push(Issue::new(
                vec![
                    ("origin", Json::str("number")),
                    ("code", Json::str("too_big")),
                    ("maximum", Json::int(max)),
                    ("inclusive", Json::Bool(true)),
                ],
                path,
                format!("Too big: expected number to be <={max}"),
            ));
        }
        // In range, so the cast is exact.
        #[expect(
            clippy::cast_possible_truncation,
            reason = "an integral value checked to lie within min..=max"
        )]
        let out = n as i64;
        (n >= lo && n <= hi).then_some(out)
    }

    /// An object's own checks: anything but a plain object is refused as a type.
    pub fn object<'a>(
        &mut self,
        v: Option<&'a Json>,
        path: &[String],
    ) -> Option<&'a [(String, Json)]> {
        match v {
            Some(Json::Object(fields)) => Some(fields),
            other => {
                self.invalid_type("object", other, path);
                None
            }
        }
    }

    /// `.strict()`: the keys the shape does not name, in the object's own order, after every field's issues.
    pub fn strict(&mut self, fields: &[(String, Json)], known: &[&str], path: &[String]) {
        let extra: Vec<&str> = fields
            .iter()
            .map(|(k, _)| k.as_str())
            .filter(|k| !known.contains(k))
            .collect();
        if extra.is_empty() {
            return;
        }
        let quoted = extra
            .iter()
            .map(|k| format!("\"{k}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let message = if extra.len() == 1 {
            format!("Unrecognized key: {quoted}")
        } else {
            format!("Unrecognized keys: {quoted}")
        };
        self.issues.push(Issue::new(
            vec![
                ("code", Json::str("unrecognized_keys")),
                (
                    "keys",
                    Json::Array(extra.iter().map(|k| Json::str(*k)).collect()),
                ),
            ],
            path,
            message,
        ));
    }
}

impl Default for Ctx {
    fn default() -> Self {
        Ctx::new()
    }
}

/// zod's source for `z.string().datetime({ offset: true })`, as it prints it in an issue.
pub const DATETIME_OFFSET_PATTERN: &str = r"/^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/";
