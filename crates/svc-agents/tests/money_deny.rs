//! The agents' money-tool deny lists hold the tools that move value: the guard the TypeScript service's honesty
//! keepers held (`copy-intel/money-deny-honesty.ts`, `merchant/guardrail-honesty.ts`,
//! `navigator/money-deny-honesty.ts`, `support-agent/money-deny-honesty.ts`, kept by `tooling/ci/dead-code.mjs`'s
//! KEEPERS). Dropping one of these tools from a list would let that agent be granted it with every other gate green.
#![allow(clippy::panic, reason = "a test: a failure is the point")]

use svc_agents::factories::{copy_intel, merchant, support};
use svc_agents::navigator::tools as navigator;

fn holds(agent: &str, list: &[&str], tools: &[&str]) {
    for t in tools {
        assert!(
            list.contains(t),
            "{agent}'s money deny list no longer holds {t}"
        );
    }
}

#[test]
fn every_agents_money_deny_list_holds_the_tools_that_move_value() {
    holds(
        "navigator",
        &navigator::MONEY_WRITE_TOOLS,
        &["ledger.post", "trade.order", "bank.transfer"],
    );
    holds(
        "copy-intel",
        &copy_intel::MONEY_WRITE_TOOLS,
        &["ledger.post", "trade.order", "trade.copy.follow"],
    );
    holds(
        "merchant",
        &merchant::MONEY_WRITE_TOOLS,
        &["ledger.post", "pay.route.change"],
    );
    holds(
        "support",
        &support::MONEY_TOOLS,
        &["ledger.post", "pay.refund", "trade.order"],
    );
}
