//! `businessCards.*`.

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;
use crate::transfers::Deps;

/// `businessCards.*`; `None` for a call outside it.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    None
}
