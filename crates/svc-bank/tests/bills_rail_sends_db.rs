//! Part `rail_sends` of slice `bills` against the Rust door on a real Postgres. Ports every check of the TypeScript's
//! `rail-sends/rail-sends.db.test.ts` (the only TypeScript suite that reaches `railSends.*`: `rg -l railSends
//! services/svc-bank/src --glob '*.test.ts'`), each test named after the TypeScript test's words and driven through the
//! door as the TypeScript drives the mounted router: each rail's own form, the step-up scope, the intent kept refused
//! with `rail.bank` and nothing held or posted, the recipient book, its cooling-off and its scam warning. Nothing of
//! that suite is left out.
//!
//! The ledger is a stand-in, as the TypeScript's `MemoryLedger` is: it holds the TEST deposit of 50 USDT for Ada and
//! answers balances; a post to it is counted, so "nothing moved" is the count staying zero and the balance staying 50.
//! The TypeScript builds its services for each call, with the window (`payeeCoolingHours`) the test last set; here the
//! door is built again whenever a test sets the window. One test more than the TypeScript's: a ledger that cannot answer
//! the balance refuses a check and a send opaquely and keeps nothing (the failure branch of the one money read).
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

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use service_kit::approvals::random_uuid;
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::js_date;
use svc_bank::bills;
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::Wiring as SpacesWiring;
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};
use svc_bank::spaces::space;

use support::TestDb;

const SECRET: &str = "bank-rail-sends-edge-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";

const STEPPED: [&str; 3] = ["bank:read", "bank:write", "trade:withdraw"];
const PLAIN: [&str; 2] = ["bank:read", "bank:write"];

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

/// Balances by (owner, asset, kind).
type Balances = BTreeMap<(String, String, String), Amount>;

/// The TypeScript's `MemoryLedger` as far as this part reads it: balances, and a count of posts (there must be none).
#[derive(Clone, Default)]
struct Book {
    balances: Arc<Mutex<Balances>>,
    posts: Arc<AtomicUsize>,
    /// The ledger cannot answer a balance read.
    down: Arc<AtomicBool>,
}

impl Book {
    /// `recipes.deposit` into the person's main USDT.
    fn fund(&self, user: &str, amount: &str) {
        *self
            .balances
            .lock()
            .unwrap()
            .entry((user.to_owned(), "USDT".to_owned(), "available".to_owned()))
            .or_default() += parse_amount(amount).unwrap();
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        if self.down.load(Ordering::SeqCst) {
            return Err("ledger unreachable".to_owned());
        }
        Ok(self
            .balances
            .lock()
            .unwrap()
            .get(&(a.owner_id.clone(), a.asset_id.clone(), a.kind.to_owned()))
            .copied()
            .unwrap_or(Amount::ZERO))
    }
    fn balances(&self, _owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .balances
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k.0 == owner)
            .map(|(k, v)| LedgerBalance {
                asset_id: k.1.clone(),
                kind: k.2.clone(),
                purpose: String::new(),
                amount: *v,
            })
            .collect())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("no registry".to_owned())
    }
    fn post_recipe(&self, recipe: &str, _input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        self.posts.fetch_add(1, Ordering::SeqCst);
        Err(PostFailure::Unknown(format!(
            "a rail send posted {recipe} under {key}"
        )))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The bank

struct Bank {
    db: TestDb,
    store: Store,
    ledger: Book,
    /// `cooling`: the owner's window the next door is built with.
    door: RefCell<BankDoor>,
    space: String,
}

fn door_for(store: Store, ledger: &Book, cooling: &str) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut spaces = SpacesWiring::none();
    spaces.ledger = Box::new(ledger.clone());
    let mut bills = bills::Wiring::none();
    // `{ payeeCoolingHours: cooling ?? '' }`.
    bills.rail_sends.cooling_hours = Some(cooling.to_owned());
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: None,
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store,
    })
    .unwrap()
    .with_partner(PartnerWiring::none())
    .with_spaces(spaces)
    .with_bills(bills)
}

/// `beforeEach`: a fresh database, Ada's TEST deposit of 50 USDT, her main space, and a window of 24 hours.
fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let store = db.store();
    let ledger = Book::default();
    ledger.fund(ADA, "50");
    let space = space::with(&store, |c| space::ensure_primary(c, ADA, "USDT"))
        .unwrap()
        .id;
    let door = RefCell::new(door_for(db.store(), &ledger, "24"));
    Some(Bank {
        db,
        store,
        ledger,
        door,
        space,
    })
}

impl Bank {
    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }
    /// `cooling = value`: the services built from now on read this window.
    fn cooling(&self, value: &str) {
        *self.door.borrow_mut() = door_for(self.db.store(), &self.ledger, value);
    }
    /// `nothingMoved`: no post, and Ada's 50 USDT where it was.
    fn nothing_moved(&self) {
        assert_eq!(self.ledger.posts.load(Ordering::SeqCst), 0);
        let held = self
            .ledger
            .balances
            .lock()
            .unwrap()
            .get(&(ADA.to_owned(), "USDT".to_owned(), "available".to_owned()))
            .copied();
        assert_eq!(held, Some(parse_amount("50").unwrap()));
    }
    /// `back(payeeId, hours)`: the recipient was saved `hours` ago.
    fn back(&self, payee_id: &str, hours: i64) {
        self.db
            .client()
            .execute(
                "UPDATE bank.rail_payees SET created_at = now() - make_interval(hours => $2::int8::int4) \
                  WHERE id = $1::text::uuid",
                &[&payee_id, &hours],
            )
            .unwrap();
    }
    fn intents(&self) -> i64 {
        self.count("SELECT count(*) FROM bank.rail_send_intents")
    }
    /// `as(userId, scopes).railSends.<call>(input)`.
    fn call(&self, user: &str, scopes: &[&str], call: &str, input: &Json) -> (u16, Json) {
        let path = format!("railSends.{call}");
        let input = input.compact();
        let door = self.door.borrow();
        match door::call(&path).map(|c| c.kind) {
            Some(Kind::Query) => send(
                &door,
                &format!("/trpc/{path}?input={}", encode(&input)),
                "GET",
                "",
                person(user, scopes),
            ),
            _ => send(
                &door,
                &format!("/trpc/{path}"),
                "POST",
                &input,
                person(user, scopes),
            ),
        }
    }
    /// `send(over, userId, scopes)`: `{ requestId, fromSpaceId, amount: '20', rail: 'ach', recipient: ACH, ...over }`,
    /// a `None` in `over` leaving that key out.
    fn send(&self, over: &[(&str, Option<Json>)], user: &str, scopes: &[&str]) -> (u16, Json) {
        let base = [
            ("requestId", Json::str(random_uuid().unwrap())),
            ("fromSpaceId", Json::str(self.space.clone())),
            ("amount", Json::str("20")),
            ("rail", Json::str("ach")),
            ("recipient", ach(&[])),
        ];
        let mut fields: Vec<(String, Option<Json>)> = base
            .into_iter()
            .map(|(k, v)| (k.to_owned(), Some(v)))
            .collect();
        for (k, v) in over {
            match fields.iter_mut().find(|(n, _)| n == k) {
                Some(slot) => slot.1 = v.clone(),
                None => fields.push(((*k).to_owned(), v.clone())),
            }
        }
        let input = Json::Object(
            fields
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k, v)))
                .collect(),
        );
        self.call(user, scopes, "send", &input)
    }
    fn ada(&self, over: &[(&str, Option<Json>)]) -> (u16, Json) {
        self.send(over, ADA, &STEPPED)
    }
    /// `add(over, userId, scopes)`: Bea in Berlin over SEPA, unless `over` says otherwise.
    fn add(&self, over: &[(&str, Json)], user: &str, scopes: &[&str]) -> (u16, Json) {
        let mut fields = vec![
            ("nickname".to_owned(), Json::str("Bea in Berlin")),
            ("country".to_owned(), Json::str("DE")),
            ("rail".to_owned(), Json::str("sepa")),
            ("recipient".to_owned(), sepa_de(&[])),
        ];
        for (k, v) in over {
            match fields.iter_mut().find(|(n, _)| n == k) {
                Some(slot) => slot.1 = v.clone(),
                None => fields.push(((*k).to_owned(), v.clone())),
            }
        }
        self.call(user, scopes, "addPayee", &Json::Object(fields))
    }
    fn added(&self, over: &[(&str, Json)]) -> Json {
        data(&self.add(over, ADA, &STEPPED))
    }
    fn payees(&self, user: &str, limit: i64) -> Json {
        data(&self.call(
            user,
            &PLAIN,
            "payees",
            &Json::obj([("limit", Json::int(limit))]),
        ))
    }
    fn to_payee(payee_id: &str) -> Vec<(&'static str, Option<Json>)> {
        vec![
            ("payeeId", Some(Json::str(payee_id))),
            ("rail", None),
            ("recipient", None),
        ]
    }
}

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str(random_uuid().unwrap())),
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

fn send(
    door: &BankDoor,
    url: &str,
    method: &str,
    body: &str,
    mut headers: Vec<(String, String)>,
) -> (u16, Json) {
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_from(
        &Request {
            method,
            url,
            headers: &headers,
            body,
        },
        "req-rail-sends-db",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn data(a: &(u16, Json)) -> Json {
    assert_eq!(a.0, 200, "{}", a.1.compact());
    a.1.get("result").unwrap().get("data").unwrap().clone()
}

/// `errorOf`: the tRPC code and the bank's code.
fn refused(a: &(u16, Json)) -> (String, Option<String>) {
    assert_ne!(a.0, 200, "expected a refusal: {}", a.1.compact());
    let d = a.1.get("error").unwrap().get("data").unwrap();
    (
        s(d, "code"),
        d.get("cause").and_then(|c| c.get("code")).map(|c| match c {
            Json::String(v) => v.clone(),
            other => other.compact(),
        }),
    )
}

fn bank_code(a: &(u16, Json)) -> String {
    refused(a).1.unwrap_or_default()
}

fn message(a: &(u16, Json)) -> String {
    s(a.1.get("error").unwrap(), "message")
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        Some(other) => other.compact(),
        None => "undefined".to_owned(),
    }
}

fn pair(code: &str, bank: &str) -> (String, Option<String>) {
    (code.to_owned(), Some(bank.to_owned()))
}

fn obj(fields: &[(&str, &str)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), Json::str(*v)))
            .collect(),
    )
}

fn with(base: &[(&str, &str)], over: &[(&str, &str)]) -> Json {
    let mut fields: Vec<(&str, &str)> = base.to_vec();
    for (k, v) in over {
        match fields.iter_mut().find(|(n, _)| n == k) {
            Some(slot) => slot.1 = v,
            None => fields.push((k, v)),
        }
    }
    obj(&fields)
}

// TEST recipients: a routing number with a valid check digit, the IBAN registry's German example.
const ACH: [(&str, &str); 4] = [
    ("holderName", "Ada TEST"),
    ("routingNumber", "021000021"),
    ("accountNumber", "000123456789"),
    ("accountType", "checking"),
];
const SEPA: [(&str, &str); 3] = [
    ("holderName", "Ada TEST"),
    ("iban", "DE89 3704 0044 0532 0130 00"),
    ("transferType", "standard"),
];
const SEPA_DE: [(&str, &str); 3] = [
    ("holderName", "Bea TEST"),
    ("iban", "DE89 3704 0044 0532 0130 00"),
    ("transferType", "instant"),
];

fn ach(over: &[(&str, &str)]) -> Json {
    with(&ACH, over)
}
fn sepa(over: &[(&str, &str)]) -> Json {
    with(&SEPA, over)
}
fn sepa_de(over: &[(&str, &str)]) -> Json {
    with(&SEPA_DE, over)
}

fn some(j: Json) -> Option<Json> {
    Some(j)
}

// ---------------------------------------------------------------------------------------------------------------
// send to a bank account over a bank rail (J-bank-04 #1)

#[test]
fn lists_the_five_rails_each_with_its_own_form_and_no_partner_on_any_of_them() {
    let Some(b) = bank() else { return };
    let req = data(&b.call(ADA, &PLAIN, "requirements", &Json::Null));
    let Some(Json::Array(rails)) = req.get("rails") else {
        panic!("rails")
    };
    let names: Vec<String> = rails.iter().map(|r| s(r, "rail")).collect();
    assert_eq!(names, ["ach", "wire", "instant", "sepa", "proxy"]);
    assert!(
        rails
            .iter()
            .all(|r| r.get("partner") == Some(&Json::Null) && s(r, "blocker") == "rail.bank")
    );
    let fields = |rail: &str| -> Vec<Json> {
        match rails
            .iter()
            .find(|r| s(r, "rail") == rail)
            .unwrap()
            .get("fields")
        {
            Some(Json::Array(f)) => f.clone(),
            _ => panic!("fields"),
        }
    };
    let field_names =
        |rail: &str| -> Vec<String> { fields(rail).iter().map(|f| s(f, "name")).collect() };
    assert_eq!(
        field_names("ach"),
        [
            "holderName",
            "routingNumber",
            "accountNumber",
            "accountType"
        ]
    );
    assert_eq!(
        field_names("wire"),
        ["holderName", "routingNumber", "accountNumber", "bankName"]
    );
    assert_eq!(
        field_names("instant"),
        ["holderName", "routingNumber", "accountNumber"]
    );
    assert_eq!(
        field_names("sepa"),
        ["holderName", "iban", "bic", "transferType"]
    );
    assert_eq!(field_names("proxy"), ["aliasType", "alias"]);
    let bic = fields("sepa")
        .into_iter()
        .find(|f| s(f, "name") == "bic")
        .unwrap();
    assert_eq!(s(&bic, "required"), "false");
}

#[test]
fn keeps_the_send_refused_with_rail_bank_masked_nothing_held_or_posted_the_same_id_is_the_same_intent()
 {
    let Some(b) = bank() else { return };
    let request_id = random_uuid().unwrap();
    let first = data(&b.ada(&[("requestId", some(Json::str(request_id.clone())))]));
    for (k, v) in [
        ("requestId", request_id.as_str()),
        ("fromSpaceId", b.space.as_str()),
        ("assetId", "USDT"),
        ("amount", "20"),
        ("rail", "ach"),
        ("recipient", "Ada TEST · …6789"),
        ("status", "refused"),
        ("refusalCode", "rail.bank"),
    ] {
        assert_eq!(s(&first, k), v, "{k}");
    }
    // Spacing, case and key order do not change the ask.
    let reordered = obj(&[
        ("accountType", "checking"),
        ("accountNumber", "0001 2345 6789"),
        ("routingNumber", "0210-00021"),
        ("holderName", " Ada TEST "),
    ]);
    assert_eq!(
        data(&b.ada(&[
            ("requestId", some(Json::str(request_id.clone()))),
            ("amount", some(Json::str("20.0"))),
            ("recipient", some(reordered)),
        ])),
        first
    );
    let sepa_sent = data(&b.ada(&[
        ("rail", some(Json::str("sepa"))),
        ("recipient", some(sepa(&[]))),
        ("amount", some(Json::str("1"))),
    ]));
    assert_eq!(s(&sepa_sent, "recipient"), "Ada TEST · …3000");
    let proxy = data(&b.ada(&[
        ("rail", some(Json::str("proxy"))),
        (
            "recipient",
            some(obj(&[
                ("aliasType", "email"),
                ("alias", "Ada.Test@Example.com"),
            ])),
        ),
    ]));
    assert_eq!(s(&proxy, "recipient"), "email a…@example.com");
    let listed = data(&b.call(ADA, &PLAIN, "list", &Json::obj([("limit", Json::int(10))])));
    let Json::Array(listed) = listed else {
        panic!("list")
    };
    let ids: Vec<String> = listed.iter().map(|r| s(r, "requestId")).collect();
    assert_eq!(
        ids,
        [
            s(&proxy, "requestId"),
            s(&sepa_sent, "requestId"),
            request_id.clone()
        ]
    );
    let stored: String =
        b.db.client()
            .query_one(
                "SELECT recipient::text FROM bank.rail_send_intents WHERE id = $1::text::uuid",
                &[&request_id],
            )
            .unwrap()
            .get(0);
    let stored = json::parse(&stored).unwrap();
    let mut got: Vec<(String, String)> = match stored {
        Json::Object(o) => o
            .into_iter()
            .map(|(k, v)| (k, s(&Json::obj([("v", v)]), "v")))
            .collect(),
        _ => panic!("recipient"),
    };
    got.sort();
    let mut want: Vec<(String, String)> = ACH
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    want.sort();
    assert_eq!(got, want);
    b.nothing_moved();
}

#[test]
fn needs_the_step_up_scope_a_plain_session_is_refused_and_nothing_is_kept() {
    let Some(b) = bank() else { return };
    assert_eq!(refused(&b.send(&[], ADA, &PLAIN)).0, "FORBIDDEN");
    assert_eq!(b.intents(), 0);
}

#[test]
fn refuses_each_rails_malformed_fields_by_name_and_keeps_nothing() {
    let Some(b) = bank() else { return };
    let bad: Vec<(&str, Json)> = vec![
        ("ach", ach(&[("routingNumber", "021000022")])),
        // A check digit that adds up, but no Federal Reserve prefix, or nothing at all.
        ("ach", ach(&[("routingNumber", "500000005")])),
        ("ach", ach(&[("routingNumber", "000000000")])),
        ("ach", ach(&[("accountNumber", "12")])),
        ("ach", ach(&[("accountType", "brokerage")])),
        ("ach", ach(&[("holderName", "")])),
        ("ach", ach(&[("iban", "DE89370400440532013000")])),
        (
            "wire",
            obj(&[
                ("holderName", "Ada TEST"),
                ("routingNumber", "021000021"),
                ("accountNumber", "123456789"),
            ]),
        ),
        ("sepa", sepa(&[("iban", "DE89 3704 0044 0532 0130 01")])),
        ("sepa", sepa(&[("bic", "NOT A BIC")])),
        (
            "proxy",
            obj(&[("aliasType", "phone"), ("alias", "0049 30 1234")]),
        ),
        ("proxy", obj(&[("aliasType", "email"), ("alias", "nobody")])),
    ];
    for (rail, recipient) in bad {
        assert_eq!(
            refused(&b.ada(&[
                ("rail", some(Json::str(rail))),
                ("recipient", some(recipient.clone())),
            ])),
            pair("BAD_REQUEST", "bank.rail_send_invalid"),
            "{rail} {}",
            recipient.compact()
        );
    }
    for amount in ["0", "0.000"] {
        assert_eq!(
            bank_code(&b.ada(&[("amount", some(Json::str(amount)))])),
            "bank.rail_send_invalid"
        );
    }
    assert_eq!(b.intents(), 0);
    // The optional BIC and a phone alias pass when well formed.
    let with_bic = data(&b.ada(&[
        ("rail", some(Json::str("sepa"))),
        ("recipient", some(sepa(&[("bic", "cobadeffxxx")]))),
    ]));
    assert_eq!(s(&with_bic, "refusalCode"), "rail.bank");
    let phone = data(&b.ada(&[
        ("rail", some(Json::str("proxy"))),
        (
            "recipient",
            some(obj(&[("aliasType", "phone"), ("alias", "+49 30 1234567")])),
        ),
    ]));
    assert_eq!(s(&phone, "recipient"), "phone …4567");
}

#[test]
fn checks_everything_a_send_checks_keeping_nothing_and_refuses_more_than_the_space_holds() {
    let Some(b) = bank() else { return };
    let ask = |amount: &str, recipient: Json| {
        Json::obj([
            ("fromSpaceId", Json::str(b.space.clone())),
            ("amount", Json::str(amount)),
            ("rail", Json::str("ach")),
            ("recipient", recipient),
        ])
    };
    assert_eq!(
        data(&b.call(ADA, &PLAIN, "check", &ask("50", ach(&[])))).compact(),
        r#"{"assetId":"USDT","amount":"50","available":"50"}"#
    );
    assert_eq!(
        refused(&b.call(
            ADA,
            &PLAIN,
            "check",
            &ask("50.000000000000000001", ach(&[]))
        )),
        pair("PRECONDITION_FAILED", "bank.rail_send_over_available")
    );
    assert_eq!(
        bank_code(&b.call(
            ADA,
            &PLAIN,
            "check",
            &ask("50", ach(&[("accountNumber", "1")]))
        )),
        "bank.rail_send_invalid"
    );
    assert_eq!(
        bank_code(&b.ada(&[("amount", some(Json::str("50.1")))])),
        "bank.rail_send_over_available"
    );
    assert_eq!(b.intents(), 0);
    b.nothing_moved();
}

#[test]
fn someone_elses_space_an_unknown_one_or_an_archived_one_is_refused_the_same_id_on_other_terms_is_a_conflict()
 {
    let Some(b) = bank() else { return };
    assert_eq!(
        bank_code(&b.send(&[], BOB, &STEPPED)),
        "bank.space_not_found"
    );
    assert_eq!(
        bank_code(&b.ada(&[("fromSpaceId", some(Json::str(random_uuid().unwrap())))])),
        "bank.space_not_found"
    );
    let request_id = random_uuid().unwrap();
    let rid = || ("requestId", some(Json::str(request_id.clone())));
    data(&b.ada(&[rid()]));
    assert_eq!(
        refused(&b.ada(&[rid(), ("amount", some(Json::str("21")))])),
        pair("BAD_REQUEST", "bank.rail_send_conflict")
    );
    assert_eq!(
        bank_code(&b.ada(&[
            rid(),
            ("recipient", some(ach(&[("accountType", "savings")]))),
        ])),
        "bank.rail_send_conflict"
    );
    // The space is checked first: someone else's space is not found, whatever the id.
    assert_eq!(
        bank_code(&b.send(&[rid()], BOB, &STEPPED)),
        "bank.space_not_found"
    );
    let bobs = space::with(&b.store, |c| space::ensure_primary(c, BOB, "USDT"))
        .unwrap()
        .id;
    assert_eq!(
        bank_code(&b.send(
            &[rid(), ("fromSpaceId", some(Json::str(bobs)))],
            BOB,
            &STEPPED
        )),
        "bank.rail_send_conflict"
    );
    assert_eq!(
        data(&b.call(BOB, &PLAIN, "list", &Json::obj([("limit", Json::int(10))]))),
        Json::Array(vec![])
    );
    b.sql(&format!(
        "UPDATE bank.spaces SET archived_at = now() WHERE id = '{}'",
        b.space
    ));
    assert_eq!(bank_code(&b.ada(&[])), "bank.space_archived");
    assert_eq!(b.intents(), 1);
    b.nothing_moved();
}

/// Not in the TypeScript suite: the one money read is the space's balance, and a ledger that cannot answer it refuses
/// a check and a send with the guard's opaque failure, keeping nothing.
#[test]
fn a_ledger_that_cannot_answer_the_balance_refuses_opaquely_and_keeps_nothing() {
    let Some(b) = bank() else { return };
    b.ledger.down.store(true, Ordering::SeqCst);
    let check = b.call(
        ADA,
        &PLAIN,
        "check",
        &Json::obj([
            ("fromSpaceId", Json::str(b.space.clone())),
            ("amount", Json::str("5")),
            ("rail", Json::str("ach")),
            ("recipient", ach(&[])),
        ]),
    );
    assert_eq!(refused(&check), ("INTERNAL_SERVER_ERROR".to_owned(), None));
    assert!(message(&check).starts_with("Bank operation failed (ref "));
    let sent = b.ada(&[]);
    assert_eq!(refused(&sent), ("INTERNAL_SERVER_ERROR".to_owned(), None));
    assert_eq!(b.intents(), 0);
    b.ledger.down.store(false, Ordering::SeqCst);
    b.nothing_moved();
}

// ---------------------------------------------------------------------------------------------------------------
// the recipient book (J-bank-04 #2)

#[test]
fn takes_each_countrys_own_rails_checks_the_form_as_a_send_does_and_lists_the_countries() {
    let Some(b) = bank() else { return };
    let req = data(&b.call(ADA, &PLAIN, "requirements", &Json::Null));
    let Some(Json::Array(countries)) = req.get("countries") else {
        panic!("countries")
    };
    let rails_of = |c: &str| {
        countries
            .iter()
            .find(|r| s(r, "country") == c)
            .map(|r| r.get("rails").unwrap().compact())
    };
    assert_eq!(
        rails_of("US").as_deref(),
        Some(r#"["ach","wire","instant","proxy"]"#)
    );
    assert_eq!(rails_of("DE").as_deref(), Some(r#"["sepa","proxy"]"#));
    assert_eq!(rails_of("GB"), None);
    let overs: Vec<Vec<(&str, Json)>> = vec![
        vec![("country", Json::str("US"))], // SEPA is not a US form
        vec![("country", Json::str("FR"))], // a German IBAN is not an account in France
        vec![("country", Json::str("GB"))],
        vec![("rail", Json::str("ach")), ("recipient", ach(&[]))], // ACH is not a German form
        vec![(
            "recipient",
            sepa_de(&[("iban", "DE89 3704 0044 0532 0130 01")]),
        )],
        vec![("nickname", Json::str(" "))],
    ];
    for over in overs {
        assert_eq!(
            refused(&b.add(&over, ADA, &STEPPED)),
            pair("BAD_REQUEST", "bank.rail_send_invalid")
        );
    }
    assert_eq!(refused(&b.add(&[], ADA, &PLAIN)).0, "FORBIDDEN");
    // The check before the code answers the same, keeping nothing.
    let ask = |country: &str| {
        Json::obj([
            ("nickname", Json::str("Bea in Berlin")),
            ("country", Json::str(country)),
            ("rail", Json::str("sepa")),
            ("recipient", sepa_de(&[])),
        ])
    };
    assert_eq!(
        data(&b.call(ADA, &PLAIN, "checkPayee", &ask("DE"))).compact(),
        r#"{"nickname":"Bea in Berlin","country":"DE","rail":"sepa","recipient":"Bea TEST · …3000"}"#
    );
    assert_eq!(
        bank_code(&b.call(ADA, &PLAIN, "checkPayee", &ask("FR"))),
        "bank.rail_send_invalid"
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.rail_payees"), 0);
    let us = b.added(&[
        ("nickname", Json::str("Ada at home")),
        ("country", Json::str("us")),
        ("rail", Json::str("ach")),
        ("recipient", ach(&[])),
    ]);
    assert_eq!(s(&us, "country"), "US");
    assert_eq!(s(&us, "rail"), "ach");
    assert_eq!(s(&us, "recipient"), "Ada TEST · …6789");
    // The same US account over another rail is the same destination, inside the same window.
    let as_wire = obj(&[
        ("holderName", "Ada TEST"),
        ("routingNumber", "021000021"),
        ("accountNumber", "000123456789"),
        ("bankName", "TEST Bank"),
    ]);
    assert_eq!(
        bank_code(&b.ada(&[
            ("rail", some(Json::str("wire"))),
            ("recipient", some(as_wire)),
        ])),
        "bank.payee_cooling_active"
    );
}

#[test]
fn a_new_recipient_shows_cannot_check_with_rail_bank_and_the_end_of_its_window_the_same_account_again_is_the_same_one()
 {
    let Some(b) = bank() else { return };
    let first = b.added(&[]);
    for (k, v) in [
        ("nickname", "Bea in Berlin"),
        ("country", "DE"),
        ("rail", "sepa"),
        ("recipient", "Bea TEST · …3000"),
        ("verification", "cannot_check"),
        ("verificationRail", "rail.bank"),
    ] {
        assert_eq!(s(&first, k), v, "{k}");
    }
    let cooling = first.get("cooling").unwrap();
    assert_eq!(s(cooling, "state"), "active");
    let ends = js_date(&s(cooling, "endsAt")).unwrap();
    let added = js_date(&s(&first, "addedAt")).unwrap();
    assert_eq!(ends.0 - added.0, 24 * 3_600_000);
    // Spacing and a new nickname or holder name do not make a second recipient, nor restart the window.
    let again = b.added(&[
        ("nickname", Json::str("Bea")),
        (
            "recipient",
            sepa_de(&[("holderName", "B TEST"), ("iban", "de89370400440532013000")]),
        ),
    ]);
    assert_eq!(s(&again, "payeeId"), s(&first, "payeeId"));
    assert_eq!(b.payees(ADA, 10), Json::Array(vec![first]));
    assert_eq!(b.payees(BOB, 10), Json::Array(vec![]));
}

#[test]
fn a_send_to_it_refuses_inside_the_window_with_the_end_time_and_goes_on_to_rail_bank_once_the_window_has_passed()
 {
    let Some(b) = bank() else { return };
    let payee = b.added(&[]);
    let payee_id = s(&payee, "payeeId");
    let ends_at = s(payee.get("cooling").unwrap(), "endsAt");
    let to_payee = Bank::to_payee(&payee_id);
    let inside = b.ada(&to_payee);
    assert_eq!(
        refused(&inside),
        pair("PRECONDITION_FAILED", "bank.payee_cooling_active")
    );
    assert!(message(&inside).contains(&ends_at), "{}", message(&inside));
    assert_eq!(
        bank_code(&b.call(
            ADA,
            &PLAIN,
            "check",
            &Json::obj([
                ("fromSpaceId", Json::str(b.space.clone())),
                ("amount", Json::str("5")),
                ("payeeId", Json::str(payee_id.clone())),
            ])
        )),
        "bank.payee_cooling_active"
    );
    // Typing the same account in by hand is the same destination, with the same window.
    assert_eq!(
        bank_code(&b.ada(&[
            ("rail", some(Json::str("sepa"))),
            (
                "recipient",
                some(sepa_de(&[("holderName", "Someone TEST")]))
            ),
        ])),
        "bank.payee_cooling_active"
    );
    assert_eq!(b.intents(), 0);
    b.back(&payee_id, 24);
    let listed = b.payees(ADA, 1);
    let Json::Array(listed) = listed else {
        panic!("payees")
    };
    assert_eq!(s(listed[0].get("cooling").unwrap(), "state"), "open");
    let request_id = random_uuid().unwrap();
    let mut with_id = to_payee.clone();
    with_id.push(("requestId", some(Json::str(request_id.clone()))));
    let kept = data(&b.ada(&with_id));
    assert_eq!(s(&kept, "rail"), "sepa");
    assert_eq!(s(&kept, "recipient"), "Bea TEST · …3000");
    assert_eq!(s(&kept, "refusalCode"), "rail.bank");
    // A send already kept is answered as kept, even once the window is no longer published.
    b.cooling("");
    assert_eq!(data(&b.ada(&with_id)), kept);
    b.nothing_moved();
}

#[test]
fn a_blank_window_refuses_every_send_to_a_saved_recipient_by_name_zero_is_no_wait() {
    let Some(b) = bank() else { return };
    let payee = b.added(&[]);
    let payee_id = s(&payee, "payeeId");
    b.back(&payee_id, 1000);
    b.cooling("");
    let first_cooling = |b: &Bank| {
        let Json::Array(rows) = b.payees(ADA, 1) else {
            panic!("payees")
        };
        rows[0].get("cooling").unwrap().clone()
    };
    assert_eq!(
        first_cooling(&b).compact(),
        r#"{"state":"unset","endsAt":null}"#
    );
    assert_eq!(
        refused(&b.ada(&Bank::to_payee(&payee_id))),
        pair("PRECONDITION_FAILED", "bank.payee_cooling_unset")
    );
    // A window no date can hold is not a published window either.
    b.cooling("99999999999");
    assert_eq!(s(&first_cooling(&b), "state"), "unset");
    b.cooling("soon");
    assert_eq!(
        bank_code(&b.ada(&Bank::to_payee(&payee_id))),
        "bank.payee_cooling_unset"
    );
    b.cooling("0");
    let fresh = b.added(&[
        (
            "recipient",
            sepa_de(&[("iban", "FR14 2004 1010 0505 0001 3M02 606")]),
        ),
        ("country", Json::str("FR")),
    ]);
    assert_eq!(s(fresh.get("cooling").unwrap(), "state"), "open");
    assert_eq!(
        s(
            &data(&b.ada(&Bank::to_payee(&s(&fresh, "payeeId")))),
            "refusalCode"
        ),
        "rail.bank"
    );
}

#[test]
fn someone_elses_recipient_or_a_removed_one_is_not_found_a_changed_account_is_a_new_recipient_whose_window_starts_again()
 {
    let Some(b) = bank() else { return };
    let payee = b.added(&[]);
    let payee_id = s(&payee, "payeeId");
    b.back(&payee_id, 48);
    assert_eq!(
        bank_code(&b.send(&Bank::to_payee(&payee_id), BOB, &STEPPED)),
        "bank.payee_not_found"
    );
    let remove = Json::obj([("payeeId", Json::str(payee_id.clone()))]);
    assert_eq!(
        bank_code(&b.call(BOB, &STEPPED, "removePayee", &remove)),
        "bank.payee_not_found"
    );
    assert_eq!(
        data(&b.call(ADA, &STEPPED, "removePayee", &remove)).compact(),
        format!(r#"{{"payeeId":"{payee_id}","removed":true}}"#)
    );
    assert_eq!(
        bank_code(&b.ada(&Bank::to_payee(&payee_id))),
        "bank.payee_not_found"
    );
    assert_eq!(b.payees(ADA, 10), Json::Array(vec![]));
    let again = b.added(&[]);
    assert_ne!(s(&again, "payeeId"), payee_id);
    assert_eq!(s(again.get("cooling").unwrap(), "state"), "active");
}

#[test]
fn the_first_time_payee_scam_warning_reads_unread_until_read_once_per_recipient_someone_else_cannot_read_it()
 {
    let Some(b) = bank() else { return };
    let bea = b.added(&[]);
    assert_eq!(
        bea.get("scamWarning").unwrap().compact(),
        r#"{"state":"unread","readAt":null}"#
    );
    let read_as = |user: &str, id: &str| {
        b.call(
            user,
            &PLAIN,
            "readPayeeWarning",
            &Json::obj([("payeeId", Json::str(id))]),
        )
    };
    let read = data(&read_as(ADA, &s(&bea, "payeeId")));
    let warning = read.get("scamWarning").unwrap().clone();
    assert_eq!(s(&warning, "state"), "read");
    assert!(js_date(&s(&warning, "readAt")).is_some());
    // Reading again changes nothing: the first read's time stands.
    assert_eq!(
        data(&read_as(ADA, &s(&bea, "payeeId")))
            .get("scamWarning")
            .unwrap(),
        &warning
    );
    let Json::Array(rows) = b.payees(ADA, 10) else {
        panic!("payees")
    };
    assert_eq!(rows[0].get("scamWarning").unwrap(), &warning);
    // Another recipient is a first-time payee of its own.
    let us = b.added(&[
        ("nickname", Json::str("Ada at home")),
        ("country", Json::str("US")),
        ("rail", Json::str("ach")),
        ("recipient", ach(&[])),
    ]);
    assert_eq!(s(us.get("scamWarning").unwrap(), "state"), "unread");
    let us_id = s(&us, "payeeId");
    // Someone else's recipient is not found, and theirs stays unread.
    assert_eq!(bank_code(&read_as(BOB, &us_id)), "bank.payee_not_found");
    let Json::Array(rows) = b.payees(ADA, 10) else {
        panic!("payees")
    };
    let mine = rows.iter().find(|p| s(p, "payeeId") == us_id).unwrap();
    assert_eq!(s(mine.get("scamWarning").unwrap(), "state"), "unread");
    // A removed recipient cannot be read either.
    data(&b.call(
        ADA,
        &STEPPED,
        "removePayee",
        &Json::obj([("payeeId", Json::str(us_id.clone()))]),
    ));
    assert_eq!(bank_code(&read_as(ADA, &us_id)), "bank.payee_not_found");
}

#[test]
fn an_invite_is_refused_by_name_no_email_delivery_is_connected() {
    let Some(b) = bank() else { return };
    let invite = |email: &str| {
        b.call(
            ADA,
            &STEPPED,
            "invitePayee",
            &Json::obj([("email", Json::str(email))]),
        )
    };
    assert_eq!(
        refused(&invite("bea@example.com")),
        pair("PRECONDITION_FAILED", "bank.payee_invite_unwired")
    );
    assert_eq!(bank_code(&invite("bea")), "bank.rail_send_invalid");
}
