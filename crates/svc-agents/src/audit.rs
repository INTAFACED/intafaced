//! The action log (\`services/svc-agents/src/fleet/audit.ts\`, \`AuditLog\`): every action a session takes is one row of
//! \`agent_actions\`, append-only (the migration's trigger) and tamper-evident: each row's
//! \`hash = SHA-256(prev_hash ‖ canonical row)\`, chained per session. Refusals are appended with the same ceremony as
//! successes. The reads are the user-visible log: keys and parameters, never sentences, and always one person's own.

use postgres::GenericClient;
use sha2::{Digest, Sha256};

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::db::{self, StoreError};

/// One action to append (\`AuditEntry\`); a field left at its default is the TypeScript's default (null, 0, \`{}\`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Entry<'a> {
    pub session_id: &'a str,
    pub user_id: &'a str,
    pub agent_id: &'a str,
    pub kind: &'a str,
    pub status: &'a str,
    pub tool: Option<&'a str>,
    pub task: Option<&'a str>,
    pub provider_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost: Amount,
    pub refusal_code: Option<&'a str>,
    pub user_message_key: &'a str,
    /// \`userMessageParams\`: each value a string or a number, as the TypeScript stores it.
    pub user_message_params: Vec<(String, Json)>,
    pub input_digest: Option<&'a str>,
    pub output_digest: Option<&'a str>,
}

/// A string parameter.
pub fn param(key: &str, value: impl Into<String>) -> (String, Json) {
    (key.to_owned(), Json::String(value.into()))
}

/// A number parameter.
pub fn num(key: &str, value: i64) -> (String, Json) {
    (key.to_owned(), Json::int(value))
}

/// \`String(v)\` of a parameter, as the hash takes it.
fn js_string(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => json::js_number_string(*n),
        other => other.compact(),
    }
}

/// One stored action (\`AuditedAction\`).
#[derive(Debug, Clone, PartialEq)]
pub struct Action {
    pub id: String,
    pub session_id: String,
    pub user_id: String,
    pub agent_id: String,
    pub sequence: i64,
    pub kind: String,
    pub status: String,
    pub tool: Option<String>,
    pub task: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost: Amount,
    pub refusal_code: Option<String>,
    pub user_message_key: String,
    /// The stored \`{}\` of parameters, in the order Postgres keeps it.
    pub user_message_params: Json,
    pub input_digest: Option<String>,
    pub output_digest: Option<String>,
    pub prev_hash: Option<String>,
    pub hash: String,
    pub occurred_at: Instant,
}

fn opt(v: Option<&String>) -> Json {
    v.map_or(Json::Null, |s| Json::str(s.clone()))
}

impl Action {
    /// \`toActionOutput\`: the row as every log read answers it.
    pub fn to_output(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("sessionId", Json::str(self.session_id.clone())),
            ("agentId", Json::str(self.agent_id.clone())),
            ("sequence", Json::int(self.sequence)),
            ("kind", Json::str(self.kind.clone())),
            ("status", Json::str(self.status.clone())),
            ("tool", opt(self.tool.as_ref())),
            ("task", opt(self.task.as_ref())),
            ("model", opt(self.model.as_ref())),
            ("inputTokens", Json::str(self.input_tokens.to_string())),
            ("outputTokens", Json::str(self.output_tokens.to_string())),
            ("cost", Json::str(format_amount(self.cost))),
            ("refusalCode", opt(self.refusal_code.as_ref())),
            ("messageKey", Json::str(self.user_message_key.clone())),
            ("messageParams", self.user_message_params.clone()),
            ("occurredAt", Json::str(self.occurred_at.iso())),
        ])
    }
}

/// The columns every read selects, in [\`action_of\`]'s order. The time is read at the millisecond, as a JavaScript
/// \`Date\` holds it.
pub const ACTION_COLUMNS: &str = "id::text, session_id::text, user_id, agent_id, sequence, kind::text, status::text, \
    tool, task, provider_id, model, input_tokens::text, output_tokens::text, cost::text, refusal_code, \
    user_message_key, user_message_params::text, input_digest, output_digest, prev_hash, hash, \
    floor(extract(epoch FROM occurred_at) * 1000)::bigint";

fn stored(what: &str, e: impl std::fmt::Display) -> StoreError {
    StoreError::new(
        format!("agents.agent_actions holds a {what} this service cannot read: {e}"),
        None,
    )
}

/// One row of [\`ACTION_COLUMNS\`].
pub fn action_of(r: &postgres::Row) -> Result<Action, StoreError> {
    let int = |i: usize| -> Result<i64, StoreError> {
        let t: String = r.try_get(i)?;
        t.parse().map_err(|e| stored("token count", e))
    };
    let cost: String = r.try_get(13)?;
    let params: String = r.try_get(16)?;
    Ok(Action {
        id: r.try_get(0)?,
        session_id: r.try_get(1)?,
        user_id: r.try_get(2)?,
        agent_id: r.try_get(3)?,
        sequence: i64::from(r.try_get::<_, i32>(4)?),
        kind: r.try_get(5)?,
        status: r.try_get(6)?,
        tool: r.try_get(7)?,
        task: r.try_get(8)?,
        provider_id: r.try_get(9)?,
        model: r.try_get(10)?,
        input_tokens: int(11)?,
        output_tokens: int(12)?,
        cost: parse_amount(&cost).map_err(|e| stored("cost", e))?,
        refusal_code: r.try_get(14)?,
        user_message_key: r.try_get(15)?,
        user_message_params: json::parse(&params).map_err(|e| stored("parameter", e.message))?,
        input_digest: r.try_get(17)?,
        output_digest: r.try_get(18)?,
        prev_hash: r.try_get(19)?,
        hash: r.try_get(20)?,
        occurred_at: Instant(r.try_get(21)?),
    })
}

/// What \`hashAction\` hashes: the row's fields, in their fixed order.
#[derive(Debug, Clone, Copy)]
pub struct Hashable<'a> {
    pub session_id: &'a str,
    pub user_id: &'a str,
    pub agent_id: &'a str,
    pub sequence: i64,
    pub kind: &'a str,
    pub status: &'a str,
    pub tool: Option<&'a str>,
    pub task: Option<&'a str>,
    pub provider_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost: Amount,
    pub refusal_code: Option<&'a str>,
    pub user_message_key: &'a str,
    pub params: &'a [(String, Json)],
    pub input_digest: Option<&'a str>,
    pub output_digest: Option<&'a str>,
    pub occurred_at: Instant,
}

/// \`hashAction\`: \`SHA-256(prev_hash ‖ canonical)\`, the canonical row a fixed-order array, never an object; the
/// parameters sorted by key, each value as \`String(v)\`.
pub fn hash_action(a: &Hashable<'_>, prev_hash: Option<&str>) -> String {
    let s = |v: Option<&str>| v.map_or(Json::Null, Json::str);
    let mut sorted: Vec<&(String, Json)> = a.params.iter().collect();
    sorted.sort_by(|x, y| x.0.encode_utf16().cmp(y.0.encode_utf16()));
    let canonical = Json::Array(vec![
        Json::str(a.session_id),
        Json::str(a.user_id),
        Json::str(a.agent_id),
        Json::int(a.sequence),
        Json::str(a.kind),
        Json::str(a.status),
        s(a.tool),
        s(a.task),
        s(a.provider_id),
        s(a.model),
        Json::str(a.input_tokens.to_string()),
        Json::str(a.output_tokens.to_string()),
        Json::str(format_amount(a.cost)),
        s(a.refusal_code),
        Json::str(a.user_message_key),
        Json::Array(
            sorted
                .iter()
                .map(|(k, v)| Json::Array(vec![Json::str(k.clone()), Json::str(js_string(v))]))
                .collect(),
        ),
        s(a.input_digest),
        s(a.output_digest),
        Json::str(a.occurred_at.iso()),
    ])
    .compact();
    let digest = Sha256::digest(format!("{}{canonical}", prev_hash.unwrap_or("")).as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// \`append(tx, entry)\`: inside the caller's transaction, with the session row locked so two actions on one session
/// queue for the next sequence instead of racing to it.
pub fn append(
    tx: &mut impl GenericClient,
    entry: &Entry<'_>,
    occurred_at: Instant,
) -> Result<Action, StoreError> {
    tx.query(
        "SELECT id FROM agents.agent_sessions WHERE id = $1::text::uuid FOR UPDATE",
        &[&entry.session_id],
    )?;
    let tip = tx.query(
        "SELECT sequence, hash FROM agents.agent_actions WHERE session_id = $1::text::uuid
          ORDER BY sequence DESC LIMIT 1",
        &[&entry.session_id],
    )?;
    let (sequence, prev_hash) = match tip.first() {
        Some(r) => (
            i64::from(r.try_get::<_, i32>(0)?) + 1,
            Some(r.try_get::<_, String>(1)?),
        ),
        None => (0, None),
    };
    let hash = hash_action(
        &Hashable {
            session_id: entry.session_id,
            user_id: entry.user_id,
            agent_id: entry.agent_id,
            sequence,
            kind: entry.kind,
            status: entry.status,
            tool: entry.tool,
            task: entry.task,
            provider_id: entry.provider_id,
            model: entry.model,
            input_tokens: entry.input_tokens,
            output_tokens: entry.output_tokens,
            cost: entry.cost,
            refusal_code: entry.refusal_code,
            user_message_key: entry.user_message_key,
            params: &entry.user_message_params,
            input_digest: entry.input_digest,
            output_digest: entry.output_digest,
            occurred_at,
        },
        prev_hash.as_deref(),
    );
    let params = Json::Object(entry.user_message_params.clone()).compact();
    let rows = tx.query(
        &format!(
            "INSERT INTO agents.agent_actions (
               session_id, user_id, agent_id, sequence, kind, status,
               tool, task, provider_id, model,
               input_tokens, output_tokens, cost,
               refusal_code, user_message_key, user_message_params,
               input_digest, output_digest, prev_hash, hash, occurred_at
             ) VALUES (
               $1::text::uuid, $2::text, $3::text, $4::text::int, $5::text::agents.action_kind,
               $6::text::agents.action_status, $7::text, $8::text, $9::text, $10::text,
               $11::text::bigint, $12::text::bigint, $13::text::numeric, $14::text, $15::text, $16::text::jsonb,
               $17::text, $18::text, $19::text, $20::text, $21::text::timestamptz
             )
             RETURNING {ACTION_COLUMNS}"
        ),
        &[
            &entry.session_id,
            &entry.user_id,
            &entry.agent_id,
            &sequence.to_string(),
            &entry.kind,
            &entry.status,
            &entry.tool,
            &entry.task,
            &entry.provider_id,
            &entry.model,
            &entry.input_tokens.to_string(),
            &entry.output_tokens.to_string(),
            &format_amount(entry.cost),
            &entry.refusal_code,
            &entry.user_message_key,
            &params,
            &entry.input_digest,
            &entry.output_digest,
            &prev_hash,
            &hash,
            &occurred_at.iso(),
        ],
    )?;
    rows.first()
        .map(action_of)
        .ok_or_else(|| StoreError::new("agents.agent_actions returned no row", None))?
}

fn many(rows: &[postgres::Row]) -> Result<Vec<Action>, StoreError> {
    rows.iter().map(action_of).collect()
}

/// \`byId\`.
pub fn by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<Action>, StoreError> {
    c.query(
        &format!(
            "SELECT {ACTION_COLUMNS} FROM agents.agent_actions WHERE id = $1::text::uuid LIMIT 1"
        ),
        &[&id],
    )?
    .first()
    .map(action_of)
    .transpose()
}

/// \`forSession\`: one session's log, sequence ascending, \`page\` rows (already held to 1..=500).
pub fn for_session(pool: &Pool, session_id: &str, page: i64) -> Result<Vec<Action>, StoreError> {
    db::with_client(pool, |c| {
        many(&c.query(
            &format!(
                "SELECT {ACTION_COLUMNS} FROM agents.agent_actions WHERE session_id = $1::text::uuid
                  ORDER BY sequence ASC LIMIT $2::text::bigint"
            ),
            &[&session_id, &page.to_string()],
        )?)
    })
}

/// \`forSessionAfter\`: the session's actions after sequence \`after\` (none: from the open at 0).
pub fn for_session_after(
    pool: &Pool,
    session_id: &str,
    after: Option<i64>,
    page: i64,
) -> Result<Vec<Action>, StoreError> {
    db::with_client(pool, |c| {
        many(&c.query(
            &format!(
                "SELECT {ACTION_COLUMNS} FROM agents.agent_actions
                  WHERE session_id = $1::text::uuid AND sequence > $2::text::int
                  ORDER BY sequence ASC LIMIT $3::text::bigint"
            ),
            &[
                &session_id,
                &after.unwrap_or(-1).to_string(),
                &page.to_string(),
            ],
        )?)
    })
}

/// \`forSessionChain\`: the whole chain, for \`verifyChain\`; never paged, so no break is hidden.
pub fn for_session_chain(pool: &Pool, session_id: &str) -> Result<Vec<Action>, StoreError> {
    db::with_client(pool, |c| {
        many(&c.query(
            &format!(
                "SELECT {ACTION_COLUMNS} FROM agents.agent_actions WHERE session_id = $1::text::uuid
                  ORDER BY sequence ASC"
            ),
            &[&session_id],
        )?)
    })
}

/// \`forUser\`: THE USER-VISIBLE LOG, newest first, optionally one outcome only.
pub fn for_user(
    pool: &Pool,
    user_id: &str,
    page: i64,
    status: Option<&str>,
) -> Result<Vec<Action>, StoreError> {
    db::with_client(pool, |c| {
        many(&c.query(
            &format!(
                "SELECT {ACTION_COLUMNS} FROM agents.agent_actions
                  WHERE user_id = $1::text AND ($2::text IS NULL OR status = $2::text::agents.action_status)
                  ORDER BY occurred_at DESC, sequence DESC
                  LIMIT $3::text::bigint"
            ),
            &[&user_id, &status, &page.to_string()],
        )?)
    })
}

/// A position in the exported log: the previous page's last row by time (whole microseconds), session and sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct After {
    pub at_us: String,
    pub session_id: String,
    pub sequence: i64,
}

/// \`forUserAfter\`: the person's whole log a page at a time, newest first, compared at the stored microsecond so a
/// row in the cursor's own millisecond is never skipped. Returns the rows and the last row's microseconds.
pub fn for_user_after(
    pool: &Pool,
    user_id: &str,
    status: Option<&str>,
    after: Option<&After>,
    page: i64,
) -> Result<(Vec<Action>, Option<String>), StoreError> {
    db::with_client(pool, |c| {
        let rows = c.query(
            &format!(
                "SELECT {ACTION_COLUMNS}, (extract(epoch FROM occurred_at) * 1000000)::bigint::text
                   FROM agents.agent_actions
                  WHERE user_id = $1::text
                    AND ($2::text IS NULL OR status = $2::text::agents.action_status)
                    AND ($3::text IS NULL
                         OR (occurred_at, session_id, sequence) < (
                              timestamptz 'epoch' + $3::text::bigint * interval '1 microsecond',
                              $4::text::uuid, $5::text::int))
                  ORDER BY occurred_at DESC, session_id DESC, sequence DESC
                  LIMIT $6::text::bigint"
            ),
            &[
                &user_id,
                &status,
                &after.map(|a| a.at_us.clone()),
                &after.map(|a| a.session_id.clone()),
                &after.map(|a| a.sequence.to_string()),
                &page.to_string(),
            ],
        )?;
        let last = rows
            .last()
            .map(|r| r.try_get::<_, String>(22))
            .transpose()?;
        Ok((many(&rows)?, last))
    })
}

/// \`countForUser\`.
pub fn count_for_user(pool: &Pool, user_id: &str, status: Option<&str>) -> Result<i64, StoreError> {
    db::with_client(pool, |c| {
        let row = c.query_one(
            "SELECT count(*)::int FROM agents.agent_actions
              WHERE user_id = $1::text AND ($2::text IS NULL OR status = $2::text::agents.action_status)",
            &[&user_id, &status],
        )?;
        Ok(i64::from(row.try_get::<_, i32>(0)?))
    })
}

/// \`verifyChain\`'s verdict: whole, or the first sequence that disagrees and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chain {
    Ok,
    Broken {
        at_sequence: i64,
        reason: &'static str,
    },
}

/// \`verifyChain\`: recompute a session's chain; a rewrite made around the service is found here.
pub fn verify_chain(pool: &Pool, session_id: &str) -> Result<Chain, StoreError> {
    let actions = for_session_chain(pool, session_id)?;
    let mut previous: Option<String> = None;
    for (index, a) in actions.iter().enumerate() {
        if usize::try_from(a.sequence).ok() != Some(index) {
            return Ok(Chain::Broken {
                at_sequence: a.sequence,
                reason: "sequence is not dense — an action is missing",
            });
        }
        if a.prev_hash != previous {
            return Ok(Chain::Broken {
                at_sequence: a.sequence,
                reason: "prev_hash does not match the preceding action",
            });
        }
        let params: Vec<(String, Json)> = match &a.user_message_params {
            Json::Object(f) => f.clone(),
            _ => Vec::new(),
        };
        let expected = hash_action(
            &Hashable {
                session_id: &a.session_id,
                user_id: &a.user_id,
                agent_id: &a.agent_id,
                sequence: a.sequence,
                kind: &a.kind,
                status: &a.status,
                tool: a.tool.as_deref(),
                task: a.task.as_deref(),
                provider_id: a.provider_id.as_deref(),
                model: a.model.as_deref(),
                input_tokens: a.input_tokens,
                output_tokens: a.output_tokens,
                cost: a.cost,
                refusal_code: a.refusal_code.as_deref(),
                user_message_key: &a.user_message_key,
                params: &params,
                input_digest: a.input_digest.as_deref(),
                output_digest: a.output_digest.as_deref(),
                occurred_at: a.occurred_at,
            },
            previous.as_deref(),
        );
        if expected != a.hash {
            return Ok(Chain::Broken {
                at_sequence: a.sequence,
                reason: "row contents do not match its recorded hash",
            });
        }
        previous = Some(a.hash.clone());
    }
    Ok(Chain::Ok)
}
