//! Who may use an agent under its published law (\`fleet/eligibility.ts\`, J-agents-01 #2), and the law itself
//! (\`tier-laws.ts\`, \`AGENTS_TIER_LAWS\`): the scanner, navigator and support doors gate on the signed principal's tier,
//! and refuse everyone while their law is unpublished. The verdict is those doors' own gate on the same law and tier.

use service_kit::json::{self, Json};

/// One door's law: unpublished, or each tier's grant in the law's own key order. A grant keeps the scanner's depth.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Law {
    #[default]
    Unpublished,
    Published(Vec<(String, Grant)>),
}

/// A tier's grant: the tools, and the scanner's \`maxSignals\`.
#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub max_signals: Option<f64>,
    pub tools: Vec<String>,
}

/// \`TierLaws\`: none for a door is unpublished.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TierLaws {
    pub scanner: Option<Law>,
    pub navigator: Option<Law>,
    pub support: Option<Law>,
}

fn tools(v: &Json) -> Result<Vec<String>, String> {
    let Json::Array(items) = v else {
        return Err("a tool list is not an array".to_owned());
    };
    if items.len() > 100 {
        return Err("a tool list holds more than 100".to_owned());
    }
    items
        .iter()
        .map(|t| match t {
            Json::String(s) if (1..=120).contains(&s.encode_utf16().count()) => Ok(s.clone()),
            _ => Err("a tool is not a name of 1 to 120 characters".to_owned()),
        })
        .collect()
}

fn law(v: &Json, scanner: bool) -> Result<Law, String> {
    let Json::Object(fields) = v else {
        return Err("a law is not an object".to_owned());
    };
    match v.get("published") {
        Some(Json::Bool(false)) => {
            if fields.len() != 1 {
                return Err("an unpublished law holds more than published".to_owned());
            }
            Ok(Law::Unpublished)
        }
        Some(Json::Bool(true)) => {
            if fields
                .iter()
                .any(|(k, _)| k != "published" && k != "matrix")
                || fields.len() != 2
            {
                return Err("a published law holds published and matrix only".to_owned());
            }
            let Some(Json::Object(matrix)) = v.get("matrix") else {
                return Err("a published law's matrix is not an object".to_owned());
            };
            let mut grants = Vec::new();
            for (tier, grant) in json::js_key_order(matrix.clone()) {
                let g = if scanner {
                    let Json::Object(gf) = &grant else {
                        return Err("a scanner grant is not an object".to_owned());
                    };
                    if gf.iter().any(|(k, _)| k != "maxSignals" && k != "tools") {
                        return Err("a scanner grant holds maxSignals and tools only".to_owned());
                    }
                    let max = match grant.get("maxSignals") {
                        Some(Json::Number(n)) if n.fract() == 0.0 && (0.0..=100.0).contains(n) => {
                            *n
                        }
                        _ => {
                            return Err("maxSignals is not a whole number from 0 to 100".to_owned());
                        }
                    };
                    Grant {
                        max_signals: Some(max),
                        tools: tools(grant.get("tools").unwrap_or(&Json::Null))?,
                    }
                } else {
                    Grant {
                        max_signals: None,
                        tools: tools(&grant)?,
                    }
                };
                grants.push((tier, g));
            }
            Ok(Law::Published(grants))
        }
        _ => Err("a law's published is not a boolean".to_owned()),
    }
}

/// \`parseTierLaws\`: blank is no law; a malformed value refuses boot (\`agents.tier_laws_invalid\`).
pub fn parse_tier_laws(raw: Option<&str>) -> Result<TierLaws, String> {
    let Some(raw) = raw.filter(|r| !r.trim().is_empty()) else {
        return Ok(TierLaws::default());
    };
    let invalid = |d: String| format!("AGENTS_TIER_LAWS is not a valid tier law: {d}");
    let parsed = json::parse(raw).map_err(|e| invalid(e.message))?;
    let Json::Object(fields) = &parsed else {
        return Err(invalid("not an object".to_owned()));
    };
    let mut laws = TierLaws::default();
    for (k, v) in fields {
        match k.as_str() {
            "scanner" => laws.scanner = Some(law(v, true).map_err(invalid)?),
            "navigator" => laws.navigator = Some(law(v, false).map_err(invalid)?),
            "support" => laws.support = Some(law(v, false).map_err(invalid)?),
            other => return Err(invalid(format!("unrecognized key \"{other}\""))),
        }
    }
    Ok(laws)
}

/// The navigator, support and scanner doors' gate: none when open, else its reason.
fn gate(law: Option<&Law>, tier: &str, scanner: bool) -> Option<&'static str> {
    let Some(Law::Published(matrix)) = law else {
        return Some("tier_law_blank");
    };
    if matrix.is_empty() {
        return Some("tier_law_blank");
    }
    if tier.is_empty() {
        return Some("tier_not_granted");
    }
    let Some((_, grant)) = matrix.iter().find(|(t, _)| t == tier) else {
        return Some("tier_not_granted");
    };
    if scanner && grant.max_signals.is_none_or(|m| m < 1.0) {
        return Some("depth_invalid");
    }
    None
}

/// \`agentEligibility\`.
pub fn agent_eligibility(agent_id: &str, laws: &TierLaws, tier: &str) -> Json {
    let your_plan = service_kit::schema::js_trim(tier).to_owned();
    let (law, scanner) = match agent_id {
        "navigator" => (laws.navigator.as_ref(), false),
        "support" => (laws.support.as_ref(), false),
        "scanner" => (laws.scanner.as_ref(), true),
        _ => {
            return Json::obj([
                ("rule", Json::str("none")),
                ("eligible", Json::Bool(true)),
                ("reason", Json::Null),
                ("code", Json::Null),
                ("yourPlan", Json::str(your_plan)),
            ]);
        }
    };
    let plans: Vec<Json> = match law {
        Some(Law::Published(m)) => m.iter().map(|(t, _)| Json::str(t.clone())).collect(),
        _ => Vec::new(),
    };
    let refused = gate(law, &your_plan, scanner);
    Json::obj([
        ("rule", Json::str("plan")),
        ("published", Json::Bool(!plans.is_empty())),
        ("plans", Json::Array(plans)),
        ("yourPlan", Json::str(your_plan.clone())),
        ("eligible", Json::Bool(refused.is_none())),
        (
            "reason",
            if refused.is_none() {
                Json::Null
            } else {
                Json::str("plan")
            },
        ),
        (
            "code",
            refused.map_or(Json::Null, |r| Json::str(format!("agents.{r}"))),
        ),
    ])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_blank_law_refuses_the_gated_doors_and_a_malformed_one_refuses_boot() {
        let none = parse_tier_laws(None).unwrap();
        let v = agent_eligibility("navigator", &none, "basic");
        assert_eq!(v.get("code"), Some(&Json::str("agents.tier_law_blank")));
        assert_eq!(v.get("published"), Some(&Json::Bool(false)));
        assert_eq!(
            agent_eligibility("merchant", &none, " full ").get("yourPlan"),
            Some(&Json::str("full"))
        );
        assert!(parse_tier_laws(Some("{\"other\":{}}")).is_err());
        assert!(parse_tier_laws(Some("{\"scanner\":{\"published\":true,\"matrix\":{\"full\":{\"maxSignals\":1.5,\"tools\":[]}}}}")).is_err());
    }

    #[test]
    fn a_published_law_grants_its_plans_in_javascript_key_order() {
        let laws = parse_tier_laws(Some(
            "{\"scanner\":{\"published\":true,\"matrix\":{\"full\":{\"maxSignals\":0,\"tools\":[]},\"basic\":{\"maxSignals\":3,\"tools\":[\"a\"]}}},\"support\":{\"published\":true,\"matrix\":{\"b\":[],\"2\":[]}}}",
        ))
        .unwrap();
        let s = agent_eligibility("scanner", &laws, "full");
        assert_eq!(s.get("code"), Some(&Json::str("agents.depth_invalid")));
        assert_eq!(
            agent_eligibility("scanner", &laws, "basic").get("eligible"),
            Some(&Json::Bool(true))
        );
        let plans = agent_eligibility("support", &laws, "x");
        assert_eq!(
            plans.get("plans"),
            Some(&Json::Array(vec![Json::str("2"), Json::str("b")]))
        );
        assert_eq!(
            plans.get("code"),
            Some(&Json::str("agents.tier_not_granted"))
        );
    }
}
