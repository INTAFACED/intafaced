//! Slice `cards`' secrets (card details, PIN and phone wallets, J-bank-14 #3, #4; and `cards.rewards`), against the Rust
//! door on a real Postgres. Ports the checks of `cards/cards-procedures.test.ts` ("customer card procedures (PG-hard)")
//! and `bank-honesty.public.test.ts` ("card rewards") that fall on `cards.reveal`, `cards.pin.reveal`, `cards.pin.set`,
//! `cards.walletProvision`, `cards.walletTokens`, `cards.secretsOffered` and `cards.rewards`, each test named after the
//! TypeScript test's words and entering through the door (`BankDoor`) where the TypeScript calls the router, or through
//! the slice's own function where it calls `CardService` (`bank.cards.issue`, `cards.walletProvision`).
//!
//! What differs from the TypeScript, and why:
//! - "refuses PAN, PIN reveal and PIN set when step-up is not switched on" and "returns a live issuer secret once,
//!   audits the reveal, and does not store the secret" use a hand-written live issuer fixture (`liveIssuer()`, programme
//!   `outside-issuer`, fixed PAN, PIN and payload). The Rust issuer port has no such fixture: its only issuer that
//!   answers a secret is the TEST partner's simulator with `secrets: "test"`, which runs the same path
//!   (`liveSecretProgramme` is true for both). These two run on it, so their answers say `test: true` and the secrets
//!   are the simulator's derived ones; "the issuer was not called" is read from the simulator's own book (no PIN held).
//! - "sets a TEST PIN and blocks it at the owner count of wrong tries, until a new PIN is set": the PIN typed at a
//!   terminal goes through `ops.cardAuthorize`, slice `card-ops`', not ported. Its `cards.pin.*` half is ported here
//!   (not set, set, shown, never stored), and the try count is read on the issuer's own `verifyPin`, the call
//!   `cardAuthorize` makes, to show that a PIN set through `cards.pin.set` clears the wrong tries.
//! - "a phone-wallet add sent twice at once with one provision id is one token and no error (#8895)": the TypeScript holds
//!   every call's token insert until the round's calls all reach it; here eight threads start each round at one barrier
//!   on their own connections, which races the audit and the token insert without lining the inserts up exactly.
//!
//! Not ported:
//! - "declines a typed PIN by name while the owner has not set the try limit": wholly `ops.cardAuthorize` (`card-ops`).
//! - The completion of 3D Secure and fraud reports in the same suite: area `safety`'s.
//! - `partner-terms.test.ts`, "the TEST partner card details, PIN and wallet switch": parsing the switch and the PIN try
//!   limit (`terms.rs`), not these calls.
//! - `bank-honesty.public.test.ts`, "keeps the card programme marked simulated and does not name an issuer":
//!   `cards.programme`, area `core`'s.
//! - `cards.procedures (source)` "is not skip-green": reads the TypeScript source file.
//!
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Arc, Barrier, Mutex};

use service_kit::approvals::{ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, zod_datetime};
use svc_bank::cards::core::{IssueAsk, issue};
use svc_bank::cards::issuer::{Issuer, PinVerdict};
use svc_bank::cards::secrets;
use svc_bank::cards::terms::PartnerTerms;
use svc_bank::cards::{Settings as CardSettings, Wiring as CardWiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::TestPartner;
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Settings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-card-procedures-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-card-secrets-internal-secret-long-enough";
const HOLDER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "99999999-9999-4999-8999-999999999999";
const SID: &str = "22222222-2222-4222-8222-222222222222";
const PIN: &str = "135790";

fn now() -> Instant {
    zod_datetime("2026-06-15T12:00:00.000Z", true).unwrap()
}

const EXPIRES: &str = "2026-06-15T12:01:00.000Z";

/// A fresh v4-shaped id: the call's guid fields need one.
fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// svc-identity's same-person consume: the TypeScript suite's `FakeIdentity` (user, session, hash; once).

struct Row {
    action_type: String,
    hash: String,
    consumed: bool,
}

#[derive(Clone, Default)]
struct FakeIdentity(Arc<Mutex<(BTreeMap<String, Row>, usize)>>);

impl FakeIdentity {
    fn approve(&self, action: &str, fields: &[(&str, &str)]) -> String {
        let fields: Vec<(String, String)> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let mut s = self.0.lock().unwrap();
        s.1 += 1;
        let id = format!("approval-{}", s.1);
        s.0.insert(
            id.clone(),
            Row {
                action_type: action.to_owned(),
                hash: payload_hash(action, &fields),
                consumed: false,
            },
        );
        id
    }
}

impl Approvals for FakeIdentity {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let refused = |code: &str| {
            Err(ConsumeError::Refused(format!(
                "identity refused consume (412) {{\"message\":\"x [action_approval.{code}]\"}}"
            )))
        };
        let mut s = self.0.lock().unwrap();
        let Some(row) = s.0.get_mut(input.approval_id) else {
            return refused("not_found");
        };
        if input.target_service != "svc-bank"
            || input.target_id != row.action_type
            || input.operation_id != input.approval_id
        {
            return refused("target_mismatch");
        }
        if row.hash != input.payload_hash {
            return refused("payload_mismatch");
        }
        let p = principal.expect("a same-person consume binds the person");
        if p.user_id != HOLDER || p.session_id != SID {
            return refused("not_requester");
        }
        if row.consumed {
            return refused("consumed");
        }
        row.consumed = true;
        Ok((
            Consumed {
                action_type: row.action_type.clone(),
                target_service: "svc-bank".to_owned(),
                target_id: input.target_id.to_owned(),
                status: "CONSUMED".to_owned(),
                requester_id: HOLDER.to_owned(),
                approver_id: Some(HOLDER.to_owned()),
                approver_is_founder: None,
                requester_is_founder: None,
            },
            Facts {
                kind: Some("same_person".to_owned()),
                expires_at: Instant(now().0 + 300_000).iso(),
            },
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door

struct Setup {
    /// `secrets: "test"` on the simulator.
    secrets: bool,
    /// `BANK_STEP_UP_MONEY_OUT=required`, with the stand-in identity.
    step_up: bool,
    /// The TEST partner (its switches), as `createBankServices` wires it when given one.
    partner: bool,
    /// The door's pool size.
    pool: usize,
}

const FRESH_SIM: Setup = Setup {
    secrets: false,
    step_up: false,
    partner: false,
    pool: 2,
};

/// `testSecretsSim(3)`: the TEST partner adapter with `secrets: "test"`, step-up required.
const TEST_SECRETS: Setup = Setup {
    secrets: true,
    step_up: true,
    partner: false,
    pool: 2,
};

struct Bank {
    door: BankDoor,
    db: TestDb,
    identity: FakeIdentity,
}

fn bank(s: &Setup) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let identity = FakeIdentity::default();
    let mut terms = PartnerTerms::nothing_reported();
    terms.test_secrets = s.secrets;
    let cards = CardWiring {
        issuer: Issuer::sim(terms),
        rank: Box::new(svc_bank::cards::NoRankTier),
        settings: CardSettings {
            pin_try_limit: Some(3),
            ..CardSettings::default()
        },
    };
    let mut transfers = TransfersWiring::none();
    if s.step_up {
        transfers.approvals = Box::new(identity.clone());
    }
    transfers.settings = Settings {
        step_up_required: s.step_up,
        producer: "svc-bank".to_owned(),
        ..Settings::default()
    };
    let mut partner = PartnerWiring::none();
    if s.partner {
        partner.partner = Some(TestPartner::new().unwrap());
    }
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let door = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now,
        store: svc_bank::db::open(&db.url, "svc-bank", s.pool, false).unwrap(),
    })
    .unwrap()
    .with_partner(partner)
    .with_transfers(transfers)
    .with_cards(cards);
    Some(Bank { door, db, identity })
}

fn principal(user: &str) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(vec![Json::str("bank:read"), Json::str("bank:write")]),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str(SID)),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
struct Answer(u16, Json);

impl Answer {
    fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    fn code(&self) -> String {
        let cause = self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"));
        match (self.0, cause) {
            (200, _) => "ok".to_owned(),
            (_, Some(Json::String(c))) => c.clone(),
            (status, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
    fn trpc(&self) -> String {
        match self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ => "ok".to_owned(),
        }
    }
    /// Everything the refusal says: the message and the cause's message.
    fn words(&self) -> String {
        let e = self.1.get("error");
        let s = |j: Option<&Json>| match j {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        };
        format!(
            "{} {}",
            s(e.and_then(|e| e.get("message"))),
            s(e.and_then(|e| e.get("data"))
                .and_then(|d| d.get("cause"))
                .and_then(|c| c.get("message")))
        )
    }
}

fn call_as(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    let mut headers = principal(user);
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-card-secrets",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, path: &str, input: &str) -> Answer {
    call_as(b, HOLDER, path, input)
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{key}: {other:?} in {}", j.compact()),
    }
}

/// `bank.cards.issue(...)`: a virtual USDT card with a 100 per-authorisation limit, through the slice's own function.
fn issue_card(b: &Bank, user: &str) -> String {
    let card_id = uuid();
    b.door
        .cards_deps(now(), |d| {
            issue(
                d,
                &IssueAsk {
                    card_id: card_id.clone(),
                    user_id: user.to_owned(),
                    asset_id: "USDT".to_owned(),
                    per_authorization_limit: parse_amount("100").unwrap(),
                    ..IssueAsk::default()
                },
            )
        })
        .unwrap();
    card_id
}

fn reveal(b: &Bank, card: &str, reveal_id: &str, approval: Option<&str>) -> Answer {
    let step = approval.map_or(String::new(), |a| format!(r#","stepUpApprovalId":"{a}""#));
    call(
        b,
        "cards.reveal",
        &format!(r#"{{"cardId":"{card}","revealId":"{reveal_id}"{step}}}"#),
    )
}

fn pin_reveal(b: &Bank, card: &str, reveal_id: &str, approval: Option<&str>) -> Answer {
    let step = approval.map_or(String::new(), |a| format!(r#","stepUpApprovalId":"{a}""#));
    call(
        b,
        "cards.pin.reveal",
        &format!(r#"{{"cardId":"{card}","revealId":"{reveal_id}"{step}}}"#),
    )
}

fn pin_set(b: &Bank, card: &str, command: &str, pin: &str, approval: Option<&str>) -> Answer {
    let step = approval.map_or(String::new(), |a| format!(r#","stepUpApprovalId":"{a}""#));
    call(
        b,
        "cards.pin.set",
        &format!(r#"{{"cardId":"{card}","commandId":"{command}","pin":"{pin}"{step}}}"#),
    )
}

/// `cards.pin.set` with its own fresh step-up.
fn set_pin_approved(b: &Bank, card: &str, pin: &str) -> Answer {
    let command = uuid();
    let a = b.identity.approve(
        "bank.step_up.cards.pinSet",
        &[("actor", HOLDER), ("cardId", card), ("commandId", &command)],
    );
    pin_set(b, card, &command, pin, Some(&a))
}

/// `cards.pin.reveal` with its own fresh step-up.
fn reveal_pin_approved(b: &Bank, card: &str) -> Answer {
    let id = uuid();
    let a = b.identity.approve(
        "bank.step_up.cards.pinReveal",
        &[("actor", HOLDER), ("cardId", card), ("revealId", &id)],
    );
    pin_reveal(b, card, &id, Some(&a))
}

fn provision(b: &Bank, card: &str, provision_id: &str, wallet: &str, nonce: &str) -> Answer {
    call(
        b,
        "cards.walletProvision",
        &format!(
            r#"{{"cardId":"{card}","provisionId":"{provision_id}","wallet":"{wallet}","nonce":"{nonce}"}}"#
        ),
    )
}

fn tokens(b: &Bank, card: &str) -> Json {
    call(
        b,
        "cards.walletTokens",
        &format!(r#"{{"cardId":"{card}"}}"#),
    )
    .ok()
}

fn token_list(b: &Bank, card: &str) -> Vec<Json> {
    match tokens(b, card).get("tokens") {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("tokens: {other:?}"),
    }
}

fn offered(b: &Bank) -> String {
    call(b, "cards.secretsOffered", "{}").ok().compact()
}

/// Every stored value of a table, as text, with the random ids, hashes and clock times masked first (`storedText`): a
/// three-digit CVV or a PIN may occur inside one of those by chance.
fn dump(b: &Bank, table: &str) -> String {
    b.db.client()
        .query(
            &format!(
                "SELECT regexp_replace(coalesce(json_agg(t)::text, '[]'), \
                   '[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}|[0-9a-f]{{64}}|\
                    [0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}T[0-9:.+-]+', '<masked>', 'g') FROM bank.{table} t"
            ),
            &[],
        )
        .unwrap()[0]
        .get(0)
}

fn audit_kinds(b: &Bank) -> Vec<String> {
    b.db.client()
        .query(
            "SELECT kind FROM bank.card_secret_audits ORDER BY kind",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

fn luhn_ok(digits: &str) -> bool {
    let sum: u32 = digits
        .chars()
        .rev()
        .enumerate()
        .map(|(i, c)| {
            let d = c.to_digit(10).unwrap();
            if i % 2 == 1 {
                let x = d * 2;
                if x > 9 { x - 9 } else { x }
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

// ---------------------------------------------------------------------------------------------------------------
// cards-procedures.test.ts, "customer card procedures (PG-hard)"

#[test]
fn refuses_pan_pin_and_wallet_on_the_simulated_programme_and_stores_neither_secret() {
    let Some(b) = bank(&FRESH_SIM) else { return };
    let card = uuid();
    call(
        &b,
        "cards.issue",
        &format!(r#"{{"cardId":"{card}","assetId":"USDT","perAuthorizationLimit":"100"}}"#),
    )
    .ok();
    assert_eq!(
        reveal(&b, &card, &uuid(), None).code(),
        "bank.card_pan_issuer_unset"
    );
    assert_eq!(
        pin_reveal(&b, &card, &uuid(), None).code(),
        "bank.card_pin_issuer_unset"
    );
    assert_eq!(
        pin_set(&b, &card, &uuid(), PIN, None).code(),
        "bank.card_pin_issuer_unset"
    );
    assert_eq!(
        provision(&b, &card, &uuid(), "apple", "nonce-1").code(),
        "bank.card_wallet_issuer_unset"
    );
    assert_eq!(
        call(&b, "cards.rewards", "{}").code(),
        "bank.rewards_issuer_unset"
    );
    assert!(!dump(&b, "cards").contains(PIN));
    assert_eq!(dump(&b, "card_secret_audits"), "[]");
}

#[test]
fn refuses_pan_pin_reveal_and_pin_set_when_step_up_is_not_switched_on() {
    let Some(b) = bank(&Setup {
        step_up: false,
        ..TEST_SECRETS
    }) else {
        return;
    };
    let card = issue_card(&b, HOLDER);
    for a in [
        reveal(&b, &card, &uuid(), None),
        pin_reveal(&b, &card, &uuid(), None),
        pin_set(&b, &card, &uuid(), PIN, None),
    ] {
        assert_eq!(a.code(), "bank.step_up_unavailable");
    }
    // The issuer was not asked: it holds no PIN for the card.
    assert_eq!(
        b.door
            .cards()
            .issuer
            .reveal_pin(&card)
            .unwrap()
            .unwrap_err(),
        svc_bank::partner::refuse(
            "bank.card_pin_not_set",
            "This card has no PIN yet. Set one first."
        )
    );
    assert_eq!(
        b.db.count("SELECT count(*) FROM bank.card_secret_audits"),
        0
    );
}

#[test]
fn returns_a_live_issuer_secret_once_audits_the_reveal_and_does_not_store_the_secret() {
    let Some(b) = bank(&TEST_SECRETS) else { return };
    let card = issue_card(&b, HOLDER);
    let reveal_id = uuid();
    assert_eq!(
        reveal(&b, &card, &reveal_id, None).code(),
        "bank.step_up_required"
    );
    let approval = b.identity.approve(
        "bank.step_up.cards.reveal",
        &[
            ("actor", HOLDER),
            ("cardId", &card),
            ("revealId", &reveal_id),
        ],
    );
    let revealed = reveal(&b, &card, &reveal_id, Some(&approval)).ok();
    let (pan, expiry, cvv) = b.door.cards().issuer.reveal_credentials(&card).unwrap();
    assert_eq!(
        revealed.compact(),
        Json::obj([
            ("pan", Json::str(pan.clone())),
            ("expiry", Json::str(expiry)),
            ("cvv", Json::str(cvv.clone())),
            ("expiresAt", Json::str(EXPIRES)),
            ("test", Json::Bool(true)),
        ])
        .compact()
    );
    assert_eq!(
        reveal(&b, &card, &reveal_id, Some(&approval)).code(),
        "bank.step_up_used"
    );
    let pin_id = uuid();
    let pin_approval = b.identity.approve(
        "bank.step_up.cards.pinSet",
        &[("actor", HOLDER), ("cardId", &card), ("commandId", &pin_id)],
    );
    assert_eq!(
        pin_set(&b, &card, &pin_id, "12", Some(&pin_approval)).code(),
        "bank.card_pin_invalid"
    );
    assert_eq!(
        set_pin_approved(&b, &card, PIN).ok().compact(),
        r#"{"ok":true}"#
    );
    assert_eq!(
        reveal_pin_approved(&b, &card).ok().compact(),
        format!(r#"{{"pin":"{PIN}","expiresAt":"{EXPIRES}","test":true}}"#)
    );
    let wallet = provision(&b, &card, &uuid(), "google", "device-nonce").ok();
    let payload = s(&wallet, "payload");
    assert!(payload.starts_with("TEST-wallet-google-"), "{payload}");
    assert_eq!(s(&wallet, "expiresAt"), EXPIRES);
    assert_eq!(wallet.get("test"), Some(&Json::Bool(true)));
    let stored = dump(&b, "cards");
    let audits = dump(&b, "card_secret_audits");
    for secret in [&pan, &cvv, &payload] {
        assert!(!stored.contains(secret.as_str()), "{secret} in cards");
        assert!(!audits.contains(secret.as_str()), "{secret} in audits");
    }
    assert!(!stored.contains(PIN) && !audits.contains(PIN));
    assert_eq!(
        audit_kinds(&b),
        ["pan_reveal", "pin_reveal", "pin_set", "wallet_provision"]
    );
}

#[test]
fn shows_the_test_partner_card_details_once_per_step_up_labelled_test_and_keeps_none_of_them() {
    let Some(b) = bank(&TEST_SECRETS) else { return };
    assert_eq!(
        offered(&b),
        r#"{"details":true,"pin":true,"wallet":true,"test":true,"walletNotOffered":false}"#
    );
    let card = issue_card(&b, HOLDER);
    let reveal_id = uuid();
    let approval = b.identity.approve(
        "bank.step_up.cards.reveal",
        &[
            ("actor", HOLDER),
            ("cardId", &card),
            ("revealId", &reveal_id),
        ],
    );
    let revealed = reveal(&b, &card, &reveal_id, Some(&approval)).ok();
    assert_eq!(revealed.get("test"), Some(&Json::Bool(true)));
    assert_eq!(s(&revealed, "expiresAt"), EXPIRES);
    let pan = s(&revealed, "pan");
    assert!(
        pan.len() == 16 && pan.starts_with("999999") && pan.bytes().all(|c| c.is_ascii_digit()),
        "{pan}"
    );
    assert!(luhn_ok(&pan));
    let expiry = s(&revealed, "expiry");
    let (month, year) = expiry.split_once('/').unwrap();
    assert!(
        (1..=12).contains(&month.parse::<u32>().unwrap()) && month.len() == 2,
        "{expiry}"
    );
    assert!(["30", "31", "32", "33", "34"].contains(&year), "{expiry}");
    let cvv = s(&revealed, "cvv");
    assert!(cvv.len() == 3 && cvv.bytes().all(|c| c.is_ascii_digit()));
    // A second reveal is a new reveal id and needs its own step-up; the first approval does not carry over.
    let again = uuid();
    let carried = reveal(&b, &card, &again, Some(&approval)).code();
    assert!(
        [
            "bank.step_up_used",
            "bank.step_up_mismatch",
            "bank.step_up_required",
            "bank.step_up_invalid"
        ]
        .contains(&carried.as_str()),
        "{carried}"
    );
    assert_eq!(
        reveal(&b, &card, &again, None).code(),
        "bank.step_up_required"
    );
    let fresh = b.identity.approve(
        "bank.step_up.cards.reveal",
        &[("actor", HOLDER), ("cardId", &card), ("revealId", &again)],
    );
    let second = reveal(&b, &card, &again, Some(&fresh)).ok();
    assert_eq!(s(&second, "pan"), pan);
    let stored = dump(&b, "cards") + &dump(&b, "card_secret_audits");
    assert!(!stored.contains(&pan));
}

#[test]
fn sets_a_test_pin_and_blocks_it_at_the_owner_count_of_wrong_tries_until_a_new_pin_is_set() {
    let Some(b) = bank(&TEST_SECRETS) else { return };
    let card = issue_card(&b, HOLDER);
    let issuer = &b.door.cards().issuer;
    let mut n = 0;
    let mut tap = |pin: &str| {
        n += 1;
        issuer
            .verify_pin(&card, &format!("auth-pin-{n}"), pin, 3)
            .unwrap()
    };
    // No PIN yet: nothing to show, and a typed PIN is "not set".
    assert_eq!(
        reveal_pin_approved(&b, &card).code(),
        "bank.card_pin_not_set"
    );
    assert_eq!(tap("1234"), PinVerdict::Unset);
    assert_eq!(
        set_pin_approved(&b, &card, "4321").ok().compact(),
        r#"{"ok":true}"#
    );
    assert_eq!(
        reveal_pin_approved(&b, &card).ok().compact(),
        format!(r#"{{"pin":"4321","expiresAt":"{EXPIRES}","test":true}}"#)
    );
    assert_eq!(tap("4321"), PinVerdict::Ok);
    assert_eq!(tap("0000"), PinVerdict::Wrong);
    assert_eq!(tap("0000"), PinVerdict::Wrong);
    assert_eq!(tap("0000"), PinVerdict::Blocked);
    assert_eq!(tap("4321"), PinVerdict::Blocked);
    // A new PIN through cards.pin.set clears the wrong tries.
    set_pin_approved(&b, &card, "8642").ok();
    assert_eq!(tap("8642"), PinVerdict::Ok);
    let stored = dump(&b, "card_secret_audits") + &dump(&b, "cards");
    assert!(!stored.contains("4321") && !stored.contains("8642"));
    // Only the reveals that showed a PIN and the two sets are audited: "not set" audits nothing.
    assert_eq!(audit_kinds(&b), ["pin_reveal", "pin_set", "pin_set"]);
}

#[test]
fn adds_the_card_to_a_phone_wallet_once_per_wallet_shows_its_tokens_paused_while_frozen_and_adds_none_to_a_frozen_card()
 {
    let Some(b) = bank(&TEST_SECRETS) else { return };
    let card = issue_card(&b, HOLDER);
    let first = provision(&b, &card, &uuid(), "apple", "device-a").ok();
    assert_eq!(first.get("test"), Some(&Json::Bool(true)));
    let payload = s(&first, "payload");
    assert!(payload.starts_with("TEST-wallet-apple-"), "{payload}");
    // The same card into the same wallet again is the same token.
    provision(&b, &card, &uuid(), "apple", "device-b").ok();
    let added = tokens(&b, &card);
    assert_eq!(added.get("test"), Some(&Json::Bool(true)));
    let list = token_list(&b, &card);
    assert_eq!(list.len(), 1);
    assert_eq!(s(&list[0], "wallet"), "apple");
    assert_eq!(s(&list[0], "state"), "added");

    call(
        &b,
        "cards.setStatus",
        &format!(r#"{{"cardId":"{card}","status":"frozen"}}"#),
    )
    .ok();
    let list = token_list(&b, &card);
    assert_eq!(list.len(), 1);
    assert_eq!(
        (s(&list[0], "wallet"), s(&list[0], "state")),
        ("apple".to_owned(), "paused".to_owned())
    );
    assert_eq!(
        provision(&b, &card, &uuid(), "google", "device-c").code(),
        "bank.card_not_active"
    );
    assert_eq!(token_list(&b, &card).len(), 1);
    assert!(!dump(&b, "card_wallet_tokens").contains(&payload));
}

#[test]
fn a_phone_wallet_add_sent_twice_at_once_with_one_provision_id_is_one_token_and_no_error_8895() {
    const ROUND: usize = 8;
    let Some(b) = bank(&Setup {
        pool: ROUND,
        ..TEST_SECRETS
    }) else {
        return;
    };
    for _ in 0..30 {
        let card = issue_card(&b, HOLDER);
        let provision_id = uuid();
        let gate = Barrier::new(ROUND);
        let errors: Vec<String> = std::thread::scope(|sc| {
            let runs: Vec<_> = (0..ROUND)
                .map(|_| {
                    sc.spawn(|| {
                        gate.wait();
                        b.door.cards_deps(now(), |d| {
                            secrets::wallet_provision(
                                d,
                                &card,
                                HOLDER,
                                &provision_id,
                                "apple",
                                "device-race",
                            )
                        })
                    })
                })
                .collect();
            runs.into_iter()
                .filter_map(|r| r.join().unwrap().err().map(|e| format!("{e:?}")))
                .collect()
        });
        assert_eq!(errors, Vec::<String>::new());
        let ids: Vec<String> =
            b.db.client()
                .query(
                    "SELECT id::text FROM bank.card_wallet_tokens WHERE card_id = $1::text::uuid",
                    &[&card],
                )
                .unwrap()
                .iter()
                .map(|r| r.get(0))
                .collect();
        assert_eq!(ids, [provision_id]);
    }
}

#[test]
fn a_card_partner_that_does_not_add_cards_to_phone_wallets_reads_not_offered_by_the_partner_and_refuses_adding_nothing_j_bank_13_8()
 {
    let Some(b) = bank(&Setup {
        partner: true,
        ..TEST_SECRETS
    }) else {
        return;
    };
    call(&b, "testPartner.set", r#"{"notOffered":["phone_wallet"]}"#).ok();
    assert_eq!(
        offered(&b),
        r#"{"details":true,"pin":true,"wallet":false,"test":true,"walletNotOffered":true}"#
    );
    let card = issue_card(&b, HOLDER);
    let refused = provision(&b, &card, &uuid(), "apple", "device-n");
    assert_eq!(refused.code(), "bank.not_offered_by_partner");
    assert!(
        refused.words().contains(
            "Not offered by the partner: adding a card to a phone wallet. Nothing was sent or changed."
        ),
        "{}",
        refused.words()
    );
    assert!(token_list(&b, &card).is_empty());
    assert_eq!(
        b.db.count("SELECT count(*) FROM bank.card_secret_audits WHERE kind = 'wallet_provision'"),
        0
    );
    // The partner offers it again: the same person's card goes in.
    call(&b, "testPartner.set", r#"{"notOffered":[]}"#).ok();
    let again = call(&b, "cards.secretsOffered", "{}").ok();
    assert_eq!(again.get("wallet"), Some(&Json::Bool(true)));
    assert_eq!(again.get("walletNotOffered"), Some(&Json::Bool(false)));
    provision(&b, &card, &uuid(), "apple", "device-o").ok();
    let list = token_list(&b, &card);
    assert_eq!(list.len(), 1);
    assert_eq!(
        (s(&list[0], "wallet"), s(&list[0], "state")),
        ("apple".to_owned(), "added".to_owned())
    );
}

#[test]
fn keeps_card_sim_without_secrets_refusing_card_details_pin_and_wallet_by_name() {
    let Some(b) = bank(&FRESH_SIM) else { return };
    let card = uuid();
    call(
        &b,
        "cards.issue",
        &format!(r#"{{"cardId":"{card}","assetId":"USDT","perAuthorizationLimit":"100"}}"#),
    )
    .ok();
    assert_eq!(
        provision(&b, &card, &uuid(), "apple", "n").code(),
        "bank.card_wallet_issuer_unset"
    );
    assert_eq!(tokens(&b, &card).compact(), r#"{"test":false,"tokens":[]}"#);
    assert_eq!(
        offered(&b),
        r#"{"details":false,"pin":false,"wallet":false,"test":false,"walletNotOffered":false}"#
    );
}

// ---------------------------------------------------------------------------------------------------------------
// bank-honesty.public.test.ts, "card rewards"

#[test]
fn refuses_until_a_card_issuer_is_connected_and_posts_no_rewards_balance() {
    let Some(b) = bank(&FRESH_SIM) else { return };
    let a = call(&b, "cards.rewards", "{}");
    assert_eq!((a.0, a.trpc()), (412, "PRECONDITION_FAILED".to_owned()));
    assert_eq!(a.code(), "bank.rewards_issuer_unset");
    // The wire carries the code; the words are the refusal's own, as the TypeScript reads them from its cause.
    let refused = b
        .door
        .cards_deps(now(), |d| secrets::rewards(d, HOLDER))
        .unwrap_err();
    let words = format!("{refused:?}");
    assert!(words.to_lowercase().contains("outside company"), "{words}");
    assert!(words.to_lowercase().contains("cashback"), "{words}");
    for name in ["visa", "mastercard", "amex", "stripe", "marqeta"] {
        assert!(!words.to_lowercase().contains(name), "{words}");
    }
    assert!(!words.bytes().any(|c| c.is_ascii_digit()), "{words}");
}

// ---------------------------------------------------------------------------------------------------------------
// The router's own pieces around these calls (`cards.router.ts`), which the suites above reach only in passing.

#[test]
fn another_persons_card_is_the_guards_403_on_every_secret_call_and_nothing_is_audited() {
    let Some(b) = bank(&TEST_SECRETS) else { return };
    let card = issue_card(&b, OTHER);
    for a in [
        reveal(&b, &card, &uuid(), None),
        pin_reveal(&b, &card, &uuid(), None),
        pin_set(&b, &card, &uuid(), PIN, None),
        provision(&b, &card, &uuid(), "apple", "n"),
        call(
            &b,
            "cards.walletTokens",
            &format!(r#"{{"cardId":"{card}"}}"#),
        ),
    ] {
        assert_eq!(a.trpc(), "FORBIDDEN", "{}", a.1.compact());
    }
    assert_eq!(
        b.db.count("SELECT count(*) FROM bank.card_secret_audits"),
        0
    );
}

#[test]
fn a_retried_pin_set_is_one_change_and_its_command_id_on_another_card_conflicts() {
    let Some(b) = bank(&TEST_SECRETS) else { return };
    let card = issue_card(&b, HOLDER);
    let second = issue_card(&b, HOLDER);
    let command = uuid();
    let set = |card: &str, pin: &str| {
        b.door
            .cards_deps(now(), |d| secrets::set_pin(d, card, HOLDER, &command, pin))
    };
    set(&card, "4321").unwrap();
    // The retry is not sent to the issuer again: the PIN it would have set is not the one held.
    set(&card, "9999").unwrap();
    assert_eq!(
        b.door.cards().issuer.reveal_pin(&card).unwrap().unwrap(),
        "4321"
    );
    assert_eq!(
        set(&second, "4321").unwrap_err(),
        svc_bank::partner::refuse(
            "bank.card_command_conflict",
            "This command id was already used for a different card change"
        )
    );
    assert_eq!(audit_kinds(&b), ["pin_set"]);
}
