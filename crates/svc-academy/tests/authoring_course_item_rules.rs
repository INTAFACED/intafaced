//! `curriculum/course-item-rules.db.test.ts` (AC-release-access-02) against a real Postgres: `dueFor`, and
//! prerequisites between a course's assignments and quizzes, saved with who and why, refused as a cycle with nothing
//! written, refused for an item that records no completion, and enforced on the learner's quiz until the required
//! assignment is handed in.
//!
//! The quiz's learner view is read through its first gate, `release::assert_item_open`. The rows the assessment and
//! learner slices' calls leave are written as they leave them: the assignment brief (`course_assignments`), the quiz
//! (`course_quizzes`), the enrolment and the hand-in (`assignment_submissions`). The second describe, "a learner's own
//! due date", tests `grantExtension` and the assignment hand-in, which are the assessment slice's calls; it is ported
//! with that slice.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::authoring_kit;

use authoring_kit::{TestDb, at, code, equals, iso, matches, message, s, store, v};
use service_kit::json::Json;
use svc_academy::authoring::courses::{CourseRecords, Limits};
use svc_academy::authoring::{item_rules, release, sql};
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const UNKNOWN: &str = "77777777-7777-4777-8777-777777777777";
const DAY: i64 = 86_400_000;

fn now() -> i64 {
    svc_academy::door::system_now().0
}

struct Course {
    id: String,
    work: String,
    quiz: String,
    lesson: String,
}

/// A published free course: an assignment (due yesterday), a published quiz and a lesson, with learner L enrolled.
fn course(db: &TestDb, st: &Store, t: i64) -> Course {
    let c = CourseRecords {
        limits: Limits {
            max_sections: Some(5),
            max_items: Some(5),
        },
    };
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
                r#"{{"courseId":"{id}","revision":1,"sections":[{{"title":"Week one","items":[
                {{"kind":"assignment","title":"Size write-up","indent":0,"url":null}},
                {{"kind":"quiz","title":"Check yourself","indent":0,"url":null}},
                {{"kind":"lesson","title":"Read me","indent":0,"url":null}}]}}]}}"#
            )),
            A,
            t,
        )
        .unwrap();
    let (work, quiz, lesson) = (
        s(&detail, "outline.0.items.0.id"),
        s(&detail, "outline.0.items.1.id"),
        s(&detail, "outline.0.items.2.id"),
    );
    let mut client = db.client();
    client
        .execute(
            "INSERT INTO academy.course_assignments (item_id, revision, instructions, points, due_at, text_mode, file_mode, saved_by, saved_at) \
             VALUES ($1::text::uuid, 1, 'Size one trade.', 10, $2::text::timestamptz, 'required', 'off', $3::text::uuid, $4::text::timestamptz)",
            &[&work, &iso(t - DAY), &A, &iso(t)],
        )
        .unwrap();
    client
        .execute(
            "INSERT INTO academy.course_quizzes (item_id, revision, state, questions, pass_mark, attempt_limit, review_mode, saved_by, saved_at, published_at, kind) \
             VALUES ($1::text::uuid, 1, 'published', '[]'::jsonb, 1, 1, 'score_only', $2::text::uuid, $3::text::timestamptz, $3::text::timestamptz, 'quiz')",
            &[&quiz, &A, &iso(t)],
        )
        .unwrap();
    let revision = authoring_kit::n(&c.get(st, &id).unwrap(), "course.revision");
    c.set_state(
        st,
        &v(&format!(
            r#"{{"courseId":"{id}","to":"published","revision":{revision},"reason":"TEST"}}"#
        )),
        A,
        t,
    )
    .unwrap();
    client
        .execute(
            "INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at) VALUES ($1::text::uuid, $2::text::uuid, 'audit', $3::text::timestamptz)",
            &[&id, &L, &iso(t)],
        )
        .unwrap();
    Course {
        id,
        work,
        quiz,
        lesson,
    }
}

fn set(
    st: &Store,
    course_id: &str,
    item: &str,
    prerequisites: &[&str],
    reason: &str,
) -> Result<Json, Refusal> {
    let ids = Json::Array(prerequisites.iter().map(|p| Json::str(*p)).collect()).compact();
    item_rules::set_prerequisites(
        st,
        &v(&format!(
            r#"{{"courseId":"{course_id}","itemId":"{item}","prerequisiteIds":{ids},"reason":"{reason}"}}"#
        )),
        A,
        now(),
    )
}

fn item<'a>(view: &'a Json, id: &str) -> &'a Json {
    match view.get("items").unwrap() {
        Json::Array(items) => items.iter().find(|i| s(i, "itemId") == id).unwrap(),
        _ => panic!(),
    }
}

fn events(db: &TestDb) -> Vec<String> {
    db.texts(
        "SELECT kind || '|' || reason FROM academy.course_item_rule_events ORDER BY at, reason",
    )
}

#[test]
fn due_for_takes_the_learners_own_date_only_while_it_is_later_than_the_briefs() {
    let brief = at("2026-11-01T00:00:00Z");
    assert_eq!(
        iso(item_rules::due_for(Some(brief), Some(at("2026-11-03T00:00:00Z"))).unwrap()),
        "2026-11-03T00:00:00.000Z"
    );
    assert_eq!(
        iso(item_rules::due_for(
            Some(at("2026-11-10T00:00:00Z")),
            Some(at("2026-11-03T00:00:00Z"))
        )
        .unwrap()),
        "2026-11-10T00:00:00.000Z"
    );
    assert_eq!(
        item_rules::due_for(None, Some(at("2026-11-03T00:00:00Z"))),
        None
    );
    assert_eq!(item_rules::due_for(Some(brief), None), Some(brief));
}

#[test]
fn b_requiring_a_saves_with_who_and_why_a_requiring_b_then_refuses_as_a_cycle_and_nothing_is_written()
 {
    let Some((db, st)) = store() else { return };
    let c = course(&db, &st, now());
    let view = set(&st, &c.id, &c.quiz, &[&c.work], "TEST order").unwrap();
    matches(
        item(&view, &c.quiz),
        &format!(
            r#"{{"prerequisites":["{}"],"setBy":"{A}","reason":"TEST order"}}"#,
            c.work
        ),
    );
    let loop_ = set(&st, &c.id, &c.work, &[&c.quiz], "TEST loop");
    assert!(
        message(set(&st, &c.id, &c.work, &[&c.quiz], "TEST loop"))
            .contains(&format!("{}>{}>{}", c.work, c.quiz, c.work))
    );
    assert_eq!(code(loop_), "academy.prerequisite_cycle");
    assert_eq!(
        code(set(&st, &c.id, &c.work, &[&c.work], "TEST order")),
        "academy.prerequisite_cycle"
    );
    equals(
        item(&item_rules::admin_view(&st, &c.id).unwrap(), &c.work)
            .get("prerequisites")
            .unwrap(),
        "[]",
    );
    // The same set again writes nothing.
    set(&st, &c.id, &c.quiz, &[&c.work], "TEST again").unwrap();
    assert_eq!(events(&db), ["prerequisites|TEST order"]);
}

#[test]
fn refuses_a_lesson_as_a_prerequisite_an_item_of_another_course_and_a_lesson_as_the_gated_item() {
    let Some((db, st)) = store() else { return };
    let c = course(&db, &st, now());
    assert_eq!(
        code(set(&st, &c.id, &c.quiz, &[&c.lesson], "TEST order")),
        "academy.prerequisite_unmeasured"
    );
    assert_eq!(
        code(set(&st, &c.id, &c.quiz, &[UNKNOWN], "TEST order")),
        "academy.outline_item_unknown"
    );
    assert_eq!(
        code(set(&st, &c.id, &c.lesson, &[], "TEST order")),
        "academy.outline_item_unknown"
    );
}

#[test]
fn keeps_the_quiz_closed_to_the_learner_until_the_assignment_it_requires_is_handed_in() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let c = course(&db, &st, t);
    set(&st, &c.id, &c.quiz, &[&c.work], "TEST order").unwrap();
    let gate = || sql::client(&st, |cl| release::assert_item_open(cl, &c.quiz, L, now()));
    assert_eq!(code(gate()), "academy.prerequisite_unmet");
    assert!(message(gate()).contains(&c.work));
    // `assignments().submit(...)`: the hand-in row the assessment slice leaves.
    db.client()
        .execute(
            "INSERT INTO academy.assignment_submissions (item_id, user_id, version, state, text, submitted_at) \
             VALUES ($1::text::uuid, $2::text::uuid, 1, 'submitted', 'TEST working', $3::text::timestamptz)",
            &[&c.work, &L, &iso(t)],
        )
        .unwrap();
    gate().unwrap();
    // Clearing the set is a change of its own.
    let cleared = set(&st, &c.id, &c.quiz, &[], "TEST open").unwrap();
    equals(item(&cleared, &c.quiz).get("prerequisites").unwrap(), "[]");
}
