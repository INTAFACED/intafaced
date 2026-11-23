//! The slice's calls (`createGlobalRouter` in `personal-pay/router.ts`), each answered through its `guard`.

use service_kit::json::Json;
use service_kit::money::js_trim;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::holds::{self, HoldAsk, ProofAsk, Scope};
use super::refusals::guard;
use super::send::{self, NewRecipient, SendAsk, canonical_compliance};
use super::{Deps, Wiring};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::router::Wiring as PartnerWiring;
use crate::spaces::space::{self, with};
use crate::transfers::step_up::{self, Binding};

fn no_such_space() -> Refusal {
    Refusal::Trpc(TrpcError::caused(
        "NOT_FOUND",
        "No such space. (bank.bills_space_not_found)",
        "bank.bills_space_not_found",
    ))
}

/// The router's `ownedSpace`: the person's space, or `bank.bills_space_not_found`.
fn owned_space(store: &Store, user_id: &str, space_id: &str) -> Result<space::Space, Refusal> {
    with(store, |c| space::find(c, space_id))?
        .filter(|s| s.user_id == user_id)
        .ok_or_else(no_such_space)
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
pub fn answer(
    w: &Wiring,
    transfers: &crate::transfers::Wiring,
    spaces: &crate::spaces::Wiring,
    partner: &PartnerWiring,
    store: &Store,
    ctx: &Ctx<'_>,
) -> Option<Result<Option<Json>, TrpcError>> {
    let d = Deps {
        store,
        ledger: spaces.ledger.as_ref(),
        custody_layer: &partner.custody_layer,
        w,
        now: ctx.now,
    };
    let input = &ctx.input;
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let text = |k: &str| input.get(k).as_str().unwrap_or_default();
    let opt = |k: &str| input.get(k).as_str();
    let limit = || input.get("limit").as_number().map(|n| n as i64);
    let id = || text("id");
    let send_id = || text("sendId");
    let operator = user;
    let out: Result<Json, Refusal> = match ctx.call.path {
        "global.partner" => return Some(Ok(Some(send::partner(&d)))),
        "global.corridors.list" => send::corridors_json(&d),
        "global.recipients.validate" => send::validate_recipient(&d, text("account"), opt("bic")),
        "global.recipients.add" => send::add_recipient(
            &d,
            &NewRecipient {
                user_id: user,
                idempotency_key: text("idempotencyKey"),
                name: text("name"),
                account: text("account"),
                country: text("country"),
                bic: opt("bic"),
                label: opt("label"),
            },
        ),
        "global.recipients.list" => send::list_recipients(&d, user, limit()),
        "global.recipients.remove" => {
            send::remove_recipient(&d, user, text("recipientId"), text("idempotencyKey"))
        }
        "global.quote" => send::quote(&d, user, text("asset"), text("amount"), text("toCurrency")),
        "global.send" => global_send(&d, transfers, spaces, partner, ctx),
        "global.list" => holds::expire_overdue(
            &d,
            Scope {
                user_id: Some(user),
                send_id: None,
            },
        )
        .and_then(|_| send::list(&d, user, limit(), opt("cursor"))),
        "global.get" => holds::get_send(&d, user, id()).map(|r| r.view()),
        "global.cancel" => holds::cancel(&d, user, id()),
        "global.recall" => send::recall(&d, user, id(), text("reason")),
        "global.receipt" => send::receipt(&d, user, id()),
        "global.autoCancelRule" => Ok(holds::auto_cancel_rule(&d)),
        "global.hold.get" => holds::for_customer(&d, user, id()),
        "global.hold.uploadProof" => holds::upload_proof(
            &d,
            &ProofAsk {
                user_id: user,
                send_id: id(),
                name: text("name"),
                kind: text("type"),
                content_base64: text("contentBase64"),
            },
        ),
        "global.ops.standInPayout" => send::stand_in_payout(&d, send_id()),
        "global.ops.holds" => holds::queue(&d, limit()),
        "global.ops.hold" => holds::hold(
            &d,
            &HoldAsk {
                send_id: send_id(),
                operator_id: operator,
                hold_key: text("holdKey"),
                reason: text("reason"),
                info_request: opt("infoRequest"),
            },
        ),
        "global.ops.requestInfo" => holds::request_info(&d, send_id(), text("infoRequest")),
        "global.ops.release" => holds::release(&d, send_id(), operator),
        "global.ops.linkReference" => {
            holds::link_reference(&d, send_id(), operator, text("reference"))
        }
        "global.ops.proof" => holds::proof_for(&d, send_id()),
        "global.ops.controls" => return Some(Ok(Some(send::controls(&d)))),
        "global.ops.summary" => send::ops_summary(&d),
        "global.ops.failed" => send::ops_failed(&d, limit()),
        "global.ops.get" => send::ops_get(&d, id()).map(|r| r.ops_view()),
        "global.ops.recalls" => send::ops_recalls(&d, limit()),
        "global.ops.recordReturn" => {
            send::record_return(&d, send_id(), text("returnRef"), operator)
        }
        "global.ops.refundReturn" => send::refund_return(&d, send_id(), operator),
        _ => return None,
    };
    Some(out.map(Some).map_err(guard))
}

/// `global.send`: the person's space, the step-up bound to exactly what is sent, then the send.
fn global_send(
    d: &Deps<'_>,
    transfers: &crate::transfers::Wiring,
    spaces: &crate::spaces::Wiring,
    partner: &PartnerWiring,
    ctx: &Ctx<'_>,
) -> Result<Json, Refusal> {
    let Some(principal) = ctx.principal else {
        return Err(Refusal::Other("global.send has no principal".to_owned()));
    };
    let input = &ctx.input;
    let text = |k: &str| input.get(k).as_str().unwrap_or_default();
    let user = principal.user_id.as_str();
    let space = owned_space(d.store, user, text("fromSpaceId"))?;
    let compliance = match input.get("compliance") {
        Value::Undefined => None,
        v => Some(v),
    };
    let quote_id = input.get("quoteId").as_str();
    let mut fields: Vec<(String, String)> = [
        ("actor", user.to_owned()),
        ("idempotencyKey", text("idempotencyKey").to_owned()),
        ("fromSpaceId", text("fromSpaceId").to_owned()),
        ("assetId", space.asset_id.clone()),
        ("amount", text("amount").to_owned()),
        ("toCurrency", js_trim(text("toCurrency")).to_uppercase()),
        ("recipientId", text("recipientId").to_owned()),
        ("country", js_trim(text("country")).to_uppercase()),
        ("deliveryMethod", js_trim(text("deliveryMethod")).to_owned()),
        ("compliance", canonical_compliance(compliance)?),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    if let Some(q) = quote_id {
        fields.push(("quoteId".to_owned(), q.to_owned()));
    }
    let binding = Binding {
        action_type: "bank.step_up.global.send",
        fields,
        operation_key: text("idempotencyKey").to_owned(),
    };
    let custody = partner.custody(d.store);
    let td = crate::transfers::Deps {
        store: d.store,
        ledger: d.ledger,
        custody: &custody,
        partner,
        spaces,
        w: transfers,
        now: d.now,
    };
    step_up::require(
        &td,
        principal,
        &binding,
        input.get("stepUpApprovalId").as_str(),
    )?;
    send::send(
        d,
        &SendAsk {
            user_id: user,
            idempotency_key: text("idempotencyKey"),
            from_space_id: text("fromSpaceId"),
            amount: text("amount"),
            to_currency: text("toCurrency"),
            recipient_id: text("recipientId"),
            country: text("country"),
            delivery_method: text("deliveryMethod"),
            compliance,
            quote_id,
        },
    )
}
