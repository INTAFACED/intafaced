//! Part `statements` of the activity slice: not ported yet (see `super`).

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;

/// What the door holds for this part, built once at start-up.
#[derive(Default)]
pub struct Wiring {}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

/// This part's wiring from the environment.
pub fn wiring(_b: &super::Build<'_>) -> Result<Wiring, String> {
    Ok(Wiring::none())
}

/// This part's answer to one of its calls; `None` while it is not ported.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    None
}
