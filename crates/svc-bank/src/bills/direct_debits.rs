//! Part `direct_debits` of the bills slice. Not ported yet: every call answers "not ported".

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

/// This part's job doors past the signature; `None` for any other path.
pub fn job(
    _d: &Deps<'_>,
    _path: &str,
    _body: &service_kit::schema::Value,
) -> Option<service_kit::server::Response> {
    None
}
