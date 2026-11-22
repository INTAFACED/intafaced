//! The person's consent to each class of tools their own agent uses (`own/guardrails.ts`, `OwnConsentStore`,
//! AG-guardrails-01). Until a class is granted every call of it is refused `agents.consent_required`
//! (`own::gates::consent_granted`); revoking withdraws it for the next call. One row per class, keyed
//! `agents:consent:<user>:<agent>:<class>`.

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::super::{OwnError, OwnRefusal};
use crate::db::{self, StoreError};
use crate::runtime::ms;

fn columns() -> String {
    format!("data_class, {}, {}", ms("granted_at"), ms("revoked_at"))
}

/// `consentView`.
fn view(r: &postgres::Row) -> Result<Json, StoreError> {
    let revoked: Option<i64> = r.try_get(2)?;
    Ok(Json::obj([
        ("dataClass", Json::str(r.try_get::<_, String>(0)?)),
        (
            "state",
            Json::str(if revoked.is_none() {
                "granted"
            } else {
                "withdrawn"
            }),
        ),
        ("grantedAt", Json::str(Instant(r.try_get(1)?).iso())),
        (
            "revokedAt",
            revoked.map_or(Json::Null, |t| Json::str(Instant(t).iso())),
        ),
    ]))
}

/// `grant`: a repeated grant returns the stored row; a grant after a revoke grants again from now.
pub fn grant(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    data_class: &str,
) -> Result<Json, OwnError> {
    let key = format!("agents:consent:{owner_id}:{agent_id}:{data_class}");
    Ok(db::with_client(pool, |c| {
        let rows = c.query(
            &format!(
                "INSERT INTO agents.own_agent_consents (agent_id, owner_id, data_class, consent_key)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text)
                 ON CONFLICT (owner_id, agent_id, data_class) DO UPDATE
                   SET granted_at = CASE WHEN own_agent_consents.revoked_at IS NULL THEN own_agent_consents.granted_at ELSE now() END,
                       revoked_at = NULL,
                       updated_at = CASE WHEN own_agent_consents.revoked_at IS NULL THEN own_agent_consents.updated_at ELSE now() END
                 RETURNING {}",
                columns()
            ),
            &[&agent_id, &owner_id, &data_class, &key],
        )?;
        let row = rows
            .first()
            .ok_or_else(|| StoreError::new("the consent upsert returned no row", None))?;
        view(row)
    })?)
}

/// `revoke`: withdraws a class; one never granted is not one to withdraw. A repeated revoke returns the stored row.
pub fn revoke(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    data_class: &str,
) -> Result<Json, OwnError> {
    let row = db::with_client(pool, |c| {
        let rows = c.query(
            &format!(
                "UPDATE agents.own_agent_consents
                    SET revoked_at = COALESCE(revoked_at, now()),
                        updated_at = CASE WHEN revoked_at IS NULL THEN now() ELSE updated_at END
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND data_class = $3::text
                 RETURNING {}",
                columns()
            ),
            &[&owner_id, &agent_id, &data_class],
        )?;
        rows.first().map(view).transpose()
    })?;
    row.ok_or_else(|| {
        OwnRefusal::with(
            "agents.consent_not_granted",
            [("dataClass", data_class.to_owned())],
        )
        .into()
    })
}

/// `list`: one row per class, by class.
pub fn list(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        let rows = c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_consents
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY data_class",
                columns()
            ),
            &[&owner_id, &agent_id],
        )?;
        rows.iter().map(view).collect::<Result<Vec<_>, _>>()
    })?;
    Ok(Json::Array(rows))
}
