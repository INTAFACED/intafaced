//! `businessBills.*` and the job doors `bill-pay/{run-due,returned}`.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;
use crate::transfers::Deps;

/// `businessBills.*`; `None` for a call outside it.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    None
}

/// `POST /internal/jobs/bill-pay/{run-due,returned}` past the signature; `None` for another path.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}
