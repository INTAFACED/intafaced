//! The Academy's database parts against a real Postgres (`TEST_DATABASE_URL_ACADEMY` or `TEST_DATABASE_URL`, a server
//! whose admin database name ends in `_test`): `svc-academy migrate` applies every built-in migration once and
//! `--down` reverses them all; the transaction helper commits, rolls back on a refusal and runs at the isolation
//! level asked; a failure carries its SQLSTATE. Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, IsolationLevel, NoTls};
use service_kit::pg::Pool;
use svc_academy::db::{self, UNIQUE_VIOLATION};
use svc_academy::errors::Refusal;
use svc_academy::migrate::MIGRATIONS;

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

struct TestDb {
    admin: String,
    name: String,
    url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    fn new() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_academy_{}_{}_{nanos:x}_test",
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
        // The database bootstrap's part (tooling/infra/postgres-init): the extensions and the schema.
        c.batch_execute(
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"academy\"",
        )
        .unwrap();
        Some(db)
    }

    fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    /// `svc-academy migrate [--down]`, the binary itself: its exit code and what it printed.
    fn migrate(&self, down: bool) -> (i32, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_svc-academy"));
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

    fn tables(&self) -> i64 {
        self.client()
            .query_one(
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'academy' AND table_name <> '__migrations'",
                &[],
            )
            .unwrap()
            .get(0)
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

#[test]
fn migrate_applies_every_file_once_and_down_reverses_them() {
    let Some(db) = TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let (code, out) = db.migrate(false);
    assert_eq!(code, 0, "{out}");
    let applied: i64 = db
        .client()
        .query_one("SELECT count(*) FROM academy.__migrations", &[])
        .unwrap()
        .get(0);
    assert_eq!(usize::try_from(applied).unwrap(), MIGRATIONS.ups().len());
    assert!(db.tables() > 50, "the academy tables exist");
    let (code, again) = db.migrate(false);
    assert_eq!(code, 0, "{again}");
    assert!(
        !again.contains('↑'),
        "a second run applies nothing:\n{again}"
    );
    let (code, down) = db.migrate(true);
    assert_eq!(code, 0, "{down}");
    assert_eq!(db.tables(), 0, "every academy table is gone after --down");
}

#[test]
fn a_transaction_commits_rolls_back_and_names_its_sqlstate() {
    let Some(db) = TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    db.client()
        .batch_execute("CREATE TABLE academy.t (id text PRIMARY KEY)")
        .unwrap();
    let pool = Pool::new(&db.url, 2);
    let level: String = db::transaction(&pool, IsolationLevel::Serializable, |tx| {
        tx.execute("INSERT INTO academy.t VALUES ('a')", &[])
            .map_err(|e| db::refusal(&e))?;
        Ok(tx
            .query_one("SHOW transaction_isolation", &[])
            .map_err(|e| db::refusal(&e))?
            .get(0))
    })
    .unwrap();
    assert_eq!(level, "serializable");
    let refused = db::transaction(&pool, IsolationLevel::ReadCommitted, |tx| {
        tx.execute("INSERT INTO academy.t VALUES ('b')", &[])
            .map_err(|e| db::refusal(&e))?;
        Err::<(), _>(Refusal::db("the handler refused", None))
    });
    assert!(refused.is_err());
    let duplicate = db::transaction(&pool, IsolationLevel::ReadCommitted, |tx| {
        tx.execute("INSERT INTO academy.t VALUES ('a')", &[])
            .map_err(|e| db::refusal(&e))
    });
    let Err(Refusal::Internal { code, .. }) = duplicate else {
        panic!("{duplicate:?}")
    };
    assert_eq!(code.as_deref(), Some(UNIQUE_VIOLATION));
    let ids: Vec<String> = db
        .client()
        .query("SELECT id FROM academy.t ORDER BY id", &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(ids, ["a"], "the refused transaction left nothing");
    pool.end();
}
