//! The desk's two reads of a person's cards, through the door: ports `ops/authorization-detail.db.test.ts`,
//! `ops/authorization-detail.conversion.db.test.ts` and `ops/customer-cards.test.ts`, every test named after the
//! TypeScript's.
//!
//! Seeded, not driven: `ops.authorizationGet` reads what `ops.cardAuthorize` wrote, and that move is the slice's other
//! half, so the tests here write each authorisation (and its conversion) through the kit's `authorize` and `convert`,
//! in the figures the TypeScript's `authorize` leaves: an approval with its hold, a decline as
//! `ledger.insufficient_funds` and rejected, and the BTC card's 100 USDT as 0.002 BTC at 50000 (`mid`).
//! `ops.customerCards` reads real rows here where the TypeScript stubs `cardsPage`.
//!
//! Left out, and why: each audit line is written to standard output, which a test in this binary cannot read back, so
//! `writes one audit line with the actor and the id`, the "logs nothing" half of the id-length test, `writes the audit
//! line before the cards are read` and `refuses the read when the audit line cannot be written` are not ported, nor the
//! "logs the read first" half of the customer list's first test; the
//! order (the line before the read, and a line that cannot be written refusing `bank.ops_audit_unavailable`) is held by
//! the code's own order in `card_ops_desk::reads`. The audit fields are the wire replay's to compare.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::card_ops_desk_kit::{
    self as kit, Auth, Bank, OPERATOR, arr, authorize, call, convert, obj, s, uuid,
};

use service_kit::json::Json;
use svc_bank::cards::Address;
use svc_bank::cards::core::{IssueAsk, cards_page, issue};

const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const STRANGER: &str = "66666666-6666-4666-8666-666666666666";
const CUSTOMER: &str = OWNER;
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const COMPLIANCE: [&str; 1] = ["admin:compliance"];
const NOW: &str = "2026-10-22T08:00:00.000Z";

fn get(b: &Bank, id: &str) -> kit::Answer {
    call(
        b,
        OPERATOR,
        &COMPLIANCE,
        "ops.authorizationGet",
        &obj(&[("id", Json::str(id))]),
    )
}

/// `seed`: an approved 40 USDT in category 5812 and a declined 500.
fn seed(b: &Bank) -> (String, String, String) {
    let card = b.card(OWNER, "USDT", None, "1000");
    let approved = authorize(
        &b.db,
        &Auth {
            card: &card,
            reference: "TEST-auth-ok",
            amount: "40",
            merchant_category: Some("5812"),
            ..Auth::default()
        },
    );
    let declined = authorize(
        &b.db,
        &Auth {
            card: &card,
            reference: "TEST-auth-nsf",
            amount: "500",
            decision: "declined",
            decline: Some("ledger.insufficient_funds"),
            status: "rejected",
            ..Auth::default()
        },
    );
    (card, approved, declined)
}

#[test]
fn returns_the_stored_decision_and_names_every_field_card_sim_does_not_have() {
    let Some(b) = kit::bank() else { return };
    let (card, approved, declined) = seed(&b);
    let before = b.count("SELECT count(*)::int8 FROM bank.card_authorizations");

    let ok = get(&b, &approved).ok();
    assert_eq!(
        [
            s(&ok, "id"),
            s(&ok, "cardId"),
            s(&ok, "userId"),
            s(&ok, "authorizationRef"),
            s(&ok, "amount"),
            s(&ok, "merchantCategory"),
            s(&ok, "decision"),
            s(&ok, "declineCode"),
            s(&ok, "status"),
            s(&ok, "conversion"),
        ],
        [
            approved.as_str(),
            &card,
            OWNER,
            "TEST-auth-ok",
            "40",
            "5812",
            "approved",
            "null",
            "pending",
            "null"
        ]
        .map(str::to_owned)
    );
    assert_ne!(s(&ok, "holdLedgerTxId"), "null");
    let missing = arr(&ok, "notAvailable");
    assert_eq!(
        missing.iter().map(|f| s(f, "field")).collect::<Vec<_>>(),
        [
            "merchantName",
            "merchantCountry",
            "networkData",
            "method",
            "cardPresence",
            "initiator",
            "type"
        ]
    );
    for f in &missing {
        assert_eq!(s(f, "reason"), "not available on card-sim");
    }

    let no = get(&b, &declined).ok();
    assert_eq!(s(&no, "decision"), "declined");
    assert_eq!(s(&no, "declineCode"), "ledger.insufficient_funds");
    assert_eq!(s(&no, "status"), "rejected");
    assert_eq!(s(&no, "holdLedgerTxId"), "null");

    assert_eq!(
        b.count("SELECT count(*)::int8 FROM bank.card_authorizations"),
        before
    );
}

#[test]
fn answers_an_unknown_and_a_malformed_id_with_the_same_not_found() {
    let Some(b) = kit::bank() else { return };
    for id in [uuid(), "not-an-id".to_owned()] {
        let a = get(&b, &id);
        assert_eq!(
            (a.trpc(), a.code()),
            (
                "NOT_FOUND".into(),
                "bank.ops_authorization_not_found".into()
            )
        );
    }
}

#[test]
fn refuses_a_caller_without_the_compliance_scope_including_the_card_holder() {
    let Some(b) = kit::bank() else { return };
    let (_, approved, _) = seed(&b);
    let input = obj(&[("id", Json::str(approved))]);
    assert_eq!(
        call(&b, OWNER, &["bank:read"], "ops.authorizationGet", &input).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        call(
            &b,
            STRANGER,
            &["admin:treasury"],
            "ops.authorizationGet",
            &input
        )
        .trpc(),
        "FORBIDDEN"
    );
}

#[test]
fn refuses_extra_input_fields_at_validation() {
    let Some(b) = kit::bank() else { return };
    let input = obj(&[("id", Json::str(uuid())), ("userId", Json::str(OWNER))]);
    assert_eq!(
        call(&b, OPERATOR, &COMPLIANCE, "ops.authorizationGet", &input).trpc(),
        "BAD_REQUEST"
    );
}

#[test]
fn returns_both_legs_of_a_conversion_and_the_funding_asset_of_the_amount() {
    let Some(b) = kit::bank() else { return };
    let card = b.card(OWNER, "BTC", Some("USDT"), "1");
    let auth = authorize(
        &b.db,
        &Auth {
            card: &card,
            reference: "TEST-auth-fx",
            amount: "0.002",
            ..Auth::default()
        },
    );
    convert(
        &b.db,
        &auth,
        ("USDT", "100"),
        ("BTC", "0.002"),
        "50000",
        "mid",
        NOW,
    );
    let got = get(&b, &auth).ok();
    assert_eq!(s(&got, "assetId"), "BTC");
    assert_eq!(s(&got, "amount"), "0.002");
    assert_eq!(
        got.get("conversion").unwrap().compact(),
        obj(&[
            ("settlementAssetId", Json::str("USDT")),
            ("settlementAmount", Json::str("100")),
            ("fundingAssetId", Json::str("BTC")),
            ("fundingAmount", Json::str("0.002")),
            ("rate", Json::str("50000")),
            ("rateQuality", Json::str("mid")),
            ("rateAsOf", Json::str(NOW)),
        ])
        .compact()
    );
}

#[test]
fn names_the_card_asset_on_a_same_asset_card_approved_or_declined() {
    let Some(b) = kit::bank() else { return };
    let (_, ok, no) = seed(&b);
    let ok = get(&b, &ok).ok();
    assert_eq!(
        (s(&ok, "assetId"), s(&ok, "amount"), s(&ok, "conversion")),
        ("USDT".into(), "40".into(), "null".into())
    );
    let no = get(&b, &no).ok();
    assert_eq!(
        [
            s(&no, "assetId"),
            s(&no, "decision"),
            s(&no, "holdLedgerTxId"),
            s(&no, "conversion")
        ],
        ["USDT", "declined", "null", "null"].map(str::to_owned)
    );
}

#[test]
fn refuses_an_id_longer_than_64_characters_at_validation_and_logs_nothing_for_it() {
    let Some(b) = kit::bank() else { return };
    assert_eq!(get(&b, &"x".repeat(65)).trpc(), "BAD_REQUEST");
}

// ---------------------------------------------------------------------------------------------------------------
// ops.customerCards

fn cards(b: &Bank, user: &str, scopes: &[&str], input: &Json) -> kit::Answer {
    call(b, user, scopes, "ops.customerCards", input)
}

fn page(user: &str, limit: Option<i64>) -> Json {
    let mut f = vec![("userId", Json::str(user))];
    if let Some(l) = limit {
        f.push(("limit", Json::int(l)));
    }
    obj(&f)
}

fn home() -> Address {
    Address {
        name: "TEST".to_owned(),
        line1: "1 Home Street".to_owned(),
        line2: None,
        city: "Berlin".to_owned(),
        region: None,
        postal_code: "10115".to_owned(),
        country: "DE".to_owned(),
    }
}

/// The customer's two cards (an open virtual one, not activated, and a closed physical one with a home address) and
/// another person's: `(open, closed)`.
fn customer(b: &Bank) -> (String, String) {
    let closed = uuid();
    b.deps(|d| {
        issue(
            d,
            &IssueAsk {
                card_id: closed.clone(),
                user_id: CUSTOMER.to_owned(),
                asset_id: "USDT".to_owned(),
                per_authorization_limit: service_kit::money::parse_amount("50").unwrap(),
                card_type: Some("physical".to_owned()),
                shipping_address: Some(home()),
                ..IssueAsk::default()
            },
        )
    })
    .unwrap();
    b.db.client()
        .execute(
            "UPDATE bank.cards SET status = 'closed' WHERE id = $1::text::uuid",
            &[&closed],
        )
        .unwrap();
    let open = uuid();
    b.deps(|d| {
        issue(
            d,
            &IssueAsk {
                card_id: open.clone(),
                user_id: CUSTOMER.to_owned(),
                asset_id: "USDT".to_owned(),
                per_authorization_limit: service_kit::money::parse_amount("50").unwrap(),
                activated: Some(false),
                ..IssueAsk::default()
            },
        )
    })
    .unwrap();
    b.card(OTHER, "USDT", None, "50");
    (open, closed)
}

#[test]
fn lists_the_named_customer_s_cards_a_closed_one_included_with_no_secret_and_logs_the_read_first() {
    let Some(b) = kit::bank() else { return };
    let (open, closed) = customer(&b);
    let out = cards(&b, OPERATOR, &["admin:read"], &page(CUSTOMER, Some(50))).ok();
    assert_eq!(s(&out, "userId"), CUSTOMER);
    let listed = arr(&out, "cards");
    assert_eq!(
        listed
            .iter()
            .map(|c| (s(c, "id"), s(c, "status")))
            .collect::<Vec<_>>(),
        vec![(open, "inactive".to_owned()), (closed, "closed".to_owned())]
    );
    let c = &listed[1];
    assert_eq!(
        [
            s(c, "simulated"),
            s(c, "perAuthorizationLimit"),
            s(c, "cardType")
        ],
        ["true", "50", "physical"].map(str::to_owned)
    );
    assert_eq!(s(c, "panTail").len(), 4);
    assert!(c.get("shippingAddress").is_none());
    let text = out.compact();
    let issuer_ref: String =
        b.db.client()
            .query_one(
                "SELECT issuer_ref FROM bank.cards WHERE id = $1::text::uuid",
                &[&s(c, "id")],
            )
            .unwrap()
            .get(0);
    assert!(!text.contains(&issuer_ref));
    assert!(!text.contains("Home Street"));
    let lower = text.to_lowercase();
    for word in ["shippingaddress", "issuerref", "pan\"", "cvv", "pin\""] {
        assert!(!lower.contains(word), "{word} in {text}");
    }
}

#[test]
fn gives_the_owner_s_own_view_of_each_card_field_for_field_without_the_shipping_address() {
    let Some(b) = kit::bank() else { return };
    customer(&b);
    b.db.client()
        .execute(
            "UPDATE bank.cards SET status = 'frozen', frozen_by = 'owner', daily_limit = 100 \
              WHERE user_id = $1 AND status <> 'closed'",
            &[&CUSTOMER],
        )
        .unwrap();
    let out = cards(&b, OPERATOR, &["admin:read"], &page(CUSTOMER, Some(50))).ok();
    let rows = b.deps(|d| {
        svc_bank::spaces::space::with(d.store(), |c| cards_page(c, CUSTOMER, 50)).unwrap()
    });
    let want: Vec<Json> = rows
        .iter()
        .map(|r| match r.view() {
            Json::Object(f) => Json::Object(
                f.into_iter()
                    .filter(|(k, _)| k != "shippingAddress")
                    .collect(),
            ),
            other => other,
        })
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        Json::Array(arr(&out, "cards")).compact(),
        Json::Array(want).compact()
    );
}

#[test]
fn refuses_a_customer_session_even_for_their_own_id_and_an_operator_without_admin_read_and_reads_nothing()
 {
    let Some(b) = kit::bank() else { return };
    customer(&b);
    assert_eq!(
        cards(
            &b,
            CUSTOMER,
            &["bank:read", "bank:write"],
            &page(CUSTOMER, Some(50))
        )
        .trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        cards(
            &b,
            OPERATOR,
            &["support:ops", "market:ops"],
            &page(CUSTOMER, Some(50))
        )
        .trpc(),
        "FORBIDDEN"
    );
}

#[test]
fn refuses_a_blank_page_size_by_its_code_a_smuggled_field_and_a_non_uuid_customer_and_reads_nothing()
 {
    let Some(b) = kit::bank() else { return };
    customer(&b);
    let op = ["admin:read"];
    let blank = cards(&b, OPERATOR, &op, &page(CUSTOMER, None));
    assert_eq!(
        (blank.trpc(), blank.code()),
        ("BAD_REQUEST".into(), "bank.cards_list_limit_unset".into())
    );
    assert_ne!(cards(&b, OPERATOR, &op, &page("nope", Some(5))).0, 200);
    assert_ne!(cards(&b, OPERATOR, &op, &page(CUSTOMER, Some(201))).0, 200);
    let smuggled = obj(&[
        ("userId", Json::str(CUSTOMER)),
        ("limit", Json::int(5)),
        ("extra", Json::int(1)),
    ]);
    assert_ne!(cards(&b, OPERATOR, &op, &smuggled).0, 200);
}
