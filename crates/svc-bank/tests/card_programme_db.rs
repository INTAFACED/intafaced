//! Slice `card-programme` against the Rust slice on a real Postgres. Ports the checks of the TypeScript's two suites
//! that fall on the slice's calls, each test named after the TypeScript test's words:
//! `cards/programme/programme-ops.db.test.ts` (the card programme desk) and `cards/programme-funding.money.test.ts`
//! (programme funding). A call on `CardProgrammeOps` or `CardService` is the slice's own function
//! (`svc_bank::card_programme`), given the dependencies the door gives it (`BankDoor::cards_deps`) and the slice's wiring.
//!
//! The authorisations, captures and reversals the TypeScript makes through `authorize`, `capture` and `reverse` (slice
//! `card-ops`, not ported) are written straight into `bank.card_authorizations`, `card_settlements` and
//! `card_authorization_traces` here, as those moves leave them.
//!
//! Not ported, with the reason: that a promoted rule declines a new authorisation, that a 3DS policy challenges or
//! exempts one, and that the simulator's TEST events drive the authorise and capture path are `card-ops`' (the
//! authorise path reads the rules and the policy); here the rule's shadow count, its promotion and roll back, the
//! exemption count over the traces, and the simulator's gate are tested. The ledger-journal assertions ("nothing
//! posts") hold by construction: no ledger is wired to these doors, so any post would refuse. A partner that fails
//! once after the approval is the TypeScript's hand-made issuer; the Rust issuer is a closed set, so the retry is
//! tested from the state that failure leaves (an approved row with no partner reference).
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use service_kit::approvals::{
    ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding, random_uuid,
};
use service_kit::json::Json;
use service_kit::money::parse_amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use sha2::{Digest, Sha256};
use svc_bank::card_programme::holders::{self, HolderAsk, Owner, uuid_from_key};
use svc_bank::card_programme::{Deps, Wiring, desk, funding};
use svc_bank::cards::core::{IssueAsk, issue};
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::terms::{PartnerTerms, sim_partner_for};
use svc_bank::cards::{Settings, Wiring as CardsWiring};
use svc_bank::door::{BankDoor, DoorConfig, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::loans::prices::{MarkQuality, Marks, PriceSource, QuotedMark};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::Wiring as SpacesWiring;
use svc_bank::spaces::ports::{DirError, Directory, Lookup};
use svc_bank::transfers::ports::{
    AccountOf, RecipientState, RecipientStatus, RecipientUnavailable,
};
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-card-programme-db-edge-secret-ok";
const INTERNAL: &str = "a-bank-card-programme-db-internal-secret";
const EXPORT_SECRET: &str = "test-secret-for-card-programme-exports";
const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
const APPROVER: &str = "88888888-8888-4888-8888-888888888888";
const LISTED: &str = "LOCAL TEST Sanctioned Cardholder";
/// programme-funding.money.test.ts's `AT`, the door's clock.
const AT: &str = "2026-11-08T12:00:00.000Z";
const FUND: &str = "bank.ops.requestCardProgrammeFunding";

fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

fn door_now() -> Instant {
    at(AT)
}

fn uuid() -> String {
    random_uuid().unwrap()
}

/// The TypeScript's `code(promise)`: the refusal's code (a decided refusal's cause).
fn code(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        Refusal::Trpc(t) => format!("{t:?}"),
        Refusal::Other(m) => panic!("not a refusal by name: {m}"),
    }
}

fn refused<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    code(&r.expect_err("expected a refusal"))
}

fn s(j: &Json, key: &str) -> Option<String> {
    match j.get(key) {
        Some(Json::String(v)) => Some(v.clone()),
        _ => None,
    }
}

fn n(j: &Json, key: &str) -> f64 {
    match j.get(key) {
        Some(Json::Number(v)) => *v,
        other => panic!("{key} is not a number: {other:?}"),
    }
}

fn list(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(v) => v.clone(),
        other => panic!("not a list: {other:?}"),
    }
}

fn field_list(j: &Json, key: &str) -> Vec<Json> {
    list(j.get(key).unwrap_or(&Json::Null))
}

/// programme-funding.money.test.ts's `REPORTED`, with the partner's figures and offers changed by `edit`.
fn reported_with(edit: impl FnOnce(&mut BTreeMap<&'static str, &'static str>)) -> PartnerTerms {
    let mut f: BTreeMap<&'static str, &'static str> = [
        ("custodyMode", r#""partner_holds""#),
        ("spendFrom", r#"["USDC","BTC","USD"]"#),
        ("lossLiability", "null"),
        (
            "reserve",
            r#"{"required":true,"amount":"25000","assetId":"USDC"}"#,
        ),
        ("funder", r#""TEST: the programme pre-funds in USDC""#),
        ("balances", "null"),
        (
            "programmeFigures",
            r#"{"USDT":{"held":"5","captured":"20"},"BTC":{"held":"0","captured":"0.0005"}}"#,
        ),
        ("figuresAsOf", r#""now""#),
        ("fundingAssetId", r#""USDC""#),
        (
            "fundingOffers",
            r#"{"fund":true,"defund":true,"autoReload":false}"#,
        ),
    ]
    .into_iter()
    .collect();
    edit(&mut f);
    let raw = format!(
        "{{{}}}",
        f.iter()
            .map(|(k, v)| format!("\"{k}\":{v}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    sim_partner_for(Some(&raw), Some("test"), None).unwrap()
}

fn reported() -> PartnerTerms {
    reported_with(|_| {})
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-identity's directory, verification tiers and approvals; svc-trade's ticker; svc-ledger's freeze.

/// `accounts` (email to user id) and `tiers`: the directory finds an account by email, identity answers its tier.
/// Emails to user ids, and user ids to their verification tier.
type Accounts = (BTreeMap<String, String>, BTreeMap<String, String>);

#[derive(Clone, Default)]
struct People(Arc<Mutex<Accounts>>);

impl People {
    /// `person(tier)`: a verified person the directory finds by email.
    fn person(&self, tier: &str) -> (String, String) {
        let user = uuid();
        let email = format!("p-{}@example.test", &user[..8]);
        let mut st = self.0.lock().unwrap();
        st.0.insert(email.clone(), user.clone());
        st.1.insert(user.clone(), tier.to_owned());
        (user, email)
    }
}

impl Directory for People {
    fn handles_of(&self, _: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok(BTreeMap::new())
    }
    fn find_active(&self, q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        let Lookup::Email(e) = q else { return Ok(None) };
        Ok(self
            .0
            .lock()
            .unwrap()
            .0
            .get(e)
            .map(|u| (u.clone(), "h".to_owned())))
    }
}

impl RecipientState for People {
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        Ok(self.0.lock().unwrap().1.get(user_id).map(|t| AccountOf {
            status: RecipientStatus::Active,
            kyc_tier: t.clone(),
        }))
    }
}

/// An approval bound to one action and its fields, consumed once.
/// Issued approvals (id to payload hash), the used ones, and how many were consumed.
type Issued = (BTreeMap<String, String>, BTreeSet<String>, usize);

#[derive(Clone, Default)]
struct Desk(Arc<Mutex<Issued>>);

impl Desk {
    fn issue(&self, kind: &str, amount: &str, threshold: &str) -> Vec<(&'static str, Json)> {
        let id = uuid();
        let fields = [
            ("kind".to_owned(), kind.to_owned()),
            ("amount".to_owned(), amount.to_owned()),
            ("threshold".to_owned(), threshold.to_owned()),
        ];
        self.0
            .lock()
            .unwrap()
            .0
            .insert(id.clone(), payload_hash(FUND, &fields));
        vec![
            ("approvalId", Json::str(id)),
            ("operationId", Json::str(uuid())),
        ]
    }
    fn consumed(&self) -> usize {
        self.0.lock().unwrap().2
    }
}

impl Approvals for Desk {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        _: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let mut st = self.0.lock().unwrap();
        let no = || ConsumeError::Refused("approval refused".to_owned());
        let hash = st.0.get(input.approval_id).cloned().ok_or_else(no)?;
        if hash != input.payload_hash || input.target_id != FUND || st.1.contains(input.approval_id)
        {
            return Err(no());
        }
        st.1.insert(input.approval_id.to_owned());
        st.2 += 1;
        Ok((
            Consumed {
                action_type: FUND.to_owned(),
                target_service: "svc-bank".to_owned(),
                target_id: FUND.to_owned(),
                status: "CONSUMED".to_owned(),
                requester_id: OPERATOR.to_owned(),
                approver_id: Some(APPROVER.to_owned()),
                approver_is_founder: Some(true),
                requester_is_founder: Some(true),
            },
            Facts {
                kind: None,
                expires_at: Instant(door_now().0 + 60_000).iso(),
            },
        ))
    }
}

/// `rates`: USDT in USDC at 0.9998 and BTC at 65000, as a TEST ticker; nothing else.
struct Rates;

impl PriceSource for Rates {
    fn marks(&self, assets: &[String], quote: &str) -> Marks {
        let mut out = Marks::new();
        for a in assets {
            let price = match (quote, a.as_str()) {
                ("USDC", "USDT") => "0.9998",
                ("USDC", "BTC") => "65000",
                _ => continue,
            };
            out.insert(
                a.clone(),
                QuotedMark::new(
                    a.clone(),
                    parse_amount(price).unwrap(),
                    door_now(),
                    MarkQuality::Mid,
                ),
            );
        }
        out
    }
}

struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door and the slice.

struct Bank {
    door: BankDoor,
    db: TestDb,
    people: People,
    desk: Desk,
    /// `sanctions`, `simulatorAllowed` and the export secret, as the slice's wiring holds them.
    sanctions: Option<String>,
    simulator_allowed: bool,
    export_secret: Option<String>,
}

fn door_for(db: &TestDb, people: &People, desk: &Desk, partner: PartnerTerms) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut spaces = SpacesWiring::none();
    spaces.directory = Box::new(people.clone());
    let mut transfers = TransfersWiring::none();
    transfers.recipients = Box::new(people.clone());
    transfers.approvals = Box::new(desk.clone());
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: None,
        freeze: Box::new(Open),
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(spaces)
    .with_transfers(transfers)
    .with_cards(CardsWiring {
        issuer: Issuer::sim(partner),
        rank: Box::new(NoRank),
        holds: Default::default(),
        settings: Settings::default(),
    })
}

struct NoRank;

impl svc_bank::cards::RankTier for NoRank {
    fn card_tier_of(&self, _: &str) -> Result<String, Refusal> {
        Ok("none".to_owned())
    }
}

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let people = People::default();
    let desk = Desk::default();
    let door = door_for(&db, &people, &desk, reported());
    Some(Bank {
        door,
        db,
        people,
        desk,
        sanctions: Some(LISTED.to_owned()),
        simulator_allowed: true,
        export_secret: Some(EXPORT_SECRET.to_owned()),
    })
}

impl Bank {
    /// The same database, people and approvals, with the card partner answering `partner`.
    fn with_partner(&mut self, partner: PartnerTerms) {
        self.door = door_for(&self.db, &self.people, &self.desk, partner);
    }

    /// `f` given the slice's dependencies, as the door hands them over.
    fn ops<T>(&self, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        let w = Wiring {
            sanctions: self.sanctions.clone(),
            simulator_allowed: self.simulator_allowed,
            export_secret: self.export_secret.clone(),
            rates: Box::new(Rates),
        };
        self.door
            .cards_deps(door_now(), |cards| f(&Deps { cards, w: &w }))
    }

    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }

    fn count(&self, q: &str) -> i64 {
        self.db.count(q)
    }

    /// `cardFor(userId)`: a USDT card with a per-authorisation limit of 500; its id and last four digits.
    fn card_for(&self, user: &str) -> (String, String) {
        let card = self.ops(|d| {
            issue(
                d.cards,
                &IssueAsk {
                    card_id: uuid(),
                    user_id: user.to_owned(),
                    asset_id: "USDT".to_owned(),
                    per_authorization_limit: parse_amount("500").unwrap(),
                    ..IssueAsk::default()
                },
            )
            .unwrap()
        });
        (card.id, card.pan_tail)
    }

    /// `createCardholder(OPERATOR, ...)` for an individual.
    fn individual(&self, key: &str, name: &str, email: &str) -> Result<Json, Refusal> {
        self.ops(|d| {
            holders::create_cardholder(
                d,
                OPERATOR,
                &HolderAsk {
                    request_key: key,
                    kind: "individual",
                    name,
                    email: Some(email),
                    country: "NL",
                    owners: Vec::new(),
                },
            )
        })
    }

    fn business(&self, key: &str, name: &str, owners: Vec<Owner>) -> Result<Json, Refusal> {
        self.ops(|d| {
            holders::create_cardholder(
                d,
                OPERATOR,
                &HolderAsk {
                    request_key: key,
                    kind: "business",
                    name,
                    email: None,
                    country: "NL",
                    owners,
                },
            )
        })
    }
}

/// An authorisation as `authorize` leaves it (slice `card-ops`): its id.
struct Auth<'a> {
    card: &'a str,
    reference: &'a str,
    amount: &'a str,
    channel: &'a str,
    merchant: Option<&'a str>,
    /// `None` approves; a decline names its code.
    decline: Option<&'a str>,
    trace: Option<&'a str>,
}

impl Default for Auth<'_> {
    fn default() -> Self {
        Auth {
            card: "",
            reference: "",
            amount: "1",
            channel: "card-present",
            merchant: None,
            decline: None,
            trace: None,
        }
    }
}

fn authorize(b: &Bank, a: &Auth<'_>) -> String {
    let id = uuid();
    let decision = if a.decline.is_some() {
        "declined"
    } else {
        "approved"
    };
    let status = if a.decline.is_some() {
        "rejected"
    } else {
        "settled"
    };
    let hold = a.decline.is_none().then(|| format!("tx-{id}"));
    let mut c = b.db.client();
    c.execute(
        "INSERT INTO bank.card_authorizations (id, card_id, authorization_ref, amount, merchant_category, decision, \
           decline_code, status, hold_ledger_tx_id, channel, decided_at) \
         VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::numeric, $5, $6::text::bank.card_decision, $7, \
           $8::text::bank.loan_event_status, $9, $10, $11::text::timestamptz)",
        &[&id, &a.card, &a.reference, &a.amount, &a.merchant, &decision, &a.decline, &status, &hold, &a.channel, &AT],
    )
    .unwrap();
    if let Some(steps) = a.trace {
        c.execute(
            "INSERT INTO bank.card_authorization_traces (authorization_id, steps) VALUES ($1::text::uuid, $2::text::jsonb)",
            &[&id, &steps],
        )
        .unwrap();
    }
    id
}

/// A settled capture or reversal on an authorisation, as `capture` and `reverse` leave it.
fn settle(b: &Bank, auth: &str, sequence: i32, kind: &str, amount: &str) {
    b.db.client()
        .execute(
            "INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount, status, ledger_tx_id, settled_at) \
             VALUES ($1::text::uuid, $2, $3::text::bank.card_settlement_kind, $4::text::numeric, 'settled', $5, $6::text::timestamptz)",
            &[&auth, &sequence, &kind, &amount, &format!("tx-{auth}-{sequence}"), &AT],
        )
        .unwrap();
}

fn params(kind: &str, rest: &[(&str, &str)]) -> Json {
    let mut f = vec![("kind".to_owned(), Json::str(kind))];
    f.extend(rest.iter().map(|(k, v)| ((*k).to_owned(), Json::str(*v))));
    Json::Object(f)
}

fn version(rules: &Json, v: f64) -> Json {
    list(rules)
        .into_iter()
        .find(|r| n(r, "version") == v)
        .unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// programme-ops.db.test.ts

#[test]
fn a_shadow_rule_counts_what_it_would_decline_over_past_test_authorisations_decides_nothing_and_roll_back_restores_the_version_before()
 {
    let Some(b) = bank() else { return };
    let (p, _) = b.people.person("full");
    let (card, _) = b.card_for(&p);
    for i in 0..10 {
        authorize(
            &b,
            &Auth {
                card: &card,
                reference: &format!("past-{i}"),
                merchant: Some(if i < 3 { "gambling" } else { "groceries" }),
                ..Auth::default()
            },
        );
    }
    let gambling = params("merchant_category", &[("category", "gambling")]);
    let shadow = b
        .ops(|d| desk::create_rule(d, OPERATOR, "no-gambling", "No gambling", &gambling))
        .unwrap();
    assert_eq!(s(&shadow, "state").as_deref(), Some("shadow"));
    assert_eq!(n(&shadow, "version"), 1.0);
    let counted = shadow.get("shadow").unwrap();
    assert_eq!(
        (n(counted, "evaluated"), n(counted, "wouldDecline")),
        (10.0, 3.0)
    );
    // In shadow it decides nothing: no past decision changed.
    let approved =
        "SELECT count(*)::int8 FROM bank.card_authorizations WHERE decision = 'approved'";
    assert_eq!(b.count(approved), 10);
    b.ops(|d| desk::promote_rule(d, OPERATOR, &s(&shadow, "id").unwrap()))
        .unwrap();
    assert_eq!(
        b.count(approved),
        10,
        "promoting a rule changes no past decision"
    );
    let active = desk::rules(&mut b.db.client()).unwrap();
    let v1 = list(&Json::Array(active))
        .into_iter()
        .find(|r| n(r, "version") == 1.0)
        .unwrap();
    assert_eq!(s(&v1, "state").as_deref(), Some("active"));

    // Version 2 (a stricter amount rule under the same key) replaces version 1; rolling back puts version 1 back.
    let stricter = params("amount_above", &[("assetId", "USDT"), ("amount", "0.5")]);
    let v2 = b
        .ops(|d| desk::create_rule(d, OPERATOR, "no-gambling", "No gambling v2", &stricter))
        .unwrap();
    assert_eq!(n(counted_of(&v2), "wouldDecline"), 10.0);
    let v2_id = s(&v2, "id").unwrap();
    b.ops(|d| desk::promote_rule(d, OPERATOR, &v2_id)).unwrap();
    let rolled = b
        .ops(|d| desk::rollback_rule(d, OPERATOR, "no-gambling"))
        .unwrap();
    assert_eq!(
        s(&version(&rolled, 1.0), "state").as_deref(),
        Some("active")
    );
    assert_eq!(
        s(&version(&rolled, 2.0), "state").as_deref(),
        Some("retired")
    );
    assert_eq!(
        refused(b.ops(|d| desk::promote_rule(d, OPERATOR, &v2_id))),
        "bank.card_rule_state"
    );
    b.ops(|d| desk::rollback_rule(d, OPERATOR, "no-gambling"))
        .unwrap();
    assert_eq!(
        refused(b.ops(|d| desk::rollback_rule(d, OPERATOR, "no-gambling"))),
        "bank.card_rule_state"
    );
    assert_eq!(b.count(approved), 10);
}

fn counted_of(rule: &Json) -> &Json {
    rule.get("shadow").unwrap()
}

#[test]
fn three_ds_an_online_payment_under_the_exemption_limit_is_counted_and_clearing_the_policy_asks_no_challenge_again()
 {
    let Some(b) = bank() else { return };
    let (p, _) = b.people.person("full");
    let (card, _) = b.card_for(&p);
    let policy = Json::Object(vec![
        ("mode".to_owned(), Json::str("challenge_all")),
        (
            "lowValueExemption".to_owned(),
            Json::obj([
                ("assetId", Json::str("USDT")),
                ("limit", Json::str("30.00")),
            ]),
        ),
    ]);
    b.ops(|d| desk::configure(d, OPERATOR, "threeds", &policy))
        .unwrap();
    let held = |j: &Json| {
        desk::settings(&mut b.db.client())
            .unwrap()
            .get("threeds")
            .and_then(|v| v.get("value"))
            .map(Json::compact)
            == Some(j.compact())
    };
    assert!(held(&policy), "the policy is stored as given");
    // A policy out of shape refuses and stores nothing.
    let bad = Json::obj([("mode", Json::str("sometimes"))]);
    assert_eq!(
        refused(b.ops(|d| desk::configure(d, OPERATOR, "threeds", &bad))),
        "bank.card_programme_invalid"
    );
    assert!(held(&policy));
    let skip = r#"[{"check":"3DS policy","result":"skip","detail":"SCA low-value exemption: 25 USDT is under the exemption limit of 30.00 USDT, so the challenge was skipped."}]"#;
    let exempt = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "online-25",
            amount: "25.00",
            channel: "online",
            trace: Some(skip),
            ..Auth::default()
        },
    );
    authorize(
        &b,
        &Auth {
            card: &card,
            reference: "online-40",
            amount: "40",
            channel: "online",
            decline: Some("bank.card_3ds_required"),
            trace: Some(
                r#"[{"check":"3DS policy","result":"decline","detail":"challenge required"}]"#,
            ),
            ..Auth::default()
        },
    );
    let trace = field_list(
        &b.ops(|d| desk::authorization(d, &exempt)).unwrap(),
        "trace",
    );
    let step = trace
        .iter()
        .find(|t| s(t, "check").as_deref() == Some("3DS policy"))
        .unwrap();
    assert_eq!(
        step.compact(),
        Json::obj([
            ("check", Json::str("3DS policy")),
            ("result", Json::str("skip")),
            (
                "detail",
                Json::str("SCA low-value exemption: 25 USDT is under the exemption limit of 30.00 USDT, so the challenge was skipped.")
            ),
        ])
        .compact()
    );
    assert_eq!(desk::exemption_count(&mut b.db.client()).unwrap(), 1);
    b.ops(|d| desk::clear_three_ds(d, OPERATOR)).unwrap();
    let cleared = desk::settings(&mut b.db.client()).unwrap();
    assert!(
        matches!(cleared.get("threeds"), None | Some(Json::Null)),
        "{cleared:?}"
    );
}

#[test]
fn lifecycle_and_capture_variance_a_25_hold_captured_at_20_shows_20_captured_5_given_back_and_a_variance_of_minus_5()
 {
    let Some(b) = bank() else { return };
    let (p, _) = b.people.person("full");
    let (card, _) = b.card_for(&p);
    let a = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "cap",
            amount: "25",
            trace: Some(
                r#"[{"check":"Card status","result":"pass","detail":"active"},{"check":"Hold","result":"pass","detail":"25 USDT held"}]"#,
            ),
            ..Auth::default()
        },
    );
    settle(&b, &a, 1, "capture", "20");
    settle(&b, &a, 2, "reversal", "5");
    let d = b.ops(|d| desk::authorization(d, &a)).unwrap();
    assert_eq!(
        d.get("variance").unwrap().compact(),
        r#"{"authorised":"25","captured":"20","returned":"5","stillHeld":"0","captureVariance":"-5"}"#
    );
    let events: Vec<String> = field_list(&d, "lifecycle")
        .iter()
        .map(|e| s(e, "event").unwrap())
        .collect();
    assert_eq!(events, ["authorised", "captured", "given back"]);
    let last = field_list(&d, "trace").last().cloned().unwrap();
    assert_eq!(
        (s(&last, "check"), s(&last, "result")),
        (Some("Hold".to_owned()), Some("pass".to_owned()))
    );
    assert_eq!(
        refused(b.ops(|d| desk::authorization(d, &uuid()))),
        "bank.ops_authorization_not_found"
    );
    assert_eq!(
        refused(b.ops(|d| desk::authorization(d, "not-a-uuid"))),
        "bank.ops_authorization_not_found"
    );
}

#[test]
fn the_kyc_and_kyb_gate_a_business_with_no_beneficial_owner_lands_in_the_review_queue_screening_with_no_list_refuses_and_stores_nothing()
 {
    let Some(mut b) = bank() else { return };
    assert_eq!(
        refused(b.business("biz-no-owner-1", "TEST Shop Ltd", Vec::new())),
        "bank.cardholder_unverified"
    );
    let queue = list(&holders::review_queue(&mut b.db.client()).unwrap());
    assert_eq!(queue.len(), 1);
    assert_eq!(s(&queue[0], "name").as_deref(), Some("TEST Shop Ltd"));
    assert_eq!(s(&queue[0], "status").as_deref(), Some("review"));
    assert_eq!(
        s(&queue[0], "gapCode").as_deref(),
        Some("bank.cardholder_unverified")
    );
    assert!(
        s(&queue[0], "gap")
            .unwrap()
            .contains("No beneficial owner on file")
    );
    // The same key replays the same refusal; other details under it conflict.
    assert_eq!(
        refused(b.business("biz-no-owner-1", "TEST Shop Ltd", Vec::new())),
        "bank.cardholder_unverified"
    );
    assert_eq!(
        refused(b.business("biz-no-owner-1", "Other", Vec::new())),
        "bank.cardholder_conflict"
    );
    // With a verified owner the business passes.
    let (_, owner) = b.people.person("full");
    let ok = b
        .business(
            "biz-owner-1",
            "TEST Owned Ltd",
            vec![Owner {
                name: "TEST Owner".to_owned(),
                email: owner,
            }],
        )
        .unwrap();
    assert_eq!(s(&ok, "status").as_deref(), Some("verified"));
    // An individual below the full level is unverified; a name on the list is under review.
    let (_, low) = b.people.person("basic");
    assert_eq!(
        refused(b.individual("low-tier-1", "Low", &low)),
        "bank.cardholder_unverified"
    );
    let (_, listed) = b.people.person("full");
    assert_eq!(
        refused(b.individual("listed-1", "local test sanctioned  cardholder", &listed)),
        "bank.cardholder_under_review"
    );
    b.sanctions = Some(String::new());
    assert_eq!(
        refused(b.individual("no-list-1", "N", &listed)),
        "bank.cardholder_screening_unset"
    );
    assert_eq!(
        b.count("SELECT count(*)::int8 FROM bank.card_cardholders WHERE request_key = 'no-list-1'"),
        0
    );
    b.sanctions = None;
    assert_eq!(
        refused(b.individual("no-list-2", "N", &listed)),
        "bank.cardholder_screening_unset"
    );
    // Directory search by a card's last four digits.
    b.sanctions = Some(LISTED.to_owned());
    let (holder, email) = b.people.person("full");
    let ch = b.individual("search-1", "TEST Searcher", &email).unwrap();
    let (_, tail) = b.card_for(&holder);
    let found = list(&holders::cardholders(&mut b.db.client(), Some(&tail)).unwrap());
    assert!(
        found.iter().any(|h| s(h, "id") == s(&ch, "id")),
        "{found:?}"
    );
}

#[test]
fn a_viewer_reads_and_changes_nothing_every_change_is_in_the_audit_log_which_cannot_be_edited() {
    let Some(b) = bank() else { return };
    let (viewer, email) = b.people.person("full");
    b.ops(|d| desk::assign_staff(d, OPERATOR, &email, "viewer"))
        .unwrap();
    let bin = |n: &str, range: &str| {
        Json::obj([
            ("bin", Json::str(n)),
            ("network", Json::str("TEST network")),
            ("range", Json::str(range)),
        ])
    };
    assert_eq!(
        refused(b.ops(|d| desk::configure(d, &viewer, "bin", &bin("400000", "shared")))),
        "bank.card_programme_viewer"
    );
    let atm = params("channel", &[("channel", "atm")]);
    assert_eq!(
        refused(b.ops(|d| desk::create_rule(d, &viewer, "x-rule", "X", &atm))),
        "bank.card_programme_viewer"
    );
    assert_eq!(
        refused(b.ops(|d| desk::assign_staff(d, OPERATOR, "none@x.test", "viewer"))),
        "bank.card_programme_invalid"
    );
    b.ops(|d| desk::configure(d, OPERATOR, "bin", &bin("400000", "shared")))
        .unwrap();
    b.ops(|d| desk::configure(d, OPERATOR, "bin", &bin("400001", "dedicated")))
        .unwrap();
    let log = list(&desk::audit_log(&mut b.db.client()).unwrap());
    assert_eq!(s(&log[0], "actor").as_deref(), Some(OPERATOR));
    assert_eq!(s(&log[0], "action").as_deref(), Some("setting.bin"));
    assert_eq!(s(&log[0], "target").as_deref(), Some("bin"));
    assert!(s(&log[0], "before").unwrap().contains(r#""bin":"400000""#));
    assert!(s(&log[0], "after").unwrap().contains(r#""bin":"400001""#));
    assert!(
        log.iter()
            .any(|e| s(e, "action").as_deref() == Some("staff.assign"))
    );
    for q in [
        "UPDATE bank.card_programme_audit SET actor = 'someone else'",
        "DELETE FROM bank.card_programme_audit",
    ] {
        let err = b.db.client().batch_execute(q).unwrap_err();
        assert!(format!("{err:?}").contains("written once"), "{err:?}");
    }
}

#[test]
fn bulk_issue_a_file_with_one_bad_row_lists_it_and_issues_nothing_the_good_rows_issued_twice_make_their_cards_once()
 {
    let Some(b) = bank() else { return };
    let (_, a) = b.people.person("full");
    let (_, bb) = b.people.person("full");
    let ha = s(&b.individual("bulk-holder-a", "A", &a).unwrap(), "id").unwrap();
    let hb = s(&b.individual("bulk-holder-b", "B", &bb).unwrap(), "id").unwrap();
    let good = [
        format!("{ha},USDT,50"),
        format!("{ha},USDT,60"),
        format!("{hb},USDT,50"),
        format!("{hb},USDT,60"),
    ];
    let bad = [
        vec!["cardholder_id,asset,per_authorisation_limit".to_owned()],
        good[..2].to_vec(),
        vec![format!("{},USDT,50", uuid())],
        good[2..].to_vec(),
    ]
    .concat()
    .join("\n");
    let checked = b.ops(|d| holders::validate_bulk_json(d, &bad)).unwrap();
    assert_eq!(checked.get("ok"), Some(&Json::Bool(false)));
    let bad_rows: Vec<f64> = field_list(&checked, "rows")
        .iter()
        .filter(|r| !matches!(r.get("error"), None | Some(Json::Null)))
        .map(|r| n(r, "row"))
        .collect();
    assert_eq!(bad_rows, [3.0]);
    assert_eq!(
        refused(b.ops(|d| holders::issue_bulk(d, OPERATOR, &bad))),
        "bank.card_bulk_invalid"
    );
    assert_eq!(b.count("SELECT count(*)::int8 FROM bank.cards"), 0);
    let file = good.join("\n");
    let first = b.ops(|d| holders::issue_bulk(d, OPERATOR, &file)).unwrap();
    let second = b.ops(|d| holders::issue_bulk(d, OPERATOR, &file)).unwrap();
    let ids = |j: &Json| -> Vec<String> {
        field_list(j, "cards")
            .iter()
            .map(|c| s(c, "cardId").unwrap())
            .collect()
    };
    assert_eq!(ids(&first).len(), 4);
    assert_eq!(ids(&second), ids(&first));
    assert_eq!(n(&second, "cardsInBatch"), 4.0);
    assert_eq!(b.count("SELECT count(*)::int8 FROM bank.cards"), 4);
    let batch = s(&first, "batchId").unwrap();
    assert_eq!(
        ids(&first)[0],
        uuid_from_key(&format!("card-bulk:{batch}:1"))
    );
    let canonical = good
        .iter()
        .map(|l| l.to_lowercase().replace("usdt", "USDT"))
        .collect::<Vec<_>>()
        .join("\n");
    let digest: String = Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    assert_eq!(batch, digest);
}

#[test]
fn reassign_moves_a_card_with_no_open_hold_to_a_verified_cardholder_and_refuses_one_with_an_open_hold_nothing_posts()
 {
    let Some(b) = bank() else { return };
    let (a, _) = b.people.person("full");
    let (bu, bmail) = b.people.person("full");
    let hb = s(
        &b.individual("reassign-holder-b", "B", &bmail).unwrap(),
        "id",
    )
    .unwrap();
    let (card, _) = b.card_for(&a);
    let open = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "open-hold",
            amount: "5",
            ..Auth::default()
        },
    );
    assert_eq!(
        refused(b.ops(|d| holders::reassign(d, OPERATOR, &card, &hb))),
        "bank.card_reassign_open_hold"
    );
    settle(&b, &open, 1, "reversal", "5");
    let moved = b
        .ops(|d| holders::reassign(d, OPERATOR, &card, &hb))
        .unwrap();
    assert_eq!(s(&moved, "cardholderId"), Some(hb.clone()));
    let owner: String =
        b.db.client()
            .query_one(
                "SELECT user_id FROM bank.cards WHERE id = $1::text::uuid",
                &[&card],
            )
            .unwrap()
            .get(0);
    assert_eq!(owner, bu);
    assert_eq!(
        b.count("SELECT count(*)::int8 FROM bank.card_reassignments"),
        1
    );
    // Back to the same holder refuses; an unknown cardholder is not found.
    assert_eq!(
        refused(b.ops(|d| holders::reassign(d, OPERATOR, &card, &hb))),
        "bank.card_reassign_same"
    );
    assert_eq!(
        refused(b.ops(|d| holders::reassign(d, OPERATOR, &card, &uuid()))),
        "bank.cardholder_not_found"
    );
}

#[test]
fn the_simulator_runs_on_a_test_stack_only_and_its_events_are_card_ops() {
    let Some(mut b) = bank() else { return };
    let (p, email) = b.people.person("full");
    let (card, _) = b.card_for(&p);
    // On a test stack the gate passes, and the event itself is slice card-ops' (not ported), writing nothing.
    let not_ported = refused(b.ops(|d| holders::simulate(d, OPERATOR, &card)));
    assert!(not_ported.contains("card-ops"), "{not_ported}");
    assert_eq!(
        b.count("SELECT count(*)::int8 FROM bank.card_programme_audit"),
        0
    );
    b.ops(|d| desk::assign_staff(d, OPERATOR, &email, "viewer"))
        .unwrap();
    assert_eq!(
        refused(b.ops(|d| holders::simulate(d, &p, &card))),
        "bank.card_programme_viewer"
    );
    b.simulator_allowed = false;
    assert_eq!(
        refused(b.ops(|d| holders::simulate(d, OPERATOR, &card))),
        "bank.card_sim_not_live"
    );
}

#[test]
fn the_export_is_signed_over_its_text_carries_its_freshness_time_and_its_totals_equal_the_report() {
    let Some(mut b) = bank() else { return };
    let (p, _) = b.people.person("full");
    let (card, _) = b.card_for(&p);
    authorize(
        &b,
        &Auth {
            card: &card,
            reference: "r1",
            amount: "3",
            ..Auth::default()
        },
    );
    authorize(
        &b,
        &Auth {
            card: &card,
            reference: "r2",
            amount: "900",
            decline: Some("bank.card_limit_exceeded"),
            ..Auth::default()
        },
    );
    let report = b.ops(|d| desk::report(d, &mut b.db.client())).unwrap();
    assert_eq!(
        report.json().get("totals").unwrap().compact(),
        r#"{"approved":1,"declined":1}"#
    );
    let file = b.ops(|d| desk::export_report(d, OPERATOR)).unwrap();
    let text = s(&file, "text").unwrap();
    let digest: String = Sha256::digest(text.as_bytes())
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    assert_eq!(s(&file, "sha256"), Some(digest));
    let sig = s(&file, "signature").unwrap();
    assert!(
        sig.len() == 64
            && sig
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "{sig}"
    );
    assert!(text.contains(&format!("As of (UTC): {}", s(&file, "asOf").unwrap())));
    assert!(text.contains("USDT,1,3,1"), "{text}");
    assert!(text.contains("total,1,,1"), "{text}");
    b.export_secret = None;
    assert_eq!(
        refused(b.ops(|d| desk::export_report(d, OPERATOR))),
        "bank.card_report_signing_unset"
    );
}

#[test]
fn the_checklist_names_the_simulated_issuer_as_rail_card_and_offers_no_go_live_step() {
    let Some(b) = bank() else { return };
    let items = list(&b.ops(|d| desk::checklist(d, &mut b.db.client())).unwrap());
    let issuer = items
        .iter()
        .find(|i| s(i, "id").as_deref() == Some("issuer"))
        .unwrap();
    assert_eq!(issuer.get("done"), Some(&Json::Bool(false)));
    assert!(s(issuer, "blocker").unwrap().contains("rail.card"));
    assert!(
        items
            .iter()
            .all(|i| s(i, "id").as_deref() != Some("go_live"))
    );
}

// ---------------------------------------------------------------------------------------------------------------
// programme-funding.money.test.ts

/// The call's words for a figure the app or the partner does not have (`ops/card-programme.ts`): the TypeScript suite
/// reads the service's `null` before the router turns it into these.
const MISSING: &str = "missing";
const NOT_KNOWN: &str = "not known";

fn row<'a>(view: &'a [Json], asset: &str) -> &'a Json {
    view.iter()
        .find(|r| s(r, "assetId").as_deref() == Some(asset))
        .unwrap()
}

fn has(r: &Json, want: &[(&str, Option<&str>)]) {
    for (k, v) in want {
        assert_eq!(s(r, k).as_deref(), *v, "{k} in {}", r.compact());
    }
}

#[test]
fn reconciles_open_holds_and_captures_against_the_partner_matches_a_break_and_not_known_where_the_partner_is_silent()
 {
    let Some(mut b) = bank() else { return };
    let user = uuid();
    let (card, _) = b.card_for(&user);
    authorize(
        &b,
        &Auth {
            card: &card,
            reference: "r-open",
            amount: "5",
            ..Auth::default()
        },
    );
    let cap = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "r-cap",
            amount: "25",
            ..Auth::default()
        },
    );
    settle(&b, &cap, 1, "capture", "20");
    settle(&b, &cap, 2, "reversal", "5");

    let view = field_list(&b.ops(funding::view).unwrap(), "rows");
    // 5 open, 20 captured (the 5 remainder returned): 25, equal to the partner's 5 + 20.
    has(
        row(&view, "USDT"),
        &[
            ("appHeld", Some("5")),
            ("appCaptured", Some("20")),
            ("appFigure", Some("25")),
            ("partnerFigure", Some("25")),
            ("difference", Some("0")),
            ("status", Some("matches")),
            ("partnerAsOf", Some(AT)),
            ("partnerState", Some("known")),
            // The stablecoin conversion: 25 USDT at 0.9998 USDC, rounded up.
            ("fundingRate", Some("0.9998")),
            ("fundingRateAsOf", Some(AT)),
            ("appFigureInFunding", Some("24.995")),
        ],
    );
    // Planted fault: a partner capture the app has no record of is a break by name, never read as 0.
    has(
        row(&view, "BTC"),
        &[
            ("appHeld", Some(MISSING)),
            ("appCaptured", Some(MISSING)),
            ("appFigure", Some(MISSING)),
            ("partnerFigure", Some("0.0005")),
            ("difference", Some(NOT_KNOWN)),
            ("status", Some("missing")),
            ("appFigureInFunding", Some(NOT_KNOWN)),
        ],
    );

    // The same figures sent with no time are "not known", so never "matches"; with a time past the partner's limit they
    // are shown, and said to be stale.
    b.with_partner(reported_with(|f| {
        f.insert("figuresAsOf", "null");
    }));
    for r in field_list(&b.ops(funding::view).unwrap(), "rows") {
        has(
            &r,
            &[
                ("partnerFigure", Some(NOT_KNOWN)),
                ("difference", Some(NOT_KNOWN)),
                ("status", Some("not_known")),
                ("partnerAsOf", Some(NOT_KNOWN)),
                ("partnerState", Some("unknown")),
            ],
        );
    }
    let old = Instant(door_now().0 - reported().figures_stale_after_ms - 1).iso();
    let quoted = format!("\"{old}\"");
    let leaked: &'static str = Box::leak(quoted.into_boxed_str());
    b.with_partner(reported_with(|f| {
        f.insert("figuresAsOf", leaked);
    }));
    has(
        row(&field_list(&b.ops(funding::view).unwrap(), "rows"), "USDT"),
        &[
            ("partnerFigure", Some("25")),
            ("status", Some("matches")),
            ("partnerAsOf", Some(&old)),
            ("partnerState", Some("stale")),
        ],
    );

    b.with_partner(reported_with(|f| {
        f.insert("programmeFigures", "null");
        f.insert("fundingAssetId", "null");
    }));
    let silent = field_list(&b.ops(funding::view).unwrap(), "rows");
    assert_eq!(silent.len(), 1, "{silent:?}");
    has(
        &silent[0],
        &[
            ("assetId", Some("USDT")),
            ("appFigure", Some("25")),
            ("partnerFigure", Some(NOT_KNOWN)),
            ("difference", Some(NOT_KNOWN)),
            ("status", Some("not_known")),
            ("fundingRate", Some(NOT_KNOWN)),
        ],
    );
}

#[test]
fn reads_fund_defund_and_auto_reload_as_the_partner_offers_them_and_not_known_when_it_is_silent() {
    assert_eq!(
        funding::offer_states(&reported()),
        [
            ("fund", "offered"),
            ("defund", "offered"),
            ("auto_reload", "not_offered")
        ]
    );
    assert_eq!(
        funding::offer_states(&reported_with(|f| {
            f.insert("fundingOffers", "null");
        })),
        [
            ("fund", "not_known"),
            ("defund", "not_known"),
            ("auto_reload", "not_known")
        ]
    );
}

/// `requestProgrammeFunding`'s input as the router hands it over, with the approval's ids when given.
fn ask(
    kind: &str,
    amount: &str,
    threshold: Option<&str>,
    reason: &str,
    id: &str,
    approval: &[(&'static str, Json)],
) -> Value {
    let mut f = vec![
        ("kind".to_owned(), Json::str(kind)),
        ("amount".to_owned(), Json::str(amount)),
        (
            "threshold".to_owned(),
            threshold.map_or(Json::Null, Json::str),
        ),
        ("reason".to_owned(), Json::str(reason)),
        ("clientRequestId".to_owned(), Json::str(id)),
    ];
    f.extend(approval.iter().map(|(k, v)| ((*k).to_owned(), v.clone())));
    Value::from_json(&Json::Object(f))
}

fn requests(b: &Bank) -> Vec<Json> {
    field_list(&b.ops(funding::view).unwrap(), "requests")
}

#[test]
fn sends_an_offered_instruction_once_with_its_approval_used_once_and_nothing_posted_the_same_key_replays_it()
 {
    let Some(b) = bank() else { return };
    let approval = b.desk.issue("fund", "1000", "");
    let input = ask(
        "fund",
        "1000",
        None,
        "TEST top up for the month",
        "op-1",
        &approval,
    );
    let first = b.ops(|d| funding::request(d, &input)).unwrap();
    has(
        &first,
        &[
            ("kind", Some("fund")),
            ("assetId", Some("USDC")),
            ("amount", Some("1000")),
            ("threshold", None),
        ],
    );
    let partner_ref = s(&first, "partnerRef").unwrap();
    let tail = partner_ref.strip_prefix("TEST-card-sim-").unwrap();
    assert!(
        tail.len() == 16 && tail.bytes().all(|c| c.is_ascii_hexdigit()),
        "{partner_ref}"
    );
    let again = b.ops(|d| funding::request(d, &input)).unwrap();
    assert_eq!(again.compact(), first.compact());
    assert_eq!(b.desk.consumed(), 1);
    assert_eq!(
        requests(&b).iter().map(Json::compact).collect::<Vec<_>>(),
        [first.compact()]
    );
}

#[test]
fn a_refused_approval_leaves_an_unapproved_row_only_a_partner_failure_after_approval_retries_without_a_second_approval()
 {
    let Some(b) = bank() else { return };
    // An approval identity did not issue for this instruction refuses.
    let stranger = vec![
        ("approvalId", Json::str(uuid())),
        ("operationId", Json::str(uuid())),
    ];
    let r = refused(b.ops(|d| {
        funding::request(
            d,
            &ask(
                "fund",
                "10",
                None,
                "TEST reason long enough",
                "op-r",
                &stranger,
            ),
        )
    }));
    assert!(r.contains("action_approval.consume_failed"), "{r}");
    assert!(requests(&b).is_empty());
    let (approved, partner): (Option<String>, Option<String>) = {
        let row = b
            .db
            .client()
            .query_one(
                "SELECT approved_at::text, partner_ref FROM bank.card_programme_funding_requests WHERE client_request_id = 'op-r'",
                &[],
            )
            .unwrap();
        (row.get(0), row.get(1))
    };
    assert_eq!((approved, partner), (None, None));
    // No approval at all refuses the same way, before the partner hears of it.
    let none = refused(b.ops(|d| {
        funding::request(
            d,
            &ask("fund", "10", None, "TEST reason long enough", "op-r", &[]),
        )
    }));
    assert!(none.contains("action_approval.missing"), "{none}");

    // A partner that failed after the approval leaves the row approved with no partner reference: the retry sends the
    // instruction without asking for a second approval.
    b.sql(
        "INSERT INTO bank.card_programme_funding_requests (client_request_id, kind, asset_id, amount, threshold, reason, approved_at) \
         VALUES ('op-f', 'defund', 'USDC', 7, NULL, 'TEST reason long enough', now())",
    );
    let done = b
        .ops(|d| {
            funding::request(
                d,
                &ask("defund", "7", None, "TEST reason long enough", "op-f", &[]),
            )
        })
        .unwrap();
    assert!(
        s(&done, "partnerRef")
            .unwrap()
            .starts_with("TEST-card-sim-")
    );
    assert_eq!(b.desk.consumed(), 0);
    // The same id for a different instruction refuses by name.
    let other = b.desk.issue("defund", "8", "");
    assert_eq!(
        refused(b.ops(|d| funding::request(
            d,
            &ask(
                "defund",
                "8",
                None,
                "TEST reason long enough",
                "op-f",
                &other
            )
        ))),
        "bank.card_funding_invalid"
    );
    assert_eq!(b.desk.consumed(), 0);
}

#[test]
fn refuses_before_using_the_approval_a_kind_the_partner_does_not_offer_a_silent_partner_a_bad_amount_or_threshold()
 {
    let Some(mut b) = bank() else { return };
    let reason = "TEST reason long enough";
    let try_ask = |b: &Bank, kind: &str, amount: &str, threshold: Option<&str>, reason: &str| {
        let approval = b.desk.issue(kind, amount, threshold.unwrap_or_default());
        refused(b.ops(|d| {
            funding::request(d, &ask(kind, amount, threshold, reason, &uuid(), &approval))
        }))
    };
    assert_eq!(
        try_ask(&b, "auto_reload", "10", Some("100"), reason),
        "bank.card_funding_not_offered"
    );
    assert_eq!(
        try_ask(&b, "fund", "0", None, reason),
        "bank.card_funding_invalid"
    );
    assert_eq!(
        try_ask(&b, "fund", "-5", None, reason),
        "bank.card_funding_invalid"
    );
    assert_eq!(
        try_ask(&b, "fund", "10", Some("5"), reason),
        "bank.card_funding_invalid"
    );
    assert_eq!(
        try_ask(&b, "fund", "10", None, "short"),
        "bank.ops_reason_too_short"
    );
    b.with_partner(reported_with(|f| {
        f.insert("fundingOffers", "null");
    }));
    assert_eq!(
        try_ask(&b, "fund", "10", None, reason),
        "bank.card_funding_not_offered"
    );
    b.with_partner(reported_with(|f| {
        f.insert("fundingAssetId", "null");
    }));
    assert_eq!(
        try_ask(&b, "fund", "10", None, reason),
        "bank.card_funding_not_offered"
    );
    assert_eq!(b.desk.consumed(), 0);
    assert_eq!(
        b.count("SELECT count(*)::int8 FROM bank.card_programme_funding_requests"),
        0
    );
}
