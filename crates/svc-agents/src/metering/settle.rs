//! Settling a window, as the runtime does it (`AgentRuntime.settleWindow` and `settleSession` in `runtime.ts`): the
//! session read, the metering-off law, the meter's seal and charge, then, for a settlement that happened, one
//! `usage_settlement` row in the session's action log and, for one that billed, one `agentUsageSettled` event.
//!
//! Metering off (`AGENTS_METERING_ENABLED`, law D26-P1-A6): nothing is sealed or posted, leftover windows included;
//! the answer is the stub (`meteringOffSettlementStub`): amount 0, no charge, not settled.

use postgres::IsolationLevel;

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::audit;
use crate::db::{self, StoreError};
use crate::errors::AgentError;
use crate::metering::Metering;
use crate::metering::meter::{self, MeterError, Settlement};
use crate::metering::pricing::charge_key_for;

/// `agentUsageSettled`'s subject.
pub const USAGE_SETTLED: &str = "intafaced.agents.usage.settled";

/// The session a settlement reads (`SessionRecord`, the fields it uses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub user_id: String,
    pub agent_id: String,
}

/// `runtime.session(id)`: the session, or none.
pub fn session(pool: &Pool, session_id: &str) -> Result<Option<Session>, StoreError> {
    db::with_client(pool, |c| {
        let rows = c.query(
            "SELECT user_id, agent_id FROM agents.agent_sessions WHERE id = $1::text::uuid",
            &[&session_id],
        )?;
        Ok(match rows.first() {
            Some(r) => Some(Session {
                user_id: r.try_get(0)?,
                agent_id: r.try_get(1)?,
            }),
            None => None,
        })
    })
}

/// `meteringOffSettlementStub`.
pub fn metering_off_stub(session_id: &str, window_id: &str) -> Settlement {
    Settlement {
        session_id: session_id.to_owned(),
        window_id: window_id.to_owned(),
        charge_key: charge_key_for(session_id, window_id),
        amount: 0,
        charge_tx_id: None,
        settled: false,
    }
}

/// A random version-4 uuid (`crypto.randomUUID()`), an event's id.
pub fn random_uuid() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex.get(0..8).unwrap_or_default(),
        hex.get(8..12).unwrap_or_default(),
        hex.get(12..16).unwrap_or_default(),
        hex.get(16..20).unwrap_or_default(),
        hex.get(20..32).unwrap_or_default()
    ))
}

/// `buildEnvelope('agentUsageSettled', payload, producer, { idempotencyKey: chargeKey })`.
pub fn usage_settled_envelope(
    m: &Metering,
    s: &Settlement,
    user_id: &str,
    at: Instant,
) -> Result<Json, String> {
    Ok(Json::obj([
        ("id", Json::str(random_uuid()?)),
        ("subject", Json::str(USAGE_SETTLED)),
        ("version", Json::int(1)),
        ("occurredAt", Json::str(at.iso())),
        ("producer", Json::str(m.producer.clone())),
        ("idempotencyKey", Json::str(s.charge_key.clone())),
        (
            "payload",
            Json::obj([
                ("sessionId", Json::str(s.session_id.clone())),
                ("userId", Json::str(user_id)),
                ("windowId", Json::str(s.window_id.clone())),
                ("amount", Json::str(format_amount(s.amount))),
                ("assetId", Json::str(m.fee_asset_id.clone())),
                ("chargeKey", Json::str(s.charge_key.clone())),
            ]),
        ),
    ]))
}

/// `settleWindow(sessionId, windowId)`.
pub fn settle_window(
    m: &Metering,
    pool: &Pool,
    session_id: &str,
    window_id: &str,
    now: Instant,
) -> Result<Settlement, MeterError> {
    let Some(session) = session(pool, session_id)? else {
        return Err(MeterError::Agent(AgentError {
            code: "agents.session_not_found",
            user_key: "agents.refused.session_closed".to_owned(),
            message: format!("No session {session_id}"),
        }));
    };
    // D26-P1-A6: never a charge while metering is off, leftover windows included.
    if !m.enabled {
        return Ok(metering_off_stub(session_id, window_id));
    }
    let result = meter::settle(m, pool, session_id, &session.user_id, window_id)?;
    // Only a settlement that happened is logged: a repeat finds the window sealed and appends nothing.
    if result.settled {
        let (key, params) = if result.amount > 0 {
            (
                "agents.usage.settled",
                vec![
                    audit::param("amount", format_amount(result.amount)),
                    audit::param("asset", m.fee_asset_id.clone()),
                ],
            )
        } else {
            ("agents.usage.free", Vec::new())
        };
        let entry = audit::Entry {
            session_id,
            user_id: &session.user_id,
            agent_id: &session.agent_id,
            kind: "usage_settlement",
            status: "executed",
            cost: result.amount,
            user_message_key: key,
            user_message_params: params,
            ..audit::Entry::default()
        };
        db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 5, |tx| {
            audit::append(tx, &entry, now).map(|_| ())
        })?;
        if result.amount > 0 {
            let envelope = usage_settled_envelope(m, &result, &session.user_id, now)
                .map_err(|e| MeterError::Store(StoreError::new(e, None)))?;
            m.bus
                .publish(USAGE_SETTLED, &result.charge_key, &envelope)
                .map_err(|e| MeterError::Store(StoreError::new(e, None)))?;
        }
    }
    Ok(result)
}

/// `settleSession(sessionId)`: every window still needing settle work, oldest first; the first failure stops it.
pub fn settle_session(
    m: &Metering,
    pool: &Pool,
    session_id: &str,
    now: Instant,
) -> Result<Vec<Settlement>, MeterError> {
    meter::open_windows(pool, session_id)?
        .iter()
        .map(|w| settle_window(m, pool, session_id, w, now))
        .collect()
}
