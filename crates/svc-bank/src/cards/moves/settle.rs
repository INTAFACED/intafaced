//! Capture, reversal and their recovery (`card-service.ts`: `capture`, `reverse`, `requireOpenAuthorization`,
//! `settlement`, `resumeSettlements`, `heldFor`, `closeWhenUsedUp`, `reverseOpenHolds`, `releaseClaimed`).
//!
//! IF THIS CRASHES EXACTLY HERE, WHOSE FUNDS ARE STRANDED? None. Each settlement row is claimed before its post, under a
//! key that is the authorisation (`withdraw.settle:<id>`, `withdraw.reverse:<id>`), so a process that dies between them
//! leaves a `pending` row that `resumeSettlements` re-drives for the amount it was claimed with. Only a definite ledger
//! refusal marks a row `rejected`; anything else may follow a commit whose reply was lost, and stays `pending`.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};

use super::cashback::{self, Outcome};
use super::conversion::funding_for;
use super::{Auth, Moves, custody_guard, definite_refusal, post_refusal, require_approved};
use crate::automations::auto_invest::service::RoundUpOutcome;
use crate::cards::reads::Figures;
use crate::cards::{Card, StatusChange, note_card_status, note_status_event, update_status};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::LedgerAccount;
use crate::spaces::space::{in_tx, pg, with};

/// The partner's side of a capture.
pub struct PartnerCapture {
    pub capture_ref: String,
    pub release_ref: Option<String>,
    pub figures: Option<Figures>,
}

/// `CaptureResult`.
pub struct Captured {
    pub authorization_id: String,
    pub captured: Amount,
    pub returned: Amount,
    pub capture_ledger_tx_id: Option<String>,
    pub reversal_ledger_tx_id: Option<String>,
    pub held_by: &'static str,
    pub partner: Option<PartnerCapture>,
    pub cashback: Outcome,
    pub round_up: RoundUpOutcome,
    /// The settlement asset, the merchant's amount and the frozen rate, on a converted card.
    pub settlement: Option<(String, Amount, Amount)>,
}

/// `reverse`'s answer: what went back, and on a partner-held one the release's reference, how, and the figures.
pub struct Released {
    pub returned: Amount,
    pub ledger_tx_id: Option<String>,
    pub partner: Option<(String, &'static str, Option<Figures>)>,
}

/// One re-driven row.
pub struct ResumedRow {
    pub sequence: i32,
    pub kind: String,
    pub amount: Amount,
    /// `settled` or `failed`.
    pub outcome: &'static str,
    pub ledger_tx_id: Option<String>,
    pub partner_ref: Option<String>,
    pub reason: Option<String>,
}

/// `resumeSettlements`' answer.
pub struct Resumed {
    pub authorization_id: String,
    pub resumed: Vec<ResumedRow>,
    pub held: Amount,
}

/// `withdrawalHoldAccount`: the hold account one authorisation names.
pub fn hold_account(user_id: &str, asset_id: &str, authorization_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "user",
        owner_id: user_id.to_owned(),
        asset_id: asset_id.to_owned(),
        kind: "hold",
        purpose: Some(format!("withdraw:{authorization_id}")),
    }
}

/// `heldFor`: what is still held against an authorisation, read from the ledger, never stored.
pub fn held_for(
    m: &Moves<'_>,
    authorization_id: &str,
    user_id: &str,
    asset_id: &str,
) -> Result<Amount, Refusal> {
    m.d.t
        .ledger
        .balance(&hold_account(user_id, asset_id, authorization_id))
        .map_err(Refusal::Other)
}

/// One of the three withdraw recipes, for this card and authorisation, under its business key.
pub fn post_withdraw(
    m: &Moves<'_>,
    recipe: &str,
    card: &Card,
    authorization_id: &str,
    amount: Amount,
) -> Result<String, super::PostErr> {
    custody_guard(m).map_err(super::PostErr::Guard)?;
    let prefix = match recipe {
        "withdrawHold" => "withdraw.hold",
        "withdrawSettle" => "withdraw.settle",
        _ => "withdraw.reverse",
    };
    let input = Json::obj([
        ("userId", Json::str(card.user_id.clone())),
        ("assetId", Json::str(card.asset_id.clone())),
        ("amount", Json::str(format_amount(amount))),
        ("rail", Json::str(card.issuer.clone())),
        ("withdrawalId", Json::str(authorization_id)),
    ]);
    m.d.t
        .ledger
        .post_recipe(recipe, &input, &format!("{prefix}:{authorization_id}"))
        .map(|tx| tx.id)
        .map_err(super::PostErr::Ledger)
}

/// `requireOpenAuthorization`: approved, its hold landed, and this kind may still move it. Only a SETTLED sequence-0 row
/// closes it; a pending one of the other kind refuses.
fn require_open(
    m: &Moves<'_>,
    card: &Card,
    authorization_ref: &str,
    kind: &str,
) -> Result<Auth, Refusal> {
    let a = require_approved(m, card, authorization_ref)?;
    let claim: Option<(String, String)> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT status::text, kind::text FROM bank.card_settlements WHERE authorization_id = $1::text::uuid AND sequence = 0",
            &[&a.id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| (r.get(0), r.get(1))))
    })?;
    if let Some((status, prior)) = claim {
        if status == "settled" {
            return Err(refuse(
                "bank.card_authorization_closed",
                format!("Authorisation {authorization_ref} has already been settled"),
            ));
        }
        if status == "pending" && prior != kind {
            return Err(refuse(
                "bank.card_settlement_kind_conflict",
                format!(
                    "Authorisation {authorization_ref} has a pending {prior} on sequence 0, not a {kind}"
                ),
            ));
        }
    }
    Ok(a)
}

fn kind_conflict(sequence: i32, prior: &str, kind: &str) -> Refusal {
    refuse(
        "bank.card_settlement_kind_conflict",
        format!("Settlement {sequence} on this authorisation was claimed as {prior}, not {kind}"),
    )
}

/// `settlement`: claim the row, post, mark it. The claimed row is the record of what this sequence is for: a caller
/// with a different kind or amount is refused by name, never handed another's transaction.
pub fn settlement(
    m: &Moves<'_>,
    authorization: &Auth,
    sequence: i32,
    kind: &str,
    amount: Amount,
    post: impl FnOnce() -> Result<String, super::PostErr>,
) -> Result<String, Refusal> {
    let shown = format_amount(amount);
    struct Claim {
        claimed: bool,
        id: String,
        ledger_tx_id: Option<String>,
        amount: Amount,
        kind: String,
    }
    let claim = in_tx(m.store(), |tx| {
        let insert = "INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount) \
                      VALUES ($1::text::uuid, $2, $3::text::bank.card_settlement_kind, $4::text::numeric)";
        let rows = tx
            .query(
                &format!("{insert} ON CONFLICT (authorization_id, sequence) DO NOTHING RETURNING id::text"),
                &[&authorization.id, &sequence, &kind, &shown],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = rows.first() {
            return Ok(Claim {
                claimed: true,
                id: r.get(0),
                ledger_tx_id: None,
                amount,
                kind: kind.to_owned(),
            });
        }
        let rows = tx
            .query(
                "SELECT id::text, ledger_tx_id, amount::text, kind::text, status::text FROM bank.card_settlements \
                  WHERE authorization_id = $1::text::uuid AND sequence = $2",
                &[&authorization.id, &sequence],
            )
            .map_err(|e| pg(&e))?;
        let Some(prior) = rows.first() else {
            return Err(Refusal::Other("settlement claim vanished".to_owned()));
        };
        let (pid, ptx, pamount, pkind, pstatus): (String, Option<String>, String, String, String) = (
            prior.get(0),
            prior.get(1),
            prior.get(2),
            prior.get(3),
            prior.get(4),
        );
        let prior_amount = parse_amount(&pamount).map_err(Refusal::Other)?;
        // A rejected claim of the other kind for the same amount is retired and claimed again as the kind that is posting.
        if pkind != kind && pstatus == "rejected" && prior_amount == amount {
            let removed = tx
                .query(
                    "DELETE FROM bank.card_settlements WHERE id = $1::text::uuid AND status = 'rejected' \
                       AND kind = $2::text::bank.card_settlement_kind RETURNING id",
                    &[&pid, &pkind],
                )
                .map_err(|e| pg(&e))?;
            if removed.is_empty() {
                return Err(kind_conflict(sequence, &pkind, kind));
            }
            let inserted = tx
                .query(
                    &format!("{insert} RETURNING id::text"),
                    &[&authorization.id, &sequence, &kind, &shown],
                )
                .map_err(|e| pg(&e))?;
            let id = inserted
                .first()
                .map(|r| r.get(0))
                .ok_or_else(|| Refusal::Other("settlement claim lost".to_owned()))?;
            return Ok(Claim {
                claimed: true,
                id,
                ledger_tx_id: None,
                amount,
                kind: kind.to_owned(),
            });
        }
        Ok(Claim {
            claimed: false,
            id: pid,
            ledger_tx_id: ptx,
            amount: prior_amount,
            kind: pkind,
        })
    })?;
    if !claim.claimed && claim.kind != kind {
        return Err(kind_conflict(sequence, &claim.kind, kind));
    }
    if claim.amount != amount {
        return Err(refuse(
            "bank.card_settlement_amount_conflict",
            format!(
                "Settlement {sequence} on this authorisation was claimed for {}, not {shown}",
                format_amount(claim.amount)
            ),
        ));
    }
    if !claim.claimed
        && let Some(tx) = claim.ledger_tx_id
    {
        return Ok(tx);
    }
    let posted = match post() {
        Ok(id) => id,
        Err(super::PostErr::Ledger(f)) => {
            // Only a definite ledger refusal proves nothing committed under this key.
            if definite_refusal(&f) {
                let code = f.code().unwrap_or_default().to_owned();
                with(m.store(), |c| {
                    c.execute(
                        "UPDATE bank.card_settlements SET status = 'rejected', rejection_code = $2, ledger_tx_id = NULL \
                          WHERE id = $1::text::uuid",
                        &[&claim.id, &code],
                    )
                    .map_err(|e| pg(&e))
                })?;
            }
            return Err(post_refusal(&f));
        }
        Err(super::PostErr::Guard(r)) => return Err(r),
    };
    with(m.store(), |c| {
        c.execute(
            "UPDATE bank.card_settlements SET status = 'settled', ledger_tx_id = $2, settled_at = now() WHERE id = $1::text::uuid",
            &[&claim.id, &posted],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(posted)
}

/// `capture`: the merchant took `amount` (in its own currency); the rest of the hold goes back. Two posts, each once on
/// the authorisation, after which the hold account reads zero.
pub fn capture(
    m: &Moves<'_>,
    card_id: &str,
    authorization_ref: &str,
    amount: Amount,
) -> Result<Captured, Refusal> {
    let card = crate::cards::read_card(m.d, card_id)?;
    let authorization = require_open(m, &card, authorization_ref, "capture")?;
    if authorization.held_by == "partner" {
        return super::partner::capture_partner_held(m, &card, &authorization, amount);
    }
    let conversion = authorization.conversion.as_ref();
    let authorized = conversion.map_or(authorization.amount, |c| c.settlement_amount);
    if amount <= Amount::ZERO || amount > authorized {
        return Err(refuse(
            "bank.card_capture_exceeds_authorization",
            format!(
                "Capture of {} exceeds the authorised {}",
                format_amount(amount),
                format_amount(authorized)
            ),
        ));
    }
    // The frozen rate, re-read, never re-quoted.
    let funding = match conversion {
        Some(c) => funding_for(amount, c.rate)?,
        None => amount,
    };
    if funding > authorization.amount {
        return Err(refuse(
            "bank.card_capture_exceeds_authorization",
            format!(
                "Capture converts to {} against a hold of {}",
                format_amount(funding),
                format_amount(authorization.amount)
            ),
        ));
    }
    let capture_tx = settlement(m, &authorization, 0, "capture", funding, || {
        post_withdraw(m, "withdrawSettle", &card, &authorization.id, funding)
    })?;
    let remainder = authorization.amount - funding;
    let reversal_tx = if remainder > Amount::ZERO {
        Some(settlement(
            m,
            &authorization,
            1,
            "reversal",
            remainder,
            || post_withdraw(m, "withdrawReverse", &card, &authorization.id, remainder),
        )?)
    } else {
        None
    };
    let cashback = cashback::pay(m, &card, &authorization, funding)?;
    let round_up = cashback::apply_round_up(m, &card, &authorization, funding, false);
    close_when_used_up(m, &card)?;
    Ok(Captured {
        authorization_id: authorization.id.clone(),
        captured: funding,
        returned: remainder,
        capture_ledger_tx_id: Some(capture_tx),
        reversal_ledger_tx_id: reversal_tx,
        held_by: "ledger",
        partner: None,
        cashback,
        round_up,
        settlement: conversion.map(|c| (c.settlement_asset_id.clone(), amount, c.rate)),
    })
}

/// `reverse`: the authorisation expired or was voided; the whole hold goes back, on sequence 0.
pub fn reverse(m: &Moves<'_>, card_id: &str, authorization_ref: &str) -> Result<Released, Refusal> {
    let card = crate::cards::read_card(m.d, card_id)?;
    let authorization = require_open(m, &card, authorization_ref, "reversal")?;
    if authorization.held_by == "partner" {
        return super::partner::release_partner_held(m, &authorization);
    }
    let tx = settlement(
        m,
        &authorization,
        0,
        "reversal",
        authorization.amount,
        || {
            post_withdraw(
                m,
                "withdrawReverse",
                &card,
                &authorization.id,
                authorization.amount,
            )
        },
    )?;
    Ok(Released {
        returned: authorization.amount,
        ledger_tx_id: Some(tx),
        partner: None,
    })
}

/// `resumeSettlements`: re-drive every claimed row that never reached the ledger, each for the amount it was claimed
/// with, then pending cashback, then cashback a settled capture never claimed; report what is still held.
pub fn resume_settlements(
    m: &Moves<'_>,
    card_id: &str,
    authorization_ref: &str,
) -> Result<Resumed, Refusal> {
    let card = crate::cards::read_card(m.d, card_id)?;
    let authorization = require_approved(m, &card, authorization_ref)?;
    if authorization.held_by == "partner" {
        return super::partner::resume_partner_held(m, &authorization);
    }
    let rows: Vec<(i32, String, String)> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT sequence, kind::text, amount::text FROM bank.card_settlements \
              WHERE authorization_id = $1::text::uuid AND status <> 'settled' ORDER BY sequence ASC",
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
        let recipe = if kind == "capture" {
            "withdrawSettle"
        } else {
            "withdrawReverse"
        };
        let done = settlement(m, &authorization, sequence, &kind, amount, || {
            post_withdraw(m, recipe, &card, &authorization.id, amount)
        });
        resumed.push(match done {
            Ok(tx) => ResumedRow {
                sequence,
                kind,
                amount,
                outcome: "settled",
                ledger_tx_id: Some(tx),
                partner_ref: None,
                reason: None,
            },
            Err(e) => ResumedRow {
                sequence,
                kind,
                amount,
                outcome: "failed",
                ledger_tx_id: None,
                partner_ref: None,
                reason: Some(super::reason_of(&e)),
            },
        });
    }
    cashback::retry_pending(m, &card, &authorization.id)?;
    cashback::earn_missing(m, &card, &authorization)?;
    Ok(Resumed {
        authorization_id: authorization.id.clone(),
        resumed,
        held: held_for(m, &authorization.id, &card.user_id, &card.asset_id)?,
    })
}

/// `closeWhenUsedUp`: a single-use or n-use card closes itself once its captured payments reach its limit, counted from
/// the capture records, never stored.
pub fn close_when_used_up(m: &Moves<'_>, card: &Card) -> Result<(), Refusal> {
    let Some(allowed) = card.uses_allowed else {
        return Ok(());
    };
    if with(m.store(), |c| crate::cards::core::uses_made(c, &card.id))? < allowed {
        return Ok(());
    }
    let current = crate::cards::read_card(m.d, &card.id)?;
    if current.status == "closed" {
        return Ok(());
    }
    m.d.issuer().set_status()?;
    in_tx(m.store(), |tx| {
        let changed = update_status(
            tx,
            &current.id,
            "status = 'closed', frozen_by = NULL",
            &[],
            "closed",
        )?;
        if changed {
            note_status_event(tx, &current.id, "closed", "system")?;
            note_card_status(
                tx,
                &StatusChange {
                    card_id: &current.id,
                    owner_user_id: &current.user_id,
                    actor: Some(&current.user_id),
                    status: "closed",
                    replacement_card_id: None,
                },
            )?;
        }
        Ok(())
    })
}

/// `releaseClaimed`: whether a sequence-0 claim (any kind, any status) exists on this authorisation.
fn release_claimed(m: &Moves<'_>, card_id: &str, authorization_ref: &str) -> Result<bool, Refusal> {
    with(m.store(), |c| {
        let n: i64 = c
            .query_one(
                "SELECT count(*)::int8 FROM bank.card_settlements s \
                   JOIN bank.card_authorizations a ON a.id = s.authorization_id \
                  WHERE a.card_id = $1::text::uuid AND a.authorization_ref = $2 AND s.sequence = 0",
                &[&card_id, &authorization_ref],
            )
            .map_err(|e| pg(&e))?
            .get(0);
        Ok(n > 0)
    })
}

/// `reverseOpenHolds`: every hold still open on a lost or stolen card goes back through `reverse`, keyed on its
/// authorisation. A partner-held release that was claimed never waits on the partner's answer; one that failed before
/// its claim is rethrown, and the card stays frozen and open.
pub fn reverse_open_holds(m: &Moves<'_>, card: &Card) -> Result<(), Refusal> {
    let open: Vec<(String, String)> = with(m.store(), |c| {
        Ok(c.query(
            "SELECT a.authorization_ref, a.money_book FROM bank.card_authorizations a \
              WHERE a.card_id = $1::text::uuid AND a.decision = 'approved' \
                AND (a.hold_ledger_tx_id IS NOT NULL OR a.partner_hold_ref IS NOT NULL) \
                AND NOT EXISTS (SELECT 1 FROM bank.card_settlements s WHERE s.authorization_id = a.id AND s.sequence = 0) \
              ORDER BY a.decided_at",
            &[&card.id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect())
    })?;
    for (authorization_ref, book) in open {
        if book == "ledger" {
            reverse(m, &card.id, &authorization_ref)?;
            continue;
        }
        if let Err(e) = reverse(m, &card.id, &authorization_ref)
            && !release_claimed(m, &card.id, &authorization_ref)?
        {
            return Err(e);
        }
    }
    Ok(())
}
