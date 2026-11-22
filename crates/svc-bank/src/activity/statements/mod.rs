//! Part `statements` of the activity slice (`statements/`): the 7 `statements.*` calls and the statement export worker.
//!
//! - `file`: `statement-file.ts`, the CSV, the PDF, the per-asset totals and the signature.
//! - `service`: `statement-service.ts`, the plan of a request, the direct download and `statements.totals`.
//! - `jobs`: `statement-jobs.ts`, background exports (`bank.statement_jobs`), the worker's claim, render and lease.
//!
//! A statement reads the activity feed (`ActivityService.collect`) through [`Collect`], the part of the feed it needs.
//! The router is `statement.router.ts`'s: each refusal passes through `throwBankProcedure` (a `BankError` answers its
//! own status with `<message> (<code>)`, anything else is tRPC's own 500 with its message), not the main guard.

pub mod file;
pub mod jobs;
pub mod service;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::{BankDoor, Ctx};
use crate::errors::{BankError, Refusal};

/// What a statement reads of one feed line (`ActivityItem`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Line {
    pub id: String,
    pub kind: String,
    /// `in` or `out`.
    pub direction: String,
    pub asset: String,
    /// Unsigned decimal string; the direction carries the sign.
    pub amount: String,
    pub posted_at: String,
    pub tx_id: String,
    /// The counterparty's handle.
    pub counterparty: Option<String>,
    pub space_name: Option<String>,
    pub order_id: Option<String>,
    pub note: Option<String>,
    pub reference: Option<String>,
    pub report_description: Option<String>,
}

/// `collect`'s input: the lines between two times, at most `limit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Query<'q> {
    pub from: &'q str,
    pub to: &'q str,
    pub asset_id: Option<&'q str>,
    /// One of the person's own spaces.
    pub account_id: Option<&'q str>,
    /// Only these activity kinds.
    pub kind: Option<&'q [&'q str]>,
    pub limit: usize,
}

/// How `collect` fails, as a statement tells the failures apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectError {
    /// `ActivityUnavailableError`, with its message.
    Unavailable(String),
    /// `ActivityAccountUnknownError`: the account is not the person's.
    AccountUnknown,
    /// Anything else the feed fails with.
    Failed(Refusal),
}

impl CollectError {
    /// The failure when a statement does not tell it apart: thrown on as it is.
    pub fn into_refusal(self) -> Refusal {
        match self {
            CollectError::Unavailable(m) => Refusal::Other(m),
            CollectError::AccountUnknown => Refusal::Other("That account is not yours".to_owned()),
            CollectError::Failed(r) => r,
        }
    }
}

/// `ActivityService.collect`: the person's feed lines in a range, newest first, paged until `limit`.
pub trait Collect: Send + Sync {
    fn collect(
        &self,
        d: &Deps<'_>,
        user_id: &str,
        q: &Query<'_>,
    ) -> Result<Vec<Line>, CollectError>;
}

/// The activity feed (`ActivityService.collect`, part `feed`). The feed's own refusals pass as the errors they are:
/// a statement tells apart only "unavailable" and "not your account"; any other is thrown on as its message, as
/// `throwBankProcedure` answers a plain `Error`.
pub struct Feed;

impl Collect for Feed {
    fn collect(
        &self,
        d: &Deps<'_>,
        user_id: &str,
        q: &Query<'_>,
    ) -> Result<Vec<Line>, CollectError> {
        use super::feed::{self, CollectQuery, FeedError};
        let asked = CollectQuery {
            from: q.from.to_owned(),
            to: q.to.to_owned(),
            asset_id: q.asset_id.map(str::to_owned),
            account_id: q.account_id.map(str::to_owned),
            kind: q.kind.map(|k| k.iter().map(|s| (*s).to_owned()).collect()),
            limit: q.limit,
        };
        let other = |m: &str| CollectError::Failed(Refusal::Other(m.to_owned()));
        let items = feed::collect(d, user_id, asked).map_err(|e| match e {
            FeedError::Unavailable => {
                CollectError::Unavailable("Activity is not available right now".to_owned())
            }
            FeedError::AccountUnknown => CollectError::AccountUnknown,
            FeedError::Bank(b) => CollectError::Failed(Refusal::Bank(b)),
            FeedError::Other(s) => CollectError::Failed(Refusal::Other(s.message)),
            FeedError::CursorInvalid => {
                other("Activity cursor is not valid, start again without a cursor")
            }
            FeedError::Range => other("The end of the range is before the start"),
            FeedError::NotFound => other("That transaction is not in your activity"),
            FeedError::LookupBounded => {
                other("Activity lookup stopped before the end of your history. Try again.")
            }
            FeedError::TaxYearUnset => {
                other("The tax year start is not set. Filter by calendar year instead")
            }
            FeedError::TaxEffectMapUnset => other("The tax effect of each kind of line is not set"),
            FeedError::SortBounded => other(
                "Oldest first is limited to 2,000 matching lines. Narrow the dates, the account or the filters",
            ),
            FeedError::Thrown(code) => other(code),
        })?;
        Ok(items
            .into_iter()
            .map(|i| Line {
                id: i.id,
                kind: i.kind.to_owned(),
                direction: i.direction.to_owned(),
                asset: i.asset,
                amount: service_kit::money::format_amount(i.amount),
                posted_at: i.posted_at.iso(),
                tx_id: i.tx_id,
                counterparty: i.counterparty,
                space_name: i.space_name,
                order_id: i.order_id,
                note: i.note,
                reference: i.reference,
                report_description: i.report_description,
            })
            .collect())
    }
}

/// What the door holds for this part, built once at start-up.
pub struct Wiring {
    /// The feed a statement reads.
    pub collect: Box<dyn Collect>,
    /// `index.ts`'s `statementJobs`.
    pub jobs: jobs::Config,
}

impl Wiring {
    /// Nothing wired: background exports are off.
    pub fn none() -> Wiring {
        Wiring {
            collect: Box::new(Feed),
            jobs: jobs::Config::default(),
        }
    }
}

/// This part's wiring from the environment (`index.ts`'s `statementJobs`): the lease only while the interval is set too,
/// and the TEST render hold refused outside an explicit dev or test process.
pub fn wiring(b: &super::Build<'_>) -> Result<Wiring, String> {
    let interval = jobs::parse_interval(b.raw("BANK_STATEMENT_JOBS_INTERVAL_MS"))?;
    let lease = jobs::parse_lease(b.raw("BANK_STATEMENT_JOBS_LEASE_MS"))?;
    let hold = jobs::parse_test_hold(
        b.raw("BANK_STATEMENT_JOBS_TEST_RENDER_HOLD_MS"),
        b.raw("APP_ENV"),
        b.raw("NODE_ENV"),
    )?;
    Ok(Wiring {
        collect: Box::new(Feed),
        jobs: jobs::Config {
            lease_ms: interval.and(lease),
            test_render_hold_ms: hold,
        },
    })
}

/// A `BankError` of a code `errors.ts` declares.
pub(crate) fn bank(code: &str, message: &str) -> Refusal {
    BankError::new(code, message).map_or_else(
        || Refusal::Other(format!("{message} ({code})")),
        Refusal::Bank,
    )
}

/// `bank-procedure.ts`'s `STATUS`: the tRPC code of each `BankError` it names; any other is `BAD_REQUEST`.
fn procedure_status(code: &str) -> &'static str {
    match code {
        "bank.transfer_message_conflict"
        | "bank.activity_note_conflict"
        | "bank.activity_dispute_conflict"
        | "bank.activity_dispute_exists"
        | "bank.activity_filter_conflict" => "CONFLICT",
        "bank.activity_not_found" | "bank.statement_job_not_found" => "NOT_FOUND",
        "bank.activity_lookup_bounded"
        | "portfolio.entries_do_not_sum"
        | "bank.statement_pdf_one_month"
        | "bank.statement_too_large"
        | "bank.statement_balances_unavailable"
        | "bank.statement_job_not_ready"
        | "rail.bank"
        | "vendor.tax" => "PRECONDITION_FAILED",
        "bank.statement_unavailable" | "bank.statement_jobs_unset" => "SERVICE_UNAVAILABLE",
        _ => "BAD_REQUEST",
    }
}

/// `throwBankProcedure`: a `TRPCError` as it is; a `BankError` with its status and `<message> (<code>)`; anything else
/// thrown on, which tRPC answers as its own 500 carrying the error's message.
pub fn procedure_error(r: Refusal) -> TrpcError {
    match r {
        Refusal::Trpc(e) => e,
        Refusal::Bank(e) => TrpcError::caused(
            procedure_status(e.row.code),
            format!("{} ({})", e.message, e.row.code),
            e.row.code,
        ),
        Refusal::Other(m) => TrpcError::plain("INTERNAL_SERVER_ERROR", m),
    }
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).as_str().unwrap_or_default().to_owned()
}

fn opt_text(v: &Value, key: &str) -> Option<String> {
    v.get(key).as_str().map(str::to_owned)
}

/// The request of `export` and `jobs.create` (`requestInput`).
fn request_of(v: &Value) -> service::Request {
    service::Request {
        from: text(v, "from"),
        to: text(v, "to"),
        asset_id: opt_text(v, "assetId"),
        space_id: opt_text(v, "spaceId"),
        format: text(v, "format"),
        report: opt_text(v, "report"),
    }
}

/// This part's answer to one of its calls.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    let user = super::user_of(ctx);
    let input = &ctx.input;
    let out: Result<Json, Refusal> = match ctx.call.path {
        "statements.export" => {
            service::export(d, user, &request_of(input), d.now).map(|f| f.to_json())
        }
        "statements.totals" => {
            let asset = opt_text(input, "assetId");
            service::totals(
                d,
                user,
                &text(input, "from"),
                &text(input, "to"),
                asset.as_deref(),
            )
            .map(|(totals, lines)| {
                Json::obj([
                    ("totals", service::totals_json(&totals)),
                    ("lines", Json::int(i64::try_from(lines).unwrap_or(i64::MAX))),
                ])
            })
        }
        "statements.letters.request" => Err(bank(
            "rail.bank",
            "A bank letter is issued with a banking partner, and none is connected in this build",
        )),
        "statements.tax.list" => Err(bank(
            "vendor.tax",
            "Tax statements are produced by a tax calculation provider, and none is connected in this build",
        )),
        "statements.jobs.create" => {
            jobs::create(d, user, &request_of(input), d.now).map(|j| j.to_json())
        }
        "statements.jobs.list" => jobs::list(d, user).map(|items| {
            Json::obj([
                ("enabled", Json::Bool(jobs::enabled(d))),
                (
                    "items",
                    Json::Array(items.iter().map(jobs::Job::to_json).collect()),
                ),
            ])
        }),
        "statements.jobs.download" => {
            jobs::download(d, user, &text(input, "id")).map(|f| f.to_json())
        }
        _ => return None,
    };
    Some(out.map_err(procedure_error))
}

/// One pass of the statement export worker (`startStatementJobWorker`'s tick): queued jobs made one at a time, at most
/// [`jobs::BATCH`]. Nothing while background exports are off. A failed pass is the error the binary logs.
pub fn run_statement_jobs(door: &BankDoor, now: Instant) -> Result<(), String> {
    door.activity_deps(now, |d| {
        jobs::tick(d).map_err(|r| match r {
            Refusal::Bank(e) => format!("{} ({})", e.message, e.row.code),
            Refusal::Trpc(e) => e.message,
            Refusal::Other(m) => m,
        })
    })
}
