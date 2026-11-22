//! The `ops-reads` slice against a real Postgres, each test in its own throwaway database (`support`). Without a URL it
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript proofs it ports, case for case: `ledger/fee-revenue-postgres.test.ts`,
//! `ledger/own-funds-postgres.test.ts`, `ledger/restore-watermark-asof.pg.test.ts`, the evaluation feed case of
//! `ledger/reconciliation-controls.pg.test.ts`, and the database side of `transactions-exist-door.test.ts`.
//!
//! The Rust port cannot post yet (the `posting` slice), so each book is written straight into the tables: the posts are
//! the ones the TypeScript tests make, by the same recipes (`fixtures/ops-reads-books.json`, written by
//! `scripts/record-door.mjs`), each balanced, with its account balances moved and the chain tip advanced as a post does.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::sync::mpsc;
use std::time::Duration;

use postgres::Client;
use service_kit::json::{self, Json};
use service_kit::money::format_amount;
use service_kit::schema::{Outcome, Value};
use service_kit::time::Instant;
use support::TestDb;
use svc_ledger::door;
use svc_ledger::errors::{self, Failure};
use svc_ledger::migrate::FILES;
use svc_ledger::ops_reads::{
    self, BUILDER_FEE_COLLECT_REASON, FeeRevenueRow, OwnFunds, OwnFundsPlaceRow, OwnFundsRow,
    RECONCILIATION_EVALUATION_SETTLE_SECONDS, VENUE_BUILDER_ACCOUNT_PREFIX,
    VENUE_BUILDER_FEE_PREFIX,
};

const BOOKS: &str = include_str!("fixtures/ops-reads-books.json");
const PAYER: &str = "11111111-1111-4111-8111-111111111111";
/// A TEST clock skew bound: the cut-off must be more than this far past before it is answered.
const BOUND: i64 = 50;

fn migrated() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    Some(db)
}

/// A connection as the ledger's pool opens one: the `ledger` schema first.
fn client(db: &TestDb) -> Client {
    let mut c = db.client();
    c.batch_execute("SET search_path = ledger, public").unwrap();
    c
}

fn books() -> Json {
    json::parse(BOOKS).unwrap()
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

fn list<'a>(j: &'a Json, k: &str) -> &'a [Json] {
    match j.get(k) {
        Some(Json::Array(v)) => v,
        other => panic!("{k}: {other:?}"),
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

fn pause(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// What one booked post left: its id, its chain position and its `posted_at` as `toISOString()` gives it.
struct Booked {
    id: String,
    seq: i64,
    posted_at: Instant,
}

/// One post, written as `PostgresLedger.post` leaves it: its accounts (made on first use), its transaction stamped at
/// a whole millisecond of the clock (`posted_at` is the process's `Date`), its entries with each running balance (a
/// debit raises a balance, a credit lowers it), and the chain tip moved to it. `key` overrides the post's own key.
fn book(c: &mut Client, post: &Json, key: Option<&str>) -> Booked {
    let mut tx = c.transaction().unwrap();
    let key = key.map_or_else(|| s(post, "idempotencyKey"), str::to_owned);
    let row = tx
        .query_one(
            "WITH tip AS (SELECT hash FROM chain_tip WHERE id = true FOR UPDATE)
             INSERT INTO ledger_tx (idempotency_key, module, reason, posted_at, hash, previous_hash)
             SELECT $1, $2, $3, date_trunc('milliseconds', clock_timestamp()), md5($1), (SELECT hash FROM tip)
             RETURNING id::text, seq, (extract(epoch FROM posted_at) * 1000)::int8",
            &[&key, &s(post, "module"), &s(post, "reason")],
        )
        .unwrap();
    let (id, seq, at): (String, i64, i64) = (row.get(0), row.get(1), row.get(2));
    for e in list(post, "entries") {
        let account = (
            s(e, "ownerType"),
            s(e, "ownerId"),
            s(e, "assetId"),
            s(e, "kind"),
            s(e, "purpose"),
        );
        let found = tx
            .query(
                "SELECT id::text FROM accounts WHERE owner_type = $1::text::owner_type AND owner_id = $2 AND asset_id = $3
                   AND kind = $4::text::account_kind AND purpose = $5",
                &[&account.0, &account.1, &account.2, &account.3, &account.4],
            )
            .unwrap();
        let account_id: String = match found.first() {
            Some(r) => r.get(0),
            None => tx
                .query_one(
                    "INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
                     VALUES ($1::text::owner_type, $2, $3, $4::text::account_kind, $5) RETURNING id::text",
                    &[&account.0, &account.1, &account.2, &account.3, &account.4],
                )
                .unwrap()
                .get(0),
        };
        let sign = if s(e, "direction") == "debit" {
            "+"
        } else {
            "-"
        };
        tx.execute(
            &format!(
                "WITH moved AS (
                   UPDATE accounts SET balance = balance {sign} $2::text::numeric WHERE id = $1::text::uuid
                   RETURNING balance
                 )
                 INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
                 SELECT $3::text::uuid, $1::text::uuid, $4, $5::text::direction, $2::text::numeric, balance FROM moved"
            ),
            &[
                &account_id,
                &s(e, "amount"),
                &id,
                &account.2,
                &s(e, "direction"),
            ],
        )
        .unwrap();
    }
    tx.execute(
        "UPDATE chain_tip SET seq = $1, hash = md5($2), updated_at = clock_timestamp() WHERE id = true",
        &[&seq, &key],
    )
    .unwrap();
    tx.commit().unwrap();
    // Each post its own millisecond, as two posts of the TypeScript test are.
    pause(3);
    Booked {
        id,
        seq,
        posted_at: Instant(at),
    }
}

fn parsed(name: &str, input: &Json) -> Value {
    match door::parse(name, Value::from_json(input)).unwrap() {
        Outcome::Ok(v) => v,
        Outcome::Issues(i) => panic!("{name}: {i:?}"),
    }
}

/// The door past its input check, as the handler answers: the reply, or `httpError`'s status and body.
fn door_answer(db: &TestDb, door: &str, body: Option<&Json>, bound: Option<i64>) -> (u16, Json) {
    let input = match body {
        Some(b) if door != "restoreWatermark" && door != "ownFunds" => parsed(door, b),
        _ => Value::Undefined,
    };
    match ops_reads::answer(door, &db.store(), &input, body, bound, now_ms) {
        Ok(j) => (200, j),
        Err(e) => errors::http_error(&e),
    }
}

/// A fee row as the TypeScript test lists it: venue, asset, earned, returned, collected.
type FeeLine = (Option<String>, String, String, String, Option<String>);

fn amounts(rows: &[FeeRevenueRow]) -> Vec<FeeLine> {
    rows.iter()
        .map(|r| {
            (
                r.venue_id.clone(),
                r.asset_id.clone(),
                format_amount(r.earned),
                format_amount(r.returned),
                r.collected.map(format_amount),
            )
        })
        .collect()
}

fn o(v: &str) -> Option<String> {
    Some(v.to_owned())
}

// ── fee-revenue-postgres.test.ts ──────────────────────────────────────────────────────────────────────────────────

/// The fee book of `PostgresLedger.feeRevenue`'s `beforeAll`: the first and the last fee's `posted_at`.
fn fee_book(db: &TestDb) -> (Instant, Instant) {
    let mut c = client(db);
    let posts = books();
    let posts = list(&posts, "feeRevenue");
    let mut first = None;
    let mut last = Instant(0);
    for p in posts {
        let b = book(&mut c, p, None);
        if s(p, "idempotencyKey") == "fee-rev-1" {
            first = Some(b.posted_at);
        }
        last = b.posted_at;
    }
    (first.unwrap(), last)
}

fn fee_revenue(db: &TestDb, from: Instant, to: Instant) -> Vec<FeeRevenueRow> {
    ops_reads::fee_revenue(&mut client(db), from, to).unwrap()
}

fn wide(first: Instant, last: Instant) -> (Instant, Instant) {
    (Instant(first.0 - 60_000), Instant(last.0 + 60_000))
}

#[test]
fn fee_revenue_sums_earned_and_returned_per_venue_and_asset_18dp_intact_and_collected_apart() {
    let Some(db) = migrated() else { return };
    let (first, last) = fee_book(&db);
    let (from, to) = wide(first, last);
    assert_eq!(
        amounts(&fee_revenue(&db, from, to)),
        vec![
            (
                None,
                o("BTC").unwrap(),
                o("0.001").unwrap(),
                o("0").unwrap(),
                None
            ),
            (
                o("other-venue"),
                o("USDC").unwrap(),
                o("7").unwrap(),
                o("0").unwrap(),
                o("0")
            ),
            (
                o("test-venue"),
                o("USDC").unwrap(),
                o("5").unwrap(),
                o("0").unwrap(),
                o("1.5")
            ),
            (
                None,
                o("USDT").unwrap(),
                o("13.123456789012345678").unwrap(),
                o("0.5").unwrap(),
                None
            ),
        ]
    );
}

#[test]
fn fee_revenue_counts_as_collected_only_what_collect_posted() {
    let Some(db) = migrated() else { return };
    let (first, last) = fee_book(&db);
    let (from, to) = wide(first, last);
    let rows = fee_revenue(&db, from, to);
    let venue = |v: &str| {
        rows.iter()
            .find(|r| r.venue_id.as_deref() == Some(v))
            .unwrap()
    };
    // Before this read split them, the one figure labelled "collected" was the earned 5.
    assert_eq!(format_amount(venue("test-venue").earned), "5");
    assert_eq!(format_amount(venue("test-venue").collected.unwrap()), "1.5");
    // A venue that paid nothing yet reads 0, not the earned figure; a fee of our own has no collected figure at all.
    assert_eq!(format_amount(venue("other-venue").collected.unwrap()), "0");
    assert!(
        rows.iter()
            .filter(|r| r.venue_id.is_none())
            .all(|r| r.collected.is_none())
    );
}

#[test]
fn fee_revenue_reads_the_collect_and_earn_entries_by_the_names_the_recipes_post_under() {
    let posts = books();
    let posts = list(&posts, "feeRevenue");
    let collect = posts
        .iter()
        .find(|p| s(p, "idempotencyKey").starts_with("builder-fee-payout:"))
        .unwrap();
    assert_eq!(s(collect, "reason"), BUILDER_FEE_COLLECT_REASON);
    let credit = list(collect, "entries")
        .iter()
        .find(|e| s(e, "direction") == "credit")
        .unwrap();
    assert_eq!(
        s(credit, "ownerId"),
        format!("{VENUE_BUILDER_ACCOUNT_PREFIX}test-venue")
    );
    let earned = posts
        .iter()
        .find(|p| s(p, "idempotencyKey") == "builder-fee:test-venue:acct-1:f1")
        .unwrap();
    let owed = list(earned, "entries")
        .iter()
        .find(|e| s(e, "direction") == "credit")
        .unwrap();
    assert_eq!(
        s(owed, "ownerId"),
        format!("{VENUE_BUILDER_FEE_PREFIX}test-venue")
    );
    assert_eq!(s(earned, "module"), ops_reads::BUILDER_FEE_MODULE);
    assert_eq!(s(collect, "module"), ops_reads::BUILDER_FEE_MODULE);
}

#[test]
fn fee_revenue_leaves_out_the_insurance_fund_and_every_user_account() {
    let Some(db) = migrated() else { return };
    let (first, last) = fee_book(&db);
    let (from, to) = wide(first, last);
    let rows = fee_revenue(&db, from, to);
    let usdt = rows.iter().find(|r| r.asset_id == "USDT").unwrap();
    assert!(!format_amount(usdt.earned).contains("77"));
    assert_eq!(
        format_amount(usdt.earned + usdt.returned),
        "13.623456789012345678"
    );
}

#[test]
fn fee_revenue_uses_a_half_open_window_from_inclusive_to_exclusive() {
    let Some(db) = migrated() else { return };
    let (first, _) = fee_book(&db);
    let at_first = fee_revenue(&db, first, Instant(first.0 + 1));
    assert_eq!(
        at_first
            .iter()
            .map(|r| (r.asset_id.clone(), format_amount(r.earned)))
            .collect::<Vec<_>>(),
        vec![("USDT".to_owned(), "10.123456789012345678".to_owned())]
    );
    assert!(fee_revenue(&db, Instant(first.0 - 60_000), first).is_empty());
}

#[test]
fn fee_revenue_omits_an_asset_with_no_fee_movement_instead_of_a_zero_row() {
    let Some(db) = migrated() else { return };
    let (_, last) = fee_book(&db);
    assert!(fee_revenue(&db, Instant(last.0 + 60_000), Instant(last.0 + 120_000)).is_empty());
}

#[test]
fn fee_revenue_door_answers_the_window_and_refuses_an_empty_or_inverted_one() {
    let Some(db) = migrated() else { return };
    let (first, last) = fee_book(&db);
    let (from, to) = wide(first, last);
    let window = |f: &str, t: &str| Json::obj([("from", Json::str(f)), ("to", Json::str(t))]);
    let (status, reply) = door_answer(
        &db,
        "feeRevenue",
        Some(&window(&from.iso(), &to.iso())),
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(s(&reply, "from"), from.iso());
    assert_eq!(s(&reply, "to"), to.iso());
    let usdt = list(&reply, "assets")
        .iter()
        .find(|a| s(a, "assetId") == "USDT")
        .unwrap()
        .clone();
    assert_eq!(
        usdt.compact(),
        r#"{"venueId":null,"assetId":"USDT","earned":"13.123456789012345678","returned":"0.5","net":"12.623456789012345678","collected":null}"#
    );
    // An offset is read as the instant it names, and answered as UTC.
    let (status, reply) = door_answer(
        &db,
        "feeRevenue",
        Some(&window(
            "2026-01-01T08:00:00+08:00",
            "2026-01-02T00:00:00.123456Z",
        )),
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(s(&reply, "from"), "2026-01-01T00:00:00.000Z");
    assert_eq!(s(&reply, "to"), "2026-01-02T00:00:00.123Z");
    for (f, t) in [
        ("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"),
        ("2026-01-01T00:00:00Z", "2026-01-01T08:00:00+08:00"),
    ] {
        let (status, body) = door_answer(&db, "feeRevenue", Some(&window(f, t)), None);
        assert_eq!(status, 400);
        assert_eq!(s(&body, "code"), "ledger.fee_revenue_window_invalid");
    }
}

// ── own-funds-postgres.test.ts ────────────────────────────────────────────────────────────────────────────────────

fn own_funds_book(db: &TestDb) -> OwnFunds {
    let mut c = client(db);
    let posts = books();
    for p in list(&posts, "ownFunds") {
        book(&mut c, p, None);
    }
    ops_reads::own_funds(&mut c).unwrap()
}

#[test]
fn own_funds_answers_every_house_and_module_account_with_a_balance_and_nothing_a_customer_holds() {
    let Some(db) = migrated() else { return };
    let read = own_funds_book(&db);
    assert!(service_kit::time::zod_datetime(&read.as_of, true).is_some());
    assert_eq!(
        read.rows
            .iter()
            .map(|r| format!(
                "{} {} {} {} {}",
                r.asset_id,
                r.owner_type,
                r.owner_id,
                r.kind,
                format_amount(r.balance)
            ))
            .collect::<Vec<_>>(),
        vec![
            "BTC house market-maker available 0.25",
            // The builder fee the venue charged for us (earned): house revenue, as before.
            "USDC house fees:builder available 4",
            "USDT house fees:trade available 12.500000000000000001",
            "USDT house insurance-fund available 77",
            "USDT module bank:loan-reserve available 300",
        ]
    );
}

#[test]
fn own_funds_leaves_out_the_user_the_merchant_pot_the_burn_account_and_every_treasury_boundary() {
    let Some(db) = migrated() else { return };
    let read = own_funds_book(&db);
    let owners: Vec<&str> = read.rows.iter().map(|r| r.owner_id.as_str()).collect();
    assert!(!owners.contains(&PAYER));
    assert!(!owners.iter().any(|o| o.starts_with("pay:clearing:")));
    assert!(!owners.contains(&"burn"));
    assert!(!owners.contains(&"futures-loss"));
    assert!(
        !owners
            .iter()
            .any(|o| o.starts_with("ops:hold-confirm:") || o.starts_with("campaigns:lock:"))
    );
    assert!(
        read.rows
            .iter()
            .all(|r| r.owner_type == "house" || r.owner_type == "module")
    );
}

#[test]
fn own_funds_answers_each_place_in_the_same_read_with_what_the_book_shows_of_ours_there() {
    let Some(db) = migrated() else { return };
    let read = own_funds_book(&db);
    assert_eq!(
        read.places
            .iter()
            .map(|p| format!(
                "{} {} {}",
                p.owner_id,
                p.asset_id,
                format_amount(-p.balance)
            ))
            .collect::<Vec<_>>(),
        vec![
            "partner-reserve:bank USDC 1.5",
            "venue-builder-account:test-venue USDC 2.5",
        ]
    );
    // The receivable the venue still owes and the rail boundaries are not places of ours.
    assert!(
        !read.places.iter().any(
            |p| p.owner_id.starts_with("venue-builder-fee:") || p.owner_id.starts_with("rail:")
        )
    );
    assert_eq!(
        read.rows
            .iter()
            .find(|r| r.owner_id == "fees:builder")
            .map(|r| r.asset_id.as_str()),
        Some("USDC")
    );
    // The door answers both lists, each place by its kind and id.
    let (status, reply) = door_answer(&db, "ownFunds", None, None);
    assert_eq!(status, 200);
    assert_eq!(
        Json::Array(list(&reply, "places").to_vec()).compact(),
        r#"[{"kind":"partner_reserve","placeId":"bank","assetId":"USDC","held":"1.5"},{"kind":"venue_builder_account","placeId":"test-venue","assetId":"USDC","held":"2.5"}]"#
    );
    assert_eq!(list(&reply, "accounts").len(), 5);
}

#[test]
fn own_funds_refuses_rather_than_count_a_customer_row_or_a_place_that_is_not_one() {
    let row = |owner_type: &str, owner_id: &str| OwnFundsRow {
        owner_type: owner_type.to_owned(),
        owner_id: owner_id.to_owned(),
        asset_id: "USDT".to_owned(),
        kind: "available".to_owned(),
        purpose: String::new(),
        balance: 1,
    };
    let read = |rows: Vec<OwnFundsRow>, places: Vec<OwnFundsPlaceRow>| OwnFunds {
        as_of: "2026-01-01T00:00:00.000Z".to_owned(),
        rows,
        places,
    };
    for r in [
        row("user", PAYER),
        row("module", "pay:proceeds:m"),
        row("house", "burn"),
        row("module", "campaigns:lock:x"),
    ] {
        assert_eq!(
            ops_reads::own_funds_reply(&read(vec![r], vec![])),
            Err(Failure::Fault)
        );
    }
    let place = |owner_id: &str, balance| OwnFundsPlaceRow {
        owner_id: owner_id.to_owned(),
        asset_id: "USDC".to_owned(),
        balance,
    };
    for p in [
        place("rail:x", -1),
        place("treasury-wallet:w", 1),
        place("partner-reserve:", -1),
    ] {
        assert_eq!(
            ops_reads::own_funds_reply(&read(vec![], vec![p])),
            Err(Failure::Fault)
        );
    }
    // A place at zero is answered; an account at zero is not.
    let ok = ops_reads::own_funds_reply(&read(
        vec![OwnFundsRow {
            balance: 0,
            ..row("house", "fees:trade")
        }],
        vec![place("treasury-wallet:w", 0)],
    ))
    .unwrap();
    assert_eq!(
        ok.compact(),
        r#"{"asOf":"2026-01-01T00:00:00.000Z","accounts":[],"places":[{"kind":"treasury_wallet","placeId":"w","assetId":"USDC","held":"0"}]}"#
    );
}

// ── restore-watermark-asof.pg.test.ts ─────────────────────────────────────────────────────────────────────────────

fn deposit(c: &mut Client, n: u32) -> Booked {
    let posts = books();
    book(
        c,
        posts.get("deposit").unwrap(),
        Some(&format!("deposit:crypto-native:tx-wm-{n}")),
    )
}

#[test]
fn restore_answers_the_genesis_tip_before_any_post_and_the_newest_seq_at_or_before_the_cut_off_after()
 {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let mut c = client(&db);
    let before = Instant(now_ms());
    pause(70);
    let genesis = ops_reads::restore_watermark_as_of(&store, before, Some(BOUND)).unwrap();
    assert_eq!((genesis.position.as_str(), genesis.integrity), ("0", None));

    deposit(&mut c, 1);
    deposit(&mut c, 2);
    pause(70);
    let cut_off = Instant(now_ms());
    pause(70);
    let at_cut = ops_reads::restore_watermark_as_of(&store, cut_off, Some(BOUND)).unwrap();
    let live_at_cut = ops_reads::restore_watermark(&mut c).unwrap();
    assert_eq!(at_cut.position, live_at_cut.position);
    // The hash is the chain's at that position, which is the tip's while nothing has been posted since.
    assert_eq!(at_cut.integrity, live_at_cut.integrity);
    let hash: String = c
        .query_one(
            "SELECT hash FROM ledger_tx WHERE seq = $1::text::int8",
            &[&at_cut.position],
        )
        .unwrap()
        .get(0);
    assert_eq!(at_cut.integrity.as_deref(), Some(hash.as_str()));

    // Posts after the cut-off move the live tip, never the position as of the cut-off.
    deposit(&mut c, 3);
    let newest = deposit(&mut c, 4);
    let live = ops_reads::restore_watermark(&mut c).unwrap();
    assert_eq!(live.position, newest.seq.to_string());
    assert!(live.position.parse::<i64>().unwrap() > at_cut.position.parse::<i64>().unwrap());
    let again = ops_reads::restore_watermark_as_of(&store, cut_off, Some(BOUND)).unwrap();
    assert_eq!(again.position, at_cut.position);
    assert_eq!(again.integrity, at_cut.integrity);
    assert_ne!(live.integrity, at_cut.integrity);
    assert_eq!(again.last_write_at, live.last_write_at);
    assert_eq!(live.last_write_at, Some(newest.posted_at.iso()));
}

#[test]
fn restore_refuses_a_cut_off_not_yet_past_the_bound_and_any_cut_off_while_the_bound_is_blank() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let code = |r: Result<ops_reads::Watermark, Failure>| match r {
        Err(Failure::Ledger { code, .. }) => code,
        other => panic!("{other:?}"),
    };
    let future = Instant(now_ms() + 60_000);
    assert_eq!(
        code(ops_reads::restore_watermark_as_of(
            &store,
            future,
            Some(BOUND)
        )),
        "ledger.restore_asof_unanswerable"
    );
    assert_eq!(
        code(ops_reads::restore_watermark_as_of(
            &store,
            Instant(now_ms()),
            Some(BOUND)
        )),
        "ledger.restore_asof_unanswerable"
    );
    assert_eq!(
        code(ops_reads::restore_watermark_as_of(
            &store,
            Instant(now_ms() - 60_000),
            None
        )),
        "ledger.skew_bound_unset"
    );
    // Each is the caller's to wait out or the owner's to set: 409, by its own message.
    let (status, body) = door_answer(
        &db,
        "restoreWatermark",
        Some(&Json::obj([("asOf", Json::str(future.iso()))])),
        Some(BOUND),
    );
    assert_eq!(
        (status, s(&body, "code").as_str()),
        (409, "ledger.restore_asof_unanswerable")
    );
    let (status, body) = door_answer(
        &db,
        "restoreWatermark",
        Some(&Json::obj([("asOf", Json::str("2026-01-01T00:00:00Z"))])),
        None,
    );
    assert_eq!(
        (status, s(&body, "code").as_str()),
        (409, "ledger.skew_bound_unset")
    );
}

#[test]
fn restore_waits_out_a_post_holding_the_chain_tip_so_a_post_in_flight_is_counted() {
    let Some(db) = migrated() else { return };
    let cut_off = Instant(now_ms() - 1000);
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let url = db.url.clone();
    let holder = std::thread::spawn(move || {
        let mut c = Client::connect(&url, postgres::NoTls).unwrap();
        c.batch_execute("SET search_path = ledger, public").unwrap();
        let mut tx = c.transaction().unwrap();
        tx.query("SELECT seq FROM chain_tip WHERE id = true FOR UPDATE", &[])
            .unwrap();
        locked_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        tx.commit().unwrap();
    });
    locked_rx.recv().unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let store = db.store();
    let reader = std::thread::spawn(move || {
        let r = ops_reads::restore_watermark_as_of(&store, cut_off, Some(BOUND));
        done_tx.send(()).unwrap();
        r
    });
    assert!(
        done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "the read waits while a post holds the tip"
    );
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    let at = reader.join().unwrap().unwrap();
    assert!(at.position.bytes().all(|b| b.is_ascii_digit()) && !at.position.is_empty());
}

#[test]
fn restore_answers_live_for_an_empty_body_as_of_the_instant_for_as_of_echoed_and_refuses_a_bad_one()
{
    let Some(db) = migrated() else { return };
    deposit(&mut client(&db), 1);
    let ask = |body: Option<&Json>| door_answer(&db, "restoreWatermark", body, Some(BOUND));
    for body in [None, Some(Json::Null), Some(Json::Object(Vec::new()))] {
        let (status, live) = ask(body.as_ref());
        assert_eq!(status, 200);
        assert_eq!(s(&live, "service"), "ledger");
        assert_eq!(s(&live, "kind"), "chain_tip.seq");
        assert_eq!(s(&live, "position"), "1");
        assert!(live.get("asOf").is_none());
        assert!(service_kit::time::zod_datetime(&s(&live, "readAt"), true).is_some());
    }
    let cut_off = Instant(now_ms() - 1000).iso();
    let (status, at) = ask(Some(&Json::obj([("asOf", Json::str(cut_off.clone()))])));
    assert_eq!(status, 200);
    assert_eq!(s(&at, "asOf"), cut_off);
    // The one post landed after the cut-off: as of it, the book stood at the genesis tip.
    assert_eq!(s(&at, "position"), "0");
    assert_eq!(at.get("integrity"), Some(&Json::Null));
    let Json::Object(fields) = &at else { panic!() };
    assert_eq!(
        fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        [
            "service",
            "kind",
            "position",
            "integrity",
            "lastWriteAt",
            "readAt",
            "asOf"
        ]
    );
    for bad in [
        Json::obj([("asOf", Json::str("yesterday"))]),
        Json::obj([
            ("asOf", Json::str(cut_off.clone())),
            ("live", Json::Bool(true)),
        ]),
        Json::str(cut_off.clone()),
        Json::Array(Vec::new()),
        Json::int(7),
    ] {
        let (status, body) = ask(Some(&bad));
        assert_eq!(status, 400, "{}", bad.compact());
        assert_eq!(s(&body, "code"), "ledger.restore_asof_invalid");
        assert_eq!(
            s(&body, "message"),
            "restore watermark: send {} or { asOf } with one instant and its offset"
        );
    }
}

#[test]
fn restore_on_a_book_without_its_tip_is_the_ledgers_own_500() {
    let Some(db) = migrated() else { return };
    client(&db).batch_execute("DELETE FROM chain_tip").unwrap();
    let (status, body) = door_answer(&db, "restoreWatermark", None, Some(BOUND));
    assert_eq!(status, 500);
    assert_eq!(s(&body, "code"), "ledger.uninitialised");
}

// ── reconciliation-controls.pg.test.ts: the evaluation feed ───────────────────────────────────────────────────────

const SOURCES: &str = r#"{"ledger":{"asOf":"2026-01-01T00:00:00.000Z"},"outside":{"asOf":"unset"},"parity":{"asOf":"unset"}}"#;

/// A control as `defineReconciliationControl` stores an active `outside_balance` one with severity critical.
fn control(c: &mut Client) -> String {
    c.query_one(
        "INSERT INTO reconciliation_controls (template, state, severity, account_set, schedule, tolerance, defined_by, defined_reason)
         VALUES ('outside_balance', 'active', 'critical',
                 '{\"mode\":\"query\",\"assetId\":\"USDT\",\"ownerIdPrefix\":\"abcdefab-8888-4888-8888-\"}'::jsonb,
                 '{\"cadence\":\"daily\",\"hour\":0,\"minute\":0}'::jsonb, '{\"default\":\"0\"}'::jsonb,
                 'operator-1', 'the feed test')
         RETURNING id::text",
        &[],
    )
    .unwrap()
    .get(0)
}

/// A finished UNSET run as `runReconciliationControl` stores one whose outside source is unset.
fn run(c: &mut Client, control_id: &str, n: u32) -> String {
    c.query_one(
        "INSERT INTO reconciliation_control_runs (control_id, operation_id, fingerprint, status, phase, error_code, as_of, read_at,
                                                  margin, sources, evidence, outside_side, period_start, period_end,
                                                  actor_id, reason, finished_at)
         VALUES ($1::text::uuid, $2, $2, 'UNSET', 'outside', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'unset',
                 $3::text::jsonb, '{\"accounts\":[],\"assets\":[{\"assetId\":\"USDT\",\"observed\":\"0\",\"expected\":\"unset\",\"difference\":\"unset\",\"tolerance\":\"0\"}],\"compared\":0}'::jsonb,
                 'unset', '2025-12-31T00:00:00Z', '2026-01-01T00:00:00Z', 'operator-1', 'the feed test',
                 clock_timestamp() - interval '1 day')
         RETURNING id::text",
        &[&control_id, &format!("op-feed-{n}"), &SOURCES],
    )
    .unwrap()
    .get(0)
}

fn feed(db: &TestDb, input: &Json) -> Result<Json, Failure> {
    ops_reads::reconciliation_evaluations(
        &mut client(db),
        &parsed("reconciliationEvaluations", input),
    )
}

fn ask(after: Json, limit: i64) -> Json {
    Json::obj([("after", after), ("limit", Json::int(limit))])
}

fn ids(page: &Json) -> Vec<String> {
    list(page, "evaluations")
        .iter()
        .map(|e| s(e.get("run").unwrap(), "id"))
        .collect()
}

#[test]
fn evaluations_feed_settled_runs_oldest_first_a_cursor_never_hands_a_row_back_started_and_unsettled_runs_wait()
 {
    let Some(db) = migrated() else { return };
    let mut c = client(&db);
    let defined = control(&mut c);
    let runs: Vec<String> = (0..5).map(|n| run(&mut c, &defined, n)).collect();
    let (first, second, started, open, fresh) = (&runs[0], &runs[1], &runs[2], &runs[3], &runs[4]);
    // A microsecond apart, older than every other run in this database: the cursor must keep the microseconds.
    let set = |sql: &str, id: &str| {
        client(&db)
            .execute(
                &format!("UPDATE reconciliation_control_runs SET {sql} WHERE id = $1::text::uuid"),
                &[&id],
            )
            .unwrap();
    };
    set("finished_at = '2020-01-01T00:00:00.000001Z'", first);
    set("finished_at = '2020-01-01T00:00:00.000002Z'", second);
    set(
        "status = 'started', finished_at = '2020-01-01T00:00:00.000003Z'",
        started,
    );
    set("finished_at = NULL", open);
    // Inside the settle window however slow the runner: stamped an hour ahead.
    set("finished_at = clock_timestamp() + interval '1 hour'", fresh);

    let page1 = feed(&db, &ask(Json::Null, 1)).unwrap();
    assert_eq!(ids(&page1), std::slice::from_ref(first));
    let e = &list(&page1, "evaluations")[0];
    let r = e.get("run").unwrap();
    assert_eq!(s(r, "controlId"), defined);
    assert_eq!(s(r, "status"), "UNSET");
    assert_eq!(s(e, "finishedAt"), "2020-01-01T00:00:00.000001Z");
    assert_eq!(
        e.get("severity").unwrap().compact(),
        r#"{"status":"set","value":"critical"}"#
    );
    assert!(r.get("accounts").is_none());
    // The run in the contract's order, its stored evidence in the contract's order too.
    assert_eq!(
        r.compact(),
        format!(
            r#"{{"id":"{first}","controlId":"{defined}","status":"UNSET","compared":0,"phase":{{"status":"set","value":"outside"}},"errorCode":{{"status":"unset"}},"asOf":"2026-01-01T00:00:00.000Z","readAt":"2026-01-01T00:00:00.000Z","margin":{{"status":"unset"}},"sources":{SOURCES},"outsideSide":"unset","periodStart":"2025-12-31T00:00:00.000Z","periodEnd":"2026-01-01T00:00:00.000Z","assets":[{{"assetId":"USDT","observed":"0","expected":"unset","difference":"unset","tolerance":"0"}}]}}"#
        )
    );
    assert_eq!(
        page1.get("next").unwrap().compact(),
        format!(r#"{{"finishedAt":"2020-01-01T00:00:00.000001Z","id":"{first}"}}"#)
    );

    let page2 = feed(&db, &ask(page1.get("next").unwrap().clone(), 1)).unwrap();
    assert_eq!(ids(&page2), std::slice::from_ref(second));
    assert_eq!(
        page2.get("next").unwrap().compact(),
        format!(r#"{{"finishedAt":"2020-01-01T00:00:00.000002Z","id":"{second}"}}"#)
    );

    // Everything after the second: the started row, the unfinished row and the run finished just now are not there.
    let rest = feed(&db, &ask(page2.get("next").unwrap().clone(), 500)).unwrap();
    let rest_ids = ids(&rest);
    for id in [first, second, started, open, fresh] {
        assert!(!rest_ids.contains(id));
    }
    let order: Vec<String> = list(&rest, "evaluations")
        .iter()
        .map(|e| format!("{}|{}", s(e, "finishedAt"), s(e.get("run").unwrap(), "id")))
        .collect();
    let mut sorted = order.clone();
    sorted.sort();
    assert_eq!(order, sorted);

    // Past the settle window, the fresh run is fed exactly once; an empty page keeps the cursor where it was.
    set(
        &format!(
            "finished_at = clock_timestamp() - make_interval(secs => {})",
            RECONCILIATION_EVALUATION_SETTLE_SECONDS + 1
        ),
        fresh,
    );
    let settled = feed(&db, &ask(page2.get("next").unwrap().clone(), 500)).unwrap();
    assert_eq!(ids(&settled).iter().filter(|id| *id == fresh).count(), 1);
    let drained = feed(&db, &ask(settled.get("next").unwrap().clone(), 500)).unwrap();
    assert!(!ids(&drained).contains(fresh));
    let far = Json::obj([
        ("finishedAt", Json::str("2999-01-01T00:00:00.000000Z")),
        ("id", Json::str(first.clone())),
    ]);
    let empty = feed(&db, &ask(far.clone(), 5)).unwrap();
    assert_eq!(
        empty.compact(),
        Json::obj([("evaluations", Json::Array(Vec::new())), ("next", far)]).compact()
    );

    // The input check is the door's, a 400 before the database (the replay holds its messages).
    for bad in [
        ask(Json::Null, 501),
        ask(
            Json::obj([
                ("finishedAt", Json::str("yesterday")),
                ("id", Json::str(first.clone())),
            ]),
            5,
        ),
        Json::obj([("limit", Json::int(5)), ("extra", Json::int(1))]),
    ] {
        assert!(matches!(
            door::parse("reconciliationEvaluations", Value::from_json(&bad)),
            Ok(Outcome::Issues(_))
        ));
    }

    // A stored run the contract cannot read is the ledger's fault: a 500, never a 400.
    set("sources = '{}'::jsonb", first);
    let broken = feed(&db, &ask(Json::Null, 1));
    assert_eq!(broken, Err(Failure::Fault));
    assert_eq!(
        errors::http_error(&broken.unwrap_err()),
        (
            500,
            Json::obj([("message", Json::str("Ledger request failed"))])
        )
    );
    client(&db)
        .execute(
            "UPDATE reconciliation_control_runs SET sources = $2::text::jsonb WHERE id = $1::text::uuid",
            &[first, &SOURCES],
        )
        .unwrap();
    assert_eq!(
        ids(&feed(&db, &ask(Json::Null, 1)).unwrap()),
        std::slice::from_ref(first)
    );
}

// ── transactions-exist ────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn transactions_exist_answers_the_booked_ids_asked_lower_cased_in_the_order_asked_each_once() {
    let Some(db) = migrated() else { return };
    let mut c = client(&db);
    let a = deposit(&mut c, 1).id;
    let b = deposit(&mut c, 2).id;
    let missing = "99999999-9999-4999-8999-999999999999";
    let input = Json::obj([(
        "txIds",
        Json::Array(vec![
            Json::str(b.to_uppercase()),
            Json::str(missing),
            Json::str(a.clone()),
            Json::str(b.clone()),
        ]),
    )]);
    let (status, reply) = door_answer(&db, "transactionsExist", Some(&input), None);
    assert_eq!(status, 200);
    assert_eq!(reply.compact(), format!(r#"{{"found":["{b}","{a}"]}}"#));
}
