//! The grading policy, the gradebook and the late policy, against a real Postgres: the port of
//! `curriculum/course-gradebook.db.test.ts` (AC-assignments-04, ENGINE GR-5), assertion for assertion. The course, its
//! outline and the enrolments are another slice's calls; they are written here as the rows those calls leave. The
//! grades table a learner reads (`courseGrades`) is the learner slice's call, so its three assertions stay with it.
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
use svc_academy::assessment::{gradebook, quizzes};
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const M: &str = "66666666-6666-4666-8666-666666666666";
const HOUR: i64 = 3_600_000;

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

struct Course {
    db: TestDb,
    store: Store,
    objects: MemoryObjects,
    now: i64,
    id: String,
    one: String,
    two: String,
    three: String,
    quiz: String,
    lesson: String,
}

fn brief(due_at: Option<&str>) -> BriefInput<'_> {
    BriefInput {
        instructions: "Size one trade.",
        points: "10",
        due_at,
        text: "required",
        file: "off",
    }
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

    fn submit(&self, item: &str, version: i64, body: &str) -> Json {
        assignments::submit(
            &self.store,
            &self.files(),
            item,
            version,
            Some(body),
            None,
            L,
            self.now,
        )
        .unwrap()
    }

    /// A hand-in by L graded `score` of 10, written as the grading desk writes it.
    fn graded(&self, item: &str, score: &str) {
        let view = self.submit(item, 1, "TEST working");
        let version = match at(&view, "nextVersion").compact().parse::<i64>() {
            Ok(n) => (n - 1).to_string(),
            Err(e) => panic!("nextVersion: {e}"),
        };
        let mut c = self.db.client();
        let id: String = c
            .query_one(
                "SELECT id::text FROM academy.assignment_submissions WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid AND version = $3::text::int",
                &[&item, &L, &version],
            )
            .unwrap()
            .get(0);
        c.execute(
            "INSERT INTO academy.assignment_grade_events (submission_id, n, score, points, comment, actor, reason, at) \
             VALUES ($1::text::uuid, 1, $2::text::numeric, 10, null, $3::text::uuid, null, $4::text::timestamptz)",
            &[&id, &score, &A, &Instant(self.now).iso()],
        )
        .unwrap();
    }

    fn policy(&self, weights: [&str; 2]) -> Vec<Json> {
        list(&jp(&format!(
            r#"[{{"name":"Homework","weight":"{}","dropLowest":1,"itemIds":["{}","{}","{}"]}},
                {{"name":"Quizzes","weight":"{}","dropLowest":0,"itemIds":["{}"]}}]"#,
            weights[0], self.one, self.two, self.three, weights[1], self.quiz
        )))
    }

    fn save(&self, weights: [&str; 2], revision: i64) -> Result<Json, Refusal> {
        gradebook::save_policy(
            &self.store,
            &self.id,
            revision,
            &self.policy(weights),
            "TEST",
            A,
            self.now,
        )
    }

    fn view(&self) -> Json {
        gradebook::view(&self.store, &self.id).unwrap()
    }

    fn count(&self, sql: &str) -> usize {
        self.db.client().query(sql, &[]).unwrap().len()
    }
}

fn learner(view: &Json, user: &str) -> Json {
    list(&at(view, "learners"))
        .into_iter()
        .find(|l| at(l, "userId") == s(user))
        .expect("the learner is listed")
}

fn item_cell(row: &Json, item: &str) -> Json {
    list(&at(row, "items"))
        .into_iter()
        .find(|i| at(i, "itemId") == s(item))
        .expect("the item is listed")
}

/// A published course with three assignments and a quiz, learners L and M enrolled.
fn course() -> Option<Course> {
    let db = TestDb::migrated()?;
    // `new Date()`: the test runs at the real time, as the TypeScript does.
    let now = svc_academy::door::system_now().0;
    let at_iso = Instant(now).iso();
    let mut c = db.client();
    let seeded = seed_course(
        &mut c,
        "risk-basics",
        "draft",
        A,
        &at_iso,
        &[
            ("assignment", "One"),
            ("assignment", "Two"),
            ("assignment", "Three"),
            ("quiz", "Check"),
            ("lesson", "Read me"),
        ],
    );
    let store = Store::Pool(db.pool());
    let ids = seeded.items.clone();
    for item in &ids[..3] {
        assignments::save(&store, item, 0, &brief(None), A, now).unwrap();
    }
    let quiz = jp(&format!(
        r#"{{"itemId":"{}","revision":0,"passMark":1,"attemptLimit":1,"scoringPolicy":null,"timeLimitSeconds":null,
            "reviewMode":"score_only","ipAllow":null,"kind":"quiz","anonymous":false,"resultsVisibility":"always",
            "questions":[{{"kind":"single","id":"q1","prompt":"TEST What caps the loss?","points":1,
              "choices":[{{"id":"a","text":"A stop"}},{{"id":"b","text":"Hope"}}],"correctChoiceId":"a"}}]}}"#,
        ids[3]
    ));
    quizzes::save(&store, &quiz, A, now).unwrap();
    quizzes::set_state(&store, &ids[3], "published", "TEST", A, now).unwrap();
    c.execute(
        "UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid",
        &[&seeded.id],
    )
    .unwrap();
    for user in [L, M] {
        enrol(&mut c, &seeded.id, user, &at_iso);
    }
    Some(Course {
        db,
        store,
        objects: MemoryObjects::new(),
        now,
        id: seeded.id,
        one: ids[0].clone(),
        two: ids[1].clone(),
        three: ids[2].clone(),
        quiz: ids[3].clone(),
        lesson: ids[4].clone(),
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

// ── grading policy and gradebook ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn weights_that_add_up_wrongly_refuse_the_right_set_saves_and_the_lowest_drops_before_averaging() {
    let ids = need!(course());
    match ids.save(["0.7", "0.4"], 0) {
        Err(Refusal::Academy(e)) => {
            assert_eq!(e.code, "academy.weights_invalid");
            assert!(e.message.contains("sum=1.1"), "{}", e.message);
        }
        other => panic!("{other:?}"),
    }
    let saved = ids.save(["0.6", "0.4"], 0).unwrap();
    assert_eq!(
        (at(&saved, "policy.revision"), at(&saved, "policy.setBy")),
        (Json::int(1), s(A))
    );
    // Before anything is graded: not attempted, never zero.
    assert_eq!(at(&learner(&saved, L), "total"), Json::Null);
    assert!(
        list(&at(&saved, "learners.0.items"))
            .iter()
            .all(|i| at(i, "state") == s("not_attempted") && at(i, "score") == Json::Null)
    );

    ids.graded(&ids.one, "10");
    ids.graded(&ids.two, "5");
    ids.graded(&ids.three, "8");
    let attempt = quizzes::start(&ids.store, &ids.quiz, L, None, None, ids.now).unwrap();
    let a = text(&at(&attempt, "attemptId"));
    quizzes::answer(&ids.store, &a, L, "q1", &s("a"), ids.now).unwrap();
    quizzes::finish(&ids.store, &a, L, ids.now).unwrap();

    let view = ids.view();
    let row = learner(&view, L);
    let mut counted = [ids.one.clone(), ids.three.clone()];
    counted.sort();
    assert_eq!(
        at(&row, "types"),
        jp(&format!(
            r#"[{{"name":"Homework","average":"0.9","counted":["{}","{}"],"dropped":["{}"]}},
                {{"name":"Quizzes","average":"1","counted":["{}"],"dropped":[]}}]"#,
            counted[0], counted[1], ids.two, ids.quiz
        ))
    );
    assert_eq!(at(&row, "total"), s("0.94"));
    assert_eq!(at(&learner(&view, M), "total"), Json::Null);
    // A stale revision refuses; the same set again writes no event.
    assert_eq!(
        code_of(ids.save(["0.5", "0.5"], 0)),
        "academy.revision_stale"
    );
    ids.save(["0.6", "0.4"], 1).unwrap();
    assert_eq!(
        ids.count("SELECT revision FROM academy.course_grading_policy_events"),
        1
    );
}

#[test]
fn a_newer_hand_in_waiting_for_a_grade_reads_as_pending_not_the_older_grade() {
    let ids = need!(course());
    ids.graded(&ids.one, "4");
    ids.submit(&ids.one, 2, "TEST second try");
    let row = learner(&ids.view(), L);
    assert_eq!(
        item_cell(&row, &ids.one),
        jp(&format!(
            r#"{{"itemId":"{}","state":"pending","score":null,"entered":null}}"#,
            ids.one
        ))
    );
}

#[test]
fn a_lesson_an_item_in_two_types_a_type_dropping_every_score_and_two_types_of_one_name_refuse() {
    let ids = need!(course());
    let save = |types: &str| {
        gradebook::save_policy(
            &ids.store,
            &ids.id,
            0,
            &list(&jp(types)),
            "TEST",
            A,
            ids.now,
        )
    };
    let (one, two, lesson) = (&ids.one, &ids.two, &ids.lesson);
    for types in [
        format!(r#"[{{"name":"All","weight":"1","dropLowest":0,"itemIds":["{lesson}"]}}]"#),
        format!(
            r#"[{{"name":"A","weight":"0.5","dropLowest":0,"itemIds":["{one}"]}},{{"name":"B","weight":"0.5","dropLowest":0,"itemIds":["{one}"]}}]"#
        ),
        format!(r#"[{{"name":"All","weight":"1","dropLowest":1,"itemIds":["{one}"]}}]"#),
        format!(
            r#"[{{"name":"Work","weight":"0.5","dropLowest":0,"itemIds":["{one}"]}},{{"name":"work","weight":"0.5","dropLowest":0,"itemIds":["{two}"]}}]"#
        ),
    ] {
        assert_eq!(
            code_of(save(&types)),
            "academy.grading_policy_invalid",
            "{types}"
        );
    }
}

#[test]
fn a_course_nobody_joined_shows_an_empty_policy_and_no_rows() {
    let Some(db) = TestDb::migrated() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let seeded = seed_course(
        &mut db.client(),
        "empty-course",
        "draft",
        A,
        "2026-10-23T12:00:00.000Z",
        &[],
    );
    let store = Store::Pool(db.pool());
    assert_eq!(
        gradebook::view(&store, &seeded.id).unwrap(),
        jp(&format!(
            r#"{{"courseId":"{}","policy":null,"latePolicy":null,"items":[],"learners":[]}}"#,
            seeded.id
        ))
    );
}

// ── late policy ─────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_late_policy_saves_over_the_revision_read_lowers_a_late_hand_in_at_read_and_clears() {
    let ids = need!(course());
    // Assignment One was due three days before L handed it in.
    let due = Instant(ids.now - 72 * HOUR).iso();
    assignments::save(&ids.store, &ids.one, 1, &brief(Some(&due)), A, ids.now).unwrap();
    ids.graded(&ids.one, "8");
    let late = |revision: i64, policy: Option<(&str, &str)>, hours: i64| {
        gradebook::save_late_policy(
            &ids.store,
            &ids.id,
            revision,
            policy,
            "TEST",
            A,
            ids.now + hours * HOUR,
        )
    };
    let cell = |view: &Json| item_cell(&learner(view, L), &ids.one);
    let graded = |score: &str, entered: Option<&str>| {
        let entered = entered.map_or("null".to_owned(), |e| format!("\"{e}\""));
        jp(&format!(
            r#"{{"itemId":"{}","state":"graded","score":"{score}","entered":{entered}}}"#,
            ids.one
        ))
    };
    let mine =
        || assignments::learner_view(&ids.store, &ids.files(), &ids.one, L, ids.now).unwrap();

    // No policy: nothing is taken off, and the learner sees "none".
    assert_eq!(cell(&ids.view()), graded("0.8", None));
    assert_eq!(at(&mine(), "latePolicy"), Json::Null);
    // Clearing a course that has none writes nothing.
    late(0, None, 0).unwrap();
    assert_eq!(
        ids.count("SELECT 1 FROM academy.course_late_policy_events"),
        0
    );

    // Set an hour before L handed in: 24 hours of grace, then 0.1 of the points per started day. 72 h late is 48 h past
    // the grace, two days, so 2 points come off.
    let saved = late(0, Some(("24", "0.1")), -1).unwrap();
    for (k, v) in [
        ("revision", Json::int(1)),
        (
            "policy",
            jp(r#"{"graceHours":"24","deductionPerDay":"0.1"}"#),
        ),
        ("setBy", s(A)),
        ("reason", s("TEST")),
    ] {
        assert_eq!(at(&saved, &format!("latePolicy.{k}")), v, "{k}");
    }
    assert_eq!(cell(&saved), graded("0.6", Some("0.8")));
    let view = mine();
    assert_eq!(
        at(&view, "latePolicy"),
        jp(r#"{"graceHours":"24","deductionPerDay":"0.1"}"#)
    );
    assert_eq!(
        (
            at(&view, "grade.score"),
            at(&view, "grade.points"),
            at(&view, "grade.entered")
        ),
        (s("6"), s("10"), s("8"))
    );
    // The entered grade itself is untouched.
    assert_eq!(
        ids.db
            .texts("SELECT score::text FROM academy.assignment_grade_events"),
        ["8.00"]
    );

    // A stale revision refuses; the same policy again writes no event.
    assert_eq!(
        code_of(late(0, Some(("0", "1")), 0)),
        "academy.revision_stale"
    );
    late(1, Some(("24.00", "0.1000")), 0).unwrap();
    assert_eq!(
        ids.count("SELECT revision FROM academy.course_late_policy_events"),
        1
    );

    // A harsher policy set after L handed in takes nothing off that hand-in: L was not shown it when they handed in.
    let harsher = late(1, Some(("0", "1")), 1).unwrap();
    assert_eq!(at(&harsher, "latePolicy.revision"), Json::int(2));
    assert_eq!(
        at(&harsher, "latePolicy.policy"),
        jp(r#"{"graceHours":"0","deductionPerDay":"1"}"#)
    );
    assert_eq!(cell(&harsher), graded("0.8", None));
    let view = mine();
    assert_eq!(
        (at(&view, "grade.score"), at(&view, "grade.entered")),
        (s("8"), Json::Null)
    );

    // Cleared: the revision goes on, nothing is taken off, and the history keeps every save.
    let cleared = late(2, None, 2).unwrap();
    assert_eq!(
        (
            at(&cleared, "latePolicy.revision"),
            at(&cleared, "latePolicy.policy")
        ),
        (Json::int(3), Json::Null)
    );
    assert_eq!(cell(&cleared), graded("0.8", None));
    let history: Vec<(i32, Option<String>, Option<String>, String)> = ids
        .db
        .client()
        .query(
            "SELECT revision, grace_hours::text, deduction_per_day::text, actor_id::text FROM academy.course_late_policy_events ORDER BY revision",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect();
    let some = |v: &str| Some(v.to_owned());
    assert_eq!(
        history,
        [
            (1, some("24.00"), some("0.1000"), A.to_owned()),
            (2, some("0.00"), some("1.0000"), A.to_owned()),
            (3, None, None, A.to_owned()),
        ]
    );
}

#[test]
fn a_late_policy_on_a_course_that_does_not_exist_refuses() {
    let ids = need!(course());
    assert_eq!(
        code_of(gradebook::save_late_policy(
            &ids.store,
            "77777777-7777-4777-8777-777777777777",
            0,
            Some(("1", "0.5")),
            "TEST",
            A,
            ids.now
        )),
        "academy.course_not_found"
    );
}
