//! The freeze and the score writes on real Postgres: `freeze-replaces-snapshot.test.ts`,
//! `standing-not-after-freeze.test.ts`, and what the TypeScript could only pin by reading its source
//! (`tournaments/wire-tx-atomic.test.ts`): a crash at each point inside the freeze, a single write and a bulk write
//! leaves nothing half-done, and a serialization failure is retried as `transaction()` retries it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::prog_support as support;

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::{Duration, Instant as Clock};

use service_kit::time::{Instant, js_date};
use svc_academy::db::Store;
use svc_academy::errors::Refusal;
use svc_academy::programme::tournaments::bulk::ScorePatch;
use svc_academy::programme::tournaments::ladder::{RankedStanding, SeasonRecord, SeasonStatus};
use svc_academy::programme::tournaments::service::{
    BulkOutcome, NoSeam, Point, Seam, SnapshotRow, StoredSnapshot, Tournaments,
};

const ALICE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const BOB: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const CAROL: &str = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";

fn now() -> Instant {
    svc_academy::door::system_now()
}

fn academy<'a>(store: &'a Store, seam: &'a dyn Seam) -> Tournaments<'a> {
    Tournaments {
        store,
        enabled: true,
        seam,
        now: now(),
    }
}

fn t(s: &str) -> i64 {
    js_date(s).unwrap().0
}

/// `liveSeason(slug)`: created, then moved to live.
fn live_season(a: &Tournaments<'_>, slug: &str) -> SeasonRecord {
    let season = a
        .create_season(
            slug,
            "Desk ladder",
            "Rank by score. No prizes.",
            t("2026-01-01T00:00:00.000Z"),
            None,
        )
        .unwrap();
    a.set_season_status(&season.id, SeasonStatus::Live).unwrap()
}

fn row(rank: i64, user: &str, score: i64, updated_at: i64) -> SnapshotRow {
    SnapshotRow {
        rank,
        user_id: user.to_owned(),
        score,
        updated_at: Instant(updated_at).iso(),
    }
}

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.code.clone(),
        Refusal::Internal { code, .. } => code.clone().unwrap_or_default(),
        other => format!("{other:?}"),
    }
}

fn db_and_store() -> Option<(support::TestDb, Store)> {
    let db = support::TestDb::new()?;
    let store = Store::Pool(db.pool(4));
    Some((db, store))
}

macro_rules! needs_postgres {
    () => {
        match db_and_store() {
            Some(x) => x,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── freeze-replaces-snapshot.test.ts ─────────────────────────────────────────────────────────────────────────────

#[test]
fn writes_the_computed_standings_and_freezes_when_no_snapshot_exists_yet() {
    let (_db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "first-freeze-board");
    let alice = a.set_standing(&season.id, ALICE, 7.0).unwrap();
    let bob = a.set_standing(&season.id, BOB, 3.0).unwrap();

    assert_eq!(a.freeze_snapshot(&season.id).unwrap(), None);

    let frozen = a
        .set_season_status(&season.id, SeasonStatus::Frozen)
        .unwrap();
    let snapshot = a.freeze_snapshot(&season.id).unwrap().unwrap();

    assert_eq!(frozen.status, SeasonStatus::Frozen);
    assert_eq!(
        snapshot.standings,
        vec![
            row(1, ALICE, 7, alice.updated_at),
            row(2, BOB, 3, bob.updated_at)
        ]
    );
}

#[test]
fn replaces_an_existing_snapshot_with_the_standings_computed_for_this_freeze() {
    let (db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "later-freeze-board");
    let early_alice = a.set_standing(&season.id, ALICE, 1.0).unwrap();
    let early_bob = a.set_standing(&season.id, BOB, 2.0).unwrap();
    let earlier = vec![
        row(1, BOB, 2, early_bob.updated_at),
        row(2, ALICE, 1, early_alice.updated_at),
    ];
    let earlier_json = format!(
        "[{{\"rank\":1,\"userId\":\"{BOB}\",\"score\":2,\"updatedAt\":\"{}\"}},{{\"rank\":2,\"userId\":\"{ALICE}\",\"score\":1,\"updatedAt\":\"{}\"}}]",
        earlier[0].updated_at, earlier[1].updated_at
    );
    db.client()
        .execute(
            "INSERT INTO academy.tournament_freeze_snapshots (season_id, frozen_at, standings) \
             VALUES ($1::text::uuid, '2020-01-01T00:00:00.000Z', $2::text::jsonb)",
            &[&season.id, &earlier_json],
        )
        .unwrap();

    let later_alice = a.set_standing(&season.id, ALICE, 10.0).unwrap();
    let later_bob = a.set_standing(&season.id, BOB, 40.0).unwrap();
    assert_eq!(
        a.freeze_snapshot(&season.id).unwrap().unwrap().standings,
        earlier
    );

    let frozen = a
        .set_season_status(&season.id, SeasonStatus::Frozen)
        .unwrap();
    let snapshot = a.freeze_snapshot(&season.id).unwrap().unwrap();

    assert_eq!(frozen.status, SeasonStatus::Frozen);
    assert_eq!(
        snapshot.standings,
        vec![
            row(1, BOB, 40, later_bob.updated_at),
            row(2, ALICE, 10, later_alice.updated_at)
        ]
    );
}

// ── standing-not-after-freeze.test.ts ────────────────────────────────────────────────────────────────────────────

/// Freeze reads the board inside the season lock, then holds the transaction open until released.
struct PauseAfterStandingsRead {
    read: Mutex<Option<Sender<()>>>,
    release: Mutex<Receiver<()>>,
}

impl Seam for PauseAfterStandingsRead {
    fn at(&self, point: Point) -> Result<(), Refusal> {
        if point == Point::FreezeStandingsRead
            && let Some(read) = self.read.lock().unwrap().take()
        {
            read.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
        Ok(())
    }
}

/// `waitForLock`: another session of this database waits on a lock, within `timeout` (or until `stop`).
fn wait_for_lock(db: &support::TestDb, timeout: Duration, stop: impl Fn() -> bool) -> bool {
    let mut c = db.client();
    let started = Clock::now();
    loop {
        if stop() {
            return false;
        }
        let n: i32 = c
            .query_one(
                "SELECT count(*)::int FROM pg_stat_activity \
                 WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'",
                &[],
            )
            .unwrap()
            .get(0);
        if n > 0 {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn does_not_land_a_standing_after_the_freeze_has_read_the_board() {
    let (db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "standing-after-snapshot");
    let alice = a.set_standing(&season.id, ALICE, 7.0).unwrap();
    let board_before = a.standings(&season.id, Some(10.0)).unwrap();

    let (read_tx, read_rx) = channel();
    let (release_tx, release_rx) = channel();
    let pause = PauseAfterStandingsRead {
        read: Mutex::new(Some(read_tx)),
        release: Mutex::new(release_rx),
    };
    let freezer = academy(&store, &pause);

    let (saw_block, frozen, write) = thread::scope(|s| {
        let freeze = s.spawn(|| freezer.set_season_status(&season.id, SeasonStatus::Frozen));
        read_rx.recv().unwrap();
        let writer = s.spawn(|| a.set_standing(&season.id, BOB, 99.0));
        let saw_block = wait_for_lock(&db, Duration::from_secs(2), || writer.is_finished());
        release_tx.send(()).unwrap();
        (saw_block, freeze.join().unwrap(), writer.join().unwrap())
    });

    assert!(
        saw_block,
        "the standing write never waited on the freeze's lock"
    );
    assert_eq!(frozen.unwrap().status, SeasonStatus::Frozen);
    let snapshot = a.freeze_snapshot(&season.id).unwrap().unwrap();
    assert_eq!(snapshot.season_id, season.id);
    assert_eq!(snapshot.standings, vec![row(1, ALICE, 7, alice.updated_at)]);
    assert_eq!(a.standings(&season.id, Some(10.0)).unwrap(), board_before);
    let e = write.unwrap_err();
    assert!(matches!(e, Refusal::Academy(_)), "{e:?}");
    assert_eq!(code(&e), "academy.season_not_live");
}

#[test]
fn writes_a_score_while_the_season_is_still_live_before_the_freeze_snapshot() {
    let (_db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "score-before-snapshot");
    let alice = a.set_standing(&season.id, ALICE, 4.0).unwrap();

    assert_eq!(a.freeze_snapshot(&season.id).unwrap(), None);

    let frozen = a
        .set_season_status(&season.id, SeasonStatus::Frozen)
        .unwrap();

    assert_eq!(frozen.status, SeasonStatus::Frozen);
    assert_eq!(
        a.freeze_snapshot(&season.id).unwrap().unwrap().standings,
        vec![row(1, ALICE, 4, alice.updated_at)]
    );
    assert_eq!(
        a.standings(&season.id, Some(10.0)).unwrap(),
        vec![RankedStanding {
            rank: 1,
            season_id: season.id.clone(),
            user_id: ALICE.to_owned(),
            score: 4,
            updated_at: alice.updated_at,
        }]
    );
}

#[test]
fn does_not_land_a_standing_once_the_season_is_frozen() {
    let (_db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "frozen-refuses-standing");
    let alice = a.set_standing(&season.id, ALICE, 4.0).unwrap();
    a.set_season_status(&season.id, SeasonStatus::Frozen)
        .unwrap();
    let snapshot = a.freeze_snapshot(&season.id).unwrap();

    let e = a.set_standing(&season.id, BOB, 99.0).unwrap_err();
    assert_eq!(code(&e), "academy.season_not_live");

    assert_eq!(
        a.standings(&season.id, Some(10.0)).unwrap(),
        vec![RankedStanding {
            rank: 1,
            season_id: season.id.clone(),
            user_id: ALICE.to_owned(),
            score: 4,
            updated_at: alice.updated_at,
        }]
    );
    assert_eq!(a.freeze_snapshot(&season.id).unwrap(), snapshot);
}

// ── A crash at each point inside the transactions ────────────────────────────────────────────────────────────────

/// The process dies at `point`: the transaction never commits.
struct CrashAt(Point);

impl Seam for CrashAt {
    fn at(&self, point: Point) -> Result<(), Refusal> {
        if point == self.0 {
            return Err(Refusal::Internal {
                message: format!("crash at {point:?}"),
                code: None,
            });
        }
        Ok(())
    }
}

fn status_of(db: &support::TestDb, season_id: &str) -> String {
    db.client()
        .query_one(
            "SELECT status::text FROM academy.tournament_seasons WHERE id = $1::text::uuid",
            &[&season_id],
        )
        .unwrap()
        .get(0)
}

#[test]
fn a_crash_anywhere_inside_the_freeze_leaves_the_season_live_and_the_earlier_snapshot_whole() {
    let (db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    for (i, point) in [
        Point::FreezeLocked,
        Point::FreezeStandingsRead,
        Point::FreezeSnapshotWritten,
        Point::FreezeStatusFlipped,
    ]
    .into_iter()
    .enumerate()
    {
        let season = live_season(&a, &format!("crash-freeze-{i}"));
        let alice = a.set_standing(&season.id, ALICE, 5.0).unwrap();
        // A first freeze that crashes, from a season with no snapshot yet: none is left behind.
        let crash = CrashAt(point);
        let e = academy(&store, &crash)
            .set_season_status(&season.id, SeasonStatus::Frozen)
            .unwrap_err();
        assert!(format!("{e:?}").contains("crash at"), "{point:?}: {e:?}");
        assert_eq!(status_of(&db, &season.id), "live", "{point:?}");
        assert_eq!(a.freeze_snapshot(&season.id).unwrap(), None, "{point:?}");
        // Scores still write while live: nothing is stranded half-frozen.
        let bob = a.set_standing(&season.id, BOB, 9.0).unwrap();
        // The retry freezes the whole board.
        let frozen = a
            .set_season_status(&season.id, SeasonStatus::Frozen)
            .unwrap();
        assert_eq!(frozen.status, SeasonStatus::Frozen);
        assert_eq!(
            a.freeze_snapshot(&season.id).unwrap().unwrap().standings,
            vec![
                row(1, BOB, 9, bob.updated_at),
                row(2, ALICE, 5, alice.updated_at)
            ],
            "{point:?}"
        );
    }
}

#[test]
fn a_crash_inside_a_freeze_that_replaces_a_snapshot_keeps_the_earlier_one() {
    let (db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    for (i, point) in [Point::FreezeSnapshotWritten, Point::FreezeStatusFlipped]
        .into_iter()
        .enumerate()
    {
        let season = live_season(&a, &format!("crash-replace-{i}"));
        db.client()
            .execute(
                "INSERT INTO academy.tournament_freeze_snapshots (season_id, frozen_at, standings) \
                 VALUES ($1::text::uuid, '2020-01-01T00:00:00.000Z', '[]'::jsonb)",
                &[&season.id],
            )
            .unwrap();
        let before = a.freeze_snapshot(&season.id).unwrap();
        a.set_standing(&season.id, ALICE, 3.0).unwrap();
        let crash = CrashAt(point);
        assert!(
            academy(&store, &crash)
                .set_season_status(&season.id, SeasonStatus::Frozen)
                .is_err()
        );
        assert_eq!(status_of(&db, &season.id), "live", "{point:?}");
        assert_eq!(a.freeze_snapshot(&season.id).unwrap(), before, "{point:?}");
        assert_eq!(
            before.map(|s: StoredSnapshot| s.frozen_at),
            Some(t("2020-01-01T00:00:00.000Z"))
        );
    }
}

#[test]
fn a_crash_inside_one_standing_write_lands_nothing() {
    let (_db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    for (i, point) in [Point::StandingLocked, Point::StandingWritten]
        .into_iter()
        .enumerate()
    {
        let season = live_season(&a, &format!("crash-standing-{i}"));
        let crash = CrashAt(point);
        assert!(
            academy(&store, &crash)
                .set_standing(&season.id, ALICE, 8.0)
                .is_err()
        );
        assert!(
            a.standings(&season.id, Some(10.0)).unwrap().is_empty(),
            "{point:?}"
        );
    }
}

fn patches() -> Vec<ScorePatch> {
    vec![
        ScorePatch::new(ALICE, 10.0),
        ScorePatch::new(BOB, 20.0),
        ScorePatch::new(CAROL, 30.0),
    ]
}

#[test]
fn a_crash_mid_bulk_leaves_no_partial_board() {
    let (_db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    for (i, point) in [
        Point::BulkLocked,
        Point::BulkPatchWritten(0),
        Point::BulkPatchWritten(1),
        Point::BulkPatchWritten(2),
    ]
    .into_iter()
    .enumerate()
    {
        let season = live_season(&a, &format!("crash-bulk-{i}"));
        a.set_standing(&season.id, ALICE, 1.0).unwrap();
        let before = a.standings(&season.id, Some(10.0)).unwrap();
        let crash = CrashAt(point);
        assert!(
            academy(&store, &crash)
                .bulk_set_standings(&season.id, &patches())
                .is_err()
        );
        assert_eq!(
            a.standings(&season.id, Some(10.0)).unwrap(),
            before,
            "{point:?}"
        );
    }
}

#[test]
fn a_bulk_write_lands_every_patch_or_refuses_before_any() {
    let (_db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "bulk-whole");
    let BulkOutcome::Ok {
        accepted,
        standings,
    } = a.bulk_set_standings(&season.id, &patches()).unwrap()
    else {
        panic!("expected the bulk write to land");
    };
    assert_eq!(accepted, 3);
    assert_eq!(standings.len(), 3);
    let board = a.standings(&season.id, Some(10.0)).unwrap();
    let users: Vec<&str> = board.iter().map(|r| r.user_id.as_str()).collect();
    assert_eq!(users, [CAROL, BOB, ALICE]);

    // A duplicate in the batch refuses before any row is written.
    let dup = vec![ScorePatch::new(ALICE, 50.0), ScorePatch::new(ALICE, 60.0)];
    let out = a.bulk_set_standings(&season.id, &dup).unwrap();
    assert!(
        matches!(&out, BulkOutcome::Refused { reason: "duplicate_user", bad_user_id: Some(u), .. } if u == ALICE),
        "{out:?}"
    );
    assert_eq!(a.standings(&season.id, Some(10.0)).unwrap(), board);

    // Frozen: the bulk refuses as season_not_live, as data.
    a.set_season_status(&season.id, SeasonStatus::Frozen)
        .unwrap();
    let out = a.bulk_set_standings(&season.id, &patches()).unwrap();
    assert!(
        matches!(
            &out,
            BulkOutcome::Refused {
                reason: "season_not_live",
                ..
            }
        ),
        "{out:?}"
    );
}

// ── transaction()'s retry ────────────────────────────────────────────────────────────────────────────────────────

/// A serialization failure at `point` on the first `fail` attempts.
struct Conflict {
    point: Point,
    fail: u32,
    seen: AtomicU32,
}

impl Seam for Conflict {
    fn at(&self, point: Point) -> Result<(), Refusal> {
        if point == self.point && self.seen.fetch_add(1, Ordering::SeqCst) < self.fail {
            return Err(Refusal::Internal {
                message: "could not serialize access".to_owned(),
                code: Some("40001".to_owned()),
            });
        }
        Ok(())
    }
}

#[test]
fn a_serialization_failure_is_retried_and_the_freeze_lands_once() {
    let (db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "retry-freeze");
    let alice = a.set_standing(&season.id, ALICE, 2.0).unwrap();
    let conflict = Conflict {
        point: Point::FreezeSnapshotWritten,
        fail: 2,
        seen: AtomicU32::new(0),
    };
    let frozen = academy(&store, &conflict)
        .set_season_status(&season.id, SeasonStatus::Frozen)
        .unwrap();
    assert_eq!(frozen.status, SeasonStatus::Frozen);
    assert_eq!(conflict.seen.load(Ordering::SeqCst), 3);
    let n: i64 = db
        .client()
        .query_one(
            "SELECT count(*) FROM academy.tournament_freeze_snapshots WHERE season_id = $1::text::uuid",
            &[&season.id],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 1);
    assert_eq!(
        a.freeze_snapshot(&season.id).unwrap().unwrap().standings,
        vec![row(1, ALICE, 2, alice.updated_at)]
    );
}

#[test]
fn a_serialization_failure_stops_after_five_attempts() {
    let (db, store) = needs_postgres!();
    let a = academy(&store, &NoSeam);
    let season = live_season(&a, "retry-gives-up");
    let conflict = Conflict {
        point: Point::StandingWritten,
        fail: u32::MAX,
        seen: AtomicU32::new(0),
    };
    let e = academy(&store, &conflict)
        .set_standing(&season.id, ALICE, 2.0)
        .unwrap_err();
    assert_eq!(code(&e), "40001");
    assert_eq!(conflict.seen.load(Ordering::SeqCst), 5);
    assert!(a.standings(&season.id, Some(10.0)).unwrap().is_empty());
    assert_eq!(status_of(&db, &season.id), "live");
}
