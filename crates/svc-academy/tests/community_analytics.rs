//! AC-analytics-01 and AC-analytics-02 (J-academy-16), against a real database, as `analytics/analytics.db.test.ts`:
//! learner summaries and their blank page size, the daily table's unrecorded days, and a report task from request to
//! sweep, abort, expiry and delete. Every refusal has a test and writes nothing. Plus: the sweep skips a task another
//! connection holds (`FOR UPDATE SKIP LOCKED`) and finishes it once that lock is gone.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::community_support;
use crate::support;

use community_support::{arr, at, b, code, exec, get, n, one, s, setup};
use service_kit::json::Json;
use service_kit::time::Instant;
use svc_academy::community::analytics::{self, ReportSettings};
use svc_academy::community::{Db, metrics, sha256_hex};
use svc_academy::db::Store;

use support::TestDb;

const A: &str = "33333333-3333-4333-8333-333333333333";
const T0: &str = "2026-11-12T08:00:00.000Z";

fn t0() -> Instant {
    at(T0)
}

fn later(seconds: i64) -> Instant {
    Instant(t0().0 + seconds * 1000)
}

const SETTINGS: ReportSettings = ReportSettings {
    page_size: Some(50),
    retention_minutes: Some(1440),
    row_limit: Some(100),
    sweep_seconds: Some(10),
};

fn uuid(db: &TestDb) -> String {
    one(db, "SELECT gen_random_uuid()::text")
}

fn tag_of(db: &TestDb) -> String {
    format!("t-{}", &one(db, "SELECT md5(random()::text)")[..8])
}

/// A learner on the foundations path with `items` completions, carrying `tag`.
fn learner(db: &TestDb, tag: &str, items: i64) -> String {
    let id = uuid(db);
    let mut c = db.client();
    c.execute(
        "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) VALUES ($1::text::uuid, 'foundations', $2::text::timestamptz)",
        &[&id, &T0],
    )
    .unwrap();
    for i in 0..items {
        c.execute(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES ($1::text::uuid, $2, $3::text::timestamptz)",
            &[&id, &format!("item-{i}"), &later(60 + i).iso()],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO academy.learner_tags (user_id, tag, added_by, added_at) VALUES ($1::text::uuid, $2, $3::text::uuid, $4::text::timestamptz)",
        &[&id, &tag, &A, &T0],
    )
    .unwrap();
    id
}

fn ids_of(rows: &[Json]) -> Vec<String> {
    rows.iter().map(|r| s(r, "userId")).collect()
}

// ── learner summaries ─────────────────────────────────────────────────────────

#[test]
fn summaries_list_each_tagged_learner_with_enrolments_items_and_last_active_none_is_an_empty_page()
{
    let Some((db, store)) = setup() else { return };
    let pool = Db(&store);
    let tag = tag_of(&db);
    let empty = analytics::summaries_page(&pool, Some(2), Some(&tag), None).unwrap();
    assert_eq!(
        empty,
        Json::obj([
            ("tag", Json::str(tag.clone())),
            ("pageSize", Json::int(2)),
            ("rows", Json::Array(vec![])),
            ("next", Json::Null),
        ])
    );
    let mut ids = [
        learner(&db, &tag, 2),
        learner(&db, &tag, 0),
        learner(&db, &tag, 1),
    ];
    ids.sort();
    let first = analytics::summaries_page(&pool, Some(2), Some(&tag), None).unwrap();
    assert_eq!(ids_of(arr(&first, "rows")), ids[..2].to_vec());
    assert_eq!(s(&first, "next"), ids[1]);
    let after = s(&first, "next");
    let second = analytics::summaries_page(&pool, Some(2), Some(&tag), Some(&after)).unwrap();
    assert_eq!(ids_of(arr(&second, "rows")), vec![ids[2].clone()]);
    assert_eq!(get(&second, "next"), &Json::Null);
    let all: Vec<Json> = arr(&first, "rows")
        .iter()
        .chain(arr(&second, "rows"))
        .cloned()
        .collect();
    for row in &all {
        assert_eq!(n(row, "enrolments"), 1);
        assert_eq!(get(row, "tags"), &Json::Array(vec![Json::str(tag.clone())]));
    }
    let two = one(
        &db,
        &format!(
            "SELECT user_id::text FROM academy.cert_item_completions WHERE user_id = ANY(ARRAY['{}']::uuid[]) GROUP BY user_id HAVING count(*) = 2",
            ids.join("','")
        ),
    );
    let row = all.iter().find(|r| s(r, "userId") == two).unwrap();
    assert_eq!(n(row, "itemsCompleted"), 2);
    assert_eq!(s(row, "lastActiveAt"), later(61).iso());
}

#[test]
fn summaries_refuse_by_name_when_the_owner_has_not_set_the_page_size() {
    let Some((_db, store)) = setup() else { return };
    assert_eq!(
        code(analytics::summaries_page(&Db(&store), None, None, None)),
        "academy.learner_summaries_list_limit_unset"
    );
}

// ── the daily activity table ──────────────────────────────────────────────────

#[test]
fn the_daily_table_reads_not_recorded_before_the_service_recorded_and_real_counts_from_then_on() {
    let Some((db, store)) = setup() else { return };
    exec(&db, "DELETE FROM academy.metrics_recording");
    exec(
        &db,
        "INSERT INTO academy.metrics_recording (id, since) VALUES (1, '2026-11-10T09:00:00Z')",
    );
    let read = metrics::ops_metrics(&Db(&store), "2026-11-08", "2026-11-10").unwrap();
    // Older rows already stored move the start back; with none, it is the recorded start.
    let oldest = one(
        &db,
        "SELECT coalesce(to_char(LEAST((SELECT min(touched_at) FROM academy.learning_touches),
           (SELECT min(completed_at) FROM academy.cert_item_completions),
           (SELECT min(granted_at) FROM academy.cert_grants)) AT TIME ZONE 'UTC', 'YYYY-MM-DD'), '')",
    );
    let since = if !oldest.is_empty() && oldest.as_str() < "2026-11-10" {
        oldest
    } else {
        "2026-11-10".to_owned()
    };
    assert_eq!(s(&read, "recordingSince"), since);
    for day in arr(&read, "days") {
        let date = s(day, "date");
        for key in ["lessonsRead", "completions", "grants"] {
            let cell = get(day, key);
            if date < since {
                assert_eq!(
                    cell,
                    &Json::obj([
                        ("value", Json::Null),
                        ("reason", Json::str("metric_not_recorded"))
                    ]),
                    "{date}"
                );
            } else {
                assert!(matches!(get(cell, "value"), Json::Number(_)), "{date}");
                assert_eq!(get(cell, "reason"), &Json::Null, "{date}");
            }
        }
    }
    let dates: Vec<String> = arr(&read, "days").iter().map(|d| s(d, "date")).collect();
    assert_eq!(dates, ["2026-11-08", "2026-11-09", "2026-11-10"]);
}

// ── report tasks ──────────────────────────────────────────────────────────────

fn task_of<'a>(list: &'a Json, id: &str) -> Option<&'a Json> {
    arr(list, "tasks").iter().find(|t| s(t, "id") == id)
}

fn request(
    pool: &Db<'_>,
    settings: &ReportSettings,
    me: &str,
    tag: Option<&str>,
    n: i64,
    now: Instant,
) -> Json {
    analytics::request(pool, settings, me, "learners", tag, n, now).unwrap()
}

#[test]
fn a_requested_learners_report_runs_on_the_sweep_queued_running_then_done_with_its_file_time_and_hash()
 {
    let Some((db, store)) = setup() else { return };
    let pool = Db(&store);
    let sweeper = db.pool();
    let tag = tag_of(&db);
    let mut tagged = vec![learner(&db, &tag, 1), learner(&db, &tag, 0)];
    tagged.sort();
    learner(&db, &tag_of(&db), 3);
    let me = uuid(&db);
    assert_eq!(
        n(
            &analytics::list(&pool, &SETTINGS, &me, t0()).unwrap(),
            "nextN"
        ),
        1
    );
    let task = request(&pool, &SETTINGS, &me, Some(&tag), 1, t0());
    assert_eq!(n(&task, "n"), 1);
    assert_eq!(s(&task, "state"), "queued");
    assert_eq!(s(&task, "tag"), tag);
    assert_eq!(s(&task, "requestedBy"), me);
    assert_eq!(get(&task, "startedAt"), &Json::Null);
    let id = s(&task, "id");
    // A retry of the same request answers the same task; a number past the next refuses.
    assert_eq!(
        s(
            &request(&pool, &SETTINGS, &me, Some(&tag), 1, later(1)),
            "id"
        ),
        id
    );
    assert_eq!(
        code(analytics::request(
            &pool,
            &SETTINGS,
            &me,
            "learners",
            Some(&tag),
            3,
            t0()
        )),
        "academy.report_out_of_order"
    );
    assert_eq!(
        code(analytics::file(&pool, &id, t0())),
        "academy.report_not_ready"
    );

    analytics::sweep(&sweeper, &SETTINGS, later(10)).unwrap();
    let listed = analytics::list(&pool, &SETTINGS, &me, later(10)).unwrap();
    assert_eq!(s(task_of(&listed, &id).unwrap(), "state"), "running");
    analytics::sweep(&sweeper, &SETTINGS, later(20)).unwrap();
    let file = analytics::file(&pool, &id, later(21)).unwrap();
    assert_eq!(s(&file, "state"), "done");
    assert_eq!(n(&file, "rows"), 2);
    assert_eq!(s(&file, "finishedAt"), later(20).iso());
    assert!(!b(&file, "expired"));
    let expires = s(&file, "expiresAt");
    assert_eq!(expires, Instant(later(20).0 + 24 * 3_600_000).iso());
    let csv = s(&file, "csv");
    assert_eq!(sha256_hex(&csv), s(&file, "sha256"));
    let lines: Vec<&str> = csv.trim_end().split("\r\n").collect();
    assert_eq!(
        lines[0],
        format!("learners report,1,made at,{},tag,{tag}", later(20).iso())
    );
    assert_eq!(
        lines[1],
        "learner,enrolments,items completed,last active,tags"
    );
    let first_cells: Vec<String> = lines[2..]
        .iter()
        .map(|l| l.split(',').next().unwrap().to_owned())
        .collect();
    assert_eq!(first_cells, tagged);

    // After the retention the file is gone, and the sweep drops its bytes.
    let gone = Instant(at(&expires).0 + 1);
    assert_eq!(
        code(analytics::file(&pool, &id, gone)),
        "academy.report_expired"
    );
    analytics::sweep(&sweeper, &SETTINGS, gone).unwrap();
    assert_eq!(
        one(
            &db,
            &format!(
                "SELECT coalesce(csv, 'NULL') FROM academy.report_centre_tasks WHERE id = '{id}'"
            )
        ),
        "NULL"
    );
    let listed = analytics::list(&pool, &SETTINGS, &me, gone).unwrap();
    assert!(b(task_of(&listed, &id).unwrap(), "expired"));
}

#[test]
fn an_aborted_running_task_never_gets_a_file_even_when_the_sweep_comes_round_again() {
    let Some((db, store)) = setup() else { return };
    let pool = Db(&store);
    let sweeper = db.pool();
    let me = uuid(&db);
    let task = request(&pool, &SETTINGS, &me, None, 1, t0());
    let id = s(&task, "id");
    analytics::sweep(&sweeper, &SETTINGS, later(10)).unwrap();
    assert_eq!(
        s(
            &analytics::abort(&pool, &me, &id, later(11)).unwrap(),
            "state"
        ),
        "aborted"
    );
    assert_eq!(
        s(
            &analytics::abort(&pool, &me, &id, later(12)).unwrap(),
            "state"
        ),
        "aborted"
    );
    analytics::sweep(&sweeper, &SETTINGS, later(20)).unwrap();
    assert_eq!(
        code(analytics::file(&pool, &id, later(21))),
        "academy.report_not_ready"
    );
    let events = db.texts(&format!(
        "SELECT event FROM academy.report_centre_events WHERE task_id = '{id}' ORDER BY n"
    ));
    assert_eq!(events, ["requested", "started", "aborted"]);
}

#[test]
fn a_finished_task_refuses_abort_and_any_task_deletes_off_the_list_its_file_gone() {
    let Some((db, store)) = setup() else { return };
    let pool = Db(&store);
    let sweeper = db.pool();
    let me = uuid(&db);
    let tag = tag_of(&db);
    let id = s(&request(&pool, &SETTINGS, &me, Some(&tag), 1, t0()), "id");
    analytics::sweep(&sweeper, &SETTINGS, later(10)).unwrap();
    analytics::sweep(&sweeper, &SETTINGS, later(20)).unwrap();
    assert_eq!(
        code(analytics::abort(&pool, &me, &id, later(21))),
        "academy.report_not_abortable"
    );
    let deleted = Json::obj([
        ("taskId", Json::str(id.clone())),
        ("deleted", Json::Bool(true)),
    ]);
    assert_eq!(
        analytics::delete(&pool, &me, &id, later(22)).unwrap(),
        deleted
    );
    assert_eq!(
        analytics::delete(&pool, &me, &id, later(23)).unwrap(),
        deleted
    );
    assert!(
        task_of(
            &analytics::list(&pool, &SETTINGS, &me, later(24)).unwrap(),
            &id
        )
        .is_none()
    );
    assert_eq!(
        code(analytics::file(&pool, &id, later(24))),
        "academy.report_not_found"
    );
    assert_eq!(
        code(analytics::abort(&pool, &me, &id, later(24))),
        "academy.report_not_found"
    );
    assert_eq!(
        n(
            &analytics::list(&pool, &SETTINGS, &me, t0()).unwrap(),
            "nextN"
        ),
        2
    );
}

#[test]
fn a_report_with_more_learners_than_one_may_hold_fails_by_name() {
    let Some((db, store)) = setup() else { return };
    let pool = Db(&store);
    let sweeper = db.pool();
    let tag = tag_of(&db);
    learner(&db, &tag, 0);
    learner(&db, &tag, 0);
    let small = ReportSettings {
        row_limit: Some(1),
        ..SETTINGS
    };
    let founder = uuid(&db);
    let id = s(&request(&pool, &small, &founder, Some(&tag), 1, t0()), "id");
    analytics::sweep(&sweeper, &small, later(10)).unwrap();
    analytics::sweep(&sweeper, &small, later(20)).unwrap();
    let listed = analytics::list(&pool, &small, A, later(21)).unwrap();
    let task = task_of(&listed, &id).unwrap();
    assert_eq!(s(task, "state"), "failed");
    assert_eq!(s(task, "failure"), "academy.report_too_large");
    assert_eq!(get(task, "sha256"), &Json::Null);
}

#[test]
fn a_request_refuses_by_name_while_an_owner_value_is_blank_and_writes_nothing() {
    let Some((db, store)) = setup() else { return };
    let pool = Db(&store);
    let me = uuid(&db);
    for (blank, want) in [
        (
            ReportSettings {
                retention_minutes: None,
                ..SETTINGS
            },
            "academy.report_retention_unset",
        ),
        (
            ReportSettings {
                row_limit: None,
                ..SETTINGS
            },
            "academy.report_limit_unset",
        ),
        (
            ReportSettings {
                sweep_seconds: None,
                ..SETTINGS
            },
            "academy.report_sweep_unset",
        ),
    ] {
        assert_eq!(
            code(analytics::request(
                &pool,
                &blank,
                &me,
                "learners",
                None,
                1,
                t0()
            )),
            want
        );
    }
    let no_page = ReportSettings {
        page_size: None,
        ..SETTINGS
    };
    assert_eq!(
        code(analytics::list(&pool, &no_page, &me, t0())),
        "academy.report_tasks_list_limit_unset"
    );
    assert_eq!(
        one(
            &db,
            &format!(
                "SELECT count(*)::text FROM academy.report_centre_tasks WHERE requested_by = '{me}'"
            )
        ),
        "0"
    );
}

/// The blank owner values refuse before the first query: a store that is down never sees the call.
#[test]
fn blank_owner_values_refuse_before_the_first_query() {
    let refusing = Store::Down("connect ECONNREFUSED".to_owned());
    let pool = Db(&refusing);
    assert_eq!(
        code(analytics::summaries_page(&pool, None, None, None)),
        "academy.learner_summaries_list_limit_unset"
    );
    let blank = ReportSettings {
        retention_minutes: None,
        ..SETTINGS
    };
    assert_eq!(
        code(analytics::request(
            &pool,
            &blank,
            A,
            "learners",
            None,
            1,
            t0()
        )),
        "academy.report_retention_unset"
    );
    let no_page = ReportSettings {
        page_size: None,
        ..SETTINGS
    };
    assert_eq!(
        code(analytics::list(&pool, &no_page, A, t0())),
        "academy.report_tasks_list_limit_unset"
    );
}

/// A running task another connection holds is skipped by the sweep (`FOR UPDATE SKIP LOCKED`), never waited on and
/// never finished twice; once the lock is gone, the next sweep finishes it.
#[test]
fn the_sweep_skips_a_task_another_connection_holds_and_finishes_it_once_released() {
    let Some((db, store)) = setup() else { return };
    let pool = Db(&store);
    let sweeper = db.pool();
    let me = uuid(&db);
    let id = s(&request(&pool, &SETTINGS, &me, None, 1, t0()), "id");
    analytics::sweep(&sweeper, &SETTINGS, later(10)).unwrap();
    let mut holder = db.client();
    let mut tx = holder.transaction().unwrap();
    tx.execute(
        "SELECT 1 FROM academy.report_centre_tasks WHERE id = $1::text::uuid FOR UPDATE",
        &[&id],
    )
    .unwrap();
    let swept = analytics::sweep(&sweeper, &SETTINGS, later(20)).unwrap();
    assert_eq!(swept.finished, 0);
    assert_eq!(
        one(
            &db,
            &format!("SELECT state FROM academy.report_centre_tasks WHERE id = '{id}'")
        ),
        "running"
    );
    tx.rollback().unwrap();
    let swept = analytics::sweep(&sweeper, &SETTINGS, later(30)).unwrap();
    assert_eq!(swept.finished, 1);
    let file = analytics::file(&pool, &id, later(31)).unwrap();
    assert_eq!(s(&file, "state"), "done");
    assert_eq!(s(&file, "finishedAt"), later(30).iso());
    let events = db.texts(&format!(
        "SELECT event FROM academy.report_centre_events WHERE task_id = '{id}' ORDER BY n"
    ));
    assert_eq!(events, ["requested", "started", "done"]);
}
