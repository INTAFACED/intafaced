//! `EarnService` (`earn/earn-service.ts`), `readPoolTotals` (`ops/pool-totals.ts`) and the supply pause the deposit
//! reads (`ops/asset-pause.ts` `assertSupplyOpen`).
//!
//! A deposit is claim `pending`, then the ledger post, then activate: a pending claim earns nothing. Only a definite
//! ledger refusal proves the money never left the main balance, so only then is the claim deleted; any other failure
//! keeps it, with its terms, for `resume_pending` or a retry with the same id, both of which post under the same key
//! `bank.earn.deposit:<positionId>`. If this crashes after the post and before activate, nobody's funds are stranded:
//! the money is in the saver's own stake pot and the next pass activates the claim.
//!
//! A day's interest is claimed, planned and stored before anything is posted, then posted from the stored plan, then
//! recorded: a crash between the post and the record is finished from the stored plan, under the same key
//! `bank.interest:<poolId>:<date>`, never planned twice.

use std::collections::{HashMap, HashSet};

use postgres::GenericClient;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::interest::{
    self, Accruing, DAY_MS, DAYS_PER_YEAR, Payout, accrual_boundary, accrual_date, daily_interest,
};
use super::{
    Deps, POOL_COLS, Pool, Position, code_of, custody_guard, definite_refusal, message_of, ms,
    pool_not_found, position_closed, position_cols, position_not_found, rate_unset, rates,
    stake_principal,
};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::{LedgerAccount, LedgerTx, PostFailure};
use crate::spaces::space::{at, in_tx, owner_list_limit, pg, with};
use crate::transfers::moves::post_refusal;
use crate::transfers::ports::RecipientStatus;

/// `MAX_TERMS_PER_RUN`: a saving whose terms ended many times over renews this many per run.
const MAX_TERMS_PER_RUN: usize = 100;

// ── Owner values ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// `assertCatalogListLimit` (`catalog-list-limit.ts`): the same rule as the owner lists, capped at 200.
pub fn pools_list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(limit, "bank.earn_pools_list_limit_unset", "earn.pools")
}

/// `assertEarnPositionsListLimit`.
pub fn positions_list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(
        limit,
        "bank.earn_positions_list_limit_unset",
        "earn.positions",
    )
}

/// `assertEarnInterestListLimit`.
pub fn interest_list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(
        limit,
        "bank.earn_interest_list_limit_unset",
        "earn.interestHistory",
    )
}

/// `assertJobBatchLimit`: a job's batch, or its own `*_unset` refusal; never the number it used to invent.
fn job_batch_limit(
    limit: Option<f64>,
    unset: &str,
    invented: i64,
    max: i64,
    name: &str,
) -> Result<i64, Refusal> {
    let Some(l) = limit.filter(|l| l.is_finite()) else {
        return Err(refuse(
            unset,
            format!(
                "{name} batch size is unset. Blank refuses — never {invented}. Pass a positive integer ({invented} is allowed if explicit)."
            ),
        ));
    };
    #[allow(clippy::cast_precision_loss, reason = "a bound of at most 1000")]
    let top = max as f64;
    if l.fract() != 0.0 || l < 1.0 || l > top {
        return Err(refuse(
            "bank.validation_failed",
            format!(
                "limit must be an integer 1..{max}, got {}",
                Json::Number(l).compact()
            ),
        ));
    }
    #[allow(clippy::cast_possible_truncation, reason = "a whole number up to 1000")]
    Ok(l as i64)
}

/// `assertEarnResumePendingLimit`.
pub fn resume_pending_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    job_batch_limit(
        limit,
        "bank.earn_resume_pending_limit_unset",
        100,
        1_000,
        "earn.resumePending",
    )
}

/// `assertEarnRenewBatchLimit`.
pub fn renew_batch_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    job_batch_limit(
        limit,
        "bank.earn_renew_batch_limit_unset",
        100,
        1_000,
        "earn.renewDue",
    )
}

/// `assertEarnReleaseBatchLimit`.
pub fn release_batch_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    job_batch_limit(
        limit,
        "bank.earn_release_batch_limit_unset",
        100,
        1_000,
        "earn.releaseUnbonded",
    )
}

/// `riskDisclosure`: the owner's wording `{ "slashing", "ownership" }`, each trimmed and not blank; anything else refuses
/// `bank.earn_risk_wording_unset`, and nothing here says a pool carries no risk.
pub fn risk_disclosure(raw: Option<&str>) -> Result<Json, Refusal> {
    let unset = || {
        refuse(
            "bank.earn_risk_wording_unset",
            "The owner has not published the staking risk wording (BANK_EARN_RISK_WORDING_JSON)",
        )
    };
    let raw = service_kit::money::js_trim(raw.unwrap_or_default());
    if raw.is_empty() {
        return Err(unset());
    }
    let parsed = json::parse(raw).map_err(|_| unset())?;
    let text = |k: &str| match parsed.get(k) {
        Some(Json::String(s)) if !service_kit::money::js_trim(s).is_empty() => {
            Some(service_kit::money::js_trim(s).to_owned())
        }
        _ => None,
    };
    match (text("slashing"), text("ownership")) {
        (Some(slashing), Some(ownership)) => Ok(Json::obj([
            ("slashing", Json::str(slashing)),
            ("ownership", Json::str(ownership)),
        ])),
        _ => Err(unset()),
    }
}

fn assert_earnable(d: &Deps<'_>, asset_id: &str) -> Result<(), Refusal> {
    if asset_id == d.settings.native_asset_id {
        return Err(refuse(
            "bank.native_asset_not_earnable",
            format!(
                "{asset_id} is staked through svc-token, not through bank earn pools (§8.1) — both would write to the same ledger stake account"
            ),
        ));
    }
    Ok(())
}

/// `assertSupplyOpen`: a desk pause of new supply on the asset refuses before anything is written.
fn assert_supply_open(c: &mut impl GenericClient, asset_id: &str) -> Result<(), Refusal> {
    let rows = c
        .query(
            "SELECT supply_paused FROM bank.asset_pauses WHERE asset_id = ANY($1)",
            &[&vec![asset_id.to_owned()]],
        )
        .map_err(|_| {
            refuse(
                "bank.asset_pause_unreadable",
                "The asset pause state could not be read, so the operation was refused",
            )
        })?;
    let paused = rows
        .iter()
        .any(|r| r.try_get::<_, bool>(0).unwrap_or(false));
    if paused {
        return Err(refuse(
            "bank.asset_paused",
            format!("New deposits are paused for {asset_id}"),
        ));
    }
    Ok(())
}

// ── Pools ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `pool`: one pool, open or closed.
pub fn pool(c: &mut impl GenericClient, pool_id: &str) -> Result<Pool, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {POOL_COLS} FROM bank.earn_pools WHERE id = $1::text::uuid"),
            &[&pool_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(Pool::from_row)
        .transpose()?
        .ok_or_else(|| pool_not_found(pool_id))
}

/// `listPools`: the open pools, an asset's best rate first; none refuses `bank.earn_rate_unset`, never a default rate.
pub fn list_pools(
    c: &mut impl GenericClient,
    asset_id: Option<&str>,
    limit: Option<f64>,
) -> Result<Vec<Pool>, Refusal> {
    let page = pools_list_limit(limit)?;
    let rows = match asset_id {
        Some(a) => c.query(
            &format!(
                "SELECT {POOL_COLS} FROM bank.earn_pools WHERE asset_id = $1 AND status = 'open' ORDER BY apr_bps DESC LIMIT $2"
            ),
            &[&a, &page],
        ),
        None => c.query(
            &format!(
                "SELECT {POOL_COLS} FROM bank.earn_pools WHERE status = 'open' ORDER BY asset_id ASC, apr_bps DESC LIMIT $1"
            ),
            &[&page],
        ),
    }
    .map_err(|e| pg(&e))?;
    if rows.is_empty() {
        return Err(rate_unset(asset_id));
    }
    rows.iter().map(Pool::from_row).collect()
}

/// `poolsForAccrual`: every open pool, and every closed pool that still holds savings (BK-earn-04).
fn pools_for_accrual(c: &mut impl GenericClient) -> Result<Vec<Pool>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {POOL_COLS} FROM bank.earn_pools pl \
                  WHERE pl.status = 'open' \
                     OR EXISTS (SELECT 1 FROM bank.earn_positions p WHERE p.pool_id = pl.id AND p.status = 'active') \
                  ORDER BY asset_id ASC, apr_bps DESC"
            ),
            &[],
        )
        .map_err(|e| pg(&e))?;
    if rows.is_empty() {
        return Err(rate_unset(None));
    }
    rows.iter().map(Pool::from_row).collect()
}

/// What an operator's create asks for (`createPool`'s input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPool {
    pub id: String,
    pub asset_id: String,
    pub kind: String,
    pub name: String,
    pub apr_bps: i64,
    pub term_days: Option<i64>,
    pub min_deposit: Amount,
    pub unbonding_days: Option<i64>,
}

/// `createPool`: the pool and its opening rate record in one transaction. The same id with the same terms answers the
/// pool already made; with other terms it refuses `bank.pool_conflict`.
pub fn create_pool(d: &Deps<'_>, input: &NewPool) -> Result<Pool, Refusal> {
    assert_earnable(d, &input.asset_id)?;
    let term_days = if input.kind == "fixed" {
        input.term_days
    } else {
        None
    };
    let min_deposit = format_amount(input.min_deposit);
    if let Some(u) = input.unbonding_days
        && (input.kind != "flexible" || !(1..=365).contains(&u))
    {
        return Err(refuse(
            "bank.pool_terms_invalid",
            "Only a flexible pool unbonds, for 1 to 365 days: a fixed term already has its own lock",
        ));
    }
    in_tx(d.store, |tx| {
        let made = tx
            .query(
                &format!(
                    "INSERT INTO bank.earn_pools (id, asset_id, kind, name, apr_bps, term_days, min_deposit, unbonding_days) \
                     VALUES ($1::text::uuid, $2, $3::text::bank.pool_kind, $4, $5::int8, $6::int8::int4, $7::text::numeric, $8::int8::int4) \
                     ON CONFLICT (id) DO NOTHING \
                     RETURNING {POOL_COLS}, {}",
                    ms("created_at")
                ),
                &[
                    &input.id,
                    &input.asset_id,
                    &input.kind,
                    &input.name,
                    &input.apr_bps,
                    &term_days,
                    &min_deposit,
                    &input.unbonding_days,
                ],
            )
            .map_err(|e| pg(&e))?;
        let Some(row) = made.first() else {
            let existing = pool(tx, &input.id).ok();
            // The rate it opened with, not today's: a later approved change is not a different create.
            let opened = tx
                .query(
                    "SELECT rate_bps::int8 FROM bank.earn_rate_changes WHERE pool_id = $1::text::uuid ORDER BY effective_at ASC LIMIT 1",
                    &[&input.id],
                )
                .map_err(|e| pg(&e))?;
            let opened_bps: Option<i64> = match opened.first() {
                Some(r) => Some(r.try_get(0).map_err(|e| pg(&e))?),
                None => None,
            };
            return match existing {
                Some(p)
                    if opened_bps == Some(input.apr_bps)
                        && p.asset_id == input.asset_id
                        && p.kind == input.kind
                        && p.name == input.name
                        && p.term_days == term_days
                        && p.min_deposit == input.min_deposit
                        && p.unbonding_days == input.unbonding_days =>
                {
                    Ok(p)
                }
                _ => Err(refuse(
                    "bank.pool_conflict",
                    format!(
                        "Pool {} already exists on different terms; a new pool needs a new id",
                        input.id
                    ),
                )),
            };
        };
        let made = Pool::from_row(row)?;
        let created_at = Instant(row.try_get(10).map_err(|e| pg(&e))?);
        rates::record(tx, &made.id, input.apr_bps, created_at, None, None)?;
        Ok(made)
    })
}

fn post(
    d: &Deps<'_>,
    recipe: &str,
    input: &Json,
    key: &str,
    customer: bool,
) -> Result<Result<LedgerTx, PostFailure>, Refusal> {
    if customer {
        custody_guard(d)?;
    }
    Ok(d.ledger.post_recipe(recipe, input, key))
}

/// `fundPool`: yield into a pool's reserve before it can be paid out, from the bank's own fee revenue, keyed
/// `bank.earn.fund:<poolId>:<fundingId>`.
pub fn fund_pool(
    d: &Deps<'_>,
    pool_id: &str,
    funding_id: &str,
    amount: Amount,
) -> Result<String, Refusal> {
    let p = with(d.store, |c| pool(c, pool_id))?;
    let input = Json::obj([
        ("poolId", Json::str(p.id.clone())),
        ("fundingId", Json::str(funding_id)),
        ("assetId", Json::str(p.asset_id.clone())),
        ("amount", Json::str(format_amount(amount))),
    ]);
    let key = format!("bank.earn.fund:{}:{funding_id}", p.id);
    post(d, "earnPoolFund", &input, &key, false)?
        .map(|tx| tx.id)
        .map_err(|f| post_refusal(&f))
}

/// `reserveBalance`: what the pool can still afford to pay, a ledger read.
pub fn reserve_balance(d: &Deps<'_>, pool_id: &str) -> Result<Amount, Refusal> {
    let p = with(d.store, |c| pool(c, pool_id))?;
    d.ledger
        .balance(&LedgerAccount::earn_pool_reserve(&p.id, &p.asset_id))
        .map_err(Refusal::Other)
}

/// `poolSize`: the stake pots of the pool's open savings, each checked against its recorded principal.
pub fn pool_size(d: &Deps<'_>, pool_id: &str) -> Result<Amount, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT id::text, user_id, asset_id, principal::text FROM bank.earn_positions \
              WHERE pool_id = $1::text::uuid AND status = 'active' ORDER BY id ASC",
            &[&pool_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let mut total: Amount = 0;
    for r in &rows {
        let id: String = r.try_get(0).map_err(|e| pg(&e))?;
        let user: String = r.try_get(1).map_err(|e| pg(&e))?;
        let asset: String = r.try_get(2).map_err(|e| pg(&e))?;
        let recorded = parse_amount(&r.try_get::<_, String>(3).map_err(|e| pg(&e))?)
            .map_err(Refusal::Other)?;
        let book = d
            .ledger
            .balance(&LedgerAccount::earn_stake(&user, &asset, &id))
            .map_err(Refusal::Other)?;
        total += stake_principal(&id, recorded, book)?;
    }
    Ok(total)
}

/// `principalOf`: the person's open principal in an asset, each saving checked against its stake pot.
pub fn principal_of(d: &Deps<'_>, user_id: &str, asset_id: &str) -> Result<Amount, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT id::text, principal::text FROM bank.earn_positions \
              WHERE user_id = $1 AND asset_id = $2 AND status = 'active' ORDER BY id ASC",
            &[&user_id, &asset_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let mut total: Amount = 0;
    for r in &rows {
        let id: String = r.try_get(0).map_err(|e| pg(&e))?;
        let recorded = parse_amount(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)
            .map_err(Refusal::Other)?;
        let book = d
            .ledger
            .balance(&LedgerAccount::earn_stake(user_id, asset_id, &id))
            .map_err(Refusal::Other)?;
        total += stake_principal(&id, recorded, book)?;
    }
    Ok(total)
}

/// `stakedOf`: the sum of the person's earn stake pots in an asset.
pub fn staked_of(d: &Deps<'_>, user_id: &str, asset_id: &str) -> Result<Amount, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT id::text FROM bank.earn_positions WHERE user_id = $1 AND asset_id = $2 AND status = 'active'",
            &[&user_id, &asset_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let mut total: Amount = 0;
    for r in &rows {
        let id: String = r.try_get(0).map_err(|e| pg(&e))?;
        total += d
            .ledger
            .balance(&LedgerAccount::earn_stake(user_id, asset_id, &id))
            .map_err(Refusal::Other)?;
    }
    Ok(total)
}

/// `readPoolTotals`: each pool's open stake pots summed, a failed ledger read null with `ledger_unavailable`, never
/// zero; utilisation is not recorded, so null. Counts and totals only, never a per-person row.
pub fn pool_totals(d: &Deps<'_>) -> Result<Json, Refusal> {
    let pools = with(d.store, |c| {
        c.query(
            "SELECT id::text, asset_id FROM bank.earn_pools ORDER BY created_at ASC, id ASC",
            &[],
        )
        .map_err(|e| pg(&e))
    })?;
    let as_of = d.now.iso();
    let mut out = Vec::new();
    for p in &pools {
        let pool_id: String = p.try_get(0).map_err(|e| pg(&e))?;
        let asset_id: String = p.try_get(1).map_err(|e| pg(&e))?;
        let positions = with(d.store, |c| {
            c.query(
                "SELECT id::text, user_id, asset_id FROM bank.earn_positions \
                  WHERE pool_id = $1::text::uuid AND status = 'active' ORDER BY id ASC",
                &[&pool_id],
            )
            .map_err(|e| pg(&e))
        })?;
        let mut total: Option<Amount> = Some(0);
        for r in &positions {
            let id: String = r.try_get(0).map_err(|e| pg(&e))?;
            let user: String = r.try_get(1).map_err(|e| pg(&e))?;
            let asset: String = r.try_get(2).map_err(|e| pg(&e))?;
            match d
                .ledger
                .balance(&LedgerAccount::earn_stake(&user, &asset, &id))
            {
                Ok(b) => total = total.map(|t| t + b),
                Err(_) => {
                    total = None;
                    break;
                }
            }
        }
        out.push(Json::obj([
            ("poolId", Json::str(pool_id)),
            ("assetId", Json::str(asset_id)),
            (
                "amountHeld",
                total.map_or(Json::Null, |t| Json::str(format_amount(t))),
            ),
            (
                "amountReason",
                if total.is_some() {
                    Json::Null
                } else {
                    Json::str("ledger_unavailable")
                },
            ),
            (
                "depositorCount",
                Json::int(i64::try_from(positions.len()).unwrap_or(i64::MAX)),
            ),
            ("utilisation", Json::Null),
            ("utilisationReason", Json::str("utilisation_not_recorded")),
        ]));
    }
    Ok(Json::obj([
        ("asOf", Json::str(as_of)),
        ("pools", Json::Array(out)),
    ]))
}

// ── Savings ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `position`: one saving.
pub fn position(c: &mut impl GenericClient, position_id: &str) -> Result<Position, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.earn_positions WHERE id = $1::text::uuid",
                position_cols()
            ),
            &[&position_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(Position::from_row)
        .transpose()?
        .ok_or_else(|| position_not_found(position_id))
}

/// `positionsInPool`: the person's open savings in one pool, newest first.
pub fn positions_in_pool(
    c: &mut impl GenericClient,
    user_id: &str,
    pool_id: &str,
    limit: Option<f64>,
) -> Result<Vec<Position>, Refusal> {
    let page = positions_list_limit(limit)?;
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.earn_positions WHERE user_id = $1 AND pool_id = $2::text::uuid AND status = 'active' \
                  ORDER BY opened_at DESC LIMIT $3",
                position_cols()
            ),
            &[&user_id, &pool_id, &page],
        )
        .map_err(|e| pg(&e))?;
    rows.iter().map(Position::from_row).collect()
}

/// `positionsOf`: the person's open savings, newest first.
pub fn positions_of(
    c: &mut impl GenericClient,
    user_id: &str,
    limit: Option<f64>,
) -> Result<Vec<Position>, Refusal> {
    let page = positions_list_limit(limit)?;
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.earn_positions WHERE user_id = $1 AND status = 'active' ORDER BY opened_at DESC LIMIT $2",
                position_cols()
            ),
            &[&user_id, &page],
        )
        .map_err(|e| pg(&e))?;
    rows.iter().map(Position::from_row).collect()
}

/// What a deposit asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepositAsk<'a> {
    pub pool_id: &'a str,
    pub user_id: &'a str,
    pub amount: Amount,
    pub position_id: &'a str,
}

fn position_input(p: &Position, amount: Amount) -> Json {
    Json::obj([
        ("positionId", Json::str(p.id.clone())),
        ("poolId", Json::str(p.pool_id.clone())),
        ("userId", Json::str(p.user_id.clone())),
        ("assetId", Json::str(p.asset_id.clone())),
        ("amount", Json::str(format_amount(amount))),
    ])
}

/// `postEarnDeposit`: idempotent on `bank.earn.deposit:<positionId>`.
fn post_deposit(d: &Deps<'_>, p: &Position) -> Result<Result<LedgerTx, PostFailure>, Refusal> {
    post(
        d,
        "earnDeposit",
        &position_input(p, p.principal),
        &format!("bank.earn.deposit:{}", p.id),
        true,
    )
}

fn activate(c: &mut impl GenericClient, position_id: &str) -> Result<(), Refusal> {
    c.execute(
        "UPDATE bank.earn_positions SET status = 'active' WHERE id = $1::text::uuid AND status = 'pending'",
        &[&position_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

fn delete_claim(c: &mut impl GenericClient, position_id: &str) -> Result<(), Refusal> {
    c.execute(
        "DELETE FROM bank.earn_positions WHERE id = $1::text::uuid AND status = 'pending'",
        &[&position_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `deposit`: claim `pending`, post, activate. The id is the caller's retry key: the same id with the same terms is
/// the same deposit; with other terms it refuses `bank.position_conflict`.
pub fn deposit(d: &Deps<'_>, ask: &DepositAsk<'_>) -> Result<Position, Refusal> {
    if ask.position_id.is_empty() {
        return Err(refuse(
            "bank.position_id_required",
            "Earn deposit needs a caller-stable position id",
        ));
    }
    let now = d.now;
    let p = with(d.store, |c| {
        let p = pool(c, ask.pool_id)?;
        // A desk pause on the pool's asset refuses before anything is written.
        assert_supply_open(c, &p.asset_id)?;
        Ok(p)
    })?;
    if p.status != "open" {
        return Err(refuse(
            "bank.pool_closed",
            format!("Pool \"{}\" is closed", p.name),
        ));
    }
    assert_earnable(d, &p.asset_id)?;
    if ask.amount < p.min_deposit {
        return Err(refuse(
            "bank.below_minimum",
            format!(
                "Minimum deposit for \"{}\" is {} {}",
                p.name,
                format_amount(p.min_deposit),
                p.asset_id
            ),
        ));
    }
    let matures_at = match (p.kind.as_str(), p.term_days) {
        ("fixed", Some(days)) => Some(Instant(now.0 + days * DAY_MS)),
        _ => None,
    };
    let claimed = with(d.store, |c| {
        c.query(
            &format!(
                "INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5::text::numeric, {}, {}, 'pending') \
                 ON CONFLICT (id) DO NOTHING RETURNING id",
                at("$6"),
                at("$7")
            ),
            &[
                &ask.position_id,
                &p.id,
                &ask.user_id,
                &p.asset_id,
                &format_amount(ask.amount),
                &now.0,
                &matures_at.map(|m| m.0),
            ],
        )
        .map_err(|e| pg(&e))
    })?;
    if claimed.is_empty()
        && let Some(done) = reuse_or_refuse(d, ask, &p.id)?
    {
        return Ok(done);
    }
    let claim = Position {
        id: ask.position_id.to_owned(),
        pool_id: p.id.clone(),
        user_id: ask.user_id.to_owned(),
        asset_id: p.asset_id.clone(),
        principal: ask.amount,
        opened_at: now,
        matures_at,
        status: "pending".to_owned(),
        auto_renew: false,
        unbonding_started_at: None,
        unbonds_at: None,
    };
    // Only a definite ledger refusal proves the money never left the main balance, so only then is the claim deleted.
    // Any other failure may follow a commit whose answer was lost: the claim stays for `resume_pending` or a retry.
    if let Err(f) = post_deposit(d, &claim)? {
        if definite_refusal(&f) {
            with(d.store, |c| delete_claim(c, &claim.id))?;
        }
        return Err(post_refusal(&f));
    }
    with(d.store, |c| {
        activate(c, &claim.id)?;
        position(c, &claim.id)
    })
}

/// `reuseOrRefuse`: an id already taken is a retry only when it is the same person, pool and amount. A retry already
/// finished answers the saving; one still pending posts again under the same key.
fn reuse_or_refuse(
    d: &Deps<'_>,
    ask: &DepositAsk<'_>,
    pool_id: &str,
) -> Result<Option<Position>, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                "SELECT user_id, pool_id::text, principal::text, status::text FROM bank.earn_positions WHERE id = $1::text::uuid",
                &[&ask.position_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(r) = rows.first() else {
            return Err(refuse(
                "bank.position_not_found",
                format!("Position {} disappeared after a conflict", ask.position_id),
            ));
        };
        let user: String = r.try_get(0).map_err(|e| pg(&e))?;
        let pool: String = r.try_get(1).map_err(|e| pg(&e))?;
        let principal = parse_amount(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)
            .map_err(Refusal::Other)?;
        let status: String = r.try_get(3).map_err(|e| pg(&e))?;
        if user != ask.user_id || pool != pool_id || principal != ask.amount {
            return Err(refuse(
                "bank.position_conflict",
                format!(
                    "Position {} already exists on different terms — a deposit that is not a retry of that one needs a new position id",
                    ask.position_id
                ),
            ));
        }
        if status == "pending" {
            return Ok(None);
        }
        position(c, ask.position_id).map(Some)
    })
}

/// One row of `resumePending`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resumed {
    pub position_id: String,
    /// `completed` or `failed`.
    pub outcome: &'static str,
    pub reason: Option<String>,
}

impl Resumed {
    pub fn json(&self) -> Json {
        let mut f = vec![
            ("positionId".to_owned(), Json::str(self.position_id.clone())),
            ("outcome".to_owned(), Json::str(self.outcome)),
        ];
        if let Some(r) = &self.reason {
            f.push(("reason".to_owned(), Json::str(r.clone())));
        }
        Json::Object(f)
    }
}

/// `resumePending`: post and activate every pending claim, oldest first. An unknown failure leaves the claim pending;
/// a definite refusal deletes it, as `deposit` does, so a refused deposit never books later with nobody's yes.
pub fn resume_pending(d: &Deps<'_>, limit: Option<f64>) -> Result<Vec<Resumed>, Refusal> {
    let batch = resume_pending_limit(limit)?;
    let rows = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.earn_positions WHERE status = 'pending' ORDER BY opened_at ASC LIMIT $1",
                    position_cols()
                ),
                &[&batch],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Position::from_row)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let mut out = Vec::new();
    for p in rows {
        let outcome = match post_deposit(d, &p) {
            Ok(Ok(_)) => with(d.store, |c| activate(c, &p.id)),
            Ok(Err(f)) => {
                if definite_refusal(&f) {
                    with(d.store, |c| delete_claim(c, &p.id))?;
                }
                Err(Refusal::Other(f.message().to_owned()))
            }
            Err(r) => Err(r),
        };
        out.push(match outcome {
            Ok(()) => Resumed {
                position_id: p.id.clone(),
                outcome: "completed",
                reason: None,
            },
            Err(r) => Resumed {
                position_id: p.id.clone(),
                outcome: "failed",
                reason: Some(message_of(&r)),
            },
        });
    }
    Ok(out)
}

/// `ratesAtOpen`: the rate each saving's pool had recorded in force when it opened; none when it opened before the
/// pool's first record.
pub fn rates_at_open(
    c: &mut impl GenericClient,
    positions: &[Position],
) -> Result<HashMap<String, Option<i64>>, Refusal> {
    let mut out = HashMap::new();
    if positions.is_empty() {
        return Ok(out);
    }
    let ids: Vec<String> = positions.iter().map(|p| p.id.clone()).collect();
    let rows = c
        .query(
            "SELECT p.id::text, ( \
               SELECT c.rate_bps::int8 FROM bank.earn_rate_changes c \
                WHERE c.pool_id = p.pool_id AND c.effective_at <= p.opened_at \
                ORDER BY c.effective_at DESC LIMIT 1) \
               FROM bank.earn_positions p WHERE p.id = ANY($1::text[]::uuid[])",
            &[&ids],
        )
        .map_err(|e| pg(&e))?;
    for r in &rows {
        out.insert(
            r.try_get::<_, String>(0).map_err(|e| pg(&e))?,
            r.try_get::<_, Option<i64>>(1).map_err(|e| pg(&e))?,
        );
    }
    Ok(out)
}

/// `PositionStanding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub accrues_from: Instant,
    /// `waiting`, `accruing`, `unbonding` or `below_unit`.
    pub accrual: &'static str,
    pub next_payout_on: Option<String>,
    pub renewals: i64,
    /// `staked`, `unbonding` or `unbonded`, for a pool that unbonds.
    pub staking: Option<&'static str>,
    pub unbonding_days: Option<i64>,
}

/// `stakingState`: by the bank's clock; none for a pool without unbonding.
pub fn staking_state(
    p: &Position,
    unbonding_days: Option<i64>,
    now: Instant,
) -> Option<&'static str> {
    unbonding_days?;
    Some(match p.unbonds_at {
        None => "staked",
        Some(u) if u.0 > now.0 => "unbonding",
        Some(_) => "unbonded",
    })
}

/// `accrualStates`: where each saving stands in the daily accrual and its payout schedule. A day pays the savings
/// opened before it began, so a saving first earns on the UTC day after it opened.
pub fn accrual_states(
    c: &mut impl GenericClient,
    positions: &[Position],
    now: Instant,
) -> Result<HashMap<String, Standing>, Refusal> {
    let mut out = HashMap::new();
    if positions.is_empty() {
        return Ok(out);
    }
    let mut pool_ids: Vec<String> = positions.iter().map(|p| p.pool_id.clone()).collect();
    pool_ids.sort();
    pool_ids.dedup();
    let ids: Vec<String> = positions.iter().map(|p| p.id.clone()).collect();
    let mut pools: HashMap<String, (i64, Option<i64>)> = HashMap::new();
    for r in &c
        .query(
            "SELECT id::text, apr_bps::int8, unbonding_days::int8 FROM bank.earn_pools WHERE id = ANY($1::text[]::uuid[])",
            &[&pool_ids],
        )
        .map_err(|e| pg(&e))?
    {
        pools.insert(
            r.try_get(0).map_err(|e| pg(&e))?,
            (
                r.try_get(1).map_err(|e| pg(&e))?,
                r.try_get(2).map_err(|e| pg(&e))?,
            ),
        );
    }
    // A day is done once it posted, or was recorded with nothing to post; a claim still holding a plan is not.
    let mut last_paid: HashMap<String, String> = HashMap::new();
    for r in &c
        .query(
            "SELECT pool_id::text, max(accrual_date)::text FROM bank.interest_accruals \
              WHERE pool_id = ANY($1::text[]::uuid[]) AND (ledger_tx_id IS NOT NULL OR planned_payouts IS NULL) \
              GROUP BY pool_id",
            &[&pool_ids],
        )
        .map_err(|e| pg(&e))?
    {
        last_paid.insert(
            r.try_get(0).map_err(|e| pg(&e))?,
            r.try_get(1).map_err(|e| pg(&e))?,
        );
    }
    let mut renewed: HashMap<String, i64> = HashMap::new();
    for r in &c
        .query(
            "SELECT position_id::text, count(*)::int8 FROM bank.earn_renewals \
              WHERE position_id = ANY($1::text[]::uuid[]) GROUP BY position_id",
            &[&ids],
        )
        .map_err(|e| pg(&e))?
    {
        renewed.insert(
            r.try_get(0).map_err(|e| pg(&e))?,
            r.try_get(1).map_err(|e| pg(&e))?,
        );
    }
    let first = |p: &Position| Instant(accrual_boundary(p.opened_at).0 + DAY_MS);
    // Only a saving whose first day is still ahead needs the record: the clock settles every other one.
    let ahead: Vec<String> = positions
        .iter()
        .filter(|p| first(p).0 > now.0)
        .map(|p| p.id.clone())
        .collect();
    let mut paid_ahead: HashSet<String> = HashSet::new();
    if !ahead.is_empty() {
        for r in &c
            .query(
                "SELECT p.id::text FROM bank.earn_positions p \
                  WHERE p.id = ANY($1::text[]::uuid[]) \
                    AND EXISTS ( \
                      SELECT 1 FROM bank.interest_accruals a \
                       WHERE a.pool_id = p.pool_id AND a.ledger_tx_id IS NOT NULL \
                         AND a.accrual_date > (p.opened_at AT TIME ZONE 'UTC')::date \
                         AND a.created_at > p.opened_at \
                         AND a.planned_payouts @> jsonb_build_array(jsonb_build_object('userId', p.user_id::text)))",
                &[&ahead],
            )
            .map_err(|e| pg(&e))?
        {
            paid_ahead.insert(r.try_get(0).map_err(|e| pg(&e))?);
        }
    }
    let today = accrual_date(now);
    for p in positions {
        let (apr_bps, unbonding_days) = pools
            .get(&p.pool_id)
            .copied()
            .ok_or_else(|| Refusal::Other(format!("pool {} of {} not read", p.pool_id, p.id)))?;
        let accrues_from = first(p);
        let accrual = if daily_interest(p.principal, apr_bps, DAYS_PER_YEAR).ok_or_else(|| {
            Refusal::Other(format!(
                "APR must be a non-negative integer in bps, got {apr_bps}"
            ))
        })? == 0
        {
            "below_unit"
        } else if p.unbonding_started_at.is_some() {
            "unbonding"
        } else if p.status == "active" && (now.0 >= accrues_from.0 || paid_ahead.contains(&p.id)) {
            "accruing"
        } else {
            "waiting"
        };
        let mut next_payout_on = None;
        if accrual != "below_unit" {
            // ISO dates order as strings: the latest of the first day, today and the day after the last one paid.
            let mut days = vec![accrual_date(accrues_from), today.clone()];
            if let Some(last) = last_paid.get(&p.pool_id) {
                let start = interest::day_start(last)
                    .ok_or_else(|| Refusal::Other(format!("accrual date {last}")))?;
                days.push(accrual_date(Instant(start.0 + DAY_MS)));
            }
            days.sort();
            let mut next = days.pop();
            // An unbonding saving's last paid day is the one it was asked on; past that, no day pays it.
            if let (Some(n), Some(started)) = (&next, p.unbonding_started_at)
                && *n > accrual_date(started)
            {
                next = None;
            }
            next_payout_on = next;
        }
        out.insert(
            p.id.clone(),
            Standing {
                accrues_from,
                accrual,
                next_payout_on,
                renewals: renewed.get(&p.id).copied().unwrap_or(0),
                staking: staking_state(p, unbonding_days, now),
                unbonding_days,
            },
        );
    }
    Ok(out)
}

/// `withdraw`: close a saving and pay its principal back to the main balance, the row locked throughout. The money is
/// the stake pot: a column that disagrees with a funded pot refuses before anything posts; an empty pot with a recorded
/// principal is a take back whose post landed and whose close did not, so the same key is replayed and the row closes.
/// In a staking-style pool the first take back only starts the unbonding (`unbond: true`), moving no money.
pub fn withdraw(
    d: &Deps<'_>,
    position_id: &str,
    now: Instant,
    unbond: bool,
) -> Result<Position, Refusal> {
    in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.earn_positions WHERE id = $1::text::uuid FOR UPDATE",
                    position_cols()
                ),
                &[&position_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(row) = rows.first() else {
            return Err(position_not_found(position_id));
        };
        let row = Position::from_row(row)?;
        if row.status == "closed" {
            return Err(position_closed());
        }
        if row.status == "pending" {
            return Err(refuse(
                "bank.position_pending",
                format!(
                    "Position {position_id} is still pending — resume the deposit before withdrawing"
                ),
            ));
        }
        if let Some(m) = row.matures_at.filter(|m| m.0 > now.0) {
            return Err(refuse(
                "bank.position_locked",
                format!("Fixed-term position is locked until {}", m.iso()),
            ));
        }
        let pools = tx
            .query(
                "SELECT unbonding_days::int8 FROM bank.earn_pools WHERE id = $1::text::uuid",
                &[&row.pool_id],
            )
            .map_err(|e| pg(&e))?;
        let unbonding_days: Option<i64> = match pools.first() {
            Some(r) => r.try_get(0).map_err(|e| pg(&e))?,
            None => None,
        };
        if let (Some(days), None) = (unbonding_days, row.unbonds_at) {
            if !unbond {
                return Err(refuse(
                    "bank.unbond_not_confirmed",
                    format!(
                        "This saving unbonds for {days} days before it is paid back; confirm the unbonding to start it"
                    ),
                ));
            }
            let unbonds_at = Instant(now.0 + days * DAY_MS);
            tx.execute(
                &format!(
                    "UPDATE bank.earn_positions SET unbonding_started_at = {}, unbonds_at = {} \
                      WHERE id = $1::text::uuid AND unbonds_at IS NULL",
                    at("$2"),
                    at("$3")
                ),
                &[&position_id, &now.0, &unbonds_at.0],
            )
            .map_err(|e| pg(&e))?;
            return Ok(Position {
                unbonding_started_at: Some(now),
                unbonds_at: Some(unbonds_at),
                ..row
            });
        }
        if let Some(u) = row.unbonds_at.filter(|u| u.0 > now.0) {
            // The same request again is the one already made.
            if unbond {
                return Ok(row);
            }
            return Err(refuse(
                "bank.position_unbonding",
                format!("This saving is unbonding until {}", u.iso()),
            ));
        }
        let book = d
            .ledger
            .balance(&LedgerAccount::earn_stake(
                &row.user_id,
                &row.asset_id,
                &row.id,
            ))
            .map_err(Refusal::Other)?;
        // Empty pot, positive column: the take back already committed. Replay the same key.
        let principal = if book == 0 && row.principal > 0 {
            row.principal
        } else {
            stake_principal(&row.id, row.principal, book)?
        };
        post(
            d,
            "earnWithdraw",
            &position_input(&row, principal),
            &format!("bank.earn.withdraw:{}", row.id),
            true,
        )?
        .map_err(|f| post_refusal(&f))?;
        tx.execute(
            "UPDATE bank.earn_positions SET status = 'closed', closed_at = now() WHERE id = $1::text::uuid",
            &[&position_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(Position {
            status: "closed".to_owned(),
            ..row
        })
    })
}

/// `ReleaseReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReleaseReport {
    pub released: Vec<(String, Amount)>,
    pub skipped: Vec<(String, &'static str)>,
    pub next: Option<String>,
}

impl ReleaseReport {
    pub fn json(&self) -> Json {
        Json::obj([
            (
                "released",
                Json::Array(
                    self.released
                        .iter()
                        .map(|(id, p)| {
                            Json::obj([
                                ("positionId", Json::str(id.clone())),
                                ("principal", Json::str(format_amount(*p))),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("skipped", skipped_json(&self.skipped)),
            ("next", self.next.clone().map_or(Json::Null, Json::str)),
        ])
    }
}

fn skipped_json(skipped: &[(String, &'static str)]) -> Json {
    Json::Array(
        skipped
            .iter()
            .map(|(id, code)| {
                Json::obj([
                    ("positionId", Json::str(id.clone())),
                    ("code", Json::str(*code)),
                ])
            })
            .collect(),
    )
}

/// `releaseUnbonded`: every staking-style saving whose unbonding ended by the bank's own clock is paid back through the
/// withdraw recipe, keyed per saving, so a run that fires twice releases once. One that fails is reported and left.
pub fn release_unbonded(
    d: &Deps<'_>,
    pool_id: Option<&str>,
    limit: Option<f64>,
    after: Option<&str>,
) -> Result<ReleaseReport, Refusal> {
    let now = d.now;
    let limit = release_batch_limit(limit)?;
    let due: Vec<String> = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT id::text FROM bank.earn_positions \
                      WHERE status = 'active' AND unbonds_at IS NOT NULL AND unbonds_at <= {} \
                        AND ($2::text IS NULL OR pool_id = $2::text::uuid) \
                        AND ($3::text IS NULL OR id > $3::text::uuid) \
                      ORDER BY id ASC LIMIT $4",
                    at("$1")
                ),
                &[&now.0, &pool_id, &after, &limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| r.try_get::<_, String>(0).map_err(|e| pg(&e)))
            .collect()
    })?;
    let mut report = ReleaseReport {
        next: (i64::try_from(due.len()).ok() == Some(limit))
            .then(|| due.last().cloned())
            .flatten(),
        ..ReleaseReport::default()
    };
    for id in due {
        match withdraw(d, &id, now, false) {
            Ok(closed) => report.released.push((id, closed.principal)),
            // Taken back by its saver since the list was read: nothing left to release.
            Err(Refusal::Bank(e)) if e.row.code == "bank.position_closed" => {}
            Err(r) => report
                .skipped
                .push((id, code_of(&r).unwrap_or("bank.earn_release_failed"))),
        }
    }
    Ok(report)
}

/// `PoolStatusChange`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusChange {
    pub pool_id: String,
    pub status: String,
    pub previous_status: String,
    pub revision: i64,
    pub approved_by: String,
}

/// The second person's approval, as `consumeOpsApprovalPair` answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approved {
    pub approval_id: String,
    pub requester_id: String,
    pub approver_id: String,
}

/// `setPoolStatus`: an approved close or reopen of a pool (BK-earn-04), a pool-level pause only. The pool row is
/// locked first; the same change sent again answers its recorded row and spends nothing; an unchanged status refuses
/// `bank.pool_status_unchanged` and a revision that is not the next one `bank.pool_status_stale`, both before `approve`
/// spends the second person.
pub fn set_pool_status(
    d: &Deps<'_>,
    pool_id: &str,
    status: &str,
    reason: &str,
    revision: i64,
    approve: &dyn Fn() -> Result<Approved, Refusal>,
) -> Result<StatusChange, Refusal> {
    in_tx(d.store, |tx| {
        let rows = tx
            .query(
                "SELECT status::text, status_revision::int8, name FROM bank.earn_pools WHERE id = $1::text::uuid FOR UPDATE",
                &[&pool_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(p) = rows.first() else {
            return Err(pool_not_found(pool_id));
        };
        let current: String = p.try_get(0).map_err(|e| pg(&e))?;
        let current_revision: i64 = p.try_get(1).map_err(|e| pg(&e))?;
        let name: String = p.try_get(2).map_err(|e| pg(&e))?;
        let recorded = tx
            .query(
                "SELECT status::text, previous_status::text, reason, approved_by FROM bank.earn_pool_status_changes \
                  WHERE pool_id = $1::text::uuid AND revision = $2::int8::int4",
                &[&pool_id, &revision],
            )
            .map_err(|e| pg(&e))?;
        if let Some(same) = recorded.first() {
            let s: String = same.try_get(0).map_err(|e| pg(&e))?;
            let r: String = same.try_get(2).map_err(|e| pg(&e))?;
            if s == status && r == reason {
                return Ok(StatusChange {
                    pool_id: pool_id.to_owned(),
                    status: s,
                    previous_status: same.try_get(1).map_err(|e| pg(&e))?,
                    revision,
                    approved_by: same.try_get(3).map_err(|e| pg(&e))?,
                });
            }
        }
        if current == status {
            return Err(refuse(
                "bank.pool_status_unchanged",
                format!("Pool \"{name}\" is already {status}"),
            ));
        }
        let next = current_revision + 1;
        if revision != next {
            return Err(refuse(
                "bank.pool_status_stale",
                format!(
                    "Pool \"{name}\" is at status revision {current_revision}; this change must be revision {next}"
                ),
            ));
        }
        let approval = approve()?;
        tx.execute(
            "INSERT INTO bank.earn_pool_status_changes \
               (pool_id, revision, status, previous_status, reason, approval_id, requested_by, approved_by) \
             VALUES ($1::text::uuid, $2::int8::int4, $3::text::bank.pool_status, $4::text::bank.pool_status, $5, $6, $7, $8)",
            &[
                &pool_id,
                &revision,
                &status,
                &current,
                &reason,
                &approval.approval_id,
                &approval.requester_id,
                &approval.approver_id,
            ],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "UPDATE bank.earn_pools SET status = $2::text::bank.pool_status, status_revision = $3::int8::int4, updated_at = now() \
              WHERE id = $1::text::uuid",
            &[&pool_id, &status, &revision],
        )
        .map_err(|e| pg(&e))?;
        Ok(StatusChange {
            pool_id: pool_id.to_owned(),
            status: status.to_owned(),
            previous_status: current,
            revision,
            approved_by: approval.approver_id,
        })
    })
}

// ── Fixed-term auto-renew (BK-earn-03) ───────────────────────────────────────────────────────────────────────────────

/// `setAutoRenew`: the saver's choice for a fixed-term saving whose term has not ended; on, in a pool closed to new
/// savings, refuses `bank.pool_closed`. Off is always allowed. Moves no money.
pub fn set_auto_renew(
    d: &Deps<'_>,
    position_id: &str,
    on: bool,
    now: Instant,
) -> Result<Position, Refusal> {
    in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.earn_positions WHERE id = $1::text::uuid FOR UPDATE",
                    position_cols()
                ),
                &[&position_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(row) = rows.first() else {
            return Err(position_not_found(position_id));
        };
        let row = Position::from_row(row)?;
        if row.status == "closed" {
            return Err(position_closed());
        }
        if row.status == "pending" {
            return Err(refuse(
                "bank.position_pending",
                format!("Position {position_id} is still pending — resume the deposit first"),
            ));
        }
        let Some(matures_at) = row.matures_at else {
            return Err(refuse(
                "bank.auto_renew_fixed_only",
                "Only a fixed-term saving renews: a flexible saving has no term to end",
            ));
        };
        if on && matures_at.0 <= now.0 {
            return Err(refuse(
                "bank.position_matured",
                format!(
                    "This saving's term ended on {}; take it back or save again",
                    matures_at.iso()
                ),
            ));
        }
        if on {
            let pools = tx
                .query(
                    "SELECT status::text, name FROM bank.earn_pools WHERE id = $1::text::uuid",
                    &[&row.pool_id],
                )
                .map_err(|e| pg(&e))?;
            let (status, name) = match pools.first() {
                Some(r) => (
                    Some(r.try_get::<_, String>(0).map_err(|e| pg(&e))?),
                    r.try_get::<_, String>(1).map_err(|e| pg(&e))?,
                ),
                None => (None, row.pool_id.clone()),
            };
            if status.as_deref() != Some("open") {
                return Err(refuse(
                    "bank.pool_closed",
                    format!("Pool \"{name}\" is closed"),
                ));
            }
        }
        if row.auto_renew != on {
            tx.execute(
                "UPDATE bank.earn_positions SET auto_renew = $2 WHERE id = $1::text::uuid",
                &[&position_id, &on],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(Position {
            auto_renew: on,
            ..row
        })
    })
}

/// `RenewalReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RenewalReport {
    pub renewed: Vec<(String, Vec<i64>, Instant)>,
    pub skipped: Vec<(String, &'static str)>,
}

impl RenewalReport {
    pub fn json(&self) -> Json {
        Json::obj([
            (
                "renewed",
                Json::Array(
                    self.renewed
                        .iter()
                        .map(|(id, terms, matures)| {
                            Json::obj([
                                ("positionId", Json::str(id.clone())),
                                (
                                    "terms",
                                    Json::Array(terms.iter().map(|t| Json::int(*t)).collect()),
                                ),
                                ("maturesAt", Json::str(matures.iso())),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("skipped", skipped_json(&self.skipped)),
        ])
    }
}

/// `accountBlock`: why identity's answer stops a renewal, or none when the account is active.
fn account_block(d: &Deps<'_>, user_id: &str) -> Option<&'static str> {
    match d.recipients.status_of(user_id) {
        Ok(RecipientStatus::Active) => None,
        Ok(_) => Some("bank.account_not_active"),
        Err(e) if e.unset => Some("bank.recipient_check_unset"),
        Err(_) => Some("bank.recipient_check_unavailable"),
    }
}

/// `renewDue`: every open saving with auto-renew on whose term ended by `at` starts its next term, each counted from
/// the end of the one before. Each term is one `earn_renewals` row keyed (saving, term), so a run that fires twice
/// renews once. Nothing posts: the principal never left the stake pot. A saver whose account is not active, or whom
/// identity cannot answer for, is skipped with the reason; `limit` counts the savings renewed or failed.
pub fn renew_due(
    d: &Deps<'_>,
    at_: Option<Instant>,
    pool_id: Option<&str>,
    limit: Option<f64>,
) -> Result<RenewalReport, Refusal> {
    let when = at_.unwrap_or(d.now);
    let limit = renew_batch_limit(limit)?;
    let mut report = RenewalReport::default();
    let mut acted = 0;
    let mut after: Option<String> = None;
    while acted < limit {
        let page: Vec<(String, String)> = with(d.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT p.id::text, p.user_id FROM bank.earn_positions p JOIN bank.earn_pools pl ON pl.id = p.pool_id \
                          WHERE p.status = 'active' AND p.auto_renew AND p.matures_at <= {} AND pl.status = 'open' \
                            AND ($2::text IS NULL OR p.pool_id = $2::text::uuid) \
                            AND ($3::text IS NULL OR p.id > $3::text::uuid) \
                          ORDER BY p.id ASC LIMIT $4",
                        at("$1")
                    ),
                    &[&when.0, &pool_id, &after, &limit],
                )
                .map_err(|e| pg(&e))?;
            rows.iter()
                .map(|r| {
                    Ok((
                        r.try_get(0).map_err(|e| pg(&e))?,
                        r.try_get(1).map_err(|e| pg(&e))?,
                    ))
                })
                .collect()
        })?;
        let Some(last) = page.last() else { break };
        after = Some(last.0.clone());
        let mut blocks: HashMap<String, Option<&'static str>> = HashMap::new();
        for (_, user) in &page {
            if !blocks.contains_key(user) {
                blocks.insert(user.clone(), account_block(d, user));
            }
        }
        for (id, user) in &page {
            if acted >= limit {
                break;
            }
            if let Some(Some(code)) = blocks.get(user) {
                report.skipped.push((id.clone(), code));
                continue;
            }
            acted += 1;
            match renew_one(d, id, when) {
                Ok(Renewed::Skipped(code)) => report.skipped.push((id.clone(), code)),
                Ok(Renewed::Terms(terms, matures)) if !terms.is_empty() => {
                    report.renewed.push((id.clone(), terms, matures));
                }
                Ok(Renewed::Terms(..)) => {}
                Err(r) => report
                    .skipped
                    .push((id.clone(), code_of(&r).unwrap_or("bank.earn_renew_failed"))),
            }
        }
        if i64::try_from(page.len()).unwrap_or(i64::MAX) < limit {
            break;
        }
    }
    Ok(report)
}

enum Renewed {
    Terms(Vec<i64>, Instant),
    Skipped(&'static str),
}

fn renew_one(d: &Deps<'_>, position_id: &str, when: Instant) -> Result<Renewed, Refusal> {
    in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.earn_positions WHERE id = $1::text::uuid FOR UPDATE",
                    position_cols()
                ),
                &[&position_id],
            )
            .map_err(|e| pg(&e))?;
        let row = rows.first().map(Position::from_row).transpose()?;
        // Taken back, or the choice turned off, since the list was read: nothing is due.
        let Some(row) = row else {
            return Ok(Renewed::Terms(Vec::new(), when));
        };
        let Some(mut matures_at) = row
            .matures_at
            .filter(|m| row.status == "active" && row.auto_renew && m.0 <= when.0)
        else {
            return Ok(Renewed::Terms(Vec::new(), row.matures_at.unwrap_or(when)));
        };
        let pools = tx
            .query(
                "SELECT status::text, kind::text, term_days::int8 FROM bank.earn_pools WHERE id = $1::text::uuid",
                &[&row.pool_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(p) = pools.first() else {
            return Ok(Renewed::Skipped("bank.pool_closed"));
        };
        let status: String = p.try_get(0).map_err(|e| pg(&e))?;
        let kind: String = p.try_get(1).map_err(|e| pg(&e))?;
        let term_days: Option<i64> = p.try_get(2).map_err(|e| pg(&e))?;
        if status != "open" {
            return Ok(Renewed::Skipped("bank.pool_closed"));
        }
        let Some(term_days) = term_days.filter(|t| kind == "fixed" && *t > 0) else {
            return Ok(Renewed::Skipped("bank.auto_renew_fixed_only"));
        };
        // The new term holds what the pot holds; a pot that disagrees is a take back the ledger finished and this
        // table did not, so it stays as it is.
        let book = d
            .ledger
            .balance(&LedgerAccount::earn_stake(
                &row.user_id,
                &row.asset_id,
                &row.id,
            ))
            .map_err(Refusal::Other)?;
        if book != row.principal {
            return Ok(Renewed::Skipped("bank.earn_principal_mismatch"));
        }
        let last: Option<i64> = tx
            .query_one(
                "SELECT max(term)::int8 FROM bank.earn_renewals WHERE position_id = $1::text::uuid",
                &[&position_id],
            )
            .map_err(|e| pg(&e))?
            .try_get(0)
            .map_err(|e| pg(&e))?;
        let mut term = last.unwrap_or(0);
        let mut terms = Vec::new();
        let principal = format_amount(row.principal);
        while matures_at.0 <= when.0 && terms.len() < MAX_TERMS_PER_RUN {
            term += 1;
            let next = Instant(matures_at.0 + term_days * DAY_MS);
            tx.execute(
                &format!(
                    "INSERT INTO bank.earn_renewals (position_id, term, previous_matures_at, matures_at, principal) \
                     VALUES ($1::text::uuid, $2::int8::int4, {}, {}, $5::text::numeric)",
                    at("$3"),
                    at("$4")
                ),
                &[&position_id, &term, &matures_at.0, &next.0, &principal],
            )
            .map_err(|e| pg(&e))?;
            terms.push(term);
            matures_at = next;
        }
        tx.execute(
            &format!(
                "UPDATE bank.earn_positions SET matures_at = {} WHERE id = $1::text::uuid",
                at("$2")
            ),
            &[&position_id, &matures_at.0],
        )
        .map_err(|e| pg(&e))?;
        Ok(Renewed::Terms(terms, matures_at))
    })
}

// ── Daily accrual ────────────────────────────────────────────────────────────────────────────────────────────────────

/// `AccrualResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccrualResult {
    pub pool_id: String,
    pub date: String,
    pub paid: Amount,
    pub recipients: i64,
    pub ledger_tx_id: Option<String>,
    pub already_accrued: bool,
}

impl AccrualResult {
    /// `ops.accrueInterest`'s row; the REST job's leaves out `paid`.
    pub fn json(&self, with_paid: bool) -> Json {
        let mut f = vec![
            ("poolId".to_owned(), Json::str(self.pool_id.clone())),
            ("date".to_owned(), Json::str(self.date.clone())),
        ];
        if with_paid {
            f.push(("paid".to_owned(), Json::str(format_amount(self.paid))));
        }
        f.push(("recipients".to_owned(), Json::int(self.recipients)));
        f.push((
            "alreadyAccrued".to_owned(),
            Json::Bool(self.already_accrued),
        ));
        Json::Object(f)
    }
}

/// One pool's failure in `accrueAll`: the day is not consumed for that pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccrualFailure {
    pub pool_id: String,
    pub reason: String,
    pub code: Option<&'static str>,
}

impl AccrualFailure {
    pub fn json(&self) -> Json {
        let mut f = vec![
            ("poolId".to_owned(), Json::str(self.pool_id.clone())),
            ("reason".to_owned(), Json::str(self.reason.clone())),
        ];
        if let Some(c) = self.code {
            f.push(("code".to_owned(), Json::str(c)));
        }
        Json::Object(f)
    }
}

/// `AccrueAllReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccrueAllReport {
    pub results: Vec<AccrualResult>,
    pub failures: Vec<AccrualFailure>,
}

impl AccrueAllReport {
    pub fn json(&self, with_paid: bool) -> Json {
        Json::obj([
            (
                "results",
                Json::Array(self.results.iter().map(|r| r.json(with_paid)).collect()),
            ),
            (
                "failures",
                Json::Array(self.failures.iter().map(AccrualFailure::json).collect()),
            ),
        ])
    }
}

/// `encodePayouts`: decimal strings, a payout list as the claim row stores it.
fn encode(payouts: &[Payout]) -> Json {
    Json::Array(
        payouts
            .iter()
            .map(|p| {
                Json::obj([
                    ("userId", Json::str(p.user_id.clone())),
                    ("amount", Json::str(format_amount(p.amount))),
                ])
            })
            .collect(),
    )
}

/// `decodePayouts`.
fn decode(stored: &str) -> Result<Vec<Payout>, Refusal> {
    let bad =
        || Refusal::Other("interest_accruals.planned_payouts is not a payout list".to_owned());
    let Json::Array(rows) = json::parse(stored).map_err(|_| bad())? else {
        return Err(bad());
    };
    rows.iter()
        .map(|r| match (r.get("userId"), r.get("amount")) {
            (Some(Json::String(u)), Some(Json::String(a))) => Ok(Payout {
                user_id: u.clone(),
                amount: parse_amount(a).map_err(Refusal::Other)?,
            }),
            _ => Err(bad()),
        })
        .collect()
}

enum Step {
    Done(AccrualResult),
    Resume {
        accrual_id: String,
        payouts: Vec<Payout>,
        rate_bps: i64,
    },
}

/// `accrue`: one day of interest for one pool, idempotent per (pool, day) twice over: the claim row
/// `unique(pool_id, accrual_date)` and the ledger key `bank.interest:<poolId>:<date>`.
pub fn accrue(
    d: &Deps<'_>,
    pool_id: &str,
    when: Instant,
    days_per_year: i64,
) -> Result<AccrualResult, Refusal> {
    let date = accrual_date(when);
    let boundary = accrual_boundary(when);
    let p = with(d.store, |c| pool(c, pool_id))?;
    // Step 1: claim the day and store the plan, committed before any money moves.
    let step = in_tx(d.store, |tx| {
        // The rate in force when the day began: a change recorded during the day pays from the next one.
        let rate_bps = rates::rate_for_day(tx, &p.id, boundary, p.apr_bps)?;
        let claimed = tx
            .query(
                "INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients) \
                 VALUES ($1::text::uuid, $2::text::date, $3::int8, 0, 0) \
                 ON CONFLICT (pool_id, accrual_date) DO NOTHING RETURNING id::text",
                &[&p.id, &date, &rate_bps],
            )
            .map_err(|e| pg(&e))?;
        let Some(claimed) = claimed.first() else {
            let row = tx
                .query_one(
                    "SELECT id::text, paid_amount::text, recipients::int8, ledger_tx_id, planned_payouts::text, rate_bps::int8 \
                       FROM bank.interest_accruals WHERE pool_id = $1::text::uuid AND accrual_date = $2::text::date",
                    &[&p.id, &date],
                )
                .map_err(|e| pg(&e))?;
            let ledger_tx_id: Option<String> = row.try_get(3).map_err(|e| pg(&e))?;
            let planned: Option<String> = row.try_get(4).map_err(|e| pg(&e))?;
            if let (None, Some(planned)) = (&ledger_tx_id, planned) {
                // A run planned the day and stopped before recording the post: pay exactly what it planned.
                return Ok(Step::Resume {
                    accrual_id: row.try_get(0).map_err(|e| pg(&e))?,
                    payouts: decode(&planned)?,
                    rate_bps: row.try_get(5).map_err(|e| pg(&e))?,
                });
            }
            return Ok(Step::Done(AccrualResult {
                pool_id: p.id.clone(),
                date: date.clone(),
                paid: parse_amount(&row.try_get::<_, String>(1).map_err(|e| pg(&e))?)
                    .map_err(Refusal::Other)?,
                recipients: row.try_get(2).map_err(|e| pg(&e))?,
                ledger_tx_id,
                already_accrued: true,
            }));
        };
        let accrual_id: String = claimed.try_get(0).map_err(|e| pg(&e))?;
        // The UTC day boundary is the cutoff whenever the scheduler runs: a saving opened at or after midnight earns
        // from the next day, and one that started unbonding before the day began earns nothing more.
        let positions = tx
            .query(
                &format!(
                    "SELECT id::text, user_id, principal::text FROM bank.earn_positions \
                      WHERE pool_id = $1::text::uuid AND status = 'active' AND opened_at < {b} \
                        AND (unbonding_started_at IS NULL OR unbonding_started_at >= {b}) \
                      ORDER BY id ASC",
                    b = at("$2")
                ),
                &[&p.id, &boundary.0],
            )
            .map_err(|e| pg(&e))?;
        let mut accruing = Vec::new();
        for r in &positions {
            let id: String = r.try_get(0).map_err(|e| pg(&e))?;
            let user: String = r.try_get(1).map_err(|e| pg(&e))?;
            let recorded = parse_amount(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)
                .map_err(Refusal::Other)?;
            let book = d
                .ledger
                .balance(&LedgerAccount::earn_stake(&user, &p.asset_id, &id))
                .map_err(Refusal::Other)?;
            let principal = stake_principal(&id, recorded, book)?;
            accruing.push(Accruing {
                position_id: id,
                user_id: user,
                principal,
            });
        }
        let plan = interest::plan_accrual(&accruing, rate_bps, days_per_year).ok_or_else(|| {
            Refusal::Other(format!(
                "APR must be a non-negative integer in bps, got {rate_bps}"
            ))
        })?;
        if plan.payouts.is_empty() {
            // A real outcome, recorded with no plan, so the row is final.
            return Ok(Step::Done(AccrualResult {
                pool_id: p.id.clone(),
                date: date.clone(),
                paid: 0,
                recipients: 0,
                ledger_tx_id: None,
                already_accrued: false,
            }));
        }
        tx.execute(
            "UPDATE bank.interest_accruals SET planned_payouts = $2::text::jsonb WHERE id = $1::text::uuid",
            &[&accrual_id, &encode(&plan.payouts).compact()],
        )
        .map_err(|e| pg(&e))?;
        Ok(Step::Resume {
            accrual_id,
            payouts: plan.payouts,
            rate_bps,
        })
    })?;
    match step {
        Step::Done(r) => Ok(r),
        Step::Resume {
            accrual_id,
            payouts,
            rate_bps,
        } => settle(d, &p, &date, &accrual_id, &payouts, rate_bps, true),
    }
}

/// `settleAccrual`: post the stored plan, then record it. When the reserve cannot cover the plan, `release` deletes the
/// claim so the day is planned afresh once the pool is funded (today's day), and otherwise keeps the stored plan (an
/// earlier day that only resumes).
fn settle(
    d: &Deps<'_>,
    p: &Pool,
    date: &str,
    accrual_id: &str,
    payouts: &[Payout],
    rate_bps: i64,
    release: bool,
) -> Result<AccrualResult, Refusal> {
    let total: Amount = payouts.iter().map(|x| x.amount).sum();
    let input = Json::obj([
        ("poolId", Json::str(p.id.clone())),
        ("date", Json::str(date)),
        ("assetId", Json::str(p.asset_id.clone())),
        ("payouts", encode(payouts)),
    ]);
    let posted = match post(
        d,
        "earnInterest",
        &input,
        &format!("bank.interest:{}:{date}", p.id),
        true,
    )? {
        Ok(tx) => tx,
        Err(f) if f.insufficient() => {
            // Nothing posted. The guard keeps a claim a concurrent run has already recorded.
            if release {
                with(d.store, |c| {
                    c.execute(
                        "DELETE FROM bank.interest_accruals WHERE id = $1::text::uuid AND ledger_tx_id IS NULL",
                        &[&accrual_id],
                    )
                    .map_err(|e| pg(&e))
                })?;
            }
            return Err(refuse(
                "bank.pool_underfunded",
                format!(
                    "Pool \"{}\" cannot cover {} {} of interest for {date}",
                    p.name,
                    format_amount(total),
                    p.asset_id
                ),
            ));
        }
        Err(f) => return Err(Refusal::Other(f.message().to_owned())),
    };
    let recipients = i64::try_from(payouts.len()).unwrap_or(i64::MAX);
    let paid = format_amount(total);
    with(d.store, |c| {
        let recorded = c
            .execute(
                "UPDATE bank.interest_accruals SET paid_amount = $2::text::numeric, recipients = $3::int8::int4, ledger_tx_id = $4 \
                  WHERE id = $1::text::uuid",
                &[&accrual_id, &paid, &recipients, &posted.id],
            )
            .map_err(|e| pg(&e))?;
        if recorded == 0 {
            // The claim was deleted after the post landed: the payment stands, so it gets its record back.
            c.execute(
                "INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, ledger_tx_id, planned_payouts) \
                 VALUES ($1::text::uuid, $2::text::date, $3::int8, $4::text::numeric, $5::int8::int4, $6, $7::text::jsonb) \
                 ON CONFLICT (pool_id, accrual_date) DO UPDATE \
                    SET paid_amount = EXCLUDED.paid_amount, recipients = EXCLUDED.recipients, \
                        ledger_tx_id = EXCLUDED.ledger_tx_id, planned_payouts = EXCLUDED.planned_payouts",
                &[
                    &p.id,
                    &date,
                    &rate_bps,
                    &paid,
                    &recipients,
                    &posted.id,
                    &encode(payouts).compact(),
                ],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    Ok(AccrualResult {
        pool_id: p.id.clone(),
        date: date.to_owned(),
        paid: total,
        recipients,
        ledger_tx_id: Some(posted.id),
        already_accrued: false,
    })
}

/// `resumeEarlierAccruals`: finish earlier days that stopped between planning and recording, each from its own stored
/// plan; no day is planned here.
fn resume_earlier(d: &Deps<'_>, before: &str, report: &mut AccrueAllReport) -> Result<(), Refusal> {
    let pending = with(d.store, |c| {
        c.query(
            "SELECT id::text, pool_id::text, accrual_date::text, rate_bps::int8, planned_payouts::text FROM bank.interest_accruals \
              WHERE planned_payouts IS NOT NULL AND ledger_tx_id IS NULL AND accrual_date < $1::text::date \
              ORDER BY accrual_date ASC, id ASC",
            &[&before],
        )
        .map_err(|e| pg(&e))
    })?;
    for r in &pending {
        let pool_id: String = r.try_get(1).map_err(|e| pg(&e))?;
        let date: String = r.try_get(2).map_err(|e| pg(&e))?;
        let out = (|| {
            let p = with(d.store, |c| pool(c, &pool_id))?;
            let id: String = r.try_get(0).map_err(|e| pg(&e))?;
            let rate: i64 = r.try_get(3).map_err(|e| pg(&e))?;
            let planned: String = r.try_get(4).map_err(|e| pg(&e))?;
            settle(d, &p, &date, &id, &decode(&planned)?, rate, false)
        })();
        match out {
            Ok(res) => report.results.push(res),
            Err(e) => report.failures.push(AccrualFailure {
                pool_id: pool_id.clone(),
                reason: format!("{date}: {}", message_of(&e)),
                code: code_of(&e),
            }),
        }
    }
    Ok(())
}

/// `accrueAll`: earlier days left planned are finished first, then every open pool, and every closed pool that still
/// holds savings, accrues for the day. One pool's failure is reported and does not withhold the others' yield.
pub fn accrue_all(d: &Deps<'_>, when: Instant) -> Result<AccrueAllReport, Refusal> {
    let pools = with(d.store, pools_for_accrual)?;
    let mut report = AccrueAllReport::default();
    resume_earlier(d, &accrual_date(when), &mut report)?;
    for p in pools {
        match accrue(d, &p.id, when, DAYS_PER_YEAR) {
            Ok(r) => report.results.push(r),
            Err(e) => report.failures.push(AccrualFailure {
                pool_id: p.id.clone(),
                reason: message_of(&e),
                code: code_of(&e),
            }),
        }
    }
    Ok(report)
}

/// `interestPaid`: what a pool has paid in all, summed from the day rows.
pub fn interest_paid(d: &Deps<'_>, pool_id: &str) -> Result<Amount, Refusal> {
    with(d.store, |c| {
        let total: String = c
            .query_one(
                "SELECT COALESCE(SUM(paid_amount), 0)::text FROM bank.interest_accruals WHERE pool_id = $1::text::uuid",
                &[&pool_id],
            )
            .map_err(|e| pg(&e))?
            .try_get(0)
            .map_err(|e| pg(&e))?;
        parse_amount(&total).map_err(Refusal::Other)
    })
}

/// `interestHistory`: what one person earned from one pool, a row per paid day, newest first. Only posted days count;
/// `total` sums every itemised paid day; paid days written before the stored plan are counted in `unitemisedDays`, never
/// guessed into anyone's figures.
pub fn interest_history(
    c: &mut impl GenericClient,
    user_id: &str,
    pool_id: &str,
    limit: Option<f64>,
    before: Option<&str>,
) -> Result<Json, Refusal> {
    let page = interest_list_limit(limit)?;
    pool(c, pool_id)?;
    let mine = Json::Array(vec![Json::obj([("userId", Json::str(user_id))])]).compact();
    let days = c
        .query(
            "SELECT a.accrual_date::text, a.rate_bps::int8, p.amount, a.ledger_tx_id \
               FROM bank.interest_accruals a \
               CROSS JOIN LATERAL jsonb_to_recordset(a.planned_payouts) AS p(\"userId\" text, amount text) \
              WHERE a.pool_id = $1::text::uuid AND a.ledger_tx_id IS NOT NULL AND a.planned_payouts @> $2::text::jsonb \
                AND p.\"userId\" = $3 \
                AND ($4::text IS NULL OR a.accrual_date < $4::text::date) \
              ORDER BY a.accrual_date DESC LIMIT $5",
            &[&pool_id, &mine, &user_id, &before, &page],
        )
        .map_err(|e| pg(&e))?;
    let total: String = c
        .query_one(
            "SELECT COALESCE(SUM(p.amount::numeric), 0)::text \
               FROM bank.interest_accruals a \
               CROSS JOIN LATERAL jsonb_to_recordset(a.planned_payouts) AS p(\"userId\" text, amount text) \
              WHERE a.pool_id = $1::text::uuid AND a.ledger_tx_id IS NOT NULL AND a.planned_payouts @> $2::text::jsonb \
                AND p.\"userId\" = $3",
            &[&pool_id, &mine, &user_id],
        )
        .map_err(|e| pg(&e))?
        .try_get(0)
        .map_err(|e| pg(&e))?;
    let unitemised: i64 = c
        .query_one(
            "SELECT count(*)::int8 FROM bank.interest_accruals \
              WHERE pool_id = $1::text::uuid AND ledger_tx_id IS NOT NULL AND planned_payouts IS NULL AND paid_amount > 0",
            &[&pool_id],
        )
        .map_err(|e| pg(&e))?
        .try_get(0)
        .map_err(|e| pg(&e))?;
    let mut rows = Vec::new();
    for r in &days {
        let amount = parse_amount(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)
            .map_err(Refusal::Other)?;
        rows.push(Json::obj([
            (
                "date",
                Json::str(r.try_get::<_, String>(0).map_err(|e| pg(&e))?),
            ),
            ("rateBps", Json::int(r.try_get(1).map_err(|e| pg(&e))?)),
            ("amount", Json::str(format_amount(amount))),
            (
                "ledgerTxId",
                Json::str(r.try_get::<_, String>(3).map_err(|e| pg(&e))?),
            ),
        ]));
    }
    Ok(Json::obj([
        ("days", Json::Array(rows)),
        (
            "total",
            Json::str(format_amount(parse_amount(&total).map_err(Refusal::Other)?)),
        ),
        ("unitemisedDays", Json::int(unitemised)),
    ]))
}
