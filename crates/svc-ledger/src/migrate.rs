//! `svc-ledger migrate [--down]` (`services/svc-ledger/scripts/migrate.ts`): applies every `*.sql` in
//! `crates/svc-ledger/migrations` (the TypeScript service's `drizzle` files, byte for byte, by the same names) in name
//! order, tracked in `ledger.__migrations`, each file once; `--down` reverses every applied one. The `ledger` schema
//! comes from the database bootstrap. The files are built into the binary.
//!
//! The ledger's runner is its own, not the kit's, because it guards the book:
//! - each file and its record commit together under one advisory lock (`ledger.migrate`), so a crash or a second
//!   runner cannot replay a half-applied file;
//! - `0007_purposed_lock_kinds.sql` refuses to invent a purpose for an unnamed lock account;
//! - `--down` runs in one transaction, refuses before reversing anything when an applied file has no `.down.sql`, and
//!   refuses while `ledger.ledger_tx` holds any row.

use std::io::Write;

use postgres::{Client, NoTls, Transaction};

use service_kit::pg::db_message;

/// Every migration file, by name, as built into the binary.
pub const FILES: [(&str, &str); 66] = [
    (
        "0000_ledger_init.down.sql",
        include_str!("../migrations/0000_ledger_init.down.sql"),
    ),
    (
        "0000_ledger_init.sql",
        include_str!("../migrations/0000_ledger_init.sql"),
    ),
    (
        "0001_purpose_keyed_holds.down.sql",
        include_str!("../migrations/0001_purpose_keyed_holds.down.sql"),
    ),
    (
        "0001_purpose_keyed_holds.sql",
        include_str!("../migrations/0001_purpose_keyed_holds.sql"),
    ),
    (
        "0002_durable_freeze.down.sql",
        include_str!("../migrations/0002_durable_freeze.down.sql"),
    ),
    (
        "0002_durable_freeze.sql",
        include_str!("../migrations/0002_durable_freeze.sql"),
    ),
    (
        "0003_commodity_asset_kind.down.sql",
        include_str!("../migrations/0003_commodity_asset_kind.down.sql"),
    ),
    (
        "0003_commodity_asset_kind.sql",
        include_str!("../migrations/0003_commodity_asset_kind.sql"),
    ),
    (
        "0004_multi_asset_seed.down.sql",
        include_str!("../migrations/0004_multi_asset_seed.down.sql"),
    ),
    (
        "0004_multi_asset_seed.sql",
        include_str!("../migrations/0004_multi_asset_seed.sql"),
    ),
    (
        "0005_owner_identifier_space.down.sql",
        include_str!("../migrations/0005_owner_identifier_space.down.sql"),
    ),
    (
        "0005_owner_identifier_space.sql",
        include_str!("../migrations/0005_owner_identifier_space.sql"),
    ),
    (
        "0006_asset_must_exist.down.sql",
        include_str!("../migrations/0006_asset_must_exist.down.sql"),
    ),
    (
        "0006_asset_must_exist.sql",
        include_str!("../migrations/0006_asset_must_exist.sql"),
    ),
    (
        "0007_purposed_lock_kinds.down.sql",
        include_str!("../migrations/0007_purposed_lock_kinds.down.sql"),
    ),
    (
        "0007_purposed_lock_kinds.sql",
        include_str!("../migrations/0007_purposed_lock_kinds.sql"),
    ),
    (
        "0008_purpose_fail_closed.down.sql",
        include_str!("../migrations/0008_purpose_fail_closed.down.sql"),
    ),
    (
        "0008_purpose_fail_closed.sql",
        include_str!("../migrations/0008_purpose_fail_closed.sql"),
    ),
    (
        "0009_idempotency_key_length.down.sql",
        include_str!("../migrations/0009_idempotency_key_length.down.sql"),
    ),
    (
        "0009_idempotency_key_length.sql",
        include_str!("../migrations/0009_idempotency_key_length.sql"),
    ),
    (
        "0010_entry_asset_matches_account.down.sql",
        include_str!("../migrations/0010_entry_asset_matches_account.down.sql"),
    ),
    (
        "0010_entry_asset_matches_account.sql",
        include_str!("../migrations/0010_entry_asset_matches_account.sql"),
    ),
    (
        "0011_purpose_trim_and_available.down.sql",
        include_str!("../migrations/0011_purpose_trim_and_available.down.sql"),
    ),
    (
        "0011_purpose_trim_and_available.sql",
        include_str!("../migrations/0011_purpose_trim_and_available.sql"),
    ),
    (
        "0012_purpose_js_trim_belt.down.sql",
        include_str!("../migrations/0012_purpose_js_trim_belt.down.sql"),
    ),
    (
        "0012_purpose_js_trim_belt.sql",
        include_str!("../migrations/0012_purpose_js_trim_belt.sql"),
    ),
    (
        "0013_tx_posted_outbox.down.sql",
        include_str!("../migrations/0013_tx_posted_outbox.down.sql"),
    ),
    (
        "0013_tx_posted_outbox.sql",
        include_str!("../migrations/0013_tx_posted_outbox.sql"),
    ),
    (
        "0014_purpose_trim_matches_string_trim.down.sql",
        include_str!("../migrations/0014_purpose_trim_matches_string_trim.down.sql"),
    ),
    (
        "0014_purpose_trim_matches_string_trim.sql",
        include_str!("../migrations/0014_purpose_trim_matches_string_trim.sql"),
    ),
    (
        "0015_snapshot_chain_tip.down.sql",
        include_str!("../migrations/0015_snapshot_chain_tip.down.sql"),
    ),
    (
        "0015_snapshot_chain_tip.sql",
        include_str!("../migrations/0015_snapshot_chain_tip.sql"),
    ),
    (
        "0016_tx_key_immutable.down.sql",
        include_str!("../migrations/0016_tx_key_immutable.down.sql"),
    ),
    (
        "0016_tx_key_immutable.sql",
        include_str!("../migrations/0016_tx_key_immutable.sql"),
    ),
    (
        "0017_posted_key_lock.down.sql",
        include_str!("../migrations/0017_posted_key_lock.down.sql"),
    ),
    (
        "0017_posted_key_lock.sql",
        include_str!("../migrations/0017_posted_key_lock.sql"),
    ),
    (
        "0018_posted_claim_bind.down.sql",
        include_str!("../migrations/0018_posted_claim_bind.down.sql"),
    ),
    (
        "0018_posted_claim_bind.sql",
        include_str!("../migrations/0018_posted_claim_bind.sql"),
    ),
    (
        "0019_outbox_amount_string.down.sql",
        include_str!("../migrations/0019_outbox_amount_string.down.sql"),
    ),
    (
        "0019_outbox_amount_string.sql",
        include_str!("../migrations/0019_outbox_amount_string.sql"),
    ),
    (
        "0020_freeze_event_outbox.down.sql",
        include_str!("../migrations/0020_freeze_event_outbox.down.sql"),
    ),
    (
        "0020_freeze_event_outbox.sql",
        include_str!("../migrations/0020_freeze_event_outbox.sql"),
    ),
    (
        "0021_posted_request_fingerprint.down.sql",
        include_str!("../migrations/0021_posted_request_fingerprint.down.sql"),
    ),
    (
        "0021_posted_request_fingerprint.sql",
        include_str!("../migrations/0021_posted_request_fingerprint.sql"),
    ),
    (
        "0022_reconcile_runs.down.sql",
        include_str!("../migrations/0022_reconcile_runs.down.sql"),
    ),
    (
        "0022_reconcile_runs.sql",
        include_str!("../migrations/0022_reconcile_runs.sql"),
    ),
    (
        "0023_entries_immutable.down.sql",
        include_str!("../migrations/0023_entries_immutable.down.sql"),
    ),
    (
        "0023_entries_immutable.sql",
        include_str!("../migrations/0023_entries_immutable.sql"),
    ),
    (
        "0024_operator_access_log.down.sql",
        include_str!("../migrations/0024_operator_access_log.down.sql"),
    ),
    (
        "0024_operator_access_log.sql",
        include_str!("../migrations/0024_operator_access_log.sql"),
    ),
    (
        "0025_asset_registry.down.sql",
        include_str!("../migrations/0025_asset_registry.down.sql"),
    ),
    (
        "0025_asset_registry.sql",
        include_str!("../migrations/0025_asset_registry.sql"),
    ),
    (
        "0026_operator_access_log_lookups.down.sql",
        include_str!("../migrations/0026_operator_access_log_lookups.down.sql"),
    ),
    (
        "0026_operator_access_log_lookups.sql",
        include_str!("../migrations/0026_operator_access_log_lookups.sql"),
    ),
    (
        "0027_reconciliation_controls.down.sql",
        include_str!("../migrations/0027_reconciliation_controls.down.sql"),
    ),
    (
        "0027_reconciliation_controls.sql",
        include_str!("../migrations/0027_reconciliation_controls.sql"),
    ),
    (
        "0028_operator_access_log_desk.down.sql",
        include_str!("../migrations/0028_operator_access_log_desk.down.sql"),
    ),
    (
        "0028_operator_access_log_desk.sql",
        include_str!("../migrations/0028_operator_access_log_desk.sql"),
    ),
    (
        "0029_account_metadata.down.sql",
        include_str!("../migrations/0029_account_metadata.down.sql"),
    ),
    (
        "0029_account_metadata.sql",
        include_str!("../migrations/0029_account_metadata.sql"),
    ),
    (
        "20261029130725_reconciliation_control_lifecycle.down.sql",
        include_str!("../migrations/20261029130725_reconciliation_control_lifecycle.down.sql"),
    ),
    (
        "20261029130725_reconciliation_control_lifecycle.sql",
        include_str!("../migrations/20261029130725_reconciliation_control_lifecycle.sql"),
    ),
    (
        "20261029160000_reconciliation_evaluation_feed.down.sql",
        include_str!("../migrations/20261029160000_reconciliation_evaluation_feed.down.sql"),
    ),
    (
        "20261029160000_reconciliation_evaluation_feed.sql",
        include_str!("../migrations/20261029160000_reconciliation_evaluation_feed.sql"),
    ),
    (
        "20261110103023_reconcile_nothing_to_compare.down.sql",
        include_str!("../migrations/20261110103023_reconcile_nothing_to_compare.down.sql"),
    ),
    (
        "20261110103023_reconcile_nothing_to_compare.sql",
        include_str!("../migrations/20261110103023_reconcile_nothing_to_compare.sql"),
    ),
];

/// The runner's default target when `DATABASE_URL` is unset, as the TypeScript runner's.
pub const DEFAULT_URL: &str = "postgres://svc_ledger:svc_ledger@localhost:5433/intafaced";

fn db(e: &postgres::Error) -> String {
    db_message(e)
}

/// The same key for up and down, so two runners cannot apply one file.
fn lock(tx: &mut Transaction<'_>) -> Result<(), String> {
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext('ledger.migrate')::bigint)",
        &[],
    )
    .map(|_| ())
    .map_err(|e| db(&e))
}

/// Runs the built-in migrations against `url`, writing the runner's lines to `out`.
pub fn run(url: &str, down: bool, out: &mut impl Write) -> Result<(), String> {
    let mut sql = Client::connect(url, NoTls).map_err(|e| db(&e))?;
    let result = apply(&mut sql, &FILES, down, out);
    let _ = sql.close();
    result
}

/// `runMigrations(sql, { migrationsDir, down })` over `files` (name, body), as the TypeScript runner reads a folder.
pub fn apply(
    sql: &mut Client,
    files: &[(&str, &str)],
    down: bool,
    out: &mut impl Write,
) -> Result<(), String> {
    let mut say = |line: String| writeln!(out, "{line}").map_err(|e| e.to_string());
    let file = |name: &str| {
        files
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, body)| *body)
    };
    // The bootstrap schema is owned by this service. Serialize tracking DDL too.
    let mut tx = sql.transaction().map_err(|e| db(&e))?;
    lock(&mut tx)?;
    tx.batch_execute(
        "CREATE TABLE IF NOT EXISTS ledger.__migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )",
    )
    .map_err(|e| db(&e))?;
    tx.commit().map_err(|e| db(&e))?;

    let mut ups: Vec<&str> = files
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| n.ends_with(".sql") && !n.ends_with(".down.sql"))
        .collect();
    ups.sort_unstable();

    if down {
        // One transaction owns the book check, every reversal, and its tracking row.
        let mut tx = sql.transaction().map_err(|e| db(&e))?;
        lock(&mut tx)?;
        let applied: Vec<String> = tx
            .query("SELECT name FROM ledger.__migrations", &[])
            .map_err(|e| db(&e))?
            .iter()
            .map(|r| r.try_get::<_, String>(0))
            .collect::<Result<_, _>>()
            .map_err(|e| db(&e))?;
        let selected: Vec<(&str, String)> = ups
            .iter()
            .filter(|up| applied.iter().any(|a| a == *up))
            .map(|up| {
                (
                    *up,
                    format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up)),
                )
            })
            .collect();
        for (_, down_file) in &selected {
            if file(down_file).is_none() {
                return Err(format!("refusing --down: missing {down_file}"));
            }
        }
        if applied.iter().any(|a| a == "0000_ledger_init.sql") {
            tx.query(
                "SELECT id FROM ledger.chain_tip WHERE id = true FOR UPDATE",
                &[],
            )
            .map_err(|e| db(&e))?;
            tx.batch_execute("LOCK TABLE ledger.ledger_tx IN SHARE ROW EXCLUSIVE MODE")
                .map_err(|e| db(&e))?;
            let existing = tx
                .query("SELECT 1 FROM ledger.ledger_tx LIMIT 1", &[])
                .map_err(|e| db(&e))?;
            if !existing.is_empty() {
                return Err("refusing --down: ledger.ledger_tx is not empty".to_owned());
            }
        }
        for (up, down_file) in selected.iter().rev() {
            say(format!("↓ {down_file}"))?;
            tx.batch_execute(file(down_file).unwrap_or_default())
                .map_err(|e| db(&e))?;
            tx.execute("DELETE FROM ledger.__migrations WHERE name = $1", &[up])
                .map_err(|e| db(&e))?;
        }
        tx.commit().map_err(|e| db(&e))?;
        say("✓ reversed".to_owned())?;
        return Ok(());
    }

    for name in ups {
        let mut tx = sql.transaction().map_err(|e| db(&e))?;
        lock(&mut tx)?;
        let seen = tx
            .query(
                "SELECT name FROM ledger.__migrations WHERE name = $1",
                &[&name],
            )
            .map_err(|e| db(&e))?;
        let already = !seen.is_empty();
        if !already {
            if name == "0007_purposed_lock_kinds.sql" {
                tx.batch_execute("LOCK TABLE ledger.accounts IN SHARE ROW EXCLUSIVE MODE")
                    .map_err(|e| db(&e))?;
                let unnamed = tx
                    .query(
                        "SELECT id FROM ledger.accounts WHERE kind IN ('escrow', 'stake', 'collateral') AND purpose = '' LIMIT 1",
                        &[],
                    )
                    .map_err(|e| db(&e))?;
                if !unnamed.is_empty() {
                    return Err(
                        "Cannot apply 0007: unnamed lock claim; refusing invented legacy purpose"
                            .to_owned(),
                    );
                }
            }
            tx.batch_execute(file(name).unwrap_or_default())
                .map_err(|e| db(&e))?;
            tx.execute(
                "INSERT INTO ledger.__migrations (name) VALUES ($1)",
                &[&name],
            )
            .map_err(|e| db(&e))?;
        }
        tx.commit().map_err(|e| db(&e))?;
        say(if already {
            format!("· {name} (already applied)")
        } else {
            format!("↑ {name}")
        })?;
    }
    say("✓ migrations up to date".to_owned())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::panic,
        reason = "a test: a failure is the point"
    )]
    use super::*;

    fn sql_files(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "sql"))
            .map(|p| {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                (name, std::fs::read(&p).unwrap())
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn every_up_has_its_reversal_built_in() {
        for (up, _) in FILES.iter().filter(|(n, _)| !n.ends_with(".down.sql")) {
            let down = format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up));
            assert!(FILES.iter().any(|(n, _)| *n == down), "{up} has no {down}");
        }
    }

    #[test]
    fn the_built_in_files_are_the_directory_on_disk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let on_disk: Vec<(String, Vec<u8>)> = sql_files(&dir);
        let mut built: Vec<(String, Vec<u8>)> = FILES
            .iter()
            .map(|(n, b)| ((*n).to_owned(), b.as_bytes().to_vec()))
            .collect();
        built.sort();
        assert_eq!(built, on_disk, "FILES is not the migrations folder");
    }

    /// While the TypeScript service runs, its `drizzle` folder and this crate's `migrations` are one set of files.
    #[test]
    fn the_migrations_are_the_typescript_services_byte_for_byte() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let ts = root.join("../../services/svc-ledger/drizzle");
        if !ts.exists() {
            return;
        }
        let ours = sql_files(&root.join("migrations"));
        let theirs = sql_files(&ts);
        let names = |v: &[(String, Vec<u8>)]| v.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
        assert_eq!(names(&ours), names(&theirs), "the same file names");
        for ((name, a), (_, b)) in ours.iter().zip(&theirs) {
            assert!(
                a == b,
                "{name} differs from services/svc-ledger/drizzle/{name}"
            );
        }
    }
}
