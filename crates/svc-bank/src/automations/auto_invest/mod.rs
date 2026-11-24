//! Part `auto_invest` of the automations slice: threshold sweeps, card round-ups and DCA (`router/auto-invest.router.ts`,
//! `auto-invest/`), `ops.runAutoInvest` (`router/ops.router.ts`) and the job door `POST /internal/jobs/run-auto-invest`
//! (`index.ts`).
//!
//! - `service`: the rules, the runner and the capture hook (`apply_round_up`, which slice `card-ops`' capture calls).
//! - `convert`: the convert counterparty a DCA needs, and svc-trade's (`TRADE_URL`, signed as svc-bank).
//!
//! The runner and the hook share one kill switch (`AUTO_INVEST_ENABLED`), so neither door is a way past the stop.

pub mod convert;
pub mod service;

use service_kit::json::Json;
use service_kit::money::parse_amount;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::js_date;

use super::Deps;
use crate::door::Ctx;
use crate::door::jobs::{body_limit, job_failed, ok};
use crate::errors::Refusal;
use crate::partner::refuse;

pub use service::{Capture, RoundUpOutcome, apply_round_up};

/// What the binary hands this part (`index.ts`'s `autoInvest` options and the router's flags).
pub struct Wiring {
    /// `AUTO_INVEST_ENABLED`: on unless the owner turns it off (`env.ts`'s default).
    pub enabled: bool,
    /// svc-trade's convert port when `TRADE_URL` is usable; none refuses every DCA `bank.auto_invest_rate_unset`.
    pub convert: Option<Box<dyn convert::ConvertPort>>,
    /// The service's own batch (`options.batchSize`); `index.ts` passes none, so a pass without a limit refuses.
    pub batch_size: Option<f64>,
}

impl Wiring {
    /// The router's defaults: on, no convert counterparty, no batch.
    pub fn none() -> Wiring {
        Wiring {
            enabled: true,
            convert: None,
            batch_size: None,
        }
    }
}

const JOB: &str = "/internal/jobs/run-auto-invest";

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn amount(v: &Value, key: &str) -> Result<service_kit::money::Amount, Refusal> {
    parse_amount(text(v, key)).map_err(Refusal::Other)
}

/// The caller's own rule, or `bank.not_owner`.
fn own_rule(d: &Deps<'_>, user: &str, rule_id: &str) -> Result<service::Rule, Refusal> {
    let rule = service::get(d, rule_id)?;
    if rule.user_id != user {
        return Err(refuse("bank.not_owner", "Not your auto-invest rule"));
    }
    Ok(rule)
}

fn disabled() -> Refusal {
    refuse(service::DISABLED, "auto-invest is disabled")
}

/// This part's calls; `None` for any other call.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let path = ctx.call.path;
    Some(match path {
        "autoInvest.policy" => Ok(service::policy(&d.w.auto_invest)),
        "autoInvest.list" => {
            let space = input.get("targetSpaceId").as_str();
            service::list(d, user, input.get("limit").as_number(), space)
                .map(|rules| Json::Array(rules.iter().map(service::Rule::json).collect()))
        }
        "autoInvest.createThresholdSweep" => (|| {
            let threshold = amount(input, "threshold")?;
            service::create_threshold_sweep(
                d,
                user,
                text(input, "assetId"),
                threshold,
                text(input, "targetPoolId"),
            )
            .map(|r| r.json())
        })(),
        "autoInvest.createRoundUp" => (|| {
            let space = input
                .get("targetSpaceId")
                .as_str()
                .filter(|s| !s.is_empty());
            // A round-up into a pot is a pot feature: refused before anything is written where the partner offers none.
            if space.is_some() {
                crate::spaces::router::offers(d.t.partner, user, "pots")?;
            }
            let granularity = amount(input, "granularity")?;
            service::create_round_up(
                d,
                &service::RoundUpAsk {
                    user_id: user,
                    asset_id: text(input, "assetId"),
                    granularity,
                    target_pool_id: input.get("targetPoolId").as_str().filter(|s| !s.is_empty()),
                    target_space_id: space,
                    buy_asset_id: input.get("buyAssetId").as_str().filter(|s| !s.is_empty()),
                },
            )
            .map(|r| r.json())
        })(),
        "autoInvest.createDca" => (|| {
            let spend = amount(input, "amount")?;
            let starts_at = js_date(text(input, "startsAt"))
                .ok_or_else(|| Refusal::Other("startsAt is no date".to_owned()))?;
            service::create_dca(
                d,
                &service::DcaAsk {
                    user_id: user,
                    spend_asset_id: text(input, "spendAssetId"),
                    buy_asset_id: text(input, "buyAssetId"),
                    amount: spend,
                    cadence: text(input, "cadence"),
                    starts_at,
                },
            )
            .map(|r| r.json())
        })(),
        "autoInvest.cancel" => (|| {
            let rule = own_rule(d, user, text(input, "ruleId"))?;
            service::cancel(d, &rule.id)?;
            Ok(Json::obj([("ok", Json::Bool(true))]))
        })(),
        "autoInvest.pause" => own_rule(d, user, text(input, "ruleId"))
            .and_then(|r| service::pause(d, &r.id))
            .map(|r| r.json()),
        "autoInvest.resume" => own_rule(d, user, text(input, "ruleId"))
            .and_then(|r| service::resume(d, &r.id))
            .map(|r| r.json()),
        "ops.runAutoInvest" => {
            if !d.w.auto_invest.enabled {
                return Some(Err(disabled()));
            }
            service::run_due(d, d.now(), input.get("limit").as_number()).map(|r| r.json())
        }
        _ => return None,
    })
}

/// `POST /internal/jobs/run-auto-invest` past the signature: 503 `bank.auto_invest_disabled` when stopped (the same
/// code as `ops.runAutoInvest`), then the body's batch (blank refuses, never 200) and one pass.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    if path != JOB {
        return None;
    }
    if !d.w.auto_invest.enabled {
        return Some(Response {
            status: 503,
            body: Json::obj([
                ("error", Json::str("auto-invest is disabled")),
                ("code", Json::str(service::DISABLED)),
            ])
            .compact(),
        });
    }
    Some(
        match service::batch_limit(body_limit(body)).and_then(|limit| {
            #[allow(clippy::cast_precision_loss, reason = "a batch of at most 10000")]
            let l = limit as f64;
            service::run_due(d, d.now(), Some(l))
        }) {
            Ok(report) => ok(&report.json()),
            Err(r) => job_failed(r),
        },
    )
}
