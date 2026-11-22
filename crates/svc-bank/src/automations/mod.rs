//! The automations slice (`PORT.md`): the person's rules that act by themselves, each a row of instructions and never a
//! balance.
//!
//! - `rules`: the payment reminder rule, the standing-order notice outbox and its job, and the money rules that refuse
//!   until the owner publishes their terms (`rules/`).
//! - `sorter`: the income sorter, its sweep job and the hand-off from a posted send (`sorter/`).
//! - `auto_invest`: threshold sweeps, card round-ups and DCA, their run and its job (`router/auto-invest.router.ts`,
//!   `auto-invest/`, `ops.runAutoInvest`).
//! - `pay_yourself`: the pay-yourself rule, its moves and its job (`pay-yourself/`).
//! - `own_moves`: moves to the person's own trading account (`own-moves/`).
//! - `router`: the calls, each answered by its part.

pub mod auto_invest;
pub mod own_moves;
pub mod pay_yourself;
pub mod router;
pub mod rules;
pub mod sorter;

/// What the binary hands the slice, one part each.
pub struct Wiring {
    pub rules: rules::Wiring,
    pub sorter: sorter::Wiring,
    pub auto_invest: auto_invest::Wiring,
    pub pay_yourself: pay_yourself::Wiring,
    pub own_moves: own_moves::Wiring,
}

impl Wiring {
    /// Nothing wired: what a door gets until the binary hands the slice in.
    pub fn none() -> Wiring {
        Wiring {
            rules: rules::Wiring::none(),
            sorter: sorter::Wiring::none(),
            auto_invest: auto_invest::Wiring::none(),
            pay_yourself: pay_yourself::Wiring::none(),
            own_moves: own_moves::Wiring::none(),
        }
    }
}

/// What every part of the slice is handed for one call or one pass: the transfers slice's dependencies (the store, the
/// ledger, the partner, the spaces and identity's reads) and the slice's wiring.
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
