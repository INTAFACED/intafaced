//! The slice's calls (`router/cards.router.ts`), each part answering its own (`core`, `orders`, `secrets`, `safety`,
//! `disputes`, `reads`), every refusal through the router's guard.

use service_kit::trpc::TrpcError;

use super::{Deps, Wiring};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::to_trpc;
use crate::partner::router::Wiring as PartnerWiring;

pub fn answer(
    w: &Wiring,
    transfers: &crate::transfers::Wiring,
    spaces: &crate::spaces::Wiring,
    partner: &PartnerWiring,
    store: &Store,
    ctx: &Ctx<'_>,
) -> Option<Result<Option<service_kit::json::Json>, TrpcError>> {
    let custody = partner.custody(store);
    let t = crate::transfers::Deps {
        store,
        ledger: spaces.ledger.as_ref(),
        custody: &custody,
        partner,
        spaces,
        w: transfers,
        now: ctx.now,
    };
    let d = Deps { t: &t, w };
    let out = super::core::answer(&d, ctx)
        .or_else(|| super::orders::answer(&d, ctx))
        .or_else(|| super::secrets::answer(&d, ctx))
        .or_else(|| super::safety::answer(&d, ctx))
        .or_else(|| super::disputes::answer(&d, ctx))
        .or_else(|| super::reads::answer(&d, ctx))?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
