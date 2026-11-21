//! The navigator's pure tools: `guardrail.ts` (the declared toolset and the money denylist), `grounded.ts` and
//! `trade-plane-env.ts` (the plane), `policy.ts` with `money-deny-honesty.ts`, `tier-gate.ts`, `tool-select.ts`,
//! `data-tools.ts` and `action-audit.ts`. None reads or writes anything; each answers as the TypeScript does.

use service_kit::json::Json;
use service_kit::money::parse_amount;
use service_kit::time::{Instant, es_date_at_midnight, zod_datetime};

use crate::runtime::eligibility::Law;
use crate::runtime::guardrails::{Guardrail, is_live_write_tool, parse_guardrail};

/// `TradeDataPlane`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plane {
    Live,
    Dark,
}

/// `effectiveNavigatorTradePlane`: without `TRADE_URL` a caller's `live` is `dark`.
pub fn effective_plane(requested: &str, trade_url: Option<&str>) -> Plane {
    if requested == "dark" || trade_url.is_none_or(|u| u.trim().is_empty()) {
        Plane::Dark
    } else {
        Plane::Live
    }
}

pub const UNAVAILABLE: &str = "agents.navigator.unavailable";
pub const TIER_CLOSED: &str = "agents.navigator.tier_closed";
pub const MARKETS_LIMIT_UNSET: &str = "agents.navigator.markets_limit_unset";
const LIVE_TASKS: [&str; 2] = ["navigator.plan", "navigator.tool_select"];

/// `NAVIGATOR_MONEY_WRITE_TOOLS`.
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

/// `NAVIGATOR_DATA_TOOLS`.
pub const DATA_TOOLS: [&str; 3] = ["trade.quote", "trade.markets.list", "identity.session.read"];

/// `navigatorAgentGuardrail()`: plan and tool_select with the three read tools.
pub fn guardrail() -> Guardrail {
    let tool = |name: &str, module: &str| {
        Json::obj([
            ("name", Json::str(name)),
            ("module", Json::str(module)),
            ("mode", Json::str("read")),
        ])
    };
    let strings = |l: &[&str]| Json::Array(l.iter().map(|s| Json::str(*s)).collect());
    let raw = Json::obj([
        ("agentId", Json::str("navigator")),
        ("version", Json::int(1)),
        ("capacityMode", Json::str("research_only")),
        (
            "tools",
            Json::Array(vec![
                tool("trade.quote", "trade"),
                tool("trade.markets.list", "trade"),
                tool("identity.session.read", "identity"),
            ]),
        ),
        (
            "limits",
            Json::obj([
                ("maxActionsPerSession", Json::int(60)),
                ("maxOutputTokensPerCall", Json::int(4096)),
                ("maxSpendPerSession", Json::str("1")),
                ("allowedModules", strings(&["trade", "identity", "agents"])),
                ("allowedTasks", strings(&LIVE_TASKS)),
            ]),
        ),
    ]);
    #[allow(
        clippy::expect_used,
        reason = "a fixed guardrail the parser's own tests hold"
    )]
    parse_guardrail(&raw).expect("the navigator's guardrail parses")
}

/// `isNavigatorMoneyWriteTool`.
pub fn is_money_write_tool(tool: &str) -> bool {
    MONEY_WRITE_TOOLS.contains(&tool) || is_live_write_tool(tool)
}

/// `navigatorDeclaredTools()`.
pub fn declared_tools() -> Vec<String> {
    guardrail().tools.into_iter().map(|t| t.name).collect()
}

fn strings(l: &[&str]) -> Json {
    Json::Array(l.iter().map(|s| Json::str(*s)).collect())
}

/// `navigator.policy`: `describeNavigatorPolicy()`.
pub fn policy() -> Json {
    let has = |t: &str| Json::int(i64::from(MONEY_WRITE_TOOLS.contains(&t)));
    let count = i64::try_from(MONEY_WRITE_TOOLS.len()).unwrap_or(0);
    let flag = |t: &str| i64::from(MONEY_WRITE_TOOLS.contains(&t));
    let (lp, to, bt) = (
        flag("ledger.post"),
        flag("trade.order"),
        flag("bank.transfer"),
    );
    Json::obj([
        ("moneyWriteTools", strings(&MONEY_WRITE_TOOLS)),
        (
            "moneyDeny",
            Json::obj([
                ("tools", Json::int(count)),
                ("hasLedgerPost", has("ledger.post")),
                ("hasTradeOrder", has("trade.order")),
                ("hasBankTransfer", has("bank.transfer")),
            ]),
        ),
        (
            "moneyDenyStatusLine",
            Json::str(format!(
                "tools={count} ledger_post={lp} trade_order={to} bank_transfer={bt}"
            )),
        ),
        (
            "moneyDenyExport",
            Json::str(format!(
                "tools,ledger_post,trade_order,bank_transfer\n{count},{lp},{to},{bt}"
            )),
        ),
        ("moneyDenyBilledAmount", Json::str("0")),
        (
            "darkPlaneRefuse",
            Json::obj([
                ("reason", Json::str("trade_plane_dark")),
                ("userMessageKey", Json::str(UNAVAILABLE)),
            ]),
        ),
        ("liveAllowedTasks", strings(&LIVE_TASKS)),
    ])
}

/// `navigator.grounded`: `navigatorGrounded(plane)` as the route answers it.
pub fn grounded(plane: Plane) -> Json {
    match plane {
        Plane::Live => Json::obj([
            ("status", Json::str("ok")),
            ("plane", Json::str("live")),
            ("allowedTasks", strings(&LIVE_TASKS)),
        ]),
        Plane::Dark => Json::obj([
            ("status", Json::str("refuse")),
            ("plane", Json::str("dark")),
            ("reason", Json::str("trade_plane_dark")),
            ("userMessageKey", Json::str(UNAVAILABLE)),
        ]),
    }
}

/// `navigator.stage1Guardrail`: the declared toolset and ceilings, as the route's output keeps them.
pub fn stage1_guardrail() -> Json {
    let g = guardrail();
    Json::obj([
        ("agentId", Json::str(g.agent_id.clone())),
        ("version", Json::int(g.version)),
        (
            "tools",
            Json::Array(
                g.tools
                    .iter()
                    .map(|t| {
                        let mut fields = vec![
                            ("name".to_owned(), Json::str(t.name.clone())),
                            ("module".to_owned(), Json::str(t.module.clone())),
                            ("mode".to_owned(), Json::str(t.mode.clone())),
                            (
                                "requiresApproval".to_owned(),
                                Json::Bool(t.requires_approval),
                            ),
                        ];
                        if let Some(n) = t.max_calls_per_session {
                            fields.push(("maxCallsPerSession".to_owned(), Json::int(n)));
                        }
                        Json::Object(fields)
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
                (
                    "allowedModules",
                    Json::Array(
                        g.limits
                            .allowed_modules
                            .iter()
                            .map(|s| Json::str(s.clone()))
                            .collect(),
                    ),
                ),
                (
                    "allowedTasks",
                    Json::Array(
                        g.limits
                            .allowed_tasks
                            .iter()
                            .map(|s| Json::str(s.clone()))
                            .collect(),
                    ),
                ),
            ]),
        ),
    ])
}

/// `navigatorTierGate`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TierGate {
    Ok {
        user_tier: String,
        allowed_tools: Vec<String>,
    },
    /// `tier_law_blank` or `tier_not_granted`, always `agents.navigator.tier_closed`.
    Refuse(&'static str),
}

/// `navigatorTierGate`: an unpublished or empty matrix refuses everyone; a tier it does not name is not granted.
pub fn tier_gate(law: Option<&Law>, user_tier: &str) -> TierGate {
    let tier = user_tier.trim();
    let Some(Law::Published(matrix)) = law else {
        return TierGate::Refuse("tier_law_blank");
    };
    if matrix.is_empty() {
        return TierGate::Refuse("tier_law_blank");
    }
    if tier.is_empty() {
        return TierGate::Refuse("tier_not_granted");
    }
    match matrix.iter().find(|(t, _)| t == tier) {
        Some((_, grant)) => TierGate::Ok {
            user_tier: tier.to_owned(),
            allowed_tools: grant.tools.clone(),
        },
        None => TierGate::Refuse("tier_not_granted"),
    }
}

/// `navigator.tierGate`.
pub fn tier_gate_json(gate: &TierGate) -> Json {
    match gate {
        TierGate::Ok {
            user_tier,
            allowed_tools,
        } => Json::obj([
            ("status", Json::str("ok")),
            ("userTier", Json::str(user_tier.clone())),
            (
                "allowedTools",
                Json::Array(allowed_tools.iter().map(|s| Json::str(s.clone())).collect()),
            ),
        ]),
        TierGate::Refuse(reason) => Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str(*reason)),
            ("userMessageKey", Json::str(TIER_CLOSED)),
        ]),
    }
}

/// `navigator.selectTools`: `selectNavigatorTools` over the declared toolset; the caller's `tools` widen nothing.
pub fn select_tools(plane: Plane, candidates: &[String]) -> Json {
    if plane == Plane::Dark {
        return Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str("trade_plane_dark")),
            ("userMessageKey", Json::str(UNAVAILABLE)),
        ]);
    }
    if candidates.is_empty() {
        return Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str("no_candidates")),
        ]);
    }
    let g = guardrail();
    let mut selected = Vec::new();
    let mut refused = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let refusal = |tool: &str, reason: &str| {
        Json::obj([("tool", Json::str(tool)), ("reason", Json::str(reason))])
    };
    for raw in candidates {
        let tool = service_kit::schema::js_trim(raw);
        if tool.is_empty() || seen.iter().any(|s| s == tool) {
            continue;
        }
        seen.push(tool.to_owned());
        if is_money_write_tool(tool) {
            refused.push(refusal(tool, "money_write"));
            continue;
        }
        match g.tools.iter().find(|t| t.name == tool) {
            None => refused.push(refusal(tool, "not_declared")),
            Some(grant) if grant.mode != "read" => refused.push(refusal(tool, "write_mode")),
            Some(_) => selected.push(Json::str(tool)),
        }
    }
    Json::obj([
        ("status", Json::str("ok")),
        ("selected", Json::Array(selected)),
        ("refused", Json::Array(refused)),
    ])
}

/// `QuoteFixture`.
#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    pub market_id: String,
    pub last: Option<String>,
    pub as_of: String,
    pub max_age_ms: f64,
}

/// `MarketListFixture`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Market {
    pub market_id: String,
    pub symbol: String,
    pub status: String,
}

/// `SessionFixture`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionFixture {
    pub session_id: String,
    pub user_id: String,
    pub status: String,
}

/// `DataToolResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum DataTool {
    Quote {
        market_id: String,
        last: String,
        as_of: String,
    },
    Markets(Vec<Market>),
    Session(SessionFixture),
    Refuse {
        tool: String,
        reason: &'static str,
        key: &'static str,
    },
}

impl DataTool {
    pub fn is_ok(&self) -> bool {
        !matches!(self, DataTool::Refuse { .. })
    }

    /// The tool's name as the result carries it.
    pub fn tool(&self) -> &str {
        match self {
            DataTool::Quote { .. } => "trade.quote",
            DataTool::Markets(_) => "trade.markets.list",
            DataTool::Session(_) => "identity.session.read",
            DataTool::Refuse { tool, .. } => tool,
        }
    }

    /// The result as `JSON.stringify` writes the TypeScript's object, keys in its order.
    pub fn to_json(&self) -> Json {
        match self {
            DataTool::Quote {
                market_id,
                last,
                as_of,
            } => Json::obj([
                ("status", Json::str("ok")),
                ("tool", Json::str("trade.quote")),
                ("marketId", Json::str(market_id.clone())),
                ("last", Json::str(last.clone())),
                ("asOf", Json::str(as_of.clone())),
            ]),
            DataTool::Markets(markets) => Json::obj([
                ("status", Json::str("ok")),
                ("tool", Json::str("trade.markets.list")),
                ("markets", markets_json(markets)),
            ]),
            DataTool::Session(s) => Json::obj([
                ("status", Json::str("ok")),
                ("tool", Json::str("identity.session.read")),
                (
                    "session",
                    Json::obj([
                        ("sessionId", Json::str(s.session_id.clone())),
                        ("userId", Json::str(s.user_id.clone())),
                        ("status", Json::str(s.status.clone())),
                    ]),
                ),
            ]),
            DataTool::Refuse { tool, reason, key } => Json::obj([
                ("status", Json::str("refuse")),
                ("tool", Json::str(tool.clone())),
                ("reason", Json::str(*reason)),
                ("userMessageKey", Json::str(*key)),
            ]),
        }
    }
}

pub fn markets_json(markets: &[Market]) -> Json {
    Json::Array(
        markets
            .iter()
            .map(|m| {
                Json::obj([
                    ("marketId", Json::str(m.market_id.clone())),
                    ("symbol", Json::str(m.symbol.clone())),
                    ("status", Json::str(m.status.clone())),
                ])
            })
            .collect(),
    )
}

/// What one data tool is invoked with.
pub struct DataToolInput<'a> {
    pub tool: &'a str,
    pub plane: Plane,
    pub tier_law: Option<&'a Law>,
    pub user_tier: &'a str,
    pub requester_user_id: &'a str,
    pub now: Instant,
    pub quote: Option<&'a Quote>,
    pub markets: Option<&'a [Market]>,
    pub session: Option<&'a SessionFixture>,
}

/// `parseUnsignedDecimal`: digits with at most 18 decimals, read exactly.
fn unsigned_decimal(s: &str) -> bool {
    let (int, frac) = s.split_once('.').map_or((s, None), |(i, f)| (i, Some(f)));
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || frac.is_some_and(|f| !digits(f) || f.len() > 18) {
        return false;
    }
    parse_amount(s).is_ok_and(|a| a >= 0)
}

/// `Date.parse` for the forms a quote's `asOf` takes: an ISO date-time with `Z` or an offset, or a bare date.
pub fn date_parse(text: &str) -> Option<Instant> {
    zod_datetime(text, true).or_else(|| es_date_at_midnight(text))
}

fn fresh(as_of: &str, max_age_ms: f64, now: Instant) -> bool {
    let Some(t) = date_parse(as_of) else {
        return false;
    };
    #[allow(
        clippy::cast_precision_loss,
        reason = "a millisecond difference, as JavaScript holds it"
    )]
    let age = (now.0 - t.0) as f64;
    age <= max_age_ms && age >= 0.0
}

/// `invokeNavigatorDataTool`: the plane, the tier, the allowlist, then the tool's own checks of its fixture.
pub fn invoke_data_tool(input: &DataToolInput<'_>) -> DataTool {
    let tool = service_kit::schema::js_trim(input.tool).to_owned();
    let refuse = |reason: &'static str, key: &'static str| DataTool::Refuse {
        tool: tool.clone(),
        reason,
        key,
    };
    if is_money_write_tool(&tool) {
        return refuse("money_write", UNAVAILABLE);
    }
    if input.plane == Plane::Dark {
        return refuse("trade_plane_dark", UNAVAILABLE);
    }
    let allowed = match tier_gate(input.tier_law, input.user_tier) {
        TierGate::Refuse(reason) => return refuse(reason, TIER_CLOSED),
        TierGate::Ok { allowed_tools, .. } => allowed_tools,
    };
    if !declared_tools().contains(&tool) || !DATA_TOOLS.contains(&tool.as_str()) {
        return refuse("tool_not_declared", UNAVAILABLE);
    }
    if !allowed.contains(&tool) {
        return refuse("tool_not_in_tier", TIER_CLOSED);
    }
    match tool.as_str() {
        "trade.quote" => {
            let Some(q) = input
                .quote
                .filter(|q| !service_kit::schema::js_trim(&q.market_id).is_empty())
            else {
                return refuse("missing_fixture", UNAVAILABLE);
            };
            let Some(last) = &q.last else {
                return refuse("incomplete_quote", UNAVAILABLE);
            };
            if !unsigned_decimal(last) {
                return refuse("invalid_decimal", UNAVAILABLE);
            }
            if !fresh(&q.as_of, q.max_age_ms, input.now) {
                return refuse("stale", UNAVAILABLE);
            }
            DataTool::Quote {
                market_id: q.market_id.clone(),
                last: last.clone(),
                as_of: q.as_of.clone(),
            }
        }
        "trade.markets.list" => {
            let Some(markets) = input.markets.filter(|m| !m.is_empty()) else {
                return refuse("empty_markets", UNAVAILABLE);
            };
            let blank = |s: &str| service_kit::schema::js_trim(s).is_empty();
            if markets
                .iter()
                .any(|m| blank(&m.market_id) || blank(&m.symbol))
            {
                return refuse("missing_fixture", UNAVAILABLE);
            }
            DataTool::Markets(markets.to_vec())
        }
        _ => {
            let Some(s) = input.session else {
                return refuse("no_live_session", UNAVAILABLE);
            };
            let blank = |s: &str| service_kit::schema::js_trim(s).is_empty();
            if blank(&s.session_id) || blank(&s.user_id) {
                return refuse("incomplete_session", UNAVAILABLE);
            }
            if blank(input.requester_user_id) || s.user_id != input.requester_user_id {
                return refuse("subject_mismatch", UNAVAILABLE);
            }
            DataTool::Session(s.clone())
        }
    }
}

/// `auditNavigatorDataTool(emptyNavigatorAuditLog(), result, occurredAt)`'s one entry, as the route answers it.
pub fn audit_entry(result: &DataTool, occurred_at: &str) -> Json {
    let (status, reason, key) = match result {
        DataTool::Refuse { reason, key, .. } => ("refused", Json::str(*reason), *key),
        _ => ("executed", Json::Null, "agents.action.executed"),
    };
    Json::obj([
        ("sequence", Json::int(0)),
        ("kind", Json::str("tool_call")),
        ("status", Json::str(status)),
        ("tool", Json::str(result.tool())),
        ("reason", reason),
        ("userMessageKey", Json::str(key)),
        ("occurredAt", Json::str(occurred_at)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::eligibility::Grant;

    fn law(tier: &str, tools: &[&str]) -> Law {
        Law::Published(vec![(
            tier.to_owned(),
            Grant {
                max_signals: None,
                tools: tools.iter().map(|t| (*t).to_owned()).collect(),
            },
        )])
    }

    #[test]
    fn the_plane_is_dark_without_a_trade_url_whatever_the_caller_asks() {
        assert_eq!(effective_plane("live", None), Plane::Dark);
        assert_eq!(effective_plane("live", Some("  ")), Plane::Dark);
        assert_eq!(effective_plane("dark", Some("http://trade")), Plane::Dark);
        assert_eq!(effective_plane("live", Some("http://trade")), Plane::Live);
    }

    #[test]
    fn the_tier_gate_refuses_closed_until_a_matrix_grants_the_tier() {
        assert_eq!(tier_gate(None, "pro"), TierGate::Refuse("tier_law_blank"));
        assert_eq!(
            tier_gate(Some(&Law::Unpublished), "pro"),
            TierGate::Refuse("tier_law_blank")
        );
        assert_eq!(
            tier_gate(Some(&Law::Published(vec![])), "pro"),
            TierGate::Refuse("tier_law_blank")
        );
        let l = law("pro", &["trade.quote"]);
        assert_eq!(
            tier_gate(Some(&l), " "),
            TierGate::Refuse("tier_not_granted")
        );
        assert_eq!(
            tier_gate(Some(&l), "free"),
            TierGate::Refuse("tier_not_granted")
        );
        assert_eq!(
            tier_gate(Some(&l), " pro "),
            TierGate::Ok {
                user_tier: "pro".into(),
                allowed_tools: vec!["trade.quote".into()]
            }
        );
    }

    #[test]
    fn tool_select_never_selects_a_money_write_an_undeclared_or_a_repeated_tool() {
        let c = |l: &[&str]| l.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            select_tools(
                Plane::Live,
                &c(&["trade.quote", " trade.quote", "ledger.post", "x.y", ""])
            )
            .compact(),
            r#"{"status":"ok","selected":["trade.quote"],"refused":[{"tool":"ledger.post","reason":"money_write"},{"tool":"x.y","reason":"not_declared"}]}"#
        );
        assert_eq!(
            select_tools(Plane::Live, &[]).compact(),
            r#"{"status":"refuse","reason":"no_candidates"}"#
        );
    }

    #[test]
    fn a_data_tool_refuses_what_it_cannot_ground_and_echoes_only_what_it_was_given() {
        let l = law(
            "pro",
            &[
                "trade.quote",
                "trade.markets.list",
                "identity.session.read",
                "trade.order",
            ],
        );
        let now = zod_datetime("2026-11-21T00:00:10Z", false).unwrap_or(Instant(0));
        let q = |last: Option<&str>, as_of: &str| Quote {
            market_id: "btc-usdt".into(),
            last: last.map(str::to_owned),
            as_of: as_of.into(),
            max_age_ms: 60_000.0,
        };
        let run = |tool: &str, quote: Option<&Quote>| {
            invoke_data_tool(&DataToolInput {
                tool,
                plane: Plane::Live,
                tier_law: Some(&l),
                user_tier: "pro",
                requester_user_id: "u1",
                now,
                quote,
                markets: None,
                session: None,
            })
        };
        let reason = |r: DataTool| match r {
            DataTool::Refuse { reason, .. } => reason,
            _ => "ok",
        };
        assert_eq!(reason(run("trade.order", None)), "money_write");
        assert_eq!(reason(run("trade.quote", None)), "missing_fixture");
        assert_eq!(
            reason(run("trade.quote", Some(&q(None, "2026-11-21T00:00:00Z")))),
            "incomplete_quote"
        );
        assert_eq!(
            reason(run(
                "trade.quote",
                Some(&q(Some("-1"), "2026-11-21T00:00:00Z"))
            )),
            "invalid_decimal"
        );
        assert_eq!(
            reason(run(
                "trade.quote",
                Some(&q(Some("1.5"), "2026-11-20T00:00:00Z"))
            )),
            "stale"
        );
        assert_eq!(
            reason(run(
                "trade.quote",
                Some(&q(Some("1.5"), "2026-11-21T00:00:20Z"))
            )),
            "stale"
        );
        assert_eq!(
            reason(run(
                "trade.quote",
                Some(&q(Some("1.5"), "2026-11-21T00:00:00Z"))
            )),
            "ok"
        );
        assert_eq!(reason(run("trade.markets.list", None)), "empty_markets");
        assert_eq!(
            reason(run("identity.session.read", None)),
            "no_live_session"
        );
        assert_eq!(reason(run("scanner.rank", None)), "tool_not_declared");
    }
}
