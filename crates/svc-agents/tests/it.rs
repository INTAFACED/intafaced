//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a
//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by
//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.

#[path = "advisors_pg.rs"]
mod advisors_pg;
#[path = "background_pg.rs"]
mod background_pg;
#[path = "boot.rs"]
mod boot;
#[path = "bus.rs"]
mod bus;
#[path = "env_parity.rs"]
mod env_parity;
#[path = "factories_copy_intel_pg.rs"]
mod factories_copy_intel_pg;
#[path = "factories_merchant_pg.rs"]
mod factories_merchant_pg;
#[path = "factories_parity/main.rs"]
mod factories_parity;
#[path = "factories_scanner_pg.rs"]
mod factories_scanner_pg;
#[path = "factories_support_pg.rs"]
mod factories_support_pg;
#[path = "gateway_parity.rs"]
mod gateway_parity;
#[path = "gateway_pg.rs"]
mod gateway_pg;
#[path = "input_parity.rs"]
mod input_parity;
#[path = "metering_pg.rs"]
mod metering_pg;
#[path = "money_deny.rs"]
mod money_deny;
#[path = "navigator_onchain_pg.rs"]
mod navigator_onchain_pg;
#[path = "navigator_research_pg.rs"]
mod navigator_research_pg;
#[path = "ops_parity.rs"]
mod ops_parity;
#[path = "ops_pg.rs"]
mod ops_pg;
#[path = "own_automation_pg.rs"]
mod own_automation_pg;
#[path = "own_builder_pg.rs"]
mod own_builder_pg;
#[path = "own_controls_pg.rs"]
mod own_controls_pg;
#[path = "own_runs_pg.rs"]
mod own_runs_pg;
#[path = "own_sharing_pg.rs"]
mod own_sharing_pg;
#[path = "own_testing_pg.rs"]
mod own_testing_pg;
#[path = "own_tools_pg.rs"]
mod own_tools_pg;
#[path = "runtime_act_pg.rs"]
mod runtime_act_pg;
#[path = "runtime_doors_pg.rs"]
mod runtime_doors_pg;
#[path = "runtime_parity.rs"]
mod runtime_parity;
#[path = "runtime_reads_pg.rs"]
mod runtime_reads_pg;
#[path = "runtime_think_pg.rs"]
mod runtime_think_pg;
#[path = "session_reads.rs"]
mod session_reads;
#[path = "store_pg.rs"]
mod store_pg;
#[path = "team_pg.rs"]
mod team_pg;
#[path = "webhooks_pg.rs"]
mod webhooks_pg;
#[path = "wire_replay.rs"]
mod wire_replay;

// The helpers the files share: `use crate::<helper>;`, never a `mod` of their own.
mod support;

/// A `tests/*.rs` or `tests/*/main.rs` file this root does not list would never run.
#[test]
fn every_test_file_is_listed() {
    let root = include_str!("it.rs");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut unlisted = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let module = if entry.path().join("main.rs").is_file() {
            Some(name.as_str())
        } else {
            name.strip_suffix(".rs").filter(|stem| *stem != "it")
        };
        if let Some(module) = module
            && !root.contains(&format!("\nmod {module};\n"))
        {
            unlisted.push(name);
        }
    }
    assert!(
        unlisted.is_empty(),
        "tests/it.rs does not list {unlisted:?}, so they never run: run `node tooling/scripts/rust-test-roots.mjs`"
    );
}
