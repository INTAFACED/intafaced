//! The programme tests' support works: a migrated database answers through the door.
#![allow(clippy::unwrap_used, reason = "a test")]

#[path = "prog_support/mod.rs"]
mod support;

use svc_academy::ports::Ports;

#[test]
fn a_migrated_database_answers_through_the_door() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(Ports::unwired(), support::settings(&[]));
    let answer = support::call(&door, &[], "health", true, None);
    assert_eq!(answer.0, 200);
    let n: i64 = db
        .client()
        .query_one("SELECT count(*) FROM academy.tournament_seasons", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}
