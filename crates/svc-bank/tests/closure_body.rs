//! `parseClosureCheckBody` (`services/svc-bank/src/closure/closure-check.ts`) against its own answers on a set of bodies
//! (`tests/fixtures/closure-body.golden.json`, recorded by `scripts/record-door.mjs`): the Rust door accepts exactly the
//! bodies it accepts.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test"
)]

use service_kit::json::{self, Json};
use service_kit::schema::Value;
use svc_bank::door::rest::closure_body_ok;

#[test]
fn the_closure_check_reads_a_body_as_the_typescript_does() {
    let golden = json::parse(include_str!("fixtures/closure-body.golden.json")).unwrap();
    let Some(Json::Array(cases)) = golden.get("cases") else {
        panic!()
    };
    let mut wrong = Vec::new();
    for case in cases {
        let Json::Array(c) = case else { panic!() };
        let body = match &c[0] {
            Json::Null => Value::Undefined,
            Json::String(t) => Value::from_json(&json::parse(t).unwrap()),
            _ => panic!(),
        };
        let Json::Bool(want) = c[1] else { panic!() };
        if closure_body_ok(&body) != want {
            wrong.push(c[0].compact());
        }
    }
    println!("{} bodies; {} differ", cases.len(), wrong.len());
    assert!(
        wrong.is_empty(),
        "these bodies are read differently: {wrong:?}"
    );
}
