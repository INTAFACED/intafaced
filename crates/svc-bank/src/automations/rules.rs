//! Part `rules` of the automations slice (`rules/`): the person's payment reminder rule, the standing-order notice
//! outbox and its job, and the rules that would move money by themselves (`rules.router.ts`, `scheduled-notices.ts`,
//! `POST /internal/jobs/run-scheduled-notices` with `job-bodies.ts`'s body).
//!
//! A person sets one reminder rule, business key `reminder:<userId>`: how long before each of their standing orders runs
//! they want to hear about it, from fixed choices, or off. A failure notice needs no rule: a run the runner refused is
//! told to its owner once. Both go through one outbox, `bank.scheduled_notices`, one row per (schedule, occurrence,
//! kind): the job writes what is owed, then publishes each owed row on the transfers slice's bus and marks it announced
//! only once the bus took it.
//!
//! If this crashes exactly here, whose funds are stranded? No one's: nothing here posts to the ledger.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;
use service_kit::tokens::is_guid;

use super::Deps;
use crate::door::Ctx;
use crate::door::jobs::{job_failed, ok};
use crate::door::rest::reply;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, in_tx, pg, with};
use crate::transfers::calendar::{self, Cadence};
use crate::transfers::notices::{amount_ok, asset_ok};

/// `REMINDER_LEAD_HOURS`: one, two, three or seven days before a run.
pub const REMINDER_LEAD_HOURS: [i64; 4] = [24, 48, 72, 168];

/// `RULE_TERMS_UNSET`.
pub const RULE_TERMS_UNSET: &str = "bank.rule_terms_unset";

/// `FAILURE_NOTICE_LOOKBACK_MS`: a failure older than this when the job first sees it is left to the run history.
pub const FAILURE_NOTICE_LOOKBACK_MS: i64 = 7 * 86_400_000;

/// `CLAIM_MS`: how long a pass holds the rows it is publishing.
const CLAIM_MS: i64 = 120_000;

/// `/internal/jobs/run-scheduled-notices`.
pub const RUN_SCHEDULED_NOTICES: &str = "/internal/jobs/run-scheduled-notices";

/// What the binary hands this part.
#[derive(Default)]
pub struct Wiring {
    /// `scheduledNotices`: the notices go out on the transfers slice's bus. `index.ts` always wires it; unwired, owed
    /// notices stay owed and the job names `bank.scheduled_notify_unwired`.
    pub notices: bool,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }

    /// `eventScheduledNotices(bus)`, as `index.ts` wires it.
    pub fn on_the_bus() -> Wiring {
        Wiring { notices: true }
    }
}

/// `ReminderRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderRule {
    pub rule_key: String,
    /// None when reminders are off.
    pub lead_hours: Option<i64>,
    pub revision: i64,
    pub updated_at: Instant,
}

impl ReminderRule {
    pub fn json(&self) -> Json {
        Json::obj([
            ("ruleKey", Json::str(self.rule_key.clone())),
            ("leadHours", self.lead_hours.map_or(Json::Null, Json::int)),
            ("revision", Json::int(self.revision)),
            ("updatedAt", Json::str(self.updated_at.iso())),
        ])
    }
}

/// `isReminderLead`.
pub fn is_reminder_lead(n: i64) -> bool {
    REMINDER_LEAD_HOURS.contains(&n)
}

const RULE_COLS: &str = "rule_key, lead_hours, revision, client_request_id, \
     floor(extract(epoch from updated_at) * 1000)::int8";

struct RuleRow {
    rule: ReminderRule,
    lead_hours: Option<i64>,
    client_request_id: String,
}

fn rule_row(r: &postgres::Row) -> Result<RuleRow, Refusal> {
    let lead = r
        .try_get::<_, Option<i32>>(1)
        .map_err(|e| pg(&e))?
        .map(i64::from);
    Ok(RuleRow {
        rule: ReminderRule {
            rule_key: r.try_get(0).map_err(|e| pg(&e))?,
            lead_hours: lead.filter(|n| is_reminder_lead(*n)),
            revision: i64::from(r.try_get::<_, i32>(2).map_err(|e| pg(&e))?),
            updated_at: Instant(r.try_get(4).map_err(|e| pg(&e))?),
        },
        lead_hours: lead,
        client_request_id: r.try_get(3).map_err(|e| pg(&e))?,
    })
}

fn read_rule(c: &mut impl GenericClient, user_id: &str) -> Result<Option<RuleRow>, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {RULE_COLS} FROM bank.reminder_rules WHERE user_id = $1"),
            &[&user_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(rule_row).transpose()
}

/// `reminderRule`: the person's rule, or none when they never set one (reminders are then off).
pub fn reminder_rule(d: &Deps<'_>, user_id: &str) -> Result<Option<ReminderRule>, Refusal> {
    Ok(with(d.store(), |c| read_rule(c, user_id))?.map(|r| r.rule))
}

/// `setReminderRule`'s input.
pub struct SetReminder<'a> {
    pub user_id: &'a str,
    pub lead_hours: Option<i64>,
    pub expected_revision: i64,
    pub client_request_id: &'a str,
}

/// `setReminderRule`: the caller names the revision it read (0 when there is no rule yet), so of two writes sent at the
/// same revision one lands and the other refuses `bank.reminder_revision_conflict`. The same write sent again (same
/// `clientRequestId`, choice and revision) reads back the row it made.
pub fn set_reminder_rule(d: &Deps<'_>, i: &SetReminder<'_>) -> Result<ReminderRule, Refusal> {
    if i.lead_hours.is_some_and(|n| !is_reminder_lead(n)) {
        return Err(refuse(
            "bank.reminder_lead_invalid",
            format!(
                "A reminder lead time is one of {} hours, or off",
                REMINDER_LEAD_HOURS.map(|n| n.to_string()).join(", ")
            ),
        ));
    }
    if i.expected_revision < 0 {
        return Err(refuse(
            "bank.reminder_lead_invalid",
            "A reminder rule write names the revision it read",
        ));
    }
    let key = format!("reminder:{}", i.user_id);
    let lead = i.lead_hours.and_then(|n| i32::try_from(n).ok());
    let expected = i32::try_from(i.expected_revision).unwrap_or(i32::MAX);
    with(d.store(), |c| {
        // No conflict target: the key is `reminder:<user_id>` (reminder_rules_key_ck), so both unique keys name the same
        // row, and a racing first write is absorbed on whichever key it hits, then read back below.
        let written = if i.expected_revision == 0 {
            c.query(
                &format!(
                    "INSERT INTO bank.reminder_rules (user_id, rule_key, lead_hours, revision, client_request_id) \
                     VALUES ($1, $2, $3, 1, $4) ON CONFLICT DO NOTHING RETURNING {RULE_COLS}"
                ),
                &[&i.user_id, &key, &lead, &i.client_request_id],
            )
        } else {
            c.query(
                &format!(
                    "UPDATE bank.reminder_rules SET lead_hours = $2, revision = revision + 1, \
                            client_request_id = $3, updated_at = now() \
                      WHERE user_id = $1 AND revision = $4 RETURNING {RULE_COLS}"
                ),
                &[&i.user_id, &lead, &i.client_request_id, &expected],
            )
        }
        .map_err(|e| pg(&e))?;
        if let Some(r) = written.first() {
            return Ok(rule_row(r)?.rule);
        }
        // A replay is the very write that landed: its request id, its choice and the revision it made.
        if let Some(row) = read_rule(c, i.user_id)?
            && row.client_request_id == i.client_request_id
            && row.lead_hours == i.lead_hours
            && row.rule.revision == i.expected_revision + 1
        {
            return Ok(row.rule);
        }
        Err(refuse(
            "bank.reminder_revision_conflict",
            format!(
                "The reminder rule changed since revision {}; read it again before saving",
                i.expected_revision
            ),
        ))
    })
}

/// `createMoneyRule`: rules that move money by themselves wait for the owner's terms; nothing is stored.
pub fn create_money_rule() -> Refusal {
    refuse(
        RULE_TERMS_UNSET,
        "Rules that move money by themselves are not open: their terms (allowed targets, a cap per rule) are not published",
    )
}

/// `ScheduledNoticePass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pass {
    pub reminders: i64,
    pub failures: i64,
    pub announced: i64,
    pub dropped: i64,
    pub owed: i64,
}

impl Pass {
    pub fn json(&self) -> Json {
        Json::obj([
            ("reminders", Json::int(self.reminders)),
            ("failures", Json::int(self.failures)),
            ("announced", Json::int(self.announced)),
            ("dropped", Json::int(self.dropped)),
            ("owed", Json::int(self.owed)),
        ])
    }
}

fn count(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn owed_count(c: &mut impl GenericClient) -> Result<i64, Refusal> {
    let r = c
        .query_one(
            "SELECT count(*)::int8 FROM bank.scheduled_notices WHERE announced_at IS NULL AND dropped_at IS NULL",
            &[],
        )
        .map_err(|e| pg(&e))?;
    r.try_get(0).map_err(|e| pg(&e))
}

/// `run`: one pass of the notice job: owe a reminder for each active standing order whose next run falls inside its
/// owner's lead time, owe a failure notice for each run refused in the last week, then publish what is owed. `limit`
/// bounds each of the three steps.
pub fn run(d: &Deps<'_>, limit: i64, now: Instant) -> Result<Pass, Refusal> {
    let reminders = owe_reminders(d, limit, now)?;
    let failures = owe_failures(d, limit, now)?;
    let (announced, dropped) = announce_owed(d, limit, now)?;
    let owed = with(d.store(), owed_count)?;
    Ok(Pass {
        reminders,
        failures,
        announced,
        dropped,
        owed,
    })
}

/// `occurrencesIn(order, nextRunAt, nextRunAt + 1ms)[0]`: the occurrence that falls exactly on `next`, none past the
/// order's end.
fn occurrence_at(
    starts_at: Instant,
    cadence: Cadence,
    ends_at: Option<Instant>,
    next: Instant,
) -> Option<i64> {
    let n = calendar::due_occurrence(starts_at, cadence, next)?;
    let start = calendar::occurrence_start(starts_at, cadence, n)?;
    (start == next && ends_at.is_none_or(|e| start.0 < e.0)).then_some(n)
}

fn owe_reminders(d: &Deps<'_>, limit: i64, now: Instant) -> Result<i64, Refusal> {
    with(d.store(), |c| {
        // Orders whose next run is still ahead and inside the owner's lead time, with no reminder for that run yet.
        let due = c
            .query(
                &format!(
                    "SELECT s.id::text, s.user_id, floor(extract(epoch from s.starts_at) * 1000)::int8, \
                            floor(extract(epoch from s.ends_at) * 1000)::int8, s.cadence::text, \
                            floor(extract(epoch from s.next_run_at) * 1000)::int8, r.lead_hours \
                       FROM bank.scheduled_transfers s \
                       JOIN bank.reminder_rules r ON r.user_id = s.user_id \
                      WHERE r.lead_hours IS NOT NULL \
                        AND s.status = 'active' \
                        AND s.next_run_at > {now} \
                        AND s.next_run_at <= {now} + make_interval(hours => r.lead_hours) \
                        AND NOT EXISTS ( \
                          SELECT 1 FROM bank.scheduled_notices n \
                           WHERE n.schedule_id = s.id AND n.kind = 'reminder' AND n.due_at = s.next_run_at \
                        ) \
                      ORDER BY s.next_run_at \
                      LIMIT $2",
                    now = at("$1")
                ),
                &[&now.0, &limit],
            )
            .map_err(|e| pg(&e))?;
        let mut ids = Vec::new();
        let mut ns = Vec::new();
        let mut users = Vec::new();
        let mut ats = Vec::new();
        let mut leads = Vec::new();
        for r in &due {
            let cadence: String = r.try_get(4).map_err(|e| pg(&e))?;
            let Some(cadence) = Cadence::parse(&cadence) else {
                return Err(Refusal::Other(format!("cadence {cadence}")));
            };
            let starts = Instant(r.try_get(2).map_err(|e| pg(&e))?);
            let ends = r
                .try_get::<_, Option<i64>>(3)
                .map_err(|e| pg(&e))?
                .map(Instant);
            let next = Instant(r.try_get(5).map_err(|e| pg(&e))?);
            // The next run is past the order's end: nothing will run, so there is nothing to remind of.
            let Some(n) = occurrence_at(starts, cadence, ends, next) else {
                continue;
            };
            ids.push(r.try_get::<_, String>(0).map_err(|e| pg(&e))?);
            ns.push(i32::try_from(n).map_err(|e| Refusal::Other(e.to_string()))?);
            users.push(r.try_get::<_, String>(1).map_err(|e| pg(&e))?);
            ats.push(next.0);
            leads.push(r.try_get::<_, i32>(6).map_err(|e| pg(&e))?);
        }
        if ids.is_empty() {
            return Ok(0);
        }
        let inserted = c
            .execute(
                "INSERT INTO bank.scheduled_notices (schedule_id, occurrence, kind, user_id, due_at, lead_hours) \
                 SELECT w.schedule_id::uuid, w.occurrence, 'reminder', w.user_id, \
                        timestamptz 'epoch' + w.due_ms * interval '1 millisecond', w.lead_hours \
                   FROM unnest($1::text[], $2::int4[], $3::text[], $4::int8[], $5::int4[]) \
                        AS w(schedule_id, occurrence, user_id, due_ms, lead_hours) \
                 ON CONFLICT (schedule_id, occurrence, kind) DO NOTHING",
                &[&ids, &ns, &users, &ats, &leads],
            )
            .map_err(|e| pg(&e))?;
        Ok(count(inserted))
    })
}

fn owe_failures(d: &Deps<'_>, limit: i64, now: Instant) -> Result<i64, Refusal> {
    let since = now.0 - FAILURE_NOTICE_LOOKBACK_MS;
    with(d.store(), |c| {
        let inserted = c
            .execute(
                &format!(
                    "INSERT INTO bank.scheduled_notices (schedule_id, occurrence, kind, user_id, due_at, reason_code) \
                     SELECT e.schedule_id, e.occurrence, 'failed', s.user_id, e.attempted_at, e.rejection_code \
                       FROM bank.transfer_executions e \
                       JOIN bank.scheduled_transfers s ON s.id = e.schedule_id \
                      WHERE e.status = 'rejected' AND e.rejection_code IS NOT NULL \
                        AND e.attempted_at >= {} \
                        AND NOT EXISTS ( \
                          SELECT 1 FROM bank.scheduled_notices n \
                           WHERE n.schedule_id = e.schedule_id AND n.occurrence = e.occurrence AND n.kind = 'failed' \
                        ) \
                      ORDER BY e.attempted_at \
                      LIMIT $2 \
                     ON CONFLICT (schedule_id, occurrence, kind) DO NOTHING",
                    at("$1")
                ),
                &[&since, &limit],
            )
            .map_err(|e| pg(&e))?;
        Ok(count(inserted))
    })
}

/// One claimed row and what it says.
struct Owed {
    id: String,
    schedule_id: String,
    occurrence: i64,
    kind: String,
    user_id: String,
    due_at: Instant,
    lead_hours: Option<i64>,
    reason_code: Option<String>,
    asset_id: String,
    amount: String,
}

fn log(event: &str, fields: Vec<(&str, Json)>) {
    let mut f = vec![
        ("level".to_owned(), Json::str("error")),
        ("service".to_owned(), Json::str("svc-bank")),
        ("event".to_owned(), Json::str(event)),
    ];
    f.extend(fields.into_iter().map(|(k, v)| (k.to_owned(), v)));
    eprintln!("{}", Json::Object(f).compact());
}

/// `eventScheduledNotices`: one notice on the bus under `bank.scheduled_<kind>:<schedule>:<occurrence>`.
fn publish(d: &Deps<'_>, row: &Owed) -> Result<(), String> {
    let amount = format_amount(parse_amount(&row.amount)?);
    let notices = d.t.notices();
    let common = is_guid(&row.id)
        && is_guid(&row.user_id)
        && is_guid(&row.schedule_id)
        && row.occurrence >= 0
        && amount_ok(&amount)
        && asset_ok(&row.asset_id);
    if row.kind == "reminder" {
        let lead = row.lead_hours.unwrap_or(0);
        notices.publish(
            "bankScheduledReminder",
            "intafaced.bank.scheduled_reminder.triggered",
            &format!(
                "bank.scheduled_reminder:{}:{}",
                row.schedule_id, row.occurrence
            ),
            Json::obj([
                ("noticeId", Json::str(row.id.clone())),
                ("userId", Json::str(row.user_id.clone())),
                ("scheduleId", Json::str(row.schedule_id.clone())),
                ("occurrence", Json::int(row.occurrence)),
                ("dueAt", Json::str(row.due_at.iso())),
                ("amount", Json::str(amount)),
                ("assetId", Json::str(row.asset_id.clone())),
                ("leadHours", Json::int(lead)),
            ]),
            common && lead >= 1,
        )
    } else {
        let reason = row.reason_code.clone().unwrap_or_default();
        let reason_ok = (1..=64).contains(&reason.encode_utf16().count());
        notices.publish(
            "bankScheduledFailed",
            "intafaced.bank.scheduled_run.failed",
            &format!(
                "bank.scheduled_failed:{}:{}",
                row.schedule_id, row.occurrence
            ),
            Json::obj([
                ("noticeId", Json::str(row.id.clone())),
                ("userId", Json::str(row.user_id.clone())),
                ("scheduleId", Json::str(row.schedule_id.clone())),
                ("occurrence", Json::int(row.occurrence)),
                ("amount", Json::str(amount)),
                ("assetId", Json::str(row.asset_id.clone())),
                ("reasonCode", Json::str(reason)),
                ("failedAt", Json::str(row.due_at.iso())),
            ]),
            common && reason_ok,
        )
    }
}

/// `announceOwed`: publish owed notices. This pass first claims the rows it will publish (a row another pass holds is
/// skipped). A reminder whose run will no longer happen as it said is dropped, not sent. A row is marked announced only
/// after the bus took it; the first publish that fails ends the pass, its row counts one more attempt and goes to the
/// back of the queue, and everything not yet published stays owed for the next pass. With no bus wired, every row stays
/// owed and the job says so.
fn announce_owed(d: &Deps<'_>, limit: i64, now: Instant) -> Result<(i64, i64), Refusal> {
    if !d.w.rules.notices {
        let owed = with(d.store(), owed_count)?;
        if owed == 0 {
            return Ok((0, 0));
        }
        return Err(refuse(
            "bank.scheduled_notify_unwired",
            "svc-notify is not wired for standing-order notices, so owed reminders and failures stay owed (bank.scheduled_notify_unwired)",
        ));
    }
    let dropped = with(d.store(), |c| {
        c.execute(
            &format!(
                "UPDATE bank.scheduled_notices n SET dropped_at = {now} \
                   FROM bank.scheduled_transfers s \
                  WHERE s.id = n.schedule_id AND n.kind = 'reminder' AND n.announced_at IS NULL AND n.dropped_at IS NULL \
                    AND (s.status <> 'active' OR s.next_run_at <> n.due_at OR n.due_at <= {now})",
                now = at("$1")
            ),
            &[&now.0],
        )
        .map_err(|e| pg(&e))
    })?;
    let claim_for = now.0 + CLAIM_MS;
    let rows = in_tx(d.store(), |tx| {
        let rows = tx
            .query(
                &format!(
                    "WITH claimed AS ( \
                       UPDATE bank.scheduled_notices SET claimed_until = {claim} \
                        WHERE id IN ( \
                          SELECT id FROM bank.scheduled_notices \
                           WHERE announced_at IS NULL AND dropped_at IS NULL AND (claimed_until IS NULL OR claimed_until < {now}) \
                           ORDER BY attempts, created_at, due_at, id \
                           LIMIT $3 \
                           FOR UPDATE SKIP LOCKED \
                        ) \
                       RETURNING id, schedule_id, occurrence, kind, user_id, due_at, lead_hours, reason_code, attempts, created_at \
                     ) \
                     SELECT c.id::text, c.schedule_id::text, c.occurrence, c.kind, c.user_id, \
                            floor(extract(epoch from c.due_at) * 1000)::int8, c.lead_hours, c.reason_code, \
                            s.asset_id, COALESCE(e.amount, s.amount)::text \
                       FROM claimed c \
                       JOIN bank.scheduled_transfers s ON s.id = c.schedule_id \
                       LEFT JOIN bank.transfer_executions e \
                         ON c.kind = 'failed' AND e.schedule_id = c.schedule_id AND e.occurrence = c.occurrence \
                      ORDER BY c.attempts, c.created_at, c.due_at, c.id",
                    claim = at("$1"),
                    now = at("$2")
                ),
                &[&claim_for, &now.0, &limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| -> Result<Owed, Refusal> {
                let g = |e: postgres::Error| pg(&e);
                Ok(Owed {
                    id: r.try_get(0).map_err(g)?,
                    schedule_id: r.try_get(1).map_err(g)?,
                    occurrence: i64::from(r.try_get::<_, i32>(2).map_err(g)?),
                    kind: r.try_get(3).map_err(g)?,
                    user_id: r.try_get(4).map_err(g)?,
                    due_at: Instant(r.try_get(5).map_err(g)?),
                    lead_hours: r.try_get::<_, Option<i32>>(6).map_err(g)?.map(i64::from),
                    reason_code: r.try_get(7).map_err(g)?,
                    asset_id: r.try_get(8).map_err(g)?,
                    amount: r.try_get(9).map_err(g)?,
                })
            })
            .collect::<Result<Vec<_>, _>>()
    })?;
    let mut announced = 0;
    for (index, row) in rows.iter().enumerate() {
        match publish(d, row) {
            Ok(()) => {
                let marked = with(d.store(), |c| {
                    c.execute(
                        "UPDATE bank.scheduled_notices SET announced_at = now(), claimed_until = NULL \
                          WHERE id = $1::text::uuid AND announced_at IS NULL",
                        &[&row.id],
                    )
                    .map_err(|e| pg(&e))
                })?;
                announced += count(marked);
            }
            Err(detail) => {
                log(
                    "bank.scheduled_notice_failed",
                    vec![
                        ("noticeId", Json::str(row.id.clone())),
                        ("detail", Json::str(detail)),
                    ],
                );
                // The bus is likely down: stop here rather than wait out a timeout for every row. The failed row goes
                // to the back; the rest are released for the next pass.
                let rest: Vec<String> = rows.iter().skip(index + 1).map(|r| r.id.clone()).collect();
                with(d.store(), |c| {
                    c.execute(
                        "UPDATE bank.scheduled_notices SET attempts = attempts + 1, claimed_until = NULL \
                          WHERE id = $1::text::uuid",
                        &[&row.id],
                    )
                    .map_err(|e| pg(&e))?;
                    if !rest.is_empty() {
                        c.execute(
                            "UPDATE bank.scheduled_notices SET claimed_until = NULL WHERE id = ANY($1::text[]::uuid[])",
                            &[&rest],
                        )
                        .map_err(|e| pg(&e))?;
                    }
                    Ok(())
                })?;
                break;
            }
        }
    }
    Ok((announced, count(dropped)))
}

/// `scheduledNoticesBody`: `{ limit }`, a whole number 1 to 1000, nothing else (`req.body ?? {}`).
pub fn notices_body(body: &Value) -> Option<i64> {
    let empty = Vec::new();
    let fields = match body {
        Value::Undefined | Value::Null => &empty,
        Value::Object(f) => f,
        _ => return None,
    };
    let mut limit = None;
    for (k, v) in fields {
        match (k.as_str(), v) {
            ("limit", Value::Number(n)) if n.fract() == 0.0 && (1.0..=1000.0).contains(n) => {
                #[allow(clippy::cast_possible_truncation, reason = "a whole number 1 to 1000")]
                let whole = *n as i64;
                limit = Some(whole);
            }
            _ => return None,
        }
    }
    limit
}

fn principal_user<'c>(ctx: &'c Ctx<'_>) -> Result<&'c str, Refusal> {
    ctx.principal
        .map(|p| p.user_id.as_str())
        .ok_or_else(|| Refusal::Other("no principal".to_owned()))
}

/// This part's calls; `None` for any other call.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let call = ctx.call.path.strip_prefix("rules.")?;
    let input = &ctx.input;
    Some(match call {
        "get" => principal_user(ctx).and_then(|user| {
            Ok(Json::obj([
                (
                    "reminder",
                    reminder_rule(d, user)?.map_or(Json::Null, |r| r.json()),
                ),
                (
                    "leadChoices",
                    Json::Array(REMINDER_LEAD_HOURS.iter().map(|n| Json::int(*n)).collect()),
                ),
                (
                    "moneyRules",
                    Json::obj([
                        ("state", Json::str("not_set")),
                        ("code", Json::str(RULE_TERMS_UNSET)),
                    ]),
                ),
            ]))
        }),
        "setReminder" => principal_user(ctx).and_then(|user| {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "whole numbers the schema checked"
            )]
            let lead = input.get("leadHours").as_number().map(|n| n as i64);
            #[allow(
                clippy::cast_possible_truncation,
                reason = "a whole number the schema checked"
            )]
            let expected = input
                .get("expectedRevision")
                .as_number()
                .map_or(0, |n| n as i64);
            set_reminder_rule(
                d,
                &SetReminder {
                    user_id: user,
                    lead_hours: lead,
                    expected_revision: expected,
                    client_request_id: input.get("clientRequestId").as_str().unwrap_or_default(),
                },
            )
            .map(|r| r.json())
        }),
        "createMoneyRule" => Err(create_money_rule()),
        _ => return None,
    })
}

/// This part's job door past the signature (`jobDoor`): the body, then one pass; a `BankError` is 400.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    if path != RUN_SCHEDULED_NOTICES {
        return None;
    }
    let Some(limit) = notices_body(body) else {
        return Some(reply(400, "body not in shape", "bank.validation_failed"));
    };
    Some(match run(d, limit, d.now()) {
        Ok(pass) => ok(&pass.json()),
        Err(r) => job_failed(r),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::json;

    fn body(s: &str) -> Value {
        Value::from_json(&json::parse(s).unwrap())
    }

    #[test]
    fn the_job_body_is_a_limit_from_1_to_1000_and_nothing_else() {
        assert_eq!(notices_body(&body(r#"{"limit":10}"#)), Some(10));
        assert_eq!(notices_body(&body(r#"{"limit":1000}"#)), Some(1000));
        assert_eq!(notices_body(&body("{}")), None);
        assert_eq!(notices_body(&Value::Undefined), None);
        assert_eq!(notices_body(&body(r#"{"limit":0}"#)), None);
        assert_eq!(notices_body(&body(r#"{"limit":1.5}"#)), None);
        assert_eq!(notices_body(&body(r#"{"limit":10,"x":1}"#)), None);
        assert_eq!(notices_body(&body(r#"{"limit":"10"}"#)), None);
    }

    #[test]
    fn the_occurrence_on_the_next_run_is_named_and_none_past_the_end() {
        let start = service_kit::time::js_date("2026-11-10T19:00:00.000Z").unwrap();
        let week = Instant(start.0 + 7 * 86_400_000);
        assert_eq!(occurrence_at(start, Cadence::Weekly, None, start), Some(0));
        assert_eq!(occurrence_at(start, Cadence::Weekly, None, week), Some(1));
        assert_eq!(
            occurrence_at(start, Cadence::Weekly, Some(week), week),
            None
        );
        assert_eq!(occurrence_at(start, Cadence::Once, None, week), None);
    }
}
