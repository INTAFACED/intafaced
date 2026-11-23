//! Slice `cards`' reads (`cards.authorizations`, `cards.recurring`, `cards.cashback`, `cards.payFrom`,
//! `cards.setPayFromOrder`, `cards.partnerHeld`) against the Rust door on a real Postgres. Ports the checks of the
//! TypeScript's suites that fall on these calls, each test named after the TypeScript test's words:
//! `cards/pay-from.money.test.ts` (whole), `pay-from-holds.money.test.ts` (Pay from's quotes, and the read parts of #3
//! and #6), `card-partner-held.money.test.ts` (the partner-held view, the view while frozen, and the doors a journey
//! uses), `card-cashback-tier.money.test.ts` (the summary's parts), `partner-terms.test.ts` ("Pay from names the real
//! blocker first"; the pure `payFromAssets` and owner-list checks are unit tests in `src/cards/reads.rs`) and
//! `cards.test.ts` ("never returns one user's authorisations under another user's card id"). A TypeScript call through
//! the router is a door call here; a call on `CardService` is the slice's own function (`svc_bank::cards::reads`),
//! given the dependencies the door gives it (`BankDoor::cards_deps`).
//!
//! The authorisations, settlements, conversions, refunds and cashback records the TypeScript makes through
//! `authorize`, `capture`, `refund` and the cashback pay (slice `card-ops`, not ported) are written straight into
//! `bank.card_authorizations`, `card_settlements`, `card_conversions`, `card_partner_refunds` and `card_cashback`
//! here, as those moves leave them; a hold the TEST partner card took is put into its book (`CardHoldBook`) as its
//! hold instruction leaves it. The door reads a book no instruction has written to until `card-ops` keeps one in the
//! slice's wiring, so a hold's report is read through the slice's function with the book that holds it.
//!
//! Not ported, with the reason: the instruction halves of these suites (authorise, capture, release, refund, expiry,
//! the freeze and the stop on each, the cashback pay, the reconciliation) are `card-ops`'; `partner-card-holds.test.ts`
//! tests those instructions, and its read side (`figures`, `holdState`, the run-out at the hold time) is the unit test
//! in `src/cards/reads.rs`; the issuer that answers a balance read with odd figures or throws is a unit test of
//! `reported_balances` there (the Rust issuer's TEST figures are held to plain decimals at boot, `terms.rs`); the
//! ledger-journal assertions ("the ledger posts nothing") have nothing to hold, as no ledger call is in these reads;
//! `owner-list-limit-unset.test.ts` reads TypeScript source (its runtime refusal is the door test below);
//! `cards.reachable`, `cards-procedures` and `sovereign-card-product` list authorisations made by `authorize`.
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

use std::collections::BTreeMap;
use std::sync::Mutex;

use service_kit::approvals::random_uuid;
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::cards::core::{IssueAsk, issue};
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::reads::{
    self, CardHoldBook, Figures, Hold, HoldConversion, HoldReads, HoldReport, Quote,
    TEST_CARD_HOLD_DAYS, hold_key,
};
use svc_bank::cards::terms::{CashbackRates, PartnerRates, PartnerTerms, sim_partner_for};
use svc_bank::cards::{Deps, RankTier, Settings, Wiring as CardsWiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::refuse;
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::Wiring as SpacesWiring;
use svc_bank::transfers::Wiring as TransfersWiring;

use support::TestDb;

const SECRET: &str = "a-bank-cards-reads-db-edge-secret-long-ok";
const INTERNAL: &str = "a-bank-cards-reads-db-internal-secret-ok";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const RW: &[&str] = &["bank:read", "bank:write"];
/// pay-from.money.test.ts's `AT`, the door's clock.
const AT: &str = "2026-11-08T12:00:00.000Z";
/// pay-from-holds.money.test.ts's `AT`.
const AT_HOLDS: &str = "2026-11-17T08:00:00.000Z";

fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

fn door_now() -> Instant {
    at(AT)
}

fn uuid() -> String {
    random_uuid().unwrap()
}

fn strings(l: &[&str]) -> Vec<String> {
    l.iter().map(|s| (*s).to_owned()).collect()
}

/// pay-from.money.test.ts's `PARTNER`: partner_holds, spends USDC, BTC and USD, reports 30, 0.01 and 50.
fn partner() -> PartnerTerms {
    sim_partner_for(
        Some(
            r#"{"custodyMode":"partner_holds","spendFrom":["USDC","BTC","USD"],"lossLiability":null,"reserve":null,"funder":null,"balances":{"USDC":"30","BTC":"0.01","USD":"50"},"programmeFigures":null,"figuresAsOf":null,"fundingAssetId":null,"fundingOffers":null}"#,
        ),
        Some("test"),
        None,
    )
    .unwrap()
}

/// `QUOTING`: the TEST partner card quoting its own TEST rates, 1 BTC in 65000.5 USDC, nothing for USD.
fn quoting() -> PartnerTerms {
    PartnerTerms {
        rates: Some(PartnerRates {
            in_asset: "USDC".to_owned(),
            per_unit: vec![("BTC".to_owned(), "65000.5".to_owned())],
        }),
        ..partner()
    }
}

/// pay-from-holds.money.test.ts's `PARTNER`: as above, 1 BTC quoted at 50000 USDC and 1 USD at 1.
fn holds_partner() -> PartnerTerms {
    PartnerTerms {
        rates: Some(PartnerRates {
            in_asset: "USDC".to_owned(),
            per_unit: vec![
                ("BTC".to_owned(), "50000".to_owned()),
                ("USD".to_owned(), "1".to_owned()),
            ],
        }),
        ..partner()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's posting freeze, svc-identity's rank perks.

struct Posting(Mutex<bool>);

impl Freeze for Posting {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: *self.0.lock().unwrap(),
            cause: None,
        })
    }
}

/// `memoryRankTier`: a fixed tier per person, `none` for anyone else.
struct Ranks(BTreeMap<String, String>);

impl RankTier for Ranks {
    fn card_tier_of(&self, user_id: &str) -> Result<String, Refusal> {
        Ok(self
            .0
            .get(user_id)
            .cloned()
            .unwrap_or_else(|| "none".to_owned()))
    }
}

struct RankDown;

impl RankTier for RankDown {
    fn card_tier_of(&self, _: &str) -> Result<String, Refusal> {
        Err(refuse("bank.rank_unavailable", "identity did not answer"))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door and its wiring.

struct Setup {
    issuer: Issuer,
    /// The TEST partner on the stack (its switches, and so its partner card).
    test_partner: bool,
    custody_layer: &'static str,
    posting: bool,
    spend_assets: Option<Vec<String>>,
    cashback_rates: Option<CashbackRates>,
    simulator_pays: bool,
    rank: Box<dyn RankTier>,
    migrate: bool,
}

impl Default for Setup {
    fn default() -> Setup {
        Setup {
            issuer: Issuer::sim(partner()),
            test_partner: true,
            custody_layer: "on",
            posting: true,
            spend_assets: Some(strings(&["USDC", "BTC", "USD"])),
            cashback_rates: None,
            simulator_pays: false,
            rank: Box::new(Ranks(BTreeMap::new())),
            migrate: true,
        }
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
}

fn bank_with(s: Setup) -> Option<Bank> {
    let db = TestDb::new()?;
    if s.migrate {
        db.migrated();
    }
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let door = BankDoor::new(DoorConfig {
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
        partner: s.test_partner.then(|| TestPartner::new().unwrap()),
        freeze: Box::new(Posting(Mutex::new(s.posting))),
        custody_layer: s.custody_layer.to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring::none())
    .with_transfers(TransfersWiring::none())
    .with_cards(CardsWiring {
        issuer: s.issuer,
        rank: s.rank,
        holds: Default::default(),
        settings: Settings {
            spend_assets: s.spend_assets,
            cashback_rates: s.cashback_rates,
            simulator_pays: s.simulator_pays,
            ..Settings::default()
        },
    });
    Some(Bank { door, db })
}

fn bank() -> Option<Bank> {
    bank_with(Setup::default())
}

impl Bank {
    fn deps<T>(&self, now: &str, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        self.door.cards_deps(at(now), f)
    }

    /// `cards.issue` as the slice does it: a card on `asset`, settling in `settlement` (its own asset when `None`).
    fn card(&self, user: &str, asset: &str, settlement: Option<&str>) -> String {
        let id = uuid();
        self.deps(AT, |d| {
            issue(
                d,
                &IssueAsk {
                    card_id: id.clone(),
                    user_id: user.to_owned(),
                    asset_id: asset.to_owned(),
                    settlement_asset_id: settlement.map(str::to_owned),
                    per_authorization_limit: parse_amount("1000").unwrap(),
                    ..IssueAsk::default()
                },
            )
            .unwrap()
        });
        id
    }
}

/// An authorisation as `authorize` leaves it (slice `card-ops`): its id.
struct Auth<'a> {
    card: &'a str,
    reference: &'a str,
    amount: &'a str,
    decision: &'a str,
    decline: Option<&'a str>,
    /// `ledger` or `partner`.
    book: &'a str,
    merchant: Option<&'a str>,
    recurring: bool,
    order: Option<&'a [&'a str]>,
    decided_at: &'a str,
}

impl Default for Auth<'_> {
    fn default() -> Self {
        Auth {
            card: "",
            reference: "",
            amount: "1",
            decision: "approved",
            decline: None,
            book: "partner",
            merchant: None,
            recurring: false,
            order: None,
            decided_at: AT,
        }
    }
}

fn authorize(b: &Bank, a: &Auth<'_>) -> String {
    let id = uuid();
    let approved = a.decision == "approved";
    let partner = a.book == "partner";
    let hold_ref = (partner && approved).then(|| format!("TEST-card-partner:{}", hold_key(&id)));
    let mode = (partner && approved).then_some("partner_holds");
    let ledger_tx = (!partner && approved).then(|| format!("tx-{id}"));
    let status = if approved { "settled" } else { "rejected" };
    let order: Option<Vec<String>> = a.order.map(strings);
    b.db.client()
        .execute(
            "INSERT INTO bank.card_authorizations (id, card_id, authorization_ref, amount, decision, decline_code, status, \
               hold_ledger_tx_id, money_book, partner_hold_ref, partner_mode, merchant, recurring, pay_from_order, decided_at) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::numeric, $5::text::bank.card_decision, $6, \
               $7::text::bank.loan_event_status, $8, $9, $10, $11, $12, $13, $14, $15::text::timestamptz)",
            &[
                &id,
                &a.card,
                &a.reference,
                &a.amount,
                &a.decision,
                &a.decline,
                &status,
                &ledger_tx,
                &a.book,
                &hold_ref,
                &mode,
                &a.merchant,
                &a.recurring,
                &order,
                &a.decided_at,
            ],
        )
        .unwrap();
    id
}

/// A hold the TEST partner card took for an authorisation, as its hold instruction leaves the book.
#[allow(
    clippy::too_many_arguments,
    reason = "a test helper: each argument is one field of the hold"
)]
fn take_hold(
    book: &Mutex<CardHoldBook>,
    terms: &PartnerTerms,
    authorization: &str,
    user: &str,
    asset: &str,
    amount: &str,
    now: &str,
    conversion: Option<HoldConversion>,
) {
    let want = parse_amount(amount).unwrap();
    let mut b = book.lock().unwrap();
    let bk = b.book_of(terms, user, asset).unwrap();
    bk.available -= want;
    bk.held += want;
    bk.open.insert(hold_key(authorization));
    b.holds.insert(
        hold_key(authorization),
        Hold {
            partner_ref: format!("TEST-card-partner:{}", hold_key(authorization)),
            user_id: user.to_owned(),
            asset_id: asset.to_owned(),
            mode: "partner_holds".to_owned(),
            amount: want,
            expires_at: Instant(at(now).0 + TEST_CARD_HOLD_DAYS * 86_400_000),
            conversion,
            captured: 0,
            released: 0,
            refunded: 0,
            expired: false,
        },
    );
}

/// The partner's capture of a hold, as its capture instruction leaves the book.
fn capture_hold(book: &Mutex<CardHoldBook>, authorization: &str, amount: &str) {
    let take = parse_amount(amount).unwrap();
    let mut b = book.lock().unwrap();
    let (open_left, id) = {
        let h = b.holds.get_mut(&hold_key(authorization)).unwrap();
        h.captured = take;
        (
            h.amount - h.captured - h.released,
            format!("{}|{}", h.user_id, h.asset_id),
        )
    };
    let bk = b.books.get_mut(&id).unwrap();
    bk.held -= take;
    if open_left == 0 {
        bk.open.remove(&hold_key(authorization));
    }
}

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        other => panic!("not a bank refusal: {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The wire.

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("99999999-9999-4999-8999-999999999999")),
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
    fn data(&self, k: &str) -> Option<Json> {
        self.1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get(k))
            .cloned()
    }
    fn trpc(&self) -> String {
        match self.data("code") {
            Some(Json::String(c)) => c,
            _ => "ok".to_owned(),
        }
    }
    /// `rejects.toMatchObject({ cause: { code } })`.
    fn cause(&self) -> String {
        match self.data("cause").and_then(|c| c.get("code").cloned()) {
            Some(Json::String(c)) => c,
            _ => panic!("no cause: {} {}", self.0, self.1.compact()),
        }
    }
}

fn call(b: &Bank, user: &str, path: &str, input: &Json) -> Answer {
    let input = input.compact();
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) if input == "null" => ("GET", format!("/trpc/{path}"), String::new()),
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(&input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input),
    };
    let mut headers = person(user, RW);
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-cards-reads-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn obj(f: &[(&str, Json)]) -> Json {
    Json::Object(
        f.iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn card_input(card: &str, limit: Option<i64>) -> Json {
    let mut f = vec![("cardId", Json::str(card))];
    if let Some(l) = limit {
        f.push(("limit", Json::int(l)));
    }
    obj(&f)
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(a) => a.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

/// Each Pay from row as `(assetId, state, partnerBalance, rate, rateAsOf)`.
fn rows(view: &Json) -> Vec<[String; 5]> {
    arr(view.get("assets").unwrap())
        .iter()
        .map(|r| {
            [
                s(r, "assetId"),
                s(r, "state"),
                s(r, "partnerBalance"),
                s(r, "rate"),
                s(r, "rateAsOf"),
            ]
        })
        .collect()
}

fn row(view: &Json, asset: &str) -> [String; 5] {
    rows(view).into_iter().find(|r| r[0] == asset).unwrap()
}

fn r5(a: &str, b: &str, c: &str, d: &str, e: &str) -> [String; 5] {
    [a, b, c, d, e].map(str::to_owned)
}

/// A replaced `quote` read.
type QuoteFn = Box<dyn Fn(&str) -> Option<Result<Option<Quote>, Refusal>>>;

/// The TEST partner card with one read replaced: `quote` or `figures`.
struct Swapped<'a> {
    base: reads::TestCardHolds<'a>,
    quote: Option<QuoteFn>,
}

impl HoldReads for Swapped<'_> {
    fn figures(&self, user: &str, asset: &str) -> Result<Figures, Refusal> {
        self.base.figures(user, asset)
    }
    fn hold_state(&self, key: &str) -> Result<Option<HoldReport>, Refusal> {
        self.base.hold_state(key)
    }
    fn quote(&self, asset: &str, settlement: &str) -> Option<Result<Option<Quote>, Refusal>> {
        match &self.quote {
            Some(q) => q(asset),
            None => self.base.quote(asset, settlement),
        }
    }
}

/// `payFrom` through the slice, at `now`, with the TEST partner card's book `book` (or a replaced read).
fn pay_from_with(b: &Bank, now: &str, book: &Mutex<CardHoldBook>, quote: Option<QuoteFn>) -> Json {
    b.deps(now, |d| {
        let base = reads::test_card_holds(d, book).unwrap();
        let holds = Swapped { base, quote };
        reads::pay_from(d, Some(&holds), ADA).unwrap()
    })
}

// ===============================================================================================================
// pay-from.money.test.ts: Pay from (J-bank-29 #1 #2).

/// The journey's card: it draws on USDT, which the partner cannot spend from, and settles in USDC.
fn pay_from_bank(issuer_terms: PartnerTerms, test_partner: bool) -> Option<(Bank, String)> {
    let b = bank_with(Setup {
        issuer: Issuer::sim(issuer_terms),
        test_partner,
        ..Setup::default()
    })?;
    let card = b.card(ADA, "USDT", Some("USDC"));
    Some((b, card))
}

#[test]
fn each_offered_asset_carries_the_partner_balance_and_the_partners_quoted_rate_with_its_time_a_silent_partner_is_not_known_never_0()
 {
    let Some((b, _)) = pay_from_bank(quoting(), true) else {
        return;
    };
    let view = call(&b, ADA, "cards.payFrom", &Json::Null).ok();
    assert_eq!(s(&view, "settlementAssetId"), "USDC");
    assert_eq!(
        rows(&view),
        vec![
            r5("USDC", "offered", "30", "1", AT),
            r5("BTC", "offered", "0.01", "65000.5", AT),
            // The partner quotes nothing for USD: the rate is null ("not known"), not 0 and not 1.
            r5("USD", "offered", "50", "null", "null"),
            // The person's USDT card: the partner cannot spend from it, so no balance or rate is shown for it.
            r5("USDT", "not_offered", "null", "null", "null"),
        ]
    );
    assert_eq!(s(&view, "order"), "null");
    assert_eq!(s(&view, "notUsedForCards"), r#"["trading","agent"]"#);
    assert_eq!(s(&view, "test"), "true");
    assert_eq!(s(&view, "custodyMode"), "partner_holds");
}

#[test]
fn a_partner_that_reports_no_balances_and_quotes_no_rates_reads_each_not_known() {
    let Some((b, _)) = pay_from_bank(
        PartnerTerms {
            balances: None,
            rates: None,
            ..partner()
        },
        true,
    ) else {
        return;
    };
    let view = call(&b, ADA, "cards.payFrom", &Json::Null).ok();
    for r in rows(&view) {
        assert_eq!(r[2..], ["null", "null", "null"], "{r:?}");
    }
}

#[test]
fn the_markets_price_never_stands_in_for_the_partners_quote_and_a_quote_that_is_not_a_positive_decimal_reads_not_known()
 {
    // No partner card (no TEST partner on the stack): every rate is "not known".
    let Some((b, _)) = pay_from_bank(quoting(), false) else {
        return;
    };
    for r in rows(&call(&b, ADA, "cards.payFrom", &Json::Null).ok()) {
        assert_eq!(r[3], "null");
    }
    let Some((b, _)) = pay_from_bank(quoting(), true) else {
        return;
    };
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let view = pay_from_with(
        &b,
        AT,
        &book,
        Some(Box::new(|asset: &str| {
            let rate = if asset == "BTC" { "0" } else { "1e3" };
            Some(Ok(Some(Quote {
                rate: rate.to_owned(),
                as_of: AT.to_owned(),
            })))
        })),
    );
    for r in rows(&view) {
        assert_eq!(r[3], "null", "{r:?}");
    }
}

#[test]
fn a_partner_quote_older_than_the_conversion_policys_window_or_dated_in_the_future_reads_not_known_a_fresh_one_shows()
 {
    let Some((b, _)) = pay_from_bank(quoting(), true) else {
        return;
    };
    let max_age = reads::CONVERSION_MAX_AGE_SECONDS;
    let aged = |seconds: i64| -> QuoteFn {
        let as_of = Instant(at(AT).0 - seconds * 1000).iso();
        Box::new(move |asset: &str| {
            Some(Ok((asset == "BTC").then(|| Quote {
                rate: "65000.5".to_owned(),
                as_of: as_of.clone(),
            })))
        })
    };
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let btc = |q| row(&pay_from_with(&b, AT, &book, Some(q)), "BTC");
    assert_eq!(
        btc(aged(max_age + 1)),
        r5("BTC", "offered", "0.01", "null", "null")
    );
    assert_eq!(btc(aged(-120))[3..], ["null", "null"]);
    let fresh = Instant(at(AT).0 - max_age * 1000).iso();
    assert_eq!(btc(aged(max_age))[3..], ["65000.5".to_owned(), fresh]);
}

#[test]
fn a_partner_whose_quote_throws_reads_each_rate_not_known_and_pay_from_still_opens_with_its_balances()
 {
    let Some((b, _)) = pay_from_bank(quoting(), true) else {
        return;
    };
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let view = pay_from_with(
        &b,
        AT,
        &book,
        Some(Box::new(|_: &str| {
            Some(Err(Refusal::Other("partner quote down".to_owned())))
        })),
    );
    for r in rows(&view) {
        assert_eq!(r[3..], ["null", "null"], "{r:?}");
    }
    assert_eq!(row(&view, "BTC")[1..3], ["offered", "0.01"]);
}

#[test]
fn an_asset_the_partner_map_leaves_out_reads_not_known_not_0() {
    // No partner card: the issuer's reported list.
    let Some((b, _)) = pay_from_bank(
        PartnerTerms {
            balances: Some(vec![("USDC".to_owned(), "30".to_owned())]),
            ..partner()
        },
        false,
    ) else {
        return;
    };
    let view = call(&b, ADA, "cards.payFrom", &Json::Null).ok();
    assert_eq!(row(&view, "BTC")[2], "null");
    assert_eq!(row(&view, "USDC")[2], "30");
}

#[test]
fn cards_that_settle_in_different_assets_quote_no_rate_rather_than_guess_which_card_pays() {
    let Some((b, _)) = pay_from_bank(quoting(), true) else {
        return;
    };
    b.card(ADA, "USDT", None);
    let view = call(&b, ADA, "cards.payFrom", &Json::Null).ok();
    assert_eq!(s(&view, "settlementAssetId"), "null");
    for r in rows(&view) {
        assert_eq!(r[3], "null");
    }
}

fn order(assets: &[&str]) -> Json {
    obj(&[(
        "assetIds",
        Json::Array(assets.iter().map(|a| Json::str(*a)).collect()),
    )])
}

fn updated_at(b: &Bank) -> String {
    b.db.client()
        .query_one(
            "SELECT updated_at::text FROM bank.card_pay_from_orders WHERE user_id = $1",
            &[&ADA],
        )
        .unwrap()
        .get(0)
}

#[test]
fn saves_the_order_usdc_btc_usd_and_reads_it_back_saving_it_again_changes_nothing() {
    let Some((b, _)) = pay_from_bank(partner(), true) else {
        return;
    };
    let saved = call(
        &b,
        ADA,
        "cards.setPayFromOrder",
        &order(&["USDC", "BTC", "USD"]),
    )
    .ok();
    assert_eq!(s(&saved, "order"), r#"["USDC","BTC","USD"]"#);
    let first = updated_at(&b);
    call(
        &b,
        ADA,
        "cards.setPayFromOrder",
        &order(&["USDC", "BTC", "USD"]),
    )
    .ok();
    assert_eq!(updated_at(&b), first);
    let again = call(&b, ADA, "cards.setPayFromOrder", &order(&["BTC", "USDC"])).ok();
    assert_eq!(s(&again, "order"), r#"["BTC","USDC"]"#);
    assert_eq!(
        s(&call(&b, ADA, "cards.payFrom", &Json::Null).ok(), "order"),
        r#"["BTC","USDC"]"#
    );
}

fn saved_rows(b: &Bank) -> i64 {
    b.db.client()
        .query_one(
            "SELECT count(*)::int8 FROM bank.card_pay_from_orders WHERE user_id = $1",
            &[&ADA],
        )
        .unwrap()
        .get(0)
}

#[test]
fn refuses_an_order_naming_an_asset_the_partner_cannot_spend_from_twice_or_none_and_saves_nothing()
{
    let Some((b, _)) = pay_from_bank(partner(), true) else {
        return;
    };
    let refused = |b: &Bank, assets: &[&str]| call(b, ADA, "cards.setPayFromOrder", &order(assets));
    assert_eq!(
        refused(&b, &["USDC", "USDT"]).cause(),
        "bank.card_pay_from_not_offered"
    );
    let set = |b: &Bank, terms: PartnerTerms, assets: &[String]| {
        b.deps(AT, |d| {
            let w = CardsWiring {
                issuer: Issuer::sim(terms),
                rank: Box::new(Ranks(BTreeMap::new())),
                holds: Default::default(),
                settings: d.settings().clone(),
            };
            let d2 = Deps {
                t: d.t,
                w: &w,
                rates: d.rates,
            };
            reads::set_pay_from_order(&d2, None, ADA, assets)
        })
    };
    let narrow = PartnerTerms {
        spend_from: Some(strings(&["USDC", "USD"])),
        ..partner()
    };
    assert_eq!(
        code(&set(&b, narrow, &strings(&["BTC"])).unwrap_err()),
        "bank.card_pay_from_not_offered"
    );
    let unlisted = PartnerTerms {
        spend_from: None,
        ..partner()
    };
    assert_eq!(
        code(&set(&b, unlisted, &strings(&["USDC"])).unwrap_err()),
        "bank.card_pay_from_not_offered"
    );
    // The door holds an order to 1 to 50 assets; the slice refuses none or twice by name.
    assert_eq!(
        code(&set(&b, partner(), &strings(&["USDC", "USDC"])).unwrap_err()),
        "bank.card_pay_from_order_invalid"
    );
    assert_eq!(
        code(&set(&b, partner(), &[]).unwrap_err()),
        "bank.card_pay_from_order_invalid"
    );
    assert_eq!(
        refused(&b, &["USDC", "USDC"]).cause(),
        "bank.card_pay_from_order_invalid"
    );
    assert_eq!(refused(&b, &[]).trpc(), "BAD_REQUEST");
    assert_eq!(saved_rows(&b), 0);
}

#[test]
fn with_the_owner_list_unset_no_order_can_be_saved_j_bank_29_1_bank_card_spend_assets_unset() {
    let Some(b) = bank_with(Setup {
        spend_assets: None,
        ..Setup::default()
    }) else {
        return;
    };
    assert_eq!(
        call(&b, ADA, "cards.setPayFromOrder", &order(&["USDC"])).cause(),
        "bank.card_spend_assets_unset"
    );
    assert_eq!(saved_rows(&b), 0);
}

// ===============================================================================================================
// partner-terms.test.ts: Pay from names the real blocker first. The database has no tables: a read before the
// blocker would answer the opaque failure, not the code.

fn unmigrated(issuer: Issuer) -> Option<Bank> {
    bank_with(Setup {
        issuer,
        spend_assets: None,
        migrate: false,
        ..Setup::default()
    })
}

#[test]
fn no_issuer_and_no_owner_list_bank_no_card_issuer_not_the_list() {
    let Some(b) = unmigrated(Issuer::None) else {
        return;
    };
    assert_eq!(
        call(&b, ADA, "cards.payFrom", &Json::Null).cause(),
        "bank.no_card_issuer"
    );
}

#[test]
fn the_simulator_in_a_live_deployment_bank_card_sim_not_live_not_the_list() {
    let Some(b) = unmigrated(Issuer::for_setting("card-sim", true, partner())) else {
        return;
    };
    assert_eq!(
        call(&b, ADA, "cards.payFrom", &Json::Null).cause(),
        "bank.card_sim_not_live"
    );
}

#[test]
fn card_sim_on_a_test_posture_and_no_owner_list_bank_card_spend_assets_unset() {
    let Some(b) = unmigrated(Issuer::sim(PartnerTerms::nothing_reported())) else {
        return;
    };
    assert_eq!(
        call(&b, ADA, "cards.payFrom", &Json::Null).cause(),
        "bank.card_spend_assets_unset"
    );
}

// ===============================================================================================================
// pay-from-holds.money.test.ts: a card payment by the pay-from order (J-bank-29 #3 to #8), read parts.

fn holds_bank() -> Option<(Bank, String)> {
    let b = bank_with(Setup {
        issuer: Issuer::sim(holds_partner()),
        ..Setup::default()
    })?;
    let card = b.card(ADA, "USDT", Some("USDC"));
    call(
        &b,
        ADA,
        "cards.setPayFromOrder",
        &order(&["USDC", "BTC", "USD"]),
    )
    .ok();
    Some((b, card))
}

#[test]
fn pay_from_shows_the_partners_own_quote_and_its_time_and_none_without_a_partner_that_quotes() {
    let Some((b, _)) = holds_bank() else {
        return;
    };
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let view = pay_from_with(&b, AT_HOLDS, &book, None);
    let offered: Vec<[String; 5]> = rows(&view)
        .into_iter()
        .filter(|r| r[1] == "offered")
        .collect();
    assert_eq!(
        offered,
        vec![
            r5("USDC", "offered", "30", "1", AT_HOLDS),
            r5("BTC", "offered", "0.01", "50000", AT_HOLDS),
            r5("USD", "offered", "50", "1", AT_HOLDS),
        ]
    );
    // The market's price never stands in for the partner's: no partner, no rate.
    let none = b.deps(AT_HOLDS, |d| reads::pay_from(d, None, ADA).unwrap());
    for r in rows(&none) {
        assert_eq!(r[3], "null");
    }
}

#[test]
fn _3_a_charge_of_25_is_held_from_usdc_the_first_asset_at_the_partners_rate_and_time_usdc_available_falls_by_exactly_that()
 {
    let Some((b, card)) = holds_bank() else {
        return;
    };
    let auth = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "jb29-25",
            amount: "25",
            order: Some(&["USDC", "BTC", "USD"]),
            decided_at: AT_HOLDS,
            ..Auth::default()
        },
    );
    b.db.client()
        .execute(
            "INSERT INTO bank.card_conversions (authorization_id, settlement_asset_id, settlement_amount, funding_asset_id, \
               funding_amount, rate, rate_quality, rate_as_of) \
             VALUES ($1::text::uuid, 'USDC', 25, 'USDC', 25, 1, 'partner', $2::text::timestamptz)",
            &[&auth, &AT_HOLDS],
        )
        .unwrap();
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let conversion = HoldConversion {
        settlement_asset_id: "USDC".to_owned(),
        settlement_amount: "25".to_owned(),
        rate: "1".to_owned(),
        rate_as_of: AT_HOLDS.to_owned(),
    };
    take_hold(
        &book,
        &holds_partner(),
        &auth,
        ADA,
        "USDC",
        "25",
        AT_HOLDS,
        Some(conversion),
    );
    b.deps(AT_HOLDS, |d| {
        let holds = reads::test_card_holds(d, &book).unwrap();
        let f = holds.figures(ADA, "USDC").unwrap();
        assert_eq!(
            (f.available.as_deref(), f.held.as_deref()),
            (Some("5"), Some("25"))
        );
        let report = holds.hold_state(&hold_key(&auth)).unwrap().unwrap().json();
        assert_eq!(s(&report, "assetId"), "USDC");
        assert_eq!(s(&report, "amount"), "25");
        let conv = report.get("conversion").unwrap();
        assert_eq!(
            (s(conv, "rate"), s(conv, "rateAsOf")),
            ("1".to_owned(), AT_HOLDS.to_owned())
        );
    });
    assert_eq!(
        row(&pay_from_with(&b, AT_HOLDS, &book, None), "USDC")[2],
        "5"
    );
    // The feed: the order the partner walked and the asset it held from.
    let feed = arr(&call(
        &b,
        ADA,
        "cards.authorizations",
        &card_input(&card, Some(10)),
    )
    .ok());
    let pay_from = feed[0].get("payFrom").unwrap();
    assert_eq!(s(pay_from, "order"), r#"["USDC","BTC","USD"]"#);
    assert_eq!(s(pay_from, "assetId"), "USDC");
    assert_eq!(s(&feed[0], "heldBy"), "partner");
    assert_eq!(
        s(feed[0].get("conversion").unwrap(), "rateQuality"),
        "partner"
    );
}

#[test]
fn _6_7_capture_22_of_25_settles_22_usdc_and_returns_3() {
    let Some((b, card)) = holds_bank() else {
        return;
    };
    let auth = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "jb29-cap",
            amount: "25",
            order: Some(&["USDC", "BTC", "USD"]),
            ..Auth::default()
        },
    );
    b.db.client()
        .execute(
            "INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount, status, money_book, partner_ref) VALUES \
               ($1::text::uuid, 0, 'capture', 22, 'settled', 'partner', 'ref-cap'), \
               ($1::text::uuid, 1, 'reversal', 3, 'settled', 'partner', 'ref-rev')",
            &[&auth],
        )
        .unwrap();
    let feed = arr(&call(
        &b,
        ADA,
        "cards.authorizations",
        &card_input(&card, Some(50)),
    )
    .ok());
    let pay_from = feed[0].get("payFrom").unwrap();
    assert_eq!(
        (s(pay_from, "captured"), s(pay_from, "returned")),
        ("22".to_owned(), "3".to_owned())
    );
    // Not taken by a pay-from order: no conversion, so no asset it held from.
    assert_eq!(s(pay_from, "assetId"), "null");
}

// ===============================================================================================================
// card-partner-held.money.test.ts: partner-held card authorisations, the read parts.

fn partner_held_bank(posting: bool) -> Option<(Bank, String)> {
    let b = bank_with(Setup {
        issuer: Issuer::sim(partner()),
        posting,
        ..Setup::default()
    })?;
    let card = b.card(ADA, "USDC", None);
    // `testPartner.set({ custody: 'off' })`: the partner holds Ada's money.
    assert_eq!(
        s(
            &call(
                &b,
                ADA,
                "testPartner.set",
                &obj(&[("custody", Json::str("off"))])
            )
            .ok(),
            "custody"
        ),
        "off"
    );
    Some((b, card))
}

fn partner_held(b: &Bank, book: &Mutex<CardHoldBook>, card: &str) -> Json {
    b.deps(AT, |d| {
        let holds = reads::test_card_holds(d, book).unwrap();
        reads::partner_held(d, Some(&holds), card, Some(10.0)).unwrap()
    })
}

#[test]
fn planted_an_approved_authorisation_is_held_by_the_partner_from_the_partner_balance() {
    let Some((b, card)) = partner_held_bank(true) else {
        return;
    };
    let auth = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "jb14-hold-1",
            amount: "40",
            ..Auth::default()
        },
    );
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let terms = PartnerTerms {
        balances: Some(vec![("USDC".to_owned(), "100".to_owned())]),
        ..partner()
    };
    take_hold(&book, &terms, &auth, ADA, "USDC", "40", AT, None);
    let view = partner_held(&b, &book, &card);
    assert_eq!(s(&view, "heldBy"), "partner");
    let auths = arr(view.get("authorizations").unwrap());
    assert_eq!(auths.len(), 1);
    assert_eq!(s(&auths[0], "authorizationId"), auth);
    let report = auths[0].get("report").unwrap();
    assert_eq!(
        (s(report, "status"), s(report, "amount"), s(report, "open")),
        ("held".to_owned(), "40".to_owned(), "40".to_owned())
    );
    assert_eq!(
        s(report, "partnerRef"),
        format!("TEST-card-partner:card.partner.hold:{auth}")
    );
}

#[test]
fn frozen_reads_stay_open_figures_and_the_partner_held_view() {
    let Some((b, card)) = partner_held_bank(false) else {
        return;
    };
    let auth = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "freeze-read",
            amount: "40",
            ..Auth::default()
        },
    );
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let terms = PartnerTerms {
        balances: Some(vec![("USDC".to_owned(), "100".to_owned())]),
        ..partner()
    };
    take_hold(&book, &terms, &auth, ADA, "USDC", "40", AT, None);
    let view = partner_held(&b, &book, &card);
    assert_eq!(s(&view, "heldBy"), "partner");
    let figures = view.get("figures").unwrap();
    assert_eq!(
        (s(figures, "available"), s(figures, "held")),
        ("60".to_owned(), "40".to_owned())
    );
    let report = arr(view.get("authorizations").unwrap())[0]
        .get("report")
        .cloned()
        .unwrap();
    assert_eq!(s(&report, "status"), "held");
    // Through the door too, frozen: the view answers.
    let door = call(&b, ADA, "cards.partnerHeld", &card_input(&card, Some(10))).ok();
    assert_eq!(s(&door, "heldBy"), "partner");
}

#[test]
fn testpartner_set_takes_custody_and_cardhold_partnerheld_reads_only_at_the_partner() {
    let Some((b, card)) = partner_held_bank(true) else {
        return;
    };
    let auth = authorize(
        &b,
        &Auth {
            card: &card,
            reference: "door-1",
            amount: "40",
            ..Auth::default()
        },
    );
    b.db.client()
        .execute(
            "INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount, status, money_book, partner_ref) \
             VALUES ($1::text::uuid, 0, 'capture', 40, 'settled', 'partner', 'ref-cap')",
            &[&auth],
        )
        .unwrap();
    let book = std::sync::Mutex::new(reads::CardHoldBook::default());
    let terms = PartnerTerms {
        balances: Some(vec![("USDC".to_owned(), "100".to_owned())]),
        ..partner()
    };
    take_hold(&book, &terms, &auth, ADA, "USDC", "40", AT, None);
    capture_hold(&book, &auth, "40");
    let view = partner_held(&b, &book, &card);
    assert_eq!(s(&view, "heldBy"), "partner");
    let figures = view.get("figures").unwrap();
    assert_eq!(
        (
            s(figures, "test"),
            s(figures, "assetId"),
            s(figures, "available"),
            s(figures, "held")
        ),
        (
            "true".to_owned(),
            "USDC".to_owned(),
            "60".to_owned(),
            "0".to_owned()
        )
    );
    let a = &arr(view.get("authorizations").unwrap())[0];
    assert_eq!(
        (s(a, "authorizationId"), s(a, "amount")),
        (auth.clone(), "40".to_owned())
    );
    let report = a.get("report").unwrap();
    assert_eq!(
        (s(report, "status"), s(report, "captured")),
        ("captured".to_owned(), "40".to_owned())
    );
    // The door, which reads a book no instruction has written to: the partner has no record, so the report is null,
    // never a guess, and the figures are the TEST figure.
    let door = call(&b, ADA, "cards.partnerHeld", &card_input(&card, Some(10))).ok();
    assert_eq!(s(&door, "heldBy"), "partner");
    assert_eq!(s(door.get("figures").unwrap(), "available"), "30");
    assert_eq!(
        s(&arr(door.get("authorizations").unwrap())[0], "report"),
        "null"
    );
    let listed = arr(&call(
        &b,
        ADA,
        "cards.authorizations",
        &card_input(&card, Some(10)),
    )
    .ok());
    assert_eq!(
        (s(&listed[0], "heldBy"), s(&listed[0], "decision")),
        ("partner".to_owned(), "approved".to_owned())
    );
}

#[test]
fn j_bank_14_6_the_feed_lists_the_refund_on_its_payment_recurring_payments_group_by_merchant_and_an_unlisted_partner_code_is_kept_raw()
 {
    let Some((b, card)) = partner_held_bank(true) else {
        return;
    };
    let pay = |reference: &'static str,
               amount: &'static str,
               merchant: &'static str,
               recurring: bool,
               when: &'static str| {
        authorize(
            &b,
            &Auth {
                card: &card,
                reference,
                amount,
                merchant: Some(merchant),
                recurring,
                decided_at: when,
                ..Auth::default()
            },
        )
    };
    pay(
        "six-sub-1",
        "5",
        "TEST Stream",
        true,
        "2026-11-08T12:00:01.000Z",
    );
    pay(
        "six-sub-2",
        "6",
        "TEST Stream",
        true,
        "2026-11-08T12:00:02.000Z",
    );
    pay("six-gym", "7", "TEST Gym", true, "2026-11-08T12:00:03.000Z");
    let shop = pay(
        "six-shop",
        "8",
        "TEST Stream",
        false,
        "2026-11-08T12:00:04.000Z",
    );
    let recurring = arr(&call(&b, ADA, "cards.recurring", &card_input(&card, Some(10))).ok());
    assert_eq!(
        recurring
            .iter()
            .map(|r| [s(r, "merchant"), s(r, "payments"), s(r, "lastAmount")])
            .collect::<Vec<_>>(),
        vec![
            ["TEST Gym", "1", "7"].map(str::to_owned),
            ["TEST Stream", "2", "6"].map(str::to_owned),
        ]
    );
    assert_eq!(s(&recurring[1], "firstAt"), "2026-11-08T12:00:01.000Z");
    assert_eq!(s(&recurring[1], "lastAt"), "2026-11-08T12:00:02.000Z");

    b.db.client()
        .execute(
            "INSERT INTO bank.card_partner_refunds (authorization_id, amount, status, partner_ref, settled_at) \
             VALUES ($1::text::uuid, 3, 'settled', 'ref-refund', '2026-11-08T12:00:05.000Z')",
            &[&shop],
        )
        .unwrap();
    let feed = arr(&call(
        &b,
        ADA,
        "cards.authorizations",
        &card_input(&card, Some(10)),
    )
    .ok());
    let by_ref = |r: &str| {
        feed.iter()
            .find(|a| s(a, "authorizationRef") == r)
            .cloned()
            .unwrap()
    };
    let six_shop = by_ref("six-shop");
    assert_eq!(s(&six_shop, "recurring"), "false");
    let refund = six_shop.get("refund").unwrap();
    assert_eq!(
        (s(refund, "amount"), s(refund, "status"), s(refund, "at")),
        (
            "3".to_owned(),
            "settled".to_owned(),
            "2026-11-08T12:00:05.000Z".to_owned()
        )
    );
    let sub = by_ref("six-sub-1");
    assert_eq!(
        (s(&sub, "recurring"), s(&sub, "refund")),
        ("true".to_owned(), "null".to_owned())
    );
    // Newest first.
    assert_eq!(s(&feed[0], "authorizationRef"), "six-shop");

    authorize(
        &b,
        &Auth {
            card: &card,
            reference: "six-unlisted",
            amount: "1",
            decision: "declined",
            decline: Some("test_partner.unlisted_reason"),
            decided_at: "2026-11-08T12:00:06.000Z",
            ..Auth::default()
        },
    );
    let feed = arr(&call(
        &b,
        ADA,
        "cards.authorizations",
        &card_input(&card, Some(10)),
    )
    .ok());
    assert_eq!(
        (
            s(&feed[0], "decision"),
            s(&feed[0], "declineCode"),
            s(&feed[0], "status")
        ),
        (
            "declined".to_owned(),
            "test_partner.unlisted_reason".to_owned(),
            "rejected".to_owned()
        )
    );
    // A recurring decline is never a recurring payment.
    assert_eq!(
        arr(&call(&b, ADA, "cards.recurring", &card_input(&card, Some(10))).ok()).len(),
        2
    );
}

// ===============================================================================================================
// cards.test.ts, and the router's owner check and page size.

#[test]
fn never_returns_one_users_authorisations_under_another_users_card_id() {
    let Some(b) = bank() else {
        return;
    };
    let mine = b.card(ADA, "USDT", None);
    let theirs = b.card(OTHER, "USDT", None);
    authorize(
        &b,
        &Auth {
            card: &mine,
            reference: "auth-1",
            amount: "10",
            book: "ledger",
            ..Auth::default()
        },
    );
    let listed = |c: &str| {
        b.deps(AT, |d| {
            svc_bank::spaces::space::with(d.store(), |cl| reads::authorizations(cl, c, 50)).unwrap()
        })
    };
    assert_eq!(arr(&listed(&theirs)).len(), 0);
    assert_eq!(arr(&listed(&mine)).len(), 1);
    // The router's half: another person's card is the guard's 403, on every card read here.
    for path in [
        "cards.authorizations",
        "cards.recurring",
        "cards.partnerHeld",
    ] {
        let a = call(&b, ADA, path, &card_input(&theirs, Some(10)));
        assert_eq!((a.0, a.trpc()), (403, "FORBIDDEN".to_owned()), "{path}");
    }
    let missing = call(
        &b,
        ADA,
        "cards.authorizations",
        &card_input(&uuid(), Some(10)),
    );
    assert_eq!(missing.cause(), "bank.card_not_found");
    // A ledger-held authorisation: held by the ledger, no pay-from, no conversion.
    let feed = arr(&call(
        &b,
        ADA,
        "cards.authorizations",
        &card_input(&mine, Some(10)),
    )
    .ok());
    assert_eq!(
        (
            s(&feed[0], "heldBy"),
            s(&feed[0], "payFrom"),
            s(&feed[0], "conversion"),
            s(&feed[0], "channel")
        ),
        (
            "ledger".to_owned(),
            "null".to_owned(),
            "null".to_owned(),
            "card-present".to_owned()
        )
    );
}

#[test]
fn an_omitted_page_size_refuses_bank_card_authorizations_list_limit_unset_never_50() {
    let Some(b) = bank() else {
        return;
    };
    let card = b.card(ADA, "USDT", None);
    for path in [
        "cards.authorizations",
        "cards.recurring",
        "cards.partnerHeld",
    ] {
        assert_eq!(
            call(&b, ADA, path, &card_input(&card, None)).cause(),
            "bank.card_authorizations_list_limit_unset",
            "{path}"
        );
    }
}

// ===============================================================================================================
// card-cashback-tier.money.test.ts: cashback on card spend by rank card tier (J-bank-13 #7), the summary.

fn rates() -> CashbackRates {
    CashbackRates {
        asset_id: "IFC".to_owned(),
        rates: vec![("none".to_owned(), 100), ("metal".to_owned(), 200)],
    }
}

fn cashback_bank(rank: Box<dyn RankTier>, cashback_rates: Option<CashbackRates>) -> Option<Bank> {
    bank_with(Setup {
        issuer: Issuer::sim(PartnerTerms::nothing_reported()),
        cashback_rates,
        simulator_pays: true,
        rank,
        ..Setup::default()
    })
}

/// A captured spend of `amount` on a new IFC card, and its cashback record as the pay left it.
fn spend_with_cashback(b: &Bank, cashback: &str, status: &str, paid_by: &str) -> String {
    let card = b.card(ADA, "IFC", None);
    let auth = authorize(
        b,
        &Auth {
            card: &card,
            reference: &uuid(),
            amount: "4",
            book: if paid_by == "wallet" {
                "partner"
            } else {
                "ledger"
            },
            ..Auth::default()
        },
    );
    let (tx, code, spend, tier): (Option<String>, Option<&str>, Option<&str>, Option<&str>) =
        match (paid_by, status) {
            ("wallet", _) => (None, None, Some("4"), Some("metal")),
            (_, "settled") => (Some(format!("tx-cb-{auth}")), None, None, None),
            (_, "rejected") => (None, Some("bank.cashback_pot_unfunded"), None, None),
            _ => (None, None, None, None),
        };
    b.db.client()
        .execute(
            "INSERT INTO bank.card_cashback (authorization_id, rate_bps, amount, status, ledger_tx_id, rejection_code, paid_by, spend, tier) \
             VALUES ($1::text::uuid, 100, $2::text::numeric, $3::text::bank.loan_event_status, $4, $5, $6, $7::text::numeric, $8)",
            &[&auth, &cashback, &status, &tx, &code, &paid_by, &spend, &tier],
        )
        .unwrap();
    auth
}

#[test]
fn pays_the_tier_rate_in_ifc_once_from_the_reward_pot_the_summary() {
    let Some(b) = cashback_bank(Box::new(Ranks(BTreeMap::new())), Some(rates())) else {
        return;
    };
    let auth = spend_with_cashback(&b, "0.04", "settled", "ledger");
    let summary = call(&b, ADA, "cards.cashback", &Json::Null).ok();
    assert_eq!(
        [
            s(&summary, "tier"),
            s(&summary, "rateBps"),
            s(&summary, "assetId"),
            s(&summary, "paid"),
            s(&summary, "unpaid"),
            s(&summary, "paying"),
            s(&summary, "simulated"),
        ],
        ["none", "100", "IFC", "0.04", "0", "true", "true"].map(str::to_owned)
    );
    assert_eq!(
        s(&summary, "rates"),
        r#"[{"tier":"none","bps":100},{"tier":"metal","bps":200}]"#
    );
    let p = &arr(summary.get("payments").unwrap())[0];
    assert_eq!(
        [
            s(p, "authorizationId"),
            s(p, "amount"),
            s(p, "status"),
            s(p, "paidBy"),
            s(p, "announced")
        ],
        [auth.as_str(), "0.04", "settled", "ledger", "false"].map(str::to_owned)
    );
    // Without its TEST stand-in, the simulator does not pay.
    let Some(off) = bank_with(Setup {
        issuer: Issuer::sim(PartnerTerms::nothing_reported()),
        cashback_rates: Some(rates()),
        ..Setup::default()
    }) else {
        return;
    };
    assert_eq!(
        s(
            &call(&off, ADA, "cards.cashback", &Json::Null).ok(),
            "paying"
        ),
        "false"
    );
}

#[test]
fn uses_the_persons_own_tier() {
    let tiers = BTreeMap::from([(ADA.to_owned(), "metal".to_owned())]);
    let Some(b) = cashback_bank(Box::new(Ranks(tiers)), Some(rates())) else {
        return;
    };
    let summary = call(&b, ADA, "cards.cashback", &Json::Null).ok();
    assert_eq!(
        (s(&summary, "tier"), s(&summary, "rateBps")),
        ("metal".to_owned(), "200".to_owned())
    );
}

#[test]
fn keeps_an_unpaid_row_and_pays_nothing_when_the_pot_is_short_the_summary() {
    let Some(b) = cashback_bank(Box::new(Ranks(BTreeMap::new())), Some(rates())) else {
        return;
    };
    spend_with_cashback(&b, "0.04", "rejected", "ledger");
    spend_with_cashback(&b, "0.02", "pending", "ledger");
    let summary = call(&b, ADA, "cards.cashback", &Json::Null).ok();
    assert_eq!(
        (
            s(&summary, "unpaid"),
            s(&summary, "refused"),
            s(&summary, "paid")
        ),
        ("0.02".to_owned(), "0.04".to_owned(), "0".to_owned())
    );
}

#[test]
fn refuses_by_name_for_a_tier_with_no_published_rate_and_with_no_rates_and_no_tier() {
    let tiers = BTreeMap::from([(ADA.to_owned(), "obsidian".to_owned())]);
    let Some(b) = cashback_bank(Box::new(Ranks(tiers)), Some(rates())) else {
        return;
    };
    // A tier with no rate reads null, not 0.
    assert_eq!(
        s(
            &call(&b, ADA, "cards.cashback", &Json::Null).ok(),
            "rateBps"
        ),
        "null"
    );
    let Some(none) = cashback_bank(Box::new(Ranks(BTreeMap::new())), None) else {
        return;
    };
    assert_eq!(
        call(&none, ADA, "cards.cashback", &Json::Null).cause(),
        "bank.cashback_rate_unset"
    );
    let Some(down) = cashback_bank(Box::new(RankDown), Some(rates())) else {
        return;
    };
    assert_eq!(
        call(&down, ADA, "cards.cashback", &Json::Null).cause(),
        "bank.rank_unavailable"
    );
}

#[test]
fn planted_cashback_on_partner_held_spend_is_owed_to_the_wallet_never_in_paid() {
    let Some(b) = cashback_bank(Box::new(Ranks(BTreeMap::new())), Some(rates())) else {
        return;
    };
    spend_with_cashback(&b, "0.08", "pending", "wallet");
    let summary = call(&b, ADA, "cards.cashback", &Json::Null).ok();
    assert_eq!(
        (
            s(&summary, "toWallet"),
            s(&summary, "paid"),
            s(&summary, "unpaid")
        ),
        ("0.08".to_owned(), "0".to_owned(), "0".to_owned())
    );
    let p = &arr(summary.get("payments").unwrap())[0];
    assert_eq!(
        (s(p, "paidBy"), s(p, "ledgerTxId")),
        ("wallet".to_owned(), "null".to_owned())
    );
    // Another person's summary holds none of Ada's records.
    assert_eq!(
        s(
            &call(&b, OTHER, "cards.cashback", &Json::Null).ok(),
            "toWallet"
        ),
        "0"
    );
}
