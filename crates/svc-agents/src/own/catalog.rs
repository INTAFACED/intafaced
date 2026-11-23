//! What a person's own agent may be built from (`services/svc-agents/src/own/catalog.ts`): the templates, the
//! attachable tools with their declared shapes and refusals, the money tools offered only so their refusal shows, the
//! draft's validator and the findings that stop publishing. A blank spend cap stays blank.

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::s2s::js_length;
use service_kit::schema::js_trim;

use super::OwnRefusal;
use crate::runtime::guardrails::{FLEET_HARD_MONEY_WRITE_TOOLS, PRODUCT_AGENT_IDS};

/// One tool a draft may be offered (`OwnTool`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnTool {
    pub name: String,
    pub module: String,
    pub moves_money: bool,
    /// `own_data`, `market_data`, `draft_write` or `live_write`; none for a money tool.
    pub data_class: Option<&'static str>,
    /// The declared input and output fields, in their order; none when not declared.
    pub shape: Option<Shape>,
    pub refusals: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shape {
    pub input: Vec<(&'static str, &'static str)>,
    pub output: Vec<(&'static str, &'static str)>,
}

impl OwnTool {
    /// The tool as the catalogue answers it (`ownAgentToolSchema`'s order).
    pub fn to_json(&self) -> Json {
        let fields = |f: &[(&str, &str)]| {
            Json::Object(
                f.iter()
                    .map(|(k, v)| ((*k).to_owned(), Json::str(*v)))
                    .collect(),
            )
        };
        Json::obj([
            ("name", Json::str(self.name.clone())),
            ("module", Json::str(self.module.clone())),
            ("movesMoney", Json::Bool(self.moves_money)),
            ("dataClass", self.data_class.map_or(Json::Null, Json::str)),
            (
                "shape",
                self.shape.as_ref().map_or(Json::Null, |s| {
                    Json::obj([("input", fields(&s.input)), ("output", fields(&s.output))])
                }),
            ),
            (
                "refusals",
                Json::Array(self.refusals.iter().map(|r| Json::str(r.clone())).collect()),
            ),
        ])
    }

    /// A write tool: one that acts in the person's name.
    pub fn writes(&self) -> bool {
        matches!(self.data_class, Some("live_write" | "draft_write"))
    }
}

const SUPPORT_GATES: [&str; 6] = [
    "desk_plane_dark",
    "tier_law_blank",
    "tier_not_granted",
    "tool_not_declared",
    "tool_not_in_tier",
    "missing_requester",
];
const NAVIGATOR_GATES: [&str; 6] = [
    "trade_plane_dark",
    "tier_law_blank",
    "tier_not_granted",
    "tool_not_declared",
    "tool_not_in_tier",
    "money_write",
];
const SCANNER_GATES: [&str; 7] = [
    "market_plane_dark",
    "tier_law_blank",
    "tier_not_granted",
    "depth_invalid",
    "tool_not_declared",
    "tool_not_in_tier",
    "money_write",
];

fn refusals(own: &[&str], gates: &[&str]) -> Vec<String> {
    own.iter().chain(gates).map(|s| (*s).to_owned()).collect()
}

fn tool(
    name: &str,
    data_class: &'static str,
    module: &str,
    shape: Option<Shape>,
    refusals: Vec<String>,
) -> OwnTool {
    OwnTool {
        name: name.to_owned(),
        module: module.to_owned(),
        moves_money: false,
        data_class: Some(data_class),
        shape,
        refusals,
    }
}

fn shape(
    input: &[(&'static str, &'static str)],
    output: &[(&'static str, &'static str)],
) -> Option<Shape> {
    Some(Shape {
        input: input.to_vec(),
        output: output.to_vec(),
    })
}

fn read_tools() -> Vec<OwnTool> {
    let mut kb = refusals(
        &[
            "no_live_kb",
            "kb_empty",
            "empty_results",
            "incomplete_article",
        ],
        &SUPPORT_GATES,
    );
    kb.push("agents.kb_search_limit_unset".to_owned());
    vec![
        tool(
            "support.kb.search",
            "own_data",
            "support",
            shape(
                &[
                    ("kbQuery", "text, up to 200 characters"),
                    ("limit", "whole number from 1 to 500, the page size"),
                ],
                &[("articles", "list of { articleKey, titleKey, bodyKey }")],
            ),
            kb,
        ),
        tool(
            "support.ticket.read",
            "own_data",
            "support",
            shape(
                &[("ticketId", "text, up to 120 characters")],
                &[("ticket", "{ ticketId, ownerUserId, status, category }")],
            ),
            refusals(
                &[
                    "missing_fixture",
                    "incomplete_ticket",
                    "not_ticket_owner",
                    "no_live_kb",
                ],
                &SUPPORT_GATES,
            ),
        ),
        tool(
            "identity.account.read",
            "own_data",
            "identity",
            shape(
                &[("userId", "text")],
                &[(
                    "account",
                    "{ userId, status: active, frozen or closed, kycTier }",
                )],
            ),
            refusals(
                &[
                    "no_live_kb",
                    "incomplete_account",
                    "account_owner_mismatch",
                    "missing_fixture",
                    "balance_field_forbidden",
                ],
                &SUPPORT_GATES,
            ),
        ),
        tool(
            "trade.quote",
            "market_data",
            "trade",
            shape(
                &[("marketId", "text, up to 64 characters")],
                &[
                    ("marketId", "text"),
                    ("last", "decimal string"),
                    ("asOf", "time"),
                ],
            ),
            refusals(
                &[
                    "missing_fixture",
                    "incomplete_quote",
                    "invalid_decimal",
                    "stale",
                ],
                &NAVIGATOR_GATES,
            ),
        ),
        tool(
            "trade.markets.list",
            "market_data",
            "trade",
            shape(
                &[("limit", "whole number from 1 to 500, optional")],
                &[(
                    "markets",
                    "list of { marketId, symbol, status: open, halted or closed }",
                )],
            ),
            refusals(
                &["empty_markets", "missing_fixture", "markets_limit_unset"],
                &NAVIGATOR_GATES,
            ),
        ),
        tool(
            "trade.ticker",
            "market_data",
            "trade",
            shape(
                &[("marketId", "text, up to 64 characters")],
                &[
                    ("marketId", "text"),
                    ("last", "decimal string"),
                    ("volume24h", "decimal string"),
                    ("change24hBps", "whole number"),
                    ("asOf", "time"),
                ],
            ),
            refusals(
                &[
                    "missing_fixture",
                    "incomplete_ticker",
                    "invalid_decimal",
                    "stale",
                ],
                &SCANNER_GATES,
            ),
        ),
        tool(
            "trade.book.top",
            "market_data",
            "trade",
            shape(
                &[("marketId", "text, up to 64 characters")],
                &[
                    ("marketId", "text"),
                    ("bid", "decimal string"),
                    ("ask", "decimal string"),
                    ("asOf", "time"),
                ],
            ),
            refusals(
                &[
                    "missing_fixture",
                    "incomplete_book",
                    "invalid_decimal",
                    "stale",
                ],
                &SCANNER_GATES,
            ),
        ),
        tool(
            "pay.metrics.read",
            "own_data",
            "pay",
            None,
            refusals(
                &["pay_plane_dark", "no_live_metrics", "stale", "no_metrics"],
                &[],
            ),
        ),
    ]
}

fn write_tools() -> Vec<OwnTool> {
    vec![tool(
        "support.ticket.comment",
        "live_write",
        "support",
        shape(
            &[
                ("ticketId", "text, up to 120 characters"),
                ("body", "text, up to 4000 characters"),
            ],
            &[("ticketId", "text"), ("commented", "yes")],
        ),
        Vec::new(),
    )]
}

fn money_tool(name: &str) -> OwnTool {
    OwnTool {
        name: name.to_owned(),
        module: name.split('.').next().unwrap_or(name).to_owned(),
        moves_money: true,
        data_class: None,
        shape: None,
        refusals: Vec::new(),
    }
}

/// The tools whose door a person's own agent can reach today; every other attachable tool refuses
/// `agents.tool_not_wired`.
pub const OWN_TOOL_DOORS: [&str; 1] = ["support.kb.search"];
/// The tools whose door only an approval reaches (AG-approvals-01).
pub const OWN_APPROVAL_DOORS: [&str; 1] = ["support.ticket.comment"];

/// What any call of an attachable tool may meet before its door: consent, the baseline, a rule.
const GATE_REFUSALS: [&str; 3] = [
    "agents.consent_required",
    "agents.baseline_value_unset",
    "agents.rule_hand_off",
];

fn gated(mut t: OwnTool) -> OwnTool {
    if t.moves_money || t.shape.is_none() {
        return t;
    }
    let mut r: Vec<String> = GATE_REFUSALS.iter().map(|s| (*s).to_owned()).collect();
    if !OWN_TOOL_DOORS.contains(&t.name.as_str()) {
        r.push("agents.tool_not_wired".to_owned());
    }
    r.append(&mut t.refusals);
    t.refusals = r;
    t
}

/// `OWN_TOOLS`: the read and write tools, gated, then the money tools.
pub fn own_tools() -> Vec<OwnTool> {
    let mut all: Vec<OwnTool> = read_tools()
        .into_iter()
        .chain(write_tools())
        .map(gated)
        .collect();
    all.push(money_tool("ledger.transfer"));
    all.extend(FLEET_HARD_MONEY_WRITE_TOOLS.iter().map(|n| money_tool(n)));
    all
}

/// One tool of the catalogue by name.
pub fn own_tool(name: &str) -> Option<OwnTool> {
    own_tools().into_iter().find(|t| t.name == name)
}

/// `OWN_TEMPLATES`, in their order.
pub const OWN_TEMPLATES: [(&str, &[&str]); 2] = [
    (
        "service-starter",
        &[
            "support.kb.search",
            "support.ticket.read",
            "identity.account.read",
        ],
    ),
    ("blank", &[]),
];

/// The template's tools.
pub fn template_tools(id: &str) -> &'static [&'static str] {
    OWN_TEMPLATES
        .iter()
        .find(|(t, _)| *t == id)
        .map_or(&[], |(_, tools)| tools)
}

/// `OWN_TEMPLATE_IDS`.
pub fn template_ids() -> Vec<&'static str> {
    OWN_TEMPLATES.iter().map(|(id, _)| *id).collect()
}

/// `parseOwnTemplates(AGENTS_OWN_TEMPLATES)`: unset or blank offers every template; `blank` is always offered; an id
/// that is not a template stops the boot.
pub fn parse_own_templates(value: Option<&str>) -> Result<Vec<&'static str>, String> {
    let ids: Vec<&str> = value
        .unwrap_or("")
        .split(',')
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(template_ids());
    }
    for id in &ids {
        if !template_ids().contains(id) {
            return Err(format!(
                "AGENTS_OWN_TEMPLATES names an unknown template: {id}"
            ));
        }
    }
    Ok(template_ids()
        .into_iter()
        .filter(|id| *id == "blank" || ids.contains(id))
        .collect())
}

/// Words the Agents room uses in its own addresses, and the product agents' ids.
pub fn reserved_names() -> Vec<&'static str> {
    let mut names = vec![
        "new",
        "sessions",
        "catalogue",
        "activity",
        "coach",
        "campaigns",
        "limits",
        "usage",
    ];
    names.extend(PRODUCT_AGENT_IDS);
    names
}

pub const NAME_MAX: usize = 64;
pub const INSTRUCTIONS_MAX: usize = 4000;
/// How many agents one person may keep.
pub const OWN_AGENTS_MAX: i64 = 50;

/// A draft as the person wrote it.
pub struct DraftInput<'a> {
    pub name: &'a str,
    pub instructions: &'a str,
    pub tools: Vec<&'a str>,
    /// Blank or absent is unset.
    pub per_session_cap: Option<&'a str>,
}

/// A draft's checked fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftFields {
    pub name: String,
    pub instructions: String,
    pub tools: Vec<String>,
    pub per_session_cap: Option<String>,
}

/// `validateDraft`: refuses the first thing it cannot store, with its reason.
pub fn validate_draft(input: &DraftInput<'_>) -> Result<DraftFields, OwnRefusal> {
    if input.name.contains('\0') || input.instructions.contains('\0') {
        return Err(OwnRefusal::new("agents.own.text_invalid"));
    }
    let name = js_trim(input.name);
    if js_length(name) > NAME_MAX {
        return Err(OwnRefusal::with(
            "agents.own.name_too_long",
            [("limit", NAME_MAX.to_string())],
        ));
    }
    if reserved_names().contains(&name.to_lowercase().as_str()) {
        return Err(OwnRefusal::with(
            "agents.own.reserved_name",
            [("name", name.to_owned())],
        ));
    }
    if js_length(input.instructions) > INSTRUCTIONS_MAX {
        return Err(OwnRefusal::with(
            "agents.own.instructions_too_long",
            [("limit", INSTRUCTIONS_MAX.to_string())],
        ));
    }
    let catalogue = own_tools();
    let mut tools: Vec<String> = Vec::new();
    for raw in &input.tools {
        let Some(t) = catalogue.iter().find(|t| t.name == js_trim(raw)) else {
            return Err(OwnRefusal::with(
                "agents.own.tool_unknown",
                [("tool", (*raw).to_owned())],
            ));
        };
        if t.moves_money {
            return Err(OwnRefusal::with(
                "agents.own.money_tool",
                [("tool", t.name.clone())],
            ));
        }
        if t.shape.is_none() {
            return Err(OwnRefusal::with(
                "agents.tool_shape_missing",
                [("tool", t.name.clone())],
            ));
        }
        if !tools.contains(&t.name) {
            tools.push(t.name.clone());
        }
    }
    Ok(DraftFields {
        name: name.to_owned(),
        instructions: input.instructions.to_owned(),
        tools,
        per_session_cap: parse_cap(input.per_session_cap)?,
    })
}

fn parse_cap(cap: Option<&str>) -> Result<Option<String>, OwnRefusal> {
    let text = js_trim(cap.unwrap_or(""));
    if text.is_empty() {
        return Ok(None);
    }
    match parse_amount(text) {
        Ok(a) if a > 0 => Ok(Some(format_amount(a))),
        _ => Err(OwnRefusal::new("agents.own.cap_invalid")),
    }
}

/// `protectionFindings`: what stops the draft being published.
pub fn protection_findings(name: &str, per_session_cap: Option<&str>) -> Vec<&'static str> {
    let mut findings = Vec::new();
    if per_session_cap.is_none() {
        findings.push("agents.spend.cap_unset");
    }
    if name.is_empty() {
        findings.push("agents.own.name_unset");
    }
    findings
}

/// The findings as an answer carries them: each blocks publishing.
pub fn findings_json(findings: &[&str]) -> Json {
    Json::Array(
        findings
            .iter()
            .map(|c| {
                Json::obj([
                    ("code", Json::str(*c)),
                    ("blocksPublishing", Json::Bool(true)),
                ])
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    // `catalog.test.ts`, case for case where it reads the catalogue and the validator.
    #[test]
    fn a_money_tool_is_listed_and_refused_on_a_draft() {
        let t = own_tool("ledger.transfer").unwrap();
        assert!(t.moves_money);
        let e = validate_draft(&DraftInput {
            name: "x",
            instructions: "",
            tools: vec!["ledger.transfer"],
            per_session_cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code, "agents.own.money_tool");
    }

    #[test]
    fn a_tool_with_no_shape_is_never_attached() {
        let e = validate_draft(&DraftInput {
            name: "x",
            instructions: "",
            tools: vec!["pay.metrics.read"],
            per_session_cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code, "agents.tool_shape_missing");
    }

    #[test]
    fn caps_names_and_tools_are_checked_in_order() {
        let ok = validate_draft(&DraftInput {
            name: "  Helper ",
            instructions: "be kind",
            tools: vec![" support.kb.search", "support.kb.search"],
            per_session_cap: Some(" 1.50 "),
        })
        .unwrap();
        assert_eq!(ok.name, "Helper");
        assert_eq!(ok.tools, vec!["support.kb.search"]);
        assert_eq!(ok.per_session_cap.as_deref(), Some("1.5"));
        for (cap, code) in [
            ("0", "agents.own.cap_invalid"),
            ("abc", "agents.own.cap_invalid"),
        ] {
            let e = validate_draft(&DraftInput {
                name: "x",
                instructions: "",
                tools: vec![],
                per_session_cap: Some(cap),
            })
            .unwrap_err();
            assert_eq!(e.code, code);
        }
        let e = validate_draft(&DraftInput {
            name: "Navigator",
            instructions: "",
            tools: vec![],
            per_session_cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code, "agents.own.reserved_name");
        let long = "x".repeat(65);
        let e = validate_draft(&DraftInput {
            name: &long,
            instructions: "",
            tools: vec![],
            per_session_cap: None,
        })
        .unwrap_err();
        assert_eq!(e.code, "agents.own.name_too_long");
    }

    #[test]
    fn templates_parse_as_the_boot_reads_them() {
        assert_eq!(
            parse_own_templates(None).unwrap(),
            vec!["service-starter", "blank"]
        );
        assert_eq!(parse_own_templates(Some(" blank ")).unwrap(), vec!["blank"]);
        assert_eq!(
            parse_own_templates(Some("service-starter")).unwrap(),
            vec!["service-starter", "blank"]
        );
        assert!(parse_own_templates(Some("nope")).is_err());
    }
}
