//! The card moves' calls (`router/ops.router.ts`: `ops.cardAuthorize`, `ops.cardThreeDSChallenge`, `ops.cardCapture`,
//! `ops.cardReverse`, `ops.cardResumeSettlement`, `ops.fundCashbackPot`; `partner/test-partner.router.ts`:
//! `testPartner.cardRefund`). Each `ops.*` call consumes the second founder's approval, bound to its action and fields,
//! before it moves anything; the output names the approver.

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::schema::Value;

use super::decide::{Ask, authorize};
use super::{Auth, Moves, partner, settle};
use crate::cards::core::{bool_of, opt_text, text};
use crate::cards::reads::Figures;
use crate::cards::safety::{OpenAsk, open};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::ops_approval;

fn amount(input: &Value, key: &str) -> Result<service_kit::money::Amount, Refusal> {
    parse_amount(text(input, key)).map_err(Refusal::Other)
}

fn owned(v: Option<&str>) -> Option<String> {
    v.map(str::to_owned)
}

fn approve(
    m: &Moves<'_>,
    input: &Value,
    action: &str,
    fields: &[(&str, Option<&str>)],
) -> Result<String, Refusal> {
    let fields: Vec<(String, String)> = fields
        .iter()
        .filter_map(|(k, v)| v.map(|v| ((*k).to_owned(), v.to_owned())))
        .collect();
    Ok(ops_approval::consume(m.d.t.w.approvals.as_ref(), input, action, &fields)?.approver_id)
}

fn opt(v: Option<String>) -> Json {
    v.map_or(Json::Null, Json::str)
}

fn figures(f: Option<Figures>) -> Json {
    f.as_ref().map_or(Json::Null, Figures::json)
}

/// `cardAuthorize`'s output.
fn authorized(a: &Auth, confirm: String) -> Json {
    let conversion = a.conversion.as_ref().map_or(Json::Null, |c| {
        Json::obj([
            (
                "settlementAssetId",
                Json::str(c.settlement_asset_id.clone()),
            ),
            (
                "settlementAmount",
                Json::str(format_amount(c.settlement_amount)),
            ),
            ("rate", Json::str(format_amount(c.rate))),
            ("rateQuality", Json::str(c.quality.clone())),
            ("rateAsOf", Json::str(c.rate_as_of.iso())),
        ])
    });
    Json::obj([
        ("authorizationId", Json::str(a.id.clone())),
        ("decision", Json::str(a.decision.clone())),
        ("declineCode", opt(a.decline_code.clone())),
        ("amount", Json::str(format_amount(a.amount))),
        ("conversion", conversion),
        ("confirmOperatorId", Json::str(confirm)),
    ])
}

/// The router's `roundUp` object: `positionId` for a pool; a space with its ledger transaction, or with the partner's
/// move and no ledger key at all.
fn round_up(r: &crate::automations::auto_invest::service::RoundUpOutcome) -> Json {
    use crate::automations::auto_invest::service::RoundUpOutcome as R;
    let mut f = vec![
        ("status".to_owned(), Json::str(r.status())),
        ("amount".to_owned(), Json::str(format_amount(r.amount()))),
    ];
    let mut put = |k: &str, v: &str| f.push((k.to_owned(), Json::str(v)));
    match r {
        R::Skipped { reason, .. } | R::Refused { reason, .. } => put("reason", reason),
        R::SettledPool { position_id, .. } => put("positionId", position_id),
        R::SettledSpace {
            space_id,
            ledger_tx_id,
            ..
        } => {
            put("spaceId", space_id);
            put("ledgerTxId", ledger_tx_id);
        }
        R::SettledPartner {
            space_id,
            partner_move_id,
            ..
        } => {
            put("spaceId", space_id);
            put("partnerMoveId", partner_move_id);
        }
        R::None => {}
    }
    Json::Object(f)
}

fn card_authorize(m: &Moves<'_>, input: &Value) -> Result<Json, Refusal> {
    let confirm = approve(
        m,
        input,
        "bank.card_authorize",
        &[
            ("cardId", Some(text(input, "cardId"))),
            ("authorizationRef", Some(text(input, "authorizationRef"))),
            ("amount", Some(text(input, "amount"))),
        ],
    )?;
    let a = authorize(
        m,
        &Ask {
            card_id: text(input, "cardId").to_owned(),
            authorization_ref: text(input, "authorizationRef").to_owned(),
            amount: amount(input, "amount")?,
            merchant_category: owned(opt_text(input, "merchantCategory")),
            merchant: owned(opt_text(input, "merchant")),
            merchant_country: owned(opt_text(input, "merchantCountry")),
            channel: owned(opt_text(input, "channel")),
            pin: owned(opt_text(input, "pin")),
            recurring: bool_of(input, "recurring"),
            three_ds: None,
        },
    )?;
    Ok(authorized(&a, confirm))
}

fn card_3ds_challenge(m: &Moves<'_>, input: &Value) -> Result<Json, Refusal> {
    let confirm = approve(
        m,
        input,
        "bank.card_3ds_challenge",
        &[
            ("cardId", Some(text(input, "cardId"))),
            ("challengeId", Some(text(input, "challengeId"))),
            ("challengeRef", Some(text(input, "challengeRef"))),
            ("amount", Some(text(input, "amount"))),
            ("merchantCategory", opt_text(input, "merchantCategory")),
            ("merchant", opt_text(input, "merchant")),
            ("merchantCountry", opt_text(input, "merchantCountry")),
        ],
    )?;
    let view = open(
        m.d,
        &OpenAsk {
            challenge_id: text(input, "challengeId").to_owned(),
            card_id: text(input, "cardId").to_owned(),
            challenge_ref: text(input, "challengeRef").to_owned(),
            amount: amount(input, "amount")?,
            merchant: owned(opt_text(input, "merchant")),
            merchant_country: owned(opt_text(input, "merchantCountry")),
            merchant_category: owned(opt_text(input, "merchantCategory")),
        },
    )?;
    Ok(Json::obj([
        ("challengeId", view.get("id").cloned().unwrap_or(Json::Null)),
        ("state", view.get("state").cloned().unwrap_or(Json::Null)),
        ("confirmOperatorId", Json::str(confirm)),
    ]))
}

fn card_capture(m: &Moves<'_>, input: &Value) -> Result<Json, Refusal> {
    let confirm = approve(
        m,
        input,
        "bank.card_capture",
        &[
            ("cardId", Some(text(input, "cardId"))),
            ("authorizationRef", Some(text(input, "authorizationRef"))),
            ("amount", Some(text(input, "amount"))),
        ],
    )?;
    let r = settle::capture(
        m,
        text(input, "cardId"),
        text(input, "authorizationRef"),
        amount(input, "amount")?,
    )?;
    let partner = r.partner.map_or(Json::Null, |p| {
        Json::obj([
            ("captureRef", Json::str(p.capture_ref)),
            ("releaseRef", opt(p.release_ref)),
            ("figures", figures(p.figures)),
        ])
    });
    let settlement = r.settlement.map_or(Json::Null, |(asset, amount, rate)| {
        Json::obj([
            ("assetId", Json::str(asset)),
            ("amount", Json::str(format_amount(amount))),
            ("rate", Json::str(format_amount(rate))),
        ])
    });
    Ok(Json::obj([
        ("captured", Json::str(format_amount(r.captured))),
        ("returned", Json::str(format_amount(r.returned))),
        ("captureLedgerTxId", opt(r.capture_ledger_tx_id)),
        ("reversalLedgerTxId", opt(r.reversal_ledger_tx_id)),
        ("heldBy", Json::str(r.held_by)),
        ("partner", partner),
        ("settlement", settlement),
        ("cashback", r.cashback.json()),
        ("roundUp", round_up(&r.round_up)),
        ("confirmOperatorId", Json::str(confirm)),
    ]))
}

fn card_reverse(m: &Moves<'_>, input: &Value) -> Result<Json, Refusal> {
    let confirm = approve(
        m,
        input,
        "bank.card_reverse",
        &[
            ("cardId", Some(text(input, "cardId"))),
            ("authorizationRef", Some(text(input, "authorizationRef"))),
        ],
    )?;
    let r = settle::reverse(m, text(input, "cardId"), text(input, "authorizationRef"))?;
    let mut f = vec![
        ("returned".to_owned(), Json::str(format_amount(r.returned))),
        ("ledgerTxId".to_owned(), opt(r.ledger_tx_id)),
    ];
    if let Some((release_ref, by, fig)) = r.partner {
        f.push((
            "partner".to_owned(),
            Json::obj([
                ("releaseRef", Json::str(release_ref)),
                ("by", Json::str(by)),
                ("figures", figures(fig)),
            ]),
        ));
    }
    f.push(("confirmOperatorId".to_owned(), Json::str(confirm)));
    Ok(Json::Object(f))
}

fn card_resume(m: &Moves<'_>, input: &Value) -> Result<Json, Refusal> {
    let confirm = approve(
        m,
        input,
        "bank.card_resume_settlement",
        &[
            ("cardId", Some(text(input, "cardId"))),
            ("authorizationRef", Some(text(input, "authorizationRef"))),
        ],
    )?;
    let r = settle::resume_settlements(m, text(input, "cardId"), text(input, "authorizationRef"))?;
    let rows = r
        .resumed
        .into_iter()
        .map(|row| {
            let mut f = vec![
                ("sequence".to_owned(), Json::int(i64::from(row.sequence))),
                ("kind".to_owned(), Json::str(row.kind)),
                ("amount".to_owned(), Json::str(format_amount(row.amount))),
                ("outcome".to_owned(), Json::str(row.outcome)),
            ];
            for (k, v) in [
                ("ledgerTxId", row.ledger_tx_id),
                ("partnerRef", row.partner_ref),
                ("reason", row.reason),
            ] {
                if let Some(v) = v {
                    f.push((k.to_owned(), Json::str(v)));
                }
            }
            Json::Object(f)
        })
        .collect();
    Ok(Json::obj([
        ("authorizationId", Json::str(r.authorization_id)),
        ("resumed", Json::Array(rows)),
        ("held", Json::str(format_amount(r.held))),
        ("confirmOperatorId", Json::str(confirm)),
    ]))
}

fn fund_cashback_pot(m: &Moves<'_>, input: &Value) -> Result<Json, Refusal> {
    let confirm = approve(
        m,
        input,
        "bank.fund_cashback_pot",
        &[
            ("windowId", Some(text(input, "windowId"))),
            ("assetId", Some(text(input, "assetId"))),
            ("amount", Some(text(input, "amount"))),
        ],
    )?;
    let asset = text(input, "assetId");
    let tx =
        super::cashback::fund_pot(m, text(input, "windowId"), asset, amount(input, "amount")?)?;
    Ok(Json::obj([
        ("ledgerTxId", Json::str(tx)),
        (
            "capacity",
            Json::str(format_amount(super::cashback::capacity(m, asset)?)),
        ),
        ("confirmOperatorId", Json::str(confirm)),
    ]))
}

/// `testPartner.cardRefund`, past the TEST partner's switch: the card is the caller's own, then the refund.
pub fn card_refund(m: &Moves<'_>, user_id: &str, input: &Value) -> Result<Json, Refusal> {
    let card = crate::cards::read_card(m.d, text(input, "cardId"))?;
    crate::transfers::schedules::assert_self(user_id, &card.user_id)?;
    let done = partner::refund(
        m,
        text(input, "cardId"),
        text(input, "authorizationRef"),
        amount(input, "amount")?,
    )?;
    Ok(Json::obj([
        ("authorizationId", Json::str(done.authorization_id)),
        ("refunded", Json::str(format_amount(done.refunded))),
        ("partnerRef", Json::str(done.partner_ref)),
        ("figures", figures(done.figures)),
    ]))
}

/// The slice's `ops.*` calls; `None` for a call that is not a card move.
pub fn answer(m: &Moves<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    Some(match ctx.call.path {
        "ops.cardAuthorize" => card_authorize(m, input),
        "ops.cardThreeDSChallenge" => card_3ds_challenge(m, input),
        "ops.cardCapture" => card_capture(m, input),
        "ops.cardReverse" => card_reverse(m, input),
        "ops.cardResumeSettlement" => card_resume(m, input),
        "ops.fundCashbackPot" => fund_cashback_pot(m, input),
        _ => return None,
    })
}
