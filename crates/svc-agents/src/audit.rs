//! The action log's append (`services/svc-agents/src/fleet/audit.ts`, `AuditLog.append`): every action a session takes
//! is one row of `agent_actions`, append-only (the migration's trigger) and tamper-evident: each row's
//! `hash = SHA-256(prev_hash ‖ canonical row)`, chained per session. Metering appends its `usage_settlement` rows here;
//! the log's reads come with the `runtime` slice.

use postgres::GenericClient;
use sha2::{Digest, Sha256};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;

/// One action to append (`AuditEntry`); what metering writes needs only these fields, every other one is its default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry<'a> {
    pub session_id: &'a str,
    pub user_id: &'a str,
    pub agent_id: &'a str,
    pub kind: &'a str,
    pub status: &'a str,
    pub cost: Amount,
    pub user_message_key: &'a str,
    /// `userMessageParams`, each value as the string it hashes as.
    pub user_message_params: Vec<(String, String)>,
}

/// The canonical row `hashAction` hashes, after `prev_hash`: a fixed-order array, never an object.
#[expect(
    clippy::too_many_arguments,
    reason = "the row's own fields, in their hashed order"
)]
pub fn hash_action(
    session_id: &str,
    user_id: &str,
    agent_id: &str,
    sequence: i64,
    kind: &str,
    status: &str,
    cost: Amount,
    user_message_key: &str,
    params: &[(String, String)],
    occurred_at: Instant,
    prev_hash: Option<&str>,
) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let canonical = Json::Array(vec![
        Json::str(session_id),
        Json::str(user_id),
        Json::str(agent_id),
        Json::int(sequence),
        Json::str(kind),
        Json::str(status),
        Json::Null,
        Json::Null,
        Json::Null,
        Json::Null,
        Json::str("0"),
        Json::str("0"),
        Json::str(format_amount(cost)),
        Json::Null,
        Json::str(user_message_key),
        Json::Array(
            sorted
                .iter()
                .map(|(k, v)| Json::Array(vec![Json::str(k.clone()), Json::str(v.clone())]))
                .collect(),
        ),
        Json::Null,
        Json::Null,
        Json::str(occurred_at.iso()),
    ])
    .compact();
    let digest = Sha256::digest(format!("{}{canonical}", prev_hash.unwrap_or("")).as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// `append(tx, entry)`: inside the caller's transaction, with the session row locked so two actions on one session queue
/// for the next sequence instead of racing to it.
pub fn append(
    tx: &mut impl GenericClient,
    entry: &Entry<'_>,
    occurred_at: Instant,
) -> Result<(), postgres::Error> {
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
        entry.session_id,
        entry.user_id,
        entry.agent_id,
        sequence,
        entry.kind,
        entry.status,
        entry.cost,
        entry.user_message_key,
        &entry.user_message_params,
        occurred_at,
        prev_hash.as_deref(),
    );
    let params = Json::Object(
        entry
            .user_message_params
            .iter()
            .map(|(k, v)| (k.clone(), Json::str(v.clone())))
            .collect(),
    )
    .compact();
    tx.execute(
        "INSERT INTO agents.agent_actions (
           session_id, user_id, agent_id, sequence, kind, status,
           input_tokens, output_tokens, cost, user_message_key, user_message_params,
           prev_hash, hash, occurred_at
         ) VALUES (
           $1::text::uuid, $2::text, $3::text, $4::text::int, $5::text::agents.action_kind, $6::text::agents.action_status,
           0, 0, $7::text::numeric, $8::text, $9::text::jsonb, $10::text, $11::text, $12::text::timestamptz
         )",
        &[
            &entry.session_id,
            &entry.user_id,
            &entry.agent_id,
            &sequence.to_string(),
            &entry.kind,
            &entry.status,
            &format_amount(entry.cost),
            &entry.user_message_key,
            &params,
            &prev_hash,
            &hash,
            &occurred_at.iso(),
        ],
    )?;
    Ok(())
}
