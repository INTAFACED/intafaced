//! What `index.ts` does before it serves, and the outbox timer it leaves running:
//! - `chain_tip` must be there (the migrations ran);
//! - `assertCustodyLayerBootable`: with `LEDGER_CUSTODY_LAYER` off, a book still holding a customer balance refuses
//!   to start, rather than strand that money in holds no post could release;
//! - `applyStartupPolicy`: `LEDGER_POSTING_ENABLED=false` freezes posting durably; `true` never thaws a frozen book;
//! - `recoverUnpublishedOutbox` at boot and every five seconds: each relay publishes what committed but was never
//!   sent. The relays are their slices' (`posting`: `ledgerTxPosted`, not ported yet; `freeze`: `ledgerFreezeUpdated`,
//!   `crate::freeze::FreezeRelay`); this holds the loop and the timer that drive them.

use crate::db::{Store, StoreError, with_client};
use crate::freeze::{self, Command, FreezeRelay};
use crate::status::{FreezeState, read_freeze};

/// The message `index.ts` stops on when `chain_tip` has no row.
pub const CHAIN_TIP_MISSING: &str =
    "chain_tip is missing — run migrations before starting svc-ledger";
/// `CUSTODY_LAYER_OPEN_BALANCES_CODE`.
pub const CUSTODY_LAYER_OPEN_BALANCES: &str = "ledger.custody_layer_open_balances";
/// The startup freeze's reason and actor (`applyStartupPolicy`).
pub const STARTUP_FREEZE_REASON: &str = "LEDGER_POSTING_ENABLED=false at startup";
pub const STARTUP_FREEZE_ACTOR: &str = "env:LEDGER_POSTING_ENABLED";
/// `OUTBOX_RECOVER_MS`.
pub const OUTBOX_RECOVER_MS: u64 = 5_000;
/// `recoverUnpublishedOutbox`'s rounds at most.
pub const OUTBOX_ROUNDS: usize = 20;

/// `SELECT seq FROM chain_tip WHERE id = true`: the chain's tip at boot, or why the service does not start.
pub fn chain_tip(store: &Store) -> Result<String, StoreError> {
    let rows = with_client(store.pool()?, |c| {
        Ok(c.query(
            "SELECT seq::text FROM ledger.chain_tip WHERE id = true",
            &[],
        )?)
    })?;
    match rows.first() {
        Some(r) => Ok(r.try_get(0)?),
        None => Err(StoreError::new(CHAIN_TIP_MISSING, None)),
    }
}

/// `assertCustodyLayerBootable()`. With the layer on it reads nothing.
pub fn assert_custody_layer_bootable(
    store: &Store,
    custody_layer_on: bool,
) -> Result<(), StoreError> {
    if custody_layer_on {
        return Ok(());
    }
    let open: i32 = with_client(store.pool()?, |c| {
        Ok(c.query_one(
            "SELECT count(*)::int AS n FROM ledger.accounts
              WHERE balance <> 0
                AND (owner_type IN ('user', 'subaccount')
                  OR (owner_type = 'module' AND (owner_id LIKE 'pay:clearing:%' OR owner_id LIKE 'pay:proceeds:%')))",
            &[],
        )?
        .try_get(0)?)
    })?;
    if open > 0 {
        return Err(StoreError::new(
            format!(
                "LEDGER_CUSTODY_LAYER is off, but {open} customer account(s) still hold a balance in this book. Switching \
                 custody off now would strand that money in its holds: set LEDGER_CUSTODY_LAYER=on, unwind them through their \
                 recipes, then switch it off."
            ),
            Some(CUSTODY_LAYER_OPEN_BALANCES),
        ));
    }
    Ok(())
}

/// `applyStartupPolicy()`: THE DATABASE WINS, in one direction. `posting_enabled` false freezes (and reaches every
/// replica); true never thaws a book something else froze. The freeze is `LedgerService.freeze`: the switch, then the
/// freeze relay publishes its intent, and a failed publish fails the start. Call once, before serving.
pub fn apply_startup_policy(
    store: &Store,
    posting_enabled: bool,
    relay: &FreezeRelay<'_>,
) -> Result<FreezeState, StoreError> {
    let state = with_client(store.pool()?, read_freeze)?;
    if posting_enabled || state.frozen {
        return Ok(state);
    }
    freeze::switch(
        store,
        relay,
        Command::Freeze {
            reason: STARTUP_FREEZE_REASON,
            actor: STARTUP_FREEZE_ACTOR,
        },
    )
}

/// One outbox's relay: publishes its committed, unsent intents, then marks each sent; how many it published.
pub trait Relay: Sync {
    fn drain(&self, store: &Store) -> Result<usize, StoreError>;
}

/// `recoverUnpublishedOutbox()`: every relay in turn, round after round, until a round publishes nothing (at most
/// [`OUTBOX_ROUNDS`]). The first failure stops the recovery; the next tick retries.
pub fn recover_outbox(store: &Store, relays: &[&dyn Relay]) -> Result<usize, StoreError> {
    let mut published = 0;
    for _ in 0..OUTBOX_ROUNDS {
        let mut round = 0;
        for relay in relays {
            round += relay.drain(store)?;
        }
        published += round;
        if round == 0 {
            break;
        }
    }
    Ok(published)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use std::sync::Mutex;

    use super::*;

    /// A relay that publishes the counts it is given, one per call, then nothing.
    struct Counts(Mutex<Vec<usize>>);

    impl Relay for Counts {
        fn drain(&self, _: &Store) -> Result<usize, StoreError> {
            let mut c = self.0.lock().unwrap();
            Ok(if c.is_empty() { 0 } else { c.remove(0) })
        }
    }

    struct Fails;

    impl Relay for Fails {
        fn drain(&self, _: &Store) -> Result<usize, StoreError> {
            Err(StoreError::new("bus down", None))
        }
    }

    #[test]
    fn recovery_runs_every_relay_until_a_round_publishes_nothing() {
        let store = Store::Down("unused".to_owned());
        let tx = Counts(Mutex::new(vec![3, 0, 1]));
        let freeze = Counts(Mutex::new(vec![0, 2]));
        assert_eq!(recover_outbox(&store, &[&tx, &freeze]).unwrap(), 6);
        assert!(tx.0.lock().unwrap().is_empty());
    }

    #[test]
    fn recovery_stops_at_twenty_rounds() {
        let store = Store::Down("unused".to_owned());
        let busy = Counts(Mutex::new(vec![1; 25]));
        assert_eq!(recover_outbox(&store, &[&busy]).unwrap(), OUTBOX_ROUNDS);
    }

    #[test]
    fn a_failing_relay_stops_the_recovery() {
        let store = Store::Down("unused".to_owned());
        assert_eq!(
            recover_outbox(&store, &[&Fails]).unwrap_err().message,
            "bus down"
        );
    }

    #[test]
    fn with_no_relays_recovery_publishes_nothing() {
        let store = Store::Down("unused".to_owned());
        assert_eq!(recover_outbox(&store, &[]).unwrap(), 0);
    }
}
