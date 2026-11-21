//! The wire replay. `services/svc-matching/src/wire-replay.golden/` is what the TypeScript service answered
//! (`wire-replay.test.ts`): every door `index.ts` mounts but `/ready` and `/metrics`, each door's own inputs and six
//! generic bodies, nine callers, under two set-ups (`blank`: an empty environment; `set`: every owner value set, with
//! one open market and a resting order). This sends the same requests (`fixtures/requests.json`, written from the
//! TypeScript matrix by `scripts/record-door.mjs`), signed the same way at the recording's frozen clock, to the Rust
//! door.
//!
//! An answer the door decides must match byte for byte: every 401 and 403 of a service's signature, its caller list or
//! the founder's principal and scope; Fastify's 414; the founder door's 503 while unconfigured; and every 400 of a
//! door's input checks (its schema, the lifecycle proof's binding, the post-only rule, a list's window, the position
//! read's account, the founder doors' key and market). Any other answer is a slice's: the door names the slice that
//! owes it, and it is counted, printed and fails nothing. One difference the door decided fails the test.
//!
//! The replay's engine keeps its state between doors, so a slice's answers come back to 0 owed only when the slices
//! that build that state are ported too; the engine slices prove theirs with the TypeScript engine tests as well.
//!
//! `WIRE_REPLAY_SLICE=<slice> cargo test -p svc-matching --test wire_replay -- --nocapture` prints that slice's owed
//! answers, and `WIRE_REPLAY_STRICT=<slice>` also fails while it owes any. The recording is read from the TypeScript
//! service while it exists; the switch copies it here before that service is deleted.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use hmac::{Hmac, Mac};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::s2s::{self, SERVICE_HEADER, SERVICE_SIGNATURE_HEADER, SERVICE_TIMESTAMP_HEADER};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use sha2::Sha256;
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome, ROUTES, Slice};

const SECRET: &str = "matching-wire-replay-internal-secret-32c";
const WRONG_SECRET: &str = "matching-wire-replay-wrong-secret-xx-32c";
const EDGE_SECRET: &str = "matching-wire-replay-edge-secret-at-least-32";
const WRONG_EDGE_SECRET: &str = "matching-wire-replay-wrong-edge-secret-32ch";
const REGION: &str = "XX";
const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
/// The recording's frozen clock, 2026-11-19T00:00:00.000Z.
const NOW_SECONDS: i64 = 1_795_046_400;

fn now_ms() -> i64 {
    NOW_SECONDS * 1000
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../services/svc-matching/src/wire-replay.golden")
}

fn text(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        _ => panic!("{k} is text"),
    }
}

/// One recorded answer, with the request that drew it.
struct Recorded {
    key: String,
    file: String,
    status: u16,
    body: String,
}

fn read_golden() -> Vec<Recorded> {
    let mut files: Vec<_> = std::fs::read_dir(golden_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let mut out = Vec::new();
    for path in files {
        let file = path.file_stem().unwrap().to_string_lossy().into_owned();
        let doc = json::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let Json::Object(rows) = doc else {
            panic!("a golden file is an object")
        };
        for (key, row) in rows {
            let Some(Json::Number(status)) = row.get("status") else {
                panic!("status")
            };
            out.push(Recorded {
                key,
                file: file.clone(),
                status: format!("{status}").parse().unwrap(),
                body: text(&row, "body"),
            });
        }
    }
    out
}

/// `(file, method, url, input)` to the body sent (none for no body).
fn read_requests() -> BTreeMap<(String, String, String, String), Option<String>> {
    let doc = json::parse(include_str!("fixtures/requests.json")).unwrap();
    let Some(Json::Array(list)) = doc.get("requests") else {
        panic!("requests")
    };
    list.iter()
        .map(|r| {
            let body = match r.get("body") {
                Some(Json::String(s)) => Some(s.clone()),
                _ => None,
            };
            (
                (
                    text(r, "file"),
                    text(r, "method"),
                    text(r, "url"),
                    text(r, "input"),
                ),
                body,
            )
        })
        .collect()
}

/// `serviceAuthHeaders`: the v1 signature, which binds no body.
fn unbound(service: &str, secret: &str) -> Vec<(String, String)> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{service}\n{NOW_SECONDS}").as_bytes());
    let sig: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    vec![
        (SERVICE_HEADER.to_owned(), service.to_owned()),
        (SERVICE_TIMESTAMP_HEADER.to_owned(), NOW_SECONDS.to_string()),
        (SERVICE_SIGNATURE_HEADER.to_owned(), sig),
    ]
}

/// The edge's forwarded principal for the replay's operator, signed with `secret`.
fn edge_principal(scopes: &[&str], mfa: bool, secret: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(OPERATOR)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("institutional")),
        ("mfa", Json::Bool(mfa)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(OPERATOR)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, secret, REGION).unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), REGION.to_owned()),
    ]
}

/// The recording's callers, by name, for this payload.
fn caller(name: &str, payload: &str) -> Vec<(String, String)> {
    let bound =
        |svc: &str, secret: &str| s2s::legacy_headers(svc, secret, payload, NOW_SECONDS).unwrap();
    match name {
        "anon" => Vec::new(),
        "svc-trade" | "svc-execution" | "svc-ledger" => bound(name, SECRET),
        "svc-trade-unbound" => unbound("svc-trade", SECRET),
        "svc-trade-wrong-secret" => bound("svc-trade", WRONG_SECRET),
        "founder" => edge_principal(&["admin:read", "admin:write"], true, EDGE_SECRET),
        "reader" => edge_principal(&["admin:read"], false, EDGE_SECRET),
        "founder-wrong-secret" => {
            edge_principal(&["admin:read", "admin:write"], true, WRONG_EDGE_SECRET)
        }
        other => panic!("a caller the replay does not make: {other}"),
    }
}

fn door(setup: &str) -> MatchingDoor {
    MatchingDoor::new(DoorConfig {
        internal_secret: SECRET.to_owned(),
        body_bind: BodyBind::Require,
        keys: None,
        edge_secret: (setup == "set").then(|| EDGE_SECRET.to_owned()),
        edge_key: None,
        clock: now_ms,
    })
    .unwrap()
}

/// The code a recorded body names, if any.
fn code_of(body: &str) -> Option<String> {
    json::parse(body).ok().and_then(|j| match j.get("code") {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    })
}

/// A recorded answer only the door gives: who is calling, Fastify's own refusals, the founder door's configuration,
/// and the input checks the door runs before the engine.
fn door_class(a: &Recorded) -> bool {
    let code = code_of(&a.body).unwrap_or_default();
    matches!(a.status, 401 | 403 | 414)
        || code.starts_with("FST_ERR_")
        || code == "matching.operator_auth_unconfigured"
        || (a.status == 400
            && (code == "BadRequest"
                || code.ends_with("_limit_unset")
                || code == "matching.idempotency_key_invalid"
                || code == "matching.market_required"))
}

fn slice_of(name: &str) -> Option<Slice> {
    Slice::ALL.into_iter().find(|s| s.name() == name)
}

/// The route pattern a recorded URL reaches, as `<method> <pattern>`.
fn pattern_of(method: &str, url: &str) -> Option<String> {
    let path = url.split_once('?').map_or(url, |(p, _)| p);
    let segments: Vec<&str> = path.split('/').collect();
    ROUTES
        .iter()
        .filter(|r| r.method == method)
        .filter(|r| {
            let p: Vec<&str> = r.path.split('/').collect();
            p.len() == segments.len()
                && p.iter()
                    .zip(&segments)
                    .all(|(p, s)| p.starts_with(':') || p == s)
        })
        .max_by_key(|r| r.path.split('/').filter(|p| !p.starts_with(':')).count())
        .map(|r| format!("{} {}", r.method, r.path))
}

#[test]
fn the_door_answers_every_recorded_request_it_decides_as_the_typescript_does() {
    let golden = read_golden();
    let requests = read_requests();
    let detail = std::env::var("WIRE_REPLAY_SLICE").ok();
    let strict = std::env::var("WIRE_REPLAY_STRICT").ok();
    let doors: BTreeMap<&str, MatchingDoor> = [("blank", door("blank")), ("set", door("set"))]
        .into_iter()
        .collect();

    let mut same = 0usize;
    let mut held: BTreeMap<String, usize> = BTreeMap::new();
    let mut owed: BTreeMap<Slice, usize> = BTreeMap::new();
    let mut owed_calls: BTreeMap<Slice, BTreeSet<String>> = BTreeMap::new();
    let mut differ = Vec::new();
    let mut reached = BTreeSet::new();
    let mut sent = BTreeSet::new();
    for a in &golden {
        let mut parts = a.key.splitn(5, ' ');
        let (setup, method, url, input, who) = (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        );
        let request = (
            a.file.clone(),
            method.to_owned(),
            url.to_owned(),
            input.to_owned(),
        );
        let Some(body) = requests.get(&request) else {
            panic!(
                "the recording holds a request the matrix does not: {}",
                a.key
            )
        };
        sent.insert(request.clone());
        let payload = body.clone().unwrap_or_default();
        let mut headers = caller(who, &payload);
        if body.is_some() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        if let Some(p) = pattern_of(method, url) {
            reached.insert(p);
        }
        let outcome = doors[setup].decide(&Request {
            method,
            url,
            headers: &headers,
            body: &payload,
        });
        match outcome {
            Outcome::Answer(r) if r.status == a.status && r.body == a.body => {
                same += 1;
                *held
                    .entry(
                        code_of(&a.body)
                            .map_or_else(|| a.status.to_string(), |c| format!("{} {c}", a.status)),
                    )
                    .or_default() += 1;
            }
            Outcome::Answer(r) => differ.push(format!(
                "{}\n  want {} {}\n  got  {} {}",
                a.key, a.status, a.body, r.status, r.body
            )),
            // Every refusal of who is calling and every input check is the door's: a slice can never owe one, so an
            // answer that should have been one shows here as a difference.
            Outcome::Owed(slice) if door_class(a) => differ.push(format!(
                "{}\n  want {} {}\n  got  owed by {}",
                a.key,
                a.status,
                a.body,
                slice.name()
            )),
            Outcome::Owed(slice) => {
                *owed.entry(slice).or_default() += 1;
                if let Some(p) = pattern_of(method, url) {
                    owed_calls.entry(slice).or_default().insert(p);
                }
                if detail.as_deref() == Some(slice.name()) {
                    println!(
                        "owed by {}: {}\n  want {} {}",
                        slice.name(),
                        a.key,
                        a.status,
                        a.body
                    );
                }
            }
        }
    }
    let total = golden.len();
    let owed_n: usize = owed.values().sum();
    println!(
        "wire replay: {total} answers, {same} the same, {owed_n} owed by a slice, {} differ",
        differ.len()
    );
    println!("  held byte for byte by the door:");
    for (what, n) in &held {
        println!("    {n:>5}  {what}");
    }
    for s in Slice::ALL {
        let n = owed.get(&s).copied().unwrap_or(0);
        let calls = owed_calls.get(&s).map_or(0, BTreeSet::len);
        println!(
            "  owed by {:<10} {n:>5} answers over {calls} doors",
            s.name()
        );
    }
    assert!(
        differ.is_empty(),
        "{} answers the door decided differ:\n{}",
        differ.len(),
        differ
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(
        same + owed_n,
        total,
        "every recorded answer is held or owed"
    );
    assert_eq!(
        sent.len(),
        requests.len(),
        "every request of the matrix is in the recording"
    );
    // Every route the door serves is one the recording reaches, but the two the TypeScript replay cannot mount.
    let unreached: Vec<String> = ROUTES
        .iter()
        .map(|r| format!("{} {}", r.method, r.path))
        .filter(|r| !reached.contains(r) && r != "GET /ready" && r != "GET /metrics")
        .collect();
    assert!(
        unreached.is_empty(),
        "routes the recording never reaches: {unreached:?}"
    );
    if let Some(s) = strict.as_deref().and_then(slice_of) {
        let n = owed.get(&s).copied().unwrap_or(0);
        assert_eq!(n, 0, "slice {} still owes {n} answers", s.name());
    }
}
