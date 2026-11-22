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
use svc_ledger::env;

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
            Ok(e) => {
                let urls = |m: BTreeMap<String, String>| {
                    Json::Object(m.into_iter().map(|(k, v)| (k, Json::String(v))).collect())
                };
                Json::Object(vec![(
                    "ok".to_owned(),
                    Json::Object(vec![
                        ("env".to_owned(), e.json),
                        (
                            "clockSkewBoundMs".to_owned(),
                            e.clock_skew_bound_ms.map_or(Json::Null, Json::int),
                        ),
                        (
                            "idempotencyConflictMode".to_owned(),
                            Json::str(e.idempotency_conflict_mode),
                        ),
                        ("railStatementUrls".to_owned(), urls(e.rail_statement_urls)),
                        ("openItemsUrls".to_owned(), urls(e.open_items_urls)),
                    ]),
                )])
            }
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
