//! A person's own spend caps (`services/svc-agents/src/spend/`: `limits.ts`, `store.ts` `get` and `set`, `routes.ts`).
//!
//! The cap is the person's: the caller is the signed principal, never a user id in the body. A blank cap, asset or
//! period refuses (`agents.spend_limit_unset`), never a default; an explicit zero is a real cap. Two sets with one
//! idempotency key and the same body write once; the same key with another body is refused. A cap is not a balance:
//! nothing here touches the ledger. The holds against the caps (reserve, commit, release) are the runtime's.

use postgres::IsolationLevel;
use sha2::{Digest, Sha256};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::{Instant, civil_from_days, days_from_civil};
use service_kit::trpc::TrpcError;

use crate::db::{self, Retryable, StoreError};
use crate::errors::AgentError;

/// `SpendPeriod`.
pub const PERIODS: [&str; 3] = ["day", "week", "month"];

/// A cap as stored and shown (`SpendLimitView`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    pub asset_id: String,
    pub per_call: Amount,
    pub per_session: Amount,
    pub per_period: Amount,
    pub period: String,
}

impl Limits {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("assetId", Json::str(self.asset_id.clone())),
            ("perCall", Json::str(format_amount(self.per_call))),
            ("perSession", Json::str(format_amount(self.per_session))),
            ("perPeriod", Json::str(format_amount(self.per_period))),
            ("period", Json::str(self.period.clone())),
        ])
    }
}

/// What the spend door can fail with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpendError {
    Agent(AgentError),
    Store(StoreError),
}

impl From<StoreError> for SpendError {
    fn from(e: StoreError) -> SpendError {
        SpendError::Store(e)
    }
}

impl From<postgres::Error> for SpendError {
    fn from(e: postgres::Error) -> SpendError {
        SpendError::Store(StoreError::from(e))
    }
}

impl Retryable for SpendError {
    fn store(&self) -> Option<&StoreError> {
        match self {
            SpendError::Store(s) => Some(s),
            SpendError::Agent(_) => None,
        }
    }
}

/// The spend router's own guard: a cap refusal is FORBIDDEN, a missing session or hold NOT_FOUND, any other domain
/// refusal BAD_REQUEST; anything else is thrown on as it is, so tRPC answers it INTERNAL_SERVER_ERROR with its message.
pub fn to_trpc(e: SpendError) -> TrpcError {
    match e {
        SpendError::Agent(a) => {
            let code = match a.code {
                "agents.spend_limit" | "agents.spend_limit_unset" => "FORBIDDEN",
                "agents.session_not_found" | "agents.spend_reservation_not_found" => "NOT_FOUND",
                _ => "BAD_REQUEST",
            };
            TrpcError::caused(code, a.user_key, a.code)
        }
        SpendError::Store(s) => TrpcError::plain("INTERNAL_SERVER_ERROR", s.message),
    }
}

fn refusal(code: &'static str, key: &str, message: String) -> SpendError {
    SpendError::Agent(AgentError {
        code,
        user_key: key.to_owned(),
        message,
    })
}

fn unset(what: &str) -> SpendError {
    refusal(
        "agents.spend_limit_unset",
        "agents.refused.spend_limit_unset",
        format!("{what} is blank — refusing rather than inventing a spend limit"),
    )
}

fn invalid(what: &str) -> SpendError {
    refusal(
        "agents.spend_limit_invalid",
        "agents.refused.spend_limit_invalid",
        format!("{what} is not a usable spend limit"),
    )
}

/// `storeOf(sql)` with no database.
pub fn database_unset() -> SpendError {
    refusal(
        "agents.capability_unavailable",
        "agents.error.capability_unavailable",
        "Agents database is unset".to_owned(),
    )
}

fn blank(v: Option<&str>) -> bool {
    v.is_none_or(|s| js_trim(s).is_empty())
}

/// `parseSpendAmount`: an unsigned decimal. Blank is unset; negative, junk and extra scale are invalid. Never coerces.
pub fn parse_spend_amount(raw: Option<&str>, field: &str) -> Result<Amount, SpendError> {
    let Some(raw) = raw.filter(|r| !js_trim(r).is_empty()) else {
        return Err(unset(field));
    };
    match parse_amount(js_trim(raw)) {
        Ok(a) if a >= Amount::ZERO => Ok(a),
        _ => Err(invalid(field)),
    }
}

/// The set's input (`parseSpendLimitInput`), each field as the call sent it (absent, null or a string).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetInput {
    pub asset_id: Option<String>,
    pub per_call: Option<String>,
    pub per_session: Option<String>,
    pub per_period: Option<String>,
    pub period: Option<String>,
    pub idempotency_key: Option<String>,
}

/// `parseSpendLimitInput`: the cap and its idempotency key, checked in the TypeScript's order.
pub fn parse_limit_input(input: &SetInput) -> Result<(Limits, String), SpendError> {
    if blank(input.asset_id.as_deref()) {
        return Err(unset("asset"));
    }
    if blank(input.period.as_deref()) {
        return Err(unset("period"));
    }
    if blank(input.idempotency_key.as_deref()) {
        return Err(invalid("idempotency key"));
    }
    let asset_id = js_trim(input.asset_id.as_deref().unwrap_or_default()).to_owned();
    let asset_ok = (1..=32).contains(&asset_id.len())
        && asset_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-');
    if !asset_ok {
        return Err(invalid("asset"));
    }
    let period = js_trim(input.period.as_deref().unwrap_or_default()).to_owned();
    if !PERIODS.contains(&period.as_str()) {
        return Err(invalid("period"));
    }
    let key = js_trim(input.idempotency_key.as_deref().unwrap_or_default()).to_owned();
    if key.encode_utf16().count() > 200 {
        return Err(invalid("idempotency key"));
    }
    Ok((
        Limits {
            asset_id,
            per_call: parse_spend_amount(input.per_call.as_deref(), "per-call limit")?,
            per_session: parse_spend_amount(input.per_session.as_deref(), "per-session limit")?,
            per_period: parse_spend_amount(input.per_period.as_deref(), "per-period limit")?,
            period,
        },
        key,
    ))
}

/// `periodStart`: the UTC day, the week from Monday, or the calendar month. The caller supplies the clock.
pub fn period_start(period: &str, now: Instant) -> Instant {
    let day = now.0.div_euclid(86_400_000);
    let (y, m, _) = civil_from_days(day);
    let start = match period {
        "day" => day,
        "month" => days_from_civil(y, m, 1),
        // 1970-01-01 was a Thursday: Monday is 0 here.
        _ => day - (day + 3).rem_euclid(7),
    };
    Instant(start * 86_400_000)
}

/// `decideReservation`: equal to a cap is allowed, over is not, checked per call, per session, then per period.
pub fn decide_reservation(
    limits: &Limits,
    session_used: Amount,
    period_used: Amount,
    amount: Amount,
) -> Result<(), (&'static str, Amount)> {
    if amount > limits.per_call {
        return Err(("call", limits.per_call));
    }
    if session_used + amount > limits.per_session {
        return Err(("session", limits.per_session));
    }
    if period_used + amount > limits.per_period {
        return Err(("period", limits.per_period));
    }
    Ok(())
}

fn limits_of(row: &postgres::Row) -> Result<Limits, SpendError> {
    let amount = |i: usize| -> Result<Amount, SpendError> {
        let t: String = row.try_get(i)?;
        parse_amount(&t).map_err(|e| SpendError::Store(StoreError::new(e, None)))
    };
    Ok(Limits {
        asset_id: row.try_get(0)?,
        per_call: amount(1)?,
        per_session: amount(2)?,
        per_period: amount(3)?,
        period: row.try_get(4)?,
    })
}

const LIMIT_COLUMNS: &str = "asset_id, per_call::text, per_session::text, per_period::text, period";

/// The person's stored caps, read on the caller's client (a hold reads them under its lock).
pub fn read_limit(
    c: &mut impl postgres::GenericClient,
    user_id: &str,
) -> Result<Option<Limits>, SpendError> {
    c.query(
        &format!("SELECT {LIMIT_COLUMNS} FROM agents.user_spend_limits WHERE user_id = $1::text"),
        &[&user_id],
    )?
    .first()
    .map(limits_of)
    .transpose()
}

/// `UserSpendStore.get`: the person's cap, or none. Unset reads as none, never zero.
pub fn get(pool: &Pool, user_id: &str) -> Result<Option<Limits>, SpendError> {
    db::with_client(pool, |c| {
        read_limit(c, user_id).map_err(|e| match e {
            SpendError::Store(s) => s,
            SpendError::Agent(a) => StoreError::new(a.message, None),
        })
    })
    .map_err(SpendError::Store)
}

/// `UserSpendStore.set`: under the person's advisory lock, the request's key claimed first; a replay of the same body
/// answers the stored cap with `replayed: true`.
pub fn set(pool: &Pool, user_id: &str, input: &SetInput) -> Result<(Limits, bool), SpendError> {
    let (limits, key) = parse_limit_input(input)?;
    let digest: String = Sha256::digest(
        [
            limits.asset_id.clone(),
            format_amount(limits.per_call),
            format_amount(limits.per_session),
            format_amount(limits.per_period),
            limits.period.clone(),
        ]
        .join("\n")
        .as_bytes(),
    )
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect();
    db::transaction_retrying(pool, IsolationLevel::ReadCommitted, 5, |tx| {
        tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            &[&format!("agents.spend:{user_id}")],
        )?;
        let inserted = tx.query(
            "INSERT INTO agents.spend_limit_requests (user_id, idempotency_key, digest)
             VALUES ($1::text, $2::text, $3::text)
             ON CONFLICT (user_id, idempotency_key) DO NOTHING
             RETURNING idempotency_key",
            &[&user_id, &key, &digest],
        )?;
        if inserted.is_empty() {
            let prior = tx.query(
                "SELECT digest FROM agents.spend_limit_requests WHERE user_id = $1::text AND idempotency_key = $2::text",
                &[&user_id, &key],
            )?;
            let same = prior
                .first()
                .map(|r| r.try_get::<_, String>(0))
                .transpose()?
                .is_some_and(|d| d == digest);
            if !same {
                return Err(refusal(
                    "agents.spend_idempotency_conflict",
                    "agents.refused.spend_idempotency_conflict",
                    format!("Idempotency key {key} already stored a different spend limit"),
                ));
            }
            return match read_limit(tx, user_id)? {
                Some(existing) => Ok((existing, true)),
                None => Err(refusal(
                    "agents.spend_limit_unset",
                    "agents.refused.spend_limit_unset",
                    "Stored spend limit row is missing".to_owned(),
                )),
            };
        }
        let rows = tx.query(
            &format!(
                "INSERT INTO agents.user_spend_limits (user_id, asset_id, per_call, per_session, per_period, period)
                 VALUES ($1::text, $2::text, $3::text::numeric, $4::text::numeric, $5::text::numeric, $6::text)
                 ON CONFLICT (user_id) DO UPDATE SET
                   asset_id = EXCLUDED.asset_id, per_call = EXCLUDED.per_call, per_session = EXCLUDED.per_session,
                   per_period = EXCLUDED.per_period, period = EXCLUDED.period, updated_at = now()
                 RETURNING {LIMIT_COLUMNS}"
            ),
            &[
                &user_id,
                &limits.asset_id,
                &format_amount(limits.per_call),
                &format_amount(limits.per_session),
                &format_amount(limits.per_period),
                &limits.period,
            ],
        )?;
        match rows.first() {
            Some(r) => Ok((limits_of(r)?, false)),
            None => Err(refusal(
                "agents.spend_limit_unset",
                "agents.refused.spend_limit_unset",
                "Spend limit was not stored".to_owned(),
            )),
        }
    })
}

#[cfg(test)]
mod tests {
    //! `limits.test.ts`, case for case, with its values.
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    /// `LIMIT`.
    fn limit() -> SetInput {
        let some = |s: &str| Some(s.to_owned());
        SetInput {
            asset_id: some("IFC"),
            per_call: some("1.50"),
            per_session: some("3"),
            per_period: some("10"),
            period: some("day"),
            idempotency_key: some("set-1"),
        }
    }

    fn field<'a>(i: &'a mut SetInput, name: &str) -> &'a mut Option<String> {
        match name {
            "perCall" => &mut i.per_call,
            "perSession" => &mut i.per_session,
            "perPeriod" => &mut i.per_period,
            "assetId" => &mut i.asset_id,
            _ => &mut i.period,
        }
    }

    fn with(name: &str, value: Option<&str>) -> SetInput {
        let mut i = limit();
        *field(&mut i, name) = value.map(str::to_owned);
        i
    }

    fn code(r: Result<(Limits, String), SpendError>) -> &'static str {
        match r {
            Err(SpendError::Agent(a)) => a.code,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn refuses_a_blank_cap_asset_or_period_and_does_not_invent_one() {
        for name in ["perCall", "perSession", "perPeriod", "assetId", "period"] {
            assert_eq!(
                code(parse_limit_input(&with(name, Some("  ")))),
                "agents.spend_limit_unset",
                "{name}"
            );
            assert_eq!(
                code(parse_limit_input(&with(name, None))),
                "agents.spend_limit_unset",
                "{name}"
            );
        }
    }

    #[test]
    fn refuses_a_negative_amount_a_junk_amount_and_an_unknown_period() {
        assert_eq!(
            code(parse_limit_input(&with("perCall", Some("-1")))),
            "agents.spend_limit_invalid"
        );
        assert_eq!(
            code(parse_limit_input(&with("perSession", Some("1e2")))),
            "agents.spend_limit_invalid"
        );
        assert_eq!(
            code(parse_limit_input(&with("period", Some("year")))),
            "agents.spend_limit_invalid"
        );
    }

    #[test]
    fn keeps_an_explicit_zero_and_a_decimal_string_as_scaled_integers() {
        let mut i = limit();
        i.per_call = Some("0".to_owned());
        i.per_session = Some("0.5".to_owned());
        i.per_period = Some("2.0".to_owned());
        let (l, _) = parse_limit_input(&i).unwrap();
        assert_eq!(l.per_call, Amount::ZERO);
        assert_eq!(l.per_session, Amount::from_scaled(5 * 10_i128.pow(17)));
        assert_eq!(l.per_period, Amount::whole(2));
        assert_eq!(l.period, "day");
    }

    #[test]
    fn uses_utc_day_monday_week_and_calendar_month() {
        let at = |s: &str| service_kit::time::js_date(s).unwrap();
        let friday = at("2026-10-23T15:04:00.000Z");
        assert_eq!(
            period_start("day", friday).iso(),
            "2026-10-23T00:00:00.000Z"
        );
        assert_eq!(
            period_start("week", friday).iso(),
            "2026-10-19T00:00:00.000Z"
        );
        assert_eq!(
            period_start("month", friday).iso(),
            "2026-10-01T00:00:00.000Z"
        );
        assert_eq!(
            period_start("week", at("2026-10-18T23:00:00.000Z")).iso(),
            "2026-10-12T00:00:00.000Z"
        );
    }

    fn cap() -> Limits {
        Limits {
            asset_id: "IFC".to_owned(),
            per_call: Amount::from_scaled(10),
            per_session: Amount::from_scaled(15),
            per_period: Amount::from_scaled(20),
            period: "day".to_owned(),
        }
    }

    #[test]
    fn allows_a_call_that_lands_on_each_cap() {
        assert_eq!(
            decide_reservation(&cap(), Amount::ZERO, Amount::ZERO, Amount::from_scaled(10)),
            Ok(())
        );
        assert_eq!(
            decide_reservation(
                &cap(),
                Amount::from_scaled(5),
                Amount::ZERO,
                Amount::from_scaled(10)
            ),
            Ok(())
        );
        assert_eq!(
            decide_reservation(
                &cap(),
                Amount::ZERO,
                Amount::from_scaled(10),
                Amount::from_scaled(10)
            ),
            Ok(())
        );
    }

    #[test]
    fn names_the_cap_that_would_be_exceeded() {
        assert_eq!(
            decide_reservation(&cap(), Amount::ZERO, Amount::ZERO, Amount::from_scaled(11)),
            Err(("call", Amount::from_scaled(10)))
        );
        assert_eq!(
            decide_reservation(
                &cap(),
                Amount::from_scaled(6),
                Amount::ZERO,
                Amount::from_scaled(10)
            ),
            Err(("session", Amount::from_scaled(15)))
        );
        assert_eq!(
            decide_reservation(
                &cap(),
                Amount::ZERO,
                Amount::from_scaled(11),
                Amount::from_scaled(10)
            ),
            Err(("period", Amount::from_scaled(20)))
        );
    }
}
