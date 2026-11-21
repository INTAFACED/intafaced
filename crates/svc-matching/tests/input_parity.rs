//! Each door's input schema against zod's own verdicts: `fixtures/input-parity/<door>.json` holds what the TypeScript
//! schema answered (its output, or its issues) to inputs `scripts/record-door.mjs` made for that door. The list
//! windows are held to `parsePublicL2QueryLimit`'s own verdicts in `fixtures/list-windows.golden.json`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::path::PathBuf;

use service_kit::json::{self, Json};
use service_kit::schema::{Outcome, Value, issues_json};
use svc_matching::door;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

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
    let mut files: Vec<PathBuf> = std::fs::read_dir(fixtures().join("input-parity"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let mut total = 0usize;
    let mut differ = Vec::new();
    for file in &files {
        let name = file.file_stem().unwrap().to_string_lossy().into_owned();
        let golden = json::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
        let Some(Json::Array(verdicts)) = golden.get("verdicts") else {
            panic!("no verdicts in {name}")
        };
        let Some(Json::Array(cases)) = golden.get("cases") else {
            panic!("no cases in {name}")
        };
        for case in cases {
            let Json::Array(c) = case else {
                panic!("a case is a list")
            };
            let Json::Number(i) = &c[1] else {
                panic!("a case: input, verdict")
            };
            let text = match &c[0] {
                Json::String(t) => Some(t.as_str()),
                _ => None,
            };
            let Json::String(want) = &verdicts[format!("{i}").parse::<usize>().unwrap()] else {
                panic!("a verdict is text")
            };
            total += 1;
            let got = verdict(&name, text);
            if &got != want {
                differ.push(format!(
                    "{name} {}\n  want {want}\n  got  {got}",
                    text.unwrap_or("undefined")
                ));
            }
        }
    }
    println!(
        "{total} inputs over {} door schemas; {} differ",
        files.len(),
        differ.len()
    );
    assert_eq!(files.len(), 15, "one fixture for each door schema");
    assert!(
        differ.is_empty(),
        "{} of {total} differ:\n{}",
        differ.len(),
        differ.join("\n")
    );
}

#[test]
fn every_list_window_reads_as_parse_public_l2_query_limit() {
    let golden =
        json::parse(&std::fs::read_to_string(fixtures().join("list-windows.golden.json")).unwrap())
            .unwrap();
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
