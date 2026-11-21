//! The real [`Approvals`] port: svc-identity's `actionApproval.consume`, as `createIdentityApprovalClient` in
//! `packages/contracts/src/action-approval-client.ts` calls it for svc-academy (`action-approval-consume.ts`, wired in
//! `index.ts` whenever `IDENTITY_URL` is set). The client is the kit's (`service_kit::approvals`): one POST signed
//! with the shared secret (svc-academy passes no S2S signer), bounded by a 5 s timeout, counted only when the reply is
//! the request's approval `CONSUMED`. Its refusal is `action_approval.consume_failed`; a call that got no reply fails
//! as `fetch` threw, which the guard answers as a 500.

use std::sync::Arc;

use service_kit::approvals::{
    ACTION_APPROVAL_CONSUME_FAILED, ConsumeError, ConsumeInput, IdentityClient, Seconds,
};
use service_kit::http::Fetch;

use crate::errors::Refusal;
use crate::ports::{ApprovalConsume, Approvals, ConsumedApproval};

pub struct IdentityApprovals(IdentityClient);

impl IdentityApprovals {
    /// `createIdentityApprovalClient(IDENTITY_URL, INTERNAL_SERVICE_SECRET)` for svc-academy.
    pub fn new(
        base_url: &str,
        secret: &str,
        fetch: Arc<dyn Fetch>,
        now: Seconds,
    ) -> IdentityApprovals {
        IdentityApprovals(IdentityClient::new(
            "svc-academy",
            base_url,
            secret,
            fetch,
            now,
        ))
    }
}

impl Approvals for IdentityApprovals {
    fn consume(&self, input: &ApprovalConsume) -> Result<ConsumedApproval, Refusal> {
        let consumed = self
            .0
            .consume(&ConsumeInput {
                approval_id: &input.approval_id,
                operation_id: &input.operation_id,
                payload_hash: &input.payload_hash,
                target_service: input.target_service,
                target_id: &input.target_id,
                expected_version: input.expected_version,
            })
            .map_err(|e| match e {
                ConsumeError::Refused(message) => Refusal::Approval {
                    message,
                    code: ACTION_APPROVAL_CONSUME_FAILED.to_owned(),
                },
                ConsumeError::Thrown(message) => Refusal::Internal {
                    message,
                    code: None,
                },
            })?;
        Ok(ConsumedApproval {
            requester_id: consumed.requester_id,
            approver_id: consumed.approver_id,
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]

    use std::sync::Mutex;

    use service_kit::http::{FetchError, HttpRequest, HttpResponse};
    use service_kit::json::Json;

    use super::*;

    struct Fake(Result<HttpResponse, FetchError>, Mutex<Vec<HttpRequest>>);

    impl Fetch for Fake {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.1.lock().unwrap().push(req.clone());
            self.0.clone()
        }
    }

    fn input() -> ApprovalConsume {
        ApprovalConsume {
            approval_id: "ap-1".to_owned(),
            operation_id: "op-1".to_owned(),
            payload_hash: "sha256:abc".to_owned(),
            target_service: "svc-academy",
            target_id: "academy.season.create".to_owned(),
            expected_version: "1",
        }
    }

    fn approvals(reply: Result<HttpResponse, FetchError>) -> (IdentityApprovals, Arc<Fake>) {
        let fake = Arc::new(Fake(reply, Mutex::new(Vec::new())));
        (
            IdentityApprovals::new(
                "http://identity:4002/",
                "an-academy-identity-approval-test-secret",
                fake.clone(),
                || 0,
            ),
            fake,
        )
    }

    #[test]
    fn the_kit_client_is_called_as_svc_academy_and_its_people_come_back() {
        let approval = Json::obj([
            ("approvalId", Json::str("ap-1")),
            ("actionType", Json::str("academy.season.create")),
            ("targetService", Json::str("svc-academy")),
            ("targetId", Json::str("academy.season.create")),
            ("expectedVersion", Json::str("1")),
            ("payloadHash", Json::str("sha256:abc")),
            ("requesterId", Json::str("req")),
            ("approverId", Json::str("appr")),
            ("policyVersion", Json::str("v1")),
            ("createdAt", Json::str("2026-09-09T12:00:00.000Z")),
            ("expiresAt", Json::str("2026-09-09T12:10:00.000Z")),
            ("status", Json::str("CONSUMED")),
            ("operationId", Json::str("op-1")),
        ]);
        let body = Json::obj([("result", Json::obj([("data", approval)]))]).compact();
        let (c, fake) = approvals(Ok(HttpResponse { status: 200, body }));
        assert_eq!(
            c.consume(&input()).unwrap(),
            ConsumedApproval {
                requester_id: "req".to_owned(),
                approver_id: Some("appr".to_owned()),
            }
        );
        let seen = fake.1.lock().unwrap();
        assert!(
            seen[0]
                .headers
                .iter()
                .any(|(k, v)| k == service_kit::s2s::SERVICE_HEADER && v == "svc-academy"),
            "{:?}",
            seen[0].headers
        );
    }

    #[test]
    fn a_refusal_is_consume_failed_and_no_reply_is_internal() {
        let (c, _) = approvals(Ok(HttpResponse {
            status: 503,
            body: String::new(),
        }));
        assert_eq!(
            c.consume(&input()).unwrap_err(),
            Refusal::Approval {
                message: "identity refused consume (503)".to_owned(),
                code: ACTION_APPROVAL_CONSUME_FAILED.to_owned(),
            }
        );
        let (c, _) = approvals(Err(FetchError {
            message: "fetch failed".to_owned(),
        }));
        assert_eq!(
            c.consume(&input()).unwrap_err(),
            Refusal::Internal {
                message: "fetch failed".to_owned(),
                code: None,
            }
        );
    }
}
