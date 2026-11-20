//! J-academy-14: the staff desk for one learner, against a real database (`learners/learner-desk.db.test.ts`). Figures
//! are TEST values, not owner settings.
//!
//! The desk's own calls run here as the TypeScript test calls `academy.learners`: access records, notes, tags, the
//! learners report, voiding an attempt and the progress view. What another slice owns is seeded as the rows it leaves:
//! enrolling (`enrolCourse`, the learner slice) is a `cert_enrollments` row; completing and undoing an item (the learner
//! slice) are `item_completion_events` rows; a quiz and its attempts (the assessment slice) are `quizzes` and
//! `assessment_attempts` rows. The item reads those slices answer (`readCurriculumItem`, `markCurriculumComplete`,
//! `startQuizAttempt`) refuse through this desk's `assert_access`, which is checked here directly.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

mod community_support;
mod support;

use community_support::{
    arr, at, b, code, door, enrol_path, get, mutate, n, query, refused, s, setup,
};
use service_kit::json::Json;
use service_kit::time::Instant;
use svc_academy::community::{Db, learner_desk};
use svc_academy::db::Store;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const PATH: &str = "sovereign";
const T0: &str = "2030-01-01T00:00:00.000Z";

fn plus(t: Instant, ms: i64) -> Instant {
    Instant(t.0 + ms)
}

/// `(await academy.learners.progress(USER, true)).courses`.
fn courses(store: &Store) -> Vec<Json> {
    let p = learner_desk::progress(&Db(store), USER, true).unwrap();
    arr(&p, "courses").to_vec()
}

fn item(store: &Store, i: usize) -> Json {
    arr(&courses(store)[0], "items")[i].clone()
}

/// The page's access records of `PATH`.
fn access(store: &Store, now: Instant) -> Vec<Json> {
    let page = learner_desk::page(&Db(store), USER, true, now).unwrap();
    arr(&page, "access")
        .iter()
        .filter(|g| s(g, "pathSlug") == PATH)
        .cloned()
        .collect()
}

fn kinds(list: &[Json], key: &str) -> Vec<String> {
    list.iter().map(|e| s(e, key)).collect()
}

#[test]
fn an_ended_record_refuses_the_courses_items_writes_its_expiry_once_and_is_reinstated_on_the_same_row()
 {
    let Some((db, store)) = setup() else { return };
    let desk = Db(&store);
    enrol_path(&db, USER, PATH, T0);
    let t0 = at(T0);
    learner_desk::grant_access(&desk, USER, PATH, "TEST", Some(plus(t0, 1000)), STAFF, t0).unwrap();
    // A repeat of the first grant is the same record.
    learner_desk::grant_access(&desk, USER, PATH, "TEST again", None, STAFF, t0).unwrap();
    learner_desk::assert_access(&desk, USER, PATH, t0).unwrap();
    let later = plus(t0, 5000);
    assert_eq!(
        code(learner_desk::assert_access(&desk, USER, PATH, later)),
        "academy.grant_expired"
    );
    assert_eq!(
        code(learner_desk::assert_access(&desk, USER, PATH, later)),
        "academy.grant_expired"
    );
    // Granting again on an ended record refuses: it is reinstated on its own row instead.
    assert_eq!(
        code(learner_desk::grant_access(
            &desk, USER, PATH, "TEST", None, STAFF, later
        )),
        "academy.grant_expired"
    );
    let ended = access(&store, later);
    assert_eq!(ended.len(), 1);
    assert_eq!(s(&ended[0], "state"), "expired");
    assert_eq!(s(&ended[0], "reason"), "TEST");
    let events = arr(&ended[0], "events");
    assert_eq!(kinds(events, "kind"), ["granted", "expired"]);
    assert_eq!(get(&events[1], "actorId"), &Json::Null);

    // A reinstatement names the event it becomes; a stale number refuses and changes nothing; blank reasons refuse.
    let grant_id = s(&ended[0], "id");
    let back_at = plus(later, 1000);
    let reinstate = |user: &str, reason: &str, n: i64| {
        learner_desk::reinstate(&desk, user, &grant_id, reason, None, n, STAFF, back_at)
    };
    assert_eq!(code(reinstate(USER, " ", 3)), "academy.reason_required");
    assert_eq!(code(reinstate(USER, "TEST", 2)), "academy.revision_stale");
    assert_eq!(code(reinstate(OTHER, "TEST", 3)), "academy.grant_not_found");
    reinstate(USER, "TEST back", 3).unwrap();
    // A replay of the same reinstatement answers and writes nothing; one more on the live record refuses.
    reinstate(USER, "TEST back", 3).unwrap();
    assert_eq!(code(reinstate(USER, "TEST", 4)), "academy.grant_active");
    let back = access(&store, back_at);
    assert_eq!(back.len(), 1);
    assert_eq!(s(&back[0], "id"), grant_id);
    assert_eq!(s(&back[0], "state"), "granted");
    assert_eq!(get(&back[0], "expiresAt"), &Json::Null);
    assert_eq!(
        kinds(arr(&back[0], "events"), "kind"),
        ["granted", "expired", "reinstated"]
    );
    learner_desk::assert_access(&desk, USER, PATH, back_at).unwrap();
}

#[test]
fn a_learner_with_no_record_keeps_the_free_enrolment_as_access_and_a_staff_grant_without_a_reason_refuses()
 {
    let Some((db, store)) = setup() else { return };
    let desk = Db(&store);
    enrol_path(&db, USER, PATH, T0);
    let now = plus(at(T0), 60_000);
    let page = learner_desk::page(&desk, USER, true, now).unwrap();
    let list = arr(&page, "access");
    assert_eq!(list.len(), 1);
    assert_eq!(get(&list[0], "id"), &Json::Null);
    assert_eq!(s(&list[0], "pathSlug"), PATH);
    assert_eq!(s(&list[0], "source"), "free");
    assert_eq!(s(&list[0], "state"), "granted");
    assert_eq!(get(&list[0], "expiresAt"), &Json::Null);
    assert_eq!(
        code(learner_desk::grant_access(
            &desk, USER, PATH, "", None, STAFF, now
        )),
        "academy.reason_required"
    );
    assert_eq!(
        code(learner_desk::grant_access(
            &desk,
            USER,
            PATH,
            "TEST",
            Some(plus(now, -1000)),
            STAFF,
            now
        )),
        "academy.window_invalid"
    );
    let page = learner_desk::page(&desk, USER, true, now).unwrap();
    assert_eq!(get(&arr(&page, "access")[0], "id"), &Json::Null);
}

#[test]
fn shows_an_undone_items_tombstone_marks_an_item_complete_only_with_a_reason_once_per_key() {
    let Some((db, store)) = setup() else { return };
    enrol_path(&db, USER, PATH, T0);
    let first = s(&item(&store, 0), "slug");
    let second = s(&item(&store, 1), "slug");
    // What `markCurriculumComplete` then `undoCurriculumComplete` (the learner slice) leave.
    db.client()
        .execute(
            "INSERT INTO academy.item_completion_events (user_id, item_slug, event, client_request_id, recorded_at) VALUES
               ($1::text::uuid, $2, 'completed', NULL, '2030-01-01T00:00:01Z'),
               ($1::text::uuid, $2, 'undone', 'TEST-undo', '2030-01-01T00:00:02Z')",
            &[&USER, &first],
        )
        .unwrap();
    let row = item(&store, 0);
    assert_eq!(s(&row, "status"), "undone");
    assert_eq!(
        kinds(arr(&row, "history"), "event"),
        ["completed", "undone"]
    );

    // `staffMarkComplete` (the learner slice) refuses a blank reason through this desk's rule, before anything is written.
    let key = format!("override:{USER}:{second}:1");
    assert_eq!(
        code(learner_desk::require_reason("  ")),
        "academy.reason_required"
    );
    assert_eq!(s(&item(&store, 1), "status"), "not_started");
    // The completion and its desk event in one transaction, twice under one key: one event.
    let now = at("2030-01-01T00:01:00.000Z");
    for _ in 0..2 {
        let mut c = db.client();
        let mut tx = c.transaction().unwrap();
        if !learner_desk::mark_recorded(&mut tx, USER, &second, &key).unwrap() {
            tx.execute(
                "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES ($1::text::uuid, $2, $3::text::timestamptz)",
                &[&USER, &second, &now.iso()],
            )
            .unwrap();
            learner_desk::record_mark_complete(
                &mut tx,
                USER,
                &second,
                "TEST offline",
                &key,
                STAFF,
                now,
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    assert_eq!(s(&item(&store, 1), "status"), "completed");
    let page = learner_desk::page(&Db(&store), USER, true, now).unwrap();
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
    let Some((db, store)) = setup() else { return };
    let desk = Db(&store);
    enrol_path(&db, USER, PATH, T0);
    let slug = s(&item(&store, 1), "slug");
    // What `setQuiz` and one finished attempt (the assessment slice) leave.
    let attempt_id: String = db
        .client()
        .query_one(
            "WITH q AS (
               INSERT INTO academy.quizzes (slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode, reason, set_by, set_at)
               VALUES ($1, '{}'::jsonb, 1, 1, NULL, 'score_only', 'TEST quiz', $3::text::uuid, now()))
             INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed, submitted_at)
             VALUES ($2::text::uuid, $1, 'TEST-1', 0, 1, false, '2030-01-01T00:00:10Z') RETURNING id::text",
            &[&slug, &USER, &STAFF],
        )
        .unwrap()
        .get(0);
    let quiz = get(&item(&store, 1), "quiz").clone();
    assert_eq!(n(&quiz, "attemptLimit"), 1);
    assert_eq!(n(&quiz, "counted"), 1);
    assert_eq!(s(&arr(&quiz, "attempts")[0], "attemptId"), attempt_id);
    let now = at("2030-01-01T00:01:00.000Z");
    assert_eq!(
        code(learner_desk::void_attempt(
            &desk,
            USER,
            &attempt_id,
            "",
            STAFF,
            now
        )),
        "academy.reason_required"
    );
    assert_eq!(
        code(learner_desk::void_attempt(
            &desk,
            OTHER,
            &attempt_id,
            "TEST",
            STAFF,
            now
        )),
        "academy.attempt_not_found"
    );
    let voided_at =
        learner_desk::void_attempt(&desk, USER, &attempt_id, "TEST page failed", STAFF, now)
            .unwrap();
    // A repeat on a voided attempt answers as the first void did.
    assert_eq!(
        learner_desk::void_attempt(
            &desk,
            USER,
            &attempt_id,
            "TEST again",
            STAFF,
            plus(now, 1000)
        )
        .unwrap(),
        voided_at
    );
    let quiz = get(&item(&store, 1), "quiz").clone();
    assert_eq!(n(&quiz, "counted"), 0);
    let voided = get(&arr(&quiz, "attempts")[0], "voided");
    assert_eq!(s(voided, "by"), STAFF);
    assert_eq!(s(voided, "reason"), "TEST page failed");
}

#[test]
fn a_note_is_kept_for_staff_and_never_returned_to_the_learner_a_replay_keeps_one_note() {
    let Some((db, store)) = setup() else { return };
    let desk = Db(&store);
    enrol_path(&db, USER, PATH, T0);
    let body = "TEST internal: learner is upset about the outage";
    let now = at("2030-01-01T00:01:00.000Z");
    assert_eq!(
        learner_desk::add_note(&desk, USER, body, "note:1", STAFF, now).unwrap(),
        1
    );
    assert_eq!(
        learner_desk::add_note(&desk, USER, body, "note:1", STAFF, now).unwrap(),
        1
    );
    // Another note under the same key (a second agent on a stale page) refuses rather than vanishing.
    assert_eq!(
        code(learner_desk::add_note(
            &desk,
            USER,
            "TEST another",
            "note:1",
            STAFF,
            now
        )),
        "academy.revision_stale"
    );
    let page = learner_desk::page(&desk, USER, true, now).unwrap();
    let notes = arr(&page, "notes");
    assert_eq!(notes.len(), 1);
    assert_eq!(n(&notes[0], "n"), 1);
    assert_eq!(s(&notes[0], "body"), body);
    assert_eq!(s(&notes[0], "authorId"), STAFF);
    // The learner may not read the staff page.
    let d = door(Store::Pool(db.pool()), Json::obj([]));
    let mine = query(
        &d,
        USER,
        &["academy:read", "academy:write"],
        "admin.learner",
        Some(&Json::obj([("userId", Json::str(USER))])),
    );
    assert_eq!(refused(&mine).0, 403);
    assert!(!mine.1.compact().contains(body));
}

#[test]
fn a_report_filtered_by_a_tag_lists_only_tagged_learners() {
    let Some((db, store)) = setup() else { return };
    let desk = Db(&store);
    for u in [USER, OTHER] {
        enrol_path(&db, u, PATH, T0);
    }
    let now = at("2030-01-01T00:01:00.000Z");
    let ids = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        code(learner_desk::tag(
            &desk,
            &ids(&[USER]),
            "test-tag",
            " ",
            STAFF,
            now
        )),
        "academy.reason_required"
    );
    assert_eq!(
        learner_desk::tag(&desk, &ids(&[USER, USER]), "test-tag", "TEST", STAFF, now).unwrap(),
        1
    );
    let users = |tag: Option<&str>| {
        let r = learner_desk::learners(&desk, tag, 50).unwrap();
        let mut v = kinds(arr(&r, "rows"), "userId");
        v.sort();
        v
    };
    assert_eq!(users(Some("test-tag")), [USER]);
    let mut both = vec![USER, OTHER];
    both.sort_unstable();
    assert_eq!(users(None), both);
    assert_eq!(
        learner_desk::tags(&desk).unwrap(),
        Json::Array(vec![Json::obj([
            ("tag", Json::str("test-tag")),
            ("learners", Json::int(1))
        ])])
    );
    assert!(learner_desk::untag(&desk, USER, "test-tag", "TEST", STAFF, now).unwrap());
    assert!(users(Some("test-tag")).is_empty());
    let page = learner_desk::page(&desk, USER, true, now).unwrap();
    let audit = kinds(arr(&page, "audit"), "kind");
    assert!(audit.iter().any(|k| k == "tag_added"), "{audit:?}");
    assert!(audit.iter().any(|k| k == "tag_removed"), "{audit:?}");
}

#[test]
fn a_read_only_session_reads_the_page_with_no_change_allowed_and_a_direct_change_refuses_as_not_permitted()
 {
    let Some((db, store)) = setup() else { return };
    enrol_path(&db, USER, PATH, T0);
    let d = door(Store::Pool(db.pool()), Json::obj([]));
    let who = Json::obj([("userId", Json::str(USER))]);
    let reader = ["admin:read"];
    let page = community_support::data(&query(&d, STAFF, &reader, "admin.learner", Some(&who)));
    assert!(!b(&page, "canChange"));
    let note = mutate(
        &d,
        STAFF,
        &reader,
        "admin.addLearnerNote",
        &Json::obj([
            ("userId", Json::str(USER)),
            ("body", Json::str("TEST")),
            ("key", Json::str("k")),
        ]),
    );
    assert_eq!(refused(&note).0, 403);
    let tag = mutate(
        &d,
        STAFF,
        &reader,
        "admin.tagLearners",
        &Json::obj([
            ("userIds", Json::Array(vec![Json::str(USER)])),
            ("tag", Json::str("x")),
            ("reason", Json::str("TEST")),
        ]),
    );
    assert_eq!(refused(&tag).0, 403);
    let now = at("2030-01-01T00:01:00.000Z");
    let page = learner_desk::page(&Db(&store), USER, true, now).unwrap();
    assert!(arr(&page, "audit").is_empty());
    let writer = ["admin:read", "admin:write"];
    let page = community_support::data(&query(&d, STAFF, &writer, "admin.learner", Some(&who)));
    assert!(b(&page, "canChange"));
}
