//! svc-identity's closure check through the Rust door against a real Postgres: the checks of the TypeScript's
//! `closure/closure-check.pg.test.ts`, each test named after its words. Balances come from a memory svc-ledger; a
//! failed read is 503. TEST data only. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it
//! fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;

use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner_account::recovery::ledger::{
    AccountRef, Balance, BankTransfer, Ledger, PostError,
};
use svc_bank::partner_account::{Wiring, closure};

use support::TestDb;

const SECRET: &str = "a-bank-closure-check-edge-secret-long-0";
const INTERNAL: &str = "bank-closure-check-secret-at-least-32-characters";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const SUB: &str = "33333333-3333-4333-8333-333333333333";
const SUB_UNLISTED: &str = "55555555-5555-4555-8555-555555555555";

/// svc-ledger's balances per owner, as a test sets them; `None` is a ledger that is down.
/// One balance: owner type, owner id, asset, kind, purpose, amount.
type Row = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    &'static str,
);

struct Balances(Option<Vec<Row>>);

impl Ledger for Balances {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<Balance>, String> {
        let rows = self.0.as_ref().ok_or_else(|| "ledger down".to_owned())?;
        Ok(rows
            .iter()
            .filter(|r| r.0 == owner_type && r.1 == owner_id)
            .map(|r| Balance {
                account: AccountRef {
                    owner_type: r.0.into(),
                    owner_id: r.1.into(),
                    asset_id: r.2.into(),
                    kind: r.3.into(),
                    purpose: r.4.map(str::to_owned),
                },
                amount: parse_amount(r.5).unwrap(),
            })
            .collect())
    }
    fn posts(&self) -> bool {
        false
    }
    fn bank_transfer(&self, _: &BankTransfer) -> Result<String, PostError> {
        Err(PostError::Other("the closure check never posts".into()))
    }
}

fn env() -> BTreeMap<String, String> {
    [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn door_on(store: Store, ledger: Balances) -> BankDoor {
    let mut wiring = Wiring::from_env(&env()).unwrap();
    wiring.closure = closure::Wiring {
        ledger: Box::new(ledger),
    };
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env: env(),
        now: door::system_now,
        store,
    })
    .unwrap()
    .with_partner_account(wiring)
}

/// `registerClosureCheck(app, { sql, ledger: new MemoryLedger(), secret })`.
fn door_with(db: &TestDb, ledger: Balances) -> BankDoor {
    door_on(db.store(), ledger)
}

fn empty() -> Balances {
    Balances(Some(Vec::new()))
}

fn post_raw(b: &BankDoor, raw: &str, signer: Option<(&str, &str)>) -> (u16, Json) {
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some((service, secret)) = signer {
        headers.extend(s2s::legacy_headers(service, secret, raw, system_seconds()).unwrap());
    }
    let res = b.handle_from(
        &Request {
            method: "POST",
            url: "/internal/closure-check",
            headers: &headers,
            body: raw,
        },
        "req-closure-check",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap_or(Json::Null))
}

/// `post(body)`: signed as svc-identity.
fn post(b: &BankDoor, body: &str) -> (u16, Json) {
    post_raw(b, body, Some(("svc-identity", INTERNAL)))
}

fn body(user: &str, subs: &[&str], scope: Option<&str>) -> String {
    let mut f = vec![
        ("userId".to_owned(), Json::str(user)),
        (
            "subAccountIds".to_owned(),
            Json::Array(subs.iter().map(|s| Json::str(*s)).collect()),
        ),
    ];
    if let Some(s) = scope {
        f.push(("scope".to_owned(), Json::str(s)));
    }
    Json::Object(f).compact()
}

/// `codes(userId, subAccountIds)`: 200 and its answer.
fn codes(b: &BankDoor, user: &str, subs: &[&str]) -> Json {
    let answer = post(b, &body(user, subs, None));
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer.1
}

fn blockers(answer: &Json) -> String {
    answer.get("blockers").unwrap().compact()
}

fn blocker_codes(answer: &Json) -> Vec<String> {
    let Some(Json::Array(rows)) = answer.get("blockers") else {
        panic!("no blockers: {}", answer.compact())
    };
    rows.iter()
        .map(|r| match r.get("code") {
            Some(Json::String(c)) => c.clone(),
            _ => panic!(),
        })
        .collect()
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

fn loan_product(db: &TestDb, name: &str) -> String {
    db.client()
        .query_one(
            "INSERT INTO bank.loan_products (name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, \
               max_ltv_bps, margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps, \
               penalty_bps, max_tranche_bps, grace_seconds) \
             VALUES ($1, 'USDT', 'BTC', 'USDT', 100, 5000, 6000, 7000, 8000, 4000, 100, 1000, 60) RETURNING id::text",
            &[&name],
        )
        .unwrap()
        .get(0)
}

fn loan(db: &TestDb, product: &str, user: &str) -> String {
    db.client()
        .query_one(
            "INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal) \
             VALUES ($1::text::uuid, $2, 'USDT', 'BTC', 'USDT', 100, '1') RETURNING id::text",
            &[&product, &user],
        )
        .unwrap()
        .get(0)
}

fn card(db: &TestDb, owner: &str, reference: &str) -> String {
    db.client()
        .query_one(
            "INSERT INTO bank.cards (user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit) \
             VALUES ($1, 'USDT', 'USDT', 'card-sim', $2, '4242', '10') RETURNING id::text",
            &[&owner, &reference],
        )
        .unwrap()
        .get(0)
}

fn exec(db: &TestDb, sql: &str, id: &str) {
    db.client().execute(sql, &[&id]).unwrap();
}

#[test]
fn refuses_a_missing_or_bad_signature_with_401() {
    let Some(db) = db() else { return };
    let b = door_with(&db, empty());
    let raw = body(USER, &[], None);
    assert_eq!(post_raw(&b, &raw, None).0, 401);
    assert_eq!(
        post_raw(
            &b,
            &raw,
            Some(("svc-identity", "wrong-secret-that-is-long-enough-for-hmac"))
        )
        .0,
        401
    );
}

#[test]
fn returns_an_empty_list_when_the_user_has_nothing_open() {
    let Some(db) = db() else { return };
    let answer = codes(&door_with(&db, empty()), USER, &[]);
    assert_eq!(blockers(&answer), "[]");
    assert_eq!(answer.get("balances").unwrap().compact(), "[]");
}

#[test]
fn blocks_on_a_dust_balance_and_on_a_sub_account_hold_and_ignores_another_user() {
    let Some(db) = db() else { return };
    let dust = door_with(
        &db,
        Balances(Some(vec![
            (
                "user",
                USER,
                "USDT",
                "available",
                None,
                "0.000000000000000001",
            ),
            ("user", OTHER, "BTC", "available", None, "2"),
        ])),
    );
    let answer = codes(&dust, USER, &[]);
    assert_eq!(
        blockers(&answer),
        r#"[{"code":"balance_remaining","count":1}]"#
    );
    assert_eq!(
        answer.get("balances").unwrap().compact(),
        r#"[{"assetId":"USDT","amount":"0.000000000000000001"}]"#
    );

    let hold = door_with(
        &db,
        Balances(Some(vec![(
            "subaccount",
            SUB,
            "ETH",
            "hold",
            Some("order:1"),
            "0.000000000000000001",
        )])),
    );
    let answer = codes(&hold, USER, &[SUB]);
    assert_eq!(
        blockers(&answer),
        r#"[{"code":"balance_remaining","count":1}]"#
    );
    assert_eq!(
        answer.get("balances").unwrap().compact(),
        r#"[{"assetId":"ETH","amount":"0.000000000000000001"}]"#
    );
}

#[test]
fn detects_each_bank_blocker_and_clears_it_when_the_row_closes() {
    let Some(db) = db() else { return };
    let b = door_with(&db, empty());
    let has = |code: &str| blocker_codes(&codes(&b, USER, &[])).contains(&code.to_owned());

    let product = loan_product(&db, "closure");
    let l = loan(&db, &product, USER);
    assert!(has("open_loan"));
    exec(
        &db,
        "UPDATE bank.loans SET status = 'repaid' WHERE id = $1::text::uuid",
        &l,
    );
    assert!(!has("open_loan"));

    let c = card(&db, USER, "ref-1");
    assert!(has("active_card"));
    exec(
        &db,
        "UPDATE bank.cards SET status = 'closed' WHERE id = $1::text::uuid",
        &c,
    );
    assert!(!has("active_card"));

    let mut client = db.client();
    let space = |name: &str| -> String {
        db.client()
            .query_one(
                "INSERT INTO bank.spaces (user_id, asset_id, name) VALUES ($1, 'USDT', $2) RETURNING id::text",
                &[&USER, &name],
            )
            .unwrap()
            .get(0)
    };
    let (from, to) = (space("from"), space("to"));
    let schedule: String = client
        .query_one(
            "INSERT INTO bank.scheduled_transfers (user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, next_run_at) \
             VALUES ($1, 'USDT', $2::text::uuid, $3::text::uuid, '1', 'daily', now(), now()) RETURNING id::text",
            &[&USER, &from, &to],
        )
        .unwrap()
        .get(0);
    assert!(has("active_schedule"));
    exec(
        &db,
        "UPDATE bank.scheduled_transfers SET status = 'cancelled' WHERE id = $1::text::uuid",
        &schedule,
    );
    assert!(!has("active_schedule"));

    let ramp: String = client
        .query_one(
            "INSERT INTO bank.ramp_onramps (user_id, asset_id, amount, rail, rail_ref, credited_by) \
             VALUES ($1, 'USDT', '1', 'test', 'rail-1', 'test') RETURNING id::text",
            &[&USER],
        )
        .unwrap()
        .get(0);
    assert!(has("pending_ramp"));
    exec(
        &db,
        "UPDATE bank.ramp_onramps SET status = 'settled', ledger_tx_id = 'tx-closure' WHERE id = $1::text::uuid",
        &ramp,
    );
    assert!(!has("pending_ramp"));

    let pool: String = client
        .query_one(
            "INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps) VALUES ('USDT', 'flexible', 'closure', 100) RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    let position: String = client
        .query_one(
            "INSERT INTO bank.earn_positions (pool_id, user_id, asset_id, principal, status) \
             VALUES ($1::text::uuid, $2, 'USDT', '1', 'active') RETURNING id::text",
            &[&pool, &USER],
        )
        .unwrap()
        .get(0);
    assert!(has("earn_position"));
    exec(
        &db,
        "UPDATE bank.earn_positions SET status = 'closed' WHERE id = $1::text::uuid",
        &position,
    );
    assert!(!has("earn_position"));
}

#[test]
fn does_not_count_another_user() {
    let Some(db) = db() else { return };
    let product = loan_product(&db, "other");
    loan(&db, &product, OTHER);
    assert_eq!(blockers(&codes(&door_with(&db, empty()), USER, &[])), "[]");
}

#[test]
fn answers_503_when_the_ledger_or_the_database_fails_never_an_empty_list() {
    let Some(db) = db() else { return };
    let raw = body(USER, &[], None);
    let ledger_down = post(&door_with(&db, Balances(None)), &raw);
    assert_eq!(ledger_down.0, 503);
    assert!(ledger_down.1.get("blockers").is_none());
    assert_eq!(
        ledger_down.1.compact(),
        r#"{"error":"closure check unavailable","code":"bank.closure_check_unavailable"}"#
    );

    let db_down = post(
        &door_on(Store::Down("TEST the database is down".to_owned()), empty()),
        &raw,
    );
    assert_eq!(db_down.0, 503);
    assert!(db_down.1.get("blockers").is_none());
}

fn uuid_n(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

#[test]
fn refuses_a_request_from_a_signed_service_that_is_not_identity_with_403() {
    let Some(db) = db() else { return };
    let answer = post_raw(
        &door_with(&db, empty()),
        &body(USER, &[], None),
        Some(("svc-pay", INTERNAL)),
    );
    assert_eq!(answer.0, 403);
    assert!(answer.1.get("blockers").is_none());
}

#[test]
fn accepts_100_sub_account_ids_and_refuses_101_with_400() {
    let Some(db) = db() else { return };
    let b = door_with(&db, empty());
    let hundred: Vec<String> = (1..=100).map(uuid_n).collect();
    let refs: Vec<&str> = hundred.iter().map(String::as_str).collect();
    assert_eq!(post(&b, &body(USER, &refs, None)).0, 200);
    let mut more = refs.clone();
    let extra = uuid_n(101);
    more.push(&extra);
    let too_many = post(&b, &body(USER, &more, None));
    assert_eq!(too_many.0, 400);
    assert_eq!(
        too_many.1.get("code"),
        Some(&Json::str("bank.closure_check_input"))
    );
}

#[test]
fn refuses_a_malformed_body_with_400_and_never_an_empty_blocker_list() {
    let Some(db) = db() else { return };
    let b = door_with(&db, empty());
    let user = format!("\"{USER}\"");
    for raw in [
        "null".to_owned(),
        "[]".to_owned(),
        "{}".to_owned(),
        format!(r#"{{"userId":{user}}}"#),
        r#"{"subAccountIds":[]}"#.to_owned(),
        r#"{"userId":"not-a-uuid","subAccountIds":[]}"#.to_owned(),
        format!(r#"{{"userId":{user},"subAccountIds":"nope"}}"#),
        format!(r#"{{"userId":{user},"subAccountIds":["not-a-uuid"]}}"#),
        format!(r#"{{"userId":{user},"subAccountIds":[42]}}"#),
        r#"{"userId":42,"subAccountIds":[]}"#.to_owned(),
    ] {
        let answer = post(&b, &raw);
        assert_eq!(answer.0, 400, "{raw}");
        assert_eq!(
            answer.1.get("code"),
            Some(&Json::str("bank.closure_check_input")),
            "{raw}"
        );
        assert!(answer.1.get("blockers").is_none(), "{raw}");
    }
}

#[test]
fn counts_rows_on_a_listed_sub_account_and_ignores_an_unlisted_one() {
    let Some(db) = db() else { return };
    let b = door_with(&db, empty());
    // Only an unlisted sub-account has an open card: nothing may appear.
    card(&db, SUB_UNLISTED, "ref-unlisted");
    assert_eq!(blockers(&codes(&b, USER, &[SUB])), "[]");
    // The listed sub-account's card blocks; the unlisted one still does not add to the count.
    card(&db, SUB, "ref-listed");
    assert_eq!(
        blockers(&codes(&b, USER, &[SUB])),
        r#"[{"code":"active_card","count":1}]"#
    );
    // Not listed: neither card is seen.
    assert_eq!(blockers(&codes(&b, USER, &[])), "[]");
}

#[test]
fn scope_sub_accounts_ignores_a_main_account_card_and_counts_the_named_sub_account_card() {
    let Some(db) = db() else { return };
    let b = door_with(&db, empty());
    card(&db, USER, "ref-main");
    let sub = || {
        let answer = post(&b, &body(USER, &[SUB], Some("sub_accounts")));
        assert_eq!(answer.0, 200, "{}", answer.1.compact());
        blockers(&answer.1)
    };
    assert_eq!(sub(), "[]");
    card(&db, SUB, "ref-sub");
    assert_eq!(sub(), r#"[{"code":"active_card","count":1}]"#);
    // Without the scope the main account's card still counts too.
    assert_eq!(
        blockers(&codes(&b, USER, &[SUB])),
        r#"[{"code":"active_card","count":2}]"#
    );
}

#[test]
fn scope_sub_accounts_does_not_read_the_main_account_balance() {
    let Some(db) = db() else { return };
    let b = door_with(
        &db,
        Balances(Some(vec![("user", USER, "BTC", "available", None, "1")])),
    );
    let answer = post(&b, &body(USER, &[SUB], Some("sub_accounts")));
    assert_eq!(answer.0, 200);
    assert_eq!(blockers(&answer.1), "[]");
    assert_eq!(answer.1.get("balances").unwrap().compact(), "[]");
}

#[test]
fn scope_sub_accounts_refuses_a_sub_account_question_that_names_no_sub_account_and_an_unknown_scope()
 {
    let Some(db) = db() else { return };
    let b = door_with(&db, empty());
    for raw in [
        body(USER, &[], Some("sub_accounts")),
        body(USER, &[USER], Some("sub_accounts")),
        body(USER, &[SUB], Some("everything")),
    ] {
        let answer = post(&b, &raw);
        assert_eq!(answer.0, 400, "{raw}");
        assert!(answer.1.get("blockers").is_none(), "{raw}");
    }
}
