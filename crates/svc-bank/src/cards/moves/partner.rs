//! Partner-held authorisations (`card-service.ts`: `requirePartnerHolds`, `partnerAvailable`, `commitPartnerHold`,
//! `markOrderHold`, `payFromOrderFor`, `partnerSettlement`, `capturePartnerHeld`, `releasePartnerHeld`,
//! `resumePartnerHeld`, `refund`).
//!
//! IF THIS CRASHES EXACTLY HERE, WHOSE FUNDS ARE STRANDED? None of them are in our book: the partner holds the money, and
//! every instruction goes under a key derived from our authorisation id (`card.partner.<instruction>:<id>`), so a re-drive
//! asks the partner the same question and gets the same answer. Our ledger posts nothing on this path.

use service_kit::money::{Amount, Rounding, format_amount, mul_div, parse_amount};

use super::partner_book::{self, Book, HoldAnswer, MoveAnswer, PartnerErr};
use super::settle::{Captured, PartnerCapture, Released, Resumed, ResumedRow};
use super::{Auth, Moves, require_approved, reread, tell_issuer};
use crate::cards::Card;
use crate::cards::reads::{Figures, hold_key, pay_from_assets, require_spend_assets};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

const ONE: Amount = 1_000_000_000_000_000_000;

/// `partnerCardKey`.
pub fn key(instruction: &str, authorization_id: &str) -> String {
    format!("card.partner.{instruction}:{authorization_id}")
}

/// `requirePartnerHolds`.
pub fn require_holds<'a>(m: &'a Moves<'_>) -> Result<Book<'a>, Refusal> {
    partner_book::book(m.d).ok_or_else(|| {
        refuse(
            "bank.card_partner_holds_unset",
            "This card money is held by the partner, but the card programme has no partner that holds authorisations. Nothing was decided.",
        )
    })
}

/// `partnerAvailable`: the partner's spendable figure, read before anything is written.
pub fn partner_available(m: &Moves<'_>, card: &Card) -> Result<Amount, Refusal> {
    let figures = require_holds(m)?.figures(&card.user_id, &card.asset_id)?;
    if figures.mode.is_none() {
        return Err(refuse(
            "bank.card_partner_mode_not_known",
            "The card partner has not said whether it holds the crypto or pulls from the wallet. Nothing was decided.",
        ));
    }
    let Some(available) = figures.available else {
        let from =
            m.d.issuer()
                .partner_terms()
                .ok()
                .and_then(|t| t.spend_from)
                .filter(|f| !f.is_empty());
        let spends = from.map_or(String::new(), |f| {
            format!(
                " It spends from {}; a card in one of those can be held.",
                f.join(", ")
            )
        });
        return Err(refuse(
            "bank.card_partner_balance_not_known",
            format!(
                "The card partner reports no {} balance, so nothing can be held.{spends} Nothing was decided.",
                card.asset_id
            ),
        ));
    };
    parse_amount(&available).map_err(Refusal::Other)
}

/// `payFromOrderFor`: the saved pay-from order as the partner can spend it now, or none.
pub fn pay_from_order_for(m: &Moves<'_>, card: &Card) -> Result<Option<Vec<String>>, Refusal> {
    if partner_book::book(m.d).is_none() {
        return Ok(None);
    }
    let saved: Option<Vec<String>> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT asset_ids FROM bank.card_pay_from_orders WHERE user_id = $1",
            &[&card.user_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| r.get(0)))
    })?;
    let Some(saved) = saved else {
        return Ok(None);
    };
    let owner = require_spend_assets(m.d.settings().spend_assets.as_ref())?;
    let terms =
        m.d.issuer()
            .partner_terms()
            .unwrap_or_else(|_| crate::cards::terms::PartnerTerms::nothing_reported());
    let offered: Vec<String> = pay_from_assets(owner, &terms, &[])
        .into_iter()
        .filter(|a| a.state == "offered")
        .map(|a| a.asset_id)
        .collect();
    let order: Vec<String> = saved.into_iter().filter(|a| offered.contains(a)).collect();
    Ok((!order.is_empty()).then_some(order))
}

fn key_conflict(message: String) -> Refusal {
    refuse("bank.card_partner_key_conflict", message)
}

/// `commitPartnerHold`: the partner holds the claimed amount, once under `card.partner.hold:<id>`. The partner's no is a
/// decline; a guard's no before it was asked is a decline only once the partner confirms it holds nothing under the key.
pub fn commit_partner_hold(
    m: &Moves<'_>,
    card: &Card,
    claimed: &Auth,
    merchant: Amount,
) -> Result<Auth, Refusal> {
    let hold_key = key("hold", &claimed.id);
    let answer = (|| -> Result<HoldAnswer, PartnerErr> {
        let holds = require_holds(m)?;
        match &claimed.pay_from_order {
            Some(order) => holds.hold_in_order(
                &hold_key,
                &card.user_id,
                order,
                &card.settlement_asset_id,
                &format_amount(merchant),
            ),
            None => holds.hold(
                &hold_key,
                &card.user_id,
                &card.asset_id,
                &format_amount(claimed.amount),
            ),
        }
    })();
    let answer = match answer {
        Ok(a) => a,
        Err(PartnerErr::Refused(r))
            if super::code_of(&r) != Some("bank.card_partner_key_conflict") =>
        {
            let code = super::code_of(&r).unwrap_or_default().to_owned();
            return super::decide::decline_claimed(m, card, claimed, &code, true);
        }
        Err(e) => {
            if super::decide::not_asked(&e) {
                let prior = require_holds(m).ok().map(|h| h.hold_state(&hold_key));
                if let Some(Ok(None)) = prior {
                    let code = super::code_of(&e.clone().refusal())
                        .unwrap_or_default()
                        .to_owned();
                    return super::decide::decline_claimed(m, card, claimed, &code, true);
                }
            }
            return Err(e.refusal());
        }
    };
    let (hold, _) = match answer {
        HoldAnswer::Declined { reason } => {
            return super::decide::decline_claimed(m, card, claimed, &reason, true);
        }
        HoldAnswer::Approved { hold, figures } => (hold, figures),
    };
    if let (Some(conversion), Some(order)) = (&hold.conversion, &claimed.pay_from_order) {
        return mark_order_hold(m, card, claimed, merchant, &hold, conversion, order);
    }
    if parse_amount(&hold.amount).ok() != Some(claimed.amount) {
        return Err(key_conflict(format!(
            "The card partner holds {} under this authorisation's key, not {}",
            hold.amount,
            format_amount(claimed.amount)
        )));
    }
    with(m.store(), |c| {
        c.execute(
            "UPDATE bank.card_authorizations SET status = 'settled', partner_hold_ref = $2, partner_mode = $3, \
               settled_at = now() WHERE id = $1::text::uuid",
            &[&claimed.id, &hold.partner_ref, &hold.mode],
        )
        .map_err(|e| pg(&e))
    })?;
    let approved = reread(m, card, &claimed.authorization_ref)?;
    tell_issuer(m);
    Ok(approved)
}

/// `markOrderHold`: the partner held a pay-from payment from one asset of the order at its own rate; the row takes its
/// figures as it reported them, in one transaction.
fn mark_order_hold(
    m: &Moves<'_>,
    card: &Card,
    claimed: &Auth,
    merchant: Amount,
    hold: &crate::cards::reads::HoldReport,
    c: &crate::cards::reads::HoldConversion,
    order: &[String],
) -> Result<Auth, Refusal> {
    let asset = hold.asset_id.clone().unwrap_or_default();
    let positive = |s: &str| parse_amount(s).is_ok_and(|a| a > 0);
    if c.settlement_asset_id != card.settlement_asset_id
        || parse_amount(&c.settlement_amount).ok() != Some(merchant)
        || !order.contains(&asset)
        || !positive(&hold.amount)
        || !positive(&c.rate)
    {
        return Err(key_conflict(format!(
            "The card partner's hold under this authorisation's key is {} {} for {} {}, not this payment of {} {} by the order {}",
            hold.amount,
            asset,
            c.settlement_amount,
            c.settlement_asset_id,
            format_amount(merchant),
            card.settlement_asset_id,
            order.join(", ")
        )));
    }
    let as_of = service_kit::time::js_date(&c.rate_as_of)
        .map(|t| t.0)
        .ok_or_else(|| Refusal::Other(format!("unreadable partner rate time {}", c.rate_as_of)))?;
    in_tx(m.store(), |tx| {
        let marked = tx
            .query(
                "UPDATE bank.card_authorizations SET status = 'settled', amount = $2::text::numeric, \
                   partner_hold_ref = $3, partner_mode = $4, settled_at = now() \
                 WHERE id = $1::text::uuid AND status = 'pending' RETURNING id",
                &[&claimed.id, &hold.amount, &hold.partner_ref, &hold.mode],
            )
            .map_err(|e| pg(&e))?;
        if marked.is_empty() {
            return Ok(());
        }
        tx.execute(
            "INSERT INTO bank.card_conversions (authorization_id, settlement_asset_id, settlement_amount, \
               funding_asset_id, funding_amount, rate, rate_quality, rate_as_of) \
             VALUES ($1::text::uuid, $2, $3::text::numeric, $4, $5::text::numeric, $6::text::numeric, 'partner', \
               to_timestamp($7::int8 / 1000.0)) \
             ON CONFLICT (authorization_id) DO NOTHING",
            &[
                &claimed.id,
                &c.settlement_asset_id,
                &c.settlement_amount,
                &asset,
                &hold.amount,
                &c.rate,
                &as_of,
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    let approved = reread(m, card, &claimed.authorization_ref)?;
    tell_issuer(m);
    Ok(approved)
}

/// `partnerSettlement`'s answer: the partner's reference, and its fresh answer when it was asked now.
pub struct Settled {
    pub partner_ref: String,
    pub answer: Option<MoveAnswer>,
}

/// `partnerSettlement`: claim the settlement row, send, mark it with the partner's reference. A `rejected` claim (the
/// partner said no, nothing moved) is retired and claimed again for what is asked now.
pub fn partner_settlement(
    m: &Moves<'_>,
    authorization: &Auth,
    sequence: i32,
    kind: &str,
    amount: Amount,
    send: impl FnOnce() -> Result<MoveAnswer, PartnerErr>,
) -> Result<Settled, Refusal> {
    let shown = format_amount(amount);
    let (id, prior_ref) = in_tx(m.store(), |tx| {
        let insert = |tx: &mut postgres::Transaction<'_>| -> Result<Option<String>, Refusal> {
            Ok(tx
                .query(
                    "INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount, money_book) \
                     VALUES ($1::text::uuid, $2, $3::text::bank.card_settlement_kind, $4::text::numeric, 'partner') \
                     ON CONFLICT (authorization_id, sequence) DO NOTHING RETURNING id::text",
                    &[&authorization.id, &sequence, &kind, &shown],
                )
                .map_err(|e| pg(&e))?
                .first()
                .map(|r| r.get(0)))
        };
        if let Some(id) = insert(tx)? {
            return Ok((id, None));
        }
        let rows = tx
            .query(
                "SELECT id::text, kind::text, amount::text, status::text, partner_ref FROM bank.card_settlements \
                  WHERE authorization_id = $1::text::uuid AND sequence = $2 FOR UPDATE",
                &[&authorization.id, &sequence],
            )
            .map_err(|e| pg(&e))?;
        let Some(prior) = rows.first() else {
            return Err(Refusal::Other("settlement claim vanished".to_owned()));
        };
        let (pid, pkind, pamount, pstatus, pref): (String, String, String, String, Option<String>) = (
            prior.get(0),
            prior.get(1),
            prior.get(2),
            prior.get(3),
            prior.get(4),
        );
        if pstatus == "rejected" {
            tx.execute(
                "DELETE FROM bank.card_settlements WHERE id = $1::text::uuid AND status = 'rejected'",
                &[&pid],
            )
            .map_err(|e| pg(&e))?;
            let again =
                insert(tx)?.ok_or_else(|| Refusal::Other("settlement claim lost".to_owned()))?;
            return Ok((again, None));
        }
        if pkind != kind {
            return Err(refuse(
                "bank.card_settlement_kind_conflict",
                format!(
                    "Settlement {sequence} on this authorisation was claimed as {pkind}, not {kind}"
                ),
            ));
        }
        if parse_amount(&pamount).ok() != Some(amount) {
            return Err(refuse(
                "bank.card_settlement_amount_conflict",
                format!(
                    "Settlement {sequence} on this authorisation was claimed for {pamount}, not {shown}"
                ),
            ));
        }
        Ok((pid, if pstatus == "settled" { pref } else { None }))
    })?;
    if let Some(partner_ref) = prior_ref {
        return Ok(Settled {
            partner_ref,
            answer: None,
        });
    }
    let answer = match send() {
        Ok(a) => a,
        Err(PartnerErr::Refused(r)) => {
            let code = super::code_of(&r).unwrap_or_default().to_owned();
            with(m.store(), |c| {
                c.execute(
                    "UPDATE bank.card_settlements SET status = 'rejected', rejection_code = $2 \
                      WHERE id = $1::text::uuid AND status = 'pending'",
                    &[&id, &code],
                )
                .map_err(|e| pg(&e))
            })?;
            return Err(r);
        }
        Err(PartnerErr::Other(r)) => return Err(r),
    };
    if parse_amount(&answer.amount).ok() != Some(amount) {
        return Err(key_conflict(format!(
            "The card partner moved {} under this {kind}'s key, not {shown}",
            answer.amount
        )));
    }
    with(m.store(), |c| {
        c.execute(
            "UPDATE bank.card_settlements SET status = 'settled', partner_ref = $2, settled_at = now() WHERE id = $1::text::uuid",
            &[&id, &answer.partner_ref],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Settled {
        partner_ref: answer.partner_ref.clone(),
        answer: Some(answer),
    })
}

/// `capturePartnerHeld`: the partner captures what the merchant took and gives the rest of its hold back. Nothing posts
/// to our ledger; cashback is owed to the person's own wallet.
pub fn capture_partner_held(
    m: &Moves<'_>,
    card: &Card,
    authorization: &Auth,
    merchant: Amount,
) -> Result<Captured, Refusal> {
    if merchant <= 0 {
        return Err(refuse(
            "bank.card_capture_exceeds_authorization",
            format!("Capture of {} is not above zero", format_amount(merchant)),
        ));
    }
    let partner = require_holds(m)?;
    let conversion = authorization.conversion.as_ref();
    if let Some(c) = conversion
        && merchant > c.settlement_amount
    {
        return Err(refuse(
            "bank.card_capture_exceeds_authorization",
            format!(
                "Capture of {} exceeds the authorised {}",
                format_amount(merchant),
                format_amount(c.settlement_amount)
            ),
        ));
    }
    let funding = match conversion {
        Some(c) => super::conversion::funding_for(merchant, c.rate)?,
        None => merchant,
    };
    let hold = hold_key(&authorization.id);
    let captured = partner_settlement(m, authorization, 0, "capture", funding, || {
        partner.capture(
            &key("capture", &authorization.id),
            &hold,
            &format_amount(funding),
        )
    })?;
    let remainder = authorization.amount - funding;
    let released = if remainder > 0 {
        Some(partner_settlement(
            m,
            authorization,
            1,
            "reversal",
            remainder,
            || partner.release(&key("release", &authorization.id), &hold),
        )?)
    } else {
        None
    };
    super::settle::close_when_used_up(m, card)?;
    let by_order = authorization.pay_from_order.is_some();
    let cashback = if by_order {
        super::cashback::Outcome::None
    } else {
        super::cashback::owe_wallet(m, card, authorization, funding)?
    };
    let figures: Option<Figures> = released
        .as_ref()
        .unwrap_or(&captured)
        .answer
        .as_ref()
        .map(|a| a.figures.clone());
    let round_up = if by_order {
        crate::automations::auto_invest::service::RoundUpOutcome::None
    } else {
        super::cashback::apply_round_up(m, card, authorization, funding, true)
    };
    Ok(Captured {
        authorization_id: authorization.id.clone(),
        captured: funding,
        returned: remainder,
        capture_ledger_tx_id: None,
        reversal_ledger_tx_id: None,
        held_by: "partner",
        partner: Some(PartnerCapture {
            capture_ref: captured.partner_ref,
            release_ref: released.map(|r| r.partner_ref),
            figures,
        }),
        cashback,
        round_up,
        settlement: conversion.map(|c| (c.settlement_asset_id.clone(), merchant, c.rate)),
    })
}

/// `releasePartnerHeld`: the partner gives the whole hold back, once; a hold whose time ran out says `expiry`.
pub fn release_partner_held(m: &Moves<'_>, authorization: &Auth) -> Result<Released, Refusal> {
    let partner = require_holds(m)?;
    let hold = hold_key(&authorization.id);
    let released = partner_settlement(
        m,
        authorization,
        0,
        "reversal",
        authorization.amount,
        || partner.release(&key("release", &authorization.id), &hold),
    )?;
    let by = match &released.answer {
        Some(a) => a.by,
        None => {
            if partner
                .hold_state(&hold)
                .ok()
                .flatten()
                .is_some_and(|r| r.status == "expired")
            {
                "expiry"
            } else {
                "instruction"
            }
        }
    };
    Ok(Released {
        returned: authorization.amount,
        ledger_tx_id: None,
        partner: Some((released.partner_ref, by, released.answer.map(|a| a.figures))),
    })
}

/// `resumePartnerHeld`: re-send each pending claim under its key; `held` is the partner's.
pub fn resume_partner_held(m: &Moves<'_>, authorization: &Auth) -> Result<Resumed, Refusal> {
    let partner = require_holds(m)?;
    let hold = hold_key(&authorization.id);
    let rows: Vec<(i32, String, String)> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT sequence, kind::text, amount::text FROM bank.card_settlements \
              WHERE authorization_id = $1::text::uuid AND status = 'pending' ORDER BY sequence ASC",
            &[&authorization.id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect())
    })?;
    let mut resumed = Vec::new();
    for (sequence, kind, raw) in rows {
        let amount = parse_amount(&raw).map_err(Refusal::Other)?;
        let done = partner_settlement(m, authorization, sequence, &kind, amount, || {
            if kind == "capture" {
                partner.capture(
                    &key("capture", &authorization.id),
                    &hold,
                    &format_amount(amount),
                )
            } else {
                partner.release(&key("release", &authorization.id), &hold)
            }
        });
        resumed.push(match done {
            Ok(s) => ResumedRow {
                sequence,
                kind: kind.clone(),
                amount,
                outcome: "settled",
                ledger_tx_id: None,
                partner_ref: Some(s.partner_ref),
                reason: None,
            },
            Err(e) => ResumedRow {
                sequence,
                kind: kind.clone(),
                amount,
                outcome: "failed",
                ledger_tx_id: None,
                partner_ref: None,
                reason: Some(super::reason_of(&e)),
            },
        });
    }
    super::cashback::announce_wallet(m, &authorization.id)?;
    let Some(report) = partner.hold_state(&hold)? else {
        return Err(refuse(
            "bank.card_partner_hold_not_found",
            format!(
                "The card partner has no record of the hold for {}",
                authorization.authorization_ref
            ),
        ));
    };
    Ok(Resumed {
        authorization_id: authorization.id.clone(),
        resumed,
        held: parse_amount(&report.open).map_err(Refusal::Other)?,
    })
}

/// `PartnerRefundResult`.
pub struct Refunded {
    pub authorization_id: String,
    pub refunded: Amount,
    pub partner_ref: String,
    pub figures: Option<Figures>,
}

fn refund_conflict() -> Refusal {
    refuse(
        "bank.card_refund_amount_conflict",
        "A refund is an amount above zero. Nothing moved.",
    )
}

/// `refund`: a merchant's refund of a partner-held capture, once per authorisation under `card.partner.refund:<id>`.
/// A custodial authorisation's refund is not built.
pub fn refund(
    m: &Moves<'_>,
    card_id: &str,
    authorization_ref: &str,
    amount: Amount,
) -> Result<Refunded, Refusal> {
    m.d.assert_issuer_may_mutate()?;
    let card = crate::cards::read_card(m.d, card_id)?;
    let authorization = require_approved(m, &card, authorization_ref)?;
    if authorization.held_by != "partner" {
        return Err(refuse(
            "bank.card_refund_not_built",
            "A refund on a card held in INTAFACED\u{2019}s own ledger is not built. Nothing moved.",
        ));
    }
    if amount <= 0 {
        return Err(refund_conflict());
    }
    let credit = match authorization
        .conversion
        .as_ref()
        .filter(|c| c.quality == "partner")
    {
        Some(c) => mul_div(amount, ONE, c.rate, Rounding::Floor),
        None => amount,
    };
    if credit <= 0 {
        return Err(refund_conflict());
    }
    let captured = with(m.store(), |c| {
        Ok(!c
            .query(
                "SELECT 1 FROM bank.card_settlements WHERE authorization_id = $1::text::uuid AND sequence = 0 \
                   AND kind = 'capture' AND status = 'settled'",
                &[&authorization.id],
            )
            .map_err(|e| pg(&e))?
            .is_empty())
    })?;
    if !captured {
        return Err(refuse(
            "bank.card_refund_nothing_captured",
            format!("Authorisation {authorization_ref} has no settled capture to refund"),
        ));
    }
    let partner = require_holds(m)?;
    let shown = format_amount(credit);
    let prior_ref = in_tx(m.store(), |tx| {
        let fresh = tx
            .query(
                "INSERT INTO bank.card_partner_refunds (authorization_id, amount) VALUES ($1::text::uuid, $2::text::numeric) \
                 ON CONFLICT (authorization_id) DO NOTHING RETURNING authorization_id",
                &[&authorization.id, &shown],
            )
            .map_err(|e| pg(&e))?;
        if !fresh.is_empty() {
            return Ok(None);
        }
        let rows = tx
            .query(
                "SELECT amount::text, status::text, partner_ref FROM bank.card_partner_refunds \
                  WHERE authorization_id = $1::text::uuid FOR UPDATE",
                &[&authorization.id],
            )
            .map_err(|e| pg(&e))?;
        let Some(prior) = rows.first() else {
            return Err(Refusal::Other("refund claim vanished".to_owned()));
        };
        let (pamount, pstatus, pref): (String, String, Option<String>) =
            (prior.get(0), prior.get(1), prior.get(2));
        if pstatus == "rejected" {
            tx.execute(
                "UPDATE bank.card_partner_refunds SET amount = $2::text::numeric, status = 'pending', rejection_code = NULL \
                  WHERE authorization_id = $1::text::uuid",
                &[&authorization.id, &shown],
            )
            .map_err(|e| pg(&e))?;
            return Ok(None);
        }
        if parse_amount(&pamount).ok() != Some(credit) {
            return Err(refuse(
                "bank.card_refund_amount_conflict",
                format!("This authorisation's refund was asked for {pamount}, not {shown}"),
            ));
        }
        Ok(if pstatus == "settled" { pref } else { None })
    })?;
    if let Some(partner_ref) = prior_ref {
        return Ok(Refunded {
            authorization_id: authorization.id,
            refunded: credit,
            partner_ref,
            figures: None,
        });
    }
    let answer = match partner.refund(
        &key("refund", &authorization.id),
        &hold_key(&authorization.id),
        &shown,
    ) {
        Ok(a) => a,
        Err(PartnerErr::Refused(r)) => {
            let code = super::code_of(&r).unwrap_or_default().to_owned();
            with(m.store(), |c| {
                c.execute(
                    "UPDATE bank.card_partner_refunds SET status = 'rejected', rejection_code = $2 \
                      WHERE authorization_id = $1::text::uuid AND status = 'pending'",
                    &[&authorization.id, &code],
                )
                .map_err(|e| pg(&e))
            })?;
            return Err(r);
        }
        Err(PartnerErr::Other(r)) => return Err(r),
    };
    if parse_amount(&answer.amount).ok() != Some(credit) {
        return Err(key_conflict(format!(
            "The card partner refunded {} under this refund's key, not {shown}",
            answer.amount
        )));
    }
    with(m.store(), |c| {
        c.execute(
            "UPDATE bank.card_partner_refunds SET status = 'settled', partner_ref = $2, settled_at = now() \
              WHERE authorization_id = $1::text::uuid",
            &[&authorization.id, &answer.partner_ref],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Refunded {
        authorization_id: authorization.id,
        refunded: credit,
        partner_ref: answer.partner_ref,
        figures: Some(answer.figures),
    })
}
