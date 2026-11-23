//! The card programme as an operator reads and changes it (`ops/card-programme.ts`, `cards/partner-terms.ts`,
//! `CardService.partnerTerms`, `payFromReconciliation`, `setOperatorStatus`): the card partner's terms in words, the
//! pay-from reconciliation against the partner's own report of each hold, and the operator's freeze. The programme's
//! own reads and its funding (`ops.cardProgramme*`, `ops.requestCardProgrammeFunding`) are slice `card-programme`'s.

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::schema::Value;

use super::text;
use crate::cards::reads::{HoldReads, hold_key};
use crate::cards::terms::{PartnerTerms, Reserve};
use crate::cards::{CARD_COLS, Card, Deps, StatusChange, note_card_status, note_status_event};
use crate::errors::Refusal;
use crate::ops_approval;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// `NOT_KNOWN`: the words every surface shows for an unknown.
pub const NOT_KNOWN: &str = "not known";

/// `BEARER_WORDS`.
fn bearer_words(bearer: &str) -> &str {
    match bearer {
        "partner" => "the partner",
        "programme" => "the programme (INTAFACED)",
        "cardholder" => "the cardholder",
        other => other,
    }
}

/// `MODE_WORDS`: whose crypto, for an operator, in the third person.
fn mode_words(mode: &str) -> &str {
    match mode {
        "partner_holds" => "The partner holds the cardholder\u{2019}s crypto and spends it",
        "wallet_pull" => "The card pulls from the cardholder\u{2019}s own wallet",
        other => other,
    }
}

/// `partnerTermsView` with the procedure's label: each unknown is "not known", a reserve never reads 0 for one, and a
/// loss is never assumed to be the partner's. A reserve the partner sent with no time for it is "not known".
pub fn partner_terms_view(terms: &PartnerTerms, display_name: &str) -> Json {
    let reserve = if terms.figures_as_of.is_none() {
        None
    } else {
        terms.reserve.as_ref()
    };
    let reported = |known: bool| Json::str(if known { "reported" } else { "not_known" });
    Json::obj([
        ("test", Json::Bool(terms.test)),
        (
            "label",
            Json::str(if terms.test {
                "TEST partner card adapter"
            } else {
                display_name
            }),
        ),
        (
            "custodyMode",
            Json::str(terms.custody_mode.as_deref().map_or(NOT_KNOWN, mode_words)),
        ),
        (
            "funder",
            Json::str(terms.funder.as_deref().unwrap_or(NOT_KNOWN)),
        ),
        (
            "reserve",
            Json::str(match reserve {
                None => NOT_KNOWN.to_owned(),
                Some(Reserve::Required { amount, asset_id }) => {
                    format!("{amount} {asset_id}, as the partner reports")
                }
                Some(Reserve::NotRequired) => "None required, as the partner reports".to_owned(),
            }),
        ),
        ("reserveStatus", reported(reserve.is_some())),
        (
            "lossLiability",
            Json::str(match &terms.loss_liability {
                Some((bearer, words)) => format!(
                    "{}, under the partner's terms: {words}",
                    bearer_words(bearer)
                ),
                None => NOT_KNOWN.to_owned(),
            }),
        ),
        (
            "lossLiabilityStatus",
            reported(terms.loss_liability.is_some()),
        ),
    ])
}

/// `ops.cardPartnerTerms`: no issuer refuses `bank.no_card_issuer`; the simulator in a live deployment
/// `bank.card_sim_not_live`.
pub fn partner_terms(d: &Deps<'_>) -> Result<Json, Refusal> {
    let terms = d.issuer().partner_terms()?;
    Ok(partner_terms_view(
        &terms,
        d.issuer().programme().display_name,
    ))
}

// ---------------------------------------------------------------------------------------------------------------
// The pay-from reconciliation (J-bank-29 #8).

/// A figure that may fall below zero, as a decimal string (`signedAmount`).
pub fn signed(a: Amount) -> String {
    if a < Amount::ZERO {
        format!("-{}", format_amount(-a))
    } else {
        format_amount(a)
    }
}

#[derive(Default)]
struct Totals {
    app_spend: Amount,
    partner_spend: Amount,
    app_open: Amount,
    partner_open: Amount,
}

fn figures(spend: Amount, open: Amount) -> Json {
    Json::obj([
        ("spend", Json::str(signed(spend))),
        ("open", Json::str(signed(open))),
    ])
}

fn amount_of(v: Option<&str>) -> Result<Amount, Refusal> {
    v.map_or(Ok(Amount::ZERO), |s| {
        parse_amount(s).map_err(Refusal::Other)
    })
}

/// `payFromReconciliation`: per asset, the spend and open holds the card partner reports against what the app recorded
/// from its answers, each line `matches` or `break`, and every hold that does not agree as its own break row (`not_reported`,
/// `unreadable` when the read fails, or `differs`). Only holds the partner reports are summed into the lines. Reads only.
/// `holds` is the partner card's read side (`partnerHolds`), `None` when the deployment has none.
pub fn pay_from_reconciliation(
    d: &Deps<'_>,
    holds: Option<&dyn HoldReads>,
) -> Result<Json, Refusal> {
    let rows = with(d.store(), |c| {
        c.query(
            "SELECT a.id::text, a.authorization_ref, c.funding_asset_id, a.amount::text, \
                    (SELECT s.amount::text FROM bank.card_settlements s \
                      WHERE s.authorization_id = a.id AND s.kind = 'capture' AND s.status = 'settled' ORDER BY s.sequence LIMIT 1), \
                    (SELECT sum(s.amount)::text FROM bank.card_settlements s \
                      WHERE s.authorization_id = a.id AND s.kind = 'reversal' AND s.status = 'settled'), \
                    (SELECT r.amount::text FROM bank.card_partner_refunds r WHERE r.authorization_id = a.id AND r.status = 'settled') \
               FROM bank.card_authorizations a \
               JOIN bank.card_conversions c ON c.authorization_id = a.id AND c.rate_quality = 'partner' \
              WHERE a.pay_from_order IS NOT NULL AND a.money_book = 'partner' AND a.decision = 'approved' AND a.status = 'settled' \
              ORDER BY a.decided_at DESC \
              LIMIT 1000",
            &[],
        )
        .map_err(|e| pg(&e))
    })?;
    let mut totals: BTreeMap<String, Totals> = BTreeMap::new();
    let mut breaks = Vec::new();
    for r in &rows {
        let id: String = r.get(0);
        let reference: String = r.get(1);
        let asset: String = r.get(2);
        let held = amount_of(Some(&r.get::<_, String>(3)))?;
        let captured = amount_of(r.get::<_, Option<String>>(4).as_deref())?;
        let returned = amount_of(r.get::<_, Option<String>>(5).as_deref())?;
        let refunded = amount_of(r.get::<_, Option<String>>(6).as_deref())?;
        let app_spend = captured - refunded;
        let app_open = held - captured - returned;
        let t = totals.entry(asset.clone()).or_default();
        let break_row = |reason: &str, partner: Json| {
            Json::obj([
                ("authorizationRef", Json::str(reference.clone())),
                ("assetId", Json::str(asset.clone())),
                ("reason", Json::str(reason)),
                ("app", figures(app_spend, app_open)),
                ("partner", partner),
            ])
        };
        // A read that fails is not the partner saying it holds nothing: it stays its own reason.
        let report = match holds {
            None => {
                breaks.push(break_row("not_reported", Json::Null));
                continue;
            }
            Some(h) => match h.hold_state(&hold_key(&id)) {
                Err(_) => {
                    breaks.push(break_row("unreadable", Json::Null));
                    continue;
                }
                Ok(None) => {
                    breaks.push(break_row("not_reported", Json::Null));
                    continue;
                }
                Ok(Some(report)) => report,
            },
        };
        let partner_spend = amount_of(Some(&report.captured))? - amount_of(Some(&report.refunded))?;
        let partner_open = amount_of(Some(&report.open))?;
        t.app_spend += app_spend;
        t.app_open += app_open;
        t.partner_spend += partner_spend;
        t.partner_open += partner_open;
        let other_asset = report.asset_id.as_deref().is_some_and(|a| a != asset);
        if partner_spend != app_spend || partner_open != app_open || other_asset {
            breaks.push(break_row("differs", figures(partner_spend, partner_open)));
        }
    }
    let line = |asset: &str, kind: &str, app: Amount, partner: Amount| {
        Json::obj([
            ("assetId", Json::str(asset)),
            ("kind", Json::str(kind)),
            ("app", Json::str(signed(app))),
            ("partner", Json::str(signed(partner))),
            (
                "status",
                Json::str(if app == partner { "matches" } else { "break" }),
            ),
        ])
    };
    let mut lines = Vec::new();
    for (asset, t) in &totals {
        lines.push(line(asset, "spend", t.app_spend, t.partner_spend));
        lines.push(line(asset, "open_holds", t.app_open, t.partner_open));
    }
    // The partner's own terms are read last, as the TypeScript reads them: no issuer refuses here, after the read.
    let test = d.issuer().partner_terms()?.test;
    Ok(Json::obj([
        ("test", Json::Bool(test)),
        ("partnerReports", Json::Bool(holds.is_some())),
        ("lines", Json::Array(lines)),
        ("breaks", Json::Array(breaks)),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// The operator's freeze.

fn reason_too_short() -> Refusal {
    refuse(
        "bank.ops_reason_too_short",
        "An operator card change needs a reason of at least 10 characters (bank.ops_reason_too_short)",
    )
}

/// A command the operator already sent under its client id: `(card_id, target_status, reason, result_status, frozen_by)`.
type Command = (String, String, String, String, Option<String>);

fn operator_command(
    c: &mut impl postgres::GenericClient,
    client_request_id: &str,
) -> Result<Option<Command>, Refusal> {
    let rows = c
        .query(
            "SELECT card_id::text, target_status, reason, result_status, frozen_by \
               FROM bank.card_operator_commands WHERE client_request_id = $1",
            &[&client_request_id],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows
        .first()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))))
}

fn answer(card_id: &str, status: &str, frozen_by: Option<&str>) -> Json {
    Json::obj([
        ("cardId", Json::str(card_id)),
        ("status", Json::str(status)),
        ("frozenBy", frozen_by.map_or(Json::Null, Json::str)),
    ])
}

/// `replayOperatorCommand`: the same card, status and reason replays the first answer; anything else under the id
/// refuses.
fn replay(prior: &Command, card_id: &str, status: &str, reason: &str) -> Result<Json, Refusal> {
    let (prior_card, target, prior_reason, result, frozen_by) = prior;
    if prior_card != card_id || target != status || prior_reason != reason {
        return Err(refuse(
            "bank.card_command_conflict",
            "This command id was already used for a different card change",
        ));
    }
    Ok(answer(
        prior_card,
        if result == "active" {
            "active"
        } else {
            "frozen"
        },
        (frozen_by.as_deref() == Some("operator")).then_some("operator"),
    ))
}

/// `ops.setCardStatus` (`setOperatorStatus`): an operator freeze or unfreeze. The client id is the idempotency key. The
/// reason is checked first; a replay of the same terms returns the first answer without spending a second approval;
/// otherwise the approval bound to this card and this status is consumed before the card is changed, and a refused
/// approval changes nothing. The issuer is told inside the card's transaction, so a refusal there changes no row.
pub fn set_card_status(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let card_id = text(input, "cardId");
    let status = text(input, "status");
    let client_request_id = text(input, "clientRequestId");
    let reason = js_trim(text(input, "reason"));
    if reason.encode_utf16().count() < 10 {
        return Err(reason_too_short());
    }
    if let Some(prior) = with(d.store(), |c| operator_command(c, client_request_id))? {
        return replay(&prior, card_id, status, reason);
    }
    ops_approval::consume(
        d.t.w.approvals.as_ref(),
        input,
        "bank.ops.setCardStatus",
        &[
            ("cardId".to_owned(), card_id.to_owned()),
            ("status".to_owned(), status.to_owned()),
        ],
    )?;
    in_tx(d.store(), |tx| {
        if let Some(raced) = operator_command(tx, client_request_id)? {
            return replay(&raced, card_id, status, reason);
        }
        let rows = tx
            .query(
                &format!("SELECT {CARD_COLS} FROM bank.cards WHERE id = $1::text::uuid FOR UPDATE"),
                &[&card_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(card) = rows.first().map(Card::from_row).transpose()? else {
            return Err(refuse(
                "bank.card_not_found",
                format!("Card {card_id} not found"),
            ));
        };
        if card.status == "closed" {
            return Err(refuse(
                "bank.card_not_active",
                "A closed card cannot be reopened",
            ));
        }
        d.issuer().set_status()?;
        let frozen_by = (status == "frozen").then_some("operator");
        tx.execute(
            "UPDATE bank.cards SET status = $2::text::bank.card_status, frozen_by = $3, updated_at = now() WHERE id = $1::text::uuid",
            &[&card.id, &status, &frozen_by],
        )
        .map_err(|e| pg(&e))?;
        // The row is locked above, so this is the status it had.
        if card.status != status {
            note_status_event(tx, &card.id, status, "operator")?;
            note_card_status(
                tx,
                &StatusChange {
                    card_id: &card.id,
                    owner_user_id: &card.user_id,
                    actor: None,
                    status,
                    replacement_card_id: None,
                },
            )?;
        }
        tx.execute(
            "INSERT INTO bank.card_operator_commands (client_request_id, card_id, target_status, reason, result_status, frozen_by) \
             VALUES ($1, $2::text::uuid, $3, $4, $5, $6)",
            &[&client_request_id, &card.id, &status, &reason, &status, &frozen_by],
        )
        .map_err(|e| pg(&e))?;
        Ok(answer(&card.id, status, frozen_by))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signed_figure_keeps_its_sign_and_its_exact_decimals() {
        assert_eq!(
            signed(parse_amount("-0.0008").unwrap_or_default()),
            "-0.0008"
        );
        assert_eq!(signed(parse_amount("12").unwrap_or_default()), "12");
        assert_eq!(signed(Amount::ZERO), "0");
    }

    #[test]
    fn an_unknown_reads_not_known_and_a_reserve_sent_with_no_time_is_not_known() {
        let mut terms = PartnerTerms::nothing_reported();
        let view = partner_terms_view(&terms, "x");
        assert_eq!(view.get("reserve"), Some(&Json::str(NOT_KNOWN)));
        assert_eq!(view.get("lossLiability"), Some(&Json::str(NOT_KNOWN)));
        terms.reserve = Some(Reserve::NotRequired);
        let view = partner_terms_view(&terms, "x");
        assert_eq!(view.get("reserveStatus"), Some(&Json::str("not_known")));
    }
}
