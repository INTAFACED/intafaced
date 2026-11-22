//! svc-matching's approval consume under its own key, ported test for test from the TypeScript service's
//! `action-approval-keys.test.ts` (the four `keyCases` of `s2s-keys-fixture.ts`): the real client
//! (`approval::Identity`, the one `main.rs` builds) sends one request, recorded as it went on the wire, and the
//! request is judged by the S2S verifier svc-identity runs (`verify_request`, audience `svc-identity`). Keys are made
//! per run; none is stored. The recorder's empty reply is not a consumed approval, so the call is refused after the
//! request went out; only the request is judged.
//!
//! Beyond the TypeScript's four: the signed body is bound (another body is refused), the audience is svc-identity's
//! alone, and the binary itself, under `S2S_AUTH_MODE=keypair`, sends its halt-all consume signed by its own key
//! (the TypeScript tested the client only, not `index.ts`'s wiring). The TypeScript's `x-intafaced-signature` check
//! names no header either signer sends; here the shared secret's real signature header (`x-intafaced-service-sig`)
//! is checked instead.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use service_kit::approvals::ConsumeInput;
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::Json;
use service_kit::s2s::{
    KeyringEntry, Mode, S2S_AUDIENCE_HEADER, S2S_BODY_HEADER, SERVICE_HEADER,
    SERVICE_SIGNATURE_HEADER, ServiceSigner, SignedContext, system_seconds,
};
use service_kit::s2s_verify::{
    BodyBind, Incoming, RequestAuth, ServiceVerifier, digest_of, verify_request,
};
use svc_matching::approval::{Approvals, Identity};

/// `SECRET`: the shared secret, made per run.
fn secret() -> String {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).unwrap();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `input`.
fn input() -> ConsumeInput<'static> {
    ConsumeInput {
        approval_id: "a1b2c3d4-0000-4000-8000-000000000001",
        operation_id: "matching.halt:1",
        payload_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        target_service: "svc-matching",
        target_id: "halt:BTC-USDT",
        expected_version: "1",
        replay: None,
    }
}

/// `recorder()`: records the request and answers 200 with an empty JSON object.
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

fn pkcs8(seed: &[u8; 32]) -> String {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    URL_SAFE_NO_PAD.encode(der)
}

/// `makeKeys(audience)`: svc-matching's key, the keyring that publishes it, and the callee's verifier.
struct Keys {
    signer: Arc<ServiceSigner>,
    keyring: Vec<KeyringEntry>,
}

fn make_keys() -> Keys {
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
        signer: Arc::new(signer),
        keyring,
    }
}

impl Keys {
    fn s2s(&self, mode: Mode) -> Option<(Arc<ServiceSigner>, Mode)> {
        Some((self.signer.clone(), mode))
    }

    /// `createServiceVerifier({ self: 'svc-identity', keyring, bootSecond: 0 })`.
    fn verifier(&self) -> ServiceVerifier {
        ServiceVerifier::new("svc-identity", &self.keyring, system_seconds)
            .unwrap()
            .with_boot_second(0)
    }
}

/// The client under test makes one request; this is it, as it went on the wire.
fn call(secret: &str, s2s: Option<(Arc<ServiceSigner>, Mode)>) -> HttpRequest {
    let wire = Arc::new(Recorder::default());
    let client = Identity::new(
        "http://identity.test",
        secret,
        s2s,
        wire.clone(),
        system_seconds,
    );
    assert!(
        client.consume(&input()).is_err(),
        "an empty reply is not an approval"
    );
    let sent = wire.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    sent[0].clone()
}

/// `url.pathname + url.search` of the request.
fn target(req: &HttpRequest) -> String {
    req.url
        .strip_prefix("http://identity.test")
        .unwrap()
        .to_owned()
}

fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// `judged(sent, verifier, mode)`: `verifyServiceRequest` fed the request exactly as it went on the wire. An absent
/// mode is the TypeScript's default, dual.
fn judged(
    req: &HttpRequest,
    method: &str,
    url: &str,
    body: &str,
    verifier: &ServiceVerifier,
    secret: &str,
    mode: Mode,
) -> RequestAuth {
    verify_request(
        &Incoming {
            method,
            url,
            headers: &req.headers,
            body: Some(body.as_bytes()),
        },
        Some(verifier),
        Some(secret),
        mode,
        BodyBind::Require,
        system_seconds(),
    )
}

fn judged_as_sent(
    req: &HttpRequest,
    verifier: &ServiceVerifier,
    secret: &str,
    mode: Mode,
) -> RequestAuth {
    let body = req.body.clone().unwrap();
    judged(
        req,
        &req.method,
        &target(req),
        &body,
        verifier,
        secret,
        mode,
    )
}

fn auth(
    service: Option<&str>,
    scheme: Option<&'static str>,
    rejected: Option<&'static str>,
) -> RequestAuth {
    RequestAuth {
        service: service.map(str::to_owned),
        scheme,
        rejected,
    }
}

#[test]
fn without_a_signing_key_the_call_is_signed_with_the_shared_secret_as_before() {
    let secret = secret();
    let sent = call(&secret, None);
    assert_eq!(sent.method, "POST");
    assert_eq!(target(&sent), "/trpc/actionApproval.consume");
    assert!(
        !sent
            .headers
            .iter()
            .any(|(h, _)| h.starts_with("x-intafaced-s2s-")),
        "{:?}",
        sent.headers
    );
    assert_eq!(
        judged_as_sent(&sent, &make_keys().verifier(), &secret, Mode::Dual),
        auth(Some("svc-matching"), Some("shared"), None)
    );
}

#[test]
fn dual_the_callee_names_the_caller_from_the_key_and_the_shared_secret_rides_along() {
    let secret = secret();
    let k = make_keys();
    let sent = call(&secret, k.s2s(Mode::Dual));
    assert_eq!(header(&sent, SERVICE_HEADER), Some("svc-matching"));
    assert!(header(&sent, SERVICE_SIGNATURE_HEADER).is_some());
    assert_eq!(header(&sent, S2S_AUDIENCE_HEADER), Some("svc-identity"));
    assert_eq!(
        judged_as_sent(&sent, &k.verifier(), &secret, Mode::Dual),
        auth(Some("svc-matching"), Some("keypair"), None)
    );
}

#[test]
fn keypair_only_the_key_signature_is_sent_and_a_keypair_only_callee_accepts_it() {
    let secret = secret();
    let k = make_keys();
    let sent = call(&secret, k.s2s(Mode::Keypair));
    assert_eq!(header(&sent, SERVICE_HEADER), None);
    assert_eq!(header(&sent, SERVICE_SIGNATURE_HEADER), None);
    assert_eq!(header(&sent, S2S_AUDIENCE_HEADER), Some("svc-identity"));
    assert_eq!(
        header(&sent, S2S_BODY_HEADER),
        Some(digest_of(sent.body.as_deref().unwrap()).as_str())
    );
    assert_eq!(
        judged_as_sent(&sent, &k.verifier(), &secret, Mode::Keypair),
        auth(Some("svc-matching"), Some("keypair"), None)
    );
}

#[test]
fn a_signed_call_moved_to_another_path_or_method_or_given_another_body_is_refused() {
    let secret = secret();
    let k = make_keys();
    let sent = call(&secret, k.s2s(Mode::Keypair));
    let body = sent.body.clone().unwrap();
    // As sent, it is accepted: each refusal below is the change alone.
    assert_eq!(
        judged_as_sent(&sent, &k.verifier(), &secret, Mode::Keypair)
            .service
            .as_deref(),
        Some("svc-matching")
    );
    let moved = judged(
        &sent,
        "POST",
        "/internal/elsewhere",
        &body,
        &k.verifier(),
        &secret,
        Mode::Keypair,
    );
    assert_eq!(moved.service, None, "{moved:?}");
    let method = judged(
        &sent,
        "GET",
        &target(&sent),
        &body,
        &k.verifier(),
        &secret,
        Mode::Keypair,
    );
    assert_eq!(method.service, None, "{method:?}");
    let other = body.replace("halt:BTC-USDT", "halt:ETH-USDT");
    let rebodied = judged(
        &sent,
        "POST",
        &target(&sent),
        &other,
        &k.verifier(),
        &secret,
        Mode::Keypair,
    );
    assert_eq!(rebodied.service, None, "{rebodied:?}");
}

#[test]
fn a_key_signed_for_identity_is_not_accepted_by_another_service() {
    let secret = secret();
    let k = make_keys();
    let sent = call(&secret, k.s2s(Mode::Keypair));
    assert_eq!(
        judged_as_sent(&sent, &k.verifier(), &secret, Mode::Keypair)
            .service
            .as_deref(),
        Some("svc-matching")
    );
    let ledger = ServiceVerifier::new("svc-ledger", &k.keyring, system_seconds)
        .unwrap()
        .with_boot_second(0);
    assert_eq!(
        judged_as_sent(&sent, &ledger, &secret, Mode::Keypair).service,
        None
    );
}

// ── the binary: `main.rs` hands its own key to the identity client ──────────

/// A stand-in NATS: `INFO`, a `PONG` for every `PING`, and a JetStream answer for every request with a reply subject.
fn fake_nats() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut out) = conn else { return };
            std::thread::spawn(move || {
                let mut input = BufReader::new(out.try_clone().unwrap());
                out.write_all(b"INFO {\"server_id\":\"fake\",\"headers\":true}\r\n")
                    .unwrap();
                loop {
                    let mut line = String::new();
                    if input.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    match parts.first().copied() {
                        Some("PING") => out.write_all(b"PONG\r\n").unwrap(),
                        Some(verb @ ("PUB" | "HPUB")) => {
                            let reply = parts[2].to_owned();
                            let total: usize = parts.last().unwrap().parse().unwrap();
                            let mut body = vec![0u8; total + 2];
                            input.read_exact(&mut body).unwrap();
                            let ack = if verb == "PUB" {
                                br#"{"config":{"name":"INTAFACED_MATCHING"}}"#.to_vec()
                            } else {
                                br#"{"stream":"INTAFACED_MATCHING","seq":1}"#.to_vec()
                            };
                            out.write_all(format!("MSG {reply} 1 {}\r\n", ack.len()).as_bytes())
                                .unwrap();
                            out.write_all(&ack).unwrap();
                            out.write_all(b"\r\n").unwrap();
                        }
                        _ => {}
                    }
                }
            });
        }
    });
    port
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
/// A stand-in svc-identity: each request it receives (method, target, headers, body) is sent on, and answered 503.
fn fake_identity() -> (u16, mpsc::Receiver<HttpRequest>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut out) = conn else { return };
            let mut input = BufReader::new(out.try_clone().unwrap());
            let mut line = String::new();
            input.read_line(&mut line).unwrap();
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_owned();
            let target = parts.next().unwrap_or_default().to_owned();
            let mut headers = Vec::new();
            loop {
                let mut h = String::new();
                input.read_line(&mut h).unwrap();
                let h = h.trim_end();
                if h.is_empty() {
                    break;
                }
                let (k, v) = h.split_once(':').unwrap();
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
            }
            let length: usize = headers
                .iter()
                .find(|(k, _)| k == "content-length")
                .map_or(0, |(_, v)| v.parse().unwrap());
            let mut body = vec![0u8; length];
            input.read_exact(&mut body).unwrap();
            out.write_all(b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .unwrap();
            let _ = tx.send(HttpRequest {
                method,
                url: format!("http://identity.test{target}"),
                headers,
                body: Some(String::from_utf8(body).unwrap()),
                timeout_ms: None,
                refuse_redirect: false,
            });
        }
    });
    (port, rx)
}

/// One POST to the binary: its status.
fn post(port: u16, path: &str, headers: &[(String, String)], body: &str) -> Option<u16> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    let mut head = format!(
        "POST {path} HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    write!(s, "{head}\r\n{body}").ok()?;
    let mut raw = String::new();
    s.read_to_string(&mut raw).ok()?;
    raw.split_whitespace().nth(1)?.parse().ok()
}

#[test]
fn the_binary_under_keypair_signs_its_halt_all_approval_consume_with_its_own_key() {
    // svc-matching's key (its identity calls) and svc-trade's (the caller of the door), one keyring for both.
    let mut seeds = [[0u8; 32]; 2];
    for s in &mut seeds {
        getrandom::fill(s).unwrap();
    }
    let keyring: Vec<KeyringEntry> = ["svc-matching", "svc-trade"]
        .iter()
        .zip(&seeds)
        .map(|(svc, seed)| KeyringEntry {
            kid: format!("{svc}.a"),
            svc: (*svc).to_owned(),
            use_: "s2s".to_owned(),
            x: URL_SAFE_NO_PAD.encode(
                ed25519_dalek::SigningKey::from_bytes(seed)
                    .verifying_key()
                    .as_bytes(),
            ),
        })
        .collect();
    let ring = Json::obj([(
        "keys",
        Json::Array(
            keyring
                .iter()
                .map(|k| {
                    Json::obj([
                        ("kid", Json::str(&k.kid)),
                        ("svc", Json::str(&k.svc)),
                        ("use", Json::str(&k.use_)),
                        ("x", Json::str(&k.x)),
                    ])
                })
                .collect(),
        ),
    )])
    .compact();
    let trade =
        ServiceSigner::new("svc-trade", "svc-trade.a", &pkcs8(&seeds[1]), &keyring).unwrap();

    let dir = std::env::temp_dir().join(format!("matching-approval-keys-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let nats = fake_nats();
    let (identity, consumed) = fake_identity();
    let port = free_port();
    let secret = secret();
    let mut child = Command::new(env!("CARGO_BIN_EXE_svc-matching"))
        .env_clear()
        .env("NODE_ENV", "test")
        .env("SERVICE_NAME", "svc-matching")
        .env("INTERNAL_SERVICE_SECRET", &secret)
        .env("MATCHING_SNAPSHOT_EVERY", "0")
        .env("MATCHING_OPERATOR_IDS", "ops-1,ops-2")
        .env("MATCHING_JOURNAL_PATH", dir.join("engine.ndjson"))
        .env("NATS_URL", format!("nats://127.0.0.1:{nats}"))
        .env("IDENTITY_URL", format!("http://127.0.0.1:{identity}"))
        .env("S2S_AUTH_MODE", "keypair")
        .env("S2S_KEYRING", &ring)
        .env("S2S_SIGNING_KID", "svc-matching.a")
        .env("S2S_SIGNING_KEY", pkcs8(&seeds[0]))
        .env("HTTP_HOST", "127.0.0.1")
        .env("HTTP_PORT", port.to_string())
        .env("LOG_LEVEL", "error")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let body = Json::obj([
        ("operatorId", Json::str("ops-1")),
        ("confirmOperatorId", Json::str("ops-2")),
        ("approvalId", Json::str("appr-1")),
        ("operationId", Json::str("op-1")),
    ])
    .compact();
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(
            trade
                .headers(
                    "svc-matching",
                    "POST",
                    "/halt-all",
                    &body,
                    &SignedContext {
                        content_type: Some("application/json".to_owned()),
                        ..SignedContext::default()
                    },
                )
                .unwrap(),
        );
        if let Some(status) = post(port, "/halt-all", &headers, &body) {
            break status;
        }
        if let Some(status) = child.try_wait().unwrap() {
            let mut err = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut err)
                .unwrap();
            panic!("the binary exited {status} before it listened: {err}");
        }
        assert!(Instant::now() < deadline, "the binary never listened");
        std::thread::sleep(Duration::from_millis(50));
    };
    let sent = consumed.recv_timeout(Duration::from_secs(10));
    child.kill().unwrap();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
    let sent = sent.expect("the door asked identity to consume the approval");
    // Identity answered 503, so the door refuses; what is judged is the request it sent.
    assert_eq!(status, 400);
    assert_eq!(target(&sent), "/trpc/actionApproval.consume");
    assert_eq!(header(&sent, SERVICE_SIGNATURE_HEADER), None);
    let identity_verifier = ServiceVerifier::new("svc-identity", &keyring, system_seconds)
        .unwrap()
        .with_boot_second(0);
    assert_eq!(
        judged_as_sent(&sent, &identity_verifier, &secret, Mode::Keypair),
        auth(Some("svc-matching"), Some("keypair"), None)
    );
}
