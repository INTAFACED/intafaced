//! Part `work_items` of slice `activity` against the Rust door on a real Postgres: the checks of the TypeScript's
//! `home/work-items.db.test.ts`, each test named after the TypeScript test's words. `workItems.list` is called through
//! the door as the signed person; loans, margin calls and cards are TEST fixtures written straight to the bank's tables,
//! with the TypeScript's own inserts.
//!
//! Not ported:
//! - "basis points read as the contract's ratio" is a pure check: it is `bps_ratio`'s unit test in
//!   `src/activity/work_items.rs`.
//! - the contract's own parse (`workItemsOutputSchema.safeParse`, `ownsAll`) runs the TypeScript contract's zod schema;
//!   here each item's fields are held to their exact values instead, which the contract's rules (kind owned by `bank`,
//!   id `<kind>:<record>`, link under `/bank`) follow from.
//! - `home/margin-warning-level.test.ts` (`readMarginWarningLevel`) is the environment's check, held by `src/env.rs`
//!   and `tests/env_parity.rs`, not by this call.
//!
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};

use support::TestDb;

const SECRET: &str = "bank-work-items-edge-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";

struct Bank {
    door: BankDoor,
    db: TestDb,
    product: String,
}

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let door = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth::unwired(),
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap();
    let product: String = db
        .client()
        .query_one(
            "INSERT INTO bank.loan_products (
               name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps, margin_call_ltv_bps,
               liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps, penalty_bps, max_tranche_bps, grace_seconds
             ) VALUES ('TEST loan', 'USDT', 'BTC', 'USDT', 800, 5000, 7500, 8500, 9500, 4000, 500, 5000, 86400)
             RETURNING id::text",
            &[],
        )
        .unwrap()
        .get(0);
    Some(Bank { door, db, product })
}

impl Bank {
    fn loan(&self, user: &str, status: &str) -> String {
        self.db
            .client()
            .query_one(
                "INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal, status)
                 VALUES ($1::text::uuid, $2, 'USDT', 'BTC', 'USDT', 800, '1000', $3::text::bank.loan_status)
                 RETURNING id::text",
                &[&self.product, &user, &status],
            )
            .unwrap()
            .get(0)
    }

    fn call(
        &self,
        loan: &str,
        sequence: i32,
        ltv_bps: i32,
        cure: &str,
        grace_hours: i32,
        cleared: bool,
    ) {
        self.db
            .client()
            .execute(
                "INSERT INTO bank.loan_margin_calls (loan_id, sequence, ltv_bps, cure_collateral_amount, grace_expires_at, cleared_at)
                 VALUES ($1::text::uuid, $2, $3, $4::text::numeric, now() + make_interval(hours => $5),
                         CASE WHEN $6 THEN now() END)",
                &[&loan, &sequence, &ltv_bps, &cure, &grace_hours, &cleared],
            )
            .unwrap();
    }

    fn card(&self, user: &str, status: &str, frozen_by: Option<&str>) -> String {
        let issuer_ref = format!("TEST-{}", service_kit::approvals::random_uuid().unwrap());
        self.db
            .client()
            .query_one(
                "INSERT INTO bank.cards (user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit, status, frozen_by)
                 VALUES ($1, 'USDT', 'USDT', 'card-sim', $2, '4242', '100', $3::text::bank.card_status, $4)
                 RETURNING id::text",
                &[&user, &issuer_ref, &status, &frozen_by],
            )
            .unwrap()
            .get(0)
    }

    /// `workItems.list` as the person, optionally on an API key or a sub-account: the status and the body.
    fn list_as(&self, user: &str, delegated: Option<(&str, &str)>) -> (u16, Json) {
        let mut fields = vec![
            ("sub".to_owned(), Json::str(user)),
            (
                "scopes".to_owned(),
                Json::Array(vec![Json::str("bank:read")]),
            ),
            ("tier".to_owned(), Json::str("full")),
            ("mfa".to_owned(), Json::Bool(true)),
            (
                "sid".to_owned(),
                Json::str(service_kit::approvals::random_uuid().unwrap()),
            ),
            ("userId".to_owned(), Json::str(user)),
            (
                "expiresAt".to_owned(),
                Json::str("2099-01-01T00:00:00.000Z"),
            ),
        ];
        if let Some((k, v)) = delegated {
            fields.push((k.to_owned(), Json::str(v)));
        }
        let raw = Json::Object(fields).compact();
        let sig = edge::sign(&raw, SECRET, "DE").unwrap();
        let headers = vec![
            ("x-intafaced-principal".to_owned(), raw),
            ("x-intafaced-principal-sig".to_owned(), sig),
            ("x-intafaced-region".to_owned(), "DE".to_owned()),
        ];
        let res = self.door.handle_from(
            &Request {
                method: "GET",
                url: "/trpc/workItems.list",
                headers: &headers,
                body: "",
            },
            "req-work-items-db",
            "127.0.0.1",
        );
        (res.status, json::parse(&res.body).unwrap())
    }

    fn items(&self, user: &str) -> Vec<Json> {
        let (status, body) = self.list_as(user, None);
        assert_eq!(status, 200, "{}", body.compact());
        match body
            .get("result")
            .and_then(|r| r.get("data"))
            .and_then(|d| d.get("items"))
        {
            Some(Json::Array(a)) => a.clone(),
            other => panic!("{other:?}"),
        }
    }

    fn grace_of(&self, loan: &str, sequence: i32) -> String {
        let ms: i64 = self
            .db
            .client()
            .query_one(
                "SELECT floor(extract(epoch from grace_expires_at) * 1000)::int8 FROM bank.loan_margin_calls \
                 WHERE loan_id = $1::text::uuid AND sequence = $2",
                &[&loan, &sequence],
            )
            .unwrap()
            .get(0);
        service_kit::time::Instant(ms).iso()
    }
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(other) => other.compact(),
        None => "absent".to_owned(),
    }
}

#[test]
fn nothing_owed_is_an_empty_list() {
    let Some(b) = bank() else { return };
    b.loan(ADA, "active");
    b.card(ADA, "active", None);
    let (status, body) = b.list_as(ADA, None);
    assert_eq!(
        (status, body.compact()),
        (200, r#"{"result":{"data":{"items":[]}}}"#.to_owned())
    );
}

#[test]
fn a_loan_in_a_margin_call_is_the_borrowers_to_cure_due_when_the_grace_ends_with_the_collateral_and_the_calls_ltv()
 {
    let Some(b) = bank() else { return };
    let id = b.loan(ADA, "margin_call");
    b.call(&id, 1, 7600, "0.5", 2, true);
    b.call(&id, 2, 7812, "0.125000000000000000", 6, false);
    let items = b.items(ADA);
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].compact(),
        Json::obj([
            ("id", Json::str(format!("margin_health:{id}"))),
            ("kind", Json::str("margin_health")),
            ("source", Json::str("bank")),
            ("severity", Json::str("action")),
            ("titleKey", Json::str("bank.margin.call_open")),
            ("link", Json::str("/bank/loans")),
            ("dueAt", Json::str(b.grace_of(&id, 2))),
            (
                "amount",
                Json::obj([("value", Json::str("0.125")), ("asset", Json::str("BTC"))])
            ),
            ("ratio", Json::str("0.7812")),
        ])
        .compact()
    );
}

#[test]
fn a_liquidating_loan_is_a_warning_a_cleared_call_a_repaid_loan_or_an_active_loan_with_no_call_is_nothing()
 {
    let Some(b) = bank() else { return };
    let liquidating = b.loan(ADA, "liquidating");
    b.call(&liquidating, 1, 8600, "1", 1, false);
    b.loan(ADA, "active");
    let cured = b.loan(ADA, "active");
    b.call(&cured, 1, 7600, "0.2", 1, true);
    let repaid = b.loan(ADA, "repaid");
    b.call(&repaid, 1, 7600, "0.2", 1, false);
    assert_eq!(
        b.items(ADA)
            .iter()
            .map(|i| (s(i, "id"), s(i, "severity"), s(i, "titleKey")))
            .collect::<Vec<_>>(),
        [(
            format!("margin_health:{liquidating}"),
            "warning".to_owned(),
            "bank.margin.liquidating".to_owned()
        )]
    );
}

#[test]
fn an_open_call_whose_loan_status_has_not_moved_yet_is_still_the_borrowers_to_cure() {
    let Some(b) = bank() else { return };
    let id = b.loan(ADA, "active");
    b.call(&id, 1, 7600, "0.2", 3, false);
    assert_eq!(
        b.items(ADA)
            .iter()
            .map(|i| (s(i, "id"), s(i, "severity")))
            .collect::<Vec<_>>(),
        [(format!("margin_health:{id}"), "action".to_owned())]
    );
}

#[test]
fn a_frozen_card_frozen_by_them_is_theirs_to_lift_frozen_by_the_bank_they_wait_closed_and_active_cards_are_nothing()
 {
    let Some(b) = bank() else { return };
    let mine = b.card(ADA, "frozen", Some("owner"));
    let banks = b.card(ADA, "frozen", Some("operator"));
    let unrecorded = b.card(ADA, "frozen", None);
    b.card(ADA, "closed", None);
    b.card(ADA, "active", None);
    let card = |id: &str, severity: &str, title: &str, reason: Option<&str>| {
        let mut f = vec![
            ("id".to_owned(), Json::str(format!("card_frozen:{id}"))),
            ("kind".to_owned(), Json::str("card_frozen")),
            ("source".to_owned(), Json::str("bank")),
            ("severity".to_owned(), Json::str(severity)),
            ("titleKey".to_owned(), Json::str(title)),
            ("link".to_owned(), Json::str("/bank/cards")),
        ];
        if let Some(r) = reason {
            f.push(("reasonCode".to_owned(), Json::str(r)));
        }
        Json::Object(f).compact()
    };
    assert_eq!(
        b.items(ADA).iter().map(Json::compact).collect::<Vec<_>>(),
        [
            card(
                &mine,
                "action",
                "bank.card.frozen_by_you",
                Some("bank.card_frozen_by_owner")
            ),
            card(
                &banks,
                "info",
                "bank.card.frozen_by_bank",
                Some("bank.card_frozen_by_operator")
            ),
            // Frozen before the bank recorded who froze it: the owner may lift it, so it is theirs, with no reason invented.
            card(&unrecorded, "action", "bank.card.frozen", None),
        ]
    );
}

#[test]
fn only_the_signed_persons_own_records_only_bank_kinds_never_a_loan_payment_and_the_answer_parses_as_the_contract()
 {
    let Some(b) = bank() else { return };
    let bobs = b.loan(BOB, "margin_call");
    b.call(&bobs, 1, 7600, "0.3", 3, false);
    b.card(BOB, "frozen", Some("owner"));
    let adas = b.loan(ADA, "margin_call");
    b.call(&adas, 1, 7700, "0.4", 4, false);
    b.card(ADA, "frozen", Some("operator"));

    let ada = b.items(ADA);
    for item in &ada {
        // The contract's rules: a bank kind answered by the bank, its id `<kind>:<record>`, a link in the bank's room.
        assert_eq!(s(item, "source"), "bank");
        assert!(s(item, "id").starts_with(&format!("{}:", s(item, "kind"))));
        assert!(s(item, "link").starts_with("/bank/"));
    }
    let mut kinds: Vec<String> = ada.iter().map(|i| s(i, "kind")).collect();
    kinds.sort();
    assert_eq!(kinds, ["card_frozen", "margin_health"]);
    assert!(!ada.iter().any(|i| s(i, "id").contains(&bobs)));
    assert!(!ada.iter().any(|i| s(i, "kind") == "loan_payment_due"));
    let mut theirs: Vec<String> = b.items(BOB).iter().map(|i| s(i, "kind")).collect();
    theirs.sort();
    assert_eq!(theirs, ["card_frozen", "margin_health"]);
}

#[test]
fn an_api_key_or_a_sub_account_has_no_home_of_its_own_refused_and_nothing_of_the_owners_is_read_out()
 {
    let Some(b) = bank() else { return };
    b.card(ADA, "frozen", Some("owner"));
    for delegated in [
        ("kid", "TEST-api-key"),
        ("sub_account", "33333333-3333-4333-8333-333333333333"),
    ] {
        let (status, body) = b.list_as(ADA, Some(delegated));
        let err = body.get("error").unwrap();
        assert_eq!(status, 403, "{}", body.compact());
        assert_eq!(
            s(err.get("data").unwrap(), "code"),
            "FORBIDDEN",
            "{}",
            body.compact()
        );
        assert!(s(err, "message").contains("bank.work_items_delegated"));
        assert!(!body.compact().contains("card_frozen"));
    }
    assert_eq!(b.items(ADA).len(), 1);
}

#[test]
fn a_margin_warning_level_is_never_assumed_an_active_loan_near_its_call_band_with_no_call_lists_nothing()
 {
    let Some(b) = bank() else { return };
    let id = b.loan(ADA, "active");
    b.db.client()
        .execute(
            "UPDATE bank.loans SET margin_call_ltv_bps = 7500, last_mark_price = '1', last_marked_at = now() WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    assert!(b.items(ADA).is_empty());
}
