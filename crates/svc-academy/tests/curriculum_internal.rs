//! `GET /internal/curriculum`: the ports of `curriculum/internal-curriculum.test.ts`,
//! `internal-curriculum-procedure.test.ts` and `internal-curriculum-mount.test.ts`. The shared secret bound to the
//! empty body, the per-service keys in dual and keypair mode, replay, audience, a tampered query, a forged key, a
//! caller off the record's list, and no fallback from a bad key to the secret. Keys are made from fixed seeds where
//! the TypeScript generates them; what is judged is the same.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePrivateKey as _;
use hmac::{Hmac, Mac as _};
use service_kit::json::{self, Json};
use service_kit::s2s::{self, KeyringEntry, Mode, ServiceSigner, SignedContext};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::Request;
use sha2::Sha256;
use svc_academy::curriculum::internal::{self, ServiceAuth};
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

const SECRET: &str = "academy-internal-curriculum-test-secret-32ch";
const UNAUTHENTICATED: &str =
    r#"{"error":"service credentials required","code":"academy.unauthenticated"}"#;

type Headers = Vec<(String, String)>;

/// A caller's key from a fixed seed: its PKCS8 private half (base64url) and its public `x`.
fn pair(seed: u8) -> (String, String) {
    let key = SigningKey::from_bytes(&[seed; 32]);
    (
        URL_SAFE_NO_PAD.encode(key.to_pkcs8_der().unwrap().as_bytes()),
        URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()),
    )
}

fn entry(svc: &str, x: &str) -> KeyringEntry {
    KeyringEntry {
        kid: format!("{svc}.a"),
        svc: svc.to_owned(),
        use_: "s2s".to_owned(),
        x: x.to_owned(),
    }
}

/// `kit()`: keys for svc-agents and svc-trade, and the public keyring the receiver believes.
struct Kit {
    keys: BTreeMap<&'static str, String>,
    keyring: Vec<KeyringEntry>,
}

fn kit() -> Kit {
    let mut keys = BTreeMap::new();
    let mut keyring = Vec::new();
    for (svc, seed) in [("svc-agents", 1u8), ("svc-trade", 2u8)] {
        let (private, x) = pair(seed);
        keys.insert(svc, private);
        keyring.push(entry(svc, &x));
    }
    Kit { keys, keyring }
}

impl Kit {
    fn signer(&self, svc: &str) -> ServiceSigner {
        ServiceSigner::new(svc, &format!("{svc}.a"), &self.keys[svc], &self.keyring).unwrap()
    }

    /// `registerInternalCurriculumRoute(app, SECRET, 'require', mode ? { verifier, mode } : undefined)`.
    fn auth(&self, mode: Option<Mode>) -> ServiceAuth {
        ServiceAuth {
            secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: mode.map(|m| {
                (
                    ServiceVerifier::new("svc-academy", &self.keyring, s2s::system_seconds)
                        .unwrap()
                        .with_boot_second(0),
                    m,
                )
            }),
        }
    }
}

/// A signer whose own keyring publishes a stranger's key under svc-agents' kid.
fn forged() -> ServiceSigner {
    let (private, x) = pair(9);
    ServiceSigner::new(
        "svc-agents",
        "svc-agents.a",
        &private,
        &[entry("svc-agents", &x)],
    )
    .unwrap()
}

fn v3(signer: &ServiceSigner, audience: &str, target: &str) -> Headers {
    signer
        .headers(audience, "GET", target, "", &SignedContext::default())
        .unwrap()
}

/// `serviceAuthHeaders(service, secret)`: v1, no body digest.
fn v1(service: &str, secret: &str) -> Headers {
    let ts = support::now_seconds();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{service}\n{ts}").as_bytes());
    let sig: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    vec![
        (s2s::SERVICE_HEADER.to_owned(), service.to_owned()),
        (s2s::SERVICE_TIMESTAMP_HEADER.to_owned(), ts.to_string()),
        (s2s::SERVICE_SIGNATURE_HEADER.to_owned(), sig),
    ]
}

fn get_at(auth: &ServiceAuth, headers: &Headers, url: &str) -> (u16, String) {
    let res = internal::answer(
        auth,
        &Request {
            method: "GET",
            url,
            headers,
            body: "",
        },
        support::now_seconds(),
    );
    (res.status, res.body)
}

fn get(auth: &ServiceAuth, headers: &Headers) -> u16 {
    get_at(auth, headers, internal::PATH).0
}

fn shared(service: &str, body: &str) -> Headers {
    support::legacy_headers(service, SECRET, body)
}

/// `ACADEMY_INTERNAL_CURRICULUM.output`, and `coachSpineIsComplete`: every spine row once, slug and title only.
fn assert_payload(body: &str) {
    let parsed = json::parse(body).unwrap();
    let Json::Object(fields) = &parsed else {
        panic!("{body}")
    };
    assert_eq!(
        fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        ["items", "licensedLibraryImported", "source"]
    );
    assert_eq!(
        parsed.get("licensedLibraryImported"),
        Some(&Json::Bool(false))
    );
    assert_eq!(parsed.get("source"), Some(&Json::str("platform-spine")));
    let Some(Json::Array(items)) = parsed.get("items") else {
        panic!()
    };
    assert_eq!(items.len(), spine::list(None, None).len());
    assert!(!items.is_empty());
    for row in items {
        let (Some(Json::String(slug)), Some(Json::String(title))) =
            (row.get("slug"), row.get("title"))
        else {
            panic!("{row:?}")
        };
        assert_eq!(&spine::get(slug).unwrap().title, title);
    }
    assert!(!body.contains("\"body\""));
}

// ── internal-curriculum.test.ts: the shared secret ──────────────────────────────────────────────────────────────────

#[test]
fn refuses_unsigned_callers_and_serves_the_spine_with_the_body_bound_secret() {
    let auth = ServiceAuth::from_env(SECRET, "", "off", None, None, None).unwrap();
    let (status, body) = get_at(&auth, &Vec::new(), internal::PATH);
    assert_eq!((status, body.as_str()), (401, UNAUTHENTICATED));
    let (status, body) = get_at(&auth, &shared("svc-agents", ""), internal::PATH);
    assert_eq!(status, 200);
    assert_payload(&body);
    assert_eq!(get(&auth, &shared("svc-agents", r#"{"not":"empty"}"#)), 401);
}

#[test]
fn require_mode_refuses_a_v1_caller_that_did_not_bind_the_empty_body() {
    let auth = ServiceAuth::from_env(SECRET, "require", "off", None, None, None).unwrap();
    assert_eq!(get(&auth, &v1("svc-agents", SECRET)), 401);
    // Accept-both (the default) takes the same v1 call: the refusal above is the binding's, not the signature's.
    let lax = ServiceAuth::from_env(SECRET, "", "off", None, None, None).unwrap();
    assert_eq!(get(&lax, &v1("svc-agents", SECRET)), 200);
}

#[test]
fn the_door_mounts_the_route_and_start_up_refuses_a_malformed_keyring() {
    // index.ts mounts it: the door answers the path before any tRPC call (`door::handle_as`), from the environment
    // `main.rs` reads (INTERNAL_SERVICE_SECRET, INTERNAL_SERVICE_BODY_BIND, S2S_AUTH_MODE and the keyring).
    let mut ports = Ports::unwired();
    ports.services = ServiceAuth::from_env(SECRET, "require", "off", None, None, None).unwrap();
    let door = AcademyDoor::new(DoorConfig {
        edge_secret: "an-academy-internal-test-edge-secret".to_owned(),
        env: BTreeMap::new(),
        store: Store::Down("down".to_owned()),
        ports,
        settings: Settings::empty(),
        now: system_now,
    })
    .unwrap();
    let headers = shared("svc-agents", "");
    let res = door.handle(&Request {
        method: "GET",
        url: internal::PATH,
        headers: &headers,
        body: "",
    });
    assert_eq!(res.status, 200, "{}", res.body);
    assert_payload(&res.body);
    let refused = door.handle(&Request {
        method: "GET",
        url: internal::PATH,
        headers: &[],
        body: "",
    });
    assert_eq!(
        (refused.status, refused.body.as_str()),
        (401, UNAUTHENTICATED)
    );
    // `s2sFromEnv` throws at load on a mode without a keyring, or a keyring it cannot read.
    assert!(ServiceAuth::from_env(SECRET, "", "dual", None, None, None).is_err());
    assert!(ServiceAuth::from_env(SECRET, "", "keypair", Some("not json"), None, None).is_err());
    assert!(ServiceAuth::from_env(SECRET, "", "sometimes", None, None, None).is_err());
    assert_eq!(internal::PATH, "/internal/curriculum");
}

// ── internal-curriculum.test.ts: per-service keys ───────────────────────────────────────────────────────────────────

#[test]
fn both_modes_serve_a_call_signed_by_svc_agents_own_key() {
    let k = kit();
    for mode in [Mode::Dual, Mode::Keypair] {
        let auth = k.auth(Some(mode));
        let headers = v3(&k.signer("svc-agents"), "svc-academy", internal::PATH);
        assert_eq!(get(&auth, &headers), 200, "{mode:?}");
    }
}

#[test]
fn refuses_a_replay_of_the_same_signed_call() {
    let k = kit();
    let auth = k.auth(Some(Mode::Keypair));
    let headers = v3(&k.signer("svc-agents"), "svc-academy", internal::PATH);
    assert_eq!(get(&auth, &headers), 200);
    assert_eq!(get(&auth, &headers), 401);
}

#[test]
fn refuses_a_call_signed_for_another_audience() {
    let k = kit();
    let auth = k.auth(Some(Mode::Keypair));
    assert_eq!(
        get(
            &auth,
            &v3(&k.signer("svc-agents"), "svc-bank", internal::PATH)
        ),
        401
    );
}

#[test]
fn refuses_a_tampered_path_or_query() {
    let k = kit();
    let auth = k.auth(Some(Mode::Keypair));
    let headers = v3(
        &k.signer("svc-agents"),
        "svc-academy",
        "/internal/curriculum?lang=en",
    );
    assert_eq!(
        get_at(&auth, &headers, "/internal/curriculum?lang=fr").0,
        401
    );
}

#[test]
fn refuses_a_key_that_is_not_in_the_keyring() {
    let k = kit();
    let auth = k.auth(Some(Mode::Keypair));
    assert_eq!(
        get(&auth, &v3(&forged(), "svc-academy", internal::PATH)),
        401
    );
    assert_eq!(k.keyring.len(), 2);
}

#[test]
fn refuses_a_caller_off_the_record_list_even_with_a_valid_key() {
    let k = kit();
    let auth = k.auth(Some(Mode::Keypair));
    assert_eq!(
        get(
            &auth,
            &v3(&k.signer("svc-trade"), "svc-academy", internal::PATH)
        ),
        401
    );
}

#[test]
fn dual_keeps_the_secret_for_svc_agents_but_not_for_an_off_list_service() {
    let auth = kit().auth(Some(Mode::Dual));
    assert_eq!(get(&auth, &shared("svc-agents", "")), 200);
    assert_eq!(get(&auth, &shared("svc-trade", "")), 401);
}

#[test]
fn keypair_refuses_the_shared_secret() {
    let auth = kit().auth(Some(Mode::Keypair));
    assert_eq!(get(&auth, &shared("svc-agents", "")), 401);
}

#[test]
fn dual_never_falls_back_from_a_bad_key_to_a_valid_secret() {
    let k = kit();
    let auth = k.auth(Some(Mode::Dual));
    let mut headers = v3(&forged(), "svc-academy", internal::PATH);
    headers.extend(shared("svc-agents", ""));
    assert_eq!(get(&auth, &headers), 401);
    assert_eq!(k.keyring.len(), 2);
}

#[test]
fn without_a_verifier_the_door_is_the_shared_secret_door_and_refuses_an_off_list_name() {
    let auth = kit().auth(None);
    assert_eq!(get(&auth, &shared("svc-agents", "")), 200);
    assert_eq!(get(&auth, &shared("svc-trade", "")), 401);
}

// ── internal-curriculum-procedure.test.ts ───────────────────────────────────────────────────────────────────────────

#[test]
fn the_records_accepted_sample_parses_and_each_refusal_is_the_records_one_with_its_status() {
    let auth = ServiceAuth::from_env(SECRET, "", "off", None, None, None).unwrap();
    let (status, body) = get_at(&auth, &shared(internal::CALLERS[0], ""), internal::PATH);
    assert_eq!(status, 200);
    assert_payload(&body);
    let mut seen = Vec::new();
    for headers in [Vec::new(), shared("svc-trade", "")] {
        let (status, body) = get_at(&auth, &headers, internal::PATH);
        // The record's one refusal: `academy.unauthenticated` → UNAUTHORIZED (401).
        assert_eq!(status, 401);
        let parsed = json::parse(&body).unwrap();
        let Some(Json::String(code)) = parsed.get("code") else {
            panic!("{body}")
        };
        seen.push(code.clone());
    }
    seen.dedup();
    assert_eq!(seen, ["academy.unauthenticated"]);
}
