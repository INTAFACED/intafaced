//! The bills slice (`PORT.md`): a person's payments out to someone outside the bank, each an instruction row and never a
//! balance.
//!
//! - `pay`: personal bill pay, its recurring bills and their job call, and the founder's counts (`personal-pay/bills.ts`,
//!   `personal-pay/router.ts` `createBillsRouter`).
//! - `direct_debits`: Direct Debit mandates and their collections, the scheme's job doors and the finance desk's read
//!   (`direct-debits/`, `ops/direct-debit-mandates.ts`).
//! - `rail_sends`: sends over a bank rail to a payee in the person's book (`rail-sends/`).
//! - `router`: the calls and the job doors, each answered by its part.

pub mod direct_debits;
pub mod pay;
pub mod rail_sends;
pub mod router;

/// What the binary hands the slice, one part each.
pub struct Wiring {
    pub pay: pay::Wiring,
    pub direct_debits: direct_debits::Wiring,
    pub rail_sends: rail_sends::Wiring,
}

impl Wiring {
    /// Nothing wired: what a door gets until the binary hands the slice in.
    pub fn none() -> Wiring {
        Wiring {
            pay: pay::Wiring::none(),
            direct_debits: direct_debits::Wiring::none(),
            rail_sends: rail_sends::Wiring::none(),
        }
    }
}

/// What every part of the slice is handed for one call or one pass: the transfers slice's dependencies (the store, the
/// ledger, the partner, the spaces, identity's reads and the step-up gate) and the slice's wiring.
pub struct Deps<'a> {
    pub t: &'a crate::transfers::Deps<'a>,
    pub w: &'a Wiring,
}

impl Deps<'_> {
    pub fn store(&self) -> &crate::db::Store {
        self.t.store
    }

    pub fn now(&self) -> service_kit::time::Instant {
        self.t.now
    }
}

/// `railBoundary(rail, asset)`: the ledger boundary a rail's payments post to. Never a partner's or a payee's name.
pub fn rail_boundary(rail_id: &str, asset_id: &str) -> crate::spaces::ports::LedgerAccount {
    crate::spaces::ports::LedgerAccount {
        owner_type: "treasury",
        owner_id: format!("rail:{rail_id}"),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}
