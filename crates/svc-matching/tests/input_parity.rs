//! Each door's input schema against zod's own verdicts: `fixtures/input-parity.golden.json` holds what the
//! TypeScript schema answered (its output, or its issues) to inputs `scripts/record-door.mjs` made for each door.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::schema::{Outcome, Value, issues_json};
use svc_matching::door;

const GOLDEN: &str = include_str!("fixtures/input-parity.golden.json");

fn verdict(name: &str, text: Option<&str>) -> String {
    let value = text.map_or(Value::Undefined, |t| {
        Value::from_json(&json::parse(t).unwrap())
    });
    match door::parse(name, value) {
        Ok(Outcome::Ok(out)) => {
            let out = out
                .to_json()
                .map_or_else(|| "undefined".to_owned(), |j| j.compact());
            if Some(out.as_str()) == text {
                "ok =".to_owned()
            } else {
                format!("ok {out}")
            }
        }
        Ok(Outcome::Issues(issues)) => format!("issues {}", issues_json(&issues).compact()),
        Err(thrown) => format!("throws {thrown}"),
    }
}

#[test]
fn every_door_input_answers_as_zod() {
    let golden = json::parse(GOLDEN).unwrap();
    let Some(Json::Array(verdicts)) = golden.get("verdicts") else {
        panic!("no verdicts")
    };
    let Some(Json::Array(cases)) = golden.get("cases") else {
        panic!("no cases")
    };
    let mut differ = Vec::new();
    for case in cases {
        let Json::Array(c) = case else {
            panic!("a case is a list")
        };
        let (Json::String(name), Json::Number(i)) = (&c[0], &c[2]) else {
            panic!("a case: door, input, verdict")
        };
        let text = match &c[1] {
            Json::String(t) => Some(t.as_str()),
            _ => None,
        };
        let Json::String(want) = &verdicts[format!("{i}").parse::<usize>().unwrap()] else {
            panic!("a verdict is text")
        };
        let got = verdict(name, text);
        if &got != want {
            differ.push(format!(
                "{name} {}\n  want {want}\n  got  {got}",
                text.unwrap_or("undefined")
            ));
        }
    }
    println!(
        "{} inputs over {} door schemas; {} differ",
        cases.len(),
        15,
        differ.len()
    );
    assert!(
        differ.is_empty(),
        "{} of {} differ:\n{}",
        differ.len(),
        cases.len(),
        differ.join("\n")
    );
}

#[test]
fn every_list_window_reads_as_parse_public_l2_query_limit() {
    let golden = json::parse(GOLDEN).unwrap();
    let Some(Json::Array(limits)) = golden.get("limits") else {
        panic!("no limits")
    };
    let mut differ = Vec::new();
    for case in limits {
        let Json::Array(c) = case else {
            panic!("a window is [raw, window]")
        };
        let Json::String(raw) = &c[0] else {
            panic!("a raw window is text")
        };
        let want = match &c[1] {
            Json::Number(n) => Some(format!("{n}")),
            _ => None,
        };
        let got = door::published_limit(raw).map(|n| n.to_string());
        if got != want {
            differ.push(format!("{raw:?}: want {want:?}, got {got:?}"));
        }
    }
    println!("{} list windows; {} differ", limits.len(), differ.len());
    assert!(differ.is_empty(), "{}", differ.join("\n"));
}
