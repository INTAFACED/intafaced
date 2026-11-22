//! The wire replay. `fixtures/wire-replay.golden.json` is what the TypeScript service's `wire-replay.golden.json` held:
//! what the TypeScript router answered to every call with four inputs (valid, absent, wrong type, an extra key) from
//! four callers (anonymous, `academy:read`, `academy:write`, an operator with two-factor), over a database that is down
//! (`store-down`) and over a service whose every method refuses `academy.room_not_found` (`refuses`), and every
//! refusal code once through `admin.academyRoles` and `abandonCoursePurchase`. This sends the same requests, built the
//! same way, to the Rust door.
//!
//! An answer the door decides must match byte for byte: every route and method refusal, every 401, every scope 403,
//! every input 400, every approval 412, the door's own calls (`health`, `admin.settingsStatus`) and every refusal
//! code's answer. Any other answer is the handler's: while it differs it is owed by the call's slice, counted and
//! printed, and fails nothing. One difference that is not owed fails the test.
//!
//! For one slice: `WIRE_REPLAY_SLICE=<slice> cargo test -p svc-academy --test it -- wire_replay:: --nocapture` prints that
//! slice's owed differences, and `WIRE_REPLAY_STRICT=<slice>` also fails while it owes any.
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
use svc_academy::db::Store;
use svc_academy::door::{self, AcademyDoor, DoorConfig, Slice};
use svc_academy::errors::{AcademyError, Refusal};
use svc_academy::ports::{Ports, StubApprovals};
use svc_academy::settings::Settings;

const GOLDEN: &str = include_str!("fixtures/wire-replay.golden.json");
const SECRET: &str = "an-academy-wire-replay-edge-secret-long";
const USER: &str = "11111111-1111-4111-8111-111111111111";

/// 2026-11-19T00:00:00Z, the TypeScript replay's fake clock.
fn now() -> Instant {
    Instant(1_795_046_400_000)
}

/// The callers, in the golden file's order: name, scopes (none: anonymous).
const CALLERS: [(&str, Option<&[&str]>); 4] = [
    ("anon", None),
    ("read", Some(&["academy:read"])),
    ("write", Some(&["academy:read", "academy:write"])),
    (
        "operator",
        Some(&["academy:read", "academy:write", "admin:read", "admin:write"]),
    ),
];

fn serve(store: Store) -> AcademyDoor {
    // The TypeScript replay's process: vitest sets NODE_ENV to `test`; its config the rest.
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
        ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    let mut ports = Ports::unwired();
    ports.approvals = Box::new(StubApprovals("replay-operator".to_owned()));
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        env,
        store,
        ports,
        settings: Settings::empty(),
        now,
    })
    .unwrap()
}

/// `encodePrincipal` of the replay's principal, signed for DE. Only the operator passed two-factor.
fn headers(scopes: Option<&[&str]>) -> Vec<(String, String)> {
    let region = ("x-intafaced-region".to_owned(), "DE".to_owned());
    let Some(scopes) = scopes else {
        return vec![region];
    };
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(scopes.contains(&"admin:write"))),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(USER)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        region,
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

/// Replaces the value of every `"<key>":"..."` string with `<mask>`.
fn mask(body: &str, key: &str, mask: &str) -> String {
    let key = format!("\"{key}\":\"");
    let mut out = String::new();
    let mut rest = body;
    while let Some(at) = rest.find(&key) {
        out.push_str(&rest[..at + key.len()]);
        let after = &rest[at + key.len()..];
        let bytes = after.as_bytes();
        let mut end = 0;
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        out.push_str(mask);
        out.push('"');
        rest = &after[(end + 1).min(after.len())..];
    }
    out.push_str(rest);
    out
}

/// One request as the TypeScript replay's `hit` sends it: `<status> <body>`, the stack, request id and path masked.
fn hit(
    door: &AcademyDoor,
    path: &str,
    kind: &str,
    input: Option<&str>,
    scopes: Option<&[&str]>,
) -> String {
    let mut headers = headers(scopes);
    let (method, url, body) = if kind == "query" {
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
    let res = door.handle(&Request {
        method,
        url: &url,
        headers: &headers,
        body: &body,
    });
    let body = mask(&res.body, "stack", "<stack>");
    let body = mask(&body, "requestId", "<id>");
    let body = body.replace(
        &format!("\"path\":{}", Json::str(path).compact()),
        "\"path\":\"<path>\"",
    );
    format!("{} {body}", res.status)
}

struct Golden {
    callers: Vec<(String, String, String)>,
    /// path, kind, the valid input as `JSON.stringify` writes it (none: undefined).
    calls: Vec<(String, String, Option<String>)>,
    /// `<group> | <request> <caller>` → `<status> <body>`.
    answers: BTreeMap<String, String>,
}

fn golden() -> Golden {
    let g = json::parse(GOLDEN).unwrap();
    let s = |v: &Json, k: &str| match v.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k}: {other:?}"),
    };
    let Some(Json::Array(callers)) = g.get("callers") else {
        panic!("callers")
    };
    let callers = callers
        .iter()
        .map(|c| (s(c, "path"), s(c, "type"), s(c, "caller")))
        .collect();
    let Some(Json::Array(calls)) = g.get("calls") else {
        panic!("calls")
    };
    let calls = calls
        .iter()
        .map(|c| {
            (
                s(c, "path"),
                s(c, "kind"),
                c.get("valid").map(Json::compact),
            )
        })
        .collect();
    let Some(Json::Array(bodies)) = g.get("bodies") else {
        panic!("bodies")
    };
    let Some(Json::Object(groups)) = g.get("answers") else {
        panic!("answers")
    };
    let mut answers = BTreeMap::new();
    for (group, requests) in groups {
        let Json::Object(requests) = requests else {
            panic!("{group}")
        };
        for (request, ats) in requests {
            let Json::Array(ats) = ats else {
                panic!("{group} {request}")
            };
            for (i, at) in ats.iter().enumerate() {
                let Json::Number(n) = at else {
                    panic!("{group} {request}")
                };
                let Json::String(body) = &bodies[format!("{n}").parse::<usize>().unwrap()] else {
                    panic!("body")
                };
                answers.insert(
                    format!("{group} | {request} {}", CALLERS[i].0),
                    body.clone(),
                );
            }
        }
    }
    Golden {
        callers,
        calls,
        answers,
    }
}

/// The four inputs, as `JSON.stringify` writes them.
fn inputs(valid: Option<&str>) -> [(&'static str, Option<String>); 4] {
    let extra = match valid.map(|v| json::parse(v).unwrap()) {
        Some(Json::Object(mut fields)) => {
            match fields.iter_mut().find(|(k, _)| k == "extra") {
                Some(slot) => slot.1 = Json::int(1),
                None => fields.push(("extra".to_owned(), Json::int(1))),
            }
            Json::Object(fields).compact()
        }
        _ => r#"{"extra":1}"#.to_owned(),
    };
    [
        ("valid", valid.map(str::to_owned)),
        ("absent", None),
        ("wrong-type", Some("7".to_owned())),
        ("extra-key", Some(extra)),
    ]
}

/// The refusals the golden file sends through its two calls: every catalogue code, then the other types.
fn refusals() -> Vec<(String, Refusal)> {
    let mut out: Vec<(String, Refusal)> = svc_academy::door::errors_table::ERRORS
        .iter()
        .map(|(code, ..)| {
            (
                (*code).to_owned(),
                Refusal::Academy(AcademyError::new(format!("replay: {code}"), code)),
            )
        })
        .collect();
    out.push((
        "owner-decision".to_owned(),
        Refusal::OwnerDecision("replay: waits for the owner".to_owned()),
    ));
    out.push((
        "dual-control".to_owned(),
        Refusal::DualControl("replay: a second operator is missing".to_owned()),
    ));
    out.push((
        "approval".to_owned(),
        Refusal::Approval {
            message: "replay: approval missing".to_owned(),
            code: "action_approval.consume_failed".to_owned(),
        },
    ));
    out.push((
        "plain-error".to_owned(),
        Refusal::Internal {
            message: "replay: an unexpected failure".to_owned(),
            code: None,
        },
    ));
    out
}

/// What the door decides, whichever slice owns the call: routing and method (404, 405), authentication (401), the
/// guard's scope, two-factor and region refusals (an `intafacedCode`), the input check (a 400) and the approval check
/// (412). A refusal a handler throws carries its code as `cause` and is the slice's, not the door's.
fn door_decided(answer: &str) -> bool {
    let status = answer.get(..3).unwrap_or("");
    let caused = answer.contains("\"cause\":");
    match status {
        "400" | "401" | "404" | "405" => !caused || answer.contains("\"intafacedCode\""),
        "403" => answer.contains("\"intafacedCode\""),
        "412" => {
            answer.contains("[action_approval.missing]")
                || answer.contains("operator identity is required")
        }
        _ => false,
    }
}

#[test]
fn the_door_answers_as_the_typescript_router_did() {
    let golden = golden();

    // The callers: every call, the same kind and the same kind of caller rule.
    let mut recorded = golden.callers.clone();
    recorded.sort();
    let ours: Vec<(String, String, String)> = door::callers()
        .into_iter()
        .map(|(p, k, c)| (p.to_owned(), k.to_owned(), c.to_owned()))
        .collect();
    assert_eq!(
        ours, recorded,
        "callers() is not the recorded procedureCallers"
    );

    let mut now: BTreeMap<String, (String, Slice)> = BTreeMap::new();
    let slice_of = |path: &str| door::call(path).map_or(Slice::Door, |c| c.slice);
    let store_down = serve(Store::Down("wire replay: the database is down".to_owned()));
    for (path, kind, valid) in &golden.calls {
        for (input_name, input) in inputs(valid.as_deref()) {
            for (caller, scopes) in CALLERS {
                let key = format!("{path} | store-down {input_name} {caller}");
                now.insert(
                    key,
                    (
                        hit(&store_down, path, kind, input.as_deref(), scopes),
                        slice_of(path),
                    ),
                );
            }
        }
    }
    let refuses = serve(Store::Refuses(Refusal::Academy(AcademyError::new(
        "replay: refused",
        "academy.room_not_found",
    ))));
    for (path, kind, valid) in &golden.calls {
        for (caller, scopes) in CALLERS {
            let key = format!("{path} | refuses valid {caller}");
            now.insert(
                key,
                (
                    hit(&refuses, path, kind, valid.as_deref(), scopes),
                    slice_of(path),
                ),
            );
        }
    }
    let through: Vec<&(String, String, Option<String>)> =
        ["admin.academyRoles", "abandonCoursePurchase"]
            .iter()
            .map(|p| golden.calls.iter().find(|c| c.0 == *p).unwrap())
            .collect();
    for (name, refusal) in refusals() {
        let door = serve(Store::Refuses(refusal));
        for (path, kind, valid) in &through {
            for (caller, scopes) in CALLERS {
                let key = format!("refusal {name} | via {path} {caller}");
                // A refusal's answer is the error table's: the door's, whichever slice owns the call it went through.
                now.insert(
                    key,
                    (
                        hit(&door, path, kind, valid.as_deref(), scopes),
                        Slice::Door,
                    ),
                );
            }
        }
    }

    // Every recorded request asked, nothing else.
    let missing: Vec<&String> = golden
        .answers
        .keys()
        .filter(|k| !now.contains_key(*k))
        .collect();
    let extra: Vec<&String> = now
        .keys()
        .filter(|k| !golden.answers.contains_key(*k))
        .collect();
    assert!(
        missing.is_empty(),
        "not asked: {:?}",
        &missing[..missing.len().min(10)]
    );
    assert!(
        extra.is_empty(),
        "not recorded: {:?}",
        &extra[..extra.len().min(10)]
    );

    let mut owed: BTreeMap<Slice, (usize, usize)> =
        Slice::ALL.iter().map(|s| (*s, (0, 0))).collect();
    let mut owed_paths: BTreeMap<Slice, BTreeMap<String, usize>> = BTreeMap::new();
    let mut wrong = Vec::new();
    let mut matched = 0usize;
    let mut decided: BTreeMap<&str, usize> = BTreeMap::new();
    let focus = std::env::var("WIRE_REPLAY_SLICE").ok();
    for (key, (answer, slice)) in &now {
        let was = &golden.answers[key];
        let entry = owed.get_mut(slice).unwrap();
        entry.1 += 1;
        if door_decided(was) {
            let kind = if key.starts_with("refusal ") {
                "refusal"
            } else {
                was.get(..3).unwrap_or("")
            };
            *decided.entry(kind).or_default() += 1;
        } else if key.starts_with("refusal ") {
            *decided.entry("refusal").or_default() += 1;
        }
        if was == answer {
            matched += 1;
            continue;
        }
        if *slice != Slice::Door && !door_decided(was) && !door_decided(answer) {
            entry.0 += 1;
            let path = key.split(" | ").next().unwrap_or(key).to_owned();
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
            "  owed by {:<10} {n:>5} of {total:>5} answers, over {paths} calls",
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
