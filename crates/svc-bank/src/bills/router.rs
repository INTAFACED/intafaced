//! The slice's calls and job doors, each answered by its part; a part answers `None` for a call that is not its own.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;

/// The slice's calls; `None` for a call no part has ported.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    super::pay::answer(d, ctx)
        .or_else(|| super::direct_debits::answer(d, ctx))
        .or_else(|| super::rail_sends::answer(d, ctx))
}

/// The slice's job doors past the signature (`index.ts`); `None` for a path that is not the slice's or not ported.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    super::direct_debits::job(d, path, body)
}
