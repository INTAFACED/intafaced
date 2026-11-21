//! Grading hand-ins, the grader lease and the bulk grade file, against a real Postgres: the port of
//! `curriculum/grading.db.test.ts` (AC-assignments-02), assertion for assertion. The course, its outline and the
//! enrolments are another slice's calls; they are written here as the rows those calls leave. `courseGrades` is the
//! learner slice's call, so its test stays with that slice.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use service_kit::json::Json;
use support::{MemoryObjects, TestDb, at, code_of, enrol, jp, seed_course, test_storage};
use svc_academy::assessment::assignments::{self, BriefInput, Files};
use svc_academy::assessment::grading::{self, GradeInput};
use svc_academy::assessment::peer::{self, StepsInput};
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const B: &str = "44444444-4444-4444-8444-444444444444";
const L: &str = "55555555-5555-4555-8555-555555555555";
const M: &str = "77777777-7777-4777-8777-777777777777";
const N: &str = "88888888-8888-4888-8888-888888888888";
const X: &str = "99999999-9999-4999-8999-999999999999";
const OUTSIDER: &str = "66666666-6666-4666-8666-666666666666";
const NOW_ISO: &str = "2026-10-23T12:00:00.000Z";
const LEASE: Option<i64> = Some(900);

fn now() -> i64 {
    service_kit::time::js_date(NOW_ISO).unwrap().0
}

fn later(minutes: i64) -> i64 {
    now() + minutes * 60_000
}

fn s(v: &str) -> Json {
    Json::str(v)
}

fn text(j: &Json) -> String {
    match j {
        Json::String(s) => s.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

fn list(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(items) => items.clone(),
        other => panic!("not an array: {other:?}"),
    }
}

fn criteria() -> Vec<Json> {
    list(&jp(
        r#"[{"name":"Sizing","levels":["0","1","2"]},{"name":"Working shown","levels":["0","0.5"]}]"#,
    ))
}

struct Open {
    db: TestDb,
    store: Store,
    objects: MemoryObjects,
    items: Vec<String>,
}

fn brief(points: &str) -> BriefInput<'_> {
    BriefInput {
        instructions: "Size one trade.",
        points,
        due_at: None,
        text: "required",
        file: "off",
    }
}

impl Open {
    fn item(&self) -> &str {
        &self.items[0]
    }

    fn files(&self) -> Files<'_> {
        Files {
            storage: Some(test_storage()),
            max_bytes: Some(1024),
            types: Some(vec!["application/pdf".to_owned()]),
            bytes: &self.objects,
        }
    }

    fn hand_in(&self, item: &str, user: &str, body: &str, minutes: i64) -> Json {
        assignments::submit(
            &self.store,
            &self.files(),
            item,
            1,
            Some(body),
            None,
            user,
            later(minutes),
        )
        .unwrap()
    }

    fn queue(&self, operator: &str, at_ms: i64) -> Json {
        grading::queue(&self.store, LEASE, self.item(), operator, at_ms).unwrap()
    }

    fn rows(&self) -> Vec<Json> {
        list(&at(&self.queue(A, now()), "rows"))
    }

    fn submission(&self, n: usize) -> String {
        text(&at(&self.rows()[n], "submissionId"))
    }

    fn learner_view(&self, user: &str) -> Result<Json, Refusal> {
        assignments::learner_view(&self.store, &self.files(), self.item(), user, now())
    }
}

/// A free course with text-only assignments (each brief saved), published, with L, M, N and X enrolled.
fn open_assignment(titles: &[&str]) -> Option<Open> {
    let db = TestDb::migrated()?;
    let mut c = db.client();
    let kinds: Vec<(&str, &str)> = titles.iter().map(|t| ("assignment", *t)).collect();
    let seeded = seed_course(&mut c, "risk-basics", "draft", A, NOW_ISO, &kinds);
    let store = Store::Pool(db.pool());
    for item in &seeded.items {
        assignments::save(&store, item, 0, &brief("10"), A, now()).unwrap();
    }
    c.execute(
        "UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid",
        &[&seeded.id],
    )
    .unwrap();
    for user in [L, M, N, X] {
        enrol(&mut c, &seeded.id, user, NOW_ISO);
    }
    Some(Open {
        db,
        store,
        objects: MemoryObjects::new(),
        items: seeded.items,
    })
}

macro_rules! need {
    ($e:expr) => {
        match $e {
            Some(f) => f,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

#[derive(Clone, Copy)]
struct G<'a> {
    n: i64,
    score: &'a str,
    comment: Option<&'a str>,
    reason: Option<&'a str>,
    operator: &'a str,
    at: i64,
}

fn g() -> G<'static> {
    G {
        n: 1,
        score: "8",
        comment: Some("Clear sizing."),
        reason: None,
        operator: A,
        at: now(),
    }
}

fn grade(o: &Open, submission: &str, over: G<'_>) -> Result<Json, Refusal> {
    grading::grade(
        &o.store,
        LEASE,
        &GradeInput {
            item_id: o.item(),
            submission_id: submission,
            n: over.n,
            score: over.score,
            comment: over.comment,
            reason: over.reason,
        },
        over.operator,
        over.at,
    )
}

#[test]
fn the_queue_shows_learners_under_aliases_and_a_grade_is_released_with_no_grader() {
    let o = need!(open_assignment(&["Write-up"]));
    let item = o.item();
    peer::save(
        &o.store,
        &StepsInput {
            item_id: item,
            revision: 0,
            peer: true,
            peer_count: Some(1),
            self_review: false,
            criteria: &criteria(),
        },
        A,
        now(),
    )
    .unwrap();
    o.hand_in(item, L, "L sizes by risk.", 0);
    o.hand_in(item, M, "M sizes by a fixed amount.", 1);
    let task = text(&at(
        &peer::state(&o.store, item, M, now()).unwrap(),
        "task.id",
    ));
    peer::submit(
        &o.store,
        item,
        &task,
        &["2".to_owned(), "0.5".to_owned()],
        M,
        now(),
    )
    .unwrap();
    let queue = o.queue(A, now());
    assert_eq!(at(&queue, "points"), s("10"));
    assert_eq!(at(&queue, "leaseSeconds"), Json::int(900));
    let rows: Vec<(Json, Json)> = list(&at(&queue, "rows"))
        .iter()
        .map(|r| (at(r, "alias"), at(r, "text")))
        .collect();
    assert_eq!(
        rows,
        [
            (Json::int(1), s("L sizes by risk.")),
            (Json::int(2), s("M sizes by a fixed amount."))
        ]
    );
    assert!(!queue.compact().contains(L));
    assert_eq!(
        at(&queue, "rows.0.peerReviews"),
        jp(r#"{"received":1,"meanTotal":"2.5"}"#)
    );
    let graded = grade(&o, &text(&at(&queue, "rows.0.submissionId")), g()).unwrap();
    assert_eq!(at(&graded, "rows.0.grade.score"), s("8"));
    assert_eq!(at(&graded, "rows.0.grade.comment"), s("Clear sizing."));
    assert_eq!(at(&graded, "rows.0.grade.overrides"), Json::int(0));
    assert_eq!(at(&graded, "rows.0.nextN"), Json::int(2));
    assert_eq!(at(&graded, "rows.0.lease"), Json::Null);
    let view = o.learner_view(L).unwrap();
    assert_eq!(
        at(&view, "grade"),
        jp(&format!(
            r#"{{"version":1,"n":1,"score":"8","points":"10","entered":null,"comment":"Clear sizing.","gradedAt":"{NOW_ISO}","readAt":null}}"#
        ))
    );
    assert_eq!(at(&view, "submissions.0.state"), s("graded"));
    assert!(!view.compact().contains(A));
    assert_eq!(at(&o.learner_view(M).unwrap(), "grade"), Json::Null);
}

#[test]
fn a_second_grader_is_locked_out_while_the_lease_is_live_and_a_blank_lease_refuses() {
    let o = need!(open_assignment(&["Write-up"]));
    let item = o.item();
    o.hand_in(item, L, "L", 0);
    let id = o.submission(0);
    assert_eq!(
        code_of(grading::open(&o.store, None, item, &id, A, now())),
        "academy.grader_lease_unset"
    );
    let opened = grading::open(&o.store, LEASE, item, &id, A, now()).unwrap();
    assert_eq!(at(&opened, "rows.0.lease.mine"), Json::Bool(true));
    assert_eq!(
        at(&o.queue(B, now()), "rows.0.lease.mine"),
        Json::Bool(false)
    );
    assert_eq!(
        code_of(grading::open(&o.store, LEASE, item, &id, B, now())),
        "academy.grader_locked"
    );
    assert_eq!(
        code_of(grade(&o, &id, G { operator: B, ..g() })),
        "academy.grader_locked"
    );
    let after_expiry = later(16);
    grading::open(&o.store, LEASE, item, &id, B, after_expiry).unwrap();
    assert!(
        grade(
            &o,
            &id,
            G {
                operator: B,
                at: after_expiry,
                ..g()
            }
        )
        .is_ok()
    );
}

#[test]
fn a_retry_answers_as_stored_an_override_needs_a_reason_and_a_stale_n_refuses() {
    let o = need!(open_assignment(&["Write-up"]));
    let item = o.item();
    o.hand_in(item, L, "L", 0);
    let id = o.submission(0);
    assert_eq!(
        code_of(grade(
            &o,
            &id,
            G {
                score: "10.5",
                ..g()
            }
        )),
        "academy.grade_invalid"
    );
    grade(&o, &id, g()).unwrap();
    grade(&o, &id, g()).unwrap();
    let events: i32 =
        o.db.client()
            .query_one(
                "SELECT count(*)::int FROM academy.assignment_grade_events",
                &[],
            )
            .unwrap()
            .get(0);
    assert_eq!(events, 1);
    assert_eq!(
        code_of(grade(&o, &id, G { score: "9", ..g() })),
        "academy.revision_stale"
    );
    // The same n with another comment is a different grade, not a retry: refused, and the stored one stands.
    assert_eq!(
        code_of(grade(
            &o,
            &id,
            G {
                comment: Some("Units missing."),
                ..g()
            }
        )),
        "academy.revision_stale"
    );
    assert_eq!(
        code_of(grade(
            &o,
            &id,
            G {
                n: 2,
                score: "9",
                ..g()
            }
        )),
        "academy.reason_required"
    );
    let over = grade(
        &o,
        &id,
        G {
            n: 2,
            score: "9",
            reason: Some("TEST regraded on appeal"),
            ..g()
        },
    )
    .unwrap();
    assert_eq!(at(&over, "rows.0.grade.score"), s("9"));
    assert_eq!(at(&over, "rows.0.grade.overrides"), Json::int(1));
    assert_eq!(at(&o.learner_view(L).unwrap(), "grade.score"), s("9"));
    assert_eq!(
        code_of(grade(&o, "00000000-0000-4000-8000-000000000000", g())),
        "academy.submission_not_found"
    );
    assignments::withdraw(&o.store, item, "TEST", A, now()).unwrap();
    assert_eq!(
        code_of(grade(
            &o,
            &id,
            G {
                n: 3,
                score: "7",
                reason: Some("TEST late change"),
                ..g()
            }
        )),
        "academy.assignment_closed"
    );
}

#[test]
fn marking_feedback_read_is_recorded_once_and_changes_no_grade() {
    let o = need!(open_assignment(&["Write-up"]));
    let item = o.item();
    o.hand_in(item, L, "L", 0);
    assert_eq!(
        code_of(grading::mark_read(&o.store, item, 1, 1, L, now())),
        "academy.submission_not_found"
    );
    let id = o.submission(0);
    grade(&o, &id, g()).unwrap();
    grading::mark_read(&o.store, item, 1, 1, L, later(5)).unwrap();
    grading::mark_read(&o.store, item, 1, 1, L, later(9)).unwrap();
    let first = at(&o.learner_view(L).unwrap(), "grade");
    assert_eq!(at(&first, "score"), s("8"));
    assert_eq!(
        at(&first, "readAt"),
        s(&service_kit::time::Instant(later(5)).iso())
    );
    // A change of grade after the read is unread again; a read sent for the old event leaves it so.
    grade(
        &o,
        &id,
        G {
            n: 2,
            score: "9",
            reason: Some("TEST regraded"),
            ..g()
        },
    )
    .unwrap();
    grading::mark_read(&o.store, item, 1, 1, L, later(10)).unwrap();
    let second = at(&o.learner_view(L).unwrap(), "grade");
    assert_eq!(
        (
            at(&second, "n"),
            at(&second, "score"),
            at(&second, "readAt")
        ),
        (Json::int(2), s("9"), Json::Null)
    );
    // A brief saved later with other points leaves a grade out of the points it was given against.
    assignments::save(&o.store, item, 1, &brief("5"), A, later(11)).unwrap();
    let third = at(&o.learner_view(L).unwrap(), "grade");
    assert_eq!(
        (at(&third, "score"), at(&third, "points")),
        (s("9"), s("10"))
    );
    assert_eq!(
        code_of(grading::mark_read(&o.store, item, 1, 1, OUTSIDER, now())),
        "academy.enrolment_required"
    );
}

#[test]
fn a_bulk_file_grades_good_rows_lists_the_bad_ones_and_the_same_file_again_changes_nothing() {
    let o = need!(open_assignment(&["Write-up"]));
    let item = o.item().to_owned();
    o.hand_in(&item, L, "L", 0);
    o.hand_in(&item, M, "M", 1);
    o.hand_in(&item, N, "N", 2);
    let rows = o.rows();
    let two = text(&at(&rows[1], "submissionId"));
    let three = text(&at(&rows[2], "submissionId"));
    // Learner 2 already has a grade, so changing it needs a reason; B holds Learner 3.
    grade(&o, &two, g()).unwrap();
    grading::open(&o.store, LEASE, &item, &three, B, now()).unwrap();
    let csv = [
        "learner,score,comment,reason",
        "Learner 1,7.5,\"Good, clear sizing.\",",
        "Learner 2,9,,",
        "Learner 3,6,,",
        "Learner 9,5,,",
        "Learner 1,4,,",
        "Learner 1x,4,,",
        "",
    ]
    .join("\r\n");
    let bulk = |text: &str, at_ms: i64| {
        grading::bulk_grade(&o.store, LEASE, &item, "grades.csv", text, A, at_ms).unwrap()
    };
    let first = bulk(&csv, now());
    assert_eq!(
        (at(&first, "repeated"), at(&first, "changed")),
        (Json::Bool(false), Json::int(1))
    );
    assert_eq!(
        at(&first, "applied"),
        jp(r#"[{"line":2,"alias":1,"score":"7.5"}]"#)
    );
    let rejected = |r: &Json| -> Vec<(Json, Json, Json)> {
        list(&at(r, "rejected"))
            .iter()
            .map(|x| (at(x, "line"), at(x, "alias"), at(x, "code")))
            .collect()
    };
    assert_eq!(
        rejected(&first),
        [
            (Json::int(3), Json::int(2), s("academy.reason_required")),
            (Json::int(4), Json::int(3), s("academy.grader_locked")),
            (
                Json::int(5),
                Json::int(9),
                s("academy.submission_not_found")
            ),
            (Json::int(6), Json::int(1), s("academy.bulk_row_invalid")),
            (Json::int(7), Json::Null, s("academy.bulk_row_invalid")),
        ]
    );
    assert_eq!(at(&first, "queue.rows.0.grade.score"), s("7.5"));
    assert_eq!(
        at(&first, "queue.rows.0.grade.comment"),
        s("Good, clear sizing.")
    );
    assert_eq!(at(&first, "queue.rows.0.grade.overrides"), Json::int(0));
    assert!(!first.compact().contains(L));
    let view = o.learner_view(L).unwrap();
    assert_eq!(
        (at(&view, "grade.score"), at(&view, "grade.comment")),
        (s("7.5"), s("Good, clear sizing."))
    );

    // The same file again grades nothing twice and changes nothing while B still holds Learner 3.
    let again = bulk(&csv, later(5));
    assert_eq!(
        (at(&again, "repeated"), at(&again, "changed")),
        (Json::Bool(true), Json::int(0))
    );
    assert_eq!(at(&again, "sha256"), at(&first, "sha256"));
    assert_eq!(at(&again, "applied"), at(&first, "applied"));
    assert_eq!(at(&again, "rejected"), at(&first, "rejected"));
    let events = || -> i32 {
        o.db.client()
            .query_one(
                "SELECT count(*)::int FROM academy.assignment_grade_events g JOIN academy.assignment_submissions s \
                 ON s.id = g.submission_id WHERE s.item_id = $1::text::uuid",
                &[&item],
            )
            .unwrap()
            .get(0)
    };
    assert_eq!(events(), 2);
    // Once B's hold has run out, the same file applies the row refused for it, and only that row.
    let cleared = bulk(&csv, later(16));
    assert_eq!(
        (at(&cleared, "repeated"), at(&cleared, "changed")),
        (Json::Bool(true), Json::int(1))
    );
    assert_eq!(
        at(&cleared, "applied"),
        jp(r#"[{"line":2,"alias":1,"score":"7.5"},{"line":4,"alias":3,"score":"6"}]"#)
    );
    let lines: Vec<Json> = list(&at(&cleared, "rejected"))
        .iter()
        .map(|r| at(r, "line"))
        .collect();
    assert_eq!(
        lines,
        [Json::int(3), Json::int(5), Json::int(6), Json::int(7)]
    );
    assert_eq!(events(), 3);
    assert_eq!(at(&bulk(&csv, later(20)), "changed"), Json::int(0));

    // A fixed file with a reason is a new file: Learner 2's grade changes and keeps its first event.
    let fixed = bulk(
        "learner,score,comment,reason\n2,9,,Re-marked after review\n",
        now(),
    );
    assert_eq!(
        at(&fixed, "applied"),
        jp(r#"[{"line":2,"alias":2,"score":"9"}]"#)
    );
    assert_eq!(
        (
            at(&fixed, "queue.rows.1.grade.score"),
            at(&fixed, "queue.rows.1.grade.overrides")
        ),
        (s("9"), Json::int(1))
    );
}

#[test]
fn a_bulk_file_with_the_wrong_header_or_no_rows_refuses_whole_and_a_blank_lease_refuses_it() {
    let o = need!(open_assignment(&["Write-up"]));
    let item = o.item();
    o.hand_in(item, L, "L", 0);
    let bulk = |csv: &str, lease: Option<i64>| {
        grading::bulk_grade(&o.store, lease, item, "g.csv", csv, A, now())
    };
    assert_eq!(
        code_of(bulk("alias,score\n1,5\n", LEASE)),
        "academy.bulk_file_invalid"
    );
    assert_eq!(
        code_of(bulk("learner,score,comment,reason\n", LEASE)),
        "academy.bulk_file_invalid"
    );
    assert_eq!(
        code_of(bulk("learner,score,comment,reason\n1,\"5,,\n", LEASE)),
        "academy.bulk_file_invalid"
    );
    assert_eq!(
        code_of(bulk("learner,score,comment,reason\n1,5,,\n", None)),
        "academy.grader_lease_unset"
    );
    let n: i32 = o
        .db
        .client()
        .query_one("SELECT count(*)::int FROM academy.assignment_bulk_grades WHERE item_id = $1::text::uuid", &[&item])
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}
