//! What the authorisations and the card partner say (`card-service.ts`: `authorizationsOf`, `recurringOf`,
//! `cashbackSummary`, `payFrom`, `setPayFromOrder`, `partnerQuotes`, `partnerBalances`, `partnerHeld`; `partner-terms.ts`:
//! `payFromAssets`, `assertPayFromOrder`, `requireSpendAssets`; the read side of `partner-card-holds.ts`; `rank-tier.ts`),
//! and the router's `cards.authorizations`, `cards.recurring`, `cards.cashback`, `cards.payFrom`,
//! `cards.setPayFromOrder` and `cards.partnerHeld`.
//!
//! Reads only, but for the saved pay-from order: nothing here holds, captures or posts. Every null is "not known",
//! never 0.
//!
//! The TEST partner card's book ([`CardHoldBook`]) lives in this process, as the TypeScript's `testPartnerCardHolds`
//! does, kept once in the slice's wiring (`Wiring::holds`). Its holds are made by slice `card-ops`' hold instruction
//! (`moves::partner_book`), and its reads run an uncaptured hold out at its time.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use postgres::GenericClient;
use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::CallSigner;
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};

use super::core::text;
use super::issuer::Issuer;
use super::terms::{CARD_TIERS, PartnerTerms, is_decimal};
use super::{Deps, RankTier, ms, own};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::pay_in::{self, PayInRail};
use crate::partner::{CardStep, TestPartner, money_held_by, refuse};
use crate::spaces::space::{owner_list_limit, pg, with};

// ---------------------------------------------------------------------------------------------------------------
// The partner card holds port, read side (`PartnerCardHolds`: `figures`, `holdState`, `quote`).

/// `PartnerCardFigures`: what the partner reports for one cardholder and asset. Each `None` is "not known".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Figures {
    pub test: bool,
    pub mode: Option<String>,
    pub asset_id: String,
    pub available: Option<String>,
    pub held: Option<String>,
}

impl Figures {
    /// `partnerFiguresOutput`, in its key order.
    pub fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
        Json::obj([
            ("test", Json::Bool(self.test)),
            ("mode", opt(&self.mode)),
            ("assetId", Json::str(self.asset_id.clone())),
            ("available", opt(&self.available)),
            ("held", opt(&self.held)),
        ])
    }
}

/// `PartnerHoldConversion`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldConversion {
    pub settlement_asset_id: String,
    pub settlement_amount: String,
    pub rate: String,
    pub rate_as_of: String,
}

/// `PartnerHoldReport`: one hold as the partner reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldReport {
    pub test: bool,
    pub partner_ref: String,
    pub mode: String,
    /// `held`, `captured`, `released` or `expired`.
    pub status: String,
    pub amount: String,
    pub captured: String,
    pub released: String,
    pub refunded: String,
    pub open: String,
    pub expires_at: Option<String>,
    pub asset_id: Option<String>,
    pub conversion: Option<HoldConversion>,
}

impl HoldReport {
    /// `partnerHoldReportOutput`, in its key order; the two optional keys only when the partner said them.
    pub fn json(&self) -> Json {
        let mut f = vec![
            ("test".to_owned(), Json::Bool(self.test)),
            ("partnerRef".to_owned(), Json::str(self.partner_ref.clone())),
            ("mode".to_owned(), Json::str(self.mode.clone())),
            ("status".to_owned(), Json::str(self.status.clone())),
            ("amount".to_owned(), Json::str(self.amount.clone())),
            ("captured".to_owned(), Json::str(self.captured.clone())),
            ("released".to_owned(), Json::str(self.released.clone())),
            ("refunded".to_owned(), Json::str(self.refunded.clone())),
            ("open".to_owned(), Json::str(self.open.clone())),
            (
                "expiresAt".to_owned(),
                self.expires_at.clone().map_or(Json::Null, Json::str),
            ),
        ];
        if let Some(a) = &self.asset_id {
            f.push(("assetId".to_owned(), Json::str(a.clone())));
        }
        if let Some(c) = &self.conversion {
            f.push((
                "conversion".to_owned(),
                Json::obj([
                    (
                        "settlementAssetId",
                        Json::str(c.settlement_asset_id.clone()),
                    ),
                    ("settlementAmount", Json::str(c.settlement_amount.clone())),
                    ("rate", Json::str(c.rate.clone())),
                    ("rateAsOf", Json::str(c.rate_as_of.clone())),
                ]),
            ));
        }
        Json::Object(f)
    }
}

/// `PartnerRateQuote`: one unit of an asset in a settlement asset, with the quote's own time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub rate: String,
    pub as_of: String,
}

/// The read side of `PartnerCardHolds`. Its reads stay open behind the posting freeze and the operator's stop
/// (`freezeGuardedCardHolds`, `stopGuardedCardHolds` pass `figures`, `holdState` and `quote` straight through), so no
/// guard stands in front of them here.
pub trait HoldReads {
    /// The partner's figures for this cardholder and asset.
    fn figures(&self, user_id: &str, asset_id: &str) -> Result<Figures, Refusal>;
    /// The hold as the partner reports it now, or `None` when it has no record of it.
    fn hold_state(&self, hold_key: &str) -> Result<Option<HoldReport>, Refusal>;
    /// The partner's quote, `Ok(None)` when it quotes none; `None` for a partner without quotes.
    fn quote(&self, _asset_id: &str, _settlement: &str) -> Option<Result<Option<Quote>, Refusal>> {
        None
    }
    /// What the partner captured for this cardholder in this asset, `Ok(None)` when it reports no book for them;
    /// `None` for a partner without the read.
    fn captured(&self, _user_id: &str, _asset_id: &str) -> Option<Result<Option<String>, Refusal>> {
        None
    }
}

/// `partnerCardKey('hold', authorizationId)`: our id, never the network's reference.
pub fn hold_key(authorization_id: &str) -> String {
    format!("card.partner.hold:{authorization_id}")
}

/// The TEST partner card's hold time, a TEST figure (`TEST_CARD_HOLD_DAYS`).
pub const TEST_CARD_HOLD_DAYS: i64 = 7;

/// One cardholder's book in one asset at the TEST partner card.
///
/// The TEST card draws on the person's own main account at the TEST partner in the card's asset when the partner holds
/// one for them (`drawn`): a hold leaves that account, a release, a hold time running out or a refund comes back to it,
/// each one partner move under the instruction's key, so the partner balance the person reads is what the card spends.
/// With no such account, the book starts at the TEST figure the TEST partner card reports for the asset. Which one a
/// book draws on is chosen while it holds nothing, so an open hold always goes back where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Book {
    /// True when the book draws on the person's own account at the TEST partner, not on a TEST figure.
    pub drawn: bool,
    /// The TEST figure's book only: what is left of it. A drawn book reads the partner account instead.
    pub available: Amount,
    pub held: Amount,
    /// The keys of this book's holds that still hold something.
    pub open: BTreeSet<String>,
}

/// One hold the TEST partner card took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hold {
    pub partner_ref: String,
    pub user_id: String,
    pub asset_id: String,
    pub mode: String,
    pub amount: Amount,
    pub expires_at: Instant,
    pub conversion: Option<HoldConversion>,
    pub captured: Amount,
    pub released: Amount,
    pub refunded: Amount,
    pub expired: bool,
    /// Whether the book it holds from was drawn on the partner account when it was taken (`hold.book.drawn`): what it
    /// gives back goes back there, whatever book the person has since.
    pub drawn: bool,
}

impl Hold {
    pub(crate) fn open(&self) -> Amount {
        self.amount - self.captured - self.released
    }

    pub(crate) fn report(&self) -> HoldReport {
        let status = if self.expired {
            "expired"
        } else if self.captured > Amount::ZERO {
            "captured"
        } else if self.released > Amount::ZERO {
            "released"
        } else {
            "held"
        };
        HoldReport {
            test: true,
            partner_ref: self.partner_ref.clone(),
            mode: self.mode.clone(),
            status: status.to_owned(),
            amount: format_amount(self.amount),
            captured: format_amount(self.captured),
            released: format_amount(self.released),
            refunded: format_amount(self.refunded),
            open: format_amount(self.open()),
            expires_at: Some(self.expires_at.iso()),
            asset_id: Some(self.asset_id.clone()),
            conversion: self.conversion.clone(),
        }
    }
}

/// The TEST partner card's in-process state: each cardholder's book per asset (`user|asset`), and each hold by its key.
#[derive(Debug, Default)]
pub struct CardHoldBook {
    pub books: BTreeMap<String, Book>,
    pub holds: BTreeMap<String, Hold>,
    /// Each instruction's first answer under its key, with the body it answered (`once`): slice `card-ops`' writes.
    pub answers: BTreeMap<String, (String, super::moves::partner_book::Kept)>,
}

pub(crate) fn book_id(user_id: &str, asset_id: &str) -> String {
    format!("{user_id}|{asset_id}")
}

/// `TestPartnerCardFunds`: the person's own main account at the TEST partner a card draws on, for one call.
#[derive(Clone, Copy)]
pub struct CardFunds<'a> {
    pub partner: Option<&'a TestPartner>,
    pub now: Instant,
}

impl CardFunds<'_> {
    /// No partner account to draw on: every book keeps to the TEST figure.
    pub const NONE: CardFunds<'static> = CardFunds {
        partner: None,
        now: Instant(0),
    };

    /// `available`: what the person's main account in `asset_id` holds now, `None` when the partner holds none.
    pub fn available(&self, user_id: &str, asset_id: &str) -> Option<Amount> {
        self.partner?.lock().card_available(user_id, asset_id)
    }

    /// `move`: one card step as one partner move under `key`; a key the partner already holds moves nothing more.
    pub fn move_funds(
        &self,
        key: &str,
        step: CardStep,
        user_id: &str,
        asset_id: &str,
        amount: Amount,
    ) -> Result<(), Refusal> {
        match self.partner {
            Some(p) => p
                .lock()
                .card_move(key, step, user_id, asset_id, amount, self.now),
            None => Ok(()),
        }
    }
}

impl CardHoldBook {
    /// `bookOf` with no partner account: the kept book, or one started from the TEST figure; `None` when the partner
    /// reports no figure.
    pub fn book_of(
        &mut self,
        terms: &PartnerTerms,
        user_id: &str,
        asset_id: &str,
    ) -> Option<&mut Book> {
        self.book_at(terms, user_id, asset_id, None)
    }

    /// `bookOf`: a book that holds nothing follows the partner account (`account`, `None` when the partner holds no
    /// such account): drawn once the partner holds one, the TEST figure without. A book that holds something is kept
    /// as it is, so an open hold always goes back where it came from.
    pub fn book_at(
        &mut self,
        terms: &PartnerTerms,
        user_id: &str,
        asset_id: &str,
        account: Option<Amount>,
    ) -> Option<&mut Book> {
        let id = book_id(user_id, asset_id);
        let has_account = account.is_some();
        let keep = self
            .books
            .get(&id)
            .is_some_and(|b| b.held > Amount::ZERO || !b.open.is_empty() || b.drawn == has_account);
        if !keep {
            if has_account {
                self.books.insert(
                    id.clone(),
                    Book {
                        drawn: true,
                        available: Amount::ZERO,
                        held: Amount::ZERO,
                        open: BTreeSet::new(),
                    },
                );
            } else if !self.books.contains_key(&id) {
                let available = parse_amount(terms.balance(asset_id)?).ok()?;
                self.books.insert(
                    id.clone(),
                    Book {
                        drawn: false,
                        available,
                        held: Amount::ZERO,
                        open: BTreeSet::new(),
                    },
                );
            }
        }
        self.books.get_mut(&id)
    }

    /// `bookOf` over the partner's own account, then what the book has: `freeIn` (the partner account's figure when
    /// drawn, else what is left of the TEST figure), what it holds, and whether it is drawn. `None` when there is no book.
    pub(crate) fn standing(
        &mut self,
        terms: &PartnerTerms,
        funds: &CardFunds<'_>,
        user_id: &str,
        asset_id: &str,
    ) -> Option<(Amount, Amount, bool)> {
        let account = funds.available(user_id, asset_id);
        let b = self.book_at(terms, user_id, asset_id, account)?;
        let free = if b.drawn {
            account.unwrap_or(Amount::ZERO)
        } else {
            b.available
        };
        Some((free, b.held, b.drawn))
    }

    /// `spendable` and what is held: the book's own free figure and anything else the partner credited the cardholder;
    /// a drawn book spends what the account holds and nothing beside it (`compose.ts`: `drawn ? 0n : ...`).
    pub(crate) fn spendable(
        &mut self,
        terms: &PartnerTerms,
        funds: &CardFunds<'_>,
        user_id: &str,
        asset_id: &str,
        credited: Amount,
    ) -> Option<(Amount, Amount)> {
        self.standing(terms, funds, user_id, asset_id)
            .map(|(free, held, drawn)| (if drawn { free } else { free + credited }, held))
    }

    /// `holdFrom`: money leaves the free figure into a hold under `key`: one partner move when the book is drawn, else
    /// off the TEST figure. The caller has the book (`book_at`) and has checked it covers `amount`.
    pub(crate) fn hold_from(
        &mut self,
        funds: &CardFunds<'_>,
        user_id: &str,
        asset_id: &str,
        amount: Amount,
        key: &str,
    ) -> Result<bool, Refusal> {
        let id = book_id(user_id, asset_id);
        let drawn = self.books.get(&id).is_some_and(|b| b.drawn);
        if drawn {
            funds.move_funds(key, CardStep::Hold, user_id, asset_id, amount)?;
        }
        if let Some(b) = self.books.get_mut(&id) {
            if !drawn {
                b.available -= amount;
            }
            b.held += amount;
            b.open.insert(key.to_owned());
        }
        Ok(drawn)
    }

    /// `giveBack`: money comes back from a hold to where it came from under `key`: one partner move when the hold was
    /// drawn, else onto the TEST figure (of a book the TEST figure still keeps).
    pub(crate) fn give_back(
        &mut self,
        funds: &CardFunds<'_>,
        hold_key: &str,
        amount: Amount,
        key: &str,
        step: CardStep,
    ) -> Result<(), Refusal> {
        let Some(h) = self.holds.get(hold_key) else {
            return Ok(());
        };
        if h.drawn {
            return funds.move_funds(key, step, &h.user_id, &h.asset_id, amount);
        }
        if let Some(b) = self.books.get_mut(&book_id(&h.user_id, &h.asset_id))
            && !b.drawn
        {
            b.available += amount;
        }
        Ok(())
    }

    /// `runOut`: the partner gives an uncaptured hold back when its hold time runs out, or when the person's TEST
    /// switch says so, under `<partner ref>:expired`.
    pub(crate) fn run_out(
        &mut self,
        key: &str,
        now: Instant,
        switch_expired: bool,
        funds: &CardFunds<'_>,
    ) -> Result<(), Refusal> {
        let Some(h) = self.holds.get(key) else {
            return Ok(());
        };
        if h.expired || h.captured > Amount::ZERO || h.open() == Amount::ZERO {
            return Ok(());
        }
        if now.0 < h.expires_at.0 && !switch_expired {
            return Ok(());
        }
        let back = h.open();
        let move_key = format!("{}:expired", h.partner_ref);
        let id = book_id(&h.user_id, &h.asset_id);
        self.give_back(funds, key, back, &move_key, CardStep::Release)?;
        if let Some(h) = self.holds.get_mut(key) {
            h.released += back;
            h.expired = true;
        }
        if let Some(b) = self.books.get_mut(&id) {
            b.held -= back;
            b.open.remove(key);
        }
        Ok(())
    }
}

/// The TEST partner card (`testPartnerCardHolds`), read side, over its book for one call.
pub struct TestCardHolds<'a> {
    pub book: &'a Mutex<CardHoldBook>,
    /// The TEST partner card's answers (`cardIssuer.partnerTerms()`).
    pub terms: &'a PartnerTerms,
    /// The TEST partner: each person's `cardHold` switch.
    pub partner: Option<&'a TestPartner>,
    /// The issuer: the TEST partner's provisional dispute credits.
    pub issuer: &'a Issuer,
    /// The TEST pay-in: what the person paid themselves shows on the card (J-bank-31 #4).
    pub pay_in: Option<&'a PayInRail>,
    pub now: Instant,
}

impl TestCardHolds<'_> {
    /// The TEST partner's card funds (`testPartner.cardFunds`), at this call's time.
    pub fn funds(&self) -> CardFunds<'_> {
        CardFunds {
            partner: self.partner,
            now: self.now,
        }
    }

    pub(crate) fn switch_expired(&self, user_id: &str) -> bool {
        self.partner
            .is_some_and(|p| p.switches(user_id).card_hold == "expired")
    }

    /// `testCardCredited` plus `payInCredited`: what else the TEST partner credited this cardholder in this asset.
    pub(crate) fn credited(&self, user_id: &str, asset_id: &str) -> Amount {
        let mut sum: Amount = Amount::ZERO;
        if let Some(book) = self.issuer.sim_book() {
            for (_, c) in &book.credits {
                if c.user_id == user_id && c.asset_id == asset_id && !c.reversed {
                    sum += c.amount;
                }
            }
        }
        if let Some(rail) = self.pay_in
            && asset_id == pay_in::ASSET
        {
            for k in rail.credits(user_id).0 {
                if k.available_at.is_some() {
                    sum += k.amount;
                }
            }
        }
        sum
    }

    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, CardHoldBook> {
        self.book
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl HoldReads for TestCardHolds<'_> {
    fn figures(&self, user_id: &str, asset_id: &str) -> Result<Figures, Refusal> {
        let switch_expired = self.switch_expired(user_id);
        let credited = self.credited(user_id, asset_id);
        let funds = self.funds();
        let mut book = self.lock();
        let open: Vec<String> = book
            .books
            .get(&book_id(user_id, asset_id))
            .map(|b| b.open.iter().cloned().collect())
            .unwrap_or_default();
        for key in open {
            book.run_out(&key, self.now, switch_expired, &funds)?;
        }
        let figures = book
            .spendable(self.terms, &funds, user_id, asset_id, credited)
            .map(|(available, held)| (format_amount(available), format_amount(held)));
        Ok(Figures {
            test: true,
            mode: self.terms.custody_mode.clone(),
            asset_id: asset_id.to_owned(),
            available: figures.as_ref().map(|f| f.0.clone()),
            held: figures.map(|f| f.1),
        })
    }

    /// `captured`: every hold's captured part, once the partner keeps a book for this cardholder and asset.
    fn captured(&self, user_id: &str, asset_id: &str) -> Option<Result<Option<String>, Refusal>> {
        let funds = self.funds();
        let mut book = self.lock();
        if book
            .standing(self.terms, &funds, user_id, asset_id)
            .is_none()
        {
            return Some(Ok(None));
        }
        let sum: Amount = book
            .holds
            .values()
            .filter(|h| h.user_id == user_id && h.asset_id == asset_id)
            .map(|h| h.captured)
            .sum();
        Some(Ok(Some(format_amount(sum))))
    }

    fn hold_state(&self, hold_key: &str) -> Result<Option<HoldReport>, Refusal> {
        let user = self.lock().holds.get(hold_key).map(|h| h.user_id.clone());
        let Some(user) = user else {
            return Ok(None);
        };
        let switch_expired = self.switch_expired(&user);
        let funds = self.funds();
        let mut book = self.lock();
        book.run_out(hold_key, self.now, switch_expired, &funds)?;
        Ok(book.holds.get(hold_key).map(Hold::report))
    }

    /// `quoteOf`: its own TEST rate, stamped with its clock now; with any rates reported, the asset they are in is 1.
    fn quote(&self, asset_id: &str, settlement: &str) -> Option<Result<Option<Quote>, Refusal>> {
        let quoted = self
            .terms
            .rates
            .as_ref()
            .filter(|r| r.in_asset == settlement)
            .and_then(|r| {
                if asset_id == settlement {
                    return Some("1".to_owned());
                }
                r.per_unit
                    .iter()
                    .find(|(a, _)| a == asset_id)
                    .map(|(_, v)| v.clone())
            })
            .and_then(|raw| parse_amount(&raw).ok());
        Some(Ok(quoted.map(|rate| Quote {
            rate: format_amount(rate),
            as_of: self.now.iso(),
        })))
    }
}

/// `partnerHolds`: the TEST partner card, only with the TEST partner and the simulator both chosen (not in a live
/// posture), as `composeCardsArea` builds it.
pub fn test_card_holds<'a>(
    d: &'a Deps<'_>,
    book: &'a Mutex<CardHoldBook>,
) -> Option<TestCardHolds<'a>> {
    let partner = d.t.partner.partner.as_ref()?;
    let terms = d.issuer().sim_partner()?;
    Some(TestCardHolds {
        book,
        terms,
        partner: Some(partner),
        issuer: d.issuer(),
        pay_in: d.t.partner.pay_in.as_ref(),
        now: d.now(),
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The owner's spendable assets and the pay-from order (`partner-terms.ts`).

/// `NOT_USED_FOR_CARDS`.
pub const NOT_USED_FOR_CARDS: [&str; 2] = ["trading", "agent"];

/// `requireSpendAssets`.
pub fn require_spend_assets(list: Option<&Vec<String>>) -> Result<&Vec<String>, Refusal> {
    list.ok_or_else(|| {
        refuse(
            "bank.card_spend_assets_unset",
            "The list of assets a card may pay from is not published: it is the owner\u{2019}s to set (bank.card_spend_assets_unset).",
        )
    })
}

/// `PayFromAsset`: the asset and `offered`, `not_offered`, `not_known` or `not_listed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayFromAsset {
    pub asset_id: String,
    pub state: &'static str,
}

/// `payFromAssets`: every asset on the owner's list, then every other the person's cards draw on.
pub fn pay_from_assets(
    owner: &[String],
    terms: &PartnerTerms,
    held: &[String],
) -> Vec<PayFromAsset> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for asset in owner.iter().chain(held) {
        if !seen.insert(asset.clone()) {
            continue;
        }
        let listed = owner.contains(asset);
        let state = match &terms.spend_from {
            None if listed => "not_known",
            None => "not_listed",
            Some(list) if !list.contains(asset) => "not_offered",
            Some(_) if listed => "offered",
            Some(_) => "not_listed",
        };
        out.push(PayFromAsset {
            asset_id: asset.clone(),
            state,
        });
    }
    out
}

/// `assertPayFromOrder`: at least one asset, none twice, each one the partner can spend from and the owner lists.
pub fn assert_pay_from_order(order: &[String], rows: &[PayFromAsset]) -> Result<(), Refusal> {
    let distinct: BTreeSet<&String> = order.iter().collect();
    if order.is_empty() || distinct.len() != order.len() {
        return Err(refuse(
            "bank.card_pay_from_order_invalid",
            "A pay-from order names each asset once, and at least one (bank.card_pay_from_order_invalid)",
        ));
    }
    for asset in order {
        if !rows
            .iter()
            .any(|r| &r.asset_id == asset && r.state == "offered")
        {
            return Err(refuse(
                "bank.card_pay_from_not_offered",
                format!(
                    "{asset} is not an asset the card partner can spend from for this card programme (bank.card_pay_from_not_offered)"
                ),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Pay from (J-bank-29 #1, #2).

/// `DisplayMark`: a price and the time its source stamped it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub price: Amount,
    pub as_of: Instant,
}

/// `DEFAULT_CARD_CONVERSION_POLICY.maxAgeSeconds`.
pub const CONVERSION_MAX_AGE_SECONDS: i64 = 60;

/// `acceptableForMarking` under the card conversion policy: above zero, no older than its window, no more than 30 s in
/// the future.
pub fn acceptable_for_marking(price: Amount, as_of: Instant, now: Instant) -> bool {
    if price <= Amount::ZERO {
        return false;
    }
    let age_ms = now.0 - as_of.0;
    // `ageSeconds > maxAgeSeconds` and `ageSeconds < -30`, on milliseconds as the TypeScript divides them.
    (-30_000..=CONVERSION_MAX_AGE_SECONDS * 1000).contains(&age_ms)
}

/// `partnerQuotes`: the partner's own quote for each asset, when it is a plain decimal with a readable, fresh time; a
/// partner that quotes none, or cannot answer, leaves the rate "not known".
pub fn partner_quotes(
    holds: Option<&dyn HoldReads>,
    assets: &[String],
    settlement: &str,
    now: Instant,
) -> BTreeMap<String, Mark> {
    let mut out = BTreeMap::new();
    let Some(holds) = holds else {
        return out;
    };
    for asset in assets {
        let Some(Ok(Some(q))) = holds.quote(asset, settlement) else {
            continue;
        };
        if !is_decimal(&q.rate) {
            continue;
        }
        let (Some(as_of), Ok(price)) = (js_date(&q.as_of), parse_amount(&q.rate)) else {
            continue;
        };
        if acceptable_for_marking(price, as_of, now) {
            out.insert(asset.clone(), Mark { price, as_of });
        }
    }
    out
}

/// What the issuer reported a cardholder can spend, kept only where it is a plain decimal (`partnerBalances`' last step).
/// A partner that does not answer reads `None`; no issuer, or the simulator in a live posture, is the blocker to name.
pub fn reported_balances(
    reported: Result<Option<Vec<(String, String)>>, Refusal>,
) -> Result<Option<BTreeMap<String, String>>, Refusal> {
    let reported = match reported {
        Ok(r) => r,
        Err(Refusal::Bank(e))
            if e.row.code == "bank.no_card_issuer" || e.row.code == "bank.card_sim_not_live" =>
        {
            return Err(Refusal::Bank(e));
        }
        Err(_) => return Ok(None),
    };
    Ok(reported.map(|list| list.into_iter().filter(|(_, v)| is_decimal(v)).collect()))
}

/// `partnerBalances`: with a partner that holds the card money, its own live figure for each asset; otherwise the
/// issuer's reported list.
pub fn partner_balances(
    d: &Deps<'_>,
    holds: Option<&dyn HoldReads>,
    user_id: &str,
    assets: &[String],
) -> Result<Option<BTreeMap<String, String>>, Refusal> {
    if let Some(holds) = holds
        && !assets.is_empty()
    {
        let mut live = BTreeMap::new();
        for asset in assets {
            if let Ok(f) = holds.figures(user_id, asset)
                && let Some(a) = f.available.filter(|a| is_decimal(a))
            {
                live.insert(asset.clone(), a);
            }
        }
        return Ok(Some(live));
    }
    reported_balances(d.issuer().cardholder_balances(user_id))
}

fn opt_str(v: Option<String>) -> Json {
    v.map_or(Json::Null, Json::str)
}

/// `payFrom`: the owner's spendable assets and any other the person's open cards draw on, each with its state, the
/// partner's balance and the partner's rate with its time; the saved order; the account kinds a card never pays from.
pub fn pay_from(
    d: &Deps<'_>,
    holds: Option<&dyn HoldReads>,
    user_id: &str,
) -> Result<Json, Refusal> {
    // The partner first: with no issuer, or the simulator in a live deployment, that is the blocker to name.
    let terms = d.issuer().partner_terms()?;
    let owner = require_spend_assets(d.settings().spend_assets.as_ref())?.clone();
    let (cards, saved) = with(d.store(), |c| {
        let cards: Vec<(String, String)> = c
            .query(
                "SELECT asset_id, settlement_asset_id FROM bank.cards WHERE user_id = $1 AND status <> 'closed' \
                 ORDER BY created_at, id",
                &[&user_id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect();
        let saved: Option<Vec<String>> = c
            .query(
                "SELECT asset_ids FROM bank.card_pay_from_orders WHERE user_id = $1",
                &[&user_id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| r.get(0));
        Ok((cards, saved))
    })?;
    let held: Vec<String> = cards
        .iter()
        .map(|(a, _)| a.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let states = pay_from_assets(&owner, &terms, &held);
    let offered: Vec<String> = states
        .iter()
        .filter(|a| a.state == "offered")
        .map(|a| a.asset_id.clone())
        .collect();
    // One settlement asset to quote in: the one every open card settles in; none, or several, and the rate is "not known".
    let mut settlements: Vec<&String> = Vec::new();
    for (_, s) in &cards {
        if !settlements.contains(&s) {
            settlements.push(s);
        }
    }
    let settlement = match settlements.as_slice() {
        [one] => Some((*one).clone()),
        _ => None,
    };
    let marks = settlement
        .as_deref()
        .map(|s| partner_quotes(holds, &offered, s, d.now()))
        .unwrap_or_default();
    let balances = partner_balances(d, holds, user_id, &offered)?;
    let assets = states
        .iter()
        .map(|a| {
            let offered = a.state == "offered";
            let mark = marks.get(&a.asset_id).filter(|_| offered);
            let balance = balances
                .as_ref()
                .and_then(|b| b.get(&a.asset_id))
                .filter(|_| offered)
                .cloned();
            Json::obj([
                ("assetId", Json::str(a.asset_id.clone())),
                ("state", Json::str(a.state)),
                ("partnerBalance", opt_str(balance)),
                ("rate", opt_str(mark.map(|m| format_amount(m.price)))),
                ("rateAsOf", opt_str(mark.map(|m| m.as_of.iso()))),
            ])
        })
        .collect();
    Ok(Json::obj([
        ("test", Json::Bool(terms.test)),
        ("custodyMode", opt_str(terms.custody_mode.clone())),
        ("settlementAssetId", opt_str(settlement)),
        ("assets", Json::Array(assets)),
        (
            "order",
            saved.map_or(Json::Null, |o| {
                Json::Array(o.into_iter().map(Json::str).collect())
            }),
        ),
        (
            "notUsedForCards",
            Json::Array(NOT_USED_FOR_CARDS.iter().map(|k| Json::str(*k)).collect()),
        ),
    ]))
}

/// `setPayFromOrder`: save the order once each asset is one the owner lists and the partner can spend from; the same
/// order again changes nothing. Moves no value.
pub fn set_pay_from_order(
    d: &Deps<'_>,
    holds: Option<&dyn HoldReads>,
    user_id: &str,
    order: &[String],
) -> Result<Json, Refusal> {
    let terms = d.issuer().partner_terms()?;
    let owner = require_spend_assets(d.settings().spend_assets.as_ref())?;
    assert_pay_from_order(order, &pay_from_assets(owner, &terms, &[]))?;
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.card_pay_from_orders (user_id, asset_ids) VALUES ($1, $2::text[]) \
             ON CONFLICT (user_id) DO UPDATE SET asset_ids = EXCLUDED.asset_ids, updated_at = now() \
             WHERE bank.card_pay_from_orders.asset_ids IS DISTINCT FROM EXCLUDED.asset_ids",
            &[&user_id, &order],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    pay_from(d, holds, user_id)
}

// ---------------------------------------------------------------------------------------------------------------
// The card's authorisations, recurring payments and the partner's holds.

/// `assertCardAuthorizationsListLimit`.
pub fn authorizations_list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(
        limit,
        "bank.card_authorizations_list_limit_unset",
        "cards.authorizations",
    )
}

fn amount_text(s: &str) -> Result<String, Refusal> {
    parse_amount(s).map(format_amount).map_err(Refusal::Other)
}

fn opt_amount_text(s: Option<String>) -> Result<Json, Refusal> {
    s.map(|s| amount_text(&s).map(Json::str))
        .transpose()
        .map(|v| v.unwrap_or(Json::Null))
}

/// `parseChannel`.
pub(crate) fn channel(v: &str) -> &str {
    match v {
        "online" | "contactless" | "atm" | "foreign" | "card-present" => v,
        _ => "card-present",
    }
}

/// `authorizationsOf` and the router's shape: the card's decisions, newest first, each with its refund, its pay-from
/// order, what was captured and returned of it, and its conversion.
pub fn authorizations(
    c: &mut impl GenericClient,
    card_id: &str,
    page: i64,
) -> Result<Json, Refusal> {
    let sql = format!(
        "SELECT a.id::text, a.authorization_ref, a.amount::text, a.merchant_category, a.merchant, a.merchant_country, \
                a.channel, a.recurring, a.decision::text, a.decline_code, a.status::text, a.money_book, \
                a.pay_from_order, {decided}, \
                c.settlement_asset_id, c.settlement_amount::text, c.funding_asset_id, c.funding_amount::text, \
                c.rate::text, c.rate_quality, {rate_as_of}, \
                r.amount::text, r.status::text, {refund_at}, \
                (SELECT s.amount::text FROM bank.card_settlements s \
                  WHERE s.authorization_id = a.id AND s.kind = 'capture' AND s.status = 'settled' ORDER BY s.sequence LIMIT 1), \
                (SELECT sum(s.amount)::text FROM bank.card_settlements s \
                  WHERE s.authorization_id = a.id AND s.kind = 'reversal' AND s.status = 'settled') \
           FROM bank.card_authorizations a \
           LEFT JOIN bank.card_conversions c ON c.authorization_id = a.id \
           LEFT JOIN bank.card_partner_refunds r ON r.authorization_id = a.id \
          WHERE a.card_id = $1::text::uuid \
          ORDER BY a.decided_at DESC \
          LIMIT $2",
        decided = ms("a.decided_at"),
        rate_as_of = ms("c.rate_as_of"),
        refund_at = ms("coalesce(r.settled_at, r.created_at)"),
    );
    let rows = c.query(&sql, &[&card_id, &page]).map_err(|e| pg(&e))?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let o = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let t = |i: usize| -> Result<Option<i64>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let pay_from_order: Option<Vec<String>> = r.try_get(12).map_err(|e| pg(&e))?;
        let decided_at = r.try_get::<_, i64>(13).map_err(|e| pg(&e))?;
        // The conversion: every column present together, or none.
        let conversion = match (o(14)?, o(15)?, o(16)?, o(17)?, o(18)?, o(19)?, t(20)?) {
            (Some(sa), Some(samt), Some(fa), Some(famt), Some(rate), Some(q), Some(at)) => {
                Some((sa, samt, fa, famt, rate, q, at))
            }
            _ => None,
        };
        let refund = match (o(21)?, o(22)?, t(23)?) {
            (Some(amount), Some(status), Some(at)) => Json::obj([
                ("amount", Json::str(amount_text(&amount)?)),
                ("status", Json::str(status)),
                ("at", Json::str(Instant(at).iso())),
            ]),
            _ => Json::Null,
        };
        let pay_from = match pay_from_order {
            None => Json::Null,
            Some(order) => Json::obj([
                (
                    "order",
                    Json::Array(order.into_iter().map(Json::str).collect()),
                ),
                (
                    "assetId",
                    conversion
                        .as_ref()
                        .filter(|c| c.5 == "partner")
                        .map_or(Json::Null, |c| Json::str(c.2.clone())),
                ),
                ("captured", opt_amount_text(o(24)?)?),
                ("returned", opt_amount_text(o(25)?)?),
            ]),
        };
        let conversion = match conversion {
            None => Json::Null,
            Some((sa, samt, _, _, rate, q, at)) => Json::obj([
                ("settlementAssetId", Json::str(sa)),
                ("settlementAmount", Json::str(amount_text(&samt)?)),
                ("rate", Json::str(amount_text(&rate)?)),
                ("rateQuality", Json::str(q)),
                ("rateAsOf", Json::str(Instant(at).iso())),
            ]),
        };
        out.push(Json::obj([
            ("id", Json::str(g(0)?)),
            ("authorizationRef", Json::str(g(1)?)),
            ("amount", Json::str(amount_text(&g(2)?)?)),
            ("merchantCategory", opt_str(o(3)?)),
            ("merchant", opt_str(o(4)?)),
            ("merchantCountry", opt_str(o(5)?)),
            ("channel", Json::str(channel(&g(6)?))),
            (
                "recurring",
                Json::Bool(r.try_get::<_, bool>(7).map_err(|e| pg(&e))?),
            ),
            ("decision", Json::str(g(8)?)),
            ("declineCode", opt_str(o(9)?)),
            ("status", Json::str(g(10)?)),
            ("refund", refund),
            ("heldBy", Json::str(g(11)?)),
            ("payFrom", pay_from),
            ("decidedAt", Json::str(Instant(decided_at).iso())),
            ("conversion", conversion),
        ]));
    }
    Ok(Json::Array(out))
}

/// `recurringOf`: the approved payments the issuer flagged as recurring, one row per merchant, newest first.
pub fn recurring(c: &mut impl GenericClient, card_id: &str, page: i64) -> Result<Json, Refusal> {
    let sql = format!(
        "SELECT a.merchant, a.merchant_country, count(*)::int8, {first}, {last}, \
                (array_agg(a.amount::text ORDER BY a.decided_at DESC))[1] \
           FROM bank.card_authorizations a \
          WHERE a.card_id = $1::text::uuid AND a.recurring AND a.decision = 'approved' \
          GROUP BY a.merchant, a.merchant_country \
          ORDER BY max(a.decided_at) DESC \
          LIMIT $2",
        first = ms("min(a.decided_at)"),
        last = ms("max(a.decided_at)"),
    );
    let rows = c.query(&sql, &[&card_id, &page]).map_err(|e| pg(&e))?;
    rows.iter()
        .map(|r| {
            let o =
                |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
            let n = |i: usize| -> Result<i64, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
            Ok(Json::obj([
                ("merchant", opt_str(o(0)?)),
                ("merchantCountry", opt_str(o(1)?)),
                ("payments", Json::int(n(2)?)),
                ("firstAt", Json::str(Instant(n(3)?).iso())),
                ("lastAt", Json::str(Instant(n(4)?).iso())),
                (
                    "lastAmount",
                    Json::str(amount_text(&o(5)?.unwrap_or_default())?),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Json::Array)
}

/// `partnerHeld`: whose book a new authorisation is held in now, the partner's figures for the card's asset, and each
/// partner-held authorisation as the partner reports it now. A partner with no record of a hold reads null.
pub fn partner_held(
    d: &Deps<'_>,
    holds: Option<&dyn HoldReads>,
    card_id: &str,
    limit: Option<f64>,
) -> Result<Json, Refusal> {
    let card = super::read_card(d, card_id)?;
    let page = authorizations_list_limit(limit)?;
    let held_by = money_held_by(
        d.t.partner.partner.as_ref(),
        &card.user_id,
        &d.t.partner.custody_layer,
    );
    let rows: Vec<(String, String, String)> = with(d.store(), |c| {
        Ok(c.query(
            "SELECT id::text, authorization_ref, amount::text FROM bank.card_authorizations \
              WHERE card_id = $1::text::uuid AND money_book = 'partner' AND decision = 'approved' \
                AND partner_hold_ref IS NOT NULL \
              ORDER BY decided_at DESC \
              LIMIT $2",
            &[&card.id, &page],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect())
    })?;
    let mut authorizations = Vec::with_capacity(rows.len());
    for (id, reference, amount) in rows {
        let report = match holds {
            Some(h) => h
                .hold_state(&hold_key(&id))?
                .map_or(Json::Null, |r| r.json()),
            None => Json::Null,
        };
        authorizations.push(Json::obj([
            ("authorizationId", Json::str(id)),
            ("authorizationRef", Json::str(reference)),
            ("amount", Json::str(amount_text(&amount)?)),
            ("report", report),
        ]));
    }
    let figures = match holds {
        Some(h) => h.figures(&card.user_id, &card.asset_id)?.json(),
        None => Json::Null,
    };
    Ok(Json::obj([
        ("heldBy", Json::str(held_by)),
        ("figures", figures),
        ("authorizations", Json::Array(authorizations)),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// Cashback by rank card tier (RC-bank-02, J-bank-13 #7).

/// `rewardsIssuerConnected` asked of a card of this programme: the simulator pays only behind its TEST stand-in.
fn paying(d: &Deps<'_>) -> bool {
    let p = d.issuer().programme();
    if d.settings().simulator_pays && p.id == "card-sim" {
        return true;
    }
    // A simulated programme, `none` and `card-sim` never pay; no live issuer exists.
    !(p.simulated || p.id == "none" || p.id == "card-sim")
}

/// `cashbackSummary`: the caller's tier and its rate, every tier's rate, the asset it is paid in, the totals over every
/// reward record, the last 50 records, whether this programme pays at all, and whether it is simulated.
pub fn cashback(d: &Deps<'_>, user_id: &str) -> Result<Json, Refusal> {
    let Some(rates) = d.settings().cashback_rates.as_ref() else {
        return Err(refuse(
            "bank.cashback_rate_unset",
            "The owner has not published cashback rates by card tier",
        ));
    };
    let tier = d.w.rank.card_tier_of(user_id)?;
    let (payments, totals) = with(d.store(), |c| {
        let sql = "SELECT cb.authorization_id::text, a.card_id::text, cb.amount::text, cb.status::text, cb.rejection_code, \
                    cb.ledger_tx_id, cb.paid_by, cb.announced_at IS NOT NULL \
               FROM bank.card_cashback cb \
               JOIN bank.card_authorizations a ON a.id = cb.authorization_id \
               JOIN bank.cards c ON c.id = a.card_id \
              WHERE c.user_id = $1 AND c.asset_id = $2 \
              ORDER BY cb.created_at DESC \
              LIMIT 50";
        let rows = c
            .query(sql, &[&user_id, &rates.asset_id])
            .map_err(|e| pg(&e))?;
        let mut payments = Vec::with_capacity(rows.len());
        for r in &rows {
            let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
            let o =
                |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
            payments.push(Json::obj([
                ("authorizationId", Json::str(g(0)?)),
                ("cardId", Json::str(g(1)?)),
                ("amount", Json::str(amount_text(&g(2)?)?)),
                ("status", Json::str(g(3)?)),
                ("rejectionCode", opt_str(o(4)?)),
                ("ledgerTxId", opt_str(o(5)?)),
                ("paidBy", Json::str(g(6)?)),
                (
                    "announced",
                    Json::Bool(r.try_get::<_, bool>(7).map_err(|e| pg(&e))?),
                ),
            ]));
        }
        let t = c
            .query_one(
                "SELECT COALESCE(SUM(cb.amount) FILTER (WHERE cb.paid_by = 'ledger' AND cb.status = 'settled'), 0)::text, \
                        COALESCE(SUM(cb.amount) FILTER (WHERE cb.paid_by = 'ledger' AND cb.status = 'pending'), 0)::text, \
                        COALESCE(SUM(cb.amount) FILTER (WHERE cb.paid_by = 'ledger' AND cb.status = 'rejected'), 0)::text, \
                        COALESCE(SUM(cb.amount) FILTER (WHERE cb.paid_by = 'wallet'), 0)::text \
                   FROM bank.card_cashback cb \
                   JOIN bank.card_authorizations a ON a.id = cb.authorization_id \
                   JOIN bank.cards c ON c.id = a.card_id \
                  WHERE c.user_id = $1 AND c.asset_id = $2",
                &[&user_id, &rates.asset_id],
            )
            .map_err(|e| pg(&e))?;
        let totals: [String; 4] = [t.get(0), t.get(1), t.get(2), t.get(3)];
        Ok((payments, totals))
    })?;
    let [paid, unpaid, refused, to_wallet] = totals;
    Ok(Json::obj([
        ("tier", Json::str(tier.clone())),
        ("rateBps", rates.rate(&tier).map_or(Json::Null, Json::int)),
        ("assetId", Json::str(rates.asset_id.clone())),
        (
            "rates",
            Json::Array(
                CARD_TIERS
                    .iter()
                    .filter_map(|t| {
                        rates.rate(t).map(|bps| {
                            Json::obj([("tier", Json::str(*t)), ("bps", Json::int(bps))])
                        })
                    })
                    .collect(),
            ),
        ),
        ("paid", Json::str(amount_text(&paid)?)),
        ("unpaid", Json::str(amount_text(&unpaid)?)),
        ("refused", Json::str(amount_text(&refused)?)),
        ("toWallet", Json::str(amount_text(&to_wallet)?)),
        ("payments", Json::Array(payments)),
        ("paying", Json::Bool(paying(d))),
        ("simulated", Json::Bool(d.issuer().programme().simulated)),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// svc-identity's rank perks door (`rank-tier.ts`, `createIdentityRankTier`).

const RANK_FETCH_MS: u64 = 3_000;

/// `encodeURIComponent`.
fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn rank_unavailable(message: impl Into<String>) -> Refusal {
    refuse("bank.rank_unavailable", message)
}

/// `rankPerksSchema`'s `cardTier`, when the whole body is in shape.
pub fn card_tier_of_perks(body: &Json) -> Option<String> {
    let num = |k: &str| match body.get(k) {
        Some(Json::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    };
    let int_in =
        |k: &str, lo: f64, hi: f64| num(k).is_some_and(|n| n.fract() == 0.0 && n >= lo && n <= hi);
    let boolean = |k: &str| matches!(body.get(k), Some(Json::Bool(_)));
    let shape = matches!(body, Json::Object(_))
        && int_in("feeDiscountBps", 0.0, 10_000.0)
        && num("p2pLimitMultiplier").is_some_and(|n| n >= 1.0)
        && int_in("copyFollowerCap", 0.0, f64::MAX)
        && boolean("lobbyHostRights")
        && boolean("otcAccess")
        && int_in("launchpadTier", 0.0, f64::MAX);
    match body.get("cardTier") {
        Some(Json::String(t)) if shape && CARD_TIERS.contains(&t.as_str()) => Some(t.clone()),
        _ => None,
    }
}

/// `createIdentityRankTier`: `GET /internal/rank/:userId/perks`, signed as svc-bank for svc-identity, 3 s; only
/// `cardTier` is read. Down, refusing or unreadable refuses `bank.rank_unavailable`: no tier is guessed.
pub struct IdentityRankTier {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
}

impl IdentityRankTier {
    pub fn new(base: &str, signer: CallSigner, fetch: Box<dyn Fetch>) -> IdentityRankTier {
        IdentityRankTier {
            base: base.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }
}

impl RankTier for IdentityRankTier {
    fn card_tier_of(&self, user_id: &str) -> Result<String, Refusal> {
        let route = format!("/internal/rank/{}/perks", encode(user_id));
        let not_answered = || rank_unavailable("identity did not answer the rank perks read");
        let headers = self
            .signer
            .sign("", "GET", &route, "")
            .map_err(|_| not_answered())?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}{route}", self.base),
                headers,
                body: None,
                timeout_ms: Some(RANK_FETCH_MS),
                refuse_redirect: false,
            })
            .map_err(|_| not_answered())?;
        if !res.ok() {
            return Err(rank_unavailable(format!(
                "identity refused the rank perks read ({})",
                res.status
            )));
        }
        json::parse(&res.body)
            .ok()
            .as_ref()
            .and_then(card_tier_of_perks)
            .ok_or_else(|| rank_unavailable("identity returned unreadable rank perks"))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The calls.

fn principal_user<'a>(ctx: &'a Ctx<'_>) -> &'a str {
    ctx.principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default()
}

fn asset_ids(v: &Value) -> Vec<String> {
    match v.get("assetIds") {
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// This part's calls, or `None` for a call it does not hold.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let path = ctx.call.path;
    if !matches!(
        path,
        "cards.authorizations"
            | "cards.recurring"
            | "cards.cashback"
            | "cards.payFrom"
            | "cards.setPayFromOrder"
            | "cards.partnerHeld"
    ) {
        return None;
    }
    let input = &ctx.input;
    let user = principal_user(ctx);
    let card_id = text(input, "cardId");
    let limit = input.get("limit").as_number();
    let test_holds = test_card_holds(d, &d.w.holds);
    let holds = test_holds.as_ref().map(|h| h as &dyn HoldReads);
    Some(match path {
        "cards.authorizations" => own(d, user, card_id).and_then(|_| {
            let page = authorizations_list_limit(limit)?;
            with(d.store(), |c| authorizations(c, card_id, page))
        }),
        "cards.recurring" => own(d, user, card_id).and_then(|_| {
            let page = authorizations_list_limit(limit)?;
            with(d.store(), |c| recurring(c, card_id, page))
        }),
        "cards.partnerHeld" => {
            own(d, user, card_id).and_then(|_| partner_held(d, holds, card_id, limit))
        }
        "cards.cashback" => cashback(d, user),
        "cards.payFrom" => pay_from(d, holds, user),
        _ => set_pay_from_order(d, holds, user, &asset_ids(input)),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use crate::cards::terms::{CUSTODY_MODES, sim_partner_for};

    fn partner(spend_from: Option<&[&str]>) -> PartnerTerms {
        let mut t = PartnerTerms::nothing_reported();
        t.spend_from = spend_from.map(|l| l.iter().map(|s| (*s).to_owned()).collect());
        t
    }

    fn strings(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| (*s).to_owned()).collect()
    }

    fn states(rows: &[PayFromAsset]) -> Vec<(String, &str)> {
        rows.iter().map(|r| (r.asset_id.clone(), r.state)).collect()
    }

    // partner-terms.test.ts, "spend-from switch".
    #[test]
    fn marks_each_owner_asset_offered_or_not_offered_from_the_partner_list_then_the_persons_other_card_assets()
     {
        let rows = pay_from_assets(
            &strings(&["USDC", "BTC"]),
            &partner(Some(&["USDC"])),
            &strings(&["USDT", "USDC"]),
        );
        assert_eq!(
            states(&rows),
            vec![
                ("USDC".to_owned(), "offered"),
                ("BTC".to_owned(), "not_offered"),
                ("USDT".to_owned(), "not_offered"),
            ]
        );
    }

    #[test]
    fn a_partner_asset_the_owner_did_not_list_is_not_offered_to_the_person() {
        let rows = pay_from_assets(
            &strings(&["USDC"]),
            &partner(Some(&["USDC", "BTC"])),
            &strings(&["BTC"]),
        );
        assert_eq!(
            states(&rows),
            vec![
                ("USDC".to_owned(), "offered"),
                ("BTC".to_owned(), "not_listed")
            ]
        );
        assert!(assert_pay_from_order(&strings(&["BTC"]), &rows).is_err());
    }

    #[test]
    fn no_partner_list_is_not_known_for_every_owner_asset_never_an_empty_list_read_as_none_offered()
    {
        let rows = pay_from_assets(
            &strings(&["USDC", "BTC"]),
            &partner(None),
            &strings(&["USDT"]),
        );
        assert_eq!(
            states(&rows),
            vec![
                ("USDC".to_owned(), "not_known"),
                ("BTC".to_owned(), "not_known"),
                ("USDT".to_owned(), "not_listed"),
            ]
        );
    }

    #[test]
    fn the_owner_list_is_the_owners_blank_or_malformed_refuses_bank_card_spend_assets_unset() {
        use crate::cards::terms::parse_spend_assets;
        for raw in [
            None,
            Some(""),
            Some("  "),
            Some("usdc"),
            Some("USDC,USDC"),
            Some("USDC,"),
        ] {
            let parsed = parse_spend_assets(raw);
            let Err(Refusal::Bank(e)) = require_spend_assets(parsed.as_ref()) else {
                panic!("{raw:?} should refuse");
            };
            assert_eq!(e.row.code, "bank.card_spend_assets_unset");
        }
        assert_eq!(
            parse_spend_assets(Some(" USDC , BTC ")).unwrap(),
            strings(&["USDC", "BTC"])
        );
    }

    #[test]
    fn a_quote_is_fresh_for_its_window_and_never_from_more_than_30_s_ahead() {
        let now = Instant(1_000_000_000);
        assert!(acceptable_for_marking(
            Amount::from_scaled(1),
            Instant(now.0 - 60_000),
            now
        ));
        assert!(!acceptable_for_marking(
            Amount::from_scaled(1),
            Instant(now.0 - 61_000),
            now
        ));
        assert!(!acceptable_for_marking(
            Amount::from_scaled(1),
            Instant(now.0 + 120_000),
            now
        ));
        assert!(acceptable_for_marking(
            Amount::from_scaled(1),
            Instant(now.0 + 30_000),
            now
        ));
        assert!(!acceptable_for_marking(Amount::ZERO, now, now));
    }

    #[test]
    fn a_reported_balance_that_is_not_a_plain_decimal_reads_not_known_and_a_partner_that_fails_reads_none()
     {
        let got = reported_balances(Ok(Some(vec![
            ("USDC".to_owned(), "-3".to_owned()),
            ("BTC".to_owned(), "1e2".to_owned()),
            ("USD".to_owned(), "50".to_owned()),
        ])))
        .unwrap()
        .unwrap();
        assert_eq!(
            got.into_iter().collect::<Vec<_>>(),
            vec![("USD".to_owned(), "50".to_owned())]
        );
        assert_eq!(
            reported_balances(Err(Refusal::Other("partner timed out".to_owned()))).unwrap(),
            None
        );
        assert!(reported_balances(Err(refuse("bank.no_card_issuer", "x"))).is_err());
    }

    #[test]
    fn rank_perks_need_the_whole_body_in_shape() {
        let ok = r#"{"feeDiscountBps":0,"p2pLimitMultiplier":1,"copyFollowerCap":0,"lobbyHostRights":false,"cardTier":"metal","otcAccess":false,"launchpadTier":0}"#;
        assert_eq!(
            card_tier_of_perks(&json::parse(ok).unwrap()).as_deref(),
            Some("metal")
        );
        assert!(card_tier_of_perks(&json::parse(&ok.replace("metal", "gold")).unwrap()).is_none());
        assert!(
            card_tier_of_perks(
                &json::parse(&ok.replace("\"p2pLimitMultiplier\":1", "\"p2pLimitMultiplier\":0.5"))
                    .unwrap()
            )
            .is_none()
        );
        assert!(card_tier_of_perks(&json::parse(r#"{"cardTier":"metal"}"#).unwrap()).is_none());
    }

    #[test]
    fn the_test_partner_card_book_runs_an_uncaptured_hold_out_at_its_time_and_reads_figures() {
        let terms = sim_partner_for(
            Some(r#"{"custodyMode":"partner_holds","spendFrom":["USDC"],"lossLiability":null,"reserve":null,"funder":null,"balances":{"USDC":"100"},"programmeFigures":null,"figuresAsOf":null,"fundingAssetId":null,"fundingOffers":null}"#),
            Some("test"),
            None,
        )
        .unwrap();
        let issuer = Issuer::sim(terms.clone());
        let book = Mutex::new(CardHoldBook::default());
        let t0 = Instant(1_700_000_000_000);
        {
            let mut b = book.lock().unwrap();
            let bk = b.book_of(&terms, "u", "USDC").unwrap();
            bk.available -= parse_amount("40").unwrap();
            bk.held += parse_amount("40").unwrap();
            bk.open.insert(hold_key("a"));
            b.holds.insert(
                hold_key("a"),
                Hold {
                    partner_ref: format!("TEST-card-partner:{}", hold_key("a")),
                    user_id: "u".to_owned(),
                    asset_id: "USDC".to_owned(),
                    mode: "partner_holds".to_owned(),
                    amount: parse_amount("40").unwrap(),
                    expires_at: Instant(t0.0 + TEST_CARD_HOLD_DAYS * 86_400_000),
                    conversion: None,
                    captured: Amount::ZERO,
                    released: Amount::ZERO,
                    refunded: Amount::ZERO,
                    expired: false,
                    drawn: false,
                },
            );
        }
        let at = |now: Instant| TestCardHolds {
            book: &book,
            terms: &terms,
            partner: None,
            issuer: &issuer,
            pay_in: None,
            now,
        };
        let f = at(t0).figures("u", "USDC").unwrap();
        assert_eq!(
            (f.available.as_deref(), f.held.as_deref()),
            (Some("60"), Some("40"))
        );
        assert_eq!(
            at(t0).hold_state(&hold_key("a")).unwrap().unwrap().status,
            "held"
        );
        let later = Instant(t0.0 + TEST_CARD_HOLD_DAYS * 86_400_000);
        let f = at(later).figures("u", "USDC").unwrap();
        assert_eq!(
            (f.available.as_deref(), f.held.as_deref()),
            (Some("100"), Some("0"))
        );
        let r = at(later).hold_state(&hold_key("a")).unwrap().unwrap();
        assert_eq!(
            (r.status.as_str(), r.released.as_str(), r.open.as_str()),
            ("expired", "40", "0")
        );
        assert!(at(later).hold_state(&hold_key("b")).unwrap().is_none());
        assert_eq!(at(t0).figures("u", "BTC").unwrap().available, None);
        assert!(CUSTODY_MODES.contains(&f.mode.unwrap().as_str()));
    }

    // partner-card-holds.test.ts, "the TEST card draws on the person's own partner account (#10227)": the book side.
    mod drawn {
        use super::*;
        use crate::cards::terms::PartnerTerms;
        use crate::partner::{Funding, card_holds_account};

        const ADA: &str = "ada";

        fn amt(s: &str) -> Amount {
            parse_amount(s).unwrap()
        }

        fn terms() -> PartnerTerms {
            PartnerTerms {
                custody_mode: Some("partner_holds".to_owned()),
                spend_from: Some(vec!["USDC".to_owned()]),
                balances: Some(vec![("USDC".to_owned(), "100".to_owned())]),
                ..PartnerTerms::nothing_reported()
            }
        }

        fn fund(p: &TestPartner, id: &str, amount: &str) {
            p.lock()
                .fund(
                    ADA,
                    &Funding {
                        fund_id: id.to_owned(),
                        asset_id: "USDC".to_owned(),
                        amount: amt(amount),
                    },
                    Instant(1_700_000_000_000),
                )
                .unwrap();
        }

        fn main_of(p: &TestPartner) -> Option<Amount> {
            p.lock().card_available(ADA, "USDC")
        }

        /// The hold instruction's book side (`partner_book::take`): the book chosen, the money held, the hold kept.
        fn hold(
            book: &Mutex<CardHoldBook>,
            terms: &PartnerTerms,
            funds: &CardFunds<'_>,
            key: &str,
            amount: &str,
        ) {
            let mut b = book.lock().unwrap();
            b.standing(terms, funds, ADA, "USDC").unwrap();
            let drawn = b.hold_from(funds, ADA, "USDC", amt(amount), key).unwrap();
            b.holds.insert(
                key.to_owned(),
                Hold {
                    partner_ref: format!("TEST-card-partner:{key}"),
                    user_id: ADA.to_owned(),
                    asset_id: "USDC".to_owned(),
                    mode: "partner_holds".to_owned(),
                    amount: amt(amount),
                    expires_at: Instant(funds.now.0 + TEST_CARD_HOLD_DAYS * 86_400_000),
                    conversion: None,
                    captured: Amount::ZERO,
                    released: Amount::ZERO,
                    refunded: Amount::ZERO,
                    expired: false,
                    drawn,
                },
            );
        }

        /// The release instruction's book side: whatever is still open goes back where it came from, under `key`.
        fn release(book: &Mutex<CardHoldBook>, funds: &CardFunds<'_>, hold_key: &str, key: &str) {
            let mut b = book.lock().unwrap();
            let back = b.holds.get(hold_key).unwrap().open();
            b.give_back(funds, hold_key, back, key, CardStep::Release)
                .unwrap();
            b.holds.get_mut(hold_key).unwrap().released += back;
            let bk = b.books.get_mut(&book_id(ADA, "USDC")).unwrap();
            bk.held -= back;
            bk.open.remove(hold_key);
        }

        fn figures(holds: &TestCardHolds<'_>) -> (Option<String>, Option<String>) {
            let f = holds.figures(ADA, "USDC").unwrap();
            (f.available, f.held)
        }

        fn pair(a: &str, h: &str) -> (Option<String>, Option<String>) {
            (Some(a.to_owned()), Some(h.to_owned()))
        }

        #[test]
        fn a_drawn_card_reads_the_persons_partner_main_account_and_holds_from_it_once_per_key() {
            let terms = terms();
            let issuer = Issuer::sim(terms.clone());
            let partner = TestPartner::new().unwrap();
            fund(&partner, "f-400", "400");
            let book = Mutex::new(CardHoldBook::default());
            let holds = TestCardHolds {
                book: &book,
                terms: &terms,
                partner: Some(&partner),
                issuer: &issuer,
                pay_in: None,
                now: Instant(1_700_000_000_000),
            };
            // The partner main account, never the TEST figure of 100.
            assert_eq!(figures(&holds), pair("400", "0"));
            let funds = holds.funds();
            hold(&book, &terms, &funds, "card.partner.hold:a", "20");
            assert_eq!(main_of(&partner), Some(amt("380")));
            assert_eq!(figures(&holds), pair("380", "20"));
            // The same key again moves nothing more at the partner.
            funds
                .move_funds(
                    "card.partner.hold:a",
                    CardStep::Hold,
                    ADA,
                    "USDC",
                    amt("20"),
                )
                .unwrap();
            assert_eq!(main_of(&partner), Some(amt("380")));
            assert_eq!(
                partner.lock().book.amount(&card_holds_account("USDC")),
                amt("20")
            );
            release(
                &book,
                &funds,
                "card.partner.hold:a",
                "card.partner.release:a",
            );
            release(
                &book,
                &funds,
                "card.partner.hold:a",
                "card.partner.release:a",
            );
            assert_eq!(main_of(&partner), Some(amt("400")));
            assert_eq!(figures(&holds), pair("400", "0"));
            assert_eq!(
                partner.lock().book.amount(&card_holds_account("USDC")),
                Amount::ZERO
            );
        }

        #[test]
        fn a_drawn_card_spends_what_the_account_holds_and_nothing_beside_it() {
            let terms = terms();
            let partner = TestPartner::new().unwrap();
            fund(&partner, "f-1000", "1000");
            let funds = CardFunds {
                partner: Some(&partner),
                now: Instant(1_700_000_000_000),
            };
            let mut b = CardHoldBook::default();
            // compose.ts: `credited: (userId, assetId, drawn) => drawn ? 0n : ...`.
            assert_eq!(
                b.spendable(&terms, &funds, ADA, "USDC", amt("7")),
                Some((amt("1000"), Amount::ZERO))
            );
            // With no partner account the TEST figure and the credit both count.
            assert_eq!(
                b.spendable(&terms, &funds, "bob", "USDC", amt("7")),
                Some((amt("107"), Amount::ZERO))
            );
        }

        #[test]
        fn with_no_account_at_the_partner_the_card_keeps_the_test_figure() {
            let terms = terms();
            let issuer = Issuer::sim(terms.clone());
            let partner = TestPartner::new().unwrap();
            let book = Mutex::new(CardHoldBook::default());
            let holds = TestCardHolds {
                book: &book,
                terms: &terms,
                partner: Some(&partner),
                issuer: &issuer,
                pay_in: None,
                now: Instant(1_700_000_000_000),
            };
            assert_eq!(figures(&holds), pair("100", "0"));
            hold(&book, &terms, &holds.funds(), "card.partner.hold:a", "10");
            assert_eq!(figures(&holds), pair("90", "10"));
            assert_eq!(main_of(&partner), None);
            assert_eq!(partner.lock().book.moves_held(), 0);
            assert!(!book.lock().unwrap().books[&book_id(ADA, "USDC")].drawn);
        }

        #[test]
        fn a_book_that_holds_nothing_follows_the_account_and_an_open_hold_goes_back_where_it_came_from()
         {
            let terms = terms();
            let issuer = Issuer::sim(terms.clone());
            let partner = TestPartner::new().unwrap();
            let book = Mutex::new(CardHoldBook::default());
            let holds = TestCardHolds {
                book: &book,
                terms: &terms,
                partner: Some(&partner),
                issuer: &issuer,
                pay_in: None,
                now: Instant(1_700_000_000_000),
            };
            let funds = holds.funds();
            assert_eq!(figures(&holds), pair("100", "0"));
            hold(&book, &terms, &funds, "card.partner.hold:a", "10");
            // The account opens while the TEST figure's hold is open: the book keeps to the figure until it holds nothing.
            fund(&partner, "f-40", "40");
            assert_eq!(figures(&holds), pair("90", "10"));
            release(
                &book,
                &funds,
                "card.partner.hold:a",
                "card.partner.release:a",
            );
            // The hold went back to the TEST figure, never into the partner account.
            assert_eq!(main_of(&partner), Some(amt("40")));
            assert_eq!(figures(&holds), pair("40", "0"));
            assert!(book.lock().unwrap().books[&book_id(ADA, "USDC")].drawn);
            // A drawn hold open while the account is emptied elsewhere still comes back to the account.
            hold(&book, &terms, &funds, "card.partner.hold:b", "15");
            assert_eq!(main_of(&partner), Some(amt("25")));
            assert_eq!(figures(&holds), pair("25", "15"));
            release(
                &book,
                &funds,
                "card.partner.hold:b",
                "card.partner.release:b",
            );
            assert_eq!(main_of(&partner), Some(amt("40")));
            // An empty drawn book whose account the partner no longer reports is kept drawn (the TypeScript's `if (kept)`).
            let other = TestPartner::new().unwrap();
            let gone = CardFunds {
                partner: Some(&other),
                now: funds.now,
            };
            assert_eq!(
                book.lock().unwrap().standing(&terms, &gone, ADA, "USDC"),
                Some((Amount::ZERO, Amount::ZERO, true))
            );
            // And a TEST figure book that holds nothing turns drawn once the account opens.
            let mut fresh = CardHoldBook::default();
            assert_eq!(
                fresh.standing(&terms, &CardFunds::NONE, ADA, "USDC"),
                Some((amt("100"), Amount::ZERO, false))
            );
            assert_eq!(
                fresh.standing(&terms, &funds, ADA, "USDC"),
                Some((amt("40"), Amount::ZERO, true))
            );
        }

        #[test]
        fn a_drawn_hold_whose_time_ran_out_comes_back_to_the_account_once() {
            let terms = terms();
            let issuer = Issuer::sim(terms.clone());
            let partner = TestPartner::new().unwrap();
            fund(&partner, "f-50", "50");
            let book = Mutex::new(CardHoldBook::default());
            let t0 = Instant(1_700_000_000_000);
            let at = |now: Instant| TestCardHolds {
                book: &book,
                terms: &terms,
                partner: Some(&partner),
                issuer: &issuer,
                pay_in: None,
                now,
            };
            hold(&book, &terms, &at(t0).funds(), "card.partner.hold:a", "30");
            assert_eq!(main_of(&partner), Some(amt("20")));
            let later = Instant(t0.0 + TEST_CARD_HOLD_DAYS * 86_400_000);
            assert_eq!(figures(&at(later)), pair("50", "0"));
            assert_eq!(figures(&at(later)), pair("50", "0"));
            assert_eq!(main_of(&partner), Some(amt("50")));
            let r = at(later)
                .hold_state("card.partner.hold:a")
                .unwrap()
                .unwrap();
            assert_eq!((r.status.as_str(), r.released.as_str()), ("expired", "30"));
            let p = partner.lock();
            let expired = p
                .book
                .by_key("TEST-card-partner:card.partner.hold:a:expired")
                .unwrap();
            assert_eq!(
                (
                    expired.from.user_id.as_str(),
                    expired.to.user_id.as_str(),
                    expired.amount
                ),
                ("partner:card-holds", ADA, amt("30"))
            );
        }
    }
}
