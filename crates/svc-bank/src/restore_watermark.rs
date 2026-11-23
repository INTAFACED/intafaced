//! The bank's `restore.watermark.read` (`services/svc-bank/src/restore-watermark.ts`, OPS-ledger-desk-05), the answer
//! of `POST /internal/restore/watermark` for svc-ops. This service keeps no single write sequence, so the position is
//! the exact row count over every table in the `bank` schema, and `integrity` is a digest of the per-table counts. A
//! restored area holds the same rows or it does not; the read changes nothing and takes no lock. `lastWriteAt` is the
//! newest `created_at` / `updated_at` in any of those tables.

use sha2::{Digest, Sha256};

use service_kit::json::Json;
use service_kit::time::{Instant, time_clip};

use crate::db::{Store, StoreError, with_client};

/// `BANK_SCHEMA`.
pub const BANK_SCHEMA: &str = "bank";

/// `digestCounts`: the sha-256, in hex, of `table=rows` lines sorted by table and joined by a newline.
pub fn digest_counts(counts: &[(String, u64)]) -> String {
    let mut sorted: Vec<&(String, u64)> = counts.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let lines: Vec<String> = sorted.iter().map(|(t, n)| format!("{t}={n}")).collect();
    Sha256::digest(lines.join("\n").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The newest stamp, as `new Date(Math.max(...times)).toISOString()` reads the epoch seconds Postgres printed; `None`
/// when no table has a stamped row.
#[expect(
    clippy::float_arithmetic,
    reason = "`Number(m) * 1000` in a double, so the millisecond is the one the TypeScript reads"
)]
pub fn last_write_at(epochs: &[Option<String>]) -> Option<String> {
    epochs
        .iter()
        .flatten()
        .filter_map(|m| m.trim().parse::<f64>().ok())
        .map(|s| s * 1000.0)
        .filter(|n| n.is_finite())
        .reduce(f64::max)
        .and_then(time_clip)
        .map(|ms| Instant(ms).iso())
}

/// `readBankWatermark(sql, now, schema)`.
pub fn read(store: &Store, now: Instant, schema: &str) -> Result<Json, StoreError> {
    let pool = store.pool()?;
    let (counts, stamped) = with_client(pool, |c| {
        let counts = c.query(
            "SELECT c.relname::text AS t,
                    (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS n
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1::text AND c.relkind = 'r'
              ORDER BY c.relname",
            &[&schema],
        )?;
        let stamped = c.query(
            "SELECT (xpath('/row/m/text()', query_to_xml(format('SELECT extract(epoch FROM max(%I)) AS m FROM %I.%I', k.column_name, k.table_schema, k.table_name), false, true, '')))[1]::text AS m
               FROM information_schema.columns k
               JOIN information_schema.tables t ON t.table_schema = k.table_schema AND t.table_name = k.table_name AND t.table_type = 'BASE TABLE'
              WHERE k.table_schema = $1::text AND k.column_name IN ('created_at', 'updated_at')",
            &[&schema],
        )?;
        Ok((counts, stamped))
    })?;
    let mut rows = Vec::with_capacity(counts.len());
    for r in &counts {
        let table: String = r.try_get(0)?;
        let n: Option<String> = r.try_get(1)?;
        let n = n
            .as_deref()
            .and_then(|n| n.parse::<u64>().ok())
            .ok_or_else(|| StoreError::new(format!("{table}: the row count did not read"), None))?;
        rows.push((table, n));
    }
    let epochs = stamped
        .iter()
        .map(|r| r.try_get::<_, Option<String>>(0))
        .collect::<Result<Vec<_>, _>>()?;
    let position: u128 = rows.iter().map(|(_, n)| u128::from(*n)).sum();
    Ok(Json::obj([
        ("service", Json::str("bank")),
        ("kind", Json::str("bank.rows")),
        ("position", Json::str(position.to_string())),
        ("integrity", Json::str(digest_counts(&rows))),
        (
            "lastWriteAt",
            last_write_at(&epochs).map_or(Json::Null, Json::String),
        ),
        ("readAt", Json::str(now.iso())),
    ]))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn the_digest_sorts_by_table_before_it_hashes() {
        let a = digest_counts(&[("spaces".to_owned(), 2), ("cards".to_owned(), 0)]);
        let b = digest_counts(&[("cards".to_owned(), 0), ("spaces".to_owned(), 2)]);
        assert_eq!(a, b);
        // sha256("cards=0\nspaces=2"), as node's createHash prints it.
        assert_eq!(
            a,
            "9aaa85b31178f1180ab8011aa3b3886a42fee9e8957e2599626e6f51f13f5d4d"
        );
        // An empty schema hashes the empty string.
        assert_eq!(
            digest_counts(&[]),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn the_newest_stamp_is_read_to_the_millisecond_and_infinity_is_dropped() {
        assert_eq!(last_write_at(&[None, None]), None);
        assert_eq!(
            last_write_at(&[
                Some("1763800000.1234567".to_owned()),
                None,
                Some("Infinity".to_owned()),
                Some("1700000000".to_owned()),
            ]),
            Some("2025-11-22T08:26:40.123Z".to_owned())
        );
    }
}
