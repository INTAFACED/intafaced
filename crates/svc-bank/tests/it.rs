//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a
//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by
//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.

#[path = "closure_body.rs"]
mod closure_body;
#[path = "credit_previews.rs"]
mod credit_previews;
#[path = "earn_db.rs"]
mod earn_db;
#[path = "env_parity.rs"]
mod env_parity;
#[path = "guard_grid.rs"]
mod guard_grid;
#[path = "input_parity.rs"]
mod input_parity;
#[path = "loans_collateral_db.rs"]
mod loans_collateral_db;
#[path = "loans_db.rs"]
mod loans_db;
#[path = "partner_db.rs"]
mod partner_db;
#[path = "partner_probe.rs"]
mod partner_probe;
#[path = "spaces_db.rs"]
mod spaces_db;
#[path = "store_pg.rs"]
mod store_pg;
#[path = "transfers_guards_db.rs"]
mod transfers_guards_db;
#[path = "transfers_schedules_db.rs"]
mod transfers_schedules_db;
#[path = "transfers_send_db.rs"]
mod transfers_send_db;
#[path = "transfers_step_up_db.rs"]
mod transfers_step_up_db;
#[path = "transfers_terms_db.rs"]
mod transfers_terms_db;
#[path = "transfers_withdrawal_db.rs"]
mod transfers_withdrawal_db;
#[path = "wire_replay.rs"]
mod wire_replay;

// The helpers the files share: `use crate::<helper>;`, never a `mod` of their own.
mod loans_kit;
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
