//! Slice `earn` against the Rust door on a real Postgres. Ports the checks of the TypeScript's earn suites
//! (`earn/accrual-state.db`, `auto-renew.db`, `deposit-lost-ack-keeps-claim`, `deposit-retry-id`,
//! `earn-principal-of-ledger.money`, `earn-product`, `earn-receipt-loss`, `interest-history.db`, `rate-history.db`,
//! `resume-definite-refusal-closes-claim`, `staking-pool.db`; the pool totals of `ops/bank-ops.db` and the earn deposit
//! of `ops/asset-pause.db`), each test named after the TypeScript test's words. A TypeScript call through the router is
//! a door call here; a call on `EarnService` is the Rust function it became, given the dependencies the door gives it
//! (`BankDoor::earn_deps`).
//!
//! Not ported, with the reason: the source pins (`earn-unset-rate-pin`, the source halves of `deposit-retry-id` and
//! `earn-product`) read TypeScript files; `pool-floor-blank`, `position-default-pending` and `interest-paid-has-tx`
//! run one migration up and down and touch no code of the slice (the migrations are the crate's own, run by
//! `store_pg`); `accrue-principal` is `stake_principal`'s unit test in `src/earn/mod.rs`.
//!
//! The ledger is a stand-in that books the four earn recipes as svc-ledger does (strict inputs, one key once, no
//! account below zero, `ledger.insufficient_funds` otherwise), and can lose one answer after booking, be unreachable,
//! or fail its balance reads. Identity is a stand-in for the account state and for the operator's approvals, each
//! bound to one action and its fields and consumed once. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
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
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::earn::interest::DAYS_PER_YEAR;
use svc_bank::earn::service::{self, DepositAsk, NewPool};
use svc_bank::earn::{self, Deps, Position, rates};
use svc_bank::errors::Refusal;
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure, TxEntry,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::{self, Rules};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::{
    AccountOf, RecipientState, RecipientStatus, RecipientUnavailable,
};
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-earn-db-edge-secret-long-enough-ok";
const INTERNAL: &str = "a-bank-earn-db-internal-secret-long-enough";
const CUSTOMER: &str = "11111111-1111-4111-8111-111111111111";
const SAVER_B: &str = "22222222-2222-4222-8222-222222222222";
const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
const APPROVER: &str = "88888888-8888-4888-8888-888888888888";
const PAYER: &str = "59999999-9999-4999-8999-999999999999";
const RW: &[&str] = &["bank:read", "bank:write"];
const TREASURY: &[&str] = &["admin:treasury"];
const DAY: i64 = 24 * 60 * 60 * 1000;
const HOUR: i64 = 60 * 60 * 1000;
const TERM_DAYS: i64 = 30;
/// TEST wording only; not an owner value.
const TEST_WORDING: &str = r#"{"slashing":"TEST: a slashing event can reduce what you get back.","ownership":"TEST: the saving stays yours while it is staked."}"#;

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn uuid() -> String {
    random_uuid().unwrap()
}

fn now() -> Instant {
    door::system_now()
}

fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

fn plus(t: Instant, ms: i64) -> Instant {
    Instant(t.0 + ms)
}

/// `midnight(at)`: the start of its UTC day.
fn midnight(t: Instant) -> Instant {
    Instant(t.0.div_euclid(DAY) * DAY)
}

fn day(t: Instant) -> String {
    t.iso()[..10].to_owned()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book, svc-identity's account state and approvals, the directory, the freeze.

/// (owner type, owner, asset, kind, purpose).
type Acct = (String, String, String, String, String);

fn available(user: &str) -> Acct {
    (
        "user".into(),
        user.into(),
        "USDT".into(),
        "available".into(),
        String::new(),
    )
}

fn stake(user: &str, asset: &str, position: &str) -> Acct {
    (
        "user".into(),
        user.into(),
        asset.into(),
        "stake".into(),
        format!("bank:earn:{position}"),
    )
}

fn reserve(pool: &str, asset: &str) -> Acct {
    (
        "module".into(),
        format!("bank:earn:{pool}"),
        asset.into(),
        "available".into(),
        String::new(),
    )
}

/// `houseFees('bank', asset)`: what `earnPoolFund` draws from by default.
fn fees(asset: &str) -> Acct {
    (
        "house".into(),
        "fees:bank".into(),
        asset.into(),
        "fees".into(),
        String::new(),
    )
}

fn acct(a: &LedgerAccount) -> Acct {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
        a.purpose.clone().unwrap_or_default(),
    )
}

fn acct_id(a: &Acct) -> String {
    format!("acct:{}:{}:{}:{}:{}", a.0, a.1, a.2, a.3, a.4)
}

/// How a booked post's answer is lost once.
#[derive(Clone, Copy)]
enum Loss {
    /// A timeout after the commit: nothing named.
    Unknown,
    /// A typed transport error after the commit (`ledger.unavailable`).
    Coded,
}

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    /// (key, recipe, tx), in posting order.
    journal: Vec<(String, String, LedgerTx)>,
    lose_reply: Option<(String, Loss)>,
    /// Every post fails before it reaches the book (`svc-ledger unreachable`).
    down: bool,
    /// Every balance read fails (`ledger down`).
    reads_down: bool,
}

#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

fn field(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

/// svc-ledger's recipe inputs are strict objects: exactly these keys.
fn strict(j: &Json, keys: &[&str]) {
    let Json::Object(f) = j else {
        panic!("not an object: {}", j.compact())
    };
    let got: BTreeSet<&str> = f.iter().map(|(k, _)| k.as_str()).collect();
    let want: BTreeSet<&str> = keys.iter().copied().collect();
    assert_eq!(got, want, "{}", j.compact());
}

fn invalid(message: &str) -> PostFailure {
    PostFailure::Coded {
        code: "ledger.invalid_entry".to_owned(),
        message: message.to_owned(),
        attempts: 1,
    }
}

/// svc-ledger's amount: a positive decimal string.
fn positive(j: &Json, k: &str) -> Result<Amount, PostFailure> {
    let raw = field(j, k);
    let a = parse_amount(&raw).map_err(|e| invalid(&e))?;
    if a <= 0 {
        return Err(invalid(&format!("{k} must be positive, got {raw}")));
    }
    Ok(a)
}

impl Book {
    fn add(&self, a: Acct, amount: &str) {
        *self.0.lock().unwrap().balances.entry(a).or_default() += amt(amount);
    }
    /// `recipes.deposit`: a TEST balance on the person's main USDT.
    fn fund(&self, user: &str, amount: &str) {
        self.add(available(user), amount);
    }
    /// `recipes.feeCharge` into the bank's fee revenue: what a pool reserve is funded from.
    fn fees(&self, amount: &str) {
        self.add(fees("USDT"), amount);
    }
    fn of(&self, a: &Acct) -> Amount {
        self.0.lock().unwrap().balances.get(a).copied().unwrap_or(0)
    }
    /// `userAvailable(user, 'USDT')`, formatted.
    fn main(&self, user: &str) -> String {
        format_amount(self.of(&available(user)))
    }
    /// The posts of one recipe (`ledger.journal().filter(tx => tx.reason === ...)`).
    fn posts(&self, recipe: &str) -> usize {
        self.0
            .lock()
            .unwrap()
            .journal
            .iter()
            .filter(|(_, r, _)| r == recipe)
            .count()
    }
    fn len(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
    fn lose_reply(&self, prefix: &str, how: Loss) {
        self.0.lock().unwrap().lose_reply = Some((prefix.to_owned(), how));
    }
    fn down(&self, down: bool) {
        self.0.lock().unwrap().down = down;
    }
    fn reads_down(&self, down: bool) {
        self.0.lock().unwrap().reads_down = down;
    }
    /// The books close: nothing was made or lost.
    fn total(&self) -> Amount {
        self.0.lock().unwrap().balances.values().sum()
    }
    /// A post of the test's own, as `ledger.post(recipes.earnWithdraw(...))`.
    fn earn_withdraw(&self, position: &str, pool: &str, user: &str, amount: &str) {
        let input = Json::obj([
            ("positionId", Json::str(position)),
            ("poolId", Json::str(pool)),
            ("userId", Json::str(user)),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str(amount)),
        ]);
        self.post_recipe(
            "earnWithdraw",
            &input,
            &format!("bank.earn.withdraw:{position}"),
        )
        .unwrap();
    }
    /// `ledger.post(recipes.earnDeposit(...))`.
    fn earn_deposit(&self, position: &str, pool: &str, user: &str, amount: &str) {
        let input = Json::obj([
            ("positionId", Json::str(position)),
            ("poolId", Json::str(pool)),
            ("userId", Json::str(user)),
            ("assetId", Json::str("USDT")),
            ("amount", Json::str(amount)),
        ]);
        self.post_recipe(
            "earnDeposit",
            &input,
            &format!("bank.earn.deposit:{position}"),
        )
        .unwrap();
    }
}

/// One recipe's legs (from, to, amount) and its key, as `packages/ledger-client/src/recipes/bank.ts` writes them.
/// One leg: (from, to, amount).
type Leg = (Acct, Acct, Amount);

fn legs(recipe: &str, input: &Json) -> Result<(Vec<Leg>, String), PostFailure> {
    Ok(match recipe {
        "earnDeposit" | "earnWithdraw" => {
            strict(
                input,
                &["positionId", "poolId", "userId", "assetId", "amount"],
            );
            let (pos, user, asset) = (
                field(input, "positionId"),
                field(input, "userId"),
                field(input, "assetId"),
            );
            let a = positive(input, "amount")?;
            let mut main = available(&user);
            main.2.clone_from(&asset);
            let pot = stake(&user, &asset, &pos);
            if recipe == "earnDeposit" {
                (vec![(main, pot, a)], format!("bank.earn.deposit:{pos}"))
            } else {
                (vec![(pot, main, a)], format!("bank.earn.withdraw:{pos}"))
            }
        }
        "earnPoolFund" => {
            strict(input, &["poolId", "fundingId", "assetId", "amount"]);
            let (pool, funding, asset) = (
                field(input, "poolId"),
                field(input, "fundingId"),
                field(input, "assetId"),
            );
            let a = positive(input, "amount")?;
            (
                vec![(fees(&asset), reserve(&pool, &asset), a)],
                format!("bank.earn.fund:{pool}:{funding}"),
            )
        }
        "earnInterest" => {
            strict(input, &["poolId", "date", "assetId", "payouts"]);
            let (pool, date, asset) = (
                field(input, "poolId"),
                field(input, "date"),
                field(input, "assetId"),
            );
            if js_date(&format!("{date}T00:00:00.000Z")).map(day) != Some(date.clone()) {
                return Err(invalid(&format!(
                    "Accrual date must be YYYY-MM-DD, got \"{date}\""
                )));
            }
            let Some(Json::Array(payouts)) = input.get("payouts") else {
                panic!("payouts: {}", input.compact())
            };
            if payouts.is_empty() {
                return Err(invalid(
                    "An interest accrual with no recipients is not a transaction",
                ));
            }
            let mut out = Vec::new();
            for p in payouts {
                strict(p, &["userId", "amount"]);
                let mut main = available(&field(p, "userId"));
                main.2.clone_from(&asset);
                out.push((reserve(&pool, &asset), main, positive(p, "amount")?));
            }
            (out, format!("bank.interest:{pool}:{date}"))
        }
        other => panic!("the bank posts no {other} in slice earn"),
    })
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        if self.0.lock().unwrap().reads_down {
            return Err("ledger down".to_owned());
        }
        Ok(self.of(&acct(a)))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        let st = self.0.lock().unwrap();
        if st.reads_down {
            return Err("ledger down".to_owned());
        }
        Ok(st
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
        if st.down {
            return Err(PostFailure::Unknown("svc-ledger unreachable".to_owned()));
        }
        let (legs, want) = legs(recipe, input)?;
        assert_eq!(key, want, "the recipe's own key");
        if let Some((_, _, t)) = st.journal.iter().find(|(k, _, _)| k == key) {
            return Ok(t.clone());
        }
        let mut staged = st.balances.clone();
        for (from, to, a) in &legs {
            *staged.entry(from.clone()).or_default() -= a;
            *staged.entry(to.clone()).or_default() += a;
        }
        if let Some((short, held)) = staged.iter().find(|(_, v)| **v < 0) {
            // The memory ledger's refusal carries no single-attempt stamp: the code alone makes it definite.
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!("Insufficient {}: short {}", short.2, format_amount(-*held)),
                attempts: 2,
            });
        }
        st.balances = staged;
        let mut entries = Vec::new();
        for (from, to, a) in &legs {
            entries.push(TxEntry {
                account_id: acct_id(from),
                asset_id: from.2.clone(),
                direction: "credit".to_owned(),
                amount: *a,
            });
            entries.push(TxEntry {
                account_id: acct_id(to),
                asset_id: to.2.clone(),
                direction: "debit".to_owned(),
                amount: *a,
            });
        }
        let tx = LedgerTx {
            id: format!("tx-{}", st.journal.len() + 1),
            posted_at: now(),
            entries,
        };
        st.journal
            .push((key.to_owned(), recipe.to_owned(), tx.clone()));
        if let Some((prefix, how)) = st.lose_reply.clone()
            && key.starts_with(prefix.as_str())
        {
            st.lose_reply = None;
            return Err(match how {
                Loss::Unknown => {
                    PostFailure::Unknown("receipt lost after ledger commit".to_owned())
                }
                Loss::Coded => PostFailure::Coded {
                    code: "ledger.unavailable".to_owned(),
                    message: "ledger unavailable".to_owned(),
                    attempts: 1,
                },
            });
        }
        Ok(tx)
    }
}

/// `memoryRecipientState()`: every account active unless set; down while `failing`; `unset` is no identity wired.
#[derive(Clone, Default)]
struct Accounts(Arc<Mutex<(BTreeMap<String, RecipientStatus>, bool)>>, bool);

impl Accounts {
    fn unwired() -> Accounts {
        Accounts(Arc::default(), true)
    }
    fn set(&self, user: &str, status: RecipientStatus) {
        self.0.lock().unwrap().0.insert(user.to_owned(), status);
    }
    fn fail(&self, down: bool) {
        self.0.lock().unwrap().1 = down;
    }
}

impl RecipientState for Accounts {
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        if self.1 {
            return Err(RecipientUnavailable {
                message: "identity is not wired".to_owned(),
                unset: true,
            });
        }
        let st = self.0.lock().unwrap();
        if st.1 {
            return Err(RecipientUnavailable {
                message: "identity is down".to_owned(),
                unset: false,
            });
        }
        Ok(Some(AccountOf {
            status: st
                .0
                .get(user_id)
                .copied()
                .unwrap_or(RecipientStatus::Active),
            kyc_tier: "full".to_owned(),
        }))
    }
}

/// `deskApprovals()`: an approval is bound to one action and one set of fields, and is consumed once.
#[derive(Clone, Default)]
struct Desk(Arc<Mutex<DeskState>>);

#[derive(Default)]
struct DeskState {
    issued: BTreeMap<String, (String, String)>,
    used: BTreeSet<String>,
    consumed: usize,
}

fn kv(fields: &[(&str, String)]) -> Vec<(String, String)> {
    fields
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}

impl Desk {
    fn issue(&self, action: &str, fields: &[(String, String)]) -> (String, String) {
        let id = uuid();
        self.0.lock().unwrap().issued.insert(
            id.clone(),
            (action.to_owned(), payload_hash(action, fields)),
        );
        (id, uuid())
    }
    fn consumed(&self) -> usize {
        self.0.lock().unwrap().consumed
    }
}

impl Approvals for Desk {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        _principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let mut st = self.0.lock().unwrap();
        let bound = st.issued.get(input.approval_id).cloned();
        let Some((action, hash)) = bound else {
            return Err(ConsumeError::Refused(
                "approval does not match these terms".to_owned(),
            ));
        };
        if hash != input.payload_hash
            || input.target_id != action
            || st.used.contains(input.approval_id)
        {
            return Err(ConsumeError::Refused(
                "approval does not match these terms".to_owned(),
            ));
        }
        st.used.insert(input.approval_id.to_owned());
        st.consumed += 1;
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
                expires_at: plus(now(), 60_000).iso(),
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
// The door and its wiring

/// What one suite's bank is built with.
struct Owner {
    /// `BANK_EARN_RISK_WORDING_JSON`.
    wording: Option<&'static str>,
    /// `recipients` wired, or no identity at all.
    identity: bool,
    /// `LEDGER_CUSTODY_LAYER`.
    custody: &'static str,
}

/// The TypeScript suites' `createBankServices(sql, ledger, ...)`: the earn service posts straight to the memory ledger,
/// so the custodial layer stands on here; one suite runs the launch decision (off).
fn owner() -> Owner {
    Owner {
        wording: Some(TEST_WORDING),
        identity: true,
        custody: "on",
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    accounts: Accounts,
    desk: Desk,
}

fn door_for(db: &TestDb, b: &Book, accounts: &Accounts, desk: &Desk, o: &Owner) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.recipients = if o.identity {
        Box::new(accounts.clone())
    } else {
        Box::new(Accounts::unwired())
    };
    transfers.approvals = Box::new(desk.clone());
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
        custody_layer: o.custody.to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(b.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("10".to_owned()),
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
    .with_transfers(transfers)
    .with_earn(earn::Settings {
        native_asset_id: "IFC".to_owned(),
        risk_wording: o.wording.map(str::to_owned),
        interest_accrual: true,
    })
}

fn bank_with(o: &Owner) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let accounts = Accounts::default();
    let desk = Desk::default();
    let door = door_for(&db, &ledger, &accounts, &desk, o);
    Some(Bank {
        door,
        db,
        ledger,
        accounts,
        desk,
    })
}

fn bank() -> Option<Bank> {
    bank_with(&owner())
}

impl Bank {
    /// The same database and book under other owner values (`services(riskWording)`, `services(false)`).
    fn rewired(&self, o: &Owner) -> BankDoor {
        door_for(&self.db, &self.ledger, &self.accounts, &self.desk, o)
    }
    fn sql(&self, q: &str) {
        self.db.client().execute(q, &[]).unwrap();
    }
    fn count(&self, q: &str) -> i64 {
        self.db.count(q)
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
    /// The slice's dependencies as the door hands them, at `now` (the system clock when none).
    fn svc<T>(&self, at_: Option<Instant>, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        self.door.earn_deps(at_.unwrap_or_else(now), f)
    }
    /// `bank.earn.createPool`: `minDeposit` 0 when none, as the TypeScript's default.
    fn create(&self, kind: &str, name: &str, apr: i64, term: Option<i64>, min: &str) -> String {
        let id = uuid();
        self.svc(None, |d| {
            service::create_pool(
                d,
                &NewPool {
                    id: id.clone(),
                    asset_id: "USDT".to_owned(),
                    kind: kind.to_owned(),
                    name: name.to_owned(),
                    apr_bps: apr,
                    term_days: term,
                    min_deposit: amt(min),
                    unbonding_days: None,
                },
            )
        })
        .unwrap()
        .id
    }
    /// `bank.earn.fundPool`, its reserve paid from the bank's TEST fee revenue.
    fn fund_reserve(&self, pool: &str, funding: &str, value: &str) {
        self.ledger.fees(value);
        self.svc(None, |d| service::fund_pool(d, pool, funding, amt(value)))
            .unwrap();
    }
    /// `bank.earn.deposit`.
    fn deposit(
        &self,
        pool: &str,
        user: &str,
        amount: &str,
        position: &str,
        at_: Option<Instant>,
    ) -> Result<Position, Refusal> {
        self.svc(at_, |d| {
            service::deposit(
                d,
                &DepositAsk {
                    pool_id: pool,
                    user_id: user,
                    amount: amt(amount),
                    position_id: position,
                },
            )
        })
    }
    fn position(&self, id: &str) -> Position {
        space::with(&self.db.store(), |c| service::position(c, id)).unwrap()
    }
    fn pool(&self, id: &str) -> earn::Pool {
        space::with(&self.db.store(), |c| service::pool(c, id)).unwrap()
    }
    fn withdraw(&self, id: &str, at_: Instant) -> Result<Position, Refusal> {
        self.svc(Some(at_), |d| service::withdraw(d, id, at_, false))
    }
    fn accrue(&self, pool: &str, at_: Instant) -> service::AccrualResult {
        self.svc(None, |d| service::accrue(d, pool, at_, DAYS_PER_YEAR))
            .unwrap()
    }
    fn resume(&self) -> Vec<service::Resumed> {
        self.svc(None, |d| service::resume_pending(d, Some(10.0)))
            .unwrap()
    }
    fn renew(&self, at_: Instant, limit: f64) -> Result<service::RenewalReport, Refusal> {
        self.svc(None, |d| {
            service::renew_due(d, Some(at_), None, Some(limit))
        })
    }
    fn history(
        &self,
        user: &str,
        pool: &str,
        limit: Option<f64>,
        before: Option<&str>,
    ) -> Result<Json, Refusal> {
        space::with(&self.db.store(), |c| {
            service::interest_history(c, user, pool, limit, before)
        })
    }
    /// `bank.earn.setPoolRate`.
    fn set_rate(
        &self,
        pool: &str,
        rate: i64,
        reason: &str,
        approval: &str,
        at_: Option<Instant>,
    ) -> Result<rates::RateSet, Refusal> {
        space::in_tx(&self.db.store(), |tx| {
            rates::set_pool_rate(tx, pool, rate, reason, approval, at_)
        })
    }
    /// A TEST pool's customer balances and reserve: the fixture the accrual suites share.
    fn seeded(&self, pool: &str) {
        for user in [CUSTOMER, SAVER_B, PAYER] {
            self.ledger.fund(user, "2000");
        }
        self.fund_reserve(pool, "seed-1", "100");
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
    /// The tRPC code (`rejects.toMatchObject({ code })`).
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
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
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
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
    };
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-earn-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    send(&b.door, path, &input.compact(), person(user, scopes))
}

/// The bank's own scheduler: an ops job signed as svc-bank.
fn job(b: &Bank, path: &str, input: &Json) -> Answer {
    let body = input.compact();
    let headers = s2s::legacy_headers("svc-bank", INTERNAL, &body, system_seconds()).unwrap();
    send(&b.door, path, &body, headers)
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

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

/// `saver.earn.deposit({ poolId, positionId, amount })`.
fn door_deposit(b: &Bank, user: &str, pool: &str, position: &str, amount: &str) -> Answer {
    call(
        b,
        user,
        RW,
        "earn.deposit",
        &obj(&[
            ("poolId", Json::str(pool)),
            ("positionId", Json::str(position)),
            ("amount", Json::str(amount)),
        ]),
    )
}

/// `saver.earn.positions({ limit: 10, poolId })`.
fn positions(b: &Bank, user: &str, pool: Option<&str>) -> Vec<Json> {
    let mut f = vec![("limit", Json::int(10))];
    if let Some(p) = pool {
        f.push(("poolId", Json::str(p)));
    }
    arr(&call(b, user, RW, "earn.positions", &obj(&f)).ok())
}

fn withdraw_door(b: &Bank, user: &str, position: &str, unbond: Option<bool>) -> Answer {
    let mut f = vec![("positionId", Json::str(position))];
    if let Some(u) = unbond {
        f.push(("unbond", Json::Bool(u)));
    }
    call(b, user, RW, "earn.withdraw", &obj(&f))
}

fn auto_renew(b: &Bank, user: &str, position: &str, on: bool) -> Answer {
    call(
        b,
        user,
        RW,
        "earn.setAutoRenew",
        &obj(&[("positionId", Json::str(position)), ("on", Json::Bool(on))]),
    )
}

// ---- The operator's four-eyes calls ---------------------------------------------------------------------------

/// `CreateEarnPoolInput`, TEST terms only.
#[derive(Clone)]
struct PoolTerms {
    pool_id: String,
    kind: &'static str,
    name: &'static str,
    apr: i64,
    term: Option<i64>,
    min: &'static str,
    unbonding: Option<i64>,
}

/// `flexible()` of the rate suite: 1.5%, a floor of 10.
fn flexible() -> PoolTerms {
    PoolTerms {
        pool_id: uuid(),
        kind: "flexible",
        name: "TEST flexible",
        apr: 150,
        term: None,
        min: "10",
        unbonding: None,
    }
}

/// `staking()`: 36.5%, so 1000 earns exactly 1 a day; seven days to unbond.
fn staking() -> PoolTerms {
    PoolTerms {
        name: "TEST staking",
        apr: 3650,
        unbonding: Some(7),
        ..flexible()
    }
}

/// `createEarnPoolFields`.
fn pool_fields(t: &PoolTerms) -> Vec<(String, String)> {
    let mut f = vec![
        ("poolId", t.pool_id.clone()),
        ("assetId", "USDT".to_owned()),
        ("kind", t.kind.to_owned()),
        ("name", t.name.to_owned()),
        ("aprBps", t.apr.to_string()),
        (
            "termDays",
            t.term.map(|d| d.to_string()).unwrap_or_default(),
        ),
        ("minDeposit", format_amount(amt(t.min))),
    ];
    if let Some(u) = t.unbonding {
        f.push(("unbondingDays", u.to_string()));
    }
    kv(&f)
}

fn with_approval(mut f: Vec<(&str, Json)>, approval: Option<(String, String)>) -> Json {
    if let Some((a, o)) = approval {
        f.push(("approvalId", Json::str(a)));
        f.push(("operationId", Json::str(o)));
    }
    obj(&f)
}

/// `treasury.ops.createEarnPool({ ...input, ...approvals.pool(input) })`.
fn create_door(b: &Bank, t: &PoolTerms) -> Answer {
    let approval = b.desk.issue("bank.ops.createEarnPool", &pool_fields(t));
    let input = with_approval(
        vec![
            ("poolId", Json::str(t.pool_id.clone())),
            ("assetId", Json::str("USDT")),
            ("kind", Json::str(t.kind)),
            ("name", Json::str(t.name)),
            ("aprBps", Json::int(t.apr)),
            ("termDays", t.term.map_or(Json::Null, Json::int)),
            ("minDeposit", Json::str(t.min)),
            ("unbondingDays", t.unbonding.map_or(Json::Null, Json::int)),
        ],
        Some(approval),
    );
    call(b, OPERATOR, TREASURY, "ops.createEarnPool", &input)
}

/// `SetEarnPoolRateInput` and the approval it is sent with: the approval's own terms may differ (`bound`).
fn rate_door(
    b: &Bank,
    pool: &str,
    rate: i64,
    reason: &str,
    bound: Option<i64>,
    scopes: &[&str],
) -> Answer {
    let approval = bound.map(|r| {
        b.desk.issue(
            "bank.ops.setEarnPoolRate",
            &kv(&[
                ("poolId", pool.to_owned()),
                ("rateBps", r.to_string()),
                ("reason", reason.to_owned()),
            ]),
        )
    });
    let input = with_approval(
        vec![
            ("poolId", Json::str(pool)),
            ("rateBps", Json::int(rate)),
            ("reason", Json::str(reason)),
        ],
        approval,
    );
    let user = if scopes == TREASURY {
        OPERATOR
    } else {
        CUSTOMER
    };
    call(b, user, scopes, "ops.setEarnPoolRate", &input)
}

/// `treasury.ops.setEarnPoolStatus({ ...change, ...approvals.status(change) })`.
fn status_door(b: &Bank, pool: &str, status: &str, reason: &str, revision: i64) -> Answer {
    let approval = b.desk.issue(
        "bank.ops.setEarnPoolStatus",
        &kv(&[
            ("poolId", pool.to_owned()),
            ("status", status.to_owned()),
            ("reason", reason.to_owned()),
            ("revision", revision.to_string()),
        ]),
    );
    let input = with_approval(
        vec![
            ("poolId", Json::str(pool)),
            ("status", Json::str(status)),
            ("reason", Json::str(reason)),
            ("revision", Json::int(revision)),
        ],
        Some(approval),
    );
    call(b, OPERATOR, TREASURY, "ops.setEarnPoolStatus", &input)
}

fn close(b: &Bank, pool: &str, revision: i64) -> Answer {
    status_door(b, pool, "closed", "TEST closed to new savings", revision)
}

// ===============================================================================================================
// earn-principal-of-ledger.money.test.ts: principalOf/poolSize gate on the ledger pot

const LEDGER_POSITION: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/// The book holds one funded stake pot of 1000; the active row says `principal`, or there is none.
fn funded(principal: Option<&str>) -> Option<(Bank, String)> {
    let b = bank()?;
    let pool = b.create("flexible", "TEST", 100, None, "0");
    b.ledger.fund(CUSTOMER, "1000");
    b.ledger
        .earn_deposit(LEDGER_POSITION, &pool, CUSTOMER, "1000");
    if let Some(p) = principal {
        b.sql(&format!(
            "INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, status) \
             VALUES ('{LEDGER_POSITION}', '{pool}', '{CUSTOMER}', 'USDT', '{p}', 'active')"
        ));
    }
    Some((b, pool))
}

#[test]
fn principal_of_and_pool_size_return_the_book_when_the_active_row_matches_earn_stake_account() {
    let Some((b, pool)) = funded(Some("1000")) else {
        return;
    };
    b.svc(None, |d| {
        assert_eq!(
            format_amount(service::principal_of(d, CUSTOMER, "USDT").unwrap()),
            "1000"
        );
        assert_eq!(format_amount(service::pool_size(d, &pool).unwrap()), "1000");
    });
}

#[test]
fn principal_of_and_pool_size_refuse_when_the_table_is_inflated() {
    let Some((b, pool)) = funded(Some("1000000")) else {
        return;
    };
    b.svc(None, |d| {
        assert_eq!(
            code(&service::principal_of(d, CUSTOMER, "USDT").unwrap_err()),
            "bank.earn_principal_mismatch"
        );
        assert_eq!(
            code(&service::pool_size(d, &pool).unwrap_err()),
            "bank.earn_principal_mismatch"
        );
    });
}

#[test]
fn principal_of_and_pool_size_refuse_when_the_table_is_deflated_rather_than_reporting_a_silent_short()
 {
    let Some((b, pool)) = funded(Some("1")) else {
        return;
    };
    b.svc(None, |d| {
        assert_eq!(
            code(&service::principal_of(d, CUSTOMER, "USDT").unwrap_err()),
            "bank.earn_principal_mismatch"
        );
        assert_eq!(
            code(&service::pool_size(d, &pool).unwrap_err()),
            "bank.earn_principal_mismatch"
        );
    });
}

#[test]
fn principal_of_and_pool_size_are_zero_when_there_is_no_active_claim_even_if_a_pot_exists() {
    let Some((b, pool)) = funded(None) else {
        return;
    };
    b.svc(None, |d| {
        assert_eq!(
            format_amount(service::principal_of(d, CUSTOMER, "USDT").unwrap()),
            "0"
        );
        assert_eq!(format_amount(service::pool_size(d, &pool).unwrap()), "0");
    });
}

// ===============================================================================================================
// deposit-lost-ack-keeps-claim.test.ts, earn-receipt-loss.test.ts, resume-definite-refusal-closes-claim.test.ts

const NOW: &str = "2026-06-01T12:00:00.000Z";

#[test]
fn a_lost_acknowledgement_keeps_the_claim_and_never_lets_a_changed_amount_become_the_record() {
    let Some(b) = bank() else { return };
    b.ledger.fund(CUSTOMER, "1000");
    let pool = b.create("flexible", "TEST", 100, None, "0");
    let id = uuid();
    b.ledger.lose_reply("bank.earn.deposit:", Loss::Unknown);
    assert!(
        b.deposit(&pool, CUSTOMER, "1000", &id, Some(at(NOW)))
            .is_err()
    );
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.earn_positions WHERE id = '{id}'"
        )),
        1
    );

    b.resume();
    // Refusing the changed amount is acceptable; adopting it is not.
    let _ = b.deposit(&pool, CUSTOMER, "500", &id, Some(at(NOW)));

    assert_eq!(b.ledger.posts("earnDeposit"), 1);
    assert_eq!(format_amount(b.position(&id).principal), "1000");
}

#[test]
fn a_typed_transport_error_after_the_deposit_committed_keeps_the_claim_recovery_activates_it_once()
{
    let Some(b) = bank() else { return };
    b.ledger.fund(CUSTOMER, "1000");
    let pool = b.create("flexible", "TEST", 100, None, "0");
    let id = uuid();
    b.ledger.lose_reply("bank.earn.deposit:", Loss::Coded);
    assert!(
        b.deposit(&pool, CUSTOMER, "1000", &id, Some(at(NOW)))
            .is_err()
    );
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.earn_positions WHERE id = '{id}'"
        )),
        1
    );

    let resumed = b.resume();
    assert_eq!(
        resumed
            .iter()
            .find(|r| r.position_id == id)
            .map(|r| r.outcome),
        Some("completed")
    );
    let p = b.position(&id);
    assert_eq!(
        (p.status.as_str(), format_amount(p.principal).as_str()),
        ("active", "1000")
    );
    assert_eq!(b.ledger.posts("earnDeposit"), 1);
}

#[test]
fn a_lost_reply_on_withdraw_leaves_the_position_open_the_retry_closes_it_with_one_post() {
    let Some(b) = bank() else { return };
    b.ledger.fund(CUSTOMER, "1000");
    let pool = b.create("flexible", "TEST", 100, None, "0");
    let id = uuid();
    b.deposit(&pool, CUSTOMER, "1000", &id, Some(at(NOW)))
        .unwrap();
    b.ledger.lose_reply("bank.earn.withdraw:", Loss::Unknown);
    assert!(b.withdraw(&id, at(NOW)).is_err());
    assert_eq!(b.position(&id).status, "active");

    assert_eq!(b.withdraw(&id, at(NOW)).unwrap().status, "closed");
    assert_eq!(b.ledger.posts("earnWithdraw"), 1);
    assert_eq!(b.ledger.main(CUSTOMER), "1000");
}

/// The claim as `deposit()` leaves it when its reply was lost: pending, nothing posted here.
fn pending_claim(b: &Bank, funded: &str, claimed: &str) -> String {
    b.ledger.fund(CUSTOMER, funded);
    let pool = b.create("flexible", &format!("TEST-{}", uuid()), 100, None, "0");
    let id = uuid();
    b.sql(&format!(
        "INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status) \
         VALUES ('{id}', '{pool}', '{CUSTOMER}', 'USDT', {claimed}::numeric, '{NOW}', NULL, 'pending')"
    ));
    id
}

#[test]
fn resume_pending_closes_the_claim_when_the_ledger_definitely_refuses_and_never_books_it_later() {
    let Some(b) = bank() else { return };
    // Only 100 available: the 1000 deposit is a definite insufficient-funds refusal.
    let id = pending_claim(&b, "100", "1000");
    let first = b.resume();
    assert_eq!(first.len(), 1);
    assert_eq!(
        (first[0].position_id.as_str(), first[0].outcome),
        (id.as_str(), "failed")
    );
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.earn_positions WHERE id = '{id}'"
        )),
        0
    );

    // Funds arrive later. A pass finds nothing: the refused deposit does not book.
    b.ledger.fund(CUSTOMER, "5000");
    assert!(b.resume().is_empty());
    assert_eq!(b.ledger.posts("earnDeposit"), 0);
}

#[test]
fn resume_pending_keeps_the_claim_pending_on_an_unknown_failure_which_may_have_committed() {
    let Some(b) = bank() else { return };
    let id = pending_claim(&b, "1000", "1000");
    b.ledger.down(true);
    let out = b.resume();
    assert_eq!(out.len(), 1);
    assert_eq!(
        (out[0].position_id.as_str(), out[0].outcome),
        (id.as_str(), "failed")
    );
    assert_eq!(
        b.rows(&format!(
            "SELECT status::text FROM bank.earn_positions WHERE id = '{id}'"
        )),
        vec![vec![Some("pending".to_owned())]]
    );

    b.ledger.down(false);
    let again = b.resume();
    assert_eq!(
        (again[0].position_id.as_str(), again[0].outcome),
        (id.as_str(), "completed")
    );
}

/// The launch decision (`LEDGER_CUSTODY_LAYER` off): a customer post refuses before svc-ledger is asked, as
/// `custodyGuardedLedger` does; pool funding is the bank's own money and posts.
#[test]
fn with_the_custodial_layer_off_a_deposit_take_back_and_interest_refuse_before_the_ledger_is_asked()
{
    let Some(b) = bank_with(&Owner {
        custody: "off",
        ..owner()
    }) else {
        return;
    };
    let pool = b.create("flexible", "TEST", 3650, None, "0");
    b.fund_reserve(&pool, "seed-1", "10");
    assert_eq!(
        format_amount(b.svc(None, |d| service::reserve_balance(d, &pool)).unwrap()),
        "10"
    );
    b.ledger.fund(CUSTOMER, "1000");
    let id = uuid();
    let refused = b.deposit(&pool, CUSTOMER, "1000", &id, None).unwrap_err();
    assert_eq!(code(&refused), "bank.no_partner_bank");
    assert_eq!(b.ledger.posts("earnDeposit"), 0);
    // As the TypeScript: the guard's refusal is not the ledger's, so the claim stays for recovery to settle.
    assert_eq!(
        b.rows(&format!(
            "SELECT status::text FROM bank.earn_positions WHERE id = '{id}'"
        )),
        vec![vec![Some("pending".to_owned())]]
    );
    let answer = door_deposit(&b, CUSTOMER, &pool, &uuid(), "10");
    assert_eq!(answer.cause(), "bank.no_partner_bank");

    // An open saving (posted before the switch) can neither be taken back nor paid while the layer is off.
    b.sql(&format!(
        "INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, opened_at, status) \
         VALUES ('{LEDGER_POSITION}', '{pool}', '{CUSTOMER}', 'USDT', 1000, now() - interval '2 days', 'active')"
    ));
    b.ledger
        .earn_deposit(LEDGER_POSITION, &pool, CUSTOMER, "1000");
    assert_eq!(
        code(&b.withdraw(LEDGER_POSITION, now()).unwrap_err()),
        "bank.no_partner_bank"
    );
    let accrued = b.svc(None, |d| service::accrue(d, &pool, now(), DAYS_PER_YEAR));
    assert_eq!(code(&accrued.unwrap_err()), "bank.no_partner_bank");
    assert_eq!(
        (
            b.ledger.posts("earnWithdraw"),
            b.ledger.posts("earnInterest")
        ),
        (0, 0)
    );
    assert_eq!(b.ledger.main(CUSTOMER), "0");
}

// ===============================================================================================================
// deposit-retry-id.test.ts: retry with the same positionId is one stake

fn retry_pool(b: &Bank) -> String {
    let pool = b.create("flexible", "USDT flex", 3650, None, "0");
    b.ledger.fund(CUSTOMER, "5000");
    pool
}

#[test]
fn omit_position_id_refuses_bank_position_id_required_and_posts_nothing() {
    let Some(b) = bank() else { return };
    let pool = retry_pool(&b);
    let r = b.deposit(&pool, CUSTOMER, "1000", "", None).unwrap_err();
    assert_eq!(code(&r), "bank.position_id_required");
    assert_eq!(b.ledger.posts("earnDeposit"), 0);
}

#[test]
fn two_deposits_with_the_same_position_id_one_row_one_ledger_post() {
    let Some(b) = bank() else { return };
    let pool = retry_pool(&b);
    let id = uuid();
    let first = b.deposit(&pool, CUSTOMER, "1000", &id, None).unwrap();
    let retry = b.deposit(&pool, CUSTOMER, "1000", &id, None).unwrap();
    assert_eq!(
        (retry.id.as_str(), first.id.as_str()),
        (id.as_str(), id.as_str())
    );
    assert_eq!(b.ledger.posts("earnDeposit"), 1);
    assert_eq!(
        b.rows(&format!(
            "SELECT id::text FROM bank.earn_positions WHERE pool_id = '{pool}' AND user_id = '{CUSTOMER}'"
        )),
        vec![vec![Some(id)]]
    );
}

#[test]
fn timeout_after_stake_posts_retry_same_position_id_still_one_deposit() {
    let Some(b) = bank() else { return };
    let pool = retry_pool(&b);
    let id = uuid();
    b.ledger.lose_reply("bank.earn.deposit:", Loss::Unknown);
    assert!(b.deposit(&pool, CUSTOMER, "1000", &id, None).is_err());
    assert_eq!(b.ledger.posts("earnDeposit"), 1);
    let retry = b.deposit(&pool, CUSTOMER, "1000", &id, None).unwrap();
    assert_eq!(
        (retry.status.as_str(), retry.id.as_str()),
        ("active", id.as_str())
    );
    assert_eq!(b.ledger.posts("earnDeposit"), 1);
}

#[test]
fn two_caller_position_ids_open_two_positions() {
    let Some(b) = bank() else { return };
    let pool = retry_pool(&b);
    let (x, y) = (uuid(), uuid());
    assert_eq!(b.deposit(&pool, CUSTOMER, "1000", &x, None).unwrap().id, x);
    assert_eq!(b.deposit(&pool, CUSTOMER, "1000", &y, None).unwrap().id, y);
    assert_eq!(b.ledger.posts("earnDeposit"), 2);
}

#[test]
fn http_without_position_id_is_400() {
    let Some(b) = bank() else { return };
    let pool = retry_pool(&b);
    let omitted = call(
        &b,
        CUSTOMER,
        RW,
        "earn.deposit",
        &obj(&[("poolId", Json::str(pool)), ("amount", Json::str("1000"))]),
    );
    assert_eq!(omitted.0, 400, "{}", omitted.1.compact());
    assert_eq!(b.ledger.posts("earnDeposit"), 0);
}

#[test]
fn two_http_posts_with_the_same_position_id_are_one_stake() {
    let Some(b) = bank() else { return };
    let pool = retry_pool(&b);
    let id = uuid();
    let first = door_deposit(&b, CUSTOMER, &pool, &id, "1000").ok();
    let retry = door_deposit(&b, CUSTOMER, &pool, &id, "1000").ok();
    assert_eq!(s(&first, "positionId"), id);
    assert_eq!(s(&retry, "positionId"), id);
    assert_eq!(b.ledger.posts("earnDeposit"), 1);
}

// ===============================================================================================================
// earn-product.test.ts: mounted earn doors

#[test]
fn earn_pools_refuses_unset_page_size_never_invent_50() {
    let Some(b) = bank() else { return };
    let a = call(&b, CUSTOMER, RW, "earn.pools", &obj(&[]));
    assert_eq!(
        (a.trpc().as_str(), a.cause().as_str()),
        ("BAD_REQUEST", "bank.earn_pools_list_limit_unset")
    );
}

#[test]
fn earn_pools_refuses_by_name_when_no_yield_rate_is_configured() {
    let Some(b) = bank() else { return };
    let a = call(
        &b,
        CUSTOMER,
        RW,
        "earn.pools",
        &obj(&[("limit", Json::int(50))]),
    );
    assert_eq!(
        (a.trpc().as_str(), a.cause().as_str()),
        ("PRECONDITION_FAILED", "bank.earn_rate_unset")
    );
    let a = call(
        &b,
        CUSTOMER,
        RW,
        "earn.pools",
        &obj(&[("assetId", Json::str("USDT")), ("limit", Json::int(50))]),
    );
    assert_eq!(
        (a.trpc().as_str(), a.cause().as_str()),
        ("PRECONDITION_FAILED", "bank.earn_rate_unset")
    );
}

#[test]
fn ops_accrue_interest_refuses_by_name_when_no_yield_rate_is_configured() {
    let Some(b) = bank() else { return };
    let a = job(
        &b,
        "ops.accrueInterest",
        &obj(&[("at", Json::str("2026-03-02T23:59:59.999Z"))]),
    );
    assert_eq!(
        (a.trpc().as_str(), a.cause().as_str()),
        ("PRECONDITION_FAILED", "bank.earn_rate_unset")
    );
}

#[test]
fn accrues_only_positions_open_before_the_utc_day_boundary() {
    let Some(b) = bank() else { return };
    let pool = b.create("flexible", "Configured USDT", 3650, None, "0");
    b.fund_reserve(&pool, &format!("fund-{}", uuid()), "100");
    b.ledger.fund(CUSTOMER, "1000");
    b.deposit(
        &pool,
        CUSTOMER,
        "1000",
        &uuid(),
        Some(at("2026-03-02T00:00:00.000Z")),
    )
    .unwrap();
    let total = b.ledger.total();

    let same = job(
        &b,
        "ops.accrueInterest",
        &obj(&[
            ("poolId", Json::str(pool.clone())),
            ("at", Json::str("2026-03-02T23:59:59.999Z")),
        ]),
    )
    .ok();
    let r = &arr(same.get("results").unwrap())[0];
    assert_eq!(
        (
            s(r, "date"),
            s(r, "paid"),
            s(r, "recipients"),
            s(r, "alreadyAccrued")
        ),
        ("2026-03-02".into(), "0".into(), "0".into(), "false".into())
    );
    assert_eq!(b.ledger.main(CUSTOMER), "0");

    let next = job(
        &b,
        "ops.accrueInterest",
        &obj(&[
            ("poolId", Json::str(pool)),
            ("at", Json::str("2026-03-03T00:00:00.000Z")),
        ]),
    )
    .ok();
    let r = &arr(next.get("results").unwrap())[0];
    assert_eq!(
        (
            s(r, "date"),
            s(r, "paid"),
            s(r, "recipients"),
            s(r, "alreadyAccrued")
        ),
        ("2026-03-03".into(), "1".into(), "1".into(), "false".into())
    );
    assert_eq!(b.ledger.main(CUSTOMER), "1");
    // `ledger.reconcile()`: interest moved out of the reserve, nothing was made.
    assert_eq!(b.ledger.total(), total);
}

// ===============================================================================================================
// accrual-state.db.test.ts: earn accrual state (BK-earn-01)

fn accrual_pool(b: &Bank) -> String {
    let pool = b.create("flexible", "TEST accrual", 3650, None, "10");
    b.seeded(&pool);
    pool
}

#[test]
fn a_deposit_under_the_minimum_is_refused_one_at_it_waits_for_its_first_full_utc_day() {
    let Some(b) = bank() else { return };
    let pool = accrual_pool(&b);
    assert_eq!(
        door_deposit(&b, CUSTOMER, &pool, &uuid(), "5").cause(),
        "bank.below_minimum"
    );
    assert!(positions(&b, CUSTOMER, Some(&pool)).is_empty());

    let id = uuid();
    door_deposit(&b, CUSTOMER, &pool, &id, "1000").ok();
    let p = &positions(&b, CUSTOMER, Some(&pool))[0];
    assert_eq!((s(p, "id"), s(p, "accrual")), (id, "waiting".to_owned()));
    // Its first day begins at the UTC midnight after it opened, whatever the clock reads by the time it is checked.
    assert_eq!(
        s(p, "accruesFrom"),
        plus(midnight(at(&s(p, "openedAt"))), DAY).iso()
    );
}

#[test]
fn accrues_once_its_first_day_is_paid_and_that_day_pays_exactly_the_calculators_figure() {
    let Some(b) = bank() else { return };
    let pool = accrual_pool(&b);
    door_deposit(&b, CUSTOMER, &pool, &uuid(), "1000").ok();
    let opened = &positions(&b, CUSTOMER, Some(&pool))[0];
    // The bank's job pays the saving's first day: 1000 at 36.5% is exactly 1.
    let first = at(&s(opened, "accruesFrom"));
    assert_eq!(format_amount(b.accrue(&pool, plus(first, HOUR)).paid), "1");
    assert_eq!(
        s(&positions(&b, CUSTOMER, Some(&pool))[0], "accrual"),
        "accruing"
    );
    let history = call(
        &b,
        CUSTOMER,
        RW,
        "earn.interestHistory",
        &obj(&[("poolId", Json::str(pool)), ("limit", Json::int(10))]),
    )
    .ok();
    let days: Vec<(String, String)> = arr(history.get("days").unwrap())
        .iter()
        .map(|d| (s(d, "date"), s(d, "amount")))
        .collect();
    assert_eq!(days, vec![(day(first), "1".to_owned())]);
}

#[test]
fn a_saving_opened_before_today_began_accrues_by_the_clock_alone() {
    let Some(b) = bank() else { return };
    let pool = accrual_pool(&b);
    let yesterday = plus(now(), -DAY);
    b.deposit(&pool, CUSTOMER, "20", &uuid(), Some(yesterday))
        .unwrap();
    let p = &positions(&b, CUSTOMER, None)[0];
    assert_eq!(
        (s(p, "accrual"), s(p, "accruesFrom")),
        ("accruing".to_owned(), midnight(plus(yesterday, DAY)).iso())
    );
}

#[test]
fn a_day_paid_to_someone_else_or_to_the_same_person_before_this_saving_opened_does_not_start_it() {
    let Some(b) = bank() else { return };
    let pool = accrual_pool(&b);
    let older = uuid();
    door_deposit(&b, CUSTOMER, &pool, &older, "1000").ok();
    door_deposit(&b, SAVER_B, &pool, &uuid(), "1000").ok();
    // Two days ahead is paid to both savers' first savings; this saver opens a second one after that run.
    b.accrue(&pool, plus(now(), 2 * DAY));
    let newer = uuid();
    door_deposit(&b, CUSTOMER, &pool, &newer, "1000").ok();
    let mine: BTreeMap<String, String> = positions(&b, CUSTOMER, Some(&pool))
        .iter()
        .map(|p| (s(p, "id"), s(p, "accrual")))
        .collect();
    assert_eq!(
        mine,
        BTreeMap::from([
            (older, "accruing".to_owned()),
            (newer, "waiting".to_owned())
        ])
    );
    assert_eq!(
        s(&positions(&b, SAVER_B, Some(&pool))[0], "accrual"),
        "accruing"
    );
}

#[test]
fn a_closed_pool_keeps_paying_the_savings_it_holds_and_a_saving_whose_day_rounds_to_nothing_says_so()
 {
    let Some(b) = bank() else { return };
    let pool = accrual_pool(&b);
    let dust = b.create("flexible", "TEST dust", 1, None, "0");
    door_deposit(&b, CUSTOMER, &dust, &uuid(), "0.000000000000000001").ok();
    b.deposit(&pool, CUSTOMER, "20", &uuid(), Some(plus(now(), -DAY)))
        .unwrap();
    let states: Vec<String> = positions(&b, CUSTOMER, Some(&dust))
        .iter()
        .map(|p| s(p, "accrual"))
        .collect();
    assert_eq!(states, vec!["below_unit"]);
    b.sql(&format!(
        "UPDATE bank.earn_pools SET status = 'closed' WHERE id = '{pool}'"
    ));
    let states: Vec<String> = positions(&b, CUSTOMER, Some(&pool))
        .iter()
        .map(|p| s(p, "accrual"))
        .collect();
    assert_eq!(states, vec!["accruing"]);
    // 20 at 36.5% is 0.02 a day, paid by the closed pool to its one saver.
    let r = b.accrue(&pool, now());
    assert_eq!((format_amount(r.paid).as_str(), r.recipients), ("0.02", 1));
}

// ===============================================================================================================
// interest-history.db.test.ts: earn.interestHistory

const OTHER: &str = "52222222-2222-4222-8222-222222222222";
const OPENED: &str = "2026-03-01T09:00:00.000Z";

/// `day(n)`: noon UTC on 1 + n March 2026.
fn march(n: i64) -> Instant {
    plus(at("2026-03-01T12:00:00.000Z"), n * DAY)
}

/// A TEST instant-access pool at 36.5% (0.1% a day, exact), its reserve funded from bank fees.
fn instant_access(b: &Bank) -> String {
    let pool = b.create("flexible", "Instant access TEST", 3650, None, "0");
    b.fund_reserve(&pool, "seed-1", "10000");
    pool
}

fn dates(h: &Json) -> Vec<String> {
    arr(h.get("days").unwrap())
        .iter()
        .map(|d| s(d, "date"))
        .collect()
}

#[test]
fn interest_history_lists_each_paid_day_with_its_rate_and_payout_and_the_days_sum_to_what_the_ledger_paid()
 {
    let Some(b) = bank() else { return };
    let pool = instant_access(&b);
    b.ledger.fund(CUSTOMER, "1000");
    b.ledger.fund(OTHER, "500");
    b.deposit(&pool, CUSTOMER, "1000", &uuid(), Some(at(OPENED)))
        .unwrap();
    b.deposit(&pool, OTHER, "500", &uuid(), Some(at(OPENED)))
        .unwrap();
    assert_eq!(b.ledger.main(CUSTOMER), "0");

    for n in [1, 2, 3] {
        b.accrue(&pool, march(n));
    }
    // A second run of a day pays nothing more and adds no row.
    b.accrue(&pool, march(3));

    let h = b.history(CUSTOMER, &pool, Some(50.0), None).unwrap();
    assert_eq!(dates(&h), vec!["2026-03-04", "2026-03-03", "2026-03-02"]);
    for d in arr(h.get("days").unwrap()) {
        assert_eq!(
            (s(&d, "rateBps"), s(&d, "amount")),
            ("3650".to_owned(), "1".to_owned())
        );
        assert!(matches!(d.get("ledgerTxId"), Some(Json::String(_))));
    }
    assert_eq!(s(&h, "total"), "3");
    assert_eq!(b.ledger.main(CUSTOMER), s(&h, "total"));

    let theirs = b.history(OTHER, &pool, Some(50.0), None).unwrap();
    let amounts: Vec<String> = arr(theirs.get("days").unwrap())
        .iter()
        .map(|d| s(d, "amount"))
        .collect();
    assert_eq!(amounts, vec!["0.5", "0.5", "0.5"]);
    assert_eq!(s(&theirs, "total"), "1.5");

    // A page is a page; the total is every paid day.
    let one = b.history(CUSTOMER, &pool, Some(1.0), None).unwrap();
    assert_eq!(
        (dates(&one), s(&one, "total")),
        (vec!["2026-03-04".to_owned()], "3".to_owned())
    );
    // Older pages go back from the oldest day shown, to nothing.
    let older = b
        .history(CUSTOMER, &pool, Some(2.0), Some("2026-03-04"))
        .unwrap();
    assert_eq!(dates(&older), vec!["2026-03-03", "2026-03-02"]);
    assert!(
        dates(
            &b.history(CUSTOMER, &pool, Some(2.0), Some("2026-03-02"))
                .unwrap()
        )
        .is_empty()
    );
    assert_eq!(s(&h, "unitemisedDays"), "0");
}

#[test]
fn a_day_planned_but_not_yet_posted_is_not_shown_as_paid() {
    let Some(b) = bank() else { return };
    let pool = instant_access(&b);
    b.ledger.fund(CUSTOMER, "1000");
    b.deposit(&pool, CUSTOMER, "1000", &uuid(), Some(at(OPENED)))
        .unwrap();
    b.accrue(&pool, march(1));
    // The run that planned 3 March died before the ledger post.
    b.sql(&format!(
        "INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, planned_payouts) \
         VALUES ('{pool}', '2026-03-03', 3650, 0, 0, '[{{\"userId\":\"{CUSTOMER}\",\"amount\":\"1\"}}]'::jsonb)"
    ));
    let h = b.history(CUSTOMER, &pool, Some(50.0), None).unwrap();
    assert_eq!(
        (dates(&h), s(&h, "total")),
        (vec!["2026-03-02".to_owned()], "1".to_owned())
    );
    assert_eq!(b.ledger.main(CUSTOMER), "1");
}

#[test]
fn a_paid_day_with_no_stored_plan_is_counted_as_not_itemised_never_guessed_into_a_total() {
    let Some(b) = bank() else { return };
    let pool = instant_access(&b);
    b.ledger.fund(CUSTOMER, "1000");
    b.deposit(&pool, CUSTOMER, "1000", &uuid(), Some(at(OPENED)))
        .unwrap();
    b.accrue(&pool, march(1));
    b.sql(&format!(
        "INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, ledger_tx_id) \
         VALUES ('{pool}', '2026-02-01', 3650, 5, 3, 'tx-before-0032')"
    ));
    let h = b.history(CUSTOMER, &pool, Some(50.0), None).unwrap();
    assert_eq!(
        (dates(&h), s(&h, "total"), s(&h, "unitemisedDays")),
        (
            vec!["2026-03-02".to_owned()],
            "1".to_owned(),
            "1".to_owned()
        )
    );
}

#[test]
fn interest_history_refuses_a_blank_page_size_and_an_unknown_pool_and_someone_with_no_position_sees_no_days()
 {
    let Some(b) = bank() else { return };
    let pool = instant_access(&b);
    assert_eq!(
        code(&b.history(CUSTOMER, &pool, None, None).unwrap_err()),
        "bank.earn_interest_list_limit_unset"
    );
    assert_eq!(
        code(&b.history(CUSTOMER, &uuid(), Some(50.0), None).unwrap_err()),
        "bank.pool_not_found"
    );
    let h = b.history(CUSTOMER, &pool, Some(50.0), None).unwrap();
    assert_eq!(h.compact(), r#"{"days":[],"total":"0","unitemisedDays":0}"#);
}

// ===============================================================================================================
// rate-history.db.test.ts: earn rate history (BK-earn-05)

fn rate_history(b: &Bank, pool: &str, limit: Option<i64>) -> Answer {
    let mut f = vec![("poolId", Json::str(pool))];
    if let Some(l) = limit {
        f.push(("limit", Json::int(l)));
    }
    call(b, CUSTOMER, RW, "earn.rateHistory", &obj(&f))
}

fn changes(h: &Json) -> Vec<(String, String)> {
    arr(h.get("changes").unwrap())
        .iter()
        .map(|c| (s(c, "rateBps"), s(c, "reason")))
        .collect()
}

fn pair(rate: &str, reason: &str) -> (String, String) {
    (rate.to_owned(), reason.to_owned())
}

#[test]
fn opening_a_pool_records_its_first_rate_and_the_customer_reads_it_with_the_pools_facts() {
    let Some(b) = bank() else { return };
    let t = flexible();
    let created = create_door(&b, &t).ok();
    assert_eq!(
        (
            s(&created, "poolId"),
            s(&created, "aprBps"),
            s(&created, "termDays"),
            s(&created, "minDeposit"),
            s(&created, "status"),
            s(&created, "approvedBy"),
        ),
        (
            t.pool_id.clone(),
            "150".into(),
            "null".into(),
            "10".into(),
            "open".into(),
            APPROVER.into()
        )
    );
    let h = rate_history(&b, &t.pool_id, Some(10)).ok();
    assert_eq!(
        (s(&h, "currentBps"), s(&h, "earlier")),
        ("150".into(), "false".into())
    );
    assert_eq!(changes(&h), vec![pair("150", "null")]);

    let page = call(
        &b,
        CUSTOMER,
        RW,
        "earn.pool",
        &obj(&[("poolId", Json::str(t.pool_id.clone()))]),
    )
    .ok();
    for (k, v) in [
        ("id", t.pool_id.as_str()),
        ("status", "open"),
        ("payoutEvery", "day"),
        ("compounding", "simple"),
        ("rewardAssetId", "USDT"),
        ("yieldSource", "pool_reserve"),
        ("rateBands", "null"),
        ("commissionBps", "null"),
        ("capacity", "null"),
    ] {
        assert_eq!(s(&page, k), v, "{k}");
    }
    let listed = &arr(&call(
        &b,
        CUSTOMER,
        RW,
        "earn.pools",
        &obj(&[("limit", Json::int(10))]),
    )
    .ok())[0];
    for (k, v) in [
        ("id", t.pool_id.as_str()),
        ("rateBands", "null"),
        ("commissionBps", "null"),
        ("capacity", "null"),
    ] {
        assert_eq!(s(listed, k), v, "{k}");
    }
}

#[test]
fn an_approved_change_moves_the_rate_and_appends_one_record_interest_pays_it_from_the_next_full_day()
 {
    let Some(b) = bank() else { return };
    let t = PoolTerms {
        apr: 3650,
        ..flexible()
    };
    create_door(&b, &t).ok();
    let moved = rate_door(&b, &t.pool_id, 7300, "TEST rate rise", Some(7300), TREASURY).ok();
    assert_eq!(
        (
            s(&moved, "poolId"),
            s(&moved, "rateBps"),
            s(&moved, "previousBps"),
            s(&moved, "approvedBy")
        ),
        (
            t.pool_id.clone(),
            "7300".into(),
            "3650".into(),
            APPROVER.into()
        )
    );
    let h = rate_history(&b, &t.pool_id, Some(10)).ok();
    assert_eq!(s(&h, "currentBps"), "7300");
    assert_eq!(
        changes(&h),
        vec![pair("3650", "null"), pair("7300", "TEST rate rise")]
    );
    let c = arr(h.get("changes").unwrap());
    assert!(at(&s(&c[1], "effectiveAt")).0 > at(&s(&c[0], "effectiveAt")).0);
    assert_eq!(b.pool(&t.pool_id).apr_bps, 7300);

    // 1000 saved since yesterday. Today began before the change, so today pays the old 36.5% (exactly 1); tomorrow is
    // the first full day at 73% (exactly 2). Each day's record names the rate it paid.
    b.ledger.fund(CUSTOMER, "1000");
    b.fund_reserve(&t.pool_id, "seed-1", "100");
    b.deposit(
        &t.pool_id,
        CUSTOMER,
        "1000",
        &uuid(),
        Some(plus(now(), -DAY)),
    )
    .unwrap();
    assert_eq!(format_amount(b.accrue(&t.pool_id, now()).paid), "1");
    assert_eq!(
        format_amount(b.accrue(&t.pool_id, plus(now(), DAY)).paid),
        "2"
    );
    assert_eq!(
        b.rows(&format!(
            "SELECT rate_bps::text FROM bank.interest_accruals WHERE pool_id = '{}' ORDER BY accrual_date",
            t.pool_id
        )),
        vec![vec![Some("3650".to_owned())], vec![Some("7300".to_owned())]]
    );
    assert_eq!(
        format_amount(
            b.svc(None, |d| service::interest_paid(d, &t.pool_id))
                .unwrap()
        ),
        "3"
    );
}

#[test]
fn a_position_shows_the_rate_its_pool_had_recorded_when_it_opened_and_one_pools_positions_read_alone()
 {
    let Some(b) = bank() else { return };
    let t = PoolTerms {
        apr: 3650,
        min: "0",
        ..flexible()
    };
    create_door(&b, &t).ok();
    let other = PoolTerms {
        apr: 100,
        min: "0",
        ..flexible()
    };
    create_door(&b, &other).ok();
    b.ledger.fund(CUSTOMER, "100");
    let first = uuid();
    b.deposit(&t.pool_id, CUSTOMER, "10", &first, None).unwrap();
    rate_door(&b, &t.pool_id, 7300, "TEST rate rise", Some(7300), TREASURY).ok();
    let second = uuid();
    b.deposit(&t.pool_id, CUSTOMER, "10", &second, None)
        .unwrap();
    // Opened before the pool's first record: the bank has no record of the rate then, and says so.
    let early = uuid();
    b.deposit(
        &other.pool_id,
        CUSTOMER,
        "10",
        &early,
        Some(plus(now(), -60_000)),
    )
    .unwrap();

    let mut mine: Vec<(String, String)> = positions(&b, CUSTOMER, Some(&t.pool_id))
        .iter()
        .map(|p| (s(p, "id"), s(p, "rateAtOpenBps")))
        .collect();
    mine.sort();
    let mut want = vec![(first, "3650".to_owned()), (second, "7300".to_owned())];
    want.sort();
    assert_eq!(mine, want);
    let all = positions(&b, CUSTOMER, None);
    assert_eq!(
        all.iter()
            .find(|p| s(p, "id") == early)
            .map(|p| s(p, "rateAtOpenBps")),
        Some("null".to_owned())
    );
    // Someone else's pool filter shows them nothing of this person's.
    let theirs = call(
        &b,
        PAYER,
        &["bank:read"],
        "earn.positions",
        &obj(&[("limit", Json::int(10)), ("poolId", Json::str(t.pool_id))]),
    )
    .ok();
    assert!(arr(&theirs).is_empty());
}

#[test]
fn refuses_a_fixed_pools_change_the_rate_already_in_force_an_unknown_pool_and_spends_no_approval_doing_it()
 {
    let Some(b) = bank() else { return };
    let fixed = PoolTerms {
        kind: "fixed",
        term: Some(30),
        apr: 600,
        ..flexible()
    };
    create_door(&b, &fixed).ok();
    let spent = b.desk.consumed();

    assert_eq!(
        rate_door(&b, &fixed.pool_id, 700, "TEST rise", Some(700), TREASURY).trpc(),
        "CONFLICT"
    );
    let flex = flexible();
    create_door(&b, &flex).ok();
    assert_eq!(
        rate_door(&b, &flex.pool_id, 150, "TEST same", Some(150), TREASURY).trpc(),
        "CONFLICT"
    );
    assert_eq!(
        rate_door(&b, &uuid(), 200, "TEST nobody", Some(200), TREASURY).trpc(),
        "NOT_FOUND"
    );
    assert_eq!(b.desk.consumed(), spent + 1);
    assert_eq!(b.count("SELECT count(*) FROM bank.earn_rate_changes"), 2);
    assert_eq!(b.pool(&fixed.pool_id).apr_bps, 600);
}

#[test]
fn refuses_a_change_with_no_approval_or_one_bound_to_another_rate_and_records_nothing() {
    let Some(b) = bank() else { return };
    let t = flexible();
    create_door(&b, &t).ok();
    assert_ne!(
        rate_door(&b, &t.pool_id, 175, "TEST rise", None, TREASURY).0,
        200
    );
    assert_ne!(
        rate_door(&b, &t.pool_id, 175, "TEST rise", Some(9000), TREASURY).0,
        200
    );
    assert_ne!(
        rate_door(&b, &t.pool_id, 175, "TEST rise", Some(175), RW).0,
        200
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.earn_rate_changes"), 1);
    assert_eq!(b.pool(&t.pool_id).apr_bps, 150);
}

#[test]
fn one_approval_writes_one_record_the_service_replays_the_record_it_already_wrote() {
    let Some(b) = bank() else { return };
    let t = flexible();
    create_door(&b, &t).ok();
    let approval = uuid();
    let first = b
        .set_rate(&t.pool_id, 175, "TEST rise", &approval, None)
        .unwrap();
    let again = b
        .set_rate(&t.pool_id, 175, "TEST rise", &approval, None)
        .unwrap();
    assert_eq!(again, first);
    assert_eq!(first.previous_bps, 150);
    let other = b
        .set_rate(&t.pool_id, 200, "TEST other", &approval, None)
        .unwrap_err();
    assert_eq!(code(&other), "bank.pool_conflict");
    assert_eq!(b.count("SELECT count(*) FROM bank.earn_rate_changes"), 2);
}

#[test]
fn a_retried_create_with_the_same_id_and_terms_is_the_same_pool_other_terms_conflict() {
    let Some(b) = bank() else { return };
    let t = flexible();
    create_door(&b, &t).ok();
    assert_eq!(s(&create_door(&b, &t).ok(), "poolId"), t.pool_id);
    let other = PoolTerms {
        apr: 999,
        ..t.clone()
    };
    assert_eq!(create_door(&b, &other).trpc(), "CONFLICT");
    let bad_term = PoolTerms {
        term: Some(30),
        ..flexible()
    };
    assert_eq!(create_door(&b, &bad_term).trpc(), "BAD_REQUEST");
    assert_eq!(b.count("SELECT count(*) FROM bank.earn_pools"), 1);
    assert_eq!(b.count("SELECT count(*) FROM bank.earn_rate_changes"), 1);
}

fn legacy_pool(b: &Bank, apr: i64) -> String {
    b.rows(&format!(
        "INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps, min_deposit) \
         VALUES ('USDT', 'flexible', 'TEST old', {apr}, 0) RETURNING id::text"
    ))[0][0]
        .clone()
        .unwrap()
}

#[test]
fn a_pool_opened_before_the_table_has_no_history_nothing_is_filled_in() {
    let Some(b) = bank() else { return };
    let legacy = legacy_pool(&b, 400);
    let h = rate_history(&b, &legacy, Some(10)).ok();
    assert_eq!(
        h.compact(),
        format!(r#"{{"poolId":"{legacy}","currentBps":400,"changes":[],"earlier":false}}"#)
    );
    assert_eq!(rate_history(&b, &uuid(), Some(10)).trpc(), "NOT_FOUND");
    assert_eq!(rate_history(&b, &legacy, None).trpc(), "BAD_REQUEST");
}

#[test]
fn a_pre_table_pools_first_change_records_the_rate_it_was_paying_first_so_the_day_of_the_change_still_pays_it()
 {
    let Some(b) = bank() else { return };
    let pool = legacy_pool(&b, 3650);
    b.set_rate(&pool, 7300, "TEST first change", &uuid(), None)
        .unwrap();
    let h = rate_history(&b, &pool, Some(10)).ok();
    assert_eq!(
        changes(&h),
        vec![pair("3650", "null"), pair("7300", "TEST first change")]
    );
    assert_eq!(s(&h, "earlier"), "false");

    b.ledger.fund(CUSTOMER, "1000");
    b.fund_reserve(&pool, "seed-legacy", "100");
    b.deposit(&pool, CUSTOMER, "1000", &uuid(), Some(plus(now(), -DAY)))
        .unwrap();
    // Today began before the change: it pays the 36.5% the pool was paying (exactly 1), not the new 73%.
    assert_eq!(format_amount(b.accrue(&pool, now()).paid), "1");
    assert_eq!(format_amount(b.accrue(&pool, plus(now(), DAY)).paid), "2");
}

#[test]
fn rate_history_pages_back_the_newest_records_oldest_first_and_says_older_ones_exist() {
    let Some(b) = bank() else { return };
    let pool = b.create("flexible", "TEST paged", 100, None, "0");
    for (i, rate) in [110, 120, 130].into_iter().enumerate() {
        let i = i64::try_from(i).unwrap();
        b.set_rate(
            &pool,
            rate,
            &format!("TEST step {i}"),
            &uuid(),
            Some(plus(now(), (i + 1) * 1000)),
        )
        .unwrap();
    }
    let read = |limit: f64| {
        space::with(&b.db.store(), |c| rates::read(c, &pool, Some(limit), None)).unwrap()
    };
    let page = read(2.0);
    assert_eq!(
        page.changes.iter().map(|c| c.rate_bps).collect::<Vec<_>>(),
        vec![120, 130]
    );
    assert!(page.earlier);
    assert!(!read(10.0).earlier);
}

#[test]
fn the_rate_table_is_append_only_an_edit_or_a_delete_raises() {
    let Some(b) = bank() else { return };
    let pool = b.create("flexible", "TEST frozen", 100, None, "0");
    let mut c = b.db.client();
    let edit = c
        .execute(
            &format!("UPDATE bank.earn_rate_changes SET rate_bps = 999 WHERE pool_id = '{pool}'"),
            &[],
        )
        .unwrap_err();
    assert!(format!("{edit:?}").contains("append-only"), "{edit:?}");
    let delete = c
        .execute(
            &format!("DELETE FROM bank.earn_rate_changes WHERE pool_id = '{pool}'"),
            &[],
        )
        .unwrap_err();
    assert!(format!("{delete:?}").contains("append-only"), "{delete:?}");
}

// ===============================================================================================================
// staking-pool.db.test.ts: staking-style earn pool and pool status (BK-earn-04)

/// A staking pool through the four-eyes door, its reserve funded and the customer's TEST balance seeded.
fn open_staking(b: &Bank) -> String {
    let t = staking();
    create_door(b, &t).ok();
    b.ledger.fund(CUSTOMER, "2000");
    b.fund_reserve(&t.pool_id, "seed-1", "100");
    t.pool_id
}

fn pool_view(b: &Bank, pool: &str) -> Json {
    call(
        b,
        CUSTOMER,
        RW,
        "earn.pool",
        &obj(&[("poolId", Json::str(pool))]),
    )
    .ok()
}

fn change(pool: &str, status: &str, previous: &str, revision: i64) -> String {
    format!(
        r#"{{"poolId":"{pool}","status":"{status}","previousStatus":"{previous}","revision":{revision},"approvedBy":"{APPROVER}"}}"#
    )
}

#[test]
fn opens_a_staking_pool_through_the_door_a_fixed_pool_cannot_unbond_and_other_pools_hash_as_before()
{
    let Some(b) = bank() else { return };
    let pool = open_staking(&b);
    let v = pool_view(&b, &pool);
    assert_eq!(
        (
            s(&v, "unbondingDays"),
            s(&v, "status"),
            s(&v, "statusRevision")
        ),
        ("7".into(), "open".into(), "0".into())
    );
    let fixed = PoolTerms {
        kind: "fixed",
        term: Some(30),
        ..staking()
    };
    assert_eq!(create_door(&b, &fixed).cause(), "bank.pool_terms_invalid");
    // Refused before the second person was spent: only the staking pool's approval is used.
    assert_eq!(b.desk.consumed(), 1);
    let plain = PoolTerms {
        unbonding: None,
        ..staking()
    };
    assert!(
        pool_fields(&plain)
            .iter()
            .all(|(k, _)| k != "unbondingDays")
    );
}

#[test]
fn a_closed_pool_refuses_a_deposit_with_bank_pool_closed_and_nothing_changes_the_change_is_recorded_once()
 {
    let Some(b) = bank() else { return };
    let pool = open_staking(&b);
    let held = uuid();
    door_deposit(&b, CUSTOMER, &pool, &held, "100").ok();

    assert_eq!(
        close(&b, &pool, 1).ok().compact(),
        change(&pool, "closed", "open", 1)
    );
    let v = pool_view(&b, &pool);
    assert_eq!(
        (s(&v, "status"), s(&v, "statusRevision")),
        ("closed".into(), "1".into())
    );

    let before = b.ledger.main(CUSTOMER);
    assert_eq!(
        door_deposit(&b, CUSTOMER, &pool, &uuid(), "50").cause(),
        "bank.pool_closed"
    );
    // Re-read after the refusal: still one saving, the main balance untouched.
    let ids: Vec<String> = positions(&b, CUSTOMER, Some(&pool))
        .iter()
        .map(|p| s(p, "id"))
        .collect();
    assert_eq!(ids, vec![held]);
    assert_eq!(b.ledger.main(CUSTOMER), before);

    // Both people are on the record: the proposer and the second person.
    assert_eq!(
        b.rows(&format!(
            "SELECT revision::text, status::text, previous_status::text, requested_by, approved_by \
               FROM bank.earn_pool_status_changes WHERE pool_id = '{pool}'"
        )),
        vec![vec![
            Some("1".to_owned()),
            Some("closed".to_owned()),
            Some("open".to_owned()),
            Some(OPERATOR.to_owned()),
            Some(APPROVER.to_owned()),
        ]]
    );
    // The record is append-only.
    let edit = b
        .db
        .client()
        .execute(
            &format!("UPDATE bank.earn_pool_status_changes SET reason = 'edited' WHERE pool_id = '{pool}'"),
            &[],
        )
        .unwrap_err();
    assert!(format!("{edit:?}").contains("append-only"), "{edit:?}");
}

#[test]
fn an_unchanged_status_and_a_stale_revision_refuse_before_the_second_person_is_spent() {
    let Some(b) = bank() else { return };
    let pool = open_staking(&b);
    close(&b, &pool, 1).ok();
    let spent = b.desk.consumed();
    assert_eq!(close(&b, &pool, 2).cause(), "bank.pool_status_unchanged");
    assert_eq!(
        status_door(&b, &pool, "open", "TEST reopen", 5).cause(),
        "bank.pool_status_stale"
    );
    assert_eq!(b.desk.consumed(), spent);
    let v = pool_view(&b, &pool);
    assert_eq!(
        (s(&v, "status"), s(&v, "statusRevision")),
        ("closed".into(), "1".into())
    );
}

#[test]
fn two_status_changes_sent_at_once_make_one_change_and_spend_one_approval() {
    let Some(b) = bank() else { return };
    let pool = open_staking(&b);
    let spent = b.desk.consumed();
    // The same change twice at once: one is recorded, the other reads it back.
    let same: Vec<Answer> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..2).map(|_| sc.spawn(|| close(&b, &pool, 1))).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(same[0].ok().compact(), change(&pool, "closed", "open", 1));
    assert_eq!(same[1].ok().compact(), same[0].ok().compact());
    assert_eq!(b.desk.consumed(), spent + 1);

    // Two different changes at once for the same next revision: one lands, the other is refused and spends nothing.
    let outcomes: Vec<Answer> = std::thread::scope(|sc| {
        let hs: Vec<_> = ["TEST reopen one", "TEST reopen two"]
            .into_iter()
            .map(|reason| {
                let (b, pool) = (&b, &pool);
                sc.spawn(move || status_door(b, pool, "open", reason, 2))
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut statuses: Vec<u16> = outcomes.iter().map(|a| a.0).collect();
    statuses.sort_unstable();
    assert_eq!(statuses[0], 200);
    assert_ne!(statuses[1], 200);
    let refused = outcomes.iter().find(|a| a.0 != 200).unwrap();
    assert_eq!(refused.cause(), "bank.pool_status_unchanged");
    assert_eq!(b.desk.consumed(), spent + 2);
    assert_eq!(
        b.rows(&format!(
            "SELECT revision::text FROM bank.earn_pool_status_changes WHERE pool_id = '{pool}' ORDER BY revision"
        )),
        vec![vec![Some("1".to_owned())], vec![Some("2".to_owned())]]
    );
}

#[test]
fn a_change_sent_again_after_its_answer_was_lost_reads_back_the_recorded_change_and_spends_no_approval()
 {
    let Some(b) = bank() else { return };
    let pool = open_staking(&b);
    let first = close(&b, &pool, 1).ok();
    let spent = b.desk.consumed();
    assert_eq!(close(&b, &pool, 1).ok(), first);
    assert_eq!(b.desk.consumed(), spent);
    // The same revision with another reason is not the same change.
    assert_eq!(
        status_door(&b, &pool, "closed", "TEST another reason", 1).cause(),
        "bank.pool_status_unchanged"
    );
    assert_eq!(b.desk.consumed(), spent);
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.earn_pool_status_changes WHERE pool_id = '{pool}'"
        )),
        1
    );
}

#[test]
fn a_held_saving_keeps_accruing_in_a_closed_pool_unbonds_once_earns_no_later_day_and_is_released_once()
 {
    let Some(b) = bank() else { return };
    let pool = open_staking(&b);
    let id = uuid();
    b.deposit(&pool, CUSTOMER, "1000", &id, Some(plus(now(), -3 * DAY)))
        .unwrap();
    close(&b, &pool, 1).ok();
    let staked = &positions(&b, CUSTOMER, Some(&pool))[0];
    assert_eq!(
        (
            s(staked, "accrual"),
            s(staked, "staking"),
            s(staked, "unbondsAt"),
            s(staked, "unbondingDays")
        ),
        (
            "accruing".into(),
            "staked".into(),
            "null".into(),
            "7".into()
        )
    );

    // The closed pool pays its first day.
    let first = at(&s(staked, "accruesFrom"));
    let r = b.accrue(&pool, plus(first, HOUR));
    assert_eq!((format_amount(r.paid).as_str(), r.recipients), ("1", 1));

    // A take back without confirming the unbonding refuses; nothing changes.
    let after_interest = b.ledger.main(CUSTOMER);
    assert_eq!(
        withdraw_door(&b, CUSTOMER, &id, None).cause(),
        "bank.unbond_not_confirmed"
    );
    let unchanged = &positions(&b, CUSTOMER, Some(&pool))[0];
    assert_eq!(
        (s(unchanged, "staking"), s(unchanged, "unbondsAt")),
        ("staked".into(), "null".into())
    );

    // Confirmed: unbonding for the pool's 7 days by the bank's clock, no money moved.
    let asked = now();
    let unbonding = withdraw_door(&b, CUSTOMER, &id, Some(true)).ok();
    assert_eq!(
        (
            s(&unbonding, "positionId"),
            s(&unbonding, "principal"),
            s(&unbonding, "status")
        ),
        (id.clone(), "1000".into(), "unbonding".into())
    );
    let unbonds_at = at(&s(&unbonding, "unbondsAt"));
    assert!(unbonds_at.0 - asked.0 >= 7 * DAY);
    assert!(unbonds_at.0 - now().0 <= 7 * DAY);
    assert_eq!(b.ledger.main(CUSTOMER), after_interest);

    // The same request again is the same request; a plain take back waits for the end.
    assert_eq!(withdraw_door(&b, CUSTOMER, &id, Some(true)).ok(), unbonding);
    assert_eq!(
        withdraw_door(&b, CUSTOMER, &id, None).cause(),
        "bank.position_unbonding"
    );
    let waiting = &positions(&b, CUSTOMER, Some(&pool))[0];
    // The day it was asked began staked, so that day is its last payout.
    assert_eq!(
        (
            s(waiting, "accrual"),
            s(waiting, "staking"),
            s(waiting, "unbondsAt"),
            s(waiting, "nextPayoutOn")
        ),
        (
            "unbonding".into(),
            "unbonding".into(),
            s(&unbonding, "unbondsAt"),
            day(asked)
        )
    );

    // The day after it was asked pays it nothing.
    let r = b.accrue(&pool, plus(midnight(asked), DAY + HOUR));
    assert_eq!((r.paid, r.recipients), (0, 0));

    // The release job: nothing before the end by the bank's clock, whatever time a caller names.
    let empty = r#"{"released":[],"skipped":[],"next":null}"#;
    let late = obj(&[
        ("limit", Json::int(10)),
        ("at", Json::str(plus(unbonds_at, DAY).iso())),
    ]);
    assert_eq!(
        job(&b, "ops.releaseUnbondedEarn", &late).ok().compact(),
        empty
    );
    assert_eq!(b.ledger.main(CUSTOMER), after_interest);
    // The unbonding ends (moved back in time, as the bank's clock passing it would).
    b.sql(&format!(
        "UPDATE bank.earn_positions SET unbonding_started_at = unbonding_started_at - interval '7 days 1 minute', \
         unbonds_at = unbonds_at - interval '7 days 1 minute' WHERE id = '{id}'"
    ));
    let ten = obj(&[("limit", Json::int(10))]);
    assert_eq!(
        job(&b, "ops.releaseUnbondedEarn", &ten).ok().compact(),
        format!(
            r#"{{"released":[{{"positionId":"{id}","principal":"1000"}}],"skipped":[],"next":null}}"#
        )
    );
    let released = format_amount(amt(&after_interest) + amt("1000"));
    assert_eq!(b.ledger.main(CUSTOMER), released);
    assert_eq!(
        job(&b, "ops.releaseUnbondedEarn", &ten).ok().compact(),
        empty
    );
    assert_eq!(b.ledger.main(CUSTOMER), released);
    assert!(positions(&b, CUSTOMER, Some(&pool)).is_empty());
}

#[test]
fn a_saving_in_a_pool_without_unbonding_is_taken_back_at_once_with_or_without_the_flag() {
    let Some(b) = bank() else { return };
    open_staking(&b);
    let plain = PoolTerms {
        unbonding: None,
        name: "TEST flexible",
        ..staking()
    };
    create_door(&b, &plain).ok();
    let id = uuid();
    door_deposit(&b, CUSTOMER, &plain.pool_id, &id, "100").ok();
    let p = &positions(&b, CUSTOMER, Some(&plain.pool_id))[0];
    assert_eq!(
        (s(p, "staking"), s(p, "unbondsAt")),
        ("null".into(), "null".into())
    );
    assert_eq!(
        withdraw_door(&b, CUSTOMER, &id, None).ok().compact(),
        format!(r#"{{"positionId":"{id}","principal":"100","status":"closed","unbondsAt":null}}"#)
    );
}

#[test]
fn the_release_job_pages_by_cursor_so_the_savings_at_the_front_never_hold_the_rest_back() {
    let Some(b) = bank() else { return };
    let pool = open_staking(&b);
    let mut ids = [uuid(), uuid()];
    ids.sort();
    for id in &ids {
        door_deposit(&b, CUSTOMER, &pool, id, "100").ok();
        withdraw_door(&b, CUSTOMER, id, Some(true)).ok();
    }
    b.sql(&format!(
        "UPDATE bank.earn_positions SET unbonding_started_at = unbonding_started_at - interval '8 days', \
         unbonds_at = unbonds_at - interval '8 days' WHERE pool_id = '{pool}'"
    ));
    let page = |after: Option<&str>| {
        let mut f = vec![("limit", Json::int(1)), ("poolId", Json::str(pool.clone()))];
        if let Some(a) = after {
            f.push(("after", Json::str(a)));
        }
        job(&b, "ops.releaseUnbondedEarn", &obj(&f)).ok().compact()
    };
    let one = |id: &str| {
        format!(
            r#"{{"released":[{{"positionId":"{id}","principal":"100"}}],"skipped":[],"next":"{id}"}}"#
        )
    };
    assert_eq!(page(None), one(&ids[0]));
    assert_eq!(page(Some(&ids[0])), one(&ids[1]));
    assert_eq!(
        page(Some(&ids[1])),
        r#"{"released":[],"skipped":[],"next":null}"#
    );
}

#[test]
fn the_release_job_refuses_a_blank_batch_size() {
    let Some(b) = bank() else { return };
    assert_eq!(
        job(&b, "ops.releaseUnbondedEarn", &obj(&[])).cause(),
        "bank.earn_release_batch_limit_unset"
    );
}

#[test]
fn the_slashing_wording_is_the_owners_published_it_reads_back_blank_or_out_of_shape_it_refuses() {
    let Some(b) = bank() else { return };
    let read = |door: &BankDoor| send(door, "earn.riskDisclosure", "", person(CUSTOMER, RW));
    assert_eq!(read(&b.door).ok(), json::parse(TEST_WORDING).unwrap());
    for wording in [
        None,
        Some(""),
        Some("   "),
        Some("not json"),
        Some("{}"),
        Some(r#"{"slashing":3,"ownership":"x"}"#),
        Some(r#"{"slashing":"TEST only"}"#),
        Some(r#"{"slashing":"TEST","ownership":"  "}"#),
    ] {
        let door = b.rewired(&Owner { wording, ..owner() });
        assert_eq!(
            read(&door).cause(),
            "bank.earn_risk_wording_unset",
            "{wording:?}"
        );
    }
}

// ===============================================================================================================
// auto-renew.db.test.ts: fixed-term auto-renew and the payout schedule (BK-earn-03)

/// A TEST fixed-term pool and a TEST flexible one, the flexible reserve funded, and TEST balances for both savers.
fn renew_pools(b: &Bank) -> (String, String) {
    let fixed = b.create("fixed", "TEST 30 days", 3650, Some(TERM_DAYS), "10");
    let flexible = b.create("flexible", "TEST flexible", 3650, None, "10");
    b.seeded(&flexible);
    (fixed, flexible)
}

fn fixed_saving(b: &Bank, pool: &str, user: &str, id: Option<&str>) -> (String, Instant) {
    let id = id.map_or_else(uuid, str::to_owned);
    let opened = door_deposit(b, user, pool, &id, "1000").ok();
    (id, at(&s(&opened, "maturesAt")))
}

fn renew_ops(b: &Bank, f: &[(&str, Json)]) -> Answer {
    job(b, "ops.renewEarnTerms", &obj(f))
}

#[test]
fn a_fixed_term_saving_shows_its_lock_date_refuses_an_early_take_back_with_the_date_and_takes_auto_renew()
 {
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let (id, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    let opened = &positions(&b, CUSTOMER, Some(&fixed))[0];
    assert_eq!(
        (
            s(opened, "id"),
            s(opened, "maturesAt"),
            s(opened, "autoRenew"),
            s(opened, "renewals")
        ),
        (id.clone(), matures.iso(), "false".into(), "0".into())
    );
    assert_eq!(matures.0 - at(&s(opened, "openedAt")).0, TERM_DAYS * DAY);
    let early = withdraw_door(&b, CUSTOMER, &id, None);
    assert_eq!(early.cause(), "bank.position_locked");
    assert!(
        early.message().contains(&matures.iso()),
        "{}",
        early.message()
    );
    let want = format!(
        r#"{{"positionId":"{id}","autoRenew":true,"maturesAt":"{}"}}"#,
        matures.iso()
    );
    assert_eq!(auto_renew(&b, CUSTOMER, &id, true).ok().compact(), want);
    // The same choice again changes nothing.
    assert_eq!(auto_renew(&b, CUSTOMER, &id, true).ok().compact(), want);
    let renewing = &positions(&b, CUSTOMER, Some(&fixed))[0];
    assert_eq!(
        (
            s(renewing, "autoRenew"),
            s(renewing, "renewals"),
            s(renewing, "maturesAt")
        ),
        ("true".into(), "0".into(), matures.iso())
    );
}

#[test]
fn refuses_auto_renew_on_a_flexible_saving_on_someone_elses_on_a_closed_pool_and_after_the_term_off_is_always_allowed()
 {
    let Some(b) = bank() else { return };
    let (fixed, flexible) = renew_pools(&b);
    let flexible_id = uuid();
    door_deposit(&b, CUSTOMER, &flexible, &flexible_id, "100").ok();
    assert_eq!(
        auto_renew(&b, CUSTOMER, &flexible_id, true).cause(),
        "bank.auto_renew_fixed_only"
    );
    let (id, _) = fixed_saving(&b, &fixed, CUSTOMER, None);
    assert_eq!(auto_renew(&b, SAVER_B, &id, true).trpc(), "FORBIDDEN");
    b.sql(&format!(
        "UPDATE bank.earn_pools SET status = 'closed' WHERE id = '{fixed}'"
    ));
    assert_eq!(
        auto_renew(&b, CUSTOMER, &id, true).cause(),
        "bank.pool_closed"
    );
    assert_eq!(
        s(&auto_renew(&b, CUSTOMER, &id, false).ok(), "autoRenew"),
        "false"
    );
    b.sql(&format!(
        "UPDATE bank.earn_pools SET status = 'open' WHERE id = '{fixed}'"
    ));
    // A term that is over takes back or saves again; it does not start a new one now.
    b.sql(&format!(
        "UPDATE bank.earn_positions SET opened_at = now() - interval '31 days', matures_at = now() - interval '1 day' \
         WHERE id = '{id}'"
    ));
    assert_eq!(
        auto_renew(&b, CUSTOMER, &id, true).cause(),
        "bank.position_matured"
    );
    assert_eq!(
        b.rows(&format!(
            "SELECT auto_renew::text FROM bank.earn_positions WHERE id = '{id}'"
        )),
        vec![vec![Some("false".to_owned())]]
    );
}

#[test]
fn at_the_terms_end_the_job_starts_one_new_term_of_the_same_length_and_amount_moves_no_money_and_a_second_run_renews_nothing()
 {
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let (id, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    auto_renew(&b, CUSTOMER, &id, true).ok();
    let stake_before = b
        .svc(None, |d| service::staked_of(d, CUSTOMER, "USDT"))
        .unwrap();
    let posts = b.ledger.len();
    let when = plus(matures, 60_000);
    let next = plus(matures, TERM_DAYS * DAY);
    let f = [("limit", Json::int(10)), ("at", Json::str(when.iso()))];
    assert_eq!(
        renew_ops(&b, &f).ok().compact(),
        format!(
            r#"{{"renewed":[{{"positionId":"{id}","terms":[1],"maturesAt":"{}"}}],"skipped":[]}}"#,
            next.iso()
        )
    );
    assert_eq!(
        renew_ops(&b, &f).ok().compact(),
        r#"{"renewed":[],"skipped":[]}"#
    );
    assert_eq!(
        b.rows(&format!(
            "SELECT term::text, {}::text, {}::text, principal::text FROM bank.earn_renewals WHERE position_id = '{id}'",
            earn::ms("previous_matures_at"),
            earn::ms("matures_at")
        )),
        vec![vec![
            Some("1".to_owned()),
            Some(matures.0.to_string()),
            Some(next.0.to_string()),
            Some("1000.000000000000000000".to_owned()),
        ]]
    );
    assert_eq!(b.ledger.len(), posts);
    assert_eq!(
        b.svc(None, |d| service::staked_of(d, CUSTOMER, "USDT"))
            .unwrap(),
        stake_before
    );
    let renewed = &positions(&b, CUSTOMER, Some(&fixed))[0];
    assert_eq!(
        (
            s(renewed, "maturesAt"),
            s(renewed, "renewals"),
            s(renewed, "autoRenew"),
            s(renewed, "principal")
        ),
        (next.iso(), "1".into(), "true".into(), "1000".into())
    );
    // The new term locks it again.
    assert_eq!(
        code(&b.withdraw(&id, when).unwrap_err()),
        "bank.position_locked"
    );
}

#[test]
fn a_run_long_after_the_end_renews_each_ended_term_in_turn_counted_from_the_end_of_the_one_before()
{
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let (id, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    auto_renew(&b, CUSTOMER, &id, true).ok();
    let report = b
        .renew(plus(matures, 2 * TERM_DAYS * DAY + 5 * DAY), 10.0)
        .unwrap();
    assert_eq!(
        report.renewed,
        vec![(id, vec![1, 2, 3], plus(matures, 3 * TERM_DAYS * DAY))]
    );
}

#[test]
fn a_saving_with_auto_renew_off_is_not_renewed_and_can_be_taken_back_once_its_term_ends() {
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let (id, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    auto_renew(&b, CUSTOMER, &id, true).ok();
    auto_renew(&b, CUSTOMER, &id, false).ok();
    let when = plus(matures, 60_000);
    assert_eq!(
        b.renew(when, 10.0).unwrap(),
        service::RenewalReport::default()
    );
    assert_eq!(b.withdraw(&id, when).unwrap().status, "closed");
}

#[test]
fn a_frozen_account_or_an_identity_that_does_not_answer_leaves_the_saving_as_it_was_and_no_identity_refuses_the_job()
 {
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let (id, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    auto_renew(&b, CUSTOMER, &id, true).ok();
    let when = plus(matures, 60_000);
    b.accounts.set(CUSTOMER, RecipientStatus::Frozen);
    assert_eq!(
        b.renew(when, 10.0).unwrap(),
        service::RenewalReport {
            renewed: vec![],
            skipped: vec![(id.clone(), "bank.account_not_active")],
        }
    );
    b.accounts.set(CUSTOMER, RecipientStatus::Active);
    b.accounts.fail(true);
    assert_eq!(
        b.renew(when, 10.0).unwrap().skipped,
        vec![(id.clone(), "bank.recipient_check_unavailable")]
    );
    b.accounts.fail(false);
    let unwired = b.rewired(&Owner {
        identity: false,
        ..owner()
    });
    // The TypeScript suite builds its service with no port at all, and the job throws. The running service never has
    // none: `index.ts` wires `unconfiguredRecipientState()` without `IDENTITY_URL`, as the binary wires `NoIdentity`, and
    // then every saving is skipped with that code, so nobody is relocked.
    let unset = unwired.earn_deps(now(), |d| {
        service::renew_due(d, Some(when), None, Some(10.0))
    });
    assert_eq!(
        unset.unwrap(),
        service::RenewalReport {
            renewed: vec![],
            skipped: vec![(id.clone(), "bank.recipient_check_unset")],
        }
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.earn_renewals"), 0);
    assert_eq!(b.position(&id).matures_at, Some(matures));
    // Taken back after its term, as the reason says it can be.
    assert_eq!(b.withdraw(&id, when).unwrap().status, "closed");
}

#[test]
fn a_pool_closed_to_new_savings_renews_nothing_and_its_saving_can_be_taken_back_once_the_term_ends()
{
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let (id, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    auto_renew(&b, CUSTOMER, &id, true).ok();
    b.sql(&format!(
        "UPDATE bank.earn_pools SET status = 'closed' WHERE id = '{fixed}'"
    ));
    let when = plus(matures, 60_000);
    assert_eq!(
        b.renew(when, 10.0).unwrap(),
        service::RenewalReport::default()
    );
    assert_eq!(b.withdraw(&id, when).unwrap().status, "closed");
}

#[test]
fn a_stake_pot_that_no_longer_holds_the_principal_is_not_relocked_so_its_replay_can_finish() {
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let (id, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    auto_renew(&b, CUSTOMER, &id, true).ok();
    // The take back's ledger post landed and the close did not.
    b.ledger.earn_withdraw(&id, &fixed, CUSTOMER, "1000");
    let when = plus(matures, 60_000);
    assert_eq!(
        b.renew(when, 10.0).unwrap().skipped,
        vec![(id.clone(), "bank.earn_principal_mismatch")]
    );
    // The replay closes it on the same key, once.
    assert_eq!(b.withdraw(&id, when).unwrap().status, "closed");
    assert_eq!(b.ledger.posts("earnWithdraw"), 1);
}

#[test]
fn skipped_savings_do_not_fill_the_run_a_saving_after_them_by_id_still_renews_within_the_limit() {
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    // The frozen account's saving comes first by id, so it is the first one the run meets.
    let (frozen, frozen_matures) = fixed_saving(
        &b,
        &fixed,
        SAVER_B,
        Some("00000000-0000-4000-8000-000000000001"),
    );
    let (mine, mine_matures) = fixed_saving(
        &b,
        &fixed,
        CUSTOMER,
        Some("00000000-0000-4000-8000-000000000002"),
    );
    auto_renew(&b, SAVER_B, &frozen, true).ok();
    auto_renew(&b, CUSTOMER, &mine, true).ok();
    b.accounts.set(SAVER_B, RecipientStatus::Frozen);
    let when = Instant(mine_matures.0.max(frozen_matures.0) + 60_000);
    let report = b.renew(when, 1.0).unwrap();
    assert_eq!(
        report
            .renewed
            .iter()
            .map(|r| r.0.clone())
            .collect::<Vec<_>>(),
        vec![mine]
    );
    assert_eq!(report.skipped, vec![(frozen, "bank.account_not_active")]);
}

#[test]
fn a_blank_batch_size_refuses_and_the_job_renews_only_the_pool_it_is_asked_about() {
    let Some(b) = bank() else { return };
    let (fixed, _) = renew_pools(&b);
    let other = b.create("fixed", "TEST other", 100, Some(10), "1");
    let (mine, matures) = fixed_saving(&b, &fixed, CUSTOMER, None);
    let (theirs, _) = fixed_saving(&b, &other, SAVER_B, None);
    auto_renew(&b, CUSTOMER, &mine, true).ok();
    auto_renew(&b, SAVER_B, &theirs, true).ok();
    let when = Json::str(plus(matures, 60_000).iso());
    assert_eq!(
        renew_ops(&b, &[("at", when.clone())]).cause(),
        "bank.earn_renew_batch_limit_unset"
    );
    let report = renew_ops(
        &b,
        &[
            ("limit", Json::int(10)),
            ("poolId", Json::str(fixed)),
            ("at", when),
        ],
    )
    .ok();
    let renewed: Vec<String> = arr(report.get("renewed").unwrap())
        .iter()
        .map(|r| s(r, "positionId"))
        .collect();
    assert_eq!(renewed, vec![mine]);
}

#[test]
fn the_payout_schedule_is_daily_the_next_payout_is_the_savings_first_day_then_the_day_after_the_last_one_paid_closed_pool_or_not()
 {
    let Some(b) = bank() else { return };
    let (_, flexible) = renew_pools(&b);
    door_deposit(&b, CUSTOMER, &flexible, &uuid(), "1000").ok();
    let opened = &positions(&b, CUSTOMER, Some(&flexible))[0];
    let first = at(&s(opened, "accruesFrom"));
    assert_eq!(s(opened, "nextPayoutOn"), day(first));
    b.accrue(&flexible, plus(first, HOUR));
    // One payout for the day, however often the job runs.
    assert!(b.accrue(&flexible, plus(first, 2 * HOUR)).already_accrued);
    let paid = &positions(&b, CUSTOMER, Some(&flexible))[0];
    assert_eq!(s(paid, "nextPayoutOn"), day(plus(first, DAY)));
    let history = call(
        &b,
        CUSTOMER,
        RW,
        "earn.interestHistory",
        &obj(&[
            ("poolId", Json::str(flexible.clone())),
            ("limit", Json::int(10)),
        ]),
    )
    .ok();
    assert_eq!(arr(history.get("days").unwrap()).len(), 1);
    b.sql(&format!(
        "UPDATE bank.earn_pools SET status = 'closed' WHERE id = '{flexible}'"
    ));
    // A closed pool still pays the savings it holds (BK-earn-04): the schedule keeps its next day.
    assert_eq!(
        s(&positions(&b, CUSTOMER, Some(&flexible))[0], "nextPayoutOn"),
        day(plus(first, DAY))
    );
}

// ===============================================================================================================
// ops/bank-ops.db.test.ts (pool totals) and ops/asset-pause.db.test.ts (the earn deposit)

#[test]
fn reads_pool_totals_from_the_ledger_and_refuses_a_customer() {
    let Some(b) = bank() else { return };
    let pool = b.create("flexible", "Cash", 100, None, "0");
    let (id, closed) = (uuid(), uuid());
    b.sql(&format!(
        "INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, status) \
         VALUES ('{id}', '{pool}', '{CUSTOMER}', 'USDT', '999999', 'active'), \
                ('{closed}', '{pool}', '{CUSTOMER}', 'USDT', '50', 'closed')"
    ));
    b.ledger.fund(CUSTOMER, "10.50");
    b.ledger.earn_deposit(&id, &pool, CUSTOMER, "10.50");

    let totals = call(&b, OPERATOR, &["admin:read"], "ops.poolTotals", &Json::Null).ok();
    assert_eq!(
        Json::Array(arr(totals.get("pools").unwrap())).compact(),
        format!(
            r#"[{{"poolId":"{pool}","assetId":"USDT","amountHeld":"10.5","amountReason":null,"depositorCount":1,"utilisation":null,"utilisationReason":"utilisation_not_recorded"}}]"#
        )
    );
    assert!(!totals.compact().contains(CUSTOMER));

    b.ledger.reads_down(true);
    let failed = call(&b, OPERATOR, &["admin:read"], "ops.poolTotals", &Json::Null).ok();
    let row = &arr(failed.get("pools").unwrap())[0];
    assert_eq!(
        (
            s(row, "amountHeld"),
            s(row, "amountReason"),
            s(row, "depositorCount")
        ),
        ("null".into(), "ledger_unavailable".into(), "1".into())
    );
    b.ledger.reads_down(false);

    assert_eq!(
        call(&b, CUSTOMER, &["bank:read"], "ops.poolTotals", &Json::Null).trpc(),
        "FORBIDDEN"
    );
}

#[test]
fn a_supply_pause_refuses_earn_deposit_a_borrow_only_pause_does_not() {
    let Some(b) = bank() else { return };
    let pool = b.create("flexible", "TEST cash", 100, None, "0");
    b.ledger.fund(CUSTOMER, "10");
    // The desk's pause, as `ops.setAssetPause` writes it (ops-desk's slice).
    b.sql(
        "INSERT INTO bank.asset_pauses (asset_id, borrow_paused, supply_paused, revision, reason, approved_by) \
         VALUES ('USDT', false, true, 1, 'TEST supply pause', 'TEST')",
    );
    assert_eq!(
        door_deposit(&b, CUSTOMER, &pool, &uuid(), "1").trpc(),
        "CONFLICT"
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.earn_positions"), 0);

    b.sql(
        "UPDATE bank.asset_pauses SET borrow_paused = true, supply_paused = false, revision = 2 WHERE asset_id = 'USDT'",
    );
    let opened = door_deposit(&b, CUSTOMER, &pool, &uuid(), "1").ok();
    assert_ne!(s(&opened, "positionId"), "null");
}
