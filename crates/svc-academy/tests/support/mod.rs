//! What the curriculum tests share: a fresh, migrated Postgres database per test (as `db_pg.rs` makes one), and the
//! service-call headers a caller sends.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};
use service_kit::pg::Pool;

fn admin_url() -> Option<String> {
    let pick = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = pick("TEST_DATABASE_URL_ACADEMY").or_else(|| pick("TEST_DATABASE_URL"));
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(
        url.is_some() || !required,
        "TEST_DATABASE_URL_ACADEMY or TEST_DATABASE_URL is required"
    );
    url
}

fn assert_test_database(c: &mut Client) {
    let name: String = c
        .query_one("SELECT current_database()", &[])
        .unwrap()
        .get(0);
    assert!(
        name.ends_with("_test"),
        "refusing: {name} is not a test database (its name must end in _test)"
    );
}

/// A database of its own, migrated by the `svc-academy migrate` binary, dropped when the test ends.
pub struct TestDb {
    admin: String,
    name: String,
    pub url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TestDb {
    /// None without a test database URL (and `REQUIRE_POSTGRES` unset).
    pub fn migrated() -> Option<TestDb> {
        let admin = admin_url()?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        assert_test_database(&mut a);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let name = format!(
            "itf_run_academy_cur_{}_{}_{nanos:x}_test",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        a.batch_execute(&format!("CREATE DATABASE \"{name}\""))
            .unwrap();
        let mut parsed = url::Url::parse(&admin).unwrap();
        parsed.set_path(&format!("/{name}"));
        let db = TestDb {
            admin,
            name,
            url: parsed.to_string(),
        };
        let mut c = db.client();
        assert_test_database(&mut c);
        c.batch_execute(
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"academy\"",
        )
        .unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_svc-academy"))
            .arg("migrate")
            .env("DATABASE_URL", &db.url)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "migrate: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Some(db)
    }

    pub fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }

    pub fn pool(&self) -> Pool {
        Pool::new(&self.url, 4)
    }

    /// The first column of every row, as text.
    pub fn texts(&self, sql: &str) -> Vec<String> {
        self.client()
            .query(sql, &[])
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Ok(mut a) = Client::connect(&self.admin, NoTls) {
            let _ = a.batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ));
        }
    }
}

/// The process clock in seconds.
pub fn now_seconds() -> i64 {
    service_kit::s2s::system_seconds()
}

/// `serviceAuthHeadersForBody(service, secret, body)` now.
pub fn legacy_headers(service: &str, secret: &str, body: &str) -> Vec<(String, String)> {
    service_kit::s2s::legacy_headers(service, secret, body, now_seconds()).unwrap()
}

/// A course staff made, as the authoring calls leave it (`CourseRecords.create`, `saveOutline`, `setState`): one row per
/// course, one section, the items in order. Those calls are another slice's; the assessment tests start from their rows.
pub struct SeededCourse {
    pub id: String,
    pub section: String,
    pub items: Vec<String>,
}

/// `create` then `saveOutline` (one section of `items`, each `(kind, title)`) then `setState(state)` at `at` (ISO).
pub fn seed_course(
    c: &mut Client,
    slug: &str,
    state: &str,
    creator: &str,
    at: &str,
    items: &[(&str, &str)],
) -> SeededCourse {
    let id: String = c
        .query_one(
            "INSERT INTO academy.courses (slug, title, pricing, state, revision, created_by, created_at, updated_at) \
             VALUES ($1, $2, 'free', $3, 3, $4::text::uuid, $5::text::timestamptz, $5::text::timestamptz) RETURNING id::text",
            &[&slug, &format!("TEST {slug}"), &state, &creator, &at],
        )
        .unwrap()
        .get(0);
    let section: String = c
        .query_one(
            "INSERT INTO academy.course_sections (course_id, position, title) VALUES ($1::text::uuid, 0, 'TEST section') RETURNING id::text",
            &[&id],
        )
        .unwrap()
        .get(0);
    let items = items
        .iter()
        .enumerate()
        .map(|(n, (kind, title))| {
            let position = i32::try_from(n).unwrap();
            c.query_one(
                "INSERT INTO academy.course_items (course_id, section_id, position, kind, title) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5) RETURNING id::text",
                &[&id, &section, &position, kind, title],
            )
            .unwrap()
            .get(0)
        })
        .collect();
    SeededCourse { id, section, items }
}

/// `CourseLearners.enrol` of a free course: one open enrolment row.
pub fn enrol(c: &mut Client, course: &str, user: &str, at: &str) {
    c.execute(
        "INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at) \
         VALUES ($1::text::uuid, $2::text::uuid, 'audit', $3::text::timestamptz)",
        &[&course, &user, &at],
    )
    .unwrap();
}

/// A refusal's code, or a panic naming what came back.
pub fn code_of<T: std::fmt::Debug>(r: Result<T, svc_academy::errors::Refusal>) -> String {
    match r {
        Err(svc_academy::errors::Refusal::Academy(e)) => e.code,
        Err(svc_academy::errors::Refusal::Trpc(e)) => e.cause.unwrap_or_default(),
        other => panic!("{other:?}"),
    }
}

/// JSON text as `JSON.parse` reads it.
pub fn jp(text: &str) -> service_kit::json::Json {
    service_kit::json::parse(text).unwrap()
}

/// `value.a.b.0.c`: a path of keys and array indexes; `null` when anything on the way is missing.
pub fn at(value: &service_kit::json::Json, path: &str) -> service_kit::json::Json {
    use service_kit::json::Json;
    let mut here = value;
    for step in path.split('.').filter(|s| !s.is_empty()) {
        let next = match (here, step.parse::<usize>()) {
            (Json::Array(items), Ok(i)) => items.get(i),
            _ => here.get(step),
        };
        match next {
            Some(n) => here = n,
            None => return Json::Null,
        }
    }
    here.clone()
}

/// `{ ...base, ...over }` of two objects, as JSON text in and out of `over`.
pub fn merged(base: &service_kit::json::Json, over: &str) -> service_kit::json::Json {
    use service_kit::json::Json;
    let (Json::Object(mut fields), Json::Object(extra)) = (base.clone(), jp(over)) else {
        panic!("merged: two objects");
    };
    for (k, v) in extra {
        match fields.iter_mut().find(|(key, _)| *key == k) {
            Some((_, slot)) => *slot = v,
            None => fields.push((k, v)),
        }
    }
    Json::Object(fields)
}

/// An object store in memory, standing in for the TypeScript tests' `put` and `get` functions: every put is recorded,
/// answered with `status`, and read back by its address without the signature.
#[derive(Default)]
pub struct MemoryObjects {
    pub status: std::sync::Mutex<u16>,
    pub stored: std::sync::Mutex<Vec<(String, Vec<u8>, String)>>,
}

impl MemoryObjects {
    pub fn new() -> MemoryObjects {
        MemoryObjects {
            status: std::sync::Mutex::new(200),
            stored: std::sync::Mutex::default(),
        }
    }

    pub fn set_status(&self, status: u16) {
        *self.status.lock().unwrap() = status;
    }

    pub fn stored(&self) -> Vec<(String, Vec<u8>, String)> {
        self.stored.lock().unwrap().clone()
    }
}

fn unsigned(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

impl svc_academy::assessment::storage::ObjectBytes for MemoryObjects {
    fn put(&self, url: &str, bytes: &[u8], content_type: &str) -> Result<u16, String> {
        let status = *self.status.lock().unwrap();
        self.stored
            .lock()
            .unwrap()
            .push((url.to_owned(), bytes.to_vec(), content_type.to_owned()));
        Ok(status)
    }

    fn get(&self, url: &str) -> Result<(u16, Vec<u8>), String> {
        let status = *self.status.lock().unwrap();
        let found = self
            .stored
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(u, _, _)| unsigned(u) == unsigned(url))
            .map(|(_, b, _)| b.clone());
        Ok(match found {
            Some(bytes) if (200..300).contains(&status) => (status, bytes),
            _ => (
                if (200..300).contains(&status) {
                    404
                } else {
                    status
                },
                Vec::new(),
            ),
        })
    }
}

/// The TypeScript tests' `STORAGE`.
pub fn test_storage() -> svc_academy::assessment::storage::StorageConfig {
    svc_academy::assessment::storage::StorageConfig {
        endpoint: "http://store.test".to_owned(),
        bucket: "b".to_owned(),
        access_key: "k".to_owned(),
        secret_key: "s".to_owned(),
        region: "r".to_owned(),
        ttl_seconds: Some(300.0),
    }
}

/// `Buffer.from(bytes).toString('base64')`.
pub fn base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl MemoryObjects {
    /// `store.clear()`: every object is gone.
    pub fn clear(&self) {
        self.stored.lock().unwrap().clear();
    }
}
