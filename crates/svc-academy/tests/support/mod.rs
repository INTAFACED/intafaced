//! What the curriculum tests share: a fresh, migrated Postgres database per test (as `db_pg.rs` makes one), and the
//! service-call headers a caller sends.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};
use service_kit::pg::Pool;

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

/// A database of its own, migrated by the `svc-academy migrate` binary, dropped when the test ends.
pub struct TestDb {
    admin: String,
    name: String,
    pub url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    /// None without a test database URL (and `REQUIRE_POSTGRES` unset).
    pub fn migrated() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_academy_cur_{}_{}_{nanos:x}_test",
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
        let out = Command::new(env!("CARGO_BIN_EXE_svc-academy"))
            .arg("migrate")
            .env("DATABASE_URL", &db.url)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "migrate: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Some(db)
    }

    pub fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    pub fn pool(&self) -> Pool {
        Pool::new(&self.url, 4)
    }

    /// The first column of every row, as text.
    pub fn texts(&self, sql: &str) -> Vec<String> {
        self.client()
            .query(sql, &[])
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
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

/// The process clock in seconds.
pub fn now_seconds() -> i64 {
    service_kit::s2s::system_seconds()
}

/// `serviceAuthHeadersForBody(service, secret, body)` now.
pub fn legacy_headers(service: &str, secret: &str, body: &str) -> Vec<(String, String)> {
    service_kit::s2s::legacy_headers(service, secret, body, now_seconds()).unwrap()
}
