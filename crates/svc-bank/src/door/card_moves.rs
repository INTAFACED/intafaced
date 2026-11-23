//! Slice `card-ops`' card moves at the door (`cards::moves`): the six `ops.*` calls and the TEST merchant's refund, given
//! the cards slice's dependencies, the bus cashback earned on partner-held spend is announced on, and the automations
//! slice's round-up as the capture's hook (`onCaptureSettled: (event) => made.autoInvest.applyRoundUp(event)`).

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use super::{BankDoor, Ctx};
use crate::cards::moves::{Moves, RoundUp, router};
use crate::errors::{Refusal, to_trpc};

fn trpc(r: Refusal) -> TrpcError {
    to_trpc(r, || {
        service_kit::approvals::random_uuid().unwrap_or_default()
    })
}

impl BankDoor {
    pub(super) fn with_moves<T>(&self, ctx: &Ctx<'_>, f: impl FnOnce(&Moves<'_>) -> T) -> T {
        let round_up = |cap: &crate::automations::auto_invest::service::Capture<'_>| {
            self.automations_deps(ctx.now, |a| {
                crate::automations::auto_invest::service::apply_round_up(a, cap)
            })
        };
        let hook: &RoundUp<'_> = &round_up;
        self.cards_deps(ctx.now, |d| {
            f(&Moves {
                d,
                cashback: Some(self.transfers.bus.as_ref()),
                round_up: Some(hook),
            })
        })
    }

    /// The `ops.*` card moves; `None` for a slice call that is not one.
    pub(super) fn card_moves(&self, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
        self.with_moves(ctx, |m| router::answer(m, ctx))
            .map(|r| r.map(Some).map_err(trpc))
    }

    /// `testPartner.cardRefund` with the TEST partner on.
    pub(super) fn card_refund(&self, ctx: &Ctx<'_>) -> Result<Option<Json>, TrpcError> {
        let user = ctx
            .principal
            .map(|p| p.user_id.as_str())
            .unwrap_or_default();
        self.with_moves(ctx, |m| router::card_refund(m, user, &ctx.input))
            .map(Some)
            .map_err(trpc)
    }
}
