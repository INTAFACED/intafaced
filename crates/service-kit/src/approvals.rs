//! svc-identity's `actionApproval.consume`, as `createIdentityApprovalClient` in
//! `packages/contracts/src/action-approval-client.ts` calls it for a service that passes no S2S signer.
//!
//! One POST of the checked consume input, signed with the shared secret, bounded by a 5 s timeout. The reply counts
//! only when it is an action approval, `CONSUMED`, and echoes the request (approval, operation, payload hash, target,
//! version). Any other reply refuses as `action_approval.consume_failed` ([`ConsumeError::Refused`]); a call that got
//! no reply, or an input out of bounds, is what `fetch` or zod threw ([`ConsumeError::Thrown`]). Each service maps
//! the two onto its own refusals.

use std::sync::Arc;

use crate::http::{Fetch, HttpRequest};
use crate::json::{self, Json};
use crate::s2s::{self, js_length};
use crate::time::zod_datetime;

/// `IDENTITY_CONSUME_TIMEOUT_MS`.
pub const IDENTITY_CONSUME_TIMEOUT_MS: u64 = 5000;
/// `ACTION_APPROVAL_CONSUME_FAILED`.
pub const ACTION_APPROVAL_CONSUME_FAILED: &str = "action_approval.consume_failed";
/// `REFUSAL_DETAIL_MAX`.
const REFUSAL_DETAIL_MAX: usize = 300;

/// `ActionApprovalConsumeInput`: the six fields, in schema order, and the replay key when the consume has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumeInput<'a> {
    pub approval_id: &'a str,
    pub operation_id: &'a str,
    pub payload_hash: &'a str,
    pub target_service: &'a str,
    pub target_id: &'a str,
    pub expected_version: &'a str,
    /// `requestId` and `consumerPrincipalId`: the same key after a lost reply answers the first consume again.
    pub replay: Option<Replay<'a>>,
}

/// A replayable consume's key and the operator who consumes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Replay<'a> {
    pub request_id: &'a str,
    pub consumer_principal_id: &'a str,
}

/// The fields of the consumed `ActionApproval` a service reads after the echo check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consumed {
    pub action_type: String,
    pub target_service: String,
    pub target_id: String,
    pub status: String,
    pub requester_id: String,
    pub approver_id: Option<String>,
    /// Identity's founder attestation; absent when identity did not send it.
    pub approver_is_founder: Option<bool>,
    pub requester_is_founder: Option<bool>,
}

/// Why a consume did not answer an approval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsumeError {
    /// `opts.fail(message, ACTION_APPROVAL_CONSUME_FAILED)`: identity answered, and not with this approval consumed.
    Refused(String),
    /// What `fetch` or the input's `parse` threw.
    Thrown(String),
}

/// The service's clock in whole seconds, for the signature's timestamp.
pub type Seconds = fn() -> i64;

/// `createIdentityApprovalClient({ service, baseUrl, internalSecret, fail })`.
pub struct IdentityClient {
    url: String,
    service: String,
    secret: String,
    fetch: Arc<dyn Fetch>,
    now: Seconds,
}

/// `z.string().min(1).max(max)`, lengths in UTF-16 code units.
fn bounded(s: &str, max: usize) -> bool {
    (1..=max).contains(&js_length(s))
}

/// `actionApprovalConsumeInputSchema.parse(input)` and `JSON.stringify` of what it returns.
fn consume_payload(input: &ConsumeInput<'_>) -> Result<String, ConsumeError> {
    let mut fields = vec![
        ("approvalId", input.approval_id, 128),
        ("operationId", input.operation_id, 128),
        ("payloadHash", input.payload_hash, 128),
        ("targetService", input.target_service, 64),
        ("targetId", input.target_id, 256),
        ("expectedVersion", input.expected_version, 128),
    ];
    if let Some(r) = input.replay {
        fields.push(("requestId", r.request_id, 128));
        fields.push(("consumerPrincipalId", r.consumer_principal_id, 128));
    }
    for &(name, value, max) in &fields {
        if !bounded(value, max) {
            return Err(ConsumeError::Thrown(format!(
                "the approval consume input's {name} is out of bounds"
            )));
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
            .map(|l| crate::schema::js_trim(l).to_owned())
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

fn str_field(o: &Json, key: &str, max: usize) -> Option<String> {
    match o.get(key)? {
        Json::String(s) if bounded(s, max) => Some(s.clone()),
        _ => None,
    }
}

/// An optional field: absent, or of the shape `ok` accepts.
fn optional(o: &Json, key: &str, ok: impl Fn(&Json) -> bool) -> bool {
    o.get(key).is_none_or(ok)
}

fn optional_bool(o: &Json, key: &str) -> Option<Option<bool>> {
    match o.get(key) {
        None => Some(None),
        Some(Json::Bool(b)) => Some(Some(*b)),
        Some(_) => None,
    }
}

fn int_at_least(j: &Json, min: f64) -> bool {
    matches!(j, Json::Number(n) if n.fract() == 0.0 && n.is_finite() && *n >= min)
}

/// `actionApprovalSchema.safeParse(raw)`: the approval and its echo fields, or `None` when the reply is not one.
struct Approval {
    consumed: Consumed,
    approval_id: String,
    operation_id: String,
    payload_hash: String,
    expected_version: String,
}

fn read_approval(o: &Json) -> Option<Approval> {
    if !matches!(o, Json::Object(_)) {
        return None;
    }
    let approver_id = match o.get("approverId")? {
        Json::Null => None,
        Json::String(s) if bounded(s, 128) => Some(s.clone()),
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
            s.clone()
        }
        _ => return None,
    };
    let approval = Approval {
        approval_id: str_field(o, "approvalId", 128)?,
        operation_id: str_field(o, "operationId", 128)?,
        payload_hash: str_field(o, "payloadHash", 128)?,
        expected_version: str_field(o, "expectedVersion", 128)?,
        consumed: Consumed {
            action_type: str_field(o, "actionType", 128)?,
            target_service: str_field(o, "targetService", 64)?,
            target_id: str_field(o, "targetId", 256)?,
            status,
            requester_id: str_field(o, "requesterId", 128)?,
            approver_id,
            approver_is_founder: optional_bool(o, "approverIsFounder")?,
            requester_is_founder: optional_bool(o, "requesterIsFounder")?,
        },
    };
    str_field(o, "policyVersion", 128)?;
    let shapes = datetime("createdAt")
        && datetime("expiresAt")
        && optional(
            o,
            "kind",
            |j| matches!(j, Json::String(s) if s == "four_eyes" || s == "same_person"),
        )
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

impl IdentityClient {
    /// `createIdentityApprovalClient({ service, baseUrl, internalSecret })`.
    pub fn new(
        service: &str,
        base_url: &str,
        secret: &str,
        fetch: Arc<dyn Fetch>,
        now: Seconds,
    ) -> IdentityClient {
        IdentityClient {
            url: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            service: service.to_owned(),
            secret: secret.to_owned(),
            fetch,
            now,
        }
    }

    /// `consume(input)`: the consumed approval, or why there is none.
    pub fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, ConsumeError> {
        let payload = consume_payload(input)?;
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(
            s2s::legacy_headers(&self.service, &self.secret, &payload, (self.now)())
                .map_err(ConsumeError::Thrown)?,
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
            .map_err(|e| ConsumeError::Thrown(e.message))?;
        if !res.ok() {
            let detail = refusal_detail(&res.body);
            return Err(ConsumeError::Refused(
                crate::schema::js_trim(&format!(
                    "identity refused consume ({}) {detail}",
                    res.status
                ))
                .to_owned(),
            ));
        }
        let raw = json::parse(&res.body)
            .map(unwrap_trpc_data)
            .map_err(|_| ConsumeError::Refused("identity consume result is not JSON".to_owned()))?;
        let approval = read_approval(&raw).ok_or_else(|| {
            ConsumeError::Refused("identity consume result is not an action approval".to_owned())
        })?;
        let c = &approval.consumed;
        if c.status != "CONSUMED"
            || approval.approval_id != input.approval_id
            || approval.operation_id != input.operation_id
            || approval.payload_hash != input.payload_hash
            || c.target_service != input.target_service
            || c.target_id != input.target_id
            || approval.expected_version != input.expected_version
        {
            return Err(ConsumeError::Refused(
                "identity consume result does not match the request or is not CONSUMED".to_owned(),
            ));
        }
        Ok(approval.consumed)
    }
}

/// `crypto.randomUUID()`: a version-4 UUID from the platform CSPRNG.
pub fn random_uuid() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex.get(0..8).unwrap_or_default(),
        hex.get(8..12).unwrap_or_default(),
        hex.get(12..16).unwrap_or_default(),
        hex.get(16..20).unwrap_or_default(),
        hex.get(20..32).unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]

    use std::sync::Mutex;

    use crate::http::{FetchError, HttpResponse};

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

    const SECRET: &str = "an-identity-approval-test-secret";

    fn input() -> ConsumeInput<'static> {
        ConsumeInput {
            approval_id: "ap-1",
            operation_id: "op-1",
            payload_hash: "sha256:abc",
            target_service: "svc-academy",
            target_id: "academy.season.create",
            expected_version: "1",
            replay: None,
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

    fn with(mut o: Json, key: &str, value: Json) -> Json {
        if let Json::Object(f) = &mut o {
            f.retain(|(k, _)| k != key);
            f.push((key.to_owned(), value));
        }
        o
    }

    fn client(status: u16, body: String) -> (IdentityClient, Arc<Fake>) {
        let fake = Arc::new(Fake {
            reply: Ok(HttpResponse { status, body }),
            seen: Mutex::new(Vec::new()),
        });
        (
            IdentityClient::new(
                "svc-academy",
                "http://identity:4002/",
                SECRET,
                fake.clone(),
                || 1_700_000_000,
            ),
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
        assert_eq!(got.action_type, "academy.season.create");
        assert_eq!(
            (got.approver_is_founder, got.requester_is_founder),
            (None, None)
        );
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
    fn the_founder_attestation_is_read_and_a_non_boolean_one_is_not_an_approval() {
        let attested = with(
            with(
                approval("CONSUMED", Json::str("appr")),
                "approverIsFounder",
                Json::Bool(true),
            ),
            "requesterIsFounder",
            Json::Bool(false),
        );
        let (c, _) = client(200, trpc(attested));
        let got = c.consume(&input()).unwrap();
        assert_eq!(
            (got.approver_is_founder, got.requester_is_founder),
            (Some(true), Some(false))
        );
        let wrong = with(
            approval("CONSUMED", Json::str("appr")),
            "approverIsFounder",
            Json::str("yes"),
        );
        let (c, _) = client(200, trpc(wrong));
        assert_eq!(
            c.consume(&input()),
            Err(ConsumeError::Refused(
                "identity consume result is not an action approval".to_owned()
            ))
        );
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
                Err(ConsumeError::Refused(message)) => message,
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
        assert_eq!(
            refused(
                200,
                trpc(with(
                    approval("CONSUMED", Json::str("appr")),
                    "payloadHash",
                    Json::str("sha256:other")
                ))
            ),
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
        let c = IdentityClient::new("svc-academy", "http://identity", SECRET, fake, || 0);
        assert_eq!(
            c.consume(&input()),
            Err(ConsumeError::Thrown("fetch failed".to_owned()))
        );
        let long = "x".repeat(400);
        assert_eq!(refusal_detail(&long), format!("{}…", "x".repeat(300)));
        assert_eq!(
            refusal_detail(r#"[{"error":{"json":{"message":"m"}}}]"#),
            "m"
        );
    }

    #[test]
    fn a_replayable_consume_sends_its_key_and_consumer_after_the_six_fields() {
        let mut asked = input();
        assert_eq!(
            consume_payload(&asked).unwrap(),
            r#"{"approvalId":"ap-1","operationId":"op-1","payloadHash":"sha256:abc","targetService":"svc-academy","targetId":"academy.season.create","expectedVersion":"1"}"#
        );
        asked.replay = Some(Replay {
            request_id: "op-1",
            consumer_principal_id: "founder-a",
        });
        assert!(consume_payload(&asked).unwrap().ends_with(
            r#""expectedVersion":"1","requestId":"op-1","consumerPrincipalId":"founder-a"}"#
        ));
        asked.replay = Some(Replay {
            request_id: "op-1",
            consumer_principal_id: "",
        });
        assert!(consume_payload(&asked).is_err());
    }

    #[test]
    fn a_random_uuid_is_version_four() {
        let id = random_uuid().unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(id, random_uuid().unwrap());
    }
}
