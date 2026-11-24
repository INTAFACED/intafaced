//! Every refusal svc-tax sends is one its record lists, with the status the record gives it; and every refusal a record
//! lists is produced by some recorded answer, or is named in `fixtures/refusals-unproduced.json`, a list that only
//! shrinks. The TypeScript service held the same two rules over its own test run (`PROCEDURE_REFUSALS_STRICT` and
//! `@intafaced/contracts/procedure-refusal-coverage`).
//!
//! What is produced is read from the recorded answers the Rust service is held to byte for byte: the service parity
//! corpus (`service_parity.rs`) and the wire replay (`wire_replay.rs`). The records are the contracts' published schema
//! (`packages/contracts/procedures/svc-tax.schema.json`), so a refusal added to a record shows here at once.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::{BTreeMap, BTreeSet};

use svc_tax::json::{self, Json};

const SCHEMA: &str = include_str!("../../../packages/contracts/procedures/svc-tax.schema.json");
const WIRE: &str = include_str!("fixtures/wire-replay.golden.json");
const CEILING: &str = include_str!("fixtures/refusals-unproduced.json");
const PARITY_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/service-parity");
/// How every svc-tax refusal is sent (`wire.rs`): PRECONDITION_FAILED, the code leading the message.
const SENT_AS: &str = "PRECONDITION_FAILED";

fn text(v: &Json) -> &str {
    match v {
        Json::String(s) => s,
        other => panic!("not a string: {other:?}"),
    }
}

fn fields(v: &Json) -> &[(String, Json)] {
    match v {
        Json::Object(f) => f,
        other => panic!("not an object: {other:?}"),
    }
}

fn items(v: &Json) -> &[Json] {
    match v {
        Json::Array(a) => a,
        other => panic!("not an array: {other:?}"),
    }
}

/// `<record> <code>` → the status the record gives it, for every svc-tax record.
fn listed() -> BTreeMap<String, String> {
    let schema = json::parse(SCHEMA).unwrap();
    let procedures = schema.get("procedures").unwrap();
    // Keyed by record name.
    let records = fields(procedures);
    let mut out = BTreeMap::new();
    for (name, r) in records {
        if text(r.get("service").unwrap()) != "svc-tax" {
            continue;
        }
        for (code, status) in fields(r.get("refusals").unwrap()) {
            out.insert(format!("{name} {code}"), text(status).to_owned());
        }
    }
    assert!(
        out.len() > 40,
        "read too few svc-tax refusals from the schema: {}",
        out.len()
    );
    out
}

/// The record a parity call is made on (`service-parity.record.test.ts`'s `op`).
fn record_of_op(op: &str) -> String {
    match op {
        "basisOverrideSet" => "tax.basisOverride.set".to_owned(),
        "basisOverrideRemove" => "tax.basisOverride.remove".to_owned(),
        other => format!("tax.{other}"),
    }
}

/// `<record> <code>` for every refusal in the recorded answers.
fn produced() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut paths: Vec<_> = std::fs::read_dir(PARITY_DIR)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    paths.sort();
    for path in paths {
        for line in std::fs::read_to_string(&path).unwrap().lines() {
            let scenario = json::parse(line).unwrap();
            let (Some(calls), Some(results)) = (scenario.get("calls"), scenario.get("results"))
            else {
                continue;
            };
            for (call, result) in items(calls).iter().zip(items(results)) {
                if let Some(refused) = result.get("refused") {
                    let op = text(call.get("op").unwrap());
                    out.insert(format!(
                        "{} {}",
                        record_of_op(op),
                        text(refused.get("code").unwrap())
                    ));
                }
            }
        }
    }
    // The wire replay: a refusal is a 412 whose message leads with its code (`tax.x — why`). Keys are
    // `<map> <path> <input> <caller>`.
    let wire = json::parse(WIRE).unwrap();
    for (key, answer) in fields(wire.get("answers").unwrap()) {
        if answer.get("status") != Some(&Json::Number(412.0)) {
            continue;
        }
        let path = key.split(' ').nth(1).unwrap();
        let body = text(answer.get("body").unwrap());
        let message = body.split("\"message\":\"").nth(1).unwrap();
        let code = message.split(" — ").next().unwrap();
        out.insert(format!("tax.{path} {code}"));
    }
    assert!(
        out.len() > 30,
        "read too few refusals from the recorded answers: {}",
        out.len()
    );
    out
}

fn ceiling() -> BTreeSet<String> {
    let file = json::parse(CEILING).unwrap();
    items(file.get("unproduced").unwrap())
        .iter()
        .map(|v| text(v).to_owned())
        .collect()
}

#[test]
fn every_refusal_sent_is_one_its_record_lists_with_that_status() {
    let listed = listed();
    let unlisted: Vec<_> = produced()
        .into_iter()
        .filter(|pair| listed.get(pair).map(String::as_str) != Some(SENT_AS))
        .collect();
    assert!(
        unlisted.is_empty(),
        "refusals sent that their record does not list as {SENT_AS}: {unlisted:?}"
    );
}

#[test]
fn every_listed_refusal_is_produced_or_named_unproduced_and_the_list_only_shrinks() {
    let (listed, produced, ceiling) = (listed(), produced(), ceiling());
    let missing: Vec<_> = listed
        .keys()
        .filter(|pair| !produced.contains(*pair) && !ceiling.contains(*pair))
        .collect();
    assert!(
        missing.is_empty(),
        "listed refusals no recorded answer produces (add a scenario that does): {missing:?}"
    );
    let now_produced: Vec<_> = ceiling
        .iter()
        .filter(|pair| produced.contains(*pair))
        .collect();
    assert!(
        now_produced.is_empty(),
        "now produced, delete from fixtures/refusals-unproduced.json: {now_produced:?}"
    );
    let stale: Vec<_> = ceiling
        .iter()
        .filter(|pair| !listed.contains_key(*pair))
        .collect();
    assert!(
        stale.is_empty(),
        "fixtures/refusals-unproduced.json names refusals no record lists: {stale:?}"
    );
}
