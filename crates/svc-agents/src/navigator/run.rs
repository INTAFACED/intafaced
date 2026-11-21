//! `navigator/session-run.ts`: the metered `navigator.answer` run. Each ask goes through the runtime's `act`, so the
//! session's guardrail decides and writes the row; a refused or empty ask is reported unanswered, never filled in.
//! The run calls no engine, so it opens no usage window and settles to zero, and says so.

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::time::Instant;

use crate::db::Store;
use crate::gateway::Gateway;
use crate::metering::{Metering, settle};
use crate::runtime::eligibility::Law;
use crate::runtime::{self, ActInput, Rt, RunError, Runtime};

use super::Navigator;
use super::ports::{LiveMarkets, read_live_markets, read_live_quote, read_live_session};
use super::tools::{
    DataTool, DataToolInput, MARKETS_LIMIT_UNSET, Market, Plane, Quote, SessionFixture,
    TIER_CLOSED, TierGate, UNAVAILABLE, declared_tools, invoke_data_tool, tier_gate,
};

/// `NAVIGATOR_AGENT_ID`.
pub const NAVIGATOR_AGENT_ID: &str = "navigator";

/// `NavigatorAsk`: a tool asked for, with the fixtures the caller supplied for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub tool: String,
    pub quote: Option<Quote>,
    pub markets: Option<Vec<Market>>,
    pub session: Option<SessionFixture>,
}

/// What one run is given.
pub struct RunInput<'a> {
    pub user_id: &'a str,
    pub plane: Plane,
    pub tier_law: Option<&'a Law>,
    pub user_tier: &'a str,
    pub asks: &'a [Ask],
    pub markets_limit: Option<f64>,
    pub now: Instant,
}

fn metering(
    session_id: Option<&str>,
    billed: &str,
    asset: &str,
    closed: bool,
    settlements: Json,
) -> Json {
    Json::obj([
        ("sessionId", session_id.map_or(Json::Null, Json::str)),
        ("billedAmount", Json::str(billed)),
        ("assetId", Json::str(asset)),
        ("sessionClosed", Json::Bool(closed)),
        ("settlements", settlements),
    ])
}

fn unmetered(asset: &str) -> Json {
    metering(None, "0", asset, false, Json::Array(vec![]))
}

fn refuse(reason: &str, key: &str, unanswered: Vec<Json>, metering: Json) -> Json {
    Json::obj([
        ("status", Json::str("refuse")),
        ("reason", Json::str(reason)),
        ("userMessageKey", Json::str(key)),
        ("unanswered", Json::Array(unanswered)),
        ("metering", metering),
    ])
}

/// `settleAndClose`: every open window settled, then the session closed.
fn settle_and_close(x: &Rt<'_>, session_id: &str, fee: &str) -> Result<Json, RunError> {
    let results = settle::settle_session(x.m, x.pool, session_id, x.now)?;
    let closed = runtime::close_session(x, session_id)?;
    let total: service_kit::money::Amount = results.iter().map(|r| r.amount).sum();
    Ok(metering(
        Some(session_id),
        &format_amount(total),
        fee,
        closed.status == "closed",
        Json::Array(
            results
                .iter()
                .map(|r| {
                    Json::obj([
                        ("windowId", Json::str(r.window_id.clone())),
                        ("amount", Json::str(format_amount(r.amount))),
                        ("chargeKey", Json::str(r.charge_key.clone())),
                        ("settled", Json::Bool(r.settled)),
                    ])
                })
                .collect(),
        ),
    ))
}

fn unanswered(tool: &str, by: &str, reason: &str, key: &str) -> Json {
    Json::obj([
        ("tool", Json::str(tool)),
        ("refusedBy", Json::str(by)),
        ("reason", Json::str(reason)),
        ("userMessageKey", Json::str(key)),
    ])
}

fn trim(s: &str) -> &str {
    service_kit::schema::js_trim(s)
}

/// What the metered run is opened on, once the free refusals have passed: the store is not read before then.
pub struct Wiring<'a> {
    pub store: &'a Store,
    pub rt: &'a Runtime,
    pub gateway: &'a Gateway,
    pub m: &'a Metering,
    pub now: Instant,
    /// The router's `feeAssetId`: the asset the run's metering names.
    pub fee_asset_id: &'a str,
}

/// `runNavigatorAnswerSession`, as `navigator.runSession` answers it.
pub fn run_session(w: &Wiring<'_>, input: &RunInput<'_>) -> Result<Json, RunError> {
    let nav = &w.rt.navigator;
    let fee = w.fee_asset_id;
    // Free refusals, before a session exists.
    if input.plane == Plane::Dark {
        return Ok(refuse(
            "trade_plane_dark",
            UNAVAILABLE,
            vec![],
            unmetered(fee),
        ));
    }
    let user_tier = match tier_gate(input.tier_law, input.user_tier) {
        TierGate::Refuse(reason) => {
            return Ok(refuse(reason, TIER_CLOSED, vec![], unmetered(fee)));
        }
        TierGate::Ok {
            user_tier,
            allowed_tools,
        } => (user_tier, allowed_tools),
    };
    if input.asks.is_empty() {
        return Ok(Json::obj([
            ("status", Json::str("empty")),
            ("userMessageKey", Json::str("agents.navigator.empty")),
            ("metering", unmetered(fee)),
        ]));
    }
    let declared = declared_tools();
    if !input
        .asks
        .iter()
        .any(|a| declared.iter().any(|d| d == trim(&a.tool)))
    {
        return Ok(refuse(
            "tool_not_declared",
            UNAVAILABLE,
            vec![],
            unmetered(fee),
        ));
    }
    if !input
        .asks
        .iter()
        .any(|a| user_tier.1.iter().any(|t| t == trim(&a.tool)))
    {
        return Ok(refuse(
            "tier_not_granted",
            TIER_CLOSED,
            vec![],
            unmetered(fee),
        ));
    }
    let trade = nav.trade_data.as_deref();
    let wants_markets = |a: &Ask| {
        trim(&a.tool) == "trade.markets.list" && a.markets.as_ref().is_none_or(Vec::is_empty)
    };
    let mut prefetched: Option<Vec<Market>> = None;
    if input.asks.iter().any(wants_markets) {
        match read_live_markets(trade, input.markets_limit) {
            LiveMarkets::MarketsLimitUnset => {
                return Ok(refuse(
                    "markets_limit_unset",
                    MARKETS_LIMIT_UNSET,
                    vec![],
                    unmetered(fee),
                ));
            }
            LiveMarkets::Ok(m) => prefetched = Some(m),
            LiveMarkets::NoLiveMarkets => {}
        }
    }

    // The metered run.
    let x = &Rt {
        rt: w.rt,
        pool: w.store.pool()?,
        gateway: w.gateway,
        m: w.m,
        now: w.now,
    };
    let session = runtime::open_session(x, input.user_id, NAVIGATOR_AGENT_ID)?;
    let asked = run_asks(x, nav, input, &session.id, &prefetched);
    let (findings, gaps) = match asked {
        Ok(v) => v,
        Err(e) => {
            // The original error is the one worth answering; a failed settle on top of it does not replace it.
            let _ = settle_and_close(x, &session.id, fee);
            return Err(e);
        }
    };
    let metering = settle_and_close(x, &session.id, fee)?;
    if findings.is_empty() {
        return Ok(refuse("no_grounded_answer", UNAVAILABLE, gaps, metering));
    }
    let count = |n: usize| Json::int(i64::try_from(n).unwrap_or(i64::MAX));
    let complete = gaps.is_empty();
    let answered = findings.len();
    Ok(Json::obj([
        ("status", Json::str("ok")),
        ("userTier", Json::str(user_tier.0)),
        ("findings", Json::Array(findings)),
        ("unanswered", Json::Array(gaps)),
        ("asked", count(input.asks.len())),
        ("answered", count(answered)),
        ("complete", Json::Bool(complete)),
        ("metering", metering),
    ]))
}

/// Each ask through `act`: a guardrail refusal is an unanswered ask; any other failure ends the run.
fn run_asks(
    x: &Rt<'_>,
    nav: &Navigator,
    input: &RunInput<'_>,
    session_id: &str,
    prefetched: &Option<Vec<Market>>,
) -> Result<(Vec<Json>, Vec<Json>), RunError> {
    let trade = nav.trade_data.as_deref();
    let mut findings = Vec::new();
    let mut gaps = Vec::new();
    for ask in input.asks {
        let tool = trim(&ask.tool).to_owned();
        let mut quote = ask.quote.clone();
        let mut markets = ask.markets.clone();
        let mut fixture = ask.session.clone();
        if input.plane == Plane::Live && trade.is_some() {
            if tool == "trade.markets.list" && markets.as_ref().is_none_or(Vec::is_empty) {
                if let Some(p) = prefetched {
                    markets = Some(p.clone());
                } else if let LiveMarkets::Ok(m) = read_live_markets(trade, input.markets_limit) {
                    markets = Some(m);
                }
            }
            if tool == "trade.quote" {
                let market_id = quote.as_ref().map_or("", |q| trim(&q.market_id)).to_owned();
                if !market_id.is_empty()
                    && quote.as_ref().is_none_or(|q| q.last.is_none())
                    && let Some(live) = read_live_quote(trade, &market_id)
                {
                    quote = Some(live);
                }
            }
        }
        if input.plane == Plane::Live && tool == "identity.session.read" {
            // A live miss never falls back to the caller's fixture.
            let asked_for = fixture
                .as_ref()
                .map_or("", |f| f.session_id.as_str())
                .to_owned();
            fixture = read_live_session(nav.identity_session.as_deref(), &asked_for, input.user_id);
        }
        let mut got: Option<DataTool> = None;
        let acted = runtime::act(
            x,
            &ActInput {
                session_id,
                tool: &tool,
                ..ActInput::default()
            },
            || {
                let r = invoke_data_tool(&DataToolInput {
                    tool: &tool,
                    plane: input.plane,
                    tier_law: input.tier_law,
                    user_tier: input.user_tier,
                    requester_user_id: input.user_id,
                    now: input.now,
                    quote: quote.as_ref(),
                    markets: markets.as_deref(),
                    session: fixture.as_ref(),
                });
                let j = r.to_json();
                got = Some(r);
                Ok(j)
            },
        );
        match acted {
            Ok(_) => {}
            Err(RunError::Refused { refusal, .. }) => {
                gaps.push(unanswered(
                    &tool,
                    "guardrail",
                    &refusal.code,
                    &refusal.user_message_key,
                ));
                continue;
            }
            Err(e) => return Err(e),
        }
        match got {
            Some(DataTool::Refuse { reason, key, .. }) => {
                gaps.push(unanswered(&tool, "tool", reason, key))
            }
            Some(ok) => findings.push(ok.to_json()),
            None => return Err(RunError::Other("the data tool did not run".to_owned())),
        }
    }
    Ok((findings, gaps))
}
