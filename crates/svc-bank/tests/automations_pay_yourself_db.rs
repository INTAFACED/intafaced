//! Part `pay_yourself` of slice `automations` against the Rust door on a real Postgres, with the TEST partner bank, its
//! TEST pay-in rail on a stand-in TEST chain, and a stand-in for svc-trade's realised read.
//!
//! Ports the checks of `pay-yourself/test-pay-in.test.ts` that fall on this part's calls, each named after the
//! TypeScript test's words: the pay-in's credits as `payYourself.summary` shows them ("gives each person their own
//! address, credits a transfer once after its confirmations...", "holds a pay-in pending while the partner holds its
//! answer..."), and "the weekly rule day" as `payYourself.setRule` sets `nextRunAt` (its table is also
//! `src/automations/pay_yourself/mod.rs`' unit test). Left: "refuses a TEST chain off loopback" and "reads token units
//! exactly", which fall on the rail's own construction, the partner slice's (`src/partner/pay_in.rs`' unit tests hold
//! them); the TypeScript's `payInCredited` (a card partner's spendable) is the cards slice's.
//!
//! The TypeScript has no other pay-yourself test. The rest of this file holds what the service does on each branch
//! (every refusal of `record` and `setRule`, the once-per-key record, the rule's run and its job door), named for what it
//! checks. The invariant: nothing here moves money; the ledger is a stand-in that counts every ask (none).
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

use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, zod_datetime};
use svc_bank::automations::Wiring as AutomationsWiring;
use svc_bank::automations::pay_yourself::realised::{Read, Realised, RealisedSource};
use svc_bank::automations::pay_yourself::{self, RUN_DUE};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::pay_in::{self, CONFIRMATIONS};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, TestPartner};
use svc_bank::spaces::Wiring as SpacesWiring;
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};

use support::TestDb;

const SECRET: &str = "bank-pay-yourself-edge-secret-long-enough";
const INTERNAL: &str = "bank-pay-yourself-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const TOKEN: &str = "0x000000000000000000000000000000000000d011";
const TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const OWNER: &str = "0x52908400098527886e0f7030069857d2e4169ee7";
const OTHER_OWNER: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

thread_local! {
    static CLOCK: Cell<i64> = const { Cell::new(0) };
}

fn clock() -> Instant {
    let at = CLOCK.with(Cell::get);
    if at == 0 {
        door::system_now()
    } else {
        Instant(at)
    }
}

fn at(iso: &str) -> Instant {
    zod_datetime(iso, true).unwrap()
}

fn set_now(iso: &str) {
    CLOCK.with(|c| c.set(at(iso).0));
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: the TEST chain, svc-trade's realised read, svc-ledger, the freeze.

#[derive(Default)]
struct ChainState {
    head: u64,
    logs: Vec<Json>,
}

/// The TEST chain as `test-pay-in.test.ts`' `chain()` gives it: a head, and ERC-20 transfer logs of the TEST token.
#[derive(Clone)]
struct Chain(Arc<Mutex<ChainState>>);

impl Chain {
    fn new() -> Chain {
        Chain(Arc::new(Mutex::new(ChainState {
            head: 10,
            logs: Vec::new(),
        })))
    }
    fn mine(&self, n: u64) {
        self.0.lock().unwrap().head += n;
    }
    fn transfer(&self, to: &str, units: u128, tx: &str, from: &str) {
        let mut s = self.0.lock().unwrap();
        s.head += 1;
        let pad = |a: &str| Json::str(format!("0x{}{}", "0".repeat(24), &a[2..]));
        let log = Json::obj([
            ("transactionHash", Json::str(tx)),
            ("logIndex", Json::str("0x0")),
            ("blockNumber", Json::str(format!("0x{:x}", s.head))),
            ("data", Json::str(format!("0x{units:x}"))),
            (
                "topics",
                Json::Array(vec![Json::str(TOPIC), pad(from), pad(to)]),
            ),
        ]);
        s.logs.push(log);
    }
}

impl Fetch for Chain {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        let body = json::parse(req.body.as_deref().unwrap()).unwrap();
        let s = self.0.lock().unwrap();
        let result = match body.get("method") {
            Some(Json::String(m)) if m == "eth_blockNumber" => Json::str(format!("0x{:x}", s.head)),
            _ => {
                let Some(Json::Array(params)) = body.get("params") else {
                    panic!("params")
                };
                let Some(Json::Array(topics)) = params[0].get("topics") else {
                    panic!("topics")
                };
                let Json::Array(to) = &topics[2] else {
                    panic!("to")
                };
                Json::Array(
                    s.logs
                        .iter()
                        .filter(|l| match l.get("topics") {
                            Some(Json::Array(t)) => to.contains(&t[2]),
                            _ => false,
                        })
                        .cloned()
                        .collect(),
                )
            }
        };
        let id = body.get("id").cloned().unwrap_or(Json::Null);
        Ok(HttpResponse {
            status: 200,
            body: Json::obj([
                ("jsonrpc", Json::str("2.0")),
                ("id", id),
                ("result", result),
            ])
            .compact(),
        })
    }
}

/// svc-trade's read: the answer a test sets, and every ask (person, since, until).
#[derive(Clone)]
struct Trade(Arc<Mutex<(Read, Vec<TradeAsk>)>>);

/// One ask of svc-trade: the person, since and until.
type TradeAsk = (String, Instant, Option<Instant>);

impl Trade {
    fn answers(&self, read: Read) {
        self.0.lock().unwrap().0 = read;
    }
    fn asked(&self) -> Vec<TradeAsk> {
        self.0.lock().unwrap().1.clone()
    }
}

fn realised(amount: &str, accounts: &[(&str, &str)]) -> Read {
    Read::Realised(Realised {
        venue_id: "test-venue".to_owned(),
        as_of: at("2026-11-20T00:00:00Z"),
        realised: amt(amount),
        accounts: accounts
            .iter()
            .map(|(o, a)| ((*o).to_owned(), amt(a)))
            .collect(),
    })
}

impl RealisedSource for Trade {
    fn realised(
        &self,
        user_id: &str,
        asset: &str,
        since: Instant,
        until: Option<Instant>,
    ) -> Result<Read, Refusal> {
        assert_eq!(asset, "USDC");
        let mut s = self.0.lock().unwrap();
        s.1.push((user_id.to_owned(), since, until));
        Ok(s.0.clone())
    }
}

/// svc-ledger: refuses everything, and counts what it was asked (paying yourself asks it nothing).
#[derive(Clone, Default)]
struct Journal(Arc<Mutex<usize>>);

impl Journal {
    fn asked(&self) -> usize {
        *self.0.lock().unwrap()
    }
    fn bump(&self) {
        *self.0.lock().unwrap() += 1;
    }
}

impl Ledger for Journal {
    fn balance(&self, _: &LedgerAccount) -> Result<Amount, String> {
        self.bump();
        Err("no ledger".to_owned())
    }
    fn balances(&self, _: &str, _: &str) -> Result<Vec<LedgerBalance>, String> {
        self.bump();
        Err("no ledger".to_owned())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        self.bump();
        Err("no ledger".to_owned())
    }
    fn post_recipe(&self, _: &str, _: &Json, _: &str) -> Result<LedgerTx, PostFailure> {
        self.bump();
        Err(PostFailure::Unknown("no ledger".to_owned()))
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

// ---------------------------------------------------------------------------------------------------------------
// The door

struct Bank {
    door: BankDoor,
    chain: Chain,
    trade: Trade,
    ledger: Journal,
}

/// The TEST partner and, with `rail`, its TEST pay-in on the stand-in chain (chain 84532); svc-trade's read answers
/// "unread" until a test sets it.
fn bank(db: &TestDb, rail: bool) -> Bank {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let chain = Chain::new();
    let trade = Trade(Arc::new(Mutex::new((
        Read::Unread("bank.realised_unread".to_owned()),
        Vec::new(),
    ))));
    let ledger = Journal::default();
    let pay_in = pay_in::for_stack(
        rail,
        Some("http://127.0.0.1:8545"),
        Some("84532"),
        Some(TOKEN),
        Box::new(chain.clone()),
    )
    .unwrap();
    let mut automations = AutomationsWiring::none();
    automations.pay_yourself = pay_yourself::Wiring {
        realised: Some(Box::new(trade.clone())),
    };
    let door = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: clock,
        store: db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(ledger.clone()),
        ..SpacesWiring::none()
    })
    .with_automations(automations);
    Bank {
        door,
        chain,
        trade,
        ledger,
    }
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
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = service_kit::edge::sign(&raw, SECRET, "DE").unwrap();
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

#[derive(Debug, Clone, PartialEq)]
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
}

fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let mut headers = person(user);
    let (method, url, body) = match kind {
        Some(Kind::Query) if input.is_empty() => ("GET", format!("/trpc/{path}"), String::new()),
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
        "req-pay-yourself-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn summary(b: &Bank, user: &str) -> Json {
    call(b, user, "payYourself.summary", "").ok()
}

fn record(b: &Bank, user: &str, key: &str, owner: &str, nonce: &str, amount: &str) -> Answer {
    call(
        b,
        user,
        "payYourself.record",
        &format!(
            r#"{{"moveKey":"{key}","owner":"{owner}","nonce":"{nonce}","amount":"{amount}"}}"#
        ),
    )
}

fn set_rule(b: &Bank, user: &str, weekday: &str, cap: &str) -> Answer {
    call(
        b,
        user,
        "payYourself.setRule",
        &format!(r#"{{"weekday":"{weekday}","cap":"{cap}"}}"#),
    )
}

/// `POST /internal/jobs/pay-yourself/run-due`, signed as `signed_as` (or not at all).
fn run_due(b: &Bank, signed_as: Option<&str>, body: &str) -> (u16, Json) {
    let mut headers = signed_as.map_or_else(Vec::new, |s| {
        s2s::legacy_headers(s, INTERNAL, body, clock().0.div_euclid(1000)).unwrap()
    });
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = b.door.handle_from(
        &Request {
            method: "POST",
            url: RUN_DUE,
            headers: &headers,
            body,
        },
        "req-pay-yourself-job",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn poll(b: &Bank) {
    let w = b.door.partner();
    w.pay_in
        .as_ref()
        .unwrap()
        .poll(w.partner.as_ref().unwrap(), clock)
        .unwrap();
}

/// The partner's main USDC figure for the person.
fn partner_usdc(b: &Bank, user: &str) -> Option<Amount> {
    b.door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .report(&AccountRef::main(user, "USDC"), Instant(0))
        .amount
}

fn field(j: &Json, k: &str) -> Json {
    j.get(k).cloned().unwrap_or(Json::Null)
}

fn credits(b: &Bank, user: &str) -> Vec<Json> {
    match field(&summary(b, user), "credits") {
        Json::Array(c) => c,
        other => panic!("{other:?}"),
    }
}

/// Each credit's `[status, amount, confirmations]`.
fn credit_rows(b: &Bank, user: &str) -> Vec<(Json, Json, Json)> {
    credits(b, user)
        .iter()
        .map(|c| {
            (
                field(c, "status"),
                field(c, "amount"),
                field(c, "confirmations"),
            )
        })
        .collect()
}

fn moves(db: &TestDb, user: &str) -> Vec<(String, String, String, String)> {
    db.client()
        .query(
            "SELECT move_key, source, status, amount::numeric(38,2)::text FROM bank.pay_yourself_moves \
             WHERE user_id = $1 ORDER BY prepared_at, move_key",
            &[&user],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect()
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

// ---------------------------------------------------------------------------------------------------------------
// test-pay-in.test.ts: "the TEST partner pay-in" (J-bank-31 #4 #6), as `payYourself.summary` shows it

#[test]
fn gives_each_person_their_own_address_credits_a_transfer_once_after_its_confirmations_and_counts_only_what_it_credited()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, true);
    let route = field(&summary(&b, ADA), "payIn");
    let Json::String(address) = field(&route, "address") else {
        panic!("{route:?}")
    };
    assert_eq!(address, pay_in::address(ADA));
    assert_ne!(address, pay_in::address(BOB));
    assert_eq!(field(&route, "label"), Json::str("TEST"));
    assert_eq!(field(&route, "chainId"), Json::int(84532));
    assert_eq!(field(&route, "token"), Json::str(TOKEN));
    assert_eq!(field(&route, "tokenDecimals"), Json::int(6));
    assert_eq!(field(&route, "asset"), Json::str("USDC"));
    assert_eq!(field(&route, "confirmations"), Json::int(12));
    poll(&b);
    b.chain.transfer(
        &address,
        298_750_000,
        "0xaaa",
        "0x52908400098527886E0F7030069857D2E4169EE7",
    );
    poll(&b);
    assert_eq!(
        credit_rows(&b, ADA),
        vec![(Json::str("pending"), Json::str("298.75"), Json::int(1))]
    );
    // The sender, as the transfer log names it, lowercase.
    assert_eq!(field(&credits(&b, ADA)[0], "from"), Json::str(OWNER));
    assert_eq!(partner_usdc(&b, ADA), Some(0));
    // One short of its confirmations: still pending, not counted.
    b.chain.mine(CONFIRMATIONS - 2);
    poll(&b);
    assert_eq!(
        credit_rows(&b, ADA),
        vec![(
            Json::str("pending"),
            Json::str("298.75"),
            Json::int(i64::try_from(CONFIRMATIONS - 1).unwrap())
        )]
    );
    assert_eq!(partner_usdc(&b, ADA), Some(0));
    b.chain.mine(1);
    poll(&b);
    poll(&b);
    let credit = credits(&b, ADA)[0].clone();
    assert_eq!(field(&credit, "status"), Json::str("available"));
    assert_eq!(
        field(&credit, "key"),
        Json::str("bank.pay-in:usdc:84532:0xaaa:0")
    );
    assert!(matches!(field(&credit, "availableAt"), Json::String(_)));
    // Credited once, on the partner's own book, to the main USDC balance.
    poll(&b);
    assert_eq!(partner_usdc(&b, ADA), Some(amt("298.75")));
    assert_eq!(credits(&b, BOB), Vec::new());
    assert_eq!(b.ledger.asked(), 0);
}

#[test]
fn holds_a_pay_in_pending_while_the_partner_holds_its_answer_and_credits_it_once_the_switch_goes_back()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, true);
    let Json::String(address) = field(&field(&summary(&b, ADA), "payIn"), "address") else {
        panic!("address")
    };
    assert_eq!(
        call(&b, ADA, "testPartner.set", r#"{"payIn":"held"}"#).0,
        200
    );
    poll(&b);
    b.chain.transfer(&address, 5_000_000, "0xbbb", OTHER_OWNER);
    b.chain.mine(CONFIRMATIONS);
    poll(&b);
    let held = |b: &Bank| {
        credits(b, ADA)
            .iter()
            .map(|c| (field(c, "status"), field(c, "held")))
            .collect::<Vec<_>>()
    };
    assert_eq!(held(&b), vec![(Json::str("pending"), Json::Bool(true))]);
    assert_eq!(partner_usdc(&b, ADA), Some(0));
    assert_eq!(
        call(&b, ADA, "testPartner.set", r#"{"payIn":"answered"}"#).0,
        200
    );
    poll(&b);
    assert_eq!(held(&b), vec![(Json::str("available"), Json::Bool(false))]);
    assert_eq!(partner_usdc(&b, ADA), Some(amt("5")));
}

// test-pay-in.test.ts: "the weekly rule day", as `payYourself.setRule` sets the rule's next run

#[test]
fn is_the_start_of_the_next_such_day_strictly_after_now() {
    let Some(db) = db() else { return };
    let b = bank(&db, true);
    // 17 Nov 2026 is a Tuesday.
    set_now("2026-11-17T10:00:00Z");
    let r = set_rule(&b, ADA, "friday", "100").ok();
    assert_eq!(
        field(&r, "nextRunAt"),
        Json::str("2026-11-20T00:00:00.000Z")
    );
    let r = set_rule(&b, ADA, "tuesday", "100").ok();
    assert_eq!(
        field(&r, "nextRunAt"),
        Json::str("2026-11-24T00:00:00.000Z")
    );
    set_now("2026-11-20T00:00:00Z");
    let r = set_rule(&b, ADA, "friday", "100").ok();
    assert_eq!(
        field(&r, "nextRunAt"),
        Json::str("2026-11-27T00:00:00.000Z")
    );
    // Set again, it is changed, never a second rule.
    assert_eq!(field(&r, "weekday"), Json::str("friday"));
    assert_eq!(db.count("SELECT count(*) FROM bank.pay_yourself_rules"), 1);
}

// ---------------------------------------------------------------------------------------------------------------
// What the service does on each branch (no TypeScript test)

#[test]
fn with_no_pay_in_every_write_refuses_pay_in_unset_and_the_summary_says_so_and_never_reads_a_failed_read_as_zero()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, false);
    assert_eq!(
        record(&b, ADA, "pay-yourself:manual:m1", OWNER, "1", "10").code(),
        "bank.pay_in_unset"
    );
    assert_eq!(
        set_rule(&b, ADA, "friday", "100").code(),
        "bank.pay_in_unset"
    );
    let s = summary(&b, ADA);
    assert_eq!(
        field(&s, "payIn"),
        Json::obj([("unset", Json::str("bank.pay_in_unset"))])
    );
    assert_eq!(
        field(&s, "realised"),
        Json::obj([("unread", Json::str("bank.realised_unread"))])
    );
    assert_eq!(field(&s, "partnerFee"), Json::str("0"));
    assert_eq!(field(&s, "moves"), Json::Array(Vec::new()));
    assert_eq!(field(&s, "credits"), Json::Array(Vec::new()));
    assert_eq!(field(&s, "rule"), Json::Null);
    // The partner's fee switch `unknown`: not known, never 0.
    assert_eq!(
        call(&b, ADA, "testPartner.set", r#"{"fee":"unknown"}"#).0,
        200
    );
    assert_eq!(field(&summary(&b, ADA), "partnerFee"), Json::Null);
    assert_eq!(
        db.count("SELECT count(*) FROM bank.pay_yourself_moves")
            + db.count("SELECT count(*) FROM bank.pay_yourself_rules"),
        0
    );
}

#[test]
fn a_signed_move_is_recorded_once_by_its_key_and_other_facts_under_the_key_are_a_conflict() {
    let Some(db) = db() else { return };
    let b = bank(&db, true);
    set_now("2026-11-18T09:00:00Z");
    let key = "pay-yourself:manual:ada-1";
    let first = record(
        &b,
        ADA,
        key,
        &OWNER.to_uppercase().replace("0X", "0x"),
        "17",
        "250.5",
    )
    .ok();
    assert_eq!(field(&first, "status"), Json::str("sent"));
    assert_eq!(field(&first, "source"), Json::str("manual"));
    assert_eq!(field(&first, "owner"), Json::str(OWNER));
    assert_eq!(field(&first, "venueNonce"), Json::str("17"));
    assert_eq!(field(&first, "amount"), Json::str("250.5"));
    assert_eq!(field(&first, "assetId"), Json::str("USDC"));
    assert_eq!(
        field(&first, "sentAt"),
        Json::str("2026-11-18T09:00:00.000Z")
    );
    assert_eq!(field(&first, "windowFrom"), Json::Null);
    // The same facts again: the same move.
    assert_eq!(record(&b, ADA, key, OWNER, "17", "250.50").ok(), first);
    for (user, owner, nonce, amount) in [
        (ADA, OWNER, "17", "250"),
        (ADA, OTHER_OWNER, "17", "250.5"),
        (ADA, OWNER, "18", "250.5"),
        (BOB, OWNER, "17", "250.5"),
    ] {
        assert_eq!(
            record(&b, user, key, owner, nonce, amount).code(),
            "bank.pay_yourself_conflict"
        );
    }
    // A key nobody prepared, that is not the person's own manual one.
    assert_eq!(
        record(&b, ADA, "pay-yourself:rule:nobody:1", OWNER, "1", "1").code(),
        "bank.pay_yourself_move_not_found"
    );
    // Not a move: a key out of shape, a nonce out of shape, nothing to move.
    for (key, nonce, amount) in [
        ("not-pay-yourself:manual:1", "1", "1"),
        ("pay-yourself:manual:2", "a.b", "1"),
        ("pay-yourself:manual:3", "1", "0"),
    ] {
        assert_eq!(
            record(&b, ADA, key, OWNER, nonce, amount).code(),
            "bank.validation_failed"
        );
    }
    assert_eq!(
        moves(&db, ADA),
        vec![(
            key.to_owned(),
            "manual".to_owned(),
            "sent".to_owned(),
            "250.50".to_owned()
        )]
    );
    // The summary shows it, and counts what was realised from when it was sent.
    b.trade.answers(realised("40", &[(OWNER, "40")]));
    set_now("2026-11-19T09:00:00Z");
    let s = summary(&b, ADA);
    assert_eq!(field(&s, "moves"), Json::Array(vec![first]));
    assert_eq!(
        field(&s, "realised"),
        Json::obj([
            ("since", Json::str("2026-11-18T09:00:00.000Z")),
            ("asOf", Json::str("2026-11-20T00:00:00.000Z")),
            ("amount", Json::str("40")),
            ("owner", Json::str(OWNER)),
        ])
    );
    assert_eq!(
        b.trade.asked().last().cloned(),
        Some((ADA.to_owned(), at("2026-11-18T09:00:00Z"), None))
    );
    assert_eq!(b.ledger.asked(), 0);
}

#[test]
fn a_due_rule_prepares_one_move_for_the_weeks_profit_less_what_was_paid_up_to_its_cap_and_its_signature_marks_it_sent()
 {
    let Some(db) = db() else { return };
    let b = bank(&db, true);
    set_now("2026-11-17T10:00:00Z");
    let rule = set_rule(&b, ADA, "friday", "100").ok();
    let Json::String(rule_id) = field(&rule, "id") else {
        panic!("id")
    };
    // Paid 30 by hand this week; the venue reports 180 realised, most on OWNER's account.
    set_now("2026-11-18T10:00:00Z");
    assert_eq!(
        record(&b, ADA, "pay-yourself:manual:w1", OWNER, "1", "30").code(),
        "ok"
    );
    b.trade
        .answers(realised("180", &[(OTHER_OWNER, "20"), (OWNER, "160")]));
    // Before its day nothing is due.
    set_now("2026-11-19T23:59:59Z");
    assert_eq!(
        run_due(&b, Some("svc-bank"), r#"{"limit":10}"#),
        (
            200,
            json::parse(r#"{"prepared":0,"nothing":0,"unread":0}"#).unwrap()
        )
    );
    set_now("2026-11-20T00:00:00Z");
    assert_eq!(
        run_due(&b, Some("svc-bank"), r#"{"limit":10}"#),
        (
            200,
            json::parse(r#"{"prepared":1,"nothing":0,"unread":0}"#).unwrap()
        )
    );
    // The window is from when the rule was set to now.
    assert_eq!(
        b.trade.asked().last().cloned(),
        Some((
            ADA.to_owned(),
            at("2026-11-17T10:00:00Z"),
            Some(at("2026-11-20T00:00:00Z"))
        ))
    );
    let key = format!(
        "pay-yourself:rule:{rule_id}:{}",
        at("2026-11-20T00:00:00Z").0
    );
    // min(cap 100, 180 - 30) = 100.
    assert_eq!(
        moves(&db, ADA)[1],
        (
            key.clone(),
            "rule".to_owned(),
            "prepared".to_owned(),
            "100.00".to_owned()
        )
    );
    let s = summary(&b, ADA);
    let Json::Array(listed) = field(&s, "moves") else {
        panic!("moves")
    };
    let prepared = &listed[0];
    assert_eq!(field(prepared, "owner"), Json::str(OWNER));
    assert_eq!(
        field(prepared, "windowFrom"),
        Json::str("2026-11-17T10:00:00.000Z")
    );
    assert_eq!(
        field(prepared, "windowTo"),
        Json::str("2026-11-20T00:00:00.000Z")
    );
    assert_eq!(field(prepared, "sentAt"), Json::Null);
    let r = field(&s, "rule");
    assert_eq!(
        field(&r, "lastRunAt"),
        Json::str("2026-11-20T00:00:00.000Z")
    );
    assert_eq!(
        field(&r, "nextRunAt"),
        Json::str("2026-11-27T00:00:00.000Z")
    );
    // Run again: not due again until its next day.
    assert_eq!(
        run_due(&b, Some("svc-bank"), r#"{"limit":10}"#).1,
        json::parse(r#"{"prepared":0,"nothing":0,"unread":0}"#).unwrap()
    );
    // The person's one signature: the prepared move is marked sent, for the amount prepared only.
    set_now("2026-11-20T08:00:00Z");
    assert_eq!(
        record(&b, ADA, &key, OWNER, "2", "99").code(),
        "bank.pay_yourself_conflict"
    );
    let sent = record(&b, ADA, &key, OWNER, "2", "100").ok();
    assert_eq!(field(&sent, "status"), Json::str("sent"));
    assert_eq!(field(&sent, "source"), Json::str("rule"));
    assert_eq!(
        field(&sent, "sentAt"),
        Json::str("2026-11-20T08:00:00.000Z")
    );
    assert_eq!(record(&b, ADA, &key, OWNER, "2", "100").ok(), sent);
    assert_eq!(
        record(&b, ADA, &key, OWNER, "3", "100").code(),
        "bank.pay_yourself_conflict"
    );
    assert_eq!(b.ledger.asked(), 0);
}

#[test]
fn a_week_with_no_profit_prepares_nothing_and_a_failed_read_leaves_the_rule_due_for_the_next_pass()
{
    let Some(db) = db() else { return };
    let b = bank(&db, true);
    set_now("2026-11-17T10:00:00Z");
    assert_eq!(set_rule(&b, ADA, "friday", "100").code(), "ok");
    assert_eq!(set_rule(&b, BOB, "friday", "100").code(), "ok");
    set_now("2026-11-20T00:00:00Z");
    // svc-trade cannot be read: nothing prepared, both rules still due.
    b.trade.answers(Read::Unread("trade.venue_down".to_owned()));
    assert_eq!(
        run_due(&b, Some("svc-bank"), r#"{"limit":10}"#).1,
        json::parse(r#"{"prepared":0,"nothing":0,"unread":2}"#).unwrap()
    );
    assert_eq!(
        db.count(
            "SELECT count(*) FROM bank.pay_yourself_rules WHERE last_run_at IS NULL AND next_run_at = '2026-11-20T00:00:00Z'"
        ),
        2
    );
    // A loss: nothing prepared, the rule moves on to its next day. The batch is the body's limit.
    b.trade.answers(realised("-5", &[(OWNER, "-5")]));
    assert_eq!(
        run_due(&b, Some("svc-bank"), r#"{"limit":1}"#).1,
        json::parse(r#"{"prepared":0,"nothing":1,"unread":0}"#).unwrap()
    );
    assert_eq!(
        run_due(&b, Some("svc-bank"), r#"{"limit":1}"#).1,
        json::parse(r#"{"prepared":0,"nothing":1,"unread":0}"#).unwrap()
    );
    assert_eq!(db.count("SELECT count(*) FROM bank.pay_yourself_moves"), 0);
}

#[test]
fn the_job_door_refuses_an_unsigned_caller_then_a_body_not_in_shape() {
    let Some(db) = db() else { return };
    let b = bank(&db, true);
    let (status, body) = run_due(&b, None, r#"{"limit":10}"#);
    assert_eq!(status, 401);
    assert_eq!(field(&body, "code"), Json::str("bank.unauthenticated"));
    for bad in [
        "{}",
        r#"{"limit":0}"#,
        r#"{"limit":501}"#,
        r#"{"limit":2.5}"#,
        r#"{"limit":1,"x":1}"#,
    ] {
        let (status, body) = run_due(&b, Some("svc-bank"), bad);
        assert_eq!(status, 400, "{bad}");
        assert_eq!(
            body,
            json::parse(r#"{"error":"body not in shape","code":"bank.validation_failed"}"#)
                .unwrap()
        );
    }
    // svc-edge never runs a job.
    assert_eq!(run_due(&b, Some("svc-edge"), r#"{"limit":10}"#).0, 401);
}
