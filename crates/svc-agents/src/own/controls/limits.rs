//! The caps a person sets for one of their own agents (`own/limits.ts`, AG-spend-01): per call, per session and per
//! month, all three or none. Only the owner reads or writes them; another person's agent reads as not found. A cap is
//! a ceiling on holds, not a balance: nothing here moves value. The holds read them through
//! `crate::runtime::holds::read_own_caps`.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::pg::Pool;

use super::super::evals::in_transaction;
use super::super::store::is_uuid;
use super::super::{OwnError, OwnRefusal};
use crate::db::{self, StoreError};

/// One row: the agent's own cap, and the person's caps for it (each none until set).
struct Row {
    agent_cap: Option<String>,
    per_call: Option<String>,
    per_session: Option<String>,
    per_period: Option<String>,
    period: Option<String>,
}

/// `parseLimit`: blank refuses as unset; anything else that is not a decimal amount at or above zero is invalid.
fn parse_limit(value: Option<&str>) -> Result<Amount, OwnRefusal> {
    let text = js_trim(value.unwrap_or(""));
    if text.is_empty() {
        return Err(OwnRefusal::new("agents.spend.cap_unset"));
    }
    match parse_amount(text) {
        Ok(a) if a >= Amount::ZERO => Ok(a),
        _ => Err(OwnRefusal::new("agents.own.cap_invalid")),
    }
}

fn amount(t: &str) -> Result<Amount, StoreError> {
    parse_amount(t).map_err(|e| StoreError::new(format!("a stored amount is not one: {e}"), None))
}

fn read_row(
    c: &mut impl GenericClient,
    owner_id: &str,
    agent_id: &str,
) -> Result<Option<Row>, StoreError> {
    if !is_uuid(agent_id) {
        return Ok(None);
    }
    let rows = c.query(
        "SELECT a.per_session_cap::text, l.per_call::text, l.per_session::text, l.per_period::text, l.period
           FROM agents.own_agents a
           LEFT JOIN agents.own_agent_limits l ON l.agent_id = a.id AND l.owner_id = a.owner_id
          WHERE a.owner_id = $1::text AND a.id = $2::text::uuid",
        &[&owner_id, &agent_id],
    )?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    Ok(Some(Row {
        agent_cap: r.try_get(0)?,
        per_call: r.try_get(1)?,
        per_session: r.try_get(2)?,
        per_period: r.try_get(3)?,
        period: r.try_get(4)?,
    }))
}

/// `OwnLimitsView`, with the owner's values the route adds: the overage grace (null when blank) and the fee asset.
pub struct LimitsView {
    /// `(perCall, perSession, perPeriod)`, the period always `month`.
    limits: Option<(Amount, Amount, Amount)>,
    agent_cap: Option<Amount>,
    effective_per_session: Option<Amount>,
}

impl LimitsView {
    /// `ownAgentLimitsSchema`, in its order.
    pub fn to_json(&self, overage_grace: Option<Amount>, asset_id: &str) -> Json {
        let money = |a: Option<Amount>| a.map_or(Json::Null, |a| Json::str(format_amount(a)));
        Json::obj([
            (
                "limits",
                self.limits.map_or(Json::Null, |(call, session, period)| {
                    Json::obj([
                        ("perCall", Json::str(format_amount(call))),
                        ("perSession", Json::str(format_amount(session))),
                        ("perPeriod", Json::str(format_amount(period))),
                        ("period", Json::str("month")),
                    ])
                }),
            ),
            ("agentCap", money(self.agent_cap)),
            ("effectivePerSession", money(self.effective_per_session)),
            ("overageGrace", money(overage_grace)),
            ("assetId", Json::str(asset_id)),
        ])
    }
}

fn view(row: &Row) -> Result<LimitsView, StoreError> {
    let agent_cap = row.agent_cap.as_deref().map(amount).transpose()?;
    let limits = match (
        &row.per_call,
        &row.per_session,
        &row.per_period,
        &row.period,
    ) {
        (Some(call), Some(session), Some(period), Some(p)) if !p.is_empty() => {
            Some((amount(call)?, amount(session)?, amount(period)?))
        }
        _ => None,
    };
    let effective_per_session = match (limits, agent_cap) {
        (Some((_, session, _)), Some(cap)) => Some(session.min(cap)),
        _ => None,
    };
    Ok(LimitsView {
        limits,
        agent_cap,
        effective_per_session,
    })
}

/// `OwnLimitsStore.get`.
pub fn get(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<LimitsView, OwnError> {
    let row = db::with_client(pool, |c| read_row(c, owner_id, agent_id))?;
    let Some(row) = row else {
        return Err(OwnRefusal::new("agents.own.not_found").into());
    };
    Ok(view(&row)?)
}

/// `OwnLimitsStore.set`: all three caps at once, or none. A per-call or per-session value above the agent's own cap is
/// refused rather than lowered, as is a per-call value above the per-session one; an agent with no cap of its own takes
/// no limits until it has one.
pub fn set(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    per_call: Option<&str>,
    per_session: Option<&str>,
    per_period: Option<&str>,
) -> Result<LimitsView, OwnError> {
    let per_call = parse_limit(per_call)?;
    let per_session = parse_limit(per_session)?;
    let per_period = parse_limit(per_period)?;
    in_transaction(pool, |tx| {
        if !is_uuid(agent_id) {
            return Ok(Err(OwnRefusal::new("agents.own.not_found").into()));
        }
        let agents = tx.query(
            "SELECT per_session_cap::text FROM agents.own_agents
              WHERE owner_id = $1::text AND id = $2::text::uuid FOR UPDATE",
            &[&owner_id, &agent_id],
        )?;
        let Some(agent) = agents.first() else {
            return Ok(Err(OwnRefusal::new("agents.own.not_found").into()));
        };
        let Some(cap) = agent.try_get::<_, Option<String>>(0)? else {
            return Ok(Err(OwnRefusal::new("agents.spend.cap_unset").into()));
        };
        let cap = amount(&cap)?;
        if per_session > cap || per_call > cap {
            return Ok(Err(OwnRefusal::with(
                "agents.spend.above_agent_cap",
                [("cap", format_amount(cap))],
            )
            .into()));
        }
        if per_call > per_session {
            return Ok(Err(
                OwnRefusal::new("agents.spend.per_call_above_session").into()
            ));
        }
        tx.execute(
            "INSERT INTO agents.own_agent_limits (agent_id, owner_id, per_call, per_session, per_period, period)
             VALUES ($1::text::uuid, $2::text, $3::text::numeric, $4::text::numeric, $5::text::numeric, 'month')
             ON CONFLICT (agent_id) DO UPDATE
                SET per_call = EXCLUDED.per_call,
                    per_session = EXCLUDED.per_session,
                    per_period = EXCLUDED.per_period,
                    updated_at = now()",
            &[
                &agent_id,
                &owner_id,
                &format_amount(per_call),
                &format_amount(per_session),
                &format_amount(per_period),
            ],
        )?;
        let Some(row) = read_row(tx, owner_id, agent_id)? else {
            return Ok(Err(OwnRefusal::new("agents.own.not_found").into()));
        };
        Ok(Ok(view(&row)?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_cap_is_unset_and_a_negative_or_unreadable_one_is_invalid() {
        let code = |v: Option<&str>| parse_limit(v).err().map(|r| r.code);
        for blank in [None, Some(""), Some("  ")] {
            assert_eq!(code(blank).as_deref(), Some("agents.spend.cap_unset"));
        }
        for bad in ["-1", "lots"] {
            assert_eq!(
                code(Some(bad)).as_deref(),
                Some("agents.own.cap_invalid"),
                "{bad}"
            );
        }
        assert_eq!(parse_limit(Some(" 0 ")), Ok(Amount::ZERO));
    }
}
