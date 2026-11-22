//! Slice `transfers`'s terms, fee schedule and limit requests against the Rust door on a real Postgres. Ports the checks
//! of the TypeScript's `transfers/fee-schedule.db.test.ts`, `transfers/transfer-terms.db.test.ts` and
//! `transfers/limit-requests.db.test.ts`, each test named after the TypeScript test's words.
//!
//! The slice's own calls (`fees.schedule.get`, `limits.requestIncrease`, `limits.myRequests`) enter through the door.
//! What the TypeScript drives through another part's call is driven here through the store functions that call will
//! use: compliance's publish, queue and decision (`ops.publishTransferTerms`, `ops.limitRequests`,
//! `ops.decideLimitRequest`, slice `ops-desk`) through `terms::publish`, `limits::queue` and `limits::decide`; a send's
//! quote and its terms check (`transfers.quote`, `transfers.toUser`, the personal sends) through `terms::quote` and
//! `terms::assert_within_terms`. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::transfers::limits::{self, Ask, Decision};
use svc_bank::transfers::terms::{self, TermsRow};

use support::TestDb;

const SECRET: &str = "a-bank-transfers-terms-db-edge-secret-long-00";
const INTERNAL: &str = "a-bank-transfers-terms-db-internal-secret-long";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const CY: &str = "33333333-3333-4333-8333-333333333333";
const REASON: &str = "TEST: paying rent this month";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn now() -> Instant {
    door::system_now()
}

fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

fn door_for(db: &TestDb) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
}

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("44444444-4444-4444-8444-444444444444")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
struct Answer(u16, Json);

impl Answer {
    fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    fn data(&self, key: &str) -> Option<&Json> {
        self.1.get("error").and_then(|e| e.get("data"))?.get(key)
    }
    /// The refusal's own code (`cause.code`).
    fn code(&self) -> String {
        match self.data("cause").and_then(|c| c.get("code")) {
            Some(Json::String(c)) => c.clone(),
            _ => panic!("no refusal code: {} {}", self.0, self.1.compact()),
        }
    }
    /// tRPC's code (`FORBIDDEN`, `BAD_REQUEST`, ...).
    fn trpc(&self) -> String {
        match self.data("code") {
            Some(Json::String(c)) => c.clone(),
            _ => "ok".to_owned(),
        }
    }
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

fn call(d: &BankDoor, user: &str, scopes: &[&str], path: &str, input: Option<&str>) -> Answer {
    let mut headers = person(user, scopes);
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            match input {
                Some(i) => format!("/trpc/{path}?input={}", encode(i)),
                None => format!("/trpc/{path}"),
            },
            String::new(),
        ),
        _ => (
            "POST",
            format!("/trpc/{path}"),
            input.unwrap_or("").to_owned(),
        ),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = d.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-transfers-terms-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

const RW: &[&str] = &["bank:read", "bank:write"];

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn code_of(r: Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        other => panic!("not a bank refusal: {other:?}"),
    }
}

fn tdb() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

/// TEST terms only; not owner values.
fn publish_usdt(db: &TestDb) {
    db.client()
        .batch_execute(
            "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) VALUES ('USDT', 25, 100, 0)",
        )
        .unwrap();
}

fn increase(
    d: &BankDoor,
    user: &str,
    id: &str,
    kind: &str,
    requested: &str,
    reason: &str,
) -> Answer {
    call(
        d,
        user,
        RW,
        "limits.requestIncrease",
        Some(
            &Json::obj([
                ("requestId", Json::str(id)),
                ("assetId", Json::str("USDT")),
                ("kind", Json::str(kind)),
                ("requested", Json::str(requested)),
                ("reason", Json::str(reason)),
            ])
            .compact(),
        ),
    )
}

// ---------------------------------------------------------------------------------------------------------------
// fees.schedule.get (PP-money-balance-04)

#[test]
fn blank_no_terms_published_published_false_and_no_entries() {
    let Some(db) = tdb() else { return };
    let d = door_for(&db);
    let out = call(&d, ADA, &["bank:read"], "fees.schedule.get", None).ok();
    assert_eq!(out.compact(), r#"{"published":false,"entries":[]}"#);
}

#[test]
fn zero_is_not_blank_a_published_zero_fee_is_listed_as_free_an_above_zero_fee_with_the_unwired_blocker()
 {
    let Some(db) = tdb() else { return };
    db.client()
        .batch_execute(
            "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee, published_at)
             VALUES ('USDT', 25, 100, 0, '2026-10-22T00:00:00Z'), ('IFC', 10, 50, 0.25, '2026-10-22T00:00:00Z')",
        )
        .unwrap();
    let d = door_for(&db);
    let out = call(&d, ADA, &["bank:read"], "fees.schedule.get", None).ok();
    assert_eq!(
        out.compact(),
        concat!(
            r#"{"published":true,"entries":["#,
            r#"{"assetId":"IFC","fee":"0.25","free":false,"feeBlocker":"bank.personal_transfer_fee_unwired","publishedAt":"2026-10-22T00:00:00.000Z"},"#,
            r#"{"assetId":"USDT","fee":"0","free":true,"feeBlocker":null,"publishedAt":"2026-10-22T00:00:00.000Z"}]}"#
        )
    );
}

#[test]
fn fees_schedule_requires_bank_read() {
    let Some(db) = tdb() else { return };
    let d = door_for(&db);
    let a = call(&d, ADA, &["bank:write"], "fees.schedule.get", None);
    assert_eq!(a.trpc(), "FORBIDDEN");
}

// ---------------------------------------------------------------------------------------------------------------
// ops.publishTransferTerms (PP-send-request-07): the store side the desk's call uses, and the send path's checks

fn stored(db: &TestDb) -> Vec<(String, String, String, String)> {
    db.client()
        .query(
            "SELECT asset_id, per_transfer_limit::text, daily_limit::text, fee::text FROM bank.personal_transfer_terms ORDER BY asset_id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect()
}

fn row(per: &str, daily: &str, fee: &str) -> TermsRow {
    TermsRow {
        per_transfer_limit: amt(per),
        daily_limit: amt(daily),
        fee: amt(fee),
    }
}

#[test]
fn publishes_the_figures_and_the_send_path_enforces_them() {
    let Some(db) = tdb() else { return };
    let mut c = db.client();
    let published = terms::publish(&mut c, "USDT", row("250", "1000", "0")).unwrap();
    let f = Json::Object(published.fields());
    assert_eq!(text(&f, "perTransferLimit"), "250");
    assert_eq!(text(&f, "dailyLimit"), "1000");
    assert_eq!(text(&f, "fee"), "0");
    let q = terms::quote(&mut c, ADA, "USDT", amt("10"), now())
        .unwrap()
        .json(None);
    assert_eq!(text(&q, "perTransferLimit"), "250");
    assert_eq!(text(&q, "dailyLimit"), "1000");
    assert_eq!(text(&q, "fee"), "0");
    let over = terms::assert_within_terms(&mut c, ADA, "USDT", amt("250.01"), now()).unwrap_err();
    assert_eq!(code_of(over), "bank.personal_transfer_limit_exceeded");
    terms::assert_within_terms(&mut c, ADA, "USDT", amt("250"), now()).unwrap();
}

#[test]
fn publishing_again_replaces_the_figures_for_that_asset_only() {
    let Some(db) = tdb() else { return };
    let mut c = db.client();
    terms::publish(&mut c, "USDT", row("250", "1000", "0")).unwrap();
    terms::publish(&mut c, "USDC", row("5", "5", "0")).unwrap();
    terms::publish(&mut c, "USDT", row("100", "1000", "0")).unwrap();
    let z = |n: &str| format!("{n}.000000000000000000");
    assert_eq!(
        stored(&db),
        vec![
            ("USDC".to_owned(), z("5"), z("5"), z("0")),
            ("USDT".to_owned(), z("100"), z("1000"), z("0")),
        ]
    );
}

#[test]
fn refuses_zero_or_inverted_limits_before_spending_the_approval() {
    for (per, daily) in [("0", "1000"), ("250", "0"), ("1001", "1000")] {
        let err = terms::assert_transfer_terms(amt(per), amt(daily)).unwrap_err();
        assert_eq!(code_of(err), "bank.personal_transfer_terms_invalid");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The send path's terms (personal-pay.ts `quote` and `assertWithinTerms`)

#[test]
fn a_send_refuses_while_nothing_is_published_and_while_a_fee_is_published() {
    let Some(db) = tdb() else { return };
    let mut c = db.client();
    let blank = terms::assert_within_terms(&mut c, ADA, "USDT", amt("1"), now()).unwrap_err();
    assert_eq!(code_of(blank), "bank.personal_transfer_terms_unset");
    let unset = terms::quote(&mut c, ADA, "USDT", amt("1"), now()).unwrap_err();
    assert_eq!(code_of(unset), "bank.personal_transfer_terms_unset");
    terms::publish(&mut c, "IFC", row("10", "50", "0.25")).unwrap();
    let fee = terms::assert_within_terms(&mut c, ADA, "IFC", amt("1"), now()).unwrap_err();
    assert_eq!(code_of(fee), "bank.personal_transfer_fee_unwired");
    let q = terms::quote(&mut c, ADA, "IFC", amt("1"), now())
        .unwrap()
        .json(Some(Json::Null));
    assert_eq!(
        q.compact(),
        r#"{"assetId":"IFC","amount":"1","perTransferLimit":"10","dailyLimit":"50","spentToday":"0","remainingToday":"50","fee":"0.25","feeBlocker":"bank.personal_transfer_fee_unwired","networkFee":null,"withinPerTransfer":true,"withinDaily":true}"#
    );
}

#[test]
fn the_daily_limit_counts_what_was_posted_today_and_a_fresh_reservation_and_a_quote_leaves_out_a_stale_one()
 {
    let Some(db) = tdb() else { return };
    let mut c = db.client();
    publish_usdt(&db);
    let at = now();
    let insert = |c: &mut postgres::Client, id: &str, amount: &str, status: &str, ago_ms: i64| {
        c.execute(
            "INSERT INTO bank.personal_transfers (transfer_id, ledger_tx_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status, created_at)
             VALUES ($1, CASE WHEN $5 = 'posted' THEN 'tx-' || $1 END, $2, gen_random_uuid(), $3, 'USDT', $4::text::numeric, $5,
                     timestamptz 'epoch' + $6::int8 * interval '1 millisecond')",
            &[&id, &ADA, &BOB, &amount, &status, &(at.0 - ago_ms)],
        )
        .unwrap();
    };
    let today = at.0 - terms::utc_day_start(at).0;
    // Keep every row inside today, whatever time the test runs.
    let fresh = today.min(60_000) / 2;
    let stale = if today > terms::STALE_RESERVATION_MS + 1_000 {
        Some(terms::STALE_RESERVATION_MS + 500)
    } else {
        None
    };
    insert(&mut c, "spent-posted-1", "20", "posted", fresh);
    insert(&mut c, "spent-reserved-1", "30", "reserved", fresh);
    if let Some(ago) = stale {
        insert(&mut c, "spent-stale-1", "40", "reserved", ago);
    }
    let start = terms::utc_day_start(at);
    let send_view = terms::spent_today(&mut c, ADA, "USDT", start, start).unwrap();
    assert_eq!(send_view, amt(if stale.is_some() { "90" } else { "50" }));
    let q = terms::quote(&mut c, ADA, "USDT", amt("10"), at).unwrap();
    assert_eq!(q.spent_today, amt("50"));
    assert_eq!(q.remaining_today, amt("50"));
    let over = terms::assert_within_terms(&mut c, ADA, "USDT", amt("25"), at);
    if stale.is_some() {
        assert_eq!(
            code_of(over.unwrap_err()),
            "bank.personal_transfer_daily_limit_exceeded"
        );
    } else {
        over.unwrap();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// limit-increase requests (BK-acct-04)

fn decide(
    db: &TestDb,
    id: &str,
    approve: bool,
    granted: Option<&str>,
    note: &str,
    by: &str,
) -> Result<(limits::LimitRequest, bool), Refusal> {
    limits::decide(
        &mut db.client(),
        &Decision {
            request_id: id,
            approve,
            granted: granted.map(amt),
            note,
            decider_id: by,
        },
    )
}

#[test]
fn an_approved_grant_raises_the_per_transfer_limit_for_that_customer_only_in_the_quote_and_the_send()
 {
    let Some(db) = tdb() else { return };
    publish_usdt(&db);
    let d = door_for(&db);
    let id = uuid();
    let opened = increase(&d, ADA, &id, "per_transfer", "60", REASON).ok();
    assert_eq!(text(&opened, "id"), id);
    assert_eq!(text(&opened, "status"), "open");
    assert_eq!(text(&opened, "requested"), "60");
    assert_eq!(text(&opened, "granted"), "null");
    assert_eq!(text(&opened, "replayed"), "false");
    let q = limits::queue(&mut db.client(), Some(10)).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].id, id);
    assert_eq!(text(&q[0].json_with_user(), "userId"), ADA);

    let mut c = db.client();
    let before = terms::assert_within_terms(&mut c, ADA, "USDT", amt("40"), now()).unwrap_err();
    assert_eq!(code_of(before), "bank.personal_transfer_limit_exceeded");

    let (decided, replayed) =
        decide(&db, &id, true, Some("50"), "TEST: income verified", CY).unwrap();
    assert!(!replayed);
    assert_eq!(decided.status, "approved");
    assert_eq!(decided.granted, Some(amt("50")));
    assert_eq!(decided.decided_by.as_deref(), Some(CY));
    let ada = terms::quote(&mut c, ADA, "USDT", amt("40"), now()).unwrap();
    assert_eq!(
        (
            ada.per_transfer_limit,
            ada.within_per_transfer,
            ada.daily_limit
        ),
        (amt("50"), true, amt("100"))
    );
    let bob = terms::quote(&mut c, BOB, "USDT", amt("40"), now()).unwrap();
    assert_eq!(
        (bob.per_transfer_limit, bob.within_per_transfer),
        (amt("25"), false)
    );

    terms::assert_within_terms(&mut c, ADA, "USDT", amt("40"), now()).unwrap();
    let over = terms::assert_within_terms(&mut c, ADA, "USDT", amt("51"), now()).unwrap_err();
    assert_eq!(code_of(over), "bank.personal_transfer_limit_exceeded");
    assert!(
        limits::queue(&mut db.client(), Some(10))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_decline_grants_nothing_a_replayed_decision_returns_the_first_a_different_one_conflicts() {
    let Some(db) = tdb() else { return };
    publish_usdt(&db);
    let d = door_for(&db);
    let id = uuid();
    increase(&d, ADA, &id, "daily", "500", REASON).ok();
    let granted = decide(&db, &id, false, Some("10"), "TEST: not this time", CY).unwrap_err();
    assert_eq!(code_of(granted), "bank.validation_failed");
    decide(&db, &id, false, None, "TEST: not this time", CY).unwrap();
    let (_, replayed) = decide(&db, &id, false, None, "TEST: not this time", CY).unwrap();
    assert!(replayed);
    let changed = decide(&db, &id, true, Some("500"), "TEST: changed my mind", CY).unwrap_err();
    assert_eq!(code_of(changed), "bank.limit_request_decided");
    let q = terms::quote(&mut db.client(), ADA, "USDT", amt("1"), now()).unwrap();
    assert_eq!(q.daily_limit, amt("100"));
    let mine = call(&d, ADA, RW, "limits.myRequests", Some(r#"{"limit":10}"#)).ok();
    let Json::Array(mine) = mine else { panic!() };
    assert_eq!(mine.len(), 1);
    assert_eq!(text(&mine[0], "id"), id);
    assert_eq!(text(&mine[0], "status"), "declined");
    assert!(mine[0].get("replayed").is_none());
}

#[test]
fn refuses_an_approval_with_no_granted_amount_a_short_note_a_self_decision_and_an_unknown_request()
{
    let Some(db) = tdb() else { return };
    publish_usdt(&db);
    let d = door_for(&db);
    let id = uuid();
    increase(&d, ADA, &id, "daily", "500", REASON).ok();
    let Refusal::Bank(e) = decide(&db, &id, true, None, "TEST: income verified", CY).unwrap_err()
    else {
        panic!()
    };
    assert_eq!(e.row.code, "bank.limit_grant_unset");
    assert!(e.message.contains("never defaulted"));
    assert_eq!(
        code_of(decide(&db, &id, true, Some("500"), "ok", CY).unwrap_err()),
        "bank.ops_reason_too_short"
    );
    assert_eq!(
        code_of(decide(&db, &id, true, Some("500"), "TEST: approving my own", ADA).unwrap_err()),
        "bank.limit_request_self_decision"
    );
    assert_eq!(
        code_of(decide(&db, &uuid(), false, None, "TEST: no such request", CY).unwrap_err()),
        "bank.limit_request_not_found"
    );
    let status: String = db
        .client()
        .query_one(
            "SELECT status FROM bank.limit_increase_requests WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .get(0);
    assert_eq!(status, "open");
}

#[test]
fn one_open_request_per_asset_and_kind_a_retry_replays_a_reused_id_with_other_terms_conflicts() {
    let Some(db) = tdb() else { return };
    publish_usdt(&db);
    let d = door_for(&db);
    let id = uuid();
    increase(&d, ADA, &id, "daily", "500", REASON).ok();
    assert_eq!(
        text(
            &increase(&d, ADA, &id, "daily", "500", REASON).ok(),
            "replayed"
        ),
        "true"
    );
    let other = increase(&d, ADA, &id, "daily", "600", REASON);
    assert_eq!(
        (other.trpc(), other.code()),
        (
            "CONFLICT".to_owned(),
            "bank.limit_request_conflict".to_owned()
        )
    );
    let open = increase(&d, ADA, &uuid(), "daily", "500", REASON);
    assert_eq!(open.trpc(), "CONFLICT");
    assert!(
        open.message().contains("already open"),
        "{}",
        open.message()
    );
    // A different kind is its own request.
    increase(&d, ADA, &uuid(), "per_transfer", "500", REASON).ok();
}

#[test]
fn a_retry_racing_its_first_call_replays_the_one_row_a_new_id_racing_it_for_the_same_open_slot_refuses_open()
 {
    let Some(db) = tdb() else { return };
    publish_usdt(&db);
    let race = |ids: Vec<String>| -> Vec<Result<(limits::LimitRequest, bool), Refusal>> {
        let barrier = std::sync::Barrier::new(ids.len());
        std::thread::scope(|s| {
            let handles: Vec<_> = ids
                .iter()
                .map(|id| {
                    let mut c = db.client();
                    let barrier = &barrier;
                    s.spawn(move || {
                        barrier.wait();
                        limits::request(
                            &mut c,
                            ADA,
                            &Ask {
                                request_id: id,
                                asset_id: "USDT",
                                kind: "daily",
                                requested: amt("500"),
                                reason: REASON,
                            },
                        )
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        })
    };
    for _ in 0..20 {
        db.client()
            .batch_execute("TRUNCATE bank.limit_increase_requests")
            .unwrap();
        let id = uuid();
        let results = race(vec![id.clone(); 6]);
        let values: Vec<_> = results.into_iter().map(|r| r.unwrap()).collect();
        assert!(values.iter().all(|(r, _)| r.id == id));
        assert_eq!(values.iter().filter(|(_, replayed)| !replayed).count(), 1);
        assert_eq!(
            db.count("SELECT count(*) FROM bank.limit_increase_requests"),
            1
        );
    }
    // Different ids for the same open slot: exactly one opens, every other refuses as already open.
    db.client()
        .batch_execute("TRUNCATE bank.limit_increase_requests")
        .unwrap();
    let results = race((0..6).map(|_| uuid()).collect());
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    for r in results.into_iter().filter_map(Result::err) {
        assert_eq!(code_of(r), "bank.limit_request_open");
    }
}

#[test]
fn refuses_a_short_reason_a_zero_amount_an_asset_with_no_published_limits_a_missing_page_size_and_the_wrong_scopes()
 {
    let Some(db) = tdb() else { return };
    let d = door_for(&db);
    let unset = increase(&d, ADA, &uuid(), "daily", "500", REASON);
    assert!(
        unset
            .message()
            .contains("bank.personal_transfer_terms_unset"),
        "{}",
        unset.message()
    );
    publish_usdt(&db);
    let short = increase(&d, ADA, &uuid(), "daily", "500", "short");
    assert_eq!(
        (short.trpc(), short.code()),
        (
            "BAD_REQUEST".to_owned(),
            "bank.limit_request_reason_too_short".to_owned()
        )
    );
    let zero = increase(&d, ADA, &uuid(), "daily", "0", REASON);
    assert_eq!(zero.trpc(), "BAD_REQUEST");
    let page = call(&d, ADA, RW, "limits.myRequests", Some("{}"));
    assert_eq!(
        (page.trpc(), page.code()),
        (
            "BAD_REQUEST".to_owned(),
            "bank.limit_request_list_limit_unset".to_owned()
        )
    );
    assert_eq!(
        code_of(limits::queue(&mut db.client(), None).unwrap_err()),
        "bank.limit_request_list_limit_unset"
    );
    let read_only = call(
        &d,
        ADA,
        &["bank:read"],
        "limits.requestIncrease",
        Some(
            &Json::obj([
                ("requestId", Json::str(uuid())),
                ("assetId", Json::str("USDT")),
                ("kind", Json::str("daily")),
                ("requested", Json::str("500")),
                ("reason", Json::str(REASON)),
            ])
            .compact(),
        ),
    );
    assert_eq!(read_only.trpc(), "FORBIDDEN");
    assert_eq!(
        db.count("SELECT count(*) FROM bank.limit_increase_requests"),
        0
    );
}
