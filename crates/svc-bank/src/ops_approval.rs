//! The operator's second person (`action-approval-consume.ts`: `consumeBankOpsApproval`, `consumeBankOpsApprovalPair`):
//! every `ops.*` call that changes an owner value consumes an identity-issued approval bound to its action and every
//! field it changes, founder-audience, before it writes. One way for every slice that has such a call.

use service_kit::approvals::{ConsumeError, ConsumeInput, founder_verdict};
use service_kit::money::js_trim;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::errors::Refusal;
use crate::transfers::Approvals;
use crate::transfers::step_up::payload_hash;

/// What identity answers with no `IDENTITY_URL` (`unpublishedActionApprovals`).
const UNWIRED: &str = "IDENTITY_URL is unpublished; bank ops do not invent a second person";

/// The second person's approval, as `consumeBankOpsApprovalPair` answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approved {
    pub approval_id: String,
    pub requester_id: String,
    pub approver_id: String,
}

/// `ActionApprovalConsumeError`: the guard's 412 with the error's own words, its code as the cause.
fn approval_refused(message: impl Into<String>, code: &str) -> Refusal {
    Refusal::Trpc(TrpcError::caused(
        "PRECONDITION_FAILED",
        message.into(),
        code.to_owned(),
    ))
}

/// `consumeBankOpsApprovalPair`: the approval and operation ids are required; identity consumes the approval bound to
/// the action and its fields; the founder pair is attested; the approver is named. `consumeBankOpsApproval` is this,
/// read for its `approver_id`.
pub fn consume(
    approvals: &dyn Approvals,
    input: &Value,
    action: &str,
    fields: &[(String, String)],
) -> Result<Approved, Refusal> {
    let approval_id = js_trim(input.get("approvalId").as_str().unwrap_or_default());
    let operation_id = js_trim(input.get("operationId").as_str().unwrap_or_default());
    if approval_id.is_empty() || operation_id.is_empty() {
        return Err(approval_refused(
            "approvalId and operationId are required; a typed-in second name is not approval",
            "action_approval.missing",
        ));
    }
    let hash = payload_hash(action, fields);
    let consumed = approvals
        .consume(
            &ConsumeInput {
                approval_id,
                operation_id,
                payload_hash: &hash,
                target_service: "svc-bank",
                target_id: action,
                expected_version: "1",
                replay: None,
            },
            None,
        )
        .map(|(c, _)| c)
        .map_err(|e| match e {
            ConsumeError::Refused(m) if m == UNWIRED => {
                approval_refused(m, "action_approval.identity_unwired")
            }
            ConsumeError::Refused(m) => approval_refused(m, "action_approval.consume_failed"),
            ConsumeError::Thrown(m) => Refusal::Other(m),
        })?;
    match founder_verdict(&consumed, action, "svc-bank", action) {
        None => {}
        Some("missing") => {
            return Err(approval_refused(
                "a founder-audience action needs identity to attest that the proposer and the approver are both founders",
                "action_approval.not_founders",
            ));
        }
        Some(_) => {
            return Err(approval_refused(
                "the founder attestation does not match a distinct founder pair for this action",
                "action_approval.not_founders",
            ));
        }
    }
    let Some(approver_id) = consumed.approver_id.filter(|a| !a.is_empty()) else {
        return Err(approval_refused(
            "consumed approval has no approver; a typed-in name is not approval",
            "action_approval.consume_failed",
        ));
    };
    Ok(Approved {
        approval_id: approval_id.to_owned(),
        requester_id: consumed.requester_id,
        approver_id,
    })
}
