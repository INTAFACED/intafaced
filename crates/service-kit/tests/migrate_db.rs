//! The migration runner against a real Postgres (`TEST_DATABASE_URL`; skips without one unless `REQUIRE_POSTGRES=1`):
//! a pending file is applied once when two runners race, and a file whose record is refused is rolled back with it.
//! Ported from the TypeScript service's `services/svc-academy/scripts/migrate.test.ts`, which held its runner to both.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use postgres::{Client, NoTls};
use service_kit::migrate::Migrations;

fn url() -> Option<String> {
    let url = std::env::var("TEST_DATABASE_URL")
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(url.is_some() || !required, "TEST_DATABASE_URL is required");
    url
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn count(c: &mut Client, sql: &str) -> i64 {
    c.query_one(sql, &[]).unwrap().get(0)
}

#[test]
fn a_pending_file_is_applied_once_in_the_transaction_that_records_it() {
    let Some(url) = url() else { return };
    let mut admin = Client::connect(&url, NoTls).unwrap();
    let db: String = admin
        .query_one("SELECT current_database()", &[])
        .unwrap()
        .get(0);
    assert!(
        db.ends_with("_test"),
        "refusing to migrate against database {db}"
    );
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let schema = leak(format!("kit_migrate_{}_{nanos:x}", std::process::id()));
    admin
        .batch_execute(&format!("CREATE SCHEMA {schema}"))
        .unwrap();

    let once: &'static [(&'static str, &'static str)] = Box::leak(Box::new([(
        "0001_once.sql",
        leak(format!(
            "CREATE TABLE IF NOT EXISTS {schema}.runs (n int NOT NULL);
             INSERT INTO {schema}.runs (n) VALUES (1);
             SELECT pg_sleep(0.8);"
        )),
    )]));
    let set = Migrations {
        schema,
        files: once,
        default_url: "",
    };
    let racers: Vec<_> = (0..2)
        .map(|_| {
            let url = url.clone();
            std::thread::spawn(move || set.run(&url, false, &mut Vec::new()))
        })
        .collect();
    for r in racers {
        assert_eq!(r.join().unwrap(), Ok(()));
    }
    assert_eq!(
        count(&mut admin, &format!("SELECT count(*) FROM {schema}.runs")),
        1
    );
    assert_eq!(
        count(
            &mut admin,
            &format!("SELECT count(*) FROM {schema}.__migrations WHERE name = '0001_once.sql'")
        ),
        1
    );

    admin
        .batch_execute(&format!(
            "CREATE FUNCTION {schema}.refuse_record() RETURNS trigger LANGUAGE plpgsql AS $fn$
             BEGIN
               IF NEW.name = '0002_refuse.sql' THEN RAISE EXCEPTION 'refuse migration record'; END IF;
               RETURN NEW;
             END $fn$;
             CREATE TRIGGER refuse_record BEFORE INSERT ON {schema}.__migrations
               FOR EACH ROW EXECUTE FUNCTION {schema}.refuse_record();"
        ))
        .unwrap();
    let both: &'static [(&'static str, &'static str)] = Box::leak(Box::new([
        once[0],
        (
            "0002_refuse.sql",
            leak(format!("INSERT INTO {schema}.runs (n) VALUES (2);")),
        ),
    ]));
    let set = Migrations {
        schema,
        files: both,
        default_url: "",
    };
    let refused = set.run(&url, false, &mut Vec::new());
    assert!(
        refused
            .as_ref()
            .is_err_and(|e| e.contains("refuse migration record")),
        "{refused:?}"
    );
    assert_eq!(
        count(&mut admin, &format!("SELECT count(*) FROM {schema}.runs")),
        1
    );
    assert_eq!(
        count(
            &mut admin,
            &format!("SELECT count(*) FROM {schema}.__migrations WHERE name = '0002_refuse.sql'")
        ),
        0
    );
    admin
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .unwrap();
}
