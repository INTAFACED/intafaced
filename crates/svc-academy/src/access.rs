//! The Academy's own access checks beyond the door's scopes and jurisdiction (`service_kit::access`): the operator
//! approval an approval-gated call checks before its slice runs (`consumeApproval` in `router.ts`).
//!
//! The order is the TypeScript's: an operator identity, then a session that passed two-factor (`requireMfa`), then
//! both approval ids (`readApprovalIds`). Only then does the slice consume the approval at svc-identity
//! ([`crate::ports::Approvals`]) with the action's payload hash ([`payload_hash`]); a slice whose call is not flagged
//! approval-gated in the door table (`createSeason`, `revokeCert`, `grantCertException`) runs
//! [`approval_precheck`] itself at the point its TypeScript handler does.

use sha2::{Digest, Sha256};

use service_kit::access::require_mfa;
use service_kit::edge::Principal;
use service_kit::json::{self, Json};
use service_kit::schema::{Value, js_trim};
use service_kit::trpc::TrpcError;

use crate::errors::Refusal;

/// `ACTION_APPROVAL_MISSING`.
pub const ACTION_APPROVAL_MISSING: &str = "action_approval.missing";
/// `ACTION_APPROVAL_UNWIRED`.
pub const ACTION_APPROVAL_UNWIRED: &str = "action_approval.unwired";

/// The two ids an operator brings from svc-identity's approval, trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalIds {
    pub approval_id: String,
    pub operation_id: String,
}

/// `readApprovalIds(input)`: both ids, trimmed, or the refusal for a missing one.
pub fn read_approval_ids(input: &Value) -> Result<ApprovalIds, Refusal> {
    let id = |key: &str| {
        input
            .get(key)
            .as_str()
            .map(|s| js_trim(s).to_owned())
            .unwrap_or_default()
    };
    let (approval_id, operation_id) = (id("approvalId"), id("operationId"));
    if approval_id.is_empty() || operation_id.is_empty() {
        return Err(Refusal::Approval {
            message:
                "approvalId and operationId are required; a typed-in second name is not approval"
                    .to_owned(),
            code: ACTION_APPROVAL_MISSING.to_owned(),
        });
    }
    Ok(ApprovalIds {
        approval_id,
        operation_id,
    })
}

/// `consumeApproval`'s checks before the consume: an operator, two-factor, both ids.
pub fn approval_precheck(
    principal: Option<&Principal>,
    input: &Value,
) -> Result<ApprovalIds, Refusal> {
    let Some(p) = principal else {
        return Err(Refusal::DualControl(
            "operator identity is required; the academy ambassador door does not invent a caller"
                .to_owned(),
        ));
    };
    require_mfa(p).map_err(|r| Refusal::Trpc(TrpcError::guard(r)))?;
    read_approval_ids(input)
}

/// `academyActionPayloadHash(actionType, fields)`: `sha256:` and the hex digest of `JSON.stringify({actionType,
/// ...fields})`.
pub fn payload_hash(action_type: &str, fields: &[(&str, &str)]) -> String {
    let mut all = vec![("actionType".to_owned(), Json::str(action_type))];
    for (k, v) in fields {
        match all.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = Json::str(*v),
            None => all.push(((*k).to_owned(), Json::str(*v))),
        }
    }
    let payload = Json::Object(json::js_key_order(all)).compact();
    let digest = Sha256::digest(payload.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ids_are_trimmed_and_a_blank_one_refuses() {
        let input = Value::Object(vec![
            ("approvalId".to_owned(), Value::String(" a ".to_owned())),
            ("operationId".to_owned(), Value::String("\u{a0}".to_owned())),
        ]);
        assert!(matches!(
            read_approval_ids(&input),
            Err(Refusal::Approval { .. })
        ));
        let ok = Value::Object(vec![
            ("approvalId".to_owned(), Value::String(" a ".to_owned())),
            ("operationId".to_owned(), Value::String("b".to_owned())),
        ]);
        assert_eq!(
            read_approval_ids(&ok).map(|i| i.approval_id),
            Ok("a".to_owned())
        );
    }

    #[test]
    fn the_payload_hash_is_the_typescripts() {
        // node -e "console.log(require('crypto').createHash('sha256').update(JSON.stringify({actionType:'academy.ambassador.freeze',userId:'u'})).digest('hex'))"
        assert_eq!(
            payload_hash("academy.ambassador.freeze", &[("userId", "u")]),
            "sha256:086bb024e6bf1254ef86b5eee2f783288c18b983dee9acbd30e499eeb61722f1"
        );
    }
}
