//! What the loans database suites share: a stand-in for svc-ledger that books the loan recipes as the TypeScript's
//! `MemoryLedger` does (one key books once, the same key with another body refuses `ledger.idempotency_conflict`, no
//! account below zero except `treasury`, `ledger.insufficient_funds` otherwise, `ledger.invalid_entry` for a recipe's
//! own refusals), settable marks on the test's clock, a venue, a margin-call sink that records, and the slice's
//! dependencies built from them (`LoanService`'s options in the TypeScript suites) or the door wired with them.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test harness: each suite uses part of it, and a failure is the point"
)]

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
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::loans::model::{self, NewProduct, Product};
use svc_bank::loans::ports::{
    Affiliates, Deps, FeeLeg, MarginCallNotice, MarginCalls, MarketMaker, SaleAsk, Settings, Venue,
    VenueQuote, market_maker,
};
use svc_bank::loans::prices::{FixedPriceSource, MarkQuality, Marks, PriceSource};
use svc_bank::loans::risk::{DEFAULT_LIQUIDATION_POLICY, LiquidationPolicy};
use svc_bank::loans::service::{collateral_account, house_fees, insurance_fund, reserve_account};
use svc_bank::loans::{self, Wiring};
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
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use crate::support::TestDb;

pub const SECRET: &str = "a-bank-loans-db-edge-secret-long-enough-ok";
pub const INTERNAL: &str = "a-bank-loans-db-internal-secret-long-enough";
pub const BORROWER: &str = "11111111-1111-4111-8111-111111111111";
pub const OTHER: &str = "22222222-2222-4222-8222-222222222222";
pub const MM_FUNDER: &str = "33333333-3333-4333-8333-333333333333";
pub const MM_SWEEP: &str = "44444444-4444-4444-8444-444444444444";
pub const INSURANCE_FUNDER: &str = "55555555-5555-4555-8555-555555555555";
pub const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
pub const APPROVER: &str = "88888888-8888-4888-8888-888888888888";
pub const PAYER: &str = "99999999-9999-4999-8999-999999999999";
pub const DAY: i64 = 24 * 60 * 60 * 1000;
pub const HOUR: i64 = 60 * 60 * 1000;

pub fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

pub fn fmt(a: Amount) -> String {
    format_amount(a)
}

pub fn uuid() -> String {
    random_uuid().unwrap()
}

pub fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

pub fn plus(t: Instant, ms: i64) -> Instant {
    Instant(t.0 + ms)
}

/// The refusal's code, or its message when it names none.
pub fn code(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.row.code.to_owned(),
        Refusal::Trpc(t) => t.message.clone(),
        Refusal::Other(m) => m.clone(),
    }
}

pub fn message(r: &Refusal) -> String {
    svc_bank::loans::service::message_of(r)
}

// ---------------------------------------------------------------------------------------------------------------
// svc-ledger's book

/// (owner type, owner, asset, kind, purpose).
pub type Acct = (String, String, String, String, String);

pub fn acct(a: &LedgerAccount) -> Acct {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
        a.purpose.clone().unwrap_or_default(),
    )
}

pub fn acct_id(a: &Acct) -> String {
    format!("acct:{}:{}:{}:{}:{}", a.0, a.1, a.2, a.3, a.4)
}

/// `userAvailable(user, asset)`.
pub fn available(user: &str, asset: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "user",
        owner_id: user.to_owned(),
        asset_id: asset.to_owned(),
        kind: "available",
        purpose: None,
    }
}

fn treasury(asset: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "treasury",
        owner_id: "boundary".to_owned(),
        asset_id: asset.to_owned(),
        kind: "available",
        purpose: None,
    }
}

/// How a booked post's answer is lost once.
#[derive(Clone, Copy, Debug)]
pub enum Loss {
    /// A timeout after the commit: nothing named.
    Unknown,
    /// A typed transport error after the commit (`ledger.unavailable`).
    Coded,
}

/// One booked transaction: its key, recipe, the body it was asked with, and the tx.
#[derive(Clone, Debug)]
pub struct Booked {
    pub key: String,
    pub recipe: String,
    pub input: Json,
    pub tx: LedgerTx,
}

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<Booked>,
    lose_reply: Option<(String, Loss)>,
    /// Refuse the next post whose key starts with this, before it books: (prefix, code, message).
    refuse_next: Option<(String, String, String)>,
    /// Fail the next post whose key starts with this, before it books, with no code: (prefix, message).
    drop_next: Option<(String, String)>,
    /// Every post fails before it reaches the book (`svc-ledger unreachable`).
    down: bool,
    /// Every read fails.
    reads_down: bool,
    /// Every recipe name asked, in order, booked or not.
    asked: Vec<String>,
}

#[derive(Clone, Default)]
pub struct Book(Arc<Mutex<BookState>>);

fn field(j: &Json, k: &str) -> Result<String, PostFailure> {
    match j.get(k) {
        Some(Json::String(v)) if !v.trim().is_empty() => Ok(v.clone()),
        _ => Err(invalid(&format!("{k} must be a non-blank id"))),
    }
}

fn int(j: &Json, k: &str) -> Result<i64, PostFailure> {
    match j.get(k) {
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 0.0 =>
        {
            #[allow(clippy::cast_possible_truncation, reason = "a whole number")]
            Ok(*n as i64)
        }
        other => Err(invalid(&format!(
            "{k} must be a non-negative integer, got {other:?}"
        ))),
    }
}

fn invalid(message: &str) -> PostFailure {
    PostFailure::Coded {
        code: "ledger.invalid_entry".to_owned(),
        message: message.to_owned(),
        attempts: 1,
    }
}

fn money(j: &Json, k: &str) -> Result<Amount, PostFailure> {
    match j.get(k) {
        Some(Json::String(raw)) => parse_amount(raw).map_err(|e| invalid(&e)),
        other => Err(invalid(&format!("{k}: {other:?}"))),
    }
}

fn positive(j: &Json, k: &str) -> Result<Amount, PostFailure> {
    let a = money(j, k)?;
    if a <= 0 {
        return Err(invalid(&format!("{k} must be positive")));
    }
    Ok(a)
}

fn non_negative(j: &Json, k: &str) -> Result<Amount, PostFailure> {
    let a = money(j, k)?;
    if a < 0 {
        return Err(invalid(&format!("{k} cannot be negative")));
    }
    Ok(a)
}

fn account_of(j: &Json) -> Result<Acct, PostFailure> {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => Ok(v.clone()),
        _ => Err(invalid(&format!("account {k}: {}", j.compact()))),
    };
    Ok((
        s("ownerType")?,
        s("ownerId")?,
        s("assetId")?,
        s("kind")?,
        match j.get("purpose") {
            Some(Json::String(p)) => p.clone(),
            _ => String::new(),
        },
    ))
}

/// One entry: (account, debit when true, amount).
type Entry = (Acct, bool, Amount);

fn credit(a: &LedgerAccount, x: Amount) -> Entry {
    (acct(a), false, x)
}

fn debit(a: &LedgerAccount, x: Amount) -> Entry {
    (acct(a), true, x)
}

/// One recipe's entries and key, as `packages/ledger-client/src/recipes/loans.ts` and `deposit` write them. A credit
/// takes from an account, a debit adds to it (the ledger-client's sign for an asset-side account).
fn entries(recipe: &str, i: &Json) -> Result<(Vec<Entry>, String), PostFailure> {
    Ok(match recipe {
        "loanCollateralLock" | "loanCollateralRelease" => {
            let (loan, user, asset) = (
                field(i, "loanId")?,
                field(i, "userId")?,
                field(i, "collateralAssetId")?,
            );
            let a = positive(i, "amount")?;
            let seq = int(i, "sequence")?;
            let pot = collateral_account(&user, &asset, &loan);
            let main = available(&user, &asset);
            if recipe == "loanCollateralLock" {
                (
                    vec![credit(&main, a), debit(&pot, a)],
                    format!("bank.loan.collateral.lock:{loan}:{seq}"),
                )
            } else {
                (
                    vec![credit(&pot, a), debit(&main, a)],
                    format!("bank.loan.collateral.release:{loan}:{seq}"),
                )
            }
        }
        "loanDraw" => {
            let (loan, user, asset) = (
                field(i, "loanId")?,
                field(i, "userId")?,
                field(i, "debtAssetId")?,
            );
            let p = positive(i, "principal")?;
            (
                vec![
                    credit(&reserve_account(&asset), p),
                    debit(&available(&user, &asset), p),
                ],
                format!("bank.loan.draw:{loan}"),
            )
        }
        "loanRepay" => {
            let (loan, user, asset) = (
                field(i, "loanId")?,
                field(i, "userId")?,
                field(i, "debtAssetId")?,
            );
            let p = non_negative(i, "principal")?;
            let interest = non_negative(i, "interest")?;
            let seq = int(i, "sequence")?;
            if p + interest <= 0 {
                return Err(invalid("total repayment must be positive"));
            }
            let mut e = vec![credit(&available(&user, &asset), p + interest)];
            if p > 0 {
                e.push(debit(&reserve_account(&asset), p));
            }
            if interest > 0 {
                e.push(debit(&house_fees(&asset), interest));
            }
            (e, format!("bank.loan.repay:{loan}:{seq}"))
        }
        "loanLiquidate" => {
            let (loan, user, coll, debt) = (
                field(i, "loanId")?,
                field(i, "userId")?,
                field(i, "collateralAssetId")?,
                field(i, "debtAssetId")?,
            );
            let tranche = int(i, "tranche")?;
            let sold = positive(i, "collateralSold")?;
            let proceeds = positive(i, "proceeds")?;
            positive(i, "markPrice")?;
            let principal = non_negative(i, "principalRepaid")?;
            let interest = non_negative(i, "interestRepaid")?;
            let penalty = non_negative(i, "penalty")?;
            let surplus = non_negative(i, "surplusToBorrower")?;
            if coll == debt {
                return Err(invalid("A liquidation sells collateral for the debt asset"));
            }
            if principal + interest + penalty + surplus != proceeds {
                return Err(invalid("Liquidation proceeds must be fully allocated"));
            }
            let buyer = i.get("buyer").cloned().unwrap_or(Json::Null);
            let to = account_of(buyer.get("collateralTo").unwrap_or(&Json::Null))?;
            let from = account_of(buyer.get("proceedsFrom").unwrap_or(&Json::Null))?;
            if to.2 != coll {
                return Err(invalid("Buyer's collateral account is in another asset"));
            }
            if from.2 != debt {
                return Err(invalid("Buyer's payment account is in another asset"));
            }
            let mut e = vec![
                credit(&collateral_account(&user, &coll, &loan), sold),
                (to, true, sold),
                (from, false, proceeds),
            ];
            if principal > 0 {
                e.push(debit(&reserve_account(&debt), principal));
            }
            if interest + penalty > 0 {
                e.push(debit(&house_fees(&debt), interest + penalty));
            }
            if surplus > 0 {
                e.push(debit(&available(&user, &debt), surplus));
            }
            (e, format!("bank.loan.liquidate:{loan}:{tranche}"))
        }
        "loanBadDebt" => {
            let (loan, asset) = (field(i, "loanId")?, field(i, "debtAssetId")?);
            let s = positive(i, "shortfall")?;
            (
                vec![
                    credit(&insurance_fund(&asset), s),
                    debit(&reserve_account(&asset), s),
                ],
                format!("bank.loan.baddebt:{loan}"),
            )
        }
        "loanReserveFund" => {
            let (funding, asset) = (field(i, "fundingId")?, field(i, "debtAssetId")?);
            let a = positive(i, "amount")?;
            let from = match i.get("from") {
                Some(f) => {
                    let f = account_of(f)?;
                    if f.2 != asset {
                        return Err(invalid("A transfer cannot change asset"));
                    }
                    f
                }
                None => acct(&house_fees(&asset)),
            };
            (
                vec![(from, false, a), debit(&reserve_account(&asset), a)],
                format!("bank.loan.reserve.fund:{asset}:{funding}"),
            )
        }
        other => panic!("the bank posts no {other} in slice loans"),
    })
}

/// `balanceAllowed`: no account below zero except a `treasury` boundary.
fn allowed(a: &Acct, next: Amount) -> bool {
    a.0 == "treasury" || next >= 0
}

impl Book {
    /// Books raw entries under a key of the test's own (`ledger.post({ idempotencyKey, entries })`).
    fn book(
        st: &mut BookState,
        key: &str,
        recipe: &str,
        input: &Json,
        entries: &[Entry],
    ) -> Result<LedgerTx, PostFailure> {
        if let Some(prior) = st.journal.iter().find(|b| b.key == key) {
            if prior.input.compact() != input.compact() || prior.recipe != recipe {
                return Err(PostFailure::Coded {
                    code: "ledger.idempotency_conflict".to_owned(),
                    message: format!(
                        "Idempotency key {key} already booked a different movement; a retry must carry the same body"
                    ),
                    attempts: 1,
                });
            }
            return Ok(prior.tx.clone());
        }
        let mut staged = st.balances.clone();
        for (a, is_debit, x) in entries {
            let held = staged.get(a).copied().unwrap_or(0);
            let next = if *is_debit { held + x } else { held - x };
            if !allowed(a, next) {
                // MemoryLedger's InsufficientFundsError: definite by its code.
                return Err(PostFailure::Coded {
                    code: "ledger.insufficient_funds".to_owned(),
                    message: format!(
                        "Insufficient {}: need {}, have {}",
                        a.2,
                        format_amount(*x),
                        format_amount(held.max(0))
                    ),
                    attempts: 2,
                });
            }
            staged.insert(a.clone(), next);
        }
        st.balances = staged;
        let tx = LedgerTx {
            key: key.to_owned(),
            id: uuid(),
            posted_at: door::system_now(),
            entries: entries
                .iter()
                .map(|(a, is_debit, x)| TxEntry {
                    account_id: acct_id(a),
                    asset_id: a.2.clone(),
                    direction: if *is_debit { "debit" } else { "credit" }.to_owned(),
                    amount: *x,
                })
                .collect(),
        };
        st.journal.push(Booked {
            key: key.to_owned(),
            recipe: recipe.to_owned(),
            input: input.clone(),
            tx: tx.clone(),
        });
        Ok(tx)
    }

    /// `recipes.deposit`: a TEST balance on `user`'s `asset`, from the treasury boundary.
    pub fn fund(&self, user: &str, asset: &str, value: &str) {
        let x = amt(value);
        let key = format!("deposit:test:{user}:{asset}:{}", uuid());
        let mut st = self.0.lock().unwrap();
        Book::book(
            &mut st,
            &key,
            "deposit",
            &Json::str(key.clone()),
            &[
                credit(&treasury(asset), x),
                debit(&available(user, asset), x),
            ],
        )
        .unwrap();
    }

    /// A raw seed: `value` from `user`'s available into `to` (`ledger.post({ entries: [credit(user), debit(to)] })`).
    pub fn seed(&self, user: &str, to: &LedgerAccount, value: &str) {
        let x = amt(value);
        let key = format!("seed:{}", uuid());
        let mut st = self.0.lock().unwrap();
        Book::book(
            &mut st,
            &key,
            "seed",
            &Json::str(key.clone()),
            &[credit(&available(user, &to.asset_id), x), debit(to, x)],
        )
        .unwrap();
    }

    /// A raw move of the test's own: `value` out of `from` into `to` (`ledger.post({ entries: [credit(from), debit(to)] })`).
    pub fn shift(&self, from: &LedgerAccount, to: &LedgerAccount, value: &str) {
        let x = amt(value);
        let key = format!("shift:{}", uuid());
        let mut st = self.0.lock().unwrap();
        Book::book(
            &mut st,
            &key,
            "shift",
            &Json::str(key.clone()),
            &[credit(from, x), debit(to, x)],
        )
        .unwrap();
    }

    /// `fund(MM_FUNDER, asset, value)` then the seed into `marketMaker(asset)`: the market maker's cash.
    pub fn seed_market_maker(&self, asset: &str, value: &str) {
        self.fund(MM_SWEEP, asset, value);
        self.seed(MM_SWEEP, &market_maker(asset), value);
    }

    /// `fund(INSURANCE_FUNDER, asset, value)` then the seed into `insuranceFund(asset)`.
    pub fn seed_insurance(&self, asset: &str, value: &str) {
        self.fund(INSURANCE_FUNDER, asset, value);
        self.seed(INSURANCE_FUNDER, &insurance_fund(asset), value);
    }

    /// A recipe post of the test's own (`ledger.post(recipes.loanX(...))`).
    pub fn post(&self, recipe: &str, input: &Json) -> Result<LedgerTx, PostFailure> {
        let (_, key) = entries(recipe, input)?;
        self.post_recipe(recipe, input, &key)
    }

    pub fn of(&self, a: &LedgerAccount) -> Amount {
        self.0
            .lock()
            .unwrap()
            .balances
            .get(&acct(a))
            .copied()
            .unwrap_or(0)
    }

    /// `formatAmount((await ledger.balance(a)).amount)`.
    pub fn bal(&self, a: &LedgerAccount) -> String {
        format_amount(self.of(a))
    }

    pub fn available(&self, user: &str, asset: &str) -> String {
        self.bal(&available(user, asset))
    }

    pub fn reserve(&self, asset: &str) -> String {
        self.bal(&reserve_account(asset))
    }

    pub fn pot(&self, user: &str, asset: &str, loan: &str) -> String {
        self.bal(&collateral_account(user, asset, loan))
    }

    /// Every booked tx, in order (`ledger.journal()`).
    pub fn journal(&self) -> Vec<Booked> {
        self.0.lock().unwrap().journal.clone()
    }

    /// The posts of one recipe.
    pub fn posts(&self, recipe: &str) -> Vec<Booked> {
        self.journal()
            .into_iter()
            .filter(|b| b.recipe == recipe)
            .collect()
    }

    /// Every recipe asked, booked or refused.
    pub fn asked(&self) -> Vec<String> {
        self.0.lock().unwrap().asked.clone()
    }

    pub fn by_key(&self, key: &str) -> Option<Booked> {
        self.journal().into_iter().find(|b| b.key == key)
    }

    pub fn lose_reply(&self, prefix: &str, how: Loss) {
        self.0.lock().unwrap().lose_reply = Some((prefix.to_owned(), how));
    }

    pub fn refuse_next(&self, prefix: &str, code: &str, message: &str) {
        self.0.lock().unwrap().refuse_next =
            Some((prefix.to_owned(), code.to_owned(), message.to_owned()));
    }

    /// The next post whose key starts with `prefix` fails before the ledger commits, naming nothing (a thrown
    /// `Error(message)` in the TypeScript's wrapped `ledger.post`).
    pub fn drop_next(&self, prefix: &str, message: &str) {
        self.0.lock().unwrap().drop_next = Some((prefix.to_owned(), message.to_owned()));
    }

    pub fn down(&self, down: bool) {
        self.0.lock().unwrap().down = down;
    }

    pub fn reads_down(&self, down: bool) {
        self.0.lock().unwrap().reads_down = down;
    }

    /// Each asset's books close: nothing was made or lost outside the treasury boundary.
    pub fn closes(&self) {
        let st = self.0.lock().unwrap();
        let mut by_asset: BTreeMap<&str, Amount> = BTreeMap::new();
        for (a, v) in &st.balances {
            *by_asset.entry(a.2.as_str()).or_default() += v;
        }
        for (asset, total) in by_asset {
            assert_eq!(total, 0, "{asset} does not close");
        }
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        if self.0.lock().unwrap().reads_down {
            return Err("ledger down".to_owned());
        }
        Ok(self.of(a))
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
        let st = self.0.lock().unwrap();
        if st.reads_down {
            return Err("ledger down".to_owned());
        }
        Ok(st
            .journal
            .iter()
            .find(|b| b.tx.id == tx_id)
            .map(|b| b.tx.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        let st = self.0.lock().unwrap();
        if st.reads_down {
            return Err("ledger down".to_owned());
        }
        Ok(st
            .journal
            .iter()
            .find(|b| b.key == key)
            .map(|b| b.tx.clone()))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let mut st = self.0.lock().unwrap();
        st.asked.push(recipe.to_owned());
        if st.down {
            return Err(PostFailure::Unknown("svc-ledger unreachable".to_owned()));
        }
        if let Some((prefix, code, message)) = st.refuse_next.clone()
            && key.starts_with(prefix.as_str())
        {
            st.refuse_next = None;
            return Err(PostFailure::Coded {
                code,
                message,
                attempts: 1,
            });
        }
        if let Some((prefix, message)) = st.drop_next.clone()
            && key.starts_with(prefix.as_str())
        {
            st.drop_next = None;
            return Err(PostFailure::Unknown(message));
        }
        let (entries, want) = entries(recipe, input)?;
        assert_eq!(key, want, "the recipe's own key");
        let tx = Book::book(&mut st, key, recipe, input, &entries)?;
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

// ---------------------------------------------------------------------------------------------------------------
// Marks, the venue, the margin-call sink, the affiliates, the approvals

/// `fixedPriceSource(prices, () => markNow)`: settable prices, stamped at a settable instant.
#[derive(Clone)]
pub struct Prices(Arc<Mutex<PriceState>>);

struct PriceState {
    prices: Vec<(String, String, Option<MarkQuality>)>,
    at: Instant,
    /// The asked asset lists, in order.
    asked: Vec<Vec<String>>,
}

impl Prices {
    pub fn new(at_: Instant) -> Prices {
        Prices(Arc::new(Mutex::new(PriceState {
            prices: Vec::new(),
            at: at_,
            asked: Vec::new(),
        })))
    }
    /// `fixedPriceSource({ BTC: { price, quality: 'mid' } })`, the TypeScript suites' `price(btc)`.
    pub fn btc(&self, price: &str) {
        self.set(&[("BTC", price, None)]);
    }
    pub fn set(&self, prices: &[(&str, &str, Option<MarkQuality>)]) {
        self.0.lock().unwrap().prices = prices
            .iter()
            .map(|(a, p, q)| ((*a).to_owned(), (*p).to_owned(), *q))
            .collect();
    }
    /// No marks at all (`fixedPriceSource({})`).
    pub fn clear(&self) {
        self.0.lock().unwrap().prices.clear();
    }
    /// `markNow = at`.
    pub fn stamp(&self, at_: Instant) {
        self.0.lock().unwrap().at = at_;
    }
    pub fn asked(&self) -> usize {
        self.0.lock().unwrap().asked.len()
    }
}

impl PriceSource for Prices {
    fn marks(&self, asset_ids: &[String], quote_asset_id: &str) -> Marks {
        let (prices, stamp) = {
            let mut st = self.0.lock().unwrap();
            st.asked.push(asset_ids.to_vec());
            (st.prices.clone(), st.at)
        };
        let refs: Vec<(&str, &str, Option<MarkQuality>)> = prices
            .iter()
            .map(|(a, p, q)| (a.as_str(), p.as_str(), *q))
            .collect();
        FixedPriceSource::new(&refs, Box::new(move || stamp))
            .unwrap()
            .marks(asset_ids, quote_asset_id)
    }
}

/// Who buys seized collateral in a suite.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Buyer {
    /// `marketMakerVenue()`.
    MarketMaker,
    /// A venue with no buyer (`quote` answers null).
    Nobody,
    /// A venue whose quote throws.
    Throws,
}

#[derive(Clone)]
pub struct VenueSwitch(Arc<Mutex<(Buyer, usize)>>);

impl VenueSwitch {
    pub fn set(&self, b: Buyer) {
        self.0.lock().unwrap().0 = b;
    }
    pub fn asked(&self) -> usize {
        self.0.lock().unwrap().1
    }
}

impl Venue for VenueSwitch {
    fn quote(&self, ask: &SaleAsk<'_>) -> Result<Option<VenueQuote>, String> {
        let mut st = self.0.lock().unwrap();
        st.1 += 1;
        match st.0 {
            Buyer::MarketMaker => MarketMaker.quote(ask),
            Buyer::Nobody => Ok(None),
            Buyer::Throws => Err("venue down".to_owned()),
        }
    }
}

/// The suites' sink: records every call; fails while `failing`.
#[derive(Clone, Default)]
pub struct Calls(Arc<Mutex<(Vec<MarginCallNotice>, bool)>>);

impl Calls {
    pub fn all(&self) -> Vec<MarginCallNotice> {
        self.0.lock().unwrap().0.clone()
    }
    pub fn len(&self) -> usize {
        self.0.lock().unwrap().0.len()
    }
    pub fn fail(&self, failing: bool) {
        self.0.lock().unwrap().1 = failing;
    }
}

impl MarginCalls for Calls {
    fn send(&self, n: &MarginCallNotice) -> Result<(), String> {
        let mut st = self.0.lock().unwrap();
        if st.1 {
            return Err("sink down".to_owned());
        }
        st.0.push(n.clone());
        Ok(())
    }
}

/// Records what svc-identity's affiliate doors were told.
#[derive(Clone, Default)]
pub struct Told(Arc<Mutex<(Vec<FeeLeg>, Vec<String>)>>);

impl Told {
    pub fn accrued(&self) -> Vec<FeeLeg> {
        self.0.lock().unwrap().0.clone()
    }
    pub fn paid(&self) -> Vec<String> {
        self.0.lock().unwrap().1.clone()
    }
}

impl Affiliates for Told {
    fn accrue(&self, leg: &FeeLeg) -> Result<(), String> {
        self.0.lock().unwrap().0.push(leg.clone());
        Ok(())
    }
    fn payout(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().1.push(id.to_owned());
        Ok(())
    }
}

/// `deskApprovals()`: an approval is bound to one action and one set of fields, and is consumed once.
#[derive(Clone, Default)]
pub struct Desk(Arc<Mutex<DeskState>>);

#[derive(Default)]
struct DeskState {
    issued: BTreeMap<String, (String, String)>,
    used: BTreeSet<String>,
    consumed: usize,
}

impl Desk {
    /// An approval of `action` over these exact fields; answers (approval id, its request id).
    pub fn issue(&self, action: &str, fields: &[(String, String)]) -> String {
        let id = uuid();
        self.0.lock().unwrap().issued.insert(
            id.clone(),
            (action.to_owned(), payload_hash(action, fields)),
        );
        id
    }
    pub fn consumed(&self) -> usize {
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
        let Some((action, hash)) = st.issued.get(input.approval_id).cloned() else {
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
                expires_at: plus(door::system_now(), 60_000).iso(),
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
// The bank

/// One suite's bank: a migrated database, the book, the marks, the venue, the sink, the affiliates, the approvals,
/// and the owner's values (`new LoanService(sql, ledger, { originationFeeBps: '0', ... })` unless a test changes them).
pub struct Kit {
    pub db: TestDb,
    pub store: Store,
    pub ledger: Book,
    pub prices: Prices,
    pub venue: VenueSwitch,
    pub calls: Calls,
    pub told: Told,
    pub desk: Desk,
    pub settings: Settings,
    /// `LEDGER_CUSTODY_LAYER`: the TypeScript suites post straight to the memory ledger, so on.
    pub custody: String,
    /// The test's clock (`now` in the TypeScript suites).
    pub now: Instant,
}

/// The suites' default instant.
pub fn t0() -> Instant {
    at("2026-06-01T12:00:00Z")
}

impl Kit {
    /// A fresh database, migrated by the binary; marks BTC at 10000 stamped `t0`; `originationFeeBps: '0'`.
    pub fn new() -> Option<Kit> {
        let db = TestDb::new()?;
        db.migrated();
        let store = db.store();
        let now = t0();
        let prices = Prices::new(now);
        prices.btc("10000");
        let settings = Settings {
            origination_fee_bps: Some("0".to_owned()),
            ..Settings::default()
        };
        Some(Kit {
            db,
            store,
            ledger: Book::default(),
            prices,
            venue: VenueSwitch(Arc::new(Mutex::new((Buyer::MarketMaker, 0)))),
            calls: Calls::default(),
            told: Told::default(),
            desk: Desk::default(),
            settings,
            custody: "on".to_owned(),
            now,
        })
    }

    /// `f` given the slice's dependencies at `now`.
    pub fn at<T>(&self, now: Instant, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        f(&Deps {
            store: &self.store,
            ledger: &self.ledger,
            custody_layer: &self.custody,
            approvals: &self.desk,
            prices: &self.prices,
            venue: &self.venue,
            margin_calls: &self.calls,
            affiliates: &self.told,
            settings: &self.settings,
            now,
        })
    }

    /// `f` at the kit's clock.
    pub fn d<T>(&self, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        self.at(self.now, f)
    }

    pub fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }

    pub fn count(&self, q: &str) -> i64 {
        self.db.count(q)
    }

    /// Every column of every row, as text.
    pub fn rows(&self, q: &str) -> Vec<Vec<Option<String>>> {
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

    /// One text value.
    pub fn one(&self, q: &str) -> Option<String> {
        self.rows(q)
            .first()
            .and_then(|r| r.first().cloned())
            .flatten()
    }

    /// `fund(user, asset, value)`.
    pub fn fund(&self, user: &str, asset: &str, value: &str) {
        self.ledger.fund(user, asset, value);
    }

    /// `fundReserve(asset, value)`: a payer's deposit, funded through the service from that payer's available, so the
    /// independent funding table records it.
    pub fn fund_reserve(&self, asset: &str, value: &str) {
        self.fund(PAYER, asset, value);
        let from = available(PAYER, asset);
        self.d(|d| {
            loans::service::fund_reserve(
                d,
                asset,
                &format!("f:{}", uuid()),
                amt(value),
                Some(&from),
            )
        })
        .unwrap();
    }

    /// `makeProduct(overrides)`: BTC-backed USDT, 10% APR, 50% max LTV, a 0 floor, the default policy.
    pub fn product_with(&self, f: impl FnOnce(&mut NewProduct)) -> Product {
        let mut p = new_product();
        f(&mut p);
        space::with(&self.store, |c| model::create_product(c, &p)).unwrap()
    }

    pub fn product(&self) -> Product {
        self.product_with(|_| {})
    }

    /// `loans.open({ loanId, productId, userId: BORROWER, collateralAmount, principal })`.
    pub fn open(
        &self,
        product: &str,
        collateral: &str,
        principal: &str,
    ) -> Result<loans::service::Opened, Refusal> {
        self.open_as(BORROWER, &uuid(), product, collateral, principal)
    }

    pub fn open_as(
        &self,
        user: &str,
        loan_id: &str,
        product: &str,
        collateral: &str,
        principal: &str,
    ) -> Result<loans::service::Opened, Refusal> {
        self.d(|d| {
            loans::service::open(
                d,
                &loans::service::OpenAsk {
                    loan_id,
                    product_id: product,
                    user_id: user,
                    collateral_amount: amt(collateral),
                    principal: amt(principal),
                    expected_apr_bps: None,
                },
            )
        })
    }

    /// The common opening: a 100000 USDT reserve, 1 BTC on the borrower, the default product, 1 BTC for 4000 USDT.
    pub fn opened(&self) -> (Product, loans::service::Opened) {
        self.fund_reserve("USDT", "100000");
        self.fund(BORROWER, "BTC", "1");
        let p = self.product();
        let o = self.open(&p.id, "1", "4000").unwrap();
        (p, o)
    }

    /// `sweepAt(at)`: advance the marks with the clock, then sweep 500.
    pub fn sweep_at(&self, at_: Instant) -> Result<loans::sweep::Swept, Refusal> {
        self.prices.stamp(at_);
        self.at(at_, |d| loans::sweep::run_risk_sweep(d, at_, Some(500.0)))
    }

    /// `ageLastAttempt(loanId, seconds)`: the loan's last attempt moved back on the database clock.
    pub fn age_last_attempt(&self, loan_id: &str, seconds: i64) {
        self.sql(&format!(
            "UPDATE bank.loans SET updated_at = now() - ({seconds}::int * interval '1 second') WHERE id = '{loan_id}'"
        ));
    }

    pub fn loan(&self, id: &str) -> loans::model::Loan {
        space::with(&self.store, |c| model::loan(c, id)).unwrap()
    }

    pub fn status(&self, id: &str) -> String {
        self.loan(id).status
    }

    pub fn debt(&self, id: &str) -> loans::model::Debt {
        space::with(&self.store, |c| model::outstanding(c, id)).unwrap()
    }

    /// The door wired with this kit's stand-ins.
    pub fn door(&self) -> BankDoor {
        door_for(self, door::system_now)
    }

    /// The door with its clock held at one instant (the TypeScript's `vi.useFakeTimers({ now })`).
    pub fn door_at(&self, now: fn() -> Instant) -> BankDoor {
        door_for(self, now)
    }
}

/// `makeProduct()`'s defaults.
pub fn new_product() -> NewProduct {
    NewProduct {
        name: "BTC-backed USDT".to_owned(),
        debt_asset_id: "USDT".to_owned(),
        collateral_asset_id: "BTC".to_owned(),
        quote_asset_id: "USDT".to_owned(),
        apr_bps: 1_000,
        max_ltv_bps: 5_000,
        min_principal: Some(0),
        policy: DEFAULT_LIQUIDATION_POLICY,
    }
}

pub fn policy(f: impl FnOnce(&mut LiquidationPolicy)) -> LiquidationPolicy {
    let mut p = DEFAULT_LIQUIDATION_POLICY;
    f(&mut p);
    p
}

// ---------------------------------------------------------------------------------------------------------------
// The door

fn door_for(k: &Kit, now: fn() -> Instant) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.approvals = Box::new(k.desk.clone());
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now,
        store: k.db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: k.custody.clone(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(k.ledger.clone()),
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
    .with_loans(Wiring {
        settings: k.settings.clone(),
        prices: Box::new(k.prices.clone()),
        venue: Box::new(k.venue.clone()),
        affiliates: Box::new(k.told.clone()),
        publish_margin_calls: false,
    })
}

/// A signed principal's headers.
pub fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
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

/// A door's answer: status and body.
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
    pub fn data(&self, k: &str) -> Option<Json> {
        self.1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get(k))
            .cloned()
    }
    /// The tRPC code.
    pub fn trpc(&self) -> String {
        match self.data("code") {
            Some(Json::String(c)) => c,
            _ => "ok".to_owned(),
        }
    }
    /// `cause.code`.
    pub fn cause(&self) -> String {
        match self.data("cause").and_then(|c| c.get("code").cloned()) {
            Some(Json::String(c)) => c,
            _ => panic!("no cause: {} {}", self.0, self.1.compact()),
        }
    }
    pub fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

pub fn send(
    door: &BankDoor,
    path: &str,
    input: &str,
    mut headers: Vec<(String, String)>,
) -> Answer {
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
        "req-loans-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// A person's call through the door.
pub fn call(door: &BankDoor, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    send(door, path, &input.compact(), person(user, scopes))
}

/// The bank's own scheduler: an ops job signed as svc-bank.
pub fn job(door: &BankDoor, path: &str, input: &Json) -> Answer {
    let body = input.compact();
    let headers = s2s::legacy_headers("svc-bank", INTERNAL, &body, system_seconds()).unwrap();
    send(door, path, &body, headers)
}

/// A JSON field as text: a string as itself, null or absent as "null", anything else compact.
pub fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

pub fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(a) => a.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

pub fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}
