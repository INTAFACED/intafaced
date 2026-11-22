//! The fleet runtime (\`services/svc-agents/src/runtime.ts\`, \`AgentRuntime\`): a session opened with its agent's guardrail
//! bound to it, a metered engine call (\`think\`) and a session closed after its windows settle. Every one of them
//! writes its row of \`agent_actions\` before it returns, refusals and failures included.
//!
//! \`think\`'s order is the TypeScript's: the route; a metered replay; Copy-Intel's returns board; the published rate;
//! the guardrail; unpaid windows; a sealed window; the funds (only without a spend gate); the claim; the spend hold
//! (caps, team limits and funds under the person's lock); the engine; then the meter, the audit row, the transcript
//! and the hold's commit in one transaction. `act` is a guarded tool call: the guardrail decides before the tool runs,
//! and a place tool runs once per idempotency key (the navigator slice ported it with its first tool).
//!
//! - [\`guardrails\`]: the guardrail, parsed and evaluated.
//! - [\`funds\`]: the funds a run is checked against.
//! - [\`holds\`]: the spend holds.
//! - [\`runs\`]: the stored run (\`runs/\`).
//! - [\`reads\`]: the session, run and log reads.
//! - [\`slice\`]: the eighteen calls.

pub mod act;
pub mod copy_intel;
pub mod eligibility;
pub mod funds;
pub mod guardrails;
pub mod holds;
pub mod reads;
pub mod runs;
pub mod slice;

use postgres::IsolationLevel;

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::audit::{self, Action};
use crate::db::{self, Retryable, StoreError};
use crate::errors::{self, AgentError};
use crate::gateway::providers::{ChatMessage, TokenUsage};
use crate::gateway::routing::{Price, Route, resolve_route};
use crate::gateway::{Gateway, TaskRequest, digest_of_text};
use crate::metering::Metering;
use crate::metering::meter::{self, MeterError, UsageInput};
use crate::metering::pricing::{ModelPrice, token_cost};
use crate::metering::settle;
use eligibility::TierLaws;
use funds::{Funds, Outcome};
use guardrails::{
    Guardrail, Refusal, SessionState, evaluate_completion, parse_guardrail, refuse,
    serialise_guardrail,
};
use holds::{HoldError, ReserveInput};

/// An \`AgentError\` with the parameters of its copy key, which the action log keeps.
#[derive(Debug, Clone, PartialEq)]
pub struct Denied {
    pub error: AgentError,
    pub params: Vec<(String, Json)>,
}

/// A refusal by a code \`errors.ts\` declares.
pub fn denied(
    code: &'static str,
    key: &str,
    message: String,
    params: Vec<(String, Json)>,
) -> Denied {
    Denied {
        error: AgentError::declared(code, key, message),
        params,
    }
}

fn plain(e: AgentError) -> Denied {
    Denied {
        error: e,
        params: Vec::new(),
    }
}

/// What the runtime is built from, once, at start-up (\`AgentRuntimeOptions\`). The fee asset and whether metering is on
/// are the meter's (\`Metering\`), as \`index.ts\` hands both the same values.
pub struct Runtime {
    /// A spend gate is wired (\`spend: new UserSpendStore(sql)\` in production): every metered run holds its worst case.
    pub spend: bool,
    /// The funds a run is checked against; none reads nothing and checks nothing.
    pub funds: Option<Box<dyn Funds>>,
    /// \`AGENTS_TRANSCRIPT_RETENTION_DAYS\`: 0 keeps no prompt text.
    pub transcript_retention_days: i64,
    /// \`AGENTS_OVERAGE_GRACE\`: blank refuses any run while a window is unpaid.
    pub overage_grace: Option<Amount>,
    /// \`AGENTS_TIER_LAWS\`.
    pub tier_laws: TierLaws,
    /// The navigator slice's outside reads and settings.
    pub navigator: crate::navigator::Navigator,
    /// `selfFreeze`: identity's read of the owner's own freeze (J-wallet-13), wired while `IDENTITY_URL` is set. None
    /// refuses every gate that asks it, as an unread freeze counts as frozen.
    pub self_freeze: Option<Box<dyn crate::self_freeze::SelfFreezeRead>>,
}

impl Runtime {
    /// A spend gate and nothing else: no funds read, no transcript kept, no grace, no tier law.
    pub fn unwired() -> Runtime {
        Runtime {
            spend: true,
            funds: None,
            transcript_retention_days: 0,
            overage_grace: None,
            tier_laws: TierLaws::default(),
            navigator: crate::navigator::Navigator::unwired(),
            self_freeze: None,
        }
    }
}

/// One call's view of the runtime: its settings, the database, the gateway, the meter and the clock.
pub struct Rt<'a> {
    pub rt: &'a Runtime,
    pub pool: &'a Pool,
    pub gateway: &'a Gateway,
    pub m: &'a Metering,
    pub now: Instant,
}

/// What a runtime call fails with, as the TypeScript throws it.
#[derive(Debug, Clone, PartialEq)]
pub enum RunError {
    /// \`RefusedError\`: a guardrail said no, and its row is written.
    Refused {
        refusal: Refusal,
        action: Box<Action>,
    },
    /// \`AgentError\`.
    Agent(Denied),
    /// \`MeteredReplayError\`: the request id was already metered.
    MeteredReplay(Denied),
    /// A refusal already decided (\`TRPCError\`).
    Trpc(TrpcError),
    Store(StoreError),
    /// Anything else: the engine's outage.
    Other(String),
}

impl From<StoreError> for RunError {
    fn from(e: StoreError) -> RunError {
        RunError::Store(e)
    }
}
impl From<postgres::Error> for RunError {
    fn from(e: postgres::Error) -> RunError {
        RunError::Store(StoreError::from(e))
    }
}
impl From<MeterError> for RunError {
    fn from(e: MeterError) -> RunError {
        match e {
            MeterError::Agent(a) => RunError::Agent(plain(a)),
            MeterError::Store(s) => RunError::Store(s),
            MeterError::Ledger(l) => RunError::Other(l.message),
            MeterError::PaymentUnavailable => {
                RunError::Other("How this person pays could not be read".to_owned())
            }
            MeterError::Pricing(p) => RunError::Other(p),
        }
    }
}
impl From<HoldError> for RunError {
    fn from(e: HoldError) -> RunError {
        match e {
            HoldError::Denied(d) => RunError::Agent(d),
            HoldError::Store(s) => RunError::Store(s),
        }
    }
}
impl Retryable for RunError {
    fn store(&self) -> Option<&StoreError> {
        match self {
            RunError::Store(s) => Some(s),
            _ => None,
        }
    }
}

impl RunError {
    /// The machine code of a refusal: the guardrail's for a refusal, the error's own otherwise; none for an outage.
    pub fn code(&self) -> Option<&str> {
        match self {
            RunError::Refused { refusal, .. } => Some(&refusal.code),
            RunError::Agent(d) | RunError::MeteredReplay(d) => Some(d.error.code),
            _ => None,
        }
    }

    /// The copy key and its parameters a failure row records (\`appendFailure\`).
    fn failure_key(&self) -> (String, Vec<(String, Json)>) {
        match self {
            RunError::Agent(d) | RunError::MeteredReplay(d) => {
                (d.error.user_key.clone(), d.params.clone())
            }
            RunError::Refused { refusal, .. } => (
                format!("Refused by guardrail: {}", refusal.code),
                Vec::new(),
            ),
            _ => ("agents.error.engine_unavailable".to_owned(), Vec::new()),
        }
    }
}

/// \`guard\` over a runtime failure: a refusal is \`agents.refused\` with the refusal's copy key.
pub fn to_trpc(e: RunError) -> TrpcError {
    match e {
        RunError::Refused { refusal, .. } => {
            TrpcError::caused("FORBIDDEN", refusal.user_message_key, "agents.refused")
        }
        RunError::Agent(d) | RunError::MeteredReplay(d) => {
            errors::to_trpc(errors::Refusal::Agent(d.error))
        }
        RunError::Trpc(t) => t,
        RunError::Store(s) => errors::to_trpc(errors::Refusal::Other(s.to_string())),
        RunError::Other(o) => errors::to_trpc(errors::Refusal::Other(o)),
    }
}

/// \`SessionRecord\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: String,
    pub user_id: String,
    pub agent_id: String,
    pub guardrail: Guardrail,
    pub guardrail_version: i64,
    pub status: String,
    pub metered: bool,
    pub opened_at: Instant,
    pub closed_at: Option<Instant>,
}

impl SessionRecord {
    /// \`sessionOutput\`.
    pub fn to_output(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("agentId", Json::str(self.agent_id.clone())),
            ("guardrailVersion", Json::int(self.guardrail_version)),
            ("status", Json::str(self.status.clone())),
            ("metered", Json::Bool(self.metered)),
            ("openedAt", Json::str(self.opened_at.iso())),
            (
                "closedAt",
                self.closed_at.map_or(Json::Null, |c| Json::str(c.iso())),
            ),
        ])
    }
}

/// A timestamp read as the TypeScript's \`Date\` holds it: whole milliseconds.
pub fn ms(column: &str) -> String {
    format!("floor(extract(epoch FROM {column}) * 1000)::bigint")
}

fn session_columns() -> String {
    format!(
        "id::text, user_id, agent_id, guardrail::text, guardrail_version, status::text, metered, {}, {}",
        ms("opened_at"),
        ms("closed_at")
    )
}

fn session_of(r: &postgres::Row) -> Result<SessionRecord, RunError> {
    let text: String = r.try_get(3)?;
    let raw = json::parse(&text).map_err(|e| RunError::Other(e.message))?;
    let guardrail = parse_guardrail(&raw).map_err(|e| RunError::Other(e.0))?;
    Ok(SessionRecord {
        id: r.try_get(0)?,
        user_id: r.try_get(1)?,
        agent_id: r.try_get(2)?,
        guardrail,
        guardrail_version: i64::from(r.try_get::<_, i32>(4)?),
        status: r.try_get(5)?,
        metered: r.try_get(6)?,
        opened_at: Instant(r.try_get(7)?),
        closed_at: r.try_get::<_, Option<i64>>(8)?.map(Instant),
    })
}

/// \`runtime.session(id)\`: the session, or none. An id Postgres cannot read as a uuid is a database error, as there.
pub fn session(pool: &Pool, session_id: &str) -> Result<Option<SessionRecord>, RunError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.agent_sessions WHERE id = $1::text::uuid",
                session_columns()
            ),
            &[&session_id],
        )?)
    })?;
    rows.first().map(session_of).transpose()
}

/// \`ownedSession\`: the caller's session; another person's reads exactly as one that does not exist.
pub fn owned_session(
    pool: &Pool,
    session_id: &str,
    user_id: &str,
) -> Result<SessionRecord, RunError> {
    match session(pool, session_id)? {
        Some(s) if s.user_id == user_id => Ok(s),
        _ => Err(RunError::Trpc(TrpcError::plain(
            "NOT_FOUND",
            "agents.refused.session_closed",
        ))),
    }
}

/// \`agentDefinition\`: the stored guardrail and switch of an agent.
pub fn agent_definition(
    pool: &Pool,
    agent_id: &str,
) -> Result<Option<(Guardrail, bool)>, RunError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT guardrail::text, enabled FROM agents.agent_definitions WHERE agent_id = $1::text",
            &[&agent_id],
        )?)
    })?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let text: String = r.try_get(0)?;
    let raw = json::parse(&text).map_err(|e| RunError::Other(e.message))?;
    let g = parse_guardrail(&raw).map_err(|e| RunError::Other(e.0))?;
    Ok(Some((g, r.try_get(1)?)))
}

/// \`CATALOGUE_ONLY_AGENTS\` (\`fleet/catalogue-only.ts\`): listed, and never opened.
pub const CATALOGUE_ONLY_AGENTS: [&str; 4] = ["launch", "growth", "portfolio", "risk-compliance"];

/// `productKindOff`, the ops slice's (`ops::fleet`).
fn product_kind_off(pool: &Pool) -> Result<bool, RunError> {
    Ok(crate::ops::fleet::product_kind_off(pool)?)
}

fn agent_not_found(message: String, key: &str, params: Vec<(String, Json)>) -> RunError {
    RunError::Agent(denied("agents.agent_not_found", key, message, params))
}

/// \`openSession\`: the agent's stored guardrail bound to a new session.
pub fn open_session(x: &Rt<'_>, user_id: &str, agent_id: &str) -> Result<SessionRecord, RunError> {
    let definition = if CATALOGUE_ONLY_AGENTS.contains(&agent_id) {
        None
    } else {
        agent_definition(x.pool, agent_id)?
    };
    let Some((guardrail, enabled)) = definition else {
        return Err(agent_not_found(
            format!("No agent \"{agent_id}\" is registered"),
            "agents.error.route_not_found",
            vec![audit::param("task", agent_id)],
        ));
    };
    if !enabled {
        return Err(agent_not_found(
            format!("Agent \"{agent_id}\" is disabled"),
            "agents.error.engine_unavailable",
            vec![],
        ));
    }
    if product_kind_off(x.pool)? {
        return Err(agent_not_found(
            format!("Agent \"{agent_id}\" is disabled by kind"),
            "agents.error.engine_unavailable",
            vec![],
        ));
    }
    insert_session(x, user_id, &guardrail, true)
}

/// `openOwnSession`: a session of a person's own agent, bound to the guardrail its builder made (`own.<agent id>`).
pub fn open_own_session(
    x: &Rt<'_>,
    user_id: &str,
    guardrail: &Guardrail,
) -> Result<SessionRecord, RunError> {
    if !guardrail.agent_id.starts_with("own.") {
        return Err(agent_not_found(
            format!("\"{}\" is not an own agent", guardrail.agent_id),
            "agents.error.route_not_found",
            vec![audit::param("task", guardrail.agent_id.clone())],
        ));
    }
    insert_session(x, user_id, guardrail, true)
}

fn insert_session(
    x: &Rt<'_>,
    user_id: &str,
    g: &Guardrail,
    metered: bool,
) -> Result<SessionRecord, RunError> {
    let snapshot = serialise_guardrail(g).compact();
    let version = i32::try_from(g.version).map_err(|e| RunError::Other(e.to_string()))?;
    db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let rows = tx.query(
            &format!(
                "INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version, metered, opened_at)
                 VALUES ($1::text, $2::text, $3::text::jsonb, $4, $5, $6::text::timestamptz)
                 RETURNING {}",
                session_columns()
            ),
            &[&user_id, &g.agent_id, &snapshot, &version, &metered, &x.now.iso()],
        )?;
        let session = session_of(
            rows.first()
                .ok_or_else(|| RunError::Other("no session row".to_owned()))?,
        )?;
        audit::append(
            tx,
            &audit::Entry {
                session_id: &session.id,
                user_id: &session.user_id,
                agent_id: &session.agent_id,
                kind: "session_open",
                status: "executed",
                user_message_key: "agents.session.opened",
                user_message_params: vec![audit::param("agent", session.agent_id.clone())],
                ..audit::Entry::default()
            },
            x.now,
        )?;
        Ok(session)
    })
}

const BOOKKEEPING: &str = "kind NOT IN ('session_open', 'session_close', 'usage_settlement')";

/// \`closeSession\`: closed once; a repeat answers the closed session and appends nothing.
pub fn close_session(x: &Rt<'_>, session_id: &str) -> Result<SessionRecord, RunError> {
    db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let rows = tx.query(
            &format!(
                "SELECT {} FROM agents.agent_sessions WHERE id = $1::text::uuid FOR UPDATE",
                session_columns()
            ),
            &[&session_id],
        )?;
        let Some(row) = rows.first() else {
            return Err(RunError::Agent(denied(
                "agents.session_not_found",
                "agents.refused.session_closed",
                format!("No session {session_id}"),
                vec![],
            )));
        };
        let current = session_of(row)?;
        if current.status == "closed" {
            return Ok(current);
        }
        let updated = tx.query(
            &format!(
                "UPDATE agents.agent_sessions SET status = 'closed', closed_at = $2::text::timestamptz
                  WHERE id = $1::text::uuid RETURNING {}",
                session_columns()
            ),
            &[&session_id, &x.now.iso()],
        )?;
        let steps: i64 = tx
            .query_one(
                &format!("SELECT count(*)::bigint FROM agents.agent_actions WHERE session_id = $1::text::uuid AND {BOOKKEEPING}"),
                &[&session_id],
            )?
            .try_get(0)?;
        audit::append(
            tx,
            &audit::Entry {
                session_id,
                user_id: &current.user_id,
                agent_id: &current.agent_id,
                kind: "session_close",
                status: "executed",
                user_message_key: "agents.session.closed",
                user_message_params: vec![audit::num("steps", steps)],
                ..audit::Entry::default()
            },
            x.now,
        )?;
        session_of(
            updated
                .first()
                .ok_or_else(|| RunError::Other("no session row".to_owned()))?,
        )
    })
}

/// \`closeSettled\`: the session's windows settled, then the session closed. A window the ledger refuses for funds, or
/// one owed and not collected, stays unpaid on its key and the session stays open, refused \`agents.window_unpaid\`.
pub fn close_settled(x: &Rt<'_>, session_id: &str) -> Result<SessionRecord, RunError> {
    match settle::settle_session(x.m, x.pool, session_id, x.now) {
        Ok(_) => {}
        Err(MeterError::Ledger(l)) if l.code.as_deref() == Some("ledger.insufficient_funds") => {
            return Err(window_unpaid(session_id));
        }
        Err(MeterError::Agent(a)) if a.code == "agents.window_unpaid" => {
            return Err(window_unpaid(session_id));
        }
        Err(e) => return Err(e.into()),
    }
    close_session(x, session_id)
}

fn window_unpaid(session_id: &str) -> RunError {
    RunError::Agent(denied(
        "agents.window_unpaid",
        "agents.error.window_unpaid",
        format!("A usage window of session {session_id} could not be paid"),
        vec![],
    ))
}

/// \`stateOf\`: what the guardrail needs to know of the session's history; bookkeeping rows are not actions.
pub fn state_of(pool: &Pool, s: &SessionRecord) -> Result<SessionState, RunError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let c = conn.client().map_err(StoreError::from)?;
    let count: i64 = c
        .query_one(
            &format!("SELECT count(*)::bigint FROM agents.agent_actions WHERE session_id = $1::text::uuid AND {BOOKKEEPING}"),
            &[&s.id],
        )?
        .try_get(0)?;
    let tools = c.query(
        "SELECT tool, count(*)::bigint FROM agents.agent_actions
          WHERE session_id = $1::text::uuid AND kind = 'tool_call' AND status = 'executed' AND tool IS NOT NULL
          GROUP BY tool",
        &[&s.id],
    )?;
    let tool_calls = tools
        .iter()
        .map(|r| Ok((r.try_get::<_, String>(0)?, r.try_get::<_, i64>(1)?)))
        .collect::<Result<Vec<_>, postgres::Error>>()?;
    let spend = meter::session_spend(c, &s.id)?;
    Ok(SessionState {
        closed: s.status == "closed",
        action_count: count,
        tool_calls,
        spend,
        approved_tools: Vec::new(),
    })
}

fn require_session(pool: &Pool, session_id: &str) -> Result<SessionRecord, RunError> {
    let Some(s) = session(pool, session_id)? else {
        return Err(RunError::Agent(denied(
            "agents.session_not_found",
            "agents.refused.session_closed",
            format!("No session {session_id}"),
            vec![],
        )));
    };
    if s.status == "closed" {
        return Err(RunError::Agent(denied(
            "agents.session_closed",
            "agents.refused.session_closed",
            format!("Session {session_id} is closed"),
            vec![],
        )));
    }
    Ok(s)
}

/// \`buildEnvelope(name, payload, producer, { idempotencyKey })\`.
pub fn envelope(
    m: &Metering,
    subject: &str,
    key: &str,
    payload: Json,
    at: Instant,
) -> Result<Json, String> {
    Ok(Json::obj([
        ("id", Json::str(settle::random_uuid()?)),
        ("subject", Json::str(subject)),
        ("version", Json::int(1)),
        ("occurredAt", Json::str(at.iso())),
        ("producer", Json::str(m.producer.clone())),
        ("idempotencyKey", Json::str(key)),
        ("payload", payload),
    ]))
}

pub const ACTION_COMPLETED: &str = "intafaced.agents.action.completed";
pub const ACTION_REJECTED: &str = "intafaced.agents.action.rejected";
pub const USAGE_ALERT_CROSSED: &str = "intafaced.agents.usage_alert.crossed";

fn publish(x: &Rt<'_>, subject: &str, key: &str, payload: Json) -> Result<(), RunError> {
    let env = envelope(x.m, subject, key, payload, x.now).map_err(RunError::Other)?;
    x.m.bus.publish(subject, key, &env).map_err(RunError::Other)
}

fn opt(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

/// The kind of action a refusal or a failure is recorded as, with its tool or task.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub kind: &'a str,
    pub tool: Option<&'a str>,
    pub task: Option<&'a str>,
}

/// \`appendRefusal\`: the refusal's row, then \`agentActionRejected\`; the answer is the refusal with its row.
pub fn append_refusal(
    x: &Rt<'_>,
    s: &SessionRecord,
    refusal: Refusal,
    cx: Context<'_>,
) -> RunError {
    match append_refusal_inner(x, s, &refusal, cx) {
        Ok(action) => RunError::Refused {
            refusal,
            action: Box::new(action),
        },
        Err(e) => e,
    }
}

fn append_refusal_inner(
    x: &Rt<'_>,
    s: &SessionRecord,
    refusal: &Refusal,
    cx: Context<'_>,
) -> Result<Action, RunError> {
    let entry = audit::Entry {
        session_id: &s.id,
        user_id: &s.user_id,
        agent_id: &s.agent_id,
        kind: cx.kind,
        status: "refused",
        tool: cx.tool,
        task: cx.task,
        refusal_code: Some(&refusal.code),
        user_message_key: &refusal.user_message_key,
        user_message_params: refusal.user_message_params.clone(),
        ..audit::Entry::default()
    };
    let action = db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        audit::append(tx, &entry, x.now)
    })?;
    publish(
        x,
        ACTION_REJECTED,
        &format!("agents.action:{}:{}", s.id, action.sequence),
        Json::obj([
            ("sessionId", Json::str(s.id.clone())),
            ("userId", Json::str(s.user_id.clone())),
            ("agentId", Json::str(s.agent_id.clone())),
            ("sequence", Json::int(action.sequence)),
            ("refusalCode", Json::str(refusal.code.clone())),
            ("tool", opt(action.tool.as_deref())),
            ("task", opt(action.task.as_deref())),
        ]),
    )?;
    Ok(action)
}

/// \`appendFailure\`: a failed row with the error's copy key, or the engine's outage for anything else. The caller's
/// error is the answer; a failure to write the row replaces it, as there.
pub fn append_failure(
    x: &Rt<'_>,
    s: &SessionRecord,
    cx: Context<'_>,
    provider: Option<(&str, &str)>,
    error: RunError,
) -> RunError {
    let (key, params) = error.failure_key();
    let entry = audit::Entry {
        session_id: &s.id,
        user_id: &s.user_id,
        agent_id: &s.agent_id,
        kind: cx.kind,
        status: "failed",
        tool: cx.tool,
        task: cx.task,
        provider_id: provider.map(|p| p.0),
        model: provider.map(|p| p.1),
        user_message_key: &key,
        user_message_params: params,
        ..audit::Entry::default()
    };
    match db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        audit::append(tx, &entry, x.now)
    }) {
        Ok(_) => error,
        Err(e) => RunError::Store(e),
    }
}

/// \`publishCompleted\`.
fn publish_completed(x: &Rt<'_>, a: &Action, usage: TokenUsage) -> Result<(), RunError> {
    publish(
        x,
        ACTION_COMPLETED,
        &format!("agents.action:{}:{}", a.session_id, a.sequence),
        Json::obj([
            ("sessionId", Json::str(a.session_id.clone())),
            ("userId", Json::str(a.user_id.clone())),
            ("agentId", Json::str(a.agent_id.clone())),
            ("sequence", Json::int(a.sequence)),
            ("kind", Json::str(a.kind.clone())),
            ("task", opt(a.task.as_deref())),
            ("tool", opt(a.tool.as_deref())),
            ("inputTokens", Json::int(usage.input_tokens)),
            ("outputTokens", Json::int(usage.output_tokens)),
        ]),
    )
}

/// `ActInput`, less its `execute`, which [`act`] takes on its own.
#[derive(Debug, Clone, Copy, Default)]
pub struct ActInput<'a> {
    pub session_id: &'a str,
    pub tool: &'a str,
    pub approved: Option<bool>,
    pub idempotency_key: Option<&'a str>,
}

/// `ActResult`: what the tool returned, its row, and whether it was a stored place answered again.
#[derive(Debug, Clone, PartialEq)]
pub struct ActResult {
    pub result: Json,
    pub action: Action,
    pub replayed: bool,
}

/// `act`: a guarded tool call. The guardrail decides before `execute` runs, and every outcome writes its row: a
/// refusal, a failure, or the executed call with the digest of what it returned. A place tool runs once per
/// idempotency key in the session: a repeat with a stored result answers it again, and another tool or an unfinished
/// claim on the key is a conflict.
pub fn act(
    x: &Rt<'_>,
    input: &ActInput<'_>,
    execute: impl FnOnce() -> Result<Json, RunError>,
) -> Result<ActResult, RunError> {
    let session = require_session(x.pool, input.session_id)?;
    let key = input
        .idempotency_key
        .map(str::trim)
        .filter(|k| !k.is_empty());
    let place_key = key.filter(|_| guardrails::is_place_tool(input.tool));
    let cx = Context {
        kind: "tool_call",
        tool: Some(input.tool),
        task: None,
    };
    if let Some(pk) = place_key
        && let Some((result, action)) = stored_place_intent(x.pool, &session.id, pk, input.tool)?
    {
        return Ok(ActResult {
            result,
            action,
            replayed: true,
        });
    }
    let state = state_of(x.pool, &session)?;
    if let Err(refusal) =
        guardrails::evaluate_tool_call(&session.guardrail, &state, input.tool, input.approved, key)
    {
        return Err(append_refusal(x, &session, refusal, cx));
    }
    let mut claimed = false;
    if let Some(pk) = place_key {
        match claim_place_intent(x.pool, &session.id, pk, input.tool)? {
            Claim::Replay(result, action) => {
                return Ok(ActResult {
                    result,
                    action: *action,
                    replayed: true,
                });
            }
            Claim::Conflict => {
                let refusal = refuse(
                    "agents.place_key_conflict",
                    "agents.refused.place_key_conflict",
                    vec![audit::param("tool", input.tool)],
                );
                return Err(append_refusal(x, &session, refusal, cx));
            }
            Claim::Claimed => claimed = true,
        }
    }
    let result = match execute() {
        Ok(r) => r,
        Err(e) => {
            if claimed && let Some(pk) = place_key {
                release_place_claim(x.pool, &session.id, pk, input.tool)?;
            }
            return Err(append_failure(x, &session, cx, None, e));
        }
    };
    let text = result.compact();
    let digest = digest_of_text(&text);
    let written = db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let row = audit::append(
            tx,
            &audit::Entry {
                session_id: &session.id,
                user_id: &session.user_id,
                agent_id: &session.agent_id,
                kind: "tool_call",
                status: "executed",
                tool: Some(input.tool),
                user_message_key: "agents.action.executed",
                user_message_params: vec![audit::param("tool", input.tool)],
                output_digest: Some(&digest),
                ..audit::Entry::default()
            },
            x.now,
        )?;
        if claimed && let Some(pk) = place_key {
            let updated = tx.execute(
                "UPDATE agents.agent_place_intents
                    SET action_id = $1::text::uuid, result_json = $2::text
                  WHERE session_id = $3::text::uuid AND idempotency_key = $4::text AND tool = $5::text
                    AND result_json IS NULL",
                &[&row.id, &text, &session.id, &pk, &input.tool],
            )?;
            if updated == 0 {
                return Err(RunError::Other(format!(
                    "place intent for session {} was not stored",
                    session.id
                )));
            }
        }
        Ok(row)
    });
    let action = match written {
        Ok(a) => a,
        Err(e) if claimed => return Err(append_failure(x, &session, cx, None, e)),
        Err(e) => return Err(e),
    };
    publish_completed(
        x,
        &action,
        TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
        },
    )?;
    Ok(ActResult {
        result,
        action,
        replayed: false,
    })
}

enum Claim {
    Claimed,
    Conflict,
    Replay(Json, Box<Action>),
}

fn parse_result(text: &str) -> Result<Json, RunError> {
    json::parse(text).map_err(|e| RunError::Other(e.message))
}

/// `storedPlaceIntent`: the same tool and key, with a stored result. Another tool is not a replay.
fn stored_place_intent(
    pool: &Pool,
    session_id: &str,
    key: &str,
    tool: &str,
) -> Result<Option<(Json, Action)>, RunError> {
    db::with_client(pool, |c| {
        let rows = c.query(
            "SELECT action_id::text, result_json FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text
                AND action_id IS NOT NULL AND result_json IS NOT NULL",
            &[&session_id, &key, &tool],
        )?;
        let Some(r) = rows.first() else {
            return Ok(None);
        };
        let action_id: String = r.try_get(0)?;
        let text: String = r.try_get(1)?;
        Ok(audit::by_id(c, &action_id)?.map(|a| (text, a)))
    })?
    .map(|(text, a)| Ok((parse_result(&text)?, a)))
    .transpose()
}

/// `claimPlaceIntent`: the claim is inserted before `execute`; a row already there with this tool's stored result is a
/// replay, anything else a conflict.
fn claim_place_intent(
    pool: &Pool,
    session_id: &str,
    key: &str,
    tool: &str,
) -> Result<Claim, RunError> {
    let found = db::with_client(pool, |c| {
        let inserted = c.execute(
            "INSERT INTO agents.agent_place_intents (session_id, idempotency_key, tool, action_id, result_json)
             VALUES ($1::text::uuid, $2::text, $3::text, NULL, NULL)
             ON CONFLICT (session_id, idempotency_key) DO NOTHING",
            &[&session_id, &key, &tool],
        )?;
        if inserted > 0 {
            return Ok(None);
        }
        let rows = c.query(
            "SELECT tool, action_id::text, result_json FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text",
            &[&session_id, &key],
        )?;
        let Some(r) = rows.first() else {
            return Ok(Some(None));
        };
        let (held, action_id, text): (String, Option<String>, Option<String>) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        if let (true, Some(id), Some(text)) = (held == tool, action_id, text)
            && let Some(a) = audit::by_id(c, &id)?
        {
            return Ok(Some(Some((text, a))));
        }
        Ok(Some(None))
    })?;
    Ok(match found {
        None => Claim::Claimed,
        Some(None) => Claim::Conflict,
        Some(Some((text, a))) => Claim::Replay(parse_result(&text)?, Box::new(a)),
    })
}

/// `releasePlaceClaim`: a claim whose `execute` never returned is dropped; a stored place stays.
fn release_place_claim(
    pool: &Pool,
    session_id: &str,
    key: &str,
    tool: &str,
) -> Result<(), RunError> {
    db::with_client(pool, |c| {
        c.execute(
            "DELETE FROM agents.agent_place_intents
              WHERE session_id = $1::text::uuid AND idempotency_key = $2::text AND tool = $3::text
                AND result_json IS NULL",
            &[&session_id, &key, &tool],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// \`publishPendingUsageAlerts\`: recorded alerts not yet published, one person's or everyone's; a row the bus refuses
/// stays unpublished for the next sweep and never holds back the ones after it.
pub fn publish_usage_alerts(x: &Rt<'_>, owner: Option<&str>) -> Result<i64, RunError> {
    let rows = db::with_client(x.pool, |c| {
        Ok(c.query(
            "SELECT alert_key, agent_id::text, owner_id, month, alert_at::text, spent::text, asset_id, email
               FROM agents.own_agent_usage_alerts
              WHERE published_at IS NULL AND ($1::text IS NULL OR owner_id = $1::text)
              ORDER BY created_at
              LIMIT 100",
            &[&owner],
        )?)
    })?;
    let mut published = 0;
    for r in &rows {
        let key: String = r.try_get(0)?;
        let amount = |i: usize| -> Result<String, RunError> {
            let t: String = r.try_get(i)?;
            service_kit::money::parse_amount(&t)
                .map(format_amount)
                .map_err(RunError::Other)
        };
        let payload = Json::obj([
            ("alertKey", Json::str(key.clone())),
            ("userId", Json::str(r.try_get::<_, String>(2)?)),
            ("agentId", Json::str(r.try_get::<_, String>(1)?)),
            ("month", Json::str(r.try_get::<_, String>(3)?)),
            ("alertAt", Json::str(amount(4)?)),
            ("spent", Json::str(amount(5)?)),
            ("assetId", Json::str(r.try_get::<_, String>(6)?)),
            ("email", Json::Bool(r.try_get(7)?)),
        ]);
        if publish(x, USAGE_ALERT_CROSSED, &key, payload).is_err() {
            continue;
        }
        db::with_client(x.pool, |c| {
            c.execute(
                "UPDATE agents.own_agent_usage_alerts SET published_at = now(), updated_at = now()
                  WHERE alert_key = $1::text AND published_at IS NULL",
                &[&key],
            )?;
            Ok(())
        })?;
        published += 1;
    }
    Ok(published)
}

/// \`retryUnpaidWindows\`: the person's sealed, unpaid windows retried smallest first on their own keys; the first the
/// ledger does not take stops the retry, and it and every larger one stay owed.
pub fn retry_unpaid_windows(x: &Rt<'_>, user_id: &str) -> Result<Amount, RunError> {
    let mut owed = 0;
    let mut stopped = false;
    for (session_id, window_id, amount) in meter::unpaid_windows(x.pool, user_id)? {
        if !stopped {
            if settle::settle_window(x.m, x.pool, &session_id, &window_id, x.now).is_ok() {
                continue;
            }
            stopped = true;
        }
        owed += amount;
    }
    Ok(owed)
}

/// \`estimateInputTokens\`: three characters (UTF-16 units) a token, rounded up: pessimistic on purpose.
pub fn estimate_input_tokens(system: Option<&str>, messages: &[ChatMessage]) -> i64 {
    let chars = system.map_or(0, |s| s.encode_utf16().count())
        + messages
            .iter()
            .map(|m| m.content.encode_utf16().count())
            .sum::<usize>();
    i64::try_from(chars.div_ceil(3)).unwrap_or(i64::MAX)
}

/// \`canonicalPrompt\`: the text whose digest is the action's input digest.
pub fn canonical_prompt(system: Option<&str>, messages: &[ChatMessage]) -> String {
    Json::Array(vec![
        opt(system),
        Json::Array(
            messages
                .iter()
                .map(|m| Json::Array(vec![Json::str(m.role.name()), Json::str(m.content.clone())]))
                .collect(),
        ),
    ])
    .compact()
}

/// \`usageCost\`.
pub fn usage_cost(
    input_tokens: i64,
    output_tokens: i64,
    price: &Price,
) -> Result<Amount, RunError> {
    let cost = |t: i64, p: Amount| token_cost(Amount::from(t), p).map_err(|e| RunError::Other(e.0));
    Ok(cost(input_tokens, price.input_per_million)?
        + cost(output_tokens, price.output_per_million)?)
}

/// \`ThinkInput\`.
pub struct ThinkInput<'a> {
    pub session_id: &'a str,
    pub request_id: &'a str,
    pub task: &'a str,
    pub system: Option<&'a str>,
    pub messages: &'a [ChatMessage],
    pub max_output_tokens: Option<i64>,
    pub team_run: bool,
}

/// \`ThinkResult\`.
#[derive(Debug, Clone, PartialEq)]
pub struct ThinkResult {
    pub text: String,
    pub usage: TokenUsage,
    /// What this call added to the bill: 0 for a call not metered.
    pub cost: Amount,
    pub metered: bool,
    pub window_id: Option<String>,
    pub route: Route,
    pub action: Action,
}

fn completion<'a>(task: &'a str) -> Context<'a> {
    Context {
        kind: "completion",
        tool: None,
        task: Some(task),
    }
}

const SPEND_LIMIT_CODES: [&str; 3] = [
    "agents.spend_limit",
    "agents.spend_limit_unset",
    "agents.spend_limit_invalid",
];
const OWN_HOLD_CODES: [&str; 7] = [
    "agents.spend.cap_exceeded",
    "agents.spend.cap_unset",
    "agents.usage.hard_limit_reached",
    "agents.team.allocation_exceeded",
    "agents.team.project_limit_exceeded",
    "agents.team.pool_exceeded",
    "agents.team.allocation_unset",
];
const FUNDS_CODES: [&str; 2] = ["agents.funds_insufficient", "agents.funds_unread"];

/// A failure inside the meter-and-audit transaction.
enum TxError {
    Ceiling(Amount),
    Run(RunError),
}
impl From<StoreError> for TxError {
    fn from(e: StoreError) -> TxError {
        TxError::Run(RunError::Store(e))
    }
}
impl From<RunError> for TxError {
    fn from(e: RunError) -> TxError {
        TxError::Run(e)
    }
}
impl Retryable for TxError {
    fn store(&self) -> Option<&StoreError> {
        match self {
            TxError::Run(RunError::Store(s)) => Some(s),
            _ => None,
        }
    }
}

/// \`think\`: one metered engine call inside the session's guardrail.
pub fn think(x: &Rt<'_>, input: &ThinkInput<'_>) -> Result<ThinkResult, RunError> {
    let s = require_session(x.pool, input.session_id)?;
    let fee = x.m.fee_asset_id.as_str();
    let cx = completion(input.task);

    // 1 · Route: a task with no route is a failed action, logged.
    let table = x.gateway.routing_table(x.now);
    let route = match resolve_route(&table, input.task) {
        Ok(r) => r.clone(),
        Err(e) => {
            let d = Denied {
                error: e,
                params: vec![audit::param("task", input.task)],
            };
            return Err(append_failure(x, &s, cx, None, RunError::Agent(d)));
        }
    };

    // 1a · A request id already metered never reaches the engine again.
    let should_meter = s.metered && x.m.enabled;
    if should_meter && meter::has_request(x.pool, &s.id, input.request_id)? {
        let e = RunError::MeteredReplay(denied(
            "agents.request_id_replay",
            "agents.error.request_id_replay",
            format!(
                "Request id \"{}\" was already metered on session {}",
                input.request_id, s.id
            ),
            vec![audit::param("requestId", input.request_id)],
        ));
        return Err(append_failure(x, &s, cx, None, e));
    }

    // 1b · Copy-Intel never builds a returns board (D26-P1-A5).
    if s.agent_id == copy_intel::COPY_INTEL_SESSION_AGENT_ID
        && input.messages.iter().any(|m| {
            m.role == crate::gateway::providers::Role::User
                && copy_intel::asks_for_returns_ranking(&m.content)
        })
    {
        return Err(append_refusal(
            x,
            &s,
            refuse(
                "agents.copy_intel.returns_board_refused",
                "agents.refused.copy_intel.returns_board_refused",
                vec![],
            ),
            cx,
        ));
    }

    let max_output_tokens = input
        .max_output_tokens
        .map_or(route.max_output_tokens, |m| m.min(route.max_output_tokens));
    // A route with no published rate never runs (OWNER 107).
    let Some(price) = route.price else {
        return Err(append_refusal(
            x,
            &s,
            refuse(
                "agents.price_unset",
                "agents.refused.price_unset",
                vec![audit::param("task", input.task)],
            ),
            cx,
        ));
    };
    let worst = usage_cost(
        estimate_input_tokens(input.system, input.messages),
        max_output_tokens,
        &price,
    )?;

    // 2 · The guardrail, before anything is called.
    let state = state_of(x.pool, &s)?;
    if let Err(r) = evaluate_completion(
        &s.guardrail,
        &state,
        input.task,
        max_output_tokens,
        worst,
        fee,
    ) {
        return Err(append_refusal(x, &s, r, cx));
    }

    // 2b · Unpaid usage, retried first; what is still owed holds the run back unless the grace covers it.
    if should_meter {
        let owed = retry_unpaid_windows(x, &s.user_id)?;
        let grace = x.rt.overage_grace;
        if owed > 0 && grace.is_none_or(|g| owed > g) {
            let refusal = match grace {
                None => refuse(
                    "agents.overage_grace_unset",
                    "agents.refused.overage_grace_unset",
                    vec![
                        audit::param("owed", format_amount(owed)),
                        audit::param("asset", fee),
                    ],
                ),
                Some(g) => refuse(
                    "agents.overage_grace_exceeded",
                    "agents.refused.overage_grace_exceeded",
                    vec![
                        audit::param("owed", format_amount(owed)),
                        audit::param("grace", format_amount(g)),
                        audit::param("asset", fee),
                    ],
                ),
            };
            return Err(append_refusal(x, &s, refusal, cx));
        }
    }

    // 2b' · A sealed window takes no more usage.
    if should_meter && meter::is_sealed(x.pool, &s.id, &meter::window_for(x.m, x.now)?)? {
        return Err(append_refusal(
            x,
            &s,
            refuse(
                "agents.window_sealed",
                "agents.refused.window_sealed",
                vec![],
            ),
            cx,
        ));
    }

    // 2a · Funds, only for a runtime wired without a spend gate (with one, the hold checks them under its lock).
    let funds = x.rt.funds.as_deref().filter(|_| should_meter && worst > 0);
    if !x.rt.spend
        && let Some(f) = funds
    {
        let outcome = match f.available(x.pool, &s.user_id, fee, &s.agent_id, &s.id) {
            Ok(reading) => funds::shortfall(&reading, 0, worst),
            Err(u) => Some(Outcome::Unread(u)),
        };
        if let Some(o) = outcome {
            let read = matches!(o, Outcome::Read(_));
            let params = funds::refusal_params(&format_amount(worst), fee, &o);
            return Err(append_refusal(
                x,
                &s,
                refuse(
                    if read {
                        "agents.funds_insufficient"
                    } else {
                        "agents.funds_unread"
                    },
                    if read {
                        "agents.refused.funds_insufficient"
                    } else {
                        "agents.refused.funds_unread"
                    },
                    params,
                ),
                cx,
            ));
        }
    }

    // The claim: the unique insert commits before the provider is called, and only while metering is on.
    let mut claimed = false;
    if should_meter {
        claimed = meter::claim_request(x.pool, &s.id, input.request_id)?;
        if !claimed {
            let e = RunError::Agent(denied(
                "agents.request_id_replay",
                "agents.error.request_id_replay",
                format!(
                    "Request id \"{}\" was already metered on session {}",
                    input.request_id, s.id
                ),
                vec![audit::param("requestId", input.request_id)],
            ));
            return Err(append_failure(x, &s, cx, None, e));
        }
    }
    let release_claim = |claimed: bool| -> Result<(), RunError> {
        if claimed {
            meter::release_claim(x.pool, &s.id, input.request_id)?;
        }
        Ok(())
    };

    // 2c · The hold: the worst case, against every cap, under the person's lock. Not a ledger post.
    let mut reserved: Option<Amount> = None;
    let mut key = input.request_id.to_owned();
    if x.rt.spend {
        match hold(x, &s, input, worst, funds, should_meter, &mut key, claimed) {
            Ok(amount) => reserved = Some(amount),
            Err(e) => {
                release_claim(claimed)?;
                if let RunError::Agent(d) = &e {
                    let code = d.error.code;
                    if SPEND_LIMIT_CODES.contains(&code) {
                        let r = refuse("agents.spend_limit", &d.error.user_key, d.params.clone());
                        return Err(append_refusal(x, &s, r, cx));
                    }
                    if OWN_HOLD_CODES.contains(&code) || FUNDS_CODES.contains(&code) {
                        let r = refuse(code, &d.error.user_key, d.params.clone());
                        return Err(append_refusal(x, &s, r, cx));
                    }
                }
                return Err(e);
            }
        }
    }
    let release_hold = || -> Result<(), RunError> {
        if reserved.is_some() {
            holds::release(x.pool, &s.user_id, &key)?;
        }
        Ok(())
    };

    // 3 · The engine.
    let request = TaskRequest {
        system: input.system.map(str::to_owned),
        messages: input.messages.to_vec(),
        max_output_tokens: Some(max_output_tokens),
        temperature: None,
        stop_sequences: None,
    };
    let done = match x.gateway.complete(input.task, &request, x.now) {
        Ok(c) => c,
        Err(e) => {
            release_hold()?;
            release_claim(claimed)?;
            let params = if e.code == "agents.route_not_found" {
                vec![audit::param("task", route.task.clone())]
            } else {
                Vec::new()
            };
            let provider = Some((route.provider_id.as_str(), route.model.as_str()));
            return Err(append_failure(
                x,
                &s,
                cx,
                provider,
                RunError::Agent(Denied { error: e, params }),
            ));
        }
    };
    let usage = done.result.usage;
    let cost = usage_cost(usage.input_tokens, usage.output_tokens, &price)?;
    let own = s.agent_id.starts_with("own.");

    // The provider reported more than was held: the hold is finished at what was held, the claim dropped, the text
    // refused.
    if let Some(held) = reserved.filter(|h| cost > *h) {
        let commit_held = || {
            db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
                holds::commit_in(tx, &s.user_id, &key, held).map(|_| ())
            })
        };
        if let Err(first) = commit_held() {
            // The provider already ran: retry the commit only. On a second failure the hold and the claim are both
            // released, each whatever the other does (`Promise.allSettled`); a failed release is the answer, else
            // the second commit's failure.
            if let Err(again) = commit_held() {
                let released = holds::release(x.pool, &s.user_id, &key);
                let dropped = release_claim(claimed);
                released?;
                dropped?;
                drop(first);
                return Err(again.into());
            }
        }
        release_claim(claimed)?;
        if own {
            let _ = publish_usage_alerts(x, Some(&s.user_id));
        }
        let r = refuse(
            "agents.spend_limit",
            "agents.refused.spend_cap",
            vec![
                audit::param("limit", format_amount(held)),
                audit::param("asset", fee),
                audit::param("scope", "call"),
            ],
        );
        return Err(append_refusal(x, &s, r, cx));
    }

    // 4 · Meter and audit together.
    let ceiling = s.guardrail.limits.max_spend_per_session;
    let prompt = canonical_prompt(input.system, input.messages);
    let input_digest = digest_of_text(&prompt);
    let output_digest = digest_of_text(&done.result.text);
    let committed = db::transaction_retrying(x.pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let mut recorded = false;
        let mut window = None;
        if let (true, Some(cap)) = (should_meter, ceiling) {
            tx.query(
                "SELECT id FROM agents.agent_sessions WHERE id = $1::text::uuid FOR UPDATE",
                &[&s.id],
            )
            .map_err(StoreError::from)?;
            let spent = meter::session_spend(tx, &s.id).map_err(RunError::from)?;
            if spent + cost > cap {
                return Err(TxError::Ceiling(cap));
            }
        }
        if should_meter {
            let r = meter::record(
                x.m,
                tx,
                &UsageInput {
                    session_id: &s.id,
                    request_id: input.request_id,
                    task: input.task,
                    provider_id: &done.result.provider_id,
                    model: &route.model,
                    input_tokens: u64::try_from(usage.input_tokens).unwrap_or(0),
                    output_tokens: u64::try_from(usage.output_tokens).unwrap_or(0),
                    price: ModelPrice {
                        input_per_million: price.input_per_million,
                        output_per_million: price.output_per_million,
                    },
                    at: x.now,
                },
            )
            .map_err(RunError::from)?;
            recorded = r.recorded;
            window = Some(r.window_id);
        }
        let action = audit::append(
            tx,
            &audit::Entry {
                session_id: &s.id,
                user_id: &s.user_id,
                agent_id: &s.agent_id,
                kind: "completion",
                status: "executed",
                task: Some(input.task),
                provider_id: Some(&done.result.provider_id),
                model: Some(&route.model),
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cost: if recorded { cost } else { 0 },
                user_message_key: "agents.action.completed",
                user_message_params: vec![audit::param("task", input.task)],
                input_digest: Some(&input_digest),
                output_digest: Some(&output_digest),
                ..audit::Entry::default()
            },
            x.now,
        )?;
        if x.rt.transcript_retention_days > 0 {
            tx.execute(
                "INSERT INTO agents.agent_transcripts (action_id, user_id, text, expires_at)
                 VALUES ($1::text::uuid, $2::text, $3::text, now() + make_interval(days => $4::text::int))",
                &[&action.id, &s.user_id, &prompt, &x.rt.transcript_retention_days.to_string()],
            )
            .map_err(StoreError::from)?;
        }
        if reserved.is_some() {
            // The cap counts this call's cost even when metering is off; the row's zero is the bill, not the cap.
            holds::commit_in(tx, &s.user_id, &key, cost).map_err(RunError::from)?;
        }
        Ok((action, recorded, window))
    });
    let (action, metered, window_id) = match committed {
        Ok(v) => v,
        Err(TxError::Ceiling(cap)) => {
            release_hold()?;
            let r = refuse(
                "agents.spend_limit",
                "agents.refused.spend_limit",
                vec![
                    audit::param("limit", format_amount(cap)),
                    audit::param("asset", fee),
                ],
            );
            return Err(append_refusal(x, &s, r, cx));
        }
        Err(TxError::Run(e)) => {
            release_hold()?;
            let provider = Some((done.result.provider_id.as_str(), route.model.as_str()));
            return Err(append_failure(x, &s, cx, provider, e));
        }
    };

    publish_completed(x, &action, usage)?;
    if reserved.is_some() && own {
        let _ = publish_usage_alerts(x, Some(&s.user_id));
    }
    Ok(ThinkResult {
        text: done.result.text,
        usage,
        cost: if metered { cost } else { 0 },
        metered,
        window_id,
        route,
        action,
    })
}

/// The hold of \`think\` (2c): the amount held, or why not. A committed hold is a replay while metering is on; while it
/// is off the next key is \`requestId:N\`.
#[allow(
    clippy::too_many_arguments,
    reason = "the hold reads the call as think holds it"
)]
fn hold(
    x: &Rt<'_>,
    s: &SessionRecord,
    input: &ThinkInput<'_>,
    worst: Amount,
    funds: Option<&dyn Funds>,
    should_meter: bool,
    key: &mut String,
    claimed: bool,
) -> Result<Amount, RunError> {
    let reserve = |k: &str| {
        holds::reserve(
            x.pool,
            &ReserveInput {
                user_id: &s.user_id,
                session_id: &s.id,
                reservation_key: k,
                asset_id: &x.m.fee_asset_id,
                amount: worst,
                now: x.now,
                agent_cap: s.guardrail.limits.max_spend_per_session,
                funds: funds.map(|f| (f, s.agent_id.as_str())),
                overage_grace: x.rt.overage_grace,
                team_run: input.team_run,
            },
        )
    };
    let mut held = reserve(key)?;
    let _ = claimed;
    if held.status == "committed" && should_meter {
        return Err(RunError::Agent(denied(
            "agents.request_id_replay",
            "agents.error.request_id_replay",
            format!(
                "Request id \"{}\" already reserved on session {}",
                input.request_id, s.id
            ),
            vec![audit::param("requestId", input.request_id)],
        )));
    }
    if held.replayed && held.status == "committed" && !should_meter {
        let n = holds::committed_uses(x.pool, &s.user_id, input.request_id)?;
        *key = format!("{}:{n}", input.request_id);
        held = reserve(key)?;
    }
    if held.replayed && (held.status == "held" || held.status == "committed") {
        return Err(RunError::Agent(denied(
            "agents.spend_reservation_conflict",
            "agents.refused.spend_reservation_conflict",
            format!("Reservation {key} is still held"),
            vec![],
        )));
    }
    Ok(held.amount)
}
