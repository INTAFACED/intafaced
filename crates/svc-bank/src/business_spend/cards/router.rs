//! `businessCards.*` (`router/business-cards.router.ts`), each answered through the router's guard, with the
//! money-out step-up where the TypeScript asks it (`reimbursementPayBinding`).

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::service::{self as svc, ClaimAsk, IssueAsk, PurchaseAsk, ReceiptAsk};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::transfers::Deps;
use crate::transfers::step_up::{self, Binding};

/// `reimbursementPayBinding`: one approval for one claim, by its approver.
pub fn reimbursement_pay_binding(actor: &str, claim_id: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.businessCards.approveAndPay",
        operation_key: claim_id.to_owned(),
        fields: vec![
            ("actor".to_owned(), actor.to_owned()),
            ("claimId".to_owned(), claim_id.to_owned()),
        ],
    }
}

/// `businessCards.*`; `None` for a call outside it.
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
    let receipt = || ReceiptAsk {
        actor: user,
        receipt_id: text("receiptId"),
        file_name: text("fileName"),
        content_type: text("contentType"),
        content_base64: text("contentBase64"),
    };
    Some(match ctx.call.path {
        "businessCards.overview" => svc::overview(d, text("accountId"), user),
        "businessCards.issueCard" => svc::issue_card(
            d,
            &IssueAsk {
                account_id: text("accountId"),
                actor: user,
                card_id: text("cardId"),
                member_user_id: text("memberUserId"),
                per_purchase_limit: text("perPurchaseLimit"),
            },
        ),
        "businessCards.testPurchase" => svc::test_purchase(
            d,
            &PurchaseAsk {
                card_id: text("cardId"),
                actor: user,
                purchase_id: text("purchaseId"),
                merchant: text("merchant"),
                amount: text("amount"),
            },
        ),
        "businessCards.decideLimitRequest" => svc::decide_limit_request(
            d,
            text("purchaseId"),
            user,
            matches!(input.get("approve"), Value::Bool(true)),
        ),
        "businessCards.setPolicy" => {
            svc::set_policy(d, text("accountId"), user, text("receiptOver"))
        }
        "businessCards.attachReceipt" => svc::attach_receipt(d, text("purchaseId"), &receipt()),
        "businessCards.receiptsZip" => svc::receipts_zip(d, text("accountId"), user),
        "businessCards.submitClaim" => svc::submit_claim(
            d,
            &ClaimAsk {
                account_id: text("accountId"),
                claim_id: text("claimId"),
                amount: text("amount"),
                description: text("description"),
                receipt: receipt(),
            },
        ),
        "businessCards.approveAndPay" => (|| {
            if step_up::enforced(d) {
                let Some(p) = principal else {
                    return Err(Refusal::Other(
                        "a step-up call with no principal".to_owned(),
                    ));
                };
                step_up::require(
                    d,
                    p,
                    &reimbursement_pay_binding(user, text("claimId")),
                    input.get("stepUpApprovalId").as_str(),
                )?;
            }
            svc::approve_and_pay(d, text("claimId"), user)
        })(),
        _ => return None,
    })
}
