//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a
//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by
//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.

#[path = "counts_as_money.rs"]
mod counts_as_money;
#[path = "integer_aliases.rs"]
mod integer_aliases;
#[path = "metrics_golden.rs"]
mod metrics_golden;
#[path = "migrate_db.rs"]
mod migrate_db;
#[path = "nats_consume.rs"]
mod nats_consume;
#[path = "nats_live.rs"]
mod nats_live;
#[path = "one_outbox.rs"]
mod one_outbox;
#[path = "outbox_db.rs"]
mod outbox_db;
#[path = "server_connections.rs"]
mod server_connections;
#[path = "server_page.rs"]
mod server_page;

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
