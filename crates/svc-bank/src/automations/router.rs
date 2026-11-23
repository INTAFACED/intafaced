//! The slice's calls, each answered by its part; a part answers `None` for a call that is not its own.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;
use crate::errors::to_trpc;

pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let out = super::rules::answer(d, ctx)
        .or_else(|| super::sorter::answer(d, ctx))
        .or_else(|| super::auto_invest::answer(d, ctx))
        .or_else(|| super::pay_yourself::answer(d, ctx))
        .or_else(|| super::own_moves::answer(d, ctx))?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

/// The slice's job doors past the signature (`index.ts`); `None` for a path that is not the slice's or not ported.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    super::rules::job(d, path, body)
        .or_else(|| super::sorter::job(d, path, body))
        .or_else(|| super::auto_invest::job(d, path, body))
        .or_else(|| super::pay_yourself::job(d, path, body))
}
