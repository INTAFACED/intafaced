//! Part `statements` of slice `activity` against a real Postgres: the checks of `statements/statement-jobs.db.test.ts`
//! (PF-statements-02, J-portfolio-11 #4, #5), each test named after the TypeScript test's words. A request is checked
//! when asked, the same request is the same job, a worker that dies mid-render leaves a claim that lapses and is taken
//! again on the same key, and the second file is byte for byte the file a direct download makes as of the same moment.
//!
//! The TypeScript reads its lines through a real `ActivityService` over stand-in ledger pages; here the feed is a stand-in
//! `Collect` that answers the two lines that feed makes of those pages for every person (a manual transfer's debit of
//! 2.25 USDT, money in, and its credit of 12.50 USDT, money out), within the range, asset and kinds asked, and that can
//! be down (the feed's history unavailable) or hold its read for one person until the test opens it.
//!
//! Ported elsewhere or in part, with the reason: "background export settings" (both tests) are pure parsing, ported as
//! unit tests in `src/activity/statements/jobs.rs`. "the worker makes queued jobs on its interval and stops": the
//! interval, the stop and the "background exports are off" warning are the binary's timer (`timers.rs`, `main.rs`), not
//! this part; here one pass of the worker (`run_statement_jobs`) makes the queued job, and a pass with background
//! exports off makes nothing. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support::TestDb;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use service_kit::time::{Instant, js_date};
use svc_bank::activity::statements::jobs::{self, Config, Job};
use svc_bank::activity::statements::service::{self, Request};
use svc_bank::activity::statements::{
    Collect, CollectError, Line, Query, Wiring as StatementsWiring, run_statement_jobs,
};
use svc_bank::activity::{Deps, Wiring};
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::errors::Refusal;

const SECRET: &str = "a-bank-statement-job-test-secret-long-enough";
const EDGE: &str = "a-bank-statement-job-test-edge-secret-long";

static USERS: AtomicUsize = AtomicUsize::new(0);

fn fresh() -> String {
    format!(
        "00000000-0000-4000-8000-{:012}",
        USERS.fetch_add(1, Ordering::SeqCst) + 1
    )
}

/// One person's read held until the test opens it: `entered` says the read began.
struct Gate {
    who: String,
    entered: Mutex<Sender<()>>,
    open: Mutex<Receiver<()>>,
}

/// The feed: two posted lines for every person; `down` makes the read fail as an outage would.
#[derive(Clone, Default)]
struct Feed {
    down: Arc<AtomicBool>,
    gate: Arc<Mutex<Option<Gate>>>,
}

impl Collect for Feed {
    fn collect(&self, _: &Deps<'_>, user: &str, q: &Query<'_>) -> Result<Vec<Line>, CollectError> {
        let held = self.gate.lock().unwrap().take();
        if let Some(g) = held {
            if g.who == user {
                g.entered.lock().unwrap().send(()).unwrap();
                // Opened, or the test gave up on it.
                let _ = g.open.lock().unwrap().recv();
            } else {
                *self.gate.lock().unwrap() = Some(g);
            }
        }
        if self.down.load(Ordering::SeqCst) {
            return Err(CollectError::Unavailable(
                "ledger history unreachable".to_owned(),
            ));
        }
        let line = |tx: &str, direction: &str, amount: &str, at: &str| Line {
            id: format!("{tx}:0"),
            kind: "transfer".to_owned(),
            direction: direction.to_owned(),
            asset: "USDT".to_owned(),
            amount: amount.to_owned(),
            posted_at: at.to_owned(),
            tx_id: tx.to_owned(),
            ..Line::default()
        };
        let (from, to) = (js_date(q.from).unwrap().0, js_date(q.to).unwrap().0);
        Ok([
            line("tx-2", "in", "2.25", "2026-10-05T00:00:00.000Z"),
            line("tx-1", "out", "12.50", "2026-10-04T00:00:00.000Z"),
        ]
        .into_iter()
        .filter(|l| {
            let at = js_date(&l.posted_at).unwrap().0;
            at >= from
                && at <= to
                && q.asset_id.is_none_or(|a| a == l.asset)
                && q.kind.is_none_or(|k| k.contains(&l.kind.as_str()))
        })
        .take(q.limit)
        .collect())
    }
}

fn door(db: &TestDb, lease_ms: Option<i64>, feed: &Feed) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
        edge_secret: EDGE.to_owned(),
        services: ServiceAuth::unwired(),
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_activity(Wiring {
        cursor_secret: Some(SECRET.to_owned()),
        statements: StatementsWiring {
            collect: Box::new(feed.clone()),
            jobs: Config {
                lease_ms,
                test_render_hold_ms: None,
            },
        },
        ..Wiring::none()
    })
}

fn setup() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

fn now() -> Instant {
    door::system_now()
}

fn at(s: &str) -> Instant {
    js_date(s).unwrap()
}

/// `LONG`: a ledger export of a year that has ended.
fn long() -> Request {
    Request {
        from: "2025-11-07T00:00:00.000Z".to_owned(),
        to: "2026-11-06T00:00:00.000Z".to_owned(),
        format: "csv".to_owned(),
        report: Some("ledger".to_owned()),
        ..Request::default()
    }
}

fn with(r: Request, f: impl FnOnce(&mut Request)) -> Request {
    let mut r = r;
    f(&mut r);
    r
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> &'static str {
    match r {
        Err(Refusal::Bank(e)) => e.row.code,
        other => panic!("not a BankError: {other:?}"),
    }
}

fn create(b: &BankDoor, who: &str, r: &Request, when: Instant) -> Result<Job, Refusal> {
    b.activity_deps(when, |d| jobs::create(d, who, r, when))
}

fn list(b: &BankDoor, who: &str) -> Vec<Job> {
    b.activity_deps(now(), |d| jobs::list(d, who)).unwrap()
}

fn render_next(b: &BankDoor) -> Option<Job> {
    b.activity_deps(now(), jobs::render_next).unwrap()
}

fn claim(b: &BankDoor) -> Option<Job> {
    b.activity_deps(now(), jobs::claim).unwrap()
}

/// `renderNext` until it makes `id` or finds nothing.
fn render_until(b: &BankDoor, id: &str) -> Option<Job> {
    let mut made = render_next(b);
    while made.as_ref().is_some_and(|j| j.id != id) {
        made = render_next(b);
    }
    made
}

fn claim_until(b: &BankDoor, id: &str) -> Option<Job> {
    let mut got = claim(b);
    while got.as_ref().is_some_and(|j| j.id != id) {
        got = claim(b);
    }
    got
}

fn export(b: &BankDoor, who: &str, r: &Request, as_of: Instant) -> service::StatementFile {
    b.activity_deps(as_of, |d| service::export(d, who, r, as_of))
        .unwrap()
}

fn download(b: &BankDoor, who: &str, id: &str) -> Result<service::StatementFile, Refusal> {
    b.activity_deps(now(), |d| jobs::download(d, who, id))
}

#[test]
fn refuses_when_background_exports_are_off_and_writes_no_row() {
    let Some(db) = setup() else { return };
    let b = door(&db, None, &Feed::default());
    let who = fresh();
    assert_eq!(
        code(create(&b, &who, &long(), now())),
        "bank.statement_jobs_unset"
    );
    assert!(list(&b, &who).is_empty());
}

#[test]
fn refuses_at_request_what_the_file_would_be_refused_for_before_any_row() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(60_000), &Feed::default());
    let who = fresh();
    let pdf = Request {
        from: "2026-09-20T00:00:00.000Z".to_owned(),
        to: "2026-10-02T00:00:00.000Z".to_owned(),
        format: "pdf".to_owned(),
        ..Request::default()
    };
    assert_eq!(
        code(create(&b, &who, &pdf, now())),
        "bank.statement_pdf_one_month"
    );
    let balances = with(long(), |r| r.report = Some("balances".to_owned()));
    assert_eq!(
        code(create(&b, &who, &balances, now())),
        "bank.statement_balances_unavailable"
    );
    let wide = with(long(), |r| r.from = "2024-01-01T00:00:00.000Z".to_owned());
    assert_eq!(code(create(&b, &who, &wide, now())), "bank.statement_range");
    assert!(list(&b, &who).is_empty());
}

#[test]
fn returns_the_same_job_for_the_same_request_however_the_instants_are_spelled() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(60_000), &Feed::default());
    let who = fresh();
    let first = create(&b, &who, &long(), now()).unwrap();
    assert_eq!(
        (
            first.state.as_str(),
            first.attempts,
            first.report.as_str(),
            first.format.as_str()
        ),
        ("queued", 0, "ledger", "csv")
    );
    let respelled = with(long(), |r| {
        r.from = "2025-11-07T00:00:00Z".to_owned();
        r.to = "2026-11-06T08:00:00+08:00".to_owned();
    });
    assert_eq!(create(&b, &who, &respelled, now()).unwrap().id, first.id);
    let other = create(
        &b,
        &who,
        &with(long(), |r| r.report = Some("trades".to_owned())),
        now(),
    )
    .unwrap();
    assert_ne!(other.id, first.id);
    assert_eq!(
        list(&b, &who)
            .iter()
            .map(|j| j.id.clone())
            .collect::<Vec<_>>(),
        vec![other.id, first.id]
    );
    assert_eq!(
        jobs::job_key(
            "ledger",
            "csv",
            "2025-11-07T00:00:00.000Z",
            "2026-11-06T00:00:00.000Z",
            None,
            None
        ),
        "statement-job:ledger:csv:2025-11-07T00:00:00.000Z:2026-11-06T00:00:00.000Z:-:-"
    );
}

#[test]
fn makes_a_queued_job_and_hands_back_the_same_file_a_direct_download_makes_as_of_the_same_moment() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(60_000), &Feed::default());
    let who = fresh();
    let as_of = at("2026-11-06T01:02:03.000Z");
    let job = create(&b, &who, &long(), as_of).unwrap();
    assert_eq!(
        code(download(&b, &who, &job.id)),
        "bank.statement_job_not_ready"
    );
    let made = render_until(&b, &job.id).unwrap();
    assert_eq!(
        (
            made.id.as_str(),
            made.state.as_str(),
            made.attempts,
            made.row_count
        ),
        (job.id.as_str(), "ready", 1, Some(2))
    );
    let file = download(&b, &who, &job.id).unwrap();
    let direct = export(&b, &who, &long(), as_of);
    assert_eq!(file.body, direct.body);
    assert_eq!(file.sha256, direct.sha256);
    assert_eq!(file.signature, direct.signature);
    assert_eq!(
        (
            file.holder_user_id.as_str(),
            file.report.as_str(),
            file.generated_at.as_str(),
            file.sha256.as_str()
        ),
        (
            who.as_str(),
            "ledger",
            "2026-11-06T01:02:03.000Z",
            direct.sha256.as_str()
        )
    );
    // A stored file is handed back without its totals, as `download` builds it.
    assert!(file.to_json().get("totals").is_none());
}

#[test]
fn re_queues_a_job_whose_worker_died_mid_render_on_the_same_key_and_the_second_file_has_the_same_content()
 {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(50), &Feed::default());
    let who = fresh();
    let job = create(&b, &who, &long(), now()).unwrap();
    // A worker claims it and dies: nothing it would have written is written.
    let dead = claim_until(&b, &job.id).unwrap();
    assert_eq!(
        (dead.id.as_str(), dead.state.as_str(), dead.attempts),
        (job.id.as_str(), "rendering", 1)
    );
    std::thread::sleep(Duration::from_millis(120));
    let made = render_until(&b, &job.id).unwrap();
    assert_eq!(
        (made.id.as_str(), made.state.as_str(), made.attempts),
        (job.id.as_str(), "ready", 2)
    );
    // Still one job for the request.
    assert_eq!(create(&b, &who, &long(), now()).unwrap().id, job.id);
    assert_eq!(list(&b, &who).len(), 1);
    let direct = export(&b, &who, &long(), job.created_at);
    let file = download(&b, &who, &job.id).unwrap();
    assert_eq!(file.sha256, direct.sha256);
    assert_eq!(file.body, direct.body);
}

#[test]
fn a_stale_worker_cannot_overwrite_the_claim_another_worker_took_after_its_lease_lapsed() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(50), &Feed::default());
    let who = fresh();
    let job = create(
        &b,
        &who,
        &with(long(), |r| r.report = Some("trades".to_owned())),
        now(),
    )
    .unwrap();
    let first = claim_until(&b, &job.id).unwrap();
    std::thread::sleep(Duration::from_millis(120));
    let second = claim_until(&b, &job.id).unwrap();
    assert_eq!((second.id.as_str(), second.attempts), (job.id.as_str(), 2));
    // The first worker comes back and tries to fail the job on its old claim: nothing changes.
    let touched = db
        .client()
        .query(
            "UPDATE bank.statement_jobs SET state = 'failed', error_code = 'x', finished_at = now(), lease_until = NULL
              WHERE id = $1::text::uuid AND state = 'rendering' AND attempts = $2
             RETURNING id",
            &[&job.id, &first.attempts],
        )
        .unwrap();
    assert_eq!(touched.len(), 0);
}

#[test]
fn re_queues_on_an_activity_outage_after_a_wait_and_only_another_person_reads_as_not_found() {
    let Some(db) = setup() else { return };
    let feed = Feed::default();
    feed.down.store(true, Ordering::SeqCst);
    let b = door(&db, Some(200), &feed);
    let who = fresh();
    let job = create(
        &b,
        &who,
        &with(long(), |r| r.report = Some("statement".to_owned())),
        now(),
    )
    .unwrap();
    let made = render_until(&b, &job.id).unwrap();
    assert_eq!(
        (made.id.as_str(), made.state.as_str(), made.attempts),
        (job.id.as_str(), "queued", 1)
    );
    feed.down.store(false, Ordering::SeqCst);
    // Not claimed again in the same breath: a brief outage cannot use every attempt at once.
    assert_ne!(render_next(&b).map(|j| j.id), Some(job.id.clone()));
    std::thread::sleep(Duration::from_millis(250));
    let made = render_until(&b, &job.id).unwrap();
    assert_eq!(
        (made.id.as_str(), made.state.as_str(), made.attempts),
        (job.id.as_str(), "ready", 2)
    );
    let stranger = fresh();
    assert_eq!(
        code(download(&b, &stranger, &job.id)),
        "bank.statement_job_not_found"
    );
    assert!(list(&b, &stranger).is_empty());
}

#[test]
fn refuses_a_range_that_has_not_ended_so_the_same_request_is_always_the_same_document() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(60_000), &Feed::default());
    let open = with(long(), |r| {
        r.from = "2026-11-01T00:00:00.000Z".to_owned();
        r.to = "2026-11-06T23:59:59.999Z".to_owned();
    });
    assert_eq!(
        code(create(&b, &fresh(), &open, at("2026-11-06T10:00:00.000Z"))),
        "bank.statement_job_unfinished"
    );
}

#[test]
fn queues_a_failed_request_again_when_it_is_asked_for_again() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(60_000), &Feed::default());
    let who = fresh();
    let r = with(long(), |r| {
        r.report = Some("trades".to_owned());
        r.to = "2026-11-04T00:00:00.000Z".to_owned();
    });
    let job = create(&b, &who, &r, now()).unwrap();
    db.client()
        .execute(
            "UPDATE bank.statement_jobs SET state = 'failed', error_code = 'bank.statement_unavailable', finished_at = now(),
                    attempts = 5
              WHERE id = $1::text::uuid",
            &[&job.id],
        )
        .unwrap();
    let again = create(&b, &who, &r, now()).unwrap();
    assert_eq!(
        (
            again.id.as_str(),
            again.state.as_str(),
            again.attempts,
            again.error_code
        ),
        (job.id.as_str(), "queued", 0, None)
    );
}

#[test]
fn marks_failed_a_lapsed_claim_that_has_used_every_attempt_instead_of_claiming_it_again() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(50), &Feed::default());
    let who = fresh();
    let r = with(long(), |r| {
        r.report = Some("trades".to_owned());
        r.to = "2026-11-03T00:00:00.000Z".to_owned();
    });
    let job = create(&b, &who, &r, now()).unwrap();
    db.client()
        .execute(
            "UPDATE bank.statement_jobs SET state = 'rendering', attempts = 5, lease_until = now() - interval '1 second'
              WHERE id = $1::text::uuid",
            &[&job.id],
        )
        .unwrap();
    assert!(render_until(&b, &job.id).is_none());
    let listed = &list(&b, &who)[0];
    assert_eq!(
        (
            listed.id.as_str(),
            listed.state.as_str(),
            listed.error_code.as_deref()
        ),
        (
            job.id.as_str(),
            "failed",
            Some("bank.statement_unavailable")
        )
    );
}

#[test]
fn a_background_pdf_is_the_direct_download_of_the_same_request_byte_for_byte_as_the_dates_were_spelled()
 {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(60_000), &Feed::default());
    let who = fresh();
    let request = Request {
        from: "2026-10-01T00:00:00Z".to_owned(),
        to: "2026-10-31T23:59:59Z".to_owned(),
        format: "pdf".to_owned(),
        ..Request::default()
    };
    let as_of = at("2026-11-06T02:00:00.000Z");
    let job = create(&b, &who, &request, as_of).unwrap();
    let made = render_until(&b, &job.id).unwrap();
    assert_eq!(made.state, "ready");
    let direct = export(&b, &who, &request, as_of);
    assert_eq!(download(&b, &who, &job.id).unwrap().body, direct.body);
}

#[test]
fn renews_its_claim_while_a_render_runs_so_a_long_render_is_not_taken_by_a_second_worker() {
    // No race on wall time: the render is held by a gate the test opens, the claim's first lease is made to run out on
    // purpose, and the second worker tries only once the renewal has put a whole fresh lease back.
    let Some(db) = setup() else { return };
    let lease_ms = 2_000;
    let held = Feed::default();
    let slow = door(&db, Some(lease_ms), &held);
    let other = door(&db, Some(lease_ms), &Feed::default());
    // Make everything older first, so the slow worker claims this job.
    while render_next(&other).is_some() {}
    let who = fresh();
    let r = with(long(), |r| {
        r.report = Some("trades".to_owned());
        r.to = "2026-11-02T00:00:00.000Z".to_owned();
    });
    let job = create(&slow, &who, &r, now()).unwrap();
    let (entered_tx, entered_rx) = channel();
    let (open_tx, open_rx) = channel();
    *held.gate.lock().unwrap() = Some(Gate {
        who: who.clone(),
        entered: Mutex::new(entered_tx),
        open: Mutex::new(open_rx),
    });
    let made = std::thread::scope(|s| {
        // Owned here, so a failed check below drops it and the held read goes on rather than hang the test.
        let open_tx = open_tx;
        let making = s.spawn(|| render_until(&slow, &job.id));
        entered_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the render began");
        // The first lease runs out: without a renewal, the next claim would take this job.
        let mut c = db.client();
        c.execute(
            "UPDATE bank.statement_jobs SET lease_until = now() - interval '1 second' WHERE id = $1::text::uuid",
            &[&job.id],
        )
        .unwrap();
        let started = std::time::Instant::now();
        loop {
            let left: f64 = c
                .query_one(
                    "SELECT (extract(epoch FROM (lease_until - now())) * 1000)::float8 FROM bank.statement_jobs
                      WHERE id = $1::text::uuid",
                    &[&job.id],
                )
                .unwrap()
                .get(0);
            #[allow(clippy::cast_precision_loss, reason = "a small lease")]
            if left > (lease_ms / 2) as f64 {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the claim was renewed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let stolen = claim(&other);
        assert_ne!(stolen.map(|j| j.id), Some(job.id.clone()));
        open_tx.send(()).unwrap();
        making.join().unwrap()
    })
    .unwrap();
    assert_eq!(
        (made.id.as_str(), made.state.as_str(), made.attempts),
        (job.id.as_str(), "ready", 1)
    );
}

#[test]
fn the_worker_makes_queued_jobs_on_its_interval_and_stops() {
    let Some(db) = setup() else { return };
    let b = door(&db, Some(60_000), &Feed::default());
    let who = fresh();
    let r = with(long(), |r| {
        r.report = Some("statement".to_owned());
        r.to = "2026-11-05T00:00:00.000Z".to_owned();
    });
    let job = create(&b, &who, &r, now()).unwrap();
    // Off, a pass makes nothing.
    let off = door(&db, None, &Feed::default());
    run_statement_jobs(&off, now()).unwrap();
    assert_eq!(list(&b, &who)[0].state, "queued");
    run_statement_jobs(&b, now()).unwrap();
    let listed = list(&b, &who);
    let made = listed.iter().find(|j| j.id == job.id).unwrap();
    assert_eq!(made.state, "ready");
}
