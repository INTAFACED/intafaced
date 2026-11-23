//! The TEST partner card's instructions (`partner-card-holds.ts`: `testPartnerCardHolds`' `hold`, `capture`, `release`,
//! `refund` and `holdInOrder`), behind the operator's partner stop and the posting freeze in that order
//! (`stopGuardedCardHolds(freezeGuardedCardHolds(...))`). The book they write is the one `cards.partnerHeld` reads
//! (`reads::CardHoldBook`), kept once in the process.
//!
//! Every instruction is answered once per key: a repeat with the same body returns the first answer, and with a
//! different body refuses `bank.card_partner_key_conflict`. A refusal is not kept under its key, because nothing happened.
//! A refusal from the partner (`PartnerCardRefusal`) is [`PartnerErr::Refused`]; a guard's refusal before the partner
//! was asked, or anything else, is [`PartnerErr::Other`].

use std::collections::BTreeSet;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};

use super::conversion::funding_for;
use crate::cards::reads::{
    CardHoldBook, Figures, Hold, HoldConversion, HoldReads, HoldReport, TEST_CARD_HOLD_DAYS,
    TestCardHolds, book_id,
};
use crate::errors::Refusal;
use crate::partner::custody::{Freeze, assert_posting_enabled, assert_stop_open};
use crate::partner::refuse;

/// `TEST_PARTNER_ID`: the operator's stop is read for this partner.
pub const PARTNER_ID: &str = "test-partner";
/// `TEST_PARTNER_UNLISTED_DECLINE`.
pub const UNLISTED_DECLINE: &str = "test_partner.unlisted_reason";

/// Why an instruction did not answer.
#[derive(Debug, Clone)]
pub enum PartnerErr {
    /// `PartnerCardRefusal`: the partner said no, and nothing moved there.
    Refused(Refusal),
    /// Anything else: a guard that refused before the partner was asked, or a failure that may follow a move.
    Other(Refusal),
}

impl PartnerErr {
    pub fn refusal(self) -> Refusal {
        match self {
            PartnerErr::Refused(r) | PartnerErr::Other(r) => r,
        }
    }
}

impl From<Refusal> for PartnerErr {
    fn from(r: Refusal) -> PartnerErr {
        PartnerErr::Other(r)
    }
}

fn partner_no(code: &str, message: String) -> PartnerErr {
    PartnerErr::Refused(refuse(code, message))
}

/// `PartnerHoldAnswer` and `PartnerOrderHoldAnswer`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::large_enum_variant,
    reason = "one answer at a time, never a collection"
)]
pub enum HoldAnswer {
    Approved { hold: HoldReport, figures: Figures },
    Declined { reason: String },
}

/// `PartnerMoveAnswer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveAnswer {
    pub partner_ref: String,
    pub amount: String,
    /// `instruction` or `expiry`.
    pub by: &'static str,
    pub hold: HoldReport,
    pub figures: Figures,
}

/// One kept answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kept {
    Hold(HoldAnswer),
    Move(MoveAnswer),
}

/// The guarded TEST partner card for one call: its reads (`TestCardHolds`) and the guards its writes ask first.
pub struct Book<'a> {
    pub holds: TestCardHolds<'a>,
    pub store: &'a crate::db::Store,
    pub freeze: &'a dyn Freeze,
}

fn hold_ref(key: &str) -> String {
    format!("TEST-card-partner:{key}")
}

fn body(fields: &[(&str, &str)]) -> String {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Json::str(*v)))
            .collect(),
    )
    .compact()
}

fn amount_of(raw: &str) -> Result<Amount, PartnerErr> {
    parse_amount(raw).map_err(|e| PartnerErr::Other(Refusal::Other(e)))
}

impl Book<'_> {
    /// The stop, then the freeze: `stopGuardedCardHolds` wraps `freezeGuardedCardHolds`.
    fn guard(&self, kind: &str) -> Result<(), PartnerErr> {
        assert_stop_open(self.store, PARTNER_ID, kind)?;
        assert_posting_enabled(self.freeze, self.store, kind, true)?;
        Ok(())
    }

    /// `figuresOf`: the book as it stands, its own figure and what else the partner credited (`spendable`).
    fn figures_of(
        &self,
        book: &mut CardHoldBook,
        user_id: &str,
        asset_id: &str,
        credited: Amount,
    ) -> Figures {
        let figures = book
            .book_of(self.holds.terms, user_id, asset_id)
            .map(|b| (format_amount(b.available + credited), format_amount(b.held)));
        Figures {
            test: true,
            mode: self.holds.terms.custody_mode.clone(),
            asset_id: asset_id.to_owned(),
            available: figures.as_ref().map(|f| f.0.clone()),
            held: figures.map(|f| f.1),
        }
    }

    /// `once`: the same body replays the first answer, a different one refuses, a refusal is not kept.
    fn once(
        &self,
        key: &str,
        canonical: String,
        act: impl FnOnce(&mut CardHoldBook) -> Result<Kept, PartnerErr>,
    ) -> Result<Kept, PartnerErr> {
        let mut book = self.holds.lock();
        if let Some((prior, answer)) = book.answers.get(key) {
            if *prior != canonical {
                return Err(partner_no(
                    "bank.card_partner_key_conflict",
                    format!(
                        "The TEST card partner already answered {key} for a different instruction. Nothing moved."
                    ),
                ));
            }
            return Ok(answer.clone());
        }
        let answer = act(&mut book)?;
        book.answers
            .insert(key.to_owned(), (canonical, answer.clone()));
        Ok(answer)
    }

    /// `holdFor`: the hold, run out if its time is up; none is the partner's no.
    fn hold_for<'b>(
        &self,
        book: &'b mut CardHoldBook,
        hold_key: &str,
    ) -> Result<&'b mut Hold, PartnerErr> {
        let Some(user) = book.holds.get(hold_key).map(|h| h.user_id.clone()) else {
            return Err(partner_no(
                "bank.card_partner_hold_not_found",
                format!(
                    "The TEST card partner has no record of {hold_key} (it forgets on a restart). Nothing moved."
                ),
            ));
        };
        let switch_expired = self.holds.switch_expired(&user);
        book.run_out(hold_key, self.holds.now, switch_expired);
        book.holds
            .get_mut(hold_key)
            .ok_or_else(|| PartnerErr::Other(Refusal::Other(format!("{hold_key} vanished"))))
    }

    fn mode(&self) -> Result<String, PartnerErr> {
        self.holds.terms.custody_mode.clone().ok_or_else(|| {
            partner_no(
                "bank.card_partner_mode_not_known",
                "The TEST card partner has not said whether it holds the crypto or pulls from the wallet. Nothing was held."
                    .to_owned(),
            )
        })
    }

    fn unlisted(&self, user_id: &str) -> bool {
        self.holds
            .partner
            .is_some_and(|p| p.switches(user_id).card_decline == "unlisted")
    }

    #[allow(clippy::too_many_arguments, reason = "one hold's every field")]
    fn take(
        &self,
        book: &mut CardHoldBook,
        key: &str,
        user_id: &str,
        asset_id: &str,
        mode: String,
        want: Amount,
        conversion: Option<HoldConversion>,
    ) -> HoldReport {
        if let Some(b) = book.books.get_mut(&book_id(user_id, asset_id)) {
            b.available -= want;
            b.held += want;
            b.open.insert(key.to_owned());
        }
        let h = Hold {
            partner_ref: hold_ref(key),
            user_id: user_id.to_owned(),
            asset_id: asset_id.to_owned(),
            mode,
            amount: want,
            expires_at: service_kit::time::Instant(
                self.holds.now.0 + TEST_CARD_HOLD_DAYS * 86_400_000,
            ),
            conversion,
            captured: 0,
            released: 0,
            refunded: 0,
            expired: false,
        };
        let report = h.report();
        book.holds.insert(key.to_owned(), h);
        report
    }

    /// `hold`: hold `amount` from the partner balance, once under `key`.
    pub fn hold(
        &self,
        key: &str,
        user_id: &str,
        asset_id: &str,
        amount: &str,
    ) -> Result<HoldAnswer, PartnerErr> {
        self.guard("card_hold")?;
        let credited = self.holds.credited(user_id, asset_id);
        let unlisted = self.unlisted(user_id);
        let kept = self.once(
            key,
            body(&[("op", "hold"), ("userId", user_id), ("assetId", asset_id), ("amount", amount)]),
            |book| {
                let mode = self.mode()?;
                let Some(available) = book
                    .book_of(self.holds.terms, user_id, asset_id)
                    .map(|b| b.available)
                else {
                    return Err(partner_no(
                        "bank.card_partner_balance_not_known",
                        format!(
                            "The TEST card partner reports no {asset_id} balance, so it cannot hold. Nothing was held."
                        ),
                    ));
                };
                let want = amount_of(amount)?;
                if unlisted {
                    return Ok(Kept::Hold(HoldAnswer::Declined {
                        reason: UNLISTED_DECLINE.to_owned(),
                    }));
                }
                if want > available + credited {
                    return Ok(Kept::Hold(HoldAnswer::Declined {
                        reason: "bank.card_partner_insufficient_funds".to_owned(),
                    }));
                }
                let hold = self.take(book, key, user_id, asset_id, mode, want, None);
                let figures = self.figures_of(book, user_id, asset_id, credited);
                Ok(Kept::Hold(HoldAnswer::Approved { hold, figures }))
            },
        )?;
        match kept {
            Kept::Hold(a) => Ok(a),
            Kept::Move(_) => Err(key_conflict(key)),
        }
    }

    /// `holdInOrder`: hold the merchant's `amount` of `settlement` from the first asset in `order` that covers it at the
    /// partner's own rate, once under `key`. One asset only.
    pub fn hold_in_order(
        &self,
        key: &str,
        user_id: &str,
        order: &[String],
        settlement: &str,
        amount: &str,
    ) -> Result<HoldAnswer, PartnerErr> {
        self.guard("card_hold")?;
        let joined = order.join(",");
        let unlisted = self.unlisted(user_id);
        let switch_expired = self.holds.switch_expired(user_id);
        let credited: Vec<Amount> = order
            .iter()
            .map(|a| self.holds.credited(user_id, a))
            .collect();
        let quotes: Vec<Option<(Amount, String)>> = order
            .iter()
            .map(|a| match self.holds.quote(a, settlement) {
                Some(Ok(Some(q))) => parse_amount(&q.rate).ok().map(|r| (r, q.as_of)),
                _ => None,
            })
            .collect();
        let kept = self.once(
            key,
            body(&[
                ("op", "holdInOrder"),
                ("userId", user_id),
                ("order", &joined),
                ("settlementAssetId", settlement),
                ("amount", amount),
            ]),
            |book| {
                let mode = self.mode()?;
                let spend_from = self.holds.terms.spend_from.clone().unwrap_or_default();
                let merchant = amount_of(amount)?;
                if unlisted {
                    return Ok(Kept::Hold(HoldAnswer::Declined {
                        reason: UNLISTED_DECLINE.to_owned(),
                    }));
                }
                for ((asset_id, quote), credited) in order.iter().zip(&quotes).zip(&credited) {
                    let credited = *credited;
                    if !spend_from.contains(asset_id) {
                        continue;
                    }
                    if book.book_of(self.holds.terms, user_id, asset_id).is_none() {
                        continue;
                    }
                    let Some((rate, as_of)) = quote.clone() else {
                        continue;
                    };
                    let open: BTreeSet<String> = book
                        .books
                        .get(&book_id(user_id, asset_id))
                        .map(|b| b.open.clone())
                        .unwrap_or_default();
                    for k in open {
                        book.run_out(&k, self.holds.now, switch_expired);
                    }
                    let Ok(want) = funding_for(merchant, rate) else {
                        continue;
                    };
                    let available = book
                        .books
                        .get(&book_id(user_id, asset_id))
                        .map_or(0, |b| b.available);
                    if want <= 0 || want > available + credited {
                        continue;
                    }
                    let conversion = HoldConversion {
                        settlement_asset_id: settlement.to_owned(),
                        settlement_amount: format_amount(merchant),
                        rate: format_amount(rate),
                        rate_as_of: as_of,
                    };
                    let hold =
                        self.take(book, key, user_id, asset_id, mode, want, Some(conversion));
                    let figures = self.figures_of(book, user_id, asset_id, credited);
                    return Ok(Kept::Hold(HoldAnswer::Approved { hold, figures }));
                }
                Ok(Kept::Hold(HoldAnswer::Declined {
                    reason: "bank.card_insufficient_funds".to_owned(),
                }))
            },
        )?;
        match kept {
            Kept::Hold(a) => Ok(a),
            Kept::Move(_) => Err(key_conflict(key)),
        }
    }

    fn moved(&self, kept: Kept, key: &str) -> Result<MoveAnswer, PartnerErr> {
        match kept {
            Kept::Move(a) => Ok(a),
            Kept::Hold(_) => Err(key_conflict(key)),
        }
    }

    /// The user and asset a hold is in, read before its book is locked for the credited figure.
    fn owner_of(&self, hold_key: &str) -> Option<(String, String)> {
        self.holds
            .lock()
            .holds
            .get(hold_key)
            .map(|h| (h.user_id.clone(), h.asset_id.clone()))
    }

    fn credited_for(&self, hold_key: &str) -> Amount {
        self.owner_of(hold_key)
            .map_or(0, |(u, a)| self.holds.credited(&u, &a))
    }

    /// `capture`: capture `amount` of the hold, once under `key`. Above what is held, the partner refuses.
    pub fn capture(
        &self,
        key: &str,
        hold_key: &str,
        amount: &str,
    ) -> Result<MoveAnswer, PartnerErr> {
        self.guard("card_capture")?;
        let credited = self.credited_for(hold_key);
        let kept = self.once(
            key,
            body(&[("op", "capture"), ("holdKey", hold_key), ("amount", amount)]),
            |book| {
                let h = self.hold_for(book, hold_key)?;
                if h.captured > 0 || h.released > 0 {
                    let state = if h.expired {
                        "expired"
                    } else if h.captured > 0 {
                        "captured"
                    } else {
                        "released"
                    };
                    return Err(partner_no(
                        "bank.card_partner_hold_closed",
                        format!("The TEST card partner says {hold_key} is already {state}. Nothing moved."),
                    ));
                }
                let take = amount_of(amount)?;
                if take <= 0 || take > h.open() {
                    return Err(partner_no(
                        "bank.card_partner_capture_exceeds_hold",
                        format!(
                            "The TEST card partner refused a capture of {amount} against a hold of {}. Nothing moved.",
                            format_amount(h.open())
                        ),
                    ));
                }
                h.captured = take;
                let (user, asset, left) = (h.user_id.clone(), h.asset_id.clone(), h.open());
                let report = h.report();
                if let Some(b) = book.books.get_mut(&book_id(&user, &asset)) {
                    b.held -= take;
                    if left == 0 {
                        b.open.remove(hold_key);
                    }
                }
                let figures = self.figures_of(book, &user, &asset, credited);
                Ok(Kept::Move(MoveAnswer {
                    partner_ref: hold_ref(key),
                    amount: amount.to_owned(),
                    by: "instruction",
                    hold: report,
                    figures,
                }))
            },
        )?;
        self.moved(kept, key)
    }

    /// `release`: give back whatever of the hold is still open, once under `key`. A hold whose time ran out was given back
    /// by the partner itself, and the answer says so (`by: 'expiry'`).
    pub fn release(&self, key: &str, hold_key: &str) -> Result<MoveAnswer, PartnerErr> {
        self.guard("card_release")?;
        let credited = self.credited_for(hold_key);
        let kept = self.once(
            key,
            body(&[("op", "release"), ("holdKey", hold_key)]),
            |book| {
                let h = self.hold_for(book, hold_key)?;
                let (user, asset) = (h.user_id.clone(), h.asset_id.clone());
                if h.expired {
                    let answer = (
                        format!("{}:expired", h.partner_ref),
                        format_amount(h.released),
                        h.report(),
                    );
                    let figures = self.figures_of(book, &user, &asset, credited);
                    return Ok(Kept::Move(MoveAnswer {
                        partner_ref: answer.0,
                        amount: answer.1,
                        by: "expiry",
                        hold: answer.2,
                        figures,
                    }));
                }
                let back = h.open();
                if back == 0 {
                    return Err(partner_no(
                        "bank.card_partner_hold_closed",
                        format!(
                            "The TEST card partner holds nothing more on {hold_key}. Nothing moved."
                        ),
                    ));
                }
                h.released += back;
                let report = h.report();
                if let Some(b) = book.books.get_mut(&book_id(&user, &asset)) {
                    b.held -= back;
                    b.available += back;
                    b.open.remove(hold_key);
                }
                let figures = self.figures_of(book, &user, &asset, credited);
                Ok(Kept::Move(MoveAnswer {
                    partner_ref: hold_ref(key),
                    amount: format_amount(back),
                    by: "instruction",
                    hold: report,
                    figures,
                }))
            },
        )?;
        self.moved(kept, key)
    }

    /// `refund`: give `amount` of what was captured back to the partner balance, once under `key`.
    pub fn refund(
        &self,
        key: &str,
        hold_key: &str,
        amount: &str,
    ) -> Result<MoveAnswer, PartnerErr> {
        self.guard("card_refund")?;
        let credited = self.credited_for(hold_key);
        let kept = self.once(
            key,
            body(&[("op", "refund"), ("holdKey", hold_key), ("amount", amount)]),
            |book| {
                let h = self.hold_for(book, hold_key)?;
                let back = amount_of(amount)?;
                if back <= 0 || back > h.captured - h.refunded {
                    return Err(partner_no(
                        "bank.card_partner_refund_exceeds_capture",
                        format!(
                            "The TEST card partner refused a refund of {amount} against {} captured. Nothing moved.",
                            format_amount(h.captured - h.refunded)
                        ),
                    ));
                }
                h.refunded += back;
                let (user, asset) = (h.user_id.clone(), h.asset_id.clone());
                let report = h.report();
                if let Some(b) = book.books.get_mut(&book_id(&user, &asset)) {
                    b.available += back;
                }
                let figures = self.figures_of(book, &user, &asset, credited);
                Ok(Kept::Move(MoveAnswer {
                    partner_ref: hold_ref(key),
                    amount: amount.to_owned(),
                    by: "instruction",
                    hold: report,
                    figures,
                }))
            },
        )?;
        self.moved(kept, key)
    }

    /// `figures`, the read (open behind both guards).
    pub fn figures(&self, user_id: &str, asset_id: &str) -> Result<Figures, Refusal> {
        self.holds.figures(user_id, asset_id)
    }

    /// `holdState`, the read (open behind both guards).
    pub fn hold_state(&self, hold_key: &str) -> Result<Option<HoldReport>, Refusal> {
        self.holds.hold_state(hold_key)
    }
}

fn key_conflict(key: &str) -> PartnerErr {
    partner_no(
        "bank.card_partner_key_conflict",
        format!(
            "The TEST card partner already answered {key} for a different instruction. Nothing moved."
        ),
    )
}

/// The TEST partner card for one call, guarded, or none: no TEST partner, or no simulator to hold for it.
pub fn book<'a>(d: &'a crate::cards::Deps<'_>) -> Option<Book<'a>> {
    Some(Book {
        holds: crate::cards::reads::test_card_holds(d, &d.w.holds)?,
        store: d.store(),
        freeze: d.t.custody.freeze,
    })
}
