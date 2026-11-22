//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a
//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by
//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.

#[path = "basis_override.rs"]
mod basis_override;
#[path = "boot.rs"]
mod boot;
#[path = "boundaries.rs"]
mod boundaries;
#[path = "choices.rs"]
mod choices;
#[path = "export_blank_map.rs"]
mod export_blank_map;
#[path = "export_parity.rs"]
mod export_parity;
#[path = "input_parity.rs"]
mod input_parity;
#[path = "io_golden.rs"]
mod io_golden;
#[path = "jurisdiction_map.rs"]
mod jurisdiction_map;
#[path = "lot_book.rs"]
mod lot_book;
#[path = "lot_book_inflows.rs"]
mod lot_book_inflows;
#[path = "lot_book_spaces.rs"]
mod lot_book_spaces;
#[path = "lot_book_transfers.rs"]
mod lot_book_transfers;
#[path = "lot_book_venue.rs"]
mod lot_book_venue;
#[path = "lot_engine.rs"]
mod lot_engine;
#[path = "lots.rs"]
mod lots;
#[path = "own_moves.rs"]
mod own_moves;
#[path = "pnl_over_time.rs"]
mod pnl_over_time;
#[path = "procedure_samples.rs"]
mod procedure_samples;
#[path = "refusal_coverage.rs"]
mod refusal_coverage;
#[path = "router_mount.rs"]
mod router_mount;
#[path = "service_parity.rs"]
mod service_parity;
#[path = "stores_pg.rs"]
mod stores_pg;
#[path = "tax_service.rs"]
mod tax_service;
#[path = "venue_book.rs"]
mod venue_book;
#[path = "wire_replay.rs"]
mod wire_replay;
#[path = "year_pack.rs"]
mod year_pack;

// The helpers the files share: `use crate::<helper>;`, never a `mod` of their own.
mod common;

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
