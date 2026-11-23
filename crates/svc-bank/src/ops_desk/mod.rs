//! Slice `ops-desk`: the operator desk's calls (`router/ops.router.ts`: `heldSends`, `releaseHeldSend`,
//! `rejectHeldSend`, `limitRequests`, `decideLimitRequest`, `publishTransferTerms`, `transferHealth`, `failedTransfers`,
//! `transferDetail`, `customerBalances`, `customerPartnerBalances`, `customerBalanceEntries`, `assetPauses`, `setAssetPause`, `partnerStops`,
//! `setPartnerStop`, `partnerRefusals`), each checked as the TypeScript checks it.
//!
//! - `pauses`: the per-asset pause of new borrow and new supply, read and changed (`ops/asset-pause.ts`).
//! - `stops`: the partner stop as the desk reads and changes it, and the refusals counted (`partner/partner-stops.ts`,
//!   `partner-refusals.ts`).
//! - `transfer_reads`: health, the failed list and one transfer (`ops/transfer-*.ts`, `failed-transfers.ts`).
//! - `balances`: a customer's balances and the entries behind one (`ops/customer-balances.ts`), and the spending balances
//!   the partner holding their money reports (`ops/customer-partner-balances.ts`).
//!
//! The held sends, the limit requests and the published terms are slice `transfers`' own functions
//! (`personal::held_for_review`, `release_held`, `reject_held`, `limits::queue`, `decide`, `terms::publish`); this slice
//! is their desk. Every change of an owner value consumes the second person's approval (`ops_approval::consume`) after
//! the form's checks, so a wrong form never spends it.

pub mod balances;
pub mod pauses;
pub mod stops;
pub mod transfer_reads;

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::ops_approval;
use crate::partner::custody::read_freeze;
use crate::partner::refuse;
use crate::partner::router::Wiring as PartnerWiring;
use crate::spaces::space::with;
use crate::transfers::terms::{self, TermsRow};
use crate::transfers::{Deps, Wiring, limits, personal};

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn opt_text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

fn bool_of(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Value::Bool(true))
}

/// A whole number the schema let through, saturating (a revision beyond a safe integer is refused by its check).
fn int_of(v: &Value, key: &str) -> Option<i64> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema held it to a whole number; out of range saturates and is refused"
    )]
    v.get(key).as_number().map(|n| n as i64)
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn f(k: &str, v: impl Into<String>) -> (String, String) {
    (k.to_owned(), v.into())
}

/// `historyLimit is required with historyFor; blank is not 50`.
fn history_limit(input: &Value) -> Result<Option<(&str, i64)>, Refusal> {
    match (opt_text(input, "historyFor"), int_of(input, "historyLimit")) {
        (None, _) => Ok(None),
        (Some(_), None) => Err(refuse(
            "bank.validation_failed",
            "historyLimit is required with historyFor; blank is not 50",
        )),
        (Some(id), Some(limit)) => Ok(Some((id, limit))),
    }
}

fn held_sends(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let limit = int_of(input, "limit").unwrap_or(50);
    let rows = personal::held_for_review(d, limit)?;
    Ok(Json::Array(
        rows.into_iter()
            .map(|(view, from, to)| {
                let mut fields = view.fields();
                fields.push(("fromUserId".to_owned(), Json::str(from)));
                fields.push(("toUserId".to_owned(), Json::str(to)));
                Json::Object(fields)
            })
            .collect(),
    ))
}

fn publish_transfer_terms(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let per = amount(text(input, "perTransferLimit"))?;
    let daily = amount(text(input, "dailyLimit"))?;
    let fee = amount(text(input, "fee"))?;
    // Checked before the approval is consumed, so a wrong form does not spend the second person.
    terms::assert_transfer_terms(per, daily)?;
    let asset = text(input, "assetId");
    let approved = ops_approval::consume(
        d.w.approvals.as_ref(),
        input,
        "bank.ops.publishTransferTerms",
        &terms::publish_fields(asset, per, daily, fee),
    )?;
    let published = with(d.store, |c| {
        terms::publish(
            c,
            service_kit::money::js_trim(asset),
            TermsRow {
                per_transfer_limit: per,
                daily_limit: daily,
                fee,
            },
        )
    })?;
    let mut out = published.fields();
    out.push(("approvedBy".to_owned(), Json::str(approved.approver_id)));
    Ok(Json::Object(out))
}

fn decide_limit_request(d: &Deps<'_>, user: &str, input: &Value) -> Result<Json, Refusal> {
    let granted = opt_text(input, "granted").map(amount).transpose()?;
    let decision = limits::Decision {
        request_id: text(input, "requestId"),
        approve: text(input, "decision") == "approve",
        granted,
        note: text(input, "note"),
        decider_id: user,
    };
    // The decision's own checks come before any read, as the TypeScript makes them.
    limits::check_decision(&decision)?;
    let (r, replayed) = with(d.store, |c| limits::decide(c, &decision))?;
    Ok(r.json_replayed(replayed))
}

fn asset_pauses(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let history = history_limit(input)?;
    let assets = with(d.store, pauses::list)?;
    let history = match history {
        Some((asset, limit)) => with(d.store, |c| pauses::history_of(c, asset, limit))?,
        None => Vec::new(),
    };
    let k = |k: &str, v: Json| (k.to_owned(), v);
    Ok(Json::Object(vec![
        k(
            "owners",
            Json::Object(vec![
                k("assetPause", Json::str("svc-bank")),
                k("postingFreeze", Json::str("svc-ledger")),
                k("accountFreeze", Json::str("svc-identity")),
            ]),
        ),
        k(
            "assets",
            Json::Array(assets.iter().map(pauses::PauseState::json).collect()),
        ),
        k(
            "history",
            Json::Array(history.iter().map(pauses::HistoryRow::json).collect()),
        ),
    ]))
}

fn set_asset_pause(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let change = pauses::Change {
        asset_id: text(input, "assetId"),
        borrow_paused: bool_of(input, "borrowPaused"),
        supply_paused: bool_of(input, "supplyPaused"),
        expected_revision: int_of(input, "expectedRevision").unwrap_or(-1),
        reason: text(input, "reason"),
    };
    let fields = [
        f("assetId", change.asset_id),
        f("borrowPaused", change.borrow_paused.to_string()),
        f("supplyPaused", change.supply_paused.to_string()),
        f("revision", (change.expected_revision + 1).to_string()),
    ];
    let (state, replayed) = pauses::set(d.store, &change, || {
        ops_approval::consume(
            d.w.approvals.as_ref(),
            input,
            "bank.ops.setAssetPause",
            &fields,
        )
        .map(|a| a.approver_id)
    })?;
    Ok(state.json_replayed(replayed))
}

fn partner_stops(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let history = history_limit(input)?;
    let partners = with(d.store, stops::list)?;
    let history = match history {
        Some((partner, limit)) => with(d.store, |c| stops::history_of(c, partner, limit))?,
        None => Vec::new(),
    };
    Ok(Json::Object(vec![
        (
            "kinds".to_owned(),
            Json::Array(stops::KINDS.iter().map(|k| Json::str(*k)).collect()),
        ),
        (
            "partners".to_owned(),
            Json::Array(partners.iter().map(stops::StopState::json).collect()),
        ),
        (
            "history".to_owned(),
            Json::Array(history.iter().map(stops::HistoryRow::json).collect()),
        ),
    ]))
}

fn set_partner_stop(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let kinds: Vec<String> = input
        .get("stoppedKinds")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(|k| k.as_str().map(str::to_owned))
        .collect();
    let change = stops::Change {
        partner_id: text(input, "partnerId"),
        stopped_kinds: &kinds,
        expected_revision: int_of(input, "expectedRevision").unwrap_or(-1),
        reason: text(input, "reason"),
    };
    let fields = [
        f("partnerId", change.partner_id),
        f("stoppedKinds", stops::normal_kinds(&kinds).join(",")),
        f("revision", (change.expected_revision + 1).to_string()),
    ];
    let (state, replayed) = stops::set(d.store, &change, || {
        ops_approval::consume(
            d.w.approvals.as_ref(),
            input,
            "bank.ops.setPartnerStop",
            &fields,
        )
        .map(|a| a.approver_id)
    })?;
    Ok(state.json_replayed(replayed))
}

fn partner_refusals(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let reading = read_freeze(d.partner.freeze.as_ref());
    let days = i32::try_from(int_of(input, "days").unwrap_or(0)).unwrap_or(0);
    let partners = with(d.store, stops::list)?;
    let (first_day, counts) = with(d.store, |c| stops::recent_refusals(c, days))?;
    let k = |k: &str, v: Json| (k.to_owned(), v);
    Ok(Json::Object(vec![
        k(
            "freeze",
            Json::Object(vec![
                k("postingEnabled", Json::Bool(reading.posting_enabled)),
                k("cause", reading.cause.map_or(Json::Null, Json::str)),
                k("owner", Json::str("svc-ledger")),
            ]),
        ),
        k(
            "stops",
            Json::Array(
                partners
                    .iter()
                    .map(|s| {
                        Json::Object(vec![
                            k("partnerId", Json::str(s.partner_id.clone())),
                            k(
                                "stoppedKinds",
                                Json::Array(
                                    s.stopped_kinds
                                        .iter()
                                        .map(|x| Json::str(x.clone()))
                                        .collect(),
                                ),
                            ),
                            k("revision", Json::int(s.revision)),
                        ])
                    })
                    .collect(),
            ),
        ),
        k("firstDay", first_day.map_or(Json::Null, Json::str)),
        k(
            "counts",
            Json::Array(
                counts
                    .into_iter()
                    .map(|c| {
                        Json::Object(vec![
                            k("day", Json::str(c.day)),
                            k("refusedBy", Json::str(c.refused_by)),
                            k("cause", Json::str(c.cause)),
                            k("kind", Json::str(c.kind)),
                            k("count", Json::str(c.count)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
fn call(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    Some(match ctx.call.path {
        "ops.heldSends" => held_sends(d, input),
        "ops.releaseHeldSend" => (|| {
            let transfer_id = text(input, "transferId");
            let approved = ops_approval::consume(
                d.w.approvals.as_ref(),
                input,
                "bank.release_held_send",
                &[f("transferId", transfer_id)],
            )?;
            personal::release_held(d, transfer_id, &approved.approver_id).map(|v| v.json())
        })(),
        "ops.rejectHeldSend" => {
            personal::reject_held(d, text(input, "transferId"), user).map(|v| v.json())
        }
        "ops.limitRequests" => (|| {
            // The page size refuses before any read, as `queue` does.
            let limit = int_of(input, "limit").ok_or_else(limits::list_limit_unset)?;
            let rows = with(d.store, |c| limits::queue(c, Some(limit)))?;
            Ok(Json::Array(
                rows.iter()
                    .map(limits::LimitRequest::json_with_user)
                    .collect(),
            ))
        })(),
        "ops.decideLimitRequest" => decide_limit_request(d, user, input),
        "ops.publishTransferTerms" => publish_transfer_terms(d, input),
        "ops.transferHealth" => transfer_reads::window_hours(
            input.get("windowHours").as_number(),
            "bank.transfer_health_window_unset",
            "Transfer health",
        )
        .and_then(|hours| with(d.store, |c| transfer_reads::health(c, hours, d.now))),
        "ops.failedTransfers" => (|| {
            let hours = transfer_reads::window_hours(
                input.get("windowHours").as_number(),
                "bank.failed_transfers_window_unset",
                "Failed transfers",
            )?;
            let limit = transfer_reads::failed_limit(input.get("limit").as_number())?;
            with(d.store, |c| {
                transfer_reads::failed(
                    c,
                    d.w.handles.as_deref(),
                    hours,
                    limit,
                    opt_text(input, "cursor"),
                    d.now,
                )
            })
        })(),
        "ops.transferDetail" => {
            let id = text(input, "id");
            transfer_reads::detail_audit(user, id)
                .and_then(|()| with(d.store, |c| transfer_reads::detail(c, id)))
        }
        "ops.customerBalances" => {
            let owner = text(input, "userId");
            balances::audit(user, owner, "breakdown")
                .and_then(|()| balances::breakdown(d.store, d.ledger, &d.money(), owner))
        }
        "ops.customerPartnerBalances" => {
            let owner = text(input, "userId");
            balances::partner_audit(user, owner)
                .and_then(|()| balances::partner_held(d.store, &d.money(), owner))
        }
        "ops.customerBalanceEntries" => {
            let owner = text(input, "userId");
            balances::audit(user, owner, "entries").and_then(|()| {
                balances::entries(
                    d.store,
                    d.ledger,
                    &d.money(),
                    owner,
                    text(input, "assetId"),
                    opt_text(input, "cursor"),
                    int_of(input, "limit"),
                )
            })
        }
        "ops.assetPauses" => asset_pauses(d, input),
        "ops.setAssetPause" => set_asset_pause(d, input),
        "ops.partnerStops" => partner_stops(d, input),
        "ops.setPartnerStop" => set_partner_stop(d, input),
        "ops.partnerRefusals" => partner_refusals(d, input),
        _ => return None,
    })
}

/// The slice's answer at the door; `None` for a path outside it.
pub fn answer(
    w: &Wiring,
    spaces: &crate::spaces::Wiring,
    partner: &PartnerWiring,
    store: &Store,
    ctx: &Ctx<'_>,
) -> Option<Result<Option<Json>, TrpcError>> {
    let custody = partner.custody(store);
    let d = Deps {
        store,
        ledger: spaces.ledger.as_ref(),
        custody: &custody,
        partner,
        spaces,
        w,
        now: ctx.now,
    };
    let out = call(&d, ctx)?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
