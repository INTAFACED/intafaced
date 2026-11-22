//! The slice's calls (`router/transfers.router.ts`, `transfers/personal-request.router.ts`, `router/limits.router.ts`,
//! `safety/safety.router.ts`, `holds/holds.router.ts`, `router.ts`'s `fees.schedule`, and `ops.runDueTransfers`): each
//! part answers its own calls, checked as the TypeScript checks them.
//!
//! `transfers.list` is the activity feed narrowed to transfers: until slice `activity` is ported, every page read fails
//! as the feed's own failure does (`activityFailure`), and its success is `activity`'s.

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use super::{Deps, Wiring, holds, limits, personal, requests, safety, schedules, terms};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::partner::router::Wiring as PartnerWiring;

/// `activityFailure` for a failure the feed did not name: an opaque 500.
pub fn activity_failure() -> Refusal {
    Refusal::Trpc(TrpcError::plain(
        "INTERNAL_SERVER_ERROR",
        "Something went wrong. Please try again.",
    ))
}

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
    let out = if ctx.call.path == "transfers.list" {
        Err(activity_failure())
    } else {
        holds::answer(&d, ctx)
            .or_else(|| safety::answer(&d, ctx))
            .or_else(|| terms::answer(&d, ctx))
            .or_else(|| limits::answer(&d, ctx))
            .or_else(|| schedules::answer(&d, ctx))
            .or_else(|| personal::answer(&d, ctx))
            .or_else(|| requests::answer(&d, ctx))?
    };
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
