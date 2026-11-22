//! The slice's calls (`router/earn.router.ts`; the earn calls of `router/ops.router.ts`; `ops/earn-pools.ts`;
//! `ops/pool-totals.ts`) and its two job doors (`index.ts`: `/internal/jobs/accrue-interest`, `resume-pending-earn`),
//! each checked as the TypeScript checks it.
//!
//! The operator's pool calls consume an identity-issued approval bound to every term (`consumeBankOpsApproval`,
//! founder-audience), and only after the terms pass the checks, so a wrong form never spends the second person.

use service_kit::approvals::{ConsumeError, ConsumeInput, founder_verdict};
use service_kit::json::Json;
use service_kit::money::{format_amount, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use super::interest::{DAYS_PER_YEAR, accrual_boundary, accrual_date};
use super::service::{self, Approved, DepositAsk, NewPool};
use super::{Deps, Position, rates};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::with;
use crate::transfers::schedules::assert_self;
use crate::transfers::step_up::payload_hash;

const UNWIRED: &str = "IDENTITY_URL is unpublished; bank ops do not invent a second person";

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn opt_text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

fn bool_of(v: &Value, key: &str) -> Option<bool> {
    match v.get(key) {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

fn int_of(v: &Value, key: &str) -> Option<i64> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema held it to a whole number"
    )]
    v.get(key).as_number().map(|n| n as i64)
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn amount_of(s: &str) -> Result<service_kit::money::Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn time_of(s: &str) -> Result<Instant, Refusal> {
    js_date(s).ok_or_else(|| Refusal::Other(format!("{s} is no date")))
}

/// `ActionApprovalConsumeError`: the guard's 412 with the error's own words, its code as the cause.
fn approval_refused(message: impl Into<String>, code: &str) -> Refusal {
    Refusal::Trpc(TrpcError::caused(
        "PRECONDITION_FAILED",
        message.into(),
        code.to_owned(),
    ))
}

/// `consumeBankOpsApprovalPair`: the approval and operation ids are required; identity consumes the approval bound to
/// the action and its fields; the founder pair is attested; the approver is named.
pub fn consume_ops(
    d: &Deps<'_>,
    input: &Value,
    action: &str,
    fields: &[(String, String)],
) -> Result<Approved, Refusal> {
    consume_approval(d.approvals, input, action, fields)
}

/// [`consume_ops`] on any slice's approvals port.
pub fn consume_approval(
    approvals: &dyn crate::transfers::Approvals,
    input: &Value,
    action: &str,
    fields: &[(String, String)],
) -> Result<Approved, Refusal> {
    let approval_id = js_trim(opt_text(input, "approvalId").unwrap_or_default());
    let operation_id = js_trim(opt_text(input, "operationId").unwrap_or_default());
    if approval_id.is_empty() || operation_id.is_empty() {
        return Err(approval_refused(
            "approvalId and operationId are required; a typed-in second name is not approval",
            "action_approval.missing",
        ));
    }
    let hash = payload_hash(action, fields);
    let consumed = approvals
        .consume(
            &ConsumeInput {
                approval_id,
                operation_id,
                payload_hash: &hash,
                target_service: "svc-bank",
                target_id: action,
                expected_version: "1",
                replay: None,
            },
            None,
        )
        .map(|(c, _)| c)
        .map_err(|e| match e {
            ConsumeError::Refused(m) if m == UNWIRED => {
                approval_refused(m, "action_approval.identity_unwired")
            }
            ConsumeError::Refused(m) => approval_refused(m, "action_approval.consume_failed"),
            ConsumeError::Thrown(m) => Refusal::Other(m),
        })?;
    match founder_verdict(&consumed, action, "svc-bank", action) {
        None => {}
        Some("missing") => {
            return Err(approval_refused(
                "a founder-audience action needs identity to attest that the proposer and the approver are both founders",
                "action_approval.not_founders",
            ));
        }
        Some(_) => {
            return Err(approval_refused(
                "the founder attestation does not match a distinct founder pair for this action",
                "action_approval.not_founders",
            ));
        }
    }
    let Some(approver_id) = consumed.approver_id.filter(|a| !a.is_empty()) else {
        return Err(approval_refused(
            "consumed approval has no approver; a typed-in name is not approval",
            "action_approval.consume_failed",
        ));
    };
    Ok(Approved {
        approval_id: approval_id.to_owned(),
        requester_id: consumed.requester_id,
        approver_id,
    })
}

pub fn f(k: &str, v: impl Into<String>) -> (String, String) {
    (k.to_owned(), v.into())
}

/// `earn.positions`' row.
fn position_row(p: &Position, at_open: Option<i64>, s: &service::Standing) -> Json {
    let k = |k: &str, v: Json| (k.to_owned(), v);
    Json::Object(vec![
        k("id", Json::str(p.id.clone())),
        k("poolId", Json::str(p.pool_id.clone())),
        k("assetId", Json::str(p.asset_id.clone())),
        k("principal", Json::str(format_amount(p.principal))),
        k("openedAt", Json::str(p.opened_at.iso())),
        k("maturesAt", iso(p.matures_at)),
        k("rateAtOpenBps", at_open.map_or(Json::Null, Json::int)),
        k("accruesFrom", Json::str(s.accrues_from.iso())),
        k("accrual", Json::str(s.accrual)),
        k("autoRenew", Json::Bool(p.auto_renew)),
        k("renewals", Json::int(s.renewals)),
        k(
            "nextPayoutOn",
            s.next_payout_on.clone().map_or(Json::Null, Json::str),
        ),
        k("staking", s.staking.map_or(Json::Null, Json::str)),
        k("unbondingStartedAt", iso(p.unbonding_started_at)),
        k("unbondsAt", iso(p.unbonds_at)),
        k(
            "unbondingDays",
            s.unbonding_days.map_or(Json::Null, Json::int),
        ),
    ])
}

fn customer(d: &Deps<'_>, user: &str, path: &str, input: &Value) -> Option<Result<Json, Refusal>> {
    let now = d.now;
    Some(match path {
        "earn.pools" => service::pools_list_limit(input.get("limit").as_number()).and_then(|_| {
            with(d.store, |c| {
                let pools = service::list_pools(
                    c,
                    opt_text(input, "assetId"),
                    input.get("limit").as_number(),
                )?;
                Ok(Json::Array(
                    pools.iter().map(|p| Json::Object(p.view())).collect(),
                ))
            })
        }),
        "earn.pool" => with(d.store, |c| {
            let p = service::pool(c, text(input, "poolId"))?;
            let mut view = p.view();
            view.push(("status".to_owned(), Json::str(p.status.clone())));
            view.push(("statusRevision".to_owned(), Json::int(p.status_revision)));
            Ok(Json::Object(view))
        }),
        "earn.riskDisclosure" => service::risk_disclosure(d.settings.risk_wording.as_deref()),
        "earn.rateHistory" => (|| {
            rates::list_limit(input.get("limit").as_number())?;
            let before = opt_text(input, "before").map(time_of).transpose()?;
            let h = with(d.store, |c| {
                rates::read(
                    c,
                    text(input, "poolId"),
                    input.get("limit").as_number(),
                    before,
                )
            })?;
            Ok(h.json())
        })(),
        "earn.deposit" => (|| {
            let amount = amount_of(text(input, "amount"))?;
            let p = service::deposit(
                d,
                &DepositAsk {
                    pool_id: text(input, "poolId"),
                    user_id: user,
                    amount,
                    position_id: text(input, "positionId"),
                },
            )?;
            Ok(Json::obj([
                ("positionId", Json::str(p.id.clone())),
                ("maturesAt", iso(p.matures_at)),
            ]))
        })(),
        "earn.withdraw" => (|| {
            let id = text(input, "positionId");
            let existing = with(d.store, |c| service::position(c, id))?;
            assert_self(user, &existing.user_id)?;
            let after = service::withdraw(d, id, now, bool_of(input, "unbond") == Some(true))?;
            Ok(Json::obj([
                ("positionId", Json::str(after.id.clone())),
                ("principal", Json::str(format_amount(after.principal))),
                (
                    "status",
                    Json::str(if after.status == "closed" {
                        "closed"
                    } else {
                        "unbonding"
                    }),
                ),
                ("unbondsAt", iso(after.unbonds_at)),
            ]))
        })(),
        "earn.setAutoRenew" => (|| {
            let id = text(input, "positionId");
            let existing = with(d.store, |c| service::position(c, id))?;
            assert_self(user, &existing.user_id)?;
            let p = service::set_auto_renew(d, id, bool_of(input, "on") == Some(true), now)?;
            Ok(Json::obj([
                ("positionId", Json::str(p.id.clone())),
                ("autoRenew", Json::Bool(p.auto_renew)),
                ("maturesAt", iso(p.matures_at)),
            ]))
        })(),
        "earn.positions" => {
            service::positions_list_limit(input.get("limit").as_number()).and_then(|_| {
                with(d.store, |c| {
                    let limit = input.get("limit").as_number();
                    let positions = match opt_text(input, "poolId") {
                        Some(pool) if !pool.is_empty() => {
                            service::positions_in_pool(c, user, pool, limit)?
                        }
                        _ => service::positions_of(c, user, limit)?,
                    };
                    let at_open = service::rates_at_open(c, &positions)?;
                    let states = service::accrual_states(c, &positions, now)?;
                    positions
                        .iter()
                        .map(|p| {
                            let s = states.get(&p.id).ok_or_else(|| {
                                Refusal::Other(format!("no standing for {}", p.id))
                            })?;
                            Ok(position_row(p, at_open.get(&p.id).copied().flatten(), s))
                        })
                        .collect::<Result<Vec<_>, _>>()
                        .map(Json::Array)
                })
            })
        }
        "earn.interestHistory" => service::interest_list_limit(input.get("limit").as_number())
            .and_then(|_| {
                with(d.store, |c| {
                    service::interest_history(
                        c,
                        user,
                        text(input, "poolId"),
                        input.get("limit").as_number(),
                        opt_text(input, "before"),
                    )
                })
            }),
        _ => return None,
    })
}

/// `createEarnPoolFields`: the fields the approval is bound to, in canonical form.
fn create_fields(input: &Value) -> Result<Vec<(String, String)>, Refusal> {
    let mut fields = vec![
        f("poolId", text(input, "poolId")),
        f("assetId", js_trim(text(input, "assetId"))),
        f("kind", text(input, "kind")),
        f("name", js_trim(text(input, "name"))),
        f(
            "aprBps",
            int_of(input, "aprBps").unwrap_or_default().to_string(),
        ),
        f(
            "termDays",
            int_of(input, "termDays")
                .map(|t| t.to_string())
                .unwrap_or_default(),
        ),
        f(
            "minDeposit",
            format_amount(amount_of(text(input, "minDeposit"))?),
        ),
    ];
    // Only a pool that unbonds names it, so the fields of every other pool hash as they always did.
    if let Some(u) = int_of(input, "unbondingDays") {
        fields.push(f("unbondingDays", u.to_string()));
    }
    Ok(fields)
}

fn terms_invalid(message: &str) -> Refusal {
    refuse("bank.pool_terms_invalid", message)
}

fn ops(d: &Deps<'_>, path: &str, input: &Value) -> Option<Result<Json, Refusal>> {
    Some(match path {
        "ops.poolTotals" => service::pool_totals(d),
        "ops.createEarnPool" => (|| {
            let kind = text(input, "kind");
            let term = int_of(input, "termDays");
            let unbonding = int_of(input, "unbondingDays");
            // Checked before the approval is consumed, so a wrong form does not spend the second person.
            if kind == "fixed" && term.is_none() {
                return Err(terms_invalid("A fixed-term pool needs its term in days"));
            }
            if kind == "flexible" && term.is_some() {
                return Err(terms_invalid("A flexible pool has no term"));
            }
            if kind == "fixed" && unbonding.is_some() {
                return Err(terms_invalid(
                    "Only a flexible pool unbonds: a fixed term already has its own lock",
                ));
            }
            let fields = create_fields(input)?;
            let approved = consume_ops(d, input, "bank.ops.createEarnPool", &fields)?;
            let p = service::create_pool(
                d,
                &NewPool {
                    id: text(input, "poolId").to_owned(),
                    asset_id: js_trim(text(input, "assetId")).to_owned(),
                    kind: kind.to_owned(),
                    name: js_trim(text(input, "name")).to_owned(),
                    apr_bps: int_of(input, "aprBps").unwrap_or_default(),
                    term_days: term,
                    min_deposit: amount_of(text(input, "minDeposit"))?,
                    unbonding_days: unbonding,
                },
            )?;
            Ok(Json::obj([
                ("poolId", Json::str(p.id.clone())),
                ("kind", Json::str(p.kind.clone())),
                ("aprBps", Json::int(p.apr_bps)),
                ("termDays", p.term_days.map_or(Json::Null, Json::int)),
                ("minDeposit", Json::str(format_amount(p.min_deposit))),
                ("status", Json::str(p.status.clone())),
                (
                    "unbondingDays",
                    p.unbonding_days.map_or(Json::Null, Json::int),
                ),
                ("approvedBy", Json::str(approved.approver_id)),
            ]))
        })(),
        "ops.setEarnPoolRate" => (|| {
            let pool_id = text(input, "poolId");
            let rate = int_of(input, "rateBps").unwrap_or_default();
            // The pool must exist and be flexible before the second person is spent.
            let p = with(d.store, |c| service::pool(c, pool_id))?;
            if p.kind == "fixed" {
                return Err(rates::fixed_rate_locked());
            }
            if p.apr_bps == rate {
                return Err(rates::rate_unchanged(rate));
            }
            let reason = js_trim(text(input, "reason")).to_owned();
            let fields = vec![
                f("poolId", pool_id),
                f("rateBps", rate.to_string()),
                f("reason", reason.clone()),
            ];
            let approved = consume_ops(d, input, "bank.ops.setEarnPoolRate", &fields)?;
            let approval_id = opt_text(input, "approvalId").unwrap_or_default();
            let set = crate::spaces::space::in_tx(d.store, |tx| {
                rates::set_pool_rate(tx, pool_id, rate, &reason, approval_id, None)
            })?;
            Ok(Json::obj([
                ("poolId", Json::str(set.pool_id)),
                ("rateBps", Json::int(set.rate_bps)),
                ("previousBps", Json::int(set.previous_bps)),
                ("effectiveAt", Json::str(set.effective_at.iso())),
                ("approvedBy", Json::str(approved.approver_id)),
            ]))
        })(),
        "ops.setEarnPoolStatus" => (|| {
            let pool_id = text(input, "poolId");
            let status = text(input, "status");
            let reason = js_trim(text(input, "reason")).to_owned();
            let revision = int_of(input, "revision").unwrap_or_default();
            let fields = vec![
                f("poolId", pool_id),
                f("status", status),
                f("reason", reason.clone()),
                f("revision", revision.to_string()),
            ];
            let change = service::set_pool_status(d, pool_id, status, &reason, revision, &|| {
                consume_ops(d, input, "bank.ops.setEarnPoolStatus", &fields)
            })?;
            Ok(Json::obj([
                ("poolId", Json::str(change.pool_id)),
                ("status", Json::str(change.status)),
                ("previousStatus", Json::str(change.previous_status)),
                ("revision", Json::int(change.revision)),
                ("approvedBy", Json::str(change.approved_by)),
            ]))
        })(),
        "ops.fundPool" => (|| {
            let pool_id = text(input, "poolId");
            let funding_id = text(input, "fundingId");
            let amount = text(input, "amount");
            let fields = vec![
                f("poolId", pool_id),
                f("fundingId", funding_id),
                f("amount", amount),
            ];
            let approved = consume_ops(d, input, "bank.fund_pool", &fields)?;
            let tx = service::fund_pool(d, pool_id, funding_id, amount_of(amount)?)?;
            Ok(Json::obj([
                ("ledgerTxId", Json::str(tx)),
                ("confirmOperatorId", Json::str(approved.approver_id)),
            ]))
        })(),
        "ops.renewEarnTerms" => (|| {
            let when = opt_text(input, "at").map(time_of).transpose()?;
            let report = service::renew_due(
                d,
                when,
                opt_text(input, "poolId"),
                input.get("limit").as_number(),
            )?;
            Ok(report.json())
        })(),
        "ops.releaseUnbondedEarn" => service::release_unbonded(
            d,
            opt_text(input, "poolId"),
            input.get("limit").as_number(),
            opt_text(input, "after"),
        )
        .map(|r| r.json()),
        "ops.accrueInterest" => (|| {
            // Parity with POST /internal/jobs/accrue-interest.
            if !d.settings.interest_accrual {
                return Err(accrual_disabled());
            }
            let when = match opt_text(input, "at") {
                Some(a) => time_of(a)?,
                None => d.now,
            };
            // A day is paid only once it has begun: paying tomorrow today would consume that day early.
            if accrual_boundary(when).0 > d.now.0 {
                return Err(refuse(
                    "bank.accrual_day_not_begun",
                    format!("the accrual day {} has not begun", accrual_date(when)),
                ));
            }
            // The single-pool path stays loud: the operator targeted that pool.
            if let Some(pool_id) = opt_text(input, "poolId") {
                let r = service::accrue(d, pool_id, when, DAYS_PER_YEAR)?;
                return Ok(Json::obj([
                    ("results", Json::Array(vec![r.json(true)])),
                    ("failures", Json::Array(Vec::new())),
                ]));
            }
            Ok(service::accrue_all(d, when)?.json(true))
        })(),
        "ops.resumePendingEarn" => service::resume_pending(d, input.get("limit").as_number())
            .map(|rows| Json::Array(rows.iter().map(service::Resumed::json).collect())),
        _ => return None,
    })
}

/// `bank.interest_accrual_disabled`.
pub fn accrual_disabled() -> Refusal {
    refuse(
        "bank.interest_accrual_disabled",
        "interest accrual is disabled",
    )
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
pub fn answer(
    d: &Deps<'_>,
    user: &str,
    path: &str,
    input: &Value,
) -> Option<Result<Json, Refusal>> {
    customer(d, user, path, input).or_else(|| ops(d, path, input))
}
