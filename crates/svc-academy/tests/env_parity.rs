//! The Academy's environment against the TypeScript's own answers (`tests/fixtures/env-parity.golden.json`, recorded
//! by `scripts/record-door.mjs` running `services/svc-academy/src/env.ts` once per case in a fresh process): the same
//! loaded values, key for key and in the same order, or the same refusal, word for word.
#![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]

use std::collections::BTreeMap;

use service_kit::json::{self, Json};

#[test]
fn every_environment_loads_or_refuses_as_the_typescript_does() {
    let golden = json::parse(include_str!("fixtures/env-parity.golden.json")).unwrap();
    let Some(Json::Array(cases)) = golden.get("cases") else {
        panic!()
    };
    let mut wrong = Vec::new();
    for case in cases {
        let Some(Json::Object(vars)) = case.get("env") else {
            panic!()
        };
        let source: BTreeMap<String, String> = vars
            .iter()
            .map(|(k, v)| match v {
                Json::String(s) => (k.clone(), s.clone()),
                _ => panic!("a variable is a string"),
            })
            .collect();
        let want = case.get("answer").unwrap().compact();
        let got = match svc_academy::env::load(&source) {
            Ok(env) => Json::obj([("ok", env.json)]).compact(),
            Err(e) => Json::obj([("refused", Json::str(e.message))]).compact(),
        };
        if got != want {
            wrong.push(format!(
                "{}\n  ts:   {want}\n  rust: {got}",
                Json::Object(vars.clone()).compact()
            ));
        }
    }
    for w in &wrong {
        println!("{w}");
    }
    assert!(
        wrong.is_empty(),
        "{} of {} environments differ",
        wrong.len(),
        cases.len()
    );
}
