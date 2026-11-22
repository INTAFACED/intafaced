//! Slice `cards`' core doors (programme, list, issue, status, limits, channels, controls, replace) against the Rust door
//! on a real Postgres. Ports the checks of `cards/cards.test.ts`, `cards/cards-procedures.test.ts`,
//! `cards/cards-auth-product.test.ts`, `cards/card-sim-not-issuer.money.test.ts`, `cards/card-simulated-true.test.ts`
//! and the cards doors of `step-up/step-up-money-out.test.ts` that fall on this slice's own calls, each test named after
//! the TypeScript test's words. Every call enters through the door, as the TypeScript's enter through the router.
//!
//! The halves that authorise a purchase (`ops.cardAuthorize`) are slice `card-ops`'s and stay there. Identity is a
//! faithful stand-in for its same-person consume (CAS once; user, session, hash and expiry). Without
//! `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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
use std::sync::{Arc, Mutex};

use service_kit::approvals::{ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::terms::PartnerTerms;
use svc_bank::cards::{NoRankTier, Settings as CardSettings, Wiring as CardsWiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Settings as TransfersSettings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-cards-core-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-cards-core-db-internal-secret-long-enough";
const HOLDER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "33333333-3333-4333-8333-333333333333";
const SID: &str = "99999999-9999-4999-8999-999999999999";
const ADDRESS: &str = r#"{"name":"Ada Lovelace","line1":"1 Analytical Engine","city":"London","postalCode":"SW1A 1AA","country":"GB"}"#;

// ---------------------------------------------------------------------------------------------------------------
// Identity's same-person consume

struct Approval {
    user_id: String,
    action_type: String,
    hash: String,
    expires_at: i64,
    consumed: bool,
}

#[derive(Clone, Default)]
struct FakeIdentity(Arc<Mutex<BTreeMap<String, Approval>>>);

impl FakeIdentity {
    fn approve(&self, action: &str, fields: &[(&str, &str)]) -> String {
        let fields: Vec<(String, String)> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let mut rows = self.0.lock().unwrap();
        let id = format!("approval-{}", rows.len() + 1);
        rows.insert(
            id.clone(),
            Approval {
                user_id: HOLDER.to_owned(),
                action_type: action.to_owned(),
                hash: payload_hash(action, &fields),
                expires_at: door::system_now().0 + 300_000,
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
        let mut rows = self.0.lock().unwrap();
        let Some(row) = rows.get_mut(input.approval_id) else {
            return refused("not_found");
        };
        if door::system_now().0 >= row.expires_at {
            return refused("expired");
        }
        if input.target_id != row.action_type {
            return refused("target_mismatch");
        }
        if row.hash != input.payload_hash {
            return refused("payload_mismatch");
        }
        let p = principal.expect("a same-person consume binds the person");
        if row.user_id != p.user_id || p.session_id != SID {
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
                requester_id: row.user_id.clone(),
                approver_id: Some(row.user_id.clone()),
                approver_is_founder: None,
                requester_is_founder: None,
            },
            Facts {
                kind: Some("same_person".to_owned()),
                expires_at: Instant(row.expires_at).iso(),
            },
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door and its calls

/// How one test's door is wired: the issuer, the module switch and the step-up mode.
struct Setup {
    issuer: Issuer,
    enabled: bool,
    step_up: Option<FakeIdentity>,
}

fn sim() -> Setup {
    Setup {
        issuer: Issuer::sim(PartnerTerms::nothing_reported()),
        enabled: true,
        step_up: None,
    }
}

fn bank(db: &TestDb, s: Setup) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    if let Some(identity) = s.step_up {
        transfers.approvals = Box::new(identity);
        transfers.settings = TransfersSettings {
            step_up_required: true,
            ..TransfersSettings::default()
        };
    }
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_transfers(transfers)
    .with_cards(CardsWiring {
        issuer: s.issuer,
        rank: Box::new(NoRankTier),
        settings: CardSettings {
            module_enabled: s.enabled,
            ..CardSettings::default()
        },
    })
}

fn person(user: &str) -> Vec<(String, String)> {
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

/// One answer: the status, and the data or the error.
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
    /// The refusal's own code (`cause.code`), or `ok`.
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
    /// tRPC's code (`FORBIDDEN`, `BAD_REQUEST`, ...).
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
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

fn call(b: &BankDoor, user: &str, path: &str, input: &str) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let mut headers = person(user);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            if input.is_empty() {
                format!("/trpc/{path}")
            } else {
                format!("/trpc/{path}?input={}", encode(input))
            },
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = b.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-cards-core-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn refused(a: &Answer, code: &str, trpc: &str) {
    assert_eq!(
        (a.code(), a.trpc()),
        (code.to_owned(), trpc.to_owned()),
        "{}",
        a.1.compact()
    );
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(a) => a.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

/// `user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit })`.
fn issue(b: &BankDoor, user: &str, card_id: &str, per: &str) -> Answer {
    call(
        b,
        user,
        "cards.issue",
        &format!(r#"{{"cardId":"{card_id}","assetId":"USDT","perAuthorizationLimit":"{per}"}}"#),
    )
}

fn set_status(b: &BankDoor, card_id: &str, status: &str, extra: &str) -> Answer {
    call(
        b,
        HOLDER,
        "cards.setStatus",
        &format!(r#"{{"cardId":"{card_id}","status":"{status}"{extra}}}"#),
    )
}

fn list(b: &BankDoor, user: &str) -> Vec<Json> {
    arr(&call(b, user, "cards.list", r#"{"limit":10}"#).ok())
}

// ---------------------------------------------------------------------------------------------------------------
// Issue

#[test]
fn issues_a_card_that_says_it_is_simulated_and_no_card_number_exists_anywhere() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card = issue(&b, HOLDER, &uuid(), "100").ok();
    assert_eq!(card.get("simulated"), Some(&Json::Bool(true)));
    assert_eq!(text(&card, "issuer"), "card-sim");
    let tail = text(&card, "panTail");
    assert!(
        tail.len() == 4 && tail.bytes().all(|c| c.is_ascii_digit()),
        "{tail}"
    );
    let names: Vec<String> = db
        .client()
        .query(
            "SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'bank' AND table_name = 'cards'",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(!names.iter().any(|n| n == "pan" || n == "card_number"));
    assert!(
        !names.iter().any(|n| {
            let n = n.to_lowercase();
            n.contains("balance") || n.contains("spendable") || n.contains("available")
        }),
        "{names:?}"
    );
}

#[test]
fn is_idempotent_on_the_card_id_a_retried_issue_is_one_card_not_two_on_one_balance() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    let first = issue(&b, HOLDER, &card_id, "500").ok();
    let second = issue(&b, HOLDER, &card_id, "500").ok();
    assert_eq!(text(&second, "id"), text(&first, "id"));
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM bank.cards WHERE user_id = '{HOLDER}'"
        )),
        1
    );
}

#[test]
fn composition_root_with_no_cards_option_still_has_no_programme_and_refuses_to_issue_writing_nothing()
 {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        Setup {
            issuer: Issuer::None,
            ..sim()
        },
    );
    assert_eq!(
        call(&b, HOLDER, "cards.programme", "").ok().compact(),
        r#"{"id":"none","simulated":true,"displayName":"No card programme"}"#
    );
    refused(
        &issue(&b, HOLDER, &uuid(), "100"),
        "bank.no_card_issuer",
        "PRECONDITION_FAILED",
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.cards"), 0);
}

#[test]
fn card_sim_under_live_posture_stays_simulated_not_a_bin_and_named_refuses_issue_zero_card_rows() {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        Setup {
            issuer: Issuer::for_setting("card-sim", true, PartnerTerms::nothing_reported()),
            ..sim()
        },
    );
    assert_eq!(
        call(&b, HOLDER, "cards.programme", "").ok().compact(),
        r#"{"id":"card-sim","simulated":true,"displayName":"Simulated card (no card programme)"}"#
    );
    let issued = issue(&b, HOLDER, &uuid(), "100");
    assert_eq!(issued.0, 412);
    refused(&issued, "bank.card_sim_not_live", "PRECONDITION_FAILED");
    assert_eq!(db.count("SELECT count(*) FROM bank.cards"), 0);

    // CARD_ISSUER=none under live posture still refuses as no issuer.
    let none = bank(
        &db,
        Setup {
            issuer: Issuer::for_setting("none", true, PartnerTerms::nothing_reported()),
            ..sim()
        },
    );
    refused(
        &issue(&none, HOLDER, &uuid(), "100"),
        "bank.no_card_issuer",
        "PRECONDITION_FAILED",
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.cards"), 0);
}

#[test]
fn module_kill_refuses_issue_through_the_router() {
    let Some(db) = db() else { return };
    let b = bank(
        &db,
        Setup {
            enabled: false,
            ..sim()
        },
    );
    refused(
        &issue(&b, HOLDER, &uuid(), "100"),
        "bank.cards_disabled",
        "SERVICE_UNAVAILABLE",
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.cards"), 0);
}

#[test]
fn issues_a_simulated_physical_card_only_with_a_delivery_address() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let physical = |card_id: &str, address: &str| {
        call(
            &b,
            HOLDER,
            "cards.issue",
            &format!(
                r#"{{"cardId":"{card_id}","assetId":"USDT","perAuthorizationLimit":"25","cardType":"physical"{address}}}"#
            ),
        )
    };
    let missing = physical(&uuid(), "");
    assert!(
        missing
            .message()
            .contains("bank.card_shipping_address_required")
            || missing.code() == "bank.card_shipping_address_required",
        "{}",
        missing.1.compact()
    );
    let card_id = uuid();
    let with_address = format!(r#","shippingAddress":{ADDRESS}"#);
    let issued = physical(&card_id, &with_address).ok();
    assert_eq!(text(&issued, "cardType"), "physical");
    assert_eq!(issued.get("simulated"), Some(&Json::Bool(true)));
    assert_eq!(text(&issued, "issuer"), "card-sim");
    assert_eq!(
        issued.get("shippingAddress").unwrap().compact(),
        r#"{"name":"Ada Lovelace","line1":"1 Analytical Engine","line2":null,"city":"London","region":null,"postalCode":"SW1A 1AA","country":"GB"}"#
    );
    assert_eq!(text(&physical(&card_id, &with_address).ok(), "id"), card_id);
    refused(
        &issue(&b, HOLDER, &card_id, "25"),
        "bank.card_issue_conflict",
        "CONFLICT",
    );
}

#[test]
fn a_card_row_stays_simulated_simulated_false_is_refused_on_insert_and_update() {
    let Some(db) = db() else { return };
    let mut c = db.client();
    let insert = |c: &mut postgres::Client, simulated: Option<bool>| {
        let id = uuid();
        let sql = match simulated {
            Some(_) => {
                "INSERT INTO bank.cards (id, user_id, asset_id, issuer, simulated, issuer_ref, pan_tail, per_authorization_limit, settlement_asset_id) \
                        VALUES ($1::text::uuid, $2, 'USDT', 'card-sim', $3, $1, '4242', 10, 'USDT') RETURNING simulated"
            }
            None => {
                "INSERT INTO bank.cards (id, user_id, asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit, settlement_asset_id) \
                     VALUES ($1::text::uuid, $2, 'USDT', 'card-sim', $1, '4242', 10, 'USDT') RETURNING simulated"
            }
        };
        let r = match simulated {
            Some(s) => c.query(sql, &[&id, &HOLDER, &s]),
            None => c.query(sql, &[&id, &HOLDER]),
        };
        (id, r.map(|rows| rows[0].get::<_, bool>(0)))
    };
    let (omitted, stored) = insert(&mut c, None);
    assert!(stored.unwrap());
    assert!(insert(&mut c, Some(true)).1.unwrap());
    let err = insert(&mut c, Some(false)).1.unwrap_err();
    assert_eq!(
        err.as_db_error().map(|e| (
            e.code().code().to_owned(),
            e.constraint().map(str::to_owned)
        )),
        Some(("23514".to_owned(), Some("cards_simulated_true".to_owned())))
    );
    let err = c
        .execute(
            "UPDATE bank.cards SET simulated = false WHERE id = $1::text::uuid",
            &[&omitted],
        )
        .unwrap_err();
    assert_eq!(
        err.as_db_error().map(|e| e.constraint().map(str::to_owned)),
        Some(Some("cards_simulated_true".to_owned()))
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Status, limits and channels

#[test]
fn refuses_to_reopen_a_closed_card() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    issue(&b, HOLDER, &card_id, "100").ok();
    set_status(&b, &card_id, "closed", "").ok();
    refused(
        &set_status(&b, &card_id, "active", ""),
        "bank.card_not_active",
        "BAD_REQUEST",
    );
}

#[test]
fn stores_exact_ceilings_tightens_without_step_up_and_loosens_only_with_step_up() {
    let Some(db) = db() else { return };
    let identity = FakeIdentity::default();
    let user = bank(&db, sim());
    let card_id = uuid();
    let issued = issue(&user, HOLDER, &card_id, "100.50").ok();
    assert_eq!(text(&issued, "perAuthorizationLimit"), "100.5");
    assert_eq!(text(&issued, "dailyLimit"), "null");
    assert_eq!(issued.get("simulated"), Some(&Json::Bool(true)));

    let limits = |b: &BankDoor, body: &str| call(b, HOLDER, "cards.setLimits", body);
    let tightened = limits(
        &user,
        &format!(
            r#"{{"cardId":"{card_id}","commandId":"{}","perAuthorizationLimit":"40","dailyLimit":"80","monthlyLimit":"200","cashLimit":"30"}}"#,
            uuid()
        ),
    )
    .ok();
    for (k, v) in [
        ("perAuthorizationLimit", "40"),
        ("dailyLimit", "80"),
        ("monthlyLimit", "200"),
        ("cashLimit", "30"),
    ] {
        assert_eq!(text(&tightened, k), v, "{k}");
    }

    let gated = bank(
        &db,
        Setup {
            step_up: Some(identity.clone()),
            ..sim()
        },
    );
    let again = limits(
        &gated,
        &format!(
            r#"{{"cardId":"{card_id}","commandId":"{}","perAuthorizationLimit":"40","dailyLimit":"50"}}"#,
            uuid()
        ),
    )
    .ok();
    assert_eq!(
        (
            text(&again, "dailyLimit"),
            text(&again, "perAuthorizationLimit")
        ),
        ("50".to_owned(), "40".to_owned())
    );
    let loosen = uuid();
    let asked =
        format!(r#"{{"cardId":"{card_id}","commandId":"{loosen}","perAuthorizationLimit":"90""#);
    let refusal = limits(&gated, &format!("{asked}}}"));
    assert!(
        refusal.message().contains("bank.step_up_required"),
        "{}",
        refusal.1.compact()
    );
    let approval = identity.approve(
        "bank.step_up.cards.setLimits",
        &[
            ("actor", HOLDER),
            ("cardId", &card_id),
            ("commandId", &loosen),
            ("perAuthorizationLimit", "90"),
            ("dailyLimit", ""),
            ("monthlyLimit", ""),
            ("cashLimit", ""),
        ],
    );
    let raised = limits(
        &gated,
        &format!(r#"{asked},"stepUpApprovalId":"{approval}"}}"#),
    )
    .ok();
    assert_eq!(text(&raised, "perAuthorizationLimit"), "90");
    assert_eq!(text(&raised, "dailyLimit"), "50");
    let listed = &list(&user, HOLDER)[0];
    for (k, v) in [
        ("id", card_id.as_str()),
        ("perAuthorizationLimit", "90"),
        ("dailyLimit", "50"),
        ("monthlyLimit", "200"),
        ("cashLimit", "30"),
    ] {
        assert_eq!(text(listed, k), v, "{k}");
    }
}

#[test]
fn replays_a_limits_command_and_refuses_the_same_id_with_different_ceilings() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    let command = uuid();
    issue(&b, HOLDER, &card_id, "100").ok();
    let body = format!(
        r#"{{"cardId":"{card_id}","commandId":"{command}","perAuthorizationLimit":"70","dailyLimit":"70"}}"#
    );
    call(&b, HOLDER, "cards.setLimits", &body).ok();
    let replay = call(&b, HOLDER, "cards.setLimits", &body).ok();
    assert_eq!(text(&replay, "perAuthorizationLimit"), "70");
    let conflict = call(
        &b,
        HOLDER,
        "cards.setLimits",
        &format!(
            r#"{{"cardId":"{card_id}","commandId":"{command}","perAuthorizationLimit":"10"}}"#
        ),
    );
    assert!(
        conflict.message().contains("bank.card_command_conflict"),
        "{}",
        conflict.1.compact()
    );
    assert_eq!(text(&list(&b, HOLDER)[0], "perAuthorizationLimit"), "70");
}

#[test]
fn returns_channel_flags_on_the_card_and_in_the_list() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    issue(&b, HOLDER, &card_id, "400").ok();
    let switched = call(
        &b,
        HOLDER,
        "cards.setChannels",
        &format!(
            r#"{{"cardId":"{card_id}","commandId":"{}","online":false,"contactless":true,"atm":false,"abroad":true}}"#,
            uuid()
        ),
    )
    .ok();
    for (k, v) in [
        ("online", false),
        ("contactless", true),
        ("atm", false),
        ("abroad", true),
        ("simulated", true),
    ] {
        assert_eq!(switched.get(k), Some(&Json::Bool(v)), "{k}");
    }
    let listed = &list(&b, HOLDER)[0];
    assert_eq!(listed.get("online"), Some(&Json::Bool(false)));
    assert_eq!(listed.get("atm"), Some(&Json::Bool(false)));
}

#[test]
fn unfreeze_and_issue_need_one_freeze_and_close_never_do_unfreezing_twice_with_one_approval_is_refused()
 {
    let Some(db) = db() else { return };
    let identity = FakeIdentity::default();
    let open = bank(&db, sim());
    let card_id = uuid();
    issue(&open, HOLDER, &card_id, "10").ok();
    set_status(&open, &card_id, "frozen", "").ok();
    let b = bank(
        &db,
        Setup {
            step_up: Some(identity.clone()),
            ..sim()
        },
    );
    let needs = set_status(&b, &card_id, "active", "");
    assert!(
        needs.message().contains("bank.step_up_required"),
        "{}",
        needs.1.compact()
    );
    assert_eq!(
        text(&set_status(&b, &card_id, "frozen", "").ok(), "id"),
        card_id
    );
    let id = identity.approve(
        "bank.step_up.cards.unfreeze",
        &[
            ("actor", HOLDER),
            ("cardId", &card_id),
            ("fromStatus", "frozen"),
            ("status", "active"),
        ],
    );
    let with = format!(r#","stepUpApprovalId":"{id}""#);
    assert_eq!(
        text(&set_status(&b, &card_id, "active", &with).ok(), "id"),
        card_id
    );
    set_status(&b, &card_id, "frozen", "").ok();
    let used = set_status(&b, &card_id, "active", &with);
    assert!(
        used.message().contains("bank.step_up_used"),
        "{}",
        used.1.compact()
    );
    assert_eq!(
        text(&set_status(&b, &card_id, "closed", "").ok(), "id"),
        card_id
    );

    let fresh = uuid();
    let ask = format!(r#"{{"cardId":"{fresh}","assetId":"USDT","perAuthorizationLimit":"10""#);
    let needs = call(&b, HOLDER, "cards.issue", &format!("{ask}}}"));
    assert!(
        needs.message().contains("bank.step_up_required"),
        "{}",
        needs.1.compact()
    );
    let issue_fields = |per: &'static str| {
        vec![
            ("actor", HOLDER),
            ("cardId", fresh.as_str()),
            ("assetId", "USDT"),
            ("settlementAssetId", ""),
            ("cashbackBps", ""),
            ("perAuthorizationLimit", per),
            ("cardType", "virtual"),
            ("shippingAddress", ""),
        ]
    };
    let bigger = identity.approve("bank.step_up.cards.issue", &issue_fields("1000"));
    let mismatch = call(
        &b,
        HOLDER,
        "cards.issue",
        &format!(r#"{ask},"stepUpApprovalId":"{bigger}"}}"#),
    );
    assert!(
        mismatch.message().contains("bank.step_up_mismatch"),
        "{}",
        mismatch.1.compact()
    );
    let ok = identity.approve("bank.step_up.cards.issue", &issue_fields("10"));
    let issued = call(
        &b,
        HOLDER,
        "cards.issue",
        &format!(r#"{ask},"stepUpApprovalId":"{ok}"}}"#),
    )
    .ok();
    assert_eq!(text(&issued, "id"), fresh);
}

// ---------------------------------------------------------------------------------------------------------------
// Controls

#[test]
fn blocks_a_category_a_merchant_and_a_country_once_each_and_a_lifted_block_is_gone() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    issue(&b, HOLDER, &card_id, "400").ok();
    let get = || {
        call(
            &b,
            HOLDER,
            "cards.controls.get",
            &format!(r#"{{"cardId":"{card_id}"}}"#),
        )
    };
    assert_eq!(
        get().ok().compact(),
        r#"{"categories":["gambling","cash_like","adult","travel","entertainment","online_shopping","groceries","fuel"],"controls":[],"history":[]}"#
    );
    let block = |kind: &str, value: &str| {
        call(
            &b,
            HOLDER,
            "cards.controls.block",
            &format!(r#"{{"cardId":"{card_id}","kind":"{kind}","value":"{value}"}}"#),
        )
    };
    block("category", "gambling").ok();
    // Blocking again is the same control, never a second row.
    block("category", "gambling").ok();
    block("merchant", "  TEST Casino Shop ").ok();
    let blocked = block("country", "us").ok();
    let pairs = |j: &Json| -> Vec<(String, String)> {
        arr(j.get("controls").unwrap())
            .iter()
            .map(|c| (text(c, "kind"), text(c, "value")))
            .collect()
    };
    assert_eq!(
        pairs(&blocked),
        [
            ("category".to_owned(), "gambling".to_owned()),
            ("merchant".to_owned(), "test casino shop".to_owned()),
            ("country".to_owned(), "US".to_owned()),
        ]
    );
    let gambling = text(&arr(blocked.get("controls").unwrap())[0], "id");
    let lifted = call(
        &b,
        HOLDER,
        "cards.controls.lift",
        &format!(r#"{{"cardId":"{card_id}","controlId":"{gambling}"}}"#),
    )
    .ok();
    let kinds: Vec<_> = pairs(&lifted).into_iter().map(|p| p.0).collect();
    assert_eq!(kinds, ["merchant", "country"]);
    let unknown = call(
        &b,
        HOLDER,
        "cards.controls.lift",
        &format!(r#"{{"cardId":"{card_id}","controlId":"{}"}}"#, uuid()),
    );
    assert!(
        unknown.message().contains("bank.card_control_not_found"),
        "{}",
        unknown.1.compact()
    );
}

#[test]
fn refuses_a_control_it_cannot_keep_and_records_each_lock_and_unlock_in_the_card_history() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    issue(&b, HOLDER, &card_id, "50").ok();
    let block = |kind: &str, value: &str| {
        call(
            &b,
            HOLDER,
            "cards.controls.block",
            &format!(r#"{{"cardId":"{card_id}","kind":"{kind}","value":"{value}"}}"#),
        )
    };
    for (kind, value) in [
        ("category", "casinos".to_owned()),
        ("country", "USA".to_owned()),
        ("merchant", "a".repeat(65)),
    ] {
        assert_ne!(block(kind, &value).0, 200, "{kind} {value}");
    }
    let invalid = block("country", "U1");
    assert!(
        invalid.message().contains("bank.card_control_invalid"),
        "{}",
        invalid.1.compact()
    );
    let get = || {
        call(
            &b,
            HOLDER,
            "cards.controls.get",
            &format!(r#"{{"cardId":"{card_id}"}}"#),
        )
        .ok()
    };
    assert_eq!(get().get("controls").unwrap().compact(), "[]");

    set_status(&b, &card_id, "frozen", "").ok();
    // Freezing a frozen card changes nothing, so it adds no history.
    set_status(&b, &card_id, "frozen", "").ok();
    set_status(&b, &card_id, "active", "").ok();
    let history: Vec<_> = arr(get().get("history").unwrap())
        .iter()
        .map(|h| (text(h, "status"), text(h, "actor")))
        .collect();
    assert_eq!(
        history,
        [
            ("active".to_owned(), "owner".to_owned()),
            ("frozen".to_owned(), "owner".to_owned())
        ]
    );
}

#[test]
fn never_shows_or_changes_another_persons_card_controls() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    issue(&b, HOLDER, &card_id, "50").ok();
    assert_ne!(
        call(
            &b,
            OTHER,
            "cards.controls.get",
            &format!(r#"{{"cardId":"{card_id}"}}"#)
        )
        .0,
        200
    );
    assert_ne!(
        call(
            &b,
            OTHER,
            "cards.controls.block",
            &format!(r#"{{"cardId":"{card_id}","kind":"category","value":"gambling"}}"#)
        )
        .0,
        200
    );
    assert_eq!(
        call(
            &b,
            HOLDER,
            "cards.controls.get",
            &format!(r#"{{"cardId":"{card_id}"}}"#)
        )
        .ok()
        .get("controls")
        .unwrap()
        .compact(),
        "[]"
    );
    // Nor its status or ceilings.
    assert_eq!(
        call(
            &b,
            OTHER,
            "cards.setStatus",
            &format!(r#"{{"cardId":"{card_id}","status":"frozen"}}"#)
        )
        .trpc(),
        "FORBIDDEN"
    );
    assert!(list(&b, OTHER).is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// Replace

#[test]
fn replaces_a_card_and_keeps_the_asset_ceilings_and_channels() {
    let Some(db) = db() else { return };
    let b = bank(&db, sim());
    let card_id = uuid();
    let replacement = uuid();
    issue(&b, HOLDER, &card_id, "100").ok();
    call(
        &b,
        HOLDER,
        "cards.setLimits",
        &format!(
            r#"{{"cardId":"{card_id}","commandId":"{}","perAuthorizationLimit":"100","dailyLimit":"60","cashLimit":"20"}}"#,
            uuid()
        ),
    )
    .ok();
    call(
        &b,
        HOLDER,
        "cards.setChannels",
        &format!(
            r#"{{"cardId":"{card_id}","commandId":"{}","online":true,"contactless":false,"atm":true,"abroad":false}}"#,
            uuid()
        ),
    )
    .ok();
    let replace = |id: &str, reason: &str| {
        call(
            &b,
            HOLDER,
            "cards.replace",
            &format!(r#"{{"cardId":"{card_id}","replacementId":"{id}","reason":"{reason}"}}"#),
        )
    };
    let replaced = replace(&replacement, "stolen").ok();
    for (k, v) in [
        ("id", replacement.as_str()),
        ("assetId", "USDT"),
        ("perAuthorizationLimit", "100"),
        ("dailyLimit", "60"),
        ("cashLimit", "20"),
        ("status", "active"),
    ] {
        assert_eq!(text(&replaced, k), v, "{k}");
    }
    for (k, v) in [
        ("online", true),
        ("contactless", false),
        ("atm", true),
        ("abroad", false),
        ("simulated", true),
    ] {
        assert_eq!(replaced.get(k), Some(&Json::Bool(v)), "{k}");
    }
    let tail = text(&replaced, "panTail");
    assert!(
        tail.len() == 4 && tail.bytes().all(|c| c.is_ascii_digit()),
        "{tail}"
    );
    assert_eq!(
        text(&replace(&replacement, "stolen").ok(), "id"),
        replacement
    );
    let rows = list(&b, HOLDER);
    assert_eq!(rows.len(), 2);
    let old = rows.iter().find(|r| text(r, "id") == card_id).unwrap();
    assert_eq!(text(old, "status"), "closed");
    let conflict = replace(&uuid(), "lost");
    assert!(
        conflict.message().contains("bank.card_replace_conflict"),
        "{}",
        conflict.1.compact()
    );
}
