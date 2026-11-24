//! Card disputes as support works them, over real rows: ports the support half of `cards/card-disputes.money.test.ts`
//! (J-bank-27, BK-cdisp-02, BK-cdisp-03), every test named after the TypeScript's. The TypeScript drives
//! `CardDisputeService` itself, so these drive `card_ops_desk::disputes` itself; `support_works_a_case_through_the_door`
//! adds one walk through the door's `ops.cardDispute*` calls with their scopes.
//!
//! Left out, and why: the cardholder half (`describe('the cardholder disputes their own charge (J-bank-15)')`) is
//! `cards_safety_db.rs`', which already ports it.
//!
//! Seeded, not driven: every test here needs a settled card payment to dispute, which `ops.cardAuthorize` and
//! `ops.cardCapture` leave; those moves are the slice's other half, so each test writes the authorisation and its capture
//! through the kit's `authorize` and `settle`. The TypeScript's MemoryLedger has no counterpart: svc-bank holds no
//! balance, so "nothing posts" is read as no settlement or transfer row of the dispute's own.
//!
//! Where the Rust differs: the TypeScript hands `CardDisputeService` the partner's terms apart from its issuer and swaps
//! them mid-test; here who bears the loss is read from the issuer's own terms, so the reported case is worked on a door
//! whose TEST partner reports them; and the TypeScript closes a case through `noCardIssuer` with its stand-in terms,
//! which the service as wired (`compose.ts`: `partnerTerms: () => cards.partnerTerms()`) would refuse, so that close
//! runs on the TEST partner here and the issuer-less close is shown refusing by name.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::card_ops_desk_kit::{
    self as kit, Auth, Bank, OPERATOR, Setup, arr, authorize, call, code_of, obj, s, settle, sim,
    uuid,
};
use crate::support::TestDb;

use service_kit::json::Json;
use svc_bank::card_ops_desk::disputes::{self as desk, CreditPartner};
use svc_bank::cards::Deps;
use svc_bank::cards::disputes::OpenAsk;
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::terms::{PartnerTerms, parse_dispute_cap};
use svc_bank::door::BankDoor;
use svc_bank::errors::Refusal;
use svc_bank::partner::refuse;

const SUPPORT: &str = "support-operator-a";

fn silent() -> PartnerTerms {
    PartnerTerms {
        balances: Some(vec![("USDT".to_owned(), "30".to_owned())]),
        ..PartnerTerms::nothing_reported()
    }
}

fn reported() -> PartnerTerms {
    PartnerTerms {
        loss_liability: Some((
            "programme".to_owned(),
            "TEST terms: the programme bears card fraud".to_owned(),
        )),
        ..silent()
    }
}

fn cap(raw: &str) -> Option<Vec<(String, String)>> {
    parse_dispute_cap(Some(raw)).unwrap()
}

fn bank() -> Option<Bank> {
    kit::bank_with(Setup {
        issuer: sim(silent()),
        cap: cap(r#"{"USDT":"100"}"#),
        ..Setup::default()
    })
}

fn on<T>(door: &BankDoor, f: impl FnOnce(&Deps<'_>) -> T) -> T {
    door.cards_deps(door.now(), f)
}

/// `captured(amount)`: a cardholder with one captured payment of `amount` USDT: `(user, card, reference)`.
fn captured(b: &Bank, amount: &str) -> (String, String, String) {
    let user = uuid();
    let card = b.card(&user, "USDT", None, "500");
    let reference = format!("auth-{}", uuid());
    let id = authorize(
        &b.db,
        &Auth {
            card: &card,
            reference: &reference,
            amount,
            ..Auth::default()
        },
    );
    settle(&b.db, &id, 1, "capture", amount, "ledger");
    (user, card, reference)
}

struct Opened {
    user: String,
    card: String,
    reference: String,
    case: Json,
    key: String,
}

fn ask<'a>(key: &'a str, card: &'a str, reference: &'a str, amount: &'a str) -> OpenAsk<'a> {
    OpenAsk {
        case_key: key,
        card_id: card,
        authorization_ref: reference,
        amount,
        reason: "TEST: not recognised",
        actor: SUPPORT,
    }
}

fn open_on(b: &Bank, door: &BankDoor, amount: &str) -> Opened {
    let (user, card, reference) = captured(b, amount);
    let key = format!("case-{}", uuid());
    let case = on(door, |d| {
        desk::open(d, &ask(&key, &card, &reference, amount))
    })
    .unwrap();
    Opened {
        user,
        card,
        reference,
        case,
        key,
    }
}

fn open(b: &Bank, amount: &str) -> Opened {
    open_on(b, &b.door, amount)
}

fn id(o: &Opened) -> String {
    s(&o.case, "id")
}

fn credit(door: &BankDoor, id: &str, partner: Option<&dyn CreditPartner>) -> Result<Json, Refusal> {
    on(door, |d| {
        desk::grant_provisional_credit(d, id, SUPPORT, partner.unwrap_or(d.issuer()))
    })
}

fn decide(door: &BankDoor, id: &str, outcome: &str) -> Result<Json, Refusal> {
    on(door, |d| desk::decide(d, id, outcome, SUPPORT, None))
}

fn get(door: &BankDoor, id: &str) -> Json {
    on(door, |d| desk::get(d, id)).unwrap()
}

fn evidence(door: &BankDoor, id: &str, key: &str, words: &str) -> Result<Json, Refusal> {
    on(door, |d| desk::add_evidence(d, id, key, words, SUPPORT))
}

fn representment(door: &BankDoor, id: &str, key: &str, actor: &str) -> Result<Json, Refusal> {
    on(door, |d| {
        desk::submit_representment(d, id, key, "TEST rep", actor)
    })
}

fn arbitration(door: &BankDoor, id: &str) -> Result<Json, Refusal> {
    on(door, |d| {
        desk::escalate_to_arbitration(d, id, &format!("arb-{}", uuid()), SUPPORT)
    })
}

fn balances(issuer: &Issuer, user: &str) -> Vec<(String, String)> {
    issuer.cardholder_balances(user).unwrap().unwrap()
}

fn usdt(v: &str) -> Vec<(String, String)> {
    vec![("USDT".to_owned(), v.to_owned())]
}

fn credit_of(case: &Json) -> Json {
    case.get("provisionalCredit").cloned().unwrap()
}

fn decision_of(case: &Json) -> Json {
    case.get("decision").cloned().unwrap()
}

/// What a dispute never writes: a settlement of its own, or a transfer.
fn posted(db: &TestDb) -> (i64, i64) {
    (
        db.count("SELECT count(*)::int8 FROM bank.card_settlements"),
        db.count("SELECT count(*)::int8 FROM bank.personal_transfers"),
    )
}

/// How a stand-in partner answers a credit: the TEST partner card, the request id, the cardholder, the asset, the amount.
type Answering<'a> =
    Box<dyn Fn(&Issuer, &str, &str, &str, &str) -> Result<(String, String), Refusal> + 'a>;

/// The TEST partner card, answering the credit as `answer` says.
struct Wrapped<'a> {
    inner: &'a Issuer,
    answer: Answering<'a>,
}

impl CreditPartner for Wrapped<'_> {
    fn programme_id(&self) -> &str {
        self.inner.programme().id
    }
    fn mutation_refuse(&self) -> Option<&'static str> {
        self.inner.mutation_refuse()
    }
    fn provisional_credit(
        &self,
        request_id: &str,
        user_id: &str,
        asset_id: &str,
        amount: &str,
    ) -> Result<(String, String), Refusal> {
        (self.answer)(self.inner, request_id, user_id, asset_id, amount)
    }
}

#[test]
fn opens_a_case_on_a_settled_capture_only_once_per_key_and_per_payment_the_queue_filters_by_state()
{
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let c = &o.case;
    assert_eq!(
        (
            s(c, "state"),
            s(c, "amount"),
            s(c, "assetId"),
            s(c, "test"),
            s(c, "decision")
        ),
        (
            "opened".into(),
            "50".into(),
            "USDT".into(),
            "true".into(),
            "null".into()
        )
    );
    let events = arr(c, "events");
    assert_eq!(events.len(), 1);
    assert_eq!(
        (
            s(&events[0], "sequence"),
            s(&events[0], "kind"),
            s(&events[0], "fromState"),
            s(&events[0], "toState"),
            s(&events[0], "actor")
        ),
        (
            "1".into(),
            "opened".into(),
            "null".into(),
            "opened".into(),
            SUPPORT.into()
        )
    );
    // The same key and figures is the same case; other figures, or a second case on the payment, refuse.
    let again = on(&b.door, |d| {
        desk::open(d, &ask(&o.key, &o.card, &o.reference, "50"))
    })
    .unwrap();
    assert_eq!(s(&again, "id"), id(&o));
    assert_eq!(
        code_of(on(&b.door, |d| desk::open(
            d,
            &ask(&o.key, &o.card, &o.reference, "40")
        ))),
        "bank.card_dispute_invalid"
    );
    let other = format!("other-{}", uuid());
    assert_eq!(
        code_of(on(&b.door, |d| desk::open(
            d,
            &OpenAsk {
                reason: "x",
                ..ask(&other, &o.card, &o.reference, "50")
            }
        ))),
        "bank.card_dispute_invalid"
    );
    // More than was captured, or a payment with no capture, is not disputable.
    let (_, card, reference) = captured(&b, "20");
    let k = format!("k-{}", uuid());
    assert_eq!(
        code_of(on(&b.door, |d| desk::open(
            d,
            &ask(&k, &card, &reference, "21")
        ))),
        "bank.card_dispute_not_disputable"
    );
    let held = format!("auth-{}", uuid());
    authorize(
        &b.db,
        &Auth {
            card: &card,
            reference: &held,
            amount: "5",
            ..Auth::default()
        },
    );
    let k = format!("k-{}", uuid());
    assert_eq!(
        code_of(on(&b.door, |d| desk::open(d, &ask(&k, &card, &held, "5")))),
        "bank.card_dispute_not_disputable"
    );

    let second = open(&b, "10");
    evidence(
        &b.door,
        &id(&second),
        &format!("ev-{}", uuid()),
        "TEST receipt",
    )
    .unwrap();
    representment(&b.door, &id(&second), &format!("rep-{}", uuid()), SUPPORT).unwrap();
    let ids = |state: Option<&str>| -> Vec<String> {
        arr(&on(&b.door, |d| desk::list(d, state)).unwrap(), "rows")
            .iter()
            .map(|r| s(r, "id"))
            .collect()
    };
    let opened = ids(Some("opened"));
    assert!(opened.contains(&id(&o)));
    assert!(!opened.contains(&id(&second)));
    assert_eq!(ids(Some("representment")), vec![id(&second)]);
    let all = ids(None);
    assert!(all.contains(&id(&o)) && all.contains(&id(&second)));
}

#[test]
fn keeps_evidence_after_submission_with_its_time_makes_arbitration_an_explicit_state_and_refuses_out_of_order_steps()
 {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let c = id(&o);
    assert_eq!(
        code_of(representment(
            &b.door,
            &c,
            &format!("rep-{}", uuid()),
            SUPPORT
        )),
        "bank.card_dispute_state"
    );
    assert_eq!(code_of(arbitration(&b.door, &c)), "bank.card_dispute_state");
    let ev = format!("ev-{}", uuid());
    evidence(&b.door, &c, &ev, "TEST receipt").unwrap();
    // A retried step is the same step.
    evidence(&b.door, &c, &ev, "TEST receipt").unwrap();
    representment(
        &b.door,
        &c,
        &format!("rep-{}", uuid()),
        "support-operator-b",
    )
    .unwrap();
    evidence(&b.door, &c, &format!("late-{}", uuid()), "TEST late letter").unwrap();
    let arb = arbitration(&b.door, &c).unwrap();
    assert_eq!(s(&arb, "state"), "arbitration");
    let steps: Vec<[String; 5]> = arr(&arb, "events")
        .iter()
        .map(|e| {
            [
                s(e, "kind"),
                s(e, "fromState"),
                s(e, "toState"),
                s(e, "actor"),
                s(e, "afterSubmission"),
            ]
        })
        .collect();
    let want = [
        ["opened", "null", "opened", SUPPORT, "false"],
        ["evidence", "opened", "opened", SUPPORT, "false"],
        [
            "representment",
            "opened",
            "representment",
            "support-operator-b",
            "false",
        ],
        [
            "evidence",
            "representment",
            "representment",
            SUPPORT,
            "true",
        ],
        [
            "arbitration",
            "representment",
            "arbitration",
            SUPPORT,
            "false",
        ],
    ];
    assert_eq!(
        steps,
        want.map(|r| r.map(str::to_owned)).to_vec(),
        "the timeline"
    );
    for e in arr(&arb, "events") {
        assert!(service_kit::time::js_date(&s(&e, "at")).is_some());
    }
    // The timeline is append-only.
    let err =
        b.db.client()
            .execute(
                "UPDATE bank.card_dispute_events SET actor = 'x' WHERE dispute_id = $1::text::uuid",
                &[&c],
            )
            .unwrap_err();
    assert!(format!("{err:?}").contains("append-only"), "{err:?}");
}

#[test]
fn asks_the_partner_s_provisional_credit_once_the_cardholder_s_available_rises_once_by_exactly_the_amount_and_nothing_posts()
 {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let issuer = &b.door.cards().issuer;
    let before = balances(issuer, &o.user);
    let posts = posted(&b.db);
    let credited = credit(&b.door, &id(&o), None).unwrap();
    let pc = credit_of(&credited);
    assert_eq!(
        (s(&pc, "state"), s(&pc, "amount")),
        ("credited".into(), "50".into())
    );
    let r = s(&pc, "partnerRef");
    let tail = r.strip_prefix("TEST-card-sim-credit-").unwrap();
    assert!(
        tail.len() == 16
            && tail
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "{r}"
    );
    // A second ask is the same credit.
    let again = credit(&b.door, &id(&o), None).unwrap();
    assert_eq!(s(&credit_of(&again), "partnerRef"), r);
    assert_eq!(before, usdt("30"));
    assert_eq!(balances(issuer, &o.user), usdt("80"));
    // Another cardholder's figure is untouched.
    assert_eq!(balances(issuer, &uuid()), usdt("30"));
    assert_eq!(
        arr(&credited, "events")
            .iter()
            .filter(|e| s(e, "kind") == "provisional_credit")
            .count(),
        1
    );
    assert_eq!(posted(&b.db), posts);
}

#[test]
fn records_who_bears_the_fraud_loss_from_the_partner_or_not_known_never_the_partner_by_default() {
    let Some(b) = bank() else { return };
    let silent_case = open(&b, "50");
    let closed = decide(&b.door, &id(&silent_case), "merchant").unwrap();
    assert_eq!(s(&closed, "state"), "closed");
    let dn = decision_of(&closed);
    assert_eq!(
        (
            s(&dn, "outcome"),
            s(&dn, "lossStatus"),
            s(&dn, "lossBearer"),
            s(&dn, "lossTerms")
        ),
        (
            "merchant".into(),
            "not_known".into(),
            "null".into(),
            "null".into()
        )
    );
    let events = arr(&closed, "events");
    let last = events.last().unwrap();
    assert_eq!(
        (s(last, "kind"), s(last, "toState"), s(last, "actor")),
        ("closed".into(), "closed".into(), SUPPORT.into())
    );
    assert!(s(last, "detail").contains("who bears the fraud loss is not known"));

    let door = b.rewired(Setup {
        issuer: sim(reported()),
        cap: cap(r#"{"USDT":"100"}"#),
        ..Setup::default()
    });
    let rep = open_on(&b, &door, "40");
    credit(&door, &id(&rep), None).unwrap();
    let closed = decide(&door, &id(&rep), "cardholder").unwrap();
    let dn = decision_of(&closed);
    assert_eq!(
        [
            s(&dn, "outcome"),
            s(&dn, "lossStatus"),
            s(&dn, "lossBearer"),
            s(&dn, "lossTerms"),
            s(&dn, "creditSettlement")
        ],
        [
            "cardholder",
            "reported",
            "programme",
            "TEST terms: the programme bears card fraud",
            "final"
        ]
        .map(str::to_owned)
    );
    // A closed case takes no further step, and the same decision again returns it.
    assert_eq!(
        s(&decide(&door, &id(&rep), "cardholder").unwrap(), "id"),
        id(&rep)
    );
    assert_eq!(
        code_of(decide(&door, &id(&rep), "merchant")),
        "bank.card_dispute_state"
    );
    assert_eq!(
        code_of(evidence(&door, &id(&rep), &format!("ev-{}", uuid()), "x")),
        "bank.card_dispute_state"
    );
    // The database refuses a reported loss with no bearer.
    let err =
        b.db.client()
            .execute(
                "UPDATE bank.card_disputes SET loss_bearer = NULL WHERE id = $1::text::uuid",
                &[&id(&rep)],
            )
            .unwrap_err();
    assert!(
        format!("{err:?}").contains("card_disputes_loss_shape"),
        "{err:?}"
    );
}

#[test]
fn a_decision_for_the_merchant_has_the_partner_reverse_its_provisional_credit() {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let issuer = &b.door.cards().issuer;
    credit(&b.door, &id(&o), None).unwrap();
    assert_eq!(balances(issuer, &o.user), usdt("80"));
    let closed = decide(&b.door, &id(&o), "merchant").unwrap();
    let dn = decision_of(&closed);
    assert_eq!(s(&dn, "creditSettlement"), "reversed");
    assert!(s(&dn, "creditSettlementPartnerRef").starts_with("TEST-card-sim-reversed-"));
    assert_eq!(balances(issuer, &o.user), usdt("30"));
}

#[test]
fn enforces_the_dispute_cap_above_it_refuses_blank_refuses_by_name_and_a_merchant_decision_needs_none()
 {
    let Some(b) = bank() else { return };
    let big = open(&b, "250");
    assert_eq!(
        code_of(credit(&b.door, &id(&big), None)),
        "bank.card_dispute_cap_exceeded"
    );
    assert_eq!(
        code_of(decide(&b.door, &id(&big), "cardholder")),
        "bank.card_dispute_cap_exceeded"
    );
    assert_eq!(s(&get(&b.door, &id(&big)), "state"), "opened");
    // Exactly at the cap is within it.
    let at_cap = open(&b, "100");
    credit(&b.door, &id(&at_cap), None).unwrap();
    assert_eq!(
        s(
            &decide(&b.door, &id(&at_cap), "cardholder").unwrap(),
            "state"
        ),
        "closed"
    );

    let blank_door = b.rewired(Setup {
        issuer: sim(silent()),
        cap: None,
        ..Setup::default()
    });
    let blank = open(&b, "10");
    assert_eq!(
        code_of(credit(&blank_door, &id(&blank), None)),
        "bank.card_dispute_cap_unset"
    );
    assert_eq!(
        code_of(decide(&blank_door, &id(&blank), "cardholder")),
        "bank.card_dispute_cap_unset"
    );
    // An asset the cap leaves out is not published either.
    let usdc_door = b.rewired(Setup {
        issuer: sim(silent()),
        cap: cap(r#"{"USDC":"100"}"#),
        ..Setup::default()
    });
    assert_eq!(
        code_of(decide(&usdc_door, &id(&blank), "cardholder")),
        "bank.card_dispute_cap_unset"
    );
    assert_eq!(
        s(
            &decide(&blank_door, &id(&big), "merchant").unwrap(),
            "state"
        ),
        "closed"
    );
}

#[test]
fn a_partner_that_cannot_answer_the_credit_leaves_the_ask_recorded_the_case_does_not_close_on_a_guess_and_a_retry_is_the_same_credit()
 {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let issuer = &b.door.cards().issuer;
    let fail = std::cell::Cell::new(true);
    let flaky = Wrapped {
        inner: issuer,
        answer: Box::new(|i, r, u, a, amt| {
            if fail.get() {
                return Err(Refusal::Other("partner down".to_owned()));
            }
            i.provisional_credit(r, u, a, amt)
        }),
    };
    match credit(&b.door, &id(&o), Some(&flaky)) {
        Err(Refusal::Other(m)) => assert_eq!(m, "partner down"),
        other => panic!("{other:?}"),
    }
    let asked = credit_of(&get(&b.door, &id(&o)));
    assert_eq!(
        (
            s(&asked, "state"),
            s(&asked, "amount"),
            s(&asked, "partnerRef")
        ),
        ("asked".into(), "null".into(), "null".into())
    );
    assert_eq!(
        code_of(decide(&b.door, &id(&o), "cardholder")),
        "bank.card_dispute_state"
    );
    fail.set(false);
    let credited = credit(&b.door, &id(&o), Some(&flaky)).unwrap();
    assert_eq!(s(&credit_of(&credited), "state"), "credited");
    assert_eq!(balances(issuer, &o.user), usdt("80"));
}

#[test]
fn with_no_card_partner_or_the_simulator_not_live_a_credit_refuses_by_name_nothing_is_recorded_and_the_case_still_closes()
 {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let issuer = &b.door.cards().issuer;
    assert_eq!(
        code_of(credit(&b.door, &id(&o), Some(&Issuer::None))),
        "bank.no_card_issuer"
    );
    assert_eq!(
        code_of(credit(&b.door, &id(&o), Some(&Issuer::SimNotLive))),
        "bank.card_sim_not_live"
    );
    let pc = credit_of(&get(&b.door, &id(&o)));
    assert_eq!(
        (s(&pc, "state"), s(&pc, "amount"), s(&pc, "partnerRef")),
        ("none".into(), "null".into(), "null".into())
    );
    // A partner that refuses by name after the ask is written takes nothing: the ask is taken back.
    let refusing = Wrapped {
        inner: issuer,
        answer: Box::new(|_, _, _, _, _| {
            Err(refuse(
                "bank.card_dispute_partner_unset",
                "TEST partner refuses",
            ))
        }),
    };
    assert_eq!(
        code_of(credit(&b.door, &id(&o), Some(&refusing))),
        "bank.card_dispute_partner_unset"
    );
    assert_eq!(s(&credit_of(&get(&b.door, &id(&o))), "state"), "none");
    let none = b.rewired(Setup {
        issuer: Issuer::None,
        cap: cap(r#"{"USDT":"100"}"#),
        ..Setup::default()
    });
    // The TypeScript test closes this case through `noCardIssuer` with its own stand-in terms (SILENT); wired as the
    // service runs it, an issuer-less deployment reads its terms from the issuer, which refuses by name, so the case
    // stays open there and closes on the TEST partner's terms.
    assert_eq!(
        code_of(decide(&none, &id(&o), "merchant")),
        "bank.no_card_issuer"
    );
    assert_eq!(s(&get(&b.door, &id(&o)), "state"), "opened");
    assert_eq!(
        s(&decide(&b.door, &id(&o), "merchant").unwrap(), "state"),
        "closed"
    );
}

#[test]
fn a_decision_for_the_cardholder_needs_the_partner_s_credit_first_once_a_decision_is_pinned_no_credit_is_asked_and_no_other_outcome_is_taken()
 {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    assert_eq!(
        code_of(decide(&b.door, &id(&o), "cardholder")),
        "bank.card_dispute_state"
    );
    assert_eq!(s(&get(&b.door, &id(&o)), "state"), "opened");
    // A decision pinned and then interrupted (the partner call or the write failed) holds its outcome.
    b.db.client()
        .execute(
            "UPDATE bank.card_disputes SET decision_requested_outcome = 'merchant' WHERE id = $1::text::uuid",
            &[&id(&o)],
        )
        .unwrap();
    assert_eq!(
        code_of(credit(&b.door, &id(&o), None)),
        "bank.card_dispute_state"
    );
    assert_eq!(
        code_of(decide(&b.door, &id(&o), "cardholder")),
        "bank.card_dispute_state"
    );
    assert_eq!(
        s(
            &decision_of(&decide(&b.door, &id(&o), "merchant").unwrap()),
            "outcome"
        ),
        "merchant"
    );
}

#[test]
fn a_partner_credit_of_another_amount_than_asked_is_not_recorded() {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let odd = Wrapped {
        inner: &b.door.cards().issuer,
        answer: Box::new(|i, r, u, a, amt| {
            let (partner_ref, _) = i.provisional_credit(r, u, a, amt)?;
            Ok((partner_ref, "500".to_owned()))
        }),
    };
    assert_eq!(
        code_of(credit(&b.door, &id(&o), Some(&odd))),
        "bank.card_dispute_partner_mismatch"
    );
    let pc = credit_of(&get(&b.door, &id(&o)));
    assert_eq!(
        (s(&pc, "state"), s(&pc, "amount"), s(&pc, "partnerRef")),
        ("asked".into(), "null".into(), "null".into())
    );
}

#[test]
fn a_step_key_is_one_step_the_same_key_for_another_step_refuses_and_a_typed_key_cannot_take_a_key_the_service_writes()
 {
    let Some(b) = bank() else { return };
    let o = open(&b, "50");
    let k = format!("ev-{}", uuid());
    evidence(&b.door, &id(&o), &k, "TEST receipt").unwrap();
    assert_eq!(
        code_of(on(&b.door, |d| desk::submit_representment(
            d,
            &id(&o),
            &k,
            "r",
            SUPPORT
        ))),
        "bank.card_dispute_invalid"
    );
    // A support key that spells the decision's own key lives under `step:`, so the decision still closes the case.
    evidence(
        &b.door,
        &id(&o),
        &format!("card-dispute-decision:{}", id(&o)),
        "TEST",
    )
    .unwrap();
    assert_eq!(
        s(&decide(&b.door, &id(&o), "merchant").unwrap(), "state"),
        "closed"
    );
}

#[test]
fn two_opens_of_the_same_case_at_once_are_one_case() {
    let Some(b) = bank() else { return };
    let (_, card, reference) = captured(&b, "30");
    let key = format!("case-{}", uuid());
    let one = || {
        on(&b.door, |d| {
            desk::open(
                d,
                &OpenAsk {
                    reason: "TEST",
                    ..ask(&key, &card, &reference, "30")
                },
            )
        })
        .unwrap()
    };
    let (x, y) = std::thread::scope(|sc| {
        let a = sc.spawn(one);
        let c = sc.spawn(one);
        (a.join().unwrap(), c.join().unwrap())
    });
    assert_eq!(s(&x, "id"), s(&y, "id"));
    assert_eq!(
        arr(&x, "events")
            .iter()
            .filter(|e| s(e, "kind") == "opened")
            .count(),
        1
    );
}

#[test]
fn parses_the_cap_blank_is_unpublished_and_malformed_refuses_to_start() {
    assert_eq!(parse_dispute_cap(None), Ok(None));
    assert_eq!(parse_dispute_cap(Some("  ")), Ok(None));
    assert!(
        parse_dispute_cap(Some(r#"{"USDC":"0"}"#))
            .unwrap_err()
            .contains("BANK_CARD_DISPUTE_CAP_JSON")
    );
    assert!(
        parse_dispute_cap(Some(r#"{"usdc":"10"}"#))
            .unwrap_err()
            .contains("BANK_CARD_DISPUTE_CAP_JSON")
    );
    assert!(
        parse_dispute_cap(Some("nope"))
            .unwrap_err()
            .contains("not JSON")
    );
    assert_eq!(
        parse_dispute_cap(Some(r#"{"USDC":"100.00"}"#)),
        Ok(Some(vec![("USDC".to_owned(), "100.00".to_owned())]))
    );
}

/// The door's `ops.cardDispute*` calls: reads take `admin:read`, steps `support:ops`, and each step's actor is the
/// signed-in operator. (No TypeScript test drives these through the router; this one shows the wiring.)
#[test]
fn support_works_a_case_through_the_door() {
    let Some(b) = bank() else { return };
    let (user, card, reference) = captured(&b, "40");
    let read = ["admin:read"];
    let ops = ["support:ops"];
    let key = format!("case-{}", uuid());
    let input = obj(&[
        ("caseKey", Json::str(key)),
        ("cardId", Json::str(card)),
        ("authorizationRef", Json::str(reference)),
        ("amount", Json::str("40")),
        ("reason", Json::str("TEST: not recognised")),
    ]);
    assert_eq!(
        call(&b, kit::OPERATOR, &read, "ops.cardDisputeOpen", &input).trpc(),
        "FORBIDDEN"
    );
    let opened = call(&b, OPERATOR, &ops, "ops.cardDisputeOpen", &input).ok();
    let c = s(&opened, "id");
    assert_eq!(s(&arr(&opened, "events")[0], "actor"), OPERATOR);
    assert_eq!(s(&opened, "userId"), user);
    let by_id = obj(&[("disputeId", Json::str(c.clone()))]);
    assert_eq!(
        call(&b, OPERATOR, &ops, "ops.cardDispute", &by_id).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        s(
            &call(&b, OPERATOR, &read, "ops.cardDispute", &by_id).ok(),
            "cap"
        ),
        "100"
    );
    let rows = arr(
        &call(
            &b,
            OPERATOR,
            &read,
            "ops.cardDisputes",
            &obj(&[("state", Json::str("opened"))]),
        )
        .ok(),
        "rows",
    );
    assert!(rows.iter().any(|r| s(r, "id") == c));
    call(
        &b,
        OPERATOR,
        &ops,
        "ops.cardDisputeEvidence",
        &obj(&[
            ("disputeId", Json::str(c.clone())),
            ("stepKey", Json::str(format!("ev-{}", uuid()))),
            ("description", Json::str("TEST receipt")),
        ]),
    )
    .ok();
    call(
        &b,
        OPERATOR,
        &ops,
        "ops.cardDisputeRepresentment",
        &obj(&[
            ("disputeId", Json::str(c.clone())),
            ("stepKey", Json::str(format!("rep-{}", uuid()))),
            ("description", Json::str("TEST rep")),
        ]),
    )
    .ok();
    let arb = call(
        &b,
        OPERATOR,
        &ops,
        "ops.cardDisputeArbitration",
        &obj(&[
            ("disputeId", Json::str(c.clone())),
            ("stepKey", Json::str(format!("arb-{}", uuid()))),
        ]),
    )
    .ok();
    assert_eq!(s(&arb, "state"), "arbitration");
    let credited = call(&b, OPERATOR, &ops, "ops.cardDisputeCredit", &by_id).ok();
    assert_eq!(s(&credit_of(&credited), "amount"), "40");
    assert_eq!(
        balances(&b.door.cards().issuer, &user),
        usdt("70"),
        "the partner's credit, on the partner's book"
    );
    let decide_input = |reason: &str| {
        obj(&[
            ("disputeId", Json::str(c.clone())),
            ("outcome", Json::str("cardholder")),
            ("reason", Json::str(reason)),
        ])
    };
    assert_eq!(
        call(
            &b,
            OPERATOR,
            &ops,
            "ops.cardDisputeDecide",
            &decide_input("")
        )
        .trpc(),
        "BAD_REQUEST"
    );
    let closed = call(
        &b,
        OPERATOR,
        &ops,
        "ops.cardDisputeDecide",
        &decide_input("TEST: the merchant did not answer"),
    )
    .ok();
    let dn = decision_of(&closed);
    assert_eq!(
        (
            s(&dn, "outcome"),
            s(&dn, "reason"),
            s(&dn, "creditSettlement")
        ),
        (
            "cardholder".into(),
            "TEST: the merchant did not answer".into(),
            "final".into()
        )
    );
    assert_eq!(s(arr(&closed, "events").last().unwrap(), "actor"), OPERATOR);
}
