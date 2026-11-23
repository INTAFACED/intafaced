//! The soft alert and the monthly hard limit a person sets for one of their own agents (`own/usage-limits.ts`,
//! `own/usage-limits-routes.ts`, J-agents-02). Only the owner reads or writes them; another person's agent reads as
//! not found. Neither is a balance and neither moves value. The hold that admits a run against the hard limit, and the
//! commit that records the month's alert, are the runtime's (`crate::runtime::holds`); this module shares their reads.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::super::evals::in_transaction;
use super::super::store::is_uuid;
use super::super::{OwnError, OwnRefusal};
use crate::db::StoreError;
use crate::metering::spend::period_start;
use crate::runtime::holds::{
    own_agent_spent, read_usage_limits, record_usage_alert, usage_alert_key, usage_month,
};

/// `parseOptional`: blank is not set; anything else must be a decimal amount above zero.
fn parse_optional(value: Option<&str>) -> Result<Option<Amount>, OwnRefusal> {
    let text = js_trim(value.unwrap_or(""));
    if text.is_empty() {
        return Ok(None);
    }
    match parse_amount(text) {
        Ok(a) if a > Amount::ZERO => Ok(Some(a)),
        _ => Err(OwnRefusal::new("agents.usage.limit_invalid")),
    }
}

/// `assertOwned`: the owner's own agent, locked for a write.
fn assert_owned(
    c: &mut impl GenericClient,
    owner_id: &str,
    agent_id: &str,
    lock: bool,
) -> Result<Result<(), OwnError>, StoreError> {
    if !is_uuid(agent_id) {
        return Ok(Err(OwnRefusal::new("agents.own.not_found").into()));
    }
    let sql = if lock {
        "SELECT 1::int FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid FOR UPDATE"
    } else {
        "SELECT 1::int FROM agents.own_agents WHERE owner_id = $1::text AND id = $2::text::uuid"
    };
    if c.query(sql, &[&owner_id, &agent_id])?.is_empty() {
        return Ok(Err(OwnRefusal::new("agents.own.not_found").into()));
    }
    Ok(Ok(()))
}

/// `OwnUsageLimitsView`, then the fee asset the route adds (`ownAgentUsageLimitsSchema`'s order).
fn view(
    c: &mut impl GenericClient,
    owner_id: &str,
    agent_id: &str,
    now: Instant,
    asset_id: &str,
) -> Result<Json, StoreError> {
    let limits = read_usage_limits(c, owner_id, agent_id)?;
    let month = usage_month(now);
    let since = period_start("month", now);
    let spent = own_agent_spent(c, owner_id, agent_id, since, false)?;
    // The same measure the hard limit admits runs against: what was spent plus every run still held at its worst case.
    let used = own_agent_spent(c, owner_id, agent_id, since, true)?;
    let alerts = c.query(
        "SELECT alert_key, spent::text FROM agents.own_agent_usage_alerts WHERE alert_key = $1::text",
        &[&usage_alert_key(agent_id, &month)],
    )?;
    let alert = match alerts.first() {
        Some(r) => {
            let spent: String = r.try_get(1)?;
            let spent = parse_amount(&spent)
                .map_err(|e| StoreError::new(format!("a stored amount is not one: {e}"), None))?;
            Some((r.try_get::<_, String>(0)?, spent))
        }
        None => None,
    };
    let alert_at = limits.as_ref().and_then(|l| l.alert_at);
    let hard_limit = limits.as_ref().and_then(|l| l.hard_limit);
    let money = |a: Option<Amount>| a.map_or(Json::Null, |a| Json::str(format_amount(a)));
    Ok(Json::obj([
        ("alertAt", money(alert_at)),
        ("hardLimit", money(hard_limit)),
        (
            "email",
            Json::Bool(limits.as_ref().is_some_and(|l| l.email)),
        ),
        ("month", Json::str(month)),
        ("spent", Json::str(format_amount(spent))),
        ("alertCrossed", Json::Bool(alert.is_some())),
        (
            "alert",
            alert.map_or(Json::Null, |(key, spent)| {
                Json::obj([
                    ("key", Json::str(key)),
                    ("spent", Json::str(format_amount(spent))),
                ])
            }),
        ),
        (
            "hardLimitReached",
            Json::Bool(hard_limit.is_some_and(|h| used >= h)),
        ),
        (
            "hardLimitRoom",
            money(hard_limit.map(|h| if h > used { h - used } else { Amount::ZERO })),
        ),
        ("assetId", Json::str(asset_id)),
    ]))
}

/// `OwnUsageLimitsStore.get`: reading also records this month's alert when the spend already reached it and no row
/// says so yet, so a commit whose alert write failed is caught up here.
pub fn get(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    asset_id: &str,
    now: Instant,
) -> Result<Json, OwnError> {
    in_transaction(pool, |tx| {
        if let Err(e) = assert_owned(tx, owner_id, agent_id, false)? {
            return Ok(Err(e));
        }
        record_usage_alert(tx, owner_id, agent_id, asset_id, now)?;
        Ok(Ok(view(tx, owner_id, agent_id, now, asset_id)?))
    })
}

/// What the person asks to store: an alert, a hard limit (blank clears either) and whether the alert is emailed.
pub struct Wanted<'a> {
    pub alert_at: Option<&'a str>,
    pub hard_limit: Option<&'a str>,
    pub email: bool,
}

/// `OwnUsageLimitsStore.set`: blank clears one; the alert must sit below the hard limit when both are set. An alert
/// already passed this month is recorded on save.
pub fn set(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    wanted: &Wanted<'_>,
    asset_id: &str,
    now: Instant,
) -> Result<Json, OwnError> {
    let email = wanted.email;
    let alert_at = parse_optional(wanted.alert_at)?;
    let hard_limit = parse_optional(wanted.hard_limit)?;
    if let (Some(a), Some(h)) = (alert_at, hard_limit)
        && a >= h
    {
        return Err(OwnRefusal::with(
            "agents.usage.alert_above_limit",
            [("limit", format_amount(h))],
        )
        .into());
    }
    in_transaction(pool, |tx| {
        if let Err(e) = assert_owned(tx, owner_id, agent_id, true)? {
            return Ok(Err(e));
        }
        tx.execute(
            "INSERT INTO agents.own_agent_usage_limits (agent_id, owner_id, alert_at, hard_limit, email)
             VALUES ($1::text::uuid, $2::text, $3::text::numeric, $4::text::numeric, $5)
             ON CONFLICT (agent_id) DO UPDATE
                SET alert_at = EXCLUDED.alert_at,
                    hard_limit = EXCLUDED.hard_limit,
                    email = EXCLUDED.email,
                    updated_at = now()",
            &[
                &agent_id,
                &owner_id,
                &alert_at.map(format_amount),
                &hard_limit.map(format_amount),
                &email,
            ],
        )?;
        // An alert set at or below what the agent already spent this month is reached now, not at the next run.
        record_usage_alert(tx, owner_id, agent_id, asset_id, now)?;
        Ok(Ok(view(tx, owner_id, agent_id, now, asset_id)?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_is_not_set_and_zero_negative_or_unreadable_is_invalid() {
        for blank in [None, Some(""), Some(" ")] {
            assert_eq!(parse_optional(blank), Ok(None));
        }
        for bad in ["0", "-1", "lots"] {
            assert_eq!(
                parse_optional(Some(bad)).err().map(|r| r.code).as_deref(),
                Some("agents.usage.limit_invalid"),
                "{bad}"
            );
        }
        assert!(parse_optional(Some("0.5")).unwrap().is_some());
    }
}
