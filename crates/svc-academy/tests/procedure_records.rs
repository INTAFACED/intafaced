//! The door against svc-academy's written records (`packages/contracts/src/academy-*-procedures.ts`), read from the
//! contracts' published schema (`packages/contracts/procedures.schema.json`), so a record added there is held here at
//! once with no edit. For every tRPC record: the door serves its path, as the same query or mutation, under the same
//! scope; each refusal it names is a catalogue code (`door/errors_table.rs`) sent with the status it names; and each of
//! its samples, sent by an operator holding every scope, is refused 400 at the door exactly when the record refuses it
//! (an accepted one may still be refused by its handler, never for its input).
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
use svc_academy::door::errors_table::ERRORS;
use svc_academy::door::{self, AcademyDoor, Access, DoorConfig, Kind};
use svc_academy::ports::{Ports, StubApprovals};
use svc_academy::settings::Settings;

const SCHEMA: &str = include_str!("../../../packages/contracts/procedures.schema.json");
const SECRET: &str = "an-academy-procedure-records-edge-secret";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const SCOPES: [&str; 5] = [
    "academy:read",
    "academy:write",
    "admin:read",
    "admin:write",
    "admin:compliance",
];

fn text(v: &Json, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// svc-academy's tRPC records by name.
fn records() -> Vec<(String, Json)> {
    let schema = json::parse(SCHEMA).unwrap();
    let Some(Json::Object(procedures)) = schema.get("procedures") else {
        panic!("no procedures");
    };
    procedures
        .iter()
        .filter(|(_, r)| {
            text(r, "service").as_deref() == Some("svc-academy")
                && text(r, "transport").as_deref() == Some("trpc")
        })
        .map(|(n, r)| (n.clone(), r.clone()))
        .collect()
}

/// A door over a database that is down: what the door decides (input, scope) is answered; a handler fails, never 400.
fn serve() -> AcademyDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut ports = Ports::unwired();
    ports.approvals = Box::new(StubApprovals("records-operator".to_owned()));
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        env,
        store: Store::Down("procedure records: the database is down".to_owned()),
        ports,
        settings: Settings::empty(),
        now: || Instant(1_795_046_400_000),
    })
    .unwrap()
}

fn headers() -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        (
            "scopes",
            Json::Array(SCOPES.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(USER)),
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

fn encode(s: &str) -> String {
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

fn send(door: &AcademyDoor, path: &str, query: bool, input: Option<&str>) -> (u16, String) {
    let mut headers = headers();
    let (method, url, body) = if query {
        let q = input
            .map(|i| format!("?input={}", encode(i)))
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
    (res.status, res.body)
}

#[test]
fn each_record_is_the_call_the_door_serves() {
    let records = records();
    assert!(records.len() >= 40, "{} svc-academy records", records.len());
    for (name, record) in &records {
        let path = text(record, "path").unwrap();
        let call = door::call(&path).unwrap_or_else(|| panic!("{name}: the door serves no {path}"));
        let kind = match call.kind {
            Kind::Query => "query",
            Kind::Mutation => "mutation",
        };
        assert_eq!(
            text(record, "kind").as_deref(),
            Some(kind),
            "{name}: {path} is a {kind} at the door"
        );
        let access = record.get("access").unwrap();
        match call.access {
            Access::Public => {
                assert_eq!(text(access, "caller").as_deref(), Some("public"), "{name}")
            }
            Access::Scope(scope) => {
                assert_eq!(text(access, "caller").as_deref(), Some("scope"), "{name}");
                assert_eq!(
                    text(access, "scope").as_deref(),
                    Some(scope),
                    "{name}: the door asks {scope}"
                );
            }
        }
    }
}

#[test]
fn each_named_refusal_is_sent_with_its_status() {
    for (name, record) in records() {
        let path = text(&record, "path").unwrap();
        let Some(Json::Object(refusals)) = record.get("refusals") else {
            panic!("{name}: no refusals");
        };
        if !refusals.is_empty() {
            // An unguarded call sends every refusal as a 500 with its code: it names none.
            assert!(
                door::call(&path).unwrap().guarded,
                "{name}: {path} is unguarded, so it sends no named refusal"
            );
        }
        for (code, status) in refusals {
            let row = ERRORS
                .iter()
                .find(|(c, ..)| c == code)
                .unwrap_or_else(|| panic!("{name}: {code} is not in the catalogue"));
            assert_eq!(
                Some(row.1),
                match status {
                    Json::String(s) => Some(s.as_str()),
                    _ => None,
                },
                "{name}: {code} is sent as {}",
                row.1
            );
        }
    }
}

#[test]
fn each_record_sample_reaches_its_verdict_at_the_door() {
    let door = serve();
    let mut checked = 0;
    for (name, record) in records() {
        let path = text(&record, "path").unwrap();
        let query = text(&record, "kind").as_deref() == Some("query");
        let Some(Json::Array(samples)) = record.get("samples") else {
            panic!("{name} has no samples");
        };
        for (i, sample) in samples.iter().enumerate() {
            let input = sample.get("input").map(Json::compact);
            let (status, body) = send(&door, &path, query, input.as_deref());
            let refuse = text(sample, "verdict").as_deref() == Some("refuse");
            let label = format!("{name} #{i} {}", input.unwrap_or_default());
            if refuse {
                assert_eq!(status, 400, "{label}: {body}");
            } else {
                assert_ne!(status, 400, "{label}: {body}");
            }
            checked += 1;
        }
    }
    assert!(checked >= 90, "{checked} samples");
    println!("procedure records: {checked} samples checked at the door");
}
