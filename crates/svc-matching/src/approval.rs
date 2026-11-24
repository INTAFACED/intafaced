//! The two-person approval a venue or founder door spends (`action-approval-consume.ts`, and `consumeVenueKill` in
//! `router.ts`). Two names typed in a body are attribution at most: the door names an approval and its operation,
//! binds them to the action (`matchingActionPayloadHash`) and its target, and svc-identity consumes it once
//! (`service_kit::approvals`). Both people must be on the venue's operator list (`MATCHING_OPERATOR_IDS`), the
//! typed operator must be the one identity recorded as asking, a distinct second person must have approved, and every
//! action but the protective brakes needs identity's attestation that the two are founders.
//!
//! The rulebook publish spends one here; the `venue` and `operator` slices' doors spend theirs through the same call.

use std::sync::Arc;

use service_kit::approvals::{
    ACTION_APPROVAL_CONSUME_FAILED, ConsumeError, ConsumeInput, Consumed, IdentityClient,
    founder_verdict, payload_hash,
};
use service_kit::http::Fetch;
use service_kit::s2s::{Mode, ServiceSigner};
use service_kit::schema::js_trim;

use crate::book::types::Reject;

/// The consuming service, as identity binds the approval to it.
pub const TARGET_SERVICE: &str = "svc-matching";
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
/// `MISSING_OPERATOR` (`halt.ts`).
pub const MISSING_OPERATOR: &str = "missing_operator";

/// Why a consume gave no approval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// `ActionApprovalConsumeError`: its code and message; the door answers 400 with both.
    Coded { code: String, message: String },
    /// What the client threw (no reply from identity, an input out of bounds): Fastify's 500.
    Thrown(String),
}

/// `ActionApprovalConsumer`.
pub trait Approvals: Send + Sync {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused>;
}

/// `unwiredApprovalConsumer()`: no `IDENTITY_URL`, so nothing is ever approved.
pub struct Unwired;

impl Approvals for Unwired {
    fn consume(&self, _: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        Err(Refused::Coded {
            code: UNWIRED.to_owned(),
            message: "IDENTITY_URL is unpublished; matching halt does not invent a second person"
                .to_owned(),
        })
    }
}

/// `createIdentityApprovalClient(IDENTITY_URL, INTERNAL_SERVICE_SECRET, s2sKey)` for svc-matching: signed with
/// svc-matching's own key when S2S gives it one (`tests/approval_keys.rs`), else with the shared secret.
pub struct Identity(IdentityClient);

impl Identity {
    pub fn new(
        base_url: &str,
        secret: &str,
        s2s: Option<(Arc<ServiceSigner>, Mode)>,
        fetch: Arc<dyn Fetch>,
        now: fn() -> i64,
    ) -> Identity {
        Identity(IdentityClient::new(TARGET_SERVICE, base_url, secret, fetch, now).with_key(s2s))
    }
}

impl Approvals for Identity {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.0.consume(input).map_err(|e| match e {
            ConsumeError::Refused(message) => Refused::Coded {
                code: ACTION_APPROVAL_CONSUME_FAILED.to_owned(),
                message,
            },
            ConsumeError::Thrown(message) => Refused::Thrown(message),
        })
    }
}

/// `stubApprovalConsumer(approverId, requesterId)`: every consume answers this pair, attested founders, for the
/// action its target names (`halt:BTC-USDT` is `matching.halt`). For tests and the wire replay's `set`.
pub struct Stub {
    pub approver_id: String,
    pub requester_id: String,
}

impl Approvals for Stub {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        let verb = input.target_id.split(':').next().unwrap_or_default();
        Ok(Consumed {
            action_type: if verb.starts_with("matching.") {
                verb.to_owned()
            } else {
                format!("matching.{verb}")
            },
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

/// `readOperatorId`: the id trimmed, or `None` when it is absent or blank.
pub fn read_operator_id(raw: Option<&str>) -> Option<String> {
    raw.map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `operatorRefuse(null)`.
pub fn operator_refuse() -> Reject {
    Reject::new(
        MISSING_OPERATOR,
        "operator identity is required; the engine does not invent a caller",
    )
}

/// `dualControlRefuse(operatorId, confirmOperatorId)`: two distinct operator identities, or why not.
pub fn dual_control_refuse(
    operator_id: Option<&str>,
    confirm_operator_id: Option<&str>,
) -> Option<Reject> {
    let Some(actor) = read_operator_id(operator_id) else {
        return Some(operator_refuse());
    };
    match read_operator_id(confirm_operator_id) {
        None => Some(Reject::new(
            MISSING_OPERATOR,
            "confirming operator identity is required; the engine does not invent a second caller",
        )),
        Some(confirm) if confirm == actor => Some(Reject::new(
            MISSING_OPERATOR,
            "confirming operator must be a distinct identity; the engine does not invent a second caller",
        )),
        Some(_) => None,
    }
}

/// `sameUser(a, b)`.
pub fn same_user(a: &str, b: &str) -> bool {
    js_trim(a).to_lowercase() == js_trim(b).to_lowercase()
}

/// `approvalEvidenceRef(approvalId)`: the consumed approval, as the evidence an emergency action needs.
pub fn evidence_ref(approval_id: &str) -> String {
    format!("action-approval:{approval_id}")
}

/// `matchingActionPayloadHash(actionType, fields)`.
pub fn action_payload_hash(action_type: &str, fields: &[(&str, &str)]) -> String {
    payload_hash(action_type, fields)
}

/// The two people a consumed approval names, and its evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorized {
    pub operator_id: String,
    pub confirm_operator_id: String,
    pub evidence_refs: Vec<String>,
}

/// Why a door spends no approval, as the door answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denied {
    /// No operator named: 200, `accepted: false`, with the typed names.
    Refused {
        operator_id: Option<String>,
        confirm_operator_id: Option<String>,
        rejected: Reject,
    },
    /// `ActionApprovalConsumeError`: 400 with its code and message.
    Bad { code: String, message: String },
    /// What the client threw: Fastify's 500.
    Thrown(String),
}

/// What a door asks to spend.
pub struct Spend<'a> {
    /// The operator acting: the body's `operatorId`, or the founder principal's user id.
    pub operator_id: Option<&'a str>,
    /// The typed second name, kept only to answer a refusal with.
    pub confirm_typed: Option<&'a str>,
    pub approval_id: Option<&'a str>,
    pub operation_id: Option<&'a str>,
    pub action_type: &'a str,
    pub fields: &'a [(&'a str, &'a str)],
    pub target_id: &'a str,
}

fn bad(code: &str, message: impl Into<String>) -> Denied {
    Denied::Bad {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// `consumeVenueKill(parsed, actionType, fields, targetId)`: in the TypeScript's order, the operator, the approval's
/// ids, the operator list, the consume, then what identity answered.
pub fn spend(
    approvals: &dyn Approvals,
    operator_ids: &[String],
    s: &Spend<'_>,
) -> Result<Authorized, Denied> {
    let Some(operator_id) = read_operator_id(s.operator_id) else {
        return Err(Denied::Refused {
            operator_id: None,
            confirm_operator_id: read_operator_id(s.confirm_typed),
            rejected: operator_refuse(),
        });
    };
    let approval_id = s.approval_id.map(js_trim).unwrap_or_default();
    let operation_id = s.operation_id.map(js_trim).unwrap_or_default();
    if approval_id.is_empty() || operation_id.is_empty() {
        return Err(bad(
            MISSING,
            "approvalId and operationId are required; a typed-in second name is not approval",
        ));
    }
    if operator_ids.is_empty() {
        return Err(bad(
            OPERATORS_UNSET,
            "MATCHING_OPERATOR_IDS is unpublished; matching does not guess who is an operator",
        ));
    }
    let is_operator = |id: &str| {
        let id = js_trim(id).to_lowercase();
        operator_ids.contains(&id)
    };
    if !is_operator(&operator_id) {
        return Err(bad(
            NOT_OPERATOR,
            "the requester is not an operator of this venue",
        ));
    }
    let hash = payload_hash(s.action_type, s.fields);
    let consumed = approvals
        .consume(&ConsumeInput {
            approval_id,
            operation_id,
            payload_hash: &hash,
            target_service: TARGET_SERVICE,
            target_id: s.target_id,
            expected_version: "1",
            replay: None,
        })
        .map_err(|e| match e {
            Refused::Coded { code, message } => Denied::Bad { code, message },
            Refused::Thrown(message) => Denied::Thrown(message),
        })?;
    if consumed.action_type != s.action_type
        || consumed.target_service != TARGET_SERVICE
        || consumed.target_id != s.target_id
        || consumed.status != "CONSUMED"
    {
        return Err(bad(
            WRONG_ACTION,
            format!(
                "the approval is not for {} on {}",
                s.action_type, s.target_id
            ),
        ));
    }
    if !same_user(&consumed.requester_id, &operator_id) {
        return Err(bad(
            OPERATOR_MISMATCH,
            "operatorId is not the person who proposed this approval",
        ));
    }
    let approver_id = match &consumed.approver_id {
        Some(a) if !same_user(a, &consumed.requester_id) => a.clone(),
        _ => return Err(bad(MISSING, "the approval has no distinct approver")),
    };
    if !is_operator(&consumed.requester_id) || !is_operator(&approver_id) {
        return Err(bad(
            NOT_OPERATOR,
            "both the proposer and the approver must be operators of this venue",
        ));
    }
    match founder_verdict(&consumed, s.action_type, TARGET_SERVICE, s.target_id) {
        None => {}
        Some("missing") => {
            return Err(bad(
                NOT_FOUNDERS,
                "a founder-audience action needs identity to attest that the proposer and the approver are both founders",
            ));
        }
        Some(_) => {
            return Err(bad(
                NOT_FOUNDERS,
                "the founder attestation does not match a distinct founder pair for this action",
            ));
        }
    }
    Ok(Authorized {
        operator_id: consumed.requester_id,
        confirm_operator_id: approver_id,
        evidence_refs: vec![evidence_ref(approval_id)],
    })
}
