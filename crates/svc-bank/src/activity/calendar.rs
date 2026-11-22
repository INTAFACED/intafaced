//! Part `calendar` of the activity slice: the money calendar (`calendar/calendar.ts`, `calendar.router.ts`,
//! `compose.ts`; BK-acct-10, J-bank-06 #5), `calendar.window`.
//!
//! One read of what is dated in a window, merged from svc-bank's own sources. Standing orders and recurring bills give
//! each occurrence from their own schedule arithmetic, with a run that already happened shown as it ended; direct debits
//! give each collection by its due date; fixed-term earn positions give their maturity. A loan has no repayment schedule
//! (none is published), so loans contribute nothing and say so. Read only: the calendar posts nothing and writes
//! nothing. Each source is read on its own, so a source that fails names itself and the others still show.
//!
//! Standing orders (`transfers`), earn and loans are ported slices and are read through their own functions. Bills and
//! direct debits are not ported: their reads are the SQL `BillPayService.listRecurring` and `DirectDebitService.dated`
//! run, on svc-bank's own tables. `index.ts` never hands the bills area a bill partner, so the bill rail is always
//! `unset` there; [`Wiring::bill_rail_live`] holds that.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, civil_from_days, js_date};
use service_kit::trpc::TrpcError;

use super::{Deps, user_of};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::partner::refuse;
use crate::spaces::space::{at as time_param, pg, with};
use crate::transfers::calendar::{Cadence, occurrence_start};
use crate::transfers::schedules::{self, Schedule};

/// `CALENDAR_SOURCES`, in the order the answer lists them.
pub const SOURCES: [&str; 5] = ["standing_orders", "bills", "direct_debits", "loans", "earn"];

/// `LOAN_SCHEDULE_UNSET`: no loan product publishes repayment dates, so a loan has none to show.
pub const LOAN_SCHEDULE_UNSET: &str = "bank.loan_schedule_unset";
/// `CALENDAR_SOURCE_UNAVAILABLE`: a source failed for a reason that is not a refusal. Its error is logged, never shown.
pub const SOURCE_UNAVAILABLE: &str = "bank.calendar_source_unavailable";
/// `CALENDAR_MAX_DAYS`: the widest window one read may ask for.
pub const MAX_DAYS: i64 = 62;

const DAY_MS: i64 = 86_400_000;
const OPEN_LOANS: [&str; 3] = ["active", "margin_call", "liquidating"];

/// What the door holds for this part, built once at start-up.
#[derive(Default)]
pub struct Wiring {
    /// `bills.railStatus() === 'live'`: whether a bill partner is wired. `index.ts` passes the bills area no ports, so
    /// it is `emptyBillPorts()` and never live.
    pub bill_rail_live: bool,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

/// This part's wiring from the environment: nothing of it is read from the environment (`compose.ts`).
pub fn wiring(_b: &super::Build<'_>) -> Result<Wiring, String> {
    Ok(Wiring::none())
}

// ---------------------------------------------------------------------------------------------------------------
// The records each source gives.

/// A recurring bill as `listRecurring` gives it (`RecurringView`), the fields the calendar reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecurringBill {
    pub id: String,
    pub reference: String,
    /// The amount as stored: `bill_recurring.amount` is text the table holds to `^[0-9]+(\.[0-9]{1,18})?$`.
    pub amount: String,
    pub asset_id: String,
    pub cadence: Cadence,
    /// `active`, `paused`, `cancelled` or `completed`.
    pub status: String,
    pub starts_at: Instant,
    pub ends_at: Option<Instant>,
    pub next_run_at: Instant,
}

/// One direct debit collection as `dated` gives it (`CollectionView`), the fields the calendar reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    pub id: String,
    pub mandate_id: String,
    pub creditor_name: String,
    pub asset_id: String,
    pub amount: Amount,
    pub due_at: Instant,
    /// `upcoming`, `processing`, `collected`, `failed` or `rejected`.
    pub status: String,
    pub failure_code: Option<String>,
}

/// One earn position as `positionsOf` gives it, the fields the calendar reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Position {
    pub id: String,
    pub asset_id: String,
    pub principal: Amount,
    pub matures_at: Option<Instant>,
    pub status: String,
}

/// One run of a standing order's occurrence (`bank.transfer_executions`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub schedule_id: String,
    pub occurrence: i64,
    pub status: String,
    pub rejection_code: Option<String>,
    pub amount: String,
}

/// The reads the calendar merges (`CalendarDeps`): the door's own in [`DoorSources`], a stand-in in a test.
pub trait Sources {
    /// `transfers.listSchedules(userId, limit)`.
    fn schedules(&self, user_id: &str, limit: i64) -> Result<Vec<Schedule>, Refusal>;
    /// The runs of these (schedule, occurrence) pairs.
    fn runs(&self, wanted: &[(String, i64)]) -> Result<Vec<Run>, Refusal>;
    /// `bills.listRecurring({ userId, limit })`.
    fn recurring_bills(&self, user_id: &str, limit: i64) -> Result<Vec<RecurringBill>, Refusal>;
    /// `bills.railStatus() === 'live'`.
    fn bill_rail_live(&self) -> bool;
    /// `directDebits.dated({ userId, from, to, limit, now })`.
    fn collections(
        &self,
        user_id: &str,
        from: Instant,
        to: Instant,
        limit: i64,
    ) -> Result<Vec<Collection>, Refusal>;
    /// `loans.loansOf(userId, limit)`: each loan's status.
    fn loan_statuses(&self, user_id: &str, limit: i64) -> Result<Vec<String>, Refusal>;
    /// `earn.positionsOf(userId, limit)`.
    fn positions(&self, user_id: &str, limit: i64) -> Result<Vec<Position>, Refusal>;
}

// ---------------------------------------------------------------------------------------------------------------
// The view.

/// `CalendarItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub source: &'static str,
    pub ref_id: String,
    pub key: String,
    pub date: Instant,
    pub label: Option<String>,
    pub asset_id: String,
    pub amount: Option<String>,
    pub status: &'static str,
    pub reason_code: Option<String>,
}

impl Item {
    fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::String);
        Json::obj([
            ("source", Json::str(self.source)),
            ("refId", Json::str(self.ref_id.clone())),
            ("key", Json::str(self.key.clone())),
            ("date", Json::str(self.date.iso())),
            ("label", opt(&self.label)),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", opt(&self.amount)),
            ("status", Json::str(self.status)),
            ("reasonCode", opt(&self.reason_code)),
        ])
    }
}

/// `CalendarSourceReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub source: &'static str,
    /// `ok`, `not_set`, `refused` or `unavailable`.
    pub state: &'static str,
    pub count: i64,
    pub code: Option<String>,
    pub complete: bool,
}

impl Report {
    fn json(&self) -> Json {
        Json::obj([
            ("source", Json::str(self.source)),
            ("state", Json::str(self.state)),
            ("count", Json::int(self.count)),
            ("code", self.code.clone().map_or(Json::Null, Json::String)),
            ("complete", Json::Bool(self.complete)),
        ])
    }
}

/// `CalendarView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub from: Instant,
    pub to: Instant,
    pub items: Vec<Item>,
    pub sources: Vec<Report>,
}

impl View {
    pub fn json(&self) -> Json {
        Json::obj([
            ("from", Json::str(self.from.iso())),
            ("to", Json::str(self.to.iso())),
            (
                "items",
                Json::Array(self.items.iter().map(Item::json).collect()),
            ),
            (
                "sources",
                Json::Array(self.sources.iter().map(Report::json).collect()),
            ),
        ])
    }
}

/// `SourceResult`.
struct Answer {
    items: Vec<Item>,
    full: bool,
    state: &'static str,
    count: Option<i64>,
    code: Option<String>,
}

impl Answer {
    fn ok(items: Vec<Item>, full: bool) -> Answer {
        Answer {
            items,
            full,
            state: "ok",
            count: None,
            code: None,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The schedule arithmetic.

fn utc_year_month(at: Instant) -> (i64, i64) {
    let (y, m, _) = civil_from_days(at.0.div_euclid(DAY_MS));
    (y, m)
}

/// `firstIndex`: the first occurrence index whose date can fall on or after `from`; a little early is fine, the loop
/// skips it.
fn first_index(starts_at: Instant, cadence: Cadence, from: Instant) -> i64 {
    let gap = from.0 - starts_at.0;
    if gap <= 0 {
        return 0;
    }
    match cadence {
        Cadence::Once => 0,
        Cadence::Daily => (gap.div_euclid(DAY_MS) - 1).max(0),
        Cadence::Weekly => (gap.div_euclid(7 * DAY_MS) - 1).max(0),
        Cadence::Monthly => {
            let (fy, fm) = utc_year_month(from);
            let (sy, sm) = utc_year_month(starts_at);
            ((fy - sy) * 12 + (fm - sm) - 1).max(0)
        }
    }
}

/// `occurrencesIn`: each occurrence of a schedule dated inside `[from, to)` and before its end (the runner's end is
/// exclusive), with its index.
pub fn occurrences_in(
    starts_at: Instant,
    cadence: Cadence,
    ends_at: Option<Instant>,
    from: Instant,
    to: Instant,
) -> Vec<(i64, Instant)> {
    let mut out = Vec::new();
    let last = if cadence == Cadence::Once {
        0
    } else {
        i64::MAX
    };
    // The window is at most MAX_DAYS, so a daily schedule gives at most that many and the bound never bites.
    let mut n = first_index(starts_at, cadence, from);
    let mut seen = 0;
    while n <= last && seen < 4 * MAX_DAYS {
        let Some(at) = occurrence_start(starts_at, cadence, n) else {
            break;
        };
        if at.0 >= to.0 {
            break;
        }
        if ends_at.is_some_and(|e| at.0 >= e.0) {
            break;
        }
        if at.0 >= from.0 {
            out.push((n, at));
        }
        n += 1;
        seen += 1;
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// The merge.

/// `refusalCode`: a domain refusal's code, or none for anything else.
fn refusal_code(r: &Refusal) -> Option<String> {
    match r {
        Refusal::Bank(e) => Some(e.row.code.to_owned()),
        Refusal::Trpc(_) | Refusal::Other(_) => None,
    }
}

fn refusal_words(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.message.clone(),
        Refusal::Trpc(e) => e.message.clone(),
        Refusal::Other(m) => m.clone(),
    }
}

/// The one window a read asks for.
pub struct Ask<'a> {
    pub user_id: &'a str,
    /// The first day at UTC midnight; `None` for a date that is not one (`new Date('nope')`).
    pub from: Option<Instant>,
    pub days: f64,
    pub limit: i64,
    pub now: Instant,
    /// The source the person's TEST switch fails (`calendarSource`, J-bank-06 #8), if any.
    pub failing: Option<&'a str>,
}

/// `CalendarService.window`: what is dated in `[from, from + days)` for this person, soonest first, and how each
/// source answered. `log` hears each source that failed for a reason that is not a refusal.
pub fn window(
    src: &dyn Sources,
    ask: &Ask<'_>,
    log: &mut dyn FnMut(&str, &str),
) -> Result<View, Refusal> {
    #[allow(
        clippy::float_cmp,
        reason = "an exact integer test of the input, as Number.isInteger"
    )]
    let whole = ask.days.is_finite() && ask.days.trunc() == ask.days;
    let days_ok = whole && ask.days >= 1.0 && ask.days <= 62.0;
    let Some(from) = ask.from.filter(|_| days_ok) else {
        return Err(refuse(
            "bank.calendar_window_invalid",
            format!("A calendar window is 1 to {MAX_DAYS} days from a valid date"),
        ));
    };
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number from 1 to 62, checked above"
    )]
    let days = ask.days as i64;
    let to = Instant(from.0 + days * DAY_MS);
    let mut items = Vec::new();
    let mut sources = Vec::new();
    for source in SOURCES {
        let read = if ask.failing == Some(source) {
            Err(Refusal::Other(format!(
                "TEST switch: the {source} source is failing for this person"
            )))
        } else {
            match source {
                "standing_orders" => {
                    standing_orders(src, ask.user_id, from, to, ask.limit, ask.now)
                }
                "bills" => bills(src, ask.user_id, from, to, ask.limit, ask.now),
                "direct_debits" => direct_debits(src, ask.user_id, from, to, ask.limit),
                "loans" => loans(src, ask.user_id, ask.limit),
                _ => earn(src, ask.user_id, from, to, ask.limit),
            }
        };
        match read {
            Ok(a) => {
                let count = a.count.unwrap_or_else(|| len(&a.items));
                items.extend(a.items);
                sources.push(Report {
                    source,
                    state: a.state,
                    count,
                    code: a.code,
                    complete: !a.full,
                });
            }
            Err(e) => {
                let code = refusal_code(&e);
                if code.is_none() {
                    log(source, &refusal_words(&e));
                }
                sources.push(Report {
                    source,
                    state: if code.is_some() {
                        "refused"
                    } else {
                        "unavailable"
                    },
                    count: 0,
                    code: Some(code.unwrap_or_else(|| SOURCE_UNAVAILABLE.to_owned())),
                    complete: false,
                });
            }
        }
    }
    // `localeCompare` on the date, the source and the key. Every date is `toISOString` text of one length, the sources
    // differ in their first letter, and the keys are lower-case uuids with `:<n>` after them, so the collation's order
    // and the bytes' agree on every value the calendar makes.
    items.sort_by(|a, b| {
        a.date
            .iso()
            .cmp(&b.date.iso())
            .then_with(|| a.source.cmp(b.source))
            .then_with(|| a.key.cmp(&b.key))
    });
    Ok(View {
        from,
        to,
        items,
        sources,
    })
}

fn len<T>(v: &[T]) -> i64 {
    i64::try_from(v.len()).unwrap_or(i64::MAX)
}

fn full<T>(v: &[T], limit: i64) -> bool {
    len(v) >= limit
}

fn standing_orders(
    src: &dyn Sources,
    user_id: &str,
    from: Instant,
    to: Instant,
    limit: i64,
    now: Instant,
) -> Result<Answer, Refusal> {
    let list = src.schedules(user_id, limit)?;
    let is_full = full(&list, limit);
    let dated: Vec<(&Schedule, i64, Instant)> = list
        .iter()
        .flat_map(|s| {
            occurrences_in(s.starts_at, s.cadence, s.ends_at, from, to)
                .into_iter()
                .map(move |(n, at)| (s, n, at))
        })
        .collect();
    if dated.is_empty() {
        return Ok(Answer::ok(Vec::new(), is_full));
    }
    let wanted: Vec<(String, i64)> = dated.iter().map(|(s, n, _)| (s.id.clone(), *n)).collect();
    let runs = src.runs(&wanted)?;
    let mut items = Vec::new();
    for (s, n, at) in dated {
        // The last run of a pair wins, as `new Map(...)` keeps the last value of a repeated key.
        let run = runs
            .iter()
            .rev()
            .find(|r| r.schedule_id == s.id && r.occurrence == n);
        let status = if let Some(r) = run {
            match r.status.as_str() {
                "settled" => "done",
                "rejected" => "failed",
                "skipped" => "skipped",
                _ => "upcoming",
            }
        } else if s.status == "active" && at.0 >= s.next_run_at.0 {
            // Due, or overdue and waiting for the runner to catch up. A date before the next run with no run of its own
            // never ran and never will, so it is left out rather than shown as due.
            "upcoming"
        } else if s.status == "paused" && at.0 >= now.0 {
            "paused"
        } else {
            continue; // cancelled, completed or a paused past date: nothing will run and nothing ran
        };
        // A run shows what it booked; the schedule's amount may have changed since.
        let amount = match run {
            Some(r) => format_amount(parse_amount(&r.amount).map_err(Refusal::Other)?),
            None => format_amount(s.amount),
        };
        items.push(Item {
            source: "standing_orders",
            ref_id: s.id.clone(),
            key: format!("{}:{n}", s.id),
            date: at,
            label: None,
            asset_id: s.asset_id.clone(),
            amount: Some(amount),
            status,
            reason_code: run.and_then(|r| r.rejection_code.clone()),
        });
    }
    Ok(Answer::ok(items, is_full))
}

fn bills(
    src: &dyn Sources,
    user_id: &str,
    from: Instant,
    to: Instant,
    limit: i64,
    now: Instant,
) -> Result<Answer, Refusal> {
    let recurring = src.recurring_bills(user_id, limit)?;
    let mut items = Vec::new();
    for r in &recurring {
        if r.status != "active" && r.status != "paused" {
            continue;
        }
        for (n, at) in occurrences_in(r.starts_at, r.cadence, r.ends_at, from, to) {
            // A bill's past runs are its payments, read in its own room; the calendar shows what is still to come. A
            // paused bill's past dates will never run, so like a paused standing order it shows only its future ones.
            if at.0 < r.next_run_at.0 {
                continue;
            }
            if r.status == "paused" && at.0 < now.0 {
                continue;
            }
            items.push(Item {
                source: "bills",
                ref_id: r.id.clone(),
                key: format!("{}:{n}", r.id),
                date: at,
                label: Some(r.reference.clone()),
                asset_id: r.asset_id.clone(),
                amount: Some(r.amount.clone()),
                status: if r.status == "active" {
                    "upcoming"
                } else {
                    "paused"
                },
                reason_code: None,
            });
        }
    }
    // With no bill partner a recurring bill cannot be set up, so an empty source says why rather than looking idle.
    let mut a = Answer::ok(items, full(&recurring, limit));
    if !src.bill_rail_live() {
        a.code = Some("bank.bills_psp_unset".to_owned());
    }
    Ok(a)
}

fn direct_debits(
    src: &dyn Sources,
    user_id: &str,
    from: Instant,
    to: Instant,
    limit: i64,
) -> Result<Answer, Refusal> {
    let rows = src.collections(user_id, from, to, limit)?;
    let is_full = full(&rows, limit);
    let items = rows
        .into_iter()
        .map(|c| Item {
            source: "direct_debits",
            ref_id: c.mandate_id,
            key: c.id,
            date: c.due_at,
            label: Some(c.creditor_name),
            asset_id: c.asset_id,
            amount: Some(format_amount(c.amount)),
            status: match c.status.as_str() {
                "collected" => "done",
                "failed" => "failed",
                "rejected" => "refused",
                _ => "upcoming",
            },
            reason_code: c.failure_code,
        })
        .collect();
    Ok(Answer::ok(items, is_full))
}

fn loans(src: &dyn Sources, user_id: &str, limit: i64) -> Result<Answer, Refusal> {
    let statuses = src.loan_statuses(user_id, limit)?;
    let open = statuses
        .iter()
        .filter(|s| OPEN_LOANS.contains(&s.as_str()))
        .count();
    Ok(Answer {
        items: Vec::new(),
        full: full(&statuses, limit),
        state: "not_set",
        count: Some(i64::try_from(open).unwrap_or(i64::MAX)),
        code: Some(LOAN_SCHEDULE_UNSET.to_owned()),
    })
}

fn earn(
    src: &dyn Sources,
    user_id: &str,
    from: Instant,
    to: Instant,
    limit: i64,
) -> Result<Answer, Refusal> {
    let positions = src.positions(user_id, limit)?;
    let mut items = Vec::new();
    for p in &positions {
        let Some(at) = p.matures_at.filter(|_| p.status == "active") else {
            continue;
        };
        if at.0 < from.0 || at.0 >= to.0 {
            continue;
        }
        items.push(Item {
            source: "earn",
            ref_id: p.id.clone(),
            key: p.id.clone(),
            date: at,
            label: None,
            asset_id: p.asset_id.clone(),
            amount: Some(format_amount(p.principal)),
            // An active position past its date has matured but its money has not been paid back: it is due, not done.
            status: "upcoming",
            reason_code: None,
        });
    }
    Ok(Answer::ok(items, full(&positions, limit)))
}

// ---------------------------------------------------------------------------------------------------------------
// The door's sources.

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

#[allow(
    clippy::cast_precision_loss,
    reason = "a page size of at most 200, as the router checked"
)]
fn as_page(limit: i64) -> f64 {
    limit as f64
}

/// The sources as the door reads them: the ported slices through their own functions, bills and direct debits with
/// the TypeScript services' own SQL.
pub struct DoorSources<'a> {
    pub d: &'a Deps<'a>,
}

impl Sources for DoorSources<'_> {
    fn schedules(&self, user_id: &str, limit: i64) -> Result<Vec<Schedule>, Refusal> {
        self.d.door.transfers_deps(|t| {
            schedules::list(t, user_id, Some(as_page(limit)), None)
                .map(|rows| rows.into_iter().map(|(s, _)| s).collect())
        })
    }

    fn runs(&self, wanted: &[(String, i64)]) -> Result<Vec<Run>, Refusal> {
        let ids: Vec<&str> = wanted.iter().map(|(id, _)| id.as_str()).collect();
        let ns = wanted
            .iter()
            .map(|(_, n)| i32::try_from(*n).map_err(|e| Refusal::Other(e.to_string())))
            .collect::<Result<Vec<i32>, Refusal>>()?;
        with(self.d.store(), |c| {
            c.query(
                "SELECT e.schedule_id::text, e.occurrence, e.status::text, e.rejection_code, e.amount::text AS amount \
                   FROM bank.transfer_executions e \
                   JOIN unnest($1::text[]::uuid[], $2::int[]) AS w(schedule_id, occurrence) \
                     ON w.schedule_id = e.schedule_id AND w.occurrence = e.occurrence",
                &[&ids, &ns],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| {
                Ok(Run {
                    schedule_id: r.try_get(0).map_err(|e| pg(&e))?,
                    occurrence: i64::from(r.try_get::<_, i32>(1).map_err(|e| pg(&e))?),
                    status: r.try_get(2).map_err(|e| pg(&e))?,
                    rejection_code: r.try_get(3).map_err(|e| pg(&e))?,
                    amount: r.try_get(4).map_err(|e| pg(&e))?,
                })
            })
            .collect()
        })
    }

    fn recurring_bills(&self, user_id: &str, limit: i64) -> Result<Vec<RecurringBill>, Refusal> {
        with(self.d.store(), |c| {
            c.query(
                &format!(
                    "SELECT id::text, reference, amount, asset_id, cadence, status, {}, {}, {} \
                       FROM bank.bill_recurring \
                      WHERE user_id = $1 \
                      ORDER BY created_at DESC, id DESC \
                      LIMIT $2",
                    ms("starts_at"),
                    ms("ends_at"),
                    ms("next_run_at")
                ),
                &[&user_id, &limit],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| {
                let cadence: String = r.try_get(4).map_err(|e| pg(&e))?;
                Ok(RecurringBill {
                    id: r.try_get(0).map_err(|e| pg(&e))?,
                    reference: r.try_get(1).map_err(|e| pg(&e))?,
                    amount: r.try_get(2).map_err(|e| pg(&e))?,
                    asset_id: r.try_get(3).map_err(|e| pg(&e))?,
                    cadence: Cadence::parse(&cadence)
                        .ok_or_else(|| Refusal::Other(format!("cadence {cadence}")))?,
                    status: r.try_get(5).map_err(|e| pg(&e))?,
                    starts_at: Instant(r.try_get(6).map_err(|e| pg(&e))?),
                    ends_at: r
                        .try_get::<_, Option<i64>>(7)
                        .map_err(|e| pg(&e))?
                        .map(Instant),
                    next_run_at: Instant(r.try_get(8).map_err(|e| pg(&e))?),
                })
            })
            .collect()
        })
    }

    fn bill_rail_live(&self) -> bool {
        self.d.w.calendar.bill_rail_live
    }

    fn collections(
        &self,
        user_id: &str,
        from: Instant,
        to: Instant,
        limit: i64,
    ) -> Result<Vec<Collection>, Refusal> {
        // `collections(sql, { userId, due: { from, to, limit } })`, the columns the calendar reads.
        with(self.d.store(), |c| {
            c.query(
                &format!(
                    "SELECT c.id::text, c.mandate_id, m.creditor_name, c.asset_id, c.amount::text AS amount, {}, \
                            c.status, c.failure_code \
                       FROM bank.dd_collections c \
                       JOIN bank.dd_mandates m ON m.id = c.mandate_id \
                       LEFT JOIN bank.dd_refund_requests r ON r.collection_row_id = c.id \
                      WHERE c.user_id = $1::text::uuid \
                        AND c.due_at >= {} AND c.due_at < {} \
                      ORDER BY c.due_at ASC, c.id ASC \
                      LIMIT $4",
                    ms("c.due_at"),
                    time_param("$2"),
                    time_param("$3")
                ),
                &[&user_id, &from.0, &to.0, &limit],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| {
                let amount: String = r.try_get(4).map_err(|e| pg(&e))?;
                Ok(Collection {
                    id: r.try_get(0).map_err(|e| pg(&e))?,
                    mandate_id: r.try_get(1).map_err(|e| pg(&e))?,
                    creditor_name: r.try_get(2).map_err(|e| pg(&e))?,
                    asset_id: r.try_get(3).map_err(|e| pg(&e))?,
                    amount: parse_amount(&amount).map_err(Refusal::Other)?,
                    due_at: Instant(r.try_get(5).map_err(|e| pg(&e))?),
                    status: r.try_get(6).map_err(|e| pg(&e))?,
                    failure_code: r.try_get(7).map_err(|e| pg(&e))?,
                })
            })
            .collect()
        })
    }

    fn loan_statuses(&self, user_id: &str, limit: i64) -> Result<Vec<String>, Refusal> {
        self.d.door.loans_deps(self.d.now, |l| {
            crate::loans::service::loans_of(l, user_id, Some(as_page(limit)))
                .map(|ls| ls.into_iter().map(|l| l.status).collect())
        })
    }

    fn positions(&self, user_id: &str, limit: i64) -> Result<Vec<Position>, Refusal> {
        let rows = with(self.d.store(), |c| {
            crate::earn::service::positions_of(c, user_id, Some(as_page(limit)))
        })?;
        Ok(rows
            .into_iter()
            .map(|p| Position {
                id: p.id,
                asset_id: p.asset_id,
                principal: p.principal,
                matures_at: p.matures_at,
                status: p.status,
            })
            .collect())
    }
}

/// `compose.ts`'s `log`: one line on stderr for a source that failed for a reason that is not a refusal.
fn log_failed(source: &str, error: &str) {
    eprintln!(
        "{}",
        Json::obj([
            ("level", Json::str("error")),
            ("service", Json::str("svc-bank")),
            ("event", Json::str("bank.calendar_source_failed")),
            ("source", Json::str(source)),
            ("error", Json::str(error)),
        ])
        .compact()
    );
}

/// This part's answer to one of its calls (`calendar.router.ts`), inside the main router's guard.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    if ctx.call.path != "calendar.window" {
        return None;
    }
    let user = user_of(ctx);
    let input = &ctx.input;
    let from = input
        .get("from")
        .as_str()
        .and_then(|day| js_date(&format!("{day}T00:00:00.000Z")));
    let days = input.get("days").as_number().unwrap_or(f64::NAN);
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number from 1 to 200, as the router's input checked"
    )]
    let limit = input.get("limit").as_number().unwrap_or(0.0) as i64;
    let partner = d.door.partner().partner.as_ref();
    let failing = partner.and_then(|p| p.switches(user).calendar_source);
    let out = window(
        &DoorSources { d },
        &Ask {
            user_id: user,
            from,
            days,
            limit,
            now: d.now,
            failing: failing.as_deref(),
        },
        &mut log_failed,
    );
    Some(out.map(|v| v.json()).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::too_many_lines,
        reason = "a test"
    )]
    //! `calendar.test.ts`: the merge, with each source faked.

    use std::cell::Cell;

    use super::*;

    const DAY: i64 = DAY_MS;
    const USER: &str = "51111111-1111-4111-8111-111111111111";

    fn t(iso: &str) -> Instant {
        js_date(iso).unwrap()
    }
    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }
    fn from() -> Instant {
        t("2026-11-01T00:00:00.000Z")
    }
    fn now() -> Instant {
        t("2026-11-10T09:00:00.000Z")
    }

    #[derive(Default)]
    struct Fake {
        schedules: Option<Result<Vec<Schedule>, Refusal>>,
        bills: Option<Result<Vec<RecurringBill>, Refusal>>,
        rail_live: bool,
        collections: Option<Result<Vec<Collection>, Refusal>>,
        collections_read: Cell<usize>,
        loans: Option<Result<Vec<String>, Refusal>>,
        positions: Option<Result<Vec<Position>, Refusal>>,
    }

    fn take<T: Clone>(v: &Option<Result<Vec<T>, Refusal>>) -> Result<Vec<T>, Refusal> {
        v.clone().unwrap_or_else(|| Ok(Vec::new()))
    }

    impl Sources for Fake {
        fn schedules(&self, _: &str, _: i64) -> Result<Vec<Schedule>, Refusal> {
            take(&self.schedules)
        }
        fn runs(&self, _: &[(String, i64)]) -> Result<Vec<Run>, Refusal> {
            Ok(Vec::new())
        }
        fn recurring_bills(&self, _: &str, _: i64) -> Result<Vec<RecurringBill>, Refusal> {
            take(&self.bills)
        }
        fn bill_rail_live(&self) -> bool {
            self.rail_live
        }
        fn collections(
            &self,
            _: &str,
            _: Instant,
            _: Instant,
            _: i64,
        ) -> Result<Vec<Collection>, Refusal> {
            self.collections_read.set(self.collections_read.get() + 1);
            take(&self.collections)
        }
        fn loan_statuses(&self, _: &str, _: i64) -> Result<Vec<String>, Refusal> {
            take(&self.loans)
        }
        fn positions(&self, _: &str, _: i64) -> Result<Vec<Position>, Refusal> {
            take(&self.positions)
        }
    }

    fn live() -> Fake {
        Fake {
            rail_live: true,
            ..Fake::default()
        }
    }

    fn run(
        f: &Fake,
        user: &str,
        days: f64,
        limit: i64,
        failing: Option<&str>,
        log: &mut Vec<(String, String)>,
    ) -> Result<View, Refusal> {
        window(
            f,
            &Ask {
                user_id: user,
                from: Some(from()),
                days,
                limit,
                now: now(),
                failing,
            },
            &mut |s, e| log.push((s.to_owned(), e.to_owned())),
        )
    }

    fn view(f: &Fake, days: f64) -> View {
        run(f, USER, days, 50, None, &mut Vec::new()).unwrap()
    }

    fn schedule(id: &str, cadence: Cadence, starts: &str, next: &str, amount: &str) -> Schedule {
        Schedule {
            id: id.to_owned(),
            user_id: USER.to_owned(),
            asset_id: "USDT".to_owned(),
            from_space_id: "a".to_owned(),
            to_space_id: "b".to_owned(),
            amount: amt(amount),
            cadence,
            starts_at: t(starts),
            ends_at: None,
            next_run_at: t(next),
            status: "active".to_owned(),
            revision: 1,
        }
    }

    fn position(id: &str, principal: &str, matures: Option<&str>) -> Position {
        Position {
            id: id.to_owned(),
            asset_id: "USDT".to_owned(),
            principal: amt(principal),
            matures_at: matures.map(t),
            status: "active".to_owned(),
        }
    }

    fn collection(due: &str, status: &str, failure: Option<&str>) -> Collection {
        Collection {
            id: "C-row".to_owned(),
            mandate_id: "MD-1".to_owned(),
            creditor_name: "TEST Gym".to_owned(),
            asset_id: "USDT".to_owned(),
            amount: amt("5"),
            due_at: t(due),
            status: status.to_owned(),
            failure_code: failure.map(str::to_owned),
        }
    }

    fn report(
        source: &'static str,
        state: &'static str,
        count: i64,
        code: Option<&str>,
        complete: bool,
    ) -> Report {
        Report {
            source,
            state,
            count,
            code: code.map(str::to_owned),
            complete,
        }
    }

    fn day(i: &Item) -> String {
        i.date.iso().get(..10).unwrap().to_owned()
    }

    fn isos(v: &[(i64, Instant)]) -> Vec<String> {
        v.iter().map(|(_, at)| at.iso()).collect()
    }

    // describe('occurrences in a window')

    #[test]
    fn keeps_a_monthly_order_on_the_31st_through_short_months_and_stops_at_the_end_date() {
        let starts = t("2026-01-31T08:00:00.000Z");
        let (a, b) = (t("2026-02-01T00:00:00.000Z"), t("2026-04-01T00:00:00.000Z"));
        let got = occurrences_in(starts, Cadence::Monthly, None, a, b);
        assert_eq!(
            isos(&got),
            ["2026-02-28T08:00:00.000Z", "2026-03-31T08:00:00.000Z"]
        );
        assert_eq!(got.iter().map(|o| o.0).collect::<Vec<_>>(), [1, 2]);
        let ended = occurrences_in(
            starts,
            Cadence::Monthly,
            Some(t("2026-03-01T00:00:00.000Z")),
            a,
            b,
        );
        assert_eq!(ended.iter().map(|o| o.0).collect::<Vec<_>>(), [1]);
    }

    #[test]
    fn gives_every_day_of_a_daily_order_once_a_one_off_only_on_its_date_and_nothing_before_the_start()
     {
        let daily = occurrences_in(
            t("2025-01-01T06:00:00.000Z"),
            Cadence::Daily,
            None,
            from(),
            Instant(from().0 + 3 * DAY),
        );
        assert_eq!(
            isos(&daily),
            [
                "2026-11-01T06:00:00.000Z",
                "2026-11-02T06:00:00.000Z",
                "2026-11-03T06:00:00.000Z"
            ]
        );
        let once = t("2026-11-05T09:00:00.000Z");
        let got = occurrences_in(
            once,
            Cadence::Once,
            None,
            from(),
            Instant(from().0 + 30 * DAY),
        );
        assert_eq!(got.iter().map(|o| o.0).collect::<Vec<_>>(), [0]);
        assert!(
            occurrences_in(
                once,
                Cadence::Once,
                None,
                t("2026-11-06T00:00:00.000Z"),
                t("2026-12-06T00:00:00.000Z")
            )
            .is_empty()
        );
        assert!(
            occurrences_in(
                t("2027-01-01T00:00:00.000Z"),
                Cadence::Weekly,
                None,
                from(),
                Instant(from().0 + 30 * DAY)
            )
            .is_empty()
        );
    }

    // describe('occurrences at the edges')

    #[test]
    fn leaves_out_a_date_that_falls_exactly_on_the_end_as_the_runner_does() {
        let got = occurrences_in(
            t("2026-11-01T08:00:00.000Z"),
            Cadence::Monthly,
            Some(t("2027-01-01T08:00:00.000Z")),
            t("2026-11-01T00:00:00.000Z"),
            t("2027-01-31T00:00:00.000Z"),
        );
        assert_eq!(
            got.iter()
                .map(|(_, at)| at.iso().get(..10).unwrap().to_owned())
                .collect::<Vec<_>>(),
            ["2026-11-01", "2026-12-01"]
        );
    }

    // describe('the merged window')

    #[test]
    fn puts_each_kind_on_its_date_soonest_first_and_loans_say_their_dates_are_not_published() {
        let f = Fake {
            schedules: Some(Ok(vec![schedule(
                "S-1",
                Cadence::Once,
                "2026-11-20T09:00:00.000Z",
                "2026-11-20T09:00:00.000Z",
                "25",
            )])),
            bills: Some(Ok(vec![RecurringBill {
                id: "B-1".to_owned(),
                reference: "TEST meter 7".to_owned(),
                amount: "40".to_owned(),
                asset_id: "USDT".to_owned(),
                cadence: Cadence::Monthly,
                status: "active".to_owned(),
                starts_at: t("2026-10-15T00:00:00.000Z"),
                ends_at: None,
                next_run_at: t("2026-11-15T00:00:00.000Z"),
            }])),
            collections: Some(Ok(vec![collection(
                "2026-11-03T00:00:00.000Z",
                "failed",
                Some("bank.insufficient_funds"),
            )])),
            positions: Some(Ok(vec![
                position("P-1", "100", Some("2026-11-25T00:00:00.000Z")),
                position("P-flexible", "1", None),
            ])),
            loans: Some(Ok(vec!["active".to_owned(), "repaid".to_owned()])),
            ..live()
        };
        let v = view(&f, 30.0);
        assert_eq!(
            v.items
                .iter()
                .map(|i| (i.source, day(i), i.status, i.reason_code.clone()))
                .collect::<Vec<_>>(),
            [
                (
                    "direct_debits",
                    "2026-11-03".to_owned(),
                    "failed",
                    Some("bank.insufficient_funds".to_owned())
                ),
                ("bills", "2026-11-15".to_owned(), "upcoming", None),
                ("standing_orders", "2026-11-20".to_owned(), "upcoming", None),
                ("earn", "2026-11-25".to_owned(), "upcoming", None),
            ]
        );
        let dd = v
            .items
            .iter()
            .find(|i| i.source == "direct_debits")
            .unwrap();
        assert_eq!(
            (
                dd.ref_id.as_str(),
                dd.label.as_deref(),
                dd.amount.as_deref()
            ),
            ("MD-1", Some("TEST Gym"), Some("5"))
        );
        assert_eq!(
            v.sources,
            [
                report("standing_orders", "ok", 1, None, true),
                report("bills", "ok", 1, None, true),
                report("direct_debits", "ok", 1, None, true),
                report("loans", "not_set", 1, Some(LOAN_SCHEDULE_UNSET), true),
                report("earn", "ok", 1, None, true),
            ]
        );
        assert_eq!(
            (v.from.iso(), v.to.iso()),
            (
                "2026-11-01T00:00:00.000Z".to_owned(),
                "2026-12-01T00:00:00.000Z".to_owned()
            )
        );
    }

    #[test]
    fn a_source_that_breaks_names_itself_and_is_logged_a_source_that_refuses_shows_its_code_the_others_still_show()
     {
        // `personalPayError('bank.bills_list_limit_unset')` is no `BankError` row in Rust; a refusal with a bank code
        // stands in for it, as the TypeScript's `refusalCode` reads both alike.
        let f = Fake {
            positions: Some(Err(Refusal::Other("connection reset".to_owned()))),
            loans: Some(Err(refuse("bank.loans_list_limit_unset", "limit unset"))),
            bills: Some(Err(refuse(
                "bank.schedules_list_limit_unset",
                "limit unset",
            ))),
            collections: Some(Ok(vec![collection(
                "2026-11-12T00:00:00.000Z",
                "upcoming",
                None,
            )])),
            ..Fake::default()
        };
        let mut log = Vec::new();
        let v = run(&f, USER, 30.0, 50, None, &mut log).unwrap();
        assert_eq!(v.items.len(), 1);
        assert_eq!(
            (v.items[0].source, v.items[0].status),
            ("direct_debits", "upcoming")
        );
        assert_eq!(
            v.sources,
            [
                report("standing_orders", "ok", 0, None, true),
                report(
                    "bills",
                    "refused",
                    0,
                    Some("bank.schedules_list_limit_unset"),
                    false
                ),
                report("direct_debits", "ok", 1, None, true),
                report(
                    "loans",
                    "refused",
                    0,
                    Some("bank.loans_list_limit_unset"),
                    false
                ),
                report("earn", "unavailable", 0, Some(SOURCE_UNAVAILABLE), false),
            ]
        );
        assert_eq!(log, [("earn".to_owned(), "connection reset".to_owned())]);
    }

    #[test]
    fn the_persons_test_switch_fails_one_source_it_reads_unavailable_unread_and_logged_and_the_others_still_show()
     {
        let f = Fake {
            positions: Some(Ok(vec![position(
                "P-1",
                "3",
                Some("2026-11-20T00:00:00.000Z"),
            )])),
            ..live()
        };
        let mut log = Vec::new();
        let v = run(&f, USER, 30.0, 50, Some("direct_debits"), &mut log).unwrap();
        assert_eq!(f.collections_read.get(), 0);
        assert_eq!(
            v.items.iter().map(|i| i.source).collect::<Vec<_>>(),
            ["earn"]
        );
        assert_eq!(
            v.sources.iter().find(|s| s.source == "direct_debits"),
            Some(&report(
                "direct_debits",
                "unavailable",
                0,
                Some(SOURCE_UNAVAILABLE),
                false
            ))
        );
        assert_eq!(
            v.sources
                .iter()
                .filter(|s| s.state == "unavailable")
                .count(),
            1
        );
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].0, "direct_debits");
        // Another person's calendar is untouched by this person's switch: the door reads the switch per person, so
        // another person's read carries none.
        let other = run(
            &f,
            "52222222-2222-4222-8222-222222222222",
            30.0,
            50,
            None,
            &mut Vec::new(),
        )
        .unwrap();
        assert!(other.sources.iter().all(|s| s.state != "unavailable"));
        assert_eq!(f.collections_read.get(), 1);
    }

    #[test]
    fn with_no_bill_partner_an_empty_bills_source_says_why() {
        let v = view(&Fake::default(), 30.0);
        assert_eq!(
            v.sources.iter().find(|s| s.source == "bills"),
            Some(&report(
                "bills",
                "ok",
                0,
                Some("bank.bills_psp_unset"),
                true
            ))
        );
    }

    #[test]
    fn refuses_a_window_of_no_days_more_than_two_months_or_no_date() {
        let f = Fake::default();
        for (at, days) in [
            (Some(from()), 0.0),
            (Some(from()), 63.0),
            (Some(from()), 1.5),
            (None, 30.0),
        ] {
            let got = window(
                &f,
                &Ask {
                    user_id: USER,
                    from: at,
                    days,
                    limit: 50,
                    now: now(),
                    failing: None,
                },
                &mut |_, _| {},
            );
            match got {
                Err(Refusal::Bank(e)) => assert_eq!(e.row.code, "bank.calendar_window_invalid"),
                other => panic!("{days}: {other:?}"),
            }
        }
    }

    #[test]
    fn leaves_out_a_past_date_an_order_never_ran_keeps_an_overdue_one_due_and_a_matured_unpaid_position_is_due()
     {
        // Behind: 8 and 9 Nov are due but not run; 5 to 7 Nov were passed over with no run of their own.
        let f = Fake {
            schedules: Some(Ok(vec![schedule(
                "S-2",
                Cadence::Daily,
                "2026-11-05T09:00:00.000Z",
                "2026-11-08T09:00:00.000Z",
                "1",
            )])),
            positions: Some(Ok(vec![position(
                "P-old",
                "10",
                Some("2026-11-04T00:00:00.000Z"),
            )])),
            ..live()
        };
        let v = view(&f, 12.0);
        assert_eq!(
            v.items
                .iter()
                .map(|i| (i.source, day(i), i.status))
                .collect::<Vec<_>>(),
            [
                ("earn", "2026-11-04".to_owned(), "upcoming"),
                ("standing_orders", "2026-11-08".to_owned(), "upcoming"),
                ("standing_orders", "2026-11-09".to_owned(), "upcoming"),
                ("standing_orders", "2026-11-10".to_owned(), "upcoming"),
                ("standing_orders", "2026-11-11".to_owned(), "upcoming"),
                ("standing_orders", "2026-11-12".to_owned(), "upcoming"),
            ]
        );
    }

    #[test]
    fn hides_a_paused_bills_past_dates_and_says_when_a_source_filled_its_whole_page() {
        let f = Fake {
            bills: Some(Ok(vec![RecurringBill {
                id: "B-p".to_owned(),
                reference: "TEST meter 9".to_owned(),
                amount: "40".to_owned(),
                asset_id: "USDT".to_owned(),
                cadence: Cadence::Weekly,
                status: "paused".to_owned(),
                starts_at: t("2026-10-01T00:00:00.000Z"),
                ends_at: None,
                next_run_at: t("2026-10-08T00:00:00.000Z"),
            }])),
            ..live()
        };
        let v = run(&f, USER, 30.0, 1, None, &mut Vec::new()).unwrap();
        assert_eq!(
            v.items
                .iter()
                .map(|i| (day(i), i.status))
                .collect::<Vec<_>>(),
            [
                ("2026-11-12".to_owned(), "paused"),
                ("2026-11-19".to_owned(), "paused"),
                ("2026-11-26".to_owned(), "paused"),
            ]
        );
        let src = |s: &str| v.sources.iter().find(|r| r.source == s).unwrap().complete;
        assert!(!src("bills"));
        assert!(src("standing_orders"));
    }
}
