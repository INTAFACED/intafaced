//! The `metering` slice (`PORT.md`): exact per-session usage, each window sealed and billed once through svc-ledger's
//! `postRecipe`, a person's own spend caps, and what their agents cost.
//!
//! - [`pricing`]: cost in scaled integers, rounded once per window and rate; window ids; the charge key.
//! - [`meter`]: `UsageMeter`: usage recorded, claimed and read; a window sealed, then charged, then recorded.
//! - [`settle`]: the runtime's `settleWindow` and `settleSession`: the metering-off law, the action log row, the event.
//! - [`spend`]: `spend.limits.get` and `set`, and the cap arithmetic the runtime's holds use.
//! - [`review`]: `analytics.summary` and `usage.summary`.
//! - [`ports`]: svc-ledger, svc-bank, svc-identity and the bus, each behind a trait.
//! - [`slice`]: the seven calls, answered as `router.ts`, `review/routes.ts` and `spend/routes.ts` answer them.

pub mod meter;
pub mod ports;
pub mod pricing;
pub mod review;
pub mod settle;
pub mod slice;
pub mod spend;

use ports::{Affiliates, Bus, Ledger, LedgerOnly, NoAffiliates, NoBus, NoLedger, UsagePayment};

/// What metering is built from, once, at start-up (`index.ts`: `new UsageMeter(sql, ledger, { payment, assetId,
/// windowMinutes, affiliateAccrue, affiliatePayout })` and the runtime's `feeAssetId` and `meteringEnabled`).
pub struct Metering {
    /// `AGENTS_FEE_ASSET_ID`: the asset usage is billed in.
    pub fee_asset_id: String,
    /// `AGENTS_USAGE_WINDOW_MINUTES`: must divide a day.
    pub window_minutes: i64,
    /// `AGENTS_METERING_ENABLED`: off is audit-only, never billed (D26-P1-A6).
    pub enabled: bool,
    /// The ledger module of every charge: `agents`.
    pub module: String,
    /// `SERVICE_NAME`: the producer of the events.
    pub producer: String,
    pub ledger: Box<dyn Ledger>,
    pub payment: Box<dyn UsagePayment>,
    pub affiliates: Box<dyn Affiliates>,
    pub bus: Box<dyn Bus>,
}

impl Metering {
    /// Nothing outside the process wired, and metering off: nothing is billed, posted or published.
    pub fn unwired(fee_asset_id: &str, window_minutes: i64) -> Metering {
        Metering {
            fee_asset_id: fee_asset_id.to_owned(),
            window_minutes,
            enabled: false,
            module: "agents".to_owned(),
            producer: "svc-agents".to_owned(),
            ledger: Box::new(NoLedger),
            payment: Box::new(LedgerOnly),
            affiliates: Box::new(NoAffiliates),
            bus: Box::new(NoBus),
        }
    }
}
