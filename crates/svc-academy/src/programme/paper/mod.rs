//! Paper drills (`paperDrill`, `paperDrillResult`, `paperOpsStatus`; `router.ts` and `academy-service.ts`): may a
//! workbook be drilled against a market trade flags as paper, what a drill came to, and whether ops left drills on.
//!
//! Read-only and stateless: no run, fill, price or balance is stored, nothing is posted, and every answer leaves under
//! the simulated seal and through the real-money ban. Each handler keeps the TypeScript's order: the inbound ban, the
//! ops switch (an `academy.<method>()` call), the paper flag check against trade, the spine lookup, then the loop.

pub mod ban;
pub mod big;
pub mod cert_hook;
pub mod flag;
pub mod ops;
pub mod simulated;
pub mod workbook;

use service_kit::json::Json;
use service_kit::schema::Value;

use crate::curriculum::spine;
use crate::door::Ctx;
use crate::errors::{AcademyError, Refusal};
use crate::ports::PaperFlags;
use crate::programme::method;
use crate::slices::{Answer, not_ported};

use ban::{assert_paper_input_never_claims_live, assert_paper_never_readable_as_real_money};
use simulated::{PublishedFill, assert_sealed_simulated, seal_simulated, value_simulated_drill};
use workbook::{
    DrillRefused, FillIn, PaperMarketRef, drill_progress, is_drill_complete, list_paper_fill_refs,
    remaining_step_ids, replay_paper_drill, start_paper_drill_for_catalog_item,
};

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    match ctx.call.path {
        "paperDrill" => paper_drill(ctx).map(Some),
        "paperDrillResult" => paper_drill_result(ctx).map(Some),
        "paperOpsStatus" => paper_ops_status(ctx).map(Some),
        _ => not_ported(ctx),
    }
}

/// `options.paperMarketFlagPort`: the port the service was built with, or none when it was built without one
/// (`TRADE_URL` unset: `index.ts` and `main.rs` build the trade port only then).
fn flag_port<'a>(ctx: &Ctx<'a>) -> Option<&'a dyn PaperFlags> {
    let port = ctx.ports.paper_flags.as_ref();
    port.wired().then_some(port)
}

/// `market` as the checked input holds it: `null` (the default) or trade's flag.
fn market_of(v: &Value) -> Option<PaperMarketRef> {
    let Value::Object(_) = v else {
        return None;
    };
    Some(PaperMarketRef {
        market_id: v.get("marketId").as_str().unwrap_or_default().to_owned(),
        paper: matches!(v.get("paper"), Value::Bool(true)),
        symbol: v.get("symbol").as_str().unwrap_or_default().to_owned(),
    })
}

/// The checks both drill calls run first, in the router's order; the spine item's kind on success.
fn gate(ctx: &Ctx<'_>, market: Option<&PaperMarketRef>) -> Result<&'static str, Refusal> {
    assert_paper_input_never_claims_live(&ctx.input)?;
    method(ctx)?;
    ops::assert_paper_trading_enabled(ops::enabled_option(ctx.settings))?;
    method(ctx)?;
    flag::assert_caller_cannot_lie_paper_flag(flag_port(ctx), market)?;
    let slug = ctx.input.get("slug").as_str().unwrap_or_default();
    // `getCurriculumItem(slug)?.kind`: the curriculum spine's own lookup.
    spine::get(slug).map(|i| i.kind.as_str()).ok_or_else(|| {
        AcademyError::new(
            format!("Curriculum item \"{slug}\" is not in the day-one spine"),
            "academy.curriculum_not_found",
        )
        .into()
    })
}

/// `{ ok: false, reason, message }`.
fn refused_wire(r: &DrillRefused) -> Json {
    Json::obj([
        ("ok", Json::Bool(false)),
        ("reason", Json::str(r.reason.as_str())),
        ("message", Json::str(r.message.clone())),
    ])
}

/// `{ ok: true, ...seal, <rest> }` from a sealed payload: its seal fields, then `rest`.
fn sealed_wire(sealed: &Json, rest: Vec<(String, Json)>) -> Json {
    let mut fields = vec![("ok".to_owned(), Json::Bool(true))];
    for key in [
        "simulated",
        "venue",
        "realLedger",
        "withdrawable",
        "realMoney",
        "disclaimer",
    ] {
        fields.push((
            key.to_owned(),
            sealed.get(key).cloned().unwrap_or(Json::Null),
        ));
    }
    fields.extend(rest);
    Json::Object(fields)
}

fn fields_of(j: Option<&Json>) -> Vec<(String, Json)> {
    match j {
        Some(Json::Object(f)) => f.clone(),
        _ => Vec::new(),
    }
}

fn int(n: usize) -> Json {
    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
}

/// `paperDrill`: may this catalog item be drilled against this market, and with which steps.
fn paper_drill(ctx: &Ctx<'_>) -> Result<Json, Refusal> {
    let market = market_of(ctx.input.get("market"));
    let kind = gate(ctx, market.as_ref())?;
    let slug = ctx.input.get("slug").as_str().unwrap_or_default();
    let run = match start_paper_drill_for_catalog_item(slug, Some(kind), market.as_ref(), None) {
        Ok(run) => run,
        Err(r) => return Ok(refused_wire(&r)),
    };
    let steps = run
        .steps
        .iter()
        .map(|s| {
            Json::obj([
                ("id", Json::str(s.id.clone())),
                ("instruction", Json::str(s.instruction.clone())),
            ])
        })
        .collect();
    let sealed = assert_sealed_simulated(seal_simulated(Json::obj([
        ("marketId", Json::str(run.market_id.clone())),
        ("symbol", Json::str(run.symbol.clone())),
        ("steps", Json::Array(steps)),
    ])))?;
    let wire = sealed_wire(&sealed, fields_of(sealed.get("result")));
    assert_paper_never_readable_as_real_money(&wire)?;
    Ok(wire)
}

/// A fill of the checked input (`publishedFillIn`: every field present and a string).
fn fill_of(v: &Value) -> FillIn {
    FillIn {
        fill_id: v.get("fillId").as_str().unwrap_or_default().to_owned(),
        market_id: v.get("marketId").as_str().unwrap_or_default().to_owned(),
        recorded_at: None,
        side: v.get("side").clone(),
        price: v.get("price").clone(),
        size: v.get("size").clone(),
    }
}

/// `paperDrillResult`: the drill replayed from the caller's steps and trade's fills, and valued.
fn paper_drill_result(ctx: &Ctx<'_>) -> Result<Json, Refusal> {
    let market = market_of(ctx.input.get("market"));
    let kind = gate(ctx, market.as_ref())?;
    let slug = ctx.input.get("slug").as_str().unwrap_or_default();
    let completed: Vec<String> = ctx
        .input
        .get("completedStepIds")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let fills: Vec<FillIn> = ctx
        .input
        .get("fills")
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(fill_of)
        .collect();
    let run = match replay_paper_drill(slug, Some(kind), market.as_ref(), &completed, &fills, None)
    {
        Ok(run) => run,
        Err(r) => return Ok(refused_wire(&r)),
    };
    let progress = drill_progress(&run);
    // The run's de-duplicated fills, never the raw input: a double-posted id is valued once.
    let for_value: Vec<PublishedFill> = list_paper_fill_refs(&run)
        .iter()
        .filter_map(|f| {
            let side = f.side.as_deref().filter(|s| *s == "buy" || *s == "sell")?;
            Some(PublishedFill {
                fill_id: f.fill_id.clone(),
                market_id: f.market_id.clone(),
                side: Value::String(side.to_owned()),
                price: Value::String(f.price.clone()?),
                size: Value::String(f.size.clone()?),
            })
        })
        .collect();
    let mark = ctx.input.get("markPrice").as_str();
    let valuation = value_simulated_drill(&for_value, mark)?;

    let remaining = remaining_step_ids(&run)
        .into_iter()
        .map(Json::String)
        .collect();
    let sealed = assert_sealed_simulated(seal_simulated(Json::obj([
        ("workbookSlug", Json::str(run.workbook_slug.clone())),
        ("marketId", Json::str(run.market_id.clone())),
        ("symbol", Json::str(run.symbol.clone())),
        ("status", Json::str(run.status.as_str())),
        ("stepCount", int(progress.step_count)),
        ("completedCount", int(progress.completed_count)),
        ("remainingStepIds", Json::Array(remaining)),
        ("ratio", Json::str(progress.ratio.clone())),
        ("complete", Json::Bool(is_drill_complete(&run))),
        ("valuation", valuation.json()),
    ])))?;
    let result = sealed.get("result").cloned().unwrap_or(Json::Null);
    let wire = sealed_wire(&sealed, vec![("result".to_owned(), result)]);
    assert_paper_never_readable_as_real_money(&wire)?;
    Ok(wire)
}

/// `paperOpsStatus`: enable or kill only; live trade is never gated by it.
fn paper_ops_status(ctx: &Ctx<'_>) -> Result<Json, Refusal> {
    method(ctx)?;
    let status = ops::paper_ops_status(ops::enabled_option(ctx.settings));
    let status = status.json();
    // The service's own check, then the router's on what it returns.
    assert_paper_never_readable_as_real_money(&status)?;
    assert_paper_never_readable_as_real_money(&status)?;
    let wire = Json::obj([
        (
            "enabled",
            status.get("enabled").cloned().unwrap_or(Json::Bool(true)),
        ),
        ("flagId", Json::str(ops::PAPER_OPS_FLAG_ID)),
        ("envKey", Json::str(ops::PAPER_OPS_ENV_KEY)),
        ("liveTradeUnaffected", Json::Bool(true)),
        ("simulated", Json::Bool(true)),
        ("venue", Json::str(simulated::SIMULATED_VENUE)),
        ("realMoney", Json::Bool(false)),
    ]);
    assert_paper_never_readable_as_real_money(&wire)?;
    Ok(wire)
}
