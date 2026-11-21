//! `support.*` (`router.ts` `support`, `support-agent/`): the support desk's policy, its comment draft gate, its desk
//! plane gate, its Stage-1 guardrail, its tier gate, its three read-only desk tools, the typed "I don't know", and the
//! metered `support.reply` run.
//!
//! Nothing here invents an answer, an article, a ticket or an account state: a dark desk, a blank tier law, a missing
//! row, somebody else's row or an unreachable desk is a typed refusal, and a KB that refused or missed escalates to a
//! person. The account projection is status and KYC tier only; no balance crosses it. The live reads go through the
//! desk port ([`Desk`], [`DeskHttp`]: svc-support's KB and ticket reads, svc-identity's account projection).
//!
//! What the TypeScript holds that no call reaches is left out: `invokeSupportDataTool`'s fixture branch (every call
//! gives it a live plane, as a dark one refuses first, and a live plane without a desk refuses `no_live_kb`), the
//! fixture articles and account a run's ask resolves to (the desk reads its own), and the board cards and status lines
//! no answer carries. The desk port's `getKb` and `commentTicket` serve the own agents' calls and come with them.

use std::sync::{Arc, OnceLock};

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::jsregex::Regex;
use service_kit::money::js_trim;
use service_kit::s2s::CallSigner;
use service_kit::schema::{Outcome, Refiner, Schema, Value};

use super::{Cx, is_refused, metered_run, strings, unmetered, with_field};
use crate::runtime::RunError;
use crate::runtime::act::{ActInput, act};
use crate::runtime::eligibility::Law;
use crate::runtime::guardrails::{Guardrail, is_live_write_tool, parse_guardrail};

/// `SUPPORT_AGENT_ID`.
pub const AGENT_ID: &str = "support";
/// `SUPPORT_KB_TOOL`: the one tool a grounded reply can cite.
pub const KB_TOOL: &str = "support.kb.search";
const TICKET_TOOL: &str = "support.ticket.read";
const ACCOUNT_TOOL: &str = "identity.account.read";

/// `SUPPORT_MONEY_TOOLS`: never granted on the support agent.
pub const MONEY_TOOLS: [&str; 12] = [
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

/// `SUPPORT_DATA_TOOLS`.
pub const DATA_TOOLS: [&str; 3] = [KB_TOOL, TICKET_TOOL, ACCOUNT_TOOL];

/// `liveAllowedTasks`, the tasks a live desk plane allows.
const TASKS: [&str; 2] = ["support.classify", "support.reply"];

const UNAVAILABLE: &str = "agents.support.unavailable";
const TIER_CLOSED: &str = "agents.support.tier_closed";
const ESCALATED: &str = "agents.support.escalated";
const COMMENT_REFUSED: &str = "agents.support.comment_refused";
const LIMIT_UNSET: &str = "agents.refused.kb_search_limit_unset";

/// `supportAgentGuardrail()`: the reads, and the ticket comment as an approval-gated write.
pub fn guardrail() -> Result<Guardrail, RunError> {
    let spec = json::parse(
        r#"{"agentId":"support","version":3,"capacityMode":"research_only",
            "tools":[{"name":"support.ticket.read","module":"support","mode":"read"},
                     {"name":"support.kb.search","module":"support","mode":"read"},
                     {"name":"identity.account.read","module":"identity","mode":"read"},
                     {"name":"support.ticket.comment","module":"support","mode":"write","requiresApproval":true,"maxCallsPerSession":20}],
            "limits":{"maxActionsPerSession":40,"maxOutputTokensPerCall":2048,"maxSpendPerSession":"0.5",
                      "allowedModules":["support","identity"],"allowedTasks":["support.classify","support.reply"]}}"#,
    )
    .map_err(|e| RunError::Other(e.message))?;
    parse_guardrail(&spec).map_err(|e| RunError::Other(e.0))
}

/// `isSupportMoneyTool`.
pub fn is_money_tool(tool: &str) -> bool {
    MONEY_TOOLS.contains(&tool) || is_live_write_tool(tool)
}

// ── Values ─────────────────────────────────────────────────────────────────

/// `KbArticleFixture`: i18n keys, never prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Article {
    pub article_key: String,
    pub title_key: String,
    pub body_key: String,
}

/// `TicketFixture`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub ticket_id: String,
    pub owner_user_id: String,
    pub status: String,
    pub category: String,
}

/// `AccountProjectionFixture`: status and KYC tier only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub user_id: String,
    pub status: String,
    pub kyc_tier: String,
}

/// `SupportDataToolResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolResult {
    Kb(Vec<Article>),
    Ticket(Ticket),
    Account(Account),
    Refuse {
        tool: String,
        reason: String,
        key: &'static str,
    },
}

impl ToolResult {
    fn refuse(tool: &str, reason: &str, key: &'static str) -> ToolResult {
        ToolResult::Refuse {
            tool: tool.to_owned(),
            reason: reason.to_owned(),
            key,
        }
    }

    fn unavailable(tool: &str, reason: &str) -> ToolResult {
        ToolResult::refuse(tool, reason, UNAVAILABLE)
    }

    /// The tool's answer, in the order the TypeScript builds it (and the outputs declare it).
    pub fn to_json(&self) -> Json {
        let ok = |tool: &str, key: &str, v: Json| {
            Json::obj([
                ("status", Json::str("ok")),
                ("tool", Json::str(tool)),
                (key, v),
            ])
        };
        match self {
            ToolResult::Kb(articles) => ok(
                KB_TOOL,
                "articles",
                Json::Array(
                    articles
                        .iter()
                        .map(|a| {
                            Json::obj([
                                ("articleKey", Json::str(a.article_key.clone())),
                                ("titleKey", Json::str(a.title_key.clone())),
                                ("bodyKey", Json::str(a.body_key.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
            ToolResult::Ticket(t) => ok(
                TICKET_TOOL,
                "ticket",
                Json::obj([
                    ("ticketId", Json::str(t.ticket_id.clone())),
                    ("ownerUserId", Json::str(t.owner_user_id.clone())),
                    ("status", Json::str(t.status.clone())),
                    ("category", Json::str(t.category.clone())),
                ]),
            ),
            ToolResult::Account(a) => ok(ACCOUNT_TOOL, "account", account_json(a)),
            ToolResult::Refuse { tool, reason, key } => Json::obj([
                ("status", Json::str("refuse")),
                ("tool", Json::str(tool.clone())),
                ("reason", Json::str(reason.clone())),
                ("userMessageKey", Json::str(*key)),
            ]),
        }
    }

    fn tool(&self) -> &str {
        match self {
            ToolResult::Kb(_) => KB_TOOL,
            ToolResult::Ticket(_) => TICKET_TOOL,
            ToolResult::Account(_) => ACCOUNT_TOOL,
            ToolResult::Refuse { tool, .. } => tool,
        }
    }
}

fn account_json(a: &Account) -> Json {
    Json::obj([
        ("userId", Json::str(a.user_id.clone())),
        ("status", Json::str(a.status.clone())),
        ("kycTier", Json::str(a.kyc_tier.clone())),
    ])
}

// ── The pure gates ─────────────────────────────────────────────────────────

/// `supportGrounded`: a dark desk, a dark KB, or a required KB without hits refuses.
fn grounded(
    plane: &str,
    kb_plane: Option<&str>,
    kb_hit_count: Option<f64>,
    require_kb: bool,
) -> Result<(), &'static str> {
    if plane == "dark" {
        return Err("desk_plane_dark");
    }
    if kb_plane == Some("dark") {
        return Err("kb_empty");
    }
    if require_kb && kb_hit_count.unwrap_or(0.0) <= 0.0 {
        return Err("kb_empty");
    }
    Ok(())
}

/// `supportTierGate`: blank or unpublished law, an empty matrix, no tier or no grant refuse.
fn tier_gate(law: Option<&Law>, user_tier: &str) -> Result<(String, Vec<String>), &'static str> {
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
    Ok((tier.to_owned(), grant.tools.clone()))
}

/// `assertKbSearchPageLimit`: a finite number, floored, at least 1, at most 500; else none (the named refusal).
fn kb_page(limit: Option<f64>) -> Option<f64> {
    let n = limit.filter(|l| l.is_finite())?.floor();
    (n >= 1.0).then_some(n.min(500.0))
}

/// `isKeyLike`: `/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i` over the trimmed value.
fn is_key_like(value: &str) -> bool {
    let v = js_trim(value);
    let mut segments = 0;
    for part in v.split(['.', '_', '-']) {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return false;
        }
        segments += 1;
    }
    segments >= 2
}

const MONEY_STEMS: [&str; 11] = [
    "balance",
    "available",
    "amount",
    "hold",
    "credit",
    "debit",
    "equity",
    "pnl",
    "funds",
    "wallet",
    "reserved",
];

/// `keyIsInventMoney`: a money stem at the start (followed by `_`, the end or a capital), as a later camel hump, or
/// `balance`/`amount` anywhere.
fn key_is_invent_money(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if lower.contains("balance") || lower.contains("amount") {
        return true;
    }
    if let Some(stem) = MONEY_STEMS.iter().find(|s| lower.starts_with(**s)) {
        // The stems are ASCII, so the next UTF-16 unit is the next byte when it is ASCII.
        match key.as_bytes().get(stem.len()) {
            None | Some(b'_' | b'A'..=b'Z') => return true,
            _ => {}
        }
    }
    let bytes = key.as_bytes();
    MONEY_STEMS.iter().any(|stem| {
        let mut hump = (*stem).to_owned();
        if let Some(first) = hump.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        key.match_indices(hump.as_str()).any(|(at, _)| {
            let before = at.checked_sub(1).and_then(|i| bytes.get(i));
            let after = bytes.get(at + hump.len());
            before.is_some_and(u8::is_ascii_lowercase) && after.is_none_or(u8::is_ascii_uppercase)
        })
    })
}

/// `accountProjectionHasInventMoney`.
fn has_invent_money<'k>(keys: impl IntoIterator<Item = &'k str>) -> bool {
    keys.into_iter().any(key_is_invent_money)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `MONEY_INVENT`, matched on the ASCII-lowercased text (its `i` flag folds nothing outside ASCII onto its letters).
fn money_invent_language(body: &str) -> bool {
    static MONEY_INVENT: OnceLock<Option<Regex>> = OnceLock::new();
    MONEY_INVENT
        .get_or_init(|| {
            Regex::new(
                r"/\b(i (have )?refunded|balance (is|now) \d+|credited \$?\d+|wired \$?\d+|sent you \$?\d+|payout of)\b/",
            )
            .ok()
        })
        .as_ref()
        // A pattern the matcher could not read refuses the draft rather than letting it through.
        .is_none_or(|r| r.test(&body.to_ascii_lowercase()))
}

/// `draftTicketComment`.
fn draft_comment(ticket_id: Option<&str>, body: Option<&str>) -> Json {
    let refuse = |reason: &str| {
        Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str(reason)),
            ("userMessageKey", Json::str(COMMENT_REFUSED)),
        ])
    };
    let ticket_id = js_trim(ticket_id.unwrap_or(""));
    if ticket_id.is_empty() {
        return refuse("missing_ticket");
    }
    let body = js_trim(body.unwrap_or(""));
    if body.is_empty() {
        return refuse("empty_body");
    }
    if utf16_len(body) > 4_000 {
        return refuse("body_too_long");
    }
    if money_invent_language(body) {
        return refuse("money_invent_language");
    }
    Json::obj([
        ("status", Json::str("ok")),
        ("ticketId", Json::str(ticket_id)),
        ("body", Json::str(body)),
    ])
}

// ── The desk ───────────────────────────────────────────────────────────────

/// `DeskSearchResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    Ok(Vec<Article>),
    Unreachable,
    /// `{ status: 'refuse', reason: 'kb_search_limit_unset' }`.
    LimitUnset,
}

/// `DeskTicketResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TicketRead {
    Ok(Ticket),
    Missing,
    Unreachable,
}

/// `DeskAccountResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountRead {
    Ok(Account),
    Unread,
    Unreachable,
}

/// `SupportDeskPort`: svc-support's KB and ticket reads, and svc-identity's account projection. A failure the desk
/// already names is a result; an error is the TypeScript's throw.
pub trait Desk: Send + Sync {
    /// `searchKb(query, limit)`: an unset page size refuses by name; no hits is `Ok([])`.
    fn search_kb(&self, query: &str, limit: Option<f64>) -> Result<Found, RunError>;
    /// `readTicket(ticketId, headers)`, as the person (`headers` forward their signed principal).
    fn read_ticket(
        &self,
        ticket_id: &str,
        headers: &[(String, String)],
    ) -> Result<TicketRead, RunError>;
    /// `readAccount(userId)`.
    fn read_account(&self, user_id: &str) -> Result<AccountRead, RunError>;
}

/// What `invokeSupportDataTool` is handed.
pub struct ToolCall<'a> {
    pub tool: &'a str,
    pub plane: &'a str,
    pub kb_plane: Option<&'a str>,
    pub requester: &'a str,
    pub law: Option<&'a Law>,
    pub user_tier: &'a str,
    pub desk: Option<&'a dyn Desk>,
    pub desk_headers: &'a [(String, String)],
    pub kb_query: &'a str,
    pub limit: Option<f64>,
    /// `ticket?.ticketId`.
    pub ticket_id: Option<&'a str>,
}

/// `invokeSupportDataTool`: one declared read behind the money denylist, the desk plane, the tier, the declared set
/// and the tier's own tools, read from the desk.
pub fn invoke_data_tool(c: &ToolCall<'_>) -> Result<ToolResult, RunError> {
    let tool = js_trim(c.tool);
    if is_money_tool(tool) {
        return Ok(ToolResult::unavailable(tool, "money_tool"));
    }
    if let Err(reason) = grounded(c.plane, c.kb_plane, None, false) {
        return Ok(ToolResult::unavailable(tool, reason));
    }
    let allowed = match tier_gate(c.law, c.user_tier) {
        Ok((_, allowed)) => allowed,
        Err(reason) => return Ok(ToolResult::refuse(tool, reason, TIER_CLOSED)),
    };
    let declared = guardrail()?.tools.iter().any(|t| t.name == tool);
    if !declared || !DATA_TOOLS.contains(&tool) {
        return Ok(ToolResult::unavailable(tool, "tool_not_declared"));
    }
    if !allowed.iter().any(|t| t == tool) {
        return Ok(ToolResult::refuse(tool, "tool_not_in_tier", TIER_CLOSED));
    }
    let requester = js_trim(c.requester);
    if requester.is_empty() {
        return Ok(ToolResult::unavailable(tool, "missing_requester"));
    }
    // The plane is live here (a dark one refused above), and a live plane reads only the desk.
    let Some(desk) = c.desk else {
        return Ok(ToolResult::unavailable(tool, "no_live_kb"));
    };
    via_desk(tool, requester, desk, c)
}

/// `invokeViaDesk`.
fn via_desk(
    tool: &str,
    requester: &str,
    desk: &dyn Desk,
    c: &ToolCall<'_>,
) -> Result<ToolResult, RunError> {
    let unavailable = |reason: &str| Ok(ToolResult::unavailable(tool, reason));
    if tool == KB_TOOL {
        let Some(page) = kb_page(c.limit) else {
            return Ok(ToolResult::refuse(
                tool,
                "kb_search_limit_unset",
                LIMIT_UNSET,
            ));
        };
        return match desk.search_kb(c.kb_query, Some(page))? {
            Found::LimitUnset => Ok(ToolResult::refuse(
                tool,
                "kb_search_limit_unset",
                LIMIT_UNSET,
            )),
            Found::Unreachable => unavailable("no_live_kb"),
            Found::Ok(articles) => {
                if articles.is_empty() {
                    return unavailable("kb_empty");
                }
                if articles.iter().any(|a| {
                    !is_key_like(&a.article_key)
                        || !is_key_like(&a.title_key)
                        || !is_key_like(&a.body_key)
                }) {
                    return unavailable("incomplete_article");
                }
                Ok(ToolResult::Kb(articles))
            }
        };
    }

    if tool == TICKET_TOOL {
        let ticket_id = js_trim(c.ticket_id.unwrap_or(""));
        if ticket_id.is_empty() {
            return unavailable("missing_fixture");
        }
        let ticket = match desk.read_ticket(ticket_id, c.desk_headers)? {
            TicketRead::Unreachable => return unavailable("no_live_kb"),
            TicketRead::Missing => return unavailable("missing_fixture"),
            TicketRead::Ok(t) => t,
        };
        let port_id = js_trim(&ticket.ticket_id);
        if port_id.is_empty() {
            return unavailable("incomplete_ticket");
        }
        if port_id != ticket_id {
            return unavailable("missing_fixture");
        }
        if js_trim(&ticket.category).is_empty() || js_trim(&ticket.owner_user_id).is_empty() {
            return unavailable("incomplete_ticket");
        }
        if ticket.owner_user_id != requester {
            return unavailable("not_ticket_owner");
        }
        return Ok(ToolResult::Ticket(ticket));
    }

    let account = match desk.read_account(requester)? {
        AccountRead::Unreachable => return unavailable("no_live_kb"),
        AccountRead::Unread => return unavailable("account_plane_dark"),
        AccountRead::Ok(a) => a,
    };
    // `accountProjectionHasInventMoney(account)`: the desk's account holds the three fields only, none of them money.
    if js_trim(&account.user_id).is_empty() || js_trim(&account.kyc_tier).is_empty() {
        return unavailable("incomplete_account");
    }
    if account.user_id != requester {
        return unavailable("account_owner_mismatch");
    }
    Ok(ToolResult::Account(account))
}

/// `supportAnswerOrEscalate`: the typed "I don't know".
fn answer_or_escalate(kb: &ToolResult, money_request: bool) -> Result<Vec<String>, &'static str> {
    if money_request {
        return Err("money_request");
    }
    match kb {
        ToolResult::Refuse { reason, .. } => {
            Err(if reason == "empty_results" || reason == "kb_empty" {
                "kb_no_hit"
            } else {
                "desk_refused"
            })
        }
        ToolResult::Kb(articles) if articles.is_empty() => Err("kb_no_hit"),
        ToolResult::Kb(articles) => Ok(articles.iter().map(|a| a.article_key.clone()).collect()),
        _ => Err("desk_refused"),
    }
}

// ── The calls ──────────────────────────────────────────────────────────────

/// `forwardedPrincipalHeaders(ctx)`: the edge-signed principal of this request, byte for byte, with its region.
fn desk_headers(cx: &Cx<'_>) -> Vec<(String, String)> {
    cx.ctx
        .forwarded
        .as_ref()
        .map_or_else(Vec::new, |(raw, sig, region)| {
            vec![
                ("x-intafaced-principal".to_owned(), raw.clone()),
                ("x-intafaced-principal-sig".to_owned(), sig.clone()),
                ("x-intafaced-region".to_owned(), region.clone()),
            ]
        })
}

/// Answers one `support.*` call.
pub fn handle(cx: &Cx<'_>, call: &str) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let law = cx.rt.tier_laws.support.as_ref();
    match call {
        "policy" => policy(),
        "draftComment" => Ok(draft_comment(
            input.get("ticketId").as_str(),
            input.get("body").as_str(),
        )),
        "grounded" => Ok(
            match grounded(
                input.get("plane").as_str().unwrap_or(""),
                input.get("kbPlane").as_str(),
                input.get("kbHitCount").as_number(),
                input.get("requireKb").truthy(),
            ) {
                Ok(()) => Json::obj([
                    ("status", Json::str("ok")),
                    ("plane", Json::str("live")),
                    ("allowedTasks", strings(&TASKS)),
                ]),
                Err(reason) => Json::obj([
                    ("status", Json::str("refuse")),
                    ("plane", Json::str("dark")),
                    ("reason", Json::str(reason)),
                    ("userMessageKey", Json::str(UNAVAILABLE)),
                ]),
            },
        ),
        "stage1Guardrail" => Ok(serialise(&guardrail()?)),
        "tierGate" => Ok(match tier_gate(law, cx.tier()) {
            Ok((tier, tools)) => Json::obj([
                ("status", Json::str("ok")),
                ("userTier", Json::str(tier)),
                ("allowedTools", strings(&tools)),
            ]),
            Err(reason) => Json::obj([
                ("status", Json::str("refuse")),
                ("reason", Json::str(reason)),
                ("userMessageKey", Json::str(TIER_CLOSED)),
            ]),
        }),
        "invokeDataTool" => invoke_route(cx, law),
        "answerOrEscalate" => answer_route(cx, law),
        "runSession" => run_session(cx, law),
        _ => Err(RunError::Trpc(crate::door::not_ported(cx.ctx.call.slice))),
    }
}

/// `describeSupportPolicy()` as `support.policy`'s output declares it.
fn policy() -> Result<Json, RunError> {
    let g = guardrail()?;
    let declared = g.tools.len();
    let approval = g.tools.iter().filter(|t| t.requires_approval).count();
    let has = |t: &str| i64::from(MONEY_TOOLS.contains(&t));
    let (ledger, refund, order) = (has("ledger.post"), has("pay.refund"), has("trade.order"));
    let money = MONEY_TOOLS.len();
    let count = |n: usize| Json::int(i64::try_from(n).unwrap_or(i64::MAX));
    Ok(Json::obj([
        ("agentAssist", Json::str("agents.support")),
        ("deskMountain", Json::str("ops.support")),
        ("deskStandalone", Json::Bool(true)),
        ("deskProductComplete", Json::Bool(false)),
        ("moneyTools", strings(&MONEY_TOOLS)),
        (
            "moneyDeny",
            Json::obj([
                ("tools", count(money)),
                ("hasLedgerPost", Json::int(ledger)),
                ("hasPayRefund", Json::int(refund)),
                ("hasTradeOrder", Json::int(order)),
            ]),
        ),
        (
            "moneyDenyStatusLine",
            Json::str(format!(
                "tools={money} ledger_post={ledger} pay_refund={refund} trade_order={order}"
            )),
        ),
        (
            "moneyDenyExport",
            Json::str(format!(
                "tools,ledger_post,pay_refund,trade_order\n{money},{ledger},{refund},{order}"
            )),
        ),
        (
            "guardrail",
            Json::obj([
                ("agentId", Json::str(g.agent_id.clone())),
                ("version", Json::int(g.version)),
                ("declared", count(declared)),
                ("moneyDenied", count(money)),
                ("approvalRequired", count(approval)),
            ]),
        ),
        (
            "guardrailStatusLine",
            Json::str(format!(
                "agent={} v={} declared={declared} moneyDenied={money} approval={approval}",
                g.agent_id, g.version
            )),
        ),
        (
            "guardrailExport",
            Json::str(format!(
                "agentId,version,declared,moneyDenied,approvalRequired\n{},{},{declared},{money},{approval}",
                g.agent_id, g.version
            )),
        ),
        (
            "declaredTools",
            Json::Array(g.tools.iter().map(|t| Json::str(t.name.clone())).collect()),
        ),
        ("dataTools", strings(&DATA_TOOLS)),
        (
            "darkPlaneRefuse",
            Json::obj([
                ("reason", Json::str("desk_plane_dark")),
                ("userMessageKey", Json::str(UNAVAILABLE)),
            ]),
        ),
        ("liveAllowedTasks", strings(&TASKS)),
        (
            "tierLawRefuse",
            Json::obj([
                ("reason", Json::str("tier_law_blank")),
                ("userMessageKey", Json::str(TIER_CLOSED)),
            ]),
        ),
        ("escalationUserMessageKey", Json::str(ESCALATED)),
        ("inventsBalances", Json::Bool(false)),
        ("inventsRefunds", Json::Bool(false)),
        ("escalationFirstClass", Json::Bool(true)),
    ]))
}

/// `serialiseGuardrail` as `stage1Guardrail`'s output declares it.
fn serialise(g: &Guardrail) -> Json {
    let tools = g
        .tools
        .iter()
        .map(|t| {
            let mut f = vec![
                ("name".to_owned(), Json::str(t.name.clone())),
                ("module".to_owned(), Json::str(t.module.clone())),
                ("mode".to_owned(), Json::str(t.mode.clone())),
                (
                    "requiresApproval".to_owned(),
                    Json::Bool(t.requires_approval),
                ),
            ];
            if let Some(m) = t.max_calls_per_session {
                f.push(("maxCallsPerSession".to_owned(), Json::int(m)));
            }
            Json::Object(f)
        })
        .collect();
    Json::obj([
        ("agentId", Json::str(g.agent_id.clone())),
        ("version", Json::int(g.version)),
        ("tools", Json::Array(tools)),
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

fn ticket_id_of(v: &Value) -> Option<&str> {
    match v.get("ticket") {
        t @ Value::Object(_) => t.get("ticketId").as_str(),
        _ => None,
    }
}

/// `support.invokeDataTool`: the tool, and its user-affecting audit row.
fn invoke_route(cx: &Cx<'_>, law: Option<&Law>) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let headers = desk_headers(cx);
    let result = invoke_data_tool(&ToolCall {
        tool: input.get("tool").as_str().unwrap_or(""),
        plane: input.get("plane").as_str().unwrap_or(""),
        kb_plane: input.get("kbPlane").as_str(),
        requester: cx.user(),
        law,
        user_tier: cx.tier(),
        desk: cx.ports.support_desk.as_deref(),
        desk_headers: &headers,
        kb_query: "",
        limit: input.get("limit").as_number(),
        ticket_id: ticket_id_of(input),
    })?;
    let occurred_at = input
        .get("occurredAt")
        .as_str()
        .map_or_else(|| cx.ctx.now.iso(), str::to_owned);
    let (status, reason, key) = match &result {
        ToolResult::Refuse { reason, key, .. } => {
            ("refused", Json::str(reason.clone()), Json::str(*key))
        }
        _ => ("executed", Json::Null, Json::str("agents.action.executed")),
    };
    Ok(Json::obj([
        ("result", result.to_json()),
        (
            "audit",
            Json::obj([
                ("sequence", Json::int(0)),
                ("kind", Json::str("tool_call")),
                ("status", Json::str(status)),
                ("tool", Json::str(result.tool())),
                ("reason", reason),
                ("userMessageKey", key),
                ("occurredAt", Json::str(occurred_at)),
            ]),
        ),
    ]))
}

fn escalation(reason: &str) -> Json {
    Json::obj([
        ("status", Json::str("escalate")),
        ("reason", Json::str(reason)),
        ("userMessageKey", Json::str(ESCALATED)),
    ])
}

/// `support.answerOrEscalate`: the KB read, then the typed "I don't know". An omitted KB plane is dark.
fn answer_route(cx: &Cx<'_>, law: Option<&Law>) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let kb = invoke_data_tool(&ToolCall {
        tool: input.get("tool").as_str().unwrap_or(""),
        plane: input.get("plane").as_str().unwrap_or(""),
        kb_plane: Some(input.get("kbPlane").as_str().unwrap_or("dark")),
        requester: cx.user(),
        law,
        user_tier: cx.tier(),
        desk: cx.ports.support_desk.as_deref(),
        desk_headers: &[],
        kb_query: "",
        limit: input.get("limit").as_number(),
        ticket_id: None,
    })?;
    Ok(
        match answer_or_escalate(&kb, input.get("moneyRequest") == &Value::Bool(true)) {
            Ok(keys) => Json::obj([
                ("status", Json::str("answer")),
                ("citedArticleKeys", strings(&keys)),
            ]),
            Err(reason) => escalation(reason),
        },
    )
}

// ── The metered run ────────────────────────────────────────────────────────

/// `ACCOUNT_STATE_MISSING_REASONS`: an account read that counts as missing for grounding honesty.
const ACCOUNT_STATE_MISSING: [&str; 7] = [
    "missing_fixture",
    "incomplete_account",
    "balance_field_forbidden",
    "account_owner_mismatch",
    "account_plane_dark",
    "account_not_attempted",
    "no_live_kb",
];

/// `SupportUnanswered`: a read that produced no fact, and who refused it.
struct Unanswered {
    tool: String,
    by_guardrail: bool,
    reason: String,
    key: String,
}

fn unanswered_json(list: &[Unanswered]) -> Json {
    Json::Array(
        list.iter()
            .map(|u| {
                Json::obj([
                    ("tool", Json::str(u.tool.clone())),
                    (
                        "refusedBy",
                        Json::str(if u.by_guardrail { "guardrail" } else { "tool" }),
                    ),
                    ("reason", Json::str(u.reason.clone())),
                    ("userMessageKey", Json::str(u.key.clone())),
                ])
            })
            .collect(),
    )
}

fn findings_json(findings: &[ToolResult]) -> Json {
    Json::Array(findings.iter().map(ToolResult::to_json).collect())
}

/// `buildSupportCaseFile`: what the agent already read, for the person it hands over to.
fn case_file(
    reason: &str,
    money_request: bool,
    findings: &[ToolResult],
    unanswered: &[Unanswered],
) -> Json {
    let mut tickets = Vec::new();
    let mut cited = Vec::new();
    let mut accounts = Vec::new();
    for f in findings {
        match f {
            ToolResult::Ticket(t) => tickets.push(t.ticket_id.clone()),
            ToolResult::Kb(articles) => {
                cited.extend(articles.iter().map(|a| a.article_key.clone()))
            }
            ToolResult::Account(a) => accounts.push(account_json(a)),
            ToolResult::Refuse { .. } => {}
        }
    }
    Json::obj([
        ("reason", Json::str(reason)),
        (
            "moneyRequest",
            Json::Bool(money_request || reason == "money_request"),
        ),
        ("findings", findings_json(findings)),
        ("unanswered", unanswered_json(unanswered)),
        ("ticketIds", strings(&tickets)),
        ("citedArticleKeys", strings(&cited)),
        ("accounts", Json::Array(accounts)),
    ])
}

fn escalate_answer(
    reason: &str,
    money_request: bool,
    findings: &[ToolResult],
    unanswered: &[Unanswered],
) -> Json {
    Json::obj([
        ("status", Json::str("escalate")),
        ("reason", Json::str(reason)),
        ("userMessageKey", Json::str(ESCALATED)),
        ("findings", findings_json(findings)),
        ("unanswered", unanswered_json(unanswered)),
        (
            "caseFile",
            case_file(reason, money_request, findings, unanswered),
        ),
    ])
}

fn refuse_answer(reason: &str, key: &str, unanswered: &[Unanswered]) -> Json {
    Json::obj([
        ("status", Json::str("refuse")),
        ("reason", Json::str(reason)),
        ("userMessageKey", Json::str(key)),
        ("unanswered", unanswered_json(unanswered)),
    ])
}

/// `accountFromState`: money or any key but the three refuses, so does a blank field or somebody else's account.
fn account_from_state(state: &Value, requester: &str) -> Result<(), &'static str> {
    let keys: Vec<&str> = match state {
        Value::Object(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
        _ => Vec::new(),
    };
    if has_invent_money(keys.iter().copied())
        || keys
            .iter()
            .any(|k| !matches!(*k, "userId" | "status" | "kycTier"))
    {
        return Err("balance_field_forbidden");
    }
    let user_id = state.get("userId").as_str().unwrap_or("");
    if js_trim(user_id).is_empty()
        || js_trim(state.get("kycTier").as_str().unwrap_or("")).is_empty()
    {
        return Err("incomplete_account");
    }
    if user_id != js_trim(requester) {
        return Err("account_owner_mismatch");
    }
    Ok(())
}

/// `resolveSupportAskFixtures`, as far as the desk reads it: an account grounding (or a raw account) that does not
/// project refuses the ask by name.
fn resolve_ask(ask: &Value, requester: &str) -> Result<(), &'static str> {
    match ask.get("accountGrounding") {
        g @ Value::Object(_) => {
            if g.get("status").as_str() == Some("unread") {
                return Err(if g.get("reason").as_str() == Some("plane_dark") {
                    "account_plane_dark"
                } else {
                    "account_not_attempted"
                });
            }
            account_from_state(g.get("state"), requester)
        }
        _ => match ask.get("account") {
            a @ Value::Object(_) => account_from_state(a, requester),
            _ => Ok(()),
        },
    }
}

/// The KB read's own outcome: refused by the guardrail, or what the tool answered.
enum KbOutcome {
    Guardrail,
    Tool(ToolResult),
}

/// `runSupportReplySession` as `support.runSession` answers it: the free outcomes before any session, then each ask
/// through the runtime's `act`, settled and closed on every path.
fn run_session(cx: &Cx<'_>, law: Option<&Law>) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let asset = cx.fee_asset_id();
    let free = |answer: Json| Ok(with_field(answer, "metering", unmetered(asset)));
    let plane = input.get("plane").as_str().unwrap_or("");
    if plane == "dark" {
        return free(refuse_answer("desk_plane_dark", UNAVAILABLE, &[]));
    }
    if input.get("moneyRequest") == &Value::Bool(true) {
        return free(escalate_answer("money_request", true, &[], &[]));
    }
    let catalog = input.get("kbCatalog").as_array().map_or(0, <[Value]>::len);
    let (user_tier, granted) = match tier_gate(law, cx.tier()) {
        Ok(t) => t,
        Err(reason) => return free(refuse_answer(reason, TIER_CLOSED, &[])),
    };
    let asks = input.get("asks").as_array().unwrap_or(&[]);
    let asked: Vec<&str> = asks
        .iter()
        .map(|a| js_trim(a.get("tool").as_str().unwrap_or("")))
        .collect();
    if asked.contains(&KB_TOOL) && catalog == 0 {
        return free(refuse_answer("kb_plane_ungrounded", UNAVAILABLE, &[]));
    }
    if asks.is_empty() {
        // The run's `empty`, which the route answers as an ungrounded KB plane.
        return free(refuse_answer("kb_plane_ungrounded", UNAVAILABLE, &[]));
    }
    let Some(desk) = cx.ports.support_desk.as_deref() else {
        return free(refuse_answer("no_live_kb", UNAVAILABLE, &[]));
    };
    if !asked.iter().any(|t| granted.iter().any(|g| g == t)) {
        return free(refuse_answer("tier_not_granted", TIER_CLOSED, &[]));
    }
    if !asked.contains(&KB_TOOL) {
        return free(escalate_answer("kb_no_hit", false, &[], &[]));
    }

    let kb_plane = if catalog > 0 { "live" } else { "dark" };
    let headers = desk_headers(cx);
    let user = cx.user();
    let x = cx.x()?;
    metered_run(&x, user, AGENT_ID, asset, |session_id| {
        let mut findings: Vec<ToolResult> = Vec::new();
        let mut unanswered: Vec<Unanswered> = Vec::new();
        let mut kb: Option<KbOutcome> = None;
        for (ask, tool) in asks.iter().zip(asked.iter().copied()) {
            let mut answered: Option<ToolResult> = None;
            let done = act(
                &x,
                &ActInput {
                    session_id,
                    tool,
                    ..ActInput::default()
                },
                || {
                    let result = match resolve_ask(ask, user) {
                        Err(reason) => ToolResult::unavailable(tool, reason),
                        Ok(()) => invoke_data_tool(&ToolCall {
                            tool,
                            plane,
                            kb_plane: Some(kb_plane),
                            requester: user,
                            law,
                            user_tier: cx.tier(),
                            desk: Some(desk),
                            desk_headers: &headers,
                            kb_query: ask.get("kbQuery").as_str().unwrap_or(""),
                            limit: ask.get("limit").as_number(),
                            ticket_id: ticket_id_of(ask),
                        })?,
                    };
                    let j = result.to_json();
                    answered = Some(result);
                    Ok(j)
                },
            );
            let result = match done {
                Ok(_) => answered.ok_or_else(|| {
                    RunError::Other("support: the tool's answer was not kept".to_owned())
                })?,
                Err(e) if is_refused(&e) => {
                    if let RunError::Refused { refusal, .. } = &e {
                        unanswered.push(Unanswered {
                            tool: tool.to_owned(),
                            by_guardrail: true,
                            reason: refusal.code.clone(),
                            key: refusal.user_message_key.clone(),
                        });
                    }
                    if tool == KB_TOOL && kb.is_none() {
                        kb = Some(KbOutcome::Guardrail);
                    }
                    continue;
                }
                Err(e) => return Err(e),
            };
            if tool == KB_TOOL && kb.is_none() {
                kb = Some(KbOutcome::Tool(result.clone()));
            }
            match result {
                ToolResult::Refuse { reason, key, .. } => unanswered.push(Unanswered {
                    tool: tool.to_owned(),
                    by_guardrail: false,
                    reason,
                    key: key.to_owned(),
                }),
                ok => findings.push(ok),
            }
        }

        if findings.is_empty() {
            return Ok(refuse_answer("no_grounded_read", UNAVAILABLE, &unanswered));
        }
        let account_missing = unanswered
            .iter()
            .any(|u| u.tool == ACCOUNT_TOOL && ACCOUNT_STATE_MISSING.contains(&u.reason.as_str()));
        if asked.contains(&ACCOUNT_TOOL) && account_missing {
            return Ok(refuse_answer(
                "account_state_missing",
                UNAVAILABLE,
                &unanswered,
            ));
        }
        let kb_result = match kb {
            None => return Ok(escalate_answer("kb_no_hit", false, &findings, &unanswered)),
            Some(KbOutcome::Guardrail) => {
                return Ok(escalate_answer(
                    "desk_refused",
                    false,
                    &findings,
                    &unanswered,
                ));
            }
            Some(KbOutcome::Tool(r)) => r,
        };
        match answer_or_escalate(&kb_result, false) {
            Err(reason) => Ok(escalate_answer(reason, false, &findings, &unanswered)),
            Ok(cited) => Ok(Json::obj([
                ("status", Json::str("ok")),
                ("userTier", Json::str(user_tier.clone())),
                ("findings", findings_json(&findings)),
                ("unanswered", unanswered_json(&unanswered)),
                ("citedArticleKeys", strings(&cited)),
                (
                    "asked",
                    Json::int(i64::try_from(asks.len()).unwrap_or(i64::MAX)),
                ),
                (
                    "answered",
                    Json::int(i64::try_from(findings.len()).unwrap_or(i64::MAX)),
                ),
                ("complete", Json::Bool(unanswered.is_empty())),
            ])),
        }
    })
}

// ── The live desk port ─────────────────────────────────────────────────────

/// The three wire shapes the desk reads (`supportKbArticleSchema`, `supportTicketSchema`, `accountStateSchema`), as
/// `scripts/factories/support.mjs` records them from the contracts.
const SCHEMAS: &str = include_str!("support_schemas.json");

struct Shapes {
    schema: Schema,
    article: usize,
    ticket: usize,
    account: usize,
}

fn shapes() -> Option<&'static Shapes> {
    static SHAPES: OnceLock<Option<Shapes>> = OnceLock::new();
    SHAPES
        .get_or_init(|| {
            let doc = json::parse(SCHEMAS).ok()?;
            let root = |k: &str| match doc.get("roots").and_then(|r| r.get(k)) {
                Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 0.0 => {
                    #[expect(
                        clippy::cast_possible_truncation,
                        clippy::cast_sign_loss,
                        reason = "a part's index, a small whole number"
                    )]
                    let i = *n as usize;
                    Some(i)
                }
                _ => None,
            };
            Some(Shapes {
                article: root("article")?,
                ticket: root("ticket")?,
                account: root("account")?,
                schema: Schema::from_json(&doc).ok()?,
            })
        })
        .as_ref()
}

/// The shapes have no refines.
struct NoRefines;

impl Refiner for NoRefines {
    fn refine(&self, id: &str, _value: &Value) -> Result<bool, String> {
        Err(format!("support: no refine named {id}"))
    }
}

/// `schema.safeParse(value)`: the output, or none when it does not parse (or the shapes are unreadable).
fn safe_parse(pick: impl Fn(&Shapes) -> usize, value: &Json) -> Option<Value> {
    let s = shapes()?;
    match s.schema.parse(pick(s), Value::from_json(value), &NoRefines) {
        Ok(Outcome::Ok(v)) => Some(v),
        _ => None,
    }
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).as_str().unwrap_or("").to_owned()
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// `unwrapTrpc`: `result.data` (or its `json`) when present, else the body.
fn unwrap_trpc(body: Json) -> Json {
    let data = match &body {
        Json::Object(_) => body
            .get("result")
            .filter(|r| matches!(r, Json::Object(_)))
            .and_then(|r| r.get("data"))
            .cloned(),
        _ => None,
    };
    match data {
        Some(d @ Json::Object(_)) => d.get("json").cloned().unwrap_or(d),
        Some(d) => d,
        None => body,
    }
}

/// `createHttpSupportDeskPort`: svc-support's public `searchKb` and the person's own ticket `get` (tRPC), and
/// svc-identity's `GET /internal/account/:userId`, signed as svc-agents. A transport or shape failure is unreachable
/// or unread, never an invented article or an active account.
pub struct DeskHttp {
    pub support_url: String,
    /// Empty without `IDENTITY_URL`: every account read is unread.
    pub identity_url: String,
    /// svc-agents to svc-identity.
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl DeskHttp {
    pub fn new(
        support_url: &str,
        identity_url: Option<&str>,
        signer: CallSigner,
        fetch: Arc<dyn Fetch>,
    ) -> DeskHttp {
        let trim = |u: &str| u.strip_suffix('/').unwrap_or(u).to_owned();
        DeskHttp {
            support_url: trim(support_url),
            identity_url: identity_url.map(trim).unwrap_or_default(),
            signer,
            fetch,
        }
    }

    /// `trpcQuery`: `(ok, status, body)`, the body null when it is not JSON and the status 0 when the fetch failed.
    fn query(
        &self,
        procedure: &str,
        input: &Json,
        headers: &[(String, String)],
    ) -> (bool, u16, Json) {
        let url = format!(
            "{}/trpc/{procedure}?input={}",
            self.support_url,
            encode_uri_component(&input.compact())
        );
        let mut all = vec![("accept".to_owned(), "application/json".to_owned())];
        all.extend(headers.iter().cloned());
        match self.fetch.fetch(&HttpRequest {
            method: "GET".to_owned(),
            url,
            headers: all,
            body: None,
            timeout_ms: None,
            refuse_redirect: false,
        }) {
            Err(_) => (false, 0, Json::Null),
            Ok(res) => (
                res.ok(),
                res.status,
                json::parse(&res.body).unwrap_or(Json::Null),
            ),
        }
    }
}

/// The path and query of a URL (`url.pathname + url.search`).
fn target_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.find('/').and_then(|i| rest.get(i..)).unwrap_or("/")
}

impl Desk for DeskHttp {
    fn search_kb(&self, query: &str, limit: Option<f64>) -> Result<Found, RunError> {
        let Some(page) = kb_page(limit) else {
            return Ok(Found::LimitUnset);
        };
        let input = Json::obj([("q", Json::str(query)), ("limit", Json::Number(page))]);
        let (ok, _, body) = self.query("searchKb", &input, &[]);
        if !ok {
            return Ok(Found::Unreachable);
        }
        let Json::Array(items) = unwrap_trpc(body) else {
            return Ok(Found::Unreachable);
        };
        let mut out = Vec::with_capacity(items.len());
        for item in &items {
            let Some(a) = safe_parse(|s| s.article, item) else {
                return Ok(Found::Unreachable);
            };
            out.push(Article {
                article_key: text(&a, "id"),
                title_key: text(&a, "titleKey"),
                body_key: text(&a, "bodyKey"),
            });
        }
        Ok(Found::Ok(out))
    }

    fn read_ticket(
        &self,
        ticket_id: &str,
        headers: &[(String, String)],
    ) -> Result<TicketRead, RunError> {
        let input = Json::obj([("ticketId", Json::str(ticket_id))]);
        let (ok, status, body) = self.query("get", &input, headers);
        if status == 404 {
            return Ok(TicketRead::Missing);
        }
        if !ok {
            return Ok(TicketRead::Unreachable);
        }
        let Some(t) = safe_parse(|s| s.ticket, &unwrap_trpc(body)) else {
            return Ok(TicketRead::Unreachable);
        };
        if js_trim(&text(&t, "id")) != ticket_id {
            return Ok(TicketRead::Missing);
        }
        Ok(TicketRead::Ok(Ticket {
            ticket_id: text(&t, "id"),
            owner_user_id: text(&t, "userId"),
            status: text(&t, "status"),
            category: text(&t, "category"),
        }))
    }

    fn read_account(&self, user_id: &str) -> Result<AccountRead, RunError> {
        if self.identity_url.is_empty() {
            return Ok(AccountRead::Unread);
        }
        let url = format!(
            "{}/internal/account/{}",
            self.identity_url,
            encode_uri_component(user_id)
        );
        let Ok(signed) = self
            .signer
            .sign("", "GET", target_of(&url), "application/json")
        else {
            // `signIdentity` throwing inside the try: the read is unreachable.
            return Ok(AccountRead::Unreachable);
        };
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(signed);
        let res = match self.fetch.fetch(&HttpRequest {
            method: "GET".to_owned(),
            url,
            headers,
            body: None,
            timeout_ms: None,
            refuse_redirect: false,
        }) {
            Ok(r) => r,
            Err(_) => return Ok(AccountRead::Unreachable),
        };
        if !res.ok() {
            return Ok(AccountRead::Unread);
        }
        let body = json::parse(&res.body).unwrap_or(Json::Null);
        let Some(a) = safe_parse(|s| s.account, &body) else {
            return Ok(AccountRead::Unread);
        };
        if a.get("userId").as_str() != Some(user_id) {
            return Ok(AccountRead::Unread);
        }
        let keys: Vec<&str> = match &a {
            Value::Object(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
            _ => Vec::new(),
        };
        if has_invent_money(keys) {
            return Ok(AccountRead::Unread);
        }
        Ok(AccountRead::Ok(Account {
            user_id: text(&a, "userId"),
            status: text(&a, "status"),
            kyc_tier: text(&a, "kycTier"),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_keys_are_the_typescripts() {
        for k in [
            "balance",
            "available_balance",
            "Balance",
            "amount",
            "hold",
            "hold_x",
            "creditLimit",
            "unrealizedPnl",
            "myWallet",
            "totalAmountX",
            "reserved",
        ] {
            assert!(key_is_invent_money(k), "{k}");
        }
        for k in [
            "userId", "status", "kycTier", "holder", "credits", "PNL2", "xpnl", "archived",
        ] {
            assert!(!key_is_invent_money(k), "{k}");
        }
    }

    #[test]
    fn keys_are_i18n_keys() {
        assert!(is_key_like("support.kb.x"));
        assert!(is_key_like(" a-b "));
        assert!(is_key_like("A_1"));
        assert!(!is_key_like("one"));
        assert!(!is_key_like("a..b"));
        assert!(!is_key_like("a.b."));
        assert!(!is_key_like("a b.c"));
        assert!(!is_key_like("é.b"));
    }

    #[test]
    fn the_shapes_are_readable() {
        assert!(shapes().is_some());
        assert!(Regex::new(r"/\b(i (have )?refunded|payout of)\b/").is_ok());
    }
}
