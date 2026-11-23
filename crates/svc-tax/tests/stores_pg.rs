//! The Postgres stores and the migration runner against a real Postgres, ported from `basis-store.pg.test.ts` and
//! `choices.pg.test.ts`. Each test makes its own database (`itf_run_tax_<pid>_<n>_<rand>_test`) from the admin URL in
//! `TEST_DATABASE_URL_TAX` or `TEST_DATABASE_URL`, refuses unless both that admin database and its own end in `_test`,
//! creates schema `tax` (the database bootstrap's job in production), applies the production migrations verbatim, and
//! drops it after. Without a URL the tests skip; with `REQUIRE_POSTGRES=1` a missing URL fails them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};
use svc_tax::ports::{BasisKind, BasisStore, BasisWrite, ChoiceStore, EngineMethod, LotPick};
use svc_tax::stores::basis::PgBasisStore;
use svc_tax::stores::choices::PgChoiceStore;
use svc_tax::stores::migrate::FILES;
use svc_tax::stores::pool::Pool;
use svc_tax::tax::Failure;

const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BO: &str = "22222222-2222-4222-8222-222222222222";
const RECORDED: &str = "0000_basis_override.sql";
const NUMERIC: &str = "0001_basis_override_numeric.sql";

fn migration(name: &str) -> &'static str {
    FILES.iter().find(|(n, _)| *n == name).unwrap().1
}

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_TAX").or_else(|| pick("TEST_DATABASE_URL"));
    // CI's Rust job has no Postgres service yet: it sets REQUIRE_POSTGRES=1 when it gets one, and from then on a missing
    // URL fails instead of skipping.
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_TAX or TEST_DATABASE_URL is required"
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

/// One private database, dropped when this goes out of scope.
struct TestDb {
    admin: String,
    name: String,
    url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    fn new(migrations: &[&str]) -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let mut rand = [0u8; 3];
        getrandom::fill(&mut rand).unwrap();
        let name = format!(
            "itf_run_tax_{}_{}_{:02x}{:02x}{:02x}_test",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst),
            rand[0],
            rand[1],
            rand[2]
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
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"tax\"",
        )
        .unwrap();
        for m in migrations {
            c.batch_execute(m).unwrap();
        }
        Some(db)
    }

    fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    fn pool(&self) -> Arc<Pool> {
        Arc::new(Pool::new(&self.url, 8))
    }

    /// `svc-tax migrate [--down]`, the binary itself: its exit code and everything it printed.
    fn migrate(&self, down: bool) -> (i32, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_svc-tax"));
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

macro_rules! db_or_skip {
    ($migrations:expr) => {
        match TestDb::new($migrations) {
            Some(db) => db,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL_TAX or TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── basis-store.pg.test.ts ──────────────────────────────────────────────────────────────────────────────────────────

type Column = (String, String, Option<i32>, Option<i32>, String);

fn money_columns(c: &mut Client) -> Vec<Column> {
    c.query(
        "SELECT column_name::text, data_type::text, numeric_precision::int4, numeric_scale::int4, is_nullable::text
         FROM information_schema.columns
         WHERE table_schema = 'tax' AND table_name = 'basis_overrides' AND column_name IN ('price_per_unit', 'qty')
         ORDER BY column_name",
        &[],
    )
    .unwrap()
    .iter()
    .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4)))
    .collect()
}

fn columns(kind: &str) -> Vec<Column> {
    let (p, s) = if kind == "numeric" {
        (Some(38), Some(18))
    } else {
        (None, None)
    };
    ["price_per_unit", "qty"]
        .iter()
        .map(|c| ((*c).to_owned(), kind.to_owned(), p, s, "YES".to_owned()))
        .collect()
}

fn insert_not_a_decimal(c: &mut Client, column: &str) -> Result<u64, postgres::Error> {
    let price = if column == "price_per_unit" {
        "not-a-decimal"
    } else {
        "10"
    };
    let qty: Option<&str> = (column == "qty").then_some("not-a-decimal");
    let kind = if column == "qty" {
        "manual"
    } else {
        "override"
    };
    let asset: Option<&str> = (column == "qty").then_some("BTC");
    c.execute(
        "INSERT INTO tax.basis_overrides (
           user_id, lot_id, version, kind, price_per_unit, acquired_at, source_note, asset_id, qty, business_key
         ) VALUES ($1, $2, 1, $3, $4, '2026-01-02T00:00:00.000Z', 'TEST receipt', $5, $6, $7)",
        &[
            &ADA,
            &format!("lot:bad:{column}"),
            &kind,
            &price,
            &asset,
            &qty,
            &format!("basisoverride:bad:{column}"),
        ],
    )
}

fn insert_recorded(c: &mut Client) {
    c.batch_execute(&format!(
        "INSERT INTO tax.basis_overrides (
           user_id, lot_id, version, kind, price_per_unit, acquired_at, source_note, asset_id, qty, business_key
         ) VALUES
           ('{ADA}', 'lot:old', 1, 'override', '100.50', '2026-01-02T00:00:00.000Z', 'TEST receipt', NULL, NULL, 'basisoverride:old'),
           ('{ADA}', 'manual:old', 1, 'manual', '10', '2026-01-02T00:00:00.000Z', 'TEST receipt', 'BTC', '2.25', 'basisoverride:manual'),
           ('{ADA}', 'lot:gone', 1, 'tombstone', NULL, NULL, NULL, NULL, NULL, 'basisoverride:gone')"
    ))
    .unwrap();
}

fn figures(c: &mut Client) -> Vec<(String, bool, bool)> {
    c.query(
        "SELECT kind,
           price_per_unit::numeric(38,18) IS NOT DISTINCT FROM (
             CASE kind WHEN 'override' THEN 100.50::numeric(38,18) WHEN 'manual' THEN 10::numeric(38,18) ELSE NULL END
           ) AS price_ok,
           qty::numeric(38,18) IS NOT DISTINCT FROM (CASE kind WHEN 'manual' THEN 2.25::numeric(38,18) ELSE NULL END) AS qty_ok
         FROM tax.basis_overrides ORDER BY kind",
        &[],
    )
    .unwrap()
    .iter()
    .map(|r| (r.get(0), r.get(1), r.get(2)))
    .collect()
}

fn kept_figures() -> Vec<(String, bool, bool)> {
    ["manual", "override", "tombstone"]
        .iter()
        .map(|k| ((*k).to_owned(), true, true))
        .collect()
}

fn record_recorded_name(c: &mut Client) {
    c.batch_execute(&format!(
        "CREATE TABLE IF NOT EXISTS tax.__migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
         INSERT INTO tax.__migrations (name) VALUES ('{RECORDED}')"
    ))
    .unwrap();
}

fn applied(c: &mut Client) -> Vec<String> {
    c.query("SELECT name FROM tax.__migrations ORDER BY name", &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

fn write(lot_id: &str, price: &str) -> BasisWrite {
    BasisWrite {
        user_id: ADA.to_owned(),
        lot_id: lot_id.to_owned(),
        manual: false,
        price_per_unit: price.to_owned(),
        acquired_at: "2026-01-02T00:00:00.000Z".to_owned(),
        source_note: "TEST receipt".to_owned(),
        asset_id: None,
        qty: None,
    }
}

#[test]
fn basis_one_version_for_the_same_payload_two_for_two_prices_and_the_other_account_isolated() {
    let db = db_or_skip!(&[migration(RECORDED), migration(NUMERIC)]);
    let store = Arc::new(PgBasisStore::new(db.pool()));
    let both = |a: BasisWrite, b: BasisWrite| {
        let (s1, s2) = (store.clone(), store.clone());
        let t1 = std::thread::spawn(move || s1.save(&a).unwrap());
        let t2 = std::thread::spawn(move || s2.save(&b).unwrap());
        (t1.join().unwrap(), t2.join().unwrap())
    };
    let (first, second) = both(write("lot:d1:BTC", "100"), write("lot:d1:BTC", "100"));
    assert_eq!((first.version, second.version), (1, 1));
    assert_eq!(first.business_key, second.business_key);
    assert_eq!(
        first.business_key,
        format!("basisoverride:{ADA}:lot:d1:BTC:1")
    );

    let (low, high) = both(write("lot:d2:BTC", "100"), write("lot:d2:BTC", "200"));
    let mut versions = [low.version, high.version];
    versions.sort_unstable();
    assert_eq!(versions, [1, 2]);

    let other = "33333333-3333-4333-8333-333333333333";
    assert_eq!(store.list_active(other).unwrap(), Vec::new());
    match store.clear(other, "lot:d1:BTC") {
        Err(Failure::Refused(e)) => assert_eq!(e.code, "tax.basis_override_absent"),
        other => panic!("expected tax.basis_override_absent, got {other:?}"),
    }
    let tomb = store.clear(ADA, "lot:d1:BTC").unwrap();
    assert_eq!(tomb.kind, BasisKind::Tombstone);
    let active: Vec<String> = store
        .list_active(ADA)
        .unwrap()
        .into_iter()
        .map(|r| r.lot_id)
        .collect();
    assert_eq!(active, vec!["lot:d2:BTC".to_owned()]);
    assert_eq!(
        store.clear(ADA, "lot:d1:BTC").unwrap().version,
        tomb.version
    );
}

#[test]
fn basis_money_is_numeric_and_a_non_decimal_string_is_refused() {
    let db = db_or_skip!(&[migration(RECORDED), migration(NUMERIC)]);
    let mut c = db.client();
    assert_eq!(money_columns(&mut c), columns("numeric"));
    assert!(insert_not_a_decimal(&mut c, "price_per_unit").is_err());
    assert!(insert_not_a_decimal(&mut c, "qty").is_err());
}

#[test]
fn basis_reverses_the_numeric_columns_and_then_the_table() {
    let db = db_or_skip!(&[migration(RECORDED), migration(NUMERIC)]);
    let mut c = db.client();
    c.batch_execute(migration("0001_basis_override_numeric.down.sql"))
        .unwrap();
    assert_eq!(money_columns(&mut c), columns("text"));
    c.batch_execute(migration("0000_basis_override.down.sql"))
        .unwrap();
    let left = c
        .query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'tax' AND tablename = 'basis_overrides'",
            &[],
        )
        .unwrap();
    assert!(left.is_empty());
    c.batch_execute(migration(RECORDED)).unwrap();
    c.batch_execute(migration(NUMERIC)).unwrap();
    assert_eq!(money_columns(&mut c), columns("numeric"));
}

#[test]
fn the_runner_applies_every_migration_on_a_fresh_database() {
    let db = db_or_skip!(&[]);
    let (code, out) = db.migrate(false);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains(&format!("↑ {RECORDED}")), "{out}");
    assert!(out.contains(&format!("↑ {NUMERIC}")), "{out}");
    let mut c = db.client();
    assert_eq!(money_columns(&mut c), columns("numeric"));
    assert!(insert_not_a_decimal(&mut c, "price_per_unit").is_err());
    assert!(insert_not_a_decimal(&mut c, "qty").is_err());
    assert_eq!(
        applied(&mut c),
        vec![
            RECORDED,
            NUMERIC,
            "20261024110000_cost_basis_choices.sql",
            "20261024150000_pnl_settings.sql"
        ]
    );
    // Run again: every file already applied, nothing re-run.
    let (code, out) = db.migrate(false);
    assert_eq!(code, 0, "{out}");
    assert!(!out.contains('↑'), "{out}");
    assert!(out.contains("✓ migrations up to date"), "{out}");
}

#[test]
fn the_runner_skips_a_recorded_text_0000_casts_stored_decimals_and_reverses() {
    let db = db_or_skip!(&[migration(RECORDED)]);
    let mut c = db.client();
    assert_eq!(money_columns(&mut c), columns("text"));
    insert_recorded(&mut c);
    record_recorded_name(&mut c);

    let (code, out) = db.migrate(false);
    assert_eq!(code, 0, "{out}");
    assert!(
        out.contains(&format!("· {RECORDED} (already applied)")),
        "{out}"
    );
    assert!(!out.contains(&format!("↑ {RECORDED}")), "{out}");
    assert!(out.contains(&format!("↑ {NUMERIC}")), "{out}");
    assert_eq!(money_columns(&mut c), columns("numeric"));
    assert_eq!(figures(&mut c), kept_figures());
    assert!(insert_not_a_decimal(&mut c, "price_per_unit").is_err());
    assert!(insert_not_a_decimal(&mut c, "qty").is_err());

    c.batch_execute(migration("0001_basis_override_numeric.down.sql"))
        .unwrap();
    assert_eq!(money_columns(&mut c), columns("text"));
    assert_eq!(figures(&mut c), kept_figures());
    c.batch_execute(migration(NUMERIC)).unwrap();
    assert_eq!(money_columns(&mut c), columns("numeric"));

    let (code, out) = db.migrate(true);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ reversed"), "{out}");
    let left = c
        .query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'tax' AND tablename = 'basis_overrides'",
            &[],
        )
        .unwrap();
    assert!(left.is_empty());
    assert!(applied(&mut c).is_empty());
}

#[test]
fn the_runner_refuses_a_stored_non_decimal_string_and_leaves_the_text_columns() {
    let db = db_or_skip!(&[migration(RECORDED)]);
    let mut c = db.client();
    insert_not_a_decimal(&mut c, "price_per_unit").unwrap();
    record_recorded_name(&mut c);

    let (code, out) = db.migrate(false);
    assert_eq!(code, 1, "{out}");
    assert!(
        out.contains("invalid input syntax for type numeric"),
        "{out}"
    );
    assert_eq!(money_columns(&mut c), columns("text"));
    let price: String = c
        .query_one(
            "SELECT price_per_unit FROM tax.basis_overrides WHERE lot_id = 'lot:bad:price_per_unit'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(price, "not-a-decimal");
    assert_eq!(applied(&mut c), vec![RECORDED]);
}

// ── choices.pg.test.ts ──────────────────────────────────────────────────────────────────────────────────────────────

const CHOICES: &str = "20261024110000_cost_basis_choices.sql";
const SETTINGS: &str = "20261024150000_pnl_settings.sql";

#[test]
fn choices_save_replace_and_clear_each_kind_and_read_back_only_the_callers_own() {
    let db = db_or_skip!(&[migration(CHOICES), migration(SETTINGS)]);
    let store = PgChoiceStore::new(db.pool());
    store
        .set_method(ADA, None, Some(EngineMethod::Lifo))
        .unwrap();
    store
        .set_method(ADA, Some("BTC"), Some(EngineMethod::Hifo))
        .unwrap();
    store
        .set_method(ADA, Some("BTC"), Some(EngineMethod::Average))
        .unwrap();
    store
        .set_day_method(ADA, "2026-10-05", None, Some(EngineMethod::Fifo))
        .unwrap();
    store
        .set_day_method(ADA, "2026-10-05", Some("BTC"), Some(EngineMethod::Hifo))
        .unwrap();
    store
        .set_pick(ADA, "tx-sale-1", "BTC", Some("lot:tx-buy-1:BTC"))
        .unwrap();
    store
        .set_pick(ADA, "tx-sale-1", "BTC", Some("lot:tx-buy-2:BTC"))
        .unwrap();
    store
        .set_method(BO, None, Some(EngineMethod::Hifo))
        .unwrap();

    let ada = store.read(ADA).unwrap();
    assert_eq!(ada.account_method, Some(EngineMethod::Lifo));
    assert_eq!(
        ada.asset_methods,
        vec![("BTC".to_owned(), EngineMethod::Average)]
    );
    assert_eq!(ada.days.len(), 2);
    assert!(
        ada.days.iter().any(|d| d.day == "2026-10-05"
            && d.asset_id.is_none()
            && d.method == EngineMethod::Fifo)
    );
    assert!(ada.days.iter().any(|d| d.day == "2026-10-05"
        && d.asset_id.as_deref() == Some("BTC")
        && d.method == EngineMethod::Hifo));
    assert_eq!(
        ada.picks,
        vec![LotPick {
            sale_tx_id: "tx-sale-1".into(),
            asset_id: "BTC".into(),
            lot_id: "lot:tx-buy-2:BTC".into()
        }]
    );
    let bo = store.read(BO).unwrap();
    assert_eq!(bo.account_method, Some(EngineMethod::Hifo));
    assert!(bo.picks.is_empty());

    store.set_method(ADA, Some("BTC"), None).unwrap();
    store
        .set_day_method(ADA, "2026-10-05", Some("BTC"), None)
        .unwrap();
    store.set_pick(ADA, "tx-sale-1", "BTC", None).unwrap();
    let cleared = store.read(ADA).unwrap();
    assert!(cleared.asset_methods.is_empty());
    assert_eq!(cleared.days.len(), 1);
    assert!(cleared.days[0].asset_id.is_none() && cleared.days[0].method == EngineMethod::Fifo);
    assert!(cleared.picks.is_empty());
    assert_eq!(
        store.read(BO).unwrap().account_method,
        Some(EngineMethod::Hifo)
    );
}

#[test]
fn choices_save_replace_and_clear_whether_transfers_count_for_the_caller_only() {
    let db = db_or_skip!(&[migration(CHOICES), migration(SETTINGS)]);
    let store = PgChoiceStore::new(db.pool());
    assert_eq!(store.read(ADA).unwrap().include_transfers, None);
    store.set_include_transfers(ADA, Some(false)).unwrap();
    store.set_include_transfers(ADA, Some(false)).unwrap();
    assert_eq!(store.read(ADA).unwrap().include_transfers, Some(false));
    assert_eq!(store.read(BO).unwrap().include_transfers, None);
    store.set_include_transfers(ADA, Some(true)).unwrap();
    assert_eq!(store.read(ADA).unwrap().include_transfers, Some(true));
    let n: i32 = db
        .client()
        .query_one(
            "SELECT count(*)::int4 FROM tax.pnl_settings WHERE user_id = $1",
            &[&ADA],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 1);
    store.set_include_transfers(ADA, None).unwrap();
    assert_eq!(store.read(ADA).unwrap().include_transfers, None);
}

#[test]
fn choices_a_method_the_book_does_not_offer_is_refused_at_the_table() {
    let db = db_or_skip!(&[migration(CHOICES), migration(SETTINGS)]);
    let mut c = db.client();
    let e = c
        .execute(
            "INSERT INTO tax.method_choices (user_id, asset_id, method) VALUES ($1, '*', 'LOFO')",
            &[&ADA],
        )
        .unwrap_err();
    assert!(
        e.as_db_error()
            .and_then(|d| d.constraint())
            .is_some_and(|k| k == "method_choices_method_ck"),
        "{e:?}"
    );
    let e = c
        .execute(
            "INSERT INTO tax.method_days (user_id, day, asset_id, method) VALUES ($1, '2026-10-05', '*', 'LOFO')",
            &[&ADA],
        )
        .unwrap_err();
    assert!(
        e.as_db_error()
            .and_then(|d| d.constraint())
            .is_some_and(|k| k == "method_days_method_ck"),
        "{e:?}"
    );
}

#[test]
fn choices_the_migration_reverses_cleanly_and_applies_again() {
    let db = db_or_skip!(&[migration(CHOICES), migration(SETTINGS)]);
    let mut c = db.client();
    c.batch_execute(migration("20261024150000_pnl_settings.down.sql"))
        .unwrap();
    c.batch_execute(migration("20261024110000_cost_basis_choices.down.sql"))
        .unwrap();
    let gone = |c: &mut Client, t: &str| -> bool {
        c.query_one("SELECT to_regclass($1)::text", &[&t])
            .unwrap()
            .get::<_, Option<String>>(0)
            .is_none()
    };
    assert!(gone(&mut c, "tax.method_choices"));
    assert!(gone(&mut c, "tax.pnl_settings"));
    for m in [CHOICES, CHOICES, SETTINGS, SETTINGS] {
        c.batch_execute(migration(m)).unwrap();
    }
    let store = PgChoiceStore::new(db.pool());
    store
        .set_method(ADA, None, Some(EngineMethod::Fifo))
        .unwrap();
    store.set_include_transfers(ADA, Some(false)).unwrap();
    let read = store.read(ADA).unwrap();
    assert_eq!(read.account_method, Some(EngineMethod::Fifo));
    assert_eq!(read.include_transfers, Some(false));
}
