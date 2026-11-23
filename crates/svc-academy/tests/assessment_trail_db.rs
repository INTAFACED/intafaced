//! Score changes after grading, the curve file and quiz analytics, against a real Postgres: the port of
//! `curriculum/course-quiz-trail.db.test.ts` (AC-quizzes-04), assertion for assertion. The course and the learners'
//! enrolments are another slice's calls; they are written here as the rows those calls leave.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use support::{TestDb, at, code_of, enrol, jp, merged, seed_course};
use svc_academy::assessment::{analytics, gradebook, quizzes, trail};
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const M: &str = "77777777-7777-4777-8777-777777777777";
const OUTSIDER: &str = "66666666-6666-4666-8666-666666666666";
const NOW_ISO: &str = "2026-10-23T12:00:00.000Z";

fn now() -> i64 {
    service_kit::time::js_date(NOW_ISO).unwrap().0
}

fn later(minutes: i64) -> i64 {
    now() + minutes * 60_000
}

const Q1: &str = r#"{"kind":"single","id":"q1","prompt":"TEST What caps the loss on a trade?","points":2,
  "choices":[{"id":"a","text":"A stop"},{"id":"b","text":"Hope"}],"correctChoiceId":"a"}"#;
const N1: &str = r#"{"kind":"numeric","id":"n1","prompt":"TEST Size?","points":3,"answer":"10","tolerance":"0"}"#;

fn two() -> Json {
    jp(&format!("[{Q1},{N1}]"))
}

/// `TWO` with each question passed through `f`.
fn map_two(f: impl Fn(Json) -> Json) -> Json {
    match two() {
        Json::Array(qs) => Json::Array(qs.into_iter().map(f).collect()),
        _ => unreachable!(),
    }
}

fn with(q: Json, over: &str) -> Json {
    merged(&q, over)
}

fn kind(q: &Json) -> String {
    at(q, "kind").compact()
}

fn draft(item: &str, revision: i64, over: &str) -> Json {
    let base = jp(&format!(
        r#"{{"itemId":"{item}","revision":{revision},"passMark":1,"attemptLimit":1,"scoringPolicy":null,"timeLimitSeconds":null,
            "reviewMode":"score_only","ipAllow":null,"kind":"quiz","anonymous":false,"resultsVisibility":"always",
            "questions":[{Q1}]}}"#
    ));
    merged(&base, over)
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

struct Taken {
    db: TestDb,
    store: Store,
    course: String,
    item: String,
    l: String,
    m: String,
}

/// A free course with one quiz item (and a lesson), published, with L and M enrolled.
fn course() -> Option<(TestDb, Store, String, String)> {
    let db = TestDb::migrated()?;
    let mut c = db.client();
    let seeded = seed_course(
        &mut c,
        "risk-basics",
        "published",
        A,
        NOW_ISO,
        &[("quiz", "Check yourself"), ("lesson", "Read me")],
    );
    for user in [L, M] {
        enrol(&mut c, &seeded.id, user, NOW_ISO);
    }
    let store = Store::Pool(db.pool());
    Some((db, store, seeded.id, seeded.items[0].clone()))
}

/// Q1 single (2 points, key a), Q2 numeric (3 points, key 10 ± 0); pass mark 3. Published. L answers b and 10; M answers a and 12.
fn taken() -> Option<Taken> {
    let (db, store, course, item) = course()?;
    quizzes::save(
        &store,
        &draft(
            &item,
            0,
            &format!(r#"{{"questions":{},"passMark":3}}"#, two().compact()),
        ),
        A,
        now(),
    )
    .unwrap();
    quizzes::set_state(&store, &item, "published", "TEST", A, now()).unwrap();
    let mut ids = Vec::new();
    for (user, choice, size) in [(L, "b", "10"), (M, "a", "12")] {
        let attempt = quizzes::start(&store, &item, user, None, None, now()).unwrap();
        let a = text(&at(&attempt, "attemptId"));
        quizzes::answer(&store, &a, user, "q1", &s(choice), now()).unwrap();
        quizzes::answer(&store, &a, user, "n1", &s(size), now()).unwrap();
        quizzes::finish(&store, &a, user, now()).unwrap();
        ids.push(a);
    }
    let m = ids.pop().unwrap();
    let l = ids.pop().unwrap();
    Some(Taken {
        db,
        store,
        course,
        item,
        l,
        m,
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

fn row_of(attempts: &Json, id: &str) -> Json {
    match at(attempts, "attempts") {
        Json::Array(rows) => rows
            .into_iter()
            .find(|r| at(r, "attemptId") == s(id))
            .expect("the attempt is listed"),
        other => panic!("{other:?}"),
    }
}

fn rows(attempts: &Json) -> Vec<Json> {
    match at(attempts, "attempts") {
        Json::Array(rows) => rows,
        other => panic!("{other:?}"),
    }
}

fn expect_fields(row: &Json, fields: &[(&str, Json)]) {
    for (k, v) in fields {
        assert_eq!(&at(row, k), v, "{k} of {}", row.compact());
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "the override's input, field for field"
)]
fn override_score(
    t: &Taken,
    item: &str,
    attempt: &str,
    points: i64,
    n: i64,
    comment: Option<&str>,
    reason: &str,
    at_ms: i64,
) -> Result<Json, Refusal> {
    trail::override_score(
        &t.store, item, attempt, "q1", points, n, comment, reason, A, at_ms,
    )
}

// ── score changes after grading (AC-quizzes-04) ────────────────────────────────────────────────────────────────────

#[test]
fn an_override_is_a_new_event_keeps_the_old_one_and_the_learner_and_gradebook_see_it() {
    let t = need!(taken());
    let before = trail::attempts(&t.store, &t.item).unwrap();
    let l_row = row_of(&before, &t.l);
    expect_fields(
        &l_row,
        &[
            ("alias", Json::int(1)),
            ("score", Json::int(3)),
            ("originalScore", Json::int(3)),
            ("maxScore", Json::int(5)),
            ("nextN", Json::int(1)),
            ("events", jp("[]")),
        ],
    );
    assert!(!before.compact().contains(L));
    let over = |points: i64, n: i64| {
        override_score(
            &t,
            &t.item,
            &t.l,
            points,
            n,
            Some("TEST stop named in words"),
            "TEST regrade",
            later(1),
        )
    };
    let after = over(2, 1).unwrap();
    let row = row_of(&after, &t.l);
    expect_fields(
        &row,
        &[
            ("score", Json::int(5)),
            ("originalScore", Json::int(3)),
            ("passed", Json::Bool(true)),
            ("nextN", Json::int(2)),
        ],
    );
    assert_eq!(
        rows(&jp(&format!(
            r#"{{"attempts":{}}}"#,
            at(&row, "events").compact()
        )))
        .len(),
        1
    );
    expect_fields(
        &at(&row, "events.0"),
        &[
            ("n", Json::int(1)),
            ("kind", s("override")),
            ("questionId", s("q1")),
            ("previousScore", Json::int(3)),
            ("score", Json::int(5)),
            ("comment", s("TEST stop named in words")),
        ],
    );
    // The same n again answers as stored; a stale n and points above the question's refuse.
    assert!(over(2, 1).is_ok());
    assert_eq!(code_of(over(1, 1)), "academy.revision_stale");
    assert_eq!(code_of(over(9, 2)), "academy.assessment_invalid");
    let mine = quizzes::current(&t.store, &t.item, L, later(2)).unwrap();
    expect_fields(
        &mine,
        &[
            ("result.state", s("graded")),
            ("result.score", Json::int(5)),
            ("result.pass", Json::Bool(true)),
        ],
    );
    let book = gradebook::view(&t.store, &t.course).unwrap();
    assert!(
        book.compact().contains(r#""score":"1""#),
        "{}",
        book.compact()
    );
}

#[test]
fn a_key_fix_changes_only_keys_and_a_rescore_applies_it_once_per_attempt() {
    let t = need!(taken());
    let revision = match at(&quizzes::admin_view(&t.store, &t.item).unwrap(), "revision") {
        Json::Number(n) => n as i64,
        other => panic!("{other:?}"),
    };
    let fixed = map_two(|q| {
        if kind(&q) == "\"numeric\"" {
            with(q, r#"{"answer":"12"}"#)
        } else {
            q
        }
    });
    let questions = |j: &Json| match j {
        Json::Array(qs) => qs.clone(),
        _ => unreachable!(),
    };
    let fix = |qs: &Json, rev: i64| {
        trail::fix_key(
            &t.store,
            &t.item,
            rev,
            &questions(qs),
            "TEST the size was 12",
            A,
            later(1),
        )
    };
    assert_eq!(code_of(fix(&two(), revision)), "academy.key_fix_invalid");
    let reworded = match &fixed {
        Json::Array(qs) => Json::Array(
            qs.iter()
                .map(|q| {
                    let prompt = text(&at(q, "prompt"));
                    with(
                        q.clone(),
                        &format!(
                            r#"{{"prompt":{}}}"#,
                            Json::String(format!("{prompt}!")).compact()
                        ),
                    )
                })
                .collect(),
        ),
        _ => unreachable!(),
    };
    assert_eq!(code_of(fix(&reworded, revision)), "academy.key_fix_invalid");
    let first_only = Json::Array(questions(&fixed).into_iter().take(1).collect());
    assert_eq!(
        code_of(fix(&first_only, revision)),
        "academy.key_fix_invalid"
    );
    fix(&fixed, revision).unwrap();
    assert_eq!(code_of(fix(&fixed, revision)), "academy.revision_stale");
    // Until a rescore, every attempt keeps its score.
    let scores: Vec<Json> = rows(&trail::attempts(&t.store, &t.item).unwrap())
        .iter()
        .map(|r| at(r, "score"))
        .collect();
    assert_eq!(scores, [Json::int(3), Json::int(2)]);
    let rescored = trail::rescore(&t.store, &t.item, "TEST key fixed", A, later(2)).unwrap();
    assert_eq!(at(&rescored, "revision"), Json::int(revision + 1));
    assert_eq!(
        at(&rescored, "rescored"),
        jp(r#"[{"alias":1,"number":1,"from":3,"to":0},{"alias":2,"number":1,"from":2,"to":5}]"#)
    );
    let m = row_of(&at(&rescored, "attempts"), &t.m);
    expect_fields(
        &m,
        &[
            ("score", Json::int(5)),
            ("originalScore", Json::int(2)),
            ("passed", Json::Bool(true)),
        ],
    );
    match at(&m, "events") {
        Json::Array(events) => assert_eq!(events.len(), 1),
        other => panic!("{other:?}"),
    }
    expect_fields(
        &at(&m, "events.0"),
        &[
            ("kind", s("rescore")),
            ("revision", Json::int(revision + 1)),
            ("previousScore", Json::int(2)),
            ("score", Json::int(5)),
        ],
    );
    let mine = quizzes::current(&t.store, &t.item, M, later(3)).unwrap();
    expect_fields(
        &mine,
        &[
            ("result.score", Json::int(5)),
            ("result.pass", Json::Bool(true)),
        ],
    );
    // Again at the same revision: nothing changes.
    assert_eq!(
        at(
            &trail::rescore(&t.store, &t.item, "TEST again", A, later(4)).unwrap(),
            "rescored"
        ),
        jp("[]")
    );
}

#[test]
fn an_attempt_on_another_quiz_is_not_overridden_and_another_quiz_is_not_rescored() {
    let t = need!(taken());
    assert_eq!(
        code_of(override_score(
            &t,
            OUTSIDER,
            &t.l,
            1,
            1,
            None,
            "TEST",
            now()
        )),
        "academy.attempt_not_found"
    );
    assert_eq!(
        code_of(trail::rescore(&t.store, OUTSIDER, "TEST", A, now())),
        "academy.quiz_not_found"
    );
}

#[test]
fn an_override_survives_a_key_fix_on_another_question_and_a_fix_of_its_own_rescores_it() {
    let t = need!(taken());
    // L answered q1 "b" (0 of 2) and n1 10 (3 of 3). Staff give q1 2 by hand: 5.
    override_score(&t, &t.item, &t.l, 2, 1, None, "TEST by hand", later(1)).unwrap();
    let fix_n1 = map_two(|q| {
        if kind(&q) == "\"numeric\"" {
            with(q, r#"{"answer":"12"}"#)
        } else {
            q
        }
    });
    let revision =
        |t: &Taken| match at(&quizzes::admin_view(&t.store, &t.item).unwrap(), "revision") {
            Json::Number(n) => n as i64,
            other => panic!("{other:?}"),
        };
    let list = |j: &Json| match j {
        Json::Array(qs) => qs.clone(),
        _ => unreachable!(),
    };
    trail::fix_key(
        &t.store,
        &t.item,
        revision(&t),
        &list(&fix_n1),
        "TEST n1 is 12",
        A,
        later(2),
    )
    .unwrap();
    assert!(
        rows(&trail::attempts(&t.store, &t.item).unwrap())
            .iter()
            .all(|r| at(r, "rescoreDue") == Json::Bool(true))
    );
    trail::rescore(&t.store, &t.item, "TEST n1", A, later(3)).unwrap();
    let l = row_of(&trail::attempts(&t.store, &t.item).unwrap(), &t.l);
    // q1 keeps the override (2); n1 is rescored to 0: 2.
    expect_fields(
        &l,
        &[("score", Json::int(2)), ("rescoreDue", Json::Bool(false))],
    );
    let earned = |row: &Json| -> Vec<Json> {
        list(&at(row, "questions"))
            .iter()
            .map(|q| at(q, "earned"))
            .collect()
    };
    assert_eq!(earned(&l), [Json::int(2), Json::int(0)]);
    // Now q1's own key changes to "b": the rescore applies it to q1 (2 points for "b").
    let fix_q1 = Json::Array(
        list(&fix_n1)
            .into_iter()
            .map(|q| {
                if kind(&q) == "\"single\"" {
                    with(q, r#"{"correctChoiceId":"b"}"#)
                } else {
                    q
                }
            })
            .collect(),
    );
    trail::fix_key(
        &t.store,
        &t.item,
        revision(&t),
        &list(&fix_q1),
        "TEST q1 is b",
        A,
        later(4),
    )
    .unwrap();
    let again = trail::rescore(&t.store, &t.item, "TEST q1", A, later(5)).unwrap();
    let aliases: Vec<Json> = list(&at(&again, "rescored"))
        .iter()
        .map(|r| at(r, "alias"))
        .collect();
    assert_eq!(aliases, [Json::int(2)]);
    let l = row_of(&at(&again, "attempts"), &t.l);
    assert_eq!(earned(&l), [Json::int(2), Json::int(0)]);
    let kinds: Vec<Json> = list(&at(&l, "events"))
        .iter()
        .map(|e| at(e, "kind"))
        .collect();
    assert_eq!(kinds, [s("override"), s("rescore")]);
}

// ── a curve file and quiz analytics (AC-quizzes-04) ────────────────────────────────────────────────────────────────

fn curve(t: &Taken, csv: &str, dry_run: bool, limit: Option<i64>) -> Result<Json, Refusal> {
    trail::curve(
        &t.store,
        limit,
        &t.item,
        "TEST-curve.csv",
        csv,
        dry_run,
        "TEST curve",
        A,
        later(1),
    )
}

#[test]
fn a_dry_run_applies_nothing_a_refused_row_refuses_the_file_and_a_good_file_applies_once() {
    let t = need!(taken());
    let bad = "learner,score\nLearner 1,4\nLearner 9,5\n";
    let dry = curve(&t, bad, true, Some(4096)).unwrap();
    expect_fields(
        &dry,
        &[
            ("dryRun", Json::Bool(true)),
            ("applied", Json::Bool(false)),
            ("repeated", Json::Bool(false)),
            (
                "rows",
                jp(r#"[{"line":2,"alias":1,"number":1,"from":3,"to":4}]"#),
            ),
            (
                "rejected",
                jp(
                    r#"[{"line":3,"alias":9,"code":"academy.attempt_not_found","message":"no Learner 9 took this quiz"}]"#,
                ),
            ),
        ],
    );
    assert_eq!(
        code_of(curve(&t, bad, false, Some(4096))),
        "academy.bulk_file_invalid"
    );
    assert!(
        rows(&trail::attempts(&t.store, &t.item).unwrap())
            .iter()
            .all(|r| at(r, "events") == jp("[]"))
    );

    let good = "learner,score\nLearner 1,4\nLearner 2,3\n";
    let applied = curve(&t, good, false, Some(4096)).unwrap();
    expect_fields(
        &applied,
        &[
            ("applied", Json::Bool(true)),
            ("repeated", Json::Bool(false)),
        ],
    );
    let moves: Vec<(Json, Json, Json)> = match at(&applied, "rows") {
        Json::Array(rs) => rs
            .iter()
            .map(|r| (at(r, "alias"), at(r, "from"), at(r, "to")))
            .collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        moves,
        [
            (Json::int(1), Json::int(3), Json::int(4)),
            (Json::int(2), Json::int(2), Json::int(3))
        ]
    );
    let repeated = curve(&t, good, false, Some(4096)).unwrap();
    expect_fields(
        &repeated,
        &[
            ("applied", Json::Bool(false)),
            ("repeated", Json::Bool(true)),
            ("rows", at(&applied, "rows")),
        ],
    );
    // A row that leaves a score as it is writes no event.
    let same = curve(&t, "learner,score\nLearner 1,4\n", false, Some(4096)).unwrap();
    assert_eq!(
        at(&same, "rows"),
        jp(r#"[{"line":2,"alias":1,"number":1,"from":4,"to":4}]"#)
    );
    let l = row_of(&trail::attempts(&t.store, &t.item).unwrap(), &t.l);
    expect_fields(
        &l,
        &[
            ("score", Json::int(4)),
            ("originalScore", Json::int(3)),
            ("events.1", Json::Null),
        ],
    );
    expect_fields(
        &at(&l, "events.0"),
        &[
            ("kind", s("curve")),
            ("previousScore", Json::int(3)),
            ("score", Json::int(4)),
        ],
    );
    // An override after a curve keeps the curve's difference, held to the maximum: q1 0 → 2 would make 6 of 5, so 5.
    let after = override_score(&t, &t.item, &t.l, 2, 2, None, "TEST", later(2)).unwrap();
    assert_eq!(at(&row_of(&after, &t.l), "score"), Json::int(5));
}

#[test]
fn a_blank_size_limit_a_file_over_it_a_bad_header_and_a_score_above_the_maximum_refuse() {
    let t = need!(taken());
    assert_eq!(
        code_of(curve(&t, "learner,score\n1,4\n", true, None)),
        "academy.bulk_limit_unset"
    );
    assert_eq!(
        code_of(curve(&t, "learner,score\n1,4\n", true, Some(10))),
        "academy.bulk_file_too_large"
    );
    assert_eq!(
        code_of(curve(&t, "alias,score\n1,4\n", true, Some(4096))),
        "academy.bulk_file_invalid"
    );
    let over = curve(&t, "learner,score\n1,6\n", true, Some(4096)).unwrap();
    assert_eq!(
        at(&over, "rejected.0.code"),
        s("academy.assessment_invalid")
    );
}

#[test]
fn analytics_shows_an_empty_state_then_item_analysis_and_the_distribution_from_real_attempts() {
    let (_db, store, _course, item) = need!(course());
    quizzes::save(
        &store,
        &draft(
            &item,
            0,
            &format!(r#"{{"questions":{},"passMark":3}}"#, two().compact()),
        ),
        A,
        now(),
    )
    .unwrap();
    quizzes::set_state(&store, &item, "published", "TEST", A, now()).unwrap();
    let empty = analytics::analytics(&store, &item).unwrap();
    expect_fields(
        &empty,
        &[
            ("graded", Json::int(0)),
            ("learners", Json::int(0)),
            ("scoreDistribution", jp("[]")),
        ],
    );
    let items: Vec<(Json, Json, Json)> = match at(&empty, "items") {
        Json::Array(is) => is
            .iter()
            .map(|i| {
                (
                    at(i, "attempts"),
                    at(i, "fullMarksShare"),
                    at(i, "meanPoints"),
                )
            })
            .collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        items,
        [
            (Json::int(0), Json::Null, Json::Null),
            (Json::int(0), Json::Null, Json::Null)
        ]
    );

    let t = need!(taken());
    let stats = analytics::analytics(&t.store, &t.item).unwrap();
    // L: q1 0, n1 3 (score 3); M: q1 2, n1 0 (score 2).
    expect_fields(
        &stats,
        &[("graded", Json::int(2)), ("learners", Json::int(2))],
    );
    let distribution = Json::Array(
        (0..=5)
            .map(|score| {
                Json::obj([
                    ("score", Json::int(score)),
                    ("count", Json::int(i64::from(score == 2 || score == 3))),
                ])
            })
            .collect(),
    );
    assert_eq!(at(&stats, "scoreDistribution"), distribution);
    let items: Vec<[Json; 5]> = match at(&stats, "items") {
        Json::Array(is) => is
            .iter()
            .map(|i| {
                [
                    at(i, "questionId"),
                    at(i, "attempts"),
                    at(i, "fullMarksShare"),
                    at(i, "meanPoints"),
                    at(i, "firstAttemptFullMarksShare"),
                ]
            })
            .collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        items,
        [
            [s("q1"), Json::int(2), s("50.0"), s("1.00"), s("50.0")],
            [s("n1"), Json::int(2), s("50.0"), s("1.50"), s("50.0")],
        ]
    );
    assert_eq!(
        code_of(analytics::answers(&t.store, &t.item)),
        "academy.permission_denied"
    );
    drop(t.db);
}
