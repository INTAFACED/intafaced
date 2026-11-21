//! `navigator/onchain-routes.ts`, `onchain.ts` and `onchain-trade.ts`: `navigator.onchain.*`, `navigator.ask`,
//! `navigator.orders` and `navigator.trading`.

use service_kit::json::Json;

use crate::db::Store;
use crate::door::{Ctx, Slice, not_ported};
use crate::runtime::{RunError, Runtime};

/// The calls this module answers.
pub const CALLS: [&str; 7] = [
    "navigator.onchain.signer",
    "navigator.onchain.bind",
    "navigator.onchain.revoke",
    "navigator.onchain.binding",
    "navigator.ask",
    "navigator.orders",
    "navigator.trading",
];

/// `NavigatorOnchainDeps`, less the database (the door's store) and the session read (the runtime's).
pub struct OnchainDeps {}

impl OnchainDeps {
    /// Nothing configured.
    pub fn unwired() -> OnchainDeps {
        OnchainDeps {}
    }
}

/// Answers one of [`CALLS`].
pub fn handle(_ctx: &Ctx<'_>, _store: &Store, _rt: &Runtime) -> Result<Json, RunError> {
    Err(RunError::Trpc(not_ported(Slice::Navigator)))
}
