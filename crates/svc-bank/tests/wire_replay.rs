//! The wire replay. `services/svc-bank/src/wire-replay.golden/` is what the TypeScript service answered (through the
//! production Fastify adapter, every dependency a stub) to every tRPC call and every REST door `index.ts` mounts through
//! an exported register function, with six inputs (absent, null, a wrong type, empty, the schema's sample, the sample
//! with every field null), from five people (nobody, a person holding no scope, a verified customer, a holder of every
//! scope, the same in the US) and seven signed services. This sends the same requests, built the same way, to the Rust
//! door.
//!
//! An answer the door decides must match byte for byte: every route and method refusal, every 401, every scope, tier,
//! region, job and service 403, every input 400, the REST doors' refusals and the door's own call (`health`). Any other
//! answer is the handler's: while the Rust door answers it "not ported" it is owed by the call's slice, counted and
//! printed, and fails nothing. One difference that is not owed fails the test.
//!
//! For one slice: `WIRE_REPLAY_SLICE=<slice> cargo test -p svc-bank --test it -- wire_replay:: --nocapture` prints that
//! slice's owed answers, and `WIRE_REPLAY_STRICT=<slice>` also fails while it owes any.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::door::rest::DOORS;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth, Slice};

const SECRET: &str = "a-bank-wire-replay-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-wire-replay-internal-secret-long-enough";
const USER: &str = "11111111-1111-4111-8111-111111111111";

/// `SCOPES` (`packages/auth/src/scopes.ts`), in its order: the `all` caller holds every one.
const SCOPES: [&str; 51] = [
    "identity:read",
    "identity:write",
    "ledger:read",
    "trade:read",
    "trade:write",
    "trade:withdraw",
    "copy:lead",
    "copy:follow",
    "pay:read",
    "pay:write",
    "pay:refund",
    "pay:payout",
    "pay:onboard",
    "p2p:read",
    "p2p:write",
    "token:read",
    "token:stake",
    "blueprint:read",
    "blueprint:write",
    "bank:read",
    "bank:write",
    "bank:card",
    "launch:read",
    "launch:write",
    "market:read",
    "market:write",
    "market:ops",
    "academy:read",
    "academy:write",
    "agents:read",
    "agents:execute",
    "notify:read",
    "notify:write",
    "support:read",
    "support:write",
    "support:ops",
    "support:lookup",
    "tax:read",
    "tax:write",
    "campaigns:read",
    "campaigns:write",
    "campaigns:ops",
    "ops:read",
    "ops:write",
    "protocol:read",
    "quant:read",
    "quant:run",
    "admin:read",
    "admin:write",
    "admin:treasury",
    "admin:compliance",
];

struct Caller {
    name: &'static str,
    scopes: Option<&'static [&'static str]>,
    tier: &'static str,
    mfa: bool,
    region: &'static str,
}

/// The people, in the recording's order.
const CALLERS: [Caller; 5] = [
    Caller {
        name: "anon",
        scopes: None,
        tier: "none",
        mfa: false,
        region: "DE",
    },
    Caller {
        name: "no-scope",
        scopes: Some(&[]),
        tier: "basic",
        mfa: false,
        region: "DE",
    },
    Caller {
        name: "customer",
        scopes: Some(&["bank:read", "bank:write"]),
        tier: "full",
        mfa: true,
        region: "DE",
    },
    Caller {
        name: "all",
        scopes: Some(&SCOPES),
        tier: "full",
        mfa: true,
        region: "DE",
    },
    Caller {
        name: "all-US",
        scopes: Some(&SCOPES),
        tier: "full",
        mfa: true,
        region: "US",
    },
];

/// The signed services, in the recording's order.
const SERVICES: [&str; 7] = [
    "svc-bank",
    "svc-ops",
    "svc-identity",
    "svc-agents",
    "svc-pay",
    "svc-support",
    "svc-tax",
];

fn serve() -> BankDoor {
    // The TypeScript replay's process: vitest's NODE_ENV and svc-bank's vitest env.
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("LEDGER_CUSTODY_LAYER", "on"),
        ("NODE_ENV", "test"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            // The replay's context binds the body as `accept-both`.
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        // The replay's `sql` is a stub that refuses every query with its own name.
        store: svc_bank::db::Store::Down("replay stub: sql".to_owned()),
    })
    .unwrap()
    // The TypeScript replay's `activity` options: a history port (a stub that throws) and the cursor secret.
    .with_activity(svc_bank::activity::Wiring {
        pages: Box::new(svc_bank::activity::pages::NoPages),
        cursor_secret: Some(INTERNAL.to_owned()),
        ..svc_bank::activity::Wiring::none()
    })
    // The TypeScript replay's `receiptSecret`: the card programme's exports are signed under it.
    .with_card_programme(svc_bank::card_programme::Wiring {
        export_secret: Some(INTERNAL.to_owned()),
        ..svc_bank::card_programme::Wiring::none()
    })
}

/// `encodePrincipal` of the replay's principal, signed for the caller's region.
fn person(c: &Caller) -> Vec<(String, String)> {
    let Some(scopes) = c.scopes else {
        return Vec::new();
    };
    let raw = Json::Object(
        [
            ("sub", Json::str(USER)),
            (
                "scopes",
                Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
            ),
            ("tier", Json::str(c.tier)),
            ("mfa", Json::Bool(c.mfa)),
            ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
            ("userId", Json::str(USER)),
            ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect(),
    )
    .compact();
    let sig = edge::sign(&raw, SECRET, c.region).unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), c.region.to_owned()),
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

/// The replay's masks: tRPC's stack trace as `<stack>`, an opaque failure's fresh reference as `<ref>`.
fn mask(body: &str) -> String {
    let key = "\"stack\":\"";
    let mut out = body.to_owned();
    if let Some(at) = out.find(key) {
        let after = &out[at + key.len()..];
        let bytes = after.as_bytes();
        let mut end = 0;
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        out = format!("{}<stack>{}", &out[..at + key.len()], &after[end..]);
    }
    let reference = "Bank operation failed (ref ";
    if let Some(at) = out.find(reference) {
        let start = at + reference.len();
        if let Some(len) = out[start..].find(')') {
            out = format!("{}<ref>{}", &out[..start], &out[start + len..]);
        }
    }
    out
}

/// One request as the TypeScript replay's `send` sends it: `payload` is `None` for no body (a query, a GET).
fn send(
    door: &BankDoor,
    method: &str,
    url: &str,
    payload: Option<&str>,
    mut h: Vec<(String, String)>,
) -> (u16, String) {
    if payload.is_some() {
        h.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = door.handle_as(
        &Request {
            method,
            url,
            headers: &h,
            body: payload.unwrap_or(""),
        },
        "replay-request",
    );
    (res.status, mask(&res.body))
}

struct Golden {
    callers: Vec<(String, String, String)>,
    /// Per call or REST door: the `sample` and `sample-nulls` JSON texts.
    inputs: BTreeMap<String, (String, String)>,
    answers: BTreeMap<String, (u16, String)>,
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        _ => panic!("no {k}"),
    }
}

fn golden() -> Golden {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../services/svc-bank/src/wire-replay.golden");
    let callers = json::parse(&std::fs::read_to_string(dir.join("callers.json")).unwrap()).unwrap();
    let Json::Array(callers) = callers else {
        panic!("callers.json")
    };
    let mut g = Golden {
        callers: callers
            .iter()
            .map(|c| (s(c, "path"), s(c, "type"), s(c, "caller")))
            .collect(),
        inputs: BTreeMap::new(),
        answers: BTreeMap::new(),
    };
    g.callers.sort();
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|f| f.extension().is_some_and(|e| e == "json"))
        .filter(|f| !f.ends_with("callers.json"))
        .collect();
    files.sort();
    for file in files {
        let part = json::parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let Some(Json::Object(inputs)) = part.get("inputs") else {
            panic!()
        };
        for (k, v) in inputs {
            g.inputs
                .insert(k.clone(), (s(v, "sample"), s(v, "sample-nulls")));
        }
        let Some(Json::Array(bodies)) = part.get("bodies") else {
            panic!()
        };
        let Some(Json::Object(answers)) = part.get("answers") else {
            panic!()
        };
        for (call, by) in answers {
            let Json::Object(by) = by else { panic!() };
            for (k, a) in by {
                let Json::Array(pair) = a else { panic!() };
                let (Json::Number(st), Json::Number(i)) = (&pair[0], &pair[1]) else {
                    panic!()
                };
                let Json::String(body) = &bodies[format!("{i}").parse::<usize>().unwrap()] else {
                    panic!()
                };
                g.answers.insert(
                    format!("{call} {k}"),
                    (format!("{st}").parse().unwrap(), body.clone()),
                );
            }
        }
    }
    g
}

/// The six inputs of a call, as the TypeScript replay builds them: `None` is absent, else the JSON text sent.
fn inputs(samples: &(String, String)) -> [(&'static str, Option<String>); 6] {
    [
        ("absent", None),
        ("null", Some("null".to_owned())),
        ("wrong-type", Some("7".to_owned())),
        ("empty", Some("{}".to_owned())),
        ("sample", Some(json::parse(&samples.0).unwrap().compact())),
        (
            "sample-nulls",
            Some(json::parse(&samples.1).unwrap().compact()),
        ),
    ]
}

/// Who sends a request: a person's headers, or a service's signature over the body.
fn senders(payload: &str) -> Vec<(&'static str, Vec<(String, String)>)> {
    let mut out: Vec<_> = CALLERS.iter().map(|c| (c.name, person(c))).collect();
    for svc in SERVICES {
        out.push((
            svc,
            s2s::legacy_headers(svc, INTERNAL, payload, system_seconds()).unwrap(),
        ));
    }
    out
}

fn message(body: &str) -> String {
    match json::parse(body)
        .ok()
        .and_then(|b| b.get("error").and_then(|e| e.get("message")).cloned())
    {
        Some(Json::String(m)) => m,
        _ => String::new(),
    }
}

/// Whether the door itself decides this recorded tRPC answer: a 401, tRPC's own 404, a zod 400, a guard's or a caller's
/// 403. A 404 with a cause (`This invite link is not known.`) is the handler's.
fn door_decides(call: &door::Call, status: u16, body: &str) -> bool {
    let m = message(body);
    call.slice == Slice::Door
        || status == 401
        || (status == 404 && m.starts_with("No procedure found on path"))
        || (status == 400 && m.starts_with('['))
        || (status == 403
            && (body.contains("\"intafacedCode\":")
                || m == "A signed-in user session is required"
                || m == "This service is not allowed to call this procedure"
                || m == "ops job is callable only as svc-bank"
                || m.starts_with("One of ")))
}

#[derive(Default)]
struct Tally {
    sent: usize,
    same: usize,
    held: BTreeMap<u16, usize>,
    owed: BTreeMap<Slice, (usize, usize, BTreeSet<String>)>,
    differ: Vec<String>,
}

impl Tally {
    fn judge(
        &mut self,
        key: &str,
        slice: Slice,
        decides: bool,
        want: &(u16, String),
        got: (u16, String),
        only: Option<&str>,
    ) {
        self.sent += 1;
        let entry = self.owed.entry(slice).or_default();
        entry.1 += 1;
        if &got == want {
            self.same += 1;
            if decides {
                *self.held.entry(want.0).or_default() += 1;
            }
            return;
        }
        let not_ported = got.0 == 500
            && got
                .1
                .contains(&format!("the {} slice is not ported", slice.name()));
        if not_ported && !decides {
            entry.0 += 1;
            entry
                .2
                .insert(key.split(' ').next().unwrap_or("").to_owned());
            if only == Some(slice.name()) {
                println!("owed {key}: {} {}", want.0, want.1);
            }
        } else {
            self.differ.push(format!(
                "{key}:\n  ts:   {} {}\n  rust: {} {}",
                want.0, want.1, got.0, got.1
            ));
        }
    }
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
    let mut t = Tally::default();
    let want = |key: &str| {
        g.answers
            .get(key)
            .unwrap_or_else(|| panic!("no recorded answer for {key}"))
            .clone()
    };
    for call in door::calls::CALLS.iter() {
        let samples = g
            .inputs
            .get(call.path)
            .unwrap_or_else(|| panic!("no recorded inputs for {}", call.path));
        for (input_name, input) in inputs(samples) {
            let (method, url, payload) = match call.kind {
                Kind::Query => (
                    "GET",
                    match &input {
                        Some(i) => format!("/trpc/{}?input={}", call.path, encode_uri_component(i)),
                        None => format!("/trpc/{}", call.path),
                    },
                    None,
                ),
                Kind::Mutation => (
                    "POST",
                    format!("/trpc/{}", call.path),
                    Some(input.clone().unwrap_or_default()),
                ),
            };
            for (who, h) in senders(payload.as_deref().unwrap_or("")) {
                let key = format!("{} {input_name} {who}", call.path);
                let w = want(&key);
                let got = send(&door, method, &url, payload.as_deref(), h);
                t.judge(
                    &key,
                    call.slice,
                    door_decides(call, w.0, &w.1),
                    &w,
                    got,
                    only.as_deref(),
                );
            }
        }
    }
    // The REST doors: each recorded refusal is the door's own; an accepted body is its slice's.
    for rest in &DOORS {
        let name = rest.name();
        let samples = g
            .inputs
            .get(&name)
            .unwrap_or_else(|| panic!("no recorded inputs for {name}"));
        for (input_name, input) in inputs(samples) {
            let payload = input.unwrap_or_default();
            for (who, h) in senders(&payload) {
                let key = format!("{name} {input_name} {who}");
                let w = want(&key);
                let got = send(&door, "POST", rest.path, Some(&payload), h);
                let decides = w.0 != 200 && w.0 != 503;
                t.judge(&key, rest.slice, decides, &w, got, only.as_deref());
            }
        }
    }

    let recorded = g.answers.len();
    assert_eq!(
        t.sent, recorded,
        "every recorded request is sent, and nothing else"
    );
    println!("wire replay: {} answers, {} the same", t.sent, t.same);
    println!("  held byte for byte by the door: {:?}", t.held);
    for (slice, (n, of, calls)) in &t.owed {
        println!(
            "  owed by {:<16} {n:>5} of {of:>5} answers, over {} calls",
            slice.name(),
            calls.len()
        );
    }
    for d in t.differ.iter().take(30) {
        println!("{d}");
    }
    assert!(
        t.differ.is_empty(),
        "{} answers differ and are not owed by a slice",
        t.differ.len()
    );
    if let Some(s) = strict {
        let left: usize = t
            .owed
            .iter()
            .filter(|(k, _)| k.name() == s)
            .map(|(_, v)| v.0)
            .sum();
        assert_eq!(left, 0, "the {s} slice still owes {left} answers");
    }
}
