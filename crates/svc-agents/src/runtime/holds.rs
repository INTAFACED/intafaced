//! The runtime's spend holds (\`services/svc-agents/src/spend/store.ts\`, \`UserSpendStore.reserve\`, \`commitIn\`,
//! \`release\`, \`releaseStaleHolds\`), with what they check under the person's lock: their own caps, the agent's cap per
//! session, the caps and the month's hard limit of an agent they built (\`own/limits.ts\`, \`own/usage-limits.ts\`), a
//! team session's allocation, project limits and pool (\`team/hold.ts\`), and the funds the run is checked against.
//!
//! A hold is not a balance and no ledger recipe is called: value moves only when a window settles. Two runs at once
//! cannot both count one cap or one balance: every check runs under \`pg_advisory_xact_lock\` on the person.

use postgres::{GenericClient, IsolationLevel, Transaction};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::{Instant, civil_from_days, days_from_civil};

use crate::db::{self, Retryable, StoreError};
use crate::metering::pricing::{ModelPrice, UsageGroup, window_cost};
use crate::metering::spend::{self, SpendError, decide_reservation, period_start};
use crate::runtime::funds::{self, Funds, Outcome, is_uuid};
use crate::runtime::{Denied, denied};

const OWN_PREFIX: &str = "own.";
/// \`TEAM_RUN_KEY_PREFIX\`: only the team run route, which reads membership first, makes these holds.
pub const TEAM_RUN_KEY_PREFIX: &str = "team:";

/// Why a hold, commit or release did not happen.
#[derive(Debug, Clone, PartialEq)]
pub enum HoldError {
    Denied(Denied),
    Store(StoreError),
}

impl From<StoreError> for HoldError {
    fn from(e: StoreError) -> HoldError {
        HoldError::Store(e)
    }
}
impl From<postgres::Error> for HoldError {
    fn from(e: postgres::Error) -> HoldError {
        HoldError::Store(StoreError::from(e))
    }
}
impl From<SpendError> for HoldError {
    fn from(e: SpendError) -> HoldError {
        match e {
            SpendError::Agent(a) => HoldError::Denied(Denied {
                error: a,
                params: Vec::new(),
            }),
            SpendError::Store(s) => HoldError::Store(s),
        }
    }
}
impl Retryable for HoldError {
    fn store(&self) -> Option<&StoreError> {
        match self {
            HoldError::Store(s) => Some(s),
            HoldError::Denied(_) => None,
        }
    }
}

fn deny(code: &'static str, key: &str, message: String, params: Vec<(String, Json)>) -> HoldError {
    HoldError::Denied(denied(code, key, message, params))
}

fn s(k: &str, v: impl Into<String>) -> (String, Json) {
    (k.to_owned(), Json::String(v.into()))
}

fn amount_text(t: &str) -> Result<Amount, StoreError> {
    parse_amount(t).map_err(|e| StoreError::new(format!("a stored amount is not one: {e}"), None))
}

/// One reservation (\`SpendReservationView\`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    pub reservation_key: String,
    pub session_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub committed_amount: Option<Amount>,
    pub status: String,
    pub replayed: bool,
}

const RES_COLUMNS: &str =
    "reservation_key, session_id::text, asset_id, amount::text, committed_amount::text, status";

fn reservation_of(r: &postgres::Row, replayed: bool) -> Result<Reservation, StoreError> {
    let committed: Option<String> = r.try_get(4)?;
    Ok(Reservation {
        reservation_key: r.try_get(0)?,
        session_id: r.try_get(1)?,
        asset_id: r.try_get(2)?,
        amount: amount_text(&r.try_get::<_, String>(3)?)?,
        committed_amount: committed.as_deref().map(amount_text).transpose()?,
        status: r.try_get(5)?,
        replayed,
    })
}

fn lock_user(tx: &mut impl GenericClient, user_id: &str) -> Result<(), StoreError> {
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        &[&format!("agents.spend:{user_id}")],
    )?;
    Ok(())
}

fn sum_of(rows: &[postgres::Row]) -> Result<Amount, StoreError> {
    match rows.first() {
        Some(r) => amount_text(&r.try_get::<_, String>(0)?),
        None => Ok(0),
    }
}

const HELD_OR_COMMITTED: &str = "COALESCE(SUM(CASE WHEN r.status = 'held' THEN r.amount
      WHEN r.status = 'committed' THEN r.committed_amount ELSE 0::numeric END), 0::numeric)::text";

/// \`summed\`: held and committed holds of one session, or of the person since a period started.
fn summed_session(
    tx: &mut impl GenericClient,
    user_id: &str,
    session_id: &str,
) -> Result<Amount, StoreError> {
    sum_of(&tx.query(
        &format!(
            "SELECT {HELD_OR_COMMITTED} FROM agents.spend_reservations r
              WHERE r.user_id = $1::text AND r.session_id = $2::text::uuid AND r.status IN ('held', 'committed')"
        ),
        &[&user_id, &session_id],
    )?)
}

fn summed_since(
    tx: &mut impl GenericClient,
    user_id: &str,
    since: Instant,
) -> Result<Amount, StoreError> {
    sum_of(&tx.query(
        &format!(
            "SELECT {HELD_OR_COMMITTED} FROM agents.spend_reservations r
              WHERE r.user_id = $1::text AND r.created_at >= $2::text::timestamptz AND r.status IN ('held', 'committed')"
        ),
        &[&user_id, &since.iso()],
    )?)
}

/// \`ownAgentUsed\`: held and committed holds on this person's sessions of one own agent since \`since\`.
fn own_agent_used(
    tx: &mut impl GenericClient,
    user_id: &str,
    agent_id: &str,
    since: Instant,
) -> Result<Amount, StoreError> {
    sum_of(&tx.query(
        &format!(
            "SELECT {HELD_OR_COMMITTED}
               FROM agents.spend_reservations r
               JOIN agents.agent_sessions s ON s.id = r.session_id
              WHERE r.user_id = $1::text AND s.user_id = $1::text AND s.agent_id = $2::text
                AND r.created_at >= $3::text::timestamptz AND r.status IN ('held', 'committed')"
        ),
        &[&user_id, &agent_id, &since.iso()],
    )?)
}

/// \`OwnCaps\`: what a hold of an own agent is checked against.
pub(crate) struct OwnCaps {
    pub(crate) per_call: Amount,
    pub(crate) per_session: Amount,
    pub(crate) per_period: Amount,
    pub(crate) period: String,
}

/// \`readOwnCaps\`: the agent's own cap per session and the person's caps for it, or none when any is unset.
pub(crate) fn read_own_caps(
    tx: &mut impl GenericClient,
    owner: &str,
    agent: &str,
) -> Result<Option<OwnCaps>, StoreError> {
    if !is_uuid(agent) {
        return Ok(None);
    }
    let rows = tx.query(
        "SELECT a.per_session_cap::text, l.per_call::text, l.per_session::text, l.per_period::text, l.period
           FROM agents.own_agents a
           LEFT JOIN agents.own_agent_limits l ON l.agent_id = a.id AND l.owner_id = a.owner_id
          WHERE a.owner_id = $1::text AND a.id = $2::text::uuid",
        &[&owner, &agent],
    )?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let get =
        |i: usize| -> Result<Option<String>, StoreError> { Ok(r.try_get::<_, Option<String>>(i)?) };
    let (Some(cap), Some(call), Some(session), Some(period_amount), Some(period)) =
        (get(0)?, get(1)?, get(2)?, get(3)?, get(4)?)
    else {
        return Ok(None);
    };
    if period.is_empty() {
        return Ok(None);
    }
    let per_session = amount_text(&session)?.min(amount_text(&cap)?);
    Ok(Some(OwnCaps {
        per_call: amount_text(&call)?.min(per_session),
        per_session,
        per_period: amount_text(&period_amount)?,
        period,
    }))
}

/// `OwnUsageLimits`: what the person set; none is not set.
pub(crate) struct UsageLimits {
    pub(crate) alert_at: Option<Amount>,
    pub(crate) hard_limit: Option<Amount>,
    pub(crate) email: bool,
}

/// `readOwnUsageLimits`: the person's usage limits for one own agent, or none when they set none.
pub(crate) fn read_usage_limits(
    tx: &mut impl GenericClient,
    owner: &str,
    agent: &str,
) -> Result<Option<UsageLimits>, StoreError> {
    if !is_uuid(agent) {
        return Ok(None);
    }
    let rows = tx.query(
        "SELECT alert_at::text, hard_limit::text, email FROM agents.own_agent_usage_limits
          WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
        &[&owner, &agent],
    )?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    Ok(Some(UsageLimits {
        alert_at: r
            .try_get::<_, Option<String>>(0)?
            .as_deref()
            .map(amount_text)
            .transpose()?,
        hard_limit: r
            .try_get::<_, Option<String>>(1)?
            .as_deref()
            .map(amount_text)
            .transpose()?,
        email: r.try_get(2)?,
    }))
}

/// \`usageMonth\`: the UTC month a spend counts in, \`YYYY-MM\`.
pub fn usage_month(at: Instant) -> String {
    at.iso().chars().take(7).collect()
}

/// \`usageAlertKey\`.
pub fn usage_alert_key(agent_id: &str, month: &str) -> String {
    format!("agents.usage_alert:{agent_id}:{month}")
}

fn next_month(since: Instant) -> Instant {
    let (y, m, _) = civil_from_days(since.0.div_euclid(86_400_000));
    let (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    Instant(days_from_civil(y, m, 1) * 86_400_000)
}

/// `ownAgentSpent`: committed holds of one own agent in the month starting at `since`; with `held`, runs still held
/// count at their worst case too.
pub(crate) fn own_agent_spent(
    tx: &mut impl GenericClient,
    user_id: &str,
    agent: &str,
    since: Instant,
    held: bool,
) -> Result<Amount, StoreError> {
    let statuses = if held {
        "('committed', 'held')"
    } else {
        "('committed')"
    };
    sum_of(&tx.query(
        &format!(
            "SELECT COALESCE(SUM(CASE WHEN r.status = 'held' THEN r.amount ELSE r.committed_amount END), 0::numeric)::text
               FROM agents.spend_reservations r
               JOIN agents.agent_sessions s ON s.id = r.session_id
              WHERE r.user_id = $1::text AND s.user_id = $1::text AND s.agent_id = $2::text
                AND r.status IN {statuses}
                AND r.created_at >= $3::text::timestamptz AND r.created_at < $4::text::timestamptz"
        ),
        &[&user_id, &format!("{OWN_PREFIX}{agent}"), &since.iso(), &next_month(since).iso()],
    )?)
}

/// \`assertBelowHardLimit\`.
fn assert_below_hard_limit(
    tx: &mut impl GenericClient,
    user_id: &str,
    agent: &str,
    asset_id: &str,
    used: Amount,
    amount: Amount,
    now: Instant,
) -> Result<(), HoldError> {
    let Some(limit) = read_usage_limits(tx, user_id, agent)?.and_then(|l| l.hard_limit) else {
        return Ok(());
    };
    if used + amount > limit {
        let month = usage_month(now);
        return Err(deny(
            "agents.usage.hard_limit_reached",
            "agents.refused.hard_limit_reached",
            format!(
                "Own agent run worst case {} {asset_id} does not fit under the hard limit {} for {month}",
                format_amount(amount),
                format_amount(limit)
            ),
            vec![
                s("limit", format_amount(limit)),
                s("asset", asset_id),
                s("month", month),
            ],
        ));
    }
    Ok(())
}

/// \`noteUsageAlert\`: the month's alert of the own agent behind this reservation, once its committed spend reached it.
fn note_usage_alert(
    tx: &mut impl GenericClient,
    user_id: &str,
    reservation_key: &str,
) -> Result<(), StoreError> {
    let rows = tx.query(
        "SELECT s.agent_id, r.asset_id, floor(extract(epoch FROM r.created_at) * 1000)::bigint
           FROM agents.spend_reservations r
           JOIN agents.agent_sessions s ON s.id = r.session_id
          WHERE r.user_id = $1::text AND r.reservation_key = $2::text AND r.status = 'committed'",
        &[&user_id, &reservation_key],
    )?;
    let Some(r) = rows.first() else {
        return Ok(());
    };
    let agent_id: String = r.try_get(0)?;
    let Some(agent) = agent_id.strip_prefix(OWN_PREFIX) else {
        return Ok(());
    };
    let asset_id: String = r.try_get(1)?;
    // The month the run was held in, which is the month its spend counts in, even when it commits after midnight.
    let at = Instant(r.try_get(2)?);
    record_usage_alert(tx, user_id, agent, &asset_id, at)
}

/// `recordUsageAlert`: the month's alert when this agent's committed spend in the month of `at` reached the alert the
/// person set. Once per agent and month: a month already recorded is not summed again, and a second crossing writes
/// nothing.
pub(crate) fn record_usage_alert(
    tx: &mut impl GenericClient,
    user_id: &str,
    agent: &str,
    asset_id: &str,
    at: Instant,
) -> Result<(), StoreError> {
    let month = usage_month(at);
    let key = usage_alert_key(agent, &month);
    if !tx
        .query(
            "SELECT 1::int FROM agents.own_agent_usage_alerts WHERE alert_key = $1::text",
            &[&key],
        )?
        .is_empty()
    {
        return Ok(());
    }
    let Some(limits) = read_usage_limits(tx, user_id, agent)? else {
        return Ok(());
    };
    let Some(alert_at) = limits.alert_at else {
        return Ok(());
    };
    let spent = own_agent_spent(tx, user_id, agent, period_start("month", at), false)?;
    if spent < alert_at {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO agents.own_agent_usage_alerts (alert_key, agent_id, owner_id, month, alert_at, spent, asset_id, email)
         VALUES ($1::text, $2::text::uuid, $3::text, $4::text, $5::text::numeric, $6::text::numeric, $7::text, $8)
         ON CONFLICT DO NOTHING",
        &[&key, &agent, &user_id, &month, &format_amount(alert_at), &format_amount(spent), &asset_id, &limits.email],
    )?;
    Ok(())
}

fn team_exceeded(scope: &str, cap: Amount, asset_id: &str) -> HoldError {
    let code = match scope {
        "allocation" => "agents.team.allocation_exceeded",
        "project" => "agents.team.project_limit_exceeded",
        _ => "agents.team.pool_exceeded",
    };
    deny(
        code,
        "agents.refused.spend_cap",
        format!(
            "Team {scope} limit {} {asset_id} would be passed",
            format_amount(cap)
        ),
        vec![
            s("limit", format_amount(cap)),
            s("asset", asset_id),
            s("scope", scope),
        ],
    )
}

/// \`used\`: held and committed holds on the business's team sessions, of the members named (all when none).
fn team_used(
    tx: &mut impl GenericClient,
    business: &str,
    members: Option<&[String]>,
) -> Result<Amount, StoreError> {
    let members =
        members.map(|m| Json::Array(m.iter().map(|x| Json::str(x.clone())).collect()).compact());
    sum_of(&tx.query(
        "SELECT COALESCE(SUM(CASE WHEN r.status = 'held' THEN r.amount ELSE r.committed_amount END), 0::numeric)::text
           FROM agents.spend_reservations r
           JOIN agents.team_sessions t ON t.session_id = r.session_id AND t.member_user_id = r.user_id
          WHERE t.business_id = $1::text::uuid AND r.status IN ('held', 'committed')
            AND ($2::text IS NULL OR t.member_user_id IN (SELECT jsonb_array_elements_text($2::text::jsonb)))",
        &[&business, &members],
    )?)
}

/// \`holdAgainstTeam\`: a team session's hold against the member's allocation, each project they are in, and the pool.
fn hold_against_team(
    tx: &mut impl GenericClient,
    user_id: &str,
    session_id: &str,
    reservation_key: &str,
    asset_id: &str,
    amount: Amount,
    team_run: bool,
) -> Result<(), HoldError> {
    let rows = tx.query(
        "SELECT business_id::text, member_user_id FROM agents.team_sessions WHERE session_id = $1::text::uuid",
        &[&session_id],
    )?;
    let Some(r) = rows.first() else {
        return Ok(());
    };
    let business: String = r.try_get(0)?;
    let member: String = r.try_get(1)?;
    if member != user_id || !team_run || !reservation_key.starts_with(TEAM_RUN_KEY_PREFIX) {
        return Err(deny(
            "agents.session_not_found",
            "agents.refused.session_closed",
            format!("No session {session_id}"),
            vec![],
        ));
    }
    // \`lockBusiness\` (team/store.ts).
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        &[&format!("agents.team:{business}")],
    )?;
    let pool = tx.query(
        "SELECT asset_id, pool_limit::text FROM agents.team_pools WHERE business_id = $1::text::uuid",
        &[&business],
    )?;
    let allocation = if pool.is_empty() {
        None
    } else {
        tx.query(
            "SELECT amount::text FROM agents.team_pool_allocations
              WHERE business_id = $1::text::uuid AND member_user_id = $2::text",
            &[&business, &user_id],
        )?
        .first()
        .map(|r| r.try_get::<_, String>(0))
        .transpose()?
    };
    let pool_row = pool.first();
    let pool_asset: Option<String> = pool_row.map(|r| r.try_get(0)).transpose()?;
    let (Some(pool_row), Some(allocation)) = (pool_row, allocation) else {
        return Err(deny(
            "agents.team.allocation_unset",
            "agents.refused.spend_limit_unset",
            "Team allocation is unset".to_owned(),
            vec![],
        ));
    };
    if pool_asset.as_deref() != Some(asset_id) {
        return Err(deny(
            "agents.team.allocation_unset",
            "agents.refused.spend_limit_unset",
            "Team allocation is unset".to_owned(),
            vec![],
        ));
    }
    let cap = amount_text(&allocation)?;
    if team_used(tx, &business, Some(&[user_id.to_owned()]))? + amount > cap {
        return Err(team_exceeded("allocation", cap, asset_id));
    }
    let projects = tx.query(
        "SELECT p.id::text, p.project_limit::text
           FROM agents.team_projects p
           JOIN agents.team_project_members m ON m.project_id = p.id
          WHERE p.business_id = $1::text::uuid AND m.member_user_id = $2::text
          ORDER BY p.seq",
        &[&business, &user_id],
    )?;
    for p in &projects {
        let id: String = p.try_get(0)?;
        let members: Vec<String> = tx
            .query("SELECT member_user_id FROM agents.team_project_members WHERE project_id = $1::text::uuid", &[&id])?
            .iter()
            .map(|m| m.try_get::<_, String>(0))
            .collect::<Result<_, _>>()?;
        let limit = amount_text(&p.try_get::<_, String>(1)?)?;
        if team_used(tx, &business, Some(&members))? + amount > limit {
            return Err(team_exceeded("project", limit, asset_id));
        }
    }
    let pool_limit = amount_text(&pool_row.try_get::<_, String>(1)?)?;
    if team_used(tx, &business, None)? + amount > pool_limit {
        return Err(team_exceeded("pool", pool_limit, asset_id));
    }
    Ok(())
}

/// \`exposure\`: what the person owes or holds already: usage in every uncharged window of theirs, plus every hold
/// still held in this asset; and the part of it in sealed windows the ledger refused.
fn exposure(
    tx: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
) -> Result<(Amount, Amount), StoreError> {
    let rows = tx.query(
        "SELECT r.session_id::text, r.window_id, w.sealed_at IS NOT NULL,
                SUM(r.input_tokens)::text, SUM(r.output_tokens)::text,
                r.input_price_per_million::text, r.output_price_per_million::text
           FROM agents.usage_records r
           JOIN agents.usage_windows w ON w.session_id = r.session_id AND w.window_id = r.window_id
           JOIN agents.agent_sessions s ON s.id = r.session_id
          WHERE s.user_id = $1::text AND w.charge_tx_id IS NULL
          GROUP BY r.session_id, r.window_id, w.sealed_at, r.input_price_per_million, r.output_price_per_million",
        &[&user_id],
    )?;
    let mut windows: Vec<(String, bool, Vec<UsageGroup>)> = Vec::new();
    for r in &rows {
        let key = format!(
            "{}:{}",
            r.try_get::<_, String>(0)?,
            r.try_get::<_, String>(1)?
        );
        let sealed: bool = r.try_get(2)?;
        let tokens = |i: usize| -> Result<Amount, StoreError> {
            let t: Option<String> = r.try_get(i)?;
            t.as_deref()
                .unwrap_or("0")
                .parse::<Amount>()
                .map_err(|e| StoreError::new(e.to_string(), None))
        };
        let group = UsageGroup {
            input_tokens: tokens(3)?,
            output_tokens: tokens(4)?,
            price: ModelPrice {
                input_per_million: amount_text(&r.try_get::<_, String>(5)?)?,
                output_per_million: amount_text(&r.try_get::<_, String>(6)?)?,
            },
        };
        match windows.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, _, groups)) => groups.push(group),
            None => windows.push((key, sealed, vec![group])),
        }
    }
    let (mut owed, mut sealed_unpaid) = (0, 0);
    for (_, sealed, groups) in &windows {
        let cost = window_cost(groups).map_err(|e| StoreError::new(e.0, None))?;
        owed += cost;
        if *sealed {
            sealed_unpaid += cost;
        }
    }
    let held = sum_of(&tx.query(
        "SELECT COALESCE(SUM(amount), 0)::text FROM agents.spend_reservations
          WHERE user_id = $1::text AND asset_id = $2::text AND status = 'held'",
        &[&user_id, &asset_id],
    )?)?;
    Ok((owed + held, sealed_unpaid))
}

fn spend_limit(cap: Amount, asset_id: &str, scope: &str) -> HoldError {
    deny(
        "agents.spend_limit",
        "agents.refused.spend_cap",
        format!(
            "Spend {scope} cap {} {asset_id} would be exceeded",
            format_amount(cap)
        ),
        vec![
            s("limit", format_amount(cap)),
            s("asset", asset_id),
            s("scope", scope),
        ],
    )
}

fn own_cap_exceeded(cap: Amount, asset_id: &str, scope: &str) -> HoldError {
    deny(
        "agents.spend.cap_exceeded",
        "agents.refused.spend_cap",
        format!(
            "Own agent {scope} cap {} {asset_id} would be exceeded",
            format_amount(cap)
        ),
        vec![
            s("limit", format_amount(cap)),
            s("asset", asset_id),
            s("scope", scope),
        ],
    )
}

/// What a hold is asked for (\`SpendGate.reserve\`'s input).
pub struct ReserveInput<'a> {
    pub user_id: &'a str,
    pub session_id: &'a str,
    pub reservation_key: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
    pub now: Instant,
    /// The agent's stored cap per session.
    pub agent_cap: Option<Amount>,
    /// The funds this run is checked against, read under the hold's lock.
    pub funds: Option<(&'a dyn Funds, &'a str)>,
    pub overage_grace: Option<Amount>,
    pub team_run: bool,
}

fn unset(message: &str) -> HoldError {
    deny(
        "agents.spend_limit_unset",
        "agents.refused.spend_limit_unset",
        message.to_owned(),
        vec![],
    )
}

/// \`reserve\`: the worst case held before the engine is called, in one transaction under the person's lock.
pub fn reserve(pool: &Pool, input: &ReserveInput<'_>) -> Result<Reservation, HoldError> {
    let wanted = format_amount(input.amount);
    let amount = spend::parse_spend_amount(Some(&wanted), "reservation")?;
    let asset_id = input.asset_id.trim();
    if asset_id.is_empty() {
        return Err(unset("Reservation asset is blank"));
    }
    let key = input.reservation_key.trim();
    if key.is_empty() || key.encode_utf16().count() > 200 {
        return Err(deny(
            "agents.spend_limit_invalid",
            "agents.refused.spend_limit_invalid",
            "Reservation key is blank".to_owned(),
            vec![],
        ));
    }
    let not_found = || {
        deny(
            "agents.session_not_found",
            "agents.refused.session_closed",
            format!("No session {}", input.session_id),
            vec![],
        )
    };
    if !is_uuid(input.session_id) {
        return Err(not_found());
    }
    db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 5, |tx| {
        lock_user(tx, input.user_id)?;
        let session = tx.query(
            "SELECT user_id, agent_id FROM agents.agent_sessions WHERE id = $1::text::uuid",
            &[&input.session_id],
        )?;
        let Some(sr) = session.first() else {
            return Err(not_found());
        };
        let (owner, agent_id): (String, String) = (sr.try_get(0)?, sr.try_get(1)?);
        if owner != input.user_id {
            return Err(not_found());
        }
        let own_agent = agent_id.strip_prefix(OWN_PREFIX);
        let own = match own_agent {
            Some(a) => read_own_caps(tx, input.user_id, a)?,
            None => None,
        };
        if own_agent.is_some() && own.is_none() {
            return Err(deny(
                "agents.spend.cap_unset",
                "agents.refused.spend_limit_unset",
                "Own agent caps are unset".to_owned(),
                vec![],
            ));
        }
        let limit = spend::read_limit(tx, input.user_id)?;
        if limit.is_none() && input.agent_cap.is_none() && own.is_none() {
            return Err(unset("User spend limit is unset"));
        }
        if let Some(l) = &limit
            && l.asset_id != asset_id
        {
            return Err(deny(
                "agents.spend_limit_invalid",
                "agents.refused.spend_limit_invalid",
                format!(
                    "Reservation asset {asset_id} does not match the spend limit asset {}",
                    l.asset_id
                ),
                vec![],
            ));
        }
        let existing = tx.query(
            &format!(
                "SELECT {RES_COLUMNS} FROM agents.spend_reservations
                  WHERE user_id = $1::text AND reservation_key = $2::text FOR UPDATE"
            ),
            &[&input.user_id, &key],
        )?;
        let prior = existing
            .first()
            .map(|r| reservation_of(r, true))
            .transpose()?;
        if let Some(p) = &prior
            && p.status != "released"
        {
            let same =
                p.session_id == input.session_id && p.asset_id == asset_id && p.amount == amount;
            if !same {
                return Err(deny(
                    "agents.spend_reservation_conflict",
                    "agents.refused.spend_reservation_conflict",
                    format!("Reservation key {key} is already held for a different call"),
                    vec![],
                ));
            }
            return Ok(p.clone());
        }
        let session_used = summed_session(tx, input.user_id, input.session_id)?;
        if let Some(l) = &limit {
            let period_used = summed_since(tx, input.user_id, period_start(&l.period, input.now))?;
            if let Err((scope, cap)) = decide_reservation(l, session_used, period_used, amount) {
                return Err(spend_limit(cap, asset_id, scope));
            }
        }
        if let (Some(own), Some(agent)) = (&own, own_agent) {
            if amount > own.per_call {
                return Err(own_cap_exceeded(own.per_call, asset_id, "call"));
            }
            if session_used + amount > own.per_session {
                return Err(own_cap_exceeded(own.per_session, asset_id, "session"));
            }
            let month_used = own_agent_used(
                tx,
                input.user_id,
                &agent_id,
                period_start(&own.period, input.now),
            )?;
            if month_used + amount > own.per_period {
                return Err(own_cap_exceeded(own.per_period, asset_id, "month"));
            }
            let used = own_agent_used(
                tx,
                input.user_id,
                &agent_id,
                period_start("month", input.now),
            )?;
            assert_below_hard_limit(tx, input.user_id, agent, asset_id, used, amount, input.now)?;
        }
        hold_against_team(
            tx,
            input.user_id,
            input.session_id,
            key,
            asset_id,
            amount,
            input.team_run,
        )?;
        if let Some(cap) = input.agent_cap
            && session_used + amount > cap
        {
            return Err(spend_limit(cap, asset_id, "session"));
        }
        if let Some((funds, agent)) = input.funds {
            let (owed_all, sealed_unpaid) = exposure(tx, input.user_id, asset_id)?;
            let grace = input.overage_grace.unwrap_or(0);
            let owed = owed_all - sealed_unpaid.min(grace);
            let read = funds.available(pool, input.user_id, asset_id, agent, input.session_id);
            let worst = format_amount(amount);
            let reading = match read {
                Err(unread) => {
                    return Err(deny(
                        "agents.funds_unread",
                        "agents.refused.funds_unread",
                        format!("Available balance could not be read to cover {worst} {asset_id}"),
                        funds::refusal_params(&worst, asset_id, &Outcome::Unread(unread)),
                    ));
                }
                Ok(r) => r,
            };
            if let Some(short) = funds::shortfall(&reading, owed, amount) {
                let unread = matches!(short, Outcome::Unread(_));
                return Err(deny(
                    if unread {
                        "agents.funds_unread"
                    } else {
                        "agents.funds_insufficient"
                    },
                    if unread {
                        "agents.refused.funds_unread"
                    } else {
                        "agents.refused.funds_insufficient"
                    },
                    if unread {
                        format!("Available balance could not be read to cover {worst} {asset_id}")
                    } else {
                        format!(
                            "Available balance does not cover {worst} {asset_id} after {} owed",
                            format_amount(owed)
                        )
                    },
                    funds::refusal_params(&worst, asset_id, &short),
                ));
            }
        }
        let rows = if prior.is_some() {
            tx.query(
                &format!(
                    "UPDATE agents.spend_reservations
                        SET session_id = $3::text::uuid, asset_id = $4::text, amount = $5::text::numeric,
                            committed_amount = NULL, status = 'held',
                            created_at = $6::text::timestamptz, updated_at = $6::text::timestamptz
                      WHERE user_id = $1::text AND reservation_key = $2::text
                     RETURNING {RES_COLUMNS}"
                ),
                &[&input.user_id, &key, &input.session_id, &asset_id, &wanted, &input.now.iso()],
            )?
        } else {
            tx.query(
                &format!(
                    "INSERT INTO agents.spend_reservations
                       (user_id, reservation_key, session_id, asset_id, amount, status, created_at, updated_at)
                     VALUES ($1::text, $2::text, $3::text::uuid, $4::text, $5::text::numeric, 'held',
                             $6::text::timestamptz, $6::text::timestamptz)
                     RETURNING {RES_COLUMNS}"
                ),
                &[&input.user_id, &key, &input.session_id, &asset_id, &wanted, &input.now.iso()],
            )?
        };
        match rows.first() {
            Some(r) => Ok(reservation_of(r, false)?),
            None => Err(unset("Reservation was not stored")),
        }
    })
}

fn missing(key: &str) -> HoldError {
    deny(
        "agents.spend_reservation_not_found",
        "agents.refused.spend_reservation_missing",
        format!("No reservation {key}"),
        vec![],
    )
}

fn closed(message: String) -> HoldError {
    deny(
        "agents.spend_reservation_closed",
        "agents.refused.spend_reservation_closed",
        message,
        vec![],
    )
}

/// \`finish\`: a commit at \`amount\`, or a release.
fn finish(
    tx: &mut impl GenericClient,
    user_id: &str,
    reservation_key: &str,
    commit: Option<Amount>,
) -> Result<Reservation, HoldError> {
    let key = reservation_key.trim();
    if key.is_empty() {
        return Err(deny(
            "agents.spend_limit_invalid",
            "agents.refused.spend_limit_invalid",
            "Reservation key is blank".to_owned(),
            vec![],
        ));
    }
    let rows = tx.query(
        &format!(
            "SELECT {RES_COLUMNS} FROM agents.spend_reservations
              WHERE user_id = $1::text AND reservation_key = $2::text FOR UPDATE"
        ),
        &[&user_id, &key],
    )?;
    let Some(row) = rows.first().map(|r| reservation_of(r, true)).transpose()? else {
        return Err(missing(key));
    };
    let Some(actual) = commit else {
        if row.status == "released" {
            return Ok(row);
        }
        if row.status == "committed" {
            return Err(closed(format!("Reservation {key} is already committed")));
        }
        let updated = tx.query(
            &format!(
                "UPDATE agents.spend_reservations SET status = 'released', updated_at = now()
                  WHERE user_id = $1::text AND reservation_key = $2::text RETURNING {RES_COLUMNS}"
            ),
            &[&user_id, &key],
        )?;
        return match updated.first() {
            Some(r) => Ok(reservation_of(r, false)?),
            None => Err(missing(key)),
        };
    };
    let actual = spend::parse_spend_amount(Some(&format_amount(actual)), "committed spend")?;
    if row.status == "committed" {
        if row.committed_amount == Some(actual) {
            return Ok(row);
        }
        return Err(deny(
            "agents.spend_reservation_conflict",
            "agents.refused.spend_reservation_conflict",
            format!("Reservation {key} is already committed for a different amount"),
            vec![],
        ));
    }
    if row.status == "released" {
        return Err(closed(format!("Reservation {key} was released")));
    }
    if actual > row.amount {
        return Err(spend_limit(row.amount, &row.asset_id, "call"));
    }
    let updated = tx.query(
        &format!(
            "UPDATE agents.spend_reservations
                SET status = 'committed', committed_amount = $3::text::numeric, updated_at = now()
              WHERE user_id = $1::text AND reservation_key = $2::text RETURNING {RES_COLUMNS}"
        ),
        &[&user_id, &key, &format_amount(actual)],
    )?;
    match updated.first() {
        Some(r) => Ok(reservation_of(r, false)?),
        None => Err(missing(key)),
    }
}

/// \`commitIn\`: the real cost recorded on the caller's transaction; the commit that brings an own agent's month to
/// its alert records the alert with it, in a savepoint, so an alert that cannot be written never undoes the charge.
pub fn commit_in(
    tx: &mut Transaction<'_>,
    user_id: &str,
    reservation_key: &str,
    amount: Amount,
) -> Result<Reservation, HoldError> {
    lock_user(tx, user_id)?;
    let view = finish(tx, user_id, reservation_key, Some(amount))?;
    if let Ok(mut sp) = tx.transaction()
        && note_usage_alert(&mut sp, user_id, reservation_key).is_ok()
    {
        let _ = sp.commit();
    }
    Ok(view)
}

/// \`release\`: a hold that never ran, dropped.
pub fn release(
    pool: &Pool,
    user_id: &str,
    reservation_key: &str,
) -> Result<Reservation, HoldError> {
    db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 5, |tx| {
        lock_user(tx, user_id)?;
        finish(tx, user_id, reservation_key, None)
    })
}

/// How many committed holds of this person already use a request id (\`requestId\` or \`requestId:N\`): the next key
/// a metering-off repeat holds under.
pub fn committed_uses(pool: &Pool, user_id: &str, request_id: &str) -> Result<i64, StoreError> {
    db::with_client(pool, |c| {
        let r = c.query_one(
            "SELECT count(*)::text FROM agents.spend_reservations
              WHERE user_id = $1::text AND status = 'committed'
                AND (reservation_key = $2::text OR strpos(reservation_key, $3::text) = 1)",
            &[&user_id, &request_id, &format!("{request_id}:")],
        )?;
        r.try_get::<_, String>(0)?
            .parse()
            .map_err(|e: std::num::ParseIntError| StoreError::new(e.to_string(), None))
    })
}

/// \`releaseStaleHolds\`: holds older than an owner-set age, released with their think claims; a hold whose usage was
/// recorded stays held. No default age: blank refuses.
pub fn release_stale_holds(
    pool: &Pool,
    max_age: Option<&str>,
    now: Instant,
) -> Result<i64, HoldError> {
    let age = max_age.map(str::trim).unwrap_or_default();
    if age.is_empty() {
        return Err(deny(
            "agents.spend_hold_max_age_unset",
            "agents.refused.spend_hold_max_age_unset",
            "Spend hold max age is unset — refusing rather than inventing an age".to_owned(),
            vec![],
        ));
    }
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let ok = match age.split_once('.') {
        None => digits(age),
        Some((a, b)) => digits(a) && digits(b),
    };
    if !ok {
        return Err(deny(
            "agents.spend_limit_invalid",
            "agents.refused.spend_limit_invalid",
            "Spend hold max age is not a number of seconds".to_owned(),
            vec![],
        ));
    }
    db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 5, |tx| {
        let users = tx.query(
            "SELECT DISTINCT user_id FROM agents.spend_reservations
              WHERE status = 'held' AND created_at < $1::text::timestamptz - ($2::text::numeric * interval '1 second')
              ORDER BY user_id",
            &[&now.iso(), &age],
        )?;
        for u in &users {
            lock_user(tx, &u.try_get::<_, String>(0)?)?;
        }
        let r = tx.query_one(
            "WITH doomed AS (
               SELECT r.user_id, r.reservation_key, r.session_id
                 FROM agents.spend_reservations r
                WHERE r.status = 'held'
                  AND r.created_at < $1::text::timestamptz - ($2::text::numeric * interval '1 second')
                  AND NOT EXISTS (SELECT 1 FROM agents.usage_records u
                                   WHERE u.session_id = r.session_id AND u.request_id = r.reservation_key)
                FOR UPDATE OF r
             ),
             released_rows AS (
               UPDATE agents.spend_reservations r SET status = 'released', updated_at = $1::text::timestamptz
                 FROM doomed d
                WHERE r.user_id = d.user_id AND r.reservation_key = d.reservation_key AND r.status = 'held'
               RETURNING r.session_id, r.reservation_key
             ),
             dropped AS (
               DELETE FROM agents.think_claims c USING released_rows rel
                WHERE c.session_id = rel.session_id AND c.request_id = rel.reservation_key
               RETURNING c.session_id
             )
             SELECT count(*)::text FROM released_rows",
            &[&now.iso(), &age],
        )?;
        r.try_get::<_, String>(0)?
            .parse::<i64>()
            .map_err(|e| HoldError::Store(StoreError::new(e.to_string(), None)))
    })
}
