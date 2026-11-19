//! `services/svc-tax/src/procedure-samples.test.ts`: the mounted side of each svc-tax record's samples. Sent through
//! the door by a caller the record admits, a refused sample is answered 400 and an accepted one never is. The samples
//! are read from the contracts' published schema (`packages/contracts/procedures.schema.json`), so a sample added to a
//! record reaches this test without an edit here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::Arc;

use common::fake::{self, FakeLedger};
use common::{date, door, text};
use svc_tax::json::{self, Json};
use svc_tax::tax::TaxDeps;

const SCHEMA: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/contracts/procedures.schema.json"
);
const USER: &str = "11111111-1111-4111-8111-111111111111";

#[test]
fn each_record_sample_reaches_its_verdict_at_the_door() {
    let schema = json::parse(&std::fs::read_to_string(SCHEMA).unwrap()).unwrap();
    let Some(Json::Object(procedures)) = schema.get("procedures") else {
        panic!("no procedures");
    };
    let wire = door::serve(fake::service(TaxDeps::new(
        r#"["DE"]"#,
        Arc::new(FakeLedger::default()),
        Some(10),
        Box::new(|| date("2026-01-02T00:00:00.000Z")),
    )));
    let headers = door::signed(USER, &["tax:read", "tax:write"], "DE");
    let mut checked = 0;
    for (name, record) in procedures {
        if text(record, "service").as_deref() != Some("svc-tax") {
            continue;
        }
        assert_eq!(text(record, "transport").as_deref(), Some("trpc"), "{name}");
        let path = text(record, "path").unwrap();
        let query = text(record, "kind").as_deref() == Some("query");
        let Some(Json::Array(samples)) = record.get("samples") else {
            panic!("{name} has no samples");
        };
        for (i, sample) in samples.iter().enumerate() {
            let input = sample.get("input").map(Json::compact);
            let res = if query {
                door::query(&wire, &headers, &path, input.as_deref())
            } else {
                door::mutate(&wire, &headers, &path, input.as_deref().unwrap_or(""))
            };
            let refuse = text(sample, "verdict").as_deref() == Some("refuse");
            let label = format!("{name} #{i} {}", input.unwrap_or_default());
            if refuse {
                assert_eq!(res.status, 400, "{label}: {}", res.body);
            } else {
                assert_ne!(res.status, 400, "{label}: {}", res.body);
            }
            checked += 1;
        }
    }
    assert!(checked >= 24, "{checked} samples");
    println!("procedure samples: {checked} checked at the door");
}
