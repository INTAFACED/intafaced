//! The wire replay. `services/svc-blueprint/src/wire-replay.golden.json` is what the TypeScript router answered to every
//! call with six inputs (absent, null, a wrong type, an empty object, a sample of its schema, the sample with every field
//! null) from four callers (anonymous, signed in with no scope, every scope in DE, every scope in the US), under blank
//! and set owner settings, over stubs that refuse any call with their own name. This sends the same requests, built the
//! same way, to the Rust door.
//!
//! An answer the door decides must match byte for byte: every route and method refusal, every 401, every scope and
//! region 403, every input 400 and the door's own call (`health`). Any other answer is the handler's: while it differs it
//! is owed by the call's slice, counted and printed, and fails nothing. One difference that is not owed fails the test.
//!
//! For one slice: `WIRE_REPLAY_SLICE=<slice> cargo test -p svc-blueprint --test it -- wire_replay:: --nocapture` prints
//! that slice's owed differences, and `WIRE_REPLAY_STRICT=<slice>` also fails while it owes any.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_blueprint::db::Store;
use svc_blueprint::door::{self, BlueprintDoor, DoorConfig, Slice};

const GOLDEN: &str = include_str!("../../../services/svc-blueprint/src/wire-replay.golden.json");
/// Recordings made while errors carried tRPC's stack hold it masked; the wire sends none now (the TypeScript test drops
/// it the same way on reading).
const RECORDED_STACK: &str = "\"stack\":\"<stack>\",";
const SECRET: &str = "a-blueprint-wire-replay-edge-secret-long-enough";
const USER: &str = "11111111-1111-4111-8111-111111111111";

/// The callers, in the recording's order: name, scopes (none: anonymous), region.
const CALLERS: [(&str, Option<&[&str]>, &str); 4] = [
    ("anon", None, "DE"),
    ("no-scope", Some(&[]), "DE"),
    ("all", Some(&["blueprint:read", "blueprint:write"]), "DE"),
    ("all-US", Some(&["blueprint:read", "blueprint:write"]), "US"),
];

/// The owner settings the recording ran under. The door reads none of them; each is a handler's.
const SETTINGS: [&str; 2] = ["blank", "set"];

fn now() -> Instant {
    Instant(1_795_046_400_000)
}

fn serve() -> BlueprintDoor {
    // The TypeScript replay's process: vitest sets NODE_ENV to `test`; the test stubs the rest.
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
        ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    BlueprintDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        env,
        now,
        // The recording's database: a stub that refuses any call with its own name.
        store: Store::Down("replay stub: sql".to_owned()),
    })
    .unwrap()
}

/// `encodePrincipal` of the replay's principal, signed for its region.
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
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
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

/// One request as the TypeScript replay sends it: `<status> <body>`.
fn hit(
    door: &BlueprintDoor,
    path: &str,
    query: bool,
    input: Option<&str>,
    caller: usize,
) -> String {
    let (_, scopes, region) = CALLERS[caller];
    let mut headers = headers(scopes, region);
    let (method, url, body) = if query {
        let q = input
            .map(|i| format!("?input={}", encode_uri_component(i)))
            .unwrap_or_default();
        ("GET", format!("/trpc/{path}{q}"), String::new())
    } else {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        (
            "POST",
            format!("/trpc/{path}"),
            input.unwrap_or_default().to_owned(),
        )
    };
    let res = door.handle_as(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "replay-request",
    );
    format!("{} {}", res.status, res.body)
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Number(n)) => format!("{n}"),
        other => panic!("{key}: {other:?}"),
    }
}

/// What the door decides, whichever slice owns the call: routing and method (404, 405), authentication (401), the
/// guard's scope and region refusals (an `intafacedCode`) and the input check (a 400 with no cause). A refusal a handler
/// throws carries its code as `cause`, or is a 500, and is the slice's, not the door's.
fn door_decided(answer: &str) -> bool {
    let status = answer.get(..3).unwrap_or("");
    let caused = answer.contains("\"cause\":");
    match status {
        "400" | "401" | "404" | "405" => !caused || answer.contains("\"intafacedCode\""),
        "403" => answer.contains("\"intafacedCode\""),
        _ => false,
    }
}

#[test]
fn the_door_answers_as_the_typescript_router_did() {
    let golden = json::parse(GOLDEN).unwrap();

    // The callers: every call, the same kind and the same kind of caller rule.
    let Some(Json::Array(recorded)) = golden.get("callers") else {
        panic!("callers")
    };
    let mut recorded: Vec<(String, String, String)> = recorded
        .iter()
        .map(|c| (text(c, "path"), text(c, "type"), text(c, "caller")))
        .collect();
    recorded.sort();
    let ours: Vec<(String, String, String)> = door::callers()
        .unwrap()
        .into_iter()
        .map(|(p, k, c)| (p, k.to_owned(), c.to_owned()))
        .collect();
    assert_eq!(
        ours, recorded,
        "callers() is not the recorded procedureCallers"
    );

    let Some(Json::Object(samples)) = golden.get("inputs") else {
        panic!("inputs")
    };
    let Some(Json::Object(answers)) = golden.get("answers") else {
        panic!("answers")
    };
    let was: BTreeMap<&str, String> = answers
        .iter()
        .map(|(k, a)| {
            let body = text(a, "body").replace(RECORDED_STACK, "");
            (k.as_str(), format!("{} {body}", text(a, "status")))
        })
        .collect();

    let door = serve();
    let mut now: BTreeMap<String, (String, Slice)> = BTreeMap::new();
    for (path, s) in samples {
        let call = door::call(path).unwrap();
        let query = call.kind == door::Kind::Query;
        let inputs: [(&str, Option<String>); 6] = [
            ("absent", None),
            ("null", Some("null".to_owned())),
            ("wrong-type", Some("7".to_owned())),
            ("empty", Some("{}".to_owned())),
            ("sample", Some(text(s, "sample"))),
            ("sample-nulls", Some(text(s, "sample-nulls"))),
        ];
        for settings in SETTINGS {
            for (input_name, input) in &inputs {
                for (i, (caller, ..)) in CALLERS.iter().enumerate() {
                    now.insert(
                        format!("{settings} {path} {input_name} {caller}"),
                        (hit(&door, path, query, input.as_deref(), i), call.slice),
                    );
                }
            }
        }
    }

    // Every recorded request asked, nothing else.
    let missing: Vec<&&str> = was.keys().filter(|k| !now.contains_key(**k)).collect();
    let extra: Vec<&String> = now
        .keys()
        .filter(|k| !was.contains_key(k.as_str()))
        .collect();
    assert!(missing.is_empty(), "not asked: {missing:?}");
    assert!(extra.is_empty(), "not recorded: {extra:?}");

    let mut owed: BTreeMap<Slice, (usize, usize)> =
        Slice::ALL.iter().map(|s| (*s, (0, 0))).collect();
    let mut owed_paths: BTreeMap<Slice, BTreeMap<String, usize>> = BTreeMap::new();
    let mut decided: BTreeMap<&str, usize> = BTreeMap::new();
    let mut wrong = Vec::new();
    let mut matched = 0usize;
    let focus = std::env::var("WIRE_REPLAY_SLICE").ok();
    for (key, (answer, slice)) in &now {
        let was = &was[key.as_str()];
        let entry = owed.get_mut(slice).unwrap();
        entry.1 += 1;
        if door_decided(was) {
            *decided.entry(was.get(..3).unwrap_or("")).or_default() += 1;
        }
        if was == answer {
            matched += 1;
            continue;
        }
        if *slice != Slice::Door && !door_decided(was) && !door_decided(answer) {
            entry.0 += 1;
            let path = key.split(' ').nth(1).unwrap_or(key).to_owned();
            *owed_paths
                .entry(*slice)
                .or_default()
                .entry(path)
                .or_default() += 1;
            if focus.as_deref() == Some(slice.name()) {
                println!(
                    "owed by {}: {key}\n  was: {was}\n  now: {answer}",
                    slice.name()
                );
            }
            continue;
        }
        wrong.push(format!("{key}\n  was: {was}\n  now: {answer}"));
    }

    println!("wire replay: {} answers, {matched} the same", now.len());
    println!("  held byte for byte by the door: {decided:?}");
    for (slice, (n, total)) in &owed {
        let paths = owed_paths.get(slice).map_or(0, BTreeMap::len);
        println!(
            "  owed by {:<8} {n:>4} of {total:>4} answers, over {paths} calls",
            slice.name()
        );
    }
    assert!(
        wrong.is_empty(),
        "{} answers differ where the door decides:\n{}",
        wrong.len(),
        wrong[..wrong.len().min(25)].join("\n")
    );
    if let Ok(strict) = std::env::var("WIRE_REPLAY_STRICT") {
        let left = owed
            .iter()
            .find(|(s, _)| s.name() == strict)
            .map_or(0, |(_, (n, _))| *n);
        assert_eq!(left, 0, "{strict} still owes {left} answers");
    }
}
