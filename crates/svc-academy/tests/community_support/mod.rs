//! What the community slice's Postgres tests share: a migrated database and its store, the course rows the authoring
//! calls (another slice's) leave, a bus that records or fails, refusal readers, and the door driven as a signed caller.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig};
use svc_academy::errors::Refusal;
use svc_academy::ports::{Bus, Ports};
use svc_academy::settings::Settings;

use crate::support::TestDb;

pub const SECRET: &str = "an-academy-community-edge-secret";

/// A fresh migrated database and a store over it; `None` (the test skips) without a test database URL.
pub fn setup() -> Option<(TestDb, Store)> {
    let db = TestDb::migrated()?;
    let store = Store::Pool(db.pool());
    Some((db, store))
}

/// `new Date(iso).getTime()` as an instant.
pub fn at(iso: &str) -> Instant {
    service_kit::time::js_date(iso).unwrap()
}

pub fn exec(db: &TestDb, sql: &str) {
    db.client().batch_execute(sql).unwrap();
}

/// One text value from a query.
pub fn one(db: &TestDb, sql: &str) -> String {
    db.texts(sql).into_iter().next().unwrap_or_default()
}

/// A course as `CourseRecords.create` and `setState` leave it: one row in `state`, created by `by`, at `now`.
pub fn course(db: &TestDb, slug: &str, state: &str, by: &str, now: &str) -> String {
    let mut c = db.client();
    let row = c
        .query_one(
            "INSERT INTO academy.courses (slug, title, summary, thumbnail_url, pricing, state, revision, created_by, created_at, updated_at)
             VALUES ($1, $2, NULL, NULL, 'free', $3, 1, $4::text::uuid, $5::text::timestamptz, $5::text::timestamptz)
             RETURNING id::text",
            &[&slug, &format!("TEST {slug}"), &state, &by, &now],
        )
        .unwrap();
    row.get(0)
}

/// A learner enrolled in a course (`course_enrolments`, track audit).
pub fn enrol(db: &TestDb, course_id: &str, user: &str, now: &str) {
    db.client()
        .execute(
            "INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at)
             VALUES ($1::text::uuid, $2::text::uuid, 'audit', $3::text::timestamptz)",
            &[&course_id, &user, &now],
        )
        .unwrap();
}

/// A learner enrolled in a curriculum path (`cert_enrollments`).
pub fn enrol_path(db: &TestDb, user: &str, path: &str, now: &str) {
    db.client()
        .execute(
            "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) VALUES ($1::text::uuid, $2, $3::text::timestamptz)",
            &[&user, &path, &now],
        )
        .unwrap();
}

/// The refusal's code: an `AcademyError`'s code, or a family refusal's cause.
pub fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.code,
        Err(Refusal::Trpc(e)) => e.cause.clone().unwrap_or_default(),
        other => panic!("not a refusal: {other:?}"),
    }
}

/// The refusal's message as the caller reads it.
pub fn message<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.message,
        Err(Refusal::Trpc(e)) => e.message,
        other => panic!("not a refusal: {other:?}"),
    }
}

/// A field of an answer.
pub fn get<'a>(j: &'a Json, key: &str) -> &'a Json {
    j.get(key)
        .unwrap_or_else(|| panic!("no {key} in {}", j.compact()))
}

pub fn s(j: &Json, key: &str) -> String {
    match get(j, key) {
        Json::String(v) => v.clone(),
        other => panic!("{key} is {}", other.compact()),
    }
}

pub fn n(j: &Json, key: &str) -> i64 {
    match get(j, key) {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "test counts are small integers"
        )]
        Json::Number(v) => *v as i64,
        other => panic!("{key} is {}", other.compact()),
    }
}

pub fn b(j: &Json, key: &str) -> bool {
    match get(j, key) {
        Json::Bool(v) => *v,
        other => panic!("{key} is {}", other.compact()),
    }
}

pub fn arr<'a>(j: &'a Json, key: &str) -> &'a [Json] {
    match get(j, key) {
        Json::Array(v) => v,
        other => panic!("{key} is {}", other.compact()),
    }
}

pub fn items(j: &Json) -> &[Json] {
    match j {
        Json::Array(v) => v,
        other => panic!("not a list: {}", other.compact()),
    }
}

/// A bus that records what it took, or fails while `fail` is set (`ModerationNoticePublisher` in the TypeScript tests).
#[derive(Default)]
pub struct FakeBus {
    pub sent: Mutex<Vec<(String, String, Json)>>,
    pub fail: AtomicBool,
}

impl FakeBus {
    pub fn set_fail(&self, on: bool) {
        self.fail.store(on, Ordering::SeqCst);
    }
    pub fn sent(&self) -> Vec<(String, String, Json)> {
        self.sent.lock().unwrap().clone()
    }
}

impl Bus for FakeBus {
    fn id(&self) -> &str {
        "fake"
    }
    fn usable(&self) -> bool {
        true
    }
    fn publish(&self, subject: &str, msg_id: &str, payload: &Json) -> Result<(), String> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("bus down".to_owned());
        }
        self.sent
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned(), payload.clone()));
        Ok(())
    }
}

/// A door over `store`, with the owner settings given and the test process's switches.
pub fn door(store: Store, settings: Json) -> AcademyDoor {
    door_with(
        store,
        settings,
        Ports::unwired(),
        svc_academy::door::system_now,
    )
}

/// The door over `store` with these ports and this clock: a run through several slices' real calls.
pub fn door_with(store: Store, settings: Json, ports: Ports, now: fn() -> Instant) -> AcademyDoor {
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
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
        ports,
        settings: Settings(settings),
        now,
    })
    .unwrap()
}

fn headers(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    vec![
        (
            "x-intafaced-principal-sig".to_owned(),
            edge::sign(&raw, SECRET, "DE").unwrap(),
        ),
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]
}

/// A tRPC query (`GET`) as `user` with `scopes`: the status and the parsed body.
pub fn query(
    door: &AcademyDoor,
    user: &str,
    scopes: &[&str],
    path: &str,
    input: Option<&Json>,
) -> (u16, Json) {
    query_from(door, user, scopes, path, input, "")
}

/// A tRPC query's address, its input URL-encoded as the client sends it.
fn url_of(path: &str, input: Option<&Json>) -> String {
    match input {
        None => format!("/trpc/{path}"),
        Some(i) => {
            let q: String = i
                .compact()
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
    }
}

/// A visitor's query: no session, only the region header the edge adds.
pub fn visitor(door: &AcademyDoor, path: &str, input: Option<&Json>) -> (u16, Json) {
    let headers = [("x-intafaced-region".to_owned(), "DE".to_owned())];
    let url = url_of(path, input);
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers: &headers,
        body: "",
    });
    (res.status, json::parse(&res.body).unwrap())
}

/// A tRPC query from the TCP peer `peer` (blank when unknown).
pub fn query_from(
    door: &AcademyDoor,
    user: &str,
    scopes: &[&str],
    path: &str,
    input: Option<&Json>,
    peer: &str,
) -> (u16, Json) {
    let headers = headers(user, scopes);
    let url = url_of(path, input);
    let req = Request {
        method: "GET",
        url: &url,
        headers: &headers,
        body: "",
    };
    let res = if peer.is_empty() {
        door.handle(&req)
    } else {
        door.handle_from(&req, "req-from-peer", peer)
    };
    (res.status, json::parse(&res.body).unwrap())
}

/// A tRPC mutation (`POST`) as `user` with `scopes`.
pub fn mutate(
    door: &AcademyDoor,
    user: &str,
    scopes: &[&str],
    path: &str,
    input: &Json,
) -> (u16, Json) {
    let headers = headers(user, scopes);
    let body = input.compact();
    let url = format!("/trpc/{path}");
    let res = door.handle(&Request {
        method: "POST",
        url: &url,
        headers: &headers,
        body: &body,
    });
    (res.status, json::parse(&res.body).unwrap())
}

/// The data of a 200 answer.
pub fn data(answer: &(u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap_or(Json::Null)
}

/// A refused answer's status, message and cause code.
pub fn refused(answer: &(u16, Json)) -> (u16, String, String) {
    let err = answer
        .1
        .get("error")
        .unwrap_or_else(|| panic!("not refused: {}", answer.1.compact()));
    let text = |v: Option<&Json>| match v {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    };
    let d = err.get("data");
    (
        answer.0,
        text(err.get("message")),
        text(d.and_then(|d| d.get("cause")).and_then(|c| c.get("code"))),
    )
}
