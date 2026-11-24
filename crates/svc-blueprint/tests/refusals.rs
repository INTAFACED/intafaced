//! The refusal catalogue against what the TypeScript router sent (`fixtures/refusals.golden.json`, recorded by
//! `scripts/record-door.mjs`): every `BlueprintError` and `AttestationSurfaceError` code, an error with a code of its
//! own and a plain one, each thrown from `card` (refusals mapped by `toTrpcError`) and from `me` (sent as tRPC sends an
//! unknown error). The codes are the same both ways, and every answer is the same byte for byte.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeSet;

use service_kit::json::{self, Json};
use service_kit::trpc;
use svc_blueprint::door;
use svc_blueprint::errors::{ATTESTATION_CODES, BLUEPRINT_CODES, Refusal};

const GOLDEN: &str = include_str!("fixtures/refusals.golden.json");

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Number(n)) => format!("{n}"),
        other => panic!("{key}: {other:?}"),
    }
}

#[test]
fn every_refusal_is_answered_as_the_typescript_router_answered_it() {
    let golden = json::parse(GOLDEN).unwrap();
    let Some(Json::Array(rows)) = golden.get("refusals") else {
        panic!("no refusals")
    };
    let mut seen: [BTreeSet<String>; 2] = [BTreeSet::new(), BTreeSet::new()];
    let mut wrong = Vec::new();
    for row in rows {
        let (kind, code, via) = (text(row, "kind"), text(row, "code"), text(row, "via"));
        let refusal = match kind.as_str() {
            "blueprint" => {
                seen[0].insert(code.clone());
                Refusal::blueprint(&code, format!("replay: {code}"))
                    .unwrap_or_else(|| panic!("{code} is not in the catalogue"))
            }
            "attestation" => {
                seen[1].insert(code.clone());
                Refusal::attestation(&code, format!("replay: {code}"))
                    .unwrap_or_else(|| panic!("{code} is not in the catalogue"))
            }
            "coded" => Refusal::Other {
                message: "replay: a coded failure".to_owned(),
                code: Some(code.clone()),
            },
            "plain" => Refusal::Other {
                message: "replay: an unexpected failure".to_owned(),
                code: None,
            },
            other => panic!("an unknown kind {other}"),
        };
        let call = door::call(&via).unwrap();
        let e = if call.mapped {
            refusal.mapped()
        } else {
            refusal.unmapped()
        };
        let res = trpc::render(&e, &via, "replay-request", "svc-blueprint", false);
        let (want, got) = (
            format!("{} {}", text(row, "status"), text(row, "body")),
            format!("{} {}", res.status, res.body),
        );
        if want != got {
            wrong.push(format!(
                "{kind} {code} via {via}\n  ts:   {want}\n  rust: {got}"
            ));
        }
    }
    let ours: BTreeSet<String> = BLUEPRINT_CODES
        .iter()
        .map(|(c, _)| (*c).to_owned())
        .collect();
    assert_eq!(
        ours, seen[0],
        "BLUEPRINT_CODES is not BlueprintError's codes"
    );
    let ours: BTreeSet<String> = ATTESTATION_CODES.iter().map(|c| (*c).to_owned()).collect();
    assert_eq!(
        ours, seen[1],
        "ATTESTATION_CODES is not AttestationSurfaceError's codes"
    );
    assert!(
        wrong.is_empty(),
        "{} of {} answers differ:\n{}",
        wrong.len(),
        rows.len(),
        wrong.join("\n")
    );
}
