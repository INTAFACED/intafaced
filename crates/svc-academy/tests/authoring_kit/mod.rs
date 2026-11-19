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

pub const SECRET: &str = "an-academy-authoring-test-edge-secret-long";

/// The door over a database, with the test process's switches (`curriculum_release.rs`'s `door`).
pub fn door(db: &TestDb, settings: svc_academy::settings::Settings, ports: svc_academy::ports::Ports) -> svc_academy::door::AcademyDoor {
    svc_academy::door::AcademyDoor::new(svc_academy::door::DoorConfig {
        edge_secret: SECRET.to_owned(),
        env: [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect(),
        store: Store::Pool(db.pool()),
        ports,
        settings,
        now: svc_academy::door::system_now,
    })
    .unwrap()
}

fn encode(input: &Json) -> String {
    input
        .compact()
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// A signed principal's headers.
pub fn principal(user: &str, scopes: &[&str], tier: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        ("scopes", Json::Array(scopes.iter().map(|s| Json::str(*s)).collect())),
        ("tier", Json::str(tier)),
        ("mfa", Json::Bool(false)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    vec![
        ("x-intafaced-principal-sig".to_owned(), service_kit::edge::sign(&raw, SECRET, "DE").unwrap()),
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

/// `GET /trpc/<path>?input=...` with these headers: the status and the parsed body.
pub fn query(door: &svc_academy::door::AcademyDoor, headers: &[(String, String)], path: &str, input: Option<&Json>) -> (u16, Json) {
    let url = match input {
        Some(i) => format!("/trpc/{path}?input={}", encode(i)),
        None => format!("/trpc/{path}"),
    };
    let res = door.handle(&service_kit::server::Request { method: "GET", url: &url, headers, body: "" });
    (res.status, json::parse(&res.body).unwrap())
}

/// A visitor (no principal) asking a public call.
pub fn visitor(door: &svc_academy::door::AcademyDoor, path: &str, input: Option<&Json>) -> (u16, Json) {
    query(door, &[("x-intafaced-region".to_owned(), "DE".to_owned())], path, input)
}

pub fn data(answer: &(u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer.1.get("result").and_then(|r| r.get("data")).cloned().unwrap_or(Json::Null)
}

/// The refusal's tRPC status and academy code (`data.academyCode` or the message's prefix).
pub fn refused(answer: &(u16, Json)) -> (u16, String) {
    let body = answer.1.compact();
    let code = answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("academyCode").or_else(|| d.get("code")))
        .map_or_else(|| body.clone(), |c| match c {
            Json::String(s) => s.clone(),
            other => other.compact(),
        });
    (answer.0, code)
}
