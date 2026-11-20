//! The lobbies' pure parts and outside clients, ported from the TypeScript's unit tests: `access/room-access.test.ts`,
//! `access/max-room-capacity.test.ts`, `list-remaining-sql-lists-limit-unset.test.ts` (rooms and sessions),
//! `host-rights.test.ts`, `host-rights-keys.test.ts`, `stake-source.test.ts`, `stake-source-keys.test.ts`,
//! `stream/provider.test.ts`, `stream/video-park.test.ts`, `spatial/scene.test.ts`, `spatial/scene-state.test.ts`,
//! `spatial/edit-policy.test.ts`, `spatial/session-fingerprint.test.ts` and `spatial/update-scene-policy.test.ts`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::float_arithmetic,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::s2s::{CallSigner, KeyringEntry, Mode, ServiceSigner};
use service_kit::s2s_verify::{self, BodyBind, Incoming, ServiceVerifier};
use service_kit::schema::Value;
use service_kit::time::Instant;
use sha2::Sha256;
use svc_academy::db::Store;
use svc_academy::errors::{AcademyError, Refusal};
use svc_academy::lobbies::clients::{self, HttpHostRights, HttpStake, may_host, parse_perks};
use svc_academy::lobbies::scene::{self, Bad, Parsed, State, Write};
use svc_academy::lobbies::seat::{self, Access, RoomTerms, Seat, SeatRequest};
use svc_academy::lobbies::store::{Lobbies, NewRoom, list_limit, published_max_room_capacity};
use svc_academy::lobbies::stream::{self, LiveKit, LiveKitOptions, stream_from_env};
use svc_academy::ports::{self, BaseHostRights, HostRights, NullStream, Ports, Stake, Stream};

fn amt(s: &str) -> i128 {
    parse_amount(s).unwrap()
}

fn code(r: &Refusal) -> &str {
    match r {
        Refusal::Academy(AcademyError { code, .. }) => code,
        other => panic!("not an academy refusal: {other:?}"),
    }
}

fn message(r: &Refusal) -> &str {
    match r {
        Refusal::Academy(AcademyError { message, .. }) | Refusal::Internal { message, .. } => {
            message
        }
        other => panic!("{other:?}"),
    }
}

// ── access/room-access.test.ts ───────────────────────────────────────────────────────────────────────────────────

fn room(access: Access, min_stake: i128, capacity: i64) -> RoomTerms {
    RoomTerms {
        access,
        min_stake,
        capacity,
    }
}

fn ask(occupancy: i64, stake: i128, invited: bool, is_host: bool) -> SeatRequest {
    SeatRequest {
        occupancy,
        stake,
        invited,
        is_host,
    }
}

fn refused_code(s: Seat) -> Option<&'static str> {
    match s {
        Seat::Allowed => None,
        Seat::Refused { code, .. } => Some(code),
    }
}

#[test]
fn a_free_room_admits_while_there_is_room_and_refuses_at_or_over_capacity() {
    assert_eq!(
        seat::decide_seat(room(Access::Free, 0, 10), ask(0, 0, false, false)),
        Seat::Allowed
    );
    assert_eq!(
        refused_code(seat::decide_seat(
            room(Access::Free, 0, 2),
            ask(2, 0, false, false)
        )),
        Some("academy.room_full")
    );
    // Occupancy above capacity is a room that shrank, not a room with space.
    assert_eq!(
        refused_code(seat::decide_seat(
            room(Access::Free, 0, 2),
            ask(5, 0, false, false)
        )),
        Some("academy.room_full")
    );
}

#[test]
fn a_staked_room_gates_on_an_inclusive_threshold_before_the_seat_count() {
    let staked = room(Access::Staked, amt("1000"), 10);
    assert_eq!(
        refused_code(seat::decide_seat(
            staked,
            ask(0, amt("999.999999999999999999"), false, false)
        )),
        Some("academy.stake_required")
    );
    assert_eq!(
        seat::decide_seat(staked, ask(0, amt("1000"), false, false)),
        Seat::Allowed
    );
    assert_eq!(
        seat::decide_seat(staked, ask(0, amt("5000"), false, false)),
        Seat::Allowed
    );
    assert_eq!(
        refused_code(seat::decide_seat(
            room(Access::Staked, amt("1000"), 1),
            ask(1, 0, false, false)
        )),
        Some("academy.stake_required")
    );
}

#[test]
fn an_invite_room_needs_an_invitation_and_still_counts_seats() {
    let invite = room(Access::Invite, 0, 10);
    assert_eq!(
        refused_code(seat::decide_seat(invite, ask(0, 0, false, false))),
        Some("academy.invite_required")
    );
    assert_eq!(
        seat::decide_seat(invite, ask(0, 0, true, false)),
        Seat::Allowed
    );
    assert_eq!(
        refused_code(seat::decide_seat(
            room(Access::Invite, 0, 1),
            ask(1, 0, true, false)
        )),
        Some("academy.room_full")
    );
}

#[test]
fn the_host_is_admitted_to_a_full_staked_or_invite_room() {
    assert_eq!(
        seat::decide_seat(room(Access::Free, 0, 1), ask(1, 0, false, true)),
        Seat::Allowed
    );
    assert_eq!(
        seat::decide_seat(
            room(Access::Staked, amt("100000"), 10),
            ask(0, 0, false, true)
        ),
        Seat::Allowed
    );
    assert_eq!(
        seat::decide_seat(room(Access::Invite, 0, 10), ask(0, 0, false, true)),
        Seat::Allowed
    );
}

#[test]
fn an_invitation_is_live_until_the_instant_it_expires() {
    let now = Instant(1_782_864_000_000); // 2026-07-01T00:00:00.000Z
    assert!(!seat::invite_is_live(None, now));
    assert!(seat::invite_is_live(Some(None), now));
    assert!(seat::invite_is_live(
        Some(Some(Instant(now.0 + 86_400_000))),
        now
    ));
    assert!(!seat::invite_is_live(
        Some(Some(Instant(now.0 - 86_400_000))),
        now
    ));
    assert!(!seat::invite_is_live(Some(Some(now)), now));
}

#[test]
fn only_a_staked_room_asks_for_a_stake_and_never_for_its_host() {
    assert!(seat::needs_stake_check(Access::Staked, false));
    assert!(!seat::needs_stake_check(Access::Free, false));
    assert!(!seat::needs_stake_check(Access::Invite, false));
    assert!(!seat::needs_stake_check(Access::Staked, true));
}

#[test]
fn the_seat_cards_stay_consistent() {
    let ok = seat::decide_seat(room(Access::Free, 0, 10), ask(0, 0, false, false));
    assert!(ok.allowed());
    assert!(seat::board_card(ok).0);
    assert!(seat::status_line_matches(ok));
    assert!(seat::status_line_consistent(&seat::status_line(ok)));
    assert_eq!(seat::parse_status_line("nope"), None);
    assert!(seat::export_text(ok).starts_with(seat::export_header()));
    assert_eq!(seat::export_line(ok), "1,,0");
    let refuse = seat::decide_seat(
        room(Access::Staked, amt("100"), 10),
        ask(0, 0, false, false),
    );
    assert!(!refuse.allowed());
    assert_eq!(seat::board_card(refuse).1, Some("academy.stake_required"));
    assert!(seat::status_line_matches(refuse));
    assert!(seat::status_line_consistent(&seat::status_line(refuse)));
    assert!(seat::export_line(refuse).contains("academy.stake_required"));
    assert_eq!(seat::ROOM_ACCESS_KINDS.len(), 3);
    assert!(seat::is_room_access_kind("free"));
    assert!(!seat::is_room_access_kind("vip"));
    assert!(seat::ROOM_ACCESS_KINDS.contains(&"invite"));
}

// ── access/max-room-capacity.test.ts ─────────────────────────────────────────────────────────────────────────────

struct Perks(bool);
impl HostRights for Perks {
    fn perks_of(&self, _: &str) -> Result<Json, Refusal> {
        let mut p = ports::base_perks();
        if let Json::Object(fields) = &mut p {
            for (k, v) in fields.iter_mut() {
                if k == "lobbyHostRights" {
                    *v = Json::Bool(self.0);
                }
            }
        }
        Ok(p)
    }
}

fn desk() -> NewRoom {
    NewRoom {
        host_id: "u-1".to_owned(),
        slug: "desk".to_owned(),
        name: "Desk".to_owned(),
        kind: "general".to_owned(),
        access: Access::Free,
        min_stake: None,
        capacity: 25.0,
    }
}

#[test]
fn create_room_refuses_an_unpublished_ceiling_and_host_rights_gate_first() {
    // The database must not be reached: a store that refuses every query would answer a 500, not these codes.
    let store = Store::Down("sql must not run when capacity is unpublished".to_owned());
    let mut ports = Ports::unwired();
    ports.host_rights = Box::new(Perks(true));
    let l = Lobbies {
        store: &store,
        ports: &ports,
        max_room_capacity: None,
        now: Instant(0),
    };
    assert_eq!(
        code(&l.create_room(&desk()).unwrap_err()),
        "academy.room_capacity_unset"
    );
    ports.host_rights = Box::new(Perks(false));
    let l = Lobbies {
        store: &store,
        ports: &ports,
        max_room_capacity: None,
        now: Instant(0),
    };
    assert_eq!(
        code(&l.create_room(&desk()).unwrap_err()),
        "academy.host_rights_required"
    );
}

#[test]
fn a_published_ceiling_is_an_integer_from_1_to_100000_and_is_never_clamped() {
    for bad in [
        None,
        Some(Json::Number(0.0)),
        Some(Json::Number(100_001.0)),
        Some(Json::Number(1.5)),
        Some(Json::str("5000")),
    ] {
        assert_eq!(
            code(&published_max_room_capacity(bad.as_ref()).unwrap_err()),
            "academy.room_capacity_unset"
        );
    }
    assert_eq!(
        published_max_room_capacity(Some(&Json::Number(1.0))).unwrap(),
        1
    );
    assert_eq!(
        published_max_room_capacity(Some(&Json::Number(100_000.0))).unwrap(),
        100_000
    );
    // Over the ceiling refuses full; a staked room needs a threshold above zero; both before any query.
    let store = Store::Down("sql must not run".to_owned());
    let mut ports = Ports::unwired();
    ports.host_rights = Box::new(Perks(true));
    let max = Json::Number(20.0);
    let l = Lobbies {
        store: &store,
        ports: &ports,
        max_room_capacity: Some(&max),
        now: Instant(0),
    };
    let over = l
        .create_room(&NewRoom {
            capacity: 21.0,
            ..desk()
        })
        .unwrap_err();
    assert_eq!(
        (code(&over), message(&over)),
        (
            "academy.room_full",
            "A lobby cannot seat more than 20 — presence fans out over the gateway"
        )
    );
    for min_stake in [None, Some(0)] {
        let staked = l
            .create_room(&NewRoom {
                access: Access::Staked,
                min_stake,
                capacity: 10.0,
                ..desk()
            })
            .unwrap_err();
        assert_eq!(code(&staked), "academy.stake_required");
    }
    // With every check passed the insert is attempted (and the down store refuses it).
    assert!(matches!(
        l.create_room(&NewRoom {
            capacity: 10.0,
            ..desk()
        })
        .unwrap_err(),
        Refusal::Internal { .. }
    ));
}

// ── list-remaining-sql-lists-limit-unset.test.ts (rooms and sessions) ─────────────────────────────────────────────

#[test]
fn an_unset_rooms_or_sessions_limit_refuses_by_name_and_a_published_one_is_cut_to_200() {
    for (code_, label) in [
        ("academy.rooms_list_limit_unset", "Rooms"),
        ("academy.sessions_list_limit_unset", "Sessions"),
    ] {
        for unset in [
            Value::Undefined,
            Value::Null,
            Value::Number(f64::NAN),
            Value::Number(f64::INFINITY),
            Value::Number(0.0),
            Value::Number(-1.0),
            Value::String("nope".to_owned()),
        ] {
            let r = list_limit(&unset, code_, label).unwrap_err();
            assert_eq!(code(&r), code_);
            assert_eq!(
                message(&r),
                format!("{label} list limit is unset — pass limit (never invent the whole table)")
            );
        }
        assert_eq!(list_limit(&Value::Number(50.0), code_, label).unwrap(), 50);
        assert_eq!(list_limit(&Value::Number(50.9), code_, label).unwrap(), 50);
        assert_eq!(
            list_limit(&Value::Number(5000.0), code_, label).unwrap(),
            200
        );
    }
    // The limit is checked before the query, and a published one reaches it.
    let store = Store::Down("down".to_owned());
    let ports = Ports::unwired();
    let l = Lobbies {
        store: &store,
        ports: &ports,
        max_room_capacity: None,
        now: Instant(0),
    };
    assert_eq!(
        code(&l.list_rooms(None, &Value::Undefined).unwrap_err()),
        "academy.rooms_list_limit_unset"
    );
    assert_eq!(
        code(&l.list_sessions(Some("r"), &Value::Undefined).unwrap_err()),
        "academy.sessions_list_limit_unset"
    );
    assert!(matches!(
        l.list_rooms(None, &Value::Number(50.0)).unwrap_err(),
        Refusal::Internal { .. }
    ));
    assert!(matches!(
        l.list_sessions(Some("r"), &Value::Number(50.0))
            .unwrap_err(),
        Refusal::Internal { .. }
    ));
}

// ── The fake wire ────────────────────────────────────────────────────────────────────────────────────────────────

type Answer = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, FetchError> + Send + Sync>;

struct FakeFetch {
    sent: Mutex<Vec<HttpRequest>>,
    answer: Answer,
}

impl FakeFetch {
    fn new(
        answer: impl Fn(&HttpRequest) -> Result<HttpResponse, FetchError> + Send + Sync + 'static,
    ) -> Arc<FakeFetch> {
        Arc::new(FakeFetch {
            sent: Mutex::new(Vec::new()),
            answer: Box::new(answer),
        })
    }
    fn status(status: u16, body: &str) -> Arc<FakeFetch> {
        let body = body.to_owned();
        FakeFetch::new(move |_| {
            Ok(HttpResponse {
                status,
                body: body.clone(),
            })
        })
    }
    fn sent(&self) -> Vec<HttpRequest> {
        self.sent.lock().unwrap().clone()
    }
}

impl Fetch for FakeFetch {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.sent.lock().unwrap().push(req.clone());
        (self.answer)(req)
    }
}

const SECRET: &str = "an-academy-host-rights-test-secret";

fn now_seconds() -> i64 {
    s2s_kit_now()
}
fn s2s_kit_now() -> i64 {
    service_kit::s2s::system_seconds()
}

fn legacy(audience: &str) -> CallSigner {
    CallSigner::new("svc-academy", audience, SECRET, None)
}

/// `verifyServiceHeaders(seen, SECRET, { rawBody: empty, mode: 'require' })`.
fn verified_v2(req: &HttpRequest) -> Result<String, &'static str> {
    let incoming = Incoming {
        method: &req.method,
        url: "/",
        headers: &req.headers,
        body: Some(b""),
    };
    s2s_verify::verify_legacy(&incoming, SECRET, BodyBind::Require, now_seconds())
}

fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn is_hex64(v: Option<&str>) -> bool {
    v.is_some_and(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
}

fn perks_body(host: bool) -> String {
    Perks(host).perks_of("").unwrap().compact()
}

// ── host-rights.test.ts ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_perk_decides_and_rank_zero_refuses() {
    let base = ports::base_perks();
    assert_eq!(base.get("lobbyHostRights"), Some(&Json::Bool(false)));
    assert!(!may_host(&base));
    assert!(may_host(&Perks(true).perks_of("").unwrap()));
    let mut rich = Perks(false).perks_of("").unwrap();
    if let Json::Object(f) = &mut rich {
        for (k, v) in f.iter_mut() {
            match k.as_str() {
                "feeDiscountBps" => *v = Json::int(9999),
                "copyFollowerCap" => *v = Json::int(10_000),
                "cardTier" => *v = Json::str("standard"),
                _ => {}
            }
        }
    }
    assert!(parse_perks(&rich).is_some());
    assert!(!may_host(&rich));
    assert!(!may_host(&BaseHostRights.perks_of("u").unwrap()));
}

#[test]
fn host_rights_send_service_credentials_and_read_the_perk() {
    let fetch = FakeFetch::status(200, &perks_body(true));
    let source = HttpHostRights::new(
        "http://svc-identity:4002",
        legacy("svc-identity"),
        fetch.clone(),
    );
    assert!(may_host(&source.perks_of("u-1").unwrap()));
    let req = &fetch.sent()[0];
    assert_eq!(req.method, "GET");
    assert_eq!(req.url, "http://svc-identity:4002/internal/rank/u-1/perks");
    assert_eq!(req.body, None);
    assert_eq!(header(req, "x-intafaced-service"), Some("svc-academy"));
    assert!(is_hex64(header(req, "x-intafaced-service-body")));
    assert!(is_hex64(header(req, "x-intafaced-service-sig")));
    assert!(
        header(req, "x-intafaced-service-ts")
            .is_some_and(|t| t.bytes().all(|c| c.is_ascii_digit()))
    );
    assert_eq!(verified_v2(req), Ok("svc-academy".to_owned()));
}

#[test]
fn host_rights_fail_closed_on_every_unreadable_answer() {
    let cases: Vec<(Arc<FakeFetch>, &str)> = vec![
        (
            FakeFetch::new(|_| {
                Err(FetchError {
                    message: "fetch failed".to_owned(),
                })
            }),
            "Host rights unavailable: fetch failed",
        ),
        (
            FakeFetch::status(401, r#"{"error":"service credentials required"}"#),
            "Host rights unavailable (401)",
        ),
        (
            FakeFetch::status(200, r#"{"lobbyHostRights":"yes"}"#),
            "Host rights payload did not match the published contract",
        ),
        (
            FakeFetch::status(200, "<html>502 Bad Gateway</html>"),
            "Host rights payload did not match the published contract",
        ),
    ];
    for (fetch, want) in cases {
        let r = HttpHostRights::new("http://svc-identity:4002", legacy("svc-identity"), fetch)
            .perks_of("u-1")
            .unwrap_err();
        assert_eq!(
            (code(&r), message(&r)),
            ("academy.host_rights_unavailable", want)
        );
    }
}

#[test]
fn the_host_rights_cards_stay_consistent() {
    let base = ports::base_perks();
    assert!(!may_host(&base));
    assert!(clients::host_rights_status_line_consistent(
        &clients::host_rights_status_line(&base)
    ));
    assert_eq!(clients::parse_host_rights_status_line("nope"), None);
    assert!(clients::host_rights_export_header().starts_with("mayHost"));
    assert_eq!(clients::host_rights_export_line(&base), "0,0");
    let allowed = Perks(true).perks_of("").unwrap();
    assert_eq!(
        clients::host_rights_status_line(&allowed),
        "mayHost=1 lobbyHostRights=1"
    );
    assert_eq!(
        clients::parse_host_rights_status_line("mayHost=1 lobbyHostRights=1"),
        Some((true, true))
    );
    assert_eq!(clients::host_rights_export_line(&allowed), "1,1");
}

// ── stake-source.test.ts ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_stake_read_signs_a_bodyless_get_with_v2_headers_bound_to_empty_bytes() {
    let fetch = FakeFetch::status(200, r#"{"staked":"0"}"#);
    let stake = HttpStake::new("http://svc-token:4010", legacy("svc-token"), fetch.clone());
    assert_eq!(stake.stake_of("u-1").unwrap(), amt("0"));
    let req = &fetch.sent()[0];
    assert_eq!(req.url, "http://svc-token:4010/internal/stake/u-1");
    assert_eq!(req.body, None);
    assert_eq!(header(req, "x-intafaced-service"), Some("svc-academy"));
    assert!(is_hex64(header(req, "x-intafaced-service-body")));
    assert!(is_hex64(header(req, "x-intafaced-service-sig")));
    assert_eq!(verified_v2(req), Ok("svc-academy".to_owned()));
}

#[test]
fn the_stake_read_fails_closed_with_its_own_words() {
    let cases: Vec<(Arc<FakeFetch>, &str)> = vec![
        (
            FakeFetch::new(|_| {
                Err(FetchError {
                    message: "fetch failed".to_owned(),
                })
            }),
            "Stake gate unavailable: fetch failed",
        ),
        (FakeFetch::status(503, "{}"), "Stake gate unavailable (503)"),
        (
            FakeFetch::status(200, "{}"),
            "Stake gate returned an unusable payload",
        ),
        (
            FakeFetch::status(200, r#"{"staked":12}"#),
            "Stake gate returned an unusable payload",
        ),
        (
            FakeFetch::status(200, "not json"),
            "Stake gate returned an unusable payload",
        ),
        (
            FakeFetch::status(200, r#"{"staked":"1.2.3"}"#),
            "Stake gate returned an unparseable amount",
        ),
    ];
    for (fetch, want) in cases {
        let r = HttpStake::new("http://svc-token:4010/", legacy("svc-token"), fetch)
            .stake_of("u-1")
            .unwrap_err();
        assert_eq!((code(&r), message(&r)), ("academy.stake_unavailable", want));
    }
    let fetch = FakeFetch::status(200, r#"{"staked":"1000.5"}"#);
    assert_eq!(
        HttpStake::new("http://svc-token:4010", legacy("svc-token"), fetch.clone())
            .stake_of("a b")
            .unwrap(),
        amt("1000.5")
    );
    assert_eq!(
        fetch.sent()[0].url,
        "http://svc-token:4010/internal/stake/a%20b"
    );
}

// ── host-rights-keys.test.ts and stake-source-keys.test.ts (`keyCases`) ───────────────────────────────────────────

fn keys(seed: u8) -> (Vec<KeyringEntry>, String) {
    use ed25519_dalek::SigningKey;
    use ed25519_dalek::pkcs8::EncodePrivateKey as _;
    let key = SigningKey::from_bytes(&[seed; 32]);
    let der = key.to_pkcs8_der().unwrap();
    let keyring = vec![KeyringEntry {
        kid: "svc-academy.a".to_owned(),
        svc: "svc-academy".to_owned(),
        use_: "s2s".to_owned(),
        x: URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()),
    }];
    (keyring, URL_SAFE_NO_PAD.encode(der.as_bytes()))
}

fn judged(
    req: &HttpRequest,
    path: &str,
    method: &str,
    verifier: &ServiceVerifier,
    mode: Mode,
) -> s2s_verify::RequestAuth {
    let incoming = Incoming {
        method,
        url: path,
        headers: &req.headers,
        body: Some(b""),
    };
    s2s_verify::verify_request(
        &incoming,
        Some(verifier),
        Some(SECRET),
        mode,
        BodyBind::Require,
        now_seconds(),
    )
}

fn key_cases(audience: &str, call: &dyn Fn(CallSigner, Arc<FakeFetch>)) {
    let path_of = |req: &HttpRequest| url::Url::parse(&req.url).unwrap().path().to_owned();
    // Without a signing key the call is signed with the shared secret as before.
    let fetch = FakeFetch::status(200, "{}");
    call(
        CallSigner::new("svc-academy", audience, SECRET, None),
        fetch.clone(),
    );
    let req = &fetch.sent()[0];
    assert!(
        !req.headers
            .iter()
            .any(|(k, _)| k.starts_with("x-intafaced-s2s-"))
    );
    let (ring, private) = keys(9);
    let verifier = ServiceVerifier::new(audience, &ring, now_seconds)
        .unwrap()
        .with_boot_second(0);
    let shared = judged(req, &path_of(req), "GET", &verifier, Mode::Dual);
    assert_eq!(
        (shared.service.as_deref(), shared.scheme),
        (Some("svc-academy"), Some("shared"))
    );
    for mode in [Mode::Dual, Mode::Keypair] {
        let (ring, private_key) = (ring.clone(), private.clone());
        let signer = Arc::new(
            ServiceSigner::new("svc-academy", "svc-academy.a", &private_key, &ring).unwrap(),
        );
        let fetch = FakeFetch::status(200, "{}");
        call(
            CallSigner::new("svc-academy", audience, SECRET, Some((signer, mode))),
            fetch.clone(),
        );
        let req = &fetch.sent()[0];
        let verifier = ServiceVerifier::new(audience, &ring, now_seconds)
            .unwrap()
            .with_boot_second(0);
        if mode == Mode::Dual {
            // The callee names the caller from the key, and the shared secret rides along.
            assert_eq!(header(req, "x-intafaced-service"), Some("svc-academy"));
            let auth = judged(req, &path_of(req), "GET", &verifier, Mode::Dual);
            assert_eq!(
                (auth.service.as_deref(), auth.scheme, auth.rejected),
                (Some("svc-academy"), Some("keypair"), None)
            );
        } else {
            // Only the key signature is sent, and a keypair-only callee accepts it.
            assert_eq!(header(req, "x-intafaced-service"), None);
            assert_eq!(header(req, "x-intafaced-service-sig"), None);
            let auth = judged(req, &path_of(req), "GET", &verifier, Mode::Keypair);
            assert_eq!(
                (auth.service.as_deref(), auth.scheme),
                (Some("svc-academy"), Some("keypair"))
            );
            // A signed call moved to another path or method is refused.
            let fresh = ServiceVerifier::new(audience, &ring, now_seconds)
                .unwrap()
                .with_boot_second(0);
            assert_eq!(
                judged(req, "/internal/elsewhere", "GET", &fresh, Mode::Keypair).service,
                None
            );
            let fresh = ServiceVerifier::new(audience, &ring, now_seconds)
                .unwrap()
                .with_boot_second(0);
            assert_eq!(
                judged(req, &path_of(req), "POST", &fresh, Mode::Keypair).service,
                None
            );
        }
    }
    let _ = private;
}

#[test]
fn the_host_rights_read_is_signed_with_svc_academys_own_key() {
    key_cases("svc-identity", &|signer, fetch| {
        let _ = HttpHostRights::new("http://identity.test", signer, fetch).perks_of("u-1");
    });
}

#[test]
fn the_stake_read_is_signed_with_svc_academys_own_key() {
    key_cases("svc-token", &|signer, fetch| {
        let _ = HttpStake::new("http://token.test", signer, fetch).stake_of("u-1");
    });
}

// ── stream/provider.test.ts and stream/video-park.test.ts ─────────────────────────────────────────────────────────

#[test]
fn the_null_provider_refuses_rather_than_fabricates() {
    let p = NullStream;
    let open = p.open_room("s").unwrap_err();
    assert_eq!(code(&open), "academy.stream_unavailable");
    assert!(message(&open).contains("ACADEMY_STREAM_PROVIDER"));
    let cred = p.credential("s", "r", "u", "attendee").unwrap_err();
    assert_eq!(code(&cred), "academy.stream_unavailable");
    assert!(message(&cred).contains("text and presence"));
    assert_eq!(p.close_room("r"), Ok(()));
    assert_eq!(p.id(), "null");
    assert!(!p.usable() && !p.constructed() && !p.probed());
    let line = stream::status_line(&p);
    for part in ["usable=0", "constructed=0", "probed=0", "null=1"] {
        assert!(line.contains(part), "{line}");
    }
    assert!(stream::status_line_consistent(&line));
    assert_eq!(stream::parse_status_line("nope"), None);
    assert_eq!(stream::export_line(&p), "null,0,0,0,1");
    assert!(stream::export_header().starts_with("id,"));
}

fn fixed_now() -> Instant {
    Instant(1_795_046_400_123)
}
fn fixed_jti() -> Result<String, Refusal> {
    Ok("00000000-0000-4000-8000-000000000000".to_owned())
}

fn token_payload(token: &str) -> Json {
    let part = token.split('.').nth(1).unwrap();
    json::parse(std::str::from_utf8(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()).unwrap()
}

#[test]
fn livekit_uses_the_room_service_and_signs_a_real_join_token() {
    let fetch = FakeFetch::status(200, r#"{"name":"session-1"}"#);
    let provider = LiveKit::new(
        LiveKitOptions {
            url: "wss://livekit.example".to_owned(),
            api_key: "API123".to_owned(),
            api_secret: "secret".to_owned(),
            token_ttl_seconds: 600,
        },
        fetch.clone(),
    )
    .with_sources(fixed_now, fixed_jti);
    assert_eq!(provider.open_room("session-1").unwrap(), "session-1");
    let credential = provider
        .credential("session-1", "session-1", "u1", "speaker")
        .unwrap();
    let req = &fetch.sent()[0];
    assert_eq!(
        req.url,
        "https://livekit.example/twirp/livekit.RoomService/CreateRoom"
    );
    assert_eq!(req.body.as_deref(), Some(r#"{"name":"session-1"}"#));
    let auth = header(req, "authorization").unwrap();
    let bearer = auth.strip_prefix("Bearer ").unwrap();
    assert_eq!(bearer.split('.').count(), 3);
    assert_eq!(
        token_payload(bearer).compact(),
        r#"{"iss":"API123","sub":"API123","iat":1795046400,"nbf":1795046400,"exp":1795046460,"jti":"00000000-0000-4000-8000-000000000000","video":{"roomCreate":true,"roomAdmin":true}}"#
    );
    assert_eq!(credential.url, "wss://livekit.example");
    assert!(credential.token.starts_with("eyJ"));
    assert_ne!(credential.token, "dev");
    assert_eq!(
        token_payload(&credential.token).compact(),
        r#"{"iss":"API123","sub":"u1","iat":1795046400,"nbf":1795046400,"exp":1795047000,"jti":"00000000-0000-4000-8000-000000000000","video":{"roomJoin":true,"room":"session-1","canPublish":true,"canSubscribe":true,"canPublishData":true}}"#
    );
    assert_eq!(credential.expires_at, Instant(fixed_now().0 + 600_000));
    // The signature is HS256 over the first two parts with the API secret.
    let (body, sig) = credential.token.rsplit_once('.').unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
    mac.update(body.as_bytes());
    assert_eq!(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()), sig);
    // The header is `{"alg":"HS256","typ":"JWT"}`; an attendee cannot publish.
    assert_eq!(
        body.split('.').next().unwrap(),
        URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#)
    );
    let attendee = provider
        .credential("session-1", "", "u2", "attendee")
        .unwrap();
    assert_eq!(
        token_payload(&attendee.token)
            .get("video")
            .unwrap()
            .get("canPublish"),
        Some(&Json::Bool(false))
    );
    assert_eq!(
        token_payload(&attendee.token)
            .get("video")
            .unwrap()
            .get("room"),
        Some(&Json::str("session-1"))
    );
}

#[test]
fn livekit_refuses_by_name_on_a_non_2xx_and_closes_rooms_by_name() {
    let fetch = FakeFetch::status(404, r#"{"code":"not_found"}"#);
    let provider = LiveKit::new(
        LiveKitOptions {
            url: "ws://lk.test/".to_owned(),
            api_key: "k".to_owned(),
            api_secret: "s".to_owned(),
            token_ttl_seconds: 3600,
        },
        fetch.clone(),
    );
    let r = provider.close_room("room-1").unwrap_err();
    assert_eq!(
        (code(&r), message(&r)),
        (
            "academy.stream_unavailable",
            "LiveKit DeleteRoom failed with HTTP 404"
        )
    );
    assert_eq!(
        fetch.sent()[0].url,
        "http://lk.test/twirp/livekit.RoomService/DeleteRoom"
    );
    assert_eq!(
        fetch.sent()[0].body.as_deref(),
        Some(r#"{"room":"room-1"}"#)
    );
    let lost = LiveKit::new(
        LiveKitOptions {
            url: "wss://lk.test".to_owned(),
            api_key: "k".to_owned(),
            api_secret: "s".to_owned(),
            token_ttl_seconds: 3600,
        },
        FakeFetch::new(|_| {
            Err(FetchError {
                message: "fetch failed".to_owned(),
            })
        }),
    );
    assert!(matches!(
        lost.open_room("s").unwrap_err(),
        Refusal::Internal { .. }
    ));
    let unnamed = LiveKit::new(
        LiveKitOptions {
            url: "wss://lk.test".to_owned(),
            api_key: "k".to_owned(),
            api_secret: "s".to_owned(),
            token_ttl_seconds: 3600,
        },
        FakeFetch::status(200, r#"{"name":""}"#),
    );
    assert_eq!(unnamed.open_room("session-9").unwrap(), "session-9");
}

#[test]
fn livekit_is_built_only_from_its_url_and_keys_and_is_never_reported_usable() {
    let wire: Arc<dyn Fetch> = FakeFetch::status(200, "{}");
    let blank = stream_from_env(
        Some("livekit"),
        Some(""),
        Some(""),
        Some(""),
        None,
        wire.clone(),
    );
    assert_eq!(blank.id(), "null");
    assert_eq!(
        stream_from_env(
            Some("none"),
            Some("wss://x"),
            Some("k"),
            Some("s"),
            None,
            wire.clone()
        )
        .id(),
        "null"
    );
    let built = stream_from_env(
        Some("livekit"),
        Some("wss://livekit.example"),
        Some("API123"),
        Some("secret"),
        None,
        wire,
    );
    assert_eq!(built.id(), "livekit");
    assert!(built.constructed() && !built.probed() && !built.usable());
    let mut ports = Ports::unwired();
    ports.stream = built;
    ports.stream_configured = Some("livekit".to_owned());
    assert_eq!(
        ports.ready().get("stream").unwrap().compact(),
        r#"{"id":"livekit","usable":false,"constructed":true,"configured":"livekit","probed":false}"#
    );
    ports.stream = Box::new(NullStream);
    ports.stream_configured = Some("none".to_owned());
    assert_eq!(
        ports.ready().get("stream").unwrap().compact(),
        r#"{"id":"null","usable":false,"constructed":false,"configured":"none","probed":false}"#
    );
}

// ── spatial/scene.test.ts ────────────────────────────────────────────────────────────────────────────────────────

fn v(text: &str) -> Value {
    Value::from_json(&json::parse(text).unwrap())
}

fn big_scene() -> Value {
    let mut props = Vec::new();
    let mut i = 0;
    loop {
        props.push(format!(
            r#"{{"id":"p{i}","kind":"block","position":{{"x":{i},"y":{i}}}}}"#
        ));
        let text = format!(r#"{{"version":1,"props":[{}]}}"#, props.join(","));
        if text.len() > scene::SCENE_MAX_BYTES {
            return v(&text);
        }
        i += 1;
    }
}

fn is_ok(p: &Parsed) -> bool {
    matches!(p, Parsed::Ok(_))
}

#[test]
fn scene_v1_is_a_closed_versioned_schema_with_a_size_budget() {
    assert_eq!(
        scene::parse_scene(&scene::empty_scene()),
        Parsed::Ok(v(r#"{"version":1}"#))
    );
    assert!(is_ok(&scene::parse_scene(&v(
        r#"{"version":1,"stage":{"width":800,"height":600},"avatars":[{"id":"a1","participantId":"seat-9","position":{"x":10,"y":20}}]}"#
    ))));
    assert!(matches!(
        scene::parse_scene(&v(r#"{"stage":{"width":1,"height":1}}"#)),
        Parsed::Err {
            reason: Bad::Invalid,
            ..
        }
    ));
    assert!(!is_ok(&scene::parse_scene(&v(
        r#"{"version":1,"email":"x@y.z"}"#
    ))));
    assert!(!is_ok(&scene::parse_scene(&v(r#"{"version":99}"#))));
    assert!(matches!(
        scene::parse_scene(&big_scene()),
        Parsed::Err {
            reason: Bad::Oversized,
            ..
        }
    ));
    assert_eq!(
        scene::assert_scene(&v(r#"{"version":2}"#))
            .unwrap_err()
            .code,
        "academy.scene_invalid"
    );
    assert_eq!(
        scene::assert_scene(&v("{}")).unwrap_err().code,
        "academy.scene_invalid"
    );
    assert!(!is_ok(&scene::parse_scene(&v(
        r#"{"version":1,"navigableShell":true}"#
    ))));
}

#[test]
fn the_scene_cards_count_without_inventing() {
    let empty = scene::empty_scene();
    assert!(scene::is_durable_scene_empty(&empty));
    assert_eq!(
        (scene::avatar_count(&empty), scene::prop_count(&empty)),
        (0, 0)
    );
    assert!(scene::within_size_budget(&empty));
    assert_eq!(
        scene::parse_status_line(&scene::status_line(&empty)),
        Some([1, 0, 0, 13])
    );
    assert_eq!(scene::parse_status_line("nope"), None);
    assert!(scene::export_text(&empty).starts_with(scene::export_header()));
    let full = v(
        r#"{"version":1,"stage":{"width":800,"height":600},"avatars":[{"id":"a1","participantId":"seat-9","position":{"x":10,"y":20}}],"props":[{"id":"p1","kind":"desk","position":{"x":1,"y":2}}]}"#,
    );
    assert_eq!(
        (scene::avatar_count(&full), scene::prop_count(&full)),
        (1, 1)
    );
    assert!(scene::status_line(&full).contains("avatars=1"));
    assert!(scene::status_line_detailed(&full).contains("stage=1"));
    assert!(scene::export_line(&full).contains("1,1,1,"));
    assert!(scene::byte_size(&full) > 0);
    assert!(scene::navigable_shell_is_residual(
        scene::SCENE_NAVIGABLE_SHELL_RESIDUAL
    ));
    assert!(!scene::navigable_shell_is_residual("canvas product done"));
    assert_eq!(scene::SCENE_MAX_BYTES, 64 * 1024);
    assert_eq!(scene::SCENE_VERSION, 1);
}

// ── spatial/scene-state.test.ts ──────────────────────────────────────────────────────────────────────────────────

const POPULATED: &str = r#"{"version":1,"stage":{"width":800,"height":600},"avatars":[{"id":"a1","participantId":"seat-1","position":{"x":10,"y":20}}]}"#;

#[test]
fn durable_scene_state_round_trips_and_reads_legacy_blanks_as_honest_empty() {
    let State::Ok {
        scene: persisted,
        occupancy,
        ..
    } = scene::persist_scene_state(&v(POPULATED))
    else {
        panic!()
    };
    assert_eq!(occupancy, "populated");
    let stored = Value::from_json(&scene::to_json(&persisted));
    assert_eq!(
        scene::load_scene_state(&stored),
        State::Ok {
            scene: persisted,
            occupancy: "populated",
            source: "stored"
        }
    );
    for blank in [Value::Null, Value::Undefined, v("{}")] {
        let loaded = scene::load_scene_state(&blank);
        assert_eq!(
            loaded,
            State::Ok {
                scene: scene::empty_scene(),
                occupancy: "empty",
                source: "empty_default"
            }
        );
        let State::Ok { scene: s, .. } = loaded else {
            panic!()
        };
        assert!(!scene::stringify(&s).contains("1000"));
    }
    let State::Ok {
        scene: e,
        occupancy,
        ..
    } = scene::persist_scene_state(&scene::empty_scene())
    else {
        panic!()
    };
    assert_eq!(occupancy, "empty");
    assert!(scene::is_durable_scene_empty(&e));
    let State::Ok {
        scene: stage,
        occupancy,
        ..
    } = scene::persist_scene_state(&v(r#"{"version":1,"stage":{"width":400,"height":300}}"#))
    else {
        panic!()
    };
    assert_eq!(occupancy, "populated");
    assert!(scene::require_populated_scene(&stage).is_ok());
    assert!(matches!(
        scene::load_scene_state(&v(r#"{"version":99}"#)),
        State::Err {
            reason: Bad::Invalid,
            ..
        }
    ));
    assert!(matches!(
        scene::persist_scene_state(&big_scene()),
        State::Err {
            reason: Bad::Oversized,
            ..
        }
    ));
}

#[test]
fn an_empty_scene_is_refused_by_name_as_a_room() {
    let State::Ok { scene: s, .. } = scene::load_scene_state(&v("{}")) else {
        panic!()
    };
    assert_eq!(
        scene::require_populated_scene(&s),
        Err("scene is empty — no stage, avatars, or props; refuse fake room")
    );
    assert_eq!(scene::SCENE_EMPTY_REFUSE, "academy.scene_empty");
    let State::Ok { scene: p, .. } = scene::load_scene_state(&v(POPULATED)) else {
        panic!()
    };
    assert_eq!(scene::require_populated_scene(&p), Ok(&p));
}

// ── spatial/edit-policy.test.ts, session-fingerprint.test.ts, update-scene-policy.test.ts ─────────────────────────

fn name(w: &Write) -> Option<&'static str> {
    scene::refuse_name(w)
}

#[test]
fn the_first_write_needs_no_fingerprint_and_a_matching_one_is_accepted() {
    let empty = scene::empty_scene();
    assert!(!scene::requires_host_fingerprint(&empty));
    let next = v(POPULATED);
    let Write::Ok {
        scene: s,
        fingerprint,
    } = scene::decide_host_scene_write(&empty, &next, None)
    else {
        panic!()
    };
    assert_eq!(scene::avatar_count(&s), 1);
    assert_eq!(fingerprint, scene::fingerprint(&s));
    let current = v(
        r#"{"version":1,"stage":{"width":100,"height":100},"avatars":[{"id":"a1","participantId":"seat-1","position":{"x":1,"y":1}}]}"#,
    );
    assert!(scene::requires_host_fingerprint(&current));
    let fp = scene::fingerprint(&current);
    let moved = v(
        r#"{"version":1,"stage":{"width":100,"height":100},"avatars":[{"id":"a1","participantId":"seat-1","position":{"x":50,"y":50}}]}"#,
    );
    let Write::Ok { scene: s, .. } = scene::decide_host_scene_write(&current, &moved, Some(&fp))
    else {
        panic!()
    };
    assert_eq!(
        scene::stringify(s.get("avatars")),
        r#"[{"id":"a1","participantId":"seat-1","position":{"x":50,"y":50}}]"#
    );
}

#[test]
fn a_write_onto_a_non_empty_scene_without_a_fingerprint_or_with_a_stale_one_is_refused_by_name() {
    let current = v(
        r#"{"version":1,"stage":{"width":100,"height":100},"avatars":[{"id":"a1","participantId":"seat-1","position":{"x":1,"y":1}}]}"#,
    );
    let omitted = scene::decide_host_scene_write(&current, &v(r#"{"version":1}"#), None);
    assert_eq!(name(&omitted), Some(scene::FINGERPRINT_REQUIRED));
    let Write::Conflict { message, .. } = &omitted else {
        panic!()
    };
    assert!(message.contains("fingerprint required"));
    assert!(!scene::has_expected_fingerprint(Some("   ")));
    let stage_only = v(r#"{"version":1,"stage":{"width":100,"height":100}}"#);
    assert_eq!(
        name(&scene::decide_host_scene_write(
            &stage_only,
            &v(r#"{"version":1,"stage":{"width":200,"height":200}}"#),
            Some("   ")
        )),
        Some(scene::FINGERPRINT_REQUIRED)
    );
    let props_only =
        v(r#"{"version":1,"props":[{"id":"p1","kind":"desk","position":{"x":0,"y":0}}]}"#);
    assert!(scene::requires_host_fingerprint(&props_only));
    assert_eq!(
        name(&scene::decide_host_scene_write(
            &props_only,
            &v(r#"{"version":1}"#),
            None
        )),
        Some(scene::FINGERPRINT_REQUIRED)
    );
    let stale = scene::decide_host_scene_write(
        &scene::empty_scene(),
        &v(r#"{"version":1}"#),
        Some(&"deadbeef".repeat(8)),
    );
    assert_eq!(name(&stale), Some(scene::FINGERPRINT_MISMATCH));
    let zeros =
        scene::decide_host_scene_write(&scene::empty_scene(), &stage_only, Some(&"0".repeat(64)));
    assert_eq!(name(&zeros), Some(scene::FINGERPRINT_MISMATCH));
    let fp = scene::fingerprint(&scene::empty_scene());
    assert!(matches!(
        scene::decide_host_scene_write(&scene::empty_scene(), &stage_only, Some(&fp)),
        Write::Ok { .. }
    ));
    let ok = scene::decide_host_scene_write(
        &stage_only,
        &v(r#"{"version":1,"stage":{"width":20,"height":20}}"#),
        Some(&scene::fingerprint(&stage_only)),
    );
    assert!(matches!(ok, Write::Ok { .. }));
}

#[test]
fn invalid_oversized_and_colliding_scenes_are_refused() {
    let empty = scene::empty_scene();
    let bad = scene::decide_host_scene_write(&empty, &v(r#"{"version":99}"#), None);
    assert!(matches!(
        bad,
        Write::Refused {
            reason: Bad::Invalid,
            ..
        }
    ));
    assert_eq!(name(&bad), None);
    assert!(matches!(
        scene::decide_host_scene_write(&empty, &big_scene(), None),
        Write::Refused {
            reason: Bad::Oversized,
            ..
        }
    ));
    let twins = scene::decide_host_scene_write(
        &empty,
        &v(
            r#"{"version":1,"avatars":[{"id":"a1","participantId":"seat-1","position":{"x":0,"y":0}},{"id":"a2","participantId":"seat-1","position":{"x":1,"y":1}}]}"#,
        ),
        None,
    );
    let Write::PresenceCollision { message } = twins else {
        panic!()
    };
    assert!(message.contains("seat-1"));
    let same_id = scene::decide_host_scene_write(
        &empty,
        &v(
            r#"{"version":1,"avatars":[{"id":"a1","participantId":"seat-1","position":{"x":0,"y":0}},{"id":"a1","participantId":"seat-2","position":{"x":1,"y":1}}]}"#,
        ),
        None,
    );
    assert!(matches!(same_id, Write::PresenceCollision { .. }));
}

#[test]
fn the_read_fingerprint_is_the_token_the_write_checks() {
    let fp_empty = scene::fingerprint(&scene::empty_scene());
    assert_eq!(
        scene::fingerprint(&scene::readable_or_empty(&v("{}"))),
        fp_empty
    );
    assert_eq!(
        scene::fingerprint(&scene::readable_or_empty(&v(r#"{"version":1}"#))),
        fp_empty
    );
    let a = v(r#"{"version":1,"stage":{"width":10,"height":10}}"#);
    assert_eq!(
        scene::fingerprint(&a),
        scene::fingerprint(&v(r#"{"version":1,"stage":{"width":10,"height":10}}"#))
    );
    let next = v(
        r#"{"version":1,"stage":{"width":20,"height":20},"avatars":[{"id":"a1","participantId":"p1","position":{"x":1,"y":2}}]}"#,
    );
    let Write::Ok {
        scene: written,
        fingerprint,
    } = scene::decide_host_scene_write(&scene::empty_scene(), &next, None)
    else {
        panic!()
    };
    // Stored as jsonb (keys reordered by length), read back: the same token.
    let stored = v(
        r#"{"stage":{"width":20,"height":20},"avatars":[{"id":"a1","position":{"x":1,"y":2},"participantId":"p1"}],"version":1}"#,
    );
    assert_eq!(
        scene::fingerprint(&scene::readable_or_empty(&stored)),
        fingerprint
    );
    let wider = v(
        r#"{"version":1,"stage":{"width":30,"height":30},"avatars":[{"id":"a1","participantId":"p1","position":{"x":1,"y":2}}]}"#,
    );
    assert_eq!(
        name(&scene::decide_host_scene_write(
            &written,
            &wider,
            Some("deadbeef")
        )),
        Some(scene::FINGERPRINT_MISMATCH)
    );
    assert!(matches!(
        scene::decide_host_scene_write(&written, &wider, Some(&fingerprint)),
        Write::Ok { .. }
    ));
    assert_eq!(
        name(&scene::decide_host_scene_write(&written, &wider, None)),
        Some(scene::FINGERPRINT_REQUIRED)
    );
    // An unreadable `{}` is the empty scene before the decision.
    assert!(!is_ok(&scene::parse_scene(&v("{}"))));
    assert!(matches!(
        scene::decide_host_scene_write(
            &scene::readable_or_empty(&v("{}")),
            &v(r#"{"version":1}"#),
            None
        ),
        Write::Ok { .. }
    ));
}

/// A stake source that is never asked: the lobbies above never needed one.
#[allow(dead_code, reason = "kept to show the port's shape in one place")]
struct NoStake;
impl Stake for NoStake {
    fn stake_of(&self, _: &str) -> Result<i128, Refusal> {
        panic!("not asked")
    }
}
