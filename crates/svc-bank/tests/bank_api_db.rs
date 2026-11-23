//! Slice `bank-api` against the Rust door on a real Postgres. Ports `developer-api/bank-api.db.test.ts` (J-bank-24 through the
//! real router, BK-bdev-01, BK-bdev-02), each test named after the TypeScript test's words: accounts with the partner's
//! figures and a typed filter, a locked pot refusing a move, a move on the partner's quote made once per dedupe id and
//! retried after a lost answer on the same key, a payment out refused `rail.bank` with its intent row kept and then made once per
//! idempotency key, and each reported state change one signed webhook delivery while a replayed report delivers
//! nothing. Every call enters through the door, as the TypeScript's enter through the router; the TEST partner's book is
//! read for what it holds, and the ledger stand-in counts every post, of which there must be none.
//!
//! The receiver is a loopback HTTP server (the dev/test hatch, `allow_local_http`). The TypeScript's `bank.bankApi.drain()` is
//! the slice's own `drain`, given the dependencies the door gives it. Without `TEST_DATABASE_URL` each test skips; with
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
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::Amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::bank_api::{self, signature};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::TestPartner;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};

use support::TestDb;

const SECRET: &str = "a-bank-api-db-edge-secret-long-enough-0000";
const INTERNAL: &str = "a-bank-api-db-internal-secret-long-enough";
const OWNER: &str = "00000000-0000-4000-8000-000000000001";
const MEMBER: &str = "00000000-0000-4000-8000-000000000002";
const RECIPIENT: &str =
    r#"{"name":"TEST Supplier Inc","accountNumber":"000123456789","routingNumber":"021000021"}"#;

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: a ledger that holds nothing and counts every post, the directory, the freeze, the receiver.

#[derive(Clone, Default)]
struct NoBook {
    posts: Arc<AtomicUsize>,
}

impl Ledger for NoBook {
    fn balance(&self, _: &LedgerAccount) -> Result<Amount, String> {
        Ok(0)
    }
    fn balances(&self, _: &str, _: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("no registry".to_owned())
    }
    fn post_recipe(&self, _: &str, _: &Json, _: &str) -> Result<LedgerTx, PostFailure> {
        self.posts.fetch_add(1, Ordering::SeqCst);
        Err(PostFailure::Unknown(
            "the bank API posts nothing".to_owned(),
        ))
    }
}

struct People;

impl Directory for People {
    fn handles_of(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok([(OWNER, "owner"), (MEMBER, "member")]
            .into_iter()
            .filter(|(id, _)| ids.iter().any(|i| i == id))
            .map(|(id, h)| (id.to_owned(), h.to_owned()))
            .collect())
    }
    fn find_active(&self, q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        Ok([(OWNER, "owner"), (MEMBER, "member")]
            .into_iter()
            .find(|(_, h)| match q {
                Lookup::Handle(x) => h.eq_ignore_ascii_case(x),
                Lookup::Email(e) => format!("{h}@example.test").eq_ignore_ascii_case(e),
            })
            .map(|(id, h)| (id.to_owned(), h.to_owned())))
    }
}

struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

/// One post the receiver took: its headers (lowercased names) and body.
#[derive(Debug, Clone)]
struct Post {
    headers: BTreeMap<String, String>,
    raw: String,
}

/// The webhook receiver: answers every post with `status` and keeps it.
struct Hook {
    url: String,
    status: Arc<AtomicU16>,
    posts: Arc<Mutex<Vec<Post>>>,
}

fn hook() -> Hook {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let status = Arc::new(AtomicU16::new(200));
    let posts = Arc::new(Mutex::new(Vec::new()));
    let (s, p) = (status.clone(), posts.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head, body) = loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break (String::new(), String::new()),
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let len = head
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if body.len() >= len {
                        break (head.to_owned(), body.to_owned());
                    }
                }
            };
            let headers = head
                .lines()
                .skip(1)
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
                .collect();
            p.lock().unwrap().push(Post { headers, raw: body });
            let code = s.load(Ordering::SeqCst);
            let _ = write!(
                stream,
                "HTTP/1.1 {code} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
        }
    });
    Hook {
        url: format!("http://127.0.0.1:{port}/hooks"),
        status,
        posts,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door and its calls

struct Bank {
    door: BankDoor,
    ledger: NoBook,
}

fn bank(db: &TestDb) -> Bank {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let ledger = NoBook::default();
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
    .with_partner(PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(People),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("10".to_owned()),
            unlock_wait_hours: Some("24".to_owned()),
        },
        terms: Terms {
            invite_minutes: Some("10".to_owned()),
            people_cap: Some("5".to_owned()),
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables::default(),
    })
    .with_bank_api(bank_api::Wiring::new(true));
    Bank { door, ledger }
}

/// The person signed in with a second factor (`trade:withdraw`), or, `key`, an API key: never more than bank:read and
/// bank:write.
fn person(user: &str, key: bool) -> Vec<(String, String)> {
    let mut scopes = vec![Json::str("bank:read"), Json::str("bank:write")];
    if !key {
        scopes.push(Json::str("trade:withdraw"));
    }
    let raw = Json::obj([
        ("sub", Json::str(user)),
        ("scopes", Json::Array(scopes)),
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
    /// The refusal's own code (`cause.code`).
    fn code(&self) -> String {
        match (
            self.0,
            self.1
                .get("error")
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("cause"))
                .and_then(|c| c.get("code")),
        ) {
            (200, _) => "ok".to_owned(),
            (_, Some(Json::String(c))) => c.clone(),
            (status, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
}

fn call_as(b: &Bank, user: &str, key: bool, path: &str, input: &str) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let mut headers = person(user, key);
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
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-bank-api-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    call_as(b, user, false, path, input)
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn items(j: &Json) -> Vec<Json> {
    match j.get("items") {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("no items: {other:?}"),
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

/// The partner's moves under one key.
fn moves_under(b: &Bank, user: &str, key: &str) -> usize {
    let partner = b.door.partner().partner.as_ref().unwrap();
    partner
        .lock()
        .record(user)
        .moves
        .iter()
        .filter(|m| m.key == key)
        .count()
}

fn posts(b: &Bank) -> usize {
    b.ledger.posts.load(Ordering::SeqCst)
}

/// `bank.bankApi.drain()`.
fn drain(b: &Bank) {
    b.door
        .bank_api_deps(b.door.now(), |d| bank_api::drain(d, bank_api::DRAIN_BATCH))
        .unwrap();
}

struct Started {
    main: Json,
    savings: String,
    joint: String,
    locked: String,
}

/// The owner's EUR money at the TEST partner: TEST 100 in the main balance, a savings pot, a pot shared with the
/// member, a locked pot.
fn start(b: &Bank) -> Started {
    call(b, OWNER, "testPartner.set", r#"{"custody":"off"}"#).ok();
    call(b, MEMBER, "testPartner.set", r#"{"custody":"off"}"#).ok();
    call(
        b,
        OWNER,
        "testPartner.fund",
        &format!(
            r#"{{"fundId":"fund-{}","assetId":"EUR","amount":"100"}}"#,
            uuid()
        ),
    )
    .ok();
    let create = |name: &str, extra: &str| {
        text(
            &call(
                b,
                OWNER,
                "spaces.create",
                &format!(r#"{{"assetId":"EUR","name":"{name}"{extra}}}"#),
            )
            .ok(),
            "id",
        )
    };
    let savings = create("TEST Savings", "");
    let joint = create("TEST Household", "");
    let until = service_kit::time::Instant(door::system_now().0 + 7 * 86_400_000).iso();
    let locked = create("TEST Locked", &format!(r#","lockedUntil":"{until}""#));
    let invite = call(
        b,
        OWNER,
        "sharedPots.invite",
        &format!(
            r#"{{"inviteId":"{}","spaceId":"{joint}","handle":"member","role":"contributor"}}"#,
            uuid()
        ),
    )
    .ok();
    call(
        b,
        MEMBER,
        "sharedPots.accept",
        &format!(r#"{{"inviteId":"{}"}}"#, text(&invite, "inviteId")),
    )
    .ok();
    let accounts = items(&call(b, OWNER, "bankApi.accounts", r#"{"limit":50}"#).ok());
    let main = accounts
        .into_iter()
        .find(|a| text(a, "type") == "standard")
        .unwrap();
    Started {
        main,
        savings,
        joint,
        locked,
    }
}

fn pay(b: &Bank, user: &str, key: &str, from: &str, method: &str, amount: &str) -> Answer {
    call(
        b,
        user,
        "bankApi.createPayment",
        &format!(
            r#"{{"idempotencyKey":"{key}","fromAccountId":"{from}","method":"{method}","recipient":{RECIPIENT},"amount":"{amount}"}}"#
        ),
    )
}

fn quote(b: &Bank, user: &str, from: &str, to: &str, amount: &str) -> Answer {
    call(
        b,
        user,
        "bankApi.quoteMove",
        &format!(r#"{{"fromAccountId":"{from}","toAccountId":"{to}","amount":"{amount}"}}"#),
    )
}

fn make_move(b: &Bank, user: &str, quote_id: &str, dedupe: &str) -> Answer {
    call(
        b,
        user,
        "bankApi.move",
        &format!(r#"{{"quoteId":"{quote_id}","dedupeId":"{dedupe}"}}"#),
    )
}

fn accounts_of(b: &Bank, user: &str, kind: &str) -> Vec<Json> {
    items(
        &call(
            b,
            user,
            "bankApi.accounts",
            &format!(r#"{{"type":"{kind}","limit":50}}"#),
        )
        .ok(),
    )
}

// ---------------------------------------------------------------------------------------------------------------

#[test]
fn lists_accounts_with_the_partner_figures_and_a_typed_filter_joint_only_for_the_joint_filter_spend_today_as_decimal_strings()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let s = start(&b);
    let all = items(&call(&b, OWNER, "bankApi.accounts", r#"{"limit":50}"#).ok());
    let mut named: Vec<(String, String)> = all
        .iter()
        .map(|a| (text(a, "name"), text(a, "type")))
        .collect();
    named.sort();
    assert_eq!(
        named,
        [
            ("Main", "standard"),
            ("TEST Household", "joint"),
            ("TEST Locked", "savings"),
            ("TEST Savings", "savings"),
        ]
        .map(|(n, t)| (n.to_owned(), t.to_owned()))
    );
    assert_eq!(
        ["balance", "figure", "heldAt", "spendToday", "locked"].map(|k| text(&s.main, k)),
        ["100", "known", "TEST partner bank", "0", "false"]
    );
    let locked = all.iter().find(|a| text(a, "id") == s.locked).unwrap();
    assert_eq!(text(locked, "locked"), "true");
    assert_ne!(text(locked, "lockedUntil"), "null");

    // TEST 12.5 leaves the main balance as a payment: spend-today on the partner's record.
    call(&b, OWNER, "testPartner.set", r#"{"bankRail":"test"}"#).ok();
    pay(
        &b,
        OWNER,
        "jb24-spend-1",
        &text(&s.main, "id"),
        "instant",
        "12.5",
    )
    .ok();
    let joints = accounts_of(&b, OWNER, "joint");
    assert_eq!(joints.len(), 1);
    assert_eq!(
        ["id", "type", "owner", "balance", "spendToday"].map(|k| text(&joints[0], k)),
        [s.joint.as_str(), "joint", "self", "0", "0"]
    );
    let standard = accounts_of(&b, OWNER, "standard");
    assert_eq!(standard.len(), 1);
    assert_eq!(
        ["id", "balance", "spendToday"].map(|k| text(&standard[0], k)),
        [text(&s.main, "id").as_str(), "87.5", "12.5"]
    );
    for a in &all {
        assert!(matches!(a.get("spendToday"), Some(Json::String(_))));
    }
    // The member sees the pot shared with them as a joint account, the owner's.
    let theirs = accounts_of(&b, MEMBER, "joint");
    assert_eq!(theirs.len(), 1);
    assert_eq!(
        [text(&theirs[0], "id"), text(&theirs[0], "owner")],
        [s.joint.clone(), "other".to_owned()]
    );
    assert!(!s.savings.is_empty());
    assert_eq!(posts(&b), 0);
}

#[test]
fn a_locked_pot_refuses_a_move_a_move_on_a_quote_is_one_partner_move_per_dedupe_id_the_same_reply_twice()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let s = start(&b);
    let main = text(&s.main, "id");
    assert_eq!(
        quote(&b, OWNER, &s.locked, &main, "1").code(),
        "bank.space_locked"
    );

    let q = quote(&b, OWNER, &main, &s.savings, "25").ok();
    assert_eq!(
        ["amount", "fee", "receives", "assetId", "heldAt"].map(|k| text(&q, k)),
        ["25", "0", "25", "EUR", "TEST partner bank"]
    );
    let qid = text(&q, "quoteId");
    let once = make_move(&b, OWNER, &qid, "jb24-move-1").ok();
    let twice = make_move(&b, OWNER, &qid, "jb24-move-1").ok();
    assert_eq!(text(&once, "state"), "completed");
    assert_eq!(text(once.get("quote").unwrap(), "quoteId"), qid);
    assert_eq!(twice, once);
    assert_eq!(
        moves_under(&b, OWNER, &format!("bank.api.move:{OWNER}:jb24-move-1")),
        1
    );
    let savings = accounts_of(&b, OWNER, "savings");
    let pot = savings.iter().find(|a| text(a, "id") == s.savings).unwrap();
    assert_eq!(text(pot, "balance"), "25");

    // The same dedupe id on another quote is a different instruction.
    let q2 = text(&quote(&b, OWNER, &main, &s.savings, "5").ok(), "quoteId");
    assert_eq!(
        make_move(&b, OWNER, &q2, "jb24-move-1").code(),
        "bank.idempotency_conflict"
    );

    // A lost answer: the row stays pending, and the retry under the same id makes the move once.
    call(&b, OWNER, "testPartner.set", r#"{"nextReply":"lost"}"#).ok();
    assert_eq!(
        make_move(&b, OWNER, &q2, "jb24-move-2").code(),
        "bank.partner_reply_lost"
    );
    assert_eq!(
        text(&make_move(&b, OWNER, &q2, "jb24-move-2").ok(), "state"),
        "completed"
    );
    assert_eq!(
        moves_under(&b, OWNER, &format!("bank.api.move:{OWNER}:jb24-move-2")),
        1
    );

    // An expired quote and an unknown fee are refused by name, with nothing moved.
    db.client()
        .execute(
            "UPDATE bank.api_move_quotes SET valid_until = now() - interval '1 second' WHERE quote_id = $1",
            &[&q2],
        )
        .unwrap();
    assert_eq!(
        make_move(&b, OWNER, &q2, "jb24-move-3").code(),
        "bank.quote_expired"
    );
    call(&b, OWNER, "testPartner.set", r#"{"fee":"unknown"}"#).ok();
    let q3 = quote(&b, OWNER, &main, &s.savings, "5").ok();
    assert_eq!([text(&q3, "fee"), text(&q3, "receives")], ["null", "null"]);
    assert_eq!(
        make_move(&b, OWNER, &text(&q3, "quoteId"), "jb24-move-4").code(),
        "bank.partner_fee_unknown"
    );
    // Only a shared pot's owner takes money out of it.
    let joint = accounts_of(&b, MEMBER, "joint").remove(0);
    assert_eq!(
        quote(&b, MEMBER, &text(&joint, "id"), &main, "1").code(),
        "bank.space_forbidden"
    );
    assert_eq!(posts(&b), 0);
}

#[test]
fn concurrent_first_calls_with_one_dedupe_id_are_one_move_row_and_one_partner_move_and_every_call_gets_the_move()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let s = start(&b);
    let main = text(&s.main, "id");
    // Each call carries the same dedupe id, so the row's partner_key (its second unique key) is the same too. A loser
    // of the insert race must read the row that won, never fail on partner_key.
    for round in 0..25 {
        let qid = text(&quote(&b, OWNER, &main, &s.savings, "1").ok(), "quoteId");
        let dedupe = format!("jb24-move-race-{round}");
        let moves: Vec<Json> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| make_move(&b, OWNER, &qid, &dedupe).ok()))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(
            moves
                .iter()
                .all(|m| text(m, "state") == "completed" && text(m, "dedupeId") == dedupe)
        );
        let mut ids: Vec<String> = moves.iter().map(|m| text(m, "partnerMoveId")).collect();
        ids.dedup();
        assert_eq!(ids.len(), 1, "{ids:?}");
        assert_eq!(
            moves_under(&b, OWNER, &format!("bank.api.move:{OWNER}:{dedupe}")),
            1
        );
    }
    assert_eq!(
        db.count("SELECT count(*) FROM (SELECT dedupe_id FROM bank.api_moves GROUP BY dedupe_id HAVING count(*) = 1) x"),
        25
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.api_moves"), 25);
    let pot = accounts_of(&b, OWNER, "savings")
        .into_iter()
        .find(|a| text(a, "id") == s.savings)
        .unwrap();
    assert_eq!(text(&pot, "balance"), "25");
    assert_eq!(posts(&b), 0);
}

#[test]
fn a_payment_with_no_rail_is_refused_rail_bank_with_its_intent_row_kept_with_the_rail_instant_and_ach_are_each_one_partner_payment()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let s = start(&b);
    let main = text(&s.main, "id");
    // An API key never sends money off the platform: a payment out takes the person's own session after its second
    // factor.
    let by_key = call_as(
        &b,
        OWNER,
        true,
        "bankApi.createPayment",
        &format!(
            r#"{{"idempotencyKey":"jb24-pay-key","fromAccountId":"{main}","method":"ach","recipient":{RECIPIENT},"amount":"10"}}"#
        ),
    );
    assert_eq!(by_key.code(), "scope.denied");
    assert!(items(&call(&b, OWNER, "bankApi.payments", r#"{"limit":10}"#).ok()).is_empty());
    assert_eq!(
        pay(&b, OWNER, "jb24-pay-none", &main, "instant", "10").code(),
        "rail.bank"
    );
    assert_eq!(
        pay(&b, OWNER, "jb24-pay-none", &main, "instant", "10").code(),
        "rail.bank"
    );
    let kept = items(&call(&b, OWNER, "bankApi.payments", r#"{"limit":10}"#).ok());
    assert_eq!(kept.len(), 1);
    assert_eq!(
        ["idempotencyKey", "state", "refusalCode"].map(|k| text(&kept[0], k)),
        ["jb24-pay-none", "refused", "rail.bank"]
    );

    call(&b, OWNER, "testPartner.set", r#"{"bankRail":"test"}"#).ok();
    let instant = pay(&b, OWNER, "jb24-pay-instant", &main, "instant", "10").ok();
    let ach = pay(&b, OWNER, "jb24-pay-ach", &main, "ach", "10").ok();
    assert_eq!(
        ["method", "state", "version", "heldAt"].map(|k| text(&instant, k)),
        ["instant", "pending", "1", "TEST partner bank"]
    );
    assert_eq!(
        ["method", "state", "version"].map(|k| text(&ach, k)),
        ["ach", "pending", "1"]
    );
    assert_eq!(
        text(
            &pay(&b, OWNER, "jb24-pay-ach", &main, "ach", "10").ok(),
            "id"
        ),
        text(&ach, "id")
    );
    assert_eq!(
        pay(&b, OWNER, "jb24-pay-ach", &main, "ach", "11").code(),
        "bank.idempotency_conflict"
    );
    let partner = b.door.partner().partner.as_ref().unwrap();
    let paid = partner
        .lock()
        .record(OWNER)
        .moves
        .iter()
        .filter(|m| m.key.starts_with(&format!("pay:{OWNER}:")))
        .count();
    assert_eq!(paid, 2);
    assert_eq!(
        text(&accounts_of(&b, OWNER, "standard")[0], "balance"),
        "80"
    );
    assert_eq!(posts(&b), 0);
}

#[test]
fn concurrent_first_calls_with_one_idempotency_key_are_one_payment_row_and_every_call_gets_its_answer()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let s = start(&b);
    let main = text(&s.main, "id");
    // Each call carries the same key, so the row's partner_key (its second unique key) is the same too. A loser of the
    // insert race must read the row that won, never fail on partner_key.
    for round in 0..25 {
        let key = format!("jb24-pay-race-{round}");
        let codes: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| pay(&b, OWNER, &key, &main, "instant", "10").code()))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(codes, vec!["rail.bank".to_owned(); 8]);
    }
    assert_eq!(db.count("SELECT count(*) FROM bank.api_payments"), 25);
    assert_eq!(
        db.count("SELECT count(DISTINCT idempotency_key) FROM bank.api_payments"),
        25
    );

    call(&b, OWNER, "testPartner.set", r#"{"bankRail":"test"}"#).ok();
    let made: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    text(
                        &pay(&b, OWNER, "jb24-pay-race-rail", &main, "instant", "10").ok(),
                        "id",
                    )
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut ids = made.clone();
    ids.dedup();
    assert_eq!(ids.len(), 1, "{made:?}");
    assert_eq!(
        moves_under(&b, OWNER, &format!("pay:{OWNER}:jb24-pay-race-rail")),
        1
    );
    assert_eq!(
        text(&accounts_of(&b, OWNER, "standard")[0], "balance"),
        "90"
    );
    assert_eq!(posts(&b), 0);
}

#[test]
fn each_reported_state_change_is_one_signed_delivery_with_the_previous_and_current_state_a_replayed_report_delivers_nothing()
 {
    let Some(db) = db() else { return };
    let b = bank(&db);
    let receiver = hook();
    let s = start(&b);
    let main = text(&s.main, "id");
    let made = call(
        &b,
        OWNER,
        "bankApi.createWebhook",
        &format!(r#"{{"endpointId":"{}","url":"{}"}}"#, uuid(), receiver.url),
    )
    .ok();
    let secret = text(&made, "secret");
    assert!(
        secret.starts_with("whsec_")
            && secret.len() == 6 + 64
            && secret[6..]
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "{secret}"
    );
    let again = call(
        &b,
        OWNER,
        "bankApi.createWebhook",
        &format!(
            r#"{{"endpointId":"{}","url":"{}"}}"#,
            text(&made, "id"),
            receiver.url
        ),
    )
    .ok();
    assert_eq!(text(&again, "secret"), "null");
    assert_eq!(
        call(
            &b,
            OWNER,
            "bankApi.createWebhook",
            &format!(
                r#"{{"endpointId":"{}","url":"http://10.0.0.5/hooks"}}"#,
                uuid()
            ),
        )
        .code(),
        "bank.webhook_url_invalid"
    );

    call(&b, OWNER, "testPartner.set", r#"{"bankRail":"test"}"#).ok();
    let p = pay(&b, OWNER, "jb24-hook-1", &main, "ach", "3").ok();
    let pid = text(&p, "id");
    let settle = format!(r#"{{"paymentId":"{pid}"}}"#);
    let settled = call(&b, OWNER, "testPartner.settlePayment", &settle).ok();
    assert_eq!(
        ["state", "version", "recorded"].map(|k| text(&settled, k)),
        ["completed", "2", "true"]
    );
    let replay = call(&b, OWNER, "testPartner.settlePayment", &settle).ok();
    assert_eq!(
        ["state", "version", "recorded"].map(|k| text(&replay, k)),
        ["completed", "2", "false"]
    );
    drain(&b);

    let got = receiver.posts.lock().unwrap().clone();
    let changed: Vec<Json> = got
        .iter()
        .map(|p| json::parse(&p.raw).unwrap())
        .filter(|j| text(j, "transferId") == pid && text(j, "version") == "2")
        .collect();
    assert_eq!(changed.len(), 1);
    assert_eq!(
        ["previousState", "currentState", "amount"].map(|k| text(&changed[0], k)),
        ["pending", "completed", "3"]
    );
    let post = got
        .iter()
        .find(|p| text(&json::parse(&p.raw).unwrap(), "version") == "2")
        .unwrap();
    let expected = signature(&secret, &post.headers["x-intafaced-timestamp"], &post.raw);
    assert_eq!(
        post.headers["x-intafaced-signature"],
        format!("v1={expected}")
    );
    assert_eq!(
        post.headers["x-intafaced-event-id"],
        format!("bank.transfer.state_changed:{pid}:2")
    );
    let log = items(
        &call(
            &b,
            OWNER,
            "bankApi.deliveries",
            &format!(r#"{{"paymentId":"{pid}","limit":10}}"#),
        )
        .ok(),
    );
    let seen: Vec<[String; 4]> = log
        .iter()
        .map(|d| ["previous", "current", "state", "attempts"].map(|k| text(d, k)))
        .collect();
    assert_eq!(
        seen,
        [
            ["pending", "completed", "delivered", "1"],
            ["null", "pending", "delivered", "1"]
        ]
        .map(|r| r.map(str::to_owned))
    );
    assert_eq!(
        text(
            &call(
                &b,
                OWNER,
                "bankApi.payment",
                &format!(r#"{{"paymentId":"{pid}"}}"#)
            )
            .ok(),
            "state"
        ),
        "completed"
    );

    // An endpoint that does not take a delivery: the attempt is kept with its answer.
    receiver.status.store(500, Ordering::SeqCst);
    let second = text(
        &pay(&b, OWNER, "jb24-hook-2", &main, "instant", "1").ok(),
        "id",
    );
    drain(&b);
    let log = items(
        &call(
            &b,
            OWNER,
            "bankApi.deliveries",
            &format!(r#"{{"paymentId":"{second}","limit":10}}"#),
        )
        .ok(),
    );
    assert_eq!(log.len(), 1);
    assert_eq!(
        ["current", "state", "attempts", "lastStatus"].map(|k| text(&log[0], k)),
        ["pending", "failed", "1", "500"]
    );
    assert_eq!(posts(&b), 0);
}
