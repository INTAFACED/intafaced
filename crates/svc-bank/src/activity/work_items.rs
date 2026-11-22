//! Part `work_items` of the activity slice: not ported yet (see `super`).

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;

/// This part's answer to one of its calls; `None` while it is not ported.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    None
}
