//! Part `own_moves` of slice `automations` against the Rust door on a real Postgres. Ports every check of the
//! TypeScript's `own-moves/own-moves.db.test.ts` (15 tests), each named after the TypeScript test's words, on the TEST
//! partner bank holding ADA's money.
//!
//! The TypeScript calls `bank.ownMoves.*` straight for its first 13 tests and the router for the last two ("the door");
//! here every move goes through the door, with svc-identity's consume standing in for the step-up the router always asks
//! (a stand-in that consumes any approval of the person's own, and records what it was asked), and the slice's own
//! function is called only where the TypeScript reads a refusal's own words (the door shows a customer the table's copy,
//! not the service's message). The partner's send to a wallet counts every send per key, as the TypeScript's does; the
//! ledger is a stand-in that counts every post and read it is asked for (the invariant: none). Left: nothing.
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
use std::sync::{Arc, Mutex};

use k256::ecdsa::SigningKey;
use service_kit::approvals::{ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::automations::Wiring as AutomationsWiring;
use svc_bank::automations::own_moves::delivery::{Delivery, DepositReader};
use svc_bank::automations::own_moves::wallet::{own_move_message, personal_message_hash};
use svc_bank::automations::own_moves::{
    self, STEP_UP_ACTION, ToWallet, own_move_key, partner_chain_out_account,
};
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, TestPartner};
use svc_bank::spaces::Wiring as SpacesWiring;
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};
use svc_bank::transfers::ports::{LockState, NoIdentity, SecurityLock};
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "bank-own-moves-edge-secret-long-enough";
const INTERNAL: &str = "bank-own-moves-internal-secret-long-enough";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const SID: &str = "33333333-3333-4333-8333-333333333333";
// Well-known public development keys (the first two accounts of common local EVM chains). They hold nothing; TEST only.
const KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WALLET: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const STRANGER_KEY: &str = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/// The owner's list the TypeScript's suite sets: one LOCAL TEST address, not the wallet.
const LIST: &str = "*:0x00000000000000000000000000000000005a1c7d";

fn tx(n: usize) -> String {
    format!("0x{n:064x}")
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

/// What a wallet's `personal_sign` returns: the EIP-191 digest signed, as `r || s || v` with v 27/28.
fn personal_sign(message: &str, key_hex: &str) -> String {
    let bytes: Vec<u8> = (0..key_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&key_hex[i..i + 2], 16).unwrap())
        .collect();
    let key = SigningKey::from_slice(&bytes).unwrap();
    let (sig, id) = key.sign_prehash_recoverable(&personal_message_hash(message));
    let rs: [u8; 64] = sig.to_bytes().into();
    let hex: String = rs.iter().map(|b| format!("{b:02x}")).collect();
    format!("0x{hex}{:02x}", id.to_byte() + 27)
}

/// `ask`: a move of `amount` USDC to the wallet, signed by `key`.
#[derive(Clone)]
struct Ask {
    move_id: String,
    amount: String,
    signature: String,
}

fn ask_with(amount: &str, move_id: &str, key: &str) -> Ask {
    let message = own_move_message(move_id, WALLET, "USDC", amount);
    Ask {
        move_id: move_id.to_owned(),
        amount: amount.to_owned(),
        signature: personal_sign(&message, key),
    }
}

fn ask(amount: &str) -> Ask {
    ask_with(amount, &uuid(), KEY)
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: the partner's send to a wallet, the chain's deposit read, svc-identity's lock and consume, svc-ledger.

#[derive(Default)]
struct SendState {
    sends: Vec<(String, String, String)>,
    fail_next: bool,
}

/// `payinSim`'s `deliver` as the TypeScript's suite gives it: a send per key, the same key answered with its transfer.
#[derive(Clone, Default)]
struct Sends(Arc<Mutex<SendState>>);

impl Sends {
    fn count(&self) -> usize {
        self.0.lock().unwrap().sends.len()
    }
    fn all(&self) -> Vec<(String, String, String)> {
        self.0.lock().unwrap().sends.clone()
    }
}

impl Delivery for Sends {
    fn deliver(&self, key: &str, to: &str, _asset: &str, amount: &str) -> Result<String, String> {
        let mut s = self.0.lock().unwrap();
        if s.fail_next {
            s.fail_next = false;
            return Err("the TEST partner did not deliver: 502 payin.send_failed".to_owned());
        }
        if let Some(i) = s.sends.iter().position(|(k, ..)| k == key) {
            return Ok(tx(i + 1));
        }
        s.sends
            .push((key.to_owned(), to.to_owned(), amount.to_owned()));
        Ok(tx(s.sends.len()))
    }
}

/// `OwnMoveDepositReader`: confirms one transfer, and records every ask.
#[derive(Clone)]
struct Chain {
    on_chain: String,
    asked: Arc<Mutex<Vec<DepositAsk>>>,
}

/// One ask of the chain: the transfer, the wallet, the asset and the amount.
type DepositAsk = (String, String, String, Amount);

impl DepositReader for Chain {
    fn confirmed(&self, tx: &str, wallet: &str, asset_id: &str, amount: Amount) -> bool {
        self.asked.lock().unwrap().push((
            tx.to_owned(),
            wallet.to_owned(),
            asset_id.to_owned(),
            amount,
        ));
        tx == self.on_chain
    }
}

/// The security lock as svc-identity reports it, or unset (no `IDENTITY_URL`).
#[derive(Clone, Copy)]
enum Hold {
    Open,
    SelfFrozen,
    Locked,
    Unset,
}

impl SecurityLock for Hold {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal> {
        let state = |locked, self_frozen| {
            Ok(LockState {
                locked,
                unlocks_at: None,
                self_frozen,
            })
        };
        match self {
            Hold::Open => state(false, false),
            Hold::SelfFrozen => state(false, true),
            Hold::Locked => state(true, false),
            Hold::Unset => NoIdentity.read(user_id),
        }
    }
}

/// svc-identity's consume: any approval of the person's own, consumed once; `refuse` answers none. Records each ask.
#[derive(Clone, Default)]
struct Identity {
    refuse: bool,
    asked: Arc<Mutex<Vec<ConsumeAsk>>>,
}

/// One consume identity was asked: the approval, the action, the payload's hash and the session.
type ConsumeAsk = (String, String, String, String);

impl Approvals for Identity {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let p = principal.expect("a same-person consume binds the person");
        self.asked.lock().unwrap().push((
            input.approval_id.to_owned(),
            input.target_id.to_owned(),
            input.payload_hash.to_owned(),
            p.session_id.to_owned(),
        ));
        if self.refuse {
            return Err(ConsumeError::Refused(
                "identity refused consume (412) {\"message\":\"x [action_approval.not_found]\"}"
                    .to_owned(),
            ));
        }
        Ok((
            Consumed {
                action_type: input.target_id.to_owned(),
                target_service: "svc-bank".to_owned(),
                target_id: input.target_id.to_owned(),
                status: "CONSUMED".to_owned(),
                requester_id: p.user_id.to_owned(),
                approver_id: Some(p.user_id.to_owned()),
                approver_is_founder: None,
                requester_is_founder: None,
            },
            Facts {
                kind: Some("same_person".to_owned()),
                expires_at: "2099-01-01T00:00:00.000Z".to_owned(),
            },
        ))
    }
}

/// svc-ledger: refuses everything, and counts what it was asked (an own move asks it nothing).
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
    sends: Sends,
    identity: Identity,
    ledger: Journal,
}

struct Options {
    deliver: bool,
    fails_once: bool,
    sanctions: &'static str,
    hold: Hold,
    deposits: Option<Chain>,
    refuse_step_up: bool,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            deliver: true,
            fails_once: false,
            sanctions: LIST,
            hold: Hold::Open,
            deposits: None,
            refuse_step_up: false,
        }
    }
}

/// `wired`: the TEST partner holding ADA's (and BOB's) money, ADA funded TEST 1000 USDC.
fn wired(db: &TestDb, o: Options) -> Bank {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let sends = Sends::default();
    sends.0.lock().unwrap().fail_next = o.fails_once;
    let identity = Identity {
        refuse: o.refuse_step_up,
        ..Identity::default()
    };
    let ledger = Journal::default();
    let mut transfers = TransfersWiring::none();
    transfers.lock = Box::new(o.hold);
    transfers.approvals = Box::new(identity.clone());
    let mut automations = AutomationsWiring::none();
    automations.own_moves = own_moves::Wiring {
        deliver: o
            .deliver
            .then(|| Box::new(sends.clone()) as Box<dyn Delivery>),
        sanctions: Some(o.sanctions.to_owned()),
        deposits: o.deposits.map(|c| Box::new(c) as Box<dyn DepositReader>),
    };
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
        ..SpacesWiring::none()
    })
    .with_transfers(transfers)
    .with_automations(automations);
    let b = Bank {
        door,
        sends,
        identity,
        ledger,
    };
    for user in [ADA, BOB] {
        assert_eq!(
            call(&b, user, "testPartner.set", r#"{"custody":"off"}"#).0,
            200
        );
    }
    let fund = r#"{"fundId":"fund-ada-1000","assetId":"USDC","amount":"1000"}"#;
    assert_eq!(call(&b, ADA, "testPartner.fund", fund).0, 200);
    b
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
    /// The refusal's own code (`cause.code`), `ok`, or `opaque` for the guard's opaque failure.
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
            (500, None) => "opaque".to_owned(),
            (status, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
}

fn call(b: &Bank, user: &str, path: &str, input: &str) -> Answer {
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
    let res = b.door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-own-moves-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn to_wallet_input(a: &Ask, approval: Option<&str>) -> String {
    let mut f = vec![
        ("moveId".to_owned(), Json::str(a.move_id.clone())),
        ("assetId".to_owned(), Json::str("USDC")),
        ("amount".to_owned(), Json::str(a.amount.clone())),
        ("wallet".to_owned(), Json::str(WALLET)),
        ("walletSignature".to_owned(), Json::str(a.signature.clone())),
    ];
    if let Some(id) = approval {
        f.push(("stepUpApprovalId".to_owned(), Json::str(id)));
    }
    Json::Object(f).compact()
}

/// `ownMoves.toWallet` through the door with a fresh approval of the person's own.
fn to_wallet(b: &Bank, user: &str, a: &Ask) -> Answer {
    // Unique across the suite's doors on one database: `bank.step_up_uses` keeps every approval used.
    let approval = format!("approval-{}", uuid());
    call(
        b,
        user,
        "ownMoves.toWallet",
        &to_wallet_input(a, Some(&approval)),
    )
}

fn record_deposit(b: &Bank, user: &str, move_id: &str, deposit: &str) -> Answer {
    call(
        b,
        user,
        "ownMoves.recordDeposit",
        &format!(r#"{{"moveId":"{move_id}","depositTx":"{deposit}"}}"#),
    )
}

fn get(b: &Bank, user: &str, move_id: &str) -> Json {
    call(
        b,
        user,
        "ownMoves.get",
        &format!(r#"{{"moveId":"{move_id}"}}"#),
    )
    .ok()
}

fn list(b: &Bank, user: &str) -> Json {
    call(b, user, "ownMoves.list", r#"{"limit":10}"#).ok()
}

/// The partner's figure for an account.
fn balance_of(b: &Bank, account: &AccountRef) -> Option<Amount> {
    b.door
        .partner()
        .partner
        .as_ref()
        .unwrap()
        .lock()
        .report(account, Instant(0))
        .amount
}

fn balance(b: &Bank) -> Option<Amount> {
    balance_of(b, &AccountRef::main(ADA, "USDC"))
}

fn rows(db: &TestDb) -> i64 {
    db.count("SELECT count(*) FROM bank.own_moves")
}

fn field(j: &Json, k: &str) -> Json {
    j.get(k).cloned().unwrap_or(Json::Null)
}

fn db() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrated();
    Some(db)
}

// ---------------------------------------------------------------------------------------------------------------
// own moves: spending to trading (J-derivatives-25 #2 #3)

#[test]
fn sends_the_amount_from_the_main_balance_to_the_wallet_once_and_the_ledger_posts_nothing() {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let m = to_wallet(&b, ADA, &ask("600")).ok();
    assert_eq!(field(&m, "status"), Json::str("sent"));
    assert_eq!(field(&m, "amount"), Json::str("600"));
    assert_eq!(field(&m, "wallet"), Json::str(WALLET));
    assert_eq!(field(&m, "partner"), Json::str("TEST partner bank"));
    assert_eq!(field(&m, "deliveryTx"), Json::str(tx(1)));
    assert!(matches!(field(&m, "partnerRef"), Json::String(_)));
    let Json::String(id) = field(&m, "id") else {
        panic!("id")
    };
    assert_eq!(
        b.sends.all(),
        vec![(own_move_key(&id), WALLET.to_owned(), "600".to_owned())]
    );
    // Invariant: the main balance lost exactly the amount, the partner's own chain-out account holds it, nothing posted.
    assert_eq!(balance(&b), Some(amt("400")));
    assert_eq!(
        balance_of(&b, &partner_chain_out_account("USDC")),
        Some(amt("600"))
    );
    assert_eq!(b.ledger.asked(), 0);
}

#[test]
fn asked_again_with_the_same_id_sends_nothing_more_and_answers_the_first_move() {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let input = ask("600");
    let first = to_wallet(&b, ADA, &input).ok();
    let (again, third) = std::thread::scope(|s| {
        let x = s.spawn(|| to_wallet(&b, ADA, &input));
        let y = s.spawn(|| to_wallet(&b, ADA, &input));
        (x.join().unwrap(), y.join().unwrap())
    });
    assert_eq!(again.ok(), first);
    assert_eq!(third.ok(), first);
    assert_eq!(b.sends.count(), 1);
    assert_eq!(balance(&b), Some(amt("400")));
}

#[test]
fn above_what_the_partner_reports_free_refuses_naming_its_figure_nothing_kept_nothing_moved_nothing_sent()
 {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    assert_eq!(
        to_wallet(&b, ADA, &ask("1000.01")).code(),
        "bank.own_move_above_free"
    );
    // The refusal's own words, as the service gives them (the door shows the table's copy).
    let a = ask("1000.01");
    let refused = b.door.automations_deps(b.door.now(), |d| {
        own_moves::to_wallet(
            d,
            ADA,
            &ToWallet {
                move_id: &a.move_id,
                asset_id: "USDC",
                amount: &a.amount,
                wallet: WALLET,
                wallet_signature: &a.signature,
            },
        )
    });
    let Err(Refusal::Bank(e)) = refused else {
        panic!("{refused:?}")
    };
    assert_eq!(e.row.code, "bank.own_move_above_free");
    assert_eq!(
        e.message,
        "TEST partner bank reports 1000 USDC free in your account, so 1000.01 USDC cannot move. Nothing was sent."
    );
    assert_eq!(b.sends.count(), 0);
    assert_eq!(balance(&b), Some(amt("1000")));
    assert_eq!(rows(&db), 0);
}

#[test]
fn a_wallet_that_did_not_sign_this_move_or_signed_another_amount_is_refused_before_anything_is_kept()
 {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let stranger = ask_with("600", &uuid(), STRANGER_KEY);
    assert_eq!(
        to_wallet(&b, ADA, &stranger).code(),
        "bank.wallet_delivery_unproven"
    );
    let signed_for_100 = Ask {
        amount: "600".to_owned(),
        ..ask("100")
    };
    assert_eq!(
        to_wallet(&b, ADA, &signed_for_100).code(),
        "bank.wallet_delivery_unproven"
    );
    assert_eq!(b.sends.count(), 0);
    assert_eq!(balance(&b), Some(amt("1000")));
    assert_eq!(rows(&db), 0);
}

#[test]
fn a_listed_wallet_is_refused_with_the_lists_code_and_nothing_moves() {
    let Some(db) = db() else { return };
    let listed = wired(
        &db,
        Options {
            sanctions: "*:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
            ..Options::default()
        },
    );
    let code = to_wallet(&listed, ADA, &ask("10")).code();
    assert!(
        code.starts_with("bank.sanction") || code.starts_with("bank.destination"),
        "{code}"
    );
    assert_eq!(code, "bank.destination_sanctions_listed");
    assert_eq!(listed.sends.count(), 0);
    assert_eq!(balance(&listed), Some(amt("1000")));
}

#[test]
fn the_same_id_with_other_terms_is_a_conflict_and_another_person_cannot_reuse_it() {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let input = ask("600");
    assert_eq!(to_wallet(&b, ADA, &input).code(), "ok");
    let other = ask_with("500", &input.move_id, KEY);
    assert_eq!(to_wallet(&b, ADA, &other).code(), "bank.own_move_conflict");
    assert_eq!(to_wallet(&b, BOB, &input).code(), "bank.own_move_conflict");
    assert_eq!(b.sends.count(), 1);
}

#[test]
fn a_send_cut_off_after_the_partner_moved_is_finished_by_asking_again_moved_once_sent_once() {
    let Some(db) = db() else { return };
    let b = wired(
        &db,
        Options {
            fails_once: true,
            ..Options::default()
        },
    );
    let input = ask("600");
    // The partner did not deliver: a thrown error, the guard's opaque failure.
    assert_eq!(to_wallet(&b, ADA, &input).code(), "opaque");
    // The partner moved it out of the main balance under the key; the row still reads opening, with nothing sent.
    assert_eq!(balance(&b), Some(amt("400")));
    let open = get(&b, ADA, &input.move_id);
    assert_eq!(field(&open, "status"), Json::str("opening"));
    assert_eq!(field(&open, "deliveryTx"), Json::Null);
    let done = to_wallet(&b, ADA, &input).ok();
    assert_eq!(field(&done, "status"), Json::str("sent"));
    assert_eq!(field(&done, "deliveryTx"), Json::str(tx(1)));
    assert_eq!(b.sends.count(), 1);
    assert_eq!(balance(&b), Some(amt("400")));
}

#[test]
fn a_move_kept_before_a_crash_the_partner_never_asked_is_sent_once_when_asked_again() {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let input = ask("250");
    db.client()
        .execute(
            "INSERT INTO bank.own_moves (id, user_id, direction, asset_id, amount, wallet, status) \
             VALUES ($1::text::uuid, $2, 'in', 'USDC', '250', $3, 'opening')",
            &[&input.move_id, &ADA, &WALLET],
        )
        .unwrap();
    assert_eq!(
        field(&to_wallet(&b, ADA, &input).ok(), "status"),
        Json::str("sent")
    );
    assert_eq!(b.sends.count(), 1);
    assert_eq!(balance(&b), Some(amt("750")));
}

#[test]
fn a_frozen_or_locked_account_or_one_whose_lock_cannot_be_read_is_refused_by_name_nothing_kept_moved_or_sent()
 {
    let Some(db) = db() else { return };
    let mut asked = 0;
    for (hold, code) in [
        (Hold::SelfFrozen, "bank.account_frozen_self"),
        (Hold::Locked, "bank.security_locked"),
        (Hold::Unset, "bank.security_lock_unset"),
    ] {
        let b = wired(
            &db,
            Options {
                hold,
                ..Options::default()
            },
        );
        assert_eq!(to_wallet(&b, ADA, &ask("100")).code(), code);
        assert_eq!(balance(&b), Some(amt("1000")));
        assert_eq!(b.sends.count(), 0);
        assert_eq!(list(&b, ADA), Json::Array(Vec::new()));
        asked += b.ledger.asked();
    }
    assert_eq!(asked, 0);
}

#[test]
fn with_no_partner_send_to_a_wallet_refuses_by_name_and_keeps_nothing() {
    let Some(db) = db() else { return };
    let b = wired(
        &db,
        Options {
            deliver: false,
            ..Options::default()
        },
    );
    assert_eq!(
        to_wallet(&b, ADA, &ask("10")).code(),
        "bank.own_move_rail_unset"
    );
    assert_eq!(balance(&b), Some(amt("1000")));
    assert_eq!(rows(&db), 0);
}

#[test]
fn records_the_wallets_own_deposit_once_the_same_again_is_the_same_another_is_a_conflict() {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let m = to_wallet(&b, ADA, &ask("600")).ok();
    let Json::String(id) = field(&m, "id") else {
        panic!("id")
    };
    let deposit = tx(0xd1);
    let first = record_deposit(&b, ADA, &id, &deposit).ok();
    assert_eq!(field(&first, "depositTx"), Json::str(deposit.clone()));
    assert!(matches!(field(&first, "depositAt"), Json::String(_)));
    assert_eq!(record_deposit(&b, ADA, &id, &deposit).ok(), first);
    assert_eq!(
        record_deposit(&b, ADA, &id, &tx(0xd2)).code(),
        "bank.own_move_conflict"
    );
    assert_eq!(
        record_deposit(&b, BOB, &id, &deposit).code(),
        "bank.own_move_not_found"
    );
    assert_eq!(b.ledger.asked(), 0);
}

#[test]
fn a_deposit_hash_the_chain_was_never_asked_about_is_recorded_as_claimed_and_never_reads_as_confirmed()
 {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let m = to_wallet(&b, ADA, &ask("600")).ok();
    assert_eq!(field(&m, "depositConfirmed"), Json::Bool(false));
    let Json::String(id) = field(&m, "id") else {
        panic!("id")
    };
    let unknown = tx(0xbad);
    let kept = record_deposit(&b, ADA, &id, &unknown).ok();
    assert_eq!(field(&kept, "depositTx"), Json::str(unknown.clone()));
    assert_eq!(field(&kept, "depositConfirmed"), Json::Bool(false));
    let got = get(&b, ADA, &id);
    assert_eq!(field(&got, "depositTx"), Json::str(unknown.clone()));
    assert_eq!(field(&got, "depositConfirmed"), Json::Bool(false));
    let Json::Array(listed) = list(&b, ADA) else {
        panic!("list")
    };
    assert_eq!(field(&listed[0], "depositTx"), Json::str(unknown));
    assert_eq!(field(&listed[0], "depositConfirmed"), Json::Bool(false));
}

#[test]
fn a_deposit_leg_reads_confirmed_only_when_the_chain_read_finds_this_moves_own_transfer() {
    let Some(db) = db() else { return };
    let chain = Chain {
        on_chain: tx(0xc0),
        asked: Arc::default(),
    };
    let b = wired(
        &db,
        Options {
            deposits: Some(chain.clone()),
            ..Options::default()
        },
    );
    let m = to_wallet(&b, ADA, &ask("600")).ok();
    assert_eq!(field(&m, "depositConfirmed"), Json::Bool(false));
    assert!(chain.asked.lock().unwrap().is_empty());
    let Json::String(id) = field(&m, "id") else {
        panic!("id")
    };
    let confirmed = record_deposit(&b, ADA, &id, &tx(0xc0)).ok();
    assert_eq!(field(&confirmed, "depositConfirmed"), Json::Bool(true));
    assert_eq!(
        chain.asked.lock().unwrap().last().cloned(),
        Some((tx(0xc0), WALLET.to_owned(), "USDC".to_owned(), amt("600")))
    );
    let other = to_wallet(&b, ADA, &ask("5")).ok();
    let Json::String(other_id) = field(&other, "id") else {
        panic!("id")
    };
    let claimed = record_deposit(&b, ADA, &other_id, &tx(0xc1)).ok();
    assert_eq!(field(&claimed, "depositConfirmed"), Json::Bool(false));
    let Json::Array(listed) = list(&b, ADA) else {
        panic!("list")
    };
    let by_id: BTreeMap<String, Json> = listed
        .iter()
        .map(|m| (field(m, "id").compact(), field(m, "depositConfirmed")))
        .collect();
    assert_eq!(by_id.len(), 2);
    assert_eq!(by_id[&Json::str(id).compact()], Json::Bool(true));
    assert_eq!(by_id[&Json::str(other_id).compact()], Json::Bool(false));
}

// the door

#[test]
fn always_asks_a_fresh_second_factor_bound_to_the_move_and_without_one_nothing_is_sent() {
    let Some(db) = db() else { return };
    let b = wired(
        &db,
        Options {
            refuse_step_up: true,
            ..Options::default()
        },
    );
    let input = ask("600");
    // No approval: refused before identity is asked.
    let none = call(&b, ADA, "ownMoves.toWallet", &to_wallet_input(&input, None));
    assert_eq!(none.code(), "bank.step_up_required");
    assert!(b.identity.asked.lock().unwrap().is_empty());
    // An approval identity does not consume: refused, and what was asked is bound to the person, the session and the move.
    let refused = call(
        &b,
        ADA,
        "ownMoves.toWallet",
        &to_wallet_input(&input, Some("approval-1")),
    );
    assert_eq!(refused.code(), "bank.step_up_required");
    let fields: Vec<(String, String)> = [
        ("actor", ADA),
        ("moveId", input.move_id.as_str()),
        ("assetId", "USDC"),
        ("amount", "600"),
        ("wallet", WALLET),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    assert_eq!(
        b.identity.asked.lock().unwrap().clone(),
        vec![(
            "approval-1".to_owned(),
            STEP_UP_ACTION.to_owned(),
            payload_hash(STEP_UP_ACTION, &fields),
            SID.to_owned()
        )]
    );
    assert_eq!(b.sends.count(), 0);
    assert_eq!(balance(&b), Some(amt("1000")));
    assert_eq!(rows(&db), 0);
}

#[test]
fn with_the_approval_sends_once_and_answers_the_move() {
    let Some(db) = db() else { return };
    let b = wired(&db, Options::default());
    let input = to_wallet_input(&ask("600"), Some("approval-1"));
    let m = call(&b, ADA, "ownMoves.toWallet", &input).ok();
    assert_eq!(field(&m, "status"), Json::str("sent"));
    assert_eq!(field(&m, "amount"), Json::str("600"));
    assert_eq!(field(&m, "partnerFee"), Json::str("0"));
    assert_eq!(field(&m, "partner"), Json::str("TEST partner bank"));
    assert_eq!(b.sends.count(), 1);
    assert_eq!(list(&b, ADA), Json::Array(vec![m.clone()]));
    // The same move with the same approval replays: nothing more is sent.
    assert_eq!(call(&b, ADA, "ownMoves.toWallet", &input).ok(), m);
    assert_eq!(b.sends.count(), 1);
    // `ownMoves.message` gives the words the wallet signs, as the TypeScript writes them.
    let words = call(
        &b,
        ADA,
        "ownMoves.message",
        &format!(
            r#"{{"moveId":"{}","assetId":"USDC","amount":"600","wallet":"{WALLET}"}}"#,
            field(&m, "id").compact().trim_matches('"')
        ),
    )
    .ok();
    assert_eq!(
        field(&words, "message"),
        Json::str(own_move_message(
            field(&m, "id").compact().trim_matches('"'),
            WALLET,
            "USDC",
            "600"
        ))
    );
}
