//! J-academy-15: staff enrolment, invitations, course email and learner exports, against a real database
//! (`learners/staff-enrolment.db.test.ts`). Figures are TEST values, not owner settings.
//!
//! Every call runs through the door as the TypeScript test drives the router, except the learner export, whose
//! background job the TypeScript test runs by hand: here `request_learner_export` is handed a schedule that keeps the
//! task's id, and `run_export` is run on it. Enrolling oneself (`enrolCourse`) and the seat cap (`setCourseSeatCap`)
//! belong to other slices and are seeded as the rows they leave.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use crate::community_support;

use std::cell::RefCell;

use community_support::{arr, b, data, door, get, items, mutate, n, query, refused, s, setup};
use service_kit::json::Json;
use svc_academy::community::{Db, clock, learner_desk, sha256_hex, staff_enrolment};
use svc_academy::db::Store;
use svc_academy::door::AcademyDoor;

use crate::support::TestDb;

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const C: &str = "55555555-5555-4555-8555-555555555555";
const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const STAFF_SCOPES: [&str; 2] = ["admin:read", "admin:write"];

/// `TEST_LIMITS`, less the keys named.
fn limits(without: &[&str]) -> Json {
    let all = [
        ("ACADEMY_BULK_ENROL_ROWS", 5),
        ("ACADEMY_BULK_EMAIL_INACTIVE_DAYS", 30),
        ("ACADEMY_REPORT_RETENTION_HOURS", 1),
        ("ACADEMY_LEARNER_EXPORT_ROWS", 10),
    ];
    Json::Object(
        all.iter()
            .filter(|(k, _)| !without.contains(k))
            .map(|(k, v)| ((*k).to_owned(), Json::int(*v)))
            .collect(),
    )
}

fn staff_door(db: &TestDb, settings: Json) -> AcademyDoor {
    door(Store::Pool(db.pool()), settings)
}

/// What `enrolCourse` (the learner slice) leaves: an open enrolment, now.
fn enrolled(db: &TestDb, user: &str, path: &str) {
    db.client()
        .execute(
            "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) VALUES ($1::text::uuid, $2, now())",
            &[&user, &path],
        )
        .unwrap();
}

fn active_enrolments(db: &TestDb, path: &str) -> i64 {
    db.client()
        .query_one(
            "SELECT count(*)::int8 FROM academy.cert_enrollments WHERE path_slug = $1 AND left_at IS NULL",
            &[&path],
        )
        .unwrap()
        .get(0)
}

fn count(db: &TestDb, sql: &str) -> usize {
    db.client().query(sql, &[]).unwrap().len()
}

/// A staff mutation's data.
fn staff(d: &AcademyDoor, path: &str, input: &Json) -> Json {
    data(&mutate(d, STAFF, &STAFF_SCOPES, path, input))
}

/// A staff mutation's refusal code (`e.cause?.code`).
fn staff_code(d: &AcademyDoor, path: &str, input: &Json) -> String {
    refused(&mutate(d, STAFF, &STAFF_SCOPES, path, input)).2
}

fn staff_read(d: &AcademyDoor, path: &str, input: Option<&Json>) -> Json {
    data(&query(d, STAFF, &STAFF_SCOPES, path, input))
}

fn upload(rows: &[(&str, Option<&str>)]) -> Json {
    Json::Array(
        rows.iter()
            .map(|(a, u)| {
                Json::obj([
                    ("address", Json::str(*a)),
                    ("userId", u.map_or(Json::Null, Json::str)),
                ])
            })
            .collect(),
    )
}

fn bulk(rows: Json, reason: &str) -> Json {
    Json::obj([
        ("path", Json::str("foundations")),
        ("rows", rows),
        ("reason", Json::str(reason)),
    ])
}

fn text_or_null(j: &Json, key: &str) -> Option<String> {
    match get(j, key) {
        Json::Null => None,
        _ => Some(s(j, key)),
    }
}

#[test]
fn bulk_enrolment_answers_each_address_sends_no_mail_and_the_same_upload_again_changes_nothing() {
    let Some((db, _store)) = setup() else { return };
    let d = staff_door(&db, limits(&[]));
    let rows = [
        ("A@test.example", Some(A)),
        ("b@test.example ", Some(B)),
        ("nobody@test.example", None),
        ("not an address", None),
        ("a@test.example", Some(A)),
    ];
    let first = staff(&d, "admin.bulkEnrol", &bulk(upload(&rows), "TEST cohort"));
    assert_eq!(s(&first, "mail"), "none");
    assert!(!b(&first, "replayed"));
    let outcomes: Vec<(String, String, Option<String>)> = arr(&first, "rows")
        .iter()
        .map(|r| (s(r, "address"), s(r, "outcome"), text_or_null(r, "code")))
        .collect();
    let want =
        |a: &str, o: &str, c: Option<&str>| (a.to_owned(), o.to_owned(), c.map(str::to_owned));
    assert_eq!(
        outcomes,
        [
            want("a@test.example", "enrolled", None),
            want("b@test.example", "enrolled", None),
            want(
                "nobody@test.example",
                "refused",
                Some("academy.learner_not_found")
            ),
            want("not an address", "refused", Some("academy.address_invalid")),
            want(
                "a@test.example",
                "refused",
                Some("academy.duplicate_address")
            ),
        ]
    );
    assert_eq!(active_enrolments(&db, "foundations"), 2);
    let events = count(&db, "SELECT key FROM academy.staff_enrolment_events");
    let mut reversed = rows;
    reversed.reverse();
    let again = staff(
        &d,
        "admin.bulkEnrol",
        &bulk(upload(&reversed), "TEST cohort"),
    );
    assert!(b(&again, "replayed"));
    assert_eq!(get(&again, "rows"), get(&first, "rows"));
    assert_eq!(active_enrolments(&db, "foundations"), 2);
    assert_eq!(
        count(&db, "SELECT key FROM academy.staff_enrolment_events"),
        events
    );
}

#[test]
fn bulk_enrolment_refuses_a_blank_row_limit_and_an_upload_over_the_limit_before_anything_is_enrolled()
 {
    let Some((db, _store)) = setup() else { return };
    let one = upload(&[("a@test.example", Some(A))]);
    let blank = staff_door(&db, Json::obj([]));
    assert_eq!(
        staff_code(&blank, "admin.bulkEnrol", &bulk(one.clone(), "TEST")),
        "academy.bulk_limit_unset"
    );
    let d = staff_door(&db, limits(&[]));
    let addresses: Vec<String> = (0..6).map(|i| format!("p{i}@test.example")).collect();
    let six: Vec<(&str, Option<&str>)> = addresses.iter().map(|a| (a.as_str(), None)).collect();
    assert_eq!(
        staff_code(&d, "admin.bulkEnrol", &bulk(upload(&six), "TEST")),
        "academy.bulk_limit_exceeded"
    );
    assert_eq!(
        staff_code(&d, "admin.bulkEnrol", &bulk(one, "  ")),
        "academy.reason_required"
    );
    assert_eq!(active_enrolments(&db, "foundations"), 0);
}

#[test]
fn staff_enrolment_past_a_full_course_enrols_and_the_event_records_the_bypass_and_the_reason() {
    let Some((db, _store)) = setup() else { return };
    let d = staff_door(&db, limits(&[]));
    enrolled(&db, A, "foundations");
    // What `setCourseSeatCap` (another slice) leaves: a cap of one.
    db.client()
        .execute(
            "INSERT INTO academy.course_enrolment_terms (path, seat_cap, visibility, reason, set_by, set_at)
             VALUES ('foundations', 1, 'published', 'TEST cap', $1::text::uuid, now())",
            &[&STAFF],
        )
        .unwrap();
    // A learner enrolling themselves is refused for the full course (`enrolCourse` reads the same closing reasons).
    let terms = staff_enrolment::Terms {
        seat_cap: Some(1),
        opens_at: None,
        closes_at: None,
        visibility: "published".to_owned(),
    };
    assert_eq!(
        staff_enrolment::closed_reasons(&terms, 1, clock()),
        ["full"]
    );
    let enrol = |reason: &str| {
        Json::obj([
            ("path", Json::str("foundations")),
            ("userId", Json::str(B)),
            ("reason", Json::str(reason)),
        ])
    };
    let done = staff(&d, "admin.staffEnrol", &enrol("TEST bursary seat"));
    assert_eq!(s(&done, "outcome"), "enrolled");
    let event = get(&done, "event");
    assert_eq!(s(event, "userId"), B);
    assert_eq!(
        get(event, "bypassed"),
        &Json::Array(vec![Json::str("full")])
    );
    assert_eq!(s(event, "reason"), "TEST bursary seat");
    assert_eq!(s(event, "actorId"), STAFF);
    assert_eq!(s(event, "source"), "staff");
    assert_eq!(s(event, "key"), format!("enrol:foundations:{B}:1"));
    let by_path = Json::obj([("path", Json::str("foundations"))]);
    let listed = staff_read(&d, "admin.staffEnrolments", Some(&by_path));
    assert_eq!(&items(&listed)[0], event);
    // The console reads the whole list with no filter, which sends no input at all.
    assert_eq!(staff_read(&d, "admin.staffEnrolments", None), listed);
    assert_eq!(
        staff_read(&d, "admin.courseInvitations", None),
        Json::Array(vec![])
    );
    assert_eq!(
        staff_read(&d, "admin.bulkEmails", None),
        Json::Array(vec![])
    );
    let repeat = staff(&d, "admin.staffEnrol", &enrol("TEST again"));
    assert_eq!(
        repeat,
        Json::obj([
            ("outcome", Json::str("already_enrolled")),
            ("event", Json::Null)
        ])
    );
    assert_eq!(
        items(&staff_read(&d, "admin.staffEnrolments", Some(&by_path))).len(),
        1
    );
}

#[test]
fn a_read_only_session_cannot_enrol() {
    let Some((db, _store)) = setup() else { return };
    let d = staff_door(&db, limits(&[]));
    let answer = mutate(
        &d,
        STAFF,
        &["admin:read"],
        "admin.staffEnrol",
        &Json::obj([
            ("path", Json::str("foundations")),
            ("userId", Json::str(B)),
            ("reason", Json::str("TEST")),
        ]),
    );
    assert_ne!(refused(&answer).0, 200);
    assert_eq!(active_enrolments(&db, "foundations"), 0);
}

#[test]
fn invitations_keep_a_hash_and_a_masked_address_once_per_course_and_name_the_mail_step() {
    let Some((db, _store)) = setup() else { return };
    let d = staff_door(&db, limits(&[]));
    let invite = |address: &str| {
        Json::obj([
            ("path", Json::str("markets")),
            ("address", Json::str(address)),
            ("reason", Json::str("TEST")),
        ])
    };
    let made = staff(
        &d,
        "admin.inviteToCourse",
        &invite("New.Person@Test.example"),
    );
    assert_eq!(s(&made, "addressMask"), "n***@test.example");
    assert_eq!(s(&made, "mail"), "vendor.email");
    assert!(!b(&made, "replayed"));
    let again = staff(
        &d,
        "admin.inviteToCourse",
        &invite("new.person@test.example "),
    );
    assert!(b(&again, "replayed"));
    assert_eq!(s(&again, "key"), s(&made, "key"));
    let stored = db.texts("SELECT row_to_json(i)::text FROM academy.course_invitations i");
    assert_eq!(stored.len(), 1);
    assert!(!stored[0].contains("new.person"), "{}", stored[0]);
    assert_eq!(
        staff_code(&d, "admin.inviteToCourse", &invite("nope")),
        "academy.address_invalid"
    );
}

fn mail(subject: &str, body: &str) -> Json {
    Json::obj([
        ("path", Json::str("foundations")),
        ("subject", Json::str(subject)),
        ("body", Json::str(body)),
        ("key", Json::str("mail:foundations:1")),
    ])
}

#[test]
fn course_email_is_written_refused_for_the_missing_provider_and_opted_out_and_inactive_learners_are_skipped()
 {
    let Some((db, _store)) = setup() else { return };
    let d = staff_door(&db, limits(&[]));
    for u in [A, B, C] {
        enrolled(&db, u, "foundations");
    }
    let slug = Json::obj([("slug", Json::str("foundations"))]);
    data(&mutate(
        &d,
        B,
        &["academy:read", "academy:write"],
        "setCourseEmails",
        &Json::obj([
            ("slug", Json::str("foundations")),
            ("on", Json::Bool(false)),
        ]),
    ));
    assert_eq!(
        data(&query(
            &d,
            B,
            &["academy:read"],
            "courseEmails",
            Some(&slug)
        )),
        Json::obj([
            ("path", Json::str("foundations")),
            ("on", Json::Bool(false))
        ])
    );
    db.client()
        .execute(
            "UPDATE academy.cert_enrollments SET enrolled_at = now() - interval '40 days' WHERE user_id = $1::text::uuid",
            &[&C],
        )
        .unwrap();
    let sent = staff(&d, "admin.sendBulkEmail", &mail("TEST", "TEST body"));
    assert_eq!(s(&sent, "state"), "refused");
    assert_eq!(s(&sent, "refusal"), "vendor.email");
    assert_eq!(n(&sent, "inactiveDays"), 30);
    assert!(!b(&sent, "replayed"));
    let counts = get(&sent, "counts");
    assert_eq!(n(counts, "not_sent"), 1);
    assert_eq!(n(counts, "sent"), 0);
    assert_eq!(n(counts, "skipped_opted_out"), 1);
    assert_eq!(n(counts, "skipped_inactive"), 1);
    let mut states: Vec<(String, String)> = arr(&sent, "recipients")
        .iter()
        .map(|r| (s(r, "userId"), s(r, "state")))
        .collect();
    states.sort();
    let mut want = vec![
        (A.to_owned(), "not_sent".to_owned()),
        (B.to_owned(), "skipped_opted_out".to_owned()),
        (C.to_owned(), "skipped_inactive".to_owned()),
    ];
    want.sort();
    assert_eq!(states, want);
    let retry = staff(&d, "admin.sendBulkEmail", &mail("TEST", "TEST body"));
    assert!(b(&retry, "replayed"));
    assert_eq!(s(&retry, "id"), s(&sent, "id"));
    let by_path = Json::obj([("path", Json::str("foundations"))]);
    assert_eq!(
        items(&staff_read(&d, "admin.bulkEmails", Some(&by_path))).len(),
        1
    );
}

#[test]
fn course_email_refuses_a_blank_inactivity_period_before_anything_is_written() {
    let Some((db, _store)) = setup() else { return };
    let d = staff_door(&db, limits(&["ACADEMY_BULK_EMAIL_INACTIVE_DAYS"]));
    enrolled(&db, A, "foundations");
    assert_eq!(
        staff_code(&d, "admin.sendBulkEmail", &mail("TEST", "TEST")),
        "academy.inactivity_period_unset"
    );
    assert_eq!(count(&db, "SELECT id FROM academy.bulk_emails"), 0);
}

#[test]
fn course_email_refuses_a_blank_subject_or_message_by_its_own_code_before_anything_is_written() {
    let Some((db, _store)) = setup() else { return };
    let d = staff_door(&db, limits(&[]));
    enrolled(&db, A, "foundations");
    assert_eq!(
        staff_code(&d, "admin.sendBulkEmail", &mail(" ", "TEST")),
        "academy.email_incomplete"
    );
    assert_eq!(count(&db, "SELECT id FROM academy.bulk_emails"), 0);
}

#[test]
fn a_learner_export_finishes_with_only_the_tagged_learners_its_time_and_the_hash_of_its_file_a_retry_reuses_the_task()
 {
    let Some((db, store)) = setup() else { return };
    let desk = Db(&store);
    let d = staff_door(&db, limits(&[]));
    for u in [A, C, B] {
        enrolled(&db, u, "foundations");
    }
    staff(
        &d,
        "admin.tagLearners",
        &Json::obj([
            ("userIds", Json::Array(vec![Json::str(A), Json::str(C)])),
            ("tag", Json::str("test-cohort")),
            ("reason", Json::str("TEST")),
        ]),
    );
    // Run the background job by hand, so the test sees queued and then done.
    let job: RefCell<Option<String>> = RefCell::new(None);
    let schedule = |id: String| *job.borrow_mut() = Some(id);
    let set = staff_enrolment::Limits {
        bulk_enrol_rows: Some(5),
        inactive_days: Some(30),
        report_retention_hours: Some(1),
        export_rows: Some(10),
    };
    let key = "report:learners:test-cohort:1";
    let asked = staff_enrolment::request_learner_export(
        &desk,
        &set,
        Some("test-cohort"),
        key,
        STAFF,
        clock(),
        &schedule,
    )
    .unwrap();
    assert_eq!(s(&asked, "state"), "queued");
    assert!(!b(&asked, "replayed"));
    let id = s(&asked, "id");
    let file = |d: &AcademyDoor| mutate_or_query_file(d, &id);
    assert_eq!(refused(&file(&d)).2, "academy.report_not_ready");
    let queued = job.borrow_mut().take().unwrap();
    assert_eq!(queued, id);
    staff_enrolment::run_export(&db.pool(), &queued).unwrap();
    let got = data(&file(&d));
    assert_eq!(s(&got, "state"), "done");
    assert_eq!(n(&got, "rows"), 2);
    assert_ne!(get(&got, "finishedAt"), &Json::Null);
    let csv = s(&got, "csv");
    assert_eq!(s(&got, "sha256"), sha256_hex(&csv));
    let mut learners: Vec<&str> = csv
        .split('\n')
        .skip(2)
        .map(|line| line.split(',').next().unwrap())
        .collect();
    learners.sort_unstable();
    let mut want = vec![A, C];
    want.sort_unstable();
    assert_eq!(learners, want);
    let retry = staff_enrolment::request_learner_export(
        &desk,
        &set,
        Some("test-cohort"),
        key,
        STAFF,
        clock(),
        &schedule,
    )
    .unwrap();
    assert_eq!(s(&retry, "id"), id);
    assert!(b(&retry, "replayed"));
    assert!(job.borrow().is_none(), "a retry schedules nothing");
    // The tag was written through the desk the export reads.
    assert_eq!(items(&learner_desk::tags(&desk).unwrap()).len(), 1);
}

/// `admin.reportFile({ id })` as staff.
fn mutate_or_query_file(d: &AcademyDoor, id: &str) -> (u16, Json) {
    query(
        d,
        STAFF,
        &STAFF_SCOPES,
        "admin.reportFile",
        Some(&Json::obj([("id", Json::str(id))])),
    )
}

#[test]
fn a_learner_export_refuses_a_blank_retention_or_row_limit() {
    let Some((db, _store)) = setup() else { return };
    let ask = Json::obj([
        ("tag", Json::Null),
        ("key", Json::str("report:learners::1")),
    ]);
    let no_retention = staff_door(&db, limits(&["ACADEMY_REPORT_RETENTION_HOURS"]));
    assert_eq!(
        staff_code(&no_retention, "admin.requestLearnerExport", &ask),
        "academy.report_retention_unset"
    );
    let no_rows = staff_door(&db, limits(&["ACADEMY_LEARNER_EXPORT_ROWS"]));
    assert_eq!(
        staff_code(&no_rows, "admin.requestLearnerExport", &ask),
        "academy.report_limit_unset"
    );
}
