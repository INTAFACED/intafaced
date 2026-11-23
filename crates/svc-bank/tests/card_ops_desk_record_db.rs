//! LOCAL TEST: the TEST card partner's own book on loopback. Ports `cards/test-card-partner-record.test.ts` (whole),
//! every test named after the TypeScript's, driving `card_ops_desk::record::answer` as the TypeScript drives
//! `answerTestCardPartnerRecord`; `the_record_is_mounted_on_loopback_alone_and_reads_the_partner_card_s_own_holds` adds
//! the door `index.ts` mounts (loopback only, the simulator only, the six routes and their methods).
//!
//! Seeded, not driven: the door test's hold is the TEST partner card's own (`ops.cardAuthorize` and `ops.cardCapture`
//! leave it, the slice's other half), written through the kit's `hold`.
//!
//! Where the Rust differs: the TypeScript's door also sends `cache-control: no-store`; the door's answer here carries
//! no headers (nothing on loopback reads them).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::card_ops_desk_kit::{self as kit, HoldMove, Setup, arr, hold, obj, rest, s, sim, uuid};

use service_kit::json::Json;
use service_kit::schema::Value;
use svc_bank::card_ops_desk::record::{RECORD_ID, RecordHolds, answer};
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::terms::{FiguresAsOf, FundingOffers, PartnerTerms, Reserve};
use svc_bank::errors::Refusal;

const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const TERMS: &str = "TEST terms: the programme bears card fraud and lost chargebacks";

fn account(owner: &str) -> Value {
    Value::from_json(&obj(&[(
        "account",
        obj(&[
            ("venueId", Json::str(RECORD_ID)),
            ("owner", Json::str(owner)),
            ("subAccount", Json::Null),
        ]),
    )]))
}

fn with(over: impl FnOnce(&mut PartnerTerms)) -> Issuer {
    let mut t = PartnerTerms {
        balances: Some(vec![("USDC".to_owned(), "120".to_owned())]),
        ..PartnerTerms::nothing_reported()
    };
    over(&mut t);
    sim(t)
}

fn plain() -> Issuer {
    with(|_| {})
}

fn ask(s: &Issuer, method: &str, path: &str, body: &Value) -> (u16, Json) {
    answer(s, None, method, path, body).unwrap().unwrap()
}

fn value(r: &(u16, Json)) -> Json {
    r.1.get("value").cloned().unwrap()
}

#[test]
fn names_itself_test() {
    let (status, body) = ask(&plain(), "GET", "/venue", &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(s(&body, "label"), "TEST");
    assert_eq!(s(body.get("venue").unwrap(), "id"), RECORD_ID);
}

#[test]
fn answers_one_cardholder_s_book_as_the_partner_keeps_it_its_credit_once_its_reversal_never_another_s()
 {
    let sm = plain();
    sm.provisional_credit("c1", ADA, "USDC", "50").unwrap();
    sm.provisional_credit("c1", ADA, "USDC", "50").unwrap();
    assert_eq!(
        ask(&sm, "POST", "/balances", &account(ADA)).1.compact(),
        obj(&[
            ("label", Json::str("TEST")),
            (
                "value",
                Json::Array(vec![obj(&[
                    ("asset", Json::str("USDC")),
                    ("free", Json::str("170")),
                    ("locked", Json::str("0")),
                    ("total", Json::str("170")),
                ])])
            ),
        ])
        .compact()
    );
    let credits = value(&ask(&sm, "POST", "/credits", &account(ADA)));
    let Json::Array(credits) = credits else {
        panic!()
    };
    assert_eq!(credits.len(), 1);
    assert_eq!(
        (
            s(&credits[0], "assetId"),
            s(&credits[0], "amount"),
            s(&credits[0], "reversed")
        ),
        ("USDC".into(), "50".into(), "false".into())
    );
    assert_eq!(
        ask(&sm, "POST", "/credits", &account(BOB)),
        (
            200,
            obj(&[("label", Json::str("TEST")), ("value", Json::Array(vec![]))])
        )
    );
    let total = |who: &str| {
        s(
            &arr(&ask(&sm, "POST", "/balances", &account(who)).1, "value")[0],
            "total",
        )
    };
    assert_eq!(total(BOB), "120");
    sm.settle_provisional_credit("d1", "c1", "reversed")
        .unwrap();
    assert_eq!(
        s(
            &arr(&ask(&sm, "POST", "/credits", &account(ADA)).1, "value")[0],
            "reversed"
        ),
        "true"
    );
    assert_eq!(total(ADA), "120");
}

fn all_null() -> Json {
    obj(&[
        ("lossLiability", Json::Null),
        ("funder", Json::Null),
        ("reserve", Json::Null),
        ("programmeFigures", Json::Null),
        ("figuresAsOf", Json::Null),
        ("fundingAssetId", Json::Null),
        ("fundingOffers", Json::Null),
    ])
}

#[test]
fn reports_its_terms_as_they_are_set_each_null_when_it_reports_nothing() {
    assert_eq!(
        ask(&plain(), "POST", "/terms", &account(ADA)),
        (
            200,
            obj(&[("label", Json::str("TEST")), ("value", all_null())])
        )
    );
    let reported = with(|t| {
        t.loss_liability = Some(("programme".to_owned(), TERMS.to_owned()));
        t.funder = Some("TEST funder".to_owned());
        t.reserve = Some(Reserve::Required {
            amount: "25000.00".to_owned(),
            asset_id: "USDC".to_owned(),
        });
        t.programme_figures = Some(vec![("USDC".to_owned(), ("5".to_owned(), "20".to_owned()))]);
        t.figures_as_of = Some(FiguresAsOf::Now);
        t.funding_asset_id = Some("USDC".to_owned());
        t.funding_offers = Some(FundingOffers {
            fund: true,
            defund: true,
            auto_reload: false,
        });
    });
    assert_eq!(
        ask(&reported, "POST", "/terms", &account(BOB)).1.compact(),
        obj(&[
            ("label", Json::str("TEST")),
            (
                "value",
                obj(&[
                    (
                        "lossLiability",
                        obj(&[
                            ("bearer", Json::str("programme")),
                            ("terms", Json::str(TERMS))
                        ])
                    ),
                    ("funder", Json::str("TEST funder")),
                    (
                        "reserve",
                        obj(&[
                            ("required", Json::Bool(true)),
                            ("amount", Json::str("25000.00")),
                            ("assetId", Json::str("USDC")),
                        ])
                    ),
                    (
                        "programmeFigures",
                        obj(&[(
                            "USDC",
                            obj(&[("held", Json::str("5")), ("captured", Json::str("20"))])
                        )])
                    ),
                    ("figuresAsOf", Json::str("now")),
                    ("fundingAssetId", Json::str("USDC")),
                    (
                        "fundingOffers",
                        obj(&[
                            ("fund", Json::Bool(true)),
                            ("defund", Json::Bool(true)),
                            ("autoReload", Json::Bool(false)),
                        ])
                    ),
                ])
            ),
        ])
        .compact()
    );
}

#[test]
fn lists_each_funding_instruction_it_took_once_under_its_key_and_none_it_refused() {
    let sm = with(|t| {
        t.funding_asset_id = Some("USDC".to_owned());
        t.funding_offers = Some(FundingOffers {
            fund: true,
            defund: false,
            auto_reload: false,
        });
    });
    let first = sm
        .programme_funding("f1", "fund", "USDC", "1000", None)
        .unwrap();
    assert_eq!(
        sm.programme_funding("f1", "fund", "USDC", "1000", None)
            .unwrap(),
        first
    );
    assert!(
        sm.programme_funding("f2", "defund", "USDC", "1000", None)
            .is_err()
    );
    assert_eq!(
        ask(&sm, "POST", "/funding", &account(ADA)).1.compact(),
        obj(&[
            ("label", Json::str("TEST")),
            (
                "value",
                Json::Array(vec![obj(&[
                    ("requestId", Json::str("f1")),
                    ("kind", Json::str("fund")),
                    ("assetId", Json::str("USDC")),
                    ("amount", Json::str("1000")),
                    ("threshold", Json::Null),
                    ("partnerRef", Json::str(first)),
                ])])
            ),
        ])
        .compact()
    );
}

/// The TypeScript test's stand-in holds: 5 held of every asset, 20 captured for Ada alone.
struct Stub;

impl RecordHolds for Stub {
    fn held(&self, _: &str, _: &str) -> Result<Option<String>, Refusal> {
        Ok(Some("5".to_owned()))
    }
    fn captured(&self, user_id: &str, _: &str) -> Result<Option<String>, Refusal> {
        Ok(Some(if user_id == ADA { "20" } else { "0" }.to_owned()))
    }
}

#[test]
fn lists_the_partner_card_s_own_held_and_captured_per_asset_for_one_cardholder_none_with_no_holds_wired()
 {
    let sm = plain();
    let (_, body) = answer(&sm, Some(&Stub), "POST", "/holds", &account(ADA))
        .unwrap()
        .unwrap();
    assert_eq!(
        body.compact(),
        obj(&[
            ("label", Json::str("TEST")),
            (
                "value",
                Json::Array(vec![obj(&[
                    ("asset", Json::str("USDC")),
                    ("held", Json::str("5")),
                    ("captured", Json::str("20")),
                ])])
            ),
        ])
        .compact()
    );
    assert_eq!(
        ask(&sm, "POST", "/holds", &account(ADA)).1.compact(),
        obj(&[("label", Json::str("TEST")), ("value", Json::Array(vec![]))]).compact()
    );
}

#[test]
fn refuses_a_wrong_account_a_sub_account_an_unknown_path_and_a_wrong_method() {
    let sm = plain();
    let body = |v: Json| Value::from_json(&obj(&[("account", v)]));
    assert_eq!(
        ask(
            &sm,
            "POST",
            "/balances",
            &body(obj(&[
                ("venueId", Json::str("x")),
                ("owner", Json::str(ADA))
            ]))
        )
        .0,
        400
    );
    assert_eq!(
        ask(
            &sm,
            "POST",
            "/balances",
            &body(obj(&[("venueId", Json::str(RECORD_ID))]))
        )
        .0,
        400
    );
    assert_eq!(
        ask(
            &sm,
            "POST",
            "/balances",
            &body(obj(&[
                ("venueId", Json::str(RECORD_ID)),
                ("owner", Json::str(ADA)),
                ("subAccount", Json::str("a")),
            ]))
        )
        .0,
        400
    );
    assert_eq!(ask(&sm, "POST", "/moves", &account(ADA)).0, 404);
    assert_eq!(ask(&sm, "GET", "/credits", &account(ADA)).0, 405);
}

#[test]
fn is_only_on_the_simulator_no_issuer_and_the_simulator_in_a_live_posture_keep_no_record() {
    for issuer in [
        Issuer::for_setting("none", false, PartnerTerms::nothing_reported()),
        Issuer::for_setting("card-sim", true, PartnerTerms::nothing_reported()),
    ] {
        assert!(answer(&issuer, None, "GET", "/venue", &Value::Null).is_none());
    }
}

/// The door: mounted on the simulator only, loopback only, and reading the TEST partner card's own book of holds.
#[test]
fn the_record_is_mounted_on_loopback_alone_and_reads_the_partner_card_s_own_holds() {
    let terms = PartnerTerms {
        balances: Some(vec![("USDC".to_owned(), "120".to_owned())]),
        ..PartnerTerms::nothing_reported()
    };
    let Some(b) = kit::bank_with(Setup {
        issuer: sim(terms.clone()),
        test_partner: true,
        ..Setup::default()
    }) else {
        return;
    };
    let base = "/test-card-partner";
    let body = account(ADA).to_json().unwrap();
    let (st, venue) = rest(
        &b.door,
        "GET",
        &format!("{base}/venue"),
        None,
        None,
        "127.0.0.1",
    );
    assert_eq!((st, s(&venue, "label")), (200, "TEST".into()));
    // Off loopback, refused; a method a route is not mounted for is not this door's.
    let (st, out) = rest(
        &b.door,
        "GET",
        &format!("{base}/venue"),
        None,
        None,
        "203.0.113.9",
    );
    assert_eq!((st, s(&out, "error")), (403, "loopback only".into()));
    assert_ne!(
        rest(
            &b.door,
            "GET",
            &format!("{base}/credits"),
            None,
            None,
            "127.0.0.1"
        )
        .0,
        200
    );

    hold(
        &b.door.cards().holds,
        &terms,
        &HoldMove {
            authorization: &uuid(),
            user: ADA,
            asset: "USDC",
            amount: "25",
            captured: "20",
            released: "0",
            refunded: "0",
        },
        b.door.now(),
    );
    let (st, out) = rest(
        &b.door,
        "POST",
        &format!("{base}/holds"),
        Some(&body),
        None,
        "::1",
    );
    assert_eq!(st, 200, "{}", out.compact());
    assert_eq!(
        Json::Array(arr(&out, "value")).compact(),
        Json::Array(vec![obj(&[
            ("asset", Json::str("USDC")),
            ("held", Json::str("5")),
            ("captured", Json::str("20")),
        ])])
        .compact()
    );

    for issuer in [Issuer::None, Issuer::SimNotLive] {
        let door = b.rewired(Setup {
            issuer,
            test_partner: true,
            ..Setup::default()
        });
        assert_ne!(
            rest(
                &door,
                "GET",
                &format!("{base}/venue"),
                None,
                None,
                "127.0.0.1"
            )
            .0,
            200
        );
    }
}
