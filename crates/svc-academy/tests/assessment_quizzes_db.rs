//! Quizzes and surveys on the items of a course staff made, against a real Postgres: the port of
//! `curriculum/course-quizzes.db.test.ts` (AC-quizzes-01, AC-quizzes-02), assertion for assertion. The course, its outline
//! and the learner's enrolment are another slice's calls (`CourseRecords`, `CourseLearners`); they are written here as
//! the rows those calls leave (`support::seed_course`, `support::enrol`).
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
use svc_academy::assessment::quizzes::{self, address_allowed, proxy_rules, resolve_address};
use svc_academy::assessment::scrypt::{access_code_matches, hash_access_code, random_salt};
use svc_academy::db::Store;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const OUTSIDER: &str = "66666666-6666-4666-8666-666666666666";
const NOW_ISO: &str = "2026-10-23T12:00:00.000Z";

fn now() -> i64 {
    service_kit::time::js_date(NOW_ISO).unwrap().0
}

const QUESTIONS: &str = r#"[{"kind":"single","id":"q1","prompt":"TEST What caps the loss on a trade?","points":2,
  "choices":[{"id":"a","text":"A stop"},{"id":"b","text":"Hope"}],"correctChoiceId":"a"}]"#;

const MIXED: &str = r#"[
  {"kind":"numeric","id":"n1","prompt":"TEST Risk on 1000 at 2%?","points":2,"answer":"20","tolerance":"0.5"},
  {"kind":"multi","id":"m1","prompt":"TEST Which cap a loss?","points":2,
   "choices":[{"id":"a","text":"A stop"},{"id":"b","text":"Position size"},{"id":"c","text":"Hope"}],
   "correctChoiceIds":["a","b"],"partialCredit":true},
  {"kind":"essay","id":"e1","prompt":"TEST Why size before entry?","points":4}]"#;

/// `{ itemId, revision, ...draft(over) }`.
fn draft(item: &str, revision: i64, over: &str) -> Json {
    let base = jp(&format!(
        r#"{{"itemId":"{item}","revision":{revision},"passMark":1,"attemptLimit":1,"scoringPolicy":null,"timeLimitSeconds":null,
            "reviewMode":"score_only","ipAllow":null,"kind":"quiz","anonymous":false,"resultsVisibility":"always",
            "questions":{QUESTIONS}}}"#
    ));
    merged(&base, over)
}

struct Fixture {
    db: TestDb,
    store: Store,
    quiz: String,
    lesson: String,
}

/// A free course with one quiz item (and a lesson item), published, with learner L enrolled.
fn course() -> Option<Fixture> {
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
    enrol(&mut c, &seeded.id, L, NOW_ISO);
    let store = Store::Pool(db.pool());
    Some(Fixture {
        db,
        store,
        quiz: seeded.items[0].clone(),
        lesson: seeded.items[1].clone(),
    })
}

macro_rules! fixture {
    () => {
        match course() {
            Some(f) => f,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

fn save(f: &Fixture, input: &Json) -> Result<Json, svc_academy::errors::Refusal> {
    quizzes::save(&f.store, input, A, now())
}

fn publish(f: &Fixture, id: &str) -> Json {
    quizzes::set_state(&f.store, id, "published", "TEST", A, now()).unwrap()
}

fn start(
    f: &Fixture,
    id: &str,
    user: &str,
    code: Option<&str>,
    address: Option<&str>,
) -> Result<Json, svc_academy::errors::Refusal> {
    quizzes::start(&f.store, id, user, code, address, now())
}

fn s(v: &str) -> Json {
    Json::str(v)
}

// ── a quiz on a course staff made (AC-quizzes-01) ──────────────────────────────────────────────────────────────────

#[test]
fn a_quiz_item_with_nothing_saved_is_revision_0_with_every_blocker_and_another_kind_is_not_a_quiz()
{
    let f = fixture!();
    let view = quizzes::admin_view(&f.store, &f.quiz).unwrap();
    assert_eq!(at(&view, "revision"), Json::int(0));
    assert_eq!(at(&view, "state"), s("draft"));
    assert_eq!(at(&view, "questions"), jp("[]"));
    assert_eq!(at(&view, "attempts"), Json::int(0));
    assert_eq!(
        at(&view, "blockers"),
        jp(
            r#"["academy.quiz_no_questions","academy.pass_mark_unset","academy.scoring_policy_unset"]"#
        )
    );
    assert_eq!(
        code_of(quizzes::admin_view(&f.store, &f.lesson)),
        "academy.quiz_not_found"
    );
}

#[test]
fn publish_refuses_a_blank_pass_mark_then_no_scoring_policy_and_publishes_once_both_are_set() {
    let f = fixture!();
    let id = f.quiz.as_str();
    save(&f, &draft(id, 0, r#"{"passMark":null}"#)).unwrap();
    assert_eq!(
        code_of(quizzes::set_state(
            &f.store,
            id,
            "published",
            "TEST",
            A,
            now()
        )),
        "academy.pass_mark_unset"
    );
    save(&f, &draft(id, 1, r#"{"attemptLimit":2}"#)).unwrap();
    assert_eq!(
        code_of(quizzes::set_state(
            &f.store,
            id,
            "published",
            "TEST",
            A,
            now()
        )),
        "academy.scoring_policy_unset"
    );
    assert_eq!(
        code_of(save(&f, &draft(id, 1, "{}"))),
        "academy.revision_stale"
    );
    save(
        &f,
        &draft(id, 2, r#"{"attemptLimit":2,"scoringPolicy":"highest"}"#),
    )
    .unwrap();
    let published = quizzes::set_state(&f.store, id, "published", "TEST ready", A, now()).unwrap();
    assert_eq!(at(&published, "state"), s("published"));
    assert_eq!(at(&published, "revision"), Json::int(3));
    assert_eq!(at(&published, "blockers"), jp("[]"));
    assert_eq!(at(&published, "publishedAt"), s(NOW_ISO));
    let mut kinds = f.db.texts(&format!(
        "SELECT kind FROM academy.course_quiz_events WHERE item_id = '{id}' ORDER BY at, kind"
    ));
    kinds.sort();
    assert_eq!(kinds, ["published", "saved", "saved", "saved"]);
}

#[test]
fn a_pass_mark_above_the_points_and_an_ip_entry_that_is_no_address_are_refused() {
    let f = fixture!();
    assert_eq!(
        code_of(save(&f, &draft(&f.quiz, 0, r#"{"passMark":3}"#))),
        "academy.assessment_invalid"
    );
    assert_eq!(
        code_of(save(
            &f,
            &draft(&f.quiz, 0, r#"{"ipAllow":["10.0.0.0/33"]}"#)
        )),
        "academy.ip_rule_invalid"
    );
}

#[test]
fn a_published_quiz_with_an_attempt_keeps_its_questions_and_cannot_be_unpublished() {
    let f = fixture!();
    let id = f.quiz.as_str();
    save(&f, &draft(id, 0, "{}")).unwrap();
    publish(&f, id);
    assert_eq!(
        at(
            &quizzes::set_state(&f.store, id, "draft", "TEST", A, now()).unwrap(),
            "state"
        ),
        s("draft")
    );
    publish(&f, id);

    let attempt = start(&f, id, L, None, None).unwrap();
    assert_eq!(at(&attempt, "itemId"), s(id));
    assert_eq!(at(&attempt, "number"), Json::int(1));
    assert_eq!(at(&attempt, "result"), Json::Null);
    assert_eq!(
        at(&quizzes::admin_view(&f.store, id).unwrap(), "attempts"),
        Json::int(1)
    );
    assert_eq!(
        code_of(quizzes::set_state(&f.store, id, "draft", "TEST", A, now())),
        "academy.item_has_attempts"
    );
    let changed = QUESTIONS.replace("TEST What caps the loss on a trade?", "TEST changed");
    assert_eq!(
        code_of(save(
            &f,
            &draft(id, 1, &format!(r#"{{"questions":{changed}}}"#))
        )),
        "academy.item_has_attempts"
    );
    // Rules still change, and a save that would block a published quiz is refused.
    assert_eq!(
        at(
            &save(&f, &draft(id, 1, r#"{"timeLimitSeconds":600}"#)).unwrap(),
            "timeLimitSeconds"
        ),
        Json::int(600)
    );
    assert_eq!(
        code_of(save(&f, &draft(id, 2, r#"{"passMark":null}"#))),
        "academy.pass_mark_unset"
    );
}

#[test]
fn a_learner_reads_the_published_quiz_without_the_key_and_a_draft_or_an_outsider_is_refused() {
    let f = fixture!();
    save(&f, &draft(&f.quiz, 0, r#"{"accessCode":"TEST-CODE-1"}"#)).unwrap();
    assert_eq!(
        code_of(quizzes::learner_view(&f.store, &f.quiz, L, now())),
        "academy.assessment_unpublished"
    );
    publish(&f, &f.quiz);
    let view = quizzes::learner_view(&f.store, &f.quiz, L, now()).unwrap();
    assert_eq!(at(&view, "title"), s("Check yourself"));
    assert_eq!(at(&view, "passMark"), Json::int(1));
    assert_eq!(at(&view, "accessCodeRequired"), Json::Bool(true));
    assert_eq!(at(&view, "attemptsUsed"), Json::int(0));
    assert!(!view.compact().contains("correctChoiceId"));
    assert_eq!(
        code_of(quizzes::learner_view(&f.store, &f.quiz, OUTSIDER, now())),
        "academy.enrolment_required"
    );
    assert_eq!(
        code_of(start(&f, &f.quiz, OUTSIDER, Some("TEST-CODE-1"), None)),
        "academy.enrolment_required"
    );
}

#[test]
fn a_start_checks_the_access_code_then_the_address() {
    let f = fixture!();
    let id = f.quiz.as_str();
    save(
        &f,
        &draft(
            id,
            0,
            r#"{"accessCode":"TEST-CODE-1","ipAllow":["203.0.113.0/24"]}"#,
        ),
    )
    .unwrap();
    let stored = f.db.texts(&format!(
        "SELECT access_code_hash FROM academy.course_quizzes WHERE item_id = '{id}'"
    ));
    let h = &stored[0];
    let parts: Vec<&str> = h.split('$').collect();
    assert_eq!(parts.len(), 3, "{h}");
    assert_eq!(parts[0], "scrypt");
    assert!(
        parts[1].len() == 32
            && parts[1]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    assert!(
        parts[2].len() == 64
            && parts[2]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    assert!(!h.contains("TEST-CODE-1"));
    assert_eq!(
        at(&quizzes::admin_view(&f.store, id).unwrap(), "accessCodeSet"),
        Json::Bool(true)
    );
    publish(&f, id);

    assert_eq!(
        code_of(start(&f, id, L, None, None)),
        "academy.access_code_invalid"
    );
    assert_eq!(
        code_of(start(&f, id, L, Some("wrong-code"), None)),
        "academy.access_code_invalid"
    );
    assert_eq!(
        code_of(start(&f, id, L, Some("TEST-CODE-1"), None)),
        "academy.ip_unreadable"
    );
    assert_eq!(
        code_of(start(&f, id, L, Some("TEST-CODE-1"), Some("198.51.100.9"))),
        "academy.ip_not_allowed"
    );
    assert_eq!(
        at(&quizzes::admin_view(&f.store, id).unwrap(), "attempts"),
        Json::int(0)
    );
    let attempt = start(&f, id, L, Some("TEST-CODE-1"), Some("203.0.113.9")).unwrap();
    assert_eq!(at(&attempt, "number"), Json::int(1));
    // A save that leaves the code out keeps it; null clears it.
    save(&f, &draft(id, 1, r#"{"ipAllow":null}"#)).unwrap();
    assert_eq!(
        at(&quizzes::admin_view(&f.store, id).unwrap(), "accessCodeSet"),
        Json::Bool(true)
    );
    save(&f, &draft(id, 2, r#"{"ipAllow":null,"accessCode":null}"#)).unwrap();
    assert_eq!(
        at(&quizzes::admin_view(&f.store, id).unwrap(), "accessCodeSet"),
        Json::Bool(false)
    );
}

// ── question kinds, essay review, results visibility and surveys (AC-quizzes-02) ───────────────────────────────────

fn take(f: &Fixture, id: &str, user: &str) -> Json {
    let attempt = start(f, id, user, None, None).unwrap();
    let a = at(&attempt, "attemptId");
    let a = a.as_str_opt();
    quizzes::answer(&f.store, a, user, "n1", &s("20.4"), now()).unwrap();
    quizzes::answer(&f.store, a, user, "m1", &jp(r#"["a"]"#), now()).unwrap();
    quizzes::answer(
        &f.store,
        a,
        user,
        "e1",
        &s("TEST Because the stop sets it."),
        now(),
    )
    .unwrap();
    quizzes::finish(&f.store, a, user, now()).unwrap()
}

trait AsStr {
    fn as_str_opt(&self) -> &str;
}

impl AsStr for Json {
    fn as_str_opt(&self) -> &str {
        match self {
            Json::String(s) => s.as_str(),
            other => panic!("not a string: {other:?}"),
        }
    }
}

#[test]
fn an_essay_leaves_the_attempt_pending_until_staff_score_it_under_an_alias() {
    let f = fixture!();
    let id = f.quiz.as_str();
    save(
        &f,
        &draft(id, 0, &format!(r#"{{"questions":{MIXED},"passMark":5}}"#)),
    )
    .unwrap();
    publish(&f, id);
    let view = quizzes::learner_view(&f.store, id, L, now()).unwrap();
    let kinds: Vec<(Json, bool)> = match at(&view, "questions") {
        Json::Array(qs) => qs
            .iter()
            .map(|q| (at(q, "kind"), at(q, "choices") == Json::Null))
            .collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        kinds,
        vec![
            (s("numeric"), true),
            (s("multi"), false),
            (s("essay"), true)
        ]
    );
    let text = view.compact();
    assert!(
        !text.contains("correctChoiceIds")
            && !text.contains("tolerance")
            && !text.contains("\"answer\"")
    );

    let finished = take(&f, id, L);
    assert_eq!(
        at(&finished, "result"),
        jp(&format!(
            r#"{{"state":"pending_review","finishedAt":"{NOW_ISO}"}}"#
        ))
    );
    assert_eq!(
        at(&quizzes::admin_view(&f.store, id).unwrap(), "pendingReview"),
        Json::int(1)
    );
    let reviews = quizzes::reviews(&f.store, id).unwrap();
    let review = at(&reviews, "0");
    assert_eq!(at(&review, "alias"), Json::int(1));
    assert_eq!(at(&review, "autoScore"), Json::int(3));
    assert_eq!(at(&review, "essays.0.questionId"), s("e1"));
    assert_eq!(at(&review, "essays.0.points"), Json::int(4));
    assert_eq!(
        at(&review, "essays.0.text"),
        s("TEST Because the stop sets it.")
    );
    assert!(!review.compact().contains(L));
    let attempt = at(&review, "attemptId");
    let attempt = attempt.as_str_opt();

    let score = |item: &str, points: &str| {
        quizzes::score_essays(&f.store, item, attempt, &jp(points), A, now())
    };
    assert_eq!(
        code_of(score(id, r#"{"e1":5}"#)),
        "academy.assessment_invalid"
    );
    // A missing score, an inherited key and another quiz's id are refused, never read as 0 or scored on the wrong quiz.
    for points in ["{}", r#"{"toString":1}"#, r#"{"e1":3,"other":1}"#] {
        assert_eq!(
            code_of(score(id, points)),
            "academy.assessment_invalid",
            "{points}"
        );
    }
    assert_eq!(
        code_of(score(L, r#"{"e1":3}"#)),
        "academy.attempt_not_found"
    );
    assert_eq!(score(id, r#"{"e1":3}"#).unwrap(), jp("[]"));
    assert_eq!(code_of(score(id, r#"{"e1":3}"#)), "academy.attempt_closed");
    let graded = quizzes::current(&f.store, id, L, now()).unwrap();
    for (k, v) in [
        ("state", s("graded")),
        ("score", Json::int(6)),
        ("maxScore", Json::int(8)),
        ("pass", Json::Bool(true)),
        ("review", Json::Null),
    ] {
        assert_eq!(at(&graded, &format!("result.{k}")), v, "{k}");
    }
    // With the review mode showing answers, each answer comes back against the key with what it earned.
    save(
        &f,
        &draft(
            id,
            1,
            &format!(r#"{{"questions":{MIXED},"passMark":5,"reviewMode":"answers"}}"#),
        ),
    )
    .unwrap();
    let reviewed = quizzes::current(&f.store, id, L, now()).unwrap();
    let expect = [
        ("n1", s("20.4"), s("20"), 2, 2),
        ("m1", jp(r#"["a"]"#), jp(r#"["a","b"]"#), 1, 2),
    ];
    for (i, (q, given, key, earned, points)) in expect.into_iter().enumerate() {
        let r = at(&reviewed, &format!("result.review.{i}"));
        assert_eq!(at(&r, "questionId"), s(q));
        assert_eq!(at(&r, "given"), given);
        assert_eq!(at(&r, "key"), key);
        assert_eq!(at(&r, "earned"), Json::int(earned));
        assert_eq!(at(&r, "points"), Json::int(points));
    }
    let essay = at(&reviewed, "result.review.2");
    assert_eq!(
        (
            at(&essay, "questionId"),
            at(&essay, "key"),
            at(&essay, "earned"),
            at(&essay, "points")
        ),
        (s("e1"), Json::Null, Json::int(3), Json::int(4))
    );
    // The attempt is taken, so the questions stay as they are.
    let two = match jp(MIXED) {
        Json::Array(mut qs) => {
            qs.truncate(2);
            Json::Array(qs).compact()
        }
        _ => unreachable!(),
    };
    assert_eq!(
        code_of(save(
            &f,
            &draft(id, 2, &format!(r#"{{"questions":{two},"passMark":1}}"#))
        )),
        "academy.item_has_attempts"
    );
}

#[test]
fn an_answer_that_does_not_fit_refuses_and_a_finished_attempt_takes_no_more() {
    let f = fixture!();
    let id = f.quiz.as_str();
    save(
        &f,
        &draft(id, 0, &format!(r#"{{"questions":{MIXED},"passMark":1}}"#)),
    )
    .unwrap();
    publish(&f, id);
    let attempt = start(&f, id, L, None, None).unwrap();
    let a = at(&attempt, "attemptId");
    let a = a.as_str_opt();
    for (q, answer) in [
        ("n1", s("twenty")),
        ("m1", s("a")),
        ("m1", jp(r#"["z"]"#)),
        ("zz", s("x")),
    ] {
        assert_eq!(
            code_of(quizzes::answer(&f.store, a, L, q, &answer, now())),
            "academy.assessment_invalid",
            "{q}"
        );
    }
    assert_eq!(
        code_of(quizzes::answer(&f.store, a, OUTSIDER, "n1", &s("1"), now())),
        "academy.attempt_not_found"
    );
    quizzes::finish(&f.store, a, L, now()).unwrap();
    assert_eq!(
        code_of(quizzes::answer(&f.store, a, L, "n1", &s("20"), now())),
        "academy.attempt_closed"
    );
    assert_eq!(
        code_of(start(&f, id, L, None, None)),
        "academy.attempt_limit"
    );
}

#[test]
fn results_show_always_only_after_the_last_attempt_or_never() {
    let f = fixture!();
    let id = f.quiz.as_str();
    let auto = match jp(MIXED) {
        Json::Array(mut qs) => {
            qs.truncate(2);
            Json::Array(qs).compact()
        }
        _ => unreachable!(),
    };
    let rules = |visibility: &str| {
        format!(
            r#"{{"questions":{auto},"passMark":1,"attemptLimit":2,"scoringPolicy":"highest","resultsVisibility":"{visibility}"}}"#
        )
    };
    save(&f, &draft(id, 0, &rules("after_last_attempt"))).unwrap();
    publish(&f, id);
    let first = start(&f, id, L, None, None).unwrap();
    let done = quizzes::finish(&f.store, at(&first, "attemptId").as_str_opt(), L, now()).unwrap();
    assert_eq!(at(&done, "result.state"), s("withheld"));
    let second = start(&f, id, L, None, None).unwrap();
    let done = quizzes::finish(&f.store, at(&second, "attemptId").as_str_opt(), L, now()).unwrap();
    for (k, v) in [
        ("state", s("graded")),
        ("score", Json::int(0)),
        ("maxScore", Json::int(4)),
        ("pass", Json::Bool(false)),
    ] {
        assert_eq!(at(&done, &format!("result.{k}")), v, "{k}");
    }
    save(&f, &draft(id, 1, &rules("never"))).unwrap();
    assert_eq!(
        at(
            &quizzes::current(&f.store, id, L, now()).unwrap(),
            "result.state"
        ),
        s("withheld")
    );
}

#[test]
fn a_timed_attempt_past_its_deadline_is_finished_with_what_was_saved_by_then() {
    let f = fixture!();
    let id = f.quiz.as_str();
    let one = match jp(MIXED) {
        Json::Array(mut qs) => {
            qs.truncate(1);
            Json::Array(qs).compact()
        }
        _ => unreachable!(),
    };
    save(
        &f,
        &draft(
            id,
            0,
            &format!(r#"{{"questions":{one},"passMark":1,"timeLimitSeconds":60}}"#),
        ),
    )
    .unwrap();
    publish(&f, id);
    let attempt = start(&f, id, L, None, None).unwrap();
    assert_eq!(at(&attempt, "secondsLeft"), Json::int(60));
    let a = at(&attempt, "attemptId");
    let a = a.as_str_opt();
    quizzes::answer(&f.store, a, L, "n1", &s("20"), now()).unwrap();
    let later = now() + 61_000;
    assert_eq!(
        code_of(quizzes::answer(&f.store, a, L, "n1", &s("0"), later)),
        "academy.attempt_closed"
    );
    let current = quizzes::current(&f.store, id, L, later).unwrap();
    assert_eq!(at(&current, "result.state"), s("graded"));
    assert_eq!(at(&current, "result.score"), Json::int(2));
    assert_eq!(
        at(&current, "result.finishedAt"),
        s(&service_kit::time::Instant(now() + 60_000).iso())
    );
}

#[test]
fn an_anonymous_survey_keeps_no_account_and_one_learner_answers_once() {
    let f = fixture!();
    let id = f.quiz.as_str();
    let survey = r#""kind":"survey","anonymous":true,"passMark":null,"attemptLimit":null,
        "questions":[{"kind":"essay","id":"s1","prompt":"TEST What would you change?","points":1}]"#;
    assert_eq!(
        code_of(save(
            &f,
            &draft(
                id,
                0,
                &format!(r#"{{{survey},"accessCode":"TEST-CODE-1"}}"#)
            )
        )),
        "academy.assessment_invalid"
    );
    let saved = save(&f, &draft(id, 0, &format!("{{{survey}}}"))).unwrap();
    assert_eq!(at(&saved, "blockers"), jp("[]"));
    publish(&f, id);
    let view = quizzes::learner_view(&f.store, id, L, now()).unwrap();
    assert_eq!(
        (
            at(&view, "kind"),
            at(&view, "anonymous"),
            at(&view, "passMark")
        ),
        (s("survey"), Json::Bool(true), Json::Null)
    );
    assert_eq!(
        code_of(start(&f, id, L, None, None)),
        "academy.quiz_not_found"
    );

    let token = "TEST-device-token-0001";
    let later = now() + 25 * 60_000;
    let sent = quizzes::submit_survey(
        &f.store,
        id,
        L,
        token,
        &jp(r#"{"s1":"TEST More charts"}"#),
        later,
    )
    .unwrap();
    assert_eq!(
        sent,
        jp(&format!(
            r#"{{"itemId":"{id}","anonymous":true,"submittedAt":"{}"}}"#,
            service_kit::time::Instant(later).iso()
        ))
    );
    assert_eq!(
        at(
            &quizzes::learner_view(&f.store, id, L, now()).unwrap(),
            "responded"
        ),
        Json::Bool(true)
    );
    // Once per learner, whatever token the device sends.
    for t in [token, "TEST-device-token-0002"] {
        assert_eq!(
            code_of(quizzes::submit_survey(
                &f.store,
                id,
                L,
                t,
                &jp(r#"{"s1":"TEST again"}"#),
                now()
            )),
            "academy.survey_duplicate"
        );
    }
    let mut c = f.db.client();
    let rows = c.query("SELECT user_id::text, to_jsonb(r)::text AS row, submitted_at FROM academy.course_survey_responses r WHERE item_id = $1::text::uuid", &[&id]).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, Option<String>>(0), None);
    // The answers carry no instant finer than the hour, so they cannot be matched to who answered by time.
    let submitted: String = c
        .query_one("SELECT to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM academy.course_survey_responses WHERE item_id = $1::text::uuid", &[&id])
        .unwrap()
        .get(0);
    assert_eq!(submitted, "2026-10-23T12:00:00.000Z");
    let columns = f.db.texts(
        "SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'academy' AND table_name = 'course_survey_takers' ORDER BY column_name",
    );
    assert_eq!(columns, ["item_id", "user_id"]);
    // Written apart: the answers and the record of who answered share no transaction id to join them by.
    let xids = c
        .query_one(
            "SELECT (SELECT xmin::text FROM academy.course_survey_responses WHERE item_id = $1::text::uuid) AS r, \
                    (SELECT xmin::text FROM academy.course_survey_takers WHERE item_id = $1::text::uuid) AS t",
            &[&id],
        )
        .unwrap();
    assert_ne!(xids.get::<_, String>(0), xids.get::<_, String>(1));
    let row: String = rows[0].get(1);
    assert!(!row.contains(L));
    assert!(!row.contains(token));
    assert_eq!(
        at(&quizzes::admin_view(&f.store, id).unwrap(), "responses"),
        Json::int(1)
    );
    assert_eq!(
        code_of(quizzes::set_state(&f.store, id, "draft", "TEST", A, now())),
        "academy.item_has_attempts"
    );
}

#[test]
fn a_named_survey_keeps_the_account_once() {
    let f = fixture!();
    let id = f.quiz.as_str();
    let survey = r#"{"kind":"survey","passMark":null,"questions":[{"kind":"essay","id":"s1","prompt":"TEST Thoughts?","points":1}]}"#;
    save(&f, &draft(id, 0, survey)).unwrap();
    publish(&f, id);
    quizzes::submit_survey(
        &f.store,
        id,
        L,
        "TEST-device-token-0001",
        &jp(r#"{"s1":"x"}"#),
        now(),
    )
    .unwrap();
    assert_eq!(
        code_of(quizzes::submit_survey(
            &f.store,
            id,
            L,
            "TEST-device-token-0002",
            &jp(r#"{"s1":"y"}"#),
            now()
        )),
        "academy.survey_duplicate"
    );
    assert_eq!(
        f.db.texts("SELECT user_id::text FROM academy.course_survey_responses"),
        [L]
    );
}

// ── access codes and addresses (AC-quizzes-01) ─────────────────────────────────────────────────────────────────────

#[test]
fn a_code_matches_only_its_own_hash_and_two_hashes_of_one_code_differ() {
    let one = hash_access_code("TEST-CODE-1", &random_salt());
    assert!(access_code_matches("TEST-CODE-1", &one));
    assert!(!access_code_matches("TEST-CODE-2", &one));
    assert_ne!(hash_access_code("TEST-CODE-1", &random_salt()), one);
    assert!(!access_code_matches("TEST-CODE-1", "plain"));
}

#[test]
fn addresses_match_single_entries_and_ranges_ipv4_and_ipv6() {
    let rules = |r: &[&str]| r.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert!(address_allowed("203.0.113.7", &rules(&["203.0.113.7"])));
    assert!(!address_allowed("203.0.113.8", &rules(&["203.0.113.7"])));
    assert!(address_allowed("2001:db8::1", &rules(&["2001:db8::/32"])));
    assert!(!address_allowed("not-an-ip", &rules(&["0.0.0.0/0"])));
    assert!(address_allowed(
        "::ffff:203.0.113.7",
        &rules(&["203.0.113.0/24"])
    ));
}

#[test]
fn the_caller_address_is_believed_only_from_a_trusted_proxy_that_names_it() {
    assert_eq!(
        resolve_address(
            &proxy_rules("").unwrap(),
            Some("127.0.0.1"),
            Some("203.0.113.7")
        ),
        None
    );
    let rules = proxy_rules("127.0.0.0/8, 10.0.0.0/8").unwrap();
    let resolve = |peer: &str, header: Option<&str>| resolve_address(&rules, Some(peer), header);
    assert_eq!(
        resolve("127.0.0.1", Some("203.0.113.7")).as_deref(),
        Some("203.0.113.7")
    );
    assert_eq!(
        resolve("::ffff:127.0.0.1", Some("203.0.113.7")).as_deref(),
        Some("203.0.113.7")
    );
    assert_eq!(resolve("192.0.2.1", Some("203.0.113.7")), None);
    assert_eq!(resolve("127.0.0.1", None), None);
    assert_eq!(resolve("127.0.0.1", Some("garbage")), None);
    assert_eq!(
        resolve("127.0.0.1", Some("::ffff:203.0.113.7")).as_deref(),
        Some("203.0.113.7")
    );
    assert!(
        proxy_rules("127.0.0.1")
            .unwrap_err()
            .contains("not a CIDR range")
    );
}
