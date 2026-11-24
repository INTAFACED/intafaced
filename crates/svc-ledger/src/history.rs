//! The `history` slice: the three reads of one owner's movements (`ledger/history.ts`, `ledger/holdings-history.ts` and
//! `PostgresLedger.history`, `historyPage` and `holdingsHistory` in `ledger/postgres-ledger.ts`).
//!
//! Each is a read and only a read: no lock, no write, no path into a post.
//!
//! - [`history`]: every entry against one account in the half-open window `[from, to)`, oldest first. Over
//!   [`HISTORY_MAX_ENTRIES`] it refuses rather than answer short: a clipped history reads as a complete one.
//! - [`history_page`]: one page of an owner's entries in one account kind, newest first by entry id, resumed by an
//!   opaque cursor that carries a position and never an account. Each line names its allow-listed rail and product,
//!   the page owner's own order, the fee taken from the owner's receiving line of a fill, and a withdrawal line's id.
//! - [`holdings_history`]: what the owner holds now and what crossed its edge since `from`, per asset, reason and
//!   bucket, both read in one repeatable-read snapshot so the holdings are exactly what the movements lead up to.
//!
//! Moments cross as milliseconds since the epoch, as a JavaScript `Date` holds them: the database's microseconds are
//! cut to milliseconds the way `new Date(<timestamptz text>)` cuts them.

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use postgres::IsolationLevel;
use postgres::types::ToSql;

use service_kit::money::{Amount, js_trim, parse_amount};
use service_kit::time::Instant;

use crate::db::{Store, StoreError, transaction, with_client};

/// Entries per (account, window) read: `HISTORY_MAX_ENTRIES`, the same bound as the journal's.
pub const HISTORY_MAX_ENTRIES: usize = 10_000;
/// `LEDGER_HOLDINGS_HISTORY_MAX_ROWS`: a technical bound on one answer, never a business limit.
pub const HOLDINGS_HISTORY_MAX_ROWS: usize = 10_000;
/// `HISTORY_RAILS`: the rails a page may echo from `ledger_tx.meta.rail`.
pub const HISTORY_RAILS: [&str; 4] = [
    "crypto-native",
    "card-sandbox",
    "bank-crypto-ledger",
    "local-test",
];
/// `HISTORY_PRODUCTS`: the products a page may echo from `ledger_tx.meta.product`.
pub const HISTORY_PRODUCTS: [&str; 1] = ["convert"];

pub const RANGE_INVALID: &str = "ledger.history_range_invalid";
pub const RANGE_TOO_LARGE: &str = "ledger.history_range_too_large";
pub const PAGE_SOCKET: &str = "ledger.history_page_socket";
pub const CURSOR_INVALID: &str = "ledger.history_cursor_invalid";
pub const HOLDINGS_WINDOW_INVALID: &str = "ledger.holdings_history_window_invalid";
pub const HOLDINGS_TOO_LARGE: &str = "ledger.holdings_history_too_large";
pub const INVALID_ENTRY: &str = "ledger.invalid_entry";

/// Why a read did not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// A `LedgerError`: its code and its own message.
    Refused { code: &'static str, message: String },
    /// The database failed.
    Store(StoreError),
}

impl From<StoreError> for ReadError {
    fn from(e: StoreError) -> ReadError {
        ReadError::Store(e)
    }
}

impl From<postgres::Error> for ReadError {
    fn from(e: postgres::Error) -> ReadError {
        ReadError::Store(e.into())
    }
}

fn refused(code: &'static str, message: impl Into<String>) -> ReadError {
    ReadError::Refused {
        code,
        message: message.into(),
    }
}

/// `parseStoredAmount`: a stored decimal string as a scaled integer; anything else is `ledger.invalid_entry`.
fn stored(text: &str, field: &str) -> Result<Amount, ReadError> {
    parse_amount(text).map_err(|e| refused(INVALID_ENTRY, format!("{field}: {e}")))
}

/// A `timestamptz` column as `new Date(...)` holds it: milliseconds since the epoch, the fraction cut.
fn ms(column: &str) -> String {
    format!("floor(extract(epoch FROM {column}) * 1000)::bigint")
}

/// A millisecond parameter as a `timestamptz`, exactly.
fn at(param: &str) -> String {
    format!("(timestamptz 'epoch' + {param}::bigint * interval '1 millisecond')")
}

/// One account, as `accountRefSchema` names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRef {
    pub owner_type: String,
    pub owner_id: String,
    pub asset_id: String,
    pub kind: String,
    /// As sent; [`AccountRef::purpose`] is the canonical one.
    pub purpose: Option<String>,
}

impl AccountRef {
    /// `accountPurpose(ref)`: the purpose trimmed, `''` when absent.
    pub fn purpose(&self) -> String {
        js_trim(self.purpose.as_deref().unwrap_or("")).to_owned()
    }
}

/// One entry against one account, as the book recorded it. The sign lives in `direction`, never in `amount`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub tx_id: String,
    pub module: String,
    pub reason: String,
    pub direction: String,
    pub amount: Amount,
    pub posted_at: Instant,
}

/// `HistoryRange`: `from` inclusive, `to` exclusive, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryRange {
    pub from: Instant,
    pub to: Instant,
}

/// `parseHistoryRange`: a window, refusing an inverted one. `from == to` is empty and legal.
pub fn history_range(from: Instant, to: Instant) -> Result<HistoryRange, ReadError> {
    if to.0 < from.0 {
        return Err(refused(
            RANGE_INVALID,
            format!(
                "History window ends before it starts: from {}, to {} — `to` is exclusive and must not precede `from`",
                from.iso(),
                to.iso()
            ),
        ));
    }
    Ok(HistoryRange { from, to })
}

/// `refuseHistoryCursor`: the paged-history field a `history` body names, if any (`after` first). The door refuses it
/// before the schema would strip it, so a page is never answered as if it were the whole window.
pub fn page_socket_field<'a>(keys: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    let keys: Vec<&str> = keys.into_iter().collect();
    ["after", "cursor"].into_iter().find(|f| keys.contains(f))
}

/// `HistoryPageSocketError`.
pub fn page_socket(field: &str) -> ReadError {
    refused(
        PAGE_SOCKET,
        format!(
            "Paged history is a socket — this door refuses '{field}' rather than answering an unpaged window as if it were complete"
        ),
    )
}

/// `PostgresLedger.history`: every entry against one account in `[from, to)`, oldest first by time then entry id. An
/// account nobody has posted to answers `[]`, and the read creates nothing.
pub fn history(
    store: &Store,
    account: &AccountRef,
    range: HistoryRange,
) -> Result<Vec<HistoryEntry>, ReadError> {
    let purpose = account.purpose();
    let found = with_client(store.pool()?, |c| {
        let accounts = c.query(
            "SELECT id::text FROM accounts
              WHERE owner_type = $1::text::owner_type AND owner_id = $2 AND asset_id = $3
                AND kind = $4::text::account_kind AND purpose = $5",
            &[
                &account.owner_type,
                &account.owner_id,
                &account.asset_id,
                &account.kind,
                &purpose,
            ],
        )?;
        let Some(account_id) = accounts.first().map(|r| r.get::<_, String>(0)) else {
            return Ok(None);
        };
        // One row past the cap is the whole detection, and keeps what this process holds bounded.
        let limit = i64::try_from(HISTORY_MAX_ENTRIES + 1).unwrap_or(i64::MAX);
        let rows = c.query(
            &format!(
                "SELECT t.id::text, t.module, t.reason, e.direction::text, e.amount::text, {}
                   FROM ledger_entries e
                   JOIN ledger_tx t ON t.id = e.tx_id
                  WHERE e.account_id = $1::text::uuid
                    AND t.posted_at >= {} AND t.posted_at < {}
                  ORDER BY t.posted_at ASC, e.id ASC
                  LIMIT $4",
                ms("t.posted_at"),
                at("$2"),
                at("$3")
            ),
            &[&account_id, &range.from.0, &range.to.0, &limit],
        )?;
        Ok(Some((account_id, rows)))
    })?;
    let Some((account_id, rows)) = found else {
        return Ok(Vec::new());
    };
    if rows.len() > HISTORY_MAX_ENTRIES {
        return Err(refused(
            RANGE_TOO_LARGE,
            format!(
                "History for account {account_id} between {} and {} exceeds {HISTORY_MAX_ENTRIES} entries — request a narrower window; a truncated history would be indistinguishable from a complete one",
                range.from.iso(),
                range.to.iso()
            ),
        ));
    }
    rows.iter()
        .map(|r| {
            Ok(HistoryEntry {
                tx_id: r.get(0),
                module: r.get(1),
                reason: r.get(2),
                direction: r.get(3),
                amount: stored(&r.get::<_, String>(4), "ledger_entries.amount")?,
                posted_at: Instant(r.get(5)),
            })
        })
        .collect()
}

// ── historyPage ────────────────────────────────────────────────────────────────────────────────────────────────────

/// `historyPageInputSchema`'s output: the scope comes from here alone, never from the cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageInput {
    pub owner_type: String,
    pub owner_id: String,
    pub kind: String,
    pub purpose: Option<String>,
    /// Omitted: every asset the owner holds in that kind.
    pub asset_id: Option<String>,
    pub limit: i64,
    pub cursor: Option<String>,
}

/// One line of a page: the history line, its asset and entry id, and what the book may say about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageEntry {
    pub entry: HistoryEntry,
    pub asset_id: String,
    /// `ledger_entries.id` (bigserial) as a decimal string.
    pub entry_id: String,
    pub rail: Option<String>,
    pub product: Option<String>,
    pub order_id: Option<String>,
    /// On the owner's receiving line of a fill: the trade-fee leg in that asset (0 when none was booked); else none.
    pub fee: Option<Amount>,
    pub withdrawal_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub entries: Vec<PageEntry>,
    /// Passed back as `cursor` for the next (older) page; none on the last.
    pub next_cursor: Option<String>,
}

/// `HistoryCursorInvalidError`.
fn cursor_invalid() -> ReadError {
    refused(
        CURSOR_INVALID,
        "History cursor is not valid — start again without a cursor",
    )
}

/// `encodeHistoryCursor`: base64url of `v2.<entry id>`.
pub fn encode_cursor(entry_id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("v2.{entry_id}"))
}

/// Node's `Buffer.from(text, 'base64url')` on text of the base64url alphabet alone: no padding needed, a dangling last
/// character dropped, trailing bits ignored.
const NODE_BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// `decodeHistoryCursor`: the entry id a cursor this door issued names, from 1 to the largest `bigint`. Anything else is
/// refused, never read as page one.
pub fn decode_cursor(cursor: &str) -> Result<i64, ReadError> {
    if cursor.is_empty()
        || !cursor
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(cursor_invalid());
    }
    let whole = cursor.len() - usize::from(cursor.len() % 4 == 1);
    let bytes = NODE_BASE64URL
        .decode(cursor.get(..whole).unwrap_or(""))
        .map_err(|_| cursor_invalid())?;
    let text = String::from_utf8_lossy(&bytes);
    let digits = text.strip_prefix("v2.").ok_or_else(cursor_invalid)?;
    if digits.is_empty() || digits.len() > 19 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(cursor_invalid());
    }
    match digits.parse::<i64>() {
        Ok(id) if id >= 1 => Ok(id),
        _ => Err(cursor_invalid()),
    }
}

/// `ORDER_ID_PATTERN` and its kin: 1 to `max` characters of `[A-Za-z0-9._-]`.
fn plain_id(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `orderIdFromHoldPurpose`: `order:<id>` to `<id>`; anything that is not a plain id is none.
pub fn order_id_from_hold_purpose(purpose: Option<&str>) -> Option<String> {
    let id = purpose?.strip_prefix("order:")?;
    plain_id(id, 128).then(|| id.to_owned())
}

/// `allowedHistoryWithdrawalId`: a `ledger / withdraw.*` line's own `<withdrawal id>:<attempt>`, else none.
pub fn allowed_withdrawal_id(module: &str, reason: &str, raw: Option<&str>) -> Option<String> {
    if module != "ledger" || !reason.starts_with("withdraw.") {
        return None;
    }
    let raw = raw?;
    let (id, attempt) = raw.rsplit_once(':')?;
    (plain_id(id, 128)
        && (1..=9).contains(&attempt.len())
        && attempt.bytes().all(|b| b.is_ascii_digit()))
    .then(|| raw.to_owned())
}

fn allowed(list: &[&str], raw: Option<String>) -> Option<String> {
    raw.filter(|r| list.contains(&r.as_str()))
}

/// A string-valued key of `ledger_tx.meta`, or none when it is absent or not a string (`typeof raw === 'string'`).
fn meta_text(key: &str) -> String {
    format!("CASE WHEN jsonb_typeof(t.meta -> '{key}') = 'string' THEN t.meta ->> '{key}' END")
}

/// `PostgresLedger.historyPage`: keyset paging on the entry id, each account walked backwards along
/// `ledger_entries_account_idx` (`LIMIT n + 1` per account) and merged; the order and fee lookups run after the page's
/// limit. One row past `limit` says a next page exists.
pub fn history_page(store: &Store, input: &PageInput) -> Result<Page, ReadError> {
    let cursor = input.cursor.as_deref().map(decode_cursor).transpose()?;
    let purpose = js_trim(input.purpose.as_deref().unwrap_or("")).to_owned();
    let limit = input.limit;
    let fill = "('trade.fill', 'trade.fill.mm_maker', 'trade.fill.buyback')";
    let sql = format!(
        "SELECT p.entry_id::text, p.tx_id::text, p.module, p.reason, p.direction::text, p.amount::text, p.asset_id,
                {posted}, p.rail, p.product, p.withdrawal_id,
                o.purpose AS order_purpose, CASE WHEN p.fill_line THEN f.fee END AS fill_fee
           FROM (
             SELECT x.entry_id, t.id AS tx_id, t.module, t.reason, x.direction, x.amount, x.asset_id, t.posted_at,
                    {rail} AS rail, {product} AS product, {withdrawal} AS withdrawal_id,
                    a.id AS account_id, a.owner_type, a.owner_id, a.kind,
                    (t.module = 'trade' AND t.reason IN {fill} AND a.owner_type = 'user'
                      AND a.kind = 'available' AND x.direction = 'debit') AS fill_line
               FROM accounts a
               CROSS JOIN LATERAL (
                 SELECT e.id AS entry_id, e.tx_id, e.direction, e.amount, e.asset_id
                   FROM ledger_entries e
                  WHERE e.account_id = a.id
                    AND ($6::bigint IS NULL OR e.id < $6::bigint)
                  ORDER BY e.id DESC
                  LIMIT $7::bigint + 1
               ) x
               JOIN ledger_tx t ON t.id = x.tx_id
              WHERE a.owner_type = $1::text::owner_type
                AND a.owner_id   = $2
                AND a.kind       = $3::text::account_kind
                AND a.purpose    = $4
                AND ($5::text IS NULL OR a.asset_id = $5::text)
              ORDER BY x.entry_id DESC
              LIMIT $7::bigint + 1
           ) p
           LEFT JOIN LATERAL (
             SELECT h.purpose
               FROM ledger_entries he
               JOIN accounts h ON h.id = he.account_id
              WHERE he.tx_id = p.tx_id
                AND p.module = 'trade'
                AND h.owner_type = p.owner_type
                AND h.owner_id = p.owner_id
                AND h.kind = 'hold'
                AND h.purpose LIKE 'order:%'
                AND (p.kind <> 'hold' OR h.id = p.account_id)
                AND (
                  p.reason IN ('order.hold', 'order.hold.amend', 'order.hold.released')
                  OR (p.reason IN {fill} AND (p.kind = 'hold' OR h.asset_id <> p.asset_id))
                )
              ORDER BY he.id
              LIMIT 1
           ) o ON true
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(fe.amount), 0)::text AS fee
               FROM ledger_entries fe
               JOIN accounts fa ON fa.id = fe.account_id
              WHERE p.fill_line
                AND fe.tx_id = p.tx_id
                AND fe.direction = 'debit'
                AND fa.owner_type = 'house'
                AND fa.owner_id = 'fees:trade'
                AND fa.kind = 'available'
                AND fa.purpose = ''
                AND fa.asset_id = p.asset_id
           ) f ON true
          ORDER BY p.entry_id DESC",
        posted = ms("p.posted_at"),
        rail = meta_text("rail"),
        product = meta_text("product"),
        withdrawal = meta_text("withdrawalId"),
    );
    let params: [&(dyn ToSql + Sync); 7] = [
        &input.owner_type,
        &input.owner_id,
        &input.kind,
        &purpose,
        &input.asset_id,
        &cursor,
        &limit,
    ];
    let rows = with_client(store.pool()?, |c| Ok(c.query(&sql, &params)?))?;
    let page_len = usize::try_from(limit).unwrap_or(0).min(rows.len());
    let mut entries = Vec::with_capacity(page_len);
    for r in rows.iter().take(page_len) {
        let module: String = r.get(2);
        let reason: String = r.get(3);
        let withdrawal: Option<String> = r.get(10);
        let order_purpose: Option<String> = r.get(11);
        let fee: Option<String> = r.get(12);
        entries.push(PageEntry {
            withdrawal_id: allowed_withdrawal_id(&module, &reason, withdrawal.as_deref()),
            entry: HistoryEntry {
                tx_id: r.get(1),
                module,
                reason,
                direction: r.get(4),
                amount: stored(&r.get::<_, String>(5), "ledger_entries.amount")?,
                posted_at: Instant(r.get(7)),
            },
            asset_id: r.get(6),
            entry_id: r.get(0),
            rail: allowed(&HISTORY_RAILS, r.get(8)),
            product: allowed(&HISTORY_PRODUCTS, r.get(9)),
            order_id: order_id_from_hold_purpose(order_purpose.as_deref()),
            fee: fee
                .map(|f| stored(&f, "ledger_entries.amount"))
                .transpose()?,
        });
    }
    let more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    let next_cursor = entries
        .last()
        .filter(|_| more)
        .map(|last| encode_cursor(&last.entry_id));
    Ok(Page {
        entries,
        next_cursor,
    })
}

// ── holdingsHistory ────────────────────────────────────────────────────────────────────────────────────────────────

/// `HoldingsHistoryInput`: a customer or a Space, a start on its bucket's boundary, and the bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldingsInput {
    pub owner_type: String,
    pub owner_id: String,
    pub from: Instant,
    pub bucket_seconds: i64,
}

/// `parseHoldingsHistoryInput`'s checks past the schema: `from` (as `new Date` reads it; none is an invalid date) not
/// ahead of `now_ms`, and on a whole bucket, so no bucket is cut.
pub fn holdings_window(
    from: Option<i64>,
    bucket_seconds: i64,
    now_ms: i64,
) -> Result<Instant, ReadError> {
    if from.is_some_and(|f| f > now_ms) {
        return Err(refused(
            HOLDINGS_WINDOW_INVALID,
            "Holdings history must start in the past",
        ));
    }
    match from {
        Some(f) if bucket_seconds > 0 && f % (bucket_seconds * 1000) == 0 => Ok(Instant(f)),
        _ => Err(refused(
            HOLDINGS_WINDOW_INVALID,
            format!(
                "Holdings history must start on a {bucket_seconds}-second boundary (UTC), so no bucket is cut"
            ),
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub asset_id: String,
    pub amount: Amount,
}

/// What crossed the owner's edge under one asset, reason and bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movement {
    pub asset_id: String,
    pub module: String,
    pub reason: String,
    pub bucket_start: Instant,
    pub inflow: Amount,
    pub outflow: Amount,
    pub fee: Amount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldingsHistory {
    /// The database's clock at the read.
    pub as_of: Instant,
    pub holdings: Vec<Holding>,
    /// Oldest bucket first, then asset, module and reason.
    pub movements: Vec<Movement>,
}

/// `PostgresLedger.holdingsHistory`: every account of the owner (available and every lock) summed per asset, and each
/// transaction since `from` netted over them (a move between two of them is zero) before it is summed per asset, reason
/// and bucket into what came in and what went out. Past `max_rows` rows it refuses instead of answering short.
pub fn holdings_history(
    store: &Store,
    input: &HoldingsInput,
    max_rows: usize,
) -> Result<HoldingsHistory, ReadError> {
    let limit = i64::try_from(max_rows + 1).unwrap_or(i64::MAX);
    let read = transaction(store.pool()?, IsolationLevel::RepeatableRead, |tx| {
        let clock = tx.query_one(&format!("SELECT {}", ms("now()")), &[])?;
        let holdings = tx.query(
            "SELECT asset_id, SUM(balance)::text AS amount
               FROM accounts
              WHERE owner_type = $1::text::owner_type AND owner_id = $2
              GROUP BY asset_id
             HAVING SUM(balance) <> 0
              ORDER BY asset_id",
            &[&input.owner_type, &input.owner_id],
        )?;
        let rows = tx.query(
            &format!(
                "SELECT m.asset_id, m.module, m.reason, m.bucket,
                        m.inflow::text AS inflow, m.outflow::text AS outflow, m.fee::text AS fee
                   FROM (
                     SELECT x.asset_id, x.module, x.reason, x.bucket,
                            SUM(GREATEST(x.net, 0)) AS inflow,
                            SUM(GREATEST(-x.net, 0)) AS outflow,
                            SUM(x.fee) AS fee
                       FROM (
                         SELECT a.asset_id, t.module, t.reason, t.id AS tx_id,
                                (floor(extract(epoch FROM t.posted_at) / $3::bigint) * $3::bigint)::bigint AS bucket,
                                SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END) AS net,
                                COALESCE(SUM(f.fee), 0) AS fee
                           FROM accounts a
                           JOIN ledger_entries e ON e.account_id = a.id
                           JOIN ledger_tx t      ON t.id = e.tx_id
                           LEFT JOIN LATERAL (
                             SELECT SUM(fe.amount) AS fee
                               FROM ledger_entries fe
                               JOIN accounts fa ON fa.id = fe.account_id
                              WHERE t.module = 'trade'
                                AND t.reason IN ('trade.fill', 'trade.fill.mm_maker', 'trade.fill.buyback')
                                AND a.owner_type = 'user'
                                AND a.kind = 'available'
                                AND e.direction = 'debit'
                                AND fe.tx_id = t.id
                                AND fe.direction = 'debit'
                                AND fa.owner_type = 'house'
                                AND fa.owner_id = 'fees:trade'
                                AND fa.kind = 'available'
                                AND fa.purpose = ''
                                AND fa.asset_id = a.asset_id
                           ) f ON true
                          WHERE a.owner_type = $1::text::owner_type
                            AND a.owner_id   = $2
                            AND t.posted_at >= {from}
                          GROUP BY a.asset_id, t.module, t.reason, t.id, t.posted_at
                       ) x
                      GROUP BY x.asset_id, x.module, x.reason, x.bucket
                     HAVING SUM(GREATEST(x.net, 0)) <> 0 OR SUM(GREATEST(-x.net, 0)) <> 0 OR SUM(x.fee) <> 0
                   ) m
                  ORDER BY m.bucket, m.asset_id, m.module, m.reason
                  LIMIT $5",
                from = at("$4")
            ),
            &[&input.owner_type, &input.owner_id, &input.bucket_seconds, &input.from.0, &limit],
        )?;
        Ok((clock.get::<_, i64>(0), holdings, rows))
    })?;
    let (as_of, holdings, rows) = read;
    if rows.len() > max_rows {
        return Err(refused(
            HOLDINGS_TOO_LARGE,
            format!(
                "More than {max_rows} movement rows since {}: ask for a later start or a larger bucket",
                input.from.iso()
            ),
        ));
    }
    Ok(HoldingsHistory {
        as_of: Instant(as_of),
        holdings: holdings
            .iter()
            .map(|h| {
                Ok(Holding {
                    asset_id: h.get(0),
                    amount: stored(&h.get::<_, String>(1), "accounts.balance")?,
                })
            })
            .collect::<Result<_, ReadError>>()?,
        movements: rows
            .iter()
            .map(|r| {
                Ok(Movement {
                    asset_id: r.get(0),
                    module: r.get(1),
                    reason: r.get(2),
                    bucket_start: Instant(r.get::<_, i64>(3).saturating_mul(1000)),
                    inflow: stored(&r.get::<_, String>(4), "ledger_entries.amount")?,
                    outflow: stored(&r.get::<_, String>(5), "ledger_entries.amount")?,
                    fee: stored(&r.get::<_, String>(6), "ledger_entries.amount")?,
                })
            })
            .collect::<Result<_, ReadError>>()?,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_every_other_text_is_refused() {
        assert_eq!(decode_cursor(&encode_cursor("42")).unwrap(), 42);
        assert_eq!(encode_cursor("42"), "djIuNDI");
        let max = "9223372036854775807";
        assert_eq!(decode_cursor(&encode_cursor(max)).unwrap(), i64::MAX);
        for bad in [
            "not-a-cursor!".to_owned(),
            URL_SAFE_NO_PAD.encode("v2.abc"),
            URL_SAFE_NO_PAD.encode("v1.1.1"),
            URL_SAFE_NO_PAD.encode("v2.1'; DROP TABLE accounts;--"),
            URL_SAFE_NO_PAD.encode("v2.99999999999999999999"),
            URL_SAFE_NO_PAD.encode("v2.9223372036854775808"),
            URL_SAFE_NO_PAD.encode("v2.0"),
            URL_SAFE_NO_PAD.encode("v2."),
            String::new(),
        ] {
            assert_eq!(decode_cursor(&bad), Err(cursor_invalid()), "{bad}");
        }
    }

    #[test]
    fn an_order_id_is_read_from_an_order_hold_and_nothing_else() {
        assert_eq!(
            order_id_from_hold_purpose(Some("order:abc-123")).as_deref(),
            Some("abc-123")
        );
        let long = format!("order:{}", "x".repeat(129));
        for bad in [
            "withdraw:abc",
            "order:",
            "order:a b",
            "order:a/b",
            long.as_str(),
            "",
        ] {
            assert_eq!(order_id_from_hold_purpose(Some(bad)), None, "{bad}");
        }
        assert_eq!(order_id_from_hold_purpose(None), None);
    }

    #[test]
    fn a_withdrawal_id_is_echoed_on_its_own_lines_in_its_own_shape() {
        let id = "7a7a7a7a-0000-4000-8000-000000000001:0";
        assert_eq!(
            allowed_withdrawal_id("ledger", "withdraw.held", Some(id)).as_deref(),
            Some(id)
        );
        assert_eq!(
            allowed_withdrawal_id("trade", "withdraw.held", Some(id)),
            None
        );
        assert_eq!(
            allowed_withdrawal_id("ledger", "deposit.credited", Some(id)),
            None
        );
        for bad in ["x", "a:b", "a:1234567890", ":1", "a b:1"] {
            assert_eq!(
                allowed_withdrawal_id("ledger", "withdraw.held", Some(bad)),
                None,
                "{bad}"
            );
        }
    }

    #[test]
    fn the_history_window_is_half_open_and_an_inverted_one_is_refused() {
        assert!(history_range(Instant(5), Instant(5)).is_ok());
        let Err(ReadError::Refused { code, message }) = history_range(Instant(6), Instant(5))
        else {
            panic!("an inverted window answered");
        };
        assert_eq!(code, RANGE_INVALID);
        assert_eq!(
            message,
            "History window ends before it starts: from 1970-01-01T00:00:00.006Z, to 1970-01-01T00:00:00.005Z — `to` is exclusive and must not precede `from`"
        );
        assert_eq!(
            page_socket_field(["account", "cursor", "after"]),
            Some("after")
        );
        assert_eq!(page_socket_field(["cursor"]), Some("cursor"));
        assert_eq!(page_socket_field(["account"]), None);
    }

    #[test]
    fn a_holdings_start_is_in_the_past_and_on_its_bucket() {
        let day = 86_400_000;
        assert_eq!(holdings_window(Some(day), 3_600, 2 * day), Ok(Instant(day)));
        assert!(holdings_window(Some(3 * day), 60, 2 * day).is_err());
        assert!(holdings_window(Some(day + 30_000), 60, 2 * day).is_err());
        assert!(holdings_window(Some(day + 3_600_000), 86_400, 2 * day).is_err());
        assert!(holdings_window(Some(-day), 86_400, 2 * day).is_ok());
        let Err(ReadError::Refused { message, .. }) = holdings_window(None, 300, 0) else {
            panic!("an invalid date answered");
        };
        assert_eq!(
            message,
            "Holdings history must start on a 300-second boundary (UTC), so no bucket is cut"
        );
    }
}
