//! `curriculum/course-release.db.test.ts` (AC-release-access-01) against a real Postgres: pacing set with who and why
//! and locked once a learner enrols, a section released days after enrolment or at an instant, cleared, and refused
//! for another course's section; and `opensAt`.
//!
//! What a learner meets is read here through `release::assert_item_open`, the gate the quiz's learner view
//! (`CourseQuizzes.learnerView`, the assessment slice's) runs first. The rows the other slices' calls leave are written
//! as they leave them: the quiz saved and published (`course_quizzes`), the enrolment (`course_enrolments`) and a begun
//! attempt (`course_quiz_attempts`). The learner preview's section and lock fields (`CoursePreview.view`) belong to the
//! learner slice and are not asserted here; the same instants are asserted on the rule (`Rule::opens_at`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod authoring_kit;

use authoring_kit::{TestDb, at, at_path, code, equals, iso, matches, s, store, v};
use service_kit::json::Json;
use svc_academy::authoring::courses::{CourseRecords, Limits};
use svc_academy::authoring::release::{self, Rule};
use svc_academy::authoring::sql;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const DAY: i64 = 86_400_000;

fn now() -> i64 {
    svc_academy::door::system_now().0
}

fn courses() -> CourseRecords {
    CourseRecords { limits: Limits { max_sections: Some(5), max_items: Some(5) } }
}

struct Course {
    id: String,
    sections: Vec<String>,
    quiz: String,
}

/// A published free course: an opening section with a link, and a second section with a link and a published quiz.
fn course(db: &TestDb, st: &Store, t: i64) -> Course {
    let c = courses();
    let created = c
        .create(
            st,
            &v(r#"{"slug":"risk-basics","title":"Risk basics","summary":null,"thumbnailUrl":null,"pricing":"free","price":null,"priceAsset":null}"#),
            A,
            t,
        )
        .unwrap();
    let id = s(&created, "id");
    let detail = c
        .save_outline(
            st,
            &v(&format!(
                r#"{{"courseId":"{id}","revision":1,"sections":[
                {{"title":"Start here","items":[{{"kind":"link","title":"Reading","indent":0,"url":"https://example.com/read"}}]}},
                {{"title":"Week two","items":[{{"kind":"link","title":"Notes","indent":0,"url":"https://example.com/notes"}},
                  {{"kind":"quiz","title":"Check yourself","indent":0,"url":null}}]}}]}}"#
            )),
            A,
            t,
        )
        .unwrap();
    let quiz = s(&detail, "outline.1.items.1.id");
    // `quizzes().save(...)` then `setState(published)`: the row the assessment slice leaves.
    db.client()
        .execute(
            "INSERT INTO academy.course_quizzes (item_id, revision, state, questions, pass_mark, attempt_limit, review_mode, saved_by, saved_at, published_at, kind) \
             VALUES ($1::text::uuid, 1, 'published', '[]'::jsonb, 1, 1, 'score_only', $2::text::uuid, $3::text::timestamptz, $3::text::timestamptz, 'quiz')",
            &[&quiz, &A, &iso(t)],
        )
        .unwrap();
    let revision = authoring_kit::n(&c.get(st, &id).unwrap(), "course.revision");
    c.set_state(st, &v(&format!(r#"{{"courseId":"{id}","to":"published","revision":{revision},"reason":"TEST"}}"#)), A, t).unwrap();
    Course {
        id,
        sections: vec![s(&detail, "outline.0.id"), s(&detail, "outline.1.id")],
        quiz,
    }
}

fn enrol(db: &TestDb, course_id: &str, user: &str, t: i64) {
    db.client()
        .execute(
            "INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at) VALUES ($1::text::uuid, $2::text::uuid, 'audit', $3::text::timestamptz)",
            &[&course_id, &user, &iso(t)],
        )
        .unwrap();
}

/// The gate a learner's quiz view runs first.
fn quiz_open(st: &Store, item: &str, user: &str, t: i64) -> Result<(), Refusal> {
    sql::client(st, |c| release::assert_item_open(c, item, user, t))
}

fn pacing(st: &Store, course_id: &str, pace: &str, reason: &str, t: i64) -> Result<Json, Refusal> {
    release::set_pacing(st, &v(&format!(r#"{{"courseId":"{course_id}","pacing":"{pace}","reason":"{reason}"}}"#)), A, t)
}

fn section(st: &Store, course_id: &str, section_id: &str, rule: &str, reason: &str, t: i64) -> Result<Json, Refusal> {
    release::set_section_release(
        st,
        &v(&format!(r#"{{"courseId":"{course_id}","sectionId":"{section_id}","rule":{rule},"reason":"{reason}"}}"#)),
        A,
        t,
    )
}

// ── pacing (AC-release-access-01) ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn pacing_is_unset_at_first_set_with_who_and_why_before_anyone_enrols_and_refuses_a_change_once_a_learner_has() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let c = course(&db, &st, t);
    matches(&release::course_release(&st, &c.id).unwrap(), r#"{"pacing":null,"pacingLocked":false}"#);
    pacing(&st, &c.id, "instructor_paced", "TEST cohort", t).unwrap();
    pacing(&st, &c.id, "self_paced", "TEST own pace", t + 1).unwrap();
    enrol(&db, &c.id, L, t);
    matches(
        &release::course_release(&st, &c.id).unwrap(),
        &format!(r#"{{"pacing":"self_paced","pacingLocked":true,"pacingSetBy":"{A}"}}"#),
    );
    assert_eq!(code(pacing(&st, &c.id, "instructor_paced", "TEST late", t)), "academy.pacing_locked");
    // The same pacing again answers as stored.
    matches(&pacing(&st, &c.id, "self_paced", "TEST", t).unwrap(), r#"{"pacing":"self_paced"}"#);
    assert_eq!(
        db.texts(&format!("SELECT reason FROM academy.course_release_events WHERE course_id = '{}' ORDER BY at, reason", c.id)),
        ["TEST cohort", "TEST own pace"]
    );
}

#[test]
fn pacing_refuses_a_course_that_does_not_exist() {
    let Some((_db, st)) = store() else { return };
    assert_eq!(code(pacing(&st, "77777777-7777-4777-8777-777777777777", "self_paced", "TEST", now())), "academy.course_not_found");
}

// ── a section released after enrolment (AC-release-access-01) ───────────────────────────────────────────────────────

#[test]
fn stays_scheduled_for_7_days_after_enrolling_and_its_quiz_refuses_until_then() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let c = course(&db, &st, t);
    let view = section(&st, &c.id, &c.sections[1], r#"{"kind":"after_enrolment","days":7}"#, "TEST drip", t).unwrap();
    matches(
        at_path(&view, "sections.1"),
        &format!(r#"{{"rule":{{"kind":"after_enrolment","days":7}},"setBy":"{A}","reason":"TEST drip"}}"#),
    );
    equals(at_path(&view, "sections.0.rule"), "null");
    // Not enrolled: no instant to count from.
    assert_eq!(Rule::AfterEnrolment(7).opens_at(None), None);
    assert_eq!(code(quiz_open(&st, &c.quiz, L, t)), "academy.not_released_yet");

    let enrolled_at = t - 2 * DAY;
    enrol(&db, &c.id, L, enrolled_at);
    assert_eq!(Rule::AfterEnrolment(7).opens_at(Some(enrolled_at)), Some(enrolled_at + 7 * DAY));
    assert_eq!(code(quiz_open(&st, &c.quiz, L, t)), "academy.not_released_yet");
    // Day 8: open.
    quiz_open(&st, &c.quiz, L, enrolled_at + 8 * DAY).unwrap();
}

#[test]
fn opens_the_quiz_once_the_days_have_passed_since_enrolling() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let c = course(&db, &st, t);
    section(&st, &c.id, &c.sections[1], r#"{"kind":"after_enrolment","days":7}"#, "TEST drip", t).unwrap();
    enrol(&db, &c.id, L, t - 8 * DAY);
    quiz_open(&st, &c.quiz, L, t).unwrap();
}

#[test]
fn keeps_work_a_learner_already_began_readable_when_staff_move_the_section_later() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let c = course(&db, &st, t);
    enrol(&db, &c.id, L, t);
    // `quizzes().start(...)`: the attempt row the assessment slice leaves.
    db.client()
        .execute(
            "INSERT INTO academy.course_quiz_attempts (item_id, user_id, number, started_at, quiz, state) \
             VALUES ($1::text::uuid, $2::text::uuid, 1, $3::text::timestamptz, '{}'::jsonb, 'open')",
            &[&c.quiz, &L, &iso(t)],
        )
        .unwrap();
    section(&st, &c.id, &c.sections[1], r#"{"kind":"after_enrolment","days":7}"#, "TEST moved later", t).unwrap();
    quiz_open(&st, &c.quiz, L, t).unwrap();
    // Another learner who has not begun is refused.
    let other = "88888888-8888-4888-8888-888888888888";
    enrol(&db, &c.id, other, t);
    assert_eq!(code(quiz_open(&st, &c.quiz, other, t)), "academy.not_released_yet");
}

// ── a section released at an instant (AC-release-access-01) ─────────────────────────────────────────────────────────

#[test]
fn shows_the_same_instant_to_every_reader_opens_when_it_passes_and_clearing_the_rule_opens_it_at_once() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let c = course(&db, &st, t);
    let when = t + 3 * DAY;
    let offset = iso(when).replace('Z', "+00:00");
    section(&st, &c.id, &c.sections[1], &format!(r#"{{"kind":"at","at":"{offset}"}}"#), "TEST launch day", t).unwrap();
    // A repeat in another spelling of the same instant writes nothing.
    let again = section(&st, &c.id, &c.sections[1], &format!(r#"{{"kind":"at","at":"{}"}}"#, iso(when)), "TEST again", t).unwrap();
    equals(at_path(&again, "sections.1.rule"), &format!(r#"{{"kind":"at","at":"{}"}}"#, iso(when)));
    assert_eq!(Rule::At(when).opens_at(None), Some(when));
    enrol(&db, &c.id, L, t);
    assert_eq!(code(quiz_open(&st, &c.quiz, L, t)), "academy.not_released_yet");
    quiz_open(&st, &c.quiz, L, when + 1).unwrap();

    let cleared = section(&st, &c.id, &c.sections[1], "null", "TEST open now", t).unwrap();
    equals(at_path(&cleared, "sections.1.rule"), "null");
    quiz_open(&st, &c.quiz, L, t).unwrap();
    let mut reasons = db.texts(&format!(
        "SELECT reason FROM academy.course_release_events WHERE section_id = '{}' ORDER BY at, reason",
        c.sections[1]
    ));
    reasons.sort();
    assert_eq!(reasons, ["TEST launch day", "TEST open now"]);
}

#[test]
fn refuses_a_section_of_another_course() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let c = course(&db, &st, t);
    assert_eq!(
        code(section(&st, &c.id, "77777777-7777-4777-8777-777777777777", r#"{"kind":"after_enrolment","days":1}"#, "TEST", t)),
        "academy.outline_item_unknown"
    );
}

// ── opensAt ─────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn counts_whole_days_from_enrolment_and_has_no_instant_without_one() {
    assert_eq!(iso(Rule::AfterEnrolment(7).opens_at(Some(at("2026-10-01T10:00:00Z"))).unwrap()), "2026-10-08T10:00:00.000Z");
    assert_eq!(Rule::AfterEnrolment(7).opens_at(None), None);
    assert_eq!(iso(Rule::At(at("2026-11-01T09:00:00+02:00")).opens_at(None).unwrap()), "2026-11-01T07:00:00.000Z");
}
