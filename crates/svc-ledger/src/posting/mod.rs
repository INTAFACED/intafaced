//! The `posting` slice: `POST /trpc/post`, as `s2s-http.ts` `postChecked` and `LedgerService.post` run it.
//!
//! In order: the caller binding (`gate::apply_binding`), the recipe gate, the four binding checks (`bindings`), the
//! custody switch, then the engine (`engine::post`: key, idempotency, body, then the tip lock, the freeze, the clock and
//! the book), then the post's own `ledgerTxPosted` intent is published from the outbox it was committed with (`relay`).
//! A store that cannot take the write answers a typed 503 (`write-block.ts`).

pub mod bindings;
pub mod engine;
pub mod gate;
pub mod recipe_door;
pub mod recorded;
pub mod rules;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::telemetry::Logger;
use service_kit::time::Instant;

use crate::boot::Relay;
use crate::db::{Store, StoreError, with_client};
use crate::errors::{self, Failure};
use crate::freeze::Bus;
use crate::posting::bindings::Reader;
use crate::posting::engine::{EngineOptions, Mismatch, Posted};
use crate::posting::gate::{Caller, Violation, Why};
use crate::posting::rules::{AccountRef, PostRequest};

/// A post's failure: a refusal the door answers as such, or the store's.
#[derive(Debug, Clone, PartialEq)]
pub enum PostError {
    Refused(Failure),
    Store(StoreError),
}

impl From<Failure> for PostError {
    fn from(f: Failure) -> PostError {
        PostError::Refused(f)
    }
}

impl From<StoreError> for PostError {
    fn from(s: StoreError) -> PostError {
        PostError::Store(s)
    }
}

/// `classifyWriteBlock`: the write-block code of a store error, or none when it is not a store condition.
pub fn write_block(e: &StoreError) -> Option<&'static str> {
    const UNAVAILABLE: [&str; 4] = ["57P01", "57P02", "57P03", "25006"];
    match e.code.as_deref() {
        Some("53100") => Some(errors::WRITE_BLOCKS[0]),
        Some(c) if (c.starts_with("08") && c.len() == 5) || UNAVAILABLE.contains(&c) => {
            Some(errors::WRITE_BLOCKS[1])
        }
        Some(_) => None,
        // No SQLSTATE: the server never answered (a refused or dropped connection, a timeout), the TypeScript
        // driver's socket codes.
        None if e.socket => Some(errors::WRITE_BLOCKS[1]),
        None => None,
    }
}

/// `toWriteBlockError`: a store condition as its typed refusal; any other store error is the ledger's own fault.
fn as_write_block(e: PostError) -> Failure {
    match e {
        PostError::Refused(f) => f,
        PostError::Store(s) => match write_block(&s) {
            Some(code) => Failure::ledger(
                code,
                format!("ledger writes are blocked: {code} ({})", s.message),
            ),
            None => Failure::Fault,
        },
    }
}

/// A store error outside the write path: the ledger's own fault.
fn as_fault(e: PostError) -> Failure {
    match e {
        PostError::Refused(f) => f,
        PostError::Store(_) => Failure::Fault,
    }
}

/// `ledgerTxPosted`'s subject and version.
pub const TX_POSTED_SUBJECT: &str = "intafaced.ledger.tx.posted";

/// What the slice is put together from, once, at start-up.
pub struct Posting {
    pub bus: Arc<dyn Bus>,
    /// `SERVICE_NAME`: the envelope's producer.
    pub producer: String,
    /// `LEDGER_CUSTODY_LAYER=on`.
    pub custody_layer_on: bool,
    pub engine: EngineOptions,
    /// The service runs with per-service keys (`dual` or `keypair`).
    pub keys_configured: bool,
    /// Where binding violations and detect-mode mismatches are logged; none logs nothing.
    pub log: Option<Logger>,
    counts: Mutex<BindingCounts>,
}

#[derive(Default)]
struct BindingCounts {
    counts: BTreeMap<(&'static str, String), u64>,
    last_warn_ms: BTreeMap<String, i64>,
}

/// `WARN_INTERVAL_MS`: a claimed service's unbound warning at most once a minute.
const WARN_INTERVAL_MS: i64 = 60_000;

impl Posting {
    pub fn new(
        bus: Arc<dyn Bus>,
        producer: String,
        custody_layer_on: bool,
        engine: EngineOptions,
        keys_configured: bool,
        log: Option<Logger>,
    ) -> Posting {
        Posting {
            bus,
            producer,
            custody_layer_on,
            engine,
            keys_configured,
            log,
            counts: Mutex::new(BindingCounts::default()),
        }
    }

    /// `callerBindingCount(reason, service)`: how many violations of this kind this process has seen.
    pub fn binding_count(&self, why: Why, service: Option<&str>) -> u64 {
        let c = self
            .counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        c.counts
            .get(&(why.as_str(), service.unwrap_or("").to_owned()))
            .copied()
            .unwrap_or(0)
    }

    /// `callerBindingCounts()`: every violation count this process holds, as `(reason, service, count)`, the service
    /// blank when none was named.
    pub fn binding_counts(&self) -> Vec<(&'static str, String, u64)> {
        let c = self
            .counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        c.counts
            .iter()
            .map(|((why, service), n)| (*why, service.clone(), *n))
            .collect()
    }

    /// `addCallerBindingCount` and the door's `onViolation` warning: every violation counted; an unbound one warned
    /// first for a claimed service, then at most once a minute; the others every time.
    fn observe(&self, seen: &[Violation], mode: &str) {
        let mut c = self
            .counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for v in seen {
            let service = v.service.clone().unwrap_or_default();
            let count = {
                let slot = c
                    .counts
                    .entry((v.why.as_str(), service.clone()))
                    .or_insert(0);
                *slot += 1;
                *slot
            };
            if v.why == Why::Unbound {
                let now = (self.engine.clock_ms)();
                let quiet = c
                    .last_warn_ms
                    .get(&service)
                    .is_some_and(|at| now - at < WARN_INTERVAL_MS);
                if quiet {
                    continue;
                }
                c.last_warn_ms.insert(service, now);
            }
            if let Some(log) = &self.log {
                let opt = |s: &Option<String>| s.clone().map_or(Json::Null, Json::String);
                log.warn(
                    vec![
                        ("event", Json::str("ledger.caller_binding")),
                        ("code", Json::str(v.code)),
                        ("reason", Json::str(v.why.as_str())),
                        ("service", opt(&v.service)),
                        ("module", Json::str(v.module.clone())),
                        ("recipe", v.recipe.map_or(Json::Null, Json::str)),
                        ("mode", Json::str(mode)),
                        ("count", Json::int(i64::try_from(count).unwrap_or(i64::MAX))),
                    ],
                    &format!("ledger caller binding violation count={count}"),
                );
            }
        }
    }

    fn report(&self, mismatches: &[Mismatch]) {
        let Some(log) = &self.log else { return };
        for m in mismatches {
            log.warn(
                vec![
                    ("service", Json::str("svc-ledger")),
                    ("event", Json::str("ledger.idempotency_mismatch")),
                    ("idempotencyKey", Json::str(m.idempotency_key.clone())),
                    ("module", Json::str(m.module.clone())),
                    ("reason", Json::str(m.reason.clone())),
                ],
                "ledger.idempotency_mismatch",
            );
        }
    }
}

/// The book's reads, over the store, as the binding checks ask them.
struct BookReader<'a>(&'a Store);

impl Reader for BookReader<'_> {
    fn tx_by_key(&self, key: &str) -> Result<Option<Posted>, PostError> {
        let pool = self.0.pool()?;
        with_client(pool, |c| Ok(engine::tx_by_key(c, key)))?
    }

    fn account_id(&self, a: &AccountRef) -> Result<Option<String>, PostError> {
        let pool = self.0.pool()?;
        with_client(pool, |c| Ok(engine::account_id(c, a)))?
    }
}

/// `postAcknowledgement(tx)`: the transaction's identity and the entries the ledger actually booked.
pub fn acknowledgement(tx: &Posted) -> Json {
    Json::obj([
        ("txId", Json::str(tx.id.clone())),
        ("hash", Json::str(tx.hash.clone())),
        ("postedAt", Json::str(Instant(tx.posted_at_ms).iso())),
        (
            "entries",
            Json::Array(
                tx.entries
                    .iter()
                    .map(|e| {
                        Json::obj([
                            ("id", Json::str(e.id.clone())),
                            ("txId", Json::str(e.tx_id.clone())),
                            ("accountId", Json::str(e.account_id.clone())),
                            ("assetId", Json::str(e.asset_id.clone())),
                            ("direction", Json::str(e.direction.as_str())),
                            ("amount", Json::str(format_amount(e.amount))),
                            ("balanceAfter", Json::str(format_amount(e.balance_after))),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

/// `postChecked` then `LedgerService.post`: the body as the door's schema parsed it, and who sent it (none for a
/// direct call, which stays on the recipe gate). `mode` is `S2S_AUTH_MODE` as the warnings name it.
pub fn post(
    store: &Store,
    p: &Posting,
    caller: Option<&Caller>,
    mode: &str,
    body: &Json,
) -> Result<Json, Failure> {
    let r = rules::read_post(body).map_err(|_| Failure::Fault)?;
    if let Some(caller) = caller {
        let (seen, judged) = gate::apply_binding(caller, &r, p.keys_configured);
        p.observe(&seen, mode);
        judged?;
    }
    gate::assert_known_recipe(&r)?;
    let reader = BookReader(store);
    bindings::maker_rebate(&reader, &r).map_err(as_fault)?;
    bindings::campaign_lock(&reader, &r).map_err(as_fault)?;
    bindings::withdraw_return(&reader, &r).map_err(as_fault)?;
    bindings::withdraw_fee(&reader, &r, caller).map_err(as_fault)?;
    let tx = book(store, p, &r)?;
    Ok(acknowledgement(&tx))
}

/// `LedgerService.post`: the custody switch, the engine, then this post's own intent published.
pub fn book(store: &Store, p: &Posting, r: &PostRequest) -> Result<Posted, Failure> {
    // The custody switch, before anything is written. A key already booked still goes to the engine, which replays
    // it or refuses a different body: a caller retrying a committed post must learn it committed.
    if !p.custody_layer_on && r.moves_customer_balance() {
        let booked = BookReader(store)
            .tx_by_key(&r.idempotency_key)
            .map_err(as_write_block)?;
        if booked.is_none() {
            return Err(rules::custody_layer_off(&r.module, &r.reason));
        }
    }
    let pool = store.pool().map_err(|e| as_write_block(e.into()))?;
    let mut mismatches = Vec::new();
    let out = engine::post(pool, r, &p.engine, &mut mismatches);
    p.report(&mismatches);
    let tx = out.map_err(as_write_block)?;
    // After commit, from the outbox row written in that transaction: a consumer never sees a tx that could still roll
    // back, and a crash here leaves the row for the recovery. A failed publish is this call's failure, as it is the
    // TypeScript's: the caller retries the same key and gets the booked transaction back.
    TxRelay(p)
        .publish(store, Some(&tx.id))
        .map_err(|_| Failure::Fault)?;
    Ok(tx)
}

/// The `ledgerTxPosted` relay: unpublished intents published, then marked sent.
pub struct TxRelay<'a>(pub &'a Posting);

fn outbox_payload(row: &engine::OutboxRow) -> Result<Json, StoreError> {
    let bad = |why: &str| {
        StoreError::new(
            format!("ledger_tx_outbox {} {why}", row.id),
            Some("ledger.outbox_payload"),
        )
    };
    let Json::Object(_) = &row.payload else {
        return Err(bad("payload is not an object"));
    };
    let Some(Json::Array(entries)) = row.payload.get("entries") else {
        return Err(bad("payload.entries is not an array"));
    };
    for e in entries {
        let Json::Object(_) = e else {
            return Err(bad("has a non-object entry"));
        };
        match e.get("amount") {
            Some(Json::String(_)) => {}
            Some(Json::Number(_)) => return Err(bad("amount arrived as a JS number")),
            _ => return Err(bad("amount must be a decimal string")),
        }
    }
    // `validatePayload`: the event's schema, whose output keeps its own key order.
    let pick = |o: &Json, keys: &[&str]| -> Result<Json, StoreError> {
        let Json::Object(fields) = o else {
            return Err(bad("payload is not an object"));
        };
        if let Some((k, _)) = fields.iter().find(|(k, _)| !keys.contains(&k.as_str())) {
            return Err(bad(&format!(
                "payload carries {k}, which ledgerTxPosted does not name"
            )));
        }
        Ok(Json::Object(
            keys.iter()
                .filter_map(|k| o.get(k).map(|v| ((*k).to_owned(), v.clone())))
                .collect(),
        ))
    };
    let mut payload = pick(
        &row.payload,
        &[
            "txId",
            "module",
            "reason",
            "hash",
            "previousHash",
            "entries",
            "postedAt",
        ],
    )?;
    let ordered = entries
        .iter()
        .map(|e| pick(e, &["accountId", "assetId", "direction", "amount"]))
        .collect::<Result<Vec<_>, _>>()?;
    if let Json::Object(fields) = &mut payload
        && let Some((_, slot)) = fields.iter_mut().find(|(k, _)| k == "entries")
    {
        *slot = Json::Array(ordered);
    }
    Ok(payload)
}

impl TxRelay<'_> {
    /// `publishUnpublishedOutbox({ txId? })`: each row's envelope, keyed `ledger.tx:<txId>` so two drains cannot
    /// double-apply at JetStream, then the row marked sent.
    pub fn publish(&self, store: &Store, tx_id: Option<&str>) -> Result<usize, StoreError> {
        let pool = store.pool()?;
        let rows = with_client(pool, |c| engine::unpublished_outbox(c, tx_id))?;
        for row in &rows {
            let payload = outbox_payload(row)?;
            let mut env = vec![
                (
                    "id".to_owned(),
                    Json::str(
                        service_kit::approvals::random_uuid()
                            .map_err(|e| StoreError::new(e, None))?,
                    ),
                ),
                ("subject".to_owned(), Json::str(TX_POSTED_SUBJECT)),
                ("version".to_owned(), Json::int(1)),
                (
                    "occurredAt".to_owned(),
                    Json::str(Instant((self.0.engine.clock_ms)()).iso()),
                ),
                ("producer".to_owned(), Json::str(self.0.producer.clone())),
                (
                    "idempotencyKey".to_owned(),
                    Json::str(format!("ledger.tx:{}", row.tx_id)),
                ),
            ];
            if !row.correlation_id.is_empty() {
                env.push((
                    "correlationId".to_owned(),
                    Json::str(row.correlation_id.clone()),
                ));
            }
            env.push(("payload".to_owned(), payload));
            self.0
                .bus
                .publish(
                    TX_POSTED_SUBJECT,
                    &format!("ledger.tx:{}", row.tx_id),
                    &Json::Object(env),
                )
                .map_err(|e| StoreError::new(e, None))?;
            with_client(pool, |c| engine::mark_published(c, &row.id))?;
        }
        Ok(rows.len())
    }
}

impl Relay for TxRelay<'_> {
    fn drain(&self, store: &Store) -> Result<usize, StoreError> {
        self.publish(store, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `write-block.test.ts`: "wraps a store error as a typed LedgerError and passes other errors through unchanged".
    // A ledger refusal passes through; a store error that is not a store condition is the ledger's own fault (the
    // TypeScript rethrew the driver error, which its door answered 500, as `Fault` is).
    #[test]
    fn a_store_condition_is_its_typed_refusal_and_anything_else_passes_through() {
        let disk = as_write_block(PostError::Store(StoreError::new("pg 53100", Some("53100"))));
        assert!(
            matches!(&disk, Failure::Ledger { code, .. } if code == errors::WRITE_BLOCKS[0]),
            "{disk:?}"
        );
        let frozen = Failure::ledger(errors::FROZEN, "frozen");
        assert_eq!(as_write_block(PostError::Refused(frozen.clone())), frozen);
        assert_eq!(
            as_write_block(PostError::Store(StoreError::new("pg 23505", Some("23505")))),
            Failure::Fault
        );
    }
}
