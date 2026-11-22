//! Part `rail_sends` of the bills slice. Not ported yet: every call answers "not ported".

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;

/// What the binary hands this part.
#[derive(Default)]
pub struct Wiring {}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

/// This part's calls; `None` for any other call.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    None
}
