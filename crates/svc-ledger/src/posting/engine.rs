//! THE LEDGER, on Postgres: `PostgresLedger.post` (`services/svc-ledger/src/ledger/postgres-ledger.ts`) and the reads
//! the posting slice needs (`getTxByKey`, `balance`, the outbox).
//!
//! Every post takes `FOR UPDATE` on the singleton chain-tip row before it reads anything it will write. That lock, not
//! the isolation level, totally orders posts, makes the hash chain a chain, and makes concurrent spends impossible to
//! interleave into an overdraft; READ COMMITTED is therefore enough, and a serialization failure or deadlock is retried
//! (`transaction(..., { maxAttempts: 10 })`). The freeze and the clock-skew bound are read under that same lock, after
//! the key: a retry of a post that already committed gets the original back even while frozen.

use postgres::{GenericClient, IsolationLevel};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use crate::chain::{self, HashEntry, HashTx};
use crate::db::{StoreError, transaction};
use crate::errors::{self, Failure};
use crate::posting::PostError;
use crate::posting::rules::{
    self, AccountRef, Direction, PostRequest, Wide, assert_balanced, assert_idempotency_key,
    assert_valid_post, post_fingerprint, replay_meta_differs,
};

/// `LEDGER_IDEMPOTENCY_CONFLICT_MODE`, as the environment resolved it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    /// A different body under a booked key is refused, 409.
    Refuse,
    /// It is answered with the original, and reported.
    Detect,
}

/// What the engine is built with (`PostgresLedgerOptions`).
#[derive(Debug, Clone, Copy)]
pub struct EngineOptions {
    pub conflict: Conflict,
    /// `LEDGER_CLOCK_SKEW_BOUND_MS`: none is unset, never 0.
    pub clock_skew_bound_ms: Option<i64>,
    /// The app clock, in milliseconds since the epoch.
    pub clock_ms: fn() -> i64,
}

/// One booked leg (`PostedEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostedEntry {
    pub id: String,
    pub tx_id: String,
    pub account_id: String,
    pub asset_id: String,
    pub direction: Direction,
    pub amount: Amount,
    pub balance_after: Amount,
}

/// A booked transaction (`LedgerTx`).
#[derive(Debug, Clone, PartialEq)]
pub struct Posted {
    pub id: String,
    pub idempotency_key: String,
    pub module: String,
    pub reason: String,
    pub meta: Json,
    pub posted_at_ms: i64,
    pub hash: String,
    pub previous_hash: Option<String>,
    pub entries: Vec<PostedEntry>,
}

impl Posted {
    /// `tx.meta[field]`.
    pub fn meta(&self, field: &str) -> Option<&Json> {
        self.meta.get(field)
    }
}

/// What a detect-mode mismatch reports (`IdempotencyMismatchInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub idempotency_key: String,
    pub module: String,
    pub reason: String,
}

fn ledger(code: &str, message: impl Into<String>) -> PostError {
    PostError::Refused(Failure::ledger(code, message))
}

/// `parseStoredAmount`: a stored numeric, read as text.
fn stored_amount(text: &str, field: &str) -> Result<Amount, PostError> {
    parse_amount(text).map_err(|e| {
        ledger(
            errors::INVALID_ENTRY,
            format!("{field} must be a decimal string: {e}"),
        )
    })
}

fn direction_of(text: &str) -> Result<Direction, PostError> {
    match text {
        "debit" => Ok(Direction::Debit),
        "credit" => Ok(Direction::Credit),
        other => Err(PostError::Store(StoreError::new(
            format!("ledger_entries.direction {other} is not a direction"),
            None,
        ))),
    }
}

const TX_COLUMNS: &str = "t.id::text, t.idempotency_key, t.module, t.reason, t.meta::text, \
     floor(extract(epoch FROM t.posted_at) * 1000)::bigint, t.hash, t.previous_hash";

/// `hydrate(row)`: the transaction and its entries, in entry order.
fn hydrate(c: &mut impl GenericClient, row: &postgres::Row) -> Result<Posted, PostError> {
    let id: String = row.try_get(0).map_err(StoreError::from)?;
    let meta: Option<String> = row.try_get(4).map_err(StoreError::from)?;
    let meta = match meta {
        Some(text) => json::parse(&text).map_err(|e| {
            PostError::Store(StoreError::new(
                format!("ledger_tx.meta: {}", e.message),
                None,
            ))
        })?,
        None => Json::Object(Vec::new()),
    };
    let rows = c
        .query(
            "SELECT id::text, tx_id::text, account_id::text, asset_id, direction::text, amount::text, \
                    balance_after::text
               FROM ledger.ledger_entries WHERE tx_id = $1::text::uuid ORDER BY id ASC",
            &[&id],
        )
        .map_err(StoreError::from)?;
    let mut entries = Vec::with_capacity(rows.len());
    for r in &rows {
        let text = |i: usize| -> Result<String, PostError> {
            Ok(r.try_get::<_, String>(i).map_err(StoreError::from)?)
        };
        entries.push(PostedEntry {
            id: text(0)?,
            tx_id: text(1)?,
            account_id: text(2)?,
            asset_id: text(3)?,
            direction: direction_of(&text(4)?)?,
            amount: stored_amount(&text(5)?, "ledger_entries.amount")?,
            balance_after: stored_amount(&text(6)?, "ledger_entries.balance_after")?,
        });
    }
    Ok(Posted {
        id,
        idempotency_key: row.try_get(1).map_err(StoreError::from)?,
        module: row.try_get(2).map_err(StoreError::from)?,
        reason: row.try_get(3).map_err(StoreError::from)?,
        meta,
        posted_at_ms: row.try_get(5).map_err(StoreError::from)?,
        hash: row.try_get(6).map_err(StoreError::from)?,
        previous_hash: row.try_get(7).map_err(StoreError::from)?,
        entries,
    })
}

/// `loadClaimedTxByKey`: the transaction a key booked and the body digest its claim stored, read in one statement so a
/// concurrent commit cannot fall between the claim and the journal. A journal row that differs from its immutable claim
/// is refused (`ledger.posted_claim_mismatch`).
pub fn claimed_by_key(
    c: &mut impl GenericClient,
    key: &str,
) -> Result<Option<(Posted, Option<String>)>, PostError> {
    let rows = c
        .query(
            &format!(
                "WITH target AS (
                   SELECT tx_id AS id FROM ledger.ledger_posted_keys WHERE idempotency_key = $1
                   UNION
                   SELECT id FROM ledger.ledger_tx WHERE idempotency_key = $1
                 )
                 SELECT {TX_COLUMNS},
                        (k.idempotency_key IS NOT DISTINCT FROM t.idempotency_key
                         AND k.posted_hash IS NOT DISTINCT FROM t.hash
                         AND k.posted_meta IS NOT DISTINCT FROM t.meta) AS claim_matches,
                        k.request_fingerprint
                   FROM target JOIN ledger.ledger_tx t ON t.id = target.id
                   LEFT JOIN ledger.ledger_posted_keys k ON k.tx_id = t.id"
            ),
            &[&key],
        )
        .map_err(StoreError::from)?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let matches: Option<bool> = row.try_get(8).map_err(StoreError::from)?;
    if rows.len() != 1 || matches != Some(true) {
        return Err(ledger(
            "ledger.posted_claim_mismatch",
            "Posted transaction differs from its immutable idempotency claim",
        ));
    }
    let fingerprint: Option<String> = row.try_get(9).map_err(StoreError::from)?;
    Ok(Some((hydrate(c, row)?, fingerprint)))
}

/// `getTxByKey(key)`.
pub fn tx_by_key(c: &mut impl GenericClient, key: &str) -> Result<Option<Posted>, PostError> {
    Ok(claimed_by_key(c, key)?.map(|(tx, _)| tx))
}

/// `balance(ref).accountId`: the account's id, or none for an account never touched. Reading creates nothing.
pub fn account_id(c: &mut impl GenericClient, a: &AccountRef) -> Result<Option<String>, PostError> {
    let rows = c
        .query(
            "SELECT id::text FROM ledger.accounts
              WHERE owner_type = $1::text::ledger.owner_type AND owner_id = $2 AND asset_id = $3
                AND kind = $4::text::ledger.account_kind AND purpose = $5",
            &[
                &a.owner_type,
                &a.owner_id,
                &a.asset_id,
                &a.kind,
                &a.purpose(),
            ],
        )
        .map_err(StoreError::from)?;
    match rows.first() {
        Some(r) => Ok(Some(r.try_get(0).map_err(StoreError::from)?)),
        None => Ok(None),
    }
}

/// `replayOf`: a retry of the same body gets the original back; a different body under that key is refused, or in
/// detect mode answered with the original and reported. A claim with no stored digest (before 0021) compares nothing.
fn replay_of(
    claimed: (Posted, Option<String>),
    r: &PostRequest,
    conflict: Conflict,
    mismatches: &mut Vec<Mismatch>,
) -> Result<Posted, PostError> {
    let (tx, fingerprint) = claimed;
    let differs = fingerprint
        .is_some_and(|f| f != post_fingerprint(&r.module, &r.reason, &r.entries))
        || replay_meta_differs(&tx.meta, &r.module, &r.reason, r.meta.as_deref());
    if differs {
        if conflict == Conflict::Refuse {
            return Err(ledger(
                errors::IDEMPOTENCY_CONFLICT,
                format!(
                    "Idempotency key {} already booked a different movement; a retry must carry the same body",
                    r.idempotency_key
                ),
            ));
        }
        mismatches.push(Mismatch {
            idempotency_key: r.idempotency_key.clone(),
            module: r.module.clone(),
            reason: r.reason.clone(),
        });
    }
    Ok(tx)
}

/// `readDatabaseNow`: `clock_timestamp()`, in milliseconds.
fn database_now_ms(c: &mut impl GenericClient) -> Result<i64, PostError> {
    let row = c
        .query_one(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint",
            &[],
        )
        .map_err(StoreError::from)?;
    Ok(row.try_get(0).map_err(StoreError::from)?)
}

/// `refuseNewWriteOnClockSkew`: with a bound set, the app clock (at the read's midpoint) against the database's.
fn refuse_on_clock_skew(c: &mut impl GenericClient, o: &EngineOptions) -> Result<(), PostError> {
    let Some(bound) = o.clock_skew_bound_ms else {
        return Ok(());
    };
    let before = (o.clock_ms)();
    let db = database_now_ms(c)?;
    let after = (o.clock_ms)();
    let app = before + (after - before).div_euclid(2);
    if i128::from(app - db).abs() > i128::from(bound) {
        let code = errors::WRITE_BLOCKS[2];
        return Err(ledger(code, format!("ledger writes are blocked: {code}")));
    }
    Ok(())
}

/// The account's row, opened if new and locked either way (`upsertAccount`).
fn upsert_account(
    c: &mut impl GenericClient,
    a: &AccountRef,
) -> Result<(String, Amount), PostError> {
    let row = c
        .query_one(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, purpose)
             VALUES ($1::text::ledger.owner_type, $2, $3, $4::text::ledger.account_kind, $5)
             ON CONFLICT (owner_type, owner_id, asset_id, kind, purpose)
             DO UPDATE SET owner_id = EXCLUDED.owner_id
             RETURNING id::text, balance::text",
            &[
                &a.owner_type,
                &a.owner_id,
                &a.asset_id,
                &a.kind,
                &a.purpose(),
            ],
        )
        .map_err(StoreError::from)?;
    let id: String = row.try_get(0).map_err(StoreError::from)?;
    let balance: String = row.try_get(1).map_err(StoreError::from)?;
    Ok((id, stored_amount(&balance, "accounts.balance")?))
}

/// A value past `numeric(38,18)`: Postgres refuses the write that would store it.
fn overflow() -> PostError {
    PostError::Store(StoreError::new("numeric field overflow", Some("22003")))
}

fn fits(w: Wide) -> Result<Amount, PostError> {
    w.amount().ok_or_else(overflow)
}

/// The book's writes for a post no one has booked: everything after the tip lock and the two checks.
fn book(
    tx: &mut postgres::Transaction<'_>,
    r: &PostRequest,
    previous_hash: Option<String>,
    clock_ms: fn() -> i64,
) -> Result<Posted, PostError> {
    // Accounts in a deterministic order: the tip lock already prevents a deadlock, and the order keeps that true if
    // the tip lock is ever sharded away.
    let mut ordered: Vec<&AccountRef> = r.entries.iter().map(|e| &e.account).collect();
    ordered.sort_by_key(|a| a.key());
    let mut accounts: Vec<(String, String, Wide)> = Vec::new();
    for a in ordered {
        let key = a.key();
        if accounts.iter().any(|(k, _, _)| *k == key) {
            continue;
        }
        let (id, balance) = upsert_account(tx, a)?;
        accounts.push((key, id, Wide::of(balance)));
    }

    let tx_id = service_kit::approvals::random_uuid()
        .map_err(|e| PostError::Store(StoreError::new(e, None)))?;
    let posted_at_ms = clock_ms();
    let posted_at = Instant(posted_at_ms).iso();
    let mut legs: Vec<(String, Wide)> = Vec::with_capacity(r.entries.len());
    for e in &r.entries {
        let key = e.account.key();
        let Some((_, id, balance)) = accounts.iter_mut().find(|(k, _, _)| *k == key) else {
            return Err(overflow());
        };
        let next = balance.plus_amount(e.delta());
        if !e.account.balance_allowed(next) {
            return Err(PostError::Refused(Failure::InsufficientFunds {
                account_id: id.clone(),
                asset_id: e.account.asset_id.clone(),
                requested: format_amount(e.amount),
                available: e.account.held_for_refusal(*balance).format(),
            }));
        }
        *balance = next;
        legs.push((id.clone(), next));
    }

    let meta = rules::canonical_meta(r.meta.as_deref()).compact();
    let hash_entries: Vec<HashEntry<'_>> = r
        .entries
        .iter()
        .zip(&legs)
        .map(|(e, (id, _))| HashEntry {
            account_id: id,
            asset_id: &e.account.asset_id,
            direction: e.direction.as_str(),
            amount: e.amount,
        })
        .collect();
    // The clock's instant, which `Instant::iso` printed above, so the hash cannot refuse it.
    let hash = chain::hash_tx(
        &HashTx {
            id: &tx_id,
            module: &r.module,
            reason: &r.reason,
            posted_at_ms,
            entries: &hash_entries,
        },
        previous_hash.as_deref(),
    )
    .ok_or_else(|| {
        PostError::Store(StoreError::new(
            "the clock is past what a JavaScript Date holds",
            None,
        ))
    })?;

    let seq: String = tx
        .query_one(
            "INSERT INTO ledger.ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
             VALUES ($1::text::uuid, $2, $3, $4, $5::text::jsonb, $6::text::timestamptz, $7, $8)
             RETURNING seq::text",
            &[
                &tx_id,
                &r.idempotency_key,
                &r.module,
                &r.reason,
                &meta,
                &posted_at,
                &hash,
                &previous_hash,
            ],
        )
        .map_err(StoreError::from)?
        .try_get(0)
        .map_err(StoreError::from)?;
    tx.execute(
        "INSERT INTO ledger.ledger_posted_keys (idempotency_key, tx_id, posted_hash, posted_meta, request_fingerprint)
         VALUES ($1, $2::text::uuid, $3, $4::text::jsonb, $5)",
        &[
            &r.idempotency_key,
            &tx_id,
            &hash,
            &meta,
            &post_fingerprint(&r.module, &r.reason, &r.entries),
        ],
    )
    .map_err(StoreError::from)?;

    let mut entries = Vec::with_capacity(r.entries.len());
    for (e, (account_id, after)) in r.entries.iter().zip(&legs) {
        let after = fits(*after)?;
        let id: String = tx
            .query_one(
                "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::ledger.direction, $5::text::numeric,
                         $6::text::numeric)
                 RETURNING id::text",
                &[
                    &tx_id,
                    account_id,
                    &e.account.asset_id,
                    &e.direction.as_str(),
                    &format_amount(e.amount),
                    &format_amount(after),
                ],
            )
            .map_err(StoreError::from)?
            .try_get(0)
            .map_err(StoreError::from)?;
        entries.push(PostedEntry {
            id,
            tx_id: tx_id.clone(),
            account_id: account_id.clone(),
            asset_id: e.account.asset_id.clone(),
            direction: e.direction,
            amount: e.amount,
            balance_after: after,
        });
    }
    for (_, id, balance) in &accounts {
        tx.execute(
            "UPDATE ledger.accounts SET balance = $1::text::numeric WHERE id = $2::text::uuid",
            &[&format_amount(fits(*balance)?), id],
        )
        .map_err(StoreError::from)?;
    }
    tx.execute(
        "UPDATE ledger.chain_tip SET hash = $1, seq = $2::text::bigint, updated_at = now() WHERE id = true",
        &[&hash, &seq],
    )
    .map_err(StoreError::from)?;

    // Same transaction as the book: a crash after COMMIT still has a row to publish. Amounts are decimal strings.
    let payload = Json::obj([
        ("txId", Json::str(tx_id.clone())),
        ("module", Json::str(r.module.clone())),
        ("reason", Json::str(r.reason.clone())),
        ("hash", Json::str(hash.clone())),
        (
            "previousHash",
            previous_hash.clone().map_or(Json::Null, Json::String),
        ),
        (
            "entries",
            Json::Array(
                entries
                    .iter()
                    .map(|e| {
                        Json::obj([
                            ("accountId", Json::str(e.account_id.clone())),
                            ("assetId", Json::str(e.asset_id.clone())),
                            ("direction", Json::str(e.direction.as_str())),
                            ("amount", Json::str(format_amount(e.amount))),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("postedAt", Json::str(posted_at)),
    ])
    .compact();
    let correlation = r.correlation_id.clone().unwrap_or_else(|| tx_id.clone());
    tx.execute(
        "INSERT INTO ledger.ledger_tx_outbox (tx_id, payload, correlation_id)
         VALUES ($1::text::uuid, $2::text::jsonb, $3)",
        &[&tx_id, &payload, &correlation],
    )
    .map_err(StoreError::from)?;

    Ok(Posted {
        id: tx_id,
        idempotency_key: r.idempotency_key.clone(),
        module: r.module.clone(),
        reason: r.reason.clone(),
        meta: json::parse(&meta).unwrap_or(Json::Object(Vec::new())),
        posted_at_ms,
        hash,
        previous_hash,
        entries,
    })
}

/// `isSerializationFailure`: `serialization_failure` or `deadlock_detected`.
fn retryable(e: &PostError) -> bool {
    matches!(e, PostError::Store(s) if matches!(s.code.as_deref(), Some("40001" | "40P01")))
}

/// Full-jitter backoff before attempt `attempt + 1`: up to `2^attempt * 5` ms.
fn backoff(attempt: u32) {
    let mut b = [0u8; 2];
    let r = getrandom::fill(&mut b).map_or(0, |()| u64::from(u16::from_le_bytes(b)));
    let ceiling = (1u64 << attempt) * 5;
    std::thread::sleep(std::time::Duration::from_millis(r % ceiling.max(1)));
}

/// `PostgresLedger.post(request)`: the key, then idempotency, then the body (STOP §4.2b #4), then one transaction
/// behind the tip lock. Detect-mode mismatches are pushed to `mismatches`.
pub fn post(
    pool: &service_kit::pg::Pool,
    r: &PostRequest,
    o: &EngineOptions,
    mismatches: &mut Vec<Mismatch>,
) -> Result<Posted, PostError> {
    assert_idempotency_key(&r.idempotency_key)?;
    // A retry that already committed needs no lock at all; clock skew is not consulted, the value already moved.
    let existing =
        crate::db::with_client(pool, |c| match claimed_by_key(c, &r.idempotency_key) {
            Ok(v) => Ok(Ok(v)),
            Err(PostError::Store(s)) => Err(s),
            Err(refused) => Ok(Err(refused)),
        })??;
    if let Some(claimed) = existing {
        return replay_of(claimed, r, o.conflict, mismatches);
    }
    assert_valid_post(r)?;

    const MAX_ATTEMPTS: u32 = 10;
    let mut attempt = 1;
    loop {
        let mut found = Vec::new();
        let out = attempt_post(pool, r, o, &mut found);
        match out {
            Err(e) if retryable(&e) && attempt < MAX_ATTEMPTS => {
                backoff(attempt);
                attempt += 1;
            }
            out => {
                mismatches.extend(found);
                return out;
            }
        }
    }
}

fn attempt_post(
    pool: &service_kit::pg::Pool,
    r: &PostRequest,
    o: &EngineOptions,
    mismatches: &mut Vec<Mismatch>,
) -> Result<Posted, PostError> {
    // A refusal inside the transaction rolls it back like a store error; it travels out in this slot.
    let mut refused: Option<PostError> = None;
    let done = transaction(pool, IsolationLevel::ReadCommitted, |tx| {
        match locked(tx, r, o, mismatches) {
            Ok(p) => Ok(p),
            Err(PostError::Store(s)) => Err(s),
            Err(e) => {
                refused = Some(e);
                Err(StoreError::new("refused", None))
            }
        }
    });
    match (done, refused) {
        (_, Some(e)) => Err(e),
        (Ok(p), None) => Ok(p),
        (Err(s), None) => Err(PostError::Store(s)),
    }
}

/// Inside the transaction: the tip lock, the key again, the clock, the freeze, the balance, then the book.
fn locked(
    tx: &mut postgres::Transaction<'_>,
    r: &PostRequest,
    o: &EngineOptions,
    mismatches: &mut Vec<Mismatch>,
) -> Result<Posted, PostError> {
    // THE LOCK. Everything after this line runs single-file, platform-wide.
    let tip = tx
        .query(
            "SELECT hash, seq::text FROM ledger.chain_tip WHERE id = true FOR UPDATE",
            &[],
        )
        .map_err(StoreError::from)?;
    let Some(tip) = tip.first() else {
        return Err(ledger(
            "ledger.uninitialised",
            "chain_tip / posting_freeze row is missing — the ledger is not initialised",
        ));
    };
    let previous_hash: Option<String> = tip.try_get(0).map_err(StoreError::from)?;
    // Two retries of one key can both pass the fast path: re-checked here, ahead of the freeze.
    if let Some(claimed) = claimed_by_key(tx, &r.idempotency_key)? {
        return replay_of(claimed, r, o.conflict, mismatches);
    }
    refuse_on_clock_skew(tx, o)?;
    let freeze = tx
        .query(
            "SELECT frozen, reason FROM ledger.posting_freeze WHERE id = true",
            &[],
        )
        .map_err(StoreError::from)?;
    let Some(freeze) = freeze.first() else {
        return Err(ledger(
            "ledger.uninitialised",
            "posting_freeze row is missing — the ledger is not initialised",
        ));
    };
    let frozen: bool = freeze.try_get(0).map_err(StoreError::from)?;
    if frozen {
        let reason: Option<String> = freeze.try_get(1).map_err(StoreError::from)?;
        return Err(ledger(
            errors::FROZEN,
            match reason.filter(|r| !r.is_empty()) {
                Some(r) => format!("Ledger posting is frozen: {r}"),
                None => "Ledger posting is frozen".to_owned(),
            },
        ));
    }
    // Inside the lock too: a body that does not sum to zero never writes.
    assert_balanced(&r.entries)?;
    book(tx, r, previous_hash, o.clock_ms)
}

/// One unpublished `ledgerTxPosted` intent (`LedgerTxOutboxRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxRow {
    pub id: String,
    pub tx_id: String,
    pub payload: Json,
    pub correlation_id: String,
}

/// `unpublishedOutbox({ txId?, limit: 100 })`: oldest first.
pub fn unpublished_outbox(
    c: &mut impl GenericClient,
    tx_id: Option<&str>,
) -> Result<Vec<OutboxRow>, StoreError> {
    let rows = match tx_id {
        Some(id) => c.query(
            "SELECT id::text, tx_id::text, payload::text, correlation_id FROM ledger.ledger_tx_outbox
              WHERE tx_id = $1::text::uuid AND published_at IS NULL ORDER BY created_at ASC LIMIT 100",
            &[&id],
        )?,
        None => c.query(
            "SELECT id::text, tx_id::text, payload::text, correlation_id FROM ledger.ledger_tx_outbox
              WHERE published_at IS NULL ORDER BY created_at ASC LIMIT 100",
            &[],
        )?,
    };
    rows.iter()
        .map(|r| {
            let payload: String = r.try_get(2)?;
            Ok(OutboxRow {
                id: r.try_get(0)?,
                tx_id: r.try_get(1)?,
                payload: json::parse(&payload).map_err(|e| {
                    StoreError::new(format!("ledger_tx_outbox.payload: {}", e.message), None)
                })?,
                correlation_id: r.try_get(3)?,
            })
        })
        .collect()
}

/// `markOutboxPublished(id)`.
pub fn mark_published(c: &mut impl GenericClient, id: &str) -> Result<(), StoreError> {
    c.execute(
        "UPDATE ledger.ledger_tx_outbox SET published_at = now() WHERE id = $1::text::uuid AND published_at IS NULL",
        &[&id],
    )?;
    Ok(())
}
