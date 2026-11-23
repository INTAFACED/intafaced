//! Part `auto_invest` of slice `automations` against the Rust door on a real Postgres. Ports the checks of the
//! TypeScript's auto-invest suites that fall on the part's calls, each test named after the TypeScript test's words:
//! `auto-invest/auto-invest.test.ts` (its database suite; `spareChange`'s three are unit tests in
//! `src/automations/auto_invest/service.rs`), `roundup-retry.test.ts`, the round-up halves of
//! `roundup-into-space.db.test.ts`, the database half of `auto-invest.reachable.test.ts`, `trade-convert-port.test.ts`,
//! the shared-secret case of `trade-convert-port-keys.test.ts`, and the auto-invest half of `ops/asset-pause.db.test.ts`
//! that the ops-desk port left to this slice. A TypeScript call through the router is a door call here; a call on
//! `AutoInvestService` is the Rust function it became, given the dependencies the door gives it
//! (`BankDoor::automations_deps`).
//!
//! The card capture is slice `card-ops`', not ported yet: where the TypeScript captures through `bank.cards.capture`,
//! the test books the capture's own spend on the stand-in ledger and calls `apply_round_up` as the capture calls it.
//!
//! Not ported, with the reason: the source pins (`auto-invest (source)`, `auto-invest.reachable (source)`, the three
//! `index.ts boot-wires` cases, `mount-vs-tracker.test.ts`) read TypeScript files; `auto-invest-policy.test.ts` is
//! held by the wire replay's `autoInvest.policy` answers; `roundup-enum-down.db.test.ts` runs migrations down and
//! touches no code of the part (the migrations are the crate's own, run by `store_pg`); the standing-order and
//! statement checks of `roundup-into-space.db.test.ts` are slices `transfers`' and `activity`'s; the dual and keypair
//! cases of `trade-convert-port-keys.test.ts` sign with `CallSigner`, the kit's one signer every outbound call of the
//! crate uses, held by the kit's own tests.
//!
//! The ledger is a stand-in that books `earnDeposit` and `bankTransfer` as svc-ledger does (one key once, no account
//! below zero, `ledger.insufficient_funds` otherwise), and can be unreachable or answer a post with another movement.
//! The convert counterparty is a stand-in that moves the person's own balances, or svc-trade's HTTP answers through a
//! fake fetch. Without `TEST_DATABASE_URL` each database test skips; with `REQUIRE_POSTGRES=1` it fails.
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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use service_kit::approvals::random_uuid;
use service_kit::edge;
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{self, CallSigner, system_seconds};
use service_kit::s2s_verify::{self, BodyBind, Incoming};
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::automations::auto_invest::convert::{
    ConvertAsk, ConvertError, ConvertPort, Converted, TradeConvert,
};
use svc_bank::automations::auto_invest::service::{
    self as ai, Capture, DcaAsk, Report, RoundUpAsk, RoundUpOutcome, Rule,
};
use svc_bank::automations::auto_invest::{self, Wiring as AutoInvestWiring};
use svc_bank::automations::{Deps, Wiring as AutomationsWiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::earn::{self, service as earn_service};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, TestPartner};
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure, TxEntry,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::{self, Rules};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::Wiring as TransfersWiring;

use support::TestDb;

const SECRET: &str = "a-bank-auto-invest-db-edge-secret-long-ok";
const INTERNAL: &str = "a-bank-auto-invest-db-internal-secret-long";
const USER_A: &str = "11111111-1111-4111-8111-111111111111";
const USER_B: &str = "22222222-2222-4222-8222-222222222222";
const RW: &[&str] = &["bank:read", "bank:write"];

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn uuid() -> String {
    random_uuid().unwrap()
}

fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

fn now() -> Instant {
    door::system_now()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book, the convert counterparty, svc-trade over HTTP, the directory, the freeze.

/// (owner type, owner, asset, kind, purpose).
type Acct = (String, String, String, String, String);

fn acct(a: &LedgerAccount) -> Acct {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
        a.purpose.clone().unwrap_or_default(),
    )
}

fn acct_of(j: &Json) -> Acct {
    let f = |k: &str| match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    };
    (
        f("ownerType"),
        f("ownerId"),
        f("assetId"),
        f("kind"),
        f("purpose"),
    )
}

fn main_of(user: &str, asset: &str) -> Acct {
    acct(&LedgerAccount::user_available(user, asset))
}

fn acct_id(a: &Acct) -> String {
    format!("acct:{}:{}:{}:{}:{}", a.0, a.1, a.2, a.3, a.4)
}

fn field(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

/// How the book answers the next posts.
#[derive(Clone, Default)]
enum Mode {
    #[default]
    Books,
    /// Every post fails before it reaches the book (`socket hang up`).
    Down,
    /// Every post answers with this transaction, booking nothing (a ledger in detect mode answering a reused key).
    Answers(LedgerTx),
}

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    /// (key, recipe, tx), in posting order.
    journal: Vec<(String, String, LedgerTx)>,
    mode: Mode,
    funded: Amount,
}

#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

impl Book {
    /// `recipes.deposit`: a TEST balance on the person's main account, from outside the book.
    fn fund(&self, user: &str, asset: &str, amount: &str) {
        let mut st = self.0.lock().unwrap();
        *st.balances.entry(main_of(user, asset)).or_default() += amt(amount);
        st.funded += amt(amount);
    }
    /// Money leaving the person's main account to outside the book: a card capture's own spend.
    fn spend(&self, user: &str, asset: &str, amount: &str) {
        let mut st = self.0.lock().unwrap();
        *st.balances.entry(main_of(user, asset)).or_default() -= amt(amount);
        st.funded -= amt(amount);
    }
    fn of(&self, a: &Acct) -> Amount {
        self.0
            .lock()
            .unwrap()
            .balances
            .get(a)
            .copied()
            .unwrap_or(Amount::ZERO)
    }
    fn main(&self, user: &str, asset: &str) -> String {
        format_amount(self.of(&main_of(user, asset)))
    }
    fn space(&self, space: &str) -> String {
        format_amount(self.of(&acct(&LedgerAccount::sub_account_available(space, "USDT"))))
    }
    fn len(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
    fn mode(&self, m: Mode) {
        self.0.lock().unwrap().mode = m;
    }
    /// `ledger.reconcile()`: nothing was made or lost, and no account is below zero.
    fn reconciles(&self) {
        let st = self.0.lock().unwrap();
        assert_eq!(st.balances.values().sum::<Amount>(), st.funded);
        assert!(st.balances.values().all(|v| *v >= Amount::ZERO));
    }
}

fn legs(recipe: &str, input: &Json) -> (Acct, Acct, Amount, String) {
    let a = amt(&field(input, "amount"));
    match recipe {
        "earnDeposit" => {
            let (pos, user, asset) = (
                field(input, "positionId"),
                field(input, "userId"),
                field(input, "assetId"),
            );
            (
                main_of(&user, &asset),
                acct(&LedgerAccount::earn_stake(&user, &asset, &pos)),
                a,
                format!("bank.earn.deposit:{pos}"),
            )
        }
        "bankTransfer" => {
            let key = format!(
                "bank.transfer.{}:{}:{}",
                field(input, "keySpace"),
                field(input, "transferId"),
                input.get("occurrence").unwrap().compact()
            );
            (
                acct_of(input.get("from").unwrap()),
                acct_of(input.get("to").unwrap()),
                a,
                key,
            )
        }
        other => panic!("the bank posts no {other} in part auto_invest"),
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self.of(&acct(a)))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .balances
            .iter()
            .filter(|(k, _)| k.0 == owner_type && k.1 == owner)
            .map(|(k, v)| LedgerBalance {
                asset_id: k.2.clone(),
                kind: k.3.clone(),
                purpose: k.4.clone(),
                amount: *v,
            })
            .collect())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("no registry".to_owned())
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        Ok(acct_id(&acct(a)))
    }
    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(_, _, t)| t.id == tx_id)
            .map(|(_, _, t)| t.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(k, _, _)| k == key)
            .map(|(_, _, t)| t.clone()))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let mut st = self.0.lock().unwrap();
        match st.mode.clone() {
            Mode::Books => {}
            Mode::Down => return Err(PostFailure::Unknown("socket hang up".to_owned())),
            Mode::Answers(tx) => return Ok(tx),
        }
        let (from, to, a, want) = legs(recipe, input);
        assert_eq!(key, want, "the recipe's own key");
        if let Some((_, _, t)) = st.journal.iter().find(|(k, _, _)| k == key) {
            return Ok(t.clone());
        }
        if st.balances.get(&from).copied().unwrap_or(Amount::ZERO) < a {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!("Insufficient {}", from.2),
                attempts: 2,
            });
        }
        *st.balances.entry(from.clone()).or_default() -= a;
        *st.balances.entry(to.clone()).or_default() += a;
        let tx = LedgerTx {
            key: key.to_owned(),
            id: format!("tx-{}", st.journal.len() + 1),
            posted_at: now(),
            entries: vec![
                TxEntry {
                    account_id: acct_id(&from),
                    asset_id: from.2.clone(),
                    direction: "credit".to_owned(),
                    amount: a,
                },
                TxEntry {
                    account_id: acct_id(&to),
                    asset_id: to.2.clone(),
                    direction: "debit".to_owned(),
                    amount: a,
                },
            ],
        };
        st.journal
            .push((key.to_owned(), recipe.to_owned(), tx.clone()));
        Ok(tx)
    }
}

/// How the convert stand-in answers.
#[derive(Clone, Copy)]
enum Fill {
    /// Spend the rule amount, receive this (none: one for one).
    Receive(Option<Amount>),
    /// `InsufficientFundsError`: the ledger's own definite refusal.
    Insufficient,
    /// `new Error('socket hang up')`: the reply was lost, the convert may have filled.
    Lost,
    /// `BankError('trade.convert_no_liquidity', 'bank.auto_invest_rate_unset')`.
    NoRate,
}

/// The test double the TypeScript injects: it moves the person's own balances on the book.
struct Convert {
    book: Book,
    fill: Fill,
    calls: Arc<AtomicUsize>,
}

impl ConvertPort for Convert {
    fn convert(&self, ask: &ConvertAsk<'_>) -> Result<Converted, ConvertError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let received = match self.fill {
            Fill::Receive(r) => r.unwrap_or(ask.from_amount),
            Fill::Insufficient => {
                return Err(ConvertError::Ledger("ledger.insufficient_funds".to_owned()));
            }
            Fill::Lost => return Err(ConvertError::Unknown("socket hang up".to_owned())),
            Fill::NoRate => {
                return Err(ConvertError::Refused(svc_bank::partner::refuse(
                    "bank.auto_invest_rate_unset",
                    "trade.convert_no_liquidity",
                )));
            }
        };
        let mut st = self.book.0.lock().unwrap();
        *st.balances
            .entry(main_of(ask.user_id, ask.from_asset))
            .or_default() -= ask.from_amount;
        *st.balances
            .entry(main_of(ask.user_id, ask.to_asset))
            .or_default() += received;
        st.funded += received - ask.from_amount;
        Ok(Converted {
            to_amount: received,
            ledger_tx_id: format!("tx:{}", ask.client_convert_id),
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
// The door and its wiring

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    calls: Arc<AtomicUsize>,
}

fn door_for(db: &TestDb, b: &Book, w: AutoInvestWiring) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
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
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        // The TypeScript suites post straight to the memory ledger: the custodial layer stands on here.
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(b.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("5".to_owned()),
            unlock_wait_hours: Some("24".to_owned()),
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
    .with_transfers(TransfersWiring::none())
    .with_earn(earn::Settings {
        native_asset_id: "IFC".to_owned(),
        risk_wording: None,
        interest_accrual: true,
    })
    .with_automations(AutomationsWiring {
        auto_invest: w,
        ..AutomationsWiring::none()
    })
}

/// `createBankServices(...)` with `autoInvest: { enabled, convert }`.
fn wiring(enabled: bool, convert: Option<Box<dyn ConvertPort>>) -> AutoInvestWiring {
    AutoInvestWiring {
        enabled,
        convert,
        batch_size: None,
    }
}

fn bank() -> Option<Bank> {
    bank_with(|_, _| wiring(true, None))
}

fn bank_with(w: impl FnOnce(&Book, &Arc<AtomicUsize>) -> AutoInvestWiring) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let door = door_for(&db, &ledger, w(&ledger, &calls));
    Some(Bank {
        door,
        db,
        ledger,
        calls,
    })
}

fn converting(fill: Fill) -> Option<Bank> {
    bank_with(|book, calls| {
        wiring(
            true,
            Some(Box::new(Convert {
                book: book.clone(),
                fill,
                calls: calls.clone(),
            })),
        )
    })
}

impl Bank {
    /// The same database and book under other wiring.
    fn rewire(&mut self, w: AutoInvestWiring) {
        self.door = door_for(&self.db, &self.ledger, w);
    }
    fn svc<T>(&self, at_: Option<Instant>, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        self.door.automations_deps(at_.unwrap_or_else(now), f)
    }
    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }
    fn rows(&self, q: &str) -> Vec<Vec<Option<String>>> {
        self.db
            .client()
            .query(q, &[])
            .unwrap()
            .iter()
            .map(|r| {
                (0..r.len())
                    .map(|i| r.get::<_, Option<String>>(i))
                    .collect()
            })
            .collect()
    }
    /// `bank.earn.createPool` in USDT unless named.
    fn pool(&self, asset: &str, min: &str) -> String {
        let id = uuid();
        self.door
            .earn_deps(now(), |d| {
                earn_service::create_pool(
                    d,
                    &earn_service::NewPool {
                        id: id.clone(),
                        asset_id: asset.to_owned(),
                        kind: "flexible".to_owned(),
                        name: format!("TEST {id}"),
                        apr_bps: 100,
                        term_days: None,
                        min_deposit: amt(min),
                        unbonding_days: None,
                    },
                )
            })
            .unwrap()
            .id
    }
    fn staked(&self, user: &str) -> String {
        format_amount(
            self.door
                .earn_deps(now(), |d| earn_service::staked_of(d, user, "USDT"))
                .unwrap(),
        )
    }
    fn sweep(&self, user: &str, threshold: &str, pool: &str) -> Result<Rule, Refusal> {
        self.svc(None, |d| {
            ai::create_threshold_sweep(d, user, "USDT", amt(threshold), pool)
        })
    }
    fn dca(&self, user: &str, starts: &str) -> Result<Rule, Refusal> {
        self.svc(None, |d| {
            ai::create_dca(
                d,
                &DcaAsk {
                    user_id: user,
                    spend_asset_id: "USDT",
                    buy_asset_id: "BTC",
                    amount: amt("100"),
                    cadence: "daily",
                    starts_at: at(starts),
                },
            )
        })
    }
    fn round_up(
        &self,
        user: &str,
        granularity: &str,
        pool: Option<&str>,
        space: Option<&str>,
    ) -> Result<Rule, Refusal> {
        self.svc(None, |d| {
            ai::create_round_up(
                d,
                &RoundUpAsk {
                    user_id: user,
                    asset_id: "USDT",
                    granularity: amt(granularity),
                    target_pool_id: pool,
                    target_space_id: space,
                    buy_asset_id: None,
                },
            )
        })
    }
    fn run(&self, at_: &str, limit: f64) -> Report {
        let when = at(at_);
        self.svc(Some(when), |d| ai::run_due(d, when, Some(limit)))
            .unwrap()
    }
    /// `applyRoundUp` as the card capture calls it.
    fn capture(
        &self,
        user: &str,
        auth: &str,
        captured: &str,
        partner_held: bool,
    ) -> RoundUpOutcome {
        self.svc(None, |d| {
            ai::apply_round_up(
                d,
                &Capture {
                    user_id: user,
                    asset_id: "USDT",
                    authorization_id: auth,
                    captured: amt(captured),
                    partner_held,
                },
            )
        })
        .unwrap()
    }
    /// A card capture of `captured` on the ledger, then its round-up (`bank.cards.capture` with the hook).
    fn card_capture(&self, user: &str, captured: &str) -> RoundUpOutcome {
        self.ledger.spend(user, "USDT", captured);
        self.capture(user, &uuid(), captured, false)
    }
    fn runs(&self, rule: &str) -> Vec<ai::Run> {
        self.svc(None, |d| ai::runs_of(d, rule)).unwrap()
    }
    fn pause(&self, rule: &str) -> Rule {
        self.svc(None, |d| ai::pause(d, rule)).unwrap()
    }
    /// One of the person's named spaces (`bank.spaces.create`).
    fn space(&self, user: &str, name: &str, asset: &str) -> String {
        let id = uuid();
        self.db
            .client()
            .execute(
                "INSERT INTO bank.spaces (id, user_id, asset_id, kind, name) VALUES ($1::text::uuid, $2, $3, 'named', $4)",
                &[&id, &user, &asset, &name],
            )
            .unwrap();
        id
    }
    fn primary(&self, user: &str) -> String {
        space::with(&self.db.store(), |c| space::ensure_primary(c, user, "USDT"))
            .unwrap()
            .id
    }
    fn archive(&self, id: &str) {
        space::archive(&self.db.store(), id).unwrap();
    }
    fn unarchive(&self, id: &str) {
        self.sql(&format!(
            "UPDATE bank.spaces SET archived_at = NULL WHERE id = '{id}'"
        ));
    }
    fn partner(&self) -> &TestPartner {
        self.door.partner().partner.as_ref().unwrap()
    }
    fn at_partner(&self, user: &str, space: Option<&str>) -> String {
        let account = AccountRef {
            user_id: user.to_owned(),
            asset_id: "USDT".to_owned(),
            space_id: space.map(str::to_owned),
        };
        self.partner()
            .lock()
            .report(&account, now())
            .amount
            .map_or("none".to_owned(), format_amount)
    }
}

/// The refusal's code, or its message when it names none.
fn code(r: &Refusal) -> String {
    earn::code_of(r).map_or_else(|| earn::message_of(r), str::to_owned)
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
            _ => "ok".to_owned(),
        }
    }
    fn cause(&self) -> String {
        match self.data("cause").and_then(|c| c.get("code").cloned()) {
            Some(Json::String(c)) => c,
            _ => panic!("no cause: {} {}", self.0, self.1.compact()),
        }
    }
}

fn send(door: &BankDoor, path: &str, input: &str, mut headers: Vec<(String, String)>) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) if input.is_empty() => ("GET", format!("/trpc/{path}"), String::new()),
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
            String::new(),
        ),
        Some(Kind::Mutation) => ("POST", format!("/trpc/{path}"), input.to_owned()),
        None => ("POST", path.to_owned(), input.to_owned()),
    };
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-auto-invest-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    send(&b.door, path, input, person(user, RW))
}

/// The bank's own scheduler: an ops job or a job door, signed as svc-bank.
fn job(b: &Bank, path: &str, input: &str) -> Answer {
    let headers = s2s::legacy_headers("svc-bank", INTERNAL, input, system_seconds()).unwrap();
    send(&b.door, path, input, headers)
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn statuses(runs: &[ai::Run]) -> Vec<&str> {
    runs.iter().map(|r| r.status.as_str()).collect()
}

fn reason(o: &RoundUpOutcome) -> &str {
    o.reason().unwrap_or("none")
}

// ===============================================================================================================
// auto-invest.test.ts: threshold sweep — same-asset excess to earn (no rate invent)

#[test]
fn moves_only_the_excess_above_threshold_into_the_earn_pool_via_ledger() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "1");
    b.ledger.fund(USER_A, "USDT", "1000");
    let rule = b.sweep(USER_A, "400", &pool).unwrap();
    assert_eq!(
        (rule.kind.as_str(), rule.status.as_str()),
        ("threshold_sweep", "active")
    );
    let report = b.run("2026-08-09T12:00:00Z", 200.0);
    assert_eq!(report.settled, 1);
    assert!(report.failures.is_empty());
    // Keep 400 in the main balance; 600 staked.
    assert_eq!(b.ledger.main(USER_A, "USDT"), "400");
    assert_eq!(b.staked(USER_A), "600");
    b.ledger.reconciles();
}

#[test]
fn skips_when_balance_is_at_or_below_threshold_moves_nothing() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0");
    b.ledger.fund(USER_A, "USDT", "50");
    b.sweep(USER_A, "100", &pool).unwrap();
    let report = b.run("2026-08-09T12:00:00Z", 200.0);
    assert_eq!((report.skipped, report.settled), (1, 0));
    assert_eq!(b.ledger.main(USER_A, "USDT"), "50");
}

#[test]
fn a_below_threshold_skip_occupying_the_sweep_key_is_not_a_later_settlement() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "1");
    b.ledger.fund(USER_A, "USDT", "50");
    let rule = b.sweep(USER_A, "100", &pool).unwrap();
    let when = "2026-08-09T12:00:00.000Z";
    let first = b.run(when, 200.0);
    assert_eq!((first.skipped, first.settled), (1, 0));
    // Same timestamp, now above threshold. The skip already holds sweep:<rule>:<now>.
    b.ledger.fund(USER_A, "USDT", "950");
    let second = b.run(when, 200.0);
    assert_eq!((second.settled, second.skipped, second.rejected), (0, 1, 0));
    assert_eq!(b.ledger.main(USER_A, "USDT"), "1000");
    assert_eq!(b.staked(USER_A), "0");
    let runs = b.runs(&rule.id);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "skipped");
    assert_eq!(runs[0].client_run_id, format!("sweep:{}:{when}", rule.id));
    assert_eq!((runs[0].position_id.clone(), runs[0].amount), (None, None));
    b.ledger.reconciles();
}

#[test]
fn a_pending_sweep_row_is_not_reported_as_settled_and_the_excess_stays_available() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "1");
    b.ledger.fund(USER_A, "USDT", "1000");
    let rule = b.sweep(USER_A, "400", &pool).unwrap();
    let when = "2026-08-09T17:00:00.000Z";
    let client = format!("sweep:{}:{when}", rule.id);
    b.sql(&format!(
        "INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount) VALUES ('{}', '{client}', 'pending', 1)",
        rule.id
    ));
    let report = b.run(when, 200.0);
    assert_eq!(
        (
            report.considered,
            report.settled,
            report.skipped,
            report.rejected
        ),
        (1, 0, 0, 0)
    );
    assert!(report.failures.is_empty());
    assert_eq!(b.ledger.main(USER_A, "USDT"), "1000");
    assert_eq!(b.staked(USER_A), "0");
    let runs = b.runs(&rule.id);
    assert_eq!(statuses(&runs), ["pending"]);
    assert_eq!(runs[0].client_run_id, client);
    assert_eq!(runs[0].amount, Some(amt("1")));
    assert_eq!(runs[0].position_id, None);
    b.ledger.reconciles();
}

#[test]
fn a_rejected_sweep_row_is_not_reported_as_settled_and_the_excess_stays_available() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "80");
    b.ledger.fund(USER_A, "USDT", "100");
    let rule = b.sweep(USER_A, "50", &pool).unwrap();
    let when = "2026-08-09T15:00:00.000Z";
    let first = b.run(when, 200.0);
    assert_eq!((first.rejected, first.settled), (1, 0));
    assert_eq!(b.ledger.main(USER_A, "USDT"), "100");
    let second = b.run(when, 200.0);
    assert_eq!((second.settled, second.rejected), (0, 1));
    assert_eq!(b.ledger.main(USER_A, "USDT"), "100");
    assert_eq!(b.staked(USER_A), "0");
    let runs = b.runs(&rule.id);
    assert_eq!(statuses(&runs), ["rejected"]);
    assert_eq!(runs[0].amount, Some(amt("50")));
    assert_eq!(
        runs[0].rejection_code.as_deref(),
        Some("bank.below_minimum")
    );
    b.ledger.reconciles();
}

#[test]
fn a_settled_sweep_is_not_deposited_a_second_time() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "1");
    b.ledger.fund(USER_A, "USDT", "1000");
    let rule = b.sweep(USER_A, "400", &pool).unwrap();
    let when = "2026-08-09T16:00:00.000Z";
    assert_eq!(b.run(when, 200.0).settled, 1);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "400");
    assert_eq!(b.staked(USER_A), "600");
    // Still above threshold at the same timestamp: the settled row already moved 600; the new 200 stays put.
    b.ledger.fund(USER_A, "USDT", "200");
    let second = b.run(when, 200.0);
    assert_eq!((second.settled, second.skipped, second.rejected), (1, 0, 0));
    assert_eq!(b.ledger.main(USER_A, "USDT"), "600");
    assert_eq!(b.staked(USER_A), "600");
    let runs = b.runs(&rule.id);
    assert_eq!(statuses(&runs), ["settled"]);
    assert_eq!(runs[0].amount, Some(amt("600")));
    b.ledger.reconciles();
}

#[test]
fn refuses_a_pool_in_a_different_asset_rather_than_inventing_a_convert() {
    let Some(b) = bank() else { return };
    let pool = b.pool("BTC", "0");
    assert_eq!(
        code(&b.sweep(USER_A, "10", &pool).unwrap_err()),
        "bank.asset_mismatch"
    );
}

#[test]
fn refuses_a_non_positive_threshold() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0");
    assert_eq!(
        code(&b.sweep(USER_A, "0", &pool).unwrap_err()),
        "bank.auto_invest_invalid_threshold"
    );
}

// ===============================================================================================================
// auto-invest.test.ts: DCA — refuse rates unset (no invent §8)

#[test]
fn refuses_create_dca_when_no_convert_port_is_configured() {
    let Some(b) = bank() else { return };
    assert_eq!(
        code(&b.dca(USER_A, "2026-08-09T00:00:00Z").unwrap_err()),
        "bank.auto_invest_rate_unset"
    );
    assert!(
        b.rows("SELECT id::text FROM bank.auto_invest_rules")
            .is_empty()
    );
}

#[test]
fn creates_and_fires_dca_when_a_convert_port_is_injected_no_rate_invent_in_bank() {
    let Some(b) = converting(Fill::Receive(None)) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let rule = b.dca(USER_A, "2026-08-01T00:00:00Z").unwrap();
    assert_eq!(rule.kind, "dca");
    assert_eq!(b.run("2026-08-09T00:00:00Z", 200.0).settled, 1);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "400");
    assert_eq!(b.ledger.main(USER_A, "BTC"), "100");
}

#[test]
fn a_pending_dca_row_is_not_reported_as_settled_and_the_spend_stays_available() {
    let Some(b) = converting(Fill::Receive(Some(amt("0.002")))) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let starts = "2026-08-09T08:00:00.000Z";
    let rule = b.dca(USER_A, starts).unwrap();
    let client = format!("dca:{}:{}", rule.id, rule.next_run_at.unwrap().iso());
    b.sql(&format!(
        "INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount) VALUES ('{}', '{client}', 'pending', 100)",
        rule.id
    ));
    let report = b.run(starts, 200.0);
    assert_eq!(
        (
            report.considered,
            report.settled,
            report.skipped,
            report.rejected
        ),
        (1, 0, 0, 0)
    );
    assert!(report.failures.is_empty());
    assert_eq!(b.calls.load(Ordering::SeqCst), 0);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "500");
    assert_eq!(b.ledger.main(USER_A, "BTC"), "0");
    let runs = b.runs(&rule.id);
    assert_eq!(statuses(&runs), ["pending"]);
    assert_eq!(
        (runs[0].client_run_id.as_str(), runs[0].amount),
        (client.as_str(), Some(amt("100")))
    );
    b.ledger.reconciles();
}

#[test]
fn a_rule_stuck_pending_does_not_starve_a_due_rule_created_after_it() {
    let Some(b) = converting(Fill::Receive(Some(amt("0.002")))) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    b.ledger.fund(USER_B, "USDT", "500");
    let starts = "2026-08-09T11:00:00.000Z";
    let stuck = b.dca(USER_A, starts).unwrap();
    b.sql(&format!(
        "INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount) VALUES ('{0}', 'dca:{0}:{1}', 'pending', 100)",
        stuck.id,
        stuck.next_run_at.unwrap().iso()
    ));
    let fresh = b.dca(USER_B, starts).unwrap();
    // A batch of one: the stuck rule is older, so it used to take the only slot on every run.
    let report = b.run(starts, 1.0);
    assert_eq!(report.settled, 1);
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
    assert_eq!(statuses(&b.runs(&fresh.id)), ["settled"]);
    assert_eq!(statuses(&b.runs(&stuck.id)), ["pending"]);
    b.ledger.reconciles();
}

#[test]
fn a_rejected_dca_row_is_not_reported_as_settled_and_convert_is_not_run_again() {
    let Some(b) = converting(Fill::Insufficient) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let when = "2026-08-09T09:00:00.000Z";
    let rule = b.dca(USER_A, when).unwrap();
    let first = b.run(when, 200.0);
    assert_eq!((first.rejected, first.settled), (1, 0));
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
    let second = b.run(when, 200.0);
    assert_eq!((second.settled, second.rejected, second.skipped), (0, 1, 0));
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "500");
    assert_eq!(b.ledger.main(USER_A, "BTC"), "0");
    let runs = b.runs(&rule.id);
    assert_eq!(statuses(&runs), ["rejected"]);
    assert_eq!(runs[0].amount, Some(amt("100")));
    assert_eq!(
        runs[0].rejection_code.as_deref(),
        Some("ledger.insufficient_funds")
    );
    b.ledger.reconciles();
}

#[test]
fn an_unknown_convert_outcome_leaves_the_dca_row_pending_never_rejected() {
    let Some(b) = converting(Fill::Lost) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let when = "2026-08-09T09:30:00.000Z";
    let rule = b.dca(USER_A, when).unwrap();
    let first = b.run(when, 200.0);
    assert_eq!((first.rejected, first.settled), (0, 0));
    assert_eq!(
        first.failures,
        vec![(rule.id.clone(), "bank.auto_invest_run_failed".to_owned())]
    );
    assert_eq!(statuses(&b.runs(&rule.id)), ["pending"]);
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn books_the_converted_amount_and_does_not_convert_a_settled_dca_row_again() {
    let Some(b) = converting(Fill::Receive(Some(amt("0.002")))) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let starts = "2026-08-09T10:00:00.000Z";
    let rule = b.dca(USER_A, starts).unwrap();
    assert_eq!(b.run(starts, 200.0).settled, 1);
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "400");
    assert_eq!(b.ledger.main(USER_A, "BTC"), "0.002");
    let booked = b.runs(&rule.id);
    assert_eq!(statuses(&booked), ["settled"]);
    assert_eq!(booked[0].amount, Some(amt("0.002")));
    // The schedule moved a day on; rewound, the settled row occupies dca:<rule>:<nextRunAt>.
    assert_eq!(
        b.svc(None, |d| ai::get(d, &rule.id))
            .unwrap()
            .next_run_at
            .unwrap()
            .iso(),
        "2026-08-10T10:00:00.000Z"
    );
    b.sql(&format!(
        "UPDATE bank.auto_invest_rules SET next_run_at = '{starts}' WHERE id = '{}'",
        rule.id
    ));
    let second = b.run(starts, 200.0);
    assert_eq!((second.settled, second.rejected, second.skipped), (1, 0, 0));
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "400");
    assert_eq!(b.ledger.main(USER_A, "BTC"), "0.002");
    let runs = b.runs(&rule.id);
    assert_eq!(statuses(&runs), ["settled"]);
    assert_eq!(runs[0].amount, Some(amt("0.002")));
    b.ledger.reconciles();
}

// ===============================================================================================================
// auto-invest.test.ts: cancel + pause + kill switch (through the door where the TypeScript uses the router)

#[test]
fn pause_stops_fires_resume_allows_them_again() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0");
    b.ledger.fund(USER_A, "USDT", "1000");
    let rule = b.sweep(USER_A, "100", &pool).unwrap();
    let paused = call(
        &b,
        USER_A,
        "autoInvest.pause",
        &format!(r#"{{"ruleId":"{}"}}"#, rule.id),
    )
    .ok();
    assert_eq!(s(&paused, "status"), "paused");
    assert_eq!(b.run("2026-08-09T12:00:00Z", 200.0).considered, 0);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "1000");
    let resumed = call(
        &b,
        USER_A,
        "autoInvest.resume",
        &format!(r#"{{"ruleId":"{}"}}"#, rule.id),
    )
    .ok();
    assert_eq!(s(&resumed, "status"), "active");
    assert_eq!(b.run("2026-08-09T12:00:00Z", 200.0).settled, 1);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "100");
    // Another person's rule is not theirs to hold, and a rule already active is not resumable.
    let other = call(
        &b,
        USER_B,
        "autoInvest.pause",
        &format!(r#"{{"ruleId":"{}"}}"#, rule.id),
    );
    assert_eq!(other.cause(), "bank.not_owner");
    let again = call(
        &b,
        USER_A,
        "autoInvest.resume",
        &format!(r#"{{"ruleId":"{}"}}"#, rule.id),
    );
    assert_eq!(again.cause(), "bank.auto_invest_inactive");
    let none = call(
        &b,
        USER_A,
        "autoInvest.pause",
        &format!(r#"{{"ruleId":"{}"}}"#, uuid()),
    );
    assert_eq!(none.cause(), "bank.auto_invest_not_found");
}

#[test]
fn cancel_stops_future_fires() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0");
    b.ledger.fund(USER_A, "USDT", "1000");
    let rule = b.sweep(USER_A, "100", &pool).unwrap();
    let done = call(
        &b,
        USER_A,
        "autoInvest.cancel",
        &format!(r#"{{"ruleId":"{}"}}"#, rule.id),
    )
    .ok();
    assert_eq!(done.compact(), r#"{"ok":true}"#);
    let report = b.svc(None, |d| ai::run_due(d, now(), Some(200.0))).unwrap();
    assert_eq!(report.considered, 0);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "1000");
    let twice = call(
        &b,
        USER_A,
        "autoInvest.cancel",
        &format!(r#"{{"ruleId":"{}"}}"#, rule.id),
    );
    assert_eq!(twice.cause(), "bank.auto_invest_inactive");
}

#[test]
fn ops_run_auto_invest_refuses_when_the_kill_switch_is_off() {
    let Some(mut b) = bank() else { return };
    b.rewire(wiring(false, None));
    let refused = job(&b, "ops.runAutoInvest", "{}");
    assert_eq!(refused.trpc(), "SERVICE_UNAVAILABLE");
    assert_eq!(refused.cause(), "bank.auto_invest_disabled");
    // The job door shares the switch and the code: neither is a way past the stop.
    let door = job(&b, "/internal/jobs/run-auto-invest", r#"{"limit":10}"#);
    assert_eq!(door.0, 503);
    assert_eq!(
        door.1.compact(),
        r#"{"error":"auto-invest is disabled","code":"bank.auto_invest_disabled"}"#
    );
}

#[test]
fn the_job_door_runs_one_pass_of_the_bodys_batch_and_refuses_a_blank_one() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0");
    b.ledger.fund(USER_A, "USDT", "1000");
    b.sweep(USER_A, "100", &pool).unwrap();
    let blank = job(&b, "/internal/jobs/run-auto-invest", "{}");
    assert_eq!(blank.0, 400);
    assert_eq!(s(&blank.1, "code"), "bank.auto_invest_batch_limit_unset");
    let unsigned = send(
        &b.door,
        "/internal/jobs/run-auto-invest",
        r#"{"limit":10}"#,
        vec![],
    );
    assert_eq!(unsigned.0, 401);
    let ran = job(&b, "/internal/jobs/run-auto-invest", r#"{"limit":10}"#);
    assert_eq!(ran.0, 200);
    assert_eq!(
        ran.1.compact(),
        r#"{"considered":1,"settled":1,"skipped":0,"rejected":0,"failures":[]}"#
    );
    assert_eq!(b.ledger.main(USER_A, "USDT"), "100");
    let ops = job(&b, "ops.runAutoInvest", r#"{"limit":10}"#).ok();
    assert_eq!(s(&ops, "considered"), "1");
}

// ===============================================================================================================
// auto-invest.test.ts: card round-up — spare change on capture (no yield invent)

#[test]
fn sweeps_0_70_after_a_4_30_capture_into_the_same_asset_earn_pool() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    b.ledger.fund(USER_A, "USDT", "1000");
    let rule = b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    assert_eq!(rule.kind, "card_roundup");
    let out = b.card_capture(USER_A, "4.30");
    assert_eq!(out.status(), "settled");
    assert_eq!(format_amount(out.amount()), "0.7");
    // 1000 - 4.30 spend - 0.70 sweep
    assert_eq!(b.ledger.main(USER_A, "USDT"), "995");
    assert_eq!(b.staked(USER_A), "0.7");
    b.ledger.reconciles();
}

#[test]
fn skips_when_the_capture_is_already_a_multiple_of_granularity_moves_nothing_extra() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    b.ledger.fund(USER_A, "USDT", "100");
    b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    let out = b.card_capture(USER_A, "5");
    assert_eq!(
        (out.status(), reason(&out)),
        ("skipped", "bank.auto_invest_no_spare")
    );
    assert_eq!(b.ledger.main(USER_A, "USDT"), "95");
    assert_eq!(b.staked(USER_A), "0");
}

#[test]
fn refuses_a_cross_asset_destination_rather_than_inventing_a_convert_rate() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    let refused = b
        .svc(None, |d| {
            ai::create_round_up(
                d,
                &RoundUpAsk {
                    user_id: USER_A,
                    asset_id: "USDT",
                    granularity: amt("1"),
                    target_pool_id: Some(&pool),
                    target_space_id: None,
                    buy_asset_id: Some("BTC"),
                },
            )
        })
        .unwrap_err();
    assert_eq!(code(&refused), "bank.auto_invest_rate_unset");
}

#[test]
fn refuses_a_second_live_round_up_on_the_same_asset() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    assert_eq!(
        code(&b.round_up(USER_A, "5", Some(&pool), None).unwrap_err()),
        "bank.auto_invest_roundup_exists"
    );
}

#[test]
fn auto_invest_kill_skips_the_hook_capture_still_stands_nothing_swept() {
    let Some(mut b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    b.ledger.fund(USER_A, "USDT", "1000");
    // Create is allowed while the runner and the hook are stopped.
    b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    b.rewire(wiring(false, None));
    let out = b.card_capture(USER_A, "4.30");
    assert_eq!(
        (out.status(), reason(&out)),
        ("skipped", "bank.auto_invest_disabled")
    );
    assert_eq!(b.ledger.main(USER_A, "USDT"), "995.7");
    assert_eq!(b.staked(USER_A), "0");
}

#[test]
fn pause_stops_the_hook_capture_still_stands() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    b.ledger.fund(USER_A, "USDT", "1000");
    let rule = b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    b.pause(&rule.id);
    let out = b.card_capture(USER_A, "4.30");
    assert_eq!(out, RoundUpOutcome::None);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "995.7");
}

#[test]
fn run_due_does_not_fire_card_roundup_rules() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    b.ledger.fund(USER_A, "USDT", "1000");
    b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    assert_eq!(b.run("2026-08-15T12:00:00Z", 200.0).considered, 0);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "1000");
}

#[test]
fn refuses_the_sweep_when_available_cannot_fund_it_capture_still_stands() {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0.01");
    b.ledger.fund(USER_A, "USDT", "4.30");
    b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    let out = b.card_capture(USER_A, "4.30");
    assert_eq!(
        (out.status(), reason(&out)),
        ("refused", "ledger.insufficient_funds")
    );
    assert_eq!(b.ledger.main(USER_A, "USDT"), "0");
}

// auto-invest.test.ts: doctrine — rules hold no balance

#[test]
fn auto_invest_tables_have_no_balance_shaped_columns_outside_the_allowlist_shape() {
    let Some(b) = bank() else { return };
    let cols = b.rows(
        "SELECT table_name::text, column_name::text FROM information_schema.columns WHERE table_schema = 'bank' \
         AND table_name LIKE 'auto_invest%' \
         AND column_name ~* '(balance|total|running|cached|available|held|accrued|outstanding)'",
    );
    assert!(cols.is_empty(), "{cols:?}");
}

// ===============================================================================================================
// roundup-retry.test.ts: applyRoundUp duplicate client run id

const AUTH: &str = "auth-roundup-1";

/// A live round-up into a fresh pool, and one prior run under the capture's key in `status`.
fn prior(status: &str, position: Option<&str>) -> Option<(Bank, String, String)> {
    let b = bank()?;
    let pool = b.pool("USDT", "0");
    let rule = b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    let run = uuid();
    b.db
        .client()
        .execute(
            "INSERT INTO bank.auto_invest_runs (id, rule_id, client_run_id, status, amount, position_id) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::bank.auto_invest_run_status, 0.7, $5)",
            &[&run, &rule.id, &format!("roundup:{}:{AUTH}", rule.id), &status, &position],
        )
        .unwrap();
    Some((b, pool, run))
}

fn spare() -> Amount {
    ai::spare_change(amt("4.30"), amt("1"))
}

fn run_row(b: &Bank, run: &str) -> (String, Option<String>) {
    let r = b.rows(&format!(
        "SELECT status::text, rejection_code FROM bank.auto_invest_runs WHERE id = '{run}'"
    ));
    (r[0][0].clone().unwrap(), r[0][1].clone())
}

#[test]
fn a_capture_the_card_partner_made_never_deposits_into_a_savings_pool_from_the_ledger_refused_by_name_recorded()
 {
    let Some((b, _, run)) = prior("pending", None) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    let out = b.capture(USER_A, AUTH, "4.30", true);
    assert_eq!(
        out,
        RoundUpOutcome::Refused {
            amount: spare(),
            reason: "bank.partner_custody_mismatch".to_owned()
        }
    );
    assert_eq!(b.ledger.len(), 0);
    assert_eq!(
        run_row(&b, &run),
        (
            "rejected".to_owned(),
            Some("bank.partner_custody_mismatch".to_owned())
        )
    );
}

#[test]
fn a_person_whose_bank_money_the_partner_holds_never_deposits_into_a_savings_pool_from_the_ledger()
{
    let Some((b, _, run)) = prior("pending", None) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    call(&b, USER_A, "testPartner.set", r#"{"custody":"off"}"#).ok();
    let out = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        out,
        RoundUpOutcome::Refused {
            amount: spare(),
            reason: "bank.partner_custody_mismatch".to_owned()
        }
    );
    assert_eq!(b.ledger.len(), 0);
    assert_eq!(run_row(&b, &run).0, "rejected");
}

#[test]
fn a_settled_row_with_a_position_id_does_not_deposit_again() {
    let position = uuid();
    let Some((b, _, _)) = prior("settled", Some(&position)) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    let out = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        out,
        RoundUpOutcome::SettledPool {
            amount: spare(),
            position_id: position
        }
    );
    assert_eq!(b.ledger.len(), 0);
}

#[test]
fn a_pending_row_deposits_once_with_that_run_id_and_settles() {
    let Some((b, pool, run)) = prior("pending", None) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    let out = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        out,
        RoundUpOutcome::SettledPool {
            amount: spare(),
            position_id: run.clone()
        }
    );
    assert_eq!(b.ledger.len(), 1);
    let p = space::with(&b.db.store(), |c| earn_service::position(c, &run)).unwrap();
    assert_eq!(
        (p.pool_id.as_str(), p.user_id.as_str(), p.principal),
        (pool.as_str(), USER_A, spare())
    );
    let r = b.rows(&format!(
        "SELECT status::text, position_id, amount::text FROM bank.auto_invest_runs WHERE id = '{run}'"
    ));
    assert_eq!(r[0][0].as_deref(), Some("settled"));
    assert_eq!(r[0][1].as_deref(), Some(run.as_str()));
    assert_eq!(parse_amount(r[0][2].as_deref().unwrap()).unwrap(), spare());
}

#[test]
fn a_rejected_row_deposits_once_with_that_same_run_id_and_settles() {
    let Some((b, _, run)) = prior("rejected", None) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    let out = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        out,
        RoundUpOutcome::SettledPool {
            amount: spare(),
            position_id: run.clone()
        }
    );
    assert_eq!(b.ledger.len(), 1);
    assert_eq!(run_row(&b, &run), ("settled".to_owned(), None));
}

#[test]
fn a_pending_row_whose_deposit_refuses_stays_refused_with_that_code() {
    let Some((b, pool, run)) = prior("pending", None) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    b.sql(&format!(
        "UPDATE bank.earn_pools SET status = 'closed' WHERE id = '{pool}'"
    ));
    let out = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        out,
        RoundUpOutcome::Refused {
            amount: spare(),
            reason: "bank.pool_closed".to_owned()
        }
    );
    assert_eq!(
        run_row(&b, &run),
        ("rejected".to_owned(), Some("bank.pool_closed".to_owned()))
    );
}

#[test]
fn a_pending_row_whose_deposit_has_an_unknown_outcome_stays_pending_and_is_re_driven_on_the_same_run_id()
 {
    let Some((b, _, run)) = prior("pending", None) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    b.ledger.mode(Mode::Down);
    let first = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        first,
        RoundUpOutcome::Refused {
            amount: spare(),
            reason: "bank.ledger_outcome_unknown".to_owned()
        }
    );
    // No `rejected` write: the deposit may have committed.
    assert_eq!(run_row(&b, &run), ("pending".to_owned(), None));
    b.ledger.mode(Mode::Books);
    let second = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        second,
        RoundUpOutcome::SettledPool {
            amount: spare(),
            position_id: run
        }
    );
    assert_eq!(b.ledger.len(), 1);
    b.ledger.reconciles();
}

#[test]
fn a_rejected_row_whose_deposit_refuses_stays_refused_with_the_deposit_code() {
    let Some((b, _, run)) = prior("rejected", None) else {
        return;
    };
    let out = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        out,
        RoundUpOutcome::Refused {
            amount: spare(),
            reason: "ledger.insufficient_funds".to_owned()
        }
    );
    assert_eq!(
        run_row(&b, &run),
        (
            "rejected".to_owned(),
            Some("ledger.insufficient_funds".to_owned())
        )
    );
}

#[test]
fn a_skipped_duplicate_does_not_deposit() {
    let Some((b, _, _)) = prior("skipped", None) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "10");
    let out = b.capture(USER_A, AUTH, "4.30", false);
    assert_eq!(
        out,
        RoundUpOutcome::Skipped {
            amount: spare(),
            reason: "bank.auto_invest_run_failed".to_owned()
        }
    );
    assert_eq!(b.ledger.len(), 0);
}

// ===============================================================================================================
// roundup-into-space.db.test.ts: money into a space (BK-pots-02)

fn round_up_into(b: &Bank, space: &str) -> Answer {
    call(
        b,
        USER_A,
        "autoInvest.createRoundUp",
        &format!(r#"{{"assetId":"USDT","granularity":"1","targetSpaceId":"{space}"}}"#),
    )
}

fn list(b: &Bank, extra: &str) -> Vec<Json> {
    match call(
        b,
        USER_A,
        "autoInvest.list",
        &format!(r#"{{"limit":50{extra}}}"#),
    )
    .ok()
    {
        Json::Array(a) => a,
        other => panic!("{}", other.compact()),
    }
}

#[test]
fn makes_a_round_up_into_the_persons_own_space_and_refuses_every_other_target_by_name() {
    let Some(b) = bank() else { return };
    let holiday = b.space(USER_A, "TEST holiday", "USDT");
    let main = b.primary(USER_A);
    let bos = b.space(USER_B, "TEST other", "USDT");
    let euro = b.space(USER_A, "TEST euro", "EURC");
    let none = call(
        &b,
        USER_A,
        "autoInvest.createRoundUp",
        r#"{"assetId":"USDT","granularity":"1"}"#,
    );
    assert_eq!(none.cause(), "bank.auto_invest_target_invalid");
    let both = call(
        &b,
        USER_A,
        "autoInvest.createRoundUp",
        &format!(
            r#"{{"assetId":"USDT","granularity":"1","targetSpaceId":"{holiday}","targetPoolId":"{}"}}"#,
            uuid()
        ),
    );
    assert_eq!(both.cause(), "bank.auto_invest_target_invalid");
    assert_eq!(
        round_up_into(&b, &main).cause(),
        "bank.auto_invest_target_invalid"
    );
    assert_eq!(round_up_into(&b, &bos).cause(), "bank.space_not_found");
    assert_eq!(round_up_into(&b, &euro).cause(), "bank.asset_mismatch");
    b.archive(&holiday);
    assert_eq!(round_up_into(&b, &holiday).cause(), "bank.space_archived");
    assert!(
        b.rows("SELECT id::text FROM bank.auto_invest_rules")
            .is_empty()
    );

    b.unarchive(&holiday);
    let rule = round_up_into(&b, &holiday).ok();
    assert_eq!(
        (
            s(&rule, "kind"),
            s(&rule, "targetSpaceId"),
            s(&rule, "targetPoolId"),
            s(&rule, "amount"),
            s(&rule, "status")
        ),
        (
            "card_roundup".to_owned(),
            holiday.clone(),
            "null".to_owned(),
            "1".to_owned(),
            "active".to_owned()
        )
    );
    let id = s(&rule, "id");
    assert!(
        list(&b, "")
            .iter()
            .any(|r| s(r, "id") == id && s(r, "targetSpaceId") == holiday)
    );
    // One live round-up per asset, whichever its target.
    let other = b.space(USER_A, "TEST bills", "USDT");
    assert_eq!(
        round_up_into(&b, &other).cause(),
        "bank.auto_invest_roundup_exists"
    );
    // Read for one space: only the round-ups into it.
    let into = list(&b, &format!(r#","targetSpaceId":"{holiday}""#));
    assert_eq!(
        into.iter().map(|r| s(r, "id")).collect::<Vec<_>>(),
        vec![id]
    );
    assert!(list(&b, &format!(r#","targetSpaceId":"{other}""#)).is_empty());
    // A list with no page size refuses, never 50.
    let blank = call(&b, USER_A, "autoInvest.list", "{}");
    assert_eq!(blank.cause(), "bank.auto_invest_list_limit_unset");
}

#[test]
fn a_round_up_into_a_pot_is_refused_where_the_partner_offers_no_pots_before_anything_is_written() {
    let Some(b) = bank() else { return };
    let holiday = b.space(USER_A, "TEST holiday", "USDT");
    call(&b, USER_A, "testPartner.set", r#"{"notOffered":["pots"]}"#).ok();
    assert_eq!(
        round_up_into(&b, &holiday).cause(),
        "bank.not_offered_by_partner"
    );
    assert!(
        b.rows("SELECT id::text FROM bank.auto_invest_rules")
            .is_empty()
    );
}

#[test]
fn moves_the_spare_change_of_a_capture_into_the_space_once_and_a_re_drive_returns_the_first_answer()
{
    let Some(b) = bank() else { return };
    b.ledger.fund(USER_A, "USDT", "10");
    let holiday = b.space(USER_A, "TEST holiday", "USDT");
    let rule = s(&round_up_into(&b, &holiday).ok(), "id");
    let auth = uuid();
    let first = b.capture(USER_A, &auth, "4.30", false);
    let RoundUpOutcome::SettledSpace {
        amount,
        space_id,
        ledger_tx_id,
    } = first.clone()
    else {
        panic!("{first:?}")
    };
    assert_eq!((amount, space_id.as_str()), (amt("0.7"), holiday.as_str()));
    assert_eq!(b.ledger.space(&holiday), "0.7");
    assert_eq!(b.ledger.main(USER_A, "USDT"), "9.3");
    assert_eq!(b.capture(USER_A, &auth, "4.30", false), first);
    assert_eq!(b.ledger.space(&holiday), "0.7");
    let runs = b.rows(&format!(
        "SELECT status::text, ledger_tx_id, client_run_id FROM bank.auto_invest_runs WHERE rule_id = '{rule}'"
    ));
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0][0].as_deref(), Some("settled"));
    assert_eq!(runs[0][1].as_deref(), Some(ledger_tx_id.as_str()));
    assert_eq!(
        runs[0][2].clone().unwrap(),
        format!("roundup:{rule}:{auth}")
    );
    // An exact multiple has nothing to move.
    let exact = b.capture(USER_A, &uuid(), "5", false);
    assert_eq!(
        (exact.status(), reason(&exact)),
        ("skipped", "bank.auto_invest_no_spare")
    );
    assert_eq!(b.ledger.space(&holiday), "0.7");
    b.ledger.reconciles();
}

#[test]
fn refuses_by_name_and_moves_nothing_when_the_account_is_empty_or_the_space_is_archived_then_settles_on_a_retry()
 {
    let Some(b) = bank() else { return };
    let holiday = b.space(USER_A, "TEST holiday", "USDT");
    let rule = s(&round_up_into(&b, &holiday).ok(), "id");
    let auth = uuid();
    let empty = b.capture(USER_A, &auth, "2.25", false);
    assert_eq!(
        (empty.status(), reason(&empty)),
        ("refused", "ledger.insufficient_funds")
    );
    assert_eq!(b.ledger.space(&holiday), "0");
    let r = b.rows(&format!(
        "SELECT status::text, rejection_code FROM bank.auto_invest_runs WHERE rule_id = '{rule}'"
    ));
    assert_eq!(
        (r[0][0].as_deref(), r[0][1].as_deref()),
        (Some("rejected"), Some("ledger.insufficient_funds"))
    );
    b.ledger.fund(USER_A, "USDT", "5");
    let retry = b.capture(USER_A, &auth, "2.25", false);
    assert_eq!((retry.status(), retry.amount()), ("settled", amt("0.75")));
    assert_eq!(b.ledger.space(&holiday), "0.75");
    b.archive(&holiday);
    let archived = b.capture(USER_A, &uuid(), "1.5", false);
    assert_eq!(
        (archived.status(), reason(&archived)),
        ("refused", "bank.space_archived")
    );
    assert_eq!(b.ledger.space(&holiday), "0.75");
    assert_eq!(b.ledger.main(USER_A, "USDT"), "4.25");
}

#[test]
fn keeps_the_run_pending_when_the_ledgers_answer_is_lost_or_names_another_movement_and_a_re_drive_moves_it_once()
 {
    let Some(b) = bank() else { return };
    b.ledger.fund(USER_A, "USDT", "10");
    let holiday = b.space(USER_A, "TEST holiday", "USDT");
    let rule = s(&round_up_into(&b, &holiday).ok(), "id");
    let auth = uuid();
    let run = || -> Vec<String> {
        b.rows(&format!(
            "SELECT status::text FROM bank.auto_invest_runs WHERE rule_id = '{rule}'"
        ))
        .into_iter()
        .map(|r| r[0].clone().unwrap())
        .collect()
    };
    b.ledger.mode(Mode::Down);
    let lost = b.capture(USER_A, &auth, "4.30", false);
    assert_eq!(
        (lost.status(), reason(&lost)),
        ("refused", "bank.ledger_outcome_unknown")
    );
    assert_eq!(run(), ["pending"]);
    // Detect mode answers a reused key with the original transaction: here, one that is not this movement.
    let deposit = LedgerTx {
        key: "bank.deposit:test".to_owned(),
        id: "tx-deposit".to_owned(),
        posted_at: now(),
        entries: vec![
            TxEntry {
                account_id: "acct:house:rail".to_owned(),
                asset_id: "USDT".to_owned(),
                direction: "credit".to_owned(),
                amount: amt("10"),
            },
            TxEntry {
                account_id: acct_id(&main_of(USER_A, "USDT")),
                asset_id: "USDT".to_owned(),
                direction: "debit".to_owned(),
                amount: amt("10"),
            },
        ],
    };
    b.ledger.mode(Mode::Answers(deposit));
    let other = b.capture(USER_A, &auth, "4.30", false);
    assert_eq!(
        (other.status(), reason(&other)),
        ("refused", "bank.ledger_outcome_unknown")
    );
    assert_eq!(run(), ["pending"]);
    assert_eq!(b.ledger.space(&holiday), "0");
    b.ledger.mode(Mode::Books);
    for _ in 0..2 {
        let settled = b.capture(USER_A, &auth, "4.30", false);
        assert_eq!(
            (settled.status(), settled.amount()),
            ("settled", amt("0.7"))
        );
    }
    assert_eq!(run(), ["settled"]);
    assert_eq!(b.ledger.space(&holiday), "0.7");
    assert_eq!(b.ledger.main(USER_A, "USDT"), "9.3");
    b.ledger.reconciles();
}

#[test]
fn where_the_partner_bank_holds_the_money_moves_the_spare_change_as_one_partner_move_once_and_posts_nothing()
 {
    let Some(b) = bank() else { return };
    call(&b, USER_A, "testPartner.set", r#"{"custody":"off"}"#).ok();
    call(
        &b,
        USER_A,
        "testPartner.fund",
        &format!(r#"{{"fundId":"fund-{USER_A}","assetId":"USDT","amount":"10"}}"#),
    )
    .ok();
    let holiday = b.space(USER_A, "TEST holiday", "USDT");
    let rule = b.round_up(USER_A, "1", None, Some(&holiday)).unwrap();
    let auth = uuid();
    let first = b.capture(USER_A, &auth, "4.30", true);
    let RoundUpOutcome::SettledPartner {
        amount,
        space_id,
        partner_move_id,
    } = first.clone()
    else {
        panic!("{first:?}")
    };
    assert_eq!((amount, space_id.as_str()), (amt("0.7"), holiday.as_str()));
    assert_eq!(first.json().get("ledgerTxId"), Some(&Json::Null));
    let key = format!("bank.transfer.own:roundup:{}:{auth}:0", rule.id);
    let moved = b.partner().lock().book.by_key(&key).cloned().unwrap();
    assert_eq!(
        (moved.id.as_str(), moved.amount),
        (partner_move_id.as_str(), amt("0.7"))
    );
    assert_eq!(
        (moved.from.space_id.clone(), moved.to.space_id.clone()),
        (None, Some(holiday.clone()))
    );
    assert_eq!(b.at_partner(USER_A, Some(&holiday)), "0.7");
    assert_eq!(b.at_partner(USER_A, None), "9.3");
    // The same capture re-driven answers with the same move, and nothing moves again.
    assert_eq!(b.capture(USER_A, &auth, "4.30", true), first);
    assert_eq!(b.at_partner(USER_A, Some(&holiday)), "0.7");
    let runs = b.rows(&format!(
        "SELECT status::text, ledger_tx_id, partner_move_id FROM bank.auto_invest_runs WHERE rule_id = '{}'",
        rule.id
    ));
    assert_eq!(
        runs,
        vec![vec![
            Some("settled".to_owned()),
            None,
            Some(partner_move_id)
        ]]
    );
    assert_eq!(b.ledger.len(), 0);
    // Another capture is its own run and its own move.
    let small = b.capture(USER_A, &uuid(), "0.5", true);
    assert_eq!((small.status(), small.amount()), ("settled", amt("0.5")));
    assert_eq!(b.at_partner(USER_A, None), "8.8");
    // The two books disagree: neither rounds up, and nothing moves anywhere.
    let mismatch = b.capture(USER_A, &uuid(), "4.30", false);
    assert_eq!(
        (mismatch.status(), reason(&mismatch)),
        ("refused", "bank.partner_custody_mismatch")
    );
    call(&b, USER_A, "testPartner.set", r#"{"custody":"on"}"#).ok();
    let other = b.capture(USER_A, &uuid(), "4.30", true);
    assert_eq!(
        (other.status(), reason(&other)),
        ("refused", "bank.partner_custody_mismatch")
    );
    call(&b, USER_A, "testPartner.set", r#"{"custody":"off"}"#).ok();
    assert_eq!(b.at_partner(USER_A, Some(&holiday)), "1.2");
    assert_eq!(b.ledger.len(), 0);
}

#[test]
fn where_the_partner_bank_holds_the_money_an_account_short_of_the_spare_change_is_refused_by_the_partner_and_moves_nothing()
 {
    let Some(b) = bank() else { return };
    call(&b, USER_A, "testPartner.set", r#"{"custody":"off"}"#).ok();
    call(
        &b,
        USER_A,
        "testPartner.fund",
        &format!(r#"{{"fundId":"fund-{USER_A}-small","assetId":"USDT","amount":"0.2"}}"#),
    )
    .ok();
    let holiday = b.space(USER_A, "TEST holiday", "USDT");
    let rule = b.round_up(USER_A, "1", None, Some(&holiday)).unwrap();
    let refused = b.capture(USER_A, &uuid(), "4.30", true);
    assert_eq!(
        (refused.status(), reason(&refused)),
        ("refused", "bank.partner_insufficient_funds")
    );
    let runs = b.rows(&format!(
        "SELECT status::text, rejection_code, partner_move_id FROM bank.auto_invest_runs WHERE rule_id = '{}'",
        rule.id
    ));
    assert_eq!(
        runs,
        vec![vec![
            Some("rejected".to_owned()),
            Some("bank.partner_insufficient_funds".to_owned()),
            None
        ]]
    );
    assert_eq!(b.at_partner(USER_A, Some(&holiday)), "0");
    assert_eq!(b.ledger.len(), 0);
}

// ===============================================================================================================
// ops/asset-pause.db.test.ts: the auto-invest half

#[test]
fn a_supply_pause_refuses_auto_invest_deposits_too_threshold_sweep_and_card_round_up_nothing_is_staked()
 {
    let Some(b) = bank() else { return };
    let pool = b.pool("USDT", "0");
    b.ledger.fund(USER_A, "USDT", "10");
    let sweep = b.sweep(USER_A, "4", &pool).unwrap();
    b.round_up(USER_A, "1", Some(&pool), None).unwrap();
    b.sql(
        "INSERT INTO bank.asset_pauses (asset_id, borrow_paused, supply_paused, revision, reason, approved_by) \
         VALUES ('USDT', false, true, 1, 'TEST pause', 'TEST approver')",
    );
    let report = b.svc(None, |d| ai::run_due(d, now(), Some(10.0))).unwrap();
    assert_eq!((report.settled, report.rejected), (0, 1));
    let runs = b.runs(&sweep.id);
    assert_eq!(statuses(&runs), ["rejected"]);
    assert_eq!(runs[0].rejection_code.as_deref(), Some("bank.asset_paused"));
    let round_up = b.capture(USER_A, &uuid(), "2.5", false);
    assert_eq!(
        (round_up.status(), reason(&round_up)),
        ("refused", "bank.asset_paused")
    );
    assert!(
        b.rows("SELECT id::text FROM bank.earn_positions")
            .is_empty()
    );
    assert_eq!(b.ledger.main(USER_A, "USDT"), "10");
}

// ===============================================================================================================
// auto-invest.reachable.test.ts: boot-shaped convert wiring

#[test]
fn boot_shaped_wiring_with_a_fake_convert_settles_dca() {
    let Some(b) = converting(Fill::Receive(None)) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let rule = b.dca(USER_A, "2026-08-01T00:00:00Z").unwrap();
    assert_eq!(b.run("2026-08-09T00:00:00Z", 200.0).settled, 1);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "400");
    assert_eq!(b.ledger.main(USER_A, "BTC"), "100");
    assert_eq!(rule.kind, "dca");
}

#[test]
fn no_convert_named_refuse() {
    let Some(b) = bank() else { return };
    assert_eq!(
        code(&b.dca(USER_A, "2026-08-09T00:00:00Z").unwrap_err()),
        "bank.auto_invest_rate_unset"
    );
    // Through the door: the policy says so, and the call refuses by name before anything is written.
    let policy = call(&b, USER_A, "autoInvest.policy", "").ok();
    assert_eq!(
        (s(&policy, "enabled"), s(&policy, "convertWired")),
        ("true".to_owned(), "false".to_owned())
    );
    let refused = call(
        &b,
        USER_A,
        "autoInvest.createDca",
        r#"{"spendAssetId":"USDT","buyAssetId":"BTC","amount":"100","cadence":"daily","startsAt":"2026-08-09T00:00:00Z"}"#,
    );
    assert_eq!(
        (refused.trpc(), refused.cause()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.auto_invest_rate_unset".to_owned()
        )
    );
}

#[test]
fn a_dca_created_through_the_door_answers_the_rule_as_the_router_maps_it() {
    let Some(b) = converting(Fill::Receive(None)) else {
        return;
    };
    let rule = call(
        &b,
        USER_A,
        "autoInvest.createDca",
        r#"{"spendAssetId":"USDT","buyAssetId":"BTC","amount":"100.50","cadence":"monthly","startsAt":"2026-08-09T10:00:00+02:00"}"#,
    )
    .ok();
    assert_eq!(s(&rule, "kind"), "dca");
    assert_eq!(s(&rule, "amount"), "100.5");
    assert_eq!(s(&rule, "cadence"), "monthly");
    assert_eq!(s(&rule, "nextRunAt"), "2026-08-09T08:00:00.000Z");
    assert_eq!(s(&rule, "threshold"), "null");
    let policy = call(&b, USER_A, "autoInvest.policy", "").ok();
    assert_eq!(s(&policy, "convertWired"), "true");
}

/// How svc-trade answers the n-th quote and every other request.
type Answering = dyn Fn(&HttpRequest, usize) -> Result<HttpResponse, FetchError> + Send + Sync;

/// svc-trade over a fake fetch: each request recorded, each answer from `answer`.
#[derive(Clone)]
struct Trade {
    seen: Arc<Mutex<Vec<HttpRequest>>>,
    answer: Arc<Answering>,
}

impl Fetch for Trade {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        let n = {
            let mut seen = self.seen.lock().unwrap();
            seen.push(req.clone());
            seen.iter()
                .filter(|r| r.url.contains("standing.quote"))
                .count()
        };
        (self.answer)(req, n)
    }
}

fn reply(status: u16, body: &str) -> Result<HttpResponse, FetchError> {
    Ok(HttpResponse {
        status,
        body: body.to_owned(),
    })
}

const SPOT: &str = r#"{"symbol":"BTC/USDT","base":"BTC","quote":"USDT","spot":true,"active":true,"limits":{"amount":{"min":"0.001"}}}"#;

fn quote_wire(over: &str) -> String {
    let base = r#""quoteId":"q-1","symbol":"BTC/USDT","side":"buy","requestedQty":"0.002","filledQty":"0.002","userNotional":"100","avgPrice":"50000","fullyFilled":true"#;
    let mut fields: Vec<(String, String)> = Vec::new();
    for part in json_fields(&format!("{{{base}}}"))
        .into_iter()
        .chain(json_fields(&format!("{{{over}}}")))
    {
        fields.retain(|(k, _)| *k != part.0);
        fields.push(part);
    }
    fields.retain(|(_, v)| v != "\"<omit>\"");
    format!(
        "{{{}}}",
        fields
            .iter()
            .map(|(k, v)| format!("\"{k}\":{v}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn json_fields(text: &str) -> Vec<(String, String)> {
    match json::parse(text).unwrap() {
        Json::Object(f) => f.into_iter().map(|(k, v)| (k, v.compact())).collect(),
        _ => vec![],
    }
}

fn execute_wire(over: &str) -> String {
    let base = r#""quoteId":"q-1","fillId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","inAmount":"100","outAmount":"0.002""#;
    let mut fields: Vec<(String, String)> = json_fields(&format!("{{{base}}}"));
    for part in json_fields(&format!("{{{over}}}")) {
        fields.retain(|(k, _)| *k != part.0);
        fields.push(part);
    }
    fields.retain(|(_, v)| v != "\"<omit>\"");
    format!(
        "{{{}}}",
        fields
            .iter()
            .map(|(k, v)| format!("\"{k}\":{v}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn data(body: &str) -> String {
    format!(r#"{{"result":{{"data":{body}}}}}"#)
}

/// `tradeConvertPort({ baseUrl, serviceSecret, marketsLimit, fetchImpl })`.
fn trade_port(
    limit: Option<i64>,
    answer: impl Fn(&HttpRequest, usize) -> Result<HttpResponse, FetchError> + Send + Sync + 'static,
) -> (TradeConvert, Trade) {
    let fetch = Trade {
        seen: Arc::default(),
        answer: Arc::new(answer),
    };
    let port = TradeConvert::new(
        "http://svc-trade:4004",
        CallSigner::new("svc-bank", "svc-trade", INTERNAL, None),
        Box::new(fetch.clone()),
        limit,
    );
    (port, fetch)
}

/// `portFrom(markets, quote, execute)`.
fn port_from(markets: &str, quote: &str, execute: &str) -> (TradeConvert, Trade) {
    let (m, q, e) = (markets.to_owned(), quote.to_owned(), execute.to_owned());
    trade_port(Some(50), move |req, _| {
        if req.url.contains("/api/v1/markets") {
            reply(200, &m)
        } else if req.url.contains("/trpc/standing.quote") {
            reply(200, &data(&q))
        } else if req.url.contains("/trpc/standing.execute") {
            reply(200, &data(&e))
        } else {
            reply(404, r#"{"error":{"message":"unexpected"}}"#)
        }
    })
}

fn buy() -> ConvertAsk<'static> {
    ConvertAsk {
        user_id: USER_A,
        instruction_id: "99999999-9999-4999-8999-999999999999",
        from_asset: "USDT",
        to_asset: "BTC",
        from_amount: amt("100"),
        client_convert_id: "dca-l154-buy",
    }
}

fn sell() -> ConvertAsk<'static> {
    ConvertAsk {
        user_id: USER_A,
        instruction_id: "99999999-9999-4999-8999-999999999999",
        from_asset: "BTC",
        to_asset: "USDT",
        from_amount: amt("0.002"),
        client_convert_id: "dca-l154-sell",
    }
}

/// The refusal's code, `unknown` for `ConvertOutcomeUnknown`, or the fill.
fn verdict(r: Result<Converted, ConvertError>) -> String {
    match r {
        Ok(c) => format!("fill {} {}", format_amount(c.to_amount), c.ledger_tx_id),
        Err(ConvertError::Refused(r)) => code(&r),
        Err(ConvertError::Ledger(c)) => c,
        Err(ConvertError::Unknown(_)) => "unknown".to_owned(),
    }
}

const RATE: &str = "bank.auto_invest_rate_unset";

/// A bank whose convert is svc-trade over the fake fetch.
fn trading(
    answer: impl Fn(&HttpRequest, usize) -> Result<HttpResponse, FetchError> + Send + Sync + 'static,
) -> Option<(Bank, Trade)> {
    let mut fetch = None;
    let b = bank_with(|_, _| {
        let (port, f) = trade_port(Some(50), answer);
        fetch = Some(f);
        wiring(true, Some(Box::new(port)))
    })?;
    Some((b, fetch.unwrap()))
}

fn standing(req: &HttpRequest, _n: usize) -> Result<HttpResponse, FetchError> {
    if req.url.contains("/api/v1/markets") {
        reply(200, &format!("[{SPOT}]"))
    } else if req.url.contains("/trpc/standing.quote") {
        reply(200, &data(&quote_wire("")))
    } else if req.url.contains("/trpc/standing.execute") {
        reply(
            200,
            &data(&execute_wire(
                r#""fillId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa""#,
            )),
        )
    } else {
        reply(404, r#"{"error":{"message":"unexpected"}}"#)
    }
}

#[test]
fn run_due_through_trade_convert_port_hits_convert_quote_no_bank_mid() {
    let Some((b, fetch)) = trading(standing) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let rule = b.dca(USER_A, "2026-08-01T00:00:00Z").unwrap();
    let report = b.run("2026-08-09T00:00:00Z", 200.0);
    let seen: Vec<String> = fetch
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|r| r.url.clone())
        .collect();
    assert!(seen.contains(&"http://svc-trade:4004/api/v1/markets?limit=50".to_owned()));
    assert!(seen.iter().any(|u| u.contains("/trpc/standing.quote")));
    assert!(seen.iter().any(|u| u.contains("/trpc/standing.execute")));
    assert_eq!(report.settled, 1);
    let runs = b.runs(&rule.id);
    assert_eq!(
        runs[0].ledger_tx_id.as_deref(),
        Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    );
    // The fill is trade's: the bank posts no mid and moves no USDT itself.
    assert_eq!(b.ledger.main(USER_A, "USDT"), "500");
}

#[test]
fn run_due_through_trade_convert_port_names_rate_unset_when_convert_quote_fails() {
    let Some((b, _)) = trading(|req, _| {
        if req.url.contains("/api/v1/markets") {
            reply(200, &format!("[{SPOT}]"))
        } else {
            reply(
                400,
                r#"{"error":{"message":"insufficient book depth","data":{"intafacedCode":"trade.convert_insufficient_depth"}}}"#,
            )
        }
    }) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let rule = b.dca(USER_A, "2026-08-01T00:00:00Z").unwrap();
    let report = b.run("2026-08-09T00:00:00Z", 200.0);
    assert_eq!((report.settled, report.rejected), (0, 1));
    assert_eq!(b.runs(&rule.id)[0].rejection_code.as_deref(), Some(RATE));
    assert_eq!(b.ledger.main(USER_A, "USDT"), "500");
}

#[test]
fn an_execute_that_times_out_leaves_the_run_pending_never_rejected() {
    let Some((b, _)) = trading(|req, n| {
        if req.url.contains("/api/v1/markets") || req.url.contains("standing.quote") {
            standing(req, n)
        } else {
            Err(FetchError {
                message: "socket hang up".to_owned(),
            })
        }
    }) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    let rule = b.dca(USER_A, "2026-08-01T00:00:00Z").unwrap();
    b.run("2026-08-09T00:00:00Z", 200.0);
    assert_eq!(statuses(&b.runs(&rule.id)), ["pending"]);
}

#[test]
fn convert_failure_does_not_invent_a_price() {
    let Some(b) = converting(Fill::NoRate) else {
        return;
    };
    b.ledger.fund(USER_A, "USDT", "500");
    b.dca(USER_A, "2026-08-01T00:00:00Z").unwrap();
    let report = b.run("2026-08-09T00:00:00Z", 200.0);
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
    assert_eq!(report.settled, 0);
    assert_eq!(b.ledger.main(USER_A, "USDT"), "500");
    assert_eq!(b.ledger.main(USER_A, "BTC"), "0");
}

// ===============================================================================================================
// trade-convert-port.test.ts (no database)

#[test]
fn buy_path_returns_convert_execute_filled_qty_decimal_strings_on_the_wire() {
    let (port, fetch) = trade_port(Some(50), |req, n| {
        if req.url.contains("standing.quote") {
            reply(
                200,
                &data(&quote_wire(
                    r#""convertSpreadBps":10,"expiresAt":"2026-08-16T12:00:00.000Z""#,
                )),
            )
        } else {
            standing(req, n)
        }
    });
    let mut ask = buy();
    ask.client_convert_id = "dca-test-1";
    assert_eq!(
        verdict(port.convert(&ask)),
        "fill 0.002 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    let seen: Vec<String> = fetch
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|r| r.url.clone())
        .collect();
    assert!(seen.contains(&"http://svc-trade:4004/api/v1/markets?limit=50".to_owned()));
    assert!(seen.iter().any(|u| u.contains("/trpc/standing.quote")));
    assert!(seen.iter().any(|u| u.contains("/trpc/standing.execute")));
}

#[test]
fn refuses_by_name_when_convert_quote_fails_does_not_invent_a_price() {
    let (port, _) = trade_port(Some(50), |req, _| {
        if req.url.contains("/api/v1/markets") {
            reply(200, &format!("[{SPOT}]"))
        } else {
            reply(
                400,
                r#"{"error":{"message":"insufficient book depth","data":{"intafacedCode":"trade.convert_insufficient_depth"}}}"#,
            )
        }
    });
    assert_eq!(verdict(port.convert(&buy())), RATE);
}

#[test]
fn refuses_when_execute_fills_nothing_rather_than_substituting_a_ticker_mid() {
    let (port, _) = port_from(
        &format!("[{SPOT}]"),
        &quote_wire(""),
        &execute_wire(r#""inAmount":"0","outAmount":"0""#),
    );
    assert_eq!(verdict(port.convert(&buy())), "unknown");
}

#[test]
fn omit_markets_limit_refuses_bank_convert_markets_limit_unset_never_calls_trade_never_invents_50()
{
    let (port, fetch) = trade_port(None, standing);
    assert_eq!(
        verdict(port.convert(&buy())),
        "bank.convert_markets_limit_unset"
    );
    assert!(fetch.seen.lock().unwrap().is_empty());
}

#[test]
fn empty_markets_listing_refuses_rate_unset_does_not_fabricate_a_pair() {
    let (port, _) = port_from("[]", &quote_wire(""), &execute_wire(""));
    assert_eq!(verdict(port.convert(&buy())), RATE);
}

#[test]
fn listed_pair_missing_refuses_rate_unset_does_not_invent_a_convert_market() {
    let eth = SPOT.replace("BTC", "ETH");
    let (port, _) = port_from(&format!("[{eth}]"), &quote_wire(""), &execute_wire(""));
    assert_eq!(verdict(port.convert(&buy())), RATE);
}

#[test]
fn a_listed_market_is_tradable_only_when_spot_and_active_are_true() {
    for market in [
        SPOT.replace(r#""spot":true,"#, ""),
        SPOT.replace(r#""active":true,"#, ""),
        SPOT.replace(r#""spot":true"#, r#""spot":false"#),
        SPOT.replace(r#""active":true"#, r#""active":false"#),
    ] {
        let (port, _) = port_from(&format!("[{market}]"), &quote_wire(""), &execute_wire(""));
        assert_eq!(verdict(port.convert(&buy())), RATE, "{market}");
    }
}

#[test]
fn quote_proceeds_only_when_fully_filled_is_true() {
    for over in [r#""fullyFilled":"<omit>""#, r#""fullyFilled":false"#] {
        let (port, _) = port_from(&format!("[{SPOT}]"), &quote_wire(over), &execute_wire(""));
        assert_eq!(verdict(port.convert(&buy())), RATE, "{over}");
    }
}

#[test]
fn a_missing_fill_id_unreadable_or_non_positive_amount_or_overspend_is_unknown_run_stays_pending() {
    for over in [
        r#""fillId":"<omit>""#,
        r#""outAmount":"<omit>""#,
        r#""inAmount":"<omit>""#,
        r#""outAmount":"""#,
        r#""outAmount":"0""#,
        r#""outAmount":"-1""#,
        r#""inAmount":"100.01""#,
    ] {
        let (port, _) = port_from(&format!("[{SPOT}]"), &quote_wire(""), &execute_wire(over));
        assert_eq!(verdict(port.convert(&buy())), "unknown", "{over}");
    }
}

#[test]
fn a_sell_that_settled_more_than_from_amount_is_unknown() {
    let (port, _) = port_from(
        &format!("[{SPOT}]"),
        &quote_wire(r#""side":"sell""#),
        &execute_wire(r#""inAmount":"0.003","outAmount":"99.5""#),
    );
    assert_eq!(verdict(port.convert(&sell())), "unknown");
}

#[test]
fn a_timeout_network_error_5xx_or_untyped_4xx_on_execute_is_unknown_a_typed_refusal_is_definite() {
    let run = |execute: fn() -> Result<HttpResponse, FetchError>| {
        let (port, _) = trade_port(Some(50), move |req, n| {
            if req.url.contains("standing.execute") {
                execute()
            } else {
                standing(req, n)
            }
        });
        verdict(port.convert(&buy()))
    };
    assert_eq!(
        run(|| Err(FetchError {
            message: "socket hang up".to_owned()
        })),
        "unknown"
    );
    assert_eq!(
        run(|| reply(502, r#"{"error":{"message":"bad gateway"}}"#)),
        "unknown"
    );
    assert_eq!(
        run(|| reply(400, r#"{"error":{"message":"nope"}}"#)),
        "unknown"
    );
    assert_eq!(run(|| reply(200, "<html>bad gateway</html>")), "unknown");
    assert_eq!(run(|| reply(200, r#"{"result":"#)), "unknown");
    assert_eq!(
        run(|| reply(
            200,
            r#"{"error":{"message":"x","data":{"intafacedCode":"trade.convert_quote_expired"}}}"#
        )),
        "unknown"
    );
    assert_eq!(
        run(|| reply(
            409,
            r#"{"error":{"message":"x","data":{"intafacedCode":"trade.convert_quote_expired"}}}"#
        )),
        RATE
    );
}

#[test]
fn sends_max_avg_price_equal_to_the_live_quote_avg_price() {
    let (port, fetch) = trade_port(Some(50), standing);
    port.convert(&buy()).unwrap();
    let seen = fetch.seen.lock().unwrap();
    let exec = seen
        .iter()
        .find(|r| r.url.contains("standing.execute"))
        .unwrap();
    let body = json::parse(exec.body.as_deref().unwrap()).unwrap();
    assert_eq!(s(&body, "maxAvgPrice"), "50000");
}

#[test]
fn a_buy_returns_the_settled_base_qty_and_the_fill_id() {
    let (port, _) = port_from(
        &format!("[{SPOT}]"),
        &quote_wire(r#""fullyFilled":true"#),
        &execute_wire(r#""outAmount":"0.002""#),
    );
    assert_eq!(
        verdict(port.convert(&buy())),
        "fill 0.002 cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    );
}

#[test]
fn a_sell_returns_the_quote_asset_parsed_from_execute_out_amount() {
    let (port, _) = port_from(
        &format!("[{SPOT}]"),
        &quote_wire(r#""side":"sell","userNotional":"100","fullyFilled":true"#),
        &execute_wire(r#""inAmount":"0.002","outAmount":"99.5""#),
    );
    assert_eq!(
        verdict(port.convert(&sell())),
        "fill 99.5 cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    );
}

#[test]
fn a_sell_refuses_when_out_amount_is_missing_blank_whitespace_zero_or_negative() {
    for over in [
        r#""outAmount":"<omit>""#,
        r#""inAmount":"0.002","outAmount":"""#,
        r#""inAmount":"0.002","outAmount":"   ""#,
        r#""inAmount":"0.002","outAmount":"0""#,
        r#""inAmount":"0.002","outAmount":"-1""#,
    ] {
        let (port, _) = port_from(
            &format!("[{SPOT}]"),
            &quote_wire(r#""side":"sell","userNotional":"100""#),
            &execute_wire(over),
        );
        assert_eq!(verdict(port.convert(&sell())), "unknown", "{over}");
    }
}

/// `watchingPort`: the quote quantities asked and the executes sent.
fn watching(markets: String, quote_for: fn(usize) -> String) -> (TradeConvert, Trade) {
    trade_port(Some(50), move |req, n| {
        if req.url.contains("/api/v1/markets") {
            reply(200, &markets)
        } else if req.url.contains("standing.quote") {
            reply(200, &data(&quote_for(n)))
        } else if req.url.contains("standing.execute") {
            reply(200, &data(&execute_wire("")))
        } else {
            reply(404, "{}")
        }
    })
}

fn quotes(f: &Trade) -> Vec<String> {
    f.seen
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.url.contains("standing.quote"))
        .map(|r| s(&json::parse(r.body.as_deref().unwrap()).unwrap(), "qty"))
        .collect()
}

fn executes(f: &Trade) -> usize {
    f.seen
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.url.contains("standing.execute"))
        .count()
}

const SPOT_NO_LIMITS: &str =
    r#"{"symbol":"BTC/USDT","base":"BTC","quote":"USDT","spot":true,"active":true}"#;

fn with_min(min: &str) -> String {
    format!(
        r#"[{{"symbol":"BTC/USDT","base":"BTC","quote":"USDT","spot":true,"active":true,"limits":{{"amount":{{"min":{min}}}}}}}]"#
    )
}

#[test]
fn refuses_a_missing_limits_amount_min_and_does_not_quote_0_00000001() {
    let (port, f) = watching(format!("[{SPOT_NO_LIMITS}]"), |_| quote_wire(""));
    assert_eq!(verdict(port.convert(&buy())), RATE);
    assert!(quotes(&f).is_empty());
    assert_eq!(executes(&f), 0);
}

#[test]
fn refuses_a_blank_limits_amount_min_and_does_not_quote_0_00000001() {
    for min in [r#""""#, r#""   ""#, "null"] {
        let (port, f) = watching(with_min(min), |_| quote_wire(""));
        assert_eq!(verdict(port.convert(&buy())), RATE, "{min}");
        assert!(!quotes(&f).contains(&"0.00000001".to_owned()));
        assert_eq!(executes(&f), 0);
    }
}

#[test]
fn refuses_a_non_positive_published_minimum_and_does_not_invent_a_probe_quantity() {
    for min in [r#""0""#, r#""-0.001""#] {
        let (port, f) = watching(with_min(min), |_| quote_wire(""));
        assert_eq!(verdict(port.convert(&buy())), RATE, "{min}");
        assert!(quotes(&f).is_empty());
        assert_eq!(executes(&f), 0);
    }
}

#[test]
fn refuses_a_sell_when_limits_amount_min_is_blank() {
    let (port, f) = watching(with_min(r#""""#), |_| {
        quote_wire(r#""side":"sell","userNotional":"100""#)
    });
    assert_eq!(verdict(port.convert(&sell())), RATE);
    assert_eq!(executes(&f), 0);
}

#[test]
fn probes_a_buy_with_the_published_positive_minimum() {
    let (port, f) = watching(format!("[{SPOT}]"), |_| {
        quote_wire(r#""userNotional":"100""#)
    });
    assert_eq!(
        verdict(port.convert(&buy())),
        "fill 0.002 cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    );
    assert_eq!(quotes(&f)[0], "0.001");
    assert_eq!(executes(&f), 1);
}

#[test]
fn probes_a_buy_with_0_00000001_only_when_the_market_published_that_minimum() {
    let (port, f) = watching(with_min(r#""0.00000001""#), |_| {
        quote_wire(r#""userNotional":"100""#)
    });
    assert_eq!(
        verdict(port.convert(&buy())),
        "fill 0.002 cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    );
    assert_eq!(quotes(&f)[0], "0.00000001");
}

#[test]
fn buy_execute_requires_the_live_quote_notional_inside_from_amount() {
    for (notional, executed) in [
        (r#""101""#, false),
        (r#""0""#, false),
        (r#""""#, false),
        (r#""   ""#, false),
        (r#""-1""#, false),
        (r#""not-a-notional""#, false),
        (r#""99.5""#, true),
    ] {
        let markets = format!("[{SPOT}]");
        let notional_owned = notional.to_owned();
        let (port, f) = trade_port(Some(50), move |req, n| {
            if req.url.contains("/api/v1/markets") {
                reply(200, &markets)
            } else if req.url.contains("standing.quote") {
                let over = if n == 1 {
                    String::new()
                } else {
                    format!(r#""userNotional":{notional_owned}"#)
                };
                reply(200, &data(&quote_wire(&over)))
            } else {
                reply(200, &data(&execute_wire("")))
            }
        });
        let v = verdict(port.convert(&buy()));
        if executed {
            assert_eq!(v, "fill 0.002 cccccccc-cccc-4ccc-8ccc-cccccccccccc");
            assert_eq!(executes(&f), 1);
        } else {
            assert_eq!(v, RATE, "{notional}");
            assert_eq!(executes(&f), 0, "{notional}");
        }
    }
}

#[test]
fn posts_the_body_bound_service_call_for_svc_bank_with_the_user_and_instruction_in_the_body_and_no_principal()
 {
    let (port, f) = trade_port(Some(50), standing);
    port.convert(&buy()).unwrap();
    let seen = f.seen.lock().unwrap();
    let calls: Vec<&HttpRequest> = seen
        .iter()
        .filter(|r| !r.url.contains("/api/v1/markets"))
        .collect();
    let paths: Vec<&str> = calls
        .iter()
        .map(|r| r.url.trim_start_matches("http://svc-trade:4004"))
        .collect();
    assert_eq!(
        paths,
        [
            "/trpc/standing.quote",
            "/trpc/standing.quote",
            "/trpc/standing.execute"
        ]
    );
    for c in &calls {
        assert_eq!(c.method, "POST");
        let body = json::parse(c.body.as_deref().unwrap()).unwrap();
        assert_eq!(
            (s(&body, "userId"), s(&body, "instructionId")),
            (
                USER_A.to_owned(),
                "99999999-9999-4999-8999-999999999999".to_owned()
            )
        );
        let header = |k: &str| {
            c.headers
                .iter()
                .find(|(h, _)| h == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(header("x-intafaced-service").as_deref(), Some("svc-bank"));
        assert!(
            !c.headers
                .iter()
                .any(|(h, _)| h.contains("principal") || h.contains("edge-sig"))
        );
        // The callee's own check of the shared secret, the body bound.
        let incoming = Incoming {
            method: &c.method,
            url: "/trpc/standing.quote",
            headers: &c.headers,
            body: Some(c.body.as_deref().unwrap().as_bytes()),
        };
        assert_eq!(
            s2s_verify::verify_legacy(&incoming, INTERNAL, BodyBind::Require, system_seconds())
                .ok()
                .as_deref(),
            Some("svc-bank")
        );
    }
    let exec = json::parse(calls[2].body.as_deref().unwrap()).unwrap();
    assert_eq!(
        (
            s(&exec, "quoteId"),
            s(&exec, "symbol"),
            s(&exec, "side"),
            s(&exec, "clientConvertId")
        ),
        (
            "q-1".to_owned(),
            "BTC/USDT".to_owned(),
            "buy".to_owned(),
            "dca-l154-buy".to_owned()
        )
    );
}

#[test]
fn refuses_a_trade_door_that_is_off_trade_standing_instruction_disabled_as_rate_unset() {
    let (port, _) = trade_port(Some(50), |req, _| {
        if req.url.contains("/api/v1/markets") {
            reply(200, &format!("[{SPOT}]"))
        } else {
            reply(
                403,
                r#"{"error":{"message":"off","data":{"intafacedCode":"trade.standing_instruction_disabled"}}}"#,
            )
        }
    });
    assert_eq!(verdict(port.convert(&buy())), RATE);
}

// trade-convert-port-keys.test.ts

#[test]
fn without_a_signing_key_the_call_is_signed_with_the_shared_secret_as_before() {
    let (port, f) = trade_port(Some(50), standing);
    let mut ask = buy();
    ask.user_id = "u-1";
    ask.instruction_id = "i-1";
    ask.client_convert_id = "dca-keys-1";
    port.convert(&ask).unwrap();
    let seen = f.seen.lock().unwrap();
    let first = seen.iter().find(|r| r.method == "POST").unwrap();
    assert!(
        !first
            .headers
            .iter()
            .any(|(h, _)| h.starts_with("x-intafaced-s2s-"))
    );
    let incoming = Incoming {
        method: &first.method,
        url: "/trpc/standing.quote",
        headers: &first.headers,
        body: Some(first.body.as_deref().unwrap().as_bytes()),
    };
    assert_eq!(
        s2s_verify::verify_legacy(&incoming, INTERNAL, BodyBind::Require, system_seconds())
            .ok()
            .as_deref(),
        Some("svc-bank")
    );
}

#[test]
fn the_part_answers_none_for_another_parts_call_and_job() {
    let Some(b) = bank() else { return };
    assert!(
        b.svc(None, |d| auto_invest::job(
            d,
            "/internal/jobs/run-income-sorter",
            &service_kit::schema::Value::Undefined
        ))
        .is_none()
    );
}
