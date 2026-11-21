//! The navigator slice's fourteen calls. The door has already checked the caller, the scope, the region, the
//! person-only rules and the input.

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::{Ctx, Slice, not_ported};
use crate::gateway::desk::GatewaySlice;
use crate::metering::Metering;
use crate::runtime::{RunError, Runtime, to_trpc};

use super::onchain;

/// Answers one call of the slice.
pub fn handle(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
) -> Result<Option<Json>, TrpcError> {
    answer(ctx, store, gateway, m, rt)
        .map(Some)
        .map_err(to_trpc)
}

fn answer(
    ctx: &Ctx<'_>,
    store: &Store,
    _gateway: &GatewaySlice,
    _m: &Metering,
    rt: &Runtime,
) -> Result<Json, RunError> {
    let path = ctx.call.path;
    if onchain::CALLS.contains(&path) {
        return onchain::handle(ctx, store, rt);
    }
    Err(RunError::Trpc(not_ported(Slice::Navigator)))
}
