//! A journal record as the TypeScript holds it: the object `JSON.parse` gave back, or the command an engine call built,
//! with its `seq`. The TypeScript reads a record off disk with a cast and no check, so a record here is the JSON value
//! itself and every reader asks it for a field as JavaScript would (`record.order.qty`). The few JavaScript rules those
//! reads lean on (`undefined` against `null`, truthiness, `===`) live here once.

use service_kit::json::{Json, js_number_string};

/// What an engine call asks the journal to keep: one input, before the book moves (`JournalCommand` in
/// `journal-codec.ts`). Its `kind` names it; the journal gives it its `seq`.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalCommand(pub Json);

/// One input the journal holds, with its position (`JournalRecord`).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalRecord(pub Json);

impl JournalCommand {
    /// `{ ...command, seq }`: the command's own keys in their order, `seq` replacing the value of a `seq` it already
    /// had or appended last. A command that is not an object spreads nothing.
    pub fn with_seq(&self, seq: usize) -> JournalRecord {
        let seq = Json::int(i64::try_from(seq).unwrap_or(i64::MAX));
        let mut fields = match &self.0 {
            Json::Object(fields) => fields.clone(),
            _ => Vec::new(),
        };
        match fields.iter_mut().find(|(k, _)| k == "seq") {
            Some((_, v)) => *v = seq,
            None => fields.push(("seq".to_owned(), seq)),
        }
        JournalRecord(Json::Object(fields))
    }
}

impl JournalRecord {
    /// `record[key]`: `None` is JavaScript's `undefined`.
    pub fn field(&self, key: &str) -> Option<&Json> {
        prop(Some(&self.0), key)
    }

    /// `record.kind` when it is a string.
    pub fn kind(&self) -> Option<&str> {
        match self.field("kind") {
            Some(Json::String(kind)) => Some(kind),
            _ => None,
        }
    }

    /// `record.seq` when it is a whole number, as every record the journal appended carries.
    pub fn seq(&self) -> Option<i64> {
        self.field("seq").and_then(whole)
    }
}

/// `value[key]` on a value JavaScript can read a property of: `None` for `undefined`. A string, number, boolean or
/// array has none of the keys a journal names, so it reads as `undefined` there too.
pub fn prop<'a>(value: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    match value {
        Some(Json::Object(fields)) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// JavaScript's truthiness of a read: `undefined`, `null`, `false`, `0` and `""` are false.
pub fn truthy(value: Option<&Json>) -> bool {
    match value {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(Json::String(s)) => !s.is_empty(),
        Some(Json::Array(_) | Json::Object(_)) => true,
    }
}

/// `value === true`.
pub fn is_true(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Bool(true)))
}

/// `value == null`: `undefined` or `null`.
pub fn nullish(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::Null))
}

/// `value === text`.
pub fn is_str(value: Option<&Json>, text: &str) -> bool {
    matches!(value, Some(Json::String(s)) if s == text)
}

/// A JSON number that is a whole number inside the range JavaScript counts exactly.
pub fn whole(value: &Json) -> Option<i64> {
    const EXACT: f64 = 9_007_199_254_740_992.0;
    match value {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "a whole number below 2^53 converts exactly"
        )]
        Json::Number(n) if n.fract() == 0.0 && n.abs() < EXACT => Some(*n as i64),
        _ => None,
    }
}

/// `String(value)` for the primitives a journal holds (a message names a seq or a kind with it).
pub fn js_string(value: Option<&Json>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Json::Null) => "null".to_owned(),
        Some(Json::Bool(b)) => b.to_string(),
        Some(Json::Number(n)) => js_number_string(*n),
        Some(Json::String(s)) => s.clone(),
        Some(Json::Array(items)) => items
            .iter()
            .map(|item| match item {
                Json::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Json::Object(_)) => "[object Object]".to_owned(),
    }
}
