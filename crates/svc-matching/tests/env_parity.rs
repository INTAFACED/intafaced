//! The environment against `env.ts`'s own answers: `fixtures/env-parity.golden.json` holds what the TypeScript
//! loaded (or refused) for each environment `scripts/record-door.mjs` set.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use service_kit::json::{self, Json};
use svc_matching::env;

const GOLDEN: &str = include_str!("fixtures/env-parity.golden.json");

#[test]
fn every_environment_loads_as_the_typescript_loads_it() {
    let golden = json::parse(GOLDEN).unwrap();
    let Some(Json::Array(cases)) = golden.get("cases") else {
        panic!("no cases")
    };
    let mut differ = Vec::new();
    for case in cases {
        let Some(Json::Object(vars)) = case.get("env") else {
            panic!("env")
        };
        let source: BTreeMap<String, String> = vars
            .iter()
            .map(|(k, v)| match v {
                Json::String(s) => (k.clone(), s.clone()),
                _ => panic!("a variable is text"),
            })
            .collect();
        let got = match env::load(&source) {
            Ok(e) => Json::Object(vec![(
                "ok".to_owned(),
                Json::Object(vec![("env".to_owned(), e.json)]),
            )]),
            Err(e) => Json::Object(vec![("refused".to_owned(), Json::str(e.message))]),
        };
        let want = case.get("answer").unwrap();
        if &got != want {
            differ.push(format!(
                "{}\n  want {}\n  got  {}",
                Json::Object(vars.clone()).compact(),
                want.compact(),
                got.compact()
            ));
        }
    }
    println!("{} environments; {} differ", cases.len(), differ.len());
    assert!(differ.is_empty(), "{}", differ.join("\n\n"));
}
