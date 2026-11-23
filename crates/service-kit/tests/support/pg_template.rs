//! A migrated template database for a service's database suites: the service's own `migrate` binary runs once per
//! set of migrations, on a bootstrapped database, and each test then gets a copy, which Postgres makes file by file
//! instead of running every migration again. Shared by the services' test harnesses (`#[path]`); the kit's own tests
//! need no database.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test harness: each suite uses part of it, and a failure is the point"
)]

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::process::Command;

use postgres::{Client, NoTls};

/// The template for the migrations in `migrations`, named by their content (`itf_tpl_<service>_<hash>_test`), made if it
/// is not there yet: `bootstrap` (the extensions and the schema `tooling/infra/postgres-init` makes), then `bin migrate`.
/// It is marked a template only once that passed, so a run that died half way makes it again. Another test process
/// waits on the same advisory lock and reuses it. Call it once per process (each harness keeps it in a `OnceLock`).
pub fn template(
    admin: &str,
    service: &str,
    migrations: &Path,
    bin: &str,
    bootstrap: &str,
) -> String {
    let mut files: Vec<_> = std::fs::read_dir(migrations)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let mut h = DefaultHasher::new();
    for f in &files {
        f.file_name().hash(&mut h);
        std::fs::read(f).unwrap().hash(&mut h);
    }
    let name = format!("itf_tpl_{service}_{:016x}_test", h.finish());
    let mut a = Client::connect(admin, NoTls).unwrap();
    a.execute("SELECT pg_advisory_lock(hashtext($1))", &[&name])
        .unwrap();
    let ready: Option<bool> = a
        .query_opt(
            "SELECT datistemplate FROM pg_database WHERE datname = $1",
            &[&name],
        )
        .unwrap()
        .map(|r| r.get(0));
    if ready != Some(true) {
        a.batch_execute(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))
            .unwrap();
        a.batch_execute(&format!("CREATE DATABASE \"{name}\""))
            .unwrap();
        let mut url = url::Url::parse(admin).unwrap();
        url.set_path(&format!("/{name}"));
        Client::connect(url.as_str(), NoTls)
            .unwrap()
            .batch_execute(bootstrap)
            .unwrap();
        let out = Command::new(bin)
            .arg("migrate")
            .env("DATABASE_URL", url.as_str())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "migrate: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        a.batch_execute(&format!("ALTER DATABASE \"{name}\" IS_TEMPLATE true"))
            .unwrap();
    }
    a.execute("SELECT pg_advisory_unlock(hashtext($1))", &[&name])
        .unwrap();
    name
}

/// Makes `name` a fresh copy of `template`, dropping any database already under that name.
pub fn copy(admin: &str, name: &str, template: &str) {
    let mut a = Client::connect(admin, NoTls).unwrap();
    a.batch_execute(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))
        .unwrap();
    a.batch_execute(&format!(
        "CREATE DATABASE \"{name}\" TEMPLATE \"{template}\""
    ))
    .unwrap();
}
