//! Slice `cards`' card room (J-bank-13: `cards.catalogue`, `acceptTerms`, `order`, `delivery`, `updateShipping`, the
//! stand-in printer's `/internal/jobs/card-sim/shipment` and a replacement's delivery) against the Rust door on a real
//! Postgres. Ports the checks of `cards/card-orders.money.test.ts` that fall on these calls, each test named after the
//! TypeScript test's words. A call on `CardOrderService` enters through the door that serves it (the router's call, or
//! the job door for `recordShipment`), as the journey does.
//!
//! Not ported, with the reason:
//! - "holds a single-use card's one use from approval, closes it after the capture, and declines what follows" and
//!   "frees a single-use card's use when its only hold is reversed whole": every check is `authorize`, `capture` or
//!   `reverse`, slice `card-ops`'. Only the order's half is held here (the card is issued with its one use).
//! - From "keeps a physical card inactive until it is activated": the two `authorize` checks (`card-ops`).
//! - From "on a lost report closes the card once, reverses its open hold once": the hold and its reversal (`card-ops`;
//!   a card with no open hold, as here, needs nothing from it) and the ledger's balance.
//! - "gives every same-id replace call at once the one replacement card": `cards.replace` is `core`'s, ported in
//!   `cards_core_db.rs`.
//!
//! The checks past the TypeScript's (the job door's signature, shape and programme; a delivery read by another person;
//! the router's own refusals) are named for what they hold. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
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

use service_kit::approvals::random_uuid;
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::orders::terms_text_hash;
use svc_bank::cards::terms::{PartnerTerms, parse_programme};
use svc_bank::cards::{Settings, Wiring as CardsWiring};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};

use support::TestDb;

const SECRET: &str = "a-bank-cards-orders-db-edge-secret-long-ok";
const INTERNAL: &str = "a-bank-cards-orders-db-internal-secret-ok";
const SHIPMENT: &str = "/internal/jobs/card-sim/shipment";
const TERMS: &str = r#"{"network":"TEST network","countries":["DE","FR"],"limits":{"virtual":2,"physical":1},"terms":{"version":"test-1","text":"TEST terms"},"designs":[{"id":"classic","name":"TEST Classic"}],"speeds":[{"speed":"standard","days":7}],"deliveryCountries":["DE"]}"#;
const ADDRESS: &str = r#"{"name":"Ada TEST","line1":"1 TEST Strasse","city":"Berlin","postalCode":"10115","country":"DE"}"#;

fn uuid() -> String {
    random_uuid().unwrap()
}

/// The door, with the card simulator and (unless `published` is false) the TEST programme above.
fn bank(db: &TestDb, issuer: Issuer, published: bool) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
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
    .with_cards(CardsWiring {
        issuer,
        rank: Box::new(svc_bank::cards::NoRankTier),
        holds: Default::default(),
        settings: Settings {
            programme: if published {
                Some(parse_programme(Some(TERMS)).unwrap())
            } else {
                None
            },
            ..Settings::default()
        },
    })
}

fn sim() -> Issuer {
    Issuer::sim(PartnerTerms::nothing_reported())
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

/// One answer: the status, and the body.
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
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

/// A call as the person.
fn call(b: &BankDoor, user: &str, path: &str, input: &str) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let mut headers = person(user);
    let (method, url, body) = match kind {
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
    let res = b.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-cards-orders-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// The stand-in printer's job door, signed as `service` (or unsigned): the status and the body.
fn printer(b: &BankDoor, service: Option<&str>, body: &str) -> (u16, Json) {
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(s) = service {
        headers.extend(s2s::legacy_headers(s, INTERNAL, body, system_seconds()).unwrap());
    }
    let res = b.handle(&Request {
        method: "POST",
        url: SHIPMENT,
        headers: &headers,
        body,
    });
    (res.status, json::parse(&res.body).unwrap())
}

/// `recordShipment`, through the job door as the stand-in printer.
fn ship(b: &BankDoor, card_id: &str, extra: &str) -> (u16, Json) {
    printer(
        b,
        Some("svc-bank"),
        &format!(r#"{{"cardId":"{card_id}",{extra}}}"#),
    )
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
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

/// One person, the room's door, and the database.
struct Room {
    _db: TestDb,
    b: BankDoor,
    user: String,
}

impl Room {
    fn new() -> Option<Room> {
        let db = TestDb::new()?;
        db.migrated();
        let b = bank(&db, sim(), true);
        Some(Room {
            _db: db,
            b,
            user: uuid(),
        })
    }

    fn call(&self, path: &str, input: &str) -> Answer {
        call(&self.b, &self.user, path, input)
    }

    fn accept(&self) -> Answer {
        self.call(
            "cards.acceptTerms",
            &format!(
                r#"{{"termsVersion":"test-1","textHash":"{}"}}"#,
                terms_text_hash("TEST terms")
            ),
        )
    }

    fn order(&self, fields: &str) -> Answer {
        self.call(
            "cards.order",
            &format!(
                r#"{{"cardId":"{}","country":"DE","termsVersion":"test-1","assetId":"USDT","perAuthorizationLimit":"50",{fields}}}"#,
                uuid()
            ),
        )
    }

    fn virtual_card(&self) -> Answer {
        self.order(r#""cardType":"virtual""#)
    }

    fn physical(&self) -> Answer {
        self.order(&format!(
            r#""cardType":"physical","designId":"classic","deliverySpeed":"standard","shippingAddress":{ADDRESS}"#
        ))
    }

    fn cards(&self) -> i64 {
        self._db.count(&format!(
            "SELECT count(*) FROM bank.cards WHERE user_id = '{}'",
            self.user
        ))
    }

    fn delivery(&self, card_id: &str) -> Answer {
        self.call("cards.delivery", &format!(r#"{{"cardId":"{card_id}"}}"#))
    }
}

#[test]
fn names_the_reason_for_a_country_off_the_list_and_refuses_the_order_there() {
    let Some(r) = Room::new() else { return };
    let off = r.call("cards.catalogue", r#"{"country":"us"}"#).ok();
    assert_eq!(s(&off, "country"), "US");
    assert_eq!(s(&off, "eligible"), "false");
    assert_eq!(s(&off, "reason"), "bank.card_not_eligible");
    assert_eq!(r.accept().code(), "ok");
    let refused = r.call(
        "cards.order",
        &format!(
            r#"{{"cardId":"{}","country":"US","termsVersion":"test-1","assetId":"USDT","perAuthorizationLimit":"50","cardType":"virtual"}}"#,
            uuid()
        ),
    );
    assert_eq!(refused.code(), "bank.card_not_eligible");
    assert_eq!(
        refused.message(),
        "Cards are not offered to residents of US"
    );
    assert_eq!(r.cards(), 0);
}

#[test]
fn refuses_an_order_before_the_terms_are_accepted_and_records_one_acceptance_however_often_it_is_given()
 {
    let Some(r) = Room::new() else { return };
    assert_eq!(r.virtual_card().code(), "bank.card_terms_not_accepted");
    let first = r.accept().ok();
    let again = r.accept().ok();
    assert_eq!(s(&again, "id"), s(&first, "id"));
    assert_eq!(s(&again, "acceptedAt"), s(&first, "acceptedAt"));
    assert_eq!(
        r._db.count(&format!(
            "SELECT count(*) FROM bank.card_terms_acceptances WHERE user_id = '{}'",
            r.user
        )),
        1
    );
    let other = r.call(
        "cards.acceptTerms",
        r#"{"termsVersion":"test-1","textHash":"sha256:other"}"#,
    );
    assert_eq!(other.code(), "bank.card_terms_changed");
    // The catalogue shows the acceptance it found.
    let shown = r.call("cards.catalogue", r#"{"country":"DE"}"#).ok();
    let terms = shown.get("terms").unwrap();
    assert_eq!(s(terms, "textHash"), terms_text_hash("TEST terms"));
    assert_eq!(s(terms.get("acceptance").unwrap(), "id"), s(&first, "id"));
}

#[test]
fn refuses_a_card_past_the_count_limit_and_a_retried_order_of_the_same_card_is_that_card() {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    let one = r.virtual_card().ok();
    r.virtual_card().ok();
    assert_eq!(r.virtual_card().code(), "bank.card_count_limit");
    let retried = r
        .call(
            "cards.order",
            &format!(
                r#"{{"cardId":"{}","country":"DE","termsVersion":"test-1","assetId":"USDT","perAuthorizationLimit":"50","cardType":"virtual"}}"#,
                s(&one, "id")
            ),
        )
        .ok();
    assert_eq!(s(&retried, "id"), s(&one, "id"));
    let catalogue = r.call("cards.catalogue", r#"{"country":"DE"}"#).ok();
    let products = arr(catalogue.get("products").unwrap());
    assert_eq!(
        products[0].compact(),
        r#"{"type":"virtual","held":2,"limit":2}"#
    );
    assert_eq!(r.cards(), 2);
}

/// The order's half of "holds a single-use card's one use from approval": the card is issued with its one use and
/// works at once; the holds are `card-ops`'.
#[test]
fn a_single_use_card_is_ordered_with_its_one_use_and_works_at_once() {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    let card = r.order(r#""cardType":"virtual","usesAllowed":1"#).ok();
    assert_eq!(s(&card, "usesAllowed"), "1");
    assert_eq!(s(&card, "status"), "active");
    let uses = r
        .call(
            "cards.uses",
            &format!(r#"{{"cardId":"{}"}}"#, s(&card, "id")),
        )
        .ok();
    assert_eq!(s(&uses, "usesMade"), "0");
}

#[test]
fn keeps_a_physical_card_inactive_until_it_is_activated() {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    let card = r.physical().ok();
    let id = s(&card, "id");
    assert_eq!(s(&card, "status"), "inactive");
    let stored: i64 = r._db.count(&format!(
        "SELECT count(*) FROM bank.cards WHERE id = '{id}' AND activated_at IS NULL"
    ));
    assert_eq!(stored, 1);
    // `cards.activate` is always behind step-up; the slice's own `activate` is what the TypeScript drives.
    let activated =
        r.b.cards_deps(door::system_now(), |d| {
            svc_bank::cards::core::activate(d, &id, &r.user)
        })
        .unwrap();
    assert!(activated.activated_at.is_some());
    let again =
        r.b.cards_deps(door::system_now(), |d| {
            svc_bank::cards::core::activate(d, &id, &r.user)
        })
        .unwrap();
    assert_eq!(again.activated_at, activated.activated_at);
    let stranger = r.b.cards_deps(door::system_now(), |d| {
        svc_bank::cards::core::activate(d, &id, &uuid())
    });
    match stranger {
        Err(svc_bank::errors::Refusal::Bank(e)) => assert_eq!(e.row.code, "bank.card_not_found"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn changes_the_address_before_print_with_the_old_one_kept_and_refuses_once_produced() {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    let card = r.physical().ok();
    let id = s(&card, "id");
    let moved = r#"{"name":"Ada TEST","line1":"9 TEST Allee","city":"Hamburg","postalCode":"10115","country":"de"}"#;
    let request = uuid();
    let update = |request: &str, address: &str| {
        r.call(
            "cards.updateShipping",
            &format!(r#"{{"cardId":"{id}","requestId":"{request}","address":{address}}}"#),
        )
    };
    let changed = update(&request, moved).ok();
    assert_eq!(s(changed.get("address").unwrap(), "line1"), "9 TEST Allee");
    assert_eq!(s(changed.get("address").unwrap(), "country"), "DE");
    let history = arr(changed.get("history").unwrap());
    assert_eq!(history.len(), 1);
    assert_eq!(
        s(history[0].get("address").unwrap(), "line1"),
        "1 TEST Strasse"
    );
    let replay = update(&request, moved).ok();
    assert_eq!(arr(replay.get("history").unwrap()).len(), 1);
    // The card's own address follows the delivery.
    assert_eq!(
        r._db.count(&format!(
            "SELECT count(*) FROM bank.cards WHERE id = '{id}' AND shipping_address->>'line1' = '9 TEST Allee'"
        )),
        1
    );
    let (status, _) = ship(&r.b, &id, r#""state":"produced""#);
    assert_eq!(status, 200);
    let locked = update(&uuid(), ADDRESS);
    assert_eq!(locked.code(), "bank.card_address_locked");
    let (status, back) = ship(&r.b, &id, r#""state":"ordered""#);
    assert_eq!(status, 400);
    assert_eq!(
        back.compact(),
        r#"{"error":"A produced card cannot go back to ordered","code":"bank.card_shipment_order"}"#
    );
    let read = r.delivery(&id).ok();
    assert_eq!(s(read.get("address").unwrap(), "line1"), "9 TEST Allee");
}

#[test]
fn names_hardware_as_not_connected_on_every_delivery_read_and_shows_the_carrier_and_number_the_printer_reports()
 {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    let card = r.physical().ok();
    let id = s(&card, "id");
    let first = r.delivery(&id).ok();
    assert_eq!(s(&first, "state"), "ordered");
    assert_eq!(s(&first, "carrier"), "null");
    assert_eq!(s(&first, "trackingRef"), "null");
    assert_eq!(s(&first, "notConnected"), "hardware");
    assert_eq!(s(&first, "designName"), "TEST Classic");
    assert_eq!(s(&first, "speed"), "standard");
    assert_eq!(s(&first, "estimateDays"), "7");
    let ordered = service_kit::time::js_date(&s(&first, "orderedAt")).unwrap();
    let expected = service_kit::time::js_date(&s(&first, "expectedBy")).unwrap();
    assert_eq!(expected.0 - ordered.0, 7 * 86_400_000);
    assert_eq!(ship(&r.b, &id, r#""state":"produced""#).0, 200);
    let (status, shipped) = ship(
        &r.b,
        &id,
        r#""state":"shipped","carrier":"TEST Post","trackingRef":"TEST-1""#,
    );
    assert_eq!(status, 200);
    // The job door sends the same delivery the read shows.
    let read = r.delivery(&id).ok();
    assert_eq!(shipped.compact(), read.compact());
    assert_eq!(s(&read, "state"), "shipped");
    assert_eq!(s(&read, "carrier"), "TEST Post");
    assert_eq!(s(&read, "trackingRef"), "TEST-1");
    assert_eq!(s(&read, "notConnected"), "hardware");
    // The same state again changes nothing, and a later word without a carrier keeps the carrier.
    assert_eq!(ship(&r.b, &id, r#""state":"shipped""#).0, 200);
    let (_, delivered) = ship(&r.b, &id, r#""state":"delivered""#);
    assert_eq!(s(&delivered, "carrier"), "TEST Post");
    assert_eq!(
        r._db.count(&format!(
            "SELECT count(*) FROM bank.card_shipments WHERE card_id = '{id}' \
               AND produced_at IS NOT NULL AND shipped_at IS NOT NULL AND delivered_at IS NOT NULL"
        )),
        1
    );
}

#[test]
fn on_a_lost_report_closes_the_card_once_and_leaves_one_new_inactive_card_with_its_own_delivery() {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    let card = r.physical().ok();
    let id = s(&card, "id");
    r.b.cards_deps(door::system_now(), |d| {
        svc_bank::cards::core::activate(d, &id, &r.user)
    })
    .unwrap();
    let replacement = uuid();
    let replace = || {
        r.call(
            "cards.replace",
            &format!(r#"{{"cardId":"{id}","replacementId":"{replacement}","reason":"stolen"}}"#),
        )
    };
    let fresh = replace().ok();
    assert_eq!(s(&fresh, "id"), replacement);
    assert_eq!(s(&fresh, "replacesCardId"), id);
    assert_eq!(s(&fresh, "cardType"), "physical");
    assert_eq!(s(&fresh, "status"), "inactive");
    assert_eq!(
        r._db.count(&format!(
            "SELECT count(*) FROM bank.cards WHERE id = '{id}' AND status = 'closed' AND replaced_by_card_id = '{replacement}'"
        )),
        1
    );
    let retry = replace().ok();
    assert_eq!(s(&retry, "id"), replacement);
    assert_eq!(r.cards(), 2);
    let delivery = r.delivery(&replacement).ok();
    assert_eq!(s(&delivery, "state"), "ordered");
    assert_eq!(
        s(delivery.get("address").unwrap(), "line1"),
        "1 TEST Strasse"
    );
    assert_eq!(arr(delivery.get("history").unwrap()).len(), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Past the TypeScript suite: the router's and the job door's own refusals.

#[test]
fn every_room_call_refuses_while_the_programme_is_unpublished() {
    let Some(db) = TestDb::new() else { return };
    db.migrated();
    let b = bank(&db, sim(), false);
    let user = uuid();
    for (path, input) in [
        ("cards.catalogue", r#"{"country":"DE"}"#.to_owned()),
        (
            "cards.acceptTerms",
            r#"{"termsVersion":"test-1","textHash":"x"}"#.to_owned(),
        ),
        (
            "cards.order",
            format!(
                r#"{{"cardId":"{}","country":"DE","termsVersion":"test-1","assetId":"USDT","perAuthorizationLimit":"50","cardType":"virtual"}}"#,
                uuid()
            ),
        ),
    ] {
        let a = call(&b, &user, path, &input);
        assert_eq!(a.0, 412, "{path}");
        assert_eq!(a.code(), "bank.card_eligibility_unset", "{path}");
    }
}

#[test]
fn an_order_refuses_a_physical_card_without_its_design_speed_address_or_delivery_country_and_a_virtual_card_with_them()
 {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    assert_eq!(
        r.order(r#""cardType":"physical","designId":"classic","deliverySpeed":"standard""#)
            .code(),
        "bank.card_shipping_address_required"
    );
    assert_eq!(
        r.order(&format!(
            r#""cardType":"physical","designId":"gold","deliverySpeed":"standard","shippingAddress":{ADDRESS}"#
        ))
        .code(),
        "bank.card_design_unknown"
    );
    assert_eq!(
        r.order(&format!(
            r#""cardType":"physical","designId":"classic","deliverySpeed":"express","shippingAddress":{ADDRESS}"#
        ))
        .code(),
        "bank.card_delivery_speed_unknown"
    );
    let fr = r#"{"name":"Ada TEST","line1":"1 rue TEST","city":"Paris","postalCode":"75001","country":"fr"}"#;
    let abroad = r.order(&format!(
        r#""cardType":"physical","designId":"classic","deliverySpeed":"standard","shippingAddress":{fr}"#
    ));
    assert_eq!(abroad.code(), "bank.card_delivery_country");
    assert_eq!(abroad.message(), "A physical card is not delivered to FR");
    assert_eq!(
        r.order(r#""cardType":"virtual","designId":"classic""#)
            .code(),
        "bank.card_not_physical"
    );
    let changed = r.call(
        "cards.order",
        &format!(
            r#"{{"cardId":"{}","country":"DE","termsVersion":"test-2","assetId":"USDT","perAuthorizationLimit":"50","cardType":"virtual"}}"#,
            uuid()
        ),
    );
    assert_eq!(changed.code(), "bank.card_terms_changed");
    assert_eq!(r.cards(), 0);
}

#[test]
fn a_delivery_is_only_its_owners_and_only_a_physical_cards() {
    let Some(r) = Room::new() else { return };
    r.accept().ok();
    let physical = s(&r.physical().ok(), "id");
    let virtual_id = s(&r.virtual_card().ok(), "id");
    let other = call(
        &r.b,
        &uuid(),
        "cards.delivery",
        &format!(r#"{{"cardId":"{physical}"}}"#),
    );
    assert_eq!(other.code(), "bank.card_not_found");
    // The customer copy of a not-found card is its code alone (`errors_table.rs`).
    assert_eq!(other.message(), "bank.card_not_found");
    assert_eq!(r.delivery(&virtual_id).code(), "bank.card_not_physical");
    let moved = r.call(
        "cards.updateShipping",
        &format!(
            r#"{{"cardId":"{physical}","requestId":"{}","address":{{"name":"A","line1":"1","city":"Paris","postalCode":"1","country":"FR"}}}}"#,
            uuid()
        ),
    );
    assert_eq!(moved.code(), "bank.card_delivery_country");
}

#[test]
fn the_printer_door_needs_a_signed_service_a_body_in_shape_a_physical_card_and_the_simulator() {
    let Some(db) = TestDb::new() else { return };
    db.migrated();
    let b = bank(&db, sim(), true);
    let unknown = uuid();
    let (status, body) = printer(
        &b,
        None,
        &format!(r#"{{"cardId":"{unknown}","state":"produced"}}"#),
    );
    assert_eq!(status, 401);
    assert_eq!(
        body.compact(),
        r#"{"error":"service credentials required","code":"bank.unauthenticated"}"#
    );
    for bad in [
        r#"{}"#.to_owned(),
        format!(r#"{{"cardId":"{unknown}","state":"lost"}}"#),
        format!(r#"{{"cardId":"{unknown}","state":"produced","extra":1}}"#),
        format!(r#"{{"cardId":"{unknown}","state":"produced","carrier":""}}"#),
        r#"{"cardId":"not-a-uuid","state":"produced"}"#.to_owned(),
    ] {
        let (status, body) = printer(&b, Some("svc-bank"), &bad);
        assert_eq!(status, 400, "{bad}");
        assert_eq!(
            body.compact(),
            r#"{"error":"body not in shape","code":"bank.validation_failed"}"#
        );
    }
    let (status, body) = ship(&b, &unknown, r#""state":"produced""#);
    assert_eq!(status, 400);
    assert_eq!(
        body.compact(),
        format!(r#"{{"error":"Card {unknown} not found","code":"bank.card_not_found"}}"#)
    );
    let user = uuid();
    call(
        &b,
        &user,
        "cards.acceptTerms",
        &format!(
            r#"{{"termsVersion":"test-1","textHash":"{}"}}"#,
            terms_text_hash("TEST terms")
        ),
    )
    .ok();
    let card = call(
        &b,
        &user,
        "cards.order",
        &format!(
            r#"{{"cardId":"{}","country":"DE","termsVersion":"test-1","assetId":"USDT","perAuthorizationLimit":"50","cardType":"virtual"}}"#,
            uuid()
        ),
    )
    .ok();
    let (status, body) = ship(&b, &s(&card, "id"), r#""state":"produced""#);
    assert_eq!(status, 400);
    assert_eq!(
        body.compact(),
        r#"{"error":"A virtual card has no delivery","code":"bank.card_not_physical"}"#
    );
    // No printer is connected to any other programme.
    let none = bank(&db, Issuer::None, true);
    let (status, body) = ship(&none, &unknown, r#""state":"produced""#);
    assert_eq!(status, 400);
    assert_eq!(
        body.compact(),
        r#"{"error":"Printing and delivery need hardware; no printer or courier is connected","code":"bank.card_printer_unset"}"#
    );
}
