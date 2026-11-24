//! What the programme slice's Postgres tests share: a fresh migrated database per test on the server
//! `TEST_DATABASE_URL_ACADEMY` or `TEST_DATABASE_URL` names (its admin database's name ends in `_test`), and the door
//! over it, called as the app calls it. Without a URL a test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test support: each test file uses part of it, and a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig};
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

pub const SECRET: &str = "an-academy-programme-test-edge-secret-long";
pub const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_ACADEMY").or_else(|| pick("TEST_DATABASE_URL"));
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_ACADEMY or TEST_DATABASE_URL is required"
    );
    url
}

fn assert_test_database(c: &mut Client) {
    let name: String = c
        .query_one("SELECT current_database()", &[])
        .unwrap()
        .get(0);
    assert!(
        name.ends_with("_test"),
        "refusing: {name} is not a test database (its name must end in _test)"
    );
}

/// One migrated database, dropped with the value.
pub struct TestDb {
    admin: String,
    name: String,
    pub url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    /// A fresh database with every built-in migration applied; `None` (skip) when no server is named.
    pub fn new() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_academy_prog_{}_{}_{nanos:x}_test",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        a.batch_execute(&format!("CREATE DATABASE \"{name}\""))
            .unwrap();
        let mut parsed = url::Url::parse(&admin).unwrap();
        parsed.set_path(&format!("/{name}"));
        let db = TestDb {
            admin,
            name,
            url: parsed.to_string(),
        };
        let mut c = db.client();
        assert_test_database(&mut c);
        c.batch_execute(
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"academy\"",
        )
        .unwrap();
        let mut out = Vec::new();
        svc_academy::migrate::run(&db.url, false, &mut out).unwrap();
        Some(db)
    }

    pub fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    pub fn pool(&self, max: usize) -> Pool {
        Pool::new(&self.url, max)
    }

    /// The door over this database, with `ports` and the environment `settings` (as `env.ts` would hand them).
    pub fn door(&self, ports: Ports, settings: Settings) -> AcademyDoor {
        door_over(Store::Pool(self.pool(4)), ports, settings)
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Ok(mut a) = Client::connect(&self.admin, NoTls) {
            let _ = a.batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ));
        }
    }
}

/// The system clock, as the running service uses.
fn system_now() -> Instant {
    svc_academy::door::system_now()
}

/// The door over any store.
pub fn door_over(store: Store, ports: Ports, settings: Settings) -> AcademyDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        env,
        store,
        ports,
        settings,
        now: system_now,
    })
    .unwrap()
}

/// Settings from `(key, value)` pairs, as `env.ts` parsed them.
pub fn settings(pairs: &[(&str, Json)]) -> Settings {
    Settings(Json::Object(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    ))
}

/// The edge's signed principal headers for `user` holding `scopes`, with two-factor when `mfa`.
pub fn principal(user: &str, scopes: &[&str], mfa: bool) -> Vec<(String, String)> {
    let region = ("x-intafaced-region".to_owned(), "DE".to_owned());
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(mfa)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(user)),
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

/// An operator holding every scope the programme calls need, past two-factor.
pub fn operator() -> Vec<(String, String)> {
    principal(
        OPERATOR,
        &["academy:read", "academy:write", "admin:read", "admin:write"],
        true,
    )
}

fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// One call through the door: its status and parsed body. A query goes as GET `?input=`, a mutation as POST.
pub fn call(
    door: &AcademyDoor,
    headers: &[(String, String)],
    path: &str,
    query: bool,
    input: Option<&Json>,
) -> (u16, Json) {
    let mut headers = headers.to_vec();
    let (method, url, body) = if query {
        let q = input
            .map(|i| format!("?input={}", encode_uri_component(&i.compact())))
            .unwrap_or_default();
        ("GET", format!("/trpc/{path}{q}"), String::new())
    } else {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        (
            "POST",
            format!("/trpc/{path}"),
            input.map(Json::compact).unwrap_or_default(),
        )
    };
    let res = door.handle(&Request {
        method,
        url: &url,
        headers: &headers,
        body: &body,
    });
    let parsed = json::parse(&res.body).unwrap_or_else(|e| panic!("{e:?}: {}", res.body));
    (res.status, parsed)
}

/// The success body's `result.data`, or a panic naming the answer.
pub fn data(answer: &(u16, Json)) -> &Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .unwrap_or_else(|| panic!("{}", answer.1.compact()))
}

/// A refusal's `cause.code` (the Academy code), when it carries one.
pub fn cause(answer: &(u16, Json)) -> Option<String> {
    let d = answer.1.get("error")?.get("data")?;
    match d.get("cause")?.get("code")? {
        Json::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// A refusal's message.
pub fn message(answer: &(u16, Json)) -> String {
    match answer.1.get("error").and_then(|e| e.get("message")) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}
