//! `curriculum/learn-hub.db.test.ts` (AC-articles-01) against a real Postgres: the Learn hub's featured article, the
//! one slot shared with a curriculum item, and topics. `publicLesson` is the curriculum slice's read of the slot
//! (`gates::featured_lesson`); it is read here against the rows the authoring calls leave.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::authoring_kit;

use authoring_kit::{at, at_path, code, equals, is_null, matches, n, s, same, store, v};
use service_kit::json::Json;
use svc_academy::authoring::courses::{CourseRecords, Limits};
use svc_academy::authoring::learn_hub;
use svc_academy::authoring::lessons::Lessons;
use svc_academy::curriculum::gates;
use svc_academy::db::Store;

const A: &str = "33333333-3333-4333-8333-333333333333";
const B: &str = "44444444-4444-4444-8444-444444444444";
const NOW: &str = "2026-10-23T12:00:00.000Z";
const LATER: &str = "2026-10-23T13:00:00.000Z";

fn now() -> i64 {
    at(NOW)
}
fn later() -> i64 {
    at(LATER)
}

fn courses() -> CourseRecords {
    CourseRecords {
        limits: Limits {
            max_sections: Some(5),
            max_items: Some(3),
        },
    }
}

fn text(markdown: &str) -> String {
    Json::Array(vec![Json::obj([
        ("type", Json::str("text")),
        ("markdown", Json::str(markdown)),
    ])])
    .compact()
}

struct Draft {
    course: Json,
    subheader: String,
    lesson: String,
}

fn draft_with_outline(st: &Store) -> Draft {
    let c = courses();
    let course = c
        .create(
            st,
            &v(r#"{"slug":"risk-basics","title":"Risk basics","summary":null,"thumbnailUrl":null,"pricing":"free","price":null,"priceAsset":null}"#),
            A,
            now(),
        )
        .unwrap();
    let detail = c
        .save_outline(
            st,
            &v(&format!(
                r#"{{"courseId":"{}","revision":1,"sections":[{{"title":"Start here","items":[
                {{"kind":"subheader","title":"Part 1","indent":0,"url":null}},
                {{"kind":"lesson","title":"Position size","indent":0,"url":null}},
                {{"kind":"link","title":"Reading","indent":0,"url":"https://example.com/read"}}]}}]}}"#,
                s(&course, "id")
            )),
            A,
            now(),
        )
        .unwrap();
    Draft {
        course: at_path(&detail, "course").clone(),
        subheader: s(&detail, "outline.0.items.0.id"),
        lesson: s(&detail, "outline.0.items.1.id"),
    }
}

fn feature(
    st: &Store,
    item: &str,
    reason: &str,
    op: &str,
    t: i64,
) -> Result<Json, svc_academy::errors::Refusal> {
    learn_hub::feature_lesson(
        st,
        &v(&format!(r#"{{"itemId":"{item}","reason":"{reason}"}}"#)),
        op,
        t,
    )
}

fn public_lesson(st: &Store) -> Json {
    gates::featured_lesson(st.pool().unwrap()).unwrap()
}

/// Save one revision and publish it: the course revision after.
fn go_live(l: &Lessons<'_>, item: &str) -> i64 {
    let saved = l
        .save(
            &v(&format!(
                r#"{{"itemId":"{item}","revision":0,"blocks":{}}}"#,
                text("One")
            )),
            A,
            now(),
        )
        .unwrap();
    let live = l
        .publish(
            &v(&format!(
                r#"{{"itemId":"{item}","lessonRevision":1,"courseRevision":{},"reason":"TEST"}}"#,
                n(&saved, "courseRevision")
            )),
            A,
            now(),
        )
        .unwrap();
    n(&live, "courseRevision")
}

// ── the Learn hub featured article (AC-articles-01) ─────────────────────────────────────────────────────────────────

#[test]
fn only_a_lesson_learners_can_read_is_featured_withdrawing_it_empties_the_slot_a_repeat_withdrawal_answers_the_same()
 {
    let Some((db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    assert_eq!(
        code(feature(&st, &d.lesson, "TEST", A, now())),
        "academy.featured_not_live"
    );
    assert_eq!(
        code(feature(&st, &d.subheader, "TEST", A, now())),
        "academy.item_has_no_lesson"
    );
    equals(
        &learn_hub::slot(&st).unwrap(),
        r#"{"curriculum":null,"lesson":null,"reason":null,"chosenBy":null,"chosenAt":null}"#,
    );

    let live_revision = go_live(&l, &d.lesson);
    let slot = feature(&st, &d.lesson, "TEST first article", B, later()).unwrap();
    matches(
        &slot,
        &format!(
            r#"{{"lesson":{{"itemId":"{}","title":"Position size","courseTitle":"Risk basics","courseState":"draft","liveRevision":1}},"reason":"TEST first article","chosenBy":"{B}"}}"#,
            d.lesson
        ),
    );
    assert_eq!(
        at_path(&l.get(&d.lesson).unwrap(), "featured").compact(),
        "true"
    );
    // Visitors see its title and course; the course's address only once the course is published.
    equals(
        &public_lesson(&st),
        r#"{"title":"Position size","courseTitle":"Risk basics","courseSlug":null}"#,
    );
    let course_id = s(&d.course, "id");
    let slug: String = db
        .client()
        .query_one("UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid RETURNING slug", &[&course_id])
        .unwrap()
        .get(0);
    equals(
        &public_lesson(&st),
        &format!(
            r#"{{"title":"Position size","courseTitle":"Risk basics","courseSlug":"{slug}"}}"#
        ),
    );
    db.client()
        .execute(
            "UPDATE academy.courses SET state = 'draft' WHERE id = $1::text::uuid",
            &[&course_id],
        )
        .unwrap();

    let withdraw = |course_revision: i64, reason: &str, op: &str| {
        l.withdraw(
            &v(&format!(
                r#"{{"itemId":"{}","courseRevision":{course_revision},"reason":"{reason}"}}"#,
                d.lesson
            )),
            op,
            later(),
        )
    };
    let withdrawn = withdraw(live_revision, "TEST pulled", A).unwrap();
    matches(
        &withdrawn,
        &format!(
            r#"{{"featured":false,"item":{{"liveRevision":null}},"courseRevision":{}}}"#,
            live_revision + 1
        ),
    );
    assert!(is_null(&learn_hub::slot(&st).unwrap(), "lesson"));
    equals(&public_lesson(&st), "null");
    assert_eq!(
        db.texts("SELECT action || '|' || reason || '|' || actor::text FROM academy.featured_events ORDER BY at, action"),
        [format!("featured|TEST first article|{B}"), format!("withdrawn|TEST pulled|{A}")]
    );
    same(
        &withdraw(live_revision, "TEST pulled", A).unwrap(),
        &withdrawn,
    );
    assert_eq!(
        code(withdraw(n(&withdrawn, "courseRevision"), "TEST", A)),
        "academy.lesson_not_live"
    );
    assert_eq!(
        code(withdraw(live_revision, "TEST", B)),
        "academy.course_revision_stale"
    );
}

#[test]
fn the_one_slot_shows_a_curriculum_item_too_clearing_empties_it_and_records_who_and_why() {
    let Some((db, st)) = store() else { return };
    let slug = svc_academy::curriculum::spine::list(None, None)[0]
        .slug
        .clone();
    db.client()
        .execute(
            "INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at) VALUES ('hub', $1::text, 'TEST', $2::text::uuid, $3::text::timestamptz)",
            &[&slug, &A, &NOW],
        )
        .unwrap();
    matches(
        &learn_hub::slot(&st).unwrap(),
        &format!(r#"{{"curriculum":{{"slug":"{slug}"}},"lesson":null,"reason":"TEST"}}"#),
    );
    equals(&public_lesson(&st), "null");
    learn_hub::clear_featured(&st, &v(r#"{"reason":"TEST tidy"}"#), B, later()).unwrap();
    assert!(is_null(&learn_hub::slot(&st).unwrap(), "curriculum"));
    assert_eq!(
        db.texts("SELECT action || '|' || coalesce(item_slug, '') || '|' || reason || '|' || actor::text FROM academy.featured_events ORDER BY at"),
        [format!("cleared|{slug}|TEST tidy|{B}")]
    );
}

#[test]
fn a_lesson_in_a_course_that_is_no_longer_draft_or_published_leaves_the_slot_and_is_not_featured() {
    let Some((db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    go_live(&l, &d.lesson);
    feature(&st, &d.lesson, "TEST", A, now()).unwrap();
    db.client()
        .execute(
            "UPDATE academy.courses SET state = 'archived' WHERE id = $1::text::uuid",
            &[&s(&d.course, "id")],
        )
        .unwrap();
    assert!(is_null(&learn_hub::slot(&st).unwrap(), "lesson"));
    equals(&public_lesson(&st), "null");
    assert_eq!(
        code(feature(&st, &d.lesson, "TEST", A, now())),
        "academy.course_not_editable"
    );
}

// ── topics (AC-articles-01) ─────────────────────────────────────────────────────────────────────────────────────────

fn topic(
    st: &Store,
    slug: &str,
    name: &str,
    op: &str,
    t: i64,
) -> Result<Json, svc_academy::errors::Refusal> {
    learn_hub::create_topic(
        st,
        &v(&format!(r#"{{"slug":"{slug}","name":"{name}"}}"#)),
        op,
        t,
    )
}

#[test]
fn a_tab_address_is_refused_a_repeat_answers_with_the_topic_another_name_is_refused_the_list_needs_its_limit()
 {
    let Some((_db, st)) = store() else { return };
    assert_eq!(
        code(topic(&st, "learning", "Learning", A, now())),
        "academy.slug_reserved"
    );
    let risk = topic(&st, "risk", "Risk", A, now()).unwrap();
    same(&topic(&st, "risk", "Risk", B, later()).unwrap(), &risk);
    assert_eq!(
        code(topic(&st, "risk", "Other", A, now())),
        "academy.topic_slug_taken"
    );
    topic(&st, "charts", "Charts", A, later()).unwrap();
    let one = learn_hub::topics(&st, Some(1)).unwrap();
    assert_eq!(authoring_kit::len(&one, "topics"), 1);
    assert_eq!(s(&one, "topics.0.slug"), "charts");
    assert_eq!(n(&one, "limit"), 1);
    assert_eq!(
        code(learn_hub::topics(&st, None)),
        "academy.topics_list_limit_unset"
    );
}

#[test]
fn a_course_is_filed_under_topics_over_the_revision_read_a_repeat_answers_with_it_an_unknown_topic_is_refused()
 {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let risk = topic(&st, "risk", "Risk", A, now()).unwrap();
    let course_id = s(&d.course, "id");
    let revision = n(&d.course, "revision");
    let set = |ids: &str| {
        c.set_topics(
            &st,
            &v(&format!(
                r#"{{"courseId":"{course_id}","revision":{revision},"topicIds":{ids}}}"#
            )),
            A,
            now(),
        )
    };
    assert_eq!(
        code(set(r#"["99999999-9999-4999-8999-999999999999"]"#)),
        "academy.topic_not_found"
    );
    let ids = format!(r#"["{}"]"#, s(&risk, "id"));
    let filed = set(&ids).unwrap();
    same(at_path(&filed, "topics"), &Json::Array(vec![risk.clone()]));
    assert_eq!(n(&filed, "course.revision"), revision + 1);
    matches(
        at_path(&filed, "events.0"),
        &format!(r#"{{"kind":"topics","actor":"{A}"}}"#),
    );
    same(&set(&ids).unwrap(), &filed);
    assert_eq!(code(set("[]")), "academy.course_revision_stale");
}
