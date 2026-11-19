//! `svc-tax migrate [--down]` (was the TypeScript service's `scripts/migrate.ts`): applies every `*.sql` in
//! `crates/svc-tax/migrations` in name order, tracked in `tax.__migrations`, each file once; `--down` reverses them.
//! The `tax` schema comes from the database bootstrap. The files are built into the binary, so the runner needs nothing
//! beside it. Its lines are the TypeScript runner's (`↑`, `·`, `↓`, `✓`); the runner is the kit's
//! (`service_kit::migrate`).

use std::io::Write;

use service_kit::migrate::Migrations;

/// Every migration file, by name, as built into the binary.
pub const FILES: [(&str, &str); 8] = [
    (
        "0000_basis_override.down.sql",
        include_str!("../../migrations/0000_basis_override.down.sql"),
    ),
    (
        "0000_basis_override.sql",
        include_str!("../../migrations/0000_basis_override.sql"),
    ),
    (
        "0001_basis_override_numeric.down.sql",
        include_str!("../../migrations/0001_basis_override_numeric.down.sql"),
    ),
    (
        "0001_basis_override_numeric.sql",
        include_str!("../../migrations/0001_basis_override_numeric.sql"),
    ),
    (
        "20261024110000_cost_basis_choices.down.sql",
        include_str!("../../migrations/20261024110000_cost_basis_choices.down.sql"),
    ),
    (
        "20261024110000_cost_basis_choices.sql",
        include_str!("../../migrations/20261024110000_cost_basis_choices.sql"),
    ),
    (
        "20261024150000_pnl_settings.down.sql",
        include_str!("../../migrations/20261024150000_pnl_settings.down.sql"),
    ),
    (
        "20261024150000_pnl_settings.sql",
        include_str!("../../migrations/20261024150000_pnl_settings.sql"),
    ),
];

/// The runner's default target when `DATABASE_URL` is unset, as the TypeScript runner's.
pub const DEFAULT_URL: &str = "postgres://svc_tax:svc_tax@localhost:5433/intafaced";

/// svc-tax's migrations, for the kit's runner.
pub const MIGRATIONS: Migrations = Migrations {
    schema: "tax",
    files: &FILES,
    default_url: DEFAULT_URL,
};

/// Runs the migrations against `url`, writing the runner's lines to `out`.
pub fn run(url: &str, down: bool, out: &mut impl Write) -> Result<(), String> {
    MIGRATIONS.run(url, down, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_up_has_its_reversal_built_in() {
        for (up, _) in MIGRATIONS.ups() {
            let down = format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up));
            assert!(MIGRATIONS.file(&down).is_ok(), "{up} has no {down}");
        }
        assert_eq!(MIGRATIONS.ups().len() * 2, FILES.len());
    }

    #[test]
    fn the_built_in_files_are_the_directory_on_disk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".sql"))
            .collect();
        on_disk.sort();
        let mut built: Vec<String> = FILES.iter().map(|(n, _)| (*n).to_owned()).collect();
        built.sort();
        assert_eq!(
            built, on_disk,
            "a migration on disk is not in FILES (or the reverse)"
        );
    }
}
