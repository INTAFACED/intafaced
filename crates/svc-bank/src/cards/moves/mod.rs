//! The card's moves (slice `card-ops`, `PORT.md`): the issuer's side of the conversation, never the person's. On a live
//! rail each is a signed message from the issuer on the card network's deadline; there is no live rail, so today they
//! are operator surface (`ops.cardAuthorize`, `ops.cardThreeDSChallenge`, `ops.cardCapture`, `ops.cardReverse`,
//! `ops.cardResumeSettlement`, `ops.fundCashbackPot`) with a second founder's approval, and the TEST merchant refund
//! (`testPartner.cardRefund`). `card-service.ts`: `authorize`, `capture`, `reverse`, `refund`, `resumeSettlements`,
//! `fundCashbackPot`, `cashbackCapacity` and everything they call.
//!
//! Money moves only through svc-ledger's recipe door, never by entries assembled here: a hold is `withdrawHold` keyed
//! `withdraw.hold:<authorisation id>`, a capture `withdrawSettle` (`withdraw.settle:<id>`), the rest of a hold
//! `withdrawReverse` (`withdraw.reverse:<id>`), cashback `rewardPay` (`reward:bank.card.cashback:<id>`) and the cashback
//! pot's funding `sweepFeesToRewards` (`token.fee.sweep:bank.card:<window>:bank:<asset>`). With `LEDGER_CUSTODY_LAYER`
//! off, every post that moves a customer balance refuses `bank.no_partner_bank` before svc-ledger is asked, as
//! `custodyGuardedLedger` does; the pot's funding is the bank's own money and posts.
//!
//! A person whose money the partner holds (OWNER 226) is held, captured, released and refunded at the card partner,
//! once each under `card.partner.<instruction>:<authorisation id>`, and our ledger posts nothing for them (`partner`).
//!
//! - `conversion`: the just-in-time rate, quoted once at the decision and frozen (`conversion.ts`).
//! - `decide`: the authorisation, its checks, the hold and the trace.
//! - `settle`: capture, reverse, the claimed settlement rows and their re-drive, a used-up card closing itself, a lost or
//!   stolen card's open holds given back.
//! - `partner`: the partner-held paths and the TEST partner card's instructions (`partner-card-holds.ts`).
//! - `cashback`: cashback by the card's rate or the rank tier's, paid from the rewards pot or owed to the wallet, the
//!   pot's funding, and the capture's round-up.
//! - `router`: the calls.

pub mod cashback;
pub mod conversion;
pub mod decide;
pub mod partner;
pub mod partner_book;
pub mod router;
pub mod settle;

use postgres::{GenericClient, Row};
use service_kit::money::{Amount, parse_amount};
use service_kit::time::Instant;

use super::{Card, ms};
use crate::automations::auto_invest::service::{Capture, RoundUpOutcome};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::PostFailure;
use crate::spaces::space::{pg, with};
use crate::transfers::ports::Bus;

/// What a card move is handed: the cards slice's dependencies (the store, the ledger, the partner, the issuer, the
/// conversion rate source), where cashback earned on partner-held spend is announced (`cashbackEarned`), and the
/// capture's round-up (`onCaptureSettled`, the automations slice's `apply_round_up`).
pub struct Moves<'a> {
    pub d: &'a super::Deps<'a>,
    /// The bus `bankCardCashbackEarned` goes on; `None` is no hand-over wired.
    pub cashback: Option<&'a dyn Bus>,
    /// `None` is no round-up.
    pub round_up: Option<&'a RoundUp<'a>>,
}

/// `CaptureSettledHook`.
pub type RoundUp<'a> = dyn Fn(&Capture<'_>) -> Result<RoundUpOutcome, Refusal> + 'a;

impl<'a> Moves<'a> {
    /// A move with no round-up: what a hook in the cards slice hands in (an authorisation a 3D Secure challenge
    /// completes, the reversal of a lost card's holds), which reach neither the round-up nor cashback.
    pub fn bare(d: &'a super::Deps<'a>) -> Moves<'a> {
        Moves {
            d,
            cashback: Some(d.t.w.bus.as_ref()),
            round_up: None,
        }
    }

    pub fn store(&self) -> &crate::db::Store {
        self.d.store()
    }

    pub fn now(&self) -> Instant {
        self.d.now()
    }
}

/// `ConversionRecord`: the rate one authorisation converted at, as written down; never re-rated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversion {
    pub settlement_asset_id: String,
    pub settlement_amount: Amount,
    pub funding_asset_id: String,
    pub funding_amount: Amount,
    pub rate: Amount,
    /// `mid`, `index`, `last` or `partner`.
    pub quality: String,
    pub rate_as_of: Instant,
}

/// `AuthorizationRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Auth {
    pub id: String,
    pub card_id: String,
    pub authorization_ref: String,
    /// What moves, in the card's funding asset.
    pub amount: Amount,
    pub merchant_category: Option<String>,
    pub merchant: Option<String>,
    pub merchant_country: Option<String>,
    pub channel: String,
    pub recurring: bool,
    /// `approved` or `declined`.
    pub decision: String,
    pub decline_code: Option<String>,
    /// `pending`, `settled` or `rejected`.
    pub status: String,
    pub hold_ledger_tx_id: Option<String>,
    /// `ledger` or `partner`: whose book holds it, decided once.
    pub held_by: String,
    pub partner_hold_ref: Option<String>,
    pub partner_mode: Option<String>,
    pub pay_from_order: Option<Vec<String>>,
    pub decided_at: Instant,
    pub conversion: Option<Conversion>,
}

fn auth_cols() -> String {
    format!(
        "a.id::text, a.card_id::text, a.authorization_ref, a.amount::text, a.merchant_category, a.merchant, \
         a.merchant_country, a.channel, a.recurring, a.decision::text, a.decline_code, a.status::text, \
         a.hold_ledger_tx_id, a.money_book, a.partner_hold_ref, a.partner_mode, a.pay_from_order, {}, \
         c.settlement_asset_id, c.settlement_amount::text, c.funding_asset_id, c.funding_amount::text, c.rate::text, \
         c.rate_quality, {}",
        ms("a.decided_at"),
        ms("c.rate_as_of")
    )
}

fn amount_text(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

impl Auth {
    /// `toAuthorization`.
    fn from_row(r: &Row) -> Result<Auth, Refusal> {
        let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let o = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let channel = g(7)?;
        // `toConversion`: every column present together, or no conversion.
        let conversion = match (
            o(18)?,
            o(19)?,
            o(20)?,
            o(21)?,
            o(22)?,
            o(23)?,
            r.try_get::<_, Option<i64>>(24).map_err(|e| pg(&e))?,
        ) {
            (Some(sa), Some(samt), Some(fa), Some(famt), Some(rate), Some(q), Some(at)) => {
                Some(Conversion {
                    settlement_asset_id: sa,
                    settlement_amount: amount_text(&samt)?,
                    funding_asset_id: fa,
                    funding_amount: amount_text(&famt)?,
                    rate: amount_text(&rate)?,
                    quality: q,
                    rate_as_of: Instant(at),
                })
            }
            _ => None,
        };
        Ok(Auth {
            id: g(0)?,
            card_id: g(1)?,
            authorization_ref: g(2)?,
            amount: amount_text(&g(3)?)?,
            merchant_category: o(4)?,
            merchant: o(5)?,
            merchant_country: o(6)?,
            // `parseChannel`: anything unknown reads as card-present.
            channel: if matches!(
                channel.as_str(),
                "online" | "contactless" | "atm" | "foreign" | "card-present"
            ) {
                channel
            } else {
                "card-present".to_owned()
            },
            recurring: r
                .try_get::<_, Option<bool>>(8)
                .map_err(|e| pg(&e))?
                .unwrap_or(false),
            decision: g(9)?,
            decline_code: o(10)?,
            status: g(11)?,
            hold_ledger_tx_id: o(12)?,
            held_by: g(13)?,
            partner_hold_ref: o(14)?,
            partner_mode: o(15)?,
            pay_from_order: r.try_get(16).map_err(|e| pg(&e))?,
            decided_at: Instant(r.try_get(17).map_err(|e| pg(&e))?),
            conversion,
        })
    }
}

/// `authorizationByRef`.
pub fn by_ref(
    c: &mut impl GenericClient,
    card_id: &str,
    authorization_ref: &str,
) -> Result<Option<Auth>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.card_authorizations a \
                   LEFT JOIN bank.card_conversions c ON c.authorization_id = a.id \
                  WHERE a.card_id = $1::text::uuid AND a.authorization_ref = $2",
                auth_cols()
            ),
            &[&card_id, &authorization_ref],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Auth::from_row).transpose()
}

/// `authorizationByRef` through the pool.
pub fn read_by_ref(
    m: &Moves<'_>,
    card_id: &str,
    authorization_ref: &str,
) -> Result<Option<Auth>, Refusal> {
    with(m.store(), |c| by_ref(c, card_id, authorization_ref))
}

/// The row just written, read back: it is there, or the store lost it.
pub fn reread(m: &Moves<'_>, card: &Card, authorization_ref: &str) -> Result<Auth, Refusal> {
    read_by_ref(m, &card.id, authorization_ref)?.ok_or_else(|| {
        Refusal::Other(format!(
            "authorisation {authorization_ref} on card {} vanished after it was written",
            card.id
        ))
    })
}

/// `requireApprovedAuthorization`: an authorisation that exists, was approved, and whose hold really landed.
pub fn require_approved(
    m: &Moves<'_>,
    card: &Card,
    authorization_ref: &str,
) -> Result<Auth, Refusal> {
    let Some(a) = read_by_ref(m, &card.id, authorization_ref)? else {
        return Err(refuse(
            "bank.card_authorization_not_found",
            format!("Authorisation {authorization_ref} not found on this card"),
        ));
    };
    if a.decision != "approved" || a.status != "settled" {
        return Err(refuse(
            "bank.card_authorization_declined",
            format!("Authorisation {authorization_ref} was declined and holds nothing"),
        ));
    }
    Ok(a)
}

/// `custodyGuardedLedger`: with the custodial layer off, a post that moves a customer balance is refused before
/// svc-ledger is asked.
pub fn custody_guard(m: &Moves<'_>) -> Result<(), Refusal> {
    if m.d.t.partner.custody_layer == "on" {
        return Ok(());
    }
    Err(refuse(
        "bank.no_partner_bank",
        "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
    ))
}

/// Why a recipe post did not answer: the custody guard refused before svc-ledger was asked, or the ledger failed.
#[derive(Debug, Clone)]
pub enum PostErr {
    Guard(Refusal),
    Ledger(PostFailure),
}

/// `isDefiniteLedgerRefusal`: a typed refusal that proves nothing committed under the key. `ledger.frozen` and
/// `ledger.idempotency_conflict` are not among them.
pub fn definite_refusal(f: &PostFailure) -> bool {
    matches!(
        f.code(),
        Some(
            "ledger.insufficient_funds"
                | "ledger.invalid_entry"
                | "ledger.unbalanced"
                | "ledger.owner_identity_space"
        )
    )
}

/// How a failed post answers the guard: the caller's own too-little-money is a `BAD_REQUEST` with the ledger's words;
/// any other ledger failure is opaque, its words only for the log (and a recovery's report).
pub fn post_refusal(f: &PostFailure) -> Refusal {
    if f.insufficient() {
        return crate::transfers::moves::post_refusal(f);
    }
    Refusal::Other(f.message().to_owned())
}

/// `err instanceof Error ? err.message : String(err)`: the words a recovery reports for one row it could not move.
pub fn reason_of(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.message.clone(),
        Refusal::Trpc(e) => e.message.clone(),
        Refusal::Other(m) => m.clone(),
    }
}

/// A refusal's own code (`BankError.code`), when it is one.
pub fn code_of(r: &Refusal) -> Option<&str> {
    match r {
        Refusal::Bank(e) => Some(e.row.code),
        _ => None,
    }
}

/// `tellIssuer`: tell the issuer, and never let the telling undo the decision. The row is the durable record of what
/// was decided; delivery is a separate fact.
pub fn tell_issuer(m: &Moves<'_>) {
    let _ = m.d.issuer().respond_to_authorization();
}

/// The card's money book for a new authorisation (`heldBy`): the TEST partner's per-person custody switch, else the
/// custodial layer, else none.
pub fn held_by(m: &Moves<'_>, user_id: &str) -> &'static str {
    crate::partner::money_held_by(
        m.d.t.partner.partner.as_ref(),
        user_id,
        &m.d.t.partner.custody_layer,
    )
}
