//! The `reports` slice's five doors against the TypeScript's own answers: `fixtures/reports.golden.json` holds what
//! each handler answered on the wire (`httpError` on what it threw) to inputs `scripts/record-door.mjs` made to reach
//! each of its branches, with `Date.now()` held at the recording's `nowMs` and a book with no balances. The Rust door's
//! input check and `svc_ledger::reports` must answer each byte for byte.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use service_kit::json::{self, Json};
use service_kit::schema::{self, Outcome, Value};
use svc_ledger::door;
use svc_ledger::errors::{self, Failure};
use svc_ledger::reports;

const GOLDEN: &str = include_str!("fixtures/reports.golden.json");

fn wire(door_name: &str, text: Option<&str>, now_ms: i64) -> (u16, String) {
    let value = text.map_or(Value::Undefined, |t| {
        Value::from_json(&json::parse(t).unwrap())
    });
    let (status, body) = match door::parse(door_name, value) {
        Ok(Outcome::Ok(input)) => {
            match reports::answer(door_name, &input, now_ms, &|_: &str, _: &str| Ok(())) {
                Ok(body) => (200, body),
                Err(failure) => errors::http_error(&failure),
            }
        }
        Ok(Outcome::Issues(issues)) => errors::http_error(&Failure::Zod(schema::message(&issues))),
        Err(_) => errors::http_error(&Failure::Fault),
    };
    (status, body.compact())
}

#[test]
fn every_report_door_answers_as_the_typescript() {
    let golden = json::parse(GOLDEN).unwrap();
    let Some(Json::Number(now)) = golden.get("nowMs") else {
        panic!("no nowMs")
    };
    let now_ms = format!("{now}").parse::<i64>().unwrap();
    let Some(Json::Array(cases)) = golden.get("cases") else {
        panic!("no cases")
    };
    let mut per_door: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut differ = Vec::new();
    for case in cases {
        let Json::Array(c) = case else {
            panic!("a case is a list")
        };
        let (Json::String(name), Json::Number(status), Json::String(body)) = (&c[0], &c[2], &c[3])
        else {
            panic!("a case: door, input, status, body")
        };
        let text = match &c[1] {
            Json::String(t) => Some(t.as_str()),
            _ => None,
        };
        let want = (format!("{status}").parse::<u16>().unwrap(), body.clone());
        let got = wire(name, text, now_ms);
        let tally = per_door.entry(name.clone()).or_default();
        tally.0 += 1;
        if got != want {
            tally.1 += 1;
            differ.push(format!(
                "{name} {}\n  want {} {}\n  got  {} {}",
                text.unwrap_or("undefined"),
                want.0,
                want.1,
                got.0,
                got.1
            ));
        }
    }
    for (name, (n, bad)) in &per_door {
        println!("{name}: {n} answers, {bad} differ");
    }
    assert_eq!(
        per_door.len(),
        reports::DOORS.len(),
        "every report door is recorded"
    );
    assert!(
        differ.is_empty(),
        "{} of {} differ:\n{}",
        differ.len(),
        cases.len(),
        differ
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Past `i128` the TypeScript's bigint answers a figure; the port refuses as its own fault rather than answer a
/// wrapped or saturated one. Two lots at the column's largest amount is the smallest such case.
#[test]
fn a_sum_past_i128_is_refused_not_wrapped() {
    let max = "99999999999999999999.999999999999999999";
    let body = format!(
        r#"{{"ownerType":"user","ownerId":"o","reportingAssetId":"USD","lots":{{"closed":[{{"assetId":"A","costBasis":"0","proceeds":"{max}"}},{{"assetId":"B","costBasis":"0","proceeds":"{max}"}}],"open":[]}},"navInputs":{{"cashReporting":"0"}}}}"#
    );
    assert_eq!(
        wire("statementPnl", Some(&body), 0),
        (500, r#"{"message":"Ledger request failed"}"#.to_owned())
    );
}
