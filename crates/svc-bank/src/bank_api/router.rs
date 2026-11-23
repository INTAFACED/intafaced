//! The slice's calls (`createBankApiRouter` in `router/bank-api.router.ts`), each answered through the main router's guard, and
//! the TEST partner's `testPartner.settlePayment` (`partner/test-partner.router.ts`), which records a payment's state change here.
//!
//! Reads take `bank:read`; a move between the person's own accounts and an endpoint take `bank:write`; a payment out takes
//! `trade:withdraw`, the person's own signed-in session after its second factor, never a key (the door's guards hold each).

use service_kit::json::Json;
use service_kit::money::parse_amount;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::{Deps, PaymentAsk, Recipient};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).as_str().unwrap_or_default()
}

fn limit(v: &Value) -> i64 {
    v.get("limit").as_number().map_or(0, |n| n as i64)
}

fn amount(v: &Value) -> Result<service_kit::money::Amount, Refusal> {
    parse_amount(text(v, "amount")).map_err(Refusal::Other)
}

fn guard(out: Result<Json, Refusal>) -> Result<Option<Json>, TrpcError> {
    out.map(Some).map_err(|e| {
        to_trpc(e, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    })
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let out = match ctx.call.path {
        "bankApi.accounts" => super::accounts(d, user, input.get("type").as_str(), limit(input)),
        "bankApi.quoteMove" => amount(input).and_then(|a| {
            super::quote(
                d,
                user,
                text(input, "fromAccountId"),
                text(input, "toAccountId"),
                a,
            )
        }),
        "bankApi.move" => {
            super::make_move(d, user, text(input, "quoteId"), text(input, "dedupeId"))
        }
        "bankApi.createPayment" => amount(input).and_then(|a| {
            let r = input.get("recipient");
            super::create_payment(
                d,
                user,
                &PaymentAsk {
                    idempotency_key: text(input, "idempotencyKey"),
                    from_account_id: text(input, "fromAccountId"),
                    method: text(input, "method"),
                    recipient: Recipient {
                        name: text(r, "name").to_owned(),
                        account_number: text(r, "accountNumber").to_owned(),
                        routing_number: text(r, "routingNumber").to_owned(),
                    },
                    amount: a,
                },
            )
        }),
        "bankApi.payment" => super::get_payment(d, user, text(input, "paymentId")),
        "bankApi.payments" => super::list_payments(d, user, limit(input)),
        "bankApi.createWebhook" => {
            super::create_endpoint(d, user, text(input, "endpointId"), text(input, "url"))
        }
        "bankApi.webhooks" => super::list_endpoints(d, user, limit(input)),
        "bankApi.deliveries" => super::deliveries(
            d,
            user,
            input.get("endpointId").as_str(),
            input.get("paymentId").as_str(),
            limit(input),
        ),
        "testPartner.settlePayment" => {
            super::settle_test_payment(d, user, text(input, "paymentId"))
        }
        _ => return None,
    };
    Some(guard(out))
}
