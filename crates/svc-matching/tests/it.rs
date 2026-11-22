//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a
//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by
//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.

#[path = "approval_keys.rs"]
mod approval_keys;
#[path = "binary.rs"]
mod binary;
#[path = "book.rs"]
mod book;
#[path = "boot.rs"]
mod boot;
#[path = "bus.rs"]
mod bus;
#[path = "combos.rs"]
mod combos;
#[path = "door_auth.rs"]
mod door_auth;
#[path = "engine.rs"]
mod engine;
#[path = "engine_calls.rs"]
mod engine_calls;
#[path = "env_parity.rs"]
mod env_parity;
#[path = "input_parity.rs"]
mod input_parity;
#[path = "journal_codec.rs"]
mod journal_codec;
#[path = "journal_file.rs"]
mod journal_file;
#[path = "journal_replay.rs"]
mod journal_replay;
#[path = "liquidity_book.rs"]
mod liquidity_book;
#[path = "liquidity_doors.rs"]
mod liquidity_doors;
#[path = "liquidity_engine.rs"]
mod liquidity_engine;
#[path = "operator.rs"]
mod operator;
#[path = "options.rs"]
mod options;
#[path = "order_rules.rs"]
mod order_rules;
#[path = "ported_a_cancel_phantom.rs"]
mod ported_a_cancel_phantom;
#[path = "ported_a_door_guards.rs"]
mod ported_a_door_guards;
#[path = "ported_b_reconcile.rs"]
mod ported_b_reconcile;
#[path = "ported_b_recovery.rs"]
mod ported_b_recovery;
#[path = "ported_b_repair.rs"]
mod ported_b_repair;
#[path = "ported_c_amend_priority.rs"]
mod ported_c_amend_priority;
#[path = "ported_c_order_doors.rs"]
mod ported_c_order_doors;
#[path = "ported_c_positions_mass_cancel.rs"]
mod ported_c_positions_mass_cancel;
#[path = "ported_d_depth.rs"]
mod ported_d_depth;
#[path = "ported_d_lists.rs"]
mod ported_d_lists;
#[path = "ported_d_orders.rs"]
mod ported_d_orders;
#[path = "ported_e_env.rs"]
mod ported_e_env;
#[path = "ported_e_open_lists_market.rs"]
mod ported_e_open_lists_market;
#[path = "ported_e_outgoing_keys.rs"]
mod ported_e_outgoing_keys;
#[path = "ported_e_user_copy.rs"]
mod ported_e_user_copy;
#[path = "ported_f_collars.rs"]
mod ported_f_collars;
#[path = "ported_f_conformance.rs"]
mod ported_f_conformance;
#[path = "ported_f_halt_law.rs"]
mod ported_f_halt_law;
#[path = "ported_f_one_book.rs"]
mod ported_f_one_book;
#[path = "ported_f_split_brain.rs"]
mod ported_f_split_brain;
#[path = "rulebook.rs"]
mod rulebook;
#[path = "serve.rs"]
mod serve;
#[path = "spreads.rs"]
mod spreads;
#[path = "triggers_bracket.rs"]
mod triggers_bracket;
#[path = "triggers_doors.rs"]
mod triggers_doors;
#[path = "triggers_engine.rs"]
mod triggers_engine;
#[path = "triggers_oco.rs"]
mod triggers_oco;
#[path = "venue_doors.rs"]
mod venue_doors;
#[path = "venue_engine.rs"]
mod venue_engine;
#[path = "venue_sessions.rs"]
mod venue_sessions;
#[path = "wire_replay.rs"]
mod wire_replay;

// The helpers the files share: `use crate::<helper>;`, never a `mod` of their own.
mod ported_c_common;

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
