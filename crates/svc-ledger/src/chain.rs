//! The chain's hash (`hashTx`, `packages/ledger-client/src/memory-ledger.ts`): sha256 over the previous hash, one space,
//! and the transaction's canonical JSON (`id`, `module`, `reason`, `postedAt`, then each entry's `accountId`, `assetId`,
//! `direction` and `amount`, in that order; amounts in `formatAmount`'s form). Reconciliation recomputes it for every
//! stored row. The fields a row may also carry (`assetHashes`, `previousAssetHashes`, `crossShardAnchor`) are the
//! `posting` slice's; a row without them keeps this digest.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

/// `8.64e15`: the largest distance from the epoch a JavaScript `Date` holds, in milliseconds.
const DATE_LIMIT_MS: i64 = 8_640_000_000_000_000;

/// One entry as the hash reads it.
pub struct HashEntry<'a> {
    pub account_id: &'a str,
    pub asset_id: &'a str,
    pub direction: &'a str,
    pub amount: Amount,
}

/// One transaction as the hash reads it. `posted_at_ms` is the instant as `new Date(column)` reads it: cut to the
/// millisecond.
pub struct HashTx<'a> {
    pub id: &'a str,
    pub module: &'a str,
    pub reason: &'a str,
    pub posted_at_ms: i64,
    pub entries: &'a [HashEntry<'a>],
}

/// `hashTx(tx, previousHash)`. `None` where `toISOString` throws: an instant no JavaScript `Date` holds.
pub fn hash_tx(tx: &HashTx<'_>, previous: Option<&str>) -> Option<String> {
    if !(-DATE_LIMIT_MS..=DATE_LIMIT_MS).contains(&tx.posted_at_ms) {
        return None;
    }
    let entries = tx
        .entries
        .iter()
        .map(|e| {
            Json::obj([
                ("accountId", Json::str(e.account_id)),
                ("assetId", Json::str(e.asset_id)),
                ("direction", Json::str(e.direction)),
                ("amount", Json::str(format_amount(e.amount))),
            ])
        })
        .collect();
    let body = Json::obj([
        ("id", Json::str(tx.id)),
        ("module", Json::str(tx.module)),
        ("reason", Json::str(tx.reason)),
        ("postedAt", Json::str(Instant(tx.posted_at_ms).iso())),
        ("entries", Json::Array(entries)),
    ]);
    let mut h = Sha256::new();
    h.update(previous.unwrap_or("").as_bytes());
    // Space, not NUL: every stored `ledger_tx.hash` was written with this byte.
    h.update(b" ");
    h.update(body.compact().as_bytes());
    Some(
        h.finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    // The digests `hashTx` gives for these two transactions (node, `@intafaced/ledger-client`).
    #[test]
    fn the_digest_is_the_typescripts() {
        let entries = [
            HashEntry {
                account_id: "a0000000-0000-4000-8000-000000000001",
                asset_id: "USDT",
                direction: "debit",
                amount: 10_000_000_000_000_000_000,
            },
            HashEntry {
                account_id: "a0000000-0000-4000-8000-000000000002",
                asset_id: "USDT",
                direction: "credit",
                amount: 10_000_000_000_000_000_000,
            },
        ];
        let first = HashTx {
            id: "70000000-0000-4000-8000-000000000001",
            module: "ledger",
            reason: "deposit \"quoted\"\n",
            posted_at_ms: 1_795_000_000_123,
            entries: &entries,
        };
        let one = hash_tx(&first, None).unwrap();
        assert_eq!(
            one,
            "4f52510a9b1f1720b6df37043b284a9b3ed70cbf533bcde3ea2a13aec8dab173"
        );
        let second = HashTx {
            id: "70000000-0000-4000-8000-000000000002",
            posted_at_ms: 1_795_000_000_999,
            ..first
        };
        assert_eq!(
            hash_tx(&second, Some(&one)).unwrap(),
            "30e9080f12c388ab8c77168a3cf93fbdb6511fe73809f5047070bc86695f8938"
        );
    }

    #[test]
    fn an_instant_no_date_holds_has_no_digest() {
        let tx = HashTx {
            id: "x",
            module: "m",
            reason: "r",
            posted_at_ms: DATE_LIMIT_MS + 1,
            entries: &[],
        };
        assert_eq!(hash_tx(&tx, None), None);
    }
}
