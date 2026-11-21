//! The identity approval a venue door spends (`services/svc-matching/src/action-approval-consume.ts`).
//!
//! A typed-in second name is never approval: the door names an approval and its operation, matching binds them to the
//! action (`matchingActionPayloadHash`) and the target, and svc-identity consumes it once (`service_kit::approvals`).
//! The two people identity recorded must both be on the venue's own operator list (`MATCHING_OPERATOR_IDS`), and every
//! switch but the four protective brakes also needs identity's attestation that they are two founders.

use std::collections::HashSet;
use std::sync::Arc;

use service_kit::approvals::{ConsumeError, ConsumeInput, Consumed, IdentityClient};
use service_kit::http::Fetch;
use service_kit::schema::js_trim;

/// `ACTION_APPROVAL_UNWIRED`.
pub const UNWIRED: &str = "action_approval.identity_unwired";
/// `ACTION_APPROVAL_MISSING`.
pub const MISSING: &str = "action_approval.missing";
/// `ACTION_APPROVAL_NOT_FOUNDERS`.
pub const NOT_FOUNDERS: &str = "action_approval.not_founders";
/// `ACTION_APPROVAL_OPERATOR_MISMATCH`.
pub const OPERATOR_MISMATCH: &str = "action_approval.operator_not_requester";
/// `ACTION_APPROVAL_WRONG_ACTION`.
pub const WRONG_ACTION: &str = "action_approval.wrong_action";
/// `ACTION_APPROVAL_NOT_OPERATOR`.
pub const NOT_OPERATOR: &str = "action_approval.not_operator";
/// `ACTION_APPROVAL_OPERATORS_UNSET`.
pub const OPERATORS_UNSET: &str = "action_approval.operators_unset";
/// The consuming service, as identity binds the approval to it.
pub const TARGET_SERVICE: &str = "svc-matching";

/// Why no approval was spent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// `ActionApprovalConsumeError`: its message and code; the door answers 400 with both.
    Coded { message: String, code: String },
    /// What the client threw (no reply from identity): it escapes the door as Fastify's 500.
    Thrown(String),
}

impl Refused {
    pub fn coded(code: &str, message: impl Into<String>) -> Refused {
        Refused::Coded {
            message: message.into(),
            code: code.to_owned(),
        }
    }
}

/// `ActionApprovalConsumer`.
pub trait Approvals: Send + Sync {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused>;
}

/// `unwiredApprovalConsumer()`: no `IDENTITY_URL`, so nothing is ever approved.
pub struct Unwired;

impl Approvals for Unwired {
    fn consume(&self, _: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        Err(Refused::coded(
            UNWIRED,
            "IDENTITY_URL is unpublished; matching halt does not invent a second person",
        ))
    }
}

/// `createIdentityApprovalClient(IDENTITY_URL, INTERNAL_SERVICE_SECRET)` for svc-matching.
pub struct Identity(IdentityClient);

impl Identity {
    pub fn new(base_url: &str, secret: &str, fetch: Arc<dyn Fetch>, now: fn() -> i64) -> Identity {
        Identity(IdentityClient::new(
            TARGET_SERVICE,
            base_url,
            secret,
            fetch,
            now,
        ))
    }
}

impl Approvals for Identity {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.0.consume(input).map_err(|e| match e {
            ConsumeError::Refused(message) => Refused::Coded {
                message,
                code: service_kit::approvals::ACTION_APPROVAL_CONSUME_FAILED.to_owned(),
            },
            ConsumeError::Thrown(message) => Refused::Thrown(message),
        })
    }
}

/// `stubApprovalConsumer(approverId, requesterId)`: every approval consumes, for the action its target names, with
/// both people attested founders. For tests and the wire replay only.
pub struct Stub {
    pub approver_id: String,
    pub requester_id: String,
}

/// `matchingActionTypeForTarget`: `resume:BTC-USDT` is `matching.resume`, `halt_all` is `matching.halt_all`.
fn action_type_for_target(target_id: &str) -> String {
    let verb = target_id.split(':').next().unwrap_or(target_id);
    if verb.starts_with("matching.") {
        verb.to_owned()
    } else {
        format!("matching.{verb}")
    }
}

impl Approvals for Stub {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        Ok(Consumed {
            action_type: action_type_for_target(input.target_id),
            target_service: input.target_service.to_owned(),
            target_id: input.target_id.to_owned(),
            status: "CONSUMED".to_owned(),
            requester_id: self.requester_id.clone(),
            approver_id: Some(self.approver_id.clone()),
            approver_is_founder: Some(true),
            requester_is_founder: Some(true),
        })
    }
}

/// `parseOperatorIds(MATCHING_OPERATOR_IDS)`: comma separated, trimmed, lower case; blank is nobody.
pub fn parse_operator_ids(raw: Option<&str>) -> HashSet<String> {
    raw.unwrap_or("")
        .split(',')
        .map(|id| js_trim(id).to_lowercase())
        .filter(|id| !id.is_empty())
        .collect()
}

/// `sameUser`.
pub fn same_user(a: &str, b: &str) -> bool {
    js_trim(a).to_lowercase() == js_trim(b).to_lowercase()
}
