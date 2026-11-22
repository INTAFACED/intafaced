//! The off-ramp (`PORT.md`, slice `ramps`). Being ported.

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;

use super::Deps;

/// The off-ramp's calls; `None` for any other path.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    None
}
