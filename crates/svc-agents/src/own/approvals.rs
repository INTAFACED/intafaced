//! Tool calls a rule held for the person, and the decisions on them (`own/guardrails.ts`, `OwnApprovalRequestStore`,
//! AG-approvals-01). One request per `agents:approve:<session>:<request id>`, so a retried call is the same request,
//! never a second one. A request waits until its expiry and then reads expired; a decision on a request that is not
//! waiting refuses with its state's code, so nothing decided is decided again and an expired request is never approved.
//!
//! The tool call and its run hold and approve; the person's calls (`own.approval.*`, `own.inbox`, `own.approvals`,
//! the held calls of `own.runs`) read, reject and edit (`super::runs`).

use postgres::GenericClient;
use postgres::IsolationLevel;
use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::catalog::own_tool;
use super::{OwnError, OwnRefusal};
use crate::db::{self, StoreError};
use crate::runtime::ms;

/// `approvalTtl`: how long a held call waits, in whole seconds (`AGENTS_APPROVAL_TTL_SECONDS`); blank refuses holding
/// any call `agents.approval.ttl_unset`.
pub fn approval_ttl(seconds: Option<i64>) -> Result<i64, OwnRefusal> {
    match seconds {
        Some(s) if s != 0 => Ok(s),
        _ => Err(OwnRefusal::new("agents.approval.ttl_unset")),
    }
}

/// `OwnApprovalRequestView`, with the agent it belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: String,
    pub agent_id: String,
    pub session_id: String,
    pub tool: String,
    /// In the order the database keeps it.
    pub input: Vec<(String, String)>,
    /// As read: a waiting request past its expiry reads `expired`.
    pub status: String,
    pub failure_code: Option<String>,
    pub rule_id: Option<String>,
    pub created_at: Instant,
    pub expires_at: Instant,
    pub decided_at: Option<Instant>,
    pub decided_by: Option<String>,
    pub replaced_by: Option<String>,
    pub result: Json,
    pub ran_at: Option<Instant>,
}

/// `REFUSAL_OF`: the typed refusal each closed state answers the agent's call with.
pub fn refusal_of(status: &str) -> Option<&'static str> {
    match status {
        "rejected" => Some("agents.approval.rejected"),
        "expired" => Some("agents.approval.expired"),
        "replaced" => Some("agents.approval.replaced"),
        "failed" => Some("agents.approval.failed"),
        _ => None,
    }
}

/// `refusalFor`: why a decision on a request in this state is refused.
fn refusal_for(status: &str) -> &'static str {
    if status == "approved" {
        "agents.approval.decided"
    } else {
        refusal_of(status).unwrap_or("agents.approval.not_found")
    }
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}
fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |s| Json::str(s.clone()))
}

impl Request {
    pub fn refusal_code(&self) -> Option<&'static str> {
        refusal_of(&self.status)
    }

    /// `ownAgentApprovalRequestSchema`, in its order.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("sessionId", Json::str(self.session_id.clone())),
            ("tool", Json::str(self.tool.clone())),
            (
                "input",
                Json::Object(
                    self.input
                        .iter()
                        .map(|(k, v)| (k.clone(), Json::str(v.clone())))
                        .collect(),
                ),
            ),
            ("status", Json::str(self.status.clone())),
            (
                "refusalCode",
                self.refusal_code().map_or(Json::Null, Json::str),
            ),
            ("failureCode", opt(self.failure_code.as_ref())),
            ("ruleId", opt(self.rule_id.as_ref())),
            ("createdAt", Json::str(self.created_at.iso())),
            ("expiresAt", Json::str(self.expires_at.iso())),
            ("decidedAt", iso(self.decided_at)),
            ("decidedBy", opt(self.decided_by.as_ref())),
            ("replacedBy", opt(self.replaced_by.as_ref())),
            ("result", self.result.clone()),
            ("ranAt", iso(self.ran_at)),
        ])
    }
}

fn columns() -> String {
    format!(
        "id::text, agent_id::text, session_id::text, tool, input_json::text,
         CASE WHEN status = 'waiting' AND expires_at <= now() THEN 'expired' ELSE status END,
         failure_code, rule_id::text, {}, {}, {}, decided_by, replaced_by::text, result_json::text, {}",
        ms("created_at"),
        ms("expires_at"),
        ms("decided_at"),
        ms("ran_at")
    )
}

fn input_of(text: &str) -> Result<Vec<(String, String)>, StoreError> {
    match json::parse(text).map_err(|e| StoreError::new(e.message, None))? {
        Json::Object(fields) => Ok(fields
            .into_iter()
            .filter_map(|(k, v)| match v {
                Json::String(s) => Some((k, s)),
                _ => None,
            })
            .collect()),
        _ => Err(StoreError::new("a request's input is not an object", None)),
    }
}

fn request_of(r: &postgres::Row) -> Result<Request, StoreError> {
    let result: Option<String> = r.try_get(13)?;
    Ok(Request {
        id: r.try_get(0)?,
        agent_id: r.try_get(1)?,
        session_id: r.try_get(2)?,
        tool: r.try_get(3)?,
        input: input_of(&r.try_get::<_, String>(4)?)?,
        status: r.try_get(5)?,
        failure_code: r.try_get(6)?,
        rule_id: r.try_get(7)?,
        created_at: Instant(r.try_get(8)?),
        expires_at: Instant(r.try_get(9)?),
        decided_at: r.try_get::<_, Option<i64>>(10)?.map(Instant),
        decided_by: r.try_get(11)?,
        replaced_by: r.try_get(12)?,
        result: match result {
            None => Json::Null,
            Some(t) => json::parse(&t).map_err(|e| StoreError::new(e.message, None))?,
        },
        ran_at: r.try_get::<_, Option<i64>>(14)?.map(Instant),
    })
}

fn first(rows: &[postgres::Row]) -> Result<Option<Request>, StoreError> {
    rows.first().map(request_of).transpose()
}

/// `sameInput`: the same fields with the same values, whatever their order.
pub fn same_input(a: &[(String, String)], b: &[(String, String)]) -> bool {
    let sorted = |x: &[(String, String)]| {
        let mut v = x.to_vec();
        v.sort();
        v
    };
    sorted(a) == sorted(b)
}

/// `dataClassOf`.
pub fn data_class_of(tool: &str) -> Result<&'static str, OwnRefusal> {
    own_tool(tool)
        .and_then(|t| t.data_class)
        .ok_or_else(|| OwnRefusal::with("agents.tool_not_declared", [("tool", tool.to_owned())]))
}

fn as_json(args: &[(String, String)]) -> String {
    Json::Object(
        args.iter()
            .map(|(k, v)| (k.clone(), Json::str(v.clone())))
            .collect(),
    )
    .compact()
}

/// What one held call is.
pub struct Hold<'a> {
    pub owner_id: &'a str,
    pub agent_id: &'a str,
    pub session_id: &'a str,
    pub request_id: &'a str,
    pub tool: &'a str,
    pub args: &'a [(String, String)],
    pub rule_id: Option<&'a str>,
    pub ttl_seconds: i64,
    /// False when the automatic reviewer decides it: stored as already announced.
    pub notify_person: bool,
}

/// The business key of a call's request.
pub fn request_key(session_id: &str, request_id: &str) -> String {
    format!("agents:approve:{session_id}:{request_id}")
}

/// `hold`: the request, once per key; the same key for another tool or input refuses `agents.request_id_replay`.
pub fn hold(pool: &Pool, h: &Hold<'_>) -> Result<Request, OwnError> {
    let key = request_key(h.session_id, h.request_id);
    let input = as_json(h.args);
    let inserted = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "INSERT INTO agents.own_agent_approval_requests
                   (agent_id, owner_id, session_id, tool, input_json, rule_id, request_key, expires_at, published_at)
                 VALUES ($1::text::uuid, $2::text, $3::text::uuid, $4::text, $5::text::jsonb, $6::text::uuid, $7::text,
                         now() + make_interval(secs => $8::bigint), CASE WHEN $9 THEN NULL ELSE now() END)
                 ON CONFLICT (owner_id, request_key) DO NOTHING
                 RETURNING {}",
                columns()
            ),
            &[
                &h.agent_id,
                &h.owner_id,
                &h.session_id,
                &h.tool,
                &input,
                &h.rule_id,
                &key,
                &h.ttl_seconds,
                &h.notify_person,
            ],
        )?)
    })?;
    if let Some(r) = first(&inserted)? {
        return Ok(r);
    }
    match by_key(pool, h.owner_id, &key)? {
        Some(row) if row.tool == h.tool && same_input(&row.input, h.args) => Ok(row),
        _ => Err(OwnRefusal::new("agents.request_id_replay").into()),
    }
}

fn by_key(pool: &Pool, owner_id: &str, key: &str) -> Result<Option<Request>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_approval_requests WHERE owner_id = $1::text AND request_key = $2::text",
                columns()
            ),
            &[&owner_id, &key],
        )?)
    })?;
    Ok(first(&rows)?)
}

fn get_on(c: &mut impl GenericClient, owner_id: &str, id: &str) -> Result<Request, OwnError> {
    let rows = c.query(
        &format!(
            "SELECT {} FROM agents.own_agent_approval_requests WHERE owner_id = $1::text AND id = $2::text::uuid",
            columns()
        ),
        &[&owner_id, &id],
    )?;
    first(&rows)?.ok_or_else(|| OwnRefusal::new("agents.approval.not_found").into())
}

/// `get`: one request of the person's, as it reads now; another person's, or none, refuses as not found.
pub fn get(pool: &Pool, owner_id: &str, id: &str) -> Result<Request, OwnError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let c = conn.client().map_err(StoreError::from)?;
    get_on(c, owner_id, id)
}

/// `find`: the request a call's key already holds, with its class; the same key for another call refuses
/// `agents.request_id_replay`.
pub fn find(
    pool: &Pool,
    owner_id: &str,
    session_id: &str,
    request_id: &str,
    tool: &str,
    args: &[(String, String)],
) -> Result<Option<(Request, &'static str)>, OwnError> {
    let Some(row) = by_key(pool, owner_id, &request_key(session_id, request_id))? else {
        return Ok(None);
    };
    if row.tool != tool || !same_input(&row.input, args) {
        return Err(OwnRefusal::new("agents.request_id_replay").into());
    }
    let class = data_class_of(&row.tool)?;
    Ok(Some((row, class)))
}

fn update(
    pool: &Pool,
    sql: &str,
    owner_id: &str,
    id: &str,
) -> Result<Vec<postgres::Row>, OwnError> {
    Ok(db::with_client(pool, |c| {
        Ok(c.query(sql, &[&owner_id, &id])?)
    })?)
}

/// `settle`: a request past its expiry is stored as expired, so it reads the same however it is read.
fn settle(pool: &Pool, owner_id: &str, id: &str) -> Result<Request, OwnError> {
    update(
        pool,
        "UPDATE agents.own_agent_approval_requests SET status = 'expired', decided_at = expires_at, updated_at = now()
          WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'waiting' AND expires_at <= now()",
        owner_id,
        id,
    )?;
    get(pool, owner_id, id)
}

/// `approve(owner, id, by)`: the approved request and whether it already was. One rejected, expired, replaced or
/// failed refuses with its state's code.
pub fn approve(
    pool: &Pool,
    owner_id: &str,
    id: &str,
    by: &str,
) -> Result<(Request, bool), OwnError> {
    let claimed = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "UPDATE agents.own_agent_approval_requests
                    SET status = 'approved', decided_at = now(), decided_by = $3::text, updated_at = now()
                  WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'waiting' AND expires_at > now()
                 RETURNING {}",
                columns()
            ),
            &[&owner_id, &id, &by],
        )?)
    })?;
    if let Some(r) = first(&claimed)? {
        data_class_of(&r.tool)?;
        return Ok((r, false));
    }
    let stored = settle(pool, owner_id, id)?;
    if stored.status != "approved" {
        return Err(OwnRefusal::new(refusal_for(&stored.status)).into());
    }
    data_class_of(&stored.tool)?;
    Ok((stored, true))
}

/// `claimRun`: the one run of an approved request with no result yet, for exactly one caller at a time; a claim left
/// by a run that crashed lapses after two minutes.
pub fn claim_run(pool: &Pool, owner_id: &str, id: &str) -> Result<bool, OwnError> {
    let rows = update(
        pool,
        "UPDATE agents.own_agent_approval_requests SET running_since = now(), updated_at = now()
          WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'approved' AND result_json IS NULL
            AND (running_since IS NULL OR running_since < now() - interval '2 minutes')
         RETURNING id",
        owner_id,
        id,
    )?;
    Ok(rows.len() == 1)
}

/// `announceAgain`: a waiting request marked not yet announced, so the person is told of it.
pub fn announce_again(pool: &Pool, owner_id: &str, id: &str) -> Result<(), OwnError> {
    update(
        pool,
        "UPDATE agents.own_agent_approval_requests SET published_at = NULL, updated_at = now()
          WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'waiting'",
        owner_id,
        id,
    )?;
    Ok(())
}

/// `releaseRun`: the run may be claimed again at once.
pub fn release_run(pool: &Pool, owner_id: &str, id: &str) -> Result<(), OwnError> {
    update(
        pool,
        "UPDATE agents.own_agent_approval_requests SET running_since = NULL, updated_at = now()
          WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'approved' AND result_json IS NULL",
        owner_id,
        id,
    )?;
    Ok(())
}

/// `recordResult`: the first result is kept; a later one never replaces it.
pub fn record_result(
    pool: &Pool,
    owner_id: &str,
    id: &str,
    result: &Json,
) -> Result<Request, OwnError> {
    let text = result.compact();
    db::with_client(pool, |c| {
        c.execute(
            "UPDATE agents.own_agent_approval_requests
                SET result_json = $3::text::jsonb, ran_at = now(), running_since = NULL, updated_at = now()
              WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'approved' AND result_json IS NULL",
            &[&owner_id, &id, &text],
        )?;
        Ok(())
    })?;
    get(pool, owner_id, id)
}

/// `fail`: an approved request its door refused for good reads failed with the door's code.
pub fn fail(pool: &Pool, owner_id: &str, id: &str, code: &str) -> Result<Request, OwnError> {
    db::with_client(pool, |c| {
        c.execute(
            "UPDATE agents.own_agent_approval_requests
                SET status = 'failed', failure_code = $3::text, running_since = NULL, updated_at = now()
              WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'approved' AND result_json IS NULL",
            &[&owner_id, &id, &code],
        )?;
        Ok(())
    })?;
    get(pool, owner_id, id)
}

/// `latest`: a request the person replaced by an edit, followed to its replacement (at most 20 hops).
pub fn latest(pool: &Pool, owner_id: &str, request: Request) -> Result<Request, OwnError> {
    let mut current = request;
    for _ in 0..20 {
        let next = match (&current.status[..], &current.replaced_by) {
            ("replaced", Some(next)) => next.clone(),
            _ => break,
        };
        current = get(pool, owner_id, &next)?;
    }
    Ok(current)
}

/// `reject`: a waiting request rejected; rejecting it again returns it. Any other state refuses with its code.
pub fn reject(pool: &Pool, owner_id: &str, id: &str) -> Result<Request, OwnError> {
    let rows = update(
        pool,
        &format!(
            "UPDATE agents.own_agent_approval_requests
                SET status = 'rejected', decided_at = now(), decided_by = 'person', updated_at = now()
              WHERE owner_id = $1::text AND id = $2::text::uuid AND status = 'waiting' AND expires_at > now()
             RETURNING {}",
            columns()
        ),
        owner_id,
        id,
    )?;
    if let Some(r) = first(&rows)? {
        return Ok(r);
    }
    let stored = settle(pool, owner_id, id)?;
    if stored.status == "rejected" {
        return Ok(stored);
    }
    Err(OwnRefusal::new(refusal_for(&stored.status)).into())
}

/// `edit`: a waiting request replaced by a new one for the edited input, in one transaction; the same edit again
/// returns the same new request, another one refuses as already replaced. Returns (replaced, new).
pub fn edit(
    pool: &Pool,
    owner_id: &str,
    id: &str,
    args: &[(String, String)],
    ttl_seconds: i64,
) -> Result<(Request, Request), OwnError> {
    let input = as_json(args);
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client = conn.client().map_err(StoreError::from)?;
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::ReadCommitted)
        .start()?;
    let locked = tx.query(
        &format!(
            "SELECT {} FROM agents.own_agent_approval_requests WHERE owner_id = $1::text AND id = $2::text::uuid FOR UPDATE",
            columns()
        ),
        &[&owner_id, &id],
    )?;
    let Some(old) = first(&locked)? else {
        return Err(OwnRefusal::new("agents.approval.not_found").into());
    };
    if let ("replaced", Some(next)) = (&old.status[..], &old.replaced_by) {
        let next = get_on(&mut tx, owner_id, next)?;
        if same_input(&next.input, args) {
            tx.commit()?;
            return Ok((old, next));
        }
    }
    if old.status != "waiting" {
        return Err(OwnRefusal::new(refusal_for(&old.status)).into());
    }
    let fresh = tx.query(
        &format!(
            "INSERT INTO agents.own_agent_approval_requests
               (agent_id, owner_id, session_id, tool, input_json, rule_id, request_key, expires_at)
             VALUES ($1::text::uuid, $2::text, $3::text::uuid, $4::text, $5::text::jsonb, $6::text::uuid, $7::text,
                     now() + make_interval(secs => $8::bigint))
             RETURNING {}",
            columns()
        ),
        &[
            &old.agent_id,
            &owner_id,
            &old.session_id,
            &old.tool,
            &input,
            &old.rule_id,
            &format!("agents:approve-edit:{}", old.id),
            &ttl_seconds,
        ],
    )?;
    let fresh = first(&fresh)?.ok_or_else(|| OwnError::Thrown("no request row".to_owned()))?;
    let replaced = tx.query(
        &format!(
            "UPDATE agents.own_agent_approval_requests
                SET status = 'replaced', replaced_by = $3::text::uuid, decided_at = now(), updated_at = now()
              WHERE owner_id = $1::text AND id = $2::text::uuid
             RETURNING {}",
            columns()
        ),
        &[&owner_id, &id, &fresh.id],
    )?;
    let replaced =
        first(&replaced)?.ok_or_else(|| OwnError::Thrown("no request row".to_owned()))?;
    tx.commit()?;
    Ok((replaced, fresh))
}

/// `list`: one agent's requests, newest first.
pub fn list(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<Request>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_approval_requests
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY created_at DESC, id
                  LIMIT $3",
                columns()
            ),
            &[&owner_id, &agent_id, &limit],
        )?)
    })?;
    Ok(rows.iter().map(request_of).collect::<Result<_, _>>()?)
}

/// `inbox`: the person's requests across all their own agents, the ones still waiting first, then newest first, each
/// with its agent's name.
pub fn inbox(pool: &Pool, owner_id: &str, limit: i64) -> Result<Vec<(Request, String)>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {}, agent_name FROM (
                   SELECT q.*, a.name AS agent_name
                     FROM agents.own_agent_approval_requests q
                     JOIN agents.own_agents a ON a.id = q.agent_id AND a.owner_id = $1::text
                    WHERE q.owner_id = $1::text) x
                  ORDER BY (CASE WHEN status = 'waiting' AND expires_at <= now() THEN 'expired' ELSE status END = 'waiting') DESC,
                           created_at DESC, id
                  LIMIT $2",
                columns()
            ),
            &[&owner_id, &limit],
        )?)
    })?;
    Ok(rows
        .iter()
        .map(|r| Ok((request_of(r)?, r.try_get::<_, String>(15)?)))
        .collect::<Result<_, StoreError>>()?)
}

/// `waiting`: one agent's requests still waiting for the person (not expired), newest first.
pub fn waiting(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    limit: i64,
) -> Result<Vec<Request>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_approval_requests
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND status = 'waiting' AND expires_at > now()
                  ORDER BY created_at DESC, id
                  LIMIT $3",
                columns()
            ),
            &[&owner_id, &agent_id, &limit],
        )?)
    })?;
    Ok(rows.iter().map(request_of).collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_wait_refuses_and_each_closed_state_has_its_code() {
        assert_eq!(
            approval_ttl(None).unwrap_err().code,
            "agents.approval.ttl_unset"
        );
        assert_eq!(
            approval_ttl(Some(0)).unwrap_err().code,
            "agents.approval.ttl_unset"
        );
        assert_eq!(approval_ttl(Some(60)).unwrap(), 60);
        assert_eq!(refusal_for("approved"), "agents.approval.decided");
        assert_eq!(refusal_for("expired"), "agents.approval.expired");
        assert_eq!(refusal_for("waiting"), "agents.approval.not_found");
    }

    #[test]
    fn the_same_input_is_the_same_whatever_the_order() {
        let a = vec![
            ("a".to_owned(), "1".to_owned()),
            ("b".to_owned(), "2".to_owned()),
        ];
        let b = vec![
            ("b".to_owned(), "2".to_owned()),
            ("a".to_owned(), "1".to_owned()),
        ];
        assert!(same_input(&a, &b));
        assert!(!same_input(&a, &a[..1]));
    }
}
