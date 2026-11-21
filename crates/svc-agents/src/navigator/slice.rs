//! The navigator slice's fourteen calls, answered as `router.ts`'s `navigator` router and
//! `navigator/onchain-routes.ts` answer them. The door has already checked the caller, the scope, the region, the
//! person-only rules and the input.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::time::{Instant, zod_datetime};
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::Ctx;
use crate::gateway::desk::GatewaySlice;
use crate::metering::Metering;
use crate::runtime::{RunError, Runtime, to_trpc};

use super::onchain;
use super::ports::{LiveMarkets, read_live_markets, read_live_session};
use super::run::{Ask, RunInput, Wiring, run_session};
use super::tools::{
    self, DataTool, DataToolInput, MARKETS_LIMIT_UNSET, Market, Quote, SessionFixture,
    effective_plane, invoke_data_tool,
};

/// Answers one call of the slice.
pub fn handle(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
) -> Result<Option<Json>, TrpcError> {
    answer(ctx, store, gateway, m, rt)
        .map(Some)
        .map_err(to_trpc)
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).as_str()
}

fn quote_of(v: &Value) -> Option<Quote> {
    let Value::Object(_) = v else {
        return None;
    };
    Some(Quote {
        market_id: text(v, "marketId").unwrap_or("").to_owned(),
        last: text(v, "last").map(str::to_owned),
        as_of: text(v, "asOf").unwrap_or("").to_owned(),
        max_age_ms: v.get("maxAgeMs").as_number().unwrap_or(0.0),
    })
}

fn markets_of(v: &Value) -> Option<Vec<Market>> {
    v.as_array().map(|rows| {
        rows.iter()
            .map(|m| Market {
                market_id: text(m, "marketId").unwrap_or("").to_owned(),
                symbol: text(m, "symbol").unwrap_or("").to_owned(),
                status: text(m, "status").unwrap_or("").to_owned(),
            })
            .collect()
    })
}

fn session_of(v: &Value) -> Option<SessionFixture> {
    let Value::Object(_) = v else {
        return None;
    };
    Some(SessionFixture {
        session_id: text(v, "sessionId").unwrap_or("").to_owned(),
        user_id: text(v, "userId").unwrap_or("").to_owned(),
        status: text(v, "status").unwrap_or("").to_owned(),
    })
}

/// `input.now`, a datetime the schema checked, or the request's time.
fn now_of(input: &Value, fallback: Instant) -> Instant {
    text(input, "now")
        .and_then(|t| zod_datetime(t, false))
        .unwrap_or(fallback)
}

fn answer(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
) -> Result<Json, RunError> {
    let path = ctx.call.path;
    if onchain::CALLS.contains(&path) {
        return onchain::handle(ctx, store, rt);
    }
    let input = &ctx.input;
    let nav = &rt.navigator;
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let tier = ctx.principal.map_or("", |p| p.tier.as_str());
    let plane = || {
        effective_plane(
            text(input, "plane").unwrap_or("dark"),
            nav.trade_url.as_deref(),
        )
    };
    let law = rt.tier_laws.navigator.as_ref();
    match path {
        "navigator.policy" => Ok(tools::policy()),
        "navigator.grounded" => Ok(tools::grounded(plane())),
        "navigator.stage1Guardrail" => Ok(tools::stage1_guardrail()),
        "navigator.selectTools" => {
            let candidates: Vec<String> = input
                .get("candidates")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|c| c.as_str().unwrap_or("").to_owned())
                .collect();
            Ok(tools::select_tools(plane(), &candidates))
        }
        "navigator.tierGate" => Ok(tools::tier_gate_json(&tools::tier_gate(law, tier))),
        "navigator.invokeDataTool" => Ok(invoke(ctx, rt, user, tier)),
        "navigator.runSession" => {
            let asks: Vec<Ask> = input
                .get("asks")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|a| Ask {
                    tool: text(a, "tool").unwrap_or("").to_owned(),
                    quote: quote_of(a.get("quote")),
                    markets: markets_of(a.get("markets")),
                    session: session_of(a.get("session")),
                })
                .collect();
            run_session(
                &Wiring {
                    store,
                    rt,
                    gateway: &gateway.gateway,
                    m,
                    now: ctx.now,
                    fee_asset_id: &gateway.fee_asset_id,
                },
                &RunInput {
                    user_id: user,
                    plane: plane(),
                    tier_law: law,
                    user_tier: tier,
                    asks: &asks,
                    markets_limit: input.get("marketsLimit").as_number(),
                    now: now_of(input, ctx.now),
                },
            )
        }
        other => Err(RunError::Other(format!("{other} is not a navigator call"))),
    }
}

fn audited(result: &DataTool, occurred_at: &str) -> Json {
    let shown = match result {
        DataTool::Markets(markets) => Json::obj([
            ("status", Json::str("ok")),
            ("tool", Json::str("trade.markets.list")),
            ("markets", tools::markets_json(markets)),
        ]),
        other => other.to_json(),
    };
    Json::obj([
        ("result", shown),
        ("audit", tools::audit_entry(result, occurred_at)),
    ])
}

/// `navigator.invokeDataTool`: one data tool over the caller's fixtures, or the live reads on a live plane, with
/// its one audit row.
fn invoke(ctx: &Ctx<'_>, rt: &Runtime, user: &str, tier: &str) -> Json {
    let input = &ctx.input;
    let nav = &rt.navigator;
    let plane = effective_plane(
        text(input, "plane").unwrap_or("dark"),
        nav.trade_url.as_deref(),
    );
    let tool = service_kit::schema::js_trim(text(input, "tool").unwrap_or("")).to_owned();
    let occurred_at = text(input, "occurredAt").map_or_else(|| ctx.now.iso(), str::to_owned);
    let mut quote = quote_of(input.get("quote"));
    let mut markets = markets_of(input.get("markets"));
    if plane == tools::Plane::Live
        && let Some(port) = nav.trade_data.as_deref()
    {
        if tool == "trade.markets.list" && markets.as_ref().is_none_or(Vec::is_empty) {
            match read_live_markets(Some(port), input.get("marketsLimit").as_number()) {
                LiveMarkets::Ok(m) => markets = Some(m),
                LiveMarkets::MarketsLimitUnset => {
                    let refused = DataTool::Refuse {
                        tool: tool.clone(),
                        reason: "markets_limit_unset",
                        key: MARKETS_LIMIT_UNSET,
                    };
                    return audited(&refused, &occurred_at);
                }
                LiveMarkets::NoLiveMarkets => {}
            }
        }
        if tool == "trade.quote" {
            let market_id = quote
                .as_ref()
                .map_or("", |q| service_kit::schema::js_trim(&q.market_id))
                .to_owned();
            if !market_id.is_empty()
                && quote.as_ref().is_none_or(|q| q.last.is_none())
                && let Ok(Some(live)) = port.quote(&market_id)
            {
                quote = Some(live);
            }
        }
    }
    let mut session = session_of(input.get("session"));
    if plane == tools::Plane::Live && tool == "identity.session.read" {
        let asked_for = session
            .as_ref()
            .map_or("", |s| s.session_id.as_str())
            .to_owned();
        // A live miss never falls back to the caller's fixture.
        session = read_live_session(nav.identity_session.as_deref(), &asked_for, user);
    }
    let result = invoke_data_tool(&DataToolInput {
        tool: &tool,
        plane,
        tier_law: rt.tier_laws.navigator.as_ref(),
        user_tier: tier,
        requester_user_id: user,
        now: now_of(input, ctx.now),
        quote: quote.as_ref(),
        markets: markets.as_deref(),
        session: session.as_ref(),
    });
    audited(&result, &occurred_at)
}
