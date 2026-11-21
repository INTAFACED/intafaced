//! An assignment's brief and the work an enrolled learner hands in, against a real Postgres: the port of
//! `curriculum/assignments.db.test.ts` (AC-assignments-01), assertion for assertion. The course, its outline and the
//! enrolment are another slice's calls; they are written here as the rows those calls leave. The object store is the
//! TypeScript test's `put`, in memory (`support::MemoryObjects`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use service_kit::json::Json;
use support::{MemoryObjects, TestDb, at, base64, code_of, enrol, jp, seed_course, test_storage};
use svc_academy::assessment::assignments::{self, BriefInput, Files};
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const OUTSIDER: &str = "66666666-6666-4666-8666-666666666666";
const NOW_ISO: &str = "2026-10-23T12:00:00.000Z";
const DUE: &str = "2026-10-24T12:00:00.000Z";
const AFTER_DUE: &str = "2026-10-25T12:00:00.000Z";
const PDF: &[u8] = b"%PDF-1.4\nTEST\n%%EOF\n";
const PNG_BYTES: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

fn t(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

fn now() -> i64 {
    t(NOW_ISO)
}

fn s(v: &str) -> Json {
    Json::str(v)
}

#[derive(Clone, Copy)]
struct Brief<'a> {
    points: &'a str,
    due_at: Option<&'a str>,
    text: &'a str,
    file: &'a str,
}

const BRIEF: Brief<'static> = Brief {
    points: "10",
    due_at: Some(DUE),
    text: "required",
    file: "required",
};

fn brief_input(b: Brief<'_>) -> BriefInput<'_> {
    BriefInput {
        instructions: "Size one trade.",
        points: b.points,
        due_at: b.due_at,
        text: b.text,
        file: b.file,
    }
}

struct Open {
    db: TestDb,
    store: Store,
    objects: MemoryObjects,
    course: String,
    item: String,
    saved: Json,
}

impl Open {
    /// `assignments(limits)`: the owner's limits, the test store and its bytes.
    fn files(&self, max_bytes: Option<i64>, types: Option<&[&str]>) -> Files<'_> {
        Files {
            storage: Some(test_storage()),
            max_bytes,
            types: types.map(|ts| ts.iter().map(|t| (*t).to_owned()).collect()),
            bytes: &self.objects,
        }
    }

    fn default_files(&self) -> Files<'_> {
        self.files(Some(1024), Some(&["application/pdf", "image/png"]))
    }

    fn submit(
        &self,
        version: i64,
        text: Option<&str>,
        file: Option<&str>,
        user: &str,
        at_ms: i64,
    ) -> Result<Json, Refusal> {
        assignments::submit(
            &self.store,
            &self.default_files(),
            &self.item,
            version,
            text,
            file,
            user,
            at_ms,
        )
    }

    fn counts(&self) -> (i32, i32) {
        let row = self
            .db
            .client()
            .query_one(
                "SELECT (SELECT count(*)::int FROM academy.assignment_submissions), (SELECT count(*)::int FROM academy.assignment_files)",
                &[],
            )
            .unwrap();
        (row.get(0), row.get(1))
    }
}

/// A free course with one assignment item, its brief saved, published, and learner L enrolled.
fn open_assignment(brief: Brief<'_>) -> Option<Open> {
    let db = TestDb::migrated()?;
    let mut c = db.client();
    let seeded = seed_course(
        &mut c,
        "risk-basics",
        "draft",
        A,
        NOW_ISO,
        &[("assignment", "Write-up")],
    );
    let store = Store::Pool(db.pool());
    let item = seeded.items[0].clone();
    let saved = assignments::save(&store, &item, 0, &brief_input(brief), A, now()).unwrap();
    c.execute(
        "UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid",
        &[&seeded.id],
    )
    .unwrap();
    enrol(&mut c, &seeded.id, L, NOW_ISO);
    Some(Open {
        db,
        store,
        objects: MemoryObjects::new(),
        course: seeded.id,
        item,
        saved,
    })
}

macro_rules! need {
    ($e:expr) => {
        match $e {
            Some(f) => f,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── an assignment brief on the founder console ──────────────────────────────────────────────────────────────────────

#[test]
fn a_brief_saves_over_the_revision_read_and_refuses_a_stale_one() {
    let o = need!(open_assignment(BRIEF));
    assert_eq!(at(&o.saved, "revision"), Json::int(1));
    assert_eq!(at(&o.saved, "brief.points"), s("10"));
    assert_eq!(at(&o.saved, "brief.dueAt"), s(DUE));
    assert_eq!(at(&o.saved, "brief.text"), s("required"));
    assert_eq!(at(&o.saved, "brief.file"), s("required"));
    assert_eq!(at(&o.saved, "savedBy"), s(A));
    assert_eq!(
        code_of(assignments::save(
            &o.store,
            &o.item,
            0,
            &brief_input(BRIEF),
            A,
            now()
        )),
        "academy.revision_stale"
    );
    let next = assignments::save(
        &o.store,
        &o.item,
        1,
        &brief_input(Brief {
            points: "12.50",
            ..BRIEF
        }),
        A,
        now(),
    )
    .unwrap();
    assert_eq!(at(&next, "brief.points"), s("12.5"));
}

#[test]
fn an_item_with_no_brief_is_not_an_assignment_a_learner_can_open() {
    let Some(db) = TestDb::migrated() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let mut c = db.client();
    let seeded = seed_course(
        &mut c,
        "no-brief",
        "draft",
        A,
        NOW_ISO,
        &[("assignment", "Write-up")],
    );
    let store = Store::Pool(db.pool());
    let item = &seeded.items[0];
    assert_eq!(
        at(&assignments::admin_view(&store, item).unwrap(), "brief"),
        Json::Null
    );
    let objects = MemoryObjects::new();
    let files = Files {
        storage: Some(test_storage()),
        max_bytes: Some(1024),
        types: Some(vec!["application/pdf".to_owned()]),
        bytes: &objects,
    };
    assert_eq!(
        code_of(assignments::learner_view(&store, &files, item, L, now())),
        "academy.assignment_not_found"
    );
}

// ── handing in work ─────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn text_without_the_required_file_is_refused_as_incomplete_and_nothing_is_recorded() {
    let o = need!(open_assignment(BRIEF));
    let refused = o.submit(1, Some("My answer"), None, L, now());
    match &refused {
        Err(Refusal::Academy(e)) => {
            assert_eq!(e.code, "academy.submission_incomplete");
            assert!(e.message.contains("missing=file"), "{}", e.message);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(o.counts(), (0, 0));
    assert_eq!(
        at(
            &assignments::learner_view(&o.store, &o.default_files(), &o.item, L, now()).unwrap(),
            "nextVersion"
        ),
        Json::int(1)
    );
}

#[test]
fn text_and_a_file_hand_in_once_and_the_same_version_again_returns_the_stored_hand_in() {
    let o = need!(open_assignment(BRIEF));
    let upload = || {
        assignments::upload_file(
            &o.store,
            &o.default_files(),
            &o.item,
            "sizing.pdf",
            "application/pdf",
            &base64(PDF),
            L,
            now(),
        )
    };
    let file = upload().unwrap();
    let stored = o.objects.stored();
    assert_eq!(stored.len(), 1);
    assert!(
        stored[0].0.contains(&format!("/submissions/{L}/")),
        "{}",
        stored[0].0
    );
    // The same file again is the same row, and is not stored a second time.
    assert_eq!(at(&upload().unwrap(), "id"), at(&file, "id"));
    assert_eq!(o.objects.stored().len(), 1);
    let file_id = match at(&file, "id") {
        Json::String(id) => id,
        other => panic!("{other:?}"),
    };
    let first = o
        .submit(1, Some("My answer"), Some(&file_id), L, now())
        .unwrap();
    let again = o.submit(1, Some("Other"), None, L, now()).unwrap();
    assert_eq!(again, first);
    assert_eq!(
        at(&first, "submissions"),
        jp(&format!(
            r#"[{{"version":1,"state":"submitted","text":"My answer",
                "file":{{"id":"{file_id}","fileName":"sizing.pdf","contentType":"application/pdf","bytes":{}}},
                "submittedAt":"{NOW_ISO}","late":false}}]"#,
            PDF.len()
        ))
    );
    assert_eq!(at(&first, "nextVersion"), Json::int(2));
    assert_eq!(o.counts(), (1, 1));
    // A version that skips ahead is stale, never a second hand-in.
    assert_eq!(
        code_of(o.submit(3, Some("x"), Some(&file_id), L, now())),
        "academy.submission_version_stale"
    );
}

#[test]
fn two_sends_of_the_same_version_at_once_record_one_hand_in_and_both_answer_with_it() {
    let o = need!(open_assignment(Brief {
        file: "off",
        ..BRIEF
    }));
    let (a, b) = std::thread::scope(|scope| {
        let one = scope.spawn(|| o.submit(1, Some("Once"), None, L, now()).unwrap());
        let two = scope.spawn(|| o.submit(1, Some("Once"), None, L, now()).unwrap());
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_eq!(a, b);
    match at(&a, "submissions") {
        Json::Array(rows) => assert_eq!(rows.len(), 1),
        other => panic!("{other:?}"),
    }
    assert_eq!(o.counts(), (1, 0));
}

#[test]
fn the_file_limit_shown_is_the_owner_limit_bounded_by_what_travels_inline() {
    let o = need!(open_assignment(BRIEF));
    let view = assignments::learner_view(&o.store, &o.default_files(), &o.item, L, now()).unwrap();
    assert_eq!(at(&view, "fileLimits.maxBytes"), Json::int(1024));
    let big = o.files(Some(500 * 1_048_576), Some(&["application/pdf"]));
    assert_eq!(
        at(
            &assignments::learner_view(&o.store, &big, &o.item, L, now()).unwrap(),
            "fileLimits.maxBytes"
        ),
        Json::int(786_432)
    );
}

#[test]
fn a_hand_in_after_the_due_date_reads_as_late_worked_out_on_read() {
    let o = need!(open_assignment(Brief {
        file: "off",
        ..BRIEF
    }));
    let view = o
        .submit(1, Some("Late answer"), None, L, t(AFTER_DUE))
        .unwrap();
    assert_eq!(at(&view, "submissions.0.version"), Json::int(1));
    assert_eq!(at(&view, "submissions.0.late"), Json::Bool(true));
    assert_eq!(at(&view, "latePolicy"), Json::Null);
    let n: i32 = o
        .db
        .client()
        .query_one(
            "SELECT count(*)::int FROM information_schema.columns \
             WHERE table_schema = 'academy' AND table_name = 'assignment_submissions' AND column_name = 'late'",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}

#[test]
fn a_learner_who_is_not_enrolled_is_refused_and_reads_nothing_of_the_brief() {
    let o = need!(open_assignment(BRIEF));
    assert_eq!(
        code_of(assignments::learner_view(
            &o.store,
            &o.default_files(),
            &o.item,
            OUTSIDER,
            now()
        )),
        "academy.enrolment_required"
    );
    assert_eq!(
        code_of(o.submit(1, Some("x"), None, OUTSIDER, now())),
        "academy.enrolment_required"
    );
    assert_eq!(
        code_of(assignments::upload_file(
            &o.store,
            &o.default_files(),
            &o.item,
            "a.pdf",
            "application/pdf",
            &base64(PDF),
            OUTSIDER,
            now()
        )),
        "academy.enrolment_required"
    );
    assert_eq!(o.counts(), (0, 0));
}

#[test]
fn a_file_is_refused_by_the_owner_limits_its_type_and_its_content() {
    let o = need!(open_assignment(BRIEF));
    let send = |content_type: &str, bytes: &[u8], files: &Files<'_>| {
        assignments::upload_file(
            &o.store,
            files,
            &o.item,
            "f",
            content_type,
            &base64(bytes),
            L,
            now(),
        )
    };
    let d = o.default_files();
    assert_eq!(
        code_of(send("application/pdf", &[0x25; 2048], &d)),
        "academy.upload_too_large"
    );
    assert_eq!(
        code_of(send("video/webm", PDF, &d)),
        "academy.upload_type_refused"
    );
    assert_eq!(
        code_of(send("application/pdf", PNG_BYTES, &d)),
        "academy.file_type_mismatch"
    );
    assert_eq!(
        code_of(send("application/pdf", PDF, &o.files(None, None))),
        "academy.upload_limits_unset"
    );
    o.objects.set_status(503);
    assert_eq!(
        code_of(send("application/pdf", PDF, &d)),
        "academy.upload_incomplete"
    );
    assert_eq!(o.counts(), (0, 0));
}

#[test]
fn withdrawn_nothing_more_is_handed_in_and_what_was_handed_in_stays_readable() {
    let o = need!(open_assignment(Brief {
        file: "off",
        ..BRIEF
    }));
    o.submit(1, Some("Kept"), None, L, now()).unwrap();
    let withdrawn = assignments::withdraw(&o.store, &o.item, "TEST", A, now()).unwrap();
    assert_eq!(at(&withdrawn, "withdrawReason"), s("TEST"));
    assert_eq!(at(&withdrawn, "learnersHandedIn"), Json::int(1));
    assert_eq!(
        code_of(o.submit(2, Some("More"), None, L, now())),
        "academy.assignment_closed"
    );
    // A retry of the stored version still answers with it.
    let retry = o.submit(1, Some("Kept"), None, L, now()).unwrap();
    assert_eq!(at(&retry, "submissions.0.text"), s("Kept"));
    assert_eq!(at(&retry, "submissions.1"), Json::Null);
    assert_eq!(at(&retry, "withdrawnAt"), s(NOW_ISO));
    assert_eq!(
        code_of(assignments::save(
            &o.store,
            &o.item,
            1,
            &brief_input(BRIEF),
            A,
            now()
        )),
        "academy.assignment_closed"
    );
    drop((o.db, o.course));
}
