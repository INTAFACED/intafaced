//! The slice's calls and job doors, each answered by its part; a part answers `None` for a call that is not its own.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;
use crate::transfers::Deps;

/// The slice's calls; `None` for a call no part has ported.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    super::bills::router::answer(d, ctx)
        .or_else(|| super::cards::router::answer(d, ctx))
        .or_else(|| super::books::router::answer(d, ctx))
}

/// The slice's job doors past the signature (`index.ts`'s `bill-pay/*`); `None` for a path that is not ported.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    super::bills::router::job(d, path, body)
}
