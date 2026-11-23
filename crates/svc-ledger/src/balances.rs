//! The `balances` slice: the reads `s2s-http.ts` serves on `balance`, `balances`, `portfolio`, `txByKey` and `txById`,
//! over `PostgresLedger`'s `balance`, `balances`, `getTxByKey` and `getTx` (`ledger/postgres-ledger.ts`). None of them
//! writes: an account nobody has touched reads as zero without a row being made, and a key or id nobody booked answers
//! `found: false`.
//!
//! A booked transaction is answered only when its immutable claim (`ledger_posted_keys`) still matches it: key, hash
//! and meta. Anything else is `ledger.posted_claim_mismatch`, a 500, never the row as it now reads.
//!
//! `portfolio` joins the owner's book to the indexer's chain positions for a 0x account (`@intafaced/portfolio-view`):
//! the chain half is present only when `INDEXER_URL` is a usable http(s) URL, the account is given and the indexer's
//! reply has the record's shape (`INDEXER_POSITIONS`). Anything else is named absent, never a zero.

use postgres::GenericClient;
use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::schema::Value;

use crate::db::{Store, with_client};
use crate::errors::{self, Failure};

/// `LedgerError('Posted transaction differs from its immutable idempotency claim', ...)`.
pub const POSTED_CLAIM_MISMATCH: &str = "ledger.posted_claim_mismatch";
/// `PORTFOLIO_INDEXER_UNWIRED`: the chain half the platform cannot read.
pub const PORTFOLIO_INDEXER_UNWIRED: &str = "indexer.portfolio_positions_unwired";
/// `resolveIndexerHalf`'s default `timeoutMs`.
pub const INDEXER_TIMEOUT_MS: u64 = 3_000;

/// What the slice's doors reach past their input check: the book, and the indexer for `portfolio`.
pub struct Reads<'a> {
    pub store: &'a Store,
    /// `process.env.INDEXER_URL`, as the process started with it.
    pub indexer_url: Option<&'a str>,
    pub fetch: &'a dyn Fetch,
}

/// A driver or SQL error is not a `LedgerError`: `httpError`'s last line, `Ledger request failed`.
fn fault<E>(_: E) -> Failure {
    Failure::Fault
}

/// `parseStoredAmount(value, field)`: a numeric column read as its text. A value that does not parse is `MoneyError`,
/// a plain error.
fn stored(text: &str) -> Result<Amount, Failure> {
    parse_amount(text).map_err(|_| Failure::Fault)
}

/// The field `key` of the parsed input, when it is a string.
fn text<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    match input {
        Value::Object(fields) => fields
            .iter()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| match v {
                Value::String(s) => Some(s.as_str()),
                _ => None,
            }),
        _ => None,
    }
}

fn required<'v>(input: &'v Value, key: &str) -> Result<&'v str, Failure> {
    text(input, key).ok_or(Failure::Fault)
}

/// One account the owner holds (`Balance`), as `balances` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub account_id: String,
    pub asset_id: String,
    pub kind: String,
    pub purpose: String,
    pub amount: Amount,
}

/// `PostgresLedger.balance(ref)`: the account's id and balance, or `''` and zero for one never touched.
pub fn balance(
    c: &mut impl GenericClient,
    owner_type: &str,
    owner_id: &str,
    asset_id: &str,
    kind: &str,
    purpose: &str,
) -> Result<(String, Amount), Failure> {
    let rows = c
        .query(
            "SELECT id::text, balance::text FROM accounts
              WHERE owner_type = $1::text::owner_type
                AND owner_id   = $2
                AND asset_id   = $3
                AND kind       = $4::text::account_kind
                AND purpose    = $5",
            &[&owner_type, &owner_id, &asset_id, &kind, &purpose],
        )
        .map_err(fault)?;
    match rows.first() {
        None => Ok((String::new(), Amount::ZERO)),
        Some(row) => {
            let id: String = row.try_get(0).map_err(fault)?;
            let amount: String = row.try_get(1).map_err(fault)?;
            Ok((id, stored(&amount)?))
        }
    }
}

/// `PostgresLedger.balances(ownerType, ownerId)`: every account the owner has, by asset, kind and purpose.
pub fn balances(
    c: &mut impl GenericClient,
    owner_type: &str,
    owner_id: &str,
) -> Result<Vec<Holding>, Failure> {
    let rows = c
        .query(
            "SELECT id::text, asset_id, kind::text, purpose, balance::text
               FROM accounts
              WHERE owner_type = $1::text::owner_type AND owner_id = $2
              ORDER BY asset_id, kind, purpose",
            &[&owner_type, &owner_id],
        )
        .map_err(fault)?;
    rows.iter()
        .map(|row| {
            let get = |i: usize| -> Result<String, Failure> {
                row.try_get::<_, String>(i).map_err(fault)
            };
            Ok(Holding {
                account_id: get(0)?,
                asset_id: get(1)?,
                kind: get(2)?,
                purpose: get(3)?,
                amount: stored(&get(4)?)?,
            })
        })
        .collect()
}

/// One booked entry (`PostedEntry`), as `hydrate` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// `ledger_entries.id` as text.
    pub id: String,
    pub account_id: String,
    pub asset_id: String,
    pub direction: String,
    pub amount: Amount,
    pub balance_after: Amount,
}

/// One booked transaction (`LedgerTx`), the fields the doors answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tx {
    pub id: String,
    pub idempotency_key: String,
    pub module: String,
    pub reason: String,
    pub hash: String,
    /// `postedAt.toISOString()`.
    pub posted_at: String,
    pub previous_hash: Option<String>,
    pub entries: Vec<Entry>,
}

/// The transaction's columns and whether its claim still matches it (`ClaimRow`).
const TX_COLUMNS: &str = "t.id::text, t.idempotency_key, t.module, t.reason, t.hash,
       to_char(t.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), t.previous_hash,
       (k.idempotency_key IS NOT DISTINCT FROM t.idempotency_key
        AND k.posted_hash IS NOT DISTINCT FROM t.hash
        AND k.posted_meta IS NOT DISTINCT FROM t.meta) AS claim_matches";

/// `assertPostedClaim(rows)`, then `hydrate`: exactly one row whose claim matches, with its entries in id order.
fn claimed(c: &mut impl GenericClient, rows: &[postgres::Row]) -> Result<Option<Tx>, Failure> {
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let matches: Option<bool> = row.try_get(7).map_err(fault)?;
    if rows.len() != 1 || matches != Some(true) {
        return Err(Failure::ledger(
            POSTED_CLAIM_MISMATCH,
            "Posted transaction differs from its immutable idempotency claim",
        ));
    }
    let get = |i: usize| -> Result<String, Failure> { row.try_get::<_, String>(i).map_err(fault) };
    let id = get(0)?;
    let entries = c
        .query(
            "SELECT account_id::text, asset_id, direction::text, amount::text, balance_after::text, id::text
               FROM ledger_entries WHERE tx_id = $1::text::uuid ORDER BY id ASC",
            &[&id],
        )
        .map_err(fault)?
        .iter()
        .map(|e| {
            let get =
                |i: usize| -> Result<String, Failure> { e.try_get::<_, String>(i).map_err(fault) };
            // `hydrate` parses `balance_after` too; a malformed one fails the read.
            Ok(Entry {
                id: get(5)?,
                balance_after: stored(&get(4)?)?,
                account_id: get(0)?,
                asset_id: get(1)?,
                direction: get(2)?,
                amount: stored(&get(3)?)?,
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    Ok(Some(Tx {
        idempotency_key: get(1)?,
        module: get(2)?,
        reason: get(3)?,
        hash: get(4)?,
        posted_at: get(5)?,
        previous_hash: row.try_get(6).map_err(fault)?,
        id,
        entries,
    }))
}

/// `PostgresLedger.getTx(txId)`.
pub fn tx_by_id(c: &mut impl GenericClient, tx_id: &str) -> Result<Option<Tx>, Failure> {
    let rows = c
        .query(
            &format!(
                "SELECT {TX_COLUMNS}
                   FROM ledger_tx t LEFT JOIN ledger_posted_keys k ON k.tx_id = t.id
                  WHERE t.id = $1::text::uuid"
            ),
            &[&tx_id],
        )
        .map_err(fault)?;
    claimed(c, &rows)
}

/// `PostgresLedger.getTxByKey(key)`: the key's claim or its journal row, read in one statement so a concurrent commit
/// cannot fall between two probes.
pub fn tx_by_key(c: &mut impl GenericClient, key: &str) -> Result<Option<Tx>, Failure> {
    let rows = c
        .query(
            &format!(
                "WITH target AS (
                   SELECT tx_id AS id FROM ledger_posted_keys WHERE idempotency_key = $1
                   UNION
                   SELECT id FROM ledger_tx WHERE idempotency_key = $1
                 )
                 SELECT {TX_COLUMNS}
                   FROM target JOIN ledger_tx t ON t.id = target.id
                   LEFT JOIN ledger_posted_keys k ON k.tx_id = t.id"
            ),
            &[&key],
        )
        .map_err(fault)?;
    claimed(c, &rows)
}

fn holding_json(h: &Holding) -> Json {
    Json::obj([
        ("accountId", Json::str(h.account_id.clone())),
        ("assetId", Json::str(h.asset_id.clone())),
        ("kind", Json::str(h.kind.clone())),
        ("purpose", Json::str(h.purpose.clone())),
        ("amount", Json::str(format_amount(h.amount))),
    ])
}

/// `indexerUrlOf(raw)`: trimmed, http or https, trailing slashes cut; anything else is unwired.
pub fn indexer_url_of(raw: Option<&str>) -> Option<String> {
    let trimmed = js_trim(raw?);
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(trimmed.trim_end_matches('/').to_owned())
}

/// `encodeURIComponent`.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `unwrapTrpcData(body)`: tRPC's `result.data`, and its `json` when the transformer wrapped it.
fn unwrap_trpc_data(body: &Json) -> &Json {
    let Json::Object(_) = body else {
        return body;
    };
    let data = match body.get("result").and_then(|r| r.get("data")) {
        None | Some(Json::Null) => body,
        Some(d) => d,
    };
    match data {
        Json::Object(fields) => fields
            .iter()
            .find(|(k, _)| k == "json")
            .map_or(data, |(_, v)| v),
        _ => data,
    }
}

/// `isDecimalString`: a string `parseAmount` accepts.
fn decimal(v: Option<&Json>) -> Option<&str> {
    match v {
        Some(Json::String(s)) if parse_amount(s).is_ok() => Some(s),
        _ => None,
    }
}

/// `z.number().int()`: a finite whole number within the safe range.
fn whole(v: Option<&Json>) -> bool {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    matches!(v, Some(Json::Number(n)) if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE)
}

/// `trpcRecordReply(INDEXER_POSITIONS, body)`, then `positionsFromWire`: each position as `{ market, size, entryPrice }`,
/// or `None` when any part is not the record's shape.
fn positions(body: &Json) -> Option<Vec<Json>> {
    let Json::Array(rows) = unwrap_trpc_data(body) else {
        return None;
    };
    rows.iter()
        .map(|row| {
            let Json::Object(_) = row else { return None };
            let s = |k: &str| match row.get(k) {
                Some(Json::String(s)) => Some(s.as_str()),
                _ => None,
            };
            // The record's output: every field of `positionSchema` is there and of its type.
            let (market, _account, size, entry_price, _block_hash) = (
                s("market")?,
                s("account")?,
                s("size")?,
                s("entryPrice")?,
                s("blockHash")?,
            );
            if !whole(row.get("blockHeight")) {
                return None;
            }
            // `positionsFromWire`: a market of 1 to 64 characters and decimal sizes and prices.
            let len = market.encode_utf16().count();
            if len == 0 || len > 64 {
                return None;
            }
            decimal(row.get("size"))?;
            decimal(row.get("entryPrice"))?;
            Some(Json::obj([
                ("market", Json::str(market)),
                ("size", Json::str(size)),
                ("entryPrice", Json::str(entry_price)),
            ]))
        })
        .collect()
}

fn indexer_absent() -> Json {
    Json::obj([
        ("status", Json::str("absent")),
        ("reason", Json::str(PORTFOLIO_INDEXER_UNWIRED)),
    ])
}

/// `resolveIndexerHalf({ url, chainAccount, fetch })`.
pub fn indexer_half(url: Option<&str>, chain_account: Option<&str>, fetch: &dyn Fetch) -> Json {
    let (Some(url), Some(account)) = (indexer_url_of(url), chain_account) else {
        return indexer_absent();
    };
    let input = Json::obj([("account", Json::str(account))]).compact();
    let req = HttpRequest {
        method: "GET".to_owned(),
        url: format!("{url}/trpc/positions?input={}", encode_component(&input)),
        headers: vec![("accept".to_owned(), "application/json".to_owned())],
        body: None,
        timeout_ms: Some(INDEXER_TIMEOUT_MS),
        refuse_redirect: false,
    };
    let Ok(res) = fetch.fetch(&req) else {
        return indexer_absent();
    };
    if !res.ok() {
        return indexer_absent();
    }
    let Ok(body) = json::parse(&res.body) else {
        return indexer_absent();
    };
    match positions(&body) {
        Some(list) => Json::obj([
            ("status", Json::str("present")),
            ("positions", Json::Array(list)),
        ]),
        None => indexer_absent(),
    }
}

fn tx_found(tx: &Tx, with_entries: bool) -> Json {
    let mut fields = vec![
        ("found".to_owned(), Json::Bool(true)),
        ("txId".to_owned(), Json::str(tx.id.clone())),
    ];
    if with_entries {
        fields.push((
            "idempotencyKey".to_owned(),
            Json::str(tx.idempotency_key.clone()),
        ));
    }
    fields.extend([
        ("hash".to_owned(), Json::str(tx.hash.clone())),
        ("postedAt".to_owned(), Json::str(tx.posted_at.clone())),
        ("module".to_owned(), Json::str(tx.module.clone())),
        ("reason".to_owned(), Json::str(tx.reason.clone())),
    ]);
    if with_entries {
        let entries = tx
            .entries
            .iter()
            .map(|e| {
                Json::obj([
                    ("accountId", Json::str(e.account_id.clone())),
                    ("assetId", Json::str(e.asset_id.clone())),
                    ("direction", Json::str(e.direction.clone())),
                    ("amount", Json::str(format_amount(e.amount))),
                ])
            })
            .collect();
        fields.push(("entries".to_owned(), Json::Array(entries)));
    }
    Json::Object(fields)
}

fn not_found() -> Json {
    Json::obj([("found", Json::Bool(false))])
}

/// The answer of door `door` (`balance`, `balances`, `portfolio`, `txByKey` or `txById`) to its parsed input.
pub fn answer(reads: &Reads<'_>, door: &str, input: &Value) -> Result<Json, Failure> {
    let pool = reads.store.pool().map_err(fault)?;
    let read = |f: &mut dyn FnMut(&mut postgres::Client) -> Result<Json, Failure>| {
        let mut out = Err(Failure::Fault);
        with_client(pool, |c| {
            out = f(c);
            Ok(())
        })
        .map_err(fault)?;
        out
    };
    match door {
        "balance" => {
            let (owner_type, owner_id, asset_id, kind) = (
                required(input, "ownerType")?,
                required(input, "ownerId")?,
                required(input, "assetId")?,
                required(input, "kind")?,
            );
            // Purpose is account identity: the canonical trim, never the request's padding.
            let purpose = js_trim(text(input, "purpose").unwrap_or(""));
            read(&mut |c| {
                let (id, amount) = balance(c, owner_type, owner_id, asset_id, kind, purpose)?;
                Ok(Json::obj([
                    ("accountId", Json::str(id)),
                    ("assetId", Json::str(asset_id)),
                    ("kind", Json::str(kind)),
                    ("purpose", Json::str(purpose)),
                    ("amount", Json::str(format_amount(amount))),
                ]))
            })
        }
        "balances" => {
            let (owner_type, owner_id) =
                (required(input, "ownerType")?, required(input, "ownerId")?);
            read(&mut |c| {
                Ok(Json::Array(
                    balances(c, owner_type, owner_id)?
                        .iter()
                        .map(holding_json)
                        .collect(),
                ))
            })
        }
        "portfolio" => {
            let (owner_type, owner_id) =
                (required(input, "ownerType")?, required(input, "ownerId")?);
            // The book first: a failed read is a 500 before the indexer is asked anything.
            let held = read(&mut |c| {
                Ok(Json::Array(
                    balances(c, owner_type, owner_id)?
                        .iter()
                        .map(holding_json)
                        .collect(),
                ))
            })?;
            let indexer = indexer_half(reads.indexer_url, text(input, "chainAccount"), reads.fetch);
            Ok(Json::obj([
                ("ownerType", Json::str(owner_type)),
                ("ownerId", Json::str(owner_id)),
                ("custodial", held),
                ("indexer", indexer),
            ]))
        }
        "txByKey" => {
            let key = required(input, "idempotencyKey")?;
            read(&mut |c| Ok(tx_by_key(c, key)?.map_or_else(not_found, |tx| tx_found(&tx, false))))
        }
        "txById" => {
            let id = required(input, "txId")?;
            read(&mut |c| Ok(tx_by_id(c, id)?.map_or_else(not_found, |tx| tx_found(&tx, true))))
        }
        _ => Err(Failure::Fault),
    }
}

/// The door's answer: 200 and the read, or the failure as `httpError` answers it.
pub fn respond(reads: &Reads<'_>, door: &str, input: &Value) -> (u16, Json) {
    match answer(reads, door, input) {
        Ok(body) => (200, body),
        Err(f) => errors::http_error(&f),
    }
}
