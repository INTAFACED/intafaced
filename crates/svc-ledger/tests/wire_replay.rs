//! The wire replay. `tests/fixtures/wire-replay.golden/` is what the TypeScript service's served doors
//! answered (`wire-replay.test.ts`): every route `index.ts` registers, six bodies, every caller kind, under three
//! settings (`blank`: the shared secret alone; `set-dual` and `set-keypair`: per-service keys in each mode), with the
//! database and the bus refusing every call. This sends the same requests, built the same way (signed with fresh
//! keys and a fresh clock, as the TypeScript replay signs them), to the Rust door.
//!
//! An answer the door decides must match byte for byte: every 404, every Fastify body refusal, every 401 and 403 of a
//! service's signature or caller list, every operator token and scope refusal, and every refusal of a door's first
//! input check. Any other answer is a slice's: the door names the slice that owes it, and it is counted, printed and
//! fails nothing. One difference the door decided fails the test.
//!
//! `WIRE_REPLAY_SLICE=<slice> cargo test -p svc-ledger --test wire_replay -- --nocapture` prints that slice's owed
//! answers, and `WIRE_REPLAY_STRICT=<slice>` also fails while it owes any. The recording is read from the TypeScript
//! service while it exists; the switch copies it here before that service is deleted.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::json::{self, Json};
use service_kit::s2s::{self, KeyringEntry, Mode, ServiceSigner, SignedContext, system_seconds};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::Request;
use service_kit::tokens::TokenConfig;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use svc_ledger::db::Store;
use svc_ledger::door::{DoorConfig, Keys, LedgerDoor, Outcome, ROUTES, Slice};
use svc_ledger::posting::Posting;
use svc_ledger::posting::engine::{Conflict, EngineOptions};

const SHARED: &str = "placeholder-ledger-wire-replay-internal-secret";
const ID: &str = "22222222-2222-4222-8222-222222222222";
const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
const TOKEN_SECRET: &str = "placeholder-ledger-wire-replay-operator-secret";

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wire-replay.golden")
}

/// One recorded answer.
struct Recorded {
    key: String,
    status: u16,
    body: String,
}

/// The recording: its routes, each body-taking route's two sample bodies, and every answer.
struct Golden {
    routes: Vec<String>,
    inputs: BTreeMap<String, (String, String)>,
    answers: Vec<Recorded>,
}

fn read_golden() -> Golden {
    let dir = golden_dir();
    let routes_doc =
        json::parse(&std::fs::read_to_string(dir.join("routes.json")).unwrap()).unwrap();
    let Some(Json::Array(routes)) = routes_doc.get("routes") else {
        panic!("routes")
    };
    let routes = routes
        .iter()
        .map(|r| match r {
            Json::String(s) => s.clone(),
            _ => panic!("a route is text"),
        })
        .collect();
    let Some(Json::Object(inputs)) = routes_doc.get("inputs") else {
        panic!("inputs")
    };
    let text = |j: &Json, k: &str| match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        _ => panic!("sample {k}"),
    };
    let inputs = inputs
        .iter()
        .map(|(k, v)| (k.clone(), (text(v, "sample"), text(v, "sample-nulls"))))
        .collect();
    let mut answers = Vec::new();
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    for file in files
        .iter()
        .filter(|f| f.file_name().is_some_and(|n| n != "routes.json"))
    {
        let doc = json::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
        let Some(Json::Array(bodies)) = doc.get("bodies") else {
            panic!("bodies")
        };
        let Some(Json::Object(rows)) = doc.get("answers") else {
            panic!("answers")
        };
        for (key, row) in rows {
            let Json::Array(row) = row else {
                panic!("an answer is [status, body]")
            };
            let (Json::Number(status), Json::Number(i)) = (&row[0], &row[1]) else {
                panic!("status and body")
            };
            let Json::String(body) = &bodies[format!("{i}").parse::<usize>().unwrap()] else {
                panic!("a body is text")
            };
            answers.push(Recorded {
                key: key.clone(),
                status: format!("{status}").parse().unwrap(),
                body: body.clone(),
            });
        }
    }
    Golden {
        routes,
        inputs,
        answers,
    }
}

/// A PKCS8 DER Ed25519 private key around a seed, base64url, as `generateKeyPairSync('ed25519')` exports one.
fn pkcs8(seed: &[u8; 32]) -> String {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    URL_SAFE_NO_PAD.encode(der)
}

/// Keys for every service the recording names, and the keyring the ledger verifies them by.
struct KeySet {
    signers: BTreeMap<String, ServiceSigner>,
    keyring: Vec<KeyringEntry>,
}

fn keys(services: &[String], salt: &str) -> KeySet {
    let mut keyring = Vec::new();
    let mut private = Vec::new();
    for svc in services {
        let seed: [u8; 32] = Sha256::digest(format!("{salt}:{svc}")).into();
        let public = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key();
        keyring.push(KeyringEntry {
            kid: format!("{svc}.a"),
            svc: svc.clone(),
            use_: "s2s".to_owned(),
            x: URL_SAFE_NO_PAD.encode(public.as_bytes()),
        });
        private.push((svc.clone(), pkcs8(&seed)));
    }
    let signers = private
        .into_iter()
        .map(|(svc, key)| {
            let signer = ServiceSigner::new(&svc, &format!("{svc}.a"), &key, &keyring).unwrap();
            (svc, signer)
        })
        .collect();
    KeySet { signers, keyring }
}

fn door(mode: Option<Mode>, keyring: &[KeyringEntry]) -> LedgerDoor {
    LedgerDoor::new(DoorConfig {
        internal_secret: SHARED.to_owned(),
        body_bind: BodyBind::Require,
        keys: mode.map(|mode| Keys {
            verifier: ServiceVerifier::new("svc-ledger", keyring, system_seconds).unwrap(),
            mode,
        }),
        tokens: TokenConfig {
            secret: TOKEN_SECRET.to_owned(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        // The TypeScript replay's `sql` stub throws this on every query.
        store: Store::Down("replay stub: sql".to_owned()),
        service_name: "svc-ledger".to_owned(),
        bus: std::sync::Arc::new(svc_ledger::freeze::MemoryBus::default()),
        approvals: Box::new(svc_ledger::approval::Unwired),
        clock_skew_bound_ms: None,
        now_ms: svc_ledger::clock::system_ms,
        log: service_kit::telemetry::Logger::new("info", Box::new(std::io::sink())),
        custody: svc_ledger::reconcile::CustodyLayer::On,
        reconcile_statement_timeout_ms: svc_ledger::reconcile::DEFAULT_STATEMENT_TIMEOUT_MS,
        indexer_url: None,
        fetch: std::sync::Arc::new(service_kit::http::UreqFetch::new()),
        posting: Posting::new(
            Arc::new(svc_ledger::freeze::MemoryBus::default()),
            "svc-ledger".to_owned(),
            false,
            EngineOptions {
                conflict: Conflict::Refuse,
                clock_skew_bound_ms: None,
                clock_ms: || 0,
            },
            mode.is_some(),
            None,
        ),
        reconciliation_sources: Arc::new(svc_ledger::controls::sources::Unset),
    })
    .unwrap()
}

/// `issueAccessToken` for the replay's operator, with these scopes and second factor.
fn bearer(scopes: &[&str], mfa: bool) -> String {
    let now = system_seconds();
    let b64 = |j: Json| URL_SAFE_NO_PAD.encode(j.compact());
    let header = b64(Json::obj([
        ("alg", Json::str("HS256")),
        ("typ", Json::str("JWT")),
    ]));
    let claims = b64(Json::obj([
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("basic")),
        ("mfa", Json::Bool(mfa)),
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
        ("sub", Json::str(OPERATOR)),
        ("iss", Json::str("intafaced")),
        ("aud", Json::str("intafaced.api")),
        ("iat", Json::int(now)),
        ("exp", Json::int(now + 900)),
        ("jti", Json::str("44444444-4444-4444-8444-444444444444")),
    ]));
    let mut mac = Hmac::<Sha256>::new_from_slice(TOKEN_SECRET.as_bytes()).unwrap();
    mac.update(format!("{header}.{claims}").as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("Bearer {header}.{claims}.{sig}")
}

/// The operator callers, by the names the recording gives them.
fn operator_header(caller: &str) -> Option<String> {
    match caller {
        "anon" => None,
        "bad-token" => Some("Bearer not-a-token".to_owned()),
        "no-scope" => Some(bearer(&[], true)),
        "read-mfa" => Some(bearer(&["admin:read"], true)),
        "compliance" => Some(bearer(&["admin:compliance"], true)),
        "treasury-no-mfa" => Some(bearer(&["admin:treasury"], false)),
        "treasury-mfa" => Some(bearer(&["admin:treasury"], true)),
        other => panic!("an operator caller the replay does not make: {other}"),
    }
}

/// The body sent under each recorded body name.
fn payload(body: &str, samples: Option<&(String, String)>) -> String {
    match body {
        "absent" => String::new(),
        "null" => "null".to_owned(),
        "wrong-type" => "7".to_owned(),
        "empty" => "{}".to_owned(),
        "sample" => samples.map_or("{}".to_owned(), |s| s.0.clone()),
        "sample-nulls" => samples.map_or("{}".to_owned(), |s| s.1.clone()),
        other => panic!("a body the replay does not send: {other}"),
    }
}

/// A recorded answer only the door gives: a 401, a 403, a 404, or Fastify's own refusal of the body.
fn door_class(a: &Recorded) -> bool {
    matches!(a.status, 401 | 403 | 404) || a.body.contains("\"code\":\"FST_ERR_")
}

fn slice_of(name: &str) -> Option<Slice> {
    Slice::ALL.into_iter().find(|s| s.name() == name)
}

#[test]
fn the_door_answers_every_recorded_request_it_decides_as_the_typescript_does() {
    let golden = read_golden();
    let ours: Vec<String> = {
        let mut r: Vec<String> = ROUTES
            .iter()
            .map(|r| format!("{} {}", r.method, r.path))
            .collect();
        r.sort();
        r
    };
    assert_eq!(
        ours, golden.routes,
        "the Rust door serves exactly the recorded routes"
    );

    let services: Vec<String> = {
        let mut s: Vec<String> = golden
            .answers
            .iter()
            .filter_map(|a| a.key.split_once(" key ").map(|(_, svc)| svc.to_owned()))
            .collect();
        s.sort();
        s.dedup();
        s
    };
    let detail = std::env::var("WIRE_REPLAY_SLICE").ok();
    let strict = std::env::var("WIRE_REPLAY_STRICT").ok();

    let mut same = 0usize;
    let mut held: BTreeMap<u16, usize> = BTreeMap::new();
    let mut owed: BTreeMap<Slice, usize> = BTreeMap::new();
    let mut differ = Vec::new();
    let mut doors: BTreeMap<String, LedgerDoor> = BTreeMap::new();
    let mut signers: BTreeMap<String, KeySet> = BTreeMap::new();
    for (settings, mode) in [
        ("blank", None),
        ("set-dual", Some(Mode::Dual)),
        ("set-keypair", Some(Mode::Keypair)),
    ] {
        let k = keys(&services, settings);
        doors.insert(settings.to_owned(), door(mode, &k.keyring));
        signers.insert(settings.to_owned(), k);
    }

    for a in &golden.answers {
        let mut parts = a.key.splitn(5, ' ');
        let (settings, method, path, body, caller) = (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        );
        let url = path.replace(":txId", ID).replace(":accountId", ID);
        let route = format!("{method} {path}");
        let takes_body = method != "GET";
        let sent = if takes_body {
            Some(payload(body, golden.inputs.get(&route)))
        } else {
            None
        };
        let text = sent.clone().unwrap_or_default();
        let mut headers: Vec<(String, String)> = if path.starts_with("/trpc/") {
            match caller.split_once(' ') {
                None => Vec::new(),
                Some(("shared", svc)) => {
                    s2s::legacy_headers(svc, SHARED, &text, system_seconds()).unwrap()
                }
                Some(("key", svc)) => signers[settings].signers[svc]
                    .headers(
                        "svc-ledger",
                        method,
                        &url,
                        &text,
                        &SignedContext {
                            principal: None,
                            principal_signature: None,
                            region: None,
                            content_type: Some("application/json".to_owned()),
                        },
                    )
                    .unwrap(),
                Some(other) => panic!("a service caller the replay does not make: {other:?}"),
            }
        } else if path.starts_with("/operator/") {
            operator_header(caller)
                .map(|h| vec![("authorization".to_owned(), h)])
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if sent.is_some() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        let outcome = doors[settings].decide(&Request {
            method,
            url: &url,
            headers: &headers,
            body: &text,
        });
        match outcome {
            Outcome::Answer(r) if r.status == a.status && r.body == a.body => {
                same += 1;
                *held.entry(a.status).or_default() += 1;
            }
            Outcome::Answer(r) => differ.push(format!(
                "{}\n  want {} {}\n  got  {} {}",
                a.key, a.status, a.body, r.status, r.body
            )),
            // Every refusal of who is calling, every route refusal and every body refusal is the door's: a slice can
            // never owe one, so an answer that should have been one shows here as a difference.
            Outcome::Owed(slice) if door_class(a) => differ.push(format!(
                "{}\n  want {} {}\n  got  owed by {}",
                a.key,
                a.status,
                a.body,
                slice.name()
            )),
            Outcome::Owed(slice) => {
                *owed.entry(slice).or_default() += 1;
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
    let total = golden.answers.len();
    let owed_n: usize = owed.values().sum();
    println!(
        "wire replay: {total} answers, {same} the same, {owed_n} owed by a slice, {} differ",
        differ.len()
    );
    println!("  held byte for byte by the door, by status: {held:?}");
    for s in Slice::ALL {
        let n = owed.get(&s).copied().unwrap_or(0);
        println!("  owed by {:<10} {n:>5}", s.name());
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
    if let Some(s) = strict.as_deref().and_then(slice_of) {
        let n = owed.get(&s).copied().unwrap_or(0);
        assert_eq!(n, 0, "slice {} still owes {n} answers", s.name());
    }
}
