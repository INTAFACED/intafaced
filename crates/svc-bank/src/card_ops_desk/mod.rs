//! Slice `card-ops`, the operator's desk (`router/ops.router.ts`): one authorisation for compliance
//! (`ops.authorizationGet`), one customer's cards (`ops.customerCards`), support's side of a card dispute
//! (`ops.cardDisputes`, `ops.cardDispute`, `ops.cardDisputeOpen`, `ops.cardDisputeEvidence`,
//! `ops.cardDisputeRepresentment`, `ops.cardDisputeArbitration`, `ops.cardDisputeCredit`, `ops.cardDisputeDecide`), the
//! card partner's terms as an operator reads them (`ops.cardPartnerTerms`), the pay-from reconciliation
//! (`ops.cardPayFromReconciliation`) and the operator's freeze (`ops.setCardStatus`); svc-ops' read of any reserve a
//! partner holds of ours (`POST /internal/capital/partner-reserves`, `reserves`); and the TEST card partner's own book
//! on loopback (`/test-card-partner/*`, `record`).
//!
//! - `reads`: the authorisation and the customer's cards, each read written to the audit line first.
//! - `disputes`: support's steps on the case the cardholder's side shares (`cards::disputes`: its case, timeline, open,
//!   evidence and close are that module's, reached from here, never copied).
//! - `programme`: the partner's terms, the reconciliation and the operator's freeze.
//! - `reserves`, `record`: the two REST doors.
//!
//! Nothing here posts to the ledger: a provisional credit and a decision are the card partner's to carry out, and the
//! reconciliation and the reserves are reads. The freeze consumes the second person's approval (`ops_approval`) after
//! its own checks and a replay, before it writes. The card moves (authorise, capture, reverse, resume, 3D Secure, the
//! cashback pot) are the slice's other half; a path this module does not hold answers `None`.

pub mod disputes;
pub mod programme;
pub mod reads;
pub mod record;
pub mod reserves;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::cards::Deps;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};

pub(crate) fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

pub(crate) fn opt_text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

/// The answer of one of the desk's calls, by its path; `None` for a path outside it.
fn call(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let dispute = text(input, "disputeId");
    Some(match ctx.call.path {
        "ops.authorizationGet" => reads::authorization_get(d, user, text(input, "id")),
        "ops.customerCards" => reads::customer_cards(
            d,
            user,
            text(input, "userId"),
            input.get("limit").as_number(),
        ),
        "ops.cardDisputes" => disputes::list(d, opt_text(input, "state")),
        "ops.cardDispute" => disputes::get(d, dispute),
        "ops.cardDisputeOpen" => disputes::open(
            d,
            &crate::cards::disputes::OpenAsk {
                case_key: text(input, "caseKey"),
                card_id: text(input, "cardId"),
                authorization_ref: text(input, "authorizationRef"),
                amount: text(input, "amount"),
                reason: text(input, "reason"),
                actor: user,
            },
        ),
        "ops.cardDisputeEvidence" => disputes::add_evidence(
            d,
            dispute,
            text(input, "stepKey"),
            text(input, "description"),
            user,
        ),
        "ops.cardDisputeRepresentment" => disputes::submit_representment(
            d,
            dispute,
            text(input, "stepKey"),
            text(input, "description"),
            user,
        ),
        "ops.cardDisputeArbitration" => {
            disputes::escalate_to_arbitration(d, dispute, text(input, "stepKey"), user)
        }
        "ops.cardDisputeCredit" => disputes::grant_provisional_credit(d, dispute, user, d.issuer()),
        "ops.cardDisputeDecide" => disputes::decide(
            d,
            dispute,
            text(input, "outcome"),
            user,
            opt_text(input, "reason"),
        ),
        "ops.cardPartnerTerms" => programme::partner_terms(d),
        "ops.cardPayFromReconciliation" => {
            let holds = crate::cards::reads::test_card_holds(d, &d.w.holds);
            programme::pay_from_reconciliation(
                d,
                holds
                    .as_ref()
                    .map(|h| h as &dyn crate::cards::reads::HoldReads),
            )
        }
        "ops.setCardStatus" => programme::set_card_status(d, input),
        _ => return None,
    })
}

/// The desk's answer at the door; `None` for a path outside it (the slice's card moves, not held here).
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let out = call(d, ctx)?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
