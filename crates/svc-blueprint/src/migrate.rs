//! `svc-blueprint migrate [--down]` (`services/svc-blueprint/scripts/migrate.ts`): applies every `*.sql` in
//! `crates/svc-blueprint/migrations` (the TypeScript service's `drizzle` files, byte for byte, by the same names) in name
//! order, tracked in `blueprint.__migrations`, each file once; `--down` reverses them in reverse order. The `blueprint`
//! schema comes from the database bootstrap. The files are built into the binary. The runner is the kit's
//! (`service_kit::migrate`): the TypeScript runner's lines, and each file committed with its record under one lock.

use std::io::Write;

use service_kit::migrate::Migrations;

/// Every migration file, by name, as built into the binary.
pub const FILES: [(&str, &str); 4] = [
    (
        "0000_blueprint_init.down.sql",
        include_str!("../migrations/0000_blueprint_init.down.sql"),
    ),
    (
        "0000_blueprint_init.sql",
        include_str!("../migrations/0000_blueprint_init.sql"),
    ),
    (
        "0001_card_shares.down.sql",
        include_str!("../migrations/0001_card_shares.down.sql"),
    ),
    (
        "0001_card_shares.sql",
        include_str!("../migrations/0001_card_shares.sql"),
    ),
];

/// The runner's default target when `DATABASE_URL` is unset, as the TypeScript runner's.
pub const DEFAULT_URL: &str = "postgres://svc_blueprint:svc_blueprint@localhost:5433/intafaced";

/// svc-blueprint's migrations, for the kit's runner.
pub const MIGRATIONS: Migrations = Migrations {
    schema: "blueprint",
    files: &FILES,
    default_url: DEFAULT_URL,
};

/// Runs the migrations against `url`, writing the runner's lines to `out`.
pub fn run(url: &str, down: bool, out: &mut impl Write) -> Result<(), String> {
    MIGRATIONS.run(url, down, out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn every_up_has_its_reversal_built_in() {
        for (up, _) in MIGRATIONS.ups() {
            let down = format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up));
            assert!(MIGRATIONS.file(&down).is_ok(), "{up} has no {down}");
        }
        assert_eq!(MIGRATIONS.ups().len() * 2, FILES.len());
    }

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
    fn the_built_in_files_are_the_directory_on_disk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut built: Vec<(String, Vec<u8>)> = FILES
            .iter()
            .map(|(n, s)| ((*n).to_owned(), s.as_bytes().to_vec()))
            .collect();
        built.sort();
        assert!(
            built == sql_files(&dir),
            "FILES is not the migrations folder"
        );
    }

    /// Until the switch deletes the TypeScript service, its `drizzle` folder is the one the stacks migrate with: the
    /// copies here must stay the same files, byte for byte.
    #[test]
    fn the_copies_are_the_typescript_services_drizzle_files() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let drizzle = root.join("../../services/svc-blueprint/drizzle");
        if !drizzle.is_dir() {
            return; // the switch deleted it: the copies are the reference now
        }
        assert!(
            sql_files(&drizzle) == sql_files(&root.join("migrations")),
            "crates/svc-blueprint/migrations is not services/svc-blueprint/drizzle: copy the changed file across"
        );
    }
}
