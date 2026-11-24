//! The advisors slice's nine calls. The door has already checked the caller, the scope, the region, the Coach run's
//! three checks and the input; each handler here runs as `router.ts` (and `coach/router.ts`) runs it. `coach.runSession`
//! and `portfolio.plan` run inside the router's `guard`; the others answer a thrown error as tRPC does, a 500 with its
//! words.

use service_kit::access::Jurisdiction;
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::Advisors;
use super::coach_run::{CoachAsk, PgRunStore, run_coach_answer};
use super::drafts::{
    GrowthAsk, InstallAsk, LaunchAsk, ScreeningAsk, draft_screening, growth_propose, launch_assess,
    marketplace_install, refuse_kyc_review,
};
use super::grounding::{SessionAsk, policy, rule, session_output};
use super::portfolio::{Plan, Target, plan_rebalance, read_own_holdings, result_json};
use crate::db::Store;
use crate::door::Ctx;
use crate::gateway::desk::GatewaySlice;
use crate::metering::Metering;
use crate::runtime::{Rt, RunError, Runtime, to_trpc};

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).as_str()
}

fn flag(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Value::Bool(true))
}

fn strings<'a>(v: &'a Value, key: &str) -> Vec<&'a str> {
    v.get(key)
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// A thrown `Error` outside the guard: tRPC's 500 with the error's words.
fn thrown(message: String) -> TrpcError {
    TrpcError::plain("INTERNAL_SERVER_ERROR", message)
}

/// What the slice reads besides the call.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub gateway: &'a GatewaySlice,
    pub m: &'a Metering,
    pub rt: &'a Runtime,
    pub advisors: &'a Advisors,
    pub jurisdiction: &'a Jurisdiction,
}

/// Answers one call of the slice.
pub fn handle(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Option<Json>, TrpcError> {
    let input = &ctx.input;
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let a = d.advisors;
    let answer = match ctx.call.path {
        "coach.policy" => policy(),
        "coach.session" => {
            let grounding = a.curriculum.load().map_err(thrown)?;
            session_output(&rule(
                &grounding,
                &SessionAsk {
                    ask: text(input, "ask"),
                    requested_slug: text(input, "requestedSlug"),
                    include_positions: flag(input, "includePositions"),
                    as_advice: flag(input, "asAdvice"),
                },
            ))
        }
        "coach.runSession" => coach_run(ctx, d, user).map_err(to_trpc)?,
        "launch.assess" => launch_assess(&LaunchAsk {
            deployer: text(input, "deployer"),
            as_badge: flag(input, "asBadge"),
            as_block_decision: flag(input, "asBlockDecision"),
            reputation: None,
        }),
        "riskCompliance.draftScreening" => draft_screening(
            &ScreeningAsk {
                subject_id: text(input, "subjectId"),
                region: text(input, "region"),
                as_decision: flag(input, "asDecision"),
                write_reviewed_by: flag(input, "writeReviewedBy"),
            },
            &d.jurisdiction.screening(),
            Jurisdiction::shipped_business_regions(),
        ),
        "riskCompliance.refuseKycReview" => refuse_kyc_review(),
        "growth.propose" => growth_propose(
            &GrowthAsk {
                headline: text(input, "headline"),
                copy: text(input, "copy"),
                publish: flag(input, "publish"),
                incentive_budget: text(input, "incentiveBudget"),
                spend_amount: text(input, "spendAmount"),
            },
            a.warehouse,
        ),
        "portfolio.plan" => portfolio_plan(input, a, user).map_err(to_trpc)?,
        "marketplace.install" => marketplace_install(&InstallAsk {
            package_id: text(input, "packageId").unwrap_or_default(),
            version: text(input, "version").unwrap_or_default(),
            publisher: text(input, "publisher").unwrap_or_default(),
            claimed_tools: strings(input, "claimedTools"),
            claimed_scopes: strings(input, "claimedScopes"),
        })
        .map_err(thrown)?,
        other => {
            return Err(thrown(format!(
                "svc-agents in Rust: {other} is not an advisors call"
            )));
        }
    };
    Ok(Some(answer))
}

/// `coach.runSession`, inside the guard.
fn coach_run(ctx: &Ctx<'_>, d: &Deps<'_>, user: &str) -> Result<Json, RunError> {
    let pool = d.store.pool()?;
    let x = Rt {
        rt: d.rt,
        pool,
        gateway: &d.gateway.gateway,
        m: d.m,
        now: ctx.now,
    };
    let grounding = d.advisors.curriculum.load().map_err(RunError::Other)?;
    let input = &ctx.input;
    let result = run_coach_answer(
        &x,
        &PgRunStore(pool),
        &grounding,
        &CoachAsk {
            user_id: user,
            request_id: text(input, "requestId").unwrap_or_default(),
            question: text(input, "question").unwrap_or_default(),
            lesson_slug: text(input, "lessonSlug").filter(|s| !s.is_empty()),
        },
        ctx.now,
    )?;
    Ok(result.to_json())
}

/// `portfolio.plan`, inside the guard: with balances and prices wired the holdings are read first, then planned.
fn portfolio_plan(input: &Value, a: &Advisors, user: &str) -> Result<Json, RunError> {
    let raw = input.get("targets").as_array();
    let targets: Option<Vec<Target<'_>>> = raw.map(|items| {
        items
            .iter()
            .map(|t| Target {
                asset: t.get("asset").as_str().unwrap_or_default(),
                plane: t.get("plane").as_str().unwrap_or_default(),
                weight: t.get("weight").as_str().unwrap_or_default(),
            })
            .collect()
    });
    let Some((ledger, prices)) = &a.holdings else {
        let plan = plan_rebalance(a.portfolio_killed, None, targets.as_deref());
        return Ok(result_json(user, &plan, None));
    };
    let holdings =
        match read_own_holdings(ledger.as_ref(), prices.as_ref(), user).map_err(RunError::Other)? {
            Ok(h) => h,
            Err(asset) => {
                return Ok(result_json(
                    user,
                    &Plan::Refused("portfolio.price_unset"),
                    Some(&asset),
                ));
            }
        };
    let plan = plan_rebalance(a.portfolio_killed, Some(&holdings), targets.as_deref());
    Ok(result_json(user, &plan, None))
}
