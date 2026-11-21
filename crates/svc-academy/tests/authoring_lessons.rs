//! `curriculum/lessons.db.test.ts` (AC-course-structure-03 and -04) against a real Postgres: revisions of ordered
//! blocks, revert, publish to learners, duplicate, outline saves that keep an item (and its lesson) by id, the import and
//! the authoring assistant.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod authoring_kit;

use authoring_kit::{
    at, at_path, code, equals, is_null, len, matches, message, n, s, same, store, v,
};
use service_kit::json::Json;
use svc_academy::authoring::courses::{CourseRecords, Limits};
use svc_academy::authoring::lessons::Lessons;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

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

const FREE: &str =
    r#""summary":null,"thumbnailUrl":null,"pricing":"free","price":null,"priceAsset":null"#;

struct Draft {
    course: Json,
    section: Json,
    subheader: Json,
    lesson: Json,
    link: Json,
}

/// A draft course with one section: a subheader, a lesson and a link.
fn draft_with_outline(st: &Store) -> Draft {
    let c = courses();
    let course = c
        .create(
            st,
            &v(&format!(
                r#"{{"slug":"risk-basics","title":"Risk basics",{FREE}}}"#
            )),
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
        section: at_path(&detail, "outline.0").clone(),
        subheader: at_path(&detail, "outline.0.items.0").clone(),
        lesson: at_path(&detail, "outline.0.items.1").clone(),
        link: at_path(&detail, "outline.0.items.2").clone(),
    }
}

fn save(
    l: &Lessons<'_>,
    item: &str,
    revision: i64,
    blocks: &str,
    op: &str,
    t: i64,
) -> Result<Json, Refusal> {
    l.save(
        &v(&format!(
            r#"{{"itemId":"{item}","revision":{revision},"blocks":{blocks}}}"#
        )),
        op,
        t,
    )
}

fn publish(
    l: &Lessons<'_>,
    item: &str,
    lesson_revision: i64,
    course_revision: i64,
    reason: &str,
    t: i64,
) -> Result<Json, Refusal> {
    l.publish(
        &v(&format!(
            r#"{{"itemId":"{item}","lessonRevision":{lesson_revision},"courseRevision":{course_revision},"reason":"{reason}"}}"#
        )),
        A,
        t,
    )
}

fn duplicate(l: &Lessons<'_>, item: &str, course_revision: i64, t: i64) -> Result<Json, Refusal> {
    l.duplicate(
        &v(&format!(
            r#"{{"itemId":"{item}","courseRevision":{course_revision}}}"#
        )),
        A,
        t,
    )
}

fn pairs(j: &Json, path: &str, fields: &[&str]) -> Vec<String> {
    match at_path(j, path) {
        Json::Array(rows) => rows
            .iter()
            .map(|r| {
                fields
                    .iter()
                    .map(|f| r.get(f).map_or("?".to_owned(), Json::compact))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect(),
        other => panic!("{}", other.compact()),
    }
}

/// `{ id, kind, title, indent, url }` of an item.
fn keep(i: &Json) -> Json {
    Json::obj([
        ("id", i.get("id").unwrap().clone()),
        ("kind", i.get("kind").unwrap().clone()),
        ("title", i.get("title").unwrap().clone()),
        ("indent", i.get("indent").unwrap().clone()),
        ("url", i.get("url").unwrap().clone()),
    ])
}

fn with(j: &Json, key: &str, value: Json) -> Json {
    match j {
        Json::Object(f) => {
            let mut f = f.clone();
            match f.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => f.push((key.to_owned(), value)),
            }
            Json::Object(f)
        }
        _ => panic!(),
    }
}

fn outline_save(
    c: &CourseRecords,
    st: &Store,
    course_id: &str,
    revision: i64,
    sections: &Json,
) -> Result<Json, Refusal> {
    let input = Json::obj([
        ("courseId", Json::str(course_id)),
        ("revision", Json::int(revision)),
        ("sections", sections.clone()),
    ]);
    c.save_outline(st, &v(&input.compact()), A, now())
}

// ── lesson revisions (AC-course-structure-03) ───────────────────────────────────────────────────────────────────────

#[test]
fn every_save_is_a_new_revision_a_repeat_answers_with_it_an_old_read_is_stale_a_label_or_a_link_holds_no_lesson()
 {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    let first = save(&l, &id, 0, &text("One"), A, now()).unwrap();
    matches(
        &first,
        r#"{"item":{"lessonRevision":1,"liveRevision":null}}"#,
    );
    assert_eq!(
        pairs(&first, "revisions", &["revision", "source"]),
        [r#"1,"saved""#]
    );
    same(&save(&l, &id, 0, &text("One"), A, later()).unwrap(), &first);
    assert_eq!(
        code(save(&l, &id, 0, &text("Other"), A, now())),
        "academy.revision_stale"
    );
    assert_eq!(
        code(save(&l, &id, 0, &text("One"), B, now())),
        "academy.revision_stale"
    );
    for item in [&d.subheader, &d.link] {
        assert_eq!(
            code(save(&l, &s(item, "id"), 0, &text("x"), A, now())),
            "academy.item_has_no_lesson"
        );
    }
}

#[test]
fn learners_keep_the_published_revision_while_staff_edit_republish_moves_them_revert_makes_a_new_revision()
 {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    let course_revision = n(&d.course, "revision");
    save(&l, &id, 0, &text("Live words"), A, now()).unwrap();
    let live = publish(&l, &id, 1, course_revision, "first cut", now()).unwrap();
    assert_eq!(n(&live, "item.liveRevision"), 1);
    assert_eq!(n(&live, "courseRevision"), course_revision + 1);
    // A repeat after a lost reply answers with the same state; nothing moves twice.
    same(
        &publish(&l, &id, 1, course_revision, "first cut", later()).unwrap(),
        &live,
    );
    let edited = save(&l, &id, 1, &text("Draft words"), A, now()).unwrap();
    matches(&edited, r#"{"item":{"lessonRevision":2,"liveRevision":1}}"#);
    let reverted = l
        .revert(
            &v(&format!(
                r#"{{"itemId":"{id}","revision":2,"toRevision":1}}"#
            )),
            A,
            now(),
        )
        .unwrap();
    assert_eq!(
        pairs(
            &reverted,
            "revisions",
            &["revision", "source", "fromRevision"]
        ),
        [
            r#"3,"reverted",1"#,
            r#"2,"saved",null"#,
            r#"1,"saved",null"#
        ]
    );
    equals(
        at_path(&reverted, "revisions.0.blocks"),
        &text("Live words"),
    );
    assert_eq!(
        code(l.revert(
            &v(&format!(
                r#"{{"itemId":"{id}","revision":3,"toRevision":9}}"#
            )),
            A,
            now()
        )),
        "academy.lesson_revision_unknown"
    );
    let live_rev = n(&live, "courseRevision");
    let republished = publish(&l, &id, 2, live_rev, "second cut", now()).unwrap();
    assert_eq!(n(&republished, "item.liveRevision"), 2);
    matches(
        at_path(&c.get(&st, &s(&d.course, "id")).unwrap(), "events.0"),
        &format!(r#"{{"kind":"lesson","actor":"{A}","reason":"second cut"}}"#),
    );
    assert_eq!(
        code(publish(&l, &id, 3, live_rev, "old read", now())),
        "academy.course_revision_stale"
    );
}

#[test]
fn an_outline_save_keeps_an_item_and_its_lesson_by_id_an_id_from_another_course_is_refused() {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    let course_id = s(&d.course, "id");
    save(&l, &id, 0, &text("Kept"), A, now()).unwrap();
    let sections = Json::Array(vec![
        Json::obj([
            ("title", Json::str("First")),
            (
                "items",
                Json::Array(vec![with(
                    &keep(&d.lesson),
                    "title",
                    Json::str("Position size, renamed"),
                )]),
            ),
        ]),
        Json::obj([
            ("id", d.section.get("id").unwrap().clone()),
            ("title", Json::str("Start here")),
            (
                "items",
                Json::Array(vec![keep(&d.link), keep(&d.subheader)]),
            ),
        ]),
    ]);
    let moved = outline_save(&c, &st, &course_id, n(&d.course, "revision"), &sections).unwrap();
    assert_eq!(
        pairs(&moved, "outline.0.items", &["id", "title"]),
        [format!(r#""{id}","Position size, renamed""#)]
    );
    assert_eq!(
        pairs(&moved, "outline.1.items", &["id", "title"]),
        [
            format!(r#""{}","Reading""#, s(&d.link, "id")),
            format!(r#""{}","Part 1""#, s(&d.subheader, "id"))
        ]
    );
    assert_eq!(s(&moved, "outline.1.id"), s(&d.section, "id"));
    equals(
        at_path(&l.get(&id).unwrap(), "revisions.0.blocks"),
        &text("Kept"),
    );
    let foreign = Json::Array(vec![Json::obj([
        ("title", Json::str("x")),
        (
            "items",
            Json::Array(vec![v_json(
                r#"{"id":"55555555-5555-4555-8555-555555555555","kind":"lesson","title":"x","indent":0,"url":null}"#,
            )]),
        ),
    ])]);
    let moved_rev = n(&moved, "course.revision");
    assert_eq!(
        code(outline_save(&c, &st, &course_id, moved_rev, &foreign)),
        "academy.outline_item_unknown"
    );
    // Dropping the item from the outline deletes it with its lesson.
    let only_link = Json::Array(vec![Json::obj([
        ("id", d.section.get("id").unwrap().clone()),
        ("title", Json::str("Start here")),
        ("items", Json::Array(vec![keep(&d.link)])),
    ])]);
    outline_save(&c, &st, &course_id, moved_rev, &only_link).unwrap();
    assert_eq!(code(l.get(&id)), "academy.outline_item_unknown");
}

fn v_json(t: &str) -> Json {
    service_kit::json::parse(t).unwrap()
}

#[test]
fn a_duplicate_copies_the_item_and_its_newest_lesson_right_after_it_not_live_and_with_no_learner_record()
 {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    save(&l, &id, 0, &text("One"), A, now()).unwrap();
    let live = publish(&l, &id, 1, n(&d.course, "revision"), "go", now()).unwrap();
    save(&l, &id, 1, &text("Two"), A, now()).unwrap();
    let copy = duplicate(&l, &id, n(&live, "courseRevision"), later()).unwrap();
    matches(
        &copy,
        r#"{"item":{"kind":"lesson","title":"Position size","lessonRevision":1,"liveRevision":null}}"#,
    );
    equals(
        at_path(&copy, "revisions"),
        &format!(
            r#"[{{"revision":1,"source":"duplicated","fromRevision":null,"fromItemId":"{id}","blocks":{},"actor":"{A}","at":"{LATER}"}}]"#,
            text("Two")
        ),
    );
    same(
        &duplicate(&l, &id, n(&live, "courseRevision"), later()).unwrap(),
        &copy,
    );
    let detail = c.get(&st, &s(&d.course, "id")).unwrap();
    let ids: Vec<String> = pairs(&detail, "outline.0.items", &["id"]);
    assert_eq!(
        ids,
        [
            format!(r#""{}""#, s(&d.subheader, "id")),
            format!(r#""{id}""#),
            format!(r#""{}""#, s(&copy, "item.id")),
            format!(r#""{}""#, s(&d.link, "id")),
        ]
    );
    matches(
        at_path(&detail, "events.0"),
        &format!(r#"{{"kind":"outline","actor":"{A}"}}"#),
    );
    // The item limit (3 a learner opens) is now full: lesson, copy and link.
    assert_eq!(
        code(duplicate(&l, &id, n(&detail, "course.revision"), now())),
        "academy.outline_too_large"
    );
}

#[test]
fn a_course_duplicate_is_a_draft_at_its_own_address_with_the_outline_and_newest_lessons_and_no_learner_record()
 {
    let Some((db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    let course_id = s(&d.course, "id");
    save(&l, &id, 0, &text("One"), A, now()).unwrap();
    let live = publish(&l, &id, 1, n(&d.course, "revision"), "go", now()).unwrap();
    save(&l, &id, 1, &text("Two"), A, now()).unwrap();
    let published = c
        .set_state(
            &st,
            &v(&format!(
                r#"{{"courseId":"{course_id}","to":"published","revision":{},"reason":"open"}}"#,
                n(&live, "courseRevision")
            )),
            A,
            now(),
        )
        .unwrap();
    assert_eq!(s(&published, "state"), "published");
    // A learner is enrolled on the source: the record a duplicate must leave behind.
    let learner = "55555555-5555-4555-8555-555555555555";
    db.client()
        .execute(
            "INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at) VALUES ($1::text::uuid, $2::text::uuid, 'audit', $3::text::timestamptz)",
            &[&course_id, &learner, &NOW],
        )
        .unwrap();
    let input = |course: &str, slug: &str, reason: &str| {
        v(&format!(
            r#"{{"courseId":"{course}","slug":"{slug}","title":"Risk basics again","reason":"{reason}"}}"#
        ))
    };
    let copy = c
        .duplicate(
            &st,
            &input(&course_id, "risk-basics-copy", "next cohort"),
            A,
            later(),
        )
        .unwrap();
    matches(
        &copy,
        &format!(
            r#"{{"slug":"risk-basics-copy","title":"Risk basics again","state":"draft","revision":1,"items":2,"createdBy":"{A}"}}"#
        ),
    );
    let detail = c.get(&st, &s(&copy, "id")).unwrap();
    let source = c.get(&st, &course_id).unwrap();
    let shape = |j: &Json| pairs(j, "outline.0.items", &["kind", "title", "indent", "url"]);
    assert_eq!(shape(&detail), shape(&source));
    assert_eq!(len(&detail, "outline"), len(&source, "outline"));
    assert_eq!(s(&detail, "outline.0.title"), s(&source, "outline.0.title"));
    let source_ids = pairs(&source, "outline.0.items", &["id"]);
    assert!(
        pairs(&detail, "outline.0.items", &["id"])
            .iter()
            .all(|i| !source_ids.contains(i))
    );
    equals(
        at_path(&detail, "events"),
        &format!(
            r#"[{{"kind":"created","revision":1,"fromState":null,"toState":"draft","actor":"{A}","reason":"duplicated from risk-basics: next cohort","at":"{LATER}"}}]"#
        ),
    );
    // The copied lesson starts at revision 1 with the newest words, and nothing is live on it.
    let copied = l.get(&s(&detail, "outline.0.items.1.id")).unwrap();
    matches(
        &copied,
        r#"{"item":{"title":"Position size","lessonRevision":1,"liveRevision":null}}"#,
    );
    equals(
        at_path(&copied, "revisions"),
        &format!(
            r#"[{{"revision":1,"source":"duplicated","fromRevision":null,"fromItemId":"{id}","blocks":{},"actor":"{A}","at":"{LATER}"}}]"#,
            text("Two")
        ),
    );
    // No learner record on the copy; the source keeps its learner.
    assert_eq!(
        db.texts("SELECT course_id::text FROM academy.course_enrolments"),
        std::slice::from_ref(&course_id)
    );
    // The source is unchanged.
    same(
        at_path(&c.get(&st, &course_id).unwrap(), "course"),
        at_path(&source, "course"),
    );
    // A repeat after a lost reply answers with the stored copy; anyone else at that address is a taken slug.
    same(
        &c.duplicate(
            &st,
            &input(&course_id, "risk-basics-copy", "next cohort"),
            A,
            later(),
        )
        .unwrap(),
        &copy,
    );
    assert_eq!(
        code(c.duplicate(
            &st,
            &input(&course_id, "risk-basics-copy", "next cohort"),
            B,
            later()
        )),
        "academy.course_slug_taken"
    );
    assert_eq!(
        code(c.duplicate(
            &st,
            &input(&course_id, "risk-basics-copy", "other"),
            A,
            later()
        )),
        "academy.course_slug_taken"
    );
    assert_eq!(
        code(c.duplicate(&st, &input(&course_id, "videos", "next cohort"), A, later())),
        "academy.slug_reserved"
    );
    assert_eq!(
        code(c.duplicate(
            &st,
            &input(
                "66666666-6666-4666-8666-666666666666",
                "nowhere-copy",
                "next cohort"
            ),
            A,
            later()
        )),
        "academy.course_not_found"
    );
}

#[test]
fn review_findings_image_replay_another_items_publish_a_lessonless_duplicate_replay_kind_lock() {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    // jsonb reorders keys; a repeat of an image block still answers with its own revision.
    let image = r#"[{"type":"image","url":"https://example.com/a.png","alt":"A chart"}]"#;
    let saved = save(&l, &id, 0, image, A, now()).unwrap();
    same(&save(&l, &id, 0, image, A, later()).unwrap(), &saved);
    // A second lesson item, published; then a stale publish of it over the first item's publish is refused.
    let copy = duplicate(&l, &id, n(&d.course, "revision"), now()).unwrap();
    let copy_id = s(&copy, "item.id");
    let first = publish(
        &l,
        &copy_id,
        1,
        n(&copy, "courseRevision"),
        "copy live",
        now(),
    )
    .unwrap();
    let other = publish(
        &l,
        &id,
        1,
        n(&first, "courseRevision"),
        "source live",
        now(),
    )
    .unwrap();
    assert_eq!(
        code(publish(
            &l,
            &copy_id,
            1,
            n(&first, "courseRevision"),
            "stale tab",
            now()
        )),
        "academy.course_revision_stale"
    );
    // A subheader duplicates (with no lesson), and a repeat after a lost reply finds that copy.
    let sub = s(&d.subheader, "id");
    let label = duplicate(&l, &sub, n(&other, "courseRevision"), now()).unwrap();
    matches(
        &label,
        r#"{"item":{"kind":"subheader","lessonRevision":null}}"#,
    );
    same(
        &duplicate(&l, &sub, n(&other, "courseRevision"), later()).unwrap(),
        &label,
    );
    // An item with a lesson does not become a link.
    let course_id = s(&d.course, "id");
    let detail = c.get(&st, &course_id).unwrap();
    let items: Vec<Json> = match at_path(&detail, "outline.0.items") {
        Json::Array(a) => a
            .iter()
            .map(|i| {
                let k = keep(i);
                if s(i, "id") == id {
                    with(
                        &with(&k, "kind", Json::str("link")),
                        "url",
                        Json::str("https://example.com"),
                    )
                } else {
                    k
                }
            })
            .collect(),
        _ => panic!(),
    };
    let sections = Json::Array(vec![Json::obj([
        ("id", d.section.get("id").unwrap().clone()),
        ("title", Json::str("Start here")),
        ("items", Json::Array(items)),
    ])]);
    assert_eq!(
        code(outline_save(
            &c,
            &st,
            &course_id,
            n(&detail, "course.revision"),
            &sections
        )),
        "academy.item_kind_locked"
    );
    assert_eq!(s(&d.link, "kind"), "link");
}

#[test]
fn the_live_revision_is_in_the_read_even_when_50_newer_revisions_are_saved_after_it() {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    save(&l, &id, 0, &text("Live"), A, now()).unwrap();
    publish(&l, &id, 1, n(&d.course, "revision"), "go", now()).unwrap();
    for r in 1..=51 {
        save(&l, &id, r, &text(&format!("Draft {r}")), A, now()).unwrap();
    }
    let read = l.get(&id).unwrap();
    assert_eq!(len(&read, "revisions"), 51);
    assert_eq!(n(&read, "revisions.0.revision"), 52);
    matches(
        at_path(&read, "revisions.50"),
        &format!(r#"{{"revision":1,"blocks":{}}}"#, text("Live")),
    );
    assert_eq!(n(&read, "item.liveRevision"), 1);
}

// ── lesson import (AC-course-structure-03) ──────────────────────────────────────────────────────────────────────────

fn file(blocks: &str) -> String {
    Json::str(format!(
        r#"{{"format":"intafaced.lesson.v1","blocks":{blocks}}}"#
    ))
    .compact()
}

fn import(l: &Lessons<'_>, item: &str, document_json: &str, t: i64) -> Result<Json, Refusal> {
    l.import(
        &v(&format!(
            r#"{{"itemId":"{item}","revision":0,"document":{document_json}}}"#
        )),
        A,
        t,
    )
}

#[test]
fn a_blank_size_limit_refuses_a_file_over_it_refuses_before_it_is_parsed_nothing_is_created() {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let id = s(&d.lesson, "id");
    let blank = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    assert_eq!(
        code(import(&blank, &id, r#""{}""#, now())),
        "academy.import_limit_unset"
    );
    // Not JSON at all, and over the limit: the size answers first, so the file was never parsed.
    let small = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: Some(64),
    };
    assert_eq!(
        code(import(
            &small,
            &id,
            &Json::str("x".repeat(65)).compact(),
            now()
        )),
        "academy.import_too_large"
    );
    assert_eq!(len(&blank.get(&id).unwrap(), "revisions"), 0);
}

#[test]
fn an_unknown_block_and_a_bad_block_are_each_listed_and_nothing_is_created_a_good_file_is_a_new_revision()
 {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let id = s(&d.lesson, "id");
    let importer = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: Some(8192),
    };
    let bad = import(
        &importer,
        &id,
        &file(
            r#"[{"type":"text","markdown":"Fine"},{"type":"iframe","src":"https://example.com"},{"type":"image","url":"javascript:alert(1)","alt":"x"}]"#,
        ),
        now(),
    )
    .unwrap();
    assert_eq!(s(&bad, "outcome"), "invalid");
    assert_eq!(pairs(&bad, "problems", &["block"]), ["2", "3"]);
    assert_eq!(
        s(&bad, "problems.0.problem"),
        r#"unknown block type "iframe""#
    );
    assert_eq!(len(&bad, "lesson.revisions"), 0);
    for document in [
        Json::str("not json").compact(),
        Json::str(r#"{"format":"other","blocks":[]}"#).compact(),
    ] {
        let r = import(&importer, &id, &document, now()).unwrap();
        assert_eq!(s(&r, "outcome"), "invalid");
        assert_eq!(len(&r, "problems"), 1);
        assert!(is_null(&r, "problems.0.block"));
    }
    let good = file(r#"[{"type":"code","language":"python","source":"size = risk / stop"}]"#);
    let done = import(&importer, &id, &good, now()).unwrap();
    assert_eq!(s(&done, "outcome"), "imported");
    assert_eq!(
        pairs(&done, "lesson.revisions", &["revision", "source"]),
        [r#"1,"imported""#]
    );
    same(&import(&importer, &id, &good, later()).unwrap(), &done);
    assert_eq!(n(&done, "lesson.importMaxBytes"), 8192);
}

// ── the authoring assistant (AC-course-structure-04) ────────────────────────────────────────────────────────────────

fn assist(
    l: &Lessons<'_>,
    item: &str,
    revision: i64,
    path: &str,
    op: &str,
    t: i64,
) -> Result<Json, Refusal> {
    l.assistant_draft(
        &v(&format!(
            r#"{{"itemId":"{item}","revision":{revision},"path":"{path}"}}"#
        )),
        op,
        t,
    )
}

fn decide(
    l: &Lessons<'_>,
    item: &str,
    based_on: i64,
    decision: &str,
    op: &str,
    t: i64,
) -> Result<Json, Refusal> {
    l.decide_draft(
        &v(&format!(r#"{{"itemId":"{item}","basedOnRevision":{based_on},"kind":"template","decision":"{decision}"}}"#)),
        op,
        t,
    )
}

#[test]
fn the_model_path_waits_for_an_owner_decision_the_template_draft_is_stored_and_goes_nowhere_until_accepted()
 {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    save(&l, &id, 0, &text("Live"), A, now()).unwrap();
    publish(&l, &id, 1, n(&d.course, "revision"), "go", now()).unwrap();
    match assist(&l, &id, 1, "model", A, now()) {
        Err(Refusal::OwnerDecision { .. }) => {}
        other => panic!("expected owner.decision, got {other:?}"),
    }
    let drafted = assist(&l, &id, 1, "template", A, now()).unwrap();
    matches(
        &drafted,
        &format!(r#"{{"draft":{{"basedOnRevision":1,"kind":"template","createdBy":"{A}"}}}}"#),
    );
    equals(
        at_path(&drafted, "draft.blocks.0"),
        &Json::obj([
            ("type", Json::str("text")),
            (
                "markdown",
                Json::str("# Position size\n\nPart of “Start here” in “Risk basics”."),
            ),
        ])
        .compact(),
    );
    let last = len(&drafted, "draft.blocks") - 1;
    equals(
        at_path(&drafted, &format!("draft.blocks.{last}")),
        &Json::obj([
            ("type", Json::str("text")),
            ("markdown", Json::str("## In this section\n\n- Reading")),
        ])
        .compact(),
    );
    // Nothing moved: no revision was written and learners see revision 1.
    assert_eq!(pairs(&drafted, "revisions", &["revision"]), ["1"]);
    assert_eq!(n(&drafted, "item.liveRevision"), 1);
    // A repeat answers with the same draft.
    same(
        &assist(&l, &id, 1, "template", B, later()).unwrap(),
        &drafted,
    );
    let accepted = decide(&l, &id, 1, "accept", B, later()).unwrap();
    assert!(is_null(&accepted, "draft"));
    matches(
        at_path(&accepted, "revisions.0"),
        &format!(
            r#"{{"revision":2,"source":"assisted","actor":"{B}","blocks":{}}}"#,
            at_path(&drafted, "draft.blocks").compact()
        ),
    );
    assert_eq!(n(&accepted, "item.liveRevision"), 1);
    same(
        &decide(&l, &id, 1, "accept", B, later()).unwrap(),
        &accepted,
    );
    assert_eq!(
        code(decide(&l, &id, 1, "discard", B, later())),
        "academy.draft_not_found"
    );
}

#[test]
fn a_section_of_200_long_titled_items_drafts_reads_and_accepts_inside_the_block_limit() {
    let Some((_db, st)) = store() else { return };
    let big = CourseRecords {
        limits: Limits {
            max_sections: Some(5),
            max_items: Some(250),
        },
    };
    let course = big
        .create(
            &st,
            &v(&format!(
                r#"{{"slug":"long-section","title":"Long section",{FREE}}}"#
            )),
            A,
            now(),
        )
        .unwrap();
    let title = |i: usize| format!("{i:03} {}", "x".repeat(116));
    let items: Vec<Json> = (0..200)
        .map(|i| {
            Json::obj([
                ("kind", Json::str("lesson")),
                ("title", Json::String(title(i))),
                ("indent", Json::int(0)),
                ("url", Json::Null),
            ])
        })
        .collect();
    let sections = Json::Array(vec![Json::obj([
        ("title", Json::str("Everything")),
        ("items", Json::Array(items)),
    ])]);
    let detail = outline_save(&big, &st, &s(&course, "id"), 1, &sections).unwrap();
    let item = s(&detail, "outline.0.items.0.id");
    let records = Lessons {
        pool: &st,
        courses: &big,
        import_max_bytes: None,
    };
    let drafted = assist(&records, &item, 0, "template", A, now()).unwrap();
    let last = len(&drafted, "draft.blocks") - 1;
    let section = at_path(&drafted, &format!("draft.blocks.{last}"));
    assert_eq!(s(section, "type"), "text");
    let markdown = s(section, "markdown");
    assert!(markdown.encode_utf16().count() <= 20_000);
    assert!(markdown.contains(&format!("- {}", title(50))));
    assert!(!markdown.contains(&title(51)));
    assert!(markdown.ends_with("- and 149 more"));
    same(
        at_path(&records.get(&item).unwrap(), "draft"),
        at_path(&drafted, "draft"),
    );
    let accepted = decide(&records, &item, 0, "accept", A, later()).unwrap();
    matches(
        at_path(&accepted, "revisions.0"),
        &format!(
            r#"{{"revision":1,"source":"assisted","blocks":{}}}"#,
            at_path(&drafted, "draft.blocks").compact()
        ),
    );
}

#[test]
fn a_stored_draft_over_the_block_limit_is_refused_by_name_on_accept_and_writes_no_revision() {
    let Some((db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    db.client()
        .execute(
            "INSERT INTO academy.lesson_drafts (item_id, based_on_revision, kind, blocks, state, created_by, created_at) \
             VALUES ($1::text::uuid, 0, 'template', $2::text::jsonb, 'open', $3::text::uuid, $4::text::timestamptz)",
            &[&id, &text(&"x".repeat(20_001)), &A, &NOW],
        )
        .unwrap();
    assert_eq!(
        code(decide(&l, &id, 0, "accept", A, now())),
        "academy.lesson_blocks_invalid"
    );
    // The TypeScript reads the class back; here the read carries the router's output check, which answers an
    // over-limit stored draft as tRPC does (500, output validation). What the assertion holds is read from the rows:
    // no revision was written, and the draft is still stored, open, at revision 0.
    assert_eq!(
        db.texts(&format!(
            "SELECT revision::text FROM academy.lesson_revisions WHERE item_id = '{id}'"
        )),
        Vec::<String>::new()
    );
    assert_eq!(
        db.texts(&format!("SELECT based_on_revision || ':' || kind || ':' || state FROM academy.lesson_drafts WHERE item_id = '{id}'")),
        ["0:template:open"]
    );
    assert!(message(l.get(&id)).contains("Output validation failed"));
}

#[test]
fn a_draft_from_an_old_revision_is_not_accepted_over_newer_words_it_can_be_discarded() {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    assist(&l, &id, 0, "template", A, now()).unwrap();
    let saved = save(&l, &id, 0, &text("Mine"), A, now()).unwrap();
    // The old draft is no longer offered to accept.
    assert!(is_null(&saved, "draft"));
    assert_eq!(
        code(decide(&l, &id, 0, "accept", A, now())),
        "academy.revision_stale"
    );
    let discarded = decide(&l, &id, 0, "discard", A, now()).unwrap();
    assert!(is_null(&discarded, "draft"));
    assert_eq!(pairs(&discarded, "revisions", &["source"]), [r#""saved""#]);
    assert_eq!(
        code(assist(&l, &id, 0, "template", A, now())),
        "academy.revision_stale"
    );
}

#[test]
fn after_a_discard_asking_for_the_template_draft_again_drafts_it_again() {
    let Some((_db, st)) = store() else { return };
    let d = draft_with_outline(&st);
    let c = courses();
    let l = Lessons {
        pool: &st,
        courses: &c,
        import_max_bytes: None,
    };
    let id = s(&d.lesson, "id");
    assist(&l, &id, 0, "template", A, now()).unwrap();
    decide(&l, &id, 0, "discard", A, now()).unwrap();
    let again = assist(&l, &id, 0, "template", B, later()).unwrap();
    matches(
        &again,
        r#"{"draft":{"basedOnRevision":0,"kind":"template"}}"#,
    );
}
