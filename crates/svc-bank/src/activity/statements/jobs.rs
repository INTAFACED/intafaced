//! `statements/statement-jobs.ts`: background exports with a document centre (PF-statements-02, J-portfolio-11 #4, #5).
//!
//! `create` checks the request as a direct download would ([`service::plan`]) and writes one job row keyed by what was
//! asked: the same request from the same person is the same job. The worker claims the oldest queued row, or one whose
//! claim lapsed because its worker died, renders the file as of the moment it was asked for (`as_of`) and writes it once.
//! Off until the worker's interval and claim lease are set: asking then refuses `bank.statement_jobs_unset`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use postgres::Row;
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::{Instant, js_date};

use super::service::{self, Request, StatementFile};
use super::{Deps, bank};
use crate::db::Store;
use crate::errors::Refusal;
use crate::spaces::space::{at, db, pg};

/// `RETRYABLE`: a claim the worker can try again after.
const RETRYABLE: [&str; 1] = ["bank.statement_unavailable"];
/// `STATEMENT_JOB_MAX_ATTEMPTS`.
pub const MAX_ATTEMPTS: i32 = 5;
/// `STATEMENT_JOBS_LIST_LIMIT`.
pub const LIST_LIMIT: i64 = 50;
/// `CLOCK_SKEW_MS`: how far a request's end may be past the bank's clock and still count as ended.
const CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
/// `startStatementJobWorker`'s `batch`: jobs made at most in one tick.
pub const BATCH: usize = 10;

/// `VIEW_COLUMNS`, with each time as epoch milliseconds.
const VIEW_COLUMNS: &str = "id::text, user_id, report, format, from_at, to_at, asset_id, space_id, state, attempts, \
     floor(extract(epoch from as_of) * 1000)::int8, filename, content_type, sha256, signature, row_count, error_code, \
     floor(extract(epoch from created_at) * 1000)::int8, floor(extract(epoch from finished_at) * 1000)::int8";

/// One row of `bank.statement_jobs` (`JobRow`), without its body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: String,
    pub user_id: String,
    pub report: String,
    pub format: String,
    pub from: String,
    pub to: String,
    pub asset_id: Option<String>,
    pub space_id: Option<String>,
    /// `queued`, `rendering`, `ready` or `failed`.
    pub state: String,
    pub attempts: i32,
    pub as_of: Instant,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub sha256: Option<String>,
    pub signature: Option<String>,
    pub row_count: Option<i32>,
    pub error_code: Option<String>,
    pub created_at: Instant,
    pub finished_at: Option<Instant>,
}

impl Job {
    fn from_row(r: &Row) -> Result<Job, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        Ok(Job {
            id: s(0)?,
            user_id: s(1)?,
            report: s(2)?,
            format: s(3)?,
            from: s(4)?,
            to: s(5)?,
            asset_id: o(6)?,
            space_id: o(7)?,
            state: s(8)?,
            attempts: r.try_get(9).map_err(|e| pg(&e))?,
            as_of: Instant(r.try_get(10).map_err(|e| pg(&e))?),
            filename: o(11)?,
            content_type: o(12)?,
            sha256: o(13)?,
            signature: o(14)?,
            row_count: r.try_get(15).map_err(|e| pg(&e))?,
            error_code: o(16)?,
            created_at: Instant(r.try_get(17).map_err(|e| pg(&e))?),
            finished_at: r
                .try_get::<_, Option<i64>>(18)
                .map_err(|e| pg(&e))?
                .map(Instant),
        })
    }

    /// `view`: the job as `jobOutput` sends it.
    pub fn to_json(&self) -> Json {
        let opt = |v: &Option<String>| v.as_ref().map_or(Json::Null, |s| Json::str(s.clone()));
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("report", Json::str(self.report.clone())),
            ("format", Json::str(self.format.clone())),
            ("from", Json::str(self.from.clone())),
            ("to", Json::str(self.to.clone())),
            ("assetId", opt(&self.asset_id)),
            ("spaceId", opt(&self.space_id)),
            ("state", Json::str(self.state.clone())),
            ("attempts", Json::int(i64::from(self.attempts))),
            ("createdAt", Json::str(self.created_at.iso())),
            (
                "finishedAt",
                self.finished_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
            ("filename", opt(&self.filename)),
            ("sha256", opt(&self.sha256)),
            (
                "rowCount",
                self.row_count
                    .map_or(Json::Null, |n| Json::int(i64::from(n))),
            ),
            ("errorCode", opt(&self.error_code)),
        ])
    }
}

/// `StatementJobsConfig`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Config {
    /// How long a claim lasts before the job is re-queued. `None`: background exports are off.
    pub lease_ms: Option<i64>,
    /// TEST only: how long a render waits before it writes.
    pub test_render_hold_ms: Option<i64>,
}

/// A query the TypeScript sends with plain `sql`: the store's own refusal when it cannot serve.
fn client<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    run(store.pool().map_err(db)?, f)
}

/// A query whose text holds `sql.unsafe(VIEW_COLUMNS)`: a store that cannot serve refuses it naming that call, as the
/// TypeScript's `sql` does (the fragment is made before the query is sent).
fn client_unsafe<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    match store {
        Store::Pool(p) => run(p, f),
        Store::Down(m) => Err(Refusal::Other(format!("{m}.unsafe"))),
    }
}

fn run<T>(
    pool: &Pool,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut conn = pool.get().map_err(db)?;
    let c = conn.client().map_err(db)?;
    f(c)
}

fn jobs(rows: &[Row]) -> Result<Vec<Job>, Refusal> {
    rows.iter().map(Job::from_row).collect()
}

/// `instant`: one instant, one spelling.
fn instant(at: &str) -> String {
    js_date(at).map(Instant::iso).unwrap_or_default()
}

/// `statementJobKey`: the business key of a request, so asking again finds the same job.
pub fn job_key(
    report: &str,
    format: &str,
    from: &str,
    to: &str,
    asset_id: Option<&str>,
    space_id: Option<&str>,
) -> String {
    [
        "statement-job",
        report,
        format,
        &instant(from),
        &instant(to),
        asset_id.unwrap_or("-"),
        space_id.unwrap_or("-"),
    ]
    .join(":")
}

fn config<'d>(d: &'d Deps<'_>) -> &'d Config {
    &d.w.statements.jobs
}

/// `enabled`: whether background exports are switched on here.
pub fn enabled(d: &Deps<'_>) -> bool {
    config(d).lease_ms.is_some()
}

/// `create`: refused now if the file would be, else the one job for this request (made if new). The range must have
/// ended, give or take a clock's skew. A request whose earlier job failed is queued again on the same row.
pub fn create(d: &Deps<'_>, user_id: &str, input: &Request, now: Instant) -> Result<Job, Refusal> {
    if !enabled(d) {
        return Err(bank(
            "bank.statement_jobs_unset",
            "Background exports are not switched on in this build",
        ));
    }
    let plan = service::plan(d, user_id, input)?;
    if js_date(&plan.to).is_some_and(|t| t.0 > now.0 + CLOCK_SKEW_MS) {
        return Err(bank(
            "bank.statement_job_unfinished",
            "A background export covers dates that have ended. End it now or earlier.",
        ));
    }
    let space_id = plan.space.as_ref().map(|s| s.id.clone());
    let asset_id = plan.asset_id.clone();
    let key = job_key(
        &plan.report,
        &plan.format,
        &plan.from,
        &plan.to,
        asset_id.as_deref(),
        space_id.as_deref(),
    );
    let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    client_unsafe(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.statement_jobs (id, user_id, key, report, format, from_at, to_at, asset_id, space_id, as_of)
                     VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8, $9, {})
                     ON CONFLICT (user_id, key) DO UPDATE
                        SET state = 'queued', attempts = 0, lease_until = NULL, error_code = NULL, finished_at = NULL,
                            as_of = EXCLUDED.as_of
                      WHERE bank.statement_jobs.state = 'failed'
                     RETURNING {VIEW_COLUMNS}",
                    at("$10")
                ),
                &[
                    &id,
                    &user_id,
                    &key,
                    &plan.report,
                    &plan.format,
                    &plan.from,
                    &plan.to,
                    &asset_id,
                    &space_id,
                    &now.0,
                ],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = rows.first() {
            return Job::from_row(r);
        }
        let found = c
            .query(
                &format!(
                    "SELECT {VIEW_COLUMNS} FROM bank.statement_jobs WHERE user_id = $1 AND key = $2"
                ),
                &[&user_id, &key],
            )
            .map_err(|e| pg(&e))?;
        found.first().map_or_else(
            || {
                Err(Refusal::Other(
                    "statement job vanished between insert and read".to_owned(),
                ))
            },
            Job::from_row,
        )
    })
}

/// `list`: the person's own export jobs, newest first.
pub fn list(d: &Deps<'_>, user_id: &str) -> Result<Vec<Job>, Refusal> {
    client_unsafe(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {VIEW_COLUMNS} FROM bank.statement_jobs WHERE user_id = $1
                      ORDER BY created_at DESC, id DESC LIMIT $2"
                ),
                &[&user_id, &LIST_LIMIT],
            )
            .map_err(|e| pg(&e))?;
        jobs(&rows)
    })
}

/// `download`: the file of one of the person's own jobs, once it is ready. Another person's job reads as not found.
pub fn download(d: &Deps<'_>, user_id: &str, id: &str) -> Result<StatementFile, Refusal> {
    let found = client_unsafe(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {VIEW_COLUMNS}, body FROM bank.statement_jobs WHERE id = $1::text::uuid AND user_id = $2"
                ),
                &[&id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(|r| {
                let body: Option<Vec<u8>> = r.try_get(19).map_err(|e| pg(&e))?;
                Ok::<_, Refusal>((Job::from_row(r)?, body))
            })
            .transpose()
    })?;
    let Some((job, body)) = found else {
        return Err(bank(
            "bank.statement_job_not_found",
            &format!("Export {id} not found"),
        ));
    };
    let ready = || {
        if job.state != "ready" {
            return None;
        }
        let nonempty = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        // `!row.body`: a buffer, even an empty one, is there; an empty string is not.
        Some((
            body.clone()?,
            nonempty(&job.sha256)?,
            nonempty(&job.signature)?,
            nonempty(&job.filename)?,
            nonempty(&job.content_type)?,
        ))
    };
    let Some((body, sha256, signature, filename, content_type)) = ready() else {
        return Err(bank(
            "bank.statement_job_not_ready",
            &format!("Export {id} is {}, so it has no file yet", job.state),
        ));
    };
    let row_count = usize::try_from(job.row_count.unwrap_or(0)).unwrap_or(0);
    Ok(StatementFile {
        format: job.format,
        filename,
        content_type,
        body,
        sha256,
        signature,
        row_count,
        totals: None,
        generated_at: job.as_of.iso(),
        holder_user_id: job.user_id,
        from: job.from,
        to: job.to,
        asset_id: job.asset_id,
        space_id: job.space_id,
        report: job.report,
    })
}

/// `claim`: the oldest job no live worker holds, a queued one whose retry time has come or one whose claim lapsed,
/// re-queued on the same row and `as_of`. A lapsed claim that has used every attempt is marked failed instead.
pub fn claim(d: &Deps<'_>) -> Result<Option<Job>, Refusal> {
    let Some(lease) = config(d).lease_ms else {
        return Ok(None);
    };
    client(d.store(), |c| {
        c.execute(
            "UPDATE bank.statement_jobs
                SET state = 'failed', lease_until = NULL, error_code = 'bank.statement_unavailable', finished_at = now()
              WHERE state = 'rendering' AND lease_until < now() AND attempts >= $1",
            &[&MAX_ATTEMPTS],
        )
        .map_err(|e| pg(&e))?;
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.statement_jobs
                        SET state = 'rendering', attempts = attempts + 1,
                            lease_until = now() + ($1::int8 * interval '1 millisecond')
                      WHERE id = (
                        SELECT id FROM bank.statement_jobs
                         WHERE (state = 'queued' AND (lease_until IS NULL OR lease_until < now()))
                            OR (state = 'rendering' AND lease_until < now() AND attempts < $2)
                         ORDER BY created_at, id
                         LIMIT 1
                         FOR UPDATE SKIP LOCKED
                      )
                     RETURNING {VIEW_COLUMNS}"
                ),
                &[&lease, &MAX_ATTEMPTS],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(Job::from_row).transpose()
    })
}

/// `current`: the job as it stands now, when this worker's claim was lost to another.
fn current(d: &Deps<'_>, id: &str) -> Result<Job, Refusal> {
    client_unsafe(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {VIEW_COLUMNS} FROM bank.statement_jobs WHERE id = $1::text::uuid"
                ),
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map_or_else(
            || Err(Refusal::Other(format!("statement job {id} vanished"))),
            Job::from_row,
        )
    })
}

/// Sleeps `total` in short steps, stopping early once `stop` is set; whether it slept the whole time.
fn sleep_unless(stop: &AtomicBool, total: Duration) -> bool {
    let step = Duration::from_millis(10);
    let started = std::time::Instant::now();
    while started.elapsed() < total {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(step.min(total.saturating_sub(started.elapsed())));
    }
    !stop.load(Ordering::SeqCst)
}

/// `renderNext`: claims and makes one job; `None` when there was nothing to claim. While it renders the claim is renewed
/// every half lease, so a long render is never taken by a second worker; a worker that dies stops renewing.
pub fn render_next(d: &Deps<'_>) -> Result<Option<Job>, Refusal> {
    let Some(job) = claim(d)? else {
        return Ok(None);
    };
    let lease = config(d).lease_ms.unwrap_or(0);
    let every = Duration::from_millis(u64::try_from((lease / 2).max(1)).unwrap_or(1));
    let done = AtomicBool::new(false);
    let store = d.store();
    let (id, attempts) = (job.id.clone(), job.attempts);
    std::thread::scope(|s| {
        s.spawn(|| {
            while sleep_unless(&done, every) {
                // A failed renewal is dropped, as the TypeScript's `.catch(() => undefined)` drops it.
                let _ = client(store, |c| {
                    c.execute(
                        "UPDATE bank.statement_jobs SET lease_until = now() + ($1::int8 * interval '1 millisecond')
                          WHERE id = $2::text::uuid AND state = 'rendering' AND attempts = $3",
                        &[&lease, &id, &attempts],
                    )
                    .map_err(|e| pg(&e))
                });
            }
        });
        let out = make(d, &job, lease);
        done.store(true, Ordering::SeqCst);
        out.map(Some)
    })
}

/// `make`: the file of a claimed job, written once, or the job re-queued or failed. Only the claim this worker holds is
/// changed.
fn make(d: &Deps<'_>, job: &Job, lease: i64) -> Result<Job, Refusal> {
    let hold = config(d).test_render_hold_ms.unwrap_or(0);
    if hold > 0 {
        std::thread::sleep(Duration::from_millis(u64::try_from(hold).unwrap_or(0)));
    }
    let request = Request {
        from: job.from.clone(),
        to: job.to.clone(),
        format: job.format.clone(),
        report: Some(job.report.clone()),
        asset_id: job.asset_id.clone().filter(|_| job.space_id.is_none()),
        space_id: job.space_id.clone(),
    };
    let made = service::plan(d, &job.user_id, &request)
        .and_then(|p| service::render(d, &job.user_id, &p, job.as_of));
    let file = match made {
        Ok(file) => file,
        Err(err) => {
            let (code, is_bank) = match &err {
                Refusal::Bank(e) => (e.row.code, true),
                _ => ("bank.statement_unavailable", false),
            };
            let again = (RETRYABLE.contains(&code) || !is_bank) && job.attempts < MAX_ATTEMPTS;
            let after = client_unsafe(d.store(), |c| {
                let rows = if again {
                    c.query(
                        &format!(
                            "UPDATE bank.statement_jobs
                                SET state = 'queued', lease_until = now() + ($1::int8 * interval '1 millisecond')
                              WHERE id = $2::text::uuid AND state = 'rendering' AND attempts = $3
                             RETURNING {VIEW_COLUMNS}"
                        ),
                        &[&lease, &job.id, &job.attempts],
                    )
                } else {
                    c.query(
                        &format!(
                            "UPDATE bank.statement_jobs
                                SET state = 'failed', lease_until = NULL, error_code = $1, finished_at = now()
                              WHERE id = $2::text::uuid AND state = 'rendering' AND attempts = $3
                             RETURNING {VIEW_COLUMNS}"
                        ),
                        &[&code, &job.id, &job.attempts],
                    )
                }
                .map_err(|e| pg(&e))?;
                rows.first().map(Job::from_row).transpose()
            })?;
            return match after {
                Some(j) => Ok(j),
                None => current(d, &job.id),
            };
        }
    };
    let row_count = i32::try_from(file.row_count).unwrap_or(i32::MAX);
    let done = client_unsafe(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.statement_jobs
                        SET state = 'ready', lease_until = NULL, filename = $1, content_type = $2,
                            body = $3, sha256 = $4, signature = $5, row_count = $6, finished_at = now()
                      WHERE id = $7::text::uuid AND state = 'rendering' AND attempts = $8
                     RETURNING {VIEW_COLUMNS}"
                ),
                &[
                    &file.filename,
                    &file.content_type,
                    &file.body,
                    &file.sha256,
                    &file.signature,
                    &row_count,
                    &job.id,
                    &job.attempts,
                ],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(Job::from_row).transpose()
    })?;
    match done {
        Some(j) => Ok(j),
        None => current(d, &job.id),
    }
}

/// One tick of `startStatementJobWorker`: makes queued jobs one at a time, at most [`BATCH`]. Off (nothing done) while
/// background exports are off.
pub fn tick(d: &Deps<'_>) -> Result<(), Refusal> {
    if !enabled(d) {
        return Ok(());
    }
    for _ in 0..BATCH {
        if render_next(d)?.is_none() {
            break;
        }
    }
    Ok(())
}

/// `optionalInteger`: unset or blank is `None`; anything else must be ASCII digits within `min..=max`.
fn optional_integer(
    name: &str,
    raw: Option<&str>,
    min: i64,
    max: i64,
) -> Result<Option<i64>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let text = service_kit::money::js_trim(raw);
    if text.is_empty() {
        return Ok(None);
    }
    let n = (text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse::<u64>().ok())
        .flatten()
        .and_then(|n| i64::try_from(n).ok())
        .filter(|n| (min..=max).contains(n));
    n.map(Some).ok_or_else(|| {
        format!("{name} must be an integer {min}–{max}, or empty to leave background exports off")
    })
}

/// `parseStatementJobsInterval`.
pub fn parse_interval(raw: Option<&str>) -> Result<Option<i64>, String> {
    optional_integer("BANK_STATEMENT_JOBS_INTERVAL_MS", raw, 500, 3_600_000)
}

/// `parseStatementJobsLease`.
pub fn parse_lease(raw: Option<&str>) -> Result<Option<i64>, String> {
    optional_integer("BANK_STATEMENT_JOBS_LEASE_MS", raw, 1_000, 3_600_000)
}

/// `parseStatementJobsTestHold`: TEST only, and refused outside an explicit dev or test process.
pub fn parse_test_hold(
    raw: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
) -> Result<Option<i64>, String> {
    let hold = optional_integer("BANK_STATEMENT_JOBS_TEST_RENDER_HOLD_MS", raw, 0, 600_000)?;
    if hold.is_some()
        && (!matches!(app_env.unwrap_or_default(), "dev" | "test")
            || node_env == Some("production"))
    {
        return Err(
            "BANK_STATEMENT_JOBS_TEST_RENDER_HOLD_MS is a TEST fault and runs only with APP_ENV exactly dev or test"
                .to_owned(),
        );
    }
    Ok(hold)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    // statement-jobs.db.test.ts: background export settings
    #[test]
    fn stay_off_when_unset_or_blank_and_refuse_boot_when_out_of_range() {
        assert_eq!(parse_interval(None), Ok(None));
        assert_eq!(parse_interval(Some("  ")), Ok(None));
        assert_eq!(parse_interval(Some("2000")), Ok(Some(2000)));
        assert!(
            parse_interval(Some("10"))
                .unwrap_err()
                .contains("BANK_STATEMENT_JOBS_INTERVAL_MS")
        );
        assert_eq!(parse_lease(Some("")), Ok(None));
        assert!(
            parse_lease(Some("soon"))
                .unwrap_err()
                .contains("BANK_STATEMENT_JOBS_LEASE_MS")
        );
    }

    #[test]
    fn the_test_render_hold_runs_only_in_an_explicit_dev_or_test_process() {
        assert_eq!(parse_test_hold(None, Some("prod"), None), Ok(None));
        assert_eq!(
            parse_test_hold(Some("5000"), Some("dev"), None),
            Ok(Some(5000))
        );
        assert!(
            parse_test_hold(Some("5000"), Some("prod"), None)
                .unwrap_err()
                .contains("TEST fault")
        );
        assert!(
            parse_test_hold(Some("5000"), Some("test"), Some("production"))
                .unwrap_err()
                .contains("TEST fault")
        );
    }

    #[test]
    fn the_same_request_has_one_key_however_its_instants_are_spelled() {
        let a = job_key(
            "ledger",
            "csv",
            "2025-11-07T00:00:00.000Z",
            "2026-11-06T00:00:00.000Z",
            None,
            None,
        );
        assert_eq!(
            a,
            "statement-job:ledger:csv:2025-11-07T00:00:00.000Z:2026-11-06T00:00:00.000Z:-:-"
        );
        let b = job_key(
            "ledger",
            "csv",
            "2025-11-07T00:00:00Z",
            "2026-11-06T08:00:00+08:00",
            None,
            None,
        );
        assert_eq!(a, b);
    }
}
