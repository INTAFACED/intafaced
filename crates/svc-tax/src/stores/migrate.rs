//! `svc-tax migrate [--down]` (the TypeScript service's `scripts/migrate.ts`, over the same files): applies every `*.sql` in
//! `crates/svc-tax/migrations` in name order, tracked in `tax.__migrations`, each file once; `--down` reverses them.
//! The `tax` schema comes from the database bootstrap. The files are built into the binary, so the runner needs nothing
//! beside it. Its lines are the TypeScript runner's (`↑`, `·`, `↓`, `✓`).

use std::io::Write;

use postgres::{Client, NoTls};

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

fn ups() -> Vec<(&'static str, &'static str)> {
    let mut ups: Vec<_> = FILES
        .iter()
        .copied()
        .filter(|(name, _)| !name.ends_with(".down.sql"))
        .collect();
    ups.sort_by(|a, b| a.0.cmp(b.0));
    ups
}

fn file(name: &str) -> Result<&'static str, String> {
    FILES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, sql)| *sql)
        .ok_or_else(|| format!("ENOENT: no such file or directory, open '{name}'"))
}

fn db(e: &postgres::Error) -> String {
    e.as_db_error()
        .map_or_else(|| e.to_string(), |d| d.message().to_owned())
}

/// Runs the migrations against `url`, writing the runner's lines to `out`.
pub fn run(url: &str, down: bool, out: &mut impl Write) -> Result<(), String> {
    let mut sql = Client::connect(url, NoTls).map_err(|e| db(&e))?;
    let result = apply(&mut sql, down, out);
    let _ = sql.close();
    result
}

fn apply(sql: &mut Client, down: bool, out: &mut impl Write) -> Result<(), String> {
    let mut say = |line: String| writeln!(out, "{line}").map_err(|e| e.to_string());
    sql.batch_execute(
        "CREATE TABLE IF NOT EXISTS tax.__migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )",
    )
    .map_err(|e| db(&e))?;
    let ups = ups();
    if down {
        for (up, _) in ups.iter().rev() {
            let down_file = format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up));
            say(format!("↓ {down_file}"))?;
            sql.batch_execute(file(&down_file)?).map_err(|e| db(&e))?;
            sql.execute("DELETE FROM tax.__migrations WHERE name = $1", &[up])
                .map_err(|e| db(&e))?;
        }
        say("✓ reversed".to_owned())?;
        return Ok(());
    }
    let applied: Vec<String> = sql
        .query("SELECT name FROM tax.__migrations", &[])
        .map_err(|e| db(&e))?
        .iter()
        .map(|r| r.try_get::<_, String>(0))
        .collect::<Result<_, _>>()
        .map_err(|e| db(&e))?;
    for (name, body) in ups {
        if applied.iter().any(|a| a == name) {
            say(format!("· {name} (already applied)"))?;
            continue;
        }
        say(format!("↑ {name}"))?;
        sql.batch_execute(body).map_err(|e| db(&e))?;
        sql.execute("INSERT INTO tax.__migrations (name) VALUES ($1)", &[&name])
            .map_err(|e| db(&e))?;
    }
    say("✓ migrations up to date".to_owned())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_up_has_its_reversal_built_in() {
        for (up, _) in ups() {
            let down = format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up));
            assert!(file(&down).is_ok(), "{up} has no {down}");
        }
        assert_eq!(ups().len() * 2, FILES.len());
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
