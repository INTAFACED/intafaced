//! Time-stamped grade reports, against a real Postgres: the port of `curriculum/grade-reports.db.test.ts` and
//! `curriculum/grade-reports-router.test.ts` (AC-assignments-04, report part), assertion for assertion. Every refusal
//! has a test, a refusal writes nothing, and a download is the stored snapshot.
//!
//! The TypeScript test hands the reports a fixed gradebook; here the gradebook is the real one, read from rows that
//! make the same book: one assignment "Size, a trade" under one type, L graded 8 of 10, M enrolled with nothing handed
//! in, the policy set at T1. The course and the enrolments are another slice's calls, written as the rows they leave.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use service_kit::server::Request;
use support::{MemoryObjects, TestDb, at, code_of, enrol, jp, seed_course, test_storage};
use svc_academy::assessment::assignments::{self, BriefInput, Files};
use svc_academy::assessment::reports::{self, csv_field, grade_report_csv};
use svc_academy::assessment::{gradebook, sha256_hex};
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::errors::Refusal;
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const M: &str = "66666666-6666-4666-8666-666666666666";
const ITEM: &str = "77777777-7777-4777-8777-777777777777";
const T1_ISO: &str = "2026-10-27T07:00:00.000Z";
const T2_ISO: &str = "2026-10-27T07:00:05.000Z";

fn t(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

/// The TypeScript test's `book(courseId)`.
fn book(course: &str) -> Json {
    jp(&format!(
        r#"{{"courseId":"{course}",
            "policy":{{"revision":1,"types":[{{"name":"Homework","weight":"1","dropLowest":0,"itemIds":["{ITEM}"]}}],"setBy":"{A}","setAt":"{T1_ISO}","reason":"TEST"}},
            "latePolicy":null,
            "items":[{{"itemId":"{ITEM}","title":"Size, a trade","kind":"assignment"}}],
            "learners":[
              {{"userId":"{L}","items":[{{"itemId":"{ITEM}","state":"graded","score":"0.8","entered":null}}],
                "types":[{{"name":"Homework","average":"0.8","counted":["{ITEM}"],"dropped":[]}}],"total":"0.8"}},
              {{"userId":"{M}","items":[{{"itemId":"{ITEM}","state":"not_attempted","score":null,"entered":null}}],
                "types":[{{"name":"Homework","average":null,"counted":[],"dropped":[]}}],"total":null}}]}}"#
    ))
}

// ── grade report CSV ────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_csv_writes_decimal_fractions_not_attempted_never_zero_and_the_time_it_was_made() {
    assert_eq!(
        grade_report_csv(&book("c"), 1, t(T1_ISO)),
        [
            format!("grade report,1,made at,{T1_ISO}"),
            "learner,\"Size, a trade\",Homework (1),total".to_owned(),
            format!("{L},0.8,0.8,0.8"),
            format!("{M},not attempted,not attempted,not attempted"),
            String::new(),
        ]
        .join("\r\n")
    );
}

#[test]
fn each_score_goes_under_its_own_column_whatever_order_a_row_lists_them_in() {
    const OTHER: &str = "99999999-9999-4999-8999-999999999999";
    let mut two = book("c");
    if let Json::Object(fields) = &mut two {
        for (k, v) in fields.iter_mut() {
            match (k.as_str(), v) {
                ("items", Json::Array(items)) => {
                    items.push(jp(&format!(
                        r#"{{"itemId":"{OTHER}","title":"Journal","kind":"assignment"}}"#
                    )));
                }
                ("learners", Json::Array(learners)) => {
                    if let Some(Json::Object(row)) = learners.first_mut() {
                        for (rk, rv) in row.iter_mut() {
                            if let ("items", Json::Array(cells)) = (rk.as_str(), rv) {
                                cells.insert(0, jp(&format!(r#"{{"itemId":"{OTHER}","state":"pending","score":null,"entered":null}}"#)));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let csv = grade_report_csv(&two, 1, t(T1_ISO));
    assert_eq!(
        csv.split("\r\n").nth(2),
        Some(format!("{L},0.8,pending,0.8,0.8").as_str())
    );
}

#[test]
fn a_title_that_starts_like_a_formula_is_kept_as_text() {
    assert_eq!(csv_field("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert_eq!(csv_field("-1"), "'-1");
    assert_eq!(csv_field(" =1+1"), "' =1+1");
}

// ── grade reports against the database ──────────────────────────────────────────────────────────────────────────────

struct Course {
    db: TestDb,
    store: Store,
    id: String,
}

impl Course {
    fn stored(&self) -> usize {
        self.db
            .texts("SELECT n::text FROM academy.course_grade_reports")
            .len()
    }

    fn make(&self, rows: Option<i64>, n: i64, at_iso: &str) -> Result<Json, Refusal> {
        reports::make(&self.store, rows, &self.id, n, A, t(at_iso))
    }
}

/// A course whose gradebook is `book(courseId)`.
fn course() -> Option<Course> {
    let db = TestDb::migrated()?;
    let mut c = db.client();
    let seeded = seed_course(
        &mut c,
        "reports-test",
        "draft",
        A,
        T1_ISO,
        &[("assignment", "Size, a trade")],
    );
    c.execute(
        "UPDATE academy.course_items SET id = $1::text::uuid WHERE id = $2::text::uuid",
        &[&ITEM, &seeded.items[0]],
    )
    .unwrap();
    let store = Store::Pool(db.pool());
    let brief = BriefInput {
        instructions: "Size one trade.",
        points: "10",
        due_at: None,
        text: "required",
        file: "off",
    };
    assignments::save(&store, ITEM, 0, &brief, A, t(T1_ISO)).unwrap();
    c.execute(
        "UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid",
        &[&seeded.id],
    )
    .unwrap();
    for user in [L, M] {
        enrol(&mut c, &seeded.id, user, T1_ISO);
    }
    let types = match jp(&format!(
        r#"[{{"name":"Homework","weight":"1","dropLowest":0,"itemIds":["{ITEM}"]}}]"#
    )) {
        Json::Array(ts) => ts,
        _ => unreachable!(),
    };
    gradebook::save_policy(&store, &seeded.id, 0, &types, "TEST", A, t(T1_ISO)).unwrap();
    let objects = MemoryObjects::new();
    let files = Files {
        storage: Some(test_storage()),
        max_bytes: Some(1024),
        types: Some(vec!["application/pdf".to_owned()]),
        bytes: &objects,
    };
    assignments::submit(
        &store,
        &files,
        ITEM,
        1,
        Some("TEST working"),
        None,
        L,
        t(T1_ISO),
    )
    .unwrap();
    c.execute(
        "INSERT INTO academy.assignment_grade_events (submission_id, n, score, points, comment, actor, reason, at) \
         SELECT id, 1, 8, 10, null, $1::text::uuid, null, $2::text::timestamptz FROM academy.assignment_submissions WHERE item_id = $3::text::uuid",
        &[&A, &T1_ISO, &ITEM],
    )
    .unwrap();
    let course = Course {
        db,
        store,
        id: seeded.id,
    };
    assert_eq!(
        gradebook::view(&course.store, &course.id).unwrap(),
        book(&course.id),
        "the rows make the TypeScript test's book"
    );
    Some(course)
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

#[test]
fn each_report_is_stored_with_its_own_time_and_hash_and_a_download_is_the_stored_snapshot() {
    let c = need!(course());
    let first = c.make(Some(10), 1, T1_ISO).unwrap();
    let second = c.make(Some(10), 2, T2_ISO).unwrap();
    for (k, v) in [
        ("courseId", Json::str(&c.id)),
        ("n", Json::int(1)),
        ("madeAt", Json::str(T1_ISO)),
        ("madeBy", Json::str(A)),
        ("rows", Json::int(2)),
    ] {
        assert_eq!(at(&first, k), v, "{k}");
    }
    assert_eq!(at(&second, "madeAt"), Json::str(T2_ISO));
    assert_ne!(at(&second, "sha256"), at(&first, "sha256"));
    let file = reports::file(&c.store, &c.id, 1).unwrap();
    let csv = match at(&file, "csv") {
        Json::String(s) => s,
        other => panic!("{other:?}"),
    };
    assert_eq!(csv, grade_report_csv(&book(&c.id), 1, t(T1_ISO)));
    assert_eq!(
        Json::String(sha256_hex(csv.as_bytes())),
        at(&first, "sha256")
    );
    let ns: Vec<Json> = match at(&reports::list(&c.store, &c.id).unwrap(), "reports") {
        Json::Array(rs) => rs.iter().map(|r| at(r, "n")).collect(),
        other => panic!("{other:?}"),
    };
    assert_eq!(ns, [Json::int(2), Json::int(1)]);
}

#[test]
fn a_retried_report_n_answers_with_the_report_it_made() {
    let c = need!(course());
    let made = c.make(Some(10), 1, T1_ISO).unwrap();
    assert_eq!(c.make(Some(10), 1, T2_ISO).unwrap(), made);
    assert_eq!(c.stored(), 1);
}

#[test]
fn a_number_past_the_next_refuses_and_writes_nothing() {
    let c = need!(course());
    assert_eq!(
        code_of(c.make(Some(10), 2, T1_ISO)),
        "academy.report_out_of_order"
    );
    assert_eq!(c.stored(), 0);
}

#[test]
fn a_blank_row_limit_refuses_and_writes_nothing() {
    let c = need!(course());
    assert_eq!(
        code_of(c.make(None, 1, T1_ISO)),
        "academy.report_limit_unset"
    );
    assert_eq!(c.stored(), 0);
}

#[test]
fn a_course_with_more_learners_than_one_report_holds_refuses_and_writes_nothing() {
    let c = need!(course());
    // The TypeScript refusal also carries `details: { limit: '1' }`, which never reaches the wire (the formatter reads
    // only retry, account-state and device details); the message names the limit instead.
    match c.make(Some(1), 1, T1_ISO) {
        Err(Refusal::Trpc(e)) => {
            assert_eq!(e.cause.as_deref(), Some("academy.report_too_large"));
            assert_eq!(e.code, "PRECONDITION_FAILED");
            assert!(e.message.contains("over the 1 rows"), "{}", e.message);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(c.stored(), 0);
}

#[test]
fn a_missing_course_and_a_missing_report_refuse() {
    let c = need!(course());
    let nowhere = "88888888-8888-4888-8888-888888888888";
    assert_eq!(
        code_of(reports::make(&c.store, Some(10), nowhere, 1, A, t(T1_ISO))),
        "academy.course_not_found"
    );
    assert_eq!(
        code_of(reports::list(&c.store, nowhere)),
        "academy.course_not_found"
    );
    assert_eq!(
        code_of(reports::file(&c.store, &c.id, 1)),
        "academy.report_not_found"
    );
}

#[test]
fn two_makers_racing_for_the_same_number_get_one_report() {
    let c = need!(course());
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| c.make(Some(10), 1, T1_ISO).unwrap());
        let b = scope.spawn(|| c.make(Some(10), 1, T2_ISO).unwrap());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(a, b);
    assert_eq!(c.stored(), 1);
}

// ── grade-reports-router.test.ts: the operator scope, and the refusal's code and status on the wire ───────────────

const SECRET: &str = "an-academy-assessment-reports-edge-secret";

fn door(store: Store, rows: Option<i64>) -> AcademyDoor {
    let settings = match rows {
        Some(r) => Json::obj([("ACADEMY_GRADE_REPORT_ROWS", Json::int(r))]),
        None => Json::obj([]),
    };
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        // The TypeScript test process's switches, as the wire replay sets them.
        env: [
            ("APP_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
            ("NODE_ENV", "test"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect(),
        store,
        ports: Ports::unwired(),
        settings: Settings(settings),
        now: system_now,
    })
    .unwrap()
}

fn ask(
    door: &AcademyDoor,
    method: &str,
    path: &str,
    input: &str,
    scopes: Option<&[&str]>,
) -> (u16, Json) {
    let mut headers = vec![
        ("content-type".to_owned(), "application/json".to_owned()),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ];
    if let Some(scopes) = scopes {
        let raw = Json::obj([
            ("sub", Json::str(A)),
            (
                "scopes",
                Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
            ),
            ("tier", Json::str("none")),
            ("mfa", Json::Bool(scopes.contains(&"admin:write"))),
            ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
            ("userId", Json::str(A)),
            ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
        ])
        .compact();
        headers.push((
            "x-intafaced-principal-sig".to_owned(),
            service_kit::edge::sign(&raw, SECRET, "DE").unwrap(),
        ));
        headers.push(("x-intafaced-principal".to_owned(), raw));
    }
    let (url, body) = if method == "GET" {
        (
            format!("/trpc/{path}?input={}", support_encode(input)),
            String::new(),
        )
    } else {
        (format!("/trpc/{path}"), input.to_owned())
    };
    let res = door.handle(&Request {
        method,
        url: &url,
        headers: &headers,
        body: &body,
    });
    (res.status, jp(&res.body))
}

fn support_encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[test]
fn the_report_calls_refuse_a_caller_without_the_operator_scope_and_send_the_code_and_status() {
    let c = need!(course());
    let d = door(Store::Pool(c.db.pool()), None);
    let list_input = format!(r#"{{"courseId":"{}"}}"#, c.id);
    let make_input = format!(r#"{{"courseId":"{}","n":1}}"#, c.id);
    let (status, _) = ask(
        &d,
        "GET",
        "admin.courseGradeReports",
        &list_input,
        Some(&["academy:read"]),
    );
    assert_eq!(status, 403);
    let (status, _) = ask(&d, "POST", "admin.makeGradeReport", &make_input, None);
    assert_eq!(status, 401);
    let operator: &[&str] = &["admin:read", "admin:write"];
    let (status, body) = ask(
        &d,
        "POST",
        "admin.makeGradeReport",
        &make_input,
        Some(operator),
    );
    assert_eq!(
        (status, at(&body, "error.data.code")),
        (412, Json::str("PRECONDITION_FAILED")),
        "{}",
        body.compact()
    );
    assert!(
        at(&body, "error.message")
            .compact()
            .contains("academy.report_limit_unset"),
        "{}",
        body.compact()
    );
    let (status, body) = ask(
        &d,
        "GET",
        "admin.gradeReportFile",
        &make_input,
        Some(operator),
    );
    assert_eq!(
        (status, at(&body, "error.data.code")),
        (404, Json::str("NOT_FOUND")),
        "{}",
        body.compact()
    );
    assert!(
        at(&body, "error.message")
            .compact()
            .contains("academy.report_not_found"),
        "{}",
        body.compact()
    );
    let (status, body) = ask(
        &d,
        "GET",
        "admin.courseGradeReports",
        &list_input,
        Some(operator),
    );
    assert_eq!(status, 200);
    assert_eq!(
        at(&body, "result.data"),
        jp(&format!(r#"{{"courseId":"{}","reports":[]}}"#, c.id))
    );
}
