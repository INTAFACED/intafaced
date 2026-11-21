//! The journal's codec against the TypeScript's own output: `fixtures/journal-codec.golden.ndjson` holds what `encode`
//! wrote (or that it threw) for each record, and what `decodeAll` read (or that it threw) from each body
//! (`scripts/record-journal.mjs`). A boot rewrites every record it reads through `encode`, so any difference here is a
//! journal the switch would change on disk.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use svc_matching::journal::{JournalRecord, decode_all, encode};

const GOLDEN: &str = include_str!("fixtures/journal-codec.golden.ndjson");

/// The golden's cases of one kind (`codec` or `decode`), one a line.
fn cases(kind: &str) -> Vec<Json> {
    GOLDEN
        .lines()
        .map(|line| json::parse(line).unwrap())
        .filter(|case| text(case, "case") == Some(kind))
        .collect()
}

fn text<'a>(case: &'a Json, key: &str) -> Option<&'a str> {
    match case.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

#[test]
fn every_record_is_written_as_the_typescript_writes_it() {
    let cases = cases("codec");
    assert!(cases.len() > 800, "the golden holds every field's variants");
    let mut differ = Vec::new();
    let mut refused = 0;
    for case in &cases {
        let name = text(case, "name").unwrap();
        let record = JournalRecord(case.get("record").unwrap().clone());
        let got = encode(&record);
        match (text(case, "encoded"), &got) {
            (Some(want), Ok(line)) if want == line => {}
            (None, Err(_)) => refused += 1,
            (want, got) => differ.push(format!("{name}\n  want {want:?}\n  got  {got:?}")),
        }
    }
    assert!(
        differ.is_empty(),
        "{} of {} differ:\n{}",
        differ.len(),
        cases.len(),
        differ.join("\n")
    );
    assert_eq!(refused, 23, "the TypeScript refuses 23 of the records");
}

#[test]
fn every_body_is_read_as_the_typescript_reads_it() {
    let cases = cases("decode");
    assert_eq!(cases.len(), 23);
    let mut differ = Vec::new();
    for case in &cases {
        let name = text(case, "name").unwrap();
        let got = decode_all(text(case, "body").unwrap())
            .map(|records| Json::Array(records.into_iter().map(|r| r.0).collect()).compact());
        match (text(case, "records"), &got) {
            (Some(want), Ok(read)) if want == read => {}
            (None, Err(_)) => {}
            (want, got) => differ.push(format!("{name}\n  want {want:?}\n  got  {got:?}")),
        }
    }
    assert!(
        differ.is_empty(),
        "{} differ:\n{}",
        differ.len(),
        differ.join("\n")
    );
}
