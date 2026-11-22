//! The address book (`PORT.md`, slice `ramps`). Being ported.

pub mod fraud;
pub mod store;

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;

use super::Deps;

/// What the door holds for the address book, built once at start-up.
pub struct Wiring {}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring {}
    }
}

/// The address book's calls; `None` for any other path.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    None
}
