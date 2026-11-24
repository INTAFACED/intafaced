//! The Postgres harness the database suites share: a throwaway database per test on the server
//! `TEST_DATABASE_URL_BLUEPRINT` or `TEST_DATABASE_URL` names (its admin database's name ends in `_test`), copied from a
//! template the crate's own `migrate` binary made once. Without a URL a suite skips; with `REQUIRE_POSTGRES=1` it fails.
//! [`TestDb::door`] is the Rust door over that database, and [`call`] one signed request to it.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test harness: each suite uses part of it, and a failure is the point"
)]

/// The migrated template each test's database is copied from.
#[path = "../../../service-kit/tests/support/pg_template.rs"]
pub mod pg_template;

use std::collections::BTreeMap;
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use svc_blueprint::card::renderer::{CardRenderer, Unconfigured};
use svc_blueprint::db::{self, Store};
use svc_blueprint::door::{BlueprintDoor, DoorConfig, Kind};

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_BLUEPRINT").or_else(|| pick("TEST_DATABASE_URL"));
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_BLUEPRINT or TEST_DATABASE_URL is required"
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

/// The database bootstrap's part (tooling/infra/postgres-init): the extension and the schema.
const BOOTSTRAP: &str =
    "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE SCHEMA IF NOT EXISTS \"blueprint\"";

/// This process's migrated template (`pg_template::template`), made once.
fn template(admin: &str) -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        pg_template::template(
            admin,
            "blueprint",
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"),
            env!("CARGO_BIN_EXE_svc-blueprint"),
            BOOTSTRAP,
        )
    })
}

pub struct TestDb {
    pub url: String,
    admin: String,
    name: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    /// A fresh, bootstrapped and empty database; `None` when no server is named (the suite skips).
    pub fn new() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_blueprint_{}_{}_{nanos:x}_test",
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
        c.batch_execute(BOOTSTRAP).unwrap();
        Some(db)
    }

    /// A fresh database as `svc-blueprint migrate` leaves it.
    pub fn migrated() -> Option<TestDb> {
        let db = TestDb::new()?;
        pg_template::copy(&db.admin, &db.name, template(&db.admin));
        Some(db)
    }

    pub fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    /// `svc-blueprint migrate [--down]`, the binary itself: its exit code and what it printed.
    pub fn binary(&self, down: bool) -> (i32, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_svc-blueprint"));
        cmd.arg("migrate").env("DATABASE_URL", &self.url);
        if down {
            cmd.arg("--down");
        }
        let out = cmd.output().unwrap();
        (
            out.status.code().unwrap_or(-1),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
        )
    }

    pub fn store(&self) -> Store {
        db::open(&self.url, "svc-blueprint", 2, false).unwrap()
    }

    /// The Rust door over this database, with no card renderer.
    pub fn door(&self) -> BlueprintDoor {
        door(self.store())
    }

    /// The Rust door over this database, with this card renderer.
    pub fn door_with(&self, renderer: Box<dyn CardRenderer>) -> BlueprintDoor {
        door_rendering(self.store(), renderer)
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

pub const SECRET: &str = "a-blueprint-database-suite-edge-secret-long-enough";

/// The door over `store`, in the replay's environment, with no card renderer.
pub fn door(store: Store) -> BlueprintDoor {
    door_rendering(store, Box::new(Unconfigured))
}

/// The door over `store` and `renderer`, in the replay's environment.
pub fn door_rendering(store: Store, renderer: Box<dyn CardRenderer>) -> BlueprintDoor {
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
        now: svc_blueprint::door::system_now,
        store,
        renderer,
    })
    .unwrap()
}

/// One call to `path` as `user`, signed in DE with both scopes: its status and its tRPC body.
pub fn call(door: &BlueprintDoor, user: &str, path: &str, input: Option<&str>) -> (u16, Json) {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(vec![
                Json::str("blueprint:read"),
                Json::str("blueprint:write"),
            ]),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    let mut headers = vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ];
    let query = svc_blueprint::door::call(path).unwrap().kind == Kind::Query;
    let (method, url, body) = if query {
        let q = input
            .map(|i| {
                format!(
                    "?input={}",
                    url::form_urlencoded::byte_serialize(i.as_bytes()).collect::<String>()
                )
            })
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
        "db-suite",
    );
    (res.status, json::parse(&res.body).unwrap())
}

/// The answer's `result.data`.
pub fn data(body: &Json) -> &Json {
    body.get("result")
        .and_then(|r| r.get("data"))
        .unwrap_or_else(|| panic!("no result.data in {}", body.compact()))
}
