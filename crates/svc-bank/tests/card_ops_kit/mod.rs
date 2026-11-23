//! What the `card_ops_*_db` suites share: a door with slice `card-ops` wired on a real Postgres, a stand-in svc-ledger
//! that books the five recipes the card moves post (`withdrawHold`, `withdrawSettle`, `withdrawReverse`, `rewardPay`,
//! `sweepFeesToRewards`) once per business key with a balance per account (the TypeScript tests' `MemoryLedger`), the
//! founders' approval desk, a recording bus, a switchable posting freeze and a TEST rate source.
//!
//! The stand-in's accounts: a person's `available` and each authorisation's hold (`hold`, purpose
//! `withdraw:<authorisation id>`); the rail boundary a capture lands in (`rail/<issuer>`); the rewards pot
//! (`house/rewards-engine`) and the bank's fees it is swept from (`house/fees:bank`). A post whose source would go below
//! zero refuses `ledger.insufficient_funds`, as svc-ledger's does.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test harness: each suite uses part of it, and a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use service_kit::approvals::{
    ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding, random_uuid,
};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::cards::core::{self, IssueAsk};
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::terms::{CashbackRates, PartnerTerms};
use svc_bank::cards::{RankTier, Settings, Wiring as CardsWiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::loans::prices::{MarkQuality, Marks, PriceSource, QuotedMark};
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::Bus;
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

pub use support::TestDb;

pub const SECRET: &str = "a-bank-card-ops-db-edge-secret-long-enough";
pub const INTERNAL: &str = "a-bank-card-ops-db-internal-secret-long-ok";
pub const HOLDER: &str = "11111111-1111-4111-8111-111111111111";
pub const OTHER: &str = "22222222-2222-4222-8222-222222222222";
pub const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
pub const APPROVER: &str = "88888888-8888-4888-8888-888888888888";
pub const CUSTOMER: &[&str] = &["bank:read", "bank:write"];
pub const DESK: &[&str] = &["admin:read", "admin:treasury"];

pub fn uuid() -> String {
    random_uuid().unwrap()
}

pub fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

pub fn now() -> Instant {
    door::system_now()
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in ledger

/// How the next matching post fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fail {
    /// svc-ledger unreachable: nothing books, the outcome is unknown to the caller.
    Unknown,
    /// A typed refusal before anything books (`ledger.invalid_entry`, `ledger.frozen`, ...).
    Coded(String),
    /// The post books, then its reply is lost, once.
    LoseReplyOnce,
    /// The post books, then svc-ledger answers this code, once.
    LandThenRefuse(String),
}

type Account = (String, String, String, String, Option<String>);

fn key_of(a: &LedgerAccount) -> Account {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
        a.purpose.clone(),
    )
}

#[derive(Default)]
pub struct BookState {
    pub balances: BTreeMap<Account, Amount>,
    /// `(recipe, key, input, tx id)`, once per key.
    pub booked: Vec<(String, String, Json, String)>,
    /// A key prefix and how a post under it fails.
    pub fail: Option<(String, Fail)>,
    /// Every key a post was asked under, in order.
    pub asked: Vec<String>,
    /// Balance reads fail while set.
    pub reads_down: bool,
}

/// svc-ledger's stand-in (`MemoryLedger`).
#[derive(Clone, Default)]
pub struct Book(pub Arc<Mutex<BookState>>);

fn user(user: &str, asset: &str, kind: &str, purpose: Option<String>) -> Account {
    (
        "user".to_owned(),
        user.to_owned(),
        asset.to_owned(),
        kind.to_owned(),
        purpose,
    )
}

fn house(owner: &str, asset: &str) -> Account {
    (
        "house".to_owned(),
        owner.to_owned(),
        asset.to_owned(),
        "available".to_owned(),
        None,
    )
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

impl Book {
    pub fn credit(&self, a: Account, amount: &str) {
        *self.0.lock().unwrap().balances.entry(a).or_default() += amt(amount);
    }
    pub fn fund(&self, who: &str, asset: &str, amount: &str) {
        self.credit(user(who, asset, "available", None), amount);
    }
    /// Real bank revenue the cashback pot is swept from.
    pub fn fees(&self, asset: &str, amount: &str) {
        self.credit(house("fees:bank", asset), amount);
    }
    fn bal(&self, a: &Account) -> Amount {
        self.0.lock().unwrap().balances.get(a).copied().unwrap_or(0)
    }
    pub fn available(&self, who: &str, asset: &str) -> String {
        format_amount(self.bal(&user(who, asset, "available", None)))
    }
    pub fn held(&self, authorization_id: &str, who: &str, asset: &str) -> String {
        format_amount(self.bal(&user(
            who,
            asset,
            "hold",
            Some(format!("withdraw:{authorization_id}")),
        )))
    }
    pub fn rail(&self, issuer: &str, asset: &str) -> String {
        format_amount(self.bal(&(
            "rail".to_owned(),
            issuer.to_owned(),
            asset.to_owned(),
            "boundary".to_owned(),
            None,
        )))
    }
    pub fn pot(&self, asset: &str) -> String {
        format_amount(self.bal(&house("rewards-engine", asset)))
    }
    /// Every account in one asset summed: what was credited in, never more or less.
    pub fn total(&self, asset: &str) -> String {
        format_amount(
            self.0
                .lock()
                .unwrap()
                .balances
                .iter()
                .filter(|(k, _)| k.2 == asset)
                .map(|(_, v)| *v)
                .sum(),
        )
    }
    /// Every hold account in one asset summed.
    pub fn all_holds(&self, asset: &str) -> String {
        format_amount(
            self.0
                .lock()
                .unwrap()
                .balances
                .iter()
                .filter(|(k, _)| k.2 == asset && k.3 == "hold")
                .map(|(_, v)| *v)
                .sum(),
        )
    }
    pub fn booked(&self, prefix: &str) -> usize {
        self.0
            .lock()
            .unwrap()
            .booked
            .iter()
            .filter(|b| b.1.starts_with(prefix))
            .count()
    }
    pub fn asked(&self, prefix: &str) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .asked
            .iter()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect()
    }
    pub fn journal_len(&self) -> usize {
        self.0.lock().unwrap().booked.len()
    }
    pub fn tx_id(&self, key: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .booked
            .iter()
            .find(|b| b.1 == key)
            .map(|b| b.3.clone())
    }
    pub fn input_of(&self, key: &str) -> Option<Json> {
        self.0
            .lock()
            .unwrap()
            .booked
            .iter()
            .find(|b| b.1 == key)
            .map(|b| b.2.clone())
    }
    pub fn fail_on(&self, prefix: &str, f: Fail) {
        self.0.lock().unwrap().fail = Some((prefix.to_owned(), f));
    }
    pub fn heal(&self) {
        self.0.lock().unwrap().fail = None;
    }
    pub fn reads_down(&self, down: bool) {
        self.0.lock().unwrap().reads_down = down;
    }

    /// One recipe's legs: the source and the destination.
    fn legs(recipe: &str, input: &Json) -> (Account, Account) {
        let asset = s(input, "assetId");
        match recipe {
            "withdrawHold" | "withdrawSettle" | "withdrawReverse" => {
                let u = s(input, "userId");
                let hold = user(
                    &u,
                    &asset,
                    "hold",
                    Some(format!("withdraw:{}", s(input, "withdrawalId"))),
                );
                let available = user(&u, &asset, "available", None);
                match recipe {
                    "withdrawHold" => (available, hold),
                    "withdrawSettle" => (
                        hold,
                        (
                            "rail".to_owned(),
                            s(input, "rail"),
                            asset,
                            "boundary".to_owned(),
                            None,
                        ),
                    ),
                    _ => (hold, available),
                }
            }
            "rewardPay" => (
                house("rewards-engine", &asset),
                user(&s(input, "userId"), &asset, "available", None),
            ),
            "sweepFeesToRewards" => (house("fees:bank", &asset), house("rewards-engine", &asset)),
            other => panic!("the card moves post no {other}"),
        }
    }
}

fn tx(id: &str, key: &str) -> LedgerTx {
    LedgerTx {
        id: id.to_owned(),
        key: key.to_owned(),
        posted_at: now(),
        entries: Vec::new(),
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        if self.0.lock().unwrap().reads_down {
            return Err("svc-ledger unreachable".to_owned());
        }
        Ok(self.bal(&key_of(a)))
    }
    fn balances(&self, _t: &str, _o: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Ok(Vec::new())
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self.tx_id(key).map(|id| tx(&id, key)))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let mut st = self.0.lock().unwrap();
        st.asked.push(key.to_owned());
        let fail = st
            .fail
            .clone()
            .filter(|(prefix, _)| key.starts_with(prefix.as_str()))
            .map(|(_, f)| f);
        match &fail {
            Some(Fail::Unknown) => {
                return Err(PostFailure::Unknown("svc-ledger unreachable".to_owned()));
            }
            Some(Fail::Coded(code)) => {
                return Err(PostFailure::Coded {
                    code: code.clone(),
                    message: "refused".to_owned(),
                    attempts: 1,
                });
            }
            _ => {}
        }
        if let Some(b) = st.booked.iter().find(|b| b.1 == key) {
            let id = b.3.clone();
            drop(st);
            return Ok(tx(&id, key));
        }
        let (from, to) = Book::legs(recipe, input);
        let amount = amt(&s(input, "amount"));
        let have = st.balances.get(&from).copied().unwrap_or(0);
        if have < amount {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!("Insufficient funds: {} has {}", from.1, format_amount(have)),
                attempts: 1,
            });
        }
        *st.balances.entry(from).or_default() -= amount;
        *st.balances.entry(to).or_default() += amount;
        let id = format!("tx-{}", st.booked.len() + 1);
        st.booked
            .push((recipe.to_owned(), key.to_owned(), input.clone(), id.clone()));
        match fail {
            Some(Fail::LoseReplyOnce) => {
                st.fail = None;
                return Err(PostFailure::Unknown("reply lost after commit".to_owned()));
            }
            Some(Fail::LandThenRefuse(code)) => {
                st.fail = None;
                return Err(PostFailure::Coded {
                    code,
                    message: "reward ack lost".to_owned(),
                    attempts: 1,
                });
            }
            _ => {}
        }
        Ok(tx(&id, key))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The approval desk, the bus, the freeze, the rates and the rank

type Issued = (BTreeMap<String, (String, String)>, usize);

/// `deskApprovals()`: an approval bound to one action and its fields, consumed once.
#[derive(Clone, Default)]
pub struct Desk(pub Arc<Mutex<Issued>>);

impl Desk {
    pub fn issue(&self, action: &str, fields: &[(String, String)]) -> Vec<(&'static str, Json)> {
        let id = uuid();
        self.0.lock().unwrap().0.insert(
            id.clone(),
            (action.to_owned(), payload_hash(action, fields)),
        );
        vec![
            ("approvalId", Json::str(id)),
            ("operationId", Json::str(uuid())),
        ]
    }
    pub fn consumed(&self) -> usize {
        self.0.lock().unwrap().1
    }
}

impl Approvals for Desk {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        _principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let mut st = self.0.lock().unwrap();
        let refused = || ConsumeError::Refused("approval does not match this change".to_owned());
        let (action, hash) = st.0.remove(input.approval_id).ok_or_else(refused)?;
        if hash != input.payload_hash || input.target_id != action {
            return Err(refused());
        }
        st.1 += 1;
        Ok((
            Consumed {
                action_type: action.clone(),
                target_service: "svc-bank".to_owned(),
                target_id: action,
                status: "CONSUMED".to_owned(),
                requester_id: OPERATOR.to_owned(),
                approver_id: Some(APPROVER.to_owned()),
                approver_is_founder: Some(true),
                requester_is_founder: Some(true),
            },
            Facts {
                kind: None,
                expires_at: Instant(now().0 + 60_000).iso(),
            },
        ))
    }
}

#[derive(Default)]
pub struct BusState {
    pub sent: Vec<(String, String, Json)>,
    pub down: bool,
}

/// The bus, recording what it took; down while `down`.
#[derive(Clone, Default)]
pub struct Recorder(pub Arc<Mutex<BusState>>);

impl Bus for Recorder {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        let mut st = self.0.lock().unwrap();
        if st.down {
            return Err("bus unreachable".to_owned());
        }
        st.sent
            .push((subject.to_owned(), msg_id.to_owned(), envelope.clone()));
        Ok(())
    }
}

impl Recorder {
    pub fn down(&self, down: bool) {
        self.0.lock().unwrap().down = down;
    }
    pub fn sent(&self) -> Vec<(String, String, Json)> {
        self.0.lock().unwrap().sent.clone()
    }
}

/// svc-ledger's posting freeze, switchable.
#[derive(Clone, Default)]
pub struct Posting(pub Arc<AtomicBool>);

impl Posting {
    pub fn freeze(&self, frozen: bool) {
        self.0.store(frozen, Ordering::SeqCst);
    }
}

impl Freeze for Posting {
    fn read(&self) -> Result<FreezeReading, String> {
        let frozen = self.0.load(Ordering::SeqCst);
        Ok(FreezeReading {
            posting_enabled: !frozen,
            cause: frozen.then(|| "person".to_owned()),
        })
    }
}

#[derive(Default)]
pub struct RateState {
    /// The funding asset's price in the settlement asset, its age in ms, and its quality; none quotes nothing.
    pub mark: Option<(Amount, i64, MarkQuality)>,
    pub asked: usize,
}

/// The conversion rate source: one funding asset's mark, settable, counting each ask.
#[derive(Clone, Default)]
pub struct Rates(pub Arc<Mutex<RateState>>);

impl Rates {
    pub fn set(&self, price: &str, age_ms: i64, quality: MarkQuality) {
        self.0.lock().unwrap().mark = Some((amt(price), age_ms, quality));
    }
    pub fn clear(&self) {
        self.0.lock().unwrap().mark = None;
    }
    pub fn asked(&self) -> usize {
        self.0.lock().unwrap().asked
    }
}

impl PriceSource for Rates {
    fn marks(&self, asset_ids: &[String], _quote: &str) -> Marks {
        let mut st = self.0.lock().unwrap();
        st.asked += 1;
        let mut out = Marks::new();
        if let (Some((price, age, quality)), Some(asset)) = (st.mark, asset_ids.first()) {
            out.insert(
                asset.clone(),
                QuotedMark::new(asset.clone(), price, Instant(now().0 - age), quality),
            );
        }
        out
    }
}

/// identity's rank door: one tier for everyone, or `bank.rank_unavailable`; switchable while the door runs.
#[derive(Clone, Default)]
pub struct Rank(pub Arc<Mutex<Option<&'static str>>>);

impl Rank {
    pub fn set(&self, tier: Option<&'static str>) {
        *self.0.lock().unwrap() = tier;
    }
}

impl RankTier for Rank {
    fn card_tier_of(&self, _user: &str) -> Result<String, Refusal> {
        let tier = *self.0.lock().unwrap();
        tier.map(str::to_owned).ok_or_else(|| {
            svc_bank::partner::refuse("bank.rank_unavailable", "IDENTITY_URL is unset")
        })
    }
}

struct NoPeople;

impl Directory for NoPeople {
    fn handles_of(&self, _ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok(BTreeMap::new())
    }
    fn find_active(&self, _q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        Ok(None)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door

/// What one door is wired with.
pub struct Opts {
    /// The TEST partner (its switches, and the TEST partner card's holds).
    pub partner: bool,
    /// `LEDGER_CUSTODY_LAYER`.
    pub custody_on: bool,
    pub issuer: Issuer,
    pub settings: Settings,
    pub rank: Option<&'static str>,
}

impl Default for Opts {
    fn default() -> Opts {
        Opts {
            partner: false,
            custody_on: true,
            issuer: Issuer::sim(PartnerTerms::nothing_reported()),
            settings: Settings::default(),
            rank: None,
        }
    }
}

/// The TEST partner card: holds the crypto, 100 USDT, 500 USDC and 1 BTC reported, spends from all three.
pub fn partner_terms() -> PartnerTerms {
    PartnerTerms {
        custody_mode: Some("partner_holds".to_owned()),
        balances: Some(vec![
            ("USDT".to_owned(), "100".to_owned()),
            ("USDC".to_owned(), "500".to_owned()),
            ("BTC".to_owned(), "1".to_owned()),
        ]),
        spend_from: Some(vec!["USDT".to_owned(), "USDC".to_owned(), "BTC".to_owned()]),
        ..PartnerTerms::nothing_reported()
    }
}

/// Cashback by rank tier: standard 100 bps, metal 200, in `asset`.
pub fn tier_rates(asset: &str) -> CashbackRates {
    svc_bank::cards::terms::parse_cashback_rates(Some(&format!(
        r#"{{"assetId":"{asset}","rates":{{"standard":100,"metal":200}}}}"#
    )))
    .unwrap()
}

pub struct Kit {
    pub db: TestDb,
    pub ledger: Book,
    pub desk: Desk,
    pub bus: Recorder,
    pub posting: Posting,
    pub rates: Rates,
    pub rank: Rank,
    pub door: BankDoor,
}

pub fn kit(o: Opts) -> Option<Kit> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let desk = Desk::default();
    let bus = Recorder::default();
    let posting = Posting::default();
    let rates = Rates::default();
    let rank = Rank::default();
    rank.set(o.rank);
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.approvals = Box::new(desk.clone());
    transfers.bus = Box::new(bus.clone());
    let mut loans = svc_bank::loans::Wiring::none();
    loans.prices = Box::new(rates.clone());
    let door = BankDoor::new(DoorConfig {
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
    .with_partner(PartnerWiring {
        partner: o.partner.then(|| TestPartner::new().unwrap()),
        freeze: Box::new(posting.clone()),
        custody_layer: if o.custody_on { "on" } else { "off" }.to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: None,
            unlock_wait_hours: None,
        },
        terms: Terms {
            invite_minutes: None,
            people_cap: None,
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables {
            account_terms: None,
            currencies: None,
            plans: None,
            fees: None,
            dormancy: None,
        },
    })
    .with_transfers(transfers)
    .with_loans(loans)
    .with_cards(CardsWiring {
        issuer: o.issuer,
        rank: Box::new(rank.clone()),
        holds: Default::default(),
        settings: o.settings,
    });
    Some(Kit {
        db,
        ledger,
        desk,
        bus,
        posting,
        rates,
        rank,
        door,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Calls

pub fn principal(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
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

#[derive(Debug, Clone)]
pub struct Answer(pub u16, pub Json);

impl Answer {
    pub fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    /// The refusal's own code (`cause.code`), tRPC's code where there is none, or `ok`.
    pub fn code(&self) -> String {
        let data = self.1.get("error").and_then(|e| e.get("data"));
        match (
            self.0,
            data.and_then(|d| d.get("cause"))
                .and_then(|c| c.get("code")),
            data.and_then(|d| d.get("code")),
        ) {
            (200, _, _) => "ok".to_owned(),
            (_, Some(Json::String(c)), _) | (_, None, Some(Json::String(c))) => c.clone(),
            (status, _, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
    pub fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

pub fn call(k: &Kit, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    let input = input.compact();
    let mut headers = principal(user, scopes);
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(&input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = k.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-card-ops-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// The approval's action and the fields it binds, per call.
fn binding(path: &str) -> (&'static str, &'static [&'static str]) {
    match path {
        "ops.cardAuthorize" => (
            "bank.card_authorize",
            &["cardId", "authorizationRef", "amount"],
        ),
        "ops.cardThreeDSChallenge" => (
            "bank.card_3ds_challenge",
            &[
                "cardId",
                "challengeId",
                "challengeRef",
                "amount",
                "merchantCategory",
                "merchant",
                "merchantCountry",
            ],
        ),
        "ops.cardCapture" => (
            "bank.card_capture",
            &["cardId", "authorizationRef", "amount"],
        ),
        "ops.cardReverse" => ("bank.card_reverse", &["cardId", "authorizationRef"]),
        "ops.cardResumeSettlement" => (
            "bank.card_resume_settlement",
            &["cardId", "authorizationRef"],
        ),
        "ops.fundCashbackPot" => ("bank.fund_cashback_pot", &["windowId", "assetId", "amount"]),
        other => panic!("{other} takes no approval"),
    }
}

/// One `ops.*` card move, with a fresh founders' approval bound to it.
pub fn op(k: &Kit, path: &str, fields: &[(&str, Json)]) -> Answer {
    let (action, keys) = binding(path);
    let bound: Vec<(String, String)> = keys
        .iter()
        .filter_map(|key| {
            fields.iter().find(|(f, _)| f == key).map(|(_, v)| match v {
                Json::String(s) => ((*key).to_owned(), s.clone()),
                other => ((*key).to_owned(), other.compact()),
            })
        })
        .collect();
    let mut all: Vec<(String, Json)> = fields
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect();
    for (k2, v) in k.desk.issue(action, &bound) {
        all.push((k2.to_owned(), v));
    }
    call(k, OPERATOR, DESK, path, &Json::Object(all))
}

pub fn authorize(k: &Kit, card: &str, reference: &str, amount: &str) -> Answer {
    op(
        k,
        "ops.cardAuthorize",
        &[
            ("cardId", Json::str(card)),
            ("authorizationRef", Json::str(reference)),
            ("amount", Json::str(amount)),
        ],
    )
}

pub fn authorize_with(
    k: &Kit,
    card: &str,
    reference: &str,
    amount: &str,
    extra: &[(&str, Json)],
) -> Answer {
    let mut fields = vec![
        ("cardId", Json::str(card)),
        ("authorizationRef", Json::str(reference)),
        ("amount", Json::str(amount)),
    ];
    fields.extend(extra.iter().cloned());
    op(k, "ops.cardAuthorize", &fields)
}

pub fn capture(k: &Kit, card: &str, reference: &str, amount: &str) -> Answer {
    op(
        k,
        "ops.cardCapture",
        &[
            ("cardId", Json::str(card)),
            ("authorizationRef", Json::str(reference)),
            ("amount", Json::str(amount)),
        ],
    )
}

pub fn reverse(k: &Kit, card: &str, reference: &str) -> Answer {
    op(
        k,
        "ops.cardReverse",
        &[
            ("cardId", Json::str(card)),
            ("authorizationRef", Json::str(reference)),
        ],
    )
}

pub fn resume(k: &Kit, card: &str, reference: &str) -> Answer {
    op(
        k,
        "ops.cardResumeSettlement",
        &[
            ("cardId", Json::str(card)),
            ("authorizationRef", Json::str(reference)),
        ],
    )
}

/// `fundCashbackPot`: real bank revenue first, then the sweep into the pot.
pub fn fund_pot(k: &Kit, asset: &str, amount: &str) -> Answer {
    k.ledger.fees(asset, amount);
    op(
        k,
        "ops.fundCashbackPot",
        &[
            ("windowId", Json::str(format!("w-{}", uuid()))),
            ("assetId", Json::str(asset)),
            ("amount", Json::str(amount)),
        ],
    )
}

/// `testPartner.set` for one person.
pub fn partner_set(k: &Kit, user: &str, fields: &[(&str, &str)]) {
    let input = Json::Object(
        fields
            .iter()
            .map(|(k2, v)| ((*k2).to_owned(), Json::str(*v)))
            .collect(),
    );
    let a = call(k, user, CUSTOMER, "testPartner.set", &input);
    assert_eq!(a.0, 200, "{}", a.1.compact());
}

/// What a card is issued with.
#[derive(Default)]
pub struct CardAsk {
    pub user: Option<&'static str>,
    pub asset: Option<&'static str>,
    pub settlement: Option<&'static str>,
    pub limit: Option<&'static str>,
    pub cashback_bps: Option<i64>,
    pub uses: Option<i64>,
}

pub fn issue(k: &Kit, ask: CardAsk) -> String {
    let card_id = uuid();
    k.door
        .cards_deps(now(), |d| {
            core::issue(
                d,
                &IssueAsk {
                    card_id: card_id.clone(),
                    user_id: ask.user.unwrap_or(HOLDER).to_owned(),
                    asset_id: ask.asset.unwrap_or("USDT").to_owned(),
                    settlement_asset_id: ask.settlement.map(str::to_owned),
                    cashback_bps: ask.cashback_bps,
                    per_authorization_limit: amt(ask.limit.unwrap_or("1000")),
                    uses_allowed: ask.uses,
                    ..IssueAsk::default()
                },
            )
        })
        .unwrap();
    card_id
}

pub fn set_status(k: &Kit, card: &str, status: &str) {
    k.door
        .cards_deps(now(), |d| core::set_status(d, card, status, None))
        .unwrap();
}

pub fn text(j: &Json, key: &str) -> String {
    s(j, key)
}

/// One row's text columns, by SQL.
pub fn row(k: &Kit, sql: &str) -> Vec<Option<String>> {
    let r = k.db.client().query(sql, &[]).unwrap();
    let Some(r) = r.first() else {
        return Vec::new();
    };
    (0..r.len())
        .map(|i| r.get::<_, Option<String>>(i))
        .collect()
}

pub fn count(k: &Kit, sql: &str) -> i64 {
    k.db.count(sql)
}

pub fn amount_text(v: Option<String>) -> String {
    v.map_or_else(|| "null".to_owned(), |s| format_amount(amt(&s)))
}
