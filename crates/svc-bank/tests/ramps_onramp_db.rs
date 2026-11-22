//! Slice `ramps`' on-ramp half against the Rust door on a real Postgres: add money, the customer's quotes and on-ramps,
//! the operator's credit, the desk's ramp reads, the pay-in partner's job doors, TEST page and loopback record. Each test
//! is named after the TypeScript test's words and enters through the door, as the TypeScript drives the router; the
//! partner's "paid" and "returned", which the TypeScript calls on the service, go through their signed job doors here,
//! and its approve through `/test/payin-sim/pay/:id/approve`.
//!
//! Ported:
//! - `ramps/add-money.db`: all 45. The two `partnerHolds` tests call it through the door (a call of slice `spaces`); the
//!   tests that check a credit's hold read it from the TEST partner itself. `paid with no hash` goes through the job
//!   door, whose body shape refuses `0x1234` (`bank.validation_failed`) before the work would.
//! - `ops/onramp-quotes.db`: all 5 (its two page-size refusals in one test, over both calls).
//! - `ramps/ramps.test`: the on-ramp and credit tests (no programme, fiat with mode none, a live rail, no or sandbox pay
//!   rails, a moving rail id, a non-positive fiat amount, a blank asset, the deposit, idempotence and its conflict). A
//!   negative amount is refused by the door's schema, so only `0` reaches the credit. Left: its off-ramp, cooling,
//!   destination, sanctions-on-send and conservation tests (the off-ramp is ported elsewhere) and its pure programme
//!   tests (held by `rails.rs`).
//! - `ramps/ramps-fiat-product`, `ramps/ramps.reachable`: the programme, `fiatSettle` (empty, in-repo, live) and `live`
//!   doors, and a customer refused `ops.creditOnramp`. Left: their off-ramp halves and source-text checks.
//! - `ramps/customer-ramps-deposits`: `onrampQuote`, `onrampCreate`, the bank-transfer instruction and `offrampQuote`'s
//!   refusals. Left: `offrampQuote` with a fee schedule (no fee source is wired anywhere yet) and the address-book,
//!   deposit and asset tests (other parts of the slice).
//! - `ramps/test-ramp-switches`: both.
//! - `ops/ramp-health`, `ops/ramp-metrics`, `ramps/payin-sim`, `ramps/test-ramp-partner-record`: through the doors (the
//!   window refusal and the crypto rail's attempts; no data versus the partner's book; the page; the record on loopback
//!   only and equal to the desk). Left: their pure catalogue-parsing and book-arithmetic unit tests, and
//!   `onramp-sim`, `pay-fiat-adapter`, `ramp-partner-book` unit suites, whose functions are pure and not doors.
//! - `ramps/ramp-kind-crypto`: the fiat refusals. Left: its direct-insert table checks (the migration's).
//!
//! Added for the Rust port's money path: a credit whose ledger answer is lost after booking, one svc-ledger refuses,
//! and one with the custodial layer off.
//!
//! The ledger is a stand-in that books `deposit` once per business key, can refuse with svc-ledger's code, or loses its
//! answer after booking. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use k256::ecdsa::SigningKey;
use service_kit::approvals::{
    ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding, random_uuid,
};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use sha3::{Digest, Keccak256};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, Funding, TestPartner};
use svc_bank::ramps::onramp::payin::{self, PayinSim};
use svc_bank::ramps::onramp::ports::{
    BankInstruction, Instruction, OpenAsk, PaymentPort, QuoteAsk, QuoteSource, QuoteTerms,
};
use svc_bank::ramps::onramp::{Wiring as OnrampWiring, add_money, rails, sim};
use svc_bank::ramps::{Settings as RampSettings, Wiring as RampsWiring};
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-ramps-onramp-db-edge-secret-long-ok";
const INTERNAL: &str = "a-bank-ramps-onramp-db-internal-secret-ok";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
const APPROVER: &str = "88888888-8888-4888-8888-888888888888";
const IBAN: &str = "GB82WEST12345698765432";
const CUSTOMER: &[&str] = &["bank:read", "bank:write"];
const DESK: &[&str] = &["admin:read", "admin:treasury"];
/// Well-known public development keys (the first two accounts of common local EVM chains). They hold nothing; TEST only.
const KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WALLET: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const STRANGER_KEY: &str = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CLEAR_LIST: &str = "*:0x00000000000000000000000000000000005a1c7d";

fn uuid() -> String {
    random_uuid().unwrap()
}

fn now_ms() -> i64 {
    door::system_now().0
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

#[derive(Default)]
struct BookState {
    /// Every post booked, by business key, in order.
    booked: Vec<(String, String, Json)>,
    available: BTreeMap<(String, String), Amount>,
    /// svc-ledger refuses every post with this code.
    refuse: Option<String>,
    /// The next post books and then its answer is lost.
    lose_next: bool,
    asked: usize,
}

/// svc-ledger: `deposit` booked once per key, the person's `available` per asset.
#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

impl Book {
    fn journal(&self) -> Vec<(String, String, Json)> {
        self.0.lock().unwrap().booked.clone()
    }
    fn available(&self, user: &str) -> Amount {
        self.0
            .lock()
            .unwrap()
            .available
            .get(&(user.to_owned(), "USDT".to_owned()))
            .copied()
            .unwrap_or(0)
    }
    fn asked(&self) -> usize {
        self.0.lock().unwrap().asked
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .available
            .get(&(a.owner_id.clone(), a.asset_id.clone()))
            .copied()
            .unwrap_or(0))
    }
    fn balances(&self, _t: &str, _o: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Ok(Vec::new())
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let mut st = self.0.lock().unwrap();
        st.asked += 1;
        if let Some(code) = st.refuse.clone() {
            return Err(PostFailure::Coded {
                code,
                message: "svc-ledger refused the post".to_owned(),
                attempts: 1,
            });
        }
        let n = st.booked.iter().position(|(_, k, _)| k == key);
        let id = match n {
            Some(i) => format!("tx-{i}"),
            None => {
                assert_eq!(recipe, "deposit");
                let user = s(input, "userId");
                let asset = s(input, "assetId");
                let amount = amt(&s(input, "amount"));
                *st.available.entry((user, asset)).or_default() += amount;
                st.booked
                    .push((recipe.to_owned(), key.to_owned(), input.clone()));
                format!("tx-{}", st.booked.len() - 1)
            }
        };
        if std::mem::take(&mut st.lose_next) {
            return Err(PostFailure::Unknown("reply lost after commit".to_owned()));
        }
        Ok(LedgerTx {
            id,
            key: key.to_owned(),
            posted_at: door::system_now(),
            entries: Vec::new(),
        })
    }
}

/// TEST rate source: a fee and an estimate for bank transfer, no estimate for card, nothing at all for wallet.
struct TestQuotes;

impl QuoteSource for TestQuotes {
    fn quote(&self, ask: &QuoteAsk, now: Instant) -> Result<Option<QuoteTerms>, Refusal> {
        if ask.method == "wallet_pay" {
            return Ok(None);
        }
        let card = ask.method == "card";
        Ok(Some(QuoteTerms {
            pay_amount: "20.50".to_owned(),
            fee: if card { "0.50" } else { "0" }.to_owned(),
            rate: "1".to_owned(),
            pay_currency: Some("EUR".to_owned()),
            expires_at: Some(Instant(now.0 + 10 * 60_000)),
            delivery_estimate: (!card).then(|| "TEST 1 business day".to_owned()),
        }))
    }
}

/// TEST partner: bank details for a bank transfer, a hosted page for everything else; can be down or broken.
#[derive(Clone, Default)]
struct TestPay {
    opened: Arc<Mutex<Vec<String>>>,
    told: Arc<Mutex<Vec<Option<String>>>>,
    down: Arc<AtomicBool>,
    broken: bool,
}

impl TestPay {
    fn opened(&self) -> Vec<String> {
        self.opened.lock().unwrap().clone()
    }
}

impl PaymentPort for TestPay {
    fn open(&self, ask: &OpenAsk, _now: Instant) -> Result<Option<Instruction>, Refusal> {
        if self.down.load(Ordering::SeqCst) {
            return Err(Refusal::Other("partner unreachable".to_owned()));
        }
        if self.broken {
            return Ok(Some(Instruction {
                partner_rail: Some("TEST-hosted".to_owned()),
                hosted_url: Some("http://not-https.example.test".to_owned()),
                bank: None,
            }));
        }
        self.opened.lock().unwrap().push(ask.onramp_id.clone());
        self.told.lock().unwrap().push(ask.wallet_address.clone());
        Ok(Some(if ask.method == "bank_transfer" {
            Instruction {
                partner_rail: Some("TEST-bank".to_owned()),
                hosted_url: None,
                bank: Some(BankInstruction {
                    reference: Some("TEST-REF-1".to_owned()),
                    account_name: Some("TEST Account".to_owned()),
                    account_ref: Some(IBAN.to_owned()),
                }),
            }
        } else {
            Instruction {
                partner_rail: Some("TEST-hosted".to_owned()),
                hosted_url: Some(format!("https://pay.example.test/{}", ask.onramp_id)),
                bank: None,
            }
        }))
    }
}

/// The pay-in stand-in's port, told the wallet (`spy`).
struct Spy {
    inner: PayinSim,
    told: Arc<Mutex<Vec<Option<String>>>>,
}

impl PaymentPort for Spy {
    fn loopback_pages(&self) -> bool {
        true
    }
    fn open(&self, ask: &OpenAsk, now: Instant) -> Result<Option<Instruction>, Refusal> {
        self.told.lock().unwrap().push(ask.wallet_address.clone());
        self.inner.open(ask, now)
    }
}

/// Approvals issued (id to action and payload hash), and how many were consumed.
type Issued = (BTreeMap<String, (String, String)>, usize);

/// `deskApprovals()`: an approval is bound to one action and one set of fields, and is consumed once.
#[derive(Clone, Default)]
struct Desk(Arc<Mutex<Issued>>);

impl Desk {
    fn issue(&self, action: &str, fields: &[(&str, &str)]) -> Vec<(&'static str, Json)> {
        let id = uuid();
        let kv: Vec<(String, String)> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        self.0
            .lock()
            .unwrap()
            .0
            .insert(id.clone(), (action.to_owned(), payload_hash(action, &kv)));
        vec![
            ("approvalId", Json::str(id)),
            ("operationId", Json::str(uuid())),
        ]
    }
    fn consumed(&self) -> usize {
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
                expires_at: Instant(now_ms() + 60_000).iso(),
            },
        ))
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
// The door

/// What one door is wired with.
#[derive(Default)]
struct Opts {
    crypto: bool,
    live_pay: bool,
    quotes: bool,
    payments: Option<Box<dyn PaymentPort>>,
    stand_in: Option<sim::OnrampSim>,
    payin: Option<PayinSim>,
    partner: Option<TestPartner>,
    custody_off: bool,
    sanctions: Option<&'static str>,
}

struct Bank {
    db: TestDb,
    ledger: Book,
    desk: Desk,
}

/// `onrampSim` over its catalogue.
fn rates(seconds: i64, lines: &[(&str, &str)]) -> sim::OnrampSim {
    let quotes: Vec<String> = lines
        .iter()
        .map(|(country, method)| {
            format!(
                r#"{{"country":"{country}","method":"{method}","asset":"USDT","payCurrency":"EUR","rate":"2","fee":"1","deliveryEstimate":{}}}"#,
                if seconds == 30 { r#""TEST 1 day""# } else { "null" }
            )
        })
        .collect();
    let raw = format!(
        r#"{{"label":"TEST add-money stand-in","quoteValidSeconds":{seconds},"quotes":[{}]}}"#,
        quotes.join(",")
    );
    sim::OnrampSim {
        catalogue: sim::parse(Some(&raw)).unwrap(),
    }
}

/// `payinSim` with its loopback page and the app's return address.
fn pay_in(bank_transfer: bool) -> PayinSim {
    let raw = if bank_transfer {
        r#"{"label":"TEST pay-in stand-in","methods":["pay_by_bank"],"bankTransfer":{"accountName":"TEST pay-in stand-in account","accountRef":"NL91 ABNA 0417 1643 00"}}"#
    } else {
        r#"{"label":"TEST pay-in stand-in","methods":["pay_by_bank"]}"#
    };
    PayinSim::new(
        payin::parse(Some(raw)).unwrap(),
        url::Url::parse("http://127.0.0.1:14999").unwrap(),
        url::Url::parse("http://127.0.0.1:3210/bank/ramps/new").unwrap(),
        None,
    )
}

/// The add-money suite's local stack: the TEST rates for NL and the pay-in stand-in.
fn stack() -> Opts {
    Opts {
        stand_in: Some(rates(
            600,
            &[("NL", "pay_by_bank"), ("NL", "bank_transfer")],
        )),
        payin: Some(pay_in(false)),
        ..Opts::default()
    }
}

/// The rate source, a live pay rail and the crypto programme, with this partner.
fn priced(pay: TestPay) -> Opts {
    Opts {
        crypto: true,
        live_pay: true,
        quotes: true,
        payments: Some(Box::new(pay)),
        ..Opts::default()
    }
}

impl Bank {
    fn door(&self, o: Opts) -> BankDoor {
        let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let mut transfers = TransfersWiring::none();
        transfers.approvals = Box::new(self.desk.clone());
        let onramp = OnrampWiring {
            programme: if o.crypto {
                rails::CRYPTO_LEDGER
            } else {
                rails::NONE
            },
            pay_fiat: if o.live_pay {
                Box::new(rails::FixedPayFiat(vec![rails::RailSnapshot::new(
                    "TEST-fiat-rail",
                    "live",
                    &["onramp"],
                )]))
            } else {
                Box::new(rails::EmptyPayFiat)
            },
            quotes: o
                .quotes
                .then(|| Box::new(TestQuotes) as Box<dyn QuoteSource>),
            stand_in: o.stand_in,
            payments: o.payments,
            fees: None,
            partner: o.payin,
        };
        BankDoor::new(DoorConfig {
            edge_secret: SECRET.to_owned(),
            services: ServiceAuth {
                secret: Some(INTERNAL.to_owned()),
                keys: None,
                trpc_bind: BodyBind::AcceptBoth,
            },
            env,
            now: door::system_now,
            store: self.db.store(),
        })
        .unwrap()
        .with_partner(PartnerWiring {
            partner: o.partner,
            freeze: Box::new(Open),
            custody_layer: if o.custody_off { "off" } else { "on" }.to_owned(),
            cash_legs: None,
            pay_in: None,
        })
        .with_spaces(SpacesWiring {
            ledger: Box::new(self.ledger.clone()),
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
        .with_ramps(RampsWiring {
            settings: RampSettings {
                destination_sanctions: Some(o.sanctions.unwrap_or(CLEAR_LIST).to_owned())
                    .filter(|s| !s.is_empty()),
                app_env: Some("test".to_owned()),
                node_env: Some("test".to_owned()),
                ..RampSettings::default()
            },
            book: svc_bank::ramps::book::Wiring::none(),
            onramp,
        })
    }
    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }
    fn count(&self, q: &str) -> i64 {
        self.db.count(q)
    }
}

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    Some(Bank {
        db,
        ledger: Book::default(),
        desk: Desk::default(),
    })
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
            _ => format!("ok: {}", self.1.compact()),
        }
    }
    /// `codeOf(err)`: the tRPC answer's cause, or a REST door's own `code`.
    fn cause(&self) -> String {
        if let Some(Json::String(c)) = self.data("cause").and_then(|c| c.get("code").cloned()) {
            return c;
        }
        match self.1.get("code") {
            Some(Json::String(c)) if self.0 != 200 => c.clone(),
            _ => format!("no cause: {} {}", self.0, self.1.compact()),
        }
    }
    /// A job door's answer.
    fn body(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1.clone()
    }
}

fn send(
    door: &BankDoor,
    method: &str,
    url: &str,
    body: &str,
    headers: &[(String, String)],
) -> (u16, String) {
    let res = door.handle_from(
        &Request {
            method,
            url,
            headers,
            body,
        },
        "req-ramps-onramp-db",
        "127.0.0.1",
    );
    (res.status, res.body)
}

fn call(door: &BankDoor, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    let input = input.compact();
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(&input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input),
    };
    let mut headers = person(user, scopes);
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let (status, body) = send(door, method, &url, &body, &headers);
    Answer(status, json::parse(&body).unwrap())
}

/// The pay-in partner's signed job door.
fn job(door: &BankDoor, path: &str, input: &Json) -> Answer {
    let body = input.compact();
    let mut headers = s2s::legacy_headers("svc-bank", INTERNAL, &body, system_seconds()).unwrap();
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let (status, out) = send(door, "POST", path, &body, &headers);
    Answer(status, json::parse(&out).unwrap())
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
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

/// `toMatchObject`: every field of `want` is in `got` with the same value (objects compared the same way).
fn matches(got: &Json, want: &Json) {
    match want {
        Json::Object(fields) => {
            for (k, v) in fields {
                let g = got
                    .get(k)
                    .unwrap_or_else(|| panic!("no {k} in {}", got.compact()));
                matches(g, v);
            }
        }
        other => assert_eq!(got, other, "in {}", got.compact()),
    }
}

/// `{ ...ask, onramp: _ }`: the view without its instruction.
fn without_onramp(j: &Json) -> Json {
    match j {
        Json::Object(f) => Json::Object(f.iter().filter(|(k, _)| k != "onramp").cloned().collect()),
        other => other.clone(),
    }
}

fn ask(amount: &str, country: &str) -> Vec<(&'static str, Json)> {
    vec![
        ("assetId", Json::str("USDT")),
        ("amount", Json::str(amount)),
        ("country", Json::str(country)),
    ]
}

fn with(mut base: Vec<(&'static str, Json)>, more: &[(&'static str, Json)]) -> Json {
    for (k, v) in more {
        base.retain(|(b, _)| b != k);
        base.push((k, v.clone()));
    }
    obj(&base)
}

fn methods(door: &BankDoor, user: &str, amount: &str, country: &str) -> Vec<Json> {
    arr(&call(
        door,
        user,
        CUSTOMER,
        "addMoney.methods",
        &obj(&ask(amount, country)),
    )
    .ok()
    .get("methods")
    .cloned()
    .unwrap())
}

fn method<'m>(ms: &'m [Json], m: &str) -> &'m Json {
    ms.iter().find(|x| s(x, "method") == m).unwrap()
}

fn quote_id(ms: &[Json], m: &str) -> String {
    s(method(ms, m).get("quote").unwrap(), "quoteId")
}

fn start(door: &BankDoor, user: &str, input: &Json) -> Answer {
    call(door, user, CUSTOMER, "addMoney.start", input)
}

fn requests(door: &BankDoor, user: &str) -> Vec<Json> {
    arr(&call(
        door,
        user,
        CUSTOMER,
        "addMoney.requests",
        &obj(&[("limit", Json::int(10))]),
    )
    .ok())
}

fn request_of(door: &BankDoor, user: &str, id: &str) -> Answer {
    call(
        door,
        user,
        CUSTOMER,
        "addMoney.request",
        &obj(&[("requestId", Json::str(id))]),
    )
}

fn paid(door: &BankDoor, id: &str, amount: &str, currency: &str, tx: Option<&str>) -> Answer {
    let mut f = vec![
        ("requestId", Json::str(id)),
        ("paidAmount", Json::str(amount)),
        ("payCurrency", Json::str(currency)),
    ];
    if let Some(t) = tx {
        f.push(("deliveryTx", Json::str(t)));
    }
    job(door, "/internal/jobs/payin-sim/paid", &obj(&f))
}

fn returned(door: &BankDoor, id: &str) -> Answer {
    job(
        door,
        "/internal/jobs/payin-sim/returned",
        &obj(&[("requestId", Json::str(id))]),
    )
}

/// The payer approves on the TEST page.
fn approve(door: &BankDoor, id: &str) -> (u16, String) {
    let headers = vec![(
        "content-type".to_owned(),
        "application/x-www-form-urlencoded".to_owned(),
    )];
    send(
        door,
        "POST",
        &format!("/test/payin-sim/pay/{id}/approve"),
        "",
        &headers,
    )
}

/// The partner's own read of a payment it opened (`addMoney.opened`).
fn opened_view(door: &BankDoor, id: &str) -> Result<add_money::PageAnswer, Refusal> {
    door.ramps_deps(door.now(), |d| {
        let o = svc_bank::ramps::onramp::Onramp { w: &d.w.onramp };
        add_money::opened(d, &o, id)
    })
}

/// An opened pay-by-bank request on the local stack: the quote and the request.
fn opened(door: &BankDoor, user: &str) -> (Json, Json) {
    let nl = ask("12.345678", "NL");
    let ms = methods(door, user, "12.345678", "NL");
    let quote = method(&ms, "pay_by_bank").get("quote").cloned().unwrap();
    let request = start(
        door,
        user,
        &with(
            nl,
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("pay_by_bank")),
                ("quoteId", Json::str(s(&quote, "quoteId"))),
            ],
        ),
    )
    .ok();
    (quote, request)
}

/// What a wallet's `personal_sign` returns: the EIP-191 digest signed, as `r || s || v` with v 27/28.
fn personal_sign(message: &str, key_hex: &str) -> String {
    let key: Vec<u8> = (0..key_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&key_hex[i..i + 2], 16).unwrap())
        .collect();
    let key = SigningKey::from_slice(&key).unwrap();
    let mut h = Keccak256::new();
    h.update(format!("\x19Ethereum Signed Message:\n{}", message.len()).as_bytes());
    h.update(message.as_bytes());
    let digest = h.finalize();
    let (sig, id) = key.sign_prehash_recoverable(&digest).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(id.to_byte() + 27);
    format!(
        "0x{}",
        out.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

fn wallet_start(
    door: &BankDoor,
    user: &str,
    id: &str,
    signature: Option<String>,
    quote: Option<&str>,
) -> Answer {
    let mut f = vec![
        ("requestId", Json::str(id)),
        ("method", Json::str("pay_by_bank")),
        ("walletAddress", Json::str(WALLET)),
    ];
    if let Some(sig) = signature {
        f.push(("walletSignature", Json::str(sig)));
    }
    if let Some(q) = quote {
        f.push(("quoteId", Json::str(q)));
    }
    start(door, user, &with(ask("12.345678", "NL"), &f))
}

/// `toWallet`: an opened pay-by-bank request delivered to ADA's wallet.
fn to_wallet(door: &BankDoor, user: &str) -> (Json, Json) {
    let ms = methods(door, user, "12.345678", "NL");
    let quote = method(&ms, "pay_by_bank").get("quote").cloned().unwrap();
    let id = uuid();
    let sig = personal_sign(&add_money::wallet_delivery_message(&id, WALLET), KEY);
    let request = wallet_start(door, user, &id, Some(sig), Some(&s(&quote, "quoteId"))).ok();
    (quote, request)
}

const TX: &str = "0xabababababababababababababababababababababababababababababababab";

// ---------------------------------------------------------------------------------------------------------------
// ramps/add-money.db: the ways to pay

#[test]
fn with_no_partner_every_way_names_the_rail_it_needs_and_the_reason_and_writes_no_quote() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    let ms = methods(&door, ADA, "20", "de");
    let want: Vec<Json> = [
        ("bank_transfer", "rail.bank"),
        ("pay_by_bank", "rail.bank"),
        ("card", "rail.card"),
        ("wallet_pay", "rail.card"),
    ]
    .iter()
    .map(|(m, r)| {
        obj(&[
            ("method", Json::str(*m)),
            ("rail", Json::str(*r)),
            ("quote", Json::Null),
            ("blocker", Json::str("bank.fiat_ramp_socket")),
            ("standIn", Json::Null),
            ("payStandIn", Json::Null),
        ])
    })
    .collect();
    assert_eq!(ms, want);
    assert_eq!(b.count("SELECT count(*) FROM bank.ramp_onramp_quotes"), 0);
}

#[test]
fn with_a_rate_source_each_way_has_its_own_quote_a_blank_estimate_stays_blank_and_a_missing_quote_says_why()
 {
    let Some(b) = bank() else { return };
    let door = b.door(Opts {
        crypto: true,
        live_pay: true,
        quotes: true,
        ..Opts::default()
    });
    let ms = methods(&door, ADA, "20", "de");
    matches(
        method(&ms, "bank_transfer").get("quote").unwrap(),
        &obj(&[
            ("fee", Json::str("0")),
            ("payAmount", Json::str("20.5")),
            ("payCurrency", Json::str("EUR")),
            ("deliveryEstimate", Json::str("TEST 1 business day")),
        ]),
    );
    matches(
        method(&ms, "card").get("quote").unwrap(),
        &obj(&[("fee", Json::str("0.5")), ("deliveryEstimate", Json::Null)]),
    );
    assert_eq!(
        method(&ms, "wallet_pay"),
        &obj(&[
            ("method", Json::str("wallet_pay")),
            ("rail", Json::str("rail.card")),
            ("quote", Json::Null),
            ("blocker", Json::str("bank.onramp_rate_unset")),
            ("standIn", Json::Null),
            ("payStandIn", Json::Null),
        ])
    );
}

#[test]
fn a_bad_amount_or_country_refuses_the_whole_read_rather_than_reading_as_a_rail_problem() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    for (amount, country) in [("0", "de"), ("20", "DEU")] {
        let a = call(
            &door,
            ADA,
            CUSTOMER,
            "addMoney.methods",
            &obj(&ask(amount, country)),
        );
        assert_ne!(a.0, 200, "{}", a.1.compact());
    }
}

// the TEST rate stand-in of the local stack (J-bank-02 #4)

fn sim30() -> Opts {
    Opts {
        stand_in: Some(rates(30, &[("NL", "bank_transfer")])),
        ..Opts::default()
    }
}

#[test]
fn prices_only_what_it_lists_labelled_test_and_leaves_every_other_way_to_pay_refused_as_before() {
    let Some(b) = bank() else { return };
    let door = b.door(sim30());
    let ms = methods(&door, ADA, "20", "nl");
    matches(
        method(&ms, "bank_transfer"),
        &obj(&[
            (
                "quote",
                obj(&[
                    ("payAmount", Json::str("41")),
                    ("fee", Json::str("1")),
                    ("rate", Json::str("2")),
                    ("payCurrency", Json::str("EUR")),
                    ("deliveryEstimate", Json::str("TEST 1 day")),
                    ("simulated", Json::Bool(true)),
                ]),
            ),
            ("blocker", Json::Null),
            ("standIn", Json::str("TEST add-money stand-in")),
        ]),
    );
    assert_eq!(s(method(&ms, "card"), "blocker"), "bank.fiat_ramp_socket");
    assert_eq!(s(method(&ms, "card"), "quote"), "null");
    let de = methods(&door, ADA, "20", "de");
    assert!(de.iter().all(|m| s(m, "quote") == "null"
        && s(m, "blocker") == "bank.fiat_ramp_socket"
        && s(m, "standIn") == "null"));
}

#[test]
fn a_quote_accepted_after_it_ran_out_is_refused_keeps_nothing_and_posts_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(sim30());
    let q = quote_id(&methods(&door, ADA, "20", "nl"), "bank_transfer");
    b.sql(&format!(
        "UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second' WHERE id = '{q}'"
    ));
    let a = start(
        &door,
        ADA,
        &with(
            ask("20", "nl"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("bank_transfer")),
                ("quoteId", Json::str(q)),
            ],
        ),
    );
    assert_eq!(a.cause(), "bank.onramp_quote_expired");
    assert!(requests(&door, ADA).is_empty());
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_quote_accepted_in_time_still_ends_with_no_partner_to_pay_refused_with_the_rail_kept_once_nothing_posted()
 {
    let Some(b) = bank() else { return };
    let door = b.door(sim30());
    let q = quote_id(&methods(&door, ADA, "20", "nl"), "bank_transfer");
    let row = start(
        &door,
        ADA,
        &with(
            ask("20", "nl"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("bank_transfer")),
                ("quoteId", Json::str(q)),
            ],
        ),
    )
    .ok();
    matches(
        &row,
        &obj(&[
            ("status", Json::str("refused")),
            ("rail", Json::str("rail.bank")),
            ("refusalCode", Json::str("bank.fiat_ramp_socket")),
            ("onramp", Json::Null),
        ]),
    );
    assert!(b.ledger.journal().is_empty());
}

// a request

#[test]
fn with_no_partner_is_refused_with_the_rail_and_kept_once_and_posts_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    let id = uuid();
    let first = start(
        &door,
        ADA,
        &with(
            ask("20", "de"),
            &[
                ("requestId", Json::str(&id)),
                ("method", Json::str("bank_transfer")),
            ],
        ),
    )
    .ok();
    matches(
        &first,
        &obj(&[
            ("requestId", Json::str(&id)),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("20")),
            ("country", Json::str("DE")),
            ("method", Json::str("bank_transfer")),
            ("rail", Json::str("rail.bank")),
            ("status", Json::str("refused")),
            ("refusalCode", Json::str("bank.fiat_ramp_socket")),
            ("onramp", Json::Null),
        ]),
    );
    let again = start(
        &door,
        ADA,
        &with(
            ask("20.000", "de"),
            &[
                ("requestId", Json::str(&id)),
                ("method", Json::str("bank_transfer")),
            ],
        ),
    )
    .ok();
    assert_eq!(again, first);
    assert_eq!(requests(&door, ADA), vec![first]);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn opens_with_the_partner_bank_details_for_a_bank_transfer_a_hosted_page_for_pay_by_bank_once_each()
{
    let Some(b) = bank() else { return };
    let pay = TestPay::default();
    let door = b.door(priced(pay.clone()));
    let transfer = start(
        &door,
        ADA,
        &with(
            ask("20", "de"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("bank_transfer")),
            ],
        ),
    )
    .ok();
    matches(
        &transfer,
        &obj(&[
            ("status", Json::str("opened")),
            ("refusalCode", Json::Null),
            ("rail", Json::str("rail.bank")),
            (
                "onramp",
                obj(&[
                    ("status", Json::str("pending_payment")),
                    ("payAmount", Json::str("20.5")),
                    ("hostedUrl", Json::Null),
                    (
                        "bankInstructions",
                        obj(&[
                            ("reference", Json::str("TEST-REF-1")),
                            ("accountName", Json::str("TEST Account")),
                            ("accountRef", Json::str(IBAN)),
                        ]),
                    ),
                ]),
            ),
        ]),
    );
    let id = uuid();
    let q = quote_id(&methods(&door, ADA, "20", "de"), "pay_by_bank");
    let base = |quote: Option<String>| {
        let mut f = vec![
            ("requestId", Json::str(&id)),
            ("method", Json::str("pay_by_bank")),
        ];
        if let Some(q) = quote {
            f.push(("quoteId", Json::str(q)));
        }
        with(ask("20", "de"), &f)
    };
    let redirect = start(&door, ADA, &base(Some(q.clone()))).ok();
    assert_eq!(
        start(&door, ADA, &base(Some(q.to_uppercase()))).ok(),
        redirect
    );
    matches(
        redirect.get("onramp").unwrap(),
        &obj(&[
            (
                "hostedUrl",
                Json::str(format!("https://pay.example.test/{id}")),
            ),
            ("bankInstructions", Json::Null),
        ]),
    );
    start(&door, ADA, &base(None)).ok();
    assert_eq!(pay.opened().iter().filter(|o| **o == id).count(), 1);
    let ms: Vec<String> = requests(&door, ADA)
        .iter()
        .map(|r| s(r, "method"))
        .collect();
    assert_eq!(ms, ["pay_by_bank", "bank_transfer"]);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn an_accepted_quote_that_has_expired_is_refused_and_keeps_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(priced(TestPay::default()));
    let q = quote_id(&methods(&door, ADA, "20", "de"), "bank_transfer");
    b.sql(&format!(
        "UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second' WHERE id = '{q}'"
    ));
    let a = start(
        &door,
        ADA,
        &with(
            ask("20", "de"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("bank_transfer")),
                ("quoteId", Json::str(q)),
            ],
        ),
    );
    assert_eq!(a.cause(), "bank.onramp_quote_expired");
    assert!(requests(&door, ADA).is_empty());
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn the_same_id_on_other_terms_or_by_someone_else_is_a_conflict_and_requests_are_only_ever_the_callers_own()
 {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    let id = uuid();
    start(
        &door,
        ADA,
        &with(
            ask("20", "de"),
            &[("requestId", Json::str(&id)), ("method", Json::str("card"))],
        ),
    )
    .ok();
    for (who, amount, m) in [
        (ADA, "21", "card"),
        (ADA, "20", "wallet_pay"),
        (BOB, "20", "card"),
    ] {
        let a = start(
            &door,
            who,
            &with(
                ask(amount, "de"),
                &[("requestId", Json::str(&id)), ("method", Json::str(m))],
            ),
        );
        assert_eq!(a.cause(), "bank.ramp_conflict");
    }
    assert!(requests(&door, BOB).is_empty());
    assert_eq!(requests(&door, ADA).len(), 1);
}

#[test]
fn an_accepted_quote_must_be_the_callers_own_and_on_the_requests_terms_otherwise_nothing_is_kept_or_opened()
 {
    let Some(b) = bank() else { return };
    let pay = TestPay::default();
    let door = b.door(priced(pay.clone()));
    let q = quote_id(&methods(&door, ADA, "1", "de"), "bank_transfer");
    for more in [
        vec![("amount", Json::str("20"))],
        vec![("assetId", Json::str("USDC"))],
        vec![("country", Json::str("FR"))],
    ] {
        let mut f = vec![
            ("requestId", Json::str(uuid())),
            ("method", Json::str("bank_transfer")),
            ("quoteId", Json::str(&q)),
        ];
        f.extend(more);
        assert_eq!(
            start(&door, ADA, &with(ask("1", "de"), &f)).cause(),
            "bank.ramp_conflict"
        );
    }
    let stolen = start(
        &door,
        BOB,
        &with(
            ask("1", "de"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("bank_transfer")),
                ("quoteId", Json::str(&q)),
            ],
        ),
    );
    assert_eq!(stolen.cause(), "bank.onramp_quote_missing");
    assert_eq!(b.count("SELECT count(*) FROM bank.add_money_requests"), 0);
    assert!(pay.opened().is_empty());
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_zero_amount_is_refused_at_the_door_with_or_without_a_quote() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    for amount in ["0", "0.000"] {
        let a = start(
            &door,
            ADA,
            &with(
                ask(amount, "de"),
                &[
                    ("requestId", Json::str(uuid())),
                    ("method", Json::str("bank_transfer")),
                    ("quoteId", Json::str(uuid())),
                ],
            ),
        );
        assert_eq!(a.trpc(), "BAD_REQUEST");
    }
    assert_eq!(b.count("SELECT count(*) FROM bank.add_money_requests"), 0);
}

#[test]
fn is_kept_before_the_partner_is_called_a_failed_call_leaves_it_opening_in_the_list_and_the_same_id_opens_it_once()
 {
    let Some(b) = bank() else { return };
    let pay = TestPay::default();
    pay.down.store(true, Ordering::SeqCst);
    let door = b.door(priced(pay.clone()));
    let id = uuid();
    let input = with(
        ask("20", "de"),
        &[
            ("requestId", Json::str(&id)),
            ("method", Json::str("bank_transfer")),
        ],
    );
    assert_eq!(start(&door, ADA, &input).trpc(), "INTERNAL_SERVER_ERROR");
    let list = requests(&door, ADA);
    assert_eq!(list.len(), 1);
    matches(
        &list[0],
        &obj(&[
            ("requestId", Json::str(&id)),
            ("status", Json::str("opening")),
            ("refusalCode", Json::Null),
            ("onramp", Json::Null),
        ]),
    );
    pay.down.store(false, Ordering::SeqCst);
    let opened = start(&door, ADA, &input).ok();
    matches(
        &opened,
        &obj(&[
            ("requestId", Json::str(&id)),
            ("status", Json::str("opened")),
            ("onramp", obj(&[("onrampId", Json::str(&id))])),
        ]),
    );
    assert_eq!(start(&door, ADA, &input).ok(), opened);
    assert_eq!(pay.opened(), vec![id]);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn an_instruction_the_partner_already_opened_is_picked_up_on_retry_even_after_its_quote_expired() {
    let Some(b) = bank() else { return };
    let pay = TestPay::default();
    let door = b.door(priced(pay.clone()));
    let id = uuid();
    let input = with(
        ask("20", "de"),
        &[
            ("requestId", Json::str(&id)),
            ("method", Json::str("pay_by_bank")),
        ],
    );
    start(&door, ADA, &input).ok();
    b.sql(&format!(
        "UPDATE bank.add_money_requests SET status = 'opening', onramp_id = NULL, opened_at = NULL WHERE id = '{id}'"
    ));
    b.sql("UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second'");
    let again = start(&door, ADA, &input).ok();
    matches(
        &again,
        &obj(&[
            ("status", Json::str("opened")),
            (
                "onramp",
                obj(&[
                    ("onrampId", Json::str(&id)),
                    (
                        "hostedUrl",
                        Json::str(format!("https://pay.example.test/{id}")),
                    ),
                ]),
            ),
        ]),
    );
    assert_eq!(pay.opened(), vec![id]);
}

#[test]
fn a_request_still_opening_whose_quote_ran_out_before_any_instruction_is_refused_with_the_expiry() {
    let Some(b) = bank() else { return };
    let pay = TestPay::default();
    pay.down.store(true, Ordering::SeqCst);
    let door = b.door(priced(pay.clone()));
    let id = uuid();
    let input = with(
        ask("20", "de"),
        &[("requestId", Json::str(&id)), ("method", Json::str("card"))],
    );
    assert_ne!(start(&door, ADA, &input).0, 200);
    b.sql("UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second'");
    pay.down.store(false, Ordering::SeqCst);
    matches(
        &start(&door, ADA, &input).ok(),
        &obj(&[
            ("status", Json::str("refused")),
            ("refusalCode", Json::str("bank.onramp_quote_expired")),
            ("onramp", Json::Null),
        ]),
    );
    assert!(pay.opened().is_empty());
}

#[test]
fn a_partner_that_answers_with_a_broken_instruction_leaves_the_request_opening_never_refused_as_no_partner()
 {
    let Some(b) = bank() else { return };
    let door = b.door(priced(TestPay {
        broken: true,
        ..TestPay::default()
    }));
    let id = uuid();
    let a = start(
        &door,
        ADA,
        &with(
            ask("20", "de"),
            &[("requestId", Json::str(&id)), ("method", Json::str("card"))],
        ),
    );
    assert_eq!(a.cause(), "bank.onramp_instruction_missing");
    matches(
        &requests(&door, ADA)[0],
        &obj(&[
            ("requestId", Json::str(&id)),
            ("status", Json::str("opening")),
            ("refusalCode", Json::Null),
        ]),
    );
}

#[test]
fn a_programme_with_no_ramp_keeps_the_refusal_even_when_a_rate_source_exists() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts {
        crypto: false,
        ..priced(TestPay::default())
    });
    let row = start(
        &door,
        ADA,
        &with(
            ask("20", "de"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("pay_by_bank")),
            ],
        ),
    )
    .ok();
    matches(
        &row,
        &obj(&[
            ("status", Json::str("refused")),
            ("rail", Json::str("rail.bank")),
            ("refusalCode", Json::str("bank.fiat_ramp_socket")),
        ]),
    );
}

// paid through the TEST pay-in stand-in of the local stack (J-bank-02 #3, #5)

#[test]
fn labels_the_way_it_opens_and_opens_it_with_the_page_the_partner_answered_posting_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = opened(&door, ADA);
    let ms = methods(&door, ADA, "12.345678", "NL");
    matches(
        method(&ms, "pay_by_bank"),
        &obj(&[
            ("standIn", Json::str("TEST add-money stand-in")),
            ("payStandIn", Json::str("TEST pay-in stand-in")),
        ]),
    );
    assert_eq!(s(method(&ms, "bank_transfer"), "payStandIn"), "null");
    matches(
        &quote,
        &obj(&[
            ("amount", Json::str("12.345678")),
            ("payAmount", Json::str("25.691356")),
            ("payCurrency", Json::str("EUR")),
        ]),
    );
    let id = s(&request, "requestId");
    matches(
        &request,
        &obj(&[
            ("status", Json::str("opened")),
            ("pendingAt", Json::Null),
            ("creditedAt", Json::Null),
            ("creditedAmount", Json::Null),
            (
                "onramp",
                obj(&[
                    ("partnerRail", Json::str(payin::PAYIN_SIM_RAIL)),
                    (
                        "hostedUrl",
                        Json::str(format!("http://127.0.0.1:14999/test/payin-sim/pay/{id}")),
                    ),
                    ("amount", Json::str("12.345678")),
                    ("payAmount", Json::str("25.691356")),
                ]),
            ),
        ]),
    );
    assert_ne!(s(&request, "openedAt"), "null");
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_bank_transfer_it_does_not_open_still_ends_with_no_partner_refused_with_the_rail_nothing_posted()
 {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let q = quote_id(&methods(&door, ADA, "12.345678", "NL"), "bank_transfer");
    let row = start(
        &door,
        ADA,
        &with(
            ask("12.345678", "NL"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("bank_transfer")),
                ("quoteId", Json::str(q)),
            ],
        ),
    )
    .ok();
    matches(
        &row,
        &obj(&[
            ("status", Json::str("refused")),
            ("refusalCode", Json::str("bank.fiat_ramp_socket")),
            ("onramp", Json::Null),
        ]),
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn approved_on_the_page_is_pending_and_sends_the_payer_back_approving_again_changes_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (_quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    // The return address the page sends the payer back to.
    assert_eq!(
        opened_view(&door, &id).unwrap().return_url,
        format!("http://127.0.0.1:3210/bank/ramps/new?request={id}")
    );
    assert_eq!(approve(&door, &id).0, 303);
    let first = request_of(&door, ADA, &id).ok();
    matches(
        &first,
        &obj(&[("status", Json::str("pending")), ("creditedAt", Json::Null)]),
    );
    assert_ne!(s(&first, "pendingAt"), "null");
    assert_eq!(approve(&door, &id).0, 303);
    assert_eq!(request_of(&door, ADA, &id).ok(), first);
    // The page shows the approved state instead of the button.
    let (status, page) = send(&door, "GET", &format!("/test/payin-sim/pay/{id}"), "", &[]);
    assert_eq!(status, 200);
    assert!(page.contains("This payment is already approved."), "{page}");
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn paid_credits_the_quote_receive_amount_exactly_once_through_the_deposit_recipe_from_its_rail() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    approve(&door, &id);
    let pay = s(&quote, "payAmount");
    let first = paid(&door, &id, &pay, "EUR", None).body();
    matches(
        &first,
        &obj(&[
            ("status", Json::str("credited")),
            ("creditedAmount", Json::str(s(&quote, "amount"))),
        ]),
    );
    for at in ["createdAt", "openedAt", "pendingAt", "creditedAt"] {
        assert_ne!(s(&first, at), "null");
    }
    let (second, third) = std::thread::scope(|sc| {
        let a = sc.spawn(|| paid(&door, &id, &pay, "EUR", None).body());
        let c = sc.spawn(|| paid(&door, &id, &pay, "EUR", None).body());
        (a.join().unwrap(), c.join().unwrap())
    });
    assert_eq!(second, first);
    assert_eq!(third, first);
    let journal = b.ledger.journal();
    assert_eq!(journal.len(), 1);
    assert_eq!(
        journal[0].1,
        format!("deposit:{}:add-money:{id}", payin::PAYIN_SIM_RAIL)
    );
    // Invariant: the person gained the quote's receive amount to the last unit.
    assert_eq!(b.ledger.available(ADA), amt(&s(&quote, "amount")));
    matches(&request_of(&door, ADA, &id).ok(), &without_onramp(&first));
}

// to the person's own wallet (J-dex-protocol-05 #4)

#[test]
fn the_message_names_the_request_and_the_wallet_in_lower_case_and_says_nothing_moves() {
    assert_eq!(
        add_money::wallet_delivery_message("AAAAAAAA-0000-4000-8000-000000000000", WALLET),
        [
            "INTAFACED buy to wallet".to_owned(),
            "Request: aaaaaaaa-0000-4000-8000-000000000000".to_owned(),
            format!("Wallet: {}", WALLET.to_lowercase()),
            "Signing this proves you control this wallet, so a purchase can be delivered to it. It moves no funds and approves nothing else.".to_owned(),
        ]
        .join("\n")
    );
}

#[test]
fn a_wallet_the_person_has_not_signed_for_or_signed_for_another_request_is_refused_before_anything_is_kept()
 {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let id = uuid();
    for sig in [
        None,
        Some(personal_sign(
            &add_money::wallet_delivery_message(&id, WALLET),
            STRANGER_KEY,
        )),
        Some(personal_sign(
            &add_money::wallet_delivery_message(&uuid(), WALLET),
            KEY,
        )),
    ] {
        assert_eq!(
            wallet_start(&door, ADA, &id, sig, None).cause(),
            "bank.wallet_delivery_unproven"
        );
    }
    assert_eq!(b.count("SELECT count(*) FROM bank.add_money_requests"), 0);
    assert_eq!(b.count("SELECT count(*) FROM bank.customer_onramps"), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_wallet_the_sanctions_list_names_or_any_while_the_list_is_unset_is_refused_before_anything_is_kept()
 {
    let Some(b) = bank() else { return };
    let listed: &'static str = Box::leak(format!("*:{WALLET}").into_boxed_str());
    let mut codes = Vec::new();
    for list in [listed, ""] {
        let door = b.door(Opts {
            sanctions: Some(list),
            ..stack()
        });
        let id = uuid();
        let sig = personal_sign(&add_money::wallet_delivery_message(&id, WALLET), KEY);
        codes.push(wallet_start(&door, ADA, &id, Some(sig), None).cause());
    }
    assert_eq!(
        codes,
        [
            "bank.destination_sanctions_listed",
            "bank.destination_sanctions_unset"
        ]
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.add_money_requests"), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn tells_the_partner_the_wallet_keeps_it_in_lower_case_and_the_test_page_names_it_nothing_is_posted()
 {
    let Some(b) = bank() else { return };
    let told = Arc::new(Mutex::new(Vec::new()));
    let door = b.door(Opts {
        payments: Some(Box::new(Spy {
            inner: pay_in(false),
            told: told.clone(),
        })),
        ..stack()
    });
    let (_q, request) = to_wallet(&door, ADA);
    assert_eq!(*told.lock().unwrap(), vec![Some(WALLET.to_lowercase())]);
    matches(
        &request,
        &obj(&[
            ("status", Json::str("opened")),
            ("walletAddress", Json::str(WALLET.to_lowercase())),
            ("deliveredAt", Json::Null),
            ("deliveryTx", Json::Null),
        ]),
    );
    let id = s(&request, "requestId");
    let (status, page) = send(&door, "GET", &format!("/test/payin-sim/pay/{id}"), "", &[]);
    assert_eq!(status, 200);
    assert!(
        page.contains(&format!(
            "Delivered to the wallet {}",
            WALLET.to_lowercase()
        )),
        "{page}"
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn paid_with_its_on_chain_transfer_is_delivered_once_crediting_nothing_anywhere_here() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = to_wallet(&door, ADA);
    let id = s(&request, "requestId");
    approve(&door, &id);
    let pay = s(&quote, "payAmount");
    let upper = TX.to_uppercase().replace("0X", "0x");
    let first = paid(&door, &id, &pay, "EUR", Some(&upper)).body();
    matches(
        &first,
        &obj(&[
            ("status", Json::str("delivered")),
            ("deliveryTx", Json::str(TX)),
            ("creditedAt", Json::Null),
            ("creditedAmount", Json::Null),
            ("creditedBy", Json::Null),
        ]),
    );
    assert_ne!(s(&first, "deliveredAt"), "null");
    let (second, third) = std::thread::scope(|sc| {
        let a = sc.spawn(|| paid(&door, &id, &pay, "EUR", Some(&upper)).body());
        let c = sc.spawn(|| paid(&door, &id, &pay, "EUR", Some(&upper)).body());
        (a.join().unwrap(), c.join().unwrap())
    });
    assert_eq!(second, first);
    assert_eq!(third, first);
    assert!(b.ledger.journal().is_empty());
    assert_eq!(b.ledger.available(ADA), 0);
    matches(&request_of(&door, ADA, &id).ok(), &without_onramp(&first));
}

#[test]
fn paid_without_the_transfer_or_with_no_hash_is_refused_and_changes_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = to_wallet(&door, ADA);
    let id = s(&request, "requestId");
    for tx in [None, Some("0x1234")] {
        let a = paid(&door, &id, &s(&quote, "payAmount"), "EUR", tx);
        // `0x1234` is not in the job body's shape: the door refuses it before the work.
        let want = if tx.is_some() {
            "bank.validation_failed"
        } else {
            "bank.onramp_delivery_missing"
        };
        assert_eq!(a.cause(), want);
    }
    matches(
        &request_of(&door, ADA, &id).ok(),
        &obj(&[("status", Json::str("opened")), ("deliveredAt", Json::Null)]),
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn another_transfer_for_a_delivered_purchase_or_a_transfer_for_a_balance_request_is_a_conflict() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = to_wallet(&door, ADA);
    let id = s(&request, "requestId");
    let pay = s(&quote, "payAmount");
    paid(&door, &id, &pay, "EUR", Some(TX)).body();
    let other = format!("0x{}", "cd".repeat(32));
    assert_eq!(
        paid(&door, &id, &pay, "EUR", Some(&other)).cause(),
        "bank.ramp_conflict"
    );
    let (bq, br) = opened(&door, BOB);
    let bid = s(&br, "requestId");
    assert_eq!(
        paid(&door, &bid, &s(&bq, "payAmount"), "EUR", Some(TX)).cause(),
        "bank.ramp_conflict"
    );
    assert_eq!(s(&request_of(&door, BOB, &bid).ok(), "status"), "opened");
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_delivered_purchase_is_never_returned_here_and_the_same_id_for_a_balance_is_a_conflict() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = to_wallet(&door, ADA);
    let id = s(&request, "requestId");
    paid(&door, &id, &s(&quote, "payAmount"), "EUR", Some(TX)).body();
    assert_eq!(returned(&door, &id).cause(), "bank.ramp_conflict");
    let again = start(
        &door,
        ADA,
        &with(
            ask("12.345678", "NL"),
            &[
                ("requestId", Json::str(&id)),
                ("method", Json::str("pay_by_bank")),
            ],
        ),
    );
    assert_eq!(again.cause(), "bank.ramp_conflict");
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn refuses_a_wallet_that_is_not_an_address_before_keeping_anything() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let a = start(
        &door,
        ADA,
        &with(
            ask("12.345678", "NL"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("pay_by_bank")),
                ("walletAddress", Json::str(format!("0x{}", "0".repeat(40)))),
            ],
        ),
    );
    assert_eq!(a.cause(), "bank.ramp_invalid_destination");
    assert_eq!(b.count("SELECT count(*) FROM bank.add_money_requests"), 0);
}

#[test]
fn a_crash_after_the_credit_and_before_the_row_said_so_catches_up_on_the_next_paid_crediting_nothing_twice()
 {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    let pay = s(&quote, "payAmount");
    paid(&door, &id, &pay, "EUR", None).body();
    b.sql(&format!(
        "UPDATE bank.add_money_requests SET status = 'opened', credited_at = NULL, credited_amount = NULL, \
           ledger_tx_id = NULL WHERE id = '{id}'"
    ));
    matches(
        &paid(&door, &id, &pay, "EUR", None).body(),
        &obj(&[
            ("status", Json::str("credited")),
            ("creditedAmount", Json::str(s(&quote, "amount"))),
        ]),
    );
    assert_eq!(b.ledger.journal().len(), 1);
    assert_eq!(b.ledger.available(ADA), amt(&s(&quote, "amount")));
}

#[test]
fn paid_in_another_amount_or_currency_than_the_payment_opened_credits_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    for (amount, currency) in [
        ("25.691355".to_owned(), "EUR"),
        (s(&quote, "payAmount"), "GBP"),
    ] {
        assert_eq!(
            paid(&door, &id, &amount, currency, None).cause(),
            "bank.onramp_paid_mismatch"
        );
    }
    assert!(b.ledger.journal().is_empty());
    assert_eq!(
        opened_view(&door, &id).unwrap().viewed.request.status,
        "opened"
    );
}

#[test]
fn a_refused_request_an_unknown_id_or_a_request_someone_else_asks_for_is_never_approved_credited_or_shown()
 {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let refused = start(
        &door,
        ADA,
        &with(
            ask("20", "DE"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("card")),
            ],
        ),
    )
    .ok();
    assert_eq!(s(&refused, "status"), "refused");
    let rid = s(&refused, "requestId");
    let (status, body) = approve(&door, &rid);
    assert_eq!(status, 409, "{body}");
    assert!(body.contains("bank.ramp_conflict"));
    assert_eq!(
        paid(&door, &rid, "1", "EUR", None).cause(),
        "bank.ramp_conflict"
    );
    let (status, body) = approve(&door, &uuid());
    assert_eq!(status, 404, "{body}");
    assert!(body.contains("bank.add_money_request_missing"));
    let (_q, request) = opened(&door, ADA);
    assert_eq!(
        request_of(&door, BOB, &s(&request, "requestId")).cause(),
        "bank.add_money_request_missing"
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_bank_transfer_it_gives_bank_details_for_opens_with_its_own_test_reference_and_account_posting_nothing()
 {
    let Some(b) = bank() else { return };
    let door = b.door(Opts {
        payin: Some(pay_in(true)),
        ..stack()
    });
    let ms = methods(&door, ADA, "12.345678", "NL");
    let offered = method(&ms, "bank_transfer");
    assert_eq!(s(offered, "payStandIn"), "TEST pay-in stand-in");
    let id = uuid();
    let input = with(
        ask("12.345678", "NL"),
        &[
            ("requestId", Json::str(&id)),
            ("method", Json::str("bank_transfer")),
            (
                "quoteId",
                Json::str(s(offered.get("quote").unwrap(), "quoteId")),
            ),
        ],
    );
    let row = start(&door, ADA, &input).ok();
    let reference = format!("TEST-{}", id.replace('-', "")[..12].to_uppercase());
    matches(
        &row,
        &obj(&[
            ("status", Json::str("opened")),
            (
                "onramp",
                obj(&[
                    ("partnerRail", Json::str(payin::PAYIN_SIM_RAIL)),
                    ("hostedUrl", Json::Null),
                    (
                        "bankInstructions",
                        obj(&[
                            ("reference", Json::str(reference)),
                            ("accountName", Json::str("TEST pay-in stand-in account")),
                            ("accountRef", Json::str("NL91ABNA0417164300")),
                        ]),
                    ),
                ]),
            ),
        ]),
    );
    assert_eq!(
        start(&door, ADA, &input).ok().get("onramp"),
        row.get("onramp")
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_payment_the_custodial_layer_credited_on_the_ledger_is_never_taken_back_here_refused_and_the_ledger_posts_nothing_more()
 {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    paid(&door, &id, &s(&quote, "payAmount"), "EUR", None).body();
    assert_eq!(returned(&door, &id).cause(), "bank.ramp_conflict");
    assert_eq!(b.ledger.journal().len(), 1);
    assert_eq!(b.ledger.available(ADA), amt(&s(&quote, "amount")));
    let v = opened_view(&door, &id).unwrap().viewed.request;
    assert_eq!((v.status.as_str(), v.returned_at), ("credited", None));
}

#[test]
fn a_request_not_credited_refused_or_unknown_is_never_returned_and_nothing_moves() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (_q, request) = opened(&door, ADA);
    let refused = start(
        &door,
        ADA,
        &with(
            ask("20", "DE"),
            &[
                ("requestId", Json::str(uuid())),
                ("method", Json::str("card")),
            ],
        ),
    )
    .ok();
    for id in [s(&request, "requestId"), s(&refused, "requestId")] {
        assert_eq!(returned(&door, &id).cause(), "bank.ramp_conflict");
    }
    assert_eq!(
        returned(&door, &uuid()).cause(),
        "bank.add_money_request_missing"
    );
    let v = opened_view(&door, &s(&request, "requestId"))
        .unwrap()
        .viewed
        .request;
    assert_eq!((v.status.as_str(), v.returned_at), ("opened", None));
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn with_no_pay_in_partner_wired_approving_and_paid_refuse_by_name_and_nothing_moves() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    let plain = b.door(Opts {
        stand_in: Some(rates(600, &[("NL", "pay_by_bank")])),
        ..Opts::default()
    });
    // With no partner its page is not mounted at all; the job door refuses by name.
    assert_eq!(approve(&plain, &id).0, 404);
    assert_eq!(
        paid(&plain, &id, &s(&quote, "payAmount"), "EUR", None).cause(),
        "bank.fiat_ramp_socket"
    );
    let page = plain.ramps_deps(plain.now(), |d| {
        let o = svc_bank::ramps::onramp::Onramp { w: &d.w.onramp };
        add_money::approved(d, &o, &id).map(|_| ())
    });
    assert!(matches!(page, Err(Refusal::Bank(e)) if e.row.code == "bank.fiat_ramp_socket"));
    assert!(b.ledger.journal().is_empty());
}

// for a person whose money the partner holds (J-wallet-01 #3; OWNER 226)

fn held_at_partner() -> TestPartner {
    let tp = TestPartner::new().unwrap();
    {
        let mut st = tp.lock();
        let mut sw = st.board.get(ADA);
        sw.custody = "off".to_owned();
        st.board.set(ADA, sw);
    }
    tp
}

fn at_partner(b: &Bank) -> BankDoor {
    b.door(Opts {
        partner: Some(held_at_partner()),
        ..stack()
    })
}

fn fund(door: &BankDoor, id: &str, amount: &str) {
    let p = door.partner().partner.as_ref().unwrap();
    p.lock()
        .fund(
            ADA,
            &Funding {
                fund_id: id.to_owned(),
                asset_id: "USDT".to_owned(),
                amount: amt(amount),
            },
            door.now(),
        )
        .unwrap();
}

fn partner_balance(door: &BankDoor) -> Amount {
    door.partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .book
        .amount(&AccountRef::main(ADA, "USDT"))
}

fn set_down(door: &BankDoor, down: bool) {
    let p = door.partner().partner.as_ref().unwrap();
    let mut st = p.lock();
    let mut sw = st.board.get(ADA);
    sw.down = down;
    st.board.set(ADA, sw);
}

#[test]
fn paid_is_credited_by_the_partner_once_held_back_until_its_release_time_and_the_ledger_posts_nothing()
 {
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    fund(&door, "fund-ada-50", "50");
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    approve(&door, &id);
    let pay = s(&quote, "payAmount");
    let before = now_ms();
    let first = paid(&door, &id, &pay, "EUR", None).body();
    matches(
        &first,
        &obj(&[
            ("status", Json::str("credited")),
            ("creditedAmount", Json::str(s(&quote, "amount"))),
            ("creditedBy", Json::str("partner")),
        ]),
    );
    let (second, third) = std::thread::scope(|sc| {
        let a = sc.spawn(|| paid(&door, &id, &pay, "EUR", None).body());
        let c = sc.spawn(|| paid(&door, &id, &pay, "EUR", None).body());
        (a.join().unwrap(), c.join().unwrap())
    });
    assert_eq!(second, first);
    assert_eq!(third, first);
    assert!(b.ledger.journal().is_empty());
    // Invariant: the partner's balance gained the receive amount exactly, once, and it holds all of it back.
    assert_eq!(
        partner_balance(&door),
        amt("50") + amt(&s(&quote, "amount"))
    );
    let holds = door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .purchase_holds(ADA, door.now())
        .unwrap()
        .unwrap();
    assert_eq!(holds.holds.len(), 1);
    assert!(holds.released.is_empty());
    let h = &holds.holds[0];
    assert_eq!(
        (h.asset_id.as_str(), h.amount, h.paid_by.as_str()),
        ("USDT", amt(&s(&quote, "amount")), "bank_pull")
    );
    assert!(
        h.release_at.0 >= before + svc_bank::partner::desks::hold_days("bank_pull") * 86_400_000
    );
}

#[test]
fn a_crash_after_the_partner_credited_and_before_the_row_said_so_catches_up_credited_once() {
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    let pay = s(&quote, "payAmount");
    paid(&door, &id, &pay, "EUR", None).body();
    b.sql(&format!(
        "UPDATE bank.add_money_requests SET status = 'opened', credited_at = NULL, credited_amount = NULL, \
           partner_pay_in_ref = NULL WHERE id = '{id}'"
    ));
    matches(
        &paid(&door, &id, &pay, "EUR", None).body(),
        &obj(&[
            ("status", Json::str("credited")),
            ("creditedBy", Json::str("partner")),
        ]),
    );
    assert_eq!(partner_balance(&door), amt(&s(&quote, "amount")));
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn the_partner_down_credits_nothing_and_leaves_the_request_as_it_was_for_its_next_paid() {
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    let pay = s(&quote, "payAmount");
    set_down(&door, true);
    assert_eq!(
        paid(&door, &id, &pay, "EUR", None).cause(),
        "bank.partner_unavailable"
    );
    matches(
        &request_of(&door, ADA, &id).ok(),
        &obj(&[("status", Json::str("opened")), ("creditedBy", Json::Null)]),
    );
    set_down(&door, false);
    matches(
        &paid(&door, &id, &pay, "EUR", None).body(),
        &obj(&[
            ("status", Json::str("credited")),
            ("creditedBy", Json::str("partner")),
        ]),
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn returned_is_taken_back_at_the_partner_once_its_hold_goes_and_the_ledger_posts_nothing() {
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    fund(&door, "fund-ada-50r", "50");
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    paid(&door, &id, &s(&quote, "payAmount"), "EUR", None).body();
    let first = returned(&door, &id).body();
    matches(
        &first,
        &obj(&[
            ("status", Json::str("returned")),
            ("creditedBy", Json::str("partner")),
            ("creditedAmount", Json::str(s(&quote, "amount"))),
        ]),
    );
    let (second, third) = std::thread::scope(|sc| {
        let a = sc.spawn(|| returned(&door, &id).body());
        let c = sc.spawn(|| returned(&door, &id).body());
        (a.join().unwrap(), c.join().unwrap())
    });
    assert_eq!(second, first);
    assert_eq!(third, first);
    assert!(b.ledger.journal().is_empty());
    assert_eq!(partner_balance(&door), amt("50"));
    let holds = door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .purchase_holds(ADA, door.now())
        .unwrap()
        .unwrap();
    assert!(holds.holds.is_empty());
}

#[test]
fn a_crash_after_the_partner_took_it_back_and_before_the_row_said_so_catches_up_taken_back_once() {
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    fund(&door, "fund-ada-50c", "50");
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    paid(&door, &id, &s(&quote, "payAmount"), "EUR", None).body();
    returned(&door, &id).body();
    b.sql(&format!(
        "UPDATE bank.add_money_requests SET status = 'credited', returned_at = NULL, return_ref = NULL WHERE id = '{id}'"
    ));
    assert_eq!(s(&returned(&door, &id).body(), "status"), "returned");
    assert_eq!(partner_balance(&door), amt("50"));
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn the_partner_down_takes_nothing_back_and_leaves_it_credited_for_its_next_returned() {
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    paid(&door, &id, &s(&quote, "payAmount"), "EUR", None).body();
    set_down(&door, true);
    assert_eq!(returned(&door, &id).cause(), "bank.partner_unavailable");
    matches(
        &request_of(&door, ADA, &id).ok(),
        &obj(&[
            ("status", Json::str("credited")),
            ("returnedAt", Json::Null),
        ]),
    );
    set_down(&door, false);
    assert_eq!(s(&returned(&door, &id).body(), "status"), "returned");
    assert!(b.ledger.journal().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// ramps.test, ramps.reachable, ramps-fiat-product, ramp-kind-crypto: the operator's credit through `ops.creditOnramp`

const USER: &str = ADA;

fn credit(
    b: &Bank,
    door: &BankDoor,
    asset: &str,
    amount: &str,
    kind: &str,
    rail_ref: &str,
) -> Answer {
    let ids = b.desk.issue(
        "bank.credit_onramp",
        &[
            ("userId", USER),
            ("assetId", asset),
            ("amount", amount),
            ("kind", kind),
            ("railRef", rail_ref),
        ],
    );
    let mut f = vec![
        ("userId", Json::str(USER)),
        ("assetId", Json::str(asset)),
        ("amount", Json::str(amount)),
        ("kind", Json::str(kind)),
        ("railRef", Json::str(rail_ref)),
    ];
    f.extend(ids);
    call(door, OPERATOR, DESK, "ops.creditOnramp", &obj(&f))
}

fn crypto() -> Opts {
    Opts {
        crypto: true,
        ..Opts::default()
    }
}

fn live_fiat() -> Opts {
    Opts {
        crypto: true,
        live_pay: true,
        ..Opts::default()
    }
}

fn onramp_rows(b: &Bank) -> i64 {
    b.count("SELECT count(*) FROM bank.ramp_onramps")
}

#[test]
fn credits_available_via_recipes_deposit_and_keeps_simulated_true() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    let row = credit(&b, &door, "USDT", "100", "crypto", "0xdeposit1").ok();
    matches(
        &row,
        &obj(&[
            ("userId", Json::str(USER)),
            ("amount", Json::str("100")),
            ("kind", Json::str("crypto")),
            ("status", Json::str("settled")),
            ("simulated", Json::Bool(true)),
            ("rail", Json::str(rails::BANK_CRYPTO_LEDGER_RAIL)),
            ("confirmOperatorId", Json::str(APPROVER)),
        ]),
    );
    assert_ne!(s(&row, "ledgerTxId"), "null");
    assert_eq!(b.ledger.available(USER), amt("100"));
    let journal = b.ledger.journal();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].1, "deposit:bank-crypto-ledger:0xdeposit1");
    assert_eq!(s(&journal[0].2, "railRef"), "0xdeposit1");
    assert_eq!(b.desk.consumed(), 1);
}

#[test]
fn is_idempotent_on_rail_rail_ref_and_refuses_a_conflicting_amount() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    let first = credit(&b, &door, "USDT", "50", "crypto", "same-ref").ok();
    let second = credit(&b, &door, "USDT", "50", "crypto", "same-ref").ok();
    assert_eq!(s(&second, "id"), s(&first, "id"));
    assert_eq!(b.ledger.available(USER), amt("50"));
    assert_eq!(
        credit(&b, &door, "USDT", "99", "crypto", "same-ref").cause(),
        "bank.ramp_conflict"
    );
    assert_eq!(b.ledger.journal().len(), 1);
}

/// The crash between claim and post: the pending row is the marker, and the re-drive books the same key once.
#[test]
fn a_credit_whose_ledger_answer_was_lost_after_booking_is_finished_by_the_re_drive_once() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    b.ledger.0.lock().unwrap().lose_next = true;
    assert_eq!(
        credit(&b, &door, "USDT", "10", "crypto", "lost-1").trpc(),
        "INTERNAL_SERVER_ERROR"
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.ramp_onramps WHERE status = 'pending'"),
        1
    );
    let again = credit(&b, &door, "USDT", "10", "crypto", "lost-1").ok();
    assert_eq!(s(&again, "status"), "settled");
    assert_eq!(b.ledger.journal().len(), 1);
    assert_eq!(b.ledger.available(USER), amt("10"));
}

#[test]
fn a_credit_svc_ledger_refuses_stays_pending_with_nothing_booked_and_the_re_drive_books_it_once() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    b.ledger.0.lock().unwrap().refuse = Some("ledger.frozen".to_owned());
    assert_eq!(
        credit(&b, &door, "USDT", "10", "crypto", "frozen-1").trpc(),
        "INTERNAL_SERVER_ERROR"
    );
    assert!(b.ledger.journal().is_empty());
    assert_eq!(b.count("SELECT count(*) FROM bank.ramp_onramps WHERE status = 'pending' AND ledger_tx_id IS NULL"), 1);
    b.ledger.0.lock().unwrap().refuse = None;
    assert_eq!(
        s(
            &credit(&b, &door, "USDT", "10", "crypto", "frozen-1").ok(),
            "status"
        ),
        "settled"
    );
    assert_eq!(b.ledger.journal().len(), 1);
}

#[test]
fn with_the_custodial_layer_off_a_credit_refuses_no_partner_bank_before_svc_ledger_is_asked() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts {
        custody_off: true,
        ..crypto()
    });
    assert_eq!(
        credit(&b, &door, "USDT", "10", "crypto", "off-1").cause(),
        "bank.no_partner_bank"
    );
    assert_eq!(b.ledger.asked(), 0);
    assert_eq!(b.ledger.available(USER), 0);
}

#[test]
fn refuses_every_money_path_when_no_programme_is_configured() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    assert_eq!(
        credit(&b, &door, "USDT", "10", "crypto", "tx-1").cause(),
        "bank.no_ramp_rail"
    );
    assert_eq!(onramp_rows(&b), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn refuses_fiat_on_bank_fiat_ramp_socket_when_mode_is_none_live_pay_adapter_cannot_sneak_a_default_rail()
 {
    let Some(b) = bank() else { return };
    let door = b.door(Opts {
        crypto: false,
        live_pay: true,
        ..Opts::default()
    });
    assert_eq!(
        credit(&b, &door, "USDT", "10", "fiat", "sneak-1").cause(),
        "bank.fiat_ramp_socket"
    );
    assert_eq!(
        call(&door, ADA, CUSTOMER, "ramps.fiatSettle", &Json::Null).cause(),
        "bank.fiat_ramp_socket"
    );
    assert_eq!(onramp_rows(&b), 0);
}

#[test]
fn refuses_a_fiat_on_ramp_when_a_live_pay_rail_is_injected() {
    let Some(b) = bank() else { return };
    let door = b.door(live_fiat());
    assert_eq!(
        credit(&b, &door, "USDT", "25", "fiat", "ach-in-1").cause(),
        "bank.fiat_ramp_socket"
    );
    assert_eq!(onramp_rows(&b), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn refuses_a_non_positive_fiat_amount_with_the_socket_before_a_row_or_a_deposit() {
    let Some(b) = bank() else { return };
    let door = b.door(live_fiat());
    assert_eq!(
        credit(&b, &door, "USDT", "0", "fiat", "ach-non-positive").cause(),
        "bank.fiat_ramp_socket"
    );
    assert_eq!(onramp_rows(&b), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn refuses_a_blank_or_whitespace_asset_before_any_row_or_ledger_post() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    assert_eq!(
        credit(&b, &door, "   ", "10", "crypto", "blank-asset-1").cause(),
        "bank.ramp_invalid_asset"
    );
    // A blank asset never reaches the credit: the door's schema refuses it.
    assert_eq!(
        credit(&b, &door, "", "10", "crypto", "blank-asset-2").trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(onramp_rows(&b), 0);
    assert_eq!(b.ledger.available(USER), 0);
}

#[test]
fn refuses_ops_credit_onramp_for_a_user_session_without_admin_treasury() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    let a = call(
        &door,
        ADA,
        CUSTOMER,
        "ops.creditOnramp",
        &obj(&[
            ("userId", Json::str(ADA)),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("10")),
            ("railRef", Json::str("self-credit")),
        ]),
    );
    assert_eq!(a.trpc(), "FORBIDDEN");
    assert_eq!(onramp_rows(&b), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn a_credit_without_its_second_persons_approval_or_with_one_for_other_terms_moves_nothing() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    let base = vec![
        ("userId", Json::str(USER)),
        ("assetId", Json::str("USDT")),
        ("amount", Json::str("10")),
        ("kind", Json::str("crypto")),
        ("railRef", Json::str("approved-1")),
    ];
    assert_eq!(
        call(&door, OPERATOR, DESK, "ops.creditOnramp", &obj(&base)).cause(),
        "action_approval.missing"
    );
    let other = b.desk.issue(
        "bank.credit_onramp",
        &[
            ("userId", USER),
            ("assetId", "USDT"),
            ("amount", "11"),
            ("kind", "crypto"),
            ("railRef", "approved-1"),
        ],
    );
    let mut f = base.clone();
    f.extend(other);
    assert_ne!(
        call(&door, OPERATOR, DESK, "ops.creditOnramp", &obj(&f)).0,
        200
    );
    assert_eq!(onramp_rows(&b), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn operator_credits_on_ramp_the_customer_lists_it_simulated_never_flips() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    let row = credit(&b, &door, "USDT", "5", "crypto", "list-1").ok();
    let list = arr(&call(
        &door,
        USER,
        CUSTOMER,
        "ramps.onramps",
        &obj(&[("limit", Json::int(10))]),
    )
    .ok());
    assert_eq!(list.len(), 1);
    matches(
        &list[0],
        &obj(&[
            ("id", Json::str(s(&row, "id"))),
            ("amount", Json::str("5")),
            ("railRef", Json::str("list-1")),
            ("simulated", Json::Bool(true)),
            ("status", Json::str("settled")),
        ]),
    );
    assert!(
        arr(&call(
            &door,
            BOB,
            CUSTOMER,
            "ramps.onramps",
            &obj(&[("limit", Json::int(10))])
        )
        .ok())
        .is_empty()
    );
    assert_eq!(
        call(&door, USER, CUSTOMER, "ramps.onramps", &obj(&[])).cause(),
        "bank.onramps_list_limit_unset"
    );
    assert_eq!(
        call(&door, USER, CUSTOMER, "ramps.offramps", &obj(&[])).cause(),
        "bank.offramps_list_limit_unset"
    );
}

// the programme and its probes (ramps-fiat-product, ramps.reachable)

#[test]
fn programme_is_none_when_ramps_option_is_omitted_and_names_fiat_via_without_inventing_a_bank_psp()
{
    let Some(b) = bank() else { return };
    let none = call(
        &b.door(Opts::default()),
        ADA,
        CUSTOMER,
        "ramps.programme",
        &Json::Null,
    )
    .ok();
    matches(
        &none,
        &obj(&[
            ("id", Json::str("none")),
            ("simulated", Json::Bool(true)),
            ("cryptoRail", Json::Null),
            ("fiatLeg", Json::str("socket.psp-partners")),
            ("fiatVia", Json::str("svc-pay.RailAdapter")),
        ]),
    );
    let on = call(
        &b.door(crypto()),
        ADA,
        CUSTOMER,
        "ramps.programme",
        &Json::Null,
    )
    .ok();
    matches(
        &on,
        &obj(&[
            ("simulated", Json::Bool(true)),
            ("cryptoRail", Json::str(rails::BANK_CRYPTO_LEDGER_RAIL)),
        ]),
    );
}

#[test]
fn ramps_fiat_settle_public_door_refuses_when_no_pay_adapter_can_settle_fiat() {
    let Some(b) = bank() else { return };
    let settle = |o: Opts| call(&b.door(o), ADA, CUSTOMER, "ramps.fiatSettle", &Json::Null).cause();
    assert_eq!(settle(crypto()), "bank.fiat_ramp_no_pay_adapter");
    // A live on-ramp rail with no off-ramp one still cannot settle.
    assert_eq!(settle(live_fiat()), "bank.no_fiat_rail");
    // Both live is still no outside cash company while the programme is simulated, which it always is.
    let both = b.door(crypto()).with_ramps(RampsWiring {
        settings: RampSettings::default(),
        book: svc_bank::ramps::book::Wiring::none(),
        onramp: OnrampWiring {
            programme: rails::CRYPTO_LEDGER,
            pay_fiat: Box::new(rails::FixedPayFiat(vec![rails::RailSnapshot::new(
                "pay-fiat-ach",
                "live",
                &["onramp", "offramp"],
            )])),
            ..OnrampWiring::none()
        },
    });
    assert_eq!(
        call(&both, ADA, CUSTOMER, "ramps.fiatSettle", &Json::Null).cause(),
        "bank.live_ramp_unset"
    );
    assert_eq!(
        call(
            &b.door(crypto()),
            ADA,
            CUSTOMER,
            "ramps.live",
            &obj(&[("amount", Json::str("10"))])
        )
        .cause(),
        "bank.live_ramp_unset"
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn ramps_fiat_settle_refuses_in_repo_sandbox_absent_pay_adapters() {
    let Some(b) = bank() else { return };
    let mut door = b.door(crypto());
    door = door.with_ramps(RampsWiring {
        settings: RampSettings::default(),
        book: svc_bank::ramps::book::Wiring::none(),
        onramp: OnrampWiring {
            programme: rails::CRYPTO_LEDGER,
            pay_fiat: Box::new(rails::FixedPayFiat(rails::in_repo_rails())),
            ..OnrampWiring::none()
        },
    });
    let a = call(&door, ADA, CUSTOMER, "ramps.fiatSettle", &Json::Null);
    assert_eq!(
        (a.trpc().as_str(), a.cause().as_str()),
        ("PRECONDITION_FAILED", "bank.no_fiat_rail")
    );
}

// customer-ramps-deposits: quotes and on-ramps through `ramps.*`

fn quote_ask(asset: &str, method: &str) -> Json {
    obj(&[
        ("assetId", Json::str(asset)),
        ("amount", Json::str("20")),
        ("method", Json::str(method)),
        ("country", Json::str("de")),
    ])
}

#[test]
fn onramp_quote_refuses_a_blank_psp_and_a_blank_rate_source_and_returns_the_source_decimals_when_both_exist()
 {
    let Some(b) = bank() else { return };
    let q = |o: Opts| {
        call(
            &b.door(o),
            ADA,
            CUSTOMER,
            "ramps.onrampQuote",
            &quote_ask("USDT", "card"),
        )
    };
    assert_eq!(q(Opts::default()).cause(), "bank.fiat_ramp_socket");
    assert_eq!(q(crypto()).cause(), "bank.fiat_ramp_no_pay_adapter");
    assert_eq!(q(live_fiat()).cause(), "bank.onramp_rate_unset");
    let quoted = q(Opts {
        quotes: true,
        ..live_fiat()
    })
    .ok();
    matches(
        &quoted,
        &obj(&[
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("20")),
            ("method", Json::str("card")),
            ("country", Json::str("DE")),
            ("payAmount", Json::str("20.5")),
            ("fee", Json::str("0.5")),
            ("rate", Json::str("1")),
            ("payCurrency", Json::str("EUR")),
            ("deliveryEstimate", Json::Null),
            ("simulated", Json::Bool(true)),
        ]),
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.ramp_onramp_quotes"), 1);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn onramp_create_is_idempotent_by_onramp_id_stores_the_partner_instruction_and_credits_nothing() {
    let Some(b) = bank() else { return };
    let pay = TestPay::default();
    let door = b.door(priced(pay.clone()));
    let quote = call(
        &door,
        ADA,
        CUSTOMER,
        "ramps.onrampQuote",
        &quote_ask("USDT", "card"),
    )
    .ok();
    let id = uuid();
    let create = |who: &str, q: &str| {
        call(
            &door,
            who,
            CUSTOMER,
            "ramps.onrampCreate",
            &obj(&[
                ("onrampId", Json::str(&id)),
                ("quoteId", Json::str(q)),
                ("method", Json::str("card")),
            ]),
        )
    };
    let first = create(ADA, &s(&quote, "quoteId")).ok();
    matches(
        &first,
        &obj(&[
            ("onrampId", Json::str(&id)),
            ("status", Json::str("pending_payment")),
            ("simulated", Json::Bool(true)),
            ("partnerRail", Json::str("TEST-hosted")),
            (
                "hostedUrl",
                Json::str(format!("https://pay.example.test/{id}")),
            ),
            ("bankInstructions", Json::Null),
        ]),
    );
    assert_eq!(create(ADA, &s(&quote, "quoteId")).ok(), first);
    assert_eq!(pay.opened(), vec![id.clone()]);
    // Someone else's quote is not found; the same id under another person is a conflict.
    assert_eq!(
        create(BOB, &s(&quote, "quoteId")).cause(),
        "bank.onramp_quote_missing"
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.customer_onramps"), 1);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn bank_transfer_instructions_are_the_partner_account_not_a_hosted_url() {
    let Some(b) = bank() else { return };
    let door = b.door(priced(TestPay::default()));
    let quote = call(
        &door,
        ADA,
        CUSTOMER,
        "ramps.onrampQuote",
        &quote_ask("USDT", "bank_transfer"),
    )
    .ok();
    let row = call(
        &door,
        ADA,
        CUSTOMER,
        "ramps.onrampCreate",
        &obj(&[
            ("onrampId", Json::str(uuid())),
            ("quoteId", Json::str(s(&quote, "quoteId"))),
            ("method", Json::str("bank_transfer")),
        ]),
    )
    .ok();
    matches(
        &row,
        &obj(&[
            ("hostedUrl", Json::Null),
            (
                "bankInstructions",
                obj(&[
                    ("reference", Json::str("TEST-REF-1")),
                    ("accountName", Json::str("TEST Account")),
                    ("accountRef", Json::str(IBAN)),
                ]),
            ),
        ]),
    );
}

#[test]
fn offramp_quote_refuses_fiat_and_an_unpublished_crypto_fee() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    let q = |kind: &str, dest: &str| {
        call(
            &door,
            ADA,
            CUSTOMER,
            "ramps.offrampQuote",
            &obj(&[
                ("assetId", Json::str("USDT")),
                ("amount", Json::str("10")),
                ("kind", Json::str(kind)),
                ("destinationRef", Json::str(dest)),
            ]),
        )
        .cause()
    };
    let evm = "0x1111111111111111111111111111111111111111";
    assert_eq!(q("fiat", IBAN), "bank.fiat_ramp_socket");
    assert_eq!(
        q("crypto", "not-an-address"),
        "bank.ramp_invalid_destination"
    );
    assert_eq!(q("crypto", evm), "bank.offramp_fee_unset");
}

// test-ramp-switches: the TEST ramp's switches

fn with_switch(partner: &TestPartner, f: impl FnOnce(&mut svc_bank::partner::switches::Switches)) {
    let mut st = partner.lock();
    let mut sw = st.board.get(ADA);
    f(&mut sw);
    st.board.set(ADA, sw);
}

#[test]
fn refuses_the_quote_bank_onramp_fee_not_known_and_keeps_nothing_off_the_same_ask_is_quoted() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts {
        partner: Some(TestPartner::new().unwrap()),
        ..sim30()
    });
    let p = door.partner().partner.as_ref().unwrap();
    with_switch(p, |s| s.ramp_fee = "unknown".to_owned());
    let ask = obj(&[
        ("assetId", Json::str("USDT")),
        ("amount", Json::str("20")),
        ("method", Json::str("bank_transfer")),
        ("country", Json::str("NL")),
    ]);
    assert_eq!(
        call(&door, ADA, CUSTOMER, "ramps.onrampQuote", &ask).cause(),
        "bank.onramp_fee_not_known"
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.ramp_onramp_quotes"), 0);
    with_switch(p, |s| s.ramp_fee = "known".to_owned());
    matches(
        &call(&door, ADA, CUSTOMER, "ramps.onrampQuote", &ask).ok(),
        &obj(&[
            ("fee", Json::str("1")),
            ("payAmount", Json::str("41")),
            ("payCurrency", Json::str("EUR")),
        ]),
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.ramp_onramp_quotes"), 1);
}

#[test]
fn a_live_quote_reads_as_run_out_and_accepting_it_refuses_bank_onramp_quote_expired_with_nothing_opened()
 {
    let Some(b) = bank() else { return };
    let pay = TestPay::default();
    let door = b.door(Opts {
        partner: Some(TestPartner::new().unwrap()),
        ..priced(pay.clone())
    });
    let quote = call(
        &door,
        ADA,
        CUSTOMER,
        "ramps.onrampQuote",
        &quote_ask("USDT", "card"),
    )
    .ok();
    with_switch(door.partner().partner.as_ref().unwrap(), |s| {
        s.ramp_quote = "expired".to_owned();
    });
    let a = call(
        &door,
        ADA,
        CUSTOMER,
        "ramps.onrampCreate",
        &obj(&[
            ("onrampId", Json::str(uuid())),
            ("quoteId", Json::str(s(&quote, "quoteId"))),
            ("method", Json::str("card")),
        ]),
    );
    assert_eq!(a.cause(), "bank.onramp_quote_expired");
    assert!(pay.opened().is_empty());
    assert_eq!(b.count("SELECT count(*) FROM bank.customer_onramps"), 0);
}

// ops/onramp-quotes.db: the desk's fiat buy reads

fn quote_row(b: &Bank, user: &str, created: &str, fee: &str) -> String {
    let id = uuid();
    b.sql(&format!(
        "INSERT INTO bank.ramp_onramp_quotes (id, user_id, asset_id, amount, method, country, pay_amount, fee, rate, \
           pay_currency, expires_at, simulated, created_at) \
         VALUES ('{id}', '{user}', 'USDT', '50', 'card', 'NL', '46.000000000000000001', '{fee}', '0.92', 'EUR', \
           '{created}'::timestamptz + interval '1 minute', true, '{created}')"
    ));
    id
}

fn asked_row(
    b: &Bank,
    user: &str,
    created: &str,
    refusal: Option<&str>,
    quote: Option<&str>,
) -> String {
    let id = uuid();
    let q = |v: Option<&str>| v.map_or_else(|| "NULL".to_owned(), |s| format!("'{s}'"));
    let status = if refusal.is_some() {
        "refused"
    } else {
        "opening"
    };
    b.sql(&format!(
        "INSERT INTO bank.add_money_requests (id, user_id, asset_id, amount, method, country, rail, status, refusal_code, \
           quote_id, created_at) \
         VALUES ('{id}', '{user}', 'USDT', '20.000000000000000001', 'bank_transfer', 'NL', 'rail.bank', '{status}', {}, \
           {}::uuid, '{created}')",
        q(refusal),
        q(quote)
    ));
    id
}

#[test]
fn lists_every_customers_fiat_buy_quotes_newest_first_with_the_exact_amounts_as_quoted() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    let older = quote_row(&b, ADA, "2026-11-06T09:00:00.000Z", "0.5");
    let newer = quote_row(&b, BOB, "2026-11-06T09:30:00.000Z", "1.250000000000000001");
    let rows = arr(&call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.onrampQuotes",
        &obj(&[("limit", Json::int(10))]),
    )
    .ok());
    assert_eq!(
        rows.iter().map(|r| s(r, "quoteId")).collect::<Vec<_>>(),
        [newer.clone(), older]
    );
    assert_eq!(
        rows[0],
        obj(&[
            ("quoteId", Json::str(&newer)),
            ("userId", Json::str(BOB)),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("50")),
            ("method", Json::str("card")),
            ("country", Json::str("NL")),
            ("payAmount", Json::str("46.000000000000000001")),
            ("fee", Json::str("1.250000000000000001")),
            ("rate", Json::str("0.92")),
            ("payCurrency", Json::str("EUR")),
            ("simulated", Json::Bool(true)),
            ("createdAt", Json::str("2026-11-06T09:30:00.000Z")),
            ("expiresAt", Json::str("2026-11-06T09:31:00.000Z")),
        ])
    );
    assert_eq!(
        arr(&call(
            &door,
            OPERATOR,
            &["admin:read"],
            "ops.onrampQuotes",
            &obj(&[("limit", Json::int(1))])
        )
        .ok())
        .len(),
        1
    );
}

#[test]
fn refuses_a_read_with_no_page_size_and_a_caller_who_is_not_an_operator() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    for path in ["ops.onrampQuotes", "ops.onrampFeesNotKnown"] {
        for limit in [None, Some(0), Some(101)] {
            let input = limit.map_or_else(|| obj(&[]), |n| obj(&[("limit", Json::int(n))]));
            let a = call(&door, OPERATOR, &["admin:read"], path, &input);
            assert_eq!(a.trpc(), "BAD_REQUEST");
            assert!(
                s(&a.1, "error").contains("bank.onramp_quotes_limit_unset"),
                "{}",
                a.1.compact()
            );
        }
        assert_eq!(
            call(
                &door,
                ADA,
                &["bank:read"],
                path,
                &obj(&[("limit", Json::int(10))])
            )
            .trpc(),
            "FORBIDDEN"
        );
    }
}

#[test]
fn lists_the_buys_the_partner_gave_no_fee_for_newest_first_as_not_known_no_fee_pay_amount_or_rate_is_read()
 {
    let Some(b) = bank() else { return };
    let door = b.door(Opts::default());
    let older = asked_row(
        &b,
        ADA,
        "2026-11-06T09:00:00.000Z",
        Some("bank.onramp_fee_not_known"),
        None,
    );
    let newer = asked_row(
        &b,
        BOB,
        "2026-11-06T09:30:00.000Z",
        Some("bank.onramp_fee_not_known"),
        None,
    );
    asked_row(
        &b,
        ADA,
        "2026-11-06T09:40:00.000Z",
        Some("bank.onramp_rate_unset"),
        None,
    );
    let q = quote_row(&b, ADA, "2026-11-06T09:50:00.000Z", "1");
    asked_row(&b, ADA, "2026-11-06T09:50:00.000Z", None, Some(&q));
    let q2 = quote_row(&b, BOB, "2026-11-06T09:55:00.000Z", "1");
    asked_row(
        &b,
        BOB,
        "2026-11-06T09:55:00.000Z",
        Some("bank.onramp_fee_not_known"),
        Some(&q2),
    );
    let read = call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.onrampFeesNotKnown",
        &obj(&[("limit", Json::int(10))]),
    )
    .ok();
    assert_eq!(s(&read, "testPartner"), "null");
    let rows = arr(read.get("rows").unwrap());
    assert_eq!(
        rows.iter().map(|r| s(r, "requestId")).collect::<Vec<_>>(),
        [newer.clone(), older]
    );
    assert_eq!(
        rows[0],
        obj(&[
            ("requestId", Json::str(&newer)),
            ("userId", Json::str(BOB)),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str("20.000000000000000001")),
            ("method", Json::str("bank_transfer")),
            ("country", Json::str("NL")),
            ("refusalCode", Json::str("bank.onramp_fee_not_known")),
            ("createdAt", Json::str("2026-11-06T09:30:00.000Z")),
        ])
    );
}

#[test]
fn labels_the_list_test_when_the_local_stacks_test_partner_ramp_is_the_one_that_gave_no_fee() {
    let Some(b) = bank() else { return };
    let door = b.door(Opts {
        partner: Some(TestPartner::new().unwrap()),
        ..Opts::default()
    });
    asked_row(
        &b,
        ADA,
        "2026-11-06T09:00:00.000Z",
        Some("bank.onramp_fee_not_known"),
        None,
    );
    let read = call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.onrampFeesNotKnown",
        &obj(&[("limit", Json::int(10))]),
    )
    .ok();
    assert_eq!(s(&read, "testPartner"), "TEST partner bank");
    assert_eq!(arr(read.get("rows").unwrap()).len(), 1);
}

// ops/ramp-health and ramp-metrics, payin-sim's book and its loopback record (test-ramp-partner-record)

#[test]
fn ramp_health_needs_its_window_and_reads_the_crypto_rails_attempts_with_no_heartbeat() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    let a = call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.rampHealth",
        &obj(&[]),
    );
    assert_eq!(a.cause(), "bank.ramp_health_window_unset");
    credit(&b, &door, "USDT", "5", "crypto", "health-1").ok();
    let h = call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.rampHealth",
        &obj(&[("windowHours", Json::int(24))]),
    )
    .ok();
    let rails = arr(h.get("rails").unwrap());
    matches(
        &rails[0],
        &obj(&[
            ("id", Json::str(rails::BANK_CRYPTO_LEDGER_RAIL)),
            ("openCount", Json::int(0)),
            ("failureCount", Json::int(0)),
            ("totalCount", Json::int(1)),
            ("failureRate", Json::str("0/1")),
            ("lastFailure", Json::Null),
            ("lastProbeAt", Json::Null),
            ("reason", Json::str("no_heartbeat")),
        ]),
    );
    assert_ne!(s(&rails[0], "lastSuccess"), "null");
    matches(
        &rails[1],
        &obj(&[
            ("id", Json::str("fiat")),
            ("provider", Json::str("unset")),
            ("failureRate", Json::Null),
        ]),
    );
}

#[test]
fn ramp_metrics_read_no_data_with_no_partner_and_the_partners_own_book_with_one() {
    let Some(b) = bank() else { return };
    let none = call(
        &b.door(Opts::default()),
        OPERATOR,
        &["admin:read"],
        "ops.rampMetrics",
        &obj(&[]),
    )
    .ok();
    assert_eq!(none, obj(&[("partner", Json::Null)]));
    let door = b.door(stack());
    let (quote, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    approve(&door, &id);
    paid(&door, &id, &s(&quote, "payAmount"), "EUR", None).body();
    let m = call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.rampMetrics",
        &obj(&[]),
    )
    .ok();
    let p = m.get("partner").unwrap();
    matches(
        p,
        &obj(&[
            ("label", Json::str("TEST pay-in stand-in")),
            ("health", Json::str("operational")),
        ]),
    );
    let paid_count = arr(p.get("orders").unwrap())
        .into_iter()
        .find(|o| s(o, "state") == "paid")
        .map(|o| s(&o, "count"));
    assert_eq!(paid_count.as_deref(), Some("1"));
    assert_ne!(s(p, "lastPaidAt"), "null");
}

#[test]
fn the_test_ramp_partners_record_answers_on_loopback_only_and_matches_the_desk() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (status, body) = send(&door, "GET", "/test-ramp-partner/venue", "", &[]);
    assert_eq!(status, 200, "{body}");
    let venue = json::parse(&body).unwrap();
    assert_eq!(s(venue.get("venue").unwrap(), "id"), "test-ramp-partner");
    let off = door.handle_from(
        &Request {
            method: "GET",
            url: "/test-ramp-partner/venue",
            headers: &[],
            body: "",
        },
        "req-off-loopback",
        "10.0.0.7",
    );
    assert_eq!(off.status, 403);
    let headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    let report = obj(&[(
        "account",
        obj(&[
            ("venueId", Json::str("test-ramp-partner")),
            ("owner", Json::str(ADA)),
        ]),
    )])
    .compact();
    let (status, body) = send(
        &door,
        "POST",
        "/test-ramp-partner/report",
        &report,
        &headers,
    );
    assert_eq!(status, 200, "{body}");
    let desk = call(
        &door,
        OPERATOR,
        &["admin:read"],
        "ops.rampMetrics",
        &obj(&[]),
    )
    .ok();
    let mut value = json::parse(&body).unwrap().get("value").cloned().unwrap();
    let mut seen = desk.get("partner").cloned().unwrap();
    // Each read stamps its own `asOf`.
    for j in [&mut value, &mut seen] {
        if let Json::Object(f) = j {
            f.retain(|(k, _)| k != "asOf");
        }
    }
    assert_eq!(value, seen);
    // With no pay-in partner the record doors are not mounted.
    let (status, _) = send(
        &b.door(Opts::default()),
        "GET",
        "/test-ramp-partner/venue",
        "",
        &[],
    );
    assert_eq!(status, 404);
}

#[test]
fn the_test_page_shows_the_payment_labelled_test_and_refuses_a_bad_id() {
    let Some(b) = bank() else { return };
    let door = b.door(stack());
    let (_q, request) = opened(&door, ADA);
    let id = s(&request, "requestId");
    let (status, page) = send(&door, "GET", &format!("/test/payin-sim/pay/{id}"), "", &[]);
    assert_eq!(status, 200);
    assert!(
        page.contains("<p data-testid=\"payin-sim-label\">TEST pay-in stand-in</p>"),
        "{page}"
    );
    assert!(
        page.contains("Pay 25.691356 EUR to add 12.345678 USDT"),
        "{page}"
    );
    assert!(
        page.contains(&format!("action=\"/test/payin-sim/pay/{id}/approve\"")),
        "{page}"
    );
    let (status, body) = send(&door, "GET", "/test/payin-sim/pay/not-a-uuid", "", &[]);
    assert_eq!(
        (status, body.contains("bank.validation_failed")),
        (400, true)
    );
}

#[test]
fn refuses_fiat_before_a_row_is_written_when_no_live_pay_adapter_is_injected() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto());
    assert_eq!(
        credit(&b, &door, "USDT", "10", "fiat", "fiat-no-pay").cause(),
        "bank.fiat_ramp_socket"
    );
    assert_eq!(onramp_rows(&b), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn sandbox_pay_rails_still_refuse_fiat_no_psp_laundering_into_bank() {
    let Some(b) = bank() else { return };
    let door = b.door(crypto()).with_ramps(RampsWiring {
        settings: RampSettings::default(),
        book: svc_bank::ramps::book::Wiring::none(),
        onramp: OnrampWiring {
            programme: rails::CRYPTO_LEDGER,
            pay_fiat: Box::new(rails::FixedPayFiat(rails::in_repo_rails())),
            ..OnrampWiring::none()
        },
    });
    assert_eq!(
        credit(&b, &door, "USDT", "10", "fiat", "fiat-sandbox").cause(),
        "bank.fiat_ramp_socket"
    );
    assert_eq!(onramp_rows(&b), 0);
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn refuses_the_same_fiat_rail_ref_again_when_the_live_rail_id_would_have_changed() {
    let Some(b) = bank() else { return };
    for rails_now in [
        vec!["pay-fiat-first"],
        vec!["pay-fiat-second", "pay-fiat-first"],
    ] {
        let door = b.door(crypto()).with_ramps(RampsWiring {
            settings: RampSettings::default(),
            book: svc_bank::ramps::book::Wiring::none(),
            onramp: OnrampWiring {
                programme: rails::CRYPTO_LEDGER,
                pay_fiat: Box::new(rails::FixedPayFiat(
                    rails_now
                        .iter()
                        .map(|r| rails::RailSnapshot::new(r, "live", &["onramp"]))
                        .collect(),
                )),
                ..OnrampWiring::none()
            },
        });
        assert_eq!(
            credit(&b, &door, "USDT", "25", "fiat", "ach-same-ref-rail-moves").cause(),
            "bank.fiat_ramp_socket"
        );
    }
    assert_eq!(
        b.count(
            "SELECT count(*) FROM bank.ramp_onramps WHERE rail_ref = 'ach-same-ref-rail-moves'"
        ),
        0
    );
    assert!(b.ledger.journal().is_empty());
}

#[test]
fn holds_not_reported_read_not_reported_never_nothing_held_and_what_can_be_withdrawn_is_not_known()
{
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    fund(&door, "fund-ada-10", "10");
    {
        let p = door.partner().partner.as_ref().unwrap();
        let mut st = p.lock();
        let mut sw = st.board.get(ADA);
        sw.purchase_holds = "not_reported".to_owned();
        st.board.set(ADA, sw);
    }
    let holds = call(&door, ADA, CUSTOMER, "partnerHolds", &Json::Null).ok();
    matches(
        &holds,
        &obj(&[
            ("held", Json::Bool(true)),
            ("reported", Json::Bool(false)),
            ("asOf", Json::Null),
            ("holds", Json::Array(vec![])),
            ("released", Json::Array(vec![])),
        ]),
    );
    let Some(Json::Array(balances)) = holds.get("balances") else {
        panic!("no balances: {}", holds.compact())
    };
    assert_eq!(balances.len(), 1, "{}", holds.compact());
    matches(
        &balances[0],
        &obj(&[
            ("assetId", Json::str("USDT")),
            ("balance", Json::str("10")),
            ("heldBack", Json::Null),
            ("withdrawable", Json::Null),
        ]),
    );
}

#[test]
fn a_person_the_partner_holds_no_money_for_has_no_partner_holds() {
    let Some(b) = bank() else { return };
    let door = at_partner(&b);
    assert_eq!(
        call(&door, BOB, CUSTOMER, "partnerHolds", &Json::Null).ok(),
        obj(&[("held", Json::Bool(false))])
    );
    assert_eq!(
        call(&door, ADA, CUSTOMER, "partnerHolds", &Json::Null)
            .ok()
            .get("held"),
        Some(&Json::Bool(true))
    );
}
