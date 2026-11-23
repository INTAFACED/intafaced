//! The `ops` slice's fixed lists, held to the contracts and the own catalogue: a list changed on one side fails here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use svc_agents::ops::fleet::{OWN_WRITE_TOOLS, is_own_write_tool};
use svc_agents::ops::{DATA_CLASSES, RULE_CHOICES};
use svc_agents::own::catalog::own_tools;
use svc_agents::runtime::guardrails::FLEET_HARD_MONEY_WRITE_TOOLS;

fn source(path: &str) -> String {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../");
    std::fs::read_to_string(format!("{root}{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The quoted strings of `export const <name> = [ ... ] as const` on one line.
fn one_line_list(text: &str, name: &str) -> Vec<String> {
    let line = text
        .lines()
        .find(|l| l.starts_with(&format!("export const {name} = [")))
        .unwrap_or_else(|| panic!("{name} is not exported on one line"));
    line.split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

#[test]
fn the_data_classes_and_rule_choices_are_the_contracts() {
    let ts = source("packages/contracts/src/agents-own.ts");
    assert_eq!(
        DATA_CLASSES.to_vec(),
        one_line_list(&ts, "OWN_AGENT_DATA_CLASSES")
    );
    assert_eq!(
        RULE_CHOICES.to_vec(),
        one_line_list(&ts, "OWN_AGENT_RULE_CHOICES")
    );
}

/// `OWN_WRITE_TOOLS` is the own catalogue filtered to a draft write, a live write or a tool that moves money, besides the
/// fleet's hard money writes the catalogue spreads into its money tools.
#[test]
fn the_own_write_tools_are_the_catalogues() {
    let tools = own_tools();
    let mut declared: Vec<String> = tools
        .iter()
        .filter(|t| {
            (t.data_class == Some("live_write")
                || t.data_class == Some("draft_write")
                || t.moves_money)
                && !FLEET_HARD_MONEY_WRITE_TOOLS.contains(&t.name.as_str())
        })
        .map(|t| t.name.clone())
        .collect();
    declared.sort();
    let mut ours = OWN_WRITE_TOOLS.map(str::to_owned).to_vec();
    ours.sort();
    assert_eq!(declared, ours);
    for hard in FLEET_HARD_MONEY_WRITE_TOOLS {
        let t = tools
            .iter()
            .find(|t| t.name == hard)
            .unwrap_or_else(|| panic!("{hard} is not in the own catalogue's money tools"));
        assert!(t.moves_money, "{hard} moves money");
    }
    assert!(
        FLEET_HARD_MONEY_WRITE_TOOLS
            .iter()
            .all(|t| is_own_write_tool(t))
    );
    assert!(!is_own_write_tool("support.kb.search"));
}
