//! The store against a real Postgres: the `migrate` binary up, again (each file once) and down, and the TypeScript
//! suite's doctrine check (`holds no money column anywhere in the schema`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use crate::support::TestDb;

const TABLES: &str = "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'blueprint' AND table_name <> '__migrations'";

#[test]
fn migrate_applies_each_file_once_and_down_reverses_them_all() {
    let Some(db) = TestDb::new() else { return };
    let (code, out) = db.binary(false);
    assert_eq!(code, 0, "{out}");
    assert_eq!(out.matches('↑').count(), 2, "{out}");
    let tables: i64 = db.client().query_one(TABLES, &[]).unwrap().get(0);
    assert_eq!(
        tables, 7,
        "blueprints, crews, crew_members, match_runs, mentor_matches, card_shares, card_opens"
    );

    let (code, out) = db.binary(false);
    assert_eq!(code, 0, "{out}");
    assert_eq!(out.matches('↑').count(), 0, "{out}");

    let (code, out) = db.binary(true);
    assert_eq!(code, 0, "{out}");
    assert_eq!(out.matches('↓').count(), 2, "{out}");
    let tables: i64 = db.client().query_one(TABLES, &[]).unwrap().get(0);
    assert_eq!(tables, 0);
}

#[test]
fn holds_no_money_column_anywhere_in_the_schema() {
    let Some(db) = TestDb::migrated() else { return };
    let mut c = db.client();
    let numerics = c
        .query(
            "SELECT table_name::text FROM information_schema.columns WHERE table_schema = 'blueprint' AND data_type = 'numeric'",
            &[],
        )
        .unwrap();
    assert!(numerics.is_empty());
    let xp: String = c
        .query_one(
            "SELECT data_type::text FROM information_schema.columns WHERE table_schema = 'blueprint' AND table_name = 'crews' AND column_name = 'xp'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(xp, "bigint");
}
