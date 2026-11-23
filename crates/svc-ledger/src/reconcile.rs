//! Reconciliation (`services/svc-ledger/src/ledger/reconcile.ts`, and `service.ts`'s `reconcile`): the proof that the
//! book is whole, read from one REPEATABLE READ snapshot, and what a run writes.
//!
//! The proof's checks, each catching what the others cannot:
//! - **balances**: every `accounts.balance` against a replay of its `ledger_entries` (a bug in posting);
//! - **chain**: every hash recomputed from its predecessor, each row's posted-key claim, and `chain_tip` naming the last
//!   row by sequence and hash (tampering, even by someone with database access);
//! - **totals**: every asset nets to zero across all accounts (value made or destroyed by any route);
//! - **customer balances**: with the custodial layer off, every customer account is at zero (customer money on our
//!   book by a route the per-post refusal and the static scan missed). With it on this reads nothing.
//!
//! A stored amount that cannot be read as `numeric(38,18)` (NaN, or a sum past the column) is corruption: a mismatch,
//! never an unfinished proof. Any other failure is incomplete: one does not freeze; the tick freezes after N in a row.
//!
//! The run (`runSnapshotReconciliation`) holds its own connection and takes no `chain_tip` lock: posts go on while it
//! reads, and are not part of its verdict. One run at a time across every replica and the operator door, by an
//! advisory lock keyed on the schema. Outcomes:
//! - `ok`: the snapshot's balances are copied to a session temp table inside the snapshot, then written to
//!   `balance_snapshots` with the `ok` run row in a short READ COMMITTED transaction (an FK check inside the snapshot
//!   would fail with 40001 on a live book);
//! - `mismatch`: a finished not-ok proof, or proven corruption thrown before the proof returned ok. Its run row and
//!   the posting freeze commit together; the caller freezes again if that commit failed;
//! - `incomplete`: everything else, recorded best effort on a fresh transaction;
//! - `skipped`: another run holds the lock. Nothing is read or written.

use postgres::{Client, GenericClient, IsolationLevel, NoTls};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, format_difference, parse_amount};
use service_kit::time::Instant;

use crate::chain::{HashEntry, HashTx, hash_tx};
use crate::db::{Store, StoreError, transaction, with_client};
use crate::freeze::{self, Command, FREEZE_ATTRIBUTED};
use crate::status::RECONCILE_ACTOR;

/// `RECONCILE_MISMATCH_REASON`.
pub const RECONCILE_MISMATCH_REASON: &str = "reconciliation mismatch";
/// `DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS`, and its bounds.
pub const DEFAULT_STATEMENT_TIMEOUT_MS: i64 = 600_000;
const MIN_STATEMENT_TIMEOUT_MS: i64 = 1_000;
const MAX_STATEMENT_TIMEOUT_MS: i64 = 3_600_000;
/// `verifyChain`'s page.
pub const CHAIN_BATCH: i64 = 1000;
/// `RECONCILE_LOCK_SQL`: the single-flight key. Advisory locks are per database, so the key carries the schema.
pub const RECONCILE_LOCK_SQL: &str = "hashtext('ledger.reconcile:' || current_schema())::bigint";
/// The session temp table the proof's balances are staged in.
const STAGING_TABLE: &str = "reconcile_snapshot_balances";
/// `CorruptReconcileAmountError`'s code.
pub const PERSISTED_AMOUNT_CORRUPT: &str = "ledger.persisted_amount_corrupt";
/// `CorruptChainTipError`'s code.
pub const CHAIN_TIP_CORRUPT: &str = "ledger.chain_tip_corrupt";
/// `ledger.reconcile_in_progress`: another run holds the single-flight lock.
pub const RECONCILE_IN_PROGRESS: &str = "ledger.reconcile_in_progress";
/// `ledger.reconcile_incomplete`: the proof could not reach a verdict.
pub const RECONCILE_INCOMPLETE: &str = "ledger.reconcile_incomplete";
/// `ReconcileFreezeFailedError`'s code: a mismatch was found and the freeze after it did not land.
pub const RECONCILE_FREEZE_FAILED: &str = "ledger.reconcile_freeze_failed";

/// `LEDGER_CUSTODY_LAYER`: the switch the proof checks customer balances against. Only `on` and `off` exist, so a
/// missing or unknown switch cannot reach the proof (the TypeScript refuses one with a `TypeError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustodyLayer {
    On,
    Off,
}

impl CustodyLayer {
    pub fn from_on(on: bool) -> CustodyLayer {
        if on {
            CustodyLayer::On
        } else {
            CustodyLayer::Off
        }
    }
}

/// Why a check did not return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProofError {
    /// `CorruptReconcileAmountError`: a stored amount in this field cannot be read as `numeric(38,18)`.
    Corrupt(String),
    /// `CorruptChainTipError`: `chain_tip` arrived as something other than text.
    ChainTipCorrupt,
    /// Anything else: the database's error, a connection's, or the proof's own.
    Failed(StoreError),
}

impl From<StoreError> for ProofError {
    fn from(e: StoreError) -> ProofError {
        ProofError::Failed(e)
    }
}

impl From<postgres::Error> for ProofError {
    fn from(e: postgres::Error) -> ProofError {
        ProofError::Failed(store_error(&e))
    }
}

impl ProofError {
    /// `reconcileErrorCode(error)`: the error's code, cut to 64, or `unknown`.
    pub fn code(&self) -> String {
        let code = match self {
            ProofError::Corrupt(_) => Some(PERSISTED_AMOUNT_CORRUPT),
            ProofError::ChainTipCorrupt => Some(CHAIN_TIP_CORRUPT),
            ProofError::Failed(e) => e.code.as_deref(),
        };
        match code.filter(|c| !c.is_empty()) {
            Some(c) => c.chars().take(64).collect(),
            None => "unknown".to_owned(),
        }
    }

    pub fn message(&self) -> String {
        match self {
            ProofError::Corrupt(field) => format!("stored amount in {field} cannot be parsed"),
            ProofError::ChainTipCorrupt => {
                "chain_tip arrived as a non-text value — refusing to anchor a snapshot on it"
                    .to_owned()
            }
            ProofError::Failed(e) => e.message.clone(),
        }
    }

    /// `isProvenReconcileCorruption`: the only thrown errors that freeze at once.
    pub fn is_corruption(&self) -> bool {
        matches!(self, ProofError::Corrupt(_) | ProofError::ChainTipCorrupt)
    }
}

/// A driver error as the TypeScript records it: the server's SQLSTATE, else the socket's errno name as Node names it.
pub fn store_error(e: &postgres::Error) -> StoreError {
    let mut out = StoreError::from(e);
    if out.code.is_none() {
        out.code = node_code(e).map(str::to_owned);
    }
    out
}

fn node_code(e: &postgres::Error) -> Option<&'static str> {
    use std::error::Error as _;
    let mut source = e.source();
    while let Some(s) = source {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            return match io.kind() {
                std::io::ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
                std::io::ErrorKind::ConnectionReset => Some("ECONNRESET"),
                std::io::ErrorKind::TimedOut => Some("ETIMEDOUT"),
                std::io::ErrorKind::BrokenPipe => Some("EPIPE"),
                std::io::ErrorKind::HostUnreachable => Some("EHOSTUNREACH"),
                std::io::ErrorKind::NetworkUnreachable => Some("ENETUNREACH"),
                _ => None,
            };
        }
        source = s.source();
    }
    None
}

/// `parseReconcileAmount`: a stored amount, or corruption naming its field.
fn amount(text: Option<&str>, field: &str) -> Result<Amount, ProofError> {
    text.and_then(|t| parse_amount(t).ok())
        .ok_or_else(|| ProofError::Corrupt(field.to_owned()))
}

/// One account whose cached balance is not its replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Drift {
    pub account_id: String,
    pub asset_id: String,
    pub cached: String,
    pub replayed: String,
    pub difference: String,
}

/// `ReconcileResult`: `ok` exactly when no drift was found (a check that did not finish reads not ok, with none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balances {
    pub ok: bool,
    pub drift: Vec<Drift>,
    pub accounts_checked: i64,
}

/// `ChainResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chain {
    Ok { length: i64 },
    Broken { broken_at: String, length: i64 },
}

impl Chain {
    pub fn ok(&self) -> bool {
        matches!(self, Chain::Ok { .. })
    }
    pub fn length(&self) -> i64 {
        match self {
            Chain::Ok { length } | Chain::Broken { length, .. } => *length,
        }
    }
    pub fn broken_at(&self) -> Option<&str> {
        match self {
            Chain::Ok { .. } => None,
            Chain::Broken { broken_at, .. } => Some(broken_at),
        }
    }
}

/// `CustomerBalanceHit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomerHit {
    pub account_id: String,
    pub asset_id: String,
    pub balance: String,
}

/// `CustomerBalanceCheck`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustomerCheck {
    On,
    Off {
        ok: bool,
        accounts_checked: i64,
        open: Vec<CustomerHit>,
    },
}

/// `ReconciliationReport['result']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofWord {
    Matched,
    NothingToCompare,
    Mismatch,
}

impl ProofWord {
    pub fn as_str(self) -> &'static str {
        match self {
            ProofWord::Matched => "matched",
            ProofWord::NothingToCompare => "nothing_to_compare",
            ProofWord::Mismatch => "mismatch",
        }
    }
}

/// A check that did not finish in a mismatch report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unfinished {
    pub check: &'static str,
    pub error_code: String,
}

/// `ReconciliationReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub ok: bool,
    pub ran_at_ms: i64,
    pub balances: Balances,
    pub chain: Chain,
    /// Each asset's total across every account, as the database grouped them.
    pub totals: Vec<(String, String)>,
    /// Assets that do not net to zero: the most serious failure there is.
    pub unbalanced_assets: Vec<String>,
    pub result: ProofWord,
    /// Left out by a proof seam that does not run it.
    pub customer_balances: Option<CustomerCheck>,
    pub incomplete_checks: Vec<Unfinished>,
    pub corrupt_amount_fields: Vec<String>,
}

impl Report {
    /// `openCustomerBalances(report)`.
    pub fn open_customer_balances(&self) -> Option<usize> {
        match &self.customer_balances {
            Some(CustomerCheck::Off { open, .. }) => Some(open.len()),
            _ => None,
        }
    }

    /// The report as the TypeScript logs it.
    pub fn json(&self) -> Json {
        let drift = self
            .balances
            .drift
            .iter()
            .map(|d| {
                Json::obj([
                    ("accountId", Json::str(d.account_id.clone())),
                    ("assetId", Json::str(d.asset_id.clone())),
                    ("cached", Json::str(d.cached.clone())),
                    ("replayed", Json::str(d.replayed.clone())),
                    ("difference", Json::str(d.difference.clone())),
                ])
            })
            .collect();
        let mut balances = vec![("ok".to_owned(), Json::Bool(self.balances.ok))];
        if !self.balances.ok {
            balances.push(("drift".to_owned(), Json::Array(drift)));
        }
        balances.push((
            "accountsChecked".to_owned(),
            Json::int(self.balances.accounts_checked),
        ));
        let mut chain = vec![("ok".to_owned(), Json::Bool(self.chain.ok()))];
        if let Some(at) = self.chain.broken_at() {
            chain.push(("brokenAt".to_owned(), Json::str(at)));
        }
        chain.push(("length".to_owned(), Json::int(self.chain.length())));
        let mut o = vec![
            ("ok".to_owned(), Json::Bool(self.ok)),
            ("ranAt".to_owned(), Json::str(Instant(self.ran_at_ms).iso())),
            ("balances".to_owned(), Json::Object(balances)),
            ("chain".to_owned(), Json::Object(chain)),
            (
                "totals".to_owned(),
                Json::Object(
                    self.totals
                        .iter()
                        .map(|(a, t)| (a.clone(), Json::str(t.clone())))
                        .collect(),
                ),
            ),
            (
                "unbalancedAssets".to_owned(),
                Json::Array(
                    self.unbalanced_assets
                        .iter()
                        .map(|a| Json::str(a.clone()))
                        .collect(),
                ),
            ),
            ("result".to_owned(), Json::str(self.result.as_str())),
        ];
        if let Some(c) = &self.customer_balances {
            o.push(("customerBalances".to_owned(), customer_json(c)));
        }
        if !self.incomplete_checks.is_empty() {
            o.push((
                "incompleteChecks".to_owned(),
                unfinished_json(&self.incomplete_checks),
            ));
        }
        if !self.corrupt_amount_fields.is_empty() {
            o.push((
                "corruptAmountFields".to_owned(),
                strings(&self.corrupt_amount_fields),
            ));
        }
        Json::Object(o)
    }
}

fn strings(items: &[String]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(s.clone())).collect())
}

fn unfinished_json(items: &[Unfinished]) -> Json {
    Json::Array(
        items
            .iter()
            .map(|u| {
                Json::obj([
                    ("check", Json::str(u.check)),
                    ("errorCode", Json::str(u.error_code.clone())),
                ])
            })
            .collect(),
    )
}

fn customer_json(c: &CustomerCheck) -> Json {
    match c {
        CustomerCheck::On => Json::obj([("custodyLayer", Json::str("on"))]),
        CustomerCheck::Off {
            ok,
            accounts_checked,
            open,
        } => Json::obj([
            ("custodyLayer", Json::str("off")),
            ("ok", Json::Bool(*ok)),
            ("accountsChecked", Json::int(*accounts_checked)),
            (
                "open",
                Json::Array(
                    open.iter()
                        .map(|h| {
                            Json::obj([
                                ("accountId", Json::str(h.account_id.clone())),
                                ("assetId", Json::str(h.asset_id.clone())),
                                ("balance", Json::str(h.balance.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
    }
}

fn count(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// `reconcileBalances`: one pass in the database, every account against the replay of its entries.
pub fn reconcile_balances(c: &mut impl GenericClient) -> Result<Balances, ProofError> {
    let rows = c.query(
        "SELECT a.id::text, a.asset_id, a.balance::text,
                COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END), 0)::text
           FROM ledger.accounts a
           LEFT JOIN ledger.ledger_entries e ON e.account_id = a.id
          GROUP BY a.id, a.asset_id, a.balance",
        &[],
    )?;
    let mut drift = Vec::new();
    for row in &rows {
        let cached = amount(row.try_get(2)?, "accounts.balance")?;
        let replayed = amount(row.try_get(3)?, "ledger_entries.amount")?;
        if cached != replayed {
            drift.push(Drift {
                account_id: row.try_get(0)?,
                asset_id: row.try_get(1)?,
                cached: format_amount(cached),
                replayed: format_amount(replayed),
                difference: format_difference(cached, replayed),
            });
        }
    }
    Ok(Balances {
        ok: drift.is_empty(),
        drift,
        accounts_checked: count(rows.len()),
    })
}

/// One `ledger_tx` row as the chain proof reads it.
struct TxRow {
    id: String,
    seq: String,
    module: String,
    reason: String,
    /// `new Date(posted_at)` in milliseconds; none for an instant that is not finite.
    posted_at_ms: Option<i64>,
    hash: String,
    previous_hash: Option<String>,
    claim_matches: bool,
}

/// `verifyChain`, page by page. The first page's query is its own step so [`run_reconciliation`] can issue its
/// statements in the order the TypeScript's pipelined checks reach the one connection: balances, the chain's first
/// page, totals, customer balances, then the rest of the chain. A failed statement aborts the snapshot for every
/// statement after it, so the order decides which checks finish.
pub struct ChainWalk<'a> {
    batch: i64,
    as_of: Option<&'a str>,
    previous: Option<String>,
    last_id: Option<String>,
    after_seq: String,
    length: i64,
    page: Option<Vec<TxRow>>,
}

impl<'a> ChainWalk<'a> {
    /// A walk of `batch` rows a page; with `as_of` (an instant `timestamptz` reads), the prefix committed by then.
    pub fn new(batch: i64, as_of: Option<&'a str>) -> ChainWalk<'a> {
        ChainWalk {
            batch,
            as_of,
            previous: None,
            last_id: None,
            after_seq: "0".to_owned(),
            length: 0,
            page: None,
        }
    }

    fn fetch(&mut self, c: &mut impl GenericClient) -> Result<(), ProofError> {
        let rows = c.query(
            "SELECT t.id::text, t.seq::text, t.module, t.reason,
                    CASE WHEN isfinite(t.posted_at) THEN floor(extract(epoch FROM t.posted_at) * 1000)::bigint END,
                    t.hash, t.previous_hash,
                    (k.idempotency_key IS NOT DISTINCT FROM t.idempotency_key
                     AND k.posted_hash IS NOT DISTINCT FROM t.hash
                     AND k.posted_meta IS NOT DISTINCT FROM t.meta)
               FROM ledger.ledger_tx t
               LEFT JOIN ledger.ledger_posted_keys k ON k.tx_id = t.id
              WHERE t.seq > $1::text::bigint
                AND ($2::text IS NULL OR t.posted_at <= $2::text::timestamptz)
              ORDER BY t.seq ASC
              LIMIT $3",
            &[&self.after_seq, &self.as_of, &self.batch],
        )?;
        let mut page = Vec::with_capacity(rows.len());
        for r in &rows {
            page.push(TxRow {
                id: r.try_get(0)?,
                seq: r.try_get(1)?,
                module: r.try_get(2)?,
                reason: r.try_get(3)?,
                posted_at_ms: r.try_get(4)?,
                hash: r.try_get(5)?,
                previous_hash: r.try_get(6)?,
                claim_matches: r.try_get::<_, Option<bool>>(7)?.unwrap_or(false),
            });
        }
        self.page = Some(page);
        Ok(())
    }

    /// The first page's query, alone.
    pub fn start(&mut self, c: &mut impl GenericClient) -> Result<(), ProofError> {
        self.fetch(c)
    }

    fn broken(&self, at: &str) -> Chain {
        Chain::Broken {
            broken_at: at.to_owned(),
            length: self.length,
        }
    }

    /// The rest of the walk, then the tip.
    pub fn finish(mut self, c: &mut impl GenericClient) -> Result<Chain, ProofError> {
        loop {
            let txs = match self.page.take() {
                Some(p) => p,
                None => {
                    self.fetch(c)?;
                    self.page.take().unwrap_or_default()
                }
            };
            if txs.is_empty() {
                break;
            }
            // One read for the page's entries.
            let ids: Vec<&str> = txs.iter().map(|t| t.id.as_str()).collect();
            let entries = c.query(
                "SELECT tx_id::text, account_id::text, asset_id, direction::text, amount::text, balance_after::text
                   FROM ledger.ledger_entries
                  WHERE tx_id = ANY($1::text[]::uuid[])
                  ORDER BY id ASC",
                &[&ids],
            )?;
            for tx in &txs {
                let mut parsed = Vec::new();
                let mut readable = tx.posted_at_ms.is_some();
                for e in entries
                    .iter()
                    .filter(|e| e.try_get::<_, &str>(0).ok() == Some(&tx.id))
                {
                    let account: &str = e.try_get(1)?;
                    let asset: &str = e.try_get(2)?;
                    let direction: &str = e.try_get(3)?;
                    // A row that cannot be parsed is a broken link, not an unfinished proof.
                    let value = amount(e.try_get(4)?, "ledger_entries.amount");
                    let after = amount(e.try_get(5)?, "ledger_entries.balance_after");
                    match (value, after) {
                        (Ok(v), Ok(_)) => parsed.push(HashEntry {
                            account_id: account,
                            asset_id: asset,
                            direction,
                            amount: v,
                        }),
                        _ => readable = false,
                    }
                }
                if !readable || !tx.claim_matches {
                    return Ok(self.broken(&tx.id));
                }
                let recomputed = hash_tx(
                    &HashTx {
                        id: &tx.id,
                        module: &tx.module,
                        reason: &tx.reason,
                        posted_at_ms: tx.posted_at_ms.unwrap_or_default(),
                        entries: &parsed,
                    },
                    self.previous.as_deref(),
                );
                if recomputed.as_deref() != Some(tx.hash.as_str())
                    || tx.previous_hash != self.previous
                {
                    return Ok(self.broken(&tx.id));
                }
                self.previous = Some(tx.hash.clone());
                self.last_id = Some(tx.id.clone());
                self.after_seq.clone_from(&tx.seq);
                self.length += 1;
            }
        }
        let last = self
            .last_id
            .clone()
            .unwrap_or_else(|| "chain_tip".to_owned());
        // A past instant proves the prefix committed by then; later rows must still link to it.
        if let Some(as_of) = self.as_of {
            let later = c.query(
                "SELECT previous_hash FROM ledger.ledger_tx WHERE posted_at > $1::text::timestamptz ORDER BY seq ASC LIMIT 1",
                &[&as_of],
            )?;
            if let Some(row) = later.first() {
                let linked: Option<String> = row.try_get(0)?;
                if linked != self.previous {
                    return Ok(self.broken(&last));
                }
                return Ok(Chain::Ok {
                    length: self.length,
                });
            }
        }
        // The singleton tip names the last row by both sequence and hash.
        let tip = c.query(
            "SELECT hash, seq::text FROM ledger.chain_tip WHERE id = true",
            &[],
        )?;
        let named = match tip.first() {
            Some(r) => {
                let hash: Option<String> = r.try_get(0)?;
                let seq: String = r.try_get(1)?;
                hash == self.previous && seq == self.after_seq
            }
            None => false,
        };
        if !named {
            return Ok(self.broken(&last));
        }
        Ok(Chain::Ok {
            length: self.length,
        })
    }
}

/// `verifyChain(sql, batchSize, asOf)`.
pub fn verify_chain(
    c: &mut impl GenericClient,
    batch: i64,
    as_of: Option<&str>,
) -> Result<Chain, ProofError> {
    let mut walk = ChainWalk::new(batch, as_of);
    walk.start(c)?;
    walk.finish(c)
}

/// `MERCHANT_MONEY_PREFIXES`: module accounts that hold a merchant's own money.
const MERCHANT_MONEY_PREFIXES: [&str; 2] = ["pay:clearing:", "pay:proceeds:"];

/// `isCustomerBalanceAccount`: every account a person or their sub-account owns, and a merchant's clearing and
/// proceeds pots. INTAFACED's own pots are not.
pub fn is_customer_balance_account(owner_type: &str, owner_id: &str) -> bool {
    match owner_type {
        "user" | "subaccount" => true,
        "module" => MERCHANT_MONEY_PREFIXES
            .iter()
            .any(|p| owner_id.starts_with(p)),
        _ => false,
    }
}

/// `customerBalancesWhileCustodyOff`: every account is read and the filter alone decides, so a customer owner kind
/// named there later is covered the day it is named.
pub fn customer_balances(
    c: &mut impl GenericClient,
    custody: CustodyLayer,
) -> Result<CustomerCheck, ProofError> {
    if custody == CustodyLayer::On {
        return Ok(CustomerCheck::On);
    }
    let rows = c.query(
        "SELECT id::text, asset_id, owner_type::text, owner_id, balance::text FROM ledger.accounts ORDER BY id ASC",
        &[],
    )?;
    let mut open = Vec::new();
    let mut checked = 0;
    for row in &rows {
        if !is_customer_balance_account(row.try_get(2)?, row.try_get(3)?) {
            continue;
        }
        checked += 1;
        let balance = amount(row.try_get(4)?, "accounts.balance")?;
        if balance != Amount::ZERO {
            open.push(CustomerHit {
                account_id: row.try_get(0)?,
                asset_id: row.try_get(1)?,
                balance: format_amount(balance),
            });
        }
    }
    Ok(CustomerCheck::Off {
        ok: open.is_empty(),
        accounts_checked: checked,
        open,
    })
}

/// `totalsByAsset`: each asset summed across every account.
pub fn totals_by_asset(c: &mut impl GenericClient) -> Result<Vec<(String, String)>, ProofError> {
    let rows = c.query(
        "SELECT asset_id, COALESCE(SUM(balance), 0)::text FROM ledger.accounts GROUP BY asset_id",
        &[],
    )?;
    rows.iter()
        .map(|r| {
            Ok((
                r.try_get(0)?,
                format_amount(amount(r.try_get(1)?, "accounts.balance")?),
            ))
        })
        .collect()
}

/// `proofResult(report)`: a not-ok report or one with an unfinished check is a mismatch; an ok proof that read no
/// account and no transaction has nothing to compare. Only the rest is matched.
pub fn proof_result(ok: bool, balances: &Balances, chain: &Chain, unfinished: usize) -> ProofWord {
    if !ok || unfinished > 0 {
        return ProofWord::Mismatch;
    }
    if balances.accounts_checked == 0 && chain.length() == 0 {
        ProofWord::NothingToCompare
    } else {
        ProofWord::Matched
    }
}

/// `runReconciliation(sql, custodyLayer)`: every check, each settled on its own. A finished mismatch stands even when a
/// sibling failed; with no mismatch, the first check that failed is the run's error (a clean partial proof never
/// turns a timeout into a verdict).
pub fn run_reconciliation(
    c: &mut impl GenericClient,
    custody: CustodyLayer,
    now_ms: fn() -> i64,
) -> Result<Report, ProofError> {
    let balance_check = reconcile_balances(c);
    let mut walk = ChainWalk::new(CHAIN_BATCH, None);
    let started = walk.start(c);
    let total_check = totals_by_asset(c);
    let customer_check = customer_balances(c, custody);
    let chain_check = started.and_then(|()| walk.finish(c));

    let balances = balance_check.clone().unwrap_or(Balances {
        ok: false,
        drift: Vec::new(),
        accounts_checked: 0,
    });
    let chain = chain_check.clone().unwrap_or(Chain::Broken {
        broken_at: "incomplete".to_owned(),
        length: 0,
    });
    let totals = total_check.clone().unwrap_or_default();
    let unbalanced_assets: Vec<String> = totals
        .iter()
        .filter(|(_, t)| t != "0")
        .map(|(a, _)| a.clone())
        .collect();
    let customer = customer_check.clone().ok();
    let customer_open = matches!(customer, Some(CustomerCheck::Off { ok: false, .. }));
    let mut incomplete = Vec::new();
    let mut corrupt = Vec::new();
    let failures = [
        ("balances", balance_check.as_ref().err()),
        ("chain", chain_check.as_ref().err()),
        ("totals", total_check.as_ref().err()),
        ("customer_balances", customer_check.as_ref().err()),
    ];
    for (check, failed) in failures.iter() {
        match failed {
            Some(ProofError::Corrupt(field)) => corrupt.push(field.clone()),
            Some(e) => incomplete.push(Unfinished {
                check,
                error_code: e.code(),
            }),
            None => {}
        }
    }
    let mismatch = matches!(&balance_check, Ok(b) if !b.ok)
        || matches!(&chain_check, Ok(c) if !c.ok())
        || !unbalanced_assets.is_empty()
        || customer_open
        || !corrupt.is_empty();
    if !mismatch && let Some((_, Some(e))) = failures.iter().find(|(_, f)| f.is_some()) {
        return Err((*e).clone());
    }
    let ok = !mismatch;
    Ok(Report {
        ok,
        ran_at_ms: now_ms(),
        result: proof_result(ok, &balances, &chain, incomplete.len()),
        balances,
        chain,
        totals,
        unbalanced_assets,
        customer_balances: customer,
        incomplete_checks: incomplete,
        corrupt_amount_fields: corrupt,
    })
}

/// `validReconcileStatementTimeoutMs`: a bounded integer, since `SET LOCAL` takes no bind parameter.
pub fn valid_statement_timeout_ms(value: i64) -> Result<i64, String> {
    if (MIN_STATEMENT_TIMEOUT_MS..=MAX_STATEMENT_TIMEOUT_MS).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "reconcile statement timeout must be an integer between {MIN_STATEMENT_TIMEOUT_MS} and {MAX_STATEMENT_TIMEOUT_MS} ms"
        ))
    }
}

/// `ReconciledTip`: what the snapshot covered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tip {
    pub seq: String,
    pub hash: Option<String>,
    /// The highest `ledger_entries.id` the snapshot sees; none on a book with no entries.
    pub through_entry_id: Option<String>,
    /// When the snapshot was taken, by the database clock, in milliseconds.
    pub snapshot_at_ms: i64,
}

/// Where an unfinished run stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Start,
    Tip,
    Proof,
    Snapshot,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Start => "start",
            Phase::Tip => "tip",
            Phase::Proof => "proof",
            Phase::Snapshot => "snapshot",
        }
    }
}

/// `SnapshotRun`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotRun {
    /// Another run holds the single-flight lock. Nothing was read or written.
    Skipped,
    Ok {
        report: Report,
        tip: Tip,
        run_id: String,
    },
    Mismatch {
        report: Report,
        tip: Option<Tip>,
        /// None when the run row itself could not be written; the verdict still stands.
        run_id: Option<String>,
        record_error: Option<String>,
    },
    Incomplete {
        phase: Phase,
        error: ProofError,
        error_code: String,
        /// None when even the incomplete row could not be written.
        run_id: Option<String>,
        record_error: Option<String>,
    },
}

/// The proof a run executes inside its snapshot: [`run_reconciliation`] in production, another in a test that must act
/// mid-proof.
pub type Prove<'a> = &'a (dyn Fn(&mut Client) -> Result<Report, ProofError> + Sync);

/// `SnapshotRunOptions`.
pub struct SnapshotOptions<'a> {
    /// Per-run `statement_timeout`, checked before it reaches SQL.
    pub statement_timeout_ms: i64,
    pub custody: CustodyLayer,
    /// The wall clock in milliseconds (`new Date()`).
    pub now_ms: fn() -> i64,
    pub prove: Option<Prove<'a>>,
    /// A failure to open the proof's connection, given instead of opening it (a test seam: phase `start`).
    pub reserve_failure: Option<ProofError>,
}

/// A run row.
struct RunRow<'a> {
    started_at_ms: i64,
    outcome: &'static str,
    tip: Option<&'a Tip>,
    error_code: Option<String>,
    detail: Json,
}

fn insert_run_row(c: &mut impl GenericClient, row: &RunRow<'_>) -> Result<String, StoreError> {
    let started = Instant(row.started_at_ms).iso();
    let seq = row.tip.map(|t| t.seq.clone());
    let entry = row.tip.and_then(|t| t.through_entry_id.clone());
    let hash = row.tip.and_then(|t| t.hash.clone());
    let detail = row.detail.compact();
    let r = c
        .query_one(
            "INSERT INTO ledger.reconcile_runs
                    (started_at, outcome, kind, through_seq, through_entry_id, tip_hash, error_code, detail)
             VALUES ($1::text::timestamptz, $2, 'full', $3::text::bigint, $4::text, $5::text, $6::text, $7::text::jsonb)
             RETURNING id::text",
            &[
                &started,
                &row.outcome,
                &seq,
                &entry,
                &hash,
                &row.error_code,
                &detail,
            ],
        )
        .map_err(|e| store_error(&e))?;
    Ok(r.try_get(0)?)
}

/// `freezeMismatch`: the halt, in the caller's transaction. An operator freeze already standing is left standing.
fn freeze_mismatch(c: &mut impl GenericClient) -> Result<(), StoreError> {
    match freeze::write_in(
        c,
        Command::Freeze {
            reason: RECONCILE_MISMATCH_REASON,
            actor: RECONCILE_ACTOR,
        },
    ) {
        Ok(_) => Ok(()),
        Err(e) if e.code.as_deref() == Some(FREEZE_ATTRIBUTED) => Ok(()),
        Err(e) => Err(e),
    }
}

/// `recordAfterRollback`: best effort, on a fresh short transaction; a mismatch commits its halt with its row.
fn record_after_rollback(store: &Store, row: &RunRow<'_>) -> (Option<String>, Option<String>) {
    let out = store.pool().and_then(|pool| {
        if row.outcome == "mismatch" {
            transaction(pool, IsolationLevel::ReadCommitted, |tx| {
                freeze_mismatch(tx)?;
                insert_run_row(tx, row)
            })
        } else {
            with_client(pool, |c| insert_run_row(c, row))
        }
    });
    match out {
        Ok(id) => (Some(id), None),
        Err(e) => (None, Some(e.message)),
    }
}

/// `boundedMessage`.
fn bounded(message: &str) -> String {
    if message.chars().count() > 500 {
        format!("{}…", message.chars().take(500).collect::<String>())
    } else {
        message.to_owned()
    }
}

/// `reportDetail`: counts and the first break only.
fn report_detail(r: &Report) -> Vec<(String, Json)> {
    let off = match &r.customer_balances {
        Some(CustomerCheck::Off {
            accounts_checked,
            open,
            ..
        }) => Some((accounts_checked, open)),
        _ => None,
    };
    let first_drift = if r.balances.ok {
        Json::Null
    } else {
        r.balances
            .drift
            .first()
            .map_or(Json::Null, |d| Json::str(d.account_id.clone()))
    };
    vec![
        (
            "accountsChecked".to_owned(),
            Json::int(r.balances.accounts_checked),
        ),
        (
            "driftCount".to_owned(),
            Json::int(if r.balances.ok {
                0
            } else {
                count(r.balances.drift.len())
            }),
        ),
        ("firstDriftAccountId".to_owned(), first_drift),
        ("chainOk".to_owned(), Json::Bool(r.chain.ok())),
        ("chainLength".to_owned(), Json::int(r.chain.length())),
        (
            "chainBrokenAt".to_owned(),
            r.chain.broken_at().map_or(Json::Null, Json::str),
        ),
        ("unbalancedAssets".to_owned(), strings(&r.unbalanced_assets)),
        ("result".to_owned(), Json::str(r.result.as_str())),
        (
            "customerBalancesChecked".to_owned(),
            off.map_or(Json::Null, |(n, _)| Json::int(*n)),
        ),
        (
            "customerBalancesOpen".to_owned(),
            off.map_or(Json::Null, |(_, o)| Json::int(count(o.len()))),
        ),
        (
            "firstCustomerBalanceAccountId".to_owned(),
            off.and_then(|(_, o)| o.first())
                .map_or(Json::Null, |h| Json::str(h.account_id.clone())),
        ),
        (
            "incompleteChecks".to_owned(),
            unfinished_json(&r.incomplete_checks),
        ),
        (
            "corruptAmountFields".to_owned(),
            strings(&r.corrupt_amount_fields),
        ),
    ]
}

/// `failedProofReport`: a proof that threw before it could say the book was consistent. No numeric drift.
fn failed_proof_report(now_ms: i64) -> Report {
    Report {
        ok: false,
        ran_at_ms: now_ms,
        balances: Balances {
            ok: false,
            drift: Vec::new(),
            accounts_checked: 0,
        },
        chain: Chain::Broken {
            broken_at: "proof".to_owned(),
            length: 0,
        },
        totals: Vec::new(),
        unbalanced_assets: Vec::new(),
        result: ProofWord::Mismatch,
        customer_balances: None,
        incomplete_checks: Vec::new(),
        corrupt_amount_fields: Vec::new(),
    }
}

/// `recordIncomplete`.
fn record_incomplete(
    store: &Store,
    started_at_ms: i64,
    error: ProofError,
    phase: Phase,
    tip: Option<&Tip>,
) -> SnapshotRun {
    let error_code = error.code();
    let (run_id, record_error) = record_after_rollback(
        store,
        &RunRow {
            started_at_ms,
            outcome: "incomplete",
            tip,
            error_code: Some(error_code.clone()),
            detail: Json::obj([
                ("phase", Json::str(phase.as_str())),
                ("message", Json::str(bounded(&error.message()))),
            ]),
        },
    );
    SnapshotRun::Incomplete {
        phase,
        error,
        error_code,
        run_id,
        record_error,
    }
}

/// `recordFailedProof`: proven corruption thrown before the proof returned ok, on the mismatch path.
fn record_failed_proof(
    store: &Store,
    started_at_ms: i64,
    now_ms: i64,
    error: &ProofError,
    phase: Phase,
    tip: Option<Tip>,
) -> SnapshotRun {
    let (run_id, record_error) = record_after_rollback(
        store,
        &RunRow {
            started_at_ms,
            outcome: "mismatch",
            tip: tip.as_ref(),
            error_code: Some(error.code()),
            detail: Json::obj([
                ("phase", Json::str(phase.as_str())),
                ("message", Json::str(bounded(&error.message()))),
                ("failedProof", Json::Bool(true)),
            ]),
        },
    );
    SnapshotRun::Mismatch {
        report: failed_proof_report(now_ms),
        tip,
        run_id,
        record_error: Some(record_error.unwrap_or_else(|| error.message())),
    }
}

/// The proof's connection, its transaction and its lock, as the run holds them.
struct Session {
    conn: Client,
    open: bool,
    locked: bool,
    timeout_ms: i64,
}

impl Session {
    fn sql(&mut self, statement: &str) -> Result<(), ProofError> {
        self.conn.batch_execute(statement).map_err(ProofError::from)
    }

    fn begin(&mut self, isolation: &str) -> Result<(), ProofError> {
        self.sql(&format!("BEGIN ISOLATION LEVEL {isolation} READ WRITE"))?;
        self.open = true;
        // The value is a checked integer; SET takes no bind parameter. The same bound for both transactions.
        let timeout = self.timeout_ms;
        self.sql(&format!("SET LOCAL statement_timeout = {timeout}"))
    }

    fn commit(&mut self) -> Result<(), ProofError> {
        self.sql("COMMIT")?;
        self.open = false;
        Ok(())
    }

    /// Roll back what is open, release the lock, and close the session (which drops its temp table and any lock left).
    fn end(mut self) {
        if self.open {
            let _ = self.conn.batch_execute("ROLLBACK");
        }
        if self.locked {
            let _ = self
                .conn
                .batch_execute(&format!("SELECT pg_advisory_unlock({RECONCILE_LOCK_SQL})"));
        }
        let _ = self.conn.close();
    }
}

/// What the run learned before it failed.
struct Learned {
    phase: Phase,
    tip: Option<Tip>,
    verdict: Option<Report>,
}

/// `runSnapshotReconciliation(sql, options)`: prove the book from one snapshot and write the verdict. Refuses a
/// statement timeout outside its bounds before anything is read.
pub fn run_snapshot(store: &Store, options: &SnapshotOptions<'_>) -> Result<SnapshotRun, String> {
    let timeout_ms = valid_statement_timeout_ms(options.statement_timeout_ms)?;
    let started_at_ms = (options.now_ms)();
    let opened = match &options.reserve_failure {
        Some(e) => Err(e.clone()),
        None => store
            .pool()
            .map_err(ProofError::from)
            .and_then(|pool| Client::connect(pool.url(), NoTls).map_err(ProofError::from)),
    };
    let conn = match opened {
        Ok(c) => c,
        Err(e) if e.is_corruption() => {
            return Ok(record_failed_proof(
                store,
                started_at_ms,
                (options.now_ms)(),
                &e,
                Phase::Start,
                None,
            ));
        }
        Err(e) => {
            return Ok(record_incomplete(
                store,
                started_at_ms,
                e,
                Phase::Start,
                None,
            ));
        }
    };
    let mut session = Session {
        conn,
        open: false,
        locked: false,
        timeout_ms,
    };
    let mut learned = Learned {
        phase: Phase::Start,
        tip: None,
        verdict: None,
    };
    let out = prove_in(&mut session, &mut learned, options, started_at_ms);
    session.end();
    Ok(match out {
        Ok(run) => run,
        Err(error) => settle_failure(store, options, started_at_ms, learned, error),
    })
}

/// A run that threw after it began: what it had learned decides what is recorded.
fn settle_failure(
    store: &Store,
    options: &SnapshotOptions<'_>,
    started_at_ms: i64,
    learned: Learned,
    error: ProofError,
) -> SnapshotRun {
    match learned.verdict {
        // The proof finished and found a break; only recording it failed. The caller still freezes.
        Some(report) if !report.ok => {
            let mut detail = report_detail(&report);
            detail.push(("recordedAfterRollback".to_owned(), Json::Bool(true)));
            let (run_id, _) = record_after_rollback(
                store,
                &RunRow {
                    started_at_ms,
                    outcome: "mismatch",
                    tip: learned.tip.as_ref(),
                    error_code: None,
                    detail: Json::Object(detail),
                },
            );
            SnapshotRun::Mismatch {
                report,
                tip: learned.tip,
                run_id,
                record_error: Some(error.message()),
            }
        }
        // The proof already returned ok: a later failure, the snapshot write included, is unfinished work.
        Some(_) => record_incomplete(
            store,
            started_at_ms,
            error,
            learned.phase,
            learned.tip.as_ref(),
        ),
        None if error.is_corruption() => record_failed_proof(
            store,
            started_at_ms,
            (options.now_ms)(),
            &error,
            learned.phase,
            learned.tip,
        ),
        None => record_incomplete(
            store,
            started_at_ms,
            error,
            learned.phase,
            learned.tip.as_ref(),
        ),
    }
}

fn prove_in(
    s: &mut Session,
    learned: &mut Learned,
    options: &SnapshotOptions<'_>,
    started_at_ms: i64,
) -> Result<SnapshotRun, ProofError> {
    s.begin("REPEATABLE READ")?;
    // The first snapshot-taking statement: from here every read sees one commit prefix.
    s.locked = true;
    let gate = s.conn.query_one(
        &format!(
            "SELECT pg_try_advisory_lock({RECONCILE_LOCK_SQL}),
                    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint"
        ),
        &[],
    )?;
    let got: bool = gate.try_get(0).map_err(|e| store_error(&e))?;
    if !got {
        s.locked = false;
        s.sql("ROLLBACK")?;
        s.open = false;
        return Ok(SnapshotRun::Skipped);
    }
    let snapshot_at_ms: i64 = gate.try_get(1).map_err(|e| store_error(&e))?;

    learned.phase = Phase::Tip;
    let rows = s.conn.query(
        "SELECT t.hash, t.seq::text, (SELECT max(id)::text FROM ledger.ledger_entries)
           FROM ledger.chain_tip t
          WHERE t.id = true",
        &[],
    )?;
    let tip = match rows.first() {
        Some(r) => Some(Tip {
            // A hash column that is not text is a corrupt tip, not an unfinished read.
            hash: r.try_get(0).map_err(|_| ProofError::ChainTipCorrupt)?,
            seq: r.try_get(1).map_err(|_| ProofError::ChainTipCorrupt)?,
            through_entry_id: r.try_get(2).map_err(|e| store_error(&e))?,
            snapshot_at_ms,
        }),
        None => None,
    };
    learned.tip.clone_from(&tip);

    learned.phase = Phase::Proof;
    let proved = match options.prove {
        Some(prove) => prove(&mut s.conn)?,
        None => run_reconciliation(&mut s.conn, options.custody, options.now_ms)?,
    };
    // A finished read showing no singleton tip is structural corruption, not an interrupted proof.
    let report = if tip.is_some() {
        proved
    } else {
        Report {
            ok: false,
            chain: Chain::Broken {
                broken_at: "chain_tip".to_owned(),
                length: proved.chain.length(),
            },
            result: ProofWord::Mismatch,
            ..proved
        }
    };
    learned.verdict = Some(report.clone());

    if !report.ok {
        // No snapshot rows: writing a drifted cache as an anchor would heal the break as success.
        s.commit()?;
        s.begin("READ COMMITTED")?;
        freeze_mismatch(&mut s.conn)?;
        let run_id = insert_run_row(
            &mut s.conn,
            &RunRow {
                started_at_ms,
                outcome: "mismatch",
                tip: tip.as_ref(),
                error_code: None,
                detail: Json::Object(report_detail(&report)),
            },
        )?;
        s.commit()?;
        return Ok(SnapshotRun::Mismatch {
            report,
            tip,
            run_id: Some(run_id),
            record_error: None,
        });
    }

    let Some(tip) = tip else {
        return Err(ProofError::Failed(StoreError::new(
            "verified reconciliation has no tip",
            None,
        )));
    };
    learned.phase = Phase::Snapshot;
    // Still inside the proof's snapshot: these are the balances the proof just checked.
    s.sql(&format!("DROP TABLE IF EXISTS pg_temp.{STAGING_TABLE}"))?;
    s.sql(&format!(
        "CREATE TEMP TABLE {STAGING_TABLE} ON COMMIT PRESERVE ROWS AS SELECT id AS account_id, balance FROM ledger.accounts"
    ))?;
    s.commit()?;

    // A short READ COMMITTED transaction: the FK check sees live rows, nothing to serialise against.
    s.begin("READ COMMITTED")?;
    let at = Instant(tip.snapshot_at_ms).iso();
    s.conn.execute(
        &format!(
            "INSERT INTO ledger.balance_snapshots (account_id, as_of, balance, through_entry_id, chain_tip_seq, chain_tip_hash)
             SELECT account_id, $1::text::timestamptz, balance, $2::text, $3::text::bigint, $4::text
               FROM pg_temp.{STAGING_TABLE}"
        ),
        &[&at, &tip.through_entry_id, &tip.seq, &tip.hash],
    )?;
    let run_id = insert_run_row(
        &mut s.conn,
        &RunRow {
            started_at_ms,
            outcome: "ok",
            tip: Some(&tip),
            error_code: None,
            detail: Json::Object(report_detail(&report)),
        },
    )?;
    s.commit()?;
    s.sql(&format!("DROP TABLE IF EXISTS pg_temp.{STAGING_TABLE}"))?;
    Ok(SnapshotRun::Ok {
        report,
        tip,
        run_id,
    })
}

/// `LastVerified`: the latest `ok` run, in milliseconds; `first_attempt_ms` only before the first one, as the
/// staleness report's durable "not verified since".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastVerified {
    pub at_ms: Option<i64>,
    pub seq: Option<String>,
    pub first_attempt_ms: Option<i64>,
}

/// `readLastVerified(sql)`.
pub fn read_last_verified(store: &Store) -> Result<LastVerified, StoreError> {
    with_client(store.pool()?, |c| {
        let rows = c.query(
            "SELECT floor(extract(epoch FROM finished_at) * 1000)::bigint, through_seq::text
               FROM ledger.reconcile_runs
              WHERE outcome = 'ok'
              ORDER BY through_seq DESC, id DESC
              LIMIT 1",
            &[],
        )?;
        if let Some(r) = rows.first() {
            return Ok(LastVerified {
                at_ms: r.try_get(0)?,
                seq: r.try_get(1)?,
                first_attempt_ms: None,
            });
        }
        let first = c.query_one(
            "SELECT floor(extract(epoch FROM min(started_at)) * 1000)::bigint FROM ledger.reconcile_runs",
            &[],
        )?;
        Ok(LastVerified {
            at_ms: None,
            seq: None,
            first_attempt_ms: first.try_get(0)?,
        })
    })
}

/// `countConsecutiveIncompleteRuns(sql)`: incomplete runs after the latest ok or mismatch. A thaw writes neither, so it
/// does not reset the count.
pub fn count_consecutive_incomplete(store: &Store) -> Result<i64, StoreError> {
    with_client(store.pool()?, |c| {
        let n: i32 = c
            .query_one(
                "SELECT count(*)::int FROM ledger.reconcile_runs
                  WHERE outcome = 'incomplete'
                    AND id > COALESCE((SELECT max(id) FROM ledger.reconcile_runs WHERE outcome IN ('ok', 'mismatch')), 0)",
                &[],
            )?
            .try_get(0)?;
        Ok(i64::from(n))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn balances(n: i64) -> Balances {
        Balances {
            ok: true,
            drift: Vec::new(),
            accounts_checked: n,
        }
    }

    // `reconcile-proof-failure.test.ts`, "derives result from the report".
    #[test]
    fn the_word_comes_from_the_report_and_an_unfinished_check_is_never_matched() {
        let chain = Chain::Ok { length: 3 };
        assert_eq!(
            proof_result(true, &balances(2), &chain, 0),
            ProofWord::Matched
        );
        assert_eq!(
            proof_result(true, &balances(0), &Chain::Ok { length: 0 }, 0),
            ProofWord::NothingToCompare
        );
        assert_eq!(
            proof_result(false, &balances(2), &chain, 0),
            ProofWord::Mismatch
        );
        assert_eq!(
            proof_result(true, &balances(2), &chain, 1),
            ProofWord::Mismatch
        );
    }

    #[test]
    fn a_customer_account_is_a_persons_or_a_merchants_pot() {
        assert!(is_customer_balance_account("user", "x"));
        assert!(is_customer_balance_account("subaccount", "x"));
        assert!(is_customer_balance_account("module", "pay:clearing:m1"));
        assert!(is_customer_balance_account("module", "pay:proceeds:m1"));
        assert!(!is_customer_balance_account("module", "pay:fees"));
        assert!(!is_customer_balance_account("house", "house:fees"));
        assert!(!is_customer_balance_account("treasury", "treasury:x"));
    }

    #[test]
    fn the_statement_timeout_is_a_bounded_integer() {
        for bad in [0, 999, 3_600_001, -1] {
            assert!(valid_statement_timeout_ms(bad).is_err());
        }
        assert_eq!(valid_statement_timeout_ms(1_000), Ok(1_000));
        assert_eq!(valid_statement_timeout_ms(3_600_000), Ok(3_600_000));
    }

    #[test]
    fn the_error_code_is_the_errors_cut_to_64_or_unknown() {
        assert_eq!(
            ProofError::Failed(StoreError::new("x", None)).code(),
            "unknown"
        );
        assert_eq!(
            ProofError::Failed(StoreError::new("x", Some(""))).code(),
            "unknown"
        );
        assert_eq!(
            ProofError::Failed(StoreError::new("x", Some(&"c".repeat(80)))).code(),
            "c".repeat(64)
        );
        assert_eq!(
            ProofError::Corrupt("accounts.balance".to_owned()).code(),
            PERSISTED_AMOUNT_CORRUPT
        );
    }
}
