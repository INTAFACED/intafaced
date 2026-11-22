//! Staff-published timed quizzes on curriculum items, against a real Postgres: the port of
//! `assessment/quiz.db.test.ts` (AC-quizzes-03), assertion for assertion, through the calls `AcademyService` makes
//! (`setQuiz`, `getAssessment`, `startQuizAttempt`, `answerQuizAttempt`, `currentQuizAttempt`, `finishQuizAttempt`,
//! `reviewQuizAttempt`, `submitAssessment`, `assessmentAttempts`). The last TypeScript test (the item rule on the course
//! outline and `markCurriculumComplete`) is the learner slice's, and stays with it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use support::{TestDb, at, code_of, jp, merged};
use svc_academy::assessment::legacy;
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::door::system_now;
use svc_academy::errors::Refusal;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const STAFF: &str = "44444444-4444-4444-8444-444444444444";
const NO_CATALOG: &[Json] = &[];

fn t(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
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

/// `listCurriculum({ path: 'markets' })[1].slug`.
fn slug() -> String {
    spine::list(Some("markets"), None)[1].slug.clone()
}

const QUESTIONS: &str = r#"[
  {"id":"q1","prompt":"TEST question one","points":1,"choices":[{"id":"a","text":"TEST wrong"},{"id":"b","text":"TEST right"}],"correctChoiceId":"b"},
  {"id":"q2","prompt":"TEST question two","points":1,"choices":[{"id":"c","text":"TEST right"},{"id":"d","text":"TEST wrong"}],"correctChoiceId":"c"}]"#;

const TIMED: &str =
    r#"{"passMark":2,"attemptLimit":2,"timeLimitSeconds":600,"reviewMode":"answers"}"#;

fn quiz(over: &str, questions: &str) -> Json {
    merged(
        &merged(&jp(TIMED), over),
        &format!(r#"{{"questions":{questions}}}"#),
    )
}

struct Fx {
    _db: TestDb,
    store: Store,
    slug: String,
}

impl Fx {
    fn publish(&self, q: Option<&Json>) -> Result<Json, Refusal> {
        legacy::set_quiz(
            &self.store,
            NO_CATALOG,
            &self.slug,
            q,
            "TEST quiz",
            STAFF,
            system_now().0,
        )
    }

    fn start(&self, user: &str, at_ms: i64) -> Result<Json, Refusal> {
        legacy::start(&self.store, NO_CATALOG, user, &self.slug, at_ms)
    }

    fn answer(
        &self,
        user: &str,
        attempt: &str,
        q: &str,
        choice: &str,
        at_ms: i64,
    ) -> Result<Json, Refusal> {
        legacy::answer(&self.store, user, attempt, q, choice, at_ms)
    }
}

fn fx() -> Option<Fx> {
    let db = TestDb::migrated()?;
    let store = Store::Pool(db.pool());
    Some(Fx {
        _db: db,
        store,
        slug: slug(),
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

#[test]
fn staff_publish_a_quiz_the_learner_reads_it_without_the_key_and_null_takes_it_down() {
    let f = need!(fx());
    let bad_key = QUESTIONS.replacen(r#""correctChoiceId":"b""#, r#""correctChoiceId":"z""#, 1);
    let bad_key = match jp(&bad_key) {
        Json::Array(qs) => Json::Array(qs.into_iter().take(1).collect()).compact(),
        _ => unreachable!(),
    };
    assert_eq!(
        code_of(f.publish(Some(&quiz("{}", &bad_key)))),
        "academy.assessment_invalid"
    );
    assert_eq!(
        code_of(legacy::set_quiz(
            &f.store,
            NO_CATALOG,
            "no-such-item",
            Some(&quiz("{}", QUESTIONS)),
            "TEST",
            STAFF,
            system_now().0
        )),
        "academy.curriculum_not_found"
    );
    assert_eq!(
        f.publish(Some(&quiz("{}", QUESTIONS))).unwrap(),
        jp(&format!(r#"{{"slug":"{}","published":true}}"#, f.slug))
    );
    let read = legacy::get(&f.store, NO_CATALOG, &f.slug).unwrap();
    for (k, v) in [
        ("passMark", Json::int(2)),
        ("timeLimitSeconds", Json::int(600)),
        ("attemptLimit", Json::int(2)),
        ("reviewMode", s("answers")),
    ] {
        assert_eq!(at(&read, k), v, "{k}");
    }
    assert!(!read.compact().contains("correctChoiceId"));
    assert_eq!(
        f.publish(None).unwrap(),
        jp(&format!(r#"{{"slug":"{}","published":false}}"#, f.slug))
    );
    assert_eq!(
        code_of(legacy::get(&f.store, NO_CATALOG, &f.slug)),
        "academy.assessment_unpublished"
    );
}

#[test]
fn start_twice_returns_the_same_attempt_with_the_server_held_time_left_and_answers_autosave() {
    let f = need!(fx());
    f.publish(Some(&quiz("{}", QUESTIONS))).unwrap();
    let t0 = t("2026-10-23T10:00:00.000Z");
    let started = f.start(USER, t0).unwrap();
    for (k, v) in [
        ("number", Json::int(1)),
        ("deadlineAt", s("2026-10-23T10:10:00.000Z")),
        ("secondsLeft", Json::int(600)),
        ("answers", jp("{}")),
        ("result", Json::Null),
    ] {
        assert_eq!(at(&started, k), v, "{k}");
    }
    let attempt = text(&at(&started, "attemptId"));
    let t1 = t0 + 61_000;
    let again = f.start(USER, t1).unwrap();
    assert_eq!(
        (at(&again, "attemptId"), at(&again, "secondsLeft")),
        (s(&attempt), Json::int(539))
    );
    f.answer(USER, &attempt, "q1", "b", t1).unwrap();
    let resumed = legacy::current(&f.store, USER, &f.slug, t0 + 120_000).unwrap();
    assert_eq!(
        (
            at(&resumed, "attemptId"),
            at(&resumed, "secondsLeft"),
            at(&resumed, "answers")
        ),
        (s(&attempt), Json::int(480), jp(r#"{"q1":"b"}"#))
    );
    assert_eq!(
        code_of(f.answer(USER, &attempt, "q1", "zz", t1)),
        "academy.assessment_invalid"
    );
    assert_eq!(
        code_of(f.answer(OTHER, &attempt, "q1", "a", t1)),
        "academy.attempt_not_found"
    );
    assert_eq!(
        code_of(legacy::review(&f.store, USER, &attempt, t1)),
        "academy.attempt_open"
    );
    assert_eq!(
        legacy::current(&f.store, OTHER, &f.slug, t1).unwrap(),
        Json::Null
    );
}

#[test]
fn finish_scores_once_the_review_shows_my_own_answers_and_the_limit_refuses_start() {
    let f = need!(fx());
    f.publish(Some(&quiz(r#"{"attemptLimit":1}"#, QUESTIONS)))
        .unwrap();
    let now = system_now().0;
    let attempt = text(&at(&f.start(USER, now).unwrap(), "attemptId"));
    f.answer(USER, &attempt, "q1", "b", now).unwrap();
    f.answer(USER, &attempt, "q2", "d", now).unwrap();
    let first = legacy::finish(&f.store, USER, &attempt, now).unwrap();
    assert_eq!(
        (
            at(&first, "result.score"),
            at(&first, "result.maxScore"),
            at(&first, "result.pass")
        ),
        (Json::int(1), Json::int(2), Json::Bool(false))
    );
    assert_eq!(
        legacy::finish(&f.store, USER, &attempt, now + 5_000).unwrap(),
        first
    );
    match legacy::attempts(&f.store, NO_CATALOG, USER, &f.slug, now).unwrap() {
        Json::Array(rows) => assert_eq!(rows.len(), 1),
        other => panic!("{other:?}"),
    }
    let review = legacy::review(&f.store, USER, &attempt, now).unwrap();
    let rows: Vec<(Json, Json, Json)> = match at(&review, "questions") {
        Json::Array(qs) => qs
            .iter()
            .map(|q| (at(q, "id"), at(q, "chosenChoiceId"), at(q, "correct")))
            .collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        rows,
        [
            (s("q1"), s("b"), Json::Bool(true)),
            (s("q2"), s("d"), Json::Bool(false))
        ]
    );
    assert_eq!(
        code_of(legacy::review(&f.store, OTHER, &attempt, now)),
        "academy.attempt_not_found"
    );
    assert_eq!(
        code_of(f.answer(USER, &attempt, "q2", "c", now)),
        "academy.attempt_closed"
    );
    assert_eq!(code_of(f.start(USER, now)), "academy.attempt_limit");

    // The review is of the quiz as it was at Start: a later switch to score only does not hide this attempt's answers.
    f.publish(Some(&quiz(
        r#"{"attemptLimit":1,"reviewMode":"score_only"}"#,
        QUESTIONS,
    )))
    .unwrap();
    assert_eq!(
        at(
            &legacy::review(&f.store, USER, &attempt, now).unwrap(),
            "reviewMode"
        ),
        s("answers")
    );
}

#[test]
fn an_attempt_keeps_the_quiz_it_started_with_through_an_edit_or_a_take_down() {
    let f = need!(fx());
    f.publish(Some(&quiz("{}", QUESTIONS))).unwrap();
    let now = system_now().0;
    let attempt = text(&at(&f.start(USER, now).unwrap(), "attemptId"));
    f.answer(USER, &attempt, "q1", "b", now).unwrap();
    // Staff change the key on q1, then take the quiz down, while the attempt is open.
    let changed = QUESTIONS.replacen(r#""correctChoiceId":"b""#, r#""correctChoiceId":"a""#, 1);
    legacy::set_quiz(
        &f.store,
        NO_CATALOG,
        &f.slug,
        Some(&quiz("{}", &changed)),
        "TEST",
        STAFF,
        now,
    )
    .unwrap();
    f.publish(None).unwrap();
    f.answer(USER, &attempt, "q2", "c", now).unwrap();
    let done = legacy::finish(&f.store, USER, &attempt, now).unwrap();
    assert_eq!(
        (
            at(&done, "result.score"),
            at(&done, "result.maxScore"),
            at(&done, "result.pass")
        ),
        (Json::int(2), Json::int(2), Json::Bool(true))
    );
    let review = legacy::review(&f.store, USER, &attempt, now).unwrap();
    let rows: Vec<(Json, Json, Json)> = match at(&review, "questions") {
        Json::Array(qs) => qs
            .iter()
            .map(|q| (at(q, "id"), at(q, "correctChoiceId"), at(q, "correct")))
            .collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        rows,
        [
            (s("q1"), s("b"), Json::Bool(true)),
            (s("q2"), s("c"), Json::Bool(true))
        ]
    );
}

#[test]
fn a_staff_quiz_is_taken_with_start_only_and_a_direct_submit_refuses() {
    let f = need!(fx());
    f.publish(Some(&quiz(r#"{"timeLimitSeconds":null}"#, QUESTIONS)))
        .unwrap();
    let now = system_now().0;
    let answers = [("q1".to_owned(), "b".to_owned())];
    assert_eq!(
        code_of(legacy::submit(
            &f.store, NO_CATALOG, USER, &f.slug, &answers, "direct-1", now
        )),
        "academy.attempt_required"
    );
    assert_eq!(
        legacy::attempts(&f.store, NO_CATALOG, USER, &f.slug, now).unwrap(),
        jp("[]")
    );
}

#[test]
fn a_pass_mark_above_the_questions_points_is_refused() {
    let f = need!(fx());
    assert_eq!(
        code_of(f.publish(Some(&quiz(r#"{"passMark":3}"#, QUESTIONS)))),
        "academy.assessment_invalid"
    );
}

#[test]
fn start_keeps_the_cooldown_and_the_attempt_limit_and_a_submit_refuses_while_an_attempt_is_open() {
    let f = need!(fx());
    let coded = match jp(QUESTIONS) {
        Json::Array(qs) => Json::Array(
            qs.into_iter()
                .map(|q| merged(&q, r#"{"kind":"single"}"#))
                .collect(),
        ),
        _ => unreachable!(),
    };
    let catalog = [jp(&format!(
        r#"{{"slug":"{}","kind":"quiz","passMark":2,"attemptLimit":3,"cooldownSeconds":3600,"questions":{}}}"#,
        f.slug,
        coded.compact()
    ))];
    let t0 = t("2026-10-23T10:00:00.000Z");
    let attempt = text(&at(
        &legacy::start(&f.store, &catalog, USER, &f.slug, t0).unwrap(),
        "attemptId",
    ));
    assert_eq!(
        code_of(legacy::submit(
            &f.store,
            &catalog,
            USER,
            &f.slug,
            &[],
            "direct-1",
            t0
        )),
        "academy.attempt_open"
    );
    legacy::finish(&f.store, USER, &attempt, t0).unwrap();
    assert_eq!(
        code_of(legacy::start(
            &f.store,
            &catalog,
            USER,
            &f.slug,
            t0 + 60_000
        )),
        "academy.attempt_cooldown"
    );
    assert_eq!(
        at(
            &legacy::start(&f.store, &catalog, USER, &f.slug, t0 + 3_601_000).unwrap(),
            "number"
        ),
        Json::int(2)
    );
}

#[test]
fn an_attempt_past_its_deadline_is_finished_with_the_answers_saved_by_then() {
    let f = need!(fx());
    f.publish(Some(&quiz(r#"{"timeLimitSeconds":60}"#, QUESTIONS)))
        .unwrap();
    let t0 = t("2026-10-23T10:00:00.000Z");
    let attempt = text(&at(&f.start(USER, t0).unwrap(), "attemptId"));
    f.answer(USER, &attempt, "q1", "b", t0).unwrap();
    let late = t0 + 61_000;
    assert_eq!(
        code_of(f.answer(USER, &attempt, "q2", "c", late)),
        "academy.attempt_closed"
    );
    assert_eq!(
        legacy::current(&f.store, USER, &f.slug, late).unwrap(),
        Json::Null
    );
    let done = legacy::finish(&f.store, USER, &attempt, late).unwrap();
    assert_eq!(
        at(&done, "result"),
        jp(
            r#"{"hidden":false,"score":1,"maxScore":2,"pass":false,"finishedAt":"2026-10-23T10:01:00.000Z"}"#
        )
    );
    let second = f.start(USER, late).unwrap();
    assert_eq!(at(&second, "number"), Json::int(2));
    assert_ne!(at(&second, "attemptId"), s(&attempt));
}
