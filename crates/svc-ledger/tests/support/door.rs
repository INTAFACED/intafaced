//! The posting doors' Postgres test kit: a fresh migrated book, the Rust door over it (with or without per-service keys,
//! the custody switch either way), callers signing as the services sign, the engine's own post for a test's setup, and
//! the reads the TypeScript tests make through `PostgresLedger` (`balance`, `getTxByKey`). The bodies are the
//! TypeScript recipes' own, recorded by `scripts/record-door-books.mjs` into `fixtures/door-books.golden.json`.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

use std::io::Write;
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use service_kit::json::{self, Json};
use service_kit::money::format_amount;
use service_kit::s2s::{
    KeyringEntry, Mode, ServiceSigner, SignedContext, legacy_headers, system_seconds,
};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::Request;
use service_kit::telemetry::Logger;
use service_kit::tokens::TokenConfig;
use sha2::{Digest, Sha256};
use svc_ledger::db::{Store, with_client};
use svc_ledger::door::{DoorConfig, Keys, LedgerDoor, Outcome};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::migrate::FILES;
use svc_ledger::posting::engine::{Conflict, EngineOptions};
use svc_ledger::posting::{self, Posting, rules};

use super::TestDb;

/// The shared secret every door of the kit accepts.
pub const SECRET: &str = "placeholder-door-books-internal-secret-long";

/// Who a TypeScript test's direct `handleS2sPost(door, body)` call (no caller) is, here: a name on no allowlist, under
/// the shared secret, to a door with no keys, where the caller binding only counts (as `tests/conformance` sent it).
pub const DIRECT: &str = "svc-conformance";

/// The bodies, recorded from the TypeScript recipes.
pub static BOOKS: LazyLock<Json> =
    LazyLock::new(|| json::parse(include_str!("../fixtures/door-books.golden.json")).unwrap());

/// The recorded value at this path (object keys, or array indexes as numbers).
pub fn fx(path: &[&str]) -> Json {
    let mut at: &Json = &BOOKS;
    for p in path {
        at = match (at, p.parse::<usize>()) {
            (Json::Array(items), Ok(i)) => {
                items.get(i).unwrap_or_else(|| panic!("no {p} in {path:?}"))
            }
            _ => at.get(p).unwrap_or_else(|| panic!("no {p} in {path:?}")),
        };
    }
    at.clone()
}

/// The recorded list at this path.
pub fn fx_list(path: &[&str]) -> Vec<Json> {
    match fx(path) {
        Json::Array(items) => items,
        other => panic!("{path:?} is not a list: {}", other.compact()),
    }
}

/// A fresh database with every migration applied.
pub fn migrated() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    Some(db)
}

/// Every line the door's posting slice logged.
#[derive(Clone, Default)]
pub struct Captured(Arc<Mutex<Vec<u8>>>);

impl Captured {
    pub fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// How the door is set up: `S2S_AUTH_MODE` with these services' keys (none: the shared secret alone), and
/// `LEDGER_CUSTODY_LAYER`.
pub struct Setup<'a> {
    pub mode: Option<Mode>,
    pub services: &'a [&'a str],
    pub custody_on: bool,
}

/// The door over one book, and its callers' keys.
pub struct Kit {
    pub door: LedgerDoor,
    url: String,
    pub store: Store,
    pub log: Captured,
    signers: Vec<(String, Arc<ServiceSigner>)>,
}

fn pkcs8(seed: &[u8; 32]) -> String {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    URL_SAFE_NO_PAD.encode(der)
}

/// The fixed engine clock: the unbound warning's once-a-minute window is then deterministic.
fn fixed_ms() -> i64 {
    1_795_000_000_000
}

impl Kit {
    pub fn new(db: &TestDb, setup: &Setup<'_>) -> Kit {
        let seeds: Vec<[u8; 32]> = setup
            .services
            .iter()
            .map(|svc| Sha256::digest(format!("door-books:{svc}")).into())
            .collect();
        let keyring: Vec<KeyringEntry> = setup
            .services
            .iter()
            .zip(&seeds)
            .map(|(svc, seed)| KeyringEntry {
                kid: format!("{svc}.a"),
                svc: (*svc).to_owned(),
                use_: "s2s".to_owned(),
                x: URL_SAFE_NO_PAD.encode(
                    ed25519_dalek::SigningKey::from_bytes(seed)
                        .verifying_key()
                        .as_bytes(),
                ),
            })
            .collect();
        let signers = setup
            .services
            .iter()
            .zip(&seeds)
            .map(|(svc, seed)| {
                (
                    (*svc).to_owned(),
                    Arc::new(
                        ServiceSigner::new(svc, &format!("{svc}.a"), &pkcs8(seed), &keyring)
                            .unwrap(),
                    ),
                )
            })
            .collect();
        let log = Captured::default();
        let bus = Arc::new(MemoryBus::default());
        let posting = Posting::new(
            bus.clone(),
            "svc-ledger".to_owned(),
            setup.custody_on,
            EngineOptions {
                conflict: Conflict::Refuse,
                clock_skew_bound_ms: None,
                clock_ms: fixed_ms,
            },
            setup.mode.is_some(),
            Some(Logger::new("warn", Box::new(log.clone()))),
        );
        let door = LedgerDoor::new(DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: setup.mode.map(|mode| Keys {
                verifier: ServiceVerifier::new("svc-ledger", &keyring, system_seconds).unwrap(),
                mode,
            }),
            tokens: TokenConfig {
                secret: "placeholder-door-books-token-secret-long".to_owned(),
                issuer: "intafaced".to_owned(),
                audience: "intafaced.api".to_owned(),
                key_id: None,
                verify_only: Vec::new(),
            },
            clock: system_seconds,
            store: db.store(),
            service_name: "svc-ledger".to_owned(),
            bus,
            approvals: Box::new(svc_ledger::approval::Unwired),
            clock_skew_bound_ms: None,
            now_ms: svc_ledger::clock::system_ms,
            log: Logger::new("info", Box::new(std::io::sink())),
            custody: if setup.custody_on {
                svc_ledger::reconcile::CustodyLayer::On
            } else {
                svc_ledger::reconcile::CustodyLayer::Off
            },
            reconcile_statement_timeout_ms: svc_ledger::reconcile::DEFAULT_STATEMENT_TIMEOUT_MS,
            indexer_url: None,
            fetch: Arc::new(service_kit::http::UreqFetch::new()),
            posting,
            reconciliation_sources: Arc::new(svc_ledger::controls::sources::Unset),
        })
        .unwrap();
        Kit {
            door,
            url: db.url.clone(),
            store: db.store(),
            log,
            signers,
        }
    }

    /// `service`'s own key, for a client that signs its own calls (svc-agents' `LedgerHttp`).
    pub fn signer(&self, service: &str) -> Arc<ServiceSigner> {
        self.signers
            .iter()
            .find(|(s, _)| s == service)
            .unwrap_or_else(|| panic!("no key for {service}"))
            .1
            .clone()
    }

    /// The headers `service`'s own key signs this call with: a fresh nonce each time, as the client signs each attempt.
    pub fn keyed_headers(
        &self,
        service: &str,
        path: &str,
        text: &str,
        audience: &str,
    ) -> Vec<(String, String)> {
        let signer = &self
            .signers
            .iter()
            .find(|(s, _)| s == service)
            .unwrap_or_else(|| panic!("no key for {service}"))
            .1;
        let mut headers = signer
            .headers(
                audience,
                "POST",
                path,
                text,
                &SignedContext {
                    content_type: Some("application/json".to_owned()),
                    ..SignedContext::default()
                },
            )
            .unwrap();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        headers
    }

    /// The call with exactly these headers: its status and parsed body.
    pub fn send_with(&self, path: &str, text: &str, headers: &[(String, String)]) -> (u16, Json) {
        match self.door.decide(&Request {
            method: "POST",
            url: path,
            headers,
            body: text,
        }) {
            Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap()),
            Outcome::Owed(s) => panic!("{path} is still owed by {}", s.name()),
        }
    }

    /// `POST <path>` signed by `service`'s own key for svc-ledger.
    pub fn keyed(&self, service: &str, path: &str, body: &Json) -> (u16, Json) {
        let text = body.compact();
        self.send_with(
            path,
            &text,
            &self.keyed_headers(service, path, &text, "svc-ledger"),
        )
    }

    /// `POST <path>` under the shared secret, claiming `service`.
    pub fn shared(&self, service: &str, path: &str, body: &Json) -> (u16, Json) {
        let text = body.compact();
        let mut headers = legacy_headers(service, SECRET, &text, system_seconds()).unwrap();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        self.send_with(path, &text, &headers)
    }

    /// `handleS2sPost(door, body)` with no caller (`DIRECT`, see above).
    pub fn direct(&self, body: &Json) -> (u16, Json) {
        self.shared(DIRECT, "/trpc/post", body)
    }

    /// `engine.post(request)`: the engine itself, as the TypeScript tests' setup posts (no caller, no gate): the custody
    /// switch, then `PostgresLedger.post`.
    pub fn engine(&self, body: &Json) {
        let r = rules::read_post(body).unwrap();
        posting::book(&self.store, self.door.posting(), &r)
            .unwrap_or_else(|f| panic!("the engine refused {}: {f:?}", body.compact()));
    }

    /// `formatAmount((await engine.balance(ref)).amount)` for a recorded account.
    pub fn bal(&self, account: &Json) -> String {
        let t = |k: &str| match account.get(k) {
            Some(Json::String(s)) => s.clone(),
            _ => String::new(),
        };
        let purpose = t("purpose");
        let (_, amount) = with_client(self.store.pool().unwrap(), |c| {
            Ok(svc_ledger::balances::balance(
                c,
                &t("ownerType"),
                &t("ownerId"),
                &t("assetId"),
                &t("kind"),
                service_kit::money::js_trim(&purpose),
            ))
        })
        .unwrap()
        .unwrap();
        format_amount(amount)
    }

    /// `engine.getTxByKey(key)`: its id and meta, or none.
    pub fn tx(&self, key: &str) -> Option<(String, Json)> {
        let mut c = postgres::Client::connect(&self.url(), postgres::NoTls).unwrap();
        c.query_opt(
            "SELECT id::text, meta::text FROM ledger.ledger_tx WHERE idempotency_key = $1",
            &[&key],
        )
        .unwrap()
        .map(|row| (row.get(0), json::parse(&row.get::<_, String>(1)).unwrap()))
    }

    /// How many transactions carry this key.
    pub fn rows(&self, key: &str) -> i64 {
        let mut c = postgres::Client::connect(&self.url(), postgres::NoTls).unwrap();
        c.query_one(
            "SELECT count(*) FROM ledger.ledger_tx WHERE idempotency_key = $1",
            &[&key],
        )
        .unwrap()
        .get(0)
    }

    /// The book's database.
    pub fn url(&self) -> String {
        self.url.clone()
    }
}
