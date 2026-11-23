//! The session API's reads (`src/door/session_reads.json`) against the door: the list names exactly the queries under its
//! prefixes that `door::calls::CALLS` serves, and each read's input passes that call's own schema, so J-agents-12 #1 meets
//! the scope check and not a parse error. A read added to the door fails here, on its own pull request, until it is listed
//! with an input (#8495).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test"
)]

use service_kit::json::{self, Json};
use svc_agents::door::Kind;
use svc_agents::door::calls::CALLS;
use svc_agents::door::inputs;

const READS: &str = include_str!("../src/door/session_reads.json");

/// Ids shaped as the service's own (uuids); only their shape matters to a schema.
fn id_for(placeholder: &str) -> Option<&'static str> {
    match placeholder {
        "<sessionId>" => Some("33333333-3333-4333-8333-333333333333"),
        "<runId>" => Some("44444444-4444-4444-8444-444444444444"),
        "<requestId>" => Some("33333333-3333-4333-8333-333333333333:first"),
        "<sessionB>" => Some("55555555-5555-4555-8555-555555555555"),
        _ => None,
    }
}

fn filled(j: &Json) -> Json {
    match j {
        Json::String(s) if s.starts_with('<') => {
            Json::str(id_for(s).unwrap_or_else(|| panic!("unknown id {s}")))
        }
        Json::Array(a) => Json::Array(a.iter().map(filled).collect()),
        Json::Object(o) => Json::Object(o.iter().map(|(k, v)| (k.clone(), filled(v))).collect()),
        other => other.clone(),
    }
}

fn doc() -> Json {
    json::parse(READS).expect("session_reads.json parses")
}

fn prefixes(doc: &Json) -> Vec<String> {
    let Some(Json::Array(p)) = doc.get("prefixes") else {
        panic!("session_reads.json: no prefixes")
    };
    p.iter()
        .map(|p| match p {
            Json::String(s) => s.clone(),
            _ => panic!("session_reads.json: a prefix is not a string"),
        })
        .collect()
}

fn reads(doc: &Json) -> Vec<(String, Json)> {
    let Some(Json::Object(r)) = doc.get("reads") else {
        panic!("session_reads.json: no reads")
    };
    r.clone()
}

#[test]
fn lists_exactly_the_doors_session_reads() {
    let doc = doc();
    let prefixes = prefixes(&doc);
    let mut served: Vec<&str> = CALLS
        .iter()
        .filter(|c| {
            c.kind == Kind::Query
                && prefixes
                    .iter()
                    .any(|p| c.path.split('.').next() == Some(p.as_str()))
        })
        .map(|c| c.path)
        .collect();
    served.sort_unstable();
    let mut listed: Vec<String> = reads(&doc).into_iter().map(|(path, _)| path).collect();
    listed.sort();
    assert_eq!(
        listed, served,
        "session_reads.json must list every session read the door serves, each with an input"
    );
}

#[test]
fn gives_each_read_an_input_its_own_schema_accepts() {
    for (path, entry) in reads(&doc()) {
        let input = entry.get("input").map(filled);
        let verdict = inputs::parse(&path, input.as_ref()).expect("schemas.json reads");
        assert!(
            verdict.is_ok(),
            "{path}: {:?}",
            verdict.err().map(|r| r.message())
        );
    }
}
