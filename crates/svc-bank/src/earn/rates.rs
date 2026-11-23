//! `earn/rate-history.ts` (BK-earn-05): every rate a pool has published, from `bank.earn_rate_changes`, which is
//! append-only. A pool's rate is written in two places only, each in one transaction with this table: the pool's
//! create records the opening rate, and [`set_pool_rate`] records an approved change and moves the pool's `apr_bps`
//! with it. Nothing is filled in for the time before a pool's first record.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::time::Instant;

use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, owner_list_limit, pg};

use super::pool_not_found;

/// `RateChange`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateChange {
    pub rate_bps: i64,
    pub effective_at: Instant,
    pub reason: Option<String>,
}

/// `RateHistory`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateHistory {
    pub pool_id: String,
    pub current_bps: i64,
    /// Oldest first: the newest `limit` records.
    pub changes: Vec<RateChange>,
    pub earlier: bool,
}

impl RateHistory {
    /// `earn.rateHistory`'s answer.
    pub fn json(&self) -> Json {
        Json::obj([
            ("poolId", Json::str(self.pool_id.clone())),
            ("currentBps", Json::int(self.current_bps)),
            (
                "changes",
                Json::Array(
                    self.changes
                        .iter()
                        .map(|c| {
                            Json::obj([
                                ("rateBps", Json::int(c.rate_bps)),
                                ("effectiveAt", Json::str(c.effective_at.iso())),
                                ("reason", c.reason.clone().map_or(Json::Null, Json::str)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("earlier", Json::Bool(self.earlier)),
        ])
    }
}

/// `recordRateChange`: one record, inside the caller's transaction.
pub fn record(
    c: &mut impl GenericClient,
    pool_id: &str,
    rate_bps: i64,
    effective_at: Instant,
    reason: Option<&str>,
    approval_id: Option<&str>,
) -> Result<(), Refusal> {
    c.execute(
        &format!(
            "INSERT INTO bank.earn_rate_changes (pool_id, rate_bps, effective_at, reason, approval_id) \
             VALUES ($1::text::uuid, $2::int8::int4, {}, $4, $5)",
            at("$3")
        ),
        &[&pool_id, &rate_bps, &effective_at.0, &reason, &approval_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `assertEarnRateHistoryListLimit`.
pub fn list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(
        limit,
        "bank.earn_rate_history_limit_unset",
        "earn.rateHistory",
    )
}

/// `readRateHistory`: one statement, so the pool's current rate and its records come from the same snapshot. `before`
/// pages back: records that took effect strictly earlier.
pub fn read(
    c: &mut impl GenericClient,
    pool_id: &str,
    limit: Option<f64>,
    before: Option<Instant>,
) -> Result<RateHistory, Refusal> {
    let page = list_limit(limit)?;
    let before_clause = if before.is_some() {
        format!("AND effective_at < {}", at("$3"))
    } else {
        "AND $3::int8 IS NULL".to_owned()
    };
    let rows = c
        .query(
            &format!(
                "SELECT p.apr_bps::int8, c.rate_bps::int8, floor(extract(epoch from c.effective_at) * 1000)::int8, c.reason \
                   FROM bank.earn_pools p \
                   LEFT JOIN LATERAL ( \
                     SELECT rate_bps, effective_at, reason FROM bank.earn_rate_changes \
                      WHERE pool_id = p.id {before_clause} \
                      ORDER BY effective_at DESC \
                      LIMIT $2 \
                   ) c ON true \
                  WHERE p.id = $1::text::uuid \
                  ORDER BY c.effective_at DESC"
            ),
            &[&pool_id, &(page + 1), &before.map(|b| b.0)],
        )
        .map_err(|e| pg(&e))?;
    let Some(first) = rows.first() else {
        return Err(pool_not_found(pool_id));
    };
    let current_bps: i64 = first.try_get(0).map_err(|e| pg(&e))?;
    let mut changes = Vec::new();
    for r in &rows {
        let effective: Option<i64> = r.try_get(2).map_err(|e| pg(&e))?;
        let Some(effective) = effective else { continue };
        changes.push(RateChange {
            rate_bps: r.try_get(1).map_err(|e| pg(&e))?,
            effective_at: Instant(effective),
            reason: r.try_get(3).map_err(|e| pg(&e))?,
        });
    }
    #[allow(
        clippy::cast_sign_loss,
        clippy::cast_possible_truncation,
        reason = "a page of at most 200"
    )]
    let page_len = page as usize;
    let earlier = changes.len() > page_len;
    changes.truncate(page_len);
    changes.reverse();
    Ok(RateHistory {
        pool_id: pool_id.to_owned(),
        current_bps,
        changes,
        earlier,
    })
}

/// `rateForDay`: the record in force when the day began; a pool with no record pays its `apr_bps`; a day before the
/// first record pays the first record's rate.
pub fn rate_for_day(
    c: &mut impl GenericClient,
    pool_id: &str,
    boundary: Instant,
    pool_bps: i64,
) -> Result<i64, Refusal> {
    let row = c
        .query_one(
            &format!(
                "SELECT \
                   (SELECT rate_bps::int8 FROM bank.earn_rate_changes WHERE pool_id = $1::text::uuid AND effective_at <= {} \
                     ORDER BY effective_at DESC LIMIT 1), \
                   (SELECT rate_bps::int8 FROM bank.earn_rate_changes WHERE pool_id = $1::text::uuid \
                     ORDER BY effective_at ASC LIMIT 1)",
                at("$2")
            ),
            &[&pool_id, &boundary.0],
        )
        .map_err(|e| pg(&e))?;
    let in_force: Option<i64> = row.try_get(0).map_err(|e| pg(&e))?;
    let first: Option<i64> = row.try_get(1).map_err(|e| pg(&e))?;
    Ok(in_force.or(first).unwrap_or(pool_bps))
}

/// What [`set_pool_rate`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateSet {
    pub pool_id: String,
    pub rate_bps: i64,
    pub effective_at: Instant,
    pub previous_bps: i64,
}

/// `setPoolRate`: an approved change of a flexible pool's rate. The pool's `apr_bps` and the history record move
/// together; the record takes effect at the database's clock, strictly after the pool's last record. One approval
/// writes at most one record: the same approval again answers the record it wrote. `now` is the TypeScript's test
/// clock; production passes none.
pub fn set_pool_rate(
    tx: &mut impl GenericClient,
    pool_id: &str,
    rate_bps: i64,
    reason: &str,
    approval_id: &str,
    now: Option<Instant>,
) -> Result<RateSet, Refusal> {
    if rate_bps < 0 {
        return Err(Refusal::Other(format!(
            "A rate is a non-negative whole number of basis points, got {rate_bps}"
        )));
    }
    let replay = tx
        .query(
            "SELECT pool_id::text, rate_bps::int8, floor(extract(epoch from effective_at) * 1000)::int8 FROM bank.earn_rate_changes WHERE approval_id = $1",
            &[&approval_id],
        )
        .map_err(|e| pg(&e))?;
    if let Some(done) = replay.first() {
        let done_pool: String = done.try_get(0).map_err(|e| pg(&e))?;
        let done_rate: i64 = done.try_get(1).map_err(|e| pg(&e))?;
        let done_at = Instant(done.try_get(2).map_err(|e| pg(&e))?);
        if done_pool != pool_id || done_rate != rate_bps {
            return Err(refuse(
                "bank.pool_conflict",
                "This approval already changed a different rate",
            ));
        }
        let previous = tx
            .query(
                &format!(
                    "SELECT rate_bps::int8 FROM bank.earn_rate_changes \
                      WHERE pool_id = $1::text::uuid AND effective_at < {} \
                      ORDER BY effective_at DESC LIMIT 1",
                    at("$2")
                ),
                &[&pool_id, &done_at.0],
            )
            .map_err(|e| pg(&e))?;
        let previous_bps = match previous.first() {
            Some(r) => r.try_get(0).map_err(|e| pg(&e))?,
            None => done_rate,
        };
        return Ok(RateSet {
            pool_id: done_pool,
            rate_bps: done_rate,
            effective_at: done_at,
            previous_bps,
        });
    }
    let pools = tx
        .query(
            "SELECT kind::text, apr_bps::int8 FROM bank.earn_pools WHERE id = $1::text::uuid FOR UPDATE",
            &[&pool_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(pool) = pools.first() else {
        return Err(pool_not_found(pool_id));
    };
    let kind: String = pool.try_get(0).map_err(|e| pg(&e))?;
    if kind == "fixed" {
        return Err(fixed_rate_locked());
    }
    let previous_bps: i64 = pool.try_get(1).map_err(|e| pg(&e))?;
    if previous_bps == rate_bps {
        return Err(rate_unchanged(rate_bps));
    }
    // The pool row is locked, so no other change of this pool can land between this read and the insert.
    let clock = tx
        .query_one(
            &format!(
                "SELECT floor(extract(epoch from GREATEST( \
                   COALESCE({}, now()), \
                   COALESCE((SELECT max(effective_at) FROM bank.earn_rate_changes WHERE pool_id = $1::text::uuid), '-infinity'::timestamptz) \
                     + interval '1 millisecond')) * 1000)::int8",
                at("$2")
            ),
            &[&pool_id, &now.map(|n| n.0)],
        )
        .map_err(|e| pg(&e))?;
    let mut effective_at = Instant(clock.try_get(0).map_err(|e| pg(&e))?);
    let any: bool = tx
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM bank.earn_rate_changes WHERE pool_id = $1::text::uuid)",
            &[&pool_id],
        )
        .map_err(|e| pg(&e))?
        .try_get(0)
        .map_err(|e| pg(&e))?;
    if !any {
        // A pool opened before the table has no record: record the rate it pays now first, so the day this change
        // lands on still pays it, and the history never claims the new rate held earlier.
        record(tx, pool_id, previous_bps, effective_at, None, None)?;
        effective_at = Instant(effective_at.0 + 1);
    }
    record(
        tx,
        pool_id,
        rate_bps,
        effective_at,
        Some(reason),
        Some(approval_id),
    )?;
    tx.execute(
        "UPDATE bank.earn_pools SET apr_bps = $2::int8, updated_at = now() WHERE id = $1::text::uuid",
        &[&pool_id, &rate_bps],
    )
    .map_err(|e| pg(&e))?;
    Ok(RateSet {
        pool_id: pool_id.to_owned(),
        rate_bps,
        effective_at,
        previous_bps,
    })
}

/// `bank.fixed_pool_rate_locked`.
pub fn fixed_rate_locked() -> Refusal {
    refuse(
        "bank.fixed_pool_rate_locked",
        "A fixed-term pool keeps the rate it opened with; publish a new pool for a new rate",
    )
}

/// `bank.pool_rate_unchanged`.
pub fn rate_unchanged(rate_bps: i64) -> Refusal {
    refuse(
        "bank.pool_rate_unchanged",
        format!("The pool already pays {rate_bps} bps"),
    )
}
