//! When a learner's quiz or assignment opens, and a learner's own due date, against a real Postgres: the parts of
//! `curriculum/course-item-rules.db.test.ts` and `curriculum/course-release.db.test.ts` (AC-release-access-01, -02) that
//! this slice answers, assertion for assertion: `dueFor`, the quiz closed by a prerequisite or a release rule
//! (`assertItemOpen`), and `grantExtension`.
//!
//! Setting prerequisites, a section's release rule and the pacing are the authoring slice's calls (`setPrerequisites`,
//! `setSectionRelease`, `setPacing`), as are the outline and the course preview; their tests stay with that slice. Here
//! the rows they leave are written directly.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use service_kit::time::Instant;
use support::{MemoryObjects, TestDb, at, code_of, enrol, jp, seed_course, test_storage};
use svc_academy::assessment::assignments::{self, BriefInput, Files};
use svc_academy::assessment::{due_for, extensions, quizzes};
use svc_academy::db::Store;
use svc_academy::door::system_now;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const OUTSIDER: &str = "66666666-6666-4666-8666-666666666666";
const OTHER: &str = "88888888-8888-4888-8888-888888888888";
const DAY: i64 = 86_400_000;

fn t(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

fn iso(ms: i64) -> String {
    Instant(ms).iso()
}

fn s(v: &str) -> Json {
    Json::str(v)
}

// ── dueFor ──────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn due_for_takes_the_learners_own_date_only_while_it_is_later_than_the_briefs() {
    let brief = t("2026-11-01T00:00:00Z");
    assert_eq!(
        due_for(Some(brief), Some(t("2026-11-03T00:00:00Z")))
            .map(iso)
            .as_deref(),
        Some("2026-11-03T00:00:00.000Z")
    );
    assert_eq!(
        due_for(
            Some(t("2026-11-10T00:00:00Z")),
            Some(t("2026-11-03T00:00:00Z"))
        )
        .map(iso)
        .as_deref(),
        Some("2026-11-10T00:00:00.000Z")
    );
    assert_eq!(due_for(None, Some(t("2026-11-03T00:00:00Z"))), None);
    assert_eq!(due_for(Some(brief), None), Some(brief));
}

// ── the course of course-item-rules.db.test.ts ──────────────────────────────────────────────────────────────────────

struct Course {
    db: TestDb,
    store: Store,
    objects: MemoryObjects,
    now: i64,
    id: String,
    section: String,
    work: String,
    quiz: String,
}

fn quiz_input(item: &str) -> Json {
    jp(&format!(
        r#"{{"itemId":"{item}","revision":0,"passMark":1,"attemptLimit":1,"scoringPolicy":null,"timeLimitSeconds":null,
            "reviewMode":"score_only","ipAllow":null,"kind":"quiz","anonymous":false,"resultsVisibility":"always",
            "questions":[{{"kind":"single","id":"q1","prompt":"TEST What caps the loss?","points":1,
              "choices":[{{"id":"a","text":"A stop"}},{{"id":"b","text":"Hope"}}],"correctChoiceId":"a"}}]}}"#
    ))
}

impl Course {
    fn files(&self) -> Files<'_> {
        Files {
            storage: Some(test_storage()),
            max_bytes: Some(1024),
            types: Some(vec!["application/pdf".to_owned()]),
            bytes: &self.objects,
        }
    }

    fn learner_view(&self, user: &str) -> Result<Json, Refusal> {
        quizzes::learner_view(&self.store, &self.quiz, user, self.now)
    }

    fn rule_events(&self) -> Vec<(String, String)> {
        self.db
            .client()
            .query(
                "SELECT kind, reason FROM academy.course_item_rule_events ORDER BY at, reason",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }

    /// `CourseRelease.setSectionRelease`'s row.
    fn release(&self, release_at: Option<i64>, after_days: Option<i32>, reason: &str) {
        self.db
            .client()
            .execute(
                "INSERT INTO academy.course_section_releases (section_id, release_at, after_days, reason, set_by, set_at) \
                 VALUES ($1::text::uuid, $2::text::timestamptz, $3, $4, $5::text::uuid, $6::text::timestamptz) \
                 ON CONFLICT (section_id) DO UPDATE SET release_at = EXCLUDED.release_at, after_days = EXCLUDED.after_days, reason = EXCLUDED.reason",
                &[&self.section, &release_at.map(iso), &after_days, &reason, &A, &iso(self.now)],
            )
            .unwrap();
    }

    fn clear_release(&self) {
        self.db
            .client()
            .execute(
                "DELETE FROM academy.course_section_releases WHERE section_id = $1::text::uuid",
                &[&self.section],
            )
            .unwrap();
    }
}

/// A published free course: an assignment (due yesterday), a published quiz and a lesson; L enrolled when asked, at
/// `enrolled`.
fn course(enrolled: Option<i64>) -> Option<Course> {
    let db = TestDb::migrated()?;
    // `new Date()`: the learner's item guard reads the clock, so the times are relative to it.
    let now = system_now().0;
    let mut c = db.client();
    let seeded = seed_course(
        &mut c,
        "risk-basics",
        "draft",
        A,
        &iso(now),
        &[
            ("assignment", "Size write-up"),
            ("quiz", "Check yourself"),
            ("lesson", "Read me"),
        ],
    );
    let store = Store::Pool(db.pool());
    let (work, quiz) = (seeded.items[0].clone(), seeded.items[1].clone());
    let due = iso(now - DAY);
    let brief = BriefInput {
        instructions: "Size one trade.",
        points: "10",
        due_at: Some(&due),
        text: "required",
        file: "off",
    };
    assignments::save(&store, &work, 0, &brief, A, now).unwrap();
    quizzes::save(&store, &quiz_input(&quiz), A, now).unwrap();
    quizzes::set_state(&store, &quiz, "published", "TEST", A, now).unwrap();
    c.execute(
        "UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid",
        &[&seeded.id],
    )
    .unwrap();
    if let Some(at_ms) = enrolled {
        enrol(&mut c, &seeded.id, L, &iso(at_ms));
    }
    Some(Course {
        db,
        store,
        objects: MemoryObjects::new(),
        now,
        id: seeded.id,
        section: seeded.section,
        work,
        quiz,
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

fn now_ms() -> i64 {
    system_now().0
}

// ── prerequisites (AC-release-access-02) ────────────────────────────────────────────────────────────────────────────

#[test]
fn the_quiz_stays_closed_to_the_learner_until_the_assignment_it_requires_is_handed_in() {
    let c = need!(course(Some(now_ms())));
    // `setPrerequisites(quiz, [work])`'s row.
    c.db.client()
        .execute(
            "INSERT INTO academy.course_item_prerequisites (item_id, prerequisite_id) VALUES ($1::text::uuid, $2::text::uuid)",
            &[&c.quiz, &c.work],
        )
        .unwrap();
    match c.learner_view(L) {
        Err(Refusal::Academy(e)) => {
            assert_eq!(e.code, "academy.prerequisite_unmet");
            assert!(e.message.contains(&c.work), "{}", e.message);
        }
        other => panic!("{other:?}"),
    }
    assignments::submit(
        &c.store,
        &c.files(),
        &c.work,
        1,
        Some("TEST working"),
        None,
        L,
        c.now,
    )
    .unwrap();
    assert_eq!(at(&c.learner_view(L).unwrap(), "itemId"), s(&c.quiz));
}

// ── a learner's own due date (AC-release-access-02) ─────────────────────────────────────────────────────────────────

fn grant(c: &Course, item: &str, user: &str, due: i64) -> Result<Json, Refusal> {
    extensions::grant_course_extension(&c.store, &c.id, item, user, due, "TEST illness", A, c.now)
}

#[test]
fn a_learners_own_due_date_shows_who_granted_it_and_a_hand_in_before_it_is_not_late() {
    let c = need!(course(Some(now_ms())));
    let until = c.now + 3 * DAY;
    let view = grant(&c, &c.work, L, until).unwrap();
    assert_eq!(
        at(&view, "extensions"),
        jp(&format!(
            r#"[{{"itemId":"{}","userId":"{L}","dueAt":"{}","reason":"TEST illness","grantedBy":"{A}","grantedAt":"{}"}}]"#,
            c.work,
            iso(until),
            iso(c.now)
        ))
    );
    let handed = assignments::submit(
        &c.store,
        &c.files(),
        &c.work,
        1,
        Some("TEST late but excused"),
        None,
        L,
        c.now,
    )
    .unwrap();
    assert_eq!(
        at(&handed, "extension"),
        jp(&format!(
            r#"{{"dueAt":"{}","reason":"TEST illness"}}"#,
            iso(until)
        ))
    );
    assert_eq!(at(&handed, "submissions.0.late"), Json::Bool(false));
    // The same grant again writes nothing.
    grant(&c, &c.work, L, until).unwrap();
    assert_eq!(
        c.rule_events()
            .iter()
            .filter(|(kind, _)| kind == "extension")
            .count(),
        1
    );
}

#[test]
fn a_date_not_after_the_assignments_own_a_learner_not_enrolled_and_an_item_not_an_assignment_refuse()
 {
    let c = need!(course(Some(now_ms())));
    assert_eq!(
        code_of(grant(&c, &c.work, L, c.now - DAY)),
        "academy.window_invalid"
    );
    assert_eq!(
        code_of(grant(&c, &c.work, OUTSIDER, c.now + DAY)),
        "academy.enrolment_required"
    );
    assert_eq!(
        code_of(grant(&c, &c.quiz, L, c.now + DAY)),
        "academy.assignment_not_found"
    );
    assert!(c.rule_events().is_empty());
}

// ── a section released after enrolment, or at an instant (AC-release-access-01) ─────────────────────────────────────

#[test]
fn a_quiz_released_days_after_enrolment_refuses_until_then() {
    let now = now_ms();
    let c = need!(course(Some(now - 2 * DAY)));
    c.release(None, Some(7), "TEST drip");
    match c.learner_view(L) {
        Err(Refusal::Academy(e)) => {
            assert_eq!(e.code, "academy.not_released_yet");
            assert!(
                e.message.contains(&iso(now - 2 * DAY + 7 * DAY)),
                "the refusal names the instant: {}",
                e.message
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_quiz_opens_once_the_days_have_passed_since_enrolling() {
    let c = need!(course(Some(now_ms() - 8 * DAY)));
    c.release(None, Some(7), "TEST drip");
    assert_eq!(at(&c.learner_view(L).unwrap(), "itemId"), s(&c.quiz));
}

#[test]
fn work_a_learner_already_began_stays_readable_when_staff_move_the_section_later() {
    let c = need!(course(Some(now_ms())));
    quizzes::start(&c.store, &c.quiz, L, None, None, c.now).unwrap();
    c.release(None, Some(7), "TEST moved later");
    assert_eq!(at(&c.learner_view(L).unwrap(), "itemId"), s(&c.quiz));
    // Another learner who has not begun is refused.
    enrol(&mut c.db.client(), &c.id, OTHER, &iso(c.now));
    assert_eq!(
        code_of(quizzes::learner_view(&c.store, &c.quiz, OTHER, c.now)),
        "academy.not_released_yet"
    );
}

#[test]
fn a_quiz_released_at_an_instant_refuses_before_it_and_clearing_the_rule_opens_it_at_once() {
    let c = need!(course(Some(now_ms())));
    let opens = c.now + 3 * DAY;
    c.release(Some(opens), None, "TEST launch day");
    assert_eq!(code_of(c.learner_view(L)), "academy.not_released_yet");
    // Once the instant passes, it opens.
    assert!(quizzes::learner_view(&c.store, &c.quiz, L, opens + 1).is_ok());
    c.clear_release();
    assert_eq!(at(&c.learner_view(L).unwrap(), "itemId"), s(&c.quiz));
}
