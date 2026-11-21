//! The wire replay. `services/svc-agents/wire-replay.golden/` is what the TypeScript router answered (through the
//! production Fastify adapter, with every optional dependency left out) to every call with five inputs (valid, absent,
//! wrong type, empty, an extra key) from five callers (anonymous, `agents:read`, a person who may execute, an operator
//! reader, and an API key). This sends the same requests, built the same way, to the Rust door.
//!
//! An answer the door decides must match byte for byte: every route and method refusal, every 401, every scope,
//! region, service and person 403, every input 400, and the door's own call (`health`). Any other answer is the
//! handler's: while the Rust door answers it "not ported" it is owed by the call's slice, counted and printed, and fails
//! nothing. One difference that is not owed fails the test.
//!
//! For one slice: `WIRE_REPLAY_SLICE=<slice> cargo test -p svc-agents --test wire_replay -- --nocapture` prints that
//! slice's owed answers, and `WIRE_REPLAY_STRICT=<slice>` also fails while it owes any.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_agents::db::Store;
use svc_agents::door::{self, AgentsDoor, DoorConfig, Kind, Pre, ServiceAuth, Slice};
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;

const SECRET: &str = "an-agents-wire-replay-edge-secret-long-enough";
const USER: &str = "11111111-1111-4111-8111-111111111111";

/// 2026-11-19T00:00:00Z, the TypeScript replay's fake clock.
fn now() -> Instant {
    Instant(1_795_046_400_000)
}

struct Caller {
    name: &'static str,
    scopes: Option<&'static [&'static str]>,
    tier: &'static str,
    kid: Option<&'static str>,
}

/// The callers, in the recording's order.
const CALLERS: [Caller; 5] = [
    Caller {
        name: "anon",
        scopes: None,
        tier: "",
        kid: None,
    },
    Caller {
        name: "read",
        scopes: Some(&["agents:read"]),
        tier: "basic",
        kid: None,
    },
    Caller {
        name: "execute",
        scopes: Some(&["agents:read", "agents:execute", "identity:write"]),
        tier: "full",
        kid: None,
    },
    Caller {
        name: "admin",
        scopes: Some(&["agents:read", "admin:read"]),
        tier: "basic",
        kid: None,
    },
    Caller {
        name: "key",
        scopes: Some(&["agents:read", "agents:execute", "identity:write"]),
        tier: "full",
        kid: Some("key-1"),
    },
];

fn serve() -> AgentsDoor {
    // The TypeScript replay's process: vitest sets NODE_ENV to `test`; svc-agents' vitest config and the replay the rest.
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
        ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    AgentsDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth::unwired(),
        env,
        now,
        store: Store::Down("svc-agents: the replay has no database".to_owned()),
        // The replay's gateway: an empty routing table and no provider registered.
        gateway: GatewaySlice::unwired("fixture-asset"),
        ready: ReadyInput::unwired(),
        metering: svc_agents::metering::Metering::unwired("USDC", 60),
        runtime: svc_agents::runtime::Runtime::unwired(),
        ops: svc_agents::ops::Ops::unwired(),
    })
    .unwrap()
}

/// `encodePrincipal` of the replay's principal, signed for DE.
fn headers(c: &Caller) -> Vec<(String, String)> {
    let Some(scopes) = c.scopes else {
        return Vec::new();
    };
    let mut fields = vec![
        ("sub", Json::str(USER)),
        ("userId", Json::str(USER)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str(c.tier)),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ];
    if let Some(kid) = c.kid {
        fields.push(("kid", Json::str(kid)));
    }
    let raw = Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
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

/// tRPC's stack trace carries file paths that move with any edit; the replay records it as `<stack>`.
fn mask_stack(body: &str) -> String {
    let key = "\"stack\":\"";
    let Some(at) = body.find(key) else {
        return body.to_owned();
    };
    let after = &body[at + key.len()..];
    let bytes = after.as_bytes();
    let mut end = 0;
    while end < bytes.len() && bytes[end] != b'"' {
        end += if bytes[end] == b'\\' { 2 } else { 1 };
    }
    format!("{}<stack>{}", &body[..at + key.len()], &after[end..])
}

/// One request as the TypeScript replay's `hit` sends it.
fn hit(
    door: &AgentsDoor,
    path: &str,
    kind: Kind,
    input: Option<&Json>,
    c: &Caller,
) -> (u16, String) {
    let mut h = headers(c);
    let (method, url, body) = match kind {
        Kind::Query => {
            let url = match input {
                Some(i) => format!("/trpc/{path}?input={}", encode_uri_component(&i.compact())),
                None => format!("/trpc/{path}"),
            };
            ("GET", url, String::new())
        }
        Kind::Mutation => {
            h.push(("content-type".to_owned(), "application/json".to_owned()));
            (
                "POST",
                format!("/trpc/{path}"),
                input.map_or(String::new(), Json::compact),
            )
        }
    };
    let res = door.handle_as(
        &Request {
            method,
            url: &url,
            headers: &h,
            body: &body,
        },
        "<request>",
    );
    (res.status, mask_stack(&res.body))
}

struct Golden {
    callers: Vec<(String, String, String)>,
    inputs: BTreeMap<String, Json>,
    answers: BTreeMap<String, (u16, String)>,
}

fn golden() -> Golden {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../services/svc-agents/wire-replay.golden");
    let mut g = Golden {
        callers: Vec::new(),
        inputs: BTreeMap::new(),
        answers: BTreeMap::new(),
    };
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    for file in files
        .iter()
        .filter(|f| f.extension().is_some_and(|e| e == "json"))
    {
        let part = json::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
        let Some(Json::Array(callers)) = part.get("callers") else {
            panic!()
        };
        for c in callers {
            let s = |k: &str| match c.get(k) {
                Some(Json::String(v)) => v.clone(),
                _ => panic!("a caller's {k}"),
            };
            g.callers.push((s("path"), s("type"), s("caller")));
        }
        let Some(Json::Object(inputs)) = part.get("inputs") else {
            panic!()
        };
        g.inputs.extend(inputs.iter().cloned());
        let Some(Json::Object(answers)) = part.get("answers") else {
            panic!()
        };
        for (k, a) in answers {
            let (Some(Json::Number(st)), Some(Json::String(body))) =
                (a.get("status"), a.get("body"))
            else {
                panic!("an answer")
            };
            g.answers
                .insert(k.clone(), (format!("{st}").parse().unwrap(), body.clone()));
        }
    }
    g.callers.sort();
    g
}

/// The five inputs of a call, as the TypeScript replay builds them.
fn inputs(valid: Option<&Json>) -> [(&'static str, Option<Json>); 5] {
    let extra = match valid {
        Some(Json::Object(o)) => {
            let mut o = o.clone();
            o.push(("extra".to_owned(), Json::int(1)));
            Json::Object(o)
        }
        _ => Json::obj([("extra", Json::int(1))]),
    };
    [
        ("valid", valid.cloned()),
        ("absent", None),
        ("wrong-type", Some(Json::int(7))),
        ("empty", Some(Json::Object(Vec::new()))),
        ("extra-key", Some(extra)),
    ]
}

/// Whether the door itself decides this recorded answer: a 401, a zod 400, a guard's or a person check's 403, a 404.
fn door_decides(call: &door::Call, status: u16, body: &str) -> bool {
    let message = json::parse(body)
        .ok()
        .and_then(|b| b.get("error").and_then(|e| e.get("message")).cloned());
    let message = match message {
        Some(Json::String(m)) => m,
        _ => String::new(),
    };
    let person_code = match call.pre {
        Pre::PersonOnly(code) => message == code,
        Pre::CoachRun => {
            ["agents.execute_scope_unset", "agents.execute_person_only"].contains(&message.as_str())
        }
        Pre::None => false,
    };
    call.slice == Slice::Door
        || matches!(status, 401 | 404)
        || (status == 400 && message.starts_with('['))
        || (status == 403
            && (body.contains("\"intafacedCode\":")
                || message == "A signed-in user session is required"
                || person_code
                || message == "This service is not allowed to call this procedure"
                || message == "usage settle is callable only as svc-agents"))
}

#[test]
fn every_recorded_request_gets_the_recorded_answer_or_is_owed_by_its_slice() {
    let g = golden();
    let ours: Vec<(String, String, String)> = door::callers()
        .into_iter()
        .map(|(p, k, c)| (p.to_owned(), k.to_owned(), c.to_owned()))
        .collect();
    assert_eq!(
        ours, g.callers,
        "the door's calls and their callers are the recording's"
    );

    let door = serve();
    let only = std::env::var("WIRE_REPLAY_SLICE").ok();
    let strict = std::env::var("WIRE_REPLAY_STRICT").ok();
    let mut sent = 0usize;
    let mut same = 0usize;
    let mut held: BTreeMap<u16, usize> = BTreeMap::new();
    let mut owed: BTreeMap<Slice, (usize, usize, std::collections::BTreeSet<&str>)> =
        BTreeMap::new();
    let mut differ = Vec::new();
    for call in door::calls::CALLS.iter() {
        let valid = if call.has_input {
            g.inputs.get(call.path)
        } else {
            None
        };
        for (input_name, input) in inputs(valid) {
            for c in &CALLERS {
                let key = format!("{} {input_name} {}", call.path, c.name);
                let want = g
                    .answers
                    .get(&key)
                    .unwrap_or_else(|| panic!("no recorded answer for {key}"));
                sent += 1;
                let got = hit(&door, call.path, call.kind, input.as_ref(), c);
                let entry = owed.entry(call.slice).or_default();
                entry.1 += 1;
                if &got == want {
                    same += 1;
                    if door_decides(call, want.0, &want.1) {
                        *held.entry(want.0).or_default() += 1;
                    }
                    continue;
                }
                let not_ported = got.0 == 500
                    && got
                        .1
                        .contains(&format!("the {} slice is not ported", call.slice.name()));
                if not_ported && !door_decides(call, want.0, &want.1) {
                    entry.0 += 1;
                    entry.2.insert(call.path);
                    if only.as_deref() == Some(call.slice.name()) {
                        println!("owed {key}: {} {}", want.0, want.1);
                    }
                } else {
                    differ.push(format!(
                        "{key}:\n  ts:   {} {}\n  rust: {} {}",
                        want.0, want.1, got.0, got.1
                    ));
                }
            }
        }
    }
    let recorded = g.answers.len();
    assert_eq!(
        sent, recorded,
        "every recorded request is sent, and nothing else"
    );
    println!("wire replay: {sent} answers, {same} the same");
    println!("  held byte for byte by the door: {held:?}");
    for (slice, (n, of, calls)) in &owed {
        println!(
            "  owed by {:<12} {n:>4} of {of:>4} answers, over {} calls",
            slice.name(),
            calls.len()
        );
    }
    for d in differ.iter().take(30) {
        println!("{d}");
    }
    assert!(
        differ.is_empty(),
        "{} answers differ and are not owed by a slice",
        differ.len()
    );
    if let Some(s) = strict {
        let left: usize = owed
            .iter()
            .filter(|(k, _)| k.name() == s)
            .map(|(_, v)| v.0)
            .sum();
        assert_eq!(left, 0, "the {s} slice still owes {left} answers");
    }
}
