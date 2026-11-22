//! The webhooks slice's three calls (`router.ts` `webhook`, `webhookCall`): unwired, each refuses
//! `agents.webhooks_unwired`; each refusal leaves as its typed code. The door has already checked the caller, the
//! `agents:read` scope and the input.

use service_kit::json::Json;
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{self, Refusal};
use crate::webhooks::{RunWebhooks, WebhookError, url_guard};

const CONFLICT: &str = "agents.webhook_endpoint_conflict";

fn to_trpc(e: WebhookError) -> TrpcError {
    match e {
        WebhookError::Url(_) => TrpcError::caused(
            "BAD_REQUEST",
            url_guard::URL_INVALID,
            url_guard::URL_INVALID,
        ),
        WebhookError::Conflict => TrpcError::caused("CONFLICT", CONFLICT, CONFLICT),
        WebhookError::Store(s) => errors::to_trpc(Refusal::Other(s.to_string())),
    }
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "the schema checked a whole number in range"
)]
fn limit(ctx: &Ctx<'_>) -> i64 {
    ctx.input.get("limit").as_number().map_or(0, |n| n as i64)
}

/// Answers one call of the slice.
pub fn handle(
    ctx: &Ctx<'_>,
    store: &Store,
    hooks: Option<&RunWebhooks>,
) -> Result<Option<Json>, TrpcError> {
    let Some(hooks) = hooks else {
        return Err(TrpcError::plain(
            "PRECONDITION_FAILED",
            "agents.webhooks_unwired",
        ));
    };
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let pool = store
        .pool()
        .map_err(|e| errors::to_trpc(Refusal::Other(e.to_string())))?;
    let input = &ctx.input;
    let answer = match ctx.call.path {
        "webhook.register" => hooks.register(
            pool,
            user,
            input.get("endpointId").as_str().unwrap_or(""),
            input.get("url").as_str().unwrap_or(""),
        ),
        "webhook.list" => hooks.list(pool, user, limit(ctx)),
        "webhook.deliveries" => hooks.deliveries(
            pool,
            user,
            input.get("endpointId").as_str(),
            input.get("runId").as_str(),
            limit(ctx),
        ),
        other => {
            return Err(errors::to_trpc(Refusal::Other(format!(
                "{other} is not a webhook call"
            ))));
        }
    };
    answer.map(Some).map_err(to_trpc)
}
