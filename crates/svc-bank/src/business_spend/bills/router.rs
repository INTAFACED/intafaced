//! `businessBills.*` (`router/business-bills.router.ts`), each answered through the router's guard, and the job doors
//! `bill-pay/{run-due,returned}` (`index.ts`'s `jobDoor`: the body's check, the work, a `BankError` as 400).

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::tokens::is_guid;
use service_kit::trpc::TrpcError;

use super::service::{
    self as svc, BILL_RETURN_REASONS, Limits, MAX_BILL_BYTES, PayAsk, ReviewAsk, SplitLine,
    UploadAsk,
};
use crate::door::Ctx;
use crate::door::jobs::{job_failed, ok};
use crate::door::rest::reply;
use crate::errors::{Refusal, to_trpc};
use crate::partner::refuse;
use crate::transfers::Deps;
use crate::transfers::step_up::{self, Binding};

/// `/internal/jobs/bill-pay/run-due`.
pub const BILL_PAY_RUN_DUE: &str = "/internal/jobs/bill-pay/run-due";
/// `/internal/jobs/bill-pay/returned`.
pub const BILL_PAY_RETURNED: &str = "/internal/jobs/bill-pay/returned";

fn amount_of(v: &Value) -> Result<Amount, Refusal> {
    parse_amount(v.as_str().unwrap_or_default()).map_err(Refusal::Other)
}

fn amount_or_none(v: &Value) -> Result<Option<Amount>, Refusal> {
    v.as_str()
        .map(|s| parse_amount(s).map_err(Refusal::Other))
        .transpose()
}

/// `billPayBinding`: the payment's own id is its operation key.
fn bill_pay_binding(actor: &str, bill_id: &str, payment_id: &str, scheduled_for: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.businessBills.pay",
        operation_key: payment_id.to_owned(),
        fields: [
            ("actor", actor),
            ("billId", bill_id),
            ("paymentId", payment_id),
            ("scheduledFor", scheduled_for),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect(),
    }
}

/// `businessBills.*`; `None` for a call outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let out = handle(d, ctx)?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

fn handle(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let principal = ctx.principal;
    let user = principal.map(|p| p.user_id.as_str()).unwrap_or_default();
    let text = |k: &str| input.get(k).as_str().unwrap_or_default();
    let opt = |k: &str| input.get(k).as_str();
    Some(match ctx.call.path {
        "businessBills.list" => svc::bills(d, text("accountId"), user),
        "businessBills.get" => svc::bill(d, text("billId"), user),
        "businessBills.settings" => svc::settings(d, text("accountId"), user),
        "businessBills.upload" => (|| {
            let file = svc::decode_base64(text("contentBase64"));
            if file.is_empty() || file.len() > MAX_BILL_BYTES {
                return Err(refuse(
                    "bank.bill_file_invalid",
                    "A bill file is 1 byte to 1 MiB.",
                ));
            }
            svc::upload(
                d,
                &UploadAsk {
                    account_id: text("accountId"),
                    user_id: user,
                    bill_id: text("billId"),
                    file_name: text("fileName"),
                    content_type: text("contentType"),
                    file: &file,
                },
            )
        })(),
        "businessBills.review" => (|| {
            svc::review(
                d,
                &ReviewAsk {
                    bill_id: text("billId"),
                    user_id: user,
                    vendor: opt("vendor"),
                    reference: opt("reference"),
                    amount: amount_or_none(input.get("amount"))?,
                    due_date: opt("dueDate"),
                },
            )
        })(),
        "businessBills.clearDuplicate" => svc::clear_duplicate(d, text("billId"), user),
        "businessBills.setVendor" => (|| {
            svc::set_vendor(
                d,
                text("accountId"),
                user,
                text("name"),
                amount_of(input.get("cap"))?,
            )
        })(),
        "businessBills.setLimits" => (|| {
            svc::set_limits(
                d,
                text("accountId"),
                user,
                Limits {
                    per_payment: amount_or_none(input.get("perPayment"))?,
                    daily: amount_or_none(input.get("daily"))?,
                    monthly: amount_or_none(input.get("monthly"))?,
                },
            )
        })(),
        "businessBills.submit" => svc::submit(d, text("billId"), user),
        "businessBills.approve" => svc::approve(d, text("billId"), user),
        "businessBills.pay" => (|| {
            if step_up::enforced(d) {
                let Some(p) = principal else {
                    return Err(Refusal::Other(
                        "a step-up call with no principal".to_owned(),
                    ));
                };
                step_up::require(
                    d,
                    p,
                    &bill_pay_binding(
                        user,
                        text("billId"),
                        text("paymentId"),
                        opt("scheduledFor").unwrap_or(""),
                    ),
                    opt("stepUpApprovalId"),
                )?;
            }
            let mut splits = Vec::new();
            for line in input.get("splits").as_array().unwrap_or_default() {
                splits.push(SplitLine {
                    category: line.get("category").as_str().unwrap_or_default().to_owned(),
                    amount: amount_of(line.get("amount"))?,
                });
            }
            svc::pay(
                d,
                &PayAsk {
                    bill_id: text("billId"),
                    user_id: user,
                    payment_id: text("paymentId"),
                    scheduled_for: opt("scheduledFor"),
                    splits: &splits,
                },
            )
        })(),
        "businessBills.resend" => svc::resend(d, text("paymentId"), user),
        "businessBills.cancel" => svc::cancel(d, text("paymentId"), user),
        _ => return None,
    })
}

fn fields(body: &Value) -> Option<&[(String, Value)]> {
    match body {
        Value::Undefined | Value::Null => Some(&[]),
        Value::Object(f) => Some(f),
        _ => None,
    }
}

/// `z.object({ limit: z.number().int().min(1).max(500) }).strict()`.
fn run_due_body(body: &Value) -> Option<i64> {
    let mut limit = None;
    for (k, v) in fields(body)? {
        match (k.as_str(), v) {
            ("limit", Value::Number(n)) if n.fract() == 0.0 && (1.0..=500.0).contains(n) => {
                #[allow(clippy::cast_possible_truncation, reason = "a whole number 1 to 500")]
                let whole = *n as i64;
                limit = Some(whole);
            }
            _ => return None,
        }
    }
    limit
}

/// `z.object({ paymentId: z.string().guid(), reason: z.enum(BILL_RETURN_REASONS) }).strict()`.
fn returned_body(body: &Value) -> Option<(String, String)> {
    let (mut payment_id, mut reason) = (None, None);
    for (k, v) in fields(body)? {
        let Value::String(s) = v else { return None };
        match k.as_str() {
            "paymentId" if is_guid(s) => payment_id = Some(s.clone()),
            "reason" if BILL_RETURN_REASONS.contains(&s.as_str()) => reason = Some(s.clone()),
            _ => return None,
        }
    }
    Some((payment_id?, reason?))
}

fn not_in_shape() -> Response {
    reply(400, "body not in shape", "bank.validation_failed")
}

/// `POST /internal/jobs/bill-pay/{run-due,returned}` past the signature; `None` for another path.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    Some(match path {
        BILL_PAY_RUN_DUE => match run_due_body(body) {
            None => not_in_shape(),
            Some(limit) => match svc::run_due(d, limit) {
                Ok(r) => ok(&r.json()),
                Err(r) => job_failed(r),
            },
        },
        BILL_PAY_RETURNED => match returned_body(body) {
            None => not_in_shape(),
            Some((payment_id, reason)) => match svc::returned(d, &payment_id, &reason) {
                Ok(b) => ok(&b),
                Err(r) => job_failed(r),
            },
        },
        _ => return None,
    })
}
