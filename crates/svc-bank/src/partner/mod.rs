//! Slice `partner` (`PORT.md`): the TEST partner bank and everything the slice serves from it, as
//! `services/svc-bank/src/partner/` composes it.
//!
//! At launch a person's bank money is held by a partner bank and INTAFACED's ledger posts nothing for it
//! (`docs/adr/2026-11-10-launch-money-model.md`). No partner is named yet, so a dev or test stack stands one in,
//! labelled TEST (`BANK_TEST_PARTNER=test`; refused at boot elsewhere): this module. It holds no money: its book is
//! TEST figures in this process only, and a restart empties it and puts every switch back off.
//!
//! - [`TestPartner`]: the switches (`switches`), the book (one owner of what the partner holds), its moves, payments,
//!   fundings and pay-ins, the purchase and direct-debit desks (`desks`) and the compliance record (`compliance`).
//! - [`custody`]: who holds each person's money, and the guarded partner every move goes through: the operator's
//!   partner stop, then svc-ledger's posting freeze, each refusal counted for the desk.
//! - [`router`]: `testPartner.*` and `convertCash.*` (`cash_leg`); [`record`]: the loopback `/test-partner/*` doors;
//!   [`usage_payment`]: `POST /internal/agents/usage-payment`; [`pay_in`]: the TEST USDC pay-in and its chain poll.
//!
//! Every switch, move and figure is per person, as the TypeScript keeps them. One lock guards the whole book: each
//! operation the TypeScript makes in one synchronous step (a debit, its credit and its record) is one step here too.

pub mod cash_leg;
pub mod compliance;
pub mod custody;
pub mod desks;
pub mod pay_in;
pub mod record;
pub mod router;
pub mod switches;
pub mod usage_payment;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use crate::errors::{BankError, Refusal};
use compliance::Compliance;
use desks::{DirectDebitDesk, PurchaseDesk};
use switches::{Board, Switches};

/// The TEST partner's name on every figure it gives (`TEST_PARTNER_LABEL`).
pub const LABEL: &str = "TEST partner bank";
/// The most moves the book keeps (`MAX_MOVES`); past it a move refuses `bank.partner_unavailable`.
pub const MAX_MOVES: usize = 200_000;
/// How old the TEST partner says its figure may be before it is stale (`TEST_PARTNER_STALE_AFTER_MS`).
pub const STALE_AFTER_MS: i64 = 60_000;
/// The TEST partner's send limit and fee (`TEST_PARTNER_DAILY_SEND`, `TEST_PARTNER_SEND_FEE`). TEST values.
pub const DAILY_SEND: &str = "1000";
pub const SEND_FEE: &str = "0.5";
/// The stand-in merchant a TEST payment goes to (`TEST_PARTNER_MERCHANT`).
pub const MERCHANT: &str = "partner:test-merchant";
/// The TEST partner's statement rules (`TEST_PARTNER_HISTORY_DAYS`, `TEST_PARTNER_SCA_AFTER_DAYS`).
pub const HISTORY_DAYS: i64 = 400;
pub const SCA_AFTER_DAYS: i64 = 90;
/// How long a TEST quote for a move between a person's own accounts stands (`TEST_PARTNER_QUOTE_MS`).
pub const QUOTE_MS: i64 = 60_000;
/// The partner's own accounts (`partner-bank.ts`).
pub const PAYOUTS_OWNER: &str = "partner:outbound-payments";
pub const PAY_INS_OWNER: &str = "partner:incoming-payments";
pub const FEES_OWNER: &str = "partner:fees";
/// The operator's id for the TEST partner in `bank.partner_stops` (`TEST_PARTNER_ID`).
pub const PARTNER_ID: &str = "test-partner";
/// The key prefix of a closure's payout (`CLOSURE_PAYOUT_KEY`): the only move a closing account still makes.
pub const CLOSURE_PAYOUT_KEY: &str = "bank.closure.payout:";
/// `BANK_TEST_PARTNER=test` outside dev or test (`TestPartnerRefusedError`).
pub const REFUSED_OUTSIDE_DEV_TEST: &str = "BANK_TEST_PARTNER=test is the TEST partner bank and ramp: it holds no money and stands in for no real partner; it runs only with APP_ENV exactly dev or test.";

/// One account at the partner (`PartnerAccountRef`): a person's main balance in a currency (`space_id` none) or a
/// space's.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AccountRef {
    pub user_id: String,
    pub asset_id: String,
    pub space_id: Option<String>,
}

impl AccountRef {
    pub fn main(user_id: &str, asset_id: &str) -> AccountRef {
        AccountRef {
            user_id: user_id.to_owned(),
            asset_id: asset_id.to_owned(),
            space_id: None,
        }
    }

    /// `accountKey`.
    pub fn key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.user_id,
            self.asset_id,
            self.space_id.as_deref().unwrap_or("main")
        )
    }
}

/// `partnerPayoutsAccount`.
pub fn payouts_account(asset_id: &str) -> AccountRef {
    AccountRef::main(PAYOUTS_OWNER, asset_id)
}

/// `partnerPayInsAccount`.
pub fn pay_ins_account(asset_id: &str) -> AccountRef {
    AccountRef::main(PAY_INS_OWNER, asset_id)
}

/// `partnerFeesAccount`.
pub fn fees_account(asset_id: &str) -> AccountRef {
    AccountRef::main(FEES_OWNER, asset_id)
}

/// One recipient of a payout (`PartnerPayee`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payee {
    pub name: String,
    pub iban: String,
    pub amount: Amount,
    pub reference: Option<String>,
}

/// What a move asks of the partner (`PartnerMoveRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveRequest {
    pub key: String,
    pub from: AccountRef,
    pub to: AccountRef,
    pub amount: Amount,
    pub payees: Option<Vec<Payee>>,
}

/// One move the partner made, or a pay-in on its record (`PartnerMove`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub id: String,
    pub key: String,
    pub from: AccountRef,
    pub to: AccountRef,
    pub amount: Amount,
    pub moved_at: Instant,
    pub label: &'static str,
    pub payees: Option<Vec<Payee>>,
}

/// A figure the partner gives for one account (`PartnerBalance`). An amount it has not given is `None`: "not known".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balance {
    pub account: AccountRef,
    pub amount: Option<Amount>,
    pub as_of: Option<Instant>,
    pub unavailable: bool,
    pub label: &'static str,
}

/// The partner's statement of one account over `[from, to)` (`PartnerStatement`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub account: AccountRef,
    pub from: Instant,
    pub to: Instant,
    pub opening: Amount,
    pub closing: Amount,
    pub lines: u64,
    pub as_of: Instant,
    pub label: &'static str,
}

/// The partner's send limits (`PartnerSendLimits`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendLimits {
    pub asset_id: String,
    pub daily_send: Amount,
    pub used_today: Amount,
    pub send_fee: Option<Amount>,
    pub as_of: Instant,
    pub label: &'static str,
}

/// The partner's quote for a move between a person's own accounts (`PartnerMoveQuote`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveQuote {
    pub quote_id: String,
    pub from: AccountRef,
    pub to: AccountRef,
    pub amount: Amount,
    pub fee: Option<Amount>,
    pub receives: Option<Amount>,
    pub quoted_at: Instant,
    pub valid_until: Instant,
    pub label: &'static str,
}

/// A payment out over the partner's rails (`PartnerPaymentRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentRequest {
    pub key: String,
    pub from: AccountRef,
    /// `instant` or `ach`.
    pub method: String,
    pub recipient: (String, String, String),
    pub amount: Amount,
}

/// One payment as it stands (`PartnerPayment`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payment {
    pub id: String,
    pub key: String,
    pub from: AccountRef,
    pub method: String,
    pub amount: Amount,
    pub state: &'static str,
    pub version: i64,
    pub previous: Option<&'static str>,
    pub changed_at: Instant,
    pub label: &'static str,
}

/// One open order the partner reports (`PartnerOpenOrder`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenOrder {
    pub id: String,
    pub asset_id: String,
    pub label: &'static str,
}

/// What a moves read asks (`PartnerMovesQuery`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MovesQuery {
    pub limit: usize,
    pub before: Option<String>,
    pub asset_id: Option<String>,
    pub pay_ins: bool,
}

/// One person's page of the partner's own book (`TestPartnerRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub accounts: Vec<(AccountRef, Amount)>,
    pub moves: Vec<Move>,
}

/// A `BankError` with a code `errors.ts` declares. Every code this slice uses is one (`tests` below holds it).
pub fn refuse(code: &str, message: impl Into<String>) -> Refusal {
    let message = message.into();
    match BankError::new(code, message.clone()) {
        Some(e) => Refusal::Bank(e),
        None => Refusal::Other(format!(
            "svc-bank in Rust: {code} is no BankError code: {message}"
        )),
    }
}

/// `partnerDown`.
pub fn partner_down() -> Refusal {
    refuse(
        "bank.partner_unavailable",
        "The partner bank is not answering. Nothing was sent or changed.",
    )
}

/// `moveConflict`.
pub fn move_conflict(key: &str) -> Refusal {
    refuse(
        "bank.partner_move_conflict",
        format!(
            "The partner already holds a different move under {key}, so this one was not made."
        ),
    )
}

fn amount_invalid(message: &str) -> Refusal {
    refuse("bank.partner_amount_invalid", message)
}

/// `bank.partner_balance_not_known` (`partnerBalanceNotKnown`).
pub fn balance_not_known(label: &str) -> Refusal {
    refuse(
        "bank.partner_balance_not_known",
        format!("{label} has not reported this balance, so it is not known."),
    )
}

fn add(a: Amount, b: Amount) -> Result<Amount, Refusal> {
    a.checked_add(b)
        .ok_or_else(|| amount_invalid("A partner figure past what the TEST book holds."))
}

fn sub(a: Amount, b: Amount) -> Result<Amount, Refusal> {
    a.checked_sub(b)
        .ok_or_else(|| amount_invalid("A partner figure past what the TEST book holds."))
}

/// The `TEST_PARTNER_*` values as amounts.
fn fixed(text: &str) -> Amount {
    parse_amount(text).unwrap_or(Amount::ZERO)
}

/// The TEST partner's book (`test-partner-book.ts`): the one owner of what it holds. Every account, every move and
/// every id it gives live here; each desk changes it only through this, so none keeps a second balance.
#[derive(Debug, Default)]
pub struct Book {
    /// Each account it holds, in the order first touched, with what it holds now.
    held: Vec<(AccountRef, Amount)>,
    at: HashMap<String, usize>,
    /// Every instructed move, by its key: one key is one move.
    by_key: HashMap<String, Move>,
    /// Each person's moves and pay-ins, oldest first; a move between two people is on both lists.
    by_person: HashMap<String, Vec<Move>>,
    seq: u64,
    /// Unique to this process: a move reference is never reused after a restart.
    boot: String,
}

impl Book {
    fn new(boot: String) -> Book {
        Book {
            boot,
            ..Book::default()
        }
    }

    /// What an account holds now.
    pub fn amount(&self, account: &AccountRef) -> Amount {
        self.at
            .get(&account.key())
            .and_then(|i| self.held.get(*i))
            .map_or(Amount::ZERO, |(_, a)| *a)
    }

    /// Adds `delta` (negative to take) to an account, in one step.
    pub fn add(&mut self, account: &AccountRef, delta: Amount) -> Result<(), Refusal> {
        let key = account.key();
        match self.at.get(&key).copied() {
            Some(i) => {
                if let Some((_, held)) = self.held.get_mut(i) {
                    *held = add(*held, delta)?;
                }
            }
            None => {
                self.at.insert(key, self.held.len());
                self.held.push((account.clone(), delta));
            }
        }
        Ok(())
    }

    /// A fresh id of this kind, unique to this process (`nextId`).
    pub fn next_id(&mut self, kind: &str) -> String {
        self.seq = self.seq.saturating_add(1);
        format!("test-partner-{kind}-{}-{:012}", self.boot, self.seq)
    }

    /// Puts an entry on one person's record only, never under a move key (`note`).
    pub fn note(&mut self, user_id: &str, entry: Move) {
        self.by_person
            .entry(user_id.to_owned())
            .or_default()
            .push(entry);
    }

    /// Puts an instructed move on the book under its key, and on each of its people's records (`remember`).
    pub fn remember(&mut self, m: Move) {
        self.by_key.insert(m.key.clone(), m.clone());
        if m.from.user_id == m.to.user_id {
            self.note(&m.from.user_id.clone(), m);
        } else {
            self.note(&m.from.user_id.clone(), m.clone());
            self.note(&m.to.user_id.clone(), m);
        }
    }

    /// The move under `key`.
    pub fn by_key(&self, key: &str) -> Option<&Move> {
        self.by_key.get(key)
    }

    /// How many instructed moves the book holds.
    pub fn moves_held(&self) -> usize {
        self.by_key.len()
    }

    /// A person's record, oldest first.
    pub fn person(&self, user_id: &str) -> &[Move] {
        self.by_person.get(user_id).map_or(&[], Vec::as_slice)
    }

    /// Every account the book holds, in the order first touched.
    pub fn accounts(&self) -> &[(AccountRef, Amount)] {
        &self.held
    }

    /// A move the partner itself makes, recorded once (`transfer`); the caller checks it may be made.
    pub fn transfer(
        &mut self,
        key: &str,
        from: &AccountRef,
        to: &AccountRef,
        amount: Amount,
        now: Instant,
    ) -> Result<Move, Refusal> {
        let m = Move {
            id: self.next_id("move"),
            key: key.to_owned(),
            from: from.clone(),
            to: to.clone(),
            amount,
            moved_at: now,
            label: LABEL,
            payees: None,
        };
        self.add(
            from,
            Amount::ZERO.checked_sub(amount).unwrap_or(Amount::ZERO),
        )?;
        self.add(to, amount)?;
        self.remember(m.clone());
        Ok(m)
    }

    /// A pay-in into `account`, credited and on its owner's record under `key`, never under a move key (`payIn`).
    pub fn pay_in(
        &mut self,
        account: &AccountRef,
        key: &str,
        amount: Amount,
        now: Instant,
    ) -> Result<String, Refusal> {
        let id = self.next_id("move");
        self.add(account, amount)?;
        self.note(
            &account.user_id,
            Move {
                id: id.clone(),
                key: key.to_owned(),
                from: pay_ins_account(&account.asset_id),
                to: account.clone(),
                amount,
                moved_at: now,
                label: LABEL,
                payees: None,
            },
        );
        Ok(id)
    }
}

/// Everything the TEST partner keeps, under one lock.
#[derive(Debug)]
pub struct State {
    pub board: Board,
    pub book: Book,
    /// One funding per person and id: (asset, amount).
    funds: HashMap<String, (String, Amount)>,
    /// People whose bank account is closing or closed: no move in or out but a closure's payout.
    restricted: HashSet<String>,
    /// The last figure given for each account, for a read while it is down; bounded with the switches.
    last_given: HashMap<String, (u64, Balance)>,
    last_order: BTreeMap<u64, String>,
    last_seq: u64,
    /// Each payment made, by key, in the order made, and the request it was made on.
    payments: Vec<(PaymentRequest, Payment)>,
    pub purchases: PurchaseDesk,
    pub debits: DirectDebitDesk,
    pub compliance: Compliance,
}

/// The TEST partner bank and ramp (`testPartner()`), on a dev or test stack only.
#[derive(Debug)]
pub struct TestPartner {
    state: Mutex<State>,
}

/// `TestPartnerFund`: TEST money paid in once per `fund_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Funding {
    pub fund_id: String,
    pub asset_id: String,
    pub amount: Amount,
}

fn payees_key(p: Option<&Vec<Payee>>) -> String {
    p.map_or_else(String::new, |list| {
        list.iter()
            .map(|p| {
                format!(
                    "{}\u{0}{}\u{0}{}\u{0}{:?}",
                    p.name,
                    p.iban,
                    p.amount.scaled(),
                    p.reference
                )
            })
            .collect::<Vec<_>>()
            .join("\u{1}")
    })
}

impl State {
    fn new(boot: String) -> State {
        State {
            board: Board::default(),
            book: Book::new(boot),
            funds: HashMap::new(),
            restricted: HashSet::new(),
            last_given: HashMap::new(),
            last_order: BTreeMap::new(),
            last_seq: 0,
            payments: Vec::new(),
            purchases: PurchaseDesk::default(),
            debits: DirectDebitDesk::default(),
            compliance: Compliance::default(),
        }
    }

    fn down(&self, user_id: &str) -> bool {
        self.board.read(user_id, |s| s.down)
    }

    /// `report`: the figure the partner gives for one account under the person's switches.
    pub fn report(&mut self, account: &AccountRef, now: Instant) -> Balance {
        let key = account.key();
        let sw = self.board.get(&account.user_id);
        if sw.down {
            return match self.last_given.get(&key) {
                Some((_, last)) => Balance {
                    unavailable: true,
                    ..last.clone()
                },
                None => Balance {
                    account: account.clone(),
                    amount: None,
                    as_of: None,
                    unavailable: true,
                    label: LABEL,
                },
            };
        }
        if sw.figures == "unknown" {
            return Balance {
                account: account.clone(),
                amount: None,
                as_of: None,
                unavailable: false,
                label: LABEL,
            };
        }
        let as_of = if sw.figures == "stale" {
            Instant(now.0.saturating_sub(STALE_AFTER_MS.saturating_mul(2)))
        } else {
            now
        };
        let given = Balance {
            account: account.clone(),
            amount: Some(self.book.amount(account)),
            as_of: Some(as_of),
            unavailable: false,
            label: LABEL,
        };
        if let Some((at, _)) = self.last_given.remove(&key) {
            self.last_order.remove(&at);
        }
        self.last_seq = self.last_seq.saturating_add(1);
        self.last_order.insert(self.last_seq, key.clone());
        self.last_given.insert(key, (self.last_seq, given.clone()));
        if self.last_given.len() > switches::MAX_PEOPLE.saturating_mul(4)
            && let Some((_, oldest)) = self.last_order.pop_first()
        {
            self.last_given.remove(&oldest);
        }
        given
    }

    /// The raw partner's `move`: asks neither the freeze nor a stop (the guarded custody does, before this).
    pub fn move_raw(&mut self, req: &MoveRequest, now: Instant) -> Result<Move, Refusal> {
        // The partner deduplicates on the key first: a retry is answered with the move it made, even while down.
        if let Some(prior) = self.book.by_key(&req.key) {
            if prior.from != req.from
                || prior.to != req.to
                || prior.amount != req.amount
                || payees_key(prior.payees.as_ref()) != payees_key(req.payees.as_ref())
            {
                return Err(move_conflict(&req.key));
            }
            return Ok(prior.clone());
        }
        // Whose switches apply: the source's owner, or for an amount given back out of the partner's own
        // outbound-payments account, the person it goes to.
        let person = if req.from.user_id == PAYOUTS_OWNER {
            req.to.user_id.clone()
        } else {
            req.from.user_id.clone()
        };
        if self.down(&person) {
            return Err(partner_down());
        }
        if !req.key.starts_with(CLOSURE_PAYOUT_KEY)
            && (self.restricted.contains(&req.from.user_id)
                || self.restricted.contains(&req.to.user_id))
        {
            return Err(refuse(
                "bank.account_restricted",
                "This bank account is closing or closed, so the partner bank makes no move in or out of it. Nothing was moved.",
            ));
        }
        if self.book.moves_held() >= MAX_MOVES {
            return Err(partner_down());
        }
        if req.amount <= Amount::ZERO {
            return Err(amount_invalid("A partner move needs an amount above zero."));
        }
        if let Some(payees) = &req.payees {
            let mut sum: Amount = Amount::ZERO;
            for p in payees {
                sum = add(sum, p.amount)?;
            }
            if payees.is_empty()
                || payees.iter().any(|p| p.amount <= Amount::ZERO)
                || sum != req.amount
            {
                return Err(amount_invalid(
                    "A payout’s recipients must add up to its amount exactly. Nothing was moved.",
                ));
            }
        }
        if req.from.asset_id != req.to.asset_id {
            return Err(refuse(
                "bank.asset_mismatch",
                "A partner move stays in one currency; convert first.",
            ));
        }
        if req.from == req.to {
            return Err(refuse(
                "bank.same_space",
                "A transfer needs two different spaces",
            ));
        }
        let has = self.book.amount(&req.from);
        if has < req.amount {
            self.debits.refused_for_funds(req, now);
            return Err(refuse(
                "bank.partner_insufficient_funds",
                format!(
                    "The partner reports {} {} in this account, less than {}. Nothing was moved.",
                    format_amount(has),
                    req.from.asset_id,
                    format_amount(req.amount)
                ),
            ));
        }
        // What the partner still holds back of a purchase stays where it is until its release time.
        let back = self.held_back(&req.from, now);
        let free = sub(has, back)?;
        if back > Amount::ZERO && free < req.amount {
            self.debits.refused_for_funds(req, now);
            return Err(refuse(
                "bank.partner_insufficient_funds",
                format!(
                    "The partner holds back {} {} of a purchase until its release time, so {} can move now, less than {}. Nothing was moved.",
                    format_amount(back),
                    req.from.asset_id,
                    format_amount(free),
                    format_amount(req.amount)
                ),
            ));
        }
        // One step: the debit, the credit and the record are made together or not at all (each is checked first).
        add(self.book.amount(&req.to), req.amount)?;
        let m = Move {
            id: self.book.next_id("move"),
            key: req.key.clone(),
            from: req.from.clone(),
            to: req.to.clone(),
            amount: req.amount,
            moved_at: now,
            label: LABEL,
            payees: req.payees.clone(),
        };
        self.book.add(&req.from, -req.amount)?;
        self.book.add(&req.to, req.amount)?;
        self.book.remember(m.clone());
        if self.board.read(&person, |s| s.next_reply == "lost") {
            let mut sw = self.board.get(&person);
            "answered".clone_into(&mut sw.next_reply);
            self.board.set(&person, sw);
            return Err(refuse(
                "bank.partner_reply_lost",
                "The partner bank did not answer, so whether this move was made is not known. Try again with the same request: it is made at most once.",
            ));
        }
        Ok(m)
    }

    /// What the purchase desk holds back of `account` now.
    fn held_back(&mut self, account: &AccountRef, now: Instant) -> Amount {
        let expired = self
            .board
            .read(&account.user_id, |s| s.purchase_hold == "expired");
        self.purchases.held_back(account, expired, now)
    }

    /// `moves`: a person's record, newest first, from just past `before`, pay-ins only when asked.
    pub fn moves(&self, user_id: &str, q: &MovesQuery) -> Vec<Move> {
        let mut out = Vec::new();
        let mut passed = q.before.is_none();
        for m in self.book.person(user_id).iter().rev() {
            if out.len() >= q.limit {
                break;
            }
            if !passed {
                if Some(&m.id) == q.before.as_ref() {
                    passed = true;
                }
                continue;
            }
            let pay_in = m.from.user_id == PAY_INS_OWNER || m.to.user_id == PAY_INS_OWNER;
            if pay_in && !q.pay_ins {
                continue;
            }
            if q.asset_id.as_ref().is_none_or(|a| *a == m.from.asset_id) {
                out.push(m.clone());
            }
        }
        out
    }

    /// The partner's own statement of one account, from its book alone.
    pub fn statement(
        &self,
        account: &AccountRef,
        from: Instant,
        to: Instant,
        now: Instant,
    ) -> Result<Statement, Refusal> {
        if self.down(&account.user_id) {
            return Err(partner_down());
        }
        let mut closing = self.book.amount(account);
        let mut net: Amount = Amount::ZERO;
        let mut lines: u64 = 0;
        for m in self.book.person(&account.user_id) {
            let into = m.to == *account;
            let out_of = m.from == *account;
            if !into && !out_of {
                continue;
            }
            let signed = sub(
                if into { m.amount } else { Amount::ZERO },
                if out_of { m.amount } else { Amount::ZERO },
            )?;
            if m.moved_at.0 >= to.0 {
                closing = sub(closing, signed)?;
            } else if m.moved_at.0 >= from.0 {
                net = add(net, signed)?;
                lines = lines.saturating_add(1);
            }
        }
        Ok(Statement {
            account: account.clone(),
            from,
            to,
            opening: sub(closing, net)?,
            closing,
            lines,
            as_of: now,
            label: LABEL,
        })
    }

    /// `openOrders`.
    pub fn open_orders(&self, user_id: &str) -> Vec<OpenOrder> {
        self.board
            .get(user_id)
            .open_order
            .map(|asset| OpenOrder {
                id: format!("TEST-order:{user_id}:{asset}"),
                asset_id: asset,
                label: LABEL,
            })
            .into_iter()
            .collect()
    }

    /// `limits`: what the person sent today (money that left them, not a move between their own spaces).
    pub fn limits(
        &self,
        user_id: &str,
        asset_id: &str,
        now: Instant,
    ) -> Result<SendLimits, Refusal> {
        let day_start = now.0.div_euclid(86_400_000).saturating_mul(86_400_000);
        let mut used: Amount = Amount::ZERO;
        for m in self.book.person(user_id) {
            if m.from.user_id == user_id
                && m.to.user_id != user_id
                && m.from.asset_id == asset_id
                && m.moved_at.0 >= day_start
            {
                used = add(used, m.amount)?;
            }
        }
        Ok(SendLimits {
            asset_id: asset_id.to_owned(),
            daily_send: fixed(DAILY_SEND),
            used_today: used,
            send_fee: self
                .board
                .read(user_id, |s| s.fee == "known")
                .then(|| fixed(SEND_FEE)),
            as_of: now,
            label: LABEL,
        })
    }

    /// `quoteMove`: the TEST partner takes nothing for a move between a person's own accounts, and says so; with
    /// `fee: 'unknown'` it does not say.
    pub fn quote_move(
        &mut self,
        from: &AccountRef,
        to: &AccountRef,
        amount: Amount,
        now: Instant,
    ) -> Result<MoveQuote, Refusal> {
        if self.down(&from.user_id) {
            return Err(partner_down());
        }
        if amount <= Amount::ZERO {
            return Err(amount_invalid("A partner move needs an amount above zero."));
        }
        if from.asset_id != to.asset_id {
            return Err(refuse(
                "bank.asset_mismatch",
                "A partner move stays in one currency; convert first.",
            ));
        }
        if from == to {
            return Err(refuse(
                "bank.same_space",
                "A transfer needs two different spaces",
            ));
        }
        let quote_id = self.book.next_id("quote");
        let fee = self
            .board
            .read(&from.user_id, |s| s.fee == "known")
            .then_some(Amount::ZERO);
        Ok(MoveQuote {
            quote_id,
            from: from.clone(),
            to: to.clone(),
            amount,
            fee,
            receives: fee.map(|f| amount.saturating_sub(f)),
            quoted_at: now,
            valid_until: Instant(now.0.saturating_add(QUOTE_MS)),
            label: LABEL,
        })
    }

    /// `payments.pay`, after the guards: one partner move into its outbound-payments account, made pending.
    pub fn pay(&mut self, req: &PaymentRequest, now: Instant) -> Result<Payment, Refusal> {
        if let Some((asked, prior)) = self.payments.iter().find(|(r, _)| r.key == req.key) {
            if asked.from != req.from
                || asked.amount != req.amount
                || asked.method != req.method
                || asked.recipient != req.recipient
            {
                return Err(move_conflict(&req.key));
            }
            return Ok(prior.clone());
        }
        if self
            .board
            .read(&req.from.user_id, |s| s.bank_rail != "test")
        {
            let rail = if req.method == "ach" {
                "ACH"
            } else {
                "instant"
            };
            return Err(refuse(
                "rail.bank",
                format!("An {rail} payment needs rail.bank. It is switched off in this build."),
            ));
        }
        if self.payments.len() >= MAX_MOVES {
            return Err(partner_down());
        }
        self.move_raw(
            &MoveRequest {
                key: req.key.clone(),
                from: req.from.clone(),
                to: payouts_account(&req.from.asset_id),
                amount: req.amount,
                payees: None,
            },
            now,
        )?;
        let made = Payment {
            id: self.book.next_id("payment"),
            key: req.key.clone(),
            from: req.from.clone(),
            method: req.method.clone(),
            amount: req.amount,
            state: "pending",
            version: 1,
            previous: None,
            changed_at: now,
            label: LABEL,
        };
        self.payments.push((req.clone(), made.clone()));
        Ok(made)
    }

    /// `paymentByKey`.
    pub fn payment_by_key(&self, key: &str) -> Option<Payment> {
        self.payments
            .iter()
            .find(|(r, _)| r.key == key)
            .map(|(_, p)| p.clone())
    }

    /// `settlePayment`: the TEST partner reports one of the person's pending payments completed; asked again it
    /// reports the same change, the same version.
    pub fn settle_payment(
        &mut self,
        user_id: &str,
        payment_id: &str,
        now: Instant,
    ) -> Result<Payment, Refusal> {
        let Some((_, found)) = self
            .payments
            .iter_mut()
            .find(|(_, p)| p.id == payment_id && p.from.user_id == user_id)
        else {
            return Err(refuse(
                "bank.payment_not_found",
                "The TEST partner has no such payment of yours.",
            ));
        };
        if found.state != "pending" {
            return Ok(found.clone());
        }
        found.state = "completed";
        found.previous = Some("pending");
        found.version = found.version.saturating_add(1);
        found.changed_at = now;
        Ok(found.clone())
    }

    /// `receive`: a payment from outside arrives in the person's main balance, once under `key`.
    pub fn receive(
        &mut self,
        account: &AccountRef,
        key: &str,
        amount: Amount,
        now: Instant,
    ) -> Result<Move, Refusal> {
        if let Some(prior) = self.book.by_key(key) {
            if prior.to != *account || prior.amount != amount || prior.from.user_id != PAY_INS_OWNER
            {
                return Err(move_conflict(key));
            }
            return Ok(prior.clone());
        }
        if self.down(&account.user_id) {
            return Err(partner_down());
        }
        if self.restricted.contains(&account.user_id) {
            return Err(refuse(
                "bank.account_restricted",
                "This bank account is closing or closed, so the partner bank takes no payment into it.",
            ));
        }
        if self.book.moves_held() >= MAX_MOVES {
            return Err(partner_down());
        }
        if amount <= Amount::ZERO {
            return Err(amount_invalid("A payment in needs an amount above zero."));
        }
        let m = Move {
            id: self.book.next_id("move"),
            key: key.to_owned(),
            from: pay_ins_account(&account.asset_id),
            to: account.clone(),
            amount,
            moved_at: now,
            label: LABEL,
            payees: None,
        };
        self.book.add(account, amount)?;
        self.book.remember(m.clone());
        Ok(m)
    }

    /// `fund`: TEST money paid into a main balance, once per person and `fund_id`. The partner's figure, not a post.
    pub fn fund(&mut self, user_id: &str, f: &Funding, now: Instant) -> Result<Balance, Refusal> {
        let account = AccountRef::main(user_id, &f.asset_id);
        let fund_key = format!("{user_id}|{}", f.fund_id);
        if let Some((asset, amount)) = self.funds.get(&fund_key) {
            if *asset != f.asset_id || *amount != f.amount {
                return Err(move_conflict(&f.fund_id));
            }
            return Ok(self.funded(&account, now));
        }
        if self.down(user_id) {
            return Err(partner_down());
        }
        if self.restricted.contains(user_id) {
            return Err(refuse(
                "bank.account_restricted",
                "This bank account is closing or closed, so the partner bank takes no payment into it.",
            ));
        }
        if f.amount <= Amount::ZERO {
            return Err(amount_invalid("TEST funding needs an amount above zero."));
        }
        self.book
            .pay_in(&account, &format!("pay-in:{fund_key}"), f.amount, now)?;
        self.funds.insert(fund_key, (f.asset_id.clone(), f.amount));
        Ok(self.funded(&account, now))
    }

    /// The partner's answer to a funding: what the account now holds, at its time now, whatever `figures` says.
    fn funded(&self, account: &AccountRef, now: Instant) -> Balance {
        Balance {
            account: account.clone(),
            amount: Some(self.book.amount(account)),
            as_of: Some(now),
            unavailable: false,
            label: LABEL,
        }
    }

    /// `record`: the partner's own book for one person, straight from the book, shaped by no switch.
    pub fn record(&self, user_id: &str) -> Record {
        Record {
            accounts: self
                .book
                .accounts()
                .iter()
                .filter(|(a, _)| a.user_id == user_id)
                .cloned()
                .collect(),
            moves: self.book.person(user_id).to_vec(),
        }
    }

    /// Marks a person's account closing or closed (`restrict`), or open again.
    pub fn restrict(&mut self, user_id: &str, on: bool) {
        if on {
            self.restricted.insert(user_id.to_owned());
        } else {
            self.restricted.remove(user_id);
        }
    }

    /// Every figure the partner gives for one person's accounts (`balances`).
    pub fn balances(&mut self, user_id: &str, now: Instant) -> Vec<Balance> {
        let accounts: Vec<AccountRef> = self
            .book
            .accounts()
            .iter()
            .filter(|(a, _)| a.user_id == user_id)
            .map(|(a, _)| a.clone())
            .collect();
        accounts.iter().map(|a| self.report(a, now)).collect()
    }
}

impl TestPartner {
    /// A fresh TEST partner: an empty book and every switch off.
    pub fn new() -> Result<TestPartner, String> {
        let uuid = service_kit::approvals::random_uuid()?;
        // A version-4 uuid's first twelve hex digits are random: the TypeScript's six random bytes.
        let boot: String = uuid
            .chars()
            .filter(char::is_ascii_hexdigit)
            .take(12)
            .collect();
        Ok(TestPartner {
            state: Mutex::new(State::new(boot)),
        })
    }

    /// `testPartnerFor`: `off` is no partner; `test` is the partner only in an explicit dev or test process.
    pub fn for_setting(
        setting: &str,
        app_env: Option<&str>,
        node_env: Option<&str>,
    ) -> Result<Option<TestPartner>, String> {
        if setting != "test" {
            return Ok(None);
        }
        if !matches!(app_env, Some("dev" | "test")) || node_env == Some("production") {
            return Err(REFUSED_OUTSIDE_DEV_TEST.to_owned());
        }
        TestPartner::new().map(Some)
    }

    /// The whole book under its lock. A poisoned lock is still the book: nothing in it is left half-written, as each
    /// change checks before it writes.
    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The person's switches.
    pub fn switches(&self, user_id: &str) -> Switches {
        self.lock().board.get(user_id)
    }
}

/// `moneyHeldBy`: `partner` when the TEST partner's custody switch is off for the person, else the custodial layer
/// when it is on, else nobody.
pub fn money_held_by(
    partner: Option<&TestPartner>,
    user_id: &str,
    custody_layer: &str,
) -> &'static str {
    if partner.is_some_and(|p| p.lock().board.read(user_id, |s| s.custody == "off")) {
        return "partner";
    }
    if custody_layer == "on" {
        "ledger"
    } else {
        "none"
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn every_code_the_slice_refuses_with_is_a_bank_error_code() {
        for code in [
            "bank.partner_unavailable",
            "bank.partner_move_conflict",
            "bank.partner_amount_invalid",
            "bank.partner_balance_not_known",
            "bank.account_restricted",
            "bank.asset_mismatch",
            "bank.same_space",
            "bank.partner_insufficient_funds",
            "bank.partner_reply_lost",
            "rail.bank",
            "bank.payment_not_found",
            "bank.test_partner_off",
            "bank.no_partner_bank",
            "bank.posting_frozen",
            "bank.partner_stopped",
            "bank.partner_stop_unreadable",
            "bank.cash_leg_not_offered",
            "bank.cash_leg_invalid",
            "bank.cash_leg_rate_moved",
            "bank.cash_leg_sending",
            "bank.business_not_found",
            "bank.business_owner_only",
            "bank.dd_refund_not_collected",
            "bank.info_request_not_found",
            "bank.info_request_not_open",
            "bank.info_request_past_deadline",
            "bank.review_not_found",
            "bank.review_not_open",
            "bank.closure_conflict",
            "bank.closure_pending",
            "bank.account_closed",
            "bank.closure_legal_hold",
            "bank.closure_destination_required",
            "bank.account_not_closed",
            "bank.reopen_window_passed",
            "bank.data_request_conflict",
            "bank.closure_not_found",
        ] {
            assert!(
                matches!(refuse(code, "m"), Refusal::Bank(_)),
                "{code} is no BankError code"
            );
        }
    }

    #[test]
    fn an_account_key_names_its_space_or_main() {
        let mut a = AccountRef::main("u", "EUR");
        assert_eq!(a.key(), "u|EUR|main");
        a.space_id = Some("s1".to_owned());
        assert_eq!(a.key(), "u|EUR|s1");
    }

    #[test]
    fn the_test_partner_is_refused_outside_an_explicit_dev_or_test_process() {
        assert!(
            TestPartner::for_setting("off", None, None)
                .unwrap()
                .is_none()
        );
        assert!(
            TestPartner::for_setting("test", Some("dev"), None)
                .unwrap()
                .is_some()
        );
        assert!(
            TestPartner::for_setting("test", Some("test"), Some("test"))
                .unwrap()
                .is_some()
        );
        assert_eq!(
            TestPartner::for_setting("test", Some("prod"), None)
                .err()
                .as_deref(),
            Some(REFUSED_OUTSIDE_DEV_TEST)
        );
        assert!(TestPartner::for_setting("test", None, None).is_err());
        assert!(TestPartner::for_setting("test", Some("dev"), Some("production")).is_err());
    }
}
