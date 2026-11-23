//! The guardrail (\`services/svc-agents/src/fleet/guardrails.ts\`): what an agent was ever allowed to do, declared, parsed
//! once and snapshotted onto each session at open, and every rule evaluated against a proposed action while it is still
//! a proposal. Pure: every decision is a function of (guardrail, session state, request).

use service_kit::json::Json;
use service_kit::jsregex::Regex;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::js_length;

/// \`MODULE_IDS\` of \`packages/config/src/modules.ts\` (held to it by \`tests/runtime_parity.rs\`).
pub const MODULE_IDS: [&str; 28] = [
    "identity",
    "ledger",
    "token",
    "matching",
    "trade",
    "execution",
    "ws",
    "pay",
    "p2p",
    "blueprint",
    "bank",
    "launch",
    "academy",
    "market",
    "mining-pool",
    "agents",
    "core-ops",
    "notify",
    "support",
    "tax",
    "quant",
    "campaigns",
    "edge",
    "chain",
    "indexer",
    "bridge",
    "protocol",
    "dex",
];

/// `isModuleId`.
pub fn is_module_id(id: &str) -> bool {
    MODULE_IDS.contains(&id)
}

pub const AGENT_CAPACITY_MODES: [&str; 5] = [
    "research_only",
    "read_only",
    "draft_preview",
    "confirm_each",
    "bounded_autonomous",
];
pub const AGENT_WITHDRAW_SCOPE: &str = "withdraw";
pub const LIVE_WRITE_TOOLS: [&str; 6] = [
    "trade.order",
    "trade.place",
    "trade.amend",
    "trade.cancel",
    "bank.withdraw",
    "bank.transfer",
];
pub const PLACE_TOOLS: [&str; 2] = ["trade.order", "trade.place"];
pub const WITHDRAW_TOOLS: [&str; 2] = ["bank.withdraw", "bank.transfer"];
pub const FLEET_HARD_MONEY_WRITE_TOOLS: [&str; 15] = [
    "ledger.post",
    "ledger.hold",
    "pay.refund",
    "pay.capture",
    "pay.route.change",
    "bank.transfer",
    "bank.withdraw",
    "bank.loan",
    "trade.order",
    "trade.place",
    "trade.amend",
    "trade.cancel",
    "trade.copy.follow",
    "trade.copy.unfollow",
    "p2p.release",
];
pub const PRODUCT_AGENT_IDS: [&str; 5] =
    ["navigator", "support", "scanner", "merchant", "copy-intel"];

pub fn is_known_capacity_mode(mode: Option<&str>) -> bool {
    mode.is_some_and(|m| AGENT_CAPACITY_MODES.contains(&m))
}
pub fn capacity_mode_allows_live_write(mode: Option<&str>) -> bool {
    matches!(mode, Some("confirm_each" | "bounded_autonomous"))
}
pub fn is_live_write_tool(tool: &str) -> bool {
    LIVE_WRITE_TOOLS.contains(&tool)
}
pub fn is_place_tool(tool: &str) -> bool {
    PLACE_TOOLS.contains(&tool)
}
pub fn is_withdraw_tool(tool: &str) -> bool {
    WITHDRAW_TOOLS.contains(&tool)
}
pub fn is_fleet_hard_money_write_tool(tool: &str) -> bool {
    FLEET_HARD_MONEY_WRITE_TOOLS.contains(&tool)
}
pub fn is_product_agent_id(agent_id: &str) -> bool {
    PRODUCT_AGENT_IDS.contains(&agent_id)
}

/// One tool grant (\`ToolGrant\`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolGrant {
    pub name: String,
    pub module: String,
    pub mode: String,
    pub max_calls_per_session: Option<i64>,
    pub requires_approval: bool,
}

/// \`GuardrailLimits\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    pub max_actions_per_session: i64,
    pub max_output_tokens_per_call: i64,
    /// None: uncapped.
    pub max_spend_per_session: Option<Amount>,
    pub allowed_modules: Vec<String>,
    pub allowed_tasks: Vec<String>,
}

/// A parsed guardrail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guardrail {
    pub agent_id: String,
    pub version: i64,
    pub capacity_mode: Option<String>,
    pub scopes: Vec<String>,
    pub tools: Vec<ToolGrant>,
    pub limits: Limits,
}

/// Why a guardrail was refused at parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

fn invalid(m: impl Into<String>) -> Invalid {
    Invalid(m.into())
}

/// zod's \`z.number().int()\`: a finite safe integer.
fn int_of(v: &Json, what: &str, min: i64, max: i64) -> Result<i64, Invalid> {
    let Json::Number(n) = v else {
        return Err(invalid(format!("{what}: expected number")));
    };
    #[expect(
        clippy::cast_possible_truncation,
        reason = "checked to be a safe integer first"
    )]
    let i = *n as i64;
    #[expect(
        clippy::cast_precision_loss,
        reason = "the safe-integer bound is exact in f64"
    )]
    let safe =
        n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && (i as f64) == *n;
    if !safe {
        return Err(invalid(format!("{what}: expected int")));
    }
    if i < min || i > max {
        return Err(invalid(format!("{what}: out of range")));
    }
    Ok(i)
}

fn str_of(v: &Json, what: &str, min: usize, max: usize) -> Result<String, Invalid> {
    let Json::String(s) = v else {
        return Err(invalid(format!("{what}: expected string")));
    };
    let n = js_length(s);
    if n < min || n > max {
        return Err(invalid(format!("{what}: length out of range")));
    }
    Ok(s.clone())
}

/// An absent key (zod's \`undefined\`) reads as None; \`null\` is a value.
fn field<'a>(o: &'a Json, key: &str) -> Option<&'a Json> {
    o.get(key)
}

fn array_default<T>(
    o: &Json,
    key: &str,
    each: impl Fn(&Json) -> Result<T, Invalid>,
) -> Result<Vec<T>, Invalid> {
    match field(o, key) {
        None => Ok(Vec::new()),
        Some(Json::Array(items)) => items.iter().map(each).collect(),
        Some(_) => Err(invalid(format!("{key}: expected array"))),
    }
}

fn module_of(v: &Json) -> Result<String, Invalid> {
    match v {
        Json::String(s) if is_module_id(s) => Ok(s.clone()),
        _ => Err(invalid(
            "must be a module id declared in packages/config/src/modules.ts",
        )),
    }
}

/// \`amountString\`: an unsigned decimal with at most 18 places.
fn amount_string(v: &Json) -> Result<Amount, Invalid> {
    let Json::String(s) = v else {
        return Err(invalid("maxSpendPerSession: expected string"));
    };
    let ok = Regex::new(r"/^\d+(\.\d{1,18})?$/")
        .map_err(invalid)?
        .test(s);
    if !ok {
        return Err(invalid(
            "must be an unsigned decimal string with at most 18 decimal places",
        ));
    }
    parse_amount(s).map_err(invalid)
}

fn tool_of(v: &Json) -> Result<ToolGrant, Invalid> {
    if !matches!(v, Json::Object(_)) {
        return Err(invalid("tool: expected object"));
    }
    let name = str_of(field(v, "name").unwrap_or(&Json::Null), "name", 1, 120)?;
    let module = module_of(field(v, "module").unwrap_or(&Json::Null))?;
    let mode = match field(v, "mode") {
        Some(Json::String(m)) if m == "read" || m == "write" => m.clone(),
        _ => return Err(invalid("mode: invalid option")),
    };
    let max_calls_per_session = match field(v, "maxCallsPerSession") {
        None => None,
        Some(n) => Some(int_of(n, "maxCallsPerSession", 0, i64::MAX)?),
    };
    let requires_approval = match field(v, "requiresApproval") {
        None => false,
        Some(Json::Bool(b)) => *b,
        Some(_) => return Err(invalid("requiresApproval: expected boolean")),
    };
    Ok(ToolGrant {
        name,
        module,
        mode,
        max_calls_per_session,
        requires_approval,
    })
}

/// \`parseGuardrail\`: the schema, then the contradictions a security policy must not hold.
pub fn parse_guardrail(input: &Json) -> Result<Guardrail, Invalid> {
    if !matches!(input, Json::Object(_)) {
        return Err(invalid("guardrail: expected object"));
    }
    let agent_id = str_of(
        field(input, "agentId").unwrap_or(&Json::Null),
        "agentId",
        1,
        64,
    )?;
    let version = int_of(
        field(input, "version").unwrap_or(&Json::Null),
        "version",
        1,
        i64::MAX,
    )?;
    let capacity_mode = match field(input, "capacityMode") {
        None => None,
        Some(v) => Some(str_of(v, "capacityMode", 1, 64)?),
    };
    let scopes = array_default(input, "scopes", |s| str_of(s, "scope", 1, 64))?;
    let tools = array_default(input, "tools", tool_of)?;
    let Some(limits) = field(input, "limits").filter(|l| matches!(l, Json::Object(_))) else {
        return Err(invalid("limits: expected object"));
    };
    let limits = Limits {
        max_actions_per_session: int_of(
            field(limits, "maxActionsPerSession").unwrap_or(&Json::Null),
            "maxActionsPerSession",
            1,
            10_000,
        )?,
        max_output_tokens_per_call: int_of(
            field(limits, "maxOutputTokensPerCall").unwrap_or(&Json::Null),
            "maxOutputTokensPerCall",
            1,
            1_000_000,
        )?,
        max_spend_per_session: match field(limits, "maxSpendPerSession") {
            None | Some(Json::Null) => None,
            Some(v) => Some(amount_string(v)?),
        },
        allowed_modules: array_default(limits, "allowedModules", module_of)?,
        allowed_tasks: array_default(limits, "allowedTasks", |t| str_of(t, "task", 1, usize::MAX))?,
    };

    let mut seen: Vec<&str> = Vec::new();
    for tool in &tools {
        if seen.contains(&tool.name.as_str()) {
            return Err(invalid(format!(
                "Duplicate tool grant \"{}\" — a tool is declared once",
                tool.name
            )));
        }
        seen.push(&tool.name);
        if !limits.allowed_modules.contains(&tool.module) {
            return Err(invalid(format!(
                "Tool \"{}\" acts in module \"{}\", which is not in allowedModules — grant the module or drop the tool",
                tool.name, tool.module
            )));
        }
        if is_product_agent_id(&agent_id) && is_fleet_hard_money_write_tool(&tool.name) {
            return Err(invalid(format!(
                "Product agent \"{agent_id}\" cannot grant money-moving tool \"{}\" — value moves only via packages/ledger-client recipes",
                tool.name
            )));
        }
    }
    if is_product_agent_id(&agent_id) && scopes.iter().any(|s| s == AGENT_WITHDRAW_SCOPE) {
        return Err(invalid(format!(
            "Product agent \"{agent_id}\" cannot carry withdraw scope — cash-out is a separate approved grant"
        )));
    }
    Ok(Guardrail {
        agent_id,
        version,
        capacity_mode,
        scopes,
        tools,
        limits,
    })
}

fn strs(v: &[String]) -> Json {
    Json::Array(v.iter().map(|s| Json::str(s.clone())).collect())
}

/// \`serialiseGuardrail\`: the jsonb form stored on the session, in the TypeScript's key order.
pub fn serialise_guardrail(g: &Guardrail) -> Json {
    let mut fields: Vec<(String, Json)> = vec![
        ("agentId".to_owned(), Json::str(g.agent_id.clone())),
        ("version".to_owned(), Json::int(g.version)),
    ];
    if let Some(mode) = &g.capacity_mode {
        fields.push(("capacityMode".to_owned(), Json::str(mode.clone())));
    }
    fields.push(("scopes".to_owned(), strs(&g.scopes)));
    fields.push((
        "tools".to_owned(),
        Json::Array(
            g.tools
                .iter()
                .map(|t| {
                    let mut f: Vec<(String, Json)> = vec![
                        ("name".to_owned(), Json::str(t.name.clone())),
                        ("module".to_owned(), Json::str(t.module.clone())),
                        ("mode".to_owned(), Json::str(t.mode.clone())),
                        (
                            "requiresApproval".to_owned(),
                            Json::Bool(t.requires_approval),
                        ),
                    ];
                    if let Some(n) = t.max_calls_per_session {
                        f.push(("maxCallsPerSession".to_owned(), Json::int(n)));
                    }
                    Json::Object(f)
                })
                .collect(),
        ),
    ));
    fields.push((
        "limits".to_owned(),
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
                g.limits
                    .max_spend_per_session
                    .map_or(Json::Null, |a| Json::str(format_amount(a))),
            ),
            ("allowedModules", strs(&g.limits.allowed_modules)),
            ("allowedTasks", strs(&g.limits.allowed_tasks)),
        ]),
    ));
    Json::Object(fields)
}

/// \`REFUSAL_CODES\`, in the TypeScript's order.
pub const REFUSAL_CODES: [&str; 28] = [
    "agents.tool_not_declared",
    "agents.tool_call_limit",
    "agents.module_not_allowed",
    "agents.task_not_allowed",
    "agents.action_limit",
    "agents.spend_limit",
    "agents.output_limit",
    "agents.approval_required",
    "agents.session_closed",
    "agents.mode_unknown",
    "agents.mode_forbids_write",
    "agents.withdraw_scope_required",
    "agents.place_idempotency_required",
    "agents.place_key_conflict",
    "agents.price_unset",
    "agents.funds_insufficient",
    "agents.funds_unread",
    "agents.spend.cap_exceeded",
    "agents.spend.cap_unset",
    "agents.team.allocation_exceeded",
    "agents.team.project_limit_exceeded",
    "agents.team.pool_exceeded",
    "agents.team.allocation_unset",
    "agents.usage.hard_limit_reached",
    "agents.overage_grace_exceeded",
    "agents.overage_grace_unset",
    "agents.window_sealed",
    "agents.copy_intel.returns_board_refused",
];

/// A refusal (\`Refusal\`): its code, the copy key a surface renders and the key's parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: String,
    pub user_message_key: String,
    pub user_message_params: Vec<(String, Json)>,
}

pub fn refuse(code: &str, key: &str, params: Vec<(String, Json)>) -> Refusal {
    Refusal {
        code: code.to_owned(),
        user_message_key: key.to_owned(),
        user_message_params: params,
    }
}

fn s(k: &str, v: impl Into<String>) -> (String, Json) {
    (k.to_owned(), Json::String(v.into()))
}
fn n(k: &str, v: i64) -> (String, Json) {
    (k.to_owned(), Json::int(v))
}

/// \`SessionState\`: what the session has consumed so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionState {
    pub closed: bool,
    pub action_count: i64,
    pub tool_calls: Vec<(String, i64)>,
    pub spend: Amount,
    pub approved_tools: Vec<String>,
}

pub fn find_tool<'a>(g: &'a Guardrail, name: &str) -> Option<&'a ToolGrant> {
    g.tools.iter().find(|t| t.name == name)
}

fn evaluate_session(g: &Guardrail, state: &SessionState) -> Result<(), Refusal> {
    if state.closed {
        return Err(refuse(
            "agents.session_closed",
            "agents.refused.session_closed",
            vec![],
        ));
    }
    if state.action_count >= g.limits.max_actions_per_session {
        return Err(refuse(
            "agents.action_limit",
            "agents.refused.step_limit",
            vec![n("limit", g.limits.max_actions_per_session)],
        ));
    }
    Ok(())
}

/// \`toolRefusalCodes\`: every refusal a call of this declared tool can meet under this guardrail, in check order.
pub fn tool_refusal_codes(g: &Guardrail, grant: &ToolGrant) -> Vec<&'static str> {
    let mut codes = vec!["agents.session_closed", "agents.action_limit"];
    let always = |mut c: Vec<&'static str>, code| {
        c.push(code);
        c
    };
    if is_product_agent_id(&g.agent_id) && is_fleet_hard_money_write_tool(&grant.name) {
        return always(codes, "agents.tool_not_declared");
    }
    if !g.limits.allowed_modules.contains(&grant.module) {
        return always(codes, "agents.module_not_allowed");
    }
    if is_live_write_tool(&grant.name) {
        if !is_known_capacity_mode(g.capacity_mode.as_deref()) {
            return always(codes, "agents.mode_unknown");
        }
        if !capacity_mode_allows_live_write(g.capacity_mode.as_deref()) {
            return always(codes, "agents.mode_forbids_write");
        }
    }
    if is_withdraw_tool(&grant.name) && !g.scopes.iter().any(|s| s == AGENT_WITHDRAW_SCOPE) {
        return always(codes, "agents.withdraw_scope_required");
    }
    if grant.max_calls_per_session == Some(0) {
        return always(codes, "agents.tool_call_limit");
    }
    if grant.max_calls_per_session.is_some() {
        codes.push("agents.tool_call_limit");
    }
    if grant.requires_approval {
        codes.push("agents.approval_required");
    }
    if is_place_tool(&grant.name) {
        codes.push("agents.place_idempotency_required");
        codes.push("agents.place_key_conflict");
    }
    codes
}

/// \`evaluateToolCall\`.
pub fn evaluate_tool_call(
    g: &Guardrail,
    state: &SessionState,
    tool: &str,
    approved: Option<bool>,
    idempotency_key: Option<&str>,
) -> Result<(), Refusal> {
    evaluate_session(g, state)?;
    let Some(grant) = find_tool(g, tool) else {
        return Err(refuse(
            "agents.tool_not_declared",
            "agents.refused.tool_not_declared",
            vec![s("tool", tool)],
        ));
    };
    if is_product_agent_id(&g.agent_id) && is_fleet_hard_money_write_tool(tool) {
        return Err(refuse(
            "agents.tool_not_declared",
            "agents.refused.tool_not_declared",
            vec![s("tool", tool)],
        ));
    }
    if !g.limits.allowed_modules.contains(&grant.module) {
        return Err(refuse(
            "agents.module_not_allowed",
            "agents.refused.module_not_allowed",
            vec![s("module", grant.module.clone())],
        ));
    }
    if is_live_write_tool(tool) {
        if !is_known_capacity_mode(g.capacity_mode.as_deref()) {
            return Err(refuse(
                "agents.mode_unknown",
                "agents.refused.mode_unknown",
                vec![s("tool", tool)],
            ));
        }
        if !capacity_mode_allows_live_write(g.capacity_mode.as_deref()) {
            // A known mode, so it is set.
            let mode = g.capacity_mode.clone().unwrap_or_default();
            return Err(refuse(
                "agents.mode_forbids_write",
                "agents.refused.mode_forbids_write",
                vec![s("tool", tool), s("mode", mode)],
            ));
        }
    }
    if is_withdraw_tool(tool) && !g.scopes.iter().any(|s| s == AGENT_WITHDRAW_SCOPE) {
        return Err(refuse(
            "agents.withdraw_scope_required",
            "agents.refused.withdraw_scope_required",
            vec![s("tool", tool)],
        ));
    }
    if let Some(limit) = grant.max_calls_per_session {
        let used = state
            .tool_calls
            .iter()
            .find(|(t, _)| t == tool)
            .map_or(0, |(_, c)| *c);
        if used >= limit {
            return Err(refuse(
                "agents.tool_call_limit",
                "agents.refused.tool_call_limit",
                vec![s("tool", tool), n("limit", limit)],
            ));
        }
    }
    if grant.requires_approval
        && approved != Some(true)
        && !state.approved_tools.iter().any(|t| t == tool)
    {
        return Err(refuse(
            "agents.approval_required",
            "agents.refused.approval_required",
            vec![s("tool", tool)],
        ));
    }
    if is_place_tool(tool) && idempotency_key.map_or("", str::trim).is_empty() {
        return Err(refuse(
            "agents.place_idempotency_required",
            "agents.refused.place_idempotency_required",
            vec![s("tool", tool)],
        ));
    }
    Ok(())
}

/// \`evaluateCompletion\`: checked against the call's worst case, never its expected cost.
pub fn evaluate_completion(
    g: &Guardrail,
    state: &SessionState,
    task: &str,
    max_output_tokens: i64,
    worst_case_cost: Amount,
    fee_asset_id: &str,
) -> Result<(), Refusal> {
    evaluate_session(g, state)?;
    if !g.limits.allowed_tasks.iter().any(|t| t == task) {
        return Err(refuse(
            "agents.task_not_allowed",
            "agents.refused.task_not_allowed",
            vec![s("task", task)],
        ));
    }
    if max_output_tokens > g.limits.max_output_tokens_per_call {
        return Err(refuse(
            "agents.output_limit",
            "agents.refused.output_limit",
            vec![n("limit", g.limits.max_output_tokens_per_call)],
        ));
    }
    if let Some(cap) = g.limits.max_spend_per_session
        && state.spend + worst_case_cost > cap
    {
        return Err(refuse(
            "agents.spend_limit",
            "agents.refused.spend_limit",
            vec![s("limit", format_amount(cap)), s("asset", fee_asset_id)],
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::json;

    fn g(text: &str) -> Result<Guardrail, Invalid> {
        parse_guardrail(&json::parse(text).unwrap())
    }

    const BASE: &str = r#"{"agentId":"probe","version":1,"capacityMode":"confirm_each","tools":[{"name":"trade.place","module":"trade","mode":"write","requiresApproval":true,"maxCallsPerSession":1}],"limits":{"maxActionsPerSession":5,"maxOutputTokensPerCall":100,"maxSpendPerSession":"1.5","allowedModules":["trade"],"allowedTasks":["chat"]}}"#;

    #[test]
    fn a_guardrail_round_trips_through_its_stored_form() {
        let parsed = g(BASE).unwrap();
        assert_eq!(g(&serialise_guardrail(&parsed).compact()).unwrap(), parsed);
        assert_eq!(
            parsed.limits.max_spend_per_session,
            Some(Amount::from_scaled(1_500_000_000_000_000_000))
        );
    }

    #[test]
    fn contradictions_and_product_money_tools_are_refused_at_parse() {
        assert!(
            g(&BASE.replace(r#""allowedModules":["trade"]"#, r#""allowedModules":[]"#)).is_err()
        );
        assert!(g(&BASE.replace("probe", "navigator")).is_err());
        assert!(g(&BASE.replace(r#""module":"trade""#, r#""module":"nowhere""#)).is_err());
        assert!(g(&BASE.replace("\"1.5\"", "\"1.5e3\"")).is_err());
        assert!(g(&BASE.replace("\"version\":1", "\"version\":1.5")).is_err());
    }

    #[test]
    fn the_tool_rules_refuse_in_their_order() {
        let gr = g(BASE).unwrap();
        let open = SessionState {
            closed: false,
            action_count: 0,
            tool_calls: vec![],
            spend: Amount::ZERO,
            approved_tools: vec![],
        };
        let code = |r: Result<(), Refusal>| r.err().map(|r| r.code);
        assert_eq!(
            code(evaluate_tool_call(&gr, &open, "x", None, None)).as_deref(),
            Some("agents.tool_not_declared")
        );
        assert_eq!(
            code(evaluate_tool_call(
                &gr,
                &open,
                "trade.place",
                None,
                Some("k")
            ))
            .as_deref(),
            Some("agents.approval_required")
        );
        assert_eq!(
            code(evaluate_tool_call(
                &gr,
                &open,
                "trade.place",
                Some(true),
                Some(" ")
            ))
            .as_deref(),
            Some("agents.place_idempotency_required")
        );
        assert_eq!(
            evaluate_tool_call(&gr, &open, "trade.place", Some(true), Some("k")),
            Ok(())
        );
        let used = SessionState {
            tool_calls: vec![("trade.place".to_owned(), 1)],
            ..open.clone()
        };
        assert_eq!(
            code(evaluate_tool_call(
                &gr,
                &used,
                "trade.place",
                Some(true),
                Some("k")
            ))
            .as_deref(),
            Some("agents.tool_call_limit")
        );
        let full = SessionState {
            action_count: 5,
            ..open
        };
        assert_eq!(
            code(evaluate_tool_call(
                &gr,
                &full,
                "trade.place",
                Some(true),
                Some("k")
            ))
            .as_deref(),
            Some("agents.action_limit")
        );
        assert_eq!(
            tool_refusal_codes(&gr, &gr.tools[0]),
            vec![
                "agents.session_closed",
                "agents.action_limit",
                "agents.tool_call_limit",
                "agents.approval_required",
                "agents.place_idempotency_required",
                "agents.place_key_conflict"
            ]
        );
    }
}
