//! A customer's own basis (`services/svc-tax/src/basis-store.ts`, `createPgBasisStore`): append-only versions in
//! `tax.basis_overrides`, one chain per lot under an advisory lock, the same payload twice storing one version, a removal
//! a tombstone. Business key `basisoverride:<userId>:<lotId>:<version>`.

use std::sync::Arc;

use postgres::GenericClient;

use super::pool::{Pool, db_failure};
use crate::money::parse_amount;
use crate::ports::{ActiveBasis, BasisKind, BasisRow, BasisStore, BasisWrite};
use crate::tax::{Failure, TaxError, format_amount, locale_compare};
use crate::time::Instant;

pub const TAX_BASIS_OVERRIDE_ABSENT: &str = "tax.basis_override_absent";
pub const TAX_BASIS_PRICE_INVALID: &str = "tax.basis_price_invalid";

const SELECT_COLUMNS: &str = "user_id, lot_id, version, kind, price_per_unit::text AS price_per_unit, \
     floor(extract(epoch from acquired_at) * 1000)::int8 AS acquired_ms, source_note, asset_id, qty::text AS qty, business_key";

pub struct PgBasisStore {
    pool: Arc<Pool>,
}

fn refused(code: &'static str, message: &str) -> Failure {
    Failure::Refused(TaxError {
        code,
        message: message.to_owned(),
    })
}

/// `decimalColumn`: numeric(38,18) comes back with trailing zeros; the book compares the canonical decimal string.
fn decimal_column(value: Option<String>) -> Result<Option<String>, Failure> {
    value
        .map(|v| {
            parse_amount(&v).map(format_amount).map_err(|_| {
                refused(
                    TAX_BASIS_PRICE_INVALID,
                    "a stored basis figure was not a decimal string",
                )
            })
        })
        .transpose()
}

fn kind_of(raw: &str) -> Result<BasisKind, Failure> {
    match raw {
        "override" => Ok(BasisKind::Override),
        "manual" => Ok(BasisKind::Manual),
        "tombstone" => Ok(BasisKind::Tombstone),
        other => Err(Failure::Internal(format!("unknown basis kind {other}"))),
    }
}

/// `toRow`.
fn to_row(row: &postgres::Row) -> Result<BasisRow, Failure> {
    let get = |e: postgres::Error| db_failure(&e);
    let version: i32 = row.try_get("version").map_err(get)?;
    let acquired: Option<i64> = row.try_get("acquired_ms").map_err(get)?;
    Ok(BasisRow {
        user_id: row.try_get("user_id").map_err(get)?,
        lot_id: row.try_get("lot_id").map_err(get)?,
        version: i64::from(version),
        kind: kind_of(row.try_get::<_, &str>("kind").map_err(get)?)?,
        price_per_unit: decimal_column(row.try_get("price_per_unit").map_err(get)?)?,
        acquired_at: acquired.map(|ms| Instant(ms).iso()),
        source_note: row.try_get("source_note").map_err(get)?,
        asset_id: row.try_get("asset_id").map_err(get)?,
        qty: decimal_column(row.try_get("qty").map_err(get)?)?,
        business_key: row.try_get("business_key").map_err(get)?,
    })
}

/// `activeOf`.
fn active_of(row: &BasisRow) -> Option<ActiveBasis> {
    if row.kind == BasisKind::Tombstone {
        return None;
    }
    let (price, acquired, note) = (
        row.price_per_unit.clone()?,
        row.acquired_at.clone()?,
        row.source_note.clone()?,
    );
    let manual = row.kind == BasisKind::Manual;
    if manual && (row.asset_id.is_none() || row.qty.is_none()) {
        return None;
    }
    Some(ActiveBasis {
        manual,
        lot_id: row.lot_id.clone(),
        version: row.version,
        price_per_unit: price,
        acquired_at: acquired,
        source_note: note,
        asset_id: if manual { row.asset_id.clone() } else { None },
        qty: if manual { row.qty.clone() } else { None },
    })
}

fn write_kind(w: &BasisWrite) -> BasisKind {
    if w.manual {
        BasisKind::Manual
    } else {
        BasisKind::Override
    }
}

/// `sameWrite`.
fn same_write(row: &BasisRow, w: &BasisWrite) -> bool {
    row.kind == write_kind(w)
        && row.price_per_unit.as_deref() == Some(w.price_per_unit.as_str())
        && row.acquired_at.as_deref() == Some(w.acquired_at.as_str())
        && row.source_note.as_deref() == Some(w.source_note.as_str())
        && row.asset_id == w.asset_id
        && row.qty == w.qty
}

fn business_key(user_id: &str, lot_id: &str, version: i64) -> String {
    format!("basisoverride:{user_id}:{lot_id}:{version}")
}

fn lock_key(user_id: &str, lot_id: &str) -> String {
    format!("tax.basis:{user_id}:{lot_id}")
}

fn latest(
    tx: &mut impl GenericClient,
    user_id: &str,
    lot_id: &str,
) -> Result<Option<BasisRow>, Failure> {
    let rows = tx
        .query(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM tax.basis_overrides WHERE user_id = $1 AND lot_id = $2 \
                 ORDER BY version DESC LIMIT 1"
            ),
            &[&user_id, &lot_id],
        )
        .map_err(|e| db_failure(&e))?;
    rows.first().map(to_row).transpose()
}

fn insert(tx: &mut impl GenericClient, row: &BasisRow) -> Result<(), Failure> {
    let version = i32::try_from(row.version)
        .map_err(|_| Failure::Internal("version out of range".to_owned()))?;
    tx.execute(
        "INSERT INTO tax.basis_overrides (
           user_id, lot_id, version, kind, price_per_unit, acquired_at, source_note, asset_id, qty, business_key
         ) VALUES ($1, $2, $3, $4, $5::text::numeric, $6::text::timestamptz, $7, $8, $9::text::numeric, $10)",
        &[
            &row.user_id,
            &row.lot_id,
            &version,
            &row.kind.name(),
            &row.price_per_unit,
            &row.acquired_at,
            &row.source_note,
            &row.asset_id,
            &row.qty,
            &row.business_key,
        ],
    )
    .map_err(|e| db_failure(&e))?;
    Ok(())
}

impl PgBasisStore {
    pub fn new(pool: Arc<Pool>) -> PgBasisStore {
        PgBasisStore { pool }
    }

    /// `sql.begin`: one transaction holding the lot's advisory lock.
    fn locked<T>(
        &self,
        user_id: &str,
        lot_id: &str,
        body: impl FnOnce(&mut postgres::Transaction<'_>) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        let mut conn = self.pool.get()?;
        let mut tx = conn.client()?.transaction().map_err(|e| db_failure(&e))?;
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key(user_id, lot_id)],
        )
        .map_err(|e| db_failure(&e))?;
        let out = body(&mut tx)?;
        tx.commit().map_err(|e| db_failure(&e))?;
        Ok(out)
    }
}

impl BasisStore for PgBasisStore {
    fn list_active(&self, user_id: &str) -> Result<Vec<ActiveBasis>, Failure> {
        let mut conn = self.pool.get()?;
        let rows = conn
            .client()?
            .query(
                &format!(
                    "SELECT DISTINCT ON (lot_id) {SELECT_COLUMNS} FROM tax.basis_overrides WHERE user_id = $1 \
                     ORDER BY lot_id, version DESC"
                ),
                &[&user_id],
            )
            .map_err(|e| db_failure(&e))?;
        let mut active = Vec::new();
        for row in &rows {
            if let Some(item) = active_of(&to_row(row)?) {
                active.push(item);
            }
        }
        active.sort_by(|a, b| locale_compare(&a.lot_id, &b.lot_id));
        Ok(active)
    }

    fn save(&self, w: &BasisWrite) -> Result<BasisRow, Failure> {
        self.locked(&w.user_id, &w.lot_id, |tx| {
            let prev = latest(tx, &w.user_id, &w.lot_id)?;
            if let Some(p) = prev.as_ref().filter(|p| same_write(p, w)) {
                return Ok(p.clone());
            }
            let version = prev.map_or(0, |p| p.version) + 1;
            let row = BasisRow {
                user_id: w.user_id.clone(),
                lot_id: w.lot_id.clone(),
                version,
                kind: write_kind(w),
                price_per_unit: Some(w.price_per_unit.clone()),
                acquired_at: Some(w.acquired_at.clone()),
                source_note: Some(w.source_note.clone()),
                asset_id: w.asset_id.clone(),
                qty: w.qty.clone(),
                business_key: business_key(&w.user_id, &w.lot_id, version),
            };
            insert(tx, &row)?;
            Ok(row)
        })
    }

    fn clear(&self, user_id: &str, lot_id: &str) -> Result<BasisRow, Failure> {
        self.locked(user_id, lot_id, |tx| {
            let Some(prev) = latest(tx, user_id, lot_id)? else {
                return Err(refused(
                    TAX_BASIS_OVERRIDE_ABSENT,
                    "no customer basis is stored for that lot",
                ));
            };
            if prev.kind == BasisKind::Tombstone {
                return Ok(prev);
            }
            let version = prev.version + 1;
            let row = BasisRow {
                user_id: user_id.to_owned(),
                lot_id: lot_id.to_owned(),
                version,
                kind: BasisKind::Tombstone,
                price_per_unit: None,
                acquired_at: None,
                source_note: None,
                asset_id: None,
                qty: None,
                business_key: business_key(user_id, lot_id, version),
            };
            insert(tx, &row)?;
            Ok(row)
        })
    }
}
