//! The `desk` slice: the ledger desk's operator reads and its account metadata writes (`ledger/operator-desk.ts`,
//! `operator-tx-get.ts`, `operator-trace.ts`, `operator-lookup.ts`, `operator-account-metadata.ts`).
//!
//! Every read that names a customer's movement or account writes one `operator_access_log` row first, and is refused
//! with nothing read when it cannot ([`record_lookup`]): the transaction list, the address search, one transaction,
//! a business key's trace and an account's metadata. The book's counts name no one and write no row. The reads answer
//! while the posting freeze is on.
//!
//! Metadata is not a posting: a set and a delete write `account_metadata` and its append-only change record, never an
//! entry, a balance or a transaction. Both refuse `ledger.frozen` under the freeze, read under a share lock in the
//! write's own transaction. A delete spends a second founder's identity approval, bound to the account, the key, the
//! reason and the key's revision; it checks the freeze and the key before identity spends anything, and a refusal
//! after the spend says the approval is gone (`ledger.account_metadata_approval_spent`).
//!
//! A refusal the TypeScript throws as a `LedgerError` is a [`StoreError`] whose code starts `ledger.`; a database
//! error keeps its SQLSTATE there. Amounts are decimal strings on the wire and scaled integers inside.

use postgres::{GenericClient, IsolationLevel, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;

use crate::approval::{Approvals, Refused, consume_ledger_approval};
use crate::balances::{Entry, Tx, tx_by_id, tx_by_key};
use crate::db::{Store, StoreError, with_client};
use crate::errors::Failure;

/// `DESK_PAGE_SIZE`: one page of the desk. A page size, not a money magnitude.
pub const DESK_PAGE_SIZE: usize = 50;
/// `ACCOUNT_METADATA_HISTORY`: how many recent changes a metadata read answers.
pub const ACCOUNT_METADATA_HISTORY: i64 = 50;

pub const LOOKUP_UNRECORDED: &str = "ledger.lookup_unrecorded";
pub const TX_NOT_FOUND: &str = "ledger.tx_not_found";
pub const BOOKING_RECORD_MISSING: &str = "ledger.booking_record_missing";
pub const TRACE_INCONSISTENT: &str = "ledger.trace_inconsistent";
pub const ACCOUNT_METADATA_INVALID: &str = "ledger.account_metadata_invalid";
pub const ACCOUNT_NOT_FOUND: &str = "ledger.account_not_found";
pub const ACCOUNT_METADATA_STALE: &str = "ledger.account_metadata_stale";
pub const ACCOUNT_METADATA_KEY_ABSENT: &str = "ledger.account_metadata_key_absent";
pub const ACCOUNT_METADATA_APPROVAL_SPENT: &str = "ledger.account_metadata_approval_spent";
pub const FROZEN: &str = "ledger.frozen";
pub const UNINITIALISED: &str = "ledger.uninitialised";
pub const ACCOUNT_METADATA_DELETE_ACTION: &str = "ledger.account_metadata.delete";
/// The target identity consumes a metadata delete against, in the ledger's `posting_<verb>` form.
pub const ACCOUNT_METADATA_DELETE_TARGET: &str = "posting_account_metadata.delete";

const ACCOUNT_NOT_FOUND_MESSAGE: &str = "No ledger account has that id.";

/// `toISOString()` of a `timestamptz` column: the instant at millisecond precision, UTC.
fn iso(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}

fn ledger(code: &str, message: impl Into<String>) -> StoreError {
    StoreError::new(message, Some(code))
}

/// A stored amount (`parseStoredAmount`): a malformed one fails the read.
fn stored(text: &str) -> Result<Amount, StoreError> {
    parse_amount(text).map_err(|m| ledger("ledger.invalid_entry", m))
}

fn nullable(s: Option<String>) -> Json {
    s.map_or(Json::Null, Json::String)
}

fn obj(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

/// A string field of an input its schema has already parsed.
fn text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

/// The revision an input names: its schema has made it an integer in `[0, 2147483646]`.
fn revision_of(input: &Value) -> i32 {
    input
        .get("revision")
        .as_number()
        .and_then(|n| format!("{n}").parse::<i32>().ok())
        .unwrap_or(0)
}

// ── who is looking ──────────────────────────────────────────────────────────────────────────────────────────────────

/// `LookupActor`: the operator's verified id and the request it came on.
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    pub actor_id: &'a str,
    pub request_id: Option<&'a str>,
}

/// Why a recorded read did not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// `LookupUnrecordedError`: the access row could not be written, so nothing was read.
    Unrecorded(StoreError),
    /// Anything after the row: a `LedgerError` keeps its code, a driver error its SQLSTATE.
    Read(StoreError),
}

impl From<StoreError> for ReadError {
    fn from(e: StoreError) -> ReadError {
        ReadError::Read(e)
    }
}

/// `recordLookup(recorder, actor, target)`: one access row, written before the read; a refusal stops the read.
pub fn record_lookup(
    store: &Store,
    actor: Actor<'_>,
    owner_type: &str,
    owner_id: &str,
    action: &str,
) -> Result<(), ReadError> {
    let pool = store.pool().map_err(ReadError::Unrecorded)?;
    with_client(pool, |c| {
        c.execute(
            "INSERT INTO operator_access_log (actor_id, action, target_owner_type, target_owner_id, request_id)
             VALUES ($1, $2, $3, $4, $5)",
            &[&actor.actor_id, &action, &owner_type, &owner_id, &actor.request_id],
        )?;
        Ok(())
    })
    .map_err(ReadError::Unrecorded)
}

/// A repeatable-read, read-only snapshot, so every part of one answer is the same book.
fn snapshot<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Transaction<'_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    store.begin(IsolationLevel::RepeatableRead, true, f)
}

// ── #1 the transaction list ─────────────────────────────────────────────────────────────────────────────────────────

/// `txListTarget(input)`: the filters in a fixed order, as the access row names them.
pub fn tx_list_target(input: &Value) -> String {
    let part = |k: &str| text(input, k).unwrap_or("*").to_owned();
    format!(
        "asset={} from={} to={} before={}",
        part("assetId"),
        part("from"),
        part("to"),
        part("before")
    )
}

/// `operatorTxList`: recorded under the operator, then `listOperatorTransactions`.
pub fn operator_tx_list(store: &Store, actor: Actor<'_>, input: &Value) -> Result<Json, ReadError> {
    record_lookup(
        store,
        actor,
        "transactions",
        &tx_list_target(input),
        "transactions.list",
    )?;
    Ok(list_transactions(store, input)?)
}

/// `listOperatorTransactions(sql, input)`: newest first, a page past `before`, and the ledger's own total on the
/// first page only (a later page answers null). Times are half-open `[from, to)` on the ledger's `posted_at`.
pub fn list_transactions(store: &Store, input: &Value) -> Result<Json, StoreError> {
    let asset = text(input, "assetId");
    // `new Date(q.from)`, sent as its `toISOString()`.
    let instant = |k: &str| {
        text(input, k)
            .map(|t| service_kit::time::js_date(t).map(service_kit::time::Instant::iso))
            .map(|d| {
                d.ok_or_else(|| ledger("ledger.operator_request_failed", "Invalid time value"))
            })
            .transpose()
    };
    let (from, to) = (instant("from")?, instant("to")?);
    let before = text(input, "before");
    snapshot(store, |tx| {
        let filters = "($1::text IS NULL OR EXISTS (SELECT 1 FROM ledger_entries m WHERE m.tx_id = t.id AND m.asset_id = $1))
              AND ($2::text IS NULL OR t.posted_at >= $2::text::timestamptz)
              AND ($3::text IS NULL OR t.posted_at < $3::text::timestamptz)";
        let total = if before.is_none() {
            let row = tx.query_one(
                &format!("SELECT count(*)::text FROM ledger_tx t WHERE {filters}"),
                &[&asset, &from, &to],
            )?;
            Json::String(row.try_get(0)?)
        } else {
            Json::Null
        };
        let limit = i64::try_from(DESK_PAGE_SIZE + 1).unwrap_or(i64::MAX);
        let rows = tx.query(
            &format!(
                "SELECT t.id::text, t.seq::text, t.idempotency_key, t.module, t.reason, {},
                        (SELECT array_agg(DISTINCT e.asset_id ORDER BY e.asset_id) FROM ledger_entries e WHERE e.tx_id = t.id),
                        (SELECT count(*)::text FROM ledger_entries e WHERE e.tx_id = t.id)
                   FROM ledger_tx t
                  WHERE {filters} AND ($4::text IS NULL OR t.seq < $4::text::bigint)
                  ORDER BY t.seq DESC
                  LIMIT $5",
                iso("t.posted_at")
            ),
            &[&asset, &from, &to, &before, &limit],
        )?;
        let page = rows
            .get(..DESK_PAGE_SIZE.min(rows.len()))
            .unwrap_or_default();
        let mut out = Vec::with_capacity(page.len());
        for r in page {
            let postings: String = r.try_get(7)?;
            // The answer's own schema: a booked transaction has at least one posting.
            if postings == "0" {
                return Err(ledger(
                    "ledger.invalid_entry",
                    "a listed transaction has no postings",
                ));
            }
            let assets: Option<Vec<String>> = r.try_get(6)?;
            out.push(obj(vec![
                ("txId", Json::String(r.try_get(0)?)),
                ("seq", Json::String(r.try_get(1)?)),
                ("businessKey", Json::String(r.try_get(2)?)),
                ("module", Json::String(r.try_get(3)?)),
                ("reason", Json::String(r.try_get(4)?)),
                ("postedAt", Json::String(r.try_get(5)?)),
                (
                    "assets",
                    Json::Array(
                        assets
                            .unwrap_or_default()
                            .into_iter()
                            .map(Json::String)
                            .collect(),
                    ),
                ),
                ("postings", Json::String(postings)),
            ]));
        }
        let next = if rows.len() > DESK_PAGE_SIZE {
            page.last()
                .map(|r| r.try_get::<_, String>(1))
                .transpose()?
                .map_or(Json::Null, Json::String)
        } else {
            Json::Null
        };
        Ok(obj(vec![
            ("total", total),
            ("rows", Json::Array(out)),
            ("nextCursor", next),
        ]))
    })
}

// ── #2 / #3 one transaction, and the booking record beside it ────────────────────────────────────────────────────────

/// `getTx` and `getTxByKey` are the `balances` slice's reads (`crate::balances`); their refusal as the desk's.
fn book(r: Result<Option<Tx>, Failure>) -> Result<Option<Tx>, StoreError> {
    r.map_err(|f| match f {
        Failure::Ledger { code, message } => StoreError::new(message, Some(&code)),
        _ => StoreError::new("Ledger request failed", None),
    })
}

/// `readBookingRecord(sql, txId)`: the transaction's place in the log, the database's time for the booking, the
/// reference the request carried, and the `tx.posted` record written in the same commit; `None` for no transaction.
pub fn read_booking_record(
    c: &mut impl GenericClient,
    tx_id: &str,
) -> Result<Option<Json>, StoreError> {
    let rows = c.query(
        &format!(
            "SELECT t.seq::text, o.id::text, o.correlation_id, {}, {}
               FROM ledger_tx t LEFT JOIN ledger_tx_outbox o ON o.tx_id = t.id
              WHERE t.id = $1::text::uuid",
            iso("o.created_at"),
            iso("o.published_at")
        ),
        &[&tx_id],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let outbox: Option<String> = row.try_get(1)?;
    let created: Option<String> = row.try_get(3)?;
    let published: Option<String> = row.try_get(4)?;
    let event = match (outbox, &created) {
        (Some(id), Some(at)) => obj(vec![
            ("id", Json::String(id)),
            ("subject", Json::str("intafaced.ledger.tx.posted")),
            ("recordedAt", Json::str(at.clone())),
            ("publishedAt", nullable(published)),
        ]),
        _ => Json::Null,
    };
    Ok(Some(obj(vec![
        ("seq", Json::String(row.try_get(0)?)),
        ("bookedAt", nullable(created)),
        ("reference", nullable(row.try_get(2)?)),
        ("event", event),
    ])))
}

/// `deskPosting(e)`: a debit raises a balance in this book and a credit lowers it, so a credited account is where the
/// value came from (`source`) and a debited one where it went (`destination`).
fn desk_posting(e: &Entry) -> Json {
    let debit = e.direction == "debit";
    let delta = if debit { e.amount } else { -e.amount };
    obj(vec![
        ("entryId", Json::str(e.id.clone())),
        ("accountId", Json::str(e.account_id.clone())),
        ("assetId", Json::str(e.asset_id.clone())),
        ("direction", Json::str(e.direction.clone())),
        (
            "side",
            Json::str(if debit { "destination" } else { "source" }),
        ),
        ("amount", Json::str(format_amount(e.amount))),
        (
            "balanceBefore",
            Json::str(format_amount(e.balance_after - delta)),
        ),
        ("balanceAfter", Json::str(format_amount(e.balance_after))),
    ])
}

/// The fields one transaction and its trace share, after their leading ones.
fn tx_body(tx: &Tx, booking: Json) -> Vec<(&'static str, Json)> {
    vec![
        ("module", Json::str(tx.module.clone())),
        ("reason", Json::str(tx.reason.clone())),
        ("postedAt", Json::str(tx.posted_at.clone())),
        ("hash", Json::str(tx.hash.clone())),
        ("previousHash", nullable(tx.previous_hash.clone())),
        ("booking", booking),
        (
            "postings",
            Json::Array(tx.entries.iter().map(desk_posting).collect()),
        ),
    ]
}

fn booking_of(c: &mut impl GenericClient, tx: &Tx) -> Result<Json, StoreError> {
    read_booking_record(c, &tx.id)?.ok_or_else(|| {
        ledger(
            BOOKING_RECORD_MISSING,
            format!("transaction {} has no row in the ledger log", tx.id),
        )
    })
}

/// `operatorTxGet`: recorded, then one booked transaction by id; an unknown id is `ledger.tx_not_found`.
pub fn operator_tx_get(store: &Store, actor: Actor<'_>, tx_id: &str) -> Result<Json, ReadError> {
    record_lookup(store, actor, "transaction", tx_id, "transaction.read")?;
    let pool = store.pool()?;
    Ok(with_client(pool, |c| {
        let tx = book(tx_by_id(c, tx_id))?
            .ok_or_else(|| ledger(TX_NOT_FOUND, format!("no transaction {tx_id}")))?;
        let booking = booking_of(c, &tx)?;
        let mut body = vec![
            ("txId", Json::str(tx.id.clone())),
            ("businessKey", Json::str(tx.idempotency_key.clone())),
        ];
        body.extend(tx_body(&tx, booking));
        Ok(obj(body))
    })?)
}

/// `traceBusinessKey`: recorded, then the transaction a business key booked; a key that never booked is an honest
/// `found: false`.
pub fn operator_trace(store: &Store, actor: Actor<'_>, key: &str) -> Result<Json, ReadError> {
    record_lookup(store, actor, "business_key", key, "trace.read")?;
    let pool = store.pool()?;
    Ok(with_client(pool, |c| {
        let Some(tx) = book(tx_by_key(c, key))? else {
            return Ok(obj(vec![
                ("found", Json::Bool(false)),
                ("businessKey", Json::str(key)),
            ]));
        };
        if tx.idempotency_key != key {
            return Err(ledger(
                TRACE_INCONSISTENT,
                format!(
                    "ledger answered tx {} for key {key}, but it was booked under another key",
                    tx.id
                ),
            ));
        }
        let booking = booking_of(c, &tx)?;
        let mut body = vec![
            ("found", Json::Bool(true)),
            ("businessKey", Json::str(key)),
            ("txId", Json::str(tx.id.clone())),
        ];
        body.extend(tx_body(&tx, booking));
        Ok(obj(body))
    })?)
}

// ── #4 the account address search ───────────────────────────────────────────────────────────────────────────────────

/// Postgres LIKE with the prefix taken literally.
fn like_prefix(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 1);
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// `operatorAccountSearch`: recorded under the operator, then `searchOperatorAccounts`.
pub fn operator_account_search(
    store: &Store,
    actor: Actor<'_>,
    input: &Value,
) -> Result<Json, ReadError> {
    let prefix = text(input, "prefix").unwrap_or_default();
    record_lookup(store, actor, "address_prefix", prefix, "accounts.search")?;
    Ok(search_accounts(store, input)?)
}

/// `searchOperatorAccounts(sql, input)`: a whole owner type and the start of an owner id, ordered by owner id then
/// account id so a cursor names one place; each account with its debit and credit volumes and the balance they make.
pub fn search_accounts(store: &Store, input: &Value) -> Result<Json, StoreError> {
    let prefix = text(input, "prefix").unwrap_or_default();
    let after = text(input, "after");
    // The schema matched `^(<owner type>):(.{1,128})$`; no owner type holds a colon.
    let (owner_type, owner_id) = prefix.split_once(':').unwrap_or((prefix, ""));
    let limit = i64::try_from(DESK_PAGE_SIZE + 1).unwrap_or(i64::MAX);
    let pool = store.pool()?;
    let rows = with_client(pool, |c| {
        Ok(c.query(
            "WITH page AS (
               SELECT a.id, a.owner_type::text AS owner_type, a.owner_id, a.asset_id, a.kind::text AS kind, a.purpose
                 FROM accounts a
                WHERE a.owner_type = $1::text::owner_type
                  AND a.owner_id LIKE $2
                  AND ($3::text IS NULL OR (a.owner_id, a.id) > (SELECT c.owner_id, c.id FROM accounts c WHERE c.id = $3::text::uuid))
                ORDER BY a.owner_id, a.id
                LIMIT $4
             )
             SELECT p.id::text, p.owner_type, p.owner_id, p.asset_id, p.kind, p.purpose,
                    COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'debit'), 0)::text,
                    COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'credit'), 0)::text,
                    count(e.id)::text
               FROM page p LEFT JOIN ledger_entries e ON e.account_id = p.id
              GROUP BY p.id, p.owner_type, p.owner_id, p.asset_id, p.kind, p.purpose
              ORDER BY p.owner_id, p.id",
            &[&owner_type, &like_prefix(owner_id), &after, &limit],
        )?)
    })?;
    let page = rows
        .get(..DESK_PAGE_SIZE.min(rows.len()))
        .unwrap_or_default();
    let mut accounts = Vec::with_capacity(page.len());
    for r in page {
        let (owner_type, owner_id): (String, String) = (r.try_get(1)?, r.try_get(2)?);
        let debits = stored(&r.try_get::<_, String>(6)?)?;
        let credits = stored(&r.try_get::<_, String>(7)?)?;
        accounts.push(obj(vec![
            ("accountId", Json::String(r.try_get(0)?)),
            ("address", Json::str(format!("{owner_type}:{owner_id}"))),
            ("ownerType", Json::String(owner_type)),
            ("ownerId", Json::String(owner_id)),
            ("assetId", Json::String(r.try_get(3)?)),
            ("kind", Json::String(r.try_get(4)?)),
            ("purpose", Json::String(r.try_get(5)?)),
            ("debits", Json::str(format_amount(debits))),
            ("credits", Json::str(format_amount(credits))),
            ("balance", Json::str(format_amount(debits - credits))),
            ("postings", Json::String(r.try_get(8)?)),
        ]));
    }
    let next = if rows.len() > DESK_PAGE_SIZE {
        page.last()
            .map(|r| r.try_get::<_, String>(0))
            .transpose()?
            .map_or(Json::Null, Json::String)
    } else {
        Json::Null
    };
    Ok(obj(vec![
        ("prefix", Json::str(prefix)),
        ("accounts", Json::Array(accounts)),
        ("nextCursor", next),
    ]))
}

// ── #5 the book's counts ────────────────────────────────────────────────────────────────────────────────────────────

/// `readOperatorStats(sql)`: the book's counts in one snapshot, and the database time they were read at.
pub fn read_stats(store: &Store) -> Result<Json, StoreError> {
    snapshot(store, |tx| {
        let r = tx.query_one(
            &format!(
                "SELECT (SELECT count(*) FROM ledger_tx)::text,
                        (SELECT count(*) FROM ledger_entries)::text,
                        (SELECT count(*) FROM accounts)::text,
                        (SELECT count(DISTINCT asset_id) FROM accounts)::text,
                        (SELECT max(seq) FROM ledger_tx)::text,
                        (SELECT {} FROM ledger_tx ORDER BY seq DESC LIMIT 1),
                        {}",
                iso("posted_at"),
                iso("clock_timestamp()")
            ),
            &[],
        )?;
        Ok(obj(vec![
            ("transactions", Json::String(r.try_get(0)?)),
            ("postings", Json::String(r.try_get(1)?)),
            ("accounts", Json::String(r.try_get(2)?)),
            ("assets", Json::String(r.try_get(3)?)),
            ("lastSeq", nullable(r.try_get(4)?)),
            ("lastPostedAt", nullable(r.try_get(5)?)),
            ("asOf", Json::String(r.try_get(6)?)),
        ]))
    })
}

// ── #6 / #7 account metadata ────────────────────────────────────────────────────────────────────────────────────────

/// One row of `account_metadata_changes` (`ChangeRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub seq: String,
    pub key: String,
    pub action: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub revision: i32,
    pub requester_id: String,
    pub approver_id: Option<String>,
    pub approval_id: Option<String>,
    pub reason: String,
    pub recorded_at: String,
}

fn change_columns() -> String {
    format!(
        "seq::text, key, action, before, after, revision, requester_id, approver_id, approval_id, reason, {}",
        iso("recorded_at")
    )
}

fn change_row(r: &Row) -> Result<Change, StoreError> {
    Ok(Change {
        seq: r.try_get(0)?,
        key: r.try_get(1)?,
        action: r.try_get(2)?,
        before: r.try_get(3)?,
        after: r.try_get(4)?,
        revision: r.try_get(5)?,
        requester_id: r.try_get(6)?,
        approver_id: r.try_get(7)?,
        approval_id: r.try_get(8)?,
        reason: r.try_get(9)?,
        recorded_at: r.try_get(10)?,
    })
}

/// `changeOf(row)`.
pub fn change_json(c: &Change) -> Json {
    obj(vec![
        ("seq", Json::str(c.seq.clone())),
        ("key", Json::str(c.key.clone())),
        ("action", Json::str(c.action.clone())),
        ("before", nullable(c.before.clone())),
        ("after", nullable(c.after.clone())),
        ("revision", Json::int(i64::from(c.revision))),
        ("requesterId", Json::str(c.requester_id.clone())),
        ("approverId", nullable(c.approver_id.clone())),
        ("reason", Json::str(c.reason.clone())),
        ("recordedAt", Json::str(c.recorded_at.clone())),
    ])
}

fn changed(account_id: &str, c: &Change) -> Json {
    obj(vec![
        ("accountId", Json::str(account_id)),
        ("change", change_json(c)),
    ])
}

/// `operatorAccountMetadataRead`: recorded under the operator, then `readAccountMetadata`.
pub fn operator_metadata_read(
    store: &Store,
    actor: Actor<'_>,
    account_id: &str,
) -> Result<Json, ReadError> {
    record_lookup(store, actor, "account", account_id, "account_metadata.read")?;
    Ok(read_account_metadata(store, account_id)?)
}

/// `readAccountMetadata(sql, input)`: the keys that hold a value, the deleted keys' revisions, the newest changes
/// first, and whether the book is frozen, in one snapshot.
pub fn read_account_metadata(store: &Store, account_id: &str) -> Result<Json, StoreError> {
    snapshot(store, |tx| {
        let account = tx.query(
            "SELECT owner_type::text, owner_id FROM accounts WHERE id = $1::text::uuid",
            &[&account_id],
        )?;
        let Some(account) = account.first() else {
            return Err(ledger(ACCOUNT_NOT_FOUND, ACCOUNT_NOT_FOUND_MESSAGE));
        };
        let address = format!(
            "{}:{}",
            account.try_get::<_, String>(0)?,
            account.try_get::<_, String>(1)?
        );
        let keys = tx.query(
            &format!(
                "SELECT key, value, revision, {}, updated_by FROM account_metadata WHERE account_id = $1::text::uuid ORDER BY key",
                iso("updated_at")
            ),
            &[&account_id],
        )?;
        let (mut entries, mut deleted) = (Vec::new(), Vec::new());
        for k in &keys {
            let (key, value, revision): (String, Option<String>, i32) =
                (k.try_get(0)?, k.try_get(1)?, k.try_get(2)?);
            match value {
                Some(value) => entries.push(obj(vec![
                    ("key", Json::String(key)),
                    ("value", Json::String(value)),
                    ("revision", Json::int(i64::from(revision))),
                    ("updatedAt", Json::String(k.try_get(3)?)),
                    ("updatedBy", Json::String(k.try_get(4)?)),
                ])),
                None => deleted.push(obj(vec![
                    ("key", Json::String(key)),
                    ("revision", Json::int(i64::from(revision))),
                ])),
            }
        }
        let changes = tx
            .query(
                &format!(
                    "SELECT {} FROM account_metadata_changes WHERE account_id = $1::text::uuid ORDER BY account_metadata_changes.seq DESC LIMIT $2",
                    change_columns()
                ),
                &[&account_id, &ACCOUNT_METADATA_HISTORY],
            )?
            .iter()
            .map(|r| change_row(r).map(|c| change_json(&c)))
            .collect::<Result<Vec<_>, _>>()?;
        let frozen = tx
            .query("SELECT frozen FROM posting_freeze WHERE id = true", &[])?
            .first()
            .map(|r| r.try_get::<_, bool>(0))
            .transpose()?
            .unwrap_or(false);
        Ok(obj(vec![
            ("accountId", Json::str(account_id)),
            ("address", Json::String(address)),
            ("entries", Json::Array(entries)),
            ("deleted", Json::Array(deleted)),
            ("changes", Json::Array(changes)),
            ("frozen", Json::Bool(frozen)),
        ]))
    })
}

/// Inside a write's transaction: refuse while frozen, holding a share lock so a freeze waits for this write.
fn refuse_while_frozen(tx: &mut impl GenericClient) -> Result<(), StoreError> {
    let rows = tx.query(
        "SELECT frozen, reason FROM posting_freeze WHERE id = true FOR SHARE",
        &[],
    )?;
    let Some(row) = rows.first() else {
        return Err(ledger(
            UNINITIALISED,
            "posting_freeze row is missing — the ledger is not initialised",
        ));
    };
    if row.try_get::<_, bool>(0)? {
        // `frozenMessage(reason)`.
        let reason: Option<String> = row.try_get(1)?;
        let message = match reason.as_deref() {
            Some(r) if !r.is_empty() => format!("Ledger posting is frozen: {r}"),
            _ => "Ledger posting is frozen".to_owned(),
        };
        return Err(ledger(FROZEN, message));
    }
    Ok(())
}

fn lock_account(tx: &mut impl GenericClient, id: &str) -> Result<(), StoreError> {
    if tx
        .query(
            "SELECT 1 FROM accounts WHERE id = $1::text::uuid FOR KEY SHARE",
            &[&id],
        )?
        .is_empty()
    {
        return Err(ledger(ACCOUNT_NOT_FOUND, ACCOUNT_NOT_FOUND_MESSAGE));
    }
    Ok(())
}

fn change_at(
    c: &mut impl GenericClient,
    account_id: &str,
    key: &str,
    revision: i32,
) -> Result<Option<Change>, StoreError> {
    c.query(
        &format!(
            "SELECT {} FROM account_metadata_changes WHERE account_id = $1::text::uuid AND key = $2 AND revision = $3",
            change_columns()
        ),
        &[&account_id, &key, &revision],
    )?
    .first()
    .map(change_row)
    .transpose()
}

/// A change outside a transaction (`changeAt(sql, ...)`).
fn change_at_now(
    store: &Store,
    account_id: &str,
    key: &str,
    revision: i32,
) -> Result<Option<Change>, StoreError> {
    with_client(store.pool()?, |c| change_at(c, account_id, key, revision))
}

fn unique_violation(e: &StoreError) -> bool {
    e.code.as_deref() == Some("23505")
}

/// What a metadata write's input is: the body's own fields (an array's by index, anything else none), then the path's
/// account id (`bodyFor(req, body)`).
pub fn body_for(body: Option<&Json>, account_id: &str) -> Value {
    let mut fields: Vec<(String, Json)> = match body {
        Some(Json::Object(o)) => o.clone(),
        Some(Json::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        _ => Vec::new(),
    };
    match fields.iter_mut().find(|(k, _)| k == "accountId") {
        Some((_, v)) => *v = Json::str(account_id),
        None => fields.push(("accountId".to_owned(), Json::str(account_id))),
    }
    Value::from_json(&Json::Object(fields))
}

/// `parseOrRefuse(schema, input)`: the parsed input, or `ledger.account_metadata_invalid` naming each issue.
fn parse_or_refuse(schema: &str, input: Value) -> Result<Value, StoreError> {
    match crate::door::parse(schema, input) {
        Ok(service_kit::schema::Outcome::Ok(v)) => Ok(v),
        Ok(service_kit::schema::Outcome::Issues(issues)) => Err(ledger(
            ACCOUNT_METADATA_INVALID,
            issues
                .iter()
                .map(service_kit::schema::Issue::message)
                .collect::<Vec<_>>()
                .join("; "),
        )),
        Err(thrown) => Err(StoreError::new(thrown, None)),
    }
}

/// `setAccountMetadata(sql, actorId, input)`: set or overwrite one key from the revision the founder read (0 for a
/// new key); the write takes the next. A retry of the same set after a lost reply answers its own change again; any
/// other change at that revision means someone wrote first, and nothing changes (`ledger.account_metadata_stale`).
pub fn set_account_metadata(
    store: &Store,
    actor_id: &str,
    input: Value,
) -> Result<Json, StoreError> {
    let cmd = parse_or_refuse("metadataSet", input)?;
    let (account_id, key, value, reason) = (
        text(&cmd, "accountId").unwrap_or_default(),
        text(&cmd, "key").unwrap_or_default(),
        text(&cmd, "value").unwrap_or_default(),
        text(&cmd, "reason").unwrap_or_default(),
    );
    let revision = revision_of(&cmd);
    let next = revision + 1;
    let same_set = |c: &Option<Change>| {
        c.as_ref()
            .filter(|c| {
                c.action == "set"
                    && c.after.as_deref() == Some(value)
                    && c.requester_id == actor_id
                    && c.reason == reason
            })
            .cloned()
    };
    let wrote = store.begin(IsolationLevel::ReadCommitted, false, |tx| {
        refuse_while_frozen(tx)?;
        lock_account(tx, account_id)?;
        let current = tx.query(
            "SELECT value, revision FROM account_metadata WHERE account_id = $1::text::uuid AND key = $2 FOR UPDATE",
            &[&account_id, &key],
        )?;
        let before: Option<String> = current.first().map(|r| r.try_get(0)).transpose()?.flatten();
        let held: i32 = current.first().map(|r| r.try_get(1)).transpose()?.unwrap_or(0);
        if held != revision {
            if let Some(prior) = same_set(&change_at(tx, account_id, key, next)?) {
                return Ok(prior);
            }
            return Err(ledger(
                ACCOUNT_METADATA_STALE,
                format!("{key} changed after it was read (revision {held}); read it again"),
            ));
        }
        tx.execute(
            "INSERT INTO account_metadata (account_id, key, value, revision, updated_at, updated_by)
             VALUES ($1::text::uuid, $2, $3, $4, now(), $5)
             ON CONFLICT (account_id, key) DO UPDATE
               SET value = EXCLUDED.value, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
            &[&account_id, &key, &value, &next, &actor_id],
        )?;
        let row = tx.query_one(
            &format!(
                "INSERT INTO account_metadata_changes (account_id, key, action, before, after, revision, requester_id, reason)
                 VALUES ($1::text::uuid, $2, 'set', $3, $4, $5, $6, $7)
                 RETURNING {}",
                change_columns()
            ),
            &[&account_id, &key, &before, &value, &next, &actor_id, &reason],
        )?;
        change_row(&row)
    });
    match wrote {
        Ok(c) => Ok(changed(account_id, &c)),
        // Two first writes of a new key race on the primary key: the loser wrote nothing.
        Err(e) if unique_violation(&e) => {
            match same_set(&change_at_now(store, account_id, key, next)?) {
                Some(prior) => Ok(changed(account_id, &prior)),
                None => Err(ledger(
                    ACCOUNT_METADATA_STALE,
                    format!("{key} changed after it was read; read it again"),
                )),
            }
        }
        Err(e) => Err(e),
    }
}

/// Why a metadata delete did not change anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteError {
    Store(StoreError),
    /// The approval was not spent: identity refused it, or its attestation does not hold.
    Approval(Refused),
}

impl From<StoreError> for DeleteError {
    fn from(e: StoreError) -> DeleteError {
        DeleteError::Store(e)
    }
}

/// The key's value at the approved revision, or the refusal that says why not.
fn holds_value_at(
    tx: &mut impl GenericClient,
    account_id: &str,
    key: &str,
    revision: i32,
    lock: bool,
) -> Result<String, StoreError> {
    let rows = tx.query(
        &format!(
            "SELECT value, revision FROM account_metadata WHERE account_id = $1::text::uuid AND key = $2{}",
            if lock { " FOR UPDATE" } else { "" }
        ),
        &[&account_id, &key],
    )?;
    let Some(current) = rows.first() else {
        return Err(ledger(
            ACCOUNT_METADATA_KEY_ABSENT,
            format!("{key} is not set on this account"),
        ));
    };
    let held: i32 = current.try_get(1)?;
    if held != revision {
        return Err(ledger(
            ACCOUNT_METADATA_STALE,
            format!(
                "{key} changed after the delete was approved (revision {held}); approve it again"
            ),
        ));
    }
    current.try_get::<_, Option<String>>(0)?.ok_or_else(|| {
        ledger(
            ACCOUNT_METADATA_KEY_ABSENT,
            format!("{key} is already deleted"),
        )
    })
}

/// A refusal after identity spent the approval: the same answer, under a code that says the approval is gone.
fn spent_if_refused<T>(r: Result<T, StoreError>) -> Result<T, StoreError> {
    r.map_err(|e| match e.code.as_deref() {
        Some(FROZEN | ACCOUNT_METADATA_STALE | ACCOUNT_METADATA_KEY_ABSENT) => ledger(
            ACCOUNT_METADATA_APPROVAL_SPENT,
            format!("{}; the approval was used, so ask for a new one", e.message),
        ),
        _ => e,
    })
}

/// `deleteAccountMetadata(sql, approvals, operatorId, input)`: refuse while frozen and check the key still holds a
/// value at the approved revision (nothing spent yet), ask identity to spend the approval, then write in one
/// transaction that checks both again. A retry with the same approval after a lost reply answers the change that
/// approval wrote, without asking identity a second time.
pub fn delete_account_metadata(
    store: &Store,
    approvals: &dyn Approvals,
    operator_id: &str,
    input: Value,
) -> Result<Json, DeleteError> {
    let cmd = parse_or_refuse("metadataDelete", input)?;
    let (account_id, key, reason, approval_id, operation_id) = (
        text(&cmd, "accountId").unwrap_or_default(),
        text(&cmd, "key").unwrap_or_default(),
        text(&cmd, "reason").unwrap_or_default(),
        text(&cmd, "approvalId").unwrap_or_default(),
        text(&cmd, "operationId").unwrap_or_default(),
    );
    let revision = revision_of(&cmd);
    let next = revision + 1;
    let replay = || -> Result<Option<Change>, StoreError> {
        Ok(change_at_now(store, account_id, key, next)?.filter(|p| {
            p.action == "delete"
                && p.reason == reason
                && p.approval_id.as_deref() == Some(approval_id)
        }))
    };
    if let Some(prior) = replay()? {
        return Ok(changed(account_id, &prior));
    }

    // Before identity spends anything: a frozen book, a missing account or a key that moved keeps the approval.
    store.begin(IsolationLevel::ReadCommitted, false, |tx| {
        refuse_while_frozen(tx)?;
        lock_account(tx, account_id)?;
        holds_value_at(tx, account_id, key, revision, false).map(|_| ())
    })?;

    let version = revision.to_string();
    let consumed = consume_ledger_approval(
        approvals,
        (approval_id, operation_id),
        ACCOUNT_METADATA_DELETE_ACTION,
        ACCOUNT_METADATA_DELETE_TARGET,
        &version,
        &[("accountId", account_id), ("key", key), ("reason", reason)],
        Some((operation_id, operator_id)),
    )
    .map_err(DeleteError::Approval)?;
    // The attestation has required a distinct founder pair, so the approver is set.
    let approver = consumed.approver_id.unwrap_or_default();

    let wrote = store.begin(IsolationLevel::ReadCommitted, false, |tx| {
        // The approval is spent now: a freeze or a write that landed since the check refuses with its own code.
        spent_if_refused(refuse_while_frozen(tx))?;
        lock_account(tx, account_id)?;
        let before = spent_if_refused(holds_value_at(tx, account_id, key, revision, true))?;
        tx.execute(
            "UPDATE account_metadata SET value = NULL, revision = $3, updated_at = now(), updated_by = $4
              WHERE account_id = $1::text::uuid AND key = $2",
            &[&account_id, &key, &next, &operator_id],
        )?;
        let row = tx.query_one(
            &format!(
                "INSERT INTO account_metadata_changes
                   (account_id, key, action, before, after, revision, requester_id, approver_id, approval_id, reason)
                 VALUES ($1::text::uuid, $2, 'delete', $3, NULL, $4, $5, $6, $7, $8)
                 RETURNING {}",
                change_columns()
            ),
            &[
                &account_id,
                &key,
                &before,
                &next,
                &consumed.requester_id,
                &approver,
                &approval_id,
                &reason,
            ],
        )?;
        change_row(&row)
    });
    match wrote {
        Ok(c) => Ok(changed(account_id, &c)),
        Err(e) if unique_violation(&e) => match replay()? {
            Some(prior) => Ok(changed(account_id, &prior)),
            None => Err(DeleteError::Store(ledger(
                ACCOUNT_METADATA_STALE,
                format!("{key} changed after the delete was approved; approve it again"),
            ))),
        },
        Err(e) => Err(DeleteError::Store(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prefix_is_taken_literally() {
        assert_eq!(like_prefix("rail_desk%"), "rail\\_desk\\%%");
        assert_eq!(like_prefix("a\\b"), "a\\\\b%");
    }

    #[test]
    fn the_list_names_its_filters_in_a_fixed_order() {
        let v = Value::from_json(&Json::obj([
            ("before", Json::str("42")),
            ("assetId", Json::str("USDC")),
        ]));
        assert_eq!(tx_list_target(&v), "asset=USDC from=* to=* before=42");
    }

    #[test]
    fn a_write_body_takes_the_paths_account_id() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let from_object = body_for(
            Some(&Json::obj([
                ("accountId", Json::str("x")),
                ("key", Json::str("k")),
            ])),
            id,
        );
        assert_eq!(from_object.get("accountId").as_str(), Some(id));
        assert_eq!(from_object.get("key").as_str(), Some("k"));
        let from_array = body_for(Some(&Json::Array(vec![Json::int(1)])), id);
        assert!(from_array.has("0"));
        assert!(!body_for(Some(&Json::str("x")), id).has("0"));
    }
}
