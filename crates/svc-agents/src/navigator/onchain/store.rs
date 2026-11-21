//! `NavigatorOnchainStore`: the person's bindings and the Navigator's orders. Every read and write names the signed-in
//! person; no row of another is reachable. Wei is `numeric(78,0)`, read and written as text.

use postgres::IsolationLevel;
use postgres::types::ToSql;

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::db::{self, StoreError};
use crate::runtime::ms;

use super::rules::{BINDING_NOT_FOUND, Refused, bind_key};

/// `NavigatorOnchainBinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub id: String,
    pub chain_id: i64,
    pub account: String,
    pub session_key: String,
    pub spend_limit_wei: String,
    pub valid_until: i64,
    pub targets: Vec<String>,
    pub selectors: Vec<String>,
    pub spec_hash: String,
    pub bind_key: String,
    pub created_at: Instant,
    pub updated_at: Instant,
    pub revoke_requested_at: Option<Instant>,
}

impl Binding {
    pub fn to_json(&self) -> Json {
        let texts = |v: &[String]| Json::Array(v.iter().cloned().map(Json::str).collect());
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("chainId", Json::int(self.chain_id)),
            ("account", Json::str(self.account.clone())),
            ("sessionKey", Json::str(self.session_key.clone())),
            ("spendLimitWei", Json::str(self.spend_limit_wei.clone())),
            ("validUntil", Json::int(self.valid_until)),
            ("targets", texts(&self.targets)),
            ("selectors", texts(&self.selectors)),
            ("specHash", Json::str(self.spec_hash.clone())),
            ("bindKey", Json::str(self.bind_key.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
            ("updatedAt", Json::str(self.updated_at.iso())),
            (
                "revokeRequestedAt",
                self.revoke_requested_at
                    .map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ])
    }
}

/// `NavigatorOrder`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    pub id: String,
    pub session_id: String,
    pub order_key: String,
    pub text: String,
    pub chain_id: i64,
    pub account: String,
    pub pool: String,
    pub token_in: String,
    pub token_in_symbol: String,
    pub token_out: String,
    pub token_out_symbol: String,
    pub amount_in_wei: String,
    pub min_out_wei: String,
    pub status: String,
    pub tx_hash: Option<String>,
    pub created_at: Instant,
}

impl Order {
    pub fn to_json(&self) -> Json {
        let s = |v: &str| Json::str(v.to_owned());
        Json::obj([
            ("id", s(&self.id)),
            ("sessionId", s(&self.session_id)),
            ("orderKey", s(&self.order_key)),
            ("placedBy", s("assistant")),
            ("text", s(&self.text)),
            ("chainId", Json::int(self.chain_id)),
            ("account", s(&self.account)),
            ("pool", s(&self.pool)),
            ("tokenIn", s(&self.token_in)),
            ("tokenInSymbol", s(&self.token_in_symbol)),
            ("tokenOut", s(&self.token_out)),
            ("tokenOutSymbol", s(&self.token_out_symbol)),
            ("amountInWei", s(&self.amount_in_wei)),
            ("minOutWei", s(&self.min_out_wei)),
            ("status", s(&self.status)),
            ("txHash", self.tx_hash.as_deref().map_or(Json::Null, s)),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

fn binding_columns() -> String {
    format!(
        "id::text, chain_id, account, session_key, spend_limit_wei::text, valid_until, targets, selectors, spec_hash, \
         bind_key, {}, {}, {}",
        ms("created_at"),
        ms("updated_at"),
        ms("revoke_requested_at")
    )
}

fn binding_of(r: &postgres::Row) -> Result<Binding, StoreError> {
    Ok(Binding {
        id: r.try_get(0)?,
        chain_id: i64::from(r.try_get::<_, i32>(1)?),
        account: r.try_get(2)?,
        session_key: r.try_get(3)?,
        spend_limit_wei: r.try_get(4)?,
        valid_until: r.try_get(5)?,
        targets: r.try_get(6)?,
        selectors: r.try_get(7)?,
        spec_hash: r.try_get(8)?,
        bind_key: r.try_get(9)?,
        created_at: Instant(r.try_get(10)?),
        updated_at: Instant(r.try_get(11)?),
        revoke_requested_at: r.try_get::<_, Option<i64>>(12)?.map(Instant),
    })
}

fn order_columns() -> String {
    format!(
        "id::text, session_id::text, order_key, ask_text, chain_id, account, pool, token_in, token_in_symbol, token_out, \
         token_out_symbol, amount_in_wei::text, min_out_wei::text, status, tx_hash, {}",
        ms("created_at")
    )
}

fn order_of(r: &postgres::Row) -> Result<Order, StoreError> {
    Ok(Order {
        id: r.try_get(0)?,
        session_id: r.try_get(1)?,
        order_key: r.try_get(2)?,
        text: r.try_get(3)?,
        chain_id: i64::from(r.try_get::<_, i32>(4)?),
        account: r.try_get(5)?,
        pool: r.try_get(6)?,
        token_in: r.try_get(7)?,
        token_in_symbol: r.try_get(8)?,
        token_out: r.try_get(9)?,
        token_out_symbol: r.try_get(10)?,
        amount_in_wei: r.try_get(11)?,
        min_out_wei: r.try_get(12)?,
        status: r.try_get(13)?,
        tx_hash: r.try_get(14)?,
        created_at: Instant(r.try_get(15)?),
    })
}

/// A chain id the schema checked as a positive integer; one past `integer` is a database error there, and here.
fn chain(chain_id: i64) -> Result<i32, StoreError> {
    i32::try_from(chain_id)
        .map_err(|_| StoreError::new("value out of range for type integer", Some("22003")))
}

fn query(
    pool: &Pool,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<postgres::Row>, StoreError> {
    db::with_client(pool, |c| Ok(c.query(sql, params)?))
}

/// What a person prepared for the Navigator's key.
pub struct BindInput<'a> {
    pub user_id: &'a str,
    pub chain_id: i64,
    pub account: &'a str,
    pub session_key: &'a str,
    pub spend_limit_wei: u128,
    pub valid_until: i64,
    pub targets: &'a [String],
    pub selectors: &'a [String],
    pub spec_hash: &'a str,
}

/// `bind`: once per key; the same scope again is the first row, a new scope replaces it and clears a revoke request.
pub fn bind(pool: &Pool, b: &BindInput<'_>) -> Result<Binding, StoreError> {
    let key = bind_key(b.chain_id, b.account, b.session_key);
    let lower = |v: &[String]| v.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
    let (targets, selectors) = (lower(b.targets), lower(b.selectors));
    let rows = query(
        pool,
        &format!(
            "INSERT INTO agents.navigator_onchain_bindings
               (user_id, chain_id, account, session_key, spend_limit_wei, valid_until, targets, selectors, spec_hash, bind_key)
             VALUES ($1, $2, $3, $4, $5::text::numeric, $6, $7, $8, $9, $10)
             ON CONFLICT (user_id, bind_key) DO UPDATE SET
               spend_limit_wei = EXCLUDED.spend_limit_wei,
               valid_until = EXCLUDED.valid_until,
               targets = EXCLUDED.targets,
               selectors = EXCLUDED.selectors,
               spec_hash = EXCLUDED.spec_hash,
               updated_at = now(),
               revoke_requested_at = NULL
             WHERE agents.navigator_onchain_bindings.spec_hash <> EXCLUDED.spec_hash
             RETURNING {}",
            binding_columns()
        ),
        &[
            &b.user_id,
            &chain(b.chain_id)?,
            &b.account.to_lowercase(),
            &b.session_key.to_lowercase(),
            &b.spend_limit_wei.to_string(),
            &b.valid_until,
            &targets,
            &selectors,
            &b.spec_hash.to_lowercase(),
            &key,
        ],
    )?;
    if let Some(r) = rows.first() {
        return binding_of(r);
    }
    binding(pool, b.user_id, b.chain_id, b.account, b.session_key)?.ok_or_else(|| {
        StoreError::new(
            "navigator binding vanished between its write and its read",
            None,
        )
    })
}

pub fn binding(
    pool: &Pool,
    user_id: &str,
    chain_id: i64,
    account: &str,
    session_key: &str,
) -> Result<Option<Binding>, StoreError> {
    let rows = query(
        pool,
        &format!(
            "SELECT {} FROM agents.navigator_onchain_bindings WHERE user_id = $1 AND bind_key = $2",
            binding_columns()
        ),
        &[&user_id, &bind_key(chain_id, account, session_key)],
    )?;
    rows.first().map(binding_of).transpose()
}

/// Why a revoke request gave no binding: none to mark, or the database.
#[derive(Debug)]
pub enum RevokeError {
    Refused(Refused),
    Store(StoreError),
}

impl From<StoreError> for RevokeError {
    fn from(e: StoreError) -> RevokeError {
        RevokeError::Store(e)
    }
}

/// `requestRevoke`: marked once; a second ask returns the first ask's time.
pub fn request_revoke(
    pool: &Pool,
    user_id: &str,
    chain_id: i64,
    account: &str,
    session_key: &str,
) -> Result<Binding, RevokeError> {
    let rows = query(
        pool,
        &format!(
            "UPDATE agents.navigator_onchain_bindings SET revoke_requested_at = COALESCE(revoke_requested_at, now())
              WHERE user_id = $1 AND bind_key = $2 RETURNING {}",
            binding_columns()
        ),
        &[&user_id, &bind_key(chain_id, account, session_key)],
    )?;
    match rows.first() {
        Some(r) => Ok(binding_of(r)?),
        None => Err(RevokeError::Refused(Refused(BINDING_NOT_FOUND))),
    }
}

/// `liveBinding`: the newest binding for this key the person has not asked to revoke.
pub fn live_binding(
    pool: &Pool,
    user_id: &str,
    chain_id: i64,
    session_key: &str,
) -> Result<Option<Binding>, StoreError> {
    let rows = query(
        pool,
        &format!(
            "SELECT {} FROM agents.navigator_onchain_bindings
              WHERE user_id = $1 AND chain_id = $2 AND session_key = $3 AND revoke_requested_at IS NULL
              ORDER BY updated_at DESC, id LIMIT 1",
            binding_columns()
        ),
        &[&user_id, &chain(chain_id)?, &session_key.to_lowercase()],
    )?;
    rows.first().map(binding_of).transpose()
}

pub fn order(pool: &Pool, user_id: &str, order_key: &str) -> Result<Option<Order>, StoreError> {
    let rows = query(
        pool,
        &format!(
            "SELECT {} FROM agents.navigator_orders WHERE user_id = $1 AND order_key = $2",
            order_columns()
        ),
        &[&user_id, &order_key],
    )?;
    rows.first().map(order_of).transpose()
}

const HELD_SQL: &str = "SELECT coalesce(sum(amount_in_wei), 0)::text FROM agents.navigator_orders
   WHERE chain_id = $1 AND account = $2 AND spec_hash = $3 AND status IN ('sending', 'sent', 'filled')";

/// A sum of wei past uint128 holds more than any cap: it saturates.
fn wei(text: &str) -> u128 {
    text.parse::<u128>().unwrap_or(u128::MAX)
}

/// `heldWei`: what every person's orders under one grant on one account hold of its cap.
pub fn held_wei(
    pool: &Pool,
    chain_id: i64,
    account: &str,
    spec_hash: &str,
) -> Result<u128, StoreError> {
    let rows = query(
        pool,
        HELD_SQL,
        &[
            &chain(chain_id)?,
            &account.to_lowercase(),
            &spec_hash.to_lowercase(),
        ],
    )?;
    let n: String = rows
        .first()
        .map(|r| r.try_get(0))
        .transpose()?
        .unwrap_or_else(|| "0".to_owned());
    Ok(wei(&n))
}

/// An order to write as sending.
pub struct ReserveInput<'a> {
    pub user_id: &'a str,
    pub session_id: &'a str,
    pub order_key: &'a str,
    pub text: &'a str,
    pub chain_id: i64,
    pub account: &'a str,
    pub session_key: &'a str,
    pub spec_hash: &'a str,
    pub pool: &'a str,
    pub token_in: &'a str,
    pub token_in_symbol: &'a str,
    pub token_out: &'a str,
    pub token_out_symbol: &'a str,
    pub amount_in_wei: u128,
    pub min_out_wei: u128,
    pub cap_wei: u128,
    pub chain_spent_wei: u128,
}

/// `reserveOrder`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reserved {
    Reserved(Order),
    Existing(Order),
    OverCap,
}

/// `reserveOrder`: under the grant's lock (one per account and grant, across every person), the same key again is the
/// first order, and a new order is written as sending only if it fits in what is left of the cap.
pub fn reserve_order(pool: &Pool, o: &ReserveInput<'_>) -> Result<Reserved, StoreError> {
    let account = o.account.to_lowercase();
    let spec_hash = o.spec_hash.to_lowercase();
    let lock = format!("agents:navigator:cap:{}:{account}:{spec_hash}", o.chain_id);
    let chain_id = chain(o.chain_id)?;
    db::transaction(pool, IsolationLevel::ReadCommitted, |tx| {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock],
        )?;
        let found = tx.query(
            &format!(
                "SELECT {} FROM agents.navigator_orders WHERE user_id = $1 AND order_key = $2",
                order_columns()
            ),
            &[&o.user_id, &o.order_key],
        )?;
        if let Some(r) = found.first() {
            return Ok(Reserved::Existing(order_of(r)?));
        }
        let held = tx.query(HELD_SQL, &[&chain_id, &account, &spec_hash])?;
        let held: String = held
            .first()
            .map(|r| r.try_get(0))
            .transpose()?
            .unwrap_or_else(|| "0".to_owned());
        let total = wei(&held)
            .checked_add(o.chain_spent_wei)
            .and_then(|n| n.checked_add(o.amount_in_wei));
        if total.is_none_or(|t| t > o.cap_wei) {
            return Ok(Reserved::OverCap);
        }
        let rows = tx.query(
            &format!(
                "INSERT INTO agents.navigator_orders
                   (user_id, session_id, order_key, ask_text, chain_id, account, session_key, spec_hash, pool, token_in,
                    token_in_symbol, token_out, token_out_symbol, amount_in_wei, min_out_wei)
                 VALUES ($1, $2::text::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text::numeric,
                         $15::text::numeric)
                 RETURNING {}",
                order_columns()
            ),
            &[
                &o.user_id,
                &o.session_id,
                &o.order_key,
                &o.text,
                &chain_id,
                &account,
                &o.session_key.to_lowercase(),
                &spec_hash,
                &o.pool.to_lowercase(),
                &o.token_in.to_lowercase(),
                &o.token_in_symbol,
                &o.token_out.to_lowercase(),
                &o.token_out_symbol,
                &o.amount_in_wei.to_string(),
                &o.min_out_wei.to_string(),
            ],
        )?;
        let r = rows
            .first()
            .ok_or_else(|| StoreError::new("the order insert returned no row", None))?;
        Ok(Reserved::Reserved(order_of(r)?))
    })
}

/// `settleOrder`: sent with its hash, then filled or reverted as the receipt says, or failed.
pub fn settle_order(
    pool: &Pool,
    user_id: &str,
    order_key: &str,
    status: &str,
    tx_hash: Option<&str>,
) -> Result<Order, StoreError> {
    let rows = query(
        pool,
        &format!(
            "UPDATE agents.navigator_orders SET status = $3, tx_hash = COALESCE($4, tx_hash), updated_at = now()
              WHERE user_id = $1 AND order_key = $2 RETURNING {}",
            order_columns()
        ),
        &[&user_id, &order_key, &status, &tx_hash],
    )?;
    rows.first().map(order_of).transpose()?.ok_or_else(|| {
        StoreError::new(
            "navigator order vanished between its write and its update",
            None,
        )
    })
}

/// `orders`: the person's orders in one session, newest first, at most 100.
pub fn orders(pool: &Pool, user_id: &str, session_id: &str) -> Result<Vec<Order>, StoreError> {
    let rows = query(
        pool,
        &format!(
            "SELECT {} FROM agents.navigator_orders WHERE user_id = $1 AND session_id = $2::text::uuid
              ORDER BY created_at DESC, id LIMIT 100",
            order_columns()
        ),
        &[&user_id, &session_id],
    )?;
    rows.iter().map(order_of).collect()
}
