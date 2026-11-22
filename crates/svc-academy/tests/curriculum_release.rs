//! The reads an item passes before its body is served, and the hub's slot, against a real Postgres: the ports of the
//! assertions on what the curriculum calls read in `release/access.test.ts` (`decideRelease`, `refuseRelease`),
//! `release/access.db.test.ts` ("sends no lesson body while locked"), `curriculum/public-catalogue.test.ts`
//! (`assertMayReadSignedOut`), `learners/learner-desk.db.test.ts` (an ended record refuses and writes its expiry once),
//! `curriculum/featured.db.test.ts` and `curriculum/learn-hub.db.test.ts` (what the hub shows). The rows those tests
//! write through the authoring and staff calls (other slices') are written here as the rows those calls leave.
//!
//! The expiry is the one write a curriculum read makes, so its failure branches are proven at each point: a second
//! read writes nothing more, two reads at once write one event, and a failure after the state change rolls the state
//! back with nothing written.
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
use service_kit::pg::Pool;
use service_kit::server::Request;
use support::TestDb;
use svc_academy::curriculum::gates::{self, Decision, Window};
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::errors::Refusal;
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

const SECRET: &str = "an-academy-curriculum-release-edge-secret";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const STAFF: &str = "99999999-9999-4999-8999-999999999999";
const GRANT: &str = "33333333-3333-4333-8333-333333333333";
const FIRST: &str = "foundations-risk-first";
const SECOND: &str = "foundations-order-types";
const THIRD: &str = "foundations-fees-are-real";

fn at(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.code,
        other => panic!("{other:?}"),
    }
}

fn message<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.message,
        other => panic!("{other:?}"),
    }
}

// ── release/access.test.ts: the decision ────────────────────────────────────────────────────────────────────────────

fn window(from: &str, until: &str, due: Option<&str>) -> Window {
    Window {
        from: at(from),
        until: at(until),
        due: due.map(at),
    }
}

#[test]
fn a_missing_prerequisite_locks_before_a_window_and_refuses_with_it() {
    let w = window(
        "2026-10-01T00:00:00Z",
        "2026-10-20T00:00:00Z",
        Some("2026-10-15T00:00:00Z"),
    );
    let d = gates::decide(
        false,
        true,
        &[FIRST.to_owned()],
        Some(w),
        None,
        at("2026-10-10T00:00:00Z"),
        None,
    );
    assert_eq!(
        d,
        Decision {
            state: "locked",
            missing: vec![FIRST.to_owned()],
            lock: Some("prerequisite")
        }
    );
    assert_eq!(code(gates::refuse(&d)), "academy.prerequisite_unmet");
    assert_eq!(
        message(gates::refuse(&d)),
        format!("academy.prerequisite_unmet missing={FIRST}")
    );
}

#[test]
fn the_due_locks_and_only_an_extension_past_it_opens_again() {
    let w = window(
        "2026-10-01T00:00:00Z",
        "2026-10-20T00:00:00Z",
        Some("2026-10-15T00:00:00Z"),
    );
    let now = at("2026-10-16T00:00:00Z");
    assert_eq!(
        gates::decide(false, false, &[], Some(w), None, now, None).lock,
        Some("window")
    );
    let extended = gates::decide(
        false,
        false,
        &[],
        Some(w),
        Some(at("2026-10-18T00:00:00Z")),
        now,
        None,
    );
    assert_eq!(extended.state, "unlocked");
    let early = gates::decide(
        false,
        false,
        &[],
        Some(window("2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z", None)),
        Some(at("2026-11-01T00:00:00Z")),
        at("2026-09-01T00:00:00Z"),
        None,
    );
    assert_eq!((early.state, early.lock), ("locked", Some("window")));
    assert_eq!(code(gates::refuse(&early)), "academy.window_invalid");
    assert_eq!(
        message(gates::refuse(&early)),
        "academy.window_invalid outside the published window"
    );
}

#[test]
fn started_shows_only_once_open_and_completed_wins() {
    let from = at("2026-10-01T00:00:00Z");
    assert_eq!(
        gates::decide(false, true, &[], None, None, from, None).state,
        "started"
    );
    let backwards = window("2026-10-20T00:00:00Z", "2026-10-01T00:00:00Z", None);
    let done = gates::decide(
        true,
        true,
        &[FIRST.to_owned()],
        Some(backwards),
        None,
        from,
        None,
    );
    assert_eq!(
        done,
        Decision {
            state: "completed",
            missing: vec![],
            lock: None
        }
    );
    assert_eq!(gates::refuse(&done), Ok(()));
}

#[test]
fn an_open_item_waits_for_its_course_to_start() {
    let start = at("2026-10-30T09:00:00Z");
    let before = at("2026-10-29T09:00:00Z");
    let d = |completed, missing: &[String], now| {
        gates::decide(completed, false, missing, None, None, now, Some(start))
    };
    assert_eq!(
        d(false, &[], before),
        Decision {
            state: "locked",
            missing: vec![],
            lock: Some("window")
        }
    );
    let gated = d(false, &["a".to_owned()], before);
    assert_eq!(
        (gated.lock, gated.missing),
        (Some("prerequisite"), vec!["a".to_owned()])
    );
    assert_eq!(d(true, &[], before).state, "completed");
    assert_eq!(d(false, &[], start).lock, None);
    assert_eq!(
        gates::decide(false, false, &[], None, None, before, None).lock,
        None
    );
}

// ── Over Postgres ───────────────────────────────────────────────────────────────────────────────────────────────────

fn db() -> Option<(TestDb, Pool)> {
    let db = TestDb::migrated()?;
    let pool = db.pool();
    Some((db, pool))
}

fn exec(db: &TestDb, sql: &str) {
    db.client().batch_execute(sql).unwrap();
}

fn door(pool: Pool) -> AcademyDoor {
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        // The test process: the jurisdiction guard's switches off, as the TypeScript tests run.
        env: [
            ("APP_ENV", "test"),
            ("NODE_ENV", "test"),
            ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
            ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect(),
        store: Store::Pool(pool),
        ports: Ports::unwired(),
        settings: Settings::empty(),
        now: system_now,
    })
    .unwrap()
}

/// `GET /trpc/<path>?input=...` as a learner with `academy:read`: the status and the parsed body.
fn learner(door: &AcademyDoor, path: &str, input: &Json) -> (u16, Json) {
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        ("scopes", Json::Array(vec![Json::str("academy:read")])),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(USER)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let headers = vec![
        (
            "x-intafaced-principal-sig".to_owned(),
            edge::sign(&raw, SECRET, "DE").unwrap(),
        ),
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ];
    let q: String = input
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
    let url = format!("/trpc/{path}?input={q}");
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers: &headers,
        body: "",
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn data(answer: &(u16, Json)) -> &Json {
    assert_eq!(answer.0, 200, "{:?}", answer.1);
    answer.1.get("result").and_then(|r| r.get("data")).unwrap()
}

/// The tRPC code and message of a refusal.
fn refusal(answer: &(u16, Json)) -> (String, String, String) {
    let err = answer.1.get("error").unwrap();
    let s = |v: Option<&Json>| match v {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{other:?}"),
    };
    let d = err.get("data").unwrap();
    (
        s(d.get("code")),
        s(err.get("message")),
        s(d.get("cause").and_then(|c| c.get("code"))),
    )
}

fn slug(s: &str) -> Json {
    Json::obj([("slug", Json::str(s))])
}

fn localized(s: &str, locale: &str) -> Json {
    Json::obj([("slug", Json::str(s)), ("locale", Json::str(locale))])
}

#[test]
fn a_locked_item_sends_no_body_and_sends_it_once_the_learner_is_open() {
    let Some((db, pool)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    exec(
        &db,
        &format!("INSERT INTO academy.item_prerequisites VALUES ('{SECOND}', '{FIRST}')"),
    );
    let door = door(pool);
    let want = (
        "PRECONDITION_FAILED".to_owned(),
        format!("academy.prerequisite_unmet missing={FIRST}"),
        "academy.prerequisite_unmet".to_owned(),
    );
    for answer in [
        learner(&door, "curriculumItem", &slug(SECOND)),
        learner(&door, "curriculumItemLocalized", &localized(SECOND, "fr")),
    ] {
        assert_eq!(answer.0, 412, "{:?}", answer.1);
        assert_eq!(refusal(&answer), want);
        assert!(!answer.1.compact().contains("\"body\""));
    }
    let open = learner(&door, "curriculumItem", &slug(FIRST));
    let Some(Json::String(body)) = data(&open).get("body") else {
        panic!()
    };
    assert!(body.contains("# Risk first"));
    let fr = learner(&door, "curriculumItemLocalized", &localized(FIRST, "fr"));
    assert_eq!(data(&fr).get("body"), Some(&Json::str(body.clone())));
    assert_eq!(data(&fr).get("fellBack"), Some(&Json::Bool(true)));
    // `markCurriculumComplete`'s row (the learner slice's call).
    exec(
        &db,
        &format!(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug) VALUES ('{USER}', '{FIRST}')"
        ),
    );
    let unlocked = learner(&door, "curriculumItem", &slug(SECOND));
    let Some(Json::String(second)) = data(&unlocked).get("body") else {
        panic!()
    };
    assert!(second.contains("# Order types you will actually use"));
    let en = learner(&door, "curriculumItemLocalized", &localized(SECOND, "en"));
    assert_eq!(data(&en).get("body"), Some(&Json::str(second.clone())));
    assert_eq!(data(&en).get("fellBack"), Some(&Json::Bool(false)));

    exec(
        &db,
        &format!(
            "INSERT INTO academy.item_windows VALUES ('{THIRD}', '2026-10-01Z', '2026-10-02Z', NULL)"
        ),
    );
    for answer in [
        learner(&door, "curriculumItem", &slug(THIRD)),
        learner(&door, "curriculumItemLocalized", &localized(THIRD, "fr")),
    ] {
        assert_eq!(answer.0, 400);
        let (trpc, _, cause) = refusal(&answer);
        assert_eq!(
            (trpc.as_str(), cause.as_str()),
            ("BAD_REQUEST", "academy.window_invalid")
        );
    }
    let now = at("2026-10-10T00:00:00Z");
    let pool = db.pool();
    let r = gates::assert_may_read(&pool, USER, THIRD, now);
    assert_eq!(
        message(r),
        "academy.window_invalid outside the published window"
    );
}

#[test]
fn the_signed_out_check_opens_asks_for_sign_in_and_applies_windows_and_the_course_start_to_everyone()
 {
    let Some((db, pool)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let now = at("2026-10-23T12:00:00Z");
    let check = |s: &str| gates::assert_may_read_signed_out(&pool, s, now);
    assert_eq!(check(FIRST), Ok(()));
    assert!(gates::opens_signed_out(&pool, FIRST, now).unwrap());
    exec(
        &db,
        &format!("INSERT INTO academy.item_prerequisites VALUES ('{FIRST}', '{SECOND}')"),
    );
    assert_eq!(code(check(FIRST)), "academy.sign_in_required");
    assert!(!gates::opens_signed_out(&pool, FIRST, now).unwrap());
    exec(&db, "TRUNCATE academy.item_prerequisites");
    exec(
        &db,
        &format!(
            "INSERT INTO academy.item_windows VALUES ('{FIRST}', '2026-11-01Z', '2026-12-01Z', NULL)"
        ),
    );
    assert_eq!(code(check(FIRST)), "academy.window_invalid");
    exec(&db, "TRUNCATE academy.item_windows");
    exec(
        &db,
        &format!(
            "INSERT INTO academy.course_starts VALUES ('foundations', '2026-10-30T09:00:00Z', 'TEST', '{STAFF}', now())"
        ),
    );
    assert_eq!(code(check(FIRST)), "academy.window_invalid");
    assert_eq!(code(check("no-such-item")), "academy.curriculum_not_found");
    // A slug is trimmed before it is looked up, as `requireCurriculumSlug` trims.
    assert_eq!(code(check(&format!(" {FIRST} "))), "academy.window_invalid");
}

/// The rows `LearnerDesk.grantAccess` leaves: the record and its `granted` event.
fn grant(db: &TestDb, expires: &str) {
    exec(
        db,
        &format!(
            "INSERT INTO academy.access_grants (id, user_id, path_slug, source, reason, starts_at, expires_at, state, created_at, updated_at) \
               VALUES ('{GRANT}', '{USER}', 'foundations', 'staff', 'TEST', '2026-10-01Z', '{expires}', 'granted', '2026-10-01Z', '2026-10-01Z'); \
             INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at) \
               VALUES ('{GRANT}', 1, 'granted', 'grant:{GRANT}:1', 'TEST', '{STAFF}', '{expires}', '2026-10-01Z');"
        ),
    );
}

fn events(db: &TestDb) -> Vec<String> {
    db.texts(&format!(
        "SELECT n || ' ' || kind || ' ' || key || ' ' || coalesce(actor_id::text, 'null') || ' ' || \
         to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') || ' ' || \
         to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         FROM academy.access_grant_events WHERE grant_id = '{GRANT}' ORDER BY n"
    ))
}

fn state(db: &TestDb) -> Vec<String> {
    db.texts(&format!(
        "SELECT state || ' ' || to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM academy.access_grants WHERE id = '{GRANT}'"
    ))
}

#[test]
fn an_ended_record_refuses_the_courses_items_and_writes_its_expiry_once() {
    let Some((db, pool)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    // No record: the free enrolment decides.
    assert_eq!(
        gates::assert_access(&pool, USER, "foundations", at("2026-10-05T00:00:00Z")),
        Ok(())
    );
    grant(&db, "2026-10-10T00:00:00.123Z");
    let before = at("2026-10-09T00:00:00Z");
    assert_eq!(gates::assert_may_read(&pool, USER, FIRST, before), Ok(()));
    assert_eq!(state(&db), ["granted 2026-10-01T00:00:00.000Z"]);
    let later = at("2026-10-11T00:00:00.456Z");
    for _ in 0..2 {
        let r = gates::assert_may_read(&pool, USER, FIRST, later);
        assert_eq!(
            message(r),
            "academy.grant_expired course=foundations ended=2026-10-10T00:00:00.123Z"
        );
    }
    // Another course's items stay open: the record is the course's.
    assert_eq!(
        gates::assert_may_read(&pool, USER, "markets-reading-the-book", later),
        Ok(())
    );
    assert_eq!(state(&db), ["expired 2026-10-11T00:00:00.456Z"]);
    assert_eq!(
        events(&db),
        [
            format!(
                "1 granted grant:{GRANT}:1 {STAFF} 2026-10-10T00:00:00.123Z 2026-10-01T00:00:00.000Z"
            ),
            format!(
                "2 expired expire:{GRANT}:2 null 2026-10-10T00:00:00.123Z 2026-10-10T00:00:00.123Z"
            ),
        ]
    );
}

#[test]
fn a_revoked_record_refuses_and_writes_nothing() {
    let Some((db, pool)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    grant(&db, "2099-01-01Z");
    exec(&db, "UPDATE academy.access_grants SET state = 'revoked'");
    assert_eq!(
        message(gates::assert_access(
            &pool,
            USER,
            "foundations",
            at("2026-10-05T00:00:00Z")
        )),
        "academy.grant_expired course=foundations revoked"
    );
    assert_eq!(events(&db).len(), 1);
}

#[test]
fn two_reads_at_once_write_one_expiry() {
    let Some((db, _)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    grant(&db, "2026-10-10T00:00:00Z");
    let later = at("2026-10-11T00:00:00Z");
    let url = db.url.clone();
    let reads: Vec<_> = (0..6)
        .map(|_| {
            let url = url.clone();
            std::thread::spawn(move || {
                let pool = Pool::new(&url, 2);
                code(gates::assert_access(&pool, USER, "foundations", later))
            })
        })
        .collect();
    for r in reads {
        assert_eq!(r.join().unwrap(), "academy.grant_expired");
    }
    let kinds: Vec<String> = events(&db)
        .iter()
        .map(|e| e.split(' ').nth(1).unwrap().to_owned())
        .collect();
    assert_eq!(kinds, ["granted", "expired"]);
}

#[test]
fn a_failure_after_the_state_change_rolls_it_back_and_the_next_read_writes_it() {
    let Some((db, pool)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    grant(&db, "2026-10-10T00:00:00Z");
    // The crash point: the UPDATE has run and the event INSERT fails (its key is already taken).
    exec(
        &db,
        &format!(
            "INSERT INTO academy.access_grants (id, user_id, path_slug, source, reason, starts_at, state, created_at, updated_at) \
               VALUES ('44444444-4444-4444-8444-444444444444', '{STAFF}', 'markets', 'free', NULL, '2026-10-01Z', 'granted', now(), now()); \
             INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, at) \
               VALUES ('44444444-4444-4444-8444-444444444444', 1, 'granted', 'expire:{GRANT}:2', 'TEST', '{STAFF}', now());"
        ),
    );
    let later = at("2026-10-11T00:00:00Z");
    let failed = gates::assert_access(&pool, USER, "foundations", later);
    assert!(
        matches!(failed, Err(Refusal::Internal { .. })),
        "{failed:?}"
    );
    assert_eq!(
        state(&db),
        ["granted 2026-10-01T00:00:00.000Z"],
        "the state change rolled back"
    );
    assert_eq!(events(&db).len(), 1, "no event was written");
    exec(
        &db,
        "DELETE FROM academy.access_grant_events WHERE grant_id = '44444444-4444-4444-8444-444444444444'",
    );
    assert_eq!(
        code(gates::assert_access(&pool, USER, "foundations", later)),
        "academy.grant_expired"
    );
    assert_eq!(state(&db), ["expired 2026-10-11T00:00:00.000Z"]);
    assert_eq!(events(&db).len(), 2);
}

// ── featured.db.test.ts and learn-hub.db.test.ts: what the hub shows ────────────────────────────────────────────────

fn featured(db: &TestDb, item: &str) {
    exec(
        db,
        &format!(
            "INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at) VALUES ('hub', '{item}', 'Start here', '{STAFF}', now())"
        ),
    );
}

#[test]
fn the_hub_shows_the_chosen_item_and_drops_one_off_the_spine_or_one_a_visitor_could_not_open() {
    let Some((db, pool)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let now = at("2026-10-23T12:00:00Z");
    assert_eq!(gates::featured_item(&pool, now), Ok(None));
    featured(&db, SECOND);
    assert_eq!(
        gates::featured_item(&pool, now)
            .unwrap()
            .map(|i| i.slug.as_str()),
        Some(SECOND)
    );
    exec(
        &db,
        &format!("INSERT INTO academy.item_prerequisites VALUES ('{SECOND}', '{FIRST}')"),
    );
    assert_eq!(gates::featured_item(&pool, now), Ok(None));
    exec(
        &db,
        "TRUNCATE academy.featured_items, academy.item_prerequisites",
    );
    featured(&db, "retired-item");
    assert_eq!(gates::featured_item(&pool, now), Ok(None));
    assert_eq!(gates::featured_lesson(&pool), Ok(Json::Null));
}

#[test]
fn the_hub_shows_a_published_lesson_names_its_course_only_while_published_and_drops_it_when_archived()
 {
    let Some((db, pool)) = db() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    exec(
        &db,
        &format!(
            "INSERT INTO academy.courses (id, slug, title, pricing, state, created_by, created_at, updated_at) \
               VALUES ('44444444-4444-4444-8444-444444444444', 'risk-basics', 'Risk basics', 'free', 'draft', '{STAFF}', now(), now()); \
             INSERT INTO academy.course_sections (id, course_id, position, title) \
               VALUES ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', 1, 'Basics'); \
             INSERT INTO academy.course_items (id, course_id, section_id, position, kind, title) \
               VALUES ('66666666-6666-4666-8666-666666666666', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', 1, 'lesson', 'Position size'); \
             INSERT INTO academy.featured_items (slot, course_item_id, reason, chosen_by, chosen_at) \
               VALUES ('hub', '66666666-6666-4666-8666-666666666666', 'TEST', '{STAFF}', now());"
        ),
    );
    // Not published yet: no live revision, nothing shown.
    assert_eq!(gates::featured_lesson(&pool), Ok(Json::Null));
    exec(
        &db,
        &format!(
            "BEGIN; UPDATE academy.course_items SET live_revision = 1; \
             INSERT INTO academy.lesson_revisions (item_id, revision, source, blocks, actor, at) \
               VALUES ('66666666-6666-4666-8666-666666666666', 1, 'saved', '[{{\"type\":\"text\"}}]', '{STAFF}', now()); COMMIT;"
        ),
    );
    let lesson = |course_slug: Json| {
        Json::obj([
            ("title", Json::str("Position size")),
            ("courseTitle", Json::str("Risk basics")),
            ("courseSlug", course_slug),
        ])
    };
    assert_eq!(gates::featured_lesson(&pool), Ok(lesson(Json::Null)));
    exec(&db, "UPDATE academy.courses SET state = 'published'");
    assert_eq!(
        gates::featured_lesson(&pool),
        Ok(lesson(Json::str("risk-basics")))
    );
    exec(&db, "UPDATE academy.courses SET state = 'archived'");
    assert_eq!(gates::featured_lesson(&pool), Ok(Json::Null));
    // A course lesson in the slot is not a curriculum item.
    assert_eq!(
        gates::featured_item(&pool, at("2026-10-23T12:00:00Z")),
        Ok(None)
    );
}
