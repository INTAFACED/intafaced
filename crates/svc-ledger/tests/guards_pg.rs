//! The database's own guards on a real Postgres (`TEST_DATABASE_URL_LEDGER` or `TEST_DATABASE_URL`, an admin database whose
//! name ends in `_test`), each test in its own throwaway database. Without a URL it skips; with `REQUIRE_POSTGRES=1`
//! it fails.
//!
//! Each guard is made to refuse something with raw SQL, the posting path out of the picture: a database backstop is
//! worth something only when it holds while the service is not the one writing. Where the TypeScript posted through
//! `PostgresLedger`, the book here is posted through the Rust engine (`posting::post`).
//!
//! Ported case for case from `services/svc-ledger`:
//!
//! - `src/db/guards-executed.test.ts`: `guards_*`.
//! - `src/db/journal-immutable.db.test.ts`: `journal_*`.
//! - `src/db/idempotency-key-backstop.test.ts`: `idempotency_key_*`.
//! - `src/db/outbox-amount-string.test.ts`: `outbox_amount_*`.
//! - `src/ledger/asset-registry.test.ts`: `asset_fk_*` and `asset_0006_*`.
//! - `src/ledger/owner-identity.test.ts`: `owner_space_*` and `owner_0005_*`.
//! - `src/ledger/purposed-locks.test.ts`: `lock_purpose_*`.
//! - `src/ledger/operator-owner-balances.test.ts`, its `operator_access_log (0024)` cases: `access_log_*`. Its
//!   in-memory cases (the row first, refused when it cannot be written) are `tests/desk_pg.rs`'s.
//! - `src/ledger/chain-page-entries.test.ts`: `chain_page_*`, counting the statements `reconcile::verify_chain` sends.
//!
//! Each TypeScript file's "H8a … not skip-green" source case is `this_suite_never_skips_a_case`: no case here is
//! ignored, and `support::admin_url` fails the run under `REQUIRE_POSTGRES=1` (CI's Rust job sets it).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use support::TestDb;
use svc_ledger::balances;
use svc_ledger::db::Store;
use svc_ledger::desk::{self, Actor};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::migrate::FILES;
use svc_ledger::posting::engine::{Conflict, EngineOptions};
use svc_ledger::posting::gate::Caller;
use svc_ledger::posting::{self, Posting};
use svc_ledger::reconcile::{self, CHAIN_BATCH, Chain, CustodyLayer};
use svc_ledger::refines::is_valid_owner_id;

const CHECK_VIOLATION: &str = "23514";
const FK_VIOLATION: &str = "23503";
const UNIQUE_VIOLATION: &str = "23505";

// ── the kit ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// A database with these migration files applied, as `createTestDb({ migrations })` builds one.
fn with_files(files: &[(&'static str, &'static str)]) -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(files, false).unwrap();
    Some(db)
}

/// Every migration: the schema as it runs today.
fn book() -> Option<TestDb> {
    with_files(&FILES)
}

/// Every migration but the one whose files start with `prefix` (the TypeScript's `PRIOR`).
fn without(prefix: &str) -> Option<TestDb> {
    let files: Vec<(&'static str, &'static str)> = FILES
        .iter()
        .copied()
        .filter(|(n, _)| !n.starts_with(prefix))
        .collect();
    with_files(&files)
}

/// One migration file's text.
fn file(name: &str) -> &'static str {
    FILES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, sql)| *sql)
        .unwrap_or_else(|| panic!("no migration {name}"))
}

/// A connection whose unqualified names are the ledger's, as the TypeScript test connection's are.
fn sql(db: &TestDb) -> Client {
    let mut c = db.client();
    c.batch_execute("SET search_path TO ledger, public")
        .unwrap();
    c
}

/// A text literal.
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The SQLSTATE and message of a refused statement.
fn refused<T: std::fmt::Debug>(r: Result<T, postgres::Error>) -> (String, String) {
    let e = r.expect_err("the statement was refused");
    let code = e.code().map(|c| c.code().to_owned()).unwrap_or_default();
    let message = e
        .as_db_error()
        .map_or_else(|| e.to_string(), |d| d.message().to_owned());
    (code, message)
}

fn refused_with<T: std::fmt::Debug>(r: Result<T, postgres::Error>, code: &str) -> String {
    let (got, message) = refused(r);
    assert_eq!(got, code, "{message}");
    message
}

fn count(c: &mut Client, query: &str) -> i64 {
    c.query_one(query, &[]).unwrap().get(0)
}

/// Turns 0023's balance-at-commit trigger off for a case whose raw fixtures insert one-sided entries on purpose
/// (`disableBalanceTrigger`); that trigger's own cases are the `journal_*` ones.
fn disable_balance_trigger(c: &mut Client) {
    c.batch_execute(
        "ALTER TABLE ledger.ledger_entries DISABLE TRIGGER ledger_entries_tx_must_balance",
    )
    .unwrap();
}

/// A raw transaction row; its id.
fn insert_tx(c: &mut impl postgres::GenericClient, key: &str) -> String {
    c.query_one(
        &format!(
            "INSERT INTO ledger.ledger_tx (idempotency_key, module, reason, hash) VALUES ({}, 'test', 'raw sql, no ledger-client', {}) RETURNING id::text",
            lit(key),
            lit(&format!("h-{key}"))
        ),
        &[],
    )
    .unwrap()
    .get(0)
}

/// A raw account for a fresh owner in this asset; its id.
fn account(c: &mut impl postgres::GenericClient, asset: &str) -> String {
    c.query_one(
        &format!(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, purpose) VALUES ('user'::ledger.owner_type, gen_random_uuid()::text, {}, 'available'::ledger.account_kind, '') RETURNING id::text",
            lit(asset)
        ),
        &[],
    )
    .unwrap()
    .get(0)
}

fn entry_sql(
    tx: &str,
    account: &str,
    asset: &str,
    direction: &str,
    amount: &str,
    after: &str,
) -> String {
    format!(
        "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after) VALUES ({}::uuid, {}::uuid, {}, {}::ledger.direction, {amount}::numeric, {after}::numeric)",
        lit(tx),
        lit(account),
        lit(asset),
        lit(direction)
    )
}

/// The engine the binary runs: custody on, refuse mode, its own bus.
fn engine() -> Posting {
    Posting::new(
        Arc::new(MemoryBus::default()),
        "svc-ledger".to_owned(),
        true,
        EngineOptions {
            conflict: Conflict::Refuse,
            clock_skew_bound_ms: None,
            clock_ms: || 1_795_000_000_000,
        },
        false,
        None,
    )
}

/// `recipes.deposit({ userId, assetId: 'USDT', amount, rail: 'test', railRef })`, posted through the Rust engine; its id.
fn deposit(store: &Store, p: &Posting, user: &str, amount: &str, rail_ref: &str) -> String {
    let body = json::parse(&format!(
        r#"{{"idempotencyKey":"deposit:test:{rail_ref}","module":"ledger","reason":"deposit.credited","entries":[{{"account":{{"ownerType":"treasury","ownerId":"rail:test","assetId":"USDT","kind":"available"}},"direction":"credit","amount":"{amount}"}},{{"account":{{"ownerType":"user","ownerId":"{user}","assetId":"USDT","kind":"available"}},"direction":"debit","amount":"{amount}"}}],"meta":{{"rail":"test","railRef":"{rail_ref}"}}}}"#
    ))
    .unwrap();
    let ack = posting::post(
        store,
        p,
        Some(&Caller::Legacy(Some("svc-wallet".to_owned()))),
        "dual",
        &body,
    )
    .unwrap();
    match ack.get("txId") {
        Some(Json::String(id)) => id.clone(),
        other => panic!("txId: {other:?}"),
    }
}

#[test]
fn this_suite_never_skips_a_case() {
    let own = include_str!("guards_pg.rs");
    for banned in [
        concat!("#[", "ignore"),
        concat!("return ", "Ok(()); // skip"),
    ] {
        assert!(!own.contains(banned), "{banned} in guards_pg.rs");
    }
    assert!(own.matches("#[test]").count() > 40);
}

// ── guards-executed.test.ts ──────────────────────────────────────────────────────────────────────────────────────────

/// A real transaction and a real account, so the only thing wrong with an entry is its asset; a fresh owner each time
/// (`realTxAndAccount`).
fn real_tx_and_account(c: &mut Client, asset: &str) -> (String, String) {
    disable_balance_trigger(c);
    static PROBE: AtomicUsize = AtomicUsize::new(0);
    let probe = PROBE.fetch_add(1, Ordering::SeqCst);
    let tx = insert_tx(c, &format!("guards-fk-probe-{probe}"));
    (tx, account(c, asset))
}

#[test]
fn guards_refuse_an_entry_in_an_asset_that_was_never_registered() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (tx, acct) = real_tx_and_account(&mut c, "USDT");
    refused_with(
        c.batch_execute(&entry_sql(&tx, &acct, "NOTANASSET", "credit", "1", "1")),
        FK_VIOLATION,
    );
}

#[test]
fn guards_refuse_an_entry_whose_asset_is_not_its_accounts_asset() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (tx, acct) = real_tx_and_account(&mut c, "USDT");
    refused_with(
        c.batch_execute(&entry_sql(&tx, &acct, "BTC", "debit", "1", "1")),
        FK_VIOLATION,
    );
}

#[test]
fn guards_an_account_cannot_be_moved_to_another_asset_while_entries_describe_it() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (tx, acct) = real_tx_and_account(&mut c, "USDT");
    c.batch_execute(&entry_sql(&tx, &acct, "USDT", "debit", "1", "1"))
        .unwrap();
    refused_with(
        c.batch_execute(&format!(
            "UPDATE accounts SET asset_id = 'BTC' WHERE id = {}::uuid",
            lit(&acct)
        )),
        FK_VIOLATION,
    );
}

#[test]
fn guards_accept_the_same_entry_in_a_registered_asset() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (tx, acct) = real_tx_and_account(&mut c, "USDT");
    c.batch_execute(&entry_sql(&tx, &acct, "USDT", "credit", "1", "1"))
        .unwrap();
}

#[test]
fn guards_an_asset_holding_live_value_cannot_be_deleted() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute("INSERT INTO assets (id, kind, decimals) VALUES ('ENTFK', 'crypto', 18) ON CONFLICT (id) DO NOTHING")
        .unwrap();
    let (tx, acct) = real_tx_and_account(&mut c, "ENTFK");
    c.batch_execute(&entry_sql(&tx, &acct, "ENTFK", "debit", "1", "1"))
        .unwrap();
    refused_with(
        c.batch_execute("DELETE FROM assets WHERE id = 'ENTFK'"),
        FK_VIOLATION,
    );
}

#[test]
fn guards_chain_tip_refuses_a_second_row() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(
        c.batch_execute("INSERT INTO chain_tip (id, hash, seq) VALUES (false, 'other', 1)"),
        CHECK_VIOLATION,
    );
    refused_with(
        c.batch_execute("INSERT INTO chain_tip (id, hash, seq) VALUES (true, 'other', 1)"),
        UNIQUE_VIOLATION,
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM chain_tip"), 1);
}

#[test]
fn guards_posting_freeze_refuses_a_second_row() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(
        c.batch_execute("INSERT INTO posting_freeze (id, frozen, reason, actor) VALUES (false, true, 'other', 'other')"),
        CHECK_VIOLATION,
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM posting_freeze"), 1);
}

const PURPOSE_USER: &str = "5f1e9c62-0d3a-4a7e-9b21-8c4a6f0e1d55";

fn hold_with_purpose(purpose: &str) -> String {
    format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose) VALUES ('user'::owner_type, {}, 'USDT', 'hold'::account_kind, {})",
        lit(PURPOSE_USER),
        lit(purpose)
    )
}

#[test]
fn guards_refuse_a_purpose_past_128_characters() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let purpose = format!("loan:{}", "a".repeat(124));
    assert_eq!(purpose.chars().count(), 129);
    refused_with(
        c.batch_execute(&hold_with_purpose(&purpose)),
        CHECK_VIOLATION,
    );
}

#[test]
fn guards_accept_a_purpose_of_exactly_128() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute(&hold_with_purpose(&"a".repeat(128)))
        .unwrap();
}

// ── journal-immutable.db.test.ts ─────────────────────────────────────────────────────────────────────────────────────

const JOURNAL_USER: &str = "9a3b6f0e-1d2c-4e5f-8a7b-0c1d2e3f4a5b";

/// `refusals on a populated book`: one deposit of 100, its transaction id.
fn populated() -> Option<(TestDb, Store, Posting, String)> {
    let db = book()?;
    let store = db.store();
    let p = engine();
    let tx = deposit(&store, &p, JOURNAL_USER, "100", "imm-1");
    Some((db, store, p, tx))
}

fn assert_book_proves(c: &mut Client) {
    assert!(reconcile::reconcile_balances(c).unwrap().ok);
    assert!(reconcile::verify_chain(c, CHAIN_BATCH, None).unwrap().ok());
}

#[test]
fn journal_normal_posting_reconcile_and_verify_chain_still_pass() {
    let Some((db, store, p, _)) = populated() else {
        return;
    };
    deposit(&store, &p, JOURNAL_USER, "50", "imm-2");
    let mut c = sql(&db);
    let report = reconcile::run_reconciliation(&mut c, CustodyLayer::On, || 0).unwrap();
    assert!(report.ok, "{report:?}");
    assert_book_proves(&mut c);
    let totals = reconcile::totals_by_asset(&mut c).unwrap();
    assert!(!totals.is_empty());
    for (asset, total) in &totals {
        let zero = total == "0"
            || total
                .strip_prefix("0.")
                .is_some_and(|z| !z.is_empty() && z.bytes().all(|b| b == b'0'));
        assert!(zero, "{asset} totals {total}");
    }
    let (_, balance) =
        balances::balance(&mut c, "user", JOURNAL_USER, "USDT", "available", "").unwrap();
    assert_eq!(balance, parse_amount("150").unwrap());
}

#[test]
fn journal_refuses_update_of_a_ledger_entries_row() {
    let Some((db, ..)) = populated() else { return };
    let mut c = sql(&db);
    let m = refused_with(
        c.batch_execute("UPDATE ledger_entries SET amount = 999999"),
        CHECK_VIOLATION,
    );
    assert!(
        m.contains("ledger_entries is append-only: UPDATE refused"),
        "{m}"
    );
    refused_with(
        c.batch_execute("UPDATE ledger_entries SET balance_after = balance_after"),
        CHECK_VIOLATION,
    );
}

#[test]
fn journal_refuses_delete_of_a_ledger_entries_row() {
    let Some((db, _, _, tx)) = populated() else {
        return;
    };
    let mut c = sql(&db);
    let m = refused_with(
        c.batch_execute(&format!(
            "DELETE FROM ledger_entries WHERE tx_id = {}::uuid",
            lit(&tx)
        )),
        CHECK_VIOLATION,
    );
    assert!(
        m.contains("ledger_entries is append-only: DELETE refused"),
        "{m}"
    );
}

/// Every statement of the three refusal cases above and below, as `left the book untouched by all of the above` runs
/// them first.
fn every_refused_write(tx: &str) -> Vec<String> {
    let id = lit(tx);
    vec![
        "UPDATE ledger_entries SET amount = 999999".to_owned(),
        "UPDATE ledger_entries SET balance_after = balance_after".to_owned(),
        format!("DELETE FROM ledger_entries WHERE tx_id = {id}::uuid"),
        "TRUNCATE ledger_entries".to_owned(),
        "TRUNCATE ledger_tx CASCADE".to_owned(),
        "TRUNCATE accounts CASCADE".to_owned(),
        format!("UPDATE ledger_tx SET hash = hash || 'x' WHERE id = {id}::uuid"),
        format!("UPDATE ledger_tx SET reason = 'edited' WHERE id = {id}::uuid"),
        format!("UPDATE ledger_tx SET posted_at = now() WHERE id = {id}::uuid"),
        format!("UPDATE ledger_tx SET previous_hash = 'x' WHERE id = {id}::uuid"),
        format!("DELETE FROM ledger_tx WHERE id = {id}::uuid"),
    ]
}

#[test]
fn journal_refuses_truncate_of_entries_and_tx_including_through_cascade_from_accounts() {
    let Some((db, ..)) = populated() else { return };
    let mut c = sql(&db);
    let m = refused_with(c.batch_execute("TRUNCATE ledger_entries"), CHECK_VIOLATION);
    assert!(
        m.contains("ledger_entries is append-only: TRUNCATE refused"),
        "{m}"
    );
    let m = refused_with(
        c.batch_execute("TRUNCATE ledger_tx CASCADE"),
        CHECK_VIOLATION,
    );
    assert!(m.contains("append-only: TRUNCATE refused"), "{m}");
    refused_with(
        c.batch_execute("TRUNCATE accounts CASCADE"),
        CHECK_VIOLATION,
    );
}

#[test]
fn journal_refuses_update_and_delete_of_any_ledger_tx_column() {
    let Some((db, _, _, tx)) = populated() else {
        return;
    };
    let mut c = sql(&db);
    for stmt in &every_refused_write(&tx)[6..] {
        let m = refused_with(c.batch_execute(stmt), CHECK_VIOLATION);
        assert!(m.contains("ledger_tx is append-only"), "{stmt}: {m}");
    }
}

#[test]
fn journal_left_the_book_untouched_by_all_of_the_above() {
    let Some((db, _, _, tx)) = populated() else {
        return;
    };
    let mut c = sql(&db);
    for stmt in every_refused_write(&tx) {
        refused_with(c.batch_execute(&stmt), CHECK_VIOLATION);
    }
    assert_book_proves(&mut c);
    assert_eq!(count(&mut c, "SELECT count(*) FROM ledger_entries"), 2);
}

#[test]
fn journal_the_writes_the_application_legitimately_makes_are_still_allowed() {
    let Some((db, ..)) = populated() else { return };
    let mut c = sql(&db);
    c.batch_execute("UPDATE accounts SET balance = balance WHERE true")
        .unwrap();
    c.batch_execute("UPDATE chain_tip SET updated_at = now() WHERE id = true")
        .unwrap();
    c.batch_execute("UPDATE ledger_tx_outbox SET published_at = now() WHERE published_at IS NULL")
        .unwrap();
}

#[test]
fn journal_break_glass_disabling_the_trigger_by_name_lets_a_change_through_and_enabling_restores_it()
 {
    let Some((db, ..)) = populated() else { return };
    let mut c = sql(&db);
    c.batch_execute("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_immutable")
        .unwrap();
    let through = (|| -> Result<(), postgres::Error> {
        c.batch_execute("UPDATE ledger_entries SET amount = amount WHERE false")?;
        let id: String = c
            .query_one("SELECT id::text FROM ledger_entries LIMIT 1", &[])?
            .get(0);
        c.execute(
            "UPDATE ledger_entries SET balance_after = balance_after WHERE id = $1::text::bigint",
            &[&id],
        )?;
        Ok(())
    })();
    c.batch_execute("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_immutable")
        .unwrap();
    through.unwrap();
    refused_with(
        c.batch_execute("UPDATE ledger_entries SET amount = amount"),
        CHECK_VIOLATION,
    );
}

/// Two fresh accounts, for raw journal inserts.
fn account_pair(c: &mut Client, a: &str, b: &str) -> (String, String) {
    (account(c, a), account(c, b))
}

#[test]
fn journal_refuses_a_one_sided_transaction_at_commit_and_nothing_of_it_remains() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (a, _) = account_pair(&mut c, "USDT", "USDT");
    let mut t = c.transaction().unwrap();
    let id = insert_tx(&mut t, "unbal-one-sided");
    t.batch_execute(&entry_sql(&id, &a, "USDT", "debit", "5", "5"))
        .unwrap();
    let m = refused_with(t.commit(), CHECK_VIOLATION);
    assert!(m.contains("does not balance: asset USDT nets to 5"), "{m}");
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM ledger_tx WHERE idempotency_key = 'unbal-one-sided'"
        ),
        0
    );
}

#[test]
fn journal_refuses_two_entries_that_balance_in_amount_but_not_per_asset() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (usdt, btc) = account_pair(&mut c, "USDT", "BTC");
    let mut t = c.transaction().unwrap();
    let id = insert_tx(&mut t, "unbal-cross-asset");
    t.batch_execute(&entry_sql(&id, &usdt, "USDT", "debit", "5", "5"))
        .unwrap();
    t.batch_execute(&entry_sql(&id, &btc, "BTC", "credit", "5", "5"))
        .unwrap();
    let m = refused_with(t.commit(), CHECK_VIOLATION);
    assert!(m.contains("does not balance"), "{m}");
}

#[test]
fn journal_refuses_unequal_amounts_in_the_same_asset() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (a, b) = account_pair(&mut c, "USDT", "USDT");
    let mut t = c.transaction().unwrap();
    let id = insert_tx(&mut t, "unbal-unequal");
    t.batch_execute(&entry_sql(&id, &a, "USDT", "debit", "5", "5"))
        .unwrap();
    t.batch_execute(&entry_sql(
        &id,
        &b,
        "USDT",
        "credit",
        "4.999999999999999999",
        "4",
    ))
    .unwrap();
    refused_with(t.commit(), CHECK_VIOLATION);
}

#[test]
fn journal_accepts_a_balanced_transaction_entries_inserted_one_at_a_time() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let (a, b) = account_pair(&mut c, "USDT", "USDT");
    let mut t = c.transaction().unwrap();
    let id = insert_tx(&mut t, "bal-one-at-a-time");
    t.batch_execute(&entry_sql(&id, &b, "USDT", "credit", "7", "7"))
        .unwrap();
    // Unbalanced right now; only the final state at COMMIT is judged.
    t.batch_execute(&entry_sql(&id, &a, "USDT", "debit", "7", "7"))
        .unwrap();
    t.commit().unwrap();
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE t.idempotency_key = 'bal-one-at-a-time'"
        ),
        2
    );
}

#[test]
fn journal_a_transaction_with_no_entries_is_not_judged() {
    // The documented gap: only entries fire the check.
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    assert!(!insert_tx(&mut c, "no-entries-tx-1").is_empty());
}

#[test]
fn journal_down_restores_the_prior_behaviour_and_up_refuses_again() {
    let Some(db) = book() else { return };
    let store = db.store();
    let p = engine();
    deposit(&store, &p, JOURNAL_USER, "10", "down-1");
    let mut c = sql(&db);
    refused_with(
        c.batch_execute("UPDATE ledger_entries SET amount = amount"),
        CHECK_VIOLATION,
    );

    c.batch_execute(file("0023_entries_immutable.down.sql"))
        .unwrap();
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'ledger' AND t.tgname IN
                ('ledger_entries_immutable','ledger_tx_immutable','ledger_entries_no_truncate','ledger_tx_no_truncate','ledger_entries_tx_must_balance')"
        ),
        0
    );
    // 0016's narrower guard is untouched by this migration's reversal.
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM pg_trigger WHERE tgname = 'ledger_tx_key_immutable' AND tgrelid = 'ledger.ledger_tx'::regclass"
        ),
        1
    );

    c.batch_execute("UPDATE ledger_entries SET balance_after = balance_after")
        .unwrap();
    let (a, _) = account_pair(&mut c, "USDT", "USDT");
    // Commits with a one-sided entry: the balance trigger is gone.
    let mut t = c.transaction().unwrap();
    let id = insert_tx(&mut t, "down-unbalanced");
    t.batch_execute(&entry_sql(&id, &a, "USDT", "debit", "1", "1"))
        .unwrap();
    t.commit().unwrap();
    c.batch_execute("DELETE FROM ledger_entries").unwrap();
    c.batch_execute("TRUNCATE ledger_entries").unwrap();

    // Re-applying UP puts the guards back (DROP IF EXISTS / OR REPLACE).
    c.batch_execute(file("0023_entries_immutable.sql")).unwrap();
    // The table is empty after the DELETE above, so the row trigger is given a row to refuse.
    deposit(&store, &p, JOURNAL_USER, "3", "down-2");
    refused_with(
        c.batch_execute("UPDATE ledger_entries SET amount = amount"),
        CHECK_VIOLATION,
    );
    refused_with(c.batch_execute("TRUNCATE ledger_entries"), CHECK_VIOLATION);
}

// ── idempotency-key-backstop.test.ts ─────────────────────────────────────────────────────────────────────────────────

fn raw_key(c: &mut Client, key: &str) -> Result<(), postgres::Error> {
    c.batch_execute(&format!(
        "INSERT INTO ledger_tx (idempotency_key, module, reason, hash) VALUES ({}, 'test', 'raw sql, no ledger-client', {})",
        lit(key),
        lit(&format!("h{key}"))
    ))
}

#[test]
fn idempotency_key_refuses_a_short_key_via_raw_sql() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    for key in ["", "x", "short", "1234567"] {
        let (code, m) = refused(raw_key(&mut c, key));
        assert_eq!(code, CHECK_VIOLATION, "{key:?}: {m}");
    }
}

#[test]
fn idempotency_key_accepts_the_shortest_key_assert_valid_post_allows() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    raw_key(&mut c, "12345678").unwrap();
}

#[test]
fn idempotency_key_the_empty_key_cannot_be_squatted() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(raw_key(&mut c, ""), CHECK_VIOLATION);
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM ledger_tx WHERE idempotency_key = ''"
        ),
        0
    );
}

// ── outbox-amount-string.test.ts ─────────────────────────────────────────────────────────────────────────────────────

fn outbox(
    c: &mut Client,
    tx: &str,
    payload: &str,
    correlation: &str,
) -> Result<(), postgres::Error> {
    c.batch_execute(&format!(
        "INSERT INTO ledger_tx_outbox (tx_id, payload, correlation_id) VALUES ({}::uuid, {}::jsonb, {})",
        lit(tx),
        lit(payload),
        lit(correlation)
    ))
}

#[test]
fn outbox_amount_refuses_an_empty_payload_and_a_number_then_stores_the_decimal_string() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let tx: String = c
        .query_one(
            "INSERT INTO ledger_tx (idempotency_key, module, reason, hash) VALUES ('l57outbox', 'test', 'outbox amount string', 'h-l57-outbox') RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    refused_with(outbox(&mut c, &tx, "{}", "l57-empty"), CHECK_VIOLATION);
    refused_with(
        outbox(&mut c, &tx, r#"{"entries":[{"amount":1}]}"#, "l57-number"),
        CHECK_VIOLATION,
    );
    outbox(&mut c, &tx, r#"{"entries":[{"amount":"1"}]}"#, "l57-string").unwrap();
    assert_eq!(
        count(
            &mut c,
            &format!(
                "SELECT count(*) FROM ledger_tx_outbox WHERE tx_id = {}::uuid",
                lit(&tx)
            )
        ),
        1
    );
}

#[test]
fn outbox_amount_checks_each_direct_entry_without_lax_jsonpath_unwrapping() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let tx: String = c
        .query_one(
            "INSERT INTO ledger_tx (idempotency_key, module, reason, hash) VALUES ('structural-outbox', 'test', 'direct entries', 'fixture-hash') RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    for entry in [
        "[]",
        "[[]]",
        "{}",
        "null",
        "1",
        r#""1""#,
        r#"{"amount":[]}"#,
        r#"{"amount":{}}"#,
        r#"{"amount":null}"#,
        r#"{"amount":1}"#,
        r#"{"amount":"NaN"}"#,
        r#"{"amount":"1e3"}"#,
    ] {
        let (code, m) = refused(outbox(
            &mut c,
            &tx,
            &format!(r#"{{"entries":[{entry}]}}"#),
            "structural",
        ));
        assert_eq!(code, CHECK_VIOLATION, "{entry}: {m}");
    }
    for amount in [
        "1",
        "0.000000000000000001",
        "-123.456",
        "9007199254740993.123456789012345678",
    ] {
        outbox(
            &mut c,
            &tx,
            &format!(r#"{{"entries":[{{"amount":"{amount}"}}]}}"#),
            "decimal",
        )
        .unwrap();
        c.batch_execute(&format!(
            "DELETE FROM ledger_tx_outbox WHERE tx_id = {}::uuid",
            lit(&tx)
        ))
        .unwrap();
    }
}

// ── asset-registry.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

const ASSET_USER: &str = "0007e7f3-2e25-4dc9-88b4-146db6d491f0";

fn open_account(asset: &str) -> String {
    format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose) VALUES ('user'::owner_type, {}, {}, 'available'::account_kind, '')",
        lit(ASSET_USER),
        lit(asset)
    )
}

#[test]
fn asset_fk_refuses_an_account_in_an_asset_with_no_row_in_ledger_assets() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(c.batch_execute(&open_account("USTD")), FK_VIOLATION);
}

#[test]
fn asset_fk_still_allows_every_asset_the_seed_migrations_registered() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    for asset in ["USDT", "BTC", "IFC", "XAU", "EUR"] {
        c.batch_execute(&open_account(asset))
            .unwrap_or_else(|e| panic!("{asset}: {e}"));
    }
}

#[test]
fn asset_fk_refuses_an_update_that_moves_an_account_into_an_unregistered_asset() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute(&open_account("ETH")).unwrap();
    refused_with(
        c.batch_execute("UPDATE accounts SET asset_id = 'ETHH' WHERE asset_id = 'ETH'"),
        FK_VIOLATION,
    );
}

#[test]
fn asset_fk_refuses_an_entry_in_an_unregistered_asset_even_on_a_valid_account() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let acct: String = c
        .query_one(
            &format!(
                "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose) VALUES ('user'::owner_type, {}, 'USDC', 'available'::account_kind, '') RETURNING id::text",
                lit(ASSET_USER)
            ),
            &[],
        )
        .unwrap()
        .get(0);
    let tx: String = c
        .query_one(
            &format!(
                "INSERT INTO ledger_tx (module, reason, idempotency_key, hash) VALUES ('ledger', 'asset-fk-probe', {}, 'not-a-real-chain-hash') RETURNING id::text",
                lit(&format!("asset-fk-{ASSET_USER}"))
            ),
            &[],
        )
        .unwrap()
        .get(0);
    refused_with(
        c.batch_execute(&entry_sql(&tx, &acct, "USDCC", "credit", "1", "1")),
        FK_VIOLATION,
    );
}

#[test]
fn asset_fk_refuses_deleting_an_asset_that_still_holds_balances() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute(&open_account("AUD")).unwrap();
    refused_with(
        c.batch_execute("DELETE FROM assets WHERE id = 'AUD'"),
        FK_VIOLATION,
    );
}

#[test]
fn asset_0006_refuses_on_a_populated_table_naming_the_asset() {
    let Some(db) = without("0006_") else { return };
    let mut c = sql(&db);
    // Exactly the state the pre-0006 schema permitted: a phantom book.
    c.batch_execute(&open_account("USTD")).unwrap();
    let (_, m) = refused(c.batch_execute(file("0006_asset_must_exist.sql")));
    assert!(m.contains("USTD"), "{m}");
    // And it left the row alone: a migration does not move value.
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM accounts WHERE asset_id = 'USTD'"
        ),
        1
    );
}

#[test]
fn asset_0006_applies_cleanly_once_the_phantom_book_is_gone_and_reverses() {
    let Some(db) = without("0006_") else { return };
    let mut c = sql(&db);
    c.batch_execute(&open_account("USTD")).unwrap();
    c.batch_execute("DELETE FROM accounts WHERE asset_id = 'USTD'")
        .unwrap();
    c.batch_execute(file("0006_asset_must_exist.sql")).unwrap();
    refused_with(c.batch_execute(&open_account("USTD")), FK_VIOLATION);
    // Down restores the old behaviour exactly: the door, re-opened.
    c.batch_execute(file("0006_asset_must_exist.down.sql"))
        .unwrap();
    c.batch_execute(&open_account("USTD")).unwrap();
}

// ── owner-identity.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

const OWNER_USER: &str = "0007e7f3-2e25-4dc9-88b4-146db6d491f0";
const OWNER_USER_2: &str = "4286702e-ae18-4d68-8764-62d4b53cc145";
/// The vendored `Member.id`, a `Long`, once it has crossed a wire as a string.
const MEMBER_ID: &str = "1042";

fn owner_insert(owner_type: &str, owner_id: &str) -> String {
    format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose) VALUES ({}::owner_type, {}, 'USDT', 'available'::account_kind, '')",
        lit(owner_type),
        lit(owner_id)
    )
}

#[test]
fn owner_space_refuses_a_vendored_bigint_member_id_in_a_user_account() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(
        c.batch_execute(&owner_insert("user", MEMBER_ID)),
        CHECK_VIOLATION,
    );
}

#[test]
fn owner_space_refuses_an_uppercase_uuid() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(
        c.batch_execute(&owner_insert("user", &OWNER_USER.to_uppercase())),
        CHECK_VIOLATION,
    );
}

#[test]
fn owner_space_refuses_a_uuid_in_a_platform_account() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(
        c.batch_execute(&owner_insert("treasury", OWNER_USER)),
        CHECK_VIOLATION,
    );
    // A UUID starting with a hex letter satisfies the slug grammar unaided.
    refused_with(
        c.batch_execute(&owner_insert(
            "house",
            "a50e8400-e29b-41d4-a716-446655440000",
        )),
        CHECK_VIOLATION,
    );
}

#[test]
fn owner_space_refuses_an_update_that_moves_an_account_into_the_wrong_space() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute(&owner_insert("user", OWNER_USER)).unwrap();
    refused_with(
        c.batch_execute(&format!(
            "UPDATE accounts SET owner_id = {} WHERE owner_id = {}",
            lit(MEMBER_ID),
            lit(OWNER_USER)
        )),
        CHECK_VIOLATION,
    );
}

/// The drift guard's cases, each with what `isValidOwnerId` (`@intafaced/ledger-client`) answered for it on 2026-11-21.
fn owner_cases() -> Vec<(&'static str, String, bool)> {
    let u = OWNER_USER;
    let u2 = OWNER_USER_2;
    let m = MEMBER_ID;
    vec![
        ("user", u.to_owned(), true),
        ("user", m.to_owned(), false),
        ("user", u.to_uppercase(), false),
        ("user", "0".to_owned(), false),
        ("user", "alice".to_owned(), false),
        ("user", String::new(), false),
        ("user", format!("{u} "), false),
        ("user", format!("{u}\n"), false),
        ("subaccount", u2.to_owned(), true),
        ("subaccount", m.to_owned(), false),
        ("module", "bank:loan-reserve".to_owned(), true),
        ("module", format!("pay:clearing:{u2}"), true),
        ("module", "bank:earn:pool-1".to_owned(), true),
        ("module", m.to_owned(), false),
        ("module", u.to_owned(), false),
        ("house", "fees:trade".to_owned(), true),
        ("house", "insurance-fund".to_owned(), true),
        ("house", "market-maker".to_owned(), true),
        ("house", "rewards-engine".to_owned(), true),
        ("house", "burn".to_owned(), true),
        ("house", "Fees:Trade".to_owned(), false),
        ("house", ":leading-colon".to_owned(), false),
        ("treasury", "rail:card-sandbox".to_owned(), true),
        ("treasury", "mint".to_owned(), true),
        ("treasury", "bridge:ethereum".to_owned(), true),
        ("treasury", "venue:BINANCE".to_owned(), true),
        ("treasury", "1042".to_owned(), false),
    ]
}

#[test]
fn owner_space_the_check_agrees_with_the_ledgers_rule_on_every_case_in_both_directions() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let mut disagreements = Vec::new();
    for (owner_type, owner_id, client) in owner_cases() {
        let rust = is_valid_owner_id(owner_type, &owner_id);
        let database = match c.batch_execute(&owner_insert(owner_type, &owner_id)) {
            Ok(()) => true,
            Err(e) if e.code().map(postgres::error::SqlState::code) == Some(CHECK_VIOLATION) => {
                false
            }
            Err(e) => panic!("{owner_type} / {owner_id:?}: {e}"),
        };
        if rust != database || client != database {
            disagreements.push(format!(
                "{owner_type} / {owner_id:?}: client={client} rust={rust} database={database}"
            ));
        }
    }
    assert_eq!(disagreements, Vec::<String>::new());
}

/// The schema without 0005, filled as the live book looked, plus `seed` (`populated`).
fn owner_populated(seed: &str) -> Option<(TestDb, Client)> {
    let db = without("0005_")?;
    let mut c = sql(&db);
    c.batch_execute(&format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance) VALUES
           ('user'::owner_type,     {u},  'USDT', 'available'::account_kind, '',          900),
           ('user'::owner_type,     {u},  'USDT', 'hold'::account_kind,      'order:abc',   0),
           ('user'::owner_type,     {u2}, 'USDT', 'available'::account_kind, '',          500),
           ('house'::owner_type,    'fees:trade',        'USDT', 'available'::account_kind, '',    0.4),
           ('treasury'::owner_type, 'rail:card-sandbox', 'USDT', 'available'::account_kind, '', -11020)",
        u = lit(OWNER_USER),
        u2 = lit(OWNER_USER_2)
    ))
    .unwrap();
    disable_balance_trigger(&mut c);
    if !seed.is_empty() {
        c.batch_execute(seed).unwrap();
    }
    Some((db, c))
}

fn apply_0005(c: &mut Client) -> Result<(), postgres::Error> {
    c.batch_execute(file("0005_owner_identifier_space.sql"))
}

fn account_rows(c: &mut Client) -> Vec<Vec<Option<String>>> {
    c.query(
        "SELECT owner_type::text, owner_id, asset_id, kind::text, purpose, balance::text FROM accounts ORDER BY id",
        &[],
    )
    .unwrap()
    .iter()
    .map(|r| (0..6).map(|i| r.get(i)).collect())
    .collect()
}

#[test]
fn owner_0005_refuses_while_a_wrong_space_account_holds_value_and_names_it() {
    let seed = format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance) VALUES ('user'::owner_type, {}, 'USDT', 'available'::account_kind, '', 250)",
        lit(MEMBER_ID)
    );
    let Some((_db, mut c)) = owner_populated(&seed) else {
        return;
    };
    let (_, m) = refused(apply_0005(&mut c));
    assert!(m.contains("1042"), "{m}");
    // Nothing half-applied: the file runs as one implicit transaction.
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE c.conname = 'accounts_owner_id_space_ck' AND n.nspname = 'ledger'"
        ),
        0
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM accounts"), 6);
}

#[test]
fn owner_0005_applies_cleanly_on_conformant_data_changing_nothing() {
    let Some((_db, mut c)) = owner_populated("") else {
        return;
    };
    let before = account_rows(&mut c);
    apply_0005(&mut c).unwrap();
    assert_eq!(account_rows(&mut c), before);
}

#[test]
fn owner_0005_canonicalises_an_uppercase_uuid_and_keeps_its_balance_exactly() {
    let seed = format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance) VALUES ('user'::owner_type, {}, 'BTC', 'available'::account_kind, '', 1.234567890123456789)",
        lit(&OWNER_USER_2.to_uppercase())
    );
    let Some((_db, mut c)) = owner_populated(&seed) else {
        return;
    };
    apply_0005(&mut c).unwrap();
    let rows = c
        .query(
            "SELECT owner_id, balance::text FROM accounts WHERE asset_id = 'BTC'",
            &[],
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, String>(0), OWNER_USER_2);
    // 18dp preserved through the backfill.
    assert_eq!(rows[0].get::<_, String>(1), "1.234567890123456789");
}

#[test]
fn owner_0005_refuses_to_lowercase_into_a_collision() {
    let seed = format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance) VALUES ('user'::owner_type, {}, 'USDT', 'available'::account_kind, '', 100)",
        lit(&OWNER_USER.to_uppercase())
    );
    let Some((_db, mut c)) = owner_populated(&seed) else {
        return;
    };
    let (_, m) = refused(apply_0005(&mut c));
    assert!(m.to_lowercase().contains("case"), "{m}");
}

#[test]
fn owner_0005_reclaims_a_wrong_space_account_that_never_held_anything() {
    let Some((_db, mut c)) = owner_populated(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance) VALUES ('user'::owner_type, '2001', 'USDT', 'available'::account_kind, '', 0)",
    ) else {
        return;
    };
    apply_0005(&mut c).unwrap();
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM accounts WHERE owner_id = '2001'"
        ),
        0
    );
    // The five legitimate rows are untouched.
    assert_eq!(count(&mut c, "SELECT count(*) FROM accounts"), 5);
}

#[test]
fn owner_0005_does_not_reclaim_a_zero_balance_account_that_appears_in_the_journal() {
    let Some((_db, mut c)) = owner_populated(
        "WITH a AS (
           INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
           VALUES ('user'::owner_type, '2002', 'USDT', 'available'::account_kind, '', 0) RETURNING id
         ), t AS (
           INSERT INTO ledger_tx (idempotency_key, module, reason, hash)
           VALUES ('vendor:increase:2002', 'adapter', 'vendor.balance.increase', 'deadbeef') RETURNING id
         )
         INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
         SELECT t.id, a.id, 'USDT', 'debit'::direction, 5, 0 FROM a, t",
    ) else {
        return;
    };
    let (_, m) = refused(apply_0005(&mut c));
    assert!(m.contains("2002"), "{m}");
}

#[test]
fn owner_0005_is_reversible_and_re_applies() {
    let Some((_db, mut c)) = owner_populated("") else {
        return;
    };
    apply_0005(&mut c).unwrap();
    refused_with(
        c.batch_execute(&owner_insert("user", MEMBER_ID)),
        CHECK_VIOLATION,
    );
    c.batch_execute(file("0005_owner_identifier_space.down.sql"))
        .unwrap();
    // Reversed means the door is open again.
    c.batch_execute(&owner_insert("user", MEMBER_ID)).unwrap();
    c.batch_execute(&format!(
        "DELETE FROM accounts WHERE owner_id = {}",
        lit(MEMBER_ID)
    ))
    .unwrap();
    apply_0005(&mut c).unwrap();
    refused_with(
        c.batch_execute(&owner_insert("user", MEMBER_ID)),
        CHECK_VIOLATION,
    );
}

// ── purposed-locks.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

const LOCK_USER: &str = "0007e7f3-2e25-4dc9-88b4-146db6d491f0";

fn kind_with_purpose(kind: &str, purpose: &str) -> String {
    format!(
        "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose) VALUES ('user'::owner_type, {}, 'USDT', {}::account_kind, {})",
        lit(LOCK_USER),
        lit(kind),
        lit(purpose)
    )
}

/// Every kind the database's `account_kind` enum declares but `available`: driven off the kind list, not a copy of it,
/// so a new lock kind is covered the moment it joins the enum.
fn lock_kinds(c: &mut Client) -> Vec<String> {
    c.query(
        "SELECT k::text FROM unnest(enum_range(NULL::ledger.account_kind)) AS k",
        &[],
    )
    .unwrap()
    .iter()
    .map(|r| r.get::<_, String>(0))
    .filter(|k| k != "available")
    .collect()
}

#[test]
fn lock_purpose_still_allows_available_with_an_empty_purpose() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute(&kind_with_purpose("available", ""))
        .unwrap();
}

#[test]
fn lock_purpose_covers_every_non_available_kind_the_enum_declares() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    let kinds = lock_kinds(&mut c);
    assert!(kinds.len() >= 4, "{kinds:?}");
    assert!(!kinds.iter().any(|k| k == "available"));
}

#[test]
fn lock_purpose_refuses_every_unpurposed_lock_kind_via_raw_sql() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    for kind in lock_kinds(&mut c) {
        let (code, m) = refused(c.batch_execute(&kind_with_purpose(&kind, "")));
        assert_eq!(code, CHECK_VIOLATION, "{kind}: {m}");
    }
}

#[test]
fn lock_purpose_refuses_the_legacy_stamp_0007_would_have_minted() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(
        c.batch_execute(&kind_with_purpose(
            "collateral",
            &format!("legacy:{LOCK_USER}"),
        )),
        CHECK_VIOLATION,
    );
}

#[test]
fn lock_purpose_allows_purposed_collateral() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute(&kind_with_purpose("collateral", "loan:probe-1"))
        .unwrap();
}

#[test]
fn lock_purpose_refuses_whitespace_only_and_padded_purposes() {
    // 0011's btrim belt (whitespace only, a trailing space), 0012's JS-trim belt (tab), a tab-only purpose.
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    for purpose in ["   ", "order:x ", "order:x\t", "\t\t\t"] {
        let (code, m) = refused(c.batch_execute(&kind_with_purpose("hold", purpose)));
        assert_eq!(code, CHECK_VIOLATION, "{purpose:?}: {m}");
    }
}

#[test]
fn lock_purpose_refuses_unicode_white_space_pads_string_trim_strips() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    for pad in [
        '\u{FEFF}', '\u{2028}', '\u{2029}', '\u{3000}', '\u{000B}', '\u{00A0}',
    ] {
        let (code, m) =
            refused(c.batch_execute(&kind_with_purpose("hold", &format!("order:x{pad}"))));
        assert_eq!(code, CHECK_VIOLATION, "U+{:04X}: {m}", u32::from(pad));
    }
}

#[test]
fn lock_purpose_allows_a_purpose_ending_in_v_and_one_ending_in_a_character_string_trim_keeps() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    c.batch_execute(&kind_with_purpose("hold", "order:v"))
        .unwrap();
    c.batch_execute(&kind_with_purpose("hold", "order:x\u{180E}"))
        .unwrap();
}

#[test]
fn lock_purpose_refuses_a_purpose_on_available() {
    let Some(db) = book() else { return };
    let mut c = sql(&db);
    refused_with(
        c.batch_execute(&kind_with_purpose("available", "split")),
        CHECK_VIOLATION,
    );
}

// ── operator-owner-balances.test.ts, operator_access_log (0024) ─────────────────────────────────────────────────────

const OPERATOR: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ACCESS_USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn record(
    store: &Store,
    actor: &str,
    request: &str,
    owner_type: &str,
    owner_id: &str,
    action: &str,
) {
    desk::record_lookup(
        store,
        Actor {
            actor_id: actor,
            request_id: Some(request),
        },
        owner_type,
        owner_id,
        action,
    )
    .unwrap();
}

#[test]
fn access_log_stores_one_row_per_read_with_actor_target_and_time() {
    let Some(db) = book() else { return };
    record(
        &db.store(),
        OPERATOR,
        "req-db-1",
        "user",
        ACCESS_USER,
        "owner_balances.read",
    );
    let mut c = sql(&db);
    let rows = c
        .query(
            "SELECT actor_id, action, target_owner_type, target_owner_id, accessed_at IS NOT NULL FROM operator_access_log WHERE request_id = 'req-db-1'",
            &[],
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, String>(0), OPERATOR);
    assert_eq!(rows[0].get::<_, String>(1), "owner_balances.read");
    assert_eq!(rows[0].get::<_, String>(2), "user");
    assert_eq!(rows[0].get::<_, String>(3), ACCESS_USER);
    assert!(rows[0].get::<_, bool>(4));
}

#[test]
fn access_log_refuses_update_delete_and_truncate() {
    let Some(db) = book() else { return };
    record(
        &db.store(),
        OPERATOR,
        "req-db-2",
        "house",
        "fees",
        "owner_balances.read",
    );
    let mut c = sql(&db);
    for stmt in [
        "UPDATE operator_access_log SET actor_id = 'someone-else' WHERE request_id = 'req-db-2'",
        "DELETE FROM operator_access_log WHERE request_id = 'req-db-2'",
        "TRUNCATE operator_access_log",
    ] {
        let (_, m) = refused(c.batch_execute(stmt));
        assert!(m.contains("append-only"), "{stmt}: {m}");
    }
    assert_eq!(count(&mut c, "SELECT count(*) FROM operator_access_log"), 1);
}

#[test]
fn access_log_stores_a_transaction_lookup_and_a_business_key_trace_with_their_own_action() {
    let Some(db) = book() else { return };
    let store = db.store();
    let tx = "99999999-9999-4999-8999-999999999999";
    record(
        &store,
        OPERATOR,
        "req-db-3",
        "transaction",
        tx,
        "transaction.read",
    );
    record(
        &store,
        OPERATOR,
        "req-db-3",
        "business_key",
        "deposit:crypto-native:0xabc",
        "trace.read",
    );
    let rows: Vec<(String, String, String)> = sql(&db)
        .query(
            "SELECT action, target_owner_type, target_owner_id FROM operator_access_log WHERE request_id = 'req-db-3' ORDER BY id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        rows,
        [
            (
                "transaction.read".to_owned(),
                "transaction".to_owned(),
                tx.to_owned()
            ),
            (
                "trace.read".to_owned(),
                "business_key".to_owned(),
                "deposit:crypto-native:0xabc".to_owned()
            ),
        ]
    );
}

#[test]
fn access_log_refuses_an_empty_actor_and_an_unknown_action() {
    let Some(db) = book() else { return };
    let empty_actor = desk::record_lookup(
        &db.store(),
        Actor {
            actor_id: "",
            request_id: None,
        },
        "user",
        ACCESS_USER,
        "owner_balances.read",
    );
    assert!(empty_actor.is_err(), "{empty_actor:?}");
    let mut c = sql(&db);
    refused_with(
        c.batch_execute("INSERT INTO operator_access_log (actor_id, action, target_owner_type, target_owner_id) VALUES ('', 'owner_balances.read', 'user', 'u')"),
        CHECK_VIOLATION,
    );
    refused_with(
        c.batch_execute("INSERT INTO operator_access_log (actor_id, action, target_owner_type, target_owner_id) VALUES ('op', 'export', 'user', 'u')"),
        CHECK_VIOLATION,
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM operator_access_log"), 0);
}

// ── chain-page-entries.test.ts ───────────────────────────────────────────────────────────────────────────────────────

/// A connection through a relay that reads the wire and counts the statements sent whose text names `ledger_entries`
/// (a simple query or a parse), as the TypeScript's `watchEntryReads` proxy counts calls on its `sql`.
fn watched(db: &TestDb) -> (Client, Arc<AtomicUsize>) {
    let reads = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream = url::Url::parse(&db.url).unwrap();
    let target = format!(
        "{}:{}",
        upstream.host_str().unwrap(),
        upstream.port().unwrap_or(5432)
    );
    let counter = reads.clone();
    std::thread::spawn(move || {
        let (mut client, _) = listener.accept().unwrap();
        let mut server = TcpStream::connect(target).unwrap();
        let mut back_server = server.try_clone().unwrap();
        let mut back_client = client.try_clone().unwrap();
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut back_server, &mut back_client);
        });
        let read_exact = |n: usize, from: &mut TcpStream| -> Option<Vec<u8>> {
            let mut buf = vec![0; n];
            from.read_exact(&mut buf).ok().map(|()| buf)
        };
        // Untyped start-up messages (an SSL or GSS request first, then the start-up packet).
        loop {
            let Some(len) = read_exact(4, &mut client) else {
                return;
            };
            let n = u32::from_be_bytes([len[0], len[1], len[2], len[3]]) as usize;
            let Some(body) = read_exact(n - 4, &mut client) else {
                return;
            };
            server.write_all(&len).unwrap();
            server.write_all(&body).unwrap();
            let code = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
            if code != 80_877_103 && code != 80_877_104 {
                break;
            }
        }
        loop {
            let Some(head) = read_exact(5, &mut client) else {
                return;
            };
            let n = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
            let Some(body) = read_exact(n - 4, &mut client) else {
                return;
            };
            if matches!(head[0], b'Q' | b'P') && body.windows(14).any(|w| w == b"ledger_entries") {
                counter.fetch_add(1, Ordering::SeqCst);
            }
            if server.write_all(&head).is_err() || server.write_all(&body).is_err() {
                return;
            }
        }
    });
    let mut relayed = url::Url::parse(&db.url).unwrap();
    relayed.set_host(Some("127.0.0.1")).unwrap();
    relayed.set_port(Some(port)).unwrap();
    let client = Client::connect(relayed.as_str(), NoTls).unwrap();
    (client, reads)
}

#[test]
fn chain_page_a_page_of_more_than_one_transaction_is_one_ledger_entries_query() {
    let Some(db) = book() else { return };
    let store = db.store();
    let p = engine();
    let user = "99999999-9999-4999-8999-999999999999";
    deposit(&store, &p, user, "10", "page-1");
    deposit(&store, &p, user, "20.5", "page-2");

    let (mut c, entry_reads) = watched(&db);
    let page_size = 2;
    let result = reconcile::verify_chain(&mut c, page_size, None).unwrap();
    assert_eq!(result, Chain::Ok { length: page_size });
    assert_eq!(entry_reads.load(Ordering::SeqCst), 1);
}

#[test]
fn chain_page_the_relay_counts_every_entries_statement() {
    // The counter itself, so a count of one above is not a counter that sees nothing.
    let Some(db) = book() else { return };
    let (mut c, entry_reads) = watched(&db);
    c.query("SELECT count(*) FROM ledger.ledger_entries", &[])
        .unwrap();
    c.batch_execute("SELECT 1 FROM ledger.ledger_entries LIMIT 1")
        .unwrap();
    c.query("SELECT 1", &[]).unwrap();
    assert_eq!(entry_reads.load(Ordering::SeqCst), 2);
}
