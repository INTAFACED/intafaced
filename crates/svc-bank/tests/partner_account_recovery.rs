//! Recovery claims through the Rust door against a real Postgres: the checks of the TypeScript's
//! `recovery/recovery-claims.db.test.ts`, each test named after its words. The heir lists the accounts identity says
//! they may claim, opens a claim and executes it; identity's verdict decides. svc-ledger is a memory book that posts a
//! `bankTransfer` once per business key, as `MemoryLedger` does. The Rust bank has no ledger post door yet, so the
//! door built from the environment answers a sweep "not ported"; these hand in a ledger that posts. TEST data only.
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::refuse;
use svc_bank::partner_account::Wiring;
use svc_bank::partner_account::recovery::identity::{
    Estate, IdentityRecovery, Unconfigured, Verdict,
};
use svc_bank::partner_account::recovery::ledger::{
    AccountRef, Balance, BankTransfer, Ledger, PostError,
};
use svc_bank::partner_account::recovery::{self, recovery_claim_id, recovery_claim_message};

use support::TestDb;

const SECRET: &str = "a-bank-recovery-claims-edge-secret-long-0";
const OWNER: &str = "71111111-1111-4111-8111-111111111111";
const HEIR: &str = "72222222-2222-4222-8222-222222222222";
const STRANGER: &str = "73333333-3333-4333-8333-333333333333";
const NOTICE: &str = "74444444-4444-4444-8444-444444444444";
const OTHER_NOTICE: &str = "76666666-6666-4666-8666-666666666666";
const SUB: &str = "78888888-8888-4888-8888-888888888888";
const SIGNATURES: &str = r#"[{"publicKey":{"kty":"EC","crv":"P-256","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"},"signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]"#;

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

/// What the memory ledger does to the next recovery post.
#[derive(Default)]
struct Faults {
    /// Post, then lose the answer (`ledger.writes_blocked_store_unavailable`), this many times.
    fail_next: usize,
    /// Refuse every recovery post `ledger.invalid_entry`.
    refuse: bool,
    /// Move 25 out of this pot to its owner just before the pot's own sweep posts, once.
    drain: Option<(String, String)>,
}

#[derive(Default)]
struct BookState {
    accounts: BTreeMap<String, (AccountRef, Amount)>,
    keys: BTreeMap<String, String>,
    faults: Faults,
}

/// `MemoryLedger`: balances per account, one transaction per idempotency key.
#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

fn account(
    owner_type: &str,
    owner_id: &str,
    asset: &str,
    kind: &str,
    purpose: Option<&str>,
) -> AccountRef {
    AccountRef {
        owner_type: owner_type.into(),
        owner_id: owner_id.into(),
        asset_id: asset.into(),
        kind: kind.into(),
        purpose: purpose.map(str::to_owned),
    }
}

fn user(owner: &str, asset: &str) -> AccountRef {
    account("user", owner, asset, "available", None)
}

fn pot_account(pot: &str, asset: &str) -> AccountRef {
    account("subaccount", pot, asset, "available", None)
}

impl BookState {
    fn add(&mut self, a: &AccountRef, n: Amount) {
        let row = self
            .accounts
            .entry(a.key())
            .or_insert_with(|| (a.clone(), Amount::ZERO));
        row.1 += n;
    }
    fn balance(&self, a: &AccountRef) -> Amount {
        self.accounts.get(&a.key()).map_or(Amount::ZERO, |r| r.1)
    }
    fn shift(&mut self, from: &AccountRef, to: &AccountRef, n: Amount) {
        self.add(from, -n);
        self.add(to, n);
    }
}

impl Book {
    /// `recipes.deposit`: the house's side is not an owner's, so only the person's account is kept.
    fn fund(&self, owner: &str, asset: &str, amount: &str) {
        self.0.lock().unwrap().add(&user(owner, asset), amt(amount));
    }
    fn shift(&self, from: &AccountRef, to: &AccountRef, amount: &str) {
        self.0.lock().unwrap().shift(from, to, amt(amount));
    }
    fn bal(&self, a: &AccountRef) -> String {
        format_amount(self.0.lock().unwrap().balance(a))
    }
    fn has_key(&self, key: &str) -> bool {
        self.0.lock().unwrap().keys.contains_key(key)
    }
    fn faults(&self, f: impl FnOnce(&mut Faults)) {
        f(&mut self.0.lock().unwrap().faults);
    }
}

impl Ledger for Book {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<Balance>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .accounts
            .values()
            .filter(|(a, _)| a.owner_type == owner_type && a.owner_id == owner_id)
            .map(|(a, n)| Balance {
                account: a.clone(),
                amount: *n,
            })
            .collect())
    }

    fn posts(&self) -> bool {
        true
    }

    fn bank_transfer(&self, t: &BankTransfer) -> Result<String, PostError> {
        let mut s = self.0.lock().unwrap();
        let key = format!(
            "bank.transfer.{}:{}:{}",
            t.key_space, t.transfer_id, t.occurrence
        );
        if s.faults.refuse {
            return Err(PostError::Ledger {
                code: "ledger.invalid_entry".into(),
                message: "TEST asset not listed".into(),
            });
        }
        if let Some((pot, owner)) = s.faults.drain.clone()
            && key.contains(&pot)
        {
            s.faults.drain = None;
            s.shift(&pot_account(&pot, "USDT"), &user(&owner, "USDT"), amt("25"));
        }
        if let Some(tx) = s.keys.get(&key) {
            return Ok(tx.clone());
        }
        if s.balance(&t.from) < t.amount {
            return Err(PostError::Ledger {
                code: "ledger.insufficient_funds".into(),
                message: "insufficient funds".into(),
            });
        }
        s.shift(&t.from, &t.to, t.amount);
        let tx = format!("tx-{}", s.keys.len() + 1);
        s.keys.insert(key, tx.clone());
        if s.faults.fail_next > 0 {
            // The ledger committed, then the answer was lost.
            s.faults.fail_next -= 1;
            return Err(PostError::Ledger {
                code: "ledger.writes_blocked_store_unavailable".into(),
                message: "ledger writes are blocked: ledger.writes_blocked_store_unavailable"
                    .into(),
            });
        }
        Ok(tx)
    }
}

#[derive(Clone)]
enum Answer {
    Ok(String),
    Refused(&'static str),
    Down,
}

/// `memoryIdentityRecovery`: the estates per heir, and the verdict a test sets.
#[derive(Clone)]
struct Identity {
    estates: BTreeMap<String, Vec<Estate>>,
    answer: Arc<Mutex<Answer>>,
    asked: Arc<Mutex<Vec<Json>>>,
}

fn estate(notice: &str) -> Estate {
    Estate {
        user_id: OWNER.into(),
        handle: "owner_test".into(),
        notice_id: notice.into(),
        threshold: 1,
        live_keys: 1,
    }
}

impl Identity {
    fn new(estates: &[(&str, &str)]) -> Identity {
        let mut map: BTreeMap<String, Vec<Estate>> = BTreeMap::new();
        for (heir, notice) in estates {
            map.entry((*heir).into()).or_default().push(estate(notice));
        }
        Identity {
            estates: map,
            answer: Arc::new(Mutex::new(Answer::Ok(NOTICE.into()))),
            asked: Arc::new(Mutex::new(Vec::new())),
        }
    }
    fn answer(&self, a: Answer) {
        *self.answer.lock().unwrap() = a;
    }
}

fn down() -> Refusal {
    refuse(
        "bank.recovery_unavailable",
        "Recovery claims could not be checked: identity answered 503",
    )
}

impl IdentityRecovery for Identity {
    fn estates(&self, heir: &str) -> Result<Vec<Estate>, Refusal> {
        if matches!(*self.answer.lock().unwrap(), Answer::Down) {
            return Err(down());
        }
        Ok(self.estates.get(heir).cloned().unwrap_or_default())
    }

    fn verify(&self, request: &Json) -> Result<Verdict, Refusal> {
        self.asked.lock().unwrap().push(request.clone());
        match self.answer.lock().unwrap().clone() {
            Answer::Ok(notice) => Ok(Verdict::Ok { notice_id: notice }),
            Answer::Refused(code) => Ok(Verdict::Refused { code: code.into() }),
            Answer::Down => Err(down()),
        }
    }
}

fn env() -> BTreeMap<String, String> {
    [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn door_with(db: &TestDb, identity: Box<dyn IdentityRecovery>, ledger: &Book) -> BankDoor {
    let mut wiring = Wiring::from_env(&env()).unwrap();
    wiring.recovery = recovery::Wiring {
        identity,
        ledger: Box::new(ledger.clone()),
    };
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: None,
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env: env(),
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner_account(wiring)
}

struct Mount {
    door: BankDoor,
    identity: Identity,
    ledger: Book,
}

/// `mount()`: the heir may claim the owner's account under the notice.
fn mount(db: &TestDb, estates: &[(&str, &str)]) -> Mount {
    let identity = Identity::new(estates);
    let ledger = Book::default();
    Mount {
        door: door_with(db, Box::new(identity.clone()), &ledger),
        identity,
        ledger,
    }
}

fn principal(user: &str, scopes: &[&str], extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub".to_owned(), Json::str(user)),
        (
            "scopes".to_owned(),
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier".to_owned(), Json::str("full")),
        ("mfa".to_owned(), Json::Bool(true)),
        (
            "sid".to_owned(),
            Json::str("77777777-7777-4777-8777-777777777777"),
        ),
        ("userId".to_owned(), Json::str(user)),
        (
            "expiresAt".to_owned(),
            Json::str("2099-01-01T00:00:00.000Z"),
        ),
    ];
    for (k, v) in extra {
        fields.push(((*k).to_owned(), Json::str(*v)));
    }
    let raw = Json::Object(fields).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

const PERSON: &[&str] = &["bank:read", "bank:write"];

fn call(
    b: &BankDoor,
    method: &str,
    path: &str,
    body: &str,
    mut headers: Vec<(String, String)>,
) -> (u16, Json) {
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = b.handle_from(
        &Request {
            method,
            url: &format!("/trpc/{path}"),
            headers: &headers,
            body,
        },
        "req-recovery-claims",
        "127.0.0.1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn estates_as(b: &BankDoor, headers: Vec<(String, String)>) -> (u16, Json) {
    call(b, "GET", "recovery.estates", "", headers)
}

fn estates(b: &BankDoor, who: &str) -> Json {
    data(estates_as(b, principal(who, PERSON, &[])))
}

fn open_as(b: &BankDoor, who: &str, owner: &str) -> (u16, Json) {
    call(
        b,
        "POST",
        "recovery.claims.open",
        &format!(r#"{{"ownerUserId":"{owner}"}}"#),
        principal(who, PERSON, &[]),
    )
}

fn execute_as(b: &BankDoor, who: &str, claim: &str) -> (u16, Json) {
    call(
        b,
        "POST",
        "recovery.claims.execute",
        &format!(r#"{{"claimId":"{claim}","signatures":{SIGNATURES}}}"#),
        principal(who, PERSON, &[]),
    )
}

fn data(answer: (u16, Json)) -> Json {
    assert_eq!(answer.0, 200, "{}", answer.1.compact());
    answer
        .1
        .get("result")
        .and_then(|r| r.get("data"))
        .cloned()
        .unwrap()
}

/// `refused(code, trpc)`: the refusal's own code and its tRPC code.
fn refused(answer: &(u16, Json)) -> (String, String) {
    let d = answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .cloned()
        .unwrap_or(Json::Null);
    let text = |v: Option<&Json>| match v {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    };
    (
        text(d.get("cause").and_then(|c| c.get("code"))),
        text(d.get("code")),
    )
}

fn pair(code: &str, trpc: &str) -> (String, String) {
    (code.to_owned(), trpc.to_owned())
}

fn field(v: &Json, key: &str) -> Json {
    v.get(key).cloned().unwrap_or(Json::Null)
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key} is not text: {other:?}"),
    }
}

fn list(v: &Json, key: &str) -> Vec<Json> {
    match v.get(key) {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("{key} is not a list: {other:?}"),
    }
}

/// Each row's fields, as one compact JSON list, for comparing rows by value.
fn rows(items: &[Json], keys: &[&str]) -> Vec<String> {
    items
        .iter()
        .map(|r| Json::Array(keys.iter().map(|k| field(r, k)).collect()).compact())
        .collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// `namedPot`: the owner's main USDT space, a named space, and value moved into it from the main account.
fn named_pot(db: &TestDb, book: &Book, owner: &str, name: &str, amount: &str) -> String {
    let mut c = db.client();
    c.execute(
        "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, 'USDT', 'primary', 'Main') ON CONFLICT DO NOTHING",
        &[&owner],
    )
    .unwrap();
    let id: String = c
        .query_one(
            "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, 'USDT', 'named', $2) RETURNING id::text",
            &[&owner, &name],
        )
        .unwrap()
        .get(0);
    book.shift(&user(owner, "USDT"), &pot_account(&id, "USDT"), amount);
    id
}

fn count(db: &TestDb, sql: &str) -> i64 {
    db.count(sql)
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

fn total(book: &Book, accounts: &[AccountRef]) -> Amount {
    let s = book.0.lock().unwrap();
    accounts.iter().map(|a| s.balance(a)).sum()
}

#[test]
fn lists_only_the_accounts_identity_names_for_the_caller_with_what_a_sweep_moves() {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.fund(OWNER, "USDT", "100");
    m.ledger.fund(OWNER, "BTC", "0.5");
    let pot = named_pot(&db, &m.ledger, OWNER, "TEST Holiday", "30");

    let listed = estates(&m.door, HEIR);
    let all = list(&listed, "estates");
    assert_eq!(all.len(), 1);
    let e = &all[0];
    assert_eq!(text(e, "userId"), OWNER);
    assert_eq!(text(e, "handle"), "owner_test");
    assert_eq!(field(e, "threshold"), Json::int(1));
    assert_eq!(field(e, "liveKeys"), Json::int(1));
    assert_eq!(field(e, "claim"), Json::Null);
    assert!(list(e, "blockers").is_empty());
    let sweepable = list(e, "sweepable");
    assert_eq!(
        sorted(rows(&sweepable, &["assetId", "spaceName", "amount"])),
        sorted(vec![
            r#"["BTC",null,"0.5"]"#.to_owned(),
            r#"["USDT",null,"70"]"#.to_owned(),
            r#"["USDT","TEST Holiday","30"]"#.to_owned(),
        ])
    );
    let space = sweepable
        .iter()
        .find(|a| field(a, "spaceId") != Json::Null)
        .unwrap();
    assert_eq!(text(space, "spaceId"), pot);
    assert!(list(&estates(&m.door, STRANGER), "estates").is_empty());
}

#[test]
fn refuses_an_api_key_a_sub_account_and_staff_and_refuses_when_identity_is_unset_or_down() {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    let key = estates_as(&m.door, principal(HEIR, PERSON, &[("kid", "key-1")]));
    assert_eq!(refused(&key), pair("bank.recovery_delegated", "FORBIDDEN"));
    let sub = call(
        &m.door,
        "POST",
        "recovery.claims.open",
        &format!(r#"{{"ownerUserId":"{OWNER}"}}"#),
        principal(HEIR, PERSON, &[("sub_account", SUB)]),
    );
    assert_eq!(refused(&sub), pair("bank.recovery_delegated", "FORBIDDEN"));
    for staff in ["admin:read", "support:ops", "market:ops", "campaigns:ops"] {
        let as_staff = estates_as(
            &m.door,
            principal(HEIR, &["bank:read", "bank:write", staff], &[]),
        );
        assert_eq!(
            refused(&as_staff),
            pair("bank.recovery_staff_forbidden", "FORBIDDEN"),
            "{staff}"
        );
    }
    m.identity.answer(Answer::Down);
    assert_eq!(
        refused(&estates_as(&m.door, principal(HEIR, PERSON, &[]))),
        pair("bank.recovery_unavailable", "SERVICE_UNAVAILABLE")
    );

    let unset = door_with(&db, Box::new(Unconfigured), &Book::default());
    assert_eq!(
        refused(&estates_as(&unset, principal(HEIR, PERSON, &[]))),
        pair("bank.recovery_unavailable", "SERVICE_UNAVAILABLE")
    );
}

#[test]
fn opens_one_claim_per_account_under_the_notice_and_gives_the_text_each_key_signs_an_account_not_listed_refuses()
 {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    let opened = data(open_as(&m.door, HEIR, OWNER));
    let claim = text(&opened, "claimId");
    assert_eq!(claim, recovery_claim_id(OWNER, NOTICE));
    assert_eq!(text(&opened, "status"), "open");
    assert_eq!(field(&opened, "round"), Json::int(0));
    assert_eq!(text(&opened, "ownerUserId"), OWNER);
    assert_eq!(text(&opened, "handle"), "owner_test");
    assert_eq!(field(&opened, "threshold"), Json::int(1));
    assert_eq!(field(&opened, "liveKeys"), Json::int(1));
    assert_eq!(
        text(&opened, "message"),
        recovery_claim_message(OWNER, HEIR, &claim)
    );
    assert_eq!(text(&data(open_as(&m.door, HEIR, OWNER)), "claimId"), claim);
    assert_eq!(
        text(
            &data(open_as(&m.door, HEIR, &OWNER.to_uppercase())),
            "claimId"
        ),
        claim
    );
    assert_eq!(
        refused(&open_as(&m.door, STRANGER, OWNER)),
        pair("bank.recovery_estate_not_found", "NOT_FOUND")
    );
    assert_eq!(
        refused(&execute_as(&m.door, STRANGER, &claim)),
        pair("bank.recovery_claim_not_found", "NOT_FOUND")
    );
    assert_eq!(
        count(&db, "SELECT count(*)::bigint FROM bank.recovery_claims"),
        1
    );
}

#[test]
fn opens_racing_their_own_retry_all_answer_the_one_claim_opens_racing_under_another_notice_are_refused()
 {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE), (STRANGER, OTHER_NOTICE)]);
    let mut c = db.client();
    for _ in 0..20 {
        c.batch_execute("DELETE FROM bank.recovery_claims").unwrap();
        let same: Vec<(u16, Json)> = std::thread::scope(|s| {
            let runs: Vec<_> = (0..6)
                .map(|_| s.spawn(|| open_as(&m.door, HEIR, OWNER)))
                .collect();
            runs.into_iter().map(|r| r.join().unwrap()).collect()
        });
        for answer in same {
            assert_eq!(
                text(&data(answer), "claimId"),
                recovery_claim_id(OWNER, NOTICE)
            );
        }
        assert_eq!(
            count(&db, "SELECT count(*)::bigint FROM bank.recovery_claims"),
            1
        );
    }
    for _ in 0..20 {
        c.batch_execute("DELETE FROM bank.recovery_claims").unwrap();
        let rivals: Vec<(&str, (u16, Json))> = std::thread::scope(|s| {
            let runs: Vec<_> = (0..6)
                .map(|i| {
                    let who = if i % 2 == 0 { HEIR } else { STRANGER };
                    let door = &m.door;
                    (who, s.spawn(move || open_as(door, who, OWNER)))
                })
                .collect();
            runs.into_iter()
                .map(|(who, r)| (who, r.join().unwrap()))
                .collect()
        });
        let winner: String = c
            .query_one("SELECT heir_user_id FROM bank.recovery_claims", &[])
            .unwrap()
            .get(0);
        for (who, answer) in &rivals {
            if *who == winner {
                assert_eq!(answer.0, 200, "{}", answer.1.compact());
            } else {
                assert_eq!(
                    refused(answer),
                    pair("bank.recovery_claim_conflict", "CONFLICT")
                );
            }
        }
        assert_eq!(
            count(&db, "SELECT count(*)::bigint FROM bank.recovery_claims"),
            1
        );
    }
}

#[test]
fn identity_refusing_the_signatures_moves_nothing_and_names_identitys_code() {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.fund(OWNER, "USDT", "100");
    let claim = text(&data(open_as(&m.door, HEIR, OWNER)), "claimId");
    m.identity
        .answer(Answer::Refused("identity.recovery_signatures_short"));
    let err = execute_as(&m.door, HEIR, &claim);
    assert_eq!(
        refused(&err),
        pair("bank.recovery_claim_refused", "PRECONDITION_FAILED")
    );
    let message = text(err.1.get("error").unwrap(), "message");
    assert!(
        message.contains("identity.recovery_signatures_short"),
        "{message}"
    );
    let asked = m.identity.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(text(&asked[0], "userId"), OWNER);
    assert_eq!(text(&asked[0], "heirUserId"), HEIR);
    assert_eq!(text(&asked[0], "claimId"), claim);
    assert_eq!(
        field(&asked[0], "signatures"),
        json::parse(SIGNATURES).unwrap()
    );

    m.identity
        .answer(Answer::Ok("79999999-9999-4999-8999-999999999999".into()));
    assert_eq!(
        refused(&execute_as(&m.door, HEIR, &claim)),
        pair("bank.recovery_claim_refused", "PRECONDITION_FAILED")
    );
    assert_eq!(m.ledger.bal(&user(OWNER, "USDT")), "100");
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "0");
    assert_eq!(
        count(&db, "SELECT count(*)::bigint FROM bank.recovery_sweeps"),
        0
    );
}

#[test]
fn sweeps_every_free_balance_into_the_heir_once_a_retry_posts_nothing_later_value_goes_in_the_next_round()
 {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.fund(OWNER, "USDT", "100");
    m.ledger.fund(OWNER, "BTC", "0.5");
    m.ledger.fund(HEIR, "USDT", "5");
    let pot = named_pot(&db, &m.ledger, OWNER, "TEST Holiday", "30");
    let usdt = [
        user(OWNER, "USDT"),
        pot_account(&pot, "USDT"),
        user(HEIR, "USDT"),
    ];
    let btc = [user(OWNER, "BTC"), user(HEIR, "BTC")];
    let before = (total(&m.ledger, &usdt), total(&m.ledger, &btc));

    let claim = text(&data(open_as(&m.door, HEIR, OWNER)), "claimId");
    let done = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(field(&done, "round"), Json::int(0));
    let c = field(&done, "claim");
    assert_eq!(text(&c, "status"), "executed");
    assert_eq!(field(&c, "round"), Json::int(1));
    assert_eq!(
        sorted(rows(
            &list(&done, "sweeps"),
            &["ownerType", "assetId", "amount", "status"]
        )),
        sorted(vec![
            r#"["subaccount","USDT","30","posted"]"#.to_owned(),
            r#"["user","BTC","0.5","posted"]"#.to_owned(),
            r#"["user","USDT","70","posted"]"#.to_owned(),
        ])
    );
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "105");
    assert_eq!(m.ledger.bal(&user(HEIR, "BTC")), "0.5");
    assert_eq!(m.ledger.bal(&user(OWNER, "USDT")), "0");
    assert_eq!(m.ledger.bal(&pot_account(&pot, "USDT")), "0");
    assert_eq!((total(&m.ledger, &usdt), total(&m.ledger, &btc)), before);
    // The heir sees the swept value in their own main account.
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT count(*)::bigint FROM bank.spaces WHERE user_id = '{HEIR}' AND asset_id = 'BTC' AND kind = 'primary'"
            )
        ),
        1
    );

    let keys: Vec<String> = db
        .client()
        .query(
            "SELECT idempotency_key FROM bank.recovery_sweeps ORDER BY 1",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(keys.len(), 3);
    for key in &keys {
        let prefix = format!("bank.transfer.recovery:{claim}:");
        assert!(key.starts_with(&prefix) && key.ends_with(":0"), "{key}");
        assert!(m.ledger.has_key(key), "{key}");
    }

    let again = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(field(&again, "round"), Json::Null);
    assert!(list(&again, "sweeps").is_empty());
    assert_eq!(text(&field(&again, "claim"), "status"), "executed");
    assert_eq!(field(&field(&again, "claim"), "round"), Json::int(1));
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "105");

    m.ledger.fund(OWNER, "USDT", "12");
    let later = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(field(&later, "round"), Json::int(1));
    assert_eq!(
        rows(&list(&later, "sweeps"), &["assetId", "amount", "status"]),
        [r#"["USDT","12","posted"]"#]
    );
    assert_eq!(field(&field(&later, "claim"), "round"), Json::int(2));
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "117");
    let key: String = db
        .client()
        .query_one(
            "SELECT idempotency_key FROM bank.recovery_sweeps WHERE round = 1",
            &[],
        )
        .unwrap()
        .get(0);
    assert!(key.ends_with(":1"), "{key}");
}

#[test]
fn free_value_moves_while_held_value_stays_and_a_later_round_moves_it_once_released() {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.fund(OWNER, "USDT", "100");
    let hold = account("user", OWNER, "USDT", "hold", Some("order:test-order-1"));
    // `recipes.orderHold`: 10 of the owner's free USDT held for the order.
    m.ledger.shift(&user(OWNER, "USDT"), &hold, "10");
    let claim = text(&data(open_as(&m.door, HEIR, OWNER)), "claimId");
    let listed = estates(&m.door, HEIR);
    let e = &list(&listed, "estates")[0];
    assert_eq!(
        rows(&list(e, "held"), &["assetId", "kind", "amount"]),
        [r#"["USDT","hold","10"]"#]
    );
    assert!(list(e, "blockers").is_empty());
    let first = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(
        rows(
            &list(&first, "sweeps"),
            &["assetId", "amount", "status", "spaceId"]
        ),
        [r#"["USDT","90","posted",null]"#]
    );
    assert_eq!(m.ledger.bal(&user(OWNER, "USDT")), "0");
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "90");
    let after = estates(&m.door, HEIR);
    assert_eq!(
        rows(&list(&list(&after, "estates")[0], "held"), &["amount"]),
        [r#"["10"]"#]
    );
    // The order is cancelled: its hold returns to the owner's free balance, and the next round moves it.
    m.ledger.shift(&hold, &user(OWNER, "USDT"), "10");
    let later = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(
        rows(&list(&later, "sweeps"), &["assetId", "amount", "status"]),
        [r#"["USDT","10","posted"]"#]
    );
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "100");
}

#[test]
fn a_crash_after_the_plan_resumes_the_same_keys_and_never_posts_twice() {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.fund(OWNER, "USDT", "100");
    m.ledger.fund(OWNER, "BTC", "2");
    let claim = text(&data(open_as(&m.door, HEIR, OWNER)), "claimId");
    m.ledger.faults(|f| f.fail_next = 1);
    let crashed = execute_as(&m.door, HEIR, &claim);
    assert_eq!(crashed.0, 500, "{}", crashed.1.compact());
    assert_eq!(refused(&crashed).1, "INTERNAL_SERVER_ERROR");
    let statuses: Vec<String> = db
        .client()
        .query(
            "SELECT status FROM bank.recovery_sweeps ORDER BY account_key",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(statuses.iter().any(|s| s == "pending"), "{statuses:?}");
    let (status, round): (String, i32) = {
        let r = db
            .client()
            .query_one("SELECT status, round FROM bank.recovery_claims", &[])
            .unwrap();
        (r.get(0), r.get(1))
    };
    assert_eq!((status.as_str(), round), ("open", 0));

    // Value arriving before the resume waits for the next round: the resumed round keeps its planned amounts.
    m.ledger.fund(OWNER, "USDT", "1");
    let resumed = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(field(&resumed, "round"), Json::int(0));
    assert_eq!(
        rows(&list(&resumed, "sweeps"), &["status"]),
        [r#"["posted"]"#, r#"["posted"]"#]
    );
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "100");
    assert_eq!(m.ledger.bal(&user(HEIR, "BTC")), "2");
    assert_eq!(m.ledger.bal(&user(OWNER, "USDT")), "1");
    let next = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(
        rows(&list(&next, "sweeps"), &["assetId", "amount"]),
        [r#"["USDT","1"]"#]
    );
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "101");
}

#[test]
fn value_gone_between_the_plan_and_the_post_settles_that_row_refused_and_the_next_round_takes_what_is_left()
 {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.fund(OWNER, "USDT", "100");
    let pot = named_pot(&db, &m.ledger, OWNER, "TEST Pot", "40");
    let claim = text(&data(open_as(&m.door, HEIR, OWNER)), "claimId");
    // Something moves 25 out of the pot after the plan and before its post: the pot's planned 40 is no longer there.
    m.ledger
        .faults(|f| f.drain = Some((pot.clone(), OWNER.to_owned())));
    let done = data(execute_as(&m.door, HEIR, &claim));
    let sweeps = list(&done, "sweeps");
    let pot_row = sweeps
        .iter()
        .find(|s| text(s, "ownerType") == "subaccount")
        .unwrap();
    assert_eq!(text(pot_row, "status"), "refused");
    assert_eq!(text(pot_row, "refusalCode"), "ledger.insufficient_funds");
    assert_eq!(text(&field(&done, "claim"), "status"), "executed");
    assert_eq!(field(&field(&done, "claim"), "round"), Json::int(1));
    // The main account's planned 60 posted; the 25 moved into it and the pot's 15 are swept by the next round.
    let next = data(execute_as(&m.door, HEIR, &claim));
    assert!(
        list(&next, "sweeps")
            .iter()
            .all(|s| text(s, "status") == "posted")
    );
    assert_eq!(m.ledger.bal(&user(OWNER, "USDT")), "0");
    assert_eq!(m.ledger.bal(&pot_account(&pot, "USDT")), "0");
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "100");
}

#[test]
fn a_round_another_call_already_posted_is_not_planned_again_new_value_goes_in_the_next_round() {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.fund(OWNER, "USDT", "100");
    let claim = text(&data(open_as(&m.door, HEIR, OWNER)), "claimId");
    data(execute_as(&m.door, HEIR, &claim));
    // The call that posted round 0 has not moved the claim on yet.
    db.client()
        .execute(
            "UPDATE bank.recovery_claims SET round = 0 WHERE id = $1::text::uuid",
            &[&claim],
        )
        .unwrap();
    m.ledger.fund(OWNER, "USDT", "3");
    let next = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(field(&next, "round"), Json::int(1));
    assert_eq!(
        rows(&list(&next, "sweeps"), &["amount", "status"]),
        [r#"["3","posted"]"#]
    );
    assert_eq!(field(&field(&next, "claim"), "round"), Json::int(2));
    assert_eq!(m.ledger.bal(&user(HEIR, "USDT")), "103");
}

#[test]
fn a_ledger_refusal_that_proves_nothing_posted_settles_the_row_and_a_claim_that_moved_nothing_stays_open()
 {
    let Some(db) = db() else { return };
    let m = mount(&db, &[(HEIR, NOTICE)]);
    m.ledger.faults(|f| f.refuse = true);
    m.ledger.fund(OWNER, "USDT", "100");
    let claim = text(&data(open_as(&m.door, HEIR, OWNER)), "claimId");
    let done = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(
        rows(&list(&done, "sweeps"), &["status", "refusalCode"]),
        [r#"["refused","ledger.invalid_entry"]"#]
    );
    let c = field(&done, "claim");
    assert_eq!(text(&c, "status"), "open");
    assert_eq!(field(&c, "round"), Json::int(1));
    assert_eq!(field(&c, "executedAt"), Json::Null);
    // Nothing is stuck: the next call plans a new round from the ledger.
    let again = data(execute_as(&m.door, HEIR, &claim));
    assert_eq!(field(&again, "round"), Json::int(1));
    assert_eq!(m.ledger.bal(&user(OWNER, "USDT")), "100");
}

#[test]
fn the_door_built_from_the_environment_moves_nothing_until_a_ledger_post_door_is_wired() {
    let Some(db) = db() else { return };
    let identity = Identity::new(&[(HEIR, NOTICE)]);
    let mut wiring = Wiring::from_env(&env()).unwrap();
    wiring.recovery.identity = Box::new(identity);
    let b = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: None,
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env: env(),
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner_account(wiring);
    let claim = text(&data(open_as(&b, HEIR, OWNER)), "claimId");
    let answer = execute_as(&b, HEIR, &claim);
    assert_eq!(answer.0, 500, "{}", answer.1.compact());
    let message = text(answer.1.get("error").unwrap(), "message");
    assert!(message.contains("slice is not ported"), "{message}");
    assert_eq!(
        count(&db, "SELECT count(*)::bigint FROM bank.recovery_sweeps"),
        0
    );
    let status: String = db
        .client()
        .query_one("SELECT status FROM bank.recovery_claims", &[])
        .unwrap()
        .get(0);
    assert_eq!(status, "open");
}
