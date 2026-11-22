//! J-academy-14: the staff desk for one learner, against a real database (`learners/learner-desk.db.test.ts`). Figures
//! are TEST values, not owner settings.
//!
//! The desk's own calls run here as the TypeScript test calls `academy.learners`: notes, tags, the learners report and
//! the page. The desk's changes that are other slices' calls (access records, the progress view, an item marked
//! complete, a voided attempt) run through the door in `join_learner_desk.rs`.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use crate::community_support;

use community_support::{arr, at, b, code, door, enrol_path, mutate, n, query, refused, s, setup};
use service_kit::json::Json;
use svc_academy::community::{Db, learner_desk};
use svc_academy::db::Store;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const PATH: &str = "sovereign";
const T0: &str = "2030-01-01T00:00:00.000Z";

fn kinds(list: &[Json], key: &str) -> Vec<String> {
    list.iter().map(|e| s(e, key)).collect()
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
