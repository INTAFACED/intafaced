//! Identity's action-bound approvals, as matching spends them (`action-approval-consume.ts` and the router's
//! `consumeVenueKill`). Two names typed into one body are attribution at most: a door that needs two people spends one
//! single-use approval svc-identity issued for exactly this action, target and payload, proposed by the operator who
//! calls and approved by a second, distinct operator. Both must be on the venue's published operator list
//! (`MATCHING_OPERATOR_IDS`); an empty list lets no one act. An action that is not a protective brake also needs
//! identity's attestation that both are founders.
//!
//! The consumer is a part handed in once ([`ApprovalConsumer`]); with no `IDENTITY_URL` it is [`Unwired`], which
//! refuses every approval.

use service_kit::json::Json;
use sha2::{Digest, Sha256};

pub const ACTION_APPROVAL_UNWIRED: &str = "action_approval.identity_unwired";
pub const ACTION_APPROVAL_MISSING: &str = "action_approval.missing";
pub const ACTION_APPROVAL_NOT_FOUNDERS: &str = "action_approval.not_founders";
pub const ACTION_APPROVAL_OPERATOR_MISMATCH: &str = "action_approval.operator_not_requester";
pub const ACTION_APPROVAL_WRONG_ACTION: &str = "action_approval.wrong_action";
pub const ACTION_APPROVAL_NOT_OPERATOR: &str = "action_approval.not_operator";
pub const ACTION_APPROVAL_OPERATORS_UNSET: &str = "action_approval.operators_unset";

/// `ActionApprovalConsumeError`: a code and its message, answered as a 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumeError {
    pub code: String,
    pub message: String,
}

impl ConsumeError {
    pub fn new(code: &str, message: impl Into<String>) -> ConsumeError {
        ConsumeError {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

/// What a door asks identity to consume (`ActionApprovalConsumeInput`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumeInput {
    pub approval_id: String,
    pub operation_id: String,
    pub payload_hash: String,
    pub target_service: String,
    pub target_id: String,
    pub expected_version: String,
}

/// A consumed approval as identity answers it (`ActionApproval`), as far as matching reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionApproval {
    pub approval_id: String,
    pub action_type: String,
    pub target_service: String,
    pub target_id: String,
    pub requester_id: String,
    pub approver_id: Option<String>,
    pub status: String,
    pub approver_is_founder: Option<bool>,
    pub requester_is_founder: Option<bool>,
}

/// Spends one approval at svc-identity.
pub trait ApprovalConsumer {
    fn consume(&self, input: &ConsumeInput) -> Result<ActionApproval, ConsumeError>;
}

/// `unwiredApprovalConsumer`: no `IDENTITY_URL`, so no approval is ever spent.
pub struct Unwired;

impl ApprovalConsumer for Unwired {
    fn consume(&self, _: &ConsumeInput) -> Result<ActionApproval, ConsumeError> {
        Err(ConsumeError::new(
            ACTION_APPROVAL_UNWIRED,
            "IDENTITY_URL is unpublished; matching halt does not invent a second person",
        ))
    }
}

/// `stubApprovalConsumer(approverId, requesterId)`: every approval consumes, for the action its target names, proposed
/// and approved by these two founders. For tests and the wire replay only.
pub struct Stub {
    pub approver_id: String,
    pub requester_id: String,
}

impl ApprovalConsumer for Stub {
    fn consume(&self, input: &ConsumeInput) -> Result<ActionApproval, ConsumeError> {
        let verb = input
            .target_id
            .split_once(':')
            .map_or(input.target_id.as_str(), |(v, _)| v);
        let action_type = if verb.starts_with("matching.") {
            verb.to_owned()
        } else {
            format!("matching.{verb}")
        };
        Ok(ActionApproval {
            approval_id: input.approval_id.clone(),
            action_type,
            target_service: input.target_service.clone(),
            target_id: input.target_id.clone(),
            requester_id: self.requester_id.clone(),
            approver_id: Some(self.approver_id.clone()),
            status: "CONSUMED".to_owned(),
            approver_is_founder: Some(true),
            requester_is_founder: Some(true),
        })
    }
}

/// `matchingActionPayloadHash`: `sha256:` and the hex digest of `JSON.stringify({ actionType, ...fields })`.
pub fn payload_hash(action_type: &str, fields: &[(&str, String)]) -> String {
    let mut o = vec![("actionType".to_owned(), Json::str(action_type))];
    for (k, v) in fields {
        o.push(((*k).to_owned(), Json::str(v.clone())));
    }
    let digest = Sha256::digest(Json::Object(o).compact().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

/// `sameUser`.
pub fn same_user(a: &str, b: &str) -> bool {
    norm(a) == norm(b)
}

fn norm(s: &str) -> String {
    service_kit::schema::js_trim(s).to_lowercase()
}

/// The brakes identity's founder attestation does not cover (`PROTECTIVE_OPERATOR_APPROVALS`, matching's rows).
const PROTECTIVE: [(&str, &str); 4] = [
    ("matching.halt", "halt"),
    ("matching.halt_all", "halt_all"),
    ("matching.reduce_only", "reduce_only"),
    ("matching.post_only", "post_only"),
];

/// `founderAttestationVerdict`'s refusal for this action, or none.
fn founder_refusal(
    row: &ActionApproval,
    action_type: &str,
    target_id: &str,
) -> Option<ConsumeError> {
    let target = norm(target_id);
    let verb = target.split_once(':').map_or(target.as_str(), |(v, _)| v);
    let ty = norm(action_type);
    if PROTECTIVE.iter().any(|(t, v)| *t == ty && *v == verb) {
        return None;
    }
    let trim = service_kit::schema::js_trim;
    let distinct = row.approver_id.as_deref().map(trim).is_some_and(|a| {
        !a.is_empty() && a.to_lowercase() != trim(&row.requester_id).to_lowercase()
    });
    let forged = row.status != "CONSUMED"
        || trim(&row.target_service) != "svc-matching"
        || trim(&row.target_id) != trim(target_id)
        || norm(&row.action_type) != ty
        || !distinct;
    let missing = row.approver_is_founder.is_none() && row.requester_is_founder.is_none();
    if !forged && missing {
        return Some(ConsumeError::new(
            ACTION_APPROVAL_NOT_FOUNDERS,
            "a founder-audience action needs identity to attest that the proposer and the approver are both founders",
        ));
    }
    if forged || row.approver_is_founder != Some(true) || row.requester_is_founder != Some(true) {
        return Some(ConsumeError::new(
            ACTION_APPROVAL_NOT_FOUNDERS,
            "the founder attestation does not match a distinct founder pair for this action",
        ));
    }
    None
}

/// What a door's approval came to (`consumeVenueKill`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Authz {
    /// Spent: the proposer and the approver, as identity recorded them.
    Approved {
        operator_id: String,
        confirm_operator_id: String,
        evidence_refs: Vec<String>,
    },
    /// No operator named: answered as a 200 refusal, with the names the body typed.
    Refused {
        operator_id: Option<String>,
        confirm_operator_id: Option<String>,
        code: String,
        message: String,
    },
    /// The approval does not stand: answered as a 400.
    Invalid(ConsumeError),
}

/// The body's own parts a door spends an approval with.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApprovalBody {
    pub operator_id: Option<String>,
    pub confirm_operator_id: Option<String>,
    pub approval_id: Option<String>,
    pub operation_id: Option<String>,
}

fn trimmed(v: Option<&String>) -> Option<String> {
    v.map(|s| service_kit::schema::js_trim(s).to_owned())
        .filter(|s| !s.is_empty())
}

/// Spend the approval for `action_type` on `target_id`, binding `fields`. `operator_ids` is the published list,
/// trimmed and lower-cased.
pub fn consume_venue_action(
    approvals: &dyn ApprovalConsumer,
    operator_ids: &[String],
    body: &ApprovalBody,
    action_type: &str,
    fields: &[(&str, String)],
    target_id: &str,
) -> Authz {
    let operator = trimmed(body.operator_id.as_ref());
    let confirm = trimmed(body.confirm_operator_id.as_ref());
    let Some(operator) = operator else {
        return Authz::Refused {
            operator_id: None,
            confirm_operator_id: confirm,
            code: "missing_operator".to_owned(),
            message: "operator identity is required; the engine does not invent a caller"
                .to_owned(),
        };
    };
    let is_operator = |id: &str| operator_ids.iter().any(|o| *o == norm(id));
    let invalid = |code: &str, message: String| Authz::Invalid(ConsumeError::new(code, message));
    let ids = (
        trimmed(body.approval_id.as_ref()),
        trimmed(body.operation_id.as_ref()),
    );
    let (Some(approval_id), Some(operation_id)) = ids else {
        return invalid(
            ACTION_APPROVAL_MISSING,
            "approvalId and operationId are required; a typed-in second name is not approval"
                .to_owned(),
        );
    };
    // Stop before the single-use approval is spent: no operator list, or a typed name that is not on it.
    if operator_ids.is_empty() {
        return invalid(
            ACTION_APPROVAL_OPERATORS_UNSET,
            "MATCHING_OPERATOR_IDS is unpublished; matching does not guess who is an operator"
                .to_owned(),
        );
    }
    if !is_operator(&operator) {
        return invalid(
            ACTION_APPROVAL_NOT_OPERATOR,
            "the requester is not an operator of this venue".to_owned(),
        );
    }
    let consumed = match approvals.consume(&ConsumeInput {
        approval_id,
        operation_id,
        payload_hash: payload_hash(action_type, fields),
        target_service: "svc-matching".to_owned(),
        target_id: target_id.to_owned(),
        expected_version: "1".to_owned(),
    }) {
        Ok(c) => c,
        Err(e) => return Authz::Invalid(e),
    };
    // The approval must be for exactly this door and target: identity stores the label the proposer typed.
    if consumed.action_type != action_type
        || consumed.target_service != "svc-matching"
        || consumed.target_id != target_id
        || consumed.status != "CONSUMED"
    {
        return invalid(
            ACTION_APPROVAL_WRONG_ACTION,
            format!("the approval is not for {action_type} on {target_id}"),
        );
    }
    if !same_user(&consumed.requester_id, &operator) {
        return invalid(
            ACTION_APPROVAL_OPERATOR_MISMATCH,
            "operatorId is not the person who proposed this approval".to_owned(),
        );
    }
    // Never fall back to the requester: a second person approved, or nothing runs.
    let approver = match &consumed.approver_id {
        Some(a) if !same_user(a, &consumed.requester_id) => a.clone(),
        _ => {
            return invalid(
                ACTION_APPROVAL_MISSING,
                "the approval has no distinct approver".to_owned(),
            );
        }
    };
    if !is_operator(&consumed.requester_id) || !is_operator(&approver) {
        return invalid(
            ACTION_APPROVAL_NOT_OPERATOR,
            "both the proposer and the approver must be operators of this venue".to_owned(),
        );
    }
    if let Some(e) = founder_refusal(&consumed, action_type, target_id) {
        return Authz::Invalid(e);
    }
    Authz::Approved {
        operator_id: consumed.requester_id.clone(),
        confirm_operator_id: approver,
        evidence_refs: vec![format!("action-approval:{}", consumed.approval_id)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_hash_is_over_the_action_and_its_fields_in_order() {
        // `matchingActionPayloadHash('matching.halt', { marketId: 'BTC-USDT' })` from the TypeScript.
        let h = payload_hash("matching.halt", &[("marketId", "BTC-USDT".to_owned())]);
        let expect = Sha256::digest(br#"{"actionType":"matching.halt","marketId":"BTC-USDT"}"#);
        let hex: String = expect.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(h, format!("sha256:{hex}"));
    }
}
