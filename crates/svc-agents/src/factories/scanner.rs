//! \`scanner.*\` (\`router.ts\` \`scanner\`, \`scanner/\`): the Market Scanner's policy, its guardrail, its tier gate, its
//! read-only data tools, its ranker over fixtures and over the tools, and the metered rank run.
//!
//! Nothing here invents a price, a market row or a ranking: a blank D26-P0-11 signal-inputs law, a blank tier law, a
//! dark market plane, a missing quote or a stale row is a typed refusal. Scores are a unitless rank key; \`last\` and
//! \`volume24h\` are money strings read as scaled integers, never as a \`number\`.

use service_kit::json::Json;
use service_kit::money::{Amount, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::js::{is_fresh, locale_compare, to_fixed};
use super::{Cx, is_refused, json_num, json_str, metered_run, strings, unmetered};
use crate::runtime::RunError;
use crate::runtime::eligibility::Law;
use crate::runtime::guardrails::{Guardrail, is_live_write_tool, parse_guardrail};
use crate::runtime::{ActInput, act};

/// \`SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL\`.
pub const RESIDUAL: &str = "D26-P0-11 scanner signal inputs law is owner-only — refuse-closed (never invent rankings / market alpha)";
/// \`P0_11_BOARD_ID\`.
pub const BOARD_ID: &str = "D26-P0-11";
/// \`SCANNER_AGENT_ID\`.
pub const AGENT_ID: &str = "scanner";
/// \`SCANNER_TICKER_TOOL\`.
pub const TICKER_TOOL: &str = "trade.ticker";

/// \`SCANNER_MONEY_WRITE_TOOLS\`: never granted on the scanner.
pub const MONEY_WRITE_TOOLS: [&str; 12] = [
    "ledger.post",
    "ledger.hold",
    "pay.refund",
    "pay.capture",
    "bank.transfer",
    "bank.withdraw",
    "bank.loan",
    "trade.order",
    "trade.place",
    "trade.amend",
    "trade.cancel",
    "p2p.release",
];

/// \`SCANNER_DATA_TOOLS\`.
pub const DATA_TOOLS: [&str; 3] = ["trade.ticker", "trade.markets.list", "trade.book.top"];

/// \`ABS_CHANGE_X_LOG_VOLUME_REQUIRED_INPUTS\`.
const REQUIRED_INPUTS: [&str; 3] = ["last", "volume24h", "change24hBps"];

/// \`scannerAgentGuardrail()\`.
pub fn guardrail() -> Result<Guardrail, RunError> {
    let spec = service_kit::json::parse(
        r#"{"agentId":"scanner","version":1,"capacityMode":"research_only",
            "tools":[{"name":"trade.ticker","module":"trade","mode":"read"},
                     {"name":"trade.markets.list","module":"trade","mode":"read"},
                     {"name":"trade.book.top","module":"trade","mode":"read"}],
            "limits":{"maxActionsPerSession":80,"maxOutputTokensPerCall":4096,"maxSpendPerSession":"1",
                      "allowedModules":["trade","agents"],"allowedTasks":["scanner.rank"]}}"#,
    )
    .map_err(|e| RunError::Other(e.message))?;
    parse_guardrail(&spec).map_err(|e| RunError::Other(e.0))
}

/// \`isScannerMoneyWriteTool\`.
pub fn is_money_write_tool(tool: &str) -> bool {
    MONEY_WRITE_TOOLS.contains(&tool) || is_live_write_tool(tool)
}

// ── Values ─────────────────────────────────────────────────────────────────

/// \`TickerFixture\` (and \`MarketFixture\`, the same shape).
#[derive(Debug, Clone, PartialEq)]
pub struct Ticker {
    pub market_id: String,
    pub last: Option<String>,
    pub volume24h: Option<String>,
    pub change24h_bps: Option<f64>,
    pub as_of: String,
    pub max_age_ms: f64,
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

impl Ticker {
    /// A row the input schema already checked.
    pub fn of(v: &Value) -> Ticker {
        Ticker {
            market_id: v.get("marketId").as_str().unwrap_or("").to_owned(),
            last: opt_str(v.get("last")),
            volume24h: opt_str(v.get("volume24h")),
            change24h_bps: v.get("change24hBps").as_number(),
            as_of: v.get("asOf").as_str().unwrap_or("").to_owned(),
            max_age_ms: v.get("maxAgeMs").as_number().unwrap_or(0.0),
        }
    }

    fn list(v: &Value) -> Vec<Ticker> {
        v.as_array().unwrap_or(&[]).iter().map(Ticker::of).collect()
    }
}

/// \`ScannerSignalInputsLaw\` as the input names it: omitted resolves to the production default, which is unpublished
/// (\`resolveScannerSignalInputsLaw\`); null and \`{ published: false }\` are blank.
fn inputs_gate(law: &Value) -> Result<(), &'static str> {
    let Value::Object(_) = law else {
        return Err("signal_inputs_law_blank");
    };
    if !matches!(law.get("published"), Value::Bool(true))
        || law.get("p0_11").as_str() != Some("sealed")
    {
        return Err("signal_inputs_law_blank");
    }
    let allowed: Vec<&str> = law
        .get("allowedInputs")
        .as_array()
        .unwrap_or(&[])
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if allowed.is_empty() {
        return Err("inputs_empty");
    }
    if law.get("rankingRecipeId").as_str() != Some("abs_change_x_log_volume") {
        return Err("ranking_recipe_unknown");
    }
    if REQUIRED_INPUTS.iter().any(|r| !allowed.contains(r)) {
        return Err("required_inputs_missing");
    }
    Ok(())
}

/// The P0-11 refusal's fields, in the order the outputs declare them.
fn inputs_refusal(reason: &str) -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("refuse")),
        ("reason".to_owned(), Json::str(reason)),
        (
            "userMessageKey".to_owned(),
            Json::str("agents.scanner.signal_inputs_closed"),
        ),
        ("residual".to_owned(), Json::str(RESIDUAL)),
    ]
}

fn refusal(reason: &str, key: &str) -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("refuse")),
        ("reason".to_owned(), Json::str(reason)),
        ("userMessageKey".to_owned(), Json::str(key)),
    ]
}

/// \`ScannerTierGateOk\`.
struct TierOk {
    user_tier: String,
    max_signals: f64,
    allowed_tools: Vec<String>,
}

/// \`scannerTierGate\`: blank or unpublished law, an empty matrix, no tier or no grant refuse; so does a depth below 1.
fn tier_gate(law: Option<&Law>, user_tier: &str) -> Result<TierOk, &'static str> {
    let tier = js_trim(user_tier);
    let Some(Law::Published(matrix)) = law else {
        return Err("tier_law_blank");
    };
    if matrix.is_empty() {
        return Err("tier_law_blank");
    }
    if tier.is_empty() {
        return Err("tier_not_granted");
    }
    let Some((_, grant)) = matrix.iter().find(|(t, _)| t == tier) else {
        return Err("tier_not_granted");
    };
    let max = grant.max_signals.unwrap_or(0.0);
    if max.fract() != 0.0 || max < 1.0 {
        return Err("depth_invalid");
    }
    Ok(TierOk {
        user_tier: tier.to_owned(),
        max_signals: max,
        allowed_tools: grant.tools.clone(),
    })
}

const TIER_CLOSED: &str = "agents.scanner.tier_closed";
const UNAVAILABLE: &str = "agents.scanner.unavailable";

// ── Data tools ─────────────────────────────────────────────────────────────

/// \`parseUnsignedDecimal\`: \`/^\d+(\.\d{1,18})?$/\`.
fn unsigned_decimal(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(|f| digits(f) && f.len() <= 18)
}

/// What \`invokeScannerDataTool\` is handed.
pub struct ToolCall<'a> {
    pub tool: &'a str,
    pub plane: &'a str,
    pub law: Option<&'a Law>,
    pub user_tier: &'a str,
    pub now: Instant,
    pub ticker: Option<&'a Ticker>,
    /// \`markets\` as the input holds it (\`{ marketId, symbol, status }\` each), or none.
    pub markets: Option<&'a [Value]>,
    /// \`bookTop\` as the input holds it, or none.
    pub book_top: Option<&'a Value>,
}

fn tool_refusal(tool: &str, reason: &str, key: &str) -> Json {
    Json::obj([
        ("status", Json::str("refuse")),
        ("tool", Json::str(tool)),
        ("reason", Json::str(reason)),
        ("userMessageKey", Json::str(key)),
    ])
}

/// \`invokeScannerDataTool\`: one declared read tool against the caller's fixture, behind the plane, the tier and the
/// allowlist, and the row's own age.
pub fn invoke_data_tool(c: &ToolCall<'_>) -> Result<Json, RunError> {
    let tool = js_trim(c.tool);
    if is_money_write_tool(tool) {
        return Ok(tool_refusal(tool, "money_write", UNAVAILABLE));
    }
    if c.plane == "dark" {
        return Ok(tool_refusal(tool, "market_plane_dark", UNAVAILABLE));
    }
    let tier = match tier_gate(c.law, c.user_tier) {
        Ok(t) => t,
        Err(reason) => return Ok(tool_refusal(tool, reason, TIER_CLOSED)),
    };
    let declared = guardrail()?.tools.iter().any(|t| t.name == tool);
    if !declared || !DATA_TOOLS.contains(&tool) {
        return Ok(tool_refusal(tool, "tool_not_declared", UNAVAILABLE));
    }
    if !tier.allowed_tools.iter().any(|t| t == tool) {
        return Ok(tool_refusal(tool, "tool_not_in_tier", TIER_CLOSED));
    }
    let now_ms = c.now.0;
    let refuse = |reason: &str| Ok(tool_refusal(tool, reason, UNAVAILABLE));

    if tool == "trade.ticker" {
        let Some(q) = c.ticker.filter(|q| !js_trim(&q.market_id).is_empty()) else {
            return refuse("missing_fixture");
        };
        let (Some(last), Some(volume), Some(change)) = (&q.last, &q.volume24h, q.change24h_bps)
        else {
            return refuse("incomplete_ticker");
        };
        if !unsigned_decimal(last) || !unsigned_decimal(volume) {
            return refuse("invalid_decimal");
        }
        if !is_fresh(&q.as_of, q.max_age_ms, now_ms) {
            return refuse("stale");
        }
        return Ok(Json::obj([
            ("status", Json::str("ok")),
            ("tool", Json::str("trade.ticker")),
            ("marketId", Json::str(q.market_id.clone())),
            ("last", Json::str(last.clone())),
            ("volume24h", Json::str(volume.clone())),
            ("change24hBps", Json::Number(change)),
            ("asOf", Json::str(q.as_of.clone())),
        ]));
    }

    if tool == "trade.markets.list" {
        let Some(markets) = c.markets.filter(|m| !m.is_empty()) else {
            return refuse("empty_markets");
        };
        let field = |m: &Value, k: &str| m.get(k).as_str().unwrap_or("").to_owned();
        if markets.iter().any(|m| {
            js_trim(&field(m, "marketId")).is_empty() || js_trim(&field(m, "symbol")).is_empty()
        }) {
            return refuse("missing_fixture");
        }
        return Ok(Json::obj([
            ("status", Json::str("ok")),
            ("tool", Json::str("trade.markets.list")),
            (
                "markets",
                Json::Array(
                    markets
                        .iter()
                        .map(|m| {
                            Json::obj([
                                ("marketId", Json::str(field(m, "marketId"))),
                                ("symbol", Json::str(field(m, "symbol"))),
                                ("status", Json::str(field(m, "status"))),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]));
    }

    // trade.book.top
    let Some(book) = c
        .book_top
        .filter(|b| !js_trim(b.get("marketId").as_str().unwrap_or("")).is_empty())
    else {
        return refuse("missing_fixture");
    };
    let (Some(bid), Some(ask)) = (book.get("bid").as_str(), book.get("ask").as_str()) else {
        return refuse("incomplete_book");
    };
    if !unsigned_decimal(bid) || !unsigned_decimal(ask) {
        return refuse("invalid_decimal");
    }
    let as_of = book.get("asOf").as_str().unwrap_or("");
    if !is_fresh(
        as_of,
        book.get("maxAgeMs").as_number().unwrap_or(0.0),
        now_ms,
    ) {
        return refuse("stale");
    }
    Ok(Json::obj([
        ("status", Json::str("ok")),
        ("tool", Json::str("trade.book.top")),
        (
            "marketId",
            Json::str(book.get("marketId").as_str().unwrap_or("")),
        ),
        ("bid", Json::str(bid)),
        ("ask", Json::str(ask)),
        ("asOf", Json::str(as_of)),
    ]))
}

// ── The ranker ─────────────────────────────────────────────────────────────

/// \`lnPositiveBigint\`: ln of a positive integer from its 53-bit mantissa.
#[expect(
    clippy::cast_precision_loss,
    reason = "the TypeScript's Number(n >> shift) of a value under 2^53, exact"
)]
#[expect(
    clippy::float_arithmetic,
    reason = "a unitless rank key, never money: the TypeScript computes it in doubles"
)]
fn ln_positive(n: Amount) -> Option<f64> {
    if n <= Amount::ZERO {
        return None;
    }
    let n = n.scaled();
    let bits = 128 - n.leading_zeros();
    let shift = bits.saturating_sub(53);
    let mantissa = (n >> shift) as f64;
    if !mantissa.is_finite() || mantissa <= 0.0 {
        return None;
    }
    Some(mantissa.ln() + f64::from(shift) * std::f64::consts::LN_2)
}

/// \`log1pVolumeWeight\`: ln(1 + volume) as a unitless key, the volume kept a scaled integer.
#[expect(
    clippy::float_arithmetic,
    reason = "a unitless rank key, never money: the TypeScript computes it in doubles"
)]
fn volume_weight(vol: Amount) -> Option<f64> {
    const SCALE: Amount = Amount::whole(1);
    if vol < Amount::ZERO {
        return None;
    }
    let numer = ln_positive(SCALE.checked_add(vol)?)?;
    let scale = ln_positive(SCALE)?;
    let w = numer - scale;
    w.is_finite().then_some(w)
}

/// \`rankFixtures\`' options.
pub struct RankOptions<'a> {
    pub now: Instant,
    pub limit: Option<f64>,
    pub market_plane: Option<&'a str>,
    pub allowlist: Option<Vec<String>>,
    pub law: &'a Value,
}

/// A ranked outcome: \`ok\`'s counts and signals, or the answer of any other status.
pub enum Ranked {
    Ok {
        signals: Vec<Json>,
        ranked_at: String,
        considered: usize,
        skipped_stale: usize,
        skipped_incomplete: usize,
    },
    Other(Vec<(String, Json)>),
}

fn empty() -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("empty")),
        (
            "userMessageKey".to_owned(),
            Json::str("agents.scanner.empty"),
        ),
    ]
}

fn unavailable(reason: &str) -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("unavailable")),
        ("userMessageKey".to_owned(), Json::str(UNAVAILABLE)),
        ("reason".to_owned(), Json::str(reason)),
    ]
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts are small; the TypeScript adds numbers"
)]
fn count(n: usize) -> Json {
    Json::Number(n as f64)
}

/// \`rankFixtures\`: |change| × ln(1 + volume) over fresh, complete rows, behind the sealed P0-11 law and a published
/// page size. Incomplete rows are skipped, never zero-filled.
#[expect(
    clippy::float_arithmetic,
    reason = "a unitless rank key, never money: the TypeScript computes it in doubles"
)]
pub fn rank_fixtures(fixtures: &[Ticker], o: &RankOptions<'_>) -> Ranked {
    if let Err(reason) = inputs_gate(o.law) {
        return Ranked::Other(inputs_refusal(reason));
    }
    let Some(limit) = o.limit.filter(|l| l.fract() == 0.0 && *l >= 1.0) else {
        return Ranked::Other(refusal(
            "rank_limit_unset",
            "agents.scanner.rank_limit_unset",
        ));
    };
    if o.market_plane == Some("dark") {
        return Ranked::Other(unavailable("market_plane_dark"));
    }
    let (scoped, not_allowed): (Vec<&Ticker>, usize) = match &o.allowlist {
        Some(list) if !list.is_empty() => {
            let kept: Vec<&Ticker> = fixtures
                .iter()
                .filter(|f| list.contains(&f.market_id))
                .collect();
            let skipped = fixtures.len() - kept.len();
            (kept, skipped)
        }
        _ => (fixtures.iter().collect(), 0),
    };
    if scoped.is_empty() {
        return Ranked::Other(empty());
    }
    let mut stale = 0;
    let mut incomplete = not_allowed;
    struct Candidate {
        market_id: String,
        score: f64,
        vol: Amount,
        reasons: Vec<&'static str>,
    }
    let mut candidates = Vec::new();
    for row in scoped.iter().copied() {
        if row.market_id.is_empty() {
            incomplete += 1;
            continue;
        }
        if !is_fresh(&row.as_of, row.max_age_ms, o.now.0) {
            stale += 1;
            continue;
        }
        let (Some(last), Some(volume), Some(change)) =
            (&row.last, &row.volume24h, row.change24h_bps)
        else {
            incomplete += 1;
            continue;
        };
        let last = parse_amount(last).ok();
        let vol = parse_amount(volume).ok();
        let weight = vol.and_then(volume_weight);
        let (Some(last), Some(vol), Some(weight)) = (last, vol, weight) else {
            incomplete += 1;
            continue;
        };
        if last < Amount::ZERO {
            incomplete += 1;
            continue;
        }
        let abs = change.abs();
        let mut reasons = vec![if abs > 0.0 {
            if change >= 0.0 {
                "change_up"
            } else {
                "change_down"
            }
        } else {
            "change_flat"
        }];
        if vol > Amount::ZERO {
            reasons.push("has_volume");
        }
        candidates.push(Candidate {
            market_id: row.market_id.clone(),
            score: abs * weight,
            vol,
            reasons,
        });
    }
    if candidates.is_empty() {
        if stale > 0 && incomplete == 0 {
            return Ranked::Other(unavailable("stale"));
        }
        if incomplete > 0 || stale > 0 {
            return Ranked::Other(unavailable("no_quotes"));
        }
        return Ranked::Other(empty());
    }
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.vol.cmp(&a.vol))
            .then_with(|| locale_compare(&a.market_id, &b.market_id))
    });
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a whole page size of at least 1"
    )]
    let take = limit.min(1e9) as usize;
    Ranked::Ok {
        signals: candidates
            .iter()
            .take(take)
            .map(|c| {
                Json::obj([
                    ("marketId", Json::str(c.market_id.clone())),
                    ("score", Json::str(to_fixed(c.score, 6))),
                    ("reasons", strings(&c.reasons)),
                ])
            })
            .collect(),
        ranked_at: o.now.iso(),
        considered: scoped.len() + not_allowed,
        skipped_stale: stale,
        skipped_incomplete: incomplete,
    }
}

fn allowlist(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// The \`ok\` answer's head: status, signals, then the counts, in the outputs' order.
fn ok_head(
    signals: Vec<Json>,
    ranked_at: String,
    considered: usize,
    stale: usize,
    incomplete: usize,
) -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("ok")),
        ("signals".to_owned(), Json::Array(signals)),
        ("rankedAt".to_owned(), Json::str(ranked_at)),
        ("considered".to_owned(), count(considered)),
        ("skippedStale".to_owned(), count(stale)),
        ("skippedIncomplete".to_owned(), count(incomplete)),
    ]
}

fn pair(k: &str, v: Json) -> (String, Json) {
    (k.to_owned(), v)
}

// ── The calls ──────────────────────────────────────────────────────────────

/// Answers one \`scanner.*\` call.
pub fn handle(cx: &Cx<'_>, call: &str) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let law = cx.rt.tier_laws.scanner.as_ref();
    match call {
        "policy" => Ok(Json::obj([
            ("boardId", Json::str(BOARD_ID)),
            ("productionDefaultPublished", Json::Bool(false)),
            ("sealedRecipeId", Json::str("abs_change_x_log_volume")),
            ("residual", Json::str(RESIDUAL)),
            ("inventsRankings", Json::Bool(false)),
            ("inventsLiveTickers", Json::Bool(false)),
            ("liveTickersClassX", Json::Bool(true)),
            ("fixtureRankOnlyWithoutLivePlane", Json::Bool(true)),
        ])),
        "rankFixtures" => {
            let ranked = rank_fixtures(
                &Ticker::list(input.get("fixtures")),
                &RankOptions {
                    now: cx.now_of("now"),
                    limit: input.get("limit").as_number(),
                    market_plane: input.get("marketPlane").as_str(),
                    allowlist: allowlist(input.get("marketAllowlist")),
                    law: input.get("signalInputsLaw"),
                },
            );
            Ok(match ranked {
                Ranked::Ok {
                    signals,
                    ranked_at,
                    considered,
                    skipped_stale,
                    skipped_incomplete,
                } => Json::Object(ok_head(
                    signals,
                    ranked_at,
                    considered,
                    skipped_stale,
                    skipped_incomplete,
                )),
                Ranked::Other(fields) => Json::Object(fields),
            })
        }
        "stage2Guardrail" => Ok(stage2_guardrail(&guardrail()?)),
        "tierGate" => Ok(match tier_gate(law, cx.tier()) {
            Ok(t) => Json::obj([
                ("status", Json::str("ok")),
                ("userTier", Json::str(t.user_tier)),
                ("maxSignals", Json::Number(t.max_signals)),
                ("allowedTools", strings(&t.allowed_tools)),
            ]),
            Err(reason) => Json::Object(refusal(reason, TIER_CLOSED)),
        }),
        "invokeDataTool" => {
            let ticker = match input.get("ticker") {
                v @ Value::Object(_) => Some(Ticker::of(v)),
                _ => None,
            };
            invoke_data_tool(&ToolCall {
                tool: input.get("tool").as_str().unwrap_or(""),
                plane: input.get("plane").as_str().unwrap_or(""),
                law,
                user_tier: cx.tier(),
                now: cx.now_of("now"),
                ticker: ticker.as_ref(),
                markets: input.get("markets").as_array(),
                book_top: match input.get("bookTop") {
                    v @ Value::Object(_) => Some(v),
                    _ => None,
                },
            })
        }
        "rankLive" => rank_live(cx, law),
        "runSession" => run_session(cx, law),
        _ => Err(RunError::Trpc(crate::door::not_ported(cx.ctx.call.slice))),
    }
}

/// \`serialiseGuardrail\` as \`stage2Guardrail\`'s output declares it.
fn stage2_guardrail(g: &Guardrail) -> Json {
    Json::obj([
        ("agentId", Json::str(g.agent_id.clone())),
        ("version", Json::int(g.version)),
        (
            "tools",
            Json::Array(
                g.tools
                    .iter()
                    .map(|t| {
                        let mut f = vec![
                            pair("name", Json::str(t.name.clone())),
                            pair("module", Json::str(t.module.clone())),
                            pair("mode", Json::str(t.mode.clone())),
                            pair("requiresApproval", Json::Bool(t.requires_approval)),
                        ];
                        if let Some(m) = t.max_calls_per_session {
                            f.push(pair("maxCallsPerSession", Json::int(m)));
                        }
                        Json::Object(f)
                    })
                    .collect(),
            ),
        ),
        (
            "limits",
            Json::obj([
                (
                    "maxActionsPerSession",
                    Json::int(g.limits.max_actions_per_session),
                ),
                (
                    "maxOutputTokensPerCall",
                    Json::int(g.limits.max_output_tokens_per_call),
                ),
                (
                    "maxSpendPerSession",
                    g.limits.max_spend_per_session.map_or(Json::Null, |a| {
                        Json::str(service_kit::money::format_amount(a))
                    }),
                ),
                ("allowedModules", strings(&g.limits.allowed_modules)),
                ("allowedTasks", strings(&g.limits.allowed_tasks)),
            ]),
        ),
    ])
}

/// \`rankLiveFromTickers\`: each ticker through \`trade.ticker\`, then the ranker at the tier's depth.
fn rank_live(cx: &Cx<'_>, law: Option<&Law>) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let signal_law = input.get("signalInputsLaw");
    if let Err(reason) = inputs_gate(signal_law) {
        return Ok(Json::Object(inputs_refusal(reason)));
    }
    let plane = input.get("plane").as_str().unwrap_or("");
    if plane == "dark" {
        return Ok(Json::Object(refusal("market_plane_dark", UNAVAILABLE)));
    }
    let tier = match tier_gate(law, cx.tier()) {
        Ok(t) => t,
        Err(reason) => return Ok(Json::Object(refusal(reason, TIER_CLOSED))),
    };
    if !tier.allowed_tools.iter().any(|t| t == TICKER_TOOL) {
        return Ok(Json::Object(refusal("tier_not_granted", TIER_CLOSED)));
    }
    let now = cx.now_of("now");
    let tickers = Ticker::list(input.get("tickers"));
    let mut accepted = Vec::new();
    let mut refused = 0;
    for t in &tickers {
        let r = invoke_data_tool(&ToolCall {
            tool: TICKER_TOOL,
            plane,
            law,
            user_tier: cx.tier(),
            now,
            ticker: Some(t),
            markets: None,
            book_top: None,
        })?;
        match accepted_ticker(&r, t) {
            Some(a) => accepted.push(a),
            None => refused += 1,
        }
    }
    if accepted.is_empty() {
        if tickers.is_empty() {
            return Ok(Json::Object(empty()));
        }
        return Ok(Json::Object(refusal("no_live_tickers", UNAVAILABLE)));
    }
    let ranked = rank_fixtures(
        &accepted,
        &RankOptions {
            now,
            limit: Some(tier.max_signals),
            market_plane: Some(plane),
            allowlist: allowlist(input.get("marketAllowlist")),
            law: signal_law,
        },
    );
    Ok(match ranked {
        Ranked::Ok {
            signals,
            ranked_at,
            considered,
            skipped_stale,
            skipped_incomplete,
        } => {
            let mut f = ok_head(
                signals,
                ranked_at,
                considered,
                skipped_stale,
                skipped_incomplete,
            );
            f.push(pair("maxSignals", Json::Number(tier.max_signals)));
            f.push(pair("userTier", Json::str(tier.user_tier)));
            f.push(pair("tickersAccepted", count(accepted.len())));
            f.push(pair("tickersRefused", count(refused)));
            Json::Object(f)
        }
        Ranked::Other(fields) => Json::Object(fields),
    })
}

/// The ticker a \`trade.ticker\` answer accepted, with the fixture's own age bound.
fn accepted_ticker(r: &Json, fixture: &Ticker) -> Option<Ticker> {
    if r.get("status").and_then(json_str) != Some("ok")
        || r.get("tool").and_then(json_str) != Some(TICKER_TOOL)
    {
        return None;
    }
    let s = |k: &str| r.get(k).and_then(json_str).map(str::to_owned);
    Some(Ticker {
        market_id: s("marketId").unwrap_or_default(),
        last: s("last"),
        volume24h: s("volume24h"),
        change24h_bps: r.get("change24hBps").and_then(json_num),
        as_of: s("asOf").unwrap_or_default(),
        max_age_ms: fixture.max_age_ms,
    })
}

// ── The metered run ────────────────────────────────────────────────────────

/// \`SpotTickersPort\`: svc-trade's tickers, a page of \`limit\`.
pub trait SpotTickers: Send + Sync {
    /// \`sample(limit)\`: the rows, or why not; \`Err(None)\` is any failure, \`Err(Some(code))\` an \`AgentError\`'s
    /// code.
    fn sample(&self, limit: Option<f64>) -> Result<Vec<Ticker>, Option<String>>;
}

/// \`readLiveSpotTickers\`: the port's rows with a last price; none, a failure or no port is \`no_live_tickers\`, an
/// unpublished page size \`tickers_limit_unset\`.
fn live_tickers(
    port: Option<&dyn SpotTickers>,
    limit: Option<f64>,
) -> Result<Vec<Ticker>, &'static str> {
    let Some(port) = port else {
        return Err("no_live_tickers");
    };
    match port.sample(limit) {
        Ok(rows) => {
            let live: Vec<Ticker> = rows
                .into_iter()
                .filter(|r| r.last.as_deref().is_some_and(|l| !js_trim(l).is_empty()))
                .collect();
            if live.is_empty() {
                Err("no_live_tickers")
            } else {
                Ok(live)
            }
        }
        Err(Some(code)) if code == "agents.tickers_limit_unset" => Err("tickers_limit_unset"),
        Err(_) => Err("no_live_tickers"),
    }
}

/// The run's refusal fields: the reason, its key, the residual when P0-11 refused, and the two counts.
fn run_refusal(
    reason: &str,
    key: &str,
    residual: bool,
    by_tool: usize,
    by_guardrail: usize,
) -> Vec<(String, Json)> {
    let mut f = refusal(reason, key);
    if residual {
        f.push(pair("residual", Json::str(RESIDUAL)));
    }
    f.push(pair("tickersRefusedByTool", count(by_tool)));
    f.push(pair("tickersRefusedByGuardrail", count(by_guardrail)));
    f
}

/// \`runScannerRankSession\`: the free refusals before any session, then each ticker through \`act\` and the pure ranker,
/// settled and closed on every path.
fn run_session(cx: &Cx<'_>, law: Option<&Law>) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let asset = cx.fee_asset_id();
    let free = |f: Vec<(String, Json)>| {
        let mut f = f;
        f.push(pair("metering", unmetered(asset)));
        Ok(Json::Object(f))
    };
    let signal_law = input.get("signalInputsLaw");
    if let Err(reason) = inputs_gate(signal_law) {
        return free(run_refusal(
            reason,
            "agents.scanner.signal_inputs_closed",
            true,
            0,
            0,
        ));
    }
    let plane = input.get("plane").as_str().unwrap_or("");
    if plane == "dark" {
        return free(run_refusal("market_plane_dark", UNAVAILABLE, false, 0, 0));
    }
    let tier = match tier_gate(law, cx.tier()) {
        Ok(t) => t,
        Err(reason) => return free(run_refusal(reason, TIER_CLOSED, false, 0, 0)),
    };
    if !tier.allowed_tools.iter().any(|t| t == TICKER_TOOL) {
        return free(run_refusal("tier_not_granted", TIER_CLOSED, false, 0, 0));
    }
    let mut tickers = Ticker::list(input.get("tickers"));
    if plane == "live" {
        match live_tickers(
            cx.ports.spot_tickers.as_deref(),
            input.get("tickersLimit").as_number(),
        ) {
            Ok(rows) => tickers = rows,
            Err("tickers_limit_unset") => {
                return free(run_refusal(
                    "tickers_limit_unset",
                    "agents.scanner.tickers_limit_unset",
                    false,
                    0,
                    0,
                ));
            }
            Err(_) => return free(run_refusal("no_live_tickers", UNAVAILABLE, false, 0, 0)),
        }
    }
    if tickers.is_empty() {
        return free(empty());
    }

    let now = cx.now_of("now");
    let x = cx.x()?;
    metered_run(&x, cx.user(), AGENT_ID, asset, |session_id| {
        let mut accepted = Vec::new();
        let mut by_tool = 0;
        let mut by_guardrail = 0;
        for t in &tickers {
            let call = ToolCall {
                tool: TICKER_TOOL,
                plane,
                law,
                user_tier: cx.tier(),
                now,
                ticker: Some(t),
                markets: None,
                book_top: None,
            };
            let done = act(
                &x,
                &ActInput {
                    session_id,
                    tool: TICKER_TOOL,
                    ..ActInput::default()
                },
                || invoke_data_tool(&call),
            );
            let result = match done {
                Ok(a) => a.result,
                Err(e) if is_refused(&e) => {
                    by_guardrail += 1;
                    continue;
                }
                Err(e) => return Err(e),
            };
            match accepted_ticker(&result, t) {
                Some(a) => accepted.push(a),
                None => by_tool += 1,
            }
        }
        if accepted.is_empty() {
            return Ok(Json::Object(run_refusal(
                "no_live_tickers",
                UNAVAILABLE,
                false,
                by_tool,
                by_guardrail,
            )));
        }
        let ranked = rank_fixtures(
            &accepted,
            &RankOptions {
                now,
                limit: Some(tier.max_signals),
                market_plane: Some(plane),
                allowlist: allowlist(input.get("marketAllowlist")),
                law: signal_law,
            },
        );
        Ok(match ranked {
            Ranked::Ok {
                signals,
                ranked_at,
                considered,
                skipped_stale,
                skipped_incomplete,
            } => {
                let mut f = ok_head(
                    signals,
                    ranked_at,
                    considered,
                    skipped_stale,
                    skipped_incomplete,
                );
                f.push(pair("maxSignals", Json::Number(tier.max_signals)));
                f.push(pair("userTier", Json::str(tier.user_tier.clone())));
                f.push(pair("tickersAccepted", count(accepted.len())));
                f.push(pair("tickersRefusedByTool", count(by_tool)));
                f.push(pair("tickersRefusedByGuardrail", count(by_guardrail)));
                Json::Object(f)
            }
            Ranked::Other(mut fields) => {
                if fields.first().and_then(|(_, v)| json_str(v)) == Some("refuse") {
                    fields.push(pair("tickersRefusedByTool", count(by_tool)));
                    fields.push(pair("tickersRefusedByGuardrail", count(by_guardrail)));
                }
                Json::Object(fields)
            }
        })
    })
}

// ── The live port ──────────────────────────────────────────────────────────

/// \`createHttpSpotTickersPort\`: svc-trade's public \`GET /api/v1/tickers?limit=\`, each row mapped to a ticker whose
/// rows age out after \`max_age_ms\` (60 s unless set). A page size that is not set refuses as
/// \`agents.tickers_limit_unset\`; a row whose symbol, last price or shape is wrong is left out, never filled.
pub struct SpotTickersHttp {
    pub trade_url: String,
    pub fetch: std::sync::Arc<dyn service_kit::http::Fetch>,
    pub max_age_ms: f64,
    pub limit: Option<f64>,
}

impl SpotTickersHttp {
    pub fn new(
        trade_url: &str,
        fetch: std::sync::Arc<dyn service_kit::http::Fetch>,
    ) -> SpotTickersHttp {
        SpotTickersHttp {
            trade_url: trade_url.strip_suffix('/').unwrap_or(trade_url).to_owned(),
            fetch,
            max_age_ms: 60_000.0,
            limit: None,
        }
    }
}

/// \`symbolToScannerMarketId\`: trimmed, lower case, the first \`/\` a \`-\`.
pub fn market_id_of(symbol: &str) -> String {
    js_trim(symbol).to_lowercase().replacen('/', "-", 1)
}

/// \`percentageToChangeBps\`: \`Math.round(Number(p) * 100)\`; blank or not a finite number is none.
#[expect(
    clippy::float_arithmetic,
    reason = "a percentage to basis points, never money, as the TypeScript does in doubles"
)]
fn change_bps(p: Option<&str>) -> Option<f64> {
    let p = p.filter(|p| !js_trim(p).is_empty())?;
    let n = service_kit::env::js_number(p).filter(|n| n.is_finite())?;
    Some(super::js::math_round(n * 100.0))
}

/// \`mapTicker\`: none for a row the wire shape refuses, another symbol's row, or one with no last price; an invalid
/// time stops the read, as \`toISOString\` throws there.
fn map_ticker(symbol: &str, raw: &Json, max_age_ms: f64) -> Result<Option<Ticker>, String> {
    let Json::Object(_) = raw else {
        return Ok(None);
    };
    let nullable = |k: &str| match raw.get(k) {
        Some(Json::String(s)) => Some(Some(s.clone())),
        Some(Json::Null) => Some(None),
        _ => None,
    };
    let (Some(Json::String(row_symbol)), Some(Json::Number(ts))) =
        (raw.get("symbol"), raw.get("timestamp"))
    else {
        return Ok(None);
    };
    let (Some(last), Some(quote), Some(base), Some(pct)) = (
        nullable("last"),
        nullable("quoteVolume"),
        nullable("baseVolume"),
        nullable("percentage"),
    ) else {
        return Ok(None);
    };
    if market_id_of(row_symbol) != market_id_of(symbol) {
        return Ok(None);
    }
    let Some(last) = last.filter(|l| !js_trim(l).is_empty()) else {
        return Ok(None);
    };
    let at = service_kit::time::time_clip(*ts).ok_or_else(|| "Invalid time value".to_owned())?;
    Ok(Some(Ticker {
        market_id: market_id_of(symbol),
        last: Some(last),
        volume24h: quote.or(base),
        change24h_bps: change_bps(pct.as_deref()),
        as_of: Instant(at).iso(),
        max_age_ms,
    }))
}

/// \`assertTickersPageLimit\`: a finite number, floored, at least 1.
fn page_limit(limit: Option<f64>) -> Option<f64> {
    let n = limit.filter(|l| l.is_finite())?.floor();
    (n >= 1.0).then_some(n)
}

/// \`encodeURIComponent(String(n))\` of a page size: its JavaScript spelling, which needs no escaping but \`+\`.
fn page_text(n: f64) -> String {
    service_kit::json::js_number_string(n).replace('+', "%2B")
}

impl SpotTickers for SpotTickersHttp {
    fn sample(&self, limit: Option<f64>) -> Result<Vec<Ticker>, Option<String>> {
        let Some(page) = page_limit(limit.or(self.limit)) else {
            return Err(Some("agents.tickers_limit_unset".to_owned()));
        };
        let res = self
            .fetch
            .fetch(&service_kit::http::HttpRequest {
                method: "GET".to_owned(),
                url: format!(
                    "{}/api/v1/tickers?limit={}",
                    self.trade_url,
                    page_text(page)
                ),
                headers: vec![("accept".to_owned(), "application/json".to_owned())],
                body: None,
                timeout_ms: None,
                refuse_redirect: false,
            })
            .map_err(|_| None)?;
        if !res.ok() {
            return Err(None);
        }
        let Ok(Json::Object(fields)) = service_kit::json::parse(&res.body) else {
            return Err(None);
        };
        let mut out = Vec::new();
        for (symbol, raw) in service_kit::json::js_key_order(fields) {
            if let Some(t) = map_ticker(&symbol, &raw, self.max_age_ms).map_err(|_| None)? {
                out.push(t);
            }
        }
        Ok(out)
    }
}
