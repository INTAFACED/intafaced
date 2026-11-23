//! How a published certificate is issued (`certs/issue-rules.ts`, AC-certificates-02): `manual` (the learner claims it;
//! no rule row reads the same), `automatic` (issued when the last requirement is recorded) or `delayed` (issued the
//! owner's delay after that). Each change is a new revision with a history row naming the operator and the reason. A
//! delayed certificate waits as one pending row per learner and certificate, written once, so a later read never moves
//! its due time. This module stores rules and waits and decides nothing about completeness. No money moves here.

use postgres::{GenericClient, IsolationLevel};

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::js_trim;

use super::sql::{self, cell, exec, iso, lock_extended, ms, q};
use crate::db;
use crate::errors::{AcademyError, Refusal};

/// `AcademyCertIssueRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub cert_id: String,
    pub mode: String,
    pub delay_minutes: Option<i64>,
    pub revision: i64,
    /// Epoch milliseconds.
    pub updated_at: i64,
}

impl Rule {
    /// `academyCertIssueRuleSchema`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("certId", Json::str(self.cert_id.clone())),
            ("mode", Json::str(self.mode.clone())),
            (
                "delayMinutes",
                self.delay_minutes.map_or(Json::Null, Json::int),
            ),
            ("revision", Json::int(self.revision)),
            ("updatedAt", Json::str(iso(self.updated_at))),
        ])
    }
}

fn rule_of(r: &postgres::Row) -> Result<Rule, Refusal> {
    Ok(Rule {
        cert_id: cell(r, 0)?,
        mode: cell(r, 1)?,
        delay_minutes: cell::<Option<i32>>(r, 2)?.map(sql::int),
        revision: sql::int(cell(r, 3)?),
        updated_at: cell(r, 4)?,
    })
}

/// `issueDueAt`: the delay counted from when the learner first stood complete.
pub fn issue_due_at(complete_at: i64, delay_minutes: i64) -> i64 {
    complete_at + delay_minutes * 60_000
}

/// `decideIssueRule`: the stored shape of a rule request; a delayed rule with no delay refuses.
pub fn decide(mode: &str, delay_minutes: Option<i64>) -> Result<(String, Option<i64>), Refusal> {
    if mode == "delayed" {
        let Some(d) = delay_minutes else {
            return Err(
                AcademyError::new("academy.cert_delay_unset", "academy.cert_delay_unset").into(),
            );
        };
        return Ok(("delayed".to_owned(), Some(d)));
    }
    if delay_minutes.is_some() {
        return Err(
            AcademyError::new("only a delayed rule has a delay", "academy.cert_invalid").into(),
        );
    }
    Ok((mode.to_owned(), None))
}

fn rule_sql() -> String {
    format!(
        "SELECT cert_id, mode, delay_minutes, revision, {} FROM academy.cert_issue_rules WHERE cert_id = $1",
        ms("updated_at")
    )
}

/// `rule(certId)`: the stored rule, or none when staff have set none.
pub fn rule<C: GenericClient>(c: &mut C, cert_id: &str) -> Result<Option<Rule>, Refusal> {
    q(c, &rule_sql(), &[&cert_id])?
        .first()
        .map(rule_of)
        .transpose()
}

/// What `setRule` is asked.
pub struct SetRule<'a> {
    pub cert_id: &'a str,
    pub mode: &'a str,
    pub delay_minutes: Option<i64>,
    pub reason: &'a str,
    pub operator_id: &'a str,
    pub now: i64,
    pub sweep_running: bool,
}

/// `setRule`: a new revision and its history row in one serializable transaction; a request matching the stored rule
/// answers it unchanged. Pending waits keep their due times.
pub fn set_rule(pool: &Pool, input: &SetRule<'_>) -> Result<Rule, Refusal> {
    let (mode, delay) = decide(input.mode, input.delay_minutes)?;
    if mode == "delayed" && !input.sweep_running {
        return Err(
            AcademyError::new("academy.cert_sweep_unset", "academy.cert_sweep_unset").into(),
        );
    }
    let delay32 = delay.map(|d| i32::try_from(d).unwrap_or(i32::MAX));
    db::transaction_retrying(pool, IsolationLevel::Serializable, |tx| {
        lock_extended(tx, &format!("cert-issue-rule:{}", input.cert_id))?;
        let current = rule(tx, input.cert_id)?;
        if let Some(c) = &current
            && c.mode == mode
            && c.delay_minutes == delay
        {
            return Ok(c.clone());
        }
        let revision =
            i32::try_from(current.as_ref().map_or(0, |c| c.revision) + 1).unwrap_or(i32::MAX);
        let now = iso(input.now);
        let rows = q(
            tx,
            &format!(
                "INSERT INTO academy.cert_issue_rules (cert_id, mode, delay_minutes, revision, updated_by, updated_at) \
                 VALUES ($1, $2, $3, $4, $5::text::uuid, $6::text::timestamptz) \
                 ON CONFLICT (cert_id) DO UPDATE SET \
                   mode = EXCLUDED.mode, delay_minutes = EXCLUDED.delay_minutes, revision = EXCLUDED.revision, \
                   updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at \
                 RETURNING cert_id, mode, delay_minutes, revision, {}",
                ms("updated_at")
            ),
            &[
                &input.cert_id,
                &mode,
                &delay32,
                &revision,
                &input.operator_id,
                &now,
            ],
        )?;
        exec(
            tx,
            "INSERT INTO academy.cert_issue_rule_events (cert_id, revision, mode, delay_minutes, actor, reason, at) \
             VALUES ($1, $2, $3, $4, $5::text::uuid, $6, $7::text::timestamptz)",
            &[
                &input.cert_id,
                &revision,
                &mode,
                &delay32,
                &input.operator_id,
                &js_trim(input.reason),
                &now,
            ],
        )?;
        rows.first()
            .map(rule_of)
            .transpose()?
            .ok_or_else(|| Refusal::db("the rule insert returned no row", None))
    })
}

/// `pending(userId, certId)`: the due time of the learner's wait, or none.
pub fn pending<C: GenericClient>(
    c: &mut C,
    user_id: &str,
    cert_id: &str,
) -> Result<Option<i64>, Refusal> {
    q(
        c,
        &format!(
            "SELECT {} FROM academy.cert_issue_pending WHERE user_id = $1::text::uuid AND cert_id = $2",
            ms("due_at")
        ),
        &[&user_id, &cert_id],
    )?
    .first()
    .map(|r| cell(r, 0))
    .transpose()
}

/// `ensurePending`: records the wait once; an existing row keeps its due time, which is answered.
pub fn ensure_pending<C: GenericClient>(
    c: &mut C,
    user_id: &str,
    cert_id: &str,
    due_at: i64,
    now: i64,
) -> Result<i64, Refusal> {
    exec(
        c,
        "INSERT INTO academy.cert_issue_pending (user_id, cert_id, due_at, created_at) \
         VALUES ($1::text::uuid, $2, $3::text::timestamptz, $4::text::timestamptz) \
         ON CONFLICT (user_id, cert_id) DO NOTHING",
        &[&user_id, &cert_id, &iso(due_at), &iso(now)],
    )?;
    Ok(pending(c, user_id, cert_id)?.unwrap_or(due_at))
}

/// `dropPending`.
pub fn drop_pending<C: GenericClient>(
    c: &mut C,
    user_id: &str,
    cert_id: &str,
) -> Result<(), Refusal> {
    exec(
        c,
        "DELETE FROM academy.cert_issue_pending WHERE user_id = $1::text::uuid AND cert_id = $2",
        &[&user_id, &cert_id],
    )
    .map(|_| ())
}

/// `due(now, batch)`: waits due by `now`, oldest first, one batch of the sweep.
pub fn due<C: GenericClient>(
    c: &mut C,
    now: i64,
    batch: i64,
) -> Result<Vec<(String, String)>, Refusal> {
    q(
        c,
        "SELECT user_id::text, cert_id FROM academy.cert_issue_pending WHERE due_at <= $1::text::timestamptz \
         ORDER BY due_at, user_id, cert_id LIMIT $2",
        &[&iso(now), &batch],
    )?
    .iter()
    .map(|r| Ok((cell(r, 0)?, cell(r, 1)?)))
    .collect()
}
