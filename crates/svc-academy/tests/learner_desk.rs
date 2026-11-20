//! J-academy-14: the staff desk for one learner, against a real Postgres: the port of the learner slice's parts of
//! `learners/learner-desk.db.test.ts` (a learner's progress as staff see it, a staff access record and its
//! reinstatement, staff marking an item complete, and a read-only session refused a change). Figures are TEST values,
//! not owner settings.
//!
//! The TypeScript reads the outcome through the learner page (`admin.learner`), a call of the community slice; here the
//! same facts are read from the rows that page reads (`access_grants`, `access_grant_events`, `cert_enrollments`,
//! `learner_events`). `readCurriculumItem`'s gate is `gates::assert_may_read`, the curriculum slice's port of it.
//! The tests of the community slice's desk calls (void an attempt, notes, tags) and the quiz start's refusal (the
//! assessment slice) are left to those slices' ports.
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
use svc_academy::curriculum::gates;
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::errors::Refusal;
use svc_academy::learner::desk::Desk;
use svc_academy::learner::service::{Learning, Options, Settle};
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const PATH: &str = "sovereign";
const EDGE_SECRET: &str = "an-academy-learner-desk-test-edge-secret";

fn now() -> i64 {
    system_now().0
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.code,
        other => panic!("{other:?}"),
    }
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

struct Desk0 {
    db: TestDb,
    store: Store,
    ports: Ports,
}

fn setup() -> Option<Desk0> {
    let db = TestDb::migrated()?;
    let store = Store::Pool(db.pool());
    Some(Desk0 {
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

impl Desk0 {
    fn learning(&self) -> Learning<'_> {
        Learning {
            pool: &self.store,
            ports: &self.ports,
            options: OPTIONS,
        }
    }

    fn desk(&self) -> Desk<'_> {
        Desk { pool: &self.store }
    }

    fn pool(&self) -> &service_kit::pg::Pool {
        self.store.pool().unwrap()
    }

    /// `items(academy)`: the learner's courses as the desk shows them.
    fn items(&self) -> Vec<Json> {
        let progress = self.desk().progress(USER, true).unwrap();
        arr(arr(progress.get("courses").unwrap())[0]
            .get("items")
            .unwrap())
        .clone()
    }

    fn enrol(&self, user: &str) {
        self.learning()
            .enrol_course(user, PATH, "audit", now())
            .unwrap();
    }

    /// The learner's access records for the course, as the page lists them: `(id, state, reason, expires_at)`.
    fn grants(&self) -> Vec<(String, String, String, Option<String>)> {
        self.db
            .client()
            .query(
                "SELECT id::text, state, reason, expires_at::text FROM academy.access_grants \
                 WHERE user_id = $1::text::uuid AND path_slug = $2",
                &[&USER, &PATH],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
            .collect()
    }

    /// One record's events in order: `(kind, actor_id)`.
    fn events(&self, grant_id: &str) -> Vec<(String, Option<String>)> {
        self.db
            .client()
            .query(
                "SELECT kind, actor_id::text FROM academy.access_grant_events WHERE grant_id = $1::text::uuid ORDER BY n",
                &[&grant_id],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }

    /// The page's audit, as the rows it is made from: every learner event and every access event of the learner.
    fn audit(&self) -> Vec<(String, String, String)> {
        self.db
            .client()
            .query(
                "SELECT kind, actor_id::text, reason FROM academy.learner_events WHERE user_id = $1::text::uuid \
                 UNION ALL SELECT 'grant_' || e.kind, e.actor_id::text, e.reason FROM academy.access_grant_events e \
                   JOIN academy.access_grants g ON g.id = e.grant_id WHERE g.user_id = $1::text::uuid \
                 UNION ALL SELECT 'extension_granted', granted_by::text, reason FROM academy.item_extensions \
                   WHERE user_id = $1::text::uuid",
                &[&USER],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get::<_, Option<String>>(1).unwrap_or_default(), r.get(2)))
            .collect()
    }
}

// ── access records ──────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn an_ended_record_refuses_the_courses_items_writes_its_expiry_once_and_is_reinstated_on_the_same_row()
 {
    let Some(t) = setup() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    t.enrol(USER);
    let slug = s(&t.items()[0], "slug");
    let t0 = now();
    t.desk()
        .grant_access(USER, PATH, "TEST", Some(t0 + 1000), STAFF, t0)
        .unwrap();
    // A repeat of the first grant is the same record.
    t.desk()
        .grant_access(USER, PATH, "TEST again", None, STAFF, t0)
        .unwrap();
    gates::assert_may_read(t.pool(), USER, &slug, t0).unwrap();
    let later = t0 + 5000;
    assert_eq!(
        code(gates::assert_may_read(t.pool(), USER, &slug, later)),
        "academy.grant_expired"
    );
    assert_eq!(
        code(gates::assert_may_read(t.pool(), USER, &slug, later)),
        "academy.grant_expired"
    );
    assert_eq!(
        code(t.learning().mark_complete(USER, "none", &slug, later)),
        "academy.grant_expired"
    );
    // Granting again on an ended record refuses: it is reinstated on its own row instead.
    assert_eq!(
        code(
            t.desk()
                .grant_access(USER, PATH, "TEST", None, STAFF, later)
        ),
        "academy.grant_expired"
    );
    // `learners.page(USER, true, later)` settles first; the read above already did.
    gates::settle_expiries(t.pool(), USER, later).unwrap();
    let ended = t.grants();
    assert_eq!(ended.len(), 1);
    assert_eq!(
        (ended[0].1.as_str(), ended[0].2.as_str()),
        ("expired", "TEST")
    );
    let grant_id = ended[0].0.clone();
    let events = t.events(&grant_id);
    assert_eq!(
        events.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        ["granted", "expired"]
    );
    assert_eq!(events[1].1, None);

    // A reinstatement names the event it becomes; a stale number refuses and changes nothing; blank reasons refuse.
    let reinstate = |user: &str, reason: &str, n: i64| {
        t.desk()
            .reinstate(user, &grant_id, reason, None, n, STAFF, now())
    };
    assert_eq!(code(reinstate(USER, " ", 3)), "academy.reason_required");
    assert_eq!(code(reinstate(USER, "TEST", 2)), "academy.revision_stale");
    assert_eq!(code(reinstate(OTHER, "TEST", 3)), "academy.grant_not_found");
    reinstate(USER, "TEST back", 3).unwrap();
    // A replay of the same reinstatement answers and writes nothing; one more on the live record refuses.
    reinstate(USER, "TEST back", 3).unwrap();
    assert_eq!(code(reinstate(USER, "TEST", 4)), "academy.grant_active");
    let back = t.grants();
    assert_eq!(back.len(), 1);
    assert_eq!(
        (back[0].0.as_str(), back[0].1.as_str(), back[0].3.as_deref()),
        (grant_id.as_str(), "granted", None)
    );
    assert_eq!(
        t.events(&grant_id)
            .iter()
            .map(|e| e.0.as_str())
            .collect::<Vec<_>>(),
        ["granted", "expired", "reinstated"]
    );
    gates::assert_may_read(t.pool(), USER, &slug, now()).unwrap();
}

#[test]
fn a_learner_with_no_record_keeps_the_free_enrolment_as_access_and_a_staff_grant_without_a_reason_refuses()
 {
    let Some(t) = setup() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    t.enrol(USER);
    // The page's one access entry is the free enrolment: no stored record (`id: null`), and the enrolment open.
    let free = |t: &Desk0| {
        assert!(t.grants().is_empty());
        let open: i64 =
            t.db.client()
                .query_one(
                    "SELECT count(*) FROM academy.cert_enrollments \
                 WHERE user_id = $1::text::uuid AND path_slug = $2 AND left_at IS NULL",
                    &[&USER, &PATH],
                )
                .unwrap()
                .get(0);
        assert_eq!(open, 1);
    };
    free(&t);
    let mine = t.learning().my_access_grants(USER).unwrap();
    let mine = arr(&mine);
    assert_eq!(mine.len(), 1);
    assert_eq!(
        (s(&mine[0], "slug"), s(&mine[0], "source")),
        (PATH.to_owned(), "free".to_owned())
    );
    assert_eq!(mine[0].get("expiresAt"), Some(&Json::Null));
    assert_eq!(
        code(t.desk().grant_access(USER, PATH, "", None, STAFF, now())),
        "academy.reason_required"
    );
    let n = now();
    assert_eq!(
        code(
            t.desk()
                .grant_access(USER, PATH, "TEST", Some(n - 1000), STAFF, n)
        ),
        "academy.window_invalid"
    );
    free(&t);
}

// ── progress and overrides ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn shows_an_undone_items_tombstone_marks_an_item_complete_only_with_a_reason_once_per_key() {
    let Some(t) = setup() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    t.enrol(USER);
    let items = t.items();
    let (first, second) = (s(&items[0], "slug"), s(&items[1], "slug"));
    let done = t
        .learning()
        .mark_complete(USER, "none", &first, now())
        .unwrap();
    t.learning()
        .undo_complete(USER, &first, &s(&done, "completedAt"), "TEST-undo", now())
        .unwrap();
    let row = t.items()[0].clone();
    assert_eq!(s(&row, "status"), "undone");
    assert_eq!(
        arr(row.get("history").unwrap())
            .iter()
            .map(|h| s(h, "event"))
            .collect::<Vec<_>>(),
        ["completed", "undone"]
    );

    let key = format!("override:{USER}:{second}:1");
    let mark = |reason: &str| {
        t.learning()
            .staff_mark_complete(USER, &second, reason, &key, STAFF, now())
    };
    assert_eq!(code(mark("  ")), "academy.reason_required");
    assert_eq!(s(&t.items()[1], "status"), "not_started");
    mark("TEST offline").unwrap();
    mark("TEST offline").unwrap();
    assert_eq!(s(&t.items()[1], "status"), "completed");
    let audit: Vec<_> = t
        .audit()
        .into_iter()
        .filter(|a| a.0 == "marked_complete")
        .collect();
    assert_eq!(
        audit,
        [(
            "marked_complete".to_owned(),
            STAFF.to_owned(),
            "TEST offline".to_owned()
        )]
    );
}

// ── notes, tags and permissions ─────────────────────────────────────────────────────────────────────────────────────

fn door(store: Store) -> AcademyDoor {
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
        settings: Settings::empty(),
        now: system_now,
    })
    .unwrap()
}

/// `caller(academy, userId, scopes)`: one tRPC call as that session. A query is a GET, a mutation a POST.
fn call(
    door: &AcademyDoor,
    user: &str,
    scopes: &[&str],
    path: &str,
    mutation: bool,
    input: &Json,
) -> (u16, Json) {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        ("userId", Json::str(user)),
        ("sid", Json::str("44444444-4444-4444-8444-444444444444")),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(true)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let mut headers = vec![
        (
            "x-intafaced-principal-sig".to_owned(),
            edge::sign(&raw, EDGE_SECRET, "DE").unwrap(),
        ),
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ];
    let body = input.compact();
    let res = if mutation {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let url = format!("/trpc/{path}");
        door.handle(&Request {
            method: "POST",
            url: &url,
            headers: &headers,
            body: &body,
        })
    } else {
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
        let url = format!("/trpc/{path}?input={q}");
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

#[test]
fn a_read_only_session_reads_the_page_with_no_change_allowed_and_a_direct_change_refuses_as_not_permitted()
 {
    let Some(t) = setup() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    t.enrol(USER);
    let door = door(Store::Pool(t.db.pool()));
    let who = Json::obj([("userId", Json::str(USER))]);
    let reader = ["admin:read"];
    let progress = call(&door, STAFF, &reader, "admin.learnerProgress", false, &who);
    assert_eq!(data(&progress).get("canChange"), Some(&Json::Bool(false)));
    let slug = s(&t.items()[0], "slug");
    let mark = |key: &str| {
        Json::obj([
            ("userId", Json::str(USER)),
            ("itemSlug", Json::str(slug.clone())),
            ("reason", Json::str("TEST")),
            ("key", Json::str(key)),
        ])
    };
    let refused = call(
        &door,
        STAFF,
        &reader,
        "admin.markCompleteFor",
        true,
        &mark("override:x"),
    );
    let err = refused.1.get("error").unwrap();
    assert_eq!(
        err.get("data").and_then(|d| d.get("code")),
        Some(&Json::str("FORBIDDEN")),
        "{err:?}"
    );
    assert!(
        s(err, "message").contains("academy.permission_denied"),
        "{err:?}"
    );
    assert!(t.audit().is_empty());
    let writer = ["admin:read", "admin:write"];
    let progress = call(&door, STAFF, &writer, "admin.learnerProgress", false, &who);
    assert_eq!(data(&progress).get("canChange"), Some(&Json::Bool(true)));
    data(&call(
        &door,
        STAFF,
        &writer,
        "admin.markCompleteFor",
        true,
        &mark("override:y"),
    ));
    assert_eq!(s(&t.items()[0], "status"), "completed");
}
