//! The rest of this slice's tests, against a real Postgres, assertion for assertion:
//!
//! - `assessment/certs.db.test.ts`: the code-catalogue assessment (`getAssessment`, `submitAssessment`,
//!   `assessmentAttempts`). Its certificate parts (`certProgress`, `grantCert`) are the certs slice's.
//! - `learners/learner-desk.db.test.ts`, "a voided attempt stops counting against the limit": the void and the retake.
//!   The `counted` figure it reads comes from the learner page (`items`), the learner slice's call.
//! - `release/access.db.test.ts`, the two `grantItemExtension` tests. The window is written as the row
//!   `setItemWindow` leaves; `markCurriculumComplete` and `itemRelease` are other slices' calls.
//! - The changer check on `admin.voidQuizAttempt` and `admin.grantLearnerExtension` (`learners/learner-desk-router.ts`:
//!   a read-only session may not change a learner), on the wire.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use service_kit::json::Json;
use service_kit::server::Request;
use support::{TestDb, at, code_of, jp, merged};
use svc_academy::assessment::{extensions, legacy};
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::errors::Refusal;
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const STAFF: &str = "44444444-4444-4444-8444-444444444444";
const DAY: i64 = 86_400_000;
const NO_CATALOG: &[Json] = &[];

fn t(iso: &str) -> i64 {
    service_kit::time::js_date(iso).unwrap().0
}

fn iso(ms: i64) -> String {
    service_kit::time::Instant(ms).iso()
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

fn store() -> Option<(TestDb, Store)> {
    let db = TestDb::migrated()?;
    let store = Store::Pool(db.pool());
    Some((db, store))
}

// ── assessment/certs.db.test.ts ─────────────────────────────────────────────────────────────────────────────────────

const TEST_QUIZ: &str = r#"{"slug":"foundations-risk-first","kind":"quiz","passMark":1,"attemptLimit":null,"cooldownSeconds":null,
  "questions":[{"id":"q1","prompt":"TEST question","kind":"single","points":1,
    "choices":[{"id":"a","text":"TEST wrong"},{"id":"b","text":"TEST right"}],"correctChoiceId":"b"}]}"#;

fn def(over: &str) -> Json {
    merged(&jp(TEST_QUIZ), over)
}

fn wrong() -> Vec<(String, String)> {
    vec![("q1".to_owned(), "a".to_owned())]
}

fn right() -> Vec<(String, String)> {
    vec![("q1".to_owned(), "b".to_owned())]
}

#[test]
fn refuses_an_unpublished_assessment_and_a_blank_pass_mark_and_hides_the_answer_key() {
    let (_db, s) = need!(store());
    assert_eq!(
        code_of(legacy::get(&s, NO_CATALOG, "foundations-risk-first")),
        "academy.assessment_unpublished"
    );
    let blank = [def(r#"{"slug":"foundations-order-types","passMark":null}"#)];
    assert_eq!(
        code_of(legacy::get(&s, &blank, "foundations-order-types")),
        "academy.pass_mark_unset"
    );

    let catalog = [def("{}")];
    let body = legacy::get(&s, &catalog, "foundations-risk-first").unwrap();
    assert!(
        !body.compact().to_lowercase().contains("correct"),
        "{}",
        body.compact()
    );
    assert_eq!(at(&body, "questions.0.correctChoiceId"), Json::Null);
    assert_eq!(at(&body, "passMark"), Json::int(1));
    assert_eq!(at(&body, "questions.0.points"), Json::int(1));
}

#[test]
fn scores_on_the_server_replays_the_first_result_and_hides_another_account() {
    let (_db, s) = need!(store());
    let catalog = [def("{}")];
    let slug = "foundations-risk-first";
    let now = system_now().0;
    let first = legacy::submit(&s, &catalog, USER, slug, &wrong(), "replay-1", now).unwrap();
    assert_eq!(
        (
            at(&first, "score"),
            at(&first, "pass"),
            at(&first, "maxScore")
        ),
        (Json::int(0), Json::Bool(false), Json::int(1))
    );
    let replay =
        legacy::submit(&s, &catalog, USER, slug, &right(), "replay-1", now + 1000).unwrap();
    assert_eq!(at(&replay, "score"), at(&first, "score"));
    assert_eq!(at(&replay, "pass"), Json::Bool(false));
    assert_eq!(at(&replay, "submittedAt"), at(&first, "submittedAt"));

    let passed = legacy::submit(&s, &catalog, USER, slug, &right(), "pass-1", now + 2000).unwrap();
    assert_eq!(
        (at(&passed, "score"), at(&passed, "pass")),
        (Json::int(1), Json::Bool(true))
    );
    match legacy::attempts(&s, &catalog, USER, slug, now + 3000).unwrap() {
        Json::Array(mine) => assert_eq!(mine.len(), 2),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        legacy::attempts(&s, &catalog, OTHER, slug, now + 3000).unwrap(),
        Json::Array(vec![])
    );
}

#[test]
fn applies_an_attempt_limit_or_cooldown_only_when_the_definition_publishes_one() {
    let (_db, s) = need!(store());
    let now = system_now().0;
    let open = [def("{}")];
    legacy::submit(
        &s,
        &open,
        USER,
        "foundations-risk-first",
        &wrong(),
        "n1",
        now,
    )
    .unwrap();
    legacy::submit(
        &s,
        &open,
        USER,
        "foundations-risk-first",
        &right(),
        "n2",
        now,
    )
    .unwrap();

    let limited = [def(
        r#"{"slug":"foundations-fees-are-real","attemptLimit":1}"#,
    )];
    let fees = "foundations-fees-are-real";
    legacy::submit(&s, &limited, USER, fees, &wrong(), "lim-1", now).unwrap();
    assert_eq!(
        code_of(legacy::submit(
            &s,
            &limited,
            USER,
            fees,
            &right(),
            "lim-2",
            now
        )),
        "academy.attempt_limit"
    );
    let replay = legacy::submit(&s, &limited, USER, fees, &right(), "lim-1", now).unwrap();
    assert_eq!(at(&replay, "pass"), Json::Bool(false));

    let cooling = [def(
        r#"{"slug":"foundations-journal-discipline","cooldownSeconds":60}"#,
    )];
    let journal = "foundations-journal-discipline";
    legacy::submit(
        &s,
        &cooling,
        USER,
        journal,
        &wrong(),
        "cool-1",
        t("2026-10-17T00:00:00Z"),
    )
    .unwrap();
    assert_eq!(
        code_of(legacy::submit(
            &s,
            &cooling,
            USER,
            journal,
            &right(),
            "cool-2",
            t("2026-10-17T00:00:30Z")
        )),
        "academy.attempt_cooldown"
    );
    let later = legacy::submit(
        &s,
        &cooling,
        USER,
        journal,
        &right(),
        "cool-3",
        t("2026-10-17T00:01:00Z"),
    )
    .unwrap();
    assert_eq!(at(&later, "pass"), Json::Bool(true));
}

// ── learners/learner-desk.db.test.ts: a voided attempt ──────────────────────────────────────────────────────────────

const DESK_QUIZ: &str = r#"{"passMark":1,"attemptLimit":1,"timeLimitSeconds":null,"reviewMode":"score_only",
  "questions":[{"id":"q1","prompt":"TEST?","points":1,"choices":[{"id":"a","text":"TEST a"},{"id":"b","text":"TEST b"}],"correctChoiceId":"a"}]}"#;

fn text(j: &Json) -> String {
    match j {
        Json::String(s) => s.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

#[test]
fn a_voided_attempt_stops_counting_against_the_limit_so_exactly_one_retake_is_allowed() {
    let (db, s) = need!(store());
    // A free path's item, so the path gate the TypeScript passes by enrolling is open here too.
    let slug = spine::list(Some("markets"), None)[1].slug.clone();
    let now = system_now().0;
    legacy::set_quiz(
        &s,
        NO_CATALOG,
        &slug,
        Some(&jp(DESK_QUIZ)),
        "TEST quiz",
        STAFF,
        now,
    )
    .unwrap();
    let first = legacy::start(&s, NO_CATALOG, USER, &slug, now).unwrap();
    legacy::finish(&s, USER, &text(&at(&first, "attemptId")), now).unwrap();
    assert_eq!(
        code_of(legacy::start(&s, NO_CATALOG, USER, &slug, now)),
        "academy.attempt_limit"
    );
    // `quiz.attempts[0].attemptId` of the learner page: the finished attempt's own row.
    let attempt: String = db
        .client()
        .query_one("SELECT id::text FROM academy.assessment_attempts WHERE user_id = $1::text::uuid AND slug = $2", &[&USER, &slug])
        .unwrap()
        .get(0);

    assert_eq!(
        code_of(extensions::void_attempt(&s, USER, &attempt, "", STAFF, now)),
        "academy.reason_required"
    );
    assert_eq!(
        code_of(extensions::void_attempt(
            &s, OTHER, &attempt, "TEST", STAFF, now
        )),
        "academy.attempt_not_found"
    );
    extensions::void_attempt(&s, USER, &attempt, "TEST page failed", STAFF, now).unwrap();
    let row = db
        .client()
        .query_one(
            "SELECT voided_by::text, void_reason FROM academy.assessment_attempts WHERE id = $1::text::uuid",
            &[&attempt],
        )
        .unwrap();
    assert_eq!(
        (row.get::<_, String>(0), row.get::<_, String>(1)),
        (STAFF.to_owned(), "TEST page failed".to_owned())
    );

    let retake = legacy::start(&s, NO_CATALOG, USER, &slug, now).unwrap();
    assert_eq!(at(&retake, "number"), Json::int(2));
    legacy::finish(&s, USER, &text(&at(&retake, "attemptId")), now).unwrap();
    assert_eq!(
        code_of(legacy::start(&s, NO_CATALOG, USER, &slug, now)),
        "academy.attempt_limit"
    );
}

// ── release/access.db.test.ts: grantItemExtension ───────────────────────────────────────────────────────────────────

const SECOND: &str = "foundations-order-types";
const THIRD: &str = "foundations-fees-are-real";

/// `setItemWindow`'s row.
fn window(db: &TestDb, slug: &str, from: i64, until: i64, due: Option<i64>) {
    db.client()
        .execute(
            "INSERT INTO academy.item_windows (item_slug, available_from, available_until, due_at) \
             VALUES ($1, $2::text::timestamptz, $3::text::timestamptz, $4::text::timestamptz)",
            &[&slug, &iso(from), &iso(until), &due.map(iso)],
        )
        .unwrap();
}

fn extensions_of(db: &TestDb) -> i64 {
    db.client()
        .query_one(
            "SELECT count(*)::int8 FROM academy.item_extensions WHERE user_id = $1::text::uuid",
            &[&USER],
        )
        .unwrap()
        .get(0)
}

#[test]
fn refuses_an_extension_without_a_reason_and_does_not_store_one() {
    let (db, s) = need!(store());
    let now = system_now().0;
    window(&db, THIRD, now - DAY, now - 3_600_000, None);
    let until = t("2026-10-05T00:00:00.000Z");
    assert_eq!(
        code_of(extensions::grant_item_extension(
            &s,
            USER,
            THIRD,
            "   ",
            until,
            "ext-blank",
            STAFF,
            now
        )),
        "academy.reason_required"
    );
    assert_eq!(extensions_of(&db), 0);
}

#[test]
fn one_extension_past_a_closed_window_replays_and_any_other_grant_under_its_request_refuses() {
    let (db, s) = need!(store());
    let now = system_now().0;
    let (open, shut) = (now - DAY, now - 3_600_000);
    window(&db, THIRD, open, shut, Some(shut));
    window(&db, SECOND, open, shut, None);
    let until = now + DAY;
    let grant = |slug: &str, reason: &str, until: i64| -> Result<Json, Refusal> {
        extensions::grant_item_extension(&s, USER, slug, reason, until, "ext-1", STAFF, now)
    };
    let first = grant(THIRD, "TEST late start", until).unwrap();
    let again = grant(THIRD, "TEST late start", until).unwrap();
    assert_eq!(at(&again, "revision"), at(&first, "revision"));
    assert_eq!(at(&again, "reason"), Json::str("TEST late start"));
    assert_eq!(at(&again, "extendedUntil"), Json::str(iso(until)));
    assert_eq!(
        code_of(grant(
            THIRD,
            "a different reason must not mint a second revision",
            until
        )),
        "academy.window_invalid"
    );
    assert_eq!(
        code_of(grant(THIRD, "TEST late start", now + 2 * DAY)),
        "academy.window_invalid"
    );
    assert_eq!(
        code_of(grant(SECOND, "TEST late start", until)),
        "academy.window_invalid"
    );
    assert_eq!(extensions_of(&db), 1);
}

// ── the changer check, on the wire ──────────────────────────────────────────────────────────────────────────────────

const SECRET: &str = "an-academy-assessment-desk-edge-secret";

fn door(store: Store) -> AcademyDoor {
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
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
        settings: Settings(Json::obj([])),
        now: system_now,
    })
    .unwrap()
}

fn post(door: &AcademyDoor, path: &str, input: &str, scopes: &[&str]) -> (u16, Json) {
    let raw = Json::obj([
        ("sub", Json::str(STAFF)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(scopes.contains(&"admin:write"))),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(STAFF)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let headers = vec![
        ("content-type".to_owned(), "application/json".to_owned()),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
        (
            "x-intafaced-principal-sig".to_owned(),
            service_kit::edge::sign(&raw, SECRET, "DE").unwrap(),
        ),
        ("x-intafaced-principal".to_owned(), raw),
    ];
    let url = format!("/trpc/{path}");
    let res = door.handle(&Request {
        method: "POST",
        url: &url,
        headers: &headers,
        body: input,
    });
    (res.status, jp(&res.body))
}

#[test]
fn a_read_only_session_may_not_void_an_attempt_or_extend_a_learner_and_nothing_is_written() {
    let (db, s) = need!(store());
    let d = door(s);
    let void_input = format!(r#"{{"userId":"{USER}","attemptId":"{OTHER}","reason":"TEST"}}"#);
    let extend_input = format!(
        r#"{{"userId":"{USER}","itemSlug":"{THIRD}","reason":"TEST","until":"2099-01-01T00:00:00.000Z","key":"k"}}"#
    );
    for (path, input) in [
        ("admin.voidQuizAttempt", &void_input),
        ("admin.grantLearnerExtension", &extend_input),
    ] {
        let (status, body) = post(&d, path, input, &["admin:read"]);
        assert_eq!(status, 403, "{path}: {}", body.compact());
        assert!(
            at(&body, "error.message")
                .compact()
                .contains("academy.permission_denied"),
            "{path}: {}",
            body.compact()
        );
    }
    assert_eq!(extensions_of(&db), 0);
    // A writer reaches the call itself: the attempt is not this learner's.
    let (status, body) = post(
        &d,
        "admin.voidQuizAttempt",
        &void_input,
        &["admin:read", "admin:write"],
    );
    assert_eq!(status, 404, "{}", body.compact());
    assert!(
        at(&body, "error.message")
            .compact()
            .contains("academy.attempt_not_found"),
        "{}",
        body.compact()
    );
}
