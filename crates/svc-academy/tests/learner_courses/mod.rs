//! What the learner's course tests share (`course-preview.db.test.ts`, `course-learners.db.test.ts`): a course staff
//! made, seeded as the authoring desk stores it (`CourseRecords.create`, `saveOutline`, `LessonRecords.save` and
//! `publish`, `setState`), and every academy table's row count.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

use postgres::Client;
use svc_academy::errors::Refusal;

pub const A: &str = "33333333-3333-4333-8333-333333333333";
pub const B: &str = "44444444-4444-4444-8444-444444444444";
pub const L: &str = "55555555-5555-4555-8555-555555555555";
pub const NOW_ISO: &str = "2026-10-23T12:00:00.000Z";
pub const LATER_ISO: &str = "2026-10-23T13:00:00.000Z";
pub const NOW: i64 = 1_792_756_800_000;
pub const LATER: i64 = NOW + 3_600_000;

pub const COURSE: &str = "c0000000-0000-4000-8000-000000000001";
pub const SECTION: &str = "c0000000-0000-4000-8000-000000000002";
pub const SUBHEADER: &str = "c0000000-0000-4000-8000-000000000003";
pub const LESSON: &str = "c0000000-0000-4000-8000-000000000004";
pub const LINK: &str = "c0000000-0000-4000-8000-000000000005";

/// A draft course `risk-basics` with one section `Start here`: a subheader, a lesson and a link (`draftWithOutline`).
pub fn draft_with_outline(c: &mut Client) {
    c.batch_execute(&format!(
        "INSERT INTO academy.courses (id, slug, title, summary, thumbnail_url, pricing, price, price_asset, state, revision, \
           created_by, created_at, updated_at) \
         VALUES ('{COURSE}', 'risk-basics', 'Risk basics', NULL, NULL, 'free', NULL, NULL, 'draft', 2, '{A}', '{NOW_ISO}', '{NOW_ISO}'); \
         INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at) \
         VALUES ('{COURSE}', 1, 'created', NULL, 'draft', '{A}', NULL, '{NOW_ISO}'), \
                ('{COURSE}', 2, 'outline', 'draft', 'draft', '{A}', NULL, '{NOW_ISO}'); \
         INSERT INTO academy.course_sections (id, course_id, position, title) VALUES ('{SECTION}', '{COURSE}', 0, 'Start here'); \
         INSERT INTO academy.course_items (id, course_id, section_id, position, kind, title, indent, url) VALUES \
           ('{SUBHEADER}', '{COURSE}', '{SECTION}', 0, 'subheader', 'Part 1', 0, NULL), \
           ('{LESSON}', '{COURSE}', '{SECTION}', 1, 'lesson', 'Position size', 0, NULL), \
           ('{LINK}', '{COURSE}', '{SECTION}', 2, 'link', 'Reading', 0, 'https://example.com/read');"
    ))
    .unwrap();
}

/// The lesson saved at revision 1 and published (`LessonRecords.save`, then `publish`).
pub fn publish_lesson(c: &mut Client) {
    c.batch_execute(&format!(
        "INSERT INTO academy.lesson_revisions (item_id, revision, source, blocks, actor, at) \
         VALUES ('{LESSON}', 1, 'saved', '[{{\"type\":\"text\",\"markdown\":\"One\"}}]', '{A}', '{NOW_ISO}'); \
         INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at) \
         VALUES ('{COURSE}', 3, 'lesson', 'draft', 'draft', '{A}', 'TEST', '{NOW_ISO}'); \
         UPDATE academy.course_items SET live_revision = 1, live_course_revision = 3 WHERE id = '{LESSON}'; \
         UPDATE academy.courses SET revision = 3 WHERE id = '{COURSE}';"
    ))
    .unwrap();
}

/// The course moved to published (`setState`).
pub fn publish_course(c: &mut Client) {
    c.batch_execute(&format!(
        "INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at) \
         VALUES ('{COURSE}', 4, 'state', 'draft', 'published', '{A}', 'TEST', '{NOW_ISO}'); \
         UPDATE academy.courses SET state = 'published', revision = 4, updated_at = '{NOW_ISO}' WHERE id = '{COURSE}';"
    ))
    .unwrap();
}

/// The draft with its lesson live, then published (`published()`).
pub fn published(c: &mut Client) {
    draft_with_outline(c);
    publish_lesson(c);
    publish_course(c);
}

/// Every academy table's row count, to prove a read wrote nothing.
pub fn counts(c: &mut Client) -> Vec<(String, i32)> {
    let tables: Vec<String> = c
        .query(
            "SELECT table_name::text FROM information_schema.tables \
             WHERE table_schema = 'academy' AND table_type = 'BASE TABLE' ORDER BY 1",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    tables
        .into_iter()
        .map(|t| {
            let n: i32 = c
                .query_one(&format!("SELECT count(*)::int FROM academy.\"{t}\""), &[])
                .unwrap()
                .get(0);
            (t, n)
        })
        .collect()
}

/// A refusal's code (`rejects.toMatchObject({ code })`).
pub fn code(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.code.clone(),
        other => panic!("not an AcademyError: {other:?}"),
    }
}
