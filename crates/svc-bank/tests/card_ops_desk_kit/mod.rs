//! What the `card_ops_desk_*_db` tests share: the door with slice `card-ops`' desk wired (the TEST card partner, the
//! TEST partner bank, the owner's dispute cap and a stand-in for the operator's approvals), callers at each scope, svc-ops'
//! signed REST call, and ONE seed helper per row kind a card move leaves.
//!
//! The card moves (`ops.cardAuthorize`, `ops.cardCapture`, a partner refund, the TEST partner card's hold instruction)
//! are the slice's other half, not ported yet. Until they are, a test that needs what they leave
//! writes it through exactly one of these helpers, so each can later be switched to the real move in one place:
//! - [`authorize`]: one `bank.card_authorizations` row (an approved one carries its hold reference, as `authorize`
//!   records it);
//! - [`settle`]: one settled `bank.card_settlements` row (a capture or the reversal of the rest);
//! - [`convert`]: one `bank.card_conversions` row (the partner's rate on a pay-from hold);
//! - [`refund`]: one settled `bank.card_partner_refunds` row;
//! - [`hold`]: one hold the TEST partner card took, captured, released and refunded, in its book (`CardHoldBook`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    dead_code,
    reason = "a test kit: a failure is the point, and not every file uses every helper"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use service_kit::approvals::{
    ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding, random_uuid,
};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::Amount;
use service_kit::money::parse_amount;
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::cards::core::{IssueAsk, issue};
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::reads::{CardHoldBook, Hold, TEST_CARD_HOLD_DAYS, hold_key};
use svc_bank::cards::terms::PartnerTerms;
use svc_bank::cards::{Deps, NoRankTier, Settings, Wiring as CardsWiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::Wiring as SpacesWiring;
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use crate::support::TestDb;

pub const SECRET: &str = "a-bank-card-ops-desk-edge-secret-long-ok";
pub const INTERNAL: &str = "a-bank-card-ops-desk-internal-secret-ok";
pub const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
pub const APPROVER: &str = "88888888-8888-4888-8888-888888888888";

pub fn uuid() -> String {
    random_uuid().unwrap()
}

pub fn at(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

/// The TEST partner card answering `terms` (`cardSim({ partner })`).
pub fn sim(terms: PartnerTerms) -> Issuer {
    Issuer::sim(terms)
}

/// svc-ledger's posting freeze, open.
struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

/// The operator's second person (`founderApprovals()`): an approval is bound to one action and one set of fields, and
/// is consumed once.
#[derive(Clone, Default)]
pub struct Desk(Arc<Mutex<DeskState>>);

#[derive(Default)]
pub struct DeskState {
    issued: BTreeMap<String, (String, String)>,
    used: BTreeSet<String>,
    consumed: usize,
}

impl Desk {
    /// The approval's ids, as the console sends them with the change.
    pub fn issue(&self, action: &str, fields: &[(&str, &str)]) -> Vec<(&'static str, Json)> {
        let id = uuid();
        let fields: Vec<(String, String)> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        self.0.lock().unwrap().issued.insert(
            id.clone(),
            (action.to_owned(), payload_hash(action, &fields)),
        );
        vec![
            ("approvalId", Json::str(id)),
            ("operationId", Json::str(uuid())),
        ]
    }

    pub fn consumed(&self) -> usize {
        self.0.lock().unwrap().consumed
    }
}

impl Approvals for Desk {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        _principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let mut st = self.0.lock().unwrap();
        let refused =
            || ConsumeError::Refused("approval does not match this card and status".to_owned());
        let (action, hash) = st
            .issued
            .get(input.approval_id)
            .cloned()
            .ok_or_else(refused)?;
        if hash != input.payload_hash
            || input.target_id != action
            || st.used.contains(input.approval_id)
        {
            return Err(refused());
        }
        st.used.insert(input.approval_id.to_owned());
        st.consumed += 1;
        Ok((
            Consumed {
                action_type: action.clone(),
                target_service: "svc-bank".to_owned(),
                target_id: action,
                status: "CONSUMED".to_owned(),
                requester_id: OPERATOR.to_owned(),
                approver_id: Some(APPROVER.to_owned()),
                approver_is_founder: Some(true),
                requester_is_founder: Some(true),
            },
            Facts {
                kind: None,
                expires_at: Instant(door::system_now().0 + 60_000).iso(),
            },
        ))
    }
}

/// What a test's door is built with.
pub struct Setup {
    pub issuer: Issuer,
    /// The TEST partner bank on the stack (its switches, and so the TEST partner card's holds).
    pub test_partner: bool,
    /// `BANK_CARD_DISPUTE_CAP_JSON`.
    pub cap: Option<Vec<(String, String)>>,
    pub desk: Desk,
    pub now: fn() -> Instant,
}

impl Default for Setup {
    fn default() -> Setup {
        Setup {
            issuer: sim(PartnerTerms::nothing_reported()),
            test_partner: false,
            cap: Some(vec![("USDT".to_owned(), "100".to_owned())]),
            desk: Desk::default(),
            now: door::system_now,
        }
    }
}

pub struct Bank {
    pub door: BankDoor,
    pub db: TestDb,
    pub desk: Desk,
}

/// A door over `db` built from `s`.
pub fn door_on(db: &TestDb, s: Setup) -> (BankDoor, Desk) {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.approvals = Box::new(s.desk.clone());
    let door = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: s.now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: s.test_partner.then(|| TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring::none())
    .with_transfers(transfers)
    .with_cards(CardsWiring {
        issuer: s.issuer,
        rank: Box::new(NoRankTier),
        holds: Mutex::default(),
        settings: Settings {
            dispute_cap: s.cap,
            ..Settings::default()
        },
    });
    (door, s.desk)
}

/// A migrated database of its own and a door on it; `None` without `TEST_DATABASE_URL`.
pub fn bank_with(s: Setup) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let (door, desk) = door_on(&db, s);
    Some(Bank { door, db, desk })
}

pub fn bank() -> Option<Bank> {
    bank_with(Setup::default())
}

impl Bank {
    /// Another door on the same database (another cap, another issuer), sharing the desk.
    pub fn rewired(&self, mut s: Setup) -> BankDoor {
        s.desk = self.desk.clone();
        door_on(&self.db, s).0
    }

    pub fn deps<T>(&self, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        self.door.cards_deps(self.door.now(), f)
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }

    /// `bank.cards.issue`: an active virtual card on `asset`, settling in `settlement` (its own asset when `None`).
    pub fn card(&self, user: &str, asset: &str, settlement: Option<&str>, per: &str) -> String {
        let id = uuid();
        self.deps(|d| {
            issue(
                d,
                &IssueAsk {
                    card_id: id.clone(),
                    user_id: user.to_owned(),
                    asset_id: asset.to_owned(),
                    settlement_asset_id: settlement.map(str::to_owned),
                    per_authorization_limit: parse_amount(per).unwrap(),
                    ..IssueAsk::default()
                },
            )
        })
        .unwrap();
        id
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Callers.

/// A signed-in person holding `scopes`, with a second factor, in DE.
pub fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("99999999-9999-4999-8999-999999999999")),
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
pub struct Answer(pub u16, pub Json);

impl Answer {
    pub fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    /// The refusal's own code (`cause.code`), tRPC's code where there is none, or `ok`.
    pub fn code(&self) -> String {
        let data = self.1.get("error").and_then(|e| e.get("data"));
        match (
            self.0,
            data.and_then(|d| d.get("cause"))
                .and_then(|c| c.get("code")),
            data.and_then(|d| d.get("code")),
        ) {
            (200, _, _) => "ok".to_owned(),
            (_, Some(Json::String(c)), _) | (_, None, Some(Json::String(c))) => c.clone(),
            (status, _, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
    /// tRPC's own code (`FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`, ...).
    pub fn trpc(&self) -> String {
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
    pub fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

/// One tRPC call through the door, as `user` holding `scopes`.
pub fn call_on(door: &BankDoor, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    let input = input.compact();
    let mut headers = person(user, scopes);
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(&input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-card-ops-desk-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

pub fn call(b: &Bank, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    call_on(&b.door, user, scopes, path, input)
}

/// A REST request to the door: `(status, body)`. `service` signs it; `peer` is the TCP peer.
pub fn rest(
    door: &BankDoor,
    method: &str,
    path: &str,
    body: Option<&Json>,
    service: Option<&str>,
    peer: &str,
) -> (u16, Json) {
    let body = body.map(Json::compact).unwrap_or_default();
    let mut headers: Vec<(String, String)> = Vec::new();
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    if let Some(s) = service {
        headers.extend(s2s::legacy_headers(s, INTERNAL, &body, system_seconds()).unwrap());
    }
    let res = door.handle_from(
        &Request {
            method,
            url: path,
            headers: &headers,
            body: &body,
        },
        "req-card-ops-desk-rest",
        peer,
    );
    (
        res.status,
        json::parse(&res.body).unwrap_or_else(|_| Json::str(res.body.clone())),
    )
}

pub fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

/// A field as text: a string's own value, `null` for null or absent, else its JSON.
pub fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

pub fn arr(j: &Json, key: &str) -> Vec<Json> {
    match j.get(key) {
        Some(Json::Array(v)) => v.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

pub fn code_of<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        other => panic!("expected a bank refusal: {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The rows a card move leaves: one helper per row kind.

/// One authorisation as `ops.cardAuthorize` leaves it.
pub struct Auth<'a> {
    pub card: &'a str,
    pub reference: &'a str,
    /// In the asset held (the card's own, or the pay-from asset the partner held).
    pub amount: &'a str,
    pub decision: &'a str,
    pub decline: Option<&'a str>,
    /// `ledger` or `partner`.
    pub book: &'a str,
    pub status: &'a str,
    pub merchant_category: Option<&'a str>,
    pub order: Option<&'a [&'a str]>,
    pub decided_at: Option<&'a str>,
}

impl Default for Auth<'_> {
    fn default() -> Self {
        Auth {
            card: "",
            reference: "",
            amount: "1",
            decision: "approved",
            decline: None,
            book: "ledger",
            status: "pending",
            merchant_category: None,
            order: None,
            decided_at: None,
        }
    }
}

/// SEED (row kind: authorisation): one `bank.card_authorizations` row, its id. An approved one on the ledger carries
/// its hold transaction; on the partner, its hold reference and mode (`authorize`'s record).
pub fn authorize(db: &TestDb, a: &Auth<'_>) -> String {
    let id = uuid();
    let approved = a.decision == "approved";
    let partner = a.book == "partner";
    let hold_ref = (partner && approved).then(|| format!("TEST-card-partner:{}", hold_key(&id)));
    let mode = (partner && approved).then_some("partner_holds");
    let ledger_tx = (!partner && approved).then(|| format!("TEST-hold-{id}"));
    let order: Option<Vec<String>> = a.order.map(|o| o.iter().map(|s| (*s).to_owned()).collect());
    db.client()
        .execute(
            "INSERT INTO bank.card_authorizations (id, card_id, authorization_ref, amount, decision, decline_code, status, \
               hold_ledger_tx_id, money_book, partner_hold_ref, partner_mode, merchant_category, pay_from_order, decided_at, \
               channel) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::numeric, $5::text::bank.card_decision, $6, \
               $7::text::bank.loan_event_status, $8, $9, $10, $11, $12, $13, COALESCE($14::text::timestamptz, now()), 'online')",
            &[
                &id,
                &a.card,
                &a.reference,
                &a.amount,
                &a.decision,
                &a.decline,
                &a.status,
                &ledger_tx,
                &a.book,
                &hold_ref,
                &mode,
                &a.merchant_category,
                &order,
                &a.decided_at,
            ],
        )
        .unwrap();
    id
}

/// SEED (row kind: settlement): one settled `bank.card_settlements` row, `capture` or `reversal`, on `book`; a capture
/// on the ledger book also marks the authorisation settled, as `capture` does.
pub fn settle(
    db: &TestDb,
    authorization: &str,
    sequence: i32,
    kind: &str,
    amount: &str,
    book: &str,
) {
    let mut c = db.client();
    let (ledger_tx, partner_ref) = if book == "partner" {
        (None, Some(format!("TEST-{kind}-{authorization}")))
    } else {
        (Some(format!("TEST-{kind}-{authorization}")), None)
    };
    c.execute(
        "INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount, status, ledger_tx_id, money_book, \
           partner_ref, settled_at) \
         VALUES ($1::text::uuid, $2, $3::text::bank.card_settlement_kind, $4::text::numeric, 'settled', $5, $6, $7, now())",
        &[&authorization, &sequence, &kind, &amount, &ledger_tx, &book, &partner_ref],
    )
    .unwrap();
    if kind == "capture" {
        c.execute(
            "UPDATE bank.card_authorizations SET status = 'settled', settled_at = now() WHERE id = $1::text::uuid",
            &[&authorization],
        )
        .unwrap();
    }
}

/// SEED (row kind: conversion): the authorisation's frozen rate, as `authorize` records it.
#[allow(
    clippy::too_many_arguments,
    reason = "one argument per column of the row"
)]
pub fn convert(
    db: &TestDb,
    authorization: &str,
    settlement: (&str, &str),
    funding: (&str, &str),
    rate: &str,
    quality: &str,
    as_of: &str,
) {
    db.client()
        .execute(
            "INSERT INTO bank.card_conversions (authorization_id, settlement_asset_id, settlement_amount, funding_asset_id, \
               funding_amount, rate, rate_quality, rate_as_of) \
             VALUES ($1::text::uuid, $2, $3::text::numeric, $4, $5::text::numeric, $6::text::numeric, $7, $8::text::timestamptz)",
            &[&authorization, &settlement.0, &settlement.1, &funding.0, &funding.1, &rate, &quality, &as_of],
        )
        .unwrap();
}

/// SEED (row kind: partner refund): the partner's refund of part of a capture, settled.
pub fn refund(db: &TestDb, authorization: &str, amount: &str) {
    db.client()
        .execute(
            "INSERT INTO bank.card_partner_refunds (authorization_id, amount, status, partner_ref, settled_at) \
             VALUES ($1::text::uuid, $2::text::numeric, 'settled', $3, now())",
            &[&authorization, &amount, &format!("TEST-refund-{authorization}")],
        )
        .unwrap();
}

/// What the TEST partner card did with one hold: taken, then captured, released and refunded.
pub struct HoldMove<'a> {
    pub authorization: &'a str,
    pub user: &'a str,
    pub asset: &'a str,
    pub amount: &'a str,
    pub captured: &'a str,
    pub released: &'a str,
    pub refunded: &'a str,
}

/// SEED (row kind: the partner card's hold): one hold in the TEST partner card's book, as its hold, capture, release
/// and refund instructions leave it.
pub fn hold(book: &Mutex<CardHoldBook>, terms: &PartnerTerms, h: &HoldMove<'_>, now: Instant) {
    let amount = parse_amount(h.amount).unwrap();
    let captured = parse_amount(h.captured).unwrap();
    let released = parse_amount(h.released).unwrap();
    let refunded = parse_amount(h.refunded).unwrap();
    let key = hold_key(h.authorization);
    let mut b = book.lock().unwrap();
    let open = amount - captured - released;
    let bk = b.book_of(terms, h.user, h.asset).unwrap();
    bk.available = bk.available - amount + released + refunded;
    bk.held += open;
    if open > Amount::ZERO {
        bk.open.insert(key.clone());
    }
    b.holds.insert(
        key.clone(),
        Hold {
            partner_ref: format!("TEST-card-partner:{key}"),
            user_id: h.user.to_owned(),
            asset_id: h.asset.to_owned(),
            mode: "partner_holds".to_owned(),
            amount,
            expires_at: Instant(now.0 + TEST_CARD_HOLD_DAYS * 86_400_000),
            conversion: None,
            captured,
            released,
            refunded,
            expired: false,
            drawn: false,
        },
    );
}
