//! svc-matching's outgoing calls under its own key, ported from the TypeScript service's `replay-ledger-client-keys.test.ts`
//! and `action-approval-keys.test.ts` (both run `s2s-keys-fixture.ts`'s four `keyCases`). Each call goes through the
//! client the binary builds (`main.rs`) into a recording `Fetch`, and the request exactly as it went on the wire is
//! judged by the kit's verifier (`service_kit::s2s_verify::verify_request`, `verifyServiceRequest`) with a keyring
//! generated per run. Each test is named after the `it` it ports, prefixed with its client (`ledger`, `identity`).
//!
//! - The replay hold check's ledger read (`holds::LedgerHttp`, `createReplayLedgerClient`): all four cases. The TypeScript
//!   read `balance(userAvailable(...))`; the Rust hold check's one read is `balances` (`POST /trpc/balances`), so
//!   that is the call judged.
//! - The approval consume (`approval::Identity`, `createIdentityApprovalClient`): only the first case, the shared
//!   secret without a key. `Identity::new` takes no key and `main.rs` passes none, while the TypeScript's
//!   `index.ts` passes `s2sKey` to it; so `dual`, `keypair` and "moved to another path or method" have no Rust call
//!   to make. That is a protection the port lost, not a TypeScript-only wrapper, and it is not ported here.
//!
//! The fixture's "x-intafaced-signature is undefined" names a header no signer writes; the shared secret's signature
//! header is `x-intafaced-service-sig`, so that is the header asserted absent.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use service_kit::approvals::ConsumeInput;
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::s2s::{
    CallSigner, KeyringEntry, Mode, SERVICE_HEADER, SERVICE_SIGNATURE_HEADER, ServiceSigner,
    system_seconds,
};
use service_kit::s2s_verify::{BodyBind, Incoming, RequestAuth, ServiceVerifier, verify_request};
use svc_matching::approval::{Approvals, Identity};
use svc_matching::holds::{LedgerHttp, ReplayHoldLedger};

const SECRET: &str = "matching-internal-service-secret-32c";

/// A fetch that records the request and answers 200 with an empty JSON object.
#[derive(Default)]
struct Recorder {
    sent: Mutex<Vec<HttpRequest>>,
}

impl Fetch for Recorder {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.sent.lock().unwrap().push(req.clone());
        Ok(HttpResponse {
            status: 200,
            body: "{}".to_owned(),
        })
    }
}

impl Recorder {
    fn first(&self) -> HttpRequest {
        self.sent
            .lock()
            .unwrap()
            .first()
            .cloned()
            .expect("a request went out")
    }
}

fn pkcs8(seed: &[u8; 32]) -> String {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    URL_SAFE_NO_PAD.encode(der)
}

/// `makeKeys(audience)`: svc-matching's key, generated per run, and the keyring that publishes it.
struct Keys {
    keyring: Vec<KeyringEntry>,
    signer: Arc<ServiceSigner>,
    audience: &'static str,
}

fn make_keys(audience: &'static str) -> Keys {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    let keyring = vec![KeyringEntry {
        kid: "svc-matching.a".to_owned(),
        svc: "svc-matching".to_owned(),
        use_: "s2s".to_owned(),
        x: URL_SAFE_NO_PAD.encode(
            ed25519_dalek::SigningKey::from_bytes(&seed)
                .verifying_key()
                .as_bytes(),
        ),
    }];
    let signer =
        ServiceSigner::new("svc-matching", "svc-matching.a", &pkcs8(&seed), &keyring).unwrap();
    Keys {
        keyring,
        signer: Arc::new(signer),
        audience,
    }
}

impl Keys {
    fn s2s(&self, mode: Mode) -> Option<(Arc<ServiceSigner>, Mode)> {
        Some((self.signer.clone(), mode))
    }

    /// `createServiceVerifier({ self: audience, keyring, bootSecond: 0 })`, fresh for each judgement as the fixture's is.
    fn verifier(&self) -> ServiceVerifier {
        ServiceVerifier::new(self.audience, &self.keyring, system_seconds)
            .unwrap()
            .with_boot_second(0)
    }
}

/// `judged(sent, verifier, mode)`: the request exactly as it went on the wire.
fn judged(sent: &HttpRequest, keys: &Keys, mode: Mode) -> RequestAuth {
    let url = url::Url::parse(&sent.url).unwrap();
    let target = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_owned(),
    };
    let body = sent.body.clone().unwrap_or_default();
    verify_request(
        &Incoming {
            method: &sent.method,
            url: &target,
            headers: &sent.headers,
            body: Some(body.as_bytes()),
        },
        Some(&keys.verifier()),
        Some(SECRET),
        mode,
        BodyBind::Require,
        system_seconds(),
    )
}

fn header<'a>(sent: &'a HttpRequest, name: &str) -> Option<&'a str> {
    sent.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn has_s2s_header(sent: &HttpRequest) -> bool {
    sent.headers
        .iter()
        .any(|(k, _)| k.starts_with("x-intafaced-s2s-"))
}

/// `moved`: the same signed request sent to another path, or with the other method.
fn moved_path(sent: &HttpRequest) -> HttpRequest {
    let url = url::Url::parse(&sent.url).unwrap();
    HttpRequest {
        url: format!("{}/internal/elsewhere", url.origin().ascii_serialization()),
        ..sent.clone()
    }
}

fn moved_method(sent: &HttpRequest) -> HttpRequest {
    HttpRequest {
        method: if sent.method == "GET" { "POST" } else { "GET" }.to_owned(),
        ..sent.clone()
    }
}

// ═══ replay-ledger-client-keys.test.ts ══════════════════════════════════

const LEDGER: &str = "svc-ledger";

/// One read through the replay hold check's ledger client, as `main.rs` builds it; its answer (`{}` is no balance
/// list) is not judged, only the request.
fn ledger_call(s2s: Option<(Arc<ServiceSigner>, Mode)>) -> HttpRequest {
    let recorder = Arc::new(Recorder::default());
    let ledger = LedgerHttp {
        base_url: "http://ledger.test".to_owned(),
        signer: CallSigner::new("svc-matching", LEDGER, SECRET, s2s),
        fetch: recorder.clone(),
    };
    let _refused = ledger.balances("user", "11111111-1111-4111-8111-111111111111");
    recorder.first()
}

#[test]
fn ledger_without_a_signing_key_the_call_is_signed_with_the_shared_secret_as_before() {
    let sent = ledger_call(None);
    assert!(!has_s2s_header(&sent));
    let auth = judged(&sent, &make_keys(LEDGER), Mode::Dual);
    assert_eq!(auth.service.as_deref(), Some("svc-matching"));
    assert_eq!(auth.scheme, Some("shared"));
}

#[test]
fn ledger_dual_the_callee_names_the_caller_from_the_key_and_the_shared_secret_rides_along() {
    let keys = make_keys(LEDGER);
    let sent = ledger_call(keys.s2s(Mode::Dual));
    assert_eq!(header(&sent, SERVICE_HEADER), Some("svc-matching"));
    assert_eq!(
        judged(&sent, &keys, Mode::Dual),
        RequestAuth {
            service: Some("svc-matching".to_owned()),
            scheme: Some("keypair"),
            rejected: None,
        }
    );
}

#[test]
fn ledger_keypair_only_the_key_signature_is_sent_and_a_keypair_only_callee_accepts_it() {
    let keys = make_keys(LEDGER);
    let sent = ledger_call(keys.s2s(Mode::Keypair));
    assert_eq!(header(&sent, SERVICE_HEADER), None);
    assert_eq!(header(&sent, SERVICE_SIGNATURE_HEADER), None);
    let auth = judged(&sent, &keys, Mode::Keypair);
    assert_eq!(auth.service.as_deref(), Some("svc-matching"));
    assert_eq!(auth.scheme, Some("keypair"));
}

#[test]
fn ledger_a_signed_call_moved_to_another_path_or_method_is_refused() {
    let keys = make_keys(LEDGER);
    let sent = ledger_call(keys.s2s(Mode::Keypair));
    assert_eq!(
        judged(&moved_path(&sent), &keys, Mode::Keypair).service,
        None
    );
    assert_eq!(
        judged(&moved_method(&sent), &keys, Mode::Keypair).service,
        None
    );
    // The request itself is accepted, so the refusals above are the move's.
    assert_eq!(
        judged(&sent, &keys, Mode::Keypair).service.as_deref(),
        Some("svc-matching")
    );
}

// ═══ action-approval-keys.test.ts ═══════════════════════════════════════

fn now_seconds() -> i64 {
    system_seconds()
}

/// One consume through the approval client `main.rs` builds on `IDENTITY_URL`. The recorder's empty reply is not a
/// consumed approval, so the consume is refused after the request went out; only the request is judged.
fn identity_call() -> HttpRequest {
    let recorder = Arc::new(Recorder::default());
    let identity = Identity::new(
        "http://identity.test",
        SECRET,
        recorder.clone(),
        now_seconds,
    );
    let payload_hash = "a".repeat(64);
    let refused = identity.consume(&ConsumeInput {
        approval_id: "a1b2c3d4-0000-4000-8000-000000000001",
        operation_id: "matching.halt:1",
        payload_hash: &payload_hash,
        target_service: "svc-matching",
        target_id: "halt:BTC-USDT",
        expected_version: "1",
        replay: None,
    });
    assert!(
        refused.is_err(),
        "an empty reply is not a consumed approval"
    );
    recorder.first()
}

#[test]
fn identity_without_a_signing_key_the_call_is_signed_with_the_shared_secret_as_before() {
    let sent = identity_call();
    assert!(!has_s2s_header(&sent));
    let auth = judged(&sent, &make_keys("svc-identity"), Mode::Dual);
    assert_eq!(auth.service.as_deref(), Some("svc-matching"));
    assert_eq!(auth.scheme, Some("shared"));
}
