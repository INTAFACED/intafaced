//! The `desk` slice against a real Postgres, each test in its own throwaway database (`support`). Without a URL it
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript proofs it ports, case for case: `ledger/operator-desk.pg.test.ts` (the list's filters, cursor and
//! total; the booking record; the address search's volumes; the counts; the access log's desk actions) and
//! `ledger/operator-account-metadata.pg.test.ts` (set and overwrite; a retried set; a delete that spends a second
//! founder's approval once; a stale revision; the freeze; the race after the spend; the refusals; the append-only
//! record). Then the door cases of `operator-lookup-http.test.ts`, `operator-desk-http.test.ts` and
//! `operator-account-metadata-http.test.ts` that need a real book: the access row written first under the operator and
//! the request, a row that cannot be written refusing with nothing read, and each metadata refusal's status.
//!
//! The book is seeded the way `recipes.deposit` posts (a credit to the rail boundary, a debit to the user's available
//! account), in SQL: the `posting` slice is not ported yet. TEST amounts only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::approvals::{ConsumeInput, Consumed};
use service_kit::json::{self, Json};
use service_kit::money::{format_amount, parse_amount};
use service_kit::s2s::system_seconds;
use service_kit::s2s_verify::BodyBind;
use service_kit::schema::Value;
use service_kit::server::{Door, Request};
use service_kit::telemetry::Logger;
use service_kit::time::Instant;
use service_kit::tokens::TokenConfig;
use sha2::Sha256;
use support::TestDb;
use svc_ledger::approval::{Approvals, Refused, Unwired};
use svc_ledger::clock::system_ms;
use svc_ledger::db::{Store, with_client};
use svc_ledger::desk::{
    self, ACCOUNT_METADATA_APPROVAL_SPENT, ACCOUNT_METADATA_DELETE_TARGET,
    ACCOUNT_METADATA_INVALID, ACCOUNT_METADATA_KEY_ABSENT, ACCOUNT_METADATA_STALE,
    ACCOUNT_NOT_FOUND, Actor, DESK_PAGE_SIZE, DeleteError, FROZEN,
};
use svc_ledger::door::{DoorConfig, LedgerDoor};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::migrate::FILES;

const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATOR: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOUNDER_A: &str = "requester";
const FOUNDER_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REASON: &str = "LOCAL TEST label for the desk";
const UNKNOWN: &str = "99999999-9999-4999-8999-999999999999";
const USDT_DEPOSITS: usize = DESK_PAGE_SIZE + 2;
const TOKEN_SECRET: &str = "placeholder-ledger-desk-test-token-secret";

fn migrated() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    Some(db)
}

/// A TEST amount times a count, as a decimal string; never a float.
fn times(amount: &str, n: usize, sign: i128) -> String {
    format_amount(sign * parse_amount(amount).unwrap() * i128::try_from(n).unwrap())
}

/// `recipes.deposit` booked as `PostgresLedger.post` books it: the rail boundary credited, the user's available
/// account debited, each balance moved and named after the entry, the claim, and the `tx.posted` outbox row whose
/// reference is the transaction id (the request carried no correlation id). Returns the transaction id.
fn deposit(
    db: &TestDb,
    user: &str,
    asset: &str,
    amount: &str,
    rail: &str,
    rail_ref: &str,
) -> String {
    let mut client = db.client();
    let mut c = client.transaction().unwrap();
    let account = |c: &mut postgres::Transaction<'_>, owner_type: &str, owner_id: &str| -> String {
        c.execute(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind)
             VALUES ($1::text::ledger.owner_type, $2, $3, 'available') ON CONFLICT DO NOTHING",
            &[&owner_type, &owner_id, &asset],
        )
        .unwrap();
        c.query_one(
            "SELECT id::text FROM ledger.accounts
              WHERE owner_type = $1::text::ledger.owner_type AND owner_id = $2 AND asset_id = $3 AND kind = 'available' AND purpose = ''",
            &[&owner_type, &owner_id, &asset],
        )
        .unwrap()
        .get(0)
    };
    let rail_account = account(&mut c, "treasury", &format!("rail:{rail}"));
    let user_account = account(&mut c, "user", user);
    let key = format!("deposit:{rail}:{rail_ref}");
    let meta = Json::obj([("rail", Json::str(rail)), ("railRef", Json::str(rail_ref))]).compact();
    let id: String = c
        .query_one(
            "INSERT INTO ledger.ledger_tx (idempotency_key, module, reason, meta, hash, previous_hash)
             VALUES ($1, 'ledger', 'deposit.credited', $2::text::jsonb, md5($1), NULL) RETURNING id::text",
            &[&key, &meta],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO ledger.ledger_posted_keys (idempotency_key, tx_id, posted_hash, posted_meta)
         SELECT idempotency_key, id, hash, meta FROM ledger.ledger_tx WHERE id = $1::text::uuid",
        &[&id],
    )
    .unwrap();
    for (acct, direction, sign) in [(&rail_account, "credit", "-"), (&user_account, "debit", "")] {
        let after: String = c
            .query_one(
                &format!(
                    "UPDATE ledger.accounts SET balance = balance + {sign}$2::text::numeric WHERE id = $1::text::uuid RETURNING balance::text"
                ),
                &[acct, &amount],
            )
            .unwrap()
            .get(0);
        c.execute(
            "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::ledger.direction, $5::text::numeric, $6::text::numeric)",
            &[&id, acct, &asset, &direction, &amount, &after],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO ledger.ledger_tx_outbox (tx_id, payload, correlation_id) VALUES ($1::text::uuid, '{\"entries\":[]}', $1)",
        &[&id],
    )
    .unwrap();
    c.commit().unwrap();
    id
}

/// The desk's book: A and B alternately in USDT, so the address search has two owners to tell apart, then A in BTC.
/// The first USDT transaction's id and the BTC one's.
fn desk_book(db: &TestDb) -> (String, String) {
    let mut first = String::new();
    for i in 0..USDT_DEPOSITS {
        let id = deposit(
            db,
            if i % 2 == 0 { A } else { B },
            "USDT",
            "1.5",
            "desk-test",
            &format!("usdt-{i}"),
        );
        if i == 0 {
            first = id;
        }
    }
    (first, deposit(db, A, "BTC", "0.25", "desk-test", "btc-1"))
}

fn input(fields: &[(&str, &str)]) -> Value {
    Value::from_json(&Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Json::str(*v)))
            .collect(),
    ))
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn list(j: &Json, key: &str) -> Vec<Json> {
    match j.get(key) {
        Some(Json::Array(v)) => v.clone(),
        other => panic!("{key} is not a list: {other:?}"),
    }
}

fn num(j: &Json, key: &str) -> f64 {
    match j.get(key) {
        Some(Json::Number(n)) => *n,
        other => panic!("{key} is not a number: {other:?}"),
    }
}

fn iso_in(ms: i64) -> String {
    Instant(system_ms() + ms).iso()
}

// ── operator-desk.pg.test.ts ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn lists_newest_first_with_the_ledgers_total_and_the_cursor_walks_the_rest_without_repeating_a_row()
{
    let Some(db) = migrated() else { return };
    let (first_usdt, btc) = desk_book(&db);
    let store = db.store();
    let first = desk::list_transactions(&store, &input(&[])).unwrap();
    assert_eq!(s(&first, "total"), (USDT_DEPOSITS + 1).to_string());
    let rows = list(&first, "rows");
    assert_eq!(rows.len(), DESK_PAGE_SIZE);
    assert_eq!(s(&rows[0], "txId"), btc);
    assert_eq!(s(&rows[0], "businessKey"), "deposit:desk-test:btc-1");
    assert_eq!(
        rows[0].get("assets"),
        Some(&Json::Array(vec![Json::str("BTC")]))
    );
    assert_eq!(s(&rows[0], "postings"), "2");
    let seqs: Vec<u64> = rows.iter().map(|r| s(r, "seq").parse().unwrap()).collect();
    assert!(
        seqs.windows(2).all(|w| w[0] > w[1]),
        "newest first: {seqs:?}"
    );
    let cursor = s(&first, "nextCursor");
    assert_eq!(cursor, s(rows.last().unwrap(), "seq"));

    let second = desk::list_transactions(&store, &input(&[("before", &cursor)])).unwrap();
    // A later page does not count again: the first page's total stands.
    assert_eq!(second.get("total"), Some(&Json::Null));
    let more = list(&second, "rows");
    assert_eq!(more.len(), USDT_DEPOSITS + 1 - DESK_PAGE_SIZE);
    assert_eq!(second.get("nextCursor"), Some(&Json::Null));
    assert_eq!(s(more.last().unwrap(), "txId"), first_usdt);
    let mut ids: Vec<String> = rows.iter().chain(&more).map(|r| s(r, "txId")).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), USDT_DEPOSITS + 1);
    store.end();
}

#[test]
fn filters_by_asset_and_by_a_half_open_time_window() {
    let Some(db) = migrated() else { return };
    let (_, btc) = desk_book(&db);
    let store = db.store();
    let only = desk::list_transactions(&store, &input(&[("assetId", "BTC")])).unwrap();
    assert_eq!(s(&only, "total"), "1");
    assert_eq!(only.get("nextCursor"), Some(&Json::Null));
    let rows = list(&only, "rows");
    assert_eq!((rows.len(), s(&rows[0], "txId")), (1, btc));
    assert_eq!(
        s(
            &desk::list_transactions(&store, &input(&[("assetId", "ETH")])).unwrap(),
            "total"
        ),
        "0"
    );

    let later = iso_in(3_600_000);
    let none = desk::list_transactions(&store, &input(&[("from", &later)])).unwrap();
    assert_eq!(
        none.compact(),
        r#"{"total":"0","rows":[],"nextCursor":null}"#
    );
    let all = desk::list_transactions(
        &store,
        &input(&[
            ("from", "2026-01-01T00:00:00Z"),
            ("to", &later),
            ("assetId", "USDT"),
        ]),
    )
    .unwrap();
    assert_eq!(s(&all, "total"), USDT_DEPOSITS.to_string());
    store.end();
}

#[test]
fn answers_each_transactions_place_in_the_log_its_booking_time_and_its_tx_posted_record() {
    let Some(db) = migrated() else { return };
    let (_, btc) = desk_book(&db);
    let store = db.store();
    let read = |id: &str| {
        with_client(store.pool().unwrap(), |c| desk::read_booking_record(c, id)).unwrap()
    };
    let booking = read(&btc).unwrap();
    let mut c = db.client();
    let seq: String = c
        .query_one(
            "SELECT seq::text FROM ledger.ledger_tx WHERE id = $1::text::uuid",
            &[&btc],
        )
        .unwrap()
        .get(0);
    assert_eq!(s(&booking, "seq"), seq);
    // No correlation id on the request: the ledger records the transaction id as its reference.
    assert_eq!(s(&booking, "reference"), btc);
    let event = booking.get("event").unwrap();
    assert_eq!(s(event, "subject"), "intafaced.ledger.tx.posted");
    assert_eq!(event.get("publishedAt"), Some(&Json::Null));
    assert_eq!(s(&booking, "bookedAt"), s(event, "recordedAt"));
    assert_eq!(read(UNKNOWN), None);
    store.end();
}

#[test]
fn finds_accounts_by_address_prefix_with_their_volumes_and_the_balance_derived_from_them() {
    let Some(db) = migrated() else { return };
    desk_book(&db);
    let store = db.store();
    let a =
        desk::search_accounts(&store, &input(&[("prefix", &format!("user:{}", &A[..8]))])).unwrap();
    assert_eq!(a.get("nextCursor"), Some(&Json::Null));
    let accounts = list(&a, "accounts");
    let of = |asset: &str| {
        accounts
            .iter()
            .find(|r| s(r, "assetId") == asset)
            .unwrap()
            .clone()
    };
    let a_deposits = USDT_DEPOSITS.div_ceil(2);
    let usdt = of("USDT");
    assert_eq!(s(&usdt, "address"), format!("user:{A}"));
    assert_eq!(s(&usdt, "ownerType"), "user");
    assert_eq!(s(&usdt, "debits"), times("1.5", a_deposits, 1));
    assert_eq!(s(&usdt, "credits"), "0");
    assert_eq!(s(&usdt, "balance"), times("1.5", a_deposits, 1));
    assert_eq!(s(&usdt, "postings"), a_deposits.to_string());
    let btc = of("BTC");
    assert_eq!(
        (s(&btc, "debits"), s(&btc, "credits"), s(&btc, "balance")),
        ("0.25".to_owned(), "0".to_owned(), "0.25".to_owned())
    );
    assert!(accounts.iter().all(|r| s(r, "ownerId") == A));

    let rail = desk::search_accounts(&store, &input(&[("prefix", "treasury:rail:desk")])).unwrap();
    let usdt_rail = list(&rail, "accounts")
        .into_iter()
        .find(|r| s(r, "assetId") == "USDT")
        .unwrap();
    assert_eq!(s(&usdt_rail, "address"), "treasury:rail:desk-test");
    assert_eq!(s(&usdt_rail, "debits"), "0");
    assert_eq!(s(&usdt_rail, "credits"), times("1.5", USDT_DEPOSITS, 1));
    assert_eq!(s(&usdt_rail, "balance"), times("1.5", USDT_DEPOSITS, -1));

    // The prefix is taken literally: a wildcard in it matches nothing.
    for literal in ["treasury:%", "treasury:rail_desk"] {
        let found = desk::search_accounts(&store, &input(&[("prefix", literal)])).unwrap();
        assert_eq!(list(&found, "accounts"), Vec::<Json>::new(), "{literal}");
    }
    store.end();
}

#[test]
fn walks_a_search_past_one_page_with_its_cursor() {
    let Some(db) = migrated() else { return };
    desk_book(&db);
    let store = db.store();
    let prefix = format!("user:{}", &A[..1]);
    let all = list(
        &desk::search_accounts(&store, &input(&[("prefix", &prefix)])).unwrap(),
        "accounts",
    );
    // The first page holds both of A's accounts; a cursor after the first leaves the second.
    let after = s(&all[0], "accountId");
    let next = list(
        &desk::search_accounts(&store, &input(&[("prefix", &prefix), ("after", &after)])).unwrap(),
        "accounts",
    );
    let ids = |rows: &[Json]| rows.iter().map(|r| s(r, "accountId")).collect::<Vec<_>>();
    assert_eq!(ids(&next), ids(&all[1..]));
    store.end();
}

#[test]
fn counts_the_book() {
    let Some(db) = migrated() else { return };
    desk_book(&db);
    let store = db.store();
    let stats = desk::read_stats(&store).unwrap();
    assert_eq!(s(&stats, "transactions"), (USDT_DEPOSITS + 1).to_string());
    assert_eq!(s(&stats, "postings"), (2 * (USDT_DEPOSITS + 1)).to_string());
    // A and B in USDT, A in BTC, and the rail in each.
    assert_eq!(s(&stats, "accounts"), "5");
    assert_eq!(s(&stats, "assets"), "2");
    let last: String = db
        .client()
        .query_one("SELECT max(seq)::text FROM ledger.ledger_tx", &[])
        .unwrap()
        .get(0);
    assert_eq!(s(&stats, "lastSeq"), last);
    assert!(service_kit::time::js_date(&s(&stats, "asOf")).is_some());
    store.end();
}

#[test]
fn records_the_desks_list_and_search_in_the_access_log_and_refuses_an_action_it_does_not_know() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let actor = |r| Actor {
        actor_id: OPERATOR,
        request_id: Some(r),
    };
    desk::record_lookup(
        &store,
        actor("desk-1"),
        "transactions",
        "asset=* from=* to=* before=*",
        "transactions.list",
    )
    .unwrap();
    desk::record_lookup(
        &store,
        actor("desk-2"),
        "address_prefix",
        "house:fees",
        "accounts.search",
    )
    .unwrap();
    let actions: Vec<String> = db
        .client()
        .query(
            "SELECT action FROM ledger.operator_access_log WHERE request_id IN ('desk-1', 'desk-2') ORDER BY request_id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(actions, ["transactions.list", "accounts.search"]);
    let refused = db
        .client()
        .execute(
            "INSERT INTO ledger.operator_access_log (actor_id, action, target_owner_type, target_owner_id) VALUES ($1, 'ledger.dump', 'x', 'y')",
            &[&OPERATOR],
        )
        .unwrap_err();
    assert!(format!("{refused:?}").contains("operator_access_log_action_ck"));
    // The slice's own writer refuses it the same way, as an unrecorded lookup.
    assert!(matches!(
        desk::record_lookup(&store, actor("desk-3"), "x", "y", "ledger.dump"),
        Err(desk::ReadError::Unrecorded(_))
    ));
    store.end();
}

// ── operator-account-metadata.pg.test.ts ────────────────────────────────────────────────────────────────────────────

type Asked = (String, String, String, String, Option<(String, String)>);

/// `stubApprovalConsumer(approverId)`: a consumed four-eyes row naming the approver, requested by `requester`, both
/// attested founders; it keeps every consume, and can freeze the book once it has answered (the race).
struct Stub {
    approver: &'static str,
    seen: Mutex<Vec<Asked>>,
    freeze_after: Option<String>,
}

impl Approvals for Stub {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.seen.lock().unwrap().push((
            input.approval_id.to_owned(),
            input.operation_id.to_owned(),
            input.target_service.to_owned(),
            input.target_id.to_owned(),
            input.replay.map(|r| {
                (
                    r.request_id.to_owned(),
                    r.consumer_principal_id.unwrap_or_default().to_owned(),
                )
            }),
        ));
        if let Some(url) = &self.freeze_after {
            freeze_at(url, true);
        }
        let verb = input
            .target_id
            .strip_prefix("posting_")
            .unwrap_or(input.target_id);
        Ok(Consumed {
            action_type: format!("ledger.{verb}"),
            target_service: input.target_service.to_owned(),
            target_id: input.target_id.to_owned(),
            status: "CONSUMED".to_owned(),
            requester_id: "requester".to_owned(),
            approver_id: Some(self.approver.to_owned()),
            approver_is_founder: Some(true),
            requester_is_founder: Some(true),
        })
    }
}

fn approvals(approver: &'static str) -> Stub {
    Stub {
        approver,
        seen: Mutex::new(Vec::new()),
        freeze_after: None,
    }
}

impl Stub {
    fn calls(&self) -> Vec<Asked> {
        self.seen.lock().unwrap().clone()
    }
}

fn freeze_at(url: &str, frozen: bool) {
    let mut c = postgres::Client::connect(url, postgres::NoTls).unwrap();
    let (reason, actor) = if frozen {
        (Some("LOCAL TEST freeze"), Some("test"))
    } else {
        (None, None)
    };
    c.execute(
        "UPDATE ledger.posting_freeze SET frozen = $1, reason = $2, actor = $3 WHERE id = true",
        &[&frozen, &reason, &actor],
    )
    .unwrap();
}

/// A book with the customer's one account; its id.
fn meta_book(db: &TestDb) -> String {
    deposit(db, A, "USDT", "1", "meta-test", "meta-1");
    db.client()
        .query_one(
            "SELECT id::text FROM ledger.accounts WHERE owner_type = 'user' AND owner_id = $1",
            &[&A],
        )
        .unwrap()
        .get(0)
}

fn set_input(account: &str, key: &str, value: &str, revision: i64) -> Value {
    Value::from_json(&Json::obj([
        ("accountId", Json::str(account)),
        ("key", Json::str(key)),
        ("value", Json::str(value)),
        ("reason", Json::str(REASON)),
        ("revision", Json::int(revision)),
    ]))
}

fn delete_input(account: &str, key: &str, revision: i64, approval: &str, operation: &str) -> Value {
    Value::from_json(&Json::obj([
        ("accountId", Json::str(account)),
        ("key", Json::str(key)),
        ("reason", Json::str(REASON)),
        ("revision", Json::int(revision)),
        ("approvalId", Json::str(approval)),
        ("operationId", Json::str(operation)),
    ]))
}

fn set(store: &Store, account: &str, key: &str, value: &str, revision: i64) -> Json {
    desk::set_account_metadata(store, FOUNDER_A, set_input(account, key, value, revision)).unwrap()
}

fn code_of(e: &DeleteError) -> String {
    match e {
        DeleteError::Store(e) => e.code.clone().unwrap_or_default(),
        DeleteError::Approval(Refused::Coded { code, .. }) => code.clone(),
        DeleteError::Approval(Refused::Thrown(m)) => m.clone(),
    }
}

fn change(j: &Json) -> Json {
    j.get("change").unwrap().clone()
}

fn entry_of(read: &Json, key: &str) -> Option<Json> {
    list(read, "entries")
        .into_iter()
        .find(|e| s(e, "key") == key)
}

#[test]
fn sets_a_key_overwrites_it_with_the_value_before_and_after_and_reads_both_back_newest_first() {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    let first = change(&set(&store, &account, "desk.label", "one", 0));
    assert_eq!(
        (
            s(&first, "action"),
            first.get("before"),
            s(&first, "after"),
            num(&first, "revision")
        ),
        ("set".to_owned(), Some(&Json::Null), "one".to_owned(), 1.0)
    );
    assert_eq!(s(&first, "requesterId"), FOUNDER_A);
    assert_eq!(first.get("approverId"), Some(&Json::Null));
    let second = change(&set(&store, &account, "desk.label", "two", 1));
    assert_eq!(
        (
            s(&second, "before"),
            s(&second, "after"),
            num(&second, "revision")
        ),
        ("one".to_owned(), "two".to_owned(), 2.0)
    );

    let read = desk::read_account_metadata(&store, &account).unwrap();
    assert_eq!(s(&read, "address"), format!("user:{A}"));
    let entries = list(&read, "entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        (
            s(&entries[0], "key"),
            s(&entries[0], "value"),
            num(&entries[0], "revision"),
            s(&entries[0], "updatedBy")
        ),
        (
            "desk.label".to_owned(),
            "two".to_owned(),
            2.0,
            FOUNDER_A.to_owned()
        )
    );
    let changes: Vec<(f64, Json, Json)> = list(&read, "changes")
        .iter()
        .map(|c| {
            (
                num(c, "revision"),
                c.get("before").cloned().unwrap(),
                c.get("after").cloned().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        changes,
        [
            (2.0, Json::str("one"), Json::str("two")),
            (1.0, Json::Null, Json::str("one"))
        ]
    );
    assert_eq!(read.get("frozen"), Some(&Json::Bool(false)));
    store.end();
}

#[test]
fn answers_a_retried_set_with_its_first_change_and_refuses_a_set_from_a_revision_someone_else_moved()
 {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    let first = change(&set(&store, &account, "desk.retry", "v", 0));
    let again = change(&set(&store, &account, "desk.retry", "v", 0));
    assert_eq!(s(&again, "seq"), s(&first, "seq"));
    let stale = desk::set_account_metadata(
        &store,
        FOUNDER_A,
        set_input(&account, "desk.retry", "other", 0),
    )
    .unwrap_err();
    assert_eq!(stale.code.as_deref(), Some(ACCOUNT_METADATA_STALE));
    // The same words from another person are not a retry: it was someone else who wrote first.
    let other =
        desk::set_account_metadata(&store, OPERATOR, set_input(&account, "desk.retry", "v", 0))
            .unwrap_err();
    assert_eq!(other.code.as_deref(), Some(ACCOUNT_METADATA_STALE));
    let n: i64 = db
        .client()
        .query_one(
            "SELECT count(*) FROM ledger.account_metadata_changes WHERE account_id = $1::text::uuid AND key = 'desk.retry'",
            &[&account],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 1);
    store.end();
}

#[test]
fn deletes_a_key_with_a_second_founder_one_consume_bound_to_the_key_and_revision_the_change_names_both()
 {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    set(&store, &account, "desk.gone", "bye", 0);
    let identity = approvals(FOUNDER_B);
    let cmd = || delete_input(&account, "desk.gone", 1, "appr-del-1", "op-del-1");
    let done = change(&desk::delete_account_metadata(&store, &identity, FOUNDER_A, cmd()).unwrap());
    assert_eq!(
        (
            s(&done, "action"),
            s(&done, "before"),
            done.get("after"),
            num(&done, "revision")
        ),
        (
            "delete".to_owned(),
            "bye".to_owned(),
            Some(&Json::Null),
            2.0
        )
    );
    assert_eq!(
        (
            s(&done, "requesterId"),
            s(&done, "approverId"),
            s(&done, "reason")
        ),
        (
            FOUNDER_A.to_owned(),
            FOUNDER_B.to_owned(),
            REASON.to_owned()
        )
    );
    assert_eq!(
        identity.calls(),
        [(
            "appr-del-1".to_owned(),
            "op-del-1".to_owned(),
            "svc-ledger".to_owned(),
            ACCOUNT_METADATA_DELETE_TARGET.to_owned(),
            Some(("op-del-1".to_owned(), FOUNDER_A.to_owned()))
        )]
    );

    // A lost reply: the same approval answers the same change and identity is not asked again.
    let again =
        change(&desk::delete_account_metadata(&store, &identity, FOUNDER_A, cmd()).unwrap());
    assert_eq!(s(&again, "seq"), s(&done, "seq"));
    assert_eq!(identity.calls().len(), 1);

    let read = desk::read_account_metadata(&store, &account).unwrap();
    assert!(entry_of(&read, "desk.gone").is_none());
    assert!(list(&read, "deleted").contains(&Json::obj([
        ("key", Json::str("desk.gone")),
        ("revision", Json::int(2))
    ])));
    // Deleting it again has nothing to delete; setting it again starts from the revision the ledger holds.
    let absent = desk::delete_account_metadata(
        &store,
        &approvals(FOUNDER_B),
        FOUNDER_A,
        delete_input(&account, "desk.gone", 2, "appr-del-2", "op-del-2"),
    )
    .unwrap_err();
    assert_eq!(code_of(&absent), ACCOUNT_METADATA_KEY_ABSENT);
    let back = change(&set(&store, &account, "desk.gone", "back", 2));
    assert_eq!(
        (
            back.get("before"),
            s(&back, "after"),
            num(&back, "revision")
        ),
        (Some(&Json::Null), "back".to_owned(), 3.0)
    );
    store.end();
}

#[test]
fn refuses_a_delete_whose_key_moved_after_approval_and_one_approved_by_the_person_who_asked_changing_nothing()
 {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    set(&store, &account, "desk.moved", "a", 0);
    set(&store, &account, "desk.moved", "b", 1);
    let identity = approvals(FOUNDER_B);
    let stale = desk::delete_account_metadata(
        &store,
        &identity,
        FOUNDER_A,
        delete_input(&account, "desk.moved", 1, "appr-moved", "op-moved"),
    )
    .unwrap_err();
    assert_eq!(code_of(&stale), ACCOUNT_METADATA_STALE);
    assert!(identity.calls().is_empty());

    // The stand-in names its requester 'requester'; an approver of the same name is the same person twice.
    let selfish = desk::delete_account_metadata(
        &store,
        &approvals("requester"),
        FOUNDER_A,
        delete_input(&account, "desk.moved", 2, "appr-self", "op-self"),
    )
    .unwrap_err();
    assert_eq!(code_of(&selfish), "action_approval.not_founders");
    let read = desk::read_account_metadata(&store, &account).unwrap();
    let kept = entry_of(&read, "desk.moved").unwrap();
    assert_eq!(
        (s(&kept, "value"), num(&kept, "revision")),
        ("b".to_owned(), 2.0)
    );
    store.end();
}

#[test]
fn under_the_posting_freeze_the_read_answers_a_set_and_a_delete_refuse_ledger_frozen_and_the_approval_is_not_spent()
 {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    set(&store, &account, "desk.frozen", "kept", 0);
    freeze_at(&db.url, true);
    let read = desk::read_account_metadata(&store, &account).unwrap();
    assert_eq!(read.get("frozen"), Some(&Json::Bool(true)));
    assert_eq!(s(&entry_of(&read, "desk.frozen").unwrap(), "value"), "kept");
    let refused = desk::set_account_metadata(
        &store,
        FOUNDER_A,
        set_input(&account, "desk.frozen", "new", 1),
    )
    .unwrap_err();
    assert_eq!(refused.code.as_deref(), Some(FROZEN));
    assert_eq!(
        refused.message,
        "Ledger posting is frozen: LOCAL TEST freeze"
    );
    let identity = approvals(FOUNDER_B);
    let cmd = || delete_input(&account, "desk.frozen", 1, "appr-frz", "op-frz");
    let frozen = desk::delete_account_metadata(&store, &identity, FOUNDER_A, cmd()).unwrap_err();
    assert_eq!(code_of(&frozen), FROZEN);
    assert!(identity.calls().is_empty());
    freeze_at(&db.url, false);
    // After the unfreeze the same approval deletes it.
    let done = change(&desk::delete_account_metadata(&store, &identity, FOUNDER_A, cmd()).unwrap());
    assert_eq!(
        (s(&done, "action"), s(&done, "before")),
        ("delete".to_owned(), "kept".to_owned())
    );
    store.end();
}

#[test]
fn a_freeze_that_lands_after_the_check_while_identity_spends_the_approval_refuses_as_spent_changing_nothing()
 {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    set(&store, &account, "desk.race", "kept", 0);
    let racing = Stub {
        freeze_after: Some(db.url.clone()),
        ..approvals(FOUNDER_B)
    };
    let spent = desk::delete_account_metadata(
        &store,
        &racing,
        FOUNDER_A,
        delete_input(&account, "desk.race", 1, "appr-race", "op-race"),
    )
    .unwrap_err();
    assert_eq!(code_of(&spent), ACCOUNT_METADATA_APPROVAL_SPENT);
    freeze_at(&db.url, false);
    let kept = entry_of(
        &desk::read_account_metadata(&store, &account).unwrap(),
        "desk.race",
    )
    .unwrap();
    assert_eq!(
        (s(&kept, "value"), num(&kept, "revision")),
        ("kept".to_owned(), 1.0)
    );
    store.end();
}

#[test]
fn refuses_an_unknown_account_a_malformed_key_and_a_short_reason_and_keeps_the_change_record_append_only()
 {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    assert_eq!(
        desk::read_account_metadata(&store, UNKNOWN)
            .unwrap_err()
            .code
            .as_deref(),
        Some(ACCOUNT_NOT_FOUND)
    );
    assert_eq!(
        desk::set_account_metadata(&store, FOUNDER_A, set_input(UNKNOWN, "desk.label", "x", 0))
            .unwrap_err()
            .code
            .as_deref(),
        Some(ACCOUNT_NOT_FOUND)
    );
    let base = || {
        vec![
            ("accountId".to_owned(), Json::str(account.clone())),
            ("value".to_owned(), Json::str("x")),
            ("revision".to_owned(), Json::int(0)),
            ("key".to_owned(), Json::str("desk.label")),
            ("reason".to_owned(), Json::str(REASON)),
        ]
    };
    let with = |k: &str, v: Json| {
        let mut o = base();
        o.iter_mut().find(|(key, _)| key == k).unwrap().1 = v;
        Value::from_json(&Json::Object(o))
    };
    for bad in [
        with("key", Json::str("Desk Label")),
        with("reason", Json::str("too short")),
        with("revision", Json::str("0")),
        with("revision", Json::Null),
    ] {
        let refused = desk::set_account_metadata(&store, FOUNDER_A, bad).unwrap_err();
        assert_eq!(refused.code.as_deref(), Some(ACCOUNT_METADATA_INVALID));
    }
    for statement in [
        "UPDATE ledger.account_metadata_changes SET after = 'forged' WHERE account_id = $1::text::uuid",
        "DELETE FROM ledger.account_metadata_changes WHERE account_id = $1::text::uuid",
    ] {
        // A change to refuse: the first refusal above wrote nothing, so set one.
        set(&store, &account, "desk.kept", "v", 0);
        let e = db.client().execute(statement, &[&account]).unwrap_err();
        assert!(format!("{e:?}").contains("append-only"), "{statement}");
    }
    store.end();
}

#[test]
fn the_access_log_takes_a_metadata_read() {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let store = db.store();
    desk::record_lookup(
        &store,
        Actor {
            actor_id: FOUNDER_A,
            request_id: None,
        },
        "account",
        &account,
        "account_metadata.read",
    )
    .unwrap();
    let action: String = db
        .client()
        .query_one(
            "SELECT action FROM ledger.operator_access_log WHERE target_owner_id = $1 ORDER BY id DESC LIMIT 1",
            &[&account],
        )
        .unwrap()
        .get(0);
    assert_eq!(action, "account_metadata.read");
    store.end();
}

// ── the doors, on a real book ───────────────────────────────────────────────────────────────────────────────────────

fn door(db: &TestDb, approvals: Box<dyn Approvals>) -> LedgerDoor {
    LedgerDoor::new(DoorConfig {
        internal_secret: "placeholder-desk-test-internal-secret".to_owned(),
        body_bind: BodyBind::Require,
        keys: None,
        tokens: TokenConfig {
            secret: TOKEN_SECRET.to_owned(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        store: db.store(),
        service_name: "svc-ledger".to_owned(),
        bus: Arc::new(MemoryBus::default()),
        approvals,
        clock_skew_bound_ms: None,
        now_ms: system_ms,
        log: Logger::new("info", Box::new(std::io::sink())),
        custody: svc_ledger::reconcile::CustodyLayer::On,
        reconcile_statement_timeout_ms: svc_ledger::reconcile::DEFAULT_STATEMENT_TIMEOUT_MS,
        indexer_url: None,
        fetch: Arc::new(service_kit::http::UreqFetch::new()),
        posting: support::idle_posting(),
    })
    .unwrap()
}

/// `issueAccessToken` for the operator, with these scopes and second factor.
fn bearer(scopes: &[&str], mfa: bool) -> String {
    let now = system_seconds();
    let b64 = |j: Json| URL_SAFE_NO_PAD.encode(j.compact());
    let header = b64(Json::obj([
        ("alg", Json::str("HS256")),
        ("typ", Json::str("JWT")),
    ]));
    let claims = b64(Json::obj([
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("basic")),
        ("mfa", Json::Bool(mfa)),
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
        ("sub", Json::str(OPERATOR)),
        ("iss", Json::str("intafaced")),
        ("aud", Json::str("intafaced.api")),
        ("iat", Json::int(now)),
        ("exp", Json::int(now + 900)),
        ("jti", Json::str("44444444-4444-4444-8444-444444444444")),
    ]));
    let mut mac = Hmac::<Sha256>::new_from_slice(TOKEN_SECRET.as_bytes()).unwrap();
    mac.update(format!("{header}.{claims}").as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("Bearer {header}.{claims}.{sig}")
}

/// A founder's sign-in: `admin:read` with a second factor.
fn founder() -> String {
    bearer(&["admin:read"], true)
}

fn treasury() -> String {
    bearer(&["admin:treasury"], true)
}

/// One request to the door, as request `req-7`: its status and parsed body.
fn call(door: &LedgerDoor, method: &str, path: &str, auth: &str, body: &str) -> (u16, Json) {
    let mut headers = vec![("authorization".to_owned(), auth.to_owned())];
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let r = door.handle_as(
        &Request {
            method,
            url: path,
            headers: &headers,
            body,
        },
        "req-7",
    );
    (r.status, json::parse(&r.body).unwrap())
}

/// Every access row: actor, action, target type, target id, request.
fn access_log(db: &TestDb) -> Vec<(String, String, String, String, Option<String>)> {
    db.client()
        .query(
            "SELECT actor_id, action, target_owner_type, target_owner_id, request_id FROM ledger.operator_access_log ORDER BY id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4)))
        .collect()
}

fn row(
    action: &str,
    owner_type: &str,
    owner_id: &str,
) -> (String, String, String, String, Option<String>) {
    (
        OPERATOR.to_owned(),
        action.to_owned(),
        owner_type.to_owned(),
        owner_id.to_owned(),
        Some("req-7".to_owned()),
    )
}

#[test]
fn each_recorded_lookup_writes_its_access_row_under_the_operator_and_the_request_then_answers() {
    let Some(db) = migrated() else { return };
    let (_, btc) = desk_book(&db);
    let d = door(&db, Box::new(Unwired));

    let (status, tx) = call(
        &d,
        "GET",
        &format!("/operator/transactions/{btc}"),
        &founder(),
        "",
    );
    assert_eq!(status, 200, "{}", tx.compact());
    assert_eq!(s(&tx, "businessKey"), "deposit:desk-test:btc-1");
    let postings = list(&tx, "postings");
    let side = |p: &Json| {
        (
            s(p, "direction"),
            s(p, "side"),
            s(p, "amount"),
            s(p, "balanceBefore"),
            s(p, "balanceAfter"),
        )
    };
    // The rail boundary is credited (where the value came from), the user's account debited (where it went).
    let want: Vec<(String, String, String, String, String)> = [
        ("credit", "source", "0.25", "0", "-0.25"),
        ("debit", "destination", "0.25", "0", "0.25"),
    ]
    .iter()
    .map(|(a, b, c, d2, e)| {
        (
            (*a).into(),
            (*b).into(),
            (*c).into(),
            (*d2).into(),
            (*e).into(),
        )
    })
    .collect();
    assert_eq!(postings.iter().map(side).collect::<Vec<_>>(), want);
    assert_eq!(s(tx.get("booking").unwrap(), "reference"), btc);

    let (status, traced) = call(
        &d,
        "GET",
        "/operator/trace?businessKey=%20deposit%3Adesk-test%3Abtc-1%20",
        &founder(),
        "",
    );
    assert_eq!(
        (status, traced.get("found"), s(&traced, "txId")),
        (200, Some(&Json::Bool(true)), btc.clone())
    );
    let (_, never) = call(
        &d,
        "GET",
        "/operator/trace?businessKey=deposit%3Anever",
        &founder(),
        "",
    );
    assert_eq!(
        never.compact(),
        r#"{"found":false,"businessKey":"deposit:never"}"#
    );

    let (status, page) = call(
        &d,
        "GET",
        "/operator/transactions?assetId=%20BTC%20&from=",
        &founder(),
        "",
    );
    assert_eq!((status, s(&page, "total")), (200, "1".to_owned()));
    let (status, found) = call(
        &d,
        "GET",
        "/operator/accounts?prefix=user%3Aaaaa",
        &founder(),
        "",
    );
    assert_eq!((status, list(&found, "accounts").len()), (200, 2));
    let account = s(&list(&found, "accounts")[0], "accountId");
    let (status, meta) = call(
        &d,
        "GET",
        &format!("/operator/accounts/{account}/metadata"),
        &founder(),
        "",
    );
    assert_eq!((status, s(&meta, "address")), (200, format!("user:{A}")));
    // The counts name no one: no row.
    let (status, stats) = call(&d, "GET", "/operator/stats", &founder(), "");
    assert_eq!(
        (status, s(&stats, "transactions")),
        (200, (USDT_DEPOSITS + 1).to_string())
    );

    assert_eq!(
        access_log(&db),
        [
            row("transaction.read", "transaction", &btc),
            row("trace.read", "business_key", "deposit:desk-test:btc-1"),
            row("trace.read", "business_key", "deposit:never"),
            row(
                "transactions.list",
                "transactions",
                "asset=BTC from=* to=* before=*"
            ),
            row("accounts.search", "address_prefix", "user:aaaa"),
            row("account_metadata.read", "account", &account),
        ]
    );
    d.end();
}

#[test]
fn an_unknown_transaction_or_account_is_404_and_still_recorded() {
    let Some(db) = migrated() else { return };
    let d = door(&db, Box::new(Unwired));
    let (status, body) = call(
        &d,
        "GET",
        &format!("/operator/transactions/{UNKNOWN}"),
        &founder(),
        "",
    );
    assert_eq!(
        (status, body.compact()),
        (
            404,
            r#"{"message":"No transaction has that id.","code":"ledger.tx_not_found"}"#.to_owned()
        )
    );
    let (status, body) = call(
        &d,
        "GET",
        &format!("/operator/accounts/{UNKNOWN}/metadata"),
        &founder(),
        "",
    );
    assert_eq!(
        (status, body.compact()),
        (
            404,
            r#"{"message":"No ledger account has that id.","code":"ledger.account_not_found"}"#
                .to_owned()
        )
    );
    assert_eq!(
        access_log(&db),
        [
            row("transaction.read", "transaction", UNKNOWN),
            row("account_metadata.read", "account", UNKNOWN)
        ]
    );
    d.end();
}

#[test]
fn a_lookup_whose_access_row_cannot_be_written_is_refused_and_reads_nothing() {
    let Some(db) = migrated() else { return };
    let (_, btc) = desk_book(&db);
    db.client()
        .batch_execute("ALTER TABLE ledger.operator_access_log ADD CONSTRAINT desk_test_refuse CHECK (false) NOT VALID")
        .unwrap();
    let d = door(&db, Box::new(Unwired));
    let unrecorded = r#"{"message":"The lookup could not be recorded, so it was not read.","code":"ledger.lookup_unrecorded"}"#;
    for path in [
        format!("/operator/transactions/{btc}"),
        "/operator/trace?businessKey=deposit%3Adesk-test%3Abtc-1".to_owned(),
        "/operator/transactions".to_owned(),
        "/operator/accounts?prefix=user%3Aa".to_owned(),
        format!("/operator/accounts/{UNKNOWN}/metadata"),
    ] {
        let (status, body) = call(&d, "GET", &path, &founder(), "");
        assert_eq!(
            (status, body.compact()),
            (503, unrecorded.to_owned()),
            "{path}"
        );
    }
    // The counts write no row, so they still answer.
    assert_eq!(call(&d, "GET", "/operator/stats", &founder(), "").0, 200);
    d.end();
}

#[test]
fn a_recorded_read_the_ledger_cannot_answer_is_503_with_a_fixed_message_never_the_driver_text() {
    let Some(db) = migrated() else { return };
    let (_, btc) = desk_book(&db);
    // The entries every answer here reads are gone; the access row still writes.
    db.client()
        .batch_execute("ALTER TABLE ledger.ledger_entries RENAME TO ledger_entries_gone")
        .unwrap();
    let d = door(&db, Box::new(Unwired));
    let (status, body) = call(
        &d,
        "GET",
        &format!("/operator/transactions/{btc}"),
        &founder(),
        "",
    );
    assert_eq!(
        (status, body.compact()),
        (503, r#"{"message":"The ledger could not answer this lookup. Try again.","code":"ledger.lookup_unavailable"}"#.to_owned())
    );
    assert_eq!(call(&d, "GET", "/operator/stats", &founder(), "").0, 503);
    assert_eq!(
        access_log(&db),
        [row("transaction.read", "transaction", &btc)]
    );
    d.end();
}

#[test]
fn the_metadata_doors_take_the_account_from_the_path_and_answer_each_refusal_with_its_own_status() {
    let Some(db) = migrated() else { return };
    let account = meta_book(&db);
    let d = door(&db, Box::new(approvals(FOUNDER_B)));
    let set_path = format!("/operator/accounts/{account}/metadata/set");
    let delete_path = format!("/operator/accounts/{account}/metadata/delete");
    let body = |value: &str, revision: i64| {
        Json::obj([
            ("accountId", Json::str(UNKNOWN)),
            ("key", Json::str("desk.door")),
            ("value", Json::str(value)),
            ("reason", Json::str(REASON)),
            ("revision", Json::int(revision)),
        ])
        .compact()
    };
    // A lookup sign-in cannot write.
    assert_eq!(
        call(&d, "POST", &set_path, &founder(), &body("v", 0)).0,
        403
    );
    let (status, set) = call(&d, "POST", &set_path, &treasury(), &body("v", 0));
    assert_eq!((status, s(&set, "accountId")), (200, account.clone()));
    assert_eq!(s(&change(&set), "requesterId"), OPERATOR);

    let (status, stale) = call(&d, "POST", &set_path, &treasury(), &body("w", 0));
    assert_eq!(
        (status, s(&stale, "code")),
        (409, ACCOUNT_METADATA_STALE.to_owned())
    );
    let (status, invalid) = call(&d, "POST", &set_path, &treasury(), r#"{"key":"desk.door"}"#);
    assert_eq!(
        (status, invalid.compact()),
        (400, r#"{"message":"Invalid input: expected string, received undefined; Invalid input: expected string, received undefined; Invalid input: expected number, received undefined","code":"ledger.account_metadata_invalid"}"#.to_owned())
    );
    let (status, missing) = call(
        &d,
        "POST",
        &format!("/operator/accounts/{UNKNOWN}/metadata/set"),
        &treasury(),
        &body("v", 0),
    );
    assert_eq!(
        (status, s(&missing, "code")),
        (404, ACCOUNT_NOT_FOUND.to_owned())
    );

    let delete = Json::obj([
        ("key", Json::str("desk.door")),
        ("reason", Json::str(REASON)),
        ("revision", Json::int(1)),
        ("approvalId", Json::str("appr-door")),
        ("operationId", Json::str("op-door")),
    ])
    .compact();
    freeze_at(&db.url, true);
    let (status, frozen) = call(&d, "POST", &delete_path, &treasury(), &delete);
    assert_eq!(
        (status, frozen.compact()),
        (
            412,
            r#"{"message":"Ledger posting is frozen: LOCAL TEST freeze","code":"ledger.frozen"}"#
                .to_owned()
        )
    );
    freeze_at(&db.url, false);
    let (status, deleted) = call(&d, "POST", &delete_path, &treasury(), &delete);
    assert_eq!(
        (status, s(&change(&deleted), "approverId")),
        (200, FOUNDER_B.to_owned())
    );
    let (status, absent) = call(
        &d,
        "POST",
        &delete_path,
        &treasury(),
        &delete.replace("\"revision\":1", "\"revision\":2"),
    );
    assert_eq!(
        (status, s(&absent, "code")),
        (404, ACCOUNT_METADATA_KEY_ABSENT.to_owned())
    );
    d.end();

    // No identity wired: the delete's approval refusal is guarded's 400 with its code, and nothing changed.
    set_once(&db, &account);
    let unwired = door(&db, Box::new(Unwired));
    let (status, refused) = call(
        &unwired,
        "POST",
        &delete_path,
        &treasury(),
        &delete.replace("desk.door", "desk.unwired"),
    );
    assert_eq!(
        (status, s(&refused, "code")),
        (400, "action_approval.identity_unwired".to_owned())
    );
    unwired.end();
}

fn set_once(db: &TestDb, account: &str) {
    let store = db.store();
    set(&store, account, "desk.unwired", "v", 0);
    store.end();
}
