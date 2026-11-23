//! Standing orders (`transfers/transfer-service.ts`): create, read, list, edit, cancel, pause and resume, and the runner
//! that fires their occurrences; and the calls that reach them and one-off moves (`router/transfers.router.ts`'s
//! `create`, `schedule`, `scheduleToUser`, `listSchedules`, `updateSchedule`, `executions`, `cancel`, `pause`, `resume`,
//! and `ops.runDueTransfers`).
//!
//! "Exactly once" does not rest on the timer. It rests on `unique(schedule_id, occurrence)` on
//! `bank.transfer_executions` (the runner claims an occurrence by inserting before it posts) and on the ledger key
//! `bank.transfer.sched:<scheduleId>:<occurrence>`; both come from the same (schedule, occurrence) pair, and the
//! occurrence from the order's start and cadence alone (`calendar`).

use postgres::{GenericClient, Row, Transaction};
use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use super::calendar::{self, Cadence, MAX_CATCH_UP_PER_PASS};
use super::moves::{
    self, Made, MoveAsk, bank_transfer_key, booked_conflict, booked_matches, custody_mismatch,
    gate_destination, hide_destination_detail, post_bank_transfer, primary_for_credit,
    resolve_for_credit, resolve_for_debit, spend_refusal,
};
use super::{Deps, review, step_up};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::custody::Held;
use crate::partner::{Move, MoveRequest, refuse};
use crate::spaces::ports::PostFailure;
use crate::spaces::shared::{assert_may_add_to, assert_may_take_out};
use crate::spaces::space::{self, Space, at, in_tx, owner_list_limit, pg, reported, with};

/// `PAUSED_SKIP_REASON`: what an occurrence skipped while its order was paused records as its reason.
pub const PAUSED_SKIP_REASON: &str = "bank.schedule_paused";

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

/// The columns every order read selects, in [`Schedule::from_row`]'s order, for a table aliased `t`.
fn cols(t: &str) -> String {
    format!(
        "{t}id::text, {t}user_id, {t}asset_id, {t}from_space_id::text, {t}to_space_id::text, {t}amount::text, \
         {t}cadence::text, {}, {}, {}, {t}status::text, {t}revision",
        ms(&format!("{t}starts_at")),
        ms(&format!("{t}ends_at")),
        ms(&format!("{t}next_run_at")),
    )
}

/// `ScheduleRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub from_space_id: String,
    pub to_space_id: String,
    pub amount: Amount,
    pub cadence: Cadence,
    pub starts_at: Instant,
    pub ends_at: Option<Instant>,
    pub next_run_at: Instant,
    /// `active`, `paused`, `cancelled` or `completed`.
    pub status: String,
    pub revision: i64,
}

impl Schedule {
    fn from_row(r: &Row) -> Result<Schedule, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let cadence = s(6)?;
        Ok(Schedule {
            id: s(0)?,
            user_id: s(1)?,
            asset_id: s(2)?,
            from_space_id: s(3)?,
            to_space_id: s(4)?,
            amount: parse_amount(&s(5)?).map_err(Refusal::Other)?,
            cadence: Cadence::parse(&cadence)
                .ok_or_else(|| Refusal::Other(format!("cadence {cadence}")))?,
            starts_at: Instant(r.try_get::<_, i64>(7).map_err(|e| pg(&e))?),
            ends_at: r
                .try_get::<_, Option<i64>>(8)
                .map_err(|e| pg(&e))?
                .map(Instant),
            next_run_at: Instant(r.try_get::<_, i64>(9).map_err(|e| pg(&e))?),
            status: s(10)?,
            revision: i64::from(r.try_get::<_, i32>(11).map_err(|e| pg(&e))?),
        })
    }
}

fn one(rows: &[Row]) -> Result<Option<Schedule>, Refusal> {
    rows.first().map(Schedule::from_row).transpose()
}

fn not_found(id: &str) -> Refusal {
    refuse(
        "bank.schedule_not_found",
        format!("Schedule {id} not found"),
    )
}

fn validation(message: &str) -> Refusal {
    refuse("bank.validation_failed", message)
}

/// `parseScheduleEditCutoff`: the owner's minutes before the next run after which an order cannot be edited; blank or not
/// a whole number of at most six digits refuses `bank.schedule_edit_cutoff_unset`. Zero is a real choice.
pub fn edit_cutoff(raw: Option<&str>) -> Result<i64, Refusal> {
    let t = raw.map(service_kit::money::js_trim).unwrap_or_default();
    if (1..=6).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit()) {
        return t.parse().map_err(|_| cutoff_unset());
    }
    Err(cutoff_unset())
}

fn cutoff_unset() -> Refusal {
    refuse(
        "bank.schedule_edit_cutoff_unset",
        "Standing order edits are not open: the edit cutoff is not published (BANK_SCHEDULE_EDIT_CUTOFF_MINUTES)",
    )
}

/// What a standing order is created with.
pub struct NewSchedule<'a> {
    pub user_id: &'a str,
    pub from_space_id: &'a str,
    pub to_space_id: &'a str,
    pub amount: Amount,
    pub cadence: Cadence,
    pub starts_at: Instant,
    pub ends_at: Option<Instant>,
    pub schedule_id: &'a str,
}

/// `scheduleToUser`: an order paying another person's main space, refused with the one code for unknown, frozen and
/// closed, so a far-future order is not a free way to learn an id's state.
pub fn schedule_to_user(
    d: &Deps<'_>,
    n: &NewSchedule<'_>,
    to_user_id: &str,
) -> Result<Schedule, Refusal> {
    let dest_user = to_user_id.trim();
    let from = with(d.store, |c| space::get(c, n.from_space_id))?;
    let dest = if dest_user.is_empty() {
        None
    } else {
        primary_for_credit(d, dest_user, &from.asset_id)?
    };
    let Some(dest) = dest else {
        return Err(refuse(
            "bank.recipient_cannot_receive",
            moves::RECIPIENT_CANNOT_RECEIVE_MESSAGE,
        ));
    };
    create(
        d,
        &NewSchedule {
            to_space_id: &dest.id,
            ..*n
        },
    )
}

/// `schedule`: one order per caller-stable id. A retry with the same id is the same order when it carries the terms it
/// was created with (an edited order is compared on revision 1), else `bank.schedule_conflict`.
pub fn create(d: &Deps<'_>, n: &NewSchedule<'_>) -> Result<Schedule, Refusal> {
    if n.schedule_id.is_empty() {
        return Err(refuse(
            "bank.schedule_id_required",
            "Standing order create needs a caller-stable schedule id",
        ));
    }
    if n.from_space_id == n.to_space_id {
        return Err(refuse(
            "bank.same_space",
            "A standing order needs two different spaces",
        ));
    }
    if n.cadence == Cadence::Once && n.ends_at.is_some() {
        return Err(validation("A one-off payment has a date and no end date"));
    }
    let from = with(d.store, |c| space::get(c, n.from_space_id))?;
    let to = with(d.store, |c| space::get(c, n.to_space_id))?;
    if from.asset_id != to.asset_id {
        return Err(refuse(
            "bank.asset_mismatch",
            format!(
                "Cannot schedule {} into a {} space",
                from.asset_id, to.asset_id
            ),
        ));
    }
    if to.user_id != from.user_id {
        moves::assert_can_receive(d, &to.user_id)?;
    }
    let amount = format_amount(n.amount);
    let starts = n.starts_at.0;
    let ends = n.ends_at.map(|e| e.0);
    let end_at = format!("CASE WHEN $9::int8 IS NULL THEN NULL ELSE {} END", at("$9"));
    let inserted = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.scheduled_transfers \
                     (id, user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, ends_at, next_run_at) \
                     VALUES ($1::text::uuid, $2, $3, $4::text::uuid, $5::text::uuid, $6::text::numeric, \
                     $7::text::bank.transfer_cadence, {start}, {end}, {start}) \
                     ON CONFLICT (id) DO NOTHING RETURNING {}",
                    cols(""),
                    start = at("$8"),
                    end = end_at,
                ),
                &[
                    &n.schedule_id,
                    &n.user_id,
                    &from.asset_id,
                    &n.from_space_id,
                    &n.to_space_id,
                    &amount,
                    &n.cadence.name(),
                    &starts,
                    &ends,
                ],
            )
            .map_err(|e| pg(&e))?;
        one(&rows)
    })?;
    if let Some(s) = inserted {
        return Ok(s);
    }
    let row = with(d.store, |c| find(c, n.schedule_id))?.ok_or_else(|| {
        refuse(
            "bank.schedule_not_found",
            format!("Schedule {} disappeared after a conflict", n.schedule_id),
        )
    })?;
    let original: Option<(Amount, Option<Instant>)> = if row.revision > 1 {
        with(d.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT amount::text, {} FROM bank.schedule_revisions \
                         WHERE schedule_id = $1::text::uuid AND revision = 1",
                        ms("ends_at")
                    ),
                    &[&n.schedule_id],
                )
                .map_err(|e| pg(&e))?;
            rows.first()
                .map(|r| -> Result<_, Refusal> {
                    Ok((
                        parse_amount(&r.get::<_, String>(0)).map_err(Refusal::Other)?,
                        r.get::<_, Option<i64>>(1).map(Instant),
                    ))
                })
                .transpose()
        })?
    } else {
        Some((row.amount, row.ends_at))
    };
    let same = original.is_some_and(|(amount, ends_at)| {
        row.user_id == n.user_id
            && row.from_space_id == n.from_space_id
            && row.to_space_id == n.to_space_id
            && amount == n.amount
            && row.cadence == n.cadence
            && row.starts_at == n.starts_at
            && ends_at == n.ends_at
    });
    if !same {
        return Err(refuse(
            "bank.schedule_conflict",
            format!(
                "Schedule {} already exists on different terms — a retry must carry the same instruction",
                n.schedule_id
            ),
        ));
    }
    Ok(row)
}

fn find(c: &mut impl GenericClient, id: &str) -> Result<Option<Schedule>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.scheduled_transfers WHERE id = $1::text::uuid",
                cols("")
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    one(&rows)
}

/// `getSchedule`: one order by id, whoever owns it; the router decides what the caller is told.
pub fn get(d: &Deps<'_>, id: &str) -> Result<Schedule, Refusal> {
    with(d.store, |c| find(c, id))?.ok_or_else(|| not_found(id))
}

/// `listSchedules`: the caller's orders, newest first, each with the caller's own destination space or none.
pub fn list(
    d: &Deps<'_>,
    user_id: &str,
    limit: Option<f64>,
    to_space_id: Option<&str>,
) -> Result<Vec<(Schedule, Option<String>)>, Refusal> {
    let page = owner_list_limit(
        limit,
        "bank.schedules_list_limit_unset",
        "transfers.listSchedules",
    )?;
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {}, CASE WHEN s.user_id = t.user_id THEN t.to_space_id::text END \
                     FROM bank.scheduled_transfers t LEFT JOIN bank.spaces s ON s.id = t.to_space_id \
                     WHERE t.user_id = $1 \
                     AND ($2::text IS NULL OR (t.to_space_id = $2::text::uuid AND s.user_id = t.user_id)) \
                     ORDER BY t.created_at DESC LIMIT $3",
                    cols("t.")
                ),
                &[&user_id, &to_space_id, &page],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| Ok((Schedule::from_row(r)?, r.get::<_, Option<String>>(12))))
            .collect()
    })
}

/// What an edit asks for.
pub struct Edit<'a> {
    pub schedule_id: &'a str,
    pub user_id: &'a str,
    pub revision: i64,
    pub amount: Amount,
    pub ends_at: Option<Instant>,
}

/// `updateSchedule`: a new amount or end at the revision the caller read; the same edit again is answered with what it
/// made; another revision refuses `bank.schedule_revision_conflict`. Nothing is posted; what the order said before is kept.
pub fn update(d: &Deps<'_>, e: &Edit<'_>) -> Result<Schedule, Refusal> {
    let now = d.now;
    let cutoff = edit_cutoff(d.w.settings.schedule_edit_cutoff.as_deref())?;
    if e.amount <= Amount::ZERO {
        return Err(validation("A standing order amount must be above zero"));
    }
    in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.scheduled_transfers WHERE id = $1::text::uuid FOR UPDATE",
                    cols("")
                ),
                &[&e.schedule_id],
            )
            .map_err(|err| pg(&err))?;
        let current = match one(&rows)? {
            Some(s) if s.user_id == e.user_id => s,
            _ => return Err(not_found(e.schedule_id)),
        };
        if current.revision == e.revision + 1
            && current.amount == e.amount
            && current.ends_at == e.ends_at
        {
            return Ok(current);
        }
        if current.revision != e.revision {
            return Err(refuse(
                "bank.schedule_revision_conflict",
                format!(
                    "Schedule {} is at revision {}, not {}: read it again before editing",
                    e.schedule_id, current.revision, e.revision
                ),
            ));
        }
        if current.status != "active" && current.status != "paused" {
            return Err(refuse(
                "bank.schedule_inactive",
                format!(
                    "Schedule {} is {} and cannot be edited",
                    e.schedule_id, current.status
                ),
            ));
        }
        if current.cadence == Cadence::Once && e.ends_at.is_some() {
            return Err(validation("A one-off payment has a date and no end date"));
        }
        if e.ends_at
            .is_some_and(|end| end.0 <= now.0.max(current.starts_at.0))
        {
            return Err(validation(
                "The end date must be after today and after the first payment",
            ));
        }
        if current.status == "active" && current.next_run_at.0 - now.0 < cutoff * 60_000 {
            return Err(refuse(
                "bank.schedule_cutoff",
                format!(
                    "The next payment is due {}; edits close {cutoff} minutes before it",
                    current.next_run_at.iso()
                ),
            ));
        }
        let old_end = current.ends_at.map(|x| x.0);
        let rev = i32::try_from(current.revision).map_err(|x| Refusal::Other(x.to_string()))?;
        tx.execute(
            &format!(
                "INSERT INTO bank.schedule_revisions (schedule_id, revision, amount, ends_at, replaced_by) \
                 VALUES ($1::text::uuid, $2, $3::text::numeric, CASE WHEN $4::int8 IS NULL THEN NULL ELSE {} END, $5)",
                at("$4")
            ),
            &[
                &current.id,
                &rev,
                &format_amount(current.amount),
                &old_end,
                &e.user_id,
            ],
        )
        .map_err(|err| pg(&err))?;
        let closes = e.ends_at.is_some_and(|end| end.0 <= current.next_run_at.0);
        let status = if closes {
            "completed"
        } else {
            current.status.as_str()
        };
        let new_end = e.ends_at.map(|x| x.0);
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.scheduled_transfers SET amount = $2::text::numeric, \
                     ends_at = CASE WHEN $3::int8 IS NULL THEN NULL ELSE {} END, \
                     status = $4::text::bank.schedule_status, revision = revision + 1, updated_at = now() \
                     WHERE id = $1::text::uuid AND revision = $5 RETURNING {}",
                    at("$3"),
                    cols("")
                ),
                &[
                    &current.id,
                    &format_amount(e.amount),
                    &new_end,
                    &status,
                    &rev,
                ],
            )
            .map_err(|err| pg(&err))?;
        one(&rows)?.ok_or_else(|| not_found(e.schedule_id))
    })
}

/// One `scheduleRevisions` row: the revision, its amount and end, and when it was replaced.
pub type Revision = (i64, Amount, Option<Instant>, Instant);

/// `scheduleRevisions`: what the order said before each edit, newest first.
pub fn revisions(d: &Deps<'_>, id: &str) -> Result<Vec<Revision>, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT revision, amount::text, {}, {} FROM bank.schedule_revisions \
                     WHERE schedule_id = $1::text::uuid ORDER BY revision DESC LIMIT 100",
                    ms("ends_at"),
                    ms("replaced_at")
                ),
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| {
                Ok((
                    i64::from(r.get::<_, i32>(0)),
                    parse_amount(&r.get::<_, String>(1)).map_err(Refusal::Other)?,
                    r.get::<_, Option<i64>>(2).map(Instant),
                    Instant(r.get(3)),
                ))
            })
            .collect()
    })
}

/// `cancelSchedule`: never touches occurrences already fired; cancel is not reverse.
pub fn cancel(d: &Deps<'_>, id: &str) -> Result<(), Refusal> {
    let n = with(d.store, |c| {
        c.execute(
            "UPDATE bank.scheduled_transfers SET status = 'cancelled', updated_at = now() \
             WHERE id = $1::text::uuid AND status IN ('active', 'paused')",
            &[&id],
        )
        .map_err(|e| pg(&e))
    })?;
    if n == 0 {
        return Err(refuse(
            "bank.schedule_inactive",
            format!("Schedule {id} is not cancellable"),
        ));
    }
    Ok(())
}

/// `pauseSchedule`: stops the order firing without destroying it; a missing order and one not running refuse apart.
pub fn pause(d: &Deps<'_>, id: &str) -> Result<Schedule, Refusal> {
    let row = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.scheduled_transfers SET status = 'paused', updated_at = now() \
                     WHERE id = $1::text::uuid AND status = 'active' RETURNING {}",
                    cols("")
                ),
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        one(&rows)
    })?;
    if let Some(s) = row {
        return Ok(s);
    }
    get(d, id)?;
    Err(refuse(
        "bank.schedule_inactive",
        format!("Schedule {id} is not active"),
    ))
}

/// `ResumeReport`: the order as it now stands, and the occurrences that came due while paused and will never fire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resumed {
    pub schedule: Schedule,
    pub skipped: Vec<i64>,
}

fn last_fired(c: &mut impl GenericClient, id: &str) -> Result<Option<i64>, Refusal> {
    let r = c
        .query_one(
            "SELECT MAX(occurrence) FROM bank.transfer_executions WHERE schedule_id = $1::text::uuid",
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    Ok(r.get::<_, Option<i32>>(0).map(i64::from))
}

/// `resumeSchedule`: starts a paused order again WITHOUT settling up: every occurrence that came due while paused is
/// recorded as skipped (`bank.schedule_paused`), and nothing is due the moment it resumes.
pub fn resume(d: &Deps<'_>, id: &str, max_catch_up: i64) -> Result<Resumed, Refusal> {
    let now = d.now;
    in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.scheduled_transfers WHERE id = $1::text::uuid FOR UPDATE",
                    cols("")
                ),
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        let s = one(&rows)?.ok_or_else(|| not_found(id))?;
        if s.status != "paused" {
            return Err(refuse(
                "bank.schedule_inactive",
                format!("Schedule {id} is not paused"),
            ));
        }
        let last = last_fired(tx, id)?;
        let due = calendar::due_occurrence(s.starts_at, s.cadence, now);
        let window_end = calendar::last_occurrence_before(s.starts_at, s.cadence, s.ends_at);
        let ceiling = due.map(|du| window_end.map_or(du, |w| du.min(w)));
        let from = last.map_or(0, |l| l + 1);
        let mut skipped: Vec<i64> = Vec::new();
        if let Some(ceil) = ceiling.filter(|c| from <= *c) {
            let (f, t) = (
                i32::try_from(from).map_err(|e| Refusal::Other(e.to_string()))?,
                i32::try_from(ceil).map_err(|e| Refusal::Other(e.to_string()))?,
            );
            let claimed = tx
                .query(
                    "INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code) \
                     SELECT $1::text::uuid, n, $2::text::numeric, 'skipped', $3 FROM generate_series($4::int, $5::int) AS n \
                     ON CONFLICT (schedule_id, occurrence) DO NOTHING RETURNING occurrence",
                    &[&id, &format_amount(s.amount), &PAUSED_SKIP_REASON, &f, &t],
                )
                .map_err(|e| pg(&e))?;
            skipped = claimed
                .iter()
                .map(|r| i64::from(r.get::<_, i32>(0)))
                .collect();
            skipped.sort_unstable();
        }
        let new_last = match ceiling {
            None => last,
            Some(c) => Some(last.map_or(c, |l| l.max(c))),
        };
        let plan = calendar::plan_due(
            s.starts_at,
            s.cadence,
            s.ends_at,
            new_last,
            now,
            max_catch_up,
        );
        if !plan.occurrences.is_empty() {
            return Err(Refusal::Other(format!(
                "resume would leave {} occurrence(s) immediately due on schedule {id} — refusing",
                plan.occurrences.len()
            )));
        }
        let status = if plan.completed {
            "completed"
        } else {
            "active"
        };
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.scheduled_transfers SET status = $2::text::bank.schedule_status, next_run_at = {}, \
                     updated_at = now() WHERE id = $1::text::uuid AND status = 'paused' RETURNING {}",
                    at("$3"),
                    cols("")
                ),
                &[&id, &status, &plan.next_run_at.0],
            )
            .map_err(|e| pg(&e))?;
        Ok(Resumed {
            schedule: one(&rows)?.ok_or_else(|| not_found(id))?,
            skipped,
        })
    })
}

// ── The runner ────────────────────────────────────────────────────────────────────────────────────────────────────

/// `FiringOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Settled,
    Rejected,
    AlreadyFired,
    Stopped,
    Busy,
}

/// One schedule's fault on a pass (`RunReport.failures`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub schedule_id: String,
    pub reason: String,
    pub code: Option<String>,
}

/// `RunReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunReport {
    pub schedules_considered: i64,
    pub settled: i64,
    pub rejected: i64,
    pub already_fired: i64,
    pub stranded_swept: i64,
    pub failures: Vec<Failure>,
}

impl RunReport {
    /// The report in the output schema's key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("schedulesConsidered", Json::int(self.schedules_considered)),
            ("settled", Json::int(self.settled)),
            ("rejected", Json::int(self.rejected)),
            ("alreadyFired", Json::int(self.already_fired)),
            ("strandedSwept", Json::int(self.stranded_swept)),
            (
                "failures",
                Json::Array(
                    self.failures
                        .iter()
                        .map(|f| {
                            let mut o = vec![
                                ("scheduleId".to_owned(), Json::str(f.schedule_id.clone())),
                                ("reason".to_owned(), Json::str(f.reason.clone())),
                            ];
                            if let Some(c) = &f.code {
                                o.push(("code".to_owned(), Json::str(c.clone())));
                            }
                            Json::Object(o)
                        })
                        .collect(),
                ),
            ),
        ])
    }

    fn count(&mut self, outcomes: &[Outcome]) {
        for o in outcomes {
            match o {
                Outcome::Settled => self.settled += 1,
                Outcome::Rejected => self.rejected += 1,
                Outcome::AlreadyFired => self.already_fired += 1,
                Outcome::Stopped | Outcome::Busy => {}
            }
        }
    }
}

/// `assertTransferDueLimit`: the pass's batch, 1 to 10000; blank refuses, never 200.
pub fn due_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    let Some(l) = limit.filter(|l| l.is_finite()) else {
        return Err(refuse(
            "bank.transfer_due_limit_unset",
            "transfers.runDueTransfers batch size is unset. Blank refuses — never 200. Pass a positive integer (200 is allowed if explicit).",
        ));
    };
    if l.fract() != 0.0 || !(1.0..=10_000.0).contains(&l) {
        return Err(validation(&format!(
            "limit must be an integer 1..10000, got {}",
            Json::Number(l).compact()
        )));
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number up to 10000"
    )]
    Ok(l as i64)
}

/// A post that failed on the runner: kept with its ledger code for the report, never shown to a caller.
fn ledger_fail(f: &PostFailure) -> Refusal {
    match f.code() {
        Some(code) => Refusal::Trpc(TrpcError::caused(
            "INTERNAL_SERVER_ERROR",
            f.message().to_owned(),
            code.to_owned(),
        )),
        None => Refusal::Other(f.message().to_owned()),
    }
}

fn failure(schedule_id: &str, r: &Refusal) -> Failure {
    let (reason, code) = match r {
        Refusal::Bank(e) => (e.message.clone(), Some(e.row.code.to_owned())),
        Refusal::Trpc(e) => (e.message.clone(), e.cause.clone()),
        Refusal::Other(m) => (m.clone(), None),
    };
    Failure {
        schedule_id: schedule_id.to_owned(),
        reason,
        code,
    }
}

/// `runDueTransfers`: every active order due at `now` (oldest first, at most `limit`), then every order holding a claim a
/// dead pass left. One order's fault is recorded and pushes it behind healthier ones; it never stops the pass.
pub fn run_due(d: &Deps<'_>, limit: Option<f64>, max_catch_up: i64) -> Result<RunReport, Refusal> {
    let now = d.now;
    let limit = due_limit(limit)?;
    let due = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.scheduled_transfers WHERE status = 'active' AND next_run_at <= {} \
                     ORDER BY next_run_at ASC LIMIT $2",
                    cols(""),
                    at("$1")
                ),
                &[&now.0, &limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Schedule::from_row)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let due_ids: Vec<String> = due.iter().map(|s| s.id.clone()).collect();
    let stranded = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.scheduled_transfers s WHERE NOT (s.id::text = ANY($1)) \
                     AND EXISTS (SELECT 1 FROM bank.transfer_executions e WHERE e.schedule_id = s.id AND e.status = 'pending') \
                     ORDER BY s.created_at ASC LIMIT $2",
                    cols("s.")
                ),
                &[&due_ids, &limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Schedule::from_row)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let mut report = RunReport {
        schedules_considered: i64::try_from(due.len() + stranded.len()).unwrap_or(i64::MAX),
        stranded_swept: i64::try_from(stranded.len()).unwrap_or(i64::MAX),
        ..RunReport::default()
    };
    let deprioritise = |id: &str| -> Result<(), Refusal> {
        with(d.store, |c| {
            c.execute(
                &format!(
                    "UPDATE bank.scheduled_transfers SET next_run_at = {}, updated_at = now() \
                     WHERE id = $2::text::uuid AND status = 'active'",
                    at("$1")
                ),
                &[&now.0, &id],
            )
            .map_err(|e| pg(&e))?;
            Ok(())
        })
    };
    for s in &due {
        match drive(d, s, max_catch_up) {
            Ok(o) => report.count(&o),
            Err(e) => {
                report.failures.push(failure(&s.id, &e));
                deprioritise(&s.id)?;
            }
        }
    }
    for s in &stranded {
        match sweep_stranded(d, s) {
            Ok(o) => report.count(&o),
            Err(e) => {
                report.failures.push(failure(&s.id, &e));
                deprioritise(&s.id)?;
            }
        }
    }
    Ok(report)
}

/// `sweepStrandedClaims`: finish every claim of this order still pending, in occurrence order.
fn sweep_stranded(d: &Deps<'_>, s: &Schedule) -> Result<Vec<Outcome>, Refusal> {
    let pending = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT occurrence FROM bank.transfer_executions WHERE schedule_id = $1::text::uuid \
                 AND status = 'pending' ORDER BY occurrence ASC",
                &[&s.id],
            )
            .map_err(|e| pg(&e))?;
        Ok(rows
            .iter()
            .map(|r| i64::from(r.get::<_, i32>(0)))
            .collect::<Vec<_>>())
    })?;
    pending.into_iter().map(|n| fire(d, s, n)).collect()
}

/// `driveSchedule`: stranded claims first, then the planned occurrences, then the scheduling hint, last.
fn drive(d: &Deps<'_>, s: &Schedule, max_catch_up: i64) -> Result<Vec<Outcome>, Refusal> {
    let last = with(d.store, |c| last_fired(c, &s.id))?;
    let plan = calendar::plan_due(s.starts_at, s.cadence, s.ends_at, last, d.now, max_catch_up);
    let mut outcomes = sweep_stranded(d, s)?;
    for n in &plan.occurrences {
        let o = fire(d, s, *n)?;
        if o == Outcome::Stopped {
            break;
        }
        outcomes.push(o);
        if o == Outcome::Busy {
            break;
        }
    }
    if outcomes.contains(&Outcome::Busy) {
        return Ok(outcomes);
    }
    let status = if plan.completed {
        "completed"
    } else {
        s.status.as_str()
    };
    with(d.store, |c| {
        c.execute(
            &format!(
                "UPDATE bank.scheduled_transfers SET next_run_at = {}, status = $2::text::bank.schedule_status, \
                 updated_at = now() WHERE id = $3::text::uuid AND status = 'active'",
                at("$1")
            ),
            &[&plan.next_run_at.0, &status, &s.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    Ok(outcomes)
}

fn exec_rows(
    tx: &mut Transaction<'_>,
    s: &Schedule,
    n: i32,
) -> Result<Option<(String, String, Amount)>, Refusal> {
    let rows = tx
        .query(
            "SELECT id::text, status::text, amount::text FROM bank.transfer_executions \
             WHERE schedule_id = $1::text::uuid AND occurrence = $2 FOR UPDATE",
            &[&s.id, &n],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| {
            Ok((
                r.get::<_, String>(0),
                r.get::<_, String>(1),
                parse_amount(&r.get::<_, String>(2)).map_err(Refusal::Other)?,
            ))
        })
        .transpose()
}

fn mark_settled(tx: &mut Transaction<'_>, exec: &str, made: &Made) -> Result<Outcome, Refusal> {
    let (column, id) = match made {
        Made::Ledger(id) => ("ledger_tx_id", id.as_str()),
        Made::Partner(m) => ("partner_move_id", m.id.as_str()),
    };
    tx.execute(
        &format!(
            "UPDATE bank.transfer_executions SET status = 'settled', {column} = $2, settled_at = now() \
             WHERE id = $1::text::uuid"
        ),
        &[&exec, &id],
    )
    .map_err(|e| pg(&e))?;
    Ok(Outcome::Settled)
}

fn mark_rejected(tx: &mut Transaction<'_>, exec: &str, code: &str) -> Result<Outcome, Refusal> {
    tx.execute(
        "UPDATE bank.transfer_executions SET status = 'rejected', rejection_code = $2 WHERE id = $1::text::uuid",
        &[&exec, &code],
    )
    .map_err(|e| pg(&e))?;
    Ok(Outcome::Rejected)
}

/// `fireOccurrence`: claim occurrence `n` under the order's row lock (a locked row is another pass: `busy`), then settle
/// it. A locked or archived space, or a person who may not send or receive, consumes the occurrence as rejected, unless
/// an earlier attempt already moved the money, which is recovered as settled.
fn fire(d: &Deps<'_>, s: &Schedule, n: i64) -> Result<Outcome, Refusal> {
    let now = d.now;
    let occ = i32::try_from(n).map_err(|e| Refusal::Other(e.to_string()))?;
    in_tx(d.store, |tx| {
        let live = tx
            .query(
                "SELECT status::text, amount::text FROM bank.scheduled_transfers WHERE id = $1::text::uuid \
                 FOR UPDATE SKIP LOCKED",
                &[&s.id],
            )
            .map_err(|e| pg(&e))?;
        let Some(live) = live.first() else {
            return Ok(Outcome::Busy);
        };
        let active = live.get::<_, String>(0) == "active";
        let (exec, claim_amount) = if active {
            let amount = parse_amount(&live.get::<_, String>(1)).map_err(Refusal::Other)?;
            let claimed = tx
                .query(
                    "INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status) \
                     VALUES ($1::text::uuid, $2, $3::text::numeric, 'pending') \
                     ON CONFLICT (schedule_id, occurrence) DO NOTHING RETURNING id::text",
                    &[&s.id, &occ, &format_amount(amount)],
                )
                .map_err(|e| pg(&e))?;
            match claimed.first() {
                Some(r) => (r.get::<_, String>(0), amount),
                None => match exec_rows(tx, s, occ)? {
                    Some((id, status, a)) if status == "pending" => (id, a),
                    _ => return Ok(Outcome::AlreadyFired),
                },
            }
        } else {
            match exec_rows(tx, s, occ)? {
                Some((id, status, a)) if status == "pending" => (id, a),
                _ => return Ok(Outcome::Stopped),
            }
        };
        let sides = (|| -> Result<(Space, Space), Refusal> {
            let from = resolve_for_debit(tx, &s.from_space_id, now)?;
            let to = resolve_for_credit(d, tx, &s.to_space_id, Some(&from.user_id), None)?;
            if to.user_id != from.user_id {
                moves::assert_can_send(d, &from.user_id)?;
            }
            Ok((from, to))
        })();
        let (from, to) = match sides {
            Ok(x) => x,
            Err(Refusal::Bank(e))
                if matches!(
                    e.row.code,
                    "bank.space_locked"
                        | "bank.space_archived"
                        | "bank.recipient_cannot_receive"
                        | "bank.sender_cannot_send"
                ) =>
            {
                let key = bank_transfer_key("sched", &s.id, n);
                if let Some(p) = d.custody.bank_for(&s.user_id) {
                    if let Some(prior) = p.move_by_key(&key) {
                        let from_acc = space::get(tx, &s.from_space_id)?.partner_account();
                        let to_acc = space::get(tx, &s.to_space_id)?.partner_account();
                        if prior.from != from_acc
                            || prior.to != to_acc
                            || prior.amount != claim_amount
                        {
                            return Err(booked_conflict(&s.id));
                        }
                        return mark_settled(tx, &exec, &Made::Partner(prior));
                    }
                } else if let Some(prior) = d.ledger.tx_by_key(&key).map_err(Refusal::Other)? {
                    return mark_settled(tx, &exec, &Made::Ledger(prior.id));
                }
                return mark_rejected(tx, &exec, e.row.code);
            }
            Err(e) => return Err(e),
        };
        let order = Schedule {
            amount: claim_amount,
            ..s.clone()
        };
        settle(d, tx, &exec, &order, &from, &to, n)
    })
}

/// `settle`: post the occurrence. Too little money is an ordinary outcome, recorded and consumed (a bills pot with the
/// fallback on is topped up from the main account first and tried once more); any other failure rolls the claim back.
fn settle(
    d: &Deps<'_>,
    tx: &mut Transaction<'_>,
    exec: &str,
    s: &Schedule,
    from: &Space,
    to: &Space,
    n: i64,
) -> Result<Outcome, Refusal> {
    let partner = d.custody.bank_for(&from.user_id);
    let to_partner = d.custody.bank_for(&to.user_id);
    if partner.is_some() || to_partner.is_some() {
        let (Some(p), Some(_)) = (partner, to_partner) else {
            let Refusal::Bank(e) = custody_mismatch() else {
                return Err(custody_mismatch());
            };
            return mark_rejected(tx, exec, e.row.code);
        };
        return settle_at_partner(d, tx, exec, s, from, to, n, &p);
    }
    let post = || {
        post_bank_transfer(
            d,
            &s.id,
            n,
            &from.ledger_account(),
            &to.ledger_account(),
            s.amount,
            "sched",
        )
    };
    let posted = match post() {
        Ok(tx) => tx,
        Err(f) if f.insufficient() => {
            if !top_up_bills_pot(d, tx, s, from, to, n)? {
                return mark_rejected(tx, exec, moves::LEDGER_INSUFFICIENT);
            }
            match post() {
                Ok(tx) => tx,
                Err(f) if f.insufficient() => {
                    return mark_rejected(tx, exec, moves::LEDGER_INSUFFICIENT);
                }
                Err(f) => return Err(ledger_fail(&f)),
            }
        }
        Err(f) => return Err(ledger_fail(&f)),
    };
    mark_settled(tx, exec, &Made::Ledger(posted.id))
}

fn partner_insufficient(r: &Refusal) -> bool {
    matches!(r, Refusal::Bank(e) if e.row.code == "bank.partner_insufficient_funds")
}

#[allow(
    clippy::too_many_arguments,
    reason = "settle's own arguments and the partner"
)]
fn settle_at_partner(
    d: &Deps<'_>,
    tx: &mut Transaction<'_>,
    exec: &str,
    s: &Schedule,
    from: &Space,
    to: &Space,
    n: i64,
    p: &Held<'_>,
) -> Result<Outcome, Refusal> {
    let attempt = || {
        p.move_(
            &MoveRequest {
                key: bank_transfer_key("sched", &s.id, n),
                from: from.partner_account(),
                to: to.partner_account(),
                amount: s.amount,
                payees: None,
            },
            d.now,
        )
    };
    let moved: Move = match attempt() {
        Ok(m) => m,
        Err(e) if partner_insufficient(&e) => {
            if !top_up_bills_pot_at_partner(d, tx, s, from, to, n, p)? {
                return mark_rejected(tx, exec, "bank.partner_insufficient_funds");
            }
            match attempt() {
                Ok(m) => m,
                Err(e) if partner_insufficient(&e) => {
                    return mark_rejected(tx, exec, "bank.partner_insufficient_funds");
                }
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(e),
    };
    mark_settled(tx, exec, &Made::Partner(moved))
}

/// `billsFallbackTransferId`: the ledger key's transfer id for a bills pot's top-up before one standing order.
pub fn bills_fallback_transfer_id(schedule_id: &str, pot_id: &str) -> String {
    format!("bills-fallback:{schedule_id}:{pot_id}")
}

/// The pot's bills role with the fallback on, and the owner's main space, when a top-up may be made at all.
fn fallback_source(
    tx: &mut Transaction<'_>,
    pot: &Space,
    to: &Space,
) -> Result<Option<Space>, Refusal> {
    if pot.kind != "named" || to.user_id == pot.user_id {
        return Ok(None);
    }
    let role = tx
        .query(
            "SELECT b.fallback FROM bank.bills_pots b JOIN bank.spaces s ON s.id = b.space_id \
             WHERE b.space_id = $1::text::uuid AND s.archived_at IS NULL",
            &[&pot.id],
        )
        .map_err(|e| pg(&e))?;
    if !role.first().is_some_and(|r| r.get::<_, bool>(0)) {
        return Ok(None);
    }
    moves::find_primary(tx, &pot.user_id, &pot.asset_id)
}

/// `topUpBillsPot`: the pot's shortfall for this order from the owner's main account, once per occurrence.
fn top_up_bills_pot(
    d: &Deps<'_>,
    tx: &mut Transaction<'_>,
    s: &Schedule,
    pot: &Space,
    to: &Space,
    n: i64,
) -> Result<bool, Refusal> {
    let Some(primary) = fallback_source(tx, pot, to)? else {
        return Ok(false);
    };
    let transfer_id = bills_fallback_transfer_id(&s.id, &pot.id);
    let key = bank_transfer_key("own", &transfer_id, n);
    if let Some(prior) = d.ledger.tx_by_key(&key).map_err(Refusal::Other)? {
        let booked = if prior.entries.is_empty() {
            d.ledger.tx_by_id(&prior.id).map_err(Refusal::Other)?
        } else {
            Some(prior)
        };
        let credit = booked
            .as_ref()
            .and_then(|b| b.entries.iter().find(|e| e.direction == "credit"))
            .map(|e| e.amount);
        let ok = match (&booked, credit) {
            (Some(b), Some(amount)) => booked_matches(
                d,
                b,
                &primary.ledger_account(),
                &pot.ledger_account(),
                amount,
            )?,
            _ => false,
        };
        if !ok {
            return Err(booked_conflict(&transfer_id));
        }
        return Ok(true);
    }
    let held = d
        .ledger
        .balance(&pot.ledger_account())
        .map_err(Refusal::Other)?;
    let shortfall = s.amount - held;
    if shortfall <= Amount::ZERO {
        return Ok(true);
    }
    let main = resolve_for_debit(tx, &primary.id, d.now)?;
    match post_bank_transfer(
        d,
        &transfer_id,
        n,
        &main.ledger_account(),
        &pot.ledger_account(),
        shortfall,
        "own",
    ) {
        Ok(booked) => {
            if !booked_matches(
                d,
                &booked,
                &main.ledger_account(),
                &pot.ledger_account(),
                shortfall,
            )? {
                return Err(booked_conflict(&transfer_id));
            }
            Ok(true)
        }
        Err(f) if f.insufficient() => Ok(false),
        Err(f) => Err(ledger_fail(&f)),
    }
}

/// `topUpBillsPotAtPartner`: the same top-up as one partner move.
fn top_up_bills_pot_at_partner(
    d: &Deps<'_>,
    tx: &mut Transaction<'_>,
    s: &Schedule,
    pot: &Space,
    to: &Space,
    n: i64,
    p: &Held<'_>,
) -> Result<bool, Refusal> {
    let Some(primary) = fallback_source(tx, pot, to)? else {
        return Ok(false);
    };
    let transfer_id = bills_fallback_transfer_id(&s.id, &pot.id);
    let key = bank_transfer_key("own", &transfer_id, n);
    if let Some(prior) = p.move_by_key(&key) {
        if prior.from != primary.partner_account() || prior.to != pot.partner_account() {
            return Err(booked_conflict(&transfer_id));
        }
        return Ok(true);
    }
    let held = reported(&p.balance(&pot.partner_account(), d.now))?;
    let shortfall = s.amount - held;
    if shortfall <= Amount::ZERO {
        return Ok(true);
    }
    let main = resolve_for_debit(tx, &primary.id, d.now)?;
    match p.move_(
        &MoveRequest {
            key,
            from: main.partner_account(),
            to: pot.partner_account(),
            amount: shortfall,
            payees: None,
        },
        d.now,
    ) {
        Ok(_) => Ok(true),
        Err(e) if partner_insufficient(&e) => Ok(false),
        Err(e) => Err(e),
    }
}

/// `executions`: what ran, and why anything did not, in occurrence order.
pub fn executions(d: &Deps<'_>, id: &str, limit: Option<f64>) -> Result<Json, Refusal> {
    let page = owner_list_limit(
        limit,
        "bank.executions_list_limit_unset",
        "transfers.executions",
    )?;
    with(d.store, |c| {
        let rows = c
            .query(
                "SELECT occurrence, amount::text, status::text, ledger_tx_id, partner_move_id, rejection_code \
                 FROM bank.transfer_executions WHERE schedule_id = $1::text::uuid ORDER BY occurrence ASC LIMIT $2",
                &[&id, &page],
            )
            .map_err(|e| pg(&e))?;
        let opt = |v: Option<String>| v.map_or(Json::Null, Json::str);
        rows.iter()
            .map(|r| {
                Ok(Json::obj([
                    ("occurrence", Json::int(i64::from(r.get::<_, i32>(0)))),
                    (
                        "amount",
                        Json::str(format_amount(
                            parse_amount(&r.get::<_, String>(1)).map_err(Refusal::Other)?,
                        )),
                    ),
                    ("status", Json::str(r.get::<_, String>(2))),
                    ("ledgerTxId", opt(r.get(3))),
                    ("partnerMoveId", opt(r.get(4))),
                    ("rejectionCode", opt(r.get(5))),
                ]))
            })
            .collect::<Result<Vec<_>, Refusal>>()
            .map(Json::Array)
    })
}

// ── The calls ─────────────────────────────────────────────────────────────────────────────────────────────────────

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn opt_text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

fn amount_of(v: &Value, key: &str) -> Result<Amount, Refusal> {
    parse_amount(text(v, key)).map_err(Refusal::Other)
}

fn date(v: &Value, key: &str) -> Result<Instant, Refusal> {
    js_date(text(v, key)).ok_or_else(|| Refusal::Other(format!("{key} is no date")))
}

fn opt_date(v: &Value, key: &str) -> Result<Option<Instant>, Refusal> {
    match opt_text(v, key) {
        Some(_) => date(v, key).map(Some),
        None => Ok(None),
    }
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

/// `assertSelf`.
pub fn assert_self(user_id: &str, owner: &str) -> Result<(), Refusal> {
    if user_id == owner {
        return Ok(());
    }
    Err(Refusal::Trpc(TrpcError::plain(
        "FORBIDDEN",
        "This account belongs to another user",
    )))
}

/// `assertPartnerAnswering`: the partner-down switch alone.
fn partner_answering(d: &Deps<'_>, user_id: &str) -> Result<(), Refusal> {
    if d.partner
        .partner
        .as_ref()
        .is_some_and(|p| p.switches(user_id).down)
    {
        return Err(refuse(
            "bank.partner_unavailable",
            "The partner bank is not answering. Nothing was sent or changed.",
        ));
    }
    Ok(())
}

/// Where a payment goes, for the review line.
enum Payee<'a> {
    User(&'a str),
    Space(&'a str),
}

/// `refuseOverReviewLine`: every door that pays another person but Send refuses above the owner's review line, so none
/// is a way around the review. An unknown destination counts as another person's.
fn refuse_over_review_line(
    d: &Deps<'_>,
    caller: &str,
    asset_id: &str,
    amount: Amount,
    to: &Payee<'_>,
) -> Result<(), Refusal> {
    if !review::over_review_line(d.w.settings.send_review.as_deref(), asset_id, amount) {
        return Ok(());
    }
    match to {
        Payee::User(u) if *u == caller => return Ok(()),
        Payee::Space(id) => {
            if with(d.store, |c| space::find(c, id))?.is_some_and(|s| s.user_id == caller) {
                return Ok(());
            }
        }
        Payee::User(_) => {}
    }
    Err(refuse(
        "bank.personal_send_review_door",
        "A payment to another person above the review line goes through Send, where it is reviewed (bank.personal_send_review_door)",
    ))
}

/// A destination space's step-up, as `create` and `schedule` ask it: a viewer of the pot is refused before any second
/// factor is spent, and a space not the caller's own (or unknown) needs one.
fn space_step_up(
    d: &Deps<'_>,
    principal: &Principal,
    to_space_id: &str,
    binding: &step_up::Binding,
    approval: Option<&str>,
) -> Result<(), Refusal> {
    if !step_up::enforced(d) {
        return Ok(());
    }
    let user = principal.user_id.as_str();
    let to = with(d.store, |c| {
        let to = space::find(c, to_space_id)?;
        if let Some(t) = &to
            && t.user_id != user
        {
            assert_may_add_to(c, user, &t.id)?;
        }
        Ok(to)
    })?;
    if to.is_none_or(|t| t.user_id != user) {
        step_up::require(d, principal, binding, approval)?;
    }
    Ok(())
}

/// The debit side of every door: the space exists, a shared pot's member who is not its owner takes nothing out, and it
/// is the caller's own.
fn own_source(d: &Deps<'_>, user: &str, from_space_id: &str) -> Result<Space, Refusal> {
    let from = with(d.store, |c| {
        let from = space::get(c, from_space_id)?;
        assert_may_take_out(c, user, &from.id, &from.user_id)?;
        Ok(from)
    })?;
    assert_self(user, &from.user_id)?;
    Ok(from)
}

fn schedule_out(s: &Schedule) -> Json {
    Json::obj([
        ("id", Json::str(s.id.clone())),
        ("nextRunAt", Json::str(s.next_run_at.iso())),
    ])
}

fn create_call(d: &Deps<'_>, principal: &Principal, input: &Value) -> Result<Json, Refusal> {
    let user = principal.user_id.as_str();
    crate::spaces::router::offers(d.partner, user, "spaces")?;
    let from = own_source(d, user, text(input, "fromSpaceId"))?;
    let to_space = text(input, "toSpaceId");
    let amount = amount_of(input, "amount")?;
    refuse_over_review_line(d, user, &from.asset_id, amount, &Payee::Space(to_space))?;
    let transfer_id = text(input, "transferId");
    let binding = step_up::create_transfer_binding(&step_up::CreateTransfer {
        actor: user,
        transfer_id,
        from_space_id: text(input, "fromSpaceId"),
        to_space_id: to_space,
        asset_id: &from.asset_id,
        amount: text(input, "amount"),
        note: opt_text(input, "note"),
        reference: opt_text(input, "reference"),
    });
    space_step_up(
        d,
        principal,
        to_space,
        &binding,
        opt_text(input, "stepUpApprovalId"),
    )?;
    let may_describe = gate_destination(d, user, &from, to_space)?;
    let moved = moves::move_between(
        d,
        &MoveAsk {
            transfer_id,
            from_space_id: text(input, "fromSpaceId"),
            to_space_id: to_space,
            amount,
            note: opt_text(input, "note"),
            reference: opt_text(input, "reference"),
            key_space: "own",
        },
        true,
    )
    .map_err(|e| {
        let shown = if may_describe {
            e
        } else {
            hide_destination_detail(e)
        };
        spend_refusal(d, shown, user, &from.asset_id)
    })?;
    Ok(match &moved.made {
        Made::Partner(m) => Json::obj([
            ("ledgerTxId", Json::Null),
            ("amount", Json::str(format_amount(moved.amount))),
            (
                "partnerMove",
                Json::obj([
                    ("id", Json::str(m.id.clone())),
                    ("label", Json::str(m.label)),
                    ("movedAt", Json::str(m.moved_at.iso())),
                ]),
            ),
        ]),
        Made::Ledger(id) => Json::obj([
            ("ledgerTxId", Json::str(id.clone())),
            ("amount", Json::str(format_amount(moved.amount))),
            ("partnerMove", Json::Null),
        ]),
    })
}

fn new_schedule<'a>(
    user: &'a str,
    input: &'a Value,
    to_space_id: &'a str,
) -> Result<NewSchedule<'a>, Refusal> {
    Ok(NewSchedule {
        user_id: user,
        from_space_id: text(input, "fromSpaceId"),
        to_space_id,
        amount: amount_of(input, "amount")?,
        cadence: Cadence::parse(text(input, "cadence"))
            .ok_or_else(|| Refusal::Other("cadence".to_owned()))?,
        starts_at: date(input, "startsAt")?,
        ends_at: opt_date(input, "endsAt")?,
        schedule_id: text(input, "scheduleId"),
    })
}

fn schedule_fields<'a>(user: &'a str, input: &'a Value, asset: &'a str) -> step_up::Schedule<'a> {
    step_up::Schedule {
        actor: user,
        schedule_id: text(input, "scheduleId"),
        from_space_id: text(input, "fromSpaceId"),
        asset_id: asset,
        amount: text(input, "amount"),
        cadence: text(input, "cadence"),
        starts_at: text(input, "startsAt"),
        ends_at: opt_text(input, "endsAt"),
    }
}

fn schedule_call(d: &Deps<'_>, principal: &Principal, input: &Value) -> Result<Json, Refusal> {
    let user = principal.user_id.as_str();
    partner_answering(d, user)?;
    let from = own_source(d, user, text(input, "fromSpaceId"))?;
    let to_space = text(input, "toSpaceId");
    refuse_over_review_line(
        d,
        user,
        &from.asset_id,
        amount_of(input, "amount")?,
        &Payee::Space(to_space),
    )?;
    let binding =
        step_up::schedule_binding(&schedule_fields(user, input, &from.asset_id), to_space);
    space_step_up(
        d,
        principal,
        to_space,
        &binding,
        opt_text(input, "stepUpApprovalId"),
    )?;
    let may_describe = gate_destination(d, user, &from, to_space)?;
    let s = create(d, &new_schedule(user, input, to_space)?).map_err(|e| {
        if may_describe {
            e
        } else {
            hide_destination_detail(e)
        }
    })?;
    Ok(schedule_out(&s))
}

fn schedule_to_user_call(
    d: &Deps<'_>,
    principal: &Principal,
    input: &Value,
) -> Result<Json, Refusal> {
    let user = principal.user_id.as_str();
    partner_answering(d, user)?;
    let from = own_source(d, user, text(input, "fromSpaceId"))?;
    let to_user = text(input, "toUserId");
    refuse_over_review_line(
        d,
        user,
        &from.asset_id,
        amount_of(input, "amount")?,
        &Payee::User(to_user),
    )?;
    if step_up::enforced(d) && to_user != user {
        let binding = step_up::schedule_to_user_binding(
            &schedule_fields(user, input, &from.asset_id),
            to_user,
        );
        step_up::require(d, principal, &binding, opt_text(input, "stepUpApprovalId"))?;
    }
    let s = schedule_to_user(d, &new_schedule(user, input, "")?, to_user)?;
    Ok(schedule_out(&s))
}

fn update_call(d: &Deps<'_>, principal: &Principal, input: &Value) -> Result<Json, Refusal> {
    let user = principal.user_id.as_str();
    partner_answering(d, user)?;
    let s = get(d, text(input, "scheduleId"))?;
    assert_self(user, &s.user_id)?;
    refuse_over_review_line(
        d,
        user,
        &s.asset_id,
        amount_of(input, "amount")?,
        &Payee::Space(&s.to_space_id),
    )?;
    #[allow(clippy::cast_possible_truncation, reason = "the schema's integer")]
    let revision = input.get("revision").as_number().unwrap_or(0.0) as i64;
    if step_up::enforced(d) {
        let to = with(d.store, |c| space::find(c, &s.to_space_id))?;
        if to.is_none_or(|t| t.user_id != user) {
            let starts = s.starts_at.iso();
            let binding = step_up::schedule_edit_binding(
                &step_up::Schedule {
                    actor: user,
                    schedule_id: &s.id,
                    from_space_id: &s.from_space_id,
                    asset_id: &s.asset_id,
                    amount: text(input, "amount"),
                    cadence: s.cadence.name(),
                    starts_at: &starts,
                    ends_at: opt_text(input, "endsAt"),
                },
                &s.to_space_id,
                revision,
            );
            step_up::require(d, principal, &binding, opt_text(input, "stepUpApprovalId"))?;
        }
    }
    let u = update(
        d,
        &Edit {
            schedule_id: text(input, "scheduleId"),
            user_id: user,
            revision,
            amount: amount_of(input, "amount")?,
            ends_at: opt_date(input, "endsAt")?,
        },
    )?;
    Ok(Json::obj([
        ("id", Json::str(u.id.clone())),
        ("revision", Json::int(u.revision)),
        ("amount", Json::str(format_amount(u.amount))),
        ("endsAt", iso(u.ends_at)),
        ("nextRunAt", Json::str(u.next_run_at.iso())),
    ]))
}

fn list_call(d: &Deps<'_>, user: &str, input: &Value) -> Result<Json, Refusal> {
    let rows = list(
        d,
        user,
        input.get("limit").as_number(),
        opt_text(input, "toSpaceId"),
    )?;
    Ok(Json::Array(
        rows.iter()
            .map(|(s, own)| {
                Json::obj([
                    ("id", Json::str(s.id.clone())),
                    ("assetId", Json::str(s.asset_id.clone())),
                    ("amount", Json::str(format_amount(s.amount))),
                    ("cadence", Json::str(s.cadence.name())),
                    ("startsAt", Json::str(s.starts_at.iso())),
                    ("endsAt", iso(s.ends_at)),
                    ("nextRunAt", Json::str(s.next_run_at.iso())),
                    ("status", Json::str(s.status.clone())),
                    ("revision", Json::int(s.revision)),
                    ("fromSpaceId", Json::str(s.from_space_id.clone())),
                    ("toSpaceId", own.clone().map_or(Json::Null, Json::str)),
                ])
            })
            .collect(),
    ))
}

/// One owned order, read before anything is written, as `cancel` reads it.
fn owned(d: &Deps<'_>, user: &str, input: &Value) -> Result<Schedule, Refusal> {
    let s = get(d, text(input, "scheduleId"))?;
    assert_self(user, &s.user_id)?;
    Ok(s)
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    if ctx.call.path == "ops.runDueTransfers" {
        return Some((|| {
            if !d.w.settings.scheduled_transfers {
                return Err(refuse(
                    "bank.transfers_disabled",
                    "scheduled transfers are disabled",
                ));
            }
            run_due(d, input.get("limit").as_number(), MAX_CATCH_UP_PER_PASS).map(|r| r.json())
        })());
    }
    let call = ctx.call.path.strip_prefix("transfers.")?;
    if !matches!(
        call,
        "create"
            | "schedule"
            | "scheduleToUser"
            | "listSchedules"
            | "updateSchedule"
            | "executions"
            | "cancel"
            | "pause"
            | "resume"
    ) {
        return None;
    }
    let Some(principal) = ctx.principal else {
        return Some(Err(Refusal::Other("no principal".to_owned())));
    };
    let user = principal.user_id.as_str();
    Some(match call {
        "create" => create_call(d, principal, input),
        "schedule" => schedule_call(d, principal, input),
        "scheduleToUser" => schedule_to_user_call(d, principal, input),
        "listSchedules" => list_call(d, user, input),
        "updateSchedule" => update_call(d, principal, input),
        "executions" => {
            owned(d, user, input).and_then(|s| executions(d, &s.id, input.get("limit").as_number()))
        }
        "cancel" => owned(d, user, input).and_then(|s| {
            cancel(d, &s.id)?;
            Ok(Json::obj([("cancelled", Json::Bool(true))]))
        }),
        "pause" => owned(d, user, input).and_then(|s| {
            let p = pause(d, &s.id)?;
            Ok(Json::obj([
                ("status", Json::str(p.status)),
                ("nextRunAt", Json::str(p.next_run_at.iso())),
            ]))
        }),
        _ => (|| {
            partner_answering(d, user)?;
            let s = owned(d, user, input)?;
            let r = resume(d, &s.id, MAX_CATCH_UP_PER_PASS)?;
            Ok(Json::obj([
                ("status", Json::str(r.schedule.status.clone())),
                ("nextRunAt", Json::str(r.schedule.next_run_at.iso())),
                (
                    "skipped",
                    Json::Array(r.skipped.iter().map(|n| Json::int(*n)).collect()),
                ),
            ]))
        })(),
    })
}
