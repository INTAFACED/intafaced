//! What the authoring tests share: a migrated Postgres per test as a [`Store`], inputs written as JSON, and reads of the
//! answers and refusals.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

#[path = "../support/mod.rs"]
mod support;

pub use support::TestDb;

use service_kit::json::{self, Json};
use service_kit::schema::Value;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

/// A fresh migrated database and the store over it; None without Postgres (and `REQUIRE_POSTGRES` unset).
pub fn store() -> Option<(TestDb, Store)> {
    let db = TestDb::migrated()?;
    let store = Store::Pool(db.pool());
    Some((db, store))
}

/// An input as the TypeScript test passes it to the class (no schema in front).
pub fn v(text: &str) -> Value {
    Value::from_json(&json::parse(text).expect("the test's JSON parses"))
}

pub fn at(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

pub fn iso(ms: i64) -> String {
    service_kit::time::Instant(ms).iso()
}

/// The refusal's code (`rejects.toMatchObject({ code })`).
pub fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.code,
        other => panic!("expected an academy refusal, got {other:?}"),
    }
}

pub fn message<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.message,
        Err(other) => format!("{other:?}"),
        Ok(v) => panic!("expected a refusal, got {v:?}"),
    }
}

/// A field by a dotted path (`course.revision`, `outline.0.title`).
pub fn at_path<'a>(j: &'a Json, path: &str) -> &'a Json {
    let mut cur = j;
    for part in path.split('.') {
        cur = match (cur, part.parse::<usize>()) {
            (Json::Array(a), Ok(i)) => a.get(i).unwrap_or_else(|| panic!("no index {part} in {}", cur.compact())),
            _ => cur.get(part).unwrap_or_else(|| panic!("no field {part} in {}", cur.compact())),
        };
    }
    cur
}

pub fn s(j: &Json, path: &str) -> String {
    match at_path(j, path) {
        Json::String(t) => t.clone(),
        other => panic!("{path} is not a string: {}", other.compact()),
    }
}

pub fn n(j: &Json, path: &str) -> i64 {
    match at_path(j, path) {
        Json::Number(x) => format!("{x}").parse().unwrap(),
        other => panic!("{path} is not a number: {}", other.compact()),
    }
}

pub fn len(j: &Json, path: &str) -> usize {
    match if path.is_empty() { j } else { at_path(j, path) } {
        Json::Array(a) => a.len(),
        other => panic!("{path} is not an array: {}", other.compact()),
    }
}

pub fn is_null(j: &Json, path: &str) -> bool {
    matches!(at_path(j, path), Json::Null)
}

/// `toMatchObject`: every field of `expected` (JSON) is in `actual` with the same value, recursively for objects.
pub fn matches(actual: &Json, expected: &str) {
    let want = json::parse(expected).unwrap();
    fn check(a: &Json, w: &Json, path: &str) {
        match (a, w) {
            (Json::Object(_), Json::Object(fields)) => {
                for (k, wv) in fields {
                    let av = a.get(k).unwrap_or_else(|| panic!("{path}.{k} missing in {}", a.compact()));
                    check(av, wv, &format!("{path}.{k}"));
                }
            }
            _ => assert_eq!(a.compact(), w.compact(), "at {path}"),
        }
    }
    check(actual, &want, "");
}

/// Objects with their keys sorted, so two answers compare as `toEqual` compares them.
pub fn norm(j: &Json) -> Json {
    match j {
        Json::Object(fields) => {
            let mut f: Vec<(String, Json)> = fields.iter().map(|(k, v)| (k.clone(), norm(v))).collect();
            f.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(f)
        }
        Json::Array(a) => Json::Array(a.iter().map(norm).collect()),
        other => other.clone(),
    }
}

/// `toEqual` against JSON text.
pub fn equals(actual: &Json, expected: &str) {
    let want = json::parse(expected).unwrap();
    assert_eq!(norm(actual).compact(), norm(&want).compact());
}

/// `toEqual` between two answers.
pub fn same(a: &Json, b: &Json) {
    assert_eq!(norm(a).compact(), norm(b).compact());
}
