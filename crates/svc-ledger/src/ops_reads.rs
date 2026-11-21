//! The `ops-reads` slice: the five service doors only svc-ops calls (`s2s-http.ts`). Each is a read: no lock it holds
//! past its own statement, no write, no path into a post.
//!
//! - `feeRevenue` (`ledger/fee-revenue.ts`, `PostgresLedger.feeRevenue`): per venue and asset over a half-open window,
//!   fees earned and returned on the `fees:*` house accounts and what each venue's Collect entries paid us.
//! - `ownFunds` (`ledger/own-funds.ts`, `PostgresLedger.ownFunds`): every house and module account of ours with a
//!   balance, customer money left out, and every own-funds place, in one statement.
//! - `restoreWatermark` (`LedgerService.restoreWatermark`): the chain tip, live or as of the joint restore's cut-off.
//! - `reconciliationEvaluations` (`listReconciliationEvaluations`): finished control runs after a cursor, oldest first.
//! - `transactionsExist` (`ledger/transactions-exist.ts`): which asked transaction ids are booked, ids only.
//!
//! Every failure is a [`Failure`] the door answers through `httpError`: a refusal the caller can fix by its code, and a
//! database error, a stored amount that does not read, or a stored row the contract no longer reads as the ledger's own
//! 500.

use postgres::{GenericClient, IsolationLevel};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::{Outcome as Parsed, Value};
use service_kit::time::{Instant, zod_datetime};

use crate::db::{Store, StoreError, transaction};
use crate::door;
use crate::errors::{self, Failure};

/// `LEDGER_FEE_REVENUE_WINDOW_INVALID`.
pub const FEE_REVENUE_WINDOW_INVALID: &str = "ledger.fee_revenue_window_invalid";
/// `VENUE_BUILDER_FEE_PREFIX`: what a venue owes us in builder fees (`venueBuilderFeeReceivable`).
pub const VENUE_BUILDER_FEE_PREFIX: &str = "venue-builder-fee:";
/// `VENUE_BUILDER_ACCOUNT_PREFIX`: our builder account at a venue, an own-funds place (`venueBuilderAccount`).
pub const VENUE_BUILDER_ACCOUNT_PREFIX: &str = "venue-builder-account:";
/// `BUILDER_FEE_MODULE` (`recipes/builder-fee.ts`).
pub const BUILDER_FEE_MODULE: &str = "trade";
/// `BUILDER_FEE_COLLECT_REASON`: the reason `builderFeeReceive` (Collect) posts under.
pub const BUILDER_FEE_COLLECT_REASON: &str = "trade.builder_fee.received";
/// `MERCHANT_MONEY_PREFIXES` (`custody-layer.ts`): module pots that hold a merchant's own money.
const MERCHANT_MONEY_PREFIXES: [&str; 2] = ["pay:clearing:", "pay:proceeds:"];
/// `OWN_FUNDS_EXCLUDED_MODULE_PREFIXES`: module pots that hold someone else's money.
pub const OWN_FUNDS_EXCLUDED_MODULE_PREFIXES: [&str; 4] = [
    "pay:clearing:",
    "pay:proceeds:",
    "ops:hold-confirm:",
    "campaigns:lock:",
];
/// `OWN_FUNDS_EXCLUDED_HOUSE`: house pots that are not funds of ours.
pub const OWN_FUNDS_EXCLUDED_HOUSE: [&str; 2] = ["burn", "futures-loss"];
/// `OWN_FUNDS_PLACE_PREFIXES` with each place's kind (`PLACE_KIND`).
pub const OWN_FUNDS_PLACES: [(&str, &str); 3] = [
    ("venue-builder-account:", "venue_builder_account"),
    ("partner-reserve:", "partner_reserve"),
    ("treasury-wallet:", "treasury_wallet"),
];
/// `RECONCILIATION_EVALUATION_SETTLE_SECONDS`: a run shows in the feed once it has been finished this long.
pub const RECONCILIATION_EVALUATION_SETTLE_SECONDS: i64 = 30;

/// A timestamp column as `Date#toISOString()` gives it once postgres.js has read it: milliseconds, UTC.
fn iso(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}

/// A database failure past the door: `httpError`'s 500, or a refusal by its own code.
fn store(e: StoreError) -> Failure {
    match e.code {
        Some(code) if code.starts_with("ledger.") => Failure::Ledger {
            code,
            message: e.message,
        },
        _ => Failure::Fault,
    }
}

impl From<StoreError> for Failure {
    fn from(e: StoreError) -> Failure {
        store(e)
    }
}

impl From<postgres::Error> for Failure {
    fn from(_: postgres::Error) -> Failure {
        Failure::Fault
    }
}

/// `parseStoredAmount`: a stored numeric that does not read is the ledger's own fault.
fn stored(text: &str) -> Result<Amount, Failure> {
    parse_amount(text).map_err(|_| Failure::Fault)
}

/// A string field of a parsed input (its schema has already required it).
fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or("")
}

/// A recorded schema run on a value: its output, or the ledger's own 500 (`schema.parse` throwing).
fn contract(name: &str, value: &Json) -> Result<Json, Failure> {
    match door::parse(name, Value::from_json(value)) {
        Ok(Parsed::Ok(out)) => out.to_json().ok_or(Failure::Fault),
        _ => Err(Failure::Fault),
    }
}

// ── feeRevenue ────────────────────────────────────────────────────────────────────────────────────────────────────

/// One venue and asset's fees over the window (`FeeRevenueRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeRevenueRow {
    pub venue_id: Option<String>,
    pub asset_id: String,
    pub earned: Amount,
    pub returned: Amount,
    /// Null exactly when `venue_id` is null.
    pub collected: Option<Amount>,
}

/// `parseFeeRevenueInput` past its schema: the window as instants, refused when it is empty or inverted.
pub fn fee_revenue_window(input: &Value) -> Result<(Instant, Instant), Failure> {
    let at = |k| zod_datetime(text(input, k), true).ok_or(Failure::Fault);
    let (from, to) = (at("from")?, at("to")?);
    if from >= to {
        return Err(Failure::ledger(
            FEE_REVENUE_WINDOW_INVALID,
            "Fee revenue window must start before it ends: `from` is inclusive, `to` is exclusive",
        ));
    }
    Ok((from, to))
}

/// `PostgresLedger.feeRevenue`: the sums run in the database, so nothing is buffered and no row cap clips the answer.
pub fn fee_revenue(
    c: &mut impl GenericClient,
    from: Instant,
    to: Instant,
) -> Result<Vec<FeeRevenueRow>, Failure> {
    let fee_skip = VENUE_BUILDER_FEE_PREFIX.len() + 1;
    let account_skip = VENUE_BUILDER_ACCOUNT_PREFIX.len() + 1;
    let sql = format!(
        "WITH fee_legs AS (
           SELECT e.tx_id, a.asset_id, e.direction, e.amount
             FROM ledger_entries e
             JOIN accounts a   ON a.id = e.account_id
             JOIN ledger_tx t  ON t.id = e.tx_id
            WHERE a.owner_type = 'house'::owner_type
              AND a.kind       = 'available'::account_kind
              AND a.purpose    = ''
              AND a.owner_id LIKE 'fees:%'
              AND t.posted_at >= $1::text::timestamptz
              AND t.posted_at <  $2::text::timestamptz
         ),
         fee_venue AS (
           SELECT e.tx_id, MIN(substr(a.owner_id, {fee_skip})) AS venue_id
             FROM ledger_entries e
             JOIN accounts a ON a.id = e.account_id
            WHERE e.tx_id IN (SELECT tx_id FROM fee_legs)
              AND a.owner_type = 'treasury'::owner_type
              AND starts_with(a.owner_id, $3::text)
            GROUP BY e.tx_id
         ),
         earned AS (
           SELECT v.venue_id, f.asset_id,
                  COALESCE(SUM(f.amount) FILTER (WHERE f.direction = 'debit'), 0)  AS earned,
                  COALESCE(SUM(f.amount) FILTER (WHERE f.direction = 'credit'), 0) AS returned
             FROM fee_legs f
             LEFT JOIN fee_venue v ON v.tx_id = f.tx_id
            GROUP BY v.venue_id, f.asset_id
         ),
         collected AS (
           SELECT substr(a.owner_id, {account_skip}) AS venue_id, a.asset_id, SUM(e.amount) AS collected
             FROM ledger_entries e
             JOIN accounts a  ON a.id = e.account_id
             JOIN ledger_tx t ON t.id = e.tx_id
            WHERE a.owner_type = 'treasury'::owner_type
              AND starts_with(a.owner_id, $4::text)
              AND e.direction = 'credit'
              AND t.module    = $5::text
              AND t.reason    = $6::text
              AND t.posted_at >= $1::text::timestamptz
              AND t.posted_at <  $2::text::timestamptz
            GROUP BY 1, 2
         )
         SELECT COALESCE(e.venue_id, c.venue_id) AS venue_id,
                COALESCE(e.asset_id, c.asset_id) AS asset_id,
                COALESCE(e.earned, 0)::text      AS earned,
                COALESCE(e.returned, 0)::text    AS returned,
                c.collected::text                AS collected
           FROM earned e
           FULL OUTER JOIN collected c ON c.venue_id = e.venue_id AND c.asset_id = e.asset_id
          ORDER BY 2, 1 NULLS FIRST"
    );
    let rows = c.query(
        &sql,
        &[
            &from.iso(),
            &to.iso(),
            &VENUE_BUILDER_FEE_PREFIX,
            &VENUE_BUILDER_ACCOUNT_PREFIX,
            &BUILDER_FEE_MODULE,
            &BUILDER_FEE_COLLECT_REASON,
        ],
    )?;
    rows.iter()
        .map(|r| {
            let venue_id: Option<String> = r.try_get(0)?;
            let collected: Option<String> = r.try_get(4)?;
            Ok(FeeRevenueRow {
                // A venue's fee with no Collect in the window is "0", the ledger's answer; a fee of our own has none.
                collected: match &venue_id {
                    None => None,
                    Some(_) => Some(stored(collected.as_deref().unwrap_or("0"))?),
                },
                venue_id,
                asset_id: r.try_get(1)?,
                earned: stored(&r.try_get::<_, String>(2)?)?,
                returned: stored(&r.try_get::<_, String>(3)?)?,
            })
        })
        .collect()
}

/// `serializeFeeRevenue`.
pub fn fee_revenue_reply(from: Instant, to: Instant, rows: &[FeeRevenueRow]) -> Json {
    let assets = rows
        .iter()
        .map(|r| {
            Json::obj([
                (
                    "venueId",
                    r.venue_id.clone().map_or(Json::Null, Json::String),
                ),
                ("assetId", Json::str(r.asset_id.clone())),
                ("earned", Json::str(format_amount(r.earned))),
                ("returned", Json::str(format_amount(r.returned))),
                ("net", Json::str(format_amount(r.earned - r.returned))),
                (
                    "collected",
                    r.collected
                        .map_or(Json::Null, |c| Json::str(format_amount(c))),
                ),
            ])
        })
        .collect();
    Json::obj([
        ("from", Json::str(from.iso())),
        ("to", Json::str(to.iso())),
        ("assets", Json::Array(assets)),
    ])
}

// ── ownFunds ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// One house or module account with a balance (`OwnFundsRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnFundsRow {
    pub owner_type: String,
    pub owner_id: String,
    pub asset_id: String,
    pub kind: String,
    pub purpose: String,
    pub balance: Amount,
}

/// One own-funds place as the ledger reads it (`OwnFundsPlaceRow`): zero or below; the negative is ours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnFundsPlaceRow {
    pub owner_id: String,
    pub asset_id: String,
    pub balance: Amount,
}

/// What `ownFunds` read, in one snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnFunds {
    /// `asOf.toISOString()`: the database clock at the same statement.
    pub as_of: String,
    pub rows: Vec<OwnFundsRow>,
    pub places: Vec<OwnFundsPlaceRow>,
}

/// `isCustomerBalanceAccount` (`custody-layer.ts`): an account that holds a customer's money in our book.
pub fn is_customer_balance_account(owner_type: &str, owner_id: &str) -> bool {
    match owner_type {
        "user" | "subaccount" => true,
        "module" => MERCHANT_MONEY_PREFIXES
            .iter()
            .any(|p| owner_id.starts_with(p)),
        _ => false,
    }
}

/// `excludedFromOwnFunds`: an account the own-funds read must never count.
pub fn excluded_from_own_funds(owner_type: &str, owner_id: &str) -> bool {
    if is_customer_balance_account(owner_type, owner_id) {
        return true;
    }
    if owner_type == "house" {
        return OWN_FUNDS_EXCLUDED_HOUSE.contains(&owner_id);
    }
    OWN_FUNDS_EXCLUDED_MODULE_PREFIXES
        .iter()
        .any(|p| owner_id.starts_with(p))
}

/// `PostgresLedger.ownFunds`: one statement, so the balances and the places are one snapshot.
pub fn own_funds(c: &mut impl GenericClient) -> Result<OwnFunds, Failure> {
    let modules: Vec<String> = OWN_FUNDS_EXCLUDED_MODULE_PREFIXES
        .iter()
        .map(|p| format!("{p}%"))
        .collect();
    let places: Vec<String> = OWN_FUNDS_PLACES
        .iter()
        .map(|(p, _)| format!("{p}%"))
        .collect();
    let house: Vec<String> = OWN_FUNDS_EXCLUDED_HOUSE
        .iter()
        .map(|h| (*h).to_owned())
        .collect();
    let now = iso("now()");
    let rows = c.query(
        &format!(
            "SELECT a.owner_type::text AS owner_type, a.owner_id, a.asset_id, a.kind::text AS kind, a.purpose,
                    a.balance::text AS balance, {now} AS now
               FROM accounts a
              WHERE (
                      a.balance > 0
                      AND (
                        (a.owner_type = 'house'::owner_type AND a.owner_id <> ALL($1::text[]))
                        OR (a.owner_type = 'module'::owner_type AND NOT (a.owner_id LIKE ANY($2::text[])))
                      )
                    )
                 OR (a.owner_type = 'treasury'::owner_type AND a.owner_id LIKE ANY($3::text[]))
              ORDER BY a.asset_id, a.owner_type::text, a.owner_id, a.kind::text, a.purpose"
        ),
        &[&house, &modules, &places],
    )?;
    let as_of: String = match rows.first() {
        Some(r) => r.try_get(6)?,
        None => c.query_one(&format!("SELECT {now}"), &[])?.try_get(0)?,
    };
    let mut out = OwnFunds {
        as_of,
        rows: Vec::new(),
        places: Vec::new(),
    };
    for r in &rows {
        let owner_type: String = r.try_get(0)?;
        let balance = stored(&r.try_get::<_, String>(5)?)?;
        if owner_type == "treasury" {
            out.places.push(OwnFundsPlaceRow {
                owner_id: r.try_get(1)?,
                asset_id: r.try_get(2)?,
                balance,
            });
        } else {
            out.rows.push(OwnFundsRow {
                owner_type,
                owner_id: r.try_get(1)?,
                asset_id: r.try_get(2)?,
                kind: r.try_get(3)?,
                purpose: r.try_get(4)?,
                balance,
            });
        }
    }
    Ok(out)
}

/// `placeOf`: the place a row is, by its prefix, with what the book shows of ours there; a row that is not a place,
/// shows less than nothing of ours or names no place is refused (`OwnFundsPlaceRowError`, the ledger's own 500).
pub fn place_of(r: &OwnFundsPlaceRow) -> Result<Json, Failure> {
    let Some((prefix, kind)) = OWN_FUNDS_PLACES
        .iter()
        .find(|(p, _)| r.owner_id.starts_with(p))
    else {
        return Err(Failure::Fault);
    };
    if r.balance > 0 {
        return Err(Failure::Fault);
    }
    let place_id = r.owner_id.get(prefix.len()..).unwrap_or("");
    if place_id.is_empty() {
        return Err(Failure::Fault);
    }
    Ok(Json::obj([
        ("kind", Json::str(*kind)),
        ("placeId", Json::str(place_id)),
        ("assetId", Json::str(r.asset_id.clone())),
        ("held", Json::str(format_amount(-r.balance))),
    ]))
}

/// `serializeOwnFunds`: every row is checked again with the custody switch's own split, so a query that drifted from it
/// refuses (`OwnFundsCustomerRowError`) rather than count customer money as ours.
pub fn own_funds_reply(read: &OwnFunds) -> Result<Json, Failure> {
    if read
        .rows
        .iter()
        .any(|r| excluded_from_own_funds(&r.owner_type, &r.owner_id))
    {
        return Err(Failure::Fault);
    }
    let accounts = read
        .rows
        .iter()
        .filter(|r| r.balance > 0)
        .map(|r| {
            Json::obj([
                ("ownerType", Json::str(r.owner_type.clone())),
                ("ownerId", Json::str(r.owner_id.clone())),
                ("assetId", Json::str(r.asset_id.clone())),
                ("kind", Json::str(r.kind.clone())),
                ("purpose", Json::str(r.purpose.clone())),
                ("balance", Json::str(format_amount(r.balance))),
            ])
        })
        .collect();
    let places = read.places.iter().map(place_of).collect::<Result<_, _>>()?;
    Ok(Json::obj([
        ("asOf", Json::str(read.as_of.clone())),
        ("accounts", Json::Array(accounts)),
        ("places", Json::Array(places)),
    ]))
}

// ── restoreWatermark ──────────────────────────────────────────────────────────────────────────────────────────────

/// Where the ledger stands, or stood (`position`, `integrity`, `lastWriteAt`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Watermark {
    pub position: String,
    pub integrity: Option<String>,
    pub last_write_at: Option<String>,
}

/// `LedgerService.restoreWatermark`'s input: no body, `null` or `{}` is the live read; exactly `{ asOf }` is the read as
/// of the cut-off. Anything else (a bare string, an array, other keys) is refused, never answered live.
pub fn restore_as_of(body: Option<&Json>) -> Result<Option<String>, Failure> {
    let refused = || {
        Failure::ledger(
            errors::RESTORE_ASOF_INVALID,
            "restore watermark: send {} or { asOf } with one instant and its offset",
        )
    };
    match body {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Object(fields)) if fields.is_empty() => Ok(None),
        Some(object @ Json::Object(_)) => {
            match door::parse("restoreWatermark", Value::from_json(object)) {
                Ok(Parsed::Ok(input)) => Ok(Some(text(&input, "asOf").to_owned())),
                _ => Err(refused()),
            }
        }
        Some(_) => Err(refused()),
    }
}

/// `chain_tip is missing`: the ledger is not initialised.
fn uninitialised() -> Failure {
    Failure::ledger(
        "ledger.uninitialised",
        "chain_tip is missing: the ledger is not initialised",
    )
}

/// `PostgresLedger.restoreWatermark`: the chain tip's `seq` and hash, and the newest `posted_at`. No lock, no write.
pub fn restore_watermark(c: &mut impl GenericClient) -> Result<Watermark, Failure> {
    let tips = c.query(
        "SELECT seq::text AS seq, hash FROM chain_tip WHERE id = true",
        &[],
    )?;
    let tip = tips.first().ok_or_else(uninitialised)?;
    let last = c.query_one(
        &format!("SELECT {} FROM ledger_tx", iso("MAX(posted_at)")),
        &[],
    )?;
    Ok(Watermark {
        position: tip.try_get(0)?,
        integrity: tip.try_get(1)?,
        last_write_at: last.try_get(0)?,
    })
}

/// `PostgresLedger.restoreWatermarkAsOf`: once the database clock is more than the skew bound past `as_of`, no post can
/// still land at or before it. `FOR SHARE` on the tip waits out a post in flight and is released before the reads, so no
/// post waits on them; the position is the chain prefix posted at or before the cut-off (0, the genesis tip, when none
/// was). A blank bound refuses `ledger.skew_bound_unset`; a cut-off not yet that far past refuses
/// `ledger.restore_asof_unanswerable`.
pub fn restore_watermark_as_of(
    store: &Store,
    as_of: Instant,
    bound_ms: Option<i64>,
) -> Result<Watermark, Failure> {
    let Some(bound) = bound_ms else {
        return Err(Failure::ledger(
            errors::SKEW_BOUND_UNSET,
            "the clock skew bound is unset, so no position can be fixed as of an instant",
        ));
    };
    let pool = store.pool()?;
    let now: Option<i64> = transaction(pool, IsolationLevel::ReadCommitted, |tx| {
        let rows = tx.query(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::int8 AS now FROM chain_tip WHERE id = true FOR SHARE",
            &[],
        )?;
        rows.first()
            .map(|r| r.try_get(0))
            .transpose()
            .map_err(StoreError::from)
    })?;
    let now = now.ok_or_else(uninitialised)?;
    if now - as_of.0 <= bound {
        return Err(Failure::ledger(
            errors::RESTORE_ASOF_UNANSWERABLE,
            format!(
                "the cut-off is not yet more than the clock skew bound ({bound} ms) in the past, so a post could still land at it"
            ),
        ));
    }
    let at = read(store, |c| {
        Ok(c.query_one(
            &format!(
                "WITH cut AS (
                   SELECT COALESCE(
                            (SELECT MAX(seq) FROM ledger_tx
                              WHERE seq < COALESCE((SELECT MIN(seq) FROM ledger_tx WHERE posted_at > $1::text::timestamptz),
                                                   9223372036854775807)),
                            0
                          ) AS seq
                 )
                 SELECT cut.seq::text AS seq,
                        (SELECT hash FROM ledger_tx WHERE ledger_tx.seq = cut.seq) AS hash,
                        (SELECT {} FROM ledger_tx) AS last
                   FROM cut",
                iso("MAX(posted_at)")
            ),
            &[&as_of.iso()],
        )?)
    })?;
    let position: Option<String> = at.try_get(0)?;
    Ok(Watermark {
        position: position.unwrap_or_else(|| "0".to_owned()),
        integrity: at.try_get(1)?,
        last_write_at: at.try_get(2)?,
    })
}

/// `restoreWatermark`'s reply (`RestoreWatermarkRead`); `asOf` is echoed as asked, and absent on a live read.
pub fn restore_reply(at: &Watermark, read_at: Instant, as_of: Option<&str>) -> Json {
    let mut o = vec![
        ("service".to_owned(), Json::str("ledger")),
        ("kind".to_owned(), Json::str("chain_tip.seq")),
        ("position".to_owned(), Json::str(at.position.clone())),
        (
            "integrity".to_owned(),
            at.integrity.clone().map_or(Json::Null, Json::String),
        ),
        (
            "lastWriteAt".to_owned(),
            at.last_write_at.clone().map_or(Json::Null, Json::String),
        ),
        ("readAt".to_owned(), Json::str(read_at.iso())),
    ];
    if let Some(a) = as_of {
        o.push(("asOf".to_owned(), Json::str(a)));
    }
    Json::Object(o)
}

// ── reconciliationEvaluations ─────────────────────────────────────────────────────────────────────────────────────

/// `comparedOf`: how many asset figures had both sides known.
fn compared_of(assets: &[Json]) -> i64 {
    let unset = |a: &Json, k| matches!(a.get(k), Some(Json::String(s)) if s == "unset");
    let count = assets
        .iter()
        .filter(|a| a.get("missing").is_none() && !unset(a, "expected") && !unset(a, "difference"))
        .count();
    i64::try_from(count).unwrap_or(i64::MAX)
}

/// `{ status: 'set', value }`, or `{ status: 'unset' }`.
fn set_or_unset(value: Option<String>) -> Json {
    match value {
        Some(v) => Json::obj([("status", Json::str("set")), ("value", Json::String(v))]),
        None => Json::obj([("status", Json::str("unset"))]),
    }
}

/// A stored jsonb column, read as text: postgres.js hands the parsed value over.
fn jsonb(r: &postgres::Row, i: usize) -> Result<Json, Failure> {
    let t: String = r.try_get(i)?;
    json::parse(&t).map_err(|_| Failure::Fault)
}

/// `toRun` without its account list: the stored run as `controls.runs` shows it, checked against
/// `reconciliationControlRunSchema`, which also gives it its keys in the contract's order.
fn evaluated_run(r: &postgres::Row) -> Result<Json, Failure> {
    let evidence = jsonb(r, 9)?;
    let list = |k| match evidence.get(k) {
        Some(Json::Null) | None => Json::Array(Vec::new()),
        Some(v) => v.clone(),
    };
    let assets = list("assets");
    let compared = match evidence.get("compared") {
        Some(Json::Null) | None => Json::int(match &assets {
            Json::Array(a) => compared_of(a),
            _ => 0,
        }),
        Some(v) => v.clone(),
    };
    let nonblank = |i| -> Result<Option<String>, Failure> {
        let s: String = r.try_get(i)?;
        Ok(Some(s).filter(|s| !s.is_empty()))
    };
    let margin: String = r.try_get(7)?;
    let mut run = vec![
        ("id".to_owned(), Json::str(r.try_get::<_, String>(0)?)),
        (
            "controlId".to_owned(),
            Json::str(r.try_get::<_, String>(1)?),
        ),
        ("status".to_owned(), Json::str(r.try_get::<_, String>(2)?)),
        ("phase".to_owned(), set_or_unset(nonblank(3)?)),
        ("errorCode".to_owned(), set_or_unset(nonblank(4)?)),
        ("asOf".to_owned(), Json::str(r.try_get::<_, String>(5)?)),
        ("readAt".to_owned(), Json::str(r.try_get::<_, String>(6)?)),
        (
            "margin".to_owned(),
            set_or_unset(Some(margin).filter(|m| m != "unset")),
        ),
        ("sources".to_owned(), jsonb(r, 8)?),
        (
            "outsideSide".to_owned(),
            Json::str(r.try_get::<_, String>(10)?),
        ),
        (
            "periodStart".to_owned(),
            Json::str(r.try_get::<_, String>(11)?),
        ),
        (
            "periodEnd".to_owned(),
            Json::str(r.try_get::<_, String>(12)?),
        ),
        ("accounts".to_owned(), list("accounts")),
        ("assets".to_owned(), assets),
        ("compared".to_owned(), compared),
    ];
    match evidence.get("reconcilingItems") {
        None | Some(Json::Null | Json::Bool(false)) => {}
        Some(items) => run.push(("reconcilingItems".to_owned(), items.clone())),
    }
    let Json::Object(fields) = contract("controlRun", &Json::Object(run))? else {
        return Err(Failure::Fault);
    };
    Ok(Json::Object(
        fields
            .into_iter()
            .filter(|(k, _)| k != "accounts")
            .collect(),
    ))
}

/// `listReconciliationEvaluations` past its input check: finished runs that have settled, after the cursor, oldest
/// first. The cursor carries microseconds, as Postgres stores them, bound as text, so the last row is never handed back.
pub fn reconciliation_evaluations(
    c: &mut impl GenericClient,
    input: &Value,
) -> Result<Json, Failure> {
    let after = input.get("after");
    let limit = input.get("limit").as_number().ok_or(Failure::Fault)?;
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the schema holds the limit to a whole number from 1 to 500"
    )]
    let limit = limit as i64;
    let cursor = match after {
        Value::Object(_) => Some((
            text(after, "finishedAt").to_owned(),
            text(after, "id").to_owned(),
        )),
        _ => None,
    };
    let columns = format!(
        "r.id::text, r.control_id::text, r.status, r.phase, r.error_code, {}, {}, r.margin, r.sources::text,
         r.evidence::text, r.outside_side, {}, {},
         to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS finished_iso,
         c.severity",
        iso("r.as_of"),
        iso("r.read_at"),
        iso("r.period_start"),
        iso("r.period_end"),
    );
    let head = format!(
        "SELECT {columns}
           FROM reconciliation_control_runs r
           JOIN reconciliation_controls c ON c.id = r.control_id
          WHERE r.status <> 'started'
            AND r.finished_at IS NOT NULL
            AND r.finished_at <= clock_timestamp() - make_interval(secs => {RECONCILIATION_EVALUATION_SETTLE_SECONDS})"
    );
    let tail = "ORDER BY r.finished_at ASC, r.id ASC LIMIT $1";
    let rows = match &cursor {
        Some((finished_at, id)) => c.query(
            &format!(
                "{head} AND (r.finished_at, r.id) > ($2::text::timestamptz, $3::text::uuid) {tail}"
            ),
            &[&limit, finished_at, id],
        )?,
        None => c.query(&format!("{head} {tail}"), &[&limit])?,
    };
    let mut evaluations = Vec::new();
    for r in &rows {
        let severity: Option<String> = r.try_get(14)?;
        evaluations.push(Json::obj([
            ("run", evaluated_run(r)?),
            ("finishedAt", Json::str(r.try_get::<_, String>(13)?)),
            ("severity", set_or_unset(severity)),
        ]));
    }
    let next = match rows.last() {
        Some(last) => Json::obj([
            ("finishedAt", Json::str(last.try_get::<_, String>(13)?)),
            ("id", Json::str(last.try_get::<_, String>(0)?)),
        ]),
        None => after.to_json().unwrap_or(Json::Null),
    };
    contract(
        "evaluationFeed",
        &Json::obj([("evaluations", Json::Array(evaluations)), ("next", next)]),
    )
}

// ── transactionsExist ─────────────────────────────────────────────────────────────────────────────────────────────

/// `transactionsExist` past its input check: the asked ids that name a booked transaction, lower-cased, in the order
/// asked, each once.
pub fn transactions_exist(c: &mut impl GenericClient, input: &Value) -> Result<Json, Failure> {
    let mut asked: Vec<String> = Vec::new();
    for id in input.get("txIds").as_array().unwrap_or(&[]) {
        let id = id.as_str().unwrap_or("").to_lowercase();
        if !asked.contains(&id) {
            asked.push(id);
        }
    }
    let rows = c.query(
        "SELECT id::text AS id FROM ledger_tx WHERE id = ANY($1::text[]::uuid[])",
        &[&asked],
    )?;
    let booked = rows
        .iter()
        .map(|r| r.try_get::<_, String>(0))
        .collect::<Result<Vec<_>, _>>()?;
    let found = asked
        .into_iter()
        .filter(|id| booked.contains(id))
        .map(Json::String)
        .collect();
    Ok(Json::obj([("found", Json::Array(found))]))
}

// ── The doors ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// One read on a connection of the pool; a pool or connection failure is the ledger's own 500.
fn read<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, Failure>,
) -> Result<T, Failure> {
    let pool = store.pool()?;
    let mut conn = pool.get().map_err(StoreError::from)?;
    let client = conn.client().map_err(StoreError::from)?;
    f(client)
}

/// One `ops-reads` door, past `authenticate` and its first input check: `input` is what that check returned, `body` the
/// body as the handler got it (`restoreWatermark` and `ownFunds` have no first check).
pub fn answer(
    door: &str,
    store: &Store,
    input: &Value,
    body: Option<&Json>,
    clock_skew_bound_ms: Option<i64>,
    now_ms: fn() -> i64,
) -> Result<Json, Failure> {
    match door {
        "feeRevenue" => {
            let (from, to) = fee_revenue_window(input)?;
            let rows = read(store, |c| fee_revenue(c, from, to))?;
            Ok(fee_revenue_reply(from, to, &rows))
        }
        "ownFunds" => own_funds_reply(&read(store, own_funds)?),
        "restoreWatermark" => {
            let as_of = restore_as_of(body)?;
            let at = match &as_of {
                None => read(store, restore_watermark)?,
                Some(a) => {
                    let instant = zod_datetime(a, true).ok_or(Failure::Fault)?;
                    restore_watermark_as_of(store, instant, clock_skew_bound_ms)?
                }
            };
            Ok(restore_reply(&at, Instant(now_ms()), as_of.as_deref()))
        }
        "reconciliationEvaluations" => read(store, |c| reconciliation_evaluations(c, input)),
        "transactionsExist" => read(store, |c| transactions_exist(c, input)),
        _ => Err(Failure::Fault),
    }
}
