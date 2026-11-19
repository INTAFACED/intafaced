//! `curriculum/courses.db.test.ts` (AC-course-structure-01 and -02) against a real Postgres: a draft with a fixed slug,
//! edits over a revision, every move with who and why, publish refusing a paid course with no price and a course with
//! nothing in it, the price withdrawal, the list and the outline.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod authoring_kit;

use authoring_kit::{at, code, equals, iso, len, matches, n, s, same, store, v};
use service_kit::json::Json;
use svc_academy::authoring::courses::{CourseRecords, Limits};
use svc_academy::db::Store;

const A: &str = "33333333-3333-4333-8333-333333333333";
const B: &str = "44444444-4444-4444-8444-444444444444";
const NOW: &str = "2026-10-23T12:00:00.000Z";
const UNKNOWN: &str = "55555555-5555-4555-8555-555555555555";

fn now() -> i64 {
    at(NOW)
}

/// The `free` details, with fields replaced.
fn free(extra: &str) -> String {
    let base = r#""slug":"risk-basics","title":"Risk basics","summary":null,"thumbnailUrl":null,"pricing":"free","price":null,"priceAsset":null"#;
    if extra.is_empty() { format!("{{{base}}}") } else { format!("{{{base},{extra}}}") }
}

fn records() -> CourseRecords {
    CourseRecords { limits: Limits { max_sections: None, max_items: None } }
}

fn limited(max_sections: i64, max_items: i64) -> CourseRecords {
    CourseRecords { limits: Limits { max_sections: Some(max_sections), max_items: Some(max_items) } }
}

fn create(st: &Store, details: &str, op: &str, at_ms: i64) -> Json {
    records().create(st, &v(details), op, at_ms).unwrap()
}

// ── creating a course ───────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn saves_a_draft_at_revision_1_with_a_created_event_and_a_repeat_answers_with_the_stored_course() {
    let Some((_db, st)) = store() else { return };
    let course = create(&st, &free(""), A, now());
    matches(&course, &format!(r#"{{"slug":"risk-basics","state":"draft","revision":1,"items":0,"createdBy":"{A}"}}"#));
    same(&create(&st, &free(""), A, now() + 99_000), &course);
    let detail = records().get(&st, &s(&course, "id")).unwrap();
    equals(
        &detail.get("events").unwrap().clone(),
        &format!(
            r#"[{{"kind":"created","revision":1,"fromState":null,"toState":"draft","actor":"{A}","reason":null,"at":"{NOW}"}}]"#
        ),
    );
}

#[test]
fn refuses_a_reserved_tab_a_shipped_course_a_lesson_address_and_a_taken_slug_with_other_details() {
    let Some((_db, st)) = store() else { return };
    let r = records();
    let with_slug = |slug: &str| v(&free("").replace("risk-basics", slug));
    assert_eq!(code(r.create(&st, &with_slug("videos"), A, now())), "academy.slug_reserved");
    assert_eq!(code(r.create(&st, &with_slug("markets"), A, now())), "academy.course_slug_taken");
    assert_eq!(code(r.create(&st, &with_slug("foundations-risk-first"), A, now())), "academy.course_slug_taken");
    create(&st, &free(""), A, now());
    let another = v(&free("").replace(r#""title":"Risk basics""#, r#""title":"Another""#));
    assert_eq!(code(r.create(&st, &another, B, now())), "academy.course_slug_taken");
    // The same details from another founder are not their create: the course is someone else's.
    assert_eq!(code(r.create(&st, &v(&free("")), B, now())), "academy.course_slug_taken");
    assert_eq!(n(&r.list(&st, &v(r#"{"limit":10}"#)).unwrap(), "counts.draft"), 1);
}

// ── editing and publishing ──────────────────────────────────────────────────────────────────────────────────────────

fn edit(course_id: &str, revision: i64, extra: &str) -> String {
    let base = free("").replace(r#""pricing":"free","price":null,"priceAsset":null"#, extra);
    base.replacen('{', &format!(r#"{{"courseId":"{course_id}","revision":{revision},"#), 1)
}

#[test]
fn an_edit_goes_over_the_revision_read_a_lost_reply_repeated_answers_with_it_a_stale_one_is_refused() {
    let Some((_db, st)) = store() else { return };
    let course = create(&st, &free("").replace(r#""pricing":"free""#, r#""pricing":"paid""#), A, now());
    let id = s(&course, "id");
    let e = edit(&id, 1, r#""pricing":"paid","price":"25.50","priceAsset":"USDT""#);
    let edited = records().update(&st, &v(&e), A, now()).unwrap();
    matches(&edited, r#"{"revision":2,"price":"25.5","priceAsset":"USDT"}"#);
    same(&records().update(&st, &v(&e), A, now()).unwrap(), &edited);
    let other = e.replace(r#""title":"Risk basics""#, r#""title":"Other""#);
    assert_eq!(code(records().update(&st, &v(&other), A, now())), "academy.course_revision_stale");
    assert_eq!(code(records().update(&st, &v(&e), B, now())), "academy.course_revision_stale");
}

fn set_state(st: &Store, r: &CourseRecords, id: &str, revision: i64, reason: &str, op: &str, at_ms: i64) -> Result<Json, svc_academy::errors::Refusal> {
    r.set_state(
        st,
        &v(&format!(r#"{{"courseId":"{id}","to":"published","revision":{revision},"reason":"{reason}"}}"#)),
        op,
        at_ms,
    )
}

#[test]
fn publishing_a_paid_course_with_no_price_refuses_price_unset_and_changes_nothing() {
    let Some((_db, st)) = store() else { return };
    let course = create(&st, &free("").replace(r#""pricing":"free""#, r#""pricing":"paid""#), A, now());
    let id = s(&course, "id");
    assert_eq!(code(set_state(&st, &records(), &id, 1, "ready", A, now())), "academy.price_unset");
    let detail = records().get(&st, &id).unwrap();
    matches(&detail, r#"{"course":{"state":"draft","revision":1}}"#);
    assert_eq!(len(&detail, "events"), 1);
}

#[test]
fn publishing_a_course_with_an_empty_outline_refuses_by_name_a_stale_revision_and_an_unknown_id_are_refused() {
    let Some((_db, st)) = store() else { return };
    let id = s(&create(&st, &free(""), A, now()), "id");
    assert_eq!(code(set_state(&st, &records(), &id, 1, "ready", A, now())), "academy.course_outline_empty");
    assert_eq!(code(set_state(&st, &records(), &id, 7, "ready", A, now())), "academy.course_revision_stale");
    assert_eq!(code(records().get(&st, UNKNOWN)), "academy.course_not_found");
}

#[test]
fn the_database_itself_refuses_a_published_paid_course_with_no_price() {
    let Some((db, st)) = store() else { return };
    let id = s(&create(&st, &free("").replace(r#""pricing":"free""#, r#""pricing":"paid""#), A, now()), "id");
    let err = db
        .client()
        .execute("UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid", &[&id])
        .unwrap_err();
    assert!(format!("{err:?}").contains("courses_published_price_chk"), "{err:?}");
}

// ── withdrawing a published course's price (J-academy-01 #5) ───────────────────────────────────────────────────────

const LESSON: &str = r#"[{"title":"Week one","items":[{"kind":"lesson","title":"First lesson","indent":0,"url":null}]}]"#;

fn paid(slug: &str) -> String {
    free("")
        .replace("risk-basics", slug)
        .replace(r#""pricing":"free","price":null,"priceAsset":null"#, r#""pricing":"paid","price":"25","priceAsset":"USDT""#)
}

/// A course with a one-lesson outline, published: revision 3.
fn published(st: &Store, details: &str) -> Json {
    let w = limited(5, 20);
    let id = s(&w.create(st, &v(details), A, now()).unwrap(), "id");
    let outlined = w
        .save_outline(st, &v(&format!(r#"{{"courseId":"{id}","revision":1,"sections":{LESSON}}}"#)), A, now())
        .unwrap();
    set_state(st, &w, &id, n(&outlined, "course.revision"), "ready", A, now()).unwrap()
}

fn withdraw(st: &Store, id: &str, revision: i64, reason: &str, op: &str, at_ms: i64) -> Result<Json, svc_academy::errors::Refusal> {
    limited(5, 20).withdraw_price(st, &v(&format!(r#"{{"courseId":"{id}","revision":{revision},"reason":"{reason}"}}"#)), op, at_ms)
}

#[test]
fn takes_the_price_down_keeps_the_course_published_and_paid_writes_the_event_and_answers_a_repeat() {
    let Some((db, st)) = store() else { return };
    let course = published(&st, &paid("risk-basics"));
    matches(&course, r#"{"state":"published","revision":3,"price":"25","priceAsset":"USDT"}"#);
    let id = s(&course, "id");
    let later = now() + 60_000;
    let done = withdraw(&st, &id, 3, "price under review", B, later).unwrap();
    matches(&done, r#"{"state":"published","pricing":"paid","price":null,"priceAsset":null,"revision":4}"#);
    let stored: String = db
        .client()
        .query_one(
            "SELECT to_char(price_withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM academy.courses WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .get(0);
    assert_eq!(stored, iso(later));
    let detail = limited(5, 20).get(&st, &id).unwrap();
    equals(
        authoring_kit::at_path(&detail, "events.0"),
        &format!(
            r#"{{"kind":"price_withdrawn","revision":4,"fromState":"published","toState":"published","actor":"{B}","reason":"price under review","at":"{}"}}"#,
            iso(later)
        ),
    );
    // A lost reply asked again answers with the stored course, and writes nothing more.
    same(&withdraw(&st, &id, 3, "price under review", B, now() + 999_000).unwrap(), &done);
    assert_eq!(len(&limited(5, 20).get(&st, &id).unwrap(), "events"), len(&detail, "events"));
    // Someone else's repeat at the old revision is stale, not theirs.
    assert_eq!(code(withdraw(&st, &id, 3, "price under review", A, later)), "academy.course_revision_stale");
}

#[test]
fn withdrawal_refuses_a_draft_a_free_course_a_stale_revision_one_already_without_a_price_and_an_unknown_id() {
    let Some((_db, st)) = store() else { return };
    let w = limited(5, 20);
    let draft = s(&w.create(&st, &v(&paid("paid-draft")), A, now()).unwrap(), "id");
    assert_eq!(code(withdraw(&st, &draft, 1, "r", A, now())), "academy.course_not_editable");
    matches(&w.get(&st, &draft).unwrap(), r#"{"course":{"state":"draft","revision":1,"price":"25"}}"#);

    let free_one = s(&published(&st, &free("")), "id");
    assert_eq!(code(withdraw(&st, &free_one, 3, "r", A, now())), "academy.course_not_editable");

    let priced = s(&published(&st, &paid("paid-live")), "id");
    assert_eq!(code(withdraw(&st, &priced, 2, "r", A, now())), "academy.course_revision_stale");
    matches(&w.get(&st, &priced).unwrap(), r#"{"course":{"revision":3,"price":"25"}}"#);

    withdraw(&st, &priced, 3, "r", A, now()).unwrap();
    assert_eq!(code(withdraw(&st, &priced, 4, "again", A, now())), "academy.course_not_editable");
    assert_eq!(n(&w.get(&st, &priced).unwrap(), "course.revision"), 4);

    assert_eq!(code(withdraw(&st, UNKNOWN, 1, "r", A, now())), "academy.course_not_found");
}

#[test]
fn publishing_a_paid_course_with_no_price_still_refuses_and_the_database_still_refuses_one_without_a_withdrawal() {
    let Some((db, st)) = store() else { return };
    let w = limited(5, 20);
    let details = free("").replace("risk-basics", "paid-unpriced").replace(r#""pricing":"free""#, r#""pricing":"paid""#);
    let id = s(&w.create(&st, &v(&details), A, now()).unwrap(), "id");
    let outlined = w
        .save_outline(&st, &v(&format!(r#"{{"courseId":"{id}","revision":1,"sections":{LESSON}}}"#)), A, now())
        .unwrap();
    assert_eq!(code(set_state(&st, &w, &id, n(&outlined, "course.revision"), "go", A, now())), "academy.price_unset");
    // A withdrawn price does not open the door to publishing another unpriced course straight past the service either.
    let err = db
        .client()
        .execute("UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid", &[&id])
        .unwrap_err();
    assert!(format!("{err:?}").contains("courses_published_price_chk"), "{err:?}");
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_list_needs_a_page_size_filters_by_state_and_counts_every_state() {
    let Some((_db, st)) = store() else { return };
    let r = records();
    assert_eq!(code(r.list(&st, &v("{}"))), "academy.courses_list_limit_unset");
    equals(
        &r.list(&st, &v(r#"{"limit":5}"#)).unwrap(),
        r#"{"courses":[],"counts":{"draft":0,"published":0,"concluded":0,"archived":0,"deleted":0}}"#,
    );
    create(&st, &free(""), A, now());
    create(&st, &free("").replace("risk-basics", "risk-two"), A, now() + 1000);
    let page = r.list(&st, &v(r#"{"limit":1}"#)).unwrap();
    assert_eq!(len(&page, "courses"), 1);
    assert_eq!(s(&page, "courses.0.slug"), "risk-two");
    assert_eq!(n(&page, "counts.draft"), 2);
    assert_eq!(len(&r.list(&st, &v(r#"{"state":"published","limit":5}"#)).unwrap(), "courses"), 0);
}

// ── the outline (AC-course-structure-02) ────────────────────────────────────────────────────────────────────────────

const START: &str = r#"{"title":"Start here","items":[{"kind":"subheader","title":"Part 1","indent":0,"url":null},{"kind":"lesson","title":"Position size","indent":1,"url":null}]}"#;
const PRACTICE: &str = r#"{"title":"Practice","items":[{"kind":"link","title":"Reading list","indent":0,"url":"https://example.com/read"}]}"#;

fn outline_input(id: &str, revision: i64, sections: &str) -> String {
    format!(r#"{{"courseId":"{id}","revision":{revision},"sections":{sections}}}"#)
}

fn save(st: &Store, r: &CourseRecords, input: &str) -> Result<Json, svc_academy::errors::Refusal> {
    r.save_outline(st, &v(input), A, now())
}

#[test]
fn blank_limits_refuse_the_save_before_anything_is_read_or_written() {
    let Some((_db, st)) = store() else { return };
    let id = s(&create(&st, &free(""), A, now()), "id");
    let both = format!("[{START},{PRACTICE}]");
    assert_eq!(code(save(&st, &records(), &outline_input(&id, 1, &both))), "academy.outline_limits_unset");
    let half = CourseRecords { limits: Limits { max_sections: Some(2), max_items: None } };
    assert_eq!(code(save(&st, &half, &outline_input(&id, 1, &both))), "academy.outline_limits_unset");
    assert_eq!(len(&records().get(&st, &id).unwrap(), "outline"), 0);
}

#[test]
fn saves_sections_of_typed_items_in_order_subheaders_are_not_counted_a_repeat_answers_too_large_refuses() {
    let Some((_db, st)) = store() else { return };
    let id = s(&create(&st, &free(""), A, now()), "id");
    let l = limited(2, 3);
    let both = format!("[{START},{PRACTICE}]");
    let saved = save(&st, &l, &outline_input(&id, 1, &both)).unwrap();
    matches(&saved, r#"{"course":{"revision":2,"items":2}}"#);
    equals(saved.get("limits").unwrap(), r#"{"maxSections":2,"maxItems":3}"#);
    let shape: Vec<String> = match saved.get("outline").unwrap() {
        Json::Array(sections) => sections
            .iter()
            .map(|sec| {
                let items: Vec<String> = match sec.get("items").unwrap() {
                    Json::Array(items) => items
                        .iter()
                        .map(|i| format!("{}:{}:{}", s(i, "kind"), s(i, "title"), n(i, "indent")))
                        .collect(),
                    _ => panic!(),
                };
                format!("{}=[{}]", s(sec, "title"), items.join(","))
            })
            .collect(),
        _ => panic!(),
    };
    assert_eq!(shape, ["Start here=[subheader:Part 1:0,lesson:Position size:1]", "Practice=[link:Reading list:0]"]);
    matches(authoring_kit::at_path(&saved, "events.0"), &format!(r#"{{"kind":"outline","revision":2,"actor":"{A}"}}"#));
    let again = save(&st, &l, &outline_input(&id, 1, &both)).unwrap();
    assert_eq!(n(&again, "course.revision"), 2);
    assert_eq!(code(save(&st, &l, &outline_input(&id, 1, &format!("[{START}]")))), "academy.course_revision_stale");
    assert_eq!(
        code(save(&st, &l, &outline_input(&id, 2, &format!("[{START},{PRACTICE},{PRACTICE}]")))),
        "academy.outline_too_large"
    );
    assert_eq!(n(&records().get(&st, &id).unwrap(), "course.revision"), 2);
    // The item limit counts what a learner can open, as the desk's item count does: two more subheaders fit under 3.
    let labels = r#"{"title":"Start here","items":[{"kind":"subheader","title":"Part 1","indent":0,"url":null},{"kind":"lesson","title":"Position size","indent":1,"url":null},{"kind":"subheader","title":"Part 1","indent":0,"url":null}]}"#;
    let with_labels = save(&st, &l, &outline_input(&id, 2, &format!("[{labels},{PRACTICE}]"))).unwrap();
    matches(&with_labels, r#"{"course":{"revision":3,"items":2}}"#);
    assert_eq!(len(&with_labels, "outline.0.items"), 3);
}

#[test]
fn a_course_with_items_publishes_with_its_reason_a_paid_one_still_needs_its_price_first() {
    let Some((_db, st)) = store() else { return };
    let id = s(&create(&st, &free("").replace(r#""pricing":"free""#, r#""pricing":"paid""#), A, now()), "id");
    let l = limited(2, 3);
    let both = format!("[{START},{PRACTICE}]");
    save(&st, &l, &outline_input(&id, 1, &both)).unwrap();
    assert_eq!(code(set_state(&st, &records(), &id, 2, "ready", A, now())), "academy.price_unset");
    records()
        .update(&st, &v(&edit(&id, 2, r#""pricing":"paid","price":"10","priceAsset":"USDT""#)), A, now())
        .unwrap();
    let published = set_state(&st, &records(), &id, 3, "ready", A, now()).unwrap();
    matches(&published, r#"{"state":"published","revision":4,"items":2}"#);
    same(&set_state(&st, &records(), &id, 3, "ready", A, now()).unwrap(), &published);
    matches(
        authoring_kit::at_path(&records().get(&st, &id).unwrap(), "events.0"),
        r#"{"kind":"state","fromState":"draft","toState":"published","reason":"ready"}"#,
    );
    assert_eq!(code(save(&st, &l, &outline_input(&id, 4, &both))), "academy.course_not_editable");
}
