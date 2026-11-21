//! What the cross-slice tests share: the whole door over a migrated database, driven as a signed learner and a signed
//! staff member, on a clock the test moves, with a bus that records the XP it took and TEST video storage settings.
//! Every row a test needs is written through the slices' own calls.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::panic,
    reason = "a test helper: each test file uses part of it, and a failure is the point"
)]

use std::cell::Cell;
use std::sync::Arc;

use service_kit::json::Json;
use service_kit::time::Instant;
use svc_academy::db::Store;
use svc_academy::door::AcademyDoor;
use svc_academy::ports::{Bus, Ports};

use crate::community_support::{FakeBus, data, door_with, mutate, query, refused};
use crate::support::TestDb;

pub const USER: &str = "11111111-1111-4111-8111-111111111111";
pub const OTHER: &str = "22222222-2222-4222-8222-222222222222";
pub const STAFF: &str = "33333333-3333-4333-8333-333333333333";
pub const LEARNER: [&str; 2] = ["academy:read", "academy:write"];
pub const ADMIN: [&str; 2] = ["admin:read", "admin:write"];
/// 2030-01-01T00:00:00.000Z.
pub const T0: i64 = 1_893_456_000_000;

thread_local! {
    static NOW: Cell<i64> = const { Cell::new(T0) };
}

/// The door's clock: this thread's test time (each test drives the door on its own thread).
pub fn now() -> Instant {
    Instant(NOW.with(Cell::get))
}

pub fn advance(ms: i64) {
    NOW.with(|n| n.set(n.get() + ms));
}

/// The bus the door publishes XP on, kept readable by the test.
struct Shared(Arc<FakeBus>);

impl Bus for Shared {
    fn id(&self) -> &str {
        "bus"
    }
    fn usable(&self) -> bool {
        true
    }
    fn publish(&self, subject: &str, msg_id: &str, payload: &Json) -> Result<(), String> {
        self.0.publish(subject, msg_id, payload)
    }
}

pub struct Run {
    pub db: TestDb,
    pub door: AcademyDoor,
    pub bus: Arc<FakeBus>,
}

/// The TEST owner values every cross-slice test runs with.
fn settings() -> Json {
    Json::obj([
        ("ACADEMY_PROGRAMME_MAX_COURSES", Json::int(4)),
        ("ACADEMY_CERT_ISSUE_SWEEP_SECONDS", Json::int(60)),
        ("ACADEMY_CERT_ISSUED_ROWS", Json::int(50)),
        ("ACADEMY_GRANT_AUDIT_PAGE_SIZE", Json::int(10)),
        ("ACADEMY_CERT_VERIFY_RATE_MAX", Json::int(100)),
        ("ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS", Json::int(60)),
        ("ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS", Json::int(30)),
        ("ACADEMY_VIDEO_MIN_TIER", Json::str("none")),
        ("ACADEMY_VIDEO_MIN_STAKE", Json::str("0")),
        (
            "ACADEMY_VIDEO_S3_ENDPOINT",
            Json::str("https://videos.test"),
        ),
        ("ACADEMY_VIDEO_S3_BUCKET", Json::str("test-bucket")),
        ("ACADEMY_VIDEO_S3_ACCESS_KEY", Json::str("TEST-access")),
        ("ACADEMY_VIDEO_S3_SECRET_KEY", Json::str("TEST-secret")),
        ("ACADEMY_VIDEO_S3_REGION", Json::str("us-east-1")),
        ("ACADEMY_VIDEO_URL_TTL_SECONDS", Json::int(300)),
    ])
}

/// A fresh database and the door over it at `T0`; `None` (the test skips) without a test database URL.
pub fn setup() -> Option<Run> {
    setup_with(|_| {})
}

/// `setup`, with the ports `wire` changes (an approvals stand-in, say) on top of the recording bus.
pub fn setup_with(wire: impl FnOnce(&mut Ports)) -> Option<Run> {
    let db = TestDb::migrated()?;
    NOW.with(|n| n.set(T0));
    let bus = Arc::new(FakeBus::default());
    let mut ports = Ports::unwired();
    ports.bus = Box::new(Shared(Arc::clone(&bus)));
    wire(&mut ports);
    let door = door_with(Store::Pool(db.pool()), settings(), ports, now);
    Some(Run { db, door, bus })
}

impl Run {
    /// A mutation as the learner, answered.
    pub fn learner(&self, path: &str, input: &Json) -> Json {
        data(&mutate(&self.door, USER, &LEARNER, path, input))
    }

    /// A query as the learner, answered.
    pub fn read(&self, path: &str, input: &Json) -> Json {
        data(&query(&self.door, USER, &LEARNER, path, Some(input)))
    }

    /// A mutation as staff who may change, answered.
    pub fn staff(&self, path: &str, input: &Json) -> Json {
        data(&mutate(&self.door, STAFF, &ADMIN, path, input))
    }

    /// A query as staff, answered.
    pub fn staff_read(&self, path: &str, input: &Json) -> Json {
        data(&query(&self.door, STAFF, &ADMIN, path, Some(input)))
    }

    /// A staff mutation's refusal code.
    pub fn staff_refusal(&self, path: &str, input: &Json) -> String {
        refused(&mutate(&self.door, STAFF, &ADMIN, path, input)).2
    }

    /// A learner query's refusal code.
    pub fn read_refusal(&self, path: &str, input: &Json) -> String {
        refused(&query(&self.door, USER, &LEARNER, path, Some(input))).2
    }

    /// The XP awards that reached the bus, by message id.
    pub fn awards(&self) -> Vec<String> {
        self.bus.sent().into_iter().map(|(_, id, _)| id).collect()
    }
}
