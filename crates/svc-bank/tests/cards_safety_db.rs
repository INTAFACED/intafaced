//! Slice `cards`' safety and disputes parts against the Rust door on a real Postgres: 3D Secure and fraud reports
//! (J-bank-14 #5, #7; `cards.threeDS.*`, `cards.fraud.*`) and the cardholder's own disputes (J-bank-15;
//! `cards.disputes.*`). Ports the checks of `cards/cards-procedures.test.ts` that fall on those calls and the cardholder
//! describe of `cards/card-disputes.money.test.ts`, each test named after the TypeScript test's words. A call through
//! the router is a door call here; a call on `CardDisputeService` or `CardSafety` is the Rust function it became, handed
//! the dependencies the door gives it (`BankDoor::cards_deps`), as when the TypeScript test moves the clock.
//!
//! What the TypeScript drives through `ops.cardAuthorize` and `ops.cardCapture` before a dispute or a fraud report is
//! written here as the rows those calls write: a `card_authorizations` row and its settled `card_settlements` capture
//! (the disputes and fraud reports read them, and move no money of their own); `ops.cardThreeDSChallenge` is
//! `safety::open`, the function it reaches; support's `submitRepresentment` is the case's state, and
//! `grantProvisionalCredit` the TEST partner's credit and the case's columns it writes. The right 3D Secure code drives
//! the real authorisation (`card-ops`' `authorize`, on a door with slice `card-ops`' stand-in ledger, `paying_bank`):
//! the hold is made once and every later answer returns that one authorisation.
//!
//! Not ported, with the reason: the rest of `card-disputes.money.test.ts` (the queue, representment, arbitration, the
//! provisional credit, the loss bearer, the cap, the partner mismatch, the step keys, two opens at once from support,
//! the cap parser) is support's `ops.cardDispute*`, slice `card-ops`' desk. Without `TEST_DATABASE_URL` each test
//! skips; with `REQUIRE_POSTGRES=1` it fails.

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
use service_kit::money::parse_amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use support::TestDb;
use svc_bank::cards::core::{self, IssueAsk};
use svc_bank::cards::issuer::Issuer;
use svc_bank::cards::terms::{DisputeRules, PartnerTerms};
use svc_bank::cards::{NoRankTier, Settings, Wiring, disputes, safety};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;

/// The card-ops kit's, so one signed caller reaches both doors.
const SECRET: &str = crate::card_ops_kit::SECRET;
const INTERNAL: &str = "a-bank-cards-safety-internal-secret-long-ok";
const HOLDER: &str = "11111111-1111-4111-8111-111111111111";
const STRANGER: &str = "33333333-3333-4333-8333-333333333333";
const OPERATOR: &str = "support-operator-a";

fn uuid() -> String {
    random_uuid().unwrap()
}

/// `SILENT`: the TEST partner reports a balance of 30 USDT and nothing else.
fn silent() -> PartnerTerms {
    PartnerTerms {
        balances: Some(vec![("USDT".to_owned(), "30".to_owned())]),
        ..PartnerTerms::nothing_reported()
    }
}

/// `RULES`: the partner's dispute rules, 120 days and no evidence after the representment.
fn rules(after: bool) -> PartnerTerms {
    PartnerTerms {
        dispute_rules: Some(DisputeRules {
            window_days: 120,
            evidence_after_submission: after,
        }),
        ..silent()
    }
}

/// The TEST partner with `secrets: "test"` (`testSecretsSim`).
fn secrets() -> PartnerTerms {
    PartnerTerms {
        test_secrets: true,
        ..PartnerTerms::nothing_reported()
    }
}

struct Bank {
    door: BankDoor,
}

fn bank(db: &TestDb, terms: PartnerTerms, three_ds_try_limit: Option<i64>) -> Bank {
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
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_cards(Wiring {
        issuer: Issuer::sim(terms),
        rank: Box::new(NoRankTier),
        holds: Default::default(),
        settings: Settings {
            pin_try_limit: Some(3),
            three_ds_try_limit,
            dispute_cap: Some(vec![("USDT".to_owned(), "100".to_owned())]),
            ..Settings::default()
        },
    });
    Bank { door }
}

/// A door that holds money (slice `card-ops`' stand-in ledger, the holder funded with 100 USDT), for a 3D Secure answer
/// that goes on to authorise the purchase.
fn paying_bank(
    terms: PartnerTerms,
    three_ds_try_limit: Option<i64>,
) -> Option<(TestDb, Bank, crate::card_ops_kit::Book)> {
    let k = crate::card_ops_kit::kit(crate::card_ops_kit::Opts {
        issuer: Issuer::sim(terms),
        settings: Settings {
            pin_try_limit: Some(3),
            three_ds_try_limit,
            dispute_cap: Some(vec![("USDT".to_owned(), "100".to_owned())]),
            ..Settings::default()
        },
        ..crate::card_ops_kit::Opts::default()
    })?;
    k.ledger.fund(HOLDER, "USDT", "100");
    let crate::card_ops_kit::Kit {
        db, ledger, door, ..
    } = k;
    Some((db, Bank { door }, ledger))
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
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
    /// The refusal's own code (`cause.code`), tRPC's code where there is none, or `ok`.
    fn code(&self) -> String {
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
}

fn call(b: &Bank, user: &str, path: &str, input: &Json) -> Answer {
    let input = input.compact();
    let mut headers = person(user);
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
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-cards-safety-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn arr(j: &Json, key: &str) -> Vec<Json> {
    match j.get(key) {
        Some(Json::Array(v)) => v.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

fn items(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(v) => v.clone(),
        other => panic!("not a list: {other:?}"),
    }
}

fn code_of<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        other => panic!("expected a bank refusal: {other:?}"),
    }
}

fn now() -> Instant {
    door::system_now()
}

/// `bank.cards.issue`: an active virtual USDT card with a per-purchase cap of 100 (or `per`).
fn issue(b: &Bank, user: &str, per: &str) -> String {
    let card_id = uuid();
    b.door
        .cards_deps(now(), |d| {
            core::issue(
                d,
                &IssueAsk {
                    card_id: card_id.clone(),
                    user_id: user.to_owned(),
                    asset_id: "USDT".to_owned(),
                    per_authorization_limit: parse_amount(per).unwrap(),
                    ..IssueAsk::default()
                },
            )
        })
        .unwrap();
    card_id
}

/// What `ops.cardAuthorize` writes: one authorisation, approved (with its hold) or declined with `decline`.
fn authorize(
    db: &TestDb,
    card_id: &str,
    reference: &str,
    amount: &str,
    decline: Option<&str>,
) -> String {
    let decision = if decline.is_some() {
        "declined"
    } else {
        "approved"
    };
    let hold = decline.is_none().then(|| format!("TEST-hold-{reference}"));
    db.client()
        .query_one(
            "INSERT INTO bank.card_authorizations (card_id, authorization_ref, amount, decision, decline_code, hold_ledger_tx_id, merchant, channel) \
             VALUES ($1::text::uuid, $2, $3::text::numeric, $4::text::bank.card_decision, $5, $6, 'TEST shop', 'online') RETURNING id::text",
            &[&card_id, &reference, &amount, &decision, &decline, &hold],
        )
        .unwrap()
        .get(0)
}

/// What `ops.cardCapture` writes: the capture of the whole authorisation, settled.
fn capture(db: &TestDb, authorization_id: &str, amount: &str) {
    let mut c = db.client();
    c.execute(
        "INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount, status, ledger_tx_id, settled_at) \
         VALUES ($1::text::uuid, 1, 'capture', $2::text::numeric, 'settled', 'TEST-capture', now())",
        &[&authorization_id, &amount],
    )
    .unwrap();
    c.execute(
        "UPDATE bank.card_authorizations SET status = 'settled', settled_at = now() WHERE id = $1::text::uuid",
        &[&authorization_id],
    )
    .unwrap();
}

/// `captured(amount)`: a cardholder with one captured payment of `amount` USDT.
fn captured(b: &Bank, db: &TestDb, amount: &str) -> (String, String, String) {
    let user = uuid();
    let card = issue(b, &user, "500");
    let reference = format!("auth-{}", uuid());
    let id = authorize(db, &card, &reference, amount, None);
    capture(db, &id, amount);
    (user, card, reference)
}

/// `ops.cardThreeDSChallenge`: the issuer opens a challenge (`CardSafety.open`).
fn challenge(
    b: &Bank,
    card_id: &str,
    id: &str,
    reference: &str,
    amount: &str,
) -> Result<Json, Refusal> {
    b.door.cards_deps(now(), |d| {
        safety::open(
            d,
            &safety::OpenAsk {
                challenge_id: id.to_owned(),
                card_id: card_id.to_owned(),
                challenge_ref: reference.to_owned(),
                amount: parse_amount(amount).unwrap(),
                merchant: Some("Online shop".to_owned()),
                merchant_country: Some("de".to_owned()),
                merchant_category: None,
            },
        )
    })
}

fn answer(b: &Bank, card_id: &str, challenge_id: &str, code: Option<&str>) -> Answer {
    let mut fields = vec![
        ("cardId".to_owned(), Json::str(card_id)),
        ("challengeId".to_owned(), Json::str(challenge_id)),
    ];
    if let Some(code) = code {
        fields.push(("code".to_owned(), Json::str(code)));
    }
    call(b, HOLDER, "cards.threeDS.answer", &Json::Object(fields))
}

fn challenges(b: &Bank, user: &str, card_id: &str) -> Answer {
    call(
        b,
        user,
        "cards.threeDS.list",
        &Json::obj([("cardId", Json::str(card_id))]),
    )
}

fn listed(b: &Bank, card_id: &str, id: &str) -> Json {
    arr(&challenges(b, HOLDER, card_id).ok(), "challenges")
        .into_iter()
        .find(|c| s(c, "id") == id)
        .unwrap()
}

fn other_code(code: &str) -> &'static str {
    if code == "000000" { "111111" } else { "000000" }
}

// ---------------------------------------------------------------------------------------------------------------
// 3D Secure and fraud reports (cards-procedures.test.ts)

#[test]
fn completes_a_3d_secure_purchase_once_on_the_right_code_and_locks_a_challenge_at_the_owner_count_of_wrong_codes()
 {
    let Some((db, b, ledger)) = paying_bank(secrets(), Some(3)) else {
        return;
    };
    let card = issue(&b, HOLDER, "100");

    let opened_id = uuid();
    let opened = challenge(&b, &card, &opened_id, "3ds-ok", "7").unwrap();
    assert_eq!(s(&opened, "state"), "open");
    // The same reference again is the same challenge; with a different amount it refuses and changes nothing.
    assert_eq!(
        s(&challenge(&b, &card, &uuid(), "3ds-ok", "7").unwrap(), "id"),
        opened_id
    );
    assert_eq!(
        code_of(challenge(&b, &card, &uuid(), "3ds-ok", "8")),
        "bank.card_3ds_conflict"
    );
    // A challenge id already used for another purchase refuses by name, and opens nothing.
    assert_eq!(
        code_of(challenge(&b, &card, &opened_id, "3ds-other", "7")),
        "bank.card_3ds_conflict"
    );
    assert_eq!(
        db.count("SELECT count(*)::int8 FROM bank.card_3ds_challenges"),
        1
    );

    let first = listed(&b, &card, &opened_id);
    assert_eq!(s(&first, "state"), "open");
    assert_eq!(s(&first, "triesLeft"), "3");
    assert_eq!(s(&first, "amount"), "7");
    assert_eq!(s(&first, "merchant"), "Online shop");
    assert_eq!(s(&first, "merchantCountry"), "DE");
    let right = s(&first, "testCode");
    assert!(
        right.len() == 6 && right.bytes().all(|c| c.is_ascii_digit()),
        "{right}"
    );
    let wrong = other_code(&right);

    let once = answer(&b, &card, &opened_id, Some(wrong)).ok();
    assert_eq!(
        (
            s(&once, "state"),
            s(&once, "triesLeft"),
            s(&once, "authorizationId")
        ),
        ("open".to_owned(), "2".to_owned(), "null".to_owned())
    );
    // The right code approves it and authorises the purchase once, under the challenge's business key: the hold is made.
    let approved = answer(&b, &card, &opened_id, Some(&right)).ok();
    assert_eq!(s(&approved, "state"), "approved");
    assert_eq!(s(&approved, "decision"), "approved");
    let auth = s(&approved, "authorizationId");
    let row = db
        .client()
        .query_one(
            "SELECT c.state, c.authorization_id::text, c.wrong_codes::int8, a.authorization_ref \
               FROM bank.card_3ds_challenges c JOIN bank.card_authorizations a ON a.id = c.authorization_id \
              WHERE c.id = $1::text::uuid",
            &[&opened_id],
        )
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "approved");
    assert_eq!(row.get::<_, Option<String>>(1), Some(auth.clone()));
    assert_eq!(row.get::<_, i64>(2), 1);
    assert_eq!(
        row.get::<_, String>(3),
        safety::three_ds_authorization_ref("3ds-ok")
    );
    assert_eq!(ledger.held(&auth, HOLDER, "USDT"), "7");
    assert_eq!(ledger.available(HOLDER, "USDT"), "93");

    // Every answer after returns that one authorisation, whatever code is typed, with its decision and no TEST code.
    let done = answer(&b, &card, &opened_id, Some(&right)).ok();
    assert_eq!(s(&done, "state"), "approved");
    assert_eq!(s(&done, "decision"), "approved");
    assert_eq!(s(&done, "declineCode"), "null");
    assert_eq!(s(&done, "testCode"), "null");
    assert_eq!(s(&done, "authorizationId"), auth);
    let (again, racing) = std::thread::scope(|sc| {
        let a = sc.spawn(|| answer(&b, &card, &opened_id, Some(&right)));
        let r = sc.spawn(|| answer(&b, &card, &opened_id, Some(wrong)));
        (a.join().unwrap().ok(), r.join().unwrap().ok())
    });
    assert_eq!(s(&again, "authorizationId"), auth);
    assert_eq!(s(&racing, "authorizationId"), auth);
    assert_eq!(ledger.booked("withdraw.hold:"), 1);
    assert_eq!(ledger.available(HOLDER, "USDT"), "93");

    // Three wrong codes lock the next challenge: no authorisation, and the right code no longer helps.
    let locked_id = uuid();
    challenge(&b, &card, &locked_id, "3ds-locked", "7").unwrap();
    let code = s(&listed(&b, &card, &locked_id), "testCode");
    let bad = other_code(&code);
    for (state, left) in [("open", "2"), ("open", "1"), ("locked", "0")] {
        let a = answer(&b, &card, &locked_id, Some(bad)).ok();
        assert_eq!(
            (s(&a, "state").as_str(), s(&a, "triesLeft").as_str()),
            (state, left)
        );
    }
    let after = answer(&b, &card, &locked_id, Some(&code)).ok();
    assert_eq!(s(&after, "state"), "locked");
    assert_eq!(s(&after, "authorizationId"), "null");
    assert_eq!(s(&after, "testCode"), "null");
    assert_eq!(
        db.count("SELECT count(*)::int8 FROM bank.card_authorizations"),
        1
    );
    // The code is never kept.
    let kept: String = db
        .client()
        .query_one(
            "SELECT coalesce(string_agg(row_to_json(c)::text, ''), '') FROM bank.card_3ds_challenges c",
            &[],
        )
        .unwrap()
        .get(0);
    assert!(!kept.contains(&code));
    assert!(!kept.contains(&right));
}

#[test]
fn finishes_an_approved_3d_secure_challenge_whose_authorisation_was_never_written_and_refuses_by_name_without_the_owner_count_or_a_partner()
 {
    let Some((db, b, ledger)) = paying_bank(secrets(), Some(3)) else {
        return;
    };
    let card = issue(&b, HOLDER, "100");
    let crash = uuid();
    challenge(&b, &card, &crash, "3ds-crash", "5").unwrap();
    // A crash between the approval and the authorisation: the row says approved and holds no authorisation. Answered
    // with no code it is finished through `authorize`, once.
    db.client()
        .execute(
            "UPDATE bank.card_3ds_challenges SET state = 'approved' WHERE id = $1::text::uuid",
            &[&crash],
        )
        .unwrap();
    let finished = answer(&b, &card, &crash, None).ok();
    assert_eq!(s(&finished, "state"), "approved");
    assert_eq!(s(&finished, "decision"), "approved");
    let crash_auth = s(&finished, "authorizationId");
    assert_eq!(ledger.held(&crash_auth, HOLDER, "USDT"), "5");
    assert_eq!(
        s(&answer(&b, &card, &crash, None).ok(), "authorizationId"),
        crash_auth
    );
    assert_eq!(
        db.count("SELECT count(*)::int8 FROM bank.card_authorizations"),
        1
    );

    // A right code on a purchase the card then declines shows the decline, not success, and holds nothing.
    let big = uuid();
    challenge(&b, &card, &big, "3ds-over-cap", "150").unwrap();
    let code = s(&listed(&b, &card, &big), "testCode");
    let shown = answer(&b, &card, &big, Some(&code)).ok();
    assert_eq!(s(&shown, "state"), "approved");
    assert_eq!(s(&shown, "decision"), "declined");
    assert_eq!(s(&shown, "declineCode"), "bank.card_limit_exceeded");
    assert_eq!(ledger.available(HOLDER, "USDT"), "95");

    // An open challenge answered with no code refuses by name and counts nothing.
    let blank = uuid();
    challenge(&b, &card, &blank, "3ds-blank", "1").unwrap();
    assert_eq!(
        answer(&b, &card, &blank, None).code(),
        "bank.card_3ds_code_missing"
    );
    assert_eq!(s(&listed(&b, &card, &blank), "triesLeft"), "3");
    // A frozen card is not asked to confirm a purchase.
    assert_eq!(
        call(
            &b,
            HOLDER,
            "cards.setStatus",
            &Json::obj([
                ("cardId", Json::str(&card)),
                ("status", Json::str("frozen"))
            ])
        )
        .code(),
        "ok"
    );
    assert_eq!(
        code_of(challenge(&b, &card, &uuid(), "3ds-frozen", "1")),
        "bank.card_not_active"
    );

    // The owner has not set the count: answering refuses by name, and nothing is counted.
    let unset = bank(&db, secrets(), None);
    let card2 = issue(&unset, HOLDER, "100");
    let open2 = uuid();
    challenge(&unset, &card2, &open2, "3ds-unset", "5").unwrap();
    assert_eq!(
        answer(&unset, &card2, &open2, Some("000000")).code(),
        "bank.card_3ds_try_limit_unset"
    );
    let first = arr(&challenges(&unset, HOLDER, &card2).ok(), "challenges")[0].clone();
    assert_eq!(
        (s(&first, "state"), s(&first, "triesLeft")),
        ("open".to_owned(), "null".to_owned())
    );

    // card-sim without the TEST secrets switch has no partner to send a code: the issuer's request refuses by name.
    let plain = bank(&db, PartnerTerms::nothing_reported(), Some(3));
    let card3 = issue(&plain, HOLDER, "100");
    assert_eq!(
        code_of(challenge(&plain, &card3, &uuid(), "3ds-none", "5")),
        "bank.card_3ds_issuer_unset"
    );
}

#[test]
fn reports_fraud_on_a_card_payment_the_card_freezes_one_case_opens_per_payment_and_another_person_cannot_report_it()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, secrets(), Some(3));
    let card = issue(&b, HOLDER, "100");
    let paid = authorize(&db, &card, "fraud-1", "4", None);
    let report = |card: &str, auth: &str| {
        call(
            &b,
            HOLDER,
            "cards.fraud.report",
            &Json::obj([
                ("cardId", Json::str(card)),
                ("authorizationId", Json::str(auth)),
            ]),
        )
    };
    let reports = |card: &str| {
        arr(
            &call(
                &b,
                HOLDER,
                "cards.fraud.list",
                &Json::obj([("cardId", Json::str(card))]),
            )
            .ok(),
            "reports",
        )
    };

    let first = report(&card, &paid).ok();
    assert_eq!(s(&first, "cardId"), card);
    assert_eq!(s(&first, "authorizationId"), paid);
    assert_eq!(s(&first, "state"), "open");
    let status = |id: &str| -> String {
        db.client()
            .query_one(
                "SELECT status::text, frozen_by FROM bank.cards WHERE id = $1::text::uuid",
                &[&id],
            )
            .map(|r| {
                format!(
                    "{}/{}",
                    r.get::<_, String>(0),
                    r.get::<_, Option<String>>(1).unwrap_or_default()
                )
            })
            .unwrap()
    };
    assert_eq!(status(&card), "frozen/owner");
    // The same payment again is the same case.
    assert_eq!(s(&report(&card, &paid).ok(), "id"), s(&first, "id"));
    assert_eq!(reports(&card).len(), 1);
    // Nothing moved: no settlement, no other authorisation.
    assert_eq!(
        db.count("SELECT count(*)::int8 FROM bank.card_settlements"),
        0
    );
    // A frozen card declines the next purchase, and a declined payment is not reported.
    let declined = authorize(&db, &card, "fraud-2", "1", Some("bank.card_not_active"));
    assert_eq!(
        report(&card, &declined).code(),
        "bank.card_authorization_declined"
    );
    assert_eq!(reports(&card).len(), 1);
    // Unfrozen and reported again: the same case, and the card frozen again.
    assert_eq!(
        call(
            &b,
            HOLDER,
            "cards.setStatus",
            &Json::obj([
                ("cardId", Json::str(&card)),
                ("status", Json::str("active"))
            ])
        )
        .code(),
        "ok"
    );
    assert_eq!(s(&report(&card, &paid).ok(), "id"), s(&first, "id"));
    assert_eq!(status(&card), "frozen/owner");

    // A payment on another card is not this card's to report.
    let other = issue(&b, HOLDER, "100");
    assert_eq!(
        report(&other, &paid).code(),
        "bank.card_authorization_not_found"
    );
    // Another person's card is not found.
    let stranger = issue(&b, STRANGER, "100");
    assert_eq!(report(&stranger, &paid).code(), "bank.card_not_found");
    assert_eq!(
        challenges(&b, HOLDER, &stranger).code(),
        "bank.card_not_found"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The cardholder disputes their own charge (card-disputes.money.test.ts, J-bank-15)

fn form(b: &Bank, user: &str, card: &str, reference: &str) -> Answer {
    call(
        b,
        user,
        "cards.disputes.form",
        &Json::obj([
            ("cardId", Json::str(card)),
            ("authorizationRef", Json::str(reference)),
        ]),
    )
}

fn file(b: &Bank, user: &str, card: &str, reference: &str, amount: &str, reason: &str) -> Answer {
    call(
        b,
        user,
        "cards.disputes.open",
        &Json::obj([
            ("cardId", Json::str(card)),
            ("authorizationRef", Json::str(reference)),
            ("amount", Json::str(amount)),
            ("reason", Json::str(reason)),
        ]),
    )
}

fn evidence(b: &Bank, user: &str, id: &str, words: &str) -> Answer {
    call(
        b,
        user,
        "cards.disputes.evidence",
        &Json::obj([
            ("disputeId", Json::str(id)),
            ("description", Json::str(words)),
        ]),
    )
}

fn withdraw(b: &Bank, user: &str, id: &str, reason: &str) -> Answer {
    call(
        b,
        user,
        "cards.disputes.withdraw",
        &Json::obj([("disputeId", Json::str(id)), ("reason", Json::str(reason))]),
    )
}

fn ledger_untouched(db: &TestDb) {
    // svc-bank holds no balance: a dispute writes no hold, capture or transfer of its own.
    assert_eq!(
        db.count(
            "SELECT count(*)::int8 FROM bank.card_settlements WHERE ledger_tx_id <> 'TEST-capture'"
        ),
        0
    );
    assert_eq!(
        db.count("SELECT count(*)::int8 FROM bank.personal_transfers"),
        0
    );
}

#[test]
fn names_where_a_charge_stands_under_the_partner_rules_and_refuses_by_name_when_the_partner_reported_none()
 {
    let Some(db) = db() else { return };
    let silent_bank = bank(&db, silent(), None);
    let (user, card, reference) = captured(&silent_bank, &db, "25");
    let unset = form(&silent_bank, &user, &card, &reference).ok();
    assert_eq!(s(&unset, "rules"), "null");
    assert_eq!(s(&unset, "standing"), "rules_unset");
    assert_eq!(s(&unset, "deadline"), "null");
    assert_eq!(
        file(&silent_bank, &user, &card, &reference, "10", "TEST").code(),
        "bank.card_dispute_rules_unset"
    );

    let b = bank(&db, rules(false), None);
    let f = form(&b, &user, &card, &reference).ok();
    assert_eq!(s(&f, "test"), "true");
    assert_eq!(
        f.get("rules").unwrap().compact(),
        r#"{"windowDays":120,"evidenceAfterSubmission":false}"#
    );
    let charge = f.get("charge").unwrap().clone();
    assert_eq!(s(&charge, "authorizationRef"), reference);
    assert_eq!(s(&charge, "assetId"), "USDT");
    assert_eq!(s(&charge, "captured"), "25");
    assert_eq!(s(&charge, "disputable"), "25");
    assert_eq!(s(&f, "standing"), "disputable");
    assert_eq!(s(&f, "disputeId"), "null");
    let settled = service_kit::time::js_date(&s(&charge, "settledAt")).unwrap();
    let deadline = service_kit::time::js_date(&s(&f, "deadline")).unwrap();
    assert_eq!(deadline.0 - settled.0, 120 * 86_400_000);

    // Past the window: named, and filing refuses.
    let late = Instant(deadline.0 + 1000);
    b.door.cards_deps(late, |d| {
        assert_eq!(
            disputes::form(d, &card, &reference).unwrap().standing,
            "window_closed"
        );
        assert_eq!(
            code_of(disputes::cardholder_open(
                d, &user, &card, &reference, "10", "TEST"
            )),
            "bank.card_dispute_not_disputable"
        );
    });

    // A declined payment, and one authorised but not captured, are named and refused.
    let declined = format!("auth-{}", uuid());
    authorize(
        &db,
        &card,
        &declined,
        "600",
        Some("bank.card_limit_exceeded"),
    );
    assert_eq!(
        s(&form(&b, &user, &card, &declined).ok(), "standing"),
        "declined"
    );
    let pending = format!("auth-{}", uuid());
    authorize(&db, &card, &pending, "5", None);
    assert_eq!(
        s(&form(&b, &user, &card, &pending).ok(), "standing"),
        "not_settled"
    );
    let refused = file(&b, &user, &card, &pending, "5", "TEST");
    assert_eq!(refused.code(), "bank.card_dispute_not_disputable");
    assert_eq!(
        form(&b, &user, &card, &format!("auth-{}", uuid())).code(),
        "bank.card_dispute_not_found"
    );
    // Another person's card is the guard's refusal, before anything is read.
    assert_eq!(form(&b, STRANGER, &card, &reference).code(), "FORBIDDEN");
    assert_eq!(
        file(&b, STRANGER, &card, &reference, "10", "TEST").code(),
        "FORBIDDEN"
    );
}

#[test]
fn files_a_partial_dispute_once_a_retry_is_the_same_case_other_figures_or_more_than_was_charged_refuse_and_nothing_posts()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, rules(false), None);
    let (user, card, reference) = captured(&b, &db, "25");
    assert_eq!(
        file(&b, &user, &card, &reference, "25.01", "TEST: charged twice").code(),
        "bank.card_dispute_not_disputable"
    );
    let c = file(&b, &user, &card, &reference, "10", "TEST: charged twice").ok();
    assert_eq!(s(&c, "state"), "opened");
    assert_eq!(s(&c, "amount"), "10");
    assert_eq!(s(&c, "reason"), "TEST: charged twice");
    assert_eq!(s(&c, "test"), "true");
    let events = arr(&c, "events");
    assert_eq!(events.len(), 1);
    assert_eq!(s(&events[0], "kind"), "opened");
    assert_eq!(s(&events[0], "by"), "you");
    assert_eq!(s(&events[0], "detail"), "TEST: charged twice");
    let id = s(&c, "id");
    assert_eq!(
        db.client()
            .query_one(
                "SELECT user_id::text FROM bank.card_disputes WHERE id = $1::text::uuid",
                &[&id]
            )
            .unwrap()
            .get::<_, String>(0),
        user
    );
    assert_eq!(
        s(
            &file(&b, &user, &card, &reference, "10", "TEST: charged twice").ok(),
            "id"
        ),
        id
    );
    assert_eq!(
        file(&b, &user, &card, &reference, "11", "TEST: charged twice").code(),
        "bank.card_dispute_invalid"
    );
    let f = form(&b, &user, &card, &reference).ok();
    assert_eq!(
        (s(&f, "standing"), s(&f, "disputeId")),
        ("already_disputed".to_owned(), id.clone())
    );
    let listed = items(
        &call(
            &b,
            &user,
            "cards.disputes.list",
            &Json::obj([("cardId", Json::str(&card))]),
        )
        .ok(),
    );
    assert_eq!(listed.len(), 1);
    assert_eq!(s(&listed[0], "id"), id);
    assert!(listed[0].get("events").is_none());
    b.door.cards_deps(now(), |d| {
        assert!(
            disputes::cardholder_list(d, &uuid(), &card)
                .unwrap()
                .is_empty()
        );
    });
    assert_eq!(
        call(
            &b,
            &uuid(),
            "cards.disputes.get",
            &Json::obj([("disputeId", Json::str(&id))])
        )
        .code(),
        "bank.card_dispute_not_found"
    );
    assert_eq!(
        s(
            &call(
                &b,
                &user,
                "cards.disputes.get",
                &Json::obj([("disputeId", Json::str(&id))])
            )
            .ok(),
            "id"
        ),
        id
    );
    ledger_untouched(&db);
}

#[test]
fn two_opens_of_the_same_case_at_once_are_one_case() {
    let Some(db) = db() else { return };
    let b = bank(&db, rules(false), None);
    let (user, card, reference) = captured(&b, &db, "25");
    let (one, two) = std::thread::scope(|sc| {
        let a = sc.spawn(|| file(&b, &user, &card, &reference, "25", "TEST"));
        let c = sc.spawn(|| file(&b, &user, &card, &reference, "25", "TEST"));
        (a.join().unwrap().ok(), c.join().unwrap().ok())
    });
    assert_eq!(s(&one, "id"), s(&two, "id"));
    assert_eq!(db.count("SELECT count(*)::int8 FROM bank.card_disputes"), 1);
    assert_eq!(
        db.count("SELECT count(*)::int8 FROM bank.card_dispute_events"),
        1
    );
}

#[test]
fn takes_evidence_while_open_after_the_representment_only_where_the_partner_rules_say() {
    let Some(db) = db() else { return };
    let b = bank(&db, rules(false), None);
    let (user, card, reference) = captured(&b, &db, "25");
    let id = s(&file(&b, &user, &card, &reference, "10", "TEST").ok(), "id");
    let one = evidence(&b, &user, &id, "TEST: my bank statement").ok();
    // The same words are the same step.
    let twice = evidence(&b, &user, &id, "TEST: my bank statement").ok();
    assert_eq!(
        arr(&twice, "events")
            .iter()
            .filter(|e| s(e, "kind") == "evidence")
            .count(),
        1
    );
    let last = arr(&one, "events").last().unwrap().clone();
    assert_eq!(s(&last, "kind"), "evidence");
    assert_eq!(s(&last, "by"), "you");
    assert_eq!(s(&last, "afterSubmission"), "false");
    assert_eq!(
        evidence(&b, &uuid(), &id, "TEST: my bank statement").code(),
        "bank.card_dispute_not_found"
    );
    // Support submits the representment (`ops.cardDisputeRepresent`, slice `card-ops`): the case's state and its line.
    db.client()
        .batch_execute(&format!(
            "UPDATE bank.card_disputes SET state = 'representment' WHERE id = '{id}'; \
             INSERT INTO bank.card_dispute_events (dispute_id, sequence, kind, from_state, to_state, actor, detail, event_key) \
             VALUES ('{id}', 3, 'representment', 'opened', 'representment', '{OPERATOR}', 'TEST', 'step:rep-{id}')"
        ))
        .unwrap();
    assert_eq!(
        evidence(&b, &user, &id, "TEST: later").code(),
        "bank.card_dispute_evidence_closed"
    );
    let after = bank(&db, rules(true), None);
    let later = evidence(&after, &user, &id, "TEST: later").ok();
    let last = arr(&later, "events").last().unwrap().clone();
    assert_eq!(s(&last, "kind"), "evidence");
    assert_eq!(s(&last, "afterSubmission"), "true");
    // Support's line reads as support's, its words kept from the cardholder.
    let rep = arr(&later, "events")
        .into_iter()
        .find(|e| s(e, "kind") == "representment")
        .unwrap();
    assert_eq!(
        (s(&rep, "by"), s(&rep, "detail")),
        ("support".to_owned(), "null".to_owned())
    );
}

#[test]
fn a_decision_carries_its_reason_withdrawing_reverses_the_partner_credit_once_as_the_partner_reports_and_posts_nothing()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, rules(false), None);
    let (user, card, reference) = captured(&b, &db, "25");
    let balances = |u: &str| b.door.cards().issuer.cardholder_balances(u).unwrap();
    let before = balances(&user);
    let id = s(&file(&b, &user, &card, &reference, "10", "TEST").ok(), "id");
    // Support grants the partner's provisional credit (`ops.cardDisputeCredit`, slice `card-ops`): the TEST partner
    // credits its cardholder under the case's credit key, and the case records its answer.
    let credit_key = format!("card-dispute-credit:{id}");
    let (partner_ref, credited) = b
        .door
        .cards()
        .issuer
        .provisional_credit(&credit_key, &user, "USDT", "10")
        .unwrap();
    db.client()
        .execute(
            "UPDATE bank.card_disputes SET credit_requested_at = now(), credit_amount = $2::text::numeric, \
                    credit_partner_ref = $3, credited_at = now() WHERE id = $1::text::uuid",
            &[&id, &credited, &partner_ref],
        )
        .unwrap();
    assert_eq!(
        balances(&user),
        Some(vec![("USDT".to_owned(), "40".to_owned())])
    );
    assert_eq!(
        withdraw(&b, &uuid(), &id, "TEST").code(),
        "bank.card_dispute_not_found"
    );
    let w = withdraw(&b, &user, &id, "TEST: the merchant paid me back").ok();
    assert_eq!(s(&w, "state"), "closed");
    let decision = w.get("decision").unwrap().clone();
    assert_eq!(s(&decision, "outcome"), "withdrawn");
    assert_eq!(s(&decision, "reason"), "TEST: the merchant paid me back");
    assert_eq!(s(&decision, "creditSettlement"), "reversed");
    assert_ne!(s(&decision, "creditSettlementPartnerRef"), "null");
    assert_eq!(
        db.client()
            .query_one(
                "SELECT loss_status FROM bank.card_disputes WHERE id = $1::text::uuid",
                &[&id]
            )
            .unwrap()
            .get::<_, String>(0),
        "not_known"
    );
    let closed = arr(&w, "events").last().unwrap().clone();
    assert_eq!(s(&closed, "kind"), "closed");
    assert_eq!(
        s(&closed, "detail"),
        format!(
            "Withdrawn by the cardholder: TEST: the merchant paid me back; who bears the fraud loss is not known; \
             the partner's provisional credit is reversed, reference {}",
            s(&decision, "creditSettlementPartnerRef")
        )
    );
    assert_eq!(balances(&user), before);
    // Withdrawn again: the case as it is, its first reason kept.
    let again = withdraw(&b, &user, &id, "TEST: again").ok();
    assert_eq!(
        s(again.get("decision").unwrap(), "reason"),
        "TEST: the merchant paid me back"
    );
    assert_eq!(
        evidence(&b, &user, &id, "TEST").code(),
        "bank.card_dispute_state"
    );
    ledger_untouched(&db);

    // Support decides for the merchant (`ops.cardDisputeDecide`, slice `card-ops`, through the shared `close`).
    let (user2, card2, reference2) = captured(&b, &db, "25");
    let id2 = s(
        &file(&b, &user2, &card2, &reference2, "25", "TEST").ok(),
        "id",
    );
    b.door.cards_deps(now(), |d| {
        disputes::close(
            d,
            &id2,
            "merchant",
            OPERATOR,
            Some("TEST: the merchant showed delivery"),
        )
        .unwrap();
    });
    let won = call(
        &b,
        &user2,
        "cards.disputes.get",
        &Json::obj([("disputeId", Json::str(&id2))]),
    )
    .ok();
    let decision = won.get("decision").unwrap().clone();
    assert_eq!(s(&decision, "outcome"), "merchant");
    assert_eq!(s(&decision, "reason"), "TEST: the merchant showed delivery");
    assert_eq!(s(&decision, "creditSettlement"), "null");
    let last = arr(&won, "events").last().unwrap().clone();
    assert_eq!(
        (s(&last, "by"), s(&last, "detail")),
        ("support".to_owned(), "null".to_owned())
    );
    ledger_untouched(&db);
}
