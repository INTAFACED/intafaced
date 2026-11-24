//! Slice `ramps` (`PORT.md`): the customer's address book, the on-ramp and add money, and the off-ramp.
//!
//! - `book`: saved withdrawal addresses and everything that guards them (`withdraw-destination.ts`, the address half of
//!   `ramps/customer-ramps.ts`, `address-approval.ts`, `wallet-ownership.ts`, `trusted-devices.ts`, `fraud-list.ts`,
//!   `sanctions-list.ts`, `send-destination.ts`, `withdraw-networks.ts`, `offramp-cooling.ts`), and the desk's fraud
//!   list calls.
//! - `onramp`: the programme, quotes, on-ramps and add money, and their TEST stand-ins (`rails.ts`,
//!   `pay-fiat-adapter.ts`, the quote half of `customer-ramps.ts`, `add-money.ts`, `payin-sim*.ts`, `onramp-sim.ts`,
//!   `ramp-partner-book.ts`, `test-ramp-partner-record.ts`, `ops/ramp-health.ts`, `ramp-metrics.ts`,
//!   `onramp-quotes.ts`), the operator's credit, the pay-in jobs and the TEST pages and record doors.
//! - `offramp`: the customer's off-ramp and withdrawal address (`ramp-service.ts`'s `offramp` and
//!   `setWithdrawDestination`).
//!
//! Money moves only through svc-ledger's recipe door (`deposit`, `withdrawHold`, `withdrawSettle`), never by entries
//! assembled here; with the custodial layer off each of those refuses `bank.no_partner_bank` before svc-ledger is
//! asked, as `custodyGuardedLedger` does.

pub mod book;
pub mod cooling;
pub mod offramp;
pub mod onramp;
pub mod refs;
pub mod sanctions;

use service_kit::json::Json;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::Ctx;

/// The owner's values the slice reads, each as `index.ts` and the TypeScript's `process.env` reads hand it in; blank
/// is `None`. Each is parsed where it is used, so a refusal names it as the TypeScript's does.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    /// `BANK_RAMP_MODE`: `none` or `crypto-ledger`.
    pub ramp_mode: Option<String>,
    /// `BANK_OFFRAMP_COOLING_HOURS`.
    pub offramp_cooling_hours: Option<String>,
    /// `BANK_ADDRESS_BOOK_CAP`.
    pub address_book_cap: Option<String>,
    /// `BANK_DESTINATION_SANCTIONS`.
    pub destination_sanctions: Option<String>,
    /// `BANK_WALLET_PROOF_WINDOW_MINUTES`.
    pub wallet_proof_window_minutes: Option<String>,
    /// `BANK_WALLET_PROOF_VALID_DAYS`.
    pub wallet_proof_valid_days: Option<String>,
    /// `BANK_ADDRESS_APPROVAL_LINK_MINUTES`.
    pub address_approval_link_minutes: Option<String>,
    /// `APP_ENV`, for what only a dev or test process may do.
    pub app_env: Option<String>,
    /// `NODE_ENV`.
    pub node_env: Option<String>,
}

/// What the door holds for the slice, built once at start-up.
pub struct Wiring {
    pub settings: Settings,
    pub book: book::Wiring,
    pub onramp: onramp::Wiring,
}

impl Wiring {
    /// Every owner value blank, no identity, no partner and no programme: what a door built without the environment
    /// holds.
    pub fn none() -> Wiring {
        Wiring {
            settings: Settings::default(),
            book: book::Wiring::none(),
            onramp: onramp::Wiring::none(),
        }
    }
}

/// What every part of the slice is handed for one call or one pass.
pub struct Deps<'a> {
    pub store: &'a Store,
    /// svc-ledger: balances, the asset registry and the recipe door.
    pub ledger: &'a dyn crate::spaces::ports::Ledger,
    /// The partner slice's wiring: the TEST partner and its switches, and `LEDGER_CUSTODY_LAYER`.
    pub partner: &'a crate::partner::router::Wiring,
    /// The transfers slice's wiring: the security lock and the operator's approvals.
    pub transfers: &'a crate::transfers::Wiring,
    pub w: &'a Wiring,
    pub now: Instant,
    /// The door's clock, for a check that reads the time again before it records (`verifyWalletProof`).
    pub clock: fn() -> Instant,
}

/// The slice's answer to a call that passed the door, or `None` when no part of the slice answers its path yet.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    book::answer(d, ctx)
        .or_else(|| onramp::answer(d, ctx))
        .or_else(|| offramp::answer(d, ctx))
}
