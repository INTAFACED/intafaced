//! The certificate calls against a real Postgres, ported file for file from the TypeScript `*.db.test.ts` that pin
//! them: `certs/revoke.db`, `certs/exception.db`, `certs/issue-rules.db`, `certs/designs.db`, the certificate half of
//! `assessment/certs.db` and `certs/designs-router` (asked through the door over a real database). Then the failure
//! branches at each crash point a certificate write has: the grant written and its XP publish lost, the revocation
//! written and its reversal lost, the exception written and its XP lost; each time the durable row stands and the
//! next call publishes what was missed.
//!
//! Each test gets its own migrated database (`TEST_DATABASE_URL_ACADEMY` or `TEST_DATABASE_URL`; skipped without one
//! unless `REQUIRE_POSTGRES=1`). `markCurriculumComplete` and its Undo belong to the learner slice: a completion is
//! written here as that call's row (`INSERT ... ON CONFLICT DO NOTHING`, the Undo's `DELETE`) and then settled through
//! `settle_certificates_needing`, which is what both calls do next.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::Mutex;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_academy::certs::catalog::{self, CertDefinition};
use svc_academy::certs::designs::Content;
use svc_academy::certs::enrolment;
use svc_academy::certs::progress::Grant;
use svc_academy::certs::service::{Certs, Pair};
use svc_academy::certs::xp::{BusPublisher, Emit, Publisher, Skip};
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::errors::Refusal;
use svc_academy::ports::{Bus, HostRights, NoBus, Ports};
use svc_academy::settings::Settings;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const OPERATOR: &str = "44444444-4444-4444-8444-444444444444";
const PROPOSER: &str = "66666666-6666-4666-8666-666666666666";
const APPROVER: &str = "55555555-5555-4555-8555-555555555555";
const CERT: &str = "foundations-v1";
/// 2026-10-24T12:00:00.000Z.
const T0: i64 = 1_792_843_200_000;
const SECRET: &str = "academy-certs-backend-edge-secret-32b";

fn minutes(n: i64) -> i64 {
    T0 + n * 60_000
}

fn iso(ms: i64) -> String {
    Instant(ms).iso()
}

fn items() -> Vec<String> {
    catalog::foundations_v1().required_item_slugs
}

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.code.clone(),
        Refusal::Internal { code, .. } => code.clone().unwrap_or_default(),
        Refusal::Approval { code, .. } | Refusal::Precondition { code, .. } => code.clone(),
        Refusal::Trpc(t) => t.cause.clone().unwrap_or_else(|| t.code.to_owned()),
        other => format!("{other:?}"),
    }
}

fn refuses<T: std::fmt::Debug>(r: Result<T, Refusal>, want: &str) {
    match r {
        Ok(v) => panic!("expected {want}, got {v:?}"),
        Err(e) => assert_eq!(code(&e), want, "{e:?}"),
    }
}

/// `value[a][b]...`, or null.
fn at(v: &Json, path: &[&str]) -> Json {
    path.iter()
        .try_fold(v, |v, k| v.get(k))
        .cloned()
        .unwrap_or(Json::Null)
}

fn s(v: &str) -> Json {
    Json::str(v)
}

struct NoHostRights;
impl HostRights for NoHostRights {
    fn perks_of(&self, _user_id: &str) -> Result<Json, Refusal> {
        Err(Refusal::Internal {
            message: "host rights unused".to_owned(),
            code: None,
        })
    }
}

/// Records every award and reversal the service asks for (`RecordingXp`, `CountingXp`).
#[derive(Default)]
struct RecordingXp {
    sent: Mutex<Vec<String>>,
}
impl Publisher for RecordingXp {
    fn id(&self) -> &str {
        "recording"
    }
    fn usable(&self) -> bool {
        true
    }
    fn publish(&self, grant: &Grant) -> Result<Emit, Refusal> {
        self.sent
            .lock()
            .unwrap()
            .push(format!("award:{}", grant.idempotency_key));
        Ok(Emit::Emitted {
            idempotency_key: format!("academy.cert:{}", grant.idempotency_key),
            xp_delta: 100,
        })
    }
    fn reverse(&self, grant: &Grant) -> Result<Emit, Refusal> {
        self.sent
            .lock()
            .unwrap()
            .push(format!("reverse:{}", grant.idempotency_key));
        Ok(Emit::Emitted {
            idempotency_key: format!("academy.cert:reverse:{}", grant.idempotency_key),
            xp_delta: -100,
        })
    }
}
impl RecordingXp {
    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }
}

/// A bus that is up or down on demand, recording what reached it.
#[derive(Default)]
struct FlakyBus {
    down: Mutex<bool>,
    reached: Mutex<Vec<String>>,
}
impl Bus for FlakyBus {
    fn id(&self) -> &str {
        "bus"
    }
    fn usable(&self) -> bool {
        true
    }
    fn publish(&self, _subject: &str, msg_id: &str, _payload: &Json) -> Result<(), String> {
        if *self.down.lock().unwrap() {
            return Err("nats is gone".to_owned());
        }
        self.reached.lock().unwrap().push(msg_id.to_owned());
        Ok(())
    }
}
impl FlakyBus {
    fn set_down(&self, down: bool) {
        *self.down.lock().unwrap() = down;
    }
    fn reached(&self) -> Vec<String> {
        self.reached.lock().unwrap().clone()
    }
}

fn wall() -> Instant {
    system_now()
}

/// The parts one `AcademyService` is built from in these tests.
struct Options<'a> {
    catalog: &'a [CertDefinition],
    xp: &'a dyn Publisher,
    sweep_running: bool,
    issued_rows: Option<i64>,
}

fn certs<'a>(store: &'a Store, o: &Options<'a>) -> Certs<'a> {
    Certs {
        store,
        catalog: o.catalog,
        xp: o.xp,
        host_rights: &NoHostRights,
        sweep_running: o.sweep_running,
        issued_rows: o.issued_rows,
        wall,
    }
}

static NULL_XP: std::sync::LazyLock<BusPublisher<'static>> =
    std::sync::LazyLock::new(|| BusPublisher {
        bus: &NoBus,
        producer: "svc-academy".to_owned(),
        clock: wall,
    });

fn plain() -> Options<'static> {
    Options {
        catalog: catalog::production(),
        xp: &*NULL_XP,
        sweep_running: false,
        issued_rows: Some(50),
    }
}

/// `markCurriculumComplete`'s row, then its settle.
fn complete(db: &TestDb, c: &Certs<'_>, user: &str, slug: &str, at: i64) {
    db.client()
        .execute(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) \
             VALUES ($1::text::uuid, $2, $3::text::timestamptz) ON CONFLICT (user_id, item_slug) DO NOTHING",
            &[&user, &slug, &iso(at)],
        )
        .unwrap();
    c.settle_certificates_needing(user, slug, at);
}

/// `finish`: enrolled in Foundations, then each item completed.
fn finish(db: &TestDb, c: &Certs<'_>, user: &str, at: i64, items: &[String]) {
    enrolment::enroll_cert_path(c, user, "foundations", at).unwrap();
    for slug in items {
        complete(db, c, user, slug, at);
    }
}

/// `issued`: the learner finishes Foundations and claims it; its public code.
fn issued(db: &TestDb, c: &Certs<'_>, user: &str) -> String {
    finish(db, c, user, T0, &items());
    c.grant_cert(user, CERT, false, T0).unwrap().public_id
}

fn count(db: &TestDb, sql: &str) -> i64 {
    let n: i32 = db.client().query_one(sql, &[]).unwrap().get(0);
    i64::from(n)
}

fn grants(db: &TestDb) -> i64 {
    count(
        db,
        &format!(
            "SELECT COUNT(*)::int FROM academy.cert_grants WHERE user_id = '{USER}' AND cert_id = '{CERT}'"
        ),
    )
}

const PAIR: Pair<'static> = Pair {
    proposed_by: PROPOSER,
    approved_by: APPROVER,
    operator_id: OPERATOR,
};

fn status(c: &Certs<'_>, public_id: &str) -> Json {
    at(&c.cert_verify(public_id).unwrap(), &["status"])
}

// ── revoke.db.test.ts ────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_revocation_turns_the_check_to_revoked_and_is_recorded_once() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    let public_id = issued(&db, &c, USER);
    assert_eq!(status(&c, &public_id), s("valid"));
    let first = c
        .revoke_cert(&public_id, "TEST revoked in error", &PAIR, T0)
        .unwrap();
    assert_eq!(
        first,
        Json::obj([
            ("publicId", s(&public_id)),
            ("certId", s(CERT)),
            ("proposedBy", s(PROPOSER)),
            ("approvedBy", s(APPROVER)),
            ("revokedBy", s(OPERATOR)),
            ("reason", s("TEST revoked in error")),
            ("revokedAt", s(&iso(T0))),
        ])
    );
    assert_eq!(status(&c, &public_id), s("revoked"));
    assert_eq!(
        c.revoke_cert(&public_id, "TEST another reason", &PAIR, T0)
            .unwrap(),
        first
    );
    assert_eq!(c.cert_revocation(&public_id).unwrap(), Some(first));
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_revocations"),
        1
    );
}

#[test]
fn a_revoked_certificate_is_never_claimed_again() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    let public_id = issued(&db, &c, USER);
    assert_eq!(c.cert_revocation(&public_id).unwrap(), None);
    c.revoke_cert(&public_id, "TEST revoked in error", &PAIR, T0)
        .unwrap();
    refuses(c.grant_cert(USER, CERT, false, T0), "academy.cert_revoked");
    assert_eq!(status(&c, &public_id), s("revoked"));
    let mine = c.my_cert_grants(USER, Some(10.0)).unwrap();
    let Json::Array(rows) = mine else { panic!() };
    assert_eq!(at(&rows[0], &["publicId"]), s(&public_id));
    assert_eq!(at(&rows[0], &["status"]), s("revoked"));
}

#[test]
fn a_revocation_refuses_an_unknown_code_and_a_blank_reason_writing_nothing() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    let public_id = issued(&db, &c, USER);
    let zeros = "0".repeat(32);
    refuses(c.cert_revocation(&zeros), "academy.cert_not_found");
    refuses(
        c.revoke_cert(&zeros, "TEST", &PAIR, T0),
        "academy.cert_not_found",
    );
    refuses(
        c.revoke_cert("not-a-code", "TEST", &PAIR, T0),
        "academy.cert_not_found",
    );
    refuses(
        c.revoke_cert(&public_id, "   ", &PAIR, T0),
        "academy.cert_invalid",
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_revocations"),
        0
    );
    assert_eq!(status(&c, &public_id), s("valid"));
}

#[test]
fn a_revocation_takes_the_xp_back_and_again_on_a_repeat() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &Options { xp: &xp, ..plain() });
    let public_id = issued(&db, &c, USER);
    let key = format!("cert:{USER}:{CERT}");
    assert_eq!(xp.sent(), [format!("award:{key}")]);
    c.revoke_cert(&public_id, "TEST revoked in error", &PAIR, T0)
        .unwrap();
    assert_eq!(
        xp.sent(),
        [
            format!("award:{key}"),
            format!("award:{key}"),
            format!("reverse:{key}")
        ]
    );
    c.settle_revoked_xp(&public_id);
    assert_eq!(
        xp.sent()[3..],
        [format!("award:{key}"), format!("reverse:{key}")]
    );
    // A certificate that stands is never reversed.
    let standing = issued(&db, &c, OTHER);
    xp.sent.lock().unwrap().clear();
    assert_eq!(c.settle_revoked_xp(&standing), None);
    assert!(xp.sent().is_empty());
}

// ── exception.db.test.ts ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn an_exception_issues_without_every_item_and_records_the_reason_once() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    finish(&db, &c, USER, T0, &items()[..1]);
    assert_eq!(c.cert_exception(USER, CERT).unwrap(), None);
    let first = c
        .grant_cert_exception(
            USER,
            CERT,
            "TEST a learner who finished elsewhere",
            &PAIR,
            T0,
        )
        .unwrap();
    for (k, v) in [
        ("userId", USER),
        ("certId", CERT),
        ("proposedBy", PROPOSER),
        ("approvedBy", APPROVER),
        ("grantedBy", OPERATOR),
        ("reason", "TEST a learner who finished elsewhere"),
    ] {
        assert_eq!(at(&first, &[k]), s(v), "{k}");
    }
    let Json::String(public_id) = at(&first, &["publicId"]) else {
        panic!()
    };
    assert_eq!(status(&c, &public_id), s("valid"));
    let Json::Array(mine) = c.my_cert_grants(USER, Some(10.0)).unwrap() else {
        panic!()
    };
    assert_eq!(mine.len(), 1);
    assert_eq!(at(&mine[0], &["publicId"]), s(&public_id));
    assert_eq!(
        c.grant_cert_exception(USER, CERT, "TEST a different reason", &PAIR, T0)
            .unwrap(),
        first
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_exceptions"),
        1
    );
    // The TypeScript's last check, the grant audit's issue line, is `grantAudit`: the programme slice's call.
}

#[test]
fn an_exception_refuses_a_held_or_revoked_certificate_before_writing() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    let held = issued(&db, &c, USER);
    refuses(c.cert_exception(USER, CERT), "academy.cert_already_granted");
    refuses(
        c.grant_cert_exception(USER, CERT, "TEST", &PAIR, T0),
        "academy.cert_already_granted",
    );
    c.revoke_cert(&held, "TEST revoked", &PAIR, T0).unwrap();
    refuses(
        c.grant_cert_exception(USER, CERT, "TEST", &PAIR, T0),
        "academy.cert_revoked",
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_exceptions"),
        0
    );
}

#[test]
fn an_exception_refuses_an_unpublished_certificate_and_a_blank_reason() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    refuses(
        c.cert_exception(USER, "no-such-cert"),
        "academy.cert_not_found",
    );
    refuses(
        c.grant_cert_exception(USER, CERT, "   ", &PAIR, T0),
        "academy.cert_invalid",
    );
}

// ── issue-rules.db.test.ts ───────────────────────────────────────────────────────────────────────────────────────

fn swept<'a>(xp: &'a dyn Publisher) -> Options<'a> {
    Options {
        catalog: catalog::production(),
        xp,
        sweep_running: true,
        issued_rows: Some(50),
    }
}

fn rule(c: &Certs<'_>, mode: &str, delay: Option<i64>, now: i64) -> Result<Json, Refusal> {
    c.set_cert_issue_rule(CERT, mode, delay, &format!("TEST {mode}"), OPERATOR, now)
        .map(|r| r.json())
}

fn issue_json(c: &Certs<'_>, now: i64) -> (Json, bool, bool) {
    let (report, issue) = c.cert_progress(USER, CERT, now).unwrap();
    (issue.json(), report.complete, report.granted)
}

fn issue(mode: &str, delay: Option<i64>, issues_at: Option<i64>) -> Json {
    Json::obj([
        ("mode", s(mode)),
        ("delayMinutes", delay.map_or(Json::Null, Json::int)),
        ("issuesAt", issues_at.map_or(Json::Null, |t| s(&iso(t)))),
    ])
}

#[test]
fn with_no_rule_nothing_is_issued_by_itself() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    finish(&db, &c, USER, T0, &items());
    assert_eq!(grants(&db), 0);
    let (iss, complete, _) = issue_json(&c, T0);
    assert_eq!(iss, issue("manual", None, None));
    assert!(complete);
    c.grant_cert(USER, CERT, false, T0).unwrap();
    assert_eq!(grants(&db), 1);
}

#[test]
fn automatic_issues_exactly_one_on_the_last_completion_even_sent_twice() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    rule(&c, "automatic", None, T0).unwrap();
    let all = items();
    let (last, rest) = all.split_last().unwrap();
    finish(&db, &c, USER, T0, rest);
    assert_eq!(grants(&db), 0);
    std::thread::scope(|sc| {
        for _ in 0..2 {
            sc.spawn(|| complete(&db, &c, USER, last, T0));
        }
    });
    assert_eq!(grants(&db), 1);
    let (iss, _, granted) = issue_json(&c, T0);
    assert!(granted);
    assert_eq!(iss, issue("automatic", None, None));
    let keys: std::collections::BTreeSet<String> = xp.sent().into_iter().collect();
    assert_eq!(keys, [format!("award:cert:{USER}:{CERT}")].into());
}

#[test]
fn delayed_waits_refuses_an_early_claim_and_the_sweep_issues_it_once() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    rule(&c, "delayed", Some(60), T0).unwrap();
    finish(&db, &c, USER, T0, &items());
    assert_eq!(grants(&db), 0);
    assert_eq!(
        issue_json(&c, minutes(10)).0,
        issue("delayed", Some(60), Some(minutes(60)))
    );
    refuses(
        c.grant_cert(USER, CERT, false, minutes(10)),
        "academy.cert_not_due",
    );
    assert_eq!(c.issue_due_certificates(minutes(59)).unwrap(), 0);
    assert_eq!(grants(&db), 0);
    assert_eq!(c.issue_due_certificates(minutes(60)).unwrap(), 1);
    assert_eq!(c.issue_due_certificates(minutes(61)).unwrap(), 0);
    assert_eq!(grants(&db), 1);
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_issue_pending"),
        0
    );
}

#[test]
fn a_delayed_wait_written_late_is_due_the_delay_after_the_last_completion() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    let all = items();
    let (last, rest) = all.split_last().unwrap();
    finish(&db, &c, USER, T0, rest);
    rule(&c, "delayed", Some(60), T0).unwrap();
    // The completion is recorded, and the process stops before the wait is written.
    db.client()
        .execute(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES ($1::text::uuid, $2, $3::text::timestamptz)",
            &[&USER, last, &iso(minutes(5))],
        )
        .unwrap();
    assert_eq!(
        at(&issue_json(&c, minutes(30)).0, &["issuesAt"]),
        s(&iso(minutes(65)))
    );
    let (_, _, granted) = issue_json(&c, minutes(65));
    assert!(granted);
    assert_eq!(grants(&db), 1);
}

#[test]
fn an_undo_before_the_delay_drops_the_wait_and_completing_again_starts_a_new_one() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    rule(&c, "delayed", Some(60), T0).unwrap();
    finish(&db, &c, USER, T0, &items());
    let last = items().last().unwrap().clone();
    // `undoCurriculumComplete`: the completion goes, then the certificates needing it are settled.
    db.client()
        .execute(
            "DELETE FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = $2",
            &[&USER, &last],
        )
        .unwrap();
    c.settle_certificates_needing(USER, &last, minutes(50));
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_issue_pending"),
        0
    );
    assert_eq!(c.issue_due_certificates(minutes(90)).unwrap(), 0);
    assert_eq!(grants(&db), 0);
    complete(&db, &c, USER, &last, minutes(100));
    assert_eq!(
        at(&issue_json(&c, minutes(101)).0, &["issuesAt"]),
        s(&iso(minutes(160)))
    );
}

#[test]
fn switching_back_to_manual_drops_every_wait() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    rule(&c, "delayed", Some(60), T0).unwrap();
    finish(&db, &c, USER, T0, &items());
    rule(&c, "manual", None, minutes(1)).unwrap();
    assert_eq!(c.issue_due_certificates(minutes(90)).unwrap(), 1);
    assert_eq!(c.issue_due_certificates(minutes(91)).unwrap(), 0);
    assert_eq!(grants(&db), 0);
}

#[test]
fn a_learner_complete_before_a_delayed_rule_waits_from_the_rule() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    finish(&db, &c, USER, T0, &items());
    rule(&c, "delayed", Some(60), minutes(30)).unwrap();
    assert_eq!(
        at(&issue_json(&c, minutes(31)).0, &["issuesAt"]),
        s(&iso(minutes(90)))
    );
    let claimed = c.grant_cert(USER, CERT, false, minutes(90)).unwrap();
    assert!(!claimed.already_granted);
    assert_eq!(grants(&db), 1);
    issue_json(&c, minutes(91));
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_issue_pending"),
        0
    );
}

#[test]
fn a_rule_change_is_a_new_revision_with_its_history_row() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    let revs: Vec<Json> = [
        rule(&c, "automatic", None, T0),
        rule(&c, "automatic", None, T0),
        rule(&c, "delayed", Some(30), T0),
    ]
    .into_iter()
    .map(|r| at(&r.unwrap(), &["revision"]))
    .collect();
    assert_eq!(revs, [Json::int(1), Json::int(1), Json::int(2)]);
    let history: Vec<String> = db
        .client()
        .query(
            "SELECT revision, mode, delay_minutes, actor::text, reason FROM academy.cert_issue_rule_events \
             WHERE cert_id = $1 ORDER BY revision",
            &[&CERT],
        )
        .unwrap()
        .iter()
        .map(|r| {
            format!(
                "{} {} {:?} {} {}",
                r.get::<_, i32>(0),
                r.get::<_, String>(1),
                r.get::<_, Option<i32>>(2),
                r.get::<_, String>(3),
                r.get::<_, String>(4)
            )
        })
        .collect();
    assert_eq!(
        history,
        [
            format!("1 automatic None {OPERATOR} TEST automatic"),
            format!("2 delayed Some(30) {OPERATOR} TEST delayed"),
        ]
    );
    let stored = c.cert_issue_rule(CERT).unwrap().unwrap();
    assert_eq!(
        (stored.mode.as_str(), stored.delay_minutes, stored.revision),
        ("delayed", Some(30), 2)
    );
}

#[test]
fn a_rule_refuses_no_delay_no_sweep_and_an_unpublished_certificate() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let xp = RecordingXp::default();
    let c = certs(&store, &swept(&xp));
    refuses(rule(&c, "delayed", None, T0), "academy.cert_delay_unset");
    let unswept = certs(&store, &plain());
    refuses(
        rule(&unswept, "delayed", Some(60), T0),
        "academy.cert_sweep_unset",
    );
    refuses(
        c.set_cert_issue_rule("markets", "automatic", None, "TEST", OPERATOR, T0),
        "academy.certificate_unpublished",
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_issue_rules"),
        0
    );
}

// ── designs.db.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

fn draft() -> Content {
    Content {
        title: "TEST Foundations".to_owned(),
        body: "TEST completed every Foundations lesson.".to_owned(),
        signatories: vec![],
        disclaimer: None,
        language: "en".to_owned(),
        size: "a4".to_owned(),
        effort_hours: Some("12.5".to_owned()),
    }
}

fn signed() -> Content {
    Content {
        signatories: vec![("TEST Signer".to_owned(), "TEST Director".to_owned())],
        disclaimer: Some("TEST disclaimer".to_owned()),
        ..draft()
    }
}

fn save(c: &Certs<'_>, revision: i64, content: &Content) -> Result<Json, Refusal> {
    c.designs()
        .save(CERT, content, revision, "TEST draft", OPERATOR, T0)
}

fn activate(c: &Certs<'_>, revision: i64) -> Result<Json, Refusal> {
    c.designs()
        .activate(CERT, revision, "TEST activate", OPERATOR, T0)
}

fn first_grant(c: &Certs<'_>, user: &str) -> Json {
    let Json::Array(rows) = c.my_cert_grants(user, Some(10.0)).unwrap() else {
        panic!()
    };
    rows[0].clone()
}

#[test]
fn activation_refuses_no_signatory_then_a_blank_disclaimer() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    let first = save(&c, 0, &draft()).unwrap();
    assert_eq!(
        at(&first, &["design", "design", "current", "revision"]),
        Json::int(1)
    );
    refuses(activate(&c, 1), "academy.cert_signatory_missing");
    let blank = Content {
        disclaimer: Some("   ".to_owned()),
        ..signed()
    };
    save(&c, 1, &blank).unwrap();
    refuses(activate(&c, 2), "academy.cert_disclaimer_unset");
    assert_eq!(
        at(
            &c.designs().design(CERT).unwrap(),
            &["design", "activeRevision"]
        ),
        Json::Null
    );
    save(&c, 2, &signed()).unwrap();
    let active = activate(&c, 3).unwrap();
    assert_eq!(at(&active, &["design", "activeRevision"]), Json::int(3));
    assert_eq!(
        at(&activate(&c, 3).unwrap(), &["design", "activatedAt"]),
        at(&active, &["design", "activatedAt"])
    );
}

#[test]
fn a_replayed_save_answers_its_revision_and_a_stale_save_refuses() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    save(&c, 0, &draft()).unwrap();
    let replay = save(&c, 0, &draft()).unwrap();
    assert_eq!(
        at(&replay, &["design", "design", "current", "revision"]),
        Json::int(1)
    );
    save(
        &c,
        1,
        &Content {
            title: "TEST Foundations two".to_owned(),
            ..draft()
        },
    )
    .unwrap();
    refuses(
        save(
            &c,
            1,
            &Content {
                title: "TEST Foundations three".to_owned(),
                ..draft()
            },
        ),
        "academy.cert_design_stale",
    );
}

#[test]
fn an_issued_certificate_keeps_its_revision_and_an_edit_warns() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    save(&c, 0, &signed()).unwrap();
    activate(&c, 1).unwrap();
    let public_id = issued(&db, &c, USER);
    refuses(
        save(
            &c,
            1,
            &Content {
                disclaimer: Some(String::new()),
                ..signed()
            },
        ),
        "academy.cert_disclaimer_unset",
    );
    let reworded = Content {
        title: "TEST Foundations, new wording".to_owned(),
        ..signed()
    };
    let edited = save(&c, 1, &reworded).unwrap();
    assert_eq!(
        at(&edited, &["warning"]),
        Json::obj([
            ("issuedKeepingEarlier", Json::int(1)),
            ("activeRevision", Json::int(2))
        ])
    );
    assert_eq!(
        at(&edited, &["design", "design", "activeRevision"]),
        Json::int(2)
    );
    let mine = first_grant(&c, USER);
    assert_eq!(at(&mine, &["publicId"]), s(&public_id));
    assert_eq!(at(&mine, &["design", "revision"]), Json::int(1));
    assert_eq!(at(&mine, &["design", "title"]), s("TEST Foundations"));
    assert_eq!(
        at(&mine, &["design", "signatories"]),
        Json::Array(vec![Json::obj([
            ("name", s("TEST Signer")),
            ("role", s("TEST Director"))
        ])])
    );
    issued(&db, &c, OTHER);
    let theirs = first_grant(&c, OTHER);
    assert_eq!(at(&theirs, &["design", "revision"]), Json::int(2));
    assert_eq!(
        at(&theirs, &["design", "title"]),
        s("TEST Foundations, new wording")
    );
}

#[test]
fn after_deactivation_a_certificate_issues_with_no_design() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    save(&c, 0, &signed()).unwrap();
    activate(&c, 1).unwrap();
    issued(&db, &c, USER);
    let off = c
        .designs()
        .deactivate(CERT, "TEST off", OPERATOR, T0)
        .unwrap();
    assert_eq!(at(&off, &["design", "activeRevision"]), Json::Null);
    issued(&db, &c, OTHER);
    assert_eq!(
        at(&first_grant(&c, USER), &["design", "revision"]),
        Json::int(1)
    );
    assert_eq!(at(&first_grant(&c, OTHER), &["design"]), Json::Null);
}

#[test]
fn with_no_active_design_a_certificate_issues_with_none() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    save(&c, 0, &draft()).unwrap();
    issued(&db, &c, USER);
    assert_eq!(at(&first_grant(&c, USER), &["design"]), Json::Null);
}

#[test]
fn the_issued_list_is_empty_with_none_issued_and_refuses_with_no_row_limit() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    assert_eq!(
        c.designs().issued(None).unwrap(),
        Json::obj([
            ("counts", Json::Array(vec![])),
            ("total", Json::int(0)),
            ("items", Json::Array(vec![]))
        ])
    );
    let unset = certs(
        &store,
        &Options {
            issued_rows: None,
            ..plain()
        },
    );
    refuses(unset.designs().issued(None), "academy.report_limit_unset");
    refuses(
        unset.designs().make_export(1, OPERATOR, T0),
        "academy.report_limit_unset",
    );
}

#[test]
fn the_issued_list_counts_by_status_and_the_export_holds_the_same_rows() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    let a = issued(&db, &c, USER);
    issued(&db, &c, OTHER);
    db.client()
        .execute(
            "UPDATE academy.cert_grants SET status = 'revoked' WHERE public_id = $1",
            &[&a],
        )
        .unwrap();
    let list = c.designs().issued(None).unwrap();
    assert_eq!(
        at(&list, &["counts"]),
        Json::Array(vec![Json::obj([
            ("certId", s(CERT)),
            ("valid", Json::int(1)),
            ("revoked", Json::int(1))
        ])])
    );
    assert_eq!(at(&list, &["total"]), Json::int(2));
    let Json::Array(items) = at(&list, &["items"]) else {
        panic!()
    };
    assert_eq!(items.len(), 2);
    let made = c.designs().make_export(1, OPERATOR, T0).unwrap();
    assert_eq!(at(&made, &["rows"]), Json::int(2));
    let Json::String(csv) = at(&c.designs().export_file(1).unwrap(), &["csv"]) else {
        panic!()
    };
    let lines: Vec<&str> = csv.trim().split("\r\n").skip(2).collect();
    assert_eq!(lines.iter().filter(|l| l.contains(",revoked,")).count(), 1);
    assert_eq!(lines.iter().filter(|l| l.contains(",valid,")).count(), 1);
    assert!(lines.iter().any(|l| l.starts_with(&format!("{a},"))));
    let retry = c
        .designs()
        .make_export(1, OPERATOR, system_now().0)
        .unwrap();
    assert_eq!(at(&retry, &["sha256"]), at(&made, &["sha256"]));
    refuses(
        c.designs().make_export(3, OPERATOR, T0),
        "academy.report_out_of_order",
    );
}

#[test]
fn an_export_longer_than_its_limit_refuses_rather_than_cut() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(
        &store,
        &Options {
            issued_rows: Some(1),
            ..plain()
        },
    );
    issued(&db, &c, USER);
    issued(&db, &c, OTHER);
    refuses(
        c.designs().make_export(1, OPERATOR, T0),
        "academy.report_too_large",
    );
    assert_eq!(
        at(&c.designs().exports().unwrap(), &["exports"]),
        Json::Array(vec![])
    );
}

// ── assessment/certs.db.test.ts (the certificate half) ───────────────────────────────────────────────────────────

/// A submitted attempt, as `submitAssessment` writes it (the assessment slice's call).
fn attempt(db: &TestDb, user: &str, slug: &str, id: &str, passed: bool) {
    db.client()
        .execute(
            "INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed) \
             VALUES ($1::text::uuid, $2, $3, $4, 1, $5)",
            &[&user, &slug, &id, &i32::from(passed), &passed],
        )
        .unwrap();
}

#[test]
fn only_a_passing_attempt_counts_and_the_grant_stays_idempotent() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let assessed = [
        catalog::foundations_v1(),
        CertDefinition::new(
            "test-assessed-v1",
            "TEST assessed",
            Some("markets"),
            &["assessment:foundations-risk-first"],
        ),
    ];
    let c = certs(
        &store,
        &Options {
            catalog: &assessed,
            ..plain()
        },
    );
    attempt(&db, USER, "foundations-risk-first", "fail-1", false);
    let (failing, _) = c.cert_progress(USER, "test-assessed-v1", T0).unwrap();
    assert!(!failing.complete);
    assert_eq!(
        failing.missing_item_slugs,
        ["assessment:foundations-risk-first"]
    );
    refuses(
        c.grant_cert(USER, "test-assessed-v1", false, T0),
        "academy.cert_incomplete",
    );
    attempt(&db, USER, "foundations-risk-first", "pass-2", true);
    let (passing, _) = c.cert_progress(USER, "test-assessed-v1", T0).unwrap();
    assert!(passing.complete);
    let granted = c.grant_cert(USER, "test-assessed-v1", false, T0).unwrap();
    let again = c.grant_cert(USER, "test-assessed-v1", false, T0).unwrap();
    assert!(again.already_granted);
    assert_eq!(again.public_id, granted.public_id);
    assert_eq!(
        again.grant.idempotency_key,
        format!("cert:{USER}:test-assessed-v1")
    );
}

#[test]
fn a_path_with_no_certificate_refuses_and_foundations_keeps_its_lessons() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    refuses(
        enrolment::enroll_cert_path(&c, USER, "markets", T0),
        "academy.certificate_unpublished",
    );
    refuses(
        c.cert_progress(USER, "sovereign", T0),
        "academy.certificate_unpublished",
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*)::int FROM academy.cert_enrollments WHERE path_slug = 'markets'"
        ),
        0
    );
    finish(&db, &c, USER, T0, &items());
    let (progress, _) = c.cert_progress(USER, CERT, T0).unwrap();
    assert_eq!(progress.required_count, 7);
    assert!(progress.complete);
    assert!(
        !progress
            .missing_item_slugs
            .iter()
            .any(|s| s.starts_with("assessment:"))
    );
    let first = c.grant_cert(USER, CERT, false, T0).unwrap();
    let second = c.grant_cert(USER, CERT, false, T0).unwrap();
    assert!(second.already_granted);
    assert_eq!(second.public_id, first.public_id);
}

/// The door over this database, with the owner's verify rate when given.
fn door(db: &TestDb, rate: Option<(i64, i64)>) -> AcademyDoor {
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
        ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    let mut settings = vec![("ACADEMY_CERT_ISSUED_ROWS".to_owned(), Json::int(50))];
    if let Some((max, window)) = rate {
        settings.push(("ACADEMY_CERT_VERIFY_RATE_MAX".to_owned(), Json::int(max)));
        settings.push((
            "ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS".to_owned(),
            Json::int(window),
        ));
    }
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        env,
        store: Store::Pool(db.pool()),
        ports: Ports::unwired(),
        settings: Settings(Json::Object(settings)),
        now: system_now,
    })
    .unwrap()
}

/// A signed principal, or anonymous.
fn headers(user: Option<&str>, scopes: &[&str], forged: bool) -> Vec<(String, String)> {
    let region = ("x-intafaced-region".to_owned(), "DE".to_owned());
    let Some(user) = user else {
        return vec![region];
    };
    let raw = Json::obj([
        ("sub", s(user)),
        ("scopes", Json::Array(scopes.iter().map(|x| s(x)).collect())),
        ("tier", s("none")),
        ("mfa", Json::Bool(true)),
        ("sid", s("33333333-3333-4333-8333-333333333333")),
        ("userId", s(user)),
        ("expiresAt", s("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(
        &raw,
        if forged {
            "a-forger-who-does-not-hold-the-secret"
        } else {
            SECRET
        },
        "DE",
    )
    .unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        region,
    ]
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// One tRPC call: its status and parsed body.
fn call(
    d: &AcademyDoor,
    path: &str,
    input: &Json,
    mutation: bool,
    headers: &[(String, String)],
    peer: &str,
) -> (u16, Json) {
    let mut h = headers.to_vec();
    let (method, url, body) = if mutation {
        h.push(("content-type".to_owned(), "application/json".to_owned()));
        ("POST", format!("/trpc/{path}"), input.compact())
    } else {
        (
            "GET",
            format!("/trpc/{path}?input={}", encode(&input.compact())),
            String::new(),
        )
    };
    let res = d.handle_from(
        &Request {
            method,
            url: &url,
            headers: &h,
            body: &body,
        },
        "req",
        peer,
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn ok(answer: (u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    at(&answer.1, &["result", "data"])
}

/// A refusal's tRPC code, message and cause code, as the TypeScript test's `refusal(err)` prints it.
fn refusal(answer: &(u16, Json)) -> (u16, Json, Json, Json) {
    let e = at(&answer.1, &["error"]);
    (
        answer.0,
        at(&e, &["data", "code"]),
        at(&e, &["message"]),
        at(&e, &["data", "cause", "code"]),
    )
}

/// Whether the refusal names `code` anywhere: its message or its cause.
fn names(answer: &(u16, Json), code: &str) -> bool {
    answer.1.compact().contains(code)
}

#[test]
fn verify_answers_without_a_session_and_refuses_a_blank_or_exceeded_rate() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    for slug in items() {
        complete(&db, &c, USER, &slug, T0);
        complete(&db, &c, OTHER, &slug, T0);
    }
    let mine = c.grant_cert(USER, CERT, false, T0).unwrap();
    let theirs = c.grant_cert(OTHER, CERT, false, T0).unwrap();
    assert_ne!(mine.public_id, theirs.public_id);
    let hex32 = |v: &str| {
        v.len() == 32
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    assert!(hex32(&mine.public_id));
    assert!(!mine.public_id.contains(&USER.replace('-', "")));
    let reference = format!("cert:{USER}:{CERT}");
    let sha = |t: &str| {
        use sha2::Digest as _;
        let h = sha2::Sha256::digest(t.as_bytes());
        h.iter().map(|b| format!("{b:02x}")).collect::<String>()[..32].to_owned()
    };
    assert_ne!(mine.public_id, sha(USER));
    assert_ne!(mine.public_id, sha(&reference));
    assert!(!reference.contains(&mine.public_id));

    // A grant row written before public codes existed is given one by the database.
    db.client()
        .execute(
            "INSERT INTO academy.cert_grants (user_id, cert_id, idempotency_key) VALUES ($1::text::uuid, 'backfill-v1', $2)",
            &[&USER, &format!("cert:{USER}:backfill-v1")],
        )
        .unwrap();
    let filled = db.texts(&format!("SELECT public_id FROM academy.cert_grants WHERE cert_id = 'backfill-v1' AND user_id = '{USER}'"));
    assert!(hex32(&filled[0]));
    assert!(!filled[0].contains(&USER.replace('-', "")));
    assert_ne!(filled[0], sha(&format!("cert:{USER}:backfill-v1")));
    let Json::Array(listed) = c.my_cert_grants(USER, Some(10.0)).unwrap() else {
        panic!()
    };
    let row = listed
        .iter()
        .find(|r| at(r, &["certId"]) == s(CERT))
        .unwrap();
    assert_eq!(at(row, &["publicId"]), s(&mine.public_id));

    let anon = headers(None, &[], false);
    let input = |id: &str| Json::obj([("publicId", s(id))]);
    let unset = call(
        &door(&db, None),
        "certVerify",
        &input(&mine.public_id),
        false,
        &anon,
        "203.0.113.10",
    );
    let (st, code, msg, _) = refusal(&unset);
    assert_eq!(
        (st, code, msg),
        (
            412,
            s("PRECONDITION_FAILED"),
            s("academy.verify_rate_unset")
        )
    );

    let open = door(&db, Some((8, 60)));
    let verified = ok(call(
        &open,
        "certVerify",
        &input(&mine.public_id),
        false,
        &anon,
        "203.0.113.10",
    ));
    assert_eq!(
        verified,
        Json::obj([
            ("certId", s(CERT)),
            ("title", s("Foundations")),
            ("grantedAt", s(&iso(mine.grant.granted_at))),
            ("status", s("valid")),
        ])
    );
    assert!(!verified.compact().contains(USER) && !verified.compact().contains("cert:"));
    let malformed = call(
        &open,
        "certVerify",
        &input("not-a-public-id"),
        false,
        &anon,
        "203.0.113.10",
    );
    let unknown = call(
        &open,
        "certVerify",
        &input(&"d".repeat(32)),
        false,
        &anon,
        "203.0.113.10",
    );
    assert_eq!(refusal(&malformed), refusal(&unknown));
    assert!(names(&unknown, "academy.cert_not_found"));
    db.client()
        .execute(
            "UPDATE academy.cert_grants SET status = 'revoked' WHERE public_id = $1",
            &[&mine.public_id],
        )
        .unwrap();
    let revoked = ok(call(
        &open,
        "certVerify",
        &input(&mine.public_id),
        false,
        &anon,
        "203.0.113.10",
    ));
    assert_eq!(at(&revoked, &["status"]), s("revoked"));
    let Json::Object(keys) = &revoked else {
        panic!()
    };
    let mut keys: Vec<&str> = keys.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["certId", "grantedAt", "status", "title"]);

    let capped = door(&db, Some((1, 60)));
    let first = call(
        &capped,
        "certVerify",
        &input(&"e".repeat(32)),
        false,
        &anon,
        "203.0.113.20",
    );
    assert!(names(&first, "academy.cert_not_found"));
    let limited = call(
        &capped,
        "certVerify",
        &input(&"f".repeat(32)),
        false,
        &anon,
        "203.0.113.20",
    );
    let (_, code, msg, _) = refusal(&limited);
    assert_eq!(
        (code, msg),
        (s("TOO_MANY_REQUESTS"), s("academy.verify_rate_limited"))
    );
    let second = call(
        &capped,
        "certVerify",
        &input(&"e".repeat(32)),
        false,
        &anon,
        "203.0.113.21",
    );
    assert!(names(&second, "academy.cert_not_found"));
    let nowhere = call(
        &capped,
        "certVerify",
        &input(&mine.public_id),
        false,
        &anon,
        "",
    );
    assert_eq!(refusal(&nowhere).2, s("academy.verify_address_unset"));
}

#[test]
fn a_holder_name_shows_only_after_that_holder_consents() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let c = certs(&store, &plain());
    for slug in items() {
        complete(&db, &c, USER, &slug, T0);
        complete(&db, &c, OTHER, &slug, T0);
    }
    let mine = c.grant_cert(USER, CERT, false, T0).unwrap().public_id;
    let theirs = c.grant_cert(OTHER, CERT, false, T0).unwrap().public_id;
    let d = door(&db, Some((20, 60)));
    let anon = headers(None, &[], false);
    let verify = |id: &str| {
        ok(call(
            &d,
            "certVerify",
            &Json::obj([("publicId", s(id))]),
            false,
            &anon,
            "203.0.113.30",
        ))
    };
    assert_eq!(at(&verify(&mine), &["holderName"]), Json::Null);
    assert!(verify(&mine).get("holderName").is_none());

    let holder = headers(Some(USER), &["academy:read", "academy:write"], false);
    let name = |who: &[(String, String)], fields: Vec<(&str, Json)>| {
        call(
            &d,
            "setCertHolderName",
            &Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()),
            true,
            who,
            "203.0.113.30",
        )
    };
    let named = ok(name(
        &holder,
        vec![
            ("publicId", s(&mine)),
            ("holderName", s("  Ada Lovelace  ")),
            ("consent", Json::Bool(true)),
            ("clientRequestId", s("name-1")),
        ],
    ));
    assert_eq!(at(&named, &["holderName"]), s("Ada Lovelace"));
    let shown = verify(&mine);
    assert_eq!(at(&shown, &["holderName"]), s("Ada Lovelace"));
    let Json::Object(keys) = &shown else { panic!() };
    let mut keys: Vec<&str> = keys.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["certId", "grantedAt", "holderName", "status", "title"]
    );

    let replay = ok(name(
        &holder,
        vec![
            ("publicId", s(&mine)),
            ("holderName", s("Bob")),
            ("consent", Json::Bool(true)),
            ("clientRequestId", s("name-1")),
        ],
    ));
    assert_eq!(at(&replay, &["holderName"]), s("Ada Lovelace"));
    assert_eq!(at(&replay, &["consentAt"]), at(&named, &["consentAt"]));
    assert_eq!(at(&verify(&mine), &["holderName"]), s("Ada Lovelace"));

    let cleared = ok(name(
        &holder,
        vec![
            ("grantId", s(CERT)),
            ("holderName", Json::Null),
            ("consent", Json::Bool(true)),
            ("clientRequestId", s("name-2")),
        ],
    ));
    assert_eq!(at(&cleared, &["holderName"]), Json::Null);
    assert!(verify(&mine).get("holderName").is_none());

    let stranger = headers(Some(OTHER), &["academy:read", "academy:write"], false);
    let refused = name(
        &stranger,
        vec![
            ("publicId", s(&mine)),
            ("holderName", s("Not theirs")),
            ("consent", Json::Bool(true)),
            ("clientRequestId", s("name-other")),
        ],
    );
    let (_, code, _, cause) = refusal(&refused);
    assert_eq!((code, cause), (s("NOT_FOUND"), s("academy.cert_not_found")));
    assert!(verify(&theirs).get("holderName").is_none());

    let newline = name(
        &holder,
        vec![
            ("publicId", s(&mine)),
            ("holderName", s("Ada\nLovelace")),
            ("consent", Json::Bool(true)),
            ("clientRequestId", s("name-3")),
        ],
    );
    let (_, code, _, cause) = refusal(&newline);
    assert_eq!(
        (code, cause),
        (s("BAD_REQUEST"), s("academy.holder_name_invalid"))
    );
}

// ── designs-router.test.ts ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_design_calls_need_admin_read_to_read_and_admin_compliance_to_write() {
    let Some(db) = TestDb::migrated() else { return };
    let d = door(&db, None);
    let save = Json::obj([
        ("certId", s(CERT)),
        ("revision", Json::int(5)),
        ("title", s("TEST")),
        ("body", s("TEST")),
        ("signatories", Json::Array(vec![])),
        ("disclaimer", Json::Null),
        ("language", s("en")),
        ("size", s("a4")),
        ("effortHours", Json::Null),
        ("reason", s("TEST")),
    ]);
    let act = Json::obj([
        ("certId", s(CERT)),
        ("revision", Json::int(1)),
        ("reason", s("TEST")),
    ]);
    let deact = Json::obj([("certId", s(CERT)), ("reason", s("TEST"))]);
    let n1 = Json::obj([("n", Json::int(1))]);
    let empty = Json::obj([]);

    let reader = headers(Some(OPERATOR), &["admin:read"], false);
    let list = ok(call(&d, "admin.certDesigns", &empty, false, &reader, ""));
    let Json::Array(items) = at(&list, &["items"]) else {
        panic!()
    };
    assert_eq!(at(&items[0], &["certId"]), s(CERT));
    assert_eq!(at(&items[0], &["design"]), Json::Null);
    assert_eq!(
        ok(call(&d, "admin.issuedCerts", &empty, false, &reader, "")),
        Json::obj([
            ("counts", Json::Array(vec![])),
            ("total", Json::int(0)),
            ("items", Json::Array(vec![]))
        ])
    );
    let forbidden = |who: &[(String, String)], path: &str, input: &Json| {
        let a = call(&d, path, input, true, who, "");
        assert_eq!(refusal(&a).1, s("FORBIDDEN"), "{path}: {}", a.1.compact());
    };
    forbidden(&reader, "admin.saveCertDesign", &save);

    let writer = headers(Some(OPERATOR), &["admin:read", "admin:write"], false);
    forbidden(&writer, "admin.saveCertDesign", &save);
    forbidden(&writer, "admin.activateCertDesign", &act);
    forbidden(&writer, "admin.deactivateCertDesign", &deact);
    forbidden(&writer, "admin.makeCertExport", &n1);

    // Compliance reaches the service, and each refusal keeps its code and its tRPC status on the wire.
    let compliance = headers(Some(OPERATOR), &["admin:read", "admin:compliance"], false);
    let refused = |path: &str, input: &Json, mutation: bool, want: (&str, &str)| {
        let a = call(&d, path, input, mutation, &compliance, "");
        let (_, code, _, cause) = refusal(&a);
        assert_eq!(
            (code, cause),
            (s(want.1), s(want.0)),
            "{path}: {}",
            a.1.compact()
        );
    };
    refused(
        "admin.saveCertDesign",
        &save,
        true,
        ("academy.cert_design_stale", "CONFLICT"),
    );
    refused(
        "admin.activateCertDesign",
        &act,
        true,
        ("academy.cert_design_not_found", "NOT_FOUND"),
    );
    refused(
        "admin.certExportFile",
        &n1,
        false,
        ("academy.report_not_found", "NOT_FOUND"),
    );

    let forged = headers(Some(OPERATOR), &["admin:read"], true);
    let a = call(&d, "admin.certDesigns", &empty, false, &forged, "");
    assert_eq!(refusal(&a).1, s("UNAUTHORIZED"));
}

// ── failure branches: a crash between the durable write and its XP ───────────────────────────────────────────────

fn bus_options<'a>(p: &'a BusPublisher<'a>) -> Options<'a> {
    Options { xp: p, ..plain() }
}

#[test]
fn a_grant_whose_xp_publish_fails_stands_and_the_next_claim_publishes_it() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let bus = FlakyBus::default();
    let p = BusPublisher {
        bus: &bus,
        producer: "svc-academy".to_owned(),
        clock: wall,
    };
    let c = certs(&store, &bus_options(&p));
    finish(&db, &c, USER, T0, &items());
    bus.set_down(true);
    let lost = c.grant_cert(USER, CERT, false, T0).unwrap();
    assert_eq!(lost.xp, Emit::Skipped(Skip::PublishFailed));
    assert!(!lost.already_granted);
    assert_eq!(grants(&db), 1, "the grant is the durable fact");
    assert!(bus.reached().is_empty());
    bus.set_down(false);
    let recovered = c.grant_cert(USER, CERT, false, T0).unwrap();
    assert!(recovered.already_granted);
    assert_eq!(recovered.public_id, lost.public_id);
    assert_eq!(bus.reached(), [format!("academy.cert:cert:{USER}:{CERT}")]);
    assert_eq!(grants(&db), 1);
}

#[test]
fn a_revocation_whose_reversal_fails_stands_and_the_settle_reverses_it() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let bus = FlakyBus::default();
    let p = BusPublisher {
        bus: &bus,
        producer: "svc-academy".to_owned(),
        clock: wall,
    };
    let c = certs(&store, &bus_options(&p));
    let public_id = issued(&db, &c, USER);
    bus.set_down(true);
    c.revoke_cert(&public_id, "TEST revoked", &PAIR, T0)
        .unwrap();
    assert_eq!(status(&c, &public_id), s("revoked"));
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_revocations"),
        1
    );
    assert_eq!(
        bus.reached(),
        [format!("academy.cert:cert:{USER}:{CERT}")],
        "only the first award went out"
    );
    bus.set_down(false);
    let reversed = c.settle_revoked_xp(&public_id).unwrap();
    assert_eq!(
        reversed,
        Emit::Emitted {
            idempotency_key: format!("academy.cert:reverse:cert:{USER}:{CERT}"),
            xp_delta: -100
        }
    );
    assert_eq!(
        bus.reached().last().unwrap(),
        &format!("academy.cert:reverse:cert:{USER}:{CERT}")
    );
    // A repeat revocation answers the record and sends the reversal again, which identity drops on its key.
    c.revoke_cert(&public_id, "TEST again", &PAIR, T0).unwrap();
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_revocations"),
        1
    );
}

#[test]
fn an_exception_whose_xp_publish_fails_stands_and_a_repeat_publishes_it() {
    let Some(db) = TestDb::migrated() else { return };
    let store = Store::Pool(db.pool());
    let bus = FlakyBus::default();
    let p = BusPublisher {
        bus: &bus,
        producer: "svc-academy".to_owned(),
        clock: wall,
    };
    let c = certs(&store, &bus_options(&p));
    enrolment::enroll_cert_path(&c, USER, "foundations", T0).unwrap();
    bus.set_down(true);
    let first = c
        .grant_cert_exception(USER, CERT, "TEST elsewhere", &PAIR, T0)
        .unwrap();
    assert_eq!(grants(&db), 1);
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_exceptions"),
        1
    );
    assert!(bus.reached().is_empty());
    bus.set_down(false);
    assert_eq!(
        c.grant_cert_exception(USER, CERT, "TEST again", &PAIR, T0)
            .unwrap(),
        first
    );
    assert_eq!(bus.reached(), [format!("academy.cert:cert:{USER}:{CERT}")]);
    assert_eq!(
        count(&db, "SELECT COUNT(*)::int FROM academy.cert_exceptions"),
        1
    );
}
