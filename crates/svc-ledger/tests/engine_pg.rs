//! The posting engine on a real Postgres (`support`: each test in its own throwaway database; without a URL it skips,
//! with `REQUIRE_POSTGRES=1` it fails). Every post is the one the TypeScript test built, made by the same
//! `@intafaced/ledger-client` recipe with the same arguments and recorded by `scripts/record-engine-posts.mjs` into
//! `fixtures/engine-posts.golden.json`; it is booked by the Rust engine (`posting::engine::post`, `PostgresLedger.post`)
//! and read back as `PostgresLedger.balance` reads it. A TypeScript suite whose cases share one database is one Rust
//! test per case, each replaying the earlier cases' posts first.
//!
//! The TypeScript files and cases it holds, case for case:
//! - `services/svc-ledger/src/ledger/postgres-ledger.test.ts`, "database-level guarantees", the posting half: an
//!   unbalanced post refused before any row; a number amount refused (`a_number_amount_never_reaches_the_book` sends it
//!   as the wire carries it: a Rust request cannot hold one); a spend that would take a user negative; the database's
//!   own refusals of a negative non-treasury balance, a zero-amount entry and a duplicate key; 18 decimals round trip;
//!   `balance_after` on every entry; 200 sequential and 50 concurrent posts without drift or a broken chain; a legacy
//!   claim with no stored digest; detect mode. Its reconcile half and journal cap are `reconcile_pg.rs`'s and
//!   `history_pg.rs`'s; "uses a unique schema" checks the TypeScript harness, not the ledger.
//! - `ledger/bank-transfer-reversal.pg.test.ts`, `ledger/futures-order-margin.pg.test.ts`,
//!   `ledger/merchant-proceeds.pg.test.ts`, `ledger/pay-received-hold.pg.test.ts`, `ledger/staff-hold.pg.test.ts`
//!   (the release/confirm race included): every case.
//! - `ledger/tx-hash-bind.test.ts`: every case, the posting side with the chain and claim checks each case makes.
//!
//! The source pins of those files ("not skip-green") are the TypeScript's own; here `REQUIRE_POSTGRES=1` (CI) makes a
//! missing database a failure.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::sync::LazyLock;

use postgres::Client;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use support::TestDb;
use svc_ledger::balances;
use svc_ledger::chain::{self, HashEntry, HashTx};
use svc_ledger::db::{self, Store, with_client};
use svc_ledger::errors::{self, Failure};
use svc_ledger::migrate::FILES;
use svc_ledger::posting::PostError;
use svc_ledger::posting::engine::{self, Conflict, EngineOptions, Mismatch, Posted};
use svc_ledger::posting::rules::{AccountRef, Direction, Entry, PostRequest, read_post};
use svc_ledger::reconcile::{self, Chain};

static FIXTURE: LazyLock<Json> =
    LazyLock::new(|| json::parse(include_str!("fixtures/engine-posts.golden.json")).unwrap());

const CHECK_VIOLATION: &str = "23514";
const UNIQUE_VIOLATION: &str = "23505";

/// A recorded post, read as the door hands it to the engine.
fn request(name: &str) -> PostRequest {
    let body = FIXTURE
        .get("posts")
        .and_then(|p| p.get(name))
        .unwrap_or_else(|| panic!("no recorded post {name}"));
    read_post(body).unwrap()
}

/// A recorded account.
fn account(name: &str) -> AccountRef {
    let a = FIXTURE
        .get("accounts")
        .and_then(|p| p.get(name))
        .unwrap_or_else(|| panic!("no recorded account {name}"));
    let s = |k: &str| match a.get(k) {
        Some(Json::String(v)) => Some(v.clone()),
        _ => None,
    };
    AccountRef {
        owner_type: s("ownerType").unwrap(),
        owner_id: s("ownerId").unwrap(),
        asset_id: s("assetId").unwrap(),
        kind: s("kind").unwrap(),
        purpose: s("purpose"),
    }
}

fn options(conflict: Conflict) -> EngineOptions {
    EngineOptions {
        conflict,
        clock_skew_bound_ms: None,
        clock_ms: svc_ledger::clock::system_ms,
    }
}

/// A migrated book and the engine over it (`new PostgresLedger(db.sql)`).
struct Book {
    db: TestDb,
    store: Store,
}

fn book() -> Option<Book> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    let store = db::open(&db.url, "svc-ledger", 10, false).unwrap();
    Some(Book { db, store })
}

impl Book {
    fn post_as(
        &self,
        r: &PostRequest,
        conflict: Conflict,
        seen: &mut Vec<Mismatch>,
    ) -> Result<Posted, Failure> {
        engine::post(self.store.pool().unwrap(), r, &options(conflict), seen).map_err(|e| match e {
            PostError::Refused(f) => f,
            PostError::Store(s) => panic!("a store error, not a refusal: {}", s.message),
        })
    }

    /// `engine.post(request)`: refuse mode, as the default engine is built.
    fn post_req(&self, r: &PostRequest) -> Result<Posted, Failure> {
        self.post_as(r, Conflict::Refuse, &mut Vec::new())
    }

    fn post(&self, name: &str) -> Result<Posted, Failure> {
        self.post_req(&request(name))
    }

    /// `engine.post` where any error counts (`rejects.toBeTruthy()`): a refusal or a store error.
    fn post_fails(&self, name: &str) -> bool {
        engine::post(
            self.store.pool().unwrap(),
            &request(name),
            &options(Conflict::Refuse),
            &mut Vec::new(),
        )
        .is_err()
    }

    /// `formatAmount((await engine.balance(ref)).amount)`.
    fn bal(&self, name: &str) -> String {
        let a = account(name);
        let (_, amount) = with_client(self.store.pool().unwrap(), |c| {
            Ok(balances::balance(
                c,
                &a.owner_type,
                &a.owner_id,
                &a.asset_id,
                &a.kind,
                a.purpose(),
            ))
        })
        .unwrap()
        .unwrap();
        format_amount(amount)
    }

    fn sql(&self) -> Client {
        self.db.client()
    }

    fn chain(&self) -> Chain {
        reconcile::verify_chain(&mut self.sql(), reconcile::CHAIN_BATCH, None).unwrap()
    }

    fn balances_ok(&self) -> bool {
        reconcile::reconcile_balances(&mut self.sql()).unwrap().ok
    }

    fn tx_count(&self) -> i64 {
        self.db.count("SELECT count(*) FROM ledger.ledger_tx")
    }
}

/// A refusal's code (`InsufficientFundsError` is `ledger.insufficient_funds`).
fn code(f: &Failure) -> &str {
    match f {
        Failure::Ledger { code, .. } => code,
        Failure::InsufficientFunds { .. } => errors::INSUFFICIENT_FUNDS,
        other => panic!("not a ledger refusal: {other:?}"),
    }
}

fn insufficient(r: Result<Posted, Failure>) {
    match r {
        Err(Failure::InsufficientFunds { .. }) => {}
        other => panic!("expected InsufficientFundsError, got {other:?}"),
    }
}

/// The SQLSTATE and constraint a statement was refused with.
fn refused(r: Result<u64, postgres::Error>) -> (String, String) {
    let e = r.expect_err("the database accepted it");
    let db = e
        .as_db_error()
        .unwrap_or_else(|| panic!("not a database refusal: {e}"));
    (
        db.code().code().to_owned(),
        db.constraint().unwrap_or("").to_owned(),
    )
}

fn user_ref(owner: &str, asset: &str) -> AccountRef {
    AccountRef {
        owner_type: "user".to_owned(),
        owner_id: owner.to_owned(),
        asset_id: asset.to_owned(),
        kind: "available".to_owned(),
        purpose: None,
    }
}

fn leg(account: &AccountRef, direction: Direction, amount: &str) -> Entry {
    Entry {
        account: account.clone(),
        direction,
        amount: parse_amount(amount).unwrap(),
    }
}

// ── ledger/postgres-ledger.test.ts: "svc-ledger — database-level guarantees" ─────────────────────────────────────────

const PL_USER: &str = "99999999-9999-4999-8999-999999999999";

#[test]
fn an_unbalanced_post_is_refused_before_any_row_is_written() {
    let Some(b) = book() else { return };
    let usdt = user_ref(PL_USER, "USDT");
    let r = PostRequest {
        idempotency_key: "unbalanced-engine-1".to_owned(),
        module: "test".to_owned(),
        reason: "unbalanced".to_owned(),
        entries: vec![
            leg(&usdt, Direction::Debit, "10"),
            leg(&usdt, Direction::Credit, "9"),
        ],
        meta: None,
        correlation_id: None,
    };
    assert_eq!(code(&b.post_req(&r).unwrap_err()), errors::UNBALANCED);
    assert_eq!(b.tx_count(), 0, "the journal stays empty");
    assert_eq!(b.db.count("SELECT count(*) FROM ledger.ledger_entries"), 0);
}

#[test]
fn a_number_amount_never_reaches_the_book() {
    let Some(b) = book() else { return };
    // The engine takes scaled integers only; a number can arrive only on the wire, and is refused there.
    let body = json::parse(&format!(
        r#"{{"idempotencyKey":"js-number-engine-1","module":"test","reason":"number-amount","entries":[{{"account":{{"ownerType":"user","ownerId":"{PL_USER}","assetId":"USDT","kind":"available"}},"direction":"debit","amount":10}},{{"account":{{"ownerType":"user","ownerId":"{PL_USER}","assetId":"USDT","kind":"available"}},"direction":"credit","amount":10}}]}}"#
    ))
    .unwrap();
    assert!(
        read_post(&body).is_err(),
        "a number amount is not read as money"
    );
    let posting = support::idle_posting();
    let out = svc_ledger::posting::post(&b.store, &posting, None, "dual", &body);
    assert!(out.is_err(), "{out:?}");
    assert_eq!(b.tx_count(), 0, "the journal stays empty");
}

#[test]
fn a_spend_that_would_take_a_user_negative_is_refused_without_writing() {
    let Some(b) = book() else { return };
    b.post("pl.neg.deposit").unwrap();
    insufficient(b.post("pl.neg.hold"));
    assert_eq!(b.bal("pl.usdt"), "10");
    assert_eq!(b.tx_count(), 1);
}

#[test]
fn the_database_itself_refuses_a_negative_non_treasury_balance() {
    let Some(b) = book() else { return };
    let mut c = b.sql();
    c.execute(
        "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind) VALUES ('user', $1, 'BTC', 'available') ON CONFLICT DO NOTHING",
        &[&PL_USER],
    )
    .unwrap();
    let (_, constraint) = refused(c.execute(
        "UPDATE ledger.accounts SET balance = -1 WHERE owner_type = 'user' AND owner_id = $1 AND asset_id = 'BTC'",
        &[&PL_USER],
    ));
    assert_eq!(constraint, "accounts_non_negative_ck");
}

#[test]
fn the_database_itself_refuses_a_zero_amount_entry() {
    let Some(b) = book() else { return };
    let mut c = b.sql();
    c.execute(
        "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind) VALUES ('user', $1, 'BTC', 'available') ON CONFLICT DO NOTHING",
        &[&PL_USER],
    )
    .unwrap();
    let tx: String = c
        .query_one(
            "INSERT INTO ledger.ledger_tx (idempotency_key, module, reason, hash) VALUES ('ck-test-zero-amount', 'test', 'test', 'deadbeef') RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    let account: String = c
        .query_one(
            "SELECT id::text FROM ledger.accounts WHERE owner_type = 'user' AND owner_id = $1 AND asset_id = 'BTC'",
            &[&PL_USER],
        )
        .unwrap()
        .get(0);
    let (_, constraint) = refused(c.execute(
        "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
         VALUES ($1::text::uuid, $2::text::uuid, 'BTC', 'debit', 0, 0)",
        &[&tx, &account],
    ));
    assert_eq!(constraint, "ledger_entries_positive_ck");
}

#[test]
fn a_duplicate_idempotency_key_is_refused_at_the_unique_index() {
    let Some(b) = book() else { return };
    let mut c = b.sql();
    let insert = "INSERT INTO ledger.ledger_tx (idempotency_key, module, reason, hash) VALUES ('dupe-test-key', 't', 't', $1)";
    c.execute(insert, &[&"a"]).unwrap();
    let (state, constraint) = refused(c.execute(insert, &[&"b"]));
    assert_eq!(
        (state.as_str(), constraint.as_str()),
        (UNIQUE_VIOLATION, "ledger_tx_idempotency_idx")
    );
}

#[test]
fn full_18_decimal_precision_survives_a_round_trip() {
    let Some(b) = book() else { return };
    b.post("pl.precision.deposit").unwrap();
    assert_eq!(b.bal("pl.eth"), "0.123456789012345678");
}

#[test]
fn balance_after_is_recorded_on_every_entry_matching_the_final_state() {
    let Some(b) = book() else { return };
    b.post("pl.ba.deposit").unwrap();
    b.post("pl.ba.hold").unwrap();
    // `journal().at(-1)`: the last transaction in commit order, its credit leg (the available pot).
    let after: String = b
        .sql()
        .query_one(
            "SELECT e.balance_after::text FROM ledger.ledger_entries e JOIN ledger.ledger_tx t ON t.id = e.tx_id
              WHERE e.direction = 'credit' AND t.seq = (SELECT max(seq) FROM ledger.ledger_tx)",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(format_amount(parse_amount(&after).unwrap()), "70");
    let unset =
        b.db.count("SELECT count(*) FROM ledger.ledger_entries WHERE balance_after IS NULL");
    assert_eq!(unset, 0, "every entry carries balance_after");
}

#[test]
fn two_hundred_sequential_posts_hold_zero_drift() {
    let Some(b) = book() else { return };
    b.post("pl.vol.deposit").unwrap();
    for i in 0..100 {
        b.post(&format!("pl.vol.hold.{i}")).unwrap();
        b.post(&format!("pl.vol.release.{i}")).unwrap();
    }
    assert_eq!(b.bal("pl.usdt"), "100000");
    assert!(b.balances_ok());
    assert!(b.chain().ok());
    let totals = reconcile::totals_by_asset(&mut b.sql()).unwrap();
    assert_eq!(totals, [("USDT".to_owned(), "0".to_owned())]);
}

#[test]
fn fifty_concurrent_posts_serialise_without_drift_or_a_broken_chain() {
    let Some(b) = book() else { return };
    b.post("pl.conc.deposit").unwrap();
    let outcomes: Vec<Result<Posted, Failure>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..50)
            .map(|i| {
                let b = &b;
                s.spawn(move || b.post(&format!("pl.conc.hold.{i}")))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for o in &outcomes {
        assert!(o.is_ok(), "{o:?}");
    }
    assert_eq!(b.bal("pl.usdt"), "9500");
    assert!(b.balances_ok());
    // Concurrency must not fork the chain.
    assert_eq!(b.chain(), Chain::Ok { length: 51 });
}

#[test]
fn a_legacy_claim_with_no_stored_digest_answers_the_original_and_new_posts_store_one() {
    let Some(b) = book() else { return };
    let first = b.post("pl.legacy.first").unwrap();
    let mut c = b.sql();
    let stored: Option<String> = c
        .query_one(
            "SELECT request_fingerprint FROM ledger.ledger_posted_keys WHERE tx_id = $1::text::uuid",
            &[&first.id],
        )
        .unwrap()
        .get(0);
    let stored = stored.expect("a new post stores its digest");
    assert!(
        stored.len() == 64
            && stored
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "{stored}"
    );

    c.batch_execute(
        "ALTER TABLE ledger.ledger_posted_keys DISABLE TRIGGER ledger_posted_keys_immutable",
    )
    .unwrap();
    c.execute(
        "UPDATE ledger.ledger_posted_keys SET request_fingerprint = NULL WHERE tx_id = $1::text::uuid",
        &[&first.id],
    )
    .unwrap();
    c.batch_execute(
        "ALTER TABLE ledger.ledger_posted_keys ENABLE TRIGGER ledger_posted_keys_immutable",
    )
    .unwrap();
    assert_eq!(b.post("pl.legacy.other").unwrap().id, first.id);
}

#[test]
fn detect_mode_answers_a_different_body_with_the_original_and_reports_it() {
    let Some(b) = book() else { return };
    let mut seen = Vec::new();
    let first = b
        .post_as(&request("pl.detect.first"), Conflict::Detect, &mut seen)
        .unwrap();
    let other = request("pl.detect.other");
    assert_eq!(
        b.post_as(&other, Conflict::Detect, &mut seen).unwrap().id,
        first.id
    );
    assert_eq!(
        seen,
        [Mismatch {
            idempotency_key: first.idempotency_key.clone(),
            module: other.module.clone(),
            reason: other.reason.clone(),
        }]
    );
    // The same body is a plain retry: nothing reported.
    b.post_as(&request("pl.detect.first"), Conflict::Detect, &mut seen)
        .unwrap();
    assert_eq!(seen.len(), 1);
    // The default engine (the spec) refuses.
    assert_eq!(
        code(&b.post_req(&other).unwrap_err()),
        errors::IDEMPOTENCY_CONFLICT
    );
}

// ── ledger/bank-transfer-reversal.pg.test.ts ─────────────────────────────────────────────────────────────────────────

fn reverses_a_posted_send_once(b: &Book) {
    b.post("btr.deposit").unwrap();
    b.post("btr.t1").unwrap();
    b.post("btr.reverse.t1").unwrap();
    b.post("btr.reverse.t1").unwrap();
    assert_eq!(b.bal("btr.from"), "1000");
    assert_eq!(b.bal("btr.to"), "0");
}

#[test]
fn a_consented_reversal_reverses_a_posted_send_once() {
    let Some(b) = book() else { return };
    reverses_a_posted_send_once(&b);
}

#[test]
fn a_reversal_the_recipient_can_no_longer_fund_is_refused_and_moves_nothing() {
    let Some(b) = book() else { return };
    reverses_a_posted_send_once(&b);
    b.post("btr.t2").unwrap();
    // The recipient spends 30 of it, so the whole 50 can no longer come back.
    b.post("btr.t3").unwrap();
    insufficient(b.post("btr.reverse.t2"));
    assert_eq!(b.bal("btr.from"), "980");
    assert_eq!(b.bal("btr.to"), "20");
}

// ── ledger/futures-order-margin.pg.test.ts ───────────────────────────────────────────────────────────────────────────

fn holds_applies_a_fill_and_posts_each_key_once(b: &Book) {
    b.post("fom.deposit").unwrap();
    b.post("fom.hold.o1").unwrap();
    b.post("fom.hold.o2").unwrap();
    assert_eq!(b.bal("fom.available"), "200");
    b.post("fom.apply.o1").unwrap();
    b.post("fom.apply.o1").unwrap();
    assert_eq!(b.bal("fom.margin.o1"), "0");
    assert_eq!(b.bal("fom.position.1"), "250");
    assert_eq!(b.bal("fom.available"), "250");
    assert_eq!(b.bal("fom.margin.o2"), "500");
}

#[test]
fn order_margin_holds_applies_a_fill_with_a_returned_remainder_in_one_posting_once() {
    let Some(b) = book() else { return };
    holds_applies_a_fill_and_posts_each_key_once(&b);
}

#[test]
fn order_margin_refuses_a_release_or_fill_past_what_the_one_order_holds() {
    let Some(b) = book() else { return };
    holds_applies_a_fill_and_posts_each_key_once(&b);
    insufficient(b.post("fom.release.o2"));
    insufficient(b.post("fom.apply.o2"));
    assert_eq!(b.bal("fom.margin.o2"), "500");
    assert_eq!(b.bal("fom.position.2"), "0");
    assert_eq!(b.bal("fom.available"), "250");
}

// ── ledger/merchant-proceeds.pg.test.ts ──────────────────────────────────────────────────────────────────────────────

const MERCHANT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MERCHANT_OWNER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

#[test]
fn merchant_proceeds_upserts_a_module_row_and_refuses_a_debit_past_zero() {
    let Some(b) = book() else { return };
    b.post("mp.capture").unwrap();
    b.post("mp.settlement").unwrap();
    let owner = format!("pay:proceeds:{MERCHANT}");
    let rows = b
        .sql()
        .query(
            "SELECT owner_type::text, owner_id, kind::text, purpose, balance::text FROM ledger.accounts WHERE owner_id = $1",
            &[&owner],
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    let col = |i: usize| -> String { rows[0].get(i) };
    assert_eq!(
        (col(0), col(1), col(2), col(3)),
        (
            "module".to_owned(),
            owner.clone(),
            "available".to_owned(),
            String::new()
        )
    );
    let balance = col(4);
    let fraction = balance
        .strip_prefix("97.5")
        .unwrap_or_else(|| panic!("{balance}"));
    assert!(fraction.bytes().all(|c| c == b'0'), "{balance}");
    let proceeds = account("mp.proceeds");
    assert_eq!(
        (
            proceeds.owner_type.as_str(),
            proceeds.owner_id.as_str(),
            proceeds.kind.as_str()
        ),
        ("module", owner.as_str(), "available")
    );
    let personal = b
        .sql()
        .query(
            "SELECT id FROM ledger.accounts WHERE owner_type = 'user' AND owner_id = $1",
            &[&MERCHANT_OWNER],
        )
        .unwrap();
    assert!(personal.is_empty());

    insufficient(b.post("mp.payout.overdraft"));
    assert_eq!(b.bal("mp.proceeds"), "97.5");
    let (state, _) = refused(b.sql().execute(
        "UPDATE ledger.accounts SET balance = -1 WHERE owner_id = $1",
        &[&owner],
    ));
    assert_eq!(state, CHECK_VIOLATION);
    assert_eq!(b.bal("mp.proceeds"), "97.5");
}

// ── ledger/pay-received-hold.pg.test.ts ──────────────────────────────────────────────────────────────────────────────

fn holds_releases_once_and_refuses_a_return_after_the_release(b: &Book) {
    b.post("prh.deposit").unwrap();
    b.post("prh.hold.h1").unwrap();
    b.post("prh.hold.h1").unwrap();
    b.post("prh.hold.h2").unwrap();
    assert_eq!(b.bal("prh.recipient"), "500");
    b.post("prh.release.h1").unwrap();
    b.post("prh.release.h1").unwrap();
    assert_eq!(b.bal("prh.recipient"), "800");
    assert_eq!(b.bal("prh.held.h1"), "0");
    insufficient(b.post("prh.return.h1"));
    assert_eq!(b.bal("prh.payer"), "0");
    assert_eq!(b.bal("prh.held.h2"), "200");
}

#[test]
fn a_received_hold_releases_once_and_refuses_a_return_after_the_release() {
    let Some(b) = book() else { return };
    holds_releases_once_and_refuses_a_return_after_the_release(&b);
}

#[test]
fn a_received_hold_returns_to_the_payer_once_and_never_draws_on_another_hold() {
    let Some(b) = book() else { return };
    holds_releases_once_and_refuses_a_return_after_the_release(&b);
    insufficient(b.post("prh.release.h2"));
    b.post("prh.return.h2").unwrap();
    b.post("prh.return.h2").unwrap();
    assert_eq!(b.bal("prh.payer"), "200");
    assert_eq!(b.bal("prh.held.h2"), "0");
    assert_eq!(b.bal("prh.recipient"), "800");
}

// ── ledger/staff-hold.pg.test.ts ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_staff_hold_of_40_releases_15_and_confirms_the_remaining_25_once() {
    let Some(b) = book() else { return };
    b.post("sh.a.deposit").unwrap();
    b.post("sh.a.place.1").unwrap();
    b.post("sh.a.place.1").unwrap();
    assert_eq!(b.bal("sh.a.available"), "60");
    assert_eq!(b.bal("sh.a.held.1"), "40");
    b.post("sh.a.release.1.1").unwrap();
    b.post("sh.a.release.1.1").unwrap();
    assert_eq!(b.bal("sh.a.held.1"), "25");
    assert_eq!(b.bal("sh.a.available"), "75");
    b.post("sh.a.confirm.1.1").unwrap();
    b.post("sh.a.confirm.1.1").unwrap();
    assert_eq!(b.bal("sh.a.held.1"), "0");
    assert_eq!(b.bal("sh.a.confirmed"), "25");
    assert_eq!(b.bal("sh.a.available"), "75");
    insufficient(b.post("sh.a.release.1.2"));
    insufficient(b.post("sh.a.confirm.1.2"));
}

#[test]
fn a_release_and_a_confirm_racing_for_the_same_remainder_exactly_one_posts() {
    let Some(b) = book() else { return };
    b.post("sh.b.deposit").unwrap();
    b.post("sh.b.place.2").unwrap();
    assert_eq!(b.bal("sh.b.available"), "75");
    let (release, confirm) = std::thread::scope(|s| {
        let r = s.spawn(|| b.post("sh.b.release.2.1"));
        let c = s.spawn(|| b.post("sh.b.confirm.2.1"));
        (r.join().unwrap(), c.join().unwrap())
    });
    assert_eq!(
        usize::from(release.is_ok()) + usize::from(confirm.is_ok()),
        1,
        "{release:?} {confirm:?}"
    );
    let released = release.is_ok();
    insufficient(if released { confirm } else { release });
    assert_eq!(b.bal("sh.b.held.2"), "0");
    assert_eq!(b.bal("sh.b.available"), if released { "100" } else { "75" });
    assert_eq!(b.bal("sh.b.confirmed"), if released { "0" } else { "25" });
}

#[test]
fn one_staff_hold_never_draws_on_another() {
    let Some(b) = book() else { return };
    b.post("sh.c.deposit").unwrap();
    b.post("sh.c.place.3").unwrap();
    b.post("sh.c.place.4").unwrap();
    insufficient(b.post("sh.c.release.3.1"));
    assert_eq!(b.bal("sh.c.held.3"), "10");
    assert_eq!(b.bal("sh.c.held.4"), "5");
    assert_eq!(b.bal("sh.c.available"), "85");
}

// ── ledger/tx-hash-bind.test.ts ──────────────────────────────────────────────────────────────────────────────────────

const THB_USER: &str = "99999999-9999-4999-8999-999999999999";

fn broken_at(c: Chain, id: &str) {
    assert!(!c.ok(), "the chain stayed green");
    assert_eq!(c.broken_at(), Some(id));
}

#[test]
fn a_rewritten_key_is_refused_and_the_original_key_does_not_post_again() {
    let Some(b) = book() else { return };
    let first = b.post("thb.bind-1").unwrap();
    assert!(b.chain().ok());
    assert_eq!(b.bal("thb.usdt"), "10");

    let mut c = b.sql();
    let (state, _) = refused(c.execute(
        "UPDATE ledger.ledger_tx SET idempotency_key = 'rewritten-key' WHERE id = $1::text::uuid",
        &[&first.id],
    ));
    assert_eq!(state, CHECK_VIOLATION);
    let (state, _) = refused(c.execute(
        r#"UPDATE ledger.ledger_tx SET meta = '{"rail":"swapped"}'::jsonb WHERE id = $1::text::uuid"#,
        &[&first.id],
    ));
    assert_eq!(state, CHECK_VIOLATION);

    assert_eq!(b.post("thb.bind-1").unwrap().id, first.id);
    assert_eq!(b.bal("thb.usdt"), "10");
    assert!(b.chain().ok());

    // A role that can disable the trigger can change the key. The stored hash covered the original key, so the chain
    // must not stay green.
    c.batch_execute(
        "ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_key_immutable;
         ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_immutable;",
    )
    .unwrap();
    c.execute(
        "UPDATE ledger.ledger_tx SET idempotency_key = 'rewritten-key' WHERE id = $1::text::uuid",
        &[&first.id],
    )
    .unwrap();
    broken_at(b.chain(), &first.id);

    // The column no longer holds the original key. The claim still does, so this post must not move the balance again.
    assert!(b.post_fails("thb.bind-1"));
    assert_eq!(b.bal("thb.usdt"), "10");
    assert_eq!(b.tx_count(), 1);
}

/// `legacyShortDigest`: the row's digest with the key left out, the hash a post before the bind stored.
fn legacy_short_digest(c: &mut Client, tx_id: &str) -> String {
    let tx = c
        .query_one(
            "SELECT module, reason, floor(extract(epoch FROM posted_at) * 1000)::bigint, previous_hash
               FROM ledger.ledger_tx WHERE id = $1::text::uuid",
            &[&tx_id],
        )
        .unwrap();
    let rows = c
        .query(
            "SELECT account_id::text, asset_id, direction::text, amount::text
               FROM ledger.ledger_entries WHERE tx_id = $1::text::uuid ORDER BY id ASC",
            &[&tx_id],
        )
        .unwrap();
    let cols: Vec<(String, String, String, Amount)> = rows
        .iter()
        .map(|r| {
            (
                r.get(0),
                r.get(1),
                r.get(2),
                parse_amount(r.get::<_, &str>(3)).unwrap(),
            )
        })
        .collect();
    let entries: Vec<HashEntry<'_>> = cols
        .iter()
        .map(|(a, s, d, amount)| HashEntry {
            account_id: a,
            asset_id: s,
            direction: d,
            amount: *amount,
        })
        .collect();
    let (module, reason, at, previous): (String, String, i64, Option<String>) =
        (tx.get(0), tx.get(1), tx.get(2), tx.get(3));
    chain::hash_tx(
        &HashTx {
            id: tx_id,
            module: &module,
            reason: &reason,
            posted_at_ms: at,
            entries: &entries,
        },
        previous.as_deref(),
    )
    .unwrap()
}

#[test]
fn a_legacy_short_digest_does_not_launder_a_rewritten_key() {
    let Some(b) = book() else { return };
    let first = b.post("thb.bind-short").unwrap();
    assert!(b.chain().ok());
    assert_eq!(b.bal("thb.usdt"), "10");

    let mut c = b.sql();
    let legacy = legacy_short_digest(&mut c, &first.id);
    c.batch_execute(
        "ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_key_immutable;
         ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_immutable;",
    )
    .unwrap();
    c.execute(
        "UPDATE ledger.ledger_tx SET idempotency_key = 'rewritten-short-key', hash = $2 WHERE id = $1::text::uuid",
        &[&first.id, &legacy],
    )
    .unwrap();
    broken_at(b.chain(), &first.id);
    assert!(b.post_fails("thb.bind-short"));
    assert_eq!(b.bal("thb.usdt"), "10");
    assert_eq!(b.tx_count(), 1);
}

/// A database migrated as one was before the bind (every file before `0018`).
fn historical_book() -> Option<Book> {
    let db = TestDb::new()?;
    let prior: Vec<(&str, &str)> = FILES
        .iter()
        .copied()
        .filter(|(name, _)| *name < "0018")
        .collect();
    db.migrate(&prior, false).unwrap();
    let store = db::open(&db.url, "svc-ledger", 2, false).unwrap();
    Some(Book { db, store })
}

/// `read0016()`: the claim-bind step (`0018`) with the request digest column (`0021`), run as the TypeScript runs them.
fn bind_step(b: &Book) {
    let up = |prefix: &str| {
        FILES
            .iter()
            .find(|(n, _)| n.starts_with(prefix) && !n.ends_with(".down.sql"))
            .map(|(_, body)| *body)
            .unwrap_or_else(|| panic!("{prefix} is not among the migrations"))
    };
    b.sql()
        .batch_execute(&format!("{}\n{}", up("0018_"), up("0021_")))
        .unwrap();
}

/// `insertHistoricalDeposit`: a 10 USDT deposit whose stored hash never covered the key, and its `0015` claim.
fn insert_historical_deposit(b: &Book, rail_ref: &str) -> (String, String, String) {
    let key = format!("deposit:test:{rail_ref}");
    let mut c = b.sql();
    let account = |c: &mut Client, owner_type: &str, owner: &str, balance: &str| -> String {
        c.query_one(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
             VALUES ($1::text::ledger.owner_type, $2, 'USDT', 'available', '', $3::text::numeric) RETURNING id::text",
            &[&owner_type, &owner, &balance],
        )
        .unwrap()
        .get(0)
    };
    let rail = account(&mut c, "treasury", "rail:test", "-10");
    let user = account(&mut c, "user", THB_USER, "10");
    let tx_id: String = c
        .query_one("SELECT gen_random_uuid()::text", &[])
        .unwrap()
        .get(0);
    let posted_at_ms = 1_775_131_200_000; // 2026-04-02T12:00:00.000Z
    let ten = parse_amount("10").unwrap();
    let entries = [
        HashEntry {
            account_id: &rail,
            asset_id: "USDT",
            direction: "credit",
            amount: ten,
        },
        HashEntry {
            account_id: &user,
            asset_id: "USDT",
            direction: "debit",
            amount: ten,
        },
    ];
    let legacy = chain::hash_tx(
        &HashTx {
            id: &tx_id,
            module: "ledger",
            reason: "deposit.credited",
            posted_at_ms,
            entries: &entries,
        },
        None,
    )
    .unwrap();
    let meta = format!(r#"{{"rail":"test","railRef":"{rail_ref}"}}"#);
    let seq: String = c
        .query_one(
            "INSERT INTO ledger.ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
             VALUES ($1::text::uuid, $2, 'ledger', 'deposit.credited', $3::text::jsonb, '2026-04-02T12:00:00.000Z', $4, NULL)
             RETURNING seq::text",
            &[&tx_id, &key, &meta, &legacy],
        )
        .unwrap()
        .get(0);
    for (account, direction, after) in [(&rail, "credit", "-10"), (&user, "debit", "10")] {
        c.execute(
            "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
             VALUES ($1::text::uuid, $2::text::uuid, 'USDT', $3::text::ledger.direction, 10, $4::text::numeric)",
            &[&tx_id, account, &direction, &after],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO ledger.ledger_posted_keys (idempotency_key, tx_id) VALUES ($1, $2::text::uuid)",
        &[&key, &tx_id],
    )
    .unwrap();
    c.execute(
        "UPDATE ledger.chain_tip SET hash = $1, seq = $2::text::bigint WHERE id = true",
        &[&legacy, &seq],
    )
    .unwrap();
    (tx_id, key, legacy)
}

#[test]
fn a_key_rewritten_on_a_row_posted_before_the_bind_does_not_launder_through_its_claim() {
    let Some(b) = historical_book() else { return };
    let (id, key, legacy) = insert_historical_deposit(&b, "bind-hist");
    bind_step(&b);
    assert!(b.chain().ok());
    let claim = b
        .sql()
        .query_one(
            "SELECT idempotency_key, posted_hash, posted_meta::text FROM ledger.ledger_posted_keys WHERE tx_id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    assert_eq!(claim.get::<_, String>(0), key);
    assert_eq!(claim.get::<_, String>(1), legacy);
    let meta = json::parse(&claim.get::<_, String>(2)).unwrap();
    assert_eq!(meta.get("rail"), Some(&Json::str("test")));
    assert_eq!(meta.get("railRef"), Some(&Json::str("bind-hist")));

    let mut c = b.sql();
    c.batch_execute("ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_key_immutable")
        .unwrap();
    c.execute(
        "UPDATE ledger.ledger_tx SET idempotency_key = 'rewritten-hist-key' WHERE id = $1::text::uuid",
        &[&id],
    )
    .unwrap();
    broken_at(b.chain(), &id);
    assert!(b.post_fails("thb.bind-hist"));
    assert_eq!(b.bal("thb.usdt"), "10");
    assert_eq!(b.tx_count(), 1);
}

#[test]
fn meta_rewritten_on_a_row_posted_before_the_bind_does_not_launder_through_its_claim() {
    let Some(b) = historical_book() else { return };
    let (id, _, legacy) = insert_historical_deposit(&b, "bind-meta");
    bind_step(&b);
    assert!(b.chain().ok());
    let mut c = b.sql();
    c.batch_execute("ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_key_immutable")
        .unwrap();
    c.execute(
        r#"UPDATE ledger.ledger_tx SET meta = '{"rail":"swapped"}'::jsonb, hash = $2 WHERE id = $1::text::uuid"#,
        &[&id, &legacy],
    )
    .unwrap();
    broken_at(b.chain(), &id);
    assert_eq!(
        code(&b.post("thb.bind-meta").unwrap_err()),
        "ledger.posted_claim_mismatch"
    );
    assert_eq!(b.bal("thb.usdt"), "10");
    assert_eq!(b.tx_count(), 1);
}

#[test]
fn changed_receipt_metadata_is_refused_not_answered_with_bytes_that_contradict_the_claim() {
    let Some(b) = book() else { return };
    let tx = b.post("thb.receipt-proof").unwrap();
    let mut c = b.sql();
    c.batch_execute(
        "ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_key_immutable;
         ALTER TABLE ledger.ledger_tx DISABLE TRIGGER ledger_tx_immutable;",
    )
    .unwrap();
    c.execute(
        r#"UPDATE ledger.ledger_tx SET meta = '{"forged":"metadata"}'::jsonb WHERE id = $1::text::uuid"#,
        &[&tx.id],
    )
    .unwrap();
    let mismatch = |r: Result<Option<balances::Tx>, Failure>| match r {
        Err(f) => assert_eq!(code(&f), "ledger.posted_claim_mismatch"),
        Ok(t) => panic!("answered: {t:?}"),
    };
    // `getTxByKey` and `getTx`, as the engine's reads answer them.
    mismatch(
        with_client(b.store.pool().unwrap(), |c| {
            Ok(balances::tx_by_key(c, &tx.idempotency_key))
        })
        .unwrap(),
    );
    mismatch(
        with_client(b.store.pool().unwrap(), |c| {
            Ok(balances::tx_by_id(c, &tx.id))
        })
        .unwrap(),
    );
    assert_eq!(
        code(&b.post("thb.receipt-proof").unwrap_err()),
        "ledger.posted_claim_mismatch"
    );
    assert_eq!(b.bal("thb.usdt"), "1");
}

#[test]
fn a_second_posted_key_for_the_same_journal_movement_is_refused() {
    let Some(b) = book() else { return };
    let tx = b.post("thb.claim-unique").unwrap();
    let (state, _) = refused(b.sql().execute(
        r#"INSERT INTO ledger.ledger_posted_keys (idempotency_key, tx_id, posted_hash, posted_meta)
           VALUES ('another-claim', $1::text::uuid, $2, '{"rail":"test","railRef":"claim-unique"}'::jsonb)"#,
        &[&tx.id, &tx.hash],
    ));
    assert_eq!(state, UNIQUE_VIOLATION);
}

#[test]
fn a_chain_tip_whose_hash_matches_but_whose_sequence_does_not_name_the_last_row_is_refused() {
    let Some(b) = book() else { return };
    // The book the earlier cases of the TypeScript's describe left: two posts.
    b.post("thb.receipt-proof").unwrap();
    b.post("thb.claim-unique").unwrap();
    assert!(b.chain().ok());
    b.sql()
        .batch_execute("UPDATE ledger.chain_tip SET seq = seq + 1 WHERE id = true")
        .unwrap();
    assert!(!b.chain().ok());
    b.sql()
        .batch_execute("UPDATE ledger.chain_tip SET seq = seq - 1 WHERE id = true")
        .unwrap();
    assert!(b.chain().ok());
}

#[test]
fn ledger_reads_keep_database_order_when_serializing_columns_as_text() {
    use service_kit::schema::Value;
    use svc_ledger::{desk, status};

    let Some(b) = book() else { return };
    let mut req = request("pl.neg.deposit");
    for n in 1..=4 {
        req.idempotency_key = format!("deposit:test:order-{n}");
        b.post_req(&req).unwrap();
    }
    req.idempotency_key = "deposit:test:order-5".to_owned();
    let booked = b.post_req(&req).unwrap();
    let replay = b.post_req(&req).unwrap();
    let account = &booked.entries[1].account_id;

    for revision in 0..10 {
        desk::set_account_metadata(
            &b.store,
            "founder-a",
            Value::from_json(&Json::obj([
                ("accountId", Json::str(account.clone())),
                ("key", Json::str("desk.label")),
                ("value", Json::str(format!("label {revision}"))),
                ("reason", Json::str("TEST ledger ordering")),
                ("revision", Json::int(revision)),
            ])),
        )
        .unwrap();
    }

    b.sql()
        .batch_execute(
            "INSERT INTO ledger.reconcile_runs (started_at, outcome, through_seq)
             VALUES (now(), 'ok', 9), (now(), 'ok', 10)",
        )
        .unwrap();
    b.sql()
        .execute(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, purpose)
             VALUES ('user', $1, 'USDT', 'hold', 'order:test'),
                    ('user', $1, 'USDT', 'escrow', 'escrow:test')",
            &[&PL_USER],
        )
        .unwrap();

    let (lookup_ids, kinds) = with_client(b.store.pool().unwrap(), |c| {
        let found = balances::tx_by_id(c, &booked.id).unwrap().unwrap();
        let ids = found.entries.into_iter().map(|e| e.id).collect::<Vec<_>>();
        let kinds = balances::balances(c, "user", PL_USER)
            .unwrap()
            .into_iter()
            .map(|h| h.kind)
            .collect::<Vec<_>>();
        Ok((ids.join(","), kinds.join(",")))
    })
    .unwrap();
    let replay_ids = replay.entries.into_iter().map(|e| e.id).collect::<Vec<_>>();
    let health = status::last_verified(&b.store).unwrap().unwrap().1;
    let verified = reconcile::read_last_verified(&b.store)
        .unwrap()
        .seq
        .unwrap();
    let metadata = desk::read_account_metadata(&b.store, account).unwrap();
    let Some(Json::Array(changes)) = metadata.get("changes") else {
        panic!("missing metadata change history");
    };

    assert_eq!(
        (
            replay_ids.join(",").as_str(),
            lookup_ids.as_str(),
            health.as_str(),
            verified.as_str(),
            changes[0].get("seq"),
            kinds.as_str(),
        ),
        (
            "9,10",
            "9,10",
            "10",
            "10",
            Some(&Json::str("10")),
            "available,hold,escrow",
        )
    );
}
