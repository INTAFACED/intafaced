//! The learner path against a real Postgres: the port of the learner slice's parts of
//! `learning/customer.db.test.ts` (course enrolment and its terms, My learning and the access records, Complete and
//! Undo, the reading position, the video position, and the staff grant audit and enrolment counts). Figures are TEST
//! values, not owner settings.
//!
//! Rows the TypeScript writes through other slices' calls (leaving a path, a prerequisite, a course start, a course's
//! enrolment terms, a published quiz and its attempts) are written here as the rows those calls leave, as
//! `curriculum_release.rs` does. What the TypeScript reads through other slices' calls (`courseOutline`,
//! `myCompletions`, `readCurriculumItem`) is read here from the rows those calls read. The tests whose every assertion
//! is another slice's call (`myCompletions`' pages, `enrollCertPath`/`leaveCertPath`, a programme's prerequisites,
//! residency cohorts, rooms and sessions, `opsMetrics`, `completionsByItem`) are left to those slices' ports.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use support::TestDb;
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::errors::Refusal;
use svc_academy::learner::service::{Learning, Options, Settle};
use svc_academy::learner::store::{LearningState, Store as Customer};
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const THIRD: &str = "33333333-3333-4333-8333-333333333333";
const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const EDGE_SECRET: &str = "academy-learning-backend-edge-secret-32";

fn now() -> i64 {
    system_now().0
}

fn at(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

fn iso(ms: i64) -> String {
    service_kit::time::Instant(ms).iso()
}

fn refused<T: std::fmt::Debug>(r: Result<T, Refusal>) -> (String, String) {
    match r {
        Err(Refusal::Academy(e)) => (e.code, e.message),
        other => panic!("{other:?}"),
    }
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    refused(r).0
}

fn arr(v: &Json) -> &Vec<Json> {
    match v {
        Json::Array(a) => a,
        other => panic!("not an array: {other:?}"),
    }
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

fn n(v: &Json, key: &str) -> f64 {
    match v.get(key) {
        Some(Json::Number(n)) => *n,
        other => panic!("{key}: {other:?}"),
    }
}

fn null(v: &Json, key: &str) -> bool {
    matches!(v.get(key), Some(Json::Null))
}

fn slugs(v: &Json) -> Vec<String> {
    arr(v).iter().map(|r| s(r, "slug")).collect()
}

struct T {
    db: TestDb,
    store: Store,
    ports: Ports,
}

fn setup() -> Option<T> {
    let db = TestDb::migrated()?;
    let store = Store::Pool(db.pool());
    Some(T {
        db,
        store,
        ports: Ports::unwired(),
    })
}

const OPTIONS: Options<'static> = Options {
    watch_threshold_seconds: None,
    video_min_tier: "",
    video_min_stake: "",
    settle: &Settle::NONE,
};

impl T {
    fn learning(&self) -> Learning<'_> {
        Learning {
            pool: &self.store,
            ports: &self.ports,
            options: OPTIONS,
        }
    }

    fn customer(&self) -> Customer<'_> {
        Customer { pool: &self.store }
    }

    fn exec(&self, sql: &str) {
        self.db.client().batch_execute(sql).unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        i64::from(
            self.db
                .client()
                .query_one(sql, &[])
                .unwrap()
                .get::<_, i32>(0),
        )
    }

    fn complete(&self, user: &str, slug: &str) -> Json {
        self.learning()
            .mark_complete(user, "none", slug, now())
            .unwrap()
    }

    /// The completion a course outline shows for an item: its `completedAt`, read at milliseconds.
    fn completed_at(&self, user: &str, slug: &str) -> Option<String> {
        self.db
            .client()
            .query_opt(
                "SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
                 FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = $2",
                &[&user, &slug],
            )
            .unwrap()
            .map(|r| r.get(0))
    }

    /// `leaveCertPath` (the certificates slice's call): the row it leaves.
    fn leave(&self, user: &str, path: &str, request: &str) {
        self.exec(&format!(
            "UPDATE academy.cert_enrollments SET left_at = now(), leave_request_id = '{request}' \
             WHERE user_id = '{user}' AND path_slug = '{path}' AND left_at IS NULL"
        ));
    }

    /// `setItemPrerequisites` (the curriculum slice's call): the rows it leaves.
    fn prerequisites(&self, item: &str, prerequisites: &[&str]) {
        self.exec(&format!(
            "DELETE FROM academy.item_prerequisites WHERE item_slug = '{item}'"
        ));
        for p in prerequisites {
            self.exec(&format!(
                "INSERT INTO academy.item_prerequisites VALUES ('{item}', '{p}')"
            ));
        }
    }

    /// `setCourseEnrolmentTerms`' calls (`setCourseSeatCap`, `setCourseEnrolmentWindow`, `setCourseVisibility`): the
    /// one row they keep per course, each call changing its own field.
    fn terms(&self, field: &str, value: &str, reason: &str) {
        self.exec(&format!(
            "INSERT INTO academy.course_enrolment_terms (path, {field}, reason, set_by, set_at) \
             VALUES ('markets', {value}, '{reason}', '{OTHER}', now()) \
             ON CONFLICT (path) DO UPDATE SET {field} = EXCLUDED.{field}, reason = EXCLUDED.reason, \
               set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at"
        ));
    }
}

fn items(path: &str) -> Vec<String> {
    spine::list(Some(path), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect()
}

fn door(store: Store, settings: Settings) -> AcademyDoor {
    AcademyDoor::new(DoorConfig {
        edge_secret: EDGE_SECRET.to_owned(),
        env: [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect(),
        store,
        ports: Ports::unwired(),
        settings,
        now: system_now,
    })
    .unwrap()
}

const SCOPES: [&str; 3] = ["academy:read", "academy:write", "admin:read"];

/// `createAcademyRouter(academy).createCaller(signed(principal({ scopes })))`, or anonymous with `None`: one tRPC call.
fn call(
    door: &AcademyDoor,
    scopes: Option<&[&str]>,
    path: &str,
    mutation: bool,
    input: Option<&Json>,
) -> (u16, Json) {
    let mut headers = vec![("x-intafaced-region".to_owned(), "DE".to_owned())];
    if let Some(scopes) = scopes {
        let raw = Json::obj([
            ("sub", Json::str(USER)),
            ("userId", Json::str(USER)),
            ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
            (
                "scopes",
                Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
            ),
            ("tier", Json::str("none")),
            ("mfa", Json::Bool(false)),
            ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
        ])
        .compact();
        headers.push((
            "x-intafaced-principal-sig".to_owned(),
            edge::sign(&raw, EDGE_SECRET, "DE").unwrap(),
        ));
        headers.push(("x-intafaced-principal".to_owned(), raw));
    }
    let body = input.map(Json::compact);
    let res = if mutation {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let url = format!("/trpc/{path}");
        door.handle(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body: body.as_deref().unwrap_or(""),
        })
    } else {
        let url = match body {
            None => format!("/trpc/{path}"),
            Some(body) => {
                let q: String = body
                    .bytes()
                    .map(|b| {
                        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                            char::from(b).to_string()
                        } else {
                            format!("%{b:02X}")
                        }
                    })
                    .collect();
                format!("/trpc/{path}?input={q}")
            }
        };
        door.handle(&Request {
            method: "GET",
            url: &url,
            headers: &headers,
            body: "",
        })
    };
    (res.status, json::parse(&res.body).unwrap())
}

fn data(answer: &(u16, Json)) -> &Json {
    assert_eq!(answer.0, 200, "{:?}", answer.1);
    answer.1.get("result").and_then(|r| r.get("data")).unwrap()
}

/// The tRPC code of a refusal and its cause's code.
fn trpc_code(answer: &(u16, Json)) -> (String, Option<String>) {
    let d = answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .unwrap_or_else(|| panic!("{:?}", answer.1));
    let code = match d.get("code") {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{other:?}"),
    };
    let cause = match d.get("cause").and_then(|c| c.get("code")) {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    };
    (code, cause)
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

macro_rules! db {
    () => {
        match setup() {
            Some(t) => t,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

#[test]
fn enrols_in_a_course_on_the_free_track_once_refuses_the_unpriced_certificate_track_and_keeps_progress_across_a_leave()
 {
    let t = db!();
    let before = t
        .learning()
        .course_enrolment(USER, "markets", now())
        .unwrap();
    assert_eq!(s(&before, "slug"), "markets");
    for key in [
        "startsAt",
        "seatCap",
        "seatsRemaining",
        "closed",
        "enrolment",
    ] {
        assert!(null(&before, key), "{key}");
    }
    assert_eq!(
        before.get("tracks").unwrap().compact(),
        r#"[{"track":"audit","free":true,"closed":null},{"track":"certificate","free":false,"closed":"no_price"}]"#
    );
    assert_eq!(s(&before, "activationMail"), "vendor.email");
    let (c, m) = refused(
        t.learning()
            .enrol_course(USER, "markets", "certificate", now()),
    );
    assert_eq!(c, "academy.enrolment_closed");
    assert!(m.contains("reason=no_price"), "{m}");
    assert_eq!(
        code(
            t.learning()
                .enrol_course(USER, "no-such-course", "audit", now())
        ),
        "academy.course_not_found"
    );

    // Two enrolments at once, through the router: one enrolment, the same answer to both.
    let d = door(Store::Pool(t.db.pool()), Settings::empty());
    let input = obj(&[
        ("slug", Json::str("markets")),
        ("track", Json::str("audit")),
    ]);
    let (first, second) = std::thread::scope(|sc| {
        let a = sc.spawn(|| call(&d, Some(&SCOPES), "enrolCourse", true, Some(&input)));
        let b = sc.spawn(|| call(&d, Some(&SCOPES), "enrolCourse", true, Some(&input)));
        (a.join().unwrap(), b.join().unwrap())
    });
    let (first, second) = (data(&first).clone(), data(&second).clone());
    assert_eq!(s(first.get("enrolment").unwrap(), "track"), "audit");
    assert_eq!(second.get("enrolment"), first.get("enrolment"));
    let read = call(
        &d,
        Some(&SCOPES),
        "courseEnrolment",
        false,
        Some(&obj(&[("slug", Json::str("markets"))])),
    );
    assert_eq!(data(&read), &first);
    assert_eq!(
        t.count(&format!(
            "SELECT COUNT(*)::int FROM academy.cert_enrollments WHERE user_id = '{USER}' AND path_slug = 'markets'"
        )),
        1
    );
    assert!(null(
        &t.learning()
            .course_enrolment(OTHER, "markets", now())
            .unwrap(),
        "enrolment"
    ));

    t.complete(USER, "markets-reading-the-book");
    t.leave(USER, "markets", "leave-markets");
    assert!(null(
        &t.learning()
            .course_enrolment(USER, "markets", now())
            .unwrap(),
        "enrolment"
    ));
    let again = t
        .learning()
        .enrol_course(USER, "markets", "audit", now())
        .unwrap();
    assert!(!null(&again, "enrolment"));
    // `myCompletions` (the certificates slice's read) lists the caller's completions: the one recorded stays.
    assert_eq!(
        t.db.texts(&format!(
            "SELECT item_slug FROM academy.cert_item_completions WHERE user_id = '{USER}'"
        )),
        ["markets-reading-the-book"]
    );
    let anonymous = call(
        &d,
        None,
        "courseEnrolment",
        false,
        Some(&obj(&[("slug", Json::str("markets"))])),
    );
    assert_eq!(trpc_code(&anonymous).0, "UNAUTHORIZED");
}

#[test]
fn my_learning_shows_real_progress_start_course_before_anything_is_read_and_keeps_progress_across_leave_and_re_enrol()
 {
    let t = db!();
    let items = items("markets");
    let l = t.learning();
    assert_eq!(l.my_learning(USER, now()).unwrap(), Json::Array(vec![]));
    assert_eq!(l.my_access_grants(USER).unwrap(), Json::Array(vec![]));
    let enrolled = l.enrol_course(USER, "markets", "audit", now()).unwrap();
    let enrolled_at = s(enrolled.get("enrolment").unwrap(), "enrolledAt");
    t.customer()
        .touch_lesson(USER, &items[0], None, "touch-0", now())
        .unwrap();
    let fresh = l.my_learning(USER, now()).unwrap();
    assert_eq!(
        arr(&fresh)[0],
        obj(&[
            ("slug", Json::str("markets")),
            ("status", Json::str("in_progress")),
            ("enrolledAt", Json::str(enrolled_at.clone())),
            ("startsAt", Json::Null),
            ("items", Json::int(i64::try_from(items.len()).unwrap())),
            ("completed", Json::int(0)),
            ("firstItemSlug", Json::str(items[0].clone())),
            ("resumeItemSlug", Json::Null),
        ])
    );
    assert_eq!(
        l.my_access_grants(USER).unwrap(),
        Json::Array(vec![obj(&[
            ("slug", Json::str("markets")),
            ("source", Json::str("free")),
            ("grantedAt", Json::str(enrolled_at)),
            ("expiresAt", Json::Null),
        ])])
    );

    t.complete(USER, &items[0]);
    let started = &arr(&l.my_learning(USER, now()).unwrap())[0].clone();
    // Continue goes back to the item last opened in this course.
    assert_eq!(n(started, "completed"), 1.0);
    assert_eq!(s(started, "resumeItemSlug"), items[0]);
    let last = items.last().unwrap();
    t.customer()
        .touch_lesson(USER, last, None, "touch-1", now())
        .unwrap();
    assert_eq!(
        s(
            &arr(&l.my_learning(USER, now()).unwrap())[0],
            "resumeItemSlug"
        ),
        *last
    );
    // The reading position is one per learner: opening a lesson elsewhere sends Continue back to the first item not done.
    let builder = spine::list(Some("builder"), None)[0].slug.clone();
    t.customer()
        .touch_lesson(USER, &builder, None, "touch-2", now())
        .unwrap();
    assert_eq!(
        s(
            &arr(&l.my_learning(USER, now()).unwrap())[0],
            "resumeItemSlug"
        ),
        *items.get(1).unwrap_or(&items[0])
    );
    assert_eq!(l.my_learning(OTHER, now()).unwrap(), Json::Array(vec![]));

    t.leave(USER, "markets", "leave-ml");
    assert_eq!(l.my_learning(USER, now()).unwrap(), Json::Array(vec![]));
    assert_eq!(l.my_access_grants(USER).unwrap(), Json::Array(vec![]));
    l.enrol_course(USER, "markets", "audit", now()).unwrap();
    let back = arr(&l.my_learning(USER, now()).unwrap())[0].clone();
    assert_eq!(
        (n(&back, "completed"), s(&back, "status")),
        (1.0, "in_progress".to_owned())
    );

    for slug in &items {
        t.complete(USER, slug);
    }
    let done = arr(&l.my_learning(USER, now()).unwrap())[0].clone();
    assert_eq!(n(&done, "completed"), items.len() as f64);
    assert_eq!(s(&done, "status"), "completed");
    let d = door(Store::Pool(t.db.pool()), Settings::empty());
    assert_eq!(
        slugs(data(&call(&d, Some(&SCOPES), "myLearning", false, None))),
        ["markets"]
    );
    let grants = call(&d, Some(&SCOPES), "myAccessGrants", false, None);
    assert_eq!(
        arr(data(&grants))
            .iter()
            .map(|g| s(g, "source"))
            .collect::<Vec<_>>(),
        ["free"]
    );
}

#[test]
fn the_course_outline_gives_each_item_its_own_release_state_locks_with_the_reason_and_start_course_skips_a_locked_first_item()
 {
    let t = db!();
    let items = items("markets");
    assert!(items.len() >= 3);
    t.prerequisites(&items[2], &[&items[1]]);
    // The outline (the authoring slice's read) is that slice's port; what the learner side does with the lock is here:
    // the locked item refuses Complete with its reason, and opens once its prerequisite is done.
    let (c, m) = refused(t.learning().mark_complete(USER, "none", &items[2], now()));
    assert_eq!(c, "academy.prerequisite_unmet");
    assert_eq!(
        m,
        format!("academy.prerequisite_unmet missing={}", items[1])
    );
    t.complete(USER, &items[1]);
    assert!(t.completed_at(USER, &items[1]).is_some());
    t.learning()
        .mark_complete(USER, "none", &items[2], now())
        .unwrap();
    assert_eq!(
        code(t.learning().mark_complete(OTHER, "none", &items[2], now())),
        "academy.prerequisite_unmet"
    );

    t.prerequisites(&items[0], &[&items[2]]);
    t.learning()
        .enrol_course(OTHER, "markets", "audit", now())
        .unwrap();
    assert_eq!(
        s(
            &arr(&t.learning().my_learning(OTHER, now()).unwrap())[0],
            "firstItemSlug"
        ),
        items[1]
    );
    assert_eq!(
        code(
            t.learning()
                .mark_complete(USER, "none", "no-such-item", now())
        ),
        "academy.curriculum_not_found"
    );
}

#[test]
fn complete_records_once_with_one_history_event_undo_drops_progress_and_relocks_and_completing_again_records_a_new_event()
 {
    let t = db!();
    let items = items("markets");
    let l = t.learning();
    t.prerequisites(&items[1], &[&items[0]]);
    let start = now();
    let first = l.mark_complete(USER, "none", &items[0], start).unwrap();
    let again = l.mark_complete(USER, "none", &items[0], start + 5).unwrap();
    assert_eq!(s(&again, "completedAt"), s(&first, "completedAt"));
    let completed = s(&first, "completedAt");
    assert_eq!(t.completed_at(USER, &items[0]), Some(completed.clone()));
    assert_eq!(t.completed_at(USER, &items[1]), None);

    let undo = |slug: &str, completed_at: &str, request: &str| {
        l.undo_complete(USER, slug, completed_at, request, now())
    };
    let undone = undo(&items[0], &completed, "undo-1").unwrap();
    assert!(!null(&undone, "undoneAt"));
    // A lost reply sends the same request again: same answer, nothing written twice.
    assert_eq!(undo(&items[0], &completed, "undo-1").unwrap(), undone);
    assert_eq!(
        code(undo(&items[1], &completed, "undo-1")),
        "academy.request_reused"
    );
    assert!(null(
        &undo(&items[0], &completed, "undo-2").unwrap(),
        "undoneAt"
    ));
    assert_eq!(t.completed_at(USER, &items[0]), None);
    let (c, m) = refused(l.mark_complete(USER, "none", &items[1], now()));
    assert_eq!(c, "academy.prerequisite_unmet");
    assert_eq!(
        m,
        format!("academy.prerequisite_unmet missing={}", items[0])
    );

    let later = at(&completed) + 60_000;
    let redone = l.mark_complete(USER, "none", &items[0], later).unwrap();
    assert_eq!(s(&redone, "completedAt"), iso(later));
    assert_eq!(
        t.db.texts(&format!(
            "SELECT event FROM academy.item_completion_events WHERE user_id = '{USER}' AND item_slug = '{}' ORDER BY recorded_at",
            items[0]
        )),
        ["completed", "undone", "completed"]
    );
    // A late Undo of the first completion does not take back the new one.
    assert!(null(
        &undo(&items[0], &completed, "undo-late").unwrap(),
        "undoneAt"
    ));
    assert!(t.completed_at(USER, &items[0]).is_some());
    // Two Undos sharing one request id on different items: one runs, the other is refused in words, never a raw error.
    l.mark_complete(USER, "none", &items[1], now()).unwrap();
    let times: Vec<String> = (0..2)
        .map(|i| t.completed_at(USER, &items[i]).unwrap())
        .collect();
    let raced: Vec<Result<Json, Refusal>> = std::thread::scope(|sc| {
        let (t, items, times) = (&t, &items, &times);
        let handles: Vec<_> = (0..2)
            .map(|i| {
                sc.spawn(move || {
                    t.learning()
                        .undo_complete(USER, &items[i], &times[i], "shared", now())
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(raced.iter().filter(|r| r.is_ok()).count(), 1);
    let rejected = raced.into_iter().find(Result::is_err).unwrap();
    assert_eq!(code(rejected), "academy.request_reused");
    l.mark_complete(USER, "none", &items[0], now()).unwrap();
    l.mark_complete(USER, "none", &items[1], now()).unwrap();
    // Undo is the caller's own: another learner's completion of the same item is untouched.
    l.mark_complete(OTHER, "none", &items[0], now()).unwrap();
    let mine = t.completed_at(USER, &items[0]).unwrap();
    undo(&items[0], &mine, "undo-3").unwrap();
    assert!(t.completed_at(OTHER, &items[0]).is_some());
}

#[test]
fn undo_matches_a_completion_stored_with_microseconds_as_rows_recorded_before_undo_existed_were() {
    let t = db!();
    let slug = items("markets")[0].clone();
    t.exec(&format!(
        "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) \
         VALUES ('{USER}', '{slug}', '2026-10-01T10:00:00.123456Z')"
    ));
    let seen = t.completed_at(USER, &slug).unwrap();
    assert_eq!(seen, "2026-10-01T10:00:00.123Z");
    let undone = t
        .learning()
        .undo_complete(USER, &slug, &seen, "old-row", now())
        .unwrap();
    assert!(!null(&undone, "undoneAt"));
    assert_eq!(t.completed_at(USER, &slug), None);
}

#[test]
fn an_item_with_a_published_quiz_completes_only_after_a_passing_attempt_and_the_outline_says_which_rule_is_unmet()
 {
    let t = db!();
    let slug = items("foundations")[0].clone();
    // The quiz as the assessment slice publishes it (`academy.quizzes`), first without a pass mark.
    let publish = |pass_mark: &str| {
        t.exec(&format!(
            "INSERT INTO academy.quizzes (slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode, reason, set_by, set_at) \
             VALUES ('{slug}', '{{}}'::jsonb, {pass_mark}, NULL, NULL, 'answers', 'TEST quiz', '{STAFF}', now()) \
             ON CONFLICT (slug) DO UPDATE SET pass_mark = EXCLUDED.pass_mark"
        ));
    };
    publish("NULL");
    assert_eq!(
        code(t.learning().mark_complete(USER, "none", &slug, now())),
        "academy.pass_mark_unset"
    );
    publish("1");
    let (c, m) = refused(t.learning().mark_complete(USER, "none", &slug, now()));
    assert_eq!(
        (c.as_str(), m.as_str()),
        (
            "academy.completion_rule_unmet",
            "academy.completion_rule_unmet rule=score"
        )
    );
    // `submitAssessment` (the assessment slice's call): the attempt row it leaves, failing, then passing.
    let attempt = |id: &str, score: i32, passed: bool| {
        t.exec(&format!(
            "INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed) \
             VALUES ('{USER}', '{slug}', '{id}', {score}, 1, {passed})"
        ));
    };
    attempt("a1", 0, false);
    assert_eq!(
        code(t.learning().mark_complete(USER, "none", &slug, now())),
        "academy.completion_rule_unmet"
    );
    attempt("a2", 1, true);
    assert_eq!(
        s(
            &t.learning()
                .mark_complete(USER, "none", &slug, now())
                .unwrap(),
            "itemSlug"
        ),
        slug
    );
}

#[test]
fn a_course_that_starts_next_week_takes_enrolments_shows_its_date_and_holds_every_item_until_it_starts()
 {
    let t = db!();
    let items = items("markets");
    let now_at = at("2026-10-23T12:00:00.000Z");
    let starts = "2026-10-30T09:00:00.000Z";
    // `setCourseStart` (the curriculum slice's call): the row it leaves.
    t.exec(&format!(
        "INSERT INTO academy.course_starts VALUES ('markets', '{starts}', 'cohort', '{OTHER}', now())"
    ));
    let l = t.learning();
    let enrolled = l.enrol_course(USER, "markets", "audit", now_at).unwrap();
    assert_eq!(s(&enrolled, "startsAt"), starts);
    assert_eq!(s(enrolled.get("enrolment").unwrap(), "track"), "audit");
    assert!(null(
        &l.course_enrolment(USER, "foundations", now_at).unwrap(),
        "startsAt"
    ));
    let held = arr(&l.my_learning(USER, now_at).unwrap())[0].clone();
    assert_eq!(
        (s(&held, "status"), s(&held, "startsAt")),
        ("future_start".to_owned(), starts.to_owned())
    );
    // Every item is held until the start: Complete refuses with the window, and opens at the start.
    for slug in &items {
        assert_eq!(
            code(l.mark_complete(USER, "none", slug, now_at)),
            "academy.window_invalid"
        );
    }
    let later = at("2026-10-30T09:00:00.000Z");
    let open = arr(&l.my_learning(USER, later).unwrap())[0].clone();
    assert_eq!(
        (s(&open, "status"), s(&open, "startsAt")),
        ("in_progress".to_owned(), starts.to_owned())
    );
    l.mark_complete(USER, "none", &items[0], later).unwrap();

    t.exec(&format!(
        "UPDATE academy.course_starts SET starts_at = NULL, reason = 'self-paced again', set_by = '{OTHER}' WHERE path = 'markets'"
    ));
    assert!(null(
        &l.course_enrolment(USER, "markets", now_at).unwrap(),
        "startsAt"
    ));
    l.mark_complete(USER, "none", &items[1], now_at).unwrap();
}

#[test]
fn a_seat_cap_an_enrolment_window_and_a_visibility_close_a_course_in_words_keep_who_set_them_and_keep_enrolments_made()
 {
    let t = db!();
    let now_at = at("2026-10-23T12:00:00.000Z");
    let l = t.learning();
    let terms = |user: &str| l.course_enrolment(user, "markets", now_at).unwrap();
    let triple = |v: &Json| {
        (
            v.get("seatCap").cloned(),
            v.get("seatsRemaining").cloned(),
            v.get("closed").cloned(),
        )
    };
    // Nothing set: no cap, open, listed.
    assert_eq!(
        triple(&terms(USER)),
        (Some(Json::Null), Some(Json::Null), Some(Json::Null))
    );

    // A cap of 2: seats count active enrolments; the second fills it and the third is refused full.
    t.terms("seat_cap", "2", "TEST cohort");
    assert_eq!(
        triple(&terms(USER)),
        (Some(Json::int(2)), Some(Json::int(2)), Some(Json::Null))
    );
    l.enrol_course(USER, "markets", "audit", now_at).unwrap();
    l.enrol_course(OTHER, "markets", "audit", now_at).unwrap();
    let full = terms(THIRD);
    assert_eq!(
        (n(&full, "seatsRemaining"), s(&full, "closed")),
        (0.0, "full".to_owned())
    );
    let (c, m) = refused(l.enrol_course(THIRD, "markets", "audit", now_at));
    assert_eq!(c, "academy.enrolment_closed");
    assert!(m.contains("reason=full"), "{m}");
    // A learner already enrolled gets the same enrolment back, full or not.
    assert!(!null(
        &l.enrol_course(USER, "markets", "audit", now_at).unwrap(),
        "enrolment"
    ));
    assert_eq!(
        t.count("SELECT COUNT(*)::int FROM academy.cert_enrollments WHERE path_slug = 'markets' AND left_at IS NULL"),
        2
    );
    t.terms("seat_cap", "NULL", "TEST off");
    assert_eq!(
        triple(&terms(THIRD)),
        (Some(Json::Null), Some(Json::Null), Some(Json::Null))
    );

    // The window: not started, then ended; each refuses with its reason, and clearing it opens the course again.
    let day = 24 * 3_600_000;
    for (opens, closes, why) in [
        (Some(now_at + day), None, "window_not_started"),
        (Some(now_at - 2 * day), Some(now_at - day), "window_ended"),
    ] {
        let lit =
            |v: Option<i64>| v.map_or("NULL".to_owned(), |v| format!("'{}'::timestamptz", iso(v)));
        t.exec(&format!(
            "UPDATE academy.course_enrolment_terms SET opens_at = {}, closes_at = {}, reason = 'TEST window' WHERE path = 'markets'",
            lit(opens),
            lit(closes)
        ));
        assert_eq!(s(&terms(THIRD), "closed"), why);
        let (_, m) = refused(l.enrol_course(THIRD, "markets", "audit", now_at));
        assert!(m.contains(&format!("reason={why}")), "{m}");
    }
    t.exec("UPDATE academy.course_enrolment_terms SET opens_at = NULL, closes_at = NULL, reason = 'TEST off' WHERE path = 'markets'");

    // Hidden and unpublished leave the catalogue and close enrolment.
    for visibility in ["hidden", "unpublished"] {
        t.terms("visibility", &format!("'{visibility}'"), "TEST");
        assert_eq!(s(&terms(THIRD), "closed"), visibility);
        assert!(!slugs(&l.public_courses().unwrap()).contains(&"markets".to_owned()));
    }
    t.terms("visibility", "'published'", "TEST");
    assert!(slugs(&l.public_courses().unwrap()).contains(&"markets".to_owned()));
    assert!(!null(
        &l.enrol_course(THIRD, "markets", "audit", now_at).unwrap(),
        "enrolment"
    ));
}

#[test]
fn records_resume_seconds_and_utc_active_days_once_per_client_request() {
    let t = db!();
    let c = t.customer();
    let day1 = c
        .touch_lesson(
            USER,
            "markets-reading-the-book",
            Some(10.0),
            "touch-1",
            at("2026-10-17T23:00:00Z"),
        )
        .unwrap();
    let again = c
        .touch_lesson(
            USER,
            "markets-reading-the-book",
            Some(15.0),
            "touch-2",
            at("2026-10-17T23:30:00Z"),
        )
        .unwrap();
    assert_eq!(again.active_days, 1);
    assert_eq!(again.seconds_read, 25);
    let day2 = c
        .touch_lesson(
            USER,
            "foundations-risk-first",
            Some(5.0),
            "touch-3",
            at("2026-10-18T00:30:00Z"),
        )
        .unwrap();
    assert_eq!(day2.active_days, 2);
    assert_eq!(
        day2.last_item_slug.as_deref(),
        Some("foundations-risk-first")
    );
    let replay = c
        .touch_lesson(
            USER,
            "markets-reading-the-book",
            Some(10.0),
            "touch-1",
            at("2026-10-19T00:00:00Z"),
        )
        .unwrap();
    assert_eq!(replay.seconds_read, day1.seconds_read);
    assert_eq!(replay.active_days, 1);
    assert_eq!(c.learning_state(USER).unwrap().seconds_read, 30);
    assert_eq!(
        c.learning_state(OTHER).unwrap(),
        LearningState {
            last_item_slug: None,
            last_opened_at: None,
            seconds_read: 0,
            active_days: 0
        }
    );
    assert_eq!(
        code(c.touch_lesson(USER, "no-such-lesson", Some(1.0), "touch-x", now())),
        "academy.curriculum_not_found"
    );
    assert_eq!(
        code(c.touch_lesson(
            USER,
            "markets-reading-the-book",
            Some(86_401.0),
            "touch-y",
            now()
        )),
        "academy.seconds_out_of_range"
    );
}

#[test]
fn stores_watch_position_for_the_caller_and_refuses_a_position_past_a_set_duration() {
    let t = db!();
    let l = t.learning();
    let c = t.customer();
    let video = "foundations-risk-first";
    let set = l
        .set_video_progress(USER, "none", video, 12.0, "watch-1", now())
        .unwrap();
    assert_eq!(
        c.get_video_progress(USER, video).unwrap(),
        obj(&[
            ("videoSlug", Json::str(video)),
            (
                "positionSeconds",
                set.get("positionSeconds").unwrap().clone()
            )
        ])
    );
    l.set_video_progress(USER, "none", video, 12.0, "watch-1", now())
        .unwrap();
    assert_eq!(
        n(
            &c.get_video_progress(USER, video).unwrap(),
            "positionSeconds"
        ),
        12.0
    );
    l.set_video_progress(USER, "none", video, 20.0, "watch-2", now())
        .unwrap();
    assert_eq!(
        n(
            &c.get_video_progress(USER, video).unwrap(),
            "positionSeconds"
        ),
        20.0
    );
    assert_eq!(
        c.get_video_progress(OTHER, video).unwrap(),
        obj(&[
            ("videoSlug", Json::str(video)),
            ("positionSeconds", Json::Null)
        ])
    );
    // The refusal past a set duration needs a spine entry with a duration: the TypeScript builds one for the test
    // (`videoSpine: [TIMED_VIDEO]`); the named spine sets none and the Rust takes no other, so it is not ported.
}

#[test]
fn gives_operators_grant_audit_and_refuses_a_session_without_admin_read() {
    let t = db!();
    t.exec(&format!(
        "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES \
           ('{USER}', 'markets-reading-the-book', '2026-10-17T01:00:00Z'), \
           ('{OTHER}', 'foundations-risk-first', '2026-10-17T02:00:00Z'); \
         INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key) VALUES \
           ('{USER}', 'foundations-v1', '2026-10-17T03:00:00Z', 'cert:{USER}:foundations-v1'), \
           ('{OTHER}', 'foundations-v1', '2026-10-17T05:00:00Z', 'cert:{OTHER}:foundations-v1'), \
           ('{USER}', 'other-cert', '2026-10-16T03:00:00Z', 'cert:{USER}:other-cert'); \
         INSERT INTO academy.access_grants (id, user_id, path_slug, source, reason, starts_at, state, created_at, updated_at) \
           VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{USER}', 'markets', 'staff', 'Scholarship for the October cohort', \
                   '2026-10-17T06:00:00Z', 'revoked', '2026-10-17T06:00:00Z', '2026-10-17T08:00:00Z'); \
         INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, at) VALUES \
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'granted', 'grant:markets:{USER}', 'Scholarship for the October cohort', '{STAFF}', '2026-10-17T06:00:00Z'), \
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 'revoked', 'revoke-access:markets:{USER}:2', 'Cohort place withdrawn', '{STAFF}', '2026-10-17T08:00:00Z'); \
         INSERT INTO academy.cert_revocations (public_id, user_id, cert_id, proposed_by, approved_by, revoked_by, reason, revoked_at) \
           VALUES ('PUB-OTHER-1', '{OTHER}', 'foundations-v1', 'founder-a', 'founder-b', '{STAFF}', 'Issued in error', '2026-10-17T07:00:00Z')"
    ));
    let page_size = Settings(obj(&[("ACADEMY_GRANT_AUDIT_PAGE_SIZE", Json::int(2))]));
    let operator = door(Store::Pool(t.db.pool()), page_size);
    let audit =
        |input: Option<&Json>| call(&operator, Some(&SCOPES), "admin.grantAudit", false, input);
    let opt = |v: &Json, k: &str| match v.get(k) {
        Some(Json::String(s)) => Some(s.clone()),
        Some(Json::Null) => None,
        other => panic!("{k}: {other:?}"),
    };
    // Newest first at the owner's page size, every line with its actor, time and reason, across pages without a repeat.
    let mut lines = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let input = cursor
            .as_ref()
            .map(|c| obj(&[("cursor", Json::str(c.clone()))]));
        let answer = audit(input.as_ref());
        let page = data(&answer);
        let items = arr(page.get("items").unwrap());
        assert!(items.len() <= 2);
        lines.extend(items.iter().cloned());
        cursor = opt(page, "nextCursor");
        pages += 1;
        if cursor.is_none() || pages >= 10 {
            break;
        }
    }
    let row = |l: &Json| {
        (
            s(l, "kind"),
            s(l, "target"),
            opt(l, "actorId"),
            opt(l, "reason"),
            s(l, "at"),
        )
    };
    let staff = || Some(STAFF.to_owned());
    let some = |v: &str| Some(v.to_owned());
    assert_eq!(
        lines.iter().map(row).collect::<Vec<_>>(),
        [
            (
                "access_revoked".into(),
                "markets".into(),
                staff(),
                some("Cohort place withdrawn"),
                "2026-10-17T08:00:00.000Z".into()
            ),
            (
                "certificate_revoked".into(),
                "foundations-v1".into(),
                staff(),
                some("Issued in error"),
                "2026-10-17T07:00:00.000Z".into()
            ),
            (
                "access_granted".into(),
                "markets".into(),
                staff(),
                some("Scholarship for the October cohort"),
                "2026-10-17T06:00:00.000Z".into()
            ),
            (
                "certificate_granted".into(),
                "foundations-v1".into(),
                None,
                None,
                "2026-10-17T05:00:00.000Z".into()
            ),
            (
                "certificate_granted".into(),
                "foundations-v1".into(),
                None,
                None,
                "2026-10-17T03:00:00.000Z".into()
            ),
            (
                "certificate_granted".into(),
                "other-cert".into(),
                None,
                None,
                "2026-10-16T03:00:00.000Z".into()
            ),
        ] as [(String, String, Option<String>, Option<String>, String); 6]
    );
    assert_eq!(pages, 3);
    let count = |input: &Json| arr(data(&audit(Some(input))).get("items").unwrap()).len();
    // A caller may ask for fewer than the owner's size, never more.
    assert_eq!(count(&obj(&[("limit", Json::int(1))])), 1);
    assert_eq!(count(&obj(&[("limit", Json::int(50))])), 2);
    // One course's lines, or one certificate's, never the other's; and how it came about only on a grant.
    let kinds = |input: &Json| {
        let answer = audit(Some(input));
        let page = data(&answer).clone();
        (
            arr(page.get("items").unwrap())
                .iter()
                .map(|l| (s(l, "kind"), opt(l, "source")))
                .collect::<Vec<_>>(),
            opt(&page, "nextCursor"),
        )
    };
    assert_eq!(
        kinds(&obj(&[("course", Json::str("markets"))])).0,
        [
            ("access_revoked".to_owned(), None),
            ("access_granted".to_owned(), some("staff"))
        ]
    );
    let (cert, next) = kinds(&obj(&[
        ("certificate", Json::str("foundations-v1")),
        ("limit", Json::int(2)),
    ]));
    assert_eq!(
        cert,
        [
            ("certificate_revoked".to_owned(), None),
            ("certificate_granted".to_owned(), some("issue"))
        ]
    );
    let rest = audit(Some(&obj(&[
        ("certificate", Json::str("foundations-v1")),
        ("cursor", Json::str(next.unwrap())),
    ])));
    let rest = data(&rest);
    assert_eq!(
        arr(rest.get("items").unwrap())
            .iter()
            .map(|l| (s(l, "kind"), s(l, "at")))
            .collect::<Vec<_>>(),
        [(
            "certificate_granted".to_owned(),
            "2026-10-17T03:00:00.000Z".to_owned()
        )]
    );
    assert!(null(rest, "nextCursor"));
    // A course and a certificate together, or a page size under 1, is a bad request, never "the page size is not set".
    let both = obj(&[
        ("course", Json::str("markets")),
        ("certificate", Json::str("foundations-v1")),
    ]);
    assert_eq!(trpc_code(&audit(Some(&both))).0, "BAD_REQUEST");
    assert_eq!(
        trpc_code(&audit(Some(&obj(&[("limit", Json::int(0))])))).0,
        "BAD_REQUEST"
    );
    // A blank owner page size refuses with its own code, whatever the caller asks for.
    let unset = door(Store::Pool(t.db.pool()), Settings::empty());
    let ten = obj(&[("limit", Json::int(10))]);
    assert_eq!(
        trpc_code(&call(
            &unset,
            Some(&SCOPES),
            "admin.grantAudit",
            false,
            Some(&ten)
        ))
        .1
        .as_deref(),
        Some("academy.grant_audit_list_limit_unset")
    );
    let reader = ["academy:read", "academy:write"];
    assert_eq!(
        trpc_code(&call(
            &unset,
            Some(&reader),
            "admin.grantAudit",
            false,
            Some(&ten)
        ))
        .0,
        "FORBIDDEN"
    );
}

#[test]
fn counts_enrolments_by_path_inside_the_utc_window_and_hides_account_ids() {
    let t = db!();
    let fourth = "44444444-4444-4444-8444-444444444444";
    t.exec(&format!(
        "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at, left_at) VALUES \
           ('{USER}', 'foundations', '2026-10-17T00:00:00Z', NULL), \
           ('{OTHER}', 'foundations', '2026-10-17T12:00:00Z', '2026-10-17T18:00:00Z'), \
           ('{USER}', 'markets', '2026-10-18T23:59:59Z', NULL), \
           ('{OTHER}', 'builder', '2026-09-01T00:00:00Z', NULL), \
           ('{fourth}', 'sovereign', '2026-10-19T00:00:00Z', NULL)"
    ));
    let d = door(Store::Pool(t.db.pool()), Settings::empty());
    let window = |from: &str, to: &str| obj(&[("from", Json::str(from)), ("to", Json::str(to))]);
    let read = |scopes: &[&str], from: &str, to: &str| {
        call(
            &d,
            Some(scopes),
            "admin.enrolments",
            false,
            Some(&window(from, to)),
        )
    };
    let counts = read(&SCOPES, "2026-10-17", "2026-10-18");
    assert_eq!(
        data(&counts).compact(),
        r#"{"from":"2026-10-17","to":"2026-10-18","total":3,"paths":[{"pathSlug":"foundations","count":2},{"pathSlug":"markets","count":1}]}"#
    );
    let empty = read(&SCOPES, "2020-01-01", "2020-01-02");
    assert_eq!(
        data(&empty).compact(),
        r#"{"from":"2020-01-01","to":"2020-01-02","total":0,"paths":[]}"#
    );
    let body = format!("{}{}", data(&counts).compact(), data(&empty).compact());
    for id in [USER, OTHER, fourth] {
        assert!(!body.contains(id));
    }
    assert_eq!(
        trpc_code(&read(&["academy:read"], "2026-10-17", "2026-10-18")).0,
        "FORBIDDEN"
    );
    assert_eq!(
        trpc_code(&read(&SCOPES, "2026-10-18", "2026-10-17")).0,
        "BAD_REQUEST"
    );
    assert_eq!(
        trpc_code(&read(&SCOPES, "2025-01-01", "2026-01-02")).0,
        "BAD_REQUEST"
    );
}
