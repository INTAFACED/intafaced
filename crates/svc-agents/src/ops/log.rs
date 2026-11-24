//! The operator's agent action log (`oplog/routes.ts`, AG-audit-01, AG-audit-02): one customer's agent actions as the
//! service recorded them, read by a signed-in operator for a reason picked from the owner's list. Every read, export
//! and transcript open writes one `agent_log_reads` row in the same transaction as the read, on its business key, so
//! there is no read without its audit row and a retried request writes no second one. The list never carries prompt
//! or answer text; only a transcript open does, while the owner's retention keeps it, with its sha256 computed here.
//!
//! [`purge_expired_transcripts`] is the hourly transcript purge.

use postgres::{GenericClient, IsolationLevel};
use sha2::{Digest, Sha256};

use service_kit::json::Json;
use service_kit::pg::Pool;

use crate::db::{self, Store, StoreError};
use crate::door::Ctx;
use crate::ops::{Ops, OpsError, iso, operator, pool};
use crate::runtime::ms;

/// How long a retried request may reuse its audit row; past it the request id is refused.
const RETRY_WINDOW_MINUTES: i32 = 5;
/// Longest tool name the filter lists; most names it lists.
const TOOL_MAX: i64 = 120;
const TOOLS_LISTED: i64 = 200;

/// `logReadKey`: one read's business key.
pub fn log_read_key(kind: &str, operator_id: &str, request_id: &str) -> String {
    format!("agents:logread:{kind}:{operator_id}:{request_id}")
}

/// `assertReason`: the reason against the owner's list, before anything is read.
fn assert_reason(ops: &Ops, reason: Option<&str>) -> Result<String, OpsError> {
    let Some(reasons) = &ops.reasons else {
        return Err(OpsError::Refused("agents.log_read_reason_unset"));
    };
    let picked = service_kit::schema::js_trim(reason.unwrap_or(""));
    if picked.is_empty() {
        return Err(OpsError::Refused("agents.log_read_reason_required"));
    }
    if !reasons.iter().any(|r| r == picked) {
        return Err(OpsError::Refused("agents.log_read_reason_unknown"));
    }
    Ok(picked.to_owned())
}

fn assert_limit(ops: &Ops) -> Result<i64, OpsError> {
    ops.actions_limit
        .ok_or(OpsError::Refused("agents.ops_actions_limit_unset"))
}

/// `readTransaction`: read committed, up to five attempts.
fn read_transaction<T>(
    p: &Pool,
    f: impl FnMut(&mut postgres::Transaction<'_>) -> Result<T, OpsError>,
) -> Result<T, OpsError> {
    db::transaction_retrying(p, IsolationLevel::ReadCommitted, 5, f)
}

/// One read to audit.
struct Read<'a> {
    kind: &'a str,
    operator_id: &'a str,
    request_id: &'a str,
    subject_id: &'a str,
    reason: &'a str,
    filter: &'a Json,
    action_id: Option<&'a str>,
    row_count: i64,
}

/// `recordRead`: the audit row once per key, then how many rows carry the key and how many reads of this customer's
/// log there are, this one included. A key already written for another customer, reason, filter or action, or more
/// than five minutes ago, is refused.
fn record_read(tx: &mut impl GenericClient, read: &Read<'_>) -> Result<(i64, i64), OpsError> {
    let key = log_read_key(read.kind, read.operator_id, read.request_id);
    let filter = read.filter.compact();
    let rows = i32::try_from(read.row_count).unwrap_or(i32::MAX);
    tx.execute(
        "INSERT INTO agents.agent_log_reads (business_key, operator_id, subject_id, kind, reason, filter, action_id, row_count)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text::jsonb, $7::text::uuid, $8::int)
         ON CONFLICT (business_key) DO NOTHING",
        &[&key, &read.operator_id, &read.subject_id, &read.kind, &read.reason, &filter, &read.action_id, &rows],
    )?;
    let r = tx.query_one(
        "SELECT count(*)::bigint,
                coalesce(bool_and(read_at > now() - make_interval(mins => $2::int)
                                  AND subject_id = $3::text AND reason = $4::text
                                  AND action_id IS NOT DISTINCT FROM $5::text::uuid
                                  AND filter = $6::text::jsonb), true)
           FROM agents.agent_log_reads WHERE business_key = $1::text",
        &[
            &key,
            &RETRY_WINDOW_MINUTES,
            &read.subject_id,
            &read.reason,
            &read.action_id,
            &filter,
        ],
    )?;
    let (audit_rows, same): (i64, bool) = (r.try_get(0)?, r.try_get(1)?);
    if !same {
        return Err(OpsError::Refused("agents.log_read_request_reused"));
    }
    let all: i64 = tx
        .query_one(
            "SELECT count(*)::bigint FROM agents.agent_log_reads WHERE subject_id = $1::text",
            &[&read.subject_id],
        )?
        .try_get(0)?;
    Ok((audit_rows, all))
}

/// One row as the list shows it (`actionView`).
pub struct ActionView {
    pub id: String,
    pub occurred_at: String,
    pub kind: String,
    pub tool: String,
    pub outcome: String,
    pub refusal_code: Option<String>,
    pub input_digest: Option<String>,
}

impl ActionView {
    fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::String);
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("occurredAt", Json::str(self.occurred_at.clone())),
            ("kind", Json::str(self.kind.clone())),
            ("tool", Json::str(self.tool.clone())),
            ("outcome", Json::str(self.outcome.clone())),
            ("refusalCode", opt(&self.refusal_code)),
            ("inputDigest", opt(&self.input_digest)),
        ])
    }
}

/// `readActions`: one customer's actions under the filter, newest first, at most `limit`, and whether there are more.
fn read_actions(
    tx: &mut impl GenericClient,
    user_id: &str,
    outcome: Option<&str>,
    tool: Option<&str>,
    limit: i64,
) -> Result<(Vec<ActionView>, bool), OpsError> {
    let rows = tx.query(
        &format!(
            "SELECT id::text, {}, kind::text, coalesce(tool, task, ''), status::text, refusal_code, input_digest
               FROM agents.agent_actions
              WHERE user_id = $1::text
                AND ($2::text IS NULL OR status::text = $2::text)
                AND ($3::text IS NULL OR coalesce(tool, task) = $3::text)
              ORDER BY occurred_at DESC, id DESC
              LIMIT $4::bigint",
            ms("occurred_at")
        ),
        &[&user_id, &outcome, &tool, &(limit + 1)],
    )?;
    let more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    let mut out = Vec::new();
    for r in rows.iter().take(usize::try_from(limit).unwrap_or(0)) {
        out.push(ActionView {
            id: r.try_get(0)?,
            occurred_at: service_kit::time::Instant(r.try_get(1)?).iso(),
            kind: r.try_get(2)?,
            tool: r.try_get(3)?,
            outcome: r.try_get(4)?,
            refusal_code: r.try_get(5)?,
            input_digest: r.try_get(6)?,
        });
    }
    Ok((out, more))
}

/// A cell a spreadsheet would run as a formula is read as text; a cell with a quote, comma or line break is quoted.
fn csv_cell(raw: &str) -> String {
    let value = if raw.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{raw}")
    } else {
        raw.to_owned()
    };
    if value.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

/// `actionsCsv`: a header, then one line per row in the order shown; no prompt or answer text.
pub fn actions_csv(rows: &[ActionView]) -> String {
    let mut lines = vec!["Time,Tool,Outcome,Refusal code,Input digest,Action id".to_owned()];
    for row in rows {
        let word = match row.outcome.as_str() {
            "executed" => "Executed",
            "refused" => "Refused",
            _ => "Failed",
        };
        lines.push(
            [
                row.occurred_at.as_str(),
                row.tool.as_str(),
                word,
                row.refusal_code.as_deref().unwrap_or(""),
                row.input_digest.as_deref().unwrap_or(""),
                row.id.as_str(),
            ]
            .iter()
            .map(|c| csv_cell(c))
            .collect::<Vec<_>>()
            .join(","),
        );
    }
    format!("{}\n", lines.join("\n"))
}

/// `filterOf`: the outcome and the tool, when given.
fn filter_of(outcome: Option<&str>, tool: Option<&str>) -> Json {
    let mut fields = Vec::new();
    if let Some(o) = outcome.filter(|o| !o.is_empty()) {
        fields.push(("outcome".to_owned(), Json::str(o)));
    }
    if let Some(t) = tool.filter(|t| !t.is_empty()) {
        fields.push(("tool".to_owned(), Json::str(t)));
    }
    Json::Object(fields)
}

/// Answers one `opsLog.*` call.
pub fn handle(call: &str, ctx: &Ctx<'_>, store: &Store, ops: &Ops) -> Result<Json, OpsError> {
    let input = |k: &str| ctx.input.get(k).as_str();
    match call {
        "reasons" => {
            let reasons = ops
                .reasons
                .as_ref()
                .ok_or(OpsError::Refused("agents.log_read_reason_unset"))?;
            Ok(Json::obj([(
                "reasons",
                Json::Array(reasons.iter().map(|r| Json::str(r.clone())).collect()),
            )]))
        }
        "actions" | "export" => {
            let reason = assert_reason(ops, input("reason"))?;
            let limit = assert_limit(ops)?;
            let p = pool(store)?;
            let user_id = input("userId").unwrap_or("");
            let (outcome, tool) = (input("outcome"), input("tool"));
            let filter = filter_of(outcome, tool);
            let request_id = input("requestId").unwrap_or("");
            let export = call == "export";
            read_transaction(p, |tx| {
                let (rows, more) = read_actions(tx, user_id, outcome, tool, limit)?;
                let tools = if export {
                    Vec::new()
                } else {
                    tx.query(
                        "SELECT DISTINCT coalesce(tool, task) AS tool FROM agents.agent_actions
                          WHERE user_id = $1::text AND length(coalesce(tool, task)) BETWEEN 1 AND $2::bigint
                          ORDER BY 1
                          LIMIT $3::bigint",
                        &[&user_id, &TOOL_MAX, &TOOLS_LISTED],
                    )?
                    .iter()
                    .map(|r| r.try_get::<_, String>(0).map(Json::String))
                    .collect::<Result<Vec<_>, _>>()?
                };
                let (audit_rows, subject_reads) = record_read(
                    tx,
                    &Read {
                        kind: call,
                        operator_id: operator(ctx),
                        request_id,
                        subject_id: user_id,
                        reason: &reason,
                        filter: &filter,
                        action_id: None,
                        row_count: i64::try_from(rows.len()).unwrap_or(i64::MAX),
                    },
                )?;
                Ok(if export {
                    Json::obj([
                        ("csv", Json::str(actions_csv(&rows))),
                        ("rows", Json::int(i64::try_from(rows.len()).unwrap_or(0))),
                        ("more", Json::Bool(more)),
                        ("auditRows", Json::int(audit_rows)),
                        ("subjectReads", Json::int(subject_reads)),
                    ])
                } else {
                    Json::obj([
                        (
                            "items",
                            Json::Array(rows.iter().map(ActionView::json).collect()),
                        ),
                        ("tools", Json::Array(tools)),
                        ("more", Json::Bool(more)),
                        ("limit", Json::int(limit)),
                        ("auditRows", Json::int(audit_rows)),
                        ("subjectReads", Json::int(subject_reads)),
                    ])
                })
            })
        }
        "transcript" => {
            let reason = assert_reason(ops, input("reason"))?;
            let days = ops
                .retention_days
                .ok_or(OpsError::Refused("agents.transcript_retention_unset"))?;
            if days == 0 {
                return Err(OpsError::Refused("agents.transcript_not_kept"));
            }
            let days = i32::try_from(days).unwrap_or(i32::MAX);
            let p = pool(store)?;
            let action_id = input("actionId").unwrap_or("");
            let request_id = input("requestId").unwrap_or("");
            read_transaction(p, |tx| {
                let Some(action) = tx
                    .query(
                        "SELECT user_id, input_digest FROM agents.agent_actions WHERE id = $1::text::uuid",
                        &[&action_id],
                    )?
                    .into_iter()
                    .next()
                else {
                    return Err(OpsError::Refused("agents.action_not_found"));
                };
                let (user_id, input_digest): (String, Option<String>) =
                    (action.try_get(0)?, action.try_get(1)?);
                // Bounded by today's retention too, so a shortened retention hides text kept under a longer one.
                let Some(kept) = tx
                    .query(
                        &format!(
                            "SELECT text, {}, {} FROM agents.agent_transcripts
                              WHERE action_id = $1::text::uuid AND expires_at > now()
                                AND stored_at > now() - make_interval(days => $2::int)",
                            ms("stored_at"),
                            ms("expires_at")
                        ),
                        &[&action_id, &days],
                    )?
                    .into_iter()
                    .next()
                else {
                    return Err(OpsError::Refused("agents.transcript_not_kept"));
                };
                let text: String = kept.try_get(0)?;
                let (audit_rows, subject_reads) = record_read(
                    tx,
                    &Read {
                        kind: "transcript",
                        operator_id: operator(ctx),
                        request_id,
                        subject_id: &user_id,
                        reason: &reason,
                        filter: &Json::Object(Vec::new()),
                        action_id: Some(action_id),
                        row_count: 1,
                    },
                )?;
                let digest: String = Sha256::digest(text.as_bytes())
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                Ok(Json::obj([
                    ("actionId", Json::str(action_id)),
                    ("userId", Json::str(user_id)),
                    ("text", Json::str(text)),
                    ("digest", Json::str(digest)),
                    ("inputDigest", input_digest.map_or(Json::Null, Json::String)),
                    ("storedAt", iso(kept.try_get(1)?)),
                    ("expiresAt", iso(kept.try_get(2)?)),
                    ("auditRows", Json::int(audit_rows)),
                    ("subjectReads", Json::int(subject_reads)),
                ]))
            })
        }
        other => Err(OpsError::Store(StoreError::new(
            format!("svc-agents in Rust: opsLog.{other} is not an opsLog call"),
            None,
        ))),
    }
}

/// `purgeExpiredTranscripts`: every kept transcript past its expiry or older than today's retention; 0 keeps none. A
/// blank retention is not a value and deletes nothing. Returns how many went.
pub fn purge_expired_transcripts(p: &Pool, retention_days: Option<i64>) -> Result<u64, StoreError> {
    let Some(days) = retention_days else {
        return Ok(0);
    };
    let days = i32::try_from(days).unwrap_or(i32::MAX);
    db::with_client(p, |c| {
        Ok(c.execute(
            "DELETE FROM agents.agent_transcripts
              WHERE $1::int = 0 OR expires_at <= now() OR stored_at <= now() - make_interval(days => $1::int)",
            &[&days],
        )?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// runtime.test.ts: "writes a cell a spreadsheet would run as a formula as text in the export".
    #[test]
    fn a_cell_a_spreadsheet_would_run_as_a_formula_is_written_as_text() {
        let row = |tool: &str, code: &str| ActionView {
            id: "a".to_owned(),
            occurred_at: "2026-10-29T00:00:00.000Z".to_owned(),
            kind: "completion".to_owned(),
            tool: tool.to_owned(),
            outcome: "refused".to_owned(),
            refusal_code: Some(code.to_owned()),
            input_digest: None,
        };
        let csv = actions_csv(&[
            row(
                "=HYPERLINK(\"https://example.invalid\",\"x\")",
                "agents.refused.task_not_allowed",
            ),
            row("+1", "@x"),
        ]);
        let lines: Vec<&str> = csv.split('\n').collect();
        assert_eq!(
            lines.get(1..3).unwrap_or_default(),
            [
                "2026-10-29T00:00:00.000Z,\"'=HYPERLINK(\"\"https://example.invalid\"\",\"\"x\"\")\",Refused,agents.refused.task_not_allowed,,a",
                "2026-10-29T00:00:00.000Z,'+1,Refused,'@x,,a",
            ]
        );
    }
}
