//! The real [`Approvals`] port: svc-identity's `actionApproval.consume`, as `createIdentityApprovalClient` in
//! `packages/contracts/src/action-approval-client.ts` calls it for svc-academy (`action-approval-consume.ts`, wired in
//! `index.ts` whenever `IDENTITY_URL` is set).
//!
//! One POST of the checked consume input, signed with the shared secret (svc-academy passes no S2S signer), bounded
//! by a 5 s timeout. The reply counts only when it is an action approval, `CONSUMED`, and echoes the request
//! (approval, operation, payload hash, target, version). Any other reply refuses as `action_approval.consume_failed`;
//! a call that got no reply fails as `fetch` threw, which the guard answers as a 500.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::{self, js_length};
use service_kit::time::zod_datetime;

use crate::errors::Refusal;
use crate::ports::{ApprovalConsume, Approvals, ConsumedApproval};

/// `IDENTITY_CONSUME_TIMEOUT_MS`.
pub const IDENTITY_CONSUME_TIMEOUT_MS: u64 = 5000;
/// `ACTION_APPROVAL_CONSUME_FAILED`.
pub const ACTION_APPROVAL_CONSUME_FAILED: &str = "action_approval.consume_failed";
/// `REFUSAL_DETAIL_MAX`.
const REFUSAL_DETAIL_MAX: usize = 300;

/// The service's clock in whole seconds, for the signature's timestamp.
pub type Seconds = fn() -> i64;

pub struct IdentityApprovals {
    url: String,
    service: String,
    secret: String,
    fetch: Arc<dyn Fetch>,
    now: Seconds,
}

impl IdentityApprovals {
    /// `createIdentityApprovalClient(IDENTITY_URL, INTERNAL_SERVICE_SECRET)` for svc-academy.
    pub fn new(
        base_url: &str,
        secret: &str,
        fetch: Arc<dyn Fetch>,
        now: Seconds,
    ) -> IdentityApprovals {
        IdentityApprovals {
            url: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            service: "svc-academy".to_owned(),
            secret: secret.to_owned(),
            fetch,
            now,
        }
    }
}

fn fail(message: impl Into<String>) -> Refusal {
    Refusal::Approval {
        message: message.into(),
        code: ACTION_APPROVAL_CONSUME_FAILED.to_owned(),
    }
}

/// `z.string().min(1).max(max)`, lengths in UTF-16 code units.
fn bounded(s: &str, max: usize) -> bool {
    (1..=max).contains(&js_length(s))
}

/// `actionApprovalConsumeInputSchema.parse(input)` and `JSON.stringify` of what it returns: the six fields in schema
/// order. A field out of bounds is the ZodError the guard answers as a 500.
fn consume_payload(input: &ApprovalConsume) -> Result<String, Refusal> {
    let fields = [
        ("approvalId", input.approval_id.as_str(), 128),
        ("operationId", input.operation_id.as_str(), 128),
        ("payloadHash", input.payload_hash.as_str(), 128),
        ("targetService", input.target_service, 64),
        ("targetId", input.target_id.as_str(), 256),
        ("expectedVersion", input.expected_version, 128),
    ];
    for (name, value, max) in fields {
        if !bounded(value, max) {
            return Err(Refusal::Internal {
                message: format!("the approval consume input's {name} is out of bounds"),
                code: None,
            });
        }
    }
    Ok(Json::Object(
        fields
            .iter()
            .map(|(k, v, _)| ((*k).to_owned(), Json::str(*v)))
            .collect(),
    )
    .compact())
}

/// `refusalDetail(text)`: tRPC's `error.message` (or the text itself when it is not JSON), first line, trimmed, cut at
/// 300 UTF-16 units with an ellipsis.
pub fn refusal_detail(text: &str) -> String {
    let message = match json::parse(text) {
        Ok(body) => {
            let first = match &body {
                Json::Array(a) => a.first().cloned().unwrap_or(Json::Null),
                other => other.clone(),
            };
            let error = first.get("error");
            error
                .and_then(|e| e.get("message"))
                .or_else(|| {
                    error
                        .and_then(|e| e.get("json"))
                        .and_then(|j| j.get("message"))
                })
                .or_else(|| first.get("message"))
                .cloned()
        }
        Err(_) => Some(Json::str(text)),
    };
    let detail = match message {
        Some(Json::String(s)) => s
            .split('\n')
            .next()
            .map(|l| service_kit::schema::js_trim(l).to_owned())
            .unwrap_or_default(),
        _ => String::new(),
    };
    let units: Vec<u16> = detail.encode_utf16().collect();
    if units.len() > REFUSAL_DETAIL_MAX {
        format!(
            "{}…",
            String::from_utf16_lossy(units.get(..REFUSAL_DETAIL_MAX).unwrap_or_default())
        )
    } else {
        detail
    }
}

/// `unwrapTrpcData(body)`: `result.data` (or the body), and its `json` when superjson wrapped it.
fn unwrap_trpc_data(body: Json) -> Json {
    let data = match body.get("result").and_then(|r| r.get("data")) {
        Some(d) => d.clone(),
        None => body,
    };
    match data.get("json") {
        Some(j) => j.clone(),
        None => data,
    }
}

fn str_field<'a>(o: &'a Json, key: &str, max: usize) -> Option<&'a str> {
    match o.get(key)? {
        Json::String(s) if bounded(s, max) => Some(s),
        _ => None,
    }
}

/// An optional field: absent, or of the shape `ok` accepts.
fn optional(o: &Json, key: &str, ok: impl Fn(&Json) -> bool) -> bool {
    o.get(key).is_none_or(ok)
}

fn int_at_least(j: &Json, min: f64) -> bool {
    matches!(j, Json::Number(n) if n.fract() == 0.0 && n.is_finite() && *n >= min)
}

/// `actionApprovalSchema.safeParse(raw)`: the fields this client reads, or `None` when the reply is not an approval.
struct Approval<'a> {
    approval_id: &'a str,
    target_service: &'a str,
    target_id: &'a str,
    expected_version: &'a str,
    payload_hash: &'a str,
    requester_id: &'a str,
    approver_id: Option<&'a str>,
    status: &'a str,
    operation_id: &'a str,
}

fn read_approval(o: &Json) -> Option<Approval<'_>> {
    if !matches!(o, Json::Object(_)) {
        return None;
    }
    let approver_id = match o.get("approverId")? {
        Json::Null => None,
        Json::String(s) if bounded(s, 128) => Some(s.as_str()),
        _ => return None,
    };
    let datetime =
        |key: &str| matches!(o.get(key), Some(Json::String(s)) if zod_datetime(s, true).is_some());
    let status = match o.get("status")? {
        Json::String(s)
            if [
                "PENDING", "APPROVED", "CONSUMED", "REJECTED", "EXPIRED", "REVOKED",
            ]
            .contains(&s.as_str()) =>
        {
            s.as_str()
        }
        _ => return None,
    };
    let approval = Approval {
        approval_id: str_field(o, "approvalId", 128)?,
        target_service: str_field(o, "targetService", 64)?,
        target_id: str_field(o, "targetId", 256)?,
        expected_version: str_field(o, "expectedVersion", 128)?,
        payload_hash: str_field(o, "payloadHash", 128)?,
        requester_id: str_field(o, "requesterId", 128)?,
        approver_id,
        status,
        operation_id: str_field(o, "operationId", 128)?,
    };
    str_field(o, "actionType", 128)?;
    str_field(o, "policyVersion", 128)?;
    let shapes = datetime("createdAt")
        && datetime("expiresAt")
        && optional(
            o,
            "kind",
            |j| matches!(j, Json::String(s) if s == "four_eyes" || s == "same_person"),
        )
        && optional(o, "approverIsFounder", |j| matches!(j, Json::Bool(_)))
        && optional(o, "requesterIsFounder", |j| matches!(j, Json::Bool(_)))
        && optional(
            o,
            "consumedAt",
            |j| matches!(j, Json::String(s) if zod_datetime(s, true).is_some()),
        )
        && optional(
            o,
            "consumedByRequestId",
            |j| matches!(j, Json::String(s) if bounded(s, 128)),
        )
        && optional(
            o,
            "consumption",
            |j| matches!(j, Json::String(s) if s == "already_consumed_by_this_request"),
        )
        && optional(o, "approvalsRequired", |j| int_at_least(j, 1.0))
        && optional(o, "approvalsGiven", |j| int_at_least(j, 0.0));
    shapes.then_some(approval)
}

impl Approvals for IdentityApprovals {
    fn consume(&self, input: &ApprovalConsume) -> Result<ConsumedApproval, Refusal> {
        let payload = consume_payload(input)?;
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(
            s2s::legacy_headers(&self.service, &self.secret, &payload, (self.now)()).map_err(
                |message| Refusal::Internal {
                    message,
                    code: None,
                },
            )?,
        );
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{}/trpc/actionApproval.consume", self.url),
                headers,
                body: Some(payload),
                timeout_ms: Some(IDENTITY_CONSUME_TIMEOUT_MS),
                refuse_redirect: false,
            })
            .map_err(|e| Refusal::Internal {
                message: e.message,
                code: None,
            })?;
        if !res.ok() {
            let detail = refusal_detail(&res.body);
            return Err(fail(
                service_kit::schema::js_trim(&format!(
                    "identity refused consume ({}) {detail}",
                    res.status
                ))
                .to_owned(),
            ));
        }
        let raw = json::parse(&res.body)
            .map(unwrap_trpc_data)
            .map_err(|_| fail("identity consume result is not JSON"))?;
        let approval = read_approval(&raw)
            .ok_or_else(|| fail("identity consume result is not an action approval"))?;
        if approval.status != "CONSUMED"
            || approval.approval_id != input.approval_id
            || approval.operation_id != input.operation_id
            || approval.payload_hash != input.payload_hash
            || approval.target_service != input.target_service
            || approval.target_id != input.target_id
            || approval.expected_version != input.expected_version
        {
            return Err(fail(
                "identity consume result does not match the request or is not CONSUMED",
            ));
        }
        Ok(ConsumedApproval {
            requester_id: approval.requester_id.to_owned(),
            approver_id: approval.approver_id.map(str::to_owned),
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]

    use std::sync::Mutex;

    use service_kit::http::{FetchError, HttpResponse};

    use super::*;

    struct Fake {
        reply: Result<HttpResponse, FetchError>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl Fetch for Fake {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.seen.lock().unwrap().push(req.clone());
            self.reply.clone()
        }
    }

    const SECRET: &str = "an-academy-identity-approval-test-secret";

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

    fn approval(status: &str, approver: Json) -> Json {
        Json::Object(
            [
                ("approvalId", Json::str("ap-1")),
                ("actionType", Json::str("academy.season.create")),
                ("targetService", Json::str("svc-academy")),
                ("targetId", Json::str("academy.season.create")),
                ("expectedVersion", Json::str("1")),
                ("payloadHash", Json::str("sha256:abc")),
                ("requesterId", Json::str("req")),
                ("approverId", approver),
                ("policyVersion", Json::str("v1")),
                ("createdAt", Json::str("2026-09-09T12:00:00.000Z")),
                ("expiresAt", Json::str("2026-09-09T12:10:00.000Z")),
                ("status", Json::str(status)),
                ("operationId", Json::str("op-1")),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
        )
    }

    fn client(status: u16, body: String) -> (IdentityApprovals, Arc<Fake>) {
        let fake = Arc::new(Fake {
            reply: Ok(HttpResponse { status, body }),
            seen: Mutex::new(Vec::new()),
        });
        (
            IdentityApprovals::new("http://identity:4002/", SECRET, fake.clone(), || {
                1_700_000_000
            }),
            fake,
        )
    }

    fn trpc(data: Json) -> String {
        Json::obj([("result", Json::obj([("data", data)]))]).compact()
    }

    #[test]
    fn a_consumed_echo_answers_its_people_and_the_request_is_the_typescripts() {
        let (c, fake) = client(200, trpc(approval("CONSUMED", Json::str("appr"))));
        let got = c.consume(&input()).unwrap();
        assert_eq!(got.requester_id, "req");
        assert_eq!(got.approver_id.as_deref(), Some("appr"));
        let seen = fake.seen.lock().unwrap();
        let req = &seen[0];
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, "http://identity:4002/trpc/actionApproval.consume");
        assert_eq!(req.timeout_ms, Some(5000));
        let body = req.body.clone().unwrap();
        assert_eq!(
            body,
            r#"{"approvalId":"ap-1","operationId":"op-1","payloadHash":"sha256:abc","targetService":"svc-academy","targetId":"academy.season.create","expectedVersion":"1"}"#
        );
        let mut want = vec![("content-type".to_owned(), "application/json".to_owned())];
        want.extend(s2s::legacy_headers("svc-academy", SECRET, &body, 1_700_000_000).unwrap());
        assert_eq!(req.headers, want);
    }

    #[test]
    fn a_superjson_wrapped_reply_and_a_null_approver_are_read() {
        let (c, _) = client(
            200,
            trpc(Json::obj([("json", approval("CONSUMED", Json::Null))])),
        );
        assert_eq!(c.consume(&input()).unwrap().approver_id, None);
    }

    #[test]
    fn every_other_reply_refuses_as_consume_failed() {
        let refused = |status: u16, body: String| {
            let (c, _) = client(status, body);
            match c.consume(&input()) {
                Err(Refusal::Approval { message, code }) => {
                    assert_eq!(code, ACTION_APPROVAL_CONSUME_FAILED);
                    message
                }
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(
            refused(
                412,
                r#"{"error":{"message":"approval is spent [action_approval.consumed]\nstack","code":-32012}}"#.to_owned()
            ),
            "identity refused consume (412) approval is spent [action_approval.consumed]"
        );
        assert_eq!(
            refused(503, String::new()),
            "identity refused consume (503)"
        );
        assert_eq!(
            refused(200, "nope".to_owned()),
            "identity consume result is not JSON"
        );
        assert_eq!(
            refused(200, trpc(Json::obj([("approvalId", Json::str("ap-1"))]))),
            "identity consume result is not an action approval"
        );
        assert_eq!(
            refused(200, trpc(approval("APPROVED", Json::str("appr")))),
            "identity consume result does not match the request or is not CONSUMED"
        );
        let mut other_target = approval("CONSUMED", Json::str("appr"));
        if let Json::Object(f) = &mut other_target {
            for (k, v) in f.iter_mut() {
                if k == "payloadHash" {
                    *v = Json::str("sha256:other");
                }
            }
        }
        assert_eq!(
            refused(200, trpc(other_target)),
            "identity consume result does not match the request or is not CONSUMED"
        );
    }

    #[test]
    fn no_reply_is_the_thrown_fetch_and_a_long_detail_is_cut() {
        let fake = Arc::new(Fake {
            reply: Err(FetchError {
                message: "fetch failed".to_owned(),
            }),
            seen: Mutex::new(Vec::new()),
        });
        let c = IdentityApprovals::new("http://identity", SECRET, fake, || 0);
        assert!(
            matches!(c.consume(&input()), Err(Refusal::Internal { message, .. }) if message == "fetch failed")
        );
        let long = "x".repeat(400);
        assert_eq!(refusal_detail(&long), format!("{}…", "x".repeat(300)));
        assert_eq!(
            refusal_detail(r#"[{"error":{"json":{"message":"m"}}}]"#),
            "m"
        );
    }
}
