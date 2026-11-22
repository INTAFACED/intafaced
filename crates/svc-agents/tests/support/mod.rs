//! The Postgres harness the database suites share: a throwaway database per test on the server
//! `TEST_DATABASE_URL_AGENTS` or `TEST_DATABASE_URL` names (its admin database's name ends in `_test`). Without a URL a
//! suite skips; with `REQUIRE_POSTGRES=1` it fails.
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

/// The NATS stand-in service-kit's tests run on, shared with the suites that need a bus.
#[path = "../../../service-kit/tests/support/standin.rs"]
pub mod standin;

use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};

use svc_agents::db::{self, Store};

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_AGENTS").or_else(|| pick("TEST_DATABASE_URL"));
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_AGENTS or TEST_DATABASE_URL is required"
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

/// The database bootstrap's part (tooling/infra/postgres-init): the extensions and the schema.
const BOOTSTRAP: &str = "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"agents\"";

/// This process's migrated template (`pg_template::template`), made once.
fn template(admin: &str) -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        pg_template::template(
            admin,
            "agents",
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"),
            env!("CARGO_BIN_EXE_svc-agents"),
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
    pub fn new() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_agents_{}_{}_{nanos:x}_test",
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

    pub fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    /// `svc-agents migrate [--down]`, the binary itself: its exit code and what it printed.
    pub fn binary(&self, down: bool) -> (i32, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_svc-agents"));
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

    /// `svc-agents migrate` run on this database in place, for a test that holds a connection to it across the migration.
    pub fn migrated_in_place(&self) {
        let (code, out) = self.binary(false);
        assert_eq!(code, 0, "{out}");
    }

    /// This database as `svc-agents migrate` leaves it: a fresh copy of the migrated template ([`template`]). Nothing may be
    /// connected to it yet; a test that is, migrates in place.
    pub fn migrated(&self) {
        pg_template::copy(&self.admin, &self.name, template(&self.admin));
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.client().query_one(sql, &[]).unwrap().get(0)
    }

    pub fn regclass(&self, name: &str) -> Option<String> {
        self.client()
            .query_one("SELECT to_regclass($1)::text", &[&name])
            .unwrap()
            .get(0)
    }

    pub fn store(&self) -> Store {
        db::open(&self.url, "svc-agents", 2, false).unwrap()
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
