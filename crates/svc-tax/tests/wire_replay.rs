//! The wire replay, answered from Rust. `services/svc-tax/src/wire-replay.golden.json` holds what the TypeScript svc-tax
//! answered to a matrix of requests (every call, seven inputs, four callers, a blank and a set jurisdiction map); its
//! own test (`wire-replay.test.ts`) holds the TypeScript service to it. This sends the same requests, built the same way,
//! to the Rust service, and every one must get the recorded status and body, byte for byte.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use std::sync::Arc;
use svc_tax::edge;
use svc_tax::json::{self, Json};

use svc_tax::ports::{Ledger, TaxBalance};
use svc_tax::tax::{Account, Failure, HistoryEntry, LakeStatus, Range, TaxDeps, TaxService};
use svc_tax::time::Instant;
use svc_tax::wire::{self, Request, Wire, WireConfig};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../services/svc-tax/src/wire-replay.golden.json"
);
const SECRET: &str = "a-tax-wire-replay-edge-secret-long-enough";
const USER: &str = "11111111-1111-4111-8111-111111111111";
/// 2026-11-19T00:00:00Z: the replay's fixed clock, so the export's filename does not move with the calendar.
const NOW: Instant = Instant(1_795_046_400_000);

/// The replay's ledger: it holds nothing.
struct EmptyLedger;

impl Ledger for EmptyLedger {
    fn balances(&self, _owner_type: &str, _owner_id: &str) -> Result<Vec<TaxBalance>, Failure> {
        Ok(Vec::new())
    }
    fn history(&self, _account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        Ok(Vec::new())
    }
}

fn serve(map_raw: &str) -> Wire {
    let tax = TaxService::new(TaxDeps {
        lake: LakeStatus::lake(None),
        indexer: LakeStatus::indexer(None),
        ..TaxDeps::new(map_raw, Arc::new(EmptyLedger), Some(10), Box::new(|| NOW))
    })
    .unwrap();
    // svc-tax's vitest environment (`services/svc-tax/vitest.config.ts`); vitest sets NODE_ENV to `test`.
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    Wire::new(WireConfig {
        edge_secret: SECRET.to_owned(),
        env,
        tax,
    })
    .unwrap()
}

/// `encodePrincipal` of the replay's principal: its keys in that function's order.
fn headers(scopes: Option<&[&str]>, region: &str) -> Vec<(String, String)> {
    let Some(scopes) = scopes else {
        return Vec::new();
    };
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(USER)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, region).unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), region.to_owned()),
    ]
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
fn without_stack(body: &str) -> String {
    let key = "\"stack\":\"";
    let mut out = String::new();
    let mut rest = body;
    while let Some(at) = rest.find(key) {
        out.push_str(&rest[..at + key.len()]);
        let after = &rest[at + key.len()..];
        let mut end = 0;
        let bytes = after.as_bytes();
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        out.push_str("<stack>\"");
        rest = &after[(end + 1).min(after.len())..];
    }
    out.push_str(rest);
    out
}

/// The replay's calls: path, kind and a valid input (`None`: no input), as JSON text in the TypeScript literal's order.
const CALLS: [(&str, &str, Option<&str>); 12] = [
    ("health", "query", None),
    ("lotBook", "query", Some(r#"{"method":"FIFO"}"#)),
    (
        "pnlOverTime",
        "query",
        Some(r#"{"from":"2026-01-01T00:00:00Z","utcOffsetMinutes":60}"#),
    ),
    ("missingBasis", "query", Some("{}")),
    (
        "basisOverride.set",
        "mutation",
        Some(r#"{"lotId":"l1","pricePerUnit":"1.5","date":"2026-01-01","sourceNote":"n"}"#),
    ),
    (
        "basisOverride.remove",
        "mutation",
        Some(r#"{"lotId":"l1"}"#),
    ),
    (
        "setLotMethod",
        "mutation",
        Some(r#"{"assetId":null,"method":"FIFO"}"#),
    ),
    (
        "setDayMethod",
        "mutation",
        Some(r#"{"day":"2026-01-01","assetId":"BTC","method":"LIFO"}"#),
    ),
    (
        "pickSaleLot",
        "mutation",
        Some(r#"{"saleTxId":"s1","assetId":"BTC","lotId":null}"#),
    ),
    (
        "setIncludeTransfers",
        "mutation",
        Some(r#"{"include":true}"#),
    ),
    ("exportPreview", "query", Some(r#"{"lotMethod":"HIFO"}"#)),
    ("exportPack", "mutation", Some(r#"{"lotMethod":"FIFO"}"#)),
];

/// The seven inputs each call gets, as `JSON.stringify` writes them (`None`: undefined).
fn inputs(valid: Option<&str>) -> Vec<(&'static str, Option<String>)> {
    let extra = match valid.map(|v| json::parse(v).unwrap()) {
        Some(Json::Object(mut fields)) => {
            fields.push(("extra".to_owned(), Json::int(1)));
            Json::Object(fields).compact()
        }
        _ => r#"{"extra":1}"#.to_owned(),
    };
    vec![
        ("valid", valid.map(str::to_owned)),
        ("absent", None),
        ("wrong-type", Some("7".to_owned())),
        ("extra-key", Some(extra)),
        (
            "bad-day",
            Some(r#"{"day":"2026-02-30","assetId":null,"method":"FIFO"}"#.to_owned()),
        ),
        (
            "complete-true",
            Some(r#"{"lotMethod":"FIFO","complete":true}"#.to_owned()),
        ),
        ("average", Some(r#"{"lotMethod":"AVERAGE"}"#.to_owned())),
    ]
}

const CALLERS: [(&str, Option<&[&str]>, &str); 4] = [
    ("anon", None, "DE"),
    ("read", Some(&["tax:read"]), "DE"),
    ("write", Some(&["tax:read", "tax:write"]), "DE"),
    ("write-US", Some(&["tax:read", "tax:write"]), "US"),
];

fn replay() -> BTreeMap<String, (u16, String)> {
    let mut answers = BTreeMap::new();
    for map_raw in ["", r#"["DE"]"#] {
        let wire = serve(map_raw);
        for (path, kind, valid) in CALLS {
            for (input_name, input) in inputs(valid) {
                for (caller, scopes, region) in CALLERS {
                    let h = headers(scopes, region);
                    let (method, url, body) = if kind == "query" {
                        let q = input
                            .as_deref()
                            .map(|i| format!("?input={}", encode_uri_component(i)))
                            .unwrap_or_default();
                        ("GET", format!("/trpc/{path}{q}"), String::new())
                    } else {
                        (
                            "POST",
                            format!("/trpc/{path}"),
                            input.clone().unwrap_or_default(),
                        )
                    };
                    let mut headers = h.clone();
                    if method == "POST" {
                        headers.push(("content-type".to_owned(), "application/json".to_owned()));
                    }
                    let res = wire.handle(&Request {
                        method,
                        url: &url,
                        headers: &headers,
                        body: &body,
                    });
                    let map_name = if map_raw.is_empty() {
                        "blank-map"
                    } else {
                        map_raw
                    };
                    answers.insert(
                        format!("{map_name} {path} {input_name} {caller}"),
                        (res.status, without_stack(&res.body)),
                    );
                }
            }
        }
    }
    answers
}

#[test]
fn every_request_in_the_matrix_gets_the_recorded_status_and_body_byte_for_byte() {
    let golden = json::parse(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    let Some(Json::Object(recorded)) = golden.get("answers") else {
        panic!("no answers in {GOLDEN}")
    };
    assert_eq!(recorded.len(), 672);
    let now = replay();
    assert_eq!(now.len(), 672, "the Rust replay builds the recorded matrix");
    let mut diffs = Vec::new();
    for (key, was) in recorded {
        let status = was
            .get("status")
            .and_then(|s| {
                if let Json::Number(n) = s {
                    Some(*n)
                } else {
                    None
                }
            })
            .unwrap();
        let Some(Json::String(body)) = was.get("body") else {
            panic!("{key}: no body")
        };
        match now.get(key) {
            Some((s, b)) if f64::from(*s) == status && b == body => {}
            Some((s, b)) => diffs.push(format!("{key}: {status} {body}\n  != {s} {b}")),
            None => diffs.push(format!("{key}: not sent")),
        }
    }
    assert!(
        diffs.is_empty(),
        "{} of 672 differ:\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}

#[test]
fn every_call_has_the_recorded_path_kind_and_caller() {
    let golden = json::parse(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    let Some(Json::Array(recorded)) = golden.get("callers") else {
        panic!("no callers in {GOLDEN}")
    };
    let recorded: Vec<(String, String, String)> = recorded
        .iter()
        .map(|c| {
            let s = |k| match c.get(k) {
                Some(Json::String(v)) => v.clone(),
                _ => panic!("caller without {k}"),
            };
            (s("path"), s("type"), s("caller"))
        })
        .collect();
    let now: Vec<(String, String, String)> = wire::callers()
        .into_iter()
        .map(|(p, k, c)| (p.to_owned(), k.to_owned(), c.to_owned()))
        .collect();
    assert_eq!(now, recorded);
}
