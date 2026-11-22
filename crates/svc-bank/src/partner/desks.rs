//! Two of the TEST partner's capabilities over its one book: the ramp's purchases and what it holds back of each
//! (`partner/test-partner-purchases.ts`), and the bank a direct debit collects from (`test-partner-direct-debits.ts`).
//! Neither keeps a balance of its own: each changes the book only through [`super::Book`].

use std::collections::HashMap;

use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;

use super::{
    AccountRef, LABEL, MAX_MOVES, Move, MoveRequest, State, move_conflict, partner_down,
    pay_ins_account, refuse,
};
use crate::errors::Refusal;

const DAY_MS: i64 = 86_400_000;

/// How long the TEST partner holds back a purchase, by how it was paid (`TEST_PURCHASE_HOLD_DAYS`). TEST values.
pub fn hold_days(paid_by: &str) -> i64 {
    if paid_by == "card" { 7 } else { 3 }
}

/// A purchase the ramp asks the partner to credit (`PartnerPurchase`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Purchase {
    pub key: String,
    pub asset_id: String,
    pub amount: Amount,
    /// `card` or `bank_pull`.
    pub paid_by: String,
}

/// What the partner holds back of one purchase until its release time (`PartnerPurchaseHold`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurchaseHold {
    pub id: String,
    pub purchase_key: String,
    pub asset_id: String,
    pub amount: Amount,
    pub paid_by: String,
    pub release_at: Instant,
    /// Set once released (`PartnerPurchaseRelease`).
    pub released_at: Option<Instant>,
}

/// The partner's answer to a credit (`PartnerCredit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credit {
    pub id: String,
    pub key: String,
    pub amount: Amount,
    pub hold: Option<PurchaseHold>,
}

/// A purchase sent back (`PartnerReturn`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Return {
    pub id: String,
    pub key: String,
    pub amount: Amount,
    pub returned_at: Instant,
}

/// What the partner reports it holds back (`PartnerPurchaseHolds`); `None` when it does not report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holds {
    pub as_of: Instant,
    pub holds: Vec<PurchaseHold>,
    pub released: Vec<PurchaseHold>,
}

#[derive(Debug, Default)]
pub struct PurchaseDesk {
    purchased: HashMap<String, (Credit, String, String)>,
    open: HashMap<String, Vec<PurchaseHold>>,
    released: HashMap<String, Vec<PurchaseHold>>,
    returns: HashMap<String, Return>,
}

impl PurchaseDesk {
    /// `releaseDue`: every open hold of the person past its release time, or all of them when `expired`.
    fn release_due(&mut self, user_id: &str, expired: bool, now: Instant) {
        let Some(open) = self.open.get_mut(user_id) else {
            return;
        };
        let (due, keep): (Vec<_>, Vec<_>) = open
            .drain(..)
            .partition(|h| expired || h.release_at.0 <= now.0);
        *open = keep;
        if due.is_empty() {
            return;
        }
        let done = self.released.entry(user_id.to_owned()).or_default();
        for mut h in due {
            h.released_at = Some(now);
            done.push(h);
        }
    }

    /// `heldBack`: what the partner holds back of a main balance now.
    pub fn held_back(&mut self, account: &AccountRef, expired: bool, now: Instant) -> Amount {
        if account.space_id.is_some() {
            return 0;
        }
        self.release_due(&account.user_id, expired, now);
        self.open.get(&account.user_id).map_or(0, |list| {
            list.iter()
                .filter(|h| h.asset_id == account.asset_id)
                .fold(0, |sum: Amount, h| sum.saturating_add(h.amount))
        })
    }
}

/// One direct debit mandate as the partner keeps it (`PartnerMandate`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mandate {
    pub mandate_id: String,
    pub blocked_at: Option<Instant>,
}

/// The partner's report of every direct debit it answers for (`PartnerDirectDebitReport`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebitReport {
    pub as_of: Instant,
    /// (owner, mandate, blocked at, known at), in the order first known.
    pub mandates: Vec<(String, String, Option<Instant>, Instant)>,
    /// (owner, mandate, collection, code), in the order refused.
    pub failures: Vec<(String, String, String, String)>,
    pub refunds: Vec<Refund>,
}

/// A collected debit the partner gave back (`PartnerDirectDebitRefund`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refund {
    pub user_id: String,
    pub mandate_id: String,
    pub collection_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub move_id: String,
    pub refunded_at: Instant,
}

/// The refusal code a blocked mandate's collection carries (`TEST_PARTNER_DD_BLOCKED`).
pub const DD_BLOCKED: &str = "test_partner.dd_mandate_blocked";
const DD_COLLECTION_KEY: &str = "bank.dd.collection:";

/// `ddCollectionOf`: the mandate and collection a collection's key names.
fn dd_collection_of(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix(DD_COLLECTION_KEY)?;
    let mut parts = rest.split(':');
    let mandate = parts.next().filter(|s| !s.is_empty())?;
    let collection = parts.next().filter(|s| !s.is_empty())?;
    parts
        .next()
        .is_none()
        .then(|| (mandate.to_owned(), collection.to_owned()))
}

#[derive(Debug, Default)]
pub struct DirectDebitDesk {
    blocks: HashMap<String, Instant>,
    known: Vec<(String, String, Instant)>,
    known_at: HashMap<String, usize>,
    failures: Vec<(String, String, String, String)>,
    failure_keys: HashMap<String, usize>,
    refunds: Vec<Refund>,
    refund_at: HashMap<String, usize>,
}

impl DirectDebitDesk {
    fn know(&mut self, user_id: &str, mandate_id: &str, now: Instant) {
        let key = format!("{user_id}|{mandate_id}");
        if !self.known_at.contains_key(&key) && self.known.len() < MAX_MOVES {
            self.known_at.insert(key, self.known.len());
            self.known
                .push((user_id.to_owned(), mandate_id.to_owned(), now));
        }
    }

    fn refused(
        &mut self,
        user_id: &str,
        mandate_id: &str,
        collection_id: &str,
        code: &str,
        now: Instant,
    ) {
        self.know(user_id, mandate_id, now);
        let key = format!("{user_id}|{mandate_id}|{collection_id}");
        if !self.failure_keys.contains_key(&key) && self.failures.len() < MAX_MOVES {
            self.failure_keys.insert(key, self.failures.len());
            self.failures.push((
                user_id.to_owned(),
                mandate_id.to_owned(),
                collection_id.to_owned(),
                code.to_owned(),
            ));
        }
    }

    /// `refusedForFunds`: a collection the partner could not cover is on its report with its reason.
    pub fn refused_for_funds(&mut self, req: &MoveRequest, now: Instant) {
        if let Some((mandate, collection)) = dd_collection_of(&req.key) {
            self.refused(
                &req.from.user_id,
                &mandate,
                &collection,
                "bank.partner_insufficient_funds",
                now,
            );
        }
    }

    fn mandate(&self, user_id: &str, mandate_id: &str) -> Mandate {
        Mandate {
            mandate_id: mandate_id.to_owned(),
            blocked_at: self.blocks.get(&format!("{user_id}|{mandate_id}")).copied(),
        }
    }
}

impl State {
    /// `purchases.credit`: the ramp's paid purchase credited once per person and key, with its hold.
    pub fn purchase_credit(
        &mut self,
        user_id: &str,
        p: &Purchase,
        now: Instant,
    ) -> Result<Credit, Refusal> {
        let credit_key = format!("{user_id}|{}", p.key);
        if let Some((prior, asset, paid_by)) = self.purchases.purchased.get(&credit_key) {
            if *asset != p.asset_id || prior.amount != p.amount || *paid_by != p.paid_by {
                return Err(move_conflict(&p.key));
            }
            return Ok(prior.clone());
        }
        if self.board.read(user_id, |s| s.down) {
            return Err(partner_down());
        }
        if p.amount <= 0 {
            return Err(refuse(
                "bank.partner_amount_invalid",
                "A purchase needs an amount above zero.",
            ));
        }
        let account = AccountRef::main(user_id, &p.asset_id);
        let id = self.book.pay_in(
            &account,
            &format!("pay-in:purchase:{credit_key}"),
            p.amount,
            now,
        )?;
        let hold = PurchaseHold {
            id: id.replacen("test-partner-move-", "test-partner-hold-", 1),
            purchase_key: p.key.clone(),
            asset_id: p.asset_id.clone(),
            amount: p.amount,
            paid_by: p.paid_by.clone(),
            release_at: Instant(
                now.0
                    .saturating_add(hold_days(&p.paid_by).saturating_mul(DAY_MS)),
            ),
            released_at: None,
        };
        self.purchases
            .open
            .entry(user_id.to_owned())
            .or_default()
            .push(hold.clone());
        let credit = Credit {
            id,
            key: p.key.clone(),
            amount: p.amount,
            hold: Some(hold),
        };
        self.purchases.purchased.insert(
            credit_key,
            (credit.clone(), p.asset_id.clone(), p.paid_by.clone()),
        );
        Ok(credit)
    }

    /// `purchases.returned`: a credited purchase sent back once; its hold goes with it.
    pub fn purchase_returned(
        &mut self,
        user_id: &str,
        p: &Purchase,
        now: Instant,
    ) -> Result<Return, Refusal> {
        let credit_key = format!("{user_id}|{}", p.key);
        match self.purchases.purchased.get(&credit_key) {
            Some((c, asset, _)) if *asset == p.asset_id && c.amount == p.amount => {}
            _ => return Err(move_conflict(&p.key)),
        }
        if let Some(prior) = self.purchases.returns.get(&credit_key) {
            return Ok(prior.clone());
        }
        if self.board.read(user_id, |s| s.down) {
            return Err(partner_down());
        }
        let account = AccountRef::main(user_id, &p.asset_id);
        let has = self.book.amount(&account);
        if has < p.amount {
            return Err(refuse(
                "bank.partner_insufficient_funds",
                format!(
                    "The partner reports {} {}, less than the {} sent back. Nothing was taken.",
                    format_amount(has),
                    p.asset_id,
                    format_amount(p.amount)
                ),
            ));
        }
        self.book.add(&account, -p.amount)?;
        if let Some(open) = self.purchases.open.get_mut(user_id) {
            open.retain(|h| h.purchase_key != p.key);
        }
        let id = self.book.next_id("move");
        self.book.note(
            user_id,
            Move {
                id: id.clone(),
                key: format!("pay-in:return:{credit_key}"),
                from: account,
                to: pay_ins_account(&p.asset_id),
                amount: p.amount,
                moved_at: now,
                label: LABEL,
                payees: None,
            },
        );
        let back = Return {
            id,
            key: p.key.clone(),
            amount: p.amount,
            returned_at: now,
        };
        self.purchases.returns.insert(credit_key, back.clone());
        Ok(back)
    }

    /// `purchases.holds`: what the partner holds back of the person's purchases, or `None` when it does not say.
    pub fn purchase_holds(
        &mut self,
        user_id: &str,
        now: Instant,
    ) -> Result<Option<Holds>, Refusal> {
        let sw = self.board.get(user_id);
        if sw.down {
            return Err(partner_down());
        }
        if sw.purchase_holds == "not_reported" {
            return Ok(None);
        }
        self.purchases
            .release_due(user_id, sw.purchase_hold == "expired", now);
        Ok(Some(Holds {
            as_of: now,
            holds: self
                .purchases
                .open
                .get(user_id)
                .cloned()
                .unwrap_or_default(),
            released: self
                .purchases
                .released
                .get(user_id)
                .cloned()
                .unwrap_or_default(),
        }))
    }

    /// `directDebits.block`.
    pub fn dd_block(
        &mut self,
        user_id: &str,
        mandate_id: &str,
        now: Instant,
    ) -> Result<Mandate, Refusal> {
        let key = format!("{user_id}|{mandate_id}");
        if !self.debits.blocks.contains_key(&key) {
            if self.board.read(user_id, |s| s.down) || self.debits.blocks.len() >= MAX_MOVES {
                return Err(partner_down());
            }
            self.debits.blocks.insert(key, now);
        }
        self.debits.know(user_id, mandate_id, now);
        Ok(self.debits.mandate(user_id, mandate_id))
    }

    /// `directDebits.unblock`.
    pub fn dd_unblock(&mut self, user_id: &str, mandate_id: &str) -> Result<Mandate, Refusal> {
        let key = format!("{user_id}|{mandate_id}");
        if self.debits.blocks.contains_key(&key) {
            if self.board.read(user_id, |s| s.down) {
                return Err(partner_down());
            }
            self.debits.blocks.remove(&key);
        }
        Ok(self.debits.mandate(user_id, mandate_id))
    }

    /// `directDebits.mandate`: a blocked mandate's collection is on the report as refused.
    pub fn dd_mandate(
        &mut self,
        user_id: &str,
        mandate_id: &str,
        for_collection: Option<&str>,
        now: Instant,
    ) -> Result<Mandate, Refusal> {
        if self.board.read(user_id, |s| s.down) {
            return Err(partner_down());
        }
        self.debits.know(user_id, mandate_id, now);
        let answer = self.debits.mandate(user_id, mandate_id);
        if let Some(collection) = for_collection
            && answer.blocked_at.is_some()
        {
            self.debits
                .refused(user_id, mandate_id, collection, DD_BLOCKED, now);
        }
        Ok(answer)
    }

    /// `directDebits.setUp`.
    pub fn dd_set_up(
        &mut self,
        user_id: &str,
        mandate_id: &str,
        now: Instant,
    ) -> Result<(), Refusal> {
        if self.board.read(user_id, |s| s.down) {
            return Err(partner_down());
        }
        self.debits.know(user_id, mandate_id, now);
        Ok(())
    }

    /// `directDebitReport`: straight from the book.
    pub fn dd_report(&self, now: Instant) -> DebitReport {
        DebitReport {
            as_of: now,
            mandates: self
                .debits
                .known
                .iter()
                .map(|(u, m, known)| {
                    let blocked = self.debits.blocks.get(&format!("{u}|{m}")).copied();
                    (u.clone(), m.clone(), blocked, *known)
                })
                .collect(),
            failures: self.debits.failures.clone(),
            refunds: self.debits.refunds.clone(),
        }
    }

    /// `refundDirectDebit`: one move back from the outbound-payments account under `bank.dd.refund:<m>:<c>`.
    pub fn dd_refund(
        &mut self,
        user_id: &str,
        mandate_id: &str,
        collection_id: &str,
        now: Instant,
    ) -> Result<Refund, Refusal> {
        let key = format!("{user_id}|{mandate_id}|{collection_id}");
        if let Some(done) = self
            .debits
            .refund_at
            .get(&key)
            .and_then(|i| self.debits.refunds.get(*i))
        {
            return Ok(done.clone());
        }
        let collected = self
            .book
            .by_key(&format!("{DD_COLLECTION_KEY}{mandate_id}:{collection_id}"))
            .filter(|m| m.from.user_id == user_id)
            .cloned();
        let Some(collected) = collected else {
            return Err(refuse(
                "bank.dd_refund_not_collected",
                "The partner collected nothing on that debit, so there is nothing to refund.",
            ));
        };
        if self.debits.refunds.len() >= MAX_MOVES {
            return Err(partner_down());
        }
        let refund_key = format!("bank.dd.refund:{mandate_id}:{collection_id}");
        let back = match self.book.by_key(&refund_key) {
            Some(m) => m.clone(),
            None => self.book.transfer(
                &refund_key,
                &collected.to,
                &collected.from,
                collected.amount,
                now,
            )?,
        };
        let refund = Refund {
            user_id: user_id.to_owned(),
            mandate_id: mandate_id.to_owned(),
            collection_id: collection_id.to_owned(),
            asset_id: back.to.asset_id.clone(),
            amount: back.amount,
            move_id: back.id.clone(),
            refunded_at: back.moved_at,
        };
        self.debits.refund_at.insert(key, self.debits.refunds.len());
        self.debits.refunds.push(refund.clone());
        Ok(refund)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_collection_key_names_one_mandate_and_one_collection() {
        assert_eq!(
            dd_collection_of("bank.dd.collection:m1:c1"),
            Some(("m1".to_owned(), "c1".to_owned()))
        );
        assert_eq!(dd_collection_of("bank.dd.collection:m1:c1:x"), None);
        assert_eq!(dd_collection_of("bank.dd.collection:m1"), None);
        assert_eq!(dd_collection_of("other:m1:c1"), None);
    }
}
