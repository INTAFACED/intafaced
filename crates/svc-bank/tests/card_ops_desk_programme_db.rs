//! The card programme as the operator's desk sees it, through the door where the TypeScript drives the router. Ports,
//! each test named after the TypeScript's:
//! - `cards/partner-terms.test.ts`: the tests of `partnerTermsView` (what `ops.cardPartnerTerms` answers) and of the
//!   partner terms' refusals by name, read through `ops.cardPartnerTerms`. Left: the switches' parsing, Pay from and the
//!   secrets switch are the `cards` slice's (`cards::terms`' own tests and `cards_reads_db.rs`).
//! - `cards/pay-from-holds.money.test.ts`: the two #8 reconciliation tests (`ops.cardPayFromReconciliation`). Left: #3 to
//!   #7 drive the card moves (the slice's other half) and `cards_reads_db.rs` holds their reads.
//! - `ops/bank-ops.db.test.ts`: the `ops.setCardStatus` half of `counts the card programme and freezes only with a
//!   matching approval`. Left: its `ops.cardProgramme` half is slice `card-programme`'s.
//! - `partner/reserves.test.ts` (whole), through `card_ops_desk::reserves::read` as the TypeScript calls
//!   `partnerReservesRead`, and `the_partner_reserves_door_answers_svc_ops_alone` through the door.
//!
//! Seeded, not driven: both #8 tests need pay-from payments the TEST partner card held, captured and refunded, which are
//! `ops.cardAuthorize`, `ops.cardCapture` and `testPartner.cardRefund`: they are written through the kit's `authorize`,
//! `convert`, `settle`, `refund` (the app's rows) and `hold` (the partner card's own book), in the figures the
//! TypeScript's moves leave (25 USDC held, 22 captured, 3 returned, 10 refunded; then 40 as 0.0008 BTC at 50000).
//! `ops.setCardStatus` is driven; its cards are issued through `cards::core::issue` and set frozen or closed in SQL.
//!
//! Where the Rust differs: the reconciliation's lines are ordered by asset byte by byte, where the TypeScript sorts with
//! `localeCompare`; an asset id is `[A-Z0-9]`, for which the two agree.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::card_ops_desk_kit::{
    self as kit, Auth, Bank, HoldMove, OPERATOR, Setup, arr, authorize, call, call_on, convert,
    hold, obj, refund, rest, s, settle, sim, uuid,
};

use service_kit::json::Json;
use service_kit::time::Instant;
use svc_bank::card_ops_desk::programme::{partner_terms_view, pay_from_reconciliation};
use svc_bank::card_ops_desk::reserves::{card_terms_or_none, read as reserves_read};
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::reads::{Figures, HoldReads, HoldReport, test_card_holds};
use svc_bank::cards::terms::{PartnerTerms, Reserve, sim_partner_for};
use svc_bank::errors::Refusal;
use svc_bank::partner::TestPartner;

const DISPLAY: &str = "Simulated card (no card programme)";
const NOT_KNOWN: &str = "not known";

/// The TEST partner card's switches as `cardSimPartnerFor(json(v), DEV)` reads them.
fn switches(v: &[(&str, Json)]) -> PartnerTerms {
    let mut all: Vec<(String, Json)> = [
        "custodyMode",
        "spendFrom",
        "lossLiability",
        "reserve",
        "funder",
        "balances",
        "programmeFigures",
        "figuresAsOf",
        "fundingAssetId",
        "fundingOffers",
    ]
    .iter()
    .map(|k| ((*k).to_owned(), Json::Null))
    .collect();
    for (k, val) in v {
        match all.iter_mut().find(|(n, _)| n == k) {
            Some(slot) => slot.1 = val.clone(),
            None => all.push(((*k).to_owned(), val.clone())),
        }
    }
    sim_partner_for(Some(&Json::Object(all).compact()), Some("dev"), None).unwrap()
}

fn view(t: &PartnerTerms) -> Json {
    partner_terms_view(t, DISPLAY)
}

/// `ops.cardPartnerTerms` on a door whose issuer is `issuer`.
fn terms_call(issuer: Issuer) -> Option<kit::Answer> {
    let b = kit::bank_with(Setup {
        issuer,
        ..Setup::default()
    })?;
    Some(call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.cardPartnerTerms",
        &obj(&[]),
    ))
}

#[test]
fn reports_each_mode_as_the_partner_set_it_and_not_known_when_it_has_not() {
    let holds = switches(&[("custodyMode", Json::str("partner_holds"))]);
    let pulls = switches(&[("custodyMode", Json::str("wallet_pull"))]);
    // The operator's words are in the third person: the cardholder's crypto, never "your" wallet.
    assert_eq!(
        s(&view(&holds), "custodyMode"),
        "The partner holds the cardholder\u{2019}s crypto and spends it"
    );
    assert_eq!(
        s(&view(&pulls), "custodyMode"),
        "The card pulls from the cardholder\u{2019}s own wallet"
    );
    assert_eq!(
        s(&view(&PartnerTerms::nothing_reported()), "custodyMode"),
        NOT_KNOWN
    );
    // Through the door, as the TEST partner card answers.
    let Some(a) = terms_call(sim(holds)) else {
        return;
    };
    let out = a.ok();
    assert_eq!(
        s(&out, "custodyMode"),
        "The partner holds the cardholder\u{2019}s crypto and spends it"
    );
    assert_eq!(
        (s(&out, "test"), s(&out, "label")),
        ("true".into(), "TEST partner card adapter".into())
    );
}

#[test]
fn an_unknown_bearer_reads_not_known_and_is_not_reported_as_the_partner() {
    let v = view(&PartnerTerms::nothing_reported());
    assert_eq!(s(&v, "lossLiability"), NOT_KNOWN);
    assert_eq!(s(&v, "lossLiabilityStatus"), "not_known");
    assert!(!s(&v, "lossLiability").contains("partner"));
}

#[test]
fn a_reported_bearer_reads_as_the_partner_reported_it_with_its_terms() {
    let t = switches(&[(
        "lossLiability",
        obj(&[
            ("bearer", Json::str("programme")),
            ("terms", Json::str("TEST: the programme bears fraud losses")),
        ]),
    )]);
    let v = view(&t);
    assert_eq!(s(&v, "lossLiabilityStatus"), "reported");
    assert_eq!(
        s(&v, "lossLiability"),
        "the programme (INTAFACED), under the partner's terms: TEST: the programme bears fraud losses"
    );
}

#[test]
fn an_unknown_reserve_and_funder_read_not_known_with_no_digit_in_them() {
    let v = view(&PartnerTerms::nothing_reported());
    assert_eq!(s(&v, "reserve"), NOT_KNOWN);
    assert_eq!(s(&v, "reserveStatus"), "not_known");
    assert_eq!(s(&v, "funder"), NOT_KNOWN);
    assert!(!s(&v, "reserve").bytes().any(|c| c.is_ascii_digit()));
}

fn required(amount: &str) -> Json {
    obj(&[
        ("required", Json::Bool(true)),
        ("amount", Json::str(amount)),
        ("assetId", Json::str("USDC")),
    ])
}

#[test]
fn a_required_reserve_shows_its_amount_none_required_says_so_in_words_not_as_0() {
    let req = view(&switches(&[
        ("figuresAsOf", Json::str("now")),
        ("reserve", required("25000.00")),
    ]));
    assert_eq!(s(&req, "reserve"), "25000.00 USDC, as the partner reports");
    let none = view(&switches(&[
        ("figuresAsOf", Json::str("now")),
        ("reserve", obj(&[("required", Json::Bool(false))])),
    ]));
    assert_eq!(s(&none, "reserve"), "None required, as the partner reports");
    assert_eq!(s(&none, "reserveStatus"), "reported");
}

#[test]
fn b2_change_6_a_reserve_the_partner_sent_with_no_time_for_it_reads_not_known_required_or_not() {
    for reserve in [
        required("25000.00"),
        obj(&[("required", Json::Bool(false))]),
    ] {
        let v = view(&switches(&[("reserve", reserve)]));
        assert_eq!(
            (s(&v, "reserve"), s(&v, "reserveStatus")),
            (NOT_KNOWN.into(), "not_known".into())
        );
    }
}

#[test]
fn card_sim_with_the_switches_planted_in_a_prod_posture_is_the_not_live_simulator_and_its_partner_terms_refuse()
 {
    let planted = switches(&[
        ("custodyMode", Json::str("partner_holds")),
        ("spendFrom", Json::Array(vec![Json::str("USDC")])),
        ("reserve", obj(&[("required", Json::Bool(false))])),
    ]);
    let adapter = Issuer::for_setting("card-sim", true, planted);
    assert_eq!(adapter.mutation_refuse(), Some("bank.card_sim_not_live"));
    let Some(a) = terms_call(adapter) else { return };
    assert_eq!(a.code(), "bank.card_sim_not_live");
}

#[test]
fn with_no_issuer_there_is_no_partner_to_ask_bank_no_card_issuer() {
    let Some(a) = terms_call(Issuer::None) else {
        return;
    };
    assert_eq!(a.code(), "bank.no_card_issuer");
}

#[test]
fn on_a_test_posture_the_planted_switches_reach_the_simulator_labelled_test() {
    let planted = switches(&[
        ("custodyMode", Json::str("partner_holds")),
        ("spendFrom", Json::Array(vec![Json::str("USDC")])),
        ("reserve", obj(&[("required", Json::Bool(false))])),
    ]);
    let adapter = Issuer::for_setting("card-sim", false, planted);
    let t = adapter.partner_terms().unwrap();
    assert!(t.test);
    assert_eq!(t.custody_mode.as_deref(), Some("partner_holds"));
    assert_eq!(t.spend_from, Some(vec!["USDC".to_owned()]));
    let Some(a) = terms_call(adapter) else { return };
    let out = a.ok();
    assert_eq!(
        (s(&out, "test"), s(&out, "label"), s(&out, "reserve")),
        (
            "true".into(),
            "TEST partner card adapter".into(),
            NOT_KNOWN.into()
        )
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The pay-from reconciliation (J-bank-29 #8).

const AT: &str = "2026-11-17T08:00:00.000Z";
const ORDER: [&str; 3] = ["USDC", "BTC", "USD"];

/// The stack's TEST partner card: 30 USDC, 0.01 BTC and 50 USD, 1 BTC quoted at 50000 USDC, 1 USD at 1.
fn partner() -> PartnerTerms {
    sim_partner_for(
        Some(
            r#"{"custodyMode":"partner_holds","spendFrom":["USDC","BTC","USD"],"lossLiability":null,"reserve":null,
                "funder":null,"balances":{"USDC":"30","BTC":"0.01","USD":"50"},"programmeFigures":null,"figuresAsOf":null,
                "fundingAssetId":null,"fundingOffers":null,"rates":{"in":"USDC","perUnit":{"BTC":"50000","USD":"1"}}}"#,
        ),
        Some("test"),
        None,
    )
    .unwrap()
}

fn at_now() -> Instant {
    kit::at(AT)
}

fn pay_bank() -> Option<Bank> {
    kit::bank_with(Setup {
        issuer: sim(partner()),
        test_partner: true,
        now: at_now,
        ..Setup::default()
    })
}

struct Paid {
    user: String,
    first: String,
    first_ref: String,
    second_ref: String,
}

/// `pay('25')`, its capture of 22 and refund of 10, then `pay('40')`: as the moves leave them.
fn pay_and_settle(b: &Bank, refunded: bool, second: bool) -> Paid {
    let user = uuid();
    // The journey's card: it draws on USDT (an asset the partner cannot spend from) and settles in USDC.
    let card = b.card(&user, "USDT", Some("USDC"), "1000");
    let terms = partner();
    let first_ref = format!("jb29-{}", uuid());
    let first = authorize(
        &b.db,
        &Auth {
            card: &card,
            reference: &first_ref,
            amount: "25",
            book: "partner",
            status: "settled",
            order: Some(&ORDER),
            ..Auth::default()
        },
    );
    convert(
        &b.db,
        &first,
        ("USDC", "25"),
        ("USDC", "25"),
        "1",
        "partner",
        AT,
    );
    settle(&b.db, &first, 1, "capture", "22", "partner");
    settle(&b.db, &first, 2, "reversal", "3", "partner");
    if refunded {
        refund(&b.db, &first, "10");
    }
    hold(
        &b.door.cards().holds,
        &terms,
        &HoldMove {
            authorization: &first,
            user: &user,
            asset: "USDC",
            amount: "25",
            captured: "22",
            released: "3",
            refunded: if refunded { "10" } else { "0" },
        },
        at_now(),
    );
    let second_ref = format!("jb29-{}", uuid());
    if second {
        let id = authorize(
            &b.db,
            &Auth {
                card: &card,
                reference: &second_ref,
                amount: "0.0008",
                book: "partner",
                status: "settled",
                order: Some(&ORDER),
                ..Auth::default()
            },
        );
        convert(
            &b.db,
            &id,
            ("USDC", "40"),
            ("BTC", "0.0008"),
            "50000",
            "partner",
            AT,
        );
        hold(
            &b.door.cards().holds,
            &terms,
            &HoldMove {
                authorization: &id,
                user: &user,
                asset: "BTC",
                amount: "0.0008",
                captured: "0",
                released: "0",
                refunded: "0",
            },
            at_now(),
        );
    }
    Paid {
        user,
        first,
        first_ref,
        second_ref,
    }
}

fn line(asset: &str, kind: &str, app: &str, partner: &str, status: &str) -> String {
    obj(&[
        ("assetId", Json::str(asset)),
        ("kind", Json::str(kind)),
        ("app", Json::str(app)),
        ("partner", Json::str(partner)),
        ("status", Json::str(status)),
    ])
    .compact()
}

fn reconciliation(door: &svc_bank::door::BankDoor) -> Json {
    call_on(
        door,
        OPERATOR,
        &["admin:read"],
        "ops.cardPayFromReconciliation",
        &obj(&[]),
    )
    .ok()
}

#[test]
fn n8_the_reconciliation_reads_every_line_matches_against_the_partner_and_a_hold_it_has_no_record_of_is_a_break_row()
 {
    let Some(b) = pay_bank() else { return };
    let paid = pay_and_settle(&b, true, true);
    let view = reconciliation(&b.door);
    assert_eq!(
        (s(&view, "test"), s(&view, "partnerReports")),
        ("true".into(), "true".into())
    );
    let lines: Vec<String> = arr(&view, "lines").iter().map(Json::compact).collect();
    for want in [
        line("USDC", "spend", "12", "12", "matches"),
        line("USDC", "open_holds", "0", "0", "matches"),
        line("BTC", "spend", "0", "0", "matches"),
        line("BTC", "open_holds", "0.0008", "0.0008", "matches"),
    ] {
        assert!(lines.contains(&want), "{want} not in {lines:?}");
    }
    assert!(
        arr(&view, "breaks")
            .iter()
            .all(|r| s(r, "authorizationRef") != paid.first_ref)
    );
    let _ = (&paid.user, &paid.second_ref);

    // A partner that has forgotten every hold (a TEST restart): each payment is its own break row, and no line sums it.
    let forgetful = b.rewired(Setup {
        issuer: sim(partner()),
        test_partner: true,
        now: at_now,
        ..Setup::default()
    });
    let broken = reconciliation(&forgetful);
    let row = arr(&broken, "breaks")
        .into_iter()
        .find(|r| s(r, "authorizationRef") == paid.first_ref)
        .unwrap();
    assert_eq!(
        (s(&row, "reason"), s(&row, "partner")),
        ("not_reported".into(), "null".into())
    );
}

/// The TEST partner card whose every read fails.
struct Down;

impl HoldReads for Down {
    fn figures(&self, _: &str, _: &str) -> Result<Figures, Refusal> {
        Err(Refusal::Other("TEST partner read is down".to_owned()))
    }
    fn hold_state(&self, _: &str) -> Result<Option<HoldReport>, Refusal> {
        Err(Refusal::Other("TEST partner read is down".to_owned()))
    }
}

#[test]
fn n8_a_partner_whose_read_fails_is_a_break_row_unreadable_never_not_reported_and_no_line_sums_it_9353()
 {
    let Some(b) = pay_bank() else { return };
    let paid = pay_and_settle(&b, false, false);
    // The book holds the payment, so a "not reported" here would be the read's failure misnamed.
    assert!(b.deps(|d| {
        test_card_holds(d, &b.door.cards().holds)
            .unwrap()
            .hold_state(&svc_bank::cards::reads::hold_key(&paid.first))
            .unwrap()
            .is_some()
    }));
    let view = b.deps(|d| pay_from_reconciliation(d, Some(&Down))).unwrap();
    let mine: Vec<String> = arr(&view, "breaks")
        .iter()
        .filter(|r| s(r, "authorizationRef") == paid.first_ref)
        .map(Json::compact)
        .collect();
    assert_eq!(
        mine,
        vec![
            obj(&[
                ("authorizationRef", Json::str(paid.first_ref.clone())),
                ("assetId", Json::str("USDC")),
                ("reason", Json::str("unreadable")),
                (
                    "app",
                    obj(&[("spend", Json::str("22")), ("open", Json::str("0"))])
                ),
                ("partner", Json::Null),
            ])
            .compact()
        ]
    );
    assert!(
        !arr(&view, "breaks")
            .iter()
            .any(|r| s(r, "reason") == "not_reported")
    );
    // Every read failed, so every line leaves every payment out on both sides, as it does one the partner does not report.
    let spend = arr(&view, "lines")
        .into_iter()
        .find(|l| s(l, "assetId") == "USDC" && s(l, "kind") == "spend")
        .unwrap();
    assert_eq!(
        (s(&spend, "app"), s(&spend, "partner"), s(&spend, "status")),
        ("0".into(), "0".into(), "matches".into())
    );
}

// ---------------------------------------------------------------------------------------------------------------
// ops.setCardStatus

const OWNER: &str = "11111111-1111-4111-8111-111111111111";

fn status_of(b: &Bank, card: &str) -> String {
    b.db.client()
        .query_one(
            "SELECT status::text FROM bank.cards WHERE id = $1::text::uuid",
            &[&card],
        )
        .unwrap()
        .get(0)
}

fn freeze(card: &str, reason: &str, client: &str, approval: &[(&'static str, Json)]) -> Json {
    let mut f = vec![
        ("cardId", Json::str(card)),
        ("status", Json::str("frozen")),
        ("reason", Json::str(reason)),
        ("clientRequestId", Json::str(client)),
    ];
    f.extend(approval.iter().cloned());
    obj(&f)
}

#[test]
fn counts_the_card_programme_and_freezes_only_with_a_matching_approval() {
    let Some(b) = kit::bank() else { return };
    let active = b.card(OWNER, "USDT", None, "100");
    let frozen = b.card(OWNER, "USDT", None, "100");
    let closed = b.card(OWNER, "BTC", None, "100");
    let mut c = b.db.client();
    c.execute(
        "UPDATE bank.cards SET status = 'frozen', frozen_by = 'owner' WHERE id = $1::text::uuid",
        &[&frozen],
    )
    .unwrap();
    c.execute(
        "UPDATE bank.cards SET status = 'closed' WHERE id = $1::text::uuid",
        &[&closed],
    )
    .unwrap();
    let treasury = ["admin:treasury"];
    let set = |input: &Json| call(&b, OPERATOR, &treasury, "ops.setCardStatus", input);

    let none = set(&freeze(&active, "lost phone", &uuid(), &[]));
    assert_eq!(none.trpc(), "PRECONDITION_FAILED");
    assert_eq!(status_of(&b, &active), "active");

    let other = b.desk.issue(
        "bank.ops.setCardStatus",
        &[("cardId", &frozen), ("status", "frozen")],
    );
    let wrong = set(&freeze(&active, "customer reported theft", &uuid(), &other));
    assert_eq!(wrong.trpc(), "PRECONDITION_FAILED");
    assert_eq!(status_of(&b, &active), "active");

    let matched = b.desk.issue(
        "bank.ops.setCardStatus",
        &[("cardId", &active), ("status", "frozen")],
    );
    let client = uuid();
    let first = set(&freeze(
        &active,
        "customer reported theft",
        &client,
        &matched,
    ))
    .ok();
    assert_eq!(
        first.compact(),
        obj(&[
            ("cardId", Json::str(active.clone())),
            ("status", Json::str("frozen")),
            ("frozenBy", Json::str("operator")),
        ])
        .compact()
    );
    let second = set(&freeze(
        &active,
        "customer reported theft",
        &client,
        &matched,
    ))
    .ok();
    assert_eq!(second.compact(), first.compact());
    assert_eq!(b.desk.consumed(), 1, "a replay spends no second approval");
    assert_eq!(
        b.count("SELECT count(*)::int8 FROM bank.card_operator_commands"),
        1
    );

    // The owner cannot lift the operator's freeze.
    let owner = call(
        &b,
        OWNER,
        &["bank:read", "bank:write"],
        "cards.setStatus",
        &obj(&[
            ("cardId", Json::str(active.clone())),
            ("status", Json::str("active")),
        ]),
    );
    assert!(
        owner.message().contains("bank.card_operator_frozen"),
        "{:?}",
        owner
    );
    assert_eq!(status_of(&b, &active), "frozen");
    // A reason under ten characters refuses before any approval is spent; another card under the same id conflicts.
    assert_eq!(
        set(&freeze(&frozen, "too short", &uuid(), &[])).code(),
        "bank.ops_reason_too_short"
    );
    assert_eq!(
        set(&freeze(&frozen, "customer reported theft", &client, &[])).code(),
        "bank.card_command_conflict"
    );
    assert_eq!(
        call(
            &b,
            OPERATOR,
            &["admin:read"],
            "ops.setCardStatus",
            &freeze(&active, "customer reported theft", &uuid(), &[])
        )
        .trpc(),
        "FORBIDDEN"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Partner reserves (J-ops-console-24 #1).

const RESERVES_AT: &str = "2026-11-09T02:00:00.000Z";

fn reserves(partner: Option<&TestPartner>, card: Option<&PartnerTerms>) -> Json {
    reserves_read(partner, card, kit::at(RESERVES_AT))
}

fn row(partner: &str, label: &str, reserve: &Json) -> Json {
    obj(&[
        ("partner", Json::str(partner)),
        ("label", Json::str(label)),
        ("test", Json::Bool(true)),
        ("reserve", reserve.clone()),
    ])
}

fn status(s: &str) -> Json {
    obj(&[("status", Json::str(s))])
}

fn partners(j: &Json) -> String {
    Json::Array(arr(j, "partners")).compact()
}

#[test]
fn reads_the_test_partner_bank_and_the_test_card_partner_as_not_known_never_zero_or_none() {
    let partner = TestPartner::new().unwrap();
    let out = reserves(Some(&partner), Some(&PartnerTerms::nothing_reported()));
    assert_eq!(
        out.compact(),
        obj(&[
            ("asOf", Json::str(RESERVES_AT)),
            (
                "partners",
                Json::Array(vec![
                    row("bank", "TEST partner bank", &status("not_known")),
                    row("card", "TEST partner card", &status("not_known")),
                ])
            ),
        ])
        .compact()
    );
}

#[test]
fn keeps_the_programme_reserve_not_known_whatever_one_person_switched_their_own_reserve_to() {
    let partner = TestPartner::new().unwrap();
    {
        let user = "11111111-1111-4111-8111-111111111111";
        let mut book = partner.lock();
        let mut sw = book.board.get(user);
        sw.reserve = "none".to_owned();
        book.board.set(user, sw);
    }
    assert_eq!(
        partners(&reserves(Some(&partner), None)),
        Json::Array(vec![row("bank", "TEST partner bank", &status("not_known"))]).compact()
    );
}

fn reported_terms(as_of: Option<&str>, reserve: Reserve) -> PartnerTerms {
    PartnerTerms {
        figures_as_of: as_of.map(|a| {
            if a == "now" {
                svc_bank::cards::terms::FiguresAsOf::Now
            } else {
                svc_bank::cards::terms::FiguresAsOf::At(a.to_owned())
            }
        }),
        reserve: Some(reserve),
        ..PartnerTerms::nothing_reported()
    }
}

fn usdc(amount: &str) -> Reserve {
    Reserve::Required {
        amount: amount.to_owned(),
        asset_id: "USDC".to_owned(),
    }
}

#[test]
fn carries_a_card_partner_reserve_it_reports_and_one_it_says_is_not_required() {
    let t = reported_terms(Some("2026-11-10T08:00:00.000Z"), usdc("25000.00"));
    assert_eq!(
        partners(&reserves(None, Some(&t))),
        Json::Array(vec![row(
            "card",
            "TEST partner card",
            // The partner's own time for the reserve, not our read time (b2 change 6).
            &obj(&[
                ("status", Json::str("reported")),
                ("assetId", Json::str("USDC")),
                ("amount", Json::str("25000.00")),
                ("asOf", Json::str("2026-11-10T08:00:00.000Z")),
            ])
        )])
        .compact()
    );
    let none = reported_terms(Some("now"), Reserve::NotRequired);
    assert_eq!(
        arr(&reserves(None, Some(&none)), "partners")[0]
            .get("reserve")
            .unwrap()
            .compact(),
        status("none").compact()
    );
}

#[test]
fn b2_change_6_a_reserve_the_card_partner_sent_with_no_time_is_not_known_never_stamped_with_our_read_time()
 {
    for reserve in [usdc("25000.00"), Reserve::NotRequired] {
        let t = reported_terms(None, reserve);
        assert_eq!(
            arr(&reserves(None, Some(&t)), "partners")[0]
                .get("reserve")
                .unwrap()
                .compact(),
            status("not_known").compact()
        );
    }
    // `now` is the TEST partner reporting with its own clock at the read.
    let live = reported_terms(Some("now"), usdc("1"));
    let r = arr(&reserves(None, Some(&live)), "partners")[0]
        .get("reserve")
        .cloned()
        .unwrap();
    assert_eq!(
        (s(&r, "status"), s(&r, "asOf")),
        ("reported".into(), RESERVES_AT.into())
    );
}

#[test]
fn lists_no_partner_a_deployment_has_no_adapter_for() {
    assert_eq!(partners(&reserves(None, None)), "[]");
}

#[test]
fn reads_no_card_issuer_as_no_card_partner_and_throws_any_other_failure() {
    assert!(card_terms_or_none(&Issuer::None).unwrap().is_none());
    match card_terms_or_none(&Issuer::SimNotLive) {
        Err(Refusal::Bank(e)) => assert_eq!(e.row.code, "bank.card_sim_not_live"),
        other => panic!("{other:?}"),
    }
}

/// The door: svc-ops alone reads it, signed; the simulator in a live posture is Fastify's 500 with its own code.
#[test]
fn the_partner_reserves_door_answers_svc_ops_alone() {
    let Some(b) = kit::bank_with(Setup {
        test_partner: true,
        ..Setup::default()
    }) else {
        return;
    };
    let path = "/internal/capital/partner-reserves";
    let body = obj(&[]);
    let (st, out) = rest(
        &b.door,
        "POST",
        path,
        Some(&body),
        Some("svc-ops"),
        "127.0.0.1",
    );
    assert_eq!(st, 200, "{}", out.compact());
    assert_eq!(
        partners(&out),
        Json::Array(vec![
            row("bank", "TEST partner bank", &status("not_known")),
            row("card", "TEST partner card", &status("not_known")),
        ])
        .compact()
    );
    assert_eq!(
        rest(&b.door, "POST", path, Some(&body), None, "127.0.0.1").0,
        401
    );
    let (st, out) = rest(
        &b.door,
        "POST",
        path,
        Some(&body),
        Some("svc-earn"),
        "127.0.0.1",
    );
    assert_eq!((st, s(&out, "code")), (403, "bank.caller_forbidden".into()));

    let not_live = b.rewired(Setup {
        issuer: Issuer::SimNotLive,
        ..Setup::default()
    });
    let (st, out) = rest(
        &not_live,
        "POST",
        path,
        Some(&body),
        Some("svc-ops"),
        "127.0.0.1",
    );
    assert_eq!(
        (st, s(&out, "code")),
        (500, "bank.card_sim_not_live".into())
    );
    let none = b.rewired(Setup {
        issuer: Issuer::None,
        ..Setup::default()
    });
    let (st, out) = rest(
        &none,
        "POST",
        path,
        Some(&body),
        Some("svc-ops"),
        "127.0.0.1",
    );
    assert_eq!((st, partners(&out)), (200, "[]".to_owned()));
}
