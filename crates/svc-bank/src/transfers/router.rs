//! The slice's calls (`router/transfers.router.ts`, `transfers/personal-request.router.ts`, `router/limits.router.ts`,
//! `safety/safety.router.ts`, `holds/holds.router.ts`, `router.ts`'s `fees.schedule`, and `ops.runDueTransfers`): each
//! part answers its own calls, checked as the TypeScript checks them.
//!
//! `transfers.list` is the activity feed narrowed to transfers: slice `activity` answers it
//! (`activity::feed::transfers_list`), and the door sends it there.

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use super::{Deps, Wiring, holds, limits, personal, requests, safety, schedules, terms};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::to_trpc;
use crate::partner::router::Wiring as PartnerWiring;

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
pub fn answer(
    w: &Wiring,
    spaces: &crate::spaces::Wiring,
    partner: &PartnerWiring,
    store: &Store,
    ctx: &Ctx<'_>,
) -> Option<Result<Option<Json>, TrpcError>> {
    let custody = partner.custody(store);
    let d = Deps {
        store,
        ledger: spaces.ledger.as_ref(),
        custody: &custody,
        partner,
        spaces,
        w,
        now: ctx.now,
    };
    let out = holds::answer(&d, ctx)
        .or_else(|| safety::answer(&d, ctx))
        .or_else(|| terms::answer(&d, ctx))
        .or_else(|| limits::answer(&d, ctx))
        .or_else(|| schedules::answer(&d, ctx))
        .or_else(|| personal::answer(&d, ctx))
        .or_else(|| requests::answer(&d, ctx))?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
