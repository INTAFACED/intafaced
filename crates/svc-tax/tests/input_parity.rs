//! Input parity: each svc-tax input check gives zod's own verdict. `services/svc-tax/src/input-parity.golden.json` holds
//! zod's answer to each case (`input-parity.test.ts` holds zod to it); the Rust check must accept what zod accepts and
//! refuse the rest with the same message, byte for byte.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use svc_tax::inputs;
use svc_tax::json::{self, Json};
use svc_tax::zod::{self, Issue};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/input-parity.golden.json"
);

fn verdict<T>(r: Result<T, Vec<Issue>>) -> String {
    match r {
        Ok(_) => "ok".to_owned(),
        Err(issues) => zod::message(&issues),
    }
}

fn check(path: &str, input: Option<&Json>) -> String {
    match path {
        "lotBook" | "missingBasis" => verdict(inputs::lot_book(input)),
        "pnlOverTime" => verdict(inputs::pnl_over_time(input)),
        "basisOverride.set" => verdict(inputs::basis_override_set(input)),
        "basisOverride.remove" => verdict(inputs::basis_override_remove(input)),
        "setLotMethod" => verdict(inputs::set_lot_method(input)),
        "setDayMethod" => verdict(inputs::set_day_method(input)),
        "pickSaleLot" => verdict(inputs::pick_sale_lot(input)),
        "setIncludeTransfers" => verdict(inputs::set_include_transfers(input)),
        "exportPreview" | "exportPack" => verdict(inputs::export(input)),
        other => panic!("no input check for {other}"),
    }
}

#[test]
fn every_input_check_gives_zods_verdict() {
    let Json::Array(cases) = json::parse(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap() else {
        panic!("{GOLDEN}")
    };
    assert!(cases.len() >= 90, "the case set shrank: {}", cases.len());
    let mut diffs = Vec::new();
    for case in &cases {
        let (Some(Json::String(path)), Some(Json::String(expected))) =
            (case.get("path"), case.get("verdict"))
        else {
            panic!("malformed case {}", case.compact())
        };
        let input = match case.get("input") {
            Some(Json::String(text)) => Some(json::parse(text).unwrap()),
            _ => None,
        };
        let got = check(path, input.as_ref());
        if &got != expected {
            diffs.push(format!(
                "{path} {}:\n  zod:  {expected}\n  rust: {got}",
                case.get("input").unwrap().compact()
            ));
        }
    }
    assert!(
        diffs.is_empty(),
        "{} of {} differ:\n{}",
        diffs.len(),
        cases.len(),
        diffs.join("\n")
    );
}
