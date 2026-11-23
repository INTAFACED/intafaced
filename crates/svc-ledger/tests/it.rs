//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a
//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by
//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.

#[path = "agents_ledger_http_pg.rs"]
mod agents_ledger_http_pg;
#[path = "approval_hash.rs"]
mod approval_hash;
#[path = "assets_pg.rs"]
mod assets_pg;
#[path = "balances_pg.rs"]
mod balances_pg;
#[path = "bindings_pg.rs"]
mod bindings_pg;
#[path = "boot.rs"]
mod boot;
#[path = "controls_pg.rs"]
mod controls_pg;
#[path = "controls_sources.rs"]
mod controls_sources;
#[path = "desk_pg.rs"]
mod desk_pg;
#[path = "door_bookings_pg.rs"]
mod door_bookings_pg;
#[path = "engine_doors_pg.rs"]
mod engine_doors_pg;
#[path = "engine_pg.rs"]
mod engine_pg;
#[path = "env_parity.rs"]
mod env_parity;
#[path = "freeze_pg.rs"]
mod freeze_pg;
#[path = "guards_pg.rs"]
mod guards_pg;
#[path = "history_pg.rs"]
mod history_pg;
#[path = "input_parity.rs"]
mod input_parity;
#[path = "metrics.rs"]
mod metrics;
#[path = "ops_reads_pg.rs"]
mod ops_reads_pg;
#[path = "post_recipe_parity.rs"]
mod post_recipe_parity;
#[path = "post_recipe_pg.rs"]
mod post_recipe_pg;
#[path = "posting_parity.rs"]
mod posting_parity;
#[path = "posting_pg.rs"]
mod posting_pg;
#[path = "reconcile_pg.rs"]
mod reconcile_pg;
#[path = "reconcile_tick.rs"]
mod reconcile_tick;
#[path = "reports_parity.rs"]
mod reports_parity;
#[path = "reports_pg.rs"]
mod reports_pg;
#[path = "store_pg.rs"]
mod store_pg;
#[path = "tokens.rs"]
mod tokens;
#[path = "wire_replay.rs"]
mod wire_replay;
#[path = "write_block.rs"]
mod write_block;

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
