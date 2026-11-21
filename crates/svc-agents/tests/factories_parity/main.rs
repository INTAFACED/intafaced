//! The factories slice held to the TypeScript's answers: every case of `tests/fixtures/factories/<factory>.golden.json`
//! (written by `scripts/record-factories.mjs` from the TypeScript router) sent through the Rust door as the person it
//! names, under the tier laws it names, at the recording's fixed clock, with the port double it names; the answer's data,
//! or its error's code and message, must be the recorded one.
//!
//! The metered runs past their free refusals open a session, and are `tests/factories_pg.rs`'.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod copy_intel;
mod merchant;
mod scanner;
mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_agents::db::Store;
use svc_agents::door::{self, AgentsDoor, DoorConfig, Kind, ServiceAuth};
use svc_agents::factories::Factories;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::readiness::ReadyInput;
use svc_agents::runtime::Runtime;
use svc_agents::runtime::eligibility::parse_tier_laws;

const SECRET: &str = "placeholder-agents-record-factories-edge-secret";
const USER: &str = "11111111-1111-4111-8111-111111111111";

/// 2026-11-19T00:00:00Z, the recording's fixed clock.
fn now() -> Instant {
    Instant(1_795_046_400_000)
}

/// A fetch that answers every request with one recorded reply (`{ status, body }`, or `{ throws: true }`), and keeps
/// the requests it was sent.
pub struct FakeFetch {
    pub reply: Json,
    pub sent: Mutex<Vec<HttpRequest>>,
}

impl FakeFetch {
    pub fn new(reply: &Json) -> Arc<FakeFetch> {
        Arc::new(FakeFetch {
            reply: reply.clone(),
            sent: Mutex::new(Vec::new()),
        })
    }
}

impl Fetch for FakeFetch {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.sent.lock().unwrap().push(req.clone());
        if self.reply.get("throws") == Some(&Json::Bool(true)) {
            return Err(FetchError {
                message: "fetch failed".to_owned(),
            });
        }
        let status = match self.reply.get("status") {
            Some(Json::Number(n)) => format!("{n}").parse().unwrap(),
            _ => 200,
        };
        Ok(HttpResponse {
            status,
            body: self.reply.get("body").map_or(String::new(), Json::compact),
        })
    }
}

fn serve(laws: Option<&str>, factories: Factories) -> AgentsDoor {
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
        ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    let mut runtime = Runtime::unwired();
    runtime.tier_laws = parse_tier_laws(laws).unwrap();
    AgentsDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth::unwired(),
        env,
        now,
        store: Store::Down("svc-agents: the factories parity has no database".to_owned()),
        gateway: GatewaySlice::unwired("fixture-asset"),
        ready: ReadyInput::unwired(),
        metering: svc_agents::metering::Metering::unwired("USDC", 60),
        runtime,
        advisors: svc_agents::advisors::Advisors::unwired(),
    })
    .unwrap()
    .with_factories(factories)
}

fn headers(scopes: &[Json], tier: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        ("userId", Json::str(USER)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("scopes", Json::Array(scopes.to_vec())),
        ("tier", Json::str(tier)),
        ("mfa", Json::Bool(false)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

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

/// The call through the door, read back as the caller sees it: `{ data }` or `{ error: { code, message } }`.
fn send(door: &AgentsDoor, path: &str, input: Option<&Json>, scopes: &[Json], tier: &str) -> Json {
    let call = door::call(path).unwrap_or_else(|| panic!("no call {path}"));
    let mut h = headers(scopes, tier);
    let (method, url, body) = match call.kind {
        Kind::Query => (
            "GET",
            match input {
                Some(i) => format!("/trpc/{path}?input={}", encode_uri_component(&i.compact())),
                None => format!("/trpc/{path}"),
            },
            String::new(),
        ),
        Kind::Mutation => {
            h.push(("content-type".to_owned(), "application/json".to_owned()));
            (
                "POST",
                format!("/trpc/{path}"),
                input.map_or(String::new(), Json::compact),
            )
        }
    };
    let res = door.handle(&Request {
        method,
        url: &url,
        headers: &h,
        body: &body,
    });
    let parsed = json::parse(&res.body).unwrap();
    if res.status == 200 {
        let data = parsed
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null);
        return Json::obj([("data", data)]);
    }
    let e = parsed.get("error").unwrap();
    Json::obj([(
        "error",
        Json::obj([
            (
                "code",
                e.get("data").and_then(|d| d.get("code")).cloned().unwrap(),
            ),
            ("message", e.get("message").cloned().unwrap()),
        ]),
    )])
}

fn ports(factory: &str, port: Option<&Json>) -> Factories {
    let Some(port) = port else {
        return Factories::unwired();
    };
    match factory {
        "scanner" => scanner::ports(port),
        "support" => support::ports(port),
        "copyIntel" => copy_intel::ports(port),
        "merchant" => merchant::ports(port),
        other => panic!("no port double for {other}"),
    }
}

#[test]
fn every_recorded_case_gets_the_recorded_answer() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/factories");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    let mut sent = 0;
    let mut differ = Vec::new();
    for file in &files {
        let factory = file
            .file_name()
            .unwrap()
            .to_string_lossy()
            .trim_end_matches(".golden.json")
            .to_owned();
        let golden = json::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
        let Some(Json::Array(cases)) = golden.get("cases") else {
            panic!("{factory}: no cases")
        };
        for c in cases {
            let s = |k: &str| match c.get(k) {
                Some(Json::String(v)) => Some(v.clone()),
                _ => None,
            };
            let name = s("name").unwrap();
            let path = s("path").unwrap();
            let Some(Json::Array(scopes)) = c.get("scopes") else {
                panic!("{name}: scopes")
            };
            let door = serve(s("laws").as_deref(), ports(&factory, c.get("port")));
            let got = send(&door, &path, c.get("input"), scopes, &s("tier").unwrap());
            sent += 1;
            let want = c.get("answer").unwrap();
            if &got != want {
                differ.push(format!(
                    "{factory} {name}:\n  ts:   {}\n  rust: {}",
                    want.compact(),
                    got.compact()
                ));
            }
        }
    }
    println!("factories parity: {sent} cases, {} differ", differ.len());
    for d in &differ {
        println!("{d}");
    }
    assert!(differ.is_empty(), "{} cases differ", differ.len());
}
