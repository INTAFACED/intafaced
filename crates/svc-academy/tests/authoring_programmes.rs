//! `curriculum/programmes.db.test.ts` (AC-programmes-01) against a real Postgres, and the parts of
//! `curriculum/programmes.test.ts` this slice owns (the catalog, and the spine video's metadata left null).
//!
//! The learner's enrolments and completions are the learner slice's calls (`enrolCourse`, `markCurriculumComplete`,
//! `undoCurriculumComplete`); the rows those calls leave are written here as they leave them (`cert_enrollments`,
//! `cert_item_completions`, and an undo's delete of the completion). The certificate a completion issues in the
//! TypeScript is then issued by the programme read, once, with the same business key.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::authoring_kit;

use authoring_kit::{TestDb, at, code, equals, matches, s, same, store, v};
use service_kit::json::Json;
use svc_academy::authoring::{programmes, video};
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const OPERATOR: &str = "44444444-4444-4444-8444-444444444444";
const T0: &str = "2026-10-24T12:00:00.000Z";
const COURSES: &str = r#"["markets","builder","sovereign"]"#;
const CERT: &str = "programme:trader-path";

fn t0() -> i64 {
    at(T0)
}

/// `save(academy, over)`: the fields replaced from `over` (JSON object text without braces).
fn save(st: &Store, max: Option<i64>, over: &[(&str, &str)], at_ms: i64) -> Result<Json, Refusal> {
    let mut fields: Vec<(String, String)> = [
        ("slug", r#""trader-path""#),
        ("title", r#""TEST Trader path""#),
        ("summary", r#""TEST three courses""#),
        ("courseSlugs", COURSES),
        ("expectedRevision", "null"),
        ("reason", r#""TEST a programme""#),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    for (k, val) in over {
        if let Some(slot) = fields.iter_mut().find(|(f, _)| f == k) {
            slot.1 = (*val).to_owned();
        }
    }
    let body = fields
        .iter()
        .map(|(k, val)| format!(r#""{k}":{val}"#))
        .collect::<Vec<_>>()
        .join(",");
    programmes::save(st, &v(&format!("{{{body}}}")), OPERATOR, at_ms, max)
}

fn enrol(db: &TestDb, user: &str, path: &str) {
    db.client()
        .execute(
            "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) VALUES ($1::text::uuid, $2::text, $3::text::timestamptz)",
            &[&user, &path, &T0],
        )
        .unwrap();
}

/// `finish(academy, course)`: enrolled, then every item of the path complete.
fn finish(db: &TestDb, path: &str, user: &str) {
    enrol(db, user, path);
    for row in spine::list(Some(path), None) {
        db.client()
            .execute(
                "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES ($1::text::uuid, $2::text, $3::text::timestamptz) ON CONFLICT DO NOTHING",
                &[&user, &row.slug, &T0],
            )
            .unwrap();
    }
}

fn read(st: &Store, user: &str) -> Json {
    programmes::programme(st, user, "trader-path", t0()).unwrap()
}

fn counts(j: &Json) -> String {
    j.get("counts").unwrap().compact()
}

#[test]
fn saves_a_programme_as_revision_1_with_its_courses_in_order_and_one_event_row_a_repeat_writes_nothing()
 {
    let Some((db, st)) = store() else { return };
    let first = save(&st, Some(4), &[], t0()).unwrap();
    matches(
        &first,
        &format!(r#"{{"slug":"trader-path","courseSlugs":{COURSES},"revision":1}}"#),
    );
    same(&save(&st, Some(4), &[], t0()).unwrap(), &first);
    assert_eq!(
        db.texts("SELECT revision || '|' || array_to_string(course_slugs, ',') || '|' || operator_id::text || '|' || reason FROM academy.programme_events"),
        [format!("1|markets,builder,sovereign|{OPERATOR}|TEST a programme")]
    );
}

#[test]
fn replaces_the_courses_over_the_revision_read_and_refuses_a_stale_revision_or_a_taken_address() {
    let Some((_db, st)) = store() else { return };
    save(&st, Some(4), &[], t0()).unwrap();
    let two = [
        ("courseSlugs", r#"["builder","markets"]"#),
        ("expectedRevision", "1"),
    ];
    let second = save(&st, Some(4), &two, t0()).unwrap();
    matches(
        &second,
        r#"{"courseSlugs":["builder","markets"],"revision":2}"#,
    );
    // The reply was lost and staff send the same save again over revision 1: it answers the stored programme.
    same(&save(&st, Some(4), &two, t0()).unwrap(), &second);
    assert_eq!(
        code(save(
            &st,
            Some(4),
            &[("title", r#""TEST late""#), ("expectedRevision", "1")],
            t0()
        )),
        "academy.revision_stale"
    );
    assert_eq!(
        code(save(&st, Some(4), &[("title", r#""TEST another""#)], t0())),
        "academy.programme_slug_taken"
    );
    assert_eq!(
        code(save(
            &st,
            Some(4),
            &[("slug", r#""nowhere""#), ("expectedRevision", "1")],
            t0()
        )),
        "academy.programme_not_found"
    );
}

#[test]
fn refuses_a_save_with_courses_while_the_owner_limit_is_blank_past_the_limit_and_at_a_reserved_address()
 {
    let Some((db, st)) = store() else { return };
    assert_eq!(
        code(save(&st, None, &[], t0())),
        "academy.programme_limit_unset"
    );
    // A programme with no course needs no limit: it is shown with its empty state.
    matches(
        &save(
            &st,
            None,
            &[("slug", r#""empty-path""#), ("courseSlugs", "[]")],
            t0(),
        )
        .unwrap(),
        r#"{"courseSlugs":[]}"#,
    );
    assert_eq!(
        code(save(&st, Some(2), &[], t0())),
        "academy.programme_too_large"
    );
    assert_eq!(
        code(save(&st, Some(4), &[("slug", r#""invitations""#)], t0())),
        "academy.slug_reserved"
    );
    assert_eq!(
        db.texts("SELECT slug FROM academy.programmes"),
        ["empty-path"]
    );
}

#[test]
fn counts_completed_enrolled_and_not_enrolled_as_the_learner_goes_and_issues_the_certificate_once_at_the_end()
 {
    let Some((db, st)) = store() else { return };
    save(&st, Some(4), &[], t0()).unwrap();
    assert_eq!(
        counts(&read(&st, USER)),
        r#"{"completed":0,"enrolled":0,"notEnrolled":3}"#
    );
    enrol(&db, USER, "markets");
    assert_eq!(
        counts(&read(&st, USER)),
        r#"{"completed":0,"enrolled":1,"notEnrolled":2}"#
    );
    // The learner slice's completion of a whole path ends its enrolment's count as enrolled: completed wins.
    for row in spine::list(Some("markets"), None) {
        db.client()
            .execute(
                "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES ($1::text::uuid, $2::text, $3::text::timestamptz)",
                &[&USER, &row.slug, &T0],
            )
            .unwrap();
    }
    assert_eq!(
        counts(&read(&st, USER)),
        r#"{"completed":1,"enrolled":0,"notEnrolled":2}"#
    );
    finish(&db, "builder", USER);
    equals(
        read(&st, USER).get("certificate").unwrap(),
        &format!(r#"{{"state":"not_earned","certId":"{CERT}"}}"#),
    );
    finish(&db, "sovereign", USER);
    let done = read(&st, USER);
    assert_eq!(
        counts(&done),
        r#"{"completed":3,"enrolled":0,"notEnrolled":0}"#
    );
    match done.get("courses").unwrap() {
        Json::Array(rows) => assert_eq!(
            rows.iter().map(|r| s(r, "state")).collect::<Vec<_>>(),
            ["completed"; 3]
        ),
        _ => panic!(),
    }
    matches(
        done.get("certificate").unwrap(),
        &format!(r#"{{"state":"earned","certId":"{CERT}","status":"valid"}}"#),
    );
    // Issued once; every later read answers the same grant.
    same(&read(&st, USER), &done);
    assert_eq!(
        db.texts(&format!("SELECT cert_id || '|' || idempotency_key FROM academy.cert_grants WHERE user_id = '{USER}'")),
        [format!("{CERT}|cert:{USER}:{CERT}")]
    );
    // Another learner's counts are their own.
    assert_eq!(
        counts(&read(&st, OTHER)),
        r#"{"completed":0,"enrolled":0,"notEnrolled":3}"#
    );
    // The public check (certVerify, the certs slice's) finds the grant by its public id.
    let public_id = s(&done, "certificate.publicId");
    assert_eq!(
        db.texts(&format!("SELECT cert_id || '|' || status FROM academy.cert_grants WHERE public_id::text = '{public_id}'")),
        [format!("{CERT}|valid")]
    );
}

#[test]
fn issues_on_the_next_read_when_the_completion_could_not_and_an_undo_after_the_issue_keeps_the_certificate()
 {
    let Some((db, st)) = store() else { return };
    for course in ["markets", "builder", "sovereign"] {
        finish(&db, course, USER);
    }
    // The programme was made after the learner finished: no completion issued it, the read does.
    save(&st, Some(4), &[], t0()).unwrap();
    let first = read(&st, USER);
    assert_eq!(s(&first, "certificate.state"), "earned");
    let last = spine::list(Some("sovereign"), None)
        .last()
        .unwrap()
        .slug
        .clone();
    db.client()
        .execute(
            "DELETE FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = $2::text",
            &[&USER, &last],
        )
        .unwrap();
    let after = read(&st, USER);
    assert_eq!(authoring_kit::n(&after, "counts.completed"), 2);
    same(
        after.get("certificate").unwrap(),
        first.get("certificate").unwrap(),
    );
}

#[test]
fn lists_programmes_newest_first_up_to_the_limit_an_empty_programme_with_no_counts_and_refuses_an_unknown_one()
 {
    let Some((_db, st)) = store() else { return };
    save(
        &st,
        Some(4),
        &[("slug", r#""empty-path""#), ("courseSlugs", "[]")],
        t0(),
    )
    .unwrap();
    save(&st, Some(4), &[], t0() + 1000).unwrap();
    let list = programmes::programmes(&st, USER, 1, false, t0()).unwrap();
    assert_eq!(authoring_kit::len(&list, ""), 1);
    assert_eq!(s(&list, "0.slug"), "trader-path");
    let all = programmes::programmes(&st, USER, 10, false, t0()).unwrap();
    matches(
        authoring_kit::at_path(&all, "1"),
        r#"{"slug":"empty-path","courses":[],"counts":{"completed":0,"enrolled":0,"notEnrolled":0}}"#,
    );
    assert_eq!(s(&all, "1.certificate.state"), "not_earned");
    assert_eq!(
        code(programmes::programme(&st, USER, "missing", t0())),
        "academy.programme_not_found"
    );
}

#[test]
fn lists_only_the_programmes_the_learner_started_or_holds_a_certificate_for_however_old_with_mine()
{
    let Some((db, st)) = store() else { return };
    save(
        &st,
        Some(4),
        &[
            ("slug", r#""old-path""#),
            ("courseSlugs", r#"["foundations"]"#),
        ],
        t0(),
    )
    .unwrap();
    save(&st, Some(4), &[], t0() + 1000).unwrap();
    save(
        &st,
        Some(4),
        &[("slug", r#""empty-path""#), ("courseSlugs", "[]")],
        t0() + 2000,
    )
    .unwrap();
    equals(
        &programmes::programmes(&st, USER, 10, true, t0()).unwrap(),
        "[]",
    );
    finish(&db, "foundations", USER);
    // The oldest programme is past a one-row page of everything, and still the learner's own.
    assert_eq!(
        s(
            &programmes::programmes(&st, USER, 1, false, t0()).unwrap(),
            "0.slug"
        ),
        "empty-path"
    );
    let mine = programmes::programmes(&st, USER, 10, true, t0()).unwrap();
    assert_eq!(authoring_kit::len(&mine, ""), 1);
    assert_eq!(s(&mine, "0.slug"), "old-path");
    assert_eq!(s(&mine, "0.certificate.state"), "earned");
    enrol(&db, USER, "markets");
    let mine = programmes::programmes(&st, USER, 10, true, t0()).unwrap();
    assert_eq!(
        [s(&mine, "0.slug"), s(&mine, "1.slug")],
        ["trader-path", "old-path"]
    );
    assert_eq!(authoring_kit::len(&mine, ""), 2);
}

// ── curriculum/programmes.test.ts ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn ships_an_empty_prerequisite_list_on_every_path() {
    let c = programmes::catalog();
    assert_eq!(
        c.iter().map(|d| d.slug).collect::<Vec<_>>(),
        programmes::PROGRAMME_SLUGS
    );
    assert!(c.iter().all(|d| d.prerequisites.is_empty()));
    assert_eq!(programmes::assert_catalog(&c), Ok(()));
}

#[test]
fn fails_when_a_prerequisite_slug_is_not_a_programme() {
    let bad: Vec<programmes::Definition> = programmes::PROGRAMME_SLUGS
        .iter()
        .map(|slug| programmes::Definition {
            slug,
            prerequisites: if *slug == "markets" {
                vec!["not-a-programme".to_owned()]
            } else {
                Vec::new()
            },
        })
        .collect();
    assert_eq!(
        programmes::assert_catalog(&bad),
        Err("unknown prerequisite slug: not-a-programme".to_owned())
    );
}

#[test]
fn leaves_video_metadata_null_until_the_owner_sets_it() {
    let entry = video::get("foundations-risk-first").unwrap();
    assert_eq!(entry.duration_seconds, None);
    assert_eq!(entry.thumbnail_url, None);
    assert_eq!(entry.language, None);
    assert_eq!(entry.captions_url, None);
}

// ── the certificate a read issues: failure branches ─────────────────────────────────────────────────────────────────

#[test]
fn reads_at_once_issue_one_certificate() {
    let Some((db, st)) = store() else { return };
    for course in ["markets", "builder", "sovereign"] {
        finish(&db, course, USER);
    }
    save(&st, Some(4), &[], t0()).unwrap();
    let url = db.url.clone();
    let reads: Vec<_> = (0..4)
        .map(|_| {
            let url = url.clone();
            std::thread::spawn(move || {
                let st = Store::Pool(service_kit::pg::Pool::new(&url, 2));
                programmes::programme(&st, USER, "trader-path", t0())
                    .map(|j| s(&j, "certificate.publicId"))
            })
        })
        .collect();
    // The TypeScript's insert arbitrates on (user_id, cert_id) only, so a read that loses the race on the other unique
    // key (idempotency_key) refuses with 23505, as the same statement does there. Every read that answers names the
    // one grant, and the next read answers it too.
    let mut ids: Vec<String> = Vec::new();
    for h in reads {
        match h.join().unwrap() {
            Ok(id) => ids.push(id),
            Err(Refusal::Internal { code, .. }) => assert_eq!(code.as_deref(), Some("23505")),
            Err(other) => panic!("{other:?}"),
        }
    }
    assert!(ids.iter().all(|i| *i == ids[0]), "{ids:?}");
    assert_eq!(
        db.texts(&format!(
            "SELECT cert_id FROM academy.cert_grants WHERE user_id = '{USER}'"
        )),
        [CERT]
    );
    let after = s(&read(&st, USER), "certificate.publicId");
    assert!(ids.is_empty() || ids[0] == after);
    assert_eq!(
        db.texts(&format!(
            "SELECT public_id::text FROM academy.cert_grants WHERE user_id = '{USER}'"
        )),
        [after]
    );
}

#[test]
fn a_store_that_fails_mid_read_issues_nothing_and_the_next_read_issues_once() {
    let Some((db, st)) = store() else { return };
    for course in ["markets", "builder", "sovereign"] {
        finish(&db, course, USER);
    }
    save(&st, Some(4), &[], t0()).unwrap();
    // The grant insert fails (a trigger stands in for the database refusing at that point): nothing is issued.
    db.client()
        .batch_execute(
            "CREATE FUNCTION academy.test_refuse_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST grant refused'; END $$; \
             CREATE TRIGGER test_refuse_grant BEFORE INSERT ON academy.cert_grants FOR EACH ROW EXECUTE FUNCTION academy.test_refuse_grant();",
        )
        .unwrap();
    assert!(programmes::programme(&st, USER, "trader-path", t0()).is_err());
    assert!(
        db.texts("SELECT cert_id FROM academy.cert_grants")
            .is_empty()
    );
    db.client()
        .batch_execute("DROP TRIGGER test_refuse_grant ON academy.cert_grants; DROP FUNCTION academy.test_refuse_grant();")
        .unwrap();
    assert_eq!(s(&read(&st, USER), "certificate.state"), "earned");
    assert_eq!(db.texts("SELECT cert_id FROM academy.cert_grants"), [CERT]);
}
