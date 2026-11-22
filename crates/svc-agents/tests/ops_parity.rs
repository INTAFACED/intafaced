//! The `ops` slice's fixed lists, held to the TypeScript they are copied from: a list changed on one side fails here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use svc_agents::ops::fleet::{OWN_WRITE_TOOLS, is_own_write_tool};
use svc_agents::ops::{DATA_CLASSES, RULE_CHOICES};
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

/// `OWN_WRITE_TOOLS` is `OWN_TOOLS` filtered to a draft write, a live write or a tool that moves money: every tool the
/// catalogue declares one of those, and the fleet's hard money writes it spreads into `MONEY_TOOLS`.
#[test]
fn the_own_write_tools_are_the_catalogues() {
    let ts = source("services/svc-agents/src/own/catalog.ts");
    let mut declared: Vec<String> = Vec::new();
    let parts: Vec<&str> = ts.split("name: '").skip(1).collect();
    for part in parts {
        let name = part.split('\'').next().unwrap();
        let body = part.split("name: '").next().unwrap();
        let entry = body.split("\n  },").next().unwrap();
        let writes = entry.contains("dataClass: 'live_write'")
            || entry.contains("dataClass: 'draft_write'")
            || entry.contains("movesMoney: true");
        if writes && name.contains('.') {
            declared.push(name.to_owned());
        }
    }
    declared.sort();
    let mut ours = OWN_WRITE_TOOLS.map(str::to_owned).to_vec();
    ours.sort();
    assert_eq!(declared, ours);
    assert!(
        ts.contains("...FLEET_HARD_MONEY_WRITE_TOOLS.map((name) => ({")
            && ts.contains("movesMoney: true,"),
        "MONEY_TOOLS no longer spreads the fleet's hard money writes as money tools"
    );
    assert!(
        FLEET_HARD_MONEY_WRITE_TOOLS
            .iter()
            .all(|t| is_own_write_tool(t))
    );
    assert!(!is_own_write_tool("support.kb.search"));
}
