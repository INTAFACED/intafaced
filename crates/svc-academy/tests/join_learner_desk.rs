//! J-academy-14 across slices, through the door (`learners/learner-desk.db.test.ts`): the staff desk's assertions the
//! community slice could only check against seeded rows, now run through each slice's own calls.
//!
//! - Access records: `admin.grantAccess` and `admin.reinstateAccess` (learner slice) against the item read that refuses
//!   an ended record (`curriculumItem`, curriculum slice) and the desk's page (`admin.learner`, community slice).
//! - The completion history: `markCurriculumComplete` and `undoCurriculumComplete`, then `admin.markCompleteFor` (learner
//!   slice), read through `admin.learnerProgress` and the page's audit.
//! - A voided attempt: `admin.setQuiz` and one attempt (`assessment.start`, `answer`, `finish`), then `admin.voidQuizAttempt` (assessment slice), read
//!   through `admin.learnerProgress`.
//!
//! The learner enrols with `enrolCourse` (learner slice). Figures are TEST values, not owner settings.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use crate::community_support;
use crate::join_support;

use community_support::{arr, get, n, s};
use join_support::{OTHER, Run, STAFF, T0, USER, advance, setup};
use service_kit::json::Json;
use service_kit::time::Instant;

const PATH: &str = "sovereign";

fn iso(at: i64) -> String {
    Instant(at).iso()
}

fn kinds(list: &[Json], key: &str) -> Vec<String> {
    list.iter().map(|e| s(e, key)).collect()
}

fn who(user: &str) -> Json {
    Json::obj([("userId", Json::str(user))])
}

impl Run {
    fn enrol(&self) {
        self.learner(
            "enrolCourse",
            &Json::obj([("slug", Json::str(PATH)), ("track", Json::str("audit"))]),
        );
    }

    /// `admin.learnerProgress(USER)`'s first course's items.
    fn items(&self) -> Vec<Json> {
        let p = self.staff_read("admin.learnerProgress", &who(USER));
        arr(&arr(&p, "courses")[0], "items").to_vec()
    }

    fn item(&self, i: usize) -> Json {
        self.items()[i].clone()
    }

    fn page(&self) -> Json {
        self.staff_read("admin.learner", &who(USER))
    }

    /// The page's access records of `PATH`.
    fn access(&self) -> Vec<Json> {
        arr(&self.page(), "access")
            .iter()
            .filter(|g| s(g, "pathSlug") == PATH)
            .cloned()
            .collect()
    }

    fn grant(&self, reason: &str, expires: Option<i64>) -> Result<Json, String> {
        let input = Json::obj([
            ("userId", Json::str(USER)),
            ("pathSlug", Json::str(PATH)),
            ("reason", Json::str(reason)),
            (
                "expiresAt",
                expires.map_or(Json::Null, |e| Json::str(iso(e))),
            ),
        ]);
        self.attempt("admin.grantAccess", &input)
    }

    /// A staff change: its answer, or its refusal code.
    fn attempt(&self, path: &str, input: &Json) -> Result<Json, String> {
        let answer =
            community_support::mutate(&self.door, STAFF, &join_support::ADMIN, path, input);
        if answer.0 == 200 {
            Ok(community_support::data(&answer))
        } else {
            Err(community_support::refused(&answer).2)
        }
    }

    /// A learner change: its answer, or its refusal code.
    fn learner_attempt(&self, path: &str, input: &Json) -> Result<Json, String> {
        let answer =
            community_support::mutate(&self.door, USER, &join_support::LEARNER, path, input);
        if answer.0 == 200 {
            Ok(community_support::data(&answer))
        } else {
            Err(community_support::refused(&answer).2)
        }
    }

    /// The learner opens the course's first item (`curriculumItem`), or its refusal code.
    fn open(&self) -> Result<Json, String> {
        let slug = s(&self.item(0), "slug");
        let answer = community_support::query(
            &self.door,
            USER,
            &join_support::LEARNER,
            "curriculumItem",
            Some(&Json::obj([("slug", Json::str(slug))])),
        );
        if answer.0 == 200 {
            Ok(community_support::data(&answer))
        } else {
            Err(community_support::refused(&answer).2)
        }
    }
}

#[test]
fn an_ended_record_refuses_the_courses_items_writes_its_expiry_once_and_is_reinstated_on_the_same_row()
 {
    let Some(run) = setup() else { return };
    run.enrol();
    run.grant("TEST", Some(T0 + 1000)).unwrap();
    // A repeat of the first grant is the same record.
    run.grant("TEST again", None).unwrap();
    run.open().unwrap();
    advance(5000);
    assert_eq!(run.open().unwrap_err(), "academy.grant_expired");
    assert_eq!(run.open().unwrap_err(), "academy.grant_expired");
    // Complete (learner slice) and a quiz attempt's Start (assessment slice) refuse the ended record too.
    let first = s(&run.item(0), "slug");
    assert_eq!(
        run.learner_attempt(
            "markCurriculumComplete",
            &Json::obj([("itemSlug", Json::str(first.clone()))])
        )
        .unwrap_err(),
        "academy.grant_expired"
    );
    assert_eq!(
        run.learner_attempt("assessment.start", &Json::obj([("slug", Json::str(first))]))
            .unwrap_err(),
        "academy.grant_expired"
    );
    // Granting again on an ended record refuses: it is reinstated on its own row instead.
    assert_eq!(
        run.grant("TEST", None).unwrap_err(),
        "academy.grant_expired"
    );
    let ended = run.access();
    assert_eq!(ended.len(), 1);
    assert_eq!(s(&ended[0], "state"), "expired");
    assert_eq!(s(&ended[0], "reason"), "TEST");
    let events = arr(&ended[0], "events");
    assert_eq!(kinds(events, "kind"), ["granted", "expired"]);
    assert_eq!(get(&events[1], "actorId"), &Json::Null);

    // A reinstatement names the event it becomes; a stale number refuses and changes nothing; blank reasons refuse.
    let grant_id = s(&ended[0], "id");
    advance(1000);
    let reinstate = |user: &str, reason: &str, n: i64| {
        run.attempt(
            "admin.reinstateAccess",
            &Json::obj([
                ("userId", Json::str(user)),
                ("grantId", Json::str(grant_id.clone())),
                ("reason", Json::str(reason)),
                ("expiresAt", Json::Null),
                ("n", Json::int(n)),
            ]),
        )
    };
    assert_eq!(
        reinstate(USER, " ", 3).unwrap_err(),
        "academy.reason_required"
    );
    assert_eq!(
        reinstate(USER, "TEST", 2).unwrap_err(),
        "academy.revision_stale"
    );
    assert_eq!(
        reinstate(OTHER, "TEST", 3).unwrap_err(),
        "academy.grant_not_found"
    );
    reinstate(USER, "TEST back", 3).unwrap();
    // A replay of the same reinstatement answers and writes nothing; one more on the live record refuses.
    reinstate(USER, "TEST back", 3).unwrap();
    assert_eq!(
        reinstate(USER, "TEST", 4).unwrap_err(),
        "academy.grant_active"
    );
    let back = run.access();
    assert_eq!(back.len(), 1);
    assert_eq!(s(&back[0], "id"), grant_id);
    assert_eq!(s(&back[0], "state"), "granted");
    assert_eq!(get(&back[0], "expiresAt"), &Json::Null);
    assert_eq!(
        kinds(arr(&back[0], "events"), "kind"),
        ["granted", "expired", "reinstated"]
    );
    run.open().unwrap();
}

#[test]
fn a_staff_grant_without_a_reason_or_with_an_end_already_passed_refuses_and_writes_nothing() {
    let Some(run) = setup() else { return };
    run.enrol();
    advance(60_000);
    let now = T0 + 60_000;
    assert_eq!(run.grant("", None).unwrap_err(), "academy.reason_required");
    assert_eq!(
        run.grant("TEST", Some(now - 1000)).unwrap_err(),
        "academy.window_invalid"
    );
    // The free enrolment is still the learner's access.
    let list = run.access();
    assert_eq!(list.len(), 1);
    assert_eq!(get(&list[0], "id"), &Json::Null);
    assert_eq!(s(&list[0], "source"), "free");
}

#[test]
fn shows_an_undone_items_tombstone_and_marks_an_item_complete_only_with_a_reason_once_per_key() {
    let Some(run) = setup() else { return };
    run.enrol();
    let first = s(&run.item(0), "slug");
    let second = s(&run.item(1), "slug");
    advance(1000);
    let done = run.learner(
        "markCurriculumComplete",
        &Json::obj([("itemSlug", Json::str(first.clone()))]),
    );
    advance(1000);
    run.learner(
        "undoCurriculumComplete",
        &Json::obj([
            ("itemSlug", Json::str(first)),
            ("completedAt", Json::str(s(&done, "completedAt"))),
            ("clientRequestId", Json::str("TEST-undo")),
        ]),
    );
    let row = run.item(0);
    assert_eq!(s(&row, "status"), "undone");
    assert_eq!(
        kinds(arr(&row, "history"), "event"),
        ["completed", "undone"]
    );

    let mark = |reason: &str, key: &str| {
        run.attempt(
            "admin.markCompleteFor",
            &Json::obj([
                ("userId", Json::str(USER)),
                ("itemSlug", Json::str(second.clone())),
                ("reason", Json::str(reason)),
                ("key", Json::str(key)),
            ]),
        )
    };
    let key = format!("override:{USER}:{second}:1");
    assert_eq!(mark("  ", &key).unwrap_err(), "academy.reason_required");
    assert_eq!(s(&run.item(1), "status"), "not_started");
    advance(60_000);
    // The completion and its desk event in one transaction, twice under one key: one event.
    assert_eq!(
        s(&mark("TEST offline", &key).unwrap(), "done"),
        "marked complete for the learner"
    );
    assert_eq!(
        s(&mark("TEST offline", &key).unwrap(), "done"),
        "already recorded"
    );
    assert_eq!(s(&run.item(1), "status"), "completed");
    let page = run.page();
    let audit: Vec<&Json> = arr(&page, "audit")
        .iter()
        .filter(|a| s(a, "kind") == "marked_complete")
        .collect();
    assert_eq!(audit.len(), 1);
    assert_eq!(s(audit[0], "actorId"), STAFF);
    assert_eq!(s(audit[0], "reason"), "TEST offline");
}

#[test]
fn a_voided_attempt_stops_counting_against_the_limit() {
    let Some(run) = setup() else { return };
    run.enrol();
    let slug = s(&run.item(1), "slug");
    run.staff(
        "admin.setQuiz",
        &Json::obj([
            ("slug", Json::str(slug.clone())),
            (
                "quiz",
                service_kit::json::parse(
                    r#"{"passMark":1,"attemptLimit":1,"timeLimitSeconds":null,"reviewMode":"score_only",
                        "questions":[{"id":"q1","prompt":"TEST question","points":1,
                          "choices":[{"id":"a","text":"TEST wrong"},{"id":"b","text":"TEST right"}],"correctChoiceId":"b"}]}"#,
                )
                .unwrap(),
            ),
            ("reason", Json::str("TEST quiz")),
        ]),
    );
    advance(10_000);
    // The quiz is taken with Start, one answer, then Finish.
    let started = run.learner(
        "assessment.start",
        &Json::obj([("slug", Json::str(slug.clone()))]),
    );
    let taken = s(&started, "attemptId");
    run.learner(
        "assessment.answer",
        &Json::obj([
            ("attemptId", Json::str(taken.clone())),
            ("questionId", Json::str("q1")),
            ("choiceId", Json::str("a")),
        ]),
    );
    run.learner(
        "assessment.finish",
        &Json::obj([("attemptId", Json::str(taken))]),
    );
    let attempt_id = run.db.texts(&format!(
        "SELECT id::text FROM academy.assessment_attempts WHERE user_id = '{USER}' AND slug = '{slug}'"
    ))[0]
        .clone();
    let quiz = get(&run.item(1), "quiz").clone();
    assert_eq!(n(&quiz, "attemptLimit"), 1);
    assert_eq!(n(&quiz, "counted"), 1);
    assert_eq!(s(&arr(&quiz, "attempts")[0], "attemptId"), attempt_id);
    advance(50_000);
    let void = |user: &str, reason: &str| {
        run.attempt(
            "admin.voidQuizAttempt",
            &Json::obj([
                ("userId", Json::str(user)),
                ("attemptId", Json::str(attempt_id.clone())),
                ("reason", Json::str(reason)),
            ]),
        )
    };
    assert_eq!(void(USER, "").unwrap_err(), "academy.reason_required");
    assert_eq!(
        void(OTHER, "TEST").unwrap_err(),
        "academy.attempt_not_found"
    );
    void(USER, "TEST page failed").unwrap();
    let voided_at = s(
        get(
            &arr(&get(&run.item(1), "quiz").clone(), "attempts")[0],
            "voided",
        ),
        "at",
    );
    // A repeat on a voided attempt answers as the first void did.
    advance(1000);
    void(USER, "TEST again").unwrap();
    let quiz = get(&run.item(1), "quiz").clone();
    assert_eq!(n(&quiz, "counted"), 0);
    let voided = get(&arr(&quiz, "attempts")[0], "voided");
    assert_eq!(s(voided, "by"), STAFF);
    assert_eq!(s(voided, "reason"), "TEST page failed");
    assert_eq!(s(voided, "at"), voided_at);
}

#[test]
fn a_note_is_kept_for_staff_and_never_returned_on_the_learners_own_reads() {
    let Some(run) = setup() else { return };
    run.enrol();
    run.learner(
        "enrollCertPath",
        &Json::obj([("pathSlug", Json::str("foundations"))]),
    );
    run.grant("TEST", None).unwrap();
    let body = "TEST internal: learner is upset about the outage";
    let note = |text: &str| {
        run.attempt(
            "admin.addLearnerNote",
            &Json::obj([
                ("userId", Json::str(USER)),
                ("body", Json::str(text)),
                ("key", Json::str("note:1")),
            ]),
        )
    };
    note(body).unwrap();
    note(body).unwrap();
    assert_eq!(note("TEST another").unwrap_err(), "academy.revision_stale");
    let notes = arr(&run.page(), "notes").to_vec();
    assert_eq!(notes.len(), 1);
    assert_eq!(s(&notes[0], "body"), body);
    assert_eq!(s(&notes[0], "authorId"), STAFF);
    // The learner's own reads (learner slice's three, the certificate slice's enrolments) never carry it.
    let reads = [
        "myLearning",
        "myAccessGrants",
        "myProgress",
        "myEnrollments",
    ]
    .map(|path| {
        let answer = community_support::query(&run.door, USER, &join_support::LEARNER, path, None);
        assert_eq!(answer.0, 200, "{path}");
        community_support::data(&answer).compact()
    });
    for (path, read) in [
        "myLearning",
        "myAccessGrants",
        "myProgress",
        "myEnrollments",
    ]
    .iter()
    .zip(&reads)
    {
        assert!(!read.contains(body), "{path} carries the note: {read}");
    }
    assert!(
        reads[3].contains("foundations"),
        "myEnrollments answers the enrolment"
    );
}
