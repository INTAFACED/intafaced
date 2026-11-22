//! The authoring side of `release/access.test.ts` and `release/access.db.test.ts` (AC-release-access): the rules a
//! release is set with (`findPrerequisiteCycle`, `normalizePrerequisites`, `clearedOrWindow`, `requireExtensionReason`,
//! `assertExtensionExtends`, `releaseOpensAt`), and `setItemPrerequisites`, `setItemWindow` and `itemRelease` over
//! Postgres. `decideRelease`, `refuseRelease` and the item body's lock are the curriculum slice's, in
//! `curriculum_release.rs`. `markCurriculumComplete` and `grantItemExtension` are the learner and staff calls of other
//! slices; the rows they leave (`cert_item_completions`, `item_extensions`) are written here as they leave them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::authoring_kit;

use authoring_kit::{TestDb, at, code, iso, matches, store, v};
use service_kit::json::Json;
use svc_academy::authoring::release;
use svc_academy::curriculum::gates::Window;
use svc_academy::db::Store;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const OPERATOR: &str = "33333333-3333-4333-8333-333333333333";
const FIRST: &str = "foundations-risk-first";
const SECOND: &str = "foundations-order-types";
const THIRD: &str = "foundations-fees-are-real";
const DAY: i64 = 86_400_000;

fn edges(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

fn w(from: &str, until: &str, due: Option<&str>) -> Window {
    Window {
        from: at(from),
        until: at(until),
        due: due.map(at),
    }
}

const FROM: &str = "2026-10-01T00:00:00.000Z";
const UNTIL: &str = "2026-10-20T00:00:00.000Z";
const DUE: &str = "2026-10-15T00:00:00.000Z";

// ── release/access.test.ts: the rules ───────────────────────────────────────────────────────────────────────────────

#[test]
fn refuses_a_prerequisite_cycle_a_to_b_to_a() {
    assert_eq!(
        release::find_cycle(&edges(&[(SECOND, FIRST), (FIRST, SECOND)])),
        Some(vec![SECOND.to_owned(), FIRST.to_owned(), SECOND.to_owned()])
    );
}

#[test]
fn accepts_a_one_way_prerequisite() {
    assert_eq!(release::find_cycle(&edges(&[(SECOND, FIRST)])), None);
}

#[test]
fn refuses_a_self_prerequisite_before_a_write() {
    assert_eq!(
        code(release::normalize_prerequisites(FIRST, &[FIRST])),
        "academy.prerequisite_cycle"
    );
}

#[test]
fn refuses_an_availability_end_that_is_not_after_the_start() {
    assert_eq!(
        code(release::cleared_or_window(
            Some(at(UNTIL)),
            Some(at(FROM)),
            None
        )),
        "academy.window_invalid"
    );
}

#[test]
fn refuses_a_window_with_only_one_end() {
    assert_eq!(
        code(release::cleared_or_window(Some(at(FROM)), None, None)),
        "academy.window_invalid"
    );
}

#[test]
fn clears_a_window_only_when_start_end_and_due_are_all_absent() {
    assert_eq!(release::cleared_or_window(None, None, None).unwrap(), None);
    assert_eq!(
        code(release::cleared_or_window(None, None, Some(at(DUE)))),
        "academy.window_invalid"
    );
}

#[test]
fn refuses_an_extension_with_no_reason_and_keeps_a_trimmed_reason() {
    assert_eq!(
        code(release::require_extension_reason("   ")),
        "academy.reason_required"
    );
    assert_eq!(
        release::require_extension_reason("  late start  ").unwrap(),
        "late start"
    );
}

#[test]
fn an_extension_must_pass_the_due() {
    assert_eq!(
        code(release::assert_extension_extends(
            w(FROM, UNTIL, Some(DUE)),
            at("2026-10-14T00:00:00.000Z")
        )),
        "academy.window_invalid"
    );
    release::assert_extension_extends(w(FROM, UNTIL, Some(DUE)), at("2026-10-18T00:00:00.000Z"))
        .unwrap();
}

#[test]
fn opens_at_the_later_of_the_window_and_the_course_start() {
    let start = at("2026-10-30T09:00:00.000Z");
    let before = at("2026-10-29T09:00:00.000Z");
    let opens =
        |window: Option<Window>| release::release_opens_at(window, None, Some(start), before);
    assert_eq!(opens(None), Some(start));
    let later = "2026-11-05T00:00:00.000Z";
    assert_eq!(
        opens(Some(w(later, "2026-12-01T00:00:00.000Z", None))),
        Some(at(later))
    );
    // A window that has already closed keeps its own (past) start: no opening is promised.
    let closed = w(FROM, UNTIL, None);
    assert_eq!(opens(Some(closed)), Some(at(FROM)));
    assert_eq!(
        release::release_opens_at(Some(closed), None, None, before),
        Some(at(FROM))
    );
    // A window that ends before the course starts never opens, so it gets no date; an extension past the start gives it one.
    let short = w("2026-10-29T12:00:00.000Z", "2026-10-30T00:00:00.000Z", None);
    assert_eq!(opens(Some(short)), None);
    assert_eq!(
        release::release_opens_at(
            Some(short),
            Some(at("2026-11-02T00:00:00.000Z")),
            Some(start),
            before
        ),
        Some(start)
    );
}

// ── release/access.db.test.ts: over Postgres ────────────────────────────────────────────────────────────────────────

fn now() -> i64 {
    svc_academy::door::system_now().0
}

fn prerequisites(
    st: &Store,
    item: &str,
    pre: &[&str],
) -> Result<Json, svc_academy::errors::Refusal> {
    let list = Json::Array(pre.iter().map(|p| Json::str(*p)).collect()).compact();
    release::set_item_prerequisites(
        st,
        &v(&format!(
            r#"{{"itemSlug":"{item}","prerequisites":{list}}}"#
        )),
    )
}

fn window(st: &Store, item: &str, from: i64, until: i64, due: Option<i64>) {
    let due = due.map_or("null".to_owned(), |d| format!(r#""{}""#, iso(d)));
    release::set_item_window(
        st,
        &v(&format!(
            r#"{{"itemSlug":"{item}","availableFrom":"{}","availableUntil":"{}","dueAt":{due}}}"#,
            iso(from),
            iso(until)
        )),
    )
    .unwrap();
}

fn item_release(st: &Store, user: &str, item: &str, t: i64) -> Json {
    release::item_release(st, user, item, t).unwrap().json()
}

fn complete(db: &TestDb, user: &str, item: &str) {
    db.client()
        .execute(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES ($1::text::uuid, $2::text, now())",
            &[&user, &item],
        )
        .unwrap();
}

#[test]
fn a_prerequisite_locks_the_item_until_the_one_it_requires_is_complete_and_completed_shows_no_window()
 {
    let Some((db, st)) = store() else { return };
    prerequisites(&st, SECOND, &[FIRST]).unwrap();
    matches(
        &item_release(&st, USER, SECOND, now()),
        &format!(r#"{{"state":"locked","lock":"prerequisite","missing":["{FIRST}"]}}"#),
    );
    complete(&db, USER, FIRST);
    complete(&db, USER, SECOND);
    matches(
        &item_release(&st, USER, SECOND, now()),
        r#"{"state":"completed","availableFrom":null,"availableUntil":null,"dueAt":null,"extendedUntil":null,"reason":null,"grantedAt":null,"grantedBy":null}"#,
    );
}

#[test]
fn rolls_back_a_prerequisite_cycle_and_keeps_the_earlier_edge() {
    let Some((db, st)) = store() else { return };
    prerequisites(&st, SECOND, &[FIRST]).unwrap();
    assert_eq!(
        code(prerequisites(&st, FIRST, &[SECOND])),
        "academy.prerequisite_cycle"
    );
    matches(
        &item_release(&st, USER, SECOND, now()),
        &format!(r#"{{"lock":"prerequisite","missing":["{FIRST}"]}}"#),
    );
    matches(
        &item_release(&st, USER, FIRST, now()),
        r#"{"lock":null,"availableFrom":null,"availableUntil":null,"dueAt":null}"#,
    );
    assert!(
        db.texts(&format!(
            "SELECT prerequisite_slug FROM academy.item_prerequisites WHERE item_slug = '{FIRST}'"
        ))
        .is_empty()
    );
}

#[test]
fn locks_a_closed_window_and_one_extension_opens_it_for_that_learner_only() {
    let Some((db, st)) = store() else { return };
    let t = now();
    let (open, shut) = (t - DAY, t - 3_600_000);
    window(&st, THIRD, open, shut, Some(shut));
    window(&st, SECOND, open, shut, None);
    matches(
        &item_release(&st, USER, THIRD, t),
        r#"{"state":"locked","lock":"window"}"#,
    );
    let extended = t + DAY;
    // `grantItemExtension(...)`: the row the staff call leaves.
    db.client()
        .execute(
            "INSERT INTO academy.item_extensions (user_id, item_slug, revision, reason, extended_until, client_request_id, granted_by, granted_at) \
             VALUES ($1::text::uuid, $2::text, 1, 'TEST late start', $3::text::timestamptz, 'ext-1', $4::text::uuid, $5::text::timestamptz)",
            &[&USER, &THIRD, &iso(extended), &OPERATOR, &iso(t)],
        )
        .unwrap();
    matches(
        &item_release(&st, USER, THIRD, t),
        &format!(
            r#"{{"state":"unlocked","lock":null,"availableFrom":"{}","availableUntil":"{}","dueAt":"{}","extendedUntil":"{}","reason":"TEST late start","grantedBy":"{OPERATOR}","grantedAt":"{}"}}"#,
            iso(open),
            iso(shut),
            iso(shut),
            iso(extended),
            iso(t)
        ),
    );
    matches(
        &item_release(&st, OTHER, THIRD, t),
        &format!(
            r#"{{"state":"locked","lock":"window","availableFrom":"{}","availableUntil":"{}","dueAt":"{}","extendedUntil":null,"reason":null,"grantedAt":null,"grantedBy":null}}"#,
            iso(open),
            iso(shut),
            iso(shut)
        ),
    );
}
