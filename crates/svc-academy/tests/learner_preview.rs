//! `curriculum/course-preview.db.test.ts` (AC-catalogue-03): Preview as new learner and private links to a course's
//! unlisted page, against a real Postgres (`TEST_DATABASE_URL`; skips without one unless `REQUIRE_POSTGRES=1`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod learner_courses;
mod support;

use learner_courses::{
    A, B, COURSE, LATER, LATER_ISO, LESSON, LINK, NOW, SUBHEADER, code, counts, draft_with_outline,
};
use service_kit::json::{self, Json};
use support::TestDb;
use svc_academy::db::Store;
use svc_academy::learner::preview::CoursePreview;

fn parse(text: &str) -> Json {
    json::parse(text).unwrap()
}

fn items(view: &Json) -> Vec<Json> {
    match view.get("sections").unwrap() {
        Json::Array(s) => match s[0].get("items").unwrap() {
            Json::Array(i) => i.clone(),
            other => panic!("items: {other:?}"),
        },
        other => panic!("sections: {other:?}"),
    }
}

fn locks(view: &Json) -> Vec<Json> {
    items(view)
        .iter()
        .map(|i| i.get("lock").unwrap().clone())
        .collect()
}

fn s(v: Option<&Json>) -> String {
    match v {
        Some(Json::String(s)) => s.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

#[test]
fn shows_the_real_syllabus_with_locks_and_writes_nothing() {
    let Some(db) = TestDb::migrated() else { return };
    let mut c = db.client();
    draft_with_outline(&mut c);
    let store = Store::Pool(db.pool());
    let preview = CoursePreview { pool: &store };
    let before = counts(&mut c);
    assert_eq!(
        preview.preview(COURSE, NOW).unwrap(),
        parse(&format!(
            r#"{{"slug":"risk-basics","title":"Risk basics","summary":null,"thumbnailUrl":null,"pricing":"free","price":null,
            "priceAsset":null,"state":"draft","pacing":null,"sections":[{{"title":"Start here","release":null,"items":[
            {{"id":"{SUBHEADER}","kind":"subheader","title":"Part 1","indent":0,"lock":null}},
            {{"id":"{LESSON}","kind":"lesson","title":"Position size","indent":0,"lock":"not_released"}},
            {{"id":"{LINK}","kind":"link","title":"Reading","indent":0,"lock":"enrolment_closed"}}]}}]}}"#
        ))
    );
    assert_eq!(counts(&mut c), before);

    learner_courses::publish_lesson(&mut c);
    let lesson = &items(&preview.preview(COURSE, NOW).unwrap())[1];
    assert_eq!(lesson.get("title"), Some(&Json::str("Position size")));
    assert_eq!(lesson.get("lock"), Some(&Json::str("enrolment_closed")));
    // Published, the released items wait only for the reader's enrolment.
    learner_courses::publish_course(&mut c);
    let live = preview.preview(COURSE, NOW).unwrap();
    assert_eq!(live.get("state"), Some(&Json::str("published")));
    assert_eq!(
        locks(&live),
        vec![Json::Null, Json::str("enrol"), Json::str("enrol")]
    );
}

#[test]
fn an_unknown_course_is_not_found() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let preview = CoursePreview { pool: &store };
    assert_eq!(
        code(&preview.preview(B, NOW).unwrap_err()),
        "academy.course_not_found"
    );
}

#[test]
fn a_link_opens_the_unlisted_page_only_its_hash_is_stored_a_revoked_one_is_not_found() {
    let Some(db) = TestDb::migrated() else { return };
    let mut c = db.client();
    draft_with_outline(&mut c);
    let store = Store::Pool(db.pool());
    let preview = CoursePreview { pool: &store };
    let made = preview
        .create_link(COURSE, "TEST reviewer", A, NOW)
        .unwrap();
    let key = s(made.get("key"));
    assert!(svc_academy::learner::preview::is_link_key(&key), "{key}");
    assert_eq!(
        s(made.get("path")),
        format!("/academy/learning/course/risk-basics#key={key}")
    );
    let link = made.get("link").unwrap();
    assert_eq!(link.get("reason"), Some(&Json::str("TEST reviewer")));
    assert_eq!(link.get("createdBy"), Some(&Json::str(A)));
    assert_eq!(link.get("revokedAt"), Some(&Json::Null));
    let stored = db.texts("SELECT key_sha256 FROM academy.course_private_links");
    assert!(!stored.concat().contains(&key));

    let before = counts(&mut c);
    let opened = preview.by_link("risk-basics", &key, NOW).unwrap();
    assert_eq!(opened.get("title"), Some(&Json::str("Risk basics")));
    assert_eq!(opened.get("state"), Some(&Json::str("draft")));
    assert_eq!(counts(&mut c), before);
    let not_found = |slug: &str, k: &str| code(&preview.by_link(slug, k, NOW).unwrap_err());
    assert_eq!(not_found("other-course", &key), "academy.course_not_found");
    assert_eq!(
        not_found("risk-basics", &key[1..]),
        "academy.course_not_found"
    );
    assert_eq!(
        not_found("risk-basics", &"x".repeat(43)),
        "academy.course_not_found"
    );

    let link_id = s(link.get("id"));
    let revoked = preview
        .revoke_link(&link_id, "TEST done", B, LATER)
        .unwrap();
    assert_eq!(revoked.get("revokedBy"), Some(&Json::str(B)));
    assert_eq!(revoked.get("revokedAt"), Some(&Json::str(LATER_ISO)));
    assert_eq!(revoked.get("revokeReason"), Some(&Json::str("TEST done")));
    // A repeat answers with the link as it was first revoked.
    assert_eq!(
        preview.revoke_link(&link_id, "again", A, NOW).unwrap(),
        revoked
    );
    assert_eq!(not_found("risk-basics", &key), "academy.course_not_found");
    assert_eq!(preview.links(COURSE).unwrap(), Json::Array(vec![revoked]));
    assert_eq!(
        code(&preview.links(B).unwrap_err()),
        "academy.course_not_found"
    );
    assert_eq!(
        code(&preview.revoke_link(B, "x", A, NOW).unwrap_err()),
        "academy.private_link_not_found"
    );
}

#[test]
fn an_archived_course_opens_through_no_link_and_takes_no_new_one() {
    let Some(db) = TestDb::migrated() else { return };
    let mut c = db.client();
    draft_with_outline(&mut c);
    let store = Store::Pool(db.pool());
    let preview = CoursePreview { pool: &store };
    let made = preview.create_link(COURSE, "TEST", A, NOW).unwrap();
    let key = s(made.get("key"));
    c.batch_execute(&format!(
        "UPDATE academy.courses SET state = 'archived' WHERE id = '{COURSE}'"
    ))
    .unwrap();
    assert_eq!(
        code(&preview.by_link("risk-basics", &key, NOW).unwrap_err()),
        "academy.course_not_found"
    );
    assert_eq!(
        code(&preview.create_link(COURSE, "TEST", A, NOW).unwrap_err()),
        "academy.private_link_course_closed"
    );
    assert_eq!(
        code(&preview.create_link(B, "TEST", A, NOW).unwrap_err()),
        "academy.course_not_found"
    );
}
