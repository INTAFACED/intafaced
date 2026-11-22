//! What a person's own agent may do with its tools (`services/svc-agents/src/own/guardrails.ts`, the gates;
//! AG-guardrails-01, -02): consent for the tool's class, the owner's baseline narrowed by this environment's override,
//! then the person's standing rule for the tool. Rules only narrow. Nothing here moves value.
//!
//! The approval requests a gate's "ask" stores are in the same TypeScript file and are ported with the calls that
//! hold and decide them.

use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::catalog::own_tools;
use super::{OwnError, OwnRefusal};
use crate::db;
use crate::runtime::ms;

/// `OWN_AGENT_RULE_CHOICES`: strictest first.
pub const RULE_CHOICES: [&str; 4] = [
    "hand_off",
    "ask_before",
    "act_on_request",
    "act_without_asking",
];
/// `OWN_AGENT_DATA_CLASSES`.
pub const DATA_CLASSES: [&str; 4] = ["own_data", "market_data", "draft_write", "live_write"];

/// A choice's place in [`RULE_CHOICES`]: the higher, the looser.
pub fn looseness(choice: &str) -> usize {
    RULE_CHOICES
        .iter()
        .position(|c| *c == choice)
        .unwrap_or(usize::MAX)
}

/// `stricter`: the stricter of two standing choices.
pub fn stricter<'a>(a: &'a str, b: &'a str) -> &'a str {
    if looseness(a) <= looseness(b) { a } else { b }
}

/// The owner's baseline: per class, the loosest choice allowed. A class missing from it is blank.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolicyBaseline(pub Vec<(&'static str, &'static str)>);

impl PolicyBaseline {
    pub fn of(&self, data_class: &str) -> Option<&'static str> {
        self.0
            .iter()
            .find(|(c, _)| *c == data_class)
            .map(|(_, choice)| *choice)
    }
}

/// `parsePolicyBaseline(AGENTS_POLICY_BASELINE)`: unset is blank everywhere; a malformed value stops the boot.
pub fn parse_policy_baseline(value: Option<&str>) -> Result<PolicyBaseline, String> {
    let text = js_trim(value.unwrap_or(""));
    if text.is_empty() {
        return Ok(PolicyBaseline::default());
    }
    let parsed = json::parse(text).map_err(|_| "AGENTS_POLICY_BASELINE is not JSON".to_owned())?;
    let Json::Object(fields) = parsed else {
        return Err("AGENTS_POLICY_BASELINE must be an object".to_owned());
    };
    let mut out: Vec<(&'static str, &'static str)> = Vec::new();
    for (key, choice) in &fields {
        let Some(class) = DATA_CLASSES.iter().find(|c| **c == key.as_str()) else {
            return Err(format!(
                "AGENTS_POLICY_BASELINE names an unknown class: {key}"
            ));
        };
        let Some(choice) = RULE_CHOICES
            .iter()
            .find(|c| matches!(choice, Json::String(s) if s == *c))
        else {
            return Err(format!(
                "AGENTS_POLICY_BASELINE has an unknown choice for {key}"
            ));
        };
        out.retain(|(c, _)| c != class);
        out.push((class, choice));
    }
    Ok(PolicyBaseline(out))
}

/// `classOf`: a tool the agent carries, with its class; one it does not carry refuses as not declared.
pub fn class_of(agent_tools: &[String], tool: &str) -> Result<&'static str, OwnRefusal> {
    own_tools()
        .into_iter()
        .find(|t| t.name == tool)
        .filter(|_| agent_tools.iter().any(|t| t == tool))
        .and_then(|t| t.data_class)
        .ok_or_else(|| OwnRefusal::with("agents.tool_not_declared", [("tool", tool.to_owned())]))
}

/// `checkRule`: the built-in law first, then the baseline.
pub fn check_rule(
    baseline: &PolicyBaseline,
    agent_tools: &[String],
    tool: &str,
    choice: &str,
) -> Result<(), OwnRefusal> {
    let data_class = class_of(agent_tools, tool)?;
    if data_class == "live_write" && choice == "act_without_asking" {
        return Err(OwnRefusal::with(
            "agents.rule_invalid",
            [("tool", tool.to_owned())],
        ));
    }
    if looseness(choice) <= looseness("ask_before") {
        return Ok(());
    }
    let Some(required) = baseline.of(data_class) else {
        return Err(OwnRefusal::with(
            "agents.baseline_value_unset",
            [("dataClass", data_class.to_owned())],
        ));
    };
    if looseness(choice) > looseness(required) {
        return Err(OwnRefusal::with(
            "agents.baseline_loosen_refused",
            [
                ("dataClass", data_class.to_owned()),
                ("required", required.to_owned()),
            ],
        ));
    }
    Ok(())
}

/// `effectiveRequirement`: the baseline, narrowed by this environment's override (`agent_policy_overrides`).
pub fn effective_requirement(
    pool: &Pool,
    baseline: &PolicyBaseline,
    data_class: &str,
) -> Result<Option<String>, OwnError> {
    let Some(required) = baseline.of(data_class) else {
        return Ok(None);
    };
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT choice FROM agents.agent_policy_overrides WHERE data_class = $1::text",
            &[&data_class],
        )?)
    })?;
    let over: Option<String> = rows.first().map(|r| r.try_get(0)).transpose()?;
    Ok(Some(match over {
        Some(o) => stricter(required, &o).to_owned(),
        None => required.to_owned(),
    }))
}

/// What a tool call of the person's own agent comes to, before it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    Run {
        data_class: &'static str,
    },
    Ask {
        data_class: &'static str,
        rule_id: Option<String>,
    },
}

impl Gate {
    pub fn data_class(&self) -> &'static str {
        match self {
            Gate::Run { data_class } | Gate::Ask { data_class, .. } => data_class,
        }
    }
}

/// `gateToolCall`: consent, then baseline, then the person's rule.
pub fn gate_tool_call(
    pool: &Pool,
    baseline: &PolicyBaseline,
    owner_id: &str,
    agent_id: &str,
    agent_tools: &[String],
    tool: &str,
) -> Result<Gate, OwnError> {
    let data_class = class_of(agent_tools, tool)?;
    if !consent_granted(pool, owner_id, agent_id, data_class)? {
        return Err(OwnRefusal::with(
            "agents.consent_required",
            [("dataClass", data_class.to_owned())],
        )
        .into());
    }
    let Some(required) = effective_requirement(pool, baseline, data_class)? else {
        return Err(OwnRefusal::with(
            "agents.baseline_value_unset",
            [("dataClass", data_class.to_owned())],
        )
        .into());
    };
    let rule = rule_for_tool(pool, owner_id, agent_id, tool)?;
    let choice = rule
        .as_ref()
        .map_or(required.as_str(), |r| stricter(&r.choice, &required))
        .to_owned();
    if choice == "hand_off" {
        return Err(OwnRefusal::with("agents.rule_hand_off", [("tool", tool.to_owned())]).into());
    }
    if choice == "ask_before" {
        return Ok(Gate::Ask {
            data_class,
            rule_id: rule.filter(|r| r.choice == choice).map(|r| r.id),
        });
    }
    Ok(Gate::Run { data_class })
}

/// `OwnRuleView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub tool: String,
    pub choice: String,
    pub updated_at: Instant,
}

impl Rule {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("tool", Json::str(self.tool.clone())),
            ("choice", Json::str(self.choice.clone())),
            ("updatedAt", Json::str(self.updated_at.iso())),
        ])
    }
}

fn rule_of(r: &postgres::Row) -> Result<Rule, OwnError> {
    Ok(Rule {
        id: r.try_get(0)?,
        tool: r.try_get(1)?,
        choice: r.try_get(2)?,
        updated_at: Instant(r.try_get(3)?),
    })
}

fn rule_columns() -> String {
    format!("id::text, tool, choice, {}", ms("updated_at"))
}

fn rule_key(agent_id: &str, tool: &str) -> String {
    format!("agents:rule:{agent_id}:own:{tool}")
}

/// `OwnRuleStore.save`: the same rule again is the same row; a new choice replaces the old one.
pub fn save_rule(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    tool: &str,
    choice: &str,
) -> Result<Rule, OwnError> {
    let row = db::with_client(pool, |c| {
        Ok(c.query_one(
            &format!(
                "INSERT INTO agents.own_agent_rules (agent_id, owner_id, tool, choice, rule_key)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text)
                 ON CONFLICT (owner_id, rule_key) DO UPDATE
                   SET choice = EXCLUDED.choice,
                       updated_at = CASE WHEN own_agent_rules.choice = EXCLUDED.choice
                                         THEN own_agent_rules.updated_at ELSE now() END
                 RETURNING {}",
                rule_columns()
            ),
            &[
                &agent_id,
                &owner_id,
                &tool,
                &choice,
                &rule_key(agent_id, tool),
            ],
        )?)
    })?;
    rule_of(&row)
}

/// `OwnRuleStore.list`: in the order they were made.
pub fn list_rules(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Vec<Rule>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_rules
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid ORDER BY created_at, id",
                rule_columns()
            ),
            &[&owner_id, &agent_id],
        )?)
    })?;
    rows.iter().map(rule_of).collect()
}

/// `OwnRuleStore.forTool`.
pub fn rule_for_tool(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    tool: &str,
) -> Result<Option<Rule>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_rules WHERE owner_id = $1::text AND rule_key = $2::text",
                rule_columns()
            ),
            &[&owner_id, &rule_key(agent_id, tool)],
        )?)
    })?;
    rows.first().map(rule_of).transpose()
}

/// `OwnConsentStore.granted`.
pub fn consent_granted(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    data_class: &str,
) -> Result<bool, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT true FROM agents.own_agent_consents
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND data_class = $3::text AND revoked_at IS NULL",
            &[&owner_id, &agent_id, &data_class],
        )?)
    })?;
    Ok(!rows.is_empty())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn tools(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn the_baseline_parses_or_stops_the_boot() {
        assert_eq!(
            parse_policy_baseline(None).unwrap(),
            PolicyBaseline::default()
        );
        let b = parse_policy_baseline(Some(r#"{"own_data":"act_on_request"}"#)).unwrap();
        assert_eq!(b.of("own_data"), Some("act_on_request"));
        assert_eq!(b.of("live_write"), None);
        assert!(parse_policy_baseline(Some("nope")).is_err());
        assert!(parse_policy_baseline(Some("[]")).is_err());
        assert!(parse_policy_baseline(Some(r#"{"x":"hand_off"}"#)).is_err());
        assert!(parse_policy_baseline(Some(r#"{"own_data":"yes"}"#)).is_err());
    }

    #[test]
    fn a_rule_only_narrows() {
        let b = parse_policy_baseline(Some(r#"{"own_data":"act_on_request"}"#)).unwrap();
        let t = tools(&["support.kb.search", "support.ticket.comment"]);
        assert!(check_rule(&b, &t, "support.kb.search", "hand_off").is_ok());
        assert!(check_rule(&b, &t, "support.kb.search", "act_on_request").is_ok());
        assert_eq!(
            check_rule(&b, &t, "support.kb.search", "act_without_asking")
                .unwrap_err()
                .code,
            "agents.baseline_loosen_refused"
        );
        assert_eq!(
            check_rule(&b, &t, "support.ticket.comment", "act_without_asking")
                .unwrap_err()
                .code,
            "agents.rule_invalid"
        );
        assert_eq!(
            check_rule(&b, &t, "support.ticket.comment", "act_on_request")
                .unwrap_err()
                .code,
            "agents.baseline_value_unset"
        );
        assert_eq!(
            check_rule(&b, &t, "trade.quote", "hand_off")
                .unwrap_err()
                .code,
            "agents.tool_not_declared"
        );
        assert_eq!(stricter("ask_before", "hand_off"), "hand_off");
    }
}
