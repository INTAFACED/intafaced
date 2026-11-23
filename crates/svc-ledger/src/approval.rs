//! The identity approval an operator write spends (`services/svc-ledger/src/ledger/action-approval-consume.ts`).
//!
//! The ledger never takes a typed-in second name: the operator door names an approval and its operation, the ledger
//! binds them to the action (`ledgerActionPayloadHash`), the target and the version it read, and svc-identity consumes
//! it once (`service_kit::approvals`). Freezing is a protective brake any operator may pull with an approval; every
//! other action (the thaw) also needs identity's attestation that the proposer and the approver are two founders.

use std::sync::Arc;

use service_kit::approvals::{
    ACTION_APPROVAL_CONSUME_FAILED, ConsumeError, ConsumeInput, Consumed, IdentityClient, Replay,
};
use service_kit::http::Fetch;
use service_kit::schema::js_trim;

/// `ACTION_APPROVAL_UNWIRED`.
pub const UNWIRED: &str = "action_approval.identity_unwired";
/// `ACTION_APPROVAL_MISSING`.
pub const MISSING: &str = "action_approval.missing";
/// `ACTION_APPROVAL_NOT_FOUNDERS`.
pub const NOT_FOUNDERS: &str = "action_approval.not_founders";
/// The consuming service, as identity binds the approval to it.
pub const TARGET_SERVICE: &str = "svc-ledger";

/// Why no approval was spent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// `ActionApprovalConsumeError`: its message and code; the door answers 400 with both.
    Coded { message: String, code: String },
    /// What the client threw (no reply from identity); the door's catch-all.
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
            message: "IDENTITY_URL is unpublished; operator freeze does not invent a second person"
                .to_owned(),
            code: UNWIRED.to_owned(),
        })
    }
}

/// `createIdentityApprovalClient(IDENTITY_URL, INTERNAL_SERVICE_SECRET)` for svc-ledger.
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
                code: ACTION_APPROVAL_CONSUME_FAILED.to_owned(),
            },
            ConsumeError::Thrown(message) => Refused::Thrown(message),
        })
    }
}

/// `ledgerActionPayloadHash`, `isProtectiveOperatorApproval` and `founderAttestationVerdict`: the kit's, shared with
/// every service that consumes an approval.
pub use service_kit::approvals::{founder_verdict, is_protective, payload_hash};

/// `consumeLedgerApproval(approvals, cmd, actionType, targetId, expectedVersion, fields, requestId, consumerPrincipalId)`:
/// the ids trimmed and required, the approval consumed for this action (with the replay key when `replay` names a
/// non-blank one: the freeze doors send none, a metadata delete sends its operation and operator), then the founder
/// attestation, fail closed, on a replay too.
pub fn consume_ledger_approval(
    approvals: &dyn Approvals,
    (approval_id, operation_id): (&str, &str),
    action_type: &str,
    target_id: &str,
    expected_version: &str,
    fields: &[(&str, &str)],
    replay: Option<(&str, &str)>,
) -> Result<Consumed, Refused> {
    let (approval_id, operation_id) = (js_trim(approval_id), js_trim(operation_id));
    let (request_id, consumer) = replay.map_or(("", ""), |(r, c)| (js_trim(r), js_trim(c)));
    if !request_id.is_empty() && consumer.is_empty() {
        return Err(Refused::Coded {
            message: "a replayable consume must name the operator who consumes it".to_owned(),
            code: MISSING.to_owned(),
        });
    }
    if approval_id.is_empty() || operation_id.is_empty() {
        return Err(Refused::Coded {
            message:
                "approvalId and operationId are required; a typed-in second name is not approval"
                    .to_owned(),
            code: MISSING.to_owned(),
        });
    }
    let hash = payload_hash(action_type, fields);
    let consumed = approvals.consume(&ConsumeInput {
        approval_id,
        operation_id,
        payload_hash: &hash,
        target_service: TARGET_SERVICE,
        target_id,
        expected_version,
        replay: (!request_id.is_empty()).then_some(Replay {
            request_id,
            consumer_principal_id: Some(consumer),
        }),
    })?;
    assert_founders(&consumed, action_type, target_id)?;
    Ok(consumed)
}

/// `assertFounderAudienceAttestation(consumed, { actionType, targetService: 'svc-ledger', targetId })`: fail closed
/// unless identity attested a distinct founder pair (a protective brake needs none).
pub fn assert_founders(
    consumed: &Consumed,
    action_type: &str,
    target_id: &str,
) -> Result<(), Refused> {
    match founder_verdict(consumed, action_type, TARGET_SERVICE, target_id) {
        None => Ok(()),
        Some(reason) => Err(Refused::Coded {
            message: if reason == "missing" {
                "a founder-audience action needs identity to attest that the proposer and the approver are both founders"
            } else {
                "the founder attestation does not match a distinct founder pair for this action"
            }
            .to_owned(),
            code: NOT_FOUNDERS.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use std::sync::Mutex;

    use super::*;

    /// `stubApprovalConsumer(approverId)`, recording what it was asked, with the founder flags it is given.
    struct Stub {
        seen: Mutex<Vec<String>>,
        flags: (Option<bool>, Option<bool>),
        requester: &'static str,
    }

    impl Approvals for Stub {
        fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
            self.seen.lock().unwrap().push(format!("{input:?}"));
            let action_type = input
                .target_id
                .strip_prefix("posting_")
                .map_or_else(|| input.target_id.to_owned(), |v| format!("ledger.{v}"));
            Ok(Consumed {
                action_type,
                target_service: input.target_service.to_owned(),
                target_id: input.target_id.to_owned(),
                status: "CONSUMED".to_owned(),
                requester_id: self.requester.to_owned(),
                approver_id: Some("approver".to_owned()),
                approver_is_founder: self.flags.0,
                requester_is_founder: self.flags.1,
            })
        }
    }

    fn stub(flags: (Option<bool>, Option<bool>), requester: &'static str) -> Stub {
        Stub {
            seen: Mutex::new(Vec::new()),
            flags,
            requester,
        }
    }

    #[test]
    fn the_payload_hash_is_the_typescripts() {
        // `ledgerActionPayloadHash('ledger.freeze', { reason: 'operator halt drill' })`, from node.
        assert_eq!(
            payload_hash("ledger.freeze", &[("reason", "operator halt drill")]),
            "sha256:52c827f0d09b6b7c8ef449d60584d4132c47283a032b46eba9b5ed49aa766c10"
        );
    }

    #[test]
    fn a_freeze_needs_no_founders_and_a_thaw_needs_two() {
        let none = stub((None, None), "requester");
        assert!(
            consume_ledger_approval(
                &none,
                (" a1 ", "o1"),
                "ledger.freeze",
                "posting_freeze",
                "v",
                &[],
                None,
            )
            .is_ok()
        );
        assert!(none.seen.lock().unwrap()[0].contains("approval_id: \"a1\""));
        let refused = |s: &Stub| {
            consume_ledger_approval(
                s,
                ("a1", "o1"),
                "ledger.unfreeze",
                "posting_unfreeze",
                "v",
                &[],
                None,
            )
            .unwrap_err()
        };
        assert_eq!(
            refused(&none),
            Refused::Coded {
                message: "a founder-audience action needs identity to attest that the proposer and the approver are both founders".to_owned(),
                code: NOT_FOUNDERS.to_owned(),
            }
        );
        let forged = Refused::Coded {
            message:
                "the founder attestation does not match a distinct founder pair for this action"
                    .to_owned(),
            code: NOT_FOUNDERS.to_owned(),
        };
        assert_eq!(
            refused(&stub((Some(true), Some(false)), "requester")),
            forged
        );
        assert_eq!(
            refused(&stub((Some(true), Some(true)), " APPROVER ")),
            forged
        );
        assert!(
            consume_ledger_approval(
                &stub((Some(true), Some(true)), "requester"),
                ("a1", "o1"),
                "ledger.unfreeze",
                "posting_unfreeze",
                "v",
                &[],
                None,
            )
            .is_ok()
        );
    }

    #[test]
    fn blank_ids_are_not_an_approval_and_unwired_refuses() {
        let none = stub((None, None), "r");
        assert_eq!(
            consume_ledger_approval(
                &none,
                ("a1", "  "), "ledger.freeze", "posting_freeze", "v", &[], None),
            Err(Refused::Coded {
                message: "approvalId and operationId are required; a typed-in second name is not approval".to_owned(),
                code: MISSING.to_owned(),
            })
        );
        assert!(none.seen.lock().unwrap().is_empty());
        assert!(matches!(
            consume_ledger_approval(
                &Unwired,
                ("a1", "o1"), "ledger.freeze", "posting_freeze", "v", &[], None),
            Err(Refused::Coded { code, .. }) if code == UNWIRED
        ));
    }

    #[test]
    fn only_the_named_brakes_are_protective() {
        assert!(is_protective(
            " Ledger.Freeze ",
            "svc-ledger",
            "POSTING_FREEZE"
        ));
        assert!(is_protective(
            "matching.halt",
            "svc-matching",
            "halt:market-1"
        ));
        assert!(!is_protective(
            "ledger.freeze",
            "svc-matching",
            "posting_freeze"
        ));
        assert!(!is_protective(
            "ledger.unfreeze",
            "svc-ledger",
            "posting_unfreeze"
        ));
    }
}
