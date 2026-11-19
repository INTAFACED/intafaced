//! A service's `migrate [--down]` (the TypeScript services' `scripts/migrate.ts`): applies every `*.sql` the service
//! built into its binary in name order, tracked in `<schema>.__migrations`, each file once; `--down` reverses them.
//! The schema comes from the database bootstrap, never from here. Its lines are the TypeScript runner's (`↑`, `·`, `↓`,
//! `✓`).

use std::io::Write;

use postgres::{Client, NoTls};

use crate::pg::db_message;

/// One service's migrations: its schema, every file by name as built into its binary (each up `x.sql` beside its
/// `x.down.sql`), and the runner's default target when `DATABASE_URL` is unset.
#[derive(Debug, Clone, Copy)]
pub struct Migrations {
    pub schema: &'static str,
    pub files: &'static [(&'static str, &'static str)],
    pub default_url: &'static str,
}

impl Migrations {
    /// The up files, in name order.
    pub fn ups(&self) -> Vec<(&'static str, &'static str)> {
        let mut ups: Vec<_> = self
            .files
            .iter()
            .copied()
            .filter(|(name, _)| !name.ends_with(".down.sql"))
            .collect();
        ups.sort_by(|a, b| a.0.cmp(b.0));
        ups
    }

    /// One file's SQL, or the error `readFile` gives for a missing one.
    pub fn file(&self, name: &str) -> Result<&'static str, String> {
        self.files
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, sql)| *sql)
            .ok_or_else(|| format!("ENOENT: no such file or directory, open '{name}'"))
    }

    /// Runs the migrations against `url`, writing the runner's lines to `out`.
    pub fn run(&self, url: &str, down: bool, out: &mut impl Write) -> Result<(), String> {
        let mut sql = Client::connect(url, NoTls).map_err(|e| db_message(&e))?;
        let result = self.apply(&mut sql, down, out);
        let _ = sql.close();
        result
    }

    fn apply(&self, sql: &mut Client, down: bool, out: &mut impl Write) -> Result<(), String> {
        let db = |e: postgres::Error| db_message(&e);
        let schema = self.schema;
        let mut say = |line: String| writeln!(out, "{line}").map_err(|e| e.to_string());
        sql.batch_execute(&format!(
            "CREATE TABLE IF NOT EXISTS {schema}.__migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )"
        ))
        .map_err(db)?;
        let ups = self.ups();
        if down {
            for (up, _) in ups.iter().rev() {
                let down_file = format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up));
                say(format!("↓ {down_file}"))?;
                sql.batch_execute(self.file(&down_file)?).map_err(db)?;
                sql.execute(
                    &format!("DELETE FROM {schema}.__migrations WHERE name = $1"),
                    &[up],
                )
                .map_err(db)?;
            }
            say("✓ reversed".to_owned())?;
            return Ok(());
        }
        let applied: Vec<String> = sql
            .query(&format!("SELECT name FROM {schema}.__migrations"), &[])
            .map_err(db)?
            .iter()
            .map(|r| r.try_get::<_, String>(0))
            .collect::<Result<_, _>>()
            .map_err(db)?;
        for (name, body) in ups {
            if applied.iter().any(|a| a == name) {
                say(format!("· {name} (already applied)"))?;
                continue;
            }
            say(format!("↑ {name}"))?;
            sql.batch_execute(body).map_err(db)?;
            sql.execute(
                &format!("INSERT INTO {schema}.__migrations (name) VALUES ($1)"),
                &[&name],
            )
            .map_err(db)?;
        }
        say("✓ migrations up to date".to_owned())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: [(&str, &str); 4] = [
        ("0002_b.sql", "b"),
        ("0001_a.down.sql", "a down"),
        ("0001_a.sql", "a"),
        ("0002_b.down.sql", "b down"),
    ];
    const SET: Migrations = Migrations {
        schema: "x",
        files: &FILES,
        default_url: "postgres://x@localhost/x",
    };

    #[test]
    fn ups_run_in_name_order_without_their_reversals() {
        assert_eq!(SET.ups(), vec![("0001_a.sql", "a"), ("0002_b.sql", "b")]);
    }

    #[test]
    fn a_missing_file_is_named_as_read_file_names_it() {
        assert_eq!(SET.file("0002_b.down.sql"), Ok("b down"));
        assert_eq!(
            SET.file("0003_c.down.sql"),
            Err("ENOENT: no such file or directory, open '0003_c.down.sql'".to_owned())
        );
    }
}
